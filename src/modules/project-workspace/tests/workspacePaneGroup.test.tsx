import assert from 'node:assert/strict';

import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import type {
  Project,
  WorkspaceLayout,
  WorkspaceLayoutActions,
  WorkspacePaneState,
  WorkspaceSessionTab,
  WorkspaceViewLabels,
} from '@/shared/types';

/**
 * The pane group ProjectMainRegion draws in the main column. Unsplit it shows one pane. Split
 * with room (canSplit) both panes sit side by side, the left one sized by --pane-left-width and a
 * divider between them. Split without room it collapses to the focused pane while the other
 * stays mounted (hidden, told it is not visible), so unsaved editor text and scroll survive.
 * Phones mount the focused pane only. Dragging the divider touches nothing but that variable.
 * Each pane's own width decides where its view bar goes (into the tab bar, or a row of its own)
 * and which views it labels; a hidden pane keeps its tier and is measured again as it shows. Tabs
 * name their project when tabs alone cannot tell it.
 */

type MainProps = {
  side: 'left' | 'right';
  isPaneVisible: boolean;
  isFocusedPane: boolean;
  isSplitPane: boolean;
  hideHeader: boolean;
  viewLabels: WorkspaceViewLabels;
  headerActions: ReactNode;
};

const mainRenders: MainProps[] = [];
const taskMasterSync = vi.fn();
const panes: { state: Record<string, unknown> } = { state: {} };
const NO_SESSIONS: ReadonlySet<string> = new Set();
// What the session protection context reports as busy / only running background work.
const sessionActivity: { busy: ReadonlySet<string>; background: ReadonlySet<string> } = { busy: NO_SESSIONS, background: NO_SESSIONS };
// Whether the sidebar is expanded (false: collapsed to its icon rail), and whether the Browser view is on.
const uiPreferences = { sidebarVisible: true };
const browserUse = { enabled: false };

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
vi.mock('@/shared/context/UiPreferencesContext', () => ({ useUiPreferences: () => uiPreferences }));
vi.mock('@/modules/browser-use', () => ({ useBrowserUseEnabled: () => browserUse.enabled }));
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
const tabBar = (side: 'left' | 'right') => document.querySelector(`[data-pane-tab-bar="${side}"]`) as HTMLElement;
const lastMainProps = (side: 'left' | 'right') => [...mainRenders].reverse().find((props) => props.side === side);
/** Whether the pane's tab bar carries the view bar. */
const hasViewBarInTabBar = (side: 'left' | 'right') => within(tabBar(side)).queryByRole('tablist', { name: 'Workspace views' }) !== null;
/** Whether each session tab of the pane shows a project suffix, in tab order (the view bar's tabs left out). */
const projectSuffixes = (side: 'left' | 'right' = 'left') => within(within(tabBar(side)).getByRole('tablist', { name: 'Open tabs' }))
  .getAllByRole('tab')
  .map((tab) => tab.querySelector('[data-tab-project]') !== null);

beforeEach(() => {
  mainRenders.length = 0;
  taskMasterSync.mockReset();
  actions = makeActions();
  sessionActivity.busy = NO_SESSIONS;
  sessionActivity.background = NO_SESSIONS;
  uiPreferences.sidebarVisible = true;
  browserUse.enabled = false;
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
  // One connection status for the whole app: it rides in the left pane's tab bar.
  assert.equal(tabBar('left').querySelector('[role="status"]') !== null, true);
  assert.equal(tabBar('right').querySelector('[role="status"]') === null, true);
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

/** Pane roots report `width` while shown and 0 while hidden with CSS (display: none), as a browser does. */
const measureShownPanes = (width: number) => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function measure(this: HTMLElement) {
    const measured = this.hasAttribute('data-workspace-pane') && !this.classList.contains('hidden') ? width : 0;
    return { x: 0, y: 0, left: 0, top: 0, right: measured, bottom: 600, width: measured, height: 600, toJSON: () => ({}) } as DOMRect;
  });
};

/** A ResizeObserver that reports only when told to; returns the call that makes every connected one report. */
const stubSilentResizeObserver = () => {
  const connected = new Set<() => void>();
  vi.stubGlobal('ResizeObserver', class {
    private readonly notify: () => void;

    constructor(callback: ResizeObserverCallback) {
      this.notify = () => callback([], this as unknown as ResizeObserver);
    }

    observe() {
      connected.add(this.notify);
    }

    unobserve() {}

    disconnect() {
      connected.delete(this.notify);
    }
  });
  return () => {
    act(() => {
      connected.forEach((notify) => notify());
    });
  };
};

