import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef, useCallback } from 'react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import ActivityDetailsPanel from '@/modules/chat/composer/ActivityDetailsPanel';
import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { WorkflowPanel } from '@/modules/chat/tools/WorkflowPanel';
import { deriveActivityDetails, deriveActivityProgress } from '@/modules/chat/utils/runProgress';
import type {
  ActivityDetails,
  ActivityDetailsWorkflow,
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

/** The tab's row is as tall as the tab (`h-8`). */
const TAB_ROW_PX = 32;

/** The resize observers set up while a chat column is modelled, with what each watches. */
const resizeObservers = new Set<{ callback: ResizeObserverCallback; targets: Set<Element> }>();

/**
 * jsdom lays nothing out, so a model stands in for the browser's chat column:
 * the transcript pane is as tall as each case leaves it (all that the header,
 * the composer and an on-screen keyboard leave of the column), and the tab's
 * row is TAB_ROW_PX. A resize reaches the page the ways a browser's does: the
 * transcript's resize observers, the window's `resize` and the visual
 * viewport's (iOS Safari's keyboard). Undone by `vi.unstubAllGlobals()`
 * and the config's `restoreMocks`.
 */
function modelChatColumn(transcriptHeightPx: number) {
  let transcriptHeight = transcriptHeightPx;
  const transcript = document.createElement('div');
  vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => DOMRect.fromRect({ width: 390, height: transcriptHeight }));
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return [...this.children].some((child) => child.classList.contains('chat-activity-tab')) ? TAB_ROW_PX : 0;
  });
  vi.stubGlobal('ResizeObserver', class {
    private readonly observer: { callback: ResizeObserverCallback; targets: Set<Element> };

    constructor(callback: ResizeObserverCallback) {
      this.observer = { callback, targets: new Set() };
      resizeObservers.add(this.observer);
    }

    observe(target: Element) {
      this.observer.targets.add(target);
    }

    unobserve(target: Element) {
      this.observer.targets.delete(target);
    }

    disconnect() {
      resizeObservers.delete(this.observer);
    }
  });
  const visualViewport = new EventTarget();
  vi.stubGlobal('visualViewport', visualViewport);

  return {
    transcriptRef: { current: transcript },
    /** The transcript takes a new height that nothing reports yet. */
    setTranscriptHeight: (heightPx: number) => {
      transcriptHeight = heightPx;
    },
    /** The transcript takes a new height its resize observers hear of: the composer grew with a draft, say. */
    resizeTranscript: (heightPx: number) => act(() => {
      transcriptHeight = heightPx;
      for (const { callback, targets } of resizeObservers) {
        if (targets.has(transcript)) {
          callback([], {} as ResizeObserver);
        }
      }
    }),
    /** The window resizes, and the transcript with it. */
    resizeWindow: (heightPx: number) => act(() => {
      transcriptHeight = heightPx;
      window.dispatchEvent(new Event('resize'));
    }),
    /** The visual viewport resizes (an on-screen keyboard comes or goes), and the transcript with it. */
    resizeVisualViewport: (heightPx: number) => act(() => {
      transcriptHeight = heightPx;
      visualViewport.dispatchEvent(new Event('resize'));
    }),
  };
}

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

  it('draws its chevron in full muted contrast at rest, and in the foreground colour when focused or open', () => {
    render(<IndicatorHarness messages={busyTranscript} activity={runningTurn()} onAbort={() => {}} />);
    const classes = () => toggle().className.split(/\s+/);

    // At rest it is the only sign the tab opens. At 60% opacity on the card
    // it read 2.3:1 in the light theme, short of the 3:1 WCAG 1.4.11 asks.
    expect(classes()).toContain('text-muted-foreground');
    expect(classes().filter((name) => name.startsWith('text-muted-foreground/'))).toEqual([]);
    // Hover alone brightened it, which neither a keyboard nor a touch gives.
    expect(classes()).toContain('focus-visible:text-foreground');
    expect(classes()).toContain('group-hover:text-foreground');

    openPanel();
    expect(classes()).toContain('text-foreground');
    expect(classes()).not.toContain('text-muted-foreground');
  });

  it('in a pane too narrow even for its label, truncates the label rather than clipping the elapsed time or the toggle', () => {
    // The readout gives way first and the label used to be shrink-0, so the
    // tab overflowed at its end, clipping the toggle (its last child) first.
    const { container } = render(<IndicatorHarness messages={[userTurn]} activity={runningTurn()} onAbort={() => {}} />);
    const tab = container.querySelector<HTMLElement>('div.chat-activity-tab')!;
    const label = screen.getByText('Thinking…').parentElement!;

    expect(label.parentElement).toBe(tab);
    expect(label.classList.contains('min-w-0')).toBe(true);
    expect(label.classList.contains('truncate')).toBe(true);
    expect(label.classList.contains('shrink-0')).toBe(false);
    // Marked, so the fit check counts what it truncates and the readout
    // still gives way before it does.
    expect(label.hasAttribute('data-fit-clip')).toBe(true);
    expect(within(tab).getByText('6m 0s').classList.contains('shrink-0')).toBe(true);
    expect(toggle().classList.contains('shrink-0')).toBe(true);
  });

  it('scrolls the tab back once focus leaves the toggle the browser scrolled into view', () => {
    const { container } = render(<IndicatorHarness messages={busyTranscript} activity={runningTurn()} onAbort={() => {}} />);
    const tab = container.querySelector<HTMLElement>('div.chat-activity-tab')!;

    toggle().focus();
    // What a browser does to bring a focused toggle the tab clips into view;
    // jsdom does no layout, so the test does it.
    tab.scrollLeft = 61;

    // Tab on to Stop: the label is back in view rather than left cut off.
    screen.getByRole('button', { name: 'Stop' }).focus();
    expect(tab.scrollLeft).toBe(0);
  });
});

