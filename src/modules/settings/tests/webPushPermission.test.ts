import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { useWebPush } from '@/modules/settings/hooks/useWebPush';

/**
 * requestPermission backs the "Allow notifications" button of the notifications page: it
 * asks for notification permission alone, without a push subscription, and the page reads
 * the answer back from `permission`. Browsers only show the prompt while the click's user
 * activation is live, so the request has to go out before anything else is awaited.
 *
 * jsdom has neither Notification nor a service worker, so both are stubbed.
 */

const stubServiceWorker = () => {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    // Never settles, so the hook's mount-time subscription check stays out of the way.
    value: { ready: new Promise(() => undefined) },
  });
};

const stubNotification = (
  permission: NotificationPermission,
  answer: () => Promise<NotificationPermission>,
) => {
  const requestPermission = vi.fn(answer);
  vi.stubGlobal('Notification', { permission, requestPermission });
  return requestPermission;
};

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

test('requestPermission asks the browser once and reports a grant through permission', async () => {
  stubServiceWorker();
  const browserRequest = stubNotification('default', async () => 'granted');
  const { result } = renderHook(() => useWebPush());
  assert.equal(result.current.permission, 'default');

  let answer: string | undefined;
  await act(async () => {
    answer = await result.current.requestPermission();
  });

  assert.equal(answer, 'granted');
  assert.equal(browserRequest.mock.calls.length, 1);
  assert.equal(result.current.permission, 'granted');
  assert.equal(result.current.isSubscribed, false, 'asking for permission does not subscribe to push');
});

test('requestPermission reports a refusal through permission', async () => {
  stubServiceWorker();
  stubNotification('default', async () => 'denied');
  const { result } = renderHook(() => useWebPush());

  let answer: string | undefined;
  await act(async () => {
    answer = await result.current.requestPermission();
  });

  assert.equal(answer, 'denied');
  assert.equal(result.current.permission, 'denied');
});

test('requestPermission sends the browser request before awaiting anything', async () => {
  stubServiceWorker();
  const browserRequest = stubNotification('default', async () => 'granted');
  const { result } = renderHook(() => useWebPush());

  await act(async () => {
    const pending = result.current.requestPermission();
    // Still inside the synchronous part of the call, where a click's user activation lives.
    assert.equal(browserRequest.mock.calls.length, 1);
    await pending;
  });
});

test('requestPermission resolves to unsupported without asking when notifications are unavailable', async () => {
  // A Notification API without a service worker, as on a plain-http LAN address.
  const browserRequest = stubNotification('default', async () => 'granted');
  const { result } = renderHook(() => useWebPush());
  assert.equal(result.current.permission, 'unsupported');

  let answer: string | undefined;
  await act(async () => {
    answer = await result.current.requestPermission();
  });

  assert.equal(answer, 'unsupported');
  assert.equal(browserRequest.mock.calls.length, 0);
  assert.equal(result.current.permission, 'unsupported');
});

test('a failed request resolves to the current permission and leaves the state alone', async () => {
  stubServiceWorker();
  stubNotification('default', async () => {
    throw new Error('request blocked');
  });
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { result } = renderHook(() => useWebPush());

  let answer: string | undefined;
  await act(async () => {
    answer = await result.current.requestPermission();
  });

  assert.equal(answer, 'default');
  assert.equal(result.current.permission, 'default');
  assert.equal(consoleError.mock.calls.length, 1);
});
