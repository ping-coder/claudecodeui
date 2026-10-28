import assert from 'node:assert/strict';

import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { WorkspaceChromeProvider } from '@/modules/project-workspace/context/WorkspaceChromeContext';
import PaneTabBar from '@/modules/project-workspace/PaneTabBar';
import type {
  PaneTabDisplay,
  Project,
  WorkspaceLayoutActions,
  WorkspacePaneState,
  WorkspaceSessionTab,
} from '@/shared/types';

/**
 * A pane's session tab bar: preview tabs in italics, middle-click / × / Delete close, a
 * double-click keeps a tab open and a double-click on the empty bar starts a new chat, a
 * roving tablist, activity marks, an "all tabs" menu once the strip overflows, and a right-click
 * menu whose items each reach the matching layout action. Split and full screen live only in the
 * rightmost visible pane's bar. Session tabs offer "Rename session" (F2) in their menu and the pane
 * menu; the rename box itself is covered by paneTabRename.test.tsx. A draft names its project after
 * its title, and so does every tab once tabs alone cannot tell the project. Tabs shrink to fit before
 * the strip scrolls, and the active tab comes back into view whenever the strip or a tab changes size.
 * jsdom has no layout: those tests read the sizing classes, or stub the sizes the browser would report.
 */

const ALPHA: Project = { projectId: 'alpha', displayName: 'Alpha', fullPath: '/repo/alpha', sessions: [] };

const makeTab = (key: string, overrides: Partial<WorkspaceSessionTab> = {}): WorkspaceSessionTab => ({
  key,
  sessionId: `session-${key}`,
  projectId: 'alpha',
  provider: 'claude',
  title: key,
  view: 'chat',
  isPreview: false,
  session: { id: `session-${key}`, __projectId: 'alpha', __provider: 'claude' },
  ...overrides,
});

const TABS = [
  makeTab('t1'),
  makeTab('t2', { isPreview: true }),
  makeTab('t3', { sessionId: null, session: null }),
  makeTab('t4'),
];
const PANE: WorkspacePaneState = { id: 'pane-left', tabs: TABS, activeTabKey: 't1', mru: ['t1'], draftActivation: 0, externalRevision: 0 };
const DISPLAY = new Map<string, PaneTabDisplay>([
  ['t1', { title: 'First chat', projectName: 'Alpha', activity: 'running' }],
  ['t2', { title: 'Second chat', projectName: 'Alpha', activity: 'attention' }],
  ['t3', { title: 'New chat', projectName: 'Alpha', activity: null }],
  ['t4', { title: 'Fourth chat', projectName: 'Alpha', activity: 'background' }],
]);

const makeActions = (): WorkspaceLayoutActions => ({
  openSession: vi.fn(),
  openSessionById: vi.fn(),
  openNewSession: vi.fn(),
  establishDraft: vi.fn(),
  activateTab: vi.fn(),
  closeTab: vi.fn(),
  closeOtherTabs: vi.fn(),
  closeTabsToRight: vi.fn(),
  closeAllTabs: vi.fn(),
  pinTab: vi.fn(),
  moveTab: vi.fn(),
  setTabView: vi.fn(),
  focusPane: vi.fn(),
  split: vi.fn(),
  toggleSplit: vi.fn(),
  closePane: vi.fn(),
  setSplitRatio: vi.fn(),
});

let actions = makeActions();
const onRenameSession = vi.fn<(sessionId: string, summary: string) => Promise<boolean>>(async () => true);
const chrome = {
  isImmersive: false,
  isBrowserFullscreen: false,
  toggleImmersive: vi.fn(),
  exitImmersive: vi.fn(),
  isSidebarPeekOpen: false,
  setSidebarPeekOpen: vi.fn(),
  canSplit: true,
};

type BarProps = ComponentProps<typeof PaneTabBar>;

const barElement = (overrides: Partial<BarProps> = {}) => (
  <PaneTabBar
    side="left"
    pane={PANE}
    tabDisplay={DISPLAY}
    actions={actions}
    newChatProject={ALPHA}
    panelId="pane-left-tabpanel"
    isFocused
    isSplit={false}
    isSideBySide={false}
    isCollapsed={false}
    hiddenPaneActivity={null}
    showWorkspaceControls
    isLeftmost
    onRenameSession={onRenameSession}
    showProjectNames={false}
    {...overrides}
  />
);

const renderBar = (overrides: Partial<BarProps> = {}, chromeOverrides: Partial<typeof chrome> = {}) => render(
  <WorkspaceChromeProvider value={{ ...chrome, ...chromeOverrides }}>{barElement(overrides)}</WorkspaceChromeProvider>,
);

