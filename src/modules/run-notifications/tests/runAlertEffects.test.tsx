import assert from 'node:assert/strict';

import { act, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useRunAlertEffects } from '@/modules/run-notifications/hooks/useRunAlertEffects';
import type { RunAlert, RunAlertOutcome } from '@/shared/types';
import type * as SharedUtils from '@/shared/utils';

/**
 * One finished run, one chime and at most one system notification in the whole browser: the tab the user is on
 * claims the alert at once, the others a little later, and only the claimer acts. A burst of completions makes
 * one sound: one chime, and silent notifications after it. The page stays quiet when the sound is off, for a
 * catch-up alert, when the desktop app notifies natively, and when push will deliver while the user is away. The
 * page posts a system notification only when the user is away, the permission is granted, their switch is on, and
 * neither push nor the desktop app will. Push counts only when the server holds this browser's subscription: one
 * the server lacks leaves the alert to the page and is replaced in the background while the Web Push channel is
 * on. Away from the page, the claimer first reads the preferences, and the server's word on the subscription, again
 * unless they are a few seconds old, and alerts on its own when a read is slow or fails; on the page the chime waits
 * on neither. Every decision is reported to the server log.
 */

const sound = vi.hoisted(() => ({
  chimes: 0,
  primes: 0,
  mirroredSettings: [] as boolean[],
  // Runs as a chime plays, for a test where the user leaves the page meanwhile.
  onChime: null as null | (() => void),
}));
const server = vi.hoisted(() => ({
  preferences: null as unknown,
  preferenceReads: 0,
  responseDelayMs: 0,
  // The push subscriptions the server holds, by endpoint, and how it answers about them.
  registeredEndpoints: new Set<string>(),
  statusReads: 0,
  statusDelayMs: 0,
  resyncOk: true,
  resyncs: [] as unknown[],
  // What the page sent to the server log.
  reports: [] as Array<Record<string, unknown>>,
}));
const deployment = vi.hoisted(() => ({ environment: null as string | null }));

vi.mock('@/shared/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedUtils>();
  return {
    ...actual,
    // Chimes unless the sound is off, as the real one does; `force` would chime anyway.
    playChatCompletionSound: async (options?: { force?: boolean }) => {
      if (!options?.force && !actual.isNotificationSoundEnabled()) {
        return false;
      }
      sound.chimes += 1;
      sound.onChime?.();
      return true;
    },
    primeNotificationSound: () => {
      sound.primes += 1;
    },
    setNotificationSoundEnabled: (enabled: boolean) => {
      sound.mirroredSettings.push(enabled);
      actual.setNotificationSoundEnabled(enabled);
    },
  };
});

