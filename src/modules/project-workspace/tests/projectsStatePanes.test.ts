import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';

/**
 * useProjectsState with two panes: the websocket handling, renames, deletes and TaskMaster
 * hydration reach every pane, and the sidebar's handlers act on the focused one.
 */

const projectsResponse = vi.fn();
const renameSessionResponse = vi.fn();
const projectTaskmasterResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    renameSession: (...args: unknown[]) => renameSessionResponse(...args),
    projectTaskmaster: (projectId: string) => projectTaskmasterResponse(projectId),
    sessionDetails: () => Promise.resolve({ ok: false }),
    projectSessions: () => Promise.resolve({ ok: false }),
  },
}));

const buildProject = (projectId: string, sessionIds: string[]): Project => ({
  projectId,
  path: `/${projectId}`,
  fullPath: `/${projectId}`,
  displayName: projectId.toUpperCase(),
  isStarred: false,
  sessions: sessionIds.map((id) => ({ id, summary: `Title ${id}`, provider: 'claude' })),
  sessionMeta: { hasMore: false, total: sessionIds.length },
});

const projectA = buildProject('pa', ['a1', 'a2']);
const projectB = buildProject('pb', ['b1']);

type ServerEventListener = (event: Record<string, unknown>) => void;

const listeners = new Set<ServerEventListener>();
const subscribe = vi.fn((listener: ServerEventListener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
});

const emit = (event: Record<string, unknown>) => {
  for (const listener of listeners) {
    listener(event);
  }
};

const upsertFor = (sessionId: string, projectId: string) => ({
  kind: 'session_upserted',
  sessionId,
  providerSessionId: null,
  provider: 'claude',
  session: { id: sessionId, summary: `Title ${sessionId}`, lastActivity: '2026-10-27T00:00:00.000Z' },
  project: { projectId, path: `/${projectId}`, fullPath: `/${projectId}`, displayName: projectId.toUpperCase(), isStarred: false },
  timestamp: '2026-10-27T00:00:00.000Z',
});

type HookProps = { sessionId?: string; navigate: ReturnType<typeof vi.fn> };

const renderProjectsState = async (processingSessionIds: ReadonlySet<string> = new Set()) => {
  const { useProjectsState } = await import('@/modules/project-workspace/hooks/useProjectsState');
  const navigate = vi.fn();
  const view = renderHook((props: HookProps) => useProjectsState({
    sessionId: props.sessionId,
    navigate: props.navigate as never,
    subscribe: subscribe as never,
    isMobile: false,
    isSessionProcessing: (sessionId) => Boolean(sessionId && processingSessionIds.has(sessionId)),
  }), { initialProps: { sessionId: undefined, navigate } as HookProps });

  await waitFor(() => {
    assert.equal(view.result.current.projects.length, 2);
  });
  return { ...view, navigate };
};

const rowOf = (project: Project, sessionId: string): ProjectSession => ({
  ...(project.sessions ?? []).find((session) => session.id === sessionId) as ProjectSession,
  __provider: 'claude',
  __projectId: project.projectId,
});

/** a1 on the left, b1 on the right (focused). */
const openBothPanes = (result: { current: Awaited<ReturnType<typeof renderProjectsState>>['result']['current'] }) => {
  act(() => {
    result.current.actions.openSession(rowOf(projectA, 'a1'));
  });
  act(() => {
    result.current.actions.openSession(rowOf(projectB, 'b1'), { target: 'other' });
  });
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  listeners.clear();
  subscribe.mockClear();
  projectsResponse.mockReset();
  projectsResponse.mockResolvedValue({ ok: true, json: async () => [projectA, projectB] });
  renameSessionResponse.mockReset();
  projectTaskmasterResponse.mockReset();
  projectTaskmasterResponse.mockResolvedValue({ ok: false });
});

afterEach(() => {
  vi.resetModules();
});

test('sessions on screen in either pane never get the attention mark; background ones do', async () => {
  const { result } = await renderProjectsState();
  openBothPanes(result);

  act(() => {
    emit({ kind: 'permission_request', sessionId: 'a1' });
    emit({ kind: 'permission_request', sessionId: 'b1' });
    emit({ kind: 'permission_request', sessionId: 'a2' });
  });

  assert.deepEqual([...result.current.attentionSessionIds], ['a2']);
});

test('an external change reloads only the pane showing the session', async () => {
  const { result } = await renderProjectsState(new Set(['a1']));
  openBothPanes(result);

  act(() => {
    emit(upsertFor('b1', 'pb'));
  });
  assert.equal(result.current.layout.right?.externalRevision, 1);
  assert.equal(result.current.layout.left.externalRevision, 0);

  // A session with a run in flight here streams its own changes; a background one only gets the dot.
  act(() => {
    emit(upsertFor('a1', 'pa'));
    emit(upsertFor('a2', 'pa'));
  });
  assert.equal(result.current.layout.left.externalRevision, 0);
  assert.deepEqual([...result.current.attentionSessionIds], ['a2']);
});

