import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useSessionProtection } from '@/shared/hooks/useSessionProtection';
import type { BackgroundTaskSummary, NormalizedMessage, ProjectSession, ServerEvent, SessionActivity } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

/**
 * The turn's `complete` used to mark the session idle outright, although the
 * runtime keeps the CLI open while the agents, workflows or commands the turn
 * launched are still running. The handler now reads the session's task events
 * — the same fold the transcript's cards draw from — and leaves the session
 * as background work with those tasks, until their notifications empty the
 * set, without waiting for the running-sessions poll. A stopped turn leaves
 * it idle, unless the server says the work goes on: the stop ended only a
 * turn that went into the process held for that work.
 */

type ActivityLog = Array<{ sessionId: string; tasks: BackgroundTaskSummary[] } | { sessionId: string; idle: true }>;

/**
 * `reporter: false` renders a chat the page did not elect to report the
 * session's background work; `activity` is the session's entry beforehand.
 */
const renderHandlers = ({ reporter = true, activity }: { reporter?: boolean; activity?: SessionActivity } = {}) => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const stored: NormalizedMessage[] = [];
  const log: ActivityLog = [];
  const syncs: string[] = [];
  // Every read of the running sessions the handler asks for.
  const refreshes: string[] = [];
  // The activity map as the provider would hold it, so the handler's read of
  // "is this session background-only" sees its own earlier report.
  const activityBySession = new Map<string, SessionActivity>(activity ? [['viewed-session', activity]] : []);

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: 'viewed-session' } as ProjectSession,
    currentSessionId: 'viewed-session',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    claimPageEffect: () => true,
    isBackgroundReporter: () => reporter,
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    onSessionIdle: (sessionId) => {
      if (sessionId) {
        activityBySession.delete(sessionId);
        log.push({ sessionId, idle: true });
      }
    },
    onSessionBackground: (sessionId, tasks) => {
      if (tasks.length > 0) {
        activityBySession.set(sessionId, { statusText: null, canInterrupt: false, startedAt: tasks[0].startedAt, background: true, tasks });
      } else {
        activityBySession.delete(sessionId);
      }
      log.push({ sessionId, tasks });
    },
    getSessionActivity: (sessionId) => activityBySession.get(sessionId),
    refreshRunningSessions: async () => { refreshes.push('read'); },
    requestLatestMessages: async (sessionId) => { syncs.push(sessionId); },
    sessionStore: {
      appendRealtime: (_sessionId: string, msg: NormalizedMessage) => { stored.push(msg); },
      getMessages: () => stored,
      updateStreaming: () => {},
      finalizeStreaming: () => {},
    } as unknown as SessionStore,
  }));

  const dispatch = (event: ServerEvent) => listener?.(event);
  return { dispatch, log, syncs, refreshes, stored };
};

const event = (fields: Record<string, unknown>): ServerEvent => ({
  id: `event-${Math.random()}`,
  sessionId: 'viewed-session',
  provider: 'claude',
  timestamp: '2026-08-21T10:32:10.000Z',
  ...fields,
} as unknown as ServerEvent);

const workflowLaunch = () => [
  event({ kind: 'tool_use', toolId: 'toolu_workflow_1', toolName: 'Workflow', toolInput: { script: '', description: 'Audit the frontend' } }),
  event({ kind: 'tool_result', toolId: 'toolu_workflow_1', content: 'Workflow launched in background', toolUseResult: { status: 'async_launched', taskId: 'wxkj4kcvd' } }),
  event({ kind: 'task_status', event: 'started', taskId: 'wxkj4kcvd', toolUseId: 'toolu_workflow_1', taskType: 'local_workflow', workflowName: 'audit', description: 'Audit the frontend' }),
];

test('a turn that ends with a task still running leaves the session as background work', () => {
  const { dispatch, log } = renderHandlers();

  workflowLaunch().forEach(dispatch);
  dispatch(event({ kind: 'complete', success: true }));

  assert.deepEqual(log, [{
    sessionId: 'viewed-session',
    tasks: [{
      taskId: 'wxkj4kcvd',
      toolUseId: 'toolu_workflow_1',
      taskType: 'local_workflow',
      description: 'Audit the frontend',
      workflowName: 'audit',
      startedAt: Date.parse('2026-08-21T10:32:10.000Z'),
    }],
  }]);
});

