import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';

import {
  PANE_MIN_WIDTH_PX,
  PANE_SPLITTER_WIDTH_PX,
  WORKSPACE_SPLIT_RATIO_DEFAULT,
  WORKSPACE_SPLIT_RATIO_MAX,
  WORKSPACE_SPLIT_RATIO_MIN,
} from '@/shared/constants';

/** One arrow key press moves the divider by this share of the main width. */
const KEYBOARD_RATIO_STEP = 0.04;

type PaneSplitterProps = {
  /** The pane group: the divider measures it and writes `--pane-left-width` on it. */
  containerRef: RefObject<HTMLElement | null>;
  /** Committed left share of the width (WorkspaceLayout.splitRatio). */
  ratio: number;
  /** Saves a new left share: once per drag on release, and on every key press or reset. */
  onCommit: (ratio: number) => void;
};

/** The left pane's width for a share of the group's width: the share of what the divider leaves. */
const toLeftWidthValue = (ratio: number): string => `calc((100% - ${PANE_SPLITTER_WIDTH_PX}px) * ${ratio})`;

/** Keeps a share inside the ratio bounds and leaves every pane at least PANE_MIN_WIDTH_PX of `groupWidth`. */
const clampRatio = (ratio: number, groupWidth: number): number => {
  const available = groupWidth - PANE_SPLITTER_WIDTH_PX;
  let min = WORKSPACE_SPLIT_RATIO_MIN;
  let max = WORKSPACE_SPLIT_RATIO_MAX;
  if (available > 0) {
    min = Math.max(min, PANE_MIN_WIDTH_PX / available);
    max = Math.min(max, 1 - PANE_MIN_WIDTH_PX / available);
  }
  // Too narrow for both minimums: the panes collapse rather than split, so the middle is as good as any.
  if (min > max) {
    return WORKSPACE_SPLIT_RATIO_DEFAULT;
  }
  return Math.min(max, Math.max(min, ratio));
};

/**
 * Rendered by ProjectMainRegion between two side-by-side panes. Dragging only rewrites the
 * group's `--pane-left-width` CSS variable (once per animation frame), so neither pane re-renders
 * during a drag; the ratio is committed once, on release. Arrow keys step it, Home and a
 * double-click reset it to the middle. The drag handling follows ProjectSidebarRegion's divider.
 */
export default function PaneSplitter({ containerRef, ratio, onCommit }: PaneSplitterProps) {
  const { t } = useTranslation();
  const separatorRef = useRef<HTMLDivElement>(null);
  // Drag origin; null while no drag is in progress.
  const dragOriginRef = useRef<{ pointerX: number; ratio: number; groupWidth: number } | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingRatioRef = useRef(ratio);

  // When the group mounts together with the divider (a reload of a split layout), React runs this
  // component's layout effect before it attaches the group's ref; the divider's parent is the group.
  const getGroup = useCallback(
    () => containerRef.current ?? separatorRef.current?.parentElement ?? null,
    [containerRef],
  );

  const writeLeftWidth = useCallback((nextRatio: number) => {
    getGroup()?.style.setProperty('--pane-left-width', toLeftWidthValue(nextRatio));
  }, [getGroup]);

  // The committed ratio drives the layout until the next drag; written before paint so the panes never jump.
  useLayoutEffect(() => {
    writeLeftWidth(ratio);
  }, [ratio, writeLeftWidth]);

  const measureGroupWidth = useCallback(() => getGroup()?.getBoundingClientRect().width ?? 0, [getGroup]);

  // The group's width, kept current: a saved share can undercut a pane's pixel minimum on a narrower
  // column, where CSS draws the divider further in. What the divider reports and steps from is where
  // it is drawn, not the saved share.
  const [groupWidth, setGroupWidth] = useState(0);
  useLayoutEffect(() => {
    const group = getGroup();
    if (!group) {
      return undefined;
    }
    const measure = () => setGroupWidth(Math.round(group.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    return () => observer.disconnect();
  }, [getGroup]);
  const drawnRatio = groupWidth > 0 ? clampRatio(ratio, groupWidth) : ratio;

  const commit = useCallback((nextRatio: number) => {
    const clamped = clampRatio(nextRatio, measureGroupWidth());
    writeLeftWidth(clamped);
    onCommit(clamped);
  }, [measureGroupWidth, onCommit, writeLeftWidth]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    // Pointer capture keeps the drag alive when the cursor leaves the thin divider.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const width = measureGroupWidth();
    // The drag starts where the divider is drawn, so it follows the pointer from the first pixel.
    const originRatio = clampRatio(ratio, width);
    dragOriginRef.current = { pointerX: event.clientX, ratio: originRatio, groupWidth: width };
    pendingRatioRef.current = originRatio;
    document.body.style.userSelect = 'none';
  }, [measureGroupWidth, ratio]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = dragOriginRef.current;
    if (!origin) {
      return;
    }
    const available = origin.groupWidth - PANE_SPLITTER_WIDTH_PX;
    const shift = available > 0 ? (event.clientX - origin.pointerX) / available : 0;
    pendingRatioRef.current = clampRatio(origin.ratio + shift, origin.groupWidth);
    if (frameRef.current !== null) {
      return;
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      writeLeftWidth(pendingRatioRef.current);
    });
  }, [writeLeftWidth]);

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
    writeLeftWidth(pendingRatioRef.current);
    // A press without a move (half of a double-click, say) saves nothing.
    if (pendingRatioRef.current !== origin.ratio) {
      onCommit(pendingRatioRef.current);
    }
  }, [onCommit, writeLeftWidth]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      commit(drawnRatio - KEYBOARD_RATIO_STEP);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      commit(drawnRatio + KEYBOARD_RATIO_STEP);
    } else if (event.key === 'Home') {
      event.preventDefault();
      commit(WORKSPACE_SPLIT_RATIO_DEFAULT);
    }
  }, [commit, drawnRatio]);

  const handleDoubleClick = useCallback(() => {
    commit(WORKSPACE_SPLIT_RATIO_DEFAULT);
  }, [commit]);

  // A drag interrupted by an unmount (the window narrowed, the panes merged) never sees its
  // pointerup: the page must not stay unselectable.
  useEffect(() => () => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
    }
    dragOriginRef.current = null;
    document.body.style.userSelect = '';
  }, []);

  return (
    <div
      ref={separatorRef}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('workspace.resizePanes', { defaultValue: 'Resize panes' })}
      aria-valuenow={Math.round(drawnRatio * 100)}
      aria-valuemin={Math.round(WORKSPACE_SPLIT_RATIO_MIN * 100)}
      aria-valuemax={Math.round(WORKSPACE_SPLIT_RATIO_MAX * 100)}
      tabIndex={0}
      // The layout width stays PANE_SPLITTER_WIDTH_PX; coarse pointers get a wider invisible hit area and a grip.
      className="group relative z-10 flex w-1.5 flex-none cursor-col-resize touch-none justify-center bg-background focus-visible:outline-none [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:inset-y-0 [@media(pointer:coarse)]:before:-left-[5px] [@media(pointer:coarse)]:before:-right-[5px] [@media(pointer:coarse)]:before:content-['']"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
    >
      <span
        aria-hidden="true"
        className="h-full w-px bg-border/70 transition-colors group-hover:bg-primary/50 group-focus-visible:bg-primary/70"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 my-auto hidden h-8 w-1 rounded-full bg-muted-foreground/40 [@media(pointer:coarse)]:block"
      />
    </div>
  );
}
