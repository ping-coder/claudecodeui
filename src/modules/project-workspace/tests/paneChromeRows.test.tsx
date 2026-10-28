import assert from 'node:assert/strict';

import { fireEvent, render, screen, within } from '@testing-library/react';
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
 * What sits above a pane's content, with the real WorkspaceMain. On desktop the session is named on
 * its tab only: no header. A wide pane carries the view bar in its tab bar, so the tab bar is the one
 * row; a narrower pane puts the view bar in a 40px row of its own (labelled while there is room, else
 * only the active view). Phones keep their header with the session title and the project. A view
 * bar that does not fit scrolls sideways.
 */

const panes: { state: Record<string, unknown> } = { state: {} };
const NO_SESSIONS: ReadonlySet<string> = new Set();
const noop = () => undefined;

vi.mock('@/modules/project-workspace/context/ProjectsStateContext', () => ({
  useProjectPanesState: () => panes.state,
}));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useBusySessionIdSet: () => NO_SESSIONS,
  useBackgroundSessionIdSet: () => NO_SESSIONS,
}));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ connectionStatus: 'connected' }) }));
vi.mock('@/shared/context/UiPreferencesContext', () => ({
  useUiPreferences: () => ({ showRawParameters: false, showThinking: false, sendByCtrlEnter: false, sidebarVisible: true }),
}));
vi.mock('@/modules/chat', () => ({ ChatInterface: () => <div data-testid="chat" /> }));
vi.mock('@/modules/file-tree', () => ({ FileTree: () => <div /> }));
vi.mock('@/modules/standalone-shell', () => ({ StandaloneShell: () => <div /> }));
vi.mock('@/modules/git-panel', () => ({ GitPanel: () => <div /> }));
vi.mock('@/modules/plugins', () => ({ usePlugins: () => ({ plugins: [] }), PluginIcon: () => null, PluginTabContent: () => <div /> }));
vi.mock('@/modules/browser-use', () => ({ BrowserUsePanel: () => <div />, useBrowserUseEnabled: () => false }));
vi.mock('@/modules/task-master', () => ({
  TaskMasterPanel: () => <div />,
  useTaskMaster: () => ({ currentProject: null }),
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }),
  useTaskMasterProjectSync: () => undefined,
}));
vi.mock('@/modules/code-editor', () => ({
  EditorSidebar: () => null,
  useEditorSidebar: () => ({
    editingFile: null,
    editorWidth: 0,
    editorExpanded: false,
    resizeHandleRef: { current: null },
    handleFileOpen: () => true,
    handleCloseEditor: noop,
    handleToggleEditorExpand: noop,
    handleResizeStart: noop,
    handleUnsavedChangesChange: noop,
  }),
}));
vi.mock('@/modules/project-workspace/hooks/useFileOpenResolver', () => ({
  useFileOpenResolver: (_project: Project | null, open: (filePath: string) => void) => open,
}));

const { WorkspaceChromeProvider } = await import('@/modules/project-workspace/context/WorkspaceChromeContext');
const { default: ProjectMainRegion } = await import('@/modules/project-workspace/ProjectMainRegion');
const { default: PaneViewBar } = await import('@/modules/project-workspace/PaneViewBar');

const ALPHA: Project = { projectId: 'alpha', displayName: 'Alpha', fullPath: '/repo/alpha', path: '/repo/alpha', sessions: [] };

const makeTab = (key: string): WorkspaceSessionTab => ({
  key,
  sessionId: `session-${key}`,
  projectId: 'alpha',
  provider: 'claude',
  title: `Chat ${key}`,
  view: 'chat',
  isPreview: false,
  session: { id: `session-${key}`, summary: `Chat ${key}`, __projectId: 'alpha', __provider: 'claude' },
});

const makePane = (tabs: WorkspaceSessionTab[]): WorkspacePaneState => ({
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

const LAYOUT: WorkspaceLayout = { left: makePane([makeTab('a1')]), right: null, focusedSide: 'left', splitRatio: 0.5 };

const setLayout = (layout: WorkspaceLayout) => {
  panes.state = {
    layout,
    paneProjects: { left: ALPHA, right: null },
    projects: [ALPHA],
    isLoadingProjects: false,
    attentionSessionIds: NO_SESSIONS,
    fallbackProject: ALPHA,
    actions,
    openSettings: vi.fn(),
    setSidebarOpen: vi.fn(),
    renameSession: vi.fn(async () => true),
    refreshProjectsSilently: vi.fn(async () => undefined),
  };
};

const renderRegion = ({ isMobile = false } = {}) => render(
  <WorkspaceChromeProvider
    value={{
      isImmersive: false,
      isBrowserFullscreen: false,
      toggleImmersive: vi.fn(),
      exitImmersive: vi.fn(),
      isSidebarPeekOpen: false,
      setSidebarPeekOpen: vi.fn(),
      canSplit: !isMobile,
    }}
  >
    <ProjectMainRegion isMobile={isMobile} ws={null} sendMessage={() => undefined} navigate={vi.fn() as unknown as NavigateFunction} />
  </WorkspaceChromeProvider>,
);

/** The left pane root reports this width; everything else measures 0, as jsdom does. */
const measureLeftPane = (width: number) => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function measure(this: HTMLElement) {
    const measured = this.getAttribute('data-workspace-pane') === 'left' ? width : 0;
    return { x: 0, y: 0, left: 0, top: 0, right: measured, bottom: 600, width: measured, height: 600, toJSON: () => ({}) } as DOMRect;
  });
};

