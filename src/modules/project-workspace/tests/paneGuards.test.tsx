import assert from 'node:assert/strict';

import { fireEvent, render, screen, within } from '@testing-library/react';
import type { NavigateFunction } from 'react-router-dom';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type {
  AppTab,
  Project,
  ProjectSession,
  WorkspaceLayout,
  WorkspaceLayoutActions,
  WorkspacePaneState,
  WorkspaceSessionTab,
} from '@/shared/types';

/**
 * What one pane may not show while the other shows it. The server gives a PTY key (project path
 * + session) to one socket, so only one visible pane connects a given terminal: the pane that
 * showed it first keeps it, the other offers "Use it here", and terminals of different sessions
 * run side by side; a hidden pane disconnects. TaskMaster has one project, the focused pane's,
 * so an unfocused pane on another project points there. A tab whose conversation is gone stays
 * and says so.
 */

const panes: { state: Record<string, unknown> } = { state: {} };
const taskMaster: { currentProject: Project | null; enabled: boolean } = { currentProject: null, enabled: false };
const browserUse = { enabled: false };
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
  useUiPreferences: () => ({ showRawParameters: false, showThinking: false, sendByCtrlEnter: false }),
}));
vi.mock('@/modules/chat', () => ({
  ChatInterface: ({ isActive }: { isActive: boolean }) => <div data-testid="chat" data-active={String(isActive)} />,
}));
vi.mock('@/modules/file-tree', () => ({ FileTree: () => <div /> }));
vi.mock('@/modules/standalone-shell', () => ({
  StandaloneShell: ({ project, session }: { project: Project; session: ProjectSession | null }) => (
    <div data-testid="terminal" data-key={`${project.fullPath}_${session?.id ?? 'default'}`} />
  ),
}));
vi.mock('@/modules/git-panel', () => ({ GitPanel: () => <div /> }));
vi.mock('@/modules/plugins', () => ({ usePlugins: () => ({ plugins: [] }), PluginIcon: () => null, PluginTabContent: () => <div /> }));
vi.mock('@/modules/browser-use', () => ({
  BrowserUsePanel: ({ isVisible }: { isVisible: boolean }) => <div data-testid="browser" data-visible={String(isVisible)} />,
  useBrowserUseEnabled: () => browserUse.enabled,
}));
vi.mock('@/modules/task-master', () => ({
  TaskMasterPanel: ({ isVisible }: { isVisible: boolean }) => <div data-testid="task-board" data-visible={String(isVisible)} />,
  useTaskMaster: () => ({ currentProject: taskMaster.currentProject }),
  useTasksSettings: () => ({ tasksEnabled: taskMaster.enabled, isTaskMasterInstalled: taskMaster.enabled }),
  useTaskMasterProjectSync: () => undefined,
}));
vi.mock('@/modules/code-editor', () => ({
  EditorSidebar: () => null,
  useEditorSidebar: () => ({
    editingFile: null,
    editorWidth: 0,
    editorExpanded: false,
    hasManualWidth: false,
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

const ALPHA: Project = { projectId: 'alpha', displayName: 'Alpha', fullPath: '/repo/alpha', path: '/repo/alpha', sessions: [] };
const BETA: Project = { projectId: 'beta', displayName: 'Beta', fullPath: '/repo/beta', path: '/repo/beta', sessions: [] };

const makeTab = (key: string, project: Project, view: AppTab, overrides: Partial<WorkspaceSessionTab> = {}): WorkspaceSessionTab => {
  const sessionId = overrides.sessionId === undefined ? `session-${key}` : overrides.sessionId;
  return {
    key,
    sessionId,
    projectId: project.projectId,
    provider: 'claude',
    title: `Chat ${key}`,
    view,
    isPreview: false,
    session: sessionId ? { id: sessionId, __projectId: project.projectId, __provider: 'claude' } : null,
    ...overrides,
  };
};

const makePane = (tabs: WorkspaceSessionTab[], activeTabKey = tabs[0]?.key ?? null): WorkspacePaneState => ({
  // Ids follow the first tab, so the two panes of a layout differ and a pane keeps its id across renders.
  id: `pane-${tabs[0]?.key ?? 'empty'}`,
  tabs,
  activeTabKey,
  mru: activeTabKey ? [activeTabKey] : [],
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
  const tab = pane?.tabs.find((candidate) => candidate.key === pane.activeTabKey);
  if (!tab || tab.isMissing) {
    return null;
  }
  return [ALPHA, BETA].find((project) => project.projectId === tab.projectId) ?? null;
};

const setLayout = (layout: WorkspaceLayout) => {
  panes.state = {
    layout,
    paneProjects: { left: projectOf(layout.left), right: projectOf(layout.right) },
    projects: [ALPHA, BETA],
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

const regionElement = (canSplit = true) => (
  <WorkspaceChromeProvider
    value={{
      isImmersive: false,
      isBrowserFullscreen: false,
      toggleImmersive: vi.fn(),
      exitImmersive: vi.fn(),
      isSidebarPeekOpen: false,
      setSidebarPeekOpen: vi.fn(),
      canSplit,
    }}
  >
    <ProjectMainRegion isMobile={false} ws={null} sendMessage={() => undefined} navigate={vi.fn() as unknown as NavigateFunction} />
  </WorkspaceChromeProvider>
);

const panel = (side: 'left' | 'right') => document.getElementById(`pane-${side}-tabpanel`) as HTMLElement;
const terminalsIn = (side: 'left' | 'right') => within(panel(side)).queryAllByTestId('terminal').length;
const showsShellNotice = (side: 'left' | 'right') => within(panel(side)).queryByText('This terminal is open in the other pane') !== null;

beforeEach(() => {
  actions = makeActions();
  taskMaster.currentProject = ALPHA;
  taskMaster.enabled = false;
  browserUse.enabled = false;
});

test('the pane that showed a terminal first keeps it; the other offers to take it over', () => {
  // The same session open on both sides, the left one already on its terminal.
  setLayout({
    left: makePane([makeTab('a1', ALPHA, 'shell', { sessionId: 'shared' })]),
    right: makePane([makeTab('b1', ALPHA, 'chat', { sessionId: 'shared' })]),
    focusedSide: 'left',
    splitRatio: 0.5,
  });
  const view = render(regionElement());
  assert.equal(terminalsIn('left'), 1);

  // The right pane switches to Shell too, and is focused: the left one still keeps the terminal.
  setLayout({
    left: makePane([makeTab('a1', ALPHA, 'shell', { sessionId: 'shared' })]),
    right: makePane([makeTab('b1', ALPHA, 'shell', { sessionId: 'shared' })]),
    focusedSide: 'right',
    splitRatio: 0.5,
  });
  view.rerender(regionElement());
  assert.equal(terminalsIn('left'), 1);
  assert.equal(terminalsIn('right'), 0, 'the second pane does not connect the same PTY');
  assert.equal(showsShellNotice('right'), true);

  fireEvent.click(within(panel('right')).getByRole('button', { name: 'Use it here' }));
  assert.equal(terminalsIn('right'), 1, 'the lease moved');
  assert.equal(terminalsIn('left'), 0);
  assert.equal(showsShellNotice('left'), true);
});

test('terminals of different sessions run side by side', () => {
  setLayout({
    left: makePane([makeTab('a1', ALPHA, 'shell')]),
    right: makePane([makeTab('b1', ALPHA, 'shell')]),
    focusedSide: 'left',
    splitRatio: 0.5,
  });
  render(regionElement());

  assert.equal(terminalsIn('left'), 1);
  assert.equal(terminalsIn('right'), 1);
  assert.equal(showsShellNotice('left') || showsShellNotice('right'), false);
});

test('a pane hidden by a collapsed split disconnects its terminal and pauses its chat', () => {
  setLayout({
    left: makePane([makeTab('a1', ALPHA, 'chat')]),
    right: makePane([makeTab('b1', ALPHA, 'shell')]),
    focusedSide: 'left',
    splitRatio: 0.5,
  });
  const view = render(regionElement(false));
  assert.equal(terminalsIn('right'), 0, 'the hidden pane does not hold a PTY');
  assert.equal(within(panel('left')).getByTestId('chat').getAttribute('data-active'), 'true');

  setLayout({
    left: makePane([makeTab('a1', ALPHA, 'chat')]),
    right: makePane([makeTab('b1', ALPHA, 'shell')]),
    focusedSide: 'right',
    splitRatio: 0.5,
  });
  view.rerender(regionElement(false));
  assert.equal(terminalsIn('right'), 1, 'shown again, it reconnects');
  assert.equal(within(panel('left')).getByTestId('chat').getAttribute('data-active'), 'false', 'the hidden chat is inactive');
});

test('tasks in an unfocused pane on another project point to the focused pane', () => {
  taskMaster.enabled = true;
  taskMaster.currentProject = ALPHA;
  setLayout({
    left: makePane([makeTab('a1', ALPHA, 'tasks')]),
    right: makePane([makeTab('b1', BETA, 'tasks')]),
    focusedSide: 'left',
    splitRatio: 0.5,
  });
  const view = render(regionElement());

  assert.equal(within(panel('left')).getByTestId('task-board').getAttribute('data-visible'), 'true');
  assert.equal(within(panel('right')).queryByTestId('task-board') === null, true, 'the other project never shows the focused one\'s tasks');
  assert.ok(within(panel('right')).getByText('Tasks follow the focused pane'));
  fireEvent.click(within(panel('right')).getByRole('button', { name: 'Focus this pane' }));
  assert.deepEqual(vi.mocked(actions.focusPane).mock.calls, [['right']]);

  // The same project on both sides: the unfocused pane shows the board too.
  setLayout({
    left: makePane([makeTab('a1', ALPHA, 'tasks')]),
    right: makePane([makeTab('b2', ALPHA, 'tasks')]),
    focusedSide: 'left',
    splitRatio: 0.5,
  });
  view.rerender(regionElement());
  assert.equal(within(panel('right')).getByTestId('task-board').getAttribute('data-visible'), 'true');
});

test('a tab whose conversation is gone stays, says so and can be closed', () => {
  setLayout({
    left: makePane(
      [makeTab('a1', ALPHA, 'chat'), makeTab('m1', ALPHA, 'chat', { projectId: '', isMissing: true, title: '' })],
      'm1',
    ),
    right: null,
    focusedSide: 'left',
    splitRatio: 0.5,
  });
  render(regionElement());

  assert.ok(within(panel('left')).getByText('This conversation no longer exists'));
  assert.equal(screen.getAllByRole('tab').length, 2, 'the tab is still listed');
  assert.equal(within(panel('left')).queryByTestId('chat') === null, true);
  fireEvent.click(within(panel('left')).getByRole('button', { name: 'Close tab' }));
  assert.deepEqual(vi.mocked(actions.closeTab).mock.calls, [['left', 'm1']]);
});

test('a pane hidden by a collapsed split tells its Tasks board and browser they are not on screen', () => {
  taskMaster.enabled = true;
  browserUse.enabled = true;
  const layout = (focusedSide: 'left' | 'right'): WorkspaceLayout => ({
    left: makePane([makeTab('a1', ALPHA, 'browser')]),
    right: makePane([makeTab('b1', ALPHA, 'tasks')]),
    focusedSide,
    splitRatio: 0.5,
  });
  const visibility = (side: 'left' | 'right', testId: string) => within(panel(side)).getByTestId(testId).getAttribute('data-visible');

  setLayout(layout('left'));
  const view = render(regionElement(false));
  assert.equal(visibility('left', 'browser'), 'true');
  assert.equal(visibility('right', 'task-board'), 'false', 'the hidden board stops polling');

  setLayout(layout('right'));
  view.rerender(regionElement(false));
  assert.equal(visibility('right', 'task-board'), 'true');
  assert.equal(visibility('left', 'browser'), 'false', 'the hidden browser stops streaming');

  // Side by side both are on screen.
  view.rerender(regionElement(true));
  assert.equal(visibility('left', 'browser'), 'true');
  assert.equal(visibility('right', 'task-board'), 'true');
});