vi.mock('@/shared/api', () => ({
  api: {
    settings: {
      notificationPreferences: async () => {
        server.preferenceReads += 1;
        // What the server holds when the request reaches it, answered after the delay a test sets.
        const { preferences } = server;
        if (server.responseDelayMs > 0) {
          await new Promise((resolve) => {
            setTimeout(resolve, server.responseDelayMs);
          });
        }
        return preferences
          ? { ok: true, json: async () => ({ success: true, preferences }) }
          : { ok: false, json: async () => ({}) };
      },
      push: {
        vapidPublicKey: async () => ({ ok: true, json: async () => ({ publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' }) }),
        status: async (endpoint: string) => {
          server.statusReads += 1;
          if (server.statusDelayMs > 0) {
            await new Promise((resolve) => {
              setTimeout(resolve, server.statusDelayMs);
            });
          }
          return { ok: true, json: async () => ({ success: true, registered: server.registeredEndpoints.has(endpoint) }) };
        },
        resync: async (subscription: { endpoint: string }) => {
          server.resyncs.push(subscription);
          if (server.resyncOk) {
            server.registeredEndpoints.add(subscription.endpoint);
          }
          return { ok: server.resyncOk, json: async () => ({}) };
        },
      },
    },
    system: {
      reportClientDiagnostics: async (report: Record<string, unknown>) => {
        server.reports.push(report);
        return { ok: true };
      },
    },
  },
}));

vi.mock('@/shared/hooks/useDeploymentEnvironment', () => ({
  useDeploymentEnvironment: () => deployment.environment,
}));

const CLAIMS_STORAGE_KEY = 'cloudcli:run-alerts:claims';

/** The server's notification preferences: everything the page could defer to switched off unless overridden. */
const preferencesWith = ({
  webPush = false,
  desktop = false,
  sound: soundOn = true,
  stop = true,
  error = true,
}: { webPush?: boolean; desktop?: boolean; sound?: boolean; stop?: boolean; error?: boolean } = {}) => ({
  channels: { inApp: false, webPush, desktop, sound: soundOn },
  events: { actionRequired: true, stop, error },
});

// The page and browser state the hook reads; jsdom has none of it.
const pageState = { visible: true, focused: true };
// What Math.random returns: where in the 300-500 ms window a background tab claims.
const randomSpread = { value: 0 };
const serviceWorker = {
  subscription: null as unknown,
  // How many subscriptions pushManager.subscribe() has made, which numbers their endpoints.
  subscriptionsMade: 0,
  notifications: [] as Array<{ title: string; options: Record<string, unknown> }>,
  messageListeners: new Set<(event: MessageEvent) => void>(),
};

const PUSH_ENDPOINT = 'https://push.example/abc';

/** A push subscription with `endpoint`; unsubscribing leaves the browser without one. */
const subscriptionWith = (endpoint: string) => ({
  endpoint,
  toJSON: () => ({ endpoint, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } }),
  unsubscribe: async () => {
    serviceWorker.subscription = null;
    return true;
  },
});

/** This browser subscribed to push, with `registered` saying whether the server holds the subscription too. */
const subscribeBrowser = ({ registered = true, endpoint = PUSH_ENDPOINT }: { registered?: boolean; endpoint?: string } = {}) => {
  serviceWorker.subscription = subscriptionWith(endpoint);
  if (registered) {
    server.registeredEndpoints.add(endpoint);
  }
};

/** The subscriptions the page saved on the server again, as `endpoint` and the `previousEndpoint` each replaced. */
const resyncedEndpoints = () => (server.resyncs as Array<{ endpoint: string; previousEndpoint?: string }>)
  .map(({ endpoint, previousEndpoint }) => ({ endpoint, previousEndpoint }));

/** The reports sent to the server log, as `outcome:reason`. */
const reportedDecisions = () => server.reports.map((report) => `${report.outcome}:${report.reason}`);

const alertOf = (sessionId: string, overrides: Partial<RunAlert> = {}): RunAlert => {
  const outcome: RunAlertOutcome = overrides.outcome ?? 'done';
  return {
    key: `${sessionId}:1000:${outcome === 'backgroundDone' ? 'background' : 'turn'}`,
    sessionId,
    outcome,
    title: `Title ${sessionId}`,
    projectName: null,
    provider: 'claude',
    receivedAt: 1000,
    isCatchUp: false,
    ...overrides,
  };
};

const renderEffects = async (systemNotificationsEnabled = true) => {
  const view = renderHook(
    (props: { systemNotificationsEnabled: boolean }) => useRunAlertEffects(props),
    { initialProps: { systemNotificationsEnabled } },
  );
  // The preference read and the push check on mount.
  await flush();
  return view;
};

/** Runs the timers due in the next `ms` and every promise they release. */
const flush = (ms = 0) => act(async () => {
  await vi.advanceTimersByTimeAsync(ms);
});

const announce = async (view: Awaited<ReturnType<typeof renderEffects>>, alert: RunAlert, waitMs = 1000) => {
  act(() => view.result.current.announce(alert));
  await flush(waitMs);
};

const readClaimedKeys = (): string[] =>
  Object.keys((JSON.parse(localStorage.getItem(CLAIMS_STORAGE_KEY) ?? '{}') as { keys?: object }).keys ?? {});

const setDesktopApp = (enabled: boolean) => {
  Object.defineProperty(window, 'cloudcliDesktopNotifications', {
    configurable: true,
    value: {
      getState: async () => ({ desktopNotifications: { enabled } }),
      onStateUpdated: () => () => undefined,
    },
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sound.chimes = 0;
  sound.primes = 0;
  sound.mirroredSettings.length = 0;
  sound.onChime = null;
  server.preferences = preferencesWith();
  server.preferenceReads = 0;
  server.responseDelayMs = 0;
  server.registeredEndpoints.clear();
  server.statusReads = 0;
  server.statusDelayMs = 0;
  server.resyncOk = true;
  server.resyncs.length = 0;
  server.reports.length = 0;
  deployment.environment = null;
  pageState.visible = true;
  pageState.focused = true;
  serviceWorker.subscription = null;
  serviceWorker.subscriptionsMade = 0;
  serviceWorker.notifications.length = 0;
  serviceWorker.messageListeners.clear();

  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (pageState.visible ? 'visible' : 'hidden'),
  });
  vi.spyOn(document, 'hasFocus').mockImplementation(() => pageState.focused);
  // A background tab claims after exactly 300 ms, unless a test moves the spread.
  randomSpread.value = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => randomSpread.value);
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistration: async () => ({
        pushManager: {
          getSubscription: async () => serviceWorker.subscription,
          // Hands back the subscription held, as browsers do when asked with its key; else makes a new one.
          subscribe: async () => {
            if (!serviceWorker.subscription) {
              serviceWorker.subscriptionsMade += 1;
              serviceWorker.subscription = subscriptionWith(`https://push.example/fresh-${serviceWorker.subscriptionsMade}`);
            }
            return serviceWorker.subscription;
          },
        },
        showNotification: async (title: string, options: Record<string, unknown>) => {
          serviceWorker.notifications.push({ title, options });
        },
      }),
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
        serviceWorker.messageListeners.add(listener);
      },
      removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
        serviceWorker.messageListeners.delete(listener);
      },
    },
  });
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: async () => 'granted' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const [target, name] of [
    [document, 'visibilityState'],
    [navigator, 'serviceWorker'],
    [navigator, 'userActivation'],
    [window, 'cloudcliDesktopNotifications'],
  ] as const) {
    delete (target as unknown as Record<string, unknown>)[name];
  }
});

