import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type {
  Project,
  SessionEstablishedContext,
  WorkspaceLayout,
  WorkspaceLayoutActions,
  WorkspacePaneState,
  WorkspaceSessionTab,
} from '@/shared/types';

/**
 * Which pane is focused. A pointer press anywhere in a pane focuses it before the click acts, so
 * the first click already lands there. Keyboard focus moves the pane focus only right after a
 * Tab key; programmatic focus (autofocus, a dialog returning focus) does not. Typing in a pane
 * keeps its preview tab open. Only the focused pane registers the command palette's file
 * operations, whatever order panes gain focus or unmount in.
 */

const panes: { state: Record<string, unknown> } = { state: {} };
const openedFiles: string[] = [];
// Text the focused pane's chat took from the palette, as `<project>:<text>`.
const insertedTexts: string[] = [];
type ChatProps = {
  selectedProject: Project;
  onFileOpen?: (filePath: string) => void;
  onNavigateToSession?: (sessionId: string) => void;
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
};
// The props each pane's chat got at its latest render, by side.
const chatProps: Partial<Record<'left' | 'right', ChatProps>> = {};
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
// The chat reads its pane from WorkspacePaneContext; a file link in it opens through the pane's own action.
vi.mock('@/modules/chat', async () => {
  const { useWorkspacePane } = await import('@/shared/context/WorkspacePaneContext');
  const { usePaletteOpsRegister } = await import('@/modules/command-palette');
  return {
    ChatInterface: (props: ChatProps) => {
      const { selectedProject, onFileOpen, onNavigateToSession, onSessionEstablished } = props;
      const { side, isFocusedPane, openFileInEditor } = useWorkspacePane();
      chatProps[side ?? 'left'] = props;
      // Like the real chat: only the focused pane takes text from other modules.
      usePaletteOpsRegister(isFocusedPane
        ? { insertComposerText: (text: string) => insertedTexts.push(`${selectedProject.projectId}:${text}`) }
        : {});
      return (
        <div data-testid={`chat-${side}`} data-focused={String(isFocusedPane)}>
          <textarea aria-label={`composer ${selectedProject.projectId}`} data-slot="prompt-input-textarea" />
          <button type="button" onClick={() => openFileInEditor?.('src/link.ts', 3)}>{`file link in ${selectedProject.projectId}`}</button>
          <button type="button" onClick={() => onFileOpen?.('src/tool.ts')}>{`tool result file in ${selectedProject.projectId}`}</button>
          <button type="button" onClick={() => onNavigateToSession?.('fork-1')}>{`fork in ${selectedProject.projectId}`}</button>
          <button
            type="button"
            onClick={() => {
              // What the chat does once a first send created the session.
              onSessionEstablished?.('new-1', { provider: 'claude', project: selectedProject, summary: 'First' });
              onNavigateToSession?.('new-1');
            }}
          >
            {`establish in ${selectedProject.projectId}`}
          </button>
        </div>
      );
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
vi.mock('@/modules/code-editor', async () => {
  const { useWorkspacePane } = await import('@/shared/context/WorkspacePaneContext');
  return {
    // The editor reads its pane too: Ctrl/Cmd+S and Esc follow isFocusedPane, the in-pane expansion isSplitPane.
    EditorSidebar: () => {
      const { side, isFocusedPane, isSplitPane } = useWorkspacePane();
      return <div data-testid={`editor-${side}`} data-focused={String(isFocusedPane)} data-split={String(isSplitPane)} />;
    },
    // Each pane's editor records which project a file opened in.
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
  };
});
vi.mock('@/modules/project-workspace/hooks/useFileOpenResolver', () => ({
  useFileOpenResolver: (_project: Project | null, open: (filePath: string) => void) => open,
}));

const { PaletteOpsProvider, usePaletteOps } = await import('@/modules/command-palette');
const { WorkspaceChromeProvider } = await import('@/modules/project-workspace/context/WorkspaceChromeContext');
const { default: ProjectMainRegion } = await import('@/modules/project-workspace/ProjectMainRegion');

const ALPHA: Project = { projectId: 'alpha', displayName: 'Alpha', fullPath: '/repo/alpha', path: '/repo/alpha', sessions: [] };
const BETA: Project = { projectId: 'beta', displayName: 'Beta', fullPath: '/repo/beta', path: '/repo/beta', sessions: [] };

const makeTab = (key: string, project: Project, overrides: Partial<WorkspaceSessionTab> = {}): WorkspaceSessionTab => ({
  key,
  sessionId: `session-${key}`,
  projectId: project.projectId,
  provider: 'claude',
  title: `Chat ${key}`,
  view: 'chat',
  isPreview: false,
  session: { id: `session-${key}`, __projectId: project.projectId, __provider: 'claude' },
  ...overrides,
});

const makePane = (tabs: WorkspaceSessionTab[], id = `pane-${tabs[0]?.key ?? 'empty'}`): WorkspacePaneState => ({
  // Ids follow the first tab unless given, so the two panes of a layout differ and a pane keeps its id across renders.
  id,
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

/** The palette operations as the command palette sees them, captured after each render. */
const palette: { ops: ReturnType<typeof usePaletteOps> | null } = { ops: null };
function PaletteProbe() {
  const ops = usePaletteOps();
  useEffect(() => {
    palette.ops = ops;
  }, [ops]);
  return null;
}

const regionElement = ({ canSplit = true } = {}) => (
  <PaletteOpsProvider>
    <PaletteProbe />
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
  </PaletteOpsProvider>
);

const splitLayout = (focusedSide: 'left' | 'right'): WorkspaceLayout => ({
  left: makePane([makeTab('a1', ALPHA)]),
  right: makePane([makeTab('b1', BETA, { isPreview: true })]),
  focusedSide,
  splitRatio: 0.5,
});

beforeEach(() => {
  actions = makeActions();
  openedFiles.length = 0;
  insertedTexts.length = 0;
  palette.ops = null;
  delete chatProps.left;
  delete chatProps.right;
});

test('a press anywhere in an unfocused pane focuses it; presses in the focused pane change nothing', () => {
  setLayout(splitLayout('left'));
  render(regionElement());

  fireEvent.pointerDown(screen.getByLabelText('composer beta'));
  assert.deepEqual(vi.mocked(actions.focusPane).mock.calls, [['right']]);

  fireEvent.pointerDown(screen.getByLabelText('composer alpha'));
  assert.equal(vi.mocked(actions.focusPane).mock.calls.length, 1, 'the focused pane is not focused again');
});

test('focus that follows a Tab key focuses the pane; programmatic focus does not', () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
  setLayout(splitLayout('left'));
  render(regionElement());
  const betaComposer = screen.getByLabelText('composer beta') as HTMLTextAreaElement;
  const alphaComposer = screen.getByLabelText('composer alpha') as HTMLTextAreaElement;

  betaComposer.focus();
  assert.equal(vi.mocked(actions.focusPane).mock.calls.length, 0, 'autofocus-style focus leaves the pane focus alone');

  alphaComposer.focus();
  fireEvent.keyDown(window, { key: 'Tab' });
  now.mockReturnValue(1050);
  betaComposer.focus();
  assert.deepEqual(vi.mocked(actions.focusPane).mock.calls, [['right']]);

  alphaComposer.focus();
  now.mockReturnValue(1400);
  betaComposer.focus();
  assert.equal(vi.mocked(actions.focusPane).mock.calls.length, 1, 'a Tab long ago does not count');
});

test('typing in a pane keeps its preview tab open', () => {
  setLayout(splitLayout('left'));
  render(regionElement());

  fireEvent.input(screen.getByLabelText('composer beta'));
  assert.deepEqual(vi.mocked(actions.pinTab).mock.calls, [['right', 'b1']]);

  fireEvent.input(screen.getByLabelText('composer alpha'));
  assert.equal(vi.mocked(actions.pinTab).mock.calls.length, 1, 'a kept tab needs nothing');
});

test('only the focused pane registers palette file operations, across focus changes and unmounts', () => {
  setLayout(splitLayout('left'));
  const view = render(regionElement());
  const ops = () => palette.ops as NonNullable<typeof palette.ops>;

  ops().openFile('one.ts');
  assert.deepEqual(openedFiles, ['alpha:one.ts']);

  setLayout(splitLayout('right'));
  view.rerender(regionElement());
  ops().openFile('two.ts');
  ops().openFileInEditor('three.ts');
  assert.deepEqual(openedFiles.slice(1), ['beta:two.ts', 'beta:three.ts'], 'operations follow the focus');

  // The focused right pane closes: its registration must not outlive it.
  setLayout({ left: makePane([makeTab('a1', ALPHA)]), right: null, focusedSide: 'left', splitRatio: 0.5 });
  view.rerender(regionElement());
  ops().openFile('four.ts');
  assert.deepEqual(openedFiles.slice(3), ['alpha:four.ts']);

  // Split again with the right focused, then the left empties and the right pane moves into its slot.
  setLayout(splitLayout('right'));
  view.rerender(regionElement());
  setLayout({ left: makePane([makeTab('b1', BETA)]), right: null, focusedSide: 'left', splitRatio: 0.5 });
  view.rerender(regionElement());
  ops().openFile('five.ts');
  assert.deepEqual(openedFiles.slice(4), ['beta:five.ts']);

  // Opening a directory switches the focused pane's tab to Files as the user's choice.
  ops().openDirectory('src');
  assert.deepEqual(vi.mocked(actions.setTabView).mock.calls.at(-1), ['left', 'b1', 'files', { pin: true }]);

  view.unmount();
  ops().openFile('six.ts');
  assert.deepEqual(openedFiles.slice(5), [], 'nothing answers once every pane is gone');
});

test('picking a view keeps a preview tab open; the fallback off a view that went away leaves it a preview', () => {
  setLayout(splitLayout('left'));
  const view = render(regionElement());

  // The right tab is a preview: choosing Files in its header is the user's choice.
  fireEvent.click(screen.getAllByRole('tab', { name: 'Files' })[1]);
  assert.deepEqual(vi.mocked(actions.setTabView).mock.calls, [['right', 'b1', 'files', { pin: true }]]);

  // Tasks are switched off, so a tab left on Tasks falls back to Chat on its own: no pin.
  vi.mocked(actions.setTabView).mockClear();
  setLayout({
    left: makePane([makeTab('a1', ALPHA)]),
    right: makePane([makeTab('b1', BETA, { isPreview: true, view: 'tasks' })]),
    focusedSide: 'left',
    splitRatio: 0.5,
  });
  view.rerender(regionElement());
  assert.deepEqual(vi.mocked(actions.setTabView).mock.calls, [['right', 'b1', 'chat', { pin: false }]]);
});

test('the chat and editor in each pane read their own pane, and a file link opens in that pane focused or not', () => {
  setLayout(splitLayout('left'));
  const view = render(regionElement());

  assert.equal(screen.getByTestId('chat-left').getAttribute('data-focused'), 'true');
  assert.equal(screen.getByTestId('chat-right').getAttribute('data-focused'), 'false');
  assert.equal(screen.getByTestId('editor-left').getAttribute('data-focused'), 'true', 'the editor sits inside the pane context too');
  assert.equal(screen.getByTestId('editor-right').getAttribute('data-focused'), 'false');
  assert.equal(screen.getByTestId('editor-right').getAttribute('data-split'), 'true');

  // A link in the unfocused right pane opens in the right pane's editor, under its project.
  fireEvent.click(screen.getByRole('button', { name: 'file link in beta' }));
  assert.deepEqual(openedFiles, ['beta:src/link.ts']);

  // Collapsed, the visible pane is not sharing the main area any more.
  view.rerender(regionElement({ canSplit: false }));
  assert.equal(screen.getByTestId('editor-left').getAttribute('data-split'), 'false');
});

/** Animation frames the panes request, run by hand. */
const captureFrames = () => {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  return () => frames.splice(0).forEach((callback) => callback(0));
};

const draftTab = (key: string, project: Project): WorkspaceSessionTab => makeTab(key, project, { sessionId: null, session: null, title: '' });

test('a focused pane that shows nothing opens a new chat for a palette action, then runs the action there', () => {
  const runFrames = captureFrames();
  // Split a moment ago: the right pane is empty and focused; the palette lists the fallback project's files.
  setLayout({ left: makePane([makeTab('a1', ALPHA)]), right: makePane([]), focusedSide: 'right', splitRatio: 0.5 });
  const view = render(regionElement());
  const ops = () => palette.ops as NonNullable<typeof palette.ops>;

  ops().openFile('README.md');
  assert.deepEqual(vi.mocked(actions.openNewSession).mock.calls, [[ALPHA, { target: 'right', view: 'files' }]]);
  assert.deepEqual(openedFiles, [], 'nothing to open it in yet');

  // The new chat shows up in the right pane: the file opens in its editor, under its project.
  // The new chat shows up in the same pane (same id).
  setLayout({ left: makePane([makeTab('a1', ALPHA)]), right: makePane([draftTab('d1', ALPHA)], 'pane-empty'), focusedSide: 'right', splitRatio: 0.5 });
  view.rerender(regionElement());
  runFrames();
  assert.deepEqual(openedFiles, ['alpha:README.md']);
});

test('a slash command picked while the focused pane is empty lands in the composer of the chat it opens', () => {
  const runFrames = captureFrames();
  setLayout({ left: makePane([]), right: null, focusedSide: 'left', splitRatio: 0.5 });
  const view = render(regionElement());

  (palette.ops as NonNullable<typeof palette.ops>).insertComposerText('/review ');
  assert.deepEqual(vi.mocked(actions.openNewSession).mock.calls, [[ALPHA, { target: 'left', view: 'chat' }]]);

  setLayout({ left: makePane([draftTab('d1', ALPHA)], 'pane-empty'), right: null, focusedSide: 'left', splitRatio: 0.5 });
  view.rerender(regionElement());
  runFrames();
  assert.deepEqual(insertedTexts, ['alpha:/review ']);
});

test('a file opened from the chat, by a link or a tool result, keeps a preview tab open', () => {
  setLayout(splitLayout('right'));
  render(regionElement());

  fireEvent.click(screen.getByRole('button', { name: 'file link in beta' }));
  fireEvent.click(screen.getByRole('button', { name: 'tool result file in beta' }));

  assert.deepEqual(openedFiles, ['beta:src/link.ts', 'beta:src/tool.ts']);
  assert.deepEqual(vi.mocked(actions.pinTab).mock.calls, [['right', 'b1'], ['right', 'b1']]);
});

test('a fork opens kept in its own pane, in the background, under the project its row names', () => {
  setLayout(splitLayout('left'));
  render(regionElement());

  fireEvent.click(screen.getByRole('button', { name: 'fork in beta' }));

  // No project or provider read off whatever tab the pane shows when the fork comes back.
  assert.deepEqual(vi.mocked(actions.openSession).mock.calls, [[
    { id: 'fork-1' },
    { target: 'right', preview: false, history: 'push', inBackground: true },
  ]]);
});

test('a first send converts the draft that sent it and opens nothing more; a late one never takes a newer draft', () => {
  setLayout({ left: makePane([makeTab('a1', ALPHA)]), right: makePane([draftTab('d1', BETA)], 'pane-right'), focusedSide: 'right', splitRatio: 0.5 });
  const view = render(regionElement());

  fireEvent.click(screen.getByRole('button', { name: 'establish in beta' }));
  assert.equal(vi.mocked(actions.establishDraft).mock.calls.length, 1);
  assert.deepEqual(vi.mocked(actions.establishDraft).mock.calls[0][2], { draftTabKey: 'd1' });
  assert.equal(vi.mocked(actions.openSession).mock.calls.length, 0, 'no second open: no focus pulled back, no URL push, no pane rebuilt');

  // A send started on d1; d1 is closed and a new draft d2 opened in the same pane before the session comes back.
  const sentFromD1 = chatProps.right as ChatProps;
  setLayout({ left: makePane([makeTab('a1', ALPHA)]), right: makePane([draftTab('d2', BETA)], 'pane-right'), focusedSide: 'right', splitRatio: 0.5 });
  view.rerender(regionElement());
  sentFromD1.onSessionEstablished?.('late-1', { provider: 'claude', project: BETA, summary: 'Late' });
  sentFromD1.onNavigateToSession?.('late-1');
  assert.deepEqual(vi.mocked(actions.establishDraft).mock.calls[1][2], { draftTabKey: 'd1' }, 'bound to the draft that sent it');
  assert.equal(vi.mocked(actions.openSession).mock.calls.length, 0);
});
