import path from 'node:path';

import type { WebSocket } from 'ws';

import { scheduleHoldsDb, sessionsDb } from '@/modules/database/index.js';
import { providerModelsService, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { planLoopsResume, readResumeOptions, type LoopsResumePlan } from '@/modules/websocket/services/loops-resume.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import {
  getGlobalImageAssetsDir,
  isImageAttachmentDescriptor,
  normalizeAttachmentDescriptors,
  type ChatAttachmentDescriptor,
} from '@/shared/image-attachments.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  GatewayEventKind,
  HandOverBlockDetail,
  HandOverChange,
  InsertStatus,
  LLMProvider,
  MessageKind,
  PausedScheduledWork,
  ProviderCancelInsertGatewayResult,
  ProviderHandOverPlan,
  ProviderHandOverPlanOptions,
  ProviderInsertGatewayResult,
  ProviderInsertInput,
  ProviderPermissionDecision,
  ProviderRuntimeWriter,
  RunEndOutcome,
  ScheduledWorkStopOptions,
  ScheduledWorkStopResult,
  ScheduledWorkSummary,
} from '@/shared/types.js';
import { buildTurnRunOptions, generateMessageId, parseIncomingJsonObject } from '@/shared/utils.js';

/**
 * Trust boundary for client-supplied image attachments: chat.send options come
 * straight from the browser, and the provider runtimes read the referenced
 * files off disk (Claude base64-encodes them into the prompt). Only images
 * that live directly inside the global upload store (`~/.cloudcli/assets`,
 * where POST /api/assets/images puts them) are allowed through — anything
 * else (absolute paths elsewhere, traversal, subdirectories) is dropped.
 *
 * Exported for tests; `assetsRootOverride` exists only for them.
 */
export function filterAttachmentsToUploadStore(
  attachments: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  const assetsRoot = path.resolve(assetsRootOverride ?? getGlobalImageAssetsDir());

  return normalizeAttachmentDescriptors(attachments).filter((descriptor) => {
    // Relative paths are anchored in the store; absolute ones must already be in it.
    const resolved = path.resolve(assetsRoot, descriptor.path);
    const relative = path.relative(assetsRoot, resolved);
    const isDirectChild =
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      !relative.includes(path.sep) &&
      !relative.includes('/');

    if (!isDirectChild) {
      console.warn(`[Chat] Dropping attachment outside the upload store: ${descriptor.path}`);
    }
    return isDirectChild;
  });
}

/** Backward-compatible image filter consumed by existing websocket tests. */
export function filterImagesToUploadStore(
  images: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  return filterAttachmentsToUploadStore(images, assetsRootOverride);
}

/**
 * Application boundary for dispatching provider runs, approvals and mid-run
 * inserts. The scheduled-messages module types its dispatcher's runtime with
 * it too, since a queued or scheduled message runs through the same gateway.
 */
export type ProviderRuntimeGateway = {
  hasRuntime(provider: string): boolean;
  run(
    provider: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown>;
  abort(provider: LLMProvider, sessionId: string): Promise<boolean>;
  stopBackgroundTask(provider: LLMProvider, sessionId: string, taskId: string): Promise<boolean>;
  /** Whether a provider runtime still holds background work for the session after its turn ended. */
  hasBackgroundWork(sessionId: string): boolean;
  /**
   * Whether a provider runtime holds scheduled work for the session in the
   * process it keeps for it: a /loop's next wake-up, a CronCreate job (see
   * `ScheduledWorkSummary`). Apart from `hasBackgroundWork`, which answers
   * for tasks alone.
   */
  hasScheduledWork(sessionId: string): boolean;
  /** The session's scheduled work, as the provider runtimes list it. */
  listScheduledWork(sessionId: string): ScheduledWorkSummary[];
  /**
   * Stops one item of the session's scheduled work, named by its id, or all
   * of it with `all` (see `ScheduledWorkStopResult`): the provider runtime
   * lets go of its process when that alone ends the work, and otherwise
   * answers with the turn that has the model cancel it. The chat gateway's
   * `chat.stop-task` asks for it, and runs that turn.
   */
  stopScheduledWork(
    provider: LLMProvider,
    sessionId: string,
    id: string,
    options: ScheduledWorkStopOptions,
  ): Promise<ScheduledWorkStopResult>;
  /**
   * The session's loops that no process runs (see `PausedScheduledWork`),
   * which `chat.resume-loops` resumes and `chat.stop-task` stops; nothing,
   * with `heldHere`, while a process of this server holds the session.
   * Absent for a gateway that reads none.
   */
  describePausedScheduledWork?(sessionId: string): Promise<PausedScheduledWork & { heldHere: boolean }>;
  resolveToolApproval(requestId: string, payload: ProviderPermissionDecision): void;
  getPendingApprovalsForSession(sessionId: string): unknown[];
  /**
   * Writes a user message into the session's running turn (see
   * `IProviderRuntime.insert`). UNSUPPORTED when the provider's runtime
   * cannot insert.
   */
  insert(provider: LLMProvider, sessionId: string, input: ProviderInsertInput): Promise<ProviderInsertGatewayResult>;
  /**
   * Withdraws an insert the model has not read yet (see
   * `IProviderRuntime.cancelInsert`). `unsupported` when the provider's
   * runtime cannot insert.
   */
  cancelInsert(provider: LLMProvider, sessionId: string, insertId: string): Promise<ProviderCancelInsertGatewayResult>;
  /**
   * Whether a turn of the session run with `options` (its run options) would
   * go into the process the provider's runtime holds for the session's
   * background work, keeping it, and what it would switch there (see
   * `ProviderHandOverPlan`). Nothing is held, for a runtime that never holds
   * a process. `planOptions` go to the runtime as given (see
   * `ProviderHandOverPlanOptions`).
   */
  planHandOver(
    provider: LLMProvider,
    sessionId: string,
    options: AnyRecord,
    planOptions?: ProviderHandOverPlanOptions,
  ): Promise<ProviderHandOverPlan>;
};

/**
 * Whether a provider runtime still holds work of the session after its turn:
 * background tasks (`hasBackgroundWork`), or scheduled work
 * (`hasScheduledWork`: a /loop's next wake-up, a CronCreate job). Either way
 * the run that left the work keeps sending live events through its writer
 * (task progress, the turn a task's report or a firing pushes), so
 * `chat.subscribe` attaches a tab to it, and the composition root keeps the
 * run registered for as long (`chatRunRegistry.setRetentionGuard`), which
 * also has the turn's `run_ended` say that work goes on.
 */
export function holdsWorkPastTurn(
  runtime: Pick<ProviderRuntimeGateway, 'hasBackgroundWork' | 'hasScheduledWork'>,
  sessionId: string,
): boolean {
  return runtime.hasBackgroundWork(sessionId) || runtime.hasScheduledWork(sessionId);
}

type ChatWebSocketDependencies = {
  /** Central dispatcher for every provider SDK/CLI runtime. */
  runtime: ProviderRuntimeGateway;
  /**
   * Called once a `chat.stop-task` has ended a session's scheduled work, so
   * the messages that waited for it go without waiting for the next poll.
   */
  onScheduledWorkReleased?: (sessionId: string) => void;
};

/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 */
function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WS_OPEN_STATE) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Reports a protocol-level failure to the requesting client.
 *
 * Protocol errors deliberately use their own `kind` (instead of the provider
 * `error` message kind) so the frontend can distinguish "your request was
 * invalid" from "the model run produced an error" without inspecting text.
 */
function sendProtocolError(
  ws: WebSocket,
  code: string,
  error: string,
  sessionId?: string
): void {
  sendJson(ws, {
    kind: 'protocol_error',
    code,
    error,
    sessionId: sessionId ?? null,
    timestamp: new Date().toISOString(),
  });
}

function readRequiredSessionId(data: AnyRecord): string | null {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return sessionId.length > 0 ? sessionId : null;
}

