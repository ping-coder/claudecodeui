import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import {
  claimRunAlert,
  markRunAlertsSeen,
  mergeSystemNotificationCta,
  readSeenRunAlertKeys,
  readSystemNotificationCta,
  showRunAlertSystemNotification,
  subscribeToSeenRunAlerts,
  subscribeToSystemNotificationCta,
  writeSystemNotificationCta,
} from '@/modules/run-notifications/utils/runAlertCoordination';

/**
 * Every tab of the browser hears every run end, so the tabs settle in localStorage which one chimes and
 * notifies (the first to claim the alert key), keep a burst of completions to one chime, and tell each other
 * which alerts the user has seen. A Web Lock guards the claim where the browser has one; the outcome must be
 * the same without it. The system notification goes through the service worker registration, never through
 * `serviceWorker.ready`, which hangs while no worker is active.
 */

const CLAIMS_STORAGE_KEY = 'cloudcli:run-alerts:claims';
const SEEN_STORAGE_KEY = 'cloudcli:run-alerts:seen';
const SYSTEM_CTA_STORAGE_KEY = 'cloudcli:run-alerts:system-cta';
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const T0 = new Date('2026-10-27T10:00:00.000Z').getTime();

/** Defines a property jsdom's navigator lacks (locks, serviceWorker) for one test. */
const defineNavigatorProperty = (name: string, value: unknown) => {
  Object.defineProperty(navigator, name, { configurable: true, value });
};

/** A Web Locks stand-in: one exclusive lock per name, granted in request order. Records each lock name asked for. */
const installLocks = () => {
  const requestedNames: string[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  defineNavigatorProperty('locks', {
    request: (name: string, callback: () => unknown) => {
      requestedNames.push(name);
      const granted = queue.then(() => callback());
      queue = granted.catch(() => undefined);
      return granted;
    },
  });
  return requestedNames;
};

/** Claims in order, moving the clock between claims: [ms after T0, alert key]. */
const claimInSequence = async (steps: Array<[number, string]>) => {
  const results: Array<{ claimed: boolean; chime: boolean }> = [];
  for (const [atMs, alertKey] of steps) {
    vi.setSystemTime(T0 + atMs);
    results.push(await claimRunAlert(alertKey));
  }
  return results;
};

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  delete (navigator as unknown as Record<string, unknown>).locks;
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
});

test('only the first claim of an alert key wins, also when the claims come at once', async () => {
  const results = await Promise.all([
    claimRunAlert('session-a:1000:turn'),
    claimRunAlert('session-a:1000:turn'),
    claimRunAlert('session-a:1000:turn'),
  ]);

  assert.deepEqual(results.map((result) => result.claimed), [true, false, false]);
  // Another run's end is a claim of its own.
  assert.equal((await claimRunAlert('session-a:2000:turn')).claimed, true);
});

test('claims come out the same with a Web Lock as without one, and completions within 1.5 s share a chime', async () => {
  const steps: Array<[number, string]> = [
    [0, 'session-a:1000:turn'],
    [0, 'session-a:1000:turn'],
    [500, 'session-b:1000:turn'],
    [1499, 'session-c:1000:turn'],
    [1500, 'session-d:1000:turn'],
    [2000, 'session-a:1000:background'],
  ];
  const expected = [
    { claimed: true, chime: true },
    { claimed: false, chime: false },
    { claimed: true, chime: false },
    { claimed: true, chime: false },
    { claimed: true, chime: true },
    { claimed: true, chime: false },
  ];

  assert.deepEqual(await claimInSequence(steps), expected);

  localStorage.clear();
  const requestedLockNames = installLocks();
  assert.deepEqual(await claimInSequence(steps), expected);
  assert.equal(requestedLockNames.length, steps.length);
  assert.equal(requestedLockNames.every((name) => name === 'cloudcli:run-alerts'), true);
});

test('claimed and seen keys are dropped after 15 minutes', async () => {
  localStorage.setItem(CLAIMS_STORAGE_KEY, JSON.stringify({
    keys: { 'old:1:turn': T0 - FIFTEEN_MINUTES_MS, 'fresh:1:turn': T0 - 1000 },
    lastChimeAt: T0 - FIFTEEN_MINUTES_MS,
  }));

  assert.equal((await claimRunAlert('fresh:1:turn')).claimed, false);
  assert.equal((await claimRunAlert('new:1:turn')).claimed, true);
  const stored = JSON.parse(localStorage.getItem(CLAIMS_STORAGE_KEY) ?? '{}') as { keys: Record<string, number> };
  assert.deepEqual(Object.keys(stored.keys).sort(), ['fresh:1:turn', 'new:1:turn']);
  // Forgotten, so it could be claimed again (alert keys carry the run's start, so this never happens for real).
  assert.equal((await claimRunAlert('old:1:turn')).claimed, true);

  markRunAlertsSeen(['seen:1:turn']);
  vi.setSystemTime(T0 + FIFTEEN_MINUTES_MS - 1);
  assert.deepEqual([...readSeenRunAlertKeys()], ['seen:1:turn']);
  vi.setSystemTime(T0 + FIFTEEN_MINUTES_MS);
  assert.deepEqual([...readSeenRunAlertKeys()], []);
});

test('a localStorage that throws leaves the alert to this tab', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  });

  assert.deepEqual(await claimRunAlert('session-a:1000:turn'), { claimed: true, chime: true });
  assert.deepEqual(await claimRunAlert('session-a:1000:turn'), { claimed: true, chime: true });
  // Neither does marking or reading seen keys throw.
  markRunAlertsSeen(['session-a:1000:turn']);
  assert.equal(readSeenRunAlertKeys().size, 0);
});

