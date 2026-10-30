import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type RequestHandler } from 'express';

import { createFileTreeRouter } from '@/modules/file-tree/file-tree.routes.js';
import type { FileTreeServices } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

function createFakeServices(overrides: Partial<FileTreeServices> = {}): FileTreeServices {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree service call');
  };

  return {
    browseWorkspace: unexpectedOperation,
    createWorkspaceFolder: unexpectedOperation,
    readTextFile: unexpectedOperation,
    openFile: unexpectedOperation,
    saveTextFile: unexpectedOperation,
    listProjectFiles: unexpectedOperation,
    searchProjectFiles: unexpectedOperation,
    createEntry: unexpectedOperation,
    renameEntry: unexpectedOperation,
    deleteEntry: unexpectedOperation,
    storeUploadedFiles: unexpectedOperation,
    ...overrides,
  };
}

const passUploadRequest: RequestHandler = (_request, _response, next) => next();

async function withFileTreeServer(
  services: FileTreeServices,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/file-tree', createFileTreeRouter(
    services,
    passUploadRequest,
    { maximumFileSizeMegabytes: 200, maximumFileCount: 20 },
    { error: () => undefined },
  ));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('project files route uses the File Tree API namespace and forwards the project id', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: false, markIgnored: false }]]);
});

test('project files route requests gitignore filtering when explicitly enabled', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files?respectGitignore=true`,
    );

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: true, markIgnored: false }]]);
});

test('project files route asks for gitignored entries to be marked when requested', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files?respectGitignore=true&markIgnored=true`,
    );

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: true, markIgnored: true }]]);
});

test('create route parses the transport payload before invoking the service', async () => {
  const inputs: Parameters<FileTreeServices['createEntry']>[0][] = [];
  const services = createFakeServices({
    createEntry: async (input) => {
      inputs.push(input);
      return {
        success: true,
        path: '/workspace/project/src/example.ts',
        name: input.name,
        type: input.type,
        message: 'File created successfully',
      };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: '/workspace/project/src',
        type: 'file',
        name: 'example.ts',
      }),
    });

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [{
    projectId: 'project-1',
    parentPath: '/workspace/project/src',
    type: 'file',
    name: 'example.ts',
  }]);
});

test('create route rejects invalid entry types without calling the service', async () => {
  let createCalled = false;
  const services = createFakeServices({
    createEntry: async () => {
      createCalled = true;
      throw new Error('createEntry should not run for invalid input');
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'link', name: 'example' }),
    });
    const payload = await response.json() as { error: string };

    assert.equal(response.status, 400);
    assert.equal(payload.error, 'Type must be "file" or "directory"');
  });

  assert.equal(createCalled, false);
});

test('file search route forwards the search as typed, the limit and the project id', async () => {
  const inputs: Array<[string, { query: string; limit: number }]> = [];
  const result = {
    files: [{ name: 'README.md', path: '/workspace/project/README.md', relativePath: 'README.md', isIgnored: false }],
    totalMatches: 1,
    incomplete: false,
  };
  const services = createFakeServices({
    searchProjectFiles: async (projectId, input) => {
      inputs.push([projectId, { query: input.query, limit: input.limit }]);
      return result;
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files/search?q=${encodeURIComponent(' read me ')}&limit=25`,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), result);
  });

  // Untrimmed: the palette scores what comes back against the same text.
  assert.deepEqual(inputs, [['project-1', { query: ' read me ', limit: 25 }]]);
});

test('file search route falls back to 100 results without a usable limit', async () => {
  const limits: number[] = [];
  const services = createFakeServices({
    searchProjectFiles: async (_projectId, input) => {
      limits.push(input.limit);
      return { files: [], totalMatches: 0, incomplete: false };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    for (const limit of ['', '&limit=0', '&limit=-3', '&limit=many']) {
      const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/search?q=readme${limit}`);
      assert.equal(response.status, 200, limit);
    }
  });

  assert.deepEqual(limits, [100, 100, 100, 100]);
});

test('file search route rejects a missing, blank or overlong search without calling the service', async () => {
  let searchCalled = false;
  const services = createFakeServices({
    searchProjectFiles: async () => {
      searchCalled = true;
      throw new Error('searchProjectFiles should not run for invalid input');
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const searches: Array<[string, string]> = [
      ['', 'Search query is required'],
      ['?q=', 'Search query is required'],
      ['?q=%20%20', 'Search query is required'],
      [`?q=${'a'.repeat(513)}`, 'Search query is too long'],
    ];
    for (const [search, message] of searches) {
      const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/search${search}`);
      const payload = await response.json() as { error: string };

      assert.equal(response.status, 400, search);
      assert.equal(payload.error, message, search);
    }
  });

  assert.equal(searchCalled, false);
});

test('file search route answers a service error with its status', async () => {
  const services = createFakeServices({
    searchProjectFiles: async () => {
      throw new AppError('Project not found', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/missing/files/search?q=readme`);

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Project not found', code: 'PROJECT_NOT_FOUND' });
  });
});

test('file read route answers a file too large to open with 413, its code and the sizes', async () => {
  const services = createFakeServices({
    readTextFile: async () => {
      throw new AppError('File is too large to open', {
        code: 'FILE_TOO_LARGE',
        statusCode: 413,
        details: { size: 20_000_000, limit: 10_485_760 },
      });
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/file?filePath=big.log`);

    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), {
      error: 'File is too large to open',
      code: 'FILE_TOO_LARGE',
      details: { size: 20_000_000, limit: 10_485_760 },
    });
  });
});

test('rename and delete routes answer a protected mount with 403 MOUNT_PROTECTED', async () => {
  const protectedError = () => new AppError('Mounted folders cannot be renamed or deleted here; unmount them instead', {
    code: 'MOUNT_PROTECTED',
    statusCode: 403,
  });
  const services = createFakeServices({
    renameEntry: async () => {
      throw protectedError();
    },
    deleteEntry: async () => {
      throw protectedError();
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const renamed = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/rename`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oldPath: 'mounts/data', newName: 'other' }),
    });
    assert.equal(renamed.status, 403);
    assert.equal((await renamed.json() as { code: string }).code, 'MOUNT_PROTECTED');

    const deleted = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'mounts/data' }),
    });
    assert.equal(deleted.status, 403);
    assert.equal((await deleted.json() as { code: string }).code, 'MOUNT_PROTECTED');
  });
});

test('file search route stops the walk when the browser drops the request', async () => {
  let signal: AbortSignal | undefined;
  let markSearchStarted: () => void = () => undefined;
  const searchStarted = new Promise<void>((resolve) => {
    markSearchStarted = resolve;
  });
  let finishSearch: () => void = () => undefined;
  const services = createFakeServices({
    searchProjectFiles: (_projectId, input) => {
      signal = input.signal;
      markSearchStarted();
      return new Promise((resolve) => {
        finishSearch = () => resolve({ files: [], totalMatches: 0, incomplete: true });
      });
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    // A plain request rather than fetch, whose connection pool would hold the
    // server open for its keep-alive timeout after the abort.
    const request = http.get(`${baseUrl}/api/file-tree/projects/project-1/files/search?q=readme`);
    request.on('error', () => undefined);
    await searchStarted;
    assert.equal(signal?.aborted, false);

    request.destroy();
    await waitUntil(() => signal?.aborted === true);
    // The walk returns what it found; nothing is written to the closed connection.
    finishSearch();
  });

  assert.equal(signal?.aborted, true);
});

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
