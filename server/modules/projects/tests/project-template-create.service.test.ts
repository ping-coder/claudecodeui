import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyProjectTemplate } from '@/modules/project-templates/index.js';
import { createProjectWithTemplate } from '@/modules/projects/services/project-template-create.service.js';
import { AppError } from '@/shared/utils.js';

type Dependencies = NonNullable<Parameters<typeof createProjectWithTemplate>[1]>;

const projectView = {
  projectId: 'project-1',
  path: '/workspace/my-app',
  fullPath: '/workspace/my-app',
  displayName: 'my-app',
  customName: 'my-app',
  isArchived: false,
  isStarred: false,
  sessions: [] as [],
  sessionMeta: { hasMore: false as const, total: 0 as const },
};

/** Records every dependency call so a test can check what ran and in which order. */
function buildDependencies(calls: string[], overrides: Partial<Dependencies> = {}): Partial<Dependencies> {
  return {
    validatePath: async (projectPath) => {
      calls.push(`validate:${projectPath}`);
      return { valid: true, resolvedPath: projectPath };
    },
    getProjectByPath: (projectPath) => {
      calls.push(`lookup:${projectPath}`);
      return null;
    },
    createProject: async (input) => {
      calls.push(`create:${input.projectPath}`);
      return { outcome: 'created', project: projectView };
    },
    applyTemplate: async (input) => {
      calls.push(`apply:${input.template.id}:${input.locale ?? ''}:${input.projectName}`);
      return { created: ['TASKS.md', 'CLAUDE.md'], skipped: [{ path: '.gitignore', reason: 'exists' }], warnings: [] };
    },
    initializeGitRepository: async (input) => {
      calls.push(`git:${input.files.join(',')}:${input.commitMessage}`);
      return { git: { action: 'initialized', committed: true, commitSha: 'abc123' }, warnings: [] };
    },
    logError: () => undefined,
    ...overrides,
  };
}

test('an unknown template is a 400 before the path is even looked at', async () => {
  const calls: string[] = [];
  await assert.rejects(
    createProjectWithTemplate({ projectPath: '/workspace/my-app', templateId: 'nope' }, buildDependencies(calls)),
    (error: unknown) => error instanceof AppError && error.code === 'UNKNOWN_PROJECT_TEMPLATE' && error.statusCode === 400,
  );
  assert.deepEqual(calls, []);
});

test('Blank and a missing template id create the project exactly as before', async () => {
  for (const templateId of [undefined, null, 'blank']) {
    const calls: string[] = [];
    const result = await createProjectWithTemplate(
      { projectPath: '/workspace/my-app', customName: 'Mine', templateId, git: 'init' },
      buildDependencies(calls),
    );

    assert.deepEqual(calls, ['create:/workspace/my-app']);
    assert.deepEqual(result, { outcome: 'created', project: projectView });
    assert.equal('template' in result, false);
  }
});

test('an active project at the path is a 409 and nothing is created or written', async () => {
  const calls: string[] = [];
  await assert.rejects(
    createProjectWithTemplate(
      { projectPath: '/workspace/my-app', templateId: 'coding' },
      buildDependencies(calls, {
        getProjectByPath: (projectPath) => {
          calls.push(`lookup:${projectPath}`);
          return { project_id: 'p', project_path: projectPath, custom_project_name: null, isStarred: 0, isArchived: 0 };
        },
      }),
    ),
    (error: unknown) => error instanceof AppError && error.code === 'PROJECT_ALREADY_EXISTS' && error.statusCode === 409,
  );
  assert.deepEqual(calls, ['validate:/workspace/my-app', 'lookup:/workspace/my-app']);
});

test('an invalid path is a 400 before anything is created', async () => {
  const calls: string[] = [];
  await assert.rejects(
    createProjectWithTemplate(
      { projectPath: '/etc/nope', templateId: 'coding' },
      buildDependencies(calls, { validatePath: async () => ({ valid: false, error: 'blocked' }) }),
    ),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_PROJECT_PATH' && error.statusCode === 400,
  );
  assert.deepEqual(calls, []);
});

test('a template in the home folder is a 400 before anything is created or written', async () => {
  const home = await fs.realpath(os.homedir());
  const calls: string[] = [];
  await assert.rejects(
    createProjectWithTemplate({ projectPath: home, templateId: 'coding', git: 'init' }, buildDependencies(calls)),
    (error: unknown) => error instanceof AppError && error.code === 'TEMPLATE_NOT_ALLOWED_AT_ROOT' && error.statusCode === 400,
  );
  assert.deepEqual(calls, [`validate:${home}`]);
});

