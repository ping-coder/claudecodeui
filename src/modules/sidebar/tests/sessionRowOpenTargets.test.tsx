import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import type {
  ArchivedSessionListItem,
  ConversationSearchResults,
  Project,
  SessionOpenOptions,
  SessionWithProvider,
  SidebarConversationOpenRequest,
  SidebarPaneTargeting,
  SidebarProjectListProps,
  SidebarSearchMode,
} from '@/shared/types';
import { hasSessionDragPayload, readSessionDragPayload } from '@/shared/utils';

/**
 * Where each way of opening a conversation from the sidebar lands. A click
 * previews it in the focused pane, a double-click keeps it, Alt/Option+click or
 * Alt/Option+Enter sends it to the other side (an ordinary kept open where no
 * split is possible), and Ctrl/Cmd/Shift/middle clicks stay the browser's. A
 * drag carries the session for the workspace while staying a link for the rest
 * of the browser. Projects rows and Conversations rows follow the same rules;
 * search hits and archived sessions take a click or an Alt+click.
 */

const forkSessionRequest = vi.fn();
const archivedProjectsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    archivedProjects: () => archivedProjectsResponse(),
    getArchivedSessions: () => Promise.resolve({ ok: true, json: async () => ({ data: { sessions: [] } }) }),
    recentConversations: () => Promise.resolve({ ok: true, json: async () => ({ data: { conversations: [] } }) }),
    forkSession: (sessionId: string) => forkSessionRequest(sessionId),
  },
}));

// The row controls fetch provider capabilities; their own tests cover them.
vi.mock('@/modules/sidebar/SessionOptions', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarHeader', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarFooter', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarProjectList', () => ({ default: () => null }));

// One MediaQueryList is cached for the whole module, so the layout is chosen here.
let isCompactLayout = false;
vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({
  useCompactSidebar: () => isCompactLayout,
}));

const { default: SidebarSessionItem } = await import('@/modules/sidebar/SidebarSessionItem');
const { default: SidebarRecentConversations } = await import('@/modules/sidebar/SidebarRecentConversations');
const { default: SidebarProjectSessions } = await import('@/modules/sidebar/SidebarProjectSessions');
const { default: SidebarProjectItem } = await import('@/modules/sidebar/SidebarProjectItem');
const { default: SidebarContent } = await import('@/modules/sidebar/SidebarContent');
const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');

const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const NOW = new Date('2026-08-21T10:00:00.000Z');
const noop = () => {};
const NO_IDS: ReadonlySet<string> = new Set<string>();

const PROJECT = {
  projectId: 'project-1',
  name: 'project-1',
  displayName: 'project one',
  fullPath: '/repo',
  sessions: [{ id: 's1', summary: 'session one', lastActivity: '2026-08-21T09:00:00.000Z', __provider: 'claude' }],
} as unknown as Project;
const SESSION = { id: 's1', summary: 'session one', lastActivity: '2026-08-21T09:00:00.000Z', __provider: 'claude' } as unknown as SessionWithProvider;

/** jsdom has no DataTransfer; this keeps what a dragstart handler writes. */
const createDataTransfer = () => {
  const store = new Map<string, string>();
  return {
    get types() {
      return [...store.keys()];
    },
    setData: (type: string, value: string) => {
      store.set(type, value);
    },
    getData: (type: string) => store.get(type) ?? '',
  } as unknown as DataTransfer;
};

type RowOverrides = {
  canTargetSides?: boolean;
  isSelecting?: boolean;
  onSessionSelect?: (session: SessionWithProvider, projectId: string, options?: SessionOpenOptions) => void;
};