const tabNamed = (title: string) => screen.getByRole('tab', { name: new RegExp(title) });

/**
 * Stands in for jsdom's missing ResizeObserver: records what every observer watches, and makes the
 * connected ones report when told to, as a browser does after a size change and once after observe().
 */
const stubResizeObserver = () => {
  type ObserverRecord = { targets: Element[]; isConnected: boolean; report: () => void };
  const records: ObserverRecord[] = [];
  vi.stubGlobal('ResizeObserver', class {
    private readonly record: ObserverRecord;

    constructor(callback: ResizeObserverCallback) {
      this.record = { targets: [], isConnected: true, report: () => callback([], this as unknown as ResizeObserver) };
      records.push(this.record);
    }

    observe(target: Element) {
      this.record.targets.push(target);
    }

    unobserve() {}

    disconnect() {
      this.record.isConnected = false;
    }
  });
  const connected = () => records.filter((record) => record.isConnected);
  return {
    /** How many observers were ever created. */
    createdCount: () => records.length,
    /** How many connected observers watch the strip and every tab now on screen. */
    countWatchingStripAndEveryTab: () => connected().filter((record) => (
      record.targets.includes(screen.getByRole('tablist', { name: 'Open tabs' }))
      && screen.getAllByRole('tab').every((tab) => record.targets.includes(tab))
    )).length,
    reportResize: () => act(() => {
      connected().forEach((record) => record.report());
    }),
  };
};

/** The strip shows viewport x 100..400 of a row of 120px tabs, which its scroll position moves. */
const STRIP_LEFT = 100;
const STRIP_WIDTH = 300;
const TAB_WIDTH = 120;
const stubStripLayout = () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function measure(this: HTMLElement) {
    let left = 0;
    let width = 0;
    if (this.getAttribute('role') === 'tablist') {
      left = STRIP_LEFT;
      width = STRIP_WIDTH;
    } else if (this.getAttribute('role') === 'tab' && this.parentElement) {
      left = STRIP_LEFT + Array.from(this.parentElement.children).indexOf(this) * TAB_WIDTH - this.parentElement.scrollLeft;
      width = TAB_WIDTH;
    }
    return { x: left, y: 0, left, top: 0, width, height: 40, right: left + width, bottom: 40, toJSON: () => ({}) } as DOMRect;
  });
};

