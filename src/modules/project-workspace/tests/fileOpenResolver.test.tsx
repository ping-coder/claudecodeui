import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * Regression guard: an absolute path must open the file it names.
 *
 * `findBestMatch` falls back to matching by filename, which is what makes bare
 * references like `foo.ts` work. Applied to an absolute path it silently
 * rewrote the reference: asking for `/home/user/.config/CLAUDE.md` opened the
 * project's own `CLAUDE.md` — a different file, with no error, indistinguishable
 * from the right one.
 */

const getFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { getFiles: (...args: unknown[]) => getFiles(...args) },
}));

const { useFileOpenResolver } = await import('@/modules/project-workspace/hooks/useFileOpenResolver');

const ROOT = '/home/odoo/workspace/personal';
const project: Project = { projectId: 'p1', displayName: 'personal', fullPath: ROOT };

const tree = [
  { type: 'file', name: 'CLAUDE.md', path: `${ROOT}/CLAUDE.md` },
  {
    type: 'directory',
    name: 'src',
    path: `${ROOT}/src`,
    children: [{ type: 'file', name: 'foo.ts', path: `${ROOT}/src/foo.ts` }],
  },
];

const setup = (files: unknown[] = tree) => {
  getFiles.mockReset();
  getFiles.mockResolvedValue({ ok: true, json: async () => files });
  const onFileOpen = vi.fn();
  const { result } = renderHook(() => useFileOpenResolver(project, onFileOpen));
  return { resolve: result.current, onFileOpen };
};

test('an absolute path outside the project is passed through untouched', async () => {
  const { resolve, onFileOpen } = setup();
  resolve('/home/odoo/.claude/CLAUDE.md');
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], '/home/odoo/.claude/CLAUDE.md');
  // It does not even need the tree, so no request goes out.
  assert.equal(getFiles.mock.calls.length, 0);
});

test('an absolute path inside the project resolves to itself, as before', async () => {
  const { resolve, onFileOpen } = setup();
  resolve(`${ROOT}/src/foo.ts`);
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], `${ROOT}/src/foo.ts`);
});

test('partial references still match against the tree', async () => {
  const { resolve, onFileOpen } = setup();
  resolve('foo.ts');
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], `${ROOT}/src/foo.ts`);

  const second = setup();
  second.resolve('src/foo.ts');
  await waitFor(() => assert.equal(second.onFileOpen.mock.calls.length, 1));
  assert.equal(second.onFileOpen.mock.calls[0][0], `${ROOT}/src/foo.ts`);
});

test('diffInfo and line survive the absolute-path shortcut', async () => {
  const { resolve, onFileOpen } = setup();
  const diffInfo = { old_string: 'a', new_string: 'b' };
  resolve('/home/odoo/.claude/CLAUDE.md', diffInfo, 150);
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.deepEqual(onFileOpen.mock.calls[0].slice(1), [diffInfo, 150]);
});

test('surrounding whitespace never reaches the API as part of the path', async () => {
  const { resolve, onFileOpen } = setup();
  resolve('  /home/odoo/.claude/CLAUDE.md ');
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], '/home/odoo/.claude/CLAUDE.md');

  const second = setup();
  second.resolve('nope.ts ');
  await waitFor(() => assert.equal(second.onFileOpen.mock.calls.length, 1));
  assert.equal(second.onFileOpen.mock.calls[0][0], 'nope.ts');
});

/**
 * Regression guard: a bare filename opens the shallowest file of that name.
 *
 * The server lists directories before files, so walking the tree in order
 * reaches every nested namesake before the root file. Taking the first match
 * made `README.md` open `deploy/peace-cc/README.md` instead of the project's
 * own `README.md`.
 */

const readmeFile = (dir: string) => ({
  type: 'file',
  name: 'README.md',
  path: dir ? `${ROOT}/${dir}/README.md` : `${ROOT}/README.md`,
});

// Mirrors the server order: directories first, then files, each by name.
const nestedReadmeDirs = [
  {
    type: 'directory',
    name: 'deploy',
    path: `${ROOT}/deploy`,
    children: [
      {
        type: 'directory',
        name: 'peace-cc',
        path: `${ROOT}/deploy/peace-cc`,
        children: [readmeFile('deploy/peace-cc')],
      },
    ],
  },
  { type: 'directory', name: 'docs', path: `${ROOT}/docs`, children: [readmeFile('docs')] },
  { type: 'directory', name: 'src', path: `${ROOT}/src`, children: [readmeFile('src')] },
];

