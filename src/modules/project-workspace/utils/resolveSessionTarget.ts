import { api } from '@/shared/api';
import { readSelectedProvider } from '@/shared/selectedProvider';
import type { LLMProvider, Project, ProjectSession } from '@/shared/types';

/**
 * Resolves a session id (from a URL, the palette, a notification, a restored tab) to the
 * session and its owning project, the way the workspace opens it in a tab.
 */

/**
 * Shape of `GET /api/providers/sessions/:sessionId`: the authoritative session -> owning
 * project resolution for a session that is not in the paginated project payloads.
 */
type SessionDetailsApiPayload = {
  data?: SessionDetails;
};

type SessionDetails = {
  sessionId?: string;
  provider?: string;
  summary?: string;
  createdAt?: string | null;
  lastActivity?: string | null;
  project?: {
    projectId?: string;
    path?: string;
    fullPath?: string;
    displayName?: string;
    isStarred?: boolean;
  } | null;
};

/**
 * found: the session and its project; isListed is false for a project the sidebar list does not
 * hold (archived), which the caller keeps in its unlisted-project cache.
 * alias: the id was a provider-native alias of `canonicalId`.
 * missing: no such session (deleted elsewhere), the lookup failed, or it has no owning project.
 */
type SessionTargetResolution =
  | { kind: 'found'; session: ProjectSession; project: Project; isListed: boolean }
  | { kind: 'alias'; canonicalId: string }
  | { kind: 'missing' };

const DEFAULT_PROVIDER: LLMProvider = 'claude';

/** Lookups in flight by session id, so every caller asking about one id shares a single request. */
const pendingLookups = new Map<string, Promise<SessionDetails | null>>();

const getSessionProvider = (session: ProjectSession): LLMProvider => {
  const provider = session.__provider ?? session.provider;
  return typeof provider === 'string' && provider.trim() ? provider as LLMProvider : DEFAULT_PROVIDER;
};

/** Finds a session in the loaded project pages, tagged with its provider and owning project; null when no page holds it. */
export const findLoadedSession = (
  sessionId: string,
  projects: Project[],
): { session: ProjectSession; project: Project } | null => {
  for (const project of projects) {
    const match = project.sessions?.find((session) => session.id === sessionId);
    if (match) {
      return {
        session: { ...match, __provider: getSessionProvider(match), __projectId: project.projectId },
        project,
      };
    }
  }
  return null;
};

const fetchSessionDetails = (sessionId: string): Promise<SessionDetails | null> => {
  const pending = pendingLookups.get(sessionId);
  if (pending) {
    return pending;
  }

  const lookup = (async () => {
    try {
      const response = await api.sessionDetails(sessionId);
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as SessionDetailsApiPayload;
      return payload.data ?? null;
    } catch (error) {
      console.error(`Error resolving session ${sessionId}:`, error);
      return null;
    } finally {
      pendingLookups.delete(sessionId);
    }
  })();
  pendingLookups.set(sessionId, lookup);
  return lookup;
};

/**
 * Loaded pages first, then the backend. The project list is read through `readProjects` after the
 * lookup, so a list that finished loading meanwhile still counts the project as listed. Never
 * guesses the project from local state: that used to bind a session to whatever was selected.
 */
export async function resolveSessionTarget(
  sessionId: string,
  readProjects: () => Project[],
): Promise<SessionTargetResolution> {
  const loaded = findLoadedSession(sessionId, readProjects());
  if (loaded) {
    return { kind: 'found', ...loaded, isListed: true };
  }

  const details = await fetchSessionDetails(sessionId);
  if (!details) {
    return { kind: 'missing' };
  }

  if (typeof details.sessionId === 'string' && details.sessionId && details.sessionId !== sessionId) {
    return { kind: 'alias', canonicalId: details.sessionId };
  }

  // The chat cannot run without its project's path, so a session no project owns cannot be shown.
  const projectId = details.project?.projectId;
  if (!projectId) {
    return { kind: 'missing' };
  }

  const listedProject = readProjects().find((candidate) => candidate.projectId === projectId) ?? null;
  // Owning project not in the active list (archived): a minimal entry still gives the chat its paths.
  const project: Project = listedProject ?? {
    projectId,
    path: details.project?.path ?? details.project?.fullPath ?? '',
    fullPath: details.project?.fullPath ?? details.project?.path ?? '',
    displayName: details.project?.displayName ?? '',
    isStarred: Boolean(details.project?.isStarred),
    sessions: [],
    sessionMeta: { hasMore: false, total: 0 },
  };

  const session: ProjectSession = {
    id: sessionId,
    summary: details.summary ?? '',
    createdAt: details.createdAt ?? undefined,
    lastActivity: details.lastActivity ?? undefined,
    __provider: typeof details.provider === 'string' && details.provider.trim()
      ? details.provider as LLMProvider
      : readSelectedProvider(),
    __projectId: projectId,
  };

  return { kind: 'found', session, project, isListed: Boolean(listedProject) };
}
