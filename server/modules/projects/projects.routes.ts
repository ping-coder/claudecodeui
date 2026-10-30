import express from 'express';

import { listProjectTemplates } from '@/modules/project-templates/index.js';
import { updateProjectDisplayName } from '@/modules/projects/services/project-management.service.js';
import { createProjectCloneRouter } from '@/modules/projects/project-clone.routes.js';
import { createProjectCreateRouter } from '@/modules/projects/project-create.routes.js';
import { createProjectMountsRouter } from '@/modules/projects/project-mounts.routes.js';
import { createPendingCloneRequests } from '@/modules/projects/services/project-clone-request.service.js';
import { startCloneProject } from '@/modules/projects/services/project-clone.service.js';
import { projectMountsService } from '@/modules/projects/services/project-mounts.service.js';
import { createProjectWithTemplate } from '@/modules/projects/services/project-template-create.service.js';
import { getProjectTaskMaster } from '@/modules/projects/services/projects-has-taskmaster.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import { getArchivedProjectsWithSessions, getProjectSessionsPage, getProjectsWithSessions } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';
import { deleteOrArchiveProject, restoreArchivedProject } from '@/modules/projects/services/project-delete.service.js';
import { applyLegacyStarredProjectIds, toggleProjectStar } from '@/modules/projects/services/project-star.service.js';

/**
 * How long a posted clone request waits for its progress stream to be opened.
 * The client opens the stream as soon as the POST resolves, so this only has
 * to outlast a slow round trip.
 */
const PENDING_CLONE_REQUEST_TTL_MS = 60_000;

const router = express.Router();

function readQueryStringValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }

  return '';
}

function readOptionalNumericQueryValue(value: unknown): number | null {
  const rawValue = readQueryStringValue(value).trim();
  if (!rawValue) {
    return null;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isNaN(parsedValue) ? null : parsedValue;
}

function parseNonNegativeIntQuery(value: unknown, name: string, fallback: number): number {
  const rawValue = readQueryStringValue(value).trim();
  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsedValue) || parsedValue < 0) {
    throw new AppError(`${name} must be a non-negative integer`, {
      code: 'INVALID_QUERY_PARAMETER',
      statusCode: 400,
    });
  }

  return parsedValue;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const skipSynchronization =
      readQueryStringValue(req.query.skipSynchronization).trim() === '1' ||
      readQueryStringValue(req.query.skipSync).trim() === '1';
    const sessionsLimit = readOptionalNumericQueryValue(req.query.sessionsLimit) ?? undefined;
    const sessionsOffset = readOptionalNumericQueryValue(req.query.sessionsOffset) ?? undefined;
    const projects = await getProjectsWithSessions({
      skipSynchronization,
      sessionsLimit,
      sessionsOffset,
    });
    res.json(projects);
  }),
);

router.get(
  '/archived',
  asyncHandler(async (_req, res) => {
    const projects = await getArchivedProjectsWithSessions();
    res.json(createApiSuccessResponse({ projects }));
  }),
);

router.get(
  '/:projectId/sessions',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const limit = parseNonNegativeIntQuery(req.query.limit, 'limit', 20);
    const offset = parseNonNegativeIntQuery(req.query.offset, 'offset', 0);
    const sessionsPage = await getProjectSessionsPage(projectId, { limit, offset });
    res.json(sessionsPage);
  }),
);

// GET /templates and POST /create-project.
router.use(
  createProjectCreateRouter({
    listProjectTemplates,
    createProjectWithTemplate,
  }),
);

/**
 * One-time (or idempotent) migration: apply legacy `localStorage` starred projectIds to the DB, then clear client storage.
 */
router.post(
  '/migrate-legacy-stars',
  asyncHandler(async (req, res) => {
    const projectIds = Array.isArray((req.body as { projectIds?: unknown })?.projectIds)
      ? ((req.body as { projectIds: unknown[] }).projectIds as unknown[]).map((x) => String(x))
      : [];
    const { updated } = applyLegacyStarredProjectIds(projectIds);
    res.json({ success: true, updated });
  }),
);

router.use(
  createProjectCloneRouter({
    startCloneProject,
    pendingCloneRequests: createPendingCloneRequests(PENDING_CLONE_REQUEST_TTL_MS),
  }),
);

// GET /mount-browse and the /:projectId/mounts endpoints.
router.use(createProjectMountsRouter(projectMountsService));

router.get(
  '/:projectId/taskmaster',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const taskMasterDetails = await getProjectTaskMaster(projectId);
    res.json(taskMasterDetails);
  }),
);

router.put('/:projectId/rename', (req, res) => {
  try {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const { displayName } = req.body as { displayName?: unknown };
    updateProjectDisplayName(projectId, displayName);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to rename project' });
  }
});

router.post(
  '/:projectId/toggle-star',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const { isStarred } = toggleProjectStar(projectId);
    res.json({ success: true, isStarred });
  }),
);

router.post(
  '/:projectId/restore',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    restoreArchivedProject(projectId);
    res.json(createApiSuccessResponse({ projectId, isArchived: false }));
  }),
);

/**
 * - `force` not set / false: archive project in DB only (`isArchived` = 1; hidden from active list).
 * - `force=true`: remove DB row, delete session rows for that path, remove all `*.jsonl` under the Claude project dir.
 */
router.delete(
  '/:projectId',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const force = req.query.force === 'true';
    await deleteOrArchiveProject(projectId, force);
    res.json({ success: true });
  }),
);

export default router;
