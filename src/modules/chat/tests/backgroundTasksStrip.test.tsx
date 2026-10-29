import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { ComponentProps } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import { i18n } from '@/modules/i18n';
import { BackgroundTasksStrip } from '@/modules/chat/transcript/BackgroundTasksStrip';
import { visibleCountToReveal } from '@/modules/chat/hooks/useChatSessionState';
import { SESSION_MESSAGES_PAGE_SIZE } from '@/modules/chat/utils/sessionMessagePagination';
import type { ChatMessage, ScheduledWorkSummary } from '@/shared/types';

// The socket the scheduled work's stop is answered on, the running-sessions
// read a stop that ended asks for, and the activity map a started stop marks
// the session busy in; the chips for scheduled work use all three.
const page = vi.hoisted(() => {
  const listeners = new Set<(frame: Record<string, unknown>) => void>();
  const state = { refreshes: 0, releaseRefresh: null as (() => void) | null, processing: [] as Array<string | null> };
  return {
    listeners,
    state,
    subscribe: (listener: (frame: Record<string, unknown>) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // Held until a test lets it settle, as a read in flight is.
    refreshRunningSessions: () => {
      state.refreshes += 1;
      return new Promise<void>((resolve) => {
        state.releaseRefresh = resolve;
      });
    },
    markSessionProcessing: (sessionId: string | null) => {
      state.processing.push(sessionId);
    },
  };
});

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: page.subscribe }),
}));

vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useSessionProtectionActions: () => ({
    refreshRunningSessions: page.refreshRunningSessions,
    markSessionProcessing: page.markSessionProcessing,
  }),
}));

const toolRow = (overrides: Partial<ChatMessage>): ChatMessage => ({
  type: 'assistant',
  content: '',
  timestamp: '2026-08-21T10:32:10.000Z',
  isToolUse: true,
  ...overrides,
});

