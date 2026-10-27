import assert from 'node:assert/strict';

import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type {
  Project,
  WorkspaceLayout,
  WorkspaceLayoutActions,
  WorkspacePaneState,
  WorkspaceSessionTab,
} from '@/shared/types';

/**
 * The pane group ProjectMainRegion draws in the main column. Unsplit it shows one pane. Split
 * with room (canSplit) both panes sit side by side, the left one sized by --pane-left-width and a
 * divider between them. Split without room it collapses to the focused pane while the other
 * stays mounted (hidden, told it is not visible), so unsaved editor text and scroll survive.
 * Phones mount the focused pane only. Dragging the divider touches nothing but that variable.
 */

type MainProps = {
  side: 'left' | 'right';
  isPaneVisible: boolean;
  isFocusedPane: boolean;
  isSplitPane: boolean;
  compact: boolean;
  hideHeader: boolean;
  showConnectionStatus: boolean;
  headerActions: ReactNode;
};

const mainRenders: MainProps[] = [];
const taskMasterSync = vi.fn();
const panes: { state: Record<string, unknown> } = { state: {} };
const NO_SESSIONS: ReadonlySet<string> = new Set();
// What the session protection context reports as busy / only running background work.
const sessionActivity: { busy: ReadonlySet<string>; background: ReadonlySet<string> } = { busy: NO_SESSIONS, background: NO_SESSIONS };

vi.mock('@/modules/project-workspace/context/ProjectsStateContext', () => ({
  useProjectPanesState: () => panes.state,
}));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useBusySessionIdSet: () => sessionActivity.busy,
  useBackgroundSessionIdSet: () => sessionActivity.background,
}));
vi.mock('@/modules/task-master', () => ({
  useTaskMasterProjectSync: (project: Project | null) => taskMasterSync(project),
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }),
}));
vi.mock('@/modules/browser-use', () => ({ useBrowserUseEnabled: () => false }));
vi.mock('@/modules/plugins', () => ({ usePlugins: () => ({ plugins: [] }), PluginIcon: () => null }));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ connectionStatus: 'connected' }) }));
vi.mock('@/modules/project-workspace/WorkspaceMain', () => ({
  default: (props: MainProps) => {
    mainRenders.push(props);
    return <div data-testid={`main-${props.side}`}>{props.headerActions}</div>;
  },
}));

const { WorkspaceChromeProvider } = await import('@/modules/project-workspace/context/WorkspaceChromeContext');
const { default: ProjectMainRegion } = await import('@/modules/project-workspace/ProjectMainRegion');
const { default: WorkspaceHeader } = await import('@/modules/project-workspace/WorkspaceHeader');

const ALPHA: Project = { projectId: 'alpha', displayName: 'Alpha', fullPath: '/repo/alpha', path: '/repo/alpha', sessions: [] };
const BETA: Project = { projectId: 'beta', displayName: 'Beta', fullPath: '/repo/beta', path: '/repo/beta', sessions: [] };
const PROJECTS = [ALPHA, BETA];

const makeTab = (key: string, projectId: string): WorkspaceSessionTab => ({
  key,
  sessionId: `session-${key}`,
  projectId,
  provider: 'claude',
  title: `Chat ${key}`,
  view: 'chat',
  isPreview: false,
  session: { id: `session-${key}`, summary: `Chat ${key}`, __projectId: projectId, __provider: 'claude' },
});

const makePane = (tabs: WorkspaceSessionTab[]): WorkspacePaneState => ({
  // Ids follow the first tab, so the two panes of a layout differ and a pane keeps its id across renders.
  id: `pane-${tabs[0]?.key ?? 'empty'}`,
  tabs,
  activeTabKey: tabs[0]?.key ?? null,
  mru: tabs[0] ? [tabs[0].key] : [],
  draftActivation: 0,
  externalRevision: 0,
});

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

const projectOf = (pane: WorkspacePaneState | null): Project | null => {
  const projectId = pane?.tabs.find((tab) => tab.key === pane.activeTabKey)?.projectId;
  return PROJECTS.find((project) => project.projectId === projectId) ?? null;
};

const setLayout = (layout: WorkspaceLayout, attentionSessionIds: ReadonlySet<string> = NO_SESSIONS) => {
  panes.state = {
    layout,
    paneProjects: { left: projectOf(layout.left), right: projectOf(layout.right) },
    projects: PROJECTS,
    isLoadingProjects: false,
    attentionSessionIds,
    fallbackProject: ALPHA,
    actions,
    openSettings: vi.fn(),
    setSidebarOpen: vi.fn(),
    renameSession: vi.fn(async () => true),
    refreshProjectsSilently: vi.fn(async () => undefined),
  };
};

