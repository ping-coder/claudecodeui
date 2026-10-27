import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { WORKSPACE_LAYOUT_STORAGE_KEY } from '@/shared/constants';
import type { Project, ProjectSession, SessionEstablishedContext } from '@/shared/types';

/**
 * URL sync and the layout actions of the split workspace: what each action does to the layout and
 * to the URL (push for opens, replace for everything else), and how a URL change is turned back
 * into a layout change.
 */

const sessionDetailsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    sessionDetails: (sessionId: string) => sessionDetailsResponse(sessionId),
  },
}));

const sessionRow = (id: string): ProjectSession => ({ id, summary: `Title ${id}`, provider: 'claude' });

const buildProject = (projectId: string, sessionIds: string[]): Project => ({
  projectId,
  displayName: projectId.toUpperCase(),
  fullPath: `/${projectId}`,
  path: `/${projectId}`,
  sessions: sessionIds.map(sessionRow),
  sessionMeta: { total: sessionIds.length, hasMore: false },
});

const projectA = buildProject('pa', ['a1', 'a2', 'a3']);
const projectB = buildProject('pb', ['b1']);

const detailsFor = (sessionId: string, projectId = 'pa', canonicalId = sessionId) => ({
  ok: true,
  json: async () => ({
    data: {
      sessionId: canonicalId,
      provider: 'codex',
      summary: `Resolved ${canonicalId}`,
      project: { projectId, path: `/${projectId}`, fullPath: `/${projectId}`, displayName: projectId.toUpperCase() },
    },
  }),
});

type HarnessProps = {
  sessionId?: string;
  projects: Project[];
  isLoadingProjects: boolean;
  isMobile: boolean;
};

const renderNavigation = async (initial: Partial<HarnessProps> = {}) => {
  const [{ useWorkspaceLayout }, { useWorkspaceNavigation }] = await Promise.all([
    import('@/modules/project-workspace/hooks/useWorkspaceLayout'),
    import('@/modules/project-workspace/hooks/useWorkspaceNavigation'),
  ]);
  const navigate = vi.fn();
  const setSidebarOpen = vi.fn();
  const clearSessionAttention = vi.fn();
  const registerEstablishedSession = vi.fn((sessionId: string, context: SessionEstablishedContext): ProjectSession => ({
    id: sessionId,
    summary: context.summary ?? '',
    __provider: context.provider,
    __projectId: context.project.projectId,
  }));

  let props: HarnessProps = {
    sessionId: undefined,
    projects: [projectA, projectB],
    isLoadingProjects: false,
    isMobile: false,
    ...initial,
  };
  const view = renderHook((current: HarnessProps) => {
    const workspace = useWorkspaceLayout({ initialSessionId: current.sessionId });
    return useWorkspaceNavigation({
      workspace,
      sessionId: current.sessionId,
      navigate,
      projects: current.projects,
      isLoadingProjects: current.isLoadingProjects,
      isMobile: current.isMobile,
      setSidebarOpen,
      registerEstablishedSession,
      clearSessionAttention,
    });
  }, { initialProps: props });

  const update = (patch: Partial<HarnessProps>) => {
    props = { ...props, ...patch };
    act(() => {
      view.rerender(props);
    });
  };

  /** Plays the last navigate() back the way the router does: the URL param changes and the tree re-renders. */
  const followUrl = () => {
    const last = navigate.mock.calls.at(-1);
    if (!last) {
      return;
    }
    const path = last[0] as string;
    update({ sessionId: path.startsWith('/session/') ? path.slice('/session/'.length) : undefined });
  };

  return { ...view, navigate, setSidebarOpen, clearSessionAttention, registerEstablishedSession, update, followUrl };
};

const tabIds = (pane: { tabs: { sessionId: string | null; projectId: string; isPreview: boolean }[] } | null | undefined) =>
  pane?.tabs.map((tab) => `${tab.sessionId ?? `draft:${tab.projectId}`}${tab.isPreview ? '*' : ''}`) ?? null;

const rowOf = (project: Project, sessionId: string) => ({
  ...(project.sessions ?? []).find((session) => session.id === sessionId) as ProjectSession,
  __provider: 'claude' as const,
  __projectId: project.projectId,
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  sessionDetailsResponse.mockReset();
  sessionDetailsResponse.mockResolvedValue({ ok: false, status: 404 });
});

afterEach(() => {
  vi.resetModules();
});

