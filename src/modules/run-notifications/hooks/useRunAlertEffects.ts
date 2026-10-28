import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  claimRunAlert,
  describeRunAlertOutcome,
  isPageActive,
  readBrowserPushSubscribed,
  readDesktopNotificationsBridge,
  showRunAlertSystemNotification,
} from '@/modules/run-notifications/utils/runAlertCoordination';
import { api } from '@/shared/api';
import { useDeploymentEnvironment } from '@/shared/hooks/useDeploymentEnvironment';
import type { RunAlert, RunAlertOutcome } from '@/shared/types';
import {
  getDeploymentEnvironmentLabel,
  playChatCompletionSound,
  primeNotificationSound,
  setNotificationSoundEnabled,
} from '@/shared/utils';

type UseRunAlertEffectsInput = {
  /** The user's "system notification" switch (UiPreferences.runAlertSystemNotification). */
  systemNotificationsEnabled: boolean;
};

type RunAlertEffects = {
  /** Chimes and posts the system notification for an alert, in the one tab of the browser that claims it. */
  announce: (alert: RunAlert) => void;
  /** Whether this browser holds a push subscription; null until the first read finishes. */
  isBrowserPushSubscribed: boolean | null;
};

/** What announce reads of the server's notification preferences: the channels that sound on their own, and the events they fire for. */
type RunAlertDeliveryPreferences = {
  webPush: boolean;
  desktop: boolean;
  events: { stop: boolean; error: boolean };
};

/** How long the server's notification preferences are trusted before an announce reads them again, in the background. */
const PREFERENCES_MAX_AGE_MS = 60_000;

/** How long the push subscription check is trusted while the user is on the page. */
const PUSH_SUBSCRIPTION_MAX_AGE_MS = 60_000;

/**
 * Away from the page, how long a delivery trusts the preferences and the push subscription as last read. Older,
 * it reads them again first, so a change made since (in Settings here, in another tab, on another device) holds
 * from the next completion on.
 */
const AWAY_DELIVERY_TRUST_MS = 5000;

/** How long an away delivery waits for fresh preferences: past it, as when the read fails, the page alerts on its own. */
const AWAY_PREFERENCES_READ_TIMEOUT_MS = 1500;

/** A tab the user is not on waits this long before claiming, plus up to CLAIM_DELAY_SPREAD_MS, so the tab in use claims first. */
const CLAIM_DELAY_BACKGROUND_MS = 300;

/** Random spread added to CLAIM_DELAY_BACKGROUND_MS, so two background tabs rarely claim in the same millisecond. */
const CLAIM_DELAY_SPREAD_MS = 200;

/** A tab never interacted with claims last: the browser's autoplay policy most likely keeps it silent. */
const CLAIM_DELAY_NEVER_ACTIVE_MS = 800;

/** Longest system notification title, in characters, ellipsis included. */
const NOTIFICATION_TITLE_MAX_LENGTH = 80;

/** How long this tab waits before claiming an alert: the tab the user is on at once, a never-used tab last, any other in between. */
const resolveClaimDelayMs = (): number => {
  if (isPageActive()) {
    return 0;
  }
  if (navigator.userActivation?.hasBeenActive === false) {
    return CLAIM_DELAY_NEVER_ACTIVE_MS;
  }
  return CLAIM_DELAY_BACKGROUND_MS + Math.random() * CLAIM_DELAY_SPREAD_MS;
};

/** Reads `{ preferences: { channels, events } }` from the notification preferences API; null when the body has none. */
const parseDeliveryPreferences = (body: unknown): { delivery: RunAlertDeliveryPreferences; sound: unknown } | null => {
  const preferences = (body as { preferences?: unknown } | null)?.preferences;
  if (!preferences || typeof preferences !== 'object') {
    return null;
  }

  const { channels, events } = preferences as { channels?: Record<string, unknown>; events?: Record<string, unknown> };
  return {
    delivery: {
      webPush: channels?.webPush === true,
      desktop: channels?.desktop === true,
      events: { stop: events?.stop === true, error: events?.error === true },
    },
    sound: channels?.sound,
  };
};