/**
 * Handles `chat.send`: resolves the session row (provider, project path, and
 * provider-native id all come from the database — never from the client),
 * registers the run, and dispatches to the provider runtime.
 *
 * A send that sets `options.keepBackgroundWork` is not started when it would
 * stop the session's background work (see `refuseSendThatStopsBackgroundWork`).
 * Only such a send waits for that check, and only while no turn is under way
 * (a busy session refuses it as RUN_IN_PROGRESS below): every other send
 * reserves its run at once, before the socket's next frame is handled.
 */
async function handleChatSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const resolved = resolveSendTarget(ws, data, dependencies, 'chat.send');
  if (!resolved) {
    return;
  }
  if (
    (data.options as AnyRecord | undefined)?.keepBackgroundWork === true
    && !chatRunRegistry.isProcessing(resolved.sessionId)
    && await refuseSendThatStopsBackgroundWork(ws, resolved, data, dependencies)
  ) {
    return;
  }

  await dispatchRun(ws, userId, resolved.sessionId, resolved.session, data, dependencies);
}

type ResolvedSendTarget = {
  sessionId: string;
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;
  provider: LLMProvider;
};

/**
 * The gateway's answer to a `chat.send` it did not start because the turn
 * would stop the session's background work, sent to the asking socket alone
 * in the envelope of the insert refusals: no `seq`, and never a
 * `protocol_error`, which the client takes as the session's run failing.
 * `changes` says why the turn cannot go into the held process, and `details`
 * what exactly (see `HandOverBlockDetail`); `content` is
 * the message as sent, for the composer to put back. `clientRequestId` is the
 * send's own (see `readClientRequestId`), left out when it had none: every
 * pane on a page shares the socket, and the id tells them which send this
 * answers.
 */
type SendRefusedFrame = {
  kind: Extract<GatewayEventKind, 'send_refused'>;
  id: string;
  sessionId: string;
  provider: LLMProvider;
  reason: 'BACKGROUND_WORK_WOULD_STOP';
  changes: HandOverChange[];
  details?: HandOverBlockDetail;
  content: string;
  clientRequestId?: string;
  timestamp: string;
};

/**
 * How a client names one of its requests (`clientRequestId`), for the gateway
 * to hand back on its answer: a send's refusal, a stop's `stop_task_status`.
 * Letters, digits, `_` and `-`, 128 at most.
 */
const CLIENT_REQUEST_ID_PATTERN = /^[\w-]{1,128}$/;

/** The request's `clientRequestId` as the client sent it, or null when it sent none, or one out of pattern. */
function readClientRequestId(data: AnyRecord): string | null {
  return typeof data.clientRequestId === 'string' && CLIENT_REQUEST_ID_PATTERN.test(data.clientRequestId)
    ? data.clientRequestId
    : null;
}

/**
 * Refuses a `chat.send` that set `options.keepBackgroundWork` when its turn
 * would stop the session's background work: the session's process is held
 * for that work, and the turn cannot run in it (it changes what only a new
 * process can apply), so the run would start a process of its own and retire
 * the held one. The socket gets `send_refused` and no run starts; the client
 * then asks the user. Returns whether it refused.
 *
 * Called by `handleChatSend` for such a send only: one without the flag stops
 * the work as it always did, which is also what the client sends once the
 * user chose to. A plan the runtime fails to make refuses too, since nothing
 * says the work would survive the send.
 */
