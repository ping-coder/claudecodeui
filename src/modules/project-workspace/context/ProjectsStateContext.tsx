import { createContext, useContext, useMemo } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import { useProjectsState } from '@/modules/project-workspace/hooks/useProjectsState';
import type {
  AppTab,
  IsSessionProcessing,
  Project,
  ProjectSession,
  ServerEvent,
  SessionOpenOptions,
  SidebarPaneTargeting,
  WorkspaceLayout,
  WorkspaceLayoutActions,
  WorkspacePaneSide,
} from '@/shared/types';

type ProjectsState = ReturnType<typeof useProjectsState>;

/** The layout, each pane's project and the layout actions: what the main region renders the panes from, and what the shell, the palette and the run notifications read about the panes. */
type ProjectPanesState = {
  layout: WorkspaceLayout;
  /** Stable object per pane (projects row merged via mergeProjectSelectionMetadata, or an unlisted/archived project); null for an empty pane. */
  paneProjects: Readonly<Record<WorkspacePaneSide, Project | null>>;
  projects: Project[];
  isLoadingProjects: boolean;
  attentionSessionIds: ReadonlySet<string>;
  /** Default project for new chats: focused pane, other pane, last browsed, first. */
  fallbackProject: Project | null;
  actions: WorkspaceLayoutActions;
  openSettings: (tab?: string) => void;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  renameSession: (sessionId: string, summary: string) => Promise<boolean>;
  refreshProjectsSilently: () => Promise<void>;
  /**
   * Reported by ProjectWorkspaceShell from its main-column measurement (canSplit): whether two panes fit
   * side by side. A split that does not fit shows the focused pane only, so only that pane's session
   * counts as on screen (no attention dot, external reloads) and the hidden pane's can be flagged.
   */
  setCanShowBothPanes: (canShowBothPanes: boolean) => void;
  /**
   * Reported per pane (WorkspacePaneState.id) by the pane's WorkspaceMain whenever its editor's buffer
   * turns dirty or clean: a layout change that would unmount a pane with unsaved edits asks first.
   */
  setPaneEditorUnsaved: (paneId: string, hasUnsavedChanges: boolean) => void;
  /** A pane's refresh token (by WorkspacePaneState.id): its views reload, without remounting, when it moves. */
  getPaneRefreshToken: (paneId: string) => number;
  /** Refreshes a pane's active tab: its view, its chat and its editor (unless the buffer holds edits). */
  refreshTab: (side: WorkspacePaneSide) => void;
  /** Refreshes every mounted pane, the project list, the sidebar lists and the app state; single-flight. */
  refreshWorkspace: () => Promise<void>;
  /** A refreshWorkspace is on its way: its buttons spin and stay disabled. */
  isRefreshingWorkspace: boolean;
};

/** What ProjectSidebarRegion needs to render the sidebar module for the focused pane. */
type ProjectSidebarState = {
  sidebarOpen: boolean;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  /** Same shape as before the split. selectedProject/selectedSession = focused pane; onSessionSelect(session, options?) = openSession; onNewSession(project, options?) = openNewSession; onProjectSelect only records the browsed project. */
  sidebarSharedProps: ProjectsState['sidebarSharedProps'];
  /** ProjectSidebarRegion adds canTargetSides = !isMobile && (chrome.canSplit || isSplit). */
  paneTargetingBase: Omit<SidebarPaneTargeting, 'canTargetSides'>;
  /** Changes whenever the focused pane's active tab changes (closes the immersive sidebar peek). */
  focusedTabKey: string | null;
};

