import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { Project } from '@/shared/types';

/**
 * Regression guard for CLAUDE.md missing from the Files tab: a gitignored entry
 * is listed greyed out instead of left out. A gitignored folder was never
 * walked by the server, so the tree must not open it, upload into it or offer
 * to fill it.
 */

const ROOT = '/home/u/claudecodeui';

const tree = [
  { type: 'directory', name: 'dist-server', path: `${ROOT}/dist-server`, isIgnored: true },
  {
    type: 'directory',
    name: 'src',
    path: `${ROOT}/src`,
    children: [
      { type: 'directory', name: 'generated', path: `${ROOT}/src/generated`, isIgnored: true },
      { type: 'file', name: 'index.ts', path: `${ROOT}/src/index.ts` },
    ],
  },
  { type: 'file', name: 'AGENTS.md', path: `${ROOT}/AGENTS.md` },
  { type: 'file', name: 'CLAUDE.md', path: `${ROOT}/CLAUDE.md`, isIgnored: true },
];

const getFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { getFiles: (...args: unknown[]) => getFiles(...args) },
}));

const { default: FileTree } = await import('@/modules/file-tree/FileTree');

const project: Project = { projectId: 'p1', displayName: 'claudecodeui', fullPath: ROOT, path: ROOT };

const treeResponse = (nodes: unknown[]) => ({ ok: true, json: async () => nodes });

// The name's parent also holds the row's chevron and folder icons, in every view mode.
const hasIcon = (name: string, iconClass: string) =>
  screen.getByText(name).parentElement?.querySelector(`.${iconClass}`) != null;

const renderTree = async (revealPath?: string) => {
  const view = render(
    <FileTree selectedProject={project} revealDirectory={revealPath ? { path: revealPath } : null} />,
  );
  await waitFor(() => assert.equal(screen.queryByText('CLAUDE.md') === null, false));
  return view;
};

beforeEach(() => {
  getFiles.mockReset();
  getFiles.mockResolvedValue(treeResponse(tree));
});

test('gitignored entries are asked for and greyed out, icon and name only', async () => {
  await renderTree();

  assert.equal((getFiles.mock.calls[0]?.[1] as { markIgnored?: boolean } | undefined)?.markIgnored, true);
  assert.equal(screen.getByText('CLAUDE.md').className.includes('opacity-60'), true);
  assert.equal(screen.getByText('AGENTS.md').className.includes('opacity-60'), false);
  assert.equal(screen.getByText('CLAUDE.md').previousElementSibling?.className.includes('opacity-60'), true);
  assert.equal(screen.getByText('AGENTS.md').previousElementSibling?.className.includes('opacity-60'), false);

  const hintedRows = screen.getAllByTitle('Matches a .gitignore rule').map((row) => row.textContent ?? '');
  assert.equal(hintedRows.some((text) => text.includes('CLAUDE.md')), true);
  assert.equal(hintedRows.some((text) => text.includes('AGENTS.md')), false);
});

test('a gitignored folder has no chevron and stays closed when clicked', async () => {
  await renderTree();

  assert.equal(hasIcon('dist-server', 'lucide-chevron-right'), false);
  assert.equal(hasIcon('src', 'lucide-chevron-right'), true);

  fireEvent.click(screen.getByText('dist-server'));
  assert.equal(hasIcon('dist-server', 'lucide-folder-open'), false);
  // A normal folder still opens, so the clicks do reach the tree.
  fireEvent.click(screen.getByText('src'));
  assert.equal(hasIcon('src', 'lucide-folder-open'), true);
});

test('a chat reveal does not open a gitignored folder either', async () => {
  const view = await renderTree('dist-server/');
  assert.equal(hasIcon('dist-server', 'lucide-folder-open'), false);

  // Revealing through a normal folder opens it and stops at the ignored one below.
  view.rerender(<FileTree selectedProject={project} revealDirectory={{ path: 'src/generated/' }} />);
  await waitFor(() => assert.equal(hasIcon('src', 'lucide-folder-open'), true));
  assert.equal(hasIcon('generated', 'lucide-folder-open'), false);
  assert.equal(hasIcon('dist-server', 'lucide-folder-open'), false);
});

