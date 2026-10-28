/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import { spawn } from 'child_process';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  appendFilesInputTag,
  buildClaudeUserContent,
  normalizeImageDescriptors
} from '@/shared/image-attachments.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyBackgroundWorkCompleted,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from '@/modules/notifications/index.js';
import { sessionHistoryCache } from '@/modules/providers/services/session-history-cache.service.js';
import {
  getReportedClaudeContextWindow,
  rememberClaudeContextWindow
} from '@/modules/providers/services/provider-token-usage.service.js';
import {
  createCompleteMessage,
  createNormalizedMessage,
  splitLegacyUltracodeEffort
} from '@/shared/utils.js';

// One entry per run that owns a session key, from the moment the run starts
// until its message loop ends. See `runEntry` in queryClaudeSDK for the fields.
const activeSessions = new Map();
// Outstanding background tasks per live session, keyed like activeSessions. An
// entry lives exactly as long as the map entry it shadows: cleared when the
// session is removed, and reset when a newer run takes the key over.
const backgroundWork = createBackgroundWorkTracker();
const pendingToolApprovals = new Map();
// Entries whose CLI process is on its way out, keyed like activeSessions: one a
// newer run took the session from (retireSession), one the user aborted, or one
// closed for outliving its released input (ABANDONED_PROCESS_CLOSE_MS). An
// entry stays until its message loop ends, or, once its query is closed, until
// its `closed` settles: closing ends the loop seconds before the SDK kills the
// process (see closeRun). The session's next run waits for it before starting
// a CLI of its own (waitForExitingProcess), whichever run did the retiring or
// aborting, so two processes never append to one transcript.
const exitingSessions = new Map();
// A new turn on its way into the process a session's previous run holds for
// background work (handTurnToHeldProcess), keyed like activeSessions, while
// it makes its lookups: the entry under the key is still the held run's. An
// abort in that window stops only the new turn (abortClaudeSDKSession).
const pendingHandOvers = new Map();

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

// How long the spawned CLI lets background work run once its stdin has closed,
// passed as CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS. The CLI counts from the end of
// its last turn after stdin closed (a later turn restarts the count); at the
// ceiling it stops every background agent, workflow and shell and exits. With
// `tengu_tidy_sloth` on (the default) background shells also last until the
// ceiling rather than a short grace period. Nothing is counted while stdin is open.
//
// CloudCLI closes stdin only when it no longer needs the process: nothing is
// outstanding, the work has reported back, the hold ran out (HOLD_IDLE_MS,
// HOLD_MAX_MS), a new turn took the session over, or the user aborted. Whatever
// still runs at that point is unwanted, and a process with stdin closed cannot
// receive a stop or an interrupt any more, so there is no reason to keep it long;
// a longer ceiling would only postpone the kill. Fixed: a host value, 0
// included, is ignored.
const CLI_BG_WAIT_GRACE_MS = 5 * 60 * 1000;

const DEFAULT_HOLD_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_HOLD_MAX_MS = 12 * 60 * 60 * 1000;
const MIN_HOLD_IDLE_MS = 60 * 1000;
// setTimeout fires at once when asked to wait longer than this.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * Reads the hold durations from CLOUDCLI_CLAUDE_HOLD_IDLE_MS and
 * CLOUDCLI_CLAUDE_HOLD_MAX_MS. A value that is not a positive integer, an idle
 * value under a minute, or a max below the idle value falls back to the
 * defaults (30 minutes and 12 hours; an inconsistent pair is dropped as a
 * whole). Values longer than a timer can wait are capped.
 * @param {Record<string, string | undefined>} env
 * @returns {{ idleMs: number, maxMs: number }}
 */
function resolveHoldDurations(env) {
  const read = (name) => {
    const raw = env[name]?.trim();
    if (!raw) {
      return null;
    }
    const value = /^\d+$/.test(raw) ? Number(raw) : 0;
    if (value > 0) {
      return Math.min(value, MAX_TIMER_DELAY_MS);
    }
    console.warn(`[Claude SDK] Ignoring ${name}=${raw}: not a positive integer`);
    return null;
  };

  let idleMs = read('CLOUDCLI_CLAUDE_HOLD_IDLE_MS') ?? DEFAULT_HOLD_IDLE_MS;
  const maxMs = read('CLOUDCLI_CLAUDE_HOLD_MAX_MS') ?? DEFAULT_HOLD_MAX_MS;
  if (idleMs < MIN_HOLD_IDLE_MS) {
    console.warn(`[Claude SDK] Ignoring CLOUDCLI_CLAUDE_HOLD_IDLE_MS=${idleMs}: below ${MIN_HOLD_IDLE_MS}`);
    idleMs = DEFAULT_HOLD_IDLE_MS;
  }
  if (maxMs < idleMs) {
    console.warn(`[Claude SDK] Ignoring the hold durations: CLOUDCLI_CLAUDE_HOLD_MAX_MS (${maxMs}) is below the idle value (${idleMs})`);
    return { idleMs: DEFAULT_HOLD_IDLE_MS, maxMs: DEFAULT_HOLD_MAX_MS };
  }
  return { idleMs, maxMs };
}

// How long a turn's process is held (stdin kept open) for background work still
// running after the turn's `result`, so the work can report back in a follow-up
// turn instead of falling to the CLI's wind-down above. A turn with nothing
// outstanding releases at once, and work that reports back releases the hold.
//
// HOLD_IDLE_MS: released after this much silence on the stream, unless the
// session's own tasks (not nested ones) are still outstanding: a backgrounded
// command emits nothing until it ends, so silence proves nothing about it.
// Nor does it about a recurring CronCreate job between its fires, or a
// ScheduleWakeup (/loop) wake-up or a one-shot CronCreate job before it is
// due: a hold for a wake-up lasts until its time plus WAKEUP_GRACE_MS, and so
// does one for a one-shot job due before HOLD_MAX would run out (one due
// later would not fire in this process anyway). A hold kept only for nested
// tasks, or for a Monitor the CLI reported no task for, ends here.
//
// HOLD_MAX_MS: the backstop for tasks that never report. Pushed back by every
// `result` and every main-thread assistant message during the hold; when it
// runs out the outstanding tasks are stopped and stdin is closed.
const { idleMs: HOLD_IDLE_MS, maxMs: HOLD_MAX_MS } = resolveHoldDurations(process.env);
// How long past its time a held process still waits for a ScheduleWakeup
// wake-up, or a one-shot CronCreate job, to fire. The CLI sends nothing for a
// fire that never starts, and the fire itself can come a little early or late.
const WAKEUP_GRACE_MS = 5 * 60 * 1000;
// A process still up this long after its input was released, whatever the
// reason, is closed: the CLI's own ceiling plus a minute. The CLI does not
// always keep to that ceiling: a backgrounded shell's own timeout can push it
// back. Not armed by the release at the end of the message loop, when the
// process is already gone or going.
const ABANDONED_PROCESS_CLOSE_MS = CLI_BG_WAIT_GRACE_MS + 60 * 1000;

// A new run waits this long for the session's exiting process (see
// exitingSessions) to end, then closes it and waits RETIRED_CLOSE_WAIT_MS more
// before starting its own. A closed query's loop ends at once, before its
// process has gone: the SDK sends SIGTERM 2 s after closing and SIGKILL 5 s
// after that. So the second wait lasts until the process has exited, as far
// as the run sees it (`processGone`), or is a plain timer that outlasts that
// schedule (see closeRun).
const RETIRED_EXIT_WAIT_MS = 15 * 1000;
const RETIRED_CLOSE_WAIT_MS = 8 * 1000;
// How long abort waits for the CLI to answer an interrupt before closing it;
// a stop of a handed-over turn waits as long for that turn's `result` too.
const INTERRUPT_REPLY_TIMEOUT_MS = 5 * 1000;
// How long a stop request waits for its reply. The task's `stopped`
// notification is the real outcome either way.
const STOP_TASK_REPLY_TIMEOUT_MS = 5 * 1000;

// Mid-run inserts (see createInsertController). A turn whose `result` comes
// while inserts are still on their way waits this long for the CLI to start
// the next turn with them, counted from the CLI's last message; after that
// they are reported lost and the turn completes.
const INSERT_NEXT_TURN_WAIT_MS = 30 * 1000;
// How long a withdrawal waits for the CLI's answer to cancel_async_message.
const INSERT_CANCEL_REPLY_TIMEOUT_MS = 5 * 1000;
// How long an abort waits for that answer before it interrupts anyway.
const INSERT_ABORT_CANCEL_WAIT_MS = 1000;
// The uuid of a message written to the CLI. An insert's id is one.
const MESSAGE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

/**
 * Resolves one turn's effort level and ultracode switch against the selected model's
 * catalog entry. Ultracode (standing dynamic-workflow orchestration) is independent of
 * effort and combines with any level; Claude Code honours it only on xhigh-capable models,
 * which the catalog marks with `supportsUltracode`. A legacy `ultracode` effort token from
 * an old queued/scheduled message or API caller is first split into xhigh + ultracode on.
 * @param {string} model - Model the turn runs with
 * @param {{ effort?: unknown, ultracode?: unknown }} requested - Client choices for the turn
 * @param {Object} [modelsDefinition] - Merged catalog the choices are validated against
 * @returns {{ effort: string|undefined, ultracode: boolean|undefined }} `effort` is a level
 *   the model declares, or undefined for the CLI default. `ultracode` is undefined when the
 *   client made no choice or the model cannot run it, so nothing is sent for it.
 */
function resolveClaudeEffortSelection(model, requested, modelsDefinition = CLAUDE_PREDEFINED_MODELS) {
  const { effort, ultracode } = splitLegacyUltracodeEffort({
    effort: typeof requested.effort === 'string' ? requested.effort : undefined,
    ultracode: typeof requested.ultracode === 'boolean' ? requested.ultracode : undefined
  });
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return {
    effort: typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
      ? effort
      : undefined,
    ultracode: selectedModel?.supportsUltracode === true && typeof ultracode === 'boolean'
      ? ultracode
      : undefined
  };
}

/**
 * Writes a resolved effort/ultracode selection onto the SDK options. Ultracode is a
 * session-scoped setting rather than an SDK option: turning it on also enables Workflows,
 * which it requires, and turning it off is sent explicitly so an `ultracode: true` in the
 * user's own settings files cannot run a turn the composer shows as off.
 * @param {Object} sdkOptions - SDK options being built
 * @param {{ effort: string|undefined, ultracode: boolean|undefined }} selection - Output of
 *   resolveClaudeEffortSelection
 */
function applyClaudeEffortSelection(sdkOptions, { effort, ultracode }) {
  if (effort) {
    sdkOptions.effort = effort;
  }

  if (ultracode === undefined) {
    return;
  }

  sdkOptions.settings = {
    ...(sdkOptions.settings || {}),
    ultracode,
    ...(ultracode ? { enableWorkflows: true } : {})
  };
}

// Claude Code refuses to load a settings file larger than this (2 MB).
const MAX_SETTINGS_FILE_BYTES = 2 * 1024 * 1024;

/**
 * The `ultracode` value one Claude settings file sets, or undefined when it
 * sets none, cannot be read, is over MAX_SETTINGS_FILE_BYTES or does not
 * parse: Claude Code skips such a file and takes the value from the files
 * below it, and ignores a value that is not a boolean. The file is decoded as
 * Claude Code decodes it (and as claude-settings-permissions.service.ts
 * does): UTF-16LE when it starts with that byte order mark, UTF-8 otherwise,
 * without the leading BOM. Windows editors and PowerShell often write one,
 * and Claude Code still applies such a file.
 * @param {string} file - Absolute path of the settings file
 * @returns {Promise<boolean|undefined>}
 */
