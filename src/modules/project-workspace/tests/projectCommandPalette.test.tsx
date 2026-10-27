import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { CommandPalette as CommandPaletteComponent } from '@/modules/command-palette';
import type {
  Project,
  WorkspaceLayout,
  WorkspaceLayoutActions,
  WorkspacePaneState,
  WorkspaceSessionTab,
} from '@/shared/types';

/**
 * ProjectCommandPalette binds the command palette to the split workspace: Open tabs lists both panes
 * with live titles, the tab commands act on the focused pane's active tab, and when a palette command
 * moves the focused pane, DOM focus follows into it once the closing dialog has handed focus back.
 */

type CommandPaletteProps = ComponentProps<typeof CommandPaletteComponent>;

let paletteProps: CommandPaletteProps | null = null;

vi.mock('@/modules/command-palette', () => ({
  CommandPalette: (props: CommandPaletteProps) => {
    paletteProps = props;
    return null;
  },
}));

// The workspace state behind the Command and Panes slices: a tiny store, so layout actions re-render.
let layoutState: WorkspaceLayout;
let projectsState: Project[] = [];
let paneProjectsState: Record<'left' | 'right', Project | null> = { left: null, right: null };
const layoutListeners = new Set<() => void>();
const setLayoutState = (next: WorkspaceLayout) => {
  layoutState = next;
  layoutListeners.forEach((listener) => listener());
};
const subscribeToLayout = (listener: () => void) => {
  layoutListeners.add(listener);
  return () => {
    layoutListeners.delete(listener);
  };
};

const handleNewSession = vi.fn<(project: Project) => void>();
const openSettings = vi.fn<(tab?: string) => void>();
const setActiveTab = vi.fn();
const openSessionById = vi.fn<WorkspaceLayoutActions['openSessionById']>();
let actions: WorkspaceLayoutActions;

vi.mock('@/modules/project-workspace/context/ProjectsStateContext', () => ({
  useProjectCommandState: () => ({
    selectedProject: projectsState[0] ?? null,
    handleNewSession,
    openSettings,
    setActiveTab,
    openSessionById,
    layout: useSyncExternalStore(subscribeToLayout, () => layoutState),
    actions,
  }),
  useProjectPanesState: () => ({ projects: projectsState, paneProjects: paneProjectsState }),
}));

const { default: ProjectCommandPalette } = await import('@/modules/project-workspace/ProjectCommandPalette');
const { WorkspaceChromeProvider } = await import('@/modules/project-workspace/context/WorkspaceChromeContext');
const { workspaceLayoutReducer } = await import('@/modules/project-workspace/utils/workspaceLayout');

const toggleImmersive = vi.fn();

const repo: Project = {
  projectId: 'project-1',
  displayName: 'repo',
  fullPath: '/repo',
  sessions: [
    // Renamed since the tab was opened; the tab still holds the old snapshot.
    { id: 'session-renamed', summary: 'Renamed title', __provider: 'claude' },
    // Listed, but without a title yet.
    { id: 'session-untitled', __provider: 'claude' },
  ],
};
// An archived project: not in the list, only known as a pane's own project.
const archived: Project = { projectId: 'project-archived', displayName: 'old-repo', fullPath: '/old-repo' };

const createTab = (key: string, sessionId: string | null, overrides: Partial<WorkspaceSessionTab> = {}): WorkspaceSessionTab => ({
  key,
  sessionId,
  projectId: 'project-1',
  provider: 'claude',
  title: '',
  view: 'chat',
  isPreview: false,
  session: sessionId ? { id: sessionId, __provider: 'claude', __projectId: 'project-1' } : null,
  ...overrides,
});

const createPane = (tabs: WorkspaceSessionTab[], activeTabKey: string | null): WorkspacePaneState => ({
  tabs,
  activeTabKey,
  mru: activeTabKey ? [activeTabKey, ...tabs.map((tab) => tab.key).filter((key) => key !== activeTabKey)] : [],
  draftActivation: 0,
  externalRevision: 0,
});

type ReducerAction = Parameters<typeof workspaceLayoutReducer>[1];
const dispatch = (action: ReducerAction) => setLayoutState(workspaceLayoutReducer(layoutState, action));

