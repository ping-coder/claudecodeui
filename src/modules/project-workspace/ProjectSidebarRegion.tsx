import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import type {
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
import type { ProjectWorkspaceShellProps, SidebarPaneTargeting, WorkspacePaneSide } from '@/shared/types';
import { cn } from '@/shared/utils';

/** Rendered by ProjectWorkspaceShell to host the sidebar module: docked on desktop (hidden, or out as a drawer, while immersive) and a drawer on mobile. */
function ProjectSidebarRegion({
  isMobile,
}: Pick<ProjectWorkspaceShellProps, 'isMobile'>) {
  const { t } = useTranslation('common');
  const { sidebarOpen, setSidebarOpen, sidebarSharedProps, paneTargetingBase, focusedTabKey } = useProjectSidebarState();
  const { isImmersive, isSidebarPeekOpen, setSidebarPeekOpen, canSplit } = useWorkspaceChrome();
  const { width: sidebarWidth, setWidth: setSidebarWidth, resetWidth: resetSidebarWidth } = useSidebarWidth();
  // Hide sidebar leaves a 48px icon rail behind, which sizes itself — the stored
  // width and the drag handle only apply while the full sidebar is on screen.
  // Immersive mode takes the docked sidebar away, its drag handle with it.
  const { sidebarVisible } = useUiPreferences();
  const isSidebarResizable = !isMobile && sidebarVisible && !isImmersive;
  // Desktop immersive shows the sidebar only as an overlay drawer, full width even when collapsed to the rail.
  const isPeekOpen = !isMobile && isImmersive && isSidebarPeekOpen;
  // Drag origin; null while no resize is in progress.
  const resizeOriginRef = useRef<{ pointerX: number; width: number } | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const pendingWidthRef = useRef<number>(sidebarWidth);
  // The sidebar's container, so the drawer's own Escape-layer marker is not taken for another layer's.
  const peekContainerRef = useRef<HTMLDivElement | null>(null);

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

  const closePeek = useCallback(() => {
    setSidebarPeekOpen(false);
  }, [setSidebarPeekOpen]);

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
  // editor's close, and stopping the event there keeps them from firing as well. A menu or dialog
  // opened from the drawer is left to close first.
  useEffect(() => {
    if (!isPeekOpen) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      const hasOtherEscapeOwner = Array.from(document.querySelectorAll(ESCAPE_LAYER_SELECTOR))
        .some((element) => element !== peekContainerRef.current);
      if (hasOtherEscapeOwner) return;
      event.preventDefault();
      event.stopPropagation();
      closePeek();
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [closePeek, isPeekOpen]);

  // A conversation opened (or a tab switched) from the drawer has done its job, so a new focused
  // tab closes it, unless the Open-in switch moved the focus.
  const lastFocusedTabRef = useRef({ side: focusedSide, tabKey: focusedTabKey });
  useEffect(() => {
    const previous = lastFocusedTabRef.current;
    lastFocusedTabRef.current = { side: focusedSide, tabKey: focusedTabKey };
    const sideChanged = previous.side !== focusedSide;
    const isSidebarFocusSwitch = sideChanged && sidebarFocusSwitchRef.current === focusedSide;
    if (sideChanged) {
      sidebarFocusSwitchRef.current = null;
    }
    if (previous.tabKey !== focusedTabKey && !isSidebarFocusSwitch && isPeekOpen) {
      closePeek();
    }
  }, [closePeek, focusedSide, focusedTabKey, isPeekOpen]);

  if (!isMobile) {
    return (
      <>
        {/* One container whose classes follow the mode, so switching docked, hidden and drawer never remounts the Sidebar. */}
        <div
          ref={peekContainerRef}
          className={cn(
            'h-full border-r border-border/50',
            isPeekOpen
              ? 'fixed inset-y-0 left-0 z-40 bg-background shadow-xl'
              : 'relative flex-shrink-0',
            // Hidden, not unmounted: Settings, the delete confirmations and the version modal live in it.
            isImmersive && !isPeekOpen && 'hidden',
          )}
          style={isPeekOpen || isSidebarResizable ? { width: sidebarWidth } : undefined}
          // Marks the drawer as the Escape owner for the app's other key handlers. Dropped while
          // Settings is open over it, because Settings only takes Escape when no such layer exists.
          data-escape-layer={isPeekOpen && !sidebarSharedProps.showSettings ? '' : undefined}
        >
          <Sidebar {...sidebarSharedProps} paneTargeting={paneTargeting} forceExpanded={isPeekOpen} />
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
            className="fixed inset-0 z-30 bg-background/40"
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
