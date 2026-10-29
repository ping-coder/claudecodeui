import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { useShellConnection } from '@/modules/shell/hooks/useShellConnection';
import ShellSessionBusyNotice from '@/modules/shell/ShellSessionBusyNotice';
import type { BackgroundTaskSummary, Project, ProjectSession, ScheduledWorkSummary, ShellSessionBusy } from '@/shared/types';

/**
 * The server sends `session_busy` instead of starting the CLI while CloudCLI
 * itself still runs the session. The Shell shows why, never asks again on its
 * own, and lets the user ask again or take the session over.
 */

// The URL builder reads a stored auth token and would bail before a socket exists.
vi.mock('@/modules/shell/utils/socket', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getShellWebSocketUrl: () => 'ws://localhost/shell',
}));

// Only the Shell component test reads this; the hook tests use the real connection hook.
const shellRuntime = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@/modules/shell/hooks/useShellRuntime', () => ({
  useShellRuntime: () => shellRuntime.current,
}));

class FakeSocket {
  // sendSocketMessage compares readyState with WebSocket.OPEN, which is this class while stubbed.
  static OPEN = 1;
  static instances: FakeSocket[] = [];

  readyState = 1;
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

  receive(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  inits() {
    return this.sent.filter((frame) => frame.type === 'init');
  }
}

const ref = <T,>(value: T): MutableRefObject<T> => ({ current: value });

const task = (taskId: string, extra: Partial<BackgroundTaskSummary> = {}): BackgroundTaskSummary => ({
  taskId,
  toolUseId: `toolu_${taskId}`,
  taskType: 'local_workflow',
  description: `Task ${taskId}`,
  startedAt: 1,
  ...extra,
});

const SESSION_ID = 'app-1';

const loop = (extra: Partial<ScheduledWorkSummary> = {}): ScheduledWorkSummary => ({
  id: 'cron:b2148320',
  kind: 'cron',
  toolUseId: 'toolu_cron_1',
  prompt: 'check CI',
  startedAt: 1,
  nextFireAt: 300_001,
  recurring: true,
  holdUntil: 691_200_001,
  cron: '*/5 * * * *',
  ...extra,
});

const busyFrame = (fields: Record<string, unknown> = {}) => ({
  type: 'session_busy',
  sessionId: SESSION_ID,
  provider: 'claude',
  reason: 'background',
  tasks: [
    task('wf1', { workflowName: 'audit' }),
    task('n1', { taskType: 'local_bash', nested: true }),
    // Missing fields: not a task the notice could name.
    { taskType: 'local_bash' },
  ],
  turnStartedAt: null,
  hasQueuedMessage: false,
  changed: false,
  ...fields,
});

/** The server's answer to the socket's latest init, which carries that init's number back. */
const answerLatestInit = (socket: FakeSocket, fields: Record<string, unknown> = {}) => {
  socket.receive(busyFrame({ initId: socket.inits().at(-1)?.initId, ...fields }));
};

function renderConnection() {
  const write = vi.fn();
  const wsRef = ref<WebSocket | null>(null);
  const view = renderHook(() =>
    useShellConnection({
      wsRef,
      terminalRef: ref({ write, cols: 80, rows: 24 } as unknown as Terminal | null),
      fitAddonRef: ref({ fit: vi.fn() } as unknown as FitAddon | null),
      selectedProjectRef: ref<Project | null | undefined>({ fullPath: '/tmp/p', path: '/tmp/p' } as Project),
      selectedSessionRef: ref<ProjectSession | null | undefined>({ id: SESSION_ID, __provider: 'claude' } as ProjectSession),
      initialCommandRef: ref<string | null | undefined>(null),
      isPlainShellRef: ref(false),
      bypassPermissionsRef: ref(false),
      modelRef: ref<string | null>(null),
      isDarkModeRef: ref(true),
      onProcessCompleteRef: ref<((exitCode: number) => void) | null | undefined>(null),
      isInitialized: true,
      autoConnect: false,
      // What the Shell runtime's closeSocket does: close it and let go of it.
      closeSocket: () => {
        wsRef.current?.close();
        wsRef.current = null;
      },
      clearTerminalScreen: vi.fn(),
    }),
  );

  const open = () => {
    act(() => {
      view.result.current.connectToShell();
    });
    const socket = FakeSocket.instances.at(-1)!;
    act(() => {
      socket.onopen?.();
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    return socket;
  };

  return { view, write, wsRef, open };
}

describe('the shell connection while CloudCLI still runs the session', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps what the server said, writes nothing to the terminal, and never asks again on its own', () => {
    const { view, write, open } = renderConnection();
    const socket = open();
    expect(socket.inits()).toHaveLength(1);

    act(() => {
      socket.receive(busyFrame());
    });
    expect(view.result.current.sessionBusy).toEqual({
      reason: 'background',
      tasks: [task('wf1', { workflowName: 'audit' }), task('n1', { taskType: 'local_bash', nested: true })],
      hasQueuedMessage: false,
      changed: false,
    });
    expect(write).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(socket.inits()).toHaveLength(1);
  });

  it('reads a queued message, and a reason it does not know as the session being held', () => {
    const { view, open } = renderConnection();
    const socket = open();

    act(() => {
      socket.receive(busyFrame({ reason: 'queued', tasks: [], hasQueuedMessage: true }));
    });
    expect(view.result.current.sessionBusy).toEqual({ reason: 'queued', tasks: [], hasQueuedMessage: true, changed: false });

    act(() => {
      socket.receive(busyFrame({ reason: 'something-newer', tasks: 'not a list', changed: 'yes' }));
    });
    expect(view.result.current.sessionBusy).toEqual({ reason: 'held', tasks: [], hasQueuedMessage: false, changed: false });
  });

  it('a restart\'s first init asks for the restart; asking again later does not', () => {
    const { view } = renderConnection();
    act(() => {
      view.result.current.connectToShell({ forceRestart: true });
    });
    const socket = FakeSocket.instances.at(-1)!;
    act(() => {
      socket.onopen?.();
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(socket.inits()[0].forceRestart).toBe(true);

    act(() => {
      socket.receive(busyFrame());
    });
    act(() => {
      view.result.current.retrySessionInit();
    });
    expect(socket.inits()[1].forceRestart).toBe(false);
  });

  it('ignores a session_busy about another session', () => {
    const { view, open } = renderConnection();
    const socket = open();

    act(() => {
      socket.receive(busyFrame({ sessionId: 'some-other-session' }));
    });
    expect(view.result.current.sessionBusy).toBeNull();
  });

  it('asks again on retry, and takes over until the server answers the takeover', () => {
    const { view, open } = renderConnection();
    const socket = open();
    act(() => {
      answerLatestInit(socket);
    });

    act(() => {
      view.result.current.retrySessionInit();
    });
    expect(socket.inits()).toHaveLength(2);
    expect(socket.inits()[1].takeOver).toBeUndefined();
    expect(socket.inits()[1].forceRestart).toBe(false);
    expect(socket.inits()[1].sessionId).toBe(SESSION_ID);
    expect(view.result.current.isTakingOver).toBe(false);
    act(() => {
      answerLatestInit(socket);
    });

    act(() => {
      view.result.current.takeOverSession();
    });
    expect(socket.inits()).toHaveLength(3);
    expect(socket.inits()[2].takeOver).toEqual({ turnStartedAt: null, taskIds: ['wf1', 'n1'] });
    expect(view.result.current.isTakingOver).toBe(true);

    // Still held after all: the notice comes back with its buttons.
    act(() => {
      answerLatestInit(socket, { reason: 'exiting', tasks: [] });
    });
    expect(view.result.current.isTakingOver).toBe(false);
    expect(view.result.current.sessionBusy?.reason).toBe('exiting');

    act(() => {
      view.result.current.takeOverSession();
    });
    expect(view.result.current.isTakingOver).toBe(true);
    act(() => {
      socket.receive({ type: 'output', data: 'Resuming Claude session' });
    });
    expect(view.result.current.sessionBusy).toBeNull();
    expect(view.result.current.isTakingOver).toBe(false);
  });

  it('numbers every init, each above the last', () => {
    const { view, open } = renderConnection();
    const socket = open();
    act(() => {
      answerLatestInit(socket);
    });
    act(() => {
      view.result.current.retrySessionInit();
    });
    act(() => {
      view.result.current.takeOverSession();
    });

    const initIds = socket.inits().map((frame) => frame.initId as number);
    expect(initIds).toHaveLength(3);
    expect(initIds.every((initId) => typeof initId === 'number')).toBe(true);
    expect(initIds[1] > initIds[0] && initIds[2] > initIds[1]).toBe(true);
  });

  it('takes over what the last notice showed: its turn, and every task id, nested and unlisted ones too', () => {
    const { view, open } = renderConnection();
    const socket = open();
    act(() => {
      answerLatestInit(socket, { reason: 'turn', turnStartedAt: 1000, tasks: [task('earlier')] });
    });

    act(() => {
      view.result.current.retrySessionInit();
    });
    act(() => {
      answerLatestInit(socket, {
        reason: 'turn',
        turnStartedAt: 2000,
        tasks: [
          ...Array.from({ length: 7 }, (_, index) => task(`a${index}`, { taskType: 'local_agent' })),
          task('n1', { taskType: 'local_bash', nested: true }),
          // Still running, though the notice cannot name it.
          { taskId: 'odd1', taskType: 'local_bash' },
          { taskType: 'local_bash' },
        ],
      });
    });
    expect(view.result.current.sessionBusy?.tasks.map((summary) => summary.taskId)).not.toContain('odd1');

    act(() => {
      view.result.current.takeOverSession();
    });
    expect(socket.inits().at(-1)?.takeOver).toEqual({
      turnStartedAt: 2000,
      taskIds: ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'n1', 'odd1'],
    });
  });

  it('keeps the takeover under way through an earlier init\'s answer, until its own', () => {
    const { view, open } = renderConnection();
    const socket = open();
    act(() => {
      answerLatestInit(socket);
    });

    // Try again, then Stop it, both before the server has answered either.
    act(() => {
      view.result.current.retrySessionInit();
    });
    act(() => {
      view.result.current.takeOverSession();
    });
    const [, retry, takeOver] = socket.inits();
    expect(view.result.current.isTakingOver).toBe(true);

    // The server answers inits in order: the retry's answer comes first.
    act(() => {
      socket.receive(busyFrame({ initId: retry.initId, reason: 'exiting', tasks: [] }));
    });
    expect(view.result.current.isTakingOver).toBe(true);
    expect(view.result.current.sessionBusy?.reason).toBe('background');

    act(() => {
      socket.receive(busyFrame({ initId: takeOver.initId, reason: 'turn', tasks: [], changed: true }));
    });
    expect(view.result.current.isTakingOver).toBe(false);
    expect(view.result.current.sessionBusy).toEqual({ reason: 'turn', tasks: [], hasQueuedMessage: false, changed: true });
  });

  it('sends no init from either button while a takeover is under way, even before a re-render', () => {
    const { view, open } = renderConnection();
    const socket = open();
    act(() => {
      answerLatestInit(socket);
    });

    act(() => {
      view.result.current.takeOverSession();
      view.result.current.takeOverSession();
      view.result.current.retrySessionInit();
    });
    act(() => {
      view.result.current.retrySessionInit();
    });
    expect(socket.inits()).toHaveLength(2);
    expect(view.result.current.isTakingOver).toBe(true);
  });

  it('takes nothing over without a notice saying what runs there', () => {
    const { view, open } = renderConnection();
    const socket = open();
    act(() => {
      view.result.current.takeOverSession();
    });
    expect(socket.inits()).toHaveLength(1);
    expect(view.result.current.isTakingOver).toBe(false);

    act(() => {
      answerLatestInit(socket);
    });
    act(() => {
      socket.receive({ type: 'output', data: 'Resuming Claude session' });
    });
    act(() => {
      view.result.current.takeOverSession();
    });
    expect(socket.inits()).toHaveLength(1);
  });

  it('an error frame clears the notice, so the error it writes is not hidden', () => {
    const { view, write, open } = renderConnection();
    const socket = open();
    act(() => {
      socket.receive(busyFrame());
    });
    act(() => {
      view.result.current.takeOverSession();
    });

    act(() => {
      socket.receive({ type: 'error', message: 'Invalid project path' });
    });
    expect(view.result.current.sessionBusy).toBeNull();
    expect(view.result.current.isTakingOver).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('the socket closing clears the notice', () => {
    const { view, open } = renderConnection();
    const socket = open();
    act(() => {
      socket.receive(busyFrame());
    });
    act(() => {
      view.result.current.takeOverSession();
    });

    act(() => {
      socket.onclose?.();
    });
    expect(view.result.current.sessionBusy).toBeNull();
    expect(view.result.current.isTakingOver).toBe(false);
  });

  it('a socket let go of outside the hook still clears the notice when it closes', () => {
    const { view, wsRef, open } = renderConnection();
    const socket = open();
    act(() => {
      socket.receive(busyFrame());
    });

    // The terminal's own teardown closes the socket without disconnecting.
    wsRef.current = null;
    act(() => {
      socket.onclose?.();
    });
    expect(view.result.current.sessionBusy).toBeNull();
  });

  it('disconnecting clears the notice, and a new socket that is told the same can still ask again', () => {
    const { view, open } = renderConnection();
    const first = open();
    act(() => {
      first.receive(busyFrame());
    });
    act(() => {
      view.result.current.takeOverSession();
    });

    act(() => {
      view.result.current.disconnectFromShell();
    });
    expect(view.result.current.sessionBusy).toBeNull();
    expect(view.result.current.isTakingOver).toBe(false);

    const second = open();
    expect(second).not.toBe(first);
    act(() => {
      second.receive(busyFrame());
    });
    expect(view.result.current.sessionBusy?.reason).toBe('background');
    act(() => {
      view.result.current.retrySessionInit();
    });
    expect(second.inits()).toHaveLength(2);
  });

  it('keeps the scheduled work a frame lists, and sends every id of it back with a takeover', () => {
    const { view, open } = renderConnection();
    const socket = open();
    const selfPaced = loop({ id: 'wakeup:toolu_wake_1', kind: 'wakeup', toolUseId: 'toolu_wake_2', cron: undefined });
    act(() => {
      answerLatestInit(socket, {
        reason: 'held',
        tasks: [],
        // The last cannot be named, but it is held all the same.
        scheduled: [loop(), selfPaced, { id: 'cron:0dd1d0e5', kind: 'cron' }],
      });
    });
    expect(JSON.stringify(view.result.current.sessionBusy)).toBe(JSON.stringify({
      reason: 'held',
      tasks: [],
      scheduled: [loop(), selfPaced],
      hasQueuedMessage: false,
      changed: false,
    }));

    act(() => {
      view.result.current.takeOverSession();
    });
    expect(JSON.stringify(socket.inits().at(-1)?.takeOver)).toBe(JSON.stringify({
      turnStartedAt: null,
      taskIds: [],
      scheduledIds: ['cron:b2148320', 'wakeup:toolu_wake_1', 'cron:0dd1d0e5'],
    }));
  });

  it('reads a frame with no scheduled work as before, and sends scheduled ids back only for a frame that lists them', () => {
    const { view, open } = renderConnection();
    const socket = open();
    act(() => {
      answerLatestInit(socket, { scheduled: [] });
    });
    expect(view.result.current.sessionBusy !== null && 'scheduled' in view.result.current.sessionBusy).toBe(false);
    act(() => {
      view.result.current.takeOverSession();
    });
    expect(JSON.stringify(socket.inits().at(-1)?.takeOver)).toBe(JSON.stringify({ turnStartedAt: null, taskIds: ['wf1', 'n1'], scheduledIds: [] }));

    // A server older than scheduled work sends no list, and gets none back.
    act(() => {
      answerLatestInit(socket);
    });
    act(() => {
      view.result.current.takeOverSession();
    });
    const takeOver = socket.inits().at(-1)?.takeOver as Record<string, unknown> | undefined;
    expect(takeOver !== undefined && 'scheduledIds' in takeOver).toBe(false);
  });

  it('a replaced socket that closes late leaves its successor\'s notice alone', () => {
    const { view, open } = renderConnection();
    const first = open();
    act(() => {
      view.result.current.disconnectFromShell();
    });
    const second = open();
    act(() => {
      second.receive(busyFrame({ reason: 'held', tasks: [] }));
    });

    act(() => {
      first.onclose?.();
    });
    expect(view.result.current.sessionBusy?.reason).toBe('held');

    // A late session_busy from the replaced socket is not taken either.
    act(() => {
      first.receive(busyFrame({ reason: 'turn' }));
    });
    expect(view.result.current.sessionBusy?.reason).toBe('held');
  });
});

describe('ShellSessionBusyNotice', () => {
  const busy = (fields: Partial<ShellSessionBusy> = {}): ShellSessionBusy => ({
    reason: 'background',
    tasks: [],
    hasQueuedMessage: false,
    changed: false,
    ...fields,
  });

  const renderNotice = (state: ShellSessionBusy, isTakingOver = false) => {
    const onRetry = vi.fn();
    const onTakeOver = vi.fn();
    const view = render(
      <ShellSessionBusyNotice busy={state} isTakingOver={isTakingOver} onRetry={onRetry} onTakeOver={onTakeOver} />,
    );
    return { view, onRetry, onTakeOver };
  };

  it('says why for each reason', () => {
    const lines: Record<ShellSessionBusy['reason'], string> = {
      turn: 'A chat turn is still running.',
      background: 'Background tasks are still running:',
      held: 'CloudCLI\'s Claude process still has this session open, most likely waiting on a Monitor or a scheduled wake-up.',
      exiting: 'CloudCLI\'s Claude process is shutting down. This usually takes seconds, at most about 6 minutes.',
      queued: 'A queued chat message goes out as soon as the session is free.',
    };
    for (const [reason, line] of Object.entries(lines) as Array<[ShellSessionBusy['reason'], string]>) {
      const { view } = renderNotice(busy({ reason }));
      expect(screen.queryByText('CloudCLI is still using this session') !== null).toBe(true);
      expect(screen.queryByText(line) !== null).toBe(true);
      expect(screen.queryByText(/two processes writing to this session/) !== null).toBe(true);
      view.unmount();
    }
  });

  it('lists the session\'s own tasks, the nested ones only when nothing else is left, five at most', () => {
    const own = renderNotice(busy({
      tasks: [task('wf1', { workflowName: 'audit' }), task('n1', { taskType: 'local_bash', description: 'npm test', nested: true })],
    }));
    expect(screen.queryByText('Workflow audit') !== null).toBe(true);
    expect(screen.queryByText('Command npm test') !== null).toBe(false);
    own.view.unmount();

    const nestedOnly = renderNotice(busy({
      tasks: [task('n1', { taskType: 'local_bash', description: 'npm test', nested: true })],
    }));
    expect(screen.queryByText('Command npm test') !== null).toBe(true);
    nestedOnly.view.unmount();

    renderNotice(busy({
      tasks: Array.from({ length: 7 }, (_, index) => task(`a${index}`, { taskType: 'local_agent', description: `Survey ${index}` })),
    }));
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Agent Survey 0',
      'Agent Survey 1',
      'Agent Survey 2',
      'Agent Survey 3',
      'Agent Survey 4',
      '+2 more',
    ]);
  });

  it('names the scheduled work after the tasks, five items at most together', () => {
    const reminder = loop({ id: 'cron:7b7cd8fc', prompt: 'stretch', recurring: false });
    const few = renderNotice(busy({ tasks: [task('wf1', { workflowName: 'audit' })], scheduled: [loop(), reminder] }));
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Workflow audit', 'Loop check CI', 'Reminder stretch']);
    few.view.unmount();

    renderNotice(busy({
      tasks: Array.from({ length: 4 }, (_, index) => task(`a${index}`, { taskType: 'local_agent', description: `Survey ${index}` })),
      scheduled: [loop(), reminder, loop({ id: 'wakeup:toolu_wake_1', kind: 'wakeup', prompt: '/loop' })],
    }));
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Agent Survey 0',
      'Agent Survey 1',
      'Agent Survey 2',
      'Agent Survey 3',
      'Loop check CI',
      '+2 more',
    ]);
  });

