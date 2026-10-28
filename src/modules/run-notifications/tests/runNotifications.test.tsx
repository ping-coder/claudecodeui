import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { RunNotifications } from '@/modules/run-notifications';
import { SessionProtectionProvider } from '@/shared/context/SessionProtectionContext';
import type { RunAlertBannerPlacement, RunSessionLabel } from '@/shared/types';
import type * as SharedUtils from '@/shared/utils';
import { setDocumentPageTitle } from '@/shared/utils';

/**
 * The whole module on one page: a `run_ended` frame from the socket becomes a title alert, a banner and, in the
 * tab that claims it, one chime. The banner follows the user's banner switch. The top banner offers to turn on
 * system notifications while the browser could show them, on at most three banners, until the user answers it
 * in this tab or another.
 */

const page = vi.hoisted(() => {
  const listeners = new Set<(event: unknown) => void>();
  return {
    listeners,
    subscribe: (listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    chimes: 0,
    preferences: { runAlertBanner: true, runAlertSystemNotification: true },
  };
});

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: page.subscribe }),
}));

vi.mock('@/shared/context/UiPreferencesContext', () => ({
  useUiPreferences: () => page.preferences,
}));

vi.mock('@/shared/hooks/useDeploymentEnvironment', () => ({
  useDeploymentEnvironment: () => null,
}));

vi.mock('@/shared/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedUtils>()),
  playChatCompletionSound: async () => {
    page.chimes += 1;
    return true;
  },
  primeNotificationSound: () => undefined,
}));

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      // The running-sessions poll stays out of the activity map.
      runningSessions: () => Promise.resolve({ ok: false, json: async () => ({}) }),
      runEnds: () => okJson({ success: true, data: { ends: [] } }),
      settings: {
        notificationPreferences: () => okJson({
          success: true,
          preferences: {
            channels: { inApp: false, webPush: false, desktop: false, sound: true },
            events: { actionRequired: true, stop: true, error: true },
          },
        }),
      },
    },
  };
});

const SYSTEM_CTA_STORAGE_KEY = 'cloudcli:run-alerts:system-cta';
const CLAIMS_STORAGE_KEY = 'cloudcli:run-alerts:claims';
const ENABLE_SYSTEM = 'Turn on system notifications';

// The page state the hooks read: document.visibilityState and document.hasFocus(), which jsdom pins.
const pageState = { visible: true, focused: true };
const requestedPermissions = { count: 0 };
const openedSessions: string[] = [];

const LABELS: Record<string, RunSessionLabel> = {
  'session-a': { title: 'Fix login bug', projectName: 'Alpha' },
};

const NOTHING_ON_SCREEN: ReadonlySet<string> = new Set();

const renderRunNotifications = async (placement: RunAlertBannerPlacement = 'desktop') => {
  const view = render(
    <SessionProtectionProvider>
      <RunNotifications
        resolveSessionLabel={(sessionId) => LABELS[sessionId] ?? null}
        onScreenSessionIds={NOTHING_ON_SCREEN}
        onOpenSession={(sessionId) => openedSessions.push(sessionId)}
        placement={placement}
      />
    </SessionProtectionProvider>,
  );
  // The recent-ends baseline, the notification preferences and the push check on mount.
  await flush();
  return view;
};

/** Runs the timers due in the next `ms` and every promise they release. */
const flush = (ms = 0) => act(async () => {
  await vi.advanceTimersByTimeAsync(ms);
});

/** A run's end as the server broadcasts it, then whatever the claim and the chime wait on. */
const runEnded = async (sessionId: string, runStartedAt = 1000, overrides: Record<string, unknown> = {}) => {
  act(() => {
    for (const listener of page.listeners) {
      listener({
        kind: 'run_ended',
        sessionId,
        provider: 'claude',
        runStartedAt,
        endedAt: runStartedAt + 500,
        outcome: 'done',
        backgroundWork: false,
        sessionName: null,
        timestamp: '2026-10-27T10:00:00.000Z',
        ...overrides,
      });
    }
  });
  await flush();
};

