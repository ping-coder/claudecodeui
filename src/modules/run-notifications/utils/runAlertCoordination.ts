import type { TFunction } from 'i18next';

import type { LLMProvider, RunAlertOutcome } from '@/shared/types';

/**
 * How the tabs of one browser share the work of a finished run's alert, and the page APIs that work needs.
 * Every tab hears every `run_ended`, so the chime and the system notification go to the one tab that claims the
 * alert first, and an alert the user has seen in one tab is dropped by the others. All of it lives in this
 * origin's localStorage: tabs of another origin (localhost and 127.0.0.1 are two), another browser or another
 * device do not take part. Private to run-notifications.
 */

/** localStorage key of the claims record: `{ keys: Record<alert key, claimed at>, lastChimeAt }`. */
const RUN_ALERT_CLAIMS_STORAGE_KEY = 'cloudcli:run-alerts:claims';

/** localStorage key of the alerts some tab has marked seen: `Record<alert key, seen at>`. */
const RUN_ALERT_SEEN_STORAGE_KEY = 'cloudcli:run-alerts:seen';

/** localStorage key of the banner's system-notification prompt record: `{ shown, done }`. */
const RUN_ALERT_SYSTEM_CTA_STORAGE_KEY = 'cloudcli:run-alerts:system-cta';

/** Web Locks name the claim's read-modify-write runs under, so two tabs claiming at once cannot both win. */
const RUN_ALERT_LOCK_NAME = 'cloudcli:run-alerts';

/** How long a claimed or seen key is kept: longer than any tab's claim delay, and than the server keeps a run's end for catch-up (10 minutes). */
const RUN_ALERT_KEY_RETENTION_MS = 15 * 60 * 1000;

/** Completions closer together than this share one chime, whichever tabs claim them. */
const RUN_ALERT_CHIME_GAP_MS = 1500;

/** What a claim tells the tab that asked: whether it announces the alert (chime, system notification), and whether it may chime. */
type RunAlertClaim = {
  claimed: boolean;
  chime: boolean;
};

/** How often the banner's "Turn on system notifications" prompt has appeared, and whether the user used or dismissed it. */
type SystemNotificationCtaRecord = {
  shown: number;
  done: boolean;
};

/** The desktop app's notifications bridge, as much of it as run-notifications reads: its state, and updates to it. */
type DesktopNotificationsBridge = {
  /** Resolves to the app state; `desktopNotifications.enabled` says whether its native notifications are on. */
  getState: () => Promise<unknown>;
  /** Calls the listener with each new app state; returns the unsubscribe function. */
  onStateUpdated?: (listener: (state: unknown) => void) => (() => void) | void;
};

/** Whether the user is on this tab: it is visible and its window has focus. */
export const isPageActive = (): boolean => document.visibilityState === 'visible' && document.hasFocus();

/**
 * Reads a JSON value from localStorage; null when the key is absent or holds no valid JSON. Throws when storage
 * itself cannot be read (blocked by the browser), which each caller handles its own way.
 */
const readStoredJson = (storageKey: string): unknown => {
  const raw = localStorage.getItem(storageKey);
  if (raw === null) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** The entries of a stored `Record<key, timestamp>` younger than the retention; anything not shaped like one reads as empty. */
const keepRecentKeys = (value: unknown, now: number): Record<string, number> => {
  // No prototype, so a stored key such as "__proto__" stays a plain entry.
  const recent = Object.create(null) as Record<string, number>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return recent;
  }

  for (const [key, storedAt] of Object.entries(value)) {
    if (typeof storedAt === 'number' && Number.isFinite(storedAt) && now - storedAt < RUN_ALERT_KEY_RETENTION_MS) {
      recent[key] = storedAt;
    }
  }
  return recent;
};

/** The claim's read-modify-write, run inside the lock where there is one. A storage this tab cannot use leaves the alert to it. */
const claimRunAlertInStorage = (alertKey: string): RunAlertClaim => {
  try {
    const now = Date.now();
    const stored = readStoredJson(RUN_ALERT_CLAIMS_STORAGE_KEY);
    const record = stored && typeof stored === 'object' ? (stored as { keys?: unknown; lastChimeAt?: unknown }) : {};
    const keys = keepRecentKeys(record.keys, now);
    if (alertKey in keys) {
      return { claimed: false, chime: false };
    }

    const lastChimeAt = typeof record.lastChimeAt === 'number' && Number.isFinite(record.lastChimeAt) ? record.lastChimeAt : 0;
    const chime = now - lastChimeAt >= RUN_ALERT_CHIME_GAP_MS;
    keys[alertKey] = now;
    localStorage.setItem(
      RUN_ALERT_CLAIMS_STORAGE_KEY,
      JSON.stringify({ keys, lastChimeAt: chime ? now : lastChimeAt }),
    );
    return { claimed: true, chime };
  } catch {
    return { claimed: true, chime: true };
  }
};

