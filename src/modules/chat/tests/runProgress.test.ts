import { describe, expect, it } from 'vitest';

import { i18n } from '@/modules/i18n';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import {
  computeProgressPercent,
  deriveActivityProgress,
  estimateRemainingMs,
  formatProgressCount,
  formatRemainingEstimate,
} from '@/modules/chat/utils/runProgress';
import type {
  ActivityProgress,
  ChatMessage,
  NormalizedMessage,
  SessionActivity,
  WorkflowAgentProgress,
  WorkflowInfo,
} from '@/shared/types';

/**
 * The activity tab above the composer said only that something was running.
 * It now counts how far the work has got, from the rows the transcript's
 * cards already draw: the agents of a workflow still running, else the
 * checklist of the turn in flight — and nothing at all when neither exists.
 */

const LAUNCHED_AT = '2026-10-26T09:50:00.000Z';
const TURN_STARTED_AT = Date.parse('2026-10-26T10:00:00.000Z');

const runningTurn: SessionActivity = { statusText: null, canInterrupt: true, startedAt: TURN_STARTED_AT };

const backgroundWork: SessionActivity = {
  statusText: null,
  canInterrupt: false,
  startedAt: Date.parse(LAUNCHED_AT),
  background: true,
  tasks: [{
    taskId: 'wxkj4kcvd',
    toolUseId: 'toolu_workflow_1',
    taskType: 'local_workflow',
    description: 'Audit the frontend',
    workflowName: 'frontend-architecture-audit',
    startedAt: Date.parse(LAUNCHED_AT),
  }],
};

const userTurn = (content = 'Audit the frontend'): ChatMessage => ({
  type: 'user',
  content,
  timestamp: '2026-10-26T10:00:00.000Z',
});

const workflowLaunch = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  type: 'assistant',
  content: '',
  timestamp: LAUNCHED_AT,
  isToolUse: true,
  toolName: 'Workflow',
  toolId: 'toolu_workflow_1',
  toolInput: '{}',
  toolResult: {
    content: 'Workflow launched in background. Task ID: wxkj4kcvd',
    isError: false,
    toolUseResult: { status: 'async_launched', taskId: 'wxkj4kcvd', runId: 'wf_16fbf852-274' },
  },
  ...overrides,
});

let toolSequence = 0;

/** A whole-list checklist row as the transcript holds it: a TodoWrite call with its input as JSON. */
const checklist = (todos: Record<string, unknown>[]): ChatMessage => ({
  type: 'assistant',
  content: '',
  timestamp: '2026-10-26T10:00:05.000Z',
  isToolUse: true,
  toolName: 'TodoWrite',
  toolId: `toolu_todo_${(toolSequence += 1)}`,
  toolInput: JSON.stringify({ todos }, null, 2),
});

/** One raw call of Claude's task tracker, as the live stream delivers it. */
const trackerCall = (toolName: string, input: Record<string, unknown>, toolUseResult?: unknown): ChatMessage => ({
  type: 'assistant',
  content: '',
  timestamp: '2026-10-26T10:00:10.000Z',
  isToolUse: true,
  toolName,
  toolId: `toolu_task_${(toolSequence += 1)}`,
  toolInput: JSON.stringify(input, null, 2),
  toolResult: toolUseResult === undefined ? null : { content: 'ok', isError: false, toolUseResult },
});

/** Mid-run: two agents finished (one failed), two running in different phases, one slot queued. */
const liveAgents: WorkflowAgentProgress[] = [
  { index: 0, label: 'audit:chat', phase: 'Audit', agentId: 'a1', state: 'done', startedAt: 1_000 },
  { index: 1, label: 'audit:sidebar', phase: 'Audit', agentId: 'a2', state: 'failed', startedAt: 2_000 },
  { index: 2, label: 'audit:shell', phase: 'Audit', agentId: 'a3', state: 'running', startedAt: 3_000 },
  { index: 3, label: 'verify:chat', phase: 'Verify', agentId: 'a4', state: 'running', startedAt: 4_000 },
  { index: 4, state: 'queued' },
];

const en = i18n.getFixedT('en');
const zh = i18n.getFixedT('zh-CN');