test('a click on a gitignored folder does not open it later, once it is no longer ignored', async () => {
  await renderTree();
  fireEvent.click(screen.getByText('dist-server'));

  // The rule is dropped from .gitignore, so the next listing walks the folder.
  getFiles.mockResolvedValue(treeResponse([
    {
      type: 'directory',
      name: 'dist-server',
      path: `${ROOT}/dist-server`,
      children: [{ type: 'file', name: 'server.js', path: `${ROOT}/dist-server/server.js` }],
    },
  ]));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

  await waitFor(() => assert.equal(hasIcon('dist-server', 'lucide-chevron-right'), true));
  assert.equal(screen.queryByText('server.js') === null, true);
});

// The same project once both rules are dropped from .gitignore: the folders are walked.
const treeWithoutRules = [
  {
    type: 'directory',
    name: 'dist-server',
    path: `${ROOT}/dist-server`,
    children: [{ type: 'file', name: 'server.js', path: `${ROOT}/dist-server/server.js` }],
  },
  {
    type: 'directory',
    name: 'src',
    path: `${ROOT}/src`,
    children: [
      {
        type: 'directory',
        name: 'generated',
        path: `${ROOT}/src/generated`,
        children: [{ type: 'file', name: 'gen.ts', path: `${ROOT}/src/generated/gen.ts` }],
      },
      { type: 'file', name: 'index.ts', path: `${ROOT}/src/index.ts` },
    ],
  },
  { type: 'file', name: 'AGENTS.md', path: `${ROOT}/AGENTS.md` },
  { type: 'file', name: 'CLAUDE.md', path: `${ROOT}/CLAUDE.md`, isIgnored: true },
];

const refreshWithoutRules = async () => {
  getFiles.mockResolvedValue(treeResponse(treeWithoutRules));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => assert.equal(hasIcon('dist-server', 'lucide-chevron-right'), true));
  // Lets whatever runs on the new listing, such as a reveal still pending, finish.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
};

test('a chat reveal of a top-level gitignored folder does not open it later, once it is no longer ignored', async () => {
  await renderTree('dist-server/');

  await refreshWithoutRules();
  assert.equal(screen.queryByText('server.js') === null, true);
});

test('a chat reveal through a normal folder does not open the gitignored one below it later either', async () => {
  await renderTree('src/generated/');
  await waitFor(() => assert.equal(hasIcon('src', 'lucide-folder-open'), true));

  await refreshWithoutRules();
  // The normal folder the reveal opened stays open.
  assert.equal(screen.queryByText('index.ts') === null, false);
  assert.equal(screen.queryByText('gen.ts') === null, true);
});

test('a gitignored folder takes no uploads: no hover button, and a drop over it goes to the root', async () => {
  await renderTree();

  assert.equal(screen.queryByLabelText('Upload files to "dist-server"') === null, true);
  assert.equal(screen.queryByLabelText('Upload files to "src"') === null, false);

  fireEvent.dragEnter(screen.getByText('src'));
  fireEvent.dragOver(screen.getByText('src'));
  assert.equal(screen.queryByText('Drop files to upload to "src"') === null, false);

  fireEvent.dragOver(screen.getByText('dist-server'));
  assert.equal(screen.queryByText('Drop files to upload to "dist-server"') === null, true);
  assert.equal(screen.queryByText('Drop files to upload') === null, false);
});

test('a gitignored folder only offers rename, delete and copy path', async () => {
  await renderTree();
  const menuLabels = () => screen.getAllByRole('menuitem').map((item) => item.textContent ?? '');

  fireEvent.contextMenu(screen.getByText('dist-server'));
  assert.deepEqual(menuLabels(), ['Rename', 'Delete', 'Copy Path']);
  // No separator above the first item.
  assert.equal(screen.getByRole('menu').firstElementChild?.getAttribute('role'), 'menuitem');

  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.contextMenu(screen.getByText('src'));
  assert.deepEqual(menuLabels(), ['New File', 'New Folder', 'Upload Files', 'Rename', 'Delete', 'Copy Path', 'Download']);
});
