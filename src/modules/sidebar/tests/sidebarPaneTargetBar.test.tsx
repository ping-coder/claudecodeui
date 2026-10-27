import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type {
  Project,
  SessionOpenOptions,
  SidebarConversationOpenRequest,
  SidebarPaneTargeting,
  SidebarProjectListProps,
  SidebarSearchMode,
} from '@/shared/types';

/**
 * The sidebar's split chrome. Once the workspace is split, "Open in: Left | Right"
 * sits above the Projects, Conversations and Running lists: choosing a side
 * focuses that pane, which is where a plain click on a row then lands. Also the
 * header's command-palette hint, which names the platform's modifier, the
 * immersive drawer, which shows the full sidebar even when it was collapsed, and
 * how the Sidebar itself wires the targeting and the open paths to its lists.
 */

vi.mock('@/shared/api', () => ({
  api: {
    archivedProjects: () => Promise.resolve({ ok: true, json: async () => ({ data: { projects: [] } }) }),
    getArchivedSessions: () => Promise.resolve({ ok: true, json: async () => ({ data: { sessions: [] } }) }),
    recentConversations: () => Promise.resolve({ ok: true, json: async () => ({ data: { conversations: [] } }) }),
  },
}));

// The lists record what the Sidebar hands them; their rows have tests of their own.
const projectListRenders: SidebarProjectListProps[] = [];
vi.mock('@/modules/sidebar/SidebarProjectList', () => ({
  default: (props: SidebarProjectListProps) => {
    projectListRenders.push(props);
    return <div data-testid="project-list" />;
  },
}));
type RecentListProps = {
  isLoading: boolean;
  onConversationSelect: (request: SidebarConversationOpenRequest, options?: SessionOpenOptions) => void;
};
const recentListRenders: RecentListProps[] = [];
vi.mock('@/modules/sidebar/SidebarRecentConversations', () => ({
  default: (props: RecentListProps) => {
    recentListRenders.push(props);
    return <div data-testid="recent-list" />;
  },
}));
vi.mock('@/modules/sidebar/SidebarFooter', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarModals', () => ({ default: () => null }));

// What the Sidebar reads from around the app.
const setCurrentProject = vi.fn();
vi.mock('@/modules/task-master', () => ({
  useTaskMaster: () => ({ mcpServerStatus: null, setCurrentProject }),
  useTasksSettings: () => ({ tasksEnabled: false }),
}));
vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({ refreshProjects: async () => {} }),
}));
vi.mock('@/shared/hooks/useDeviceSettings', () => ({
  useDeviceSettings: () => ({ isPWA: false }),
}));
vi.mock('@/shared/hooks/useVersionCheck', () => ({
  useVersionCheck: () => ({
    updateAvailable: false,
    restartRequired: false,
    latestVersion: null,
    currentVersion: '1.0.0',
    releaseInfo: null,
    installMode: 'git',
  }),
}));
let sidebarVisiblePreference = true;
vi.mock('@/shared/context/UiPreferencesContext', () => ({
  useUiPreferences: () => ({ sidebarVisible: sidebarVisiblePreference, keepProjectsExpanded: false }),
  useSetUiPreference: () => () => {},
}));
const NO_SESSION_IDS: ReadonlySet<string> = new Set<string>();
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useBusySessionIdSet: () => NO_SESSION_IDS,
  useBackgroundSessionIdSet: () => NO_SESSION_IDS,
}));

const { default: SidebarPaneTargetBar } = await import('@/modules/sidebar/SidebarPaneTargetBar');
const { default: SidebarContent } = await import('@/modules/sidebar/SidebarContent');
const { default: SidebarHeader } = await import('@/modules/sidebar/SidebarHeader');
const { default: Sidebar } = await import('@/modules/sidebar/Sidebar');
const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');

const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const noop = () => {};
const PROJECT = { projectId: 'project-1', displayName: 'project one', fullPath: '/repo', sessions: [] } as unknown as Project;

const targeting = (overrides: Partial<SidebarPaneTargeting> = {}): SidebarPaneTargeting => ({
  canTargetSides: true,
  isSplit: true,
  focusedSide: 'left',
  onFocusSide: noop,
  placements: new Map(),
  ...overrides,
});

