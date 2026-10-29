import { scheduledMessagesDb, sessionDraftsDb, sessionsDb } from '@/modules/database/index.js';
import type { QueuedSessionMessageRecord, ScheduledMessageRow } from '@/modules/database/index.js';
import type { HandOverFailureCode } from '@/modules/scheduled-messages/services/scheduled-messages.service.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { HandOverFailure, ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type { AnyRecord, HandOverChange, LLMProvider, ProviderHandOverPlan } from '@/shared/types.js';
import { buildTurnRunOptions, readQueuedChatMessage } from '@/shared/utils.js';

/**
 * How often due messages are looked for.
 *
 * A minute is the granularity the composer offers, and the due query is
 * indexed on `(status, scheduled_for)`, so the poll is one cheap query.
 * Anything finer would buy precision nobody asked for.
 */
const POLL_INTERVAL_MS = 30_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * How long a queued message the held process turned away at the hand-over
 * (HAND_OVER_FAILED) waits before it is tried again: a poll after the first
 * time, twice as long after each further time in a row, ten minutes at most.
 * Each try that fails adds an error row to the conversation.
 */
const HAND_OVER_RETRY_FIRST_MS = POLL_INTERVAL_MS;
const HAND_OVER_RETRY_MAX_MS = 10 * 60_000;
/**
 * How much sooner than its time a retry may go, so the timer's jitter does
 * not push a retry due on a poll to the poll after it.
 */
const HAND_OVER_RETRY_SLACK_MS = 1_000;

/**
 * Per session, the queued message the held process turned away at the
 * hand-over: how many times in a row (`failures`), when it may be tried
 * again (`retryAt`), and the stored value it was (`claimToken`, see
 * `QueuedSessionMessageRecord`). It waits only while the session's process
 * is still held for scheduled work, the only hold such a turn goes into
 * (`acceptsProcessSettings`), and only as it was: one that has changed since
 * (more was queued onto it, or it was replaced) goes as any would. A queued
 * turn that goes through, or fails otherwise, clears the session.
 */
const handOverRetries = new Map<string, { failures: number; retryAt: number; claimToken: string }>();

/**
 * Records that the held process turned `candidate`'s turn away at the
 * hand-over, in the pass that started at `now`, and returns how long the
 * message now waits.
 */
function noteHandOverFailure(candidate: QueuedSessionMessageRecord, now: Date): number {
  const failures = (handOverRetries.get(candidate.sessionId)?.failures ?? 0) + 1;
  const delay = Math.min(HAND_OVER_RETRY_FIRST_MS * 2 ** (failures - 1), HAND_OVER_RETRY_MAX_MS);
  handOverRetries.set(candidate.sessionId, {
    failures,
    retryAt: now.getTime() + delay - HAND_OVER_RETRY_SLACK_MS,
    claimToken: candidate.claimToken,
  });
  return delay;
}

/** Whether `candidate` is a turned-away queued message still waiting to be tried again (see `handOverRetries`). */
function waitsToRetryHandOver(
  candidate: QueuedSessionMessageRecord,
  now: Date,
  runtime: ProviderRuntimeGateway,
): boolean {
  const retry = handOverRetries.get(candidate.sessionId);
  return retry !== undefined
    && retry.claimToken === candidate.claimToken
    && now.getTime() < retry.retryAt
    && runtime.hasScheduledWork(candidate.sessionId);
}

/**
 * A due pass asking whether a session's next due message can go
 * (`dueTurnToSend`), while it holds the session to ask (see
 * `sessionsInFlight`). `answered` settles, through `settle`, once the pass
 * has acted on the answer: it started the message's turn, and holds the
 * session for it, or it let go of the session, the message left to wait. A
 * message it could not claim (cancelled while the pass asked) started
 * nothing: its check stays open until the check of the session's next due
 * message takes its place, or the pass lets go of the session.
 */
type DueCheck = { answered: Promise<void>; settle: () => void };

