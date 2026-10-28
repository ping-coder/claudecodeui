import assert from 'node:assert/strict';

import { EditorView } from '@codemirror/view';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { writeCodeEditorSettings } from '@/shared/codeEditorSettings';
import type { CodeEditorFile } from '@/shared/types';
import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

/**
 * Regression guard for "text does not wrap while editing". Every file used to
 * follow one `wordWrap` setting that is off by default, and many users already
 * have it stored as an explicit false, so Markdown and plain-text files never
 * wrapped. Those files now follow their own `textWordWrap` setting (on unless
 * turned off), code keeps `wordWrap`, and the header toggle flips only the
 * setting for the kind of file that is open.
 */

const { recordEditorRender } = vi.hoisted(() => ({
  // Called with the extensions on every render of the stubbed CodeMirror.
  recordEditorRender: vi.fn((extensions: unknown[]) => extensions),
}));

vi.mock('@/shared/api', () => ({
  api: {
    readFile: async () => ({ ok: true, json: async () => ({ content: 'a long line' }) }),
    saveFile: async () => ({ ok: true, json: async () => ({ success: true }) }),
    // The preference store pushes edits to the server on a debounce.
    user: { savePreferences: async () => new Response('{}', { status: 200 }) },
  },
  readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

vi.mock('@uiw/react-codemirror', () => {
  function CodeMirrorStub({ value, extensions }: { value: string; extensions?: unknown[] }) {
    recordEditorRender(extensions ?? []);
    return <textarea data-testid="editor" value={value} readOnly />;
  }

  return { default: CodeMirrorStub };
});

const { default: CodeEditor } = await import('@/modules/code-editor/CodeEditor');

/** The single localStorage blob the preference store mirrors the server into. */
const MIRROR_STORAGE_KEY = 'user-preferences';

const TEXT_TOGGLE_LABEL = 'Word wrap (Markdown and text files)';
const CODE_TOGGLE_LABEL = 'Word wrap (code files)';

const storedCodeEditorSettings = (): Record<string, unknown> => {
  const raw = localStorage.getItem(MIRROR_STORAGE_KEY);
  const mirror = raw === null ? {} : (JSON.parse(raw) as { codeEditorSettings?: Record<string, unknown> });
  return mirror.codeEditorSettings ?? {};
};

const openEditor = async (name: string) => {
  const file: CodeEditorFile = { name, path: `/repo/${name}`, projectId: 'p1' };
  const view = render(<CodeEditor file={file} onClose={() => undefined} />);
  const editor = await screen.findByTestId<HTMLTextAreaElement>('editor');
  await waitFor(() => assert.equal(editor.value, 'a long line'));
  return view;
};

// Booleans only: a failed assertion on the extension list or on a DOM node
// would print the whole structure.
const isWrapping = () => (recordEditorRender.mock.lastCall?.[0] ?? []).includes(EditorView.lineWrapping);
const hasToggle = (label: string) => screen.queryByLabelText(label) !== null;
const togglePressed = (label: string) => screen.getByLabelText(label).getAttribute('aria-pressed');

beforeEach(() => {
  resetUserPreferences();
  localStorage.clear();
  recordEditorRender.mockClear();
});

test('Markdown and plain-text files wrap by default, code files do not', async () => {
  for (const name of ['notes.md', 'notes.markdown', 'notes.mdx', 'notes.txt', 'notes.rst', 'notes.adoc', 'README.MD']) {
    const { unmount } = await openEditor(name);
    assert.equal(isWrapping(), true, `${name} should wrap`);
    assert.equal(hasToggle(TEXT_TOGGLE_LABEL), true, `${name} should offer the text-file toggle`);
    unmount();
  }

  // A file without an extension, a log or a config file is treated as code.
  for (const name of ['a.ts', 'server.log', 'LICENSE', 'config.json']) {
    const { unmount } = await openEditor(name);
    assert.equal(isWrapping(), false, `${name} should not wrap`);
    assert.equal(hasToggle(CODE_TOGGLE_LABEL), true, `${name} should offer the code-file toggle`);
    unmount();
  }
});

test('a wordWrap: false stored before the split does not stop text files wrapping', async () => {
  // What the old settings page wrote for anyone who changed any editor setting.
  writeUserPreference('codeEditorSettings', {
    wordWrap: false,
    showMinimap: true,
    lineNumbers: true,
    fontSize: '12',
  });

  const markdown = await openEditor('notes.md');
  assert.equal(isWrapping(), true);
  markdown.unmount();

  await openEditor('a.ts');
  assert.equal(isWrapping(), false);
});

test('a user who already wraps code keeps wrapping both kinds of file', async () => {
  writeUserPreference('codeEditorSettings', { wordWrap: true });

  const code = await openEditor('a.ts');
  assert.equal(isWrapping(), true);
  code.unmount();

  await openEditor('notes.md');
  assert.equal(isWrapping(), true);
});

test('the toggle in a text file turns off wrapping for text files only, and it sticks', async () => {
  const first = await openEditor('notes.md');
  assert.equal(togglePressed(TEXT_TOGGLE_LABEL), 'true');

  fireEvent.click(screen.getByLabelText(TEXT_TOGGLE_LABEL));

  assert.equal(isWrapping(), false);
  assert.equal(togglePressed(TEXT_TOGGLE_LABEL), 'false');
  // Stored in the synced settings, leaving the code-file setting unset.
  assert.equal(storedCodeEditorSettings().textWordWrap, false);
  assert.equal('wordWrap' in storedCodeEditorSettings(), false);
  first.unmount();

  await openEditor('notes.md');
  assert.equal(isWrapping(), false);
});

test('the toggle in a code file turns on wrapping for code files only', async () => {
  const code = await openEditor('a.ts');
  assert.equal(togglePressed(CODE_TOGGLE_LABEL), 'false');

  fireEvent.click(screen.getByLabelText(CODE_TOGGLE_LABEL));

  assert.equal(isWrapping(), true);
  assert.equal(togglePressed(CODE_TOGGLE_LABEL), 'true');
  assert.equal(storedCodeEditorSettings().wordWrap, true);
  assert.equal('textWordWrap' in storedCodeEditorSettings(), false);
  code.unmount();

  await openEditor('notes.md');
  assert.equal(isWrapping(), true);
});

test('the Markdown preview has no wrap toggle, since it always wraps', async () => {
  await openEditor('notes.md');
  assert.equal(hasToggle(TEXT_TOGGLE_LABEL), true);

  // No i18n instance is initialised here, so labels without a default render as their key.
  fireEvent.click(screen.getByTitle('actions.previewMarkdown'));
  assert.equal(hasToggle(TEXT_TOGGLE_LABEL), false);

  fireEvent.click(screen.getByTitle('actions.editMarkdown'));
  assert.equal(hasToggle(TEXT_TOGGLE_LABEL), true);
});

test('a change made in the settings dialog reaches an open text file at once', async () => {
  await openEditor('notes.md');
  assert.equal(isWrapping(), true);

  act(() => {
    writeCodeEditorSettings({ textWordWrap: false });
  });

  assert.equal(isWrapping(), false);
  assert.equal(togglePressed(TEXT_TOGGLE_LABEL), 'false');
});
