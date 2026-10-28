import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { WebSocket } from 'ws';

import {
  closeConnection,
  initializeDatabase,
  notificationPreferencesDb,
  userDb,
} from '@/modules/database/index.js';
import {
  registerDesktopNotificationClient,
  setNotificationRunLookup,
  unregisterDesktopNotificationClient,
} from '@/modules/notifications/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { createProviderRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  abortClaudeSDKSession,
  claudeRuntime,
  listClaudeSDKBackgroundWork,
  queryClaudeSDK,
  stopClaudeSDKTask,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * The runtime keeps the CLI's stdin open after a turn's `result` while the
 * turn's background work is outstanding, and lets go when that work has
 * reported. These drive `queryClaudeSDK` with a scripted SDK stream — the
 * seam is `context.createQuery` — and watch the held prompt stream: the CLI
 * exits when it ends, so "released" is the whole outcome.
 */

const SESSION_ID = 'app-hold-session';
const NATIVE_ID = 'native-hold-session';

// A held process takes the session's next turn itself, keeping its background
// work (claude-runtime-held-turn.test.ts). An edited message resumes the
// conversation partway, which only a new process can, so the later turns
// here still replace the process held before them.
const EDITED_TURN = { resumeAnchorId: 'edited-turn' };

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  /** Makes the stream throw, as the SDK's does when the CLI fails. */
  fail: (error: Error) => void;
  released: () => boolean;
  stopped: string[];
  /**
   * What reached the CLI, in order: `interrupt` and `stop:<taskId>` for
   * control requests written while its stdin was open, `release` when the
   * held prompt stream ended, `close` when the query was closed.
   */
  calls: string[];
  /**
   * Control requests written after the release. The SDK drops them, and their
   * promise only settles, rejected, when the query closes.
   */
  dropped: string[];
  closed: () => boolean;
  /** Whether the runtime has built this query yet. */
  created: () => boolean;
  /** The options the runtime built the query with. */
  options: () => Record<string, unknown> | null;
};

type ScriptedBehaviour = {
  /** `hang` leaves every interrupt unanswered until the query closes. */
  interrupt?: 'reply' | 'hang';
};

/** A stand-in for the SDK query: yields what the test emits, and reads the held prompt to notice its release. */
function createScriptedQuery(
  behaviour: ScriptedBehaviour = {},
): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  const queue: Array<Record<string, unknown> | Error | null> = [];
  let wake: (() => void) | null = null;
  let released = false;
  let closed = false;
  let builtWith: Record<string, unknown> | null = null;
  const stopped: string[] = [];
  const calls: string[] = [];
  const dropped: string[] = [];
  // Requests the CLI never answers; closing the query rejects them, as the SDK does.
  const unanswered: Array<(error: Error) => void> = [];
  const unansweredRequest = () => new Promise<void>((_resolve, reject) => { unanswered.push(reject); });

  const script: Scripted = {
    emit: (message) => { queue.push(message); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
    fail: (error) => { queue.push(error); wake?.(); },
    released: () => released,
    stopped,
    calls,
    dropped,
    closed: () => closed,
    created: () => builtWith !== null,
    options: () => builtWith,
  };

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt, options }) => {
    builtWith = options;
    void (async () => {
      for await (const _message of prompt) { /* the CLI reads its stdin */ }
      released = true;
      calls.push('release');
    })();

    const iterator = (async function* () {
      for (;;) {
        if (closed) {
          return;
        }
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const next = queue.shift();
        if (next === null || next === undefined) {
          return;
        }
        if (next instanceof Error) {
          throw next;
        }
        yield next;
      }
    })();

    return Object.assign(iterator, {
      interrupt: async () => {
        if (released) {
          dropped.push('interrupt');
          return unansweredRequest();
        }
        calls.push('interrupt');
        if (behaviour.interrupt === 'hang') {
          return unansweredRequest();
        }
      },
      stopTask: async (taskId: string) => {
        if (released) {
          dropped.push(`stop:${taskId}`);
          return unansweredRequest();
        }
        stopped.push(taskId);
        calls.push(`stop:${taskId}`);
      },
      close: () => {
        if (closed) {
          return;
        }
        closed = true;
        calls.push('close');
        for (const reject of unanswered.splice(0)) {
          reject(new Error('Query closed before response received'));
        }
        wake?.();
      },
    });
  };

  return { createQuery, script };
}

/**
 * A writer like the chat gateway's: it records what the runtime sends, and
 * counts the runtime's reports that held background work has finished. A
 * `userId` turns the run's notifications on (see withNotifications), and
 * `runStartedAt` names the run the way the gateway's writer does.
 */
function createWriter({ userId = null, runStartedAt }: { userId?: number | null; runStartedAt?: number } = {}) {
  const sent: NormalizedMessage[] = [];
  let finishedReports = 0;
  const writer = {
    send: (message: NormalizedMessage) => { sent.push(message); },
    userId,
    runStartedAt,
    reportBackgroundWorkFinished: () => { finishedReports += 1; },
  };
  return { writer, sent, finishedReports: () => finishedReports };
}

async function withRun(
  runTest: (context: {
    script: Scripted;
    sent: NormalizedMessage[];
    done: Promise<unknown>;
    finishedReports: () => number;
  }) => Promise<void>,
  behaviour: ScriptedBehaviour = {},
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const { createQuery, script } = createScriptedQuery(behaviour);
  const { writer, sent, finishedReports } = createWriter();
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
  };

  try {
    const done = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, writer as never, context);
    // The run reads files before it starts its CLI. Once the CLI is up, what a
    // test emits is handled within a flush, so the tests' timelines start here.
    await waitUntil(() => script.created());
    try {
      await runTest({ script, sent, done, finishedReports });
    } finally {
      // Also when an assertion failed, so the run does not hold the session
      // into the next test.
      script.end();
    }
    await done;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 25); });

// A fixed settle can be too short on a loaded machine; the supersede tests
// wait for the run to have actually processed its turn instead.
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await settle();
  }
  assert.ok(condition(), 'condition never became true');
}

const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const ack = (id: string, text: string, toolUseResult: Record<string, unknown>) => ({
  type: 'user', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  tool_use_result: toolUseResult,
});
const taskStarted = (taskId: string, toolUseId: string, taskType: string) => ({
  type: 'system', subtype: 'task_started', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, description: `Task ${taskId}`, task_type: taskType,
});
const taskNotification = (taskId: string, toolUseId: string, status: string) => ({
  type: 'system', subtype: 'task_notification', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, status, summary: `Task ${taskId} ${status}`, output_file: '',
});
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'launched', duration_ms: 1, num_turns: 1 });
// The `result` the CLI ends a batch of its own task notifications with: no
// model call for an orphan (0 turns), a real turn for a revived notification.
const internalResult = (numTurns: number) => ({
  type: 'result', subtype: 'success', is_error: false, session_id: NATIVE_ID, result: '', duration_ms: 0, num_turns: numTurns,
  total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, modelUsage: {},
  origin: { kind: 'task-notification' },
});
// The `result` of the turn the CLI starts to relay a finished task.
const followUpResult = () => ({ ...result(), result: 'relayed', origin: { kind: 'task-notification' } });
// The `result` that ends a turn the user interrupted.
const interruptedResult = () => ({
  type: 'result', subtype: 'error_during_execution', is_error: true, session_id: NATIVE_ID, duration_ms: 1, num_turns: 1, errors: ['interrupted'],
});
const assistantText = (text: string, parentToolUseId: string | null = null) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: parentToolUseId,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const statusEvent = () => ({ type: 'system', subtype: 'status', session_id: NATIVE_ID, status: 'requesting' });

function launchWorkflow(script: Scripted): void {
  script.emit(init());
  script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
  script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
  script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
}

