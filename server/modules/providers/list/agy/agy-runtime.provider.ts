/**
 * Antigravity CLI (`agy`) runtime adapter.
 *
 * Every turn is one `agy -p <prompt> --output-format stream-json` process.
 * Its stdout is NDJSON (`init`, `step_update`, `result`); step updates are
 * mapped to chat messages by the agy sessions provider's `normalizeMessage`
 * (reached through the runtime context), so live rows and history rows share
 * one mapping. This adapter owns what a stateless mapping cannot: binding a
 * new chat to agy's conversation id, pairing tool steps, the token budget,
 * error reporting, the single terminal `complete`, and stopping the whole
 * process group on abort.
 */

import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import crossSpawn from 'cross-spawn';

import { findAgyConversationRoot, isLegacyAgyRoot } from '@/modules/providers/list/agy/agy-store.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { isAgyConversationId, isAgyOauthTokenPresent, resolveAgyCliPath } from '@/shared/agy-cli-path.js';
import { normalizeAttachmentDescriptors } from '@/shared/image-attachments.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type {
  AgyStepUpdate,
  AgyStreamEvent,
  AgyUsage,
  AnyRecord,
  NormalizedMessage,
  ProviderModelsDefinition,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import {
  buildAgyTokenUsage,
  createCompleteMessage,
  createNormalizedMessage,
  readObjectRecord,
  readOptionalString,
  stripAnsiSequences,
} from '@/shared/utils.js';

/** The payload of agy's final `result` event. */
type AgyResultPayload = NonNullable<Extract<AgyStreamEvent, { event: 'result' }>['result']>;

/**
 * One turn in flight, keyed by app session id in `activeAgyRuns`. `child` is
 * null until the process is spawned, so an abort that lands while the turn is
 * still resolving its model stops it before anything starts.
 */
type ActiveAgyRun = {
  child: ChildProcess | null;
  aborted: boolean;
  /** Settles once the turn is over: the process closed, or it never started. */
  finished: Promise<void>;
  markFinished: () => void;
};

const activeAgyRuns = new Map<string, ActiveAgyRun>();

/**
 * How long after an abort's SIGTERM agy's process group gets SIGKILL, whether
 * or not agy itself has exited by then.
 */
const AGY_ABORT_KILL_DELAY_MS = 5_000;
/** How long an abort still waits for the process to close after SIGKILL. */
const AGY_ABORT_SETTLE_GRACE_MS = 2_000;
/**
 * How long agy's stdout/stderr may stay open after agy itself exited. A
 * helper it started (a language server, say) can inherit the pipes and hold
 * them open indefinitely; the turn must still finish.
 */
const AGY_EXIT_CLOSE_GRACE_MS = 3_000;
/** Characters of stderr and of non-JSON stdout kept for the error row. */
const AGY_OUTPUT_TAIL_CHARS = 8_192;
/** Longest CLI output excerpt shown in an error row. */
const AGY_ERROR_DETAIL_CHARS = 2_000;

const AGY_NOT_INSTALLED_MESSAGE = 'Antigravity CLI (agy) is not installed on this machine. '
  + 'Install it so `agy` is on the server\'s PATH or in ~/.local/bin, or set AGY_CLI_PATH to the agy binary.';
const AGY_NOT_SIGNED_IN_MESSAGE = 'The Antigravity CLI is not signed in. '
  + 'Run `agy` once in a terminal to sign in, then send your message again.';
const AGY_ATTACHMENTS_UNSUPPORTED_MESSAGE = 'Antigravity does not support attachments yet. '
  + 'Remove the attached images or files and send your message again.';
const AGY_PROMPT_TOO_LARGE_MESSAGE = 'This message is too large to hand to the Antigravity CLI: the prompt travels '
  + 'as one command-line argument, which Linux caps (at 128 KiB on most systems). Shorten it and send it again.';
const AGY_LEGACY_ROOT_HINT = 'This conversation is stored in ~/.gemini/antigravity, where older Antigravity versions '
  + 'kept their data, and the current agy CLI may not be able to resume it. Start a new chat to continue.';

/** An `AGY_ERROR` marker line, with whatever detail follows the marker. */
const AGY_ERROR_LINE_PATTERN = /\bAGY_ERROR\b[\s:=-]*(.*)$/;
/**
 * Step states that end a step without success. Only DONE is verified, so the
 * match is loose, as in the agy sessions provider's live mapping.
 */