test('a rename and a delete reach every tab of the session, in both panes', async () => {
  renameSessionResponse.mockResolvedValue({ ok: true, json: async () => ({}) });
  const { result } = await renderProjectsState();
  act(() => {
    result.current.actions.openSession(rowOf(projectA, 'a1'));
  });
  act(() => {
    result.current.actions.openSession(rowOf(projectA, 'a1'), { target: 'right' });
  });
  assert.equal(result.current.layout.right?.tabs[0].sessionId, 'a1');

  await act(async () => {
    await result.current.renameSession('a1', 'Renamed everywhere');
  });
  for (const pane of [result.current.layout.left, result.current.layout.right]) {
    assert.equal(pane?.tabs[0].title, 'Renamed everywhere');
    assert.equal(pane?.tabs[0].session?.summary, 'Renamed everywhere');
  }

  act(() => {
    result.current.handleSessionDelete('a1');
  });
  assert.deepEqual(result.current.layout.left.tabs, []);
  assert.equal(result.current.layout.right, null);
  assert.deepEqual(result.current.projects[0].sessions?.map((session) => session.id), ['a2']);
});

test('deleting a project closes its tabs in both panes', async () => {
  const { result } = await renderProjectsState();
  openBothPanes(result);
  act(() => {
    result.current.actions.openSession(rowOf(projectA, 'a2'), { target: 'right' });
  });

  act(() => {
    result.current.handleProjectDelete('pa');
  });

  assert.deepEqual(result.current.layout.left.tabs.map((tab) => tab.sessionId), ['b1']);
  assert.equal(result.current.layout.right, null);
  assert.deepEqual(result.current.projects.map((project) => project.projectId), ['pb']);
});

test('TaskMaster details are fetched for the projects of both panes', async () => {
  projectTaskmasterResponse.mockImplementation(async (projectId: string) => ({
    ok: true,
    json: async () => ({ taskmaster: { hasTaskmaster: true, status: `ready-${projectId}` } }),
  }));
  const { result } = await renderProjectsState();
  openBothPanes(result);

  await waitFor(() => {
    assert.equal(result.current.paneProjects.right?.taskmaster?.status, 'ready-pb');
  });
  assert.equal(result.current.paneProjects.left?.taskmaster?.status, 'ready-pa');
  assert.deepEqual(projectTaskmasterResponse.mock.calls.map(([projectId]) => projectId).sort(), ['pa', 'pb']);

  // Switching focus brings no project on screen, so nothing is fetched again.
  act(() => {
    result.current.actions.focusPane('left');
  });
  assert.equal(projectTaskmasterResponse.mock.calls.length, 2);
});

test('URL changes do not re-subscribe the websocket', async () => {
  const { result, rerender } = await renderProjectsState();
  openBothPanes(result);
  const subscriptions = subscribe.mock.calls.length;

  rerender({ sessionId: 'a1', navigate: vi.fn() });
  rerender({ sessionId: 'b1', navigate: vi.fn() });
  act(() => {
    result.current.actions.focusPane('left');
  });

  assert.equal(subscribe.mock.calls.length, subscriptions);
  assert.equal(listeners.size, 1);
});

test('the sidebar project click neither clears the focused session nor navigates', async () => {
  const { result, navigate } = await renderProjectsState();
  act(() => {
    result.current.sidebarSharedProps.onSessionSelect(rowOf(projectA, 'a1'));
  });
  const sessionBefore = result.current.selectedSession;
  navigate.mockClear();

  act(() => {
    result.current.sidebarSharedProps.onProjectSelect(projectB);
  });

  assert.equal(result.current.selectedSession, sessionBefore);
  assert.equal(result.current.selectedSession?.id, 'a1');
  assert.deepEqual(navigate.mock.calls, []);
  assert.equal(result.current.fallbackProject?.projectId, 'pa', 'the focused pane still wins over the browsed project');
});

test('the sidebar props follow the focused pane', async () => {
  const { result } = await renderProjectsState();
  openBothPanes(result);
  assert.equal(result.current.sidebarSharedProps.selectedSession?.id, 'b1');
  assert.equal(result.current.sidebarSharedProps.selectedProject?.projectId, 'pb');
  assert.equal(result.current.paneTargetingBase.isSplit, true);
  assert.equal(result.current.paneTargetingBase.focusedSide, 'right');
  const placements = result.current.paneTargetingBase.placements;

  act(() => {
    result.current.paneTargetingBase.onFocusSide('left');
  });

  assert.equal(result.current.sidebarSharedProps.selectedSession?.id, 'a1');
  assert.equal(result.current.sidebarSharedProps.selectedProject?.projectId, 'pa');
  assert.equal(result.current.focusedTabKey, result.current.layout.left.activeTabKey);
  assert.equal(result.current.paneTargetingBase.placements, placements, 'a focus switch leaves the row placements alone');
});

test('registering an optimistic session only writes projects; the command state acts on the focused tab', async () => {
  const { result } = await renderProjectsState();
  act(() => {
    result.current.actions.openSession(rowOf(projectA, 'a1'));
  });
  const layoutBefore = result.current.layout;

  act(() => {
    result.current.registerOptimisticSession({ sessionId: 'fresh', provider: 'codex', project: projectA, summary: 'Fresh' });
  });
  assert.equal(result.current.layout, layoutBefore);
  assert.equal(result.current.projects[0].sessions?.[0].id, 'fresh');

  act(() => {
    result.current.setActiveTab('git');
  });
  assert.equal(result.current.layout.left.tabs[0].view, 'git');
});
