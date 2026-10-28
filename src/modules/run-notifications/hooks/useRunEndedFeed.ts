import { useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { readSeenRunAlertKeys } from '@/modules/run-notifications/utils/runAlertCoordination';
import { api } from '@/shared/api';
import { useSessionProtectionActions } from '@/shared/context/SessionProtectionContext';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { LLMProvider, ResolveRunSessionLabel, RunAlert, RunAlertOutcome, ServerEvent } from '@/shared/types';

type UseRunEndedFeedInput = {
  /** Names a session for its alert; project-workspace's ProjectRunNotifications implements it. */
  resolveSessionLabel: ResolveRunSessionLabel;
  /** Receives each alert once: live ones as their run ends, catch-up ones after a reconnect. */
  onAlert: (alert: RunAlert) => void;
};

/** One run end as a `run_ended` frame and the recent-ends list carry it, once its fields have been checked. */
type RunEnd = {
  sessionId: string;
  provider: LLMProvider;
  /** The server's start time of the run, its identity. */
  runStartedAt: number;
  outcome: 'done' | 'failed' | 'aborted' | 'backgroundDone';
  /** 'done' only: the turn ended with background work still running. */
  backgroundWork: boolean;
  /** The session's custom name on the server, for a session this tab has not loaded. */
  sessionName: string | null;
};

/** How many handled alert keys this tab remembers, oldest forgotten first; far more than ten minutes of run ends. */
const HANDLED_RUN_END_KEY_LIMIT = 500;

/** Every provider a run can end for. A Record, so a provider added to LLMProvider must be added here too. */
const RUN_END_PROVIDERS: Record<LLMProvider, true> = { claude: true, cursor: true, codex: true, opencode: true, agy: true };

const RUN_END_OUTCOMES: ReadonlySet<string> = new Set<RunEnd['outcome']>(['done', 'failed', 'aborted', 'backgroundDone']);

/** Reads a `run_ended` frame, or an entry of the recent-ends list; null when a required field is missing or malformed. */
const parseRunEnd = (value: unknown): RunEnd | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const { sessionId, provider, runStartedAt, outcome, backgroundWork, sessionName } = value as Record<string, unknown>;
  if (
    typeof sessionId !== 'string'
    || !sessionId
    || typeof provider !== 'string'
    || !Object.prototype.hasOwnProperty.call(RUN_END_PROVIDERS, provider)
    || typeof runStartedAt !== 'number'
    || !Number.isFinite(runStartedAt)
    || typeof outcome !== 'string'
    || !RUN_END_OUTCOMES.has(outcome)
  ) {
    return null;
  }

  return {
    sessionId,
    provider: provider as LLMProvider,
    runStartedAt,
    outcome: outcome as RunEnd['outcome'],
    backgroundWork: backgroundWork === true,
    sessionName: typeof sessionName === 'string' && sessionName.trim() ? sessionName.trim() : null,
  };
};

/** The end's alert key, the same in every tab, so the tabs agree on which alert was claimed or seen. */
const toRunAlertKey = (end: RunEnd): string =>
  `${end.sessionId}:${end.runStartedAt}:${end.outcome === 'backgroundDone' ? 'background' : 'turn'}`;

/** What the end means for whoever waits on it; null for an aborted run, which raises no alert whoever stopped it. */
const toRunAlertOutcome = (end: RunEnd): RunAlertOutcome | null => {
  switch (end.outcome) {
    case 'done':
      return end.backgroundWork ? 'replied' : 'done';
    case 'failed':
      return 'failed';
    case 'backgroundDone':
      return 'backgroundDone';
    default:
      return null;
  }
};

/** The server's recent run ends (the last 10 minutes, oldest first); null when the request fails or the body lists none. */
const fetchRecentRunEnds = async (): Promise<RunEnd[] | null> => {
  try {
    const response = await api.runEnds();
    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as { data?: { ends?: unknown } } | null;
    const ends = body?.data?.ends;
    if (!Array.isArray(ends)) {
      return null;
    }
    return ends.map(parseRunEnd).filter((end): end is RunEnd => end !== null);
  } catch {
    return null;
  }
};

/**
 * Turns the server's run ends into alerts. Live `run_ended` frames raise alerts as they come, and also bring the
 * activity map up to date for a run this tab did not follow, so the title's running part and the spinners stop
 * with the alert rather than at the next poll. On mount the recent-ends list is read as a baseline (the ends it
 * lists happened before this tab was here); after each reconnect it is read again, and the ends missed meanwhile
 * come out as catch-up alerts, unless another tab has already shown them. Each alert key is handed over once.
 * Used by RunNotifications.
 */
