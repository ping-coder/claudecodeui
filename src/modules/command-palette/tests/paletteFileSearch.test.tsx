import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { CommandPaletteWorkspaceCommands, Project } from '@/shared/types';

/**
 * Regression guard: typing "claude" in the palette did not find CLAUDE.md. The
 * root page rendered only the first five files and cmdk filters only what is
 * rendered, and every absolute path matched through the project folder's own
 * name, so all files scored the same. Gitignored files such as .env are found
 * by searching but never listed before anything is typed. A search also puts
 * the group holding the best match first, so Enter opens that match.
 */

const ROOT = '/home/u/claudecodeui';

const fileAt = (relativePath: string, isIgnored = false) => ({
  path: `${ROOT}/${relativePath}`,
  name: relativePath.split('/').pop() ?? relativePath,
  relativePath,
  isIgnored,
});

// The source's order: .env (gitignored) first, five weaker "claude" matches
// from the third on, CLAUDE.md tenth, and files that match nothing around them.
const FILES = Array.from({ length: 30 }, (_, index) => fileAt(
  index === 0
    ? '.env'
    : index >= 2 && index <= 6
      ? `docs/claude-notes-${index}.md`
      : index === 9
        ? 'CLAUDE.md'
        : `file-${index}.txt`,
  index === 0,
));

// What the sources hand the palette in the current test.
let files: Array<ReturnType<typeof fileAt>> = FILES;
let sessions: Array<{ id: string; label: string; provider?: string }> = [];
let branches: Array<{ name: string }> = [];

const openFile = vi.fn<(path: string) => void>();
const checkout = vi.fn<(branch: string) => void>();
const onOpenSettings = vi.fn<(tab?: string) => void>();
const onOpenSession = vi.fn();
const onActivateTab = vi.fn();

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ toggleDarkMode: () => undefined }),
}));
vi.mock('@/modules/command-palette/context/PaletteOpsContext', () => ({
  usePaletteOps: () => ({ openFile: (path: string) => openFile(path) }),
}));
vi.mock('@/modules/command-palette/hooks/useSessionsSource', () => ({
  useSessionsSource: (projectId: string | undefined, enabled: boolean) => (projectId && enabled ? sessions : []),
}));
vi.mock('@/modules/command-palette/hooks/useSessionMessageSearch', () => ({ useSessionMessageSearch: () => [] }));
vi.mock('@/modules/command-palette/hooks/useFilesSource', () => ({
  useFilesSource: (projectId: string | undefined, enabled: boolean) => (projectId && enabled ? files : []),
}));
vi.mock('@/modules/command-palette/hooks/useCommitsSource', () => ({ useCommitsSource: () => [] }));
vi.mock('@/modules/command-palette/hooks/useBranchesSource', () => ({
  useBranchesSource: (projectId: string | undefined, enabled: boolean) => (projectId && enabled ? branches : []),
}));
vi.mock('@/modules/command-palette/hooks/useGitActions', () => ({
  useGitActions: () => ({
    fetch: async () => undefined,
    pull: async () => undefined,
    push: async () => undefined,
    checkout: async (branch: string) => checkout(branch),
  }),
}));

const { default: CommandPalette } = await import('@/modules/command-palette/CommandPalette');

const project: Project = {
  projectId: 'project-1',
  displayName: 'claudecodeui',
  fullPath: ROOT,
  path: ROOT,
  sessions: [],
};

// Two tabs, so the Open tabs group is offered, and each names the claudecodeui project.
const workspace: CommandPaletteWorkspaceCommands = {
  canSplit: true,
  isSplit: false,
  isImmersive: false,
  openTabs: [
    { side: 'left', tabKey: 'tab-login', title: 'Fix login bug', provider: 'claude', projectName: 'claudecodeui', isActive: true },
    { side: 'left', tabKey: 'tab-notes', title: 'Write release notes', provider: 'codex', projectName: 'claudecodeui', isActive: false },
  ],
  onToggleSplit: () => undefined,
  onFocusPane: () => undefined,
  onMoveActiveTabToOtherSide: () => undefined,
  onCloseOtherTabs: () => undefined,
  onCloseFocusedPane: () => undefined,
  onActivateTab: (...args) => onActivateTab(...args),
  onToggleFullscreen: () => undefined,
};

const openPalette = (workspaceCommands?: CommandPaletteWorkspaceCommands) => {
  render(
    <CommandPalette
      selectedProject={project}
      onStartNewChat={() => undefined}
      onOpenSettings={onOpenSettings}
      onOpenSession={onOpenSession}
      workspace={workspaceCommands}
    />,
  );
  act(() => {
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
  });
  assert.equal(screen.queryByRole('dialog') === null, false, 'the palette opened');
};

const search = (query: string) => {
  act(() => {
    fireEvent.change(screen.getByRole('combobox'), { target: { value: query } });
  });
};

const pressEnter = () => {
  act(() => {
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  });
};

// Each option reads as the file name followed by its path; none when nothing matches.
const fileOptionTexts = () => {
  const group = screen.queryByRole('group', { name: 'Files' });
  return group ? within(group).queryAllByRole('option').map((option) => option.textContent ?? '') : [];
};

const openFilesPage = () => {
  act(() => {
    fireEvent.click(within(screen.getByRole('group', { name: 'Files' })).getByRole('option', { name: /Browse all files/ }));
  });
};