describe('the progress of a busy session', () => {
  it('counts a running workflow\'s agents: finished, running, total, the current phase, from its launch', () => {
    const progress = deriveActivityProgress(
      [userTurn(), workflowLaunch({ taskStatus: { status: 'running', agents: liveAgents } })],
      runningTurn,
    );

    // Failed counts as finished, as the card's "2 of 5 agents finished" does;
    // the queued slot counts toward the total; the phase is the running agent
    // started last.
    expect(progress).toEqual({
      unit: 'agents',
      done: 2,
      total: 5,
      running: 2,
      phase: 'Verify',
      startedAt: Date.parse(LAUNCHED_AT),
    });
  });

  it('counts the agents the card lists, with the journal\'s settled word over a stale live one', () => {
    // The last history load read a3 as completed; the stream's last progress
    // event still had it running. The journal also knows an agent the stream
    // never listed.
    const workflow: WorkflowInfo = {
      runId: 'wf_16fbf852-274',
      name: 'frontend-architecture-audit',
      status: 'running',
      agents: [
        { id: 'a3', label: 'audit:shell', phase: 'Audit', status: 'completed' },
        { id: 'a0', label: 'plan', phase: 'Plan', status: 'completed' },
      ],
      agentCounts: { total: 2, completed: 2, failed: 0, running: 0, stopped: 0 },
    };
    const progress = deriveActivityProgress(
      [userTurn(), workflowLaunch({ workflow, taskStatus: { status: 'running', agents: liveAgents } })],
      runningTurn,
    );

    expect(progress).toMatchObject({ unit: 'agents', done: 4, total: 6, running: 1, phase: 'Verify' });
  });

  it('reads a workflow\'s live task events the way the transcript folds them', () => {
    const row = (id: string, overrides: Partial<NormalizedMessage>): NormalizedMessage => ({
      id,
      sessionId: 'session-1',
      timestamp: LAUNCHED_AT,
      provider: 'claude',
      kind: 'text',
      role: 'assistant',
      ...overrides,
    });
    const messages = normalizedToChatMessages([
      row('prompt', { kind: 'text', role: 'user', content: 'Audit the frontend' }),
      row('workflow-call', { kind: 'tool_use', toolId: 'toolu_workflow_1', toolName: 'Workflow', toolInput: { script: '', description: 'Audit' } }),
      row('task-started', { kind: 'task_status', event: 'started', taskId: 'wxkj4kcvd', toolUseId: 'toolu_workflow_1', taskType: 'local_workflow', workflowName: 'audit' }),
      row('task-progress', { kind: 'task_status', event: 'progress', taskId: 'wxkj4kcvd', toolUseId: 'toolu_workflow_1', agents: liveAgents }),
    ]);

    expect(deriveActivityProgress(messages, runningTurn)).toMatchObject({ unit: 'agents', done: 2, total: 5, running: 2 });
  });

  it('keeps counting the workflow once the turn has ended and only background work remains', () => {
    const progress = deriveActivityProgress(
      [userTurn(), workflowLaunch({ taskStatus: { status: 'running', agents: liveAgents } })],
      backgroundWork,
    );

    expect(progress).toMatchObject({ unit: 'agents', done: 2, total: 5 });
  });

  it('has nothing to count for a session that is not busy, or one with neither a workflow nor a checklist', () => {
    const messages = [userTurn(), workflowLaunch({ taskStatus: { status: 'running', agents: liveAgents } })];

    expect(deriveActivityProgress(messages, null)).toBeNull();
    expect(deriveActivityProgress([userTurn()], runningTurn)).toBeNull();
    expect(deriveActivityProgress([], backgroundWork)).toBeNull();
  });

  it('looks past a workflow that has finished or failed to launch, to the turn\'s checklist', () => {
    const todos = [{ content: 'Audit', status: 'completed' }, { content: 'Fix', status: 'in_progress' }];

    expect(deriveActivityProgress(
      [userTurn(), workflowLaunch({ taskStatus: { status: 'completed', agents: liveAgents } }), checklist(todos)],
      runningTurn,
    )).toMatchObject({ unit: 'tasks', done: 1, total: 2 });
    expect(deriveActivityProgress(
      [userTurn(), workflowLaunch({ toolResult: { content: 'Invalid workflow script', isError: true }, taskStatus: { status: 'running', agents: liveAgents } })],
      runningTurn,
    )).toBeNull();
  });

  it('skips a running workflow that has listed no agents yet, for an older one that has', () => {
    const older = workflowLaunch({ toolId: 'toolu_workflow_0', taskStatus: { status: 'running', agents: liveAgents } });
    const fresh = workflowLaunch({ toolId: 'toolu_workflow_2', timestamp: '2026-10-26T10:00:30.000Z', taskStatus: { status: 'running' } });

    expect(deriveActivityProgress([older, userTurn(), fresh], runningTurn)).toMatchObject({ unit: 'agents', done: 2, total: 5 });
    expect(deriveActivityProgress([userTurn(), fresh], runningTurn)).toBeNull();
  });

  it('counts the newest checklist of the turn in flight, from the turn\'s start', () => {
    const progress = deriveActivityProgress([
      userTurn(),
      checklist([{ content: 'Read', status: 'in_progress' }, { content: 'Write', status: 'pending' }]),
      checklist([
        { content: 'Read', status: 'completed', activeForm: 'Reading' },
        { content: 'Plan', status: 'completed', activeForm: 'Planning' },
        { content: 'Write', status: 'completed', activeForm: 'Writing' },
        { content: 'Test', status: 'in_progress', activeForm: 'Testing' },
        { content: 'Review', status: 'pending', activeForm: 'Reviewing' },
        { content: 'Ship', status: 'pending', activeForm: 'Shipping' },
        { content: 'Announce', status: 'pending', activeForm: 'Announcing' },
      ]),
    ], runningTurn);

    expect(progress).toEqual({ unit: 'tasks', done: 3, total: 7, running: 1, startedAt: TURN_STARTED_AT });
  });

  it('never borrows a checklist from an earlier turn', () => {
    const earlier = checklist([{ content: 'Read', status: 'completed' }, { content: 'Write', status: 'pending' }]);

    expect(deriveActivityProgress([userTurn('first'), earlier, userTurn('second')], runningTurn)).toBeNull();
  });

  it('does not count the checklist once the turn has ended, since nothing advances it until the next', () => {
    const todos = [{ content: 'Read', status: 'completed' }, { content: 'Write', status: 'pending' }];

    expect(deriveActivityProgress([userTurn(), checklist(todos)], backgroundWork)).toBeNull();
  });

  it('reads a Codex plan, which the server normalizes onto the same checklist shape', () => {
    // Codex's update_plan steps arrive as `{ content, status }` with no ids.
    const plan = checklist([
      { content: 'Inspect the failing test', status: 'completed' },
      { content: 'Patch the parser', status: 'in_progress' },
      { content: 'Run the suite', status: 'pending' },
    ]);

    expect(deriveActivityProgress([userTurn(), plan], runningTurn)).toMatchObject({ unit: 'tasks', done: 1, total: 3, running: 1 });
  });

  it('counts only the items the checklist view draws, and nothing for an empty list', () => {
    const malformed = checklist([
      { content: 'Read', status: 'completed' },
      { status: 'completed' },
      { content: 'Write' },
      { content: 'Test', status: 'pending' },
    ]);

    expect(deriveActivityProgress([userTurn(), malformed], runningTurn)).toMatchObject({ done: 1, total: 2 });
    expect(deriveActivityProgress([userTurn(), checklist([])], runningTurn)).toBeNull();
  });
});