const bannerTitles = () => screen.queryAllByRole('article').map((card) => card.getAttribute('aria-label'));
const hasSystemCta = () => screen.queryByRole('button', { name: ENABLE_SYSTEM }) !== null;
const readSystemCta = () => JSON.parse(localStorage.getItem(SYSTEM_CTA_STORAGE_KEY) ?? 'null') as unknown;

/** A browser that could show the page's system notifications once allowed: secure, permission not asked yet. */
const allowSystemCta = () => {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  vi.stubGlobal('Notification', {
    permission: 'default',
    requestPermission: () => {
      requestedPermissions.count += 1;
      return Promise.resolve('granted');
    },
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  page.chimes = 0;
  page.preferences = { runAlertBanner: true, runAlertSystemNotification: true };
  pageState.visible = true;
  pageState.focused = true;
  requestedPermissions.count = 0;
  openedSessions.length = 0;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (pageState.visible ? 'visible' : 'hidden'),
  });
  vi.spyOn(document, 'hasFocus').mockImplementation(() => pageState.focused);
  setDocumentPageTitle('Workspace');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const [target, name] of [
    [document, 'visibilityState'],
    [window, 'isSecureContext'],
    [window, 'cloudcliDesktopNotifications'],
    [navigator, 'serviceWorker'],
  ] as const) {
    delete (target as unknown as Record<string, unknown>)[name];
  }
});

test('a run_ended frame puts [Done] in the title, shows a banner, and the tab that claims it chimes once', async () => {
  await renderRunNotifications();

  await runEnded('session-a');
  assert.equal(document.title, '[Done] Fix login bug');
  assert.deepEqual(bannerTitles(), ['Fix login bug']);
  assert.equal(page.chimes, 1);

  // Past the 1.5 s of that chime: an alert another tab claimed first makes no sound here, the next one does.
  await flush(2000);
  localStorage.setItem(CLAIMS_STORAGE_KEY, JSON.stringify({ keys: { 'session-b:2000:turn': Date.now() }, lastChimeAt: 0 }));
  await runEnded('session-b', 2000, { sessionName: 'Audit deps' });
  assert.deepEqual(bannerTitles(), ['Audit deps', 'Fix login bug']);
  assert.equal(page.chimes, 1);

  await runEnded('session-c', 3000);
  assert.deepEqual(bannerTitles(), ['Untitled session', 'Audit deps', 'Fix login bug']);
  assert.equal(page.chimes, 2);
});

test('"Open" opens the session and takes its banner away', async () => {
  await renderRunNotifications();
  await runEnded('session-a');
  await flush(400);

  fireEvent.click(screen.getByRole('button', { name: 'Open Fix login bug' }));
  assert.deepEqual(openedSessions, ['session-a']);
  assert.deepEqual(bannerTitles(), []);
});

test('with the banner switch off no banner shows, while the title and the chime still do', async () => {
  page.preferences = { runAlertBanner: false, runAlertSystemNotification: true };
  await renderRunNotifications();

  await runEnded('session-a');
  assert.deepEqual(bannerTitles(), []);
  assert.equal(document.title, '[Done] Fix login bug');
  assert.equal(page.chimes, 1);
});

test('the system-notification prompt rides on the top banner, on three new banners at most', async () => {
  allowSystemCta();
  await renderRunNotifications();
  assert.equal(hasSystemCta(), false, 'no banner, no prompt');

  await runEnded('session-a', 1000);
  assert.equal(hasSystemCta(), true);
  await runEnded('session-b', 2000);
  await runEnded('session-c', 3000);
  assert.equal(within(screen.getAllByRole('article')[0]).queryByRole('button', { name: ENABLE_SYSTEM }) === null, false);
  assert.deepEqual(readSystemCta(), { shown: 3, done: false });

  await runEnded('session-d', 4000);
  assert.equal(hasSystemCta(), false);
  assert.deepEqual(readSystemCta(), { shown: 3, done: false });
});