test('a URL naming a session open on the other side only focuses that side, without navigating', async () => {
  const harness = await renderNavigation();
  act(() => {
    harness.result.current.actions.openSession(rowOf(projectA, 'a1'));
  });
  harness.followUrl();
  act(() => {
    harness.result.current.actions.openSession(rowOf(projectB, 'b1'), { target: 'other' });
  });
  harness.followUrl();
  act(() => {
    harness.result.current.actions.focusPane('left');
  });
  harness.followUrl();
  assert.equal(harness.result.current.layout.focusedSide, 'left');
  harness.navigate.mockClear();

  // Back: the URL returns to the right pane's session.
  harness.update({ sessionId: 'b1' });

  assert.equal(harness.result.current.layout.focusedSide, 'right');
  assert.deepEqual(tabIds(harness.result.current.layout.left), ['a1']);
  assert.deepEqual(tabIds(harness.result.current.layout.right), ['b1']);
  assert.deepEqual(harness.navigate.mock.calls, []);
});

test('a URL session missing from the loaded pages is looked up and opened as a preview', async () => {
  sessionDetailsResponse.mockImplementation(async (sessionId: string) => detailsFor(sessionId));
  const harness = await renderNavigation();

  harness.update({ sessionId: 'old-1' });

  await waitFor(() => {
    assert.deepEqual(tabIds(harness.result.current.layout.left), ['old-1*']);
  });
  assert.equal(harness.result.current.focused.session?.__provider, 'codex');
  assert.equal(harness.result.current.focused.session?.summary, 'Resolved old-1');
  assert.equal(harness.result.current.paneProjects.left?.projectId, 'pa');
  assert.deepEqual(harness.navigate.mock.calls, [], 'the URL already shows the session');
  assert.deepEqual(sessionDetailsResponse.mock.calls, [['old-1']]);
});

test('a URL holding a provider alias moves to the canonical id by replace', async () => {
  sessionDetailsResponse.mockImplementation(async (sessionId: string) => detailsFor(sessionId, 'pa', 'app-1'));
  const harness = await renderNavigation();

  harness.update({ sessionId: 'native-1' });

  await waitFor(() => {
    assert.deepEqual(tabIds(harness.result.current.layout.left), ['app-1*']);
  });
  assert.deepEqual(harness.navigate.mock.calls, [['/session/app-1', { replace: true }]]);
});

test('opens push the URL; focus, close and establishing a draft replace it', async () => {
  const harness = await renderNavigation();
  const { actions } = harness.result.current;

  act(() => {
    actions.openSession(rowOf(projectA, 'a1'));
  });
  harness.followUrl();
  act(() => {
    actions.openSession(rowOf(projectB, 'b1'), { target: 'other' });
  });
  harness.followUrl();
  act(() => {
    actions.focusPane('left');
  });
  harness.followUrl();
  const a1Key = harness.result.current.layout.left.tabs[0].key;
  act(() => {
    actions.closeTab('left', a1Key);
  });
  harness.followUrl();
  act(() => {
    actions.openNewSession(projectA);
  });
  harness.followUrl();
  act(() => {
    actions.establishDraft('new-1', { provider: 'claude', project: projectA, summary: 'First message' });
  });
  harness.followUrl();

  assert.deepEqual(harness.navigate.mock.calls, [
    ['/session/a1'],
    ['/session/b1'],
    ['/session/a1', { replace: true }],
    ['/session/b1', { replace: true }],
    ['/'],
    ['/session/new-1', { replace: true }],
  ]);
  assert.deepEqual(tabIds(harness.result.current.layout.left), ['b1', 'new-1']);
  assert.equal(harness.result.current.layout.right, null);
  assert.deepEqual(harness.registerEstablishedSession.mock.calls[0]?.[0], 'new-1');
});

test('going back to / leaves every pane as it was', async () => {
  const harness = await renderNavigation();
  act(() => {
    harness.result.current.actions.openSession(rowOf(projectA, 'a1'));
  });
  harness.followUrl();
  const layoutBefore = harness.result.current.layout;
  harness.navigate.mockClear();

  harness.update({ sessionId: undefined });

  assert.equal(harness.result.current.layout, layoutBefore);
  assert.deepEqual(harness.navigate.mock.calls, []);
});

test('a page opened on / with a session on screen writes it into the URL by replace', async () => {
  sessionStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify({
    version: 1,
    left: {
      tabs: [{ key: 'k1', sessionId: 'a2', projectId: 'pa', provider: 'claude', title: 'Title a2', view: 'chat', isPreview: false }],
      activeTabKey: 'k1',
      mru: ['k1'],
    },
    right: null,
    focusedSide: 'left',
    splitRatio: 0.5,
  }));

  const harness = await renderNavigation({ sessionId: undefined });

  assert.deepEqual(harness.navigate.mock.calls, [['/session/a2', { replace: true }]]);
});