function launchAgent(script: Scripted): void {
  script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 900', subagent_type: 'general-purpose', run_in_background: true }));
  script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
  script.emit(ack('toolu_agent', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
}

const completes = (sent: NormalizedMessage[]) => sent.filter((message) => message.kind === 'complete').length;
const listedTasks = () => listClaudeSDKBackgroundWork().map((entry) => [entry.sessionId, entry.tasks.map((task) => task.taskId)]);

const MINUTE = 60 * 1000;
// The runtime's defaults; the tests run without the env overrides.
const HOLD_IDLE_MS = 30 * MINUTE;
const HOLD_MAX_MS = 12 * 60 * MINUTE;

// Waits that keep working while `setTimeout` is mocked: the tests below mock
// only `setTimeout`, so these lean on `setImmediate`.
async function flush(rounds = 10): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

// Gives up after five seconds of real time (the mocked `setTimeout` leaves
// `performance.now()` alone) rather than after a number of rounds: a run
// starting up waits on file reads, which a loaded machine stretches past any
// fixed count.
async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!condition() && performance.now() < deadline) {
    await flush(1);
  }
  assert.equal(condition(), true, 'condition never became true');
}

// Settles to the promise's value, or to 'pending' when it is still waiting
// after the flush: how a test tells "returned at once" from "hangs".
const settledNow = <T>(promise: Promise<T>) => Promise.race([promise, flush().then(() => 'pending' as const)]);

function createContext(): Omit<ProviderRuntimeContext, 'createQuery'> {
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  return {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };
}

/**
 * Adds a probe to a run's context: `started` turns true when the run, done
 * waiting for the session's exiting process, resolves its model, the first
 * thing it does after that wait. A query's `created` only turns after file
 * reads, so a check on it right after a flush can pass by luck; this one
 * tells "still waiting" from "on its way" within a flush.
 */
function probeStart(context: Omit<ProviderRuntimeContext, 'createQuery'>) {
  let started = false;
  return {
    context: {
      ...context,
      resolveResumeModel: (sessionId: string | undefined, requestedModel?: string | null) => {
        started = true;
        return context.resolveResumeModel(sessionId, requestedModel);
      },
    },
    started: () => started,
  };
}

/** A notification as a desktop app socket received it: `[code, body]`. */
type DeliveredNotification = [string, string];

/**
 * Runs a test with notifications on: an isolated database holds a user whose
 * notifications reach only a desktop app socket (Web Push off, so nothing
 * leaves the process), every event switch on. Writers built with the user id
 * report to it.
 *
 * Repeats collapse for 20 s across the whole process, keyed by session and,
 * when it is known, by run, so each test gives its runs a session of its own.
 */
async function withNotifications(
  runTest: (capture: { userId: number; delivered: () => DeliveredNotification[] }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');

  const frames: Array<{ payload: { body: string; data: { code: string } } }> = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (message: string) => { frames.push(JSON.parse(message)); },
    close: () => undefined,
  } as unknown as WebSocket;

  try {
    await initializeDatabase();
    const userId = Number(userDb.createUser('hold-notifications', 'password-hash').id);
    notificationPreferencesDb.updatePreferences(userId, {
      channels: { webPush: false, desktop: true },
      events: { actionRequired: true, stop: true, error: true },
    });
    registerDesktopNotificationClient({ userId, deviceId: 'hold-device', ws: socket });
    await runTest({
      userId,
      delivered: () => frames.map((frame): DeliveredNotification => [frame.payload.data.code, frame.payload.body]),
    });
  } finally {
    unregisterDesktopNotificationClient(socket);
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

const STOPPED_ABORTED: DeliveredNotification = ['run.stopped', 'Claude: aborted'];
const STOPPED_COMPLETED: DeliveredNotification = ['run.stopped', 'Claude: completed'];
// Repeats of a notification inside this window collapse into one.
const NOTIFICATION_DEDUPE_MS = 20 * 1000;

test('stopping the last outstanding task releases the held process', async () => {
  await withRun(async ({ script, sent, done, finishedReports }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await settle();

    // The turn is over for the client, the process is held for the workflow.
    assert.ok(sent.some((message) => message.kind === 'complete'));
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => [entry.sessionId, entry.tasks.map((task) => task.taskId)]), [[SESSION_ID, ['wf1']]]);
    assert.equal(script.released(), false, 'stdin stays open while the workflow runs');

    // The user stops it. The CLI answers with a `stopped` notification and
    // pushes no follow-up turn, so nothing else would ever end the hold.
    assert.equal(await stopClaudeSDKTask(SESSION_ID, 'wf1'), true);
    assert.deepEqual(script.stopped, ['wf1']);
    script.emit(taskNotification('wf1', 'toolu_wf', 'stopped'));
    await settle();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'the process is let go once nothing is outstanding');
    assert.equal(finishedReports(), 0, 'a stopped task pushes no follow-up turn, so no work is reported finished');
    void done;
  });
});

test('a task that reported completed keeps the hold for the turn that relays its result', async () => {
  await withRun(async ({ script, finishedReports }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await settle();
    assert.equal(finishedReports(), 0, 'the turn that launched the workflow finished nothing in the background');

    // Completed, unlike stopped, is followed by a turn the CLI pushes to relay
    // the result; closing stdin at the notification would cut it short.
    script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    await settle();
    assert.equal(script.released(), false);
    assert.equal(finishedReports(), 0, 'the work is reported once its follow-up turn is in, not at the notification');

    script.emit(result());
    await settle();
    assert.equal(script.released(), true, 'the follow-up turn\'s result ends the hold');
    assert.equal(finishedReports(), 1, 'the writer hears once that the held work has finished');
  });
});

test('an agent that ran in the foreground and settled before the result does not hold the process', async () => {
  await withRun(async ({ script, finishedReports }) => {
    // An Agent call without `run_in_background` is scored as background by
    // the static rule, but the CLI ran it in the foreground: its task started
    // and settled before the turn ended. The task events know that.
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'Return the word FOUR', subagent_type: 'general-purpose' }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    script.emit(ack('toolu_agent', 'FOUR', { status: 'completed', agentId: 'a1' }));
    script.emit(result());
    await settle();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'nothing is outstanding, so nothing to hold for');
    assert.equal(finishedReports(), 0, 'a turn with no background work reports none finished');
  });
});

test('a turn that needs a new process stops the tasks the held process still has going before letting it go', async () => {
  // Two runs on one session, each with its own scripted CLI: the first is
  // held for a background agent, the second is the user's next message.
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const { writer, sent, finishedReports } = createWriter();
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: Omit<ProviderRuntimeContext, 'createQuery'> = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };

  try {
    const firstRun = queryClaudeSDK('start an agent', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: first.createQuery });
    await settle();
    first.script.emit(init());
    first.script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 90', subagent_type: 'general-purpose', run_in_background: true }));
    first.script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    first.script.emit(ack('toolu_agent', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
    first.script.emit(result());
    await waitFor(() => sent.some((message) => message.kind === 'complete'));
    assert.equal(first.script.released(), false, 'the first process is held for its agent');

    // Closing stdin alone would leave the CLI waiting for the agent, so the
    // superseded process would live on next to the new one for as long as
    // the agent runs. The stop has to reach it before stdin ends, because the
    // SDK drops control requests written to an ended stdin.
    const secondRun = queryClaudeSDK('Continue', { sessionId: SESSION_ID, cwd, ...EDITED_TURN }, writer as never, { ...context, createQuery: second.createQuery });
    await settle();
    assert.deepEqual(first.script.stopped, ['a1'], 'the held process is told to stop its agent');
    assert.equal(first.script.released(), true, 'and is then let go');
    assert.deepEqual(second.script.stopped, [], 'the new process is untouched');

    first.script.emit(taskNotification('a1', 'toolu_agent', 'stopped'));
    first.script.end();
    await firstRun;
    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(finishedReports(), 0, 'work a new turn stopped never reports finished');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a held process is still let go when stopping its tasks throws', async () => {
  // Stopping is best effort; a stop that throws on the spot must not keep the
  // held process alive or take the new turn down with it.
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: Omit<ProviderRuntimeContext, 'createQuery'> = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };
  const throwingStop: NonNullable<ProviderRuntimeContext['createQuery']> = (options) =>
    Object.assign(first.createQuery(options), {
      stopTask: () => { throw new Error('stop failed'); },
    });

  try {
    const firstRun = queryClaudeSDK('start an agent', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: throwingStop });
    await settle();
    first.script.emit(init());
    first.script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 90', subagent_type: 'general-purpose', run_in_background: true }));
    first.script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    first.script.emit(ack('toolu_agent', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
    first.script.emit(result());
    await waitFor(() => sent.some((message) => message.kind === 'complete'));
    assert.equal(first.script.released(), false, 'the first process is held for its agent');

    const secondRun = queryClaudeSDK('Continue', { sessionId: SESSION_ID, cwd, ...EDITED_TURN }, writer as never, { ...context, createQuery: second.createQuery });
    await settle();
    assert.equal(first.script.released(), true, 'the held process is let go anyway');

    first.script.end();
    await firstRun;
    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
    assert.equal(second.script.released(), true, 'the new turn ran to completion');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a turn whose tool emits no task events still holds on the static rule', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
    script.emit(ack('toolu_monitor', 'Monitor started', {}));
    script.emit(result());
    await settle();

    assert.equal(script.released(), false, 'Monitor reports no task, so the launch rule decides');
  });
});

