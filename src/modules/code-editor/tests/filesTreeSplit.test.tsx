import assert from 'node:assert/strict';

import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { WorkspacePaneProvider } from '@/shared/context/WorkspacePaneContext';
import type { CodeEditorFile } from '@/shared/types';

/**
 * Regression guard for the Files view squeezing the tree to 200px: the docked editor's box took
 * its content's width (the longest line, the file path), so any file wider than the pane pinned
 * the tree to its minimum. The editor now takes what the tree's saved share leaves, the divider
 * drags, steps and resets that share without saving what a narrow pane clamps, and the Chat side
 * panel keeps its own width.
 */

const LONG_LINE = 'x'.repeat(5000);
const readFile = vi.fn(async () => ({ ok: true, json: async () => ({ content: LONG_LINE }) }));

vi.mock('@/shared/api', () => ({
  api: { readFile, saveFile: vi.fn() },
  readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value }: { value: string }) => <textarea data-testid="editor" value={value} readOnly />,
}));

vi.mock('@/modules/code-editor/utils/editorToolbarPanel', () => ({
  createEditorToolbarPanelExtension: () => [],
}));

const { default: EditorSidebar } = await import('@/modules/code-editor/EditorSidebar');

const file: CodeEditorFile = { name: 'TASKS.md', path: '/repo/TASKS.md', projectId: 'p1' };

// A 1440px window less the 288px sidebar, unless a test narrows it.
let rowWidth = 1152;

let frames: Array<FrameRequestCallback | null> = [];
const flushFrames = () => {
  const pending = frames;
  frames = [];
  pending.forEach((callback) => callback?.(0));
};

beforeEach(() => {
  window.localStorage.clear();
  rowWidth = 1152;
  frames = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames[id - 1] = null;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function measure(this: HTMLElement) {
    const width = this.dataset.testid === 'row' ? rowWidth : 0;
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 800, width, height: 800, toJSON: () => ({}) } as DOMRect;
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => rowWidth });
  globalThis.ResizeObserver = class {
    observe() {}

    unobserve() {}

    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.style.userSelect = '';
});

const toggleExpand = vi.fn();

/** Laid out the way WorkspaceMain lays it out: the tree column, then the sidebar, in one flex row. */
const sidebar = (fillSpace: boolean, isSplitPane = false) => (
  <WorkspacePaneProvider value={{ side: 'left', isFocusedPane: true, isSplitPane, openFileInEditor: null, openDirectory: null }}>
    <div data-testid="row" className="flex">
      <div className="min-w-[200px] flex-1">tree</div>
      <EditorSidebar
        editingFile={file}
        isMobile={false}
        editorExpanded={false}
        editorWidth={600}
        resizeHandleRef={{ current: null }}
        onResizeStart={() => undefined}
        onCloseEditor={() => undefined}
        onToggleEditorExpand={toggleExpand}
        projectPath="/repo"
        fillSpace={fillSpace}
      />
    </div>
  </WorkspacePaneProvider>
);

const renderFiles = async (fillSpace = true, isSplitPane = false) => {
  const view = render(sidebar(fillSpace, isSplitPane));
  await waitFor(() => assert.equal(screen.queryByTestId<HTMLTextAreaElement>('editor')?.value.length, LONG_LINE.length));
  return view;
};

const findDivider = () => screen.queryByRole('separator', { name: 'Resize file tree' });
/** The sidebar's own box: the divider's parent. */
const readShare = () => findDivider()?.parentElement?.style.getPropertyValue('--files-tree-ratio');
const stored = () => window.localStorage.getItem('files-tree-ratio');
const assertClose = (actual: number, expected: number, label: string) => {
  assert.equal(Math.abs(actual - expected) < 1e-9, true, `${label}: expected ${expected}, got ${actual}`);
};

/** jsdom has no PointerEvent: build the event and give it the fields React reads. */
const firePointer = (element: Element, type: 'pointerDown' | 'pointerMove' | 'pointerUp', clientX: number) => {
  const event = createEvent[type](element);
  Object.defineProperties(event, { clientX: { value: clientX }, button: { value: 0 }, pointerId: { value: 1 } });
  fireEvent(element, event);
};

test('the Files view sizes the editor box by the tree share, not by what the editor holds', async () => {
  await renderFiles();

  // The row's second child: the sidebar's box, found without the divider so HEAD fails on the layout itself.
  const editorWrapper = screen.getByTestId('editor').closest('.border-s');
  const box = editorWrapper?.parentElement;
  // A definite basis taken from the share: the 5000-character line no longer sizes the box.
  assert.equal(box?.style.flex.includes('var(--files-tree-ratio, 0.4)') ?? false, true, `flex: "${box?.style.flex}"`);
  assert.equal(box?.style.getPropertyValue('--files-tree-ratio'), '0.4');
  assert.equal(editorWrapper?.getAttribute('style') ?? '', '', 'the editor wrapper has no width of its own');
  assert.equal(findDivider() !== null, true, 'the Files view has a resizable divider');
});

