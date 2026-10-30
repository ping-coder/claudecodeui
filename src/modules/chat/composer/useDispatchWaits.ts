import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import { useSessionProtectionActions } from '@/shared/context/SessionProtectionContext';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { DispatchWait, DispatchWaitTarget, ScheduledWorkStopStatus } from '@/shared/types';

type WaitingPayload = { data?: { waits?: unknown } };

// One empty list, so what reads it is not redrawn for a new one.
const NONE: DispatchWait[] = [];

/** What a waiting message's action came to, said under it until the user does something else. */
export type DispatchWaitNotice = 'stopFailed' | 'stopAfterTurn' | 'useFailed';

/** An action under way for a waiting message: its loops are being stopped, or it is being switched to the loop's settings. */
export type DispatchWaitBusy = 'stopping' | 'using';

/** The key a waiting message goes by on this page: `queued`, or `scheduled:<id>`. */
export const dispatchWaitKey = (target: DispatchWaitTarget): string => (
  target.kind === 'queued' ? 'queued' : `scheduled:${target.id}`
);

const isWait = (value: unknown): value is DispatchWait => {
  const wait = value as Partial<DispatchWait> | null;
  return Boolean(wait)
    && typeof wait?.sessionId === 'string'
    && typeof wait.reason === 'string'
    && Array.isArray(wait.changes)
    && Array.isArray(wait.actions)
    && (wait.target?.kind === 'queued' || (wait.target?.kind === 'scheduled' && typeof wait.target.id === 'string'));
};

/** `current` with `key` set to `value`, or taken out for null; `current` itself when that changes nothing. */
function withEntry<T>(current: ReadonlyMap<string, T>, key: string, value: T | null): ReadonlyMap<string, T> {
  if (value === null ? !current.has(key) : current.get(key) === value) {
    return current;
  }
  const next = new Map(current);
  if (value === null) {
    next.delete(key);
  } else {
    next.set(key, value);
  }
  return next;
}

