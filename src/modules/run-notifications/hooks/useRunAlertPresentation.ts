import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import {
  isPageActive,
  markRunAlertsSeen,
  subscribeToSeenRunAlerts,
} from '@/modules/run-notifications/utils/runAlertCoordination';
import type { DocumentTitleStatus, RunAlert, RunAlertOutcome } from '@/shared/types';
import { setDocumentTitleAlert } from '@/shared/utils';

type UseRunAlertPresentationInput = {
  /** The user's banner switch (UiPreferences.runAlertBanner); the title alert shows either way. */
  bannersEnabled: boolean;
  /** Sessions this tab shows in the Chat view of a pane on display: no banner for them while the user is on the tab. */
  onScreenSessionIds: ReadonlySet<string>;
};

type RunAlertPresentation = {
  /** Shows a new alert: in the title always, as a banner unless banners are off or its session is in front of the user. */
  present: (alert: RunAlert) => void;
  /** The banners to draw, newest first; empty while the tab is hidden, so ones that came meanwhile appear on return. */
  banners: RunAlert[];
  /** The banner's close button or swipe: drops the alert here and marks it seen for the other tabs. */
  dismissBanner: (alertKey: string) => void;
  /** The banner's "Open": drops the alert and marks it seen; the caller opens the session. */
  openBanner: (alertKey: string) => void;
  /** "Dismiss all": drops every banner and marks them seen. */
  dismissAllBanners: () => void;
  /** Reported by the banners while the pointer or the focus is on one: their visible time stops counting meanwhile. */
  setBannersHovered: (hovered: boolean) => void;
};

/** One queued banner: its alert, and the visible clock's reading when it arrived (see readVisibleClock). */
type QueuedRunAlertBanner = {
  alert: RunAlert;
  arrivedAtVisibleMs: number;
};

/** The title alert's groups, most urgent first: the title names the first group that has an unread alert. */
type TitleAlertGroup = 'failed' | 'done' | 'replied';

const TITLE_ALERT_GROUPS: readonly TitleAlertGroup[] = ['failed', 'done', 'replied'];

/** How long a banner stays once it has been visible this long in total (the page visible, no banner hovered). */
const BANNER_VISIBLE_MS = 8000;

/** Most banners the queue keeps; older ones beyond it are dropped. */
const BANNER_QUEUE_LIMIT = 20;

/** The title alert switches between itself and the normal title this often while the user is away. */
const TITLE_ALERT_BLINK_MS = 1000;

/** How long the title alert shows, still, once the user is on the tab, before it counts as seen and clears. */
const TITLE_ALERT_SEEN_AFTER_MS = 2000;

const NO_BANNERS: RunAlert[] = [];

/** The title group an outcome counts in: finished background work reads as done. */
const toTitleAlertGroup = (outcome: RunAlertOutcome): TitleAlertGroup => (outcome === 'backgroundDone' ? 'done' : outcome);

/** The localized marker of a title group, with the number of its unread alerts when there is more than one ("[Done 2]"). */
const readTitleAlertMarker = (group: TitleAlertGroup, count: number, t: TFunction): string => {
  switch (group) {
    case 'failed':
      return count > 1
        ? t('runNotifications.title.failedCount', { count, defaultValue: '[Failed {{count}}]' })
        : t('runNotifications.title.failed', { defaultValue: '[Failed]' });
    case 'replied':
      return count > 1
        ? t('runNotifications.title.repliedCount', { count, defaultValue: '[Replied {{count}}]' })
        : t('runNotifications.title.replied', { defaultValue: '[Replied]' });
    default:
      return count > 1
        ? t('runNotifications.title.doneCount', { count, defaultValue: '[Done {{count}}]' })
        : t('runNotifications.title.done', { defaultValue: '[Done]' });
  }
};

/** The title's alert part for the unread alerts (oldest first): the most urgent group's marker and its newest alert's title. */
const buildTitleAlertStatus = (alerts: readonly RunAlert[], t: TFunction): DocumentTitleStatus | null => {
  for (const group of TITLE_ALERT_GROUPS) {
    const members = alerts.filter((alert) => toTitleAlertGroup(alert.outcome) === group);
    if (members.length > 0) {
      return { marker: readTitleAlertMarker(group, members.length, t), subject: members[members.length - 1].title };
    }
  }
  return null;
};

/**
 * How finished-run alerts show in this tab. The title's alert part names the unread alerts, failed first, then
 * done, then replied ("[Done 2] Fix login bug"): it blinks every second while the user is away, and once the user
 * is on the tab it stays still for 2 s, then clears and marks those alerts seen. Banners queue newest first; each
 * goes after 8 s of being visible (time while the page is hidden or a banner is hovered does not count), and one
 * that arrives while the page is hidden waits for it to be visible. A session in front of the user gets no banner,
 * and a session brought on screen loses its alerts. Alerts another tab marks seen go here too, shown banners
 * included. Used by RunNotifications.
 */
