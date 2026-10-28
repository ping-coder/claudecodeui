import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

const readWholePixels = (width: number): number => width;

/**
 * The rendered width of the element `ref` points at, in whole pixels (0 until it is measured), or what
 * `select` makes of it. Measured synchronously in a layout effect, so the first paint already uses the
 * real width (no frame with the wrong layout), then kept current with a ResizeObserver. The state only
 * changes when the selected value does: a pane that only needs to know whether it is narrower than a
 * threshold does not re-render on every pixel of a divider drag. A width of 0 (display: none) changes
 * nothing: the value of the last real width stands while the element is hidden. `selectKey` stands for
 * anything else `select` reads (a pane's view count) and for whether the element is shown: when it
 * changes, the width is measured and selected again before paint. Left to the ResizeObserver, an element
 * coming into view would first paint with its hidden value: the observer's update renders a frame late.
 * Attach the ref to an element that stays mounted. Used by project-workspace's ProjectWorkspaceShell
 * (whether two panes fit) and WorkspacePane (where its view bar goes and which views it labels), and
 * by file-tree's FileTree (which detailed columns fit).
 */
export function useElementWidth<T = number>(
  ref: RefObject<HTMLElement | null>,
  select: (width: number) => T = readWholePixels as (width: number) => T,
  selectKey?: unknown,
): T {
  // The selector of the latest render, read by the observer, so a new function identity does not re-observe.
  const selectRef = useRef(select);
  useLayoutEffect(() => {
    selectRef.current = select;
  });
  // The selected value of the last measurement; what decides split capability and a pane's view bar.
  const [value, setValue] = useState<T>(() => select(0));

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return undefined;
    }

    const measure = () => {
      const width = Math.round(element.getBoundingClientRect().width);
      // Hidden: no re-render for a layout nobody sees, and the element shows again as it was.
      if (width === 0) {
        return;
      }
      const nextValue = selectRef.current(width);
      setValue((previous) => (Object.is(previous, nextValue) ? previous : nextValue));
    };
    measure();

    // jsdom and very old browsers have no ResizeObserver: the first measurement stands.
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, selectKey]);

  return value;
}