test('a batch of orphan task notifications at the start of a resumed run does not end the turn', async () => {
  await withRun(async ({ script, sent, finishedReports }) => {
    // On resume the CLI first reports a task the previous process never
    // finished, in a batch of its own that ends in a model-free result.
    script.emit(init());
    script.emit(taskNotification('old', 'toolu_old', 'stopped'));
    script.emit(internalResult(0));
    await flush();
    assert.equal(completes(sent), 0, 'the batch\'s result is not the turn\'s');
    assert.equal(script.released(), false, 'stdin stays open for the prompt\'s own turn');
    assert.equal(finishedReports(), 0);
    assert.equal(sent.some((message) => message.kind === 'status' && message.text === 'token_budget'), false, 'its all-zero usage is not published');

    // The prompt's own turn launches a workflow and ends.
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await flush();
    assert.equal(completes(sent), 1, 'the prompt\'s own result ends the turn');
    assert.equal(script.released(), false, 'and the process is held for the workflow');

    // The workflow reports back in a turn the CLI starts for its notification.
    script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    script.emit(followUpResult());
    await flush();
    assert.equal(script.released(), true);
    assert.equal(finishedReports(), 1, 'the work is reported finished once');
    assert.equal(completes(sent), 1, 'and the turn is not completed again');
  });
});

test('a revived notification turn at the start of a run does not end the turn either', async () => {
  await withRun(async ({ script, sent, finishedReports }) => {
    // A notification the previous process left queued runs a real turn on
    // resume. It calls the model, here starting a Monitor, but its result is
    // still not the prompt's.
    script.emit(init());
    script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
    script.emit(ack('toolu_monitor', 'Monitor started', {}));
    script.emit(internalResult(2));
    await flush();
    assert.equal(completes(sent), 0);
    assert.equal(script.released(), false);

    script.emit(result());
    await flush();
    assert.equal(completes(sent), 1);
    assert.equal(script.released(), false, 'the Monitor that turn started still holds the process');
    assert.equal(finishedReports(), 0);
  });
});

test('a zero-turn result for the prompt itself still ends the turn', async () => {
  // A local slash command: the CLI answers without the model, and no origin.
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit({ ...result(), result: '', num_turns: 0 });
    await flush();
    assert.equal(completes(sent), 1);
    assert.equal(script.released(), true);
  });

  // A prompt a hook blocked: an error result with no turns, for the user's own message.
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: NATIVE_ID, duration_ms: 1, num_turns: 0, errors: ['blocked by hook'], origin: { kind: 'human' } });
    await flush();
    assert.equal(completes(sent), 1);
    assert.equal(script.released(), true);
  });
});

test('the session\'s own task keeps the process held through silence until HOLD_MAX stops it', async (t) => {
  await withRun(async ({ script, finishedReports }) => {
    launchWorkflow(script);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    script.emit(result());
    await flush();
    assert.equal(script.released(), false);

    // A backgrounded command says nothing until it ends, so silence alone
    // never lets the session's own work go.
    t.mock.timers.tick(HOLD_IDLE_MS);
    await flush();
    assert.equal(script.released(), false);
    assert.deepEqual(script.stopped, []);

    t.mock.timers.tick(HOLD_MAX_MS - HOLD_IDLE_MS);
    await flush();
    assert.deepEqual(script.calls, ['stop:wf1', 'release'], 'the workflow is stopped while stdin is open, then the CLI is let go');
    // The CLI marks the workflow killed, and may still run a turn before it exits.
    script.emit({ type: 'system', subtype: 'task_updated', session_id: NATIVE_ID, task_id: 'wf1', patch: { status: 'killed' } });
    script.emit(followUpResult());
    await flush();
    assert.equal(finishedReports(), 0, 'giving up on the work is not the work finishing');

    // The CLI stops what is left and exits within its own five-minute
    // ceiling; one still up a minute after that is closed.
    t.mock.timers.tick(6 * MINUTE - 1);
    await flush();
    assert.equal(script.closed(), false);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(script.closed(), true);
    // A closed process makes the session's next run wait 8 s, and the next
    // test runs on this session too.
    t.mock.timers.tick(8 * 1000);
  });
});

test('a follow-up turn pushes HOLD_MAX back; subagent traffic does not', async (t) => {
  await withRun(async ({ script }) => {
    launchWorkflow(script);
    launchAgent(script);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    script.emit(result());
    await flush();

    // The workflow reports back a minute before HOLD_MAX; the agent runs on.
    t.mock.timers.tick(HOLD_MAX_MS - MINUTE);
    script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    script.emit(followUpResult());
    await flush();
    t.mock.timers.tick(MINUTE);
    await flush();
    assert.equal(script.released(), false, 'a follow-up result pushes HOLD_MAX back');

    // A main-thread message of a follow-up turn counts the same way.
    t.mock.timers.tick(HOLD_MAX_MS - 2 * MINUTE);
    script.emit(assistantText('Still relaying'));
    await flush();
    t.mock.timers.tick(2 * MINUTE);
    await flush();
    assert.equal(script.released(), false, 'a main-thread assistant message pushes HOLD_MAX back');

    // The agent's own transcript is not a follow-up turn.
    t.mock.timers.tick(HOLD_MAX_MS - 3 * MINUTE);
    script.emit(assistantText('Agent progress', 'toolu_agent'));
    await flush();
    t.mock.timers.tick(3 * MINUTE);
    await flush();
    assert.equal(script.released(), true, 'subagent traffic leaves HOLD_MAX where it was');
    assert.deepEqual(script.stopped, ['a1']);
  });
});

test('a hold with none of the session\'s own tasks outstanding ends after HOLD_IDLE of silence', async (t) => {
  await withRun(async ({ script, finishedReports }) => {
    script.emit(init());
    script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
    script.emit(ack('toolu_monitor', 'Monitor started', {}));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    script.emit(result());
    await flush();

    t.mock.timers.tick(HOLD_IDLE_MS - MINUTE);
    script.emit(statusEvent());
    await flush();
    t.mock.timers.tick(HOLD_IDLE_MS - MINUTE);
    await flush();
    assert.equal(script.released(), false, 'anything from the CLI pushes the countdown back out');

    t.mock.timers.tick(MINUTE);
    await flush();
    assert.equal(script.released(), true);
    // The CLI may still run a turn for the Monitor before it exits.
    script.emit(followUpResult());
    await flush();
    assert.equal(finishedReports(), 0, 'running out of silence is not the work finishing');
  });
});

test('a hold kept only for nested tasks ends after HOLD_IDLE of silence', async (t) => {
  await withRun(async ({ script, finishedReports }) => {
    script.emit(init());
    // Started for a call inside an agent's own transcript: none of this
    // session's turns issued toolu_inner.
    script.emit(taskStarted('n1', 'toolu_inner', 'local_bash'));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    script.emit(result());
    await flush();
    assert.equal(script.released(), false, 'held while the nested task is outstanding');

    t.mock.timers.tick(HOLD_IDLE_MS);
    await flush();
    assert.equal(script.released(), true);
    assert.deepEqual(script.stopped, []);
    assert.equal(finishedReports(), 0);
  });
});

