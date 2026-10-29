import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { CodeEditorFile } from '@/shared/types';

/**
 * The editor's full screen is the browser's: the button (docked or floating) asks for the root
 * fullscreen in its click, the editor floats maximized while it lasts (even after the window grew
 * past the mobile breakpoint), Escape leaves it before it closes the editor, and it ends with the
 * browser's fullscreen, with closing, and with the editor.
 */

const readFile = vi.fn(async () => ({ ok: true, json: async () => ({ content: 'hello' }) }));

vi.mock('@/shared/api', () => ({
  api: {
    readFile,
    // A media preview's bytes never arrive here: its header, with the full-screen button, shows meanwhile.
    readFileBlob: () => new Promise<never>(() => undefined),
    saveFile: vi.fn(),
    system: { reportClientDiagnostics: vi.fn(async () => new Response(null, { status: 204 })) },
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

vi.mock('@/modules/code-editor/utils/editorToolbarPanel', () => ({
  createEditorToolbarPanelExtension: () => [],
}));

const { default: EditorSidebar } = await import('@/modules/code-editor/EditorSidebar');

const file: CodeEditorFile = { name: 'a.txt', path: '/repo/a.txt', projectId: 'p1' };

const onCloseEditor = vi.fn();
let fullscreenElement: Element | null = null;
const requestFullscreen = vi.fn(async () => {
  fullscreenElement = document.documentElement;
  document.dispatchEvent(new Event('fullscreenchange'));
});
const exitFullscreen = vi.fn(async () => {
  fullscreenElement = null;
  document.dispatchEvent(new Event('fullscreenchange'));
});

beforeEach(() => {
  fullscreenElement = null;
  requestFullscreen.mockClear();
  exitFullscreen.mockClear();
  onCloseEditor.mockClear();
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true });
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
  Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, writable: true, value: requestFullscreen });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, writable: true, value: exitFullscreen });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 });
  globalThis.ResizeObserver = class {
    observe() {}

    unobserve() {}

    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  for (const [target, key] of [[document, 'fullscreenEnabled'], [document, 'fullscreenElement'], [document.documentElement, 'requestFullscreen'], [document, 'exitFullscreen']] as const) {
    Reflect.deleteProperty(target, key);
  }
});

const sidebar = (isMobile: boolean, editingFile: CodeEditorFile | null = file) => (
  <div>
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
  </div>
);

const isFloating = (container: HTMLElement) => container.querySelector('.fixed.inset-0') !== null;
// md:p-0 alone: with md:p-4 beside it the stylesheet's md:p-4 wins and the editor keeps a 16px frame.
const isMaximized = (container: HTMLElement) => {
  const className = container.querySelector('.fixed.inset-0')?.className ?? '';
  return className.includes('md:p-0') && !className.includes('md:p-4');
};

test('the floating editor\'s full screen takes the browser fullscreen and survives the window growing past the breakpoint', async () => {
  const { container, rerender } = render(sidebar(true));
  await screen.findByTestId('editor');

  act(() => {
    fireEvent.click(screen.getByTitle('actions.fullscreen'));
  });
  // In the click, on the root element.
  assert.equal(requestFullscreen.mock.calls.length, 1);
  assert.equal(requestFullscreen.mock.contexts[0] === document.documentElement, true);
  await act(async () => undefined);
  assert.equal(isMaximized(container), true);

  // The fullscreen window is wider than the mobile breakpoint: still floating and maximized.
  rerender(sidebar(false));
  assert.equal(isFloating(container), true);
  assert.equal(isMaximized(container), true);

  // The browser leaves fullscreen (Escape): the maximize ends and the desktop editor docks again.
  act(() => {
    fullscreenElement = null;
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  await waitFor(() => assert.equal(isFloating(container), false));
  assert.equal(exitFullscreen.mock.calls.length, 0);
});

test('closing the editor, or the editor going away, leaves the browser fullscreen', async () => {
  const { container, rerender } = render(sidebar(true));
  await screen.findByTestId('editor');
  act(() => {
    fireEvent.click(screen.getByTitle('actions.fullscreen'));
  });
  await act(async () => undefined);

  act(() => {
    fireEvent.click(screen.getByTitle('actions.close'));
  });
  assert.equal(exitFullscreen.mock.calls.length, 1);
  assert.equal(onCloseEditor.mock.calls.length, 1);

  rerender(sidebar(true));
  await screen.findByTestId('editor');
  act(() => {
    fireEvent.click(screen.getByTitle('actions.fullscreen'));
  });
  await act(async () => undefined);
  rerender(sidebar(true, null));
  await waitFor(() => assert.equal(exitFullscreen.mock.calls.length, 2));
  assert.equal(isFloating(container), false);
});

test('the docked editor\'s full screen floats it over the screen and docks it again after', async () => {
  const { container } = render(sidebar(false));
  await screen.findByTestId('editor');
  assert.equal(isFloating(container), false);

  act(() => {
    fireEvent.click(screen.getByTitle('actions.fullscreen'));
  });
  assert.equal(requestFullscreen.mock.calls.length, 1);
  await act(async () => undefined);
  assert.equal(isFloating(container), true);
  assert.equal(isMaximized(container), true);

  act(() => {
    fireEvent.click(screen.getByTitle('actions.exitFullscreen'));
  });
  assert.equal(exitFullscreen.mock.calls.length, 1);
  await waitFor(() => assert.equal(isFloating(container), false));
});

test('Escape leaves full screen first and closes the editor only on the next press', async () => {
  const { container } = render(sidebar(true));
  await screen.findByTestId('editor');
  act(() => {
    fireEvent.click(screen.getByTitle('actions.fullscreen'));
  });
  await act(async () => undefined);

  // An Escape something above took (the palette, CodeMirror's completion list) changes nothing here.
  const claim = (event: KeyboardEvent) => event.preventDefault();
  document.addEventListener('keydown', claim, { capture: true, once: true });
  act(() => {
    fireEvent.keyDown(document, { key: 'Escape' });
  });
  assert.equal(isMaximized(container), true);

  act(() => {
    fireEvent.keyDown(document, { key: 'Escape' });
  });
  assert.equal(exitFullscreen.mock.calls.length, 1);
  assert.equal(isMaximized(container), false);
  assert.equal(onCloseEditor.mock.calls.length, 0);

  // The repeats of a held Escape do not close it either.
  act(() => {
    fireEvent.keyDown(document, { key: 'Escape', repeat: true });
  });
  assert.equal(onCloseEditor.mock.calls.length, 0);

  act(() => {
    fireEvent.keyDown(document, { key: 'Escape' });
  });
  assert.equal(onCloseEditor.mock.calls.length, 1);
});

test('the docked media preview has full screen too: it floats over the screen and docks again after', async () => {
  const picture: CodeEditorFile = { name: 'pic.png', path: '/repo/pic.png', projectId: 'p1' };
  const { container } = render(sidebar(false, picture));
  // The preview's labels fall back to their English defaults without i18n.
  const button = await screen.findByRole('button', { name: 'Fullscreen' });
  assert.equal(isFloating(container), false);

  act(() => {
    fireEvent.click(button);
  });
  assert.equal(String(requestFullscreen.mock.calls.length), '1');
  await act(async () => undefined);
  assert.equal(isFloating(container), true);

  act(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Exit fullscreen' }));
  });
  assert.equal(String(exitFullscreen.mock.calls.length), '1');
  await waitFor(() => assert.equal(isFloating(container), false));
});
