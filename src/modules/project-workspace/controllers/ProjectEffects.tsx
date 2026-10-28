import { useEffect } from 'react';

import { usePaletteOpsRegister } from '@/modules/command-palette';
import { useProcessingSessions } from '@/shared/context/SessionProtectionContext';
import { writeSelectedProvider } from '@/shared/selectedProvider';
import { useProjectEffectsState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { useRunningSessionTitle } from '@/modules/project-workspace/hooks/useRunningSessionTitle';
import type { LLMProvider } from '@/shared/types';
import { findLiveSessionTitle, getPageTitle, getSessionTitle, setDocumentPageTitle } from '@/shared/utils';

/**
 * Headless controller rendered by ProjectWorkspaceShell for page-wide effects: palette operations,
 * service-worker notification clicks and the browser tab title. The title's page part follows the
 * focused pane; its running part names the latest running session and, while set, shows instead.
 */
export default function ProjectEffects() {
  const {
    openSettings,
    refreshProjectsSilently,
    setSidebarOpen,
    openSessionById,
    focusedProject,
    focusedSession,
    projects,
    layout,
  } = useProjectEffectsState();
  const activities = useProcessingSessions();

  usePaletteOpsRegister({
    openSettings,
    refreshProjects: refreshProjectsSilently,
  });

  useRunningSessionTitle({ activities, projects, layout });

  // Rendered here rather than in the sidebar, so the title keeps following the focused pane while the
  // sidebar is collapsed, switched to another mode or hidden by immersive mode. The live title comes
  // first, like the running part's, so a session that starts running keeps the name it showed; the
  // focused tab's own session object can be older than a rename or a generated summary.
  const pageTitle = focusedSession
    ? findLiveSessionTitle(focusedSession.id, projects) ?? getSessionTitle(focusedSession)
    : getPageTitle(focusedProject, null);
  useEffect(() => {
    setDocumentPageTitle(pageTitle);
  }, [pageTitle]);

  // The workspace unmounts on sign-out and when its route is left: the app name comes back rather
  // than the last session's. Apart from the effect above, so a change of title is a single write.
  useEffect(() => () => setDocumentPageTitle(null), []);

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
