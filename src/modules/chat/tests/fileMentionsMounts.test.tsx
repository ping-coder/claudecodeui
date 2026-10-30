import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { RefObject } from 'react';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * The `@` list offers the project's own files: a mount's files live in a folder outside the project,
 * often a large one, and are left out.
 */

const getFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { getFiles: (...args: unknown[]) => getFiles(...args) },
}));

const { useFileMentions } = await import('@/modules/chat/hooks/useFileMentions');

const ROOT = '/home/user/project';
const project: Project = { projectId: 'p1', displayName: 'project', fullPath: ROOT };

test('files inside a mount are not offered', async () => {
  getFiles.mockResolvedValue({
    ok: true,
    json: async () => [
      {
        type: 'directory',
        name: 'mounts',
        path: `${ROOT}/mounts`,
        children: [
          {
            type: 'directory',
            name: 'data',
            path: `${ROOT}/mounts/data`,
            mount: { mountId: 'm1', name: 'data', targetPath: '/mnt/data', status: 'ok' },
            children: [{ type: 'file', name: 'notes-big.csv', path: `${ROOT}/mounts/data/notes-big.csv`, inMount: true }],
          },
        ],
      },
      { type: 'file', name: 'notes.md', path: `${ROOT}/notes.md` },
    ],
  });

  const textareaRef: RefObject<HTMLTextAreaElement> = { current: null };
  const hook = renderHook(
    ({ input }: { input: string }) => useFileMentions({ selectedProject: project, input, setInput: vi.fn(), textareaRef }),
    { initialProps: { input: '' } },
  );
  await waitFor(() => assert.equal(getFiles.mock.calls.length, 1));

  hook.rerender({ input: '@notes' });
  act(() => {
    hook.result.current.setCursorPosition('@notes'.length);
  });

  await waitFor(() => assert.deepEqual(hook.result.current.filteredFiles.map((file) => file.name), ['notes.md']));
});