test('with one project and nothing open, the first load starts a new chat in it', async () => {
  const harness = await renderNavigation({ projects: [], isLoadingProjects: true });
  harness.update({ projects: [projectA], isLoadingProjects: false });

  assert.deepEqual(tabIds(harness.result.current.layout.left), ['draft:pa']);
  assert.equal(harness.result.current.layout.left.draftActivation, 1);
  assert.deepEqual(harness.navigate.mock.calls, []);

  // Closing it later does not bring it back.
  act(() => {
    harness.result.current.actions.closeTab('left', harness.result.current.layout.left.tabs[0].key);
  });
  harness.update({ projects: [{ ...projectA }] });
  assert.deepEqual(tabIds(harness.result.current.layout.left), []);
});

test('no automatic new chat with several projects or when the URL names a session', async () => {
  const several = await renderNavigation({ projects: [], isLoadingProjects: true });
  several.update({ projects: [projectA, projectB], isLoadingProjects: false });
  assert.deepEqual(tabIds(several.result.current.layout.left), []);
  several.unmount();

  const deepLinked = await renderNavigation({ sessionId: 'a1', projects: [], isLoadingProjects: true });
  deepLinked.update({ projects: [projectA], isLoadingProjects: false });
  assert.deepEqual(tabIds(deepLinked.result.current.layout.left), ['a1*']);
});

test('on a phone, opening a session or a new chat closes the sidebar drawer', async () => {
  const phone = await renderNavigation({ isMobile: true });
  act(() => {
    phone.result.current.actions.openSession(rowOf(projectA, 'a1'), { preview: true });
  });
  assert.deepEqual(phone.setSidebarOpen.mock.calls, [[false]]);
  act(() => {
    phone.result.current.actions.openNewSession(projectB);
  });
  assert.deepEqual(phone.setSidebarOpen.mock.calls, [[false], [false]]);
  phone.unmount();

  const desktop = await renderNavigation({ isMobile: false });
  act(() => {
    desktop.result.current.actions.openSession(rowOf(projectA, 'a1'));
  });
  assert.deepEqual(desktop.setSidebarOpen.mock.calls, []);
});

test('a lookup overtaken by a newer navigation is dropped', async () => {
  let resolveLookup: ((value: unknown) => void) | null = null;
  sessionDetailsResponse.mockImplementation(() => new Promise((resolve) => {
    resolveLookup = resolve;
  }));
  const harness = await renderNavigation();

  harness.update({ sessionId: 'slow-1' });
  act(() => {
    harness.result.current.actions.openSession(rowOf(projectA, 'a1'));
  });
  await act(async () => {
    resolveLookup?.(detailsFor('slow-1'));
    await Promise.resolve();
  });

  assert.deepEqual(tabIds(harness.result.current.layout.left), ['a1']);
});

test('an unresolvable URL session opens a tab flagged as missing', async () => {
  const harness = await renderNavigation();

  harness.update({ sessionId: 'gone-1' });

  await waitFor(() => {
    assert.equal(harness.result.current.layout.left.tabs[0]?.isMissing, true);
  });
  assert.equal(harness.result.current.layout.left.tabs[0].sessionId, 'gone-1');
  assert.equal(harness.result.current.layout.left.tabs[0].projectId, '');
  assert.equal(harness.result.current.paneProjects.left, null);
});

test('a restored visible tab the loaded pages lack is looked up once; restored rows and stale drafts are reconciled', async () => {
  sessionStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify({
    version: 1,
    left: {
      tabs: [
        { key: 'k1', sessionId: 'a1', projectId: 'pa', provider: 'claude', title: 'stale', view: 'files', isPreview: false },
        { key: 'k2', sessionId: null, projectId: 'deleted-project', provider: 'claude', title: '', view: 'chat', isPreview: false },
      ],
      activeTabKey: 'k1',
      mru: ['k1'],
    },
    right: {
      tabs: [{ key: 'k3', sessionId: 'deep-1', projectId: 'pa', provider: 'claude', title: 'Deep', view: 'chat', isPreview: false }],
      activeTabKey: 'k3',
      mru: ['k3'],
    },
    focusedSide: 'right',
    splitRatio: 0.5,
  }));
  sessionDetailsResponse.mockImplementation(async (sessionId: string) => detailsFor(sessionId));

  const harness = await renderNavigation({ sessionId: 'deep-1', projects: [], isLoadingProjects: true });
  harness.update({ projects: [projectA, projectB], isLoadingProjects: false });

  await waitFor(() => {
    assert.equal(harness.result.current.layout.right?.tabs[0].session?.summary, 'Resolved deep-1');
  });
  assert.deepEqual(tabIds(harness.result.current.layout.left), ['a1'], 'the draft of a deleted project is pruned');
  assert.equal(harness.result.current.layout.left.tabs[0].title, 'Title a1', 'the restored snapshot takes the loaded row');
  assert.equal(harness.result.current.layout.left.tabs[0].view, 'files');

  harness.update({ projects: [{ ...projectA }, projectB] });
  assert.deepEqual(sessionDetailsResponse.mock.calls, [['deep-1']]);
});