beforeEach(() => {
  actions = makeActions();
  chrome.toggleImmersive.mockReset();
  chrome.setSidebarPeekOpen.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('a preview tab is italic and its tooltip says how to keep it open', () => {
  renderBar();

  const preview = tabNamed('Second chat');
  assert.ok(within(preview).getByText('Second chat').classList.contains('italic'));
  assert.match(preview.getAttribute('title') ?? '', /Preview · double-click to keep open/);
  assert.equal(within(tabNamed('First chat')).getByText('First chat').classList.contains('italic'), false);
});

test('a middle click closes the tab, and its press is prevented so the browser does not autoscroll', () => {
  renderBar();
  const tab = tabNamed('Fourth chat');

  const press = createEvent.mouseDown(tab, { button: 1 });
  fireEvent(tab, press);
  assert.equal(press.defaultPrevented, true);

  fireEvent(tab, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
  assert.deepEqual(vi.mocked(actions.closeTab).mock.calls, [['left', 't4']]);
});

test('a double-click keeps a tab; a double-click on the empty bar starts a new chat in the pane project', () => {
  renderBar();

  fireEvent.doubleClick(tabNamed('Second chat'));
  assert.deepEqual(vi.mocked(actions.pinTab).mock.calls, [['left', 't2']]);
  assert.equal(vi.mocked(actions.openNewSession).mock.calls.length, 0, 'a tab double-click is not a new chat');

  fireEvent.doubleClick(document.querySelector('[data-tab-bar-blank]') as HTMLElement);
  assert.deepEqual(vi.mocked(actions.openNewSession).mock.calls, [[ALPHA, { target: 'left' }]]);

  fireEvent.click(screen.getByRole('button', { name: 'New chat in Alpha' }));
  assert.equal(vi.mocked(actions.openNewSession).mock.calls.length, 2, 'the + button starts one too');
});

test('the tabs form a roving tablist: arrows, Home and End move and activate, Enter activates, Delete closes', () => {
  renderBar();
  const tabs = screen.getAllByRole('tab');

  assert.equal(screen.getByRole('tablist', { name: 'Open tabs' }).contains(tabs[0]), true);
  assert.deepEqual(tabs.map((tab) => tab.getAttribute('tabindex')), ['0', '-1', '-1', '-1']);
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  assert.ok(tabs.every((tab) => tab.getAttribute('aria-controls') === 'pane-left-tabpanel'));

  tabs[0].focus();
  fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
  assert.ok(document.activeElement === tabs[1], 'focus moves with the arrow');
  fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' });
  assert.ok(document.activeElement === tabs[3], 'and wraps around');
  fireEvent.keyDown(tabs[1], { key: 'Home' });
  fireEvent.keyDown(tabs[1], { key: 'End' });
  fireEvent.keyDown(tabs[2], { key: 'Enter' });
  fireEvent.keyDown(tabs[2], { key: ' ' });
  assert.deepEqual(vi.mocked(actions.activateTab).mock.calls, [
    ['left', 't2'],
    ['left', 't4'],
    ['left', 't1'],
    ['left', 't4'],
    ['left', 't3'],
    ['left', 't3'],
  ]);

  fireEvent.keyDown(tabs[1], { key: 'Delete' });
  assert.deepEqual(vi.mocked(actions.closeTab).mock.calls, [['left', 't2']]);
});

test('tabs mark running sessions with a spinner and attention or background work with a dot', () => {
  renderBar();

  assert.ok(within(tabNamed('First chat')).getByRole('img', { name: 'Processing session' }));
  assert.ok(within(tabNamed('Second chat')).getByRole('img', { name: 'Session needs attention' }));
  assert.ok(within(tabNamed('Fourth chat')).getByRole('img', { name: 'Background work running' }));
  assert.equal(within(tabNamed('New chat')).queryByRole('img', { name: /Processing|attention|Background/ }) === null, true, 'a draft shows no activity');
});

test('the × closes a tab without activating it', () => {
  renderBar();

  fireEvent.click(within(tabNamed('Fourth chat')).getByRole('button', { name: 'Close tab' }));

  assert.deepEqual(vi.mocked(actions.closeTab).mock.calls, [['left', 't4']]);
  assert.equal(vi.mocked(actions.activateTab).mock.calls.length, 0);
});

test('the all-tabs menu appears once the strip overflows and lists every tab', () => {
  const { unmount } = renderBar();
  assert.equal(screen.queryByRole('button', { name: 'All tabs' }) === null, true, 'no menu while every tab fits');
  unmount();

  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
  renderBar();

  fireEvent.click(screen.getByRole('button', { name: 'All tabs' }));
  const menu = screen.getByRole('menu');
  assert.deepEqual(
    within(menu).getAllByRole('menuitem').map((item) => item.textContent?.replace('Alpha', '')),
    ['First chat', 'Second chat', 'New chat', 'Fourth chat'],
  );
  fireEvent.click(within(menu).getByRole('menuitem', { name: /Fourth chat/ }));
  assert.deepEqual(vi.mocked(actions.activateTab).mock.calls, [['left', 't4']]);
});

test('every item of the right-click menu reaches its layout action', () => {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  renderBar();

  const choose = (title: string, item: string) => {
    fireEvent.contextMenu(tabNamed(title), { clientX: 40, clientY: 20 });
    const menu = screen.getByRole('menu');
    assert.ok(menu.hasAttribute('data-escape-layer'));
    fireEvent.click(within(menu).getByRole('menuitem', { name: item }));
    assert.equal(screen.queryByRole('menu') === null, true, `${item} closes the menu`);
  };

  choose('Second chat', 'Close tab');
  choose('Second chat', 'Close other tabs');
  choose('Second chat', 'Close tabs to the right');
  choose('Second chat', 'Close all tabs');
  choose('Second chat', 'Keep open');
  choose('Second chat', 'Open on the other side');
  choose('Second chat', 'Move to the other side');
  choose('Second chat', 'Copy session ID');

  assert.deepEqual(vi.mocked(actions.closeTab).mock.calls, [['left', 't2']]);
  assert.deepEqual(vi.mocked(actions.closeOtherTabs).mock.calls, [['left', 't2']]);
  assert.deepEqual(vi.mocked(actions.closeTabsToRight).mock.calls, [['left', 't2']]);
  assert.deepEqual(vi.mocked(actions.closeAllTabs).mock.calls, [['left']]);
  assert.deepEqual(vi.mocked(actions.pinTab).mock.calls, [['left', 't2']]);
  assert.deepEqual(vi.mocked(actions.moveTab).mock.calls, [
    ['left', 't2', 'right', { copy: true }],
    ['left', 't2', 'right'],
  ]);
  assert.deepEqual(writeText.mock.calls, [['session-t2']]);
  vi.unstubAllGlobals();
});

test('the menu fits the tab: no "Keep open" on a kept tab, a draft is never copied, the last tab has nothing to its right', () => {
  renderBar();

  fireEvent.contextMenu(tabNamed('Fourth chat'), { clientX: 10, clientY: 10 });
  let menu = screen.getByRole('menu');
  assert.equal(within(menu).queryByRole('menuitem', { name: 'Keep open' }) === null, true);
  assert.ok((within(menu).getByRole('menuitem', { name: 'Close tabs to the right' }) as HTMLButtonElement).disabled);
  fireEvent.pointerDown(document.body);
  assert.equal(screen.queryByRole('menu') === null, true, 'a press outside closes it');

  fireEvent.contextMenu(tabNamed('New chat'), { clientX: 10, clientY: 10 });
  menu = screen.getByRole('menu');
  assert.equal(within(menu).queryByRole('menuitem', { name: 'Open on the other side' }) === null, true);
  assert.equal(within(menu).queryByRole('menuitem', { name: 'Copy session ID' }) === null, true);
  assert.ok(within(menu).getByRole('menuitem', { name: 'Move to the other side' }));
});

test('Shift+F10 opens the menu; arrows move inside it; Escape closes it and goes no further', () => {
  renderBar();
  const tab = tabNamed('First chat');

  fireEvent.keyDown(tab, { key: 'F10', shiftKey: true });
  const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
  assert.ok(document.activeElement === items[0], 'the first item takes focus');
  fireEvent.keyDown(items[0], { key: 'ArrowDown' });
  assert.ok(document.activeElement === items[1], 'ArrowDown moves to the next item');

  const leaked = vi.fn();
  window.addEventListener('keydown', leaked);
  const escape = createEvent.keyDown(items[1], { key: 'Escape' });
  fireEvent(items[1], escape);
  window.removeEventListener('keydown', leaked);

  assert.equal(escape.defaultPrevented, true);
  assert.equal(screen.queryByRole('menu') === null, true);
  assert.equal(leaked.mock.calls.length, 0, 'the chat abort and other Escape handlers never see it');
});

test('only the rightmost visible pane carries the split and full-screen buttons', () => {
  render(
    <WorkspaceChromeProvider value={chrome}>
      <div data-testid="left-bar">{barElement({ side: 'left', isSplit: true, isSideBySide: true, showWorkspaceControls: false })}</div>
      <div data-testid="right-bar">{barElement({ side: 'right', isSplit: true, isSideBySide: true, isFocused: false, isLeftmost: false, panelId: 'pane-right-tabpanel' })}</div>
    </WorkspaceChromeProvider>,
  );
  const leftBar = screen.getByTestId('left-bar');
  const rightBar = screen.getByTestId('right-bar');

  assert.equal(within(leftBar).queryByRole('button', { name: 'Merge panes' }) === null, true);
  assert.equal(within(leftBar).queryByRole('button', { name: 'Full screen' }) === null, true);

  fireEvent.click(within(rightBar).getByRole('button', { name: 'Merge panes' }));
  fireEvent.click(within(rightBar).getByRole('button', { name: 'Full screen' }));
  assert.equal(vi.mocked(actions.toggleSplit).mock.calls.length, 1);
  assert.equal(chrome.toggleImmersive.mock.calls.length, 1);

  // Split side by side: the focused pane's active tab is underlined, the other bar is not.
  assert.ok(within(leftBar).getByRole('tab', { name: /First chat/ }).querySelector('[data-focus-accent]'));
  assert.equal(within(rightBar).getByRole('tab', { name: /First chat/ }).querySelector('[data-focus-accent]') === null, true);
});

test('unsplit and too narrow, the split button is disabled and says why', () => {
  vi.useFakeTimers();
  renderBar({}, { canSplit: false });
  const splitButton = screen.getByRole('button', { name: 'Split view' });

  assert.equal(splitButton.getAttribute('aria-disabled'), 'true');
  fireEvent.click(splitButton);
  assert.equal(vi.mocked(actions.toggleSplit).mock.calls.length, 0);

  fireEvent.mouseOver(splitButton);
  act(() => {
    vi.advanceTimersByTime(400);
  });
  assert.ok(screen.getByText('Widen the window to split'));
});

test('while immersive the leftmost pane offers the sidebar, and the full-screen button exits', () => {
  renderBar({}, { isImmersive: true });

  fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }));
  assert.deepEqual(chrome.setSidebarPeekOpen.mock.calls, [[true]]);
  assert.ok(screen.getByRole('button', { name: 'Exit full screen' }));
});

