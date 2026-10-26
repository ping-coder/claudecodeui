import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef, useCallback } from 'react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { deriveActivityDetails, deriveActivityProgress } from '@/modules/chat/utils/runProgress';
import type {
  BackgroundTaskSummary,
  ChatMessage,
  SessionActivity,
  WorkflowAgentProgress,
} from '@/shared/types';
import { resetUserPreferences } from '@/shared/userSettings';

/**
 * A user watching a run saw no progress at all: the tab above the composer
 * draws its readout only when a workflow or a checklist has something to
 * count, and a run the Claude CLI drives outside this view sends no live
 * events. The tab now opens a panel with the run's details in full, and says
 * so plainly when there are none.
 */

// The composer's voice controls reach for a preferences provider and a health
// endpoint that have nothing to do with the activity tab.
vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));
vi.mock('@/modules/chat/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({ state: 'idle', toggle: () => undefined, stop: () => undefined }),
}));

const NOW = Date.parse('2026-10-26T10:06:05.000Z');
// The workflow launched six minutes ago, with the turn.
const LAUNCH = NOW - 360_000;

const PANEL = { name: 'Progress details' } as const;

const runningTurn = (overrides: Partial<SessionActivity> = {}): SessionActivity => ({
  statusText: 'Thinking',
  canInterrupt: true,
  startedAt: LAUNCH,
  ...overrides,
});

const workflowTask: BackgroundTaskSummary = {
  taskId: 'wxkj4kcvd',
  toolUseId: 'toolu_workflow_1',
  taskType: 'local_workflow',
  description: 'Audit the frontend',
  workflowName: 'frontend-architecture-audit',
  startedAt: LAUNCH,
};

const agentTask: BackgroundTaskSummary = {
  taskId: 'a8c1',
  toolUseId: 'toolu_agent_1',
  taskType: 'local_agent',
  description: 'Survey the repo',
  startedAt: LAUNCH + 60_000,
};

const backgroundWork = (tasks: BackgroundTaskSummary[]): SessionActivity => ({
  statusText: null,
  canInterrupt: false,
  startedAt: Math.min(...tasks.map((task) => task.startedAt)),
  background: true,
  tasks,
});

/** What the running-sessions poll reports for a turn a Claude CLI process CloudCLI does not drive is running. */
const cliDrivenRun = (): SessionActivity => ({
  statusText: 'Running in the Claude CLI',
  canInterrupt: false,
  startedAt: NOW - 192_000,
});

const userTurn: ChatMessage = { type: 'user', content: 'Audit the frontend', timestamp: new Date(LAUNCH - 5_000).toISOString() };

const SCRIPT = [
  'export const meta = {',
  "  name: 'frontend-architecture-audit',",
  "  description: 'Evidence-based audit of the frontend',",
  '}',
].join('\n');

const liveAgents: WorkflowAgentProgress[] = [
  { index: 0, label: 'plan', phase: 'Plan', agentId: 'p1', state: 'done', startedAt: LAUNCH, durationMs: 120_000 },
  { index: 1, label: 'audit:chat', phase: 'Audit', agentId: 'a1', state: 'failed', startedAt: LAUNCH + 120_000, durationMs: 60_000 },
  { index: 2, label: 'audit:sidebar', phase: 'Audit', agentId: 'a2', state: 'running', startedAt: LAUNCH + 120_000 },
  { index: 3, label: 'verify', phase: 'Verify', agentId: 'a3', state: 'running', startedAt: LAUNCH + 300_000 },
  { index: 4, state: 'queued' },
  { index: 5, label: 'report', state: 'queued' },
];

