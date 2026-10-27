import { ClipboardCheck, Terminal, type LucideIcon } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ChatInterface } from '@/modules/chat';
import { FileTree } from '@/modules/file-tree';
import { StandaloneShell } from '@/modules/standalone-shell';
import { GitPanel } from '@/modules/git-panel';
import { PluginTabContent } from '@/modules/plugins';
import { BrowserUsePanel, useBrowserUseEnabled } from '@/modules/browser-use';
import { usePaletteOpsRegister } from '@/modules/command-palette';
import { TaskMasterPanel, useTaskMaster, useTasksSettings } from '@/modules/task-master';
import type {
  AppTab,
  CodeEditorDiffInfo,
  DirectoryRevealRequest,
  Project,
  ProjectSession,
  SessionEstablishedContext,
  SessionNavigationOptions,
  SettingsMainTab,
  WorkspacePaneSide,
  WorkspaceViewSetter,
} from '@/shared/types';
import { WorkspacePaneProvider } from '@/shared/context/WorkspacePaneContext';
import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import { useFileOpenResolver } from '@/modules/project-workspace/hooks/useFileOpenResolver';
import { EditorSidebar, useEditorSidebar } from '@/modules/code-editor';
import WorkspaceHeader from '@/modules/project-workspace/WorkspaceHeader';
import WorkspaceStateView from '@/modules/project-workspace/WorkspaceStateView';
import WorkspaceErrorBoundary from '@/modules/project-workspace/WorkspaceErrorBoundary';

type WorkspaceMainProps = {
  /** The pane this content fills. */
  side: WorkspacePaneSide;
  /** Only the focused pane registers palette operations; the chat and editor inside read it from WorkspacePaneContext. */
  isFocusedPane: boolean;
  /** False while the pane stays mounted but hidden (a split too narrow to show both): the chat pauses and the shell unmounts. */
  isPaneVisible: boolean;
  /** The pane shares the main area with another one side by side. */
  isSplitPane: boolean;
  /** The pane is narrower than 640px: compact header. */
  compact: boolean;
  /** Immersive mode: no header; the pane's tab bar carries the view bar instead. */
  hideHeader: boolean;
  /** Extra controls at the end of the header's first row (the phone's tabs and full-screen buttons). */
  headerActions: ReactNode;
  /** The chat connection pill; the right pane side by side hides it so the app shows one. */
  showConnectionStatus: boolean;
  /** The other pane already holds this terminal (same PTY key), so the Shell view offers to take it over instead of connecting. */
  shellBlockedBy: WorkspacePaneSide | null;
  /** Moves the terminal lease to this pane. */
  onClaimShell: () => void;
  /** Focuses this pane; offered by the Tasks notice of an unfocused pane. */
  onFocusPane: () => void;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  /** Switches the pane's view; user-initiated switches keep a preview tab open, fallbacks below do not. */
  setActiveTab: WorkspaceViewSetter;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  isMobile: boolean;
  onMenuClick: () => void;
  isLoading: boolean;
  onNavigateToSession: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings: (tab?: SettingsMainTab) => void;
  externalMessageUpdate: number;
  newSessionTrigger: number;
  /** Switches the app to another project — used by the git panel's Worktrees view. */
  onProjectSelect: (project: Project) => void;
  /** Silently re-syncs the sidebar project list after worktree projects change. */
  onProjectsRefresh: () => void;
  /** Persists a new title for a session; resolves false when the backend refuses it. Used by the header's inline rename. */
  onRenameSession: (sessionId: string, summary: string) => Promise<boolean>;
  /** Hears the editor's buffer turn dirty or clean (clean again when it unmounts), for the pane's layout guard. */
  onEditorUnsavedChange: (hasUnsavedChanges: boolean) => void;
  /** The user opened a file from the chat: a preview tab becomes a kept one, as on a view switch. */
  onKeepTab: () => void;
};

/** What an unfocused pane registers with the command palette: nothing, so palette actions land in the focused pane. */
const NO_PALETTE_OPS = {};

type PaneViewNoticeProps = {
  icon: LucideIcon;
  message: string;
  actionLabel: string;
  onAction: () => void;
};

/** Stands in for a view this pane cannot show right now (a terminal the other pane holds, tasks of another project). */
function PaneViewNotice({ icon: Icon, message, actionLabel, onAction }: PaneViewNoticeProps) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <Icon className="mx-auto mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
        <p className="mb-4 text-sm text-muted-foreground">{message}</p>
        <button
          type="button"
          onClick={onAction}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
}

