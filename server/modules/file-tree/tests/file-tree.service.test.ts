import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import type {
  FileTreeDirectoryEntry,
  FileTreeFileSystem,
  FileTreeMountsGateway,
  FileTreeNode,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeStats,
  ProjectMount,
} from '@/shared/types.js';
import { AppError, resolveReadOnlyRootPath, validateWorkspacePath } from '@/shared/utils.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

function createDirectoryEntry(name: string, directory: boolean): FileTreeDirectoryEntry {
  return {
    name,
    isDirectory: () => directory,
  };
}

/**
 * Adapts a path-keyed listing to the streaming directory contract so tests keep
 * describing directories as plain arrays.
 */
function createDirectoryReader(
  listDirectory: (directoryPath: string) => FileTreeDirectoryEntry[],
): FileTreeFileSystem['openDirectory'] {
  return async function* openDirectory(directoryPath) {
    yield* listDirectory(directoryPath);
  };
}

function createStats(directory: boolean, mode: number): FileTreeStats {
  return {
    size: directory ? 0 : 24,
    mtime: new Date('2026-01-02T03:04:05.000Z'),
    mode,
    isDirectory: () => directory,
    isSymbolicLink: () => false,
  };
}

function createFakeFileSystem(
  overrides: Partial<FileTreeFileSystem> = {},
): FileTreeFileSystem {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree filesystem operation');
  };

  const fileSystem: FileTreeFileSystem = {
    access: unexpectedOperation,
    stat: unexpectedOperation,
    lstat: unexpectedOperation,
    openDirectory: () => ({
      [Symbol.asyncIterator]: () => ({ next: unexpectedOperation }),
    }),
    // The names the directory stream lists, unless a test reads them its own way.
    readDirectoryNames: async (directoryPath) => {
      const names: string[] = [];
      for await (const entry of fileSystem.openDirectory(directoryPath)) {
        names.push(entry.name);
      }
      return names;
    },
    realpath: unexpectedOperation,
    readTextFile: unexpectedOperation,
    writeTextFile: unexpectedOperation,
    makeDirectory: unexpectedOperation,
    rename: unexpectedOperation,
    removeDirectory: unexpectedOperation,
    unlink: unexpectedOperation,
    copyFile: unexpectedOperation,
    createReadStream: () => Readable.from([]),
    ...overrides,
  };
  return fileSystem;
}

/**
 * Runs a call in a mount at once, as the projects module's mount gate does
 * for a network share that answers.
 */
const runMountCallsDirectly: FileTreeMountsGateway['runInMountTarget'] = async (_realPath, operation) => {
  try {
    return { kind: 'done', value: await operation({ gated: true }) };
  } catch (error) {
    return { kind: 'failed', error };
  }
};

/** Runs a call in a mount at once, as the mount gate does for a local disk, which it does not time. */
const runMountCallsOnLocalDisk: FileTreeMountsGateway['runInMountTarget'] = async (_realPath, operation) => {
  try {
    return { kind: 'done', value: await operation({ gated: false }) };
  } catch (error) {
    return { kind: 'failed', error };
  }
};

// Every filesystem answers, as far as the mount gate knows.
const noShareHangs: FileTreeMountsGateway['isShareUnreachable'] = async () => false;

// A project without mounts, which is what every test that does not set any up runs with.
const noMounts: FileTreeMountsGateway = {
  directoryName: 'mounts',
  listProjectMounts: async () => [],
  runInMountTarget: runMountCallsDirectly,
  isShareUnreachable: noShareHangs,
};

function createDependencies(
  fileSystem: FileTreeFileSystem,
  projectRoot: string,
): FileTreeServiceDependencies {
  return {
    fileSystem,
    projects: {
      getProjectPathById: async () => projectRoot,
    },
    mounts: noMounts,
    workspace: {
      rootPath: projectRoot,
      validatePath: async (candidatePath) => ({ valid: true, resolvedPath: candidatePath }),
      resolveReadOnlyRootPath: async () => null,
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
    // Time stands still unless a test moves it.
    now: () => 0,
  };
}

test('listProjectFiles applies gitignore alongside hard directory exclusions', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const documentationDirectory = path.join(projectRoot, 'docs');
  const buildDocumentationDirectory = path.join(documentationDirectory, 'build');
  const gitDirectory = path.join(projectRoot, '.git');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const sourceDirectory = path.join(projectRoot, 'src');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return '*.log';
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.git', true),
          createDirectoryEntry('node_modules', true),
          createDirectoryEntry('README.md', false),
          createDirectoryEntry('docs', true),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === documentationDirectory) {
        return [createDirectoryEntry('build', true)];
      }
      if (directoryPath === buildDocumentationDirectory) {
        return [createDirectoryEntry('foo.md', false)];
      }
      if (directoryPath === sourceDirectory) {
        return [createDirectoryEntry('index.ts', false)];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(
      candidatePath === documentationDirectory
        || candidatePath === buildDocumentationDirectory
        || candidatePath === sourceDirectory
        || candidatePath === gitDirectory
        || candidatePath === nodeModulesDirectory,
      0o754,
    ),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['docs', 'src', 'README.md']);
  const documentationEntry = tree[0];
  assert.deepEqual(documentationEntry?.children?.map((entry) => entry.name), ['build']);
  assert.deepEqual(documentationEntry?.children?.[0]?.children?.map((entry) => entry.name), ['foo.md']);
  const sourceEntry = tree[1];
  assert.ok(sourceEntry);
  assert.equal(sourceEntry.type, 'directory');
  assert.equal(sourceEntry.permissions, '754');
  assert.equal(sourceEntry.permissionsRwx, 'rwxr-xr--');
  assert.deepEqual(sourceEntry.children?.map((entry) => entry.name), ['index.ts']);
  assert.equal(readDirectories.includes(gitDirectory), false);
  assert.equal(readDirectories.includes(nodeModulesDirectory), false);
});

test('listProjectFiles excludes gitignored entries only when requested', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const cacheDirectory = path.join(projectRoot, 'cache');
  const sourceDirectory = path.join(projectRoot, 'src');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return ['*.log', '!keep.log', 'cache/', 'src/generated.ts'].join('\n');
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.gitignore', false),
          createDirectoryEntry('cache', true),
          createDirectoryEntry('ignored.log', false),
          createDirectoryEntry('keep.log', false),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === cacheDirectory) {
        return [createDirectoryEntry('cached.txt', false)];
      }
      if (directoryPath === sourceDirectory) {
        return [
          createDirectoryEntry('generated.ts', false),
          createDirectoryEntry('index.ts', false),
        ];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(
      candidatePath === cacheDirectory || candidatePath === sourceDirectory,
      0o644,
    ),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['src', '.gitignore', 'keep.log']);
  assert.deepEqual(tree[0]?.children?.map((entry) => entry.name), ['index.ts']);
  assert.equal(readDirectories.includes(cacheDirectory), false);
});

test('listProjectFiles falls back to conventional directory names when no gitignore exists', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const documentationDirectory = path.join(projectRoot, 'docs');
  const buildDocumentationDirectory = path.join(documentationDirectory, 'build');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('debug.log', false),
          createDirectoryEntry('docs', true),
          createDirectoryEntry('node_modules', true),
        ];
      }
      if (directoryPath === documentationDirectory) {
        return [
          createDirectoryEntry('build', true),
          createDirectoryEntry('guide.md', false),
        ];
      }
      if (directoryPath === buildDocumentationDirectory) {
        return [createDirectoryEntry('generated.md', false)];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(candidatePath === documentationDirectory, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['docs', 'debug.log']);
  assert.deepEqual(tree[0]?.children?.map((entry) => entry.name), ['guide.md']);
  assert.equal(readDirectories.includes(nodeModulesDirectory), false);
  assert.equal(readDirectories.includes(buildDocumentationDirectory), false);
});

test('listProjectFiles rejects a tree that exceeds the server entry limit', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader((directoryPath) => directoryPath === projectRoot
      ? Array.from({ length: 10_001 }, (_, index) => createDirectoryEntry(`file-${index}.txt`, false))
      : []),
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
});

test('listProjectFiles abandons a directory stream as soon as the entry limit is passed', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  let streamedEntries = 0;
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    // Endless on purpose: the walk has to stop consuming the stream itself
    // instead of waiting for the directory listing to be materialized.
    openDirectory: async function* (directoryPath) {
      if (directoryPath !== projectRoot) {
        return;
      }
      for (let index = 0; ; index += 1) {
        streamedEntries += 1;
        yield createDirectoryEntry(`file-${index}.txt`, false);
      }
    },
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
  // The budget plus the single entry that proves it was exceeded.
  assert.equal(streamedEntries, 10_001);
});

test('listProjectFiles shares the entry limit across nested directories', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const firstDirectory = path.join(projectRoot, 'first');
  const secondDirectory = path.join(projectRoot, 'second');
  const directoryPaths = new Set([firstDirectory, secondDirectory]);
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader((directoryPath) => {
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('first', true),
          createDirectoryEntry('second', true),
        ];
      }
      if (directoryPaths.has(directoryPath)) {
        return Array.from(
          { length: 5_000 },
          (_, index) => createDirectoryEntry(`${path.basename(directoryPath)}-${index}.txt`, false),
        );
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(directoryPaths.has(candidatePath), 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
});

test('listProjectFiles marks gitignored entries without walking them', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const sourceDirectory = path.join(projectRoot, 'src');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return ['CLAUDE.md', '.claude/', 'dist/', '*.log', '!keep.log', 'src/generated.ts', 'node_modules/'].join('\n');
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          ...['.git', 'node_modules', '.claude', 'dist', 'src'].map((name) => createDirectoryEntry(name, true)),
          ...['AGENTS.md', 'CLAUDE.md', 'debug.log', 'keep.log'].map((name) => createDirectoryEntry(name, false)),
        ];
      }
      if (directoryPath === sourceDirectory) {
        return [
          createDirectoryEntry('generated.ts', false),
          createDirectoryEntry('index.ts', false),
        ];
      }
      return [];
    }),
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true, markIgnored: true });

  // dist/ matches too, but a build folder stays hidden; .git and node_modules always do.
  assert.deepEqual(tree.map((entry) => entry.name), ['.claude', 'src', 'AGENTS.md', 'CLAUDE.md', 'debug.log', 'keep.log']);
  assert.deepEqual(
    tree.filter((entry) => entry.isIgnored === true).map((entry) => entry.name),
    ['.claude', 'CLAUDE.md', 'debug.log'],
  );
  // The other entries do not carry the field at all.
  assert.deepEqual(
    tree.filter((entry) => 'isIgnored' in entry).map((entry) => entry.name),
    ['.claude', 'CLAUDE.md', 'debug.log'],
  );
  assert.equal(tree[0]?.children, undefined);
  for (const closedDirectory of ['.claude', 'dist', 'node_modules', '.git']) {
    assert.equal(
      readDirectories.includes(path.join(projectRoot, closedDirectory)),
      false,
      `${closedDirectory} must not be read`,
    );
  }
  assert.deepEqual(
    tree[1]?.children?.map((entry) => [entry.name, entry.isIgnored]),
    [['generated.ts', true], ['index.ts', undefined]],
  );
});

