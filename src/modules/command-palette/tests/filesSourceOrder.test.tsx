import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

/**
 * Regression guard: the palette keeps at most 500 files, and collecting them
 * depth first let one deep folder fill the budget before any root file, so
 * CLAUDE.md and README.md could not be found at all.
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

test('root files claim the budget before a deep folder that alone exceeds it', async () => {
  getFiles.mockResolvedValue({ ok: true, json: async () => tree });

  const { result } = renderHook(() => useFilesSource('project-1', true));

  await waitFor(() => assert.equal(result.current.length, 500));
  assert.deepEqual(
    result.current.slice(0, 2).map((file) => [file.relativePath, file.isIgnored]),
    [['CLAUDE.md', true], ['README.md', false]],
  );
  assert.equal(result.current[2]?.relativePath.startsWith('deep/a/'), true);
  assert.equal(result.current[2]?.path.startsWith(`${ROOT}/deep/a/`), true);
  // Gitignored files are asked for, so CLAUDE.md is there to be searched.
  assert.equal((getFiles.mock.calls[0]?.[1] as { markIgnored?: boolean } | undefined)?.markIgnored, true);
});