async function refuseSendThatStopsBackgroundWork(
  ws: WebSocket,
  target: ResolvedSendTarget,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
): Promise<boolean> {
  const clientOptions = (data.options ?? {}) as AnyRecord;
  let plan: ProviderHandOverPlan;
  try {
    plan = await dependencies.runtime.planHandOver(
      target.provider,
      target.sessionId,
      // The options the turn's run would get (see dispatchRun), so the plan
      // judges the very turn that would run.
      buildTurnRunOptions({
        sessionId: target.sessionId,
        projectPath: target.session.project_path,
        clientOptions,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Chat] Provider runtime "${target.provider}" could not plan a send over background work`, {
      sessionId: target.sessionId,
      error: message,
    });
    plan = { heldWork: true, canHandOver: false, changes: ['lookup'], switches: [] };
  }
  // A process of the turn's own that brings the held work back stops nothing.
  if (!plan.heldWork || plan.canHandOver || plan.replaceKeepsWork) {
    return false;
  }

  const clientRequestId = readClientRequestId(data);
  const frame: SendRefusedFrame = {
    kind: 'send_refused',
    id: generateMessageId('send_refused'),
    sessionId: target.sessionId,
    provider: target.provider,
    reason: 'BACKGROUND_WORK_WOULD_STOP',
    changes: plan.changes,
    ...(plan.details ? { details: plan.details } : {}),
    content: typeof data.content === 'string' ? data.content : '',
    ...(clientRequestId ? { clientRequestId } : {}),
    timestamp: new Date().toISOString(),
  };
  sendJson(ws, frame);
  return true;
}

/**
 * Shared front half of `chat.send` and `chat.edit-send`: the session row and
 * provider come from the database, never from the client.
 */
function resolveSendTarget(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  frameName: string,
): ResolvedSendTarget | null {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', `${frameName} requires a sessionId.`);
    return null;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(
      ws,
      'SESSION_NOT_FOUND',
      `Session "${sessionId}" was not found. Create it via POST /api/providers/sessions first.`,
      sessionId
    );
    return null;
  }

  const provider = session.provider as LLMProvider;
  if (!dependencies.runtime.hasRuntime(provider)) {
    sendProtocolError(ws, 'UNSUPPORTED_PROVIDER', `Provider "${provider}" is not available.`, sessionId);
    return null;
  }

  return { sessionId, session, provider };
}

/**
 * What the provider runtime reports to a turn's `onSwitchesRestored` run
 * option, the turn's switch-back: a turn run with `restoreSwitchesAfterTurn`
 * is over, and the process it was handed to stays, switched back. For each
 * of the model and the permission mode the turn was to switch, what the
 * process runs with now; null for one the turn was not to switch.
 */
type SwitchesRestored = { model?: unknown; permissionMode?: unknown };

/**
 * One turn that recorded one of its settings (its model, reasoning effort or
 * ultracode) on the session for itself alone (see `recordForTurnAlone`).
 */
type TurnSettingRecord<T> = {
  /** What the session had recorded when the turn wrote its own; null when nothing was. */
  previous: T | null;
  /** What the turn recorded. */
  value: T;
  /** Set once the turn's switch-back has come. */
  restored: boolean;
  /**
   * The session's next such turn, when it was dispatched while this turn's
   * switch-back was still to come, so that it found this turn's value
   * recorded. Once the switch-back comes, it takes over this turn's previous
   * value as its own.
   */
  next: TurnSettingRecord<T> | null;
};

/** One setting of the session's row a turn can record for itself alone (see `recordForTurnAlone`). */
type TurnSetting<T> = {
  /**
   * Per session, the latest turn that recorded the setting for itself alone,
   * until its switch-back comes: the only one whose switch-back puts a value
   * back. One whose switch-back never comes (its process let go after the
   * turn) stays until the session's next such turn takes its place: that turn
   * links to it only if it still finds its value recorded, and a switch-back
   * that never comes hands nothing on.
   */
  records: Map<string, TurnSettingRecord<T>>;
  /** What the session's row records; null when nothing is, or the session has gone. */
  read: (sessionId: string) => T | null;
  write: (provider: LLMProvider, sessionId: string, value: T) => void;
  /** What the switch-back says the process runs with, standing in when nothing was recorded before the turn. */
  switchedBackTo?: (restored: SwitchesRestored) => T | null;
};

const TURN_MODEL: TurnSetting<string> = {
  records: new Map(),
  read: (sessionId) => sessionsDb.getSessionById(sessionId)?.model?.trim() || null,
  write: (provider, sessionId, model) => {
    providerModelsService.setSessionModel(provider, sessionId, model);
  },
  switchedBackTo: (restored) => (
    typeof restored?.model === 'string' && restored.model.trim() ? restored.model.trim() : null
  ),
};

const TURN_EFFORT: TurnSetting<string> = {
  records: new Map(),
  read: (sessionId) => sessionsDb.getSessionById(sessionId)?.effort?.trim() || null,
  write: (provider, sessionId, effort) => {
    providerModelsService.setSessionEffort(provider, sessionId, effort);
  },
};

const TURN_ULTRACODE: TurnSetting<boolean> = {
  records: new Map(),
  read: (sessionId) => {
    const ultracode = sessionsDb.getSessionById(sessionId)?.ultracode;
    return typeof ultracode === 'number' ? ultracode !== 0 : null;
  },
  write: (provider, sessionId, ultracode) => {
    providerModelsService.setSessionUltracode(provider, sessionId, ultracode);
  },
};

/**
 * Records one setting of a turn whose switches last for the turn alone
 * (`restoreSwitchesAfterTurn`, as the scheduled-messages dispatcher sends a
 * queued or due message): its model, reasoning effort or ultracode. Returns
 * what puts the session's own value back once the turn's switch-back comes
 * (see `SwitchesRestored`), for the turn's `onSwitchesRestored` run option.
 *
 * The value is recorded before the run as for every turn: the runtime reads
 * a resumed turn's model off the record, and the message must run on its
 * own. But the record is also what a composer shows when the session is
 * opened again, and what the user's next send goes with. Left on the
 * message's model, it would switch a /loop the message left as it was for
 * good. Left on an effort or ultracode the held process cannot switch to (a
 * message that went in on the process's own, `acceptProcessSettings`), it
 * would make the user's next send ask for a new process, which stops the
 * loop, though nobody changed a setting. So once the switch-back comes, the
 * value recorded before the turn goes back, unless the record no longer
 * holds the turn's (the user picked another meanwhile); read and written
 * with nothing awaited in between. The previous value goes back whatever the
 * runtime switched back, as the turn's record replaced the user's pick even
 * where nothing was switched: the turn named the process's own settings, or
 * it was stopped while it waited for a turn the CLI ran on its own. The
 * model the runtime names stands in only when nothing was recorded before.
 * A turn that started a process of its own, or whose process lets go after
 * it, gets no switch-back: it leaves the record on the turn's values, as
 * every turn's did before.
 *
 * Two such turns of a session can follow each other faster than the first
 * one's switch-back (due messages of one session in one pass). The record is
 * then the second one's, and only the second one's switch-back puts a value
 * back: the one the second found recorded, or, when that was the first one's,
 * the one recorded before the first, which the first one's switch-back hands
 * on. Each setting goes its own way: when the second turn records no effort,
 * the first one's switch-back puts the effort back.
 */
function recordForTurnAlone<T>(
  setting: TurnSetting<T>,
  provider: LLMProvider,
  sessionId: string,
  value: T,
): (restored: SwitchesRestored) => void {
  const recorded = setting.read(sessionId);
  const turn: TurnSettingRecord<T> = { previous: recorded, value, restored: false, next: null };
  const latest = setting.records.get(sessionId);
  if (latest && !latest.restored && latest.value === recorded) {
    latest.next = turn;
  }
  setting.records.set(sessionId, turn);
  setting.write(provider, sessionId, value);

  return (restored) => {
    if (turn.restored) {
      return;
    }
    turn.restored = true;
    if (turn.next) {
      turn.next.previous = turn.previous;
    }
    if (setting.records.get(sessionId) !== turn) {
      // A later such turn recorded its value: the record is that turn's.
      return;
    }
    setting.records.delete(sessionId);
    const previous = turn.previous ?? setting.switchedBackTo?.(restored) ?? null;
    if (previous !== null && setting.read(sessionId) === turn.value) {
      setting.write(provider, sessionId, previous);
    }
  };
}

/**
 * Why a provider runtime turned a turn away at the hand-over, as its run's
 * `error` with code HAND_OVER_FAILED says: a turn the scheduled-messages
 * dispatcher sent on the held process's own settings
 * (`acceptProcessSettings`), which that process did not take after all, or
 * a turn sent on the word that a process of its own keeps the work
 * (`keepBackgroundWork`), which the CLI's own turn started more of while it
 * waited. The runtime fails such a turn rather than start a process of its
 * own, which would stop the session's work. `reason` is the runtime's word
 * for it (Claude's: `stale-plan`, `lookup`, `work-started`), `content` its
 * English text; null when the error left either out.
 */
export type HandOverFailure = { reason: string | null; content: string | null };

type ChatRun = NonNullable<ReturnType<typeof chatRunRegistry.startRun>>;

/** The `HandOverFailure` a run's events report, or null when its runtime reported none. */
function readHandOverFailure(run: ChatRun): HandOverFailure | null {
  const error = run.events.find((event) => event.kind === 'error' && event.code === 'HAND_OVER_FAILED');
  if (!error) {
    return null;
  }
  return {
    reason: typeof error.reason === 'string' ? error.reason : null,
    content: typeof error.content === 'string' ? error.content : null,
  };
}

/** How a turn `runDetachedChatTurn` ran ended. */
export type DetachedTurnOutcome = Extract<RunEndOutcome, 'done' | 'failed' | 'aborted'>;

/**
 * How a run's turn ended, read off its terminal `complete` as the run's end
 * is (see `RunEndOutcome`). `failed` includes a CLI that could not start,
 * which a runtime reports so rather than by throwing.
 */
function readTurnOutcome(run: ChatRun): DetachedTurnOutcome {
  for (let index = run.events.length - 1; index >= 0; index -= 1) {
    const event = run.events[index];
    if (event.kind !== 'complete') {
      continue;
    }
    if (event.aborted === true) {
      return 'aborted';
    }
    if (typeof event.success === 'boolean') {
      return event.success ? 'done' : 'failed';
    }
    return typeof event.exitCode !== 'number' || event.exitCode === 0 ? 'done' : 'failed';
  }
  return 'failed';
}

/**
 * Registers the run and hands the turn to the provider runtime. Resolves once
 * the runtime's run settles, with whether the run started, how it failed,
 * and the `HandOverFailure` its events report.
 *
 * `extraRuntimeOptions` go over the client's options (see
 * `buildTurnRunOptions`): how an edited message asks the provider to resume
 * partway instead of continuing from the tip, or the
 * `acceptProcessSettings` and `ownSettings` of a turn `runDetachedChatTurn`
 * runs; a normal send passes nothing.
 */
async function dispatchRun(
  ws: WebSocket | null,
  userId: string | number | null,
  sessionId: string,
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  extraRuntimeOptions: AnyRecord = {},
  beforeRun?: (run: ChatRun) => void | Promise<void>,
): Promise<{ started: boolean; error: string | null; handOverFailure: HandOverFailure | null }> {
  const provider = session.provider as LLMProvider;

  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider,
    providerSessionId: session.provider_session_id,
    connection: ws,
    userId,
  });

  if (!run) {
    if (ws) {
      sendProtocolError(
        ws,
        'RUN_IN_PROGRESS',
        `Session "${sessionId}" already has a run in progress.`,
        sessionId
      );
    }
    return { started: false, error: 'A run is already in progress for this session.', handOverFailure: null };
  }

  const clientOptions = (data.options ?? {}) as AnyRecord;
  const command = typeof data.content === 'string' ? data.content : '';

  // Older clients and replayed queued or scheduled messages can still carry the
  // legacy `ultracode` effort, which now means xhigh with ultracode on. It is
  // split here (buildTurnRunOptions), so neither the session row nor the
  // runtime ever sees the token.
  const turnOptions = buildTurnRunOptions({
    sessionId,
    projectPath: session.project_path,
    clientOptions,
    extraOptions: extraRuntimeOptions,
  });
  const { effort, ultracode } = turnOptions;

  // Record what this turn runs with so reopening the session later restores the
  // same model, reasoning effort and ultracode switch, and so the resume path
  // has a session-scoped model answer to use. A turn whose switches last for
  // it alone puts the session's own settings back afterwards
  // (recordForTurnAlone).
  const turnModel = typeof clientOptions.model === 'string' ? clientOptions.model.trim() : '';
  const forTurnAlone = clientOptions.restoreSwitchesAfterTurn === true;
  const putBack: Array<(restored: SwitchesRestored) => void> = [];
  const record = <T>(setting: TurnSetting<T>, value: T) => {
    if (forTurnAlone) {
      putBack.push(recordForTurnAlone(setting, provider, sessionId, value));
    } else {
      setting.write(provider, sessionId, value);
    }
  };
  if (turnModel) {
    record(TURN_MODEL, turnModel);
  }
  if (effort) {
    record(TURN_EFFORT, effort);
  }
  if (typeof ultracode === 'boolean') {
    record(TURN_ULTRACODE, ultracode);
  }
  const onSwitchesRestored = putBack.length > 0
    ? (restored: SwitchesRestored) => {
      for (const put of putBack) {
        put(restored);
      }
    }
    : null;

  const attachmentCandidates = [
    ...normalizeAttachmentDescriptors(clientOptions.images),
    ...normalizeAttachmentDescriptors(clientOptions.files),
    ...normalizeAttachmentDescriptors(clientOptions.attachments),
  ];
  const verifiedAttachments = filterAttachmentsToUploadStore(attachmentCandidates);
  const uniqueAttachments = verifiedAttachments.filter(
    (descriptor, index, all) => all.findIndex((candidate) => candidate.path === descriptor.path) === index,
  );

  // The provider runtimes receive the stable app session id. When their
  // CLI/SDK needs the provider-native id for resume, they resolve it from the
  // session row themselves (sessionsService.resolveProviderSessionId).
  // Brand-new sessions have no provider id yet, so the runtime starts fresh
  // and announces one, which the gateway writer captures and maps back to the
  // app session id.
  const runtimeOptions: AnyRecord = {
    ...turnOptions,
    // Attachments are re-validated server-side: only direct children of the
    // global upload store may reach provider runtimes or their file tools.
    attachments: uniqueAttachments,
    images: uniqueAttachments.filter(isImageAttachmentDescriptor),
    files: uniqueAttachments.filter((descriptor) => !isImageAttachmentDescriptor(descriptor)),
  };
  // The gateway's own callback (see recordForTurnAlone), never a value the
  // client sent under its name.
  delete runtimeOptions.onSwitchesRestored;
  if (onSwitchesRestored) {
    runtimeOptions.onSwitchesRestored = onSwitchesRestored;
  }

  let failure: string | null = null;
  try {
    // Runs only now that the session is reserved, because an edit rewinds the
    // conversation here and a rewind for a run that was never admitted cannot
    // be taken back. Inside the try so a rewind that throws still releases the
    // run instead of leaving the session processing forever.
    await beforeRun?.(run);
    await dependencies.runtime.run(provider, command, runtimeOptions, run.writer);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    console.error(`[Chat] Provider runtime "${provider}" failed`, { sessionId, error: failure });
  } finally {
    // Safety net: a runtime that crashed (or resolved) without emitting its
    // terminal `complete` would otherwise leave the session stuck in
    // "processing" forever on every connected client. Scoped to THIS run —
    // a queued message can start the session's next run before this promise
    // settles, and the session-keyed completeRun would kill that new run.
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
  }

  return { started: true, error: failure, handOverFailure: readHandOverFailure(run) };
}

/**
 * Handles `chat.edit-send`: replaces an already-sent message and everything
 * after it with a new turn.
 *
 * Nothing is deleted. The provider resumes the conversation partway and
 * appends the replacement, so the abandoned attempt stays in the transcript
 * file and is simply no longer part of the live conversation — the same shape
 * Claude Code's rewind and Codex's fork-with-cut-point produce.
 */
async function handleChatEditSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const resolved = resolveSendTarget(ws, data, dependencies, 'chat.edit-send');
  if (!resolved) {
    return;
  }

  const { sessionId, session, provider } = resolved;
  const anchorId = typeof data.anchorId === 'string' ? data.anchorId.trim() : '';
  if (!anchorId) {
    sendProtocolError(ws, 'ANCHOR_REQUIRED', 'chat.edit-send requires the anchorId of the message being replaced.', sessionId);
    return;
  }

  let resumeThroughId: string | null;
  try {
    const anchor = await sessionsService.resolveEditAnchor(sessionId, anchorId);
    if (!anchor) {
      sendProtocolError(
        ws,
        'EDIT_NOT_SUPPORTED',
        `Provider "${provider}" cannot replace an already-sent message.`,
        sessionId
      );
      return;
    }
    if (!anchor.found) {
      sendProtocolError(ws, 'ANCHOR_NOT_FOUND', 'That message is no longer in the transcript.', sessionId);
      return;
    }
    resumeThroughId = anchor.resumeThroughId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendProtocolError(ws, 'ANCHOR_LOOKUP_FAILED', `Could not read the transcript: ${message}`, sessionId);
    return;
  }

  // Providers split here on what their runtime can do. Claude resumes its
  // transcript partway, so the anchor rides along as a run option. Codex
  // cannot — a thread only grows — so the conversation is rewound on disk and
  // the run that follows is an ordinary resume of whatever the session then
  // points at. Which of the two applies is decided here; the rewind itself
  // waits until the run has actually been admitted.
  const rewinds = sessionsService.providerRewindsForEdit(sessionId);

  await dispatchRun(
    ws,
    userId,
    sessionId,
    session,
    data,
    dependencies,
    // `null` is meaningful: the edited turn was the first prompt, so the
    // conversation starts over instead of resuming.
    rewinds
      ? {}
      : { resumeAnchorId: resumeThroughId ?? undefined, resumeFromScratch: resumeThroughId === null },
    async (run) => {
      // Emitted through the run's writer so it is sequenced and replayed like
      // any other event — a second tab watching this session has to truncate
      // too.
      //
      // Before the rewind, not after it. A rewind that has to branch spawns a
      // process and waits on a JSON-RPC round trip, and holding the frame
      // until that came back left the message the user had just edited away
      // sitting on screen for about a second — the very flicker this feature
      // exists to avoid. Announcing first is safe because a rewind that fails
      // still ends the run, and the terminal `complete` makes every client
      // re-read the transcript, which puts back anything that turned out not
      // to have been replaced after all.
      run.writer.send({
        kind: 'history_truncated',
        provider,
        sessionId,
        anchorId,
      });

      if (rewinds) {
        try {
          await sessionsService.rewindSessionForEdit(sessionId, resumeThroughId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendProtocolError(ws, 'EDIT_REWIND_FAILED', `Could not rewind the conversation: ${message}`, sessionId);
          // Ends the run before the provider is asked to continue a
          // conversation that was not rewound after all.
          throw error;
        }
      }
    },
  );
}

/**
 * Handles `chat.abort`: cancels the run for one app session and emits the
 * terminal `complete` on its behalf (runtimes skip their own complete for
 * aborted runs, and the registry drops any duplicate).
 */
async function handleChatAbort(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.abort requires a sessionId.');
    return;
  }

  const hadRunningRun = await chatRunRegistry.abortRun(
    sessionId,
    (provider, appSessionId) => dependencies.runtime.abort(provider, appSessionId),
  );
  if (!hadRunningRun) {
    sendProtocolError(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
  }
}

/**
 * The gateway's answers to a `chat.stop-task` that names scheduled work (see
 * `stopScheduledWork`), sent to the asking socket alone, without `seq`, and
 * never as a `protocol_error`, which the client takes as the session's run
 * failing. `taskId` is the id the stop named, and `clientRequestId` the
 * stop's own (see `readClientRequestId`), left out when it had none: every
 * pane on a page shares the socket, and two of them can stop the same item.
 *
 * - `stopped`: the provider runtime let go of its held process, which ended
 *   the work;
 * - `started`: the turn that has the model cancel the work has started;
 *   `finished` follows once it is over, with `stillHeld` saying whether any
 *   of the work it was to end is still held;
 * - `failed`: that turn was not started, as it would have replaced the held
 *   process and stopped the session's other background work, or the runtime
 *   failed to answer;
 * - `busy`: a turn is under way in the session, or the cancelling turn could
 *   not start: the stop can be asked again once it is over;
 * - `not_found`: the session holds no such work.
 */
type StopTaskStatusFrame = {
  kind: Extract<GatewayEventKind, 'stop_task_status'>;
  sessionId: string;
  taskId: string;
  status: 'stopped' | 'started' | 'finished' | 'failed' | 'busy' | 'not_found';
  stillHeld?: boolean;
  clientRequestId?: string;
  timestamp: string;
};

/**
 * Whether a `chat.stop-task` names scheduled work (`cron:` or `wakeup:`, see
 * `ScheduledWorkSummary.id`) rather than a background task. The provider
 * runtime checks the rest of the id.
 */
function namesScheduledWork(taskId: string): boolean {
  return taskId.startsWith('cron:') || taskId.startsWith('wakeup:');
}

/**
 * Stops scheduled work of a session for `chat.stop-task`: the item `taskId`
 * names, or all of it with `all`. Each step is answered with
 * `stop_task_status` (see `StopTaskStatusFrame`).
 *
 * Nothing is stopped while a turn is under way in the session. The provider
 * runtime stops what letting go of its held process stops; for the rest it
 * answers with a turn that has the model cancel the work (see
 * `ScheduledWorkStopResult`). That turn runs as the scheduled-messages
 * dispatcher runs a message, with no client attached: planned first, with
 * what its options leave out taken as the held process's own, and not
 * started when it would need a process of its own while that process is held
 * for background work, which the new process would stop. A session whose
 * process has gone starts one, which resumes the conversation, so the model
 * can cancel a CronCreate job the CLI brings back from the transcript; so
 * does a stop of paused work (the loops of the session no process runs,
 * `describePausedScheduledWork`), which the runtime then names, run with the
 * settings the session's last hold ran with, as a resume is. Once the
 * turn is over, the session's scheduled work tells whether the model did: a
 * self-paced loop's wake-up is never there, as no process brings it back.
 */
async function stopScheduledWork(
  ws: WebSocket,
  userId: string | number | null,
  target: {
    sessionId: string;
    taskId: string;
    all: boolean;
    clientRequestId: string | null;
    session: ReturnType<typeof sessionsDb.getSessionById> | null;
  },
  dependencies: ChatWebSocketDependencies,
): Promise<void> {
  const { sessionId, taskId, all, clientRequestId, session } = target;
  const reply = (status: StopTaskStatusFrame['status'], stillHeld?: boolean) => {
    const frame: StopTaskStatusFrame = {
      kind: 'stop_task_status',
      sessionId,
      taskId,
      status,
      ...(stillHeld === undefined ? {} : { stillHeld }),
      ...(clientRequestId ? { clientRequestId } : {}),
      timestamp: new Date().toISOString(),
    };
    sendJson(ws, frame);
  };

  const provider = session?.provider as LLMProvider | undefined;
  if (!session || !provider || !dependencies.runtime.hasRuntime(provider)) {
    reply('not_found');
    return;
  }
  if (chatRunRegistry.isProcessing(sessionId)) {
    reply('busy');
    return;
  }

  let stop: ScheduledWorkStopResult;
  let paused: ScheduledWorkSummary[] = [];
  try {
    // With no process of this server holding the session, the stop names
    // its paused work (the loops no process runs).
    paused = (await dependencies.runtime.describePausedScheduledWork?.(sessionId))?.items ?? [];
    stop = await dependencies.runtime.stopScheduledWork(provider, sessionId, taskId, {
      all,
      ...(paused.length > 0 ? { paused } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Chat] Provider runtime "${provider}" failed to stop scheduled work`, { sessionId, taskId, error: message });
    reply('failed');
    return;
  }
  if (stop.status !== 'turn') {
    reply(stop.status);
    if (stop.status === 'stopped') {
      dependencies.onScheduledWorkReleased?.(sessionId);
    }
    return;
  }

  // A stop of paused work starts a process that brings back every job the
  // transcript holds, those it leaves alone included, and is held for them:
  // it runs with what the session's last hold ran with, as a resume does
  // (readResumeOptions), the stop's own options over those.
  const turnOptions = paused.length > 0
    ? { ...(readResumeOptions(scheduleHoldsDb.get(sessionId)) ?? {}), ...stop.options }
    : stop.options;

  let plan: ProviderHandOverPlan;
  try {
    plan = await dependencies.runtime.planHandOver(
      provider,
      sessionId,
      // The options the turn's run gets (see dispatchRun), so the plan judges
      // the very turn that would run.
      buildTurnRunOptions({ sessionId, projectPath: session.project_path, clientOptions: turnOptions }),
      { inheritUnset: true },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Chat] Provider runtime "${provider}" could not plan the turn that cancels scheduled work`, {
      sessionId,
      error: message,
    });
    plan = { heldWork: true, canHandOver: false, changes: ['lookup'], switches: [] };
  }
  if (plan.heldWork && !plan.canHandOver) {
    console.log(`[Chat] Session ${sessionId}: not cancelling scheduled work, the turn would replace the process held for background work (${plan.changes.join(', ')})`);
    reply('failed');
    return;
  }

  const { targetIds } = stop;
  const result = await runDetachedChatTurn(
    {
      sessionId,
      userId,
      content: stop.content,
      options: turnOptions,
      onStarted: () => {
        // The asking socket follows the turn from its first frame. A turn
        // handed to the held process brings along whoever watched it (see
        // chatRunRegistry), but one that starts a process of its own, for a
        // session whose process has gone, has nobody watching.
        chatRunRegistry.attachConnection(sessionId, ws);
        reply('started');
      },
      onTurnEnded: () => {
        let stillHeld = true;
        try {
          const held = new Set(dependencies.runtime.listScheduledWork(sessionId).map((item) => item.id));
          stillHeld = targetIds.some((id) => held.has(id));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[Chat] Could not list scheduled work after the turn that cancels it', { sessionId, error: message });
        }
        reply('finished', stillHeld);
        if (!stillHeld) {
          dependencies.onScheduledWorkReleased?.(sessionId);
        }
      },
    },
    dependencies,
  );
  if (!result.started) {
    reply('busy');
  }
}

/**
 * Handles `chat.stop-task`: stops one background task of a session — an
 * agent, a workflow or a backgrounded command that is still going after its
 * turn ended. Unlike `chat.abort` there is no run to consult: the task lives
 * in the provider's held process, which is the only thing that can stop it.
 * The provider then reports the task as stopped on the session's stream, so
 * nothing is echoed back here on success.
 *
 * An id that names scheduled work (`cron:`, `wakeup:`) is stopped by
 * `stopScheduledWork` instead, and `allScheduled: true` stops all of the
 * session's: those are answered with `stop_task_status` frames, which carry
 * the stop's `clientRequestId` back.
 */
async function handleChatStopTask(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.stop-task requires a sessionId.');
    return;
  }

  const taskId = typeof data.taskId === 'string' ? data.taskId.trim() : '';
  if (!taskId) {
    sendProtocolError(ws, 'TASK_ID_REQUIRED', 'chat.stop-task requires a taskId.', sessionId);
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (namesScheduledWork(taskId)) {
    await stopScheduledWork(
      ws,
      userId,
      { sessionId, taskId, all: data.allScheduled === true, clientRequestId: readClientRequestId(data), session },
      dependencies,
    );
    return;
  }
  if (!session) {
    sendProtocolError(ws, 'SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`, sessionId);
    return;
  }

  const stopped = await dependencies.runtime.stopBackgroundTask(
    session.provider as LLMProvider,
    sessionId,
    taskId,
  );
  if (!stopped) {
    sendProtocolError(
      ws,
      'NO_SUCH_TASK',
      `Session "${sessionId}" has no running background task "${taskId}".`,
      sessionId,
    );
  }
}