const renderProjectsRow = ({ canTargetSides = true, isSelecting = false, onSessionSelect = noop }: RowOverrides = {}) =>
  render(
    <SidebarSessionItem
      project={PROJECT}
      session={SESSION}
      selectedSession={null}
      isProcessing={false}
      hasBackgroundWork={false}
      needsAttention={false}
      currentTime={NOW}
      isEditing={false}
      renameDraft=""
      onRenameDraftChange={noop}
      onStartEditingSession={noop}
      onCancelEditingSession={noop}
      onSaveEditingSession={noop}
      onSessionSelect={onSessionSelect}
      onDeleteSession={noop}
      isSelecting={isSelecting}
      isChecked={false}
      onToggleSessionSelected={noop}
      canTargetSides={canTargetSides}
      isWorkspaceSplit={false}
      panePlacement={null}
      t={t}
    />,
  );

const projectsRowLink = (container: HTMLElement): HTMLAnchorElement => {
  const link = container.querySelector<HTMLAnchorElement>('a[href="/session/s1"]');
  assert.ok(link, 'the desktop row is a link to the session');
  return link;
};

const paneTargeting = (canTargetSides: boolean): SidebarPaneTargeting => ({
  canTargetSides,
  isSplit: false,
  focusedSide: 'left',
  onFocusSide: noop,
  placements: new Map(),
});

const renderConversationsRow = (
  onConversationSelect: (request: SidebarConversationOpenRequest, options?: SessionOpenOptions) => void,
  canTargetSides = true,
) => render(
  <SidebarRecentConversations
    conversations={[{
      sessionId: 's9',
      provider: 'codex',
      projectId: null,
      projectDisplayName: 'somewhere',
      sessionTitle: 'a recent one',
      lastActivity: '2026-08-21T09:30:00.000Z',
    }]}
    total={1}
    hasMore={false}
    isLoading={false}
    isLoadingMore={false}
    hasError={false}
    selectedSession={null}
    currentTime={NOW}
    sessionActions={{
      activeRename: null,
      activeSessions: NO_IDS,
      backgroundSessionIds: NO_IDS,
      attentionSessionIds: NO_IDS,
      onRenameDraftChange: noop,
      onStartEditingSession: noop,
      onCancelEditingSession: noop,
      onSaveEditingSession: noop,
      onDeleteSession: noop,
      paneTargeting: paneTargeting(canTargetSides),
    }}
    onConversationSelect={onConversationSelect}
    onLoadMore={noop}
    onRetry={noop}
    t={t}
  />,
);

const conversationRowLink = (): HTMLAnchorElement => screen.getByTestId('recent-conversation-row') as HTMLAnchorElement;

const NATIVE_CLICKS: MouseEventInit[] = [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }];

/**
 * Whether the row left this click to the browser. Read once the row has handled it,
 * then the navigation itself is stopped: jsdom cannot follow links.
 */
