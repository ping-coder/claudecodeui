import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';

//----------------- HTTP RESPONSE SHAPES ------------
/**
 * Canonical success envelope used by backend APIs that return a structured payload.
 *
 * Use this for route handlers that need a stable `success/data` shape so frontend
 * consumers can parse responses consistently across endpoints.
 */
export type ApiSuccessShape<TData = unknown> = {
  success: true;
  data: TData;
};

/**
 * Generic plain-object record used when parsing loosely typed JSON payloads.
 *
 * Use this only after runtime shape checks, not as a replacement for validated
 * domain models.
 */
export type AnyRecord = Record<string, any>;

// ---------------------------
//----------------- WEBSOCKET TRANSPORT TYPES ------------
/**
 * Minimal websocket client contract used by backend broadcaster services.
 *
 * Any transport object added to `connectedClients` must implement these two
 * members so shared services can safely send JSON strings and check whether the
 * socket is still open before broadcasting.
 */
export type RealtimeClientConnection = {
  readyState: number;
  send(data: string): void;
};

/**
 * Authenticated user payload attached to websocket upgrade requests.
 *
 * Platform and OSS auth flows currently use either `id` or `userId`; both are
 * represented here so websocket handlers can resolve a stable writer user id.
 */
export type AuthenticatedWebSocketUser = {
  id?: string | number;
  userId?: string | number;
  username?: string;
  [key: string]: unknown;
};

/**
 * HTTP upgrade request shape after websocket authentication succeeds.
 *
 * `verifyClient` populates `request.user` with the authenticated payload, and
 * downstream websocket handlers rely on this extended request type.
 */
export type AuthenticatedWebSocketRequest = IncomingMessage & {
  user?: AuthenticatedWebSocketUser;
};

// ---------------------------
//----------------- PROVIDER MESSAGE MODEL ------------
/**
 * Providers supported by the unified server runtime.
 *
 * Use this as the source of truth whenever a function or payload needs to identify
 * a specific LLM integration.
 */
export type LLMProvider = 'claude' | 'codex' | 'cursor' | 'opencode' | 'agy';

/**
 * One selectable model row in a provider model catalog.
 */
export type ProviderModelOption = {
  value: string;
  label: string;
  description?: string;
  /** Stable SQLite row id used only by model-management actions. */
  recordId?: number;
  /** True for user-created rows; false for immutable CloudCLI defaults. */
  isCustom?: boolean;
  effort?: {
    default?: string;
    values: {
      value: string;
      description?: string;
    }[];
  };
  /**
   * True when this model can run with ultracode: Claude Code's standing
   * dynamic-workflow orchestration. Ultracode is an on/off switch beside the
   * effort level, not one of the `effort.values`, and combines with any of
   * them. Only providers whose capabilities report `supportsUltracode` set it;
   * absent means unsupported.
   */
  supportsUltracode?: boolean;
};

/**
 * Provider model catalog returned by `GET /api/providers/:provider/models`.
 */
export type ProviderModelsDefinition = {
  OPTIONS: ProviderModelOption[];
  DEFAULT: string;
  /**
   * Reasoning-effort levels a custom entry of this catalog may declare, weakest
   * first; empty for providers without effort support. The Providers service
   * sets it on merged catalogs from the capability matrix, so the model
   * library offers the same levels on every machine. Adapter catalogs omit it.
   */
  EFFORT_LEVELS?: string[];
  /**
   * The user's "use only my models" flag for this provider, set by the
   * Providers service on merged catalogs. While it is true and at least one
   * custom model exists, `OPTIONS` holds only custom models and `DEFAULT` is
   * the first of them; with no custom models the built-ins are listed anyway.
   * Adapter catalogs omit it.
   */
  CUSTOM_MODELS_ONLY?: boolean;
};

/**
 * One persisted custom-model row in the provider model library.
 *
 * Provider modules use this shape at the database boundary. Predefined models
 * never use this type because they remain source-controlled in provider
 * adapters. `modelId` is sent to the provider runtime, while `model` is the
 * user-supplied display name shown in pickers.
 */
export type CustomProviderModelRecord = {
  recordId: number;
  provider: LLMProvider;
  modelId: string;
  model: string;
  sortOrder: number;
  /** NULL for rows that never declared effort levels, including pre-existing rows. */
  effort: CustomProviderModelEffort | null;
};

/**
 * Reasoning-effort levels a user declared for one custom model.
 *
 * `values` holds unique, non-empty level ids drawn from the levels the
 * provider's predefined models declare, and is never empty (an empty
 * declaration is stored as NULL). `default`, when present, is one of `values`
 * and documents the level the provider applies when the composer sends
 * `Default`, mirroring `ProviderModelOption['effort'].default`.
 */
export type CustomProviderModelEffort = {
  values: string[];
  default?: string;
};

/**
 * User-editable values accepted when creating or changing a custom model.
 *
 * `id` must be the exact provider-facing model identifier and cannot contain
 * whitespace. `model` is a concise display name. The provider is supplied by
 * the route path so a row can never be moved across providers accidentally.
 */
export type CustomProviderModelInput = {
  id: string;
  model: string;
  /**
   * Optional reasoning-effort declaration. `undefined` leaves stored metadata
   * untouched on update (and stores none on create) so clients that predate
   * effort metadata keep working; `null` clears it.
   */
  effort?: CustomProviderModelEffort | null;
};

// ---------------------------
//----------------- PROVIDER ACTIVE MODEL TYPES ------------
/**
 * Provider-neutral result for the model that is actively driving a session or
 * provider runtime at the time of lookup.
 *
 * `model` must always be populated. Provider adapters should use the
 * provider-specific lookup method requested by the caller, and only fall back
 * to the provider catalog `DEFAULT` value when the active model cannot be read.
 */
export type ProviderCurrentActiveModel = {
  model: string;
};

/**
 * Where a resolved session model came from.
 *
 * `session` means the app has recorded a model for this session (the user
 * picked one, or the session has been sent on at least once) and that value is
 * authoritative. `provider` means the session predates any app-recorded model
 * and the value was read back from the provider's own session state — the case
 * for sessions started directly in a provider CLI. `default` means neither was
 * available and the catalog default is standing in.
 *
 * Routes surface this so the frontend can tell a real selection apart from a
 * placeholder without re-deriving the precedence chain.
 */
export type ProviderSessionModelSource = 'session' | 'provider' | 'default';

/**
 * The model one session runs with, its persisted reasoning effort and ultracode
 * choice when they have been recorded, and where the model answer came from.
 *
 * Returned by `providerModelsService.resolveSessionModel` and used by the
 * `/models`, `/cost` and `/status` commands, the active-model route, and the
 * composer's model picker so every surface agrees on one answer.
 */
export type ProviderSessionModel = {
  provider: LLMProvider;
  sessionId: string | null;
  model: string;
  /** NULL means this session has not recorded an effort choice yet. */
  effort: string | null;
  /**
   * Whether this session last ran with ultracode on. NULL means no choice has
   * been recorded yet. Independent of `effort`; see
   * `ProviderModelOption['supportsUltracode']`.
   */
  ultracode: boolean | null;
  source: ProviderSessionModelSource;
};

/**
 * Message/event variants emitted by provider adapters and normalized transports.
 *
 * Keep this union in sync with event kinds produced by provider session adapters.
 *
 * `insert_status` is the one kind both sides send: a runtime reports an
 * accepted insert's progress through the run's writer, and the chat gateway
 * answers a refused insert or a failed cancel straight to the asking socket
 * (see `InsertStatus`).
 */
export type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_resolved'
  | 'permission_cancelled'
  | 'session_created'
  | 'history_truncated'
  | 'task_notification'
  | 'task_status'
  | 'insert_status';

/**
 * Event kinds added by the chat gateway layer on top of provider message kinds.
 *
 * These are app-level realtime events (subscription acks, sidebar deltas, run
 * ends, project loading progress, protocol failures) that are not produced by
 * any provider adapter. Together with `MessageKind` they form the complete set of
 * `kind` values a websocket client can receive, so the frontend only ever
 * needs one kind-based switch.
 *
 * `send_refused` answers a `chat.send` that asked to keep the session's
 * background work and could not: the gateway started no run, and tells only
 * the asking socket, without `seq` (see `ProviderHandOverPlan`).
 */
export type GatewayEventKind =
  | 'chat_subscribed'
  | 'session_upserted'
  | 'run_ended'
  | 'loading_progress'
  | 'protocol_error'
  | 'send_refused';

/**
 * Complete set of `kind` values emitted to websocket clients.
 *
 * Every server-to-client websocket frame carries a `kind` from this union.
 * Provider runtimes emit `MessageKind` values; gateway services emit
 * `GatewayEventKind` values.
 */
export type ServerEventKind = MessageKind | GatewayEventKind;

/** The owning project as it appears inside a `session_upserted` delta. */
export type SessionUpsertedProject = {
  projectId: string;
  path: string;
  fullPath: string;
  displayName: string;
  isStarred: boolean;
};