/**
 * The gateway's answers to a `chat.resume-loops` (see handleChatResumeLoops),
 * sent to the asking socket alone, without `seq`, in the envelope of
 * `stop_task_status`. `clientRequestId` is the request's own, left out when
 * it had none.
 *
 * - `started`: the turn that resumes the loops has started; `finished`
 *   follows once it is over;
 * - `busy`: a turn is under way in the session, or the resuming turn could
 *   not start: the resume can be asked again once it is over;
 * - `held_elsewhere`: a Claude CLI outside this server holds the session,
 *   and runs its loops;
 * - `not_found`: the session has no paused loop, or a process of this
 *   server holds it;
 * - `failed`: the paused loops could not be read.
 */
type ResumeLoopsStatusFrame = {
  kind: Extract<GatewayEventKind, 'resume_loops_status'>;
  sessionId: string;
  status: 'started' | 'finished' | 'busy' | 'held_elsewhere' | 'not_found' | 'failed';
  clientRequestId?: string;
  timestamp: string;
};

/**
 * Handles `chat.resume-loops`: resumes the session's paused loops, those no
 * process runs (see `PausedScheduledWork`), in a turn that runs as
 * `chat.stop-task` runs its cancelling turn, with no client attached and the
 * asking socket following it once it starts. The turn's message and run
 * options come from `planLoopsResume`: the settings the session's last hold
 * ran with, else the settings among the request's `options` (the
 * composer's). Its process brings the cron jobs back from the transcript and
 * is held for them; the model sets the self-paced loop's wake-up again. The
 * resumed process records its own hold in place of the last one's; that
 * record is removed once the turn has finished if nothing replaced it, and
 * kept when the turn failed (its CLI could not start, say) or was aborted,
 * for the next resume. Each step is answered with `resume_loops_status` (see
 * `ResumeLoopsStatusFrame`).
 */