test('a saved share comes back after a reload; junk falls back to 40%', async () => {
  window.localStorage.setItem('files-tree-ratio', '0.45');
  const first = await renderFiles();
  assert.equal(findDivider()?.getAttribute('aria-valuenow'), '45');
  assert.equal(readShare(), '0.45');
  first.unmount();

  for (const junk of ['abc', '1.5', '0', '', '-0.2', '0.5px', 'NaN']) {
    window.localStorage.setItem('files-tree-ratio', junk);
    const view = await renderFiles();
    assert.equal(findDivider()?.getAttribute('aria-valuenow'), '40', `stored ${JSON.stringify(junk)}`);
    view.unmount();
  }
});

test('a drag rewrites only the CSS variable, once per frame, keeps both minimums, and saves once on release', async () => {
  await renderFiles();
  const setItem = vi.spyOn(Storage.prototype, 'setItem');
  const divider = findDivider();
  assert.equal(divider !== null, true);
  if (!divider) return;

  firePointer(divider, 'pointerDown', 460);
  assert.equal(document.body.style.userSelect, 'none');

  firePointer(divider, 'pointerMove', 460 + 0.1 * 1152);
  assert.equal(readShare(), '0.4', 'nothing is written before the frame');
  flushFrames();
  assertClose(Number(readShare()), 0.5, 'the divider follows the pointer');

  firePointer(divider, 'pointerMove', 2000);
  firePointer(divider, 'pointerMove', 2001);
  assert.equal(frames.filter(Boolean).length, 1, 'moves within a frame share one write');
  flushFrames();
  assertClose(Number(readShare()), 1 - 284 / 1152, 'the editor keeps 280px plus the divider');

  firePointer(divider, 'pointerMove', -2000);
  flushFrames();
  assertClose(Number(readShare()), 200 / 1152, 'the tree keeps 200px');
  assert.equal(setItem.mock.calls.length, 0, 'nothing is saved while dragging');

  firePointer(divider, 'pointerUp', -2000);
  assert.equal(setItem.mock.calls.length, 1, 'saved once, on release');
  assertClose(Number(stored()), 200 / 1152, 'the saved share');
  assert.equal(document.body.style.userSelect, '');
});

test('arrow keys step the share by 4%, Home and a double-click save 40% back', async () => {
  await renderFiles();
  const divider = findDivider();
  assert.equal(divider !== null, true);
  if (!divider) return;

  fireEvent.keyDown(divider, { key: 'ArrowRight' });
  assert.equal(findDivider()?.getAttribute('aria-valuenow'), '44');
  fireEvent.keyDown(divider, { key: 'ArrowLeft' });
  fireEvent.keyDown(divider, { key: 'ArrowLeft' });
  assert.equal(findDivider()?.getAttribute('aria-valuenow'), '36');
  assertClose(Number(stored()), 0.36, 'each key press is saved');

  fireEvent.keyDown(divider, { key: 'Home' });
  assert.equal(stored(), '0.4');

  fireEvent.keyDown(divider, { key: 'ArrowRight' });
  fireEvent.doubleClick(divider);
  assert.equal(stored(), '0.4');
  assert.equal(readShare(), '0.4');
});

test('right to left the tree is on the right: a drag leftwards and ArrowLeft widen it', async () => {
  // What <html dir="rtl"> computes; jsdom neither maps dir to direction nor inherits it.
  const rtlStyle = document.createElement('style');
  rtlStyle.textContent = '[dir="rtl"], [dir="rtl"] * { direction: rtl; }';
  document.head.append(rtlStyle);
  document.documentElement.setAttribute('dir', 'rtl');
  try {
    await renderFiles();
    const divider = findDivider();
    assert.equal(divider !== null, true);
    if (!divider) return;

    firePointer(divider, 'pointerDown', 700);
    firePointer(divider, 'pointerMove', 700 - 0.1 * 1152);
    flushFrames();
    assertClose(Number(readShare()), 0.5, 'the tree grows as the divider moves left');
    firePointer(divider, 'pointerUp', 700 - 0.1 * 1152);
    assertClose(Number(stored()), 0.5, 'the saved share');

    fireEvent.keyDown(divider, { key: 'ArrowLeft' });
    assert.equal(findDivider()?.getAttribute('aria-valuenow'), '54');
    fireEvent.keyDown(divider, { key: 'ArrowRight' });
    fireEvent.keyDown(divider, { key: 'ArrowRight' });
    assert.equal(findDivider()?.getAttribute('aria-valuenow'), '46');
  } finally {
    document.documentElement.removeAttribute('dir');
    rtlStyle.remove();
  }
});

