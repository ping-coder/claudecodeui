import { memo, useCallback, useLayoutEffect, useRef } from 'react';

import { usePaletteOps } from '@/modules/command-palette';
import { QuickSettingsPanel } from '@/modules/quick-settings-panel';
import { useProjectCommandState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { useWorkspaceChrome } from '@/modules/project-workspace/context/WorkspaceChromeContext';
import { getActiveTab, getPane } from '@/modules/project-workspace/utils/workspaceLayout';
import type { SlashCommand } from '@/shared/types';

/**
 * Rendered by ProjectWorkspaceShell to bind this module's project state and the chat composer to the
 * quick-settings-panel module. Immersive mode has no docked column: the panel opens as an overlay
 * there, and a stored pin is kept for afterwards.
 */
function ProjectQuickSettingsRegion() {
  const { selectedProject, setActiveTab, layout } = useProjectCommandState();
  const { isImmersive } = useWorkspaceChrome();
  const paletteOps = usePaletteOps();

  // The layout as last rendered, read when a command is picked, so the memoized panel keeps one callback.
  const layoutRef = useRef(layout);
  useLayoutEffect(() => {
    layoutRef.current = layout;
  });

  // A picked command belongs in the chat composer, which only accepts focus while the Chat tab is
  // showing. A focused pane that shows nothing (no tab, a conversation that is gone) has no composer
  // yet: the insert itself opens its new chat on Chat (WorkspacePane), and switching the view first
  // would open one more, in the same event.
  const handleInsertCommand = useCallback((command: SlashCommand) => {
    const current = layoutRef.current;
    const focusedTab = getActiveTab(getPane(current, current.focusedSide));
    if (focusedTab && !focusedTab.isMissing) {
      setActiveTab('chat');
    }
    paletteOps.insertComposerText(`${command.name} `);
  }, [paletteOps, setActiveTab]);

  return (
    <QuickSettingsPanel
      selectedProject={selectedProject}
      onInsertCommand={handleInsertCommand}
      allowDocking={!isImmersive}
    />
  );
}

export default memo(ProjectQuickSettingsRegion);