async function handleChatResumeLoops(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.resume-loops requires a sessionId.');
    return;
  }
  const clientRequestId = readClientRequestId(data);
  const reply = (status: ResumeLoopsStatusFrame['status']) => {
    const frame: ResumeLoopsStatusFrame = {
      kind: 'resume_loops_status',
      sessionId,
      status,
      ...(clientRequestId ? { clientRequestId } : {}),
      timestamp: new Date().toISOString(),
    };
    sendJson(ws, frame);
  };

  const session = sessionsDb.getSessionById(sessionId);
  const provider = session?.provider as LLMProvider | undefined;
  if (!session || !provider || !dependencies.runtime.hasRuntime(provider)) {
    reply('not_found');
    return;
  }
  if (chatRunRegistry.isProcessing(sessionId)) {
    reply('busy');
    return;
  }

  let plan: LoopsResumePlan;
  try {
    plan = await planLoopsResume(sessionId, dependencies.runtime, data.options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Chat] Could not read the paused loops of a session', { sessionId, error: message });
    reply('failed');
    return;
  }
  if (plan.status !== 'turn') {
    reply(plan.status === 'held_elsewhere' ? 'held_elsewhere' : 'not_found');
    return;
  }

  const { content, options, itemIds } = plan;
  const stored = scheduleHoldsDb.get(sessionId);
  const result = await runDetachedChatTurn(
    {
      sessionId,
      userId,
      content,
      options,
      onStarted: () => {
        console.log(`[Chat] Session ${sessionId}: resuming ${itemIds.length} paused loop(s): ${itemIds.join(', ')}`);
        chatRunRegistry.attachConnection(sessionId, ws);
        reply('started');
      },
      onTurnEnded: ({ outcome }) => {
        if (stored && outcome === 'done') {
          scheduleHoldsDb.removeForRun(sessionId, stored.runId);
        }
        reply('finished');
      },
    },
    dependencies,
  );
  if (!result.started) {
    reply('busy');
  }
}

