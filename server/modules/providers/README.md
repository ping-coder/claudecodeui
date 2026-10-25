# Providers Module Guide

This file documents the current provider contract in `server/modules/providers`.
Keep it current whenever provider wiring, skill discovery, or session sync
behavior changes. The goal is that a human or AI agent can add a new provider
without guessing which files need to move.

## Current Provider Shape

Every provider wrapper exposes seven facets:

- `runtime`
- `models`
- `auth`
- `mcp`
- `skills`
- `sessions`
- `sessionSynchronizer`

These correspond to the shared interfaces in `server/shared/interfaces.ts`:

- `IProviderRuntime`
- `IProviderModels`
- `IProviderAuth`
- `IProviderMcp`
- `IProviderSkills`
- `IProviderSessions`
- `IProviderSessionSynchronizer`

A wrapper can also expose an optional `fork` facet (`IProviderFork`, implemented
by Claude and Codex). Without it, forking a session answers 409
`FORK_NOT_SUPPORTED`.

The services that consume them are:

- `providerModelsService`
- `providerAuthService`
- `providerMcpService`
- `providerSkillsService`
- `sessionsService`
- `sessionSynchronizerService`

Live execution is consumed through `providerRuntimeService`, which resolves the
provider-owned runtime through the same `providerRegistry` as every other facet.

Current provider ids in this repo are:

- `claude`
- `codex`
- `cursor`
- `opencode`
- `agy` (Antigravity CLI)

Those ids are mirrored in backend unions and frontend provider constants. If
adding a new provider, update every place that hardcodes this list.

## Current File Layout

Each provider lives under its own folder in `server/modules/providers/list/`:

```text
server/modules/providers/list/<provider>/
  <provider>.provider.ts
  <provider>-runtime.provider.ts
  <provider>-auth.provider.ts
  <provider>-models.provider.ts
  <provider>-mcp.provider.ts
  <provider>-skills.provider.ts
  <provider>-sessions.provider.ts
  <provider>-session-synchronizer.provider.ts
  <provider>-fork.provider.ts        (optional)
```

The existing provider folders are `claude`, `codex`, `cursor`, `opencode`, and
`agy`. New files under `server/modules` are TypeScript; the `.js` runtimes of
Claude, Cursor, and OpenCode predate that rule. Helpers private to one provider
stay in its folder (for example `agy-store.ts`, which the agy sessions provider
and synchronizer share).

Each provider wrapper owns its SDK/CLI runtime alongside its auth, model, and
session facets. Runtime adapters receive registry-backed model and session
lookups from `providerRuntimeService` at execution time instead of importing
those services themselves. This keeps `providerRegistry` as the only provider
mapping without creating a circular dependency. Application-level consumers
import the service from `server/modules/providers/index.ts`.

## What Each Facet Does

| Facet | Responsibility | Base / Service |
| --- | --- | --- |
| `runtime` | Run and abort live SDK/CLI sessions | `IProviderRuntime` -> `providerRuntimeService` |
| `models` | Resolve supported and active models | `IProviderModels` -> `providerModelsService` |
| `auth` | Report install/auth state for the provider runtime | `IProviderAuth` -> `providerAuthService` |
| `mcp` | Read, list, write, and remove provider-native MCP config | `McpProvider` -> `providerMcpService` |
| `skills` | Discover provider-native skill markdown files | `SkillsProvider` -> `providerSkillsService` |
| `sessions` | Normalize live events and fetch session history | `IProviderSessions` -> `sessionsService` |
| `sessionSynchronizer` | Scan transcript artifacts and upsert session metadata | `IProviderSessionSynchronizer` -> `sessionSynchronizerService` |
| `fork` (optional) | Copy a session into a new one | `IProviderFork` -> `sessionsService` |

`sessions` and `sessionSynchronizer` are separate concerns:

- `sessions` handles runtime event normalization and history fetches.
- `sessionSynchronizer` handles file-backed session indexing into `sessionsDb`.

## How To Add A Provider

1. Add the provider id everywhere it is part of the contract.