const AGY_FAILED_STEP_STATE_PATTERN = /error|fail|cancel/i;

/**
 * Maps the UI permission mode onto agy's flags: `--mode accept-edits`,
 * `--mode plan`, or `--dangerously-skip-permissions` for bypass. "Skip
 * permissions" from the tool settings counts as bypass, except in plan mode,
 * which stays read-only (as the Claude runtime treats it). Anything else,
 * `default` included, passes no flag. Exported for the agy runtime tests.
 */
export function resolveAgyPermissionFlags(permissionMode: unknown, skipPermissions = false): string[] {
  if (permissionMode === 'plan') {
    return ['--mode', 'plan'];
  }
  if (permissionMode === 'bypassPermissions' || skipPermissions) {
    return ['--dangerously-skip-permissions'];
  }
  if (permissionMode === 'acceptEdits') {
    return ['--mode', 'accept-edits'];
  }
  return [];
}

/** A model value that can follow `--model`: never the "use the CLI's own" placeholders, never flag-like. */
function isPassableAgyModel(model: unknown): model is string {
  return typeof model === 'string'
    && model.trim() !== ''
    && model !== 'default'
    && !model.startsWith('-')
    && !/[\u0000-\u001f]/.test(model);
}

/**
 * Builds one turn's agy argv. The prompt is always a single element right
 * after `-p`; one that starts with `-` gets a leading space so a CLI parser
 * that refuses dash-prefixed option values cannot read it as a flag. Effort
 * must already be validated against the selected model. Exported for the agy
 * runtime tests.
 */
export function buildAgyArgs(input: {
  prompt: string;
  conversationId?: string | null;
  model?: string | null;
  permissionMode?: unknown;
  skipPermissions?: boolean;
  effort?: string | null;
}): string[] {
  const prompt = input.prompt.startsWith('-') ? ` ${input.prompt}` : input.prompt;
  const args = ['-p', prompt, '--output-format', 'stream-json'];
  if (isAgyConversationId(input.conversationId)) {
    args.push('--conversation', input.conversationId);
  }
  if (isPassableAgyModel(input.model)) {
    args.push('--model', input.model);
  }
  args.push(...resolveAgyPermissionFlags(input.permissionMode, input.skipPermissions));
  if (input.effort && input.effort !== 'default') {
    args.push('--effort', input.effort);
  }
  return args;
}

/**
 * Keeps an effort level only when the selected model's catalog row offers it
 * (`default` never reaches the CLI). With no explicit model, agy runs its
 * configured default, which the catalog's DEFAULT mirrors.
 */
function resolveAgyEffort(
  model: string | undefined,
  effort: unknown,
  catalog: ProviderModelsDefinition | null,
): string | undefined {
  if (typeof effort !== 'string' || !effort || effort === 'default' || !catalog) {
    return undefined;
  }

  const selectedModel = isPassableAgyModel(model) ? model : catalog.DEFAULT;
  const option = catalog.OPTIONS.find((candidate) => candidate.value === selectedModel);
  const allowedEfforts = option?.effort?.values.map((level) => level.value) ?? [];
  return allowedEfforts.includes(effort) ? effort : undefined;
}

/** The text after an `AGY_ERROR` marker (or a JSON payload's message), or null for other lines. */
function readAgyErrorText(line: string): string | null {
  const match = AGY_ERROR_LINE_PATTERN.exec(line);
  if (!match) {
    return null;
  }

  const detail = match[1].trim();
  if (!detail) {
    return line.trim();
  }

  try {
    const payload = readObjectRecord(JSON.parse(detail));
    const message = readOptionalString(payload?.message) ?? readOptionalString(payload?.error);
    if (message) {
      return message;
    }
  } catch {
    // Plain-text detail, the usual form.
  }
  return detail;
}

function findAgyErrorText(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const errorText = readAgyErrorText(line);
    if (errorText) {
      return errorText;
    }
  }
  return null;
}

function appendTail(tail: string, text: string): string {
  const combined = tail + text;
  return combined.length > AGY_OUTPUT_TAIL_CHARS ? combined.slice(-AGY_OUTPUT_TAIL_CHARS) : combined;
}

