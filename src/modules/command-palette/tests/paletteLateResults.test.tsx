import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { CommandPaletteWorkspaceCommands, Project } from '@/shared/types';

/**
 * Regression guard: the files list and session search answer after the last keystroke, and a
 * search puts the group holding the best match first. cmdk kept its highlight on the row that was
 * first before they landed, so Enter activated an open tab or opened Settings: Agents instead of
 * opening CLAUDE.md. A row that lands on top now takes the highlight, unless the user moved it.
 */

const ROOT = '/home/u/claudecodeui';

const fileAt = (relativePath: string) => ({
  path: `${ROOT}/${relativePath}`,
  name: relativePath.split('/').pop() ?? relativePath,
  relativePath,
  isIgnored: false,
});

// Of these, only CLAUDE.md matches "claude".
const FILES = [
  fileAt('CLAUDE.md'),
  fileAt('package.json'),
  ...Array.from({ length: 8 }, (_, index) => fileAt(`file-${index}.txt`)),
];

// A session found through its messages, whose title matches "claude" a little better than CLAUDE.md does.
const MESSAGE_MATCHES = [
  { sessionId: 'session-hooks', label: 'Claude hooks notes', snippet: 'We set up claude hooks for this repo', provider: 'claude' },
];

// What the files source and the session search have answered so far.
const sources = vi.hoisted(() => ({
  files: [] as Array<{ path: string; name: string; relativePath: string; isIgnored: boolean }>,
  messageMatches: [] as Array<{ sessionId: string; label: string; snippet: string; provider: string }>,
  listeners: new Set<() => void>(),
}));

const openFile = vi.fn<(path: string) => void>();
const onOpenSettings = vi.fn<(tab?: string) => void>();
const onOpenSession = vi.fn();
const onActivateTab = vi.fn();

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ toggleDarkMode: () => undefined }),
}));
vi.mock('@/modules/command-palette/context/PaletteOpsContext', () => ({
  usePaletteOps: () => ({ openFile: (path: string) => openFile(path) }),
}));
vi.mock('@/modules/command-palette/hooks/useSessionsSource', () => ({ useSessionsSource: () => [] }));
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
// Both sources re-render the palette when a test lands an answer, as a finished request does.
vi.mock('@/modules/command-palette/hooks/useFilesSource', async () => {
  const React = await import('react');
  return {
    useFilesSource: (projectId: string | undefined, enabled: boolean) => {
      const files = React.useSyncExternalStore(
        (listener) => {
          sources.listeners.add(listener);
          return () => sources.listeners.delete(listener);
        },
        () => sources.files,
      );
      return { files: projectId && enabled ? files : [], tooLarge: false };
    },
  };
});
vi.mock('@/modules/command-palette/hooks/useSessionMessageSearch', async () => {
  const React = await import('react');
  return {
    useSessionMessageSearch: (projectId: string | undefined, _query: string, enabled: boolean) => {
      const matches = React.useSyncExternalStore(
        (listener) => {
          sources.listeners.add(listener);
          return () => sources.listeners.delete(listener);
        },
        () => sources.messageMatches,
      );
      return projectId && enabled ? matches : [];
    },
  };
});

const { default: CommandPalette } = await import('@/modules/command-palette/CommandPalette');

const project: Project = {
  projectId: 'project-1',
  displayName: 'claudecodeui',
  fullPath: ROOT,
  path: ROOT,
  sessions: [],
};

// Two tabs, so the Open tabs group is offered; both match "claude" through their project's name.
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

// The text of every element scrollIntoView was called on, oldest first.
const scrolledIntoView: string[] = [];

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

const pressKey = (key: string) => {
  act(() => {
    fireEvent.keyDown(screen.getByRole('combobox'), { key });
  });
};

/**
 * A source answers now, after the last keystroke. Async, so the palette's observer of its rows
 * runs inside act.
 */
const land = async (answer: () => void) => {
  await act(async () => {
    answer();
    sources.listeners.forEach((listener) => listener());
  });
};

// cmdk highlights every row whose value is the selected one.
const highlightedOptionTexts = () => screen.getAllByRole('option')
  .filter((option) => option.getAttribute('aria-selected') === 'true')
  .map((option) => option.textContent ?? '');

// The headings of the groups on screen, top to bottom.
const shownGroupHeadings = () => Array.from(document.querySelectorAll('[cmdk-group]:not([hidden]) [cmdk-group-heading]'))
  .map((heading) => heading.textContent ?? '');

