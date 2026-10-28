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

// The matchMedia stand-in vitest.setup.ts installs; tests that replace it put it back.
const setupMatchMedia = window.matchMedia;

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
    [navigator, 'userAgent'],
    [window, 'isSecureContext'],
    [window, 'cloudcliDesktopNotifications'],
  ];
  for (const [target, key] of stubbed) {
    Reflect.deleteProperty(target, key);
  }
  defineOwn(window, 'matchMedia', setupMatchMedia);
  // The window-check tests fake the clock and leave switching back to here, failed or not.
  vi.useRealTimers();
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
  // Nothing was asked of the browser, so there is nothing to explain.
  assert.equal(result.current.browserFullscreenIssue, null);
});

test('where the Fullscreen API is off (iPhone) immersive mode comes alone', async () => {
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => false });
  const { result } = renderHook(() => useImmersiveMode());

  await enterOrLeave(result.current.toggleImmersive);

  assert.equal(requestFullscreen.mock.calls.length, 0);
  assert.equal(result.current.isImmersive, true);
  assert.equal(result.current.browserFullscreenIssue, null);
});

test('a refused request leaves immersive mode on and says why', async () => {
  requestFullscreen.mockImplementation(async () => {
    throw new TypeError('not granted');
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { result } = renderHook(() => useImmersiveMode());

  // An unhandled rejection here would fail the run.
  await enterOrLeave(result.current.toggleImmersive);

  assert.equal(result.current.isImmersive, true);
  assert.equal(result.current.isBrowserFullscreen, false);
  assert.equal(keyboard.lock.mock.calls.length, 0);
  assert.deepEqual(result.current.browserFullscreenIssue, { reason: 'refused', detail: 'not granted' });
  // Chromium logs nothing for a refusal by the browser itself, so the hook does.
  assert.equal(warn.mock.calls.length, 1);

  // The refused fullscreen is not ours, so another element's fullscreen ending changes nothing.
  act(() => {
    showFullscreen(document.body);
    showFullscreen(null);
  });
  assert.equal(result.current.isImmersive, true);

  // Leaving immersive mode takes the reason away, though no fullscreen of ours was left to undo.
  await enterOrLeave(result.current.exitImmersive);
  assert.equal(result.current.browserFullscreenIssue, null);
  assert.equal(exitFullscreen.mock.calls.length, 0);
});

test('a refusal without a message is named by its error', async () => {
  requestFullscreen.mockImplementation(async () => {
    throw new TypeError();
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { result } = renderHook(() => useImmersiveMode());

  await enterOrLeave(result.current.toggleImmersive);

  assert.deepEqual(result.current.browserFullscreenIssue, { reason: 'refused', detail: 'TypeError' });
});

test('a refusal that arrives after immersive mode was left, or after a newer request, reports nothing', async () => {
  const pending: Deferred[] = [];
  requestFullscreen.mockImplementation(() => new Promise<void>((resolve, reject) => {
    pending.push({
      resolve: () => {
        showFullscreen(document.documentElement);
        resolve();
      },
      reject,
    });
  }));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { result } = renderHook(() => useImmersiveMode());

  // Refused after immersive mode was left.
  await enterOrLeave(result.current.toggleImmersive);
  await enterOrLeave(result.current.toggleImmersive);
  await act(async () => {
    pending[0].reject(new TypeError('not granted'));
  });
  assert.equal(result.current.browserFullscreenIssue, null);

  // Refused after a newer request was made and granted.
  await enterOrLeave(result.current.toggleImmersive);
  await enterOrLeave(result.current.toggleImmersive);
  await enterOrLeave(result.current.toggleImmersive);
  await act(async () => {
    pending[2].resolve();
  });
  await act(async () => {
    pending[1].reject(new TypeError('not granted'));
  });
  assert.equal(result.current.browserFullscreenIssue, null);
  assert.equal(result.current.isBrowserFullscreen, true);
  assert.equal(warn.mock.calls.length, 0);
  // Still ours: the browser ending it ends immersive mode.
  act(() => {
    showFullscreen(null);
  });
  assert.equal(result.current.isImmersive, false);
});

test('retry asks again within the same call and clears the reason once granted', async () => {
  requestFullscreen.mockImplementationOnce(async () => {
    throw new TypeError('not granted');
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { result } = renderHook(() => useImmersiveMode());
  await enterOrLeave(result.current.toggleImmersive);
  assert.equal(result.current.browserFullscreenIssue?.reason, 'refused');

  act(() => {
    result.current.retryBrowserFullscreen();
  });
  // Inside the notice's click, so synchronously, and on the root element again.
  assert.equal(requestFullscreen.mock.calls.length, 2);
  assert.equal(requestFullscreen.mock.contexts[1] === document.documentElement, true);

  await act(async () => undefined);
  assert.equal(result.current.browserFullscreenIssue, null);
  assert.equal(result.current.isBrowserFullscreen, true);
  assert.equal(keyboard.lock.mock.calls.length, 1);
  // The retried fullscreen is ours like the first would have been: its end ends immersive mode.
  act(() => {
    showFullscreen(null);
  });
  assert.equal(result.current.isImmersive, false);
});

test('retry does nothing outside immersive mode, while the document is fullscreen or while a retry is pending', async () => {
  const pending: Deferred[] = [];
  const { result } = renderHook(() => useImmersiveMode());

  act(() => {
    result.current.retryBrowserFullscreen();
  });
  assert.equal(requestFullscreen.mock.calls.length, 0);

  await enterOrLeave(result.current.toggleImmersive);
  act(() => {
    result.current.retryBrowserFullscreen();
  });
  assert.equal(requestFullscreen.mock.calls.length, 1);
  await enterOrLeave(result.current.exitImmersive);

  // Refused, then retried twice before the browser answered the first retry.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  requestFullscreen.mockImplementationOnce(async () => {
    throw new TypeError('not granted');
  });
  requestFullscreen.mockImplementation(() => new Promise<void>((resolve, reject) => {
    pending.push({ resolve, reject });
  }));
  await enterOrLeave(result.current.toggleImmersive);
  assert.equal(result.current.browserFullscreenIssue?.reason, 'refused');

  // Not while something else (a video) is fullscreen.
  const video = document.createElement('video');
  act(() => {
    showFullscreen(video);
    result.current.retryBrowserFullscreen();
    showFullscreen(null);
  });
  assert.equal(requestFullscreen.mock.calls.length, 2);

  act(() => {
    result.current.retryBrowserFullscreen();
    result.current.retryBrowserFullscreen();
  });
  assert.equal(requestFullscreen.mock.calls.length, 3);
  assert.equal(pending.length, 1);
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

// ---- The window check: a grant the window does not show (this tab captured, an extension's stand-in)

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

/**
 * Installs a user agent and a `(display-mode: fullscreen)` query that follows a stand-in browser
 * window, as Chromium's does. Records the queries asked for and the change listeners attached.
 */
const stubWindowDisplayMode = (userAgent: string, matches: boolean) => {
  defineOwn(navigator, 'userAgent', userAgent);
  const queries: string[] = [];
  const listeners = new Set<() => void>();
  const query = {
    matches,
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'change') {
        listeners.add(listener);
      }
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === 'change') {
        listeners.delete(listener);
      }
    },
  };
  defineOwn(window, 'matchMedia', (text: string) => {
    queries.push(text);
    return query;
  });
  return {
    queries,
    listeners,
    setWindowFullscreen: (next: boolean) => {
      query.matches = next;
      listeners.forEach((listener) => listener());
    },
  };
};

const advanceTime = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

test('a grant the window never shows is reported as full screen kept inside the window', async () => {
  vi.useFakeTimers();
  const displayMode = stubWindowDisplayMode(CHROME_UA, false);
  const { result } = renderHook(() => useImmersiveMode());

  await enterOrLeave(result.current.toggleImmersive);
  assert.equal(result.current.isBrowserFullscreen, true);
  assert.deepEqual(displayMode.queries, ['(display-mode: fullscreen)']);
  assert.equal(displayMode.listeners.size, 1);
  advanceTime(2999);
  assert.equal(result.current.browserFullscreenIssue, null);
  advanceTime(1);

  assert.deepEqual(result.current.browserFullscreenIssue, { reason: 'inWindow' });
  assert.equal(displayMode.listeners.size, 0);
  assert.equal(vi.getTimerCount(), 0);
  assert.equal(result.current.isImmersive, true);
  // The document already holds the fullscreen: asking again would change nothing.
  act(() => {
    result.current.retryBrowserFullscreen();
  });
  assert.equal(requestFullscreen.mock.calls.length, 1);

  await enterOrLeave(result.current.exitImmersive);
  assert.equal(result.current.browserFullscreenIssue, null);
});

test('a window that turns fullscreen in time, or one already fullscreen, is not reported', async () => {
  vi.useFakeTimers();
  const displayMode = stubWindowDisplayMode(CHROME_UA, false);
  const { result } = renderHook(() => useImmersiveMode());

  await enterOrLeave(result.current.toggleImmersive);
  advanceTime(1000);
  act(() => {
    displayMode.setWindowFullscreen(true);
  });
  assert.equal(displayMode.listeners.size, 0);
  assert.equal(vi.getTimerCount(), 0);
  advanceTime(5000);
  assert.equal(result.current.browserFullscreenIssue, null);

  // Already showing when the grant arrives: nothing to wait for.
  await enterOrLeave(result.current.toggleImmersive);
  await enterOrLeave(result.current.toggleImmersive);
  assert.equal(result.current.isBrowserFullscreen, true);
  assert.equal(vi.getTimerCount(), 0);
  assert.equal(displayMode.listeners.size, 0);
});

test('leaving, unmounting or the browser ending the fullscreen before the window shows it stops the check', async () => {
  vi.useFakeTimers();
  const displayMode = stubWindowDisplayMode(CHROME_UA, false);
  const { result, unmount } = renderHook(() => useImmersiveMode());

  await enterOrLeave(result.current.toggleImmersive);
  assert.equal(vi.getTimerCount(), 1);
  await enterOrLeave(result.current.toggleImmersive);
  assert.equal(vi.getTimerCount(), 0);
  assert.equal(displayMode.listeners.size, 0);
  assert.equal(result.current.browserFullscreenIssue, null);

  await enterOrLeave(result.current.toggleImmersive);
  act(() => {
    showFullscreen(null);
  });
  assert.equal(result.current.isImmersive, false);
  assert.equal(vi.getTimerCount(), 0);
  assert.equal(displayMode.listeners.size, 0);

  await enterOrLeave(result.current.toggleImmersive);
  assert.equal(vi.getTimerCount(), 1);
  unmount();
  assert.equal(vi.getTimerCount(), 0);
  assert.equal(displayMode.listeners.size, 0);
});

test('outside Chromium a granted fullscreen element is taken as the whole screen', async () => {
  vi.useFakeTimers();
  const displayMode = stubWindowDisplayMode(SAFARI_UA, false);
  const { result } = renderHook(() => useImmersiveMode());

  await enterOrLeave(result.current.toggleImmersive);

  // Safari's display-mode does not follow the window, so it is not even asked.
  assert.deepEqual(displayMode.queries, []);
  assert.equal(vi.getTimerCount(), 0);
  advanceTime(3000);
  assert.equal(result.current.browserFullscreenIssue, null);
});

test('a grant that leaves nothing fullscreen (an extension\'s stand-in) is reported after the wait', async () => {
  vi.useFakeTimers();
  stubWindowDisplayMode(SAFARI_UA, false);
  requestFullscreen.mockImplementation(async () => undefined);
  const { result } = renderHook(() => useImmersiveMode());

  await enterOrLeave(result.current.toggleImmersive);
  advanceTime(2999);
  assert.equal(result.current.browserFullscreenIssue, null);
  advanceTime(1);

  assert.deepEqual(result.current.browserFullscreenIssue, { reason: 'inWindow' });
});

test('the prefixed request (Safari before 16.4) is not checked: only webkitfullscreenchange reports it', async () => {
  vi.useFakeTimers();
  stubWindowDisplayMode(SAFARI_UA, false);
  Reflect.deleteProperty(document.documentElement, 'requestFullscreen');
  defineOwn(document, 'webkitFullscreenEnabled', true);
  // Answers later, if at all.
  const webkitRequestFullscreen = vi.fn();
  defineOwn(document.documentElement, 'webkitRequestFullscreen', webkitRequestFullscreen);
  const { result } = renderHook(() => useImmersiveMode());

  await enterOrLeave(result.current.toggleImmersive);
  assert.equal(webkitRequestFullscreen.mock.calls.length, 1);
  assert.equal(vi.getTimerCount(), 0);
  advanceTime(3000);
  assert.equal(result.current.browserFullscreenIssue, null);
  assert.equal(result.current.isImmersive, true);
});

test('the browser ending a fullscreen kept inside the window ends immersive mode and its reason', async () => {
  vi.useFakeTimers();
  stubWindowDisplayMode(CHROME_UA, false);
  const { result } = renderHook(() => useImmersiveMode());
  await enterOrLeave(result.current.toggleImmersive);
  advanceTime(3000);
  assert.equal(result.current.browserFullscreenIssue?.reason, 'inWindow');

  // Escape held: the browser leaves the fullscreen it kept inside the window.
  act(() => {
    showFullscreen(null);
  });

  assert.equal(result.current.isImmersive, false);
  assert.equal(result.current.browserFullscreenIssue, null);
});

test('a stale grant neither waits on the window nor clears anything for the newer request', async () => {
  vi.useFakeTimers();
  const displayMode = stubWindowDisplayMode(CHROME_UA, false);
  const pending: Deferred[] = [];
  requestFullscreen.mockImplementation(() => new Promise<void>((resolve, reject) => {
    pending.push({
      resolve: () => {
        showFullscreen(document.documentElement);
        resolve();
      },
      reject,
    });
  }));
  const { result } = renderHook(() => useImmersiveMode());

  // Left and entered again before the browser answered the first request.
  await enterOrLeave(result.current.toggleImmersive);
  await enterOrLeave(result.current.toggleImmersive);
  await enterOrLeave(result.current.toggleImmersive);
  await act(async () => {
    pending[0].resolve();
  });
  assert.equal(vi.getTimerCount(), 0);
  assert.equal(displayMode.listeners.size, 0);

  // The newer request's own grant starts the wait.
  await act(async () => {
    pending[1].resolve();
  });
  assert.equal(vi.getTimerCount(), 1);
  assert.equal(displayMode.listeners.size, 1);
});
