import { describe, expect, it } from 'vitest';

import { i18n } from '@/modules/i18n';
import { deriveActivityDetails, formatElapsed } from '@/modules/chat/utils/runProgress';
import type {
  BackgroundTaskSummary,
  ChatMessage,
  SessionActivity,
  WorkflowAgentProgress,
  WorkflowInfo,
} from '@/shared/types';

/**
 * The activity tab's readout sums the work up in one line, and draws nothing
 * when there is nothing to count — which left a user watching a run with no
 * idea what it was doing. A click on the tab now opens a panel listing the
 * work in full; this is what it lists, read from the same rows.
 */

const TURN_AT = '2026-10-26T10:00:00.000Z';
const LAUNCHED_AT = '2026-10-26T10:00:05.000Z';
const LAUNCH = Date.parse(LAUNCHED_AT);
// Six minutes into the workflow's run.
const NOW = LAUNCH + 360_000;

const runningTurn: SessionActivity = { statusText: 'Thinking', canInterrupt: true, startedAt: Date.parse(TURN_AT) };

const backgroundTask = (overrides: Partial<BackgroundTaskSummary> = {}): BackgroundTaskSummary => ({
  taskId: 'wxkj4kcvd',
  toolUseId: 'toolu_workflow_1',
  taskType: 'local_workflow',
  description: 'Audit the frontend',
  workflowName: 'frontend-architecture-audit',
  startedAt: LAUNCH,
  ...overrides,
});

const backgroundWork = (tasks: BackgroundTaskSummary[]): SessionActivity => ({
  statusText: null,
  canInterrupt: false,
  startedAt: Math.min(...tasks.map((task) => task.startedAt)),
  background: true,
  tasks,
});

/** What the running-sessions poll reports for a turn a Claude CLI process CloudCLI does not drive is running. */
const cliDrivenRun: SessionActivity = {
  statusText: 'Running in the Claude CLI',
  canInterrupt: false,
  startedAt: Date.parse(TURN_AT),
};

const userTurn = (content = 'Audit the frontend'): ChatMessage => ({ type: 'user', content, timestamp: TURN_AT });

// The script header the real launch in session 4820c6b8 carried.
const SCRIPT = [
  'export const meta = {',
  "  name: 'frontend-architecture-audit',",
  "  description: 'Evidence-based audit of the frontend',",
  '}',
].join('\n');

const workflowLaunch = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  type: 'assistant',
  content: '',
  timestamp: LAUNCHED_AT,
  isToolUse: true,
  toolName: 'Workflow',
  toolId: 'toolu_workflow_1',
  toolInput: JSON.stringify({ script: SCRIPT, description: 'Parallel frontend architecture audit' }, null, 2),
  toolResult: {
    content: 'Workflow launched in background. Task ID: wxkj4kcvd',
    isError: false,
    toolUseResult: { status: 'async_launched', taskId: 'wxkj4kcvd', runId: 'wf_16fbf852-274' },
  },
  ...overrides,
});

let toolSequence = 0;

const checklist = (todos: Record<string, unknown>[]): ChatMessage => ({
  type: 'assistant',
  content: '',
  timestamp: '2026-10-26T10:00:10.000Z',
  isToolUse: true,
  toolName: 'TodoWrite',
  toolId: `toolu_todo_${(toolSequence += 1)}`,
  toolInput: JSON.stringify({ todos }, null, 2),
});

const trackerCall = (toolName: string, input: Record<string, unknown>, toolUseResult?: unknown): ChatMessage => ({
  type: 'assistant',
  content: '',
  timestamp: '2026-10-26T10:00:20.000Z',
  isToolUse: true,
  toolName,
  toolId: `toolu_task_${(toolSequence += 1)}`,
  toolInput: JSON.stringify(input, null, 2),
  toolResult: toolUseResult === undefined ? null : { content: 'ok', isError: false, toolUseResult },
});

