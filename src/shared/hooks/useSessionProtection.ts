import { useCallback, useRef, useState } from 'react';

import type { BackgroundTaskSummary, GetSessionActivity, IsSessionProcessing, MarkSessionBackground, MarkSessionIdle, MarkSessionProcessing, ScheduledWorkSummary, SessionActivity, SessionActivityMap, SessionActivitySnapshot, SyncProcessingSessions } from '@/shared/types';




const LOCAL_ACTIVITY_GRACE_MS = 10_000;

/**
 * The tasks as an identity, so two lists that say the same about the same
 * tasks compare equal — every field the pill, the strip and the composer
 * read, not the ids alone, or a poll that learns a task is nested or corrects
 * its start would be dropped as a repeat.
 */
const backgroundTasksKey = (tasks: readonly BackgroundTaskSummary[] | undefined): string =>
  (tasks ?? [])
    .map((task) => [task.taskId, task.toolUseId, task.taskType, task.description, task.workflowName ?? '', task.startedAt, task.nested ? 1 : 0].join('\u0001'))
    .join('\u0000');

/**
 * The scheduled work as an identity, by what changes while an item is held:
 * its next run (every run moves it, a self-paced loop's renewal too, along
 * with its latest call and reason) and how long it is held. A poll that
 * says only that is not dropped as a repeat.
 */
const scheduledWorkKey = (scheduled: readonly ScheduledWorkSummary[] | undefined): string =>
  (scheduled ?? [])
    .map((item) => [item.id, item.toolUseId, item.nextFireAt ?? '', item.holdUntil, item.reason ?? ''].join('\u0001'))
    .join('\u0000');

const sessionActivitiesMatch = (left: SessionActivity, right: SessionActivity): boolean =>
  left.statusText === right.statusText
  && left.canInterrupt === right.canInterrupt
  && left.startedAt === right.startedAt
  && Boolean(left.background) === Boolean(right.background)
  && backgroundTasksKey(left.tasks) === backgroundTasksKey(right.tasks)
  && scheduledWorkKey(left.scheduled) === scheduledWorkKey(right.scheduled);

/** An entry's `scheduled`, written only when there is some, so an entry without any carries no key for it. */
const withScheduled = (scheduled: ScheduledWorkSummary[] | undefined): Pick<SessionActivity, 'scheduled'> => (
  scheduled?.length ? { scheduled } : {}
);

/**
 * A session's entry while the tasks it launched, or the scheduled work its
 * held process keeps, go on after its turn: busy, but no response. Timed from
 * the earliest of them. Never called with neither.
 */
const backgroundActivity = (tasks: BackgroundTaskSummary[], scheduled: ScheduledWorkSummary[] = []): SessionActivity => ({
  statusText: null,
  canInterrupt: false,
  startedAt: Math.min(...tasks.map((task) => task.startedAt), ...scheduled.map((item) => item.startedAt)),
  background: true,
  tasks,
  ...withScheduled(scheduled),
});

const sessionActivityMapsMatch = (
  left: ReadonlyMap<string, SessionActivity>,
  right: ReadonlyMap<string, SessionActivity>,
): boolean => {
  if (left.size !== right.size) {
    return false;
  }

  for (const [sessionId, leftActivity] of left) {
    const rightActivity = right.get(sessionId);
    if (!rightActivity || !sessionActivitiesMatch(leftActivity, rightActivity)) {
      return false;
    }
  }

  return true;
};

/**
 * Single source of truth for which sessions are busy. Everything the chat UI
 * shows (activity indicator, abort availability, status text) is derived from
 * this map; terminal events (`complete`, abort, an authoritative idle
 * subscribe ack) delete the entry atomically. Session ids are always concrete
 * (allocated before the first send), so entries are keyed by real session
 * ids only.
 *
 * An entry is either a response in flight or, flagged `background`, a
 * session whose turn has ended while the tasks it launched — agents,
 * workflows, backgrounded commands — are still running, or while its held
 * process keeps scheduled work (a /loop, a reminder). Only the former counts
 * as processing: the composer stays usable during the latter. Scheduled work
 * is the server's word alone: the running-sessions poll sets and clears it,
 * and so does finished background work (`run_ended`); what the client reads
 * from the transcript changes only the tasks.
 */
