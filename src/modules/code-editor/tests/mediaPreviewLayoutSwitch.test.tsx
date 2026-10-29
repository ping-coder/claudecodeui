import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, test, vi } from 'vitest';

import type { CodeEditorFile } from '@/shared/types';

/**
 * A media preview keeps its element whatever the editor's layout: full screen from the docked
 * preview and back, or the window crossing the mobile breakpoint, only change the wrappers' classes.
 * A rebuilt <video> starts again at 0:00, paused, and a rebuilt PDF frame reloads at page 1.
 */

vi.mock('@/shared/api', () => ({
  api: {
    readFile: vi.fn(),
    // A PDF has to start with the PDF marker to be shown.
    readFileBlob: async (_projectId: string, path: string) => ({
      ok: true,
      status: 200,
      blob: async () => (path.endsWith('.pdf')
        ? new Blob(['%PDF-1.4\n'], { type: 'application/pdf' })
        : new Blob(['frames'], { type: 'video/mp4' })),
    }),
    saveFile: vi.fn(),
    system: { reportClientDiagnostics: async () => new Response(null, { status: 204 }) },
  },
  readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

const { default: EditorSidebar } = await import('@/modules/code-editor/EditorSidebar');

const clip: CodeEditorFile = { name: 'clip.mp4', path: '/repo/clip.mp4', projectId: 'p1' };
const pdf: CodeEditorFile = { name: 'doc.pdf', path: '/repo/doc.pdf', projectId: 'p1' };

Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 });
globalThis.ResizeObserver = class {
  observe() {}

  unobserve() {}

  disconnect() {}
} as unknown as typeof ResizeObserver;

beforeAll(() => {
  // jsdom has no blob URLs and no Blob.arrayBuffer, which the PDF check reads the first bytes with.
  let urls = 0;
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => `blob:preview-${(urls += 1)}` });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
  Object.defineProperty(Blob.prototype, 'arrayBuffer', {
    configurable: true,
    value(this: Blob) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(this);
      });
    },
  });
});

afterAll(() => {
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
  Reflect.deleteProperty(Blob.prototype, 'arrayBuffer');
});

const sidebar = (editingFile: CodeEditorFile, isMobile = false) => (
  <div>
    <EditorSidebar
      editingFile={editingFile}
      isMobile={isMobile}
      editorExpanded={false}
      editorWidth={600}
      resizeHandleRef={{ current: null }}
      onResizeStart={() => undefined}
      onCloseEditor={() => undefined}
      onToggleEditorExpand={() => undefined}
      projectPath="/repo"
    />
  </div>
);

const isFloating = (container: HTMLElement) => container.querySelector('.fixed.inset-0') !== null;

for (const [editingFile, selector] of [[clip, 'video'], [pdf, 'iframe']] as const) {
  test(`full screen from the docked ${editingFile.name} preview and back keeps its <${selector}>`, async () => {
    const { container } = render(sidebar(editingFile));
    await waitFor(() => assert.equal(container.querySelector(selector) !== null, true));
    const media = container.querySelector(selector);
    assert.equal(isFloating(container), false);

    // The preview's labels fall back to their English defaults without i18n.
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
    });
    await act(async () => undefined);
    assert.equal(isFloating(container), true);
    assert.equal(container.querySelector(selector) === media, true);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Exit fullscreen' }));
    });
    await waitFor(() => assert.equal(isFloating(container), false));
    assert.equal(container.querySelector(selector) === media, true);
  });
}

test('the window crossing the mobile breakpoint floats and docks the preview with its <video> kept', async () => {
  const { container, rerender } = render(sidebar(clip));
  await waitFor(() => assert.equal(container.querySelector('video') !== null, true));
  const video = container.querySelector('video');

  rerender(sidebar(clip, true));
  assert.equal(isFloating(container), true);
  assert.equal(container.querySelector('video') === video, true);

  rerender(sidebar(clip, false));
  assert.equal(isFloating(container), false);
  assert.equal(container.querySelector('video') === video, true);
});