test('the task\'s notification then marks the background-only session idle', () => {
  const { dispatch, log, syncs } = renderHandlers();

  workflowLaunch().forEach(dispatch);
  dispatch(event({ kind: 'complete', success: true }));
  // Progress while the work runs changes nothing about the set.
  dispatch(event({ kind: 'task_status', event: 'progress', taskId: 'wxkj4kcvd', toolUseId: 'toolu_workflow_1', summary: 'Verify 3/6' }));
  assert.equal(log.length, 1);
  const syncsBefore = syncs.length;

  dispatch(event({ kind: 'task_status', event: 'notification', taskId: 'wxkj4kcvd', toolUseId: 'toolu_workflow_1', status: 'completed', summary: 'done' }));

  assert.deepEqual(log[1], { sessionId: 'viewed-session', tasks: [] });
  // The notification says only that the task settled; its result reaches the
  // card through the history reader, so the viewed session syncs at once.
  assert.deepEqual(syncs.slice(syncsBefore), ['viewed-session']);
});

test('a turn that ends with nothing running, or is aborted, leaves the session idle', () => {
  const { dispatch, log } = renderHandlers();

  dispatch(event({ kind: 'text', role: 'assistant', content: 'Done.' }));
  dispatch(event({ kind: 'complete', success: true }));
  assert.deepEqual(log, [{ sessionId: 'viewed-session', tasks: [] }]);

  // An abort releases the CLI and takes the launched work down with it: the
  // server's complete says nothing about background work.
  workflowLaunch().forEach(dispatch);
  dispatch(event({ kind: 'complete', aborted: true }));
  assert.deepEqual(log[1], { sessionId: 'viewed-session', idle: true });
});

const RUNNING_WORKFLOW: BackgroundTaskSummary = {
  taskId: 'wxkj4kcvd',
  toolUseId: 'toolu_workflow_1',
  taskType: 'local_workflow',
  description: 'Audit the frontend',
  workflowName: 'audit',
  startedAt: Date.parse('2026-08-21T10:32:10.000Z'),
};

test('a stopped turn the server says left the background work going leaves the session as background work, with the tasks the transcript names', () => {
  // The turn went into the process held for the workflow, and the stop
  // ended that turn alone.
  const { dispatch, log } = renderHandlers();

  workflowLaunch().forEach(dispatch);
  dispatch(event({ kind: 'complete', aborted: true, backgroundWork: true }));

  assert.deepEqual(log, [{ sessionId: 'viewed-session', tasks: [RUNNING_WORKFLOW] }]);
});

test('when the transcript names none of the work the server says goes on, the session keeps the tasks its entry lists', () => {
  // The launch is not loaded here, or only an agent's own tasks run; the
  // entry has them from the running-sessions poll, kept through the turn.
  const nested: BackgroundTaskSummary = { taskId: 'b1', toolUseId: 'toolu_inner', taskType: 'local_bash', description: 'Sleep', startedAt: 5, nested: true };
  const { dispatch, log } = renderHandlers({
    activity: { statusText: null, canInterrupt: true, startedAt: 9, tasks: [RUNNING_WORKFLOW, nested] },
  });

  dispatch(event({ kind: 'text', role: 'assistant', content: 'Writing the docs' }));
  dispatch(event({ kind: 'complete', aborted: true, backgroundWork: true }));

  assert.deepEqual(log, [{ sessionId: 'viewed-session', tasks: [RUNNING_WORKFLOW, nested] }]);
});