- Update `LLMProvider` in `server/shared/types.ts` and in `src/shared/types.ts`.
  The two unions must match. The typecheck then reports every
  `Record<LLMProvider, ...>` that needs an entry: `provider.registry.ts`, the
  capabilities matrix, `processedByProvider` in
  `services/session-synchronizer.service.ts`, the curated catalogs in the
  capabilities and models service tests, and the frontend constants.
- The compiler does not check plain string lists, and each one fails quietly,
  so update them by hand:
  - `parseProvider` in `server/modules/providers/provider.routes.ts`. Without
    it, every `/:provider/*` route answers 400 `UNSUPPORTED_PROVIDER`.
  - `MODEL_PROVIDERS` and `MODEL_PROVIDER_LABELS` in
    `server/modules/commands/commands.routes.ts`. Without them, `/models`,
    `/cost`, and `/status` silently use `claude`.
  - `AGENT_RUN_PROVIDERS` in `server/modules/agent/agent.routes.ts` if the
    provider can be launched from the agent API (see step 12).
  - `PROVIDER_LABELS` in
    `server/modules/notifications/services/notification-orchestrator.service.js`.
    Without it, notifications call the provider "Assistant".
  - `PROVIDERS` in `src/shared/selectedProvider.ts`. Without it, a saved
    selection falls back to `claude`.
  - `CLI_PROVIDERS` in `src/modules/provider-auth/hooks/useProviderAuthStatus.ts`.
    Without it, the auth status stays on "Checking…".
  - The `PROVIDER_ORDER` list in `public/api-docs.html` if the provider should
    appear in the public API docs.
- Add the id to the `provider_models` table's `CHECK (provider IN (...))` in
  `server/modules/database/schema.ts`. Existing databases keep the CHECK they
  were created with (`CREATE TABLE IF NOT EXISTS`), so
  `server/modules/database/migrations.ts` must also rebuild an existing table
  whose CHECK lacks the provider. Without that, saving a custom model for the
  provider fails with a misleading 409 `MODEL_ID_ALREADY_EXISTS`.

2. Create the wrapper class.

- Add `server/modules/providers/list/<provider>/<provider>.provider.ts`.
- Extend `AbstractProvider`.
- Expose readonly `runtime`, `models`, `auth`, `mcp`, `skills`, `sessions`,
  and `sessionSynchronizer`, plus `fork` when sessions can be forked.
- Call `super('<provider>')`.
- The registry builds every wrapper when it is imported, so constructors must
  not read files or start processes.

3. Implement the runtime.

- Add `server/modules/providers/list/<provider>/<provider>-runtime.provider.ts`
  when the provider supports live SDK/CLI execution, and implement
  `IProviderRuntime`: `run(command, options, writer, context)` and
  `abort(sessionId)`.
- `options` carries the app `sessionId`, `cwd`, `projectPath`, `model`,
  `effort`, `permissionMode`, `images`, and `files`.
- Key running processes by the app session id. When a new chat gets its
  provider session id, call `writer.setSessionId(...)` and send
  `session_created`. Resume with `context.resolveProviderSessionId(...)`.
- Pass provider events through `context.normalizeMessage(...)` and send each
  result with `writer.send(...)`.
- Send exactly one `complete` per run, and none after an abort: the chat
  gateway sends the aborted `complete` itself.
- On spawn `ENOENT` or exit code 127, ask `context.isProviderInstalled()` so the
  user is told the CLI is missing instead of seeing a generic failure.
- A new run can start as soon as `abort()` resolves. Let the old process's close
  handler remove its map entry only while that entry still points at it.

4. Implement models.

- `getSupportedModels()` returns `{ OPTIONS, DEFAULT }` and never throws. Cache
  CLI listings and fall back to a built-in catalog.
- When the provider supports effort, give every option `effort: { values }`.
  The composer's effort menu shows the selected model's values.
- `getCurrentActiveModel(sessionId)` must return exactly `DEFAULT` when it has
  no answer (`buildDefaultProviderCurrentActiveModel`), because
  `resolveSessionModel` reads that value as "unknown".

5. Declare capabilities.

- Add a row to `PROVIDER_CAPABILITIES` in
  `server/modules/providers/services/provider-capabilities.service.ts`. The
  frontend reads it from `GET /api/providers/capabilities`.
