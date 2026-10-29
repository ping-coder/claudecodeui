import { useCallback, useEffect, useState } from 'react';
import type { RefObject } from 'react';

import { isRtl } from '@/shared/direction';

/** Mouse wheels that report whole lines scroll this many pixels per line. */
const WHEEL_LINE_HEIGHT_PX = 20;
/** Slack before an edge counts as reached, so sub-pixel scroll positions do not leave a fade showing. */
const EDGE_TOLERANCE_PX = 2;

/**
 * How far the strip is scrolled from its left edge, 0..max in both directions. Right to left,
 * scrollLeft runs from 0 (scrolled to the start, which is the right edge) down to -max.
 */
const offsetFromLeft = (element: HTMLElement): number => {
  const max = element.scrollWidth - element.clientWidth;
  return isRtl(element) ? element.scrollLeft + max : element.scrollLeft;
};

/**
 * A horizontally scrolling strip of tabs: a vertical mouse wheel scrolls it sideways (until an
 * edge, so the page can scroll on), the edge fades follow the scroll position and size, and
 * the selected tab (`[role="tab"][aria-selected="true"]`) is scrolled into view whenever
 * `revealKey` changes. Used by WorkspaceHeader (the phone's view tabs), PaneViewBar (a desktop
 * pane's view tabs) and PaneTabBar (session tabs).
 */
export function useHorizontalWheelScroll(scrollRef: RefObject<HTMLElement | null>, revealKey: unknown) {
  // Whether content is hidden past each edge; drives the fades, the scroll buttons and the tab list menu.
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    // Physical sides: the fades and scroll buttons stay at the left and right edges in both directions.
    const offset = offsetFromLeft(element);
    setCanScrollLeft(offset > EDGE_TOLERANCE_PX);
    setCanScrollRight(offset < element.scrollWidth - element.clientWidth - EDGE_TOLERANCE_PX);
  }, [scrollRef]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return undefined;
    }
    updateScrollState();

    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    // The strip and its content both resize independently (window resize, tabs added or renamed).
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(element);
    if (element.firstElementChild) {
      observer.observe(element.firstElementChild);
    }
    return () => observer.disconnect();
  }, [scrollRef, updateScrollState]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return undefined;
    }

    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
        return;
      }

      // Wheeling down moves towards the end of the strip: rightwards, or leftwards right to left.
      const maxScrollLeft = element.scrollWidth - element.clientWidth;
      const fromStart = Math.abs(element.scrollLeft);
      const canMove = event.deltaY < 0 ? fromStart > 0 : fromStart < maxScrollLeft;
      if (!canMove) {
        return;
      }

      event.preventDefault();
      const lineMultiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE_HEIGHT_PX : 1;
      const towardsEnd = isRtl(element) ? -1 : 1;
      element.scrollBy({ left: event.deltaY * lineMultiplier * towardsEnd, behavior: 'auto' });
    };

    // Not passive: preventDefault keeps the page from scrolling while the strip takes the wheel.
    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, [scrollRef]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const selectedTab = scrollRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      selectedTab?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      updateScrollState();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [revealKey, scrollRef, updateScrollState]);

  /** Scrolls about two thirds of the visible width towards one edge. */
  const scrollByPage = useCallback((direction: -1 | 1) => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    element.scrollBy({ left: direction * Math.max(180, element.clientWidth * 0.65), behavior: 'smooth' });
  }, [scrollRef]);

  return { canScrollLeft, canScrollRight, updateScrollState, scrollByPage };
}
