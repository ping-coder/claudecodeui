import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useImmersiveMode } from '@/modules/project-workspace/hooks/useImmersiveMode';

/**
 * Full screen is one command with one visible state: the workspace goes immersive and, where the
 * browser allows it, the root element takes the browser fullscreen in the same gesture. jsdom has
 * neither the Fullscreen API nor Keyboard Lock, so each test installs the parts a browser would
 * provide and plays the browser's side (granting, refusing, ending fullscreen) by hand.
 */

type Deferred = { resolve: () => void; reject: (error: Error) => void };

// What the stubbed browser currently shows fullscreen.
let fullscreenElement: Element | null = null;
let requestFullscreen = vi.fn<(options?: FullscreenOptions) => Promise<void>>();
let exitFullscreen = vi.fn<() => Promise<void>>();
let keyboard = { lock: vi.fn<(keyCodes?: string[]) => Promise<void>>(), unlock: vi.fn<() => void>() };

const defineOwn = (target: object, key: string, value: unknown) => {
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
};

const showFullscreen = (element: Element | null, eventName = 'fullscreenchange') => {
  fullscreenElement = element;
  document.dispatchEvent(new Event(eventName));
};

beforeEach(() => {
  fullscreenElement = null;
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true });
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
  // The browser grants at once: the element goes fullscreen, fullscreenchange fires, the promise resolves.
  requestFullscreen = vi.fn(async () => {
    showFullscreen(document.documentElement);
  });
  defineOwn(document.documentElement, 'requestFullscreen', requestFullscreen);
  exitFullscreen = vi.fn(async () => {
    showFullscreen(null);
  });
  defineOwn(document, 'exitFullscreen', exitFullscreen);
  keyboard = { lock: vi.fn(async () => undefined), unlock: vi.fn() };
  defineOwn(navigator, 'keyboard', keyboard);
  defineOwn(window, 'isSecureContext', true);
});

afterEach(() => {
  const stubbed: Array<[object, string]> = [
    [document, 'fullscreenEnabled'],
    [document, 'fullscreenElement'],
    [document, 'exitFullscreen'],
    [document, 'webkitFullscreenEnabled'],
    [document, 'webkitFullscreenElement'],
    [document.documentElement, 'requestFullscreen'],
    [document.documentElement, 'webkitRequestFullscreen'],
    [navigator, 'keyboard'],
    [window, 'isSecureContext'],
    [window, 'cloudcliDesktopNotifications'],
  ];
  for (const [target, key] of stubbed) {
    Reflect.deleteProperty(target, key);
  }
});

const enterOrLeave = async (toggle: () => void) => {
  // Async act also flushes the request's promise callbacks.
  await act(async () => {
    toggle();
  });
};

test('entering asks for fullscreen on the root element in the same call and shows both states', async () => {
  const { result } = renderHook(() => useImmersiveMode());

  // The request has to happen inside the user's gesture, so synchronously within toggleImmersive.
  act(() => {
    result.current.toggleImmersive();
  });
  assert.equal(requestFullscreen.mock.calls.length, 1);
  assert.deepEqual(requestFullscreen.mock.calls[0], [{ navigationUI: 'hide' }]);
  // Compared as a boolean: a failed assertion on a DOM node makes node:assert walk the whole tree.
  assert.equal(requestFullscreen.mock.contexts[0] === document.documentElement, true);

  await act(async () => undefined);
  assert.equal(result.current.isImmersive, true);
  assert.equal(result.current.isBrowserFullscreen, true);
});

test('inside the desktop app immersive mode comes without the browser fullscreen', async () => {
  defineOwn(window, 'cloudcliDesktopNotifications', { notify: () => undefined });
  const { result } = renderHook(() => useImmersiveMode());

  await enterOrLeave(result.current.toggleImmersive);

  assert.equal(requestFullscreen.mock.calls.length, 0);
  assert.equal(result.current.isImmersive, true);
  assert.equal(result.current.isBrowserFullscreen, false);
});

test('where the Fullscreen API is off (iPhone) immersive mode comes alone', async () => {
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => false });
  const { result } = renderHook(() => useImmersiveMode());

  await enterOrLeave(result.current.toggleImmersive);

  assert.equal(requestFullscreen.mock.calls.length, 0);
  assert.equal(result.current.isImmersive, true);
});

test('a refused request leaves immersive mode on, quietly', async () => {
  requestFullscreen.mockImplementation(async () => {
    throw new TypeError('Permissions check failed');
  });
  const { result } = renderHook(() => useImmersiveMode());

  // An unhandled rejection here would fail the run.
  await enterOrLeave(result.current.toggleImmersive);

  assert.equal(result.current.isImmersive, true);
  assert.equal(result.current.isBrowserFullscreen, false);
  assert.equal(keyboard.lock.mock.calls.length, 0);

  // The refused fullscreen is not ours, so another element's fullscreen ending changes nothing.
  act(() => {
    showFullscreen(document.body);
    showFullscreen(null);
  });
  assert.equal(result.current.isImmersive, true);
});

test('the browser ending the fullscreen (Escape held, F11) ends immersive mode with it', async () => {
  const { result } = renderHook(() => useImmersiveMode());
  await enterOrLeave(result.current.toggleImmersive);
  assert.equal(result.current.isBrowserFullscreen, true);

  act(() => {
    showFullscreen(null);
  });

  assert.equal(result.current.isImmersive, false);
  assert.equal(result.current.isBrowserFullscreen, false);
  assert.equal(keyboard.unlock.mock.calls.length, 1);
  // The browser already left fullscreen; nothing is asked to leave it again.
  assert.equal(exitFullscreen.mock.calls.length, 0);
});