test('with the page\'s activity map, a stop that left the work going keeps the session as background work through the run\'s end, without waiting for the poll', () => {
  // The real map: the workflow's turn ends, the next turn goes into the
  // held process, and the user stops that turn alone.
  let listener: ((frame: ServerEvent) => void) | null = null;
  const stored: NormalizedMessage[] = [];
  const view = renderHook(() => {
    const protection = useSessionProtection();
    useChatRealtimeHandlers({
      isActive: true,
      subscribe: (fn) => {
        listener = fn;
        return () => { listener = null; };
      },
      provider: 'claude',
      selectedSession: { id: 'viewed-session' } as ProjectSession,
      currentSessionId: 'viewed-session',
      setTokenBudget: () => {},
      pendingPermissionRequests: [],
      setPendingPermissionRequests: () => {},
      claimPageEffect: () => true,
      isBackgroundReporter: () => true,
      lastSeqRef: { current: new Map() },
      statusCheckSentAtRef: { current: new Map() },
      onSessionProcessing: protection.markSessionProcessing,
      onSessionIdle: protection.markSessionIdle,
      onSessionBackground: protection.markSessionBackground,
      getSessionActivity: protection.getSessionActivity,
      requestLatestMessages: async () => {},
      sessionStore: {
        appendRealtime: (_sessionId: string, msg: NormalizedMessage) => { stored.push(msg); },
        getMessages: () => stored,
        getSessionSlot: () => ({ serverMessages: [] }),
        updateStreaming: () => {},
        finalizeStreaming: () => {},
        discardStreaming: () => {},
      } as unknown as SessionStore,
    });
    return protection;
  });
  const dispatch = (frame: ServerEvent) => act(() => { listener?.(frame); });
  const entry = () => {
    const activity = view.result.current.getSessionActivity('viewed-session');
    return JSON.stringify({
      background: activity?.background === true,
      tasks: (activity?.tasks ?? []).map((task) => task.taskId),
      busy: view.result.current.processingSessions.has('viewed-session'),
      responding: view.result.current.isSessionProcessing('viewed-session'),
    });
  };

  workflowLaunch().forEach(dispatch);
  dispatch(event({ kind: 'complete', success: true }));
  // The composer's send of the next turn marks the session busy again.
  act(() => { view.result.current.markSessionProcessing('viewed-session', { statusText: null, canInterrupt: true }); });
  dispatch(event({ kind: 'text', role: 'assistant', content: 'Writing the docs' }));
  assert.equal(entry(), JSON.stringify({ background: false, tasks: ['wxkj4kcvd'], busy: true, responding: true }));

  dispatch(event({ kind: 'complete', aborted: true, backgroundWork: true }));
  const afterStop = JSON.stringify({ background: true, tasks: ['wxkj4kcvd'], busy: true, responding: false });
  assert.equal(entry(), afterStop);

  // run-notifications marks the session idle at the run's end, which leaves
  // a background-only entry as it is.
  act(() => { view.result.current.markSessionIdle('viewed-session'); });
  assert.equal(entry(), afterStop);
});

test('a chat the page did not elect to report the work leaves the session alone at such a stop, rather than idle it', () => {
  const { dispatch, log } = renderHandlers({ reporter: false });

  workflowLaunch().forEach(dispatch);
  dispatch(event({ kind: 'complete', aborted: true, backgroundWork: true }));

  assert.deepEqual(log, []);
});

test('tasks the history load left running count too, described by their launch', () => {
  // The page loaded after their start events went by: the backend's word
  // from the journal is what says they still run, and the acknowledgement is
  // what names them. A launch nothing has named is left to the poll.
  const { dispatch, log } = renderHandlers();

  dispatch(event({
    kind: 'tool_use', toolId: 'toolu_agent_1', toolName: 'Agent', toolInput: { description: 'Survey the repo', prompt: '…' },
    subagent: { id: 'a1', description: 'Survey the repo', status: 'running' },
  }));
  dispatch(event({
    kind: 'tool_result', toolId: 'toolu_agent_1', content: '',
    // The real acknowledgement: no `taskId`, the agent's id is the task's.
    toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a1' },
  }));
  dispatch(event({
    kind: 'tool_use', toolId: 'toolu_workflow_1', toolName: 'Workflow', toolInput: { script: '' },
    workflow: { runId: 'wf_1', name: 'audit', status: 'running', agents: [], agentCounts: { total: 0, completed: 0, failed: 0, running: 0, stopped: 0 } },
  }));
  dispatch(event({
    kind: 'tool_result', toolId: 'toolu_workflow_1', content: '',
    toolUseResult: { status: 'async_launched', taskId: 'wxkj4kcvd', taskType: 'local_workflow', workflowName: 'audit' },
  }));
  dispatch(event({
    kind: 'tool_use', toolId: 'toolu_agent_2', toolName: 'Agent', toolInput: { description: 'Unnamed', prompt: '…' },
    subagent: { id: '', description: 'Unnamed', status: 'running' },
  }));
  dispatch(event({ kind: 'complete', success: true }));

  assert.deepEqual(log, [{
    sessionId: 'viewed-session',
    tasks: [
      { taskId: 'a1', toolUseId: 'toolu_agent_1', taskType: 'local_agent', description: 'Survey the repo', startedAt: Date.parse('2026-08-21T10:32:10.000Z') },
      { taskId: 'wxkj4kcvd', toolUseId: 'toolu_workflow_1', taskType: 'local_workflow', description: '', workflowName: 'audit', startedAt: Date.parse('2026-08-21T10:32:10.000Z') },
    ],
  }]);
});