const unsplitLayout = (): WorkspaceLayout => ({
  left: makePane([makeTab('a1', 'alpha'), makeTab('a2', 'alpha')]),
  right: null,
  focusedSide: 'left',
  splitRatio: 0.5,
});

const splitLayout = (focusedSide: 'left' | 'right' = 'left'): WorkspaceLayout => ({
  left: makePane([makeTab('a1', 'alpha')]),
  right: makePane([makeTab('b1', 'beta')]),
  focusedSide,
  splitRatio: 0.5,
});

const regionElement = ({ canSplit = true, isMobile = false, isImmersive = false } = {}) => (
  <WorkspaceChromeProvider
    value={{
      isImmersive,
      isBrowserFullscreen: false,
      toggleImmersive: vi.fn(),
      exitImmersive: vi.fn(),
      isSidebarPeekOpen: false,
      setSidebarPeekOpen: vi.fn(),
      canSplit,
    }}
  >
    <ProjectMainRegion isMobile={isMobile} ws={null} sendMessage={() => undefined} navigate={vi.fn() as unknown as NavigateFunction} />
  </WorkspaceChromeProvider>
);

const pane = (side: 'left' | 'right') => document.querySelector<HTMLElement>(`[data-workspace-pane="${side}"]`);
const lastMainProps = (side: 'left' | 'right') => [...mainRenders].reverse().find((props) => props.side === side);

beforeEach(() => {
  mainRenders.length = 0;
  taskMasterSync.mockReset();
  actions = makeActions();
  sessionActivity.busy = NO_SESSIONS;
  sessionActivity.background = NO_SESSIONS;
});

test('unsplit, one pane fills the column with no divider', () => {
  setLayout(unsplitLayout());
  render(regionElement());

  assert.ok(pane('left'));
  assert.equal(pane('right') === null, true);
  assert.ok(pane('left')?.classList.contains('flex-1'));
  assert.equal(pane('left')?.getAttribute('role'), 'group');
  // Not focusable by default: a click on plain text would park focus on it and stop keyboard scrolling.
  assert.equal(pane('left')?.hasAttribute('tabindex'), false);
  assert.equal(screen.queryByRole('separator') === null, true);
  assert.equal(lastMainProps('left')?.isPaneVisible, true);
  assert.equal(lastMainProps('left')?.isSplitPane, false);
});

