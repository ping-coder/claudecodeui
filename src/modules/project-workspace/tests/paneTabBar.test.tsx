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
 * rightmost visible pane's bar.
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
const PANE: WorkspacePaneState = { tabs: TABS, activeTabKey: 't1', mru: ['t1'], draftActivation: 0, externalRevision: 0 };
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
    {...overrides}
  />
);

const renderBar = (overrides: Partial<BarProps> = {}, chromeOverrides: Partial<typeof chrome> = {}) => render(
  <WorkspaceChromeProvider value={{ ...chrome, ...chromeOverrides }}>{barElement(overrides)}</WorkspaceChromeProvider>,
);

const tabNamed = (title: string) => screen.getByRole('tab', { name: new RegExp(title) });

beforeEach(() => {
  actions = makeActions();
  chrome.toggleImmersive.mockReset();
  chrome.setSidebarPeekOpen.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
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
  const lonePane: WorkspacePaneState = { tabs: [TABS[0]], activeTabKey: 't1', mru: ['t1'], draftActivation: 0, externalRevision: 0 };
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
