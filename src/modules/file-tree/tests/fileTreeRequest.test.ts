import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { useFileTreeData } from '@/modules/file-tree/hooks/useFileTreeData';
import type { Project } from '@/shared/types';

/**
 * The explorer's listing request goes through the real API helper: it must ask
 * for gitignored entries to be marked, on top of the gitignore filtering every
 * listing asks for.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the file tree asks for gitignored entries to be marked rather than left out', async () => {
  const requestedUrls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requestedUrls.push(url);
    return new Response('[]', { status: 200 });
  }));
  const project: Project = { projectId: 'p1', displayName: 'project', fullPath: '/project', path: '/project' };

  renderHook(() => useFileTreeData(project));

  await waitFor(() => assert.equal(requestedUrls.length, 1));
  assert.equal(requestedUrls[0], '/api/file-tree/projects/p1/files?respectGitignore=true&markIgnored=true');
});
