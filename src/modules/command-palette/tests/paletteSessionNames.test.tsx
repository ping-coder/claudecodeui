import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { CommandPaletteWorkspaceCommands, Project } from '@/shared/types';

/**
 * The palette's session rows read a session's title as the rest of the workspace does, through the
 * formatter project-workspace hands it (sidebar's formatSessionTitle: "Untitled Claude Session" in
 * the interface language), and name the provider beside a session row or an open tab by its name,
 * not its id ("agy" read as such).
 */

const sources = vi.hoisted(() => ({
  sessions: [] as Array<{ id: string; label: string; provider?: string }>,
  messageMatches: [] as Array<{ sessionId: string; label: string; snippet: string; provider: string }>,
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ toggleDarkMode: () => undefined }),
}));
vi.mock('@/modules/command-palette/context/PaletteOpsContext', () => ({
  usePaletteOps: () => ({ openFile: () => undefined }),
}));
vi.mock('@/modules/command-palette/hooks/useSessionsSource', () => ({
  useSessionsSource: (projectId: string | undefined, enabled: boolean) => (projectId && enabled ? sources.sessions : []),
}));
vi.mock('@/modules/command-palette/hooks/useSessionMessageSearch', () => ({
  useSessionMessageSearch: (projectId: string | undefined, _query: string, enabled: boolean) => (projectId && enabled ? sources.messageMatches : []),
}));
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

const project: Project = { projectId: 'project-1', displayName: 'repo', fullPath: '/repo', path: '/repo', sessions: [] };

// No room for a second pane, so a highlighted session row carries no "open in the other pane" hint.
const workspace: CommandPaletteWorkspaceCommands = {
  canSplit: false,
  isSplit: false,
  isImmersive: false,
  openTabs: [
    { side: 'left', tabKey: 'tab-a', title: 'Fix login bug', provider: 'claude', projectName: 'repo', isActive: true },
    { side: 'left', tabKey: 'tab-b', title: 'Port the CLI', provider: 'agy', projectName: 'repo', isActive: false },
  ],
  onToggleSplit: () => undefined,
  onFocusPane: () => undefined,
  onMoveActiveTabToOtherSide: () => undefined,
  onCloseOtherTabs: () => undefined,
  onCloseFocusedPane: () => undefined,
  onActivateTab: () => undefined,
  onToggleFullscreen: () => undefined,
};

/** Stands in for sidebar's formatSessionTitle in Chinese. */
const formatInChinese = (title: string) => (title === 'Untitled Claude Session' ? '未命名的 Claude 会话' : title);

const openPalette = (formatSessionTitle?: (title: string) => string) => {
  render(
    <CommandPalette
      selectedProject={project}
      onStartNewChat={() => undefined}
      onOpenSettings={() => undefined}
      onOpenSession={() => undefined}
      workspace={workspace}
      formatSessionTitle={formatSessionTitle}
    />,
  );
  act(() => {
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
  });
  assert.equal(screen.queryByRole('dialog') === null, false, 'the palette opened');
};

/** The text of each row of a group, top to bottom. */
const rowsOf = (group: string) => within(screen.getByRole('group', { name: group })).getAllByRole('option').map((option) => option.textContent ?? '');

beforeEach(() => {
  sources.sessions = [
    { id: 'session-untitled', label: 'Untitled Claude Session', provider: 'claude' },
    { id: 'session-agy', label: 'Port the CLI', provider: 'agy' },
  ];
  sources.messageMatches = [];
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

test('a session row reads its title through the workspace\'s formatter, and its provider by name', () => {
  openPalette(formatInChinese);
  assert.deepEqual(rowsOf('Sessions'), ['未命名的 Claude 会话Claude', 'Port the CLIAntigravity']);
});

test('a session found by its messages reads the same way', () => {
  sources.sessions = [];
  sources.messageMatches = [{ sessionId: 'session-found', label: 'Untitled Claude Session', snippet: 'progress per file', provider: 'agy' }];
  openPalette(formatInChinese);
  act(() => {
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'progress' } });
  });
  assert.deepEqual(rowsOf('Sessions'), ['未命名的 Claude 会话progress per fileAntigravity']);
});

test('without a formatter a title shows as stored', () => {
  openPalette();
  assert.deepEqual(rowsOf('Sessions'), ['Untitled Claude SessionClaude', 'Port the CLIAntigravity']);
});

test('an open tab names its provider by name', () => {
  openPalette();
  assert.deepEqual(rowsOf('Open tabs'), ['Fix login bugrepoClaude', 'Port the CLIrepoAntigravity']);
});
