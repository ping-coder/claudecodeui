import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import { getPane } from '@/modules/project-workspace/utils/workspaceLayout';
import type { WorkspaceLayout, WorkspacePaneSide } from '@/shared/types';

type UseWorkspaceRefreshArgs = {
  layoutRef: MutableRefObject<WorkspaceLayout>;
  /** One /api/projects that also patches the open tabs' session rows; never the loading screen. */
  refreshProjects: () => Promise<void>;
  /** What lives outside the workspace state: the socket, the running sessions, the plugin list. */
  refreshAppState?: () => Promise<unknown> | void;
};

/** Every refresh counter: one for the whole workspace and one per pane id, both only ever going up. */
type RefreshCounters = { epoch: number; byPane: Readonly<Record<string, number>> };

/**
 * The page-free refresh of the workspace, used by useProjectsState. A pane's refresh token is the
 * workspace epoch plus its own count, keyed by pane id: the token follows a pane into the other slot and a
 * new pane starts where nothing fires. The tokens live here, not in the layout, so a refresh is never a
 * layout change, is never persisted and asks no unsaved-edits question. Refreshing a tab bumps its pane;
 * refreshing everything bumps the epoch (every mounted pane, a collapsed split's hidden one included) and
 * reloads the project list and the app state once, single-flight.
 */
export function useWorkspaceRefresh({ layoutRef, refreshProjects, refreshAppState }: UseWorkspaceRefreshArgs) {
  // The refresh counters every pane's token is read from; a change re-renders the panes it moved.
  const [counters, setCounters] = useState<RefreshCounters>({ epoch: 0, byPane: {} });
  // A full refresh is on its way: its buttons spin and do nothing until it settles.
  const [isRefreshingWorkspace, setIsRefreshingWorkspace] = useState(false);
  const inFlightRef = useRef<Promise<void> | null>(null);

  // The newest loaders, read when a refresh starts, so refreshWorkspace keeps one identity.
  const loadersRef = useRef({ refreshProjects, refreshAppState });
  useLayoutEffect(() => {
    loadersRef.current = { refreshProjects, refreshAppState };
  });

  const refreshTab = useCallback((side: WorkspacePaneSide) => {
    const pane = getPane(layoutRef.current, side);
    if (!pane) {
      return;
    }
    setCounters((previous) => ({
      ...previous,
      byPane: { ...previous.byPane, [pane.id]: (previous.byPane[pane.id] ?? 0) + 1 },
    }));
  }, [layoutRef]);

  const refreshWorkspace = useCallback((): Promise<void> => {
    if (inFlightRef.current) {
      return inFlightRef.current;
    }
    setCounters((previous) => ({ ...previous, epoch: previous.epoch + 1 }));
    setIsRefreshingWorkspace(true);
    const { refreshProjects: loadProjects, refreshAppState: loadAppState } = loadersRef.current;
    const run = Promise.allSettled([loadProjects(), loadAppState?.()]).then(() => {
      inFlightRef.current = null;
      setIsRefreshingWorkspace(false);
    });
    inFlightRef.current = run;
    return run;
  }, []);

  const getPaneRefreshToken = useCallback(
    (paneId: string): number => counters.epoch + (counters.byPane[paneId] ?? 0),
    [counters],
  );

  return {
    /** Moves with every full refresh: the sidebar reloads its archived and recent lists on it. */
    refreshEpoch: counters.epoch,
    getPaneRefreshToken,
    refreshTab,
    refreshWorkspace,
    isRefreshingWorkspace,
  };
}
