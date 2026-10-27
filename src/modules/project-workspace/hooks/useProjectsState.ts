import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import { api } from '@/shared/api';
import type {
  AppTab,
  IsSessionProcessing,
  LLMProvider,
  LoadingProgress,
  Project,
  ProjectSession,
  ServerEvent,
  SessionEstablishedContext,
  SidebarPaneTargeting,
} from '@/shared/types';
import { useWorkspaceLayout } from '@/modules/project-workspace/hooks/useWorkspaceLayout';
import { useWorkspaceNavigation } from '@/modules/project-workspace/hooks/useWorkspaceNavigation';
import { findLoadedSession } from '@/modules/project-workspace/utils/resolveSessionTarget';
import { getActiveTab, getPane, layoutHasSession } from '@/modules/project-workspace/utils/workspaceLayout';

type UseProjectsStateArgs = {
  sessionId?: string;
  navigate: NavigateFunction;
  /** Subscription to the unified websocket event stream. */
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  isMobile: boolean;
  isSessionProcessing: IsSessionProcessing;
};

/**
 * Shape of the per-session sidebar delta (`kind: session_upserted`). It carries
 * everything needed to upsert one session row in place — no full project-list
 * snapshot is ever pushed.
 *
 * Produced on the wire by exactly one builder,
 * `server/modules/websocket/services/session-upsert-broadcast.service.ts`,
 * which both the on-disk sessions watcher and the chat run registry go through.
 */
type SessionUpsertedEvent = ServerEvent & {
  sessionId: string;
  providerSessionId?: string | null;
  provider: LLMProvider;
  session: ProjectSession;
  project: {
    projectId: string;
    path: string;
    fullPath: string;
    displayName: string;
    isStarred: boolean;
  } | null;
};

type FetchProjectsOptions = {
  showLoadingState?: boolean;
};

type RegisterOptimisticSessionArgs = {
  sessionId: string;
  provider: LLMProvider;
  project: Project;
  summary?: string | null;
};

type ProjectSessionPage = Pick<Project, 'sessions' | 'sessionMeta'>;

const serialize = (value: unknown) => JSON.stringify(value ?? null);

const projectsHaveChanges = (
  prevProjects: Project[],
  nextProjects: Project[],
): boolean => {
  if (prevProjects.length !== nextProjects.length) {
    return true;
  }

  return nextProjects.some((nextProject, index) => {
    const prevProject = prevProjects[index];
    if (!prevProject) {
      return true;
    }

    return (
      nextProject.projectId !== prevProject.projectId ||
      nextProject.displayName !== prevProject.displayName ||
      nextProject.fullPath !== prevProject.fullPath ||
      Boolean(nextProject.isStarred) !== Boolean(prevProject.isStarred) ||
      serialize(nextProject.sessionMeta) !== serialize(prevProject.sessionMeta) ||
      serialize(nextProject.sessions) !== serialize(prevProject.sessions) ||
      serialize(nextProject.taskmaster) !== serialize(prevProject.taskmaster)
    );
  });
};

const mergeTaskMasterCache = (nextProjects: Project[], previousProjects: Project[]): Project[] => {
  if (previousProjects.length === 0) {
    return nextProjects;
  }

  // Keyed by `projectId` (the DB primary key) so caches stay correct across
  // renames and other mutations that might have changed the display name.
  const previousTaskMasterByProject = new Map(
    previousProjects
      .filter((project) => Boolean(project.taskmaster))
      .map((project) => [project.projectId, project.taskmaster]),
  );

  return nextProjects.map((project) => {
    const cachedTaskMasterInfo = previousTaskMasterByProject.get(project.projectId);
    if (!cachedTaskMasterInfo) {
      return project;
    }

    return {
      ...project,
      taskmaster: cachedTaskMasterInfo,
    };
  });
};

const getProjectSessions = (project: Project): ProjectSession[] => {
  return project.sessions ?? [];
};

const countLoadedProjectSessions = (project: Project): number => getProjectSessions(project).length;

const mergeSessionProviderLists = (baseSessions: ProjectSession[], additionalSessions: ProjectSession[]): ProjectSession[] => {
  const merged = [...baseSessions];
  const seenSessionIds = new Set(baseSessions.map((session) => String(session.id)));

  for (const session of additionalSessions) {
    const sessionId = String(session.id);
    if (seenSessionIds.has(sessionId)) {
      continue;
    }

    merged.push(session);
    seenSessionIds.add(sessionId);
  }

  return merged;
};

