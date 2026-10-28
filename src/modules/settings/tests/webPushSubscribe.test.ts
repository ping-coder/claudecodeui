import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { PushSubscribeOutcome } from '@/shared/types';

/**
 * Regression guard: turning push on stored the Web Push channel as on even when the browser
 * refused permission or the subscription failed, since subscribe() swallowed every failure and
 * the settings dialog saved the channel after it either way. subscribe() now resolves to how it
 * went, only 'subscribed' when the server saved the subscription, and keeps the reason of a
 * failure for the notifications tab to show. A subscription the attempt made that the server never
 * got is dropped from the browser too; one the browser already held, say from another tab, stays.
 *
 * jsdom has neither Notification, a service worker nor push, so all three are stubbed.
 */

const server = vi.hoisted(() => ({
  publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' as string | null,
  subscribeOk: true,
  keyRequests: 0,
  subscriptions: [] as unknown[],
}));

vi.mock('@/shared/api', () => ({
  api: {
    settings: {
      push: {
        vapidPublicKey: async () => {
          server.keyRequests += 1;
          return { ok: true, status: 200, json: async () => ({ publicKey: server.publicKey }) };
        },
        subscribe: async (subscription: unknown) => {
          server.subscriptions.push(subscription);
          return server.subscribeOk
            ? { ok: true, status: 200, json: async () => ({ success: true }) }
            : { ok: false, status: 500, json: async () => ({ error: 'Failed to save subscription' }) };
        },
        unsubscribe: async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }),
      },
    },
  },
}));

const { useWebPush } = await import('@/modules/settings/hooks/useWebPush');

const ENDPOINT = 'https://push.example.test/subscription-1';

/** What the browser's push manager holds, as getSubscription() answers it. */
const browser = { subscription: null as null | typeof browserSubscription };

/** The browser's push subscription, which a failed attempt must unsubscribe. */
const browserSubscription = {
  endpoint: ENDPOINT,
  toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } }),
  unsubscribe: vi.fn(async () => {
    browser.subscription = null;
    return true;
  }),
};

const subscribeInBrowser = async () => {
  browser.subscription = browserSubscription;
  return browserSubscription;
};

const pushManager = {
  subscribe: vi.fn(subscribeInBrowser),
  getSubscription: async () => browser.subscription,
};

const stubNotification = (answer: NotificationPermission, permission: NotificationPermission = 'default') => {
  const requestPermission = vi.fn(async () => answer);
  vi.stubGlobal('Notification', { permission, requestPermission });
  return requestPermission;
};

const stubServiceWorker = (ready: Promise<unknown>) => {
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready } });
};

/** Runs subscribe() to its end and returns its outcome. */
const subscribeWith = async (result: { current: ReturnType<typeof useWebPush> }) => {
  let outcome: PushSubscribeOutcome | undefined;
  await act(async () => {
    outcome = await result.current.subscribe();
  });
  return outcome;
};

/** Lets the hook's check of what the browser holds, on mount or a permission change, finish. */
const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