test('split with room, both panes show side by side with the left one sized by --pane-left-width', () => {
  setLayout(splitLayout());
  render(regionElement({ canSplit: true }));

  const left = pane('left');
  const right = pane('right');
  assert.ok(left && right);
  assert.equal(left.classList.contains('hidden'), false);
  assert.equal(right.classList.contains('hidden'), false);
  assert.match(left.style.flexBasis, /var\(--pane-left-width/);
  assert.match(left.style.flexBasis, /clamp\(360px/);
  assert.ok(right.classList.contains('flex-1'));

  const separator = screen.getByRole('separator', { name: 'Resize panes' });
  assert.ok(separator.previousElementSibling === left, 'the divider sits between the panes');
  assert.ok(separator.nextElementSibling === right);
  const group = document.querySelector<HTMLElement>('[data-workspace-pane-group]');
  assert.equal(group?.style.getPropertyValue('--pane-left-width'), 'calc((100% - 6px) * 0.5)');

  assert.equal(lastMainProps('left')?.isPaneVisible, true);
  assert.equal(lastMainProps('right')?.isPaneVisible, true);
  assert.equal(lastMainProps('left')?.isSplitPane, true);
  assert.equal(lastMainProps('left')?.isFocusedPane, true);
  assert.equal(lastMainProps('right')?.isFocusedPane, false);
  // One connection status for the whole app: the right pane hides its own.
  assert.equal(lastMainProps('left')?.showConnectionStatus, true);
  assert.equal(lastMainProps('right')?.showConnectionStatus, false);
});

test('split without room, the focused pane shows and the other stays mounted but hidden and not visible', () => {
  setLayout(splitLayout('left'));
  render(regionElement({ canSplit: false }));

  assert.equal(pane('left')?.classList.contains('hidden'), false);
  assert.ok(pane('right')?.classList.contains('hidden'), 'the right pane is hidden with CSS');
  assert.ok(screen.getByTestId('main-right'), 'and still mounted');
  assert.equal(lastMainProps('right')?.isPaneVisible, false);
  assert.equal(lastMainProps('left')?.isPaneVisible, true);
  assert.equal(lastMainProps('left')?.isSplitPane, false);
  assert.equal(screen.queryByRole('separator') === null, true);

  // The visible pane's bar starts with the left/right switcher.
  const leftPane = pane('left') as HTMLElement;
  const switchRight = within(leftPane).getByRole('button', { name: 'Focus right pane' });
  assert.equal(within(leftPane).getByRole('button', { name: 'Focus left pane' }).getAttribute('aria-pressed'), 'true');
  fireEvent.click(switchRight);
  assert.deepEqual(vi.mocked(actions.focusPane).mock.calls, [['right']]);
});

test('a collapsed split follows the focused side', () => {
  setLayout(splitLayout('right'));
  render(regionElement({ canSplit: false }));

  assert.ok(pane('left')?.classList.contains('hidden'));
  assert.equal(pane('right')?.classList.contains('hidden'), false);
  assert.equal(lastMainProps('left')?.isPaneVisible, false);
  // The visible pane is the rightmost one, so it carries the split and full-screen buttons.
  assert.ok(within(pane('right') as HTMLElement).getByRole('button', { name: 'Merge panes' }));
  assert.equal(within(pane('left') as HTMLElement).queryByRole('button', { name: 'Merge panes' }) === null, true);
});

test('phones mount only the focused pane, without tab bars or a divider', () => {
  setLayout(splitLayout('right'));
  render(regionElement({ isMobile: true, canSplit: false }));

  assert.equal(pane('left') === null, true, 'the other pane is not mounted');
  assert.ok(pane('right'));
  assert.equal(screen.queryByRole('tablist', { name: 'Open tabs' }) === null, true);
  assert.equal(screen.queryByRole('separator') === null, true);
  assert.equal(mainRenders.some((props) => props.side === 'left'), false);
});

test('dragging the divider rewrites only the CSS variable; the panes do not re-render and the ratio is saved on release', () => {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function measure(this: HTMLElement) {
    const width = this.hasAttribute('data-workspace-pane-group') ? 1006 : 0;
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 600, width, height: 600, toJSON: () => ({}) } as DOMRect;
  });
  setLayout(splitLayout());
  render(regionElement({ canSplit: true }));
  frames.splice(0).forEach((callback) => callback(0));
  const group = document.querySelector<HTMLElement>('[data-workspace-pane-group]') as HTMLElement;
  const separator = screen.getByRole('separator');
  const rendersBeforeDrag = mainRenders.length;

  const firePointer = (type: 'pointerDown' | 'pointerMove' | 'pointerUp', clientX: number) => {
    const event = createEvent[type](separator);
    Object.defineProperties(event, { clientX: { value: clientX }, button: { value: 0 }, pointerId: { value: 1 } });
    fireEvent(separator, event);
  };

  firePointer('pointerDown', 500);
  firePointer('pointerMove', 550);
  frames.splice(0).forEach((callback) => callback(0));

  assert.equal(group.style.getPropertyValue('--pane-left-width'), 'calc((100% - 6px) * 0.55)');
  assert.equal(mainRenders.length, rendersBeforeDrag, 'no pane re-rendered during the drag');
  assert.equal(vi.mocked(actions.setSplitRatio).mock.calls.length, 0, 'nothing is saved mid-drag');

  firePointer('pointerUp', 550);
  assert.deepEqual(vi.mocked(actions.setSplitRatio).mock.calls, [[0.55]]);
});

test('TaskMaster is synced once, from the focused pane only', () => {
  setLayout(splitLayout('left'));
  const view = render(regionElement());
  assert.ok(taskMasterSync.mock.calls.length > 0);
  assert.ok(taskMasterSync.mock.calls.every(([project]) => project === ALPHA), 'only the focused pane project is synced');

  taskMasterSync.mockReset();
  setLayout(splitLayout('right'));
  view.rerender(regionElement());
  assert.ok(taskMasterSync.mock.calls.length > 0);
  assert.ok(taskMasterSync.mock.calls.every(([project]) => project === BETA));
});