/** The notification code of an outcome, as the server's pushes name it: it goes into the tag and the data. */
const toNotificationCode = (outcome: RunAlertOutcome): string => {
  switch (outcome) {
    case 'failed':
      return 'run.failed';
    case 'backgroundDone':
      return 'run.background_completed';
    default:
      return 'run.stopped';
  }
};

/** Cuts a title to NOTIFICATION_TITLE_MAX_LENGTH characters, ending it with an ellipsis; counts code points, so no emoji is split. */
const truncateNotificationTitle = (title: string): string => {
  const characters = Array.from(title);
  return characters.length > NOTIFICATION_TITLE_MAX_LENGTH
    ? `${characters.slice(0, NOTIFICATION_TITLE_MAX_LENGTH - 1).join('')}…`
    : title;
};

/** Reads `desktopNotifications.enabled` from a desktop bridge state. */
const readDesktopNotificationsEnabled = (state: unknown): boolean =>
  (state as { desktopNotifications?: { enabled?: unknown } } | null)?.desktopNotifications?.enabled === true;

/** Resolves as `promise` does if it resolves within `timeoutMs`; to `fallback` if it rejects or takes longer. */
const settleWithin = <T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> => new Promise((resolve) => {
  const timer = window.setTimeout(() => resolve(fallback), timeoutMs);
  promise.then(resolve, () => resolve(fallback)).finally(() => window.clearTimeout(timer));
});

/**
 * The sound and the system notification of finished-run alerts. On mount it reads the server's notification
 * preferences and mirrors `channels.sound` into the local sound switch (which used to stay on until the user opened
 * Settings on that device), follows the desktop app's notification switch, checks for a push subscription, and
 * unlocks the chime on every pointerdown and keydown. `announce` lets the tab the user is on claim at once and the
 * others a little later. With the user away, the claimer first reads the preferences and the push subscription again
 * unless they were read in the last few seconds. It chimes, unless the desktop app or push will make the sound, and
 * posts a system notification when the user is away and nothing else will, silent once the burst has made its
 * sound. Used by RunNotifications.
 */
