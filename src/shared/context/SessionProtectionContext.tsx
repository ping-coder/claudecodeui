import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import type { ReactNode } from 'react';

import {
  useSessionProtection,
} from '@/shared/hooks/useSessionProtection';
import type { BackgroundTaskSummary, GetSessionActivity, IsSessionProcessing, MarkSessionBackground, MarkSessionIdle, MarkSessionProcessing, SessionActivity, SessionActivityMap, SyncProcessingSessions } from '@/shared/types';
import { api } from '@/shared/api';
import { parseScheduledWork } from '@/shared/utils';

type RunningSessionApiItem = {
  sessionId?: unknown;
  startedAt?: unknown;
  statusText?: unknown;
  canInterrupt?: unknown;
  background?: unknown;
  tasks?: unknown;
  scheduled?: unknown;
};

type RunningSessionsApiPayload = {
  data?: {
    sessions?: RunningSessionApiItem[];
  };
};

type SessionProtectionActions = {
  markSessionProcessing: MarkSessionProcessing;
  markSessionIdle: MarkSessionIdle;
  markSessionBackground: MarkSessionBackground;
  syncProcessingSessions: SyncProcessingSessions;
  isSessionProcessing: IsSessionProcessing;
  getSessionActivity: GetSessionActivity;
  /**
   * Reads the running sessions now, as the poll does every few seconds;
   * settles once the map holds the answer (or the read failed). For what only
   * the server can tell right after an event: the scheduled work a turn left
   * (chat's realtime handlers, at its `complete`), or what a stop of it left
   * (chat's background-tasks strip).
   */
  refreshRunningSessions: () => Promise<void>;
};

const SessionProtectionStateContext = createContext<SessionActivityMap | null>(null);
const SessionProtectionActionsContext = createContext<SessionProtectionActions | null>(null);
const BusySessionIdsContext = createContext<ReadonlySet<string> | null>(null);
const BackgroundSessionIdsContext = createContext<ReadonlySet<string> | null>(null);

/**
 * The set of session ids whose activity passes `include`, with a stable
 * identity while membership is unchanged.
 *
 * Every provider `status` frame rewrites an entry's `statusText`, which
 * allocates a new activity map several times a second during a run. Consumers
 * that only need membership — the sidebar renders a dot per row and a running
 * count — would re-render on all of it.
 */
function useSessionIdSet(
  processingSessions: SessionActivityMap,
  include: (activity: SessionActivity) => boolean,
): ReadonlySet<string> {
  // Deriving the set from a membership key, rather than from the map, keeps its
  // identity stable across the `statusText` rewrites without reading a ref
  // during render. Session ids never contain a NUL, so it is a safe separator.
  const membershipKey = [...processingSessions]
    .filter(([, activity]) => include(activity))
    .map(([sessionId]) => sessionId)
    .sort()
    .join('\u0000');

  return useMemo(
    () => new Set(membershipKey ? membershipKey.split('\u0000') : []),
    [membershipKey],
  );
}

const isAnyActivity = () => true;
const isBackgroundOnly = (activity: SessionActivity) => Boolean(activity.background);

const parseStartedAt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** The poll's task list, kept only when every entry has the shape the indicator reads. */
const parseBackgroundTasks = (value: unknown): BackgroundTaskSummary[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const tasks: BackgroundTaskSummary[] = [];
  for (const item of value) {
    const task = item as Partial<Record<keyof BackgroundTaskSummary, unknown>> | null;
    if (
      !task
      || typeof task.taskId !== 'string'
      || typeof task.toolUseId !== 'string'
      || typeof task.taskType !== 'string'
      || typeof task.description !== 'string'
      || typeof task.startedAt !== 'number'
    ) {
      // One entry the server wrote in a shape this client does not read
      // should not hide the rest of the session's work.
      continue;
    }
    tasks.push({
      taskId: task.taskId,
      toolUseId: task.toolUseId,
      taskType: task.taskType,
      description: task.description,
      ...(typeof task.workflowName === 'string' ? { workflowName: task.workflowName } : {}),
      startedAt: task.startedAt,
      ...(task.nested === true ? { nested: true } : {}),
    });
  }
  return tasks;
};

