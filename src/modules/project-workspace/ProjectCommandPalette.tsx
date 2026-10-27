import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { CommandPalette } from '@/modules/command-palette';
import {
  useProjectCommandState,
  useProjectPanesState,
} from '@/modules/project-workspace/context/ProjectsStateContext';
import { useWorkspaceChrome } from '@/modules/project-workspace/context/WorkspaceChromeContext';
import { findLoadedSession } from '@/modules/project-workspace/utils/resolveSessionTarget';
import { getActiveTab, getPane } from '@/modules/project-workspace/utils/workspaceLayout';
import { WORKSPACE_PANE_SIDES } from '@/shared/constants';
import type {
  CommandPaletteWorkspaceCommands,
  Project,
  SessionOpenOptions,
  UntitledPaneTabLabels,
  WorkspaceLayout,
  WorkspaceOpenTabSummary,
  WorkspacePaneSide,
  WorkspaceSessionTab,
} from '@/shared/types';
import { focusWorkspacePaneElement, getOtherPaneSide, resolvePaneTabTitle } from '@/shared/utils';

/** A tab session's title in the loaded projects, where renames and generated summaries land; empty for a draft, an unloaded session or an untitled one. */
const getLiveTabTitle = (tab: WorkspaceSessionTab, projects: Project[]): string | undefined => {
  if (!tab.sessionId) {
    return undefined;
  }
  const liveSession = findLoadedSession(tab.sessionId, projects)?.session;
  return liveSession?.summary || liveSession?.name;
};

/** A tab's project name: its projects row, else the pane's own project (an archived one the list does not hold). */
const getOpenTabProjectName = (tab: WorkspaceSessionTab, projects: Project[], paneProject: Project | null): string => {
  if (!tab.projectId) {
    return '';
  }
  const project = projects.find((candidate) => candidate.projectId === tab.projectId)
    ?? (paneProject?.projectId === tab.projectId ? paneProject : null);
  return project?.displayName ?? '';
};

/**
 * Both panes' tabs, left first. isActive marks only the focused pane's active tab: the one the
 * palette's tab commands act on, which also tells the palette which pane is focused.
 */
const collectOpenTabs = (
  layout: WorkspaceLayout,
  projects: Project[],
  paneProjects: Readonly<Record<WorkspacePaneSide, Project | null>>,
  labels: UntitledPaneTabLabels,
): WorkspaceOpenTabSummary[] => {
  const focusedTabKey = getActiveTab(getPane(layout, layout.focusedSide))?.key ?? null;
  return WORKSPACE_PANE_SIDES.flatMap((side) => (getPane(layout, side)?.tabs ?? []).map((tab) => ({
    side,
    tabKey: tab.key,
    title: resolvePaneTabTitle(tab, getLiveTabTitle(tab, projects), labels),
    provider: tab.provider,
    projectName: getOpenTabProjectName(tab, projects, paneProjects[side]),
    isActive: side === layout.focusedSide && tab.key === focusedTabKey,
  })));
};

/** Rendered by ProjectWorkspaceShell to bind this module's project state, pane layout and chrome to the command-palette module. */
function ProjectCommandPalette() {
  const { t } = useTranslation();
  const {
    selectedProject,
    handleNewSession,
    openSettings,
    setActiveTab,
    openSessionById,
    layout,
    actions,
  } = useProjectCommandState();
  // Only for the Open tabs titles and project names: useProjectCommandState carries neither projects nor pane projects.
  const { projects, paneProjects } = useProjectPanesState();
  const { canSplit, isImmersive, toggleImmersive } = useWorkspaceChrome();

  // The layout as last rendered: commands read the focused tab when they run, and the focus hand-off
  // below reads the layout their own change produced.
  const layoutRef = useRef(layout);
  useLayoutEffect(() => {
    layoutRef.current = layout;
  });

  /**
   * Runs a palette command; when it moved the focused pane, DOM focus follows a frame later, as after
   * the pane shortcuts. The closing dialog hands focus back to where it was opened from, usually the
   * pane just left, and typing or Esc there would act on the wrong pane. Focus already inside the new
   * pane stays where it is. Sessions that first need a server lookup open later and are not followed.
   */
  const runMovingFocus = useCallback((command: () => void) => {
    const sideBefore = layoutRef.current.focusedSide;
    command();
    requestAnimationFrame(() => {
      const current = layoutRef.current;
      if (current.focusedSide !== sideBefore) {
        focusWorkspacePaneElement(
          current.focusedSide,
          getActiveTab(getPane(current, current.focusedSide))?.view,
          { keepFocusInside: true },
        );
      }
    });
  }, []);

  const startNewChat = useCallback((project: Project) => {
    runMovingFocus(() => handleNewSession(project));
  }, [handleNewSession, runMovingFocus]);

  const openSession = useCallback((sessionId: string, options: SessionOpenOptions) => {
    runMovingFocus(() => openSessionById(sessionId, options));
  }, [openSessionById, runMovingFocus]);

  const newChatLabel = t('workspace.newChat');
  const missingLabel = t('workspace.missingSession');
  const openTabs = useMemo(
    () => collectOpenTabs(layout, projects, paneProjects, { newChat: newChatLabel, missing: missingLabel }),
    [layout, missingLabel, newChatLabel, paneProjects, projects],
  );

  const isSplit = layout.right !== null;
  const workspace = useMemo<CommandPaletteWorkspaceCommands>(() => {
    const readFocusedTab = () => {
      const current = layoutRef.current;
      return { side: current.focusedSide, tab: getActiveTab(getPane(current, current.focusedSide)) };
    };
    return {
      canSplit,
      isSplit,
      isImmersive,
      openTabs,
      onToggleSplit: () => runMovingFocus(actions.toggleSplit),
      onFocusPane: (side) => runMovingFocus(() => actions.focusPane(side)),
      onMoveActiveTabToOtherSide: () => runMovingFocus(() => {
        const focused = readFocusedTab();
        if (focused.tab) {
          actions.moveTab(focused.side, focused.tab.key, getOtherPaneSide(focused.side));
        }
      }),
      onCloseOtherTabs: () => {
        const focused = readFocusedTab();
        if (focused.tab) {
          actions.closeOtherTabs(focused.side, focused.tab.key);
        }
      },
      onCloseFocusedPane: () => runMovingFocus(() => actions.closePane(layoutRef.current.focusedSide)),
      onActivateTab: (side, tabKey) => runMovingFocus(() => actions.activateTab(side, tabKey)),
      // Called straight from the palette's click or Enter, so the browser still sees a user gesture.
      onToggleFullscreen: toggleImmersive,
    };
  }, [actions, canSplit, isImmersive, isSplit, openTabs, runMovingFocus, toggleImmersive]);

  return (
    <CommandPalette
      selectedProject={selectedProject}
      onStartNewChat={startNewChat}
      onOpenSettings={openSettings}
      onShowTab={setActiveTab}
      onOpenSession={openSession}
      workspace={workspace}
    />
  );
}

export default memo(ProjectCommandPalette);