test('each pane is measured, not the viewport: a wide one carries its view bar in the tab bar, a narrower one gets a row of its own', () => {
  measurePanes({ left: 1000, right: 700 });
  setLayout(splitLayout());
  const view = render(regionElement({ canSplit: true }));

  assert.equal(lastMainProps('left')?.hideHeader, true);
  assert.equal(hasViewBarInTabBar('left'), true);
  assert.equal(lastMainProps('right')?.hideHeader, false);
  assert.equal(lastMainProps('right')?.viewLabels, 'all');
  assert.equal(hasViewBarInTabBar('right'), false);
  view.unmount();

  // Too narrow to label every view: only the active one keeps its label.
  measurePanes({ left: 380 });
  setLayout(unsplitLayout());
  render(regionElement({ canSplit: false }));
  assert.equal(lastMainProps('left')?.hideHeader, false);
  assert.equal(lastMainProps('left')?.viewLabels, 'active');
});

test('immersive, the header goes and each pane keeps one row: tabs, the view bar and one connection status', () => {
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

test('immersive, a pane below the wide tier labels only its active view and lets the view bar shrink; a wide one labels every view', () => {
  const isFilesLabelHidden = (side: 'left' | 'right') => within(within(tabBar(side)).getByRole('tab', { name: 'Files' }))
    .getByText('Files')
    .classList.contains('hidden');
  const canTrailingShrink = (side: 'left' | 'right') => tabBar(side).querySelector('[data-tab-bar-trailing]')?.classList.contains('flex-shrink') ?? false;

  measurePanes({ left: 700, right: 700 });
  setLayout(splitLayout());
  const view = render(regionElement({ canSplit: true, isImmersive: true }));
  assert.deepEqual([isFilesLabelHidden('left'), isFilesLabelHidden('right')], [true, true]);
  assert.deepEqual([lastMainProps('left')?.hideHeader, lastMainProps('right')?.hideHeader], [true, true], 'still one row');
  assert.deepEqual([canTrailingShrink('left'), canTrailingShrink('right')], [true, true]);
  view.unmount();

  measurePanes({ left: 1000, right: 1000 });
  render(regionElement({ canSplit: true, isImmersive: true }));
  assert.deepEqual([isFilesLabelHidden('left'), isFilesLabelHidden('right')], [false, false]);
  assert.deepEqual([canTrailingShrink('left'), canTrailingShrink('right')], [false, false], 'the tabs give way first');
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

test('the phone header names the session and its project, and carries the connection status and the phone\'s controls', () => {
  const setView = vi.fn();
  render(
    <WorkspaceHeader
      activeTab="chat"
      setActiveTab={setView}
      selectedProject={ALPHA}
      selectedSession={{ id: 'session-a1', summary: 'Fix the build', __provider: 'claude' }}
      shouldShowTasksTab={false}
      shouldShowBrowserTab={false}
      isMobile
      onMenuClick={vi.fn()}
      onRenameSession={vi.fn(async () => true)}
      headerActions={<button type="button">Tabs (3)</button>}
    />,
  );

  assert.equal(screen.queryByRole('heading', { name: 'Fix the build' }) !== null, true);
  assert.equal(screen.queryByText('Alpha') !== null, true);
  assert.equal(document.querySelector('header [role="status"]') !== null, true);
  assert.equal(screen.queryByRole('button', { name: 'Tabs (3)' }) !== null, true);

  fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
  assert.deepEqual(setView.mock.calls, [['files', { userInitiated: true }]]);
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

  // The view bar shares the tab bar, so the session tabs are read from the Open tabs list.
  const strip = within(tabBar('left')).getByRole('tablist', { name: 'Open tabs' });
  const titles = Array.from(strip.querySelectorAll('[data-tab-title]')).map((title) => title.textContent);
  assert.deepEqual(titles, [
    'Renamed in the sidebar',
    'Chat a2',
    'New chat',
    'This conversation no longer exists',
  ]);
  // Alpha and Beta tabs side by side: every tab names its project.
  assert.deepEqual(projectSuffixes('left'), [true, true, true, true]);
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

test('a single pane is tiered by its width too: at 480px its view bar gets a labelled row of its own', () => {
  measurePanes({ left: 480 });
  setLayout(unsplitLayout());
  const view = render(regionElement({ canSplit: false }));
  assert.equal(lastMainProps('left')?.hideHeader, false);
  assert.equal(lastMainProps('left')?.viewLabels, 'all');
  assert.equal(hasViewBarInTabBar('left'), false);

  // Collapsed, the visible pane goes by its width as well.
  setLayout(splitLayout('left'));
  view.rerender(regionElement({ canSplit: false }));
  assert.equal(lastMainProps('left')?.hideHeader, false);
  assert.equal(lastMainProps('left')?.viewLabels, 'all');
  assert.equal(hasViewBarInTabBar('left'), false);
});

test('collapsed, the pane the switcher shows is tiered by its own width in the commit that shows it', () => {
  // The observer stays silent: the first frame on screen gets only what the commit itself measured.
  stubSilentResizeObserver();
  measureShownPanes(700);
  /** [header row hidden, view bar in the tab bar]: at 700px both false, the view bar has a row of its own. */
  const rows = (side: 'left' | 'right') => [lastMainProps(side)?.hideHeader, hasViewBarInTabBar(side)];
  try {
    setLayout(splitLayout('left'));
    const view = render(regionElement({ canSplit: false }));
    assert.deepEqual(rows('left'), [false, false]);

    // The right pane, hidden since it mounted, comes into view.
    setLayout(splitLayout('right'));
    view.rerender(regionElement({ canSplit: false }));
    assert.deepEqual(rows('right'), [false, false]);

    // And the left one again.
    setLayout(splitLayout('left'));
    view.rerender(regionElement({ canSplit: false }));
    assert.deepEqual(rows('left'), [false, false]);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('a pane hidden by a collapsed split keeps its tier rather than the one a 0px width would give', () => {
  const notifyResize = stubSilentResizeObserver();
  measureShownPanes(700);
  try {
    setLayout(splitLayout('left'));
    const view = render(regionElement({ canSplit: false }));
    assert.equal(lastMainProps('left')?.hideHeader, false);

    // The switcher hides the left pane: the commit and then the observer measure it at 0.
    setLayout(splitLayout('right'));
    view.rerender(regionElement({ canSplit: false }));
    notifyResize();
    assert.equal(lastMainProps('left')?.hideHeader, false, 'still the medium tier, not re-rendered as a wide pane');
  } finally {
    vi.unstubAllGlobals();
  }
});

test('a pane only re-renders when its width crosses a tier, not on every pixel of a drag', () => {
  let leftWidth = 900;
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

    // Ten frames of a divider drag, 3px each, all within the medium tier (384-991px for four views).
    for (let frame = 0; frame < 10; frame += 1) {
      leftWidth -= 3;
      act(() => {
        notifyResize.forEach((notify) => notify());
      });
    }
    assert.equal(lastMainProps('left')?.hideHeader, false);
    assert.equal(leftRenders(), before, 'no re-render while the width stays within one tier');

    // Into the wide tier: the view bar joins the tab bar.
    leftWidth = 1000;
    act(() => {
      notifyResize.forEach((notify) => notify());
    });
    assert.equal(lastMainProps('left')?.hideHeader, true);
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

test('each view raises the room the view bar needs in the tab bar, and turning one on re-tiers the pane at once', () => {
  measurePanes({ left: 1050 });
  setLayout(unsplitLayout());
  const view = render(regionElement({ canSplit: false }));
  assert.equal(lastMainProps('left')?.hideHeader, true, 'four views fit beside the tabs from 992px');

  // Browser makes five views, which need 1080px: no resize is needed to notice.
  browserUse.enabled = true;
  view.rerender(regionElement({ canSplit: false }));
  assert.equal(lastMainProps('left')?.hideHeader, false);
  assert.equal(lastMainProps('left')?.viewLabels, 'all');
  assert.equal(hasViewBarInTabBar('left'), false);
});

test('tabs name their project only when tabs alone cannot tell it', () => {
  // One project, the sidebar listing it: the tabs need no suffix.
  setLayout(unsplitLayout());
  const view = render(regionElement({ canSplit: false }));
  assert.deepEqual(projectSuffixes('left'), [false, false]);

  const draft = (key: string, projectId: string): WorkspaceSessionTab => ({ ...makeTab(key, projectId), sessionId: null, session: null, title: '' });
  const singlePane = (tabs: WorkspaceSessionTab[]): WorkspaceLayout => ({ left: makePane(tabs), right: null, focusedSide: 'left', splitRatio: 0.5 });
  const show = (layout: WorkspaceLayout, chrome: { isImmersive?: boolean } = {}) => {
    setLayout(layout);
    view.rerender(regionElement({ canSplit: false, ...chrome }));
    return projectSuffixes('left');
  };

  // A Beta tab joins: every tab says whose it is.
  assert.deepEqual(show(singlePane([makeTab('a1', 'alpha'), makeTab('a2', 'alpha'), makeTab('b1', 'beta')])), [true, true, true]);

  // A draft is "New chat" in any project, so it always names its own.
  assert.deepEqual(show(singlePane([makeTab('a1', 'alpha'), draft('d1', 'alpha')])), [false, true]);

  // A missing conversation without a project ('') is not a second project.
  assert.deepEqual(show(singlePane([makeTab('a1', 'alpha'), { ...makeTab('m1', ''), isMissing: true, session: null }])), [false, false]);

  // The sidebar out of sight: collapsed to its rail, or immersive.
  uiPreferences.sidebarVisible = false;
  assert.deepEqual(show(unsplitLayout()), [true, true]);
  uiPreferences.sidebarVisible = true;
  assert.deepEqual(show(unsplitLayout(), { isImmersive: true }), [true, true]);
});

test('the left tab bar keeps the one connection status, but no view bar, while that pane is empty, missing its conversation or loading', () => {
  const chrome = () => [tabBar('left').querySelector('[role="status"]') !== null, tabBar('right').querySelector('[role="status"]') !== null, hasViewBarInTabBar('left')];
  // The left pane keeps its id throughout, so the content it showed first stays mounted behind each state.
  const withLeft = (tabs: WorkspaceSessionTab[]): WorkspaceLayout => ({
    left: { ...makePane(tabs), id: 'pane-a1' },
    right: makePane([makeTab('b1', 'beta')]),
    focusedSide: 'right',
    splitRatio: 0.5,
  });

  setLayout(withLeft([makeTab('a1', 'alpha')]));
  const view = render(regionElement({ canSplit: true }));
  assert.deepEqual(chrome(), [true, false, true]);

  setLayout(withLeft([{ ...makeTab('m1', 'alpha'), isMissing: true, session: null }]));
  view.rerender(regionElement({ canSplit: true }));
  assert.deepEqual(chrome(), [true, false, false], 'missing conversation');

  setLayout(withLeft([]));
  view.rerender(regionElement({ canSplit: true }));
  assert.deepEqual(chrome(), [true, false, false], 'empty pane');

  setLayout(withLeft([makeTab('a1', 'alpha')]));
  panes.state = { ...panes.state, isLoadingProjects: true };
  view.rerender(regionElement({ canSplit: true }));
  assert.deepEqual(chrome(), [true, false, false], 'loading');
});

test('a pane showing a conversation names it and its project in a visually hidden heading', () => {
  setLayout({ left: makePane([makeTab('a1', 'alpha')]), right: makePane([]), focusedSide: 'left', splitRatio: 0.5 });
  render(regionElement({ canSplit: true }));

  const heading = within(pane('left') as HTMLElement).queryByRole('heading', { level: 2, name: 'Chat a1 · Alpha' });
  assert.equal(heading?.classList.contains('sr-only'), true);
  assert.equal(heading?.closest('[role="tabpanel"]') !== null, true);
  assert.equal(within(pane('right') as HTMLElement).queryByRole('heading', { name: /·/ }) === null, true, 'an empty pane has none');
});

test('the server\'s placeholder names read in the interface language in the hidden heading and the phone header, whose rename starts from the stored name', async () => {
  // A language switch saves the choice to the server; it must not reach the network.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
  await act(async () => {
    await i18n.changeLanguage('zh-CN');
  });
  try {
    const untitled = { id: 'session-a1', summary: 'Untitled Claude Session', __provider: 'claude' as const };
    setLayout({ left: makePane([makeTab('a1', 'alpha')]), right: null, focusedSide: 'left', splitRatio: 0.5 });
    panes.state = { ...panes.state, projects: [{ ...ALPHA, sessions: [untitled] }, BETA] };
    const view = render(regionElement());
    const headings = within(pane('left') as HTMLElement).getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    assert.deepEqual(headings, ['未命名的 Claude 会话 · Alpha']);
    view.unmount();

    render(
      <WorkspaceHeader
        activeTab="chat"
        setActiveTab={vi.fn()}
        selectedProject={ALPHA}
        selectedSession={untitled}
        shouldShowTasksTab={false}
        shouldShowBrowserTab={false}
        isMobile
        onMenuClick={vi.fn()}
        onRenameSession={vi.fn(async () => true)}
      />,
    );
    const title = screen.getByRole('heading', { level: 2 });
    assert.equal(title.textContent, '未命名的 Claude 会话');
    assert.equal(title.getAttribute('title'), '未命名的 Claude 会话（双击重命名）');
    fireEvent.doubleClick(title);
    assert.equal((screen.getByRole('textbox', { name: '会话标题' }) as HTMLInputElement).value, 'Untitled Claude Session');
  } finally {
    // Unmount first, so restoring the language cannot re-render this test's tree.
    cleanup();
    await act(async () => {
      await i18n.changeLanguage('en');
    });
    vi.unstubAllGlobals();
  }
});
