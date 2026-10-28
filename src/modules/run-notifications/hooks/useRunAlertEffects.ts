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

/** How long the push subscription check is trusted before it runs again. */
const PUSH_SUBSCRIPTION_MAX_AGE_MS = 60_000;

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

/**
 * The sound and the system notification of finished-run alerts. On mount it reads the server's notification
 * preferences and mirrors `channels.sound` into the local sound switch (which used to stay on until the user opened
 * Settings on that device), follows the desktop app's notification switch, checks for a push subscription, and
 * unlocks the chime on every pointerdown and keydown. `announce` lets the tab the user is on claim at once and the
 * others a little later; the claimer chimes, unless the desktop app or push will make the sound, and posts a system
 * notification when the user is away and nothing else will. Used by RunNotifications.
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
  const isReadingPreferencesRef = useRef(false);

  const refreshPreferences = useCallback(async () => {
    if (isReadingPreferencesRef.current) {
      return;
    }
    isReadingPreferencesRef.current = true;
    try {
      const response = await api.settings.notificationPreferences();
      if (!response.ok) {
        return;
      }
      const parsed = parseDeliveryPreferences(await response.json());
      if (!parsed || disposedRef.current) {
        return;
      }
      preferencesRef.current = { delivery: parsed.delivery, readAt: Date.now() };
      if (typeof parsed.sound === 'boolean') {
        setNotificationSoundEnabled(parsed.sound);
      }
    } catch {
      // The last answer stays in use; the next announce asks again.
    } finally {
      isReadingPreferencesRef.current = false;
    }
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

  // The push subscription check as last made and when, so deliveries within a minute of it do not repeat it.
  const pushSubscriptionRef = useRef<{ subscribed: boolean; readAt: number } | null>(null);

  const readPushSubscribed = useCallback(async (): Promise<boolean> => {
    const cached = pushSubscriptionRef.current;
    if (cached && Date.now() - cached.readAt < PUSH_SUBSCRIPTION_MAX_AGE_MS) {
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
    void readPushSubscribed();
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

    const delivery = preferencesRef.current?.delivery ?? null;
    const eventEnabled = delivery?.events[alert.outcome === 'failed' ? 'error' : 'stop'] === true;
    const desktopBridge = readDesktopNotificationsBridge();
    // The desktop app's native notification makes its own sound.
    const desktopWillAlert = desktopBridge !== null
      && desktopNotificationsEnabledRef.current
      && delivery?.desktop === true
      && eventEnabled;
    // Push delivers the system notification, with its sound unless a CloudCLI window has focus (sw.js).
    const pushWillAlert = delivery?.webPush === true && eventEnabled && (await readPushSubscribed());

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
      silent: chimed,
    });
  }, [readPushSubscribed]);

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
      // In the background: this alert goes by the last answer.
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
