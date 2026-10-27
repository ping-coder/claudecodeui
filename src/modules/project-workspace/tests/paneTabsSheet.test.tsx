import assert from 'node:assert/strict';

import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type {
  Project,
  WorkspaceLayout,
  WorkspaceLayoutActions,
  WorkspacePaneState,
  WorkspaceSessionTab,
} from '@/shared/types';

/**
 * Phones show one pane and no tab bar. The header's Tabs button (once there is more than one tab
 * or a right pane) opens a bottom sheet listing the tabs, grouped left/right while a right pane
 * exists: previews in italics, running sessions spin, ones needing attention get an amber dot. A
 * row switches to its tab and side, × closes a tab, and the footer starts a new chat or closes
 * every tab. The header's full-screen button sits next to it.
 */

type MainProps = { side: 'left' | 'right'; headerActions: ReactNode; hideHeader: boolean };

const panes: { state: Record<string, unknown> } = { state: {} };
const NO_SESSIONS: ReadonlySet<string> = new Set();

vi.mock('@/modules/project-workspace/context/ProjectsStateContext', () => ({
  useProjectPanesState: () => panes.state,
}));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useBusySessionIdSet: () => NO_SESSIONS,
  useBackgroundSessionIdSet: () => NO_SESSIONS,
}));
vi.mock('@/modules/task-master', () => ({
  useTaskMasterProjectSync: () => undefined,
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }),
}));
vi.mock('@/modules/browser-use', () => ({ useBrowserUseEnabled: () => false }));
vi.mock('@/modules/plugins', () => ({ usePlugins: () => ({ plugins: [] }), PluginIcon: () => null }));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ connectionStatus: 'connected' }) }));
// The real WorkspaceMain draws headerActions in its header, which it leaves out while immersive.
vi.mock('@/modules/project-workspace/WorkspaceMain', () => ({
  default: ({ side, headerActions, hideHeader }: MainProps) => (
    <div data-testid={`main-${side}`}>{hideHeader ? null : headerActions}</div>
  ),
}));

const { WorkspaceChromeProvider } = await import('@/modules/project-workspace/context/WorkspaceChromeContext');
const { default: ProjectMainRegion } = await import('@/modules/project-workspace/ProjectMainRegion');
const { default: PaneTabsSheet } = await import('@/modules/project-workspace/PaneTabsSheet');

const ALPHA: Project = { projectId: 'alpha', displayName: 'Alpha', fullPath: '/repo/alpha', path: '/repo/alpha', sessions: [] };

const makeTab = (key: string, overrides: Partial<WorkspaceSessionTab> = {}): WorkspaceSessionTab => ({
  key,
  sessionId: `session-${key}`,
  projectId: 'alpha',
  provider: 'claude',
  title: `Chat ${key}`,
  view: 'chat',
  isPreview: false,
  session: { id: `session-${key}`, __projectId: 'alpha', __provider: 'claude' },
  ...overrides,
});

const makePane = (tabs: WorkspaceSessionTab[], activeTabKey = tabs[0]?.key ?? null): WorkspacePaneState => ({
  // Ids follow the first tab, so the two panes of a layout differ and a pane keeps its id across renders.
  id: `pane-${tabs[0]?.key ?? 'empty'}`,
  tabs,
  activeTabKey,
  mru: activeTabKey ? [activeTabKey] : [],
  draftActivation: 0,
  externalRevision: 0,
});

const makeActions = (): WorkspaceLayoutActions => ({
  openSession: vi.fn(),
  openSessionById: vi.fn(),
  openNewSession: vi.fn(),
  establishDraft: vi.fn(),
  activateTab: vi.fn(),
  closeTab: vi.fn(),
  closeOtherTabs: vi.fn(),
  closeTabsToRight: vi.fn(),
  closeAllTabs: vi.fn(),
  pinTab: vi.fn(),
  moveTab: vi.fn(),
  setTabView: vi.fn(),
  focusPane: vi.fn(),
  split: vi.fn(),
  toggleSplit: vi.fn(),
  closePane: vi.fn(),
  setSplitRatio: vi.fn(),
});

let actions = makeActions();
const toggleImmersive = vi.fn();

