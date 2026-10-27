import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useLayoutEffect } from 'react';
import type { ReactNode } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { Project, ProjectSession, SessionEstablishedContext, WorkspaceLayout } from '@/shared/types';

/**
 * A pane's editor buffer lives in its WorkspaceMain. Layout changes must not drop it silently: a pane
 * that shows nothing (its last tab closed, its conversation deleted or gone) keeps WorkspaceMain mounted
 * and hidden, a pane moving into the left slot takes its own editor along, and a change that still
 * unmounts a pane with unsaved edits (a merge, closing a side, its last tab closing) asks first, with the
 * editor's own question; declining leaves the layout as it was. Runs the real layout hooks, pane group,
 * panes, WorkspaceMain and code editor; only the chat, the heavy views and CodeMirror are stand-ins.
 */

// Hoisted: the i18n import above already loads the API module, before this file's own constants exist.
const { readFile, saveFile, sessionDetails } = vi.hoisted(() => ({
  readFile: vi.fn(async () => ({ ok: true, json: async () => ({ content: 'hello' }) })),
  saveFile: vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) })),
  sessionDetails: vi.fn(async () => ({ ok: false, status: 404 })),
}));

vi.mock('@/shared/api', () => ({
  api: { readFile, saveFile, sessionDetails },
  readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
}));
vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }) }));
vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange }: { value: string; onChange?: (value: string) => void }) => (
    <textarea aria-label="code" value={value} onChange={(event) => onChange?.(event.target.value)} />
  ),
}));

const NO_SESSIONS: ReadonlySet<string> = new Set();
// Every chat mount, by pane: a chat that unmounts stops hearing its runs (sounds, [Done], permission prompts).
const chatLifecycle = { mounts: 0, unmounts: 0 };

// The pane state reaches the group through a context here, as it does in the app.
vi.mock('@/modules/project-workspace/context/ProjectsStateContext', async () => {
  const { createContext, useContext } = await import('react');
  const TestPanesContext = createContext<Record<string, unknown> | null>(null);
  return {
    useProjectPanesState: () => useContext(TestPanesContext),
    TestPanesProvider: TestPanesContext.Provider,
  };
});
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useBusySessionIdSet: () => NO_SESSIONS,
  useBackgroundSessionIdSet: () => NO_SESSIONS,
}));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ connectionStatus: 'connected' }) }));
vi.mock('@/shared/context/UiPreferencesContext', () => ({
  useUiPreferences: () => ({ showRawParameters: false, showThinking: false, sendByCtrlEnter: false }),
}));
vi.mock('@/modules/chat', () => ({
  ChatInterface: ({ selectedProject, onFileOpen }: { selectedProject: Project | null; onFileOpen?: (filePath: string) => void }) => {
    useEffect(() => {
      chatLifecycle.mounts += 1;
      return () => {
        chatLifecycle.unmounts += 1;
      };
    }, []);
    return (
      <button type="button" onClick={() => onFileOpen?.(`/repo/${selectedProject?.projectId}/src/app.ts`)}>
        {`open file in ${selectedProject?.projectId}`}
      </button>
    );
  },
}));
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

const { TestPanesProvider } = await import('@/modules/project-workspace/context/ProjectsStateContext') as unknown as {
  TestPanesProvider: (props: { value: Record<string, unknown>; children: ReactNode }) => ReactNode;
};
const { useWorkspaceLayout } = await import('@/modules/project-workspace/hooks/useWorkspaceLayout');
const { useWorkspaceNavigation } = await import('@/modules/project-workspace/hooks/useWorkspaceNavigation');
const { WorkspaceChromeProvider } = await import('@/modules/project-workspace/context/WorkspaceChromeContext');
const { default: ProjectMainRegion } = await import('@/modules/project-workspace/ProjectMainRegion');

