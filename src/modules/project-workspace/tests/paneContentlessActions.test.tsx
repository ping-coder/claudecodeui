import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { Project, ProjectSession, SlashCommand } from '@/shared/types';

/**
 * Palette and quick-settings actions picked while the focused pane shows nothing. The action opens one
 * new chat in that pane and runs there once the chat is on screen; when the user declines the open (it
 * would drop unsaved edits), the action goes with it and never lands on what the pane shows later. Runs
 * the real project state (layout, navigation, the command state's setActiveTab), pane group, panes,
 * WorkspaceMain, palette registry and quick settings region; the chat, the editor and the heavy views
 * are stand-ins.
 */

// Hoisted: the i18n import above already loads the API module, before this file's own constants exist.
const { projectsResponse } = vi.hoisted(() => ({ projectsResponse: vi.fn() }));

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectTaskmaster: async () => ({ ok: false }),
    projectSessions: async () => ({ ok: false }),
    sessionDetails: async () => ({ ok: false, status: 404 }),
  },
}));

const NO_SESSIONS: ReadonlySet<string> = new Set();
const noop = () => undefined;
// Text each chat took from the palette, as `<session id, or draft>:<text>`.
const insertedTexts: string[] = [];
// Files the panes' editors were asked to open, as `<project>:<path>`.
const openedFiles: string[] = [];

vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useBusySessionIdSet: () => NO_SESSIONS,
  useBackgroundSessionIdSet: () => NO_SESSIONS,
}));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ connectionStatus: 'connected' }) }));
vi.mock('@/shared/context/UiPreferencesContext', () => ({
  useUiPreferences: () => ({ showRawParameters: false, showThinking: false, sendByCtrlEnter: false }),
}));
// Like the real chat: only the focused pane's chat takes text from other modules.
vi.mock('@/modules/chat', async () => {
  const { useWorkspacePane } = await import('@/shared/context/WorkspacePaneContext');
  const { usePaletteOpsRegister } = await import('@/modules/command-palette');
  return {
    ChatInterface: ({ selectedSession }: { selectedSession: ProjectSession | null }) => {
      const { isFocusedPane } = useWorkspacePane();
      usePaletteOpsRegister(isFocusedPane
        ? { insertComposerText: (text: string) => insertedTexts.push(`${selectedSession?.id ?? 'draft'}:${text}`) }
        : {});
      return <div data-testid="chat" />;
    },
  };
});
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
  EditorSidebar: () => <div />,
  useEditorSidebar: ({ selectedProject }: { selectedProject: Project | null }) => ({
    editingFile: null,
    editorWidth: 0,
    editorExpanded: false,
    hasManualWidth: false,
    resizeHandleRef: { current: null },
    handleFileOpen: (filePath: string) => {
      openedFiles.push(`${selectedProject?.projectId}:${filePath}`);
      return true;
    },
    handleCloseEditor: noop,
    handleToggleEditorExpand: noop,
    handleResizeStart: noop,
    handleUnsavedChangesChange: noop,
  }),
}));
vi.mock('@/modules/project-workspace/hooks/useFileOpenResolver', () => ({
  useFileOpenResolver: (_project: Project | null, open: (filePath: string) => void) => open,
}));
// The panel's Commands tab, reduced to one command.
vi.mock('@/modules/quick-settings-panel', () => ({
  QuickSettingsPanel: ({ onInsertCommand }: { onInsertCommand?: (command: SlashCommand) => void }) => (
    <button type="button" onClick={() => onInsertCommand?.({ name: '/review' } as SlashCommand)}>Insert /review</button>
  ),
}));

const { PaletteOpsProvider, usePaletteOps } = await import('@/modules/command-palette');
const { ProjectsStateProvider, useProjectPanesState } = await import('@/modules/project-workspace/context/ProjectsStateContext');
const { WorkspaceChromeProvider } = await import('@/modules/project-workspace/context/WorkspaceChromeContext');
const { default: ProjectMainRegion } = await import('@/modules/project-workspace/ProjectMainRegion');
const { default: ProjectQuickSettingsRegion } = await import('@/modules/project-workspace/ProjectQuickSettingsRegion');

