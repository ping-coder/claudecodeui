import { Layers, Maximize2, MessageSquareOff, Minimize2 } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, Dispatch, ReactNode, SetStateAction, SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useBrowserUseEnabled } from '@/modules/browser-use';
import { usePaletteOps, usePaletteOpsRegister } from '@/modules/command-palette';
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
import { NO_PALETTE_OPS } from '@/shared/constants';
import type {
  AppTab,
  PaneTabActivity,
  PaneTabDisplay,
  Project,
  ProjectSession,
  SessionDragPayload,
  SessionEstablishedContext,
  SessionNavigationOptions,
  WorkspaceLayoutActions,
  WorkspacePaneSide,
  WorkspacePaneState,
  WorkspaceViewSetter,
} from '@/shared/types';
import { DeploymentEnvironmentBadge } from '@/shared/ui';
import { cn, getPaneScopedDomId } from '@/shared/utils';

/** Narrower than this a pane beside another drops its title block and labels only the active view. */
const COMPACT_PANE_WIDTH_PX = 640;
/** A focus that follows a Tab key press within this window is keyboard navigation into the pane. */
const TAB_FOCUS_WINDOW_MS = 120;
/** An empty set, so panes without another pane pass the same object every render. */
const NO_SESSION_IDS: ReadonlySet<string> = new Set();

/** Whether a measured pane width calls for the compact header (0 is not measured yet). */
const isCompactPaneWidth = (width: number): boolean => width > 0 && width < COMPACT_PANE_WIDTH_PX;

/** Whether an event comes from a workspace-wide control (split, full screen, show sidebar), which acts on the workspace, not on this pane. */
const isWorkspaceControlEvent = (event: SyntheticEvent): boolean => (
  event.target instanceof Element && event.target.closest('[data-workspace-control]') !== null
);

type PaletteOperations = ReturnType<typeof usePaletteOps>;

/** A palette or quick-settings action picked while the focused pane showed nothing, waiting for the new chat it opened there. */
type PendingContentOperation = {
  run: (ops: PaletteOperations) => void;
  /** The pane's draft counter at the pick: the new chat becoming its active tab bumps it. */
  draftActivation: number;
};