const mergeExpandedSessionPages = (previousProjects: Project[], incomingProjects: Project[]): Project[] => {
  if (previousProjects.length === 0) {
    return incomingProjects;
  }

  const previousByProjectId = new Map(previousProjects.map((project) => [project.projectId, project]));

  return incomingProjects.map((incomingProject) => {
    const previousProject = previousByProjectId.get(incomingProject.projectId);
    if (!previousProject) {
      return incomingProject;
    }

    const previousLoadedCount = countLoadedProjectSessions(previousProject);
    const incomingLoadedCount = countLoadedProjectSessions(incomingProject);
    if (previousLoadedCount <= incomingLoadedCount) {
      return incomingProject;
    }

    const mergedProject: Project = {
      ...incomingProject,
      sessions: mergeSessionProviderLists(incomingProject.sessions ?? [], previousProject.sessions ?? []),
    };

    const totalSessions = Number(incomingProject.sessionMeta?.total ?? previousLoadedCount);
    mergedProject.sessionMeta = {
      ...incomingProject.sessionMeta,
      total: totalSessions,
      hasMore: countLoadedProjectSessions(mergedProject) < totalSessions,
    };

    return mergedProject;
  });
};

const mergeProjectSessionPage = (
  existingProject: Project,
  sessionsPage: ProjectSessionPage,
): Project => {
  const mergedProject: Project = {
    ...existingProject,
    sessions: mergeSessionProviderLists(existingProject.sessions ?? [], sessionsPage.sessions ?? []),
  };

  const totalSessions = Number(sessionsPage.sessionMeta?.total ?? existingProject.sessionMeta?.total ?? 0);
  mergedProject.sessionMeta = {
    ...existingProject.sessionMeta,
    ...sessionsPage.sessionMeta,
    total: totalSessions,
    hasMore: countLoadedProjectSessions(mergedProject) < totalSessions,
  };

  return mergedProject;
};

const getSessionAliasIds = (event: SessionUpsertedEvent): Set<string> => {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') {
      return;
    }

    const trimmed = value.trim();
    if (trimmed) {
      ids.add(trimmed);
    }
  };

  add(event.sessionId);
  add(event.providerSessionId);
  add(event.session?.id);

  return ids;
};

/**
 * Upserts one session into a project's normalized session list.
 *
 * Existing rows are updated in place (summary/lastActivity changes from the
 * watcher); new rows are prepended since the watcher only fires for sessions
 * with fresh activity. `sessionMeta.total` grows only on insert.
 */
const upsertSessionIntoProject = (project: Project, event: SessionUpsertedEvent): Project => {
  const sessions = project.sessions ?? [];
  const aliasIds = getSessionAliasIds(event);
  const normalizedSession: ProjectSession = {
    ...event.session,
    id: event.sessionId,
    __provider: event.provider,
  };
  const existingIndex = sessions.findIndex((session) => aliasIds.has(String(session.id)));

  let nextSessions: ProjectSession[];
  let inserted = false;
  if (existingIndex >= 0) {
    let changed = false;
    nextSessions = [];

    for (const [index, session] of sessions.entries()) {
      if (index === existingIndex) {
        const updated = { ...session, ...normalizedSession };
        // Never let a later upsert that carries an empty summary blank out a
        // title we already have. Fresh sessions momentarily broadcast an empty
        // custom_name before the disk indexer fills it in, which would
        // otherwise flash the row back to the "New session" placeholder.
        if (!normalizedSession.summary?.trim() && session.summary?.trim()) {
          updated.summary = session.summary;
        }
        if (serialize(session) !== serialize(updated)) {
          changed = true;
        }
        nextSessions.push(updated);
        continue;
      }

      if (aliasIds.has(String(session.id))) {
        changed = true;
        continue;
      }

      nextSessions.push(session);
    }

    if (!changed) {
      return project;
    }
  } else {
    nextSessions = [normalizedSession, ...sessions];
    inserted = true;
  }

  const next: Project = { ...project, sessions: nextSessions };
  if (inserted) {
    const total = Number(project.sessionMeta?.total ?? 0) + 1;
    next.sessionMeta = {
      ...project.sessionMeta,
      total,
      hasMore: countLoadedProjectSessions(next) < total,
    };
  }

  return next;
};

