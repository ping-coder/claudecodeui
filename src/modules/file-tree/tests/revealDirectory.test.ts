import assert from 'node:assert/strict';

import { test } from 'vitest';

import { directoryRevealFolders } from '@/modules/file-tree/utils/revealDirectory';
import type { FileTreeNode } from '@/shared/types';

/**
 * Regression guard: an in-chat directory reference is written the way the model
 * wrote it — usually relative, sometimes absolute — while the file tree keys
 * every node by the absolute path the server emitted.
 */

const ROOT = '/home/odoo/workspace/personal';

const files = [
  {
    type: 'directory',
    name: 'decisions',
    path: `${ROOT}/decisions`,
    children: [{ type: 'file', name: '0001-first.md', path: `${ROOT}/decisions/0001-first.md` }],
  },
  {
    type: 'directory',
    name: 'src',
    path: `${ROOT}/src`,
    children: [
      {
        type: 'directory',
        name: 'modules',
        path: `${ROOT}/src/modules`,
        children: [{ type: 'file', name: 'index.ts', path: `${ROOT}/src/modules/index.ts` }],
      },
    ],
  },
  { type: 'file', name: 'README.md', path: `${ROOT}/README.md` },
] as unknown as FileTreeNode[];

// The path of every folder the reveal reaches, root first.
const revealedPaths = (tree: FileTreeNode[], projectPath: string, reference: string) =>
  directoryRevealFolders(tree, projectPath, reference).map((folder) => folder.path);

test('a relative reference resolves against the project root', () => {
  assert.deepEqual(revealedPaths(files, ROOT, 'decisions/'), [`${ROOT}/decisions`]);
});

test('every ancestor of a nested reference is expanded, root first', () => {
  assert.deepEqual(revealedPaths(files, ROOT, 'src/modules/'), [
    `${ROOT}/src`,
    `${ROOT}/src/modules`,
  ]);
});

test('an absolute reference inside the project resolves to the same paths', () => {
  assert.deepEqual(revealedPaths(files, ROOT, `${ROOT}/src/modules`), [
    `${ROOT}/src`,
    `${ROOT}/src/modules`,
  ]);
});

test('a sibling directory that merely shares the root prefix expands nothing', () => {
  assert.deepEqual(revealedPaths(files, ROOT, `${ROOT}-backup/src`), []);
});

test('a path outside the project, and the root itself, expand nothing', () => {
  assert.deepEqual(revealedPaths(files, ROOT, '/etc/ssl'), []);
  assert.deepEqual(revealedPaths(files, ROOT, ROOT), []);
});

test('expansion stops at the last level the tree actually holds', () => {
  // `dist/` is gitignored, so the tree never listed it.
  assert.deepEqual(revealedPaths(files, ROOT, 'src/dist/assets/'), [`${ROOT}/src`]);
  assert.deepEqual(revealedPaths(files, ROOT, 'README.md/'), []);
});

test('a gitignored folder the tree lists greyed out is reached as the last level', () => {
  // Returned rather than skipped, so the tree knows the request found its
  // folder, and flagged, so the tree keeps that folder closed.
  const withIgnored = [
    ...files,
    { type: 'directory', name: 'dist-server', path: `${ROOT}/dist-server`, isIgnored: true },
  ] as unknown as FileTreeNode[];
  assert.deepEqual(
    directoryRevealFolders(withIgnored, ROOT, 'dist-server/assets/').map((folder) => [folder.path, folder.isIgnored === true]),
    [[`${ROOT}/dist-server`, true]],
  );
});

test('windows separators and a ./ prefix are levelled before matching', () => {
  assert.deepEqual(revealedPaths(files, ROOT, './src/modules'), [
    `${ROOT}/src`,
    `${ROOT}/src/modules`,
  ]);

  const windowsRoot = 'C:\\Users\\odoo\\personal';
  const windowsFiles = [
    {
      type: 'directory',
      name: 'src',
      path: 'C:\\Users\\odoo\\personal\\src',
      children: [],
    },
  ] as unknown as FileTreeNode[];
  assert.deepEqual(revealedPaths(windowsFiles, windowsRoot, 'C:\\Users\\odoo\\personal\\src'), [
    'C:\\Users\\odoo\\personal\\src',
  ]);
});