/**
 * A plan agent took two minutes and an audit agent failed after one; two
 * agents run, the newer one in the Verify phase; two slots wait, one of them
 * already labelled.
 */
const liveAgents: WorkflowAgentProgress[] = [
  { index: 0, label: 'plan', phase: 'Plan', agentId: 'p1', state: 'done', startedAt: LAUNCH, durationMs: 120_000 },
  { index: 1, label: 'audit:chat', phase: 'Audit', agentId: 'a1', state: 'failed', startedAt: LAUNCH + 120_000, durationMs: 60_000 },
  { index: 2, label: 'audit:sidebar', phase: 'Audit', agentId: 'a2', state: 'running', startedAt: LAUNCH + 120_000 },
  { index: 3, label: 'verify', phase: 'Verify', agentId: 'a3', state: 'running', startedAt: LAUNCH + 300_000 },
  { index: 4, state: 'queued' },
  { index: 5, label: 'report', state: 'queued' },
];

const runningWorkflow = (overrides: Partial<ChatMessage> = {}) => workflowLaunch({
  taskStatus: { status: 'running', taskId: 'wxkj4kcvd', agents: liveAgents },
  ...overrides,
});

const en = i18n.getFixedT('en');
const zh = i18n.getFixedT('zh-CN');

describe('the workflows the details panel lists', () => {
  it('draws a running workflow the way its card does: name, what it does, the counts, the phase, the elapsed time and the time left', () => {
    const details = deriveActivityDetails([userTurn(), runningWorkflow()], runningTurn, NOW);

    expect(details?.workflows).toHaveLength(1);
    expect(details?.workflows[0]).toMatchObject({
      key: 'toolu_workflow_1',
      name: 'frontend-architecture-audit',
      description: 'Evidence-based audit of the frontend',
      status: 'running',
      // Failed counts as finished, as on the card; the queued slots count
      // toward the total; the phase is the running agent started last.
      progress: { unit: 'agents', done: 2, total: 6, running: 2, phase: 'Verify', startedAt: LAUNCH },
      elapsedMs: 360_000,
      // The two running agents end when the younger has run a typical
      // agent's 90 s (30 s to go); the two queued slots then take one wave.
      remainingMs: 30_000 + 90_000,
      hiddenAgentCount: 0,
    });
  });

  it('lists the agents at work first, then the finished ones, newest first, then the queued slots in start order', () => {
    const details = deriveActivityDetails([userTurn(), runningWorkflow()], runningTurn, NOW);

    expect(details?.workflows[0].agents).toEqual([
      { key: 'a3', label: 'verify', status: 'running', phase: 'Verify', elapsedMs: 60_000 },
      { key: 'a2', label: 'audit:sidebar', status: 'running', phase: 'Audit', elapsedMs: 240_000 },
      { key: 'a1', label: 'audit:chat', status: 'failed', phase: 'Audit', elapsedMs: 60_000 },
      { key: 'p1', label: 'plan', status: 'completed', phase: 'Plan', elapsedMs: 120_000 },
      // A slot nothing has named yet is called by its place in the run.
      { key: 'slot-4', label: '#5', status: 'queued' },
      { key: 'slot-5', label: 'report', status: 'queued' },
    ]);
  });

  it('lists the agents a history load read from the journal, with no times it never had', () => {
    const workflow: WorkflowInfo = {
      runId: 'wf_16fbf852-274',
      name: 'audit-from-journal',
      description: 'Read back from disk',
      status: 'running',
      agents: [
        { id: 'j1', label: 'plan', phase: 'Plan', status: 'completed' },
        { id: 'j2', label: 'audit:chat', phase: 'Audit', status: 'running' },
      ],
      agentCounts: { total: 2, completed: 1, failed: 0, running: 1, stopped: 0 },
    };
    const details = deriveActivityDetails([userTurn(), workflowLaunch({ workflow })], runningTurn, NOW);

    // The journal's name and description come before the script's.
    expect(details?.workflows[0]).toMatchObject({ name: 'audit-from-journal', description: 'Read back from disk' });
    expect(details?.workflows[0].agents).toEqual([
      { key: 'j2', label: 'audit:chat', status: 'running', phase: 'Audit' },
      { key: 'j1', label: 'plan', status: 'completed', phase: 'Plan' },
    ]);
    // No agent was timed, so one agent at a time is paced by the run so far:
    // one done in six minutes, one to go.
    expect(details?.workflows[0].remainingMs).toBe(360_000);
  });

  it('keeps a big fan-out\'s list short, with what the run is doing now still in view', () => {
    const fanOut: WorkflowAgentProgress[] = [
      { index: 0, label: 'plan', agentId: 'p1', state: 'done', startedAt: LAUNCH, durationMs: 60_000 },
      ...Array.from({ length: 3 }, (_, offset): WorkflowAgentProgress => ({
        index: offset + 1, label: `audit:${offset + 1}`, agentId: `a${offset + 1}`, state: 'running', startedAt: LAUNCH + 60_000,
      })),
      ...Array.from({ length: 10 }, (_, offset): WorkflowAgentProgress => ({ index: offset + 4, state: 'queued' })),
    ];
    const details = deriveActivityDetails(
      [userTurn(), workflowLaunch({ taskStatus: { status: 'running', agents: fanOut } })],
      runningTurn,
      NOW,
    );
    const [workflow] = details?.workflows ?? [];

    expect(workflow.progress).toMatchObject({ done: 1, total: 14, running: 3 });
    expect(workflow.agents.map((agent) => agent.label)).toEqual([
      'audit:3', 'audit:2', 'audit:1', 'plan', '#5', '#6', '#7', '#8',
    ]);
    expect(workflow.hiddenAgentCount).toBe(6);
  });

  it('shows a run that has listed no agent yet by its name and elapsed time alone', () => {
    const details = deriveActivityDetails(
      [userTurn(), workflowLaunch({ taskStatus: { status: 'running', workflowName: 'nightly-triage' } })],
      runningTurn,
      NOW,
    );

    expect(details?.workflows[0]).toMatchObject({
      name: 'nightly-triage',
      status: 'running',
      progress: null,
      elapsedMs: 360_000,
      remainingMs: null,
      agents: [],
    });
  });

  it('puts the runs still going first, then the ones this turn saw end, newest first, and leaves out what earlier turns finished', () => {
    const at = (offsetMs: number) => new Date(LAUNCH + offsetMs).toISOString();
    const messages = [
      workflowLaunch({ toolId: 'wf-earlier-done', timestamp: at(-600_000), taskStatus: { status: 'completed' } }),
      workflowLaunch({ toolId: 'wf-earlier-running', timestamp: at(-500_000), taskStatus: { status: 'running', agents: liveAgents } }),
      userTurn(),
      workflowLaunch({
        toolId: 'wf-done-now',
        timestamp: at(10_000),
        taskStatus: { status: 'completed', usage: { totalTokens: 1_000, toolUses: 12, durationMs: 95_000 } },
      }),
      workflowLaunch({ toolId: 'wf-refused', timestamp: at(20_000), toolResult: { content: 'Invalid workflow script', isError: true } }),
      workflowLaunch({ toolId: 'wf-running-now', timestamp: at(30_000), taskStatus: { status: 'running', agents: liveAgents } }),
    ];
    const details = deriveActivityDetails(messages, runningTurn, NOW);

    expect(details?.workflows.map((workflow) => [workflow.key, workflow.status])).toEqual([
      ['wf-running-now', 'running'],
      ['wf-earlier-running', 'running'],
      ['wf-refused', 'failed'],
    ]);
    expect(details?.hiddenWorkflowCount).toBe(1);

    // A finished run shows the wall time the CLI reported, and no time left.
    const finished = deriveActivityDetails(messages.filter((message) => message.toolId !== 'wf-refused'), runningTurn, NOW);
    expect(finished?.workflows[2]).toMatchObject({ key: 'wf-done-now', status: 'completed', elapsedMs: 95_000, remainingMs: null });
    expect(finished?.hiddenWorkflowCount).toBe(0);
  });

  it('settles the agents of a run that has ended, as its card does', () => {
    const details = deriveActivityDetails(
      [userTurn(), workflowLaunch({ taskStatus: { status: 'completed', agents: liveAgents } })],
      runningTurn,
      NOW,
    );
    const [workflow] = details?.workflows ?? [];

    // Agents the run ended under have no outcome, and slots never started are gone.
    expect(workflow.agents.map((agent) => [agent.label, agent.status])).toEqual([
      ['verify', 'stopped'],
      ['audit:sidebar', 'stopped'],
      ['audit:chat', 'failed'],
      ['plan', 'completed'],
    ]);
    expect(workflow.progress).toMatchObject({ done: 2, total: 4, running: 0 });
    expect(workflow.progress?.phase).toBeUndefined();
  });
});

