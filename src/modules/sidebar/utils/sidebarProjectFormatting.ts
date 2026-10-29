import type { TFunction } from 'i18next';

import type {
  LLMProvider,
  Project,
  ProjectSession,
  ProjectSortOrder,
  SessionWithProvider,
  SettingsProject,
} from '@/shared/types';

// Presentation data the sidebar derives from a session before rendering its row.
type SessionViewModel = {
  isActive: boolean;
  /** The title as stored: what a rename starts from. */
  sessionName: string;
  /** The title as the row shows it (formatSessionTitle). */
  sessionTitle: string;
  sessionTime: string;
  messageCount: number;
};

/**
 * How long ago, in a few characters of the interface language ("<1m", "5m", "23hr", "2d" in
 * English): under a minute, minutes, hours, then days. Empty for a missing or unreadable date.
 * `t` is the sidebar namespace's.
 */
export const formatCompactAge = (
  dateString: string | null | undefined,
  currentTime: Date,
  t: TFunction,
): string => {
  if (!dateString) return '';

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return '';

  const minutes = Math.floor(Math.max(0, currentTime.getTime() - date.getTime()) / 60000);
  if (minutes < 1) return t('time.compactNow');
  if (minutes < 60) return t('time.compactMinutes', { count: minutes });

  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? t('time.compactHours', { count: hours })
    : t('time.compactDays', { count: Math.floor(hours / 24) });
};

/** "Untitled Claude Session" and the like: the names the server gives a session that has no title yet. */
const SERVER_UNTITLED_SESSION = /^Untitled (Claude|Codex|Cursor|OpenCode) Session$/;

/**
 * A session title as the sidebar shows it: the server's placeholder names ("Untitled Claude Session",
 * "Untitled Session", agy's "Untitled", the conversation search's "New Session") in the interface
 * language, any other title as it is. A rename starts from the stored title, so saving it unchanged
 * does not store the translation. The keys name their namespace, so any `t` will do. Exported for
 * project-workspace, which names sessions this way too (pane tabs, the phone header, an empty pane's
 * recent list, the browser tab title, the palette's session rows, the terminal's header), and for
 * run-notifications (a session the workspace does not know, by the server's name).
 */
export const formatSessionTitle = (title: string, t: TFunction): string => {
  const provider = SERVER_UNTITLED_SESSION.exec(title)?.[1];
  if (provider) {
    return t('sidebar:projects.untitledProviderSession', { provider });
  }
  if (title === 'New Session') {
    return t('sidebar:projects.newSession');
  }
  return title === 'Untitled Session' || title === 'Untitled' ? t('sidebar:projects.untitledSession') : title;
};

const getCreatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.createdAt || session.created_at || '');
};

const getUpdatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.lastActivity || '');
};

const getSessionProvider = (session: ProjectSession): LLMProvider => {
  const provider = session.__provider ?? session.provider;
  return typeof provider === 'string' && provider.trim()
    ? provider as LLMProvider
    : 'claude';
};

const getSessionDate = (session: SessionWithProvider): Date => {
  return new Date(getUpdatedTimestamp(session) || getCreatedTimestamp(session) || 0);
};

const getSessionName = (session: SessionWithProvider, t: TFunction): string => {
  return session.summary || session.name || t('projects.newSession');
};

const getSessionTime = (session: SessionWithProvider): string => {
  return getUpdatedTimestamp(session) || getCreatedTimestamp(session);
};

export const createSessionViewModel = (
  session: SessionWithProvider,
  currentTime: Date,
  t: TFunction,
): SessionViewModel => {
  const sessionDate = getSessionDate(session);
  const diffInMinutes = Math.floor((currentTime.getTime() - sessionDate.getTime()) / (1000 * 60));
  const sessionName = getSessionName(session, t);

  return {
    isActive: diffInMinutes < 10,
    sessionName,
    sessionTitle: formatSessionTitle(sessionName, t),
    sessionTime: getSessionTime(session),
    messageCount: Number(session.messageCount || 0),
  };
};

