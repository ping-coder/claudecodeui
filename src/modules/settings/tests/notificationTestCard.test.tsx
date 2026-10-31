import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import NotificationTestCard from '@/modules/settings/tabs/NotificationTestCard';

/**
 * Settings' "Send test notification" posts a system notification from the page at once, through the service worker
 * registration, and when this browser holds a push subscription asks the server to push a test to that endpoint
 * alone, then says what became of each: posted, blocked, no service worker; accepted by the push service with its
 * status, or refused and why. A subscription the server lacks is replaced first. A push that arrives while the
 * account's push is off says finished tasks still will not. The permission is asked through Settings, so its
 * switches follow the answer. A collapsed "No banner?" says where macOS, Windows and the browser hide a posted
 * notification.
 */

const server = vi.hoisted(() => ({
  registered: new Set<string>(),
  testAnswer: null as null | { status: number; body: unknown },
  pushTests: [] as unknown[],
  resyncs: [] as unknown[],
  reports: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/shared/api', () => ({
  api: {
    settings: {
      push: {
        vapidPublicKey: async () => ({ ok: true, json: async () => ({ publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' }) }),
        status: async (endpoint: string) => ({ ok: true, json: async () => ({ success: true, registered: server.registered.has(endpoint) }) }),
        resync: async (subscription: { endpoint: string; previousEndpoint?: string }) => {
          server.resyncs.push(subscription);
          server.registered.add(subscription.endpoint);
          if (subscription.previousEndpoint) {
            server.registered.delete(subscription.previousEndpoint);
          }
          return { ok: true, json: async () => ({ success: true }) };
        },
        test: async (payload: { endpoint: string }) => {
          server.pushTests.push(payload);
          const answer = server.testAnswer ?? {
            status: 200,
            body: { success: true, delivery: { accepted: true, statusCode: 201, host: 'fcm.googleapis.com' } },
          };
          return { ok: answer.status < 300, status: answer.status, json: async () => answer.body };
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

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/this-browser';
const FRESH_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/fresh';

type FakeSubscription = { endpoint: string; toJSON: () => unknown; unsubscribe: () => Promise<boolean> };

const browser = {
  hasRegistration: true,
  subscription: null as null | FakeSubscription,
  shown: [] as Array<{ title: string; options: Record<string, unknown> }>,
};

const subscriptionWith = (endpoint: string): FakeSubscription => ({
  endpoint,
  toJSON: () => ({ endpoint, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } }),
  unsubscribe: async () => {
    browser.subscription = null;
    return true;
  },
});

const subscribe = ({ registered }: { registered: boolean }) => {
  browser.subscription = subscriptionWith(ENDPOINT);
  if (registered) {
    server.registered.add(ENDPOINT);
  }
};

const stubPermission = (permission: NotificationPermission, answer: NotificationPermission = permission) => {
  const requestPermission = vi.fn(async () => answer);
  vi.stubGlobal('Notification', { permission, requestPermission });
  return requestPermission;
};

/** Settings' permission request: asks the browser, as useWebPush does. */
const requestPermissionThroughSettings = vi.fn(async () => Notification.requestPermission());

const renderCard = ({ isAccountPushOff = false }: { isAccountPushOff?: boolean } = {}) => render(
  <NotificationTestCard onRequestNotificationPermission={requestPermissionThroughSettings} isAccountPushOff={isAccountPushOff} />,
);

/** Clicks the button and lets the test run to its end. */
const sendTest = async (name = 'Send test notification') => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
};

// Presence checks come back as booleans: node:assert must never be handed a DOM node.
const hasText = (text: string) => screen.queryByText(text) !== null;

beforeEach(() => {
  server.registered.clear();
  server.testAnswer = null;
  server.pushTests.length = 0;
  server.resyncs.length = 0;
  server.reports.length = 0;
  browser.hasRegistration = true;
  browser.subscription = null;
  browser.shown.length = 0;
  requestPermissionThroughSettings.mockClear();
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistration: async () => (browser.hasRegistration ? {
        pushManager: {
          getSubscription: async () => browser.subscription,
          // Hands back the subscription held, as browsers do when asked with its key; else makes a new one.
          subscribe: async () => {
            browser.subscription ??= subscriptionWith(FRESH_ENDPOINT);
            return browser.subscription;
          },
        },
        showNotification: async (title: string, options: Record<string, unknown>) => {
          browser.shown.push({ title, options });
        },
      } : undefined),
    },
  });
  stubPermission('granted');
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  await i18n.changeLanguage('en');
});

test('the page posts its test notification through the worker, and says push is off for a browser without it', async () => {
  renderCard();

  await sendTest();

  assert.deepEqual(browser.shown, [{
    title: 'CloudCLI test',
    options: {
      body: 'Sent by this page. If you see this, system notifications work.',
      tag: 'cloudcli:test:local',
      renotify: true,
      icon: '/logo-256.png',
      badge: '/logo-128.png',
      data: {},
    },
  }]);
  assert.equal(hasText('Posted a system notification from this page.'), true);
  assert.equal(hasText('Push is not on for this browser, so no push was sent.'), true);
  assert.deepEqual(server.pushTests, []);
  assert.deepEqual(server.reports.map(({ outcome, reason, push }) => ({ outcome, reason, push })), [
    { outcome: 'posted', reason: 'test', push: 'none' },
  ]);
});

test('a subscribed browser also gets a test push to its own endpoint, with the push service\'s answer shown', async () => {
  subscribe({ registered: true });
  renderCard();

  await sendTest();

  assert.equal(browser.shown.length, 1);
  assert.deepEqual(server.pushTests, [{ endpoint: ENDPOINT, title: 'CloudCLI test', body: 'Sent through push. If you see this, push works.' }]);
  assert.equal(hasText('The push service accepted the test push (201). It should arrive within seconds.'), true);
  assert.deepEqual(server.resyncs, []);
});

test('a push that arrives while the account\'s push is off says finished tasks still will not', async () => {
  subscribe({ registered: true });
  renderCard({ isAccountPushOff: true });

  await sendTest();

  assert.equal(hasText(
    "The push service accepted the test push (201). It should arrive within seconds. Finished tasks won't be pushed here, though: push is off for your account, as happens when it is turned off on another device. Turn push off and on again above to switch it back on.",
  ), true);
});

test('a refused test push shows the status and the push service\'s reason, and a dropped subscription says so', async () => {
  subscribe({ registered: true });
  server.testAnswer = {
    status: 200,
    body: {
      success: true,
      delivery: { accepted: false, statusCode: 403, host: 'fcm.googleapis.com', detail: 'the VAPID credentials do not correspond', dropped: true },
    },
  };
  renderCard();

  await sendTest();

  assert.equal(hasText(
    'The push service refused the test push (403): the VAPID credentials do not correspond That subscription no longer works and was removed. Turn push on again.',
  ), true);

  server.testAnswer = { status: 200, body: { success: true, delivery: { accepted: false, statusCode: null, host: 'fcm.googleapis.com', detail: 'ETIMEDOUT' } } };
  await sendTest();
  assert.equal(hasText("Couldn't reach the push service: ETIMEDOUT"), true);

  server.testAnswer = { status: 500, body: {} };
  await sendTest();
  assert.equal(hasText("CloudCLI couldn't send the test push (HTTP 500)."), true);
});

test('a subscription the server lacks is replaced before the test push goes out to the new one', async () => {
  subscribe({ registered: false });
  renderCard();

  await sendTest();

  assert.deepEqual(server.resyncs, [{ endpoint: FRESH_ENDPOINT, keys: { p256dh: 'p256dh-key', auth: 'auth-key' }, previousEndpoint: ENDPOINT }]);
  assert.deepEqual((server.pushTests as Array<{ endpoint: string }>).map(({ endpoint }) => endpoint), [FRESH_ENDPOINT]);
  assert.equal(hasText(
    "The server couldn't push to this browser's subscription, so it was set up again. The push service accepted the test push (201). It should arrive within seconds.",
  ), true);
});

test('permission not asked yet is asked for first, through Settings; a refusal posts nothing', async () => {
  const requestPermission = stubPermission('default', 'denied');
  renderCard();

  await sendTest();

  // Through Settings' request, so the system notification switch above follows the answer.
  assert.equal(requestPermissionThroughSettings.mock.calls.length, 1);
  assert.equal(requestPermission.mock.calls.length, 1);
  assert.deepEqual(browser.shown, []);
  assert.equal(hasText('Notifications are blocked for this site, so nothing was posted.'), true);

  stubPermission('default', 'default');
  await sendTest();
  assert.equal(hasText('Notifications were not allowed, so nothing was posted.'), true);
});

test('without a service worker the test says to reload, and without the API that it cannot notify here', async () => {
  browser.hasRegistration = false;
  renderCard();

  await sendTest();
  assert.equal(hasText('No service worker is running for this page. Reload the page and try again.'), true);
  assert.equal(hasText('Push is not on for this browser, so no push was sent.'), true);

  vi.stubGlobal('Notification', undefined);
  delete (window as unknown as Record<string, unknown>).Notification;
  await sendTest();
  assert.equal(hasText('This browser cannot show system notifications here.'), true);
});

test('No banner? opens to the macOS, Windows and browser checks, naming this address', () => {
  renderCard();

  const summary = screen.getByText('No banner?');
  assert.equal(summary.tagName, 'SUMMARY');
  assert.equal(hasText(
    'macOS: System Settings → Notifications → Google Chrome (or your browser): turn on Allow notifications and choose Banners or Alerts. Focus and Do Not Disturb hide banners too.',
  ), true);
  assert.equal(hasText(
    'Windows: Settings → System → Notifications: turn on Google Chrome (or your browser) and Show notification banners. Turn off Do not disturb (Focus assist on Windows 10).',
  ), true);
  assert.equal(screen.queryAllByText((text) => text.includes(window.location.origin) && text.includes('localhost and 127.0.0.1')).length, 1);
});

test('in Chinese the button, the outcomes and the help read correctly', async () => {
  await i18n.changeLanguage('zh-CN');
  renderCard();

  await sendTest('发送测试通知');

  assert.equal(browser.shown[0]?.title, 'CloudCLI 测试');
  assert.equal(hasText('已从本页发出系统通知。'), true);
  assert.equal(hasText('此浏览器没有开推送，所以没有发推送。'), true);
  assert.equal(hasText('没有弹出横幅？'), true);
});
