import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

import type { WorkspacePaneSide } from '@/shared/types';

/** What a workspace pane tells the chat and editor rendered inside it. */
type WorkspacePaneContextValue = {
  /** Pane hosting this subtree; null outside the split workspace. */
  side: WorkspacePaneSide | null;
  /** Only the focused pane answers page-wide keys (Esc abort, Ctrl/Cmd+S), registers palette ops and takes DOM focus. */
  isFocusedPane: boolean;
  /** The pane shares the main area with another one side by side (editor expands in place instead of popping out). */
  isSplitPane: boolean;
  /** Opens a file in this pane's editor; null -> fall back to usePaletteOps(). */
  openFileInEditor: ((filePath: string, line?: number | null) => void) | null;
  /** Reveals a directory in this pane's file tree; null -> palette fallback. */
  openDirectory: ((directoryPath: string) => void) | null;
};

type WorkspacePaneProviderProps = {
  value: WorkspacePaneContextValue;
  children: ReactNode;
};

/**
 * Outside any pane (tests, and every screen but the workspace) a subtree behaves as the one
 * focused pane did before the split: it owns the page-wide keys and uses the palette fallbacks.
 */
const DEFAULT_WORKSPACE_PANE: WorkspacePaneContextValue = {
  side: null,
  isFocusedPane: true,
  isSplitPane: false,
  openFileInEditor: null,
  openDirectory: null,
};

const WorkspacePaneContext = createContext<WorkspacePaneContextValue>(DEFAULT_WORKSPACE_PANE);

/** Rendered by project-workspace's WorkspaceMain around each pane's content, so the chat and code-editor modules inside know which pane they belong to. Pass a memoized value. */
export function WorkspacePaneProvider({ value, children }: WorkspacePaneProviderProps) {
  return <WorkspacePaneContext.Provider value={value}>{children}</WorkspacePaneContext.Provider>;
}

/** Read by the chat and code-editor modules to gate page-wide keys and focus on the focused pane and to open files in their own pane. */
export function useWorkspacePane(): WorkspacePaneContextValue {
  return useContext(WorkspacePaneContext);
}