const projectFromRegistration = (project: Project): Project => ({
  projectId: project.projectId,
  path: project.path || project.fullPath,
  fullPath: project.fullPath || project.path || '',
  displayName: project.displayName,
  isStarred: project.isStarred,
  sessions: project.sessions ?? [],
  sessionMeta: project.sessionMeta ?? { hasMore: false, total: countLoadedProjectSessions(project) },
  taskmaster: project.taskmaster,
});

const removeSessionFromProject = (project: Project, sessionIdToDelete: string): Project => {
  const sessions = project.sessions ?? [];
  const nextSessions = sessions.filter((session) => session.id !== sessionIdToDelete);
  if (nextSessions.length === sessions.length) {
    return project;
  }

  const updatedProject: Project = {
    ...project,
    sessions: nextSessions,
  };

  const totalSessions = Math.max(0, Number(project.sessionMeta?.total ?? 0) - 1);
  updatedProject.sessionMeta = {
    ...project.sessionMeta,
    total: totalSessions,
    hasMore: countLoadedProjectSessions(updatedProject) < totalSessions,
  };

  return updatedProject;
};

// Writes a confirmed rename onto the matching sidebar row. Returns the same
// project when it holds no such row, or the row already carries that title, so
// the sidebar list does not re-render for projects the rename did not touch.
const renameSessionInProject = (project: Project, sessionIdToRename: string, summary: string): Project => {
  const sessions = project.sessions ?? [];
  const existingIndex = sessions.findIndex((session) => session.id === sessionIdToRename);
  if (existingIndex < 0 || sessions[existingIndex].summary === summary) {
    return project;
  }

  const nextSessions = [...sessions];
  nextSessions[existingIndex] = { ...sessions[existingIndex], summary };
  return { ...project, sessions: nextSessions };
};

/**
 * The workspace's state: the projects data and its websocket sync here, the split layout in
 * useWorkspaceLayout (state and persistence) and useWorkspaceNavigation (URL sync, actions and
 * the values derived from the focused pane). Rendered once by ProjectsStateProvider.
 */