export function useRunAlertPresentation({ bannersEnabled, onScreenSessionIds }: UseRunAlertPresentationInput): RunAlertPresentation {
  const { t } = useTranslation('common');

  // The alerts this tab has not shown the user yet, oldest first. The title's alert part is derived from them,
  // and they clear (counting as seen) once the user has been on the tab for 2 s.
  const [titleAlerts, setTitleAlerts] = useState<RunAlert[]>([]);
  // The banner queue, newest first, at most BANNER_QUEUE_LIMIT. Each banner keeps the visible clock's reading at
  // its arrival, so its visible time so far is the clock's reading now minus that, and it goes at BANNER_VISIBLE_MS.
  const [bannerQueue, setBannerQueue] = useState<QueuedRunAlertBanner[]>([]);
  // Whether the user is on this tab (visible and focused): the title alert blinks while not, and clears 2 s after it is.
  const [isActive, setIsActive] = useState(isPageActive);
  // Whether the tab is visible: banners show, and count their visible time, only then.
  const [isPageVisible, setIsPageVisible] = useState(() => document.visibilityState === 'visible');
  // Whether the pointer or the focus is on a banner: their visible time stops counting while the user reads one.
  const [isBannerHovered, setIsBannerHovered] = useState(false);

  // Turning banners off takes away the ones showing (state adjusted during render, so they never draw again).
  if (!bannersEnabled && bannerQueue.length > 0) {
    setBannerQueue([]);
  }

  // The latest of each, for callbacks that run outside render (the socket, the storage event, timers).
  const latestRef = useRef({ titleAlerts, bannerQueue, bannersEnabled, onScreenSessionIds });
  useLayoutEffect(() => {
    latestRef.current = { titleAlerts, bannerQueue, bannersEnabled, onScreenSessionIds };
  });

  // The visible clock: milliseconds during which banners counted (page visible, none hovered), so a banner's
  // visible time is the difference between two readings. Banked time, plus the stretch running now, if any.
  const visibleClockBankedMsRef = useRef(0);
  const visibleClockRunningSinceRef = useRef<number | null>(null);
  const readVisibleClock = useCallback((): number => {
    const runningSince = visibleClockRunningSinceRef.current;
    return visibleClockBankedMsRef.current + (runningSince === null ? 0 : Date.now() - runningSince);
  }, []);

  const isBannerClockRunning = isPageVisible && !isBannerHovered;
  useEffect(() => {
    if (!isBannerClockRunning) {
      return undefined;
    }
    visibleClockRunningSinceRef.current = Date.now();
    return () => {
      const runningSince = visibleClockRunningSinceRef.current;
      if (runningSince !== null) {
        visibleClockBankedMsRef.current += Date.now() - runningSince;
      }
      visibleClockRunningSinceRef.current = null;
    };
  }, [isBannerClockRunning]);

  // Takes the banner that has been visible longest away once it reaches BANNER_VISIBLE_MS, then the next.
  useEffect(() => {
    if (!isBannerClockRunning || bannerQueue.length === 0) {
      return undefined;
    }
    const firstExpiry = Math.min(...bannerQueue.map((banner) => banner.arrivedAtVisibleMs + BANNER_VISIBLE_MS));
    const timer = window.setTimeout(() => {
      const now = readVisibleClock();
      setBannerQueue((queue) => {
        const kept = queue.filter((banner) => now - banner.arrivedAtVisibleMs < BANNER_VISIBLE_MS);
        // A new array either way: should a timer fire a hair early, the schedule runs again rather than stop.
        return kept.length === queue.length ? [...queue] : kept;
      });
    }, Math.max(0, firstExpiry - readVisibleClock()));
    return () => window.clearTimeout(timer);
  }, [bannerQueue, isBannerClockRunning, readVisibleClock]);

  // Removes the alerts that match from the title and the banners; with markSeen, records them as seen for the
  // other tabs. The keys are taken from the latest committed lists, the removal from whatever state is current.
  const removeAlerts = useCallback((matches: (alert: RunAlert) => boolean, { markSeen }: { markSeen: boolean }) => {
    const { titleAlerts: currentTitleAlerts, bannerQueue: currentBanners } = latestRef.current;
    const removedKeys = new Set<string>();
    currentTitleAlerts.forEach((alert) => {
      if (matches(alert)) {
        removedKeys.add(alert.key);
      }
    });
    currentBanners.forEach(({ alert }) => {
      if (matches(alert)) {
        removedKeys.add(alert.key);
      }
    });
    if (removedKeys.size === 0) {
      return;
    }

    setTitleAlerts((alerts) => {
      const kept = alerts.filter((alert) => !matches(alert));
      return kept.length === alerts.length ? alerts : kept;
    });
    setBannerQueue((queue) => {
      const kept = queue.filter(({ alert }) => !matches(alert));
      return kept.length === queue.length ? queue : kept;
    });
    if (markSeen) {
      markRunAlertsSeen([...removedKeys]);
    }
  }, []);

  // Visibility and focus come from the page, not from React. A tab the user comes back to first drops the
  // banners of sessions already on screen: the pane itself shows how they ended.
  useEffect(() => {
    const updatePageState = () => {
      const active = isPageActive();
      setIsActive(active);
      setIsPageVisible(document.visibilityState === 'visible');
      if (active) {
        const onScreen = latestRef.current.onScreenSessionIds;
        setBannerQueue((queue) => {
          const kept = queue.filter(({ alert }) => !onScreen.has(alert.sessionId));
          return kept.length === queue.length ? queue : kept;
        });
      }
    };
    document.addEventListener('visibilitychange', updatePageState);
    window.addEventListener('focus', updatePageState);
    window.addEventListener('blur', updatePageState);
    return () => {
      document.removeEventListener('visibilitychange', updatePageState);
      window.removeEventListener('focus', updatePageState);
      window.removeEventListener('blur', updatePageState);
    };
  }, []);

  // A session the user brings on screen (opens it, switches to its tab) while on the page: its alerts are seen.
  const previousOnScreenSessionIdsRef = useRef(onScreenSessionIds);
  useEffect(() => {
    const previous = previousOnScreenSessionIdsRef.current;
    previousOnScreenSessionIdsRef.current = onScreenSessionIds;
    if (!isPageActive()) {
      return;
    }
    const entered = new Set([...onScreenSessionIds].filter((sessionId) => !previous.has(sessionId)));
    if (entered.size > 0) {
      removeAlerts((alert) => entered.has(alert.sessionId), { markSeen: true });
    }
  }, [onScreenSessionIds, removeAlerts]);

  // Alerts another tab marked seen: gone here too, shown banners included. Not marked again.
  useEffect(() => subscribeToSeenRunAlerts((alertKeys) => {
    const seenKeys = new Set(alertKeys);
    removeAlerts((alert) => seenKeys.has(alert.key), { markSeen: false });
  }), [removeAlerts]);

  const titleStatus = useMemo(() => buildTitleAlertStatus(titleAlerts, t), [titleAlerts, t]);
  const titleMarker = titleStatus?.marker ?? null;
  const titleSubject = titleStatus?.subject ?? null;

  // The title's alert part: blinking while the user is away; still while on the tab, then cleared after 2 s and
  // marked seen. Leaving within those 2 s cancels the clearing and the blinking resumes.
  useEffect(() => {
    if (titleMarker === null || titleSubject === null) {
      setDocumentTitleAlert(null);
      return undefined;
    }

    const status: DocumentTitleStatus = { marker: titleMarker, subject: titleSubject };
    setDocumentTitleAlert(status);
    if (isActive) {
      const clearTimer = window.setTimeout(() => {
        const seenKeys = latestRef.current.titleAlerts.map((alert) => alert.key);
        setTitleAlerts([]);
        markRunAlertsSeen(seenKeys);
      }, TITLE_ALERT_SEEN_AFTER_MS);
      return () => window.clearTimeout(clearTimer);
    }

    let isShown = true;
    const blinkTimer = window.setInterval(() => {
      isShown = !isShown;
      setDocumentTitleAlert(isShown ? status : null);
    }, TITLE_ALERT_BLINK_MS);
    return () => window.clearInterval(blinkTimer);
  }, [isActive, titleMarker, titleSubject]);

  // A workspace that goes away (sign-out, another route) leaves no alert in the title.
  useEffect(() => () => setDocumentTitleAlert(null), []);

  const present = useCallback((alert: RunAlert) => {
    setTitleAlerts((alerts) => (alerts.some((entry) => entry.key === alert.key) ? alerts : [...alerts, alert]));

    const { bannersEnabled: showsBanners, onScreenSessionIds: onScreen } = latestRef.current;
    if (!showsBanners || (onScreen.has(alert.sessionId) && isPageActive())) {
      return;
    }
    const arrivedAtVisibleMs = readVisibleClock();
    setBannerQueue((queue) => (
      queue.some((banner) => banner.alert.key === alert.key)
        ? queue
        : [{ alert, arrivedAtVisibleMs }, ...queue].slice(0, BANNER_QUEUE_LIMIT)
    ));
  }, [readVisibleClock]);

  const dismissBanner = useCallback((alertKey: string) => {
    removeAlerts((alert) => alert.key === alertKey, { markSeen: true });
  }, [removeAlerts]);

  const dismissAllBanners = useCallback(() => {
    const bannerKeys = new Set(latestRef.current.bannerQueue.map(({ alert }) => alert.key));
    removeAlerts((alert) => bannerKeys.has(alert.key), { markSeen: true });
  }, [removeAlerts]);

  const banners = useMemo(
    () => (isPageVisible && bannerQueue.length > 0 ? bannerQueue.map(({ alert }) => alert) : NO_BANNERS),
    [bannerQueue, isPageVisible],
  );

  return {
    present,
    banners,
    dismissBanner,
    openBanner: dismissBanner,
    dismissAllBanners,
    setBannersHovered: setIsBannerHovered,
  };
}