describe('the progress of Claude\'s task tracker', () => {
  // What a history load leaves: the server replays the tracker into a
  // whole-list TodoWrite snapshot keyed by the tracker's ids.
  const snapshot = () => checklist([
    { id: '1', content: 'Audit', status: 'completed' },
    { id: '2', content: 'Fix', status: 'in_progress' },
    { id: '3', content: 'Verify', status: 'pending' },
  ]);

  it('replays the calls streamed since the last snapshot over it, even one from an earlier turn', () => {
    const progress = deriveActivityProgress([
      snapshot(),
      userTurn(),
      trackerCall('TaskUpdate', { taskId: '2', status: 'completed' }),
      trackerCall('TaskCreate', { subject: 'Document', activeForm: 'Documenting' }, { task: { id: '4', subject: 'Document' } }),
      trackerCall('TaskUpdate', { taskId: '3', status: 'in_progress' }),
    ], runningTurn);

    // Task 1 was done before the turn opened, so the turn's pace leaves it out.
    expect(progress).toEqual({ unit: 'tasks', done: 2, total: 4, running: 1, startedAt: TURN_STARTED_AT, doneAtStart: 1 });
  });

  it('builds the list from the tracker\'s first task when no snapshot is loaded', () => {
    const progress = deriveActivityProgress([
      userTurn(),
      trackerCall('TaskCreate', { subject: 'Audit' }, { task: { id: '1', subject: 'Audit' } }),
      trackerCall('TaskCreate', { subject: 'Fix' }, { task: { id: '2', subject: 'Fix' } }),
      trackerCall('TaskUpdate', { taskId: '1', status: 'completed' }),
    ], runningTurn);

    expect(progress).toMatchObject({ unit: 'tasks', done: 1, total: 2, running: 0 });
  });

  it('draws nothing when the list began above the loaded rows, rather than a false fraction', () => {
    // An update of a task this replay never saw created.
    expect(deriveActivityProgress([
      userTurn(),
      trackerCall('TaskUpdate', { taskId: '7', status: 'completed' }),
    ], runningTurn)).toBeNull();
    // Task 11 created with tasks 1–10 out of sight.
    expect(deriveActivityProgress([
      userTurn(),
      trackerCall('TaskCreate', { subject: 'Ship' }, { task: { id: '11', subject: 'Ship' } }),
    ], runningTurn)).toBeNull();
    // An id far out of the tracker's range is a gap too, and answers at once.
    expect(deriveActivityProgress([
      userTurn(),
      trackerCall('TaskCreate', { subject: 'Ship' }, { task: { id: '1' } }),
      trackerCall('TaskCreate', { subject: 'Ship' }, { task: { id: 1_761_472_800_000 } }),
    ], runningTurn)).toBeNull();
  });

  it('adopts a listing wholesale and drops a deleted task', () => {
    expect(deriveActivityProgress([
      userTurn(),
      trackerCall('TaskList', {}, { tasks: [
        { id: '4', subject: 'Audit', status: 'completed' },
        { id: '5', subject: 'Fix', status: 'pending' },
        { id: '6', subject: 'Verify', status: 'pending' },
      ] }),
    ], runningTurn)).toMatchObject({ done: 1, total: 3 });

    expect(deriveActivityProgress([
      snapshot(),
      userTurn(),
      trackerCall('TaskUpdate', { taskId: '3', status: 'deleted' }),
    ], runningTurn)).toMatchObject({ done: 1, total: 2, running: 1 });
  });

  it('drops a task the tracker reports as deleted, as the server\'s replay does', () => {
    expect(deriveActivityProgress([
      snapshot(),
      userTurn(),
      trackerCall('TaskGet', { taskId: '3' }, { task: { id: '3', subject: 'Verify', status: 'deleted' } }),
    ], runningTurn)).toMatchObject({ done: 1, total: 2, running: 1 });
  });

  it('keeps counting when a refreshed snapshot already folded in a deletion streamed live', () => {
    // A history refresh mid-turn swaps the tracker calls for the server's
    // snapshots, and the server drops a deleted task too. The raw deletion
    // can survive the swap and sort after the snapshot that already lacks it:
    // nothing is left to delete, and the list is still known in full.
    const refreshed = checklist([
      { id: '1', content: 'Audit', status: 'completed' },
      { id: '2', content: 'Fix', status: 'in_progress' },
    ]);

    expect(deriveActivityProgress([
      snapshot(),
      userTurn(),
      refreshed,
      trackerCall('TaskUpdate', { taskId: '3', status: 'deleted' }, { success: true, taskId: '3', updatedFields: ['status'] }),
    ], runningTurn)).toMatchObject({ done: 1, total: 2, running: 1 });
    // With no whole list behind the replay, an unseen task is still one from
    // above the loaded rows.
    expect(deriveActivityProgress([
      userTurn(),
      trackerCall('TaskCreate', { subject: 'Audit' }, { task: { id: '1', subject: 'Audit' } }),
      trackerCall('TaskUpdate', { taskId: '3', status: 'deleted' }),
    ], runningTurn)).toBeNull();
  });
});