test('the tab the user is on claims at once, another after 300-500 ms, a never-used one after 800 ms', async () => {
  const view = await renderEffects();

  act(() => view.result.current.announce(alertOf('a')));
  await flush();
  assert.deepEqual(readClaimedKeys(), ['a:1000:turn']);

  // 300 + 0.99 x 200 = 498 ms.
  pageState.focused = false;
  randomSpread.value = 0.99;
  act(() => view.result.current.announce(alertOf('b')));
  await flush(497);
  assert.deepEqual(readClaimedKeys(), ['a:1000:turn']);
  await flush(1);
  assert.deepEqual(readClaimedKeys(), ['a:1000:turn', 'b:1000:turn']);

  randomSpread.value = 0;
  act(() => view.result.current.announce(alertOf('c')));
  await flush(299);
  assert.equal(readClaimedKeys().includes('c:1000:turn'), false);
  await flush(1);
  assert.equal(readClaimedKeys().includes('c:1000:turn'), true);

  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { hasBeenActive: false } });
  act(() => view.result.current.announce(alertOf('d')));
  await flush(799);
  assert.equal(readClaimedKeys().includes('d:1000:turn'), false);
  await flush(1);
  assert.equal(readClaimedKeys().includes('d:1000:turn'), true);
});

test('only the tab that claims the alert chimes', async () => {
  const view = await renderEffects();
  // Another tab got there first.
  localStorage.setItem(CLAIMS_STORAGE_KEY, JSON.stringify({ keys: { 'a:1000:turn': Date.now() }, lastChimeAt: 0 }));

  await announce(view, alertOf('a'));
  assert.equal(sound.chimes, 0);

  await announce(view, alertOf('b'));
  assert.equal(sound.chimes, 1);
});

test('completions within 1.5 s make one chime', async () => {
  const view = await renderEffects();

  await announce(view, alertOf('a'), 0);
  await announce(view, alertOf('b'), 0);
  await flush(1000);
  await announce(view, alertOf('c'), 0);
  assert.equal(sound.chimes, 1);

  await flush(500);
  await announce(view, alertOf('d'), 0);
  assert.equal(sound.chimes, 2);
});

test('no chime with the sound off, for a catch-up alert, or when the desktop app notifies natively', async () => {
  localStorage.setItem('notificationSoundEnabled', 'false');
  server.preferences = preferencesWith({ sound: false });
  let view = await renderEffects();
  await announce(view, alertOf('a'));
  assert.equal(sound.chimes, 0);
  view.unmount();

  server.preferences = preferencesWith();
  view = await renderEffects();
  await announce(view, alertOf('b', { isCatchUp: true }));
  assert.equal(sound.chimes, 0);
  assert.equal(readClaimedKeys().includes('b:1000:turn'), false);
  view.unmount();

  setDesktopApp(true);
  server.preferences = preferencesWith({ desktop: true });
  view = await renderEffects();
  await announce(view, alertOf('c'));
  assert.equal(sound.chimes, 0);
  view.unmount();

  // The desktop app with its notifications off leaves the chime to the page (past the 1.5 s of the last claim).
  setDesktopApp(false);
  view = await renderEffects();
  await flush(2000);
  await announce(view, alertOf('d'));
  assert.equal(sound.chimes, 1);
});