test('a fullscreen immersive mode did not take ending leaves immersive mode alone', async () => {
  defineOwn(window, 'cloudcliDesktopNotifications', {});
  const { result } = renderHook(() => useImmersiveMode());
  await enterOrLeave(result.current.toggleImmersive);

  // A video goes fullscreen and comes back.
  const video = document.createElement('video');
  act(() => {
    showFullscreen(video);
    showFullscreen(null);
  });

  assert.equal(result.current.isImmersive, true);
});

test('Escape is locked to the page once fullscreen is granted on a secure origin', async () => {
  const { result } = renderHook(() => useImmersiveMode());

  await enterOrLeave(result.current.toggleImmersive);

  assert.deepEqual(keyboard.lock.mock.calls, [[['Escape']]]);
});

test('no keyboard lock on an insecure origin (LAN http)', async () => {
  defineOwn(window, 'isSecureContext', false);
  const { result } = renderHook(() => useImmersiveMode());

  await enterOrLeave(result.current.toggleImmersive);

  assert.equal(requestFullscreen.mock.calls.length, 1);
  assert.equal(keyboard.lock.mock.calls.length, 0);
});

test('leaving immersive mode leaves the browser fullscreen and releases the keyboard', async () => {
  const { result } = renderHook(() => useImmersiveMode());
  await enterOrLeave(result.current.toggleImmersive);

  await enterOrLeave(result.current.toggleImmersive);

  assert.equal(exitFullscreen.mock.calls.length, 1);
  assert.equal(keyboard.unlock.mock.calls.length, 1);
  assert.equal(result.current.isImmersive, false);
  assert.equal(result.current.isBrowserFullscreen, false);

  // exitImmersive (the exit buttons) does the same.
  await enterOrLeave(result.current.toggleImmersive);
  await enterOrLeave(result.current.exitImmersive);
  assert.equal(exitFullscreen.mock.calls.length, 2);
  assert.equal(result.current.isImmersive, false);
});

test('leaving without a browser fullscreen does not touch the Fullscreen API', async () => {
  defineOwn(window, 'cloudcliDesktopNotifications', {});
  const { result } = renderHook(() => useImmersiveMode());
  await enterOrLeave(result.current.toggleImmersive);

  // An F11 fullscreen reports no element and is not ours to end.
  await enterOrLeave(result.current.exitImmersive);

  assert.equal(exitFullscreen.mock.calls.length, 0);
  assert.equal(result.current.isImmersive, false);
});

test('a grant that arrives after immersive mode was left is undone', async () => {
  let pending: Deferred | null = null;
  requestFullscreen.mockImplementation(() => new Promise<void>((resolve, reject) => {
    pending = {
      resolve: () => {
        showFullscreen(document.documentElement);
        resolve();
      },
      reject,
    };
  }));
  const { result } = renderHook(() => useImmersiveMode());

  await enterOrLeave(result.current.toggleImmersive);
  await enterOrLeave(result.current.toggleImmersive);
  // Nothing is fullscreen yet, so there was nothing to exit.
  assert.equal(exitFullscreen.mock.calls.length, 0);

  await act(async () => {
    (pending as Deferred | null)?.resolve();
  });

  assert.equal(exitFullscreen.mock.calls.length, 1);
  assert.equal(keyboard.lock.mock.calls.length, 0);
  assert.equal(result.current.isImmersive, false);
  assert.equal(result.current.isBrowserFullscreen, false);
});

test('Safari\'s prefixed API is used when the standard one is missing', async () => {
  Reflect.deleteProperty(document.documentElement, 'requestFullscreen');
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => undefined });
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => undefined });
  defineOwn(document, 'webkitFullscreenEnabled', true);
  Object.defineProperty(document, 'webkitFullscreenElement', { configurable: true, get: () => fullscreenElement });
  const webkitRequestFullscreen = vi.fn(() => {
    showFullscreen(document.documentElement, 'webkitfullscreenchange');
  });
  defineOwn(document.documentElement, 'webkitRequestFullscreen', webkitRequestFullscreen);
  const { result } = renderHook(() => useImmersiveMode());

  await enterOrLeave(result.current.toggleImmersive);
  assert.equal(webkitRequestFullscreen.mock.calls.length, 1);
  assert.equal(result.current.isBrowserFullscreen, true);

  act(() => {
    showFullscreen(null, 'webkitfullscreenchange');
  });
  assert.equal(result.current.isImmersive, false);
});

test('unmounting the workspace while fullscreen leaves the browser fullscreen', async () => {
  const { result, unmount } = renderHook(() => useImmersiveMode());
  await enterOrLeave(result.current.toggleImmersive);

  unmount();

  assert.equal(exitFullscreen.mock.calls.length, 1);
  assert.equal(keyboard.unlock.mock.calls.length, 1);
});

test('immersive mode is not persisted: a new workspace starts outside it', async () => {
  localStorage.clear();
  sessionStorage.clear();
  const first = renderHook(() => useImmersiveMode());
  await enterOrLeave(first.result.current.toggleImmersive);
  assert.equal(first.result.current.isImmersive, true);

  assert.equal(localStorage.length, 0);
  assert.equal(sessionStorage.length, 0);
  const second = renderHook(() => useImmersiveMode());
  assert.equal(second.result.current.isImmersive, false);
});