test('listProjectFiles caps ignored entries without a 413', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async () => '*.o',
    // Ignored entries come first, so charging them to the visible budget
    // would push the 10,000 visible files over the limit.
    openDirectory: createDirectoryReader((directoryPath) => directoryPath === projectRoot
      ? [
          ...Array.from({ length: 3_000 }, (_, index) => createDirectoryEntry(`object-${index}.o`, false)),
          ...Array.from({ length: 10_000 }, (_, index) => createDirectoryEntry(`file-${index}.txt`, false)),
        ]
      : []),
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true, markIgnored: true });

  assert.equal(tree.length, 12_000);
  assert.equal(tree.filter((entry) => entry.isIgnored === true).length, 2_000);
});

test('browseWorkspace still hides build folders', async () => {
  const workspaceRoot = path.resolve('file-tree-test-workspace');
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    stat: async () => createStats(true, 0o755),
    realpath: async (candidatePath) => candidatePath,
    openDirectory: createDirectoryReader((directoryPath) => directoryPath === workspaceRoot
      ? [
          createDirectoryEntry('dist', true),
          createDirectoryEntry('node_modules', true),
          createDirectoryEntry('src', true),
        ]
      : []),
    lstat: async () => createStats(true, 0o755),
  });
  const service = createFileTreeService(createDependencies(fileSystem, workspaceRoot));

  const browsed = await service.browseWorkspace(workspaceRoot);

  assert.deepEqual(browsed.suggestions.map((entry) => entry.name), ['src']);
});

test('readTextFile rejects traversal before invoking the filesystem adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const readPaths: string[] = [];
  const fileSystem = createFakeFileSystem({
    readTextFile: async (filePath) => {
      readPaths.push(filePath);
      return 'should not be read';
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', '../secret.txt'),
    (error: unknown) => error instanceof AppError
      && error.code === 'PATH_OUTSIDE_PROJECT'
      && error.statusCode === 403,
  );
  assert.deepEqual(readPaths, []);
});

test('readTextFile reports a directory as a client error, not a 500', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    stat: async () => createStats(true, 0o40755),
    readTextFile: async () => {
      const error = new Error('EISDIR: illegal operation on a directory, read');
      (error as NodeJS.ErrnoException).code = 'EISDIR';
      throw error;
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', 'decisions'),
    (error: unknown) => error instanceof AppError
      && error.code === 'EISDIR'
      && error.statusCode === 400
      && error.message === 'Path is a directory, not a file',
  );
});

test('createEntry performs filesystem mutation only through the injected adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const targetPath = path.join(projectRoot, 'notes.txt');
  const writtenFiles: Array<{ filePath: string; content: string }> = [];
  const fileSystem = createFakeFileSystem({
    access: async (candidatePath) => {
      if (candidatePath === targetPath) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
    },
    writeTextFile: async (filePath, content) => {
      writtenFiles.push({ filePath, content });
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const result = await service.createEntry({
    projectId: 'project-1',
    parentPath: projectRoot,
    type: 'file',
    name: 'notes.txt',
  });

  assert.equal(result.path, targetPath);
  assert.deepEqual(writtenFiles, [{ filePath: targetPath, content: '' }]);
});

test('storeUploadedFiles takes the project root itself as a target, however it is written', async () => {
  // A file dropped onto a top-level row of the tree is uploaded next to it, into the root: older
  // clients send the root's absolute path, which used to fail with a 403.
  const projectRoot = path.resolve('file-tree-test-project');
  const copiedFiles: Array<{ source: string; destination: string }> = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    copyFile: async (source, destination) => {
      copiedFiles.push({ source, destination });
    },
    unlink: async () => undefined,
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));
  const upload = (targetPath: string) => service.storeUploadedFiles({
    projectId: 'project-1',
    targetPath,
    relativePaths: ['notes.txt'],
    requestedFileCount: 1,
    files: [{ originalName: 'notes.txt', temporaryPath: '/uploads/tmp-1', size: 6, mimeType: 'text/plain' }],
  });

  for (const targetPath of [projectRoot, `${projectRoot}${path.sep}`, '', '.', './']) {
    copiedFiles.length = 0;
    const result = await upload(targetPath);
    assert.equal(result.targetPath, projectRoot, `target ${JSON.stringify(targetPath)}`);
    assert.equal(result.uploadedCount, 1, `target ${JSON.stringify(targetPath)}`);
    assert.deepEqual(copiedFiles, [{ source: '/uploads/tmp-1', destination: path.join(projectRoot, 'notes.txt') }]);
  }

  // Only the root itself is let through: its parent and a sibling sharing its name as a prefix stay outside.
  for (const targetPath of [path.dirname(projectRoot), `${projectRoot}-other`, '..']) {
    copiedFiles.length = 0;
    await assert.rejects(
      upload(targetPath),
      (error: unknown) => error instanceof AppError
        && error.code === 'PATH_OUTSIDE_PROJECT'
        && error.statusCode === 403,
      `target ${JSON.stringify(targetPath)}`,
    );
    assert.deepEqual(copiedFiles, []);
  }
});

/**
 * Builds the service against the real filesystem and the real workspace policy,
 * which is the only way to exercise the read-only roots: the whole guarantee
 * rests on `realpath` resolving symlinks before the comparison.
 */