/**
 * Why a `chat.insert` was refused, which tells the client how to fall back
 * (see `NormalizedMessage['insertReason']`).
 */
type InsertRefusalReason = 'NO_ACTIVE_RUN' | 'UNSUPPORTED' | 'SLASH_COMMAND' | 'INVALID';

/**
 * How a client names an insert: a UUID it generates, which the runtime also
 * writes to the CLI as the message's uuid.
 */
const INSERT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The reason a `cancel_failed` carries for a withdrawal the runtime did not
 * make. Its own `cancel_failed` (the CLI is already delivering the insert)
 * carries none, and so does a status this table does not know: the client
 * keeps the card until the insert reports how it ended.
 */
const CANCEL_FAILURE_REASONS: Partial<Record<ProviderCancelInsertGatewayResult['status'], string>> = {
  not_found: 'NOT_FOUND',
  unsupported: 'UNSUPPORTED',
};

/**
 * Answers a `chat.insert` or `chat.insert-cancel` straight back to the socket
 * that sent it, as an `insert_status` without `seq`: only the asking client
 * needs to hear that its request went nowhere. Every pane sharing the socket
 * gets it, so the client matches it to the composer that sent it by
 * `insertId`.
 *
 * Never a `protocol_error`: the client handles one that names a session by
 * marking the session idle and adding an error bubble, which would break the
 * very run the insert was meant for.
 */
function sendInsertReply(
  ws: WebSocket,
  reply: {
    sessionId: string | null;
    insertId: string | null;
    insertStatus: Extract<InsertStatus, 'refused' | 'cancel_failed' | 'failed'>;
    insertReason?: string;
    content?: string;
    provider?: LLMProvider;
  },
): void {
  sendJson(ws, {
    kind: 'insert_status' satisfies MessageKind,
    id: generateMessageId('insert_status'),
    ...reply,
    timestamp: new Date().toISOString(),
  });
}

/** Whether an insert frame carries attachments, which inserts do not take. */
function carriesAttachments(data: AnyRecord): boolean {
  const options = (data.options ?? {}) as AnyRecord;
  return [options.images, options.files, options.attachments]
    .some((candidates) => normalizeAttachmentDescriptors(candidates).length > 0);
}

/**
 * Narrows a runtime's refusal to the reasons the client acts on. DUPLICATE
 * (the insertId was used before in this run) is a malformed request from the
 * client's side, as is any reason a runtime made up.
 */
function readInsertRefusalReason(reason: string): InsertRefusalReason {
  return reason === 'NO_ACTIVE_RUN' || reason === 'UNSUPPORTED' ? reason : 'INVALID';
}

/**
 * Handles `chat.insert`: writes a user message into the session's running
 * turn, which the model reads once its current tool batch ends instead of
 * after the turn (see `IProviderRuntime.insert`; Claude only today).
 *
 * Everything the client has to fall back on is answered here as a `refused`
 * `insert_status`: a malformed frame or unknown session (INVALID), no turn in
 * progress (NO_ACTIVE_RUN), a slash command (SLASH_COMMAND), a provider that
 * cannot insert (UNSUPPORTED). An accepted insert is reported by the runtime
 * through the run's writer, starting with `pending`, so nothing is echoed.
 */
