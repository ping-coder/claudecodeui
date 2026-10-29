import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import type {
  BackgroundTaskSummary,
  Project,
  ProjectSession,
  ShellSessionBusy,
  ShellTakeOverSnapshot,
} from '@/shared/types';
import { TERMINAL_INIT_DELAY_MS } from '@/shared/constants';
import { getShellWebSocketUrl, parseShellMessage, sendSocketMessage } from '@/modules/shell/utils/socket';
import { readSelectedProvider } from '@/shared/selectedProvider';
import { parseScheduledWork } from '@/shared/utils';

const ANSI_ESCAPE_REGEX =
  /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u009D[^\u0007\u009C]*(?:\u0007|\u009C)|\u001B[PX^_][^\u001B]*\u001B\\|[\u0090\u0098\u009E\u009F][^\u009C]*\u009C|\u001B[@-Z\\-_])/g;
const PROCESS_EXIT_REGEX = /Process exited with code (\d+)/;

const SESSION_BUSY_REASONS: ReadonlyArray<ShellSessionBusy['reason']> = ['turn', 'exiting', 'background', 'held', 'queued'];

/** One background task off the wire, or null when it lacks a field a task summary has. */
function readBusyTask(value: unknown): BackgroundTaskSummary | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const task = value as Record<string, unknown>;
  if (
    typeof task.taskId !== 'string'
    || typeof task.toolUseId !== 'string'
    || typeof task.taskType !== 'string'
    || typeof task.description !== 'string'
    || typeof task.startedAt !== 'number'
  ) {
    return null;
  }
  return {
    taskId: task.taskId,
    toolUseId: task.toolUseId,
    taskType: task.taskType,
    description: task.description,
    ...(typeof task.workflowName === 'string' ? { workflowName: task.workflowName } : {}),
    startedAt: task.startedAt,
    ...(task.nested === true ? { nested: true } : {}),
  };
}

/**
 * Reads a `session_busy` frame. A reason this client does not know reads as
 * `held`, the plainest "CloudCLI still has the session open". Scheduled work
 * is kept only when the frame lists some, so a frame without any reads as
 * one from a server that never reports it.
 */
function readSessionBusyFrame(message: Record<string, unknown>): ShellSessionBusy {
  const reason = SESSION_BUSY_REASONS.find((known) => known === message.reason) ?? 'held';
  const tasks = Array.isArray(message.tasks)
    ? message.tasks.map(readBusyTask).filter((task): task is BackgroundTaskSummary => task !== null)
    : [];
  const scheduled = parseScheduledWork(message.scheduled) ?? [];
  return {
    reason,
    tasks,
    ...(scheduled.length > 0 ? { scheduled } : {}),
    hasQueuedMessage: message.hasQueuedMessage === true,
    changed: message.changed === true,
  };
}

/** The string each entry of a frame's list names under `field`, skipping the entries that name none. */
const readIds = (list: unknown, field: string): string[] => (Array.isArray(list)
  ? list.flatMap((entry: unknown) => {
    const id = entry && typeof entry === 'object' ? (entry as Record<string, unknown>)[field] : undefined;
    return typeof id === 'string' ? [id] : [];
  })
  : []);

/**
 * What a `session_busy` frame showed, for a takeover to send back: the
 * running turn's start, and the id of every task in the frame. That includes
 * tasks the notice leaves out (nested, past the listed few, or missing a
 * field it names them by), which are running all the same: the server would
 * count a task missing here as new and refuse every takeover. The same goes
 * for the scheduled work of a frame that lists it (a server that reports it
 * always does, empty or not); a frame without the list sends none back.
 */
function readTakeOverSnapshot(message: Record<string, unknown>): ShellTakeOverSnapshot {
  const turnStartedAt =
    typeof message.turnStartedAt === 'number' && Number.isFinite(message.turnStartedAt) ? message.turnStartedAt : null;
  return {
    turnStartedAt,
    taskIds: readIds(message.tasks, 'taskId'),
    ...(Array.isArray(message.scheduled) ? { scheduledIds: readIds(message.scheduled, 'id') } : {}),
  };
}

