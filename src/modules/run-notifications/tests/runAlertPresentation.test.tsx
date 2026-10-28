import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useRunAlertPresentation } from '@/modules/run-notifications/hooks/useRunAlertPresentation';
import type { RunAlert, RunAlertOutcome } from '@/shared/types';
import { setDocumentPageTitle } from '@/shared/utils';

/**
 * A finished run shows in the tab title, blinking while the user is away and clearing 2 s after they are back,
 * failed first and counted per kind ("[Done 2] X"), and as a banner, newest first, that goes after 8 s of being
 * visible. A banner waits while the tab is hidden, pauses while hovered, is skipped for a session in front of the
 * user, and goes when another tab has seen its alert.
 */

const SEEN_STORAGE_KEY = 'cloudcli:run-alerts:seen';

// A language switch saves the choice to the server; it must not reach the network.
vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));

// The page state the hook reads: document.visibilityState and document.hasFocus(), which jsdom pins.
const pageState = { visible: true, focused: false };

type PresentationProps = { bannersEnabled: boolean; onScreenSessionIds: ReadonlySet<string> };

const NOTHING_ON_SCREEN: ReadonlySet<string> = new Set();

const renderPresentation = (initialProps: PresentationProps = { bannersEnabled: true, onScreenSessionIds: NOTHING_ON_SCREEN }) =>
  renderHook((props: PresentationProps) => useRunAlertPresentation(props), { initialProps });

/** Moves the page to a new state and fires the events the browser would. */
const setPage = (next: { visible: boolean; focused: boolean }) => {
  act(() => {
    pageState.visible = next.visible;
    pageState.focused = next.focused;
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event(next.focused ? 'focus' : 'blur'));
  });
};

const advance = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

const alertOf = (sessionId: string, outcome: RunAlertOutcome = 'done', runStartedAt = 1000): RunAlert => ({
  key: `${sessionId}:${runStartedAt}:${outcome === 'backgroundDone' ? 'background' : 'turn'}`,
  sessionId,
  outcome,
  title: `Title ${sessionId}`,
  projectName: null,
  provider: 'claude',
  receivedAt: runStartedAt,
  isCatchUp: false,
});

const readSeenKeys = (): string[] => Object.keys(JSON.parse(localStorage.getItem(SEEN_STORAGE_KEY) ?? '{}') as object);

const bannerSessions = (banners: RunAlert[]) => banners.map((banner) => banner.sessionId);

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  pageState.visible = true;
  pageState.focused = false;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (pageState.visible ? 'visible' : 'hidden'),
  });
  vi.spyOn(document, 'hasFocus').mockImplementation(() => pageState.focused);
  setDocumentPageTitle('Page');
});

