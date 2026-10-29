import assert from 'node:assert/strict';

import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, test, vi } from 'vitest';

import type { CodeEditorFile } from '@/shared/types';

/**
 * The docked editor's diff bar showed over a dialog's overlay: CodeMirror gives its panels (the diff
 * bar, the search panel) z-index 300 and its tooltips 500, and nothing around the docked editor was
 * a stacking context, so the bar competed with the app's dialogs (z-50 and up) and won. The docked
 * box is a stacking context of its own now (Tailwind's `isolate`); the floating editor is one
 * already, a fixed z-[9999] layer. jsdom paints nothing, so this checks what decides the painting:
 * the real CodeMirror's panels sit inside such a box. The bar's pop-out button and the docked
 * editor's resize handle are named in the UI language.
 */

vi.mock('@/shared/api', () => ({
  api: { readFile: vi.fn(), saveFile: vi.fn() },
  readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

const { i18n } = await import('@/modules/i18n');
const { writeCodeEditorSettings } = await import('@/shared/codeEditorSettings');
const { default: EditorSidebar } = await import('@/modules/code-editor/EditorSidebar');

// A diff the editor shows without reading the file: the bar lists its one change.
const file: CodeEditorFile = {
  name: 'style.css',
  path: '/repo/public/style.css',
  projectId: 'p1',
  diffInfo: { old_string: 'body { margin: 0; }\n', new_string: 'body { margin: 0; padding: 0; }\n' },
};

Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 });

globalThis.ResizeObserver = class {
  observe() {}

  unobserve() {}

  disconnect() {}
} as unknown as typeof ResizeObserver;

beforeAll(() => {
  // The minimap draws on a canvas, which jsdom does not have.
  writeCodeEditorSettings({ showMinimap: false });
  // jsdom lays nothing out and has no text-range rectangles; CodeMirror's cursor layer asks for them.
  const emptyRect = { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) };
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => Object.assign([], { item: () => null }),
  });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => emptyRect });
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

const renderSidebar = (isMobile: boolean) => render(
  <div>
    <EditorSidebar
      editingFile={file}
      isMobile={isMobile}
      editorExpanded={false}
      editorWidth={600}
      resizeHandleRef={{ current: null }}
      onResizeStart={() => undefined}
      onCloseEditor={() => undefined}
      onToggleEditorExpand={() => undefined}
      projectPath="/repo"
    />
  </div>,
);

/** The diff bar, once CodeMirror has built it. */
const findDiffBar = async (container: HTMLElement) => {
  await waitFor(() => assert.equal(container.querySelector('.cm-editor-toolbar-panel') !== null, true));
  return container.querySelector('.cm-editor-toolbar-panel') as HTMLElement;
};

test('docked, the diff bar sits in a box that is a stacking context of its own', async () => {
  const { container } = renderSidebar(false);
  const bar = await findDiffBar(container);

  // CodeMirror's panel layer, the one at z-index 300.
  assert.equal(bar.closest('.cm-panels') !== null, true);
  // The box the docked editor fills: its border and width are the docked layout's.
  const box = bar.closest('.border-s');
  assert.equal(box !== null, true);
  assert.equal(box?.classList.contains('isolate'), true);
  assert.equal(box?.classList.contains('contents'), false);
});

test('floating, the editor is a full-viewport layer of its own and the wrappers give up their boxes', async () => {
  const { container } = renderSidebar(true);
  const bar = await findDiffBar(container);

  const layer = bar.closest('.fixed.inset-0');
  assert.equal(layer !== null, true);
  assert.equal(layer?.className.includes('z-[9999]'), true);
  assert.equal(container.querySelector('.isolate') === null, true);
});

test('the pop-out button and the resize handle are named in the UI language', async () => {
  const english = renderSidebar(false);
  await findDiffBar(english.container);
  assert.equal(english.container.querySelector('.cm-popout-btn')?.getAttribute('title'), 'Open in modal');
  assert.equal(english.container.querySelector('.cursor-col-resize')?.getAttribute('title'), 'Drag to resize');
  english.unmount();

  for (const language of ['zh-CN', 'he']) {
    await i18n.changeLanguage(language);
    const translate = i18n.getFixedT(language, 'codeEditor');
    const { container, unmount } = renderSidebar(false);
    await findDiffBar(container);
    const popOut = container.querySelector('.cm-popout-btn')?.getAttribute('title') ?? '';
    const resize = container.querySelector('.cursor-col-resize')?.getAttribute('title') ?? '';
    assert.equal(popOut, translate('toolbar.popOut'));
    assert.equal(resize, translate('resizeEditor'));
    // Their own words, not the English ones set apart as a fallback.
    assert.equal(/[A-Za-z]/.test(popOut), false);
    assert.equal(/[A-Za-z]/.test(resize), false);
    unmount();
  }
});