const runningWorkflow: ChatMessage = {
  type: 'assistant',
  content: '',
  timestamp: new Date(LAUNCH).toISOString(),
  isToolUse: true,
  toolName: 'Workflow',
  toolId: 'toolu_workflow_1',
  toolInput: JSON.stringify({ script: SCRIPT, description: 'Parallel frontend architecture audit' }),
  toolResult: {
    content: 'Workflow launched in background. Task ID: wxkj4kcvd',
    isError: false,
    toolUseResult: { status: 'async_launched', taskId: 'wxkj4kcvd', runId: 'wf_16fbf852-274' },
  },
  taskStatus: { status: 'running', taskId: 'wxkj4kcvd', agents: liveAgents },
};

const turnChecklist: ChatMessage = {
  type: 'assistant',
  content: '',
  timestamp: new Date(LAUNCH + 10_000).toISOString(),
  isToolUse: true,
  toolName: 'TodoWrite',
  toolId: 'toolu_todo_1',
  toolInput: JSON.stringify({
    todos: [
      { content: 'Read the code', status: 'completed' },
      { content: 'Write the fix', status: 'in_progress' },
      { content: 'Run the tests', status: 'pending' },
    ],
  }),
};

const busyTranscript = [userTurn, runningWorkflow, turnChecklist];

type HarnessProps = { messages: ChatMessage[] } & Omit<ComponentProps<typeof ActivityIndicator>, 'progress' | 'readDetails'>;

/** The tab as the composer draws it, counting and reading its details from the transcript the way ChatInterface does. */
function IndicatorHarness({ messages, activity, ...props }: HarnessProps) {
  const readDetails = useCallback(
    (nowMs: number) => deriveActivityDetails(messages, activity, nowMs),
    [messages, activity],
  );
  return (
    <ActivityIndicator
      activity={activity}
      progress={deriveActivityProgress(messages, activity)}
      readDetails={readDetails}
      {...props}
    />
  );
}

const toggle = () => screen.getByRole('button', PANEL);
const panel = () => screen.getByRole('region', PANEL);
const openPanel = () => {
  fireEvent.click(toggle());
  return panel();
};