test('sessions on screen lose their attention mark; a phone only sees the focused pane', async () => {
  const harness = await renderNavigation();
  act(() => {
    harness.result.current.actions.openSession(rowOf(projectA, 'a1'));
    harness.result.current.actions.openSession(rowOf(projectB, 'b1'), { target: 'other' });
  });
  const cleared = harness.clearSessionAttention.mock.calls.map(([sessionId]) => sessionId);
  assert.ok(cleared.includes('a1') && cleared.includes('b1'));
  assert.deepEqual([...harness.result.current.visibleSessionIds].sort(), ['a1', 'b1']);

  harness.update({ isMobile: true });
  assert.deepEqual([...harness.result.current.visibleSessionIds], ['b1']);
});

test('a session opened without a project is resolved from the loaded pages and keeps its search target', async () => {
  const harness = await renderNavigation();

  act(() => {
    harness.result.current.actions.openSession({ id: 'a2', __provider: 'claude', __searchTargetSnippet: 'needle' });
  });

  assert.deepEqual(tabIds(harness.result.current.layout.left), ['a2']);
  assert.equal(harness.result.current.layout.left.tabs[0].projectId, 'pa');
  assert.equal(harness.result.current.focused.session?.__searchTargetSnippet, 'needle');
  assert.equal(harness.result.current.focused.session?.summary, 'Title a2');
  assert.deepEqual(sessionDetailsResponse.mock.calls, []);
});

test('pane projects and placements keep their identity across a focus switch and a session-only refresh', async () => {
  const harness = await renderNavigation();
  act(() => {
    harness.result.current.actions.openSession(rowOf(projectA, 'a1'));
    harness.result.current.actions.openSession(rowOf(projectB, 'b1'), { target: 'other' });
  });
  const { paneProjects, sessionPlacements } = harness.result.current;
  assert.equal(paneProjects.left?.projectId, 'pa');
  assert.equal(paneProjects.right?.projectId, 'pb');
  assert.deepEqual([...sessionPlacements], [['a1', 'left'], ['b1', 'right']]);

  act(() => {
    harness.result.current.actions.focusPane('left');
  });
  harness.update({ projects: [{ ...projectA, sessions: [...(projectA.sessions ?? []), sessionRow('a9')] }, projectB] });

  assert.equal(harness.result.current.paneProjects, paneProjects);
  assert.equal(harness.result.current.sessionPlacements, sessionPlacements);

  harness.update({ projects: [{ ...projectA, displayName: 'Renamed' }, projectB] });
  assert.equal(harness.result.current.paneProjects.left?.displayName, 'Renamed');
});

test('the new-chat default follows the focused pane, then the other pane, then the browsed project, then the first one', async () => {
  const harness = await renderNavigation();
  assert.equal(harness.result.current.fallbackProject?.projectId, 'pa');

  act(() => {
    harness.result.current.recordBrowsedProject(projectB);
  });
  assert.equal(harness.result.current.fallbackProject?.projectId, 'pb');

  act(() => {
    harness.result.current.actions.openSession(rowOf(projectA, 'a1'));
  });
  assert.equal(harness.result.current.fallbackProject?.projectId, 'pa');

  act(() => {
    harness.result.current.actions.split();
  });
  assert.equal(harness.result.current.layout.focusedSide, 'right');
  assert.equal(harness.result.current.fallbackProject?.projectId, 'pa', 'an empty focused pane falls back to the other pane');
});

test('a project title click records the browsed project without touching any pane or the URL', async () => {
  const harness = await renderNavigation();
  act(() => {
    harness.result.current.actions.openSession(rowOf(projectA, 'a1'));
  });
  const layoutBefore = harness.result.current.layout;
  harness.navigate.mockClear();

  act(() => {
    harness.result.current.recordBrowsedProject(projectB);
  });

  assert.equal(harness.result.current.layout, layoutBefore);
  assert.deepEqual(harness.navigate.mock.calls, []);
});