test('in a narrow pane the divider reports where it is drawn and saves nothing it did not move', async () => {
  // A 573px split pane: the tree keeps 200px, so a saved 30% is drawn at 35%.
  rowWidth = 573;
  window.localStorage.setItem('files-tree-ratio', '0.3');
  const view = await renderFiles(true, true);
  const divider = findDivider();
  assert.equal(divider !== null, true);
  if (!divider) return;
  assert.equal(divider.getAttribute('aria-valuenow'), '35');
  assert.equal(divider.getAttribute('aria-valuemin'), '35');
  assert.equal(divider.getAttribute('aria-valuemax'), '50');

  // A press without a move, half of a double-click.
  firePointer(divider, 'pointerDown', 200);
  firePointer(divider, 'pointerUp', 200);
  assert.equal(stored(), '0.3', 'the saved share is not replaced by the clamped one');
  assert.equal(readShare(), '0.3');

  // A frame wrote a position the pointer then left again: the variable goes back to the saved share.
  firePointer(divider, 'pointerDown', 200);
  firePointer(divider, 'pointerMove', 260);
  flushFrames();
  firePointer(divider, 'pointerMove', 200);
  firePointer(divider, 'pointerUp', 200);
  assert.equal(stored(), '0.3');
  assert.equal(readShare(), '0.3');
  view.unmount();

  // A reset in a pane where 40% is drawn clamped still saves 40%, for the next wider pane.
  rowWidth = 490;
  window.localStorage.setItem('files-tree-ratio', '0.42');
  await renderFiles(true, true);
  const narrowDivider = findDivider();
  assert.equal(narrowDivider !== null, true);
  if (!narrowDivider) return;
  fireEvent.doubleClick(narrowDivider);
  assert.equal(stored(), '0.4');
  assert.equal(findDivider()?.getAttribute('aria-valuenow'), '41');
});

test('a split pane without room for 200px plus the 284px docked box expands the editor instead of docking it', async () => {
  rowWidth = 483;
  toggleExpand.mockClear();
  const view = await renderFiles(true, true);
  assert.equal(toggleExpand.mock.calls.length, 1);
  view.unmount();

  rowWidth = 484;
  toggleExpand.mockClear();
  await renderFiles(true, true);
  assert.equal(toggleExpand.mock.calls.length, 0);
  assert.equal(findDivider() !== null, true);
});

test('a Files drag leaves the Chat side panel at its own width', async () => {
  readFile.mockClear();
  const view = await renderFiles();
  const divider = findDivider();
  assert.equal(divider !== null, true);
  if (!divider) return;
  firePointer(divider, 'pointerDown', 460);
  firePointer(divider, 'pointerMove', 700);
  act(() => flushFrames());
  firePointer(divider, 'pointerUp', 700);

  // Switched to Chat: the editor docks at the side-panel width, with the old handle.
  view.rerender(sidebar(false));
  assert.equal(findDivider() === null, true, 'no tree divider outside the Files view');
  const editorWrapper = screen.getByTestId('editor').closest('.border-s') as HTMLElement | null;
  assert.equal(editorWrapper?.style.width, '600px');
  assert.equal(screen.queryByTitle('Drag to resize') !== null, true);
  assert.equal(readFile.mock.calls.length, 1, 'switching views keeps the editor mounted');
});

test('an unmount restores selection only when it cuts short a drag of this divider', async () => {
  // Another divider's drag (the pane splitter) narrows the pane until the editor expands, which unmounts
  // this one: the page stays unselectable for that drag.
  const view = await renderFiles();
  document.body.style.userSelect = 'none';
  view.rerender(sidebar(false));
  assert.equal(findDivider() === null, true);
  assert.equal(document.body.style.userSelect, 'none');

  // This divider's own drag, cut short by the switch to Chat, gives selection back.
  document.body.style.userSelect = '';
  view.rerender(sidebar(true));
  const divider = findDivider();
  assert.equal(divider !== null, true);
  if (!divider) return;
  firePointer(divider, 'pointerDown', 460);
  assert.equal(document.body.style.userSelect, 'none');
  view.rerender(sidebar(false));
  assert.equal(document.body.style.userSelect, '');
});