/** Rendered by WorkspacePane to show its active tab's project in the tab's view: chat, files, shell, git, tasks, browser or a plugin. */
function WorkspaceMain({
  side,
  isFocusedPane,
  isPaneVisible,
  isSplitPane,
  compact,
  hideHeader,
  headerActions,
  showConnectionStatus,
  shellBlockedBy,
  onClaimShell,
  onFocusPane,
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  ws,
  sendMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  externalMessageUpdate,
  newSessionTrigger,
  onProjectSelect,
  onProjectsRefresh,
  onRenameSession,
  onEditorUnsavedChange,
  onKeepTab,
}: WorkspaceMainProps) {
  const { t } = useTranslation();
  const preferences = useUiPreferences();
  const { showRawParameters, showThinking, sendByCtrlEnter } = preferences;

  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const browserUseEnabled = useBrowserUseEnabled();
  // TaskMaster holds one current project, which follows the focused pane (ProjectMainRegion syncs it).
  const { currentProject: taskMasterProject } = useTaskMaster();

  // The folder an in-chat `path/` reference asked to reveal. Held as an object
  // so that re-clicking the same folder is a new request the tree acts on.
  const [revealDirectory, setRevealDirectory] = useState<DirectoryRevealRequest | null>(null);

  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);
  const shouldShowBrowserTab = browserUseEnabled;
  // An unfocused pane on another project would show the focused pane's tasks, so it points there instead.
  const isTaskMasterElsewhere = !isFocusedPane
    && Boolean(selectedProject)
    && taskMasterProject?.projectId !== selectedProject?.projectId;

  const {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
    handleUnsavedChangesChange,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
  });

  // The editor reports its buffer here; the pane's layout guard hears it too, so a layout change that
  // would unmount this pane asks before the edits go.
  const handleEditorUnsavedChange = useCallback((hasUnsavedChanges: boolean) => {
    handleUnsavedChangesChange(hasUnsavedChanges);
    onEditorUnsavedChange(hasUnsavedChanges);
  }, [handleUnsavedChangesChange, onEditorUnsavedChange]);

  // A file opened from the chat (a link in a message, a tool result) is the user working in this tab,
  // so a preview tab is kept, as on a view switch; nothing happens when the user keeps an unsaved buffer.
  const openFileFromChat = useCallback((
    filePath: string,
    diffInfo: CodeEditorDiffInfo | null = null,
    line: number | null = null,
  ) => {
    if (handleFileOpen(filePath, diffInfo, line)) {
      onKeepTab();
    }
  }, [handleFileOpen, onKeepTab]);

  // Resolves bare/partial file references (e.g. links inside chat messages) to
  // real project files before opening them in the in-app editor.
  const resolvedFileOpen = useFileOpenResolver(selectedProject, openFileFromChat);

  // Programmatic fallbacks: they leave a preview tab a preview.
  useEffect(() => {
    if (!shouldShowTasksTab && activeTab === 'tasks') {
      setActiveTab('chat');
    }
  }, [shouldShowTasksTab, activeTab, setActiveTab]);

  useEffect(() => {
    if (!shouldShowBrowserTab && activeTab === 'browser') {
      setActiveTab('chat');
    }
  }, [shouldShowBrowserTab, activeTab, setActiveTab]);

  // Stable so React.memo(ChatInterface) can bail out: an inline arrow here made
  // every WorkspaceMain render re-render the whole chat tree, including during
  // an editor-divider drag.
  const showAllTasks = useCallback(() => {
    setActiveTab('tasks', { userInitiated: true });
  }, [setActiveTab]);

  const openFile = useCallback((filePath: string) => {
    if (handleFileOpen(filePath)) {
      setActiveTab('files', { userInitiated: true });
    }
  }, [handleFileOpen, setActiveTab]);

  // Opens the editor side panel in place, keeping the current tab (e.g. chat).
  const openFileInEditor = useCallback((filePath: string, line?: number | null) => {
    resolvedFileOpen(filePath, undefined, line);
  }, [resolvedFileOpen]);

  // Directories cannot be read as text: reveal them in the file tree instead.
  const openDirectory = useCallback((directoryPath: string) => {
    setActiveTab('files', { userInitiated: true });
    setRevealDirectory({ path: directoryPath });
  }, [setActiveTab]);

  // Stable arguments keep usePaletteOpsRegister's effect from tearing down and
  // rewriting the whole palette registry on every render. Only the focused pane
  // registers, so palette actions always land where the user last pointed.
  const paletteOps = useMemo(
    () => (isFocusedPane ? { openFile, openFileInEditor, openDirectory } : NO_PALETTE_OPS),
    [isFocusedPane, openDirectory, openFile, openFileInEditor],
  );
  usePaletteOpsRegister(paletteOps);

  // Memoized: every consumer (chat, editor) re-renders when this object changes.
  const paneContext = useMemo(() => ({
    side,
    isFocusedPane,
    isSplitPane,
    openFileInEditor,
    openDirectory,
  }), [isFocusedPane, isSplitPane, openDirectory, openFileInEditor, side]);

  if (isLoading) {
    return <WorkspaceStateView mode="loading" isMobile={isMobile && !hideHeader} onMenuClick={onMenuClick} />;
  }

  if (!selectedProject) {
    return <WorkspaceStateView mode="empty" isMobile={isMobile && !hideHeader} onMenuClick={onMenuClick} />;
  }

  return (
    <WorkspacePaneProvider value={paneContext}>
      <div className="flex h-full flex-col">
        {!hideHeader && (
          <WorkspaceHeader
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            shouldShowTasksTab={shouldShowTasksTab}
            shouldShowBrowserTab={shouldShowBrowserTab}
            isMobile={isMobile}
            onMenuClick={onMenuClick}
            onRenameSession={onRenameSession}
            compact={compact}
            headerActions={headerActions}
            showConnectionStatus={showConnectionStatus}
          />
        )}

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden ${editorExpanded ? 'hidden' : ''} flex-1`}>
            <div className={`h-full ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
              <WorkspaceErrorBoundary showDetails>
                <ChatInterface
                  isActive={activeTab === 'chat' && isPaneVisible}
                  selectedProject={selectedProject}
                  selectedSession={selectedSession}
                  ws={ws}
                  sendMessage={sendMessage}
                  onFileOpen={openFileFromChat}
                  onNavigateToSession={onNavigateToSession}
                  onSessionEstablished={onSessionEstablished}
                  onShowSettings={onShowSettings}
                  showRawParameters={showRawParameters}
                  showThinking={showThinking}
                  sendByCtrlEnter={sendByCtrlEnter}
                  externalMessageUpdate={externalMessageUpdate}
                  newSessionTrigger={newSessionTrigger}
                  onShowAllTasks={tasksEnabled ? showAllTasks : null}
                />
              </WorkspaceErrorBoundary>
            </div>

            {activeTab === 'files' && (
              <div className="h-full overflow-hidden">
                <FileTree
                  selectedProject={selectedProject}
                  onFileOpen={handleFileOpen}
                  revealDirectory={revealDirectory}
                />
              </div>
            )}

            {/* One PTY per terminal key: a hidden pane, or one whose terminal the other pane holds, does not connect. */}
            {activeTab === 'shell' && (shellBlockedBy ? (
              <PaneViewNotice
                icon={Terminal}
                message={t('workspace.shellElsewhere', { defaultValue: 'This terminal is open in the other pane' })}
                actionLabel={t('workspace.useShellHere', { defaultValue: 'Use it here' })}
                onAction={onClaimShell}
              />
            ) : isPaneVisible && (
              <div className="h-full w-full overflow-hidden">
                <StandaloneShell
                  project={selectedProject}
                  session={selectedSession}
                  showHeader={false}
                  isActive
                />
              </div>
            ))}

            {activeTab === 'git' && (
              <div className="h-full overflow-hidden">
                <GitPanel
                  selectedProject={selectedProject}
                  isMobile={isMobile}
                  onFileOpen={handleFileOpen}
                  onProjectSelect={onProjectSelect}
                  onProjectsRefresh={onProjectsRefresh}
                />
              </div>
            )}

            {shouldShowTasksTab && (isTaskMasterElsewhere ? (
              activeTab === 'tasks' && (
                <PaneViewNotice
                  icon={ClipboardCheck}
                  message={t('workspace.tasksFollowFocus', { defaultValue: 'Tasks follow the focused pane' })}
                  actionLabel={t('workspace.focusThisPane', { defaultValue: 'Focus this pane' })}
                  onAction={onFocusPane}
                />
              )
            ) : (
              <TaskMasterPanel isVisible={activeTab === 'tasks' && isPaneVisible} />
            ))}

            {shouldShowBrowserTab && activeTab === 'browser' && (
              <div className="h-full overflow-hidden">
                <BrowserUsePanel isVisible={isPaneVisible} onShowSettings={onShowSettings} />
              </div>
            )}

            {activeTab.startsWith('plugin:') && (
              <div className="h-full overflow-hidden">
                <PluginTabContent
                  pluginName={activeTab.replace('plugin:', '')}
                  selectedProject={selectedProject}
                  selectedSession={selectedSession}
                />
              </div>
            )}
          </div>

          <EditorSidebar
            editingFile={editingFile}
            isMobile={isMobile}
            editorExpanded={editorExpanded}
            editorWidth={editorWidth}
            hasManualWidth={hasManualWidth}
            resizeHandleRef={resizeHandleRef}
            onResizeStart={handleResizeStart}
            onCloseEditor={handleCloseEditor}
            onToggleEditorExpand={handleToggleEditorExpand}
            onUnsavedChangesChange={handleEditorUnsavedChange}
            projectPath={selectedProject.path}
            fillSpace={activeTab === 'files'}
          />
        </div>
      </div>
    </WorkspacePaneProvider>
  );
}

export default React.memo(WorkspaceMain);