async function readSettingsFileUltracode(file) {
  try {
    const bytes = await fs.readFile(file);
    if (bytes.length > MAX_SETTINGS_FILE_BYTES) {
      return undefined;
    }
    const isUtf16LittleEndian = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
    const settings = JSON.parse(bytes.toString(isUtf16LittleEndian ? 'utf16le' : 'utf8').replace(/^\uFEFF/, ''));
    return typeof settings?.ultracode === 'boolean' ? settings.ultracode : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The ultracode setting a CLI started with these SDK options runs with, as
 * Claude Code 2.1.312 reports it (get_settings): the `ultracode` of the
 * `settings` option, which the SDK passes as --settings and which beats every
 * settings file, when it names one. Otherwise the value of the settings files
 * the run loads (`settingSources`), whatever order they are listed in: the
 * user's settings.json (under CLAUDE_CONFIG_DIR, else ~/.claude), then the
 * project's .claude/settings.json, then its .claude/settings.local.json, each
 * over the one before. The project files are read in the working directory
 * itself, not above it, as the CLI reads them. Off when none sets it.
 * @param {Object} sdkOptions - SDK options built by mapCliOptionsToSDK
 * @returns {Promise<boolean>}
 */
async function resolveEffectiveUltracode(sdkOptions) {
  const flag = sdkOptions.settings?.ultracode;
  if (typeof flag === 'boolean') {
    return flag;
  }
  const sources = new Set(sdkOptions.settingSources ?? []);
  const projectDirectory = sdkOptions.cwd || process.cwd();
  const files = [
    sources.has('user') && path.join(sdkOptions.env?.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude'), 'settings.json'),
    sources.has('project') && path.join(projectDirectory, '.claude', 'settings.json'),
    sources.has('local') && path.join(projectDirectory, '.claude', 'settings.local.json'),
  ].filter(Boolean);
  const values = await Promise.all(files.map(readSettingsFileUltracode));
  return values.reduce((effective, value) => value ?? effective, false);
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

/**
 * The `entrypoint` every run CloudCLI starts through the Agent SDK writes on
 * its transcript rows and its process registry record. The SDK's own default,
 * pinned so a CloudCLI started from inside a Claude Code process (whose
 * children inherit that process's entrypoint, which the CLI may then rewrite)
 * still writes it. Used by the Claude history reader to tell CloudCLI's own
 * launches from those of another CLI process on the same session.
 */
export const CLOUDCLI_CLAUDE_ENTRYPOINT = 'sdk-ts';

/**
 * Environment for the spawned CLI. Forwards all host env vars (e.g. ANTHROPIC_BASE_URL);
 * since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
 *
 * Claude Code turns the Artifact tools off for SDK-driven sessions unless
 * CLAUDE_CODE_ARTIFACT is set, so a session continued from this UI would lose them.
 * Default it on; a host value (e.g. CLAUDE_CODE_ARTIFACT=0) still wins.
 *
 * The entrypoint is always CloudCLI's own (`CLOUDCLI_CLAUDE_ENTRYPOINT`): an
 * inherited one would label CloudCLI's runs as some other kind of process.
 *
 * The background-work ceiling is always CloudCLI's own too
 * (`CLI_BG_WAIT_GRACE_MS`): a host value, 0 included, would keep work alive in a
 * process CloudCLI can no longer reach.
 *
 * @param {Record<string, string | undefined>} [hostEnv]
 * @returns {Record<string, string | undefined>}
 */
export function buildClaudeSdkEnv(hostEnv = process.env) {
  return {
    CLAUDE_CODE_ARTIFACT: '1',
    ...hostEnv,
    CLAUDE_CODE_ENTRYPOINT: CLOUDCLI_CLAUDE_ENTRYPOINT,
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(CLI_BG_WAIT_GRACE_MS),
  };
}

/**
 * Adds `perTaskStopAffordance: true` to the SDK's `initialize` control
 * request: the host has a stop control for each background task (the chat's
 * stop-task), so an interrupt only has to stop the turn under way. Without
 * it, Claude Code (2.1.312, checked against a real process) also kills every
 * background agent and workflow, with their own commands, on an interrupt;
 * backgrounded commands and pending wake-ups outlive it either way. The SDK
 * this server uses has no option for it, so the field is added to the
 * request's line on its way to the CLI. Any other line, and one that does not
 * parse, goes out as it came.
 * @param {string} line - One line the SDK writes to the CLI's stdin
 * @returns {string}
 */
function declarePerTaskStopAffordance(line) {
  if (!line.includes('"initialize"')) {
    return line;
  }
  try {
    const message = JSON.parse(line);
    if (message?.type !== 'control_request' || message.request?.subtype !== 'initialize') {
      return line;
    }
    message.request.perTaskStopAffordance = true;
    return `${JSON.stringify(message)}\n`;
  } catch {
    return line;
  }
}

/**
 * Starts the CLI for the SDK (its `spawnClaudeCodeProcess` option) as the
 * SDK's own spawn does, the CLI's stderr going to `onStderr`, except that the
 * first `initialize` request it writes declares the per-task stop control
 * (declarePerTaskStopAffordance). The CLI reads the declaration only from the
 * first initialize, and the SDK sends one per process.
 * @param {{ command: string, args: Array<string>, cwd?: string, env: Record<string, string | undefined>, signal: AbortSignal }} spawnOptions
 * @param {(data: string) => void} onStderr
 * @returns {import('child_process').ChildProcess}
 */
function spawnClaudeCli({ command, args, cwd, env, signal }, onStderr) {
  const child = spawn(command, args, { cwd, env, signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stderr.on('data', (chunk) => onStderr(chunk.toString()));
  const write = child.stdin.write;
  child.stdin.write = function writeDeclaringStopAffordance(chunk, ...rest) {
    if (typeof chunk !== 'string') {
      return write.call(this, chunk, ...rest);
    }
    const declared = declarePerTaskStopAffordance(chunk);
    if (declared !== chunk) {
      child.stdin.write = write;
    }
    return write.call(this, declared, ...rest);
  };
  return child;
}

function mapCliOptionsToSDK(options = {}) {
  const {
    providerSessionId,
    cwd,
    toolsSettings,
    permissionMode,
    effort,
    ultracode,
    resumeAnchorId,
    resumeFromScratch
  } = options;

  const sdkOptions = {};

  sdkOptions.env = buildClaudeSdkEnv();

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  // When nothing resolves the option stays unset on purpose: the SDK then falls back to the
  // binary it ships, which beats handing it a bare `claude` that raw spawn can never launch.
  const claudeExecutablePath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  if (claudeExecutablePath) {
    sdkOptions.pathToClaudeCodeExecutable = claudeExecutablePath;
  }

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_PREDEFINED_MODELS.DEFAULT;

  applyClaudeEffortSelection(sdkOptions, resolveClaudeEffortSelection(
    sdkOptions.model,
    { effort, ultracode },
    options.effortModels || CLAUDE_PREDEFINED_MODELS,
  ));

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  sdkOptions.settingSources = ['project', 'user', 'local'];

  // The CLI echoes every user message it takes from stdin back on stdout
  // (`isReplay`), which is how the run learns that the CLI has read an insert
  // (see createInsertController). The run drops the echoes of what it wrote
  // itself; local command output comes as such an echo with or without the
  // flag and is still shown.
  sdkOptions.extraArgs = { 'replay-user-messages': null };

  // The SDK resumes with the provider-native session id, never the app id.
  // `resumeFromScratch` is set when the very first prompt of a conversation was
  // edited: there is nothing before it to resume through, so the turn has to
  // start the conversation over instead.
  if (providerSessionId && !resumeFromScratch) {
    sdkOptions.resume = providerSessionId;

    // Editing an already-sent message re-runs the conversation truncated just
    // before it. `resumeSessionAt` is inclusive of the uuid it names, so the
    // caller resolves the last row to KEEP and passes that — never the edited
    // turn itself, which would leave the original prompt in context.
    if (resumeAnchorId) {
      sdkOptions.resumeSessionAt = resumeAnchorId;
    }
  }

  return sdkOptions;
}

/**
 * Registers a run's entry under its session key.
 *
 * A run registers as soon as it starts, and anything else found under the key
 * is retired first rather than overwritten: this map entry is the only handle
 * for stopping that run, so overwriting it would strand its generator.
 * @param {string} sessionId - Session key
 * @param {Object} entry - The run's entry (see `runEntry` in queryClaudeSDK)
 */
function addSession(sessionId, entry) {
  const existing = activeSessions.get(sessionId);
  if (existing && existing !== entry) {
    retireSession(sessionId);
  }
  activeSessions.set(sessionId, entry);
  // The history reader reports a background agent as running or stopped by
  // whether this entry exists, and the cached history does not see this map.
  sessionHistoryCache.invalidate(sessionId);
}

/**
 * Sends a stop for one task without waiting for the reply. A stop that cannot
 * be delivered changes nothing: the process is on its way out either way. The
 * synchronous call is guarded too, so a throwing stop cannot skip whatever the
 * caller does next.
 * @param {Object|null} instance - SDK query instance
 * @param {string} taskId - The task's `task_id`
 */
function sendStopTask(instance, taskId) {
  try {
    Promise.resolve(instance?.stopTask?.(taskId)).catch(() => {});
  } catch {
    // Same as a rejected stop.
  }
}

/**
 * Takes a session key from the run registered under it, so a new run can have
 * it. Idempotent: the entry leaves activeSessions on the first call.
 *
 * A retired run with a CLI process is silenced, which makes its loop ignore
 * everything its process still says, and joins exitingSessions until its
 * process is gone (see exitingSessions); the tasks tracked for it are
 * forgotten. While its input is still held, the process is told to interrupt
 * the turn it may be running (a follow-up turn, or a first turn with no
 * `result` yet) and to stop its outstanding tasks, and only then is the input
 * released: the SDK drops control requests written after stdin has ended, and
 * the CLI's wind-down would otherwise keep those tasks, and the process
 * appending to the same transcript, alive for up to CLI_BG_WAIT_GRACE_MS. A
 * turn the process starts after that is closed with it (see the silenced
 * branch of queryClaudeSDK's loop).
 * Nothing is awaited; each request is written before this returns. A process
 * whose input is already released is sent nothing, as the requests would be
 * dropped. Inserts the run still had pending are reported failed first, as
 * its loop says nothing once silenced, and the caller of a turn handed to the
 * process is let go.
 * @param {string} sessionKey - Session key
 * @param {string} [reason] - Why the run lets go, for the release's log line:
 *   `superseded` when a newer run takes the session, `shell-takeover` when
 *   the Shell tab takes it for a CLI (releaseClaudeSDKSession)
 */
function retireSession(sessionKey, reason = 'superseded') {
  const entry = activeSessions.get(sessionKey);
  if (!entry) {
    return;
  }
  // Read before removeSession forgets them.
  const outstanding = backgroundWork.outstanding(sessionKey);
  removeSession(sessionKey);
  entry.inserts.failAll('SUPERSEDED');
  entry.settleTurn();

  const { instance } = entry;
  if (!instance) {
    // Still starting: it checks its entry before spawning a CLI and stands down.
    return;
  }
  entry.silenced = true;
  exitingSessions.set(sessionKey, entry);
  if (!entry.inputReleased) {
    const logInterruptError = (error) => {
      console.error(`Error interrupting superseded run for session ${sessionKey}:`, error?.message || error);
    };
    try {
      Promise.resolve(instance.interrupt()).catch(logInterruptError);
    } catch (error) {
      logInterruptError(error);
    }
    for (const task of outstanding) {
      sendStopTask(instance, task.taskId);
    }
  }
  entry.releaseInput(reason);
}

/**
 * Closes a query and its CLI process (the SDK ends stdin, sends SIGTERM 2 s
 * later and SIGKILL 5 s after that). Logs instead of throwing, as it runs from
 * timers and from paths that still have cleanup to do.
 * @param {Object|null} instance - SDK query instance
 * @param {string|null} sessionKey - Session key, for the log
 */
function closeQuery(instance, sessionKey) {
  try {
    instance?.close?.();
  } catch (error) {
    console.error(`[Claude SDK] Session ${sessionKey || 'NEW'}: closing the query failed:`, error?.message || error);
  }
}

/**
 * Closes a run's query and its CLI process, once, and records on the entry
 * when the process can be taken to be gone. Closing ends the run's loop at
 * once, so its `exited` settles while the SDK has yet to kill the process.
 * @param {Object} entry - The run's entry (see `runEntry` in queryClaudeSDK)
 * @param {string|null} sessionKey - Session key, for the log
 * @returns {Promise<void>} The entry's `closed`: settles once the process has
 *   exited (`processGone`, for a process the run started itself), and at the
 *   latest RETIRED_CLOSE_WAIT_MS after the first close
 */
function closeRun(entry, sessionKey) {
  if (!entry.closed) {
    closeQuery(entry.instance, sessionKey);
    const waitedOut = new Promise((resolve) => {
      setTimeout(resolve, RETIRED_CLOSE_WAIT_MS).unref?.();
    });
    entry.closed = entry.processGone ? Promise.race([entry.processGone, waitedOut]) : waitedOut;
  }
  return entry.closed;
}

/**
 * Races a promise against a timer that never keeps the server alive.
 * @param {Promise<unknown>|unknown} promise - What to wait for; a rejection passes through
 * @param {number} timeoutMs - How long to wait
 * @returns {Promise<boolean>} True when the promise resolved first, false when time ran out
 */
function resolvesWithin(promise, timeoutMs) {
  let timer = null;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(promise).then(() => true), timedOut])
    .finally(() => clearTimeout(timer));
}

/**
 * Waits for the session's exiting process, if any (see exitingSessions), to
 * end before a new run starts its CLI, so two CLI processes never append to
 * one transcript and the new one does not find the old one's just-stopped
 * tasks and report them as orphans. A process still up after
 * RETIRED_EXIT_WAIT_MS is closed. Once its query is closed, by this wait or
 * anyone else, the loop's end proves nothing, so the new run waits out the
 * entry's `closed` (see closeRun). A closed entry stays in exitingSessions
 * until then, so a run that arrives after its loop has ended waits too.
 * @param {string} sessionKey - Session key
 * @returns {Promise<void>}
 */
async function waitForExitingProcess(sessionKey) {
  const exiting = exitingSessions.get(sessionKey);
  if (!exiting) {
    return;
  }
  if (!await resolvesWithin(exiting.exited, RETIRED_EXIT_WAIT_MS)) {
    console.warn(`[Claude SDK] Session ${sessionKey}: the previous process is still running after ${RETIRED_EXIT_WAIT_MS} ms; closing it, and starting the new run in ${RETIRED_CLOSE_WAIT_MS} ms`);
    closeRun(exiting, sessionKey);
  }
  await exiting.closed;
}

/**
 * Writes the CLI's stderr to the server log, one entry per line, tagged with
 * the session. The SDK discards it unless a callback is set; it carries the
 * CLI's own notices, such as the one printed when it stops background tasks at
 * its wait ceiling.
 * @param {string|null} sessionKey - Session key, or null before one is known
 * @param {string} data - A chunk of stderr output
 */
function logCliStderr(sessionKey, data) {
  for (const line of String(data).split('\n')) {
    if (line.trim()) {
      console.error(`[Claude CLI ${sessionKey || 'NEW'}] ${line.trimEnd()}`);
    }
  }
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
  // No process, no background work: anything still tracked was killed with it.
  backgroundWork.clear(sessionId);
  // See addSession: a page cached while the process was up still says
  // `running` for any agent that never reported back.
  sessionHistoryCache.invalidate(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

/**
 * True for the user bubble the SDK echoes for a subagent's own prompt.
 *
 * Subagent traffic carries `parent_tool_use_id`, so this echo lands in the main
 * thread and stacks a second copy of the prompt right below the Agent tool card
 * that already displays it. It also disappears on reload, because the transcript
 * keeps that turn in the subagent's sidechain rather than the session file.
 * @param {Object} message - Normalized message about to be sent to the client
 * @returns {boolean}
 */
export function isSubagentPromptEcho(message) {
  return Boolean(message?.parentToolUseId) && message.role === 'user' && message.kind === 'text';
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @typedef {Object} TokenBudget
 * @property {number} used
 * @property {number} total
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} [cacheReadTokens]
 * @property {number} [cacheCreationTokens]
 * @property {number} [cacheTokens]
 * @property {{ input: number, output: number }} breakdown
 */

/**
 * The window a budget is measured against: the one the SDK reported for the
 * session's model when known, else the server-wide CONTEXT_WINDOW setting.
 * @param {number|null|undefined} reportedContextWindow - SDK-reported window
 * @returns {number} Context window in tokens
 */
function resolveContextWindow(reportedContextWindow) {
  if (Number.isFinite(reportedContextWindow) && reportedContextWindow > 0) {
    return reportedContextWindow;
  }
  return parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;
}

/**
 * Reads the context window the SDK measured for the model that served a turn.
 *
 * `result.modelUsage` has one entry per model the turn billed, subagents'
 * included, so the entry has to be the main thread's model. Its key is the id
 * the CLI requested, which for a 1M variant carries a `[1m]` suffix that the
 * assistant rows' `message.model` lacks (`claude-sonnet-5-5[1m]` vs
 * `claude-sonnet-5-5`); newer CLIs also state the bare id as `canonicalModel`.
 * @param {Object} sdkMessage - SDK stream message
 * @param {string|null} mainModel - `message.model` of the turn's main-thread assistant rows
 * @returns {number|null} The reported window, or null when there is none
 */
function readReportedContextWindow(sdkMessage, mainModel) {
  const modelUsage = sdkMessage?.type === 'result' ? sdkMessage.modelUsage : null;
  if (!modelUsage || typeof modelUsage !== 'object') {
    return null;
  }

  const reported = Object.entries(modelUsage).filter(
    ([, modelData]) => modelData && typeof modelData === 'object' && readNumber(modelData.contextWindow) > 0
  );
  const exactMatch = reported.find(([modelKey]) => modelKey === mainModel);
  const variantMatch = reported.find(([modelKey, modelData]) => (
    Boolean(mainModel)
    && (modelData.canonicalModel === mainModel || modelKey.replace(/\[[^\]]*\]$/, '') === mainModel)
  ));
  // A turn that billed a single model was served by it, whatever it is called.
  const entry = exactMatch ?? variantMatch ?? (reported.length === 1 ? reported[0] : null);
  return entry ? readNumber(entry[1].contextWindow) : null;
}

/**
 * Builds a context-window budget from an Anthropic-shaped usage payload.
 *
 * `input_tokens + cache_read + cache_creation` is one request's whole prompt,
 * which is exactly what the context window holds at that moment.
 * @param {Object} messageUsage - Anthropic usage payload
 * @param {number|null} [reportedContextWindow] - SDK-reported window for the session's model
 * @returns {TokenBudget} Token budget object
 */
function buildTokenBudget(messageUsage, reportedContextWindow) {
  const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
  const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
  const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
  const cacheTokens = cacheCreationTokens + cacheReadTokens;
  const inputTokens = directInputTokens + cacheTokens;
  const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
  const contextWindow = resolveContextWindow(reportedContextWindow);

  return {
    used: inputTokens + outputTokens,
    total: contextWindow,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Extracts the session's context-window usage from an SDK stream message.
 *
 * Only assistant messages describe the context window: each one reports the
 * prompt its own request carried. The turn-ending `result` is deliberately not
 * a source here — see `extractCumulativeTokenBudget`.
 * @param {Object} sdkMessage - SDK stream message
 * @param {number|null} [reportedContextWindow] - SDK-reported window for the session's model
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage, reportedContextWindow) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  // Subagent traffic (parent_tool_use_id set) reports the subagent's own
  // context window, not this session's — surfacing it makes the counter drop
  // to the subagent's number and bounce back on the next main-thread event.
  if (sdkMessage.parent_tool_use_id) {
    return null;
  }

  // Only assistant messages carry Anthropic-shaped usage. System
  // task_progress/task_notification events have a top-level `usage` too, but
  // shaped {total_tokens, tool_uses, duration_ms} — reading Anthropic keys
  // off it yields an all-zero budget that flashes "0" in the composer.
  if (sdkMessage.type !== 'assistant') {
    return null;
  }

  const messageUsage = sdkMessage.message?.usage;
  if (!messageUsage || typeof messageUsage !== 'object') {
    return null;
  }

  return buildTokenBudget(messageUsage, reportedContextWindow);
}

/**
 * Last-resort budget read from a turn's `result` message.
 *
 * `result.usage` and `result.modelUsage` are the turn's *bill*: every request
 * the turn made, summed, including each subagent's. A turn that made four
 * requests therefore reports roughly four times the context the conversation
 * actually holds, so publishing it made the counter leap at the end of a turn
 * and fall back on the next assistant message — worst with subagents running,
 * whose requests inflate the sum without ever entering this session's context.
 *
 * It is still the only usage an SDK build that reports none per assistant
 * message ever emits, so it stays available for the caller to use when a turn
 * produced no assistant budget at all.
 * @param {Object} sdkMessage - SDK stream message
 * @param {number|null} [reportedContextWindow] - SDK-reported window for the session's model
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractCumulativeTokenBudget(sdkMessage, reportedContextWindow) {
  if (!sdkMessage || typeof sdkMessage !== 'object' || sdkMessage.type !== 'result') {
    return null;
  }

  if (sdkMessage.usage && typeof sdkMessage.usage === 'object') {
    return buildTokenBudget(sdkMessage.usage, reportedContextWindow);
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;
  const contextWindow = resolveContextWindow(reportedContextWindow);

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

// Tool calls that leave work running past the end of a turn. Bash and Agent only
// count when they are backgrounded; the rest defer or watch work by nature.
// Workflow belongs here rather than in a branch of its own: its input schema has
// no foreground option at all, so every call returns a task id immediately and
// reports back in a later turn. TaskCreate stays out despite its name: it only
// adds an item to the to-do list (CLI 2.1.312) and starts nothing, so holding
// for it kept an idle process up as if it had background work, and a send
// that needs a new process was refused over work that never existed.
const DEFERRED_WORK_TOOLS = new Set(['Monitor', 'ScheduleWakeup', 'CronCreate', 'Workflow']);

// The deferred-work tools whose work no task event ever reports: the wake-up
// a ScheduleWakeup (/loop) sets, and a CronCreate job. The run follows that
// work by the calls and what their results say (see `heldWakeup` and
// `heldCronJobs` in queryClaudeSDK), and holds its process for it whatever
// the tracker says. A Monitor is not one of them: Claude Code (2.1.165 and
// later) reports it as a task, which the tracker follows; one it reports no
// task for is held until the CLI runs a turn for it (`untrackedMonitorHeld`).
const SCHEDULING_TOOLS = new Set(['ScheduleWakeup', 'CronCreate']);

/**
 * Whether a tool call is a ScheduleWakeup that ends a loop: `stop: true`
 * cancels the pending wake-ups instead of setting one, so nothing is left.
 * @param {Object} block - A `tool_use` content block
 * @returns {boolean}
 */
function endsLoop(block) {
  return block.name === 'ScheduleWakeup' && block.input?.stop === true;
}

/**
 * Whether one content block is a tool call that keeps working after the
 * turn's `result` arrives (see startsBackgroundWork).
 * @param {Object} block - A content block
 * @returns {boolean}
 */
function launchesBackgroundWork(block) {
  if (block?.type !== 'tool_use') {
    return false;
  }
  if (block.name === 'Bash') {
    return block.input?.run_in_background === true;
  }
  // A backgrounded subagent outlives the turn exactly like a backgrounded
  // Bash does, so the process has to be held open for it to report back.
  // Agents background by default — `run_in_background` is optional and only
  // an explicit `false` opts out — hence `!== false` rather than `=== true`.
  // A foreground agent must stay out of DEFERRED_WORK_TOOLS: it never pushes
  // a follow-up turn, so it would pin the process for the full ceiling.
  if (block.name === 'Agent') {
    return block.input?.run_in_background !== false;
  }
  return DEFERRED_WORK_TOOLS.has(block.name) && !endsLoop(block);
}

/**
 * Detects tool calls that keep working after the turn's `result` arrives.
 *
 * Only turns that start background work need their CLI process held open; every
 * other turn can let it exit immediately, as it did before the hold existed.
 *
 * Used by the providers module's tests, which pin the tool matching directly:
 * the alternative is driving a whole SDK run to observe whether stdin was held,
 * and the cost of getting this wrong is silently killed background work.
 *
 * @param {Object} sdkMessage - SDK stream message
 * @returns {boolean} True when the message launches work that outlives the turn
 */
export function startsBackgroundWork(sdkMessage) {
  const content = sdkMessage?.message?.content;
  return Array.isArray(content) && content.some(launchesBackgroundWork);
}

/**
 * Detects tool calls that start a background task: what startsBackgroundWork
 * finds, but for the calls whose work no task event ever reports
 * (SCHEDULING_TOOLS), which the run follows by their results instead. A turn
 * that reports no task at all is held for what this finds (see
 * `backgroundWorkPending` in queryClaudeSDK).
 * @param {Object} sdkMessage - SDK stream message
 * @returns {boolean}
 */
function startsBackgroundTasks(sdkMessage) {
  const content = sdkMessage?.message?.content;
  return Array.isArray(content)
    && content.some((block) => launchesBackgroundWork(block) && !SCHEDULING_TOOLS.has(block.name));
}

// The shortest and the longest wait a ScheduleWakeup sets: the CLI clamps
// `delaySeconds` to them.
const WAKEUP_MIN_DELAY_S = 60;
const WAKEUP_MAX_DELAY_S = 3600;

/**
 * When the wake-up a ScheduleWakeup call set fires, in epoch ms: the
 * `scheduledFor` its result carries (`tool_use_result`), else worked out from
 * its `delaySeconds` as the CLI does (clamped, then rounded up to the
 * minute). `exact` when the result said: the fire names the time it was set
 * for (`scheduled_for`), which then has to match it.
 * @param {Object|null} output - The call's `tool_use_result`
 * @param {Object} input - The call's input
 * @param {number} calledAt - When the call came, in epoch ms
 * @returns {{ at: number, exact: boolean }}
 */
function readWakeupTime(output, input, calledAt) {
  if (Number.isFinite(output?.scheduledFor) && output.scheduledFor > 0) {
    return { at: output.scheduledFor, exact: true };
  }
  const requested = Math.round(Number(input?.delaySeconds));
  const delaySeconds = Number.isNaN(requested)
    ? WAKEUP_MIN_DELAY_S
    : Math.min(WAKEUP_MAX_DELAY_S, Math.max(WAKEUP_MIN_DELAY_S, requested));
  return { at: Math.ceil((calledAt + delaySeconds * 1000) / 60000) * 60000, exact: false };
}

/**
 * The text of a `tool_result` block, whether its content is a string or a
 * list of parts.
 * @param {unknown} content - The block's `content`
 * @returns {string}
 */
function readToolResultText(content) {
  if (typeof content === 'string') {
    return content;
  }
  return Array.isArray(content)
    ? content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n')
    : '';
}

/**
 * The id of the job a CronCreate call scheduled: its result's `id`, else as
 * its text names it ("Scheduled recurring job <id> (…)", "Scheduled one-shot
 * task <id> (…)"); null when neither says.
 * @param {Object|null} output - The call's `tool_use_result`
 * @param {string} text - The call's result text
 * @returns {string|null}
 */
function readCronJobId(output, text) {
  if (typeof output?.id === 'string' && output.id !== '') {
    return output.id;
  }
  const match = /Scheduled (?:recurring job|one-shot task) ([^\s().,]+)/.exec(text);
  return match ? match[1] : null;
}

// `task_updated` patch statuses after which a task is gone for good. `pending`,
// `running` and `paused` are still outstanding; `killed` is what the CLI
// writes when it stops a task itself (the task notification spells it
// `stopped`).
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed']);

/**
 * Tracks the background tasks each live session still has outstanding, folded
 * from the `system` task events the SDK stream already carries.
 *
 * `startsBackgroundWork` above only knows that a turn *launched* something
 * lasting; this knows what is still running and which task ids it answers to,
 * which is what the running-sessions list and a stop request need once the
 * turn's `result` has gone out and nothing else remembers the session is busy.
 *
 * Verified against a real query (SDK 0.3.165): `task_started` carries
 * `task_id`, `tool_use_id`, `task_type` and `description` for every agent,
 * workflow and backgrounded command (a foreground Bash emits nothing);
 * `task_notification` settles a task with any status; `task_updated` carries
 * only `task_id` and a patch, and is terminal when the patch's `status` is.
 * Housekeeping tasks the CLI starts on its own have no `tool_use_id` and are
 * not tracked — nothing in the transcript could show them.
 *
 * Exported so the folding can be driven with the four event shapes directly;
 * the runtime keeps one instance keyed like `activeSessions`.
 *
 * `hasOwnOutstanding` ignores `nested` tasks: it answers whether work the
 * session itself started is still running, which is what keeps a held process
 * open through silence.
 *
 * @returns {{
 *   apply: (sessionKey: string, message: Object) => void,
 *   hasOutstanding: (sessionKey: string) => boolean,
 *   hasOwnOutstanding: (sessionKey: string) => boolean,
 *   has: (sessionKey: string, taskId: string) => boolean,
 *   outstanding: (sessionKey: string) => Array<import('@/shared/types.js').BackgroundTaskSummary>,
 *   clear: (sessionKey: string) => void,
 *   list: () => Array<{ sessionId: string, tasks: Array<import('@/shared/types.js').BackgroundTaskSummary> }>
 * }}
 */
export function createBackgroundWorkTracker() {
  /** @type {Map<string, Map<string, import('@/shared/types.js').BackgroundTaskSummary>>} */
  const sessions = new Map();
  /**
   * Tool-use ids the session's own turns issued. A task started for a call an
   * agent made inside its own transcript — a workflow agent's backgrounded
   * command, say — reaches this stream too, and nothing in the parent
   * transcript could show it; it is kept for stopping but flagged `nested`.
   * @type {Map<string, Set<string>>}
   */
  const ownToolUseIds = new Map();

  const remove = (sessionKey, taskId) => {
    const tasks = sessions.get(sessionKey);
    if (!tasks) {
      return;
    }
    tasks.delete(taskId);
    if (tasks.size === 0) {
      sessions.delete(sessionKey);
    }
  };

  return {
    apply(sessionKey, message) {
      if (message?.type === 'assistant' && !message.parent_tool_use_id) {
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_use' && typeof block.id === 'string') {
              let ids = ownToolUseIds.get(sessionKey);
              if (!ids) {
                ids = new Set();
                ownToolUseIds.set(sessionKey, ids);
              }
              ids.add(block.id);
            }
          }
        }
        return;
      }
      if (message?.type !== 'system' || typeof message.task_id !== 'string') {
        return;
      }
      switch (message.subtype) {
        case 'task_started': {
          if (typeof message.tool_use_id !== 'string') {
            return;
          }
          const task = {
            taskId: message.task_id,
            toolUseId: message.tool_use_id,
            taskType: message.task_type,
            description: message.description,
            startedAt: Date.now()
          };
          if (typeof message.workflow_name === 'string') {
            task.workflowName = message.workflow_name;
          }
          if (!ownToolUseIds.get(sessionKey)?.has(message.tool_use_id)) {
            task.nested = true;
          }
          let tasks = sessions.get(sessionKey);
          if (!tasks) {
            tasks = new Map();
            sessions.set(sessionKey, tasks);
          }
          tasks.set(task.taskId, task);
          return;
        }
        case 'task_notification':
          remove(sessionKey, message.task_id);
          return;
        case 'task_updated':
          if (TERMINAL_TASK_STATUSES.has(message.patch?.status)) {
            remove(sessionKey, message.task_id);
          }
          return;
        default:
      }
    },

    hasOutstanding(sessionKey) {
      return sessions.has(sessionKey);
    },

    hasOwnOutstanding(sessionKey) {
      for (const task of sessions.get(sessionKey)?.values() ?? []) {
        if (!task.nested) {
          return true;
        }
      }
      return false;
    },

    has(sessionKey, taskId) {
      return Boolean(sessions.get(sessionKey)?.has(taskId));
    },

    outstanding(sessionKey) {
      return Array.from(sessions.get(sessionKey)?.values() ?? []);
    },

    clear(sessionKey) {
      sessions.delete(sessionKey);
      ownToolUseIds.delete(sessionKey);
    },

    list() {
      return Array.from(sessions, ([sessionId, tasks]) => ({
        sessionId,
        tasks: Array.from(tasks.values())
      }));
    }
  };
}

/**
 * Builds the SDK user messages for one turn.
 *
 * Always returns SDKUserMessage records rather than a bare string: a string
 * prompt makes the SDK flag the query as single-turn and close stdin the moment
 * the turn's `result` arrives, which kills the CLI's background tasks. Plain
 * text turns carry string content; turns with image attachments carry the
 * prompt text plus one base64 `image` block per attachment (read from the
 * global `~/.cloudcli/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {Array} files - Non-image attachment descriptors
 * @param {string} cwd - Project working directory attachment paths resolve against
 * @param {string} uuid - The uuid the CLI records the prompt under, and echoes
 *   it back with (see createInsertController)
 * @returns {Promise<Array<Object>>} SDKUserMessage records for the turn
 */
async function buildPromptMessages(command, images, files, cwd, uuid) {
  const promptWithFiles = appendFilesInputTag(command, files);
  const content = normalizeImageDescriptors(images).length === 0
    ? promptWithFiles
    : await buildClaudeUserContent(promptWithFiles, images, cwd);

  return [{
    type: 'user',
    uuid,
    message: {
      role: 'user',
      content
    },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString()
  }];
}

/**
 * Wraps prompt messages in an async iterable that yields them, then waits for
 * more until it is released.
 *
 * The SDK closes the CLI's stdin as soon as its input iterable is exhausted (and
 * immediately on `result` for string prompts). The CLI reads that EOF as the end
 * of the run and kills anything still going in the background, so the iterable
 * has to stay pending until we actually want the process gone. While it does,
 * `push` writes another message to the CLI (a mid-run insert). Releasing drops
 * whatever was pushed and not yet taken, so nothing reaches the CLI after it.
 *
 * @param {Array<Object>} messages - SDKUserMessage records to send first
 * @returns {{ stream: AsyncIterable, push: (message: Object) => boolean, release: () => void }}
 *   The stream, a writer that returns false once the stream is released, and its closer
 */
function createHeldPromptStream(messages) {
  const queued = [...messages];
  let released = false;
  let wake = null;

  const stream = (async function* () {
    for (;;) {
      if (released) {
        return;
      }
      if (queued.length > 0) {
        yield queued.shift();
        continue;
      }
      // Keeps stdin open: the CLI stays alive until release() is called.
      await new Promise((resolve) => { wake = resolve; });
      wake = null;
    }
  })();

  return {
    stream,
    push(message) {
      if (released) {
        return false;
      }
      queued.push(message);
      wake?.();
      return true;
    },
    release() {
      released = true;
      queued.length = 0;
      wake?.();
    },
  };
}

/**
 * Whether an insert request names an insert the CLI can take: a UUID id, as
 * the CLI records the message under it, and some text.
 * @param {unknown} input - What the caller passed as `{ insertId, content }`
 * @returns {boolean}
 */
function isValidInsertInput(input) {
  return typeof input?.insertId === 'string'
    && MESSAGE_UUID_PATTERN.test(input.insertId)
    && typeof input.content === 'string'
    && input.content.trim().length > 0;
}

/**
 * True for the CLI's echo of a task notification it fed itself: background
 * work reporting back, which the client shows on the task's card instead.
 * @param {Object} message - An `isReplay` user message
 * @returns {boolean}
 */
function isTaskNotificationEcho(message) {
  if (message.origin?.kind === 'task-notification') {
    return true;
  }
  const content = message.message?.content;
  const text = Array.isArray(content)
    ? content.find((part) => part?.type === 'text')?.text
    : content;
  return typeof text === 'string' && text.trimStart().startsWith('<task-notification>');
}

/**
 * The task an echoed task notification is about, as its text names it
 * (`<task-id>…</task-id>`); null for any other message.
 * @param {Object} message - SDK stream message
 * @returns {string|null}
 */
function readNotifiedTaskId(message) {
  if (message.isReplay !== true || !isTaskNotificationEcho(message)) {
    return null;
  }
  const content = message.message?.content;
  const text = Array.isArray(content)
    ? content.find((part) => part?.type === 'text')?.text
    : content;
  const match = typeof text === 'string' ? /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(text) : null;
  return match ? match[1] : null;
}

/**
 * The uuids of the prompts a turn consumed, as the CLI names them on the
 * turn's `result`: `user_message_uuids` (every prompt it took, the turn's own
 * and any folded in), and `user_message_uuid` (the one that started it, the
 * last of a merged batch). A turn the CLI starts on its own, such as a
 * wake-up or a task notification's, names none; an older CLI never does.
 * @param {Object} result - A `result` message
 * @returns {Array<string>|null} Null when the result names nothing
 */
function readConsumedPromptUuids(result) {
  const list = Array.isArray(result.user_message_uuids) ? result.user_message_uuids : null;
  const single = typeof result.user_message_uuid === 'string' ? result.user_message_uuid : null;
  if (!list && !single) {
    return null;
  }
  return [...(list ?? []), ...(single ? [single] : [])].filter((uuid) => typeof uuid === 'string');
}

/**
 * Keeps one run's mid-run inserts: user messages written to the CLI while
 * the turn runs. The CLI reads one after its current tool batch, or, when
 * the turn ends first, runs it as the next turn of the same process.
 *
 * - One insert is written at a time, the rest wait in order. The CLI runs
 *   adjacent queued prompts as one turn under the last one's uuid, so two
 *   written together would read back from the transcript as one message. For
 *   the same reason nothing is written before the run's own prompt has
 *   started.
 * - A written insert is read at its first receipt: the CLI's echo of it
 *   (`--replay-user-messages`) or its `command_lifecycle` `started`. Read
 *   during the turn it is `delivered`, and the transcript keeps it as a
 *   `queued_command` attachment; read once the turn has ended, it is
 *   `next_turn`, the next turn's prompt row. Either way the client gets the
 *   message the normalizer makes of that row, so it carries the id history
 *   will give it. `cancelled`, `refused` or `discarded` from the CLI ends it
 *   unread. One that starts the next turn while the user is stopping the run
 *   is the abort's instead (see receive).
 * - A turn whose `result` comes while inserts are pending is not over:
 *   deferTurnEnd holds the result until the next turn takes them. When they
 *   end unread instead (withdrawn, refused, or lost after
 *   INSERT_NEXT_TURN_WAIT_MS of silence), the held result is finished after
 *   all (finishDeferredTurn). The run thus completes once, however many
 *   turns its inserts run as.
 * - It echoes back what the run wrote itself, which the client already
 *   shows: the first prompt, every insert, and the task notifications the
 *   CLI feeds itself. `observe` reports those so the run drops them.
 * - A later send can hand the process a turn of its own while it is held for
 *   background work (see handTurnToHeldProcess). beginHandedOverTurn makes
 *   that turn's prompt the one inserts wait for; its echo is dropped too.
 *   The CLI queues the prompt until it is idle, and an interrupt does not
 *   clear that queue, so an abort takes back a prompt that has not started.
 *   Until it starts, the CLI may run turns of its own (relaying background
 *   work, a wake-up or a scheduled task firing); isAheadOfHandedOverPrompt
 *   tells their results from the prompt's.
 *
 * Each insert's statuses go through the run's writer as `insert_status`
 * (see `InsertStatus`): `pending`, then one of `delivered`, `next_turn`,
 * `cancelled` or `failed`. A `cancelled` or `failed` one says why in
 * `insertReason`: ABORTED (the user stopped the run), LOST (no receipt by
 * the time the next turn should have started), CLI_REFUSED, CLI_DISCARDED or
 * CLI_CANCELLED (the CLI ended it unread), RUN_ENDED, RUN_FAILED, or
 * SUPERSEDED (a newer run took the session over). A withdrawal the user
 * asked for carries none.
 *
 * @param {Object} deps
 * @param {string} deps.firstPromptUuid - The uuid the run's own prompt went out with
 * @param {(message: Object) => boolean} deps.push - Writes a message to the CLI
 *   (the held prompt stream); false once it no longer can
 * @param {() => boolean} deps.inputOpen - Whether control requests still reach the CLI
 * @param {() => boolean} deps.stopping - Whether the run is being aborted or
 *   superseded: nothing more is written then
 * @param {() => boolean} deps.acceptsInserts - Whether the run's turn takes a new insert
 * @param {() => Object|null} deps.getInstance - The SDK query, for cancel_async_message
 * @param {(message: Object) => void} deps.send - The run's writer
 * @param {(raw: Object) => Array<Object>} deps.normalize - The provider's normalizer
 * @param {() => string|null} deps.getSessionId - The session id the run's messages carry
 * @param {(result: Object) => void} deps.finishDeferredTurn - Finishes a `result`
 *   deferTurnEnd held back, as if it had just arrived
 * @param {() => string} deps.logPrefix - Names the session in log lines
 */
function createInsertController({
  firstPromptUuid,
  push,
  inputOpen,
  stopping,
  acceptsInserts,
  getInstance,
  send,
  normalize,
  getSessionId,
  finishDeferredTurn,
  logPrefix,
}) {
  // Every insert the run accepted, by insertId, whatever became of it.
  const inserts = new Map();
  // Accepted inserts not written yet, oldest first.
  const waiting = [];
  // The insert written to the CLI and not yet read or ended.
  let written = null;
  // The uuid of every prompt written to the process: the run's own and those
  // of the turns handed to it later. The CLI acts on a uuid once.
  const promptUuids = new Set([firstPromptUuid]);
  // The prompt of the turn under way, whose echo or `started` begins it, and
  // whose echo is dropped (the CLI echoes a prompt as it takes it).
  let currentPromptUuid = firstPromptUuid;
  // Set once the CLI has started the current prompt (or ended its turn).
  let promptTurnStarted = false;
  // Set while the current prompt is one a later send handed to the process.
  let promptHandedOver = false;
  // Whether that prompt has been written to the CLI: a hand-over that waits
  // for the CLI's own turn to end writes it then (see handOverTurn).
  let promptWritten = true;
  // Set once the CLI has been seen reporting a prompt the run wrote as it
  // takes it (an echo, or a `started`): such a CLI reports a handed-over
  // prompt before that prompt's turn can end (isAheadOfHandedOverPrompt).
  let announcesPrompts = false;
  // Set once the turn the written insert waits for has ended (its `result`
  // came, held back or not), until an insert starts the next turn: a receipt
  // meanwhile is that insert starting it (see receive).
  let turnEnded = false;
  // The turn's `result` while deferTurnEnd holds it back, and the timer that
  // gives up on the next turn.
  let deferredResult = null;
  let nextTurnTimer = null;

  const isPending = (entry) => entry.state === 'waiting' || entry.state === 'written';
  const hasPending = () => written !== null || waiting.length > 0;
  const pendingEntries = () => (written ? [written, ...waiting] : [...waiting]);

  const sendStatus = (entry, insertStatus, insertReason) => {
    send(createNormalizedMessage({
      kind: 'insert_status',
      sessionId: getSessionId(),
      provider: 'claude',
      insertId: entry.insertId,
      insertStatus,
      content: entry.content,
      ...(insertReason ? { insertReason } : {}),
    }));
  };

  // Ends an insert: `delivered`, `next_turn`, `cancelled` or `failed`.
  const settle = (entry, state, insertReason) => {
    entry.state = state;
    if (written === entry) {
      written = null;
    }
    const index = waiting.indexOf(entry);
    if (index !== -1) {
      waiting.splice(index, 1);
    }
    sendStatus(entry, state, insertReason);
  };

  const armNextTurnTimer = () => {
    if (nextTurnTimer) {
      clearTimeout(nextTurnTimer);
    }
    nextTurnTimer = setTimeout(onNextTurnTimeout, INSERT_NEXT_TURN_WAIT_MS);
    nextTurnTimer.unref?.();
  };

  // Ends a deferral, handing back the result it held.
  const endDeferral = () => {
    if (nextTurnTimer) {
      clearTimeout(nextTurnTimer);
      nextTurnTimer = null;
    }
    const result = deferredResult;
    deferredResult = null;
    return result;
  };

  const sendCancel = async (insertId, timeoutMs) => {
    const instance = getInstance();
    let reply;
    try {
      if (typeof instance?.cancelAsyncMessage === 'function') {
        reply = instance.cancelAsyncMessage(insertId);
      } else if (typeof instance?.request === 'function') {
        // The same control request, for an SDK without the method.
        reply = Promise.resolve(instance.request({ subtype: 'cancel_async_message', message_uuid: insertId }))
          .then((answer) => answer?.response?.cancelled);
      } else {
        return false;
      }
    } catch {
      return false;
    }
    let cancelled = false;
    const answered = await resolvesWithin(
      Promise.resolve(reply).then((value) => { cancelled = value === true; }, () => {}),
      timeoutMs,
    );
    return answered && cancelled;
  };

  const flush = () => {
    if (written || waiting.length === 0 || !promptTurnStarted || !inputOpen() || stopping()) {
      return;
    }
    const entry = waiting[0];
    const wrote = push({
      type: 'user',
      uuid: entry.insertId,
      // Read after the current tool batch; 'now' would interrupt the turn
      // and 'later' would wait for its end.
      priority: 'next',
      // Some of the CLI's checks for a person's message do not count one
      // that names no origin.
      origin: { kind: 'human' },
      message: { role: 'user', content: entry.content },
      parent_tool_use_id: null,
      timestamp: new Date().toISOString(),
    });
    if (!wrote) {
      settle(entry, 'failed', 'RUN_ENDED');
      return;
    }
    waiting.shift();
    entry.state = 'written';
    written = entry;
    if (deferredResult) {
      // A fresh wait for the insert the next turn should start with.
      armNextTurnTimer();
    }
  };

  // An insert ended unread. A turn held back for it is over after all,
  // unless another insert takes its place.
  const afterUnreadEnd = () => {
    if (deferredResult && !hasPending()) {
      finishDeferredTurn(endDeferral());
      return;
    }
    flush();
  };

  const receive = (entry) => {
    announcesPrompts = true;
    if (turnEnded && stopping()) {
      // It started the next turn just as the user stopped the run, and the
      // abort interrupts that turn. The CLI reports a prompt consumed into
      // an aborted turn as cancelled, and its row may never reach the
      // transcript, so it is the abort's like every insert still pending:
      // the text goes back to the composer, and no message is shown for it.
      settle(entry, 'cancelled', 'ABORTED');
      return;
    }
    const nextTurn = turnEnded;
    settle(entry, nextTurn ? 'next_turn' : 'delivered');
    const timestamp = new Date().toISOString();
    const row = nextTurn
      ? { type: 'user', uuid: entry.insertId, timestamp, message: { role: 'user', content: entry.content } }
      : {
        type: 'attachment',
        timestamp,
        attachment: {
          type: 'queued_command',
          prompt: entry.content,
          source_uuid: entry.insertId,
          commandMode: 'prompt',
          origin: { kind: 'human' },
        },
      };
    for (const message of normalize(row)) {
      send(message);
    }
    if (nextTurn) {
      // Its turn has started; that turn's own `result` ends it.
      turnEnded = false;
      endDeferral();
    }
    flush();
  };

  // Asks the CLI to take back the written insert. The CLI's own `cancelled`
  // lifecycle may settle it first; a receipt means it came too late.
  const withdrawWritten = async (entry) => {
    const cancelled = inputOpen() && await sendCancel(entry.insertId, INSERT_CANCEL_REPLY_TIMEOUT_MS);
    if (cancelled && entry.state === 'written') {
      settle(entry, 'cancelled');
      afterUnreadEnd();
    }
    if (entry.state === 'cancelled') {
      return { status: 'cancelled' };
    }
    return { status: entry.state === 'failed' ? 'not_found' : 'cancel_failed' };
  };

  // The CLI reported taking the current prompt (its echo or `started`).
  const startPromptTurn = () => {
    announcesPrompts = true;
    if (!promptTurnStarted) {
      promptTurnStarted = true;
      flush();
    }
  };

  const onLifecycle = (message) => {
    const uuid = message.command_uuid;
    if (uuid === currentPromptUuid) {
      if (message.state === 'started') {
        startPromptTurn();
      }
      return;
    }
    const entry = typeof uuid === 'string' ? inserts.get(uuid) : undefined;
    if (!entry || entry !== written) {
      return;
    }
    if (message.state === 'started') {
      receive(entry);
    } else if (message.state === 'cancelled' || message.state === 'refused' || message.state === 'discarded') {
      if (message.state === 'cancelled' && entry.cancelRequested) {
        settle(entry, 'cancelled', entry.cancelReason);
      } else {
        console.warn(`${logPrefix()}: the CLI ended insert ${entry.insertId} unread (${message.state})`);
        settle(entry, 'failed', `CLI_${message.state.toUpperCase()}`);
      }
      afterUnreadEnd();
    }
  };

  const onNextTurnTimeout = () => {
    nextTurnTimer = null;
    if (!deferredResult) {
      return;
    }
    const lost = pendingEntries();
    console.warn(`${logPrefix()}: no turn started for ${lost.length} insert(s) within ${INSERT_NEXT_TURN_WAIT_MS} ms of the CLI's last message; reporting them lost`);
    if (written && inputOpen()) {
      // In case the CLI still holds it; it is reported lost either way.
      void sendCancel(written.insertId, INSERT_CANCEL_REPLY_TIMEOUT_MS);
    }
    for (const entry of lost) {
      settle(entry, 'failed', 'LOST');
    }
    finishDeferredTurn(endDeferral());
  };

  return {
    hasPending,

    /**
     * Takes a new insert: reported `pending`, then written to the CLI as
     * soon as it is its turn.
     * @param {{ insertId: string, content: string }} input - Already
     *   validated (isValidInsertInput)
     * @returns {{ accepted: true } | { accepted: false, reason: 'NO_ACTIVE_RUN' | 'DUPLICATE' }}
     */
    accept(input) {
      if (!acceptsInserts()) {
        return { accepted: false, reason: 'NO_ACTIVE_RUN' };
      }
      // The CLI acts on a message uuid once.
      if (promptUuids.has(input.insertId) || inserts.has(input.insertId)) {
        return { accepted: false, reason: 'DUPLICATE' };
      }
      const entry = {
        insertId: input.insertId,
        content: input.content,
        state: 'waiting',
        // Set once a withdrawal was asked for, with the reason it reports.
        cancelRequested: false,
        cancelReason: undefined,
        // The CLI's answer to a withdrawal still out.
        cancelling: null,
      };
      inserts.set(entry.insertId, entry);
      waiting.push(entry);
      sendStatus(entry, 'pending');
      flush();
      return { accepted: true };
    },

    /**
     * Withdraws an insert the model has not read. One still waiting is simply
     * dropped; a written one only the CLI can take back. `cancel_failed` means
     * the CLI kept it, or is already delivering it; it still reports how it
     * ends. `not_found` is an insert this run does not hold, or one that has
     * already ended.
     * @param {string} insertId
     * @returns {Promise<{ status: 'cancelled' | 'cancel_failed' | 'not_found' }>}
     */
    cancel(insertId) {
      const entry = inserts.get(insertId);
      if (!entry || !isPending(entry)) {
        return Promise.resolve({ status: 'not_found' });
      }
      if (entry.state === 'waiting') {
        settle(entry, 'cancelled');
        afterUnreadEnd();
        return Promise.resolve({ status: 'cancelled' });
      }
      // A second request while the first is out shares its answer.
      if (!entry.cancelling) {
        entry.cancelRequested = true;
        entry.cancelling = withdrawWritten(entry).finally(() => { entry.cancelling = null; });
      }
      return entry.cancelling;
    },

    /**
     * Looks at one message from the CLI before the run handles it: notes the
     * receipts above, and restarts the wait for the next turn while there is
     * one.
     * @param {Object} message - SDK stream message
     * @returns {boolean} True for an echo of what the run wrote itself, which
     *   the run drops
     */
    observe(message) {
      if (deferredResult) {
        armNextTurnTimer();
      }
      if (message?.type === 'command_lifecycle') {
        onLifecycle(message);
        return false;
      }
      if (message?.type !== 'user' || message.isReplay !== true) {
        return false;
      }
      const uuid = typeof message.uuid === 'string' ? message.uuid : null;
      if (uuid && uuid === currentPromptUuid) {
        startPromptTurn();
        return true;
      }
      const entry = uuid ? inserts.get(uuid) : undefined;
      if (entry) {
        if (entry === written) {
          receive(entry);
        }
        return true;
      }
      return isTaskNotificationEcho(message);
    },

    /**
     * Called with each `result` of the run's turn. With inserts pending, the
     * CLI runs them as the next turn, so the result is held back (see above).
     * @param {Object} result - The `result` message
     * @returns {boolean} True when the result is held back
     */
    deferTurnEnd(result) {
      promptTurnStarted = true;
      turnEnded = true;
      if (!hasPending()) {
        return false;
      }
      console.log(`${logPrefix()}: the turn ended with ${pendingEntries().length} insert(s) unread; they run as the next turn`);
      deferredResult = result;
      armNextTurnTimer();
      flush();
      return true;
    },

    /**
     * Called instead of deferTurnEnd with a `result` of the run's turn that
     * comes while an abort is under way: nothing is held back then, but an
     * insert read from now on started the next turn (see receive).
     */
    noteTurnEnded() {
      turnEnded = true;
    },

    /**
     * Makes a prompt a later send handed to the process the current one (see
     * handTurnToHeldProcess): inserts wait for its turn to start, and its
     * echo is dropped. Called just before the prompt is written, with no
     * insert pending: the turn before it has completed. A prompt that waits
     * for the CLI's own turn to end is written later (`written` false), and
     * noteHandedOverPromptWritten says when.
     * @param {string} promptUuid - The uuid the handed-over prompt goes out with
     * @param {{ written?: boolean }} [state]
     */
    beginHandedOverTurn(promptUuid, { written = true } = {}) {
      promptUuids.add(promptUuid);
      currentPromptUuid = promptUuid;
      promptTurnStarted = false;
      promptHandedOver = true;
      promptWritten = written;
      turnEnded = false;
    },

    /** The handed-over prompt that waited for the CLI's own turn is written now. */
    noteHandedOverPromptWritten() {
      promptWritten = true;
    },

    /**
     * Whether a `result` that comes before the handed-over prompt's turn has
     * started is that of a turn the CLI ran ahead of it, rather than the
     * prompt's own: one relaying background work, or one the CLI starts on
     * its own (a ScheduleWakeup or /loop wake-up, a CronCreate task). Such a
     * turn neither ends the handed-over turn nor lets inserts out. False
     * outside that wait.
     *
     * Decided by what the result says first: a turn that names the prompts
     * it consumed (readConsumedPromptUuids) is the prompt's when they include
     * it. A turn that names none is one of the CLI's own: ahead of the prompt
     * when this CLI has been seen reporting the prompts it takes, as it would
     * have reported this one first. A CLI that does neither leaves only the
     * `origin`: a task notification's turn is ahead, any other is taken for
     * the prompt's, so that the turn cannot hang. Every result before the
     * prompt is written is ahead of it.
     * @param {Object} result - The `result` message
     * @returns {boolean}
     */
    isAheadOfHandedOverPrompt(result) {
      if (!promptHandedOver || promptTurnStarted) {
        return false;
      }
      if (!promptWritten) {
        return true;
      }
      const consumed = readConsumedPromptUuids(result);
      if (consumed) {
        return !consumed.includes(currentPromptUuid);
      }
      if (announcesPrompts) {
        return true;
      }
      return result.origin?.kind === 'task-notification';
    },

    /**
     * Whether a `result` names, among the prompts its turn consumed
     * (readConsumedPromptUuids), one the run wrote: its own prompt, a
     * handed-over one or an insert. A turn the CLI starts on its own names
     * none.
     * @param {Object} result - A `result` message
     * @returns {boolean}
     */
    namesWrittenPrompt(result) {
      return (readConsumedPromptUuids(result) ?? []).some((uuid) => promptUuids.has(uuid) || inserts.has(uuid));
    },

    /**
     * Whether an abort has something to take back first: an insert not read
     * yet, or a handed-over prompt still in the CLI's queue.
     * @returns {boolean}
     */
    needsWithdrawalOnAbort: () => hasPending() || (promptHandedOver && !promptTurnStarted),

    /**
     * Withdraws everything pending before an abort interrupts the turn: the
     * CLI keeps queued messages across an interrupt and runs them once it is
     * handled. That includes a handed-over prompt whose turn has not started.
     * Every insert the turn has not read is reported cancelled, even one
     * whose withdrawal the CLI did not confirm, or one that starts the next
     * turn meanwhile (see receive), so the client puts the text back rather
     * than lose it. Any held result is dropped: the abort ends the turn.
     * @returns {Promise<{ promptWithdrawn: boolean }>} `promptWithdrawn` when
     *   a handed-over prompt whose turn had not started will run no turn: the
     *   CLI confirmed taking it back, or it was never written
     */
    async cancelAllForAbort() {
      endDeferral();
      for (const entry of [...waiting]) {
        settle(entry, 'cancelled', 'ABORTED');
      }
      let promptWithdrawal = Promise.resolve(false);
      if (promptHandedOver && !promptTurnStarted) {
        if (!promptWritten) {
          promptWithdrawal = Promise.resolve(true);
        } else if (inputOpen()) {
          promptWithdrawal = sendCancel(currentPromptUuid, INSERT_ABORT_CANCEL_WAIT_MS);
        }
      }
      const withdrawals = [promptWithdrawal];
      const target = written;
      if (target) {
        target.cancelRequested = true;
        target.cancelReason = 'ABORTED';
        if (inputOpen()) {
          withdrawals.push(sendCancel(target.insertId, INSERT_ABORT_CANCEL_WAIT_MS));
        }
      }
      const [promptWithdrawn] = await Promise.all(withdrawals);
      // A receipt may have come in meanwhile.
      if (target?.state === 'written') {
        settle(target, 'cancelled', 'ABORTED');
      }
      if (promptWithdrawn && !promptTurnStarted) {
        // Nothing waits for its turn any more.
        promptHandedOver = false;
        return { promptWithdrawn: true };
      }
      return { promptWithdrawn: false };
    },

    /**
     * Reports everything pending failed, for a run that can no longer
     * deliver it. Any held result is dropped: the caller ends the turn.
     * @param {string} reason - The `insertReason`
     */
    failAll(reason) {
      endDeferral();
      for (const entry of pendingEntries()) {
        settle(entry, 'failed', reason);
      }
    },

    /** Stops the wait for a next turn, once the run's loop has ended. */
    dispose() {
      endDeferral();
    },
  };
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

// How the log, and the English text of the run's notice (see
// reportBackgroundWorkStopped), name a change that keeps a turn out of a live
// process (planTurnHandOver). The client names them the same way.
const HAND_OVER_CHANGE_LABELS = {
  cwd: 'the working directory',
  effort: 'the reasoning effort',
  ultracode: 'Ultracode',
  tools: 'the tool permissions',
  model: 'the model',
  permissionMode: 'the permission mode',
};

/**
 * Whether two lists hold the same entries, in any order.
 * @param {Array<string>} first
 * @param {Array<string>} second
 * @returns {boolean}
 */
function haveSameEntries(first, second) {
  const firstSet = new Set(first);
  const secondSet = new Set(second);
  return firstSet.size === secondSet.size && [...firstSet].every((entry) => secondSet.has(entry));
}

/**
 * Follows the switches of one setting of a live process, its model or its
 * permission mode. The CLI applies switches in the order they come, ahead of
 * any prompt written after them, so the next prompt runs with the target of
 * the last switch sent that the CLI has not refused, else with the value it
 * confirmed last. `current` says which before the CLI has answered: a turn
 * planned or handed over meanwhile, such as a due message sent right behind
 * one whose switch back is on its way, weighs what its prompt will run with.
 * @param {string} initial - The value the process was launched with
 * @returns {{
 *   current: () => string,
 *   confirmed: () => string,
 *   send: (value: string) => { confirm: () => void, refuse: () => void }
 * }}
 */
function createSwitchTracker(initial) {
  let confirmed = initial;
  // Switches sent and not answered yet, oldest first.
  const unanswered = [];
  return {
    current: () => (unanswered.length > 0 ? unanswered[unanswered.length - 1].value : confirmed),
    confirmed: () => confirmed,
    send(value) {
      const entry = { value };
      unanswered.push(entry);
      return {
        // Every switch sent before it is behind it now, whatever its answer.
        confirm() {
          const index = unanswered.indexOf(entry);
          if (index !== -1) {
            confirmed = value;
            unanswered.splice(0, index + 1);
          }
        },
        refuse() {
          const index = unanswered.indexOf(entry);
          if (index !== -1) {
            unanswered.splice(index, 1);
          }
        },
      };
    },
  };
}

/**
 * What it takes to run a new turn in a live process rather than a new one:
 * the switches to send first, and what only a new process can apply.
 *
 * The CLI takes its working directory, tool rules, effort and settings
 * (ultracode) at launch. The SDK switches the model (setModel) and the
 * permission mode (setPermissionMode) of a live process with a control
 * request, except into bypassPermissions for a process not launched in it,
 * which the CLI refuses. A turn may allow tools the process was not launched
 * with, as the run's canUseTool grants them (entering plan mode adds some);
 * one that allows fewer, or denies others, needs a new process.
 *
 * Ultracode is compared as each process runs with it (resolveEffectiveUltracode):
 * the turn's own choice, or, for a turn that makes none (a model that cannot
 * run it, such as the catalog's default, gets none; see
 * resolveClaudeEffortSelection), the value of the Claude settings files,
 * which a new process would run with. The live process keeps the value it
 * was launched with, whatever model it switches to.
 *
 * @param {Object} launched - The live process's configuration (see `launched` in queryClaudeSDK)
 * @param {Object} next - SDK options a new process would get for the turn (mapCliOptionsToSDK)
 * @param {Object|null} instance - The live SDK query
 * @param {boolean} nextUltracode - The ultracode setting a new process would
 *   run the turn with (resolveEffectiveUltracode of `next`)
 * @returns {{ changes: Array<Exclude<import('@/shared/types.js').HandOverChange, 'lookup'>>, switches: Array<import('@/shared/types.js').HandOverSwitch>, model: string|null, permissionMode: string|null }}
 *   `changes` is empty when the turn can go in; `model` and `permissionMode`
 *   are the switches to make before its prompt, if any, and `switches` names
 *   the ones the process can make, whatever else `changes` holds
 */
function planTurnHandOver(launched, next, instance, nextUltracode) {
  const changes = [];
  const switches = [];
  if ((next.cwd ?? null) !== launched.cwd) {
    changes.push('cwd');
  }
  if ((next.effort ?? null) !== launched.effort) {
    changes.push('effort');
  }
  if (nextUltracode !== launched.ultracode) {
    changes.push('ultracode');
  }
  const nextAllowedTools = new Set(next.allowedTools ?? []);
  if (
    launched.allowedTools.some((entry) => !nextAllowedTools.has(entry))
    || !haveSameEntries(next.disallowedTools ?? [], launched.disallowedTools)
  ) {
    changes.push('tools');
  }
  const model = next.model !== launched.model ? next.model : null;
  if (model) {
    (typeof instance?.setModel === 'function' ? switches : changes).push('model');
  }
  const nextPermissionMode = next.permissionMode ?? 'default';
  const permissionMode = nextPermissionMode !== launched.permissionMode ? nextPermissionMode : null;
  if (permissionMode) {
    const canSwitch = typeof instance?.setPermissionMode === 'function'
      && (permissionMode !== 'bypassPermissions' || launched.canBypass);
    (canSwitch ? switches : changes).push('permissionMode');
  }
  return { changes, switches, model, permissionMode };
}

/**
 * Whether a run option names a setting: a string with something in it. A
 * blank one names none, as the chat gateway reads a blank model or effort.
 * @param {unknown} value
 * @returns {boolean}
 */
function namesSetting(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * A turn's run options with every setting they leave out taken from the live
 * process (see `ProviderHandOverPlanOptions.inheritUnset`), so that setting
 * is neither a change nor a switch (planTurnHandOver): `cwd`, `model`,
 * `effort` and `permissionMode` when not named (namesSetting), and each of
 * `toolsSettings`' `allowedTools`, `disallowedTools` and `skipPermissions`
 * the options do not carry. What the options carry is kept, so a
 * `permissionMode` they name still meets the live `skipPermissions`, as
 * mapCliOptionsToSDK combines the two. `ultracode` is the live one when the
 * options make no choice (no boolean, nor the legacy `ultracode` effort); a
 * model that cannot run it still gets none.
 *
 * Used by a run's planHandOver, and through the run's entry by
 * handTurnToHeldProcess, for a plan or a run that inherits unset settings.
 * @param {Object} turnOptions - The turn's run options
 * @param {{ cwd: string|null, model: string, effort: string|null, ultracode: boolean, permissionMode: string, allowedTools: Array<string>, disallowedTools: Array<string>, skipPermissions: boolean }} live
 *   The live process's own settings (see `liveSettings` in queryClaudeSDK)
 * @returns {Object}
 */
function inheritUnsetSettings(turnOptions, live) {
  const given = turnOptions.toolsSettings && typeof turnOptions.toolsSettings === 'object'
    ? turnOptions.toolsSettings
    : {};
  const choosesUltracode = typeof turnOptions.ultracode === 'boolean' || turnOptions.effort === 'ultracode';
  return {
    ...turnOptions,
    cwd: namesSetting(turnOptions.cwd) ? turnOptions.cwd : live.cwd ?? undefined,
    model: namesSetting(turnOptions.model) ? turnOptions.model : live.model,
    effort: namesSetting(turnOptions.effort) ? turnOptions.effort : live.effort ?? undefined,
    ultracode: choosesUltracode ? turnOptions.ultracode : live.ultracode,
    permissionMode: namesSetting(turnOptions.permissionMode) ? turnOptions.permissionMode : live.permissionMode,
    toolsSettings: {
      ...given,
      allowedTools: Array.isArray(given.allowedTools) ? given.allowedTools : [...live.allowedTools],
      disallowedTools: Array.isArray(given.disallowedTools) ? given.disallowedTools : [...live.disallowedTools],
      skipPermissions: typeof given.skipPermissions === 'boolean' ? given.skipPermissions : live.skipPermissions,
    },
  };
}

/**
 * The model catalog a turn's effort is checked against: the provider's own,
 * or the built-in one when it cannot be read.
 * @param {Object} context - Provider-scoped lookups
 * @returns {Promise<Object>}
 */
async function loadEffortModels(context) {
  try {
    return await context.getProviderModels();
  } catch (error) {
    console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    return CLAUDE_PREDEFINED_MODELS;
  }
}

/**
 * Tells a turn's run that the process its session held for background work
 * is being replaced by one of the turn's own, which stops that work, and why:
 * what only a new process can apply (planTurnHandOver), or `lookup` alone when
 * the turn's options could not be resolved. An `error` the client translates
 * by its `code`, BACKGROUND_WORK_STOPPED, and its `changes` (HandOverChange
 * labels); `content` says the same in English for a client that cannot.
 * @param {Object} writer - The writer of the turn's run
 * @param {string} key - Session key, for the log
 * @param {string} sessionId - The session id the message carries
 * @param {Array<import('@/shared/types.js').HandOverChange>} changes
 */
function reportBackgroundWorkStopped(writer, key, sessionId, changes) {
  const labels = changes.filter((change) => change !== 'lookup').map((change) => HAND_OVER_CHANGE_LABELS[change]);
  const named = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}` : labels.join('');
  const why = changes.includes('lookup')
    ? 'the message could not be handed to the process the work ran in'
    : `this message changes ${named}, which only a new Claude process can apply`;
  console.log(`[Claude SDK] Session ${key}: ${why}; replacing the process held for background work`);
  writer.send(createNormalizedMessage({
    kind: 'error',
    code: 'BACKGROUND_WORK_STOPPED',
    changes: [...changes],
    content: `Background work stopped: ${why}.`,
    sessionId,
    provider: 'claude',
  }));
}

/**
 * Hands a new turn to the process the session's previous run holds open for
 * background work, as that process's next turn, instead of starting a CLI of
 * its own: the work keeps running. Called by queryClaudeSDK first.
 *
 * Makes the lookups a new run makes (model, catalog, prompt), then checks
 * again that the process still takes a turn, as it may have let go
 * meanwhile. Returns null when the turn has to start a process of its own,
 * which then retires the held one as before: for an edited message, when the
 * turn's options need a new process (planTurnHandOver), and when a lookup
 * fails. In the last two cases it says so in the turn's stream
 * (reportBackgroundWorkStopped), so the user knows why the work stopped. A
 * client asks first (planClaudeSDKHandOver), and the chat gateway refuses a
 * send that asked to keep the work when it would not go in; the client also
 * asks before sending an edit over background work.
 *
 * Options that set `inheritUnset: true` (a message the scheduled-messages
 * dispatcher planned that way) take every setting they leave out from the
 * live process first (inheritUnsetSettings), the model included: the one the
 * session last recorded is the composer's latest pick, not what the process
 * runs. Only for the hand-over: a turn that starts a process of its own runs
 * with its options as they are.
 *
 * Options that set `restoreSwitchesAfterTurn: true` (a message the
 * scheduled-messages dispatcher sends) keep the model and permission mode the
 * turn switches to for that turn alone: the process is switched back once
 * the turn is over (see handOverTurn in queryClaudeSDK), so work that runs on
 * after it, such as a /loop's next wake-up, keeps its own. Their
 * `onSwitchesRestored({ model, permissionMode })`, if any, hears what the
 * process runs with once the turn is over, however it ended, unless the
 * process lets go then (see restoreTurnSwitches); a turn that starts a
 * process of its own never calls it.
 *
 * @param {string} command - The turn's prompt
 * @param {Object} options - The turn's run options; `sessionId` names the session
 * @param {Object} writer - The writer of the turn's run
 * @param {Object} context - Provider-scoped lookups
 * @returns {Promise<{ settled: Promise<void> }|null>} `settled` settles once
 *   the handed-over turn is over (see `settleHandedOverTurn` in
 *   queryClaudeSDK); null when the turn starts a process of its own. Wrapped,
 *   as an async function would wait out a promise it returned.
 */
/**
 * Tells a turn sent with `restoreSwitchesAfterTurn` that it switched nothing,
 * when it is stopped while its hand-over is still under way (see
 * pendingHandOvers): it never reached the held process, which runs on with
 * what it had. Its `onSwitchesRestored` hears null for both, on a later
 * microtask, as restoreTurnSwitches reports a plan that switches nothing.
 * @param {Object} options - The turn's run options
 * @param {string} key - The session's id
 */
function reportNothingSwitched(options, key) {
  if (options.restoreSwitchesAfterTurn !== true || typeof options.onSwitchesRestored !== 'function') {
    return;
  }
  void Promise.resolve().then(() => {
    try {
      options.onSwitchesRestored({ model: null, permissionMode: null });
    } catch (error) {
      console.warn(`[Claude SDK] Session ${key}: onSwitchesRestored failed:`, error?.message || error);
    }
  });
}

async function handTurnToHeldProcess(command, options, writer, context) {
  const key = options.sessionId;
  // An edited message resumes the conversation partway, which only a new
  // process can; the client asks before sending one over background work.
  if (options.resumeAnchorId || options.resumeFromScratch || !getSession(key)?.takesHandedOverTurn?.()) {
    return null;
  }
  const inheritsModel = options.inheritUnset === true && !namesSetting(options.model);
  const turnOptions = options.inheritUnset === true
    ? getSession(key).inheritUnsetSettings(options)
    : options;

  // Until the turn is handed over, an abort is for it alone (see
  // pendingHandOvers): it must neither reach the held process nor let the
  // turn start a process of its own afterwards.
  const pending = {
    aborted: false,
    abort: () => {
      pending.aborted = true;
      notifyRunStopped({
        userId: writer?.userId || null,
        provider: 'claude',
        sessionId: key,
        sessionName: options.sessionSummary,
        stopReason: 'aborted',
        runStartedAt: writer?.runStartedAt ?? null
      });
    },
  };
  pendingHandOvers.set(key, pending);
  let outcome;
  let providerSessionId;
  try {
    providerSessionId = context.resolveProviderSessionId(key);
    const resolvedModel = inheritsModel
      ? turnOptions.model
      : await context.resolveResumeModel(key, options.model);
    const sdkOptions = mapCliOptionsToSDK({
      ...turnOptions,
      providerSessionId,
      model: resolvedModel || turnOptions.model,
      effortModels: await loadEffortModels(context),
    });
    const ultracode = await resolveEffectiveUltracode(sdkOptions);
    const [promptMessage] = await buildPromptMessages(command, options.images, options.files, turnOptions.cwd, crypto.randomUUID());

    if (pending.aborted) {
      // The abort reported the stop, and its caller sends the `complete`.
      reportNothingSwitched(options, key);
      return { settled: Promise.resolve() };
    }
    // The process may have let go, or ended, meanwhile: handOverTurn checks.
    outcome = getSession(key)?.handOverTurn({
      writer,
      sessionName: options.sessionSummary,
      sdkOptions,
      ultracode,
      skipPermissions: Boolean(turnOptions.toolsSettings?.skipPermissions),
      restoreSwitches: options.restoreSwitchesAfterTurn === true,
      onSwitchesRestored: options.restoreSwitchesAfterTurn === true ? options.onSwitchesRestored : null,
      promptMessage,
    }) ?? { taken: false, changes: [] };
  } catch (error) {
    if (pending.aborted) {
      reportNothingSwitched(options, key);
      return { settled: Promise.resolve() };
    }
    // A new run makes the same lookups, and reports what fails; it retires
    // the held process first, unless that has let go meanwhile.
    console.warn(`[Claude SDK] Session ${key}: could not hand the new turn to the process held for background work:`, error?.message || error);
    if (getSession(key)?.takesHandedOverTurn?.()) {
      reportBackgroundWorkStopped(writer, key, providerSessionId || key, ['lookup']);
    }
    return null;
  } finally {
    if (pendingHandOvers.get(key) === pending) {
      pendingHandOvers.delete(key);
    }
  }
  if (outcome.taken) {
    return { settled: outcome.settled };
  }
  if (outcome.changes.length > 0) {
    reportBackgroundWorkStopped(writer, key, providerSessionId || key, outcome.changes);
  }
  return null;
}

/**
 * What a turn of the session run with these options would make of the
 * process the session's previous run holds open for background work, worked
 * out without sending it anything or switching anything (see
 * `IProviderRuntime.planHandOver` and `ProviderHandOverPlan`): `heldWork`
 * when that process is held, its turn over, for work of the session's own;
 * `canHandOver` when the turn would go into it (handTurnToHeldProcess);
 * `changes` for what keeps it out otherwise (planTurnHandOver), or `lookup`
 * when the lookups a run makes first failed; `switches` for the model and
 * permission mode it would switch there. An edited message never goes in,
 * and names no change. A session with no such process, or whose process is
 * starting or has let go, has nothing held. One whose process is in a turn
 * takes no other: `heldWork` then says whether that process has work of the
 * session's own (holdsOwnWorkInTurn), which stopping a first turn would stop
 * with it.
 *
 * The lookups are the held run's, with its provider-scoped context, except
 * that a model the turn names comes first: the chat gateway records it for
 * the session before the turn's run looks the model up. With
 * `planOptions.inheritUnset`, or `inheritUnset: true` in the options (the
 * run then hands the turn over that way too), a setting the options leave
 * out is the live process's own (inheritUnsetSettings).
 * @param {string} sessionId - Session key (the app session id for a chat run)
 * @param {Object} options - The run options the turn's run would get
 *   (`buildTurnRunOptions`): `cwd` already defaulted to the session's
 *   project, `effort` and `ultracode` already split
 * @param {import('@/shared/types.js').ProviderHandOverPlanOptions} [planOptions]
 * @returns {Promise<import('@/shared/types.js').ProviderHandOverPlan>}
 */
async function planClaudeSDKHandOver(sessionId, options, planOptions) {
  const entry = typeof sessionId === 'string' ? getSession(sessionId) : undefined;
  if (!entry) {
    return { heldWork: false, canHandOver: false, changes: [], switches: [] };
  }
  return entry.planHandOver(
    options && typeof options === 'object' ? options : {},
    planOptions && typeof planOptions === 'object' ? planOptions : {},
  );
}

/**
 * Executes a Claude query using the SDK.
 *
 * A session whose previous run still holds its process open for background
 * work takes the turn in that process instead (handTurnToHeldProcess), so the
 * work keeps running; otherwise the run starts a CLI of its own, retiring
 * whatever held the session.
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - The writer of the turn's run
 * @param {Object} context - Provider-scoped model, session, and auth lookups
 * @returns {Promise<void>} Settles when the run's CLI process has exited; for
 *   a turn handed to a held process, once that turn is over (its `complete`
 *   is out, the user aborted it, or the process ended)
 */
async function queryClaudeSDK(command, options = {}, ws, context) {
  const { sessionId, sessionSummary } = options;
  if (sessionId) {
    const handedOver = await handTurnToHeldProcess(command, options, ws, context);
    if (handedOver) {
      await handedOver.settled;
      return;
    }
  }
  // Callers pass the stable app session id; the SDK only understands the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  // Provider-native id as the SDK reports it (starts as the resume id, or is
  // captured from the stream for brand-new sessions).
  let capturedSessionId = providerSessionId;
  let sessionCreatedSent = false;
  // Process-map key: the app session id when the caller supplied one, else
  // the provider-native id once captured (legacy/direct API callers).
  const sessionKey = () => sessionId || capturedSessionId || null;

  // The writer the turn under way reports through, and the session name its
  // notifications carry. A turn a later send hands to this process brings its
  // own (handOverTurn): the run registry gave that send a run of its own.
  let writer = ws;
  let turnSessionName = sessionSummary;
  // Resolves the promise a handed-over turn's caller waits on (see the
  // return value above), once that turn is over.
  let settleHandedOverTurn = null;
  // Who hears that the work the process is held for has finished: the writer
  // and session name of the turn that last completed with work outstanding.
  // A handed-over turn takes this over once it completes; work that reports
  // back before then is still the previous turn's.
  let backgroundReport = null;
  // Set while a handed-over turn runs (handOverTurn): what of the hold it
  // ended its own end has to keep. `untracked`: the process was held for work
  // neither the tracker nor the run's own records (untrackedWorkHeld) can
  // see, such as a backgrounded command of an SDK that reports no task,
  // cleared once that work has reported back. `taskIds`: the tasks
  // outstanding at the hand-over. `relayPending`: one of those finished after
  // the hand-over, so the CLI relays it in a turn after this one, which needs
  // stdin open.
  let handedOverHold = null;
  // What the process was launched with (cwd, tool rules, effort, ultracode),
  // and the model and permission mode its next prompt runs with, with the
  // `skipPermissions` of the tool settings its current turn came with. Set
  // once the query exists; a turn handed over later is compared with it
  // (planTurnHandOver). The model and permission mode follow the switches
  // sent since, before the CLI answers them (switchProcess).
  let launched = null;
  // The switches of the model and of the permission mode sent to the
  // process (createSwitchTracker), set with `launched`.
  let switchTrackers = null;
  // The SDK options the run's canUseTool reads. A handed-over turn's tool
  // rules and permission mode are written here.
  let liveSdkOptions = null;
  // Set while the user stops a handed-over turn, and only that turn
  // (stopHandedOverTurn). A `result` meanwhile is the stopped turn's: it
  // completes nothing, and resolves the stop's wait for it (settleStoppedTurn).
  let stoppingHandedOverTurn = false;
  let settleStoppedTurn = null;
  // A hand-over whose prompt waits for the turn the CLI runs on its own to
  // end before the process is switched for it and the prompt is written
  // (handOverTurn); written by writeDeferredHandOver.
  let deferredHandOver = null;
  // What the process is switched back to once a turn handed over with
  // `restoreSwitches` is over (restoreTurnSwitches): the model and permission
  // mode it ran with before, when the turn switched them, and its tool rules.
  // Set once the turn's switches are made (writeHandedOverPrompt).
  let switchesToRestore = null;
  // Who hears what the process runs with once such a turn is over
  // (restoreTurnSwitches): the turn's `onSwitchesRestored`, with whether its
  // plan switches the model and the permission mode, made or not. Set at the
  // hand-over (handOverTurn).
  let switchesReport = null;

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: writer?.userId || null,
      writer,
      event
    });
  };

  // Settles the handed-over turn's promise, once.
  const settleTurn = () => {
    const settle = settleHandedOverTurn;
    settleHandedOverTurn = null;
    settle?.();
  };

  // Ends the held prompt stream. Replaced once the stream exists; only
  // releaseInput below calls it for the live stream.
  let releasePromptStream = () => {};
  // Writes one more message to the CLI through the held prompt stream (a
  // mid-run insert); false until the stream exists and once it is released.
  let pushPrompt = () => false;
  // The uuid the run's prompt goes out with: the CLI records the prompt's row
  // under it and echoes the prompt back with it (see createInsertController).
  const firstPromptUuid = crypto.randomUUID();
  // The post-turn hold's silence countdown (HOLD_IDLE_MS) and its backstop
  // (HOLD_MAX_MS), with when the backstop runs out. Both run only while the
  // process is held for background work.
  let holdIdleTimer = null;
  let holdMaxTimer = null;
  let holdMaxAt = null;
  // Closes the process if it is still up ABANDONED_PROCESS_CLOSE_MS after its
  // input was released.
  let abandonedCloseTimer = null;
  // The client is told the turn is over as soon as `result` lands, even though
  // the process lingers, so the UI never waits out the idle hold. A `result`
  // that comes while inserts are pending is held back instead (see
  // createInsertController), so this can stay false across several turns.
  let turnCompleteSent = false;
  // Set by the first `result` of the run's own turn, held back or not. Any
  // task-notification `result` before it ends a batch the CLI ran ahead of the
  // prompt; one after it is background work reporting back.
  let promptResultSeen = false;
  // Set when a turn starts a background task (startsBackgroundTasks),
  // cleared when the next `result` arrives — only turns with work still
  // outstanding hold their process open.
  let backgroundWorkPending = false;
  // Set when the stream reports a task starting during this turn. Task events
  // are the exact word on what is still running, so when the turn produced
  // any, the tracker decides the hold for tasks; `backgroundWorkPending` is
  // the fallback for an SDK that does not report tasks at all.
  let sawTaskEventThisTurn = false;
  // Work no task event reports, which the process is held for whatever the
  // tracker says (untrackedWorkHeld), as the calls and their results tell:
  // - `heldWakeup`: the wake-up a ScheduleWakeup (/loop) set, as
  //   readWakeupTime has it, until it fires and its turn ends, a later call
  //   sets another, or one with `stop: true` cancels it.
  // - `heldCronJobs`: the jobs CronCreate scheduled in this process, by id,
  //   with `recurring` and `nextFireAt` (null when its result did not say):
  //   a recurring one until a CronDelete cancels it, a one-shot one until it
  //   has fired. They die with the process, as the CLI keeps them in memory.
  // - `untrackedMonitorHeld`: a Monitor the CLI reported no task for, until
  //   the CLI runs a turn for it.
  let heldWakeup = null;
  const heldCronJobs = new Map();
  let untrackedMonitorHeld = false;
  const untrackedWorkHeld = () => heldWakeup !== null || heldCronJobs.size > 0 || untrackedMonitorHeld;
  // The turn's main-thread ScheduleWakeup, CronCreate and CronDelete calls,
  // by tool_use id, until their results say what they did.
  const schedulingCalls = new Map();
  // The turn's Monitor calls the CLI has reported no task for yet.
  const monitorCallsAwaitingTask = new Set();
  // Set once the turn has made a ScheduleWakeup call: what it called, not a
  // wake-up it ran for, then decides whether a wake-up is still to come.
  let wakeupCallThisTurn = false;
  // The commands the CLI started for the turn (`command_lifecycle`
  // `started`): `source` is the scheduler fire's `wakeup_source`
  // (`loop_wakeup` for a ScheduleWakeup's, `schedule_wakeup` for a cron
  // job's), null for any other command or from a CLI that does not say,
  // `scheduledFor` the time a wake-up was set for, and `startedAt` when the
  // run heard it start.
  let turnCommands = [];
  // Tasks of the session's own that finished (not stopped), until the CLI
  // feeds their notification into a turn: their relay. A `result` of a turn
  // that relayed one (ownTaskRelayedThisTurn) is that task reporting back,
  // not untracked work. The CLI echoes each notification it feeds a turn
  // (taskNotificationEchoedThisTurn), which names the task.
  const finishedOwnTaskIds = new Set();
  let ownTaskRelayedThisTurn = false;
  let taskNotificationEchoedThisTurn = false;
  // Whether the CLI is in a turn, as far as the stream tells: from the first
  // sign of one until its `result`.
  let cliTurnActive = true;
  // True while the process is being held open for background work, so a later
  // `result` can be recognised as that work reporting back.
  let heldForBackgroundWork = false;
  // Set once a turn publishes a budget read from an assistant message, so the
  // turn-ending `result` is only mined for usage when nothing better arrived.
  let assistantBudgetSent = false;
  // The window the SDK reported for this session's model (a resumed session
  // starts from the one its last run reported), the model the main thread's
  // assistant rows name, and the budget last published — re-sent with the
  // right total when the turn's `result` is the first to state the window.
  let reportedContextWindow = getReportedClaudeContextWindow(providerSessionId) ?? null;
  let mainThreadModel = null;
  let lastSentTokenBudget = null;

  // This run's activeSessions entry. It is registered as soon as the run has a
  // session key, before its CLI is up, so an abort or a newer run finds the
  // run while it still waits for the process it replaces.
  let markExited = () => {};
  const runEntry = {
    // The SDK query, once created.
    instance: null,
    // `starting` until the query exists, then `active`; `aborted` once
    // abortClaudeSDKSession has dealt with it.
    status: 'starting',
    startTime: null,
    writer: ws,
    // Set when the held prompt stream ends (releaseInput). The SDK may keep
    // stdin open a little longer (until the first `result`), but a control
    // request written from here on can be dropped, so nothing sends one: they
    // all go out before the release.
    inputReleased: false,
    // Set by abortClaudeSDKSession before it interrupts the process, cleared
    // again if the abort fails. A `result` that lands meanwhile is the
    // interrupted turn's and sends no `complete`: the abort's caller sends it.
    // Per run, so an aborted process still winding down cannot touch the
    // session's next run.
    abortRequested: false,
    // Set once the run no longer speaks for the session: a newer run took it
    // over (retireSession), or the user aborted it. Its loop then ignores
    // everything the process still says and winds down without a word.
    silenced: false,
    // Settles when this run's message loop has ended. A loop that ends on its
    // own has seen the CLI exit (the SDK waits for the exit before it ends the
    // stream); one ended by closing the query has not: the SDK ends the stream
    // at once and kills the process seconds later.
    exited: new Promise((resolve) => { markExited = resolve; }),
    // Set by closeRun when the query is closed; settles once the process can
    // be taken to be gone.
    closed: null,
    // Settles once the CLI process this run started (spawnClaudeCli) has
    // exited; null until it starts one, and for a query that starts none of
    // its own (a test's scripted one).
    processGone: null,
    // The run's mid-run inserts (createInsertController), set right below.
    inserts: null,
    releaseInput: (reason) => releaseInput(reason),
    reportAborted: () => reportAborted(),
    // Whether a later send's turn can go into this process (handOverTurn).
    takesHandedOverTurn: () => takesHandedOverTurn(),
    // Runs a later send's turn in this process (handTurnToHeldProcess).
    handOverTurn: (turn) => handOverTurn(turn),
    // A later send's run options with what they leave out taken from this
    // process (handTurnToHeldProcess, for options that inherit unset settings).
    inheritUnsetSettings: (turnOptions) => (launched ? inheritUnsetSettings(turnOptions, liveSettings()) : turnOptions),
    // What a later send's turn would make of this process (planClaudeSDKHandOver).
    planHandOver: (turnOptions, planOptions) => planHandOver(turnOptions, planOptions),
    // Releases the caller of a handed-over turn the run will not finish.
    settleTurn: () => settleTurn(),
    // Whether an abort stops only the turn under way, and stops it so
    // (abortClaudeSDKSession; see stopHandedOverTurn).
    stopsTurnOnly: () => stopsTurnOnly(),
    stopHandedOverTurn: () => stopHandedOverTurn(),
  };
  // The key runEntry is registered under. A session key never changes once known.
  let registeredKey = null;

  runEntry.inserts = createInsertController({
    firstPromptUuid,
    push: (message) => pushPrompt(message),
    inputOpen: () => Boolean(runEntry.instance) && !runEntry.inputReleased,
    stopping: () => runEntry.abortRequested || runEntry.silenced || stoppingHandedOverTurn,
    // A turn under way: the CLI is up, the turn has not completed, and the run
    // is neither being stopped nor letting its process go.
    acceptsInserts: () => Boolean(runEntry.instance)
      && !turnCompleteSent
      && !runEntry.inputReleased
      && !runEntry.abortRequested
      && !runEntry.silenced
      && !stoppingHandedOverTurn,
    getInstance: () => runEntry.instance,
    send: (message) => writer.send(message),
    normalize: (raw) => context.normalizeMessage(raw, capturedSessionId || sessionId || null),
    getSessionId: () => capturedSessionId || sessionId || null,
    finishDeferredTurn: (result) => {
      if (!runEntry.silenced) {
        finishTurn(result);
      }
    },
    logPrefix: () => `[Claude SDK] Session ${sessionKey() || 'NEW'}`,
  });

  // The run's one report that the user stopped it. Sent by
  // abortClaudeSDKSession, or by the run itself when its loop ends while the
  // abort is still under way, whichever comes first; never for a turn that
  // has already completed. The abort's caller sends the terminal `complete`.
  const reportAborted = () => {
    if (turnCompleteSent) {
      return;
    }
    turnCompleteSent = true;
    handedOverHold = null;
    notifyRunStopped({
      userId: writer?.userId || null,
      provider: 'claude',
      sessionId: sessionId || capturedSessionId || null,
      sessionName: turnSessionName,
      stopReason: 'aborted',
      runStartedAt: writer?.runStartedAt ?? null
    });
    settleTurn();
  };

  const clearHoldTimers = () => {
    if (holdIdleTimer) {
      clearTimeout(holdIdleTimer);
      holdIdleTimer = null;
    }
    if (holdMaxTimer) {
      clearTimeout(holdMaxTimer);
      holdMaxTimer = null;
    }
    holdMaxAt = null;
  };

  // Closes the held prompt stream so the CLI can wind down, once, and logs why.
  // Ends the hold too: nothing is held for after this. The CLI should then
  // exit on its own; one still up ABANDONED_PROCESS_CLOSE_MS later is closed.
  const releaseInput = (reason) => {
    clearHoldTimers();
    heldWakeup = null;
    heldCronJobs.clear();
    untrackedMonitorHeld = false;
    finishedOwnTaskIds.clear();
    // No prompt, switch or restore reaches the CLI from here on, and a turn
    // whose process lets go is not reported switched back.
    deferredHandOver = null;
    switchesToRestore = null;
    switchesReport = null;
    if (runEntry.inputReleased) {
      return;
    }
    runEntry.inputReleased = true;
    if (runEntry.instance) {
      console.log(`[Claude SDK] Session ${sessionKey() || 'NEW'}: closing the CLI's input (${reason})`);
    }
    releasePromptStream();
    // At the end of the loop the process is already gone or going.
    if (reason !== 'loop-end' && runEntry.instance) {
      abandonedCloseTimer = setTimeout(() => {
        abandonedCloseTimer = null;
        console.warn(`[Claude SDK] Session ${sessionKey() || 'NEW'}: the process is still running ${ABANDONED_PROCESS_CLOSE_MS} ms after its input was closed (${reason}); closing it`);
        // Closing ends the loop at once and the process seconds later, so the
        // entry waits in exitingSessions like a superseded or aborted one, and
        // the session's next run waits for it. One a newer run retired or an
        // abort let go is there already.
        if (registeredKey && getSession(registeredKey) === runEntry) {
          exitingSessions.set(registeredKey, runEntry);
        }
        closeRun(runEntry, sessionKey());
      }, ABANDONED_PROCESS_CLOSE_MS);
      abandonedCloseTimer.unref?.();
    }
  };

  // HOLD_IDLE_MS of silence. Like every timer here, the hold timers are
  // unref'd: they never keep the server alive on their own.
  const onHoldIdle = () => {
    holdIdleTimer = null;
    // Silence says nothing about the session's own tasks: a backgrounded
    // command emits nothing until it ends. Nor about a recurring cron job
    // between its fires, or a one-shot one whose result named no time.
    // HOLD_MAX bounds those.
    if (
      backgroundWork.hasOwnOutstanding(sessionKey())
      || [...heldCronJobs.values()].some((job) => job.recurring || job.nextFireAt === null)
    ) {
      armHoldIdleTimer();
      return;
    }
    // Nor about a wake-up or a one-shot cron job still to come: the hold
    // waits for the last of them, with WAKEUP_GRACE_MS to spare, as a fire
    // that never starts sends nothing. A one-shot job due after HOLD_MAX runs
    // out is not waited for: it would not fire in this process anyway.
    const holdEndsAt = holdMaxAt ?? Date.now() + HOLD_MAX_MS;
    let dueAt = heldWakeup ? heldWakeup.at : -Infinity;
    for (const job of heldCronJobs.values()) {
      if (job.nextFireAt <= holdEndsAt) {
        dueAt = Math.max(dueAt, job.nextFireAt);
      }
    }
    const wait = dueAt + WAKEUP_GRACE_MS - Date.now();
    if (wait > 0) {
      armHoldIdleTimer(wait);
      return;
    }
    heldForBackgroundWork = false;
    releaseInput('idle');
  };
  const armHoldIdleTimer = (delay = HOLD_IDLE_MS) => {
    if (holdIdleTimer) {
      clearTimeout(holdIdleTimer);
    }
    holdIdleTimer = setTimeout(onHoldIdle, Math.min(delay, MAX_TIMER_DELAY_MS));
    holdIdleTimer.unref?.();
  };

  // No follow-up turn for HOLD_MAX_MS: give up on the work. stdin is still
  // open, so the stops reach the CLI; the release comes after them. Letting go
  // this way is not the work finishing, so nothing is reported finished.
  const onHoldMax = () => {
    holdMaxTimer = null;
    heldForBackgroundWork = false;
    const outstanding = backgroundWork.outstanding(sessionKey());
    console.warn(`[Claude SDK] Session ${sessionKey() || 'NEW'}: no follow-up turn for ${HOLD_MAX_MS} ms; stopping ${outstanding.length} outstanding task(s)`);
    for (const task of outstanding) {
      sendStopTask(runEntry.instance, task.taskId);
    }
    releaseInput('hold-max');
  };
  const armHoldMaxTimer = () => {
    if (holdMaxTimer) {
      clearTimeout(holdMaxTimer);
    }
    holdMaxAt = Date.now() + HOLD_MAX_MS;
    holdMaxTimer = setTimeout(onHoldMax, HOLD_MAX_MS);
    holdMaxTimer.unref?.();
  };

  // The work the process is held for has all reported back: one report, to
  // the turn that left it running (backgroundReport), else the current one.
  const reportBackgroundWorkDone = () => {
    const report = backgroundReport ?? { writer, sessionName: turnSessionName };
    backgroundReport = null;
    notifyBackgroundWorkCompleted({
      userId: report.writer?.userId || null,
      provider: 'claude',
      sessionId: sessionId || capturedSessionId || null,
      sessionName: report.sessionName,
      runStartedAt: report.writer?.runStartedAt ?? null
    });
    report.writer.reportBackgroundWorkFinished?.();
  };

  // Notes a task of the session's own that finished on its own, not stopped:
  // the CLI relays it in a turn (finishedOwnTaskIds). Read at its first
  // terminal event, before the tracker forgets it.
  const noteOwnTaskFinished = (message) => {
    if (message.type !== 'system' || typeof message.task_id !== 'string') {
      return;
    }
    const finished = (message.subtype === 'task_notification' && message.status !== 'stopped')
      || (message.subtype === 'task_updated' && (message.patch?.status === 'completed' || message.patch?.status === 'failed'));
    if (finished && backgroundWork.outstanding(sessionKey()).some((task) => task.taskId === message.task_id && !task.nested)) {
      finishedOwnTaskIds.add(message.task_id);
    }
  };

  // Whether a `result` that comes once the run's turn is over ends a turn the
  // CLI ran on its own (a wake-up's, a cron job's, a Monitor event's), which
  // reports back work the tracker cannot see (noteTurnUntrackedWork): a turn
  // for no prompt the run wrote, and not one relaying a task of the
  // session's own (ownTaskRelayedThisTurn).
  const reportsUntrackedWork = (result) => result.origin?.kind !== 'human'
    && !runEntry.inserts.namesWrittenPrompt(result)
    && !ownTaskRelayedThisTurn;

  // Work the turn has started that would hold the process if it ended now:
  // a Monitor the CLI has reported no task for yet, or anything lasting from
  // an SDK that reports no task at all. A wake-up or a cron job holds from
  // its call's result on (untrackedWorkHeld).
  const turnStartedWorkToHold = () => monitorCallsAwaitingTask.size > 0
    || (!sawTaskEventThisTurn && backgroundWorkPending);

  // A `result` ends a turn: what the next turn starts counts afresh.
  const resetTurnWork = () => {
    backgroundWorkPending = false;
    sawTaskEventThisTurn = false;
    ownTaskRelayedThisTurn = false;
    taskNotificationEchoedThisTurn = false;
    wakeupCallThisTurn = false;
    turnCommands = [];
    schedulingCalls.clear();
    monitorCallsAwaitingTask.clear();
  };

  // Notes the main-thread calls that leave work no task event reports. A
  // Monitor waits for its task (monitorCallsAwaitingTask); a ScheduleWakeup,
  // CronCreate or CronDelete for its result (noteSchedulingResults).
  const noteUntrackedWorkCalls = (message) => {
    const content = message.message?.content;
    if (!Array.isArray(content)) {
      return;
    }
    for (const block of content) {
      if (block?.type !== 'tool_use' || typeof block.id !== 'string') {
        continue;
      }
      if (block.name === 'Monitor') {
        monitorCallsAwaitingTask.add(block.id);
      } else if (block.name === 'ScheduleWakeup' || block.name === 'CronCreate' || block.name === 'CronDelete') {
        schedulingCalls.set(block.id, { name: block.name, input: block.input ?? {}, calledAt: Date.now() });
      }
    }
  };

  // Reads what the turn's ScheduleWakeup, CronCreate and CronDelete calls
  // did off their results: the output the CLI adds to a message that carries
  // one result (`tool_use_result`), else the result's text and the call's
  // input. A call that failed did nothing. A wake-up set replaces the one
  // pending, as the CLI cancels that; `stop: true` cancels every pending
  // wake-up, but no cron job.
  const noteSchedulingResults = (message) => {
    const content = message.message?.content;
    if (!Array.isArray(content)) {
      return;
    }
    const results = content.filter((block) => block?.type === 'tool_result');
    for (const block of results) {
      const call = schedulingCalls.get(block.tool_use_id);
      if (!call) {
        continue;
      }
      schedulingCalls.delete(block.tool_use_id);
      if (block.is_error === true) {
        continue;
      }
      const output = results.length === 1 && message.tool_use_result && typeof message.tool_use_result === 'object'
        ? message.tool_use_result
        : null;
      if (call.name === 'ScheduleWakeup') {
        wakeupCallThisTurn = true;
        heldWakeup = call.input.stop === true || output?.stopped === true
          ? null
          : readWakeupTime(output, call.input, call.calledAt);
      } else if (call.name === 'CronCreate') {
        heldCronJobs.set(readCronJobId(output, readToolResultText(block.content)) ?? `call:${block.tool_use_id}`, {
          // A job is recurring unless the call says otherwise.
          recurring: typeof output?.recurring === 'boolean' ? output.recurring : call.input.recurring !== false,
          nextFireAt: Number.isFinite(output?.nextFireAt) ? output.nextFireAt : null,
        });
      } else {
        heldCronJobs.delete(typeof output?.id === 'string' ? output.id : call.input.id);
      }
    }
  };

  // Notes a command the CLI starts for the turn it runs (`command_lifecycle`
  // `started`), as `turnCommands` keeps them.
  const noteCommandStarted = (message) => {
    turnCommands.push({
      source: message.wakeup_source === 'loop_wakeup' || message.wakeup_source === 'schedule_wakeup'
        ? message.wakeup_source
        : null,
      scheduledFor: Number.isFinite(message.scheduled_for) ? message.scheduled_for : null,
      startedAt: Date.now(),
    });
  };

  // A cron job fired, starting at `firedAt`. The fire names no job (CLI
  // 2.1.312), but the CLI fires a one-shot job only once the time its
  // CronCreate result named has come, and the fire is seen after that: the
  // one-shot job due first by then is the one, and is gone, else the first
  // one whose result named no time. A fire with no one-shot job due, a
  // recurring job's or that of a job the run did not see created (one an
  // earlier process saved, the CLI's notice of missed jobs), takes none.
  const dropFiredOneShotJob = (firedAt) => {
    let fired = null;
    let untimed = null;
    for (const [jobId, job] of heldCronJobs) {
      if (job.recurring) {
        continue;
      }
      if (job.nextFireAt === null) {
        untimed = untimed ?? jobId;
      } else if (
        job.nextFireAt <= firedAt
        && (fired === null || job.nextFireAt < heldCronJobs.get(fired).nextFireAt)
      ) {
        fired = jobId;
      }
    }
    const jobId = fired ?? untimed;
    if (jobId !== null) {
      heldCronJobs.delete(jobId);
    }
  };

  // What a turn's `result` tells of the work no task reports, its calls read
  // (noteSchedulingResults):
  // - A scheduler fire the turn ran for has reported back. A ScheduleWakeup's
  //   (`loop_wakeup`) takes the held wake-up with it, unless the turn made a
  //   ScheduleWakeup call of its own, or the held one was set while the fire
  //   waited: the CLI names the time a fire was set for, and the held one
  //   then has another. A cron job's (`schedule_wakeup`) takes the one-shot
  //   job it fired for, if any (dropFiredOneShotJob); a recurring one stays.
  // - A turn the CLI ran on its own (`cliOwnTurn`: reportsUntrackedWork) to
  //   relay a task notification is a Monitor's the CLI reported no task for.
  //   One for no fire the CLI named, from a CLI that does not name them, is
  //   taken for any work that ends by reporting back: the wake-up, every
  //   one-shot job due by then, as dropFiredOneShotJob reads a job's time,
  //   and the Monitor.
  // - A Monitor called during the turn that the CLI reported no task for is
  //   held from now on.
  const noteTurnUntrackedWork = (result, cliOwnTurn) => {
    const fires = turnCommands.filter((command) => command.source !== null);
    for (const fire of fires) {
      if (fire.source === 'schedule_wakeup') {
        dropFiredOneShotJob(fire.startedAt);
      } else if (
        heldWakeup
        && !wakeupCallThisTurn
        && (!heldWakeup.exact || fire.scheduledFor === null || fire.scheduledFor === heldWakeup.at)
      ) {
        heldWakeup = null;
      }
    }
    if (cliOwnTurn && result.origin?.kind === 'task-notification') {
      untrackedMonitorHeld = false;
    } else if (cliOwnTurn && fires.length === 0) {
      if (!wakeupCallThisTurn) {
        heldWakeup = null;
      }
      const dueBy = Date.now();
      for (const [jobId, job] of heldCronJobs) {
        if (!job.recurring && (job.nextFireAt === null || job.nextFireAt <= dueBy)) {
          heldCronJobs.delete(jobId);
        }
      }
      untrackedMonitorHeld = false;
    }
    if (monitorCallsAwaitingTask.size > 0) {
      untrackedMonitorHeld = true;
      monitorCallsAwaitingTask.clear();
    }
  };

  // A task-notification turn from a CLI that echoed none of the
  // notifications it fed the turn relays a task of the session's own when
  // one waits for its relay: the oldest is taken to be the one.
  const noteUnechoedRelay = (result) => {
    if (result.origin?.kind !== 'task-notification' || taskNotificationEchoedThisTurn || ownTaskRelayedThisTurn) {
      return;
    }
    const [taskId] = finishedOwnTaskIds;
    if (taskId !== undefined) {
      finishedOwnTaskIds.delete(taskId);
      ownTaskRelayedThisTurn = true;
    }
  };

  // A `result` of a turn the CLI ran ahead of a handed-over prompt (see
  // isAheadOfHandedOverPrompt): one relaying background work that finished
  // before the hand-over, or one it started on its own (a wake-up that
  // ScheduleWakeup or /loop set, a CronCreate task firing). The handed-over
  // turn goes on. What the earlier turn started is carried into the hold the
  // handed-over turn's end decides on: tasks by the tracker, work the tracker
  // cannot see (the loop's next wake-up, a cron job) by untrackedWorkHeld,
  // and anything lasting from an SDK without task events by `untracked`;
  // then nothing has finished. Otherwise, when it relayed the last of the
  // work (none outstanding, none still to be relayed after the handed-over
  // turn, no untracked work still to report back), that work is done.
  const onWorkReportedAheadOfTurn = (message) => {
    noteTurnUntrackedWork(message, reportsUntrackedWork(message));
    const startedWork = turnStartedWorkToHold();
    resetTurnWork();
    if (startedWork) {
      handedOverHold.untracked = true;
      return;
    }
    if (backgroundWork.hasOutstanding(sessionKey()) || handedOverHold.relayPending || untrackedWorkHeld()) {
      return;
    }
    handedOverHold.untracked = false;
    if (backgroundReport) {
      reportBackgroundWorkDone();
    }
  };

  // Handles a `result` of the run's turn, or of the turns after it: on the
  // first, the turn is over as far as the client is concerned, unless the
  // user is aborting it (then it is the interrupted turn's). Called by the
  // loop, or by the insert controller for a result it held back. A turn
  // handed to the process later (handOverTurn) completes here the same way,
  // and one the user stopped alone (stopHandedOverTurn) ends here without
  // completing: the stop reports it.
  const finishTurn = (message) => {
    const abortPending = runEntry.abortRequested;
    // The stopped turn's own result is the first while the stop is under
    // way; any later one is a turn the CLI runs on its own.
    const stopped = stoppingHandedOverTurn && !abortPending && Boolean(handedOverHold);
    const stillOutstanding = backgroundWork.hasOutstanding(sessionKey());
    let releaseReason = 'background-done';
    const completesTurn = !turnCompleteSent && !abortPending && !stoppingHandedOverTurn;
    // What a handed-over turn keeps of the hold it ended.
    const inheritedHold = completesTurn || stopped ? handedOverHold : null;
    // What the turn did to the work no task reports, and, for a turn the CLI
    // ran on its own after the run's turn, what of it has reported back.
    noteTurnUntrackedWork(message, !completesTurn && !stopped && !abortPending && reportsUntrackedWork(message));
    // Work started during this turn, or work from an earlier turn that
    // has not settled yet (a follow-up turn reports one task in while
    // another is still going), is still running. Hold the process open
    // so it can finish and report back in a follow-up turn; the hold
    // timers are only a backstop for work that never reports.
    //
    // The release when the last task settles is this same branch on the
    // follow-up turn the CLI pushes for it, not the settling event
    // itself: closing stdin at that moment would cut the turn that
    // relays the task's result.
    //
    // When the turn reported its tasks, the tracker is the whole truth about
    // tasks: an Agent call without `run_in_background` is scored as
    // background by `startsBackgroundWork`, but the CLI runs it in the
    // foreground and it has settled before this `result` — holding for it
    // kept a process alive for the full ceiling with nothing outstanding.
    // Work no task reports (untrackedWorkHeld) holds whatever the tracker
    // says: a /loop turn that also backgrounded a command still has its next
    // wake-up to come once the command is done.
    //
    // An input already released (the hold ran out, or an abort) is never
    // held again.
    //
    // A handed-over turn also keeps what the hold it ended was for: work the
    // tracker cannot see that has not reported back, or a task of that hold
    // the CLI has yet to relay.
    const holdForTurn = stillOutstanding
      || turnStartedWorkToHold()
      || untrackedWorkHeld()
      || Boolean(inheritedHold && (inheritedHold.untracked || inheritedHold.relayPending));
    if (completesTurn) {
      turnCompleteSent = true;
      handedOverHold = null;
      releaseReason = 'turn-done';
      if (message.num_turns === 0 && message.origin === undefined) {
        // The prompt's own model-free turn (a local command, a prompt a
        // hook blocked). Logged because an orphan batch from a CLI that
        // stopped sending `origin` looks just like it, and would end the
        // turn early again.
        console.log(`[Claude SDK] Session ${sessionKey() || 'NEW'}: a result with num_turns 0 and no origin ended the turn`);
      }
      writer.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
      notifyRunStopped({
        userId: writer?.userId || null,
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        sessionName: turnSessionName,
        stopReason: 'completed',
        runStartedAt: writer?.runStartedAt ?? null
      });
    } else if (stopped) {
      handedOverHold = null;
      releaseReason = 'turn-stopped';
    } else if (heldForBackgroundWork && !abortPending && !holdForTurn) {
      // A result after the turn already reported complete means the work we
      // held the process open for has finished and pushed a follow-up turn
      // — the last of it, when nothing else is still running and the
      // follow-up turn started nothing new (a loop's next wake-up).
      reportBackgroundWorkDone();
    }
    resetTurnWork();
    if (holdForTurn && !runEntry.inputReleased) {
      heldForBackgroundWork = true;
      // A turn that completes with work outstanding is the one to hear when
      // it is done, the work of the turns before it included.
      if (completesTurn || !backgroundReport) {
        backgroundReport = { writer, sessionName: turnSessionName };
      }
      armHoldIdleTimer();
      armHoldMaxTimer();
      if (completesTurn || stopped) {
        restoreTurnSwitches();
      }
    } else {
      // Either nothing was backgrounded, or the background work just
      // reported in — let the CLI exit now, as it always has.
      heldForBackgroundWork = false;
      releaseInput(abortPending ? 'aborted' : releaseReason);
    }
    if (completesTurn) {
      settleTurn();
    }
    if (stopped) {
      settleStoppedTurn?.();
    }
  };

  // Whether a later send's turn can go into this process instead of one of
  // its own (handOverTurn): the turn under way has completed, and the
  // process is held open for background work, its input still open (a turn
  // that completes with nothing to hold for releases it), and no abort is
  // under way.
  const takesHandedOverTurn = () => turnCompleteSent
    && !runEntry.inputReleased
    && !runEntry.abortRequested;

  // Whether the process is held, its turn over, for work of the session's
  // own: a task one of its turns started that is still outstanding, or work
  // the tracker cannot see (a wake-up, a cron job, a relay still to come),
  // which is all a hold with no task outstanding can be for. A hold kept
  // only for nested tasks is not, unless untracked work is held as well.
  const holdsOwnWork = () => takesHandedOverTurn()
    && heldForBackgroundWork
    && (untrackedWorkHeld()
      || backgroundWork.hasOwnOutstanding(sessionKey())
      || !backgroundWork.hasOutstanding(sessionKey()));

  // Whether a turn is under way in a process with work of the session's own:
  // a task of the session's own still outstanding, work no task reports (a
  // /loop wake-up, a cron job; untrackedWorkHeld) or that the turn has
  // started (turnStartedWorkToHold), or, for a turn handed over while the
  // process was held, the untracked work of that hold or a task of it the
  // CLI has yet to relay. Stopping a first turn stops that work with its
  // process (abortClaudeSDKSession); a handed-over turn is stopped alone
  // (stopHandedOverTurn).
  const holdsOwnWorkInTurn = () => !turnCompleteSent
    && Boolean(runEntry.instance)
    && !runEntry.inputReleased
    && !runEntry.abortRequested
    && !runEntry.silenced
    && (backgroundWork.hasOwnOutstanding(sessionKey())
      || turnStartedWorkToHold()
      || untrackedWorkHeld()
      || Boolean(handedOverHold && (handedOverHold.untracked || handedOverHold.relayPending)));

  // The live process's own settings, which a later send's turn that leaves
  // one out inherits (inheritUnsetSettings): its working directory, model,
  // effort, ultracode and permission mode, the tools canUseTool allows now
  // (what the user allowed for good included), the tools it was launched
  // denying, and the `skipPermissions` its current turn came with.
  const liveSettings = () => ({
    cwd: launched.cwd,
    model: launched.model,
    effort: launched.effort,
    ultracode: launched.ultracode,
    permissionMode: launched.permissionMode,
    allowedTools: liveSdkOptions.allowedTools,
    disallowedTools: launched.disallowedTools,
    skipPermissions: launched.skipPermissions,
  });

  // What handOverTurn would make of a later send's turn with these options,
  // worked out without writing or switching anything (planClaudeSDKHandOver).
  // The lookups are the ones handTurnToHeldProcess makes, with this run's
  // context, except that the turn's own model comes first: the chat gateway
  // records it for the session before the turn's run looks the model up.
  // With `inheritUnset`, asked or set in the options, a setting the options
  // leave out is this process's own (inheritUnsetSettings), the model
  // included, so there is no model to look up.
  const planHandOver = async (turnOptions, planOptions = {}) => {
    // A turn under way takes no other; whether its process has work of the
    // session's own is all there is to say.
    const inTurn = () => ({ heldWork: holdsOwnWorkInTurn(), canHandOver: false, changes: [], switches: [] });
    if (!takesHandedOverTurn()) {
      return inTurn();
    }
    // Only a new process resumes the conversation partway.
    if (turnOptions.resumeAnchorId || turnOptions.resumeFromScratch) {
      return { heldWork: holdsOwnWork(), canHandOver: false, changes: [], switches: [] };
    }
    const planned = planOptions.inheritUnset === true || turnOptions.inheritUnset === true
      ? inheritUnsetSettings(turnOptions, liveSettings())
      : turnOptions;
    let next = null;
    let nextUltracode = false;
    try {
      const requestedModel = namesSetting(planned.model) ? planned.model.trim() : '';
      const model = requestedModel || await context.resolveResumeModel(sessionKey(), planned.model);
      next = mapCliOptionsToSDK({
        ...planned,
        model: model || planned.model,
        effortModels: await loadEffortModels(context),
      });
      nextUltracode = await resolveEffectiveUltracode(next);
    } catch (error) {
      next = null;
      console.warn(`[Claude SDK] Session ${sessionKey()}: could not work out whether a new turn goes into the process held for background work:`, error?.message || error);
    }
    // The process may have let go, or taken another turn, meanwhile.
    if (!takesHandedOverTurn()) {
      return inTurn();
    }
    if (!next) {
      return { heldWork: holdsOwnWork(), canHandOver: false, changes: ['lookup'], switches: [] };
    }
    const { changes, switches } = planTurnHandOver(launched, next, runEntry.instance, nextUltracode);
    return { heldWork: holdsOwnWork(), canHandOver: changes.length === 0, changes, switches };
  };

  // Sends one switch of the model or the permission mode (`setting`) to the
  // live process. From then on `launched` names its target, which the CLI
  // applies ahead of any prompt written after it, so a turn planned or handed
  // over before the CLI answers is weighed against what its prompt will run
  // with (createSwitchTracker). A switch the CLI refuses leaves the process
  // as it was: `launched` goes back to what it runs with, and the refusal is
  // logged. canUseTool follows a permission mode once the CLI confirms it,
  // which it does ahead of any tool request of the turn.
  // @returns {Promise<boolean>} Settles once the CLI has answered: true when
  //   it switched
  const switchProcess = (setting, value, description) => {
    const tracker = switchTrackers[setting];
    const answer = tracker.send(value);
    launched[setting] = tracker.current();
    const refused = (error) => {
      console.warn(`[Claude SDK] Session ${sessionKey()}: could not switch ${description}: ${error?.message || error}`);
      answer.refuse();
      launched[setting] = tracker.current();
      return false;
    };
    try {
      const reply = setting === 'model'
        ? runEntry.instance.setModel(value)
        : runEntry.instance.setPermissionMode(value);
      return Promise.resolve(reply).then(() => {
        answer.confirm();
        launched[setting] = tracker.current();
        if (setting === 'permissionMode') {
          liveSdkOptions.permissionMode = tracker.confirmed();
        }
        return true;
      }, refused);
    } catch (error) {
      return Promise.resolve(refused(error));
    }
  };

  // Switches the model and permission mode a hand-over's plan names, ahead
  // of its prompt, which the CLI reads after them, and sets the turn's own
  // tool rules; the remembered ones of earlier turns go. `skipPermissions` is
  // that of the tool settings the turn came with, which a later turn that
  // brings none inherits.
  const applyTurnSettings = ({ plan, allowedTools, skipPermissions }) => {
    if (plan.model) {
      switchProcess('model', plan.model, `the model to ${plan.model}`);
    }
    if (plan.permissionMode) {
      switchProcess('permissionMode', plan.permissionMode, `the permission mode to ${plan.permissionMode}`);
    }
    liveSdkOptions.allowedTools = [...allowedTools];
    launched.skipPermissions = skipPermissions;
  };

  // Switches the process for a hand-over and writes its prompt (handOverTurn).
  // A turn that keeps its switches to itself has what they replace noted
  // first, for restoreTurnSwitches. False when the prompt could not be
  // written.
  const writeHandedOverPrompt = (turn) => {
    const restore = turn.restoreSwitches ? {
      model: turn.plan.model ? launched.model : null,
      permissionMode: turn.plan.permissionMode ? launched.permissionMode : null,
      allowedTools: [...liveSdkOptions.allowedTools],
      skipPermissions: launched.skipPermissions,
    } : null;
    applyTurnSettings(turn);
    if (!pushPrompt({ ...turn.promptMessage, priority: 'later' })) {
      return false;
    }
    switchesToRestore = restore;
    return true;
  };

  // Writes the prompt of a hand-over that waited for the CLI's own turn to
  // end (handOverTurn), once that turn's `result` is in.
  const writeDeferredHandOver = () => {
    const turn = deferredHandOver;
    if (!turn || cliTurnActive || runEntry.inputReleased) {
      return;
    }
    deferredHandOver = null;
    if (writeHandedOverPrompt(turn)) {
      runEntry.inserts.noteHandedOverPromptWritten();
    }
  };

  // Switches the process back once a turn handed over with `restoreSwitches`
  // is over (completed, failed or stopped, its prompt taken back included), so
  // the work it is still held for runs on with its own model, permission mode
  // and tool rules. Nothing is sent to a process that lets go after the turn,
  // and nobody hears of it. Otherwise, once the CLI has answered every switch
  // back, the turn's `onSwitchesRestored` hears what the process runs with:
  // for the model and the permission mode, when the turn's plan switches it
  // (made or not), the value it was switched back to, else what the process
  // has (the CLI refused to switch it back, or the prompt was taken back
  // before the switches were made); null when the plan does not switch it.
  const restoreTurnSwitches = () => {
    const restore = switchesToRestore;
    const report = switchesReport;
    switchesToRestore = null;
    switchesReport = null;
    const answers = [];
    if (restore) {
      if (restore.model) {
        const model = restore.model;
        answers.push(switchProcess('model', model, `the model back to ${model}`).then((switched) => (switched ? { model } : {})));
      }
      if (restore.permissionMode) {
        const permissionMode = restore.permissionMode;
        answers.push(switchProcess('permissionMode', permissionMode, `the permission mode back to ${permissionMode}`)
          .then((switched) => (switched ? { permissionMode } : {})));
      }
      liveSdkOptions.allowedTools = [...restore.allowedTools];
      launched.skipPermissions = restore.skipPermissions;
    }
    if (!report) {
      return;
    }
    void Promise.all(answers).then((switchedBack) => {
      const restored = Object.assign({}, ...switchedBack);
      try {
        report.onSwitchesRestored({
          model: report.switchesModel ? restored.model ?? launched.model : null,
          permissionMode: report.switchesPermissionMode ? restored.permissionMode ?? launched.permissionMode : null,
        });
      } catch (error) {
        console.warn(`[Claude SDK] Session ${sessionKey()}: onSwitchesRestored failed:`, error?.message || error);
      }
    });
  };

  // Runs a later send's turn in this process as its next turn (see
  // handTurnToHeldProcess), when its options allow (planTurnHandOver):
  // the model and permission mode are switched first (writeHandedOverPrompt),
  // and the prompt goes out with priority `later`, so the CLI runs it as a
  // turn of its own once it is idle, after any turn it runs first: one
  // relaying background work, or one it starts on its own (a wake-up, a
  // CronCreate task). Those turns' results are not this turn's
  // (isAheadOfHandedOverPrompt). From then on the turn reports through its
  // own writer and completes once, like any turn; the work the process was
  // held for keeps running and reports back. The hold ends: HOLD_IDLE stops,
  // as a long tool call is silent, and HOLD_MAX stays the backstop.
  //
  // `restoreSwitches` (`restoreSwitchesAfterTurn` in the run options) keeps
  // what the turn switches to its own: the process is switched back once the
  // turn is over (restoreTurnSwitches), and `onSwitchesRestored` hears what
  // it runs with then, unless it lets go. Such a turn that switches anything
  // while the CLI runs a turn of its own waits for that turn's `result`
  // before it switches the process and writes its prompt
  // (writeDeferredHandOver), so the CLI's turn, a /loop wake-up say, runs
  // with the process's own settings; stopped before then, it switches
  // nothing, and `onSwitchesRestored` still hears what the process runs with.
  const handOverTurn = ({ writer: turnWriter, sessionName, sdkOptions: next, ultracode, skipPermissions, restoreSwitches, onSwitchesRestored, promptMessage }) => {
    if (!takesHandedOverTurn()) {
      return { taken: false, changes: [] };
    }
    const plan = planTurnHandOver(launched, next, runEntry.instance, ultracode);
    if (plan.changes.length > 0) {
      return { taken: false, changes: plan.changes };
    }

    const turn = {
      plan,
      allowedTools: next.allowedTools ?? [],
      skipPermissions: skipPermissions === true,
      restoreSwitches: restoreSwitches === true,
      onSwitchesRestored: typeof onSwitchesRestored === 'function' ? onSwitchesRestored : null,
      promptMessage,
    };
    const waitsForCliTurn = turn.restoreSwitches && Boolean(plan.model || plan.permissionMode) && cliTurnActive;
    if (waitsForCliTurn) {
      deferredHandOver = turn;
    } else if (!writeHandedOverPrompt(turn)) {
      return { taken: false, changes: [] };
    }
    switchesReport = turn.restoreSwitches && turn.onSwitchesRestored ? {
      switchesModel: Boolean(plan.model),
      switchesPermissionMode: Boolean(plan.permissionMode),
      onSwitchesRestored: turn.onSwitchesRestored,
    } : null;

    // What a turn the CLI runs ahead of the prompt has started so far stays
    // counted (backgroundWorkPending, sawTaskEventThisTurn) until that turn's
    // `result`, which carries it into the hold (onWorkReportedAheadOfTurn).
    const outstanding = backgroundWork.outstanding(sessionKey());
    if (holdIdleTimer) {
      clearTimeout(holdIdleTimer);
      holdIdleTimer = null;
    }
    heldForBackgroundWork = false;
    handedOverHold = {
      // Work no task reports that the run follows (untrackedWorkHeld) is
      // still held after the turn as long as it lasts.
      untracked: outstanding.length === 0 && !untrackedWorkHeld(),
      taskIds: new Set(outstanding.map((task) => task.taskId)),
      relayPending: false,
    };

    // The previous turn's run hears that its process, and its work, go on,
    // and so does the run of the turn that left the work running, when that
    // is an earlier one (the previous turn was stopped, and left none): the
    // work's end is still that run's (backgroundReport).
    writer.reportProcessHandedOver?.();
    if (backgroundReport && backgroundReport.writer !== writer) {
      backgroundReport.writer.reportProcessHandedOver?.();
    }
    writer = turnWriter;
    runEntry.writer = turnWriter;
    turnSessionName = sessionName;
    turnCompleteSent = false;
    runEntry.inserts.beginHandedOverTurn(promptMessage.uuid, { written: !waitsForCliTurn });
    const settled = new Promise((resolve) => { settleHandedOverTurn = resolve; });
    console.log(`[Claude SDK] Session ${sessionKey()}: a new turn goes into the process held for background work (${outstanding.length} task(s) outstanding${waitsForCliTurn ? '; after the CLI\'s own turn' : ''})`);
    return { taken: true, settled };
  };

  // Whether an abort stops only the turn under way (stopHandedOverTurn): a
  // turn handed to the process while it was held for background work, with
  // its input still open and no other stop under way.
  const stopsTurnOnly = () => Boolean(handedOverHold)
    && !turnCompleteSent
    && Boolean(runEntry.instance)
    && !runEntry.inputReleased
    && !runEntry.abortRequested
    && !runEntry.silenced
    && !stoppingHandedOverTurn;

  // Ends a stopped handed-over turn that leaves no `result`: its prompt was
  // taken back before its turn started, or its result did not come in time.
  // The process is held for what it was held for before the hand-over;
  // what a turn of the CLI's own still running has started stays counted for
  // that turn's `result`.
  const endStoppedTurnWithoutResult = () => {
    const hold = handedOverHold;
    handedOverHold = null;
    const holdNow = backgroundWork.hasOutstanding(sessionKey())
      || turnStartedWorkToHold()
      || untrackedWorkHeld()
      || Boolean(hold && (hold.untracked || hold.relayPending));
    if (holdNow && !runEntry.inputReleased) {
      heldForBackgroundWork = true;
      armHoldIdleTimer();
      armHoldMaxTimer();
      restoreTurnSwitches();
    } else {
      heldForBackgroundWork = false;
      releaseInput('turn-stopped');
    }
  };

  // Stops a turn handed to the process while it was held for background work
  // (abortClaudeSDKSession), and only that turn: the work and the hold go
  // on, and a later send goes into the process as before. Unread inserts are
  // withdrawn first, and so is the turn's prompt when its turn has not
  // started (it waits behind a turn the CLI runs on its own, which goes on);
  // otherwise the turn is interrupted, which, with the per-task stop control
  // declared (declarePerTaskStopAffordance), stops nothing else. The
  // interrupted turn's `result` ends it without completing it (finishTurn),
  // and the stop waits up to INTERRUPT_REPLY_TIMEOUT_MS for it, so the next
  // send finds the process held again; then the turn is reported stopped
  // (reportAborted), and the abort's caller sends the terminal `complete`.
  // @returns {Promise<'stopped' | 'unanswered'>} `unanswered` when the CLI
  //   did not answer the interrupt in time: the caller stops the run whole
  const stopHandedOverTurn = async () => {
    stoppingHandedOverTurn = true;
    const stoppedTurnEnded = new Promise((resolve) => { settleStoppedTurn = resolve; });
    // A prompt that waited for the CLI's turn is never written, nor its
    // switches made.
    deferredHandOver = null;
    try {
      const { promptWithdrawn } = await runEntry.inserts.cancelAllForAbort();
      // A turn whose `result` came meanwhile has ended: an interrupt now
      // could only stop a turn the CLI runs on its own.
      if (!promptWithdrawn && handedOverHold && !runEntry.inputReleased) {
        let replied = false;
        const interruptReply = Promise.resolve(runEntry.instance.interrupt()).then(() => { replied = true; });
        await resolvesWithin(Promise.all([interruptReply, stoppedTurnEnded]), INTERRUPT_REPLY_TIMEOUT_MS);
        if (!replied) {
          return 'unanswered';
        }
      }
      if (handedOverHold) {
        endStoppedTurnWithoutResult();
      }
      stoppingHandedOverTurn = false;
      reportAborted();
      return 'stopped';
    } finally {
      stoppingHandedOverTurn = false;
      settleStoppedTurn = null;
    }
  };

  // Hoisted above the try so the catch's cleanup can tell whether this run
  // got as far as starting its CLI.
  let queryInstance = null;

  try {
    // A new turn takes the session over from any earlier run still holding it
    // (see retireSession), so held runs cannot stack up across a conversation,
    // and its own CLI starts only once the session's exiting process, if any,
    // has gone: the one it just retired, or one an earlier run retired or the
    // user aborted.
    if (sessionKey()) {
      registeredKey = sessionKey();
      addSession(registeredKey, runEntry);
      await waitForExitingProcess(registeredKey);
    }

    const resolvedModel = await context.resolveResumeModel(sessionId, options.model);
    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      providerSessionId,
      model: resolvedModel || options.model,
      effortModels: await loadEffortModels(context),
    });

    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }
    // What the CLI will run with, settings files included (see `launched`).
    const launchUltracode = await resolveEffectiveUltracode(sdkOptions);

    // Every turn uses streaming input so stdin stays open past the turn's
    // `result`. The message list is reusable, but each query attempt needs its
    // own stream because an async generator cannot be replayed once consumed.
    const promptMessages = await buildPromptMessages(command, options.images, options.files, options.cwd, firstPromptUuid);

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          // Notifications are app-facing, so they carry the app session id.
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: turnSessionName },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${sessionId || capturedSessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    sdkOptions.stderr = (data) => logCliStderr(sessionKey(), data);
    // Started as the SDK would, declaring the per-task stop control, so that
    // stopping a turn handed to a held process leaves its background agents
    // and workflows running (declarePerTaskStopAffordance).
    sdkOptions.spawnClaudeCodeProcess = (spawnOptions) => {
      const child = spawnClaudeCli(spawnOptions, sdkOptions.stderr);
      runEntry.processGone = new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
        } else {
          child.once('exit', () => resolve());
        }
      });
      return child;
    };

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      writer.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: turnSessionName },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${sessionId || capturedSessionId || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          // Keyed by the app session id so `chat.subscribe` can look pending
          // approvals up directly; provider id only for legacy callers.
          _sessionId: sessionId || capturedSessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          writer.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      // A client answered. Announce it on the run stream so the replay buffer
      // and every other attached tab drop the prompt — resolving happens over
      // the inbound socket only, so without this a mid-run page refresh
      // replays the `permission_request` with nothing to retract it and the
      // already-answered prompt resurrects.
      writer.send(createNormalizedMessage({ kind: 'permission_resolved', requestId, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    // An abort, or a newer run on the session, may have taken the key while
    // this run was starting. Its CLI is never started then, and the abort
    // (which reported the stop) and its caller, or the newer run, own the
    // client-facing events.
    if (registeredKey && getSession(registeredKey) !== runEntry) {
      return;
    }

    // The SDK's own `query`, unless the caller supplies one (tests script the
    // stream to drive the hold logic below without a CLI process).
    const createQuery = context.createQuery ?? query;
    let heldPrompt = createHeldPromptStream(promptMessages);
    releasePromptStream = heldPrompt.release;
    pushPrompt = heldPrompt.push;
    try {
      queryInstance = createQuery({
        prompt: heldPrompt.stream,
        options: sdkOptions
      });
    } catch (hookError) {
      // Older/newer SDK versions may not accept hook shapes yet.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
      delete sdkOptions.hooks;
      // Discard the abandoned stream and build a fresh one for the retry.
      heldPrompt.release();
      heldPrompt = createHeldPromptStream(promptMessages);
      releasePromptStream = heldPrompt.release;
      pushPrompt = heldPrompt.push;
      queryInstance = createQuery({
        prompt: heldPrompt.stream,
        options: sdkOptions
      });
    }

    // The entry now stands for a live process: abort and stop can reach it.
    runEntry.instance = queryInstance;
    runEntry.status = 'active';
    runEntry.startTime = Date.now();
    if (registeredKey) {
      // The history reader dates the live run by this start (see addSession).
      sessionHistoryCache.invalidate(registeredKey);
    }
    // Copied: canUseTool adds the tools the user allows for good to the live
    // options, but the CLI keeps the lists it was launched with.
    launched = {
      cwd: sdkOptions.cwd ?? null,
      allowedTools: [...sdkOptions.allowedTools],
      disallowedTools: [...sdkOptions.disallowedTools],
      effort: sdkOptions.effort ?? null,
      // What the CLI runs with: the launch's own choice, else the settings
      // files' (resolveEffectiveUltracode). A model switch keeps it.
      ultracode: launchUltracode,
      canBypass: sdkOptions.permissionMode === 'bypassPermissions',
      model: sdkOptions.model,
      permissionMode: sdkOptions.permissionMode ?? 'default',
      // As mapCliOptionsToSDK reads it.
      skipPermissions: Boolean(options.toolsSettings?.skipPermissions),
    };
    switchTrackers = {
      model: createSwitchTracker(launched.model),
      permissionMode: createSwitchTracker(launched.permissionMode),
    };
    liveSdkOptions = sdkOptions;

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    for await (const message of queryInstance) {
      // A newer run took the session over (retireSession), or the user
      // aborted this one. Whatever this process still says belongs to no one:
      // nothing is forwarded, tracked, notified or timed. The loop only waits
      // for the process to exit.
      if (runEntry.silenced) {
        // Except the session id of a brand-new session the user stopped
        // before its CLI reported it: the CLI still writes the prompt to that
        // session's transcript, which stays the app session's. A superseded
        // run's session id belongs to the newer run.
        if (runEntry.abortRequested && !capturedSessionId && typeof message.session_id === 'string') {
          capturedSessionId = message.session_id;
          if (typeof writer.setSessionId === 'function') {
            writer.setSessionId(capturedSessionId);
          }
        }
        // A turn the CLI starts once let go of (a task notification it had
        // queued, an agent the stops reached reporting back, a prompt it did
        // not give back) is closed with the process: nobody hears it, and
        // with the per-task stop control declared, an agent the stops missed
        // would keep the CLI up until its own ceiling. The interrupted turn's
        // own `result` and lifecycle end start nothing.
        if (
          runEntry.inputReleased
          && !runEntry.closed
          && ((message.type === 'system' && message.subtype === 'init')
            || (message.type === 'command_lifecycle' && message.state === 'started'))
        ) {
          console.log(`[Claude SDK] Session ${sessionKey() || 'NEW'}: the CLI started a turn after it was let go of; closing it`);
          closeRun(runEntry, sessionKey());
        }
        continue;
      }

      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        // A run started without any session key registers once it has one.
        if (!registeredKey) {
          registeredKey = sessionKey();
          addSession(registeredKey, runEntry);
        }

        // Set session ID on writer
        if (writer.setSessionId && typeof writer.setSessionId === 'function') {
          writer.setSessionId(capturedSessionId);
        }

        // Send session-created event only once for sessions with nothing to resume
        if (!providerSessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          writer.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
      }

      // The CLI runs one turn at a time, from its first sign (its init, a
      // command it starts, a main-thread message) to its `result`.
      if (message.type === 'result') {
        cliTurnActive = false;
      } else if (
        (message.type === 'system' && message.subtype === 'init')
        || (message.type === 'command_lifecycle' && message.state === 'started')
        || ((message.type === 'assistant' || message.type === 'user') && !message.parent_tool_use_id)
      ) {
        cliTurnActive = true;
      }
      if (message.type === 'command_lifecycle' && message.state === 'started') {
        noteCommandStarted(message);
      }
      // The CLI feeds a finished task's notification into a turn, which
      // relays it (see finishedOwnTaskIds).
      if (message.type === 'user' && message.isReplay === true && isTaskNotificationEcho(message)) {
        taskNotificationEchoedThisTurn = true;
        if (finishedOwnTaskIds.delete(readNotifiedTaskId(message))) {
          ownTaskRelayedThisTurn = true;
        }
      } else if (message.type === 'result') {
        noteUnechoedRelay(message);
      }

      // The CLI echoes back the prompts it takes (--replay-user-messages).
      // The client already shows the ones this run wrote, and the task
      // notifications the CLI feeds itself land on their cards, so those
      // echoes go no further; the insert controller reads its receipts off
      // them first. Any other echo, such as local command output, goes on.
      if (runEntry.inserts.observe(message)) {
        continue;
      }

      // A `result` for a batch of the CLI's own task notifications, not for
      // this run's prompt. On resume the CLI reports the background tasks the
      // previous process never finished, each in a batch of its own ahead of
      // the prompt, and such a batch ends in a `result` (with no model call,
      // `num_turns` 0, for an orphan; a revived queued notification runs a
      // real turn). Taking it for the turn's end would send `complete` seconds
      // in and close stdin under the prompt's real turn, which the CLI's
      // wind-down then charges to that turn's background work. Only `origin`
      // tells it apart: a 0-turn `result` can be the prompt's own (a local
      // command, a prompt a hook blocked). Once the prompt's turn has ended, a
      // task-notification `result` is background work reporting back and goes
      // on below. A CLI that sends no `origin` keeps the old behaviour.
      if (!promptResultSeen && message.type === 'result' && message.origin?.kind === 'task-notification') {
        console.log(`[Claude SDK] Session ${sessionKey() || 'NEW'}: skipped a result for the CLI's own task notifications (origin ${message.origin.kind}, num_turns ${message.num_turns})`);
        continue;
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = context.normalizeMessage(transformedMessage, sid);
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        if (isSubagentPromptEcho(msg)) {
          continue;
        }
        writer.send(msg);
      }

      if (
        message.type === 'assistant'
        && !message.parent_tool_use_id
        && typeof message.message?.model === 'string'
        && message.message.model !== '<synthetic>'
      ) {
        mainThreadModel = message.message.model;
      }

      // Only a turn's `result` states the window of the model that served it.
      const turnContextWindow = readReportedContextWindow(message, mainThreadModel);
      const contextWindowChanged = Boolean(turnContextWindow) && turnContextWindow !== reportedContextWindow;
      if (turnContextWindow) {
        reportedContextWindow = turnContextWindow;
        rememberClaudeContextWindow(message.session_id || capturedSessionId, turnContextWindow);
        if (contextWindowChanged && sessionKey()) {
          // A history page cached before this turn ended carries the old total.
          sessionHistoryCache.invalidate(sessionKey());
        }
      }

      // Extract and send token budget updates from assistant usage payloads,
      // falling back to the turn's cumulative bill only for SDK builds that
      // report no per-assistant usage at all.
      let tokenBudgetData = extractTokenBudget(message, reportedContextWindow)
        || (assistantBudgetSent ? null : extractCumulativeTokenBudget(message, reportedContextWindow));
      if (
        !tokenBudgetData
        && turnContextWindow
        && lastSentTokenBudget
        && lastSentTokenBudget.total !== turnContextWindow
      ) {
        // The reading stands; only the window it is measured against was wrong.
        tokenBudgetData = { ...lastSentTokenBudget, total: turnContextWindow };
      }
      if (tokenBudgetData) {
        if (message.type === 'assistant') {
          assistantBudgetSent = true;
        }
        lastSentTokenBudget = tokenBudgetData;
        writer.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }

      if (startsBackgroundTasks(message)) {
        backgroundWorkPending = true;
      }
      if (message.type === 'assistant' && !message.parent_tool_use_id) {
        noteUntrackedWorkCalls(message);
      } else if (message.type === 'user' && !message.parent_tool_use_id) {
        noteSchedulingResults(message);
      }
      // Only tasks the tracker follows count. A housekeeping task the CLI
      // starts on its own has no tool_use_id, and would otherwise hand the hold
      // decision to a tracker with nothing in it.
      if (message.type === 'system' && message.subtype === 'task_started' && typeof message.tool_use_id === 'string') {
        sawTaskEventThisTurn = true;
        monitorCallsAwaitingTask.delete(message.tool_use_id);
      }
      // Only the run that owns the session key feeds its tracker: its tasks
      // must never land among those of another run on the session, where an
      // own task would keep that run's process held through every silence.
      // (A superseded or aborted run is silenced before it gets here.)
      if (!registeredKey || getSession(registeredKey) === runEntry) {
        noteOwnTaskFinished(message);
        backgroundWork.apply(sessionKey(), message);
      }

      // A task the user stopped gets no follow-up turn from the CLI — only its
      // `stopped` notification — so when that was the last outstanding task
      // nothing will ever push the `result` the release below waits for, and
      // the process would sit until the idle ceiling. Release it here, unless
      // the process is still held for work no task reports (a loop's next
      // wake-up, a cron job). A completed task is different: the CLI relays
      // its result in a turn of its own, which closing stdin now would cut
      // short.
      if (
        heldForBackgroundWork
        && !untrackedWorkHeld()
        && message.type === 'system'
        && message.subtype === 'task_notification'
        && message.status === 'stopped'
        && !backgroundWork.hasOutstanding(sessionKey())
      ) {
        heldForBackgroundWork = false;
        releaseInput('task-stopped');
      }

      // A task the hand-over found outstanding finished during a handed-over
      // turn. The CLI relays it in a turn queued behind that turn's prompt,
      // so that turn's end must not close stdin. A stopped task is relayed
      // in no turn.
      if (
        handedOverHold
        && message.type === 'system'
        && message.subtype === 'task_notification'
        && handedOverHold.taskIds.delete(message.task_id)
        && message.status !== 'stopped'
      ) {
        handedOverHold.relayPending = true;
      }

      if (message.type === 'result') {
        if (
          handedOverHold
          && !runEntry.abortRequested
          && runEntry.inserts.isAheadOfHandedOverPrompt(message)
        ) {
          // Ahead of a handed-over prompt, the CLI ran a turn of its own:
          // relaying background work that finished before the hand-over, or
          // a wake-up or scheduled task firing. Not the handed-over turn,
          // which neither completes nor takes inserts on it. A prompt that
          // waited for that turn to end goes out now.
          onWorkReportedAheadOfTurn(message);
          writeDeferredHandOver();
          continue;
        }
        promptResultSeen = true;
        // Inserts the CLI has not read yet run as the next turn of this same
        // process, so the turn goes on: no `complete`, no release, and the
        // background work this turn started still counts at the end. While
        // an abort or a stop is under way nothing is held back, but an
        // insert read from now on started the next turn all the same.
        let heldBack = false;
        if (!turnCompleteSent) {
          if (runEntry.abortRequested || stoppingHandedOverTurn) {
            runEntry.inserts.noteTurnEnded();
          } else {
            heldBack = runEntry.inserts.deferTurnEnd(message);
          }
        }
        if (!heldBack) {
          finishTurn(message);
        }
      } else {
        if (holdIdleTimer) {
          // Background activity after the turn — push the countdown back out.
          armHoldIdleTimer();
        }
        if (holdMaxTimer && message.type === 'assistant' && !message.parent_tool_use_id) {
          // A follow-up turn is under way: the held work is still reporting.
          armHoldMaxTimer();
        }
      }
    }

    // Clean up session on completion — only while this run still owns the map
    // entry. A superseding run may have replaced it, and deleting here would
    // strand that run.
    if (registeredKey && getSession(registeredKey) === runEntry) {
      removeSession(registeredKey);
    }

    // The process is gone: inserts it never read never will be. (A silenced
    // run has reported its own; an abort still under way reports them.)
    if (!runEntry.silenced && !runEntry.abortRequested) {
      runEntry.inserts.failAll('RUN_ENDED');
    }

    // A silenced run winds down without a word: the run that took the session
    // over, or the abort and its caller, own the client-facing events. Nor
    // does a run whose `result` already completed the turn. Otherwise the
    // loop ended before the turn completed: a run the user is aborting
    // reports the stop (the abort's caller sends the terminal `complete`, with
    // aborted: true), any other sends the terminal `complete` itself.
    if (!turnCompleteSent && !runEntry.silenced) {
      if (runEntry.abortRequested) {
        reportAborted();
      } else {
        turnCompleteSent = true;
        writer.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
        notifyRunStopped({
          userId: writer?.userId || null,
          provider: 'claude',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: turnSessionName,
          stopReason: 'completed',
          runStartedAt: writer?.runStartedAt ?? null
        });
      }
    }
    // Complete

  } catch (error) {
    console.error('SDK query error:', error);

    // Clean up session on error — only while this run still owns the map entry
    // (a superseding run may have replaced it).
    const ownedKey = Boolean(registeredKey) && getSession(registeredKey) === runEntry;
    if (ownedKey) {
      removeSession(registeredKey);
    }

    if (runEntry.silenced) {
      // Superseded or aborted: the newer run, or the abort and its caller,
      // own all further client-facing events.
      return;
    }

    if (registeredKey && !ownedKey && !queryInstance) {
      // Aborted, or taken over by a newer run, before its CLI started: the
      // abort and its caller, or that run, own the client-facing events.
      return;
    }

    if (runEntry.abortRequested) {
      // A throw while the abort is under way, such as the one interrupt()
      // causes, is expected noise, not a user-facing error. The abort's
      // caller sends the terminal complete.
      reportAborted();
      return;
    }

    // Ahead of the error and the terminal complete.
    runEntry.inserts.failAll('RUN_FAILED');

    // Check if Claude CLI is installed for a clearer error message
    const installed = await context.isProviderInstalled();
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : error.message;

    // Send error to WebSocket, then the terminal complete. A run that already
    // reported completion and then failed during its post-turn hold still
    // surfaces the error, but must not emit a second terminal complete.
    writer.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    if (!turnCompleteSent) {
      writer.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    }
    notifyRunFailed({
      userId: writer?.userId || null,
      provider: 'claude',
      sessionId: sessionId || capturedSessionId || null,
      sessionName: turnSessionName,
      error,
      runStartedAt: writer?.runStartedAt ?? null
    });
  } finally {
    if (abandonedCloseTimer) {
      clearTimeout(abandonedCloseTimer);
      abandonedCloseTimer = null;
    }
    runEntry.inserts.dispose();
    // Always close stdin — otherwise an aborted or failed run leaves the CLI
    // process (and its MCP servers) alive until the server exits.
    releaseInput('loop-end');
    // An exiting entry leaves exitingSessions once its process is gone. A loop
    // that ended on its own has seen the process exit; a closed query's loop
    // ends seconds before the SDK kills the process, so a closed entry stays
    // until its `closed` settles, and a run that arrives meanwhile still waits
    // for it. Only this run's own entry is removed: a newer one may hold the
    // key by then.
    if (registeredKey && exitingSessions.get(registeredKey) === runEntry) {
      const exitingKey = registeredKey;
      const leaveExitingSessions = () => {
        if (exitingSessions.get(exitingKey) === runEntry) {
          exitingSessions.delete(exitingKey);
        }
      };
      if (runEntry.closed) {
        void runEntry.closed.then(leaveExitingSessions);
      } else {
        leaveExitingSessions();
      }
    }
    // A handed-over turn the loop ended under is over too, and a stop of it
    // waits no longer for its `result`.
    settleTurn();
    settleStoppedTurn?.();
    markExited();
  }
}

/**
 * Aborts an active SDK session.
 *
 * A run still starting (waiting for an exiting process, or loading its
 * settings) is only marked: it stands down before spawning its CLI. So is a
 * turn still on its way into a held process (pendingHandOvers), which leaves
 * that process and its background work alone. A turn that went into a
 * process held for background work is stopped alone (stopHandedOverTurn):
 * the work and the hold go on, unless the CLI does not answer the interrupt
 * within INTERRUPT_REPLY_TIMEOUT_MS, which closes the process. Any other
 * live process first has its
 * unread inserts, and a handed-over prompt it has not started, withdrawn,
 * waiting up to INSERT_ABORT_CANCEL_WAIT_MS for the CLI to confirm, and every
 * insert is reported cancelled. It is then interrupted and told to stop its
 * outstanding tasks while its input is still held, then let go; it is closed
 * instead when the CLI does not answer the interrupt within
 * INTERRUPT_REPLY_TIMEOUT_MS, or at once when its input is already released
 * and the requests could be dropped. From then
 * on its loop is silenced, and the entry stays in exitingSessions until the
 * process is gone (see exitingSessions), so the session's next run waits for
 * it. Once stdin has closed the CLI usually exits at once; one that starts a
 * turn after the interrupt (a queued task notification, an agent the stops
 * reached reporting back) is closed as that turn starts (see the silenced
 * branch of queryClaudeSDK's loop): with the per-task stop control declared,
 * the interrupt spares background agents and workflows, so one that started
 * too late to be in the stops would otherwise keep it running.
 *
 * The run's one stop report (`aborted`) goes out from here; the caller sends
 * the terminal `complete`.
 * @param {string} sessionId - Session identifier
 * @returns {Promise<boolean>} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId) {
  const pendingHandOver = pendingHandOvers.get(sessionId);
  if (pendingHandOver) {
    console.log(`Aborting a turn on its way into the held process of session ${sessionId}`);
    pendingHandOvers.delete(sessionId);
    pendingHandOver.abort();
    return true;
  }

  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  if (!session.instance) {
    console.log(`Aborting SDK session before its CLI started: ${sessionId}`);
    session.status = 'aborted';
    removeSession(sessionId);
    session.reportAborted();
    return true;
  }

  if (session.stopsTurnOnly()) {
    try {
      console.log(`Stopping the turn handed to the held process of session ${sessionId}; its background work goes on`);
      if (await session.stopHandedOverTurn() === 'stopped') {
        return true;
      }
    } catch (error) {
      console.error(`Error stopping the handed-over turn of session ${sessionId}:`, error);
      // The turn goes on and completes on its own.
      return false;
    }
    // A CLI that does not answer the interrupt is stopped whole.
    console.warn(`[Claude SDK] Session ${sessionId}: no reply to the interrupt within ${INTERRUPT_REPLY_TIMEOUT_MS} ms; closing the process`);
    session.abortRequested = true;
    closeRun(session, sessionId);
    letGoOfAbortedRun(session, sessionId);
    return true;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Marked before interrupting: a `result` that lands meanwhile is the
    // interrupted turn's, and the run loop must not complete the turn on it.
    // It also stops the run taking or writing inserts.
    session.abortRequested = true;

    // Inserts the CLI has not read, and a handed-over prompt it has not
    // started, go first: it keeps queued messages across an interrupt and
    // runs them once it is handled.
    if (!session.inputReleased && session.inserts.needsWithdrawalOnAbort()) {
      await session.inserts.cancelAllForAbort();
    }

    // Checked after that wait too: the turn may have ended and let go of the
    // input meanwhile.
    if (session.inputReleased) {
      closeRun(session, sessionId);
    } else {
      // Like retireSession: the stops are written right behind the interrupt,
      // while stdin is open, as the SDK drops control requests written after
      // it has ended. Left running, the tasks would keep the CLI, and its
      // writes to the transcript, going after the release.
      const outstanding = backgroundWork.outstanding(sessionId);
      const interruptReply = session.instance.interrupt();
      for (const task of outstanding) {
        sendStopTask(session.instance, task.taskId);
      }
      if (!await resolvesWithin(interruptReply, INTERRUPT_REPLY_TIMEOUT_MS)) {
        console.warn(`[Claude SDK] Session ${sessionId}: no reply to the interrupt within ${INTERRUPT_REPLY_TIMEOUT_MS} ms; closing the process`);
        closeRun(session, sessionId);
      }
    }

    letGoOfAbortedRun(session, sessionId);
    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    session.abortRequested = false;
    return false;
  }
}

/**
 * The end of an abort that stops a run whole (abortClaudeSDKSession), once
 * its process has been told to stop or closed: its input is released, as
 * without it the CLI stays up for the rest of the post-turn hold, its loop is
 * silenced, it leaves the session for exitingSessions until its process is
 * gone, and it reports the stop.
 * @param {Object} session - The run's entry (see `runEntry` in queryClaudeSDK)
 * @param {string} sessionId - Session key
 */
function letGoOfAbortedRun(session, sessionId) {
  session.releaseInput('aborted');
  session.status = 'aborted';
  session.silenced = true;

  // The process is on its way out, unless its loop has ended while the
  // interrupt was pending, or a newer run took the key (and put the entry
  // in exitingSessions itself).
  if (getSession(sessionId) === session) {
    removeSession(sessionId);
    exitingSessions.set(sessionId, session);
  }

  session.reportAborted();
}

/**
 * Sessions whose background tasks are still outstanding, with the tasks.
 *
 * A session stays here after its turn's `result` for as long as the process
 * is held open for the work — which is exactly the window in which nothing
 * else (the chat run registry marks the run completed at `result`) knows the
 * session is still busy.
 * @returns {Array<{ sessionId: string, tasks: Array<import('@/shared/types.js').BackgroundTaskSummary> }>}
 */
function listClaudeSDKBackgroundWork() {
  return backgroundWork.list();
}

/**
 * Stops one outstanding background task through the SDK, which then emits a
 * `task_notification` with status `stopped` — the same event that drops the
 * task from the tracker and settles its card. That notification is the real
 * outcome: the reply to the request is waited for STOP_TASK_REPLY_TIMEOUT_MS
 * at most.
 * @param {string} sessionId - Session identifier
 * @param {string} taskId - The task's `task_id` as reported on `task_started`
 * @returns {Promise<boolean>} False when no live process is tracking the task,
 *   or when the process's input is released and the request could be dropped
 */
async function stopClaudeSDKTask(sessionId, taskId) {
  const session = getSession(sessionId);
  if (!session?.instance || session.inputReleased || !backgroundWork.has(sessionId, taskId)) {
    return false;
  }
  await resolvesWithin(session.instance.stopTask(taskId), STOP_TASK_REPLY_TIMEOUT_MS);
  return true;
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return Boolean(session && session.status === 'active');
}

/**
 * When the run behind a session started, or null when no run is up.
 *
 * The history reader uses this to tell a background agent launched by the
 * live process (still able to report back) from one launched by an earlier
 * process that has since exited (never will): a launch row older than the
 * live run cannot belong to it.
 * @param {string} sessionId - Session identifier
 * @returns {number|null} Epoch milliseconds the live run started, or null
 */
function getClaudeSDKSessionStartTime(sessionId) {
  const session = getSession(sessionId);
  return session && session.status === 'active' ? session.startTime : null;
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

/**
 * Writes a user message into the session's running turn (see
 * createInsertController and `IProviderRuntime.insert`): reported `pending`
 * through the run's writer at once, then written to the CLI when it is its
 * turn.
 * @param {string} sessionId - Session key (the app session id for a chat run)
 * @param {{ insertId: string, content: string }} input - The insert: a UUID the
 *   CLI records the message under, and plain text
 * @returns {Promise<{ accepted: true } | { accepted: false, reason: 'NO_ACTIVE_RUN' | 'INVALID' | 'DUPLICATE' }>}
 *   NO_ACTIVE_RUN when no turn is under way: the CLI has not started, the turn
 *   has completed (background work may still run), or it is being aborted
 */
async function insertIntoClaudeSDKSession(sessionId, input) {
  if (!isValidInsertInput(input)) {
    return { accepted: false, reason: 'INVALID' };
  }
  const session = getSession(sessionId);
  if (!session) {
    return { accepted: false, reason: 'NO_ACTIVE_RUN' };
  }
  return session.inserts.accept(input);
}

/**
 * Withdraws an insert the model has not read yet (see
 * `IProviderRuntime.cancelInsert`).
 * @param {string} sessionId - Session key
 * @param {string} insertId - The insert's id
 * @returns {Promise<{ status: 'cancelled' | 'cancel_failed' | 'not_found' }>}
 *   `cancelled` once the run has reported it so; `cancel_failed` when the CLI
 *   kept it; `not_found` when the session's run does not hold it, or it has
 *   already ended
 */
async function cancelClaudeSDKInsert(sessionId, insertId) {
  const session = getSession(sessionId);
  if (!session || typeof insertId !== 'string') {
    return { status: 'not_found' };
  }
  return session.inserts.cancel(insertId);
}

/**
 * Whether a process of this server still holds the session (see
 * `IProviderRuntime.processState`). `running` while a run owns the key: from
 * its start, still waiting for an exiting process or loading its settings,
 * through its turn and any hold for background work. `exiting` once that
 * run has released the CLI's input, until its loop ends, and while a
 * retired, aborted or abandoned run's process winds down (exitingSessions).
 * Null when neither applies.
 * @param {string} sessionKey - Session key (the app session id for a chat run)
 * @returns {'running' | 'exiting' | null}
 */
function getClaudeSDKProcessState(sessionKey) {
  const entry = getSession(sessionKey);
  if (entry) {
    return entry.inputReleased ? 'exiting' : 'running';
  }
  return exitingSessions.has(sessionKey) ? 'exiting' : null;
}

/**
 * Lets go of the session for a CLI the Shell tab is about to start on it (see
 * `IProviderRuntime.release`): the run holding it is retired the way a newer
 * run would take it over (its turn interrupted, its outstanding tasks stopped,
 * its input released; see retireSession), and the promise resolves once its
 * process, or any other of the session's on its way out, is gone
 * (waitForExitingProcess). Resolves at once when nothing holds the session.
 * @param {string} sessionKey - Session key (the app session id for a chat run)
 * @returns {Promise<void>}
 */
async function releaseClaudeSDKSession(sessionKey) {
  retireSession(sessionKey, 'shell-takeover');
  await waitForExitingProcess(sessionKey);
}

/**
 * The Claude provider's runtime (`IProviderRuntime`), mounted by
 * claude.provider.ts; the provider runtime gateway reaches every entry
 * through it.
 */
export const claudeRuntime = {
  run: queryClaudeSDK,
  abort: abortClaudeSDKSession,
  permissions: {
    resolve: resolveToolApproval,
    listPending: getPendingApprovalsForSession,
  },
  listBackgroundWork: listClaudeSDKBackgroundWork,
  stopBackgroundTask: stopClaudeSDKTask,
  insert: insertIntoClaudeSDKSession,
  cancelInsert: cancelClaudeSDKInsert,
  processState: getClaudeSDKProcessState,
  release: releaseClaudeSDKSession,
  planHandOver: planClaudeSDKHandOver,
};

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  listClaudeSDKBackgroundWork,
  stopClaudeSDKTask,
  isClaudeSDKSessionActive,
  getClaudeSDKSessionStartTime,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  extractTokenBudget,
  extractCumulativeTokenBudget
};
