import assert from 'node:assert/strict';

import { fireEvent, screen, within } from '@testing-library/react';
import { useEffect } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type * as TaskMasterModule from '@/modules/task-master';
import type {
  AppTab,
  Project,
  ServerEvent,
  WorkspaceLayout,
  WorkspaceLayoutActions,
  WorkspacePaneState,
  WorkspaceSessionTab,
} from '@/shared/types';

/**
 * TaskMaster holds one current project. Before the split every WorkspaceMain synced it to its own
 * project, so two panes on different projects took turns overwriting it, and each turn refetched
 * that project's TaskMaster details (the probe counted 101 requests in 500 ms). The pane group now
 * syncs it once, from the focused pane: it settles on that project with one request, follows each
 * focus change with one more, and an unfocused pane on another project never takes it over.
 *
 * Rendered with a plain root, outside act(): a ping-pong would keep act() flushing effects forever,
 * while here it shows up the way it did in the browser, as a request count.
 */

const { projectTaskmaster } = vi.hoisted(() => ({
  projectTaskmaster: vi.fn(async (_projectId: string) => ({
    ok: true,
    json: async () => ({ taskmaster: { hasTaskmaster: true, status: 'configured' } }),
  })),
}));

vi.mock('@/shared/api', () => ({
  api: {
    projectTaskmaster,
    taskmaster: {
      tasks: async () => ({ ok: true, json: async () => ({ tasks: [] }) }),
      mcpStatus: async () => ({ ok: true, json: async () => ({}) }),
    },
  },
}));

// Constants, so the provider's callbacks keep their identity across renders.
const AUTH = { user: { id: 1 }, token: 'token', isLoading: false };
const WEBSOCKET = {
  connectionStatus: 'connected',
  subscribe: (_listener: (event: ServerEvent) => void) => () => undefined,
};
const PREFERENCES = { showRawParameters: false, showThinking: false, sendByCtrlEnter: false };
const NO_SESSIONS: ReadonlySet<string> = new Set();
const noop = () => undefined;
const panes: { state: Record<string, unknown> } = { state: {} };

vi.mock('@/modules/auth', () => ({ useAuth: () => AUTH }));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => WEBSOCKET }));
vi.mock('@/shared/context/UiPreferencesContext', () => ({ useUiPreferences: () => PREFERENCES }));
vi.mock('@/modules/project-workspace/context/ProjectsStateContext', () => ({
  useProjectPanesState: () => panes.state,
}));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useBusySessionIdSet: () => NO_SESSIONS,
  useBackgroundSessionIdSet: () => NO_SESSIONS,
}));
// The real TaskMaster context and sync hook; only the board itself is a probe of what it would show.
vi.mock('@/modules/task-master', async (importOriginal) => {
  const actual = await importOriginal<typeof TaskMasterModule>();
  return {
    ...actual,
    useTasksSettings: () => ({ tasksEnabled: true, isTaskMasterInstalled: true }),
    TaskMasterPanel: ({ isVisible }: { isVisible: boolean }) => {
      const { currentProject } = actual.useTaskMaster();
      return <div data-testid="task-board" data-project={currentProject?.projectId ?? ''} data-visible={String(isVisible)} />;
    },
  };
});
// Pulled in by the task-master barrel's board and setup modal; neither renders here.
vi.mock('@/modules/prd-editor', () => ({ PRDEditor: () => null }));
vi.mock('@/modules/shell', () => ({ Shell: () => null }));
// Shows whether its pane is focused, so a test can tell when a focus change has rendered.
vi.mock('@/modules/chat', async () => {
  const { useWorkspacePane } = await import('@/shared/context/WorkspacePaneContext');
  return {
    ChatInterface: () => {
      const { side, isFocusedPane } = useWorkspacePane();
      return <div data-testid={`chat-${side}`} data-focused={String(isFocusedPane)} />;
    },
  };
});
vi.mock('@/modules/file-tree', () => ({ FileTree: () => <div /> }));
vi.mock('@/modules/standalone-shell', () => ({ StandaloneShell: () => <div /> }));
vi.mock('@/modules/git-panel', () => ({ GitPanel: () => <div /> }));
vi.mock('@/modules/plugins', () => ({ usePlugins: () => ({ plugins: [] }), PluginIcon: () => null, PluginTabContent: () => <div /> }));
vi.mock('@/modules/browser-use', () => ({ BrowserUsePanel: () => <div />, useBrowserUseEnabled: () => false }));
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

