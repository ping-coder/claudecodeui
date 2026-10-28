import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import ProjectRunNotifications from '@/modules/project-workspace/ProjectRunNotifications';
import { WorkspaceChromeProvider } from '@/modules/project-workspace/context/WorkspaceChromeContext';
import type {
  Project,
  ResolveRunSessionLabel,
  RunAlertBannerPlacement,
  WorkspaceLayout,
  WorkspaceLayoutActions,
  WorkspacePaneSide,
  WorkspacePaneState,
  WorkspaceSessionTab,
} from '@/shared/types';

/**
 * ProjectRunNotifications binds the workspace to run-notifications: it names a session by its live title, else
 * its tab's snapshot, with its project (archived ones included); it says which sessions are on screen (the
 * active tab of a pane on display, in the Chat view); it opens a banner's session on Chat in the focused pane,
 * closing the phone's sidebar first; and it places the banners for desktop, phone and phone immersive mode.
 */

type CapturedProps = {
  resolveSessionLabel: ResolveRunSessionLabel;
  onScreenSessionIds: ReadonlySet<string>;
  onOpenSession: (sessionId: string) => void;
  placement: RunAlertBannerPlacement;
};

const captured = vi.hoisted(() => ({ props: null as unknown }));

vi.mock('@/modules/run-notifications', () => ({
  RunNotifications: (props: unknown) => {
    captured.props = props;
    return null;
  },
}));

const panes = vi.hoisted(() => ({ state: null as unknown }));

vi.mock('@/modules/project-workspace/context/ProjectsStateContext', () => ({
  useProjectPanesState: () => panes.state,
}));

/** What opening a session from a banner did, in order. */
const calls: string[] = [];

const tabOf = (key: string, overrides: Partial<WorkspaceSessionTab> = {}): WorkspaceSessionTab => ({
  key,
  sessionId: key,
  projectId: 'project-alpha',
  provider: 'claude',
  title: `Snapshot ${key}`,
  view: 'chat',
  isPreview: false,
  session: null,
  ...overrides,
});

const paneOf = (id: string, tabs: WorkspaceSessionTab[], activeTabKey: string | null = tabs[0]?.key ?? null): WorkspacePaneState => ({
  id,
  tabs,
  activeTabKey,
  mru: [],
  draftActivation: 0,
  externalRevision: 0,
});

const ALPHA: Project = {
  projectId: 'project-alpha',
  displayName: 'Alpha',
  fullPath: '/alpha',
  sessions: [
    { id: 'live', summary: '  Live title  ' },
    { id: 'untitled' },
  ],
};

/** Listed, but no page of its sessions loaded. */
const BETA: Project = { projectId: 'project-beta', displayName: 'Beta', fullPath: '/beta' };

/** Archived: no longer in the project list, held only as a pane's project. */
const ARCHIVED: Project = { projectId: 'project-old', displayName: 'Old stuff', fullPath: '/old' };

const layoutOf = (left: WorkspacePaneState, right: WorkspacePaneState | null, focusedSide: WorkspacePaneSide = 'left'): WorkspaceLayout => ({
  left,
  right,
  focusedSide,
  splitRatio: 0.5,
});

const panesStateWith = (layout: WorkspaceLayout, paneProjects: Record<WorkspacePaneSide, Project | null> = { left: ALPHA, right: null }) => ({
  projects: [ALPHA, BETA],
  paneProjects,
  layout,
  actions: {
    openSessionById: (sessionId: string, options: unknown) => {
      calls.push(`openSessionById ${sessionId} ${JSON.stringify(options)}`);
    },
  } as unknown as WorkspaceLayoutActions,
  setSidebarOpen: (open: boolean) => {
    calls.push(`setSidebarOpen ${String(open)}`);
  },
});

const chromeWith = ({ canSplit = true, isImmersive = false }: { canSplit?: boolean; isImmersive?: boolean } = {}) => ({
  isImmersive,
  isBrowserFullscreen: false,
  toggleImmersive: () => undefined,
  exitImmersive: () => undefined,
  isSidebarPeekOpen: false,
  setSidebarPeekOpen: () => undefined,
  canSplit,
});

const tree = (isMobile: boolean, chrome = chromeWith()) => (
  <WorkspaceChromeProvider value={chrome}>
    <ProjectRunNotifications isMobile={isMobile} />
  </WorkspaceChromeProvider>
);

const renderWith = (
  layout: WorkspaceLayout,
  { isMobile = false, chrome = chromeWith(), paneProjects }: {
    isMobile?: boolean;
    chrome?: ReturnType<typeof chromeWith>;
    paneProjects?: Record<WorkspacePaneSide, Project | null>;
  } = {},
) => {
  panes.state = panesStateWith(layout, paneProjects);
  return render(tree(isMobile, chrome));
};