describe('the background tasks strip', () => {
  it('lists a running workflow and a running agent with what each has got to', () => {
    render(
      <BackgroundTasksStrip
        sessionId="session-1"
        canStopTasks
        sendMessage={() => {}}
        onReveal={() => {}}
        onLoadAll={() => {}}
        messages={[
          toolRow({ toolName: 'Read', toolId: 'toolu_read', toolInput: '{}' }),
          toolRow({
            toolName: 'Workflow',
            toolId: 'toolu_workflow_1',
            taskStatus: { status: 'running', workflowName: 'frontend-architecture-audit', summary: 'Verify 3/6' },
          }),
          toolRow({
            toolName: 'Agent',
            toolId: 'toolu_agent_1',
            isSubagentContainer: true,
            taskStatus: { status: 'running', description: 'Survey the repo', usage: { totalTokens: 1, toolUses: 12, durationMs: 1 } },
          }),
          // Finished: the live notification has landed.
          toolRow({
            toolName: 'Workflow',
            toolId: 'toolu_workflow_2',
            taskStatus: { status: 'completed', workflowName: 'review-p1' },
          }),
        ]}
      />,
    );

    const chips = screen.getAllByRole('button');
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'Workflowfrontend-architecture-audit· Verify 3/6',
      'AgentSurvey the repo· 12 tools',
    ]);
  });

  it('says how many of a workflow\'s agents have finished and which one it is on', () => {
    // Once the stream reports on the run's agents, that beats its summary —
    // which only restates the workflow's description.
    render(
      <BackgroundTasksStrip
        onReveal={() => {}}
        onLoadAll={() => {}}
        sessionId="session-1"
        canStopTasks
        sendMessage={() => {}}
        messages={[
          toolRow({
            toolName: 'Workflow',
            toolId: 'toolu_workflow_1',
            taskStatus: {
              status: 'running',
              workflowName: 'frontend-architecture-audit',
              summary: 'Evidence-based audit of the frontend',
              agents: [
                { index: 0, label: 'audit:chat', agentId: 'aa1e064cf8bd159d6', state: 'done', startedAt: 1 },
                { index: 1, label: 'audit:sidebar', agentId: 'a9cfe29aa8f2afcbf', state: 'running', startedAt: 2 },
                { index: 2, label: 'audit:files', agentId: 'ab89f2cde612a51b1', state: 'failed', startedAt: 3 },
                { index: 3, label: 'synthesize', state: 'queued' },
              ],
            },
          }),
        ]}
      />,
    );

    expect(screen.getByRole('button').textContent).toBe('Workflowfrontend-architecture-audit· 2/4 agents · audit:sidebar');
  });

  it('renders nothing when no task is running', () => {
    const { container } = render(
      <BackgroundTasksStrip
        sessionId="session-1"
        canStopTasks
        sendMessage={() => {}}
        onReveal={() => {}}
        onLoadAll={() => {}}
        messages={[
          toolRow({ toolName: 'Read', toolId: 'toolu_read', toolInput: '{}' }),
          toolRow({
            toolName: 'Workflow',
            toolId: 'toolu_workflow_2',
            workflow: { runId: 'wf_1', name: 'review-p1', status: 'completed', agents: [], agentCounts: { total: 0, completed: 0, failed: 0, running: 0, stopped: 0 } },
          }),
        ]}
      />,
    );

    expect(container.innerHTML).toBe('');
  });

  it('keeps a workflow the last history load left running, before any live event', () => {
    // A page reloaded mid-run: the store has no task events yet, but the
    // backend read the journal and knows the run is still going.
    render(
      <BackgroundTasksStrip
        sessionId="session-1"
        canStopTasks
        sendMessage={() => {}}
        onReveal={() => {}}
        onLoadAll={() => {}}
        messages={[
          toolRow({
            toolName: 'Workflow',
            toolId: 'toolu_workflow_1',
            workflow: {
              runId: 'wf_1',
              name: 'frontend-architecture-audit',
              status: 'running',
              agents: [
                { id: 'a1', status: 'completed' },
                { id: 'a2', status: 'running' },
              ],
              agentCounts: { total: 2, completed: 1, failed: 0, running: 1, stopped: 0 },
            },
          }),
        ]}
      />,
    );

    expect(screen.getByRole('button').textContent).toBe('Workflowfrontend-architecture-audit· 1/2');
  });

  it('asks the pane to reveal the task\'s row when its chip is clicked', () => {
    // The row may be outside the visible window or in an unmounted lazy row,
    // so the strip cannot reach it with an element lookup of its own; the
    // pane's session state widens the window and scrolls the row's wrapper.
    const onReveal = vi.fn();
    const row = toolRow({
      toolName: 'Workflow',
      toolId: 'toolu_workflow_1',
      taskStatus: { status: 'running', workflowName: 'frontend-architecture-audit' },
    });

    render(<BackgroundTasksStrip sessionId="session-1" canStopTasks sendMessage={() => {}} onReveal={onReveal} onLoadAll={() => {}} messages={[row]} />);

    fireEvent.click(screen.getByRole('button'));
    expect(onReveal).toHaveBeenCalledWith(row);
  });

  it('clips a long progress summary inside the chip and keeps the whole text in the title', () => {
    // The progress span was `flex-shrink-0`: a summary of a few dozen words
    // ran out of the chip's background and across the transcript.
    const summary = 'Phase 2 of 6: three agents in sequence review the composer, the transcript and the sidebar for overflow';
    render(
      <BackgroundTasksStrip
        sessionId="session-1"
        canStopTasks
        sendMessage={() => {}}
        onReveal={() => {}}
        onLoadAll={() => {}}
        messages={[toolRow({
          toolName: 'Workflow',
          toolId: 'toolu_workflow_1',
          toolInput: JSON.stringify({ description: 'Audit the frontend', script: '' }),
          taskStatus: { status: 'running', workflowName: 'frontend-architecture-audit', summary },
        })]}
      />,
    );

    const chip = screen.getByRole('button');
    const progress = chip.lastElementChild as HTMLElement;
    expect(progress.textContent).toBe(`· ${summary}`);
    expect(progress.className).toContain('truncate');
    expect(progress.className).toContain('min-w-0');
    expect(progress.className).not.toContain('flex-shrink-0');
    expect(chip.title).toBe(`Workflow · frontend-architecture-audit · ${summary}`);
    expect(chip.parentElement?.className).toContain('max-w-full');
  });

  it('does not repeat the launch\'s description as progress', () => {
    // A workflow's first progress report carries its own description as the
    // summary, which the card already shows in its header and the chip in
    // its name; as progress it is only noise, and long.
    render(
      <BackgroundTasksStrip
        sessionId="session-1"
        canStopTasks
        sendMessage={() => {}}
        onReveal={() => {}}
        onLoadAll={() => {}}
        messages={[
          toolRow({
            toolName: 'Workflow',
            toolId: 'toolu_workflow_1',
            toolInput: JSON.stringify({ description: 'Evidence-based audit of the frontend', script: '' }),
            taskStatus: { status: 'running', workflowName: 'audit', summary: 'Evidence-based audit of the frontend' },
          }),
          toolRow({
            toolName: 'Agent',
            toolId: 'toolu_agent_1',
            isSubagentContainer: true,
            taskStatus: { status: 'running', description: 'Survey the repo', summary: 'Survey the repo' },
          }),
        ]}
      />,
    );

    expect(screen.getAllByRole('button').map((chip) => chip.textContent)).toEqual([
      'Workflowaudit',
      'AgentSurvey the repo',
    ]);
  });

  it('knows the launch\'s description from the script\'s meta header when the input has none', () => {
    // The CLI does not pass a workflow's description as tool input; it is in
    // the script's `export const meta`, and the run's first summary restates it.
    render(
      <BackgroundTasksStrip
        sessionId="session-1"
        canStopTasks
        sendMessage={() => {}}
        onReveal={() => {}}
        onLoadAll={() => {}}
        messages={[
          toolRow({
            toolName: 'Workflow',
            toolId: 'toolu_workflow_1',
            toolInput: JSON.stringify({ script: "export const meta = {\n  name: 'audit',\n  description: 'Evidence-based audit of the frontend',\n}\nreturn 1" }),
            taskStatus: { status: 'running', workflowName: 'audit', summary: 'Evidence-based audit of the frontend' },
          }),
        ]}
      />,
    );

    expect(screen.getByRole('button').textContent).toBe('Workflowaudit');
  });

  it('stops a task over the websocket from its chip, by the id its events or acknowledgement named', () => {
    const sendMessage = vi.fn();
    render(
      <BackgroundTasksStrip
        sessionId="session-1"
        canStopTasks
        sendMessage={sendMessage}
        onReveal={() => {}}
        onLoadAll={() => {}}
        messages={[
          // Named by the live start event.
          toolRow({
            toolName: 'Workflow',
            toolId: 'toolu_workflow_1',
            taskStatus: { status: 'running', taskId: 'wxkj4kcvd', workflowName: 'audit' },
          }),
          // Named only by the launch acknowledgement: the page loaded after
          // the start event went by. A real async agent's acknowledgement
          // carries no `taskId` — its `agentId` is the task's id.
          toolRow({
            toolName: 'Agent',
            toolId: 'toolu_agent_1',
            subagent: { id: 'a1', description: 'Survey the repo', status: 'running' },
            toolResult: { content: '', isError: false, toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a1' } },
          }),
          // A backgrounded command's acknowledgement spells it differently.
          toolRow({
            toolName: 'Bash',
            toolId: 'toolu_bash_1',
            taskStatus: { status: 'running', description: 'npm test' },
            toolResult: { content: '', isError: false, toolUseResult: { backgroundTaskId: 'b5xsbzu5k' } },
          }),
          // Nothing has named this one, so nothing can stop it.
          toolRow({
            toolName: 'Agent',
            toolId: 'toolu_agent_2',
            subagent: { id: '', description: 'Unnamed', status: 'running' },
          }),
        ]}
      />,
    );

    const stops = screen.getAllByRole('button', { name: 'Stop' });
    expect(stops).toHaveLength(3);
    stops.forEach((stop) => fireEvent.click(stop));

    expect(sendMessage.mock.calls.map(([frame]) => frame)).toEqual([
      { type: 'chat.stop-task', sessionId: 'session-1', taskId: 'wxkj4kcvd' },
      { type: 'chat.stop-task', sessionId: 'session-1', taskId: 'a1' },
      { type: 'chat.stop-task', sessionId: 'session-1', taskId: 'b5xsbzu5k' },
    ]);
  });
});