beforeEach(() => {
  // The header's badges look things up; nothing here is about them.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
  projectListRenders.length = 0;
  recentListRenders.length = 0;
  setCurrentProject.mockReset();
  sidebarVisiblePreference = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window.navigator, 'platform');
});

// ------------------------------------------------------------------ The switch

test('nothing renders while the workspace is not split', () => {
  for (const paneTargeting of [null, undefined, targeting({ isSplit: false })]) {
    const { container, unmount } = render(<SidebarPaneTargetBar paneTargeting={paneTargeting} t={t} />);
    assert.equal(container.innerHTML, '');
    unmount();
  }
});

test('split, it is a radio group whose checked side is the focused pane', () => {
  render(<SidebarPaneTargetBar paneTargeting={targeting({ focusedSide: 'right' })} t={t} />);

  const group = screen.getByRole('radiogroup', { name: 'paneTarget.label' });
  const radios = within(group).getAllByRole('radio');
  assert.deepEqual(radios.map((radio) => radio.textContent), ['paneTarget.left', 'paneTarget.right']);
  assert.deepEqual(radios.map((radio) => radio.getAttribute('aria-checked')), ['false', 'true']);
  // Roving focus: Tab lands on the checked side only.
  assert.deepEqual(radios.map((radio) => radio.tabIndex), [-1, 0]);
});

test('choosing Right focuses the right pane; the side already chosen is left alone', () => {
  const onFocusSide = vi.fn();
  render(<SidebarPaneTargetBar paneTargeting={targeting({ onFocusSide })} t={t} />);

  fireEvent.click(screen.getByRole('radio', { name: 'paneTarget.right' }));
  fireEvent.click(screen.getByRole('radio', { name: 'paneTarget.left' }));

  assert.deepEqual(onFocusSide.mock.calls, [['right']]);
});

test('the arrow keys move the choice and the focus with it', () => {
  const onFocusSide = vi.fn();
  render(<SidebarPaneTargetBar paneTargeting={targeting({ onFocusSide })} t={t} />);
  const group = screen.getByRole('radiogroup');

  fireEvent.keyDown(group, { key: 'ArrowRight' });
  assert.deepEqual(onFocusSide.mock.calls, [['right']]);
  assert.ok(document.activeElement === screen.getByRole('radio', { name: 'paneTarget.right' }), 'focus moves to Right');

  fireEvent.keyDown(group, { key: 'ArrowLeft' });
  assert.equal(onFocusSide.mock.calls.length, 1, 'left is already the focused pane here');
  assert.ok(document.activeElement === screen.getByRole('radio', { name: 'paneTarget.left' }), 'focus moves to Left');
});

// ------------------------------------------------------------------ In the sidebar

const renderContent = (searchMode: SidebarSearchMode, paneTargeting: SidebarPaneTargeting | null) => render(
  <SidebarContent
    isPWA={false}
    isMobile={false}
    isLoading={false}
    projects={[PROJECT]}
    runningSessionsCount={1}
    archivedProjects={[]}
    archivedSessions={[]}
    archivedSessionsCount={0}
    isArchivedSessionsLoading={false}
    recentConversations={[]}
    recentConversationsTotal={0}
    recentConversationsHasMore={false}
    isRecentConversationsLoading={false}
    isLoadingMoreRecentConversations={false}
    recentConversationsError={false}
    searchFilter=""
    onSearchFilterChange={noop}
    onClearSearchFilter={noop}
    searchMode={searchMode}
    onSearchModeChange={noop}
    conversationResults={null}
    isSearching={false}
    searchProgress={null}
    onRestoreArchivedProject={noop}
    onLoadMoreRecentConversations={noop}
    onRetryRecentConversations={noop}
    onArchivedSessionClick={noop}
    onRestoreArchivedSession={noop}
    onDeleteArchivedSession={noop}
    onConversationResultClick={noop}
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
      currentTime: new Date('2026-08-21T10:00:00.000Z'),
      activeRename: null,
      filteredProjects: [PROJECT],
      selectedSession: null,
      paneTargeting,
    } as unknown as SidebarProjectListProps}
    t={t}
  />,
);

