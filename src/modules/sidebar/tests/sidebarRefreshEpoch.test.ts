import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * The workspace's Refresh all reloads the project list itself and moves the sidebar's refresh epoch: the
 * sidebar then reloads only its own lists, the archived ones and, while its tab is open, the recent
 * conversations. It never asks for the project list a second time.
 */

const { archivedProjects, archivedSessions, recentConversations } = vi.hoisted(() => ({
  archivedProjects: vi.fn(async () => ({ ok: true, json: async () => ({ data: { projects: [] } }) })),
  archivedSessions: vi.fn(async () => ({ ok: true, json: async () => ({ data: { sessions: [] } }) })),
  recentConversations: vi.fn(async () => ({ ok: true, json: async () => ({ data: { conversations: [], total: 0, hasMore: false } }) })),
}));

vi.mock('@/shared/api', () => ({
  api: {
    archivedProjects: () => archivedProjects(),
    getArchivedSessions: () => archivedSessions(),
    recentConversations: () => recentConversations(),
  },
}));

const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');

const t = ((key: string) => key) as unknown as TFunction;
const onRefresh = vi.fn();
// One identity for every render: a fresh array or set each render would rerun the controller's effects for ever.
const NO_PROJECTS: Project[] = [];
const NO_SESSIONS: ReadonlySet<string> = new Set();
const onProjectSelect = vi.fn();
const onSessionSelect = vi.fn();
const setSidebarVisible = vi.fn();

const renderController = () => renderHook(
  ({ refreshEpoch }: { refreshEpoch: number }) => useSidebarController({
    projects: NO_PROJECTS,
    selectedProject: null,
    selectedSession: null,
    activeSessions: NO_SESSIONS,
    backgroundSessionIds: NO_SESSIONS,
    isLoading: false,
    isMobile: false,
    t,
    onRefresh,
    refreshEpoch,
    onProjectSelect,
    onSessionSelect,
    setSidebarVisible,
    sidebarVisible: true,
  }),
  { initialProps: { refreshEpoch: 0 } },
);

beforeEach(() => {
  localStorage.clear();
  archivedProjects.mockClear();
  archivedSessions.mockClear();
  recentConversations.mockClear();
  onRefresh.mockClear();
});

test('a new refresh epoch reloads the archived lists, and the recent conversations only while their tab is open', async () => {
  const view = renderController();
  await waitFor(() => assert.equal(archivedProjects.mock.calls.length, 1, 'the first load'));

  view.rerender({ refreshEpoch: 1 });
  await waitFor(() => assert.equal(archivedProjects.mock.calls.length, 2));
  assert.equal(archivedSessions.mock.calls.length, 2);
  assert.equal(recentConversations.mock.calls.length, 0, 'the Conversations tab is closed');

  act(() => {
    view.result.current.setSearchMode('conversations');
  });
  await waitFor(() => assert.equal(recentConversations.mock.calls.length, 1, 'opening the tab loads it'));
  view.rerender({ refreshEpoch: 2 });
  await waitFor(() => assert.equal(recentConversations.mock.calls.length, 2));

  assert.equal(onRefresh.mock.calls.length, 0, 'the project list is not asked for again');
});
