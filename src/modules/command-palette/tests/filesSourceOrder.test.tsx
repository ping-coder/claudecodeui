import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

/**
 * Regression guard: the palette kept only the first 500 files of the tree, so
 * deeper files could not be found; before that, collecting them depth first let
 * one deep folder crowd out CLAUDE.md and README.md. A project the server
 * refuses as too large (413) showed no files and no reason.
 */

const ROOT = '/home/u/project';

const deepFiles = Array.from({ length: 600 }, (_, index) => ({
  type: 'file',
  name: `file-${index}.ts`,
  path: `${ROOT}/deep/a/file-${index}.ts`,
}));

// Folders before files, the order the server sends every level in.
const tree = [
  {
    type: 'directory',
    name: 'deep',
    path: `${ROOT}/deep`,
    children: [{ type: 'directory', name: 'a', path: `${ROOT}/deep/a`, children: deepFiles }],
  },
  { type: 'file', name: 'CLAUDE.md', path: `${ROOT}/CLAUDE.md`, isIgnored: true },
  { type: 'file', name: 'README.md', path: `${ROOT}/README.md` },
];

const getFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { getFiles: (...args: unknown[]) => getFiles(...args) },
}));

const { useFilesSource } = await import('@/modules/command-palette/hooks/useFilesSource');

beforeEach(() => {
  getFiles.mockReset();
});

test('every file of the tree is kept, root files first', async () => {
  getFiles.mockResolvedValue({ ok: true, status: 200, json: async () => tree });

  const { result } = renderHook(() => useFilesSource('project-1', true));

  await waitFor(() => assert.equal(result.current.files.length, 602));
  assert.deepEqual(
    result.current.files.slice(0, 2).map((file) => [file.relativePath, file.isIgnored]),
    [['CLAUDE.md', true], ['README.md', false]],
  );
  assert.equal(result.current.files.at(-1)?.relativePath, 'deep/a/file-599.ts');
  assert.equal(result.current.files.at(-1)?.path, `${ROOT}/deep/a/file-599.ts`);
  assert.equal(result.current.tooLarge, false);
  // Gitignored files are asked for, so CLAUDE.md is there to be searched.
  assert.equal((getFiles.mock.calls[0]?.[1] as { markIgnored?: boolean } | undefined)?.markIgnored, true);
});

test('a 413 is reported as too large; any other failure is just no files', async () => {
  getFiles.mockResolvedValue({ ok: false, status: 413, json: async () => ({ error: 'Project file tree exceeds the 10,000 entry limit.' }) });
  const tooLarge = renderHook(() => useFilesSource('project-1', true));
  await waitFor(() => assert.equal(tooLarge.result.current.tooLarge, true));
  assert.equal(tooLarge.result.current.files.length, 0);

  getFiles.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
  const failed = renderHook(() => useFilesSource('project-2', true));
  await waitFor(() => assert.equal(getFiles.mock.calls.length, 2));
  // Lets the answer land.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(failed.result.current.tooLarge, false);
  assert.equal(failed.result.current.files.length, 0);
});

test('a failed response is judged by its status alone, so a 413 whose body is not JSON is still too large', async () => {
  // A proxy's HTML error page, say: reading it as JSON throws.
  const json = vi.fn(async () => {
    throw new SyntaxError('Unexpected token \'<\', "<html>" is not valid JSON');
  });
  getFiles.mockResolvedValue({ ok: false, status: 413, json });

  const { result } = renderHook(() => useFilesSource('project-1', true));

  await waitFor(() => assert.equal(result.current.tooLarge, true));
  assert.equal(result.current.files.length, 0);
  assert.equal(json.mock.calls.length, 0);
});

test('a mount\'s files are left out: they live outside the project, often in a large folder', async () => {
  getFiles.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => [
      {
        type: 'directory',
        name: 'mounts',
        path: `${ROOT}/mounts`,
        children: [
          {
            type: 'directory',
            name: 'videos',
            path: `${ROOT}/mounts/videos`,
            mount: { mountId: 'm1', name: 'videos', targetPath: '/mnt/videos', status: 'ok' },
            children: [{ type: 'file', name: 'take1.mov', path: `${ROOT}/mounts/videos/take1.mov`, inMount: true }],
          },
        ],
      },
      { type: 'file', name: 'README.md', path: `${ROOT}/README.md` },
    ],
  });

  const { result } = renderHook(() => useFilesSource('project-1', true));

  await waitFor(() => assert.equal(result.current.files.length > 0, true));
  assert.deepEqual(result.current.files.map((file) => file.relativePath), ['README.md']);
});
