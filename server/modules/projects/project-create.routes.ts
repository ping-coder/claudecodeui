import express from 'express';

import type { listProjectTemplates } from '@/modules/project-templates/index.js';
import type { createProjectWithTemplate } from '@/modules/projects/services/project-template-create.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type ProjectCreateRouterDependencies = {
  listProjectTemplates: typeof listProjectTemplates;
  createProjectWithTemplate: typeof createProjectWithTemplate;
};

/**
 * Creates the template list and the create-project endpoint. Services come in
 * as dependencies so route tests can check what reaches them.
 */
export function createProjectCreateRouter(dependencies: ProjectCreateRouterDependencies): express.Router {
  const router = express.Router();

  router.get(
    '/templates',
    asyncHandler(async (_req, res) => {
      res.json(createApiSuccessResponse({ templates: dependencies.listProjectTemplates() }));
    }),
  );

  router.post(
    '/create-project',
    asyncHandler(async (req, res) => {
      const requestBody = req.body as Record<string, unknown>;
      const projectPath = typeof requestBody.path === 'string' ? requestBody.path : '';
      const customName = typeof requestBody.customName === 'string' ? requestBody.customName : null;

      if (requestBody.workspaceType !== undefined) {
        throw new AppError('workspaceType is no longer supported. Use the single create-project flow.', {
          code: 'LEGACY_WORKSPACE_TYPE_UNSUPPORTED',
          statusCode: 400,
        });
      }

      if (requestBody.githubUrl || requestBody.githubTokenId || requestBody.newGithubToken) {
        throw new AppError('Repository cloning is not supported on create-project', {
          code: 'CLONE_NOT_SUPPORTED_ON_CREATE_PROJECT',
          statusCode: 400,
          details: 'Use /api/projects/clone for cloning workflows',
        });
      }

      const projectCreationResult = await dependencies.createProjectWithTemplate({
        projectPath,
        customName,
        templateId: typeof requestBody.templateId === 'string' ? requestBody.templateId : null,
        git: requestBody.git === 'init' || requestBody.git === 'none' ? requestBody.git : null,
        locale: typeof requestBody.locale === 'string' ? requestBody.locale : null,
      });

      res.json({
        success: true,
        project: projectCreationResult.project,
        ...(projectCreationResult.template ? { template: projectCreationResult.template } : {}),
        message:
          projectCreationResult.outcome === 'reactivated_archived'
            ? 'Archived project path reused successfully'
            : 'Project created successfully',
      });
    }),
  );

  return router;
}