/**
 * The `session_upserted` sidebar delta, built only by
 * `modules/websocket/services/session-upsert-broadcast.service.ts`.
 *
 * Typed rather than assembled as an untyped object literal because the payload
 * used to be built in two places and silently drifted apart: one copy set
 * `providerSessionId` and the other did not, and nothing could detect it.
 *
 * `providerSessionId` is how a client recognises that a row it is currently
 * showing has been merged into its canonical app-session row, so it is always
 * present — `null` only while the provider has not reported an id yet.
 */
export type SessionUpsertedEvent = {
  kind: 'session_upserted';
  sessionId: string;
  providerSessionId: string | null;
  provider: LLMProvider;
  session: {
    id: string;
    summary: string;
    messageCount: number;
    lastActivity: string;
  };
  project: SessionUpsertedProject | null;
  timestamp: string;
};

/**
 * How a run, or the background work a completed run left behind, ended.
 *
 * `done`, `failed` and `aborted` describe a turn and are read from its terminal
 * `complete`. `backgroundDone` is the later end of the agents or workflows that
 * turn left running, reported once their follow-up turn has come back (Claude
 * only today).
 */
export type RunEndOutcome = 'done' | 'failed' | 'aborted' | 'backgroundDone';

/**
 * Broadcast to every connected chat socket (like session_upserted) when the run registry sees a run's
 * first `complete`, and when the background work a completed run left behind has finished and the CLI's
 * follow-up turn reported (Claude). Kept 10 minutes, at most 200, for GET /api/providers/sessions/run-ends.
 * sessionId + runStartedAt + phase (turn | background) name one end identically in every tab.
 *
 * Built only by `modules/websocket/services/chat-run-registry.service.ts`. It
 * covers every run the registry tracks, whoever started it: a chat send from
 * any tab or device, a queued or scheduled message, an Agent API call. The
 * frame goes out a microtask after the turn's `complete`, so the run's own
 * listeners always see the `complete` first. It is a gateway frame: it has no
 * `seq` and is never replayed by `chat.subscribe`.
 */
export type RunEndedEvent = {
  kind: 'run_ended';
  /** App session id. */
  sessionId: string;
  provider: LLMProvider;
  /** The registry run's startedAt (server clock); the run's identity. */
  runStartedAt: number;
  /** Server clock. */
  endedAt: number;
  /**
   * complete: aborted → 'aborted'; success === false (exitCode !== 0 when success is absent) → 'failed'; else 'done'.
   * A `complete` that carries neither `success` nor a numeric `exitCode` (Codex's live `turn_complete`)
   * is 'done', as the chat client has always read it.
   */
  outcome: RunEndOutcome;
  /** 'done' only: the runtime still held background work for the session when the turn completed. */
  backgroundWork: boolean;
  /**
   * sessions.custom_name, so a tab that has not loaded the session can still name it. Trimmed;
   * null when the row has no name or the lookup failed.
   */
  sessionName: string | null;
  /** ISO time, like the other gateway frames. */
  timestamp: string;
};

/**
 * Provider-neutral message envelope used in REST responses and realtime channels.
 *
 * Every provider-specific message must be converted into this shape before being
 * emitted outside provider-specific modules.
 */
/**
 * A compaction, as the transcript records it.
 *
 * `running` is the status the CLI sends when it starts compacting, `done` the
 * boundary it sends when it has, `failed` a compaction that did not finish.
 * The token counts and duration only come with a boundary.
 */
export type CompactionInfo = {
  phase: 'running' | 'done' | 'failed';
  /** Whether the user asked for it or the context window did. */
  trigger?: 'manual' | 'auto';
  /** Tokens the conversation held before and after, when the boundary reports them. */
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  error?: string | null;
};

export type NormalizedMessage = {
  id: string;
  /**
   * The provider's own identifier for the transcript row this message came
   * from, when the provider has stable per-row identity (today: Claude's
   * `uuid`). It is what "edit this message" and "fork from here" address, so it
   * has to survive a reload — never a value this app synthesized.
   */
  transcriptAnchorId?: string;
  sessionId: string;
  timestamp: string;
  provider: LLMProvider;
  kind: MessageKind;
  /**
   * Monotonic per-run sequence number assigned by the chat run registry when a
   * live event is forwarded to the websocket. History messages loaded over
   * REST do not carry it. Clients use it with `chat.subscribe` to replay only
   * the live events they missed across websocket reconnects.
   */
  seq?: number;
  role?: 'user' | 'assistant';
  content?: string;
  /**
   * The model that produced this assistant message, as the provider reported
   * it on the transcript row (today: Claude's `message.model`, e.g.
   * `claude-opus-5`). Absent on user turns — no provider records which model a
   * request went out with — and absent when the provider named a placeholder
   * such as `<synthetic>`, so a locally-fabricated notice is never labelled
   * with a model it did not run on.
   */
  model?: string;
  /**
   * Optional display-oriented metadata used by providers that need to expose
   * richer transcript artifacts without introducing a brand-new message kind.
   *
   * Current Claude usage:
   * - local slash commands expose parsed command fields
   * - compact summaries are flagged so the UI can treat them differently later
   */
  displayText?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  /** Set on the row that stands in for a compaction, so the UI can draw it as one. */
  compact?: CompactionInfo;
  images?: unknown;
  /** Non-image files attached to a user turn after provider history normalization. */
  files?: unknown;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: {
    content?: string;
    isError?: boolean;
    toolUseResult?: unknown;
  };
  isError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  reason?: string;
  newSessionId?: string;
  status?: string;
  summary?: string;
  tokenBudget?: unknown;
  /**
   * Timeline of everything a subagent did, attached to the `tool_use` that
   * spawned it. Present for Claude `Agent`/`Task` calls and Codex
   * `spawn_agent` calls; absent for every other tool.
   */
  subagentTools?: SubagentActivity[];
  /** Identity and lifecycle of the subagent this `tool_use` spawned. */
  subagent?: SubagentInfo;
  /** The workflow run this `tool_use` launched, read from its journal on disk. */
  workflow?: WorkflowInfo;
  /** Stored memory the reply drew on, when the provider reports it. */
  memoryCitations?: MemoryCitation[];
  toolUseResult?: unknown;
  sequence?: number;
  rowid?: number;
  /**
   * `task_status` fields: one lifecycle event of a background task the live
   * run is tracking. `taskId` is the provider's task handle; `toolUseId` names
   * the call that launched it and is absent on `updated`, which the SDK keys by
   * task id alone. `status` and `summary` above carry the event's own.
   */
  event?: 'started' | 'progress' | 'updated' | 'notification';
  taskId?: string;
  toolUseId?: string;
  taskType?: string;
  workflowName?: string;
  description?: string;
  usage?: TaskUsage;
  outputFile?: string;
  /** A workflow's `progress` only: where each agent the run spawned stands. */
  agents?: WorkflowAgentProgress[];
  /**
   * `insert_status` only: the client-generated UUID naming the insert, which
   * is also the uuid the CLI writes for the message. Every status of one
   * insert carries the same id, and the client that sent it matches on it.
   */
  insertId?: string;
  /** `insert_status` only: where the insert stands (see `InsertStatus`). */
  insertStatus?: InsertStatus;
  /**
   * `insert_status` only, optional: why. A `refused` status always carries
   * one of `NO_ACTIVE_RUN` (no turn in progress; an idle session takes a
   * normal send), `UNSUPPORTED` (the provider cannot insert; queue it),
   * `SLASH_COMMAND` (never read mid-turn; queue it) or `INVALID` (malformed,
   * unknown session, attachments, reused insertId). The gateway's
   * `cancel_failed` carries `NOT_FOUND`, `UNSUPPORTED`, `INVALID` or
   * `INTERNAL_ERROR`, or nothing when the CLI is already delivering the
   * insert, and its `failed` carries `INTERNAL_ERROR`. On the runtime's
   * statuses it is the runtime's own word, so clients may show it but must
   * not branch on values they do not know.
   */
  insertReason?: string;
  /**
   * Set on the user `text` message of an insert the model read in the middle
   * of a turn, live and in history, where Claude records it as a
   * `queued_command` attachment row (a message typed into a terminal CLI
   * mid-turn reads back the same way). Its `id` is the row's `source_uuid`,
   * which for an insert sent from here is the insertId, and it has no
   * `transcriptAnchorId`: a conversation cannot be resumed from that row, so
   * the message cannot be edited or forked from. An insert that ran as the
   * next turn is an ordinary user message instead, anchored at the insertId.
   */
  inserted?: boolean;
  [key: string]: unknown;
};

/**
 * What a background task has spent so far, as the CLI reports it on
 * `task_progress` and `task_notification`.
 */
export type TaskUsage = {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
};

/**
 * One background task a live session still has outstanding — a spawned
 * agent, a workflow run or a backgrounded command — as the runtime tracks it
 * from the stream's `task_started` until the event that settles it.
 *
 * `taskId` is the handle a stop request names; `toolUseId` is the call that
 * launched it, which is how the client pairs the task with its card.
 * `startedAt` is the server clock at `task_started`, so a session whose turn
 * has ended can still report how long its work has been going.
 */
