import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type {
  CommandPaletteWorkspaceCommands,
  Project,
  SessionOpenOptions,
  WorkspaceOpenTabSummary,
} from '@/shared/types';

/**
 * The command palette acts on the focused pane of the split workspace: a session result opens in the
 * focused pane on Enter and in the other pane on Ctrl/Cmd+Enter (or Ctrl/Cmd-click), the Workspace
 * group runs the pane commands and shows their shortcuts, and Open tabs switches to any tab of either pane.
 */

const SESSIONS = [
  { id: 'session-fix', label: 'Fix login bug', provider: 'claude' },
  { id: 'session-parser', label: 'Refactor parser', provider: 'codex' },
];

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ toggleDarkMode: () => undefined }),
}));
vi.mock('@/modules/command-palette/hooks/useSessionsSource', () => ({
  useSessionsSource: (projectId: string | undefined, enabled: boolean) => (projectId && enabled ? SESSIONS : []),
}));
vi.mock('@/modules/command-palette/hooks/useSessionMessageSearch', () => ({ useSessionMessageSearch: () => [] }));
vi.mock('@/modules/command-palette/hooks/useFilesSource', () => ({ useFilesSource: () => ({ files: [], tooLarge: false }) }));
vi.mock('@/modules/command-palette/hooks/useCommitsSource', () => ({ useCommitsSource: () => [] }));
vi.mock('@/modules/command-palette/hooks/useBranchesSource', () => ({ useBranchesSource: () => [] }));
vi.mock('@/modules/command-palette/hooks/useGitActions', () => ({
  useGitActions: () => ({
    fetch: async () => undefined,
    pull: async () => undefined,
    push: async () => undefined,
    checkout: async () => undefined,
  }),
}));

const { default: CommandPalette } = await import('@/modules/command-palette/CommandPalette');

const project: Project = {
  projectId: 'project-1',
  displayName: 'repo',
  fullPath: '/repo',
  path: '/repo',
  sessions: [],
};

// The same session is open on both sides; the focused (left) pane has two tabs.
const OPEN_TABS: WorkspaceOpenTabSummary[] = [
  { side: 'left', tabKey: 'tab-left-fix', title: 'Fix login bug', provider: 'claude', projectName: 'repo', isActive: true },
  { side: 'left', tabKey: 'tab-left-notes', title: 'Write release notes', provider: 'codex', projectName: 'repo', isActive: false },
  { side: 'right', tabKey: 'tab-right-fix', title: 'Fix login bug', provider: 'claude', projectName: 'repo', isActive: false },
];

const onOpenSession = vi.fn<(sessionId: string, options: SessionOpenOptions) => void>();

const createWorkspace = (overrides: Partial<CommandPaletteWorkspaceCommands> = {}): CommandPaletteWorkspaceCommands => ({
  canSplit: true,
  isSplit: true,
  isImmersive: false,
  openTabs: OPEN_TABS,
  onToggleSplit: vi.fn(),
  onFocusPane: vi.fn(),
  onMoveActiveTabToOtherSide: vi.fn(),
  onCloseOtherTabs: vi.fn(),
  onCloseFocusedPane: vi.fn(),
  onActivateTab: vi.fn(),
  onToggleFullscreen: vi.fn(),
  ...overrides,
});

const renderPalette = (workspace?: CommandPaletteWorkspaceCommands) => render(
  <CommandPalette
    selectedProject={project}
    onStartNewChat={() => undefined}
    onOpenSettings={() => undefined}
    onShowTab={() => undefined}
    onOpenSession={onOpenSession}
    workspace={workspace}
  />,
);

const openPalette = () => {
  act(() => {
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
  });
  assert.ok(screen.queryByRole('dialog'), 'the palette opened');
};

const isPaletteOpen = () => screen.queryByRole('dialog') !== null;

const searchInput = () => screen.getByRole('combobox');

const search = (query: string) => {
  act(() => {
    fireEvent.change(searchInput(), { target: { value: query } });
  });
};

/** Highlights an item the way hovering does, so the next Enter picks it. */
const highlight = (option: HTMLElement) => {
  act(() => {
    fireEvent.pointerMove(option);
  });
  assert.equal(option.getAttribute('aria-selected'), 'true');
};

const pressEnter = (modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {}) => {
  act(() => {
    fireEvent.keyDown(searchInput(), { key: 'Enter', ...modifiers });
  });
};

/** A mouse pick: pointerdown (jsdom has no PointerEvent, so a MouseEvent of that type) then click. */
const clickOption = (option: HTMLElement, modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {}) => {
  act(() => {
    option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, ...modifiers }));
    fireEvent.click(option, modifiers);
  });
};

const sessionOption = (label: string) => within(screen.getByRole('group', { name: 'Sessions' }))
  .getByRole('option', { name: new RegExp(label) });