describe('the details panel in a short chat column', () => {
  // The panel grows upward from the tab, inside a chat column that clips
  // whatever passes its top. 390x664 phone: 454px of transcript, 118px once
  // a 336px keyboard is up.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resizeObservers.clear();
  });

  it('fits the room above the composer, so its first rows stay in reach as an on-screen keyboard comes and goes', () => {
    const column = modelChatColumn(454);
    render(<IndicatorHarness messages={busyTranscript} activity={runningTurn()} onAbort={() => {}} transcriptRef={column.transcriptRef} />);
    const opened = openPanel();

    // Room to spare: its own 16rem ceiling decides.
    expect(opened.style.maxHeight).toBe('min(16rem, 408px)');

    // iOS Safari: the keyboard shrinks the visual viewport, and the
    // workspace with it, while dvh stays as it was.
    column.resizeVisualViewport(118);
    // 118px of transcript: 32 for the tab's row, 6 for the panel's gap above
    // it and 8 to spare below the header leave the panel 72px, all of it in
    // view and scrolling within.
    expect(panel().style.maxHeight).toBe('min(16rem, 72px)');

    column.resizeVisualViewport(454);
    expect(panel().style.maxHeight).toBe('min(16rem, 408px)');
  });

  it('shrinks as a long draft grows the composer under it, and follows the window', () => {
    const column = modelChatColumn(300);
    render(<IndicatorHarness messages={busyTranscript} activity={runningTurn()} onAbort={() => {}} transcriptRef={column.transcriptRef} />);
    openPanel();
    expect(panel().style.maxHeight).toBe('min(16rem, 254px)');

    // A twelve-line draft: the composer grows and the transcript gives way.
    column.resizeTranscript(180);
    expect(panel().style.maxHeight).toBe('min(16rem, 134px)');

    column.resizeWindow(140);
    expect(panel().style.maxHeight).toBe('min(16rem, 94px)');
  });

  it('measures the room afresh each time it opens', () => {
    const column = modelChatColumn(454);
    render(<IndicatorHarness messages={busyTranscript} activity={runningTurn()} onAbort={() => {}} transcriptRef={column.transcriptRef} />);
    openPanel();
    fireEvent.click(toggle());

    // The keyboard came up while the panel was closed and nothing watched.
    column.setTranscriptHeight(118);
    expect(openPanel().style.maxHeight).toBe('min(16rem, 72px)');
  });

  it('caps nothing by the viewport, and only by its own ceiling with no transcript to fit', () => {
    render(<IndicatorHarness messages={busyTranscript} activity={runningTurn()} onAbort={() => {}} />);
    const opened = openPanel();

    expect(opened.style.maxHeight).toBe('');
    expect(opened.classList.contains('max-h-64')).toBe(true);
    expect(opened.className).not.toMatch(/vh/);
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

describe('a workflow\'s run time in the panel', () => {
  // The CLI reports a run's wall time to the millisecond: 95.6 s is 1m 36s to
  // the nearest second, and 1m 35s rounded down.
  const reportedUsage = { totalTokens: 1_000, toolUses: 12, durationMs: 95_600 };

  const finishedAgents: WorkflowAgentProgress[] = [
    { index: 0, label: 'plan', agentId: 'p1', state: 'done', startedAt: LAUNCH, durationMs: 40_000 },
    { index: 1, label: 'report', agentId: 'r1', state: 'done', startedAt: LAUNCH + 40_000, durationMs: 55_000 },
  ];

  /** The panel listing one workflow, as deriveActivityDetails reads it. */
  const listing = (workflow: Pick<ActivityDetailsWorkflow, 'status' | 'elapsedMs'>): ActivityDetails => ({
    run: { statusText: 'Thinking', elapsedMs: 360_000, isBackground: false, isCliDriven: false },
    workflows: [{
      key: 'toolu_workflow_1',
      name: 'frontend-architecture-audit',
      description: 'Evidence-based audit of the frontend',
      progress: { unit: 'agents', done: 2, total: 2, running: 0, startedAt: LAUNCH },
      remainingMs: null,
      agents: [],
      hiddenAgentCount: 0,
      ...workflow,
    }],
    hiddenWorkflowCount: 0,
    checklist: null,
    tasks: [],
  });

  const workflowSection = () => screen.getByText('frontend-architecture-audit').closest('section')!;

  it('reads a finished run\'s reported time as the run\'s Workflow card does', () => {
    const card = render(
      <WorkflowPanel
        toolInput={JSON.stringify({ script: SCRIPT })}
        taskStatus={{ status: 'completed', taskId: 'wxkj4kcvd', agents: finishedAgents, usage: reportedUsage }}
        createDiff={() => []}
      />,
    );
    expect(card.container.textContent).toContain('· 1m 36s');
    card.unmount();

    render(<ActivityDetailsPanel id="details" details={listing({ status: 'completed', elapsedMs: reportedUsage.durationMs })} />);
    expect(workflowSection().textContent).toContain('2/2 agents· 100%· 1m 36s');
  });

  it('still counts a running run\'s time in whole seconds, as the tab\'s clock ticks', () => {
    render(<ActivityDetailsPanel id="details" details={listing({ status: 'running', elapsedMs: 95_600 })} />);

    expect(workflowSection().textContent).toContain('2/2 agents· 100%· 1m 35s');
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
    resizeObservers.clear();
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

  /** The composer as ChatInterface draws it for one viewed session. */
  const sessionComposerProps = (sessionId: string, activity: SessionActivity, messages: ChatMessage[]) => composerProps({
    activitySessionId: sessionId,
    activity,
    isLoading: !activity.background,
    activityProgress: deriveActivityProgress(messages, activity),
    readActivityDetails: (nowMs) => deriveActivityDetails(messages, activity, nowMs),
  });

  it('starts collapsed in a session the user switches to, though both are busy', () => {
    const turnInA = runningTurn({ startedAt: Date.now() - 360_000 });
    const runInB: SessionActivity = { statusText: 'Running in the Claude CLI', canInterrupt: false, startedAt: Date.now() - 20_000 };
    const { rerender } = render(<ChatComposer {...sessionComposerProps('session-a', turnInA, busyTranscript)} />);
    openPanel();

    // Picking B in the sidebar hands the tab B's activity in the same render:
    // the tab passes no idle moment that would collapse the panel.
    rerender(<ChatComposer {...sessionComposerProps('session-b', runInB, [userTurn])} />);
    expect(screen.getByText('Running in the Claude CLI…')).toBeTruthy();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', PANEL)).toBeNull();

    // Nor does going back reopen it over A's transcript.
    rerender(<ChatComposer {...sessionComposerProps('session-a', turnInA, busyTranscript)} />);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', PANEL)).toBeNull();
  });

  it('keeps the panel open within one session when background work gives way to a new turn', () => {
    const work = backgroundWork([{ ...workflowTask, startedAt: Date.now() - 360_000 }]);
    const { rerender } = render(<ChatComposer {...sessionComposerProps('session-a', work, busyTranscript)} />);
    openPanel();

    // The user sends over the background work: the entry becomes a turn with
    // a fresh clock, and the workflow the panel lists runs on under it. The
    // session never went idle, so the user's choice holds.
    rerender(<ChatComposer {...sessionComposerProps('session-a', runningTurn({ startedAt: Date.now() }), busyTranscript)} />);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(within(panel()).getByText('frontend-architecture-audit')).toBeTruthy();
  });

  it('fits the details panel in the transcript above the composer', () => {
    const column = modelChatColumn(118);
    const activity = runningTurn({ startedAt: Date.now() - 360_000 });
    render(<ChatComposer {...sessionComposerProps('session-a', activity, busyTranscript)} transcriptRef={column.transcriptRef} />);

    expect(openPanel().style.maxHeight).toBe('min(16rem, 72px)');
  });
});
