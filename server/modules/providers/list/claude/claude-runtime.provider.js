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
// newer run took the session from (retireSession), or one the user aborted. An
// entry stays until its message loop ends, or, once its query is closed, until
// its `closed` settles: closing ends the loop seconds before the SDK kills the
// process (see closeRun). The session's next run waits for it before starting
// a CLI of its own (waitForExitingProcess), whichever run did the retiring or
// aborting, so two processes never append to one transcript.
const exitingSessions = new Map();

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
// command emits nothing until it ends, so silence proves nothing about it. A
// hold kept only for nested tasks, or for Monitor, ScheduleWakeup, CronCreate
// or TaskCreate, ends here.
//
// HOLD_MAX_MS: the backstop for tasks that never report. Pushed back by every
// `result` and every main-thread assistant message during the hold; when it
// runs out the outstanding tasks are stopped and stdin is closed.
const { idleMs: HOLD_IDLE_MS, maxMs: HOLD_MAX_MS } = resolveHoldDurations(process.env);
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
// after that. So the second wait is a plain timer (see closeRun) that outlasts
// that schedule.
const RETIRED_EXIT_WAIT_MS = 15 * 1000;
const RETIRED_CLOSE_WAIT_MS = 8 * 1000;
// How long abort waits for the CLI to answer an interrupt before closing it.
const INTERRUPT_REPLY_TIMEOUT_MS = 5 * 1000;
// How long a stop request waits for its reply. The task's `stopped`
// notification is the real outcome either way.
const STOP_TASK_REPLY_TIMEOUT_MS = 5 * 1000;

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
 * appending to the same transcript, alive for up to CLI_BG_WAIT_GRACE_MS.
 * Nothing is awaited; each request is written before this returns. A process
 * whose input is already released is sent nothing, as the requests would be
 * dropped.
 * @param {string} sessionKey - Session key
 */
