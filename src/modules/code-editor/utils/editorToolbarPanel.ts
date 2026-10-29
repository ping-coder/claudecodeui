import { getChunks } from '@codemirror/merge';
import { EditorView, showPanel } from '@codemirror/view';

import type { CodeEditorFile } from '@/shared/types';

type EditorToolbarLabels = {
  changes: string;
  previousChange: string;
  nextChange: string;
  hideDiff: string;
  showDiff: string;
  collapse: string;
  expand: string;
  popOut: string;
};

type CreateEditorToolbarPanelParams = {
  file: CodeEditorFile;
  showDiff: boolean;
  isSidebar: boolean;
  isExpanded: boolean;
  onToggleDiff: () => void;
  onPopOut: (() => void) | null;
  onToggleExpand: (() => void) | null;
  labels: EditorToolbarLabels;
};

const getDiffVisibilityIcon = (showDiff: boolean) => {
  if (showDiff) {
    return '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />';
  }

  return '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />';
};

// Left-right arrows, not the four-corner full-screen glyph: this only widens the docked editor to
// its pane, and the full-screen look made it read as the browser's full screen.
const getExpandIcon = (isExpanded: boolean) => {
  if (isExpanded) {
    // lucide fold-horizontal
    return '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2 12h6M22 12h-6M12 2v2M12 8v2M12 14v2M12 20v2M19 9l-3 3 3 3M5 15l3-3-3-3" />';
  }

  // lucide move-horizontal
  return '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 8l4 4-4 4M2 12h20M6 8l-4 4 4 4" />';
};

const escapeHtml = (value: string): string => (
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
);

export const createEditorToolbarPanelExtension = ({
  file,
  showDiff,
  isSidebar,
  isExpanded,
  onToggleDiff,
  onPopOut,
  onToggleExpand,
  labels,
}: CreateEditorToolbarPanelParams) => {
  const hasToolbarButtons = Boolean(file.diffInfo || (isSidebar && onPopOut) || (isSidebar && onToggleExpand));
  if (!hasToolbarButtons) {
    return [];
  }

  const createPanel = (view: EditorView) => {
    const dom = document.createElement('div');
    dom.className = 'cm-editor-toolbar-panel';

    let currentIndex = 0;

    const updatePanel = () => {
      const hasDiff = Boolean(file.diffInfo && showDiff);
      const chunksData = hasDiff ? getChunks(view.state) : null;
      const chunks = chunksData?.chunks || [];
      const chunkCount = chunks.length;
      const maxChunkIndex = Math.max(0, chunkCount - 1);
      currentIndex = Math.max(0, Math.min(currentIndex, maxChunkIndex));
      const escapedLabels = {
        changes: escapeHtml(labels.changes),
        previousChange: escapeHtml(labels.previousChange),
        nextChange: escapeHtml(labels.nextChange),
        hideDiff: escapeHtml(labels.hideDiff),
        showDiff: escapeHtml(labels.showDiff),
        collapse: escapeHtml(labels.collapse),
        expand: escapeHtml(labels.expand),
        popOut: escapeHtml(labels.popOut),
      };
      // Icons are static SVG path fragments controlled by this module.
      const diffVisibilityIcon = getDiffVisibilityIcon(showDiff);
      const expandIcon = getExpandIcon(isExpanded);

      let toolbarHtml = '<div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">';
      toolbarHtml += '<div style="display: flex; align-items: center; gap: 8px;">';

      if (hasDiff) {
        toolbarHtml += `
          <span style="font-weight: 500;">${chunkCount > 0 ? `${currentIndex + 1}/${chunkCount}` : '0'} ${escapedLabels.changes}</span>
          <button class="cm-diff-nav-btn cm-diff-nav-prev" title="${escapedLabels.previousChange}" ${chunkCount === 0 ? 'disabled' : ''}>
            <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />
            </svg>
          </button>
          <button class="cm-diff-nav-btn cm-diff-nav-next" title="${escapedLabels.nextChange}" ${chunkCount === 0 ? 'disabled' : ''}>
            <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        `;
      }

      toolbarHtml += '</div>';
      toolbarHtml += '<div style="display: flex; align-items: center; gap: 4px;">';

      if (file.diffInfo) {
        toolbarHtml += `
          <button class="cm-toolbar-btn cm-toggle-diff-btn" title="${showDiff ? escapedLabels.hideDiff : escapedLabels.showDiff}">
            <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              ${diffVisibilityIcon}
            </svg>
          </button>
        `;
      }

      if (isSidebar && onPopOut) {
        toolbarHtml += `
          <button class="cm-toolbar-btn cm-popout-btn" title="${escapedLabels.popOut}">
            <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
            </svg>
          </button>
        `;
      }

      if (isSidebar && onToggleExpand) {
        toolbarHtml += `
          <button class="cm-toolbar-btn cm-expand-btn" title="${isExpanded ? escapedLabels.collapse : escapedLabels.expand}">
            <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              ${expandIcon}
            </svg>
          </button>
        `;
      }

      toolbarHtml += '</div>';
      toolbarHtml += '</div>';

      dom.innerHTML = toolbarHtml;

      if (hasDiff) {
        const previousButton = dom.querySelector<HTMLButtonElement>('.cm-diff-nav-prev');
        const nextButton = dom.querySelector<HTMLButtonElement>('.cm-diff-nav-next');

        previousButton?.addEventListener('click', () => {
          if (chunks.length === 0) {
            return;
          }

          currentIndex = currentIndex > 0 ? currentIndex - 1 : chunks.length - 1;
          const chunk = chunks[currentIndex];

          if (chunk) {
            view.dispatch({
              effects: EditorView.scrollIntoView(chunk.fromB, { y: 'center' }),
            });
          }

          updatePanel();
        });

        nextButton?.addEventListener('click', () => {
          if (chunks.length === 0) {
            return;
          }

          currentIndex = currentIndex < chunks.length - 1 ? currentIndex + 1 : 0;
          const chunk = chunks[currentIndex];

          if (chunk) {
            view.dispatch({
              effects: EditorView.scrollIntoView(chunk.fromB, { y: 'center' }),
            });
          }

          updatePanel();
        });
      }

      const toggleDiffButton = dom.querySelector<HTMLButtonElement>('.cm-toggle-diff-btn');
      toggleDiffButton?.addEventListener('click', onToggleDiff);

      const popOutButton = dom.querySelector<HTMLButtonElement>('.cm-popout-btn');
      popOutButton?.addEventListener('click', () => {
        onPopOut?.();
      });

      const expandButton = dom.querySelector<HTMLButtonElement>('.cm-expand-btn');
      expandButton?.addEventListener('click', () => {
        onToggleExpand?.();
      });
    };

    updatePanel();

    return {
      top: true,
      dom,
      update: updatePanel,
    };
  };

  return [showPanel.of(createPanel)];
};