describe('the checklist the details panel lists', () => {
  it('lists the turn\'s checklist item by item, with how many are done', () => {
    const details = deriveActivityDetails([
      userTurn(),
      checklist([
        { content: 'Read the code', status: 'completed' },
        { content: 'Write the fix', status: 'in_progress' },
        { content: 'Run the tests', status: 'pending' },
      ]),
    ], runningTurn, NOW);

    expect(details?.checklist).toEqual({
      items: [
        { key: '#0', text: 'Read the code', status: 'completed' },
        { key: '#1', text: 'Write the fix', status: 'in_progress' },
        { key: '#2', text: 'Run the tests', status: 'pending' },
      ],
      done: 1,
      total: 3,
    });
  });

  it('names the tracker\'s tasks by their subjects as its calls stream in', () => {
    const details = deriveActivityDetails([
      userTurn(),
      trackerCall('TaskCreate', { subject: 'Audit', activeForm: 'Auditing' }, { task: { id: '1', subject: 'Audit' } }),
      trackerCall('TaskCreate', { subject: 'Fix' }, { task: { id: '2', subject: 'Fix' } }),
      trackerCall('TaskUpdate', { taskId: '1', status: 'completed' }),
      trackerCall('TaskUpdate', { taskId: '2', status: 'in_progress', subject: 'Fix the parser' }),
    ], runningTurn, NOW);

    expect(details?.checklist).toEqual({
      items: [
        { key: '1', text: 'Audit', status: 'completed' },
        { key: '2', text: 'Fix the parser', status: 'in_progress' },
      ],
      done: 1,
      total: 2,
    });
  });

  it('lists none from an earlier turn, none once the turn is over, and none it cannot know in full', () => {
    const todos = [{ content: 'Read', status: 'completed' }, { content: 'Write', status: 'pending' }];

    expect(deriveActivityDetails([userTurn('first'), checklist(todos), userTurn('second')], runningTurn, NOW)?.checklist).toBeNull();
    expect(deriveActivityDetails([userTurn(), checklist(todos)], backgroundWork([backgroundTask()]), NOW)?.checklist).toBeNull();
    // An update of a task the loaded rows never saw created.
    expect(deriveActivityDetails(
      [userTurn(), trackerCall('TaskUpdate', { taskId: '7', status: 'completed' })],
      runningTurn,
      NOW,
    )?.checklist).toBeNull();
  });
});