const sessionRow = (id: string): ProjectSession => ({ id, summary: `Chat ${id}`, __provider: 'claude' });
const ALPHA: Project = { projectId: 'alpha', displayName: 'Alpha', fullPath: '/repo/alpha', path: '/repo/alpha', sessions: ['a1', 'a2'].map(sessionRow) };
const BETA: Project = { projectId: 'beta', displayName: 'Beta', fullPath: '/repo/beta', path: '/repo/beta', sessions: ['b1'].map(sessionRow) };
const PROJECTS = [ALPHA, BETA];

type Navigation = ReturnType<typeof useWorkspaceNavigation>;
const harness: { navigation: Navigation | null } = { navigation: null };
const nav = () => harness.navigation as Navigation;

function Workspace({ isMobile = false }: { isMobile?: boolean }) {
  const workspace = useWorkspaceLayout({});
  const navigation = useWorkspaceNavigation({
    workspace,
    navigate: vi.fn() as unknown as NavigateFunction,
    projects: PROJECTS,
    isLoadingProjects: false,
    isMobile,
    setSidebarOpen: vi.fn(),
    registerEstablishedSession: (sessionId: string, context: SessionEstablishedContext) => ({ id: sessionId, __projectId: context.project.projectId }),
    clearSessionAttention: () => undefined,
  });
  useLayoutEffect(() => {
    harness.navigation = navigation;
  });
  const panesState = {
    layout: navigation.layout,
    paneProjects: navigation.paneProjects,
    projects: PROJECTS,
    isLoadingProjects: false,
    attentionSessionIds: NO_SESSIONS,
    fallbackProject: navigation.fallbackProject,
    actions: navigation.actions,
    openSettings: vi.fn(),
    setSidebarOpen: vi.fn(),
    renameSession: vi.fn(async () => true),
    refreshProjectsSilently: vi.fn(async () => undefined),
    setCanShowBothPanes: navigation.setCanShowBothPanes,
    setPaneEditorUnsaved: navigation.setPaneEditorUnsaved,
  };
  return (
    <TestPanesProvider value={panesState}>
      <WorkspaceChromeProvider
        value={{
          isImmersive: false,
          isBrowserFullscreen: false,
          toggleImmersive: () => undefined,
          exitImmersive: () => undefined,
          isSidebarPeekOpen: false,
          setSidebarPeekOpen: () => undefined,
          canSplit: true,
        }}
      >
        <ProjectMainRegion isMobile={isMobile} ws={null} sendMessage={() => undefined} navigate={vi.fn() as unknown as NavigateFunction} />
      </WorkspaceChromeProvider>
    </TestPanesProvider>
  );
}

const rowOf = (project: Project, sessionId: string): ProjectSession => ({
  ...sessionRow(sessionId),
  __projectId: project.projectId,
});

const run = (change: () => void) => {
  act(() => {
    change();
  });
};

const layout = (): WorkspaceLayout => nav().layout;
const tabKeyOf = (side: 'left' | 'right', sessionId: string) =>
  (side === 'left' ? layout().left : layout().right)?.tabs.find((tab) => tab.sessionId === sessionId)?.key as string;
const paneElement = (side: 'left' | 'right') => document.querySelector(`[data-workspace-pane="${side}"]`) as HTMLElement;
const editors = () => screen.queryAllByLabelText<HTMLTextAreaElement>('code');
// Booleans and strings rather than nodes: a failed assertion on a jsdom node walks the whole tree.
const editorValues = () => editors().map((editor) => editor.value);
const isEditorShown = () => editors().some((editor) => editor.closest('[data-pane-content]')?.getAttribute('data-pane-content') === 'shown');

/** Opens src/app.ts from the chat of `side` and leaves an unsaved edit in it. */
const editFileIn = async (side: 'left' | 'right', project: Project) => {
  fireEvent.click(within(paneElement(side)).getByRole('button', { name: `open file in ${project.projectId}` }));
  await waitFor(() => assert.deepEqual(editorValues().filter((value) => value === 'hello').length, 1));
  const editor = within(paneElement(side)).getByLabelText<HTMLTextAreaElement>('code');
  fireEvent.change(editor, { target: { value: `${side} edited` } });
  await waitFor(() => assert.ok(within(paneElement(side)).queryByLabelText('Unsaved changes') !== null));
};

