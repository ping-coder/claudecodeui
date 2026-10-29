import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * The page has one browser fullscreen and several things that maximize themselves with it. The
 * shared controller holds it for all of them: one request for the first, one exit after the last,
 * and the browser ending it ends every maximize. Each test loads the controller afresh (its state
 * is per page load) and plays the browser by hand, as jsdom has no Fullscreen API.
 */

let fullscreenElement: Element | null = null;
let requestFullscreen = vi.fn<(options?: FullscreenOptions) => Promise<void>>();
let exitFullscreen = vi.fn<() => Promise<void>>();
let keyboard = { lock: vi.fn<(keyCodes?: string[]) => Promise<void>>(), unlock: vi.fn<() => void>() };
let fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const defineOwn = (target: object, key: string, value: unknown) => {
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
};

const showFullscreen = (element: Element | null) => {
  fullscreenElement = element;
  document.dispatchEvent(new Event('fullscreenchange'));
};

/** A Chromium window whose display mode and size the test sets; the screen is 1512×982. */
const stubChromiumWindow = ({ fullscreen, outer }: { fullscreen: boolean; outer: [number, number] }) => {
  defineOwn(navigator, 'userAgent', CHROME_UA);
  const listeners = new Set<() => void>();
  const query = {
    matches: fullscreen,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  defineOwn(window, 'matchMedia', (text: string) => (text === '(display-mode: fullscreen)' ? query : { matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  defineOwn(window, 'outerWidth', outer[0]);
  defineOwn(window, 'outerHeight', outer[1]);
  defineOwn(window.screen, 'width', 1512);
  defineOwn(window.screen, 'height', 982);
  return {
    listeners,
    resizeWindow: (width: number, height: number) => {
      defineOwn(window, 'outerWidth', width);
      defineOwn(window, 'outerHeight', height);
      window.dispatchEvent(new Event('resize'));
    },
  };
};

const setupMatchMedia = window.matchMedia;

beforeEach(() => {
  vi.resetModules();
  fullscreenElement = null;
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true });
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
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
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  const stubbed: Array<[object, string]> = [
    [document, 'fullscreenEnabled'],
    [document, 'fullscreenElement'],
    [document, 'exitFullscreen'],
    [document.documentElement, 'requestFullscreen'],
    [navigator, 'keyboard'],
    [navigator, 'userAgent'],
    [window, 'isSecureContext'],
    [window, 'outerWidth'],
    [window, 'outerHeight'],
    [window.screen, 'width'],
    [window.screen, 'height'],
    [window, 'cloudcliDesktopNotifications'],
  ];
  for (const [target, key] of stubbed) {
    Reflect.deleteProperty(target, key);
  }
  defineOwn(window, 'matchMedia', setupMatchMedia);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const loadHooks = () => import('@/shared/hooks/useBrowserFullscreen');

/** The reports sent so far, as parsed bodies. */
const reports = () => fetchMock.mock.calls
  .filter(([url]) => url === '/api/system/client-diagnostics')
  .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);

const flush = () => act(async () => undefined);

test('two holders share one request, and only the last one leaving exits the browser fullscreen', async () => {
  const { useBrowserFullscreen } = await loadHooks();
  const workspace = renderHook(() => useBrowserFullscreen({ source: 'workspace' }));
  const editor = renderHook(() => useBrowserFullscreen({ source: 'codeEditor' }));

  await act(async () => workspace.result.current.enter());
  await act(async () => editor.result.current.enter());
  assert.equal(requestFullscreen.mock.calls.length, 1);
  assert.equal(editor.result.current.isBrowserFullscreen, true);

  await act(async () => editor.result.current.exit());
  assert.equal(exitFullscreen.mock.calls.length, 0);
  assert.equal(workspace.result.current.isBrowserFullscreen, true);

  await act(async () => workspace.result.current.exit());
  assert.equal(exitFullscreen.mock.calls.length, 1);
});

test('a new first holder does not wait on a request every earlier holder left: it asks again', async () => {
  // The first request is never answered (a permission prompt left open, say).
  requestFullscreen.mockImplementationOnce(() => new Promise<void>(() => undefined));
  const { useBrowserFullscreen } = await loadHooks();
  const prd = renderHook(() => useBrowserFullscreen({ source: 'prdEditor' }));
  const editor = renderHook(() => useBrowserFullscreen({ source: 'codeEditor' }));

  await act(async () => prd.result.current.enter());
  await act(async () => prd.result.current.exit());
  await act(async () => editor.result.current.enter());

  assert.equal(requestFullscreen.mock.calls.length, 2);
  assert.equal(editor.result.current.isBrowserFullscreen, true);
});

test('the browser ending the fullscreen ends every holder\'s maximize', async () => {
  const { useBrowserFullscreen } = await loadHooks();
  const workspace = renderHook(() => useBrowserFullscreen({ source: 'workspace' }));
  const editor = renderHook(() => useBrowserFullscreen({ source: 'codeEditor' }));
  await act(async () => workspace.result.current.enter());
  await act(async () => editor.result.current.enter());

  act(() => {
    showFullscreen(null);
  });

  assert.equal(workspace.result.current.isMaximized, false);
  assert.equal(editor.result.current.isMaximized, false);
  assert.equal(keyboard.unlock.mock.calls.length, 1);
  assert.equal(exitFullscreen.mock.calls.length, 0);
});

test('Escape is locked once for the granted fullscreen and unlocked when the last holder leaves', async () => {
  const { useBrowserFullscreen } = await loadHooks();
  const editor = renderHook(() => useBrowserFullscreen({ source: 'codeEditor' }));
  const workspace = renderHook(() => useBrowserFullscreen({ source: 'workspace' }));

  await act(async () => editor.result.current.enter());
  assert.equal(keyboard.lock.mock.calls.length, 1);
  assert.deepEqual(keyboard.lock.mock.calls[0][0], ['Escape']);
  await act(async () => workspace.result.current.enter());
  await act(async () => editor.result.current.exit());
  // Immersive mode still holds the page fullscreen, Escape still locked.
  assert.equal(keyboard.lock.mock.calls.length, 1);
  assert.equal(keyboard.unlock.mock.calls.length, 0);
  assert.equal(exitFullscreen.mock.calls.length, 0);
  await act(async () => workspace.result.current.exit());
  assert.equal(keyboard.unlock.mock.calls.length, 1);
  assert.equal(exitFullscreen.mock.calls.length, 1);
});

test('a maximized editor, PRD editor or preview is an overlay that owns Escape; immersive mode is not', async () => {
  const { useBrowserFullscreen } = await loadHooks();
  const { hasMaximizedOverlay } = await import('@/shared/browserFullscreen');
  const workspace = renderHook(() => useBrowserFullscreen({ source: 'workspace' }));
  const browserUse = renderHook(() => useBrowserFullscreen({ source: 'browserUse' }));

  await act(async () => workspace.result.current.enter());
  assert.equal(hasMaximizedOverlay(), false);
  await act(async () => browserUse.result.current.enter());
  assert.equal(hasMaximizedOverlay(), true);
  await act(async () => browserUse.result.current.exit());
  assert.equal(hasMaximizedOverlay(), false);
});

test('a refused request keeps the CSS maximize, says why, and the next holder\'s gesture asks again', async () => {
  requestFullscreen.mockImplementationOnce(async () => {
    throw new TypeError('not granted');
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { useBrowserFullscreen, useBrowserFullscreenIssue } = await loadHooks();
  const prd = renderHook(() => useBrowserFullscreen({ source: 'prdEditor' }));
  const notice = renderHook(() => useBrowserFullscreenIssue());

  await act(async () => prd.result.current.enter());
  assert.equal(prd.result.current.isMaximized, true);
  assert.equal(prd.result.current.isBrowserFullscreen, false);
  assert.deepEqual(notice.result.current.issue, { reason: 'refused', detail: 'not granted' });
  await flush();
  assert.equal(reports().at(-1)?.outcome, 'refused');
  assert.equal(reports().at(-1)?.detail, 'not granted');

  const browserUse = renderHook(() => useBrowserFullscreen({ source: 'browserUse' }));
  await act(async () => browserUse.result.current.enter());
  assert.equal(requestFullscreen.mock.calls.length, 2);
  assert.equal(notice.result.current.issue, null);
  assert.equal(prd.result.current.isBrowserFullscreen, true);
});

test('a fullscreen window smaller than the screen (Split View) is reported with both sizes after the wait', async () => {
  vi.useFakeTimers();
  stubChromiumWindow({ fullscreen: true, outer: [756, 982] });
  const { useBrowserFullscreen, useBrowserFullscreenIssue } = await loadHooks();
  const workspace = renderHook(() => useBrowserFullscreen({ source: 'workspace' }));
  const notice = renderHook(() => useBrowserFullscreenIssue());

  await act(async () => workspace.result.current.enter());
  act(() => {
    vi.advanceTimersByTime(2999);
  });
  assert.equal(notice.result.current.issue, null);
  act(() => {
    vi.advanceTimersByTime(1);
  });

  assert.deepEqual(notice.result.current.issue, {
    reason: 'inWindow',
    kind: 'partial',
    window: { width: 756, height: 982 },
    screen: { width: 1512, height: 982 },
  });
  assert.equal(vi.getTimerCount(), 0);
});

test('the black band above a notch is tolerated, and a window that grows to the screen in time is not reported', async () => {
  vi.useFakeTimers();
  const chromium = stubChromiumWindow({ fullscreen: true, outer: [1512, 945] });
  const { useBrowserFullscreen, useBrowserFullscreenIssue } = await loadHooks();
  const workspace = renderHook(() => useBrowserFullscreen({ source: 'workspace' }));
  const notice = renderHook(() => useBrowserFullscreenIssue());

  // 37 points short of the screen: the whole screen at once, nothing to wait for.
  await act(async () => workspace.result.current.enter());
  assert.equal(vi.getTimerCount(), 0);
  await act(async () => workspace.result.current.exit());

  // Still animating at the grant: the resize at the end settles it.
  chromium.resizeWindow(1200, 800);
  await act(async () => workspace.result.current.enter());
  assert.equal(vi.getTimerCount(), 1);
  act(() => {
    chromium.resizeWindow(1512, 982);
  });
  assert.equal(vi.getTimerCount(), 0);
  act(() => {
    vi.advanceTimersByTime(5000);
  });
  assert.equal(notice.result.current.issue, null);
});

test('a screen reported upright while the device lies sideways (iPad) is turned before the comparison', async () => {
  vi.useFakeTimers();
  defineOwn(navigator, 'userAgent', 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
  defineOwn(window, 'outerWidth', 1180);
  defineOwn(window, 'outerHeight', 820);
  defineOwn(window.screen, 'width', 820);
  defineOwn(window.screen, 'height', 1180);
  const { useBrowserFullscreen, useBrowserFullscreenIssue } = await loadHooks();
  const workspace = renderHook(() => useBrowserFullscreen({ source: 'workspace' }));
  const notice = renderHook(() => useBrowserFullscreenIssue());

  await act(async () => workspace.result.current.enter());
  assert.equal(vi.getTimerCount(), 0);
  await flush();
  assert.equal(reports().at(-1)?.outcome, 'whole');
  // The report keeps what the browser said.
  assert.deepEqual(reports().at(-1)?.screen, [820, 1180]);
  act(() => {
    vi.advanceTimersByTime(5000);
  });
  assert.equal(notice.result.current.issue, null);
});

test('leaving before the window settles reports what it looked like', async () => {
  vi.useFakeTimers();
  stubChromiumWindow({ fullscreen: false, outer: [1200, 800] });
  const { useBrowserFullscreen } = await loadHooks();
  const editor = renderHook(() => useBrowserFullscreen({ source: 'codeEditor' }));

  await act(async () => editor.result.current.enter());
  await act(async () => editor.result.current.exit());
  await flush();

  const last = reports().at(-1);
  assert.equal(last?.outcome, 'interrupted');
  assert.equal(last?.kind, 'tab');
  assert.equal(last?.source, 'codeEditor');
});

test('the desktop app gets the CSS maximize without a notice, and each try is reported', async () => {
  defineOwn(window, 'cloudcliDesktopNotifications', {});
  const { useBrowserFullscreen, useBrowserFullscreenIssue } = await loadHooks();
  const workspace = renderHook(() => useBrowserFullscreen({ source: 'workspace' }));
  const notice = renderHook(() => useBrowserFullscreenIssue());

  await act(async () => workspace.result.current.enter());
  assert.equal(requestFullscreen.mock.calls.length, 0);
  assert.equal(workspace.result.current.isMaximized, true);
  assert.equal(notice.result.current.issue, null);
  await act(async () => workspace.result.current.exit());
  await act(async () => workspace.result.current.enter());
  await flush();
  assert.deepEqual(reports().map((report) => `${report.outcome}/${report.cause}`), ['unavailable/desktopApp', 'unavailable/desktopApp']);
});

test('a browser without the API is explained once per page load and reported every time', async () => {
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => false });
  const { useBrowserFullscreen, useBrowserFullscreenIssue } = await loadHooks();
  const editor = renderHook(() => useBrowserFullscreen({ source: 'codeEditor' }));
  const notice = renderHook(() => useBrowserFullscreenIssue());

  await act(async () => editor.result.current.enter());
  assert.equal(requestFullscreen.mock.calls.length, 0);
  assert.deepEqual(notice.result.current.issue, { reason: 'unavailable', cause: 'noApi' });
  act(() => notice.result.current.dismiss());
  await act(async () => editor.result.current.exit());
  await act(async () => editor.result.current.enter());
  assert.equal(notice.result.current.issue, null);
  await flush();
  assert.equal(reports().filter((report) => report.cause === 'noApi').length, 2);
});

test('a whole-screen grant is reported once, without the page address', async () => {
  stubChromiumWindow({ fullscreen: true, outer: [1512, 982] });
  const { useBrowserFullscreen } = await loadHooks();
  const workspace = renderHook(() => useBrowserFullscreen({ source: 'workspace' }));

  await act(async () => workspace.result.current.enter());
  await flush();

  const sent = reports();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].outcome, 'whole');
  assert.equal(sent[0].source, 'workspace');
  assert.deepEqual(sent[0].screen, [1512, 982]);
  assert.equal(JSON.stringify(sent[0]).includes(window.location.host || 'localhost'), false);
});
