import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  TouchEvent as ReactTouchEvent,
} from 'react';
import { useTranslation } from 'react-i18next';

import { useProjectSidebarState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { useWorkspaceChrome } from '@/modules/project-workspace/context/WorkspaceChromeContext';
import { Sidebar } from '@/modules/sidebar';
import { ESCAPE_LAYER_SELECTOR } from '@/shared/constants';
import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import {
  SIDEBAR_WIDTH_KEYBOARD_STEP,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  useSidebarWidth,
} from '@/shared/hooks/useSidebarWidth';
import type {
  Project,
  ProjectSession,
  ProjectWorkspaceShellProps,
  SessionOpenOptions,
  SidebarPaneTargeting,
  WorkspacePaneSide,
} from '@/shared/types';
import { cn, hasSessionDragPayload } from '@/shared/utils';

/**
 * How long the drawer stays out after a click in it opens a preview: the click may be the first
 * half of a double-click, whose second click and dblclick must still land on the row to keep the
 * tab. The common default double-click time of the desktop platforms.
 */
const DRAWER_DOUBLE_CLICK_GRACE_MS = 500;

/** What a click in the drawer lands on: a row's link, a search hit or any other button. */
const DRAWER_CLICK_TARGET_SELECTOR = 'a, button';

/** Candidates for the drawer's Tab stops, narrowed by `isTabStop`. */
const TAB_STOP_CANDIDATE_SELECTOR = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';

/** Reachable with Tab: in the tab order, enabled and rendered (not inside a display:none subtree, not visibility:hidden). */
const isTabStop = (element: HTMLElement): boolean => (
  element.tabIndex >= 0
  && !element.matches(':disabled')
  && element.getClientRects().length > 0
  && window.getComputedStyle(element).visibility !== 'hidden'
);

/** The first and last Tab stops inside the drawer, so Tab and Shift+Tab can wrap around in it. */
const findTabStopEdges = (container: HTMLElement): { first: HTMLElement | null; last: HTMLElement | null } => {
  const candidates = Array.from(container.querySelectorAll<HTMLElement>(TAB_STOP_CANDIDATE_SELECTOR));
  const first = candidates.find(isTabStop) ?? null;
  let last: HTMLElement | null = null;
  for (let index = candidates.length - 1; index >= 0 && !last; index -= 1) {
    if (isTabStop(candidates[index])) {
      last = candidates[index];
    }
  }
  return { first, last };
};

/**
 * A text field gets the first say over an Escape typed into it: the drawer's inline renames cancel
 * on it, and so may a field in a dialog opened from the drawer (portaled outside it).
 */
const isTextEntryTarget = (target: EventTarget | null): boolean => (
  target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'))
);

/** Rendered by ProjectWorkspaceShell to host the sidebar module: docked on desktop (hidden, or out as a drawer, while immersive) and a drawer on mobile. */
function ProjectSidebarRegion({
  isMobile,
}: Pick<ProjectWorkspaceShellProps, 'isMobile'>) {
  const { t } = useTranslation('common');
  const { sidebarOpen, setSidebarOpen, sidebarSharedProps, paneTargetingBase, focusedTabKey } = useProjectSidebarState();
  const { onSessionSelect, onNewSession } = sidebarSharedProps;
  const { isImmersive, isSidebarPeekOpen, setSidebarPeekOpen, canSplit } = useWorkspaceChrome();
  const { width: sidebarWidth, setWidth: setSidebarWidth, resetWidth: resetSidebarWidth } = useSidebarWidth();
  // Hide sidebar leaves a 48px icon rail behind, which sizes itself — the stored
  // width and the drag handle only apply while the full sidebar is on screen.
  // Immersive mode takes the docked sidebar away, its drag handle with it.
  const { sidebarVisible } = useUiPreferences();
  const isSidebarResizable = !isMobile && sidebarVisible && !isImmersive;
  // Desktop immersive shows the sidebar only as an overlay drawer, full width even when collapsed to the rail.
  const isPeekOpen = !isMobile && isImmersive && isSidebarPeekOpen;
  // Read by the open callbacks handed to the sidebar, which keep one identity while the drawer comes and goes.
  const isPeekOpenRef = useRef(isPeekOpen);
  useLayoutEffect(() => {
    isPeekOpenRef.current = isPeekOpen;
  }, [isPeekOpen]);
  // Drag origin; null while no resize is in progress.
  const resizeOriginRef = useRef<{ pointerX: number; width: number } | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const pendingWidthRef = useRef<number>(sidebarWidth);
  // The sidebar's container, so the drawer's own Escape-layer marker is not taken for another layer's.
  const peekContainerRef = useRef<HTMLDivElement | null>(null);
  // Set while a conversation is dragged out of the drawer: the overlay then lets the drag through
  // to the panes underneath, where the workspace's drop zones are. Cleared when the drag ends.
  const [isDraggingSessionOut, setIsDraggingSessionOut] = useState(false);
  if (isDraggingSessionOut && !isPeekOpen) {
    // Adjusting state while rendering: a drag whose dragend never came (its row went away) must
    // not leave the next drawer's overlay letting clicks through.
    setIsDraggingSessionOut(false);
  }

  const { onFocusSide: focusPane, focusedSide, isSplit } = paneTargetingBase;
  // The side the sidebar's Open-in switch just moved the focus to. That switch opens nothing,
  // so the focused-tab change it causes must not close the drawer before the click that follows.
  const sidebarFocusSwitchRef = useRef<WorkspacePaneSide | null>(null);
  const handleFocusSide = useCallback((side: WorkspacePaneSide) => {
    sidebarFocusSwitchRef.current = side;
    focusPane(side);
  }, [focusPane]);

  // Rows offer sides wherever two panes can stand side by side, or already do.
  const canTargetSides = !isMobile && (canSplit || isSplit);
  const paneTargeting = useMemo<SidebarPaneTargeting>(() => ({
    ...paneTargetingBase,
    onFocusSide: handleFocusSide,
    canTargetSides,
  }), [canTargetSides, handleFocusSide, paneTargetingBase]);

  // A close the drawer has put off for a double-click: the row link or button whose click opened a
  // preview, and the timer (null while a press on that row holds the close).
  const pendingCloseRef = useRef<{ target: Element | null; timer: number | null } | null>(null);

  const cancelPendingClose = useCallback(() => {
    const pendingClose = pendingCloseRef.current;
    if (pendingClose && pendingClose.timer !== null) {
      window.clearTimeout(pendingClose.timer);
    }
    pendingCloseRef.current = null;
  }, []);

  const closePeek = useCallback(() => {
    cancelPendingClose();
    setSidebarPeekOpen(false);
  }, [cancelPendingClose, setSidebarPeekOpen]);

  const startPendingCloseTimer = useCallback(() => {
    const pendingClose = pendingCloseRef.current;
    if (!pendingClose) return;
    if (pendingClose.timer !== null) {
      window.clearTimeout(pendingClose.timer);
    }
    pendingClose.timer = window.setTimeout(() => {
      pendingCloseRef.current = null;
      setSidebarPeekOpen(false);
    }, DRAWER_DOUBLE_CLICK_GRACE_MS);
  }, [setSidebarPeekOpen]);

  // The click inside the drawer being handled right now: whether a pointer made it (Enter on a
  // link clicks with detail 0) and the row link or button it landed on.
  const drawerClickRef = useRef<{ isPointer: boolean; target: Element | null } | null>(null);

  const handleDrawerClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    drawerClickRef.current = {
      isPointer: event.detail > 0,
      target: event.target instanceof Element ? event.target.closest(DRAWER_CLICK_TARGET_SELECTOR) : null,
    };
  }, []);

  // Bubbled back up: the click has been handled, so no later open takes it for its own.
  const handleDrawerClick = useCallback(() => {
    drawerClickRef.current = null;
  }, []);

  // While a close waits on a double-click, a press on the same row (the second click, or the start
  // of a drag) holds it until release, and a press anywhere else in the drawer cancels it: the
  // user is still browsing.
  const handleDrawerPointerDownCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pendingClose = pendingCloseRef.current;
    if (!pendingClose) return;
    const pressed = event.target instanceof Element ? event.target.closest(DRAWER_CLICK_TARGET_SELECTOR) : null;
    if (pressed === null || pressed !== pendingClose.target) {
      cancelPendingClose();
      return;
    }
    if (pendingClose.timer !== null) {
      window.clearTimeout(pendingClose.timer);
      pendingClose.timer = null;
    }
  }, [cancelPendingClose]);

  const handleDrawerPointerUpCapture = useCallback(() => {
    if (pendingCloseRef.current?.timer === null) {
      startPendingCloseTimer();
    }
  }, [startPendingCloseTimer]);

  // Opening a conversation from the drawer closes it, whether or not the focused tab changes (the
  // conversation may be on screen already). A preview opened by a click waits out a double-click,
  // so the double-click's second half still reaches the row and keeps the tab.
  const handleSessionSelect = useCallback((session: ProjectSession, options?: SessionOpenOptions) => {
    const click = drawerClickRef.current;
    drawerClickRef.current = null;
    onSessionSelect(session, options);
    if (!isPeekOpenRef.current) return;
    if (options?.preview && click?.isPointer) {
      cancelPendingClose();
      pendingCloseRef.current = { target: click.target, timer: null };
      startPendingCloseTimer();
      return;
    }
    closePeek();
  }, [cancelPendingClose, closePeek, onSessionSelect, startPendingCloseTimer]);

  const handleNewSession = useCallback((project: Project, options?: SessionOpenOptions) => {
    drawerClickRef.current = null;
    onNewSession(project, options);
    if (isPeekOpenRef.current) {
      closePeek();
    }
  }, [closePeek, onNewSession]);

  // A conversation dragged out of the drawer: the overlay steps aside for the drag, and a drop that
  // took it (it opened somewhere) closes the drawer like any other open from it.
  const handleDrawerDragStart = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isPeekOpenRef.current || !hasSessionDragPayload(event.dataTransfer)) return;
    cancelPendingClose();
    setIsDraggingSessionOut(true);
  }, [cancelPendingClose]);

  const handleDrawerDragEnd = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isDraggingSessionOut) return;
    setIsDraggingSessionOut(false);
    if (isPeekOpenRef.current && event.dataTransfer && event.dataTransfer.dropEffect !== 'none') {
      closePeek();
    }
  }, [closePeek, isDraggingSessionOut]);

  // Tab and Shift+Tab wrap around inside the drawer instead of walking into the panes it covers.
  // Focus in a menu or dialog opened from it (portaled elsewhere) is left for that layer to move.
  const handleDrawerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const container = peekContainerRef.current;
    if (event.key !== 'Tab' || event.defaultPrevented || !isPeekOpenRef.current || !container) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !container.contains(active)) return;
    const { first, last } = findTabStopEdges(container);
    if (!first || !last) return;
    if (event.shiftKey && (active === first || active === container)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  const handleBackdropClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setSidebarOpen(false);
  }, [setSidebarOpen]);

  const handleBackdropTouch = useCallback((event: ReactTouchEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setSidebarOpen(false);
  }, [setSidebarOpen]);

  // Sidebar resizing (desktop only). Pointer capture keeps the drag alive when
  // the cursor leaves the 4px handle, and the width is only written to storage
  // once the pointer is released.
  const handleResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeOriginRef.current = { pointerX: event.clientX, width: sidebarWidth };
    pendingWidthRef.current = sidebarWidth;
    document.body.style.userSelect = 'none';
  }, [sidebarWidth]);

  const handleResizeMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = resizeOriginRef.current;
    if (!origin) return;

    pendingWidthRef.current = origin.width + (event.clientX - origin.pointerX);
    if (resizeFrameRef.current !== null) return;
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      setSidebarWidth(pendingWidthRef.current, false);
    });
  }, [setSidebarWidth]);

  const handleResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeOriginRef.current) return;
    resizeOriginRef.current = null;

    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
    }
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.style.userSelect = '';
    setSidebarWidth(pendingWidthRef.current);
  }, [setSidebarWidth]);

  const handleResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setSidebarWidth(sidebarWidth - SIDEBAR_WIDTH_KEYBOARD_STEP);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setSidebarWidth(sidebarWidth + SIDEBAR_WIDTH_KEYBOARD_STEP);
    } else if (event.key === 'Home') {
      event.preventDefault();
      resetSidebarWidth();
    }
  }, [resetSidebarWidth, setSidebarWidth, sidebarWidth]);

  // Going mobile, collapsing or going immersive mid-drag unmounts the separator, so the
  // pointerup that would have ended the drag never arrives: the body stays unselectable, and
  // the live origin would make a plain hover resize the sidebar once it is back.
  useEffect(() => {
    if (isSidebarResizable) return;
    resizeOriginRef.current = null;
    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
    }
    document.body.style.userSelect = '';
  }, [isSidebarResizable]);

  // A drag interrupted by an unmount must not leave the page unselectable.
  useEffect(() => () => {
    if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current);
    document.body.style.userSelect = '';
  }, []);

  // The drawer owns Escape while it is out. Window capture runs before the chat's abort and the
  // editor's close, and claiming the event there (preventDefault) keeps them from firing. A menu
  // or dialog opened from the drawer is left to close first. An Escape typed into a text field
  // reaches the field before the drawer: a rename cancels on it and stops it there, and only an
  // Escape that comes back up to the window unanswered closes the drawer.
  useEffect(() => {
    if (!isPeekOpen) return undefined;
    let escapeLeftToField: KeyboardEvent | null = null;

    const handleKeyDownCapture = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      const hasOtherEscapeOwner = Array.from(document.querySelectorAll(ESCAPE_LAYER_SELECTOR))
        .some((element) => element !== peekContainerRef.current);
      if (hasOtherEscapeOwner) return;
      event.preventDefault();
      if (isTextEntryTarget(event.target)) {
        escapeLeftToField = event;
        return;
      }
      event.stopPropagation();
      closePeek();
    };

    const handleKeyDownBubble = (event: KeyboardEvent) => {
      if (event !== escapeLeftToField) return;
      escapeLeftToField = null;
      closePeek();
    };

    window.addEventListener('keydown', handleKeyDownCapture, true);
    window.addEventListener('keydown', handleKeyDownBubble);
    return () => {
      window.removeEventListener('keydown', handleKeyDownCapture, true);
      window.removeEventListener('keydown', handleKeyDownBubble);
    };
  }, [closePeek, isPeekOpen]);

  // Opens from the drawer close it themselves. A focused tab that changes for any other reason
  // (the command palette, a shortcut, the URL) closes it too, unless the Open-in switch moved the
  // focus, or a click in the drawer has already put its close off for a double-click.
  const lastFocusedTabRef = useRef({ side: focusedSide, tabKey: focusedTabKey });
  useEffect(() => {
    const previous = lastFocusedTabRef.current;
    lastFocusedTabRef.current = { side: focusedSide, tabKey: focusedTabKey };
    const sideChanged = previous.side !== focusedSide;
    const isSidebarFocusSwitch = sideChanged && sidebarFocusSwitchRef.current === focusedSide;
    if (sideChanged) {
      sidebarFocusSwitchRef.current = null;
    }
    if (previous.tabKey !== focusedTabKey && !isSidebarFocusSwitch && isPeekOpen && !pendingCloseRef.current) {
      closePeek();
    }
  }, [closePeek, focusedSide, focusedTabKey, isPeekOpen]);

  // Whatever closed the drawer (leaving immersive mode does too), a close it put off may not
  // outlive it.
  useEffect(() => {
    if (!isPeekOpen) {
      cancelPendingClose();
    }
  }, [cancelPendingClose, isPeekOpen]);
  useEffect(() => cancelPendingClose, [cancelPendingClose]);

  // Focus follows the drawer: in when it opens, so Tab walks the sidebar and not the panes it
  // covers, and back to where it came from (the "Show sidebar" button) when it closes. Only focus
  // the closed drawer dropped is handed back: focus that moved on (into a pane, a dialog) stays.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasPeekOpenRef = useRef(false);
  useEffect(() => {
    const container = peekContainerRef.current;
    const wasPeekOpen = wasPeekOpenRef.current;
    wasPeekOpenRef.current = isPeekOpen;
    if (!container || isPeekOpen === wasPeekOpen) return;

    if (isPeekOpen) {
      const previous = document.activeElement;
      returnFocusRef.current = previous instanceof HTMLElement && previous !== document.body && !container.contains(previous)
        ? previous
        : null;
      container.focus({ preventScroll: true });
      return;
    }

    const returnTo = returnFocusRef.current;
    returnFocusRef.current = null;
    const active = document.activeElement;
    // Leaving immersive mode docks the sidebar, where focus inside it is still on screen.
    const isFocusDropped = !active || active === document.body || (isImmersive && container.contains(active));
    if (isFocusDropped && returnTo?.isConnected) {
      returnTo.focus({ preventScroll: true });
    }
  }, [isImmersive, isPeekOpen]);

  if (!isMobile) {
    return (
      <>
        {/* One container whose classes follow the mode, so switching docked, hidden and drawer never remounts the Sidebar. */}
        <div
          ref={peekContainerRef}
          className={cn(
            'h-full border-r border-border/50',
            isPeekOpen
              ? 'fixed inset-y-0 left-0 z-40 bg-background shadow-xl outline-none'
              : 'relative flex-shrink-0',
            // Hidden, not unmounted: Settings, the delete confirmations and the version modal live in it.
            isImmersive && !isPeekOpen && 'hidden',
          )}
          style={isPeekOpen || isSidebarResizable ? { width: sidebarWidth } : undefined}
          // A dialog while it is the drawer, focused when it opens. Not aria-modal: that would make it
          // a layer that the app's other shortcuts step aside for, and it only owns Escape.
          role={isPeekOpen ? 'dialog' : undefined}
          aria-label={isPeekOpen ? t('workspace.sidebarDrawer', { defaultValue: 'Sidebar' }) : undefined}
          tabIndex={isPeekOpen ? -1 : undefined}
          // Marks the drawer as the Escape owner for the app's other key handlers. Dropped while
          // Settings is open over it, because Settings only takes Escape when no such layer exists.
          data-escape-layer={isPeekOpen && !sidebarSharedProps.showSettings ? '' : undefined}
          onClickCapture={handleDrawerClickCapture}
          onClick={handleDrawerClick}
          onPointerDownCapture={handleDrawerPointerDownCapture}
          onPointerUpCapture={handleDrawerPointerUpCapture}
          onDragStart={handleDrawerDragStart}
          onDragEnd={handleDrawerDragEnd}
          onKeyDown={handleDrawerKeyDown}
        >
          <Sidebar
            {...sidebarSharedProps}
            onSessionSelect={handleSessionSelect}
            onNewSession={handleNewSession}
            paneTargeting={paneTargeting}
            forceExpanded={isPeekOpen}
          />
          {isSidebarResizable && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('versionUpdate.ariaLabels.resizeSidebar')}
              aria-valuenow={sidebarWidth}
              aria-valuemin={SIDEBAR_WIDTH_MIN}
              aria-valuemax={SIDEBAR_WIDTH_MAX}
              tabIndex={0}
              className="absolute inset-y-0 -right-0.5 z-10 w-1 cursor-col-resize hover:bg-primary/40 focus-visible:bg-primary/60 focus-visible:outline-none"
              onPointerDown={handleResizeStart}
              onPointerMove={handleResizeMove}
              onPointerUp={handleResizeEnd}
              onPointerCancel={handleResizeEnd}
              onDoubleClick={resetSidebarWidth}
              onKeyDown={handleResizeKeyDown}
            />
          )}
        </div>
        {isPeekOpen && (
          <button
            type="button"
            // Out of the way of a conversation dragged from the drawer, so the drag reaches the panes.
            className={cn('fixed inset-0 z-30 bg-background/40', isDraggingSessionOut && 'pointer-events-none')}
            onClick={closePeek}
            aria-label={t('versionUpdate.ariaLabels.closeSidebar')}
          />
        )}
      </>
    );
  }

  return (
    <div
      className={`fixed inset-0 z-50 flex transition-all duration-150 ease-out ${
        sidebarOpen ? 'visible opacity-100' : 'invisible opacity-0'
      }`}
    >
      <button
        className="fixed inset-0 bg-background/60 backdrop-blur-sm transition-opacity duration-150 ease-out"
        onClick={handleBackdropClick}
        onTouchStart={handleBackdropTouch}
        aria-label={t('versionUpdate.ariaLabels.closeSidebar')}
      />
      <div
        className={`relative h-full w-[85vw] max-w-sm transform border-r border-border/40 bg-card transition-transform duration-150 ease-out sm:w-80 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        onClick={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
      >
        <Sidebar {...sidebarSharedProps} paneTargeting={paneTargeting} />
      </div>
    </div>
  );
}

export default memo(ProjectSidebarRegion);