test('the switch sits above the Projects, Conversations and Running lists', () => {
  const lists: Array<[SidebarSearchMode, string]> = [
    ['projects', 'project-list'],
    ['conversations', 'recent-list'],
    ['running', 'project-list'],
  ];

  for (const [searchMode, listTestId] of lists) {
    const { unmount } = renderContent(searchMode, targeting());
    const group = screen.getByRole('radiogroup');
    const list = screen.getByTestId(listTestId);
    assert.ok(
      group.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
      `${searchMode}: the switch comes before the list`,
    );
    unmount();
  }
});

test('the archive has no switch, and neither has an unsplit workspace', () => {
  const archived = renderContent('archived', targeting());
  assert.ok(screen.queryByRole('radiogroup') === null, 'not over the archive');
  archived.unmount();

  renderContent('projects', targeting({ isSplit: false }));
  assert.ok(screen.queryByRole('radiogroup') === null, 'not while unsplit');
});

test('the sidebar root names the focused pane for the rows to read on hover', () => {
  const { container, unmount } = renderContent('projects', targeting({ focusedSide: 'right' }));
  assert.equal(container.firstElementChild?.getAttribute('data-focused-pane-side'), 'right');
  unmount();

  const outsideSplit = renderContent('projects', null);
  assert.equal(outsideSplit.container.firstElementChild?.hasAttribute('data-focused-pane-side'), false);
});

// ------------------------------------------------------------------ The header

const renderHeader = (onCollapseSidebar?: () => void) => render(
  <SidebarHeader
    isPWA={false}
    isMobile={false}
    isLoading={false}
    projectsCount={1}
    runningSessionsCount={0}
    archivedSessionsCount={0}
    isArchivedSessionsLoading={false}
    searchFilter=""
    onSearchFilterChange={noop}
    onClearSearchFilter={noop}
    searchMode="projects"
    onSearchModeChange={noop}
    onRefresh={noop}
    isRefreshing={false}
    onCreateProject={noop}
    onCollapseSidebar={onCollapseSidebar}
    t={t}
  />,
);

const setPlatform = (platform: string) => {
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true });
};

test('the command palette hint names this platform\'s modifier, read when it renders', () => {
  setPlatform('MacIntel');
  const mac = renderHeader(noop);
  assert.equal(mac.container.querySelector('kbd')?.textContent, '⌘K');
  mac.unmount();

  setPlatform('Linux x86_64');
  const linux = renderHeader(noop);
  assert.equal(linux.container.querySelector('kbd')?.textContent, 'CtrlK');
});

test('forced open, the sidebar offers no way to hide itself', () => {
  const collapsible = renderHeader(noop);
  assert.ok(collapsible.container.querySelector('button[title="tooltips.hideSidebar"]'));
  collapsible.unmount();

  const forcedOpen = renderHeader(undefined);
  assert.ok(forcedOpen.container.querySelector('button[title="tooltips.hideSidebar"]') === null, 'no hide button while forced open');
});

test('forced open, a sidebar collapsed to the rail shows in full', () => {
  const projects = [PROJECT];
  const renderController = (forceExpanded: boolean | undefined) => renderHook(() => useSidebarController({
    projects,
    selectedProject: null,
    selectedSession: null,
    activeSessions: new Set<string>(),
    backgroundSessionIds: new Set<string>(),
    isLoading: false,
    isMobile: false,
    t,
    onRefresh: noop,
    onProjectSelect: noop,
    onSessionSelect: noop,
    setSidebarVisible: noop,
    sidebarVisible: false,
    forceExpanded,
  }));

  assert.equal(renderController(undefined).result.current.isSidebarCollapsed, true);
  assert.equal(renderController(true).result.current.isSidebarCollapsed, false);
});

// ------------------------------------------------------------------ The Sidebar itself

