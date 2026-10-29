import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
  dismissBrowserFullscreenIssue,
  getBrowserFullscreenSnapshot,
  holdBrowserFullscreen,
  retryBrowserFullscreen,
  subscribeToBrowserFullscreen,
} from '@/shared/browserFullscreen';
import type { BrowserFullscreenSource } from '@/shared/types';

type UseBrowserFullscreenOptions = {
  /**
   * Used only to name the control in the diagnostics report and to tell a view maximized over the
   * page (any source but 'workspace', which owns a short Escape) from immersive mode; the notice is
   * shared by every holder whatever the source.
   */
  source: BrowserFullscreenSource;
};

/**
 * A component's maximized state, paired with the browser fullscreen. Used by project-workspace's
 * useImmersiveMode, code-editor's EditorSidebar, prd-editor's PRDEditor and browser-use's
 * BrowserUsePanel. `enter` must run inside the user's gesture; the component shows its CSS maximize
 * whenever `isMaximized`, which the browser ending its fullscreen turns off.
 */
export function useBrowserFullscreen({ source }: UseBrowserFullscreenOptions) {
  // Whether this component is maximized (its CSS maximize shows), with or without the browser
  // fullscreen: a refused or unavailable request still maximizes. Memory only: a reload cannot
  // restore the fullscreen, which needs a gesture.
  const [isMaximized, setIsMaximized] = useState(false);
  // Read synchronously by enter/exit, which can run twice before React re-renders.
  const isMaximizedRef = useRef(false);
  const releaseRef = useRef<(() => void) | null>(null);
  const { isFullscreen } = useSyncExternalStore(subscribeToBrowserFullscreen, getBrowserFullscreenSnapshot);

  const enter = useCallback(() => {
    if (isMaximizedRef.current) {
      return;
    }
    isMaximizedRef.current = true;
    setIsMaximized(true);
    releaseRef.current = holdBrowserFullscreen({
      source,
      onBrowserExit: () => {
        // The browser left fullscreen and the controller already let this holder go.
        releaseRef.current = null;
        isMaximizedRef.current = false;
        setIsMaximized(false);
      },
    });
  }, [source]);

  const exit = useCallback(() => {
    if (!isMaximizedRef.current) {
      return;
    }
    isMaximizedRef.current = false;
    setIsMaximized(false);
    const release = releaseRef.current;
    releaseRef.current = null;
    release?.();
  }, []);

  const toggle = useCallback(() => {
    if (isMaximizedRef.current) {
      exit();
    } else {
      enter();
    }
  }, [enter, exit]);

  // An unmounted component (the workspace left, the editor closed) must not keep the page fullscreen.
  useEffect(() => () => {
    const release = releaseRef.current;
    releaseRef.current = null;
    isMaximizedRef.current = false;
    release?.();
  }, []);

  return {
    isMaximized,
    isBrowserFullscreen: isMaximized && isFullscreen,
    enter,
    exit,
    toggle,
  };
}

/**
 * The current fullscreen issue for the notice, with its Retry and Close. Used by project-workspace's
 * useImmersiveMode; ProjectWorkspaceShell renders one BrowserFullscreenNotice for every holder.
 */
export function useBrowserFullscreenIssue() {
  const { issue } = useSyncExternalStore(subscribeToBrowserFullscreen, getBrowserFullscreenSnapshot);
  return {
    issue,
    retry: retryBrowserFullscreen,
    dismiss: dismissBrowserFullscreenIssue,
  };
}