describe('the background tasks strip, for a task whose launch row is not loaded', () => {
  const tasks = [
    { taskId: 'wxkj4kcvd', toolUseId: 'toolu_workflow_1', taskType: 'local_workflow', description: 'Audit the frontend', workflowName: 'audit', startedAt: 1 },
    // Launched by one of the workflow's agents: its business, not the session's.
    { taskId: 'b5xsbzu5k', toolUseId: 'toolu_inner', taskType: 'local_bash', description: 'Sleep for 60 seconds', startedAt: 2, nested: true },
  ];

  it('lists it from the activity map, loads the transcript on click, and can stop it', () => {
    // A reload of a long session loads its last page; a workflow launched
    // pages earlier has no row here, but the running-sessions poll knows it.
    const sendMessage = vi.fn();
    const onLoadAll = vi.fn();
    render(
      <BackgroundTasksStrip
        sessionId="session-1"
        canStopTasks
        sendMessage={sendMessage}
        onReveal={() => {}}
        onLoadAll={onLoadAll}
        messages={[toolRow({ toolName: 'Read', toolId: 'toolu_read', toolInput: '{}' })]}
        tasks={tasks}
      />,
    );

    const chips = screen.getAllByRole('button');
    expect(chips.map((chip) => chip.textContent)).toEqual(['Workflowaudit', '']);
    expect(chips[0]?.title).toBe('Workflow · audit · Launched earlier in this conversation; click to load it');
    fireEvent.click(chips[0]!);
    expect(onLoadAll).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(sendMessage).toHaveBeenCalledWith({ type: 'chat.stop-task', sessionId: 'session-1', taskId: 'wxkj4kcvd' });
  });

  it('defers to the loaded row once the transcript has it, settled or not', () => {
    // The row is the word on its task: a settled one must not come back as
    // a chip from a poll that has not caught up.
    const { container } = render(
      <BackgroundTasksStrip
        sessionId="session-1"
        canStopTasks
        sendMessage={() => {}}
        onReveal={() => {}}
        onLoadAll={() => {}}
        messages={[toolRow({
          toolName: 'Workflow',
          toolId: 'toolu_workflow_1',
          taskStatus: { status: 'completed', taskId: 'wxkj4kcvd', workflowName: 'audit' },
        })]}
        tasks={tasks}
      />,
    );

    expect(container.innerHTML).toBe('');
  });
});