- `permissionModes` and `defaultPermissionMode` drive the composer's permission
  menu.
- `supportsEffort` must equal `effortLevels.length > 0`, and every curated
  effort value must appear in `effortLevels`.
- Set `supportsMessageEditing` and `supportsSessionForking` only when the edit
  methods (`resolveEditAnchor`, `rewindSession`) or the `fork` facet exist.

6. Implement auth.

- Return a full `ProviderAuthStatus`.
- Treat normal `not installed` / `not authenticated` states as data, not exceptions.
- Keep provider-specific credential discovery inside the auth provider.
- If the provider has no auth step, return a stable unauthenticated or not-installed status instead of omitting the facet.
- Prefer filesystem checks to running the CLI, because the status is fetched
  whenever onboarding or settings opens. Antigravity, for example, finds its
  binary with `server/shared/agy-cli-path.ts` and only checks that its token
  file exists.

7. Implement MCP.

- Extend `McpProvider`.
- Pass the supported scopes and transports to `super(...)`.
- Implement the four required methods:
  - `readScopedServers(...)`
  - `writeScopedServers(...)`
  - `buildServerConfig(...)`
  - `normalizeServerConfig(...)`
- Use the shared validation and normalization behavior from `McpProvider`.
- Keep the provider-specific config format local to the provider implementation.
- If CloudCLI should not manage the provider's MCP config, pass no scopes. Its
  lists are then empty, writes fail with `MCP_SCOPE_NOT_SUPPORTED`, and adding
  or removing a server for all providers skips it (`supportsScope`).

Current MCP formats in this repo are:

| Provider | User / Project Storage | Supported Scopes | Supported Transports |
| --- | --- | --- | --- |
| Claude | `.mcp.json` in user / local / project locations | `user`, `local`, `project` | `stdio`, `http`, `sse` |
| Codex | `.codex/config.toml` | `user`, `project` | `stdio`, `http` |
| Cursor | `.cursor/mcp.json` | `user`, `project` | `stdio`, `http` |
| OpenCode | `~/.config/opencode/opencode.json` or `<workspace>/opencode.json` (`.jsonc` is read when present) | `user`, `project` | `stdio`, `http` |
| Antigravity | Not managed by CloudCLI, so nothing is written under `~/.gemini` | none | none |

8. Implement skills.

- Extend `SkillsProvider`.
- Implement `getSkillSources(workspacePath)`.
- Return the actual discovery roots for the provider.
- Skills are discovered from `SKILL.md` files.
- `readProviderSkillMarkdownDefinition(...)` reads front matter `name` and `description`.
- If `name` is missing, the parent directory name is used as a fallback.
- Use `recursive: true` only when the provider stores skills in nested trees.
- Keep the emitted `command` string aligned with the provider's real skill syntax.
- A provider without skill discovery returns no sources. Its list is empty,
  and adding or removing a skill fails with `PROVIDER_SKILLS_WRITE_UNSUPPORTED`,
  because the default `getGlobalSkillSource()` returns `null`.

Current skill discovery roots are:

| Provider | User Roots | Project / Repo Roots | Prefix | Notes |
| --- | --- | --- | --- | --- |
| Claude | `~/.claude/skills` | `<workspace>/.claude/skills` | `/` | Also discovers Claude plugin skills from enabled plugin installs. Command skills live under `commands/`; markdown skills live under `skills/` and are scanned recursively. |
| Codex | `~/.agents/skills`, `~/.codex/skills/.system`, `/etc/codex/skills` | `<workspace>/.agents/skills`, `path.dirname(workspacePath)/.agents/skills`, topmost git root `.agents/skills` | `$` | Overlapping roots are deduplicated before scanning. |
| Cursor | `~/.cursor/skills` | `<workspace>/.cursor/skills`, `<workspace>/.agents/skills` | `/` | Uses slash-style commands. |
| OpenCode | `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills` | Cwd-to-topmost-git-root `.opencode/skills`, `.claude/skills`, and `.agents/skills` | `/` | Reuses OpenCode, Claude, and Agents skill locations. Overlapping roots are deduplicated before scanning. |
| Antigravity | none | none | none | Read-only and empty, so nothing is written under `~/.gemini`. |