// ---------------------------------------------------------------- review fixes

const unavailable = { ok: false, status: 503 };

test('a partial session object (a dropped row, a fork) takes its title and fields from the loaded row', async () => {
  const harness = await renderNavigation();

  act(() => {
    harness.result.current.actions.openSession({ id: 'a2', __projectId: 'pa', __provider: 'claude' }, { target: 'left', preview: false });
  });

  // The header and the browser tab read this object: no "New Session" for a titled conversation.
  assert.equal(harness.result.current.focused.session?.summary, 'Title a2');
  assert.equal(harness.result.current.layout.left.tabs[0].title, 'Title a2');
  assert.equal(harness.result.current.focused.session?.__projectId, 'pa');
});

test('a background open (a fork) resolves its project from its own row, keeps the focus and leaves a pending open alone', async () => {
  let resolveUserLookup: ((value: unknown) => void) | null = null;
  sessionDetailsResponse.mockImplementation(() => new Promise((resolve) => {
    resolveUserLookup = resolve;
  }));
  const harness = await renderNavigation();
  act(() => {
    harness.result.current.actions.openSession(rowOf(projectA, 'a1'));
    harness.result.current.actions.openSession(rowOf(projectB, 'b1'), { target: 'other' });
    harness.result.current.actions.focusPane('left');
  });
  // The user opens a conversation that needs a lookup.
  act(() => {
    harness.result.current.actions.openSessionById('old-7');
  });
  harness.navigate.mockClear();

  // The fork of a3 comes back to the right pane: no project or provider handed over.
  act(() => {
    harness.result.current.actions.openSession({ id: 'a3' }, { target: 'right', preview: false, inBackground: true });
  });
  const forkTab = harness.result.current.layout.right?.tabs.find((tab) => tab.sessionId === 'a3');
  assert.equal(forkTab?.projectId, 'pa', 'the project its row names, not the pane\'s');
  assert.equal(harness.result.current.layout.focusedSide, 'left', 'the focus stays where the user is');
  assert.deepEqual(harness.navigate.mock.calls, [], 'the URL follows the focused pane only');

  await act(async () => {
    resolveUserLookup?.(detailsFor('old-7'));
    await Promise.resolve();
  });
  await waitFor(() => {
    assert.equal(harness.result.current.layout.left.tabs.some((tab) => tab.sessionId === 'old-7'), true, 'the user\'s open was not cancelled');
  });
});

test('a session established from a draft that was closed meanwhile changes no pane', async () => {
  const harness = await renderNavigation();
  act(() => {
    harness.result.current.actions.openNewSession(projectA);
  });
  const draftKey = harness.result.current.layout.left.tabs[0].key;
  act(() => {
    harness.result.current.actions.closeTab('left', draftKey);
    harness.result.current.actions.openNewSession(projectA);
  });
  const layoutBefore = harness.result.current.layout;
  harness.navigate.mockClear();

  act(() => {
    harness.result.current.actions.establishDraft('late-1', { provider: 'claude', project: projectA, summary: 'Late' }, { draftTabKey: draftKey });
  });

  assert.equal(harness.result.current.layout, layoutBefore, 'the new blank chat stays blank');
  assert.deepEqual(harness.navigate.mock.calls, []);
  assert.equal(harness.registerEstablishedSession.mock.calls.length, 1, 'the session still reaches the sidebar');
});

test('a tab flagged missing after a failed lookup comes back once the loaded pages list its session', async () => {
  sessionDetailsResponse.mockResolvedValue(unavailable);
  const harness = await renderNavigation({ projects: [projectA, projectB] });

  harness.update({ sessionId: 'late-row' });
  await waitFor(() => {
    assert.equal(harness.result.current.layout.left.tabs[0]?.isMissing, true);
  });
  const lookups = sessionDetailsResponse.mock.calls.length;

  harness.update({ projects: [buildProject('pa', ['a1', 'a2', 'a3', 'late-row']), projectB] });

  const tab = harness.result.current.layout.left.tabs[0];
  assert.equal(tab.isMissing, undefined);
  assert.equal(tab.projectId, 'pa');
  assert.equal(harness.result.current.paneProjects.left?.projectId, 'pa');
  assert.equal(sessionDetailsResponse.mock.calls.length, lookups, 'no request needed');
});