function createRealFileSystemService(
  projectRoot: string,
  workspaceRoot = projectRoot,
  mounts: FileTreeMountsGateway = noMounts,
): FileTreeServices {
  return createFileTreeService({
    fileSystem: {
      access: (candidatePath) => fsPromises.access(candidatePath),
      stat: (candidatePath) => fsPromises.stat(candidatePath),
      lstat: (candidatePath) => fsPromises.lstat(candidatePath),
      openDirectory: async function* (directoryPath) {
        yield* await fsPromises.opendir(directoryPath);
      },
      readDirectoryNames: (directoryPath) => fsPromises.readdir(directoryPath),
      realpath: (candidatePath) => fsPromises.realpath(candidatePath),
      readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
      writeTextFile: (filePath, content) => fsPromises.writeFile(filePath, content, 'utf8'),
      async makeDirectory(directoryPath, recursive) {
        await fsPromises.mkdir(directoryPath, { recursive });
      },
      rename: (oldPath, newPath) => fsPromises.rename(oldPath, newPath),
      async removeDirectory(directoryPath) {
        await fsPromises.rm(directoryPath, { recursive: true, force: true });
      },
      unlink: (filePath) => fsPromises.unlink(filePath),
      copyFile: (source, destination) => fsPromises.copyFile(source, destination),
      createReadStream: (filePath) => createReadStream(filePath),
    },
    projects: { getProjectPathById: async () => projectRoot },
    mounts,
    workspace: {
      rootPath: workspaceRoot,
      validatePath: (candidatePath) => validateWorkspacePath(candidatePath),
      resolveReadOnlyRootPath: (candidatePath) => resolveReadOnlyRootPath(candidatePath),
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
    now: () => performance.now(),
  });
}

test('the temp directory can be browsed and read, but never written to', async () => {
  const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-tmp-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));

  try {
    // The shape a task notification quotes: an agent's output file written to
    // the system temp directory, outside every project.
    await fsPromises.mkdir(path.join(temporaryDirectory, 'tasks'));
    const outputPath = path.join(temporaryDirectory, 'tasks', 'agent.output');
    await fsPromises.writeFile(outputPath, 'what the agent found', 'utf8');

    const service = createRealFileSystemService(projectRoot);

    const browsed = await service.browseWorkspace(temporaryDirectory);
    assert.deepEqual(browsed.suggestions.map((entry) => entry.name), ['tasks']);

    const opened = await service.readTextFile('project-1', outputPath);
    assert.equal(opened.content, 'what the agent found');

    const streamed = await service.openFile('project-1', outputPath);
    streamed.stream.destroy();

    // Read-only means read-only: nothing may be created or changed there.
    await assert.rejects(
      service.saveTextFile('project-1', outputPath, 'overwritten'),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.createWorkspaceFolder(path.join(temporaryDirectory, 'new-folder')),
      (error: unknown) => (error as AppError).code === 'INVALID_WORKSPACE_PATH',
    );
    await assert.rejects(
      service.createEntry({
        projectId: 'project-1',
        parentPath: path.join(temporaryDirectory, 'tasks'),
        type: 'file',
        name: 'planted.txt',
      }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.renameEntry({ projectId: 'project-1', oldPath: outputPath, newName: 'renamed.output' }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    const uploadedTemporaryPath = path.join(projectRoot, 'upload.tmp');
    await fsPromises.writeFile(uploadedTemporaryPath, 'upload', 'utf8');
    await assert.rejects(
      service.storeUploadedFiles({
        projectId: 'project-1',
        targetPath: path.join(temporaryDirectory, 'tasks'),
        relativePaths: [],
        requestedFileCount: 1,
        files: [{ originalName: 'upload.txt', temporaryPath: uploadedTemporaryPath, size: 6, mimeType: 'text/plain' }],
      }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.deleteEntry({ projectId: 'project-1', targetPath: outputPath }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    assert.deepEqual(await fsPromises.readdir(path.join(temporaryDirectory, 'tasks')), ['agent.output']);
    assert.equal(await fsPromises.readFile(outputPath, 'utf8'), 'what the agent found');
  } finally {
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
  }
});

test('reading through a symlink out of the temp directory is still refused', async () => {
  const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-tmp-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));
  // The link target has to sit under no read-only root. Beside this file is
  // deterministic; a directory under `$HOME` lands under `/tmp` whenever a
  // test run isolates its home there, and the Claude projects directory is a
  // read-only root too.
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));

  try {
    assert.equal(await resolveReadOnlyRootPath(outsideDirectory), null);
    await fsPromises.writeFile(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');
    await fsPromises.symlink(outsideDirectory, path.join(temporaryDirectory, 'escape'));

    const service = createRealFileSystemService(projectRoot);
    await assert.rejects(
      service.readTextFile('project-1', path.join(temporaryDirectory, 'escape', 'secret.txt')),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
  } finally {
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
  }
});

test('a file in another folder of the workspace can be read, but never written to', async () => {
  // Both sit beside this file, outside every read-only root, for the reason
  // given in the symlink test above.
  const workspaceRoot = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-workspace-'));
  const projectRoot = path.join(workspaceRoot, 'project');
  const siblingDirectory = path.join(workspaceRoot, '.runs', 'run-1');
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));

  try {
    await fsPromises.mkdir(projectRoot);
    await fsPromises.mkdir(siblingDirectory, { recursive: true });
    const reportPath = path.join(siblingDirectory, 'report.md');
    await fsPromises.writeFile(reportPath, 'what the run found', 'utf8');
    await fsPromises.writeFile(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');
    await fsPromises.symlink(outsideDirectory, path.join(workspaceRoot, 'escape'));

    const service = createRealFileSystemService(projectRoot, workspaceRoot);

    const opened = await service.readTextFile('project-1', reportPath);
    assert.equal(opened.content, 'what the run found');
    const streamed = await service.openFile('project-1', reportPath);
    streamed.stream.destroy();

    await assert.rejects(
      service.saveTextFile('project-1', reportPath, 'overwritten'),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.deleteEntry({ projectId: 'project-1', targetPath: reportPath }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    assert.equal(await fsPromises.readFile(reportPath, 'utf8'), 'what the run found');

    // A link inside the workspace does not open what lies outside it.
    await assert.rejects(
      service.readTextFile('project-1', path.join(workspaceRoot, 'escape', 'secret.txt')),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
  } finally {
    await fsPromises.rm(workspaceRoot, { recursive: true, force: true });
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
  }
});

/**
 * The files the command palette collects from a listing, as its files source
 * does: one tree level at a time, each level in listing order.
 */
function collectPaletteFiles(tree: FileTreeNode[]): Array<[string, boolean]> {
  const files: Array<[string, boolean]> = [];
  let level = tree.map((node) => ({ node, relativePath: node.name }));
  while (level.length > 0) {
    const nextLevel: typeof level = [];
    for (const { node, relativePath } of level) {
      if (node.type === 'file') {
        files.push([relativePath, node.isIgnored === true]);
      } else {
        for (const child of node.children ?? []) {
          nextLevel.push({ node: child, relativePath: `${relativePath}/${child.name}` });
        }
      }
    }
    level = nextLevel;
  }
  return files;
}

/**
 * A fake filesystem serving a tree described as `relative/path/` (directory)
 * and `relative/path` (file) entries per directory, listed out of order on
 * purpose, plus the given `.gitignore`.
 */
function createTreeFileSystem(
  projectRoot: string,
  directories: Record<string, string[]>,
  gitignore: string | null,
  overrides: Partial<FileTreeFileSystem> = {},
): FileTreeFileSystem {
  return createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      if (gitignore === null) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return gitignore;
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      const relativeDirectory = path.relative(projectRoot, directoryPath).split(path.sep).join('/');
      return (directories[relativeDirectory] ?? []).map((name) => (
        createDirectoryEntry(name.replace(/\/$/, ''), name.endsWith('/'))
      ));
    }),
    lstat: async () => createStats(false, 0o644),
    ...overrides,
  });
}

// Every listing rule at once: always-hidden folders, gitignored files (listed,
// marked) and folders (listed, never walked), gitignored build folders and OS
// clutter (hidden), a negated pattern, and a chain deeper than a listing goes.
const SEARCH_TREE: Record<string, string[]> = {
  '': [
    'zebra.md', 'src/', 'CLAUDE.md', '.git/', 'node_modules/', '.claude/', 'dist/',
    'docs/', 'AGENTS.md', 'debug.log', 'keep.log', '.DS_Store', 'deep/',
  ],
  '.git': ['HEAD'],
  node_modules: ['left-pad.js'],
  '.claude': ['settings.json'],
  dist: ['bundle.js'],
  src: ['index.ts', 'components/', 'generated.ts'],
  'src/components': ['Button.tsx', '.DS_Store', 'Alert.tsx'],
  docs: ['guide.md'],
  ...Object.fromEntries(Array.from({ length: 12 }, (_, depth) => {
    const directory = ['deep', ...Array.from({ length: depth }, (_unused, index) => `d${index + 1}`)].join('/');
    return [directory, [`level-${depth + 1}.txt`, `d${depth + 1}/`]];
  })),
};

const SEARCH_GITIGNORE = ['CLAUDE.md', '.claude/', 'dist/', '*.log', '!keep.log', 'src/generated.ts', '.DS_Store'].join('\n');

test('searchProjectFiles finds the files the palette lists, in listing order on equal scores', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const readDirectories: string[] = [];
  const fileSystem = createTreeFileSystem(projectRoot, SEARCH_TREE, SEARCH_GITIGNORE);
  const listDirectory = fileSystem.openDirectory;
  fileSystem.openDirectory = (directoryPath) => {
    readDirectories.push(path.relative(projectRoot, directoryPath).split(path.sep).join('/'));
    return listDirectory(directoryPath);
  };
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const listed = collectPaletteFiles(
    await service.listProjectFiles('project-1', { respectGitignore: true, markIgnored: true }),
  );
  readDirectories.length = 0;
  // The root itself, as a pasted path: read relative to the root it is empty, so every file
  // matches alike and the order left is the listing's.
  const found = await service.searchProjectFiles('project-1', { query: `${projectRoot}${path.sep}`, limit: 200 });

  assert.deepEqual(found.files.map((file) => [file.relativePath, file.isIgnored]), listed);
  assert.equal(found.totalMatches, listed.length);
  assert.equal(found.incomplete, false);
  // Spot checks of the rules both apply.
  assert.deepEqual(listed.slice(0, 5), [
    ['AGENTS.md', false], ['CLAUDE.md', true], ['debug.log', true], ['keep.log', false], ['zebra.md', false],
  ]);
  // Ten levels below the root, and no deeper.
  assert.equal(listed.some(([relativePath]) => relativePath === 'deep/d1/d2/d3/d4/d5/d6/d7/d8/d9/level-10.txt'), true);
  assert.equal(listed.some(([relativePath]) => relativePath.includes('level-11')), false);
  for (const closedDirectory of ['.git', 'node_modules', '.claude', 'dist', 'deep/d1/d2/d3/d4/d5/d6/d7/d8/d9/d10']) {
    assert.equal(readDirectories.includes(closedDirectory), false, `${closedDirectory} must not be read`);
  }
  // Every file comes with its absolute path, spelled as the listing spells it.
  assert.equal(found.files[0]?.path, path.join(projectRoot, 'AGENTS.md'));
  assert.equal(found.files[0]?.name, 'AGENTS.md');
});

test('searchProjectFiles hides the conventional build folders when the project has no gitignore', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createTreeFileSystem(projectRoot, {
    '': ['build/', 'docs/', 'debug.log', 'node_modules/'],
    build: ['notes-generated.md'],
    docs: ['notes.md'],
    node_modules: ['notes.js'],
  }, null);
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const found = await service.searchProjectFiles('project-1', { query: 'notes', limit: 10 });

  assert.deepEqual(found.files.map((file) => file.relativePath), ['docs/notes.md']);
});

test('searchProjectFiles ranks the best matches first, breaks ties in listing order and returns the best few', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createTreeFileSystem(projectRoot, {
    '': ['b/', 'a/', 'bx.md', 'x.md', 'ax.md'],
    a: ['x.md', 'c/'],
    b: ['x.md'],
    'a/c': ['x.md'],
  }, null);
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const found = await service.searchProjectFiles('project-1', { query: 'x.md', limit: 5 });

  // The exact name scores best. a/x.md, b/x.md and a/c/x.md tie: the shallower
  // two first, a before b as listed. ax.md and bx.md tie lower down, in listing
  // order, and the limit cuts bx.md.
  assert.deepEqual(found.files.map((file) => file.relativePath), ['x.md', 'a/x.md', 'b/x.md', 'a/c/x.md', 'ax.md']);
  assert.equal(found.totalMatches, 6);
  assert.equal(found.incomplete, false);
});

test('searchProjectFiles returns at most 200 files whatever the limit asked for', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createTreeFileSystem(projectRoot, {
    '': Array.from({ length: 300 }, (_, index) => `file-${index}.txt`),
  }, null);
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const found = await service.searchProjectFiles('project-1', { query: 'file', limit: 1_000 });

  assert.equal(found.files.length, 200);
  assert.equal(found.totalMatches, 300);
});