describe('the activity tab as the details toggle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts collapsed, and its chevron button opens and closes the panel it controls', () => {
    render(<IndicatorHarness messages={busyTranscript} activity={runningTurn()} onAbort={() => {}} />);

    // A real button, so Enter and Space work it, with a name that holds still
    // while the label beside it rotates and the time ticks.
    expect(toggle().tagName).toBe('BUTTON');
    expect(toggle().getAttribute('type')).toBe('button');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', PANEL)).toBeNull();

    const opened = openPanel();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(toggle().getAttribute('aria-controls')).toBe(opened.id);
    expect(within(opened).getByText('frontend-architecture-audit')).toBeTruthy();

    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', PANEL)).toBeNull();
  });

  it('opens from a tap anywhere on the tab, not only on the chevron', () => {
    const { container } = render(<IndicatorHarness messages={busyTranscript} activity={runningTurn()} onAbort={() => {}} />);

    fireEvent.click(screen.getByText('Thinking…'));
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(within(container.querySelector<HTMLElement>('div.chat-activity-tab')!).getByText('33%'));
    expect(screen.queryByRole('region', PANEL)).toBeNull();
  });

  it('keeps the compact readout and Stop as they were, with the panel outside the tab', () => {
    const onAbort = vi.fn();
    const { container } = render(<IndicatorHarness messages={busyTranscript} activity={runningTurn()} onAbort={onAbort} />);
    const opened = openPanel();
    const tab = container.querySelector<HTMLElement>('div.chat-activity-tab')!;

    expect(within(tab).getByRole('progressbar').getAttribute('aria-label')).toBe('2/6 agents');
    expect(tab.textContent).toContain('Thinking…');
    expect(tab.textContent).toContain('Verify· 2/6 agents· 33%· ~2m left');
    expect(within(tab).getByText('6m 0s')).toBeTruthy();
    // The panel takes none of the room the fit check measures the tab by.
    expect(tab.contains(opened)).toBe(false);

    // Stop sits beside the tab, so it stops the turn and leaves the panel be.
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('region', PANEL)).toBeTruthy();
  });

  it('stays as the user left it while the activity lasts, and the next activity starts collapsed', () => {
    const { rerender } = render(<IndicatorHarness messages={busyTranscript} activity={runningTurn()} onAbort={() => {}} />);
    openPanel();

    // The turn ends; the workflow it launched keeps the session busy.
    rerender(<IndicatorHarness messages={busyTranscript} activity={backgroundWork([workflowTask, agentTask])} onAbort={() => {}} />);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(within(panel()).getByText('Background work')).toBeTruthy();

    // The work is done: the panel closes with the activity.
    rerender(<IndicatorHarness messages={busyTranscript} activity={null} onAbort={() => {}} />);
    expect(screen.queryByRole('region', PANEL)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByRole('button', PANEL)).toBeNull();

    rerender(<IndicatorHarness messages={busyTranscript} activity={runningTurn({ startedAt: NOW })} onAbort={() => {}} />);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', PANEL)).toBeNull();
  });

  it('is hidden, not forgotten, while something else holds the space above the composer', () => {
    const { container, rerender } = render(<IndicatorHarness messages={busyTranscript} activity={runningTurn()} onAbort={() => {}} />);
    openPanel();

    rerender(<IndicatorHarness messages={busyTranscript} activity={runningTurn()} onAbort={() => {}} isHidden />);
    expect(container.textContent).toBe('');

    rerender(<IndicatorHarness messages={busyTranscript} activity={runningTurn()} onAbort={() => {}} />);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(within(panel()).getByText('frontend-architecture-audit')).toBeTruthy();
  });

  it('leaves Esc to stop the turn rather than closing the panel', () => {
    const onAbort = vi.fn();
    // What ChatInterface listens with while the turn can be stopped.
    const stopOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      onAbort();
    };
    document.addEventListener('keydown', stopOnEscape, { capture: true });
    try {
      render(<IndicatorHarness messages={busyTranscript} activity={runningTurn()} onAbort={onAbort} />);
      const opened = openPanel();

      toggle().focus();
      fireEvent.keyDown(toggle(), { key: 'Escape' });
      expect(onAbort).toHaveBeenCalledTimes(1);
      expect(toggle().getAttribute('aria-expanded')).toBe('true');

      fireEvent.keyDown(opened, { key: 'Escape' });
      expect(onAbort).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('region', PANEL)).toBe(opened);
    } finally {
      document.removeEventListener('keydown', stopOnEscape, { capture: true });
    }
  });

  it('offers no toggle when there are no details to read', () => {
    const { container } = render(<ActivityIndicator activity={runningTurn()} onAbort={() => {}} />);

    expect(screen.queryByRole('button', PANEL)).toBeNull();
    fireEvent.click(screen.getByText('Thinking…'));
    expect(screen.queryByRole('region', PANEL)).toBeNull();
    expect(container.querySelector('div.chat-activity-tab')?.classList.contains('cursor-pointer')).toBe(false);
  });
});