const groupOptionNames = (groupName: string) => within(screen.getByRole('group', { name: groupName }))
  .getAllByRole('option')
  .map((option) => option.textContent ?? '');

beforeEach(() => {
  onOpenSession.mockReset();
  // jsdom ships no ResizeObserver or scrollIntoView, which cmdk's list uses.
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('Enter on a session result opens it in the focused pane as a kept tab', () => {
  renderPalette(createWorkspace());
  openPalette();

  highlight(sessionOption('Refactor parser'));
  pressEnter();

  assert.deepEqual(onOpenSession.mock.calls, [['session-parser', { target: 'focused', preview: false }]]);
  assert.equal(isPaletteOpen(), false);
});

test('Ctrl+Enter and Cmd+Enter send a session result to the other pane', () => {
  renderPalette(createWorkspace());

  openPalette();
  highlight(sessionOption('Refactor parser'));
  pressEnter({ ctrlKey: true });

  openPalette();
  highlight(sessionOption('Fix login bug'));
  pressEnter({ metaKey: true });

  // A plain Enter right after still goes to the focused pane: the modifier is read per gesture.
  openPalette();
  highlight(sessionOption('Fix login bug'));
  pressEnter();

  assert.deepEqual(onOpenSession.mock.calls, [
    ['session-parser', { target: 'other' }],
    ['session-fix', { target: 'other' }],
    ['session-fix', { target: 'focused', preview: false }],
  ]);
});

test('a Ctrl/Cmd-click sends a session result to the other pane, a plain click to the focused one', () => {
  renderPalette(createWorkspace({ isSplit: false }));

  openPalette();
  clickOption(sessionOption('Refactor parser'), { ctrlKey: true });
  openPalette();
  clickOption(sessionOption('Refactor parser'), { metaKey: true });
  openPalette();
  clickOption(sessionOption('Refactor parser'));

  assert.deepEqual(onOpenSession.mock.calls, [
    ['session-parser', { target: 'other' }],
    ['session-parser', { target: 'other' }],
    ['session-parser', { target: 'focused', preview: false }],
  ]);
});

test('with no other pane to use, Ctrl+Enter opens in the focused pane and no hint offers otherwise', () => {
  const { rerender } = renderPalette(createWorkspace({ canSplit: false, isSplit: false }));
  openPalette();
  assert.equal(sessionOption('Refactor parser').textContent?.includes('Open on the other side'), false);
  highlight(sessionOption('Refactor parser'));
  pressEnter({ ctrlKey: true });

  // Already split but too narrow to show both: the other pane exists, so it is still a target.
  rerender(
    <CommandPalette
      selectedProject={project}
      onStartNewChat={() => undefined}
      onOpenSettings={() => undefined}
      onOpenSession={onOpenSession}
      workspace={createWorkspace({ canSplit: false, isSplit: true })}
    />,
  );
  openPalette();
  assert.ok(sessionOption('Refactor parser').textContent?.includes('Ctrl+EnterOpen on the other side'));
  highlight(sessionOption('Refactor parser'));
  pressEnter({ ctrlKey: true });

  // Outside the split workspace (no workspace commands) the palette opens sessions as before.
  rerender(
    <CommandPalette
      selectedProject={project}
      onStartNewChat={() => undefined}
      onOpenSettings={() => undefined}
      onOpenSession={onOpenSession}
    />,
  );
  openPalette();
  assert.equal(screen.queryByRole('group', { name: 'Workspace' }) === null, true);
  assert.equal(screen.queryByRole('group', { name: 'Open tabs' }) === null, true);
  highlight(sessionOption('Refactor parser'));
  pressEnter({ metaKey: true });

  assert.deepEqual(onOpenSession.mock.calls, [
    ['session-parser', { target: 'focused', preview: false }],
    ['session-parser', { target: 'other' }],
    ['session-parser', { target: 'focused', preview: false }],
  ]);
});

test('the Workspace group shows each pane command with its shortcut and runs it', () => {
  const workspace = createWorkspace();
  renderPalette(workspace);
  openPalette();

  assert.deepEqual(groupOptionNames('Workspace'), [
    'Merge panesCtrl+\\',
    'Focus left paneCtrl+1',
    'Focus right paneCtrl+2',
    'Move to the other side',
    'Close other tabs',
    'Close this side',
    'Full screenCtrl+Shift+Enter',
  ]);

  const pick = (label: string) => {
    if (!isPaletteOpen()) {
      openPalette();
    }
    const option = within(screen.getByRole('group', { name: 'Workspace' })).getByRole('option', { name: new RegExp(`^${label}`) });
    clickOption(option);
    assert.equal(isPaletteOpen(), false, `${label} closes the palette`);
  };

  pick('Merge panes');
  assert.equal(vi.mocked(workspace.onToggleSplit).mock.calls.length, 1);
  pick('Focus left pane');
  pick('Focus right pane');
  assert.deepEqual(vi.mocked(workspace.onFocusPane).mock.calls, [['left'], ['right']]);
  pick('Move to the other side');
  assert.equal(vi.mocked(workspace.onMoveActiveTabToOtherSide).mock.calls.length, 1);
  pick('Close other tabs');
  assert.equal(vi.mocked(workspace.onCloseOtherTabs).mock.calls.length, 1);
  pick('Close this side');
  assert.equal(vi.mocked(workspace.onCloseFocusedPane).mock.calls.length, 1);
  pick('Full screen');
  assert.equal(vi.mocked(workspace.onToggleFullscreen).mock.calls.length, 1);
  assert.equal(onOpenSession.mock.calls.length, 0);
});

test('right to left the panes are named and found by where they are drawn: the first one on the right', () => {
  // What <html dir="rtl"> computes in a browser; jsdom neither maps dir to direction nor inherits it.
  const style = document.createElement('style');
  style.textContent = '[dir="rtl"], [dir="rtl"] * { direction: rtl; }';
  document.head.append(style);
  document.documentElement.setAttribute('dir', 'rtl');
  try {
    const workspace = createWorkspace();
    renderPalette(workspace);
    openPalette();
    assert.deepEqual(groupOptionNames('Workspace').slice(1, 3), ['Focus right paneCtrl+1', 'Focus left paneCtrl+2']);

    search('focus right');
    assert.deepEqual(groupOptionNames('Workspace').filter((name) => name.startsWith('Focus')), ['Focus right paneCtrl+1']);
    search('left');
    assert.deepEqual(groupOptionNames('Workspace').filter((name) => name.startsWith('Focus')), ['Focus left paneCtrl+2']);
    assert.deepEqual(groupOptionNames('Open tabs'), ['Fix login bugrepo · Left paneClaude'], 'only the tab drawn on the left');

    clickOption(within(screen.getByRole('group', { name: 'Workspace' })).getByRole('option', { name: /^Focus left pane/ }));
    assert.deepEqual(vi.mocked(workspace.onFocusPane).mock.calls, [['right']]);
  } finally {
    document.documentElement.removeAttribute('dir');
    style.remove();
  }
});

test('unsplit, Split is offered (disabled with the reason when too narrow) and pane-only commands are left out', () => {
  const singleTab: WorkspaceOpenTabSummary[] = [OPEN_TABS[0]];
  const narrow = createWorkspace({ canSplit: false, isSplit: false, openTabs: singleTab });
  const { rerender } = renderPalette(narrow);
  openPalette();

  assert.deepEqual(groupOptionNames('Workspace'), [
    'Split viewWiden the window to splitCtrl+\\',
    'Full screenCtrl+Shift+Enter',
  ]);
  const splitOption = within(screen.getByRole('group', { name: 'Workspace' })).getByRole('option', { name: /^Split view/ });
  assert.equal(splitOption.getAttribute('aria-disabled'), 'true');
  clickOption(splitOption);
  assert.equal(vi.mocked(narrow.onToggleSplit).mock.calls.length, 0);
  // Only the tab already on screen: nothing to switch to, so no Open tabs group.
  assert.equal(screen.queryByRole('group', { name: 'Open tabs' }) === null, true);

  const wide = createWorkspace({ isSplit: false, isImmersive: true, openTabs: OPEN_TABS.slice(0, 2) });
  rerender(
    <CommandPalette
      selectedProject={project}
      onStartNewChat={() => undefined}
      onOpenSettings={() => undefined}
      onOpenSession={onOpenSession}
      workspace={wide}
    />,
  );
  assert.deepEqual(groupOptionNames('Workspace'), [
    'Split viewCtrl+\\',
    'Move to the other side',
    'Close other tabs',
    'Exit full screenCtrl+Shift+Enter',
  ]);
  clickOption(within(screen.getByRole('group', { name: 'Workspace' })).getByRole('option', { name: /^Split view/ }));
  assert.equal(vi.mocked(wide.onToggleSplit).mock.calls.length, 1);
});

test('search finds the split and full screen commands by split, 分屏, fullscreen and 全屏', () => {
  renderPalette(createWorkspace({ isSplit: false }));
  openPalette();

  const workspaceOptions = () => {
    const group = screen.queryByRole('group', { name: 'Workspace' });
    return group ? within(group).queryAllByRole('option').map((option) => option.textContent ?? '') : [];
  };
  const hasOption = (prefix: string) => workspaceOptions().some((name) => name.startsWith(prefix));

  for (const query of ['split', '分屏']) {
    search(query);
    assert.ok(hasOption('Split view'), `"${query}" finds Split view`);
  }
  for (const query of ['fullscreen', '全屏']) {
    search(query);
    assert.ok(hasOption('Full screen'), `"${query}" finds Full screen`);
  }
});

test('Refresh tab and Refresh all come before full screen, are found by refresh, reload, 刷新 and 重新加载, and run', () => {
  const workspace = createWorkspace({ isSplit: false, onRefreshTab: vi.fn(), canRefreshTab: true, onRefreshAll: vi.fn() });
  const { rerender } = renderPalette(workspace);
  openPalette();

  assert.deepEqual(groupOptionNames('Workspace').slice(-3), ['Refresh tab', 'Refresh all', 'Full screenCtrl+Shift+Enter']);
  const workspaceOptions = () => within(screen.getByRole('group', { name: 'Workspace' })).queryAllByRole('option').map((option) => option.textContent ?? '');
  for (const query of ['refresh', 'reload', '刷新', '重新加载']) {
    search(query);
    assert.deepEqual(workspaceOptions().filter((name) => name.startsWith('Refresh')), ['Refresh tab', 'Refresh all'], `"${query}"`);
  }

  clickOption(within(screen.getByRole('group', { name: 'Workspace' })).getByRole('option', { name: /^Refresh tab/ }));
  assert.equal(vi.mocked(workspace.onRefreshTab as () => void).mock.calls.length, 1);
  openPalette();
  clickOption(within(screen.getByRole('group', { name: 'Workspace' })).getByRole('option', { name: /^Refresh all/ }));
  assert.equal(vi.mocked(workspace.onRefreshAll as () => void).mock.calls.length, 1);

  // Nothing on screen to refresh, and a refresh of everything already running.
  const busy = createWorkspace({ isSplit: false, onRefreshTab: vi.fn(), canRefreshTab: false, onRefreshAll: vi.fn(), isRefreshingWorkspace: true });
  rerender(
    <CommandPalette
      selectedProject={project}
      onStartNewChat={() => undefined}
      onOpenSettings={() => undefined}
      onOpenSession={onOpenSession}
      workspace={busy}
    />,
  );
  openPalette();
  assert.deepEqual(groupOptionNames('Workspace').filter((name) => name.startsWith('Refresh')), ['Refresh allRefreshing…']);
  const refreshAll = within(screen.getByRole('group', { name: 'Workspace' })).getByRole('option', { name: /^Refresh all/ });
  assert.equal(refreshAll.getAttribute('aria-disabled'), 'true');
  clickOption(refreshAll);
  assert.equal(vi.mocked(busy.onRefreshAll as () => void).mock.calls.length, 0);
});

test('Open tabs lists the tabs of both panes and activates the picked one in its pane', () => {
  const workspace = createWorkspace();
  renderPalette(workspace);
  openPalette();

  const group = screen.getByRole('group', { name: 'Open tabs' });
  const options = within(group).getAllByRole('option');
  assert.deepEqual(options.map((option) => option.textContent), [
    'Fix login bugrepo · Left paneClaude',
    'Write release notesrepo · Left paneCodex',
    'Fix login bugrepo · Right paneClaude',
  ]);
  // Only the focused pane's active tab is marked as the current one.
  assert.deepEqual(options.map((option) => option.getAttribute('aria-current')), ['true', null, null]);

  // The same session open on both sides stays two distinct entries: picking the right one targets the right pane.
  highlight(options[2]);
  assert.equal(options[0].getAttribute('aria-selected'), 'false');
  pressEnter();
  assert.deepEqual(vi.mocked(workspace.onActivateTab).mock.calls, [['right', 'tab-right-fix']]);
  assert.equal(onOpenSession.mock.calls.length, 0);

  openPalette();
  clickOption(within(screen.getByRole('group', { name: 'Open tabs' })).getByRole('option', { name: /^Write release notes/ }));
  assert.deepEqual(vi.mocked(workspace.onActivateTab).mock.calls, [['right', 'tab-right-fix'], ['left', 'tab-left-notes']]);
});

test('two tabs with the same title in one pane stay separate entries', () => {
  // Two different sessions that were never given a title, side by side in an unsplit workspace.
  const workspace = createWorkspace({
    isSplit: false,
    openTabs: [
      { side: 'left', tabKey: 'tab-first', title: 'New Session', provider: 'claude', projectName: 'repo', isActive: true },
      { side: 'left', tabKey: 'tab-second', title: 'New Session', provider: 'claude', projectName: 'repo', isActive: false },
    ],
  });
  renderPalette(workspace);
  openPalette();

  const options = within(screen.getByRole('group', { name: 'Open tabs' })).getAllByRole('option');
  highlight(options[1]);
  assert.equal(options[0].getAttribute('aria-selected'), 'false');
  pressEnter();
  assert.deepEqual(vi.mocked(workspace.onActivateTab).mock.calls, [['left', 'tab-second']]);
});