test('the desktop app\'s notification switch is followed as it changes', async () => {
  const desktop = { listener: null as ((state: unknown) => void) | null };
  Object.defineProperty(window, 'cloudcliDesktopNotifications', {
    configurable: true,
    value: {
      getState: async () => ({ desktopNotifications: { enabled: false } }),
      onStateUpdated: (listener: (state: unknown) => void) => {
        desktop.listener = listener;
        return () => {
          desktop.listener = null;
        };
      },
    },
  });
  server.preferences = preferencesWith({ desktop: true });
  const view = await renderEffects();

  await announce(view, alertOf('a'));
  assert.equal(sound.chimes, 1, 'its notifications off: the page chimes');

  act(() => desktop.listener?.({ desktopNotifications: { enabled: true } }));
  await flush(2000);
  await announce(view, alertOf('b'));
  assert.equal(sound.chimes, 1, 'turned on: its native notification sounds instead');

  view.unmount();
  assert.equal(desktop.listener === null, true, 'unsubscribed on unmount');
});

test('a desktop bridge that cannot report its state counts as the desktop app with its notifications off', async () => {
  Object.defineProperty(window, 'cloudcliDesktopNotifications', { configurable: true, value: {} });
  server.preferences = preferencesWith({ desktop: true });
  pageState.focused = false;
  const view = await renderEffects();

  await announce(view, alertOf('a'));
  // Nothing says its native notification will sound, so the page chimes; and the desktop app gets no page notification.
  assert.equal(sound.chimes, 1);
  assert.equal(serviceWorker.notifications.length, 0);
});

test('when push will deliver the alert the page chimes only while the user is on it', async () => {
  subscribeBrowser();
  server.preferences = preferencesWith({ webPush: true });
  const view = await renderEffects();

  pageState.focused = false;
  await announce(view, alertOf('a'));
  assert.equal(sound.chimes, 0);
  assert.equal(serviceWorker.notifications.length, 0, 'push posts it, not the page');

  // On the page, sw.js silences the push and the page chimes instead.
  pageState.focused = true;
  await flush(2000);
  await announce(view, alertOf('b'));
  assert.equal(sound.chimes, 1);

  // A failure goes by the error event: with it off, push stays quiet and the page chimes.
  server.preferences = preferencesWith({ webPush: true, error: false });
  view.unmount();
  const next = await renderEffects();
  pageState.focused = false;
  await flush(2000);
  await announce(next, alertOf('c', { outcome: 'failed' }));
  assert.equal(sound.chimes, 2);
});

test('the system notification needs the claim, the user away, the permission, the switch, and no push or desktop app', async () => {
  pageState.focused = false;
  let view = await renderEffects();
  await announce(view, alertOf('a', { projectName: 'Alpha' }));
  assert.deepEqual(serviceWorker.notifications, [{
    title: 'Title a',
    options: {
      body: 'Done · Alpha',
      tag: 'claude:a:run.stopped',
      data: { sessionId: 'a', provider: 'claude', code: 'run.stopped' },
      icon: '/logo-256.png',
      badge: '/logo-128.png',
      silent: true,
      renotify: true,
    },
  }]);
  serviceWorker.notifications.length = 0;

  // Not claimed here.
  localStorage.setItem(CLAIMS_STORAGE_KEY, JSON.stringify({ keys: { 'b:1000:turn': Date.now() }, lastChimeAt: 0 }));
  await announce(view, alertOf('b'));
  // The user is on the page.
  pageState.focused = true;
  await announce(view, alertOf('c'));
  pageState.focused = false;
  // No permission.
  vi.stubGlobal('Notification', { permission: 'default', requestPermission: async () => 'default' });
  await announce(view, alertOf('d'));
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: async () => 'granted' });
  // The switch is off.
  view.rerender({ systemNotificationsEnabled: false });
  await announce(view, alertOf('e'));
  view.unmount();
  assert.equal(serviceWorker.notifications.length, 0);

  // Push will deliver it.
  subscribeBrowser();
  server.preferences = preferencesWith({ webPush: true });
  view = await renderEffects();
  await announce(view, alertOf('f'));
  view.unmount();
  serviceWorker.subscription = null;
  server.preferences = preferencesWith();

  // The desktop app, its own notifications off or not.
  setDesktopApp(false);
  view = await renderEffects();
  await announce(view, alertOf('g'));
  assert.equal(serviceWorker.notifications.length, 0);
});

