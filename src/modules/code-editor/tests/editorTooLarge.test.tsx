import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import type { CodeEditorFile } from '@/shared/types';

/**
 * A file over the server's read cap (413 FILE_TOO_LARGE) opens as a notice that it is too large,
 * with its size and the cap when the server gives them, instead of an empty buffer or an error
 * placeholder; and nothing is ever saved over the real file. A workspace refresh asks for it again,
 * since its size changes on disk, and an open file that grew past the cap says so on refresh.
 */

const { readFile, saveFile } = vi.hoisted(() => ({
  readFile: vi.fn(),
  saveFile: vi.fn(),
}));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      readFile: (...args: unknown[]) => readFile(...args),
      saveFile: (...args: unknown[]) => saveFile(...args),
    },
  };
});
vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }) }));
vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value }: { value: string }) => <textarea aria-label="code" value={value} readOnly />,
}));
vi.mock('@/modules/code-editor/utils/editorToolbarPanel', () => ({ createEditorToolbarPanelExtension: () => [] }));

const { default: EditorSidebar } = await import('@/modules/code-editor/EditorSidebar');

const BIG_FILE: CodeEditorFile = { name: 'dump.sql', path: '/repo/mounts/data/dump.sql', projectId: 'p1' };
const MB = 1024 * 1024;

const editorAt = (reloadToken?: number) => (
  <EditorSidebar
    editingFile={BIG_FILE}
    isMobile={false}
    editorExpanded={false}
    editorWidth={600}
    resizeHandleRef={{ current: null }}
    onResizeStart={() => undefined}
    onCloseEditor={() => undefined}
    onToggleEditorExpand={() => undefined}
    projectPath="/repo"
    reloadToken={reloadToken}
  />
);

const renderEditor = (reloadToken?: number) => render(editorAt(reloadToken));

const tooLargeReply = (size: number) => json({ error: 'File is too large', code: 'FILE_TOO_LARGE', details: { size, limit: 10 * MB } }, 413);
// A string rather than the node: a failed assertion on a jsdom node walks the whole tree.
const editorValue = () => screen.queryByLabelText<HTMLTextAreaElement>('code')?.value ?? null;

beforeEach(() => {
  readFile.mockReset();
  saveFile.mockReset();
  saveFile.mockResolvedValue(json({ success: true }));
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 });
  vi.stubGlobal('ResizeObserver', class {
    observe() {}

    unobserve() {}

    disconnect() {}
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  await i18n.changeLanguage('en');
});

test('a file over the cap says how large it is and what the editor opens, with no buffer to edit', async () => {
  // The file-tree routes' error body: the message, with the code and details beside it.
  readFile.mockResolvedValue(json({ error: 'File is too large', code: 'FILE_TOO_LARGE', details: { size: 25 * MB, limit: 10 * MB } }, 413));
  renderEditor();

  await waitFor(() => assert.equal(screen.queryByText('File too large') !== null, true));
  assert.equal(screen.queryByText('"dump.sql" is 25 MB; the editor opens files up to 10 MB. Download it or open it in a terminal instead.') !== null, true);
  assert.equal(screen.queryByLabelText('code') === null, true);
  assert.equal(screen.queryByText(/Error loading file/) === null, true);

  // Cmd/Ctrl+S has no buffer to write: the real file is left alone.
  fireEvent.keyDown(document, { key: 's', ctrlKey: true });
  fireEvent.keyDown(document, { key: 's', metaKey: true });
  assert.equal(saveFile.mock.calls.length, 0);
});

test('a bare 413 still reads as too large, without sizes', async () => {
  readFile.mockResolvedValue(json({ error: 'File is too large' }, 413));
  renderEditor();

  await waitFor(() => assert.equal(screen.queryByText('"dump.sql" is too large to open in the editor.') !== null, true));
});

test('the notice is translated, and the structured error envelope reads the same', async () => {
  await i18n.changeLanguage('zh-CN');
  readFile.mockResolvedValue(json({
    success: false,
    error: { code: 'FILE_TOO_LARGE', message: 'File is too large', details: { size: 12.5 * MB, limit: 10 * MB } },
  }, 413));
  renderEditor();

  await waitFor(() => assert.equal(screen.queryByText('文件太大') !== null, true));
  assert.equal(screen.queryByText(/12\.5 MB/) !== null, true);
});

test('any other failure keeps the error placeholder in the buffer', async () => {
  readFile.mockResolvedValue(json({ success: false, error: { code: 'NOT_FOUND', message: 'File not found' } }, 404));
  renderEditor();

  await waitFor(() => assert.equal((screen.queryByLabelText<HTMLTextAreaElement>('code')?.value ?? '').includes('File not found'), true));
  assert.equal(screen.queryByText('File too large') === null, true);
});

test('a file just over the cap never reads as the same size as the cap', async () => {
  // 10,490,000 bytes against a 10 MiB cap: both would round to "10 MB".
  readFile.mockResolvedValue(json({ error: 'File is too large', code: 'FILE_TOO_LARGE', details: { size: 10_490_000, limit: 10 * MB } }, 413));
  renderEditor();

  await waitFor(() => assert.equal(screen.queryByText('File too large') !== null, true));
  assert.equal(screen.queryByText('"dump.sql" is 10.1 MB; the editor opens files up to 10 MB. Download it or open it in a terminal instead.') !== null, true);
});

test('a refresh asks for a too-large file again, and opens it once it fits', async () => {
  readFile.mockResolvedValueOnce(tooLargeReply(12 * MB));
  const view = renderEditor(0);
  await waitFor(() => assert.equal(screen.queryByText(/is 12 MB/) !== null, true));

  // The log was rotated: a few lines now.
  readFile.mockResolvedValueOnce(json({ content: 'fresh log' }));
  view.rerender(editorAt(1));

  await waitFor(() => assert.equal(editorValue(), 'fresh log'));
  assert.equal(readFile.mock.calls.length, 2);
  assert.equal(screen.queryByText('File too large') === null, true);
  // It is an ordinary buffer again: a save writes it.
  fireEvent.keyDown(document, { key: 's', ctrlKey: true });
  await waitFor(() => assert.equal(saveFile.mock.calls.length, 1));
});

test('a refresh of a file still over the cap gives its size now', async () => {
  readFile.mockResolvedValueOnce(tooLargeReply(12 * MB));
  const view = renderEditor(0);
  await waitFor(() => assert.equal(screen.queryByText(/is 12 MB/) !== null, true));

  readFile.mockResolvedValueOnce(tooLargeReply(30 * MB));
  view.rerender(editorAt(1));

  await waitFor(() => assert.equal(screen.queryByText(/is 30 MB/) !== null, true));
  assert.equal(screen.queryByText(/is 12 MB/) === null, true);
});

test('an open file that grew past the cap says so on refresh, instead of keeping a copy that no longer follows the disk', async () => {
  readFile.mockResolvedValueOnce(json({ content: 'small log' }));
  const view = renderEditor(0);
  await waitFor(() => assert.equal(editorValue(), 'small log'));

  readFile.mockResolvedValueOnce(tooLargeReply(11 * MB));
  view.rerender(editorAt(1));

  await waitFor(() => assert.equal(screen.queryByText(/is 11 MB/) !== null, true));
  assert.equal(editorValue(), null);
  fireEvent.keyDown(document, { key: 's', ctrlKey: true });
  assert.equal(saveFile.mock.calls.length, 0);
});