/** Mounted by the project-workspace route; tracks which sessions are busy — producing a response, running background tasks or holding scheduled work — so chat, sidebar, project-workspace and run-notifications agree on session activity. */
export function SessionProtectionProvider({ children }: { children: ReactNode }) {
  const {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
    markSessionBackground,
    syncProcessingSessions,
    isSessionProcessing,
    getSessionActivity,
  } = useSessionProtection();

  // Reads are numbered as they start. Besides the poll, an event can ask for
  // one (refreshRunningSessions), so two can be out at once, and an answer
  // that comes back after a later read's has been applied describes an older
  // moment: it is dropped.
  const lastReadRef = useRef(0);
  const lastAppliedReadRef = useRef(0);

  const refreshRunningSessions = useCallback(async () => {
    lastReadRef.current += 1;
    const read = lastReadRef.current;
    try {
      const response = await api.runningSessions();
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as RunningSessionsApiPayload;
      if (read < lastAppliedReadRef.current) {
        return;
      }
      lastAppliedReadRef.current = read;
      const sessions = Array.isArray(payload.data?.sessions) ? payload.data.sessions : [];

      syncProcessingSessions(
        sessions
          .map((session) => {
            if (typeof session.sessionId !== 'string' || !session.sessionId) {
              return null;
            }

            return {
              sessionId: session.sessionId,
              startedAt: parseStartedAt(session.startedAt),
              statusText: typeof session.statusText === 'string' ? session.statusText : undefined,
              canInterrupt: typeof session.canInterrupt === 'boolean' ? session.canInterrupt : undefined,
              background: session.background === true,
              tasks: parseBackgroundTasks(session.tasks),
              scheduled: parseScheduledWork(session.scheduled),
            };
          })
          .filter((session): session is NonNullable<typeof session> => Boolean(session)),
      );
    } catch (error) {
      console.error('[SessionProtection] Failed to sync running sessions:', error);
    }
  }, [syncProcessingSessions]);

  useEffect(() => {
    void refreshRunningSessions();
  }, [refreshRunningSessions]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshRunningSessions();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [refreshRunningSessions]);

  const actions = useMemo<SessionProtectionActions>(
    () => ({
      markSessionProcessing,
      markSessionIdle,
      markSessionBackground,
      syncProcessingSessions,
      isSessionProcessing,
      getSessionActivity,
      refreshRunningSessions,
    }),
    [
      getSessionActivity,
      isSessionProcessing,
      markSessionBackground,
      markSessionIdle,
      markSessionProcessing,
      refreshRunningSessions,
      syncProcessingSessions,
    ],
  );

  const busySessionIds = useSessionIdSet(processingSessions, isAnyActivity);
  const backgroundSessionIds = useSessionIdSet(processingSessions, isBackgroundOnly);

  return (
    <SessionProtectionActionsContext.Provider value={actions}>
      <BusySessionIdsContext.Provider value={busySessionIds}>
        <BackgroundSessionIdsContext.Provider value={backgroundSessionIds}>
          <SessionProtectionStateContext.Provider value={processingSessions}>
            {children}
          </SessionProtectionStateContext.Provider>
        </BackgroundSessionIdsContext.Provider>
      </BusySessionIdsContext.Provider>
    </SessionProtectionActionsContext.Provider>
  );
}

/**
 * Membership-only view of the busy sessions, background work included. Prefer
 * this over useProcessingSessions wherever the activity details are not
 * rendered.
 */
export function useBusySessionIdSet(): ReadonlySet<string> {
  const busySessionIds = useContext(BusySessionIdsContext);
  if (!busySessionIds) {
    throw new Error('useBusySessionIdSet must be used within SessionProtectionProvider');
  }
  return busySessionIds;
}

/**
 * The busy sessions that are only running background tasks — no response in
 * flight. A subset of useBusySessionIdSet, with the same stable identity, for
 * the sidebar rows and the pane tabs to draw those sessions differently.
 */
export function useBackgroundSessionIdSet(): ReadonlySet<string> {
  const backgroundSessionIds = useContext(BackgroundSessionIdsContext);
  if (!backgroundSessionIds) {
    throw new Error('useBackgroundSessionIdSet must be used within SessionProtectionProvider');
  }
  return backgroundSessionIds;
}

/**
 * The whole activity map, details included (status text, start time, background tasks), so it changes with
 * every provider status frame. Read by chat's ChatInterface for its activity indicator and by project-workspace's
 * ProjectEffects for the running part of the tab title; prefer the membership sets above when ids are enough.
 */
export function useProcessingSessions(): SessionActivityMap {
  const processingSessions = useContext(SessionProtectionStateContext);
  if (!processingSessions) {
    throw new Error('useProcessingSessions must be used within SessionProtectionProvider');
  }
  return processingSessions;
}

/**
 * The stable actions on the activity map, for code that writes it or reads it at event time without
 * re-rendering on its changes. Used by chat's ChatInterface (sends, realtime frames), its background-tasks
 * strip (refreshRunningSessions once a stop of scheduled work is answered), project-workspace's
 * ProjectWorkspaceRoute (isSessionProcessing) and run-notifications, which settles a session's entry when
 * `run_ended` reports its run over.
 */
export function useSessionProtectionActions(): SessionProtectionActions {
  const actions = useContext(SessionProtectionActionsContext);
  if (!actions) {
    throw new Error('useSessionProtectionActions must be used within SessionProtectionProvider');
  }
  return actions;
}