test('the system notification is silent once the burst has made its sound, and still renotifies', async () => {
  pageState.focused = false;
  const view = await renderEffects();

  await announce(view, alertOf('a'));
  // Within 1.5 s of that chime: no chime of its own, and none from the notification either.
  await announce(view, alertOf('b', { outcome: 'failed' }), 0);
  await flush(2000);
  // Past the 1.5 s with the sound off: no chime, so the notification sounds.
  server.preferences = preferencesWith({ sound: false });
  localStorage.setItem('notificationSoundEnabled', 'false');
  await announce(view, alertOf('c', { outcome: 'backgroundDone' }));

  assert.equal(sound.chimes, 1);
  assert.deepEqual(serviceWorker.notifications.map(({ options }) => ({
    tag: options.tag,
    silent: options.silent,
    renotify: options.renotify,
  })), [
    { tag: 'claude:a:run.stopped', silent: true, renotify: true },
    { tag: 'claude:b:run.failed', silent: true, renotify: true },
    { tag: 'claude:c:run.background_completed', silent: false, renotify: true },
  ]);
});

test('a completion claimed within 1.5 s of another tab\'s chime posts a silent notification', async () => {
  pageState.focused = false;
  const view = await renderEffects();
  // Another tab of this browser claimed a completion, with its chime, a moment ago.
  const now = Date.now();
  localStorage.setItem(CLAIMS_STORAGE_KEY, JSON.stringify({ keys: { 'x:1000:turn': now }, lastChimeAt: now }));

  await announce(view, alertOf('a'));
  assert.equal(sound.chimes, 0);
  assert.deepEqual(serviceWorker.notifications.map(({ options }) => ({
    silent: options.silent,
    renotify: options.renotify,
  })), [{ silent: true, renotify: true }]);
});

test('the title leads with the environment label and is cut to 80 characters', async () => {
  pageState.focused = false;
  deployment.environment = 'staging';
  const view = await renderEffects();

  await announce(view, alertOf('a', { title: 'x'.repeat(100), outcome: 'replied' }));

  const [notification] = serviceWorker.notifications;
  assert.equal(notification.title.startsWith('Stage · xxx'), true);
  assert.equal(Array.from(notification.title).length, 80);
  assert.equal(notification.title.endsWith('…'), true);
  assert.equal(notification.options.body, 'Replied, background work still running');
});

test('the server\'s sound setting is mirrored on mount; on the page, the preferences are read again after a minute', async () => {
  server.preferences = preferencesWith({ sound: false });
  const view = await renderEffects();

  assert.deepEqual(sound.mirroredSettings, [false]);
  assert.equal(localStorage.getItem('notificationSoundEnabled'), 'false');
  assert.equal(server.preferenceReads, 1);

  // The page is active here, so a delivery goes by the last answer for a minute.
  await flush(30_000);
  await announce(view, alertOf('a'));
  assert.equal(server.preferenceReads, 1);

  server.preferences = preferencesWith({ sound: true });
  await flush(30_000);
  await announce(view, alertOf('b'));
  assert.equal(server.preferenceReads, 2);
  assert.deepEqual(sound.mirroredSettings, [false, true]);
});

test('away from the page, a delivery reads the preferences again first once they are over 5 s old', async () => {
  subscribeBrowser();
  server.preferences = preferencesWith({ webPush: true });
  const view = await renderEffects();
  pageState.focused = false;

  // Read a moment ago: push will deliver this one, and the page stays quiet without asking again.
  await announce(view, alertOf('a'));
  assert.equal(server.preferenceReads, 1);
  assert.equal(sound.chimes, 0);

  // The user turns the "Run stopped" event off, in Settings here or on another device: no push comes for it now.
  server.preferences = preferencesWith({ webPush: true, stop: false });
  await flush(20_000);
  await announce(view, alertOf('b'));
  assert.equal(server.preferenceReads, 2);
  assert.equal(sound.chimes, 1);
  assert.deepEqual(serviceWorker.notifications.map(({ title }) => title), ['Title b']);

  // The next completion of the burst goes by that fresh read.
  await announce(view, alertOf('c'));
  assert.equal(server.preferenceReads, 2);
  assert.deepEqual(serviceWorker.notifications.map(({ title }) => title), ['Title b', 'Title c']);
});

