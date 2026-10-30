import { memo, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { ChatInstancesProvider } from '@/modules/chat';
import { PaletteOpsProvider } from '@/modules/command-palette';
import { usePlugins } from '@/modules/plugins';
import { ProjectsStateProvider } from '@/modules/project-workspace/context/ProjectsStateContext';
import {
  SessionProtectionProvider,
  useSessionProtectionActions,
} from '@/shared/context/SessionProtectionContext';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import { useVisualViewportKeyboardOffset } from '@/modules/project-workspace/hooks/useVisualViewportKeyboardOffset';
import ProjectWorkspaceShell from '@/modules/project-workspace/ProjectWorkspaceShell';

const MemoizedProjectWorkspaceRouteContent = memo(ProjectWorkspaceRouteContent);

/** This module's only public export: rendered by App for the "/" and "/session/:sessionId" routes. */
export default function ProjectWorkspaceRoute() {
  // One realtime coordinator for every ChatInterface on the page, whichever pane renders it.
  return (
    <SessionProtectionProvider>
      <ChatInstancesProvider>
        <PaletteOpsProvider>
          <MemoizedProjectWorkspaceRouteContent />
        </PaletteOpsProvider>
      </ChatInstancesProvider>
    </SessionProtectionProvider>
  );
}

function ProjectWorkspaceRouteContent() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { ws, sendMessage, subscribe, reconnectNow } = useWebSocket();
  const { isSessionProcessing, refreshRunningSessions } = useSessionProtectionActions();
  const { refreshPlugins } = usePlugins();

  useVisualViewportKeyboardOffset();

  // Refresh all's share outside the workspace state. A dropped socket reconnects now instead of after
  // its retry delay; the reconnect then has every chat catch up on its own (websocket_reconnected).
  const refreshAppState = useCallback(() => {
    reconnectNow();
    return Promise.allSettled([refreshRunningSessions(), refreshPlugins()]);
  }, [reconnectNow, refreshPlugins, refreshRunningSessions]);

  return (
    <ProjectsStateProvider
      sessionId={sessionId}
      navigate={navigate}
      subscribe={subscribe}
      isMobile={isMobile}
      isSessionProcessing={isSessionProcessing}
      refreshAppState={refreshAppState}
    >
      <ProjectWorkspaceShell
        isMobile={isMobile}
        ws={ws}
        sendMessage={sendMessage}
        navigate={navigate}
      />
    </ProjectsStateProvider>
  );
}