/**
 * Sessions the dispatcher holds: a scheduled or queued turn it started is
 * under way there, or a due pass is asking whether the session's next due
 * message can go (its `DueCheck`).
 *
 * Kept per session rather than as one flag for the whole dispatcher, so one
 * session's turn holds up no other session's messages. Passes skip a session
 * held for a turn and leave its messages as they are, which keeps one
 * session's messages in order and stops two of its turns racing into it. A
 * queued pass waits for a due check's answer instead (see
 * `dispatchQueuedMessages`): a due message that can go goes first, and one
 * that has to wait keeps no queued message back.
 *
 * A session is held until the turn is over, not until its run settles. That
 * can be hours later: a turn that leaves work going (a /loop's wake-up, a
 * backgrounded build, agent or workflow) keeps its CLI process open until the
 * work is done. From the turn's end the next pass treats the session like any
 * other, whose messages wait only while sending them would disturb the work
 * its process is held for (`wouldDisturbHeldWork`, and `dueTurnToSend` for a
 * turn under way): one the held process can take goes into it as its next
 * turn, and so does one kept out only by its effort, ultracode or tool rules
 * while the process is held for scheduled work alone, which then runs on the
 * process's own, unless its tool rules are stricter (`planTurn`).
 */
const sessionsInFlight = new Map<string, DueCheck | null>();

/**
 * A message as the dispatcher sends it: its content, and the options its
 * turn runs with, as `runDetachedChatTurn` takes them (`dispatchedOptions`,
 * with `acceptProcessSettings: true` added by `planTurn` when the turn takes
 * the held process's settings, which `runDetachedChatTurn` alone passes on
 * to the run). Read once per message, so the hand-over plan and the turn see
 * the same options.
 */
type DispatchedTurn = { content: string; options: AnyRecord };

/** How a message's run settled (see `runDetachedChatTurn`). */
type DispatchedTurnResult = Awaited<ReturnType<typeof runDetachedChatTurn>>;

/**
 * The options a message's turn runs with: the ones its client sent with it,
 * `inheritUnset: true` and `restoreSwitchesAfterTurn: true`. The dispatcher
 * plans the turn with unset settings taken as the held process's own
 * (`planMessageTurn`), and a run with `inheritUnset` hands its turn to that
 * process the same way (see `ProviderHandOverPlanOptions`). Without it, the
 * run would read what the message leaves out as a new process would (no tool
 * rules, permissions not skipped): it would switch a /loop's process out of
 * bypassPermissions, or replace the process and stop the work the plan said
 * it would keep. A turn handed to the held process with another model or
 * permission mode switches the process to them for that turn only:
 * `restoreSwitchesAfterTurn` has the provider switch it back once the turn is
 * over, so the work the process is held for runs on as it did (see
 * `wouldDisturbHeldWork`), and the chat gateway then puts back the model the
 * session had recorded before the turn. An `acceptProcessSettings` the
 * client stored is dropped: only `planTurn` decides that a turn takes the
 * held process's settings.
 */
function dispatchedOptions(clientOptions: AnyRecord): AnyRecord {
  const { acceptProcessSettings: _acceptProcessSettings, ...options } = clientOptions;
  return { ...options, inheritUnset: true, restoreSwitchesAfterTurn: true };
}

