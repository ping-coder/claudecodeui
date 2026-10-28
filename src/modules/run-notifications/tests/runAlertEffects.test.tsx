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
 * one chime. The page stays quiet when the sound is off, for a catch-up alert, when the desktop app notifies
 * natively, and when push will deliver while the user is away. The page posts a system notification only when
 * the user is away, the permission is granted, their switch is on, and neither push nor the desktop app will.
 */

const sound = vi.hoisted(() => ({ chimes: 0, primes: 0, mirroredSettings: [] as boolean[] }));
const server = vi.hoisted(() => ({ preferences: null as unknown, preferenceReads: 0 }));
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
        return server.preferences
          ? { ok: true, json: async () => ({ success: true, preferences: server.preferences }) }
          : { ok: false, json: async () => ({}) };
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
  notifications: [] as Array<{ title: string; options: Record<string, unknown> }>,
};

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
  server.preferences = preferencesWith();
  server.preferenceReads = 0;
  deployment.environment = null;
  pageState.visible = true;
  pageState.focused = true;
  serviceWorker.subscription = null;
  serviceWorker.notifications.length = 0;

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
        pushManager: { getSubscription: async () => serviceWorker.subscription },
        showNotification: async (title: string, options: Record<string, unknown>) => {
          serviceWorker.notifications.push({ title, options });
        },
      }),
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
  serviceWorker.subscription = { endpoint: 'https://push.example/abc' };
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
      renotify: false,
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
  serviceWorker.subscription = { endpoint: 'https://push.example/abc' };
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

test('the system notification is silent exactly when the page chimed', async () => {
  pageState.focused = false;
  const view = await renderEffects();

  await announce(view, alertOf('a'));
  // Within 1.5 s of that chime: no chime of its own, so the notification sounds.
  await announce(view, alertOf('b', { outcome: 'failed' }), 0);
  await flush(2000);
  localStorage.setItem('notificationSoundEnabled', 'false');
  await announce(view, alertOf('c', { outcome: 'backgroundDone' }));

  assert.deepEqual(serviceWorker.notifications.map(({ options }) => ({
    tag: options.tag,
    silent: options.silent,
    renotify: options.renotify,
  })), [
    { tag: 'claude:a:run.stopped', silent: true, renotify: false },
    { tag: 'claude:b:run.failed', silent: false, renotify: true },
    { tag: 'claude:c:run.background_completed', silent: false, renotify: true },
  ]);
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

test('on mount the server\'s sound setting is mirrored into this browser, and read again once it is a minute old', async () => {
  server.preferences = preferencesWith({ sound: false });
  const view = await renderEffects();

  assert.deepEqual(sound.mirroredSettings, [false]);
  assert.equal(localStorage.getItem('notificationSoundEnabled'), 'false');
  assert.equal(server.preferenceReads, 1);

  await flush(30_000);
  await announce(view, alertOf('a'));
  assert.equal(server.preferenceReads, 1);

  server.preferences = preferencesWith({ sound: true });
  await flush(30_000);
  await announce(view, alertOf('b'));
  assert.equal(server.preferenceReads, 2);
  assert.deepEqual(sound.mirroredSettings, [false, true]);
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