test('reopening a missing tab\'s session from the sidebar or by id brings the conversation back', async () => {
  const harness = await renderNavigation();
  harness.update({ sessionId: 'a2-gone' });
  await waitFor(() => {
    assert.equal(harness.result.current.layout.left.tabs[0]?.isMissing, true);
  });

  // From a sidebar row, which names the project.
  act(() => {
    harness.result.current.actions.openSession({ id: 'a2-gone', summary: 'Found again', __projectId: 'pa', __provider: 'claude' }, { preview: true });
  });
  let tab = harness.result.current.layout.left.tabs[0];
  assert.equal(tab.isMissing, undefined);
  assert.equal(tab.projectId, 'pa');
  assert.equal(harness.result.current.layout.left.tabs.length, 1, 'the same tab, not a second one');

  // By id (palette, notification): the flagged tab is looked past, the loaded row found.
  act(() => {
    harness.result.current.commit({ type: 'markMissing', sessionId: 'a1-flag' });
    harness.result.current.actions.openSession(rowOf(projectA, 'a1'));
    harness.result.current.commit({ type: 'markMissing', sessionId: 'a1' });
  });
  assert.equal(harness.result.current.layout.left.tabs.find((candidate) => candidate.sessionId === 'a1')?.isMissing, true);
  act(() => {
    harness.result.current.actions.openSessionById('a1');
  });
  tab = harness.result.current.layout.left.tabs.find((candidate) => candidate.sessionId === 'a1') as typeof tab;
  assert.equal(tab.isMissing, undefined);
});

test('opening a missing deep-linked session by id asks again instead of reviving the stranded tab as it is', async () => {
  const harness = await renderNavigation();
  harness.update({ sessionId: 'gone-2' });
  await waitFor(() => {
    assert.equal(harness.result.current.layout.left.tabs[0]?.isMissing, true);
  });
  assert.equal(harness.result.current.layout.left.tabs[0].projectId, '', 'a stranded tab knows no project');

  // The server answers now (it was restarting): a palette or notification open finds the session.
  sessionDetailsResponse.mockImplementation(async (sessionId: string) => detailsFor(sessionId));
  act(() => {
    harness.result.current.actions.openSessionById('gone-2');
  });

  await waitFor(() => {
    assert.equal(harness.result.current.layout.left.tabs[0].isMissing, undefined);
  });
  assert.equal(harness.result.current.layout.left.tabs[0].projectId, 'pa');
  assert.equal(harness.result.current.layout.left.tabs.length, 1);
});

test('a titled session opened with its project is never looked up, so a failing lookup cannot flag it missing', async () => {
  sessionDetailsResponse.mockResolvedValue(unavailable);
  const harness = await renderNavigation();

  act(() => {
    harness.result.current.actions.openSession({ id: 'older-1', summary: 'Older chat', __projectId: 'pa', __provider: 'claude' }, { preview: true });
  });
  await act(async () => {
    await Promise.resolve();
  });

  assert.deepEqual(sessionDetailsResponse.mock.calls, []);
  assert.equal(harness.result.current.layout.left.tabs[0].isMissing, undefined);
});

test('an untitled row opened with its project (a search hit the loaded pages lack) is looked up once for its title', async () => {
  sessionDetailsResponse.mockResolvedValue(unavailable);
  const harness = await renderNavigation();

  // What the sidebar's search and Conversations rows hand over for a session past the loaded page.
  act(() => {
    harness.result.current.actions.openSession(
      { id: 'old-1', __provider: 'claude', __searchTargetSnippet: 'needle', __projectId: 'pa' },
      { preview: true },
    );
  });
  await waitFor(() => {
    assert.equal(sessionDetailsResponse.mock.calls.length, 1);
  });
  await act(async () => {
    await Promise.resolve();
  });
  assert.equal(harness.result.current.layout.left.tabs[0].isMissing, undefined, 'a 503 says nothing about the session');
  assert.equal(harness.result.current.layout.left.tabs[0].title, '');

  // On screen again later, it is asked again, and the title lands in the tab and in the session the header reads.
  sessionDetailsResponse.mockImplementation(async (sessionId: string) => detailsFor(sessionId));
  act(() => {
    harness.result.current.actions.openSession(rowOf(projectA, 'a1'), { preview: false });
  });
  act(() => {
    harness.result.current.actions.openSession({ id: 'old-1', __provider: 'claude', __projectId: 'pa' }, { preview: true });
  });
  await waitFor(() => {
    assert.equal(harness.result.current.focused.tab?.title, 'Resolved old-1');
  });
  assert.equal(harness.result.current.focused.session?.summary, 'Resolved old-1');
  assert.equal(harness.result.current.focused.tab?.projectId, 'pa');
  assert.deepEqual(sessionDetailsResponse.mock.calls.map(([sessionId]) => sessionId), ['old-1', 'old-1']);
});