async function handleChatInsert(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  const insertId = typeof data.insertId === 'string' ? data.insertId : null;
  const content = typeof data.content === 'string' ? data.content : null;
  const refuse = (insertReason: InsertRefusalReason, provider?: LLMProvider) => {
    sendInsertReply(ws, {
      sessionId,
      insertId,
      insertStatus: 'refused',
      insertReason,
      content: content ?? undefined,
      provider,
    });
  };

  if (
    !sessionId
    || !insertId
    || !INSERT_ID_PATTERN.test(insertId)
    || !content?.trim()
    // Text only: the composer queues a message with attachments instead.
    || carriesAttachments(data)
  ) {
    refuse('INVALID');
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    refuse('INVALID');
    return;
  }

  const provider = session.provider as LLMProvider;
  if (!dependencies.runtime.hasRuntime(provider)) {
    refuse('UNSUPPORTED', provider);
    return;
  }

  // Only a turn in progress takes an insert. A turn that has ended with only
  // background work left does not: the client sends normally instead.
  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running') {
    refuse('NO_ACTIVE_RUN', provider);
    return;
  }

  // After the run check, because an idle session takes a slash command as a
  // normal send, which is what NO_ACTIVE_RUN leads to. A busy one queues it:
  // the CLI would only run it once the turn is over. Leading whitespace does
  // not keep a command from counting.
  if (content.trimStart().startsWith('/')) {
    refuse('SLASH_COMMAND', provider);
    return;
  }

  // Before the runtime is called: it reports `pending` through the run's
  // writer while it accepts, and the asking socket has to hear that even if
  // it never subscribed to this run.
  chatRunRegistry.attachConnection(sessionId, ws);

  let result: ProviderInsertGatewayResult;
  try {
    result = await dependencies.runtime.insert(provider, sessionId, { insertId, content });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Chat] Provider runtime "${provider}" failed to take an insert`, { sessionId, insertId, error: message });
    // Reported as the insert's end, so the client puts the text back in the
    // composer it came from.
    sendInsertReply(ws, { sessionId, insertId, insertStatus: 'failed', insertReason: 'INTERNAL_ERROR', content, provider });
    return;
  }

  if (!result.accepted) {
    refuse(readInsertRefusalReason(result.reason), provider);
  }
}

/**
 * Handles `chat.insert-cancel`: withdraws an insert the model has not read.
 *
 * A withdrawn insert is reported by the runtime through the run's writer as
 * a `cancelled` `insert_status`, so every tab drops its card and nothing is
 * echoed here. Anything else comes straight back as `cancel_failed`, with no
 * reason when the CLI is already delivering the insert, NOT_FOUND when the
 * session's run does not hold it (it has ended, or never existed),
 * UNSUPPORTED when the provider cannot insert, INVALID for a malformed frame
 * or unknown session, and INTERNAL_ERROR when the runtime threw.
 *
 * Unlike `chat.insert` there is no run check: the runtime is what knows
 * which inserts are still pending.
 */
async function handleChatInsertCancel(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  const insertId = typeof data.insertId === 'string' ? data.insertId : null;
  const fail = (insertReason?: string, provider?: LLMProvider) => {
    sendInsertReply(ws, { sessionId, insertId, insertStatus: 'cancel_failed', insertReason, provider });
  };

  if (!sessionId || !insertId || !INSERT_ID_PATTERN.test(insertId)) {
    fail('INVALID');
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    fail('INVALID');
    return;
  }

  const provider = session.provider as LLMProvider;
  if (!dependencies.runtime.hasRuntime(provider)) {
    fail('UNSUPPORTED', provider);
    return;
  }

  // The runtime reports `cancelled` through the run's writer; the asking
  // socket has to hear it.
  chatRunRegistry.attachConnection(sessionId, ws);

  let result: ProviderCancelInsertGatewayResult;
  try {
    result = await dependencies.runtime.cancelInsert(provider, sessionId, insertId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Chat] Provider runtime "${provider}" failed to withdraw an insert`, { sessionId, insertId, error: message });
    fail('INTERNAL_ERROR', provider);
    return;
  }

  if (result.status !== 'cancelled') {
    fail(CANCEL_FAILURE_REASONS[result.status], provider);
  }
}

/**
 * Handles `chat.subscribe`: for each requested session, reports whether a run
 * is processing, re-attaches the live stream to this socket, replays missed
 * events (seq > lastSeq), and includes pending permission requests.
 *
 * This single message replaces the old `check-session-status`,
 * `get-pending-permissions`, and Claude-only writer reconnect flows.
 */
function handleChatSubscribe(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): void {
  const targets = Array.isArray(data.sessions) ? data.sessions : [];

  for (const target of targets) {
    if (!target || typeof target !== 'object') {
      continue;
    }

    const sessionId = typeof (target as AnyRecord).sessionId === 'string'
      ? ((target as AnyRecord).sessionId as string).trim()
      : '';
    if (!sessionId) {
      continue;
    }

    const lastSeqRaw = (target as AnyRecord).lastSeq;
    const lastSeq = typeof lastSeqRaw === 'number' && Number.isFinite(lastSeqRaw)
      ? Math.max(0, Math.floor(lastSeqRaw))
      : 0;

    const run = chatRunRegistry.getRun(sessionId);
    const isProcessing = chatRunRegistry.isProcessing(sessionId);

    // Future live events for this run should land on the socket that asked —
    // this is what makes mid-stream page refreshes work for all providers.
    // A session whose turn ended but whose background or scheduled work is
    // still going keeps producing events through the same writer (task
    // progress, the turn the CLI pushes when a task reports or a /loop's
    // wake-up or cron job fires), so a tab opened during that work attaches
    // too; the registry keeps the run while the work lasts.
    if (isProcessing || holdsWorkPastTurn(dependencies.runtime, sessionId)) {
      chatRunRegistry.attachConnection(sessionId, ws);
    }

    // Pending approvals are tracked under the app session id inside the
    // Claude runtime, so they can be looked up directly.
    const pendingPermissions = dependencies.runtime.getPendingApprovalsForSession(sessionId);

    sendJson(ws, {
      kind: 'chat_subscribed',
      sessionId,
      isProcessing,
      lastSeq: run?.lastSeq ?? 0,
      pendingPermissions,
      timestamp: new Date().toISOString(),
    });

    // Replay only for RUNNING runs, strictly after the ack. Completed runs
    // are fully persisted to the provider transcript and served over REST —
    // replaying them (e.g. after a page reload where the client's lastSeq is
    // 0) would duplicate messages the history fetch already returned.
    if (isProcessing) {
      for (const event of chatRunRegistry.replayEvents(sessionId, lastSeq)) {
        sendJson(ws, event);
      }
    }
  }
}

/**
 * Handles `chat.permission-response`: forwards a tool-approval decision to the
 * pending approval resolver (Claude is the only provider with interactive
 * approvals today, but the message is intentionally provider-neutral).
 */
function handlePermissionResponse(data: AnyRecord, dependencies: ChatWebSocketDependencies): void {
  if (typeof data.requestId !== 'string' || data.requestId.length === 0) {
    return;
  }

  dependencies.runtime.resolveToolApproval(data.requestId, {
    allow: Boolean(data.allow),
    updatedInput: data.updatedInput,
    message: typeof data.message === 'string' ? data.message : undefined,
    rememberEntry: data.rememberEntry,
  });
}

/**
 * Runs a turn for a session with no client attached.
 *
 * Used by scheduled messages, which fire from a timer: there is no socket to
 * report errors to and no audience to stream to. The chat gateway's stop of
 * scheduled work runs its cancelling turn this way too (`stopScheduledWork`),
 * telling the asking socket how it goes through `onStarted` and
 * `onTurnEnded`. The run is registered exactly like an interactive one, so
 * anyone who opens the session while it is going subscribes and replays it
 * from the start, and the session shows as busy everywhere in the meantime.
 *
 * Resolves when the provider run settles, which for a turn that leaves
 * background work going is when its process exits, or as soon as the turn is
 * over and the provider has handed that process to the session's next run
 * (a message went into the process as its next turn and keeps the work
 * going): the caller waits for its own run, not for a process the next turn
 * has taken on. The run itself still finishes in the background, safety net
 * included. `onTurnEnded` tells the caller earlier, as the turn ends. Returns
 * false when the session has gone away or is busy without
 * `interruptActiveRun`, which the caller reports on the schedule.
 *
 * `options` are the server's own, never a client's: an
 * `acceptProcessSettings: true` or an `ownSettings` among them reaches the
 * run, which `buildTurnRunOptions` drops from a `chat.send`. Only the
 * scheduled-messages dispatcher sets them: the first once its plan said the
 * held process takes the turn, the second for a turn that borrows the held
 * process's settings (see `IProviderRuntime.run`).
 */