/** Pane roots report the given widths; everything else measures 0, as jsdom does. */
const measurePanes = (widths: Partial<Record<'left' | 'right', number>>) => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function measure(this: HTMLElement) {
    const side = this.getAttribute('data-workspace-pane') as 'left' | 'right' | null;
    const width = side ? widths[side] ?? 0 : 0;
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 600, width, height: 600, toJSON: () => ({}) } as DOMRect;
  });
};

test('a pane narrower than 640px gets the compact header: each pane is measured, not the viewport', () => {
  measurePanes({ left: 639, right: 720 });
  setLayout(splitLayout());
  render(regionElement({ canSplit: true }));

  assert.equal(lastMainProps('left')?.compact, true);
  assert.equal(lastMainProps('right')?.compact, false);
});

test('immersive, the header goes and each pane keeps one row: tabs, the compact view bar and one connection status', () => {
  setLayout(splitLayout());
  render(regionElement({ canSplit: true, isImmersive: true }));
  const leftBar = document.querySelector('[data-pane-tab-bar="left"]') as HTMLElement;
  const rightBar = document.querySelector('[data-pane-tab-bar="right"]') as HTMLElement;

  assert.equal(lastMainProps('left')?.hideHeader, true);
  assert.equal(lastMainProps('right')?.hideHeader, true);
  assert.ok(within(leftBar).getByRole('tablist', { name: 'Workspace views' }));
  assert.ok(within(rightBar).getByRole('tablist', { name: 'Workspace views' }));
  // The view bar in the tab bar switches this pane's view as the user's choice.
  fireEvent.click(within(rightBar).getByRole('tab', { name: 'Files' }));
  assert.deepEqual(vi.mocked(actions.setTabView).mock.calls, [['right', 'b1', 'files', { pin: true }]]);

  assert.equal(leftBar.querySelector('[role="status"]') !== null, true, 'the connection status rides in the left bar');
  assert.equal(rightBar.querySelector('[role="status"]') === null, true, 'and only there');
  assert.ok(within(leftBar).getByRole('button', { name: 'Show sidebar' }));
  assert.equal(within(rightBar).queryByRole('button', { name: 'Show sidebar' }) === null, true);
  assert.ok(within(rightBar).getByRole('button', { name: 'Exit full screen' }));
});

test('collapsed, the switcher dot follows what the hidden pane\'s sessions are doing', () => {
  const layout = {
    left: makePane([makeTab('a1', 'alpha')]),
    right: makePane([makeTab('b1', 'beta'), makeTab('b2', 'beta')]),
    focusedSide: 'left' as const,
    splitRatio: 0.5,
  };
  const hiddenSideDot = () => within(pane('left') as HTMLElement)
    .getByRole('button', { name: 'Focus right pane' })
    .querySelector('[data-hidden-pane-activity]');

  setLayout(layout);
  const view = render(regionElement({ canSplit: false }));
  assert.equal(hiddenSideDot() === null, true, 'nothing runs on the hidden side');

  // A background tab of the hidden pane is running.
  sessionActivity.busy = new Set(['session-b2']);
  view.rerender(regionElement({ canSplit: false }));
  assert.equal(hiddenSideDot()?.getAttribute('data-hidden-pane-activity'), 'running');

  // One needing attention outranks it.
  setLayout(layout, new Set(['session-b1']));
  view.rerender(regionElement({ canSplit: false }));
  assert.equal(hiddenSideDot()?.getAttribute('data-hidden-pane-activity'), 'attention');

  // Side by side there is no switcher at all.
  view.rerender(regionElement({ canSplit: true }));
  assert.equal(within(pane('left') as HTMLElement).queryByRole('button', { name: 'Focus right pane' }) === null, true);
});