export type BackgroundTaskSummary = {
  taskId: string;
  toolUseId: string;
  taskType: string;
  description: string;
  workflowName?: string;
  startedAt: number;
  /**
   * The task was launched by a subagent or workflow agent, not by the
   * session's own turn: its `toolUseId` names a call in that agent's
   * transcript, so no card in this session's transcript matches it. Listed so
   * it can still be stopped; not counted as the session's own work.
   */
  nested?: boolean;
};

/**
 * Whether a provider runtime's own process still holds a session (see
 * `IProviderRuntime.processState`): `running` while a run owns it, starting,
 * mid-turn or held open past its turn; `exiting` while a process that let go
 * of it, or was retired or aborted, is on its way out. Only a runtime that
 * keeps a process past its turn reports it (Claude).
 */
export type ProviderProcessState = 'running' | 'exiting';

/**
 * What this server's own provider processes still hold for one session,
 * merged across runtimes by the provider runtime service
 * (`describeSessionHold`): the process state, `running` winning over
 * `exiting` and null when no runtime reports a process, and every runtime's
 * outstanding background tasks for the session (nested ones included). The
 * Shell tab reads it before starting a CLI on the session, which would report
 * those tasks as orphans and write to the same transcript. It says nothing
 * about other CloudCLI instances or CLIs started outside this server.
 */
export type SessionHold = {
  processState: ProviderProcessState | null;
  tasks: BackgroundTaskSummary[];
};

/**
 * One live Claude process that may still deliver the report of background
 * work it launched in a session: CloudCLI's own SDK run, or a Claude CLI
 * process the CLI's registry (`~/.claude/sessions`) lists for the session,
 * such as a Shell-tab `claude --resume`, a REPL in a terminal, or another
 * CloudCLI instance's run.
 *
 * Background work runs inside the process that launched it, so a launch can
 * only still report through a process that is up and that wrote it.
 * `startedAt` (epoch ms) rules out a process that started after the launch
 * row was written. `entrypoint` is the `CLAUDE_CODE_ENTRYPOINT` the process
 * runs under: `sdk-ts` for an Agent SDK run (CloudCLI pins it for its own
 * runs, and keeps an inherited one away from its Shell tab, whose REPL then
 * writes `cli`), and whatever another process was started with, e.g. `cli`
 * for an interactive REPL or `sdk-cli` for a non-interactive CLI started
 * from one. The CLI also stamps it on every transcript row it writes, so a
 * process of another kind is ruled out too. It is null when the process's
 * record does not say, and then rules nothing out.
 */
export type LiveClaudeRun = {
  startedAt: number;
  entrypoint: string | null;
};

/**
 * Where one agent of a running workflow stands, as the SDK reports it on the
 * run's `task_progress` events.
 *
 * An entry the script has queued but not yet started has no `agentId` and is
 * identified by `index` alone; once the agent runs, `agentId` names the
 * transcript it writes. `lastToolName` and `lastToolSummary` are the agent's
 * own latest tool call — unlike the event's task-level `last_tool_name`, which
 * for a workflow is the current agent's label.
 */
export type WorkflowAgentProgress = {
  index: number;
  label?: string;
  /** The title of the script phase the agent runs under, when it has one. */
  phase?: string;
  agentId?: string;
  model?: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  startedAt?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  promptPreview?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  resultPreview?: string;
};

/**
 * One workflow agent's recorded timeline, read from its transcript on demand
 * when the card is opened — the SDK never streams an agent's own rows to the
 * parent session, so this is the only way to see what it did.
 *
 * `activityCount` is the full length of the timeline; `activity` is capped
 * for transport like a subagent's `subagentTools`.
 */
export type WorkflowAgentActivity = {
  agent: {
    id: string;
    label?: string;
    model?: string;
    status: 'running' | 'completed' | 'failed' | 'stopped';
  };
  activity: SubagentActivity[];
  activityCount: number;
};

/**
 * One agent a workflow run spawned, as its journal records it.
 *
 * `label` and `phase` are whatever the script passed when it spawned the
 * agent; older scripts passed neither. An agent with a `started` record and no
 * `result` or `failed` one is still running as far as the journal knows.
 */
export type WorkflowAgentInfo = {
  id: string;
  label?: string;
  phase?: string;
  /** `stopped` is an agent the journal never settled although the run itself has — abandoned by a stop or a resume that re-ran the step. */
  status: 'running' | 'completed' | 'failed' | 'stopped';
};

/**
 * A `Workflow` tool call's run, attached to the `tool_use` that launched it.
 *
 * `status` follows the same rule as a background agent's: the task
 * notification's word when one exists, else `running` only while the process
 * that launched it is still up, else `stopped`. The agent list and counts come
 * from `<transcriptDir>/journal.jsonl`; both are empty when the run left no
 * journal behind (a fork copies only the parent's transcript).
 */
export type WorkflowInfo = {
  runId: string;
  name: string;
  description?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  /**
   * When the run's outcome was written to the session transcript, as an ISO
   * 8601 timestamp on the server's clock: the latest row that carried its
   * `<task-notification>`, whether a user-role turn or a queue-operation
   * record. A run's end is not streamed when the turn is driven outside
   * CloudCLI (a Shell-tab `claude --resume`), so this is the only way to
   * place it. Absent while the run has not reported, including a `stopped`
   * run whose process ended first, since nothing records when that run ended.
   */
  endedAt?: string;
  agents: WorkflowAgentInfo[];
  agentCounts: { total: number; completed: number; failed: number; running: number; stopped: number };
  scriptPath?: string;
};

/**
 * One stored memory an assistant reply drew on.
 *
 * Codex appends these to a reply that used its memory files, naming the file
 * and line range it read plus a short note on what it took from there. The
 * transcript shows them as a footnote so a memory-derived claim is traceable
 * rather than arriving as an unattributed assertion.
 */
export type MemoryCitation = {
  /** File and line range that was read, e.g. `MEMORY.md:137-142`. */
  source: string;
  /** What the reply took from that range, when the provider states it. */
  note?: string;
};

/**
 * One entry in a subagent's recorded timeline.
 *
 * Providers store a subagent's work in a separate transcript (Claude:
 * `<session>/subagents/agent-<id>.jsonl`; Codex: a sibling rollout keyed by
 * `agent_thread_id`). Both are flattened into this shape so the transcript can
 * replay a subagent's run with the same renderers the main thread uses.
 *
 * `kind` decides which fields matter: `tool` uses the tool fields, `text` and
 * `thinking` use `content`. Consumers must not assume tool fields exist on the
 * text kinds.
 */
export type SubagentActivity = {
  kind: 'tool' | 'text' | 'thinking';
  timestamp?: string;
  /** Tool-call identity; only set when `kind` is `tool`. */
  toolId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: { content?: string; isError?: boolean } | null;
  /** Message body; only set when `kind` is `text` or `thinking`. */
  content?: string;
};

/**
 * Identity and lifecycle of one spawned subagent, normalized across providers.
 *
 * `status` is `running` until the call that spawned the agent resolves. After
 * that it is whatever the provider reported — Claude's task notification
 * carries one — and `completed` when the provider reported nothing. A failed
 * tool call *inside* the agent is not a failed agent, so it is never inferred
 * from the transcript. A background agent whose session process ended before
 * it reported is `stopped`: no outcome exists and none is coming.
 */
export type SubagentInfo = {
  /** Provider-native agent id — Claude `agentId`, Codex `agent_thread_id`. */
  id: string;
  /** Human-facing label: Claude's agent type, or Codex's assigned nickname. */
  name?: string;
  /** Agent type/preset when the provider records one (Claude `agentType`). */
  type?: string;
  /** One-line task summary shown in the collapsed header. */
  description?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  /** Model the subagent ran on, when the provider records it. */
  model?: string;
  /**
   * How many activities the agent actually recorded. It exceeds
   * `subagentTools.length` when a long run was truncated for transport, which
   * lets the UI say so instead of silently showing a partial timeline.
   */
  activityCount?: number;
};

/**
 * Output gateway shared by WebSocket and SSE provider runs.
 *
 * Runtime adapters only depend on this structural surface, which keeps them
 * independent from the transport that ultimately delivers normalized events.
 */
export type ProviderRuntimeWriter = {
  send(data: unknown): void;
  setSessionId?(sessionId: string): void;
  userId?: string | number | null;
  isWebSocketWriter?: boolean;
  /**
   * The background work a completed turn left behind has finished and its follow-up turn reported. Optional: SSE writers leave it out.
   *
   * The Claude runtime calls it where it sends the `run.background_completed`
   * notification. Not called when the user stopped the last task, or when a new
   * turn stopped the work, since the CLI pushes no follow-up turn then. The chat
   * gateway's writer records it as a `backgroundDone` run end.
   */
  reportBackgroundWorkFinished?(): void;
  /**
   * The session's next run took over the process this writer's turn ran in, with the background work it
   * is held for, instead of stopping that work. Optional: SSE writers leave it out.
   *
   * The Claude runtime calls it on the writer of the turn that left the work running when it runs a new
   * turn in that process. The chat gateway's writer records the next run as this run's successor, so the
   * work's later `reportBackgroundWorkFinished` on this writer still counts.
   */
  reportProcessHandedOver?(): void;
  /**
   * When the run this writer belongs to started, in ms, or null when unknown.
   * The chat gateway's writer sets it to the run registry's `startedAt`; other
   * writers leave it out.
   *
   * Runtimes pass it as `runStartedAt` to `notifyRunStopped`, `notifyRunFailed`
   * and `notifyBackgroundWorkCompleted`, so the push dedupe names the run that
   * ended. A runtime can report after its terminal `complete`, by which time
   * the session's next run may already hold the registry slot.
   */
  readonly runStartedAt?: number | null;
};