test('a restored tab whose lookup could not reach the server stays as it is and is asked again later', async () => {
  sessionStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify({
    version: 1,
    left: {
      tabs: [
        { key: 'k1', sessionId: 'deep-1', projectId: 'pa', provider: 'claude', title: 'Deep', view: 'chat', isPreview: false },
        { key: 'k2', sessionId: 'a1', projectId: 'pa', provider: 'claude', title: 'A1', view: 'chat', isPreview: false },
      ],
      activeTabKey: 'k1',
      mru: ['k1'],
    },
    right: null,
    focusedSide: 'left',
    splitRatio: 0.5,
  }));
  sessionDetailsResponse.mockResolvedValue(unavailable);
  const harness = await renderNavigation({ sessionId: 'deep-1' });

  await waitFor(() => {
    assert.equal(sessionDetailsResponse.mock.calls.length, 1);
  });
  await act(async () => {
    await Promise.resolve();
  });
  assert.equal(harness.result.current.layout.left.tabs[0].isMissing, undefined, 'a 503 says nothing about the session');

  // Shown again later, it is asked again, and a real answer lands.
  sessionDetailsResponse.mockImplementation(async (sessionId: string) => detailsFor(sessionId));
  act(() => {
    harness.result.current.actions.activateTab('left', 'k2');
  });
  act(() => {
    harness.result.current.actions.activateTab('left', 'k1');
  });
  await waitFor(() => {
    assert.equal(harness.result.current.layout.left.tabs[0].session?.summary, 'Resolved deep-1');
  });
});

test('clicking the session on screen while the URL sits on / puts it back into the URL', async () => {
  const harness = await renderNavigation();
  act(() => {
    harness.result.current.actions.openSession(rowOf(projectA, 'a1'));
  });
  harness.followUrl();
  // Forward/Back landed on / while the pane still shows a1.
  harness.update({ sessionId: undefined });
  harness.navigate.mockClear();

  act(() => {
    harness.result.current.actions.openSession(rowOf(projectA, 'a1'), { preview: true });
  });
  assert.deepEqual(harness.navigate.mock.calls, [['/session/a1']]);
  harness.followUrl();

  harness.update({ sessionId: undefined });
  harness.navigate.mockClear();
  act(() => {
    harness.result.current.actions.activateTab('left', harness.result.current.layout.left.tabs[0].key);
  });
  assert.deepEqual(harness.navigate.mock.calls, [['/session/a1', { replace: true }]]);
});

test('a deep link opened in a new browser tab leaves the shared seed alone until the user changes something', async () => {
  const seed = JSON.stringify({
    version: 1,
    left: { tabs: [{ key: 's1', sessionId: 'b1', projectId: 'pb', provider: 'claude', title: 'B1', view: 'chat', isPreview: false }], activeTabKey: 's1', mru: ['s1'] },
    right: { tabs: [{ key: 's2', sessionId: 'a2', projectId: 'pa', provider: 'claude', title: 'A2', view: 'chat', isPreview: false }], activeTabKey: 's2', mru: ['s2'] },
    focusedSide: 'left',
    splitRatio: 0.4,
  });
  localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, seed);
  const harness = await renderNavigation({ sessionId: 'a3' });

  await waitFor(() => {
    assert.deepEqual(tabIds(harness.result.current.layout.left), ['a3*']);
  });
  await new Promise((resolve) => {
    setTimeout(resolve, 400);
  });
  assert.equal(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY), seed, 'opening the link is not a change of the user\'s');
  assert.ok(sessionStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)?.includes('a3'), 'the tab keeps its own copy');

  act(() => {
    harness.result.current.actions.openSession(rowOf(projectA, 'a1'));
  });
  await new Promise((resolve) => {
    setTimeout(resolve, 400);
  });
  assert.ok(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)?.includes('a1'), 'a change the user made does reach it');
});

test('merging keeps the conversation of the focused pane on screen and in the URL', async () => {
  const harness = await renderNavigation();
  act(() => {
    harness.result.current.actions.openSession(rowOf(projectA, 'a1'));
  });
  harness.followUrl();
  act(() => {
    harness.result.current.actions.openSession(rowOf(projectB, 'b1'), { target: 'other' });
  });
  harness.followUrl();
  harness.navigate.mockClear();

  act(() => {
    harness.result.current.actions.toggleSplit();
  });

  assert.equal(harness.result.current.layout.right, null);
  assert.equal(harness.result.current.focused.session?.id, 'b1');
  assert.deepEqual(tabIds(harness.result.current.layout.left), ['a1', 'b1']);
  assert.deepEqual(harness.navigate.mock.calls, [], 'the URL already shows b1');
});

