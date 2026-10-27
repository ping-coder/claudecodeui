import type { SessionPanePlacement, SessionWithProvider, SidebarProjectListProps } from '@/shared/types';
import SidebarProjectItem from '@/modules/sidebar/SidebarProjectItem';
import SidebarProjectsState from '@/modules/sidebar/SidebarProjectsState';

/**
 * The placement map for an expanded project with a loaded session open in a pane, else null.
 * A collapsed project draws no session rows and one with nothing open draws no marker, so
 * both keep being handed null and their memo holds while tabs open and close elsewhere.
 */
const resolveProjectPlacements = (
  isExpanded: boolean,
  sessions: SessionWithProvider[],
  placements: ReadonlyMap<string, SessionPanePlacement> | undefined,
): ReadonlyMap<string, SessionPanePlacement> | null => {
  if (!isExpanded || !placements || placements.size === 0) {
    return null;
  }
  return sessions.some((session) => placements.has(session.id)) ? placements : null;
};

/** Rendered by SidebarContent to list the filtered projects, delegating each row to SidebarProjectItem. */
export default function SidebarProjectList({
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
  onLoadMoreSessions,
  loadingMoreProjects,
  activeSessions,
  backgroundSessionIds,
  attentionSessionIds,
  isProjectStarred,
  onRenameDraftChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onSessionSelect,
  onDeleteSession,
  onForkSession,
  onNewSession,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  sessionSelection,
  onSetSessionSelection,
  onToggleSessionSelected,
  onCancelSessionSelection,
  onDeleteSelectedSessions,
  paneTargeting,
  t,
}: SidebarProjectListProps) {
  const state = (
    <SidebarProjectsState
      isLoading={isLoading}
      loadingProgress={loadingProgress}
      projectsCount={projects.length}
      filteredProjectsCount={filteredProjects.length}
      t={t}
    />
  );

  const showProjects = !isLoading && projects.length > 0 && filteredProjects.length > 0;

  return (
      <div className="pb-safe-area-inset-bottom md:space-y-1">
        {!showProjects
          ? state
          : filteredProjects.map((project) => {
              // Both renames are resolved here rather than inside the row, so
              // every other row is handed the same scalars on each keystroke and
              // its memo boundary holds.
              const renamingProject =
                activeRename?.target === 'project' && activeRename.id === project.projectId
                  ? activeRename
                  : null;
              const renamingSession =
                activeRename?.target === 'session' && activeRename.projectId === project.projectId
                  ? activeRename
                  : null;
              // Resolved here for the same reason as the renames: only the
              // project in selection mode sees a set, every other row keeps
              // being handed the same `null` and its memo holds.
              const selectedSessionIds =
                sessionSelection?.projectId === project.projectId ? sessionSelection.sessionIds : null;
              // Split targeting is resolved per row too, and the focused side is left out:
              // the rows offer absolute sides, so a focus switch changes nothing they draw.
              const isExpanded = isProjectExpanded(project.projectId);
              const sessions = getProjectSessions(project);
              // The highlight as well. The focused pane's session belongs to the focused pane's
              // project, so only that row is handed its id: a focus switch between two panes
              // changes props on the two project rows and the two session rows it moves the
              // highlight between, and on no other row.
              const isSelected = selectedProject?.projectId === project.projectId;
              const selectedSessionId = isSelected ? selectedSession?.id ?? null : null;

              // React key + per-project state lookups all use the DB `projectId`
              // so they remain stable across renames and session changes.
              return (
              <SidebarProjectItem
                key={project.projectId}
                project={project}
                isSelected={isSelected}
                selectedSessionId={selectedSessionId}
                isExpanded={isExpanded}
                isDeleting={deletingProjects.has(project.projectId)}
                isStarred={isProjectStarred(project.projectId)}
                isEditing={renamingProject !== null}
                renameDraft={renamingProject?.draft ?? ''}
                sessions={sessions}
                initialSessionsLoaded={initialSessionsLoaded.has(project.projectId)}
                isLoadingMoreSessions={loadingMoreProjects.has(project.projectId)}
                currentTime={currentTime}
                sessionRenameId={renamingSession?.id ?? null}
                sessionRenameDraft={renamingSession?.draft ?? ''}
                tasksEnabled={tasksEnabled}
                mcpServerStatus={mcpServerStatus}
                onRenameDraftChange={onRenameDraftChange}
                onToggleProject={onToggleProject}
                onProjectSelect={onProjectSelect}
                onToggleStarProject={onToggleStarProject}
                onStartEditingProject={onStartEditingProject}
                onCancelEditingProject={onCancelEditingProject}
                onSaveProjectName={onSaveProjectName}
                onDeleteProject={onDeleteProject}
                onSessionSelect={onSessionSelect}
                onDeleteSession={onDeleteSession}
                onForkSession={onForkSession}
                onLoadMoreSessions={onLoadMoreSessions}
                activeSessions={activeSessions}
                backgroundSessionIds={backgroundSessionIds}
                attentionSessionIds={attentionSessionIds}
                onNewSession={onNewSession}
                onStartEditingSession={onStartEditingSession}
                onCancelEditingSession={onCancelEditingSession}
                onSaveEditingSession={onSaveEditingSession}
                selectedSessionIds={selectedSessionIds}
                onSetSessionSelection={onSetSessionSelection}
                onToggleSessionSelected={onToggleSessionSelected}
                onCancelSessionSelection={onCancelSessionSelection}
                onDeleteSelectedSessions={onDeleteSelectedSessions}
                canTargetSides={paneTargeting?.canTargetSides ?? false}
                isWorkspaceSplit={paneTargeting?.isSplit ?? false}
                panePlacements={resolveProjectPlacements(isExpanded, sessions, paneTargeting?.placements)}
                t={t}
              />
            );
          })}
    </div>
  );
}
