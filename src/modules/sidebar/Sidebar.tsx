import { memo, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import { useVersionCheck } from '@/shared/hooks/useVersionCheck';
import { useUiPreferences, useSetUiPreference } from '@/shared/context/UiPreferencesContext';
import { useSidebarController } from '@/modules/sidebar/hooks/useSidebarController';
import { useTaskMaster, useTasksSettings } from '@/modules/task-master';
import { usePaletteOps } from '@/modules/command-palette';
import { useBackgroundSessionIdSet, useBusySessionIdSet } from '@/shared/context/SessionProtectionContext';
import type {
  LLMProvider,
  LoadingProgress,
  Project,
  ProjectSession,
  SessionOpenOptions,
  SidebarPaneTargeting,
  SidebarProjectListProps,
} from '@/shared/types';
import SidebarCollapsed from '@/modules/sidebar/SidebarCollapsed';
import SidebarContent from '@/modules/sidebar/SidebarContent';
import SidebarModals from '@/modules/sidebar/SidebarModals';

type SidebarProps = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  attentionSessionIds: ReadonlySet<string>;
  /** Records the browsed project (desktop title click); no longer clears or navigates the workspace. */
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: ProjectSession, options?: SessionOpenOptions) => void;
  onNewSession: (project: Project, options?: SessionOpenOptions) => void;
  onSessionDelete?: (sessionId: string) => void;
  onLoadMoreSessions?: (projectId: string) => Promise<void> | void;
  // `projectId` is the DB identifier; the sidebar hands it back to the parent
  // when the delete flow completes.
  onProjectDelete?: (projectId: string) => void;
  isLoading: boolean;
  loadingProgress: LoadingProgress | null;
  onRefresh: () => Promise<void> | void;
  /** Moves with the workspace's Refresh all: the archived and recent lists reload (the project list already did). */
  refreshEpoch?: number;
  onShowSettings: () => void;
  showSettings: boolean;
  settingsInitialTab: string;
  onCloseSettings: () => void;
  isMobile: boolean;
  /** Split targeting for the rows, their menus and the Open-in switch; absent outside the split workspace. */
  paneTargeting?: SidebarPaneTargeting | null;
  /** Immersive peek: full sidebar even when the user collapsed it to the rail. */
  forceExpanded?: boolean;
};

