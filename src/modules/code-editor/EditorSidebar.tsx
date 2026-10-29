import { useCallback, useState, useEffect, useRef } from 'react';
import type { MouseEvent, MutableRefObject } from 'react';

import type { CodeEditorFile } from '@/shared/types';
import { useWorkspacePane } from '@/shared/context/WorkspacePaneContext';
import {
  EDITOR_DIVIDER_WIDTH_PX,
  EDITOR_PANEL_MIN_WIDTH_PX,
  EDITOR_SIDE_CONTENT_MIN_WIDTH_PX,
  FILES_TREE_RATIO_DEFAULT,
} from '@/shared/constants';
import CodeEditor from '@/modules/code-editor/CodeEditor';
import FilesTreeDivider from '@/modules/code-editor/FilesTreeDivider';

type EditorSidebarProps = {
  editingFile: CodeEditorFile | null;
  isMobile: boolean;
  editorExpanded: boolean;
  editorWidth: number;
  resizeHandleRef: MutableRefObject<HTMLDivElement | null>;
  onResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  onCloseEditor: () => void;
  onToggleEditorExpand: () => void;
  // Forwarded to CodeEditor so useEditorSidebar can refuse to swap a dirty
  // buffer for another file without asking.
  onUnsavedChangesChange?: (hasUnsavedChanges: boolean) => void;
  projectPath?: string;
  fillSpace?: boolean;
};

// The narrowest docked editor box: the editor and the divider in front of it.
const MIN_DOCKED_WIDTH = EDITOR_PANEL_MIN_WIDTH_PX + EDITOR_DIVIDER_WIDTH_PX;

/**
 * The docked editor's box in the Files view: what the tree's share leaves, kept between both minimums.
 * A definite basis, so nothing the editor shows (a long line, a long path, a wide image) sizes it.
 */
const FILES_EDITOR_FLEX = `0 0 clamp(${MIN_DOCKED_WIDTH}px, calc((1 - var(--files-tree-ratio, ${FILES_TREE_RATIO_DEFAULT})) * 100%), calc(100% - ${EDITOR_SIDE_CONTENT_MIN_WIDTH_PX}px))`;

