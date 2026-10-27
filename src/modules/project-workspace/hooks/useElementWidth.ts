import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

const readWholePixels = (width: number): number => width;

/**
 * The rendered width of the element `ref` points at, in whole pixels (0 until it is measured), or what
 * `select` makes of it. Measured synchronously in a layout effect, so the first paint already uses the
 * real width (no frame with the wrong layout), then kept current with a ResizeObserver. The state only
 * changes when the selected value does: a pane that only needs to know whether it is narrower than a
 * threshold does not re-render on every pixel of a divider drag. Attach the ref to an element that stays
 * mounted. Used by ProjectWorkspaceShell (whether two panes fit) and by each workspace pane (compact header).
 */
export function useElementWidth<T = number>(
  ref: RefObject<HTMLElement | null>,
  select: (width: number) => T = readWholePixels as (width: number) => T,
): T {
  // The selector of the latest render, read by the observer, so a new function identity does not re-observe.
  const selectRef = useRef(select);
  useLayoutEffect(() => {
    selectRef.current = select;
  });
  // The selected value of the last measurement; what decides split capability and compact pane chrome.
  const [value, setValue] = useState<T>(() => select(0));

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return undefined;
    }

    const measure = () => {
      const nextValue = selectRef.current(Math.round(element.getBoundingClientRect().width));
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
  }, [ref]);

  return value;
}
