import { useBrowserFullscreen, useBrowserFullscreenIssue } from '@/shared/hooks/useBrowserFullscreen';

/**
 * Used by ProjectWorkspaceShell for the workspace's single full-screen state: entering makes the
 * workspace immersive and, where the browser allows it, takes the browser fullscreen in the same
 * gesture; leaving undoes both, and so does the browser ending that fullscreen. Escape stays the
 * page's for a short press. When the browser refuses, or keeps its fullscreen inside the window,
 * immersive mode stays and browserFullscreenIssue says why.
 */
export function useImmersiveMode() {
  // Immersive: sidebar and docked quick settings hidden, panes down to one chrome row (a floating
  // capsule on phones). It is the workspace's maximized state in the shared fullscreen controller.
  const { isMaximized, isBrowserFullscreen, toggle, exit } = useBrowserFullscreen({ source: 'workspace' });
  const { issue, retry, dismiss } = useBrowserFullscreenIssue();

  return {
    isImmersive: isMaximized,
    isBrowserFullscreen,
    browserFullscreenIssue: issue,
    toggleImmersive: toggle,
    exitImmersive: exit,
    retryBrowserFullscreen: retry,
    dismissBrowserFullscreenIssue: dismiss,
  };
}