/** A `clientRequestId` for a stop: unique on the page, which is all the server's answers need to name it. */
const createStopRequestId = (): string => `wait_stop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

/**
 * Why the session's queued and scheduled messages wait (see DispatchWait), and the user's ways out
 * of a wait. Read from the server when the session opens and once the socket reconnects, then kept
 * current by the `dispatch_waiting` frames, which every socket gets: only the session's count.
 *
 * - `stopAndSend` stops the session's loops as the task strip's "Stop all" does (`chat.stop-task`
 *   with `allScheduled`), following the stop by its own `clientRequestId`; once the loops have let
 *   go of the process the server sends the waiting messages at once.
 * - `sendWithProcessSettings` stores on the message that it goes with the held process's settings.
 * - `keepWaiting` folds the actions away on this page; the reason stays. `showActions` unfolds them.
 * - `forget` drops a wait at once, for a message the user cancelled.
 *
 * `onWaitEnded` hears of each message that no longer waits (it went, or is gone), for the list
 * that shows it to read again.
 *
 * Read by ChatInterface for the composer's queued card and scheduled list.
 */
export function useDispatchWaits(
  sessionId: string | null,
  sendMessage: (message: unknown) => void,
  onWaitEnded?: (target: DispatchWaitTarget) => void,
) {
  const { subscribe } = useWebSocket();
  const { markSessionProcessing, refreshRunningSessions } = useSessionProtectionActions();
  const [waits, setWaits] = useState<{ sessionId: string; list: DispatchWait[] } | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<ReadonlyMap<string, DispatchWaitBusy>>(() => new Map());
  const [notices, setNotices] = useState<ReadonlyMap<string, DispatchWaitNotice>>(() => new Map());
  // The stops this page sent for a waiting message and has no final answer to: request id → wait key.
  const stopsRef = useRef(new Map<string, string>());
  // Reads are numbered as they start: an answer that comes back after a later read's describes an
  // older moment, or another session.
  const lastReadRef = useRef(0);
  // What changed while the newest read was under way, by wait key (null: no longer waits). The
  // server may have answered from before those changes, and sends no frame again for a wait that
  // stays the same, so they are laid over the answer instead of dropping it.
  const changesDuringReadRef = useRef<Map<string, DispatchWait | null> | null>(null);
  const sessionIdRef = useRef(sessionId);
  const onWaitEndedRef = useRef(onWaitEnded);
  useLayoutEffect(() => {
    sessionIdRef.current = sessionId;
    onWaitEndedRef.current = onWaitEnded;
  });

  const refresh = useCallback(async () => {
    lastReadRef.current += 1;
    const read = lastReadRef.current;
    if (!sessionId) {
      changesDuringReadRef.current = null;
      return;
    }
    const changesDuringRead = new Map<string, DispatchWait | null>();
    changesDuringReadRef.current = changesDuringRead;
    try {
      const response = await api.scheduledMessages.waiting(sessionId);
      if (!response.ok) {
        return;
      }
      const payload = (await response.json()) as WaitingPayload;
      if (read !== lastReadRef.current) {
        return;
      }
      const answered = Array.isArray(payload.data?.waits) ? payload.data.waits.filter(isWait) : [];
      const list = [
        ...answered.filter((wait) => !changesDuringRead.has(dispatchWaitKey(wait.target))),
        ...[...changesDuringRead.values()].filter((wait): wait is DispatchWait => wait !== null),
      ];
      setWaits({ sessionId, list });
    } catch (error) {
      console.error('[Chat] Failed to read why messages wait:', error);
    } finally {
      if (changesDuringReadRef.current === changesDuringRead) {
        changesDuringReadRef.current = null;
      }
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A stop this page sent has its answer.
  const settleStop = useCallback((requestId: string, key: string, notice: DispatchWaitNotice | null) => {
    stopsRef.current.delete(requestId);
    setBusy((current) => withEntry(current, key, null));
    if (notice) {
      setNotices((current) => withEntry(current, key, notice));
    }
  }, []);

  useEffect(() => {
    if (!sessionId) {
      return undefined;
    }
    return subscribe((event) => {
      if (event.kind === 'websocket_reconnected') {
        // A stop's answer the socket lost is lost for good.
        stopsRef.current.clear();
        setBusy(new Map());
        void refresh();
        return;
      }
      if (event.kind === 'dispatch_waiting' && event.sessionId === sessionId) {
        const target = event.target as DispatchWaitTarget | undefined;
        if (!target || (target.kind !== 'queued' && target.kind !== 'scheduled')) {
          return;
        }
        const key = dispatchWaitKey(target);
        const wait = isWait(event.wait) ? event.wait : null;
        // A newer word than the read under way, if any: it goes over that read's answer too.
        changesDuringReadRef.current?.set(key, wait);
        setWaits((current) => {
          const others = (current?.sessionId === sessionId ? current.list : []).filter((entry) => dispatchWaitKey(entry.target) !== key);
          return { sessionId, list: wait ? [...others, wait] : others };
        });
        if (!wait) {
          setBusy((current) => withEntry(current, key, null));
          setNotices((current) => withEntry(current, key, null));
          onWaitEndedRef.current?.(target);
        }
        return;
      }
      if (event.kind !== 'stop_task_status' || event.sessionId !== sessionId || typeof event.clientRequestId !== 'string') {
        return;
      }
      const key = stopsRef.current.get(event.clientRequestId);
      if (key === undefined) {
        return;
      }
      const requestId = event.clientRequestId;
      switch (event.status as ScheduledWorkStopStatus) {
        case 'started':
          // The cancelling turn is a turn like any other.
          markSessionProcessing(sessionId);
          break;
        case 'stopped':
        case 'not_found':
          settleStop(requestId, key, null);
          void refreshRunningSessions();
          break;
        case 'finished':
          settleStop(requestId, key, event.stillHeld === false ? null : 'stopFailed');
          void refreshRunningSessions();
          break;
        case 'busy':
          settleStop(requestId, key, 'stopAfterTurn');
          break;
        case 'failed':
          settleStop(requestId, key, 'stopFailed');
          break;
        default:
          break;
      }
    });
  }, [markSessionProcessing, refresh, refreshRunningSessions, sessionId, settleStop, subscribe]);

  // Cleared during the switch render: one session's waits never paint over another's.
  const [renderedSessionId, setRenderedSessionId] = useState(sessionId);
  if (renderedSessionId !== sessionId) {
    setRenderedSessionId(sessionId);
    setFolded(new Set());
    setBusy(new Map());
    setNotices(new Map());
  }

  const list = waits && waits.sessionId === sessionId ? waits.list : NONE;

  const waitFor = useCallback(
    (target: DispatchWaitTarget): DispatchWait | null => list.find((wait) => dispatchWaitKey(wait.target) === dispatchWaitKey(target)) ?? null,
    [list],
  );

  const stopAndSend = useCallback((wait: DispatchWait) => {
    const key = dispatchWaitKey(wait.target);
    if (!wait.stopTaskId || busy.has(key)) {
      return;
    }
    const requestId = createStopRequestId();
    stopsRef.current.set(requestId, key);
    sendMessage({ type: 'chat.stop-task', sessionId: wait.sessionId, taskId: wait.stopTaskId, allScheduled: true, clientRequestId: requestId });
    setBusy((current) => withEntry(current, key, 'stopping'));
    setNotices((current) => withEntry(current, key, null));
  }, [busy, sendMessage]);

  const sendWithProcessSettings = useCallback(async (wait: DispatchWait) => {
    const key = dispatchWaitKey(wait.target);
    if (busy.has(key)) {
      return;
    }
    setBusy((current) => withEntry(current, key, 'using'));
    setNotices((current) => withEntry(current, key, null));
    try {
      const response = wait.target.kind === 'queued'
        ? await api.scheduledMessages.useProcessSettingsForQueued(wait.sessionId)
        : await api.scheduledMessages.useProcessSettings(wait.target.id);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      // The server ran a pass: the message went, and its wait ends with a
      // frame, or it waits on for what the loop's settings do not change.
      if (sessionIdRef.current === wait.sessionId) {
        setBusy((current) => withEntry(current, key, null));
      }
    } catch (error) {
      console.error('[Chat] Failed to send a waiting message with the loop\'s settings:', error);
      if (sessionIdRef.current === wait.sessionId) {
        setBusy((current) => withEntry(current, key, null));
        setNotices((current) => withEntry(current, key, 'useFailed'));
      }
    }
  }, [busy]);

  const keepWaiting = useCallback((wait: DispatchWait) => {
    const key = dispatchWaitKey(wait.target);
    setFolded((current) => new Set(current).add(key));
    setNotices((current) => withEntry(current, key, null));
  }, []);

  const showActions = useCallback((wait: DispatchWait) => {
    const key = dispatchWaitKey(wait.target);
    setFolded((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, []);

  const forget = useCallback((target: DispatchWaitTarget) => {
    const key = dispatchWaitKey(target);
    changesDuringReadRef.current?.set(key, null);
    setWaits((current) => (current
      ? { sessionId: current.sessionId, list: current.list.filter((wait) => dispatchWaitKey(wait.target) !== key) }
      : current));
  }, []);

  return {
    waits: list,
    waitFor,
    isFolded: (wait: DispatchWait) => folded.has(dispatchWaitKey(wait.target)),
    busyOf: (wait: DispatchWait) => busy.get(dispatchWaitKey(wait.target)) ?? null,
    noticeOf: (wait: DispatchWait) => notices.get(dispatchWaitKey(wait.target)) ?? null,
    stopAndSend,
    sendWithProcessSettings,
    keepWaiting,
    showActions,
    forget,
    refresh,
  };
}