export function useRunAlertEffects({ systemNotificationsEnabled }: UseRunAlertEffectsInput): RunAlertEffects {
  const { t } = useTranslation('common');
  const environment = useDeploymentEnvironment();
  const environmentLabel = environment ? getDeploymentEnvironmentLabel(environment, t) : null;

  // Whether this browser holds a push subscription; null until the first check. RunNotifications offers the
  // system-notification prompt only once it is known to be false, as push already delivers notifications otherwise.
  const [isBrowserPushSubscribed, setIsBrowserPushSubscribed] = useState<boolean | null>(null);

  // What a delivery reads when it fires, synced after every commit.
  const latestRef = useRef({ t, environmentLabel, systemNotificationsEnabled });
  useLayoutEffect(() => {
    latestRef.current = { t, environmentLabel, systemNotificationsEnabled };
  });

  // Set once the hook unmounts, so a delivery still waiting on its claim or chime posts nothing for a signed-out page.
  const disposedRef = useRef(false);
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);

  // The server's notification preferences as last read and when; null until a read succeeds.
  const preferencesRef = useRef<{ delivery: RunAlertDeliveryPreferences; readAt: number } | null>(null);
  // The read in flight, if any. Every caller gets it until it settles rather than starting another: a delivery
  // waits on the very read that announce, or the mount, started.
  const preferencesReadRef = useRef<Promise<boolean> | null>(null);

  // Reads the preferences again; resolves to whether that read succeeded. A failed one leaves the last answer in place.
  const refreshPreferences = useCallback((): Promise<boolean> => {
    if (preferencesReadRef.current) {
      return preferencesReadRef.current;
    }
    const read = (async () => {
      try {
        const response = await api.settings.notificationPreferences();
        if (!response.ok) {
          return false;
        }
        const parsed = parseDeliveryPreferences(await response.json());
        if (!parsed || disposedRef.current) {
          return false;
        }
        preferencesRef.current = { delivery: parsed.delivery, readAt: Date.now() };
        if (typeof parsed.sound === 'boolean') {
          setNotificationSoundEnabled(parsed.sound);
        }
        return true;
      } catch {
        return false;
      }
    })();
    preferencesReadRef.current = read;
    // Let go of it once settled. A then-callback never runs at once, so this always follows the assignment above.
    void read.then(() => {
      if (preferencesReadRef.current === read) {
        preferencesReadRef.current = null;
      }
    });
    return read;
  }, []);

  useEffect(() => {
    void refreshPreferences();
  }, [refreshPreferences]);

  // Whether the desktop app's own notifications are on; false in a browser. Read when a delivery decides, never rendered.
  const desktopNotificationsEnabledRef = useRef(false);
  useEffect(() => {
    const bridge = readDesktopNotificationsBridge();
    if (!bridge) {
      return undefined;
    }

    let isListening = true;
    const applyState = (state: unknown) => {
      if (isListening) {
        desktopNotificationsEnabledRef.current = readDesktopNotificationsEnabled(state);
      }
    };
    // Called inside the chain, so a bridge whose getState is missing or throws leaves the desktop notifications
    // off instead of throwing out of the effect and taking the workspace down.
    Promise.resolve()
      .then(() => bridge.getState())
      .then(applyState)
      .catch(() => undefined);
    const unsubscribe = typeof bridge.onStateUpdated === 'function' ? bridge.onStateUpdated(applyState) : undefined;
    return () => {
      isListening = false;
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, []);

  // The push subscription check as last made and when, so a delivery soon after it does not repeat it.
  const pushSubscriptionRef = useRef<{ subscribed: boolean; readAt: number } | null>(null);

  // Whether this browser holds a push subscription: the last check while under `maxAgeMs` old, else a new one.
  const readPushSubscribed = useCallback(async (maxAgeMs: number): Promise<boolean> => {
    const cached = pushSubscriptionRef.current;
    if (cached && Date.now() - cached.readAt < maxAgeMs) {
      return cached.subscribed;
    }
    const subscribed = await readBrowserPushSubscribed();
    pushSubscriptionRef.current = { subscribed, readAt: Date.now() };
    if (!disposedRef.current) {
      setIsBrowserPushSubscribed(subscribed);
    }
    return subscribed;
  }, []);

  useEffect(() => {
    void readPushSubscribed(PUSH_SUBSCRIPTION_MAX_AGE_MS);
  }, [readPushSubscribed]);

  // Every gesture resumes the chime's audio context, so a chime later played outside any gesture (and after iOS
  // interrupted the context) is heard. Capture phase, so a handler that stops propagation cannot hide the gesture.
  useEffect(() => {
    const prime = () => primeNotificationSound();
    window.addEventListener('pointerdown', prime, { capture: true, passive: true });
    window.addEventListener('keydown', prime, { capture: true, passive: true });
    return () => {
      window.removeEventListener('pointerdown', prime, { capture: true });
      window.removeEventListener('keydown', prime, { capture: true });
    };
  }, []);

  const deliver = useCallback(async (alert: RunAlert) => {
    const claim = await claimRunAlert(alert.key);
    if (!claim.claimed || disposedRef.current) {
      return;
    }

    // Away from the page, the preferences decide whether push or the desktop app sounds instead of the page, and the
    // user may have changed them since they were read: older than AWAY_DELIVERY_TRUST_MS, they are read again first
    // (by the claimer alone, so one request per completion at most). Without an answer in time the page alerts on
    // its own. A push that comes as well replaces the page's notification (same tag), but sw.js sounds it again when
    // no window has focus: a possible second sound, taken over a possible silence.
    const isAway = !isPageActive();
    const preferences = preferencesRef.current;
    let delivery = preferences?.delivery ?? null;
    if (isAway && (!preferences || Date.now() - preferences.readAt > AWAY_DELIVERY_TRUST_MS)) {
      const isRead = await settleWithin(refreshPreferences(), AWAY_PREFERENCES_READ_TIMEOUT_MS, false);
      if (disposedRef.current) {
        return;
      }
      delivery = isRead ? preferencesRef.current?.delivery ?? null : null;
    }

    const eventEnabled = delivery?.events[alert.outcome === 'failed' ? 'error' : 'stop'] === true;
    const desktopBridge = readDesktopNotificationsBridge();
    // The desktop app's native notification makes its own sound.
    const desktopWillAlert = desktopBridge !== null
      && desktopNotificationsEnabledRef.current
      && delivery?.desktop === true
      && eventEnabled;
    // Push delivers the system notification, with its sound unless a CloudCLI window has focus (sw.js). Away, the
    // subscription gets the same few seconds of trust as the preferences: Settings may have dropped or made it since.
    const pushWillAlert = delivery?.webPush === true
      && eventEnabled
      && (await readPushSubscribed(isAway ? AWAY_DELIVERY_TRUST_MS : PUSH_SUBSCRIPTION_MAX_AGE_MS));

    let chimed = false;
    if (claim.chime && !desktopWillAlert && !(pushWillAlert && !isPageActive())) {
      chimed = await playChatCompletionSound();
    }

    if (
      disposedRef.current
      || isPageActive()
      || desktopBridge !== null
      || pushWillAlert
      || !latestRef.current.systemNotificationsEnabled
      || !('Notification' in window)
      || Notification.permission !== 'granted'
    ) {
      return;
    }

    const { t: translate, environmentLabel: label } = latestRef.current;
    const outcomeText = describeRunAlertOutcome(alert.outcome, translate);
    const code = toNotificationCode(alert.outcome);
    await showRunAlertSystemNotification({
      title: truncateNotificationTitle(label ? `${label} · ${alert.title}` : alert.title),
      body: alert.projectName
        ? translate('runNotifications.withProject', {
          outcome: outcomeText,
          project: alert.projectName,
          defaultValue: '{{outcome}} · {{project}}',
        })
        : outcomeText,
      tag: `${alert.provider}:${alert.sessionId}:${code}`,
      data: { sessionId: alert.sessionId, provider: alert.provider, code },
      // Silent once the burst has made its sound: the page chimed, or a claim within the last 1.5 s, in this tab or
      // another, took the burst's one chime. The price: should that claim make no sound in the end (its chime failed
      // or the sound was off while the user was on its tab, so it posted nothing; its tab closed first), the whole
      // burst stays silent, where this notification used to sound.
      silent: chimed || !claim.chime,
    });
  }, [readPushSubscribed, refreshPreferences]);

  // Claim timers still waiting, cleared on unmount.
  const claimTimersRef = useRef(new Set<number>());
  useEffect(() => {
    const claimTimers = claimTimersRef.current;
    return () => {
      claimTimers.forEach((timer) => window.clearTimeout(timer));
      claimTimers.clear();
    };
  }, []);

  const announce = useCallback((alert: RunAlert) => {
    // Catch-up alerts are old news: shown, never chimed or notified.
    if (alert.isCatchUp) {
      return;
    }

    const preferences = preferencesRef.current;
    if (!preferences || Date.now() - preferences.readAt > PREFERENCES_MAX_AGE_MS) {
      // In the background. With the user on the page this alert goes by the last answer; away, the delivery waits on
      // this same read.
      void refreshPreferences();
    }

    const delayMs = resolveClaimDelayMs();
    if (delayMs === 0) {
      void deliver(alert);
      return;
    }
    const timer = window.setTimeout(() => {
      claimTimersRef.current.delete(timer);
      void deliver(alert);
    }, delayMs);
    claimTimersRef.current.add(timer);
  }, [deliver, refreshPreferences]);

  return { announce, isBrowserPushSubscribed };
}
