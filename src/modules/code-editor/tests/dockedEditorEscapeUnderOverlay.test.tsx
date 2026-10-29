import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { holdBrowserFullscreen } from '@/shared/browserFullscreen';
import { WorkspacePaneProvider } from '@/shared/context/WorkspacePaneContext';
import type { CodeEditorFile, PrdEditorFile } from '@/shared/types';

/**
 * The workspace docks the code editor beside every view, so an editor open in the pane stays docked
 * under Browser Use's full-screen preview and under the PRD editor (a dialog, or in full screen). A
 * short Escape there is the view's: it leaves the full screen or closes the PRD editor, and the
 * editor behind it neither closes nor asks to drop its unsaved changes, whichever listener came
 * first. A floating editor (popped out, on a phone, in full screen) is above those views and keeps
 * its Escape.
 */

const SESSION = {
  id: 's1',
  status: 'ready',
  url: 'https://example.com/',
  title: 'Example',
  screenshotDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  createdAt: '2026-10-29T00:00:00.000Z',
  updatedAt: '2026-10-29T00:00:00.000Z',
  lastAction: null,
  message: null,
  createdBy: 'agent',
  profileName: null,
  viewport: null,
  cursor: null,
};

const PRD_PATH = '/repo/.taskmaster/docs/prd.txt';
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      // The PRD a test opens from disk never finishes loading; the code editor's file does at once.
      readFile: async (_projectId: string, path: string) => (path === PRD_PATH
        ? new Promise<never>(() => undefined)
        : { ok: true, json: async () => ({ content: 'hello' }) }),
      saveFile: vi.fn(),
      browserUse: {
        status: async () => json({ data: { enabled: true, available: true, playwrightInstalled: true, chromiumInstalled: true, installInProgress: false, sessionCount: 1, message: '' } }),
        sessions: async () => json({ data: { sessions: [SESSION] } }),
        stopSession: async () => json({ success: true }),
        deleteSession: async () => json({ success: true }),
        installRuntime: async () => json({ success: true }),
      },
      system: { reportClientDiagnostics: async () => new Response(null, { status: 204 }) },
    },
    readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
  };
});

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

// Both editors' CodeMirror: a text area the tests type into.
vi.mock('@uiw/react-codemirror', () => ({
  default: function CodeMirrorStub({ value, onChange }: { value: string; onChange?: (next: string) => void }) {
    return <textarea data-testid="codemirror" value={value} onChange={(event) => onChange?.(event.target.value)} />;
  },
}));

const { default: EditorSidebar } = await import('@/modules/code-editor/EditorSidebar');
const { BrowserUsePanel } = await import('@/modules/browser-use');
const { PRDEditor } = await import('@/modules/prd-editor');

const file: CodeEditorFile = { name: 'a.txt', path: '/repo/a.txt', projectId: 'p1' };
const onCloseEditor = vi.fn();
const onClosePrd = vi.fn();
// "Discard the unsaved changes?" answered with Cancel.
const confirmDiscard = vi.fn(() => false);

let fullscreenElement: Element | null = null;
const requestFullscreen = vi.fn(async () => {
  fullscreenElement = document.documentElement;
  document.dispatchEvent(new Event('fullscreenchange'));
});
const exitFullscreen = vi.fn(async () => {
  fullscreenElement = null;
  document.dispatchEvent(new Event('fullscreenchange'));
});

Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 });
globalThis.ResizeObserver = class {
  observe() {}

  unobserve() {}

  disconnect() {}
} as unknown as typeof ResizeObserver;

beforeEach(() => {
  fullscreenElement = null;
  onCloseEditor.mockClear();
  onClosePrd.mockClear();
  confirmDiscard.mockClear();
  requestFullscreen.mockClear();
  exitFullscreen.mockClear();
  vi.stubGlobal('confirm', confirmDiscard);
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true });
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
  Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, writable: true, value: requestFullscreen });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, writable: true, value: exitFullscreen });
});

afterEach(() => {
  for (const [target, key] of [[document, 'fullscreenEnabled'], [document, 'fullscreenElement'], [document.documentElement, 'requestFullscreen'], [document, 'exitFullscreen']] as const) {
    Reflect.deleteProperty(target, key);
  }
  vi.unstubAllGlobals();
});

/** A pane as WorkspaceMain lays it out: the view, then the editor docked beside it. */
const pane = (view: ReactNode, isMobile = false) => (
  <WorkspacePaneProvider value={{ side: 'left', isFocusedPane: true, isSplitPane: false, openFileInEditor: null, openDirectory: null }}>
    <div className="flex">
      {view}
      <EditorSidebar
        editingFile={file}
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
  </WorkspacePaneProvider>
);

/** The code editor's buffer, once its file has loaded. */
const findCodeEditor = async () => {
  await waitFor(() => assert.equal(screen.queryAllByTestId('codemirror').some((area) => (area as HTMLTextAreaElement).value === 'hello'), true));
  return screen.getAllByTestId('codemirror').find((area) => (area as HTMLTextAreaElement).value === 'hello') as HTMLTextAreaElement;
};

const typeInto = (area: HTMLTextAreaElement, value: string) => {
  act(() => {
    fireEvent.change(area, { target: { value } });
  });
};

const pressEscape = () => {
  act(() => {
    fireEvent.keyDown(document, { key: 'Escape' });
  });
};

const overlay = () => document.querySelector('.fixed.inset-0.z-50');

