import { memo, useCallback, useMemo } from 'react';

import { useProjectPanesState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { useWorkspaceChrome } from '@/modules/project-workspace/context/WorkspaceChromeContext';
import { findLoadedSession } from '@/modules/project-workspace/utils/resolveSessionTarget';
import { findSessionTab, getActiveTab, getPane } from '@/modules/project-workspace/utils/workspaceLayout';
import { RunNotifications } from '@/modules/run-notifications';
import type {
  Project,
  RunAlertBannerPlacement,
  RunSessionLabel,
  WorkspaceLayout,
  WorkspacePaneSide,
} from '@/shared/types';
import { findLiveSessionTitle } from '@/shared/utils';

type ProjectRunNotificationsProps = {
  isMobile: boolean;
};

/**
 * How the workspace names a session in a run alert: its live title (where renames and generated summaries land),
 * else the title its pane tab last knew; its project's display name from the loaded projects, else from the tab's
 * project among the pane projects (an archived project the list does not hold). Null when the workspace knows
 * neither, so run-notifications falls back to the server's session name.
 */
const resolveRunSessionLabel = (
  sessionId: string,
  projects: Project[],
  paneProjects: Readonly<Record<WorkspacePaneSide, Project | null>>,
  layout: WorkspaceLayout,
): RunSessionLabel | null => {
  const tab = findSessionTab(layout, sessionId)?.tab ?? null;
  const title = findLiveSessionTitle(sessionId, projects) || tab?.title.trim() || '';

  let projectName = findLoadedSession(sessionId, projects)?.project.displayName?.trim() || null;
  if (!projectName && tab?.projectId) {
    const tabProject = projects.find((project) => project.projectId === tab.projectId)
      ?? Object.values(paneProjects).find((project) => project?.projectId === tab.projectId)
      ?? null;
    projectName = tabProject?.displayName?.trim() || null;
  }

  return title || projectName ? { title, projectName } : null;
};

/**
 * The sessions in the Chat view of a pane on display, as a stable key (sorted ids joined by NUL; ids never hold
 * one). Both panes count only while they sit side by side; a split too narrow to show both, and a phone, show
 * the focused pane alone.
 */
const collectOnScreenChatSessionKey = (layout: WorkspaceLayout, showsBothPanes: boolean): string => {
  const sides: WorkspacePaneSide[] = showsBothPanes ? ['left', 'right'] : [layout.focusedSide];
  const sessionIds: string[] = [];
  for (const side of sides) {
    const tab = getActiveTab(getPane(layout, side));
    if (tab?.sessionId && tab.view === 'chat') {
      sessionIds.push(tab.sessionId);
    }
  }
  return sessionIds.sort().join('\u0000');
};

/**
 * Rendered by ProjectWorkspaceShell right after ProjectEffects to bind the workspace to the run-notifications
 * module: how a session is named in an alert, which sessions are on screen (they get no banner), opening a
 * session from a banner's "Open" (kept, on Chat, in the focused pane) and where the banners sit.
 */
function ProjectRunNotifications({ isMobile }: ProjectRunNotificationsProps) {
  const { projects, paneProjects, layout, actions, setSidebarOpen } = useProjectPanesState();
  const { canSplit, isImmersive } = useWorkspaceChrome();

  const resolveSessionLabel = useCallback(
    (sessionId: string) => resolveRunSessionLabel(sessionId, projects, paneProjects, layout),
    [layout, paneProjects, projects],
  );

  const showsBothPanes = layout.right !== null && canSplit && !isMobile;
  const onScreenKey = collectOnScreenChatSessionKey(layout, showsBothPanes);
  // Memoized on the key, so a layout change that leaves the same sessions on screen keeps the same set.
  const onScreenSessionIds = useMemo<ReadonlySet<string>>(
    () => new Set(onScreenKey ? onScreenKey.split('\u0000') : []),
    [onScreenKey],
  );

  const onOpenSession = useCallback((sessionId: string) => {
    // On a phone the sidebar drawer would cover the session it opens.
    setSidebarOpen(false);
    actions.openSessionById(sessionId, { preview: false, view: 'chat' });
  }, [actions, setSidebarOpen]);

  const placement: RunAlertBannerPlacement = !isMobile ? 'desktop' : isImmersive ? 'phoneImmersive' : 'phone';

  return (
    <RunNotifications
      resolveSessionLabel={resolveSessionLabel}
      onScreenSessionIds={onScreenSessionIds}
      onOpenSession={onOpenSession}
      placement={placement}
    />
  );
}

export default memo(ProjectRunNotifications);