const LISTED_PROJECT = {
  projectId: 'project-1',
  name: 'project-1',
  displayName: 'project one',
  fullPath: '/repo',
  sessions: [{ id: 's1', summary: 'session one', lastActivity: '2026-08-21T09:00:00.000Z', __provider: 'claude' }],
} as unknown as Project;

type SidebarRenderProps = { paneTargeting?: SidebarPaneTargeting | null; forceExpanded?: boolean };

const renderSidebar = (initialProps: SidebarRenderProps = {}) => {
  const onProjectSelect = vi.fn();
  const onSessionSelect = vi.fn();
  const element = (props: SidebarRenderProps) => (
    <Sidebar
      projects={[LISTED_PROJECT]}
      selectedProject={null}
      selectedSession={null}
      attentionSessionIds={NO_SESSION_IDS}
      onProjectSelect={onProjectSelect}
      onSessionSelect={onSessionSelect}
      onNewSession={noop}
      isLoading={false}
      loadingProgress={null}
      onRefresh={noop}
      onShowSettings={noop}
      showSettings={false}
      settingsInitialTab="agents"
      onCloseSettings={noop}
      isMobile={false}
      {...props}
    />
  );
  const rendered = render(element(initialProps));
  return {
    onProjectSelect,
    onSessionSelect,
    rerenderWith: (props: SidebarRenderProps) => rendered.rerender(element(props)),
  };
};

test('the Sidebar hands its split targeting to the lists, and a title click only records the project', async () => {
  const paneTargeting = targeting();
  const { onProjectSelect } = renderSidebar({ paneTargeting });
  // The archive loads on mount; let it land so nothing updates after the test.
  await waitFor(() => assert.ok(screen.getByRole('radiogroup'), 'the Open-in switch shows over the split workspace'));

  const listProps = projectListRenders.at(-1);
  assert.ok(listProps);
  assert.equal(listProps.paneTargeting, paneTargeting);
  assert.ok(document.querySelector('button[title="Hide sidebar"]'), 'a docked sidebar can still be hidden');

  act(() => {
    listProps.onProjectSelect(LISTED_PROJECT);
  });
  assert.deepEqual(onProjectSelect.mock.calls, [[LISTED_PROJECT]]);
  assert.equal(setCurrentProject.mock.calls.length, 0, 'TaskMaster follows the focused pane, not sidebar clicks');
});

test('a Conversations row opens straight into the workspace, without selecting its project first', async () => {
  const { onProjectSelect, onSessionSelect } = renderSidebar({ paneTargeting: targeting() });

  // The header carries a desktop and a phone copy of the mode tabs; either switches the list.
  fireEvent.click(screen.getAllByRole('button', { name: 'Conversations' })[0]);
  await waitFor(() => assert.equal(recentListRenders.at(-1)?.isLoading, false));
  const recentList = recentListRenders.at(-1) as RecentListProps;
  act(() => {
    recentList.onConversationSelect({ projectId: 'project-1', sessionId: 's1', provider: 'claude' }, { target: 'other' });
  });

  assert.equal(onProjectSelect.mock.calls.length, 0);
  assert.equal(onSessionSelect.mock.calls.length, 1);
  const [session, options] = onSessionSelect.mock.calls[0];
  // The loaded row is opened, tagged with its project; the options pass through untouched.
  assert.deepEqual(
    [session.id, session.summary, session.__projectId, options],
    ['s1', 'session one', 'project-1', { target: 'other' }],
  );
});

test('forced open, a Sidebar collapsed to the rail renders in full and offers no way to hide itself', async () => {
  sidebarVisiblePreference = false;
  const { rerenderWith } = renderSidebar();
  await waitFor(() => assert.ok(screen.getByRole('button', { name: 'Show sidebar' }), 'collapsed to the rail'));
  assert.ok(screen.queryByTestId('project-list') === null, 'the rail draws no list');

  rerenderWith({ forceExpanded: true });

  assert.ok(screen.getByTestId('project-list'));
  assert.ok(screen.queryByRole('button', { name: 'Show sidebar' }) === null, 'the rail is gone');
  assert.ok(document.querySelector('button[title="Hide sidebar"]') === null, 'no hide button while forced open');
});