describe('the background tasks the details panel lists', () => {
  const agent = backgroundTask({
    taskId: 'a8c1', toolUseId: 'toolu_agent_1', taskType: 'local_agent', description: 'Survey the repo', workflowName: undefined, startedAt: LAUNCH + 60_000,
  });
  const command = backgroundTask({
    taskId: 'b5xs', toolUseId: 'toolu_bash_1', taskType: 'local_bash', description: 'npm test', workflowName: undefined, startedAt: LAUNCH + 300_000,
  });
  const nestedCommand = backgroundTask({
    taskId: 'c9q2', toolUseId: 'toolu_inner_1', taskType: 'local_bash', description: 'pnpm lint', workflowName: undefined, startedAt: LAUNCH + 200_000, nested: true,
  });

  it('lists the session\'s own tasks, newest first, with how long each has run, leaving out the workflow drawn above', () => {
    const details = deriveActivityDetails(
      [userTurn(), runningWorkflow()],
      backgroundWork([backgroundTask(), agent, command, nestedCommand]),
      NOW,
    );

    expect(details?.workflows.map((workflow) => workflow.key)).toEqual(['toolu_workflow_1']);
    expect(details?.tasks.map((task) => [task.taskId, task.taskType, task.elapsedMs])).toEqual([
      ['b5xs', 'local_bash', 60_000],
      ['a8c1', 'local_agent', 300_000],
    ]);
  });

  it('still lists a workflow whose launch is not among the loaded rows', () => {
    const details = deriveActivityDetails([userTurn()], backgroundWork([backgroundTask()]), NOW);

    expect(details?.workflows).toEqual([]);
    expect(details?.tasks).toEqual([{ ...backgroundTask(), elapsedMs: 360_000 }]);
  });

  it('lists an agent\'s own commands only when nothing else is running', () => {
    const details = deriveActivityDetails([userTurn()], backgroundWork([nestedCommand]), NOW);

    expect(details?.tasks.map((task) => task.taskId)).toEqual(['c9q2']);
  });
});