const readmeTree = [...nestedReadmeDirs, readmeFile('')];

test('a bare filename opens the root file, not a nested namesake listed first', async () => {
  const { resolve, onFileOpen } = setup(readmeTree);
  resolve('README.md');
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], `${ROOT}/README.md`);
});

test('matches at the same depth keep the tree order', async () => {
  // No root README.md: docs/ and src/ tie as the shallowest, and docs/ is
  // listed first.
  const { resolve, onFileOpen } = setup(nestedReadmeDirs);
  resolve('README.md');
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], `${ROOT}/docs/README.md`);
});

test('a partial path still reaches the deeper file it names', async () => {
  const { resolve, onFileOpen } = setup(readmeTree);
  resolve('peace-cc/README.md');
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], `${ROOT}/deploy/peace-cc/README.md`);
});

test('the filename fallback also prefers the shallowest file', async () => {
  // No file sits under `missing/`, so only the filename can match.
  const { resolve, onFileOpen } = setup(readmeTree);
  resolve('missing/README.md');
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], `${ROOT}/README.md`);
});

/**
 * Regression guard: the project folder's own name never lets a root file take
 * a nested match.
 *
 * Suffixes were matched against absolute paths, which include the project
 * folder. In a project at `/home/u/tokio`, `tokio/Cargo.toml` fit both
 * `/home/u/tokio/tokio/Cargo.toml` and `/home/u/tokio/Cargo.toml`, and the
 * shallower root file won.
 */

// The resolver sends only the project id, so these trees can live under roots
// of their own. Both keep the server order: directories first, then files.
const TOKIO_ROOT = '/home/u/tokio';
const tokioCargoFile = (dir: string) => ({
  type: 'file',
  name: 'Cargo.toml',
  path: dir ? `${TOKIO_ROOT}/${dir}/Cargo.toml` : `${TOKIO_ROOT}/Cargo.toml`,
});
const tokioTree = [
  { type: 'directory', name: 'benches', path: `${TOKIO_ROOT}/benches`, children: [tokioCargoFile('benches')] },
  { type: 'directory', name: 'tokio', path: `${TOKIO_ROOT}/tokio`, children: [tokioCargoFile('tokio')] },
  tokioCargoFile(''),
];

const VITE_ROOT = '/home/u/vite';
const viteTree = [
  {
    type: 'directory',
    name: 'packages',
    path: `${VITE_ROOT}/packages`,
    children: [
      {
        type: 'directory',
        name: 'vite',
        path: `${VITE_ROOT}/packages/vite`,
        children: [{ type: 'file', name: 'package.json', path: `${VITE_ROOT}/packages/vite/package.json` }],
      },
    ],
  },
  { type: 'file', name: 'package.json', path: `${VITE_ROOT}/package.json` },
];

test('a path into a folder named like the project opens the nested file, not the root one', async () => {
  const { resolve, onFileOpen } = setup(tokioTree);
  resolve('tokio/Cargo.toml');
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], `${TOKIO_ROOT}/tokio/Cargo.toml`);

  // The bare filename still opens the root one.
  const second = setup(tokioTree);
  second.resolve('Cargo.toml');
  await waitFor(() => assert.equal(second.onFileOpen.mock.calls.length, 1));
  assert.equal(second.onFileOpen.mock.calls[0][0], `${TOKIO_ROOT}/Cargo.toml`);
});

test('a partial path into a folder named like the project opens the nested file', async () => {
  const { resolve, onFileOpen } = setup(viteTree);
  resolve('vite/package.json');
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], `${VITE_ROOT}/packages/vite/package.json`);
});

test('a reference that starts with the project folder\'s name still opens the file it names', async () => {
  // No folder inside the project is called `personal`, so only the absolute
  // path fits; the filename alone would pick the root README.md.
  const { resolve, onFileOpen } = setup(readmeTree);
  resolve('personal/docs/README.md');
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], `${ROOT}/docs/README.md`);
});
