import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

/** Workspace chrome: the immersive (fullscreen) state, the immersive sidebar peek and whether the main column can hold two panes. */
type WorkspaceChromeState = {
  isImmersive: boolean;
  isBrowserFullscreen: boolean;
  toggleImmersive: () => void;
  exitImmersive: () => void;
  /** Immersive desktop: sidebar shown as an overlay drawer. */
  isSidebarPeekOpen: boolean;
  setSidebarPeekOpen: (open: boolean) => void;
  /** !isMobile && main column >= 2*PANE_MIN_WIDTH_PX + PANE_SPLITTER_WIDTH_PX. */
  canSplit: boolean;
};

type WorkspaceChromeProviderProps = {
  value: WorkspaceChromeState;
  children: ReactNode;
};

const noop = () => {};

/** Without a provider the workspace is never immersive and never offers a split, and the setters do nothing. */
const DEFAULT_WORKSPACE_CHROME: WorkspaceChromeState = {
  isImmersive: false,
  isBrowserFullscreen: false,
  toggleImmersive: noop,
  exitImmersive: noop,
  isSidebarPeekOpen: false,
  setSidebarPeekOpen: noop,
  canSplit: false,
};

const WorkspaceChromeContext = createContext<WorkspaceChromeState>(DEFAULT_WORKSPACE_CHROME);

/** Rendered by ProjectWorkspaceShell around the whole workspace so its regions share one immersive state and split capability. Pass a memoized value. */
export function WorkspaceChromeProvider({ value, children }: WorkspaceChromeProviderProps) {
  return <WorkspaceChromeContext.Provider value={value}>{children}</WorkspaceChromeContext.Provider>;
}

/** Read by this module's regions (main panes, sidebar, command palette, quick settings, shortcuts) to follow immersive mode and split capability. */
export function useWorkspaceChrome(): WorkspaceChromeState {
  return useContext(WorkspaceChromeContext);
}
