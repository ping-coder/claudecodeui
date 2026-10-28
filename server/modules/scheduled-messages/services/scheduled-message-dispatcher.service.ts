import { scheduledMessagesDb, sessionDraftsDb } from '@/modules/database/index.js';
import type { QueuedSessionMessageRecord, ScheduledMessageRow } from '@/modules/database/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { readQueuedChatMessage } from '@/shared/utils.js';

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
 */
const sessionsInFlight = new Set<string>();

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

async function sendClaimedQueuedMessage(
  candidate: QueuedSessionMessageRecord,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  const message = readQueuedChatMessage(candidate.queuedMessage);
  if (!message) {
    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    return;
  }

  const result = await runDetachedChatTurn(
    {
      sessionId: candidate.sessionId,
      userId: candidate.userId,
      content: message.content,
      options: { ...message.options, attachments: message.attachments },
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
 * Whether a queued turn has to keep waiting for the session.
 *
 * A turn that ends with background work still going (a backgrounded command,
 * agent or workflow) is marked completed, but its CLI process stays open so
 * that work can report back. A new turn replaces that process and stops the
 * work, which is why the composer asks before an interactive send. A queued
 * turn was promised to go "when this finishes", so it waits for that work too.
 */
function isSessionBusy(sessionId: string, runtime: ProviderRuntimeGateway): boolean {
  return chatRunRegistry.isProcessing(sessionId) || runtime.hasBackgroundWork(sessionId);
}

/**
 * Sends every persisted queued turn whose session is idle.
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
      if (!sessionDraftsDb.claimQueuedMessage(candidate)) {
        return;
      }
      claimed += 1;
      await sendClaimedQueuedMessage(candidate, runtime);
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
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  try {
    const result = await runDetachedChatTurn(
      {
        sessionId: row.session_id,
        userId: row.user_id,
        content: row.content,
        options: readOptions(row.options),
        // The user picked this time on purpose; a run that happens to be going
        // is aborted so the scheduled message lands when it was due, instead
        // of being recorded as "not sent — session was busy".
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
 * rather than interrupting it; it interrupts only a run the dispatcher did not
 * start.
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
        // Claimed right before it goes, not when listed, so a message waiting
        // for the turn before it is not marked sent early. A message
        // cancelled while it waited is skipped here.
        if (!scheduledMessagesDb.claim(row.id)) {
          continue;
        }
        claimed += 1;
        await sendClaimedMessage(row, runtime);
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
