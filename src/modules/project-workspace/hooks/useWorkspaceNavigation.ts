import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { NavigateFunction } from 'react-router-dom';

import { WORKSPACE_KEY_ENTRY_SEPARATOR, WORKSPACE_KEY_FIELD_SEPARATOR } from '@/shared/constants';
import { readSelectedProvider } from '@/shared/selectedProvider';
import type {
  AppTab,
  Project,
  ProjectSession,
  SessionEstablishedContext,
  SessionOpenOptions,
  SessionPanePlacement,
  WorkspaceLayout,
  WorkspaceLayoutActions,
  WorkspacePaneSide,
  WorkspaceSessionTab,
} from '@/shared/types';
import { getOtherPaneSide, readSessionProvider } from '@/shared/utils';
import type { useWorkspaceLayout } from '@/modules/project-workspace/hooks/useWorkspaceLayout';
import { mergeProjectSelectionMetadata } from '@/modules/project-workspace/utils/projectSelectionMetadata';
import { findLoadedSession, resolveSessionTarget } from '@/modules/project-workspace/utils/resolveSessionTarget';
import {
  collectMountedPaneIds,
  collectSessionPlacements,
  collectVisibleSessionIds,
  findSessionTab,
  getActiveTab,
  getPane,
  isLayoutEmpty,
  workspaceLayoutReducer,
} from '@/modules/project-workspace/utils/workspaceLayout';

type WorkspaceLayoutAction = Parameters<typeof workspaceLayoutReducer>[1];

type UseWorkspaceNavigationArgs = {
  workspace: ReturnType<typeof useWorkspaceLayout>;
  /** Session id in the URL (/session/:id); undefined on /. */
  sessionId?: string;
  navigate: NavigateFunction;
  projects: Project[];
  isLoadingProjects: boolean;
  isMobile: boolean;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  /** Writes the session a first send created into `projects`; returns the object its tab hands to the chat. */
  registerEstablishedSession: (sessionId: string, context: SessionEstablishedContext) => ProjectSession;
  clearSessionAttention: (sessionId: string) => void;
};

/** A session ready to open: the object for the chat and the project that owns it. */
type KnownSession = { session: ProjectSession; projectId: string };

/** What a backend lookup of a session nothing local knows came to. */
type LookupResult = KnownSession | 'missing' | 'unavailable';

/**
 * Who changed the layout. 'user': an action the user took (a click, a key, a send). 'sync': what the page
 * did on its own (following the URL, restoring rows, resolving tabs, websocket updates); it never
 * unlocks the localStorage seed and never re-points a URL that moved off the screen.
 */
type ChangeOrigin = 'user' | 'sync';

type CommitOptions = {
  origin?: ChangeOrigin;
  /**
   * An explicit open or activation of the focused session: the URL follows even when the layout did not
   * change, so a URL left on / (Back, Forward) gets the session back.
   */
  refillUrl?: boolean;
};

/** The workspace state the rest of the app reads: the focused pane's tab, project and session. */
type FocusedPane = {
  side: WorkspacePaneSide;
  tab: WorkspaceSessionTab | null;
  project: Project | null;
  session: ProjectSession | null;
};

const getFocusedSessionId = (layout: WorkspaceLayout): string | null =>
  getActiveTab(getPane(layout, layout.focusedSide))?.sessionId ?? null;

/** The title a tab shows until the live projects row is available; the same fields, in the same order, as the sidebar row. */
const readSessionTitle = (session: ProjectSession): string => {
  for (const candidate of [session.summary, session.name, session.title]) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }
  return '';
};

/** Drops undefined fields so a caller's partial session object never blanks fields a lookup filled in. */
const definedFields = (session: ProjectSession): ProjectSession =>
  Object.fromEntries(Object.entries(session).filter(([, value]) => value !== undefined)) as ProjectSession;

/**
 * One pane's project object, stable while a projects refresh only touched its session rows (the chat
 * reloads whenever its project identity changes), and kept while a refresh momentarily no longer lists it.
 */