describe('the background tasks strip, for tasks only the activity map has a word on', () => {
  it('lists a backgrounded command whose loaded launch row has no status of its own', () => {
    // A backgrounded command's row from history says nothing about its task
    // until a live event does; the poll knows it is running, and the ✕ is
    // the only way to stop it.
    const sendMessage = vi.fn();
    render(
      <BackgroundTasksStrip
        sessionId="session-1"
        canStopTasks
        sendMessage={sendMessage}
        onReveal={() => {}}
        onLoadAll={() => {}}
        messages={[toolRow({
          toolName: 'Bash',
          toolId: 'toolu_bash_1',
          toolInput: JSON.stringify({ command: 'npm test', run_in_background: true }),
          toolResult: { content: '', isError: false, toolUseResult: { backgroundTaskId: 'b5xsbzu5k' } },
        })]}
        tasks={[{ taskId: 'b5xsbzu5k', toolUseId: 'toolu_bash_1', taskType: 'local_bash', description: 'npm test', startedAt: 1 }]}
      />,
    );

    expect(screen.getAllByRole('button').map((chip) => chip.textContent)).toEqual(['Commandnpm test', '']);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(sendMessage).toHaveBeenCalledWith({ type: 'chat.stop-task', sessionId: 'session-1', taskId: 'b5xsbzu5k' });
  });

  it('draws a task one of the session\'s agents launched without offering to load a row it has none of', () => {
    const onLoadAll = vi.fn();
    render(
      <BackgroundTasksStrip
        sessionId="session-1"
        canStopTasks
        sendMessage={() => {}}
        onReveal={() => {}}
        onLoadAll={onLoadAll}
        messages={[toolRow({
          toolName: 'Workflow',
          toolId: 'toolu_workflow_1',
          taskStatus: { status: 'completed', taskId: 'wxkj4kcvd', workflowName: 'audit' },
        })]}
        tasks={[{ taskId: 'b5xsbzu5k', toolUseId: 'toolu_inner', taskType: 'local_bash', description: 'Sleep for 60 seconds', startedAt: 2, nested: true }]}
      />,
    );

    // The chip is a plain label with the Stop beside it: nothing to click into.
    expect(screen.getAllByRole('button').map((chip) => chip.getAttribute('aria-label'))).toEqual(['Stop']);
    const chip = screen.getByTitle(/Launched by one of this session's agents/);
    expect(chip.textContent).toBe('CommandSleep for 60 seconds');
    fireEvent.click(chip);
    expect(onLoadAll).not.toHaveBeenCalled();
  });

  it('counts one agent in the singular', () => {
    render(
      <BackgroundTasksStrip
        sessionId="session-1"
        canStopTasks
        sendMessage={() => {}}
        onReveal={() => {}}
        onLoadAll={() => {}}
        messages={[toolRow({
          toolName: 'Workflow',
          toolId: 'toolu_workflow_1',
          taskStatus: { status: 'running', workflowName: 'audit', agents: [{ index: 0, label: 'only', agentId: 'a1', state: 'running' }] },
        })]}
      />,
    );

    expect(screen.getByRole('button').textContent).toBe('Workflowaudit· 0/1 agent · only');
  });
});

describe('the background tasks strip, for tasks only a Claude CLI outside CloudCLI can stop', () => {
  // The async launches of a Claude CLI CloudCLI does not drive (a Shell tab's
  // `claude --resume`, another CloudCLI instance), as a history load returns
  // them while that CLI lives: read running, their acknowledgements naming
  // tasks that only that CLI tracks. A stop for one is refused as
  // NO_SUCH_TASK, which lands in the transcript as an error row.
  const cliRows = [
    toolRow({
      toolName: 'Workflow',
      toolId: 'toolu_workflow_cli',
      workflow: {
        runId: 'wf_cli',
        name: 'frontend-audit',
        status: 'running',
        agents: [{ id: 'a1', status: 'running' }],
        agentCounts: { total: 1, completed: 0, failed: 0, running: 1, stopped: 0 },
      },
      toolResult: {
        content: 'Workflow launched in background. Task ID: wcli1',
        isError: false,
        toolUseResult: { status: 'async_launched', taskId: 'wcli1', runId: 'wf_cli' },
      },
    }),
    toolRow({
      toolName: 'Agent',
      toolId: 'toolu_agent_cli',
      isSubagentContainer: true,
      subagent: { id: 'acli2', description: 'Survey the repo', status: 'running' },
      toolResult: { content: '', isError: false, toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'acli2' } },
    }),
  ];

  it('lists them without a ✕, which the server could only refuse', () => {
    const sendMessage = vi.fn();
    const onReveal = vi.fn();
    render(
      <BackgroundTasksStrip
        sessionId="app-session"
        canStopTasks={false}
        sendMessage={sendMessage}
        onReveal={onReveal}
        onLoadAll={() => {}}
        messages={cliRows}
      />,
    );

    // Still listed, and still a way to the card.
    const chips = screen.getAllByRole('button');
    expect(chips.map((chip) => chip.textContent)).toEqual(['Workflowfrontend-audit· 0/1', 'AgentSurvey the repo']);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    chips.forEach((chip) => fireEvent.click(chip));
    expect(onReveal).toHaveBeenCalledTimes(2);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('offers it on the same rows while CloudCLI\'s runtime drives the session', () => {
    const sendMessage = vi.fn();
    render(
      <BackgroundTasksStrip
        sessionId="app-session"
        canStopTasks
        sendMessage={sendMessage}
        onReveal={() => {}}
        onLoadAll={() => {}}
        messages={cliRows}
      />,
    );

    screen.getAllByRole('button', { name: 'Stop' }).forEach((stop) => fireEvent.click(stop));
    expect(sendMessage.mock.calls.map(([frame]) => frame)).toEqual([
      { type: 'chat.stop-task', sessionId: 'app-session', taskId: 'wcli1' },
      { type: 'chat.stop-task', sessionId: 'app-session', taskId: 'acli2' },
    ]);
  });
});

describe('the background tasks strip, for scheduled work', () => {
  // Local times: the strip tells a next run against the browser's clock and day.
  const NOW = new Date(2026, 9, 29, 10, 0).getTime();
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
  const clock = (time: number) => new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' }).format(new Date(time));

  const loop = (overrides: Partial<ScheduledWorkSummary> = {}): ScheduledWorkSummary => ({
    id: 'cron:b2148320',
    kind: 'cron',
    toolUseId: 'toolu_cron_1',
    prompt: 'check CI',
    startedAt: NOW - 60_000,
    nextFireAt: at(29, 14, 5),
    recurring: true,
    holdUntil: NOW + 8 * 86_400_000,
    cron: '*/5 * * * *',
    cadence: 'Every 5 minutes',
    expiresAt: NOW + 7 * 86_400_000,
    ...overrides,
  });
  const reminder = (overrides: Partial<ScheduledWorkSummary> = {}): ScheduledWorkSummary => loop({
    id: 'cron:7b7cd8fc',
    toolUseId: 'toolu_cron_2',
    prompt: 'stretch',
    nextFireAt: at(29, 14, 30),
    recurring: false,
    cron: '30 14 29 10 *',
    cadence: 'Once at 2:30 PM',
    expiresAt: undefined,
    ...overrides,
  });
  const selfPaced = (overrides: Partial<ScheduledWorkSummary> = {}): ScheduledWorkSummary => ({
    id: 'wakeup:toolu_wake_1',
    kind: 'wakeup',
    toolUseId: 'toolu_wake_3',
    prompt: 'check the deploy',
    startedAt: NOW - 600_000,
    nextFireAt: at(29, 14, 5),
    recurring: true,
    holdUntil: NOW + 8 * 86_400_000,
    reason: 'waiting for the deploy',
    ...overrides,
  });

  type StripProps = ComponentProps<typeof BackgroundTasksStrip>;
  // The id the latest stop carried, which the server's answers to it carry back.
  let lastStopId: string | undefined;
  const renderStrip = (overrides: Partial<StripProps> = {}) => {
    const sendMessage = vi.fn((message: unknown) => {
      const frame = message as Record<string, unknown>;
      if (frame.type === 'chat.stop-task' && typeof frame.clientRequestId === 'string') {
        lastStopId = frame.clientRequestId;
      }
    });
    const onReveal = vi.fn();
    const onLoadAll = vi.fn();
    const view = render(
      <BackgroundTasksStrip
        sessionId="session-1"
        canStopTasks
        sendMessage={sendMessage}
        onReveal={onReveal}
        onLoadAll={onLoadAll}
        messages={[]}
        scheduled={[loop()]}
        {...overrides}
      />,
    );
    return { ...view, sendMessage, onReveal, onLoadAll };
  };

  /** The chip that names an item, by its prompt. */
  const chip = (prompt: string) => screen.getAllByRole('button').find((button) => button.textContent?.includes(prompt));
  const stopButtons = () => screen.queryAllByRole('button', { name: 'Stop' });
  const emit = (frame: Record<string, unknown>) => act(() => {
    for (const listener of [...page.listeners]) {
      listener(frame);
    }
  });
  /** An answer to the latest stop, as the server sends it: with the id that stop carried. */
  const status = (fields: Record<string, unknown>) => ({
    kind: 'stop_task_status',
    sessionId: 'session-1',
    taskId: 'cron:b2148320',
    ...(lastStopId ? { clientRequestId: lastStopId } : {}),
    timestamp: '2026-10-29T02:00:00.000Z',
    ...fields,
  });
  type SentFrames = { mock: { calls: unknown[][] } };
  /** The frames a strip sent, less the id each stop carries, which `stopIds` reads. */
  const framesSent = (sendMessage: SentFrames) => sendMessage.mock.calls.map(([frame]) => {
    const { clientRequestId: _clientRequestId, ...rest } = frame as Record<string, unknown>;
    return JSON.stringify(rest);
  });
  const stopIds = (sendMessage: SentFrames) => sendMessage.mock.calls.map(([frame]) => (frame as Record<string, unknown>).clientRequestId);
  const settleRefresh = () => act(async () => {
    page.state.releaseRefresh?.();
    await Promise.resolve();
  });
  /** Clicks an item's ✕ and confirms on the strip, with Stop or Stop all. */
  const confirmStop = (index: number, choice: RegExp = /^Stop$/) => {
    fireEvent.click(stopButtons()[index]);
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: choice }));
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    page.state.refreshes = 0;
    page.state.releaseRefresh = null;
    page.state.processing = [];
    lastStopId = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists each kind after the tasks: a clock in blue, no pulse, how often and when it runs next', () => {
    renderStrip({
      messages: [toolRow({ toolName: 'Agent', toolId: 'toolu_agent_1', taskStatus: { status: 'running', description: 'Survey the repo' } })],
      scheduled: [loop(), reminder(), selfPaced()],
    });

    const chips = screen.getAllByRole('button').filter((button) => button.getAttribute('aria-label') !== 'Stop');
    expect(chips.map((button) => button.textContent)).toEqual([
      'AgentSurvey the repo',
      `Loopcheck CI· Every 5 minutes · Next: ${clock(at(29, 14, 5))}`,
      `Reminderstretch· ${clock(at(29, 14, 30))}`,
      `Loopcheck the deploy· Self-paced · Next: ${clock(at(29, 14, 5))}`,
    ]);
    const loopChip = chip('check CI');
    expect(loopChip?.querySelector('.text-blue-500') !== null).toBe(true);
    expect(loopChip?.querySelector('.animate-pulse') === null).toBe(true);
  });

  it('keeps the details in the tooltip, and says when a run has come or will not happen', () => {
    renderStrip({
      scheduled: [
        loop({ durable: true }),
        selfPaced({ nextFireAt: NOW - 1_000 }),
        reminder({ nextFireAt: NOW + 10 * 86_400_000 }),
      ],
    });

    expect(chip('check CI')?.title.split('\n').slice(0, 2)).toEqual(['check CI', '*/5 * * * * · Every 5 minutes (server time)']);
    expect(chip('check CI')?.title.includes('Kept in the project\'s .claude/scheduled_tasks.json')).toBe(true);
    expect(chip('check the deploy')?.title).toBe('check the deploy\nReason: waiting for the deploy');
    expect(chip('check the deploy')?.textContent).toBe('Loopcheck the deploy· Self-paced · Due now');
    expect(chip('stretch')?.textContent?.endsWith('· Past the hold limit, will not run')).toBe(true);
  });

  it('scrolls to the call that made an item, or loads the rest of the transcript when that row is not loaded', () => {
    const call = toolRow({ toolName: 'CronCreate', toolId: 'toolu_cron_1', toolInput: '{}' });
    const { onReveal, onLoadAll } = renderStrip({ messages: [call], scheduled: [loop(), selfPaced()] });

    fireEvent.click(chip('check CI')!);
    fireEvent.click(chip('check the deploy')!);
    expect(onReveal.mock.calls.length === 1 && onReveal.mock.calls[0][0] === call).toBe(true);
    expect(onLoadAll.mock.calls.length).toBe(1);
  });

  it('offers no ✕ for a job an older CLI gave no id, nor for a session CloudCLI does not drive', () => {
    renderStrip({ scheduled: [loop({ id: 'cron:call:toolu_cron_1' })] });
    expect(stopButtons().length).toBe(0);
    expect(chip('check CI') !== undefined).toBe(true);

    renderStrip({ canStopTasks: false, scheduled: [selfPaced()] });
    expect(stopButtons().length).toBe(0);
  });

  it('asks on the strip first, in words that follow what the stop takes', () => {
    const { unmount } = renderStrip({ scheduled: [selfPaced()] });
    fireEvent.click(stopButtons()[0]);
    expect(within(screen.getByRole('group')).getByText('Stop this loop?').textContent).toBe('Stop this loop?');
    expect(document.activeElement?.textContent).toBe('Cancel');
    unmount();

    renderStrip({ scheduled: [loop(), reminder()] });
    fireEvent.click(stopButtons()[0]);
    expect(screen.getByRole('group').textContent?.startsWith('Stop this loop? CloudCLI runs one turn with the current model to have Claude cancel it.')).toBe(true);
    fireEvent.click(stopButtons()[1]);
    expect(screen.getByRole('group').textContent?.startsWith('Cancel this reminder? CloudCLI runs one turn')).toBe(true);
  });

  it('asks for a turn to stop a self-paced loop while a task keeps the process held', () => {
    renderStrip({
      scheduled: [selfPaced()],
      tasks: [{ taskId: 't1', toolUseId: 'toolu_t1', taskType: 'local_bash', description: 'npm run dev', startedAt: NOW }],
    });
    fireEvent.click(stopButtons().at(-1)!);
    expect(screen.getByRole('group').textContent?.startsWith('Stop this loop? CloudCLI runs one turn')).toBe(true);
  });

  it('sends the stop and shows the item stopping; with two or more it can stop them all at once', () => {
    const { sendMessage, unmount } = renderStrip({ scheduled: [loop()] });
    fireEvent.click(stopButtons()[0]);
    expect(within(screen.getByRole('group')).queryAllByRole('button', { name: /^Stop all/ }).length).toBe(0);
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: 'Stop' }));
    expect(framesSent(sendMessage)).toEqual([
      JSON.stringify({ type: 'chat.stop-task', sessionId: 'session-1', taskId: 'cron:b2148320' }),
    ]);
    // An id of its own, in the shape the server hands back.
    const [sentId] = stopIds(sendMessage);
    expect(typeof sentId === 'string' && /^[\w-]{1,128}$/.test(sentId)).toBe(true);
    expect(screen.queryAllByRole('group').length).toBe(0);
    expect(screen.getByText('Stopping…').textContent).toBe('Stopping…');
    expect(stopButtons().length).toBe(0);
    unmount();

    const all = renderStrip({ scheduled: [loop(), selfPaced(), loop({ id: 'cron:call:toolu_old', prompt: 'old job' })] });
    confirmStop(1, /^Stop all \(2\)$/);
    expect(framesSent(all.sendMessage)).toEqual([
      JSON.stringify({ type: 'chat.stop-task', sessionId: 'session-1', taskId: 'wakeup:toolu_wake_1', allScheduled: true }),
    ]);
    expect(screen.getAllByText('Stopping…').length).toBe(2);
  });

  it('greys the ✕ out while a turn runs, saying to stop it after the turn', () => {
    const { sendMessage } = renderStrip({ isTurnRunning: true });
    const stop = stopButtons()[0];
    expect(stop.getAttribute('aria-disabled')).toBe('true');
    expect(stop.title).toBe('Stop it after this turn ends');

    fireEvent.click(stop);
    expect(screen.queryAllByRole('group').length).toBe(0);
    expect(screen.queryAllByText('Stop it after this turn ends').length).toBe(1);
    expect(sendMessage.mock.calls.length).toBe(0);
  });

  it('keeps an item stopping through the turn that cancels it, and once it is gone reads the running sessions again', async () => {
    renderStrip();
    confirmStop(0);

    emit(status({ status: 'started' }));
    expect(screen.queryAllByText('Stopping…').length).toBe(1);
    // The turn shows as the session's at once, a turn the pane can stop.
    expect(page.state.processing).toEqual(['session-1']);
    emit(status({ status: 'finished', stillHeld: false }));
    expect(page.state.refreshes).toBe(1);
    expect(screen.queryAllByText('Stopping…').length).toBe(1);

    // The read is back; here the item is still listed, so its ✕ is too.
    await settleRefresh();
    expect(screen.queryAllByText('Stopping…').length).toBe(0);
    expect(stopButtons().length).toBe(1);
  });

  it('reads the running sessions again when the process was let go, or there was no such item', async () => {
    renderStrip({ scheduled: [selfPaced(), loop()] });
    confirmStop(0);
    emit(status({ taskId: 'wakeup:toolu_wake_1', status: 'stopped' }));
    expect(page.state.refreshes).toBe(1);
    await settleRefresh();

    confirmStop(1);
    emit(status({ status: 'not_found' }));
    expect(page.state.refreshes).toBe(2);
  });

  it('gives the ✕ back with a hint when the turn did not cancel it, or none could run', () => {
    renderStrip();
    const hint = 'It was not cancelled. Try again, or ask Claude in the message box to cancel it.';

    confirmStop(0);
    emit(status({ status: 'finished', stillHeld: true }));
    expect(stopButtons().length).toBe(1);
    expect(screen.queryAllByText(hint).length).toBe(1);

    confirmStop(0);
    expect(screen.queryAllByText(hint).length).toBe(0);
    emit(status({ status: 'failed' }));
    expect(stopButtons().length).toBe(1);
    expect(screen.queryAllByText(hint).length).toBe(1);
    expect(page.state.refreshes).toBe(0);
  });

  it('gives the ✕ back, to try after the turn, when a turn was under way', () => {
    renderStrip();
    confirmStop(0);
    emit(status({ status: 'busy' }));

    expect(stopButtons().length).toBe(1);
    expect(screen.queryAllByText('Stop it after this turn ends').length).toBe(1);
  });

  it('heeds only the stops it asked for, and ends them all when the socket reconnects', () => {
    renderStrip();
    // Another pane on the session, or another session, asked for these.
    emit(status({ status: 'failed' }));
    emit(status({ sessionId: 'session-2', status: 'failed' }));
    expect(screen.queryAllByText(/^It was not cancelled/).length).toBe(0);

    confirmStop(0);
    emit(status({ sessionId: 'session-2', status: 'failed' }));
    expect(screen.queryAllByText('Stopping…').length).toBe(1);

    emit({ kind: 'websocket_reconnected', timestamp: Date.now() });
    expect(screen.queryAllByText('Stopping…').length).toBe(0);
    expect(stopButtons().length).toBe(1);
  });

  it('closes the question when a turn starts while it asks, and does not ask again once the turn is over', () => {
    const props = { sessionId: 'session-1', canStopTasks: true, sendMessage: () => {}, onReveal: () => {}, onLoadAll: () => {}, messages: [], scheduled: [loop()] };
    const { rerender } = render(<BackgroundTasksStrip {...props} />);
    fireEvent.click(stopButtons()[0]);
    expect(screen.queryAllByRole('group').length).toBe(1);

    rerender(<BackgroundTasksStrip {...props} isTurnRunning />);
    expect(screen.queryAllByRole('group').length).toBe(0);
    rerender(<BackgroundTasksStrip {...props} />);
    expect(screen.queryAllByRole('group').length).toBe(0);
  });

  it('forgets a stop asked for in one session once the pane shows another', () => {
    const { rerender } = renderStrip();
    confirmStop(0);
    expect(screen.queryAllByText('Stopping…').length).toBe(1);

    rerender(
      <BackgroundTasksStrip
        sessionId="session-2"
        canStopTasks
        sendMessage={() => {}}
        onReveal={() => {}}
        onLoadAll={() => {}}
        messages={[]}
        scheduled={[loop()]}
      />,
    );
    expect(screen.queryAllByText('Stopping…').length).toBe(0);
    expect(stopButtons().length).toBe(1);
  });

  it('closes the question on a press outside it, or on Escape wherever the focus is, but not on a press of its own buttons', () => {
    const { sendMessage } = renderStrip({ scheduled: [loop(), selfPaced()] });

    fireEvent.click(stopButtons()[0]);
    fireEvent.pointerDown(document.body);
    expect(screen.queryAllByRole('group').length).toBe(0);

    fireEvent.click(stopButtons()[0]);
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryAllByRole('group').length).toBe(0);

    // Safari and Firefox on macOS leave the focus where it was on a click.
    fireEvent.click(stopButtons()[0]);
    const stop = within(screen.getByRole('group')).getByRole('button', { name: 'Stop' });
    fireEvent.pointerDown(stop);
    fireEvent.click(stop);
    expect(sendMessage.mock.calls.length).toBe(1);
  });

  it('lays out task names and prompts by their own first letter: right to left, "/loop" stays "/loop" and a long prompt is cut at its end', () => {
    renderStrip({
      messages: [toolRow({ toolName: 'Workflow', toolId: 'toolu_workflow_1', taskStatus: { status: 'running', workflowName: 'release-check' } })],
      tasks: [{ taskId: 'task-1', toolUseId: 'toolu_bash_1', taskType: 'local_bash', description: 'npm test -- --watch', startedAt: NOW - 1000 }],
      scheduled: [selfPaced({ prompt: '/loop' }), loop()],
    });
    const laidOutByContent = [...document.querySelectorAll('.bidi-auto')].map((element) => element.textContent);
    expect(laidOutByContent).toEqual(['release-check', 'npm test -- --watch', '/loop', 'check CI']);
  });

  it('closes the question on Escape, which it owns while open, and on Cancel', () => {
    const { sendMessage } = renderStrip();

    fireEvent.click(stopButtons()[0]);
    const question = screen.getByRole('group');
    expect(question.hasAttribute('data-escape-layer')).toBe(true);
    fireEvent.keyDown(document.activeElement ?? question, { key: 'Escape' });
    expect(screen.queryAllByRole('group').length).toBe(0);
    expect(document.activeElement === stopButtons()[0]).toBe(true);

    fireEvent.click(stopButtons()[0]);
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryAllByRole('group').length).toBe(0);
    expect(sendMessage.mock.calls.length).toBe(0);
  });

  it('tells its stops from another pane\'s on the socket they share: the other pane\'s answer about the same item leaves its own stopping', async () => {
    // The session open in two panes of one page, each with its strip.
    const left = renderStrip();
    const right = renderStrip();
    const inLeft = within(left.container);
    const inRight = within(right.container);
    const confirmIn = (pane: typeof inLeft) => {
      fireEvent.click(pane.getByRole('button', { name: 'Stop' }));
      fireEvent.click(within(pane.getByRole('group')).getByRole('button', { name: 'Stop' }));
    };
    confirmIn(inLeft);
    confirmIn(inRight);
    const [leftId] = stopIds(left.sendMessage);
    const [rightId] = stopIds(right.sendMessage);
    expect(leftId === rightId).toBe(false);

    emit(status({ status: 'started', clientRequestId: leftId }));
    // The left pane's turn runs, so the right pane's stop of the same item waits for it.
    emit(status({ status: 'busy', clientRequestId: rightId }));
    expect(inLeft.queryAllByText('Stopping…').length).toBe(1);
    expect(inLeft.queryAllByText('Stop it after this turn ends').length).toBe(0);
    expect(inRight.queryAllByText('Stopping…').length).toBe(0);
    expect(inRight.queryAllByText('Stop it after this turn ends').length).toBe(1);

    emit(status({ status: 'finished', stillHeld: false, clientRequestId: leftId }));
    expect(page.state.refreshes).toBe(1);
    await settleRefresh();
    expect(inLeft.queryAllByText('Stopping…').length).toBe(0);
  });

  it('settles a stop by the item it named when the server hands no id back', () => {
    renderStrip();
    confirmStop(0);

    emit(status({ status: 'failed', clientRequestId: undefined }));
    expect(stopButtons().length).toBe(1);
    expect(screen.queryAllByText(/^It was not cancelled/).length).toBe(1);
  });

  it('keeps how often and when an item runs in view: short of room, the prompt gives way first', () => {
    renderStrip({ scheduled: [loop({ prompt: 'Reply with exactly the word TICK and nothing else, then wait for the next run' })] });

    const prompt = [...document.querySelectorAll('.bidi-auto')].find((element) => element.textContent?.startsWith('Reply with'));
    const timing = prompt?.nextElementSibling;
    expect(timing?.textContent?.startsWith('· Every 5 minutes')).toBe(true);
    // The two share a row of their own, which gives way inside the chip; in
    // it the prompt shrinks, to nothing if it has to, and the timing only
    // ever narrows to the row's width, cut there with an ellipsis.
    expect(prompt?.parentElement?.className.split(' ').includes('min-w-0')).toBe(true);
    expect(prompt?.className.split(' ').includes('min-w-0')).toBe(true);
    const timingClasses = timing?.className.split(' ') ?? [];
    expect(['flex-shrink-0', 'max-w-full', 'truncate'].every((name) => timingClasses.includes(name))).toBe(true);
    expect(timingClasses.includes('min-w-0')).toBe(false);
  });
});

