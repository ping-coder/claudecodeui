import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { Project } from '@/shared/types';

/**
 * Regression guard for the detailed view at narrow widths: twelve proportional columns with
 * 88px of gaps let MODIFIED run into PERMISSIONS and wrapped "2 days ago" over three lines once
 * the tree got narrower than about 500px (beside an editor, in a split pane, on a phone). The
 * metadata columns now drop out by the tree's own width, the rows keep the header's grid, and
 * the toolbar wraps instead of clipping the view switch.
 */

const ROOT = '/home/u/demo';
const tree = [
  { type: 'directory', name: 'src', path: `${ROOT}/src`, modified: '2026-10-26T00:00:00Z', permissionsRwx: 'rwxrwxr-x', children: [] },
  { type: 'file', name: 'package.json', path: `${ROOT}/package.json`, size: 8192, modified: '2026-10-26T00:00:00Z', permissionsRwx: 'rw-rw-r--' },
];

const getFiles = vi.fn();
vi.mock('@/shared/api', () => ({
  api: { getFiles: (...args: unknown[]) => getFiles(...args) },
}));

const { default: FileTree } = await import('@/modules/file-tree/FileTree');

const project: Project = { projectId: 'p1', displayName: 'demo', fullPath: ROOT, path: ROOT };

// The width every element reports; only the tree root is measured.
let treeWidth = 1152;
const observers = new Set<{ callback: ResizeObserverCallback }>();

beforeEach(() => {
  window.localStorage.clear();
  getFiles.mockReset();
  getFiles.mockResolvedValue({ ok: true, json: async () => tree });
  observers.clear();
  globalThis.ResizeObserver = class {
    callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    observe() {
      observers.add(this);
    }

    unobserve() {}

    disconnect() {
      observers.delete(this);
    }
  } as unknown as typeof ResizeObserver;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => (
    { x: 0, y: 0, left: 0, top: 0, right: treeWidth, bottom: 600, width: treeWidth, height: 600, toJSON: () => ({}) } as DOMRect
  ));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const renderTree = async (width: number) => {
  treeWidth = width;
  const view = render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.equal(screen.queryByText('package.json') !== null, true));
  return view;
};

/** The column labels, in order. */
const headerLabels = () => Array.from(screen.getByText('Name').parentElement?.children ?? []).map((cell) => cell.textContent);

/** How many grid cells the row of `name` has (its upload button is not a cell). */
const rowCellCount = (name: string) => {
  const row = screen.getByText(name).closest('.grid');
  return Array.from(row?.children ?? []).filter((cell) => cell.tagName === 'DIV').length;
};

test('the detailed columns that fit stay, the rest drop out, and every row keeps the header grid', async () => {
  const cases: Array<[number, string[]]> = [
    [1152, ['Name', 'Size', 'Modified', 'Permissions']],
    [420, ['Name', 'Size', 'Modified']],
    [300, ['Name', 'Size']],
    [200, ['Name']],
  ];
  for (const [width, labels] of cases) {
    const view = await renderTree(width);
    assert.deepEqual(headerLabels(), labels, `${width}px`);
    assert.equal(rowCellCount('package.json'), labels.length, `${width}px file row`);
    assert.equal(rowCellCount('src'), labels.length, `${width}px folder row`);
    view.unmount();
  }
});

test('narrowing the tree, say by opening the editor beside it, drops the columns', async () => {
  await renderTree(1152);
  assert.equal(headerLabels().length, 4);

  treeWidth = 200;
  act(() => {
    observers.forEach((observer) => observer.callback([], observer as unknown as ResizeObserver));
  });
  assert.deepEqual(headerLabels(), ['Name']);
});

test('the labels scroll with the rows, so a vertical scrollbar cannot shift one against the other', async () => {
  await renderTree(1152);
  const labelScroller = screen.getByText('Name').closest('.overflow-auto');
  const rowScroller = screen.getByText('package.json').closest('.overflow-auto');
  assert.equal(labelScroller !== null && labelScroller === rowScroller, true);
  const header = screen.getByText('Name').parentElement?.parentElement;
  assert.equal(header?.className.includes('sticky') ?? false, true);
});

test('a rename in the detailed view gets the whole row', async () => {
  await renderTree(1152);
  fireEvent.contextMenu(screen.getByText('package.json'));
  fireEvent.click(await screen.findByText('Rename'));
  const input = await screen.findByDisplayValue('package.json');
  const row = input.parentElement;
  assert.equal(row?.style.gridTemplateColumns, 'auto minmax(0, 1fr)');
});

test('the project root\'s row sits above the labels, outside the scroller and its grid, in every view', async () => {
  await renderTree(1152);
  const rootRow = () => screen.getByText('demo').closest('[data-file-tree-root]');
  assert.equal(rootRow()?.closest('.overflow-auto') === null, true);
  assert.deepEqual(headerLabels(), ['Name', 'Size', 'Modified', 'Permissions']);
  assert.equal(rowCellCount('package.json'), 4);

  for (const view of ['Simple view', 'Compact view', 'Detailed view']) {
    fireEvent.click(screen.getByTitle(view));
    assert.equal(rootRow() !== null, true, view);
  }
});

test('the toolbar wraps rather than clipping the view switch', async () => {
  await renderTree(200);
  const titleRow = screen.getByRole('heading', { name: 'Files' }).parentElement;
  assert.equal(titleRow?.className.includes('flex-wrap') ?? false, true);
  assert.equal(screen.queryByTitle('Simple view') !== null, true);
});