  it('says the process waits for the loops, or runs them beside the tasks; other reasons stay', () => {
    const held = renderNotice(busy({ reason: 'held', scheduled: [loop()] }));
    expect(screen.queryAllByText('This session has loops waiting for their next run:').length).toBe(1);
    expect(screen.queryAllByText(/waiting on a Monitor/).length).toBe(0);
    held.view.unmount();

    const background = renderNotice(busy({ reason: 'background', tasks: [task('wf1', { workflowName: 'audit' })], scheduled: [loop()] }));
    expect(screen.queryAllByText('Background tasks and loops are still running:').length).toBe(1);
    background.view.unmount();

    renderNotice(busy({ reason: 'turn', scheduled: [loop()] }));
    expect(screen.queryAllByText('A chat turn is still running.').length).toBe(1);
    expect(screen.queryAllByText('Loop check CI').length).toBe(1);
  });

  it('calls back once per button', () => {
    const { onRetry, onTakeOver } = renderNotice(busy());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop it and open here' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onTakeOver).toHaveBeenCalledTimes(1);
  });

  it('offers no takeover while a message is queued, and says what to do instead', () => {
    renderNotice(busy({ reason: 'queued', hasQueuedMessage: true }));
    expect(screen.queryByRole('button', { name: 'Stop it and open here' }) === null).toBe(true);
    expect(screen.queryByText('Send or withdraw the queued message in the chat first.') !== null).toBe(true);
    expect(screen.queryByRole('button', { name: 'Try again' }) !== null).toBe(true);
  });