const tabBar = () => document.querySelector<HTMLElement>('[data-pane-tab-bar="left"]');
const viewRow = () => document.querySelector<HTMLElement>('[data-pane-view-row]');
const hasHeader = () => document.querySelector('header') !== null;
/** Which built-in views of the view row show their label, in order. */
const labelledViews = (row: HTMLElement) => ['Chat', 'Shell', 'Files', 'Source Control']
  .filter((name) => !within(within(row).getByRole('tab', { name })).getByText(name).classList.contains('hidden'));

beforeEach(() => {
  actions = makeActions();
  setLayout(LAYOUT);
});

test('a wide desktop pane has one row: the tab bar carries the view bar, and there is no header', () => {
  renderRegion();

  assert.equal(hasHeader(), false);
  assert.equal(viewRow() === null, true);
  const bar = tabBar() as HTMLElement;
  assert.equal(within(bar).queryByRole('tablist', { name: 'Workspace views' }) !== null, true);
  assert.equal(within(bar).queryByRole('tablist', { name: 'Open tabs' }) !== null, true);
});

test('at 700px the view bar gets a labelled row of its own under the tab bar, still without a header or a title', () => {
  measureLeftPane(700);
  renderRegion();

  const row = viewRow();
  assert.equal(row !== null && row.closest('[role="tabpanel"]') !== null, true, 'the row sits in the tab panel');
  const views = within(row as HTMLElement).queryByRole('tablist', { name: 'Workspace views' });
  assert.equal(views !== null, true);
  assert.equal(within(tabBar() as HTMLElement).queryByRole('tablist', { name: 'Workspace views' }) === null, true);
  assert.equal(hasHeader(), false);
  assert.equal(within(row as HTMLElement).queryByText('Chat a1') === null, true, 'the tab alone names the session');
  assert.deepEqual(labelledViews(row as HTMLElement), ['Chat', 'Shell', 'Files', 'Source Control']);

  // A pick in the row is the user's: it switches the tab's view and keeps the tab.
  fireEvent.click(within(row as HTMLElement).getByRole('tab', { name: 'Files' }));
  assert.deepEqual(vi.mocked(actions.setTabView).mock.calls, [['left', 'a1', 'files', { pin: true }]]);
});

test('at 360px the row labels only the active view', () => {
  measureLeftPane(360);
  renderRegion();

  const row = viewRow();
  assert.equal(row !== null, true);
  assert.deepEqual(labelledViews(row as HTMLElement), ['Chat']);
});

test('a phone keeps its header with the session title and the project, and has no tab bar', () => {
  renderRegion({ isMobile: true });

  const header = document.querySelector('header');
  assert.equal(header !== null, true);
  assert.equal(within(header as HTMLElement).queryByRole('heading', { name: 'Chat a1' }) !== null, true);
  assert.equal(within(header as HTMLElement).queryByText('Alpha') !== null, true);
  assert.equal(tabBar() === null, true);
  assert.equal(viewRow() === null, true);
});

test('a view bar that does not fit scrolls sideways, a vertical wheel included, with a fade over each hidden side', () => {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
  const scrollLeft = vi.spyOn(Element.prototype, 'scrollLeft', 'get').mockReturnValue(0);
  const { container } = render(
    <PaneViewBar activeTab="chat" setActiveTab={vi.fn()} shouldShowTasksTab={false} shouldShowBrowserTab={false} labels="all" />,
  );
  const scroller = screen.getByRole('tablist', { name: 'Workspace views' }).parentElement as HTMLElement;
  const fades = () => ({
    left: container.querySelector('.bg-gradient-to-r') !== null,
    right: container.querySelector('.bg-gradient-to-l') !== null,
  });
  assert.deepEqual(fades(), { left: false, right: true });

  const scrollBy = vi.fn();
  scroller.scrollBy = scrollBy as unknown as typeof scroller.scrollBy;
  const wheel = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
  scroller.dispatchEvent(wheel);
  assert.equal(wheel.defaultPrevented, true, 'the page does not scroll while the bar takes the wheel');
  assert.deepEqual(scrollBy.mock.calls, [[{ left: 120, behavior: 'auto' }]]);

  scrollLeft.mockReturnValue(300);
  fireEvent.scroll(scroller);
  assert.deepEqual(fades(), { left: true, right: false });
});