const SPLIT_LAYOUT: WorkspaceLayout = {
  left: makePane([makeTab('l1'), makeTab('l2', { isPreview: true })]),
  right: makePane([makeTab('r1'), makeTab('r2')], 'r2'),
  focusedSide: 'right',
  splitRatio: 0.5,
};

const SHEET_DISPLAY = new Map([
  ['l1', { title: 'Left one', projectName: 'Alpha', activity: null }],
  ['l2', { title: 'Left preview', projectName: 'Alpha', activity: 'running' as const }],
  ['r1', { title: 'Right one', projectName: 'Alpha', activity: 'attention' as const }],
  ['r2', { title: 'Right two', projectName: 'Alpha', activity: null }],
]);

const renderSheet = (overrides: Partial<ComponentProps<typeof PaneTabsSheet>> = {}) => {
  const onOpenChange = vi.fn();
  render(
    <PaneTabsSheet
      open
      onOpenChange={onOpenChange}
      layout={SPLIT_LAYOUT}
      tabDisplay={SHEET_DISPLAY}
      newChatProject={ALPHA}
      actions={actions}
      {...overrides}
    />,
  );
  return onOpenChange;
};

const setLayout = (layout: WorkspaceLayout) => {
  panes.state = {
    layout,
    paneProjects: { left: layout.left.tabs.length > 0 ? ALPHA : null, right: layout.right?.tabs.length ? ALPHA : null },
    projects: [ALPHA],
    isLoadingProjects: false,
    attentionSessionIds: NO_SESSIONS,
    fallbackProject: ALPHA,
    actions,
    openSettings: vi.fn(),
    setSidebarOpen: vi.fn(),
    renameSession: vi.fn(async () => true),
    refreshProjectsSilently: vi.fn(async () => undefined),
  };
};

const phoneRegion = ({ isImmersive = false } = {}) => (
  <WorkspaceChromeProvider
    value={{
      isImmersive,
      isBrowserFullscreen: false,
      toggleImmersive,
      exitImmersive: vi.fn(),
      isSidebarPeekOpen: false,
      setSidebarPeekOpen: vi.fn(),
      canSplit: false,
    }}
  >
    <ProjectMainRegion isMobile ws={null} sendMessage={() => undefined} navigate={vi.fn() as unknown as NavigateFunction} />
  </WorkspaceChromeProvider>
);

beforeEach(() => {
  actions = makeActions();
  toggleImmersive.mockReset();
});

test('split, the sheet lists both panes\' tabs by side, with previews in italics and activity marks', () => {
  renderSheet();

  const dialog = screen.getByRole('dialog', { name: 'All tabs' });
  const left = within(dialog).getByRole('region', { name: 'Left pane' });
  const right = within(dialog).getByRole('region', { name: 'Right pane' });
  assert.ok(within(left).getByRole('heading', { name: 'Left pane' }));
  assert.ok(within(right).getByRole('heading', { name: 'Right pane' }));

  // Rows are the buttons without an aria-label of their own (the × buttons have one).
  const rowTitles = (region: HTMLElement) => within(region).getAllByRole('button')
    .filter((button) => !button.hasAttribute('aria-label'))
    .map((row) => row.textContent);
  assert.deepEqual(rowTitles(left), ['Left oneAlpha', 'Left previewAlpha']);
  assert.deepEqual(rowTitles(right), ['Right oneAlpha', 'Right twoAlpha']);

  assert.ok(within(left).getByText('Left preview').classList.contains('italic'));
  assert.equal(within(left).getByText('Left one').classList.contains('italic'), false);
  assert.ok(within(left).getByRole('img', { name: 'Processing session' }), 'a running session spins');
  assert.ok(within(right).getByRole('img', { name: 'Session needs attention' }), 'one needing attention gets the amber dot');
  // Only the focused pane's active tab is the current one.
  assert.equal(within(right).getByRole('button', { name: /Right two/ }).getAttribute('aria-current'), 'page');
  assert.equal(within(left).getByRole('button', { name: /Left one/ }).hasAttribute('aria-current'), false);
});