test('away from the page, push turned on since the last read takes the alert over from the next completion', async () => {
  const view = await renderEffects();
  pageState.focused = false;

  // The user turns push on in Settings: this browser subscribes, and the server pushes the event from now on.
  subscribeBrowser();
  server.preferences = preferencesWith({ webPush: true });
  await flush(20_000);
  await announce(view, alertOf('a'));

  assert.equal(server.preferenceReads, 2);
  assert.equal(view.result.current.isBrowserPushSubscribed, true);
  assert.equal(sound.chimes, 0);
  assert.equal(serviceWorker.notifications.length, 0);
});

test('a read that takes over 1.5 s, or fails, leaves the alert to the page, whatever the last answer said', async () => {
  subscribeBrowser();
  server.preferences = preferencesWith({ webPush: true });
  const view = await renderEffects();
  pageState.focused = false;
  server.responseDelayMs = 5000;
  await flush(20_000);

  // Claimed after 300 ms; the read then gets 1.5 s.
  act(() => view.result.current.announce(alertOf('a')));
  await flush(1700);
  assert.equal(sound.chimes, 0);
  await flush(200);
  assert.equal(sound.chimes, 1);
  assert.deepEqual(serviceWorker.notifications.map(({ title }) => title), ['Title a']);

  // The slow read lands at last; well past it, a read the server turns down does the same.
  await flush(4000);
  server.responseDelayMs = 0;
  server.preferences = null;
  await flush(10_000);
  await announce(view, alertOf('b'));
  assert.equal(server.preferenceReads, 3);
  assert.equal(sound.chimes, 2);
  assert.deepEqual(serviceWorker.notifications.map(({ title }) => title), ['Title a', 'Title b']);
});

test('a delivery waits on the read announce has started rather than making its own', async () => {
  const view = await renderEffects();
  pageState.focused = false;
  // Push turned on since the read on mount, and the server slow to answer.
  subscribeBrowser();
  server.preferences = preferencesWith({ webPush: true });
  server.responseDelayMs = 1000;
  await flush(61_000);

  // Over a minute old: announce starts a read at once, and the claim 300 ms later waits for its answer.
  await announce(view, alertOf('a'), 2000);
  assert.equal(server.preferenceReads, 2);
  assert.equal(sound.chimes, 0);
  assert.equal(serviceWorker.notifications.length, 0);
});

test('every pointerdown and keydown primes the sound', async () => {
  const view = await renderEffects();

  fireEvent.pointerDown(document.body);
  fireEvent.pointerDown(document.body);
  fireEvent.keyDown(document.body, { key: 'a' });
  assert.equal(sound.primes, 3);

  view.unmount();
  fireEvent.pointerDown(document.body);
  assert.equal(sound.primes, 3);
});

test('a subscription the server lacks leaves the alert to the page, and is replaced quietly while push is wanted', async () => {
  // Push was turned on on another device, so the account's channel is on; this browser's subscription is one the
  // server never got, or dropped. It is replaced by a new one, which the server fails to save at first.
  subscribeBrowser({ registered: false });
  server.preferences = preferencesWith({ webPush: true });
  server.resyncOk = false;
  const view = await renderEffects();
  pageState.focused = false;

  assert.deepEqual(server.resyncs, [{
    endpoint: 'https://push.example/fresh-1',
    keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
    previousEndpoint: PUSH_ENDPOINT,
  }]);
  await announce(view, alertOf('a'));
  assert.equal(sound.chimes, 1);
  assert.deepEqual(serviceWorker.notifications.map(({ title }) => title), ['Title a']);
  assert.deepEqual(server.reports.map(({ outcome, reason, push, silent }) => ({ outcome, reason, push, silent })), [
    { outcome: 'posted', reason: 'away', push: 'unknown', silent: true },
  ]);
  // Tried once per page load, the new subscription included: the next alerts neither ask the server again nor make
  // yet another subscription.
  await flush(10_000);
  await announce(view, alertOf('b'));
  assert.equal(server.resyncs.length, 1);
  assert.equal(serviceWorker.subscriptionsMade, 1);
  view.unmount();

  // The next page load sets it up, and from then on push carries the alert.
  server.resyncOk = true;
  const next = await renderEffects();
  assert.deepEqual(resyncedEndpoints().at(-1), { endpoint: 'https://push.example/fresh-2', previousEndpoint: 'https://push.example/fresh-1' });
  await flush(2000);
  await announce(next, alertOf('c'));
  assert.deepEqual(serviceWorker.notifications.map(({ title }) => title), ['Title a', 'Title b']);
  assert.equal(server.reports.at(-1)?.outcome, 'push');
  assert.equal(server.reports.at(-1)?.push, 'registered');
});

