import { IS_PLATFORM } from '@/shared/utils';
import { getStoredAuthToken } from '@/shared/authToken';
import type { ShellTakeOverSnapshot } from '@/shared/types';

type ShellInitMessage = {
  type: 'init';
  projectPath: string;
  sessionId: string | null;
  hasSession: boolean;
  provider: string;
  cols: number;
  rows: number;
  initialCommand: string | null | undefined;
  isPlainShell: boolean;
  forceRestart?: boolean;
  bypassPermissions?: boolean;
  // The model to start the CLI on; only an agy shell reads it (--model).
  model?: string;
  // The app theme at launch, so the server can start a CLI in the colour scheme
  // the terminal is painted in.
  colorScheme?: 'light' | 'dark';
  // Asks the server to stop what CloudCLI still runs on the session (the
  // chat turn, the held process with its background tasks and scheduled
  // work) and then start the CLI; sent only after a `session_busy`, with what
  // that frame showed. The server stops nothing if more has started since.
  takeOver?: ShellTakeOverSnapshot;
  // This init's number; the `session_busy` answering it carries it back.
  initId: number;
};

type ShellResizeMessage = {
  type: 'resize';
  cols: number;
  rows: number;
};

type ShellInputMessage = {
  type: 'input';
  data: string;
};

type ShellOutgoingMessage = ShellInitMessage | ShellResizeMessage | ShellInputMessage;

type ShellIncomingMessage =
  | { type: 'output'; data: string }
  // Sent instead of starting a PTY when the project path or session id is
  // rejected, so this is the only signal that the terminal will never start.
  | { type: 'error'; message?: string }
  | { type: 'auth_url'; url?: string }
  // The app theme the Claude CLI in the pty was launched for. A running CLI
  // keeps those colours, including one a reconnect reattaches to.
  | { type: 'claude_theme'; colorScheme?: string }
  // Sent instead of starting the CLI while CloudCLI itself still runs the
  // session; the socket stays open for another init. `initId` is the number
  // of the init it answers. `scheduled` lists the held process's scheduled
  // work (a server older than that sends none).
  | {
    type: 'session_busy';
    sessionId?: string;
    provider?: string;
    reason?: string;
    tasks?: unknown;
    scheduled?: unknown;
    turnStartedAt?: number | null;
    hasQueuedMessage?: boolean;
    changed?: boolean;
    initId?: number;
  }
  | { type: string; [key: string]: unknown };

export function getShellWebSocketUrl(): string | null {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

  if (IS_PLATFORM) {
    return `${protocol}//${window.location.host}/shell`;
  }

  const token = getStoredAuthToken();
  if (!token) {
    console.error('No authentication token found for Shell WebSocket connection');
    return null;
  }

  return `${protocol}//${window.location.host}/shell?token=${encodeURIComponent(token)}`;
}

export function parseShellMessage(payload: string): ShellIncomingMessage | null {
  try {
    return JSON.parse(payload) as ShellIncomingMessage;
  } catch {
    return null;
  }
}

export function sendSocketMessage(ws: WebSocket | null, message: ShellOutgoingMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}