test('the compact header drops the title and labels only the active view; the right pane\'s has no connection status', () => {
  const setView = vi.fn();
  const header = (props: { compact?: boolean; showConnectionStatus?: boolean; headerActions?: ReactNode } = {}) => (
    <WorkspaceHeader
      activeTab="chat"
      setActiveTab={setView}
      selectedProject={ALPHA}
      selectedSession={{ id: 'session-a1', summary: 'Fix the build', __provider: 'claude' }}
      shouldShowTasksTab={false}
      shouldShowBrowserTab={false}
      isMobile={false}
      onMenuClick={vi.fn()}
      onRenameSession={vi.fn(async () => true)}
      {...props}
    />
  );
  const filesLabel = () => within(screen.getByRole('tab', { name: 'Files' })).getByText('Files');

  const view = render(header());
  assert.ok(screen.getByRole('heading', { name: 'Fix the build' }));
  assert.equal(document.querySelector('header [role="status"]') !== null, true);
  assert.ok(filesLabel().className.includes('lg:inline'), 'wide headers label every view on large screens');

  // A wide right pane side by side keeps its title but leaves the one connection status to the left pane.
  view.rerender(header({ showConnectionStatus: false }));
  assert.ok(screen.getByRole('heading', { name: 'Fix the build' }));
  assert.equal(document.querySelector('header [role="status"]') === null, true);

  // A narrow left pane keeps the status but not the title.
  view.rerender(header({ compact: true }));
  assert.equal(screen.queryByRole('heading', { name: 'Fix the build' }) === null, true, 'the pane tab already names the session');
  assert.equal(document.querySelector('header [role="status"]') !== null, true);

  view.rerender(header({ compact: true, showConnectionStatus: false }));
  assert.equal(screen.queryByRole('heading', { name: 'Fix the build' }) === null, true, 'the pane tab already names the session');
  assert.equal(document.querySelector('header [role="status"]') === null, true);
  assert.equal(filesLabel().className.includes('lg:inline'), false, 'only the active view keeps its label');
  assert.equal(document.querySelector('header > div')?.children.length, 1, 'no empty block is left before the view bar');

  fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
  assert.deepEqual(setView.mock.calls, [['files', { userInitiated: true }]]);

  view.rerender(header({ compact: true, headerActions: <button type="button">Tabs (3)</button> }));
  assert.ok(screen.getByRole('button', { name: 'Tabs (3)' }));
});

test('tab titles prefer the live projects row over the tab\'s snapshot, and name drafts and missing conversations', () => {
  const projectsWithRename: Project[] = [
    { ...ALPHA, sessions: [{ id: 'session-a1', summary: 'Renamed in the sidebar', __provider: 'claude' }] },
    BETA,
  ];
  setLayout({
    left: makePane([
      makeTab('a1', 'alpha'),
      makeTab('a2', 'alpha'),
      { ...makeTab('d1', 'beta'), sessionId: null, session: null, title: '' },
      { ...makeTab('m1', 'alpha'), title: '', isMissing: true },
    ]),
    right: null,
    focusedSide: 'left',
    splitRatio: 0.5,
  });
  panes.state = { ...panes.state, projects: projectsWithRename };
  render(regionElement());

  const titles = within(document.querySelector('[data-pane-tab-bar="left"]') as HTMLElement)
    .getAllByRole('tab')
    .map((tab) => tab.textContent);
  assert.deepEqual(titles, [
    'Renamed in the sidebar',
    'Chat a2',
    'New chat',
    'This conversation no longer exists',
  ]);
});

test('a freshly split, empty right pane offers the left pane\'s conversation and leaves it out of the recent list', () => {
  const projectsWithSessions: Project[] = [
    {
      ...ALPHA,
      sessions: [
        { id: 'session-a1', summary: 'Chat a1', lastActivity: '2026-10-27T10:00:00Z', __provider: 'claude' },
        { id: 'session-old', summary: 'Older talk', lastActivity: '2026-10-20T10:00:00Z', __provider: 'claude' },
      ],
    },
    BETA,
  ];
  setLayout({ left: makePane([makeTab('a1', 'alpha')]), right: makePane([]), focusedSide: 'right', splitRatio: 0.5 });
  panes.state = { ...panes.state, projects: projectsWithSessions };
  render(regionElement());
  const rightPane = pane('right') as HTMLElement;

  const recent = within(rightPane).getByRole('region', { name: 'Recent conversations' });
  assert.deepEqual(within(recent).getAllByRole('button').map((button) => button.textContent), ['Older talkAlpha']);

  fireEvent.click(within(rightPane).getByRole('button', { name: 'Also open the current conversation here' }));
  const [opened, options] = vi.mocked(actions.openSession).mock.calls[0];
  assert.equal(opened.id, 'session-a1');
  assert.equal(opened.__projectId, 'alpha');
  assert.deepEqual(options, { target: 'right', preview: false });
});