test('a pane that is not leftmost has no sidebar button even while immersive', () => {
  renderBar({ isLeftmost: false }, { isImmersive: true });

  assert.equal(screen.queryByRole('button', { name: 'Show sidebar' }) === null, true);
});

test('collapsed, the switcher marks the hidden side while it runs or needs attention', () => {
  const collapsed = { side: 'left' as const, isSplit: true, isCollapsed: true };
  const view = renderBar({ ...collapsed, hiddenPaneActivity: 'attention' });

  const hiddenSideDot = () => screen.getByRole('button', { name: 'Focus right pane' }).querySelector('[data-hidden-pane-activity]');
  assert.equal(hiddenSideDot()?.getAttribute('data-hidden-pane-activity'), 'attention');
  assert.equal(
    screen.getByRole('button', { name: 'Focus left pane' }).querySelector('[data-hidden-pane-activity]') === null,
    true,
    'the side on screen has no dot',
  );

  view.rerender(<WorkspaceChromeProvider value={chrome}>{barElement({ ...collapsed, hiddenPaneActivity: 'running' })}</WorkspaceChromeProvider>);
  assert.equal(hiddenSideDot()?.getAttribute('data-hidden-pane-activity'), 'running');

  view.rerender(<WorkspaceChromeProvider value={chrome}>{barElement({ ...collapsed, hiddenPaneActivity: null })}</WorkspaceChromeProvider>);
  assert.equal(hiddenSideDot() === null, true, 'an idle hidden pane has no dot');
});

