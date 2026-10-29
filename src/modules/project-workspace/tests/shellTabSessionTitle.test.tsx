import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import type { Project, ProjectSession } from '@/shared/types';

/**
 * A pane's Shell view names its session as the pane's tab does: the server's placeholder names
 * ("Untitled Claude Session") and a session with no title read in the interface language. The
 * shell module cannot import the sidebar (the sidebar reaches the shell through task-master), so
 * the pane hands the name over.
 */

const shellProps: { sessionTitle?: string | null }[] = [];
const noop = () => undefined;

vi.mock('@/shared/context/UiPreferencesContext', () => ({
  useUiPreferences: () => ({ showRawParameters: false, showThinking: false, sendByCtrlEnter: false }),
}));
vi.mock('@/modules/chat', () => ({ ChatInterface: () => <div /> }));
vi.mock('@/modules/file-tree', () => ({ FileTree: () => <div /> }));
vi.mock('@/modules/standalone-shell', () => ({
  StandaloneShell: (props: { sessionTitle?: string | null }) => {
    shellProps.push(props);
    return <div data-testid="terminal" />;
  },
}));
vi.mock('@/modules/git-panel', () => ({ GitPanel: () => <div /> }));
vi.mock('@/modules/plugins', () => ({ usePlugins: () => ({ plugins: [] }), PluginIcon: () => null, PluginTabContent: () => <div /> }));
vi.mock('@/modules/browser-use', () => ({ BrowserUsePanel: () => <div />, useBrowserUseEnabled: () => false }));
vi.mock('@/modules/task-master', () => ({
  TaskMasterPanel: () => <div />,
  useTaskMaster: () => ({ currentProject: null }),
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }),
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

const { default: WorkspaceMain } = await import('@/modules/project-workspace/WorkspaceMain');

const PROJECT: Project = { projectId: 'alpha', displayName: 'Alpha', fullPath: '/repo/alpha', path: '/repo/alpha', sessions: [] };

const renderShellView = (session: ProjectSession) => render(
  <WorkspaceMain
    side="left"
    isFocusedPane
    isPaneVisible
    isSplitPane={false}
    hideHeader
    viewLabels="all"
    headerActions={null}
    shellBlockedBy={null}
    onClaimShell={noop}
    onFocusPane={noop}
    selectedProject={PROJECT}
    selectedSession={session}
    activeTab="shell"
    setActiveTab={noop}
    ws={null}
    sendMessage={noop}
    isMobile={false}
    onMenuClick={noop}
    isLoading={false}
    onNavigateToSession={noop}
    onSessionEstablished={noop}
    onShowSettings={noop}
    externalMessageUpdate={0}
    newSessionTrigger={0}
    onProjectSelect={noop}
    onProjectsRefresh={noop}
    onRenameSession={async () => true}
    onEditorUnsavedChange={noop}
    onKeepTab={noop}
  />,
);

afterEach(async () => {
  shellProps.length = 0;
  await act(async () => {
    await i18n.changeLanguage('en');
  });
});

test('the Shell view names its session in the interface language', async () => {
  await act(async () => {
    await i18n.changeLanguage('zh-CN');
  });
  renderShellView({ id: 'session-a', summary: 'Untitled Claude Session', __provider: 'claude' });
  assert.equal(shellProps.at(-1)?.sessionTitle, '未命名的 Claude 会话');
});

test('a session with no title, or with its own, reads as the tab bar reads it', async () => {
  const view = renderShellView({ id: 'session-b', summary: 'Fix login bug', __provider: 'claude' });
  assert.equal(shellProps.at(-1)?.sessionTitle, 'Fix login bug');
  view.unmount();

  await act(async () => {
    await i18n.changeLanguage('zh-CN');
  });
  renderShellView({ id: 'session-c', __provider: 'claude' });
  assert.equal(shellProps.at(-1)?.sessionTitle, '新会话');
});
