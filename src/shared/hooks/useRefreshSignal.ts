import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Calls `onRefresh` each time `token` changes after mount, never on mount itself: a view that mounts
 * after a refresh already loads fresh data. `token` is a counter that only moves forward (the workspace's
 * refresh token for a pane); undefined stands for "no refresh signal" and never fires. The latest
 * `onRefresh` runs, so it may read current state without being stable. Used by project-workspace's
 * WorkspaceMain and the views it shows (file-tree's FileTree, git-panel's GitPanel and its Compare and
 * Worktrees views, browser-use's BrowserUsePanel, task-master's TaskMasterPanel, code-editor's document
 * hook), and by sidebar's controller for its archived and recent lists.
 */
export function useRefreshSignal(token: number | undefined, onRefresh: () => void): void {
  // The newest callback, so a refresh never runs one from an older render.
  const onRefreshRef = useRef(onRefresh);
  useLayoutEffect(() => {
    onRefreshRef.current = onRefresh;
  });

  // The token already answered; starts at the mount value, so mounting (and StrictMode's re-run) fires nothing.
  const answeredTokenRef = useRef(token);
  useEffect(() => {
    if (token === answeredTokenRef.current) {
      return;
    }
    answeredTokenRef.current = token;
    if (token !== undefined) {
      onRefreshRef.current();
    }
  }, [token]);
}