Command forms currently used by the providers are:

- Claude user/project skills: `/skill-name`
- Claude plugin skills: `/plugin-name:skill-name`
- Codex skills: `$skill-name`
- Cursor skills: `/skill-name`
- OpenCode skills: `/skill-name`
- Antigravity: no skills are listed

9. Implement sessions.

- Implement `normalizeMessage(raw, sessionId)` and `fetchHistory(sessionId, options)`.
- Use `createNormalizedMessage(...)` and `generateMessageId(...)` for emitted messages.
- Keep normalized message ids unique. If one raw event produces multiple text
  parts, append a discriminator so ids do not collide.
- Keep pagination consistent:
  - `limit: null` means unbounded/full history.
  - `limit: 0` means an empty page.
  - always return `total`, `hasMore`, `offset`, and `limit` when paginating.
- Sanitize any filesystem-derived ids before using them in file or database paths.
- Do not assume a provider's history format matches another provider's format.
- Look a session's data up by `options.providerSessionId`, not by the app
  session id. `sessionsService.fetchHistory` passes it, then rewrites every
  message's `sessionId` to the app id.
- Build message ids with one helper shared by `normalizeMessage` and
  `fetchHistory`. The client refetches history after a run and dedupes it by
  id, so live and stored ids must match.
- `resolveEditAnchor`, `rewindSession`, and `readWorkflowAgentActivity` are
  optional. Without them, message editing and workflow cards are unavailable.

10. Implement session synchronization.

- Implement `synchronize(since?: Date)` to scan provider artifacts and upsert
  sessions into `sessionsDb`.
- Implement `synchronizeFile(filePath)` for single-file watcher updates. It
  returns the session row id from `sessionsDb.createSession(...)`, or `null`.
- Use the existing helpers when they fit:
  - `buildLookupMap(...)`
  - `extractFirstValidJsonlData(...)`
  - `findFilesRecursivelyCreatedAfter(...)`
  - `normalizeSessionName(...)`
  - `readFileTimestamps(...)`
- Make the sync resilient to partial, malformed, or missing provider files.
- The orchestration service runs all provider synchronizers and only advances
  `scan_state.last_scanned_at` when every provider succeeds. Return 0 when the
  provider has no data on this machine, but let unexpected read errors throw,
  so the cursor does not move past updates that were never read.
- Store `jsonl_path` as `null` when sessions live in a shared database, so
  deleting one app session cannot remove it.
- Add the provider's roots and target files to
  `server/modules/providers/services/sessions-watcher.service.ts`
  (`PROVIDER_WATCH_PATHS`, `isWatcherTargetFile`). Do not create a root that
  belongs to another tool: Antigravity's roots are only watched when they
  already exist.

Current session sync roots are:

| Provider | Scan Roots | Metadata Helpers / Notes |
| --- | --- | --- |
| Claude | `~/.claude/projects/**/*.jsonl` | Uses `~/.claude/history.jsonl` for name lookup and the trailing `ai-title`, `last-prompt`, or `custom-title` entries for title recovery. |
| Codex | `~/.codex/sessions/**/*.jsonl` | Uses `~/.codex/session_index.jsonl` for title lookup and the last `task_complete` message for a fallback title. |
| Cursor | `~/.cursor/projects/**/*.jsonl` | Uses sibling `worker.log` to recover `workspacePath`, then derives the session title from the first user prompt. |
| OpenCode | `~/.local/share/opencode/opencode.db` | Reads active sessions/messages/parts from OpenCode's shared SQLite database and stores `jsonl_path` as `null` so deleting one app session cannot remove the shared DB. |
| Antigravity | `<root>/conversation_summaries.db` in each agy data root: the colon-separated `AGY_DATA_DIRS` when set, else `~/.gemini/antigravity-cli` and `~/.gemini/antigravity` | Never opens agy's files in place: each scan copies the database and its `-wal` (never the `-shm`) into a private temp directory and reads the copy, so nothing under `~/.gemini` is written; a missing root or database means no sessions. Each root keeps its own high-water mark in `app_config` (`agy_root_watermarks`) instead of the shared scan cursor, so an older build that advanced the cursor during a rollback cannot hide conversations, and a root that fails to read keeps its mark. History comes from `<root>/brain/<id>/.system_generated/logs/transcript_full.jsonl`, else `transcript.jsonl`. The watcher reacts to the database, its `-wal` file, and those transcripts. Stores `jsonl_path` as `null`. New chats are bound by the runtime's `init` event, not by claiming pending app sessions. |