describe('the pace a turn\'s checklist is timed by', () => {
  const minutes = (count: number) => count * 60_000;
  const atTurnMinute = (count: number) => new Date(TURN_STARTED_AT + minutes(count)).toISOString();
  const todo = (content: string, status: string) => ({ content, status });

  // Turn 1 finished three of six items, then stopped on a question.
  const earlierTurnList = () => checklist([
    todo('A', 'completed'), todo('B', 'completed'), todo('C', 'completed'),
    todo('D', 'in_progress'), todo('E', 'pending'), todo('F', 'pending'),
  ]);
  // The "continue" turn restates the list, as TodoWrite and Codex plans do.
  const restatedList = () => checklist([
    todo('A', 'completed'), todo('B', 'completed'), todo('C', 'completed'),
    todo('D', 'in_progress'), todo('E', 'pending'), todo('F', 'pending'),
  ]);
  const advancedList = () => checklist([
    todo('A', 'completed'), todo('B', 'completed'), todo('C', 'completed'),
    todo('D', 'completed'), todo('E', 'in_progress'), todo('F', 'pending'),
  ]);

  it('leaves the items a carried-on list had done before the turn out of the turn\'s pace', () => {
    const progress = deriveActivityProgress(
      [userTurn('first'), earlierTurnList(), userTurn('continue'), restatedList()],
      runningTurn,
    );

    expect(progress).toMatchObject({ done: 3, total: 6, doneAtStart: 3, startedAt: TURN_STARTED_AT });
    // Nothing has been finished in this turn yet, so there is no pace at all,
    // however long the turn runs.
    expect(estimateRemainingMs(progress!, TURN_STARTED_AT + 45_000)).toBeNull();
    expect(estimateRemainingMs(progress!, TURN_STARTED_AT + minutes(5))).toBeNull();

    // D finishes five minutes in: one item in five minutes, two to go.
    const advanced = deriveActivityProgress(
      [userTurn('first'), earlierTurnList(), userTurn('continue'), restatedList(), advancedList()],
      runningTurn,
    );
    expect(advanced).toMatchObject({ done: 4, total: 6, doneAtStart: 3 });
    expect(estimateRemainingMs(advanced!, TURN_STARTED_AT + minutes(5))).toBe(minutes(10));
  });

  it('leaves out the tasks the tracker carried over from an earlier turn', () => {
    const turnOneCalls = [
      trackerCall('TaskCreate', { subject: 'Audit' }, { task: { id: '1', subject: 'Audit' } }),
      trackerCall('TaskCreate', { subject: 'Fix' }, { task: { id: '2', subject: 'Fix' } }),
      trackerCall('TaskCreate', { subject: 'Verify' }, { task: { id: '3', subject: 'Verify' } }),
      trackerCall('TaskCreate', { subject: 'Ship' }, { task: { id: '4', subject: 'Ship' } }),
      trackerCall('TaskUpdate', { taskId: '1', status: 'completed' }),
      trackerCall('TaskUpdate', { taskId: '2', status: 'completed' }),
    ];
    const started = deriveActivityProgress([
      userTurn('first'),
      ...turnOneCalls,
      userTurn('continue'),
      trackerCall('TaskUpdate', { taskId: '3', status: 'in_progress' }),
    ], runningTurn);
    expect(started).toMatchObject({ done: 2, total: 4, doneAtStart: 2 });
    expect(estimateRemainingMs(started!, TURN_STARTED_AT + 45_000)).toBeNull();

    // The same from a history load, where an earlier turn's snapshot seeds it.
    const fromSnapshot = deriveActivityProgress([
      checklist([
        { id: '1', content: 'Audit', status: 'completed' },
        { id: '2', content: 'Fix', status: 'completed' },
        { id: '3', content: 'Verify', status: 'pending' },
        { id: '4', content: 'Ship', status: 'pending' },
      ]),
      userTurn('continue'),
      trackerCall('TaskUpdate', { taskId: '3', status: 'in_progress' }),
      trackerCall('TaskUpdate', { taskId: '3', status: 'completed' }),
    ], runningTurn);
    expect(fromSnapshot).toMatchObject({ done: 3, total: 4, doneAtStart: 2 });
    // One task in four minutes, one to go.
    expect(estimateRemainingMs(fromSnapshot!, TURN_STARTED_AT + minutes(4))).toBe(minutes(4));
  });

  it('counts a fresh list from nothing, even after a finished one shares an item with it', () => {
    const finished = checklist([
      todo('Read', 'completed'), todo('Run tests', 'completed'), todo('Ship', 'completed'),
    ]);
    const fresh = checklist([
      todo('Profile', 'completed'), todo('Run tests', 'in_progress'), todo('Optimize', 'pending'), todo('Document', 'pending'),
    ]);
    const progress = deriveActivityProgress([userTurn('first'), finished, userTurn('next'), fresh], runningTurn);

    expect(progress).toMatchObject({ done: 1, total: 4, startedAt: TURN_STARTED_AT });
    expect(progress?.doneAtStart).toBeUndefined();
    // One item in three minutes, three to go.
    expect(estimateRemainingMs(progress!, TURN_STARTED_AT + minutes(3))).toBe(minutes(9));

    // Only the shared item that was done before counts as carried over.
    const sharingDone = checklist([
      todo('Profile', 'completed'), todo('Run tests', 'completed'), todo('Optimize', 'pending'), todo('Document', 'pending'),
    ]);
    expect(deriveActivityProgress([userTurn('first'), finished, userTurn('next'), sharingDone], runningTurn))
      .toMatchObject({ done: 2, total: 4, doneAtStart: 1 });
  });

  it('counts a list begun in the turn from the turn\'s start, even when its first write already shows an item done', () => {
    const progress = deriveActivityProgress([
      userTurn('Do the six steps'),
      {
        ...checklist([
          todo('A', 'completed'), todo('B', 'in_progress'), todo('C', 'pending'),
          todo('D', 'pending'), todo('E', 'pending'), todo('F', 'pending'),
        ]),
        timestamp: atTurnMinute(5),
      },
    ], runningTurn);

    expect(progress).toMatchObject({ done: 1, total: 6, startedAt: TURN_STARTED_AT });
    expect(progress?.doneAtStart).toBeUndefined();
    // One item in five minutes, five to go.
    expect(estimateRemainingMs(progress!, TURN_STARTED_AT + minutes(5))).toBe(minutes(25));
  });

  it('times the pace from the oldest loaded checklist row when the list the turn opened with cannot be known', () => {
    // A turn longer than the loaded page: its user message and the list it
    // opened with are above the rows. What the oldest row shows done may
    // predate the turn, so the window opens at that row.
    const oldest = { ...restatedList(), timestamp: atTurnMinute(10) };
    const newest = { ...advancedList(), timestamp: atTurnMinute(20) };
    const paginated = deriveActivityProgress([oldest, newest], runningTurn);

    expect(paginated).toMatchObject({ done: 4, total: 6, doneAtStart: 3, startedAt: TURN_STARTED_AT + minutes(10) });
    // One item in the ten minutes since that row, two to go.
    expect(estimateRemainingMs(paginated!, TURN_STARTED_AT + minutes(20))).toBe(minutes(20));

    // The user message is loaded, but the tracker list it opened on began
    // above the rows (task 5 was never seen created): the turn's own
    // snapshot opens the window instead.
    const trackerSnapshot = (statuses: string[]) => checklist(
      statuses.map((status, index) => ({ id: String(index + 1), content: `Task ${index + 1}`, status })),
    );
    const unknowableOpening = deriveActivityProgress([
      trackerCall('TaskUpdate', { taskId: '5', status: 'completed' }),
      userTurn('continue'),
      { ...trackerSnapshot(['completed', 'completed', 'completed', 'completed', 'completed', 'in_progress']), timestamp: atTurnMinute(2) },
      { ...trackerSnapshot(['completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'in_progress']), timestamp: atTurnMinute(6) },
    ], runningTurn);
    expect(unknowableOpening).toMatchObject({ done: 6, total: 7, doneAtStart: 5, startedAt: TURN_STARTED_AT + minutes(2) });
    // One task in the four minutes since that snapshot, one to go.
    expect(estimateRemainingMs(unknowableOpening!, TURN_STARTED_AT + minutes(6))).toBe(minutes(4));
  });
});

describe('the time left of a workflow whose agents run side by side', () => {
  const LAUNCH = Date.parse(LAUNCHED_AT);

  // A plan agent took four minutes; three audit agents then started together,
  // with two more slots queued behind them.
  const fanOut: WorkflowAgentProgress[] = [
    { index: 0, label: 'plan', phase: 'Plan', agentId: 'p1', state: 'done', startedAt: LAUNCH, durationMs: 240_000 },
    { index: 1, label: 'audit:chat', phase: 'Audit', agentId: 'a1', state: 'running', startedAt: LAUNCH + 240_000 },
    { index: 2, label: 'audit:sidebar', phase: 'Audit', agentId: 'a2', state: 'running', startedAt: LAUNCH + 240_000 },
    { index: 3, label: 'audit:shell', phase: 'Audit', agentId: 'a3', state: 'running', startedAt: LAUNCH + 250_000 },
    { index: 4, state: 'queued' },
    { index: 5, state: 'queued' },
  ];
  const fanOutProgress = () => deriveActivityProgress(
    [userTurn(), workflowLaunch({ taskStatus: { status: 'running', agents: fanOut } })],
    runningTurn,
  );

  it('carries the live stream\'s per-agent timing', () => {
    expect(fanOutProgress()).toMatchObject({
      unit: 'agents',
      done: 1,
      total: 6,
      running: 3,
      startedAt: LAUNCH,
      agentTiming: { meanDurationMs: 240_000, runningStartedAt: [LAUNCH + 240_000, LAUNCH + 240_000, LAUNCH + 250_000], queued: 2 },
    });
  });

  it('estimates from how long a finished agent took, so the estimate shrinks while the wave runs', () => {
    const progress = fanOutProgress()!;

    // Six minutes in, the youngest audit agent has 130 s of a typical agent's
    // 240 s to go; the two queued slots fit in one more wave behind it.
    expect(estimateRemainingMs(progress, LAUNCH + 360_000)).toBe(130_000 + 240_000);
    // A minute later the same wave has a minute less to go, where a pace of
    // one agent per six minutes would have grown to 35 minutes.
    expect(estimateRemainingMs(progress, LAUNCH + 420_000)).toBe(70_000 + 240_000);
    // An agent running past the typical time is taken as about to finish.
    expect(estimateRemainingMs(progress, LAUNCH + 900_000)).toBe(240_000);
  });

  it('runs the queued slots in waves as wide as the running set', () => {
    const progress: ActivityProgress = {
      unit: 'agents',
      done: 2,
      total: 9,
      running: 2,
      startedAt: LAUNCH,
      agentTiming: { meanDurationMs: 100_000, runningStartedAt: [LAUNCH + 200_000, LAUNCH + 230_000], queued: 5 },
    };

    // 70 s for the running pair, then three waves of up to two.
    expect(estimateRemainingMs(progress, LAUNCH + 260_000)).toBe(70_000 + 3 * 100_000);
  });

  it('keeps the rules on when there is no estimate at all', () => {
    const timing = { meanDurationMs: 240_000, runningStartedAt: [LAUNCH + 240_000], queued: 0 };

    expect(estimateRemainingMs({ unit: 'agents', done: 0, total: 3, running: 1, startedAt: LAUNCH, agentTiming: timing }, LAUNCH + 600_000)).toBeNull();
    expect(estimateRemainingMs({ unit: 'agents', done: 3, total: 3, running: 0, startedAt: LAUNCH, agentTiming: timing }, LAUNCH + 600_000)).toBeNull();
    expect(estimateRemainingMs({ unit: 'agents', done: 1, total: 3, running: 1, startedAt: LAUNCH, agentTiming: timing }, LAUNCH + 20_000)).toBeNull();
    // What is left is neither running nor queued: agents a stop abandoned.
    expect(estimateRemainingMs(
      { unit: 'agents', done: 2, total: 3, running: 0, startedAt: LAUNCH, agentTiming: { ...timing, runningStartedAt: [] } },
      LAUNCH + 600_000,
    )).toBeNull();
  });

  it('gives no estimate while more than one agent runs and the stream has not timed them', () => {
    // liveAgents' finished agents never said how long they ran.
    const untimed = deriveActivityProgress(
      [userTurn(), workflowLaunch({ taskStatus: { status: 'running', agents: liveAgents } })],
      runningTurn,
    )!;
    expect(untimed).toMatchObject({ done: 2, total: 5, running: 2 });
    expect(untimed.agentTiming).toBeUndefined();
    expect(estimateRemainingMs(untimed, LAUNCH + 600_000)).toBeNull();

    // One agent at a time is still paced the old way: 2 done in 6 minutes, 4 to go.
    expect(estimateRemainingMs({ unit: 'agents', done: 2, total: 6, running: 1, startedAt: LAUNCH }, LAUNCH + 360_000)).toBe(720_000);
  });

  it('has no per-agent timing from the journal alone, or with a running agent that never said when it started', () => {
    const journalOnly: WorkflowInfo = {
      runId: 'wf_16fbf852-274',
      name: 'frontend-architecture-audit',
      status: 'running',
      agents: [
        { id: 'p1', label: 'plan', phase: 'Plan', status: 'completed' },
        { id: 'a1', label: 'audit:chat', phase: 'Audit', status: 'running' },
      ],
      agentCounts: { total: 2, completed: 1, failed: 0, running: 1, stopped: 0 },
    };
    expect(deriveActivityProgress([userTurn(), workflowLaunch({ workflow: journalOnly })], runningTurn)?.agentTiming)
      .toBeUndefined();

    const unstarted = fanOut.map((agent) => (agent.agentId === 'a3' ? { ...agent, startedAt: undefined } : agent));
    expect(deriveActivityProgress(
      [userTurn(), workflowLaunch({ taskStatus: { status: 'running', agents: unstarted } })],
      runningTurn,
    )?.agentTiming).toBeUndefined();
  });
});

describe('the progress readout', () => {
  const NOW = Date.parse('2026-10-26T10:30:00.000Z');
  const readout = (overrides: Partial<ActivityProgress>): ActivityProgress => ({
    unit: 'tasks',
    done: 3,
    total: 7,
    running: 1,
    startedAt: NOW - 180_000,
    ...overrides,
  });

  it('estimates the time left as elapsed × (total − done) / (done − doneAtStart)', () => {
    expect(estimateRemainingMs(readout({}), NOW)).toBe(240_000);
    expect(estimateRemainingMs(readout({ done: 1, total: 2, startedAt: NOW - 45_000 }), NOW)).toBe(45_000);
    // Two of the three done units were done before the window opened.
    expect(estimateRemainingMs(readout({ doneAtStart: 2 }), NOW)).toBe(720_000);
  });

  it('gives no estimate before a unit finishes, once all have, or while the pace is too young to trust', () => {
    expect(estimateRemainingMs(readout({ done: 0, startedAt: NOW - 600_000 }), NOW)).toBeNull();
    expect(estimateRemainingMs(readout({ done: 7, startedAt: NOW - 600_000 }), NOW)).toBeNull();
    expect(estimateRemainingMs(readout({ startedAt: NOW - 20_000 }), NOW)).toBeNull();
    // Every done unit was done before the window opened.
    expect(estimateRemainingMs(readout({ doneAtStart: 3, startedAt: NOW - 600_000 }), NOW)).toBeNull();
  });

  it('prints the estimate rounded to the minute, marked as approximate', () => {
    expect(formatRemainingEstimate(30_000, en)).toBe('<1m left');
    expect(formatRemainingEstimate(59_999, en)).toBe('<1m left');
    expect(formatRemainingEstimate(150_000, en)).toBe('~3m left');
    expect(formatRemainingEstimate(65 * 60_000, en)).toBe('~1h 5m left');
    expect(formatRemainingEstimate(59.6 * 60_000, en)).toBe('~1h left');
    expect(formatRemainingEstimate(2 * 60 * 60_000, en)).toBe('~2h left');
    expect(formatRemainingEstimate(180_000, zh)).toBe('约剩 3 分钟');
    expect(formatRemainingEstimate(65 * 60_000, zh)).toBe('约剩 1 小时 5 分钟');
  });

  it('reads 100% only when every unit is done', () => {
    expect(computeProgressPercent({ done: 3, total: 7 })).toBe(43);
    expect(computeProgressPercent({ done: 0, total: 5 })).toBe(0);
    expect(computeProgressPercent({ done: 199, total: 200 })).toBe(99);
    expect(computeProgressPercent({ done: 7, total: 7 })).toBe(100);
    expect(computeProgressPercent({ done: 0, total: 0 })).toBe(0);
  });

  it('counts agents and tasks, pluralized on the total', () => {
    expect(formatProgressCount({ unit: 'agents', done: 3, total: 7 }, en)).toBe('3/7 agents');
    expect(formatProgressCount({ unit: 'agents', done: 0, total: 1 }, en)).toBe('0/1 agent');
    expect(formatProgressCount({ unit: 'tasks', done: 2, total: 5 }, en)).toBe('2/5 tasks');
    expect(formatProgressCount({ unit: 'agents', done: 3, total: 7 }, zh)).toBe('3/7 个智能体');
    expect(formatProgressCount({ unit: 'tasks', done: 2, total: 5 }, zh)).toBe('2/5 项任务');
  });
});