export function useRunEndedFeed({ resolveSessionLabel, onAlert }: UseRunEndedFeedInput): void {
  const { t } = useTranslation('common');
  const { subscribe } = useWebSocket();
  const { markSessionIdle, markSessionBackground, getSessionActivity } = useSessionProtectionActions();

  // What the socket listener and the list reads use when they fire, synced after every commit, so the single
  // subscription never acts on a stale label resolver or callback.
  const latestRef = useRef({ resolveSessionLabel, onAlert, t, markSessionIdle, markSessionBackground, getSessionActivity });
  useLayoutEffect(() => {
    latestRef.current = { resolveSessionLabel, onAlert, t, markSessionIdle, markSessionBackground, getSessionActivity };
  });

  // Alert keys this tab has handled (alerted, or listed in the baseline), oldest first. A Set iterates in
  // insertion order, so the first key is the oldest when the limit is passed.
  const handledKeysRef = useRef(new Set<string>());
  // Whether a recent-ends read has served as the baseline yet. Until one succeeds, the next successful read is it.
  const hasBaselineRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    const handledKeys = handledKeysRef.current;

    const rememberHandled = (alertKey: string) => {
      handledKeys.add(alertKey);
      if (handledKeys.size > HANDLED_RUN_END_KEY_LIMIT) {
        const oldestKey = handledKeys.values().next().value;
        if (oldestKey !== undefined) {
          handledKeys.delete(oldestKey);
        }
      }
    };

    const toAlert = (end: RunEnd, alertKey: string, outcome: RunAlertOutcome, isCatchUp: boolean): RunAlert => {
      const label = latestRef.current.resolveSessionLabel(end.sessionId);
      return {
        key: alertKey,
        sessionId: end.sessionId,
        outcome,
        title: label?.title
          || end.sessionName
          || latestRef.current.t('runNotifications.untitledSession', { defaultValue: 'Untitled session' }),
        projectName: label?.projectName ?? null,
        provider: end.provider,
        receivedAt: Date.now(),
        isCatchUp,
      };
    };

    // A finished turn has no response in flight (a background-only entry is left alone); finished background
    // work clears the session's purple entry, but never a new turn the session has started since.
    const syncActivity = (end: RunEnd) => {
      const { markSessionIdle: markIdle, markSessionBackground: markBackground, getSessionActivity: readActivity } = latestRef.current;
      if (end.outcome !== 'backgroundDone') {
        markIdle(end.sessionId);
      } else if (readActivity(end.sessionId)?.background) {
        markBackground(end.sessionId, []);
      }
    };

    const handleLiveEnd = (end: RunEnd) => {
      syncActivity(end);
      const alertKey = toRunAlertKey(end);
      if (handledKeys.has(alertKey)) {
        return;
      }
      rememberHandled(alertKey);
      const outcome = toRunAlertOutcome(end);
      if (outcome) {
        latestRef.current.onAlert(toAlert(end, alertKey, outcome, false));
      }
    };

    const readRecentEnds = async () => {
      const ends = await fetchRecentRunEnds();
      if (disposed || !ends) {
        return;
      }

      if (!hasBaselineRef.current) {
        hasBaselineRef.current = true;
        ends.forEach((end) => rememberHandled(toRunAlertKey(end)));
        return;
      }

      // Ends missed while the socket was down: shown, never chimed (RunAlert.isCatchUp). Their activity is left
      // to the poll, since a session may well have started another run since.
      const seenKeys = readSeenRunAlertKeys();
      for (const end of ends) {
        const alertKey = toRunAlertKey(end);
        if (handledKeys.has(alertKey)) {
          continue;
        }
        rememberHandled(alertKey);
        const outcome = toRunAlertOutcome(end);
        if (outcome && !seenKeys.has(alertKey)) {
          latestRef.current.onAlert(toAlert(end, alertKey, outcome, true));
        }
      }
    };

    const unsubscribe = subscribe((event: ServerEvent) => {
      if (event.kind === 'run_ended') {
        const end = parseRunEnd(event);
        if (end) {
          handleLiveEnd(end);
        }
      } else if (event.kind === 'websocket_reconnected') {
        void readRecentEnds();
      }
    });
    // Subscribed first, so an end that comes while the baseline is read is still heard live.
    void readRecentEnds();

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [subscribe]);
}