test('searchProjectFiles stops at its entry limit, keeps what it found and says it is incomplete', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  let streamedEntries = 0;
  const fileSystem = createTreeFileSystem(projectRoot, {}, null, {
    // More than the limit, but finite, so a walk that ignored the limit would
    // finish with a complete result instead of hanging.
    openDirectory: async function* (directoryPath) {
      if (directoryPath !== projectRoot) {
        return;
      }
      for (let index = 0; index < 100_050; index += 1) {
        streamedEntries += 1;
        yield createDirectoryEntry(`file-${index}.txt`, false);
      }
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const found = await service.searchProjectFiles('project-1', { query: 'file', limit: 5 });

  assert.equal(found.incomplete, true);
  // The limit, plus the single entry that proves it was reached.
  assert.equal(streamedEntries, 100_001);
  assert.equal(found.totalMatches, 100_000);
  // All score alike, so they come in listing order.
  assert.deepEqual(found.files.map((file) => file.relativePath), [
    'file-0.txt', 'file-1.txt', 'file-10.txt', 'file-100.txt', 'file-1000.txt',
  ]);
});

test('searchProjectFiles shares its entry limit across directories', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  let streamedEntries = 0;
  const fileSystem = createTreeFileSystem(projectRoot, {}, null, {
    openDirectory: async function* (directoryPath) {
      if (directoryPath === projectRoot) {
        streamedEntries += 2;
        yield createDirectoryEntry('first', true);
        yield createDirectoryEntry('second', true);
        return;
      }
      for (let index = 0; index < 60_000; index += 1) {
        streamedEntries += 1;
        yield createDirectoryEntry(`${path.basename(directoryPath)}-${index}.txt`, false);
      }
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const found = await service.searchProjectFiles('project-1', { query: 'txt', limit: 5 });

  assert.equal(found.incomplete, true);
  // The limit, plus one entry for each of the two directories still being read.
  assert.equal(streamedEntries <= 100_002, true, `${streamedEntries} entries read`);
  assert.equal(found.totalMatches, 99_998);
});

test('searchProjectFiles reports a project that just fits its entry limit as complete', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createTreeFileSystem(projectRoot, {
    '': Array.from({ length: 100_000 }, (_, index) => `file-${index}.txt`),
  }, null);
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const found = await service.searchProjectFiles('project-1', { query: 'file-99999', limit: 1 });

  assert.equal(found.incomplete, false);
  assert.deepEqual(found.files.map((file) => file.relativePath), ['file-99999.txt']);
});

test('searchProjectFiles stops at its time limit and returns what it found', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  let clock = 1_000_000;
  let streamedEntries = 0;
  const fileSystem = createTreeFileSystem(projectRoot, {}, null, {
    // Every entry takes a millisecond to read.
    openDirectory: async function* (directoryPath) {
      if (directoryPath !== projectRoot) {
        return;
      }
      for (let index = 0; index < 5_000; index += 1) {
        clock += 1;
        streamedEntries += 1;
        yield createDirectoryEntry(`file-${index}.txt`, false);
      }
    },
  });
  const service = createFileTreeService({ ...createDependencies(fileSystem, projectRoot), now: () => clock });

  const found = await service.searchProjectFiles('project-1', { query: 'file', limit: 3 });

  assert.equal(found.incomplete, true);
  // Two seconds in, the entry that arrives stops the walk.
  assert.equal(streamedEntries, 2_000);
  assert.equal(found.totalMatches, 1_999);
  assert.deepEqual(found.files.map((file) => file.relativePath), ['file-0.txt', 'file-1.txt', 'file-10.txt']);
});

test('searchProjectFiles says it is incomplete when its time runs out between reading a file and scoring it', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  let clock = 0;
  const fileSystem = createTreeFileSystem(projectRoot, {}, null, {
    openDirectory: async function* (directoryPath) {
      if (directoryPath !== projectRoot) {
        return;
      }
      // Telling what the first entry is takes the rest of the time, as other reads scoring their
      // files would: the read has checked the clock and hands the file over, and only the check
      // before scoring it sees that time is up. The last directory of the last level, so no
      // other read is left to notice.
      yield {
        name: 'notes.txt',
        isDirectory: () => {
          clock += 5_000;
          return false;
        },
      };
      yield createDirectoryEntry('todo.txt', false);
    },
  });
  const service = createFileTreeService({ ...createDependencies(fileSystem, projectRoot), now: () => clock });

  const found = await service.searchProjectFiles('project-1', { query: 'txt', limit: 5 });

  assert.equal(found.totalMatches, 0);
  assert.equal(found.incomplete, true);
});

test('searchProjectFiles does not open the next level once its time is up', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  let clock = 0;
  const readDirectories: string[] = [];
  const fileSystem = createTreeFileSystem(projectRoot, {}, null, {
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      // Reading the root takes the whole time limit.
      clock += 2_000;
      return directoryPath === projectRoot
        ? [createDirectoryEntry('src', true), createDirectoryEntry('README.md', false)]
        : [createDirectoryEntry('index.ts', false)];
    }),
  });
  const service = createFileTreeService({ ...createDependencies(fileSystem, projectRoot), now: () => clock });

  const found = await service.searchProjectFiles('project-1', { query: 'e', limit: 10 });

  assert.equal(found.incomplete, true);
  assert.deepEqual(readDirectories, [projectRoot]);
});

test('searchProjectFiles stops as soon as its request is aborted', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const request = new AbortController();
  let streamedEntries = 0;
  const fileSystem = createTreeFileSystem(projectRoot, {}, null, {
    openDirectory: async function* (directoryPath) {
      if (directoryPath !== projectRoot) {
        return;
      }
      for (let index = 0; index < 1_000; index += 1) {
        if (index === 10) {
          request.abort();
        }
        streamedEntries += 1;
        yield createDirectoryEntry(`file-${index}.txt`, false);
      }
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const found = await service.searchProjectFiles('project-1', { query: 'file', limit: 5, signal: request.signal });

  assert.equal(found.incomplete, true);
  assert.equal(streamedEntries, 11);
  assert.equal(found.totalMatches, 10);
});

test('searchProjectFiles lets the rest of the server run while it works through a large directory', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createTreeFileSystem(projectRoot, {
    '': Array.from({ length: 5_000 }, (_, index) => `file-${index}.txt`),
  }, null);
  // A tenth of a millisecond passes every time the walk looks at the clock.
  let clock = 0;
  const service = createFileTreeService({ ...createDependencies(fileSystem, projectRoot), now: () => (clock += 0.1) });

  let searchFinished = false;
  let ranDuringSearch = false;
  setImmediate(() => {
    ranDuringSearch = !searchFinished;
  });
  const found = await service.searchProjectFiles('project-1', { query: 'file', limit: 5 });
  searchFinished = true;

  assert.equal(ranDuringSearch, true);
  // Pausing costs the walk nothing it finds.
  assert.equal(found.incomplete, false);
  assert.equal(found.totalMatches, 5_000);
});

test('searchProjectFiles lets the rest of the server run while it reads entries it does not score', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  // Gitignored folders are listed but neither scored nor walked.
  const fileSystem = createTreeFileSystem(projectRoot, {
    '': Array.from({ length: 5_000 }, (_, index) => `out-${index}/`),
  }, 'out-*/');
  let clock = 0;
  const service = createFileTreeService({ ...createDependencies(fileSystem, projectRoot), now: () => (clock += 0.1) });

  let searchFinished = false;
  let ranDuringSearch = false;
  setImmediate(() => {
    ranDuringSearch = !searchFinished;
  });
  const found = await service.searchProjectFiles('project-1', { query: 'out', limit: 5 });
  searchFinished = true;

  assert.equal(ranDuringSearch, true);
  assert.equal(found.incomplete, false);
  assert.equal(found.totalMatches, 0);
});

test('searchProjectFiles scores no file once it hears that its request was aborted', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const request = new AbortController();
  const directoryNames = Array.from({ length: 16 }, (_, index) => `d${index}`);
  const fileSystem = createTreeFileSystem(projectRoot, {
    '': directoryNames.map((name) => `${name}/`),
    ...Object.fromEntries(directoryNames.map((name) => [
      name,
      Array.from({ length: 100 }, (_, index) => `file-${index}.txt`),
    ])),
  }, null);
  // A file counts as dealt with once the search asks for the next entry.
  let filesDoneAfterAbort = 0;
  const listDirectory = fileSystem.openDirectory;
  fileSystem.openDirectory = async function* (directoryPath) {
    for await (const entry of listDirectory(directoryPath)) {
      yield entry;
      if (!entry.isDirectory() && request.signal.aborted) {
        filesDoneAfterAbort += 1;
      }
    }
  };
  let clock = 0;
  const service = createFileTreeService({
    ...createDependencies(fileSystem, projectRoot),
    fileSystemConcurrency: 16,
    now: () => (clock += 0.1),
  });

  // Aborted a few turns in, while every directory's read waits for its next slice.
  let turns = 0;
  const abortLater = () => {
    turns += 1;
    if (turns === 5) {
      request.abort();
    } else {
      setImmediate(abortLater);
    }
  };
  setImmediate(abortLater);
  const found = await service.searchProjectFiles('project-1', { query: 'file', limit: 5, signal: request.signal });

  assert.equal(found.incomplete, true);
  assert.equal(found.totalMatches > 0, true, 'the walk was under way');
  assert.equal(filesDoneAfterAbort, 0);
});

test('searchProjectFiles scores for one slice at a time, however many directories it reads at once', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const directoryNames = Array.from({ length: 64 }, (_, index) => `d${index}`);
  // Names that take the real scorer milliseconds each against the search below, though well
  // under its step limit.
  const costlyNames = [0, 1].map((index) => `e-${'e'.repeat(160)}-${index}.txt`);
  const fileSystem = createTreeFileSystem(projectRoot, {
    '': directoryNames.map((name) => `${name}/`),
    ...Object.fromEntries(directoryNames.map((name) => [name, costlyNames])),
  }, null);
  // A file counts as dealt with once the search asks for the next entry.
  let filesDone = 0;
  const listDirectory = fileSystem.openDirectory;
  fileSystem.openDirectory = async function* (directoryPath) {
    for await (const entry of listDirectory(directoryPath)) {
      yield entry;
      if (!entry.isDirectory()) {
        filesDone += 1;
      }
    }
  };
  const service = createFileTreeService({
    ...createDependencies(fileSystem, projectRoot),
    // All 64 directories are read at once.
    fileSystemConcurrency: 64,
    now: () => performance.now(),
  });

  // The most files the search deals with between two turns of the event loop.
  let searching = true;
  let doneByLastTurn = 0;
  let mostDoneInOneTurn = 0;
  const countTurn = () => {
    mostDoneInOneTurn = Math.max(mostDoneInOneTurn, filesDone - doneByLastTurn);
    doneByLastTurn = filesDone;
    if (searching) {
      setImmediate(countTurn);
    }
  };
  setImmediate(countTurn);
  const found = await service.searchProjectFiles('project-1', { query: 'eeeeeeeeee', limit: 5 });
  searching = false;
  // And since the last turn.
  countTurn();

  assert.equal(found.totalMatches > 0, true);
  // A slice of 10ms fits a few of these files. Reads that all went on after a
  // pause would deal with a file each, 64 in one turn.
  assert.equal(mostDoneInOneTurn <= 32, true, `${mostDoneInOneTurn} files in one turn`);
});