type UseShellConnectionOptions = {
  wsRef: MutableRefObject<WebSocket | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  selectedProjectRef: MutableRefObject<Project | null | undefined>;
  selectedSessionRef: MutableRefObject<ProjectSession | null | undefined>;
  initialCommandRef: MutableRefObject<string | null | undefined>;
  isPlainShellRef: MutableRefObject<boolean>;
  bypassPermissionsRef: MutableRefObject<boolean>;
  modelRef: MutableRefObject<string | null | undefined>;
  isDarkModeRef: MutableRefObject<boolean>;
  onProcessCompleteRef: MutableRefObject<((exitCode: number) => void) | null | undefined>;
  isInitialized: boolean;
  autoConnect: boolean;
  closeSocket: () => void;
  clearTerminalScreen: () => void;
  onOutputRef?: MutableRefObject<(() => void) | null>;
};

type UseShellConnectionResult = {
  isConnected: boolean;
  isConnecting: boolean;
  claudeLaunchColorScheme: 'light' | 'dark' | null;
  sessionBusy: ShellSessionBusy | null;
  isTakingOver: boolean;
  closeSocket: () => void;
  connectToShell: (options?: { forceRestart?: boolean }) => void;
  disconnectFromShell: (options?: { suppressAutoConnect?: boolean }) => void;
  // Sends the init again on the open socket, after a `session_busy`; does
  // nothing while a takeover is under way, as it would replace it.
  retrySessionInit: () => void;
  // Sends the init with `takeOver`, the snapshot of the last `session_busy`:
  // the server stops what CloudCLI runs on the session, waits for it to exit,
  // then starts the CLI, or answers with a new `session_busy` if more has
  // started than that frame showed. One takeover at a time.
  takeOverSession: () => void;
};