// cmdk highlights every row whose value is the selected one.
const highlightedOptionTexts = () => screen.getAllByRole('option')
  .filter((option) => option.getAttribute('aria-selected') === 'true')
  .map((option) => option.textContent ?? '');

// The headings of the groups on screen, top to bottom.
const shownGroupHeadings = () => Array.from(document.querySelectorAll('[cmdk-group]:not([hidden]) [cmdk-group-heading]'))
  .map((heading) => heading.textContent ?? '');

beforeEach(() => {
  files = FILES;
  sessions = [];
  branches = [];
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

test('searching the root page puts CLAUDE.md first, wherever it sits in the list', () => {
  openPalette();

  search('claude');

  // The best five of six matches, shown with paths relative to the project.
  assert.deepEqual(fileOptionTexts(), [
    'CLAUDE.mdCLAUDE.md',
    'claude-notes-2.mddocs/claude-notes-2.md',
    'claude-notes-3.mddocs/claude-notes-3.md',
    'claude-notes-4.mddocs/claude-notes-4.md',
    'claude-notes-5.mddocs/claude-notes-5.md',
  ]);
});

test('claude then Enter opens CLAUDE.md, though open tabs, a session and Settings: Agents match too', () => {
  // The tabs match through their project's name, Agents through its "claude code" keywords.
  sessions = [{ id: 'session-parser', label: 'Ask claude about the parser', provider: 'claude' }];
  openPalette(workspace);

  search('claude');

  // The group with the best match first; the others, scoring alike, keep their usual order.
  assert.deepEqual(shownGroupHeadings(), ['Files', 'Open tabs', 'Settings', 'Sessions']);
  assert.deepEqual(highlightedOptionTexts(), ['CLAUDE.mdCLAUDE.md']);

  pressEnter();
  assert.deepEqual(openFile.mock.calls, [[`${ROOT}/CLAUDE.md`]]);
  assert.equal(onActivateTab.mock.calls.length, 0);
  assert.equal(onOpenSettings.mock.calls.length, 0);
  assert.equal(onOpenSession.mock.calls.length, 0);
});

test('the root page lists no gitignored file before anything is typed, but search finds it', () => {
  openPalette();

  assert.equal(fileOptionTexts().some((text) => text.includes('.env')), false);

  search('env');
  assert.deepEqual(fileOptionTexts(), ['.env.env']);
});

test('the files page holds back gitignored files until a search, and matches relative paths', () => {
  openPalette();
  // Counted as the page lists them before anything is typed.
  assert.equal(fileOptionTexts().includes('Browse all files (29)'), true);
  openFilesPage();

  const listed = fileOptionTexts();
  assert.equal(listed.length, 29);
  assert.equal(listed.some((text) => text.includes('.env')), false);

  // Every absolute path contains "claude" through the project folder's name.
  search('claude');
  const matches = fileOptionTexts();
  assert.equal(matches.length, 6);
  assert.equal(matches[0], 'CLAUDE.mdCLAUDE.md');
});

test('no Browse all files when the files page would list no more than the root page', () => {
  // Three files to list, and seven gitignored logs that only a search finds.
  files = [
    ...['a.ts', 'b.ts', 'c.ts'].map((name) => fileAt(name)),
    ...Array.from({ length: 7 }, (_, index) => fileAt(`logs/run-${index}.log`, true)),
  ];
  openPalette();

  assert.deepEqual(fileOptionTexts(), ['a.tsa.ts', 'b.tsb.ts', 'c.tsc.ts']);
});

test('a pasted absolute path finds its file as its relative path does, on the root page and the files page', () => {
  openPalette();

  search('CLAUDE.md');
  const rootPageMatches = fileOptionTexts();
  assert.equal(rootPageMatches[0], 'CLAUDE.mdCLAUDE.md');
  search(`${ROOT}/CLAUDE.md`);
  assert.deepEqual(fileOptionTexts(), rootPageMatches);

  search('');
  openFilesPage();
  search('CLAUDE.md');
  const filesPageMatches = fileOptionTexts();
  assert.equal(filesPageMatches[0], 'CLAUDE.mdCLAUDE.md');
  search(`${ROOT}/CLAUDE.md`);
  assert.deepEqual(fileOptionTexts(), filesPageMatches);
});

test('a Windows path pasted with backslashes finds its file', () => {
  files = [
    { path: 'C:\\Users\\u\\proj\\README.md', name: 'README.md', relativePath: 'README.md', isIgnored: false },
    { path: 'C:\\Users\\u\\proj\\src\\a.ts', name: 'a.ts', relativePath: 'src/a.ts', isIgnored: false },
  ];
  openPalette();

  search('C:\\Users\\u\\proj\\src\\a.ts');
  assert.deepEqual(fileOptionTexts(), ['a.tssrc/a.ts']);
});

test('a file and a branch with the same name stay two rows: picking the branch switches to it', () => {
  // A build output at the project root, named like the branch it was built on.
  files = [fileAt('main', true), fileAt('main.go')];
  branches = [{ name: 'main' }, { name: 'dev' }];
  openPalette();
  search('main');

  act(() => {
    fireEvent.pointerMove(within(screen.getByRole('group', { name: 'Branches' })).getByRole('option', { name: 'Switch to: main' }));
  });
  assert.deepEqual(highlightedOptionTexts(), ['Switch to: main']);

  pressEnter();
  assert.deepEqual(checkout.mock.calls, [['main']]);
  assert.equal(openFile.mock.calls.length, 0);
});