export type ProviderPermissionDecision = {
  allow: boolean;
  updatedInput?: unknown;
  message?: string;
  rememberEntry?: unknown;
};

export type ProviderRuntimePermissionGateway = {
  resolve(requestId: string, decision: ProviderPermissionDecision): void;
  listPending(sessionId: string): unknown[];
};

/**
 * Provider-scoped application capabilities supplied to a runtime for one run.
 *
 * Keeping these lookups outside concrete SDK/CLI adapters prevents the
 * adapters from importing services that resolve back through providerRegistry.
 */
export type ProviderRuntimeContext = {
  resolveProviderSessionId(sessionId: string | null | undefined): string | null;
  resolveResumeModel(
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined>;
  getProviderModels(): Promise<ProviderModelsDefinition>;
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[];
  isProviderInstalled(): Promise<boolean>;
  /**
   * Builds the SDK query for a run. Production leaves this unset and the
   * runtime uses the SDK's own; tests supply a scripted stream so the hold
   * and background-work paths can be driven without a CLI process.
   */
  createQuery?: (input: { prompt: AsyncIterable<unknown>; options: AnyRecord }) => AsyncIterable<unknown> & {
    interrupt(): Promise<void>;
    stopTask?(taskId: string): Promise<void>;
    /** Ends the query and its CLI process: stdin first, then SIGTERM and SIGKILL. */
    close?(): void;
    /**
     * Switch the live process's model and permission mode, for a turn the runtime runs in a process it
     * held for background work. Without them, a turn that changes either starts a process of its own.
     */
    setModel?(model?: string): Promise<void>;
    setPermissionMode?(mode: string): Promise<void>;
  };
};

export type ProviderRunFunction = (
  command: string,
  options: AnyRecord,
  writer: ProviderRuntimeWriter,
) => Promise<unknown>;

/**
 * Shared options used to fetch historical provider messages.
 *
 * Consumers should pass provider-specific lookup hints (`projectPath`) only
 * when the selected provider requires them.
 *
 * `providerSessionId` is the provider-native session id from the sessions
 * index (transcript file name / provider database key). Provider adapters
 * must use it — never the app-facing session id they were called with — when
 * matching transcript rows on disk, because app-created sessions use an
 * app-allocated id that the provider has never seen.
 */
export type FetchHistoryOptions = {
  projectPath?: string;
  limit?: number | null;
  offset?: number;
  providerSessionId?: string;
};

/**
 * Standardized response payload returned from provider history readers.
 *
 * Use this as the contract for APIs that return paginated conversation history.
 */
export type FetchHistoryResult = {
  messages: NormalizedMessage[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number | null;
  tokenUsage?: unknown;
};

// ---------------------------
//----------------- MID-RUN INSERT TYPES ------------
/**
 * Where one mid-run insert stands, as `insert_status` frames report it.
 *
 * The provider runtime sends these through the run's writer, so they are
 * sequenced, replayed by `chat.subscribe` and seen by every tab and pane on
 * the session: `pending` once it has accepted the insert (it may still be
 * waiting its turn to be written to the CLI), then exactly one of
 * `delivered` (the model read it in the middle of the turn), `next_turn`
 * (the turn ended first, so it ran as the next turn in the same process),
 * `cancelled` (withdrawn, or taken back by an abort before the model read
 * it) or `failed` (it never reached the model: the run ended, or the CLI
 * refused or lost it).
 *
 * The chat gateway sends the rest straight back to the socket that asked,
 * without `seq`, so no other tab sees them: `refused` (the insert was not
 * taken; see `insertReason`) and `cancel_failed` (nothing was withdrawn; the
 * insert carries on and still reports how it ends). A runtime that throws
 * while accepting an insert is answered the same way, as `failed`.
 */
export type InsertStatus =
  | 'pending'
  | 'delivered'
  | 'next_turn'
  | 'cancelled'
  | 'failed'
  | 'refused'
  | 'cancel_failed';

/**
 * What a `chat.insert` hands to a provider runtime. `insertId` is the
 * client-generated UUID, already validated by the gateway; the runtime uses
 * it as the uuid of the message it writes to the CLI, so the live message and
 * the transcript row carry the same id. `content` is plain text, never empty
 * and never a slash command.
 */
export type ProviderInsertInput = {
  insertId: string;
  content: string;
};

/**
 * A provider runtime's answer to `IProviderRuntime.insert`. A refusal emits
 * nothing on the run's writer; the gateway answers the asking socket.
 */
export type ProviderInsertResult =
  | { accepted: true }
  | { accepted: false; reason: 'NO_ACTIVE_RUN' | 'INVALID' | 'DUPLICATE' };

/** A provider runtime's answer to `IProviderRuntime.cancelInsert`. */
export type ProviderCancelInsertResult = {
  status: 'cancelled' | 'cancel_failed' | 'not_found';
};

/**
 * The provider runtime gateway's answer to an insert: the runtime's own, or
 * UNSUPPORTED when the session's provider runtime has no `insert`.
 */
export type ProviderInsertGatewayResult =
  | ProviderInsertResult
  | { accepted: false; reason: 'UNSUPPORTED' };

/**
 * The provider runtime gateway's answer to a withdrawal: the runtime's own, or
 * `unsupported` when the session's provider runtime has no `cancelInsert`.
 */
export type ProviderCancelInsertGatewayResult =
  | ProviderCancelInsertResult
  | { status: 'unsupported' };

// ---------------------------
//----------------- HELD PROCESS HAND-OVER TYPES ------------
/**
 * What keeps a turn out of the process a provider runtime holds open for a
 * session's background work, where it would keep that work running. The CLI
 * takes some settings only at launch, so a turn that changes them needs a
 * process of its own, and starting one stops the work: `cwd`, `effort`,
 * `ultracode`, and `tools` (allowing fewer tools than the process was
 * launched with, or denying others). `model` and `permissionMode` count only
 * when the live process cannot switch to them (bypassPermissions, for a
 * process not launched with it). `lookup`: the runtime could not resolve the
 * turn's options, so it cannot tell.
 */
export type HandOverChange = 'model' | 'effort' | 'ultracode' | 'permissionMode' | 'tools' | 'cwd' | 'lookup';

/**
 * What a turn handed to the held process would switch in that process before
 * its prompt: its `model` or its `permissionMode`, when the turn's differ and
 * the live process can switch to them. The switch outlasts the turn: the
 * background work runs on with it, which is why the scheduled-messages
 * dispatcher keeps a message that would switch anything out of the process.
 * A difference the process cannot switch is a `HandOverChange` instead.
 */
export type HandOverSwitch = Extract<HandOverChange, 'model' | 'permissionMode'>;

/**
 * How `IProviderRuntime.planHandOver`, and the provider runtime gateway's
 * `planHandOver`, read a turn's options. Optional; leaving it out plans the
 * turn exactly as its run options say.
 *
 * - `inheritUnset`: a setting the options leave out (no or a blank `model`,
 *   `effort`, `permissionMode` or `cwd`, no `toolsSettings` or one of its
 *   fields) counts as the live process's own value, so it is neither a change
 *   nor a switch. For a message that carries only some settings: the
 *   scheduled-messages dispatcher plans queued and due messages with it, as a
 *   scheduled one stores no tool rules. A run whose options set
 *   `inheritUnset: true` hands its turn over the same way, so a caller that
 *   plans with it sends the turn with it too; without it the run judges the
 *   turn as its options say, which the plan would not have predicted.
 */
export type ProviderHandOverPlanOptions = {
  inheritUnset?: boolean;
};

/**
 * Whether a session's next turn would keep the background work its last
 * turn left running, worked out without side effects. The answer of
 * `IProviderRuntime.planHandOver`, of the provider runtime gateway's
 * `planHandOver`, which the chat gateway asks before a `chat.send` that set
 * `keepBackgroundWork` and the scheduled-messages dispatcher before it sends
 * a queued or due message, and of POST
 * /api/providers/sessions/:sessionId/hand-over-plan, which the composer asks
 * before it sends over background work (that route answers the first three
 * fields).
 *
 * - `heldWork`: the session's process is held open after its turn for
 *   background work of its own that is still going, or that the runtime
 *   cannot track (a Monitor, a wake-up) and has not reported back. Also true
 *   while a turn runs in a process with such work: tasks of the session's own
 *   still outstanding, or, for a turn handed to the process while it was
 *   held, work of that hold the runtime cannot track or has yet to relay.
 *   Interrupting that turn would stop the work.
 * - `canHandOver`: a `chat.send` with these options would run as that
 *   process's next turn, so the work keeps running. Never while a turn runs.
 * - `changes`: what would keep it out (see `HandOverChange`); empty when it
 *   would go in, or when nothing is held.
 * - `switches`: what handing the turn over would switch in the live process
 *   (see `HandOverSwitch`), listed whether or not `changes` keep the turn
 *   out; empty when nothing differs, when there is no process to hand the
 *   turn to (nothing held, a turn under way, an edited message), and when
 *   the turn's options could not be resolved (`lookup`).
 *
 * A session with no held process, and every runtime that never holds one,
 * answer `{ heldWork: false, canHandOver: false, changes: [], switches: [] }`.
 */
export type ProviderHandOverPlan = {
  heldWork: boolean;
  canHandOver: boolean;
  changes: HandOverChange[];
  switches: HandOverSwitch[];
};

// ---------------------------
//----------------- PROVIDER SKILL TYPES ------------
/**
 * Scope where a provider skill definition was discovered.
 *
 * Provider skill adapters should use this to describe the origin of each
 * skill markdown file without leaking provider-specific folder names into route
 * contracts. `repo` is used for Codex repository lookup locations, while
 * `project` is used for providers that treat workspace-local skills as project
 * scoped.
 */
export type ProviderSkillScope = 'user' | 'project' | 'plugin' | 'repo' | 'admin' | 'system';

/**
 * Shared input accepted by provider skill listing operations.
 *
 * Routes pass `workspacePath` when a caller wants project/repository skills for
 * a specific folder. Providers should fall back to the backend process cwd when
 * this option is omitted.
 */
export type ProviderSkillListOptions = {
  workspacePath?: string;
};

/**
 * One supporting file bundled with an uploaded provider skill.
 *
 * `relativePath` is resolved below the installed skill directory and must never
 * be absolute or contain traversal segments. Text files may use `utf8`; binary
 * scripts and assets should use `base64` so JSON transport does not corrupt
 * their bytes.
 */
export type ProviderSkillCreateFile = {
  relativePath: string;
  content: string;
  encoding: 'utf8' | 'base64';
};

/**
 * One skill markdown payload submitted for provider-managed installation.
 *
 * `content` is the raw markdown body that will be written to `SKILL.md`.
 * `directoryName` lets callers control the target folder name explicitly when
 * they want stable filesystem paths that differ from the markdown front matter
 * `name` field. `fileName` is optional upload metadata used only as a final
 * fallback when no directory name or front matter name is present. `files`
 * carries scripts, references, and other files from a complete skill folder.
 */
export type ProviderSkillCreateEntry = {
  content: string;
  directoryName?: string;
  fileName?: string;
  files?: ProviderSkillCreateFile[];
};

/**
 * Shared input accepted by provider skill creation operations.
 *
 * The service layer batches multiple skill definitions in one request. Each
 * entry can contain only markdown or a complete skill folder.
 */
export type ProviderSkillCreateInput = {
  entries: ProviderSkillCreateEntry[];
};

export type ProviderSkillRemoveInput = {
  directoryName: string;
};

/**
 * Normalized skill record returned by provider skill adapters.
 *
 * The `command` value is the exact invocation text the selected provider expects
 * for this skill. Claude plugin skills use a namespaced command such as
 * `/plugin-name:skill-name`, while Codex skills use the `$skill-name` form.
 * `sourcePath` points to the skill markdown file that produced the record so
 * callers can distinguish duplicate skill names across scopes.
 */
export type ProviderSkill = {
  provider: LLMProvider;
  name: string;
  description: string;
  command: string;
  scope: ProviderSkillScope;
  sourcePath: string;
  pluginName?: string;
  pluginId?: string;
};

/**
 * Internal source descriptor consumed by shared provider skill discovery logic.
 *
 * Concrete provider adapters build these records from their native lookup rules.
 * The shared skills provider then scans `rootDir` for child skill markdown files
 * and uses `commandForSkill` or `commandPrefix` to produce the provider-specific
 * invocation command. Set `recursive` only when a provider stores skills under
 * arbitrary nested folders below the source root.
 */
export type ProviderSkillSource = {
  scope: ProviderSkillScope;
  rootDir: string;
  recursive?: boolean;
  commandPrefix?: '/' | '$';
  commandForSkill?: (skillName: string) => string;
  pluginName?: string;
  pluginId?: string;
};

// ---------------------------
//----------------- SHARED ERROR TYPES ------------
/**
 * Optional metadata used when constructing application-level errors.
 *
 * `statusCode` should reflect the HTTP response status, while `code` identifies
 * the stable machine-readable error category.
 */
export type AppErrorOptions = {
  code?: string;
  statusCode?: number;
  details?: unknown;
};

// ---------------------------
//----------------- MCP TYPES ------------
/**
 * Scope where an MCP server definition is stored and resolved.
 *
 * `user` is global for a user account, `local` is provider-local, and `project`
 * is tied to a specific project path.
 */
export type McpScope = 'user' | 'local' | 'project';

/**
 * Transport protocol used by an MCP server definition.
 */
export type McpTransport = 'stdio' | 'http' | 'sse';

/**
 * Normalized MCP server model exposed to frontend and route handlers.
 *
 * Provider adapters should map provider-native config to this structure before
 * returning results.
 */
export type ProviderMcpServer = {
  provider: LLMProvider;
  name: string;
  scope: McpScope;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: Record<string, string>;
};

/**
 * Payload for create/update MCP server operations.
 *
 * Routes and services should accept this type, validate it, and then persist it
 * through provider-specific MCP repositories.
 */
export type UpsertProviderMcpServerInput = {
  name: string;
  scope?: McpScope;
  transport: McpTransport;
  workspacePath?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: Record<string, string>;
};

// ---------------------------
//----------------- PROVIDER AUTH TYPES ------------
/**
 * Records that an API-key style credential is taking precedence over a
 * still-valid subscription login in `~/.claude/.credentials.json`.
 *
 * Claude Code always prefers `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` over
 * the OAuth login written by `claude /login`, so when both exist every request
 * is billed to the key (pay-as-you-go) rather than the subscription — usually
 * without the user realising it. The Claude auth provider fills this in so the
 * settings UI can say which variable won and where it was found; the fix
 * differs per source (unset the variable and restart the server for
 * `process_env`, edit the `env` block of `~/.claude/settings.json` for
 * `settings_file`). It is never set when the login in the credentials file is
 * missing or expired, because then nothing is being bypassed.
 */
export type ProviderAuthSubscriptionOverride = {
  /** The environment variable Claude Code is using instead of the login. */
  variable: 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN';
  /** Where that variable was found: the server process env or the settings.json env block. */
  source: 'process_env' | 'settings_file';
  /** Email recorded in the credentials file for the bypassed login, when known. */
  subscriptionEmail: string | null;
};

/**
 * Authentication status result returned by provider health checks.
 *
 * This shape is consumed by settings/status endpoints to report installation and
 * credential state for each provider.
 */
export type ProviderAuthStatus = {
  installed: boolean;
  provider: LLMProvider;
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
  /**
   * Present only when `method` is `api_key` and a valid subscription login is
   * being bypassed; see ProviderAuthSubscriptionOverride. Omitted otherwise so
   * existing consumers that never look for it are unaffected.
   */
  subscriptionOverride?: ProviderAuthSubscriptionOverride;
};

// ---------------------------
//----------------- SHARED DATABASE CREDENTIAL TYPES ------------
/**
 * Safe credential view returned by credential listing APIs.
 *
 * This intentionally excludes the raw credential secret while still exposing
 * metadata needed for UI rendering and management operations.
 */
export type CredentialPublicRow = {
  id: number;
  credential_name: string;
  credential_type: string;
  description: string | null;
  created_at: string;
  is_active: number;
};

/**
 * Result returned after creating a credential record.
 *
 * Use this return shape when callers need the created id and display metadata,
 * but must never receive the stored secret value.
 */
export type CreateCredentialResult = {
  id: number | bigint;
  credentialName: string;
  credentialType: string;
};

// ---------------------------
//----------------- CHAT DRAFT QUEUE TYPES ------------
/**
 * A chat message queued to be sent when its session is next idle, in the shape
 * the composer submits it and `session_drafts.queued_message` stores it.
 *
 * `content` is the message text, `attachments` the JSON-safe descriptors
 * returned by POST /api/assets/files, and `options` the composer's send options
 * (model, effort, permission mode, ...) captured when it was queued. A session
 * has at most one: a message queued while another is waiting is merged into it
 * by the drafts repository. The User module accepts it, the Database module
 * stores and merges it, and the Scheduled Messages dispatcher sends it (read
 * through `readQueuedChatMessage`).
 */
export type QueuedChatMessage = {
  content: string;
  options?: Record<string, unknown>;
  attachments: unknown[];
};

// ---------------------------
//----------------- PROJECT PERSISTENCE TYPES ------------
/**
 * Canonical project row shape returned by the projects repository.
 *
 * Use this type whenever backend services need to pass around one database
 * project record without leaking raw SQL row typing across modules.
 */
export type ProjectRepositoryRow = {
  project_id: string;
  project_path: string;
  custom_project_name: string | null;
  isStarred: number;
  isArchived: number;
};

/**
 * Result category returned by `projectsDb.createProjectPath`.
 *
 * `created` means a fresh row was inserted, `reactivated_archived` means an
 * existing archived path was accepted and updated, and `active_conflict` means
 * an already-active path blocked project creation.
 */
export type CreateProjectPathOutcome =
  | 'created'
  | 'reactivated_archived'
  | 'active_conflict';

/**
 * Structured result returned by project-path upsert operations.
 *
 * Services should use this result to decide whether a request succeeded,
 * should return a conflict, or needs follow-up retrieval of row metadata.
 */
export type CreateProjectPathResult = {
  outcome: CreateProjectPathOutcome;
  project: ProjectRepositoryRow | null;
};

/**
 * Validation result for user-supplied workspace/project paths.
 *
 * `resolvedPath` is present only when validation succeeds. `error` is present
 * only when validation fails and is suitable for user-facing diagnostics.
 */
export type WorkspacePathValidationResult = {
  valid: boolean;
  resolvedPath?: string;
  error?: string;
};

// ---------------------------
//----------------- GIT COMMAND EXECUTION AND WORKTREE MANAGEMENT ------------
/**
 * Captured output of one completed `git` invocation.
 *
 * Returned by `GitCommandRunner` and `GitProcessRunner` implementations so the
 * git and worktree services can read both streams without caring about
 * process plumbing.
 */
export type GitCommandResult = {
  stdout: string;
  stderr: string;
};

/**
 * Executes `git <args>` inside `cwd` and resolves with the captured output.
 *
 * All worktree services receive their git access through this contract so
 * tests can inject a fake runner instead of spawning real processes. The
 * promise must reject (with `stderr` attached when available) on a non-zero
 * exit code.
 */
export type GitCommandRunner = (args: string[], cwd: string) => Promise<GitCommandResult>;

/**
 * Executes `command args...` inside `options.cwd` and resolves with the captured output.
 *
 * This is the `spawnAsync` shape the Git routes module injects into its typed
 * services (branch deletion, branch compare) so their tests can substitute a
 * fake runner. Like `GitCommandRunner`, the promise must reject on a non-zero
 * exit code, with `stderr` attached to the error when available.
 */
export type GitProcessRunner = (
  command: string,
  args: string[],
  options: { cwd: string },
) => Promise<GitCommandResult>;

/**
 * One entry parsed from `git worktree list --porcelain`.
 *
 * This is the raw repository-level view (path/HEAD/branch/flags) before any
 * enrichment with project links or ahead/behind counts. `branch` is null for
 * detached-HEAD worktrees.
 */
export type WorktreePorcelainEntry = {
  path: string;
  headSha: string | null;
  branch: string | null;
  isDetached: boolean;
  isLocked: boolean;
  isPrunable: boolean;
};

/**
 * Fully enriched worktree row served to the UI.
 *
 * Extends the porcelain entry with everything the Worktrees panel renders:
 * dirty-file count, ahead/behind relative to the base branch (the branch
 * checked out in the main worktree), last-commit metadata, and the CloudCLI
 * project row linked to the worktree directory (if one was registered).
 */
export type WorktreeDescriptor = {
  path: string;
  branch: string | null;
  headSha: string | null;
  isMain: boolean;
  isCurrent: boolean;
  isLocked: boolean;
  isDetached: boolean;
  changedFileCount: number;
  ahead: number;
  behind: number;
  lastCommitSubject: string | null;
  lastCommitDate: string | null;
  linkedProjectId: string | null;
  linkedProjectArchived: boolean;
};

/**
 * Response payload of `GET /api/worktrees`.
 *
 * `baseBranch` is the branch checked out in the main worktree — the merge
 * target offered by the UI. `worktrees` always lists the main worktree first.
 */
export type WorktreeListResult = {
  repositoryRoot: string;
  baseBranch: string | null;
  worktrees: WorktreeDescriptor[];
};

// ---------------------------
//----------------- WORKTREE SERVICE INPUTS AND RESULTS ------------
/**
 * Input accepted by the worktree-listing workflow.
 *
 * `projectPath` may point at the main checkout or any linked worktree. The
 * service uses Git to resolve the complete repository-level worktree list.
 */
export type ListWorktreesInput = {
  projectPath: string;
};

/**
 * Input accepted when creating a linked Git worktree.
 *
 * `branch` is checked out when it already exists, otherwise it is created from
 * `baseBranch`. When `baseBranch` is omitted, the main worktree branch is used.
 */
export type CreateWorktreeInput = {
  projectPath: string;
  branch: string;
  baseBranch?: string | null;
};

/**
 * Result of successfully creating a linked Git worktree.
 *
 * `createdBranch` distinguishes a new branch from an existing branch checkout,
 * allowing API clients to accurately describe what Git changed.
 */
export type CreateWorktreeResult = {
  worktreePath: string;
  branch: string;
  createdBranch: boolean;
};

/**
 * Result of atomically creating and registering a worktree for project use.
 *
 * The Worktrees application service compensates the Git creation if project
 * registration fails, so routes only receive this shape after both steps pass.
 */
export type CreateAndOpenWorktreeResult = CreateWorktreeResult & {
  project: WorktreeProjectView;
};

/**
 * Input accepted when registering an existing worktree as a CloudCLI project.
 *
 * The service verifies that `worktreePath` belongs to the repository containing
 * `projectPath` before it creates or restores any project record.
 */
export type OpenWorktreeInput = {
  projectPath: string;
  worktreePath: string;
};

/**
 * Project view returned after a worktree is opened in CloudCLI.
 *
 * This deliberately mirrors the project-selection payload used by the Projects
 * module so the frontend can switch to the worktree without another lookup.
 */
export type WorktreeProjectView = {
  projectId: string;
  path: string;
  fullPath: string;
  displayName: string;
  isStarred: boolean;
  sessions: [];
  sessionMeta: { hasMore: false; total: 0 };
};

/**
 * Input accepted when removing a linked Git worktree.
 *
 * `force` permits removal with local changes. `deleteBranch` requests
 * best-effort branch cleanup after the worktree directory is removed.
 */
export type RemoveWorktreeInput = {
  projectPath: string;
  worktreePath: string;
  force?: boolean;
  deleteBranch?: boolean;
};

/**
 * Result of removing a linked Git worktree.
 *
 * `archivalError` reports best-effort project archival failure after Git has
 * already removed the worktree, allowing callers to represent partial success.
 */
export type RemoveWorktreeResult = {
  removedPath: string;
  branch: string | null;
  branchDeleted: boolean;
  archivedProjectId: string | null;
  archivalError: string | null;
};

/**
 * Input accepted when merging a linked worktree into the main worktree branch.
 *
 * The service verifies both worktrees are clean, supports squash and regular
 * merges, and may remove the source worktree after a successful merge.
 */
export type MergeWorktreeInput = {
  projectPath: string;
  worktreePath: string;
  squash?: boolean;
  message?: string | null;
  removeAfterMerge?: boolean;
};

/**
 * Result of a completed worktree merge.
 *
 * `removedWorktree` is populated only when post-merge removal succeeds.
 * `cleanupError` reports failed optional removal without misrepresenting the
 * already-completed merge as a failure.
 */
export type MergeWorktreeResult = {
  mergedBranch: string;
  targetBranch: string;
  squash: boolean;
  removedWorktree: RemoveWorktreeResult | null;
  cleanupError: string | null;
};

// ---------------------------
//----------------- WORKTREE MODULE DEPENDENCY CONTRACTS ------------
/**
 * Filesystem capability required by the Worktrees module.
 *
 * Production wiring checks the real filesystem; unit tests provide a small
 * deterministic fake so worktree creation never touches developer directories.
 */
export type WorktreeFileSystem = {
  pathExists(candidatePath: string): Promise<boolean>;
};

/**
 * Project-management boundary consumed by Worktrees workflows.
 *
 * The Worktrees module uses this contract instead of importing Database or
 * Projects internals. Production adapters delegate through those modules'
 * `index.ts` barrels, while unit tests supply in-memory functions.
 */
export type WorktreeProjectGateway = {
  getProjectPathById(projectId: string): string | null;
  getProjectByPath(projectPath: string): ProjectRepositoryRow | null;
  createProject(input: {
    projectPath: string;
    customName: string;
  }): Promise<{
    outcome: 'created' | 'reactivated_archived';
    project: { projectId: string };
  }>;
  restoreProject(projectId: string): void | Promise<void>;
  archiveProject(projectId: string): void | Promise<void>;
};

/**
 * Complete application-service surface used by the Worktrees HTTP router.
 *
 * Routes parse transport values and call these functions; they do not import
 * repositories, filesystem adapters, Git runners, or individual service files.
 */
export type WorktreeServices = {
  resolveProjectPath(projectId: string): string;
  list(input: ListWorktreesInput): Promise<WorktreeListResult>;
  create(input: CreateWorktreeInput): Promise<CreateWorktreeResult>;
  createAndOpen(input: CreateWorktreeInput): Promise<CreateAndOpenWorktreeResult>;
  open(input: OpenWorktreeInput): Promise<WorktreeProjectView>;
  merge(input: MergeWorktreeInput): Promise<MergeWorktreeResult>;
  remove(input: RemoveWorktreeInput): Promise<RemoveWorktreeResult>;
};

// ---------------------------
//----------------- FILE TREE MODULE CONTRACTS ------------
/**
 * One filesystem item returned by the File Tree API.
 *
 * The service populates metadata without following symlinks and recursively
 * attaches `children` only while the requested depth permits traversal. The
 * frontend uses the absolute `path` as the stable identifier for editor and
 * file-operation requests.
 */
export type FileTreeNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: string | null;
  permissions: string;
  permissionsRwx: string;
  isSymlink?: boolean;
  /**
   * Present, and true, only when `listProjectFiles` runs with `markIgnored`
   * and the entry matches the project root's `.gitignore`. Ignored directories
   * are never walked, so they never carry `children`.
   */
  isIgnored?: boolean;
  children?: FileTreeNode[];
};

/**
 * Minimal directory-entry shape required during File Tree traversal.
 *
 * Production adapts Node `Dirent` objects to this structural contract. Tests
 * provide small handwritten entries and therefore never read real directories.
 */
export type FileTreeDirectoryEntry = {
  name: string;
  isDirectory(): boolean;
};

/**
 * Minimal file-stat shape used for tree metadata and delete decisions.
 *
 * The numeric mode is converted to octal and rwx strings for the UI. `lstat`
 * supplies symlink state while `stat` is used when deciding file versus folder
 * deletion behavior.
 */
export type FileTreeStats = {
  size: number;
  mtime: Date;
  mode: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

/**
 * Complete filesystem capability injected into File Tree services.
 *
 * The production composition root delegates these operations to Node's fs
 * APIs. Unit tests provide deterministic path-keyed fakes so service tests
 * cannot inspect, write, rename, or delete developer files.
 */
export type FileTreeFileSystem = {
  access(candidatePath: string): Promise<void>;
  stat(candidatePath: string): Promise<FileTreeStats>;
  lstat(candidatePath: string): Promise<FileTreeStats>;
  // Streamed rather than returned as an array so a directory with millions of
  // children is abandoned at the entry limit instead of being materialized.
  openDirectory(directoryPath: string): AsyncIterable<FileTreeDirectoryEntry>;
  realpath(candidatePath: string): Promise<string>;
  readTextFile(filePath: string): Promise<string>;
  writeTextFile(filePath: string, content: string): Promise<void>;
  makeDirectory(directoryPath: string, recursive: boolean): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  removeDirectory(directoryPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  copyFile(sourcePath: string, destinationPath: string): Promise<void>;
  createReadStream(filePath: string): Readable;
};

/**
 * Project lookup boundary consumed by File Tree workflows.
 *
 * File Tree services resolve DB-assigned project ids through this contract and
 * never import the Database module or its repositories directly.
 */
export type FileTreeProjectGateway = {
  getProjectPathById(projectId: string): string | null | Promise<string | null>;
};

/**
 * Workspace validation boundary used by filesystem browsing and folder creation.
 *
 * The injected validator enforces the configured workspace root and resolves
 * symlinks before the File Tree service exposes or mutates paths.
 */
export type FileTreeWorkspaceGateway = {
  rootPath: string;
  validatePath(candidatePath: string): Promise<WorkspacePathValidationResult>;
  /**
   * Resolves a path readable outside the workspace root — the system temp
   * directory and the Claude projects directory — or `null` when it is not
   * one. Read-only: the write policy is `validatePath` and it does not consult
   * this.
   */
  resolveReadOnlyRootPath(candidatePath: string): Promise<string | null>;
};

/**
 * Uploaded-file record passed from the Multer transport adapter into the File
 * Tree service.
 *
 * Transport-specific field names are normalized so upload workflows do not
 * depend on Express or Multer types.
 */
export type FileTreeUploadedFile = {
  originalName: string;
  temporaryPath: string;
  size: number;
  mimeType: string;
};

/**
 * Logger boundary for expected File Tree diagnostics.
 *
 * Production delegates to the server console. Unit tests use no-op or captured
 * loggers and never patch the global console singleton.
 */
export type FileTreeLogger = {
  error(message: string, error?: unknown): void;
};

/**
 * Required production dependencies for the File Tree application service.
 *
 * Filesystem, project lookup, workspace policy, MIME detection, concurrency,
 * and logging are all explicit so service construction has no hidden process,
 * repository, or machine-wide defaults.
 */
export type FileTreeServiceDependencies = {
  fileSystem: FileTreeFileSystem;
  projects: FileTreeProjectGateway;
  workspace: FileTreeWorkspaceGateway;
  resolveMimeType(filePath: string): string;
  fileSystemConcurrency: number;
  logger: FileTreeLogger;
};

/**
 * Complete File Tree application-service surface consumed by HTTP routes.
 *
 * Routes parse transport inputs and call these methods; they never resolve
 * project repositories, validate filesystem ownership, or perform filesystem
 * mutations themselves.
 */
export type FileTreeServices = {
  browseWorkspace(inputPath: string | null): Promise<{
    path: string;
    suggestions: Array<{ path: string; name: string; type: 'directory' }>;
  }>;
  createWorkspaceFolder(folderPath: string): Promise<{ success: true; path: string }>;
  readTextFile(projectId: string, filePath: string): Promise<{ content: string; path: string }>;
  openFile(projectId: string, filePath: string): Promise<{ contentType: string; stream: Readable }>;
  saveTextFile(projectId: string, filePath: string, content: string): Promise<{
    success: true;
    path: string;
    message: string;
  }>;
  /**
   * Lists the project tree, up to 10 levels deep. `node_modules`, `.git`,
   * `.svn` and `.hg` are always left out.
   *
   * By default, and whenever the project root has no readable `.gitignore`,
   * folders with conventional build and cache names (`dist`, `build`,
   * `__pycache__` and so on) are left out too. With `respectGitignore` the root
   * `.gitignore` decides instead and every matching entry is left out, which
   * the `@` mention list and bare file-name links rely on.
   *
   * Adding `markIgnored` lists matching entries with `isIgnored: true` instead,
   * for the file explorer and the command palette. Ignored directories are not
   * walked. Still hidden in this mode: matching folders with a conventional
   * build or cache name, and `.DS_Store` and `Thumbs.db`.
   *
   * A tree with more than 10,000 entries, not counting ignored ones, fails
   * with a 413 (`FILE_TREE_TOO_LARGE`). Ignored entries have a separate cap of
   * 2,000; past it they are dropped rather than failing the request.
   */
  listProjectFiles(
    projectId: string,
    options?: { respectGitignore: boolean; markIgnored?: boolean },
  ): Promise<FileTreeNode[]>;
  createEntry(input: {
    projectId: string;
    parentPath: string;
    type: 'file' | 'directory';
    name: string;
  }): Promise<{ success: true; path: string; name: string; type: 'file' | 'directory'; message: string }>;
  renameEntry(input: { projectId: string; oldPath: string; newName: string }): Promise<{
    success: true;
    oldPath: string;
    newPath: string;
    newName: string;
    message: string;
  }>;
  deleteEntry(input: { projectId: string; targetPath: string }): Promise<{
    success: true;
    path: string;
    type: 'file' | 'directory';
    message: string;
  }>;
  storeUploadedFiles(input: {
    projectId: string;
    targetPath: string;
    relativePaths: string[];
    requestedFileCount: number;
    files: FileTreeUploadedFile[];
  }): Promise<{
    success: true;
    files: Array<{ name: string; path: string; size: number; mimeType: string }>;
    uploadedCount: number;
    requestedFileCount: number;
    targetPath: string;
    message: string;
  }>;
};

// ---------------------------
//----------------- VOICE MODULE CONTRACTS ------------
/**
 * Per-request voice settings parsed from authenticated HTTP headers.
 *
 * The Voice routes create this value from the optional `x-voice-*` headers and
 * pass it to the Voice service. Empty values mean "use the server-configured
 * default"; the backend base URL is intentionally absent because clients must
 * never control the server's outbound destination.
 */
export type VoiceRequestOverrides = {
  apiKey?: string;
  sttModel?: string;
  ttsModel?: string;
  ttsVoice?: string;
  ttsFormat?: string;
};

/**
 * Uploaded audio accepted by the Voice transcription service.
 *
 * Routes translate Multer's transport-specific file object into this minimal
 * shape so the service does not depend on Express or Multer types.
 */
export type VoiceAudioUpload = {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
};

/**
 * Successful speech payload returned by the Voice service.
 *
 * The route copies `contentType` to the client response and pipes `body`
 * without buffering the complete synthesized audio in application memory.
 */
export type VoiceSpeechPayload = {
  contentType: string;
  body: ReadableStream<Uint8Array> | null;
};

/**
 * Explicit service result used by Voice routes instead of transport-aware
 * exceptions.
 *
 * Services return `ok: false` with the exact client status/message for expected
 * backend, validation, and timeout failures. Routes only translate the result
 * into HTTP output, while unexpected programming errors still reject normally.
 */
export type VoiceServiceResult<TValue> =
  | { ok: true; value: TValue }
  | { ok: false; status: number; error: string };

/**
 * Complete application-service surface consumed by the Voice HTTP router.
 *
 * The composition root supplies a concrete implementation with environment
 * configuration and an injected outbound HTTP adapter. Unit tests use the same
 * contract with handwritten fetch fakes and never patch global state.
 */
export type VoiceService = {
  getHealth(): { configured: boolean };
  transcribe(input: {
    audio: VoiceAudioUpload;
    overrides: VoiceRequestOverrides;
  }): Promise<VoiceServiceResult<{ text: string }>>;
  synthesizeSpeech(input: {
    text: string;
    overrides: VoiceRequestOverrides;
  }): Promise<VoiceServiceResult<VoiceSpeechPayload>>;
};

// ---------------------------
//----------------- CLI MODULE CONTRACTS ------------
/**
 * Output boundary used by the CLI and Sandbox services.
 *
 * Production wiring delegates to the real console. Unit tests collect these
 * calls in arrays, which keeps command assertions deterministic and avoids
 * monkey-patching the global console singleton.
 */
export type CliOutput = {
  log(message?: string): void;
  error(message?: string): void;
};

/**
 * Minimal synchronous filesystem surface shared by CLI status reporting and
 * sandbox workspace validation.
 *
 * The production composition root adapts Node's filesystem module. Tests supply
 * path-keyed fakes, so service tests never inspect or modify the real machine.
 */
export type CliFileSystem = {
  pathExists(filePath: string): boolean;
  getFileStats(filePath: string): { size: number; modifiedAt: Date };
};

/**
 * Mutable environment view owned by the CLI application.
 *
 * CLI options update this object before the server starts. Production passes
 * `process.env`; tests pass a plain record to verify option precedence without
 * changing process-wide environment state.
 */
export type CliEnvironment = Record<string, string | undefined>;

/**
 * Package metadata displayed by CLI help, status, version, and update commands.
 *
 * The composition root reads this once from the application package file and
 * injects only the fields the service needs.
 */
export type CliPackageMetadata = {
  version: string;
  homepage?: string;
  bugsUrl?: string;
};

/**
 * Executable CLI application returned by the CLI composition root.
 *
 * The thin executable entrypoint passes `process.argv` arguments to `run` and
 * copies the returned code to `process.exitCode`. Tests invoke the same method
 * directly with isolated dependencies.
 */
export type CliApplication = {
  run(argumentsList: string[]): Promise<number>;
};

/**
 * Sandbox command service consumed by the top-level CLI command dispatcher.
 *
 * Keeping this behind one required dependency lets CLI tests use a tiny fake,
 * while focused Sandbox tests exercise subprocess and filesystem behavior with
 * their own handwritten adapters.
 */
export type SandboxCommandService = {
  execute(argumentsList: string[]): Promise<number>;
};

// ---------------------------
//----------------- AGY (ANTIGRAVITY CLI) STREAM TYPES ------------
/**
 * Token counts agy reports on an `agent_response` step that reached DONE (per
 * step) and on the final `result` event (cumulative over the whole
 * conversation, so never shown as the current turn's usage).
 */
export type AgyUsage = {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
};

/**
 * One `step_update` from `agy --output-format stream-json`. The same
 * `step_index` arrives first as ACTIVE and then as DONE. `step_type` is a
 * closed vocabulary (`user_input`, `system_message`, `agent_response`, `tool`
 * seen so far); consumers must log and ignore any other value. Agent text
 * streams through `text_delta`; tool steps carry `tool_info.parameters` on
 * ACTIVE and `tool_info.output` on DONE. The stream never carries thinking
 * text, only `usage.thinking_tokens`.
 */
export type AgyStepUpdate = {
  conversation_id?: string;
  step_index?: number;
  state?: 'ACTIVE' | 'DONE' | string;
  step_type?: 'user_input' | 'system_message' | 'agent_response' | 'tool' | string;
  text_delta?: string;
  tool_name?: string;
  tool_info?: {
    name?: string;
    parameters?: Record<string, unknown>;
    output?: unknown;
  };
  duration_seconds?: number;
  usage?: AgyUsage;
};

/**
 * One NDJSON line of `agy --output-format stream-json`.
 *
 * - `init` names the conversation (`conversation_id`), which is the provider
 *   session id a new chat binds to; no log scan or DB polling is needed.
 * - `step_update` carries progress; see `AgyStepUpdate`.
 * - `result` ends the run; its `usage` and `duration_seconds` are cumulative
 *   over the conversation. A `status` other than `SUCCESS` is a failure that
 *   may still carry a partial `response`.
 *
 * Produced by the agy runtime's line parser and consumed by the agy sessions
 * provider's `normalizeMessage`, which maps step updates to chat messages.
 */
export type AgyStreamEvent =
  | {
    event: 'init';
    conversation_id?: string;
    init?: { model?: string; cwd?: string; tools?: string[]; permission_mode?: string };
  }
  | { event: 'step_update'; step_update?: AgyStepUpdate }
  | {
    event: 'result';
    result?: {
      conversation_id?: string;
      status?: string;
      response?: string;
      duration_seconds?: number;
      num_turns?: number;
      usage?: AgyUsage;
    };
  };

// ---------------------------
//----------------- AGY (ANTIGRAVITY CLI) STORE TYPES ------------
/**
 * One top-level conversation listed in an agy data root's
 * `conversation_summaries.db`, as the agy store reads it.
 *
 * Child conversations (subagents) and killed ones are filtered out before a
 * summary is built, and so are rows whose id is not a valid conversation id.
 * When the same conversation appears in several roots, only the copy with the
 * newest `lastModifiedMs` is kept and `root` names the root it came from.
 *
 * - `projectPath` is the first `workspace_uris` entry as a decoded file path,
 *   or the home directory when the conversation has no usable workspace.
 * - `title` is agy's title, else its preview, else the first user message of
 *   the transcript, else the root's `history.jsonl` display text; null when
 *   none of them has text (the synchronizer then applies its fallback name).
 * - `preview` is agy's own preview text, kept so a name derived from it can be
 *   replaced once agy titles the conversation.
 * - `lastModifiedMs` comes from `last_modified_time`; for agy's zero value it
 *   falls back to the transcript's mtime, then the conversation database's
 *   mtime, and is null when nothing on disk dates the conversation.
 *
 * Produced by the agy store and consumed by the agy session synchronizer.
 */
export type AgyConversationSummary = {
  conversationId: string;
  root: string;
  title: string | null;
  preview: string | null;
  projectPath: string;
  lastModifiedMs: number | null;
};

/**
 * One step (one JSONL row) of an agy transcript, read from
 * `<root>/brain/<conversation id>/.system_generated/logs/transcript_full.jsonl`
 * or, when that is missing, the shortened `transcript.jsonl`.
 *
 * `type` is the step kind: `USER_INPUT`, `PLANNER_RESPONSE`, `GENERIC` (the
 * result of a tool call) or `SYSTEM_MESSAGE`; readers ignore other kinds.
 * Planner steps carry `thinking`, `content`, `tool_calls` (`{ name, args }`,
 * where `args` and each of its values may be JSON-encoded strings) and their
 * token counts. In `transcript.jsonl`, the fields named in `truncated_fields`
 * were cut short. Every field is agy's and only partly verified, so all of
 * them are `unknown` and must be read defensively.
 */
export type AgyTranscriptStep = {
  step_index?: unknown;
  source?: unknown;
  type?: unknown;
  status?: unknown;
  created_at?: unknown;
  content?: unknown;
  thinking?: unknown;
  tool_calls?: unknown;
  input_tokens?: unknown;
  cache_read_tokens?: unknown;
  output_tokens?: unknown;
  truncated_fields?: unknown;
  [key: string]: unknown;
};

/**
 * One parsed agy transcript and where it was read from.
 *
 * `isComplete` is false when only the shortened `transcript.jsonl` exists, so
 * some step fields may be truncated. `modifiedAt` is the file's mtime (ISO),
 * a stable fallback time for steps without a readable `created_at`.
 * Malformed lines (such as a row agy is still writing) are skipped.
 *
 * Produced by the agy store; consumed by the agy sessions provider (history)
 * and the provider token-usage service.
 */
export type AgyTranscript = {
  conversationId: string;
  root: string;
  filePath: string;
  isComplete: boolean;
  modifiedAt: string;
  steps: AgyTranscriptStep[];
};

/**
 * Context usage of an agy conversation, from the token counts of one model
 * response: `inputTokens` is the whole prompt (new plus cache-read tokens)
 * and `used` adds the response's output. It has the shape OpenCode's history
 * reader and usage endpoint return, without a `total` (agy reports no context
 * window size).
 *
 * Built by `buildAgyTokenUsage`; returned by the agy sessions provider's
 * history and by the provider token-usage service.
 */
export type AgyTokenUsage = {
  used: number;
  inputTokens: number;
  outputTokens: number;
  breakdown: {
    input: number;
    output: number;
  };
};