test('searchProjectFiles stops when its request is aborted while it works through a large directory', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const request = new AbortController();
  const fileSystem = createTreeFileSystem(projectRoot, {
    '': Array.from({ length: 5_000 }, (_, index) => `file-${index}.txt`),
  }, null);
  let clock = 0;
  const service = createFileTreeService({ ...createDependencies(fileSystem, projectRoot), now: () => (clock += 0.1) });

  // The browser gives up on the request; the server hears of it the next time it gets to run.
  setImmediate(() => {
    request.abort();
  });
  const found = await service.searchProjectFiles('project-1', { query: 'file', limit: 5, signal: request.signal });

  assert.equal(found.incomplete, true);
  // Neither the entry limit nor the time limit stops it before the 5,000 entries are read.
  assert.equal(found.totalMatches < 1_000, true, `${found.totalMatches} matches`);
});

test('searchProjectFiles breaks ties between the files of a directory in listing order', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  // Listed out of order, and named so that sorting by code unit would order them differently.
  const fileSystem = createTreeFileSystem(projectRoot, {
    '': ['b.md', 'B.md', 'Ä.md', 'src/', 'a.md', '_x.md', '10.md', '9.md', 'é.md', 'e.md', 'Lib/', 'lib/'],
    src: ['b.ts', 'A.ts', 'a.ts'],
    Lib: ['z.md'],
    lib: ['z.md'],
  }, null);
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const listed = collectPaletteFiles(
    await service.listProjectFiles('project-1', { respectGitignore: true, markIgnored: true }),
  );
  // The root itself as the search: every file matches alike.
  const found = await service.searchProjectFiles('project-1', { query: `${projectRoot}${path.sep}`, limit: 200 });

  assert.deepEqual(found.files.map((file) => [file.relativePath, file.isIgnored]), listed);
  assert.deepEqual(listed.slice(0, 3), [['_x.md', false], ['10.md', false], ['9.md', false]]);
});

test('searchProjectFiles answers a project it cannot find with a 404', async () => {
  const fileSystem = createFakeFileSystem();
  const service = createFileTreeService({
    ...createDependencies(fileSystem, path.resolve('file-tree-test-project')),
    projects: { getProjectPathById: async () => null },
  });

  await assert.rejects(
    service.searchProjectFiles('missing', { query: 'readme', limit: 10 }),
    (error: unknown) => error instanceof AppError
      && error.code === 'PROJECT_NOT_FOUND'
      && error.statusCode === 404,
  );
});

test('searchProjectFiles stays inside the project and does not follow a symlink out of it', async () => {
  // Both sit beside this file, outside every read-only root, as in the symlink tests above.
  const projectRoot = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-search-'));
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));

  try {
    await fsPromises.mkdir(path.join(projectRoot, 'docs'));
    await fsPromises.writeFile(path.join(projectRoot, 'docs', 'notes.md'), 'inside', 'utf8');
    await fsPromises.writeFile(path.join(outsideDirectory, 'secret-notes.md'), 'outside', 'utf8');
    await fsPromises.symlink(outsideDirectory, path.join(projectRoot, 'linked-notes'));

    const service = createRealFileSystemService(projectRoot);
    const found = await service.searchProjectFiles('project-1', { query: 'notes', limit: 10 });

    // The link is a file to the palette, as in a listing; what it points to is not walked.
    assert.deepEqual(found.files.map((file) => file.relativePath).sort(), ['docs/notes.md', 'linked-notes']);
    for (const file of found.files) {
      assert.equal(file.path.startsWith(`${projectRoot}${path.sep}`), true, file.path);
    }
    assert.equal(found.incomplete, false);
  } finally {
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
  }
});

/**
 * A project beside this file with one registered mount, `mounts/data`, linked
 * the way the projects module links it (sentinel included) to a folder that
 * is outside the project, the workspace root and every read-only root.
 */
async function withMountedProject(
  run: (fixture: {
    projectRoot: string;
    targetRoot: string;
    linkPath: string;
    mount: ProjectMount;
    mountsGateway: FileTreeMountsGateway;
  }) => Promise<void>,
): Promise<void> {
  const projectRoot = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-mount-project-'));
  const targetRoot = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-mount-target-'));
  try {
    await fsPromises.mkdir(path.join(projectRoot, 'mounts'));
    await fsPromises.writeFile(path.join(projectRoot, 'mounts', '.gitignore'), '# CloudCLI mounts: never committed\n*\n');
    const linkPath = path.join(projectRoot, 'mounts', 'data');
    await fsPromises.symlink(targetRoot, linkPath, 'dir');
    const mount: ProjectMount = {
      mountId: 'mount-1',
      name: 'data',
      linkPath: 'mounts/data',
      targetPath: targetRoot,
      realTargetPath: await fsPromises.realpath(targetRoot),
      status: 'ok',
      createdAt: '2026-10-30T00:00:00.000Z',
    };
    const mountsGateway: FileTreeMountsGateway = {
      directoryName: 'mounts',
      listProjectMounts: async () => [mount],
      runInMountTarget: runMountCallsDirectly,
      isShareUnreachable: noShareHangs,
    };
    await run({ projectRoot, targetRoot, linkPath, mount, mountsGateway });
  } finally {
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
    await fsPromises.rm(targetRoot, { recursive: true, force: true });
  }
}

function findNode(nodes: FileTreeNode[], name: string): FileTreeNode | undefined {
  return nodes.find((node) => node.name === name);
}

test('listProjectFiles lists a mount as a directory with its contents, past a .gitignore rule for mounts/', async () => {
  await withMountedProject(async ({ projectRoot, targetRoot, linkPath, mountsGateway }) => {
    await fsPromises.mkdir(path.join(targetRoot, 'videos'));
    await fsPromises.writeFile(path.join(targetRoot, 'videos', 'clip.mp4'), 'clip');
    await fsPromises.writeFile(path.join(targetRoot, 'readme.txt'), 'big files');
    await fsPromises.writeFile(path.join(projectRoot, '.gitignore'), 'mounts/\n');
    await fsPromises.writeFile(path.join(projectRoot, 'index.ts'), 'export {};');

    const service = createRealFileSystemService(projectRoot, projectRoot, mountsGateway);
    const tree = await service.listProjectFiles('project-1', { respectGitignore: true, markIgnored: true });

    const mountsFolder = findNode(tree, 'mounts');
    assert.equal(mountsFolder?.type, 'directory');
    assert.equal(mountsFolder?.isIgnored, undefined);
    // The sentinel is not shown; the link is a folder.
    assert.deepEqual(mountsFolder?.children?.map((node) => node.name), ['data']);
    const dataNode = mountsFolder?.children?.[0];
    assert.equal(dataNode?.path, linkPath);
    assert.equal(dataNode?.type, 'directory');
    assert.equal(dataNode?.isSymlink, true);
    assert.deepEqual(dataNode?.mount, { mountId: 'mount-1', name: 'data', targetPath: targetRoot, status: 'ok' });
    assert.equal(dataNode?.inMount, undefined);
    assert.equal(dataNode?.truncated, undefined);
    assert.deepEqual(dataNode?.children?.map((node) => [node.name, node.type, node.inMount]), [
      ['videos', 'directory', true],
      ['readme.txt', 'file', true],
    ]);
    const clip = findNode(dataNode?.children ?? [], 'videos')?.children?.[0];
    assert.equal(clip?.path, path.join(linkPath, 'videos', 'clip.mp4'));
    assert.equal(clip?.inMount, true);
  });
});

test('listProjectFiles shows a mount to the @ mention list as a folder without its contents', async () => {
  await withMountedProject(async ({ projectRoot, targetRoot, mountsGateway }) => {
    await fsPromises.writeFile(path.join(targetRoot, 'readme.txt'), 'big files');

    const service = createRealFileSystemService(projectRoot, projectRoot, mountsGateway);
    const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

    const dataNode = findNode(findNode(tree, 'mounts')?.children ?? [], 'data');
    assert.equal(dataNode?.type, 'directory');
    assert.equal(dataNode?.mount?.status, 'ok');
    assert.equal(dataNode?.children, undefined);
  });
});

test('listProjectFiles cuts a big mount short on its own budget instead of failing with a 413', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const mountsDirectory = path.join(projectRoot, 'mounts');
  const linkPath = path.join(mountsDirectory, 'big');
  const sourceDirectory = path.join(projectRoot, 'src');
  const mount: ProjectMount = {
    mountId: 'mount-big',
    name: 'big',
    linkPath: 'mounts/big',
    targetPath: '/data/big',
    realTargetPath: '/data/big',
    status: 'ok',
    createdAt: '2026-10-30T00:00:00.000Z',
  };
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    lstat: async (candidatePath) => createStats(candidatePath === sourceDirectory || candidatePath === mountsDirectory, 0o644),
    openDirectory: async function* (directoryPath) {
      if (directoryPath === projectRoot) {
        yield createDirectoryEntry('mounts', true);
        yield createDirectoryEntry('src', true);
        return;
      }
      if (directoryPath === mountsDirectory) {
        yield createDirectoryEntry('.gitignore', false);
        // A symlink is not a directory entry, as opendir reports it.
        yield createDirectoryEntry('big', false);
        return;
      }
      if (directoryPath === linkPath) {
        // More than the whole project's entry limit.
        for (let index = 0; index < 12_000; index += 1) {
          yield createDirectoryEntry(`frame-${index}.png`, false);
        }
        return;
      }
      if (directoryPath === sourceDirectory) {
        yield createDirectoryEntry('main.ts', false);
      }
    },
  });
  const service = createFileTreeService({
    ...createDependencies(fileSystem, projectRoot),
    mounts: {
      directoryName: 'mounts',
      listProjectMounts: async () => [mount],
      runInMountTarget: runMountCallsDirectly,
      isShareUnreachable: noShareHangs,
    },
  });

  const tree = await service.listProjectFiles('project-1', { respectGitignore: false, markIgnored: true });

  const mountsFolder = findNode(tree, 'mounts');
  assert.deepEqual(mountsFolder?.children?.map((node) => node.name), ['big']);
  const bigNode = mountsFolder?.children?.[0];
  assert.equal(bigNode?.type, 'directory');
  assert.equal(bigNode?.truncated, true);
  assert.equal(bigNode?.children?.length, 2_000);
  assert.equal(bigNode?.children?.every((node) => node.inMount === true), true);
  // The rest of the project is listed as usual.
  assert.deepEqual(findNode(tree, 'src')?.children?.map((node) => node.name), ['main.ts']);
});