/** What a pane's WorkspaceMain shows: the active tab's project, session and view. */
type PaneContent = { project: Project; session: ProjectSession | null; view: AppTab };

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
  /** Hears this pane's editor turn dirty or clean (by pane id), so layout changes that would unmount the pane ask first. */
  onEditorUnsavedChange: (paneId: string, hasUnsavedChanges: boolean) => void;
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
 * Rendered by ProjectMainRegion once per pane (keyed by pane id). One pane of the split workspace: its
 * tab bar on desktop, then the active tab in WorkspaceMain, or an empty pane / missing-session notice
 * over the WorkspaceMain it last showed, kept mounted and hidden. A pointer press anywhere inside focuses
 * the pane (workspace-wide controls excepted), as does keyboard focus arriving by Tab (programmatic focus
 * does not); typing inside or opening a file from the chat keeps a preview tab open.
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
  onEditorUnsavedChange,
  className,
  style,
}: WorkspacePaneProps) {
  const { t } = useTranslation();
  const { canSplit, isImmersive, toggleImmersive } = useWorkspaceChrome();
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const browserUseEnabled = useBrowserUseEnabled();
  const paletteOps = usePaletteOps();

  const rootRef = useRef<HTMLDivElement>(null);
  // Only the crossing of the threshold re-renders the pane, not every pixel of a divider drag.
  const isNarrow = useElementWidth(rootRef, isCompactPaneWidth);
  // The pane's own width decides, not the viewport, and only beside another pane: a single pane keeps
  // its title (project name, double-click rename) at any width.
  const isCompact = !isMobile && isSideBySide && isNarrow;

  const activeTab = getActiveTab(pane);
  const isMissing = Boolean(activeTab?.isMissing);
  const hasTabBar = !isMobile;
  const showConnectionStatus = !(isSideBySide && side === 'right');
  const panelId = getPaneScopedDomId(side, 'tabpanel');

  const liveContent: PaneContent | null = activeTab && !isMissing && project
    ? { project, session: activeTab.session, view: activeTab.view }
    : null;
  const hasContent = liveContent !== null;
  // The content WorkspaceMain last showed. While the pane shows nothing (no tab, a conversation that
  // is gone) WorkspaceMain keeps it, hidden, instead of unmounting: its chat keeps hearing the runs it
  // follows (reporting the background work they leave, permission prompts) and its editor keeps any
  // unsaved buffer for when the pane shows something again.
  const [shownContent, setShownContent] = useState<PaneContent | null>(liveContent);
  if (
    liveContent
    && (shownContent?.project !== liveContent.project
      || shownContent.session !== liveContent.session
      || shownContent.view !== liveContent.view)
  ) {
    // Adjusting state while rendering: React re-renders right away, before anything is committed.
    setShownContent(liveContent);
  }
  const mainContent = liveContent ?? shownContent;

  // The draft tab on screen. A send binds the session it creates to it (see handleSessionEstablished).
  const activeDraftKey = activeTab && activeTab.sessionId === null ? activeTab.key : null;
  // The project palette and quick-settings actions use when this pane shows nothing: the one the palette lists.
  const commandProject = project ?? fallbackProject;

  // Latest tab facts for the callbacks handed to WorkspaceMain, which stay stable across tab
  // switches so the memoized chat does not re-render for a new callback identity.
  const latestTabRef = useRef({
    tabKey: activeTab?.key ?? null,
    isPreview: Boolean(activeTab?.isPreview),
    hasContent,
    commandProject,
    draftActivation: pane.draftActivation,
  });
  useLayoutEffect(() => {
    latestTabRef.current = {
      tabKey: activeTab?.key ?? null,
      isPreview: Boolean(activeTab?.isPreview),
      hasContent,
      commandProject,
      draftActivation: pane.draftActivation,
    };
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

  const handlePointerDownCapture = (event: SyntheticEvent) => {
    // The first click already acts on this pane: it is focused before the target handles the press.
    // Workspace-wide controls (split, full screen, show sidebar) only sit here for their position.
    if (!isFocused && !isWorkspaceControlEvent(event)) {
      actions.focusPane(side);
    }
  };

  const handleFocusCapture = (event: SyntheticEvent) => {
    // Autofocus, a dialog handing focus back and AskUserQuestion focus programmatically: only Tab moves the pane focus.
    if (!isFocused && !isWorkspaceControlEvent(event) && performance.now() - lastTabKeyAtRef.current <= TAB_FOCUS_WINDOW_MS) {
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
    const { tabKey, hasContent: isShowingContent } = latestTabRef.current;
    // A hidden WorkspaceMain (an empty pane, a missing conversation) never changes a tab's view.
    if (tabKey && isShowingContent) {
      actions.setTabView(side, tabKey, view, { pin: Boolean(options?.userInitiated) });
    }
  }, [actions, side]);

  // Opening a file from the chat is the user working here, like switching views: a preview tab stays.
  const keepActiveTab = useCallback(() => {
    const { tabKey, isPreview, hasContent: isShowingContent } = latestTabRef.current;
    if (tabKey && isPreview && isShowingContent) {
      actions.pinTab(side, tabKey);
    }
  }, [actions, side]);

  // The session this pane's chat just established: the navigation the chat asks for next is already done.
  const justEstablishedRef = useRef<string | null>(null);

  // Bound to the draft on screen at render time. A first send keeps the callback of the render it
  // started in, so however slow it is, it converts the draft that sent it (wherever the user moved it
  // meanwhile), or nothing once that draft was closed, never a newer draft of the same project.
  const handleSessionEstablished = useCallback((sessionId: string, context: SessionEstablishedContext) => {
    justEstablishedRef.current = sessionId;
    actions.establishDraft(sessionId, context, activeDraftKey ? { draftTabKey: activeDraftKey } : undefined);
  }, [actions, activeDraftKey]);

  const handleNavigateToSession = useCallback((targetSessionId: string, options?: SessionNavigationOptions) => {
    // establishDraft converted the draft in place; opening it again would pull the focus back here, push
    // the URL, and rebuild a pane closed in the meantime.
    if (justEstablishedRef.current === targetSessionId) {
      justEstablishedRef.current = null;
      return;
    }
    // A fork: kept, in this pane, under the project its own row names (resolved, never read off
    // whatever tab is on screen when the fork comes back), and without taking the focus from wherever
    // the user went meanwhile.
    actions.openSession(
      { id: targetSessionId },
      { target: side, preview: false, history: options?.replace ? 'replace' : 'push', inBackground: true },
    );
  }, [actions, side]);

  // The worktrees view switches project by opening that project's new chat in this pane.
  const handleProjectSelect = useCallback((selectedProject: Project) => {
    actions.openNewSession(selectedProject, { target: side });
  }, [actions, side]);

  const handleProjectsRefresh = useCallback(() => {
    void refreshProjectsSilently();
  }, [refreshProjectsSilently]);

  const reportEditorUnsaved = useCallback((hasUnsavedChanges: boolean) => {
    onEditorUnsavedChange(pane.id, hasUnsavedChanges);
  }, [onEditorUnsavedChange, pane.id]);

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

  // ---------------------------------------------------------------- palette actions in a pane without content

  // The action picked while this focused pane showed nothing: it runs once the new chat it opened here is
  // this pane's active tab, through the operations that chat and its WorkspaceMain register. State, not a
  // ref, so the pane renders right after the pick even when the open changed nothing (the user kept unsaved
  // edits it would have dropped): an action whose chat never came is dropped then, never run on whatever
  // this pane shows later.
  const [pendingContentOperation, setPendingContentOperation] = useState<PendingContentOperation | null>(null);
  const runInNewChat = useCallback((view: AppTab, run: (ops: PaletteOperations) => void) => {
    const { commandProject: targetProject, draftActivation } = latestTabRef.current;
    if (!targetProject) {
      return;
    }
    setPendingContentOperation({ run, draftActivation });
    // Only the focused pane without content registers these, so `side` is still where this pane is: nothing
    // opens a chat before them in the same event (ProjectQuickSettingsRegion leaves that to the insert).
    actions.openNewSession(targetProject, { target: side, view });
  }, [actions, side]);
  const contentlessPaneOps = useMemo(() => ({
    openFile: (filePath: string) => runInNewChat('files', (ops) => ops.openFile(filePath)),
    openFileInEditor: (filePath: string, line?: number | null) => runInNewChat('chat', (ops) => ops.openFileInEditor(filePath, line)),
    openDirectory: (directoryPath: string) => runInNewChat('files', (ops) => ops.openDirectory(directoryPath)),
    insertComposerText: (text: string) => runInNewChat('chat', (ops) => ops.insertComposerText(text)),
  }), [runInNewChat]);
  usePaletteOpsRegister(isFocused && !hasContent && !isLoadingProjects ? contentlessPaneOps : NO_PALETTE_OPS);
  // The open put its chat here only if a draft became this pane's active tab since the pick; the render
  // right after the pick already shows what the open did.
  const landedContentOperation = pendingContentOperation
    && hasContent
    && pane.draftActivation !== pendingContentOperation.draftActivation
    ? pendingContentOperation
    : null;
  if (pendingContentOperation && !landedContentOperation) {
    // Adjusting state while rendering: React re-renders right away, before anything is committed.
    setPendingContentOperation(null);
  }
  useEffect(() => {
    if (!landedContentOperation) {
      return undefined;
    }
    // A frame later the pane's chat and editor have registered their operations and settled on the new chat.
    const frame = window.requestAnimationFrame(() => {
      setPendingContentOperation(null);
      landedContentOperation.run(paletteOps);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [landedContentOperation, paletteOps]);

  // ---------------------------------------------------------------- chrome

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

  // What the pane shows in place of its content.
  let placeholder: ReactNode = null;
  if (!hasContent) {
    if (pane.tabs.length === 0 && !isLoadingProjects) {
      placeholder = (
        <PaneEmptyState
          side={side}
          projects={projects}
          defaultProject={project ?? fallbackProject}
          isSplit={isSplit}
          canSplit={canSplit}
          isMobile={isMobile}
          otherPaneSession={otherPaneSession}
          otherPaneSessionIds={otherPaneSessionIds}
          actions={actions}
          mobileHeader={mobileHeader}
          onMenuClick={openSidebar}
        />
      );
    } else if (isMissing) {
      placeholder = <MissingSessionNotice header={mobileHeader} onClose={closeActiveTab} />;
    } else {
      // Projects still loading, or a tab whose project is not known (yet).
      placeholder = (
        <WorkspaceStateView mode={isLoadingProjects ? 'loading' : 'empty'} isMobile={Boolean(mobileHeader)} onMenuClick={openSidebar} />
      );
    }
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

  // No tabIndex on the root: it would take the focus of every click on plain text in the pane, and the
  // keyboard scrolling of the scroll area under it. Programmatic focus lends it one until a press or focus
  // inside the pane takes it back (focusWorkspacePaneElement).
  return (
    <div
      ref={rootRef}
      data-workspace-pane={side}
      role="group"
      aria-label={isSplit
        ? (side === 'left' ? t('workspace.leftPane', { defaultValue: 'Left pane' }) : t('workspace.rightPane', { defaultValue: 'Right pane' }))
        : undefined}
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
        {mainContent && (
          <div data-pane-content={hasContent ? 'shown' : 'kept'} className={hasContent ? 'contents' : 'hidden'}>
            <WorkspaceMain
              side={side}
              isFocusedPane={isFocused && hasContent}
              isPaneVisible={isVisible && hasContent}
              isSplitPane={isSideBySide}
              compact={isCompact}
              hideHeader={isImmersive}
              headerActions={mobileHeaderActions}
              showConnectionStatus={showConnectionStatus}
              shellBlockedBy={shellBlockedBy}
              onClaimShell={claimShell}
              onFocusPane={focusThisPane}
              selectedProject={mainContent.project}
              selectedSession={mainContent.session}
              activeTab={mainContent.view}
              setActiveTab={setActiveTab}
              ws={ws}
              sendMessage={sendMessage}
              isMobile={isMobile}
              onMenuClick={openSidebar}
              isLoading={isLoadingProjects}
              onNavigateToSession={handleNavigateToSession}
              onSessionEstablished={handleSessionEstablished}
              onShowSettings={openSettings}
              externalMessageUpdate={pane.externalRevision}
              newSessionTrigger={pane.draftActivation}
              onProjectSelect={handleProjectSelect}
              onProjectsRefresh={handleProjectsRefresh}
              onRenameSession={renameSession}
              onEditorUnsavedChange={reportEditorUnsaved}
              onKeepTab={keepActiveTab}
            />
          </div>
        )}
        {placeholder}
        {isDropTargetActive && (
          <PaneDropOverlay targets={dropTargets} isSplit={isSplit} onDropSession={onDropSession} />
        )}
      </div>
    </div>
  );
}

export default memo(WorkspacePane);