const openBrowserUseFullscreen = async () => {
  // Without i18n set up, labels are their keys.
  const button = await screen.findByRole('button', { name: 'browserUse.fullScreen' });
  await waitFor(() => assert.equal(button.hasAttribute('disabled'), false));
  act(() => {
    fireEvent.click(button);
  });
  await act(async () => undefined);
  assert.equal(overlay() !== null, true);
};

const prdBackdropClass = () => document.querySelector('.fixed.inset-0.z-\\[200\\]')?.className ?? '';

test('Browser Use\'s full-screen preview takes Escape over the docked editor beside it', async () => {
  render(pane(<BrowserUsePanel isVisible />));
  await findCodeEditor();
  await openBrowserUseFullscreen();

  pressEscape();
  assert.equal(String(onCloseEditor.mock.calls.length), '0');
  assert.equal(overlay() === null, true);
  assert.equal(String(exitFullscreen.mock.calls.length), '1');

  // The preview gone, Escape is the editor's again.
  pressEscape();
  assert.equal(String(onCloseEditor.mock.calls.length), '1');
});

test('the editor\'s unsaved changes are not offered for discarding by the preview\'s Escape', async () => {
  render(pane(<BrowserUsePanel isVisible />));
  typeInto(await findCodeEditor(), 'hello, edited');
  await openBrowserUseFullscreen();

  pressEscape();
  assert.equal(String(confirmDiscard.mock.calls.length), '0');
  assert.equal(String(onCloseEditor.mock.calls.length), '0');
  assert.equal(overlay() === null, true);
  assert.equal(String(exitFullscreen.mock.calls.length), '1');

  // The editor's own Escape still asks first.
  pressEscape();
  assert.equal(String(confirmDiscard.mock.calls.length), '1');
  assert.equal(String(onCloseEditor.mock.calls.length), '0');
});

test('the preview keeps its Escape when the editor\'s key listener came after its own', async () => {
  render(pane(<BrowserUsePanel isVisible />));
  const editor = await findCodeEditor();
  await openBrowserUseFullscreen();
  // Typing re-registers the editor's key listener, after the preview's this time.
  typeInto(editor, 'hello, edited');

  pressEscape();
  assert.equal(String(confirmDiscard.mock.calls.length), '0');
  assert.equal(String(onCloseEditor.mock.calls.length), '0');
  assert.equal(overlay() === null, true);
  assert.equal(String(exitFullscreen.mock.calls.length), '1');
});

test('the PRD editor, a dialog over the pane, takes Escape over the docked editor with unsaved changes', async () => {
  // The file was open first and the PRD editor came after, from the Tasks view.
  const { rerender } = render(pane(null));
  typeInto(await findCodeEditor(), 'hello, edited');
  rerender(pane(<PRDEditor onClose={onClosePrd} isNewFile initialContent="# PRD" />));

  pressEscape();
  assert.equal(String(confirmDiscard.mock.calls.length), '0');
  assert.equal(String(onCloseEditor.mock.calls.length), '0');
  assert.equal(String(onClosePrd.mock.calls.length), '1');
});

test('the PRD editor in full screen takes Escape to leave it, then to close, over the docked editor', async () => {
  const { rerender } = render(pane(null));
  await findCodeEditor();
  rerender(pane(<PRDEditor onClose={onClosePrd} isNewFile initialContent="# PRD" />));
  act(() => {
    fireEvent.click(screen.getByTitle('Fullscreen'));
  });
  await act(async () => undefined);
  assert.equal(prdBackdropClass().includes('md:p-0'), true);

  pressEscape();
  assert.equal(String(onCloseEditor.mock.calls.length), '0');
  assert.equal(String(exitFullscreen.mock.calls.length), '1');
  assert.equal(prdBackdropClass().includes('md:p-4'), true);
  assert.equal(String(onClosePrd.mock.calls.length), '0');

  pressEscape();
  assert.equal(String(onCloseEditor.mock.calls.length), '0');
  assert.equal(String(onClosePrd.mock.calls.length), '1');
});

test('the PRD editor takes Escape over the docked editor while its file still loads', async () => {
  const prd: PrdEditorFile = { name: 'prd.txt', projectId: 'p1', path: PRD_PATH, isExisting: true };
  const { rerender } = render(pane(null));
  await findCodeEditor();
  rerender(pane(<PRDEditor onClose={onClosePrd} file={prd} projectPath="/repo" />));
  assert.equal(screen.queryByText('Loading PRD...') !== null, true);

  pressEscape();
  assert.equal(String(onCloseEditor.mock.calls.length), '0');
  assert.equal(String(onClosePrd.mock.calls.length), '1');
});

test('a docked editor steps aside while a view is maximized over the page; a floating one keeps its Escape', async () => {
  const docked = render(pane(null));
  await findCodeEditor();
  let release = holdBrowserFullscreen({ source: 'browserUse', onBrowserExit: () => undefined });
  pressEscape();
  assert.equal(String(onCloseEditor.mock.calls.length), '0');
  act(() => {
    release();
  });
  pressEscape();
  assert.equal(String(onCloseEditor.mock.calls.length), '1');
  docked.unmount();

  // On a phone the editor floats over everything in the pane, a maximized view included.
  render(pane(null, true));
  await findCodeEditor();
  release = holdBrowserFullscreen({ source: 'browserUse', onBrowserExit: () => undefined });
  pressEscape();
  assert.equal(String(onCloseEditor.mock.calls.length), '2');
  act(() => {
    release();
  });
});