test('listProjectFiles shows a mount whose target is gone as a broken folder without contents', async () => {
  await withMountedProject(async ({ projectRoot, targetRoot, mount }) => {
    await fsPromises.rm(targetRoot, { recursive: true, force: true });
    const brokenMount: ProjectMount = { ...mount, realTargetPath: null, status: 'missing-target' };

    const service = createRealFileSystemService(projectRoot, projectRoot, {
      directoryName: 'mounts',
      listProjectMounts: async () => [brokenMount],
      runInMountTarget: runMountCallsDirectly,
      isShareUnreachable: noShareHangs,
    });
    const tree = await service.listProjectFiles('project-1', { respectGitignore: true, markIgnored: true });

    const dataNode = findNode(findNode(tree, 'mounts')?.children ?? [], 'data');
    assert.equal(dataNode?.type, 'directory');
    assert.equal(dataNode?.mount?.status, 'missing-target');
    assert.equal(dataNode?.children, undefined);
  });
});

test('a mount\'s link, the mounts folder and the sentinel cannot be renamed or deleted, and nothing is touched', async () => {
  await withMountedProject(async ({ projectRoot, targetRoot, linkPath, mountsGateway }) => {
    await fsPromises.writeFile(path.join(targetRoot, 'keep.bin'), 'precious');
    const service = createRealFileSystemService(projectRoot, projectRoot, mountsGateway);
    const isProtected = (error: unknown) => error instanceof AppError
      && error.code === 'MOUNT_PROTECTED'
      && error.statusCode === 403;

    await assert.rejects(service.deleteEntry({ projectId: 'project-1', targetPath: linkPath }), isProtected);
    await assert.rejects(service.deleteEntry({ projectId: 'project-1', targetPath: 'mounts/data' }), isProtected);
    await assert.rejects(service.deleteEntry({ projectId: 'project-1', targetPath: 'mounts' }), isProtected);
    await assert.rejects(service.deleteEntry({ projectId: 'project-1', targetPath: 'mounts/.gitignore' }), isProtected);
    await assert.rejects(
      service.renameEntry({ projectId: 'project-1', oldPath: linkPath, newName: 'renamed' }),
      isProtected,
    );
    await assert.rejects(
      service.renameEntry({ projectId: 'project-1', oldPath: path.join(projectRoot, 'mounts'), newName: 'other' }),
      isProtected,
    );

    assert.equal((await fsPromises.lstat(linkPath)).isSymbolicLink(), true);
    assert.equal(await fsPromises.readFile(path.join(targetRoot, 'keep.bin'), 'utf8'), 'precious');
    assert.deepEqual((await fsPromises.readdir(path.join(projectRoot, 'mounts'))).sort(), ['.gitignore', 'data']);
  });
});

test('a mount\'s link and the mounts folder stay protected when their path is spelled through another link', async () => {
  await withMountedProject(async ({ projectRoot, targetRoot, linkPath, mountsGateway }) => {
    await fsPromises.writeFile(path.join(targetRoot, 'keep.bin'), 'precious');
    // A link in the project to the project itself.
    await fsPromises.symlink('.', path.join(projectRoot, 'self'), 'dir');
    const service = createRealFileSystemService(projectRoot, projectRoot, mountsGateway);
    const isProtected = (error: unknown) => error instanceof AppError
      && error.code === 'MOUNT_PROTECTED'
      && error.statusCode === 403;

    await assert.rejects(service.deleteEntry({ projectId: 'project-1', targetPath: 'self/mounts/data' }), isProtected);
    await assert.rejects(service.deleteEntry({ projectId: 'project-1', targetPath: 'self/mounts/.gitignore' }), isProtected);
    await assert.rejects(service.deleteEntry({ projectId: 'project-1', targetPath: 'self/mounts' }), isProtected);
    await assert.rejects(
      service.renameEntry({ projectId: 'project-1', oldPath: 'self/mounts/data', newName: 'moved' }),
      isProtected,
    );
    await assert.rejects(
      service.renameEntry({ projectId: 'project-1', oldPath: path.join(projectRoot, 'self', 'mounts'), newName: 'other' }),
      isProtected,
    );

    assert.equal((await fsPromises.lstat(linkPath)).isSymbolicLink(), true);
    assert.equal(await fsPromises.readFile(path.join(targetRoot, 'keep.bin'), 'utf8'), 'precious');
    assert.deepEqual((await fsPromises.readdir(path.join(projectRoot, 'mounts'))).sort(), ['.gitignore', 'data']);
    // What is inside the mount is still the user's to change, by any spelling.
    await fsPromises.writeFile(path.join(targetRoot, 'old.log'), 'old');
    await service.deleteEntry({ projectId: 'project-1', targetPath: 'self/mounts/data/old.log' });
    assert.deepEqual(await fsPromises.readdir(targetRoot), ['keep.bin']);
  });
});

test('a file inside the project opens by its absolute path while the disk it shares with a mount does not answer', async () => {
  await withMountedProject(async ({ projectRoot, mount }) => {
    await fsPromises.mkdir(path.join(projectRoot, 'src'));
    await fsPromises.writeFile(path.join(projectRoot, 'src', 'index.ts'), 'export {};');
    let asked = 0;
    const service = createRealFileSystemService(projectRoot, projectRoot, {
      directoryName: 'mounts',
      listProjectMounts: async () => [mount],
      runInMountTarget: runMountCallsDirectly,
      // A call on that disk timed out a moment ago.
      isShareUnreachable: async () => {
        asked += 1;
        return true;
      },
    });
    const absolutePath = path.join(projectRoot, 'src', 'index.ts');

    assert.equal((await service.readTextFile('project-1', absolutePath)).content, 'export {};');
    const opened = await service.openFile('project-1', absolutePath);
    opened.stream.destroy();
    assert.equal(asked, 0);
  });
});

test('deleting a file inside a mount deletes the real file in the target', async () => {
  await withMountedProject(async ({ projectRoot, targetRoot, linkPath, mountsGateway }) => {
    await fsPromises.writeFile(path.join(targetRoot, 'old.log'), 'old');
    await fsPromises.writeFile(path.join(targetRoot, 'keep.log'), 'keep');
    const service = createRealFileSystemService(projectRoot, projectRoot, mountsGateway);

    const result = await service.deleteEntry({ projectId: 'project-1', targetPath: path.join(linkPath, 'old.log') });

    assert.equal(result.type, 'file');
    assert.deepEqual(await fsPromises.readdir(targetRoot), ['keep.log']);
  });
});

test('a file in a mount\'s target can be read by its real path', async () => {
  await withMountedProject(async ({ projectRoot, targetRoot, mountsGateway }) => {
    await fsPromises.writeFile(path.join(targetRoot, 'notes.md'), 'from the big disk');
    const realFilePath = path.join(await fsPromises.realpath(targetRoot), 'notes.md');
    assert.equal(await resolveReadOnlyRootPath(realFilePath), null);

    // Without the mount the real path is outside everything readable.
    const withoutMount = createRealFileSystemService(projectRoot);
    await assert.rejects(
      withoutMount.readTextFile('project-1', realFilePath),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );

    const service = createRealFileSystemService(projectRoot, projectRoot, mountsGateway);
    const opened = await service.readTextFile('project-1', realFilePath);
    assert.equal(opened.content, 'from the big disk');
    // Writing by the real path stays refused: only the link's path writes into a mount.
    await assert.rejects(
      service.saveTextFile('project-1', realFilePath, 'overwritten'),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    assert.equal(await fsPromises.readFile(realFilePath, 'utf8'), 'from the big disk');
  });
});

test('searchProjectFiles leaves out mount links and the sentinel', async () => {
  await withMountedProject(async ({ projectRoot, targetRoot, mountsGateway }) => {
    await fsPromises.writeFile(path.join(targetRoot, 'data-notes.md'), 'outside');
    await fsPromises.writeFile(path.join(projectRoot, 'data-model.ts'), 'inside');

    const service = createRealFileSystemService(projectRoot, projectRoot, mountsGateway);
    const found = await service.searchProjectFiles('project-1', { query: 'data', limit: 10 });

    assert.deepEqual(found.files.map((file) => file.relativePath), ['data-model.ts']);
    const gitignoreSearch = await service.searchProjectFiles('project-1', { query: 'gitignore', limit: 10 });
    assert.deepEqual(gitignoreSearch.files.map((file) => file.relativePath), []);
  });
});

/**
 * Runs each call in a mount as the projects module's mount gate does, with
 * a short time limit: a call that has not answered by then comes back
 * `unreachable`, and its share (the longest of `shares` its real path lies
 * in) takes no new call. Notes the real paths it was given.
 */
function createTimeLimitedMountCalls(timeLimitMs: number, shares: string[]) {
  const realPaths: string[] = [];
  const hungShares = new Set<string>();
  const shareOf = (realPath: string) => shares
    .filter((share) => realPath === share || realPath.startsWith(`${share}${path.sep}`))
    .sort((left, right) => right.length - left.length)[0];
  const runInMountTarget: FileTreeMountsGateway['runInMountTarget'] = async (realPath, operation) => {
    realPaths.push(realPath);
    const share = shareOf(realPath);
    if (hungShares.has(share)) {
      return { kind: 'unreachable' };
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timed out'>((resolve) => {
      timer = setTimeout(() => resolve('timed out'), timeLimitMs);
    });
    try {
      const outcome = await Promise.race([
        operation({ gated: true }).then((value) => ({ kind: 'done' as const, value }), (error: unknown) => ({ kind: 'failed' as const, error })),
        timedOut,
      ]);
      if (outcome === 'timed out') {
        hungShares.add(share);
        return { kind: 'unreachable' };
      }
      return outcome;
    } finally {
      clearTimeout(timer);
    }
  };
  return { runInMountTarget, realPaths };
}

