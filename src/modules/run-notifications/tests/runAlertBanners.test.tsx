import assert from 'node:assert/strict';

import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import RunAlertBanners from '@/modules/run-notifications/RunAlertBanners';
import type { RunAlert, RunAlertOutcome } from '@/shared/types';

/**
 * The banners are a stack portaled into body, newest on top, as many cards as the placement shows and a
 * "N more · Dismiss all" line for the rest. Only "Open" opens a session, and no button answers in the first
 * 400 ms of a card; the close button and a sideways swipe dismiss one. A polite live region reads each new
 * banner out, and nothing in the stack is a dialog, menu or alert that would catch Escape or the focus.
 */

// A language switch saves the choice to the server; it must not reach the network.
vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));

type BannersProps = ComponentProps<typeof RunAlertBanners>;

// What the stack reported through its callbacks, in order.
const reported = {
  opened: [] as string[],
  dismissed: [] as string[],
  dismissAll: 0,
  enableSystem: 0,
  hover: [] as boolean[],
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

/** Newest first, as the presentation hands them over. */
const NEWEST_FIRST = ['e', 'd', 'c', 'b', 'a'].map((sessionId) => alertOf(sessionId));

// The same functions on every render, as RunNotifications passes them, so a rerender changes only what a test changes.
const CALLBACKS: Pick<
  BannersProps,
  'onOpen' | 'onDismiss' | 'onDismissAll' | 'onEnableSystemNotifications' | 'onHoverChange'
> = {
  onOpen: (alert) => reported.opened.push(alert.key),
  onDismiss: (alertKey) => reported.dismissed.push(alertKey),
  onDismissAll: () => {
    reported.dismissAll += 1;
  },
  onEnableSystemNotifications: () => {
    reported.enableSystem += 1;
  },
  onHoverChange: (hovered) => reported.hover.push(hovered),
};

const propsWith = (overrides: Partial<BannersProps> = {}): BannersProps => ({
  banners: NEWEST_FIRST,
  maxVisible: 3,
  placement: 'desktop',
  showSystemNotificationCta: false,
  ...CALLBACKS,
  ...overrides,
});

const renderBanners = (overrides: Partial<BannersProps> = {}) => render(<RunAlertBanners {...propsWith(overrides)} />);

const stack = () => screen.getByRole('region', { name: 'Task notifications' });
const cardTitles = () => screen.queryAllByRole('article').map((card) => card.getAttribute('aria-label'));
const card = (title: string) => screen.getByRole('article', { name: title });
const hasText = (text: string) => screen.queryByText(text) !== null;
/** The stack's top offset, read loosely: jsdom reorders the terms of a calc() with env() in it. */
const readStackTop = () => {
  const top = stack().style.top;
  const offset = ['3.5rem', '6rem'].find((value) => top.includes(value)) ?? 'no offset';
  return top.includes('safe-area-inset-top') ? `${offset} below the safe area` : `${offset} from the edge`;
};

/** Lets the cards' 400 ms click guard pass. */
const armCards = () => {
  act(() => {
    vi.advanceTimersByTime(400);
  });
};

/** jsdom has no PointerEvent: build the event and give it the fields React reads. */
const firePointer = (element: Element, type: 'pointerDown' | 'pointerMove' | 'pointerUp', clientX: number) => {
  const event = createEvent[type](element);
  Object.defineProperties(event, {
    clientX: { value: clientX },
    button: { value: 0 },
    pointerId: { value: 1 },
  });
  fireEvent(element, event);
};

const swipe = (element: Element, distancePx: number) => {
  firePointer(element, 'pointerDown', 100);
  firePointer(element, 'pointerMove', 100 + distancePx / 2);
  firePointer(element, 'pointerUp', 100 + distancePx);
};

beforeEach(() => {
  vi.useFakeTimers();
  reported.opened.length = 0;
  reported.dismissed.length = 0;
  reported.dismissAll = 0;
  reported.enableSystem = 0;
  reported.hover.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

test('the stack is portaled into body, out of the workspace\'s own tree', () => {
  const view = renderBanners();

  const section = stack();
  assert.equal(section.parentElement === document.body, true);
  assert.equal(view.container.contains(section), false);
  assert.equal(section.className.includes('fixed'), true);
  assert.equal(section.className.includes('z-40'), true);
  // Clicks go through the stack between its cards.
  assert.equal(section.className.includes('pointer-events-none'), true);
  assert.equal(screen.getAllByRole('article').every((element) => element.className.includes('pointer-events-auto')), true);
});

test('newest on top: three cards on desktop, one on a phone, and a line for the rest', () => {
  const view = renderBanners();
  assert.deepEqual(cardTitles(), ['Title e', 'Title d', 'Title c']);
  assert.equal(hasText('2 more'), true);
  assert.equal(stack().className.includes('right-4 w-[22rem]'), true);
  assert.equal(readStackTop(), '6rem below the safe area');

  fireEvent.click(screen.getByRole('button', { name: 'Dismiss all' }));
  assert.equal(reported.dismissAll, 1);

  view.rerender(<RunAlertBanners {...propsWith({ maxVisible: 1, placement: 'phone' })} />);
  assert.deepEqual(cardTitles(), ['Title e']);
  assert.equal(hasText('4 more'), true);
  assert.equal(stack().className.includes('inset-x-3'), true);
  assert.equal(readStackTop(), '6rem below the safe area');

  // Phone immersive mode: below the exit capsule instead of the two-row header.
  view.rerender(<RunAlertBanners {...propsWith({ maxVisible: 1, placement: 'phoneImmersive' })} />);
  assert.equal(readStackTop(), '3.5rem below the safe area');

  // Everything fits: no line.
  view.rerender(<RunAlertBanners {...propsWith({ banners: NEWEST_FIRST.slice(0, 2) })} />);
  assert.deepEqual(cardTitles(), ['Title e', 'Title d']);
  assert.equal(screen.queryByRole('button', { name: 'Dismiss all' }) === null, true);
});

test('each card names the session, how it ended and its project', () => {
  renderBanners({
    banners: [
      alertOf('a', { projectName: 'Alpha' }),
      alertOf('b', { outcome: 'replied' }),
      alertOf('c', { outcome: 'backgroundDone' }),
      alertOf('d', { outcome: 'failed', projectName: 'Delta' }),
    ],
    maxVisible: 4,
  });

  assert.equal(hasText('Done · Alpha'), true);
  assert.equal(hasText('Replied, background work still running'), true);
  assert.equal(hasText('Background work finished'), true);
  assert.equal(hasText('Failed · Delta'), true);
});

test('the card body opens nothing, and its buttons answer only 400 ms after it appeared', () => {
  renderBanners();
  const top = card('Title e');

  fireEvent.click(top);
  fireEvent.click(within(top).getByRole('button', { name: 'Open Title e' }));
  fireEvent.click(within(top).getByRole('button', { name: 'Dismiss' }));
  act(() => {
    vi.advanceTimersByTime(399);
  });
  fireEvent.click(within(top).getByRole('button', { name: 'Open Title e' }));
  assert.deepEqual(reported.opened, []);
  assert.deepEqual(reported.dismissed, []);

  act(() => {
    vi.advanceTimersByTime(1);
  });
  fireEvent.click(top);
  assert.deepEqual(reported.opened, []);
  fireEvent.click(within(top).getByRole('button', { name: 'Open Title e' }));
  assert.deepEqual(reported.opened, ['e:1000:turn']);
});

test('the close button and a sideways swipe of 64 px dismiss a card', () => {
  renderBanners();
  armCards();

  fireEvent.click(within(card('Title d')).getByRole('button', { name: 'Dismiss' }));
  assert.deepEqual(reported.dismissed, ['d:1000:turn']);

  // Too short a swipe springs back.
  swipe(card('Title e'), 63);
  assert.deepEqual(reported.dismissed, ['d:1000:turn']);
  swipe(card('Title e'), -64);
  assert.deepEqual(reported.dismissed, ['d:1000:turn', 'e:1000:turn']);

  // A press that starts on a button is a click, never a swipe.
  swipe(within(card('Title c')).getByRole('button', { name: 'Open Title c' }), 200);
  assert.deepEqual(reported.dismissed, ['d:1000:turn', 'e:1000:turn']);
});

test('a polite live region reads the newest banner out, once', () => {
  const view = renderBanners({ banners: [alertOf('a', { outcome: 'failed' })] });
  const liveRegion = screen.getByRole('status');
  assert.equal(liveRegion.getAttribute('aria-live'), 'polite');
  assert.equal(liveRegion.textContent, 'Failed: Title a');

  view.rerender(<RunAlertBanners {...propsWith({ banners: [alertOf('b'), alertOf('a', { outcome: 'failed' })] })} />);
  assert.equal(screen.getByRole('status').textContent, 'Done: Title b');

  // The newer one dismissed, the older one on top again is not read a second time.
  view.rerender(<RunAlertBanners {...propsWith({ banners: [alertOf('a', { outcome: 'failed' })] })} />);
  assert.equal(screen.getByRole('status').textContent, 'Done: Title b');

  // The region stays in place with no banner, so the next one is heard.
  view.rerender(<RunAlertBanners {...propsWith({ banners: [] })} />);
  assert.equal(screen.queryByRole('status') === null, false);
});

test('nothing in the stack catches Escape or the focus', () => {
  renderBanners({ showSystemNotificationCta: true });

  const section = stack();
  const blockingSelector = '[data-escape-layer], [aria-modal], [role="menu"], [role="alert"], [role="alertdialog"], [role="dialog"]';
  assert.equal(section.matches(blockingSelector), false);
  assert.equal(section.querySelectorAll(blockingSelector).length, 0);
  assert.equal(document.activeElement === document.body, true);
});

test('the system-notification prompt sits on the top card only and reports a click', () => {
  const view = renderBanners({ showSystemNotificationCta: true });

  const prompts = screen.getAllByRole('button', { name: 'Turn on system notifications' });
  assert.equal(prompts.length, 1);
  assert.equal(card('Title e').contains(prompts[0]), true);

  fireEvent.click(prompts[0]);
  assert.equal(reported.enableSystem, 0);
  armCards();
  fireEvent.click(prompts[0]);
  assert.equal(reported.enableSystem, 1);

  view.rerender(<RunAlertBanners {...propsWith({ showSystemNotificationCta: false })} />);
  assert.equal(screen.queryByRole('button', { name: 'Turn on system notifications' }) === null, true);
});

test('the pointer or the focus on a card pauses the stack, and a card that goes lets go of it', () => {
  const view = renderBanners();

  fireEvent.mouseEnter(card('Title e'));
  fireEvent.mouseLeave(card('Title e'));
  assert.deepEqual(reported.hover, [true, false]);

  const openButton = within(card('Title d')).getByRole('button', { name: 'Open Title d' });
  act(() => openButton.focus());
  act(() => openButton.blur());
  assert.deepEqual(reported.hover, [true, false, true, false]);

  // The hovered card is dismissed: it fires no mouseleave on its way out.
  fireEvent.mouseEnter(card('Title c'));
  view.rerender(<RunAlertBanners {...propsWith({ banners: NEWEST_FIRST.filter((alert) => alert.sessionId !== 'c') })} />);
  assert.deepEqual(reported.hover, [true, false, true, false, true, false]);
});

test('a focused button that goes while every card stays lets go of the stack', () => {
  const view = renderBanners({ showSystemNotificationCta: true });

  // Chrome and Edge focus a clicked button. Once used, the prompt unmounts under the focus, which fires no blur.
  act(() => screen.getByRole('button', { name: 'Turn on system notifications' }).focus());
  view.rerender(<RunAlertBanners {...propsWith({ showSystemNotificationCta: false })} />);
  assert.deepEqual(cardTitles(), ['Title e', 'Title d', 'Title c']);
  assert.deepEqual(reported.hover, [true, false]);

  // "Dismiss all" focused, and the banners folded into its line seen in another tab: the line goes, the cards stay.
  act(() => screen.getByRole('button', { name: 'Dismiss all' }).focus());
  view.rerender(<RunAlertBanners {...propsWith({ banners: NEWEST_FIRST.slice(0, 3) })} />);
  assert.equal(screen.queryByRole('button', { name: 'Dismiss all' }) === null, true);
  assert.deepEqual(cardTitles(), ['Title e', 'Title d', 'Title c']);
  assert.deepEqual(reported.hover, [true, false, true, false]);
});

test('the stack reads in Simplified Chinese', async () => {
  const { i18n } = await import('@/modules/i18n');
  await act(async () => {
    await i18n.changeLanguage('zh-CN');
  });

  try {
    renderBanners({
      banners: [alertOf('b', { projectName: 'Alpha' }), alertOf('a', { outcome: 'failed' })],
      maxVisible: 1,
      showSystemNotificationCta: true,
    });

    assert.equal(screen.queryByRole('region', { name: '任务通知' }) === null, false);
    assert.equal(hasText('已完成 · Alpha'), true);
    assert.equal(within(card('Title b')).getByRole('button', { name: '打开 Title b' }).textContent, '查看');
    assert.equal(screen.queryByRole('button', { name: '关闭' }) === null, false);
    assert.equal(hasText('还有 1 条'), true);
    assert.equal(screen.queryByRole('button', { name: '全部关闭' }) === null, false);
    assert.equal(screen.queryByRole('button', { name: '开启系统通知' }) === null, false);
    assert.equal(screen.getByRole('status').textContent, '已完成：Title b');
  } finally {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  }
});
