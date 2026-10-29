import { useMemo } from 'react';
import { markdown } from '@codemirror/lang-markdown';
import { search } from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';

import { MarkdownPreview } from '@/modules/code-editor';

/**
 * One object for every render: react-codemirror reconfigures the editor whenever basicSetup's
 * identity changes, and an inline object did so on every keystroke.
 */
const BASIC_SETUP = {
  lineNumbers: true,
  foldGutter: true,
  dropCursor: false,
  allowMultipleSelections: false,
  indentOnInput: true,
  bracketMatching: true,
  closeBrackets: true,
  autocompletion: true,
  highlightSelectionMatches: true,
  searchKeymap: true,
};

/**
 * The search panel's state in the editor's own configuration. Without it Ctrl+F appends that state
 * to the configuration, and a reconfiguration (word wrap, the theme) replaces what was appended,
 * closing an open search panel. One instance, so the state carries over each replacement.
 */
const SEARCH_EXTENSION = search();

type PrdEditorBodyProps = {
  content: string;
  onContentChange: (nextContent: string) => void;
  previewMode: boolean;
  isDarkMode: boolean;
  wordWrap: boolean;
};

/** Rendered by PrdEditorWorkspace inside the prd-editor module to switch the PRD between markdown editing and rendered preview. */
export default function PrdEditorBody({
  content,
  onContentChange,
  previewMode,
  isDarkMode,
  wordWrap,
}: PrdEditorBodyProps) {
  const extensions = useMemo(
    () => [markdown(), ...(wordWrap ? [EditorView.lineWrapping] : []), SEARCH_EXTENSION],
    [wordWrap],
  );

  if (previewMode) {
    return (
      <div className="prose prose-gray h-full max-w-none overflow-y-auto p-6 dark:prose-invert">
        <MarkdownPreview content={content} />
      </div>
    );
  }

  return (
    <CodeMirror
      value={content}
      onChange={onContentChange}
      extensions={extensions}
      theme={isDarkMode ? oneDark : undefined}
      height="100%"
      style={{
        fontSize: '14px',
        height: '100%',
      }}
      basicSetup={BASIC_SETUP}
    />
  );
}
