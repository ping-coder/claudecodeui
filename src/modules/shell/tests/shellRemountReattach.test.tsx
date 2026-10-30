import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useShellConnection } from '@/modules/shell/hooks/useShellConnection';
import type { Project, ProjectSession } from '@/shared/types';

/**
 * The workspace's refresh mounts a terminal again rather than restarting it. A mounting terminal
 * connects on its own and its init asks for no restart, so the server reattaches it to the shell it kept
 * and replays the output; only the restart button (connectToShell with forceRestart) asks the server to
 * kill that shell.
 */

// The URL builder reads a stored auth token and would bail before a socket exists.
vi.mock('@/modules/shell/utils/socket', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getShellWebSocketUrl: () => 'ws://localhost/shell',
}));

class FakeSocket {
  // sendSocketMessage compares readyState with WebSocket.OPEN, which is this class while stubbed.
  static OPEN = 1;
  static instances: FakeSocket[] = [];

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<Record<string, unknown>> = [];

  constructor() {
    FakeSocket.instances.push(this);
  }

  send(payload: string) {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }

  close() {
    this.readyState = 3;
  }

  inits() {
    return this.sent.filter((frame) => frame.type === 'init');
  }
}

const ref = <T,>(value: T): MutableRefObject<T> => ({ current: value });

/** A terminal as the Shell mounts it: connecting on its own, closing its socket when it goes. */
const mountTerminal = () => {
  const wsRef = ref<WebSocket | null>(null);
  const view = renderHook(() => useShellConnection({
    wsRef,
    terminalRef: ref({ write: vi.fn(), cols: 80, rows: 24 } as unknown as Terminal | null),
    fitAddonRef: ref({ fit: vi.fn() } as unknown as FitAddon | null),
    selectedProjectRef: ref<Project | null | undefined>({ projectId: 'p1', displayName: 'p', fullPath: '/repo', path: '/repo' }),
    selectedSessionRef: ref<ProjectSession | null | undefined>({ id: 'session-1', __provider: 'claude' }),
    initialCommandRef: ref<string | null | undefined>(null),
    isPlainShellRef: ref(false),
    bypassPermissionsRef: ref(false),
    modelRef: ref<string | null>(null),
    isDarkModeRef: ref(true),
    onProcessCompleteRef: ref<((exitCode: number) => void) | null | undefined>(null),
    isInitialized: true,
    autoConnect: true,
    closeSocket: () => {
      wsRef.current?.close();
      wsRef.current = null;
    },
    clearTerminalScreen: vi.fn(),
  }));
  return {
    view,
    unmount: () => {
      // What the Shell runtime does when the terminal goes.
      wsRef.current?.close();
      wsRef.current = null;
      view.unmount();
    },
  };
};

/** The server accepts the socket; the init follows once the terminal has been fitted. */
const openLatestSocket = () => {
  const socket = FakeSocket.instances.at(-1) as FakeSocket;
  act(() => {
    socket.readyState = 1;
    socket.onopen?.();
  });
  act(() => {
    vi.advanceTimersByTime(100);
  });
  return socket;
};

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('a terminal mounted again connects on its own and asks to reattach, not to restart', () => {
  const first = mountTerminal();
  const firstSocket = openLatestSocket();
  assert.equal(firstSocket.inits().length, 1);
  assert.equal(firstSocket.inits()[0].forceRestart, false);

  first.unmount();
  assert.equal(firstSocket.readyState, 3);
  mountTerminal();
  const secondSocket = openLatestSocket();

  assert.equal(FakeSocket.instances.length, 2);
  assert.equal(secondSocket.inits().length, 1);
  assert.equal(secondSocket.inits()[0].forceRestart, false);
  assert.equal(secondSocket.inits()[0].sessionId, 'session-1');
});

test('only the restart path asks the server to restart the shell', () => {
  const terminal = mountTerminal();
  openLatestSocket();
  act(() => {
    terminal.view.result.current.disconnectFromShell({ suppressAutoConnect: true });
  });
  act(() => {
    terminal.view.result.current.connectToShell({ forceRestart: true });
  });

  const restarted = openLatestSocket();
  assert.equal(restarted.inits()[0].forceRestart, true);
});