test('a housekeeping task the CLI starts on its own does not cost a Monitor its hold', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
    script.emit({ type: 'system', subtype: 'task_started', session_id: NATIVE_ID, task_id: 'ambient', description: 'housekeeping', task_type: 'local_agent' });
    script.emit(ack('toolu_monitor', 'Monitor started', {}));
    script.emit(result());
    await flush();

    assert.equal(script.released(), false, 'a task without a tool_use_id is not one the tracker follows');
  });
});

test('a turn that needs a new process interrupts and stops a held process, then waits for it to exit before starting its own', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const { writer, sent, finishedReports } = createWriter();
  const context = createContext();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  try {
    const firstRun = queryClaudeSDK('start work', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: first.createQuery });
    await waitUntil(() => first.script.created());
    launchWorkflow(first.script);
    launchAgent(first.script);
    first.script.emit(result());
    // The workflow reports back, and the CLI is part-way through the turn
    // that relays it when the user sends the next message.
    first.script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    first.script.emit(assistantText('The workflow finished.'));
    await waitUntil(() => completes(sent) === 1);
    await flush();
    assert.equal(first.script.released(), false);

    const next = probeStart(context);
    const secondRun = queryClaudeSDK('Continue', { sessionId: SESSION_ID, cwd, ...EDITED_TURN }, writer as never, { ...next.context, createQuery: second.createQuery });
    await flush();
    assert.deepEqual(first.script.calls, ['interrupt', 'stop:a1', 'release'], 'the turn is interrupted and the agent stopped while stdin is open, then stdin ends');
    assert.equal(next.started(), false, 'the new CLI waits for the old one to exit');

    // Until it exits, nothing the old process says belongs to anyone.
    first.script.emit(taskStarted('b1', 'toolu_b1', 'local_bash'));
    first.script.emit(result());
    await flush();
    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(completes(sent), 1);
    assert.equal(finishedReports(), 0);
    assert.equal(next.started(), false);

    t.mock.timers.tick(15 * 1000);
    await waitUntil(() => first.script.closed());
    // Closing ends the old loop at once, while the SDK kills the process only
    // seconds later, so the new CLI waits out that schedule as well.
    await firstRun;
    await flush();
    assert.equal(next.started(), false, 'an old process still up after 15 s is closed, and given 8 s more');
    t.mock.timers.tick(8 * 1000 - 1);
    await flush();
    assert.equal(next.started(), false);
    t.mock.timers.tick(1);
    await waitUntil(() => second.script.created());

    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
    assert.equal(completes(sent), 2);
    assert.equal(finishedReports(), 0);
  } finally {
    // Lets runs left waiting by a failed assertion wind down.
    first.script.end();
    second.script.end();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a new turn sends nothing to a process whose input is released, and closes it after 15 s', async (t) => {
  const consoleError = t.mock.method(console, 'error');
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const { writer } = createWriter();
  const context = createContext();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  try {
    const firstRun = queryClaudeSDK('Hi', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: first.createQuery });
    await waitUntil(() => first.script.created());
    first.script.emit(init());
    first.script.emit(result());
    // Nothing was outstanding, so stdin is already released; the CLI has
    // not exited yet.
    await waitUntil(() => first.script.released());

    const next = probeStart(context);
    const secondRun = queryClaudeSDK('Continue', { sessionId: SESSION_ID, cwd }, writer as never, { ...next.context, createQuery: second.createQuery });
    await flush();
    assert.deepEqual(first.script.dropped, [], 'no control request is written to an ended stdin');
    assert.equal(next.started(), false);

    t.mock.timers.tick(15 * 1000);
    await waitUntil(() => first.script.closed());
    await firstRun;
    await flush();
    assert.equal(next.started(), false, 'the closed process is given 8 s to be killed');
    t.mock.timers.tick(8 * 1000 - 1);
    await flush();
    assert.equal(next.started(), false);
    t.mock.timers.tick(1);
    await waitUntil(() => second.script.created());

    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
    const errors = consoleError.mock.calls.map((call) => String(call.arguments[0]));
    assert.equal(errors.some((line) => line.includes('Error interrupting superseded run')), false);
  } finally {
    // Lets runs left waiting by a failed assertion wind down.
    first.script.end();
    second.script.end();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('an abort while a new run waits for the old process keeps the new run from starting its CLI', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const { writer, sent } = createWriter();
  const context = createContext();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  try {
    const firstRun = queryClaudeSDK('start an agent', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: first.createQuery });
    await waitUntil(() => first.script.created());
    first.script.emit(init());
    launchAgent(first.script);
    first.script.emit(result());
    await waitUntil(() => completes(sent) === 1);

    let secondSettled = false;
    const secondRun = queryClaudeSDK('Continue', { sessionId: SESSION_ID, cwd, ...EDITED_TURN }, writer as never, { ...context, createQuery: second.createQuery })
      .finally(() => { secondSettled = true; });
    await flush();
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true, 'the starting run is found and stopped');

    first.script.end();
    await firstRun;
    await waitUntil(() => secondSettled || second.script.created());
    assert.equal(second.script.created(), false, 'its CLI never starts');
    await secondRun;
    assert.equal(completes(sent), 1, 'the abort\'s caller sends the aborted run\'s complete');
  } finally {
    // Lets a run that did start its CLI wind down when an assertion failed.
    second.script.end();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('aborting a run whose input is already released closes its process at once', async (t) => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(result());
    await waitUntil(() => script.released());
    t.mock.timers.enable({ apis: ['setTimeout'] });

    assert.equal(await settledNow(abortClaudeSDKSession(SESSION_ID)), true);
    assert.equal(script.closed(), true);
    assert.deepEqual(script.dropped, [], 'no interrupt is written to an ended stdin');
    assert.equal(completes(sent), 1, 'the turn had completed already');
    // A closed process makes the session's next run wait 8 s, and the next
    // test runs on this session too.
    t.mock.timers.tick(8 * 1000);
  });
});

test('an abort whose interrupt is never answered closes the process after 5 s', async (t) => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(assistantText('Working on it'));
    await flush();
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const aborting = abortClaudeSDKSession(SESSION_ID);
    await flush();
    assert.deepEqual(script.calls, ['interrupt']);
    assert.equal(script.closed(), false);

    t.mock.timers.tick(5 * 1000);
    assert.equal(await settledNow(aborting), true, 'the abort returns once the process is closed');
    assert.equal(script.closed(), true);
    assert.equal(completes(sent), 0, 'the abort\'s caller sends the terminal complete');
    // A closed process makes the session's next run wait 8 s, and the next
    // test runs on this session too.
    t.mock.timers.tick(8 * 1000);
  }, { interrupt: 'hang' });
});

test('a task cannot be stopped through a process HOLD_MAX has let go', async (t) => {
  await withRun(async ({ script }) => {
    launchWorkflow(script);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    script.emit(result());
    await flush();
    t.mock.timers.tick(HOLD_MAX_MS);
    await flush();
    assert.deepEqual(script.stopped, ['wf1']);
    assert.equal(script.released(), true);

    // Its `stopped` notification is still on the way, so it is still listed.
    assert.deepEqual(listedTasks(), [[SESSION_ID, ['wf1']]]);
    assert.equal(await settledNow(stopClaudeSDKTask(SESSION_ID, 'wf1')), false);
    assert.deepEqual(script.dropped, []);

    script.emit(taskNotification('wf1', 'toolu_wf', 'stopped'));
    await flush();
    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
  });
});

test('the CLI\'s stderr reaches the server log with the session it belongs to', async (t) => {
  const consoleError = t.mock.method(console, 'error', () => {});
  await withRun(async ({ script }) => {
    script.emit(init());
    await flush();

    const stderr = script.options()?.stderr;
    assert.equal(typeof stderr, 'function');
    (stderr as (data: string) => void)('Background tasks still running 5m after the last turn (a1); stopping them.\n\n');
    const lines = consoleError.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.startsWith('[Claude CLI'));
    assert.deepEqual(lines, [`[Claude CLI ${SESSION_ID}] Background tasks still running 5m after the last turn (a1); stopping them.`]);
  });
});