test('a vertical wheel scrolls an overflowing strip sideways, and leaves the wheel to the page at the edge', () => {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
  const scrollLeft = vi.spyOn(Element.prototype, 'scrollLeft', 'get').mockReturnValue(0);
  renderBar();
  const strip = screen.getByRole('tablist', { name: 'Open tabs' });
  const scrollBy = vi.fn();
  strip.scrollBy = scrollBy as unknown as typeof strip.scrollBy;

  const wheel = (deltaX: number, deltaY: number) => {
    const event = new WheelEvent('wheel', { deltaX, deltaY, bubbles: true, cancelable: true });
    strip.dispatchEvent(event);
    return event;
  };

  assert.equal(wheel(0, 120).defaultPrevented, true, 'the page does not scroll while the strip takes the wheel');
  assert.deepEqual(scrollBy.mock.calls, [[{ left: 120, behavior: 'auto' }]]);

  assert.equal(wheel(80, 10).defaultPrevented, false, 'a sideways trackpad swipe scrolls natively');
  assert.equal(wheel(0, -120).defaultPrevented, false, 'at the left edge an upward wheel goes to the page');

  scrollLeft.mockReturnValue(600);
  assert.equal(wheel(0, 120).defaultPrevented, false, 'at the right edge a downward wheel goes to the page');
  assert.equal(scrollBy.mock.calls.length, 1);
});

test('tabs added in the background bring up the all-tabs menu once they overflow, without a tab switch', () => {
  const scrollWidth = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
  const view = renderBar();
  assert.equal(screen.queryByRole('button', { name: 'All tabs' }) === null, true);

  // Another tab lands behind the active one (moved over from the other pane, say): the strip now overflows.
  scrollWidth.mockReturnValue(900);
  const morePane: WorkspacePaneState = { ...PANE, tabs: [...TABS, makeTab('t5')] };
  view.rerender(<WorkspaceChromeProvider value={chrome}>{barElement({ pane: morePane })}</WorkspaceChromeProvider>);
  assert.ok(screen.getByRole('button', { name: 'All tabs' }));
});

test('unsplit, the only tab can be opened on the other side but not moved there', () => {
  const lonePane: WorkspacePaneState = { id: 'pane-left', tabs: [TABS[0]], activeTabKey: 't1', mru: ['t1'], draftActivation: 0, externalRevision: 0 };
  const view = renderBar({ pane: lonePane });

  fireEvent.contextMenu(tabNamed('First chat'), { clientX: 10, clientY: 10 });
  let menu = screen.getByRole('menu');
  assert.equal((within(menu).getByRole('menuitem', { name: 'Move to the other side' }) as HTMLButtonElement).disabled, true);
  assert.equal((within(menu).getByRole('menuitem', { name: 'Open on the other side' }) as HTMLButtonElement).disabled, false);
  fireEvent.keyDown(menu, { key: 'Escape' });

  // Split, it can move: the right pane keeps it.
  view.rerender(<WorkspaceChromeProvider value={chrome}>{barElement({ pane: lonePane, isSplit: true })}</WorkspaceChromeProvider>);
  fireEvent.contextMenu(tabNamed('First chat'), { clientX: 10, clientY: 10 });
  menu = screen.getByRole('menu');
  assert.equal((within(menu).getByRole('menuitem', { name: 'Move to the other side' }) as HTMLButtonElement).disabled, false);
});

