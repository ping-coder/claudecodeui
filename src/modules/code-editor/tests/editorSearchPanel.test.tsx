import assert from 'node:assert/strict';

import { openSearchPanel } from '@codemirror/search';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, test } from 'vitest';

import CodeEditorSurface from '@/modules/code-editor/CodeEditorSurface';

/**
 * Regression guard: Ctrl+F's search panel closed on the next keystroke. Every render handed
 * react-codemirror a new basicSetup object, so it reconfigured the editor, and a reconfiguration
 * dropped the search state Ctrl+F had appended. Changing the extensions (the editor floating into
 * full screen, docking again) closed it the same way. The real CodeMirror runs here, not a stub.
 */

// How many reconfigurations the editor went through.
let reconfigurations = 0;
const countReconfigurations = EditorView.updateListener.of((update) => {
  if (update.transactions.some((transaction) => transaction.reconfigured)) {
    reconfigurations += 1;
  }
});
// One list for every render, as CodeEditor memoizes its own.
const STABLE_EXTENSIONS: Extension[] = [countReconfigurations];

/** Keeps the buffer as CodeEditor does: each keystroke sets the content and re-renders the surface. */
function Surface({ extensions }: { extensions: Extension[] }) {
  const [content, setContent] = useState('alpha beta');
  return (
    <CodeEditorSurface
      content={content}
      onChange={setContent}
      markdownPreview={false}
      isMarkdownFile={false}
      isDarkMode={false}
      fontSize={14}
      showLineNumbers
      extensions={extensions}
    />
  );
}

const openEditor = (extensions: Extension[]) => {
  const view = render(<Surface extensions={extensions} />);
  const editor = EditorView.findFromDOM(view.container.querySelector('.cm-editor') as HTMLElement);
  if (!editor) {
    throw new Error('no editor view');
  }
  act(() => {
    openSearchPanel(editor);
  });
  return { ...view, editor };
};

// Booleans only: a failed assertion on a DOM node would print the whole structure.
const isSearchOpen = (container: HTMLElement) => container.querySelector('.cm-search') !== null;

beforeEach(() => {
  reconfigurations = 0;
});

test('typing in the document leaves the editor configured as it was, search panel open', () => {
  const { container, editor } = openEditor(STABLE_EXTENSIONS);
  assert.equal(isSearchOpen(container), true);
  reconfigurations = 0;

  act(() => {
    editor.dispatch({ changes: { from: editor.state.doc.length, insert: '!' }, userEvent: 'input.type' });
  });

  assert.equal(editor.state.doc.toString(), 'alpha beta!');
  assert.equal(String(reconfigurations), '0');
  assert.equal(isSearchOpen(container), true);
});

test('a new set of extensions reconfigures the editor and keeps the search panel open', () => {
  const { container, rerender } = openEditor(STABLE_EXTENSIONS);
  reconfigurations = 0;

  // What entering or leaving full screen does: the toolbar extension is rebuilt for the new layout.
  rerender(<Surface extensions={[countReconfigurations, EditorView.lineWrapping]} />);

  assert.equal(reconfigurations > 0, true);
  assert.equal(isSearchOpen(container), true);
});