test('workspace-wide buttons in a tab bar do not focus that pane; anything else pressed in it does', () => {
  setLayout(splitLayout('left'));
  const view = render(regionElement({ canSplit: true }));
  const rightPane = pane('right') as HTMLElement;

  fireEvent.pointerDown(within(rightPane).getByRole('button', { name: 'Full screen' }));
  fireEvent.pointerDown(within(rightPane).getByRole('button', { name: 'Merge panes' }));
  assert.deepEqual(vi.mocked(actions.focusPane).mock.calls, [], 'the user keeps working on the left');

  fireEvent.pointerDown(within(rightPane).getByRole('tab', { name: /Chat b1/ }));
  assert.deepEqual(vi.mocked(actions.focusPane).mock.calls, [['right']]);

  // Immersive, "Show sidebar" sits in the left bar: opening the drawer from the right leaves the right focused.
  vi.mocked(actions.focusPane).mockClear();
  setLayout(splitLayout('right'));
  view.rerender(regionElement({ canSplit: true, isImmersive: true }));
  fireEvent.pointerDown(within(pane('left') as HTMLElement).getByRole('button', { name: 'Show sidebar' }));
  assert.deepEqual(vi.mocked(actions.focusPane).mock.calls, []);
});

test('keyboard focus follows the split button into the tab bar that carries it after a split and a merge', () => {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  const runFrames = () => frames.splice(0).forEach((callback) => callback(0));
  setLayout(unsplitLayout());
  const view = render(regionElement({ canSplit: true }));
  const splitButton = within(pane('left') as HTMLElement).getByRole('button', { name: 'Split view' });

  splitButton.focus();
  fireEvent.click(splitButton);
  assert.equal(vi.mocked(actions.toggleSplit).mock.calls.length, 1);
  // The split renders: the button now lives in the right pane's bar.
  setLayout(splitLayout('right'));
  view.rerender(regionElement({ canSplit: true }));
  runFrames();
  const mergeButton = within(pane('right') as HTMLElement).getByRole('button', { name: 'Merge panes' });
  assert.equal(document.activeElement === mergeButton, true);

  fireEvent.click(mergeButton);
  setLayout(unsplitLayout());
  view.rerender(regionElement({ canSplit: true }));
  runFrames();
  assert.equal(document.activeElement === within(pane('left') as HTMLElement).getByRole('button', { name: 'Split view' }), true);
});

test('a single pane keeps its title however narrow; only a pane beside another goes compact', () => {
  measurePanes({ left: 480 });
  setLayout(unsplitLayout());
  const view = render(regionElement({ canSplit: false }));
  assert.equal(lastMainProps('left')?.compact, false, 'the project name and the rename box stay');

  // Collapsed, the visible pane is alone on screen too.
  setLayout(splitLayout('left'));
  view.rerender(regionElement({ canSplit: false }));
  assert.equal(lastMainProps('left')?.compact, false);
});

test('a pane only re-renders when its width crosses the compact threshold, not on every pixel of a drag', () => {
  let leftWidth = 720;
  const notifyResize: Array<() => void> = [];
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly callback: ResizeObserverCallback) {}

    observe() {
      notifyResize.push(() => this.callback([], this as unknown as ResizeObserver));
    }

    unobserve() {}

    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function measure(this: HTMLElement) {
    const width = this.getAttribute('data-workspace-pane') === 'left' ? leftWidth : 900;
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 600, width, height: 600, toJSON: () => ({}) } as DOMRect;
  });
  try {
    setLayout(splitLayout());
    render(regionElement({ canSplit: true }));
    const leftRenders = () => mainRenders.filter((props) => props.side === 'left').length;
    const before = leftRenders();

    // Ten frames of a divider drag, 3px each, all wider than 640px.
    for (let frame = 0; frame < 10; frame += 1) {
      leftWidth -= 3;
      act(() => {
        notifyResize.forEach((notify) => notify());
      });
    }
    assert.equal(leftRenders(), before, 'no re-render while the width stays on one side of 640px');

    leftWidth = 600;
    act(() => {
      notifyResize.forEach((notify) => notify());
    });
    assert.equal(lastMainProps('left')?.compact, true);
    assert.equal(leftRenders(), before + 1, 'one re-render for the crossing');
  } finally {
    vi.unstubAllGlobals();
  }
});

test('collapsed, the switcher dot also counts background work left running on the hidden side', () => {
  sessionActivity.background = new Set(['session-b1']);
  setLayout(splitLayout('left'));
  render(regionElement({ canSplit: false }));

  const dot = within(pane('left') as HTMLElement)
    .getByRole('button', { name: 'Focus right pane' })
    .querySelector('[data-hidden-pane-activity]');
  assert.equal(dot?.getAttribute('data-hidden-pane-activity'), 'running');
});