// The text of the option a screen reader is pointed at.
const activeOptionText = () => {
  const id = screen.getByRole('combobox').getAttribute('aria-activedescendant');
  return id ? document.getElementById(id)?.textContent ?? null : null;
};

beforeEach(() => {
  sources.files = [];
  sources.messageMatches = [];
  scrolledIntoView.length = 0;
  // jsdom ships no ResizeObserver or scrollIntoView, which cmdk's list uses.
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolledIntoView.push(this.textContent ?? '');
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

for (const withOpenTabs of [true, false]) {
  test(`files that land after the last keystroke take the highlight to CLAUDE.md (${withOpenTabs ? 'with' : 'without'} open tabs)`, async () => {
    openPalette(withOpenTabs ? workspace : undefined);
    search('claude');
    // The best match until the files land: an open tab, or Settings: Agents through its "claude code" keywords.
    const firstBest = withOpenTabs ? 'Fix login bugclaudecodeuiClaude' : 'Settings: Agents';
    assert.deepEqual(highlightedOptionTexts(), [firstBest]);
    scrolledIntoView.length = 0;

    await land(() => {
      sources.files = FILES;
    });

    assert.deepEqual(shownGroupHeadings(), withOpenTabs ? ['Files', 'Open tabs', 'Settings'] : ['Files', 'Settings']);
    assert.deepEqual(highlightedOptionTexts(), ['CLAUDE.mdCLAUDE.md']);
    // Brought into view with its group's heading, as cmdk shows a row it highlights.
    assert.deepEqual(scrolledIntoView, ['Files', 'CLAUDE.mdCLAUDE.md']);

    pressKey('Enter');
    assert.deepEqual(openFile.mock.calls, [[`${ROOT}/CLAUDE.md`]]);
    assert.equal(onActivateTab.mock.calls.length, 0);
    assert.equal(onOpenSettings.mock.calls.length, 0);
  });
}

test('a session that session search lands on top takes the highlight', async () => {
  sources.files = FILES;
  openPalette(workspace);
  search('claude');
  assert.deepEqual(highlightedOptionTexts(), ['CLAUDE.mdCLAUDE.md']);

  await land(() => {
    sources.messageMatches = MESSAGE_MATCHES;
  });

  assert.equal(shownGroupHeadings()[0], 'Sessions');
  assert.deepEqual(highlightedOptionTexts().map((text) => text.startsWith('Claude hooks notes')), [true]);

  pressKey('Enter');
  assert.deepEqual(onOpenSession.mock.calls, [['session-hooks', { target: 'focused', preview: false }]]);
  assert.equal(openFile.mock.calls.length, 0);
});

// Two ways the user moves cmdk's highlight from CLAUDE.md to the first open tab, the next row down.
const MOVES_TO_FIRST_TAB: Array<[string, () => void]> = [
  ['the arrow keys', () => pressKey('ArrowDown')],
  ['the pointer', () => {
    act(() => {
      fireEvent.pointerMove(screen.getByRole('option', { name: /^Fix login bug/ }));
    });
  }],
];

for (const [how, moveToFirstTab] of MOVES_TO_FIRST_TAB) {
  test(`a highlight moved with ${how} after the files landed stays put when sessions land on top`, async () => {
    openPalette(workspace);
    search('claude');
    await land(() => {
      sources.files = FILES;
    });
    assert.deepEqual(highlightedOptionTexts(), ['CLAUDE.mdCLAUDE.md']);

    moveToFirstTab();
    assert.deepEqual(highlightedOptionTexts(), ['Fix login bugclaudecodeuiClaude']);
    // cmdk still makes this move itself, and points screen readers at the row it moved to.
    assert.equal(activeOptionText(), 'Fix login bugclaudecodeuiClaude');

    await land(() => {
      sources.messageMatches = MESSAGE_MATCHES;
    });

    assert.equal(shownGroupHeadings()[0], 'Sessions');
    assert.deepEqual(highlightedOptionTexts(), ['Fix login bugclaudecodeuiClaude']);

    pressKey('Enter');
    assert.deepEqual(onActivateTab.mock.calls, [['left', 'tab-login']]);
    assert.equal(onOpenSession.mock.calls.length, 0);
    assert.equal(openFile.mock.calls.length, 0);
  });
}
