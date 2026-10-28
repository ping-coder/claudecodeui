import { scheduledMessagesDb, sessionDraftsDb, sessionsDb } from '@/modules/database/index.js';
import type { QueuedSessionMessageRecord, ScheduledMessageRow } from '@/modules/database/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type { AnyRecord, LLMProvider, ProviderHandOverPlan } from '@/shared/types.js';
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
 * Sessions the dispatcher is still sending to: a scheduled or queued turn it
 * started whose provider run has not settled yet.
 *
 * Kept per session rather than as one flag for the whole dispatcher because a
 * run can take hours to settle: a turn that leaves background work going (a
 * backgrounded build, agent or workflow) keeps its CLI process open until that
 * work reports back. Only that session has to wait for it. Passes skip these
 * sessions and leave their messages as they are, which keeps one session's
 * messages in order and stops two of its turns racing into it.
 *
 * A session is let go early once the user's next turn has taken that process
 * over (see `runDetachedChatTurn`): the work then goes on under the user's
 * turn, and the next pass treats the session like any other, whose messages
 * wait only while sending them would disturb the work its process is held
 * for (`wouldDisturbHeldWork`, and `mustDueMessageWait` for a turn under way).
 */
const sessionsInFlight = new Set<string>();

/**
 * A message as the dispatcher sends it: its content, and the options its
 * turn runs with, as `runDetachedChatTurn` takes them (`dispatchedOptions`).
 * Read once per message, so the hand-over plan and the turn see the same
 * options.
 */
type DispatchedTurn = { content: string; options: AnyRecord };

/**
 * The options a message's turn runs with: the ones its client sent with it,
 * and `inheritUnset: true`. The dispatcher plans the turn with unset settings
 * taken as the held process's own (`planMessageTurn`), and a run with the
 * option hands its turn to that process the same way (see
 * `ProviderHandOverPlanOptions`). Without it, the run would read what the
 * message leaves out as a new process would (no tool rules, permissions not
 * skipped): it would switch a /loop's process out of bypassPermissions, or
 * replace the process and stop the work the plan said it would keep.
 */
function dispatchedOptions(clientOptions: AnyRecord): AnyRecord {
  return { ...clientOptions, inheritUnset: true };
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

/**
 * Runs one session's sends, unless the dispatcher is still sending to that
 * session, and returns them as a promise, or null when it skipped them.
 *
 * The session is marked before `send` reaches its first await, so a pass that
 * starts meanwhile (the next poll, or two passes started together) skips it.
 * A failure is logged here rather than passed on, so one session's error does
 * not fail the pass for the others.
 */
function sendUnlessInFlight(sessionId: string, send: () => Promise<void>): Promise<void> | null {
  if (sessionsInFlight.has(sessionId)) {
    return null;
  }

  sessionsInFlight.add(sessionId);
  return send()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ScheduledMessages] Sending to a session failed', { sessionId, error: message });
    })
    .finally(() => {
      sessionsInFlight.delete(sessionId);
    });
}

/** The turn a queued message runs, or null when it has nothing to send. */
function readQueuedTurn(candidate: QueuedSessionMessageRecord): DispatchedTurn | null {
  const message = readQueuedChatMessage(candidate.queuedMessage);
  return message
    ? { content: message.content, options: dispatchedOptions({ ...message.options, attachments: message.attachments }) }
    : null;
}

