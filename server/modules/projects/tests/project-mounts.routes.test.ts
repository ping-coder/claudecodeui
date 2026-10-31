import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';

import { createProjectMountsRouter } from '@/modules/projects/project-mounts.routes.js';
import type { ProjectMount } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type RouterDependencies = Parameters<typeof createProjectMountsRouter>[0];

const mount: ProjectMount = {
  mountId: 'mount-1',
  name: 'data',
  linkPath: 'mounts/data',
  targetPath: '/mnt/disk/data',
  realTargetPath: '/mnt/disk/data',
  status: 'ok',
  createdAt: '2026-10-30T00:00:00.000Z',
};

function unexpected(name: string) {
  return async (): Promise<never> => {
    throw new Error(`${name} must not run`);
  };
}

function createDependencies(overrides: Partial<RouterDependencies> = {}): RouterDependencies {
  return {
    browseMountTargets: unexpected('browseMountTargets'),
    listMountsOverview: unexpected('listMountsOverview'),
    createMount: unexpected('createMount'),
    adoptMount: unexpected('adoptMount'),
    removeMount: unexpected('removeMount'),
    repairMount: unexpected('repairMount'),
    ...overrides,
  };
}

async function withMountsServer(
  dependencies: RouterDependencies,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/projects', createProjectMountsRouter(dependencies));
  // The server's global error middleware, as far as these routes rely on it.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
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

async function request(baseUrl: string, method: string, url: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

test('mount routes pass the project, the mount and the body through and wrap the answers', async () => {
  const calls: unknown[][] = [];
  const dependencies = createDependencies({
    listMountsOverview: async (...args) => {
      calls.push(['list', ...args]);
      return { mounts: [mount], adoptable: [{ name: 'old', targetPath: '/mnt/old' }] };
    },
    createMount: async (...args) => {
      calls.push(['create', ...args]);
      return mount;
    },
    adoptMount: async (...args) => {
      calls.push(['adopt', ...args]);
      return mount;
    },
    removeMount: async (...args) => {
      calls.push(['remove', ...args]);
      return { removed: true, linkRemoved: false };
    },
    repairMount: async (...args) => {
      calls.push(['repair', ...args]);
      return mount;
    },
  });

  await withMountsServer(dependencies, async (baseUrl) => {
    assert.deepEqual(await request(baseUrl, 'GET', '/api/projects/p-1/mounts'), {
      status: 200,
      body: { success: true, data: { mounts: [mount], adoptable: [{ name: 'old', targetPath: '/mnt/old' }] } },
    });
    assert.deepEqual(
      await request(baseUrl, 'POST', '/api/projects/p-1/mounts', { name: 'data', targetPath: '/mnt/disk/data', extra: 1 }),
      { status: 200, body: { success: true, data: { mount } } },
    );
    assert.deepEqual(
      await request(baseUrl, 'POST', '/api/projects/p-1/mounts/adopt', { name: 'old' }),
      { status: 200, body: { success: true, data: { mount } } },
    );
    assert.deepEqual(
      await request(baseUrl, 'DELETE', '/api/projects/p-1/mounts/mount-1'),
      { status: 200, body: { success: true, data: { removed: true, linkRemoved: false } } },
    );
    assert.deepEqual(
      await request(baseUrl, 'POST', '/api/projects/p-1/mounts/mount-1/repair'),
      { status: 200, body: { success: true, data: { mount } } },
    );
  });

  assert.deepEqual(calls, [
    ['list', 'p-1'],
    ['create', 'p-1', { name: 'data', targetPath: '/mnt/disk/data' }],
    ['adopt', 'p-1', { name: 'old' }],
    ['remove', 'p-1', 'mount-1'],
    ['repair', 'p-1', 'mount-1'],
  ]);
});

test('mount-browse passes the path along, or nothing for the home folder, and says when the listing was cut short', async () => {
  const paths: Array<string | null> = [];
  const listing = {
    path: '/mnt',
    parent: '/',
    directories: [{ name: 'disk', path: '/mnt/disk' }],
    truncated: { checked: 1_200, total: 48_000 },
  };
  const dependencies = createDependencies({
    browseMountTargets: async (inputPath, options) => {
      paths.push(inputPath);
      assert.equal(options?.signal instanceof AbortSignal, true);
      return listing;
    },
  });

  await withMountsServer(dependencies, async (baseUrl) => {
    assert.deepEqual(await request(baseUrl, 'GET', '/api/projects/mount-browse?path=%2Fmnt'), {
      status: 200,
      body: { success: true, data: listing },
    });
    await request(baseUrl, 'GET', '/api/projects/mount-browse');
  });

  assert.deepEqual(paths, ['/mnt', null]);
});

test('a mount-browse request the client gives up on aborts the browse', { timeout: 5_000 }, async () => {
  let browseStarted = () => {};
  const started = new Promise<void>((resolve) => {
    browseStarted = resolve;
  });
  let browseEnded = () => {};
  const ended = new Promise<void>((resolve) => {
    browseEnded = resolve;
  });
  const dependencies = createDependencies({
    browseMountTargets: async (_inputPath, options) => {
      browseStarted();
      // Answers only once the request is closed.
      await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      browseEnded();
      return { path: '/mnt/nas', parent: '/mnt', directories: [] };
    },
  });

  await withMountsServer(dependencies, async (baseUrl) => {
    const client = new AbortController();
    const response = fetch(`${baseUrl}/api/projects/mount-browse?path=%2Fmnt%2Fnas`, { signal: client.signal });
    await started;
    client.abort();
    await assert.rejects(response);
    await ended;
  });
});

test('a refused mount answers with the service\'s code and status', async () => {
  const dependencies = createDependencies({
    createMount: async () => {
      throw new AppError('This folder cannot be mounted', { code: 'MOUNT_TARGET_FORBIDDEN', statusCode: 400 });
    },
    removeMount: async () => {
      throw new AppError('Mount not found', { code: 'MOUNT_NOT_FOUND', statusCode: 404 });
    },
  });

  await withMountsServer(dependencies, async (baseUrl) => {
    const created = await request(baseUrl, 'POST', '/api/projects/p-1/mounts', { name: 'etc', targetPath: '/etc' });
    assert.equal(created.status, 400);
    assert.equal((created.body.error as { code: string }).code, 'MOUNT_TARGET_FORBIDDEN');

    const removed = await request(baseUrl, 'DELETE', '/api/projects/p-1/mounts/nope');
    assert.equal(removed.status, 404);
    assert.equal((removed.body.error as { code: string }).code, 'MOUNT_NOT_FOUND');
  });
});