/**
 * Cached against the project object, not its id.
 *
 * Every sidebar render asks for each project's sessions, and this builds a new
 * array of new session objects. Without the cache the array is a different
 * reference each time, which is enough on its own to defeat the memo boundary
 * on every project and session row. `useProjectsState` always replaces a
 * project rather than mutating it, so a stale entry is unreachable: a changed
 * project is a different key.
 */
const sortedSessionsByProject = new WeakMap<Project, SessionWithProvider[]>();

export const getAllSessions = (project: Project): SessionWithProvider[] => {
  const cached = sortedSessionsByProject.get(project);
  if (cached) {
    return cached;
  }

  const sessions = (project.sessions || []).map((session) => ({
    ...session,
    __provider: getSessionProvider(session),
  })).sort(
    (a, b) => getSessionDate(b).getTime() - getSessionDate(a).getTime(),
  );

  sortedSessionsByProject.set(project, sessions);
  return sessions;
};

const getProjectLastActivity = (project: Project): Date => {
  const sessions = getAllSessions(project);
  if (sessions.length === 0) {
    return new Date(0);
  }

  return sessions.reduce((latest, session) => {
    const sessionDate = getSessionDate(session);
    return sessionDate > latest ? sessionDate : latest;
  }, new Date(0));
};

export const sortProjects = (
  projects: Project[],
  projectSortOrder: ProjectSortOrder,
): Project[] => {
  const byName = [...projects];

  byName.sort((projectA, projectB) => {
    // Star order now comes from backend `projects.isStarred`.
    const aStarred = Boolean(projectA.isStarred);
    const bStarred = Boolean(projectB.isStarred);

    if (aStarred && !bStarred) {
      return -1;
    }

    if (!aStarred && bStarred) {
      return 1;
    }

    if (projectSortOrder === 'date') {
      return getProjectLastActivity(projectB).getTime() - getProjectLastActivity(projectA).getTime();
    }

    return (projectA.displayName || projectA.projectId).localeCompare(projectB.displayName || projectB.projectId);
  });

  return byName;
};

export const filterProjects = (projects: Project[], searchFilter: string): Project[] => {
  const normalizedSearch = searchFilter.trim().toLowerCase();
  if (!normalizedSearch) {
    return projects;
  }

  return projects.filter((project) => {
    const displayName = (project.displayName || project.projectId).toLowerCase();
    // `project.path`/`fullPath` is the most useful search target now that the
    // folder-derived name is gone; fall back to displayName above.
    const searchPath = (project.path || project.fullPath || '').toLowerCase();
    return displayName.includes(normalizedSearch) || searchPath.includes(normalizedSearch);
  });
};

export const getTaskIndicatorStatus = (
  project: Project,
  mcpServerStatus: { hasMCPServer?: boolean; isConfigured?: boolean } | null,
) => {
  const projectConfigured = Boolean(project.taskmaster?.hasTaskmaster);
  const mcpConfigured = Boolean(mcpServerStatus?.hasMCPServer && mcpServerStatus?.isConfigured);

  if (projectConfigured && mcpConfigured) {
    return 'fully-configured';
  }

  if (projectConfigured) {
    return 'taskmaster-only';
  }

  if (mcpConfigured) {
    return 'mcp-only';
  }

  return 'not-configured';
};

export const normalizeProjectForSettings = (project: Project): SettingsProject => {
  const fallbackPath =
    typeof project.fullPath === 'string' && project.fullPath.length > 0
      ? project.fullPath
      : typeof project.path === 'string'
        ? project.path
        : '';

  // Legacy SettingsProject still expects a `name` field; use the projectId so
  // downstream consumers that rely on a stable identifier continue to work.
  return {
    name: project.projectId,
    displayName:
      typeof project.displayName === 'string' && project.displayName.trim().length > 0
        ? project.displayName
        : project.projectId,
    fullPath: fallbackPath,
    path:
      typeof project.path === 'string' && project.path.length > 0
        ? project.path
        : fallbackPath,
  };
};

/** Display names for the providers a session row can belong to. */
export const PROVIDER_LABELS: Record<LLMProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  agy: 'Antigravity',
};
