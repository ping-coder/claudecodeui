import { Layers, Maximize2, MessageSquareOff, Minimize2 } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { CSSProperties, Dispatch, ReactNode, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { useBrowserUseEnabled } from '@/modules/browser-use';
import { useTasksSettings } from '@/modules/task-master';
import { useWorkspaceChrome } from '@/modules/project-workspace/context/WorkspaceChromeContext';
import { useElementWidth } from '@/modules/project-workspace/hooks/useElementWidth';
import { getActiveTab } from '@/modules/project-workspace/utils/workspaceLayout';
import MobileMenuButton from '@/modules/project-workspace/MobileMenuButton';
import PaneDropOverlay from '@/modules/project-workspace/PaneDropOverlay';
import PaneEmptyState from '@/modules/project-workspace/PaneEmptyState';
import PaneTabBar from '@/modules/project-workspace/PaneTabBar';
import WorkspaceConnectionStatus from '@/modules/project-workspace/WorkspaceConnectionStatus';
import WorkspaceMain from '@/modules/project-workspace/WorkspaceMain';
import WorkspaceStateView from '@/modules/project-workspace/WorkspaceStateView';
import WorkspaceTabs from '@/modules/project-workspace/WorkspaceTabs';
import type {
  PaneTabActivity,
  PaneTabDisplay,
  Project,
  ProjectSession,
  SessionDragPayload,
  SessionNavigationOptions,
  WorkspaceLayoutActions,
  WorkspacePaneSide,
  WorkspacePaneState,
  WorkspaceViewSetter,
} from '@/shared/types';
import { DeploymentEnvironmentBadge } from '@/shared/ui';
import { cn, getPaneScopedDomId } from '@/shared/utils';

/** Narrower than this a pane drops its title block and labels only the active view. */
const COMPACT_PANE_WIDTH_PX = 640;
/** A focus that follows a Tab key press within this window is keyboard navigation into the pane. */
const TAB_FOCUS_WINDOW_MS = 120;
/** An empty set, so panes without another pane pass the same object every render. */
const NO_SESSION_IDS: ReadonlySet<string> = new Set();

type WorkspacePaneProps = {
  side: WorkspacePaneSide;
  pane: WorkspacePaneState;
  /** The other pane, read only by an empty pane ("open the current conversation here"); null while unsplit or while this pane has tabs. */
  otherPane: WorkspacePaneState | null;
  /** The active tab's project; null for an empty pane or a missing session. */
  project: Project | null;
  /** Every project, for an empty pane's recent conversations and project menu; the group passes an empty list while this pane has tabs. */
  projects: Project[];
  isLoadingProjects: boolean;
  /** Where a new chat goes when this pane has no project of its own. */
  fallbackProject: Project | null;
  /** tabKey -> label and activity, for both panes. */
  tabDisplay: ReadonlyMap<string, PaneTabDisplay>;
  /** Collapsed split: what the hidden pane's tabs are doing, drawn as a dot on the switcher. */
  hiddenPaneActivity: PaneTabActivity | null;
  actions: WorkspaceLayoutActions;
  isFocused: boolean;
  /** On screen; a collapsed split keeps the other pane mounted but hidden. */
  isVisible: boolean;
  /** A right pane exists. */
  isSplit: boolean;
  /** Both panes are on screen. */
  isSideBySide: boolean;
  /** The leftmost visible pane (immersive "Show sidebar"). */
  isLeftmost: boolean;
  /** The rightmost visible pane (split/merge and full-screen buttons). */
  isRightmost: boolean;
  isMobile: boolean;
  /** A conversation or tab is being dragged over the workspace: show the drop zones. */
  isDropTargetActive: boolean;
  onDropSession: (side: WorkspacePaneSide, payload: SessionDragPayload, copy: boolean) => void;
  /** The pane holding this pane's terminal key, when it is the other one. */
  shellBlockedBy: WorkspacePaneSide | null;
  onClaimShell: (side: WorkspacePaneSide) => void;
  /** Tabs in both panes, for the phone's Tabs button; 0 on desktop, which has no such button. */
  tabCount: number;
  onOpenTabsSheet: () => void;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  openSettings: (tab?: string) => void;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  renameSession: (sessionId: string, summary: string) => Promise<boolean>;
  refreshProjectsSilently: () => Promise<void>;
  /** Width and visibility, decided by the pane group. */
  className?: string;
  style?: CSSProperties;
};

type PaneMobileHeaderProps = {
  onMenuClick: () => void;
  actions: ReactNode;
};

/** A phone's header row above an empty pane or a missing session, which have no workspace header of their own. */
function PaneMobileHeader({ onMenuClick, actions }: PaneMobileHeaderProps) {
  return (
    <div className="pwa-header-safe flex flex-shrink-0 items-center gap-2 border-b border-border/50 bg-background/80 p-2 backdrop-blur-sm sm:p-3">
      <MobileMenuButton onMenuClick={onMenuClick} compact />
      <DeploymentEnvironmentBadge className="max-w-20" />
      {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
    </div>
  );
}

type MissingSessionNoticeProps = {
  header: ReactNode;
  onClose: () => void;
};

/** Stands in for a tab whose conversation no longer exists; the tab stays until the user closes it. */
function MissingSessionNotice({ header, onClose }: MissingSessionNoticeProps) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <MessageSquareOff className="mx-auto mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <p className="mb-4 text-sm text-muted-foreground">
            {t('workspace.missingSession', { defaultValue: 'This conversation no longer exists' })}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            {t('workspace.closeTab', { defaultValue: 'Close tab' })}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Rendered by ProjectMainRegion once per side (keyed by side). One pane of the split workspace:
 * its tab bar on desktop, then the active tab in WorkspaceMain, an empty pane, or a missing-session
 * notice. A pointer press anywhere inside focuses the pane, as does keyboard focus arriving by Tab
 * (programmatic focus does not); typing inside keeps a preview tab open.
 */
function WorkspacePane({
  side,
  pane,
  otherPane,
  project,
  projects,
  isLoadingProjects,
  fallbackProject,
  tabDisplay,
  hiddenPaneActivity,
  actions,
  isFocused,
  isVisible,
  isSplit,
  isSideBySide,
  isLeftmost,
  isRightmost,
  isMobile,
  isDropTargetActive,
  onDropSession,
  shellBlockedBy,
  onClaimShell,
  tabCount,
  onOpenTabsSheet,
  ws,
  sendMessage,
  openSettings,
  setSidebarOpen,
  renameSession,
  refreshProjectsSilently,
  className,
  style,
}: WorkspacePaneProps) {
  const { t } = useTranslation();
  const { canSplit, isImmersive, toggleImmersive } = useWorkspaceChrome();
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const browserUseEnabled = useBrowserUseEnabled();

  const rootRef = useRef<HTMLDivElement>(null);
  const paneWidth = useElementWidth(rootRef);
  // The pane's own width decides, not the viewport: a half-width pane on a wide screen is compact too.
  const isCompact = !isMobile && paneWidth > 0 && paneWidth < COMPACT_PANE_WIDTH_PX;

  const activeTab = getActiveTab(pane);
  const isMissing = Boolean(activeTab?.isMissing);
  const hasTabBar = !isMobile;
  const showConnectionStatus = !(isSideBySide && side === 'right');
  const panelId = getPaneScopedDomId(side, 'tabpanel');

  // Latest tab facts for the callbacks handed to WorkspaceMain, which stay stable across tab
  // switches so the memoized chat does not re-render for a new callback identity.
  const latestTabRef = useRef({ tabKey: activeTab?.key ?? null, projectId: project?.projectId, provider: activeTab?.provider });
  useLayoutEffect(() => {
    latestTabRef.current = { tabKey: activeTab?.key ?? null, projectId: project?.projectId, provider: activeTab?.provider };
  });

  // When the last Tab key went down: focus arriving right after it is the user moving into this pane.
  const lastTabKeyAtRef = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    const recordTabKey = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        lastTabKeyAtRef.current = performance.now();
      }
    };
    window.addEventListener('keydown', recordTabKey, true);
    return () => window.removeEventListener('keydown', recordTabKey, true);
  }, []);

  const handlePointerDownCapture = () => {
    // The first click already acts on this pane: it is focused before the target handles the press.
    if (!isFocused) {
      actions.focusPane(side);
    }
  };

  const handleFocusCapture = () => {
    // Autofocus, a dialog handing focus back and AskUserQuestion focus programmatically: only Tab moves the pane focus.
    if (!isFocused && performance.now() - lastTabKeyAtRef.current <= TAB_FOCUS_WINDOW_MS) {
      actions.focusPane(side);
    }
  };

  const handleInputCapture = () => {
    // Typing anywhere in the pane (composer, terminal, rename box) means the user is working here.
    if (activeTab?.isPreview) {
      actions.pinTab(side, activeTab.key);
    }
  };

  const setActiveTab = useCallback<WorkspaceViewSetter>((view, options) => {
    const { tabKey } = latestTabRef.current;
    if (tabKey) {
      actions.setTabView(side, tabKey, view, { pin: Boolean(options?.userInitiated) });
    }
  }, [actions, side]);

  // A fork or a just-created session opens kept, in this pane, under this pane's project.
  const handleNavigateToSession = useCallback((targetSessionId: string, options?: SessionNavigationOptions) => {
    const { projectId, provider } = latestTabRef.current;
    actions.openSession(
      { id: targetSessionId, __projectId: projectId, __provider: provider },
      { target: side, preview: false, history: options?.replace ? 'replace' : 'push' },
    );
  }, [actions, side]);

  // The worktrees view switches project by opening that project's new chat in this pane.
  const handleProjectSelect = useCallback((selectedProject: Project) => {
    actions.openNewSession(selectedProject, { target: side });
  }, [actions, side]);

  const handleProjectsRefresh = useCallback(() => {
    void refreshProjectsSilently();
  }, [refreshProjectsSilently]);

  const openSidebar = useCallback(() => {
    setSidebarOpen(true);
  }, [setSidebarOpen]);

  const focusThisPane = useCallback(() => {
    actions.focusPane(side);
  }, [actions, side]);

  const claimShell = useCallback(() => {
    onClaimShell(side);
  }, [onClaimShell, side]);

  const closeActiveTab = () => {
    if (activeTab) {
      actions.closeTab(side, activeTab.key);
    }
  };

  const showTabsButton = tabCount > 1 || isSplit;
  const mobileHeaderActions = useMemo(() => {
    if (!isMobile) {
      return null;
    }
    const tabsLabel = t('workspace.tabsButton', { count: tabCount, defaultValue: 'Tabs ({{count}})' });
    const fullscreenLabel = isImmersive
      ? t('workspace.exitFullscreen', { defaultValue: 'Exit full screen' })
      : t('workspace.fullscreen', { defaultValue: 'Full screen' });
    return (
      <>
        {showTabsButton && (
          <button
            type="button"
            onClick={onOpenTabsSheet}
            aria-label={tabsLabel}
            className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            <Layers className="h-4 w-4" aria-hidden="true" />
            <span aria-hidden="true">{tabCount}</span>
          </button>
        )}
        <button
          type="button"
          onClick={toggleImmersive}
          aria-label={fullscreenLabel}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          {isImmersive ? <Minimize2 className="h-4 w-4" aria-hidden="true" /> : <Maximize2 className="h-4 w-4" aria-hidden="true" />}
        </button>
      </>
    );
  }, [isImmersive, isMobile, onOpenTabsSheet, showTabsButton, t, tabCount, toggleImmersive]);

  // Phones hide every header while immersive; the floating capsule is the way out.
  const mobileHeader = isMobile && !isImmersive
    ? <PaneMobileHeader onMenuClick={openSidebar} actions={mobileHeaderActions} />
    : null;

  const otherActiveTab = getActiveTab(otherPane);
  const otherPaneSession = useMemo<ProjectSession | null>(() => (
    otherActiveTab?.sessionId && !otherActiveTab.isMissing
      ? {
        ...otherActiveTab.session,
        id: otherActiveTab.sessionId,
        __projectId: otherActiveTab.projectId,
        __provider: otherActiveTab.provider,
      }
      : null
  ), [otherActiveTab]);
  const otherPaneSessionIds = useMemo<ReadonlySet<string>>(() => (
    otherPane
      ? new Set(otherPane.tabs.map((tab) => tab.sessionId).filter((sessionId): sessionId is string => Boolean(sessionId)))
      : NO_SESSION_IDS
  ), [otherPane]);

  const hasContent = Boolean(activeTab && !isMissing && project);
  const immersiveContent = isImmersive && hasTabBar && (hasContent || showConnectionStatus) ? (
    <>
      {hasContent && activeTab && (
        <WorkspaceTabs
          compact
          activeTab={activeTab.view}
          setActiveTab={setActiveTab}
          shouldShowTasksTab={Boolean(tasksEnabled && isTaskMasterInstalled)}
          shouldShowBrowserTab={browserUseEnabled}
        />
      )}
      {showConnectionStatus && <WorkspaceConnectionStatus />}
    </>
  ) : null;

  let content: ReactNode;
  if (pane.tabs.length === 0) {
    content = isLoadingProjects ? (
      <WorkspaceStateView mode="loading" isMobile={Boolean(mobileHeader)} onMenuClick={openSidebar} />
    ) : (
      <PaneEmptyState
        side={side}
        projects={projects}
        defaultProject={project ?? fallbackProject}
        isSplit={isSplit}
        isMobile={isMobile}
        otherPaneSession={otherPaneSession}
        otherPaneSessionIds={otherPaneSessionIds}
        actions={actions}
        mobileHeader={mobileHeader}
        onMenuClick={openSidebar}
      />
    );
  } else if (isMissing) {
    content = <MissingSessionNotice header={mobileHeader} onClose={closeActiveTab} />;
  } else {
    content = (
      <WorkspaceMain
        side={side}
        isFocusedPane={isFocused}
        isPaneVisible={isVisible}
        isSplitPane={isSideBySide}
        compact={isCompact}
        hideHeader={isImmersive}
        headerActions={mobileHeaderActions}
        showConnectionStatus={showConnectionStatus}
        shellBlockedBy={shellBlockedBy}
        onClaimShell={claimShell}
        onFocusPane={focusThisPane}
        selectedProject={project}
        selectedSession={activeTab?.session ?? null}
        activeTab={activeTab?.view ?? 'chat'}
        setActiveTab={setActiveTab}
        ws={ws}
        sendMessage={sendMessage}
        isMobile={isMobile}
        onMenuClick={openSidebar}
        isLoading={isLoadingProjects}
        onNavigateToSession={handleNavigateToSession}
        onSessionEstablished={actions.establishDraft}
        onShowSettings={openSettings}
        externalMessageUpdate={pane.externalRevision}
        newSessionTrigger={pane.draftActivation}
        onProjectSelect={handleProjectSelect}
        onProjectsRefresh={handleProjectsRefresh}
        onRenameSession={renameSession}
      />
    );
  }

  const isCollapsed = isSplit && !isSideBySide;
  // Unsplit, the zones offer "here" and, room permitting, "on the right (split)"; split, one zone
  // per pane lines up with the divider; collapsed, the visible pane offers both sides.
  let dropTargets: readonly WorkspacePaneSide[];
  if (isSideBySide) {
    dropTargets = [side];
  } else if (isSplit || canSplit) {
    dropTargets = ['left', 'right'];
  } else {
    dropTargets = ['left'];
  }
  const tabPanelProps = hasTabBar && activeTab
    ? { role: 'tabpanel', 'aria-labelledby': `${panelId}-${activeTab.key}` }
    : {};

  return (
    <div
      ref={rootRef}
      data-workspace-pane={side}
      role="group"
      aria-label={isSplit
        ? (side === 'left' ? t('workspace.leftPane', { defaultValue: 'Left pane' }) : t('workspace.rightPane', { defaultValue: 'Right pane' }))
        : undefined}
      tabIndex={-1}
      className={cn('flex min-h-0 min-w-0 flex-col overflow-hidden outline-none', className)}
      style={style}
      onPointerDownCapture={handlePointerDownCapture}
      onFocusCapture={handleFocusCapture}
      onInputCapture={handleInputCapture}
    >
      {hasTabBar && (
        <PaneTabBar
          side={side}
          pane={pane}
          tabDisplay={tabDisplay}
          actions={actions}
          newChatProject={project ?? fallbackProject}
          panelId={panelId}
          isFocused={isFocused}
          isSplit={isSplit}
          isSideBySide={isSideBySide}
          isCollapsed={isCollapsed}
          hiddenPaneActivity={hiddenPaneActivity}
          showWorkspaceControls={isRightmost}
          isLeftmost={isLeftmost}
          immersiveContent={immersiveContent}
        />
      )}
      <div id={panelId} {...tabPanelProps} className="relative flex min-h-0 flex-1 flex-col">
        {content}
        {isDropTargetActive && (
          <PaneDropOverlay targets={dropTargets} isSplit={isSplit} onDropSession={onDropSession} />
        )}
      </div>
    </div>
  );
}

export default memo(WorkspacePane);
