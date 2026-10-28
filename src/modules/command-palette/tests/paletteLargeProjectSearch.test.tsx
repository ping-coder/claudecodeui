import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { Project } from '@/shared/types';

/**
 * Regression guard: a project of more than 10,000 entries, which the listing refuses (413), only
 * said it was too large, and no file of it could be found. Typing now searches the project on the
 * server, and the palette ranks the answer as it ranks a listing; it says when the server searched
 * only part of the project, and falls back to the old note when the search fails. The real files
 * sources run here; only the API is faked.
 */

const ROOT = '/home/u/monorepo';

const fileAt = (relativePath: string, isIgnored = false) => ({
  path: `${ROOT}/${relativePath}`,
  name: relativePath.split('/').pop() ?? relativePath,
  relativePath,
  isIgnored,
});

type SearchAnswer = { ok: boolean; status: number; json: () => Promise<unknown> };

const server = vi.hoisted(() => ({
  searches: [] as Array<{ query: string; limit: number }>,
  // What the file search answers in the current test; null leaves it unanswered.
  answer: null as null | ((query: string) => SearchAnswer),
}));

vi.mock('@/shared/api', () => ({
  api: {
    getFiles: async () => ({
      ok: false,
      status: 413,
      json: async () => ({ error: 'Project file tree exceeds the 10,000 entry limit.' }),
    }),
    searchFiles: (_projectId: string, query: string, limit: number) => {
      server.searches.push({ query, limit });
      const answer = server.answer;
      return answer ? Promise.resolve(answer(query)) : new Promise(() => undefined);
    },
  },
}));

const openFile = vi.fn<(path: string) => void>();

vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ toggleDarkMode: () => undefined }) }));
vi.mock('@/modules/command-palette/context/PaletteOpsContext', () => ({
  usePaletteOps: () => ({ openFile: (path: string) => openFile(path) }),
}));
vi.mock('@/modules/command-palette/hooks/useSessionsSource', () => ({ useSessionsSource: () => [] }));
vi.mock('@/modules/command-palette/hooks/useSessionMessageSearch', () => ({ useSessionMessageSearch: () => [] }));
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

const project: Project = { projectId: 'project-1', displayName: 'monorepo', fullPath: ROOT, path: ROOT, sessions: [] };

const SEARCHING_NOTE = 'Searching files…';
const INCOMPLETE_NOTE = /Only part of this large project was searched/;
const TOO_LARGE_NOTE = /more than 10,000 entries/;

const wait = async (ms: number) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

// Opens the palette and lets the refused listing land.
const openPalette = async () => {
  render(
    <CommandPalette
      selectedProject={project}
      onStartNewChat={() => undefined}
      onOpenSettings={() => undefined}
      onOpenSession={() => undefined}
    />,
  );
  act(() => {
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
  });
  await wait(0);
};

const type = (query: string) => {
  act(() => {
    fireEvent.change(screen.getByRole('combobox'), { target: { value: query } });
  });
};

// Past the search's debounce, with its answer in.
const waitForTheSearch = () => wait(350);

// Each option reads as the file name followed by its path; none when nothing matches.
const fileOptionTexts = () => {
  const group = screen.queryByRole('group', { name: 'Files' });
  return group ? within(group).queryAllByRole('option').map((option) => option.textContent ?? '') : [];
};

const hasText = (text: string | RegExp) => screen.queryByText(text) !== null;

beforeEach(() => {
  server.searches = [];
  server.answer = null;
  openFile.mockReset();
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

test('typing searches the server once the typing rests; its matches are ranked and Enter opens the best', async () => {
  // Sent in an order of the server's own; the palette ranks them as it ranks a listing.
  server.answer = () => ({
    ok: true,
    status: 200,
    json: async () => ({
      files: [
        fileAt('packages/web/src/components/Button.tsx'),
        fileAt('Button.md', true),
      ],
      totalMatches: 2,
      incomplete: false,
    }),
  });
  await openPalette();
  // Nothing typed: no search, and no note.
  assert.equal(server.searches.length, 0);
  assert.equal(hasText(SEARCHING_NOTE) || hasText(TOO_LARGE_NOTE), false);

  type('b');
  type('bu');
  type('button');
  assert.equal(hasText(SEARCHING_NOTE), true);
  assert.equal(server.searches.length, 0, 'still typing');

  await waitForTheSearch();

  assert.deepEqual(server.searches, [{ query: 'button', limit: 100 }]);
  // The root file scores best; gitignored, it is found all the same.
  assert.deepEqual(fileOptionTexts(), [
    'Button.mdButton.md',
    'Button.tsxpackages/web/src/components/Button.tsx',
  ]);
  assert.equal(hasText(SEARCHING_NOTE) || hasText(INCOMPLETE_NOTE) || hasText(TOO_LARGE_NOTE), false);

  act(() => {
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  });
  assert.deepEqual(openFile.mock.calls, [[`${ROOT}/Button.md`]]);
});

test('a search the server could not finish says some files may be missing', async () => {
  server.answer = () => ({
    ok: true,
    status: 200,
    json: async () => ({ files: [fileAt('apps/api/README.md')], totalMatches: 1, incomplete: true }),
  });
  await openPalette();

  type('readme');
  await waitForTheSearch();

  assert.deepEqual(fileOptionTexts(), ['README.mdapps/api/README.md']);
  assert.equal(hasText(INCOMPLETE_NOTE), true);
  assert.equal(hasText(SEARCHING_NOTE), false);
});

test('the matches of the last search stay, narrowed to what is typed, until the next answer lands', async () => {
  // Five badges tie with the button for "b" and come first, in listing order.
  server.answer = () => ({
    ok: true,
    status: 200,
    json: async () => ({
      files: [...Array.from({ length: 5 }, (_, index) => fileAt(`src/Badge${index + 1}.tsx`)), fileAt('src/Button.tsx')],
      totalMatches: 6,
      incomplete: false,
    }),
  });
  await openPalette();
  type('b');
  await waitForTheSearch();
  // The root page shows the best five.
  assert.equal(fileOptionTexts().length, 5);
  assert.equal(fileOptionTexts().includes('Button.tsxsrc/Button.tsx'), false);

  server.answer = null;
  type('butt');

  // Ranked again for what is typed now, the button, sixth before, is the one match.
  assert.deepEqual(fileOptionTexts(), ['Button.tsxsrc/Button.tsx']);
  assert.equal(hasText(SEARCHING_NOTE), true);
});

test('a failed search says the project is too large to list', async () => {
  server.answer = () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
  await openPalette();

  type('readme');
  await waitForTheSearch();

  assert.deepEqual(fileOptionTexts(), []);
  assert.equal(hasText(TOO_LARGE_NOTE), true);
  assert.equal(hasText(SEARCHING_NOTE), false);
});

test('a match from the server outranks the other groups as a listed file would, so Enter opens it', async () => {
  // Scored by its absolute path, settings.json would rank below the Open settings action.
  server.answer = () => ({
    ok: true,
    status: 200,
    json: async () => ({ files: [fileAt('settings.json')], totalMatches: 1, incomplete: false }),
  });
  await openPalette();

  type('settings');
  await waitForTheSearch();
  act(() => {
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  });

  assert.deepEqual(openFile.mock.calls, [[`${ROOT}/settings.json`]]);
});