test('listProjectFiles answers in time when a share inside a mount hangs, and lists the rest', { timeout: 5_000 }, async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const mountsDirectory = path.join(projectRoot, 'mounts');
  const linkPath = path.join(mountsDirectory, 'data');
  const nasPath = path.join(linkPath, 'nas');
  const mount: ProjectMount = {
    mountId: 'mount-data',
    name: 'data',
    linkPath: 'mounts/data',
    targetPath: '/data',
    realTargetPath: '/data',
    status: 'ok',
    createdAt: '2026-10-30T00:00:00.000Z',
  };
  const hangs = () => new Promise<never>(() => {});
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    // A hard-mounted NFS share at /data/nas whose server is gone: anything
    // that touches it never answers.
    lstat: async (candidatePath) => (candidatePath === nasPath
      ? hangs()
      : createStats(candidatePath === mountsDirectory || candidatePath === path.join(linkPath, 'local'), 0o755)),
    openDirectory: async function* (directoryPath) {
      if (directoryPath === projectRoot) {
        yield createDirectoryEntry('mounts', true);
        yield createDirectoryEntry('index.ts', false);
        return;
      }
      if (directoryPath === mountsDirectory) {
        yield createDirectoryEntry('data', false);
        return;
      }
      if (directoryPath === linkPath) {
        yield createDirectoryEntry('nas', true);
        yield createDirectoryEntry('local', true);
        yield createDirectoryEntry('readme.txt', false);
        return;
      }
      if (directoryPath === nasPath) {
        await hangs();
      }
      if (directoryPath === path.join(linkPath, 'local')) {
        yield createDirectoryEntry('notes.md', false);
      }
    },
  });
  const mountCalls = createTimeLimitedMountCalls(50, ['/data', path.join('/data', 'nas')]);
  const service = createFileTreeService({
    ...createDependencies(fileSystem, projectRoot),
    mounts: {
      directoryName: 'mounts',
      listProjectMounts: async () => [mount],
      runInMountTarget: mountCalls.runInMountTarget,
      isShareUnreachable: noShareHangs,
    },
  });

  const tree = await service.listProjectFiles('project-1', { respectGitignore: false, markIgnored: true });

  const dataNode = findNode(findNode(tree, 'mounts')?.children ?? [], 'data');
  assert.equal(dataNode?.truncated, true);
  // The share's own folder, whose type its lstat never told, is left out.
  assert.deepEqual(dataNode?.children?.map((node) => node.name), ['local', 'readme.txt']);
  assert.deepEqual(findNode(dataNode?.children ?? [], 'local')?.children?.map((node) => node.name), ['notes.md']);
  assert.equal(findNode(tree, 'index.ts')?.type, 'file');
  // Every call in the mount went through the gate, by where it really is.
  assert.equal(mountCalls.realPaths.includes('/data'), true);
  assert.equal(mountCalls.realPaths.includes(path.join('/data', 'nas')), true);
  assert.equal(mountCalls.realPaths.every((realPath) => realPath === '/data' || realPath.startsWith(`/data${path.sep}`)), true);
});

test('reads and changes in a mount whose target does not answer are refused with 503 before anything touches it', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const linkPath = path.join(projectRoot, 'mounts', 'data');
  const offline: ProjectMount = {
    mountId: 'mount-data',
    name: 'data',
    linkPath: 'mounts/data',
    targetPath: '/mnt/nas/data',
    realTargetPath: null,
    status: 'missing-target',
    createdAt: '2026-10-30T00:00:00.000Z',
  };
  const touched: string[] = [];
  const note = (operation: string) => async (candidatePath: string) => {
    touched.push(`${operation} ${candidatePath}`);
    throw new Error('the share would hang here');
  };
  const fileSystem = createFakeFileSystem({
    access: note('access'),
    stat: note('stat'),
    lstat: note('lstat'),
    realpath: note('realpath'),
    readTextFile: note('readTextFile'),
    writeTextFile: note('writeTextFile'),
  });
  const service = createFileTreeService({
    ...createDependencies(fileSystem, projectRoot),
    mounts: {
      directoryName: 'mounts',
      listProjectMounts: async () => [offline],
      runInMountTarget: runMountCallsDirectly,
      isShareUnreachable: noShareHangs,
    },
  });
  const unreachable = (error: unknown) => error instanceof AppError
    && error.code === 'MOUNT_UNREACHABLE'
    && error.statusCode === 503;

  await assert.rejects(service.readTextFile('project-1', 'mounts/data/notes.md'), unreachable);
  await assert.rejects(service.readTextFile('project-1', path.join(linkPath, 'notes.md')), unreachable);
  await assert.rejects(service.readTextFile('project-1', '/mnt/nas/data/notes.md'), unreachable);
  await assert.rejects(service.openFile('project-1', path.join(linkPath, 'clip.mp4')), unreachable);
  await assert.rejects(service.saveTextFile('project-1', path.join(linkPath, 'notes.md'), 'text'), unreachable);
  await assert.rejects(service.deleteEntry({ projectId: 'project-1', targetPath: path.join(linkPath, 'old.log') }), unreachable);
  await assert.rejects(
    service.renameEntry({ projectId: 'project-1', oldPath: path.join(linkPath, 'a.txt'), newName: 'b.txt' }),
    unreachable,
  );
  await assert.rejects(
    service.createEntry({ projectId: 'project-1', parentPath: linkPath, name: 'new.txt', type: 'file' }),
    unreachable,
  );
  assert.deepEqual(touched, []);
});

test('a read in a mount whose share stops answering comes back 503 in time', { timeout: 5_000 }, async () => {
  await withMountedProject(async ({ projectRoot, linkPath, mount }) => {
    let calls = 0;
    const service = createRealFileSystemService(projectRoot, projectRoot, {
      directoryName: 'mounts',
      listProjectMounts: async () => [mount],
      runInMountTarget: async () => {
        calls += 1;
        return { kind: 'unreachable' };
      },
      isShareUnreachable: noShareHangs,
    });

    await assert.rejects(
      service.readTextFile('project-1', path.join(linkPath, 'notes.md')),
      (error: unknown) => error instanceof AppError && error.code === 'MOUNT_UNREACHABLE' && error.statusCode === 503,
    );
    assert.equal(calls, 1);
  });
});

test('readTextFile refuses a file over 10 MB with 413 and both sizes, and reads one at the limit', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const limit = 10 * 1024 * 1024;
  const readPaths: string[] = [];
  const fileSystem = createFakeFileSystem({
    stat: async (candidatePath) => ({
      ...createStats(false, 0o644),
      size: candidatePath.endsWith('huge.log') ? limit + 1 : limit,
    }),
    readTextFile: async (filePath) => {
      readPaths.push(filePath);
      return 'content';
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', 'huge.log'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TOO_LARGE'
      && error.statusCode === 413
      && JSON.stringify(error.details) === JSON.stringify({ size: limit + 1, limit }),
  );
  assert.deepEqual(readPaths, []);

  const atLimit = await service.readTextFile('project-1', 'exact.log');
  assert.equal(atLimit.content, 'content');
});

test('a read by the real path of a mount reached through a link is refused with 503 while that filesystem hangs', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  // Registered by a link in the home folder (~/nas -> /mnt/nas), so the
  // target's realpath, which the agent quotes, is not its registered path.
  const offline: ProjectMount = {
    mountId: 'mount-nas',
    name: 'nas',
    linkPath: 'mounts/nas',
    targetPath: '/home/u/nas',
    realTargetPath: null,
    status: 'missing-target',
    createdAt: '2026-10-30T00:00:00.000Z',
  };
  const touched: string[] = [];
  const fileSystem = createFakeFileSystem({
    realpath: async (candidatePath) => {
      touched.push(`realpath ${candidatePath}`);
      throw new Error('the share would hang here');
    },
    readTextFile: async (candidatePath) => {
      touched.push(`readTextFile ${candidatePath}`);
      return 'text';
    },
  });
  const service = createFileTreeService({
    ...createDependencies(fileSystem, projectRoot),
    mounts: {
      directoryName: 'mounts',
      listProjectMounts: async () => [offline],
      runInMountTarget: runMountCallsDirectly,
      // The mount's probe hung on /mnt/nas.
      isShareUnreachable: async (absolutePath) => absolutePath === '/mnt/nas' || absolutePath.startsWith('/mnt/nas/'),
    },
    workspace: {
      rootPath: projectRoot,
      validatePath: async (candidatePath) => ({ valid: true, resolvedPath: candidatePath }),
      resolveReadOnlyRootPath: async (candidatePath) => {
        touched.push(`resolveReadOnlyRootPath ${candidatePath}`);
        return null;
      },
    },
  });
  const unreachable = (error: unknown) => error instanceof AppError
    && error.code === 'MOUNT_UNREACHABLE'
    && error.statusCode === 503;

  await assert.rejects(service.readTextFile('project-1', '/mnt/nas/data/a.csv'), unreachable);
  await assert.rejects(service.openFile('project-1', '/mnt/nas/scans/page.png'), unreachable);
  assert.deepEqual(touched, []);

  // A path whose filesystem answers goes on to the other rules.
  await assert.rejects(
    service.readTextFile('project-1', '/srv/elsewhere/b.txt'),
    (error: unknown) => error instanceof AppError && error.code !== 'MOUNT_UNREACHABLE',
  );
  assert.deepEqual(touched, ['resolveReadOnlyRootPath /srv/elsewhere/b.txt']);
});