/**
 * Claims a finished run's alert for this tab. `claimed` is true for the first tab of the browser to ask about the
 * key (it chimes and posts the system notification), false for every later one; `chime` is true when no claim
 * chimed in the last 1.5 s, so a burst of completions makes one sound. With Web Locks the read-modify-write runs
 * under an exclusive lock; without them (plain http on a LAN is no secure context) it runs bare, where two
 * background tabs claiming in the same millisecond could both win. When localStorage cannot be used every tab
 * handles its own alerts.
 */
export const claimRunAlert = async (alertKey: string): Promise<RunAlertClaim> => {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) {
    return claimRunAlertInStorage(alertKey);
  }

  try {
    return await locks.request(RUN_ALERT_LOCK_NAME, () => claimRunAlertInStorage(alertKey));
  } catch {
    // The lock itself could not be taken (an opaque origin, say); the bare read-modify-write still works.
    return claimRunAlertInStorage(alertKey);
  }
};

/**
 * Marks alerts seen in this browser: the other tabs hear it through the `storage` event and drop those alerts
 * from their title and banners (shown ones too), and a reconnect's catch-up skips them. Keys already marked
 * are left alone, so marking them again wakes no tab. Nothing happens when localStorage cannot be used.
 */
export const markRunAlertsSeen = (alertKeys: readonly string[]): void => {
  if (alertKeys.length === 0) {
    return;
  }

  try {
    const now = Date.now();
    const seen = keepRecentKeys(readStoredJson(RUN_ALERT_SEEN_STORAGE_KEY), now);
    let hasNewKey = false;
    for (const alertKey of alertKeys) {
      if (!(alertKey in seen)) {
        seen[alertKey] = now;
        hasNewKey = true;
      }
    }
    if (hasNewKey) {
      localStorage.setItem(RUN_ALERT_SEEN_STORAGE_KEY, JSON.stringify(seen));
    }
  } catch {
    // The other tabs simply keep their copies of these alerts.
  }
};

/** The alert keys some tab of this browser marked seen in the last 15 minutes; empty when localStorage cannot be read. */
export const readSeenRunAlertKeys = (): ReadonlySet<string> => {
  try {
    return new Set(Object.keys(keepRecentKeys(readStoredJson(RUN_ALERT_SEEN_STORAGE_KEY), Date.now())));
  } catch {
    return new Set();
  }
};

/**
 * Calls `listener` with every key in the seen record whenever another tab writes it (the `storage` event never
 * fires in the tab that wrote). Removing alerts by these keys is idempotent, so the listener gets the whole
 * record rather than only the keys just added. Returns the unsubscribe function.
 */
export const subscribeToSeenRunAlerts = (listener: (alertKeys: string[]) => void): (() => void) => {
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== RUN_ALERT_SEEN_STORAGE_KEY || !event.newValue) {
      return;
    }

    let seen: unknown;
    try {
      seen = JSON.parse(event.newValue);
    } catch {
      return;
    }
    const alertKeys = Object.keys(keepRecentKeys(seen, Date.now()));
    if (alertKeys.length > 0) {
      listener(alertKeys);
    }
  };

  window.addEventListener('storage', handleStorage);
  return () => window.removeEventListener('storage', handleStorage);
};

/** Reads a stored system-notification prompt record; a fresh one (never shown, not done) for anything else. */
const toSystemNotificationCtaRecord = (value: unknown): SystemNotificationCtaRecord => {
  if (!value || typeof value !== 'object') {
    return { shown: 0, done: false };
  }
  const { shown, done } = value as { shown?: unknown; done?: unknown };
  return {
    shown: typeof shown === 'number' && Number.isFinite(shown) ? shown : 0,
    done: done === true,
  };
};

/**
 * Combines two copies of the prompt's record: the higher count, and done once either says so. Returns `current`
 * itself when `other` adds nothing, so a state holding it is left alone.
 */
export const mergeSystemNotificationCta = (
  current: SystemNotificationCtaRecord,
  other: SystemNotificationCtaRecord,
): SystemNotificationCtaRecord => (
  other.shown <= current.shown && (current.done || !other.done)
    ? current
    : { shown: Math.max(current.shown, other.shown), done: current.done || other.done }
);