beforeEach(() => {
  server.publicKey = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
  server.subscribeOk = true;
  server.keyRequests = 0;
  server.subscriptions = [];
  browser.subscription = null;
  browserSubscription.unsubscribe.mockClear();
  pushManager.subscribe.mockReset();
  pushManager.subscribe.mockImplementation(subscribeInBrowser);
  stubServiceWorker(Promise.resolve({ pushManager }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

test('a granted permission and a subscription the server saves subscribe this browser', async () => {
  stubNotification('granted');
  const { result } = renderHook(() => useWebPush());

  const outcome = await subscribeWith(result);

  assert.equal(outcome, 'subscribed');
  assert.equal(result.current.isSubscribed, true);
  assert.equal(result.current.subscribeFailure, null);
  assert.equal(result.current.isLoading, false);
  assert.deepEqual(server.subscriptions, [{ endpoint: ENDPOINT, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } }]);
  assert.equal(browserSubscription.unsubscribe.mock.calls.length, 0);
});

test('a refused prompt fails as denied, before anything is asked of the server', async () => {
  stubNotification('denied');
  const { result } = renderHook(() => useWebPush());

  const outcome = await subscribeWith(result);

  assert.equal(outcome, 'denied');
  assert.equal(result.current.permission, 'denied');
  assert.equal(result.current.subscribeFailure, 'denied');
  assert.equal(result.current.isSubscribed, false);
  assert.equal(result.current.isLoading, false);
  assert.equal(server.keyRequests, 0);
  assert.equal(pushManager.subscribe.mock.calls.length, 0);
});

test('a prompt closed without an answer fails as dismissed', async () => {
  stubNotification('default');
  const { result } = renderHook(() => useWebPush());

  const outcome = await subscribeWith(result);

  assert.equal(outcome, 'dismissed');
  assert.equal(result.current.subscribeFailure, 'dismissed');
  assert.equal(result.current.isSubscribed, false);
  assert.equal(server.subscriptions.length, 0);
});

test('a browser with notifications but no push fails as unsupported', async () => {
  stubNotification('granted');
  stubServiceWorker(Promise.resolve({}));
  const { result } = renderHook(() => useWebPush());

  const outcome = await subscribeWith(result);

  assert.equal(outcome, 'unsupported');
  assert.equal(result.current.subscribeFailure, 'unsupported');
  assert.equal(result.current.isSubscribed, false);
});

test('without notification support it fails as unsupported and never prompts', async () => {
  const requestPermission = stubNotification('granted');
  Reflect.deleteProperty(navigator, 'serviceWorker');
  const { result } = renderHook(() => useWebPush());
  assert.equal(result.current.permission, 'unsupported');

  const outcome = await subscribeWith(result);

  assert.equal(outcome, 'unsupported');
  assert.equal(requestPermission.mock.calls.length, 0);
  assert.equal(result.current.subscribeFailure, 'unsupported');
});

test('a subscription the server refuses fails, and the browser drops its copy', async () => {
  stubNotification('granted');
  server.subscribeOk = false;
  const { result } = renderHook(() => useWebPush());

  const outcome = await subscribeWith(result);

  assert.equal(outcome, 'failed');
  assert.equal(result.current.subscribeFailure, 'failed');
  assert.equal(result.current.isSubscribed, false);
  assert.equal(result.current.isLoading, false);
  assert.equal(browserSubscription.unsubscribe.mock.calls.length, 1);
  assert.equal(browser.subscription === null, true, 'the browser holds no subscription the server lacks');
});

test('a subscription the browser already held, say from another tab, stays when saving it fails', async () => {
  stubNotification('granted', 'granted');
  const { result } = renderHook(() => useWebPush());
  await settle();
  // The check on mount found nothing, so the button offers to turn push on. Then another tab
  // turns push on: the browser holds the subscription the server stored for that tab.
  assert.equal(result.current.isSubscribed, false);
  browser.subscription = browserSubscription;
  // Asked again with the same key, the browser hands that subscription back, in a new object.
  pushManager.subscribe.mockImplementation(async () => ({ ...browserSubscription }));
  server.subscribeOk = false;

  const outcome = await subscribeWith(result);

  assert.equal(outcome, 'failed');
  assert.equal(browserSubscription.unsubscribe.mock.calls.length, 0);
  assert.equal(browser.subscription === browserSubscription, true, 'the subscription the other tab saved is still there');
  assert.equal(result.current.isSubscribed, true, 'the button shows what the browser holds');
  assert.equal(result.current.subscribeFailure === null, true, 'no failure note under a button that says push is on');
});

test('a subscription made in place of an expired one is dropped when saving it fails', async () => {
  stubNotification('granted', 'granted');
  const expiredSubscription = {
    ...browserSubscription,
    endpoint: 'https://push.example.test/expired',
    unsubscribe: vi.fn(async () => true),
  };
  browser.subscription = expiredSubscription;
  server.subscribeOk = false;
  const { result } = renderHook(() => useWebPush());

  const outcome = await subscribeWith(result);

  assert.equal(outcome, 'failed');
  assert.equal(result.current.subscribeFailure, 'failed');
  assert.equal(result.current.isSubscribed, false);
  assert.equal(browserSubscription.unsubscribe.mock.calls.length, 1);
  assert.equal(expiredSubscription.unsubscribe.mock.calls.length, 0);
  assert.equal(browser.subscription === null, true, 'the browser holds no subscription the server lacks');
});

test('turning push off clears the reason an earlier attempt failed', async () => {
  const requestPermission = stubNotification('default');
  const { result } = renderHook(() => useWebPush());
  assert.equal(await subscribeWith(result), 'dismissed');
  // Another tab turns push on, and allowing notifications here shows that this browser has it.
  browser.subscription = browserSubscription;
  requestPermission.mockImplementation(async () => 'granted');
  await act(async () => {
    await result.current.requestPermission();
  });
  await settle();
  assert.equal(result.current.isSubscribed, true);

  await act(async () => {
    await result.current.unsubscribe();
  });

  assert.equal(result.current.isSubscribed, false);
  assert.equal(result.current.subscribeFailure === null, true, 'no note left over from the dismissed prompt');
});

test('a push service error fails before anything reaches the server', async () => {
  stubNotification('granted');
  pushManager.subscribe.mockImplementation(async () => {
    throw new DOMException('Registration failed - push service error', 'AbortError');
  });
  const { result } = renderHook(() => useWebPush());

  const outcome = await subscribeWith(result);

  assert.equal(outcome, 'failed');
  assert.equal(server.subscriptions.length, 0);
  assert.equal(result.current.isSubscribed, false);
});

test('a server without a push key fails', async () => {
  stubNotification('granted');
  server.publicKey = null;
  const { result } = renderHook(() => useWebPush());

  const outcome = await subscribeWith(result);

  assert.equal(outcome, 'failed');
  assert.equal(pushManager.subscribe.mock.calls.length, 0);
});

test('without an active service worker it fails after a while instead of spinning for good', async () => {
  vi.useFakeTimers();
  stubNotification('granted');
  // `ready` never settles while no worker is active.
  stubServiceWorker(new Promise(() => undefined));
  const { result } = renderHook(() => useWebPush());

  let outcome: PushSubscribeOutcome | undefined;
  await act(async () => {
    const pending = result.current.subscribe().then((value) => {
      outcome = value;
    });
    await vi.advanceTimersByTimeAsync(9_000);
    assert.equal(outcome, undefined, 'still waiting for the worker');
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
  });

  assert.equal(outcome, 'failed');
  assert.equal(result.current.isLoading, false);
  assert.equal(result.current.subscribeFailure, 'failed');
});

test('the next attempt clears the reason the last one failed', async () => {
  const requestPermission = stubNotification('default');
  const { result } = renderHook(() => useWebPush());
  assert.equal(await subscribeWith(result), 'dismissed');
  assert.equal(result.current.subscribeFailure, 'dismissed');

  requestPermission.mockImplementation(async () => 'granted');
  assert.equal(await subscribeWith(result), 'subscribed');

  assert.equal(result.current.subscribeFailure, null);
  assert.equal(result.current.isSubscribed, true);
});
