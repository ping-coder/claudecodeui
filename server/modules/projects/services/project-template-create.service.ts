import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import {
  applyProjectTemplate,
  initializeTemplateGitRepository,
  resolveProjectTemplate,
} from '@/modules/project-templates/index.js';
import { createProject } from '@/modules/projects/services/project-management.service.js';
import type {
  ProjectRepositoryRow,
  ProjectTemplateApplyResult,
  ProjectTemplateGitMode,
  ProjectTemplateGitResult,
  ProjectTemplateReport,
  ProjectTemplateWarning,
  WorkspacePathValidationResult,
} from '@/shared/types.js';
import { AppError, normalizeProjectPath, validateWorkspacePath, WORKSPACES_ROOT } from '@/shared/utils.js';

type CreateProjectWithTemplateInput = {
  projectPath: string;
  customName?: string | null;
  templateId?: string | null;
  git?: ProjectTemplateGitMode | null;
  locale?: string | null;
};

type CreateProjectResult = Awaited<ReturnType<typeof createProject>>;

type CreateProjectWithTemplateDependencies = {
  validatePath: (projectPath: string) => Promise<WorkspacePathValidationResult>;
  getProjectByPath: (projectPath: string) => ProjectRepositoryRow | null;
  createProject: (input: { projectPath: string; customName?: string | null }) => Promise<CreateProjectResult>;
  applyTemplate: typeof applyProjectTemplate;
  initializeGitRepository: typeof initializeTemplateGitRepository;
  /** Resolved folders a template may not be applied to as the project folder itself. */
  listProtectedRoots: () => Promise<string[]>;
  logError: (message: string, error: unknown) => void;
};

/** Real path in the same form validateWorkspacePath returns, or the plain resolved path when it does not exist. */
async function resolveComparablePath(targetPath: string): Promise<string> {
  try {
    return normalizeProjectPath(await realpath(targetPath));
  } catch {
    return normalizeProjectPath(path.resolve(targetPath));
  }
}

const defaultDependencies: CreateProjectWithTemplateDependencies = {
  validatePath: validateWorkspacePath,
  getProjectByPath: (projectPath: string): ProjectRepositoryRow | null => projectsDb.getProjectPath(projectPath),
  createProject: (input) => createProject(input),
  applyTemplate: (input) => applyProjectTemplate(input),
  initializeGitRepository: (input) => initializeTemplateGitRepository(input),
  listProtectedRoots: () => Promise.all([os.homedir(), WORKSPACES_ROOT].map(resolveComparablePath)),
  logError: (message: string, error: unknown): void => {
    console.error(message, error);
  },
};

/**
 * Creates a project and, for a template other than Blank, writes the template
 * files and sets up git. Used by `POST /api/projects/create-project`.
 * `createProject` keeps its signature because the worktrees module calls it.
 *
 * Order matters: an unknown template is rejected before anything touches the
 * disk, and the path is validated and checked against active projects before
 * any template file is written, so a template never lands in a project that
 * already exists. The home folder and the workspace root are refused too.
 * Once the project is registered, template and git problems only become
 * report warnings.
 */
export async function createProjectWithTemplate(
  input: CreateProjectWithTemplateInput,
  dependencyOverrides: Partial<CreateProjectWithTemplateDependencies> = {},
): Promise<CreateProjectResult & { template?: ProjectTemplateReport }> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const template = resolveProjectTemplate(input.templateId);
  const projectInput = { projectPath: input.projectPath, customName: input.customName ?? null };

  if (!template) {
    return dependencies.createProject(projectInput);
  }

  const normalizedPath = normalizeProjectPath(input.projectPath || '');
  if (!normalizedPath) {
    throw new AppError('path is required', {
      code: 'PROJECT_PATH_REQUIRED',
      statusCode: 400,
    });
  }

  const pathValidation = await dependencies.validatePath(normalizedPath);
  if (!pathValidation.valid || !pathValidation.resolvedPath) {
    throw new AppError('Invalid project path', {
      code: 'INVALID_PROJECT_PATH',
      statusCode: 400,
      details: pathValidation.error ?? 'Path validation failed',
    });
  }

  const resolvedProjectPath = normalizeProjectPath(pathValidation.resolvedPath);

  // In the home folder (the default workspace root) `.claude/skills` is Claude's
  // user-level skills folder, so the skills would load in every project, and
  // `git init` would put every project created below it inside one repository.
  if ((await dependencies.listProtectedRoots()).includes(resolvedProjectPath)) {
    throw new AppError(
      'Templates cannot be added to the home folder or the workspace root. Choose a folder inside it.',
      {
        code: 'TEMPLATE_NOT_ALLOWED_AT_ROOT',
        statusCode: 400,
        details: `Template not allowed at: ${resolvedProjectPath}`,
      },
    );
  }

  // createProject only finds an active conflict after it has created the
  // directory; checking first keeps template files out of an existing project.
  const existingProject = dependencies.getProjectByPath(resolvedProjectPath);
  if (existingProject && !existingProject.isArchived) {
    throw new AppError('Project path already exists and is active', {
      code: 'PROJECT_ALREADY_EXISTS',
      statusCode: 409,
      details: `Project path already exists: ${resolvedProjectPath}`,
    });
  }

  const createdProject = await dependencies.createProject(projectInput);
  const projectRoot = createdProject.project.fullPath;

  let applyResult: ProjectTemplateApplyResult;
  try {
    applyResult = await dependencies.applyTemplate({
      projectRoot,
      template,
      locale: input.locale,
      projectName: createdProject.project.displayName,
    });
  } catch (error) {
    dependencies.logError('Failed to apply project template:', error);
    applyResult = { created: [], skipped: [], warnings: ['TEMPLATE_APPLY_FAILED'] };
  }

  const warnings: ProjectTemplateWarning[] = [...applyResult.warnings];
  let git: ProjectTemplateGitResult = { action: 'none', committed: false };
  const gitMode = template.git.offersInit ? input.git ?? template.git.defaultMode : 'none';
  if (gitMode === 'init') {
    try {
      const gitOutcome = await dependencies.initializeGitRepository({
        projectRoot,
        files: applyResult.created,
        commitMessage: template.git.initialCommitMessage,
      });
      git = gitOutcome.git;
      warnings.push(...gitOutcome.warnings);
    } catch (error) {
      dependencies.logError('Failed to initialize the template repository:', error);
      warnings.push('GIT_INIT_FAILED');
    }
  }

  return {
    ...createdProject,
    template: {
      templateId: template.id,
      created: applyResult.created,
      skipped: applyResult.skipped,
      git,
      warnings,
    },
  };
}
