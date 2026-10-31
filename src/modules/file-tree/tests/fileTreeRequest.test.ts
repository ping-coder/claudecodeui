import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
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

test('a refresh the user asks for asks for the mounts to be walked again; a reload after a change does not', async () => {
  const requestedUrls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requestedUrls.push(url);
    return new Response('[]', { status: 200 });
  }));
  const project: Project = { projectId: 'p1', displayName: 'project', fullPath: '/project', path: '/project' };

  const { result } = renderHook(() => useFileTreeData(project));
  await waitFor(() => assert.equal(requestedUrls.length, 1));
  await waitFor(() => assert.equal(result.current.loading, false));

  act(() => result.current.refreshFilesFresh());
  await waitFor(() => assert.equal(requestedUrls.length, 2));
  assert.equal(requestedUrls[1], '/api/file-tree/projects/p1/files?respectGitignore=true&markIgnored=true&fresh=true');
  await waitFor(() => assert.equal(result.current.refreshing, false));

  act(() => result.current.refreshFiles());
  await waitFor(() => assert.equal(requestedUrls.length, 3));
  assert.equal(requestedUrls[2], '/api/file-tree/projects/p1/files?respectGitignore=true&markIgnored=true');
});