/** The system-notification prompt's record; a fresh one (never shown, not done) when absent or unreadable. */
export const readSystemNotificationCta = (): SystemNotificationCtaRecord => {
  try {
    return toSystemNotificationCtaRecord(readStoredJson(RUN_ALERT_SYSTEM_CTA_STORAGE_KEY));
  } catch {
    // Unreadable storage: the prompt starts over for this page load.
    return { shown: 0, done: false };
  }
};

/**
 * Saves the system-notification prompt's record, merged with the stored one: a tab that read it before another
 * tab counted or answered the prompt never lowers the count or takes the answer back. A storage that cannot be
 * written keeps the record for this page load only.
 */
export const writeSystemNotificationCta = (record: SystemNotificationCtaRecord): void => {
  try {
    const stored = toSystemNotificationCtaRecord(readStoredJson(RUN_ALERT_SYSTEM_CTA_STORAGE_KEY));
    localStorage.setItem(RUN_ALERT_SYSTEM_CTA_STORAGE_KEY, JSON.stringify(mergeSystemNotificationCta(stored, record)));
  } catch {
    // Nothing else to do: the next page load offers the prompt again.
  }
};

/**
 * Calls `listener` with the prompt's record whenever another tab saves it (the `storage` event never fires in
 * the tab that wrote), so an answer given in one tab, or the count reached there, holds in every tab at once.
 * Returns the unsubscribe function.
 */
export const subscribeToSystemNotificationCta = (listener: (record: SystemNotificationCtaRecord) => void): (() => void) => {
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== RUN_ALERT_SYSTEM_CTA_STORAGE_KEY || !event.newValue) {
      return;
    }

    let stored: unknown;
    try {
      stored = JSON.parse(event.newValue);
    } catch {
      return;
    }
    listener(toSystemNotificationCtaRecord(stored));
  };

  window.addEventListener('storage', handleStorage);
  return () => window.removeEventListener('storage', handleStorage);
};

/**
 * Whether this browser holds a Web Push subscription with this origin's service worker, in which case push
 * delivers the finished run's system notification and the page posts none. False without a service worker
 * (plain http), without a registration, and on any error.
 */
export const readBrowserPushSubscribed = async (): Promise<boolean> => {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    const subscription = await registration?.pushManager?.getSubscription();
    return Boolean(subscription);
  } catch {
    return false;
  }
};

/**
 * Posts a finished run's system notification through this origin's service worker registration (Android Chrome
 * and iOS home-screen apps allow no other way), so a click takes the existing notificationclick path that opens
 * the session. It never waits on `serviceWorker.ready`, which stays pending while no worker is active. Resolves to
 * whether it was posted: false without a registration, or when posting fails.
 */
export const showRunAlertSystemNotification = async ({
  title,
  body,
  tag,
  data,
  silent,
}: {
  title: string;
  body: string;
  /** `${provider}:${sessionId}:${code}`, the tag the server's push for the same run uses. */
  tag: string;
  data: { sessionId: string; provider: LLMProvider; code: string };
  /** True once this alert's burst has made its sound: the page chimed, or another claim within 1.5 s took the chime. */
  silent: boolean;
}): Promise<boolean> => {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (!registration) {
      return false;
    }

    // `renotify` is missing from TypeScript's NotificationOptions, though browsers read it.
    const options: NotificationOptions & { renotify: boolean } = {
      body,
      tag,
      data,
      icon: '/logo-256.png',
      badge: '/logo-128.png',
      silent,
      renotify: !silent,
    };
    await registration.showNotification(title, options);
    return true;
  } catch {
    return false;
  }
};

/**
 * The desktop app's notifications bridge (its preload script exposes it on window); null in a browser. Its
 * presence is how run-notifications tells the desktop app, which shows native notifications of its own, from a
 * browser tab.
 */
export const readDesktopNotificationsBridge = (): DesktopNotificationsBridge | null => {
  const bridge = (window as Window & { cloudcliDesktopNotifications?: unknown }).cloudcliDesktopNotifications;
  return bridge && typeof bridge === 'object' ? (bridge as DesktopNotificationsBridge) : null;
};

/** A finished run's result in words ("Done", "Failed"), the same in the banners and the system notification. */
export const describeRunAlertOutcome = (outcome: RunAlertOutcome, t: TFunction): string => {
  switch (outcome) {
    case 'replied':
      return t('runNotifications.outcome.replied', { defaultValue: 'Replied, background work still running' });
    case 'failed':
      return t('runNotifications.outcome.failed', { defaultValue: 'Failed' });
    case 'backgroundDone':
      return t('runNotifications.outcome.backgroundDone', { defaultValue: 'Background work finished' });
    default:
      return t('runNotifications.outcome.done', { defaultValue: 'Done' });
  }
};
