import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { CodeEditorFile } from '@/shared/types';

/**
 * A workspace refresh moves the editor's reload token. A clean buffer rereads its file in place; edits
 * typed or saved while the reread is out keep the buffer, and so does a reread that fails. A file opened from a
 * chat's diff has nothing on disk to reread, and a media preview fetches its bytes again.
 */

const { readFile, readFileBlob, saveFile } = vi.hoisted(() => ({
  readFile: vi.fn(),
  readFileBlob: vi.fn(),
  saveFile: vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) })),
}));

vi.mock('@/shared/api', () => ({
  api: {
    readFile: (...args: unknown[]) => readFile(...args),
    readFileBlob: (...args: unknown[]) => readFileBlob(...args),
    saveFile: () => saveFile(),
  },
  readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
}));
vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }) }));
vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange }: { value: string; onChange?: (value: string) => void }) => (
    <textarea aria-label="code" value={value} onChange={(event) => onChange?.(event.target.value)} />
  ),
}));
vi.mock('@/modules/code-editor/utils/editorToolbarPanel', () => ({ createEditorToolbarPanelExtension: () => [] }));

const { default: EditorSidebar } = await import('@/modules/code-editor/EditorSidebar');

const TEXT_FILE: CodeEditorFile = { name: 'a.txt', path: '/repo/a.txt', projectId: 'p1' };

const sidebar = (file: CodeEditorFile, reloadToken: number) => (
  <EditorSidebar
    editingFile={file}
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

const textReply = (content: string) => ({ ok: true, json: async () => ({ content }) });
// A string rather than the node: a failed assertion on a jsdom node walks the whole tree.
const editorValue = () => screen.queryByLabelText<HTMLTextAreaElement>('code')?.value ?? null;
const notice = 'Unsaved changes, so the file was not reloaded';

beforeEach(() => {
  readFile.mockReset();
  readFileBlob.mockReset();
  saveFile.mockClear();
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 });
  vi.stubGlobal('ResizeObserver', class {
    observe() {}

    unobserve() {}

    disconnect() {}
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
});

test('edits typed while the reread is out keep the buffer, and the header says the file was left alone', async () => {
  readFile.mockResolvedValueOnce(textReply('hello'));
  const view = render(sidebar(TEXT_FILE, 0));
  await waitFor(() => assert.equal(editorValue(), 'hello'));

  let answer: (value: unknown) => void = () => undefined;
  readFile.mockImplementationOnce(() => new Promise((resolve) => {
    answer = resolve;
  }));
  view.rerender(sidebar(TEXT_FILE, 1));
  await waitFor(() => assert.equal(readFile.mock.calls.length, 2));
  fireEvent.change(screen.getByLabelText('code'), { target: { value: 'typed meanwhile' } });
  await act(async () => {
    answer(textReply('from disk'));
  });

  assert.equal(editorValue(), 'typed meanwhile');
  assert.equal(screen.queryByText(notice) !== null, true);
  assert.equal(screen.queryByLabelText('Unsaved changes') !== null, true, 'still unsaved against the old baseline');
});

test('a save while the reread is out wins: the older disk text never replaces what was just saved', async () => {
  readFile.mockResolvedValueOnce(textReply('hello'));
  const view = render(sidebar(TEXT_FILE, 0));
  await waitFor(() => assert.equal(editorValue(), 'hello'));

  let answer: (value: unknown) => void = () => undefined;
  readFile.mockImplementationOnce(() => new Promise((resolve) => {
    answer = resolve;
  }));
  view.rerender(sidebar(TEXT_FILE, 1));
  await waitFor(() => assert.equal(readFile.mock.calls.length, 2));
  fireEvent.change(screen.getByLabelText('code'), { target: { value: 'saved text' } });
  await act(async () => {
    fireEvent.click(screen.getByTitle('Save'));
  });
  await waitFor(() => assert.equal(screen.queryByLabelText('Unsaved changes') === null, true));
  await act(async () => {
    answer(textReply('hello'));
  });

  assert.equal(saveFile.mock.calls.length, 1);
  assert.equal(editorValue(), 'saved text');
});

test('a reread that fails keeps the buffer instead of an error placeholder', async () => {
  readFile.mockResolvedValueOnce(textReply('hello'));
  const view = render(sidebar(TEXT_FILE, 0));
  await waitFor(() => assert.equal(editorValue(), 'hello'));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

  readFile.mockRejectedValueOnce(new Error('offline'));
  view.rerender(sidebar(TEXT_FILE, 1));
  await waitFor(() => assert.equal(readFile.mock.calls.length, 2));
  await act(async () => undefined);

  assert.equal(editorValue(), 'hello');
});

test('a file opened from a chat\'s diff is not reread', async () => {
  const diffFile: CodeEditorFile = { ...TEXT_FILE, diffInfo: { old_string: 'before', new_string: 'after' } };
  const view = render(sidebar(diffFile, 0));
  await waitFor(() => assert.equal(editorValue(), 'after'));

  view.rerender(sidebar(diffFile, 1));
  await act(async () => undefined);

  assert.equal(readFile.mock.calls.length, 0);
  assert.equal(editorValue(), 'after');
});

test('a media preview fetches its bytes again', async () => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:preview' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
  readFileBlob.mockImplementation(async () => new Response(new Blob(['png'], { type: 'image/png' }), { status: 200 }));
  const image: CodeEditorFile = { name: 'logo.png', path: '/repo/logo.png', projectId: 'p1' };
  const view = render(sidebar(image, 0));
  await waitFor(() => assert.equal(readFileBlob.mock.calls.length, 1));

  view.rerender(sidebar(image, 1));
  await waitFor(() => assert.equal(readFileBlob.mock.calls.length, 2));
  assert.equal(readFile.mock.calls.length, 0, 'nothing is read as text');
  // Unmounted while the blob URL helpers still exist: the preview revokes its URL on the way out.
  view.unmount();
});