/** What the command palette and quick settings act on: the focused pane. */
type ProjectCommandState = {
  /** Focused pane's project, else fallbackProject (a stable object). A focused pane that shows nothing runs file and composer actions in a new chat of it. */
  selectedProject: Project | null;
  /** New chat in the focused pane. */
  handleNewSession: (project: Project) => void;
  openSettings: (tab?: string) => void;
  /** Focused tab's view, user-initiated (pins); a focused pane that shows nothing opens a new chat in selectedProject on that view. */
  setActiveTab: (view: AppTab) => void;
  openSessionById: (sessionId: string, options?: SessionOpenOptions) => void;
  layout: WorkspaceLayout;
  actions: WorkspaceLayoutActions;
  /** The palette's Refresh tab and Refresh all (see ProjectPanesState). */
  refreshTab: (side: WorkspacePaneSide) => void;
  refreshWorkspace: () => Promise<void>;
  isRefreshingWorkspace: boolean;
};

/** What the headless page effects need: palette registrations, notification clicks and the document title's page and running parts. */
type ProjectEffectsState = {
  openSettings: (tab?: string) => void;
  refreshProjectsSilently: () => Promise<void>;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  openSessionById: (sessionId: string, options?: SessionOpenOptions) => void;
  focusedProject: Project | null;
  focusedSession: ProjectSession | null;
  /** Where both title parts look up a session's live title (renames and generated summaries land here). */
  projects: Project[];
  /** The sessions this tab has open, which the running part names first (and counts external CLI turns only for), and the tabs' title snapshots. */
  layout: WorkspaceLayout;
};

type ProjectsStateProviderProps = {
  children: ReactNode;
  sessionId?: string;
  navigate: NavigateFunction;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  isMobile: boolean;
  isSessionProcessing: IsSessionProcessing;
  /** Refresh all's share outside the workspace state (see useProjectsState). */
  refreshAppState?: () => Promise<unknown> | void;
};

const ProjectPanesContext = createContext<ProjectPanesState | null>(null);
const ProjectSidebarContext = createContext<ProjectSidebarState | null>(null);
const ProjectCommandContext = createContext<ProjectCommandState | null>(null);
const ProjectEffectsContext = createContext<ProjectEffectsState | null>(null);

