import express from 'express';

import type { ProjectMountsService } from '@/modules/projects/services/project-mounts.service.js';
import { asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type ProjectMountsRouterDependencies = Pick<
  ProjectMountsService,
  'browseMountTargets' | 'listMountsOverview' | 'createMount' | 'adoptMount' | 'removeMount' | 'repairMount'
>;

function readBody(request: express.Request): Record<string, unknown> {
  return typeof request.body === 'object' && request.body !== null
    ? request.body as Record<string, unknown>
    : {};
}

function readParam(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readQueryString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/**
 * Creates the mounts endpoints under /api/projects: the target folder
 * browser and, per project, list, mount, adopt, unmount and repair. The
 * service comes in as a dependency so route tests can check what reaches it.
 */
export function createProjectMountsRouter(dependencies: ProjectMountsRouterDependencies): express.Router {
  const router = express.Router();

  router.get(
    '/mount-browse',
    asyncHandler(async (req, res) => {
      res.json(createApiSuccessResponse(await dependencies.browseMountTargets(readQueryString(req.query.path))));
    }),
  );

  router.get(
    '/:projectId/mounts',
    asyncHandler(async (req, res) => {
      res.json(createApiSuccessResponse(await dependencies.listMountsOverview(readParam(req.params.projectId))));
    }),
  );

  router.post(
    '/:projectId/mounts',
    asyncHandler(async (req, res) => {
      const body = readBody(req);
      const mount = await dependencies.createMount(readParam(req.params.projectId), {
        name: body.name,
        targetPath: body.targetPath,
      });
      res.json(createApiSuccessResponse({ mount }));
    }),
  );

  router.post(
    '/:projectId/mounts/adopt',
    asyncHandler(async (req, res) => {
      const mount = await dependencies.adoptMount(readParam(req.params.projectId), { name: readBody(req).name });
      res.json(createApiSuccessResponse({ mount }));
    }),
  );

  router.delete(
    '/:projectId/mounts/:mountId',
    asyncHandler(async (req, res) => {
      res.json(createApiSuccessResponse(
        await dependencies.removeMount(readParam(req.params.projectId), readParam(req.params.mountId)),
      ));
    }),
  );

  router.post(
    '/:projectId/mounts/:mountId/repair',
    asyncHandler(async (req, res) => {
      const mount = await dependencies.repairMount(readParam(req.params.projectId), readParam(req.params.mountId));
      res.json(createApiSuccessResponse({ mount }));
    }),
  );

  return router;
}