export async function runDetachedChatTurn(
  input: {
    sessionId: string;
    userId: string | number | null;
    content: string;
    options?: AnyRecord;
    /**
     * Aborts a run already in progress instead of refusing to start. A
     * scheduled message sets this: the user picked the time knowing it might
     * land mid-run, so the timer outranks a running turn. The dispatcher
     * waits instead while the session holds background work of its own,
     * which the abort would stop.
     */
    interruptActiveRun?: boolean;
    /**
     * Called once the turn is over: its run's terminal `complete` has gone
     * out, however the turn ended (`outcome`, see readTurnOutcome). Never
     * called for a run that did not start, which the result reports. The
     * scheduled-messages dispatcher holds the session until then: the run can
     * stay open for hours after, holding its process for work the turn left
     * going, and the session's next messages may go into that process
     * meanwhile.
     */
    onTurnEnded?: (ended: { outcome: DetachedTurnOutcome }) => void;
    /**
     * Called once the turn's run has started: the session is reserved for
     * it, and the provider runtime is about to get the turn. Never called
     * for a run that did not start. The chat gateway's stop of scheduled
     * work tells the asking socket then.
     */
    onStarted?: () => void;
    /**
     * Called before the result settles when the provider runtime turned the
     * turn away at the hand-over (see `HandOverFailure`), which only a turn
     * whose options set `acceptProcessSettings: true` or
     * `keepBackgroundWork: true` can be. The scheduled-messages dispatcher
     * puts a queued message back in the queue then, and records why a due
     * one failed, or tries it again.
     */
    onHandOverFailed?: (failure: HandOverFailure) => void;
  },
  dependencies: ChatWebSocketDependencies,
): Promise<{ started: boolean; error: string | null }> {
  const session = sessionsDb.getSessionById(input.sessionId);
  if (!session) {
    return { started: false, error: 'The session no longer exists.' };
  }

  const provider = session.provider as LLMProvider;
  if (!dependencies.runtime.hasRuntime(provider)) {
    return { started: false, error: `Provider "${provider}" is not available.` };
  }

  const activeRun = chatRunRegistry.getRun(input.sessionId);
  if (activeRun && activeRun.status === 'running') {
    if (!input.interruptActiveRun) {
      return { started: false, error: 'A run was already in progress for this session.' };
    }
    // Same as `chat.abort`: cancel the provider run and emit the terminal
    // `complete` on its behalf, so every watching client sees the
    // interrupted run end before this turn's stream begins. The interrupted
    // run's own dispatch settles later through completeRunIfCurrent, which is
    // scoped to that run and cannot touch the one started here.
    await chatRunRegistry.abortRun(
      input.sessionId,
      (provider, appSessionId) => dependencies.runtime.abort(provider, appSessionId),
    );
  }

  // Settles only if the turn's process goes on to the session's next run; the
  // run is known once dispatchRun has reserved the session.
  let settleOnHandOver: (result: { started: boolean; error: string | null }) => void = () => {};
  const handedOver = new Promise<{ started: boolean; error: string | null }>((resolve) => {
    settleOnHandOver = resolve;
  });
  const { onTurnEnded, onStarted, onHandOverFailed } = input;
  const dispatched = dispatchRun(
    null,
    input.userId,
    input.sessionId,
    session,
    { sessionId: input.sessionId, content: input.content, options: input.options ?? {} },
    dependencies,
    {
      ...(input.options?.acceptProcessSettings === true ? { acceptProcessSettings: true } : {}),
      ...(input.options?.ownSettings !== undefined ? { ownSettings: input.options.ownSettings } : {}),
    },
    (run) => {
      void chatRunRegistry.whenHandedOver(run).then(() => settleOnHandOver({ started: true, error: null }));
      if (onTurnEnded) {
        void chatRunRegistry.whenCompleted(run).then(() => onTurnEnded({ outcome: readTurnOutcome(run) }));
      }
      onStarted?.();
    },
  ).then(({ handOverFailure, ...result }) => {
    if (handOverFailure) {
      onHandOverFailed?.(handOverFailure);
    }
    return result;
  });
  return Promise.race([dispatched, handedOver]);
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 * Used by the websocket server service for every chat connection.
 *
 * Inbound protocol (client to server):
 * - `chat.send`                { sessionId, content, options?, clientRequestId? } (`options.keepBackgroundWork`:
 *                              refuse rather than stop the session's background work; the refusal
 *                              carries the send's `clientRequestId`)
 * - `chat.edit-send`           { sessionId, anchorId, content, options? }
 * - `chat.insert`              { sessionId, insertId, content }
 * - `chat.insert-cancel`       { sessionId, insertId }
 * - `chat.abort`               { sessionId }
 * - `chat.stop-task`           { sessionId, taskId, allScheduled?, clientRequestId? } (a `cron:` or `wakeup:`
 *                              taskId names scheduled work; `allScheduled` stops all of the session's; its
 *                              `stop_task_status` answers carry the stop's `clientRequestId`)
 * - `chat.resume-loops`        { sessionId, options?, clientRequestId? } (resumes the loops a restart left
 *                              paused; answered with `resume_loops_status`)
 * - `chat.subscribe`           { sessions: [{ sessionId, lastSeq? }] }
 * - `chat.permission-response` { requestId, allow, updatedInput?, message?, rememberEntry? }
 *
 * Outbound protocol (server to client): every frame is `kind`-based — either
 * a provider `NormalizedMessage` (with `seq`) or a gateway event
 * (`chat_subscribed`, `session_upserted`, `run_ended`, `loading_progress`,
 * `protocol_error`, `send_refused`, `stop_task_status`, `resume_loops_status`). `insert_status`
 * comes both ways: a runtime's go out through the run's writer with `seq`,
 * while the gateway answers a refused insert or a failed cancel to the
 * asking socket alone, without one. `send_refused` goes the same way, for a
 * `chat.send` with `keepBackgroundWork` that would have stopped the session's
 * background work, and so does `stop_task_status`, for a `chat.stop-task`
 * that names scheduled work, and `resume_loops_status`, for a
 * `chat.resume-loops`.
 */
export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  console.log('[INFO] Chat WebSocket connected');
  connectedClients.add(ws);

  const userId = readRequestUserId(request);

  ws.on('message', async (rawMessage) => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as AnyRecord;
      const messageType = typeof data.type === 'string' ? data.type : '';

      switch (messageType) {
        case 'chat.edit-send':
          await handleChatEditSend(ws, userId, data, dependencies);
          return;
        case 'chat.send':
          await handleChatSend(ws, userId, data, dependencies);
          return;
        case 'chat.insert':
          await handleChatInsert(ws, data, dependencies);
          return;
        case 'chat.insert-cancel':
          await handleChatInsertCancel(ws, data, dependencies);
          return;
        case 'chat.abort':
          await handleChatAbort(ws, data, dependencies);
          return;
        case 'chat.stop-task':
          await handleChatStopTask(ws, userId, data, dependencies);
          return;
        case 'chat.resume-loops':
          await handleChatResumeLoops(ws, userId, data, dependencies);
          return;
        case 'chat.subscribe':
          handleChatSubscribe(ws, data, dependencies);
          return;
        case 'chat.permission-response':
          handlePermissionResponse(data, dependencies);
          return;
        default:
          sendProtocolError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type "${messageType}".`);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      sendProtocolError(ws, 'INTERNAL_ERROR', message);
    }
  });

  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
  });
}
