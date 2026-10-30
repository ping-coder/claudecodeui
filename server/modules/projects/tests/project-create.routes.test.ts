import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';

import { listProjectTemplates } from '@/modules/project-templates/index.js';
import { createProjectCreateRouter } from '@/modules/projects/project-create.routes.js';
import type { createProjectWithTemplate } from '@/modules/projects/services/project-template-create.service.js';
import { AppError } from '@/shared/utils.js';

type CreateRunner = typeof createProjectWithTemplate;
type CreateInput = Parameters<CreateRunner>[0];

const project = {
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

const report = {
  templateId: 'coding',
  created: ['TASKS.md'],
  skipped: [],
  warnings: ['GIT_IDENTITY_MISSING' as const],
  git: { action: 'initialized' as const, committed: false },
};

async function withCreateServer(
  createRunner: CreateRunner,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/projects', createProjectCreateRouter({
    listProjectTemplates,
    createProjectWithTemplate: createRunner,
  }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.code });
      return;
    }
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function postCreate(baseUrl: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api/projects/create-project`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const unexpectedCreateRunner: CreateRunner = async () => {
  throw new Error('createProjectWithTemplate must not run');
};

test('GET /templates lists the templates in the success envelope, Blank first', async () => {
  await withCreateServer(unexpectedCreateRunner, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/projects/templates`);
    const body = await response.json() as { success: boolean; data: { templates: Array<{ id: string }> } };

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.deepEqual(body.data.templates, listProjectTemplates());
    assert.equal(body.data.templates[0]?.id, 'blank');
  });
});

test('POST /create-project passes the template id, git source and locale to the service', async () => {
  const inputs: CreateInput[] = [];
  await withCreateServer(async (input) => {
    inputs.push(input);
    return { outcome: 'created', project, template: report };
  }, async (baseUrl) => {
    const response = await postCreate(baseUrl, {
      path: '/workspace/my-app',
      customName: 'My app',
      templateId: 'coding',
      git: 'init',
      locale: 'zh-CN',
    });

    assert.equal(response.status, 200);
    assert.deepEqual(inputs, [{
      projectPath: '/workspace/my-app',
      customName: 'My app',
      templateId: 'coding',
      git: 'init',
      locale: 'zh-CN',
    }]);
    assert.deepEqual(response.body, {
      success: true,
      project,
      template: report,
      message: 'Project created successfully',
    });
  });
});

test('POST /create-project without a template keeps today\'s request and response', async () => {
  const inputs: CreateInput[] = [];
  await withCreateServer(async (input) => {
    inputs.push(input);
    return { outcome: 'reactivated_archived', project };
  }, async (baseUrl) => {
    const response = await postCreate(baseUrl, { path: '/workspace/my-app', git: 'something-else' });

    assert.deepEqual(inputs, [{
      projectPath: '/workspace/my-app',
      customName: null,
      templateId: null,
      git: null,
      locale: null,
    }]);
    assert.deepEqual(response.body, {
      success: true,
      project,
      message: 'Archived project path reused successfully',
    });
  });
});

test('POST /create-project still refuses legacy and clone fields', async () => {
  await withCreateServer(unexpectedCreateRunner, async (baseUrl) => {
    const legacy = await postCreate(baseUrl, { path: '/workspace/my-app', workspaceType: 'new' });
    const clone = await postCreate(baseUrl, { path: '/workspace/my-app', githubUrl: 'https://github.com/a/b' });

    assert.equal(legacy.status, 400);
    assert.equal(legacy.body.error, 'LEGACY_WORKSPACE_TYPE_UNSUPPORTED');
    assert.equal(clone.status, 400);
    assert.equal(clone.body.error, 'CLONE_NOT_SUPPORTED_ON_CREATE_PROJECT');
  });
});

test('POST /create-project answers an unknown template with 400 UNKNOWN_PROJECT_TEMPLATE', async () => {
  await withCreateServer(async () => {
    throw new AppError('Unknown project template: nope', { code: 'UNKNOWN_PROJECT_TEMPLATE', statusCode: 400 });
  }, async (baseUrl) => {
    const response = await postCreate(baseUrl, { path: '/workspace/my-app', templateId: 'nope' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'UNKNOWN_PROJECT_TEMPLATE');
  });
});
