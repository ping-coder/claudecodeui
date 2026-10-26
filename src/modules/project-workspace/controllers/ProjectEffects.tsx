import { useEffect } from 'react';

import { usePaletteOpsRegister } from '@/modules/command-palette';
import { writeSelectedProvider } from '@/shared/selectedProvider';
import { useProjectEffectsState } from '@/modules/project-workspace/context/ProjectsStateContext';
import type { LLMProvider } from '@/shared/types';
import { getPageTitle, setDocumentPageTitle } from '@/shared/utils';

/**
 * Headless controller rendered by ProjectWorkspaceShell for page-wide effects: palette operations,
 * service-worker notification clicks and the browser tab title, all following the focused pane.
 */
export default function ProjectEffects() {
  const {
    openSettings,
    refreshProjectsSilently,
    setSidebarOpen,
    openSessionById,
    focusedProject,
    focusedSession,
  } = useProjectEffectsState();

  usePaletteOpsRegister({
    openSettings,
    refreshProjects: refreshProjectsSilently,
  });

  // Rendered here rather than in the sidebar, so the title keeps following the focused pane while the
  // sidebar is collapsed, switched to another mode or hidden by immersive mode.
  const pageTitle = getPageTitle(focusedProject, focusedSession);
  useEffect(() => {
    setDocumentPageTitle(pageTitle);
  }, [pageTitle]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return undefined;
    }

    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.type !== 'notification:navigate') {
        return;
      }

      if (typeof message.provider === 'string' && message.provider.trim()) {
        writeSelectedProvider(message.provider as LLMProvider);
      }

      setSidebarOpen(false);
      void refreshProjectsSilently();

      // The notified session opens kept in the focused pane, on its Chat view; a notification
      // without a session leaves the panes as they are.
      if (typeof message.sessionId === 'string' && message.sessionId) {
        openSessionById(message.sessionId, { preview: false, view: 'chat' });
      }
    };

    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [openSessionById, refreshProjectsSilently, setSidebarOpen]);

  return null;
}