11. Register the provider.

- Add the new provider class to `server/modules/providers/provider.registry.ts`.
- Update `server/modules/providers/provider.routes.ts` provider parsing.
- If the provider introduces a new service or lifecycle hook, export it from the module entrypoint that consumes providers.

12. Wire runtime and UI surfaces outside the providers module when needed.

If the provider can run live chat sessions, update these too:

- The agent API: `AGENT_RUN_PROVIDERS` and the run dispatch in
  `server/modules/agent/agent.routes.ts`, with their dependencies in
  `server/modules/agent/agent.module.ts` and `server/index.ts`, which takes
  each runner from `providerRuntimeService.getRunner(...)`.
- The Shell tab: a branch in `buildShellCommand` and a name for the welcome
  line in `server/modules/websocket/services/shell-websocket.service.ts`. An
  unknown provider launches `claude`.
- Token usage: a branch in
  `server/modules/providers/services/provider-token-usage.service.ts`. An
  unknown provider is looked up as a Claude transcript and answers 404 every
  time a session opens.
- Slash commands: the provider lists in
  `server/modules/commands/commands.routes.ts` (step 1).

If the provider is visible in the UI, update:

- `src/shared/types.ts`, `src/shared/selectedProvider.ts`, and
  `src/shared/constants.ts`
- `src/modules/chat/hooks/useChatProviderState.ts` (fallback models,
  permission modes, and effort values)
- `src/modules/chat/transcript/ProviderSelectionEmptyState.tsx`
- `src/modules/mcp/McpServers.tsx`
- `src/modules/provider-auth/hooks/useProviderAuthStatus.ts`
- `src/modules/provider-auth/ProviderLoginModal.tsx` if the provider has a
  login or setup flow (an unknown provider runs the Claude login)
- `src/shared/ui/LLMProviderLogo.tsx` (an unknown provider shows the Claude logo)
- `src/modules/settings/tabs/agents-settings/AgentsSettingsTab.tsx`,
  `sections/AgentSelectorSection.tsx`, and `sections/content/AccountContent.tsx`
- `src/modules/onboarding/AgentConnectionsStep.tsx`
- `src/modules/skills/ProviderSkills.tsx` and
  `src/modules/sidebar/utils/sidebarProjectFormatting.ts`
- `src/modules/shell/Shell.tsx` if the provider's Shell launch honours the
  bypass toggle, which is shown per provider
- the locale files under `src/modules/i18n/locales/`

## Minimal Wrapper Template

```ts
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { <Provider>ProviderAuth } from './<provider>-auth.provider.js';
import { <Provider>ProviderModels } from './<provider>-models.provider.js';
import { <Provider>McpProvider } from './<provider>-mcp.provider.js';
import { <provider>Runtime } from './<provider>-runtime.provider.js';
import { <Provider>SkillsProvider } from './<provider>-skills.provider.js';
import { <Provider>SessionsProvider } from './<provider>-sessions.provider.js';
import { <Provider>SessionSynchronizer } from './<provider>-session-synchronizer.provider.js';
import type {
  IProviderAuth,
  IProviderMcp,
  IProviderModels,
  IProviderRuntime,
  IProviderSessionSynchronizer,
  IProviderSessions,
  IProviderSkills,
} from '@/shared/interfaces.js';

export class <Provider>Provider extends AbstractProvider {
  readonly runtime: IProviderRuntime = <provider>Runtime;
  readonly models: IProviderModels = new <Provider>ProviderModels();
  readonly auth: IProviderAuth = new <Provider>ProviderAuth();
  readonly mcp: IProviderMcp = new <Provider>McpProvider();
  readonly skills: IProviderSkills = new <Provider>SkillsProvider();
  readonly sessions: IProviderSessions = new <Provider>SessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer =
    new <Provider>SessionSynchronizer();

  constructor() {
    super('<provider>');
  }
}
```

