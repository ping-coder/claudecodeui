import assert from 'node:assert/strict';

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, test } from 'vitest';

import { createEditorToolbarPanelExtension } from '@/modules/code-editor/utils/editorToolbarPanel';

/**
 * The docked editor's "expand to full width" button only widens the editor to its pane. It used
 * the four-corner full-screen glyph and read as the browser's full screen, which the header's own
 * full-screen button now gives; it shows left-right arrows instead.
 */

const LABELS = {
  changes: 'changes',
  previousChange: 'Previous change',
  nextChange: 'Next change',
  hideDiff: 'Hide diff',
  showDiff: 'Show diff',
  collapse: 'Collapse editor',
  expand: 'Expand editor to full width',
  popOut: 'Open in modal',
};

// The four-corner glyph the button used to show.
const FULL_SCREEN_GLYPH = 'M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4';

let view: EditorView | null = null;

afterEach(() => {
  const parent = view?.dom.parentElement;
  view?.destroy();
  parent?.remove();
  view = null;
});

/** The path the docked toolbar's expand button draws, from a real CodeMirror panel. */
const expandButtonPath = (isExpanded: boolean): string => {
  view = new EditorView({
    parent: document.body.appendChild(document.createElement('div')),
    state: EditorState.create({
      doc: 'hello',
      extensions: createEditorToolbarPanelExtension({
        file: { name: 'a.txt', path: '/repo/a.txt', projectId: 'p1' },
        showDiff: false,
        isSidebar: true,
        isExpanded,
        onToggleDiff: () => undefined,
        onPopOut: null,
        onToggleExpand: () => undefined,
        labels: LABELS,
      }),
    }),
  });
  return view.dom.querySelector('.cm-expand-btn path')?.getAttribute('d') ?? '';
};

test('expanding shows left-right arrows (lucide move-horizontal), not the full-screen glyph', () => {
  const path = expandButtonPath(false);
  assert.equal(path === FULL_SCREEN_GLYPH, false);
  assert.equal(path, 'M18 8l4 4-4 4M2 12h20M6 8l-4 4 4 4');
});

test('collapsing shows arrows folding in (lucide fold-horizontal)', () => {
  assert.equal(expandButtonPath(true), 'M2 12h6M22 12h-6M12 2v2M12 8v2M12 14v2M12 20v2M19 9l-3 3 3 3M5 15l3-3-3-3');
});