async function sendClaimedQueuedMessage(
  candidate: QueuedSessionMessageRecord,
  turn: DispatchedTurn | null,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  if (!turn) {
    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    return;
  }

  const result = await runDetachedChatTurn(
    {
      sessionId: candidate.sessionId,
      userId: candidate.userId,
      content: turn.content,
      options: turn.options,
    },
    { runtime },
  );

  // The registry check and run reservation are separate operations. If a run
  // wins that tiny race, put the turn back so the next poll tries again.
  if (!result.started && result.error === 'A run was already in progress for this session.') {
    sessionDraftsDb.restoreQueuedMessage(candidate);
    return;
  }
  sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
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
 * it leaves unset is no difference to the process.
 *
 * Null for a session the dispatcher cannot run (gone, or its provider
 * unavailable): the send reports that. Null, too, for a plan the runtime
 * fails to make, which is logged: the message is then judged as if nothing
 * were held, and goes as it did before the dispatcher asked.
 */
async function planMessageTurn(
  sessionId: string,
  clientOptions: AnyRecord,
  runtime: ProviderRuntimeGateway,
): Promise<ProviderHandOverPlan | null> {
  const session = sessionsDb.getSessionById(sessionId);
  if (!session || !runtime.hasRuntime(session.provider)) {
    return null;
  }
  try {
    return await runtime.planHandOver(
      session.provider as LLMProvider,
      sessionId,
      buildTurnRunOptions({ sessionId, projectPath: session.project_path, clientOptions }),
      { inheritUnset: true },
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
 * it until the work is done. It does, too, when the turn would go in only
 * by switching the live process's model or permission mode (`switches`):
 * nobody is there to see the switch, and the work runs on after the turn
 * with what it switched to, as a /loop allowed to edit would ask for every
 * edit once a message switched it to the default mode, and be refused when
 * nobody answers.
 *
 * A turn the process takes as it is goes on time, as its next turn, and the
 * work keeps running; waiting for the hold itself to end would keep it back
 * for as long as a self-paced /loop runs.
 */
function wouldDisturbHeldWork(plan: ProviderHandOverPlan | null): boolean {
  return plan !== null && plan.heldWork && (!plan.canHandOver || plan.switches.length > 0);
}

/**
 * Whether a due message has to wait rather than go now.
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
async function mustDueMessageWait(
  sessionId: string,
  clientOptions: AnyRecord,
  runtime: ProviderRuntimeGateway,
): Promise<boolean> {
  const plan = await planMessageTurn(sessionId, clientOptions, runtime);
  // Read once the plan is in: a turn may have started or ended while the
  // runtime planned, and the claim and the send follow without waiting on
  // anything else, so the send finds the turn this read found.
  if (chatRunRegistry.isProcessing(sessionId)) {
    return plan?.heldWork === true || runtime.hasBackgroundWork(sessionId);
  }
  return wouldDisturbHeldWork(plan);
}

/**
 * Sends every persisted queued turn its session is free for: no turn under
 * way, no background work the tracker reports, and no held work the turn
 * would disturb (`wouldDisturbHeldWork`).
 *
 * Resolves with how many it claimed once the turns it started have settled.
 * The poll in this file does not wait for that; the tests do, to drive one
 * pass without the timer.
 */
export async function dispatchQueuedMessages(runtime: ProviderRuntimeGateway): Promise<number> {
  let claimed = 0;
  const sends: Promise<void>[] = [];

  for (const candidate of sessionDraftsDb.listQueuedMessages()) {
    if (isSessionBusy(candidate.sessionId, runtime)) {
      continue;
    }
    const send = sendUnlessInFlight(candidate.sessionId, async () => {
      const turn = readQueuedTurn(candidate);
      // Asked once the session is marked: the runtime answers asynchronously,
      // and a pass that starts meanwhile has to skip the session. The claim
      // below succeeds only for the message as listed, the one planned for.
      if (turn && wouldDisturbHeldWork(await planMessageTurn(candidate.sessionId, turn.options, runtime))) {
        return;
      }
      if (!sessionDraftsDb.claimQueuedMessage(candidate)) {
        return;
      }
      claimed += 1;
      await sendClaimedQueuedMessage(candidate, turn, runtime);
    });
    if (send) {
      sends.push(send);
    }
  }

  await Promise.all(sends);
  return claimed;
}

async function sendClaimedMessage(
  row: ScheduledMessageRow,
  turn: DispatchedTurn,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  try {
    const result = await runDetachedChatTurn(
      {
        sessionId: row.session_id,
        userId: row.user_id,
        content: turn.content,
        options: turn.options,
        // The user picked this time on purpose; a run that happens to be going
        // is aborted so the scheduled message lands when it was due, instead
        // of being recorded as "not sent — session was busy". Only a run in
        // a session with no background work of its own: the message waited
        // otherwise (`mustDueMessageWait`).
        interruptActiveRun: true,
      },
      { runtime },
    );

    // Recorded rather than retried, and recorded whether the run never started
    // (deleted session, unavailable provider) or started and then failed.
    // Silently dropping a message the user scheduled is worse than telling
    // them it did not go.
    if (!result.started || result.error) {
      scheduledMessagesDb.markFailed(row.id, result.error ?? 'The session was unavailable when this was due.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scheduledMessagesDb.markFailed(row.id, message);
  }
}

/**
 * Sends every message whose time has come.
 *
 * Different sessions are sent to side by side. One session's messages go one
 * at a time, in the order they were due: a session runs one turn at a time,
 * and two of its messages must not race each other into it. A session the
 * dispatcher is still sending to is left for a later pass, so a message that
 * comes due meanwhile waits for that turn to settle, background work included,
 * rather than interrupting it. It interrupts only a run the dispatcher did
 * not start, and only in a session with no background work of its own: not
 * the user's turn that went into a process held for such work, such as the
 * process of a turn the dispatcher started (`mustDueMessageWait`). Nor does a
 * message go when it would disturb background work the session's process is
 * held for (`wouldDisturbHeldWork`). A waiting message stays pending, and so
 * do the session's later ones, until it can go. One the held process can
 * take as it is goes into it when due.
 *
 * Resolves with how many it claimed once the turns it started have settled.
 * The poll in this file does not wait for that; the tests do, to drive one
 * pass without the timer.
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

  for (const [sessionId, rows] of dueBySession) {
    const send = sendUnlessInFlight(sessionId, async () => {
      for (const row of rows) {
        const turn: DispatchedTurn = { content: row.content, options: dispatchedOptions(readOptions(row.options)) };
        // Asked before each message, for its own options, not once per
        // session: whether the held process takes a turn depends on what the
        // turn changes, and the user's turn may have taken over the previous
        // message's process and left it held, or still be running in it.
        if (await mustDueMessageWait(sessionId, turn.options, runtime)) {
          return;
        }
        // Claimed right before it goes, not when listed, so a message waiting
        // for the turn before it is not marked sent early. A message
        // cancelled while it waited is skipped here.
        if (!scheduledMessagesDb.claim(row.id)) {
          continue;
        }
        claimed += 1;
        await sendClaimedMessage(row, turn, runtime);
      }
    });
    if (send) {
      sends.push(send);
    }
  }

  await Promise.all(sends);
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
    // passes themselves skip the sessions an earlier poll is still sending
    // to. Each pass marks the sessions it sends to before it returns, so the
    // queued pass skips a session the scheduled pass has just taken: a due
    // message goes before a turn queued for the same session.
    void dispatchDueScheduledMessages(runtime).catch(logPassFailure);
    void dispatchQueuedMessages(runtime).catch(logPassFailure);
  };

  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  // Never keep the process alive just to poll for scheduled messages.
  pollTimer.unref?.();

  // Catch up on anything that came due while the server was not running.
  poll();
}

export function closeScheduledMessageDispatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