const props = () => captured.props as CapturedProps;
const onScreen = () => [...props().onScreenSessionIds].sort();

beforeEach(() => {
  captured.props = null;
  calls.length = 0;
});

test('a session is named by its live title, else its tab\'s snapshot, with its project, archived ones included', () => {
  renderWith(
    layoutOf(
      paneOf('pane-left', [tabOf('live'), tabOf('untitled'), tabOf('orphan', { projectId: 'project-beta' })]),
      paneOf('pane-right', [tabOf('archived', { projectId: 'project-old', title: '  Archived snapshot ' })]),
    ),
    { paneProjects: { left: ALPHA, right: ARCHIVED } },
  );
  const { resolveSessionLabel } = props();

  assert.deepEqual(resolveSessionLabel('live'), { title: 'Live title', projectName: 'Alpha' });
  // Loaded without a title: the tab's snapshot names it.
  assert.deepEqual(resolveSessionLabel('untitled'), { title: 'Snapshot untitled', projectName: 'Alpha' });
  // Not in the loaded pages: the project comes from the tab's project id, in the list or a pane's project.
  assert.deepEqual(resolveSessionLabel('orphan'), { title: 'Snapshot orphan', projectName: 'Beta' });
  assert.deepEqual(resolveSessionLabel('archived'), { title: 'Archived snapshot', projectName: 'Old stuff' });
  // The workspace knows nothing: run-notifications falls back to the server's name.
  assert.equal(resolveSessionLabel('elsewhere'), null);
});

test('on screen: the active tab of each pane on display, in the Chat view', () => {
  const split = layoutOf(
    paneOf('pane-left', [tabOf('left-chat'), tabOf('left-other')]),
    paneOf('pane-right', [tabOf('right-chat')]),
    'right',
  );

  // Side by side, both panes count.
  const view = renderWith(split);
  assert.deepEqual(onScreen(), ['left-chat', 'right-chat']);

  // A split too narrow for both shows the focused pane alone, and so does a phone.
  view.rerender(tree(false, chromeWith({ canSplit: false })));
  assert.deepEqual(onScreen(), ['right-chat']);
  view.rerender(tree(true));
  assert.deepEqual(onScreen(), ['right-chat']);

  // Another view than Chat, a background tab and a draft are not on screen.
  panes.state = panesStateWith(layoutOf(
    paneOf('pane-left', [tabOf('left-chat'), tabOf('left-files', { view: 'files' })], 'left-files'),
    paneOf('pane-right', [tabOf('draft', { sessionId: null })]),
  ));
  view.rerender(tree(false));
  assert.deepEqual(onScreen(), []);

  // Unsplit: the one pane.
  panes.state = panesStateWith(layoutOf(paneOf('pane-left', [tabOf('only')]), null));
  view.rerender(tree(false));
  assert.deepEqual(onScreen(), ['only']);
});

test('the on-screen set keeps its identity while the same sessions stay on screen', () => {
  const view = renderWith(layoutOf(paneOf('pane-left', [tabOf('a'), tabOf('b')]), paneOf('pane-right', [tabOf('c')])));
  const first = props().onScreenSessionIds;

  // A new layout object, the same sessions on screen (a tab opened in the background, the panes swapped).
  panes.state = panesStateWith(layoutOf(paneOf('pane-left', [tabOf('c')]), paneOf('pane-right', [tabOf('a'), tabOf('b'), tabOf('d')])));
  view.rerender(tree(false));
  assert.equal(props().onScreenSessionIds === first, true);

  panes.state = panesStateWith(layoutOf(paneOf('pane-left', [tabOf('a'), tabOf('b')], 'b'), paneOf('pane-right', [tabOf('c')])));
  view.rerender(tree(false));
  assert.equal(props().onScreenSessionIds === first, false);
});

test('"Open" closes the sidebar, then opens the session kept, on Chat, in the focused pane', () => {
  renderWith(layoutOf(paneOf('pane-left', [tabOf('a')]), null));

  props().onOpenSession('session-x');

  assert.deepEqual(calls, [
    'setSidebarOpen false',
    'openSessionById session-x {"preview":false,"view":"chat"}',
  ]);
});

test('the banners sit for desktop, phone or phone immersive mode', () => {
  const layout = layoutOf(paneOf('pane-left', [tabOf('a')]), null);
  const view = renderWith(layout);
  assert.equal(props().placement, 'desktop');

  view.rerender(tree(false, chromeWith({ isImmersive: true })));
  assert.equal(props().placement, 'desktop');

  view.rerender(tree(true));
  assert.equal(props().placement, 'phone');

  view.rerender(tree(true, chromeWith({ isImmersive: true })));
  assert.equal(props().placement, 'phoneImmersive');
});