export function useProjectsState({
  sessionId,
  navigate,
  subscribe,
  isMobile,
  isSessionProcessing,
}: UseProjectsStateArgs) {
  const workspace = useWorkspaceLayout({ initialSessionId: sessionId });
  const { layoutRef } = workspace;

  const [projects, setProjects] = useState<Project[]>([]);
  const [attentionSessionIds, setAttentionSessionIds] = useState<Set<string>>(new Set());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState('agents');

  const loadingProgressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Guards the one-time mount fetch below. `fetchProjects` is stable, so the
   * effect only ever re-runs because StrictMode remounts the tree in
   * development — and each extra run costs a full `/api/projects`, which
   * re-scans every provider transcript on the server and re-broadcasts the
   * sidebar's loading progress. Two overlapping scans finish far enough apart
   * that the progress bar replayed from zero, showing the loading screen twice
   * on every refresh.
   */
  const mountFetchStartedRef = useRef(false);
  /**
   * Generation of the newest `/api/projects` request. Several independent
   * triggers call refreshProjectsSilently (a rename, a service-worker
   * notification, the worktrees view), and the server re-synchronizes sessions
   * before responding, so an older response can land last. Applying it would
   * revert the project list and, with it, the pane projects derived from it —
   * the workspace header and document title.
   */
  const projectsRequestIdRef = useRef(0);

  const clearSessionAttention = useCallback((targetSessionId?: string | null) => {
    if (!targetSessionId) {
      return;
    }

    setAttentionSessionIds((previous) => {
      if (!previous.has(targetSessionId)) {
        return previous;
      }

      const next = new Set(previous);
      next.delete(targetSessionId);
      return next;
    });
  }, []);

  const fetchProjects = useCallback(async ({ showLoadingState = true }: FetchProjectsOptions = {}) => {
    // Claimed before the request starts and read again in `finally`, so the
    // loading flag is only ever cleared by the response that actually wrote
    // `projects`.
    const requestId = (projectsRequestIdRef.current += 1);

    try {
      if (showLoadingState) {
        setIsLoadingProjects(true);
      }
      const response = await api.projects();
      const projectData = (await response.json()) as Project[];

      if (projectsRequestIdRef.current !== requestId) {
        return;
      }

      // Pane projects are derived from these rows (merged with
      // mergeProjectSelectionMetadata), so a project rename reaches the
      // workspace header and the document title from here alone.
      setProjects((prevProjects) => {
        const projectsWithTaskMaster = mergeTaskMasterCache(projectData, prevProjects);
        const mergedProjects = mergeExpandedSessionPages(prevProjects, projectsWithTaskMaster);

        if (prevProjects.length === 0) {
          return mergedProjects;
        }

        return projectsHaveChanges(prevProjects, mergedProjects)
          ? mergedProjects
          : prevProjects;
      });
    } catch (error) {
      console.error('Error fetching projects:', error);
    } finally {
      // Only the newest request clears the flag, and it clears it whether or not
      // it asked for the spinner, because by now it has written the list.
      //
      // A superseded response must leave the spinner up: it returned above
      // without touching `projects`, so clearing here would render the sidebar's
      // "No projects found" empty state over the still-empty initial list until
      // the newest response lands. Anything that refreshes during the first load
      // — the websocket's reconnect re-sync, a command-palette refresh, React's
      // StrictMode double-mount — supersedes the initial fetch and used to
      // trigger exactly that flash.
      if (projectsRequestIdRef.current === requestId) {
        setIsLoadingProjects(false);
      }
    }
  }, []);

  const refreshProjectsSilently = useCallback(async () => {
    // Keep chat view stable while still syncing sidebar/session metadata in background.
    await fetchProjects({ showLoadingState: false });
  }, [fetchProjects]);

  /**
   * Puts a session a first send just created into `projects` and returns the
   * object its tab hands to the chat. Only `projects` is written: the draft tab
   * that sent it is converted by the layout (useWorkspaceNavigation.establishDraft).
   */
  const registerOptimisticSession = useCallback(({
    sessionId: newSessionId,
    provider,
    project,
    summary,
  }: RegisterOptimisticSessionArgs): ProjectSession => {
    const now = new Date().toISOString();
    const optimisticSession: ProjectSession = {
      id: newSessionId,
      summary: summary ?? '',
      messageCount: 0,
      createdAt: now,
      created_at: now,
      updated_at: now,
      lastActivity: now,
      __provider: provider,
      __projectId: project?.projectId,
    };
    if (!newSessionId || !project?.projectId) {
      return optimisticSession;
    }

    // A purely local record that reuses the wire shape to feed
    // `upsertSessionIntoProject`; it is never dispatched onto the socket. It
    // deliberately carries no `providerSessionId` — the row was created moments
    // ago by `POST /api/providers/sessions` and the provider has not reported
    // an id yet, so there is nothing truthful to put there.
    const upsert: SessionUpsertedEvent = {
      kind: 'session_upserted',
      sessionId: newSessionId,
      provider,
      session: optimisticSession,
      project: {
        projectId: project.projectId,
        path: project.path || project.fullPath,
        fullPath: project.fullPath || project.path || '',
        displayName: project.displayName,
        isStarred: Boolean(project.isStarred),
      },
      timestamp: now,
    };

    setProjects((previousProjects) => {
      const existingProject = previousProjects.find((candidate) => candidate.projectId === project.projectId);
      if (!existingProject) {
        return [upsertSessionIntoProject(projectFromRegistration(project), upsert), ...previousProjects];
      }

      const updatedProject = upsertSessionIntoProject(existingProject, upsert);
      if (updatedProject === existingProject) {
        return previousProjects;
      }

      return previousProjects.map((candidate) =>
        candidate.projectId === existingProject.projectId ? updatedProject : candidate,
      );
    });

    return optimisticSession;
  }, []);

  const registerEstablishedSession = useCallback(
    (newSessionId: string, context: SessionEstablishedContext) => registerOptimisticSession({
      sessionId: newSessionId,
      provider: context.provider,
      project: context.project,
      summary: context.summary,
    }),
    [registerOptimisticSession],
  );

  // Hydrates TaskMaster details for the given `projectId`. The project
  // identifier comes directly from the DB-driven /api/projects response.
  const hydrateProjectTaskMaster = useCallback(async (projectId: string) => {
    if (!projectId) {
      return;
    }

    try {
      const response = await api.projectTaskmaster(projectId);
      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as { taskmaster?: Project['taskmaster'] };
      const taskMasterInfo = data.taskmaster;
      if (!taskMasterInfo) {
        return;
      }

      // Pane projects pick the details up from the row through mergeProjectSelectionMetadata.
      setProjects((previousProjects) =>
        previousProjects.map((project) =>
          project.projectId === projectId
            ? { ...project, taskmaster: taskMasterInfo }
            : project,
        ),
      );
    } catch (error) {
      console.error(`Error fetching TaskMaster info for project ${projectId}:`, error);
    }
  }, []);

  const openSettings = useCallback((tab = 'tools') => {
    setSettingsInitialTab(tab);
    setShowSettings(true);
  }, []);

  const {
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
  } = useWorkspaceNavigation({
    workspace,
    sessionId,
    navigate,
    projects,
    isLoadingProjects,
    isMobile,
    setSidebarOpen,
    registerEstablishedSession,
    clearSessionAttention,
  });

  /**
   * Latest values the websocket handler reads. The subscription is registered
   * once (per `subscribe` identity) and events are dispatched outside React's
   * render cycle, so the handler reads through refs instead of stale closures;
   * re-subscribing on every change (a focus switch rewrites the URL) would
   * risk missing events.
   */
  const visibleSessionIdsRef = useRef(visibleSessionIds);
  const isSessionProcessingRef = useRef(isSessionProcessing);
  useLayoutEffect(() => {
    visibleSessionIdsRef.current = visibleSessionIds;
    isSessionProcessingRef.current = isSessionProcessing;
  });

  // A session on screen in either pane is being looked at, so it never needs the amber dot.
  const markSessionAttention = useCallback((targetSessionId?: string | null) => {
    if (!targetSessionId || visibleSessionIdsRef.current.has(targetSessionId)) {
      return;
    }

    setAttentionSessionIds((previous) => {
      if (previous.has(targetSessionId)) {
        return previous;
      }

      const next = new Set(previous);
      next.add(targetSessionId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (mountFetchStartedRef.current) {
      return;
    }

    mountFetchStartedRef.current = true;
    void fetchProjects();
  }, [fetchProjects]);

  // Each project that comes on screen in either pane gets its TaskMaster details once more.
  const leftProjectId = paneProjects.left?.projectId ?? null;
  const rightProjectId = paneProjects.right?.projectId ?? null;
  const taskMasterProjectIdsRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const visibleProjectIds = new Set([leftProjectId, rightProjectId].filter((projectId): projectId is string => Boolean(projectId)));
    for (const projectId of visibleProjectIds) {
      if (!taskMasterProjectIdsRef.current.has(projectId)) {
        void hydrateProjectTaskMaster(projectId);
      }
    }
    taskMasterProjectIdsRef.current = visibleProjectIds;
  }, [hydrateProjectTaskMaster, leftProjectId, rightProjectId]);

  // Realtime sidebar updates. The backend pushes per-session deltas
  // (`session_upserted`) instead of full project snapshots, so each event is
  // a keyed upsert that can never clobber unrelated client state — no
  // "suppress updates while a run is active" protection is needed anymore.
  useEffect(() => {
    const handleEvent = (event: ServerEvent) => {
      // The project list is maintained purely by incremental `session_upserted`
      // deltas, so anything that happened while the socket was down is missing
      // from it until something else forces a refresh. Chat re-syncs itself on
      // this event; the sidebar has to as well.
      if (event.kind === 'websocket_reconnected') {
        void refreshProjectsSilently();
        return;
      }

      if (event.kind === 'loading_progress') {
        if (loadingProgressTimeoutRef.current) {
          clearTimeout(loadingProgressTimeoutRef.current);
          loadingProgressTimeoutRef.current = null;
        }

        setLoadingProgress(event as unknown as LoadingProgress);

        if (event.phase === 'complete') {
          loadingProgressTimeoutRef.current = setTimeout(() => {
            setLoadingProgress(null);
            loadingProgressTimeoutRef.current = null;
          }, 500);
        }

        return;
      }

      const eventSessionId = typeof event.sessionId === 'string' && event.sessionId
        ? event.sessionId
        : null;

      if (
        eventSessionId
        && event.kind !== 'chat_subscribed'
        && event.kind !== 'session_upserted'
        && event.kind !== 'status'
        && event.kind !== 'stream_end'
        && event.kind !== 'permission_resolved'
        && event.kind !== 'permission_cancelled'
      ) {
        markSessionAttention(eventSessionId);
      }

      if (event.kind !== 'session_upserted') {
        return;
      }

      const upsert = event as SessionUpsertedEvent;
      if (!upsert.sessionId || !upsert.session) {
        return;
      }

      // The transcript of a session on screen changed on disk while no run is
      // active here (e.g. edited from another client or the CLI): the panes
      // showing it reload their messages.
      if (visibleSessionIdsRef.current.has(upsert.sessionId) && !isSessionProcessingRef.current(upsert.sessionId)) {
        commit({ type: 'noteExternalUpdate', sessionId: upsert.sessionId }, 'replace', { origin: 'sync' });
      } else {
        markSessionAttention(upsert.sessionId);
      }

      setProjects((previousProjects) => {
        const targetProjectId = upsert.project?.projectId;
        const existingProject = previousProjects.find((project) =>
          targetProjectId ? project.projectId === targetProjectId : getProjectSessions(project).some((session) => session.id === upsert.sessionId),
        );

        if (!existingProject) {
          // First session of a project this client has never seen: create the
          // project entry from the event payload.
          if (!upsert.project) {
            return previousProjects;
          }

          const newProject: Project = {
            projectId: upsert.project.projectId,
            path: upsert.project.path,
            fullPath: upsert.project.fullPath,
            displayName: upsert.project.displayName,
            isStarred: upsert.project.isStarred,
            sessions: [],
            sessionMeta: { hasMore: false, total: 0 },
          } as Project;

          return [...previousProjects, upsertSessionIntoProject(newProject, upsert)];
        }

        const updatedProject = upsertSessionIntoProject(existingProject, upsert);
        if (updatedProject === existingProject) {
          return previousProjects;
        }

        return previousProjects.map((project) =>
          project.projectId === existingProject.projectId ? updatedProject : project,
        );
      });

      const aliasSessionId =
        typeof upsert.providerSessionId === 'string' && upsert.providerSessionId !== upsert.sessionId
          ? upsert.providerSessionId
          : null;
      if (!aliasSessionId || !layoutHasSession(layoutRef.current, aliasSessionId)) {
        return;
      }

      // Tabs still on the provider-native id move to the canonical one, and so
      // does the URL when the focused tab was one of them — by replace, because
      // the alias was never a page of its own.
      commit({ type: 'replaceSessionId', fromId: aliasSessionId, toId: upsert.sessionId }, 'replace', { origin: 'sync' });
      const canonicalSession: ProjectSession = {
        ...upsert.session,
        id: upsert.sessionId,
        __provider: upsert.provider,
        ...(upsert.project?.projectId ? { __projectId: upsert.project.projectId } : {}),
      };
      // The same rule as the sidebar row: a blank summary never blanks a title we have.
      if (!canonicalSession.summary?.trim()) {
        delete canonicalSession.summary;
      }
      commit({ type: 'patchSession', sessionId: upsert.sessionId, patch: canonicalSession }, 'replace', { origin: 'sync' });
    };

    return subscribe(handleEvent);
  }, [commit, layoutRef, markSessionAttention, refreshProjectsSilently, subscribe]);

  useEffect(() => {
    return () => {
      if (loadingProgressTimeoutRef.current) {
        clearTimeout(loadingProgressTimeoutRef.current);
        loadingProgressTimeoutRef.current = null;
      }
    };
  }, []);

  const handleSessionDelete = useCallback(
    (sessionIdToDelete: string) => {
      clearSessionAttention(sessionIdToDelete);
      // Every tab showing it closes; the URL follows the focused pane by replace.
      commit({ type: 'removeSession', sessionId: sessionIdToDelete });

      setProjects((prevProjects) =>
        prevProjects.map((project) => removeSessionFromProject(project, sessionIdToDelete)),
      );
    },
    [clearSessionAttention, commit],
  );

  const handleSidebarRefresh = useCallback(async () => {
    try {
      const response = await api.projects();
      const freshProjects = (await response.json()) as Project[];
      const projectsWithTaskMaster = mergeTaskMasterCache(freshProjects, projects);
      const mergedProjects = mergeExpandedSessionPages(projects, projectsWithTaskMaster);

      setProjects((prevProjects) =>
        projectsHaveChanges(prevProjects, mergedProjects) ? mergedProjects : prevProjects,
      );

      // Every tab showing a refreshed session gets the new row; a row that did
      // not change keeps the tab's session identity, so no chat reacts.
      const current = layoutRef.current;
      const openSessionIds = new Set(
        [...current.left.tabs, ...(current.right?.tabs ?? [])]
          .map((tab) => tab.sessionId)
          .filter((tabSessionId): tabSessionId is string => Boolean(tabSessionId)),
      );
      for (const openSessionId of openSessionIds) {
        const refreshed = findLoadedSession(openSessionId, mergedProjects);
        if (refreshed) {
          commit({ type: 'patchSession', sessionId: openSessionId, patch: refreshed.session }, 'replace', { origin: 'sync' });
        }
      }
    } catch (error) {
      console.error('Error refreshing sidebar:', error);
    }
  }, [commit, layoutRef, projects]);

  /**
   * Persists a new title for one session and writes it onto every local copy
   * — the sidebar row in `projects` and each tab holding the session, which
   * the workspace header and the document title read — the moment the backend
   * confirms. The rename route only updates the DB; it does not broadcast a
   * `session_upserted`, so nothing else would refresh the header. Patching in
   * place rather than refetching also keeps every session page the sidebar has
   * loaded past the first. The sidebar's Conversations list folds the new
   * title in from `projects` itself.
   *
   * Resolves `false` when the backend refused the rename; transport errors
   * propagate so the caller can tell the two apart, as the sidebar does.
   */
  const renameSession = useCallback(async (sessionIdToRename: string, summary: string): Promise<boolean> => {
    const trimmed = summary.trim();
    if (!trimmed) {
      return false;
    }

    const response = await api.renameSession(sessionIdToRename, trimmed);
    if (!response.ok) {
      console.error('[Workspace] Failed to rename session:', response.status);
      return false;
    }

    setProjects((previousProjects) => {
      let changed = false;
      const nextProjects = previousProjects.map((project) => {
        const renamedProject = renameSessionInProject(project, sessionIdToRename, trimmed);
        if (renamedProject !== project) {
          changed = true;
        }
        return renamedProject;
      });
      return changed ? nextProjects : previousProjects;
    });

    // A session opened from a Conversations search hit carries the one-shot
    // jump target the chat reads off every new session identity. Leave it
    // behind, or the rename would scroll the transcript back to the matched
    // message and flash the search highlight again.
    commit({ type: 'patchSession', sessionId: sessionIdToRename, patch: { summary: trimmed }, dropSearchTarget: true });

    return true;
  }, [commit]);

  const loadMoreProjectSessions = useCallback(async (projectId: string) => {
    const project = projects.find((candidate) => candidate.projectId === projectId);
    if (!project) {
      return;
    }

    const loadedCount = countLoadedProjectSessions(project);
    const totalCount = Number(project.sessionMeta?.total ?? 0);
    if (totalCount > 0 && loadedCount >= totalCount) {
      return;
    }

    const response = await api.projectSessions(projectId, {
      limit: 20,
      offset: loadedCount,
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string | { message?: string } };
      const errorPayload = payload.error;
      const message =
        typeof errorPayload === 'string'
          ? errorPayload
          : errorPayload && typeof errorPayload === 'object' && errorPayload.message
            ? errorPayload.message
            : `Failed to load more sessions for project ${projectId}`;
      throw new Error(message);
    }

    const sessionsPage = (await response.json()) as ProjectSessionPage;

    setProjects((previousProjects) =>
      previousProjects.map((candidate) => {
        if (candidate.projectId !== projectId) {
          return candidate;
        }

        return mergeProjectSessionPage(candidate, sessionsPage);
      }),
    );
  }, [projects]);

  // `projectId` is the DB identifier passed from the sidebar's delete flow
  // after the migration away from folder-derived project names.
  const handleProjectDelete = useCallback(
    (projectId: string) => {
      // Every tab of the project closes, drafts included.
      commit({ type: 'removeProject', projectId });

      setProjects((prevProjects) => prevProjects.filter((project) => project.projectId !== projectId));
    },
    [commit],
  );

  const selectedProject = focused.project;
  const selectedSession = focused.session;

  const sidebarSharedProps = useMemo(
    () => ({
      projects,
      selectedProject,
      selectedSession,
      attentionSessionIds,
      // A title click only records the browsed project: it no longer clears or navigates a pane.
      onProjectSelect: recordBrowsedProject,
      onSessionSelect: actions.openSession,
      onNewSession: actions.openNewSession,
      onSessionDelete: handleSessionDelete,
      onLoadMoreSessions: loadMoreProjectSessions,
      onProjectDelete: handleProjectDelete,
      isLoading: isLoadingProjects,
      loadingProgress,
      onRefresh: handleSidebarRefresh,
      onShowSettings: () => setShowSettings(true),
      showSettings,
      settingsInitialTab,
      onCloseSettings: () => setShowSettings(false),
      isMobile,
    }),
    [
      actions,
      attentionSessionIds,
      handleProjectDelete,
      handleSessionDelete,
      handleSidebarRefresh,
      isLoadingProjects,
      isMobile,
      loadMoreProjectSessions,
      loadingProgress,
      projects,
      recordBrowsedProject,
      selectedProject,
      selectedSession,
      settingsInitialTab,
      showSettings,
    ],
  );

  const isSplit = layout.right !== null;
  const paneTargetingBase = useMemo<Omit<SidebarPaneTargeting, 'canTargetSides'>>(
    () => ({
      isSplit,
      focusedSide: layout.focusedSide,
      onFocusSide: actions.focusPane,
      placements: sessionPlacements,
    }),
    [actions, isSplit, layout.focusedSide, sessionPlacements],
  );

  const focusedTabKey = getPane(layout, layout.focusedSide)?.activeTabKey ?? null;

  // The command state's project (focused pane's, else the fallback), read when setActiveTab runs.
  const commandProjectRef = useRef<Project | null>(selectedProject ?? fallbackProject);
  useLayoutEffect(() => {
    commandProjectRef.current = selectedProject ?? fallbackProject;
  });

  /**
   * Switches the focused tab's view as a user action (a preview becomes a kept tab). A pane that shows
   * nothing (empty, or a conversation that is gone) opens a new chat in the command project on that view
   * instead, so the palette's Navigate items act there too. The quick settings' command insert does not
   * come here for such a pane: the insert opens that chat itself (ProjectQuickSettingsRegion).
   */
  const setActiveTab = useCallback((view: AppTab) => {
    const current = layoutRef.current;
    const tab = getActiveTab(getPane(current, current.focusedSide));
    if (tab && !tab.isMissing) {
      actions.setTabView(current.focusedSide, tab.key, view, { pin: true });
      return;
    }
    const project = commandProjectRef.current;
    if (project) {
      actions.openNewSession(project, { target: current.focusedSide, view });
    }
  }, [actions, layoutRef]);

  return {
    projects,
    isLoadingProjects,
    loadingProgress,
    attentionSessionIds,
    sidebarOpen,
    setSidebarOpen,
    showSettings,
    setShowSettings,
    settingsInitialTab,
    openSettings,
    fetchProjects,
    refreshProjectsSilently,
    registerOptimisticSession,
    handleSessionDelete,
    handleProjectDelete,
    handleSidebarRefresh,
    loadMoreProjectSessions,
    renameSession,
    sidebarSharedProps,
    paneTargetingBase,
    focusedTabKey,
    layout,
    actions,
    paneProjects,
    fallbackProject,
    sessionPlacements,
    visibleSessionIds,
    setCanShowBothPanes,
    setPaneEditorUnsaved,
    /** Focused pane's project; null for an empty pane. */
    selectedProject,
    /** Focused pane's session; null for a new chat or an empty pane. */
    selectedSession,
    focusedProject: selectedProject,
    focusedSession: selectedSession,
    /** New chat in the focused pane. */
    handleNewSession: actions.openNewSession,
    setActiveTab,
    openSessionById: actions.openSessionById,
  };
}
