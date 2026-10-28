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
 * `select` also gets the height, in whole pixels, and the value it selected last (undefined for the
 * initial value, which it gets with a width and height of 0), for an answer with hysteresis: one that
 * stays as it is between two thresholds. Attach the ref to an element that stays mounted. Used by
 * project-workspace's ProjectWorkspaceShell (whether two panes fit) and WorkspacePane (where its view bar
 * goes and which views it labels), by file-tree's FileTree (which detailed columns fit), and by chat's
 * ChatInterface (whether the chat column has room for the pinned question) and PinnedQuestionBar (which
 * of its parts fit).
 */
export function useElementWidth<T = number>(
  ref: RefObject<HTMLElement | null>,
  select: (width: number, height: number, previous: T | undefined) => T = readWholePixels as (width: number) => T,
  selectKey?: unknown,
): T {
  // The selector of the latest render, read by the observer, so a new function identity does not re-observe.
  const selectRef = useRef(select);
  useLayoutEffect(() => {
    selectRef.current = select;
  });
  // The selected value of the last measurement; what decides split capability and a pane's view bar.
  const [value, setValue] = useState<T>(() => select(0, 0, undefined));

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return undefined;
    }

    const measure = () => {
      const rect = element.getBoundingClientRect();
      const width = Math.round(rect.width);
      // Hidden: no re-render for a layout nobody sees, and the element shows again as it was.
      if (width === 0) {
        return;
      }
      const height = Math.round(rect.height);
      // Selected in the updater, so `previous` is the value this one replaces, however many
      // measurements are waiting to be rendered.
      setValue((previous) => {
        const nextValue = selectRef.current(width, height, previous);
        return Object.is(previous, nextValue) ? previous : nextValue;
      });
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