test('a row switches to its tab on its side and closes the sheet; × closes that tab and leaves the sheet open', () => {
  const onOpenChange = renderSheet();

  fireEvent.click(screen.getByRole('button', { name: /Left preview/ }));
  assert.deepEqual(vi.mocked(actions.activateTab).mock.calls, [['left', 'l2']]);
  assert.deepEqual(onOpenChange.mock.calls, [[false]]);

  onOpenChange.mockClear();
  const rightRegion = screen.getByRole('region', { name: 'Right pane' });
  const closeButtons = within(rightRegion).getAllByRole('button', { name: 'Close tab' });
  fireEvent.click(closeButtons[0]);
  assert.deepEqual(vi.mocked(actions.closeTab).mock.calls, [['right', 'r1']]);
  assert.equal(onOpenChange.mock.calls.length, 0);
});

test('the footer starts a new chat in the focused pane and closes every tab, the right pane first', () => {
  const onOpenChange = renderSheet();

  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  assert.deepEqual(vi.mocked(actions.openNewSession).mock.calls, [[ALPHA, { target: 'focused' }]]);
  assert.deepEqual(onOpenChange.mock.calls, [[false]]);

  fireEvent.click(screen.getByRole('button', { name: 'Close all tabs' }));
  // Emptying the left pane first would move the right pane's tabs into it, out of reach of the second close.
  assert.deepEqual(vi.mocked(actions.closeAllTabs).mock.calls, [['right'], ['left']]);
});

test('unsplit, the sheet lists the one pane without side headings', () => {
  renderSheet({
    layout: { left: makePane([makeTab('l1'), makeTab('l2')]), right: null, focusedSide: 'left', splitRatio: 0.5 },
  });

  assert.equal(screen.queryByRole('heading', { name: 'Left pane' }) === null, true);
  assert.equal(screen.queryByRole('region', { name: 'Right pane' }) === null, true);
  assert.equal(screen.getAllByRole('button', { name: 'Close tab' }).length, 2);
  fireEvent.click(screen.getByRole('button', { name: 'Close all tabs' }));
  assert.deepEqual(vi.mocked(actions.closeAllTabs).mock.calls, [['left']]);
});

test('on a phone the header offers Tabs once there is more than one tab or a right pane, and it opens the sheet', () => {
  setLayout({ left: makePane([makeTab('a1')]), right: null, focusedSide: 'left', splitRatio: 0.5 });
  const view = render(phoneRegion());
  assert.equal(screen.queryByRole('button', { name: /^Tabs/ }) === null, true, 'one tab needs no switcher');
  fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
  assert.equal(toggleImmersive.mock.calls.length, 1);

  setLayout({ left: makePane([makeTab('a1'), makeTab('a2')]), right: null, focusedSide: 'left', splitRatio: 0.5 });
  view.rerender(phoneRegion());
  assert.equal(screen.queryByRole('dialog') === null, true);
  fireEvent.click(screen.getByRole('button', { name: 'Tabs (2)' }));
  const dialog = screen.getByRole('dialog', { name: 'All tabs' });
  assert.ok(within(dialog).getByRole('button', { name: /Chat a2/ }));
});

test('an empty right pane on a phone still offers Tabs; immersive hides the header controls', () => {
  setLayout({ left: makePane([makeTab('a1')]), right: makePane([]), focusedSide: 'right', splitRatio: 0.5 });
  const view = render(phoneRegion());

  assert.ok(screen.getByRole('heading', { name: 'This side is empty' }));
  fireEvent.click(screen.getByRole('button', { name: 'Tabs (1)' }));
  assert.ok(screen.getByRole('dialog', { name: 'All tabs' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(screen.queryByRole('dialog') === null, true);

  view.rerender(phoneRegion({ isImmersive: true }));
  assert.equal(screen.queryByRole('button', { name: /^Tabs/ }) === null, true, 'the floating capsule is the way out while immersive');
  assert.equal(screen.queryByRole('button', { name: 'Exit full screen' }) === null, true);

  setLayout({ left: makePane([makeTab('a1'), makeTab('a2')]), right: null, focusedSide: 'left', splitRatio: 0.5 });
  view.rerender(phoneRegion({ isImmersive: true }));
  assert.equal(screen.queryByRole('button', { name: /^Tabs/ }) === null, true);
});