test('away from the page, a subscription the server dropped since its last answer leaves the next alert to the page, and is replaced', async () => {
  subscribeBrowser();
  server.preferences = preferencesWith({ webPush: true });
  const view = await renderEffects();
  pageState.focused = false;

  await announce(view, alertOf('a'));
  assert.equal(serviceWorker.notifications.length, 0, 'push carries it');

  // That push came back 410 and the server dropped the subscription. A minute on, the user is still in another app.
  server.registeredEndpoints.delete(PUSH_ENDPOINT);
  await flush(60_000);
  await announce(view, alertOf('b'));
  assert.deepEqual(serviceWorker.notifications.map(({ title }) => title), ['Title b']);
  assert.equal(server.reports.at(-1)?.push, 'unknown');
  // Replaced rather than saved again as it was: the push service had called that one gone.
  assert.deepEqual(resyncedEndpoints(), [{ endpoint: 'https://push.example/fresh-1', previousEndpoint: PUSH_ENDPOINT }]);

  await flush(10_000);
  await announce(view, alertOf('c'));
  assert.deepEqual(serviceWorker.notifications.map(({ title }) => title), ['Title b']);
  assert.equal(server.reports.at(-1)?.outcome, 'push');
});

test('away from the page, a subscription saved since in Settings takes the alert over from the next completion', async () => {
  // The server lacks the subscription and the Web Push channel is off, so nothing puts it right on load.
  subscribeBrowser({ registered: false });
  const view = await renderEffects();
  pageState.focused = false;
  await announce(view, alertOf('a'));
  assert.deepEqual(serviceWorker.notifications.map(({ title }) => title), ['Title a']);

  // The user turns push on in Settings: the server saves this browser's subscription, and the channel is on.
  server.registeredEndpoints.add(PUSH_ENDPOINT);
  server.preferences = preferencesWith({ webPush: true });
  await flush(20_000);
  await announce(view, alertOf('b'));

  assert.deepEqual(serviceWorker.notifications.map(({ title }) => title), ['Title a']);
  assert.equal(server.reports.at(-1)?.outcome, 'push');
  assert.equal(server.reports.at(-1)?.push, 'registered');
});

test('on the page the chime waits on no request about the push subscription', async () => {
  subscribeBrowser();
  const view = await renderEffects();
  assert.equal(server.statusReads, 1);
  // Long after the last answer, with the server slow to give another.
  await flush(11 * 60_000);
  server.statusDelayMs = 1400;

  await announce(view, alertOf('a'), 0);

  assert.equal(sound.chimes, 1);
  assert.equal(server.statusReads, 1);
  assert.deepEqual(reportedDecisions(), ['skipped:onPage']);
});

test('a user who leaves the page while the chime plays gets the server asked then', async () => {
  subscribeBrowser();
  server.preferences = preferencesWith({ webPush: true });
  const view = await renderEffects();
  // The server has dropped the subscription since it last said it held it.
  server.registeredEndpoints.delete(PUSH_ENDPOINT);
  await flush(20_000);
  sound.onChime = () => {
    pageState.focused = false;
  };

  await announce(view, alertOf('a'));

  assert.equal(sound.chimes, 1);
  assert.deepEqual(serviceWorker.notifications.map(({ title }) => title), ['Title a']);
  assert.equal(server.reports.at(-1)?.push, 'unknown');
});

