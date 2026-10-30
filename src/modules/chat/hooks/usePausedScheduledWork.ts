import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { ScheduledWorkSummary } from '@/shared/types';
import { parseScheduledWork } from '@/shared/utils';

type PausedScheduledWorkPayload = { data?: { scheduled?: unknown } };

// One empty list, so the memoized strip is not redrawn for a new one.
const NONE: ScheduledWorkSummary[] = [];

/**
 * The session's paused loops: those a restart of the server left with no process, which wait in
 * the transcript (see ScheduledWorkSummary's `paused`). Read while `enabled` (a Claude session
 * with no live scheduled work and no turn under way): when such a session opens, when it turns
 * idle, after each `run_ended` of it, and once the socket reconnects (a restart drops it).
 * Nothing while disabled: a live process holds the session then, and the server lists its work.
 * `refresh` reads again, for a stop or a resume the strip asked for. Read by ChatInterface for
 * the background-tasks strip.
 */
export function usePausedScheduledWork(sessionId: string | null, enabled: boolean) {
  const { subscribe } = useWebSocket();
  const [paused, setPaused] = useState<{ sessionId: string; items: ScheduledWorkSummary[] } | null>(null);
  // Reads are numbered as they start: an answer that comes back after a later read's describes
  // an older moment, or another session.
  const lastReadRef = useRef(0);
  // What a read started by an event checks, synced after every commit.
  const enabledRef = useRef(enabled);
  useLayoutEffect(() => {
    enabledRef.current = enabled;
  });

  const refresh = useCallback(async () => {
    lastReadRef.current += 1;
    const read = lastReadRef.current;
    // Disabled, the list reads empty (below), and is dropped as it turns so.
    if (!sessionId || !enabledRef.current) {
      return;
    }
    try {
      const response = await api.pausedScheduledWork(sessionId);
      if (!response.ok) {
        return;
      }
      const payload = (await response.json()) as PausedScheduledWorkPayload;
      if (read !== lastReadRef.current) {
        return;
      }
      setPaused({ sessionId, items: parseScheduledWork(payload.data?.scheduled) ?? [] });
    } catch (error) {
      console.error('[Chat] Failed to read the paused loops:', error);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (!sessionId) {
      return undefined;
    }
    return subscribe((event) => {
      if (event.kind === 'websocket_reconnected' || (event.kind === 'run_ended' && event.sessionId === sessionId)) {
        void refresh();
      }
    });
  }, [refresh, sessionId, subscribe]);

  // What a process held while it ran is not paused once it lets go: the list
  // is read afresh then, never shown from before.
  if (!enabled && paused !== null) {
    setPaused(null);
  }

  const items = enabled && paused && paused.sessionId === sessionId ? paused.items : NONE;
  return { items, refresh };
}