function useStablePaneProject(projectId: string | null, row: Project | null): Project | null {
  // The object last handed to the pane; replaced only when the project or its workspace metadata changes.
  const [stableProject, setStableProject] = useState<Project | null>(row);
  let next: Project | null = null;
  if (projectId && row) {
    next = stableProject?.projectId === projectId ? mergeProjectSelectionMetadata(stableProject, row) : row;
  } else if (projectId) {
    next = stableProject?.projectId === projectId ? stableProject : null;
  }
  if (next !== stableProject) {
    // Adjusting state while rendering: React re-renders right away, before anything is committed.
    setStableProject(next);
  }
  return next;
}

/**
 * The split workspace's write path and URL sync. Every layout change goes through `commit`, which
 * runs the reducer on the latest layout, asks before a change unmounts a pane whose editor holds
 * unsaved edits and, when the focused pane's active session changed, moves the URL once. Also
 * implements WorkspaceLayoutActions and derives what the rest of the app reads.
 */
export function useWorkspaceNavigation({
  workspace,
  sessionId,
  navigate,
  projects,
  isLoadingProjects,
  isMobile,
  setSidebarOpen,
  registerEstablishedSession,
  clearSessionAttention,
}: UseWorkspaceNavigationArgs) {
  const { layout, layoutRef, setLayout, createTabKey, createPaneId, takeLegacyView } = workspace;
  // The editor's own "discard unsaved changes" question, asked before a layout change unmounts its pane.
  const { t: tCodeEditor } = useTranslation('codeEditor');

  // Projects a tab needs that the sidebar list does not hold: an archived session's project, or one a
  // deep link resolved. Pane projects fall back to it, keyed by projectId.
  const [unlistedProjects, setUnlistedProjects] = useState<Readonly<Record<string, Project>>>({});
  // The project whose title the user last clicked in the sidebar: new chats default to it when no pane has a project.
  const [lastBrowsedProjectId, setLastBrowsedProjectId] = useState<string | null>(null);
  // Whether the main column fits both panes side by side, reported by ProjectWorkspaceShell, which
  // measures it. A split that does not fit shows the focused pane only, so only its session is on screen.
  const [canShowBothPanes, setCanShowBothPanes] = useState(true);

  // Latest values for the stable callbacks below and for lookups that resolve later. `navigate` in
  // particular changes identity on every URL change, which must not rebuild the actions.
  const navigateRef = useRef(navigate);
  const projectsRef = useRef(projects);
  const isMobileRef = useRef(isMobile);
  useLayoutEffect(() => {
    navigateRef.current = navigate;
    projectsRef.current = projects;
    isMobileRef.current = isMobile;
  });
  // The session the URL shows, updated as soon as commit navigates so a second commit in the same tick compares against it.
  const urlSessionIdRef = useRef<string | null>(sessionId ?? null);
  useLayoutEffect(() => {
    urlSessionIdRef.current = sessionId ?? null;
  }, [sessionId]);
  // The URL commit last navigated to, so the URL sync recognises its own navigation and leaves the layout alone.
  const selfNavigationRef = useRef<{ sessionId: string | null } | null>(null);
  // The URL session last turned into a layout change: each URL is handled once, when it appears.
  const handledUrlSessionIdRef = useRef<string | null>(null);
  // Bumped by every user navigation; a lookup that resolves after a newer one is dropped instead of yanking the pane back.
  const navigationEpochRef = useRef(0);
  // Sessions whose tab data is known complete or already looked up; each id is resolved at most once.
  const resolvedSessionIdsRef = useRef(new Set<string>());
  // Ids of the panes whose editor holds unsaved changes, as each pane's WorkspaceMain reports them.
  const unsavedEditorPaneIdsRef = useRef(new Set<string>());

  const navigateToSession = useCallback((targetSessionId: string | null, history: 'push' | 'replace') => {
    urlSessionIdRef.current = targetSessionId;
    selfNavigationRef.current = { sessionId: targetSessionId };
    const path = targetSessionId ? `/session/${targetSessionId}` : '/';
    if (history === 'replace') {
      navigateRef.current(path, { replace: true });
    } else {
      navigateRef.current(path);
    }
  }, []);

  /**
   * A change that unmounts a pane (a merge, closing a side, its last tab closed or moved away, a phone
   * switching panes) would silently drop that pane's unsaved editor buffer: the editor's own question
   * decides. True when nothing is lost or the user lets it go.
   */
  const confirmUnmountingPanes = useCallback((previous: WorkspaceLayout, next: WorkspaceLayout): boolean => {
    const unsaved = unsavedEditorPaneIdsRef.current;
    if (unsaved.size === 0) {
      return true;
    }
    const isPhone = isMobileRef.current;
    const stillMounted = new Set(collectMountedPaneIds(next, { isMobile: isPhone }));
    const losesEdits = collectMountedPaneIds(previous, { isMobile: isPhone })
      .some((paneId) => !stillMounted.has(paneId) && unsaved.has(paneId));
    return !losesEdits || window.confirm(tCodeEditor('unsavedChanges.confirmClose'));
  }, [tCodeEditor]);

  /** The only writer of the layout. Returns the layout it produced (the previous one when nothing changed or the user kept their edits). */
  const commit = useCallback((
    action: WorkspaceLayoutAction,
    history: 'push' | 'replace' = 'replace',
    { origin = 'user', refillUrl = false }: CommitOptions = {},
  ): WorkspaceLayout => {
    const previous = layoutRef.current;
    const next = workspaceLayoutReducer(previous, action);
    if (next !== previous) {
      if (!confirmUnmountingPanes(previous, next)) {
        return previous;
      }
      setLayout(next, { byUser: origin === 'user' });
    } else if (!refillUrl) {
      return previous;
    }
    const nextSessionId = getFocusedSessionId(next);
    const focusedSessionChanged = getFocusedSessionId(previous) !== nextSessionId;
    if ((focusedSessionChanged || refillUrl) && urlSessionIdRef.current !== nextSessionId) {
      navigateToSession(nextSessionId, history);
    }
    return next;
  }, [confirmUnmountingPanes, layoutRef, navigateToSession, setLayout]);

  const beginNavigation = useCallback((): number => {
    navigationEpochRef.current += 1;
    return navigationEpochRef.current;
  }, []);

  const closeMobileSidebar = useCallback(() => {
    if (isMobileRef.current) {
      setSidebarOpen(false);
    }
  }, [setSidebarOpen]);

  const rememberUnlistedProject = useCallback((project: Project | null | undefined) => {
    if (!project?.projectId || projectsRef.current.some((candidate) => candidate.projectId === project.projectId)) {
      return;
    }
    setUnlistedProjects((previous) => (previous[project.projectId] ? previous : { ...previous, [project.projectId]: project }));
  }, []);

  /** The view a new tab starts on: the requested one, or the pre-split app-wide view for the first tab of an empty layout. */
  const pickView = useCallback((view?: AppTab): AppTab | undefined => (
    view ?? (isLayoutEmpty(layoutRef.current) ? takeLegacyView() : undefined)
  ), [layoutRef, takeLegacyView]);

  const openKnownSession = useCallback((
    { session, projectId }: KnownSession,
    options: SessionOpenOptions,
    origin: ChangeOrigin = 'user',
  ) => {
    // The owning project is known, so the tab already holds what the chat needs: the visible-tab
    // lookup leaves it alone (a failed lookup there used to flag a perfectly good session missing).
    resolvedSessionIdsRef.current.add(session.id);
    commit({
      type: 'open',
      payload: { session, projectId, provider: readSessionProvider(session), title: readSessionTitle(session) },
      target: options.target ?? 'focused',
      preview: Boolean(options.preview),
      view: pickView(options.view),
      focus: !options.inBackground,
      newTabKey: createTabKey(),
      newPaneId: createPaneId(),
    }, options.history ?? 'push', { origin, refillUrl: origin === 'user' && !options.inBackground });
  }, [commit, createPaneId, createTabKey, pickView]);

  /**
   * A tab for a session that could not be resolved: it stays, and the pane says the conversation is gone.
   * `retryable` (the lookup failed rather than finding nothing) lets the visible-tab lookup ask again.
   */
  const openMissingSession = useCallback((
    missingSessionId: string,
    options: SessionOpenOptions,
    { origin, retryable }: { origin: ChangeOrigin; retryable: boolean },
  ) => {
    if (!retryable) {
      resolvedSessionIdsRef.current.add(missingSessionId);
    }
    const provider = readSelectedProvider();
    commit({
      type: 'open',
      payload: { session: { id: missingSessionId, __provider: provider }, projectId: '', provider, title: '' },
      target: options.target ?? 'focused',
      preview: Boolean(options.preview),
      view: pickView(options.view),
      focus: !options.inBackground,
      newTabKey: createTabKey(),
      newPaneId: createPaneId(),
    }, options.history ?? 'push', { origin });
    commit({ type: 'markMissing', sessionId: missingSessionId }, 'replace', { origin: 'sync' });
  }, [commit, createPaneId, createTabKey, pickView]);

  /**
   * Sessions the layout or the loaded pages already know, merged with what the caller passed (a search
   * target, say). A tab flagged missing proves nothing about the session, so it is looked past.
   */
  const findKnownSession = useCallback((requested: ProjectSession): KnownSession | null => {
    const own = definedFields(requested);
    const hit = findSessionTab(layoutRef.current, requested.id);
    if (hit && !hit.tab.isMissing) {
      return {
        session: { ...hit.tab.session, ...own, id: requested.id, __projectId: hit.tab.projectId, __provider: hit.tab.provider },
        projectId: hit.tab.projectId,
      };
    }
    const loaded = findLoadedSession(requested.id, projectsRef.current);
    if (loaded) {
      resolvedSessionIdsRef.current.add(requested.id);
      return {
        session: { ...loaded.session, ...own, __projectId: loaded.project.projectId },
        projectId: loaded.project.projectId,
      };
    }
    return null;
  }, [layoutRef]);

  /** Asks the backend about a session nothing local knows; follows one alias hop. */
  const lookUpSession = useCallback(async (requested: ProjectSession): Promise<LookupResult> => {
    const own = definedFields(requested);
    let resolution = await resolveSessionTarget(requested.id, () => projectsRef.current);
    if (resolution.kind === 'alias') {
      const canonical = { ...own, id: resolution.canonicalId };
      const known = findKnownSession(canonical);
      if (known) {
        return known;
      }
      resolution = await resolveSessionTarget(resolution.canonicalId, () => projectsRef.current);
      if (resolution.kind === 'found') {
        own.id = resolution.session.id;
      }
    }
    if (resolution.kind === 'unavailable') {
      return 'unavailable';
    }
    if (resolution.kind !== 'found') {
      return 'missing';
    }
    if (!resolution.isListed) {
      rememberUnlistedProject(resolution.project);
    }
    resolvedSessionIdsRef.current.add(resolution.session.id);
    return {
      session: { ...resolution.session, ...own, __projectId: resolution.project.projectId },
      projectId: resolution.project.projectId,
    };
  }, [findKnownSession, rememberUnlistedProject]);

  /**
   * Opens a session whose project the caller could not name: locally known ones at once, others after a
   * lookup. A lookup overtaken by a newer navigation is dropped, unless `epoch` is null (a background open).
   */
  const openUnresolvedSession = useCallback((
    requested: ProjectSession,
    options: SessionOpenOptions,
    epoch: number | null,
    origin: ChangeOrigin,
  ) => {
    const known = findKnownSession(requested);
    if (known) {
      openKnownSession(known, options, origin);
      return;
    }
    void lookUpSession(requested).then((resolved) => {
      if (epoch !== null && epoch !== navigationEpochRef.current) {
        return;
      }
      if (typeof resolved === 'object') {
        openKnownSession(resolved, options, origin);
      } else {
        openMissingSession(requested.id, options, { origin, retryable: resolved === 'unavailable' });
      }
    });
  }, [findKnownSession, lookUpSession, openKnownSession, openMissingSession]);

  const openSession = useCallback((session: ProjectSession, options: SessionOpenOptions = {}) => {
    // A background open (a fork finishing) must not cancel what the user started meanwhile, nor close the phone's drawer.
    const epoch = options.inBackground ? null : beginNavigation();
    if (!options.inBackground) {
      closeMobileSidebar();
    }
    rememberUnlistedProject(options.ownerProject);
    const projectId = session.__projectId || options.ownerProject?.projectId;
    if (projectId) {
      // The loaded row fills in what a partial object (a dropped row, a drag payload) leaves out, its
      // title first of all; the caller's own fields win.
      const loaded = findLoadedSession(session.id, projectsRef.current);
      const complete = loaded ? { ...loaded.session, ...definedFields(session) } : session;
      openKnownSession({ session: { ...complete, __projectId: projectId }, projectId }, options);
      return;
    }
    openUnresolvedSession(session, options, epoch, 'user');
  }, [beginNavigation, closeMobileSidebar, openKnownSession, openUnresolvedSession, rememberUnlistedProject]);

  const openSessionById = useCallback((targetSessionId: string, options: SessionOpenOptions = {}) => {
    const epoch = options.inBackground ? null : beginNavigation();
    if (!options.inBackground) {
      closeMobileSidebar();
    }
    openUnresolvedSession({ id: targetSessionId }, options, epoch, 'user');
  }, [beginNavigation, closeMobileSidebar, openUnresolvedSession]);

  const openNewSession = useCallback((project: Project, options: SessionOpenOptions = {}) => {
    beginNavigation();
    closeMobileSidebar();
    rememberUnlistedProject(project);
    commit({
      type: 'openDraft',
      projectId: project.projectId,
      provider: readSelectedProvider(),
      target: options.target ?? 'focused',
      view: pickView(options.view),
      newTabKey: createTabKey(),
      newPaneId: createPaneId(),
    }, options.history ?? 'push');
  }, [beginNavigation, closeMobileSidebar, commit, createPaneId, createTabKey, pickView, rememberUnlistedProject]);

  const establishDraft = useCallback((
    establishedSessionId: string,
    context: SessionEstablishedContext,
    options: { draftTabKey?: string } = {},
  ) => {
    const session = registerEstablishedSession(establishedSessionId, context);
    resolvedSessionIdsRef.current.add(establishedSessionId);
    // The URL is replaced, so Back does not land on an empty new-chat page.
    commit({
      type: 'establishDraft',
      projectId: context.project.projectId,
      draftTabKey: options.draftTabKey,
      payload: {
        session,
        projectId: context.project.projectId,
        provider: context.provider,
        title: context.summary ?? '',
      },
    }, 'replace');
  }, [commit, registerEstablishedSession]);

  const actions = useMemo<WorkspaceLayoutActions>(() => ({
    openSession,
    openSessionById,
    openNewSession,
    establishDraft,
    activateTab: (side, tabKey) => {
      beginNavigation();
      commit({ type: 'activate', side, tabKey }, 'replace', { refillUrl: true });
    },
    closeTab: (side, tabKey) => {
      beginNavigation();
      commit({ type: 'close', side, tabKey });
    },
    closeOtherTabs: (side, tabKey) => {
      beginNavigation();
      commit({ type: 'closeOthers', side, tabKey });
    },
    closeTabsToRight: (side, tabKey) => {
      beginNavigation();
      commit({ type: 'closeToRight', side, tabKey });
    },
    closeAllTabs: (side) => {
      beginNavigation();
      commit({ type: 'closeAll', side });
    },
    pinTab: (side, tabKey) => {
      commit({ type: 'pin', side, tabKey });
    },
    moveTab: (from, tabKey, to, options = {}) => {
      beginNavigation();
      commit({
        type: 'move',
        from,
        tabKey,
        to,
        index: options.index,
        copy: options.copy,
        newTabKey: createTabKey(),
        newPaneId: createPaneId(),
      });
    },
    setTabView: (side, tabKey, view, options = {}) => {
      commit({ type: 'setView', side, tabKey, view, pin: Boolean(options.pin) });
    },
    focusPane: (side) => {
      beginNavigation();
      commit({ type: 'focus', side });
    },
    split: () => {
      beginNavigation();
      commit({ type: 'split', newPaneId: createPaneId() });
    },
    toggleSplit: () => {
      beginNavigation();
      commit(layoutRef.current.right ? { type: 'merge' } : { type: 'split', newPaneId: createPaneId() });
    },
    closePane: (side) => {
      beginNavigation();
      commit({ type: 'closePane', side });
    },
    setSplitRatio: (ratio) => {
      commit({ type: 'setRatio', ratio });
    },
  }), [
    beginNavigation,
    commit,
    createPaneId,
    createTabKey,
    establishDraft,
    layoutRef,
    openNewSession,
    openSession,
    openSessionById,
  ]);

  /** Reported by each pane's WorkspaceMain whenever its editor's buffer turns dirty or clean (and clean on unmount). */
  const setPaneEditorUnsaved = useCallback((paneId: string, hasUnsavedChanges: boolean) => {
    if (hasUnsavedChanges) {
      unsavedEditorPaneIdsRef.current.add(paneId);
    } else {
      unsavedEditorPaneIdsRef.current.delete(paneId);
    }
  }, []);

  // ---------------------------------------------------------------- derived values

  const findProjectRow = (projectId: string | null): Project | null => (
    projectId ? projects.find((project) => project.projectId === projectId) ?? unlistedProjects[projectId] ?? null : null
  );
  const leftProjectId = getActiveTab(layout.left)?.projectId || null;
  const rightProjectId = getActiveTab(layout.right)?.projectId || null;
  const leftProject = useStablePaneProject(leftProjectId, findProjectRow(leftProjectId));
  const rightProject = useStablePaneProject(rightProjectId, findProjectRow(rightProjectId));
  const paneProjects = useMemo<Readonly<Record<WorkspacePaneSide, Project | null>>>(
    () => ({ left: leftProject, right: rightProject }),
    [leftProject, rightProject],
  );

  const focusedTab = getActiveTab(getPane(layout, layout.focusedSide));
  const focusedProject = paneProjects[layout.focusedSide];
  const focused = useMemo<FocusedPane>(() => ({
    side: layout.focusedSide,
    tab: focusedTab,
    project: focusedProject,
    session: focusedTab?.session ?? null,
  }), [focusedProject, focusedTab, layout.focusedSide]);

  // Rebuilt only when tab membership changes, so sidebar rows keep their props across tab switches.
  const placementKey = useMemo(() => [...collectSessionPlacements(layout)]
    .map(([placedSessionId, placement]) => `${placedSessionId}${WORKSPACE_KEY_FIELD_SEPARATOR}${placement}`)
    .sort()
    .join(WORKSPACE_KEY_ENTRY_SEPARATOR), [layout]);
  const sessionPlacements = useMemo<ReadonlyMap<string, SessionPanePlacement>>(() => new Map(
    placementKey
      ? placementKey.split(WORKSPACE_KEY_ENTRY_SEPARATOR).map((entry) => {
        const [placedSessionId, placement] = entry.split(WORKSPACE_KEY_FIELD_SEPARATOR);
        return [placedSessionId, placement as SessionPanePlacement];
      })
      : [],
  ), [placementKey]);

  // Phones and a split too narrow for two panes show only the focused pane, so only its session counts as seen there.
  const showsFocusedPaneOnly = isMobile || !canShowBothPanes;
  const visibleKey = useMemo(
    () => [...collectVisibleSessionIds(layout, { focusedOnly: showsFocusedPaneOnly })].sort().join(WORKSPACE_KEY_ENTRY_SEPARATOR),
    [layout, showsFocusedPaneOnly],
  );
  const visibleSessionIds = useMemo<ReadonlySet<string>>(
    () => new Set(visibleKey ? visibleKey.split(WORKSPACE_KEY_ENTRY_SEPARATOR) : []),
    [visibleKey],
  );

  const otherPaneProject = paneProjects[getOtherPaneSide(layout.focusedSide)];
  // The last browsed project, else the first one: a stable object like the pane projects, so what reads
  // the fallback (the quick settings' commands, say) does not reload on every session update.
  const browsedProjectId = lastBrowsedProjectId && findProjectRow(lastBrowsedProjectId) ? lastBrowsedProjectId : null;
  const browsedOrFirstProjectId = browsedProjectId ?? projects[0]?.projectId ?? null;
  const browsedOrFirstProject = useStablePaneProject(browsedOrFirstProjectId, findProjectRow(browsedOrFirstProjectId));
  const fallbackProject = focusedProject ?? otherPaneProject ?? browsedOrFirstProject;

  const recordBrowsedProject = useCallback((project: Project) => {
    rememberUnlistedProject(project);
    setLastBrowsedProjectId(project.projectId);
  }, [rememberUnlistedProject]);

  // ---------------------------------------------------------------- effects

  // A page opened on / with a session on screen gets that session into the URL, once.
  const hasCheckedMountUrlRef = useRef(false);
  useEffect(() => {
    if (hasCheckedMountUrlRef.current) {
      return;
    }
    hasCheckedMountUrlRef.current = true;
    const focusedSessionId = getFocusedSessionId(layoutRef.current);
    if (!sessionId && focusedSessionId) {
      navigateToSession(focusedSessionId, 'replace');
    }
  }, [layoutRef, navigateToSession, sessionId]);

  // URL -> layout, only when the URL itself changes: Back/Forward, a pasted link, a reload.
  useEffect(() => {
    const urlSessionId = sessionId ?? null;
    if (selfNavigationRef.current && selfNavigationRef.current.sessionId === urlSessionId) {
      selfNavigationRef.current = null;
      handledUrlSessionIdRef.current = urlSessionId;
      return;
    }
    if (!urlSessionId) {
      // Back on /: the panes stay as they are, a lookup the previous URL started is dropped, and
      // the next /session URL is handled afresh.
      if (handledUrlSessionIdRef.current !== null) {
        handledUrlSessionIdRef.current = null;
        beginNavigation();
      }
      return;
    }
    if (handledUrlSessionIdRef.current === urlSessionId) {
      return;
    }
    const hit = findSessionTab(layoutRef.current, urlSessionId);
    // Anything not already open is resolved against the first page of projects, not an empty list.
    if (!hit && isLoadingProjects) {
      return;
    }
    handledUrlSessionIdRef.current = urlSessionId;
    const epoch = beginNavigation();
    if (hit) {
      commit({ type: 'activate', side: hit.side, tabKey: hit.tab.key }, 'replace', { origin: 'sync' });
      return;
    }
    openUnresolvedSession({ id: urlSessionId }, { target: 'focused', preview: true, history: 'replace' }, epoch, 'sync');
  }, [beginNavigation, commit, isLoadingProjects, layoutRef, openUnresolvedSession, sessionId]);

  // After the first load: drafts of projects that are gone go, and restored tabs get their full rows.
  const hasHydratedRestoredTabsRef = useRef(false);
  useEffect(() => {
    if (isLoadingProjects || projects.length === 0 || hasHydratedRestoredTabsRef.current) {
      return;
    }
    hasHydratedRestoredTabsRef.current = true;
    commit({
      type: 'pruneDrafts',
      liveProjectIds: new Set([...projects.map((project) => project.projectId), ...Object.keys(unlistedProjects)]),
    }, 'replace', { origin: 'sync' });
    const current = layoutRef.current;
    const restoredSessionIds = new Set(
      [...current.left.tabs, ...(current.right?.tabs ?? [])]
        .map((tab) => tab.sessionId)
        .filter((tabSessionId): tabSessionId is string => Boolean(tabSessionId)),
    );
    for (const restoredSessionId of restoredSessionIds) {
      const loaded = findLoadedSession(restoredSessionId, projects);
      if (loaded) {
        resolvedSessionIdsRef.current.add(restoredSessionId);
        commit(
          { type: 'patchSession', sessionId: restoredSessionId, patch: loaded.session, dropSearchTarget: true },
          'replace',
          { origin: 'sync' },
        );
      }
    }
  }, [commit, isLoadingProjects, layoutRef, projects, unlistedProjects]);

  // Keeps today's first-run experience: with a single project and nothing to show, start a new chat in it.
  // Armed on the first load and again whenever the list is empty, so creating the first project starts one too.
  const isAutoDraftArmedRef = useRef(true);
  useEffect(() => {
    if (isLoadingProjects) {
      return;
    }
    if (projects.length === 0) {
      isAutoDraftArmedRef.current = true;
      return;
    }
    if (!isAutoDraftArmedRef.current) {
      return;
    }
    isAutoDraftArmedRef.current = false;
    if (projects.length !== 1 || sessionId || !isLayoutEmpty(layoutRef.current)) {
      return;
    }
    commit({
      type: 'openDraft',
      projectId: projects[0].projectId,
      provider: readSelectedProvider(),
      target: 'focused',
      view: pickView(),
      newTabKey: createTabKey(),
      newPaneId: createPaneId(),
    }, 'replace', { origin: 'sync' });
  }, [commit, createPaneId, createTabKey, isLoadingProjects, layoutRef, pickView, projects, sessionId]);

  // A visible tab whose session is not in the loaded pages (a restored or archived one) is looked up
  // once; background tabs wait until they are shown. Only a definite "no such session" flags the tab
  // missing; a lookup that could not reach the server leaves it as it is, to be asked again later.
  useEffect(() => {
    if (isLoadingProjects) {
      return;
    }
    for (const visibleSessionId of visibleSessionIds) {
      if (resolvedSessionIdsRef.current.has(visibleSessionId)) {
        continue;
      }
      resolvedSessionIdsRef.current.add(visibleSessionId);
      if (findLoadedSession(visibleSessionId, projectsRef.current)) {
        continue;
      }
      void resolveSessionTarget(visibleSessionId, () => projectsRef.current).then((resolution) => {
        if (resolution.kind === 'found') {
          if (!resolution.isListed) {
            rememberUnlistedProject(resolution.project);
          }
          commit(
            { type: 'patchSession', sessionId: visibleSessionId, patch: resolution.session, dropSearchTarget: true },
            'replace',
            { origin: 'sync' },
          );
        } else if (resolution.kind === 'alias') {
          commit({ type: 'replaceSessionId', fromId: visibleSessionId, toId: resolution.canonicalId }, 'replace', { origin: 'sync' });
        } else if (resolution.kind === 'missing') {
          commit({ type: 'markMissing', sessionId: visibleSessionId }, 'replace', { origin: 'sync' });
        } else {
          resolvedSessionIdsRef.current.delete(visibleSessionId);
        }
      });
    }
  }, [commit, isLoadingProjects, rememberUnlistedProject, visibleSessionIds]);

  // A tab flagged missing whose session turns up in the loaded pages (a lookup that failed while the
  // server was away, a page loaded later) shows its conversation again, without asking the server.
  useEffect(() => {
    if (isLoadingProjects) {
      return;
    }
    const current = layoutRef.current;
    for (const tab of [...current.left.tabs, ...(current.right?.tabs ?? [])]) {
      if (!tab.isMissing || !tab.sessionId) {
        continue;
      }
      const loaded = findLoadedSession(tab.sessionId, projects);
      if (loaded) {
        commit(
          { type: 'patchSession', sessionId: tab.sessionId, patch: loaded.session, dropSearchTarget: true },
          'replace',
          { origin: 'sync' },
        );
      }
    }
  }, [commit, isLoadingProjects, layoutRef, projects]);

  // A session on screen is being looked at, so it no longer needs attention.
  useEffect(() => {
    for (const visibleSessionId of visibleSessionIds) {
      clearSessionAttention(visibleSessionId);
    }
  }, [clearSessionAttention, visibleSessionIds]);

  return {
    layout,
    commit,
    actions,
    focused,
    paneProjects,
    sessionPlacements,
    visibleSessionIds,
    fallbackProject,
    recordBrowsedProject,
    setCanShowBothPanes,
    setPaneEditorUnsaved,
  };
}