test('tasks an aborted run\'s process starts before it exits are not tracked for the session', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(assistantText('Working on it'));
    await flush();
    assert.equal(await settledNow(abortClaudeSDKSession(SESSION_ID)), true);

    // The CLI can still run a turn before it exits; the session's next run
    // must not inherit what it starts.
    launchAgent(script);
    await flush();
    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
  });
});

test('an abort stops the run\'s outstanding tasks while its stdin is still open', async () => {
  await withRun(async ({ script, finishedReports }) => {
    script.emit(init());
    launchAgent(script);
    script.emit(assistantText('Working on it'));
    await flush();

    assert.equal(await settledNow(abortClaudeSDKSession(SESSION_ID)), true);
    // Left running, the agent would keep the CLI, and its writes to the
    // transcript, going after the release; a stop written after stdin has
    // ended is dropped.
    assert.deepEqual(script.calls, ['interrupt', 'stop:a1', 'release']);
    assert.deepEqual(script.dropped, []);
    assert.equal(finishedReports(), 0);
  });
});

test('the next run after an abort waits for the aborted process, which says nothing more, and completes on its own result', async (t) => {
  await withNotifications(async ({ userId, delivered }) => {
    const sessionId = 'app-hold-abort-then-run';
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
    const first = createScriptedQuery();
    const second = createScriptedQuery();
    const stopped = createWriter({ userId });
    const next = createWriter({ userId });
    const context = createContext();
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);

    try {
      const firstRun = queryClaudeSDK('start an agent', { sessionId, cwd }, stopped.writer as never, { ...context, createQuery: first.createQuery });
      await waitUntil(() => first.script.created());
      first.script.emit(init());
      launchAgent(first.script);
      first.script.emit(assistantText('Working on it'));
      await flush();

      assert.equal(await settledNow(abortClaudeSDKSession(sessionId)), true);
      const forwarded = stopped.sent.length;
      // A scheduled message that interrupts a run starts the next one at once.
      const nextStart = probeStart(context);
      const secondRun = queryClaudeSDK('Next', { sessionId, cwd }, next.writer as never, { ...nextStart.context, createQuery: second.createQuery });
      await flush();
      assert.equal(nextStart.started(), false, 'the next CLI waits for the aborted one to exit');

      // The aborted CLI ends the interrupted turn, then runs one more for a
      // notification it had queued before it exits.
      first.script.emit(interruptedResult());
      first.script.emit(taskNotification('a1', 'toolu_agent', 'stopped'));
      first.script.emit(assistantText('A late turn'));
      first.script.emit(followUpResult());
      await flush();
      assert.equal(stopped.sent.length, forwarded, 'nothing the aborted process says after the abort is forwarded');
      assert.equal(nextStart.started(), false);

      // Past the dedupe window, so a second report of the aborted run would show.
      now += NOTIFICATION_DEDUPE_MS + 1000;
      first.script.end();
      await firstRun;
      await waitUntil(() => second.script.created());
      second.script.emit(init());
      second.script.emit(result());
      await flush();
      assert.equal(completes(next.sent), 1, 'the next run completes on its own result');
      assert.equal(second.script.released(), true);
      second.script.end();
      await secondRun;

      assert.equal(completes(stopped.sent), 0, 'the abort\'s caller sends the aborted run\'s complete');
      assert.equal(stopped.finishedReports() + next.finishedReports(), 0);
      assert.deepEqual(delivered(), [STOPPED_ABORTED, STOPPED_COMPLETED], 'one report for each run');
    } finally {
      first.script.end();
      second.script.end();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test('the abort mark is the aborted run\'s own: a process that outlives its close cannot swallow the next run\'s complete', async (t) => {
  await withNotifications(async ({ userId, delivered }) => {
    const sessionId = 'app-hold-abort-unclosable';
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
    const first = createScriptedQuery();
    const second = createScriptedQuery();
    const stopped = createWriter({ userId });
    const next = createWriter({ userId });
    const context = createContext();
    // A close that fails leaves the process, and its loop, running.
    const unclosable: NonNullable<ProviderRuntimeContext['createQuery']> = (options) =>
      Object.assign(first.createQuery(options), {
        close: () => { throw new Error('close failed'); },
      });
    t.mock.method(console, 'error', () => {});
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);

    try {
      const firstRun = queryClaudeSDK('Hi', { sessionId, cwd }, stopped.writer as never, { ...context, createQuery: unclosable });
      await waitUntil(() => first.script.created());
      first.script.emit(init());
      first.script.emit(assistantText('Working on it'));
      await flush();
      assert.equal(await settledNow(abortClaudeSDKSession(sessionId)), true);

      const secondRun = queryClaudeSDK('Next', { sessionId, cwd }, next.writer as never, { ...context, createQuery: second.createQuery });
      await flush();
      t.mock.timers.tick(15 * 1000);
      await flush();
      t.mock.timers.tick(8 * 1000);
      await waitUntil(() => second.script.created());

      // The aborted process is still up: its loop has not ended.
      second.script.emit(init());
      second.script.emit(result());
      await flush();
      assert.equal(completes(next.sent), 1, 'the next run completes on its own result');
      assert.equal(second.script.released(), true);
      second.script.end();
      await secondRun;

      now += NOTIFICATION_DEDUPE_MS + 1000;
      first.script.emit(interruptedResult());
      first.script.end();
      await firstRun;
      assert.equal(completes(stopped.sent), 0);
      assert.deepEqual(delivered(), [STOPPED_ABORTED, STOPPED_COMPLETED]);
    } finally {
      first.script.end();
      second.script.end();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test('a run whose process exits while the abort waits for the interrupt reply reports the stop once', async (t) => {
  await withNotifications(async ({ userId, delivered }) => {
    const sessionId = 'app-hold-abort-exited';
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
    const { createQuery, script } = createScriptedQuery({ interrupt: 'hang' });
    const { writer, sent } = createWriter({ userId });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);

    try {
      const run = queryClaudeSDK('Hi', { sessionId, cwd }, writer as never, { ...createContext(), createQuery });
      await waitUntil(() => script.created());
      script.emit(init());
      script.emit(assistantText('Working on it'));
      await flush();

      const aborting = abortClaudeSDKSession(sessionId);
      await flush();
      // The CLI exits before it answers.
      script.end();
      await run;
      assert.deepEqual(delivered(), [STOPPED_ABORTED], 'the run reports the stop when its loop ends first');

      now += NOTIFICATION_DEDUPE_MS + 1000;
      t.mock.timers.tick(5 * 1000);
      assert.equal(await settledNow(aborting), true);
      assert.deepEqual(delivered(), [STOPPED_ABORTED], 'and the abort does not report it again');
      assert.equal(completes(sent), 0, 'the abort\'s caller sends the terminal complete');
    } finally {
      script.end();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test('a run aborted while it waits for the old process leaves that wait to the session\'s next run', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const third = createScriptedQuery();
  const { writer, sent, finishedReports } = createWriter();
  const context = createContext();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  try {
    const firstRun = queryClaudeSDK('start an agent', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: first.createQuery });
    await waitUntil(() => first.script.created());
    first.script.emit(init());
    launchAgent(first.script);
    first.script.emit(result());
    await waitUntil(() => completes(sent) === 1);

    // The second run retires the held process and waits for it to exit; the
    // user stops that run and sends again.
    const secondRun = queryClaudeSDK('Continue', { sessionId: SESSION_ID, cwd, ...EDITED_TURN }, writer as never, { ...context, createQuery: second.createQuery });
    await flush();
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    const thirdStart = probeStart(context);
    const thirdRun = queryClaudeSDK('Continue again', { sessionId: SESSION_ID, cwd }, writer as never, { ...thirdStart.context, createQuery: third.createQuery });
    await flush();
    assert.equal(thirdStart.started(), false, 'the old process is still up, so the third run waits for it too');

    first.script.emit(taskNotification('a1', 'toolu_agent', 'stopped'));
    first.script.end();
    await firstRun;
    await waitUntil(() => third.script.created());
    await secondRun;
    assert.equal(second.script.created(), false, 'the aborted run never starts its CLI');

    third.script.emit(init());
    third.script.emit(result());
    third.script.end();
    await thirdRun;
    assert.equal(completes(sent), 2, 'the first and third runs complete on their results; the abort\'s caller completes the second');
    assert.equal(finishedReports(), 0);
  } finally {
    second.script.end();
    third.script.end();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a process still up a minute past the CLI\'s ceiling is closed whatever released it, but not once its loop has ended', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ABANDONED_PROCESS_CLOSE_MS = 6 * MINUTE;

  // A turn with nothing outstanding lets go at once.
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(result());
    await waitUntil(() => script.released());
    t.mock.timers.tick(ABANDONED_PROCESS_CLOSE_MS - 1);
    await flush();
    assert.equal(script.closed(), false);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(script.closed(), true, 'the CLI should have exited within its own ceiling');
    // A closed process makes the session's next run wait 8 s, and the next
    // case runs on this session too.
    t.mock.timers.tick(8 * 1000);
  });

  // The user aborts the turn.
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(assistantText('Working on it'));
    await flush();
    assert.equal(await settledNow(abortClaudeSDKSession(SESSION_ID)), true);
    assert.equal(script.closed(), false);
    t.mock.timers.tick(ABANDONED_PROCESS_CLOSE_MS);
    await flush();
    assert.equal(script.closed(), true);
    // A closed process makes the session's next run wait 8 s, and the next
    // case runs on this session too.
    t.mock.timers.tick(8 * 1000);
  });

  await withRun(async ({ script, done }) => {
    script.emit(init());
    script.emit(result());
    await waitUntil(() => script.released());
    script.end();
    await done;
    t.mock.timers.tick(ABANDONED_PROCESS_CLOSE_MS);
    await flush();
    assert.equal(script.closed(), false, 'the timer goes with the loop');
  });

  // A stream that ends while the input is still held: the release at the end
  // of the loop leaves no timer behind.
  await withRun(async ({ script, done }) => {
    script.emit(init());
    await flush();
    script.end();
    await done;
    await waitUntil(() => script.released());
    t.mock.timers.tick(ABANDONED_PROCESS_CLOSE_MS);
    await flush();
    assert.equal(script.closed(), false);
  });
});

test('a process the abandoned-process timer closed still makes the next run wait out its kill', async (t) => {
  const sessionId = 'app-hold-abandoned-then-run';
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const { writer, sent } = createWriter();
  const context = createContext();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  try {
    const firstRun = queryClaudeSDK('Hi', { sessionId, cwd }, writer as never, { ...context, createQuery: first.createQuery });
    await waitUntil(() => first.script.created());
    first.script.emit(init());
    first.script.emit(result());
    await waitUntil(() => first.script.released());

    // The CLI never exits on its own, so the timer closes it. Closing ends
    // the loop at once; the SDK kills the process seconds later.
    t.mock.timers.tick(6 * MINUTE);
    await waitUntil(() => first.script.closed());
    await firstRun;

    const next = probeStart(context);
    const secondRun = queryClaudeSDK('Next', { sessionId, cwd }, writer as never, { ...next.context, createQuery: second.createQuery });
    await flush();
    assert.equal(next.started(), false, 'the new CLI waits for the closed one to be killed');
    t.mock.timers.tick(8 * 1000 - 1);
    await flush();
    assert.equal(next.started(), false);
    t.mock.timers.tick(1);
    await waitUntil(() => second.script.created());

    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
    assert.equal(completes(sent), 2);
  } finally {
    first.script.end();
    second.script.end();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('every report of a run is keyed to that run, even once the session has moved on to another', async (t) => {
  await withNotifications(async ({ userId, delivered }) => {
    const sessionId = 'app-hold-run-keys';
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
    const context = createContext();
    t.mock.method(console, 'error', () => {});
    // The registry slot already holds the session's next run, as it can when
    // a run reports after its terminal `complete`.
    setNotificationRunLookup(() => ({ provider: 'claude', startedAt: 999 }));

    let runStartedAt = 1000;
    const runOnce = async (drive: (script: Scripted) => Promise<void>) => {
      const { createQuery, script } = createScriptedQuery();
      runStartedAt += 1;
      const { writer } = createWriter({ userId, runStartedAt });
      const run = queryClaudeSDK('Hi', { sessionId, cwd }, writer as never, { ...context, createQuery });
      await waitUntil(() => script.created());
      await drive(script);
      script.end();
      await run;
    };
    const workReportsBack = async (script: Scripted) => {
      launchWorkflow(script);
      script.emit(result());
      script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
      script.emit(followUpResult());
      await flush();
    };
    const endsWithoutResult = async (script: Scripted) => {
      script.emit(init());
      await flush();
    };
    const fails = async (script: Scripted) => {
      script.emit(init());
      script.fail(new Error('boom'));
      await flush();
    };
    const isAborted = async (script: Scripted) => {
      script.emit(init());
      script.emit(assistantText('Working on it'));
      await flush();
      assert.equal(await settledNow(abortClaudeSDKSession(sessionId)), true);
    };

    try {
      // Two runs of each kind, well inside the dedupe window.
      for (const drive of [workReportsBack, endsWithoutResult, fails, isAborted]) {
        await runOnce(drive);
        await runOnce(drive);
      }
      const backgroundDone: DeliveredNotification = ['run.background_completed', 'Claude: Background work finished'];
      const failed: DeliveredNotification = ['run.failed', 'Claude: Run Failed: boom'];
      assert.deepEqual(delivered(), [
        STOPPED_COMPLETED, backgroundDone,
        STOPPED_COMPLETED, backgroundDone,
        STOPPED_COMPLETED,
        STOPPED_COMPLETED,
        failed,
        failed,
        STOPPED_ABORTED,
        STOPPED_ABORTED,
      ]);
    } finally {
      setNotificationRunLookup(() => null);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test('a run aborted before its CLI starts reports the stop at once, not when its wait is over', async (t) => {
  await withNotifications(async ({ userId, delivered }) => {
    const sessionId = 'app-hold-abort-starting';
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
    const first = createScriptedQuery();
    const second = createScriptedQuery();
    const held = createWriter({ userId, runStartedAt: 1 });
    const waiting = createWriter({ userId, runStartedAt: 2 });
    const context = createContext();
    t.mock.timers.enable({ apis: ['setTimeout'] });

    try {
      const firstRun = queryClaudeSDK('start an agent', { sessionId, cwd }, held.writer as never, { ...context, createQuery: first.createQuery });
      await waitUntil(() => first.script.created());
      first.script.emit(init());
      launchAgent(first.script);
      first.script.emit(result());
      await waitUntil(() => completes(held.sent) === 1);

      const secondRun = queryClaudeSDK('Continue', { sessionId, cwd, ...EDITED_TURN }, waiting.writer as never, { ...context, createQuery: second.createQuery });
      await flush();
      assert.equal(await settledNow(abortClaudeSDKSession(sessionId)), true);
      assert.deepEqual(delivered(), [STOPPED_COMPLETED, STOPPED_ABORTED], 'the stop is reported while the old process is still up');

      first.script.end();
      await firstRun;
      await secondRun;
      assert.equal(second.script.created(), false);
      assert.deepEqual(delivered(), [STOPPED_COMPLETED, STOPPED_ABORTED], 'and only once');
      assert.equal(completes(waiting.sent), 0, 'the abort\'s caller sends the aborted run\'s complete');
    } finally {
      first.script.end();
      second.script.end();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test('a brand-new session the user stops before its CLI reports the session id still records that id', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const { createQuery, script } = createScriptedQuery();
  const { writer, sent } = createWriter();
  const announced: string[] = [];
  const announcing = { ...writer, setSessionId: (id: string) => { announced.push(id); } };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const run = queryClaudeSDK('Hi', { sessionId: SESSION_ID, cwd }, announcing as never, { ...createContext(), createQuery });

  try {
    await waitUntil(() => script.created());
    assert.equal(await settledNow(abortClaudeSDKSession(SESSION_ID)), true);
    const forwarded = sent.length;

    // The CLI still starts the prompt's turn in the session it then reports,
    // so the app session has to keep pointing at it; the process is closed
    // as that turn starts.
    script.emit(init());
    script.emit(interruptedResult());
    await flush();
    assert.deepEqual(announced, [NATIVE_ID]);
    assert.equal(sent.length, forwarded, 'nothing else reaches the client');
    assert.equal(script.closed(), true);
  } finally {
    script.end();
    await run;
    // A closed process makes the session's next run wait 8 s, and the next
    // test runs on this session too.
    t.mock.timers.tick(8 * 1000);
    await rm(cwd, { recursive: true, force: true });
  }
});

// With the per-task stop control declared, an interrupt spares background
// agents and workflows. A process let go of that starts another turn (a
// notification it had queued, an agent the stop reached reporting back) is
// closed as that turn starts: an agent the stops missed would otherwise keep
// it up, and the session's next run would wait 15 s before closing it.

test('an aborted process that starts another turn is closed then, and the next run waits only for its kill', async (t) => {
  const sessionId = 'app-hold-abort-late-turn';
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const { writer, sent } = createWriter();
  const context = createContext();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  try {
    const firstRun = queryClaudeSDK('start an agent', { sessionId, cwd }, writer as never, { ...context, createQuery: first.createQuery });
    await waitUntil(() => first.script.created());
    first.script.emit(init());
    launchAgent(first.script);
    first.script.emit(assistantText('Working on it'));
    await flush();
    assert.equal(await settledNow(abortClaudeSDKSession(sessionId)), true);
    assert.deepEqual(first.script.calls, ['interrupt', 'stop:a1', 'release']);

    // The interrupted turn's own end starts nothing.
    first.script.emit(interruptedResult());
    first.script.emit({ type: 'command_lifecycle', uuid: 'lc-1', session_id: NATIVE_ID, command_uuid: 'prompt-1', state: 'cancelled' });
    await flush();
    assert.equal(first.script.closed(), false);

    // The CLI starts a turn for the agent the stop reached.
    first.script.emit(init());
    await flush();
    assert.equal(first.script.closed(), true);
    await firstRun;

    const next = probeStart(context);
    const secondRun = queryClaudeSDK('Next', { sessionId, cwd }, writer as never, { ...next.context, createQuery: second.createQuery });
    await flush();
    assert.equal(next.started(), false, 'the next run waits out the kill');
    t.mock.timers.tick(8 * 1000);
    await waitUntil(() => second.script.created());
    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
    assert.equal(completes(sent), 1, 'the aborted run\'s complete is its caller\'s to send');
  } finally {
    first.script.end();
    second.script.end();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a held process a newer run takes over that starts another turn is closed then, and the new run starts after its kill', async (t) => {
  const sessionId = 'app-hold-supersede-late-turn';
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const { writer, sent } = createWriter();
  const context = createContext();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  try {
    const firstRun = queryClaudeSDK('start an agent', { sessionId, cwd }, writer as never, { ...context, createQuery: first.createQuery });
    await waitUntil(() => first.script.created());
    first.script.emit(init());
    launchAgent(first.script);
    first.script.emit(result());
    await waitUntil(() => completes(sent) === 1);

    const next = probeStart(context);
    const secondRun = queryClaudeSDK('Continue', { sessionId, cwd, ...EDITED_TURN }, writer as never, { ...next.context, createQuery: second.createQuery });
    await flush();
    assert.deepEqual(first.script.calls, ['interrupt', 'stop:a1', 'release']);
    first.script.emit(init());
    await waitUntil(() => first.script.closed());
    await firstRun;
    await flush();
    assert.equal(next.started(), false);
    t.mock.timers.tick(8 * 1000);
    await waitUntil(() => second.script.created());

    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
    assert.equal(completes(sent), 2);
  } finally {
    first.script.end();
    second.script.end();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('letting go of a held session for the Shell closes a process that starts another turn, and resolves once it is killed', async (t) => {
  const sessionId = 'app-hold-release-late-turn';
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const { createQuery, script } = createScriptedQuery();
  const { writer, sent } = createWriter();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  try {
    const run = queryClaudeSDK('start an agent', { sessionId, cwd }, writer as never, { ...createContext(), createQuery });
    await waitUntil(() => script.created());
    script.emit(init());
    launchAgent(script);
    script.emit(result());
    await waitUntil(() => completes(sent) === 1);

    const release = claudeRuntime.release(sessionId);
    await flush();
    assert.deepEqual(script.calls, ['interrupt', 'stop:a1', 'release']);
    script.emit(init());
    await waitUntil(() => script.closed());
    await run;
    assert.equal(await settledNow(release), 'pending', 'the kill is still to come');
    t.mock.timers.tick(8 * 1000);
    await release;
    assert.equal(claudeRuntime.processState(sessionId), null);
  } finally {
    script.end();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a run that finds the old process closed by another run\'s wait still waits out its kill', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const third = createScriptedQuery();
  const { writer, sent } = createWriter();
  const context = createContext();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  try {
    const firstRun = queryClaudeSDK('start an agent', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: first.createQuery });
    await waitUntil(() => first.script.created());
    first.script.emit(init());
    launchAgent(first.script);
    first.script.emit(result());
    await waitUntil(() => completes(sent) === 1);

    // The second run retires the held process, which does not exit; the user
    // stops that run and, 5 s later, sends again.
    const secondRun = queryClaudeSDK('Continue', { sessionId: SESSION_ID, cwd, ...EDITED_TURN }, writer as never, { ...context, createQuery: second.createQuery });
    await flush();
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    t.mock.timers.tick(5 * 1000);
    const thirdStart = probeStart(context);
    const thirdRun = queryClaudeSDK('Continue again', { sessionId: SESSION_ID, cwd }, writer as never, { ...thirdStart.context, createQuery: third.createQuery });
    await flush();

    // The second run's wait closes the old process at 15 s, which ends its
    // loop at once; the process itself is only killed seconds later.
    t.mock.timers.tick(10 * 1000);
    await waitUntil(() => first.script.closed());
    await firstRun;
    await flush();
    assert.equal(thirdStart.started(), false, 'the third run waits out the kill too');
    t.mock.timers.tick(8 * 1000 - 1);
    await flush();
    assert.equal(thirdStart.started(), false);
    t.mock.timers.tick(1);
    await waitUntil(() => third.script.created());
    await secondRun;
    assert.equal(second.script.created(), false);

    third.script.emit(init());
    third.script.emit(result());
    third.script.end();
    await thirdRun;
    assert.equal(completes(sent), 2);
  } finally {
    first.script.end();
    second.script.end();
    third.script.end();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a run that arrives after a closed process\'s loop has ended still waits out its kill', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const third = createScriptedQuery();
  const { writer, sent } = createWriter();
  const context = createContext();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  try {
    const firstRun = queryClaudeSDK('start an agent', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: first.createQuery });
    await waitUntil(() => first.script.created());
    first.script.emit(init());
    launchAgent(first.script);
    first.script.emit(result());
    await waitUntil(() => completes(sent) === 1);

    // The second run retires the held process, which does not exit, and its
    // wait closes it at 15 s. The old loop ends then and there; the process
    // is only killed seconds later.
    const secondRun = queryClaudeSDK('Continue', { sessionId: SESSION_ID, cwd, ...EDITED_TURN }, writer as never, { ...context, createQuery: second.createQuery });
    await flush();
    t.mock.timers.tick(15 * 1000);
    await waitUntil(() => first.script.closed());
    await firstRun;

    // A second later the user stops the second run and sends again.
    t.mock.timers.tick(1000);
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    const thirdStart = probeStart(context);
    const thirdRun = queryClaudeSDK('Continue again', { sessionId: SESSION_ID, cwd }, writer as never, { ...thirdStart.context, createQuery: third.createQuery });
    await flush();
    assert.equal(thirdStart.started(), false, 'the third run still finds the closed process and waits for it');
    t.mock.timers.tick(7 * 1000 - 1);
    await flush();
    assert.equal(thirdStart.started(), false);
    assert.equal(third.script.created(), false, 'no CLI of its own until 8 s after the close');
    t.mock.timers.tick(1);
    await waitUntil(() => third.script.created());
    await secondRun;
    assert.equal(second.script.created(), false, 'the aborted run never starts its CLI');

    third.script.emit(init());
    third.script.emit(result());
    third.script.end();
    await thirdRun;
    assert.equal(completes(sent), 2, 'the first and third runs complete on their results; the abort\'s caller completes the second');
  } finally {
    first.script.end();
    second.script.end();
    third.script.end();
    await rm(cwd, { recursive: true, force: true });
  }
});

// What the Shell tab asks before it starts a CLI on a session (processState),
// and how it takes a session over (release).

test('the process state follows a run: running from its start through its hold, exiting once it lets go or is aborted, then none', async () => {
  const sessionId = 'app-hold-process-state';
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const held = createScriptedQuery();
  const aborted = createScriptedQuery();
  const { writer } = createWriter();
  const context = createContext();
  let stateBeforeQuery: string | null = 'unread';

  try {
    const heldRun = queryClaudeSDK('start a workflow', { sessionId, cwd }, writer as never, {
      ...context,
      // Asked once the run is registered and before it builds its query.
      resolveResumeModel: (resumeSessionId: string | undefined, requestedModel?: string | null) => {
        stateBeforeQuery = claudeRuntime.processState(sessionId);
        return context.resolveResumeModel(resumeSessionId, requestedModel);
      },
      createQuery: held.createQuery,
    });
    await waitUntil(() => held.script.created());
    assert.equal(stateBeforeQuery, 'running', 'a run holds the session from its start, before its CLI is up');

    launchWorkflow(held.script);
    held.script.emit(result());
    await waitUntil(() => listClaudeSDKBackgroundWork().some((entry) => entry.sessionId === sessionId));
    assert.equal(claudeRuntime.processState(sessionId), 'running', 'held for the workflow');

    // The workflow reports back; the turn relaying it lets the process go.
    held.script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    held.script.emit(followUpResult());
    await waitUntil(() => held.script.released());
    assert.equal(claudeRuntime.processState(sessionId), 'exiting', 'let go, not exited yet');
    held.script.end();
    await heldRun;
    assert.equal(claudeRuntime.processState(sessionId), null);

    const abortedRun = queryClaudeSDK('a long turn', { sessionId, cwd }, writer as never, { ...context, createQuery: aborted.createQuery });
    await waitUntil(() => aborted.script.created());
    aborted.script.emit(init());
    await flush();
    assert.equal(await abortClaudeSDKSession(sessionId), true);
    assert.equal(claudeRuntime.processState(sessionId), 'exiting');
    aborted.script.end();
    await abortedRun;
    assert.equal(claudeRuntime.processState(sessionId), null);
  } finally {
    held.script.end();
    aborted.script.end();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a process the abandoned-process timer closed counts as exiting, and holds the next run back, until its kill is through', async (t) => {
  const sessionId = 'app-hold-abandoned-state';
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const { writer } = createWriter();
  const context = createContext();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  try {
    const firstRun = queryClaudeSDK('watch the log', { sessionId, cwd }, writer as never, { ...context, createQuery: first.createQuery });
    await waitUntil(() => first.script.created());
    first.script.emit(init());
    first.script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
    first.script.emit(ack('toolu_monitor', 'Monitor started', {}));
    first.script.emit(result());
    await flush();
    assert.equal(claudeRuntime.processState(sessionId), 'running', 'held for the Monitor');

    t.mock.timers.tick(HOLD_IDLE_MS);
    await waitUntil(() => first.script.released());
    assert.equal(claudeRuntime.processState(sessionId), 'exiting');

    // The CLI never exits on its own, so the timer closes it: the loop ends
    // at once, and the SDK kills the process seconds later.
    t.mock.timers.tick(6 * MINUTE);
    await waitUntil(() => first.script.closed());
    await firstRun;
    assert.equal(claudeRuntime.processState(sessionId), 'exiting', 'closed, not killed yet');

    const next = probeStart(context);
    const secondRun = queryClaudeSDK('Next', { sessionId, cwd }, writer as never, { ...next.context, createQuery: second.createQuery });
    await flush();
    assert.equal(next.started(), false, 'the new run waits for the kill');
    t.mock.timers.tick(8 * 1000 - 1);
    await flush();
    assert.equal(next.started(), false);
    t.mock.timers.tick(1);
    await waitUntil(() => second.script.created());

    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
    assert.equal(claudeRuntime.processState(sessionId), null);
  } finally {
    first.script.end();
    second.script.end();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('release stops a held session the way a newer run would, and resolves once its process is gone', async (t) => {
  const sessionId = 'app-hold-release';
  const logged: string[] = [];
  const log = console.log;
  t.mock.method(console, 'log', (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
    log(...args);
  });
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const { createQuery, script } = createScriptedQuery();
  const { writer } = createWriter();

  try {
    const run = queryClaudeSDK('start a workflow', { sessionId, cwd }, writer as never, { ...createContext(), createQuery });
    await waitUntil(() => script.created());
    launchWorkflow(script);
    script.emit(result());
    await waitUntil(() => listClaudeSDKBackgroundWork().some((entry) => entry.sessionId === sessionId));

    const release = claudeRuntime.release(sessionId);
    await flush();
    assert.deepEqual(script.calls, ['interrupt', 'stop:wf1', 'release']);
    assert.equal(logged.some((line) => line.includes('closing the CLI\'s input (shell-takeover)')), true);
    assert.equal(await settledNow(release), 'pending', 'the process has not exited yet');

    script.end();
    await run;
    await release;
    assert.equal(claudeRuntime.processState(sessionId), null);

    assert.equal(await settledNow(claudeRuntime.release('app-hold-release-idle')), undefined, 'nothing holds that session');
  } finally {
    script.end();
    await rm(cwd, { recursive: true, force: true });
  }
});

// The Shell handler (websocket module) reads a session through the provider
// runtime service. These run the service over the real Claude runtime.

test('through the runtime service, a held session reads running with its workflow, then exiting once let go, then nothing', async () => {
  const sessionId = 'app-hold-service-hold';
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const { createQuery, script } = createScriptedQuery();
  const { writer } = createWriter();
  const service = createProviderRuntimeService({ listProviders: () => [{ id: 'claude', runtime: claudeRuntime }] as never });

  try {
    const run = queryClaudeSDK('start a workflow', { sessionId, cwd }, writer as never, { ...createContext(), createQuery });
    await waitUntil(() => script.created());
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit({ ...taskStarted('wf1', 'toolu_wf', 'local_workflow'), workflow_name: 'audit' });
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await waitUntil(() => service.hasBackgroundWork(sessionId));

    const held = service.describeSessionHold(sessionId);
    assert.equal(held?.processState, 'running');
    assert.deepEqual(held?.tasks.map((task) => [task.taskId, task.workflowName]), [['wf1', 'audit']]);

    // The workflow reports back; the turn relaying it lets the process go.
    script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    script.emit(followUpResult());
    await waitUntil(() => script.released());
    assert.deepEqual(service.describeSessionHold(sessionId), { processState: 'exiting', tasks: [] });

    script.end();
    await run;
    assert.equal(service.describeSessionHold(sessionId), null);
  } finally {
    script.end();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('through the runtime service, letting go of a held session stops it like a newer run and resolves once its process is gone', async () => {
  const sessionId = 'app-hold-service-release';
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const { createQuery, script } = createScriptedQuery();
  const { writer } = createWriter();
  const service = createProviderRuntimeService({ listProviders: () => [{ id: 'claude', runtime: claudeRuntime }] as never });

  try {
    const run = queryClaudeSDK('start a workflow', { sessionId, cwd }, writer as never, { ...createContext(), createQuery });
    await waitUntil(() => script.created());
    launchWorkflow(script);
    script.emit(result());
    await waitUntil(() => service.hasBackgroundWork(sessionId));

    const release = service.releaseSession(sessionId);
    await flush();
    assert.deepEqual(script.calls, ['interrupt', 'stop:wf1', 'release']);
    assert.deepEqual(service.describeSessionHold(sessionId), { processState: 'exiting', tasks: [] });
    assert.equal(await settledNow(release), 'pending', 'the process has not exited yet');

    script.end();
    await run;
    await release;
    assert.equal(service.describeSessionHold(sessionId), null);
  } finally {
    script.end();
    await rm(cwd, { recursive: true, force: true });
  }
});