test('the bar comes in the larger size: a 40px row, 14px tab titles up to 256px wide, 24px close buttons', () => {
  renderBar();
  const bar = document.querySelector<HTMLElement>('[data-pane-tab-bar="left"]');
  const tab = tabNamed('First chat');
  const closeButton = within(tab).getByRole('button', { name: 'Close tab' });

  assert.equal(bar?.classList.contains('h-10'), true);
  assert.equal(tab.classList.contains('text-sm'), true);
  assert.equal(tab.classList.contains('max-w-64'), true);
  assert.equal(closeButton.classList.contains('h-6'), true);
  assert.equal(closeButton.classList.contains('w-6'), true);
});

test('short of room, tabs shrink from up to 256px down to a minimum before the strip scrolls; the title truncates, the mark and × never give way', () => {
  renderBar();
  const strip = screen.getByRole('tablist', { name: 'Open tabs' });
  const tab = tabNamed('First chat');
  const title = tab.querySelector('[data-tab-title]') as HTMLElement;
  const tabEnd = tab.querySelector('[data-tab-end]') as HTMLElement;

  // One grid column per tab: the columns share the room out evenly, each between its tab's minimum and
  // what the tab wants, so a short tab stays whole while a long one truncates.
  assert.equal(strip.classList.contains('grid'), true);
  assert.equal(strip.classList.contains('grid-flow-col'), true);
  assert.equal(tab.classList.contains('flex-none'), false, 'a tab gives way');
  assert.equal(tab.classList.contains('max-w-64'), true, 'and grows back up to 256px');
  // The minimum keeps the icon, about three letters and the × (32px under a coarse pointer, so wider there).
  assert.equal(tab.classList.contains('min-w-28'), true);
  assert.equal(tab.classList.contains('[@media(pointer:coarse)]:min-w-[7.5rem]'), true);

  assert.equal(title.classList.contains('min-w-0'), true);
  assert.equal(title.classList.contains('truncate'), true, 'an ellipsis');
  assert.equal(tabEnd.classList.contains('flex-shrink-0'), true);
  assert.equal(tabEnd.classList.contains('ml-auto'), true, 'at the right edge of a short tab held at its minimum');
  assert.equal(tabEnd.contains(within(tab).getByRole('img', { name: 'Processing session' })), true);
  assert.equal(tabEnd.contains(within(tab).getByRole('button', { name: 'Close tab' })), true);
});

test('whenever the strip or a tab changes size, the active tab is scrolled back into view whole', () => {
  const resize = stubResizeObserver();
  stubStripLayout();
  const view = renderBar({ pane: { ...PANE, activeTabKey: 't4' } });
  const strip = screen.getByRole('tablist', { name: 'Open tabs' });

  assert.equal(resize.countWatchingStripAndEveryTab(), 1, 'the strip and every tab are watched');

  // The fourth tab sits at 460..580, its × past the strip's right edge at 400: its right edge comes in.
  resize.reportResize();
  assert.equal(strip.scrollLeft, 180);

  // Scrolled back by hand, the strip stays there until something changes size.
  strip.scrollLeft = 0;
  resize.reportResize();
  assert.equal(strip.scrollLeft, 180);

  // Already in view (260..380): nothing moves.
  strip.scrollLeft = 200;
  resize.reportResize();
  assert.equal(strip.scrollLeft, 200);

  // The first tab active, at -100..20, past the left edge: its left edge comes in.
  view.rerender(<WorkspaceChromeProvider value={chrome}>{barElement({ pane: { ...PANE, activeTabKey: 't1' } })}</WorkspaceChromeProvider>);
  resize.reportResize();
  assert.equal(strip.scrollLeft, 0);
});

