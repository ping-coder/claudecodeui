import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import ProjectEffects from '@/modules/project-workspace/controllers/ProjectEffects';
import { useProjectPanesState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { WorkspaceChromeProvider } from '@/modules/project-workspace/context/WorkspaceChromeContext';
import { useElementWidth } from '@/shared/hooks/useElementWidth';
import { useImmersiveMode } from '@/modules/project-workspace/hooks/useImmersiveMode';
import { useWorkspaceShortcuts } from '@/modules/project-workspace/hooks/useWorkspaceShortcuts';
import { PANE_MIN_WIDTH_PX, PANE_SPLITTER_WIDTH_PX } from '@/shared/constants';
import type { ProjectWorkspaceShellProps } from '@/shared/types';
import BrowserFullscreenNotice from '@/modules/project-workspace/BrowserFullscreenNotice';
import ImmersiveExitControl from '@/modules/project-workspace/ImmersiveExitControl';
import ProjectCommandPalette from '@/modules/project-workspace/ProjectCommandPalette';
import ProjectMainRegion from '@/modules/project-workspace/ProjectMainRegion';
import ProjectQuickSettingsRegion from '@/modules/project-workspace/ProjectQuickSettingsRegion';
import ProjectRunNotifications from '@/modules/project-workspace/ProjectRunNotifications';
import ProjectSidebarRegion from '@/modules/project-workspace/ProjectSidebarRegion';

/** Narrowest main column that holds two panes side by side. */
const SPLIT_MAIN_COLUMN_MIN_WIDTH_PX = 2 * PANE_MIN_WIDTH_PX + PANE_SPLITTER_WIDTH_PX;

/**
 * Rendered by ProjectWorkspaceRoute to lay out the workspace sidebar, main region and global overlays.
 * It owns the workspace chrome its regions share through WorkspaceChromeProvider: immersive (full
 * screen) mode, the immersive sidebar drawer and whether the main column is wide enough to split.
 */
function ProjectWorkspaceShell({
  isMobile,
  ws,
  sendMessage,
  navigate,
}: ProjectWorkspaceShellProps) {
  const { layout, actions, setSidebarOpen, setCanShowBothPanes } = useProjectPanesState();
  const {
    isImmersive,
    isBrowserFullscreen,
    browserFullscreenIssue,
    toggleImmersive,
    exitImmersive,
    retryBrowserFullscreen,
    dismissBrowserFullscreenIssue,
  } = useImmersiveMode();
  // Whether the sidebar is out as an overlay drawer in desktop immersive mode, where its docked
  // column is hidden. Held here because a pane's "Show sidebar" button opens it and the sidebar
  // region closes it; memory only, like immersive mode itself.
  const [isSidebarPeekOpen, setSidebarPeekOpen] = useState(false);

  // Kept mounted in every layout, so the width is known before the first paint and on every resize.
  const mainColumnRef = useRef<HTMLDivElement>(null);
  const mainColumnWidth = useElementWidth(mainColumnRef);
  const canSplit = !isMobile && mainColumnWidth >= SPLIT_MAIN_COLUMN_MIN_WIDTH_PX;
  // The panes' state decides what counts as on screen: a split that does not fit shows one pane.
  // Reported before paint, like the measurement itself.
  useLayoutEffect(() => {
    setCanShowBothPanes(canSplit);
  }, [canSplit, setCanShowBothPanes]);

  // Every entry into immersive mode starts with the drawer closed; leaving it hides the drawer
  // through `isPeekShown` below, whichever way immersive mode ends (the browser can end it too).
  const toggleImmersiveWithClosedPeek = useCallback(() => {
    setSidebarPeekOpen(false);
    toggleImmersive();
  }, [toggleImmersive]);

  // A pane shortcut that put DOM focus in a pane takes the drawer covering the panes away.
  const closeSidebarPeek = useCallback(() => {
    setSidebarPeekOpen(false);
  }, []);

  useWorkspaceShortcuts({
    isMobile,
    canSplit,
    layout,
    actions,
    toggleImmersive: toggleImmersiveWithClosedPeek,
    closeSidebarPeek,
  });

  const isPeekShown = isSidebarPeekOpen && isImmersive && !isMobile;
  const chrome = useMemo(() => ({
    isImmersive,
    isBrowserFullscreen,
    toggleImmersive: toggleImmersiveWithClosedPeek,
    exitImmersive,
    isSidebarPeekOpen: isPeekShown,
    setSidebarPeekOpen,
    canSplit,
  }), [canSplit, exitImmersive, isBrowserFullscreen, isImmersive, isPeekShown, toggleImmersiveWithClosedPeek]);

  const openSidebarDrawer = useCallback(() => {
    setSidebarOpen(true);
  }, [setSidebarOpen]);

  return (
    <WorkspaceChromeProvider value={chrome}>
      <div
        className="fixed inset-0 flex bg-background"
        style={{ bottom: 'var(--keyboard-height, 0px)' }}
      >
        <ProjectEffects />
        <ProjectRunNotifications isMobile={isMobile} />
        <ProjectSidebarRegion isMobile={isMobile} />

        <div ref={mainColumnRef} className="flex min-w-0 flex-1 flex-col">
          <ProjectMainRegion
            isMobile={isMobile}
            ws={ws}
            sendMessage={sendMessage}
            navigate={navigate}
          />
        </div>

        {/* Desktop only: says why a maximize (immersive mode, the editor, the PRD editor, Browser Use) came without the
            whole screen. Phones keep the console warning and the report. */}
        {!isMobile && browserFullscreenIssue && (
          <BrowserFullscreenNotice
            issue={browserFullscreenIssue}
            onRetry={retryBrowserFullscreen}
            onDismiss={dismissBrowserFullscreenIssue}
          />
        )}
        {/* Phones hide the header while immersive, so this capsule is the way back out. */}
        {isMobile && isImmersive && (
          <ImmersiveExitControl onOpenMenu={openSidebarDrawer} onExit={exitImmersive} />
        )}
        <ProjectCommandPalette />
        {/* Last flex child on purpose: when pinned it docks to the right of the main region. */}
        <ProjectQuickSettingsRegion />
      </div>
    </WorkspaceChromeProvider>
  );
}

export default memo(ProjectWorkspaceShell);
