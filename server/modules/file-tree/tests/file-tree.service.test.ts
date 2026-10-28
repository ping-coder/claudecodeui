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
  FileTreeNode,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeStats,
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

  return {
    access: unexpectedOperation,
    stat: unexpectedOperation,
    lstat: unexpectedOperation,
    openDirectory: () => ({
      [Symbol.asyncIterator]: () => ({ next: unexpectedOperation }),
    }),
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
}

function createDependencies(
  fileSystem: FileTreeFileSystem,
  projectRoot: string,
): FileTreeServiceDependencies {
  return {
    fileSystem,
    projects: {
      getProjectPathById: async () => projectRoot,
    },
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
function createRealFileSystemService(projectRoot: string, workspaceRoot = projectRoot): FileTreeServices {
  return createFileTreeService({
    fileSystem: {
      access: (candidatePath) => fsPromises.access(candidatePath),
      stat: (candidatePath) => fsPromises.stat(candidatePath),
      lstat: (candidatePath) => fsPromises.lstat(candidatePath),
      openDirectory: async function* (directoryPath) {
        yield* await fsPromises.opendir(directoryPath);
      },
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