/** Used by the project-workspace module to dock the code editor beside a pane's content, with drag-to-resize; an editor that does not fit pops out, or fills its pane when that pane sits beside another. */
export default function EditorSidebar({
  editingFile,
  isMobile,
  editorExpanded,
  editorWidth,
  resizeHandleRef,
  onResizeStart,
  onCloseEditor,
  onToggleEditorExpand,
  onUnsavedChangesChange,
  projectPath,
  fillSpace,
}: EditorSidebarProps) {
  const [poppedOut, setPoppedOut] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Only the ceiling is state; the applied width is derived below. Holding a
  // second copy of the width meant every drag frame rendered twice, and keeping
  // `editorWidth` in this effect's dependencies rebuilt the ResizeObserver on
  // every one of those frames.
  const [maxEditorWidth, setMaxEditorWidth] = useState<number | null>(null);
  // Side by side with another pane, a floating editor would cover both panes.
  const { isSplitPane } = useWorkspacePane();
  // Set once a split pane too narrow to dock the editor has expanded it in place
  // (or found it expanded). The expand prop only toggles, and several
  // measurements (this effect, the observer's first callback, a resize,
  // StrictMode's re-run) can land before `editorExpanded` comes back; a second
  // toggle would undo the first. It also leaves a user who collapses the editor
  // in that pane alone. Cleared once the pane has room again and on close.
  const narrowPaneExpandedRef = useRef(false);

  // Track how much room the container can spare so the left content keeps at
  // least EDITOR_SIDE_CONTENT_MIN_WIDTH_PX as the window resizes.
  useEffect(() => {
    if (!editingFile) {
      // The next file opened in a narrow pane is expanded again.
      narrowPaneExpandedRef.current = false;
      return;
    }
    if (isMobile || poppedOut) return;

    const updateAvailableWidth = () => {
      if (!containerRef.current) return;
      const parentElement = containerRef.current.parentElement;
      if (!parentElement) return;

      // A pane hidden while the split is collapsed measures 0, and popping out
      // from there would cover the pane that is showing. The observer reports
      // the real width once the pane is shown again.
      if (parentElement.clientWidth === 0) return;

      const availableWidth = parentElement.clientWidth - EDITOR_SIDE_CONTENT_MIN_WIDTH_PX;

      // The divider counts: CSS keeps the docked box at MIN_DOCKED_WIDTH, so a narrower
      // remainder would push the row past the pane.
      if (availableWidth < MIN_DOCKED_WIDTH) {
        if (isSplitPane) {
          // Fill this pane instead of popping out over both.
          if (!narrowPaneExpandedRef.current) {
            narrowPaneExpandedRef.current = true;
            if (!editorExpanded) onToggleEditorExpand();
          }
          return;
        }
        // Not enough space - pop out the editor so user can still see everything
        setPoppedOut(true);
        return;
      }

      narrowPaneExpandedRef.current = false;
      setMaxEditorWidth(availableWidth);
    };

    updateAvailableWidth();
    window.addEventListener('resize', updateAvailableWidth);

    // Also use ResizeObserver for more accurate detection
    const resizeObserver = new ResizeObserver(updateAvailableWidth);
    const parentEl = containerRef.current?.parentElement;
    if (parentEl) {
      resizeObserver.observe(parentEl);
    }

    return () => {
      window.removeEventListener('resize', updateAvailableWidth);
      resizeObserver.disconnect();
    };
  }, [editingFile, editorExpanded, isMobile, isSplitPane, onToggleEditorExpand, poppedOut]);

  const effectiveWidth = maxEditorWidth === null
    ? editorWidth
    : Math.min(editorWidth, maxEditorWidth);

  // Closing always leaves the floating layout behind so the next file opens
  // docked again; stable identities keep the editor's keyboard shortcuts and
  // toolbar extension from being rebuilt on every render.
  const handleClose = useCallback(() => {
    setPoppedOut(false);
    onCloseEditor();
  }, [onCloseEditor]);

  const handlePopOut = useCallback(() => setPoppedOut(true), []);

  if (!editingFile) {
    return null;
  }

  // One CodeEditor element in one position for every layout; only the wrappers
  // change, so switching layouts never remounts it and drops the buffer.
  const isFloating = isMobile || poppedOut;

  // The Files view splits the pane by the tree's share; every other view docks the editor at its own width.
  const isFilesSplit = Boolean(fillSpace) && !editorExpanded && !isFloating;
  const useFlexLayout = editorExpanded || isFilesSplit;

  // The resize handle sits in a fixed child slot, so dropping it never shifts
  // the editor's position and remounts it. `contents` makes the wrappers give
  // up their own boxes while the floating editor covers the viewport by itself.
  return (
    <div
      ref={containerRef}
      className={isFloating ? 'contents' : `flex h-full min-w-0 ${editorExpanded ? 'flex-1' : ''}`}
      style={isFilesSplit ? { flex: FILES_EDITOR_FLEX } : undefined}
    >
      {isFilesSplit ? <FilesTreeDivider /> : !isFloating && !editorExpanded && (
        <div
          ref={resizeHandleRef}
          onMouseDown={onResizeStart}
          className="group relative w-1 flex-shrink-0 cursor-col-resize bg-gray-200 transition-colors hover:bg-blue-500 dark:bg-gray-700 dark:hover:bg-blue-600"
          title="Drag to resize"
        >
          <div className="absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 bg-blue-500 opacity-0 transition-opacity group-hover:opacity-100 dark:bg-blue-600" />
        </div>
      )}

      <div
        className={isFloating
          ? 'contents'
          : `h-full overflow-hidden border-s border-gray-200 dark:border-gray-700 ${useFlexLayout ? 'min-w-0 flex-1' : ''}`}
        style={isFloating || useFlexLayout ? undefined : { width: `${effectiveWidth}px`, minWidth: `${EDITOR_PANEL_MIN_WIDTH_PX}px` }}
      >
        <CodeEditor
          file={editingFile}
          onClose={handleClose}
          onUnsavedChangesChange={onUnsavedChangesChange}
          projectPath={projectPath}
          isSidebar={!isFloating}
          isExpanded={!isFloating && editorExpanded}
          onToggleExpand={isFloating ? null : onToggleEditorExpand}
          onPopOut={isFloating ? null : handlePopOut}
        />
      </div>
    </div>
  );
}