test('a template at the workspace root is a 400, a folder inside it is fine', async () => {
  const listProtectedRoots = async () => ['/workspace'];
  const calls: string[] = [];
  await assert.rejects(
    createProjectWithTemplate(
      { projectPath: '/workspace/', templateId: 'coding' },
      buildDependencies(calls, { listProtectedRoots }),
    ),
    (error: unknown) => error instanceof AppError && error.code === 'TEMPLATE_NOT_ALLOWED_AT_ROOT' && error.statusCode === 400,
  );
  assert.deepEqual(calls, ['validate:/workspace']);

  const result = await createProjectWithTemplate(
    { projectPath: '/workspace/my-app', templateId: 'coding' },
    buildDependencies([], { listProtectedRoots }),
  );
  assert.equal(result.template?.templateId, 'coding');
});

test('Blank in the home folder still creates the project as before', async () => {
  const home = await fs.realpath(os.homedir());
  const calls: string[] = [];
  const result = await createProjectWithTemplate({ projectPath: home, templateId: 'blank' }, buildDependencies(calls));

  assert.deepEqual(calls, [`create:${home}`]);
  assert.equal('template' in result, false);
});

test('an archived project at the path is reused and gets the template', async () => {
  const calls: string[] = [];
  const result = await createProjectWithTemplate(
    { projectPath: '/workspace/my-app', templateId: 'coding', locale: 'zh-CN' },
    buildDependencies(calls, {
      getProjectByPath: (projectPath) => ({
        project_id: 'p', project_path: projectPath, custom_project_name: null, isStarred: 0, isArchived: 1,
      }),
    }),
  );

  assert.ok(calls.includes('apply:coding:zh-CN:my-app'));
  assert.equal(result.template?.templateId, 'coding');
});

test('coding creates, applies, then initializes git with only the created files', async () => {
  const calls: string[] = [];
  const result = await createProjectWithTemplate(
    { projectPath: '/workspace/my-app', templateId: 'coding', locale: 'en' },
    buildDependencies(calls),
  );

  assert.deepEqual(calls, [
    'validate:/workspace/my-app',
    'lookup:/workspace/my-app',
    'create:/workspace/my-app',
    'apply:coding:en:my-app',
    'git:TASKS.md,CLAUDE.md:Initial commit from the coding template',
  ]);
  assert.deepEqual(result.template, {
    templateId: 'coding',
    created: ['TASKS.md', 'CLAUDE.md'],
    skipped: [{ path: '.gitignore', reason: 'exists' }],
    git: { action: 'initialized', committed: true, commitSha: 'abc123' },
    warnings: [],
  });
  assert.equal(result.project.projectId, 'project-1');
});

test('git "none" writes the files and leaves git alone', async () => {
  const calls: string[] = [];
  const result = await createProjectWithTemplate(
    { projectPath: '/workspace/my-app', templateId: 'coding', git: 'none' },
    buildDependencies(calls),
  );

  assert.equal(calls.some((call) => call.startsWith('git:')), false);
  assert.deepEqual(result.template?.git, { action: 'none', committed: false });
});

test('a template failure after registration still returns the project, with warnings', async () => {
  const calls: string[] = [];
  const result = await createProjectWithTemplate(
    { projectPath: '/workspace/my-app', templateId: 'coding' },
    buildDependencies(calls, {
      applyTemplate: async () => {
        throw new Error('disk on fire');
      },
      initializeGitRepository: async () => {
        throw new Error('git exploded');
      },
    }),
  );

  assert.equal(result.project.projectId, 'project-1');
  assert.deepEqual(result.template?.created, []);
  assert.deepEqual(result.template?.warnings, ['TEMPLATE_APPLY_FAILED', 'GIT_INIT_FAILED']);
});

test('git warnings are passed through to the report', async () => {
  const result = await createProjectWithTemplate(
    { projectPath: '/workspace/my-app', templateId: 'coding' },
    buildDependencies([], {
      initializeGitRepository: async () => ({
        git: { action: 'initialized', committed: false },
        warnings: ['GIT_IDENTITY_MISSING'],
      }),
    }),
  );

  assert.deepEqual(result.template?.git, { action: 'initialized', committed: false });
  assert.deepEqual(result.template?.warnings, ['GIT_IDENTITY_MISSING']);
});

test('the real apply engine writes the template into the created project folder', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'project-template-create-'));
  try {
    const result = await createProjectWithTemplate(
      { projectPath: projectRoot, customName: 'Shop', templateId: 'coding', git: 'none', locale: 'en' },
      buildDependencies([], {
        createProject: async () => ({
          outcome: 'created',
          project: { ...projectView, path: projectRoot, fullPath: projectRoot, displayName: 'Shop' },
        }),
        applyTemplate: (input) => applyProjectTemplate(input),
      }),
    );

    assert.equal(result.template?.created.length, 5);
    const tasks = await fs.readFile(path.join(projectRoot, 'TASKS.md'), 'utf8');
    assert.equal(tasks.split('\n')[0], '# Shop tasks');
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});