test('a subscription the server lacks is left alone while the Web Push channel is off, or without permission', async () => {
  subscribeBrowser({ registered: false });
  let view = await renderEffects();
  pageState.focused = false;

  await announce(view, alertOf('a'));
  assert.deepEqual(server.resyncs, []);
  assert.deepEqual(serviceWorker.notifications.map(({ title }) => title), ['Title a']);
  view.unmount();

  server.preferences = preferencesWith({ webPush: true });
  vi.stubGlobal('Notification', { permission: 'denied', requestPermission: async () => 'denied' });
  view = await renderEffects();
  await flush(2000);
  assert.deepEqual(server.resyncs, []);
});

test('a server that does not answer about the subscription within 1.5 s leaves the alert to the page', async () => {
  subscribeBrowser();
  server.preferences = preferencesWith({ webPush: true });
  const view = await renderEffects();
  pageState.focused = false;
  // Half a minute on, the server's last word is too old for a delivery away from the page, and it now takes 5 s to answer.
  await flush(30_000);
  server.statusDelayMs = 5000;

  act(() => view.result.current.announce(alertOf('a')));
  await flush(1700);
  assert.equal(serviceWorker.notifications.length, 0);
  await flush(200);
  assert.deepEqual(serviceWorker.notifications.map(({ title }) => title), ['Title a']);
  assert.equal(server.reports.at(-1)?.push, 'unchecked');
});

test('the server is asked again when the page comes back into view a minute on, and when the worker reports a new subscription', async () => {
  subscribeBrowser();
  const view = await renderEffects();
  assert.equal(server.statusReads, 1);

  const showPage = () => act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await flush(30_000);
  showPage();
  await flush();
  assert.equal(server.statusReads, 1, 'half a minute on: the answer still holds');

  await flush(31_000);
  showPage();
  await flush();
  assert.equal(server.statusReads, 2);

  // The worker saw the browser replace the subscription: asked at once, and the new endpoint is the one checked.
  subscribeBrowser({ endpoint: 'https://push.example/replaced', registered: false });
  server.preferences = preferencesWith({ webPush: true });
  serviceWorker.messageListeners.forEach((listener) => listener(new MessageEvent('message', { data: { type: 'push:subscription-changed' } })));
  await flush();
  assert.equal(server.statusReads >= 3, true);
  assert.deepEqual(resyncedEndpoints(), [{ endpoint: 'https://push.example/fresh-1', previousEndpoint: 'https://push.example/replaced' }]);

  view.unmount();
  assert.equal(serviceWorker.messageListeners.size, 0, 'stops listening on unmount');
});

test('every decision about the system notification goes to the server log', async () => {
  const view = await renderEffects();

  // On the page: nothing to post.
  await announce(view, alertOf('a'));
  // Away, posted, silent after the chime.
  pageState.focused = false;
  await flush(2000);
  await announce(view, alertOf('b'));
  // The switch off, then no permission.
  view.rerender({ systemNotificationsEnabled: false });
  await announce(view, alertOf('c'));
  view.rerender({ systemNotificationsEnabled: true });
  vi.stubGlobal('Notification', { permission: 'default', requestPermission: async () => 'default' });
  await announce(view, alertOf('d'));
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: async () => 'granted' });
  // Left to push.
  subscribeBrowser();
  server.preferences = preferencesWith({ webPush: true });
  await flush(20_000);
  await announce(view, alertOf('e'));

  assert.deepEqual(reportedDecisions(), [
    'skipped:onPage',
    'posted:away',
    'skipped:switchOff',
    'skipped:noPermission',
    'push:pushRegistered',
  ]);
  assert.deepEqual(server.reports[1], {
    event: 'notification',
    outcome: 'posted',
    reason: 'away',
    push: 'none',
    silent: true,
    permission: 'granted',
    visibility: 'visible',
    focused: false,
    platform: (navigator.platform || '').slice(0, 40),
  });
  // Nothing about the run itself goes in a report.
  assert.equal(JSON.stringify(server.reports).includes('Title'), false);
});

test('in the desktop app the decision is reported as the desktop app\'s, and a catch-up alert reports nothing', async () => {
  setDesktopApp(true);
  server.preferences = preferencesWith({ desktop: true });
  const view = await renderEffects();
  pageState.focused = false;

  await announce(view, alertOf('a'));
  await announce(view, alertOf('b', { isCatchUp: true }));

  assert.deepEqual(reportedDecisions(), ['desktop:desktopNotifies']);
});