function readOptions(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function logSendFailure(sessionId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[ScheduledMessages] Sending to a session failed', { sessionId, error: message });
}

/**
 * Runs one session's sends, unless the dispatcher already holds that
 * session, and returns them as a promise, or null when it skipped them.
 * `send` resolves once the dispatcher may let go of the session: the turns
 * it started there are over, or it left the session's messages to wait.
 *
 * The session is marked before `send` reaches its first await, so a pass that
 * starts meanwhile (the next poll, or two passes started together) skips it,
 * or, for a queued pass, waits for the due check `send` opens. A failure is
 * logged here rather than passed on, so one session's error does not fail the
 * pass for the others.
 */
function sendUnlessInFlight(sessionId: string, send: () => Promise<void>): Promise<void> | null {
  if (sessionsInFlight.has(sessionId)) {
    return null;
  }

  sessionsInFlight.set(sessionId, null);
  return send()
    .catch((error: unknown) => {
      logSendFailure(sessionId, error);
    })
    .finally(() => {
      // A due check still open is answered by letting go: its message waits,
      // or could not be claimed. Deleted first, so a queued pass that wakes
      // on the answer finds the session free.
      const check = sessionsInFlight.get(sessionId);
      sessionsInFlight.delete(sessionId);
      check?.settle();
    });
}

/**
 * Opens a due check on a session the due pass holds (see `DueCheck`). The
 * pass closes it once it has started the message's turn (`closeDueCheck`);
 * one still open when the session is let go is answered then
 * (`sendUnlessInFlight`). A check the previous message left open, as it
 * could not be claimed, is answered once this one stands in its place, so a
 * queued pass waiting on it waits on this one next (`waitForDueChecks`).
 */
function openDueCheck(sessionId: string): void {
  let settle = () => {};
  const answered = new Promise<void>((resolve) => { settle = resolve; });
  const previous = sessionsInFlight.get(sessionId);
  sessionsInFlight.set(sessionId, { answered, settle });
  previous?.settle();
}

/**
 * Closes the session's due check: the session stays held, for the turn the
 * due pass started. Called only once that turn has its run.
 */
function closeDueCheck(sessionId: string): void {
  const check = sessionsInFlight.get(sessionId);
  if (check) {
    sessionsInFlight.set(sessionId, null);
    check.settle();
  }
}

/**
 * Settles once no due check is open on the session, including the checks a
 * due pass opens one after another for the session's later messages.
 */
async function waitForDueChecks(sessionId: string): Promise<void> {
  for (let check = sessionsInFlight.get(sessionId); check; check = sessionsInFlight.get(sessionId)) {
    await check.answered;
  }
}

/**
 * Runs a message's turn (`runDetachedChatTurn`) and resolves once the turn is
 * over, with how its run settles (`settled`). The run can settle hours later:
 * a turn that leaves work going keeps its process, and its run, open until
 * the work is done, or until a later turn of the session goes into that
 * process. The dispatcher holds the session only until the turn is over, and
 * reads the outcome when the run settles. A run that did not start, or that
 * settled without its turn completing, is over as it settles.
 *
 * The turn's run is reserved before this first awaits, unless the turn has
 * to interrupt a run under way first (`interruptActiveRun`).
 */
async function runMessageTurn(
  input: Omit<Parameters<typeof runDetachedChatTurn>[0], 'onTurnEnded'>,
  runtime: ProviderRuntimeGateway,
): Promise<{ settled: Promise<DispatchedTurnResult> }> {
  let endTurn = () => {};
  const turnEnded = new Promise<void>((resolve) => { endTurn = resolve; });
  const settled = runDetachedChatTurn({ ...input, onTurnEnded: endTurn }, { runtime });
  await Promise.race([turnEnded, settled.then(() => undefined, () => undefined)]);
  return { settled };
}

/** The turn a queued message runs, or null when it has nothing to send. */
function readQueuedTurn(candidate: QueuedSessionMessageRecord): DispatchedTurn | null {
  const message = readQueuedChatMessage(candidate.queuedMessage);
  return message
    ? { content: message.content, options: dispatchedOptions({ ...message.options, attachments: message.attachments }) }
    : null;
}

/**
 * Sends a claimed queued message's turn, in the pass that started at `now`,
 * and resolves once the turn is over. What follows its run's settling
 * (putting the message back when another run took the session first, or the
 * held process turned the turn away at the hand-over, then to wait before it
 * is tried again; dropping the draft the message leaves empty) goes into
 * `outcomes`.
 */
async function sendClaimedQueuedMessage(
  candidate: QueuedSessionMessageRecord,
  turn: DispatchedTurn | null,
  runtime: ProviderRuntimeGateway,
  outcomes: Promise<void>[],
  now: Date,
): Promise<void> {
  if (!turn) {
    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    return;
  }

  let handOverFailure: HandOverFailure | null = null;
  const { settled } = await runMessageTurn(
    {
      sessionId: candidate.sessionId,
      userId: candidate.userId,
      content: turn.content,
      options: turn.options,
      onHandOverFailed: (failure) => { handOverFailure = failure; },
    },
    runtime,
  );

  outcomes.push(settled
    .then((result) => {
      // The registry check and run reservation are separate operations. If a
      // run wins that tiny race, put the turn back so the next poll tries again.
      if (!result.started && result.error === 'A run was already in progress for this session.') {
        sessionDraftsDb.restoreQueuedMessage(candidate);
        return;
      }
      // The held process did not take the turn after all (`planTurn`), and it
      // and its work go on: the message goes back in the queue, the draft
      // with it, for a pass to plan again once it has waited
      // (`handOverRetries`).
      if (handOverFailure) {
        const retryInMs = noteHandOverFailure(candidate, now);
        console.warn('[ScheduledMessages] The held process turned a queued message away; it goes back in the queue', {
          sessionId: candidate.sessionId,
          reason: handOverFailure.reason,
          retryInMs,
        });
        sessionDraftsDb.restoreQueuedMessage(candidate);
        return;
      }
      handOverRetries.delete(candidate.sessionId);
      sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    })
    .catch((error: unknown) => {
      logSendFailure(candidate.sessionId, error);
    }));
}

/**
 * Whether a queued turn has to keep waiting for the session, as far as the
 * run registry and the task tracker tell: a turn is under way, or a provider
 * runtime still tracks background work its turns started (a backgrounded
 * command, agent or workflow). A queued turn was promised to go "when this
 * finishes", so it waits for that work too. Held work no task reports is
 * asked about next, for the turn itself (`wouldDisturbHeldWork`).
 */
function isSessionBusy(sessionId: string, runtime: ProviderRuntimeGateway): boolean {
  return chatRunRegistry.isProcessing(sessionId) || runtime.hasBackgroundWork(sessionId);
}

/**
 * The provider runtime's hand-over plan for a message's turn (see
 * `ProviderHandOverPlan`): what sending it now would make of the process the
 * session's runtime holds for background work of its own.
 *
 * Asked with the run options `runDetachedChatTurn` gives the message's run
 * (`buildTurnRunOptions` over `dispatchedOptions`), so it judges the turn
 * that would run, and with unset settings taken as the live process's own
 * (`inheritUnset`, which those options set for the run too): a scheduled
 * message carries only the model, effort and permission mode it was
 * scheduled with, not the tool rules a composer send carries, and a setting
 * it leaves unset is no difference to the process. A turn whose options set
 * `acceptProcessSettings: true` (see `planTurn`) is planned with it too, in
 * the run options as `runDetachedChatTurn` passes it on, and in the plan
 * options.
 *
 * Null for a session the dispatcher cannot run (gone, or its provider
 * unavailable): the send reports that. Null, too, for a plan the runtime
 * fails to make, which is logged: the message is then judged as if nothing
 * were held, and goes as it did before the dispatcher asked.
 */
async function planMessageTurn(
  sessionId: string,
  turnOptions: AnyRecord,
  runtime: ProviderRuntimeGateway,
): Promise<ProviderHandOverPlan | null> {
  const session = sessionsDb.getSessionById(sessionId);
  if (!session || !runtime.hasRuntime(session.provider)) {
    return null;
  }
  const accepting = turnOptions.acceptProcessSettings === true;
  try {
    return await runtime.planHandOver(
      session.provider as LLMProvider,
      sessionId,
      buildTurnRunOptions({
        sessionId,
        projectPath: session.project_path,
        clientOptions: turnOptions,
        extraOptions: accepting ? { acceptProcessSettings: true } : undefined,
      }),
      accepting ? { inheritUnset: true, acceptProcessSettings: true } : { inheritUnset: true },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[ScheduledMessages] Could not tell whether a message would disturb the session\'s background work', {
      sessionId,
      error: message,
    });
    return null;
  }
}

/**
 * Whether a message, planned as `plan` (`planMessageTurn`), has to stay out
 * of the process the session's runtime holds after its turn for work of the
 * session's own (`heldWork`), work no task reports included (a wake-up that
 * ScheduleWakeup or /loop set, a CronCreate job). It does when its turn
 * cannot go into that process (`canHandOver`): it changes something only a
 * new process can apply, and starting one stops the work. The chat gateway
 * refuses such a send from the composer, whose dialog then offers to queue
 * it until the work is done.
 *
 * A turn the process takes goes on time, as its next turn, and the work
 * keeps running; waiting for the hold itself to end would keep it back for
 * as long as a self-paced /loop runs. So does a turn that switches the live
 * process's model or permission mode (`switches`): it runs with its own, and
 * the process switches back once it is over (`restoreSwitchesAfterTurn`, see
 * `dispatchedOptions`), so a /loop allowed to edit is still allowed after it.
 * One kept out only by its effort, ultracode or tool rules goes in on the
 * process's own while the process is held for scheduled work alone, unless
 * its tool rules are stricter (`planTurn`).
 */
function wouldDisturbHeldWork(plan: ProviderHandOverPlan | null): boolean {
  return plan !== null && plan.heldWork && !plan.canHandOver;
}

/**
 * The settings a held process took at launch and cannot switch for a turn
 * (see `HandOverChange`), which a turn of a process held for scheduled work
 * alone may take from the process instead (`acceptsProcessSettings`). Tool
 * rules only when the turn's are no stricter than the process's: the runtime
 * still keeps out a turn whose rules allow fewer tools or deny others, and
 * its plan with `acceptProcessSettings` says so (`planTurn`).
 */
const PROCESS_ONLY_SETTINGS: ReadonlySet<HandOverChange> = new Set<HandOverChange>(['effort', 'ultracode', 'tools']);

/**
 * Whether a message whose turn would disturb held work, as planned in `plan`
 * (`wouldDisturbHeldWork`), is worth planning again on the process's own
 * effort, ultracode and tool rules (`planTurn`): the process is held for
 * scheduled work alone, a /loop's next wake-up or a CronCreate job
 * (`hasScheduledWork`, with no task the tracker reports: `hasBackgroundWork`),
 * and only those settings keep the turn out. Scheduled work could keep the
 * message waiting for days, as long as the process is held for a loop, where
 * tasks end by themselves. A working directory, or a plan the runtime could
 * not work out (`lookup`), still keeps the turn out, and so does a model or
 * permission mode the process cannot switch to. Tool rules stricter than the
 * process's keep it out too, which only the runtime can tell.
 */
function acceptsProcessSettings(
  sessionId: string,
  plan: ProviderHandOverPlan,
  runtime: ProviderRuntimeGateway,
): boolean {
  return plan.changes.length > 0
    && plan.changes.every((change) => PROCESS_ONLY_SETTINGS.has(change))
    && !runtime.hasBackgroundWork(sessionId)
    && runtime.hasScheduledWork(sessionId);
}

/**
 * Plans a message's turn (`planMessageTurn`) and returns the turn as it
 * would go, with its plan. When the turn would disturb held work only
 * through settings a process held for scheduled work alone cannot switch
 * (`acceptsProcessSettings`), the turn takes the process's own instead: its
 * options set `acceptProcessSettings: true`, and the runtime, which has the
 * last word on what it takes, is asked again; tool rules stricter than the
 * process's still keep the turn out. The turn goes so only when that plan
 * lets it in; otherwise, or when the runtime fails to plan it, it stays as
 * first planned, and waits.
 *
 * Its run is handed over as that plan said, even if the CLI's own turn has
 * started a task since. A process that does not take it after all fails the
 * turn (HAND_OVER_FAILED, see `HandOverFailure`) rather than be replaced, and
 * the work goes on: a queued message goes back in the queue, and waits
 * before it is tried again (`sendClaimedQueuedMessage`), and a due one is
 * marked failed with why (`recordDueMessageOutcome`).
 */
async function planTurn(
  sessionId: string,
  turn: DispatchedTurn,
  runtime: ProviderRuntimeGateway,
): Promise<{ turn: DispatchedTurn; plan: ProviderHandOverPlan | null }> {
  const plan = await planMessageTurn(sessionId, turn.options, runtime);
  if (!plan || !wouldDisturbHeldWork(plan) || !acceptsProcessSettings(sessionId, plan, runtime)) {
    return { turn, plan };
  }
  const accepting: DispatchedTurn = { ...turn, options: { ...turn.options, acceptProcessSettings: true } };
  const acceptingPlan = await planMessageTurn(sessionId, accepting.options, runtime);
  return acceptingPlan && !wouldDisturbHeldWork(acceptingPlan)
    ? { turn: accepting, plan: acceptingPlan }
    : { turn, plan };
}

/**
 * The turn a due message sends now (see `planTurn`), or null when it has to
 * wait.
 *
 * A due message interrupts a turn under way (see `sendClaimedMessage`), and
 * the interrupt stops whatever the session's process holds with the turn.
 * So while a turn is under way it waits when the session holds background
 * work of its own: the plan says the process running the turn has such work
 * (`heldWork`: the turn went into a process held for it, or tasks of the
 * session's own are outstanding), or the tracker reports work the session's
 * turns started, which tells it too when the plan failed. A turn under way
 * in a session with no such work is interrupted, as it always was. With no
 * turn under way, it waits while its turn would disturb held work
 * (`wouldDisturbHeldWork`).
 */
async function dueTurnToSend(
  sessionId: string,
  turn: DispatchedTurn,
  runtime: ProviderRuntimeGateway,
): Promise<DispatchedTurn | null> {
  const planned = await planTurn(sessionId, turn, runtime);
  // Read once the plan is in: a turn may have started or ended while the
  // runtime planned, and the claim and the send follow without waiting on
  // anything else, so the send finds the turn this read found.
  if (chatRunRegistry.isProcessing(sessionId)) {
    return planned.plan?.heldWork === true || runtime.hasBackgroundWork(sessionId) ? null : planned.turn;
  }
  return wouldDisturbHeldWork(planned.plan) ? null : planned.turn;
}

/**
 * Sends every persisted queued turn its session is free for: no turn under
 * way, no background work the tracker reports, and no held work the turn
 * would disturb (`wouldDisturbHeldWork`; see `planTurn` for a process held
 * for scheduled work alone). A session a due pass is asking
 * about (`DueCheck`) is looked at once it has its answer: a due message that
 * goes keeps the session, and the queued turn waits for it, while one that
 * has to wait keeps the queued turn back no more than if it were not there.
 * A queued message the held process turned away at the hand-over waits
 * before it is tried again (`handOverRetries`), counted from `now`, when the
 * pass starts.
 *
 * Resolves with how many it claimed once the runs of the turns it started
 * have settled. The poll in this file does not wait for that; the tests do,
 * to drive one pass without the timer.
 */
export async function dispatchQueuedMessages(
  runtime: ProviderRuntimeGateway,
  now: Date = new Date(),
): Promise<number> {
  let claimed = 0;
  const sends: Promise<void>[] = [];
  const outcomes: Promise<void>[] = [];

  const sendWhenFree = (candidate: QueuedSessionMessageRecord): Promise<void> | null => {
    if (waitsToRetryHandOver(candidate, now, runtime) || isSessionBusy(candidate.sessionId, runtime)) {
      return null;
    }
    return sendUnlessInFlight(candidate.sessionId, async () => {
      let turn = readQueuedTurn(candidate);
      // Asked once the session is marked: the runtime answers asynchronously,
      // and a pass that starts meanwhile has to skip the session. The claim
      // below succeeds only for the message as listed, the one planned for.
      if (turn) {
        const planned = await planTurn(candidate.sessionId, turn, runtime);
        if (wouldDisturbHeldWork(planned.plan)) {
          return;
        }
        turn = planned.turn;
      }
      if (!sessionDraftsDb.claimQueuedMessage(candidate)) {
        return;
      }
      claimed += 1;
      await sendClaimedQueuedMessage(candidate, turn, runtime, outcomes, now);
    });
  };

  for (const candidate of sessionDraftsDb.listQueuedMessages()) {
    const send = sessionsInFlight.get(candidate.sessionId)
      ? (async () => {
          await waitForDueChecks(candidate.sessionId);
          await sendWhenFree(candidate);
        })()
      : sendWhenFree(candidate);
    if (send) {
      sends.push(send);
    }
  }

  await Promise.all(sends);
  await Promise.all(outcomes);
  return claimed;
}

/** The failure reason a hand-over failure's `reason` is recorded as (see `HandOverFailureCode`). */
const HAND_OVER_FAILURE_CODES: ReadonlyMap<string, HandOverFailureCode> = new Map([
  ['stale-plan', 'hand_over_failed:stale-plan'],
  ['lookup', 'hand_over_failed:lookup'],
]);

/**
 * Why a due message failed when the held process turned its turn away at
 * the hand-over (see `HandOverFailure`): the code of the runtime's `reason`,
 * which the composer's list words in the user's language after "Not sent —".
 * A reason with no code, or none, is recorded as the runtime's English text,
 * without the "Not sent:" it opens with, which the list shows as it is.
 */
function handOverFailureReason(failure: HandOverFailure): string {
  const code = failure.reason === null ? undefined : HAND_OVER_FAILURE_CODES.get(failure.reason);
  if (code) {
    return code;
  }
  const text = failure.content?.replace(/^Not sent:\s*/, '').trim();
  return text || 'The process held for the session\'s scheduled work did not take this message.';
}

/**
 * Records how a due message's run settled. Recorded rather than retried, and
 * recorded whether the run never started (deleted session, unavailable
 * provider) or started and then failed, the held process turning its turn
 * away at the hand-over included (`handOverFailure`). Silently dropping a
 * message the user scheduled is worse than telling them it did not go.
 */
async function recordDueMessageOutcome(
  row: ScheduledMessageRow,
  settled: Promise<DispatchedTurnResult>,
  handOverFailure: () => HandOverFailure | null,
): Promise<void> {
  try {
    const result = await settled;
    const failure = handOverFailure();
    if (failure) {
      console.warn('[ScheduledMessages] The held process turned a due message away', {
        sessionId: row.session_id,
        reason: failure.reason,
      });
      scheduledMessagesDb.markFailed(row.id, handOverFailureReason(failure));
      return;
    }
    if (!result.started || result.error) {
      scheduledMessagesDb.markFailed(row.id, result.error ?? 'The session was unavailable when this was due.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scheduledMessagesDb.markFailed(row.id, message);
  }
}

/**
 * Sends a claimed due message's turn and resolves once the turn is over; how
 * its run settles is recorded through `outcomes`. Closes the session's due
 * check as soon as the turn has its run: the session stays held for the turn.
 */
async function sendClaimedMessage(
  row: ScheduledMessageRow,
  turn: DispatchedTurn,
  runtime: ProviderRuntimeGateway,
  outcomes: Promise<void>[],
): Promise<void> {
  let handOverFailure: HandOverFailure | null = null;
  const turnOver = runMessageTurn(
    {
      sessionId: row.session_id,
      userId: row.user_id,
      content: turn.content,
      options: turn.options,
      // The user picked this time on purpose; a run that happens to be going
      // is aborted so the scheduled message lands when it was due, instead
      // of being recorded as "not sent — session was busy". Only a run in
      // a session with no background work of its own: the message waited
      // otherwise (`dueTurnToSend`).
      interruptActiveRun: true,
      onHandOverFailed: (failure) => { handOverFailure = failure; },
    },
    runtime,
  );
  closeDueCheck(row.session_id);
  const { settled } = await turnOver;
  outcomes.push(recordDueMessageOutcome(row, settled, () => handOverFailure));
}

/**
 * Sends every message whose time has come.
 *
 * Different sessions are sent to side by side. One session's messages go one
 * at a time, in the order they were due: a session runs one turn at a time,
 * and two of its messages must not race each other into it. A session the
 * dispatcher holds for a turn it started is left for a later pass, so a
 * message that comes due meanwhile waits for that turn to be over rather than
 * interrupting it, and then goes as in any session. It interrupts only a run
 * the dispatcher did not start, and only in a session with no background work
 * of its own: not the user's turn that went into a process held for such
 * work (`dueTurnToSend`). Nor does a message go when it would disturb
 * background work the session's process is held for (`wouldDisturbHeldWork`).
 * A waiting message stays pending, and so do the session's later ones, until
 * it can go; the session's queued turn does not wait behind it (see
 * `dispatchQueuedMessages`). One the held process can take goes into it when
 * due, the process of a turn the dispatcher started included.
 *
 * Resolves with how many it claimed once the runs of the turns it started
 * have settled and their outcomes are recorded. The poll in this file does
 * not wait for that; the tests do, to drive one pass without the timer.
 */
export async function dispatchDueScheduledMessages(
  runtime: ProviderRuntimeGateway,
  now: Date = new Date(),
): Promise<number> {
  const dueBySession = new Map<string, ScheduledMessageRow[]>();
  for (const row of scheduledMessagesDb.listDue(now)) {
    const rows = dueBySession.get(row.session_id);
    if (rows) {
      rows.push(row);
    } else {
      dueBySession.set(row.session_id, [row]);
    }
  }

  let claimed = 0;
  const sends: Promise<void>[] = [];
  const outcomes: Promise<void>[] = [];

  for (const [sessionId, rows] of dueBySession) {
    const send = sendUnlessInFlight(sessionId, async () => {
      for (const row of rows) {
        const message: DispatchedTurn = { content: row.content, options: dispatchedOptions(readOptions(row.options)) };
        // Asked before each message, for its own options, not once per
        // session: whether the held process takes a turn depends on what the
        // turn changes, and the previous message's turn, or the user's, may
        // have left the process held, or still be running in it.
        openDueCheck(sessionId);
        const turn = await dueTurnToSend(sessionId, message, runtime);
        if (!turn) {
          return;
        }
        // Claimed right before it goes, not when listed, so a message waiting
        // for the turn before it is not marked sent early. A message
        // cancelled while it waited is skipped here. Nothing went, so its due
        // check stays open, for the session's next message to take over or
        // for the session's release to answer: a queued pass waiting on it
        // must not read the session as held for a turn.
        if (!scheduledMessagesDb.claim(row.id)) {
          continue;
        }
        claimed += 1;
        await sendClaimedMessage(row, turn, runtime, outcomes);
      }
    });
    if (send) {
      sends.push(send);
    }
  }

  await Promise.all(sends);
  await Promise.all(outcomes);
  return claimed;
}

function logPassFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[ScheduledMessages] Dispatch pass failed', { error: message });
}

/**
 * Starts the poll that sends scheduled messages.
 *
 * The schedule lives in the database, so a message stays scheduled across a
 * restart and one that came due while the server was down is sent on the first
 * poll after it comes back, rather than being skipped.
 */
export function initializeScheduledMessageDispatcher(runtime: ProviderRuntimeGateway): void {
  if (pollTimer) {
    return;
  }

  const poll = () => {
    // Neither pass is awaited: a turn's run can take hours to settle, and the
    // passes themselves skip the sessions an earlier poll still holds for a
    // turn. The scheduled pass marks the sessions it asks about before it
    // returns, and the queued pass waits for each answer: a due message that
    // goes goes before a turn queued for the same session, and one that has
    // to wait keeps none back.
    void dispatchDueScheduledMessages(runtime).catch(logPassFailure);
    void dispatchQueuedMessages(runtime).catch(logPassFailure);
  };

  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  // Never keep the process alive just to poll for scheduled messages.
  pollTimer.unref?.();

  // Catch up on anything that came due while the server was not running.
  poll();
}

/**
 * Stops the poll, and forgets how long turned-away queued messages wait
 * (`handOverRetries`): a dispatcher started again tries them at once.
 */
export function closeScheduledMessageDispatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  handOverRetries.clear();
}
