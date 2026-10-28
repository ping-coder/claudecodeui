import { useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import { useTheme } from '@/shared/context/ThemeContext';
import type { Project, ProjectSession, ShellSessionBusy } from '@/shared/types';
import { useShellConnection } from '@/modules/shell/hooks/useShellConnection';
import { useShellTerminal } from '@/modules/shell/hooks/useShellTerminal';

type UseShellRuntimeOptions = {
  selectedProject: Project | null | undefined;
  selectedSession: ProjectSession | null | undefined;
  initialCommand: string | null | undefined;
  isPlainShell: boolean;
  bypassPermissions: boolean;
  // Model to launch the CLI on; null leaves the CLI on its own default.
  model?: string | null;
  minimal: boolean;
  autoConnect: boolean;
  isRestarting: boolean;
  onProcessComplete?: ((exitCode: number) => void) | null;
  onOutputRef?: MutableRefObject<(() => void) | null>;
};

type UseShellRuntimeResult = {
  terminalContainerRef: RefObject<HTMLDivElement>;
  terminalRef: MutableRefObject<Terminal | null>;
  wsRef: MutableRefObject<WebSocket | null>;
  isConnected: boolean;
  isInitialized: boolean;
  isConnecting: boolean;
  // A live Claude CLI was launched in the other theme and keeps those colours
  // until it is restarted.
  isClaudeThemeOutdated: boolean;
  // Set while the server holds the CLI back because CloudCLI still runs the
  // session, and what runs there; the Shell shows its busy notice for it.
  sessionBusy: ShellSessionBusy | null;
  // A takeover was sent and the server has not answered yet.
  isTakingOver: boolean;
  connectToShell: (options?: { forceRestart?: boolean }) => void;
  disconnectFromShell: (options?: { suppressAutoConnect?: boolean }) => void;
  // Asks the server again whether the CLI can start on the session.
  retrySessionInit: () => void;
  // Asks the server to stop what the busy notice shows CloudCLI running on
  // the session and start the CLI; the server stops nothing if more started.
  takeOverSession: () => void;
};

export function useShellRuntime({
  selectedProject,
  selectedSession,
  initialCommand,
  isPlainShell,
  bypassPermissions,
  model = null,
  minimal,
  autoConnect,
  isRestarting,
  onProcessComplete,
  onOutputRef,
}: UseShellRuntimeOptions): UseShellRuntimeResult {
  const { isDarkMode } = useTheme();
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const selectedProjectRef = useRef(selectedProject);
  const selectedSessionRef = useRef(selectedSession);
  const initialCommandRef = useRef(initialCommand);
  const isPlainShellRef = useRef(isPlainShell);
  const bypassPermissionsRef = useRef(bypassPermissions);
  const modelRef = useRef(model);
  const isDarkModeRef = useRef(isDarkMode);
  const onProcessCompleteRef = useRef(onProcessComplete);
  const lastSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);

  // Keep mutable values in refs so websocket handlers always read current data.
  useEffect(() => {
    selectedProjectRef.current = selectedProject;
    selectedSessionRef.current = selectedSession;
    initialCommandRef.current = initialCommand;
    isPlainShellRef.current = isPlainShell;
    bypassPermissionsRef.current = bypassPermissions;
    modelRef.current = model;
    isDarkModeRef.current = isDarkMode;
    onProcessCompleteRef.current = onProcessComplete;
  }, [selectedProject, selectedSession, initialCommand, isPlainShell, bypassPermissions, model, isDarkMode, onProcessComplete]);

  const closeSocket = useCallback(() => {
    const activeSocket = wsRef.current;
    if (!activeSocket) {
      return;
    }

    if (
      activeSocket.readyState === WebSocket.OPEN ||
      activeSocket.readyState === WebSocket.CONNECTING
    ) {
      activeSocket.close();
    }

    wsRef.current = null;
  }, []);

  const { isInitialized, clearTerminalScreen, disposeTerminal } = useShellTerminal({
    terminalContainerRef,
    terminalRef,
    fitAddonRef,
    wsRef,
    selectedProject,
    minimal,
    isRestarting,
    closeSocket,
  });

  const {
    isConnected,
    isConnecting,
    claudeLaunchColorScheme,
    sessionBusy,
    isTakingOver,
    connectToShell,
    disconnectFromShell,
    retrySessionInit,
    takeOverSession,
  } = useShellConnection({
    wsRef,
    terminalRef,
    fitAddonRef,
    selectedProjectRef,
    selectedSessionRef,
    initialCommandRef,
    isPlainShellRef,
    bypassPermissionsRef,
    modelRef,
    isDarkModeRef,
    onProcessCompleteRef,
    isInitialized,
    autoConnect,
    closeSocket,
    clearTerminalScreen,
    onOutputRef,
  });

  const isClaudeThemeOutdated =
    isConnected &&
    claudeLaunchColorScheme !== null &&
    claudeLaunchColorScheme !== (isDarkMode ? 'dark' : 'light');

  useEffect(() => {
    if (!isRestarting) {
      return;
    }

    disconnectFromShell({ suppressAutoConnect: true });
    disposeTerminal();
  }, [disconnectFromShell, disposeTerminal, isRestarting]);

  useEffect(() => {
    if (selectedProject) {
      return;
    }

    disconnectFromShell();
    disposeTerminal();
  }, [disconnectFromShell, disposeTerminal, selectedProject]);

  useEffect(() => {
    const currentSessionId = selectedSession?.id ?? null;
    if (lastSessionIdRef.current !== currentSessionId && isInitialized) {
      disconnectFromShell();
    }

    lastSessionIdRef.current = currentSessionId;
  }, [disconnectFromShell, isInitialized, selectedSession?.id]);

  return {
    terminalContainerRef,
    terminalRef,
    wsRef,
    isConnected,
    isInitialized,
    isConnecting,
    isClaudeThemeOutdated,
    sessionBusy,
    isTakingOver,
    connectToShell,
    disconnectFromShell,
    retrySessionInit,
    takeOverSession,
  };
}
