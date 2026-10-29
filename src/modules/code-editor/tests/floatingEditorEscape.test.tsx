import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { WorkspacePaneProvider } from '@/shared/context/WorkspacePaneContext';
import type { CodeEditorFile } from '@/shared/types';

/**
 * An editor floating over the pane (popped out, on a phone, in full screen) owns a short Escape:
 * the press closes it, or ends its full screen, before the chat underneath may stop its run on it.
 * EditorSidebar says so through hasFloatingEditor, which chat's ChatInterface reads, for as long as
 * its editor floats in the focused pane.
 */

vi.mock('@/shared/api', () => ({
  api: {
    readFile: async () => ({ ok: true, json: async () => ({ content: 'hello' }) }),
    saveFile: vi.fn(),
    system: { reportClientDiagnostics: async () => new Response(null, { status: 204 }) },
  },
  readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

vi.mock('@uiw/react-codemirror', () => ({
  default: function CodeMirrorStub({ value }: { value: string }) {
    return <textarea data-testid="editor" value={value} readOnly />;
  },
}));

// The pop-out button lives in a CodeMirror panel, which the stubbed editor does not build: the
// stand-in keeps the callback the real button's click invokes.
const toolbarPanels: Array<{ onPopOut: (() => void) | null }> = [];
vi.mock('@/modules/code-editor/utils/editorToolbarPanel', () => ({
  createEditorToolbarPanelExtension: (params: { onPopOut: (() => void) | null }) => {
    toolbarPanels.push(params);
    return [];
  },
}));

const { default: EditorSidebar } = await import('@/modules/code-editor/EditorSidebar');
const { hasFloatingEditor } = await import('@/modules/code-editor');

const file: CodeEditorFile = { name: 'a.txt', path: '/repo/a.txt', projectId: 'p1' };
const onCloseEditor = vi.fn();

Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 });
globalThis.ResizeObserver = class {
  observe() {}

  unobserve() {}

  disconnect() {}
} as unknown as typeof ResizeObserver;

beforeEach(() => {
  toolbarPanels.length = 0;
  onCloseEditor.mockClear();
});

const sidebar = ({ isMobile = false, focused = true, editingFile = file }: { isMobile?: boolean; focused?: boolean; editingFile?: CodeEditorFile | null } = {}) => (
  <WorkspacePaneProvider value={{ side: 'left', isFocusedPane: focused, isSplitPane: false, openFileInEditor: null, openDirectory: null }}>
    <EditorSidebar
      editingFile={editingFile}
      isMobile={isMobile}
      editorExpanded={false}
      editorWidth={600}
      resizeHandleRef={{ current: null }}
      onResizeStart={() => undefined}
      onCloseEditor={onCloseEditor}
      onToggleEditorExpand={() => undefined}
      projectPath="/repo"
    />
  </WorkspacePaneProvider>
);

test('a docked editor leaves Escape to the chat; popped out it takes it until it docks again on close', async () => {
  render(sidebar());
  await screen.findByTestId('editor');
  assert.equal(hasFloatingEditor(), false);

  act(() => {
    toolbarPanels.at(-1)?.onPopOut?.();
  });
  assert.equal(hasFloatingEditor(), true);

  // Closing leaves the floating layout behind, so the next file opens docked.
  act(() => {
    fireEvent.click(screen.getByTitle('actions.close'));
  });
  assert.equal(String(onCloseEditor.mock.calls.length), '1');
  assert.equal(hasFloatingEditor(), false);
});

test('a phone\'s editor takes Escape only in the focused pane, and lets go when the editor goes', async () => {
  const { rerender } = render(sidebar({ isMobile: true, focused: false }));
  await screen.findByTestId('editor');
  assert.equal(hasFloatingEditor(), false);

  rerender(sidebar({ isMobile: true, focused: true }));
  assert.equal(hasFloatingEditor(), true);

  rerender(sidebar({ isMobile: true, focused: true, editingFile: null }));
  assert.equal(hasFloatingEditor(), false);
});

test('the docked editor\'s full screen floats it and takes Escape for as long as it lasts', async () => {
  render(sidebar());
  await screen.findByTestId('editor');

  // jsdom has no Fullscreen API: the editor keeps its CSS maximize, floating over the page.
  act(() => {
    fireEvent.click(screen.getByTitle('actions.fullscreen'));
  });
  assert.equal(hasFloatingEditor(), true);

  act(() => {
    fireEvent.click(screen.getByTitle('actions.exitFullscreen'));
  });
  assert.equal(hasFloatingEditor(), false);
});