export function useShellConnection({
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
}: UseShellConnectionOptions): UseShellConnectionResult {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  // The theme the server says the Claude CLI in this pty was launched for. Only
  // the server knows it: a reconnect can reattach to a CLI started in another
  // theme. Null when the pty runs anything else or no socket is open.
  const [claudeLaunchColorScheme, setClaudeLaunchColorScheme] = useState<'light' | 'dark' | null>(null);
  // What the server said CloudCLI still runs on the session when it held the
  // CLI back (`session_busy`); drives the Shell's busy notice. Cleared once
  // the pty sends output, on an error frame, and when the socket goes away.
  const [sessionBusy, setSessionBusy] = useState<ShellSessionBusy | null>(null);
  // Set from asking the server to take the session over until it answers
  // (output, the session_busy carrying the takeover's initId, an error) or
  // the socket goes away; the notice disables its buttons meanwhile, as the
  // stop can take a while.
  const [isTakingOver, setIsTakingOver] = useState(false);
  // isTakingOver for the send guards: a second click can come before the
  // re-render that disables the buttons.
  const isTakingOverRef = useRef(false);
  // The number of the last init sent. The server puts an init's number on
  // the `session_busy` that answers it, which tells the answer to an earlier
  // init from the answer to the latest.
  const lastInitIdRef = useRef(0);
  // What the notice on screen showed (its frame's turn and task ids), sent
  // back with a takeover; null when no notice is up. A ref, so a click always
  // sends the latest frame's.
  const takeOverSnapshotRef = useRef<ShellTakeOverSnapshot | null>(null);
  const connectingRef = useRef(false);
  const forceRestartOnInitRef = useRef(false);
  const suppressAutoConnectRef = useRef(false);

  const handleProcessCompletion = useCallback(
    (output: string) => {
      if (!isPlainShellRef.current || !onProcessCompleteRef.current) {
        return;
      }

      const sanitizedOutput = output.replace(ANSI_ESCAPE_REGEX, '');
      const cleanOutput = sanitizedOutput;
      if (cleanOutput.includes('Process exited with code 0')) {
        onProcessCompleteRef.current(0);
        return;
      }

      const match = cleanOutput.match(PROCESS_EXIT_REGEX);
      if (!match) {
        return;
      }

      const exitCode = Number.parseInt(match[1], 10);
      if (!Number.isNaN(exitCode) && exitCode !== 0) {
        onProcessCompleteRef.current(exitCode);
      }
    },
    [isPlainShellRef, onProcessCompleteRef],
  );

  // The server has answered the takeover, or never will.
  const settleTakeOver = useCallback(() => {
    isTakingOverRef.current = false;
    setIsTakingOver(false);
  }, []);

  // Takes the busy notice down, with what a takeover would have sent for it.
  const clearSessionBusy = useCallback(() => {
    setSessionBusy(null);
    takeOverSnapshotRef.current = null;
    settleTakeOver();
  }, [settleTakeOver]);

  const handleSocketMessage = useCallback(
    (rawPayload: string, socket: WebSocket) => {
      const message = parseShellMessage(rawPayload);
      if (!message) {
        console.error('[Shell] Error handling WebSocket message:', rawPayload);
        return;
      }

      if (message.type === 'session_busy') {
        // Only the open socket's word on the session on screen counts: a
        // replaced socket's, or one about a session since left, is stale.
        if (socket !== wsRef.current || message.sessionId !== (selectedSessionRef.current?.id ?? null)) {
          return;
        }
        // So is the answer to an init that another followed, such as a
        // retry's arriving after the takeover was sent: only the takeover's
        // own answer may bring the buttons back.
        if (typeof message.initId === 'number' && message.initId !== lastInitIdRef.current) {
          return;
        }
        setSessionBusy(readSessionBusyFrame(message));
        takeOverSnapshotRef.current = readTakeOverSnapshot(message);
        settleTakeOver();
        return;
      }

      if (message.type === 'output') {
        // Output comes from a running pty: nothing holds the CLI back now.
        clearSessionBusy();
        const output = typeof message.data === 'string' ? message.data : '';
        handleProcessCompletion(output);
        terminalRef.current?.write(output);
        onOutputRef?.current?.();
        return;
      }

      if (message.type === 'error') {
        // The server sends this instead of spawning a PTY, then keeps the
        // socket open — so without writing it out the terminal just stays
        // blank forever under a green "connected" dot. Deliberately not
        // closing the socket: `onclose` clears the screen and would erase
        // the very message being surfaced here.
        const detail = typeof message.message === 'string' && message.message
          ? message.message
          : 'Shell error';
        // The notice would cover the error it writes.
        clearSessionBusy();
        terminalRef.current?.write(`\r\n\x1b[31m${detail}\x1b[0m\r\n`);
        return;
      }

      if (message.type === 'claude_theme') {
        const { colorScheme } = message;
        setClaudeLaunchColorScheme(colorScheme === 'light' || colorScheme === 'dark' ? colorScheme : null);
      }
    },
    [clearSessionBusy, handleProcessCompletion, onOutputRef, selectedSessionRef, settleTakeOver, terminalRef, wsRef],
  );

  // Sends the init frame for the session on screen: when the socket opens,
  // and again when the user retries or takes the session over after a
  // `session_busy`. False when nothing was sent (no open socket, no
  // terminal or project yet).
  const sendInit = useCallback(
    (socket: WebSocket | null, options: { forceRestart?: boolean; takeOver?: ShellTakeOverSnapshot } = {}): boolean => {
      const currentTerminal = terminalRef.current;
      const currentProject = selectedProjectRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN || !currentTerminal || !currentProject) {
        return false;
      }

      lastInitIdRef.current += 1;
      sendSocketMessage(socket, {
        type: 'init',
        initId: lastInitIdRef.current,
        projectPath: currentProject.fullPath || currentProject.path || '',
        sessionId: isPlainShellRef.current ? null : selectedSessionRef.current?.id || null,
        hasSession: isPlainShellRef.current ? false : Boolean(selectedSessionRef.current),
        provider: isPlainShellRef.current ? 'plain-shell' : (selectedSessionRef.current?.__provider || readSelectedProvider()),
        cols: currentTerminal.cols,
        rows: currentTerminal.rows,
        initialCommand: initialCommandRef.current,
        isPlainShell: isPlainShellRef.current,
        forceRestart: Boolean(options.forceRestart),
        // Launch-time flag: bypass mode can only join the CLI's
        // shift+tab cycle when claude starts with it.
        bypassPermissions: bypassPermissionsRef.current,
        // Launch-time as well: agy's --model only applies at start.
        ...(modelRef.current ? { model: modelRef.current } : {}),
        // Launch-time too: a CLI picks its colours when it starts.
        colorScheme: isDarkModeRef.current ? 'dark' : 'light',
        ...(options.takeOver ? { takeOver: options.takeOver } : {}),
      });
      return true;
    },
    [
      bypassPermissionsRef,
      initialCommandRef,
      isDarkModeRef,
      isPlainShellRef,
      modelRef,
      selectedProjectRef,
      selectedSessionRef,
      terminalRef,
    ],
  );

  const connectWebSocket = useCallback(
    (isConnectionLocked = false) => {
      if ((connectingRef.current && !isConnectionLocked) || isConnecting || isConnected) {
        return;
      }

      try {
        const wsUrl = getShellWebSocketUrl();
        if (!wsUrl) {
          connectingRef.current = false;
          setIsConnecting(false);
          return;
        }

        connectingRef.current = true;

        const socket = new WebSocket(wsUrl);
        wsRef.current = socket;

        socket.onopen = () => {
          setIsConnected(true);
          setIsConnecting(false);
          connectingRef.current = false;

          window.setTimeout(() => {
            const currentFitAddon = fitAddonRef.current;
            if (!terminalRef.current || !currentFitAddon || !selectedProjectRef.current) {
              return;
            }

            currentFitAddon.fit();
            const forceRestart = forceRestartOnInitRef.current;
            forceRestartOnInitRef.current = false;

            sendInit(socket, { forceRestart });
          }, TERMINAL_INIT_DELAY_MS);
        };

        socket.onmessage = (event) => {
          const rawPayload = typeof event.data === 'string' ? event.data : String(event.data ?? '');
          handleSocketMessage(rawPayload, socket);
        };

        socket.onclose = () => {
          setIsConnected(false);
          setIsConnecting(false);
          setClaudeLaunchColorScheme(null);
          // A replaced socket's close can land after its successor has been
          // told the session is busy; that notice is the successor's.
          if (wsRef.current === null || wsRef.current === socket) {
            clearSessionBusy();
          }
          connectingRef.current = false;
          clearTerminalScreen();
        };

        socket.onerror = () => {
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
        };
      } catch {
        setIsConnected(false);
        setIsConnecting(false);
        connectingRef.current = false;
        forceRestartOnInitRef.current = false;
      }
    },
    [
      clearSessionBusy,
      clearTerminalScreen,
      fitAddonRef,
      handleSocketMessage,
      isConnected,
      isConnecting,
      selectedProjectRef,
      sendInit,
      terminalRef,
      wsRef,
    ],
  );

  const connectToShell = useCallback((options?: { forceRestart?: boolean }) => {
    if (!isInitialized || isConnected || isConnecting || connectingRef.current) {
      return;
    }

    forceRestartOnInitRef.current = Boolean(options?.forceRestart);
    suppressAutoConnectRef.current = false;
    connectingRef.current = true;
    setIsConnecting(true);
    connectWebSocket(true);
  }, [connectWebSocket, isConnected, isConnecting, isInitialized]);

  const disconnectFromShell = useCallback((options?: { suppressAutoConnect?: boolean }) => {
    if (options?.suppressAutoConnect) {
      suppressAutoConnectRef.current = true;
    }

    closeSocket();
    clearTerminalScreen();
    setIsConnected(false);
    setIsConnecting(false);
    setClaudeLaunchColorScheme(null);
    clearSessionBusy();
    connectingRef.current = false;
    forceRestartOnInitRef.current = false;
  }, [clearSessionBusy, clearTerminalScreen, closeSocket]);

  // No polling: the user decides when to ask again. A CLI opened on its own
  // in a gap between two chat turns would race the next turn.
  const retrySessionInit = useCallback(() => {
    // The server lets a later init replace a takeover it is still waiting
    // on, and that takeover then opens nothing although it stopped the work.
    if (isTakingOverRef.current) {
      return;
    }
    sendInit(wsRef.current);
  }, [sendInit, wsRef]);

  const takeOverSession = useCallback(() => {
    const snapshot = takeOverSnapshotRef.current;
    // One at a time, and only of what a notice showed.
    if (isTakingOverRef.current || !snapshot) {
      return;
    }
    if (sendInit(wsRef.current, { takeOver: snapshot })) {
      isTakingOverRef.current = true;
      setIsTakingOver(true);
    }
  }, [sendInit, wsRef]);

  useEffect(() => {
    if (
      !autoConnect ||
      suppressAutoConnectRef.current ||
      !isInitialized ||
      isConnecting ||
      isConnected
    ) {
      return;
    }

    connectToShell();
  }, [autoConnect, connectToShell, isConnected, isConnecting, isInitialized]);

  return {
    isConnected,
    isConnecting,
    claudeLaunchColorScheme,
    sessionBusy,
    isTakingOver,
    closeSocket,
    connectToShell,
    disconnectFromShell,
    retrySessionInit,
    takeOverSession,
  };
}
