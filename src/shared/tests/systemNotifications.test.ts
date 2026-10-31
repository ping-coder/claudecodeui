import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import {
  checkPushRegistration,
  repairPushRegistration,
  reportNotificationDelivery,
  urlBase64ToUint8Array,
} from '@/shared/systemNotifications';

/**
 * A browser's push subscription counts as deliverable only when the server holds its endpoint and it was made with
 * the server's current VAPID key: the browser can hold one the server dropped or never got, or one keyed to an
 * older VAPID key, and trusting either left a finished task without a notification. A repair replaces either with
 * a new subscription (the server most often lacks one because the push service called it gone), without the
 * preference change and "enabled" push of turning push on. A browser that will not subscribe outside a click keeps
 * the one it holds, saved again.
 */

const CURRENT_KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const OLD_KEY = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';

const server = vi.hoisted(() => ({
  available: true,
  registered: new Set<string>(),
  resyncs: [] as unknown[],
  reports: [] as unknown[],
}));

vi.mock('@/shared/api', () => ({
  api: {
    settings: {
      push: {
        vapidPublicKey: async () => {
          if (!server.available) {
            throw new TypeError('Failed to fetch');
          }
          return { ok: true, json: async () => ({ publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' }) };
        },
        status: async (endpoint: string) => ({ ok: true, json: async () => ({ success: true, registered: server.registered.has(endpoint) }) }),
        resync: async (subscription: { endpoint: string; previousEndpoint?: string }) => {
          server.resyncs.push(subscription);
          server.registered.add(subscription.endpoint);
          if (subscription.previousEndpoint) {
            server.registered.delete(subscription.previousEndpoint);
          }
          return { ok: true, json: async () => ({ success: true }) };
        },
      },
    },
    system: {
      reportClientDiagnostics: async (report: unknown) => {
        server.reports.push(report);
        return { ok: true };
      },
    },
  },
}));

type FakeSubscription = {
  endpoint: string;
  options?: { applicationServerKey: ArrayBuffer | null };
  toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } };
  unsubscribe: () => Promise<boolean>;
};

const browser = {
  subscription: null as FakeSubscription | null,
  subscribeCalls: [] as unknown[],
  // Safari's way: subscribe() outside a click is refused, even with the permission granted.
  refusesWithoutGesture: false,
};

const subscriptionWith = (endpoint: string, key: string | null): FakeSubscription => ({
  endpoint,
  options: { applicationServerKey: key === null ? null : urlBase64ToUint8Array(key).buffer as ArrayBuffer },
  toJSON: () => ({ endpoint, keys: { p256dh: `p256dh-${endpoint}`, auth: `auth-${endpoint}` } }),
  unsubscribe: async () => {
    browser.subscription = null;
    return true;
  },
});

const isSameKey = (first: ArrayBuffer | null | undefined, second: ArrayBuffer) => (
  first !== null && first !== undefined && new Uint8Array(first).join() === new Uint8Array(second).join()
);

const installServiceWorker = (pushManager: unknown = {
  getSubscription: async () => browser.subscription,
  // As browsers do: the subscription held comes back when asked with its key, and one with another key blocks a new one.
  subscribe: async (options: { applicationServerKey: ArrayBuffer }) => {
    browser.subscribeCalls.push(options);
    if (browser.refusesWithoutGesture) {
      throw new DOMException('Subscribing for push requires a user gesture', 'NotAllowedError');
    }
    if (browser.subscription) {
      if (isSameKey(browser.subscription.options?.applicationServerKey, options.applicationServerKey)) {
        return browser.subscription;
      }
      throw new DOMException('A subscription with a different applicationServerKey already exists', 'InvalidStateError');
    }
    browser.subscription = subscriptionWith('https://push.example/fresh', CURRENT_KEY);
    return browser.subscription;
  },
}) => {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: async () => ({ pushManager }) },
  });
};

beforeEach(() => {
  server.available = true;
  server.registered.clear();
  server.resyncs.length = 0;
  server.reports.length = 0;
  browser.subscription = null;
  browser.subscribeCalls.length = 0;
  browser.refusesWithoutGesture = false;
  installServiceWorker();
});

afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  delete (navigator as unknown as Record<string, unknown>).locks;
});

test('only a subscription the server holds, made with its current key, counts as registered', async () => {
  assert.deepEqual(await checkPushRegistration(), { status: 'none', endpoint: null });

  browser.subscription = subscriptionWith('https://push.example/a', CURRENT_KEY);
  assert.deepEqual(await checkPushRegistration(), { status: 'unknown', endpoint: 'https://push.example/a' });

  server.registered.add('https://push.example/a');
  assert.deepEqual(await checkPushRegistration(), { status: 'registered', endpoint: 'https://push.example/a' });

  // Registered, but made with the key the server used before: its pushes would be refused.
  browser.subscription = subscriptionWith('https://push.example/a', OLD_KEY);
  assert.equal((await checkPushRegistration()).status, 'staleKey');
  // Made with no key at all (an old GCM sender id).
  browser.subscription = subscriptionWith('https://push.example/a', null);
  assert.equal((await checkPushRegistration()).status, 'staleKey');
  // A browser that does not say which key it used is taken at its word.
  browser.subscription = { ...subscriptionWith('https://push.example/a', OLD_KEY), options: undefined };
  assert.equal((await checkPushRegistration()).status, 'registered');

  server.available = false;
  assert.equal((await checkPushRegistration()).status, 'unchecked');
});