test('tabs opening or closing are watched afresh, so the active tab comes into view; a session update keeping the tabs is not', () => {
  const resize = stubResizeObserver();
  stubStripLayout();
  const fiveTabs = [...TABS, makeTab('t5')];
  const view = renderBar({ pane: { ...PANE, activeTabKey: 't4' } });
  const rerenderWithTabs = (tabs: WorkspaceSessionTab[]) => view.rerender(
    <WorkspaceChromeProvider value={chrome}>{barElement({ pane: { ...PANE, tabs, activeTabKey: 't4' } })}</WorkspaceChromeProvider>,
  );
  const strip = screen.getByRole('tablist', { name: 'Open tabs' });
  const createdBefore = resize.createdCount();

  // A tab opens behind the active one: it is watched along with the others, and the report a browser
  // gives every new target brings the active tab (460..580, past the right edge at 400) into view.
  rerenderWithTabs(fiveTabs);
  assert.equal(resize.countWatchingStripAndEveryTab(), 1, 'the new tab is watched too');
  assert.equal(resize.createdCount(), createdBefore + 1);
  resize.reportResize();
  assert.equal(strip.scrollLeft, 180);

  // A session update rebuilds the tab list with the same tabs in the same order: no new observer, so
  // no fresh report snaps back a strip the user has scrolled.
  rerenderWithTabs(fiveTabs.map((tab) => ({ ...tab })));
  assert.equal(resize.createdCount(), createdBefore + 1);

  // A tab closes: the rest are watched afresh, and the active tab, now third (340..460 with the strip
  // scrolled back to the start), comes into view.
  strip.scrollLeft = 0;
  rerenderWithTabs(fiveTabs.filter((tab) => tab.key !== 't2'));
  assert.equal(resize.countWatchingStripAndEveryTab(), 1);
  assert.equal(resize.createdCount(), createdBefore + 2);
  resize.reportResize();
  assert.equal(strip.scrollLeft, 60);
});

test('the all-tabs menu shows only while the tabs overflow at their minimum width, and never for a lone tab', () => {
  const resize = stubResizeObserver();
  const scrollWidth = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
  const view = renderBar();
  const allTabsShown = () => screen.queryByRole('button', { name: 'All tabs' }) !== null;
  const rightFadeShown = () => document.querySelector('.bg-gradient-to-l') !== null;

  assert.equal(allTabsShown(), false, 'shrunk to fit, nothing is hidden');

  // The strip narrows past what the tabs need at their minimum width: now some are out of sight.
  scrollWidth.mockReturnValue(450);
  resize.reportResize();
  assert.equal(allTabsShown(), true);

  // Only one tab left, wider than the strip even at its minimum: it scrolls, but there is nothing to switch to.
  view.rerender(<WorkspaceChromeProvider value={chrome}>{barElement({ pane: { ...PANE, tabs: [TABS[0]], activeTabKey: 't1' } })}</WorkspaceChromeProvider>);
  assert.equal(rightFadeShown(), true);
  assert.equal(allTabsShown(), false);
});

test('only session tabs offer "Rename session" in their menu, marked with F2, below the close items', () => {
  const missingTab = makeTab('t5', { isMissing: true, session: null });
  const pane: WorkspacePaneState = { ...PANE, tabs: [...TABS, missingTab] };
  const display = new Map(DISPLAY).set('t5', { title: 'Gone chat', projectName: 'Alpha', activity: null });
  renderBar({ pane, tabDisplay: display });

  const readMenu = (title: string) => {
    fireEvent.contextMenu(tabNamed(title), { clientX: 10, clientY: 10 });
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    const renameItem = within(menu).queryByRole('menuitem', { name: 'Rename session' });
    const facts = {
      first: items[0]?.textContent ?? null,
      hasRename: renameItem !== null,
      shortcut: renameItem?.getAttribute('aria-keyshortcuts') ?? null,
      shortcutHint: renameItem?.querySelector('[aria-hidden="true"]')?.textContent ?? null,
    };
    fireEvent.keyDown(menu, { key: 'Escape' });
    return facts;
  };

  for (const title of ['First chat', 'Second chat', 'Fourth chat']) {
    assert.deepEqual(readMenu(title), { first: 'Close tab', hasRename: true, shortcut: 'F2', shortcutHint: 'F2' }, title);
  }
  for (const title of ['New chat', 'Gone chat']) {
    assert.deepEqual(readMenu(title), { first: 'Close tab', hasRename: false, shortcut: null, shortcutHint: null }, title);
  }

  // F2 is announced on the tabs it renames.
  assert.deepEqual(
    screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-keyshortcuts')),
    ['F2', 'F2', null, 'F2', null],
  );
});