const isLeftToBrowser = (element: Element, init: MouseEventInit): boolean => {
  let leftToBrowser = false;
  const recordAndStop = (event: Event) => {
    leftToBrowser = !event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener('click', recordAndStop);
  fireEvent.click(element, init);
  document.removeEventListener('click', recordAndStop);
  return leftToBrowser;
};

const CONVERSATION_REQUEST: SidebarConversationOpenRequest = { projectId: null, sessionId: 's9', provider: 'codex' };

beforeEach(() => {
  isCompactLayout = false;
  forkSessionRequest.mockReset();
  archivedProjectsResponse.mockReset();
  archivedProjectsResponse.mockResolvedValue({ ok: true, json: async () => ({ data: { projects: [] } }) });
});

// ------------------------------------------------------------------ Projects rows

test('a click on a row previews the session in the focused pane', () => {
  const onSessionSelect = vi.fn();
  const { container } = renderProjectsRow({ onSessionSelect });

  const followed = fireEvent.click(projectsRowLink(container));

  assert.equal(followed, false, 'the link is not followed');
  assert.deepEqual(onSessionSelect.mock.calls, [[SESSION, 'project-1', { preview: true }]]);
});

test('Alt+click sends the session to the other side, prevented before anything else', () => {
  const onSessionSelect = vi.fn();
  const { container } = renderProjectsRow({ onSessionSelect });

  const followed = fireEvent.click(projectsRowLink(container), { altKey: true });

  assert.equal(followed, false, 'prevented, so the browser does not download the link');
  assert.deepEqual(onSessionSelect.mock.calls, [[SESSION, 'project-1', { target: 'other' }]]);
});

test('Alt+click where no split is possible is a kept open in the focused pane', () => {
  const onSessionSelect = vi.fn();
  const { container } = renderProjectsRow({ onSessionSelect, canTargetSides: false });

  assert.equal(fireEvent.click(projectsRowLink(container), { altKey: true }), false);
  assert.deepEqual(onSessionSelect.mock.calls, [[SESSION, 'project-1', { target: 'focused' }]]);
});

test('Ctrl, Cmd and Shift clicks and the middle button are left to the browser', () => {
  const onSessionSelect = vi.fn();
  const { container } = renderProjectsRow({ onSessionSelect });
  const link = projectsRowLink(container);

  for (const init of NATIVE_CLICKS) {
    assert.equal(isLeftToBrowser(link, init), true, `${JSON.stringify(init)} keeps the native link behaviour`);
  }
  assert.equal(onSessionSelect.mock.calls.length, 0);
});

test('a double-click keeps the session open, and an Alt double-click does not bounce it back', () => {
  const onSessionSelect = vi.fn();
  const { container } = renderProjectsRow({ onSessionSelect });
  const link = projectsRowLink(container);

  fireEvent.doubleClick(link);
  assert.deepEqual(onSessionSelect.mock.calls, [[SESSION, 'project-1', { preview: false }]]);

  onSessionSelect.mockClear();
  // The browser's sequence: click (detail 1), click (detail 2), dblclick, all with Alt held.
  fireEvent.click(link, { altKey: true, detail: 1 });
  assert.equal(fireEvent.click(link, { altKey: true, detail: 2 }), false, 'still not followed');
  fireEvent.doubleClick(link, { altKey: true });
  assert.deepEqual(onSessionSelect.mock.calls, [[SESSION, 'project-1', { target: 'other' }]]);
});

test('Alt+Enter on the focused row opens it on the other side; a plain Enter is the link\'s own', () => {
  const onSessionSelect = vi.fn();
  const { container } = renderProjectsRow({ onSessionSelect });
  const link = projectsRowLink(container);

  assert.equal(fireEvent.keyDown(link, { key: 'Enter' }), true);
  assert.equal(onSessionSelect.mock.calls.length, 0);

  assert.equal(fireEvent.keyDown(link, { key: 'Enter', altKey: true }), false, 'the link is not followed as well');
  assert.deepEqual(onSessionSelect.mock.calls, [[SESSION, 'project-1', { target: 'other' }]]);
});

test('dragging a row carries the session and keeps the link for the rest of the browser', () => {
  const { container } = renderProjectsRow();
  const dataTransfer = createDataTransfer();

  fireEvent.dragStart(projectsRowLink(container), { dataTransfer });

  assert.ok(hasSessionDragPayload(dataTransfer));
  assert.deepEqual(readSessionDragPayload(dataTransfer), {
    sessionId: 's1',
    projectId: 'project-1',
    provider: 'claude',
    title: 'session one',
  });
  assert.match(dataTransfer.getData('text/uri-list'), /^http:\/\/.+\/session\/s1$/);
});

test('rows ticked for a bulk delete cannot be dragged', () => {
  const { container } = renderProjectsRow({ isSelecting: true });
  const link = projectsRowLink(container);
  const dataTransfer = createDataTransfer();

  assert.equal(link.getAttribute('draggable'), 'false');
  assert.equal(fireEvent.dragStart(link, { dataTransfer }), false);
  assert.equal(hasSessionDragPayload(dataTransfer), false);
});

test('a tap on a compact row previews the session without selecting its project first', () => {
  isCompactLayout = true;
  const onSessionSelect = vi.fn();
  const { container } = renderProjectsRow({ onSessionSelect });

  const card = container.querySelector('.rounded-md.bg-card');
  assert.ok(card);
  fireEvent.click(card);

  assert.deepEqual(onSessionSelect.mock.calls, [[SESSION, 'project-1', { preview: true }]]);
});

// ------------------------------------------------------------------ Conversations rows

test('a Conversations row follows the same rules as a Projects row', () => {
  const onConversationSelect = vi.fn();
  renderConversationsRow(onConversationSelect);
  const link = conversationRowLink();

  assert.equal(fireEvent.click(link), false);
  assert.equal(fireEvent.click(link, { altKey: true }), false);
  fireEvent.doubleClick(link);
  assert.equal(fireEvent.keyDown(link, { key: 'Enter', altKey: true }), false);
  for (const init of NATIVE_CLICKS) {
    assert.equal(isLeftToBrowser(link, init), true, `${JSON.stringify(init)} keeps the native link behaviour`);
  }

  assert.deepEqual(onConversationSelect.mock.calls, [
    [CONVERSATION_REQUEST, { preview: true }],
    [CONVERSATION_REQUEST, { target: 'other' }],
    [CONVERSATION_REQUEST, { preview: false }],
    [CONVERSATION_REQUEST, { target: 'other' }],
  ]);
});

test('an Alt double-click on a Conversations row does not bounce it back', () => {
  const onConversationSelect = vi.fn();
  renderConversationsRow(onConversationSelect);
  const link = conversationRowLink();

  // The browser's sequence: click (detail 1), click (detail 2), dblclick, all with Alt held.
  fireEvent.click(link, { altKey: true, detail: 1 });
  assert.equal(fireEvent.click(link, { altKey: true, detail: 2 }), false, 'still not followed');
  fireEvent.doubleClick(link, { altKey: true });

  assert.deepEqual(onConversationSelect.mock.calls, [[CONVERSATION_REQUEST, { target: 'other' }]]);
});

test('a Conversations row opens Alt+clicks in the focused pane where no split is possible', () => {
  const onConversationSelect = vi.fn();
  renderConversationsRow(onConversationSelect, false);

  fireEvent.click(conversationRowLink(), { altKey: true });

  assert.deepEqual(onConversationSelect.mock.calls, [[CONVERSATION_REQUEST, { target: 'focused' }]]);
});

test('dragging a Conversations row carries the session even without a known project', () => {
  renderConversationsRow(noop);
  const dataTransfer = createDataTransfer();

  fireEvent.dragStart(conversationRowLink(), { dataTransfer });

  assert.deepEqual(readSessionDragPayload(dataTransfer), {
    sessionId: 's9',
    projectId: null,
    provider: 'codex',
    title: 'a recent one',
  });
  assert.match(dataTransfer.getData('text/uri-list'), /\/session\/s9$/);
});

// ------------------------------------------------------------------ New session button

const renderProjectSessions = (onNewSession: (project: Project, options?: SessionOpenOptions) => void, canTargetSides = true) =>
  render(
    <SidebarProjectSessions
      project={PROJECT}
      isExpanded
      sessions={[SESSION]}
      selectedSession={null}
      initialSessionsLoaded
      hasMoreSessions={false}
      isLoadingMoreSessions={false}
      activeSessions={NO_IDS}
      backgroundSessionIds={NO_IDS}
      attentionSessionIds={NO_IDS}
      currentTime={NOW}
      sessionRenameId={null}
      sessionRenameDraft=""
      onRenameDraftChange={noop}
      onStartEditingSession={noop}
      onCancelEditingSession={noop}
      onSaveEditingSession={noop}
      onSessionSelect={noop}
      onDeleteSession={noop}
      onLoadMoreSessions={noop}
      onNewSession={onNewSession}
      selectedSessionIds={null}
      onSetSessionSelection={noop}
      onToggleSessionSelected={noop}
      onCancelSessionSelection={noop}
      onDeleteSelectedSessions={noop}
      canTargetSides={canTargetSides}
      isWorkspaceSplit={false}
      panePlacements={null}
      t={t}
    />,
  );

test('New session opens in the focused pane, and on the other side with Alt', () => {
  const onNewSession = vi.fn();
  renderProjectSessions(onNewSession);
  const button = screen.getByRole('button', { name: 'sessions.newSession' });

  fireEvent.click(button);
  fireEvent.click(button, { altKey: true });

  assert.deepEqual(onNewSession.mock.calls, [[PROJECT, undefined], [PROJECT, { target: 'other' }]]);
});

test('New session ignores Alt where no split is possible, and the compact button selects nothing first', () => {
  const onNewSession = vi.fn();
  const { unmount } = renderProjectSessions(onNewSession, false);
  fireEvent.click(screen.getByRole('button', { name: 'sessions.newSession' }), { altKey: true });
  unmount();

  isCompactLayout = true;
  renderProjectSessions(onNewSession);
  fireEvent.click(screen.getByRole('button', { name: 'sessions.newSession' }));

  assert.deepEqual(onNewSession.mock.calls, [[PROJECT, undefined], [PROJECT]]);
});

// ------------------------------------------------------------------ Down through a project row

test('a project row hands its split targeting down to its session rows', () => {
  const onSessionSelect = vi.fn();
  const onProjectSelect = vi.fn();
  const { container } = render(
    <SidebarProjectItem
      project={PROJECT}
      selectedProject={null}
      selectedSession={null}
      isExpanded
      isDeleting={false}
      isStarred={false}
      isEditing={false}
      renameDraft=""
      sessions={[SESSION]}
      initialSessionsLoaded
      isLoadingMoreSessions={false}
      currentTime={NOW}
      sessionRenameId={null}
      sessionRenameDraft=""
      tasksEnabled={false}
      mcpServerStatus={null}
      onRenameDraftChange={noop}
      onToggleProject={noop}
      onProjectSelect={onProjectSelect}
      onToggleStarProject={noop}
      onStartEditingProject={noop}
      onCancelEditingProject={noop}
      onSaveProjectName={noop}
      onDeleteProject={noop}
      onSessionSelect={onSessionSelect}
      onDeleteSession={noop}
      onLoadMoreSessions={noop}
      activeSessions={NO_IDS}
      backgroundSessionIds={NO_IDS}
      attentionSessionIds={NO_IDS}
      onNewSession={noop}
      onStartEditingSession={noop}
      onCancelEditingSession={noop}
      onSaveEditingSession={noop}
      selectedSessionIds={null}
      onSetSessionSelection={noop}
      onToggleSessionSelected={noop}
      onCancelSessionSelection={noop}
      onDeleteSelectedSessions={noop}
      canTargetSides
      isWorkspaceSplit
      panePlacements={new Map([['s1', 'right']])}
      t={t}
    />,
  );

  assert.equal(container.querySelector('[data-pane-placement]')?.getAttribute('data-pane-placement'), 'right');
  fireEvent.click(projectsRowLink(container), { altKey: true });
  assert.deepEqual(onSessionSelect.mock.calls, [[SESSION, 'project-1', { target: 'other' }]]);
  assert.equal(onProjectSelect.mock.calls.length, 0, 'opening a session selects no project first');
});

// ------------------------------------------------------------------ Search hits and the archive

const SEARCH_RESULTS: ConversationSearchResults = {
  query: 'needle',
  totalMatches: 1,
  titleResults: [{
    sessionId: 't1',
    provider: 'claude',
    projectId: 'project-1',
    projectDisplayName: 'project one',
    sessionTitle: 'needle in the title',
    lastActivity: null,
  }],
  results: [{
    projectId: null,
    projectName: 'elsewhere',
    projectDisplayName: 'elsewhere',
    sessions: [{
      sessionId: 'c1',
      provider: 'gemini',
      sessionSummary: 'a needle inside',
      matches: [{ role: 'user', snippet: 'a needle', highlights: [], timestamp: '2026-08-21T09:00:00.000Z', provider: 'gemini' }],
    }],
  }],
} as unknown as ConversationSearchResults;

const ARCHIVED_SESSION: ArchivedSessionListItem = {
  sessionId: 'a1',
  provider: 'claude',
  projectId: 'archived-project',
  projectPath: '/old',
  projectDisplayName: 'old project',
  sessionTitle: 'an archived one',
  createdAt: null,
  updatedAt: null,
  lastActivity: null,
  isProjectArchived: false,
};

const renderContent = (
  searchMode: SidebarSearchMode,
  handlers: {
    onConversationResultClick?: (request: SidebarConversationOpenRequest, options?: SessionOpenOptions) => void;
    onArchivedSessionClick?: (session: ArchivedSessionListItem, options?: SessionOpenOptions) => void;
  },
) => render(
  <SidebarContent
    isPWA={false}
    isMobile={false}
    isLoading={false}
    projects={[PROJECT]}
    runningSessionsCount={0}
    archivedProjects={[]}
    archivedSessions={[ARCHIVED_SESSION]}
    archivedSessionsCount={1}
    isArchivedSessionsLoading={false}
    recentConversations={[]}
    recentConversationsTotal={0}
    recentConversationsHasMore={false}
    isRecentConversationsLoading={false}
    isLoadingMoreRecentConversations={false}
    recentConversationsError={false}
    searchFilter={searchMode === 'conversations' ? 'needle' : ''}
    onSearchFilterChange={noop}
    onClearSearchFilter={noop}
    searchMode={searchMode}
    onSearchModeChange={noop}
    conversationResults={searchMode === 'conversations' ? SEARCH_RESULTS : null}
    isSearching={false}
    searchProgress={null}
    onRestoreArchivedProject={noop}
    onLoadMoreRecentConversations={noop}
    onRetryRecentConversations={noop}
    onArchivedSessionClick={handlers.onArchivedSessionClick ?? noop}
    onRestoreArchivedSession={noop}
    onDeleteArchivedSession={noop}
    onConversationResultClick={handlers.onConversationResultClick ?? noop}
    onRefresh={noop}
    isRefreshing={false}
    onCreateProject={noop}
    onCollapseSidebar={noop}
    updateAvailable={false}
    restartRequired={false}
    releaseInfo={null}
    latestVersion={null}
    currentVersion="1.0.0"
    onShowVersionModal={noop}
    onShowSettings={noop}
    projectListProps={{
      currentTime: NOW,
      activeRename: null,
      paneTargeting: paneTargeting(true),
    } as unknown as SidebarProjectListProps}
    t={t}
  />,
);

test('a search hit previews on click and goes to the other side on Alt+click', () => {
  const onConversationResultClick = vi.fn();
  renderContent('conversations', { onConversationResultClick });

  fireEvent.click(screen.getByText('needle in the title'));
  fireEvent.click(screen.getByText('needle in the title'), { altKey: true });
  fireEvent.click(screen.getByText('a needle inside'));

  assert.deepEqual(onConversationResultClick.mock.calls, [
    [{ projectId: 'project-1', sessionId: 't1', provider: 'claude' }, { preview: true }],
    [{ projectId: 'project-1', sessionId: 't1', provider: 'claude' }, { target: 'other' }],
    [{
      projectId: null,
      sessionId: 'c1',
      provider: 'gemini',
      messageTimestamp: '2026-08-21T09:00:00.000Z',
      messageSnippet: 'a needle',
    }, { preview: true }],
  ]);
});

test('an archived session previews on click and goes to the other side on Alt+click', () => {
  const onArchivedSessionClick = vi.fn();
  renderContent('archived', { onArchivedSessionClick });

  fireEvent.click(screen.getByText('an archived one'));
  fireEvent.click(screen.getByText('an archived one'), { altKey: true });

  assert.deepEqual(onArchivedSessionClick.mock.calls, [
    [ARCHIVED_SESSION, { preview: true }],
    [ARCHIVED_SESSION, { target: 'other' }],
  ]);
});

// ------------------------------------------------------------------ The controller's open paths

const ARCHIVED_PROJECT = {
  projectId: 'archived-project',
  displayName: 'old project',
  fullPath: '/old',
  sessions: [],
  isArchived: true,
} as unknown as Project;

const renderController = (onSessionSelect = vi.fn(), onProjectSelect = vi.fn()) => {
  const projects = [PROJECT];
  const rendered = renderHook(() => useSidebarController({
    projects,
    selectedProject: null,
    selectedSession: null,
    activeSessions: NO_IDS,
    backgroundSessionIds: NO_IDS,
    isLoading: false,
    isMobile: false,
    t,
    onRefresh: noop,
    onProjectSelect,
    onSessionSelect,
    setSidebarVisible: noop,
    sidebarVisible: true,
  }));
  return { ...rendered, onSessionSelect, onProjectSelect };
};

test('a row hands its options through, tagged with the owning project', () => {
  const { result, onSessionSelect } = renderController();

  act(() => {
    result.current.handleSessionClick(SESSION, 'project-1', { target: 'right' });
  });

  assert.deepEqual(onSessionSelect.mock.calls, [[{ ...SESSION, __projectId: 'project-1' }, { target: 'right' }]]);
});

test('a Conversations row or search hit opens without selecting its project first', () => {
  const { result, onSessionSelect, onProjectSelect } = renderController();

  act(() => {
    result.current.openConversation({ projectId: 'project-1', sessionId: 's1', provider: 'claude' }, { target: 'other' });
    result.current.openConversation(
      { projectId: null, sessionId: 'x1', provider: '', messageTimestamp: 'then', messageSnippet: 'what' },
      { preview: true },
    );
  });

  assert.equal(onProjectSelect.mock.calls.length, 0, 'recording a browsed project opens nothing, so it is not called');
  assert.deepEqual(onSessionSelect.mock.calls, [
    [
      { ...SESSION, __searchTargetTimestamp: null, __searchTargetSnippet: null, __projectId: 'project-1' },
      { target: 'other' },
    ],
    [
      // No project to name: the workspace looks it up by id.
      { id: 'x1', __provider: 'claude', __searchTargetTimestamp: 'then', __searchTargetSnippet: 'what', __projectId: '' },
      { preview: true },
    ],
  ]);
});

test('an archived session travels with its archived project instead of selecting it', async () => {
  archivedProjectsResponse.mockResolvedValue({ ok: true, json: async () => ({ data: { projects: [ARCHIVED_PROJECT] } }) });
  const { result, onSessionSelect, onProjectSelect } = renderController();
  await waitFor(() => assert.equal(result.current.archivedProjects.length, 1));

  act(() => {
    result.current.openArchivedSession(ARCHIVED_SESSION, { preview: true });
    result.current.openArchivedSession({ ...ARCHIVED_SESSION, sessionId: 'a2', projectId: 'project-1' }, { target: 'other' });
  });

  assert.equal(onProjectSelect.mock.calls.length, 0);
  assert.deepEqual(onSessionSelect.mock.calls, [
    [
      { id: 'a1', summary: 'an archived one', __provider: 'claude', __projectId: 'archived-project' },
      { preview: true, ownerProject: ARCHIVED_PROJECT },
    ],
    [
      // A listed project needs no carrying.
      { id: 'a2', summary: 'an archived one', __provider: 'claude', __projectId: 'project-1' },
      { target: 'other', ownerProject: null },
    ],
  ]);
});

test('a fork opens as a kept tab in the focused pane', async () => {
  forkSessionRequest.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { sessionId: 'forked', sessionName: 'the copy' } }),
  });
  const { result, onSessionSelect } = renderController();

  await act(async () => {
    await result.current.forkSession({ ...SESSION, __projectId: 'project-1' });
  });

  assert.deepEqual(onSessionSelect.mock.calls, [[
    { id: 'forked', summary: 'the copy', __provider: 'claude', __projectId: 'project-1' },
    { target: 'focused' },
  ]]);
});