## Minimal Skills Template

```ts
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';

export class <Provider>SkillsProvider extends SkillsProvider {
  constructor() {
    super('<provider>');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    return [
      {
        scope: 'project',
        rootDir: path.join(workspacePath, '.<provider>', 'skills'),
        commandPrefix: '/',
      },
    ];
  }
}
```

## Minimal Session Sync Template

```ts
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

export class <Provider>SessionSynchronizer implements IProviderSessionSynchronizer {
  async synchronize(since?: Date): Promise<number> {
    return 0;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    return null;
  }
}
```

## AI Prompt Template

Use this prompt when asking an AI agent to add a provider:

```text
Add a new provider "<provider>" using the current provider module architecture.

Requirements:
1) Create:
   - server/modules/providers/list/<provider>/<provider>.provider.ts
   - server/modules/providers/list/<provider>/<provider>-runtime.provider.ts
   - server/modules/providers/list/<provider>/<provider>-auth.provider.ts
   - server/modules/providers/list/<provider>/<provider>-models.provider.ts
   - server/modules/providers/list/<provider>/<provider>-mcp.provider.ts
   - server/modules/providers/list/<provider>/<provider>-skills.provider.ts
   - server/modules/providers/list/<provider>/<provider>-sessions.provider.ts
   - server/modules/providers/list/<provider>/<provider>-session-synchronizer.provider.ts
2) Register in:
   - server/modules/providers/provider.registry.ts
   - server/modules/providers/provider.routes.ts
   - server/modules/providers/services/provider-capabilities.service.ts
   - server/shared/types.ts LLMProvider
   - src/shared/types.ts LLMProvider
3) Work through every step of "How To Add A Provider" in
   server/modules/providers/README.md, including the string lists the compiler
   does not check and the provider_models CHECK migration.
4) Mirror the nearest existing provider implementation for file naming, style,
   and error handling.
5) Implement skills support with SkillsProvider and the current skill roots.
6) Implement session synchronization if the provider stores transcript files.
7) Ensure sessions use unique ids, safe path handling, and correct pagination.
8) Keep `sessions` and `sessionSynchronizer` separate.
9) Run:
   - npx oxlint <touched files>
   - npm run typecheck
```

## Validation

After adding or changing a provider, run the relevant checks:

```bash
npx oxlint server/modules/providers server/shared
npm run typecheck
```

Useful tests in this repo:

- `server/modules/providers/tests/mcp.test.ts`
- `server/modules/providers/tests/skills.test.ts`
- `server/modules/providers/tests/opencode-sessions.test.ts`

These tests list every provider and need the new id:

- `server/modules/providers/tests/provider-runtime.service.test.ts`
- `server/modules/providers/tests/provider-capabilities.service.test.ts`
- `server/modules/providers/tests/provider-models.service.test.ts`
- `server/modules/providers/tests/provider.routes.test.ts`
- `server/modules/providers/tests/mcp.test.ts`
- `server/modules/websocket/tests/shell-websocket.service.test.ts`

If you touch sessions or session synchronization, add or update focused tests
alongside the implementation.

## Common Mistakes

- Adding provider files but forgetting `provider.registry.ts` or
  `provider.routes.ts`.
- Adding a live runtime without exposing it from the provider wrapper.
- Updating backend provider ids but not `src/shared/types.ts` or the frontend
  provider constants.
- Missing one of the provider lists the compiler does not check (step 1).
  They fail quietly: a 400 response, or a silent fallback to `claude`.
- Widening the `provider_models` CHECK in `schema.ts` without checking that
  `migrations.ts` widens it in existing databases too.
- Omitting `runtime`, `skills`, or `sessionSynchronizer` from the wrapper.
- Returning duplicate normalized message ids for split content.
- Treating `limit === 0` as unbounded history.
- Building file paths from raw session ids without validation.
- Hardcoding a skill root without checking the provider's actual discovery rules.
- Forgetting that Claude plugin skills are discovered differently from normal
  user/project skill folders.
- Assuming one provider's MCP config file format works for the others.