function retireSession(sessionKey) {
  const entry = activeSessions.get(sessionKey);
  if (!entry) {
    return;
  }
  // Read before removeSession forgets them.
  const outstanding = backgroundWork.outstanding(sessionKey);
  removeSession(sessionKey);

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
  entry.releaseInput('superseded');
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
 * @returns {Promise<void>} The entry's `closed`: settles RETIRED_CLOSE_WAIT_MS
 *   after the first close
 */
function closeRun(entry, sessionKey) {
  if (!entry.closed) {
    closeQuery(entry.instance, sessionKey);
    entry.closed = new Promise((resolve) => {
      setTimeout(resolve, RETIRED_CLOSE_WAIT_MS).unref?.();
    });
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
// reports back in a later turn.
const DEFERRED_WORK_TOOLS = new Set(['Monitor', 'ScheduleWakeup', 'CronCreate', 'TaskCreate', 'Workflow']);

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
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((block) => {
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
    return DEFERRED_WORK_TOOLS.has(block.name);
  });
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
 * @returns {Promise<Array<Object>>} SDKUserMessage records for the turn
 */
async function buildPromptMessages(command, images, files, cwd) {
  const promptWithFiles = appendFilesInputTag(command, files);
  const content = normalizeImageDescriptors(images).length === 0
    ? promptWithFiles
    : await buildClaudeUserContent(promptWithFiles, images, cwd);

  return [{
    type: 'user',
    message: {
      role: 'user',
      content
    },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString()
  }];
}

/**
 * Wraps prompt messages in an async iterable that yields them and then parks.
 *
 * The SDK closes the CLI's stdin as soon as its input iterable is exhausted (and
 * immediately on `result` for string prompts). The CLI reads that EOF as the end
 * of the run and kills anything still going in the background, so the iterable
 * has to stay pending until we actually want the process gone.
 *
 * @param {Array<Object>} messages - SDKUserMessage records to send
 * @returns {{ stream: AsyncIterable, release: () => void }} Stream plus its closer
 */
function createHeldPromptStream(messages) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });

  const stream = (async function* () {
    for (const message of messages) {
      yield message;
    }
    // Keeps stdin open — the CLI stays alive until release() is called.
    await held;
  })();

  return { stream, release };
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

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @param {Object} context - Provider-scoped model, session, and auth lookups
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws, context) {
  const { sessionId, sessionSummary } = options;
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

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    });
  };

  // Ends the held prompt stream. Replaced once the stream exists; only
  // releaseInput below calls it for the live stream.
  let releasePromptStream = () => {};
  // The post-turn hold's silence countdown (HOLD_IDLE_MS) and its backstop
  // (HOLD_MAX_MS). Both run only while the process is held for background work.
  let holdIdleTimer = null;
  let holdMaxTimer = null;
  // Closes the process if it is still up ABANDONED_PROCESS_CLOSE_MS after its
  // input was released.
  let abandonedCloseTimer = null;
  // The client is told the turn is over as soon as `result` lands, even though
  // the process lingers, so the UI never waits out the idle hold.
  let turnCompleteSent = false;
  // Set when a turn starts background work, cleared when the next `result`
  // arrives — only turns with work still outstanding hold their process open.
  let backgroundWorkPending = false;
  // Set when the stream reports a task starting during this turn. Task events
  // are the exact word on what is still running, so when the turn produced
  // any, the tracker decides the hold; `startsBackgroundWork` is the fallback
  // for tools that emit none (Monitor, ScheduleWakeup, CronCreate, TaskCreate)
  // and for an SDK that does not report tasks at all.
  let sawTaskEventThisTurn = false;
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
    releaseInput: (reason) => releaseInput(reason),
    reportAborted: () => reportAborted(),
  };
  // The key runEntry is registered under. A session key never changes once known.
  let registeredKey = null;

  // The run's one report that the user stopped it. Sent by
  // abortClaudeSDKSession, or by the run itself when its loop ends while the
  // abort is still under way, whichever comes first; never for a turn that
  // has already completed. The abort's caller sends the terminal `complete`.
  const reportAborted = () => {
    if (turnCompleteSent) {
      return;
    }
    turnCompleteSent = true;
    notifyRunStopped({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: sessionId || capturedSessionId || null,
      sessionName: sessionSummary,
      stopReason: 'aborted',
      runStartedAt: ws?.runStartedAt ?? null
    });
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
  };

  // Closes the held prompt stream so the CLI can wind down, once, and logs why.
  // Ends the hold too: nothing is held for after this. The CLI should then
  // exit on its own; one still up ABANDONED_PROCESS_CLOSE_MS later is closed.
  const releaseInput = (reason) => {
    clearHoldTimers();
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
    // command emits nothing until it ends. HOLD_MAX bounds those.
    if (backgroundWork.hasOwnOutstanding(sessionKey())) {
      armHoldIdleTimer();
      return;
    }
    heldForBackgroundWork = false;
    releaseInput('idle');
  };
  const armHoldIdleTimer = () => {
    if (holdIdleTimer) {
      clearTimeout(holdIdleTimer);
    }
    holdIdleTimer = setTimeout(onHoldIdle, HOLD_IDLE_MS);
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
    holdMaxTimer = setTimeout(onHoldMax, HOLD_MAX_MS);
    holdMaxTimer.unref?.();
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
    let effortModels = CLAUDE_PREDEFINED_MODELS;
    try {
      effortModels = await context.getProviderModels();
    } catch (error) {
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      providerSessionId,
      model: resolvedModel || options.model,
      effortModels,
    });

    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // Every turn uses streaming input so stdin stays open past the turn's
    // `result`. The message list is reusable, but each query attempt needs its
    // own stream because an async generator cannot be replayed once consumed.
    const promptMessages = await buildPromptMessages(command, options.images, options.files, options.cwd);

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
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${sessionId || capturedSessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    sdkOptions.stderr = (data) => logCliStderr(sessionKey(), data);

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
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
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
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
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
      ws.send(createNormalizedMessage({ kind: 'permission_resolved', requestId, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));

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
          if (typeof ws.setSessionId === 'function') {
            ws.setSessionId(capturedSessionId);
          }
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
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // Send session-created event only once for sessions with nothing to resume
        if (!providerSessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
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
      // command, a prompt a hook blocked). Once the turn has completed, a
      // task-notification `result` is background work reporting back and goes
      // on below. A CLI that sends no `origin` keeps the old behaviour.
      if (!turnCompleteSent && message.type === 'result' && message.origin?.kind === 'task-notification') {
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
        ws.send(msg);
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
        ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }

      if (startsBackgroundWork(message)) {
        backgroundWorkPending = true;
      }
      // Only tasks the tracker follows count. A housekeeping task the CLI
      // starts on its own has no tool_use_id, and would otherwise hand the hold
      // decision to a tracker with nothing in it, dropping the hold a Monitor
      // started in the same turn needs.
      if (message.type === 'system' && message.subtype === 'task_started' && typeof message.tool_use_id === 'string') {
        sawTaskEventThisTurn = true;
      }
      // Only the run that owns the session key feeds its tracker: its tasks
      // must never land among those of another run on the session, where an
      // own task would keep that run's process held through every silence.
      // (A superseded or aborted run is silenced before it gets here.)
      if (!registeredKey || getSession(registeredKey) === runEntry) {
        backgroundWork.apply(sessionKey(), message);
      }

      // A task the user stopped gets no follow-up turn from the CLI — only its
      // `stopped` notification — so when that was the last outstanding task
      // nothing will ever push the `result` the release below waits for, and
      // the process would sit until the idle ceiling. Release it here. A
      // completed task is different: the CLI relays its result in a turn of
      // its own, which closing stdin now would cut short.
      if (
        heldForBackgroundWork
        && message.type === 'system'
        && message.subtype === 'task_notification'
        && message.status === 'stopped'
        && !backgroundWork.hasOutstanding(sessionKey())
      ) {
        heldForBackgroundWork = false;
        releaseInput('task-stopped');
      }

      if (message.type === 'result') {
        // The turn is done as far as the client is concerned, unless the user
        // is aborting it: then this is the interrupted turn's `result`.
        const abortPending = runEntry.abortRequested;
        const stillOutstanding = backgroundWork.hasOutstanding(sessionKey());
        let releaseReason = 'background-done';
        if (!turnCompleteSent && !abortPending) {
          turnCompleteSent = true;
          releaseReason = 'turn-done';
          if (message.num_turns === 0 && message.origin === undefined) {
            // The prompt's own model-free turn (a local command, a prompt a
            // hook blocked). Logged because an orphan batch from a CLI that
            // stopped sending `origin` looks just like it, and would end the
            // turn early again.
            console.log(`[Claude SDK] Session ${sessionKey() || 'NEW'}: a result with num_turns 0 and no origin ended the turn`);
          }
          ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
          notifyRunStopped({
            userId: ws?.userId || null,
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            sessionName: sessionSummary,
            stopReason: 'completed',
            runStartedAt: ws?.runStartedAt ?? null
          });
        } else if (heldForBackgroundWork && !abortPending && !stillOutstanding) {
          // A result after the turn already reported complete means the work we
          // held the process open for has finished and pushed a follow-up turn
          // — the last of it, when nothing else is still running.
          notifyBackgroundWorkCompleted({
            userId: ws?.userId || null,
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            sessionName: sessionSummary,
            runStartedAt: ws?.runStartedAt ?? null
          });
          ws.reportBackgroundWorkFinished?.();
        }
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
        // When the turn reported its tasks, the tracker is the whole truth: an
        // Agent call without `run_in_background` is scored as background by
        // `startsBackgroundWork`, but the CLI runs it in the foreground and
        // it has settled before this `result` — holding for it kept a process
        // alive for the full ceiling with nothing outstanding.
        //
        // An input already released (the hold ran out, or an abort) is never
        // held again.
        const holdForTurn = sawTaskEventThisTurn ? stillOutstanding : backgroundWorkPending || stillOutstanding;
        backgroundWorkPending = false;
        sawTaskEventThisTurn = false;
        if (holdForTurn && !runEntry.inputReleased) {
          heldForBackgroundWork = true;
          armHoldIdleTimer();
          armHoldMaxTimer();
        } else {
          // Either nothing was backgrounded, or the background work just
          // reported in — let the CLI exit now, as it always has.
          heldForBackgroundWork = false;
          releaseInput(abortPending ? 'aborted' : releaseReason);
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
        ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'claude',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          stopReason: 'completed',
          runStartedAt: ws?.runStartedAt ?? null
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

    // Check if Claude CLI is installed for a clearer error message
    const installed = await context.isProviderInstalled();
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : error.message;

    // Send error to WebSocket, then the terminal complete. A run that already
    // reported completion and then failed during its post-turn hold still
    // surfaces the error, but must not emit a second terminal complete.
    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    if (!turnCompleteSent) {
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    }
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: sessionId || capturedSessionId || null,
      sessionName: sessionSummary,
      error,
      runStartedAt: ws?.runStartedAt ?? null
    });
  } finally {
    if (abandonedCloseTimer) {
      clearTimeout(abandonedCloseTimer);
      abandonedCloseTimer = null;
    }
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
    markExited();
  }
}

/**
 * Aborts an active SDK session.
 *
 * A run still starting (waiting for an exiting process, or loading its
 * settings) is only marked: it stands down before spawning its CLI. A live
 * process is interrupted and told to stop its outstanding tasks while its
 * input is still held, then let go; it is closed instead when the CLI does
 * not answer the interrupt within INTERRUPT_REPLY_TIMEOUT_MS, or at once when
 * its input is already released and the requests could be dropped. From then
 * on its loop is silenced, and the entry stays in exitingSessions until the
 * process is gone (see exitingSessions), so the session's next run waits for
 * it. Once stdin has closed the CLI usually exits at once; a turn it starts
 * after the interrupt (a queued task notification, a Monitor event) can keep
 * it up longer, until the session's next run or ABANDONED_PROCESS_CLOSE_MS
 * closes it.
 *
 * The run's one stop report (`aborted`) goes out from here; the caller sends
 * the terminal `complete`.
 * @param {string} sessionId - Session identifier
 * @returns {Promise<boolean>} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId) {
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

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Marked before interrupting: a `result` that lands meanwhile is the
    // interrupted turn's, and the run loop must not complete the turn on it.
    session.abortRequested = true;

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

    // Release the held stdin stream; without this the CLI stays up for the rest
    // of the post-turn hold even though the user cancelled.
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
    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    session.abortRequested = false;
    return false;
  }
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

export const claudeRuntime = {
  run: queryClaudeSDK,
  abort: abortClaudeSDKSession,
  permissions: {
    resolve: resolveToolApproval,
    listPending: getPendingApprovalsForSession,
  },
  listBackgroundWork: listClaudeSDKBackgroundWork,
  stopBackgroundTask: stopClaudeSDKTask,
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