describe('what the details panel lists', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a running turn: the run, each workflow with its readout and agents, and the turn\'s checklist', () => {
    render(<IndicatorHarness messages={busyTranscript} activity={runningTurn()} onAbort={() => {}} />);
    const opened = openPanel();

    expect(opened.textContent).toContain('Thinking· 6m 0s');

    const workflow = within(opened).getByText('frontend-architecture-audit').closest('section')!;
    expect(within(workflow).getByText('Evidence-based audit of the frontend')).toBeTruthy();
    expect(within(workflow).getByText('running')).toBeTruthy();
    expect(within(workflow).getByRole('progressbar').getAttribute('aria-label')).toBe('2/6 agents');
    expect(workflow.textContent).toContain('2/6 agents· 33%· Verify· 6m 0s· ~2m left');
    expect(within(workflow).getByText('~2m left').getAttribute('title')).toBe('Estimated from the pace so far');
    // Each agent's status is read out ahead of its name; the icon is drawn only.
    expect(within(workflow).getAllByRole('listitem').map((line) => line.textContent)).toEqual([
      'running: verify· Verify1m 0s',
      'running: audit:sidebar· Audit4m 0s',
      'failed: audit:chat· Audit1m 0s',
      'done: plan· Plan2m 0s',
      'queued: #5',
      'queued: report',
    ]);

    const checklist = within(opened).getByText('Task list').closest('section')!;
    expect(within(checklist).getByText('1/3 tasks')).toBeTruthy();
    expect(within(checklist).getAllByRole('listitem').map((item) => [item.getAttribute('data-status'), item.textContent])).toEqual([
      ['completed', 'done: Read the code'],
      ['in_progress', 'in progress: Write the fix'],
      ['pending', 'to do: Run the tests'],
    ]);

    // The workflow is drawn above, so it is not listed again as a task.
    expect(within(opened).queryByText('Background tasks')).toBeNull();
    expect(within(opened).queryByText(/No detailed progress/)).toBeNull();
  });

  it('background work: the workflow and the other tasks, and no Stop', () => {
    render(<IndicatorHarness messages={busyTranscript} activity={backgroundWork([workflowTask, agentTask])} onAbort={() => {}} />);

    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    const opened = openPanel();

    expect(opened.textContent).toContain('Background work· 6m 0s');
    const workflow = within(opened).getByText('frontend-architecture-audit').closest('section')!;
    expect(workflow.textContent).toContain('2/6 agents· 33%· Verify· 6m 0s· ~2m left');
    // The turn's checklist ended with the turn.
    expect(within(opened).queryByText('Task list')).toBeNull();
    const tasks = within(opened).getByText('Background tasks').closest('section')!;
    expect(within(tasks).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Agent Survey the repo5m 0s']);
  });

  it('a run the Claude CLI drives outside this view: why its details come late, then what its transcript holds', () => {
    const activity = cliDrivenRun();
    const { rerender } = render(<IndicatorHarness messages={[userTurn]} activity={activity} />);

    // CloudCLI cannot stop a CLI it does not drive.
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    const opened = openPanel();
    expect(opened.textContent).toContain('Running in the Claude CLI· 3m 12s');
    const note = 'This run is driven by the Claude CLI outside this view, so these details update as its transcript is written.';
    expect(within(opened).getByText(note)).toBeTruthy();
    expect(within(opened).getByText('No detailed progress yet — this run has no workflow, task list or background task.')).toBeTruthy();

    // A history reload brings what the CLI has written since.
    rerender(<IndicatorHarness messages={[userTurn, turnChecklist]} activity={activity} />);
    expect(within(panel()).getByText(note)).toBeTruthy();
    expect(within(panel()).getByText('Write the fix')).toBeTruthy();
    expect(within(panel()).queryByText(/No detailed progress/)).toBeNull();
  });

  it('nothing to list: says so plainly, without the CLI\'s note', () => {
    render(<IndicatorHarness messages={[userTurn]} activity={runningTurn()} onAbort={() => {}} />);
    const opened = openPanel();

    expect(opened.textContent).toContain('Thinking· 6m 0s');
    expect(within(opened).getByText('No detailed progress yet — this run has no workflow, task list or background task.')).toBeTruthy();
    expect(within(opened).queryByText(/driven by the Claude CLI/)).toBeNull();
  });

  it('names a turn with no status line plainly, rather than in the tab\'s rotating words', () => {
    render(<IndicatorHarness messages={[userTurn]} activity={runningTurn({ statusText: null })} onAbort={() => {}} />);

    expect(openPanel().textContent).toContain('Turn in progress· 6m 0s');
  });
});

describe('the details panel in Chinese', () => {
  it('speaks the user\'s language', async () => {
    await act(async () => {
      await i18n.changeLanguage('zh-CN');
    });
    try {
      render(<IndicatorHarness messages={[userTurn]} activity={cliDrivenRun()} />);
      fireEvent.click(screen.getByRole('button', { name: '进度详情' }));
      const opened = screen.getByRole('region', { name: '进度详情' });

      expect(within(opened).getByText('此运行由本视图之外的 Claude CLI 驱动，以下详情会随它写入对话记录而更新。')).toBeTruthy();
      expect(within(opened).getByText('暂无详细进度——此运行没有工作流、任务清单或后台任务。')).toBeTruthy();
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en');
      });
    }
  });
});