test('keys marked seen here reach the other tabs through the storage event', () => {
  const heard: string[][] = [];
  const unsubscribe = subscribeToSeenRunAlerts((alertKeys) => heard.push(alertKeys));

  const before = localStorage.getItem(SEEN_STORAGE_KEY);
  markRunAlertsSeen(['session-a:1000:turn']);
  const after = localStorage.getItem(SEEN_STORAGE_KEY);
  assert.deepEqual([...readSeenRunAlertKeys()], ['session-a:1000:turn']);

  // The browser fires `storage` in the other tabs only; this is the event they get.
  window.dispatchEvent(new StorageEvent('storage', { key: SEEN_STORAGE_KEY, oldValue: before, newValue: after }));
  window.dispatchEvent(new StorageEvent('storage', { key: CLAIMS_STORAGE_KEY, oldValue: null, newValue: '{}' }));
  assert.deepEqual(heard, [['session-a:1000:turn']]);

  // Marking a key again, even later, changes nothing, so no tab is woken for it.
  vi.setSystemTime(T0 + 1000);
  markRunAlertsSeen(['session-a:1000:turn']);
  assert.equal(localStorage.getItem(SEEN_STORAGE_KEY), after);

  unsubscribe();
  window.dispatchEvent(new StorageEvent('storage', { key: SEEN_STORAGE_KEY, oldValue: before, newValue: after }));
  assert.equal(heard.length, 1);
});

test('the system-notification prompt\'s record only grows, and the other tabs hear every save', () => {
  const heard: unknown[] = [];
  const unsubscribe = subscribeToSystemNotificationCta((record) => heard.push(record));

  writeSystemNotificationCta({ shown: 2, done: true });
  // A tab that read the record before that save: its lower count and missing answer do not win.
  writeSystemNotificationCta({ shown: 1, done: false });
  assert.deepEqual(readSystemNotificationCta(), { shown: 2, done: true });
  writeSystemNotificationCta({ shown: 3, done: false });
  assert.deepEqual(readSystemNotificationCta(), { shown: 3, done: true });

  // The browser fires `storage` in the other tabs only; this is the event they get.
  window.dispatchEvent(new StorageEvent('storage', { key: SYSTEM_CTA_STORAGE_KEY, newValue: localStorage.getItem(SYSTEM_CTA_STORAGE_KEY) }));
  window.dispatchEvent(new StorageEvent('storage', { key: SEEN_STORAGE_KEY, newValue: '{}' }));
  assert.deepEqual(heard, [{ shown: 3, done: true }]);
  unsubscribe();
  window.dispatchEvent(new StorageEvent('storage', { key: SYSTEM_CTA_STORAGE_KEY, newValue: '{"shown":4,"done":true}' }));
  assert.equal(heard.length, 1);

  // A copy that adds nothing leaves the record as it is, the same object.
  const current = { shown: 3, done: true };
  assert.equal(mergeSystemNotificationCta(current, { shown: 1, done: false }) === current, true);
  assert.deepEqual(mergeSystemNotificationCta({ shown: 1, done: false }, { shown: 0, done: true }), { shown: 1, done: true });
});

test('the system notification goes through getRegistration, never serviceWorker.ready', async () => {
  const posted: Array<{ title: string; options: unknown }> = [];
  let isReadyRead = false;
  let registration: unknown = {
    showNotification: async (title: string, options: unknown) => {
      posted.push({ title, options });
    },
  };
  defineNavigatorProperty('serviceWorker', {
    getRegistration: async () => registration,
    get ready() {
      isReadyRead = true;
      return new Promise(() => undefined);
    },
  });

  const notification = {
    title: 'Fix login bug',
    body: 'Done · Alpha',
    tag: 'claude:session-a:run.stopped',
    data: { sessionId: 'session-a', provider: 'claude' as const, code: 'run.stopped' },
    silent: true,
  };
  assert.equal(await showRunAlertSystemNotification(notification), 'posted');
  assert.deepEqual(posted, [{
    title: 'Fix login bug',
    options: {
      body: 'Done · Alpha',
      tag: 'claude:session-a:run.stopped',
      data: { sessionId: 'session-a', provider: 'claude', code: 'run.stopped' },
      icon: '/logo-256.png',
      badge: '/logo-128.png',
      silent: true,
      // Silent drops the sound, never the banner of a notification that replaces the session's last one.
      renotify: true,
    },
  }]);

  registration = {
    showNotification: async () => {
      throw new TypeError('No notification permission has been granted for this origin.');
    },
  };
  assert.equal(await showRunAlertSystemNotification(notification), 'failed');

  registration = undefined;
  assert.equal(await showRunAlertSystemNotification({ ...notification, silent: false }), 'noServiceWorker');
  assert.equal(posted.length, 1);
  assert.equal(isReadyRead, false);

  // No service worker at all (plain http).
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  assert.equal(await showRunAlertSystemNotification(notification), 'noServiceWorker');
});

test('a system notification from a right-to-left interface goes out without bidi isolates', async () => {
  const posted: Array<{ title: string; body: unknown }> = [];
  defineNavigatorProperty('serviceWorker', {
    getRegistration: async () => ({
      showNotification: async (title: string, options: { body?: unknown }) => {
        posted.push({ title, body: options.body });
      },
    }),
  });

  // What the Hebrew interface hands over: a fallback label in LRI…PDI, values in FSI…PDI.
  await showRunAlertSystemNotification({
    title: '\u2066Stage\u2069 · Fix login bug',
    body: '\u2068הושלם\u2069 · \u2068demo-app\u2069',
    tag: 'claude:session-a:run.stopped',
    data: { sessionId: 'session-a', provider: 'claude', code: 'run.stopped' },
    silent: true,
  });
  assert.deepEqual(posted, [{ title: 'Stage · Fix login bug', body: 'הושלם · demo-app' }]);
});

