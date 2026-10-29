import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';

import { useFilesTreeRatio } from '@/modules/code-editor/hooks/useFilesTreeRatio';
import {
  EDITOR_DIVIDER_WIDTH_PX,
  EDITOR_PANEL_MIN_WIDTH_PX,
  EDITOR_SIDE_CONTENT_MIN_WIDTH_PX,
  FILES_TREE_RATIO_DEFAULT,
} from '@/shared/constants';
import { forwardArrowKey, inlineSign } from '@/shared/direction';

/** One arrow key press moves the divider by this share of the pane. */
const KEYBOARD_RATIO_STEP = 0.04;

/** Lowest and highest tree share that leave both pixel minimums in a row `rowWidth` wide. */
const getRatioBounds = (rowWidth: number): { min: number; max: number } => {
  if (rowWidth <= 0) {
    return { min: 0, max: 1 };
  }
  return {
    min: EDITOR_SIDE_CONTENT_MIN_WIDTH_PX / rowWidth,
    max: 1 - (EDITOR_PANEL_MIN_WIDTH_PX + EDITOR_DIVIDER_WIDTH_PX) / rowWidth,
  };
};

/** Where CSS draws a share: kept inside both pixel minimums. Too narrow for both, the editor is not docked and any share will do. */
const clampTreeRatio = (ratio: number, rowWidth: number): number => {
  const { min, max } = getRatioBounds(rowWidth);
  return min > max ? ratio : Math.min(max, Math.max(min, ratio));
};

/**
 * Rendered by EditorSidebar as the first child of its docked box in the Files view. It writes
 * `--files-tree-ratio` on that box (its parent) and measures the pane's row (the box's parent).
 * Dragging only rewrites the variable (once per frame); the share is saved once, on release.
 * Arrow keys step it, Home and a double-click reset it. Follows project-workspace's PaneSplitter.
 */
export default function FilesTreeDivider() {
  const { t } = useTranslation('codeEditor');
  const { ratio, commitRatio } = useFilesTreeRatio();
  const separatorRef = useRef<HTMLDivElement>(null);
  // Drag origin; null while no drag is in progress.
  const dragOriginRef = useRef<{ pointerX: number; ratio: number; rowWidth: number; sign: 1 | -1 } | null>(null);
  const pendingRatioRef = useRef(ratio);
  const frameRef = useRef<number | null>(null);

  // Read off the divider rather than a ref from EditorSidebar: the divider mounts together with the
  // box, and React runs this component's layout effects before it attaches the box's ref.
  const getBox = useCallback(() => separatorRef.current?.parentElement ?? null, []);

  const writeRatio = useCallback((nextRatio: number) => {
    getBox()?.style.setProperty('--files-tree-ratio', String(nextRatio));
  }, [getBox]);

  // The committed share drives the layout until the next drag; written before paint.
  useLayoutEffect(() => {
    writeRatio(ratio);
  }, [ratio, writeRatio]);

  const measureRowWidth = useCallback(
    () => getBox()?.parentElement?.getBoundingClientRect().width ?? 0,
    [getBox],
  );

  // The row's width, kept current: a share saved in a wider pane can undercut a minimum here, where CSS
  // draws the divider further in. What the divider reports and steps from is where it is drawn.
  const [rowWidth, setRowWidth] = useState(0);
  useLayoutEffect(() => {
    const row = getBox()?.parentElement;
    if (!row) {
      return undefined;
    }
    const measure = () => setRowWidth(Math.round(row.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [getBox]);
  const drawnRatio = rowWidth > 0 ? clampTreeRatio(ratio, rowWidth) : ratio;
  const bounds = getRatioBounds(rowWidth);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    // Pointer capture keeps the drag alive when the pointer leaves the thin divider; pointer events cover touch.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const width = measureRowWidth();
    // The drag starts where the divider is drawn, so it follows the pointer from the first pixel.
    const originRatio = clampTreeRatio(ratio, width);
    // Right to left the tree is on the right and grows as the divider moves left.
    dragOriginRef.current = { pointerX: event.clientX, ratio: originRatio, rowWidth: width, sign: inlineSign(event.currentTarget) };
    pendingRatioRef.current = originRatio;
    document.body.style.userSelect = 'none';
  }, [measureRowWidth, ratio]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = dragOriginRef.current;
    if (!origin || origin.rowWidth <= 0) {
      return;
    }
    const shift = (origin.sign * (event.clientX - origin.pointerX)) / origin.rowWidth;
    pendingRatioRef.current = clampTreeRatio(origin.ratio + shift, origin.rowWidth);
    if (frameRef.current !== null) {
      return;
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      writeRatio(pendingRatioRef.current);
    });
  }, [writeRatio]);

  const handlePointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = dragOriginRef.current;
    if (!origin) {
      return;
    }
    dragOriginRef.current = null;
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.style.userSelect = '';
    // Compared with the clamped origin, not the saved share: a press without a move (half of a
    // double-click, say) saves nothing, even where the saved share is drawn clamped. The variable
    // goes back to the saved share then, in case a frame wrote a position the pointer left again.
    const moved = pendingRatioRef.current !== origin.ratio;
    writeRatio(moved ? pendingRatioRef.current : ratio);
    if (moved) {
      commitRatio(pendingRatioRef.current);
    }
  }, [commitRatio, ratio, writeRatio]);

  // Arrow keys step from where the divider is drawn and save the share they land on.
  const commitClamped = useCallback((nextRatio: number) => {
    commitRatio(clampTreeRatio(nextRatio, measureRowWidth()));
  }, [commitRatio, measureRowWidth]);

  // Saved as is, not clamped to this pane: CSS clamps where it is drawn, and a wider pane gets the default back.
  const resetRatio = useCallback(() => {
    commitRatio(FILES_TREE_RATIO_DEFAULT);
  }, [commitRatio]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    // The arrow pointing into the editor widens the tree: ArrowLeft right to left.
    const grow = forwardArrowKey(event.currentTarget);
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      commitClamped(drawnRatio + (event.key === grow ? 1 : -1) * KEYBOARD_RATIO_STEP);
    } else if (event.key === 'Home') {
      event.preventDefault();
      resetRatio();
    }
  }, [commitClamped, drawnRatio, resetRatio]);

  // A drag cut short by an unmount (the view switched, the pane narrowed) never sees its pointerup:
  // the page must not stay unselectable. Without a drag of its own the divider leaves the page alone:
  // dragging the pane splitter can narrow the pane until the editor expands and this unmounts.
  useEffect(() => () => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
    }
    if (dragOriginRef.current) {
      dragOriginRef.current = null;
      document.body.style.userSelect = '';
    }
  }, []);

  return (
    <div
      ref={separatorRef}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('resizeFileTree', { defaultValue: 'Resize file tree' })}
      aria-valuenow={Math.round(drawnRatio * 100)}
      aria-valuemin={Math.round(bounds.min * 100)}
      aria-valuemax={Math.round(bounds.max * 100)}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onDoubleClick={resetRatio}
      onKeyDown={handleKeyDown}
      // The layout width stays 4px; coarse pointers get a wider invisible hit area.
      className="group relative w-1 flex-shrink-0 cursor-col-resize touch-none bg-gray-200 transition-colors hover:bg-blue-500 focus-visible:bg-blue-500 focus-visible:outline-none dark:bg-gray-700 dark:hover:bg-blue-600 [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:inset-y-0 [@media(pointer:coarse)]:before:-end-[6px] [@media(pointer:coarse)]:before:-start-[6px] [@media(pointer:coarse)]:before:content-['']"
    />
  );
}