const { TaskMasterProvider, useTaskMaster } = await import('@/modules/task-master');
const { WorkspaceChromeProvider } = await import('@/modules/project-workspace/context/WorkspaceChromeContext');
const { default: ProjectMainRegion } = await import('@/modules/project-workspace/ProjectMainRegion');

const ALPHA: Project = { projectId: 'alpha', displayName: 'Alpha', fullPath: '/repo/alpha', path: '/repo/alpha', sessions: [] };
const BETA: Project = { projectId: 'beta', displayName: 'Beta', fullPath: '/repo/beta', path: '/repo/beta', sessions: [] };

const makeTab = (key: string, project: Project, view: AppTab = 'chat'): WorkspaceSessionTab => ({
  key,
  sessionId: `session-${key}`,
  projectId: project.projectId,
  provider: 'claude',
  title: `Chat ${key}`,
  view,
  isPreview: false,
  session: { id: `session-${key}`, __projectId: project.projectId, __provider: 'claude' },
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
// Every project TaskMaster has been current for, in order; consecutive repeats are not recorded.
let currentProjectHistory: Array<string | null> = [];

function CurrentProjectProbe() {
  const projectId = useTaskMaster().currentProject?.projectId ?? null;
  useEffect(() => {
    currentProjectHistory.push(projectId);
  }, [projectId]);
  return null;
}

const projectOf = (pane: WorkspacePaneState | null): Project | null => {
  const projectId = pane?.tabs.find((tab) => tab.key === pane.activeTabKey)?.projectId;
  return [ALPHA, BETA].find((project) => project.projectId === projectId) ?? null;
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

const CHROME = {
  isImmersive: false,
  isBrowserFullscreen: false,
  toggleImmersive: noop,
  exitImmersive: noop,
  isSidebarPeekOpen: false,
  setSidebarPeekOpen: noop,
  canSplit: true,
};

const workspace = () => (
  <TaskMasterProvider>
    <CurrentProjectProbe />
    <WorkspaceChromeProvider value={CHROME}>
      <ProjectMainRegion isMobile={false} ws={null} sendMessage={noop} navigate={vi.fn() as unknown as NavigateFunction} />
    </WorkspaceChromeProvider>
  </TaskMasterProvider>
);

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousActEnvironment: boolean | undefined;
let root: Root | null = null;
let container: HTMLElement | null = null;

const mount = (element: ReactElement) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(element);
};

const sleep = (ms: number) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/** Polls until the page shows what a step waits for; a slow machine takes longer, a broken page never gets there. */
const waitUntil = async (condition: () => boolean, description: string) => {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > 3000) {
      throw new Error(`timed out waiting until ${description}`);
    }
    await sleep(10);
  }
};

/** Once a step has landed, a quiet stretch in which a ping-pong (or a stray request) would pile up. */
const settle = () => sleep(80);

const requestedProjects = () => projectTaskmaster.mock.calls.map(([projectId]) => projectId);
const panel = (side: 'left' | 'right') => document.getElementById(`pane-${side}-tabpanel`) as HTMLElement;
const currentProjectIs = (projectId: string) => () => currentProjectHistory.at(-1) === projectId;
const isChatFocused = (side: 'left' | 'right') => () => document.querySelector(`[data-testid="chat-${side}"]`)?.getAttribute('data-focused') === 'true';