describe('the background tasks strip, in another language', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  const renderAgent = (toolUses: number) => render(
    <BackgroundTasksStrip
      sessionId="session-1"
      canStopTasks
      sendMessage={() => {}}
      onReveal={() => {}}
      onLoadAll={() => {}}
      messages={[
        toolRow({
          toolName: 'Agent',
          toolId: 'toolu_agent_1',
          isSubagentContainer: true,
          taskStatus: { status: 'running', description: 'Survey the repo', usage: { totalTokens: 1, toolUses, durationMs: 1 } },
        }),
      ]}
    />,
  );

  it('counts an agent\'s tool uses in the interface language', async () => {
    await i18n.changeLanguage('zh-CN');
    renderAgent(12);
    expect(screen.getByRole('status').textContent?.includes('12 次工具调用')).toBe(true);
  });

  it('counts one tool use in Hebrew\'s singular', async () => {
    await i18n.changeLanguage('he');
    renderAgent(1);
    expect(screen.getByRole('status').textContent?.includes('שימוש אחד בכלי')).toBe(true);
  });
});

describe('visibleCountToReveal', () => {
  it('keeps the window when the row is already inside it', () => {
    // 942 rows, window of 100: row 900 has 42 rows after it, itself included.
    expect(visibleCountToReveal(942, 900, 100)).toBe(100);
  });

  it('widens the window to the row plus a page of context when it is not', () => {
    // Row 106 of 942 needs 836 rows shown; a page more gives it some context above.
    expect(visibleCountToReveal(942, 106, 100)).toBe(836 + SESSION_MESSAGES_PAGE_SIZE);
  });
});