/** Exported through the sidebar barrel; the project-workspace module renders it as the app's project and session navigation panel. */
function Sidebar({
  projects,
  selectedProject,
  selectedSession,
  attentionSessionIds,
  onProjectSelect,
  onSessionSelect,
  onNewSession,
  onSessionDelete,
  onLoadMoreSessions,
  onProjectDelete,
  isLoading,
  loadingProgress,
  onRefresh,
  refreshEpoch,
  onShowSettings,
  showSettings,
  settingsInitialTab,
  onCloseSettings,
  isMobile,
  paneTargeting = null,
  forceExpanded = false,
}: SidebarProps) {
  const { t } = useTranslation(['sidebar', 'common']);
  const { isPWA } = useDeviceSettings({ trackMobile: false });
  const { updateAvailable, restartRequired, latestVersion, currentVersion, releaseInfo, installMode } = useVersionCheck(
    'siteboon',
    'claudecodeui',
  );
  const preferences = useUiPreferences();
  const setPreference = useSetUiPreference();
  const { sidebarVisible } = preferences;
  // Only the MCP status: TaskMaster's current project follows the focused pane, not sidebar clicks.
  const { mcpServerStatus } = useTaskMaster();
  const { tasksEnabled } = useTasksSettings();
  const paletteOps = usePaletteOps();
  // Only membership is rendered here, so subscribing to the full activity map
  // would re-render the whole tree on every provider status frame.
  const activeSessions = useBusySessionIdSet();
  const backgroundSessionIds = useBackgroundSessionIdSet();

  const {
    isSidebarCollapsed,
    isProjectExpanded,
    activeRename,
    showNewProject,
    initialSessionsLoaded,
    currentTime,
    isRefreshing,
    searchFilter,
    searchMode,
    setSearchMode,
    conversationResults,
    isSearching,
    searchProgress,
    clearConversationResults,
    runningSessionsCount,
    deletingProjects,
    pendingDeletion,
    showVersionModal,
    filteredProjects,
    archivedProjects,
    archivedSessions,
    archivedSessionsCount,
    isArchivedSessionsLoading,
    recentConversations,
    recentConversationsTotal,
    recentConversationsHasMore,
    isRecentConversationsLoading,
    isLoadingMoreRecentConversations,
    recentConversationsError,
    reloadRecentConversations,
    loadMoreRecentConversations,
    toggleProject,
    handleSessionClick,
    openConversation,
    toggleStarProject,
    isProjectStarred,
    getProjectSessions,
    loadingMoreProjects,
    loadMoreSessionsForProject,
    startEditingProject,
    startEditingSession,
    updateRenameDraft,
    cancelRename,
    saveProjectName,
    showDeleteSessionConfirmation,
    confirmDeleteSession,
    sessionSelection,
    setProjectSessionSelection,
    toggleSessionSelected,
    cancelSessionSelection,
    showDeleteSelectedSessionsConfirmation,
    confirmDeleteSessions,
    requestProjectDelete,
    confirmDeleteProject,
    handleProjectSelect,
    openArchivedSession,
    restoreArchivedProject,
    restoreArchivedSession,
    refreshProjects,
    updateSessionSummary,
    forkSession,
    collapseSidebar: handleCollapseSidebar,
    expandSidebar: handleExpandSidebar,
    setShowNewProject,
    setSearchFilter,
    setPendingDeletion,
    setShowVersionModal,
  } = useSidebarController({
    projects,
    selectedProject,
    selectedSession,
    activeSessions,
    backgroundSessionIds,
    isLoading,
    isMobile,
    t,
    onRefresh,
    refreshEpoch,
    onProjectSelect,
    onSessionSelect,
    onSessionDelete,
    onLoadMoreSessions,
    onProjectDelete,
    setSidebarVisible: (visible) => setPreference('sidebarVisible', visible),
    sidebarVisible,
    keepProjectsExpanded: preferences.keepProjectsExpanded,
    forceExpanded,
  });

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    document.documentElement.classList.toggle('pwa-mode', isPWA);
    document.body.classList.toggle('pwa-mode', isPWA);
  }, [isPWA]);

  // The new project joins the list, then opens in a new chat like a click on its New session would,
  // which selects and expands it in the sidebar.
  const handleProjectCreated = (createdProject?: Record<string, unknown>) => {
    void Promise.resolve(paletteOps.refreshProjects()).finally(() => {
      if (typeof createdProject?.projectId !== 'string') {
        return;
      }
      const project = createdProject as Project;
      handleProjectSelect(project);
      onNewSession(project);
    });
  };

  // Stable so memo() on the row components can bail out; an inline arrow here
  // would give every row a new callback on each sidebar render.
  const handleSaveProjectName = useCallback((projectId: string, nextName: string) => {
    void saveProjectName(projectId, nextName);
  }, [saveProjectName]);

  const handleSaveSessionName = useCallback(
    (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => {
      void updateSessionSummary(projectName, sessionId, summary, provider);
    },
    [updateSessionSummary],
  );

  const projectListProps: SidebarProjectListProps = {
    projects,
    filteredProjects,
    selectedProject,
    selectedSession,
    isLoading,
    loadingProgress,
    isProjectExpanded,
    activeRename,
    initialSessionsLoaded,
    currentTime,
    deletingProjects,
    tasksEnabled,
    mcpServerStatus,
    getProjectSessions,
    loadingMoreProjects,
    activeSessions,
    backgroundSessionIds,
    attentionSessionIds,
    isProjectStarred,
    onRenameDraftChange: updateRenameDraft,
    onToggleProject: toggleProject,
    onProjectSelect: handleProjectSelect,
    onToggleStarProject: toggleStarProject,
    onStartEditingProject: startEditingProject,
    onCancelEditingProject: cancelRename,
    onSaveProjectName: handleSaveProjectName,
    onDeleteProject: requestProjectDelete,
    onSessionSelect: handleSessionClick,
    onDeleteSession: showDeleteSessionConfirmation,
    onForkSession: forkSession,
    onLoadMoreSessions: loadMoreSessionsForProject,
    onNewSession,
    onStartEditingSession: startEditingSession,
    onCancelEditingSession: cancelRename,
    onSaveEditingSession: handleSaveSessionName,
    sessionSelection,
    onSetSessionSelection: setProjectSessionSelection,
    onToggleSessionSelected: toggleSessionSelected,
    onCancelSessionSelection: cancelSessionSelection,
    onDeleteSelectedSessions: showDeleteSelectedSessionsConfirmation,
    paneTargeting,
    t,
  };

  return (
    <>
        <SidebarModals
          projects={projects}
        showSettings={showSettings}
        settingsInitialTab={settingsInitialTab}
        onCloseSettings={onCloseSettings}
        showNewProject={showNewProject}
        onCloseNewProject={() => setShowNewProject(false)}
        onProjectCreated={handleProjectCreated}
        pendingDeletion={pendingDeletion}
        onCancelDeletion={() => setPendingDeletion(null)}
        onConfirmDeleteProject={confirmDeleteProject}
        onConfirmDeleteSession={confirmDeleteSession}
        onConfirmDeleteSessions={confirmDeleteSessions}
        showVersionModal={showVersionModal}
        onCloseVersionModal={() => setShowVersionModal(false)}
        releaseInfo={releaseInfo}
        currentVersion={currentVersion}
        latestVersion={latestVersion}
        installMode={installMode}
        t={t}
      />

      {isSidebarCollapsed ? (
        <SidebarCollapsed
          onExpand={handleExpandSidebar}
          onShowSettings={onShowSettings}
          updateAvailable={updateAvailable}
          restartRequired={restartRequired}
          onShowVersionModal={() => setShowVersionModal(true)}
          t={t}
        />
      ) : (
        <>
        <SidebarContent
            isPWA={isPWA}
            isMobile={isMobile}
            isLoading={isLoading}
            projects={projects}
            runningSessionsCount={runningSessionsCount}
            archivedProjects={archivedProjects}
            archivedSessions={archivedSessions}
            archivedSessionsCount={archivedSessionsCount}
            isArchivedSessionsLoading={isArchivedSessionsLoading}
            recentConversations={recentConversations}
            recentConversationsTotal={recentConversationsTotal}
            recentConversationsHasMore={recentConversationsHasMore}
            isRecentConversationsLoading={isRecentConversationsLoading}
            isLoadingMoreRecentConversations={isLoadingMoreRecentConversations}
            recentConversationsError={recentConversationsError}
            searchFilter={searchFilter}
            onSearchFilterChange={setSearchFilter}
            onClearSearchFilter={() => setSearchFilter('')}
            searchMode={searchMode}
            onSearchModeChange={(mode) => {
              setSearchMode(mode);
              if (mode === 'projects') clearConversationResults();
            }}
            conversationResults={conversationResults}
            isSearching={isSearching}
            searchProgress={searchProgress}
            onRestoreArchivedProject={restoreArchivedProject}
            onLoadMoreRecentConversations={loadMoreRecentConversations}
            onRetryRecentConversations={reloadRecentConversations}
            onArchivedSessionClick={openArchivedSession}
            onRestoreArchivedSession={restoreArchivedSession}
            onDeleteArchivedSession={(session) => {
              showDeleteSessionConfirmation(
                session.sessionId,
                session.sessionTitle,
                { isArchived: true },
              );
            }}
            onConversationResultClick={openConversation}
            onRefresh={() => {
              void refreshProjects();
            }}
            isRefreshing={isRefreshing}
            onCreateProject={() => setShowNewProject(true)}
            // Forced open, the sidebar cannot be hidden from inside; its overlay closes instead.
            onCollapseSidebar={forceExpanded ? undefined : handleCollapseSidebar}
            updateAvailable={updateAvailable}
            restartRequired={restartRequired}
            releaseInfo={releaseInfo}
            latestVersion={latestVersion}
            currentVersion={currentVersion}
            onShowVersionModal={() => setShowVersionModal(true)}
            onShowSettings={onShowSettings}
            projectListProps={projectListProps}
            t={t}
          />
        </>
      )}

    </>
  );
}

export default memo(Sidebar);