/** Layout actions that change the store through the real reducer, so the component sees what they did. */
const createActions = (): WorkspaceLayoutActions => ({
  openSession: vi.fn(),
  openSessionById: vi.fn(),
  openNewSession: vi.fn(),
  establishDraft: vi.fn(),
  activateTab: vi.fn((side, tabKey) => dispatch({ type: 'activate', side, tabKey })),
  closeTab: vi.fn(),
  closeOtherTabs: vi.fn((side, tabKey) => dispatch({ type: 'closeOthers', side, tabKey })),
  closeTabsToRight: vi.fn(),
  closeAllTabs: vi.fn(),
  pinTab: vi.fn(),
  moveTab: vi.fn((from, tabKey, to) => dispatch({ type: 'move', from, tabKey, to, newTabKey: 'tab-copy' })),
  setTabView: vi.fn(),
  focusPane: vi.fn((side) => dispatch({ type: 'focus', side })),
  split: vi.fn(),
  toggleSplit: vi.fn(() => dispatch(layoutState.right ? { type: 'closePane', side: 'right' } : { type: 'split' })),
  closePane: vi.fn((side) => dispatch({ type: 'closePane', side })),
  setSplitRatio: vi.fn(),
});

const renderBinding = ({ canSplit = true, isImmersive = false } = {}) => render(
  <WorkspaceChromeProvider
    value={{
      isImmersive,
      isBrowserFullscreen: false,
      toggleImmersive,
      exitImmersive: () => undefined,
      isSidebarPeekOpen: false,
      setSidebarPeekOpen: () => undefined,
      canSplit,
    }}
  >
    <ProjectCommandPalette />
  </WorkspaceChromeProvider>,
);

const palette = (): CommandPaletteProps => {
  assert.ok(paletteProps, 'the command palette rendered');
  return paletteProps;
};

const workspaceCommands = () => {
  const { workspace } = palette();
  assert.ok(workspace, 'the palette gets workspace commands');
  return workspace;
};

/** Lets the frame the focus hand-off waits for go by. */
const nextFrame = () => act(async () => {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
});

beforeEach(() => {
  paletteProps = null;
  projectsState = [repo];
  paneProjectsState = { left: repo, right: archived };
  actions = createActions();
  handleNewSession.mockReset();
  openSessionById.mockReset();
  toggleImmersive.mockReset();
});

afterEach(() => {
  document.body.querySelectorAll('[data-test-pane]').forEach((element) => element.remove());
});

test('Open tabs lists both panes with live titles and marks only the focused pane\'s active tab', () => {
  setLayoutState({
    left: createPane([
      createTab('tab-renamed', 'session-renamed', { title: 'Old title' }),
      createTab('tab-draft', null),
      createTab('tab-gone', 'session-gone', { projectId: '', isMissing: true }),
    ], 'tab-renamed'),
    right: createPane([
      createTab('tab-archived', 'session-archived', { projectId: 'project-archived', provider: 'codex', title: 'Archived chat' }),
      createTab('tab-untitled', 'session-untitled'),
    ], 'tab-archived'),
    focusedSide: 'right',
    splitRatio: 0.5,
  });
  renderBinding({ canSplit: false, isImmersive: true });

  const workspace = workspaceCommands();
  assert.equal(workspace.canSplit, false);
  assert.equal(workspace.isSplit, true);
  assert.equal(workspace.isImmersive, true);
  assert.deepEqual(workspace.openTabs, [
    { side: 'left', tabKey: 'tab-renamed', title: 'Renamed title', provider: 'claude', projectName: 'repo', isActive: false },
    { side: 'left', tabKey: 'tab-draft', title: 'New chat', provider: 'claude', projectName: 'repo', isActive: false },
    { side: 'left', tabKey: 'tab-gone', title: 'This conversation no longer exists', provider: 'claude', projectName: '', isActive: false },
    { side: 'right', tabKey: 'tab-archived', title: 'Archived chat', provider: 'codex', projectName: 'old-repo', isActive: true },
    { side: 'right', tabKey: 'tab-untitled', title: 'New Session', provider: 'claude', projectName: 'repo', isActive: false },
  ]);

  // A refresh that renames the session in the projects list shows up without touching the tab.
  projectsState = [{ ...repo, sessions: [{ id: 'session-renamed', summary: 'Renamed again', __provider: 'claude' }] }];
  act(() => setLayoutState({ ...layoutState }));
  assert.equal(workspaceCommands().openTabs[0].title, 'Renamed again');
});