test('the prompt asks for the permission first thing in the click, and is gone for good once answered or closed', async () => {
  allowSystemCta();
  const view = await renderRunNotifications();
  await runEnded('session-a', 1000);
  await flush(400);

  fireEvent.click(screen.getByRole('button', { name: ENABLE_SYSTEM }));
  // Within the click itself, not after an await: Safari asks only from a user gesture.
  assert.equal(requestedPermissions.count, 1);
  assert.equal(hasSystemCta(), false);
  assert.deepEqual(readSystemCta(), { shown: 1, done: true });
  await runEnded('session-b', 2000);
  assert.equal(hasSystemCta(), false);
  view.unmount();

  // Closing the card that carries the prompt declines it.
  localStorage.clear();
  await renderRunNotifications();
  await runEnded('session-c', 3000);
  await flush(400);
  const promptCard = screen.getAllByRole('article')[0];
  fireEvent.click(within(promptCard).getByRole('button', { name: 'Dismiss' }));
  assert.deepEqual(readSystemCta(), { shown: 1, done: true });
  await runEnded('session-d', 4000);
  assert.equal(hasSystemCta(), false);
  assert.equal(requestedPermissions.count, 1);
});

test('an answer given in another tab holds here at once, and this tab never takes it back', async () => {
  allowSystemCta();
  await renderRunNotifications();
  await runEnded('session-a', 1000);
  assert.equal(hasSystemCta(), true);

  // Another tab: the user closed the card that carried the prompt there.
  const answered = JSON.stringify({ shown: 1, done: true });
  localStorage.setItem(SYSTEM_CTA_STORAGE_KEY, answered);
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key: SYSTEM_CTA_STORAGE_KEY, oldValue: null, newValue: answered }));
  });
  assert.equal(hasSystemCta(), false);

  await runEnded('session-b', 2000);
  assert.equal(hasSystemCta(), false);
  assert.deepEqual(readSystemCta(), { shown: 1, done: true });
});

test('no prompt where the page could not show system notifications or need not', async () => {
  const cases: Array<[string, () => void]> = [
    ['the permission was already given', () => {
      vi.stubGlobal('Notification', { permission: 'granted', requestPermission: async () => 'granted' });
    }],
    ['the system-notification switch is off', () => {
      page.preferences = { runAlertBanner: true, runAlertSystemNotification: false };
    }],
    ['plain http on a LAN', () => {
      Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    }],
    ['the desktop app, which notifies natively', () => {
      Object.defineProperty(window, 'cloudcliDesktopNotifications', {
        configurable: true,
        value: { getState: async () => ({ desktopNotifications: { enabled: false } }) },
      });
    }],
    ['push already delivers them', () => {
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          getRegistration: async () => ({
            pushManager: { getSubscription: async () => ({ endpoint: 'https://push.example/abc' }) },
          }),
        },
      });
    }],
  ];

  for (const [index, [reason, arrange]] of cases.entries()) {
    localStorage.clear();
    allowSystemCta();
    arrange();
    const view = await renderRunNotifications();
    await runEnded(`session-${index}`, 1000 + index);
    assert.equal(bannerTitles().length, 1, reason);
    assert.equal(hasSystemCta(), false, reason);
    view.unmount();
    page.preferences = { runAlertBanner: true, runAlertSystemNotification: true };
    for (const [target, name] of [[window, 'isSecureContext'], [window, 'cloudcliDesktopNotifications'], [navigator, 'serviceWorker']] as const) {
      delete (target as unknown as Record<string, unknown>)[name];
    }
  }
});

test('a phone shows one banner at a time', async () => {
  await renderRunNotifications('phone');

  await runEnded('session-a', 1000);
  await runEnded('session-b', 2000, { sessionName: 'Audit deps' });
  assert.deepEqual(bannerTitles(), ['Audit deps']);
  assert.equal(screen.queryByText('1 more') !== null, true);
});