test('a task ending during a turn in flight is left to the turn\'s complete', () => {
  const { dispatch, log } = renderHandlers();

  workflowLaunch().forEach(dispatch);
  dispatch(event({ kind: 'task_status', event: 'notification', taskId: 'wxkj4kcvd', toolUseId: 'toolu_workflow_1', status: 'completed', summary: 'done' }));

  assert.deepEqual(log, [], 'the session is processing, not background-only');
});

test('a refused stop request does not idle the session it was sent on', () => {
  // The ✕ on a chip whose task just settled answers NO_SUCH_TASK; a response
  // may be streaming on that session, and it must keep its spinner.
  const { dispatch, log } = renderHandlers();

  dispatch(event({ kind: 'protocol_error', code: 'NO_SUCH_TASK', error: 'Session has no such task' }));
  dispatch(event({ kind: 'protocol_error', code: 'TASK_ID_REQUIRED', error: 'chat.stop-task requires a taskId' }));
  assert.deepEqual(log, []);

  // Any other rejection still means the send never became a run.
  dispatch(event({ kind: 'protocol_error', code: 'SESSION_NOT_FOUND', error: 'gone' }));
  assert.deepEqual(log, [{ sessionId: 'viewed-session', idle: true }]);
});

test('a turn\'s end reads the running sessions at once, for the scheduled work only the server knows of', () => {
  // A /loop the turn set up shows the moment the turn is over, not at the
  // next poll; the read comes after the remaining tasks are reported.
  const { dispatch, log, refreshes } = renderHandlers();

  dispatch(event({ kind: 'text', role: 'assistant', content: 'I will check CI every 5 minutes.' }));
  dispatch(event({ kind: 'complete', success: true }));
  assert.equal(log.length, 1);
  assert.deepEqual(refreshes, ['read']);

  // A stop that left the held process's work going: read too.
  dispatch(event({ kind: 'complete', aborted: true, backgroundWork: true }));
  assert.deepEqual(refreshes, ['read', 'read']);

  // A stop that took the process down: nothing is left to read about.
  dispatch(event({ kind: 'complete', aborted: true }));
  assert.deepEqual(refreshes, ['read', 'read']);
});

test('only the chat that reports the session\'s background work reads the running sessions at a turn\'s end', () => {
  const { dispatch, refreshes } = renderHandlers({ reporter: false });

  dispatch(event({ kind: 'complete', success: true }));
  assert.deepEqual(refreshes, []);
});

test('the answer to a stop of scheduled work is no transcript row and changes no activity', () => {
  const { dispatch, log, stored } = renderHandlers({
    activity: { statusText: null, canInterrupt: false, startedAt: 1, background: true, tasks: [], scheduled: [] },
  });

  dispatch(event({ kind: 'stop_task_status', taskId: 'cron:b2148320', status: 'started' }));
  dispatch(event({ kind: 'stop_task_status', taskId: 'cron:b2148320', status: 'finished', stillHeld: false }));
  assert.equal(stored.length, 0);
  assert.deepEqual(log, []);
});
