import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent as ReactDragEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useTaskMasterProjectSync } from '@/modules/task-master';
import { useProjectPanesState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { useWorkspaceChrome } from '@/modules/project-workspace/context/WorkspaceChromeContext';
import { collectMountedPaneIds, getActiveTab, getPane } from '@/modules/project-workspace/utils/workspaceLayout';
import PaneSplitter from '@/modules/project-workspace/PaneSplitter';
import PaneTabsSheet from '@/modules/project-workspace/PaneTabsSheet';
import WorkspacePane from '@/modules/project-workspace/WorkspacePane';
import {
  PANE_MIN_WIDTH_PX,
  PANE_SPLITTER_WIDTH_PX,
  WORKSPACE_KEY_ENTRY_SEPARATOR,
  WORKSPACE_KEY_FIELD_SEPARATOR,
  WORKSPACE_PANE_SIDES,
} from '@/shared/constants';
import { useBackgroundSessionIdSet, useBusySessionIdSet } from '@/shared/context/SessionProtectionContext';
import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import type {
  PaneTabActivity,
  PaneTabDisplay,
  Project,
  ProjectWorkspaceShellProps,
  SessionDragPayload,
  UntitledPaneTabLabels,
  WorkspacePaneSide,
} from '@/shared/types';
import { cn, getOtherPaneSide, hasSessionDragPayload, resolvePaneTabTitle } from '@/shared/utils';

/**
 * The left pane while two panes share the main column: the share PaneSplitter writes into
 * `--pane-left-width`, kept between the pixel minimums of both panes.
 */
const LEFT_PANE_STYLE: CSSProperties = {
  flexBasis: `clamp(${PANE_MIN_WIDTH_PX}px, var(--pane-left-width, 50%), calc(100% - ${PANE_MIN_WIDTH_PX + PANE_SPLITTER_WIDTH_PX}px))`,
};

/** A new right pane fades in over 120ms; opacity only, no transform, so fixed overlays inside it stay viewport-fixed. */
const NEW_PANE_FADE_CLASS_NAME = 'animate-dialog-overlay-show [animation-duration:120ms] motion-reduce:animate-none';

/**
 * Which pane keeps a terminal both visible panes want. `left`/`right` are the terminal keys each
 * pane showed at the last render, so the pane that showed a key first can be told apart.
 */
type ShellLease = { left: string | null; right: string | null; holder: WorkspacePaneSide | null };

/** Handed to panes that have tabs: only an empty pane lists projects, so the others skip re-rendering on every projects refresh. */
const NO_PROJECTS: Project[] = [];

/**
 * Rendered by ProjectWorkspaceShell in the main column: the pane group. One pane while unsplit;
 * split, both panes side by side with a divider when the column is wide enough, otherwise the
 * focused pane only, the other kept mounted but hidden; phones render the focused pane alone.
 * It also owns what spans both panes: the drag-over state for the drop zones, the terminal lease,
 * the TaskMaster project (the focused pane's), whether tabs name their project, and the phone's tab sheet.
 */
function ProjectMainRegion({
  isMobile,
  ws,
  sendMessage,
}: ProjectWorkspaceShellProps) {
  const { t } = useTranslation();
  const {
    layout,
    paneProjects,
    projects,
    isLoadingProjects,
    attentionSessionIds,
    fallbackProject,
    actions,
    openSettings,
    setSidebarOpen,
    renameSession,
    refreshProjectsSilently,
    setPaneEditorUnsaved,
    getPaneRefreshToken,
    refreshTab,
    refreshWorkspace,
    isRefreshingWorkspace,
  } = useProjectPanesState();
  const { canSplit, isImmersive } = useWorkspaceChrome();
  const { sidebarVisible } = useUiPreferences();
  const busySessionIds = useBusySessionIdSet();
  const backgroundSessionIds = useBackgroundSessionIdSet();
  const groupRef = useRef<HTMLDivElement>(null);

  // A conversation or a tab is being dragged over the panes: they show their drop zones.
  const [isSessionDragOver, setIsSessionDragOver] = useState(false);
  // The phone's tab sheet, opened from a pane header's Tabs button.
  const [isTabsSheetOpen, setIsTabsSheetOpen] = useState(false);
  // See ShellLease; never persisted.
  const [shellLease, setShellLease] = useState<ShellLease>({ left: null, right: null, holder: null });

  // TaskMaster has one current project: the focused pane's, synced here once rather than by every pane.
  useTaskMasterProjectSync(paneProjects[layout.focusedSide]);

  const { focusedSide } = layout;
  const isSplit = layout.right !== null;
  const isSideBySide = isSplit && canSplit && !isMobile;
  const isSideVisible = (side: WorkspacePaneSide): boolean => (side === 'left'
    ? !isSplit || isSideBySide || focusedSide === 'left'
    : isSplit && (isSideBySide || focusedSide === 'right'));
  // Phones mount the focused pane only; a collapsed desktop split keeps the hidden pane mounted. The same
  // rule tells commit which layout changes unmount a pane (and its unsaved editor).
  const mountedPaneIds = collectMountedPaneIds(layout, { isMobile });

  // ---------------------------------------------------------------- tab labels and activity

  const getActivity = useCallback((sessionId: string | null): PaneTabActivity | null => {
    if (!sessionId) {
      return null;
    }
    if (busySessionIds.has(sessionId) && !backgroundSessionIds.has(sessionId)) {
      return 'running';
    }
    if (attentionSessionIds.has(sessionId)) {
      return 'attention';
    }
    return backgroundSessionIds.has(sessionId) ? 'background' : null;
  }, [attentionSessionIds, backgroundSessionIds, busySessionIds]);

  // The same fields, in the same order, as the sidebar row and the command palette read.
  const liveTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const project of projects) {
      for (const session of project.sessions ?? []) {
        const title = session.summary || session.name;
        if (typeof title === 'string' && title.trim()) {
          titles.set(session.id, title);
        }
      }
    }
    return titles;
  }, [projects]);

  const projectNames = useMemo(() => {
    const names = new Map(projects.map((project) => [project.projectId, project.displayName]));
    // Archived and deep-linked projects are not listed, but the panes showing them know them.
    for (const paneProject of [paneProjects.left, paneProjects.right]) {
      if (paneProject && !names.has(paneProject.projectId)) {
        names.set(paneProject.projectId, paneProject.displayName);
      }
    }
    return names;
  }, [paneProjects, projects]);

  // Built as a string first so the map keeps its identity while no label or activity changed.
  const untitledLabels: UntitledPaneTabLabels = {
    newChat: t('workspace.newChat', { defaultValue: 'New chat' }),
    missing: t('workspace.missingSession', { defaultValue: 'This conversation no longer exists' }),
  };
  const tabDisplayKey = [...layout.left.tabs, ...(layout.right?.tabs ?? [])]
    .map((tab) => [
      tab.key,
      resolvePaneTabTitle(tab, tab.sessionId ? liveTitles.get(tab.sessionId) : null, untitledLabels, t),
      projectNames.get(tab.projectId) ?? '',
      getActivity(tab.sessionId) ?? '',
    ].join(WORKSPACE_KEY_FIELD_SEPARATOR))
    .join(WORKSPACE_KEY_ENTRY_SEPARATOR);
  const tabDisplay = useMemo<ReadonlyMap<string, PaneTabDisplay>>(() => new Map(
    tabDisplayKey
      ? tabDisplayKey.split(WORKSPACE_KEY_ENTRY_SEPARATOR).map((entry) => {
        const [tabKey, title, projectName, activity] = entry.split(WORKSPACE_KEY_FIELD_SEPARATOR);
        return [tabKey, { title, projectName, activity: (activity || null) as PaneTabActivity | null }];
      })
      : [],
  ), [tabDisplayKey]);

  // Tabs name their project only when they cannot tell on their own: tabs of more than one project are
  // open, or the sidebar that lists the projects is out of sight on desktop (collapsed to its icon rail,
  // or immersive). A missing conversation's '' is no project.
  const openProjectCount = new Set(
    [...layout.left.tabs, ...(layout.right?.tabs ?? [])].map((tab) => tab.projectId).filter(Boolean),
  ).size;
  const showProjectNames = openProjectCount > 1 || (!isMobile && (isImmersive || !sidebarVisible));

  /** What a hidden pane's tabs are doing, for the collapsed switcher's dot: attention first, then any running work. */
  const getPaneActivity = (side: WorkspacePaneSide): PaneTabActivity | null => {
    let activity: PaneTabActivity | null = null;
    for (const tab of getPane(layout, side)?.tabs ?? []) {
      const tabActivity = tabDisplay.get(tab.key)?.activity ?? null;
      if (tabActivity === 'attention') {
        return 'attention';
      }
      if (tabActivity) {
        activity = 'running';
      }
    }
    return activity;
  };

  // ---------------------------------------------------------------- terminal lease

  /** The PTY key of a visible pane showing the Shell view, as the server builds it; null otherwise. */
  const getShellKey = (side: WorkspacePaneSide): string | null => {
    const tab = getActiveTab(getPane(layout, side));
    const project = paneProjects[side];
    if (!tab || tab.view !== 'shell' || tab.isMissing || !project || !isSideVisible(side)) {
      return null;
    }
    return `${project.fullPath || project.path || ''}_${tab.sessionId ?? 'default'}`;
  };
  const leftShellKey = getShellKey('left');
  const rightShellKey = getShellKey('right');
  const isShellContested = leftShellKey !== null && leftShellKey === rightShellKey;
  let shellHolder: WorkspacePaneSide | null = null;
  if (isShellContested) {
    if (shellLease.holder && shellLease.left === leftShellKey && shellLease.right === rightShellKey) {
      shellHolder = shellLease.holder;
    } else if (shellLease.left === leftShellKey) {
      // The pane that already showed this terminal keeps it.
      shellHolder = 'left';
    } else if (shellLease.right === rightShellKey) {
      shellHolder = 'right';
    } else {
      shellHolder = focusedSide;
    }
  }
  if (shellLease.left !== leftShellKey || shellLease.right !== rightShellKey || shellLease.holder !== shellHolder) {
    // Adjusting state while rendering: React re-renders right away, before anything is committed.
    setShellLease({ left: leftShellKey, right: rightShellKey, holder: shellHolder });
  }
  const getShellBlockedBy = (side: WorkspacePaneSide): WorkspacePaneSide | null => (
    isShellContested && shellHolder !== null && shellHolder !== side ? shellHolder : null
  );

  const claimShell = useCallback((side: WorkspacePaneSide) => {
    setShellLease((current) => (current.holder === side ? current : { ...current, holder: side }));
  }, []);

  // ---------------------------------------------------------------- drag and drop

  const handleGroupDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!isMobile && hasSessionDragPayload(event.dataTransfer)) {
      setIsSessionDragOver(true);
    }
  };

  const handleGroupDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget as Node | null;
    if (nextTarget && event.currentTarget.contains(nextTarget)) {
      return;
    }
    // Safari reports no relatedTarget on dragleave: a pointer still inside the group has not left it.
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX > rect.left && event.clientX < rect.right && event.clientY > rect.top && event.clientY < rect.bottom) {
      return;
    }
    setIsSessionDragOver(false);
  };

  // A drop anywhere, or a drag that ends (Escape, dropped outside the window), clears the zones.
  // It waits for the next task: this window listener runs before React hands the drop to a zone,
  // and a browser lets React commit between the two, so clearing at once would unmount the zone
  // before it ever saw the drop.
  useEffect(() => {
    if (!isSessionDragOver) {
      return undefined;
    }
    let clearTimer: number | null = null;
    const clearDragOver = () => {
      clearTimer ??= window.setTimeout(() => {
        clearTimer = null;
        setIsSessionDragOver(false);
      }, 0);
    };
    window.addEventListener('drop', clearDragOver, true);
    window.addEventListener('dragend', clearDragOver, true);
    return () => {
      window.removeEventListener('drop', clearDragOver, true);
      window.removeEventListener('dragend', clearDragOver, true);
      if (clearTimer !== null) {
        window.clearTimeout(clearTimer);
      }
    };
  }, [isSessionDragOver]);

  const handleDropSession = useCallback((side: WorkspacePaneSide, payload: SessionDragPayload, copy: boolean) => {
    setIsSessionDragOver(false);
    if (payload.fromTab) {
      // A tab dropped back onto its own pane stays where it is.
      if (payload.fromTab.side !== side) {
        actions.moveTab(payload.fromTab.side, payload.fromTab.tabKey, side, { copy });
      }
      return;
    }
    if (payload.sessionId) {
      // The row's title travels with the drop: a conversation the loaded pages lack still gets one.
      actions.openSession(
        {
          id: payload.sessionId,
          __projectId: payload.projectId ?? undefined,
          __provider: payload.provider,
          ...(payload.title ? { summary: payload.title } : {}),
        },
        { target: side, preview: false },
      );
    }
  }, [actions]);

  const openTabsSheet = useCallback(() => {
    setIsTabsSheetOpen(true);
  }, []);

  const tabCount = layout.left.tabs.length + (layout.right?.tabs.length ?? 0);

  const renderPane = (side: WorkspacePaneSide) => {
    const pane = getPane(layout, side);
    if (!pane || !mountedPaneIds.includes(pane.id)) {
      return null;
    }
    const isVisible = isSideVisible(side);
    const otherSide = getOtherPaneSide(side);
    // Only an empty pane reads these (its recent list and "open the current conversation here").
    const isEmpty = pane.tabs.length === 0;
    let className: string;
    let style: CSSProperties | undefined;
    if (!isVisible) {
      className = 'hidden';
    } else if (isSideBySide && side === 'left') {
      className = 'h-full flex-none';
      style = LEFT_PANE_STYLE;
    } else {
      className = cn('h-full flex-1', isSideBySide && side === 'right' && NEW_PANE_FADE_CLASS_NAME);
    }

    // Keyed by pane id, not side: a right pane taking the left slot keeps its chat and editor.
    return (
      <WorkspacePane
        key={pane.id}
        side={side}
        pane={pane}
        otherPane={isEmpty ? getPane(layout, otherSide) : null}
        project={paneProjects[side]}
        projects={isEmpty ? projects : NO_PROJECTS}
        isLoadingProjects={isLoadingProjects}
        fallbackProject={fallbackProject}
        tabDisplay={tabDisplay}
        hiddenPaneActivity={isSplit && !isSideBySide && isVisible ? getPaneActivity(otherSide) : null}
        actions={actions}
        isFocused={focusedSide === side}
        isVisible={isVisible}
        isSplit={isSplit}
        isSideBySide={isSideBySide}
        isLeftmost={isSideBySide ? side === 'left' : isVisible}
        isRightmost={isSideBySide ? side === 'right' : isVisible}
        isMobile={isMobile}
        isDropTargetActive={isSessionDragOver && isVisible}
        onDropSession={handleDropSession}
        shellBlockedBy={getShellBlockedBy(side)}
        onClaimShell={claimShell}
        tabCount={isMobile ? tabCount : 0}
        showProjectNames={showProjectNames}
        onOpenTabsSheet={openTabsSheet}
        ws={ws}
        sendMessage={sendMessage}
        openSettings={openSettings}
        setSidebarOpen={setSidebarOpen}
        renameSession={renameSession}
        refreshProjectsSilently={refreshProjectsSilently}
        onEditorUnsavedChange={setPaneEditorUnsaved}
        refreshToken={getPaneRefreshToken(pane.id)}
        onRefreshTab={refreshTab}
        onRefreshWorkspace={refreshWorkspace}
        isRefreshingWorkspace={isRefreshingWorkspace}
        className={className}
        style={style}
      />
    );
  };

  return (
    <div
      ref={groupRef}
      data-workspace-pane-group=""
      className="relative flex min-h-0 min-w-0 flex-1"
      onDragEnter={handleGroupDragOver}
      onDragOver={handleGroupDragOver}
      onDragLeave={handleGroupDragLeave}
    >
      {renderPane(WORKSPACE_PANE_SIDES[0])}
      {isSideBySide && (
        <PaneSplitter containerRef={groupRef} ratio={layout.splitRatio} onCommit={actions.setSplitRatio} />
      )}
      {renderPane(WORKSPACE_PANE_SIDES[1])}
      {isMobile && (
        <PaneTabsSheet
          open={isTabsSheetOpen}
          onOpenChange={setIsTabsSheetOpen}
          layout={layout}
          tabDisplay={tabDisplay}
          newChatProject={paneProjects[focusedSide] ?? fallbackProject}
          actions={actions}
          onRefreshAll={refreshWorkspace}
          isRefreshingWorkspace={isRefreshingWorkspace}
        />
      )}
    </div>
  );
}

export default memo(ProjectMainRegion);