let confirm = vi.spyOn(window, 'confirm');

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  chatLifecycle.mounts = 0;
  chatLifecycle.unmounts = 0;
  // jsdom has no ResizeObserver; the editor sidebar and the panes observe their size with it.
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

test('closing the only tab keeps the editor and the chat mounted, hidden, until the pane shows something again', async () => {
  render(<Workspace />);
  run(() => nav().actions.openSession(rowOf(ALPHA, 'a1')));
  await editFileIn('left', ALPHA);
  const chatMountsBefore = chatLifecycle.mounts;

  run(() => nav().actions.closeTab('left', tabKeyOf('left', 'a1')));

  assert.ok(screen.getByRole('heading', { name: 'No conversation open' }));
  assert.deepEqual(editorValues(), ['left edited'], 'the edit is still there');
  assert.equal(isEditorShown(), false, 'but not on screen');
  assert.equal(chatLifecycle.unmounts, 0, 'the chat keeps hearing its runs');
  assert.equal(confirm.mock.calls.length, 0, 'nothing is lost, so nothing is asked');

  run(() => nav().actions.openSession(rowOf(ALPHA, 'a2')));
  assert.deepEqual(editorValues(), ['left edited']);
  assert.equal(isEditorShown(), true);
  assert.equal(chatLifecycle.mounts, chatMountsBefore, 'the same chat shows the next conversation');
});

test('deleting the only open conversation, or its conversation turning out gone, keeps the editor', async () => {
  render(<Workspace />);
  run(() => nav().actions.openSession(rowOf(ALPHA, 'a1')));
  run(() => nav().actions.openSession(rowOf(ALPHA, 'a2')));
  await editFileIn('left', ALPHA);

  run(() => {
    nav().commit({ type: 'markMissing', sessionId: 'a2' });
  });
  assert.ok(screen.getByText('This conversation no longer exists'));
  assert.deepEqual(editorValues(), ['left edited']);
  assert.equal(isEditorShown(), false);

  run(() => nav().actions.activateTab('left', tabKeyOf('left', 'a1')));
  assert.equal(isEditorShown(), true, 'back on a conversation, the editor is back');

  run(() => {
    nav().commit({ type: 'removeSession', sessionId: 'a1' });
    nav().commit({ type: 'removeSession', sessionId: 'a2' });
  });
  assert.ok(screen.getByRole('heading', { name: 'No conversation open' }));
  assert.deepEqual(editorValues(), ['left edited']);
  assert.equal(chatLifecycle.unmounts, 0);
  assert.equal(confirm.mock.calls.length, 0);
});

test('merging asks before the unfocused pane\'s unsaved edits go, and declining keeps both panes', async () => {
  render(<Workspace />);
  run(() => nav().actions.openSession(rowOf(ALPHA, 'a1')));
  run(() => nav().actions.split());
  run(() => nav().actions.openSession(rowOf(BETA, 'b1')));
  await editFileIn('right', BETA);
  run(() => nav().actions.focusPane('left'));

  run(() => nav().actions.toggleSplit());
  assert.equal(confirm.mock.calls.length, 1);
  assert.match(String(confirm.mock.calls[0][0]), /unsaved changes/i, 'the editor\'s own question');
  assert.ok(layout().right, 'declined: still split');
  assert.deepEqual(editorValues(), ['right edited']);

  confirm.mockReturnValue(true);
  run(() => nav().actions.toggleSplit());
  assert.equal(layout().right, null);
  assert.deepEqual(editorValues(), [], 'accepted: the right pane and its editor are gone');
  assert.deepEqual(layout().left.tabs.map((tab) => tab.sessionId), ['a1', 'b1']);
});