test('the tab commands act on the focused pane\'s active tab and the rest pass straight through', async () => {
  setLayoutState({
    left: createPane([createTab('tab-left', 'session-left')], 'tab-left'),
    right: createPane([createTab('tab-right-a', 'session-right-a'), createTab('tab-right-b', 'session-right-b')], 'tab-right-b'),
    focusedSide: 'right',
    splitRatio: 0.5,
  });
  renderBinding();

  act(() => workspaceCommands().onCloseOtherTabs());
  assert.deepEqual(vi.mocked(actions.closeOtherTabs).mock.calls, [['right', 'tab-right-b']]);
  assert.deepEqual(layoutState.right?.tabs.map((tab) => tab.key), ['tab-right-b']);

  act(() => workspaceCommands().onMoveActiveTabToOtherSide());
  assert.deepEqual(vi.mocked(actions.moveTab).mock.calls, [['right', 'tab-right-b', 'left']]);
  // The right pane's last tab moved away, so that side closed and the tab now lives on the left.
  assert.equal(layoutState.right, null);
  assert.deepEqual(layoutState.left.tabs.map((tab) => tab.key), ['tab-left', 'tab-right-b']);

  act(() => workspaceCommands().onToggleSplit());
  assert.equal(vi.mocked(actions.toggleSplit).mock.calls.length, 1);
  assert.equal(layoutState.focusedSide, 'right');

  act(() => workspaceCommands().onCloseFocusedPane());
  assert.deepEqual(vi.mocked(actions.closePane).mock.calls, [['right']]);

  // The focused pane is empty (just split): there is no tab to move or keep, so nothing happens.
  act(() => workspaceCommands().onToggleSplit());
  act(() => workspaceCommands().onMoveActiveTabToOtherSide());
  act(() => workspaceCommands().onCloseOtherTabs());
  assert.equal(vi.mocked(actions.moveTab).mock.calls.length, 1);
  assert.equal(vi.mocked(actions.closeOtherTabs).mock.calls.length, 1);

  act(() => workspaceCommands().onFocusPane('left'));
  act(() => workspaceCommands().onActivateTab('left', 'tab-left'));
  assert.deepEqual(vi.mocked(actions.focusPane).mock.calls, [['left']]);
  assert.deepEqual(vi.mocked(actions.activateTab).mock.calls, [['left', 'tab-left']]);

  workspaceCommands().onToggleFullscreen();
  assert.equal(toggleImmersive.mock.calls.length, 1);

  palette().onOpenSession('session-x', { target: 'other' });
  palette().onStartNewChat(repo);
  assert.deepEqual(openSessionById.mock.calls, [['session-x', { target: 'other' }]]);
  assert.deepEqual(handleNewSession.mock.calls, [[repo]]);
  assert.equal(palette().onOpenSettings, openSettings);
  assert.equal(palette().onShowTab, setActiveTab);
  // Let the focus hand-offs these commands scheduled run here rather than in the next test.
  await nextFrame();
});

test('when a palette command moves the focused pane, DOM focus follows into it', async () => {
  setLayoutState({
    left: createPane([createTab('tab-left', 'session-left', { view: 'files' })], 'tab-left'),
    right: createPane([createTab('tab-right', 'session-right')], 'tab-right'),
    focusedSide: 'left',
    splitRatio: 0.5,
  });
  // The panes as the pane group renders them (pane DOM contract), plus a sidebar control.
  document.body.insertAdjacentHTML('beforeend', `
    <div data-test-pane data-workspace-pane="left" tabindex="-1"><textarea data-slot="prompt-input-textarea"></textarea></div>
    <div data-test-pane data-workspace-pane="right" tabindex="-1"><textarea data-slot="prompt-input-textarea"></textarea></div>
    <button data-test-pane type="button">sidebar</button>
  `);
  const leftPane = document.querySelector<HTMLElement>('[data-workspace-pane="left"]');
  const leftComposer = leftPane?.querySelector<HTMLElement>('textarea');
  const rightComposer = document.querySelector<HTMLElement>('[data-workspace-pane="right"] textarea');
  const sidebarButton = document.querySelector<HTMLElement>('button[data-test-pane]');
  assert.ok(leftPane && leftComposer && rightComposer && sidebarButton);
  renderBinding();

  // The closing palette dialog put focus back where it was opened from: the left composer.
  leftComposer.focus();
  act(() => workspaceCommands().onFocusPane('right'));
  await nextFrame();
  assert.equal(layoutState.focusedSide, 'right');
  assert.equal(document.activeElement === rightComposer, true, 'on the Chat view focus lands in the composer');

  rightComposer.focus();
  act(() => workspaceCommands().onActivateTab('left', 'tab-left'));
  await nextFrame();
  assert.equal(document.activeElement === leftPane, true, 'on another view focus lands on the pane itself');

  // Opening a session the other pane already shows reveals it there, and focus goes along.
  openSessionById.mockImplementation(() => dispatch({ type: 'activate', side: 'right', tabKey: 'tab-right' }));
  leftComposer.focus();
  act(() => palette().onOpenSession('session-right', { target: 'focused', preview: false }));
  await nextFrame();
  assert.equal(document.activeElement === rightComposer, true);

  // A command that leaves the focused pane where it was does not move focus.
  sidebarButton.focus();
  act(() => workspaceCommands().onFocusPane('right'));
  act(() => workspaceCommands().onToggleFullscreen());
  await nextFrame();
  assert.equal(document.activeElement === sidebarButton, true);
});
