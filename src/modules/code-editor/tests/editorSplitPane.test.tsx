import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useCallback, useRef, useState } from 'react';
import { test, vi } from 'vitest';

import { WorkspacePaneProvider } from '@/shared/context/WorkspacePaneContext';
import type { CodeEditorFile } from '@/shared/types';

/**
 * Split panes: a pane too narrow for the docked editor (200px of content plus
 * 280px of editor) popped the editor out as a modal over both panes, and a pane
 * hidden while the split is collapsed measured 0 and popped out the same way.
 * A split pane now expands the editor inside itself, a hidden pane measures
 * nothing, and a single pane still pops out as it always has.
 */

const readFile = vi.fn(async () => ({ ok: true, json: async () => ({ content: 'hello' }) }));
const saveFile = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));

vi.mock('@/shared/api', () => ({
  api: { readFile, saveFile },
  readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

vi.mock('@uiw/react-codemirror', () => {
  function CodeMirrorStub({ value, onChange }: { value: string; onChange?: (value: string) => void }) {
    return (
      <textarea
        data-testid="editor"
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
      />
    );
  }

  return { default: CodeMirrorStub };
});

type ToolbarPanelParams = {
  isSidebar: boolean;
  isExpanded: boolean;
  onToggleExpand: (() => void) | null;
};

// The expand/collapse button lives in a CodeMirror panel, which the stubbed
// editor does not build. Keeping the arguments the panel was built from tells
// how the editor is laid out and hands the test the button's callback.
const toolbarPanels: ToolbarPanelParams[] = [];

vi.mock('@/modules/code-editor/utils/editorToolbarPanel', () => ({
  createEditorToolbarPanelExtension: (params: ToolbarPanelParams) => {
    toolbarPanels.push(params);
    return [];
  },
}));

const { default: EditorSidebar } = await import('@/modules/code-editor/EditorSidebar');

type PaneContextValue = Parameters<typeof WorkspacePaneProvider>[0]['value'];

/** A pane shown beside the other one. */
const SIDE_BY_SIDE: PaneContextValue = {
  side: 'left',
  isFocusedPane: true,
  isSplitPane: true,
  openFileInEditor: null,
  openDirectory: null,
};

/** The pane on show while a split is collapsed to one pane: not side by side. */
const COLLAPSED_SHOWN: PaneContextValue = { ...SIDE_BY_SIDE, isSplitPane: false };

/** The other pane of a collapsed split, hidden with CSS but still mounted. */
const COLLAPSED_HIDDEN: PaneContextValue = { ...SIDE_BY_SIDE, side: 'right', isFocusedPane: false, isSplitPane: false };

const file: CodeEditorFile = { name: 'a.txt', path: '/repo/a.txt', projectId: 'p1' };
const otherFile: CodeEditorFile = { name: 'b.txt', path: '/repo/b.txt', projectId: 'p1' };

// The width the sidebar reads off its parent; a pane hidden with CSS reports 0.
let containerWidth = 1400;

Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get: () => containerWidth,
});

// The test decides when the observer reports, so a report can land in the same
// batch as a window resize, before React renders what the first one asked for.
const connectedObservers = new Set<FakeResizeObserver>();

class FakeResizeObserver {
  callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe() {
    connectedObservers.add(this);
  }

  unobserve() {}

  disconnect() {
    connectedObservers.delete(this);
  }
}

globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

/** The pane changed size: the window resize and the observer both report it. */
const reportResize = () => {
  act(() => {
    window.dispatchEvent(new Event('resize'));
    [...connectedObservers].forEach((observer) => {
      observer.callback([], observer as unknown as ResizeObserver);
    });
  });
};

// Every expand or collapse request, automatic or from the toolbar button.
const toggleRequests = vi.fn();

type PaneEditorProps = {
  /** Omitted: rendered outside any pane, as every screen but the workspace is. */
  pane?: PaneContextValue;
  initiallyExpanded?: boolean;
};

/** Wired the way WorkspaceMain wires it through useEditorSidebar: expanding only toggles, closing clears the file and the expansion. */
function PaneEditor({ pane, initiallyExpanded = false }: PaneEditorProps) {
  // The open file, as useEditorSidebar holds it: null once the editor is closed.
  const [editingFile, setEditingFile] = useState<CodeEditorFile | null>(file);
  // useEditorSidebar's expansion flag, fed back to the sidebar after each toggle.
  const [editorExpanded, setEditorExpanded] = useState(initiallyExpanded);
  const resizeHandleRef = useRef<HTMLDivElement | null>(null);

  const toggleExpand = useCallback(() => {
    toggleRequests();
    setEditorExpanded((previous) => !previous);
  }, []);

  const closeEditor = useCallback(() => {
    setEditingFile(null);
    setEditorExpanded(false);
  }, []);

  const content = (
    <>
      <button type="button" onClick={() => setEditingFile(otherFile)}>open b.txt</button>
      <div>
        <EditorSidebar
          editingFile={editingFile}
          isMobile={false}
          editorExpanded={editorExpanded}
          editorWidth={600}
          resizeHandleRef={resizeHandleRef}
          onResizeStart={() => undefined}
          onCloseEditor={closeEditor}
          onToggleEditorExpand={toggleExpand}
          projectPath="/repo"
        />
      </div>
    </>
  );

  return pane ? <WorkspacePaneProvider value={pane}>{content}</WorkspacePaneProvider> : content;
}

const waitForEditor = async () => {
  await waitFor(() => assert.equal(screen.queryByTestId<HTMLTextAreaElement>('editor')?.value, 'hello'));
};

const renderPaneEditor = async (width: number, props: PaneEditorProps) => {
  containerWidth = width;
  toolbarPanels.length = 0;
  const view = render(<PaneEditor {...props} />);
  await waitForEditor();
  return view;
};

/** The floating layout is the modal one: a full-viewport overlay. */
const isFloating = (container: HTMLElement) => container.querySelector('.fixed.inset-0') !== null;

/** Only the docked, unexpanded layout has a drag handle beside the editor. */
const isDocked = () => screen.queryByTitle('Drag to resize') !== null;

/** Whether the editor was last laid out inside the pane, and expanded there. */
const editorLayout = () => {
  const panel = toolbarPanels.at(-1);
  return { inPane: panel?.isSidebar, expanded: panel?.isExpanded };
};

/** Exactly what clicking the toolbar's expand/collapse button does. */
const clickExpandButton = () => {
  const toggle = toolbarPanels.at(-1)?.onToggleExpand;
  assert.ok(toggle, 'the in-pane toolbar offers the expand/collapse button');
  act(() => toggle());
};

test('a split pane too narrow to dock the editor expands it in place instead of popping out', async () => {
  const { container } = await renderPaneEditor(420, { pane: SIDE_BY_SIDE });

  assert.equal(isFloating(container), false);
  assert.equal(toggleRequests.mock.calls.length, 1);
  assert.deepEqual(editorLayout(), { inPane: true, expanded: true });

  // Later reports from the same narrow pane change nothing.
  reportResize();
  assert.equal(toggleRequests.mock.calls.length, 1);
  assert.equal(isFloating(container), false);
  assert.deepEqual(editorLayout(), { inPane: true, expanded: true });
});

test('reports landing before the expansion renders ask for it only once', async () => {
  const { container } = await renderPaneEditor(1400, { pane: SIDE_BY_SIDE });
  assert.ok(isDocked());
  assert.equal(toggleRequests.mock.calls.length, 0);

  // The pane narrows, say the quick settings panel was pinned. Asking twice
  // would toggle the editor straight back to docked.
  containerWidth = 420;
  reportResize();

  assert.equal(toggleRequests.mock.calls.length, 1);
  assert.deepEqual(editorLayout(), { inPane: true, expanded: true });
  assert.equal(isFloating(container), false);
});

test('collapsing it in the narrow pane sticks until the pane narrows again', async () => {
  await renderPaneEditor(420, { pane: SIDE_BY_SIDE });
  assert.equal(toggleRequests.mock.calls.length, 1);

  clickExpandButton();
  reportResize();

  assert.equal(toggleRequests.mock.calls.length, 2, 'only the click itself, no automatic re-expansion');
  assert.deepEqual(editorLayout(), { inPane: true, expanded: false });
  assert.ok(isDocked());

  // Room again, then too narrow again: the new narrowing expands it once more.
  containerWidth = 1400;
  reportResize();
  assert.equal(toggleRequests.mock.calls.length, 2);
  containerWidth = 420;
  reportResize();
  assert.equal(toggleRequests.mock.calls.length, 3);
  assert.deepEqual(editorLayout(), { inPane: true, expanded: true });
});

test('an editor the user had expanded already is left expanded, and a collapse there sticks', async () => {
  await renderPaneEditor(420, { pane: SIDE_BY_SIDE, initiallyExpanded: true });

  assert.equal(toggleRequests.mock.calls.length, 0);
  assert.deepEqual(editorLayout(), { inPane: true, expanded: true });

  clickExpandButton();
  reportResize();
  assert.equal(toggleRequests.mock.calls.length, 1);
  assert.deepEqual(editorLayout(), { inPane: true, expanded: false });
});

test('the next file opened in the narrow pane expands again after a close', async () => {
  await renderPaneEditor(420, { pane: SIDE_BY_SIDE });
  clickExpandButton();
  assert.equal(toggleRequests.mock.calls.length, 2);

  // A clean buffer closes without asking.
  fireEvent.click(screen.getByTitle('actions.close'));
  assert.equal(screen.queryByTestId('editor') !== null, false);

  fireEvent.click(screen.getByRole('button', { name: 'open b.txt' }));
  await waitForEditor();

  assert.equal(toggleRequests.mock.calls.length, 3);
  assert.deepEqual(editorLayout(), { inPane: true, expanded: true });
});

test('a pane hidden by a collapsed split never pops the editor out', async () => {
  const { container, rerender } = await renderPaneEditor(0, { pane: COLLAPSED_HIDDEN });
  reportResize();

  assert.equal(isFloating(container), false);
  assert.equal(toggleRequests.mock.calls.length, 0);

  // Switched to it, in a window with room for the docked editor.
  containerWidth = 900;
  rerender(<PaneEditor pane={COLLAPSED_SHOWN} />);
  reportResize();
  assert.equal(isFloating(container), false);
  assert.ok(isDocked());
  assert.equal(toggleRequests.mock.calls.length, 0);
});

test('a split pane measuring 0 does not ask for the expansion until it has a width', async () => {
  await renderPaneEditor(0, { pane: SIDE_BY_SIDE });
  reportResize();

  assert.equal(toggleRequests.mock.calls.length, 0);
  assert.ok(isDocked());

  containerWidth = 420;
  reportResize();
  assert.equal(toggleRequests.mock.calls.length, 1);
  assert.deepEqual(editorLayout(), { inPane: true, expanded: true });
});

test('a single pane still pops the editor out when there is no room', async () => {
  // The visible pane of a collapsed split, and a workspace with no panes at all.
  for (const pane of [COLLAPSED_SHOWN, undefined]) {
    const { container, unmount } = await renderPaneEditor(1400, { pane });
    assert.ok(isDocked());

    containerWidth = 300;
    reportResize();

    await waitFor(() => assert.ok(isFloating(container)));
    assert.equal(editorLayout().inPane, false);
    assert.equal(toggleRequests.mock.calls.length, 0);
    unmount();
  }
});
