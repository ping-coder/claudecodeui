import assert from 'node:assert/strict';

import { openSearchPanel } from '@codemirror/search';
import { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { test } from 'vitest';

import PrdEditorBody from '@/modules/prd-editor/PrdEditorBody';

/**
 * Regression guard: the PRD editor's Ctrl+F search panel closed on the next keystroke, as the code
 * editor's did: a new basicSetup object on every render reconfigured the editor, which dropped the
 * search state Ctrl+F had appended. Turning word wrap on or off closed it too. The real CodeMirror
 * runs here, not a stub.
 */

/** Keeps the buffer as PRDEditor does: each keystroke sets the content and re-renders the body. */
function Body({ wordWrap }: { wordWrap: boolean }) {
  const [content, setContent] = useState('# PRD');
  return <PrdEditorBody content={content} onContentChange={setContent} previewMode={false} isDarkMode={false} wordWrap={wordWrap} />;
}

// Booleans only: a failed assertion on a DOM node would print the whole structure.
const isSearchOpen = (container: HTMLElement) => container.querySelector('.cm-search') !== null;

test('the search panel stays open while the PRD is typed in and while word wrap changes', () => {
  const { container, rerender } = render(<Body wordWrap />);
  const editor = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement);
  if (!editor) {
    throw new Error('no editor view');
  }
  // Appended the way Ctrl+F used to append the search state: a reconfiguration drops it.
  const appended = () => undefined;
  act(() => {
    editor.dispatch({ effects: StateEffect.appendConfig.of(EditorView.updateListener.of(appended)) });
    openSearchPanel(editor);
  });
  assert.equal(isSearchOpen(container), true);

  act(() => {
    editor.dispatch({ changes: { from: editor.state.doc.length, insert: '\n' }, userEvent: 'input.type' });
  });

  assert.equal(editor.state.doc.toString(), '# PRD\n');
  // Typing re-rendered the body without reconfiguring the editor.
  assert.equal(editor.state.facet(EditorView.updateListener).includes(appended), true);
  assert.equal(isSearchOpen(container), true);

  // Word wrap rebuilds the extensions, which does reconfigure it; the panel stays.
  rerender(<Body wordWrap={false} />);
  assert.equal(editor.state.facet(EditorView.updateListener).includes(appended), false);
  assert.equal(isSearchOpen(container), true);
});