afterEach(() => {
  vi.useRealTimers();
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

test('while the user is away the title alert blinks every second', () => {
  const view = renderPresentation();

  act(() => view.result.current.present(alertOf('a')));
  assert.equal(document.title, '[Done] Title a');
  advance(1000);
  assert.equal(document.title, 'Page');
  advance(1000);
  assert.equal(document.title, '[Done] Title a');
  advance(1000);
  assert.equal(document.title, 'Page');
  assert.deepEqual(readSeenKeys(), []);
});

test('with the user on the tab it stays still for 2 s, then clears and counts as seen', () => {
  setPage({ visible: true, focused: true });
  const view = renderPresentation();

  act(() => view.result.current.present(alertOf('a')));
  assert.equal(document.title, '[Done] Title a');
  advance(1999);
  assert.equal(document.title, '[Done] Title a');
  assert.deepEqual(readSeenKeys(), []);

  advance(1);
  assert.equal(document.title, 'Page');
  assert.deepEqual(readSeenKeys(), ['a:1000:turn']);
});

test('leaving within the 2 s cancels the clearing and the blinking resumes', () => {
  setPage({ visible: true, focused: true });
  const view = renderPresentation();
  act(() => view.result.current.present(alertOf('a')));
  advance(1500);

  setPage({ visible: true, focused: false });
  assert.equal(document.title, '[Done] Title a');
  advance(1000);
  assert.equal(document.title, 'Page');
  advance(1000);
  assert.equal(document.title, '[Done] Title a');
  advance(10_000);
  assert.deepEqual(readSeenKeys(), []);

  // Back for good: 2 s later it is seen.
  setPage({ visible: true, focused: true });
  assert.equal(document.title, '[Done] Title a');
  advance(2000);
  assert.equal(document.title, 'Page');
  assert.deepEqual(readSeenKeys(), ['a:1000:turn']);
});

test('failed comes first, and each kind counts its unread alerts', () => {
  const view = renderPresentation();

  act(() => view.result.current.present(alertOf('a')));
  act(() => view.result.current.present(alertOf('b', 'backgroundDone')));
  assert.equal(document.title, '[Done 2] Title b');

  act(() => view.result.current.present(alertOf('c', 'replied')));
  assert.equal(document.title, '[Done 2] Title b');

  act(() => view.result.current.present(alertOf('d', 'failed')));
  assert.equal(document.title, '[Failed] Title d');
});

test('the title follows the interface language', async () => {
  const { i18n } = await import('@/modules/i18n');
  const view = renderPresentation();
  act(() => view.result.current.present(alertOf('a')));
  act(() => view.result.current.present(alertOf('b')));

  try {
    await act(async () => {
      await i18n.changeLanguage('zh-CN');
    });
    assert.equal(document.title, '[完成 2] Title b');
  } finally {
    // English again for the tests after this one, also when the assertion above fails.
    view.unmount();
    await i18n.changeLanguage('en');
  }
});

test('no banner for a session on screen while the user is on the tab', () => {
  setPage({ visible: true, focused: true });
  const view = renderPresentation({ bannersEnabled: true, onScreenSessionIds: new Set(['a']) });

  act(() => view.result.current.present(alertOf('a')));
  act(() => view.result.current.present(alertOf('b')));
  assert.deepEqual(bannerSessions(view.result.current.banners), ['b']);
  // The title still says it.
  assert.equal(document.title, '[Done 2] Title b');

  // Away from the tab, the same session does get one.
  setPage({ visible: true, focused: false });
  act(() => view.result.current.present(alertOf('a', 'done', 2000)));
  assert.deepEqual(bannerSessions(view.result.current.banners), ['a', 'b']);
});

test('banners that come while the tab is hidden wait, and on return the ones on screen are dropped', () => {
  setPage({ visible: false, focused: false });
  const view = renderPresentation({ bannersEnabled: true, onScreenSessionIds: new Set(['a']) });

  act(() => view.result.current.present(alertOf('a')));
  act(() => view.result.current.present(alertOf('b')));
  assert.deepEqual(bannerSessions(view.result.current.banners), []);
  // Hidden time does not count.
  advance(60_000);

  setPage({ visible: true, focused: true });
  assert.deepEqual(bannerSessions(view.result.current.banners), ['b']);
});

test('a banner goes after 8 s of being visible, unseen; hovering and hidden time do not count', () => {
  const view = renderPresentation();
  act(() => view.result.current.present(alertOf('a')));

  advance(3000);
  act(() => view.result.current.setBannersHovered(true));
  advance(30_000);
  act(() => view.result.current.setBannersHovered(false));
  setPage({ visible: false, focused: false });
  advance(30_000);
  setPage({ visible: true, focused: false });

  advance(4999);
  assert.deepEqual(bannerSessions(view.result.current.banners), ['a']);
  advance(1);
  assert.deepEqual(bannerSessions(view.result.current.banners), []);
  assert.deepEqual(readSeenKeys(), []);
});

test('newest first, at most 20 banners kept', () => {
  const view = renderPresentation();
  for (let index = 1; index <= 22; index += 1) {
    act(() => view.result.current.present(alertOf(`s${index}`)));
  }

  const sessions = bannerSessions(view.result.current.banners);
  assert.equal(sessions.length, 20);
  assert.equal(sessions[0], 's22');
  assert.equal(sessions[19], 's3');
});

test('alerts another tab marks seen go here too, shown banners included', () => {
  const view = renderPresentation();
  act(() => view.result.current.present(alertOf('a')));
  act(() => view.result.current.present(alertOf('b')));

  act(() => {
    window.dispatchEvent(new StorageEvent('storage', {
      key: SEEN_STORAGE_KEY,
      oldValue: null,
      newValue: JSON.stringify({ 'a:1000:turn': Date.now() }),
    }));
  });

  assert.deepEqual(bannerSessions(view.result.current.banners), ['b']);
  assert.equal(document.title, '[Done] Title b');
});

test('a session brought on screen while the user is on the tab loses its alerts, marked seen', () => {
  setPage({ visible: true, focused: true });
  const view = renderPresentation();
  act(() => view.result.current.present(alertOf('a')));
  act(() => view.result.current.present(alertOf('b')));
  assert.deepEqual(bannerSessions(view.result.current.banners), ['b', 'a']);

  view.rerender({ bannersEnabled: true, onScreenSessionIds: new Set(['a']) });

  assert.deepEqual(bannerSessions(view.result.current.banners), ['b']);
  assert.equal(document.title, '[Done] Title b');
  assert.deepEqual(readSeenKeys(), ['a:1000:turn']);
});

test('dismissing a banner, opening it or dismissing them all marks those alerts seen', () => {
  const view = renderPresentation();
  ['a', 'b', 'c', 'd'].forEach((sessionId) => act(() => view.result.current.present(alertOf(sessionId))));

  act(() => view.result.current.dismissBanner('a:1000:turn'));
  act(() => view.result.current.openBanner('b:1000:turn'));
  assert.deepEqual(bannerSessions(view.result.current.banners), ['d', 'c']);
  assert.deepEqual(readSeenKeys(), ['a:1000:turn', 'b:1000:turn']);

  act(() => view.result.current.dismissAllBanners());
  assert.deepEqual(bannerSessions(view.result.current.banners), []);
  assert.deepEqual(readSeenKeys().sort(), ['a:1000:turn', 'b:1000:turn', 'c:1000:turn', 'd:1000:turn']);
  assert.equal(document.title, 'Page');
});

test('with banners off only the title shows, and turning them off takes the shown ones away', () => {
  const view = renderPresentation();
  act(() => view.result.current.present(alertOf('a')));
  assert.deepEqual(bannerSessions(view.result.current.banners), ['a']);

  view.rerender({ bannersEnabled: false, onScreenSessionIds: NOTHING_ON_SCREEN });
  assert.deepEqual(bannerSessions(view.result.current.banners), []);

  act(() => view.result.current.present(alertOf('b')));
  assert.deepEqual(bannerSessions(view.result.current.banners), []);
  assert.equal(document.title, '[Done 2] Title b');
});

test('unmounting leaves no alert in the title', () => {
  const view = renderPresentation();
  act(() => view.result.current.present(alertOf('a', 'failed')));
  assert.equal(document.title, '[Failed] Title a');

  view.unmount();
  assert.equal(document.title, 'Page');
});