  it('says a refused takeover stopped nothing, and only then', () => {
    const refused = renderNotice(busy({ reason: 'turn', changed: true }));
    expect(screen.queryByText(/so nothing was stopped/) !== null).toBe(true);
    expect(screen.queryByText('A chat turn is still running.') !== null).toBe(true);
    refused.view.unmount();

    renderNotice(busy({ reason: 'turn' }));
    expect(screen.queryByText(/so nothing was stopped/) === null).toBe(true);
  });

  it('disables both buttons while the takeover is under way', () => {
    const { onRetry, onTakeOver } = renderNotice(busy(), true);
    const retry = screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement;
    const takeOver = screen.getByRole('button', { name: 'Stopping…' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(takeOver.disabled).toBe(true);
    fireEvent.click(retry);
    fireEvent.click(takeOver);
    expect(onRetry).not.toHaveBeenCalled();
    expect(onTakeOver).not.toHaveBeenCalled();
  });
});

describe('Shell', () => {
  it('shows the notice over a connected terminal instead of the connect overlay', async () => {
    const retrySessionInit = vi.fn();
    shellRuntime.current = {
      terminalContainerRef: { current: null },
      terminalRef: { current: null },
      wsRef: { current: null },
      isConnected: true,
      isInitialized: true,
      isConnecting: false,
      isClaudeThemeOutdated: false,
      sessionBusy: { reason: 'turn', tasks: [], hasQueuedMessage: false },
      isTakingOver: false,
      connectToShell: () => undefined,
      disconnectFromShell: () => undefined,
      retrySessionInit,
      takeOverSession: () => undefined,
    };
    const { Shell } = await import('@/modules/shell');

    render(
      <Shell
        selectedProject={{ projectId: 'p1', displayName: 'Project One', fullPath: '/tmp/project-one' } as Project}
        selectedSession={{ id: SESSION_ID, __provider: 'claude' } as ProjectSession}
      />,
    );

    expect(screen.queryByText('A chat turn is still running.') !== null).toBe(true);
    expect(screen.queryByText('Continue in Shell') === null).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retrySessionInit).toHaveBeenCalledTimes(1);
  });

  it('leaves the connect overlay alone while no socket is open', async () => {
    shellRuntime.current = {
      terminalContainerRef: { current: null },
      terminalRef: { current: null },
      wsRef: { current: null },
      isConnected: false,
      isInitialized: true,
      isConnecting: false,
      isClaudeThemeOutdated: false,
      sessionBusy: { reason: 'turn', tasks: [], hasQueuedMessage: false },
      isTakingOver: false,
      connectToShell: () => undefined,
      disconnectFromShell: () => undefined,
      retrySessionInit: () => undefined,
      takeOverSession: () => undefined,
    };
    const { Shell } = await import('@/modules/shell');

    render(
      <Shell
        selectedProject={{ projectId: 'p1', displayName: 'Project One', fullPath: '/tmp/project-one' } as Project}
        selectedSession={{ id: SESSION_ID, __provider: 'claude' } as ProjectSession}
      />,
    );

    expect(screen.queryByText('Continue in Shell') !== null).toBe(true);
    expect(screen.queryByText('A chat turn is still running.') === null).toBe(true);
  });
});
