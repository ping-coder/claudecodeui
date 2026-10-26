import { useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';

/**
 * The rendered width of the element `ref` points at, in whole pixels; 0 until it is measured.
 * Measured synchronously in a layout effect, so the first paint already uses the real width
 * (no frame with the wrong layout), then kept current with a ResizeObserver. Attach the ref to
 * an element that stays mounted. Used by ProjectWorkspaceShell (whether two panes fit) and by
 * each workspace pane (compact header).
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  // Last measured width; what decides split capability and compact pane chrome.
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return undefined;
    }

    const measure = () => {
      const nextWidth = Math.round(element.getBoundingClientRect().width);
      setWidth((previous) => (previous === nextWidth ? previous : nextWidth));
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

  return width;
}
