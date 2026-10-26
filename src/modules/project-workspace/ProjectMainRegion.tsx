import { memo, useCallback, useLayoutEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { useProjectPanesState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { getActiveTab, getPane } from '@/modules/project-workspace/utils/workspaceLayout';
import type { AppTab, Project, ProjectWorkspaceShellProps, SessionNavigationOptions } from '@/shared/types';
import WorkspaceMain from '@/modules/project-workspace/WorkspaceMain';

/**
 * Rendered by ProjectWorkspaceShell to bind the focused pane of the workspace layout to WorkspaceMain.
 * A single-pane binding: the pane group with tab bars and a second pane replaces it.
 */
function ProjectMainRegion({
  isMobile,
  ws,
  sendMessage,
}: ProjectWorkspaceShellProps) {
  const {
    layout,
    paneProjects,
    isLoadingProjects,
    actions,
    openSettings,
    setSidebarOpen,
    renameSession,
    refreshProjectsSilently,
  } = useProjectPanesState();

  const side = layout.focusedSide;
  const pane = getPane(layout, side);
  const activeTab = getActiveTab(pane);
  // A tab whose session no longer exists shows the no-project state instead of an empty chat.
  const selectedProject = activeTab?.isMissing ? null : paneProjects[side];
  const selectedSession = activeTab?.session ?? null;
  const view: AppTab = activeTab?.view ?? 'chat';
  const activeTabKey = activeTab?.key ?? null;
  const activeTabProvider = activeTab?.provider;
  const selectedProjectId = selectedProject?.projectId;

  // The view a functional `setActiveTab` updater starts from.
  const viewRef = useRef(view);
  useLayoutEffect(() => {
    viewRef.current = view;
  });

  // WorkspaceMain still speaks the pre-split `setActiveTab`: every call becomes a view switch of the
  // focused tab, treated as the user's (a preview tab becomes a kept one).
  const setActiveTab = useCallback<Dispatch<SetStateAction<AppTab>>>((value) => {
    if (!activeTabKey) {
      return;
    }
    const nextView = typeof value === 'function' ? value(viewRef.current) : value;
    actions.setTabView(side, activeTabKey, nextView, { pin: true });
  }, [actions, activeTabKey, side]);

  const handleOpenSidebar = useCallback(() => {
    setSidebarOpen(true);
  }, [setSidebarOpen]);

  // A fork or a just-established session opens kept in this pane, under this pane's project.
  const handleNavigateToSession = useCallback((
    targetSessionId: string,
    options?: SessionNavigationOptions,
  ) => {
    actions.openSession(
      { id: targetSessionId, __projectId: selectedProjectId, __provider: activeTabProvider },
      { target: side, preview: false, history: options?.replace ? 'replace' : 'push' },
    );
  }, [actions, activeTabProvider, selectedProjectId, side]);

  // The worktrees view switches project by opening that project's new chat here.
  const handleProjectSelect = useCallback((project: Project) => {
    actions.openNewSession(project, { target: side });
  }, [actions, side]);

  const handleProjectsRefresh = useCallback(() => {
    void refreshProjectsSilently();
  }, [refreshProjectsSilently]);

  return (
    <WorkspaceMain
      selectedProject={selectedProject}
      selectedSession={selectedSession}
      activeTab={view}
      setActiveTab={setActiveTab}
      ws={ws}
      sendMessage={sendMessage}
      isMobile={isMobile}
      onMenuClick={handleOpenSidebar}
      isLoading={isLoadingProjects}
      onNavigateToSession={handleNavigateToSession}
      onSessionEstablished={actions.establishDraft}
      onShowSettings={openSettings}
      externalMessageUpdate={pane?.externalRevision ?? 0}
      newSessionTrigger={pane?.draftActivation ?? 0}
      onProjectSelect={handleProjectSelect}
      onProjectsRefresh={handleProjectsRefresh}
      onRenameSession={renameSession}
    />
  );
}

export default memo(ProjectMainRegion);