/** Rendered by ProjectWorkspaceRoute to own the workspace's project, session and pane state and expose it through this module's context hooks. */
export function ProjectsStateProvider({
  children,
  sessionId,
  navigate,
  subscribe,
  isMobile,
  isSessionProcessing,
  refreshAppState,
}: ProjectsStateProviderProps) {
  const state = useProjectsState({
    sessionId,
    navigate,
    subscribe,
    isMobile,
    isSessionProcessing,
    refreshAppState,
  });

  const panesState = useMemo<ProjectPanesState>(
    () => ({
      layout: state.layout,
      paneProjects: state.paneProjects,
      projects: state.projects,
      isLoadingProjects: state.isLoadingProjects,
      attentionSessionIds: state.attentionSessionIds,
      fallbackProject: state.fallbackProject,
      actions: state.actions,
      openSettings: state.openSettings,
      setSidebarOpen: state.setSidebarOpen,
      renameSession: state.renameSession,
      refreshProjectsSilently: state.refreshProjectsSilently,
      setCanShowBothPanes: state.setCanShowBothPanes,
      setPaneEditorUnsaved: state.setPaneEditorUnsaved,
      getPaneRefreshToken: state.getPaneRefreshToken,
      refreshTab: state.refreshTab,
      refreshWorkspace: state.refreshWorkspace,
      isRefreshingWorkspace: state.isRefreshingWorkspace,
    }),
    [
      state.actions,
      state.attentionSessionIds,
      state.fallbackProject,
      state.getPaneRefreshToken,
      state.isLoadingProjects,
      state.isRefreshingWorkspace,
      state.layout,
      state.openSettings,
      state.paneProjects,
      state.projects,
      state.refreshProjectsSilently,
      state.refreshTab,
      state.refreshWorkspace,
      state.renameSession,
      state.setCanShowBothPanes,
      state.setPaneEditorUnsaved,
      state.setSidebarOpen,
    ],
  );

  const sidebarState = useMemo<ProjectSidebarState>(
    () => ({
      sidebarOpen: state.sidebarOpen,
      setSidebarOpen: state.setSidebarOpen,
      sidebarSharedProps: state.sidebarSharedProps,
      paneTargetingBase: state.paneTargetingBase,
      focusedTabKey: state.focusedTabKey,
    }),
    [state.focusedTabKey, state.paneTargetingBase, state.setSidebarOpen, state.sidebarOpen, state.sidebarSharedProps],
  );

  const commandSelectedProject = state.selectedProject ?? state.fallbackProject;
  const commandState = useMemo<ProjectCommandState>(
    () => ({
      selectedProject: commandSelectedProject,
      handleNewSession: state.handleNewSession,
      openSettings: state.openSettings,
      setActiveTab: state.setActiveTab,
      openSessionById: state.openSessionById,
      layout: state.layout,
      actions: state.actions,
      refreshTab: state.refreshTab,
      refreshWorkspace: state.refreshWorkspace,
      isRefreshingWorkspace: state.isRefreshingWorkspace,
    }),
    [
      commandSelectedProject,
      state.actions,
      state.handleNewSession,
      state.isRefreshingWorkspace,
      state.layout,
      state.openSessionById,
      state.openSettings,
      state.refreshTab,
      state.refreshWorkspace,
      state.setActiveTab,
    ],
  );

  const effectsState = useMemo<ProjectEffectsState>(
    () => ({
      openSettings: state.openSettings,
      refreshProjectsSilently: state.refreshProjectsSilently,
      setSidebarOpen: state.setSidebarOpen,
      openSessionById: state.openSessionById,
      focusedProject: state.focusedProject,
      focusedSession: state.focusedSession,
      projects: state.projects,
      layout: state.layout,
    }),
    [
      state.focusedProject,
      state.focusedSession,
      state.layout,
      state.openSessionById,
      state.openSettings,
      state.projects,
      state.refreshProjectsSilently,
      state.setSidebarOpen,
    ],
  );

  return (
    <ProjectEffectsContext.Provider value={effectsState}>
      <ProjectCommandContext.Provider value={commandState}>
        <ProjectPanesContext.Provider value={panesState}>
          <ProjectSidebarContext.Provider value={sidebarState}>
            {children}
          </ProjectSidebarContext.Provider>
        </ProjectPanesContext.Provider>
      </ProjectCommandContext.Provider>
    </ProjectEffectsContext.Provider>
  );
}

function useRequiredProjectContext<T>(value: T | null, hookName: string): T {
  if (!value) {
    throw new Error(`${hookName} must be used within ProjectsStateProvider`);
  }
  return value;
}

/**
 * Read by ProjectMainRegion to draw both panes, change the layout, collect the panes' unsaved-editor
 * reports and hand each pane its refresh token and refresh actions, by ProjectWorkspaceShell for the
 * workspace shortcuts, the phone's immersive menu and refresh buttons and to report whether two panes
 * fit, by ProjectCommandPalette for the titles and project names of its Open tabs, and by
 * ProjectRunNotifications for the session names in run alerts, the sessions the panes on display show
 * and opening a session from a banner.
 */
export function useProjectPanesState(): ProjectPanesState {
  return useRequiredProjectContext(useContext(ProjectPanesContext), 'useProjectPanesState');
}

/** Read by ProjectSidebarRegion to render the sidebar module for the focused pane. */
export function useProjectSidebarState(): ProjectSidebarState {
  return useRequiredProjectContext(useContext(ProjectSidebarContext), 'useProjectSidebarState');
}

/** Read by ProjectCommandPalette and ProjectQuickSettingsRegion, which act on the focused pane. */
export function useProjectCommandState(): ProjectCommandState {
  return useRequiredProjectContext(useContext(ProjectCommandContext), 'useProjectCommandState');
}

/** Read by ProjectEffects for palette registrations, notification clicks and the document title: its page part, and through useRunningSessionTitle its running part. */
export function useProjectEffectsState(): ProjectEffectsState {
  return useRequiredProjectContext(useContext(ProjectEffectsContext), 'useProjectEffectsState');
}