export function useSessionProtection() {
  const [processingSessions, setProcessingSessions] = useState<Map<string, SessionActivity>>(
    new Map(),
  );
  const processingSessionsRef = useRef<SessionActivityMap>(processingSessions);
  processingSessionsRef.current = processingSessions;

  const markSessionProcessing = useCallback<MarkSessionProcessing>((sessionId, activity) => {
    if (!sessionId) {
      return;
    }

    setProcessingSessions((prev) => {
      const existing = prev.get(sessionId);
      // A new turn on a session that was only doing background work starts
      // its own clock: the stale idle-ack guard compares against it, and the
      // tasks' start is not when this response began.
      const continuing = existing && !existing.background ? existing : undefined;
      const next: SessionActivity = {
        statusText:
          activity?.statusText !== undefined ? activity.statusText : continuing?.statusText ?? null,
        canInterrupt: activity?.canInterrupt ?? continuing?.canInterrupt ?? true,
        startedAt: continuing?.startedAt ?? Date.now(),
        // The tasks keep running under the new turn, and the scheduled work
        // stays held; they are reported again when it ends.
        ...(existing?.tasks ? { tasks: existing.tasks } : {}),
        ...withScheduled(existing?.scheduled),
      };

      if (
        continuing
        && continuing.statusText === next.statusText
        && continuing.canInterrupt === next.canInterrupt
      ) {
        return prev;
      }

      const updated = new Map(prev);
      updated.set(sessionId, next);
      return updated;
    });
  }, []);

  const markSessionIdle = useCallback<MarkSessionIdle>((sessionId, opts) => {
    if (!sessionId) {
      return;
    }

    setProcessingSessions((prev) => {
      const existing = prev.get(sessionId);
      // A background-only entry is not a response, so nothing that reports
      // "no response in flight" — an idle subscribe ack, a rejected send —
      // has anything to say about it.
      if (!existing || existing.background) {
        return prev;
      }

      // Guard against stale `chat_subscribed` idle acks: if a new request
      // started after the subscribe was sent, the idle ack describes the
      // older request and must not clear the newer one.
      if (opts?.ifStartedBefore !== undefined && existing.startedAt >= opts.ifStartedBefore) {
        return prev;
      }

      const updated = new Map(prev);
      // A run that left background work running keeps the tasks and the
      // scheduled work its entry lists as that work, for a tab that did not
      // follow the run; one that did has settled the entry from the
      // transcript by now, as background work or idle, which the check above
      // leaves alone.
      if (opts?.backgroundWorkGoesOn && (existing.tasks?.length || existing.scheduled?.length)) {
        updated.set(sessionId, backgroundActivity(existing.tasks ?? [], existing.scheduled));
      } else {
        updated.delete(sessionId);
      }
      return updated;
    });
  }, []);

  const markSessionBackground = useCallback<MarkSessionBackground>((sessionId, tasks, scheduled) => {
    setProcessingSessions((prev) => {
      const existing = prev.get(sessionId);
      // Left out, the scheduled work stays as the server last reported it.
      const nextScheduled = scheduled ?? existing?.scheduled ?? [];
      if (tasks.length === 0 && nextScheduled.length === 0) {
        if (!existing) {
          return prev;
        }
        const updated = new Map(prev);
        updated.delete(sessionId);
        return updated;
      }

      const next = backgroundActivity(tasks, nextScheduled);
      if (existing && sessionActivitiesMatch(existing, next)) {
        return prev;
      }

      const updated = new Map(prev);
      updated.set(sessionId, next);
      return updated;
    });
  }, []);

  const syncProcessingSessions = useCallback<SyncProcessingSessions>((sessions) => {
    const now = Date.now();

    setProcessingSessions((prev) => {
      const incoming = new Map<string, SessionActivitySnapshot>();
      for (const session of sessions) {
        if (!session.sessionId) {
          continue;
        }
        incoming.set(session.sessionId, session);
      }

      const updated = new Map<string, SessionActivity>();

      for (const [sessionId, snapshot] of incoming) {
        const existing = prev.get(sessionId);
        const snapshotStartedAt =
          typeof snapshot.startedAt === 'number' && Number.isFinite(snapshot.startedAt) && snapshot.startedAt > 0
            ? snapshot.startedAt
            : undefined;

        // A send dispatched moments ago may not be a run on the server yet,
        // so a poll that still lists only the session's background work must
        // not demote the response in flight.
        if (
          snapshot.background
          && existing
          && !existing.background
          && now - existing.startedAt < LOCAL_ACTIVITY_GRACE_MS
        ) {
          updated.set(sessionId, existing);
          continue;
        }

        // A run listed where the map had only background work is a new turn,
        // as markSessionProcessing has it: the background entry's
        // canInterrupt: false must not make it look driven outside CloudCLI.
        const base = !snapshot.background && existing?.background ? undefined : existing;
        updated.set(sessionId, {
          statusText:
            snapshot.statusText !== undefined ? snapshot.statusText : base?.statusText ?? null,
          canInterrupt: snapshot.canInterrupt ?? base?.canInterrupt ?? true,
          startedAt: snapshotStartedAt ?? base?.startedAt ?? now,
          ...(snapshot.background ? { background: true } : {}),
          ...(snapshot.tasks ? { tasks: snapshot.tasks } : {}),
          ...withScheduled(snapshot.scheduled),
        });
      }

      for (const [sessionId, activity] of prev) {
        if (!incoming.has(sessionId) && now - activity.startedAt < LOCAL_ACTIVITY_GRACE_MS) {
          updated.set(sessionId, activity);
        }
      }

      return sessionActivityMapsMatch(prev, updated) ? prev : updated;
    });
  }, []);

  const isSessionProcessing = useCallback<IsSessionProcessing>((sessionId) => {
    const activity = sessionId ? processingSessionsRef.current.get(sessionId) : undefined;
    return Boolean(activity && !activity.background);
  }, []);

  const getSessionActivity = useCallback<GetSessionActivity>(
    (sessionId) => processingSessionsRef.current.get(sessionId),
    [],
  );

  return {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
    markSessionBackground,
    syncProcessingSessions,
    isSessionProcessing,
    getSessionActivity,
  };
}