test('a folder in a mount on a network share is read as names in one slow call, never through opendir, and its entries take their types from lstat', { timeout: 5_000 }, async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const mountsDirectory = path.join(projectRoot, 'mounts');
  const linkPath = path.join(mountsDirectory, 'data');
  const clipsPath = path.join(linkPath, 'clips');
  const mount: ProjectMount = {
    mountId: 'mount-data',
    name: 'data',
    linkPath: 'mounts/data',
    targetPath: '/data',
    realTargetPath: '/data',
    status: 'ok',
    createdAt: '2026-10-30T00:00:00.000Z',
  };
  const opened: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    lstat: async (candidatePath) => createStats(
      [mountsDirectory, clipsPath, path.join(linkPath, 'node_modules')].includes(candidatePath),
      0o755,
    ),
    // opendir reads a share that reports no entry types with a synchronous
    // lstat on the event loop, so it is for the project's own folders only.
    openDirectory: async function* (directoryPath) {
      opened.push(directoryPath);
      if (directoryPath === projectRoot) {
        yield createDirectoryEntry('mounts', true);
        return;
      }
      if (directoryPath === mountsDirectory) {
        yield createDirectoryEntry('data', false);
        return;
      }
      throw new Error(`opendir in a mount: ${directoryPath}`);
    },
    readDirectoryNames: async (directoryPath) => {
      if (directoryPath === linkPath) {
        return ['clips', 'node_modules', 'notes.md'];
      }
      if (directoryPath === clipsPath) {
        return ['a.mp4'];
      }
      throw new Error(`unexpected read of ${directoryPath}`);
    },
  });
  const slowCalls: string[] = [];
  let otherCalls = 0;
  const service = createFileTreeService({
    ...createDependencies(fileSystem, projectRoot),
    mounts: {
      directoryName: 'mounts',
      listProjectMounts: async () => [mount],
      runInMountTarget: async (realPath, operation, options) => {
        if (options?.slow === true) {
          slowCalls.push(realPath);
        } else {
          otherCalls += 1;
        }
        return runMountCallsDirectly(realPath, operation, options);
      },
      isShareUnreachable: noShareHangs,
    },
  });

  const tree = await service.listProjectFiles('project-1', { respectGitignore: false, markIgnored: true });

  const dataNode = findNode(findNode(tree, 'mounts')?.children ?? [], 'data');
  // node_modules is a folder by its lstat, so the hard exclusions hide it.
  assert.deepEqual(dataNode?.children?.map((node) => [node.name, node.type]), [['clips', 'directory'], ['notes.md', 'file']]);
  assert.deepEqual(findNode(dataNode?.children ?? [], 'clips')?.children?.map((node) => node.name), ['a.mp4']);
  assert.equal(findNode(dataNode?.children ?? [], 'notes.md')?.permissions, '755');
  assert.equal(dataNode?.truncated, undefined);
  assert.deepEqual(opened, [projectRoot, mountsDirectory]);
  // Reading every name of a big folder takes long on a share that answers,
  // so only the folder reads are slow calls; each lstat has the time limit.
  assert.deepEqual(slowCalls.sort(), ['/data', path.join('/data', 'clips')]);
  assert.equal(otherCalls, 4);
});

test('on a local disk a folder in a mount is streamed, and the walk stops reading it at the mounts\' budget', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const mountsDirectory = path.join(projectRoot, 'mounts');
  const linkPath = path.join(mountsDirectory, 'frames');
  const mount: ProjectMount = {
    mountId: 'mount-frames',
    name: 'frames',
    linkPath: 'mounts/frames',
    targetPath: '/data/frames',
    realTargetPath: '/data/frames',
    status: 'ok',
    createdAt: '2026-10-30T00:00:00.000Z',
  };
  let entriesRead = 0;
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    lstat: async (candidatePath) => createStats(candidatePath === mountsDirectory, 0o644),
    openDirectory: async function* (directoryPath) {
      if (directoryPath === projectRoot) {
        yield createDirectoryEntry('mounts', true);
        return;
      }
      if (directoryPath === mountsDirectory) {
        yield createDirectoryEntry('frames', false);
        return;
      }
      if (directoryPath === linkPath) {
        // A local dataset folder of fifty thousand images.
        for (let index = 0; index < 50_000; index += 1) {
          entriesRead += 1;
          yield createDirectoryEntry(`frame-${index}.png`, false);
        }
      }
    },
    readDirectoryNames: async (directoryPath) => {
      throw new Error(`a whole folder read on a local disk: ${directoryPath}`);
    },
  });
  const service = createFileTreeService({
    ...createDependencies(fileSystem, projectRoot),
    mounts: {
      directoryName: 'mounts',
      listProjectMounts: async () => [mount],
      runInMountTarget: runMountCallsOnLocalDisk,
      isShareUnreachable: noShareHangs,
    },
  });

  const tree = await service.listProjectFiles('project-1', { respectGitignore: false, markIgnored: true });

  const framesNode = findNode(findNode(tree, 'mounts')?.children ?? [], 'frames');
  assert.equal(framesNode?.truncated, true);
  assert.equal(framesNode?.children?.length, 2_000);
  // One name past the budget tells there is more; the rest is never read.
  assert.equal(entriesRead, 2_001);
});

test('no folder in a mount is read once the mounts\' budget is used up', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const mountsDirectory = path.join(projectRoot, 'mounts');
  const linkPath = path.join(mountsDirectory, 'scans');
  const mount: ProjectMount = {
    mountId: 'mount-scans',
    name: 'scans',
    linkPath: 'mounts/scans',
    targetPath: '/nas/scans',
    realTargetPath: '/nas/scans',
    status: 'ok',
    createdAt: '2026-10-30T00:00:00.000Z',
  };
  const folderNames = Array.from({ length: 2_000 }, (_value, index) => `batch-${index}`);
  const foldersRead: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    // Every entry in the mount is a folder.
    lstat: async (candidatePath) => createStats(candidatePath !== projectRoot, 0o755),
    openDirectory: async function* (directoryPath) {
      if (directoryPath === projectRoot) {
        yield createDirectoryEntry('mounts', true);
        return;
      }
      if (directoryPath === mountsDirectory) {
        yield createDirectoryEntry('scans', false);
      }
    },
    readDirectoryNames: async (directoryPath) => {
      foldersRead.push(directoryPath);
      // The mount's own folder fills the budget, so the scans in the folders
      // in it (a hundred thousand each, on a real NAS) need not be read.
      return directoryPath === linkPath ? folderNames : ['scan-0.tif', 'scan-1.tif'];
    },
  });
  const service = createFileTreeService({
    ...createDependencies(fileSystem, projectRoot),
    mounts: {
      directoryName: 'mounts',
      listProjectMounts: async () => [mount],
      runInMountTarget: runMountCallsDirectly,
      isShareUnreachable: noShareHangs,
    },
  });

  const tree = await service.listProjectFiles('project-1', { respectGitignore: false, markIgnored: true });

  const scansNode = findNode(findNode(tree, 'mounts')?.children ?? [], 'scans');
  assert.equal(scansNode?.children?.length, 2_000);
  assert.equal(scansNode?.truncated, true);
  assert.equal(foldersRead.length, 1);
  assert.equal(foldersRead[0] === linkPath, true);
});

test('the walk stops waiting for a slow folder read at its time limit, and lists the mount cut short', { timeout: 5_000 }, async (t) => {
  const projectRoot = path.resolve('file-tree-test-project');
  const mountsDirectory = path.join(projectRoot, 'mounts');
  const mount: ProjectMount = {
    mountId: 'mount-nas',
    name: 'nas',
    linkPath: 'mounts/nas',
    targetPath: '/nas',
    realTargetPath: '/nas',
    status: 'ok',
    createdAt: '2026-10-30T00:00:00.000Z',
  };
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    lstat: async (candidatePath) => createStats(candidatePath === mountsDirectory, 0o755),
    openDirectory: createDirectoryReader((directoryPath) => {
      if (directoryPath === projectRoot) {
        return [createDirectoryEntry('mounts', true), createDirectoryEntry('index.ts', false)];
      }
      return directoryPath === mountsDirectory ? [createDirectoryEntry('nas', false)] : [];
    }),
  });
  let slowReadStarted = false;
  const service = createFileTreeService({
    ...createDependencies(fileSystem, projectRoot),
    mounts: {
      directoryName: 'mounts',
      listProjectMounts: async () => [mount],
      runInMountTarget: async (realPath, operation, options) => {
        if (options?.slow === true) {
          // Still reading every name, long past the walk's time limit; the
          // gate keeps the share's turn for it until it answers.
          slowReadStarted = true;
          return new Promise(() => {});
        }
        return runMountCallsDirectly(realPath, operation, options);
      },
      isShareUnreachable: noShareHangs,
    },
  });

  const realSetTimeout = globalThis.setTimeout;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listing = service.listProjectFiles('project-1', { respectGitignore: false, markIgnored: true });
  for (let turn = 0; turn < 1_000 && !slowReadStarted; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(slowReadStarted, true);
  t.mock.timers.tick(5_000);
  const tree = await Promise.race([
    listing,
    new Promise<null>((resolve) => {
      realSetTimeout(() => resolve(null), 1_000);
    }),
  ]);

  assert.equal(tree === null, false);
  const nasNode = findNode(findNode(tree ?? [], 'mounts')?.children ?? [], 'nas');
  assert.equal(nasNode?.truncated, true);
  assert.deepEqual(nasNode?.children, []);
  assert.equal(findNode(tree ?? [], 'index.ts')?.type, 'file');
});

test('a read or a change in a mount asks the gate to follow the links below the target, so a link into another share counts against that share', async () => {
  await withMountedProject(async ({ projectRoot, targetRoot, linkPath, mount }) => {
    await fsPromises.writeFile(path.join(targetRoot, 'notes.md'), 'notes');
    const asked: Array<{ realPath: string; followLinksBelow: string | undefined }> = [];
    const service = createRealFileSystemService(projectRoot, projectRoot, {
      directoryName: 'mounts',
      listProjectMounts: async () => [mount],
      runInMountTarget: async (realPath, operation, options) => {
        asked.push({ realPath, followLinksBelow: options?.followLinksBelow });
        return runMountCallsDirectly(realPath, operation, options);
      },
      isShareUnreachable: noShareHangs,
    });
    const realTarget = mount.realTargetPath ?? '';

    assert.equal((await service.readTextFile('project-1', 'mounts/data/notes.md')).content, 'notes');
    await service.deleteEntry({ projectId: 'project-1', targetPath: path.join(linkPath, 'notes.md') });
    await fsPromises.writeFile(path.join(targetRoot, 'again.md'), 'again');
    assert.equal((await service.readTextFile('project-1', path.join(realTarget, 'again.md'))).content, 'again');

    assert.equal(asked.length > 0, true);
    assert.equal(asked.every((call) => call.followLinksBelow === realTarget), true, JSON.stringify(asked));
  });
});