test('the pane menu starts with "Rename session" for the active tab, disabled while that tab is a draft', () => {
  const view = renderBar();
  const readFirstPaneMenuItem = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Pane actions' }));
    const first = within(screen.getByRole('menu')).getAllByRole('menuitem')[0] as HTMLButtonElement;
    const facts = { label: first.textContent, disabled: first.disabled };
    fireEvent.click(screen.getByRole('button', { name: 'Pane actions' }));
    return facts;
  };

  assert.deepEqual(readFirstPaneMenuItem(), { label: 'Rename session', disabled: false });

  view.rerender(
    <WorkspaceChromeProvider value={chrome}>{barElement({ pane: { ...PANE, activeTabKey: 't3' } })}</WorkspaceChromeProvider>,
  );
  assert.deepEqual(readFirstPaneMenuItem(), { label: 'Rename session', disabled: true });
});

test('only the active kept session tab says in its tooltip how to rename it', () => {
  const renameHint = 'Double-click or F2 to rename';
  const previewHint = 'Preview · double-click to keep open';
  const view = renderBar();
  const tooltipOf = (title: string) => tabNamed(title).getAttribute('title') ?? '';

  assert.equal(tooltipOf('First chat').includes(renameHint), true);
  assert.equal(tooltipOf('Fourth chat').includes(renameHint), false, 'a background tab is only switched to by a double-click');
  assert.equal(tooltipOf('Second chat').includes(previewHint), true);
  assert.equal(tooltipOf('Second chat').includes(renameHint), false);

  // Active, a preview is still kept by a double-click, and a draft has nothing to rename.
  view.rerender(<WorkspaceChromeProvider value={chrome}>{barElement({ pane: { ...PANE, activeTabKey: 't2' } })}</WorkspaceChromeProvider>);
  assert.equal(tooltipOf('Second chat').includes(previewHint), true);
  assert.equal(tooltipOf('Second chat').includes(renameHint), false);
  view.rerender(<WorkspaceChromeProvider value={chrome}>{barElement({ pane: { ...PANE, activeTabKey: 't3' } })}</WorkspaceChromeProvider>);
  assert.equal(tooltipOf('New chat').includes(renameHint), false);
});

test('a draft always names its project after its title; with showProjectNames every tab does', () => {
  const view = renderBar();
  const suffixes = () => screen.getAllByRole('tab').map((tab) => tab.querySelector('[data-tab-project]')?.textContent ?? null);

  // Only "New chat" (t3) could be in any project.
  assert.deepEqual(suffixes().map((suffix) => suffix?.includes('Alpha') ?? false), [false, false, true, false]);
  assert.equal(tabNamed('New chat').querySelector('[data-tab-title]')?.textContent, 'New chat', 'the title keeps a span of its own');

  view.rerender(<WorkspaceChromeProvider value={chrome}>{barElement({ showProjectNames: true })}</WorkspaceChromeProvider>);
  assert.deepEqual(suffixes().map((suffix) => suffix?.includes('Alpha') ?? false), [true, true, true, true]);
  // Seen as "First chat · Alpha", heard as "First chat, Alpha": the dot is hidden from screen readers
  // (jsdom puts a space between the spans a browser joins).
  assert.equal(screen.queryByRole('tab', { name: /First chat\s*, Alpha/ }) !== null, true);

  // A missing conversation opened from a link may have no project at all: nothing to name.
  const orphan = makeTab('t5', { projectId: '', isMissing: true, session: null });
  view.rerender(
    <WorkspaceChromeProvider value={chrome}>
      {barElement({
        showProjectNames: true,
        pane: { ...PANE, tabs: [...TABS, orphan] },
        tabDisplay: new Map(DISPLAY).set('t5', { title: 'Gone chat', projectName: '', activity: null }),
      })}
    </WorkspaceChromeProvider>,
  );
  assert.equal(tabNamed('Gone chat').querySelector('[data-tab-project]') === null, true);
});

test('what the pane puts after the tabs sits between the blank stretch and the pane menu, and shrinks only when allowed', () => {
  const trailing = <span data-testid="trailing">views</span>;
  const view = renderBar({ trailingContent: trailing });
  const container = () => document.querySelector('[data-tab-bar-trailing]') as HTMLElement;

  assert.equal(container().contains(screen.getByTestId('trailing')), true);

  assert.equal(container().previousElementSibling?.hasAttribute('data-tab-bar-blank'), true);
  assert.equal(container().nextElementSibling?.contains(screen.getByRole('button', { name: 'Pane actions' })), true);
  assert.equal(container().classList.contains('flex-shrink-0'), true, 'the tabs give way first');

  view.rerender(
    <WorkspaceChromeProvider value={chrome}>{barElement({ trailingContent: trailing, trailingCanShrink: true })}</WorkspaceChromeProvider>,
  );
  assert.equal(container().classList.contains('flex-shrink'), true);
  assert.equal(container().classList.contains('flex-shrink-0'), false);
});
