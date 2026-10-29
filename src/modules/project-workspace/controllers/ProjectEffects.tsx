import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { usePaletteOpsRegister } from '@/modules/command-palette';
import { formatSessionTitle } from '@/modules/sidebar';
import { useProcessingSessions } from '@/shared/context/SessionProtectionContext';
import { writeSelectedProvider } from '@/shared/selectedProvider';
import { useProjectEffectsState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { useRunningSessionTitle } from '@/modules/project-workspace/hooks/useRunningSessionTitle';
import { findSessionTab } from '@/modules/project-workspace/utils/workspaceLayout';
import type { LLMProvider } from '@/shared/types';
import { getPageTitle, resolveDocumentSessionTitle, setDocumentPageTitle } from '@/shared/utils';

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
  // Names an untitled focused session in the interface language, and re-renders when that changes.
  const { t } = useTranslation('common');

  usePaletteOpsRegister({
    openSettings,
    refreshProjects: refreshProjectsSilently,
  });

  useRunningSessionTitle({ activities, projects, layout });

  // Rendered here rather than in the sidebar, so the title keeps following the focused pane while the
  // sidebar is collapsed, switched to another mode or hidden by immersive mode. The focused session is
  // named exactly as the running part names it (live title, its tab's snapshot, localized placeholder;
  // the server's placeholder names translated too), so when it starts running the title only gains the
  // marker.
  const pageTitle = focusedSession
    ? formatSessionTitle(
      resolveDocumentSessionTitle(focusedSession.id, projects, findSessionTab(layout, focusedSession.id)?.tab.title, t),
      t,
    )
    : getPageTitle(focusedProject, null, t);
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

      // Follows the notified session's provider; the user picked a notification, not a provider.
      if (typeof message.provider === 'string' && message.provider.trim()) {
        writeSelectedProvider(message.provider as LLMProvider, { automatic: true });
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