function lastChars(text: string, limit: number): string {
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

function isDirectory(directoryPath: string): boolean {
  try {
    return fs.statSync(directoryPath).isDirectory();
  } catch {
    return false;
  }
}

function hasAttachments(options: AnyRecord): boolean {
  return [options.images, options.files, options.attachments]
    .some((attachments) => normalizeAttachmentDescriptors(attachments).length > 0);
}

function describeSpawnError(error: unknown, agyPath: string, workingDirectory: string): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'E2BIG') {
    return AGY_PROMPT_TOO_LARGE_MESSAGE;
  }
  if (code === 'ENOENT') {
    // spawn reports a missing working directory as ENOENT too.
    return isDirectory(workingDirectory)
      ? AGY_NOT_INSTALLED_MESSAGE
      : `Antigravity cannot start because the project directory does not exist: ${workingDirectory}`;
  }
  if (code === 'EACCES') {
    return `The Antigravity CLI at ${agyPath} could not be started: permission denied.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `The Antigravity CLI could not be started: ${message}`;
}

/**
 * The conversation id a stream event carries, not yet validated: `init`
 * names it, and step updates and the final `result` repeat it.
 */
function readAgyEventConversationId(event: AgyStreamEvent): unknown {
  switch (event.event) {
    case 'init':
      return event.conversation_id;
    case 'step_update':
      return readObjectRecord(event.step_update)?.conversation_id;
    case 'result':
      return readObjectRecord(event.result)?.conversation_id;
    default:
      return undefined;
  }
}

/** A DONE tool step re-shaped as its ACTIVE announcement, for a tool whose ACTIVE never arrived. */
function synthesizeActiveToolStep(step: AgyStepUpdate): AgyStreamEvent {
  const toolInfo = step.tool_info ? { ...step.tool_info } : undefined;
  delete toolInfo?.output;
  return { event: 'step_update', step_update: { ...step, state: 'ACTIVE', tool_info: toolInfo } };
}

/** True when the conversation is found only under the legacy `~/.gemini/antigravity` root. */
async function isStoredOnlyInLegacyRoot(conversationId: string): Promise<boolean> {
  try {
    const root = await findAgyConversationRoot(conversationId);
    return typeof root === 'string' && isLegacyAgyRoot(root);
  } catch {
    return false;
  }
}

/**
 * Signals agy's whole process group. agy is spawned detached, so it leads its
 * own group and the negative pid also reaches every tool and language server
 * it started; signalling agy alone would orphan them.
 */
function signalAgyProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }

  try {
    if (process.platform === 'win32') {
      child.kill(signal);
      return;
    }
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      console.warn(`[agy] Failed to send ${signal} to the CLI process group:`, error);
      child.kill(signal);
    }
  }
}

/**
 * Whether anything of agy's process group is still there (a member that
 * exited but was not reaped yet counts). On Windows, where agy leads no
 * group, only agy itself is considered.
 */
function isAgyProcessGroupAlive(child: ChildProcess): boolean {
  if (!child.pid) {
    return false;
  }
  if (process.platform === 'win32') {
    return child.exitCode === null && child.signalCode === null;
  }

  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    // EPERM: the group has members, just none this process may signal.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Resolves true when `promise` settles within `timeoutMs`, false otherwise. */
function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function createActiveAgyRun(): ActiveAgyRun {
  let markFinished: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    markFinished = resolve;
  });
  return { child: null, aborted: false, finished, markFinished };
}

/**
 * The abort handler emits an aborted run's terminal `complete` as soon as
 * `abort()` resolves. Settling the run itself one event-loop turn later lets
 * that happen before the caller's "runtime ended without `complete`" safety
 * net, which would otherwise report the abort as a plain failure.
 */
function settleAfterAbortHandler(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Runs one chat turn. Resolves when the turn succeeded or was aborted and
 * rejects (after reporting an error row and the terminal `complete`) when it
 * failed, so the Agent API and scheduled messages see the failure.
 */
async function runAgyTurn(
  command: string,
  options: AnyRecord,
  writer: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<void> {
  const prompt = typeof command === 'string' ? command : '';
  // Callers pass the stable app session id; agy resumes by its own
  // conversation id, which the session row records.
  const appSessionId = readOptionalString(options.sessionId) ?? null;
  const sessionName = readOptionalString(options.sessionSummary) ?? null;
  const workingDirectory = readOptionalString(options.cwd) ?? readOptionalString(options.projectPath) ?? null;
  const providerSessionId = context.resolveProviderSessionId(appSessionId);
  // A resumed chat keeps its conversation id; a new one learns it from `init`.
  let conversationId: string | null = providerSessionId;

  const messageSessionId = (): string | null => conversationId || appSessionId;
  const send = (fields: { kind: NormalizedMessage['kind'] } & Record<string, unknown>): void => {
    writer.send(createNormalizedMessage({ ...fields, sessionId: messageSessionId(), provider: 'agy' }));
  };
  // Exactly one terminal `complete` per turn, whichever path ends it.
  let completeSent = false;
  const sendComplete = (exitCode: number): void => {
    if (!completeSent) {
      completeSent = true;
      writer.send(createCompleteMessage({ provider: 'agy', sessionId: messageSessionId(), exitCode }));
    }
  };
  // Notifications are app-facing, so they carry the app session id. They are
  // a side channel: a failure to deliver one must not stall the turn. They
  // name this run by its start time: an abort is reported once agy's process
  // closes, after the abort handler already ended the run, so the session's
  // next run may have started.
  const notifyOutcome = (outcome: { failure: string } | { stopReason: 'completed' | 'aborted' }): void => {
    const target = {
      userId: writer.userId ?? null,
      provider: 'agy',
      sessionId: appSessionId || conversationId,
      sessionName,
      runStartedAt: writer.runStartedAt ?? null,
    };
    try {
      if ('failure' in outcome) {
        notifyRunFailed({ ...target, error: outcome.failure });
      } else {
        notifyRunStopped({ ...target, stopReason: outcome.stopReason });
      }
    } catch (error) {
      console.warn('[agy] Failed to send the run notification:', error);
    }
  };
  const reportFailure = (message: string): void => {
    send({ kind: 'error', content: message });
    sendComplete(1);
    notifyOutcome({ failure: message });
  };
  const failBeforeSpawn = (message: string): Error => {
    reportFailure(message);
    return new Error(message);
  };

  const agyPath = resolveAgyCliPath();
  if (!agyPath) {
    throw failBeforeSpawn(AGY_NOT_INSTALLED_MESSAGE);
  }
  if (!isAgyOauthTokenPresent()) {
    throw failBeforeSpawn(AGY_NOT_SIGNED_IN_MESSAGE);
  }
  if (hasAttachments(options)) {
    throw failBeforeSpawn(AGY_ATTACHMENTS_UNSUPPORTED_MESSAGE);
  }
  if (!prompt.trim()) {
    throw failBeforeSpawn('There is no message to send to Antigravity.');
  }
  if (!workingDirectory || !isDirectory(workingDirectory)) {
    throw failBeforeSpawn(workingDirectory
      ? `Antigravity cannot start because the project directory does not exist: ${workingDirectory}`
      : 'Antigravity needs a project directory to run in.');
  }
  if (providerSessionId && !isAgyConversationId(providerSessionId)) {
    throw failBeforeSpawn(`This chat is linked to "${providerSessionId}", which is not an Antigravity conversation id, so it cannot be resumed. Start a new chat.`);
  }

  // Registered before the model lookups below so an abort that lands during
  // them stops the turn before agy starts. Legacy callers without an app
  // session id get a private key; nothing can address them for abort.
  const processKey = appSessionId ?? `agy-${randomUUID()}`;
  const entry = createActiveAgyRun();
  activeAgyRuns.set(processKey, entry);
  const releaseEntry = (): void => {
    // Only while this turn still owns the key: a turn started right after an
    // abort may already have replaced it.
    if (activeAgyRuns.get(processKey) === entry) {
      activeAgyRuns.delete(processKey);
    }
    entry.markFinished();
  };

  const requestedModel = readOptionalString(options.model);
  let resolvedModel: string | undefined;
  try {
    resolvedModel = await context.resolveResumeModel(appSessionId ?? undefined, requestedModel ?? null);
  } catch (error) {
    console.warn('[agy] Could not resolve the session model; using the requested one:', error);
    resolvedModel = requestedModel;
  }
  let catalog: ProviderModelsDefinition | null = null;
  try {
    catalog = await context.getProviderModels();
  } catch (error) {
    console.warn('[agy] Could not load the model catalog to validate effort:', error);
  }

  if (entry.aborted) {
    releaseEntry();
    notifyOutcome({ stopReason: 'aborted' });
    await settleAfterAbortHandler();
    return;
  }

  const args = buildAgyArgs({
    prompt,
    conversationId: providerSessionId,
    model: resolvedModel,
    permissionMode: options.permissionMode,
    skipPermissions: options.toolsSettings?.skipPermissions === true || options.skipPermissions === true,
    effort: resolveAgyEffort(resolvedModel, options.effort, catalog),
  });

  let child: ChildProcess;
  try {
    // No shell: the prompt reaches agy as one argv element, untouched. stdin
    // is closed so a prompt for input can never hang a headless turn.
    child = crossSpawn(agyPath, args, {
      cwd: workingDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (error) {
    // Argument-size failures (E2BIG) are thrown synchronously, not emitted.
    releaseEntry();
    throw failBeforeSpawn(describeSpawnError(error, agyPath, workingDirectory));
  }
  entry.child = child;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = '';
    let stderrTail = '';
    let textLineTail = '';
    let agyErrorText: string | null = null;
    let result: AgyResultPayload | null = null;
    let latestUsage: AgyUsage | null = null;
    let streamedText = false;
    let malformedIdLogged = false;
    let exitGraceTimer: NodeJS.Timeout | null = null;
    const announcedToolSteps = new Set<number>();
    const finishedToolSteps = new Set<number>();

    const finish = (failure: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (exitGraceTimer) {
        clearTimeout(exitGraceTimer);
      }
      releaseEntry();

      if (entry.aborted) {
        notifyOutcome({ stopReason: 'aborted' });
        void settleAfterAbortHandler().then(resolve);
        return;
      }
      if (failure) {
        reject(new Error(failure));
      } else {
        resolve();
      }
    };

    const bindConversation = (candidate: unknown): void => {
      if (conversationId || candidate === undefined || candidate === null || candidate === '') {
        return;
      }
      if (!isAgyConversationId(candidate)) {
        if (!malformedIdLogged) {
          malformedIdLogged = true;
          console.warn(`[agy] Ignoring malformed conversation id ${JSON.stringify(candidate)}`);
        }
        return;
      }

      conversationId = candidate;
      writer.setSessionId?.(candidate);
      writer.send(createNormalizedMessage({
        kind: 'session_created',
        newSessionId: candidate,
        sessionId: candidate,
        provider: 'agy',
      }));
    };

    const forwardToChat = (event: AgyStreamEvent): void => {
      let messages: NormalizedMessage[];
      try {
        messages = context.normalizeMessage(event, messageSessionId());
      } catch (error) {
        console.error('[agy] Failed to map a stream event:', error);
        return;
      }
      for (const message of messages) {
        writer.send(message);
      }
    };

    // A tool step arrives as ACTIVE (the call) and then DONE (its output), or
    // a failed end state. Each call must become exactly one card: a repeated
    // update is dropped, and an end whose ACTIVE never came is announced first.
    const forwardToolStep = (event: AgyStreamEvent, step: AgyStepUpdate): void => {
      const stepIndex = typeof step.step_index === 'number' ? step.step_index : null;
      if (stepIndex === null) {
        forwardToChat(event);
        return;
      }

      if (step.state === 'ACTIVE') {
        if (!announcedToolSteps.has(stepIndex)) {
          announcedToolSteps.add(stepIndex);
          forwardToChat(event);
        }
        return;
      }

      if (step.state === 'DONE' || AGY_FAILED_STEP_STATE_PATTERN.test(step.state ?? '')) {
        if (finishedToolSteps.has(stepIndex)) {
          return;
        }
        if (!announcedToolSteps.has(stepIndex)) {
          announcedToolSteps.add(stepIndex);
          forwardToChat(synthesizeActiveToolStep(step));
        }
        finishedToolSteps.add(stepIndex);
        forwardToChat(event);
        return;
      }

      forwardToChat(event);
    };

    const handleStreamEvent = (event: AgyStreamEvent): void => {
      // First, so `session_created` precedes whatever this event forwards.
      bindConversation(readAgyEventConversationId(event));
      switch (event.event) {
        case 'init':
          // It only names the conversation, bound above.
          return;
        case 'step_update': {
          const step = readObjectRecord(event.step_update) as AgyStepUpdate | null;
          if (!step) {
            return;
          }
          if (step.step_type === 'tool') {
            forwardToolStep(event, step);
            return;
          }
          if (step.step_type === 'agent_response') {
            if (typeof step.text_delta === 'string' && step.text_delta.trim()) {
              streamedText = true;
            }
            if (step.state === 'DONE' && readObjectRecord(step.usage)) {
              latestUsage = step.usage as AgyUsage;
            }
          }
          // user_input, system_message and unknown step types are the
          // mapping's call (it drops them).
          forwardToChat(event);
          return;
        }
        case 'result':
          result = (readObjectRecord(event.result) ?? {}) as AgyResultPayload;
          return;
        default:
          console.warn(`[agy] Ignoring unknown stream event ${JSON.stringify((event as { event?: unknown }).event)}`);
      }
    };

    // Non-JSON stdout is CLI chatter (or an AGY_ERROR line), never assistant
    // text; it is kept for the error row of a failed turn.
    const recordTextLine = (line: string): void => {
      const text = stripAnsiSequences(line).trim();
      if (!text) {
        return;
      }
      agyErrorText ??= readAgyErrorText(text);
      textLineTail = appendTail(textLineTail, `${text}\n`);
    };

    const handleStdoutLine = (rawLine: string): void => {
      const line = rawLine.trim();
      if (!line) {
        return;
      }

      let parsed: unknown = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Not JSON; handled below.
      }
      const event = readObjectRecord(parsed);
      if (entry.aborted) {
        // Nothing reaches the chat once the turn was aborted, but a new chat
        // still binds: the abort can be handled before the `init` agy already
        // wrote is read, and an unbound chat would start a fresh conversation
        // next turn, without this prompt. Binding shows nothing (the chat
        // writer only records the mapping) and lands before the abort
        // handler's `complete`, as the abort waits for `close`.
        if (event) {
          bindConversation(readAgyEventConversationId(event as AgyStreamEvent));
        }
        return;
      }
      if (!event) {
        recordTextLine(line);
        return;
      }
      handleStreamEvent(event as AgyStreamEvent);
    };

    // Null when the turn succeeded; otherwise the error row's text.
    const describeTurnFailure = (code: number | null, signal: NodeJS.Signals | null): string | null => {
      const failedResult = result !== null && result.status !== 'SUCCESS';
      if (code === 0 && !agyErrorText && result !== null && !failedResult) {
        return null;
      }

      // agy's own error text says it best; stderr is only searched for one
      // once the turn has failed anyway.
      const stderrText = stripAnsiSequences(stderrTail).trim();
      const agyError = agyErrorText ?? findAgyErrorText(stderrText);
      if (agyError) {
        return agyError;
      }

      let summary: string;
      if (failedResult) {
        summary = `Antigravity stopped with status ${readOptionalString(result?.status) ?? 'unknown'}.`;
      } else if (code === null) {
        summary = `The Antigravity CLI was stopped${signal ? ` by ${signal}` : ''} before it finished.`;
      } else if (code !== 0) {
        summary = `The Antigravity CLI exited with code ${code}.`;
      } else {
        summary = 'The Antigravity CLI ended without reporting a result.';
      }
      const detail = lastChars(stderrText || textLineTail.trim(), AGY_ERROR_DETAIL_CHARS);
      return detail ? `${summary}\n\n${detail}` : summary;
    };

    const completeTurn = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
      let failure = describeTurnFailure(code, signal);
      if (failure && providerSessionId && await isStoredOnlyInLegacyRoot(providerSessionId)) {
        failure = `${failure}\n\n${AGY_LEGACY_ROOT_HINT}`;
      }
      // An abort that landed during the lookup owns the terminal `complete`.
      if (entry.aborted) {
        finish(null);
        return;
      }

      // `result.response` repeats the streamed text, so it is only shown
      // when nothing streamed (a partial answer of a failed turn, typically).
      const finalResponse = result?.response;
      if (!streamedText && typeof finalResponse === 'string' && finalResponse.trim()) {
        send({ kind: 'text', role: 'assistant', content: finalResponse });
      }
      if (failure) {
        send({ kind: 'error', content: failure });
      }
      // The latest response's context, built as history builds it, so the
      // counter does not jump when the session reloads. `result.usage` is
      // cumulative over the conversation and never used here.
      const tokenBudget = buildAgyTokenUsage(latestUsage);
      if (tokenBudget) {
        send({ kind: 'status', text: 'token_budget', tokenBudget });
      }
      sendComplete(failure ? 1 : 0);
      notifyOutcome(failure ? { failure } : { stopReason: 'completed' });
      finish(failure);
    };

    // utf8 decoding on the stream keeps a multi-byte character that is split
    // across two chunks intact.
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        handleStdoutLine(line);
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = appendTail(stderrTail, chunk);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (child.pid !== undefined) {
        // The process is running; `close` still reports how the turn ended.
        console.warn('[agy] CLI process error:', error.message);
        return;
      }
      if (settled) {
        return;
      }
      // Spawn failed (the binary vanished or is not executable); `close`
      // follows, but the turn ends here.
      if (entry.aborted) {
        finish(null);
        return;
      }
      const message = describeSpawnError(error, agyPath, workingDirectory);
      reportFailure(message);
      finish(message);
    });

    child.on('exit', () => {
      if (settled) {
        return;
      }
      exitGraceTimer = setTimeout(() => {
        exitGraceTimer = null;
        console.warn('[agy] The CLI exited but a process it started still holds its output open; finishing the turn.');
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, AGY_EXIT_CLOSE_GRACE_MS);
    });

    // The turn ends on `close` rather than on `result`, so the transcript is
    // fully written before the client refetches history.
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (exitGraceTimer) {
        clearTimeout(exitGraceTimer);
        exitGraceTimer = null;
      }
      if (settled) {
        return;
      }
      if (stdoutBuffer.trim()) {
        handleStdoutLine(stdoutBuffer);
      }
      stdoutBuffer = '';

      // The abort handler sends an aborted turn's `complete`; nothing else
      // is reported for it.
      if (entry.aborted) {
        finish(null);
        return;
      }

      void completeTurn(code, signal).catch((error: unknown) => {
        console.error('[agy] Failed to finish the turn:', error);
        const message = error instanceof Error ? error.message : String(error);
        if (!settled && !completeSent) {
          try {
            reportFailure(message);
          } catch (reportError) {
            console.error('[agy] Failed to report the failed turn:', reportError);
          }
        }
        finish(message);
      });
    });
  });
}

/**
 * Aborts the turn running for an app session: SIGTERM to agy's process group,
 * then SIGKILL to the whole group AGY_ABORT_KILL_DELAY_MS later, whether or
 * not agy itself exited meanwhile, so no tool or language server it started
 * outlives the abort by ignoring SIGTERM. Resolves as soon as agy's process
 * closed (or the kill grace ran out), not when the group is gone, so a turn
 * started right after an abort never runs alongside the old process on the
 * same conversation. Resolves false when nothing is running for the session.
 */
async function abortAgyRun(sessionId: string): Promise<boolean> {
  const entry = activeAgyRuns.get(sessionId);
  if (!entry) {
    return false;
  }

  entry.aborted = true;
  const child = entry.child;
  if (!child) {
    // Not spawned yet: the turn sees the flag before spawning and stops.
    await settlesWithin(entry.finished, AGY_ABORT_KILL_DELAY_MS);
    return true;
  }

  signalAgyProcessGroup(child, 'SIGTERM');
  // Not tied to agy's own exit: agy can obey SIGTERM at once while a helper
  // in its group ignores it, and that helper would then run on with no
  // owner. Unref'd so it never keeps the server process alive.
  const groupKillTimer = setTimeout(() => {
    signalAgyProcessGroup(child, 'SIGKILL');
  }, AGY_ABORT_KILL_DELAY_MS);
  groupKillTimer.unref();

  await settlesWithin(entry.finished, AGY_ABORT_KILL_DELAY_MS + AGY_ABORT_SETTLE_GRACE_MS);
  // Called off only once nothing of the group is left: a survivor still gets
  // its SIGKILL, and the id of a group that is gone is never signalled again.
  if (!isAgyProcessGroupAlive(child)) {
    clearTimeout(groupKillTimer);
  }
  return true;
}

/** Used by the providers module's AgyProvider to run and abort agy turns. */
export const agyRuntime: IProviderRuntime = {
  run: runAgyTurn,
  abort: abortAgyRun,
};