test('without a service worker or push the check says so at once, without asking the server', async () => {
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  assert.deepEqual(await checkPushRegistration(), { status: 'unsupported', endpoint: null });

  installServiceWorker(null);
  assert.deepEqual(await checkPushRegistration(), { status: 'unsupported', endpoint: null });
});

test('a known answer for the endpoint is reused instead of asking the server', async () => {
  browser.subscription = subscriptionWith('https://push.example/a', CURRENT_KEY);
  const asked: string[] = [];

  const check = await checkPushRegistration((endpoint) => {
    asked.push(endpoint);
    return 'registered';
  });

  assert.deepEqual(check, { status: 'registered', endpoint: 'https://push.example/a' });
  assert.deepEqual(asked, ['https://push.example/a']);
});

test('a repair replaces a subscription the server lacks with a new one, quietly, and leaves a registered one alone', async () => {
  // The server dropped it after the push service called it gone: saved again as it is, the next push would drop it again.
  browser.subscription = subscriptionWith('https://push.example/gone', CURRENT_KEY);

  assert.deepEqual(await repairPushRegistration(), { status: 'registered', endpoint: 'https://push.example/fresh' });
  assert.deepEqual(server.resyncs, [{
    endpoint: 'https://push.example/fresh',
    keys: { p256dh: 'p256dh-https://push.example/fresh', auth: 'auth-https://push.example/fresh' },
    previousEndpoint: 'https://push.example/gone',
  }]);
  assert.equal(browser.subscription?.endpoint, 'https://push.example/fresh');

  assert.deepEqual(await repairPushRegistration(), { status: 'registered', endpoint: 'https://push.example/fresh' });
  assert.equal(server.resyncs.length, 1);
});

test('where the browser will not subscribe outside a click, a subscription the server lacks is kept and saved again', async () => {
  browser.refusesWithoutGesture = true;
  browser.subscription = subscriptionWith('https://push.example/a', CURRENT_KEY);

  assert.deepEqual(await repairPushRegistration(), { status: 'registered', endpoint: 'https://push.example/a' });
  assert.deepEqual(server.resyncs, [{ endpoint: 'https://push.example/a', keys: { p256dh: 'p256dh-https://push.example/a', auth: 'auth-https://push.example/a' } }]);
  assert.equal(browser.subscription?.endpoint, 'https://push.example/a');
});

test('a repair replaces a subscription made with an old key, and the server drops the old endpoint', async () => {
  browser.subscription = subscriptionWith('https://push.example/stale', OLD_KEY);
  server.registered.add('https://push.example/stale');

  assert.deepEqual(await repairPushRegistration(), { status: 'registered', endpoint: 'https://push.example/fresh' });

  assert.equal(browser.subscribeCalls.length, 1);
  const { applicationServerKey, userVisibleOnly } = browser.subscribeCalls[0] as { applicationServerKey: ArrayBuffer; userVisibleOnly: boolean };
  assert.equal(userVisibleOnly, true);
  assert.deepEqual([...new Uint8Array(applicationServerKey)], [...urlBase64ToUint8Array(CURRENT_KEY)]);
  assert.deepEqual(server.resyncs, [{
    endpoint: 'https://push.example/fresh',
    keys: { p256dh: 'p256dh-https://push.example/fresh', auth: 'auth-https://push.example/fresh' },
    previousEndpoint: 'https://push.example/stale',
  }]);
  assert.deepEqual([...server.registered], ['https://push.example/fresh']);
});

test('tabs repairing at once take turns under one Web Lock, and the second finds nothing left to do', async () => {
  const lockNames: string[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (name: string, callback: () => unknown) => {
        lockNames.push(name);
        const granted = queue.then(() => callback());
        queue = granted.catch(() => undefined);
        return granted;
      },
    },
  });
  browser.subscription = subscriptionWith('https://push.example/a', CURRENT_KEY);

  const [first, second] = await Promise.all([repairPushRegistration(), repairPushRegistration()]);

  assert.deepEqual(lockNames, ['cloudcli:push-registration', 'cloudcli:push-registration']);
  assert.equal(first.status, 'registered');
  assert.equal(second.status, 'registered');
  assert.equal(server.resyncs.length, 1);
});

test('a report carries the decision and the browser state, never what the notification said', async () => {
  vi.stubGlobal('Notification', { permission: 'granted' });
  try {
    reportNotificationDelivery({ outcome: 'posted', reason: 'away', push: 'unknown', silent: false });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    assert.deepEqual(server.reports, [{
      event: 'notification',
      outcome: 'posted',
      reason: 'away',
      push: 'unknown',
      silent: false,
      permission: 'granted',
      visibility: document.visibilityState === 'visible' ? 'visible' : 'hidden',
      focused: document.hasFocus(),
      platform: (navigator.platform || '').slice(0, 40),
    }]);
  } finally {
    vi.unstubAllGlobals();
  }
});