test('merging from the pane being edited keeps that pane, its conversation and its editor', async () => {
  render(<Workspace />);
  run(() => nav().actions.openSession(rowOf(ALPHA, 'a1')));
  run(() => nav().actions.split());
  run(() => nav().actions.openSession(rowOf(BETA, 'b1')));
  await editFileIn('right', BETA);

  run(() => nav().actions.toggleSplit());

  assert.equal(confirm.mock.calls.length, 0);
  assert.equal(layout().right, null);
  assert.equal(nav().focused.session?.id, 'b1', 'the conversation being worked in stays on screen');
  assert.deepEqual(editorValues(), ['right edited'], 'and so does its editor, now in the only pane');
  assert.equal(isEditorShown(), true);
});

test('closing the left side moves the right pane over with its editor; closing a side with edits asks', async () => {
  render(<Workspace />);
  run(() => nav().actions.openSession(rowOf(ALPHA, 'a1')));
  run(() => nav().actions.split());
  run(() => nav().actions.openSession(rowOf(BETA, 'b1')));
  await editFileIn('right', BETA);

  run(() => nav().actions.closePane('left'));
  assert.equal(confirm.mock.calls.length, 0, 'the edited pane survives');
  assert.deepEqual(editorValues(), ['right edited']);
  assert.equal(within(paneElement('left')).getByLabelText<HTMLTextAreaElement>('code').value, 'right edited');

  // Split again and close the edited side itself.
  run(() => nav().actions.split());
  run(() => nav().actions.focusPane('left'));
  run(() => nav().actions.moveTab('left', tabKeyOf('left', 'b1'), 'right'));
  assert.ok(layout().right);
  run(() => nav().actions.closePane('left'));
  assert.equal(confirm.mock.calls.length, 1, 'the left pane holds the edits now');
  assert.ok(layout().right, 'declined: nothing closed');
});

test('closing the last tab of the right pane asks first; declining keeps the tab', async () => {
  render(<Workspace />);
  run(() => nav().actions.openSession(rowOf(ALPHA, 'a1')));
  run(() => nav().actions.split());
  run(() => nav().actions.openSession(rowOf(BETA, 'b1')));
  await editFileIn('right', BETA);

  run(() => nav().actions.closeTab('right', tabKeyOf('right', 'b1')));

  assert.equal(confirm.mock.calls.length, 1);
  assert.deepEqual(layout().right?.tabs.map((tab) => tab.sessionId), ['b1']);
  assert.deepEqual(editorValues(), ['right edited']);
});

test('merging two empty panes keeps the left one, with the edits its hidden editor holds, and asks nothing', async () => {
  render(<Workspace />);
  run(() => nav().actions.openSession(rowOf(ALPHA, 'a1')));
  await editFileIn('left', ALPHA);
  run(() => nav().actions.closeAllTabs('left'));
  run(() => nav().actions.split());
  run(() => nav().actions.focusPane('left'));

  run(() => nav().actions.toggleSplit());

  assert.equal(confirm.mock.calls.length, 0, 'keeping the left pane loses nothing');
  assert.equal(layout().right, null);
  assert.deepEqual(editorValues(), ['left edited']);
  assert.equal(chatLifecycle.unmounts, 0, 'the hidden chat keeps hearing its runs');
});

test('on a phone, "Close all tabs" closes both panes in one go and keeps the shown pane\'s unsaved edits, hidden', async () => {
  const view = render(<Workspace />);
  run(() => nav().actions.openSession(rowOf(ALPHA, 'a1')));
  run(() => nav().actions.split());
  run(() => nav().actions.openSession(rowOf(BETA, 'b1')));
  await editFileIn('right', BETA);
  const rightPaneId = layout().right?.id;
  // A split brought over from a wider window: the phone shows the focused right pane only.
  view.rerender(<Workspace isMobile />);

  fireEvent.click(screen.getByRole('button', { name: 'Tabs (2)' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close all tabs' }));

  assert.equal(confirm.mock.calls.length, 0, 'the pane on screen stays, so nothing is lost');
  assert.equal(layout().right, null);
  assert.deepEqual(layout().left.tabs, []);
  assert.equal(layout().left.id, rightPaneId);
  assert.deepEqual(editorValues(), ['right edited']);
});