const ALPHA: Project = {
  projectId: 'alpha',
  displayName: 'Alpha',
  fullPath: '/repo/alpha',
  path: '/repo/alpha',
  sessions: [{ id: 'a1', summary: 'Chat a1', __provider: 'claude' }, { id: 'a2', summary: 'Chat a2', __provider: 'claude' }],
  sessionMeta: { hasMore: false, total: 2 },
};
const BETA: Project = {
  projectId: 'beta',
  displayName: 'Beta',
  fullPath: '/repo/beta',
  path: '/repo/beta',
  sessions: [{ id: 'b1', summary: 'Chat b1', __provider: 'claude' }],
  sessionMeta: { hasMore: false, total: 1 },
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

const navigate = vi.fn() as unknown as NavigateFunction;
const subscribe = () => noop;

type PanesState = ReturnType<typeof useProjectPanesState>;
type PaletteOps = ReturnType<typeof usePaletteOps>;
const harness: { panes: PanesState | null; ops: PaletteOps | null } = { panes: null, ops: null };
const panes = () => harness.panes as PanesState;

function HarnessProbe() {
  const panesState = useProjectPanesState();
  const ops = usePaletteOps();
  useLayoutEffect(() => {
    harness.panes = panesState;
    harness.ops = ops;
  });
  return null;
}

function Workspace() {
  return (
    <PaletteOpsProvider>
      <ProjectsStateProvider navigate={navigate} subscribe={subscribe} isMobile={false} isSessionProcessing={() => false}>
        <WorkspaceChromeProvider value={CHROME}>
          <ProjectMainRegion isMobile={false} ws={null} sendMessage={noop} navigate={navigate} />
          <ProjectQuickSettingsRegion />
          <HarnessProbe />
        </WorkspaceChromeProvider>
      </ProjectsStateProvider>
    </PaletteOpsProvider>
  );
}

// Animation frames, run by hand: the pending action runs a frame after its chat is on screen.
const frames: FrameRequestCallback[] = [];
const runFrames = () => {
  act(() => {
    frames.splice(0).forEach((callback) => callback(0));
  });
};

let confirm = vi.spyOn(window, 'confirm');

/** Renders the workspace once the first load is in; with one project, that load opened its new chat on its own. */
const renderWorkspace = async (projects: Project[]) => {
  projectsResponse.mockResolvedValue({ ok: true, json: async () => projects });
  render(<Workspace />);
  await waitFor(() => assert.equal(panes().isLoadingProjects, false));
};

const activeTabOf = (side: 'left' | 'right') => {
  const pane = side === 'left' ? panes().layout.left : panes().layout.right;
  return pane?.tabs.find((tab) => tab.key === pane.activeTabKey) ?? null;
};

/** One project, as for a first-time user: the first load's new chat on the left, split, the new right pane empty and focused. */
const renderSplitWithEmptyFocusedPane = async ({ leftEditorUnsaved = false } = {}) => {
  await renderWorkspace([ALPHA]);
  await waitFor(() => assert.equal(panes().layout.left.tabs[0]?.sessionId, null, 'the first load opened the new chat'));
  if (leftEditorUnsaved) {
    // What the left pane's WorkspaceMain reports once its editor holds an unsaved edit.
    act(() => panes().setPaneEditorUnsaved(panes().layout.left.id, true));
  }
  act(() => panes().actions.split());
  assert.equal(panes().layout.focusedSide, 'right');
  assert.equal(panes().layout.right?.tabs.length, 0);
};

/** Opens a2 in the right pane, as a click in the sidebar's Open-in switch would. */
const openA2OnTheRight = () => {
  act(() => panes().actions.openSession({ id: 'a2', summary: 'Chat a2', __provider: 'claude', __projectId: 'alpha' }, { target: 'right' }));
  runFrames();
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  insertedTexts.length = 0;
  openedFiles.length = 0;
  harness.panes = null;
  harness.ops = null;
  frames.length = 0;
  projectsResponse.mockReset();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  // jsdom has no ResizeObserver; the panes observe their width with it.
  vi.stubGlobal('ResizeObserver', class {
    observe() {}

    unobserve() {}

    disconnect() {}
  });
  confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('a palette file open in an empty focused pane opens a new chat of the other pane\'s project on Files, then the file in its editor', async () => {
  await renderWorkspace([ALPHA, BETA]);
  act(() => panes().actions.openSession({ id: 'a1', summary: 'Chat a1', __provider: 'claude', __projectId: 'alpha' }));
  act(() => panes().actions.split());

  act(() => harness.ops?.openFile('README.md'));
  assert.deepEqual(openedFiles, [], 'nothing to open it in until the new chat is on screen');
  runFrames();

  assert.equal(activeTabOf('right')?.sessionId, null, 'the new chat, in the pane the user is in');
  assert.equal(activeTabOf('right')?.projectId, 'alpha');
  assert.equal(activeTabOf('right')?.view, 'files');
  assert.deepEqual(openedFiles, ['alpha:README.md']);
});

test('a slash command picked in a lone empty pane lands in the composer of the new chat it opens', async () => {
  await renderWorkspace([ALPHA, BETA]);
  assert.equal(panes().layout.left.tabs.length, 0, 'two projects: nothing opens on its own');

  fireEvent.click(screen.getByRole('button', { name: 'Insert /review' }));
  runFrames();

  assert.equal(activeTabOf('left')?.sessionId, null);
  assert.equal(activeTabOf('left')?.view, 'chat');
  assert.deepEqual(insertedTexts, ['draft:/review ']);
});

test('a slash command picked while the focused pane is empty opens one new chat there and lands in its composer', async () => {
  await renderSplitWithEmptyFocusedPane();

  fireEvent.click(screen.getByRole('button', { name: 'Insert /review' }));
  runFrames();

  // The project's one new chat moves into the pane the user is in, and the command lands in it.
  assert.deepEqual(insertedTexts, ['draft:/review ']);
  assert.equal(confirm.mock.calls.length, 0);
  assert.equal(activeTabOf(panes().layout.focusedSide)?.sessionId, null);
});

test('declining the unsaved-edits question asks once and drops the command: it never lands in a chat opened later', async () => {
  await renderSplitWithEmptyFocusedPane({ leftEditorUnsaved: true });

  fireEvent.click(screen.getByRole('button', { name: 'Insert /review' }));
  runFrames();
  assert.equal(confirm.mock.calls.length, 1, 'one pick, one question');
  assert.equal(panes().layout.right?.tabs.length, 0, 'declined: the layout is as it was');

  openA2OnTheRight();

  assert.deepEqual(insertedTexts, [], 'nothing typed into a2');
  assert.equal(confirm.mock.calls.length, 1);
});

test('a palette file open declined the same way does not switch a conversation opened later to Files', async () => {
  await renderSplitWithEmptyFocusedPane({ leftEditorUnsaved: true });

  act(() => harness.ops?.openFile('README.md'));
  runFrames();
  assert.equal(confirm.mock.calls.length, 1);

  openA2OnTheRight();

  const a2Tab = panes().layout.right?.tabs.find((tab) => tab.sessionId === 'a2');
  assert.equal(a2Tab?.view, 'chat');
  assert.deepEqual(openedFiles, []);
});