beforeEach(() => {
  previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  actions = makeActions();
  currentProjectHistory = [];
  projectTaskmaster.mockClear();
});

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

test('two panes on different projects leave TaskMaster on the focused pane\'s project, one request per focus change', async () => {
  setLayout({ left: makePane([makeTab('a1', ALPHA)]), right: makePane([makeTab('b1', BETA)]), focusedSide: 'left', splitRatio: 0.5 });
  mount(workspace());
  await waitUntil(currentProjectIs('alpha'), 'TaskMaster is on Alpha');
  await settle();

  assert.deepEqual(currentProjectHistory, [null, 'alpha']);
  assert.deepEqual(requestedProjects(), ['alpha'], 'the unfocused pane does not pull TaskMaster over to its project');

  setLayout({ left: makePane([makeTab('a1', ALPHA)]), right: makePane([makeTab('b1', BETA)]), focusedSide: 'right', splitRatio: 0.5 });
  root?.render(workspace());
  await waitUntil(currentProjectIs('beta'), 'TaskMaster is on Beta');
  await settle();

  assert.deepEqual(currentProjectHistory, [null, 'alpha', 'beta']);
  assert.deepEqual(requestedProjects(), ['alpha', 'beta']);
});

test('an unfocused pane on Tasks of another project points to the focused pane instead of taking TaskMaster over', async () => {
  setLayout({ left: makePane([makeTab('a1', ALPHA)]), right: makePane([makeTab('b1', BETA, 'tasks')]), focusedSide: 'left', splitRatio: 0.5 });
  mount(workspace());
  await waitUntil(currentProjectIs('alpha'), 'TaskMaster is on Alpha');
  await settle();

  assert.equal(within(panel('right')).queryByTestId('task-board') === null, true, 'the right pane never shows Alpha\'s tasks as Beta\'s');
  assert.ok(within(panel('right')).getByText('Tasks follow the focused pane'));
  assert.deepEqual(requestedProjects(), ['alpha']);

  fireEvent.click(within(panel('right')).getByRole('button', { name: 'Focus this pane' }));
  assert.deepEqual(vi.mocked(actions.focusPane).mock.calls, [['right']]);

  // The layout answers with the focus on the right.
  setLayout({ left: makePane([makeTab('a1', ALPHA)]), right: makePane([makeTab('b1', BETA, 'tasks')]), focusedSide: 'right', splitRatio: 0.5 });
  root?.render(workspace());
  await waitUntil(currentProjectIs('beta'), 'TaskMaster is on Beta');
  await settle();

  assert.equal(within(panel('right')).getByTestId('task-board').getAttribute('data-project'), 'beta');
  assert.equal(within(panel('right')).getByTestId('task-board').getAttribute('data-visible'), 'true');
  assert.deepEqual(requestedProjects(), ['alpha', 'beta']);
  assert.deepEqual(currentProjectHistory, [null, 'alpha', 'beta']);
});

test('focusing an empty pane leaves TaskMaster on the last project and asks for nothing', async () => {
  setLayout({ left: makePane([makeTab('a1', ALPHA)]), right: makePane([]), focusedSide: 'left', splitRatio: 0.5 });
  mount(workspace());
  await waitUntil(currentProjectIs('alpha'), 'TaskMaster is on Alpha');
  await settle();
  assert.deepEqual(requestedProjects(), ['alpha']);

  setLayout({ left: makePane([makeTab('a1', ALPHA)]), right: makePane([]), focusedSide: 'right', splitRatio: 0.5 });
  root?.render(workspace());
  await waitUntil(() => !isChatFocused('left')(), 'the focus has moved off the left pane');
  await settle();

  assert.ok(screen.getByRole('heading', { name: 'This side is empty' }));
  assert.deepEqual(currentProjectHistory, [null, 'alpha']);
  assert.deepEqual(requestedProjects(), ['alpha']);
});
