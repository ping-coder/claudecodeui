import { memo, useCallback } from 'react';

import { usePaletteOps } from '@/modules/command-palette';
import { QuickSettingsPanel } from '@/modules/quick-settings-panel';
import { useProjectCommandState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { useWorkspaceChrome } from '@/modules/project-workspace/context/WorkspaceChromeContext';
import type { SlashCommand } from '@/shared/types';

/**
 * Rendered by ProjectWorkspaceShell to bind this module's project state and the chat composer to the
 * quick-settings-panel module. Immersive mode has no docked column: the panel opens as an overlay
 * there, and a stored pin is kept for afterwards.
 */
function ProjectQuickSettingsRegion() {
  const { selectedProject, setActiveTab } = useProjectCommandState();
  const { isImmersive } = useWorkspaceChrome();
  const paletteOps = usePaletteOps();

  // A picked command belongs in the chat composer, which only accepts focus
  // while the Chat tab is showing.
  const handleInsertCommand = useCallback((command: SlashCommand) => {
    setActiveTab('chat');
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