test('a split too narrow for two panes counts only the focused pane\'s session as on screen', async () => {
  const harness = await renderNavigation();
  act(() => {
    harness.result.current.actions.openSession(rowOf(projectA, 'a1'));
    harness.result.current.actions.openSession(rowOf(projectB, 'b1'), { target: 'other' });
  });
  assert.deepEqual([...harness.result.current.visibleSessionIds].sort(), ['a1', 'b1']);

  act(() => {
    harness.result.current.setCanShowBothPanes(false);
  });
  assert.deepEqual([...harness.result.current.visibleSessionIds], ['b1']);
});

test('the new-chat fallback keeps its object across a refresh that only touched session rows', async () => {
  const harness = await renderNavigation();
  const fallback = harness.result.current.fallbackProject;
  assert.equal(fallback?.projectId, 'pa');

  harness.update({ projects: [{ ...projectA, sessions: [...(projectA.sessions ?? []), sessionRow('a9')] }, projectB] });
  assert.equal(harness.result.current.fallbackProject, fallback, 'what reads it (the quick settings\' commands) does not reload');

  harness.update({ projects: [{ ...projectA, displayName: 'Renamed' }, projectB] });
  assert.equal(harness.result.current.fallbackProject?.displayName, 'Renamed');
});

test('an archived session keeps its project through the unlisted cache, from the sidebar or from a deep link', async () => {
  const archived = buildProject('old', []);
  const harness = await renderNavigation();
  act(() => {
    harness.result.current.actions.openSession({ id: 'arch-1', summary: 'Archived chat', __provider: 'claude' }, { ownerProject: archived });
  });
  assert.equal(harness.result.current.paneProjects.left?.projectId, 'old');
  assert.equal(harness.result.current.focused.project?.projectId, 'old');

  sessionDetailsResponse.mockImplementation(async (sessionId: string) => detailsFor(sessionId, 'old-2'));
  const linked = await renderNavigation({ sessionId: 'arch-2' });
  await waitFor(() => {
    assert.equal(linked.result.current.paneProjects.left?.projectId, 'old-2');
  });
});

test('a restored draft of a browsed, unlisted project survives the first load', async () => {
  sessionStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify({
    version: 1,
    left: {
      tabs: [
        { key: 'k1', sessionId: 'a1', projectId: 'pa', provider: 'claude', title: 'A1', view: 'chat', isPreview: false },
        { key: 'k2', sessionId: null, projectId: 'old', provider: 'claude', title: '', view: 'chat', isPreview: false },
      ],
      activeTabKey: 'k1',
      mru: ['k1'],
    },
    right: null,
    focusedSide: 'left',
    splitRatio: 0.5,
  }));
  const harness = await renderNavigation({ projects: [], isLoadingProjects: true });
  act(() => {
    harness.result.current.recordBrowsedProject(buildProject('old', []));
  });

  harness.update({ projects: [projectA, projectB], isLoadingProjects: false });
  assert.deepEqual(tabIds(harness.result.current.layout.left), ['a1', 'draft:old']);
});

test('a restored visible tab that turns out to be an alias moves to the canonical id, and so does the URL', async () => {
  sessionStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify({
    version: 1,
    left: {
      tabs: [{ key: 'k1', sessionId: 'native-9', projectId: 'pa', provider: 'claude', title: 'Native', view: 'chat', isPreview: false }],
      activeTabKey: 'k1',
      mru: ['k1'],
    },
    right: null,
    focusedSide: 'left',
    splitRatio: 0.5,
  }));
  sessionDetailsResponse.mockImplementation(async (sessionId: string) => detailsFor(sessionId, 'pa', 'app-9'));
  const harness = await renderNavigation({ sessionId: 'native-9' });

  await waitFor(() => {
    assert.deepEqual(tabIds(harness.result.current.layout.left), ['app-9']);
  });
  assert.equal(harness.result.current.layout.left.tabs[0].isMissing, undefined);
  assert.deepEqual(harness.navigate.mock.calls.at(-1), ['/session/app-9', { replace: true }]);
});

test('on a phone, opening a session by id (a notification, the palette) closes the sidebar drawer', async () => {
  const phone = await renderNavigation({ isMobile: true });
  act(() => {
    phone.result.current.actions.openSessionById('a1');
  });
  assert.deepEqual(phone.setSidebarOpen.mock.calls, [[false]]);
});