describe('the details panel in the composer', () => {
  type ChatComposerProps = ComponentProps<typeof ChatComposer>;

  const composerProps = (overrides: Partial<ChatComposerProps>): ChatComposerProps => {
    const noop = () => undefined;
    return {
      pendingPermissionRequests: [],
      handlePermissionDecision: noop,
      handleGrantToolPermission: () => ({ success: true }),
      activity: null,
      isLoading: false,
      onAbortSession: noop,
      permissionMode: 'default',
      availablePermissionModes: ['default'],
      onSelectPermissionMode: noop,
      providerLabel: 'Claude',
      effort: 'default',
      availableEffortOptions: [],
      onSelectEffort: noop,
      ultracode: null,
      onToggleUltracode: noop,
      model: 'auto',
      availableModelOptions: [],
      onSelectModel: noop,
      modelsLoading: false,
      tokenBudget: null,
      onShowTokenUsage: noop,
      slashCommandsCount: 0,
      onToggleCommandMenu: noop,
      hasInput: false,
      onClearInput: noop,
      onSubmit: noop,
      isDragActive: false,
      queuedDraft: null,
      backgroundSendPrompt: null,
      onResolveBackgroundSendPrompt: noop,
      isEditingSentMessage: false,
      onCancelEditMessage: noop,
      scheduledMessages: [],
      onScheduleMessage: noop,
      onCancelScheduledMessage: noop,
      onEditQueuedDraft: noop,
      onDeleteQueuedDraft: noop,
      attachedFiles: [],
      onRemoveAttachment: noop,
      fileErrors: new Map(),
      showFileDropdown: false,
      filteredFiles: [],
      selectedFileIndex: -1,
      onSelectFile: noop,
      filteredCommands: [],
      selectedCommandIndex: -1,
      onCommandSelect: noop,
      onCloseCommandMenu: noop,
      isCommandMenuOpen: false,
      frequentCommands: [],
      getRootProps: () => ({}),
      getInputProps: () => ({}),
      openAttachmentPicker: noop,
      inputHighlightRef: createRef<HTMLDivElement>(),
      renderInputWithMentions: (text) => text,
      textareaRef: createRef<HTMLTextAreaElement>(),
      input: '',
      onInputChange: noop,
      onTextareaClick: noop,
      onTextareaKeyDown: noop,
      onTextareaPaste: noop,
      onTextareaScrollSync: noop,
      onTextareaInput: noop,
      placeholder: 'Ask Claude anything...',
      isTextareaExpanded: false,
      ...overrides,
    };
  };

  beforeEach(() => {
    // The composer's slash-command hook fetches commands and skills on mount.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
    resetUserPreferences();
    localStorage.clear();
  });

  afterEach(() => {
    resetUserPreferences();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('is open again once the permission request that hid it is answered', () => {
    const activity = runningTurn({ startedAt: Date.now() - 360_000 });
    const props = composerProps({
      activity,
      isLoading: true,
      activityProgress: deriveActivityProgress(busyTranscript, activity),
      readActivityDetails: (nowMs) => deriveActivityDetails(busyTranscript, activity, nowMs),
    });
    const { rerender } = render(<ChatComposer {...props} />);
    openPanel();

    rerender(<ChatComposer {...props} pendingPermissionRequests={[{ requestId: 'perm-1', toolName: 'Bash', input: { command: 'npm test' } }]} />);
    expect(screen.queryByRole('region', PANEL)).toBeNull();
    expect(screen.queryByRole('button', PANEL)).toBeNull();

    rerender(<ChatComposer {...props} />);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(within(panel()).getByText('frontend-architecture-audit')).toBeTruthy();
  });
});