describe('the run the details panel describes', () => {
  it('says how long the run has gone on and that it is a turn in flight', () => {
    expect(deriveActivityDetails([userTurn()], runningTurn, NOW)?.run).toEqual({
      statusText: 'Thinking',
      elapsedMs: NOW - Date.parse(TURN_AT),
      isBackground: false,
      isCliDriven: false,
    });
  });

  it('tells background work from a turn', () => {
    expect(deriveActivityDetails([], backgroundWork([backgroundTask()]), NOW)?.run).toEqual({
      statusText: null,
      elapsedMs: 360_000,
      isBackground: true,
      isCliDriven: false,
    });
  });

  it('marks a turn the Claude CLI drives outside CloudCLI, whose details only arrive with its transcript', () => {
    const details = deriveActivityDetails([userTurn()], cliDrivenRun, NOW);

    expect(details?.run).toMatchObject({ statusText: 'Running in the Claude CLI', isBackground: false, isCliDriven: true });
    // The transcript the CLI has written so far still counts.
    const withChecklist = deriveActivityDetails(
      [userTurn(), checklist([{ content: 'Read', status: 'completed' }, { content: 'Write', status: 'in_progress' }])],
      cliDrivenRun,
      NOW,
    );
    expect(withChecklist?.checklist).toMatchObject({ done: 1, total: 2 });
  });

  it('lists nothing at all for a run with no workflow, checklist or background task', () => {
    expect(deriveActivityDetails([userTurn()], cliDrivenRun, NOW)).toMatchObject({
      workflows: [],
      hiddenWorkflowCount: 0,
      checklist: null,
      tasks: [],
    });
  });

  it('has no details for a session that is not busy', () => {
    expect(deriveActivityDetails([userTurn(), runningWorkflow()], null, NOW)).toBeNull();
  });
});

describe('an elapsed time', () => {
  it('prints whole seconds, then minutes and seconds, as the tab does', () => {
    expect(formatElapsed(45_000, en)).toBe('45s');
    expect(formatElapsed(59_999, en)).toBe('59s');
    expect(formatElapsed(192_000, en)).toBe('3m 12s');
    expect(formatElapsed(75 * 60_000, en)).toBe('75m 0s');
    expect(formatElapsed(-1_000, en)).toBe('0s');
    expect(formatElapsed(192_000, zh)).toBe('3m 12s');
  });
});
