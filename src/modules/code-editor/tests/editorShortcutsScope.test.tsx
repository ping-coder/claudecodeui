import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo } from 'react';
import { test, vi } from 'vitest';

import { WorkspacePaneProvider } from '@/shared/context/WorkspacePaneContext';
import type { CodeEditorFile, WorkspacePaneSide } from '@/shared/types';

/**
 * Regression guard for split panes: each pane can hold an open editor, and both
 * used to listen for Ctrl/Cmd+S and Escape on the document, so one Ctrl+S saved
 * both files and Escape closed the editor that registered first rather than the
 * one in use. Only the focused pane's editor answers them now.
 */

const readFile = vi.fn(async (_projectId: string, filePath: string) => ({
  ok: true,
  json: async () => ({ content: `content of ${filePath}` }),
}));
const saveFile = vi.fn(async (_projectId: string, _filePath: string, _content: string) => ({
  ok: true,
  json: async () => ({ success: true }),
}));

vi.mock('@/shared/api', () => ({
  api: { readFile, saveFile },
  readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

vi.mock('@uiw/react-codemirror', () => {
  function CodeMirrorStub({ value, onChange }: { value: string; onChange?: (value: string) => void }) {
    return (
      <textarea
        data-testid="editor"
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
      />
    );
  }

  return { default: CodeMirrorStub };
});

const { default: CodeEditor } = await import('@/modules/code-editor/CodeEditor');

type PaneContextValue = Parameters<typeof WorkspacePaneProvider>[0]['value'];

const leftFile: CodeEditorFile = { name: 'a.txt', path: '/repo/a.txt', projectId: 'p1' };
const rightFile: CodeEditorFile = { name: 'b.txt', path: '/repo/b.txt', projectId: 'p1' };

const closeLeft = vi.fn();
const closeRight = vi.fn();

const paneContext = (side: WorkspacePaneSide, focusedSide: WorkspacePaneSide): PaneContextValue => ({
  side,
  isFocusedPane: side === focusedSide,
  isSplitPane: true,
  openFileInEditor: null,
  openDirectory: null,
});

/** Two panes side by side, each with a docked editor, as WorkspaceMain renders them. */
function TwoPanes({ focusedSide }: { focusedSide: WorkspacePaneSide }) {
  const left = useMemo(() => paneContext('left', focusedSide), [focusedSide]);
  const right = useMemo(() => paneContext('right', focusedSide), [focusedSide]);

  return (
    <>
      <div data-workspace-pane="left">
        <WorkspacePaneProvider value={left}>
          <CodeEditor file={leftFile} onClose={closeLeft} isSidebar />
        </WorkspacePaneProvider>
      </div>
      <div data-workspace-pane="right">
        <WorkspacePaneProvider value={right}>
          <CodeEditor file={rightFile} onClose={closeRight} isSidebar />
        </WorkspacePaneProvider>
      </div>
    </>
  );
}

const renderPanes = async (focusedSide: WorkspacePaneSide) => {
  const view = render(<TwoPanes focusedSide={focusedSide} />);
  await waitFor(() => {
    const [leftEditor, rightEditor] = screen.queryAllByTestId<HTMLTextAreaElement>('editor');
    assert.equal(leftEditor?.value, 'content of /repo/a.txt');
    assert.equal(rightEditor?.value, 'content of /repo/b.txt');
  });
  const [leftEditor, rightEditor] = screen.getAllByTestId<HTMLTextAreaElement>('editor');
  return { ...view, leftEditor, rightEditor };
};

const typeInto = (editor: HTMLTextAreaElement, value: string) => {
  fireEvent.change(editor, { target: { value } });
};

const pressSave = (target: HTMLElement) => {
  fireEvent.keyDown(target, { key: 's', ctrlKey: true });
};

// A macrotask boundary lets every save that was started reach the API mock and
// settle, so a second, unwanted save cannot slip in after the assertion.
const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const savedPaths = () => saveFile.mock.calls.map((call) => call[1]);

test('Ctrl+S saves only the file in the focused pane', async () => {
  const { leftEditor, rightEditor } = await renderPanes('left');
  // Both buffers have something to lose, so a save of either would matter.
  typeInto(leftEditor, 'left edited');
  typeInto(rightEditor, 'right edited');

  pressSave(leftEditor);
  await waitFor(() => assert.ok(saveFile.mock.calls.length > 0));
  await settle();

  assert.deepEqual(savedPaths(), ['/repo/a.txt']);
  assert.equal(saveFile.mock.calls[0][2], 'left edited');
});

test('Escape closes only the editor in the focused pane', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const { rightEditor } = await renderPanes('right');

  fireEvent.keyDown(rightEditor, { key: 'Escape' });

  assert.equal(closeRight.mock.calls.length, 1);
  assert.equal(closeLeft.mock.calls.length, 0);
  // Both buffers were clean, so nothing had to be confirmed either.
  assert.equal(confirm.mock.calls.length, 0);
});

test('moving the focus to the other pane takes both shortcuts with it', async () => {
  const { rerender, rightEditor } = await renderPanes('left');

  // What a click into the right pane does to the pane context.
  rerender(<TwoPanes focusedSide="right" />);

  pressSave(rightEditor);
  await waitFor(() => assert.ok(saveFile.mock.calls.length > 0));
  await settle();
  assert.deepEqual(savedPaths(), ['/repo/b.txt']);

  fireEvent.keyDown(rightEditor, { key: 'Escape' });
  assert.equal(closeRight.mock.calls.length, 1);
  assert.equal(closeLeft.mock.calls.length, 0);

  // ...and back again.
  rerender(<TwoPanes focusedSide="left" />);
  const [leftEditor] = screen.getAllByTestId<HTMLTextAreaElement>('editor');
  fireEvent.keyDown(leftEditor, { key: 'Escape' });
  assert.equal(closeLeft.mock.calls.length, 1);
  assert.equal(closeRight.mock.calls.length, 1);
});
