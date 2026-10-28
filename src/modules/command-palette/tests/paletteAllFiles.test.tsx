import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { Project } from '@/shared/types';

/**
 * Regression guard: the palette kept only the first 500 files of the tree, so a
 * deeper file could not be found, the files page claimed 499 files, and a
 * project the server refused (413) showed no files and no reason. The real
 * files source runs here; only the API is faked. Searching a refused project on
 * the server is covered in paletteLargeProjectSearch.test.tsx.
 */

const ROOT = '/home/u/project';

type TreeNode = { type: 'file' | 'directory'; name: string; path: string; isIgnored?: boolean; children?: TreeNode[] };
const fileNode = (dir: string, name: string, isIgnored = false): TreeNode => ({
  type: 'file',
  name,
  path: `${ROOT}/${dir ? `${dir}/` : ''}${name}`,
  isIgnored,
});

// 1,200 files in src/a, a needle seven levels down that the source lists last, and two root files.
const NEEDLE_DIR = 'zz/deep/a/b/c/d';
const tree: TreeNode[] = [
  {
    type: 'directory',
    name: 'src',
    path: `${ROOT}/src`,
    children: [{
      type: 'directory',
      name: 'a',
      path: `${ROOT}/src/a`,
      children: Array.from({ length: 1200 }, (_, index) => fileNode('src/a', `file-${index}.ts`)),
    }],
  },
  NEEDLE_DIR.split('/').reduceRight<TreeNode>((child, name, index, parts) => ({
    type: 'directory',
    name,
    path: `${ROOT}/${parts.slice(0, index + 1).join('/')}`,
    children: [child],
  }), fileNode(NEEDLE_DIR, 'NeedleTarget.tsx')),
  fileNode('', 'CLAUDE.md', true),
  fileNode('', 'README.md'),
];

let response: { ok: boolean; status: number; json: () => Promise<unknown> };
const openFile = vi.fn<(path: string) => void>();

// The file search, which the palette falls back on for a refused project, fails here.
vi.mock('@/shared/api', () => ({
  api: {
    getFiles: async () => response,
    searchFiles: async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }),
  },
}));
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

const project: Project = { projectId: 'project-1', displayName: 'project', fullPath: ROOT, path: ROOT, sessions: [] };

// Opens the palette and lets the files request answer.
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
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const search = (query: string) => {
  act(() => {
    fireEvent.change(screen.getByRole('combobox'), { target: { value: query } });
  });
};

// Each option reads as the file name followed by its path; none when nothing matches.
const fileOptionTexts = () => {
  const group = screen.queryByRole('group', { name: 'Files' });
  return group ? within(group).queryAllByRole('option').map((option) => option.textContent ?? '') : [];
};

const hasText = (text: string | RegExp) => screen.queryByText(text) !== null;

beforeEach(() => {
  response = { ok: true, status: 200, json: async () => tree };
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

test('a file past the first 500 is found from the root page and opened with Enter', async () => {
  await openPalette();

  search('NeedleTarget');
  assert.deepEqual(fileOptionTexts(), [`NeedleTarget.tsx${NEEDLE_DIR}/NeedleTarget.tsx`]);

  act(() => {
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  });
  assert.deepEqual(openFile.mock.calls, [[`${ROOT}/${NEEDLE_DIR}/NeedleTarget.tsx`]]);
});

test('the files page counts every file, renders 100 rows, and says it leaves the rest out', async () => {
  await openPalette();
  // CLAUDE.md is gitignored, so it is not counted.
  assert.equal(fileOptionTexts().includes('Browse all files (1202)'), true);
  act(() => {
    fireEvent.click(within(screen.getByRole('group', { name: 'Files' })).getByRole('option', { name: /Browse all files/ }));
  });
  assert.equal(fileOptionTexts().length, 100);
  assert.equal(hasText('Showing 100 of 1202 files. Type to find the rest.'), true);

  // Hundreds of files match; the exact name ranks first.
  search('file-11');
  assert.equal(fileOptionTexts().length, 100);
  assert.equal(fileOptionTexts()[0], 'file-11.tssrc/a/file-11.ts');
  assert.equal(hasText('Showing the 100 best matches. Keep typing to narrow them down.'), true);

  // One match: nothing is left out, so there is no note.
  search('NeedleTarget');
  assert.deepEqual(fileOptionTexts(), [`NeedleTarget.tsx${NEEDLE_DIR}/NeedleTarget.tsx`]);
  assert.equal(hasText(/best matches|Showing \d+ of/), false);
});

test('a project the server refuses as too large says why when searched and its file search fails', async () => {
  response = { ok: false, status: 413, json: async () => ({ error: 'Project file tree exceeds the 10,000 entry limit.' }) };
  await openPalette();
  // Not before anything is typed: the palette is often opened for its actions.
  assert.equal(hasText(/more than 10,000 entries/), false);

  search('README');
  // Past the file search's debounce, and its failed answer.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  assert.deepEqual(fileOptionTexts(), []);
  assert.equal(hasText(/more than 10,000 entries/), true);
});
