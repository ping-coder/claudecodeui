import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { WebSocket } from 'ws';

import {
  closeConnection,
  initializeDatabase,
  notificationPreferencesDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import {
  registerDesktopNotificationClient,
  unregisterDesktopNotificationClient,
} from '@/modules/notifications/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { nextScheduledFire } from '@/modules/providers/list/claude/claude-scheduled-work.js';
import {
  abortClaudeSDKSession,
  claudeRuntime,
  listClaudeSDKBackgroundWork,
  queryClaudeSDK,
  reconnectSessionWriter,
  stopClaudeSDKTask,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { chatRunRegistry, connectedClients } from '@/modules/websocket/index.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * A turn that has completed while its process is held open for background
 * work hands the session's next message to that process as its next turn:
 * the work keeps running, the new turn reports through its own run's writer
 * and completes once, and the work still reports back once. These drive
 * `queryClaudeSDK` with a scripted SDK stream (the seam is
 * `context.createQuery`) and read what each run writes to the CLI off the
 * held prompt stream.
 */

type SwitchAnswer = 'ok' | 'refuse';

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  /** Every message read off the held prompt stream, in order. */
  prompts: Array<Record<string, unknown>>;
  /**
   * What reached the CLI, in order: `prompt:<uuid>` as the CLI reads one,
   * `setModel:<model>`, `setPermissionMode:<mode>`, `cancel:<uuid>`,
   * `interrupt`, `stop:<taskId>`, `release`, `close`.
   */
  calls: string[];
  released: () => boolean;
  created: () => boolean;
  options: () => Record<string, unknown> | null;
  /** How the CLI answers the switches that follow. */
  setSwitchAnswer: (answer: SwitchAnswer) => void;
};

type ScriptedBehaviour = {
  /** `hang` leaves every interrupt unanswered until the query closes. */
  interrupt?: 'reply' | 'hang';
  /** False for an SDK whose query has no setModel or setPermissionMode. */
  switches?: boolean;
  /** `keep`: the CLI answers every cancel_async_message that it kept the message. */
  cancel?: 'confirm' | 'keep';
};

function createScriptedQuery(
  behaviour: ScriptedBehaviour = {},
): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  let released = false;
  let closed = false;
  let builtWith: Record<string, unknown> | null = null;
  let switchAnswer: SwitchAnswer = 'ok';
  const prompts: Array<Record<string, unknown>> = [];
  const calls: string[] = [];

  const script: Scripted = {
    emit: (message) => { queue.push(message); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
    prompts,
    calls,
    released: () => released,
    created: () => builtWith !== null,
    options: () => builtWith,
    setSwitchAnswer: (answer) => { switchAnswer = answer; },
  };

  // The CLI answers a switch on a line of its own, which the SDK reads in a
  // later turn of the event loop: never within the one that sent it.
  const answerSwitch = (call: string) => {
    calls.push(call);
    const answer = switchAnswer;
    return new Promise<void>((resolve, reject) => {
      setImmediate(() => (answer === 'ok' ? resolve() : reject(new Error(`refused ${call}`))));
    });
  };

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt, options }) => {
    builtWith = options;
    void (async () => {
      for await (const message of prompt) {
        const record = message as Record<string, unknown>;
        prompts.push(record);
        calls.push(`prompt:${String(record.uuid)}`);
      }
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
        yield next;
      }
    })();

    const switches = behaviour.switches === false
      ? {}
      : {
        setModel: (model?: string) => answerSwitch(`setModel:${String(model)}`),
        setPermissionMode: (mode: string) => answerSwitch(`setPermissionMode:${mode}`),
      };
    return Object.assign(iterator, switches, {
      interrupt: async () => {
        calls.push('interrupt');
        if (behaviour.interrupt === 'hang') {
          await new Promise(() => {});
        }
      },
      stopTask: async (taskId: string) => { calls.push(`stop:${taskId}`); },
      cancelAsyncMessage: async (uuid: string) => {
        calls.push(`cancel:${uuid}`);
        return behaviour.cancel !== 'keep';
      },
      close: () => {
        if (!closed) {
          closed = true;
          calls.push('close');
          wake?.();
        }
      },
    });
  };

  return { createQuery, script };
}

/**
 * A writer like the chat gateway's: records what its run is sent, and counts
 * its run's reports that held work finished and that its process was handed on.
 */
function createWriter(runStartedAt?: number, userId: number | null = null) {
  const sent: NormalizedMessage[] = [];
  let finishedReports = 0;
  let handOverReports = 0;
  const sockets: unknown[] = [];
  const writer = {
    send: (message: NormalizedMessage) => { sent.push(message); },
    userId,
    runStartedAt,
    reportBackgroundWorkFinished: () => { finishedReports += 1; },
    reportProcessHandedOver: () => { handOverReports += 1; },
    updateWebSocket: (socket: unknown) => { sockets.push(socket); },
  };
  return { writer, sent, sockets, finishedReports: () => finishedReports, handOverReports: () => handOverReports };
}

type Writer = ReturnType<typeof createWriter>;

function createContext(overrides: Partial<ProviderRuntimeContext> = {}): Omit<ProviderRuntimeContext, 'createQuery'> {
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  return {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    ...overrides,
  };
}

async function flush(rounds = 10): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

// Gives up after five seconds of real time; works while `setTimeout` is mocked.
async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!condition() && performance.now() < deadline) {
    await flush(1);
  }
  assert.equal(condition(), true, 'condition never became true');
}

const NATIVE_ID = 'native-held-turn-session';
const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id: string, text: string) => ({
  type: 'user', uuid: randomUUID(), session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
});
const taskStarted = (taskId: string, toolUseId: string, taskType: string) => ({
  type: 'system', subtype: 'task_started', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, description: `Task ${taskId}`, task_type: taskType,
});
const taskNotification = (taskId: string, toolUseId: string, status: string) => ({
  type: 'system', subtype: 'task_notification', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, status, summary: `Task ${taskId} ${status}`, output_file: '',
});
const taskUpdated = (taskId: string, status: string) => ({
  type: 'system', subtype: 'task_updated', session_id: NATIVE_ID, task_id: taskId, patch: { status, end_time: Date.now() },
});
const assistantText = (text: string) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const echo = (uuid: string, content: string) => ({
  type: 'user', isReplay: true, uuid, session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'user', content },
});
const lifecycle = (commandUuid: string, state: string, extra: Record<string, unknown> = {}) => ({
  type: 'command_lifecycle', uuid: randomUUID(), session_id: NATIVE_ID, command_uuid: commandUuid, state, ...extra,
});
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'done', duration_ms: 1, num_turns: 1 });
// The `result` of a turn the CLI runs to relay a finished task.
const relayResult = () => ({ ...result(), result: 'relayed', origin: { kind: 'task-notification' } });
// The `result` that ends a prompt's turn the user interrupted, as CLI 2.1.312 writes it.
const interruptedResultFor = (uuid: string) => ({
  type: 'result', subtype: 'error_during_execution', is_error: true, session_id: NATIVE_ID, duration_ms: 1, num_turns: 1,
  origin: { kind: 'human' }, user_message_uuid: uuid, user_message_uuids: [uuid],
});

const completes = (sent: NormalizedMessage[]) => sent.filter((message) => message.kind === 'complete').length;
const userTexts = (sent: NormalizedMessage[]) => sent.filter((message) => message.kind === 'text' && message.role === 'user');
const assistantTexts = (sent: NormalizedMessage[]) => sent
  .filter((message) => message.kind === 'text' && message.role === 'assistant')
  .map((message) => message.content);
const listedTaskIds = (sessionId: string) => listClaudeSDKBackgroundWork()
  .filter((entry) => entry.sessionId === sessionId)
  .flatMap((entry) => entry.tasks.map((task) => task.taskId));
/** The scheduled work the runtime lists for a session. */
const scheduledOf = (sessionId: string) => claudeRuntime.listScheduledWork()
  .filter((entry) => entry.sessionId === sessionId)
  .flatMap((entry) => entry.scheduled);

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
// The runtime's defaults; the tests run without the env overrides.
const HOLD_IDLE_MS = 30 * MINUTE;
const SCHEDULE_HOLD_MAX_MS = 8 * DAY;

/** Settles to true once `promise` has settled, checked within a flush. */
function track(promise: Promise<unknown>): () => boolean {
  let settled = false;
  void promise.finally(() => { settled = true; });
  return () => settled;
}

type HeldRun = {
  sessionId: string;
  cwd: string;
  script: Scripted;
  first: Writer;
  firstRun: Promise<unknown>;
  context: Omit<ProviderRuntimeContext, 'createQuery'>;
  /** The queries later runs are given; a run that goes into the held process never builds one. */
  laterQueries: Array<ReturnType<typeof createScriptedQuery>>;
};

/**
 * Starts a run whose turn launches background work and completes, so its
 * process is held: by default a workflow (`wf1`), which the tracker follows.
 * `expectHeld: false` is for a turn whose work does not hold the process.
 */
async function startHeldRun(
  launch: (script: Scripted) => void = launchWorkflow,
  runOptions: Record<string, unknown> = {},
  {
    behaviour = {},
    first = createWriter(1),
    context = createContext(),
    expectHeld = true,
  }: { behaviour?: ScriptedBehaviour; first?: Writer; context?: Omit<ProviderRuntimeContext, 'createQuery'>; expectHeld?: boolean } = {},
): Promise<HeldRun> {
  const sessionId = `app-held-turn-${randomUUID()}`;
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-held-turn-'));
  const { createQuery, script } = createScriptedQuery(behaviour);
  const firstRun = queryClaudeSDK('start the work', { sessionId, cwd, ...runOptions }, first.writer as never, { ...context, createQuery });
  await waitUntil(() => script.prompts.length === 1);
  script.emit(init());
  launch(script);
  script.emit(result());
  await waitUntil(() => completes(first.sent) === 1);
  if (expectHeld) {
    assert.equal(script.released(), false, 'the first process is held for its work');
  }
  return { sessionId, cwd, script, first, firstRun, context, laterQueries: [] };
}

/** A context whose model lookup fails while `failing()` says so. */
function createFailingLookupContext(failing: () => boolean): Omit<ProviderRuntimeContext, 'createQuery'> {
  const context = createContext();
  return {
    ...context,
    resolveResumeModel: async (sessionId, requestedModel) => {
      if (failing()) {
        throw new Error('database is locked');
      }
      return context.resolveResumeModel(sessionId, requestedModel);
    },
  };
}

function launchWorkflow(script: Scripted): void {
  script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
  script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
  script.emit(toolResult('toolu_wf', 'Workflow launched in background. Task ID: wf1'));
}

/**
 * A Monitor as a CLI that reports no task for it starts one: only the launch
 * rule holds the process for it, until the CLI runs a turn for it.
 */
function launchUntrackedMonitor(script: Scripted): void {
  script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
  script.emit(toolResult('toolu_monitor', 'Monitor started'));
}

/** A Monitor as CLI 2.1.312 starts it: a task (`local_bash`) for the call. */
function launchMonitor(script: Scripted): void {
  script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'until test -f ready; do sleep 2; done', description: 'wait ready', timeout_ms: 60000 }));
  script.emit(taskStarted('mon1', 'toolu_monitor', 'local_bash'));
  script.emit(toolResult('toolu_monitor', 'Monitor started (task mon1, expires in 1m unless the source ends first)'));
}

/**
 * The Monitor's source ends: CLI 2.1.312 settles its task and runs a turn for
 * it, which echoes nothing.
 */
function endMonitor(script: Scripted): void {
  script.emit(taskUpdated('mon1', 'completed'));
  script.emit(taskNotification('mon1', 'toolu_monitor', 'completed'));
  script.emit(init());
  script.emit(assistantText('The Monitor saw READY.'));
  script.emit(relayResult());
}

/** A self-paced loop's next wake-up: no task event, so only the launch rule holds the process for it. */
function scheduleWakeup(script: Scripted, id = 'toolu_wakeup'): void {
  script.emit(toolUse(id, 'ScheduleWakeup', { delaySeconds: 60, prompt: 'check the build again', reason: 'polling' }));
  script.emit(toolResult(id, 'Wake-up scheduled'));
}

/**
 * Has the CLI echo the run's own prompt first, as a CLI started with
 * --replay-user-messages does: from then on the run knows this CLI reports
 * the prompts it takes.
 */
function announcingPrompt(launch: (script: Scripted) => void): (script: Scripted) => void {
  return (script) => {
    script.emit(echo(String(script.prompts[0]?.uuid), 'start the work'));
    launch(script);
  };
}

/** A `result` naming the prompts its turn consumed, as CLI 2.1.31x writes it. */
const resultFor = (uuids: string[]) => ({ ...result(), user_message_uuid: uuids[uuids.length - 1], user_message_uuids: uuids });

/** Sends the session's next message, with a writer of its own, as the chat gateway would for a new run. */
function sendNext(
  held: HeldRun,
  text: string,
  runOptions: Record<string, unknown> = {},
  writer: Writer = createWriter(2),
  context: Omit<ProviderRuntimeContext, 'createQuery'> = held.context,
) {
  const later = createScriptedQuery();
  held.laterQueries.push(later);
  const run = queryClaudeSDK(text, { sessionId: held.sessionId, cwd: held.cwd, ...runOptions }, writer.writer as never, { ...context, createQuery: later.createQuery });
  return { writer, run, settled: track(run), later };
}

/** The uuid the CLI got the prompt at `index` with. */
const promptUuid = (held: HeldRun, index: number) => String(held.script.prompts[index]?.uuid);

async function finish(held: HeldRun, runs: Array<Promise<unknown>> = []): Promise<void> {
  held.script.end();
  for (const later of held.laterQueries) {
    later.script.end();
  }
  await held.firstRun;
  await Promise.all(runs);
  await rm(held.cwd, { recursive: true, force: true });
}

test('a message while only background work is left goes into the held process as its next turn, and the work keeps running', async () => {
  const held = await startHeldRun();
  const next = sendNext(held, 'And check the logs');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    assert.equal(next.later.script.created(), false, 'no second CLI is started');
    assert.deepEqual(held.script.calls.filter((call) => !call.startsWith('prompt:')), [], 'nothing is interrupted, stopped or released');
    assert.deepEqual(listedTaskIds(held.sessionId), ['wf1']);
    const written = held.script.prompts[1];
    assert.deepEqual(written.message, { role: 'user', content: 'And check the logs' });
    assert.equal(written.priority, 'later', 'run once the CLI is idle, never folded into a turn it relays work in');
    assert.match(String(written.uuid), /^[0-9a-f-]{36}$/);
    assert.notEqual(written.uuid, held.script.prompts[0].uuid);
    assert.equal(held.first.handOverReports(), 1, 'the first run hears that its process goes on under the new run');

    held.script.emit(echo(promptUuid(held, 1), 'And check the logs'));
    held.script.emit(assistantText('The logs are clean.'));
    await flush();
    assert.deepEqual(userTexts(next.writer.sent), [], 'the composer already shows the message; its echo is dropped');
    assert.deepEqual(assistantTexts(next.writer.sent), ['The logs are clean.']);
    assert.deepEqual(assistantTexts(held.first.sent), [], 'the turn reports through its own run');

    held.script.emit(result());
    await flush();
    assert.equal(completes(next.writer.sent), 1, 'the new turn completes once');
    assert.equal(completes(held.first.sent), 1, 'the first turn is not completed again');
    assert.equal(next.settled(), true, 'the new run is over once its turn is');
    assert.equal(held.script.released(), false, 'the workflow still holds the process');

    held.script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    held.script.emit(relayResult());
    await flush();
    assert.equal(held.script.released(), true);
    assert.equal(next.writer.finishedReports(), 1, 'the work is reported finished once, to the turn that last left it running');
    assert.equal(held.first.finishedReports(), 0);
  } finally {
    await finish(held, [next.run]);
  }
});

test('work the CLI relays ahead of the handed-over turn ends as the previous run\'s, and the new turn still completes once', async () => {
  const held = await startHeldRun();
  // The workflow finishes and the CLI starts relaying it before the message comes.
  held.script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
  held.script.emit(assistantText('The workflow is done.'));
  await flush();
  const next = sendNext(held, 'Summarise it');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(relayResult());
    await flush();
    assert.equal(completes(next.writer.sent), 0, 'the relay is not the new turn');
    assert.equal(held.first.finishedReports(), 1, 'the work the first turn left running is reported done, to that run');
    assert.equal(next.writer.finishedReports(), 0);
    assert.equal(held.script.released(), false, 'the new turn still needs the process');
    assert.equal(next.settled(), false);

    held.script.emit(echo(promptUuid(held, 1), 'Summarise it'));
    held.script.emit(assistantText('Summary.'));
    held.script.emit(result());
    await flush();
    assert.equal(completes(next.writer.sent), 1);
    assert.equal(held.script.released(), true, 'nothing is left to hold the process for');
    assert.equal(next.writer.finishedReports() + held.first.finishedReports(), 1, 'reported once in all');
  } finally {
    await finish(held, [next.run]);
  }
});

test('a task of the hold that finishes during the handed-over turn keeps stdin open for the turn that relays it', async () => {
  const held = await startHeldRun();
  const next = sendNext(held, 'Keep going');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(echo(promptUuid(held, 1), 'Keep going'));
    held.script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    held.script.emit(result());
    await flush();
    assert.equal(completes(next.writer.sent), 1);
    assert.deepEqual(listedTaskIds(held.sessionId), []);
    assert.equal(held.script.released(), false, 'the CLI relays the workflow in a turn after this one');

    held.script.emit(assistantText('The workflow finished.'));
    held.script.emit(relayResult());
    await flush();
    assert.equal(held.script.released(), true);
    assert.equal(next.writer.finishedReports(), 1);
    assert.equal(held.first.finishedReports(), 0);
  } finally {
    await finish(held, [next.run]);
  }
});

test('stopping the last task of the hold during the handed-over turn leaves the turn its process', async () => {
  const held = await startHeldRun();
  const next = sendNext(held, 'Stop that workflow');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(echo(promptUuid(held, 1), 'Stop that workflow'));
    await flush();
    assert.equal(await stopClaudeSDKTask(held.sessionId, 'wf1'), true);
    held.script.emit(taskNotification('wf1', 'toolu_wf', 'stopped'));
    await flush();
    assert.equal(held.script.released(), false, 'the turn is still running');

    held.script.emit(result());
    await flush();
    assert.equal(completes(next.writer.sent), 1);
    assert.equal(held.script.released(), true, 'a stopped task is relayed in no turn, so nothing is left to hold for');
    assert.equal(next.writer.finishedReports() + held.first.finishedReports(), 0, 'a stopped task is not work that finished');
  } finally {
    await finish(held, [next.run]);
  }
});

test('work the tracker cannot see still holds the process after the handed-over turn', async () => {
  const held = await startHeldRun(launchUntrackedMonitor);
  const next = sendNext(held, 'Anything new?');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(echo(promptUuid(held, 1), 'Anything new?'));
    held.script.emit(assistantText('Nothing yet.'));
    held.script.emit(result());
    await flush();
    assert.equal(completes(next.writer.sent), 1);
    assert.equal(held.script.released(), false, 'the Monitor the first turn started keeps the process held');
  } finally {
    await finish(held, [next.run]);
  }
});

test('the hold\'s silence countdown stops while the handed-over turn runs and starts again at its end', async (t) => {
  const held = await startHeldRun(launchUntrackedMonitor);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // The countdown the first turn's end would have armed: a Monitor hold ends
  // after HOLD_IDLE of silence. Armed afresh here, under the mocked clock.
  held.script.emit(assistantText('Watching.'));
  const next = sendNext(held, 'Run the long migration');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(echo(promptUuid(held, 1), 'Run the long migration'));
    held.script.emit(toolUse('toolu_bash', 'Bash', { command: 'sleep 7200' }));
    await flush();
    // A long foreground command says nothing.
    t.mock.timers.tick(HOLD_IDLE_MS + MINUTE);
    await flush();
    assert.equal(held.script.released(), false, 'a silent tool call does not end a turn\'s process');

    held.script.emit(toolResult('toolu_bash', ''));
    held.script.emit(result());
    await flush();
    assert.equal(held.script.released(), false);
    t.mock.timers.tick(HOLD_IDLE_MS);
    await flush();
    assert.equal(held.script.released(), true, 'after the turn, the Monitor hold ends after HOLD_IDLE of silence again');
  } finally {
    await finish(held, [next.run]);
  }
});

test('a changed model and permission mode are switched in the held process before the prompt goes out', async () => {
  const held = await startHeldRun();
  const next = sendNext(held, 'Now with Opus', { model: 'opus', permissionMode: 'acceptEdits' });
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    assert.equal(next.later.script.created(), false);
    const calls = held.script.calls.filter((call) => call !== `prompt:${promptUuid(held, 0)}`);
    assert.deepEqual(calls, ['setModel:opus', 'setPermissionMode:acceptEdits', `prompt:${promptUuid(held, 1)}`]);
  } finally {
    await finish(held, [next.run]);
  }
});

test('the run\'s permission checks follow a switched permission mode once the CLI confirms it, and not a refused one', async () => {
  const held = await startHeldRun(launchWorkflow, { permissionMode: 'bypassPermissions' });
  const canUseTool = held.script.options()?.canUseTool as (tool: string, input: unknown, context: unknown) => Promise<{ behavior: string }>;
  try {
    assert.equal((await canUseTool('Bash', { command: 'ls' }, {})).behavior, 'allow', 'bypassed before the switch');

    // A refused switch leaves the process, and the checks, as they were.
    held.script.setSwitchAnswer('refuse');
    const refused = sendNext(held, 'In auto', { permissionMode: 'auto' });
    await waitUntil(() => held.script.prompts.length === 2);
    await flush();
    assert.equal((await canUseTool('Bash', { command: 'ls' }, {})).behavior, 'allow');
    held.script.emit(echo(promptUuid(held, 1), 'In auto'));
    held.script.emit(result());
    await waitUntil(() => refused.settled());

    held.script.setSwitchAnswer('ok');
    const next = sendNext(held, 'Ask me first', { permissionMode: 'default' });
    await waitUntil(() => held.script.prompts.length === 3);
    await flush();
    void canUseTool('Bash', { command: 'rm -rf build' }, {});
    await flush();
    const requests = next.writer.sent.filter((message) => message.kind === 'permission_request');
    assert.equal(requests.length, 1, 'the tool now needs approval, asked through the new turn\'s run');
    assert.equal(requests[0]?.toolName, 'Bash');
    claudeRuntime.permissions.resolve(String(requests[0]?.requestId), { allow: false });
  } finally {
    await finish(held);
  }
});

/** The notices a run got that the held process was replaced: `[code, changes, content]`. */
const workStoppedNotices = (sent: NormalizedMessage[]) => sent
  .filter((message) => message.kind === 'error')
  .map((message) => [message.code, message.changes, message.content]);

test('a change only a new process can apply replaces the held process, and the new run says why in a notice the client can translate', async () => {
  const held = await startHeldRun();
  const next = sendNext(held, 'Think harder', { effort: 'high' });
  try {
    await waitUntil(() => held.script.released());
    assert.deepEqual(held.script.calls.filter((call) => !call.startsWith('prompt:')), ['interrupt', 'stop:wf1', 'release'], 'the process is retired as before');
    assert.equal(held.script.prompts.length, 1, 'nothing is written to it');
    assert.deepEqual(workStoppedNotices(next.writer.sent), [[
      'BACKGROUND_WORK_STOPPED',
      ['effort'],
      'Background work stopped: this message changes the reasoning effort, which only a new Claude process can apply.',
    ]]);
    assert.equal(held.first.handOverReports(), 0);
    // The retired CLI exits; the new run then starts its own.
    held.script.end();
    await waitUntil(() => next.later.script.created());
  } finally {
    await finish(held, [next.run]);
  }

  const elsewhere = await startHeldRun();
  const moved = sendNext(elsewhere, 'Think harder over there', { effort: 'high', cwd: '/elsewhere' });
  try {
    await waitUntil(() => elsewhere.script.released());
    assert.deepEqual(workStoppedNotices(moved.writer.sent), [[
      'BACKGROUND_WORK_STOPPED',
      ['cwd', 'effort'],
      'Background work stopped: this message changes the working directory and the reasoning effort, which only a new Claude process can apply.',
    ]]);
    elsewhere.script.end();
    await waitUntil(() => moved.later.script.created());
  } finally {
    await finish(elsewhere, [moved.run]);
  }
});

test('each change only a new process can apply is named, and none goes into the held process', async () => {
  const cases: Array<{ launch: Record<string, unknown>; next: Record<string, unknown>; named: string }> = [
    { launch: {}, next: { permissionMode: 'bypassPermissions' }, named: 'permissionMode' },
    { launch: { toolsSettings: { allowedTools: ['Read'], disallowedTools: [] } }, next: { toolsSettings: { allowedTools: [], disallowedTools: [] } }, named: 'tools' },
    { launch: {}, next: { toolsSettings: { allowedTools: [], disallowedTools: ['Bash'] } }, named: 'tools' },
    // Ultracode needs an xhigh-capable model, which the catalog marks.
    { launch: { model: 'opus' }, next: { model: 'opus', ultracode: true }, named: 'ultracode' },
    { launch: { model: 'opus', ultracode: true }, next: { model: 'opus', ultracode: false }, named: 'ultracode' },
    // A process launched on a model without ultracode runs with it off.
    { launch: {}, next: { model: 'opus', ultracode: true }, named: 'ultracode' },
    { launch: {}, next: { cwd: '/elsewhere' }, named: 'cwd' },
  ];
  for (const { launch, next: nextOptions, named } of cases) {
    const held = await startHeldRun(launchWorkflow, launch);
    const next = sendNext(held, 'Again', { ...launch, ...nextOptions });
    try {
      await waitUntil(() => held.script.released());
      const notices = workStoppedNotices(next.writer.sent);
      assert.equal(notices.length, 1, named);
      assert.deepEqual(notices[0]?.slice(0, 2), ['BACKGROUND_WORK_STOPPED', [named]], named);
      assert.equal(held.script.prompts.length, 1, named);
      held.script.end();
      await waitUntil(() => next.later.script.created());
    } finally {
      await finish(held, [next.run]);
    }
  }
});

test('a turn that allows more tools, or enters plan mode, still goes into the held process', async () => {
  const held = await startHeldRun(launchWorkflow, { toolsSettings: { allowedTools: ['Read'], disallowedTools: [] } });
  const next = sendNext(held, 'Plan it', { permissionMode: 'plan', toolsSettings: { allowedTools: ['Read', 'Bash(npm test:*)'], disallowedTools: [] } });
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    assert.equal(next.later.script.created(), false);
    assert.equal(held.script.calls.includes('setPermissionMode:plan'), true);
    await flush();
    const canUseTool = held.script.options()?.canUseTool as (tool: string, input: unknown, context: unknown) => Promise<{ behavior: string }>;
    assert.equal((await canUseTool('Bash', { command: 'npm test -- --watch' }, {})).behavior, 'allow', 'the turn\'s own rule is granted');
    assert.equal((await canUseTool('WebSearch', { query: 'x' }, {})).behavior, 'allow', 'and so are the tools plan mode allows');
  } finally {
    await finish(held, [next.run]);
  }
});

test('a plain model switch to or from the default model goes into the held process', async () => {
  // The composer sends no ultracode choice for the default model, which
  // cannot run it, and an explicit one for the others.
  const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
    [{ model: 'default', effort: 'default' }, { model: 'opus', effort: 'default', ultracode: false }],
    [{ model: 'opus', ultracode: false }, { model: 'default' }],
  ];
  for (const [launch, nextOptions] of cases) {
    const held = await startHeldRun(launchWorkflow, launch);
    const next = sendNext(held, 'Again', nextOptions);
    try {
      await waitUntil(() => held.script.prompts.length === 2);
      assert.equal(next.later.script.created(), false);
      assert.deepEqual(held.script.calls.filter((call) => !call.startsWith('prompt:')), [`setModel:${String(nextOptions.model)}`], 'switched, not retired');
      assert.deepEqual(listedTaskIds(held.sessionId), ['wf1']);
      assert.deepEqual(workStoppedNotices(next.writer.sent), []);
    } finally {
      await finish(held, [next.run]);
    }
  }
});

const NOTHING_HELD = { heldWork: false, canHandOver: false, changes: [], switches: [] };

test('planning a turn says whether it would go into the held process, and sends the process nothing', async () => {
  assert.deepEqual(await claudeRuntime.planHandOver(`app-held-turn-${randomUUID()}`, {}), NOTHING_HELD, 'no process');

  const held = await startHeldRun(launchWorkflow, { model: 'opus', effort: 'high' });
  try {
    const plan = (options: Record<string, unknown>) => claudeRuntime.planHandOver(held.sessionId, { sessionId: held.sessionId, cwd: held.cwd, ...options });
    assert.deepEqual(await plan({ model: 'opus', effort: 'high' }), { heldWork: true, canHandOver: true, changes: [], switches: [] });
    assert.deepEqual(
      await plan({ model: 'sonnet', effort: 'high', permissionMode: 'acceptEdits' }),
      { heldWork: true, canHandOver: true, changes: [], switches: ['model', 'permissionMode'] },
      'both are switched in the live process',
    );
    assert.deepEqual(await plan({ model: 'opus', effort: 'max' }), { heldWork: true, canHandOver: false, changes: ['effort'], switches: [] });
    assert.deepEqual(
      await plan({ model: 'opus', effort: 'max', ultracode: true, cwd: '/elsewhere', permissionMode: 'bypassPermissions', toolsSettings: { allowedTools: [], disallowedTools: ['Bash'] } }),
      {
        heldWork: true,
        canHandOver: false,
        changes: ['cwd', 'effort', 'ultracode', 'tools', 'permissionMode'],
        switches: [],
        details: {
          tools: { notAllowed: [], alsoDenied: ['Bash'] },
          permissionMode: { process: 'default', message: 'bypassPermissions', reason: 'bypass_not_allowed' },
        },
      },
      'the tool rules and the permission mode say what exactly keeps the turn out',
    );
    assert.deepEqual(await plan({ model: 'opus', effort: 'high', resumeAnchorId: 'anchor-1' }), { heldWork: true, canHandOver: false, changes: [], switches: [] }, 'an edit resumes partway, which only a new process can');
    assert.deepEqual(await plan({ model: 'default' }), { heldWork: true, canHandOver: false, changes: ['effort'], switches: ['model'] }, 'a model switch that drops the effort level is not plain');
    assert.deepEqual(await plan({ model: 'default', effort: 'high' }), { heldWork: true, canHandOver: true, changes: [], switches: ['model'] }, 'nor is ultracode, which the default model cannot run');

    assert.deepEqual(held.script.calls, [`prompt:${promptUuid(held, 0)}`], 'nothing was written, switched or stopped');
    assert.deepEqual(listedTaskIds(held.sessionId), ['wf1']);

    // The turn the plan said would go in does.
    const next = sendNext(held, 'Go on', { model: 'opus', effort: 'high' });
    await waitUntil(() => held.script.prompts.length === 2);
    assert.equal(next.later.script.created(), false);
    assert.deepEqual(
      await plan({ model: 'opus', effort: 'high' }),
      { heldWork: true, canHandOver: false, changes: [], switches: [] },
      'a process in a turn takes no send, and interrupting the turn would stop the workflow',
    );
    held.script.emit(echo(promptUuid(held, 1), 'Go on'));
    held.script.emit(result());
    await waitUntil(() => next.settled());
    assert.deepEqual(await plan({ model: 'opus', effort: 'high' }), { heldWork: true, canHandOver: true, changes: [], switches: [] }, 'held again after that turn');
  } finally {
    await finish(held);
  }
});

test('planning a turn names a model switch the SDK cannot make, and a failed lookup', async () => {
  const unswitchable = await startHeldRun(launchWorkflow, {}, { behaviour: { switches: false } });
  try {
    assert.deepEqual(
      await claudeRuntime.planHandOver(unswitchable.sessionId, { cwd: unswitchable.cwd, model: 'opus', permissionMode: 'plan' }),
      {
        heldWork: true,
        canHandOver: false,
        changes: ['model', 'permissionMode'],
        switches: [],
        details: {
          model: { process: 'default', message: 'opus' },
          permissionMode: { process: 'default', message: 'plan', reason: 'cannot_switch' },
        },
      },
    );
  } finally {
    await finish(unswitchable);
  }

  let failing = false;
  const held = await startHeldRun(launchWorkflow, {}, { context: createFailingLookupContext(() => failing) });
  try {
    failing = true;
    assert.deepEqual(await claudeRuntime.planHandOver(held.sessionId, { cwd: held.cwd }), { heldWork: true, canHandOver: false, changes: ['lookup'], switches: [] });
    assert.deepEqual(held.script.calls, [`prompt:${promptUuid(held, 0)}`]);
  } finally {
    await finish(held);
  }
});

test('planning a turn reads the model the turn names before the one the session last recorded', async () => {
  // The chat gateway records a send's model before its run looks the model
  // up, so the run will resolve the model the send names; the plan, asked
  // before that, must not use the session's previous one.
  const context = createContext();
  const held = await startHeldRun(launchWorkflow, { model: 'opus', effort: 'xhigh' }, {
    context: { ...context, resolveResumeModel: async () => 'opus' },
  });
  try {
    assert.deepEqual(
      await claudeRuntime.planHandOver(held.sessionId, { cwd: held.cwd, model: 'default', effort: 'xhigh' }),
      { heldWork: true, canHandOver: false, changes: ['effort'], switches: ['model'] },
      'the default model has no xhigh level',
    );
    assert.deepEqual(
      await claudeRuntime.planHandOver(held.sessionId, { cwd: held.cwd, effort: 'xhigh' }),
      { heldWork: true, canHandOver: true, changes: [], switches: [] },
      'a turn that names no model resumes with the recorded one',
    );
  } finally {
    await finish(held);
  }
});

test('planning a turn counts a hold for work the tracker cannot see as held work, and one kept only for nested tasks as none', async () => {
  const monitored = await startHeldRun(launchUntrackedMonitor);
  try {
    assert.deepEqual(await claudeRuntime.planHandOver(monitored.sessionId, { cwd: monitored.cwd }), { heldWork: true, canHandOver: true, changes: [], switches: [] });
  } finally {
    await finish(monitored);
  }

  const held = await startHeldRun((script) => {
    launchWorkflow(script);
    // A command one of the workflow's agents backgrounded: not the session's own.
    script.emit(taskStarted('nested1', 'toolu_inside_agent', 'local_bash'));
  });
  try {
    held.script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    held.script.emit(relayResult());
    await flush();
    assert.deepEqual(listedTaskIds(held.sessionId), ['nested1']);
    assert.equal(held.script.released(), false);
    assert.deepEqual(await claudeRuntime.planHandOver(held.sessionId, { cwd: held.cwd }), { heldWork: false, canHandOver: true, changes: [], switches: [] });
  } finally {
    await finish(held);
  }
});

// What a scheduled message stores (ChatInterface.handleScheduleMessage): no
// tool settings, unlike a composer send (buildSendOptions).
const SCHEDULED_OPTIONS = { model: 'sonnet', effort: 'high', permissionMode: 'default' };
const INHERIT_UNSET = { inheritUnset: true };

/** The tool settings a composer send carries, the user's permission preferences. */
const toolsSettings = (allowedTools: string[], disallowedTools: string[], skipPermissions: boolean) => ({
  toolsSettings: { allowedTools, disallowedTools, skipPermissions },
});

type CanUseTool = (tool: string, input: unknown, context: unknown) => Promise<{ behavior: string }>;

test('a plan that inherits unset settings takes the tool rules and skipped permissions a message leaves out from the live process', async () => {
  // A composer send with permissions skipped launched the loop in bypassPermissions.
  const skipping = await startHeldRun(announcingPrompt(scheduleWakeup), { ...SCHEDULED_OPTIONS, ...toolsSettings([], [], true) });
  try {
    const plan = (planOptions?: Record<string, unknown>) => claudeRuntime.planHandOver(
      skipping.sessionId,
      { sessionId: skipping.sessionId, cwd: skipping.cwd, ...SCHEDULED_OPTIONS },
      planOptions,
    );
    assert.deepEqual(await plan(INHERIT_UNSET), { heldWork: true, canHandOver: true, changes: [], switches: [] });
    assert.deepEqual(
      await plan(),
      { heldWork: true, canHandOver: true, changes: [], switches: ['permissionMode'] },
      'read as it is, the message switches the loop out of bypassPermissions',
    );
  } finally {
    await finish(skipping);
  }

  // A rule the user allowed for good, and one they deny.
  const ruled = await startHeldRun(announcingPrompt(scheduleWakeup), {
    ...SCHEDULED_OPTIONS,
    ...toolsSettings(['Bash(git status:*)'], ['WebFetch'], false),
  });
  try {
    const plan = (planOptions?: Record<string, unknown>) => claudeRuntime.planHandOver(
      ruled.sessionId,
      { sessionId: ruled.sessionId, cwd: ruled.cwd, ...SCHEDULED_OPTIONS },
      planOptions,
    );
    assert.deepEqual(await plan(INHERIT_UNSET), { heldWork: true, canHandOver: true, changes: [], switches: [] });
    assert.deepEqual(
      await plan(),
      { heldWork: true, canHandOver: false, changes: ['tools'], switches: [], details: { tools: { notAllowed: ['Bash(git status:*)'], alsoDenied: [] } } },
      'read as it is, the message allows fewer tools',
    );
    assert.deepEqual(ruled.script.calls, [`prompt:${promptUuid(ruled, 0)}`], 'nothing was written or switched');
  } finally {
    await finish(ruled);
  }
});

test('a plan that inherits unset settings still weighs what the message names, and takes an unnamed model from the process, not from the session\'s record', async () => {
  const context = createContext();
  let recordedModel = 'opus';
  const held = await startHeldRun(launchWorkflow, { model: 'opus', effort: 'high' }, {
    context: { ...context, resolveResumeModel: async () => recordedModel },
  });
  // The composer's latest pick, recorded for the session since the process started.
  recordedModel = 'sonnet';
  try {
    const plan = (options: Record<string, unknown>, planOptions?: Record<string, unknown>) => claudeRuntime.planHandOver(
      held.sessionId,
      { sessionId: held.sessionId, cwd: held.cwd, ...options },
      planOptions,
    );
    assert.deepEqual(await plan({}, INHERIT_UNSET), { heldWork: true, canHandOver: true, changes: [], switches: [] });
    assert.deepEqual(
      await plan({}),
      { heldWork: true, canHandOver: false, changes: ['effort'], switches: ['model'] },
      'read as it is: the recorded model, and no effort level',
    );
    assert.deepEqual(
      await plan({ inheritUnset: true }),
      { heldWork: true, canHandOver: true, changes: [], switches: [] },
      'options that inherit, as their run will, are planned the same way',
    );
    assert.deepEqual(
      await plan({ model: 'default', permissionMode: 'acceptEdits' }, INHERIT_UNSET),
      { heldWork: true, canHandOver: true, changes: [], switches: ['model', 'permissionMode'] },
    );
    assert.deepEqual(await plan({ effort: 'max' }, INHERIT_UNSET), { heldWork: true, canHandOver: false, changes: ['effort'], switches: [] });
    assert.deepEqual(
      await plan({ toolsSettings: { disallowedTools: ['Bash'] } }, INHERIT_UNSET),
      { heldWork: true, canHandOver: false, changes: ['tools'], switches: [], details: { tools: { notAllowed: [], alsoDenied: ['Bash'] } } },
      'a tool rule the message carries is its own',
    );
  } finally {
    await finish(held);
  }
});

test('a turn that inherits unset settings goes into a loop held in bypassPermissions without switching it, and the loop is still not asked about its tools', async () => {
  const held = await startHeldRun(announcingPrompt(scheduleWakeup), { ...SCHEDULED_OPTIONS, ...toolsSettings([], [], true) });
  const canUseTool = held.script.options()?.canUseTool as CanUseTool;
  const next = sendNext(held, 'Post a summary', { ...SCHEDULED_OPTIONS, inheritUnset: true });
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    assert.equal(next.later.script.created(), false, 'no second CLI is started');
    assert.deepEqual(held.script.calls.filter((call) => !call.startsWith('prompt:')), [], 'nothing is switched, stopped or released');
    held.script.emit(echo(promptUuid(held, 1), 'Post a summary'));
    held.script.emit(result());
    await waitUntil(() => next.settled());
    assert.equal(held.script.released(), false, 'the loop still holds the process');
    assert.equal((await canUseTool('Bash', { command: 'kubectl get pods' }, {})).behavior, 'allow');
    assert.deepEqual(next.writer.sent.filter((message) => message.kind === 'permission_request'), []);
  } finally {
    await finish(held, [next.run]);
  }
});

test('a turn that inherits unset settings and carries no tool rules goes into a process launched with some, and they still apply', async () => {
  const held = await startHeldRun(announcingPrompt(scheduleWakeup), {
    ...SCHEDULED_OPTIONS,
    ...toolsSettings(['Bash(git status:*)'], ['WebFetch'], false),
  });
  const canUseTool = held.script.options()?.canUseTool as CanUseTool;
  const next = sendNext(held, 'Post a summary', { ...SCHEDULED_OPTIONS, inheritUnset: true });
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    assert.equal(next.later.script.created(), false, 'no second CLI is started');
    assert.deepEqual(held.script.calls.filter((call) => !call.startsWith('prompt:')), [], 'nothing is switched, stopped or released');
    assert.deepEqual(workStoppedNotices(next.writer.sent), []);
    await flush();
    assert.equal((await canUseTool('Bash', { command: 'git status --short' }, {})).behavior, 'allow', 'the allowed rule still applies');
    assert.equal((await canUseTool('WebFetch', { url: 'https://example.com' }, {})).behavior, 'deny', 'and so does the denied one');
  } finally {
    await finish(held, [next.run]);
  }
});

test('a turn that inherits unset settings and names no model keeps the process\'s model, though the session recorded another since', async () => {
  const context = createContext();
  let recordedModel = 'opus';
  const held = await startHeldRun(announcingPrompt(scheduleWakeup), { model: 'opus', effort: 'high' }, {
    context: { ...context, resolveResumeModel: async () => recordedModel },
  });
  recordedModel = 'sonnet';
  const next = sendNext(held, 'Post a summary', { effort: 'high', inheritUnset: true });
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    assert.equal(next.later.script.created(), false, 'no second CLI is started');
    assert.deepEqual(held.script.calls.filter((call) => !call.startsWith('prompt:')), [], 'the model is not switched');
  } finally {
    await finish(held, [next.run]);
  }
});

test('a later turn that inherits unset settings inherits the skipped permissions of the turn handed over last, not of the launch', async () => {
  const held = await startHeldRun(launchWorkflow, { ...SCHEDULED_OPTIONS, ...toolsSettings([], [], true) });
  try {
    // The user turned skipped permissions off: the composer's next send
    // switches the process from bypassPermissions to default.
    const asked = sendNext(held, 'Ask me first', { ...SCHEDULED_OPTIONS, ...toolsSettings([], [], false) });
    await waitUntil(() => held.script.prompts.length === 2);
    assert.deepEqual(held.script.calls.filter((call) => call.startsWith('set')), ['setPermissionMode:default']);
    held.script.emit(echo(promptUuid(held, 1), 'Ask me first'));
    held.script.emit(result());
    await waitUntil(() => asked.settled());

    assert.deepEqual(
      await claudeRuntime.planHandOver(held.sessionId, { sessionId: held.sessionId, cwd: held.cwd, ...SCHEDULED_OPTIONS }, INHERIT_UNSET),
      { heldWork: true, canHandOver: true, changes: [], switches: [] },
    );
  } finally {
    await finish(held);
  }
});

test('while a turn runs in a process with work of the session\'s own, a plan says interrupting it would stop that work; with none, it says nothing is held', async () => {
  // The user's turn went into a process a loop holds for its next wake-up.
  const looping = await startHeldRun(announcingPrompt(scheduleWakeup));
  const next = sendNext(looping, 'How is it going?');
  try {
    await waitUntil(() => looping.script.prompts.length === 2);
    looping.script.emit(echo(promptUuid(looping, 1), 'How is it going?'));
    await flush();
    const busy = { heldWork: true, canHandOver: false, changes: [], switches: [] };
    assert.deepEqual(await claudeRuntime.planHandOver(looping.sessionId, { cwd: looping.cwd, effort: 'max' }, INHERIT_UNSET), busy);
    assert.deepEqual(await claudeRuntime.planHandOver(looping.sessionId, { cwd: looping.cwd }), busy);
  } finally {
    await finish(looping, [next.run]);
  }

  // A first turn: once it has a task of its own outstanding, and before.
  const sessionId = `app-held-turn-${randomUUID()}`;
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-held-turn-'));
  const { createQuery, script } = createScriptedQuery();
  const firstRun = queryClaudeSDK('Hi', { sessionId, cwd }, createWriter(1).writer as never, { ...createContext(), createQuery });
  try {
    await waitUntil(() => script.prompts.length === 1);
    script.emit(init());
    await flush();
    assert.deepEqual(await claudeRuntime.planHandOver(sessionId, { cwd }), NOTHING_HELD, 'nothing in the background yet');
    launchWorkflow(script);
    await flush();
    assert.deepEqual(await claudeRuntime.planHandOver(sessionId, { cwd }), { heldWork: true, canHandOver: false, changes: [], switches: [] });
  } finally {
    script.end();
    await firstRun;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a turn that only adds to the to-do list lets its process go: the next send finds no held work, and is told of none stopped', async () => {
  // TaskCreate (CLI 2.1.312) adds an item to the to-do list. Nothing runs for
  // it and no task event comes, yet the process used to be held for it: a send
  // that needs a new process was then refused over an empty work list, and
  // once sent anyway was told background work had stopped.
  const sessionId = `app-held-turn-${randomUUID()}`;
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-held-turn-'));
  const { createQuery, script } = createScriptedQuery();
  const first = createWriter(1);
  const context = createContext();
  const firstRun = queryClaudeSDK('Plan the change', { sessionId, cwd, model: 'opus', effort: 'high' }, first.writer as never, { ...context, createQuery });
  // Shaped like a held run so sendNext and finish apply; nothing holds it.
  const run: HeldRun = { sessionId, cwd, script, first, firstRun, context, laterQueries: [] };
  const laterRuns: Array<Promise<unknown>> = [];
  try {
    await waitUntil(() => script.prompts.length === 1);
    script.emit(init());
    script.emit(toolUse('toolu_todo', 'TaskCreate', { subject: 'Wire the route', description: 'Add the route and its test' }));
    script.emit(toolResult('toolu_todo', 'Task #1 created successfully: Wire the route'));
    script.emit(result());
    await waitUntil(() => completes(first.sent) === 1);
    await flush();
    assert.deepEqual(await claudeRuntime.planHandOver(sessionId, { cwd, model: 'opus', effort: 'max' }), NOTHING_HELD);
    assert.equal(script.released(), true, 'nothing outlives the turn, so its CLI is let go at once');

    // The CLI exits on the release; the next send starts a process of its own.
    script.end();
    const next = sendNext(run, 'Start on it', { model: 'opus', effort: 'max' });
    laterRuns.push(next.run);
    await waitUntil(() => next.later.script.created());
    assert.deepEqual(workStoppedNotices(next.writer.sent), []);
  } finally {
    await finish(run, laterRuns);
  }
});

test('an edited message replaces the held process without a word', async () => {
  const held = await startHeldRun();
  const next = sendNext(held, 'Edited', { resumeAnchorId: 'anchor-1' });
  try {
    await waitUntil(() => held.script.released());
    assert.equal(held.script.prompts.length, 1);
    assert.deepEqual(next.writer.sent.filter((message) => message.kind === 'error'), [], 'the client asked before sending it');
    held.script.end();
    await waitUntil(() => next.later.script.created());
  } finally {
    await finish(held, [next.run]);
  }
});

test('stopping a handed-over turn whose prompt has not started takes the prompt back, and leaves the CLI\'s own turn and the work running', async () => {
  const held = await startHeldRun();
  // The CLI is relaying something else, so the message waits in its queue.
  held.script.emit(assistantText('Relaying.'));
  await flush();
  const next = sendNext(held, 'Never mind');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    assert.equal(await abortClaudeSDKSession(held.sessionId), true);
    await flush();
    const calls = held.script.calls.filter((call) => !call.startsWith('prompt:'));
    assert.deepEqual(calls, [`cancel:${promptUuid(held, 1)}`], 'taken back; the relaying turn is not interrupted, and nothing is stopped or released');
    assert.equal(next.settled(), true);
    assert.equal(completes(next.writer.sent), 0, 'the abort\'s caller sends the terminal complete');
    assert.deepEqual(listedTaskIds(held.sessionId), ['wf1']);

    // The relaying turn ends with the workflow still going: the process is
    // held for it, and the session's next message goes into it.
    held.script.emit(relayResult());
    await flush();
    assert.equal(held.script.released(), false);
    const after = sendNext(held, 'Now this', {}, createWriter(3));
    await waitUntil(() => held.script.prompts.length === 3);
    assert.equal(after.later.script.created(), false, 'no second CLI is started');
  } finally {
    await finish(held, [next.run]);
  }
});

test('a handed-over turn stopped while the CLI relays the finished work ahead of it leaves that relay to report the work done', async () => {
  const held = await startHeldRun();
  // The workflow finishes, and the CLI starts relaying it.
  held.script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
  held.script.emit(assistantText('The workflow is done.'));
  await flush();
  const next = sendNext(held, 'Never mind');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    assert.equal(await abortClaudeSDKSession(held.sessionId), true);
    assert.equal(completes(next.writer.sent), 0, 'the abort\'s caller sends the terminal complete');
    held.script.emit(relayResult());
    await flush();
    assert.deepEqual(held.script.calls.filter((call) => !call.startsWith('prompt:')), [`cancel:${promptUuid(held, 1)}`, 'release'], 'let go once nothing is left');
    assert.deepEqual([held.first.finishedReports(), next.writer.finishedReports()], [1, 0], 'the work is reported done, to the run that left it running');
  } finally {
    await finish(held, [next.run]);
  }
});

test('stopping a handed-over turn once it has started interrupts that turn alone: the work and the hold go on, and the next message goes into the process', async () => {
  const held = await startHeldRun();
  const next = sendNext(held, 'Go');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(echo(promptUuid(held, 1), 'Go'));
    held.script.emit(assistantText('Going.'));
    await flush();
    const aborting = abortClaudeSDKSession(held.sessionId);
    const stopSettled = track(aborting);
    await waitUntil(() => held.script.calls.includes('interrupt'));
    await flush();
    assert.equal(stopSettled(), false, 'the stop waits for the interrupted turn to end, so the next send finds the process held again');
    held.script.emit(interruptedResultFor(promptUuid(held, 1)));
    assert.equal(await aborting, true);
    await flush();
    assert.deepEqual(held.script.calls.filter((call) => !call.startsWith('prompt:')), ['interrupt'], 'no task is stopped, and the input stays open');
    assert.equal(next.settled(), true);
    assert.equal(completes(next.writer.sent), 0, 'the abort\'s caller sends the terminal complete');
    assert.deepEqual(listedTaskIds(held.sessionId), ['wf1']);
    assert.deepEqual(await claudeRuntime.planHandOver(held.sessionId, { cwd: held.cwd }), { heldWork: true, canHandOver: true, changes: [], switches: [] });

    const third = sendNext(held, 'Again', {}, createWriter(3));
    await waitUntil(() => held.script.prompts.length === 3);
    assert.equal(third.later.script.created(), false, 'no second CLI is started');
    held.script.emit(echo(promptUuid(held, 2), 'Again'));
    held.script.emit(result());
    await waitUntil(() => third.settled());
    assert.equal(completes(third.writer.sent), 1);
    held.script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    held.script.emit(relayResult());
    await flush();
    assert.equal(held.script.released(), true);
    assert.deepEqual([held.first.finishedReports(), next.writer.finishedReports(), third.writer.finishedReports()], [0, 0, 1]);
  } finally {
    await finish(held, [next.run]);
  }
});

test('an abort while the turn is still on its way into the held process stops only that turn', async () => {
  const held = await startHeldRun();
  let lookUpModel: () => void = () => {};
  const modelLookup = new Promise<undefined>((resolve) => { lookUpModel = () => resolve(undefined); });
  const next = sendNext(held, 'Wait', {}, createWriter(2), { ...held.context, resolveResumeModel: () => modelLookup });
  try {
    await flush();
    assert.equal(await abortClaudeSDKSession(held.sessionId), true);
    assert.deepEqual(held.script.calls.filter((call) => !call.startsWith('prompt:')), [], 'the held process and its work are left alone');
    lookUpModel();
    await waitUntil(() => next.settled());
    assert.equal(held.script.prompts.length, 1, 'the turn never goes in');
    assert.equal(next.later.script.created(), false, 'nor starts a process of its own');
    assert.deepEqual(listedTaskIds(held.sessionId), ['wf1']);
  } finally {
    await finish(held, [next.run]);
  }
});

test('inserts go into the handed-over turn once its prompt has started, and report through its run', async () => {
  const held = await startHeldRun();
  const next = sendNext(held, 'Look at the tests');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    assert.deepEqual(
      await claudeRuntime.insert(held.sessionId, { insertId: promptUuid(held, 1), content: 'x' }),
      { accepted: false, reason: 'DUPLICATE' },
      'the CLI acts on a uuid once',
    );
    const insertId = randomUUID();
    assert.deepEqual(await claudeRuntime.insert(held.sessionId, { insertId, content: 'Only the unit tests' }), { accepted: true });
    await flush();
    assert.equal(held.script.prompts.length, 2, 'not before the turn has started');

    held.script.emit(lifecycle(promptUuid(held, 1), 'started'));
    await flush();
    assert.equal(held.script.prompts[2]?.uuid, insertId);
    held.script.emit(echo(insertId, 'Only the unit tests'));
    await flush();
    const statuses = next.writer.sent.filter((message) => message.kind === 'insert_status').map((message) => message.insertStatus);
    assert.deepEqual(statuses, ['pending', 'delivered']);
    assert.equal(held.first.sent.some((message) => message.kind === 'insert_status'), false);
  } finally {
    await finish(held, [next.run]);
  }
});

test('the process ending during the handed-over turn completes that turn through its own run', async () => {
  const held = await startHeldRun();
  const next = sendNext(held, 'One more thing');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(echo(promptUuid(held, 1), 'One more thing'));
    held.script.end();
    await held.firstRun;
    await waitUntil(() => next.settled());
    assert.equal(completes(next.writer.sent), 1);
    assert.equal(completes(held.first.sent), 1);
  } finally {
    await finish(held, [next.run]);
  }
});

test('a third message goes into the same process once the second turn has left it held', async () => {
  const held = await startHeldRun();
  const second = sendNext(held, 'Second');
  const third = createWriter(3);
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(echo(promptUuid(held, 1), 'Second'));
    held.script.emit(result());
    await waitUntil(() => second.settled());

    const next = sendNext(held, 'Third', {}, third);
    await waitUntil(() => held.script.prompts.length === 3);
    assert.equal(second.writer.handOverReports(), 1);
    held.script.emit(echo(promptUuid(held, 2), 'Third'));
    held.script.emit(result());
    await waitUntil(() => next.settled());
    assert.deepEqual([completes(held.first.sent), completes(second.writer.sent), completes(third.sent)], [1, 1, 1]);

    held.script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    held.script.emit(relayResult());
    await flush();
    assert.deepEqual([held.first.finishedReports(), second.writer.finishedReports(), third.finishedReports()], [0, 0, 1]);
    assert.equal(held.script.released(), true);
  } finally {
    await finish(held, [second.run]);
  }
});

test('a process whose turn has not completed takes no other turn', async () => {
  const sessionId = `app-held-turn-${randomUUID()}`;
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-held-turn-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const context = createContext();
  const firstRun = queryClaudeSDK('Hi', { sessionId, cwd }, createWriter(1).writer as never, { ...context, createQuery: first.createQuery });
  try {
    await waitUntil(() => first.script.prompts.length === 1);
    first.script.emit(init());
    launchWorkflow(first.script);
    await flush();
    const secondRun = queryClaudeSDK('Next', { sessionId, cwd }, createWriter(2).writer as never, { ...context, createQuery: second.createQuery });
    await waitUntil(() => first.script.released());
    assert.equal(first.script.prompts.length, 1);
    assert.deepEqual(first.script.calls.filter((call) => !call.startsWith('prompt:')), ['interrupt', 'stop:wf1', 'release']);
    first.script.end();
    await waitUntil(() => second.script.created());
    second.script.end();
    await secondRun;
  } finally {
    first.script.end();
    second.script.end();
    await firstRun;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a process that has let go of its input takes no turn, and is sent no switch', async () => {
  const sessionId = `app-held-turn-${randomUUID()}`;
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-held-turn-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const context = createContext();
  const firstRun = queryClaudeSDK('Hi', { sessionId, cwd }, createWriter(1).writer as never, { ...context, createQuery: first.createQuery });
  try {
    await waitUntil(() => first.script.prompts.length === 1);
    first.script.emit(init());
    first.script.emit(result());
    // Nothing was outstanding, so the input is let go at once; the CLI has not exited yet.
    await waitUntil(() => first.script.released());

    const secondRun = queryClaudeSDK('Next', { sessionId, cwd, model: 'opus' }, createWriter(2).writer as never, { ...context, createQuery: second.createQuery });
    await flush();
    assert.deepEqual(first.script.calls.filter((call) => !call.startsWith('prompt:')), ['release']);
    first.script.end();
    await waitUntil(() => second.script.created());
    assert.equal(first.script.prompts.length, 1);
    second.script.end();
    await secondRun;
  } finally {
    first.script.end();
    second.script.end();
    await firstRun;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a held process an abort is stopping takes no new turn', async (t) => {
  const held = await startHeldRun(launchWorkflow, {}, { behaviour: { interrupt: 'hang' } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const aborting = abortClaudeSDKSession(held.sessionId);
  await flush();
  const next = sendNext(held, 'Next');
  try {
    await flush();
    assert.equal(held.script.prompts.length, 1, 'nothing goes into a process being stopped');
    // The interrupt is never answered: the abort closes the process after 5 s,
    // and the new run starts its CLI once the old one has had 8 s to die.
    t.mock.timers.tick(5 * 1000);
    assert.equal(await aborting, true);
    await waitUntil(() => held.script.calls.includes('close'));
    await held.firstRun;
    t.mock.timers.tick(8 * 1000);
    await waitUntil(() => next.later.script.created());
  } finally {
    await finish(held, [next.run]);
  }
});

test('a process whose SDK cannot switch the model or the permission mode takes no turn that changes either', async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ model: 'opus' }, 'model'],
    [{ permissionMode: 'acceptEdits' }, 'permissionMode'],
  ];
  for (const [change, named] of cases) {
    const held = await startHeldRun(launchWorkflow, {}, { behaviour: { switches: false } });
    const next = sendNext(held, 'Again', change);
    try {
      await waitUntil(() => held.script.released());
      assert.deepEqual(workStoppedNotices(next.writer.sent).map((notice) => notice.slice(0, 2)), [['BACKGROUND_WORK_STOPPED', [named]]], named);
      assert.equal(held.script.prompts.length, 1, named);
      held.script.end();
      await waitUntil(() => next.later.script.created());
    } finally {
      await finish(held, [next.run]);
    }
  }
});

test('a process launched in bypassPermissions switches back into it, and a switch it has made is not sent again', async () => {
  const held = await startHeldRun(launchWorkflow, { permissionMode: 'bypassPermissions' });
  const switches = () => held.script.calls.filter((call) => call.startsWith('set'));
  const completeTurn = async (index: number, run: ReturnType<typeof sendNext>) => {
    await waitUntil(() => held.script.prompts.length === index + 1);
    held.script.emit(echo(promptUuid(held, index), 'turn'));
    held.script.emit(result());
    await waitUntil(() => run.settled());
  };
  try {
    await completeTurn(1, sendNext(held, 'Ask first', { permissionMode: 'default', model: 'opus' }));
    assert.deepEqual(switches(), ['setModel:opus', 'setPermissionMode:default']);

    await completeTurn(2, sendNext(held, 'Same again', { permissionMode: 'default', model: 'opus' }));
    assert.deepEqual(switches(), ['setModel:opus', 'setPermissionMode:default'], 'the process runs with them already');

    const back = sendNext(held, 'Bypass again', { permissionMode: 'bypassPermissions', model: 'opus' });
    await waitUntil(() => held.script.prompts.length === 4);
    assert.equal(back.later.script.created(), false);
    assert.deepEqual(switches(), ['setModel:opus', 'setPermissionMode:default', 'setPermissionMode:bypassPermissions']);
  } finally {
    await finish(held);
  }
});

test('reconnecting the session\'s writer reaches the run of the turn handed over', async () => {
  const held = await startHeldRun();
  const next = sendNext(held, 'Next');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    const socket = { readyState: 1 };
    assert.equal(reconnectSessionWriter(held.sessionId, socket), true);
    assert.equal(next.writer.sockets.includes(socket), true);
    assert.deepEqual(held.first.sockets, []);
  } finally {
    await finish(held, [next.run]);
  }
});

test('work a relaying turn starts before the hand-over still holds the process after the handed-over turn', async () => {
  const held = await startHeldRun();
  // The workflow finishes, and the turn that relays it starts a Monitor.
  held.script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
  launchUntrackedMonitor(held.script);
  await flush();
  const next = sendNext(held, 'And then?');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(relayResult());
    held.script.emit(echo(promptUuid(held, 1), 'And then?'));
    held.script.emit(result());
    await flush();
    assert.equal(completes(next.writer.sent), 1);
    assert.equal(held.script.released(), false, 'the Monitor the relaying turn started keeps the process held');
    assert.deepEqual([held.first.finishedReports(), next.writer.finishedReports()], [0, 0], 'the work goes on in that Monitor');
  } finally {
    await finish(held, [next.run]);
  }
});

test('a process that ends while the turn makes its lookups leaves the turn a process of its own', async () => {
  const held = await startHeldRun();
  let lookUpModel: () => void = () => {};
  const modelLookup = new Promise<undefined>((resolve) => { lookUpModel = () => resolve(undefined); });
  const next = sendNext(held, 'Next', {}, createWriter(2), { ...held.context, resolveResumeModel: () => modelLookup });
  try {
    await flush();
    held.script.end();
    await held.firstRun;
    lookUpModel();
    await waitUntil(() => next.later.script.created());
    assert.equal(held.script.prompts.length, 1);
    assert.equal(next.writer.sent.some((message) => message.kind === 'error'), false, 'nothing about its options kept it out');
  } finally {
    await finish(held, [next.run]);
  }
});

test('a turn aborted on its way in starts nothing even when a lookup then fails', async () => {
  const held = await startHeldRun();
  let failLookup: () => void = () => {};
  const modelLookup = new Promise<undefined>((_resolve, reject) => { failLookup = () => reject(new Error('database is locked')); });
  const next = sendNext(held, 'Next', {}, createWriter(2), { ...held.context, resolveResumeModel: () => modelLookup });
  try {
    await flush();
    assert.equal(await abortClaudeSDKSession(held.sessionId), true);
    failLookup();
    await waitUntil(() => next.settled());
    assert.equal(next.later.script.created(), false);
    assert.equal(held.script.prompts.length, 1);
  } finally {
    await finish(held, [next.run]);
  }
});

test('a lookup that fails leaves the turn to a run of its own, and the run says the work stopped', async () => {
  const held = await startHeldRun();
  let calls = 0;
  const failingFirst = async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error('database is locked');
    }
    return undefined;
  };
  const next = sendNext(held, 'Next', {}, createWriter(2), { ...held.context, resolveResumeModel: failingFirst });
  try {
    await waitUntil(() => held.script.released());
    held.script.end();
    await waitUntil(() => next.later.script.created());
    assert.equal(held.script.prompts.length, 1);
    assert.deepEqual(workStoppedNotices(next.writer.sent), [[
      'BACKGROUND_WORK_STOPPED',
      ['lookup'],
      'Background work stopped: the message could not be handed to the process the work ran in.',
    ]]);
  } finally {
    await finish(held, [next.run]);
  }
});

test('the handed-over prompt\'s turn completes it even when its result names a task notification', async () => {
  // A CLI that read the prompt inside a turn it ran for a task notification.
  const held = await startHeldRun();
  const next = sendNext(held, 'Next');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(echo(promptUuid(held, 1), 'Next'));
    held.script.emit(relayResult());
    await flush();
    assert.equal(completes(next.writer.sent), 1);
    assert.equal(next.settled(), true);
  } finally {
    await finish(held, [next.run]);
  }
});

test('a wake-up turn the held process runs ahead of the handed-over prompt does not end the handed-over turn', async () => {
  const held = await startHeldRun(announcingPrompt(scheduleWakeup));
  // The wake-up fires and the CLI runs a turn of its own. Its result names
  // neither an origin nor a prompt of the run's.
  held.script.emit(assistantText('Checking the build again.'));
  await flush();
  const next = sendNext(held, 'What is the status?');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(result());
    await flush();
    assert.equal(completes(next.writer.sent), 0, 'the wake-up turn is not the handed-over one');
    assert.equal(next.settled(), false);
    assert.equal(held.script.released(), false, 'the handed-over turn still needs the process');
    assert.equal(held.first.finishedReports(), 1, 'the wake-up the first turn scheduled has run, and scheduled no other');

    held.script.emit(echo(promptUuid(held, 1), 'What is the status?'));
    held.script.emit(assistantText('All green.'));
    held.script.emit(result());
    await flush();
    assert.equal(completes(next.writer.sent), 1);
    assert.equal(next.settled(), true);
    assert.equal(assistantTexts(next.writer.sent).includes('All green.'), true);
    assert.equal(held.script.released(), true, 'nothing is left to hold the process for');
    assert.equal(held.first.finishedReports() + next.writer.finishedReports(), 1);
  } finally {
    await finish(held, [next.run]);
  }
});

test('a wake-up turn that schedules the next one keeps the process held past the handed-over turn, and nothing is reported finished', async () => {
  const held = await startHeldRun(announcingPrompt(scheduleWakeup));
  held.script.emit(assistantText('Checking the build again.'));
  await flush();
  const next = sendNext(held, 'What is the status?');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    // A self-paced loop: the wake-up turn schedules the next wake-up.
    scheduleWakeup(held.script, 'toolu_wakeup_2');
    held.script.emit(result());
    await flush();
    assert.equal(completes(next.writer.sent), 0);

    held.script.emit(echo(promptUuid(held, 1), 'What is the status?'));
    held.script.emit(assistantText('Still building.'));
    held.script.emit(result());
    await flush();
    assert.equal(completes(next.writer.sent), 1);
    assert.equal(held.script.released(), false, 'the next wake-up still holds the process');
    assert.deepEqual([held.first.finishedReports(), next.writer.finishedReports()], [0, 0], 'the loop goes on');
  } finally {
    await finish(held, [next.run]);
  }
});

test('an insert taken after the hand-over waits for the handed-over prompt\'s turn, not for a turn ahead of it', async () => {
  const held = await startHeldRun(announcingPrompt(scheduleWakeup));
  held.script.emit(assistantText('Checking the build again.'));
  await flush();
  const next = sendNext(held, 'What is the status?');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    const insertId = randomUUID();
    assert.deepEqual(await claudeRuntime.insert(held.sessionId, { insertId, content: 'And the logs' }), { accepted: true });
    held.script.emit(result());
    await flush();
    assert.equal(held.script.prompts.length, 2, 'written now, it would run ahead of the handed-over prompt');

    held.script.emit(lifecycle(promptUuid(held, 1), 'started'));
    await flush();
    assert.equal(held.script.prompts[2]?.uuid, insertId);
    assert.equal(held.script.prompts[2]?.priority, 'next');
  } finally {
    await finish(held, [next.run]);
  }
});

test('a result naming the handed-over prompt ends its turn, even one the CLI did not report taking', async () => {
  const held = await startHeldRun(announcingPrompt(launchWorkflow));
  const next = sendNext(held, 'Next');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    // Run in one turn with a prompt queued after it, which names that turn.
    held.script.emit(assistantText('Both done.'));
    held.script.emit(resultFor([promptUuid(held, 1), randomUUID()]));
    await flush();
    assert.equal(completes(next.writer.sent), 1);
    assert.equal(next.settled(), true);
  } finally {
    await finish(held, [next.run]);
  }
});

test('a result naming only other prompts is not the handed-over turn\'s, even from a CLI that reports nothing as it takes a prompt', async () => {
  const held = await startHeldRun();
  const next = sendNext(held, 'Next');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(resultFor([randomUUID()]));
    await flush();
    assert.equal(completes(next.writer.sent), 0);

    held.script.emit(resultFor([promptUuid(held, 1)]));
    await flush();
    assert.equal(completes(next.writer.sent), 1);
  } finally {
    await finish(held, [next.run]);
  }
});

test('from a CLI that reports nothing as it takes a prompt and names none on its results, the next plain result ends the handed-over turn', async () => {
  const held = await startHeldRun();
  const next = sendNext(held, 'Next');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(result());
    await flush();
    assert.equal(completes(next.writer.sent), 1, 'the turn cannot be left hanging');
  } finally {
    await finish(held, [next.run]);
  }
});

test('work relayed ahead of the handed-over turn is reported once, and not while another task of the hold is still to be relayed', async () => {
  const held = await startHeldRun((script) => {
    launchWorkflow(script);
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'survey', subagent_type: 'general-purpose', run_in_background: true }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(toolResult('toolu_agent', 'Async agent launched successfully.'));
  });
  // The workflow finishes, and the CLI starts relaying it.
  held.script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
  await flush();
  const next = sendNext(held, 'Next');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    // The agent finishes too: its relay comes after the handed-over turn.
    held.script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    held.script.emit(relayResult());
    await flush();
    assert.equal(held.first.finishedReports() + next.writer.finishedReports(), 0, 'the agent is still to be relayed');

    held.script.emit(lifecycle(promptUuid(held, 1), 'started'));
    held.script.emit(result());
    await flush();
    assert.equal(completes(next.writer.sent), 1);
    assert.equal(held.script.released(), false, 'held for the agent\'s relay');
    held.script.emit(relayResult());
    await flush();
    assert.deepEqual([held.first.finishedReports(), next.writer.finishedReports()], [0, 1]);
    assert.equal(held.script.released(), true);

    // A further relay finds nothing more to report.
    held.script.emit(relayResult());
    await flush();
    assert.deepEqual([held.first.finishedReports(), next.writer.finishedReports()], [0, 1]);
  } finally {
    await finish(held, [next.run]);
  }
});

test('two turns relayed ahead of the handed-over turn report the work done once', async () => {
  const held = await startHeldRun((script) => {
    launchWorkflow(script);
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'survey', subagent_type: 'general-purpose', run_in_background: true }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(toolResult('toolu_agent', 'Async agent launched successfully.'));
  });
  held.script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
  held.script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
  await flush();
  const next = sendNext(held, 'Next');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(relayResult());
    held.script.emit(relayResult());
    await flush();
    assert.deepEqual([held.first.finishedReports(), next.writer.finishedReports()], [1, 0]);
    held.script.emit(echo(promptUuid(held, 1), 'Next'));
    held.script.emit(result());
    await flush();
    assert.equal(held.script.released(), true);
    assert.deepEqual([held.first.finishedReports(), next.writer.finishedReports()], [1, 0]);
  } finally {
    await finish(held, [next.run]);
  }
});

test('a hold for work the tracker cannot see ends once that work reports back ahead of the handed-over turn', async () => {
  const held = await startHeldRun(launchUntrackedMonitor);
  // The Monitor fires, and the CLI runs a turn for it.
  held.script.emit(assistantText('The log changed.'));
  await flush();
  const next = sendNext(held, 'Next');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(relayResult());
    held.script.emit(echo(promptUuid(held, 1), 'Next'));
    held.script.emit(result());
    await flush();
    assert.equal(completes(next.writer.sent), 1);
    assert.equal(held.script.released(), true, 'as a follow-up turn ends a hold for such work');
  } finally {
    await finish(held, [next.run]);
  }
});

test('a newer run that takes the session over lets the handed-over turn\'s caller go', async () => {
  const held = await startHeldRun();
  const next = sendNext(held, 'Next');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    const newer = sendNext(held, 'Edited', { resumeAnchorId: 'anchor-1' }, createWriter(3));
    await waitUntil(() => next.settled());
    held.script.end();
    await waitUntil(() => newer.later.script.created());
    newer.later.script.end();
    await newer.run;
  } finally {
    await finish(held, [next.run]);
  }
});

/** A backgrounded command the tracker follows (`bg1` by default). */
function launchBackgroundCommand(script: Scripted, taskId = 'bg1', toolUseId = 'toolu_bash'): void {
  script.emit(toolUse(toolUseId, 'Bash', { command: 'make', run_in_background: true }));
  script.emit(taskStarted(taskId, toolUseId, 'local_bash'));
  script.emit(toolResult(toolUseId, `Command running in background with ID: ${taskId}`));
}

/** The CLI feeding a finished task's notification into the turn that relays it, as CLI 2.1.312 echoes it. */
const notificationEcho = (taskId: string, toolUseId: string) => ({
  type: 'user', isReplay: true, uuid: randomUUID(), session_id: NATIVE_ID, parent_tool_use_id: null,
  origin: { kind: 'task-notification', producer: 'session-task' },
  message: { role: 'user', content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n</task-notification>` },
});

/** A task finishing and the CLI relaying it in a turn of its own. */
function relayFinishedTask(script: Scripted, taskId: string, toolUseId: string): void {
  script.emit(taskNotification(taskId, toolUseId, 'completed'));
  script.emit(notificationEcho(taskId, toolUseId));
  script.emit(assistantText(`${taskId} is done.`));
  script.emit(relayResult());
}

/** A scheduled wake-up firing: the CLI's own turn, whose result names neither an origin nor a prompt. */
function fireWakeup(script: Scripted, scheduleNext = false): void {
  script.emit(lifecycle(randomUUID(), 'started'));
  script.emit(assistantText('Checking again.'));
  if (scheduleNext) {
    scheduleWakeup(script, `toolu_wakeup_${randomUUID()}`);
  }
  script.emit(result());
}

const HELD_WORK_IN_TURN = { heldWork: true, canHandOver: false, changes: [], switches: [] };

test('stopping a handed-over turn withdraws its unread inserts and reports them cancelled, through its own run', async () => {
  const held = await startHeldRun();
  const next = sendNext(held, 'Look at the tests');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(lifecycle(promptUuid(held, 1), 'started'));
    const insertId = randomUUID();
    assert.deepEqual(await claudeRuntime.insert(held.sessionId, { insertId, content: 'Only the unit tests' }), { accepted: true });
    await waitUntil(() => held.script.prompts.length === 3);

    const aborting = abortClaudeSDKSession(held.sessionId);
    await waitUntil(() => held.script.calls.includes('interrupt'));
    held.script.emit(interruptedResultFor(promptUuid(held, 1)));
    assert.equal(await aborting, true);
    assert.deepEqual(held.script.calls.filter((call) => !call.startsWith('prompt:')), [`cancel:${insertId}`, 'interrupt']);
    const statuses = next.writer.sent
      .filter((message) => message.kind === 'insert_status')
      .map((message) => [message.insertStatus, message.insertReason ?? null]);
    assert.deepEqual(statuses, [['pending', null], ['cancelled', 'ABORTED']]);
    assert.equal(held.script.released(), false, 'the workflow still holds the process');
  } finally {
    await finish(held, [next.run]);
  }
});

test('a handed-over prompt the CLI does not give back is taken to have started, and its turn is interrupted', async () => {
  const held = await startHeldRun(launchWorkflow, {}, { behaviour: { cancel: 'keep' } });
  const next = sendNext(held, 'Never mind');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    const aborting = abortClaudeSDKSession(held.sessionId);
    await waitUntil(() => held.script.calls.includes('interrupt'));
    held.script.emit(interruptedResultFor(promptUuid(held, 1)));
    assert.equal(await aborting, true);
    assert.deepEqual(held.script.calls.filter((call) => !call.startsWith('prompt:')), [`cancel:${promptUuid(held, 1)}`, 'interrupt']);
    assert.equal(held.script.released(), false);
    assert.deepEqual(listedTaskIds(held.sessionId), ['wf1']);
  } finally {
    await finish(held, [next.run]);
  }
});

test('a handed-over turn whose stop the CLI never answers is stopped whole: the process is closed after 5 s', async (t) => {
  const held = await startHeldRun(launchWorkflow, {}, { behaviour: { interrupt: 'hang' } });
  const next = sendNext(held, 'Go');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(echo(promptUuid(held, 1), 'Go'));
    await flush();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const aborting = abortClaudeSDKSession(held.sessionId);
    await waitUntil(() => held.script.calls.includes('interrupt'));
    t.mock.timers.tick(5 * 1000);
    assert.equal(await aborting, true);
    await waitUntil(() => held.script.calls.includes('close'));
    assert.equal(next.settled(), true);
    assert.equal(completes(next.writer.sent), 0, 'the abort\'s caller sends the terminal complete');
    // A closed process makes the session's next run wait 8 s.
    t.mock.timers.tick(8 * 1000);
  } finally {
    await finish(held, [next.run]);
  }
});

test('a turn that started a wake-up before it was stopped leaves the process held for that wake-up', async () => {
  const held = await startHeldRun();
  const next = sendNext(held, 'Keep checking every five minutes');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(echo(promptUuid(held, 1), 'Keep checking every five minutes'));
    scheduleWakeup(held.script);
    held.script.emit(toolUse('toolu_fg', 'Bash', { command: 'npm test' }));
    await flush();
    const aborting = abortClaudeSDKSession(held.sessionId);
    await waitUntil(() => held.script.calls.includes('interrupt'));
    held.script.emit(interruptedResultFor(promptUuid(held, 1)));
    assert.equal(await aborting, true);

    // The workflow finishes and is relayed; the wake-up is still to come.
    relayFinishedTask(held.script, 'wf1', 'toolu_wf');
    await flush();
    assert.equal(held.script.released(), false, 'held for the wake-up');
    assert.deepEqual(await claudeRuntime.planHandOver(held.sessionId, { cwd: held.cwd }), { heldWork: true, canHandOver: true, changes: [], switches: [] });
    fireWakeup(held.script);
    await flush();
    assert.equal(held.script.released(), true, 'the wake-up has run and set no other');
  } finally {
    await finish(held, [next.run]);
  }
});

test('a first turn that sets up a wake-up or a Monitor and goes on working counts as held work while it runs', async () => {
  for (const setUp of [scheduleWakeup, launchUntrackedMonitor, launchMonitor]) {
    const sessionId = `app-held-turn-${randomUUID()}`;
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-held-turn-'));
    const { createQuery, script } = createScriptedQuery();
    const firstRun = queryClaudeSDK('/loop 5m check CI', { sessionId, cwd }, createWriter(1).writer as never, { ...createContext(), createQuery });
    try {
      await waitUntil(() => script.prompts.length === 1);
      script.emit(init());
      script.emit(echo(String(script.prompts[0]?.uuid), '/loop 5m check CI'));
      await flush();
      assert.deepEqual(await claudeRuntime.planHandOver(sessionId, { cwd }), NOTHING_HELD, `${setUp.name}: nothing yet`);
      setUp(script);
      script.emit(toolUse('toolu_long', 'Bash', { command: 'npm test' }));
      await flush();
      assert.deepEqual(await claudeRuntime.planHandOver(sessionId, { cwd }), HELD_WORK_IN_TURN, setUp.name);
    } finally {
      script.end();
      await firstRun;
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test('a /loop turn that also backgrounded a command keeps its process held for the next wake-up once the command is done and relayed', async () => {
  const held = await startHeldRun(announcingPrompt((script) => {
    launchBackgroundCommand(script);
    scheduleWakeup(script);
  }));
  try {
    relayFinishedTask(held.script, 'bg1', 'toolu_bash');
    await flush();
    assert.equal(held.script.released(), false, 'the loop\'s next wake-up still needs the process');
    assert.equal(held.first.finishedReports(), 0, 'the loop goes on');
    assert.deepEqual(await claudeRuntime.planHandOver(held.sessionId, { cwd: held.cwd }), { heldWork: true, canHandOver: true, changes: [], switches: [] });

    // A wake-up that sets the next keeps it held, and nothing is reported finished.
    fireWakeup(held.script, true);
    await flush();
    assert.equal(held.script.released(), false);
    assert.equal(held.first.finishedReports(), 0);

    // One that sets none ends the loop.
    fireWakeup(held.script);
    await flush();
    assert.equal(held.script.released(), true);
    assert.equal(held.first.finishedReports(), 1);
  } finally {
    await finish(held);
  }
});

test('a relay of the loop\'s command that the CLI does not echo still counts as the command reporting back, not the wake-up', async () => {
  const held = await startHeldRun(announcingPrompt((script) => {
    launchBackgroundCommand(script);
    scheduleWakeup(script);
  }));
  try {
    held.script.emit(taskNotification('bg1', 'toolu_bash', 'completed'));
    held.script.emit(assistantText('bg1 is done.'));
    held.script.emit(relayResult());
    await flush();
    assert.equal(held.script.released(), false, 'the wake-up is still to come');
    fireWakeup(held.script);
    await flush();
    assert.equal(held.script.released(), true);
  } finally {
    await finish(held);
  }
});

test('stopping the loop\'s command, in its own turn or in one handed to its process, leaves the process held for the next wake-up', async () => {
  const loopWithCommand = announcingPrompt((script) => {
    launchBackgroundCommand(script);
    scheduleWakeup(script);
  });

  // Stopped while the process is held: no follow-up turn comes for a stopped task.
  const idle = await startHeldRun(loopWithCommand);
  try {
    assert.equal(await stopClaudeSDKTask(idle.sessionId, 'bg1'), true);
    idle.script.emit(taskNotification('bg1', 'toolu_bash', 'stopped'));
    await flush();
    assert.equal(idle.script.released(), false, 'the wake-up is still to come');
  } finally {
    await finish(idle);
  }

  // Stopped during the user's turn that went into the process.
  const held = await startHeldRun(loopWithCommand);
  const next = sendNext(held, 'Stop the build, then tell me the status');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(echo(promptUuid(held, 1), 'Stop the build, then tell me the status'));
    held.script.emit(taskNotification('bg1', 'toolu_bash', 'stopped'));
    held.script.emit(assistantText('Stopped the build.'));
    await flush();
    assert.deepEqual(await claudeRuntime.planHandOver(held.sessionId, { cwd: held.cwd }, INHERIT_UNSET), HELD_WORK_IN_TURN);
    held.script.emit(result());
    await waitUntil(() => next.settled());
    assert.equal(held.script.released(), false);
    assert.deepEqual(await claudeRuntime.planHandOver(held.sessionId, { cwd: held.cwd }), { heldWork: true, canHandOver: true, changes: [], switches: [] });
  } finally {
    await finish(held, [next.run]);
  }
});

test('a wake-up set in a turn whose long foreground command the CLI reports as a task still holds the process', async () => {
  // CLI 2.1.312 reports a foreground command that runs for a while as a task.
  const held = await startHeldRun((script) => {
    script.emit(toolUse('toolu_fg', 'Bash', { command: 'npm test' }));
    script.emit(taskStarted('fg1', 'toolu_fg', 'local_bash'));
    script.emit(taskNotification('fg1', 'toolu_fg', 'completed'));
    script.emit(toolResult('toolu_fg', 'ok'));
    scheduleWakeup(script);
  });
  try {
    assert.deepEqual(await claudeRuntime.planHandOver(held.sessionId, { cwd: held.cwd }), { heldWork: true, canHandOver: true, changes: [], switches: [] });
  } finally {
    await finish(held);
  }
});

test('a turn the CLI runs ahead of the handed-over prompt that starts a command and a wake-up keeps the process held for the wake-up', async () => {
  const held = await startHeldRun(announcingPrompt(scheduleWakeup));
  // The wake-up fires: its turn backgrounds a command and sets the next wake-up.
  held.script.emit(assistantText('Checking the build again.'));
  launchBackgroundCommand(held.script);
  scheduleWakeup(held.script, 'toolu_wakeup_2');
  await flush();
  const next = sendNext(held, 'What is the status?');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(result());
    held.script.emit(echo(promptUuid(held, 1), 'What is the status?'));
    held.script.emit(result());
    await waitUntil(() => next.settled());
    relayFinishedTask(held.script, 'bg1', 'toolu_bash');
    await flush();
    assert.equal(held.script.released(), false, 'the next wake-up still needs the process');
    assert.deepEqual([held.first.finishedReports(), next.writer.finishedReports()], [0, 0]);
  } finally {
    await finish(held, [next.run]);
  }
});

test('the loop\'s command relayed ahead of the handed-over turn reports nothing finished while the wake-up is still to come', async () => {
  const held = await startHeldRun(announcingPrompt((script) => {
    launchBackgroundCommand(script);
    scheduleWakeup(script);
  }));
  // The command finishes, and the CLI starts relaying it.
  held.script.emit(taskNotification('bg1', 'toolu_bash', 'completed'));
  held.script.emit(notificationEcho('bg1', 'toolu_bash'));
  held.script.emit(assistantText('The build is done.'));
  await flush();
  const next = sendNext(held, 'What is the status?');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(relayResult());
    await flush();
    assert.equal(held.first.finishedReports(), 0, 'the loop goes on');
    held.script.emit(echo(promptUuid(held, 1), 'What is the status?'));
    held.script.emit(result());
    await waitUntil(() => next.settled());
    assert.equal(held.script.released(), false, 'the wake-up still needs the process');
    fireWakeup(held.script);
    await flush();
    assert.equal(held.script.released(), true);
    assert.deepEqual([held.first.finishedReports(), next.writer.finishedReports()], [0, 1]);
  } finally {
    await finish(held, [next.run]);
  }
});

test('a turn whose ScheduleWakeup ends the loop lets its process go', async () => {
  const sessionId = `app-held-turn-${randomUUID()}`;
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-held-turn-'));
  const { createQuery, script } = createScriptedQuery();
  const first = createWriter(1);
  const firstRun = queryClaudeSDK('stop the loop', { sessionId, cwd }, first.writer as never, { ...createContext(), createQuery });
  try {
    await waitUntil(() => script.prompts.length === 1);
    script.emit(init());
    script.emit(toolUse('toolu_stop', 'ScheduleWakeup', { stop: true }));
    script.emit(toolResult('toolu_stop', 'Loop stopped'));
    script.emit(result());
    await waitUntil(() => completes(first.sent) === 1);
    await flush();
    assert.equal(script.released(), true, 'no wake-up is left to wait for');
  } finally {
    script.end();
    await firstRun;
    await rm(cwd, { recursive: true, force: true });
  }
});

/**
 * Runs a test with Claude's user settings file under a directory of its own
 * (CLAUDE_CONFIG_DIR, which the CLI reads too): `write` puts a settings file
 * there, given its settings or its bytes, or removes it given null.
 */
async function withUserSettings(runTest: (write: (settings: Record<string, unknown> | Buffer | null) => Promise<void>) => Promise<void>): Promise<void> {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-held-turn-config-'));
  process.env.CLAUDE_CONFIG_DIR = directory;
  const write = async (settings: Record<string, unknown> | Buffer | null) => {
    await rm(path.join(directory, 'settings.json'), { force: true });
    if (settings) {
      await writeFile(path.join(directory, 'settings.json'), Buffer.isBuffer(settings) ? settings : JSON.stringify(settings));
    }
  };
  try {
    await runTest(write);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previous;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

/** Writes, or with null removes, one of a project's own Claude settings files: its settings, its text or its bytes. */
async function writeProjectSettings(cwd: string, file: 'settings.json' | 'settings.local.json', content: Record<string, unknown> | string | Buffer | null): Promise<void> {
  await mkdir(path.join(cwd, '.claude'), { recursive: true });
  await rm(path.join(cwd, '.claude', file), { force: true });
  if (content !== null) {
    await writeFile(path.join(cwd, '.claude', file), typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content));
  }
}

test('a process launched with no ultracode choice runs with the settings file\'s: switching it to a model with ultracode off is a change', async () => {
  await withUserSettings(async (write) => {
    await write({ ultracode: true });
    // The default model gets no ultracode choice, so the process runs with the file's.
    const held = await startHeldRun(launchWorkflow, { model: 'default', effort: 'high' });
    const laterRuns: Array<Promise<unknown>> = [];
    try {
      const plan = (options: Record<string, unknown>) => claudeRuntime.planHandOver(held.sessionId, { cwd: held.cwd, effort: 'high', ...options });
      assert.deepEqual(await plan({ model: 'opus', ultracode: false }), { heldWork: true, canHandOver: false, changes: ['ultracode'], switches: ['model'] });
      assert.deepEqual(await plan({ model: 'opus', ultracode: true }), { heldWork: true, canHandOver: true, changes: [], switches: ['model'] });

      const next = sendNext(held, 'With ultracode off', { model: 'opus', effort: 'high', ultracode: false });
      laterRuns.push(next.run);
      await waitUntil(() => held.script.released());
      assert.deepEqual(workStoppedNotices(next.writer.sent).map((notice) => notice.slice(0, 2)), [['BACKGROUND_WORK_STOPPED', ['ultracode']]]);
      assert.equal(held.script.prompts.length, 1, 'nothing goes into the process');
      held.script.end();
      await waitUntil(() => next.later.script.created());
    } finally {
      await finish(held, laterRuns);
    }
  });
});

test('a turn that makes no ultracode choice is weighed against what a new process would read from the settings files', async () => {
  await withUserSettings(async (write) => {
    await write(null);
    const held = await startHeldRun(launchWorkflow, { model: 'opus', effort: 'high', ultracode: true });
    try {
      const plan = () => claudeRuntime.planHandOver(held.sessionId, { cwd: held.cwd, model: 'default', effort: 'high' });
      assert.deepEqual(await plan(), { heldWork: true, canHandOver: false, changes: ['ultracode'], switches: ['model'] }, 'a new process would run with it off');
      await write({ ultracode: true });
      assert.deepEqual(await plan(), { heldWork: true, canHandOver: true, changes: [], switches: ['model'] }, 'as the process does');
    } finally {
      await finish(held);
    }
  });
});

test('the settings files are read in Claude Code\'s order, the project\'s over the user\'s and its local file over both, and a file that does not parse is skipped', async () => {
  await withUserSettings(async (write) => {
    await write(null);
    const held = await startHeldRun(launchWorkflow, { model: 'opus', effort: 'high', ultracode: false });
    try {
      const fileValueKeepsTheTurnOut = async () => (await claudeRuntime.planHandOver(held.sessionId, { cwd: held.cwd, model: 'default', effort: 'high' })).changes.includes('ultracode');
      await write({ ultracode: true });
      assert.equal(await fileValueKeepsTheTurnOut(), true, 'the user\'s file turns it on');
      await writeProjectSettings(held.cwd, 'settings.json', { ultracode: false });
      assert.equal(await fileValueKeepsTheTurnOut(), false, 'the project\'s turns it off again');
      await writeProjectSettings(held.cwd, 'settings.local.json', { ultracode: true });
      assert.equal(await fileValueKeepsTheTurnOut(), true, 'the local file wins over both');
      await writeProjectSettings(held.cwd, 'settings.local.json', '{ not json');
      assert.equal(await fileValueKeepsTheTurnOut(), false, 'a broken local file is skipped');
      await writeProjectSettings(held.cwd, 'settings.json', { ultracode: 'false' });
      assert.equal(await fileValueKeepsTheTurnOut(), true, 'and so is a value that is not a boolean');
    } finally {
      await finish(held);
    }
  });
});

test('a plan or a turn that inherits unset settings takes ultracode from the live process', async () => {
  await withUserSettings(async (write) => {
    await write(null);
    const held = await startHeldRun(announcingPrompt(scheduleWakeup), { ...SCHEDULED_OPTIONS, model: 'opus', ultracode: true });
    const laterRuns: Array<Promise<unknown>> = [];
    try {
      const options = { sessionId: held.sessionId, cwd: held.cwd, ...SCHEDULED_OPTIONS, model: 'opus' };
      assert.deepEqual(await claudeRuntime.planHandOver(held.sessionId, options, INHERIT_UNSET), { heldWork: true, canHandOver: true, changes: [], switches: [] });
      assert.deepEqual(await claudeRuntime.planHandOver(held.sessionId, options), { heldWork: true, canHandOver: false, changes: ['ultracode'], switches: [] }, 'read as it is, a new process would run it off');
      const next = sendNext(held, 'Post a summary', { ...SCHEDULED_OPTIONS, model: 'opus', inheritUnset: true });
      laterRuns.push(next.run);
      await waitUntil(() => held.script.prompts.length === 2);
      assert.equal(next.later.script.created(), false, 'no second CLI is started');
    } finally {
      await finish(held, laterRuns);
    }
  });
});

const RESTORE = { restoreSwitchesAfterTurn: true };

/** The model and permission mode switches the CLI got, in order. */
const switchCalls = (held: HeldRun) => held.script.calls.filter((call) => call.startsWith('set'));

test('a turn handed over with restoreSwitchesAfterTurn runs with its own model and permission mode, and the process is switched back once its result is in', async () => {
  // A loop launched with permissions skipped, in bypassPermissions.
  const held = await startHeldRun(announcingPrompt(scheduleWakeup), { ...SCHEDULED_OPTIONS, ...toolsSettings([], [], true) });
  const canUseTool = held.script.options()?.canUseTool as CanUseTool;
  const next = sendNext(held, 'Summarise with Opus, asking first', { ...SCHEDULED_OPTIONS, model: 'opus', permissionMode: 'default', toolsSettings: { skipPermissions: false }, ...INHERIT_UNSET, ...RESTORE });
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    const calls = held.script.calls.filter((call) => call !== `prompt:${promptUuid(held, 0)}`);
    assert.deepEqual(calls, ['setModel:opus', 'setPermissionMode:default', `prompt:${promptUuid(held, 1)}`], 'the CLI is idle: switched, then the prompt');
    await flush();
    held.script.emit(echo(promptUuid(held, 1), 'Summarise with Opus, asking first'));
    void canUseTool('Bash', { command: 'rm -rf build' }, {});
    await flush();
    const requests = next.writer.sent.filter((message) => message.kind === 'permission_request');
    assert.equal(requests.length, 1, 'the turn asks, in its own permission mode');
    claudeRuntime.permissions.resolve(String(requests[0]?.requestId), { allow: false });
    held.script.emit(result());
    await waitUntil(() => next.settled());
    await flush();
    assert.deepEqual(switchCalls(held), ['setModel:opus', 'setPermissionMode:default', 'setModel:sonnet', 'setPermissionMode:bypassPermissions']);
    assert.equal(held.script.released(), false, 'the loop still holds the process');
    assert.equal((await canUseTool('Bash', { command: 'kubectl get pods' }, {})).behavior, 'allow', 'the loop runs as before');
    assert.deepEqual(
      await claudeRuntime.planHandOver(held.sessionId, { sessionId: held.sessionId, cwd: held.cwd, ...SCHEDULED_OPTIONS }, INHERIT_UNSET),
      { heldWork: true, canHandOver: true, changes: [], switches: [] },
      'the process runs with what it had',
    );
  } finally {
    await finish(held, [next.run]);
  }
});

test('a turn handed over with restoreSwitchesAfterTurn while the CLI runs a turn of its own switches and writes nothing until that turn is over', async () => {
  const held = await startHeldRun(announcingPrompt(scheduleWakeup), SCHEDULED_OPTIONS);
  // The wake-up fires: the CLI runs a turn of its own.
  held.script.emit(lifecycle(randomUUID(), 'started'));
  held.script.emit(assistantText('Checking the build again.'));
  await flush();
  const next = sendNext(held, 'Post a summary', { ...SCHEDULED_OPTIONS, model: 'opus', ...INHERIT_UNSET, ...RESTORE });
  try {
    await waitUntil(() => held.first.handOverReports() === 1);
    assert.equal(next.later.script.created(), false, 'it goes into the held process');
    assert.deepEqual(switchCalls(held), [], 'the wake-up runs with the loop\'s model');
    assert.equal(held.script.prompts.length, 1);

    scheduleWakeup(held.script, 'toolu_wakeup_2');
    held.script.emit(result());
    await waitUntil(() => held.script.prompts.length === 2);
    const calls = held.script.calls.filter((call) => call !== `prompt:${promptUuid(held, 0)}`);
    assert.deepEqual(calls, ['setModel:opus', `prompt:${promptUuid(held, 1)}`]);
    assert.equal(completes(next.writer.sent), 0, 'the wake-up\'s turn is not the handed-over one');

    held.script.emit(echo(promptUuid(held, 1), 'Post a summary'));
    held.script.emit(result());
    await waitUntil(() => next.settled());
    await flush();
    assert.deepEqual(switchCalls(held), ['setModel:opus', 'setModel:sonnet']);
    assert.equal(held.script.released(), false, 'the next wake-up still holds the process');
  } finally {
    await finish(held, [next.run]);
  }
});

test('a turn handed over with restoreSwitchesAfterTurn that the user stops is switched back too, and one stopped before it was written sends nothing', async () => {
  const held = await startHeldRun(announcingPrompt(scheduleWakeup), SCHEDULED_OPTIONS);
  const restored: unknown[] = [];
  const next = sendNext(held, 'Post a summary', {
    ...SCHEDULED_OPTIONS, model: 'opus', ...INHERIT_UNSET, ...RESTORE,
    onSwitchesRestored: (switchedBack: unknown) => { restored.push(switchedBack); },
  });
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(echo(promptUuid(held, 1), 'Post a summary'));
    await flush();
    const aborting = abortClaudeSDKSession(held.sessionId);
    await waitUntil(() => held.script.calls.includes('interrupt'));
    held.script.emit(interruptedResultFor(promptUuid(held, 1)));
    assert.equal(await aborting, true);
    await flush();
    assert.deepEqual(held.script.calls.filter((call) => !call.startsWith('prompt:')), ['setModel:opus', 'interrupt', 'setModel:sonnet']);
    assert.deepEqual(restored, [{ model: 'sonnet', permissionMode: null }], 'its onSwitchesRestored hears it');
    assert.equal(held.script.released(), false);
  } finally {
    await finish(held, [next.run]);
  }

  const waiting = await startHeldRun(announcingPrompt(scheduleWakeup), SCHEDULED_OPTIONS);
  // The wake-up fires, and the message waits for its turn to end.
  waiting.script.emit(lifecycle(randomUUID(), 'started'));
  await flush();
  const stopped = sendNext(waiting, 'Post a summary', { ...SCHEDULED_OPTIONS, model: 'opus', ...INHERIT_UNSET, ...RESTORE });
  try {
    await waitUntil(() => waiting.first.handOverReports() === 1);
    assert.equal(await abortClaudeSDKSession(waiting.sessionId), true);
    await waitUntil(() => stopped.settled());
    assert.deepEqual(waiting.script.calls.filter((call) => call !== `prompt:${promptUuid(waiting, 0)}`), [], 'no switch, no prompt, no interrupt of the wake-up');
    waiting.script.emit(result());
    await flush();
    assert.equal(waiting.script.released(), true, 'the wake-up has run and set no other');
  } finally {
    await finish(waiting, [stopped.run]);
  }
});

test('a turn handed over with restoreSwitchesAfterTurn whose process lets go at its end is not switched back', async () => {
  const held = await startHeldRun(announcingPrompt(scheduleWakeup), SCHEDULED_OPTIONS);
  const next = sendNext(held, 'Post a summary', { ...SCHEDULED_OPTIONS, model: 'opus', ...INHERIT_UNSET, ...RESTORE });
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    // The wake-up runs ahead of the message and sets no other.
    held.script.emit(lifecycle(randomUUID(), 'started'));
    held.script.emit(result());
    held.script.emit(echo(promptUuid(held, 1), 'Post a summary'));
    held.script.emit(result());
    await waitUntil(() => next.settled());
    await flush();
    assert.equal(held.script.released(), true, 'nothing is left to hold the process for');
    assert.deepEqual(switchCalls(held), ['setModel:opus']);
  } finally {
    await finish(held, [next.run]);
  }
});

test('a turn with restoreSwitchesAfterTurn that needs a process of its own never calls its onSwitchesRestored', async () => {
  const held = await startHeldRun(announcingPrompt(scheduleWakeup), SCHEDULED_OPTIONS);
  const restored: unknown[] = [];
  const next = sendNext(held, 'Post a summary', {
    ...SCHEDULED_OPTIONS, model: 'opus', effort: 'max', ...INHERIT_UNSET, ...RESTORE,
    onSwitchesRestored: (switchedBack: unknown) => { restored.push(switchedBack); },
  });
  try {
    await waitUntil(() => held.script.released());
    held.script.end();
    await waitUntil(() => next.later.script.prompts.length === 1);
    next.later.script.emit(init());
    next.later.script.emit(result());
    await waitUntil(() => completes(next.writer.sent) === 1);
    await flush();
    assert.deepEqual(switchCalls(held), []);
    assert.deepEqual(restored, []);
  } finally {
    await finish(held, [next.run]);
  }
});

test('the hand-over plan reads a turn handed over with restoreSwitchesAfterTurn as any other', async () => {
  const held = await startHeldRun(announcingPrompt(scheduleWakeup), SCHEDULED_OPTIONS);
  try {
    const options = { sessionId: held.sessionId, cwd: held.cwd, ...SCHEDULED_OPTIONS, ...RESTORE };
    assert.deepEqual(await claudeRuntime.planHandOver(held.sessionId, { ...options, model: 'opus', permissionMode: 'acceptEdits' }, INHERIT_UNSET), { heldWork: true, canHandOver: true, changes: [], switches: ['model', 'permissionMode'] });
    assert.deepEqual(await claudeRuntime.planHandOver(held.sessionId, { ...options, effort: 'max' }, INHERIT_UNSET), { heldWork: true, canHandOver: false, changes: ['effort'], switches: [] });
    assert.deepEqual(held.script.calls, [`prompt:${promptUuid(held, 0)}`], 'nothing was written or switched');
  } finally {
    await finish(held);
  }
});

// ---------------------------------------------------------------------------
// Work no task event reports, and a Monitor, as CLI 2.1.312 reports them.
// ---------------------------------------------------------------------------

/**
 * A ScheduleWakeup and its result as CLI 2.1.312 writes it: the time the
 * wake-up fires (`scheduledFor`, rounded up to the minute) in the output it
 * adds to the result's message.
 */
function armWakeup(script: Scripted, scheduledFor: number, delaySeconds: number, id = `toolu_wakeup_${randomUUID()}`): void {
  script.emit(toolUse(id, 'ScheduleWakeup', { delaySeconds, prompt: '/loop check the build', reason: 'polling' }));
  script.emit({
    ...toolResult(id, `Next wakeup scheduled (in ${Math.round((scheduledFor - Date.now()) / 1000)}s).`),
    tool_use_result: { scheduledFor, clampedDelaySeconds: delaySeconds, wasClamped: false },
  });
}

/** A ScheduleWakeup that ends the loop, and its result. */
function stopLoop(script: Scripted, id = `toolu_stop_${randomUUID()}`): void {
  script.emit(toolUse(id, 'ScheduleWakeup', { stop: true }));
  script.emit({
    ...toolResult(id, 'Loop stopped — cancelled 1 pending wakeup(s); no further dynamic-loop wakeups scheduled.'),
    tool_use_result: { scheduledFor: 0, clampedDelaySeconds: 0, wasClamped: false, stopped: true, cancelledWakeups: 1 },
  });
}

/** CLI 2.1.312 fires the wake-up set for `scheduledFor` (`loop_wakeup`) and runs its turn. */
function fireLoopWakeup(script: Scripted, scheduledFor: number, turn: () => void = () => {}): void {
  script.emit(lifecycle(randomUUID(), 'started', { wakeup_source: 'loop_wakeup', scheduled_for: scheduledFor }));
  script.emit(init());
  script.emit(assistantText('Checking again.'));
  turn();
  script.emit(result());
}

/**
 * A CronCreate and its result as CLI 2.1.312 writes them; `output: false`
 * leaves out the output it adds to the result's message, as an older CLI
 * may. `omitRecurring` leaves the call's choice out: a job recurs by default.
 * `nextFireAt` is when the job fires next (five minutes from now by default,
 * which is not when the CLI's defaults would fire a `*\/5` job: the run then
 * knows its time until its first fire only).
 */
function createCronJob(
  script: Scripted,
  jobId: string,
  { recurring = true, omitRecurring = false, output = true, nextFireAt = Date.now() + 5 * MINUTE, cron = '*/5 * * * *', durable = false }: { recurring?: boolean; omitRecurring?: boolean; output?: boolean; nextFireAt?: number; cron?: string; durable?: boolean } = {},
): void {
  const id = `toolu_cron_${jobId}`;
  const recurs = omitRecurring || recurring;
  script.emit(toolUse(id, 'CronCreate', { cron, prompt: 'check the deploy', ...(omitRecurring ? {} : { recurring }), ...(durable ? { durable } : {}) }));
  const text = recurs
    ? `Scheduled recurring job ${jobId} (Every 5 minutes). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner.`
    : `Scheduled one-shot task ${jobId} (at 2:30pm). Session-only (not written to disk, dies when Claude exits). It will fire once then auto-delete.`;
  script.emit({
    ...toolResult(id, text),
    ...(output ? { tool_use_result: { id: jobId, humanSchedule: 'Every 5 minutes', recurring: recurs, durable, nextFireAt } } : {}),
  });
}

/** A CronDelete of a job, and its result. */
function deleteCronJob(script: Scripted, jobId: string): void {
  const id = `toolu_cron_delete_${randomUUID()}`;
  script.emit(toolUse(id, 'CronDelete', { id: jobId }));
  script.emit({ ...toolResult(id, `Cancelled job ${jobId}.`), tool_use_result: { id: jobId } });
}

/** CLI 2.1.312 fires a cron job (`schedule_wakeup`) and runs its turn, whose result names no prompt. */
function fireCronJob(script: Scripted, turn: () => void = () => {}): void {
  script.emit(lifecycle(randomUUID(), 'started', { wakeup_source: 'schedule_wakeup' }));
  script.emit(init());
  script.emit(assistantText('The deploy is healthy.'));
  turn();
  script.emit(result());
}

/** Sends the session's next message and runs its turn in the held process, which `turn` fills in. */
async function runHandedOverTurn(held: HeldRun, text: string, turn: () => void, runOptions: Record<string, unknown> = {}) {
  const next = sendNext(held, text, runOptions);
  const index = held.script.prompts.length;
  await waitUntil(() => held.script.prompts.length === index + 1);
  held.script.emit(echo(promptUuid(held, index), text));
  turn();
  held.script.emit(resultFor([promptUuid(held, index)]));
  await waitUntil(() => next.settled());
  await flush();
  return next;
}

const STILL_HELD = { heldWork: true, canHandOver: true, changes: [], switches: [] };

test('a Monitor the CLI reports as a task lets its process go, and reports the work done, once its source ends and the CLI runs a turn for it', async () => {
  const held = await startHeldRun(announcingPrompt(launchMonitor));
  try {
    assert.deepEqual(listedTaskIds(held.sessionId), ['mon1']);
    endMonitor(held.script);
    await flush();
    assert.equal(held.script.released(), true);
    assert.equal(held.first.finishedReports(), 1);
    assert.deepEqual(await claudeRuntime.planHandOver(held.sessionId, { cwd: held.cwd, effort: 'max' }), NOTHING_HELD);
  } finally {
    await finish(held);
  }
});

test('a Monitor that fired an event keeps its process held until its source ends', async () => {
  const held = await startHeldRun(announcingPrompt(launchMonitor));
  try {
    // An event while it runs: a turn of its own, with no task event and no echo.
    held.script.emit(init());
    held.script.emit(assistantText('First event.'));
    held.script.emit(relayResult());
    await flush();
    assert.equal(held.script.released(), false);
    assert.equal(held.first.finishedReports(), 0);
    endMonitor(held.script);
    await flush();
    assert.equal(held.script.released(), true);
    assert.equal(held.first.finishedReports(), 1);
  } finally {
    await finish(held);
  }
});

test('a Monitor the user stops, or a handed-over turn stops with TaskStop, lets its process go', async () => {
  const idle = await startHeldRun(announcingPrompt(launchMonitor));
  try {
    assert.equal(await stopClaudeSDKTask(idle.sessionId, 'mon1'), true);
    idle.script.emit(taskUpdated('mon1', 'killed'));
    idle.script.emit(taskNotification('mon1', 'toolu_monitor', 'stopped'));
    await flush();
    assert.equal(idle.script.released(), true, 'no turn follows a stop, so the stop lets the process go');
  } finally {
    await finish(idle);
  }

  const held = await startHeldRun(announcingPrompt(launchMonitor));
  const runs: Array<Promise<unknown>> = [];
  try {
    const next = await runHandedOverTurn(held, 'Stop watching', () => {
      held.script.emit(toolUse('toolu_stop', 'TaskStop', { task_id: 'mon1' }));
      held.script.emit(taskUpdated('mon1', 'killed'));
      held.script.emit(taskNotification('mon1', 'toolu_monitor', 'stopped'));
      held.script.emit(toolResult('toolu_stop', 'Stopped task mon1'));
    });
    runs.push(next.run);
    assert.equal(held.script.released(), true, 'nothing is left to hold the process for');
    assert.deepEqual([held.first.finishedReports(), next.writer.finishedReports()], [0, 0]);
  } finally {
    await finish(held, runs);
  }
});

test('a Monitor that has ended holds nothing more: a command a later turn backgrounded lets the process go once it is relayed', async () => {
  const held = await startHeldRun(announcingPrompt(launchMonitor));
  const runs: Array<Promise<unknown>> = [];
  try {
    const next = await runHandedOverTurn(held, 'Build it in the background', () => launchBackgroundCommand(held.script));
    runs.push(next.run);
    endMonitor(held.script);
    await flush();
    assert.equal(held.script.released(), false, 'the command still runs');
    relayFinishedTask(held.script, 'bg1', 'toolu_bash');
    await flush();
    assert.equal(held.script.released(), true);
    assert.deepEqual([held.first.finishedReports(), next.writer.finishedReports()], [0, 1]);
  } finally {
    await finish(held, runs);
  }
});

test('a Monitor\'s turns leave a pending wake-up held: only its own fire takes it', async () => {
  const scheduledFor = Date.now() + 20 * MINUTE;
  const held = await startHeldRun(announcingPrompt((script) => {
    launchMonitor(script);
    armWakeup(script, scheduledFor, 1200);
  }));
  try {
    // An event of the Monitor's, then its end: turns the CLI runs for it.
    held.script.emit(init());
    held.script.emit(assistantText('First event.'));
    held.script.emit(relayResult());
    endMonitor(held.script);
    await flush();
    assert.equal(held.script.released(), false, 'the wake-up is still to come');
    assert.equal(held.first.finishedReports(), 0);
    fireLoopWakeup(held.script, scheduledFor);
    await flush();
    assert.equal(held.script.released(), true);
    assert.equal(held.first.finishedReports(), 1);
  } finally {
    await finish(held);
  }
});

test('a recurring CronCreate job keeps its process held through its fires, and nothing is reported finished', async () => {
  const cases: Array<[string, { omitRecurring?: boolean; output?: boolean }]> = [
    ['recurring', {}],
    ['recurring by default', { omitRecurring: true }],
    ['recurring by default, from a result with no output', { omitRecurring: true, output: false }],
  ];
  for (const [label, job] of cases) {
    const held = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'job1', job)));
    try {
      fireCronJob(held.script);
      await flush();
      assert.equal(held.script.released(), false, `${label}: after the first fire`);
      fireCronJob(held.script);
      await flush();
      assert.equal(held.script.released(), false, `${label}: after the second fire`);
      assert.equal(held.first.finishedReports(), 0, label);
      assert.deepEqual(await claudeRuntime.planHandOver(held.sessionId, { cwd: held.cwd }), STILL_HELD, label);
    } finally {
      await finish(held);
    }
  }
});

test('a one-shot CronCreate job lets its process go once it has fired, and the work is reported done once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  for (const output of [true, false]) {
    const held = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'once1', { recurring: false, output })));
    try {
      // It fires five minutes on, as its result said.
      t.mock.timers.tick(5 * MINUTE);
      fireCronJob(held.script);
      await flush();
      assert.equal(held.script.released(), true, `output ${output}`);
      assert.equal(held.first.finishedReports(), 1, `output ${output}`);
    } finally {
      await finish(held);
    }
  }
});

test('a cron fire with no one-shot job due takes none: a recurring job\'s fire, then its deletion, leave the process held for a one-shot job still to come', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const held = await startHeldRun(announcingPrompt((script) => {
    createCronJob(script, 'rec1', { nextFireAt: Date.now() + MINUTE });
    createCronJob(script, 'once1', { recurring: false, nextFireAt: Date.now() + 30 * MINUTE });
  }));
  const runs: Array<Promise<unknown>> = [];
  try {
    t.mock.timers.tick(MINUTE);
    fireCronJob(held.script);
    await flush();
    const next = await runHandedOverTurn(held, 'Stop the loop, keep the reminder', () => deleteCronJob(held.script, 'rec1'));
    runs.push(next.run);
    assert.equal(held.script.released(), false, 'the reminder is still to come');
    assert.deepEqual(await claudeRuntime.planHandOver(held.sessionId, { cwd: held.cwd }), STILL_HELD);
    assert.deepEqual([held.first.finishedReports(), next.writer.finishedReports()], [0, 0]);
    // The reminder fires at its time.
    t.mock.timers.tick(29 * MINUTE);
    fireCronJob(held.script);
    await flush();
    assert.equal(held.script.released(), true);
    assert.deepEqual([held.first.finishedReports(), next.writer.finishedReports()], [0, 1]);
  } finally {
    await finish(held, runs);
  }
});

test('a one-shot job that comes due while a recurring job\'s fire runs is not taken for that fire, even one that deletes the recurring job', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const held = await startHeldRun(announcingPrompt((script) => {
    createCronJob(script, 'rec1', { nextFireAt: Date.now() + MINUTE });
    createCronJob(script, 'once1', { recurring: false, nextFireAt: Date.now() + 3 * MINUTE });
  }));
  try {
    t.mock.timers.tick(MINUTE);
    held.script.emit(lifecycle(randomUUID(), 'started', { wakeup_source: 'schedule_wakeup' }));
    held.script.emit(init());
    held.script.emit(assistantText('The deploy is done: the loop can stop.'));
    await flush();
    // The fire's turn runs past the reminder's time, which the CLI fires once it is over.
    t.mock.timers.tick(5 * MINUTE);
    deleteCronJob(held.script, 'rec1');
    held.script.emit(result());
    await flush();
    assert.equal(held.script.released(), false, 'the reminder\'s fire is still to come');
    assert.equal(held.first.finishedReports(), 0);
    fireCronJob(held.script);
    await flush();
    assert.equal(held.script.released(), true);
    assert.equal(held.first.finishedReports(), 1);
  } finally {
    await finish(held);
  }
});

test('a fire takes only a one-shot job due by the time it started: one of a job the run did not see created, or one ahead of the job\'s time, takes none and reports nothing finished', async () => {
  const later = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'once1', { recurring: false, nextFireAt: Date.now() + 30 * MINUTE })));
  try {
    // A job an earlier process saved, or the CLI's notice of missed jobs.
    fireCronJob(later.script);
    await flush();
    assert.equal(later.script.released(), false);
    assert.equal(later.first.finishedReports(), 0);
    assert.deepEqual(await claudeRuntime.planHandOver(later.sessionId, { cwd: later.cwd }), STILL_HELD);
  } finally {
    await finish(later);
  }

  // The CLI never fires a one-shot job ahead of its time: a fire a minute
  // before it, such as a recurring job's, is another job's.
  const ahead = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'once1', { recurring: false, nextFireAt: Date.now() + 50 * 1000 })));
  try {
    fireCronJob(ahead.script);
    await flush();
    assert.equal(ahead.script.released(), false);
    assert.equal(ahead.first.finishedReports(), 0);
  } finally {
    await finish(ahead);
  }

  const due = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'once1', { recurring: false, nextFireAt: Date.now() - 1000 })));
  try {
    fireCronJob(due.script);
    await flush();
    assert.equal(due.script.released(), true);
    assert.equal(due.first.finishedReports(), 1);
  } finally {
    await finish(due);
  }
});

test('from a CLI that names no fire, a turn of its own takes only the one-shot jobs due by then', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const held = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'once1', { recurring: false, nextFireAt: Date.now() + 30 * MINUTE })));
  const ownTurn = () => {
    held.script.emit(init());
    held.script.emit(assistantText('The deploy is healthy.'));
    held.script.emit(result());
  };
  try {
    ownTurn();
    await flush();
    assert.equal(held.script.released(), false, 'the job is still to come');
    assert.equal(held.first.finishedReports(), 0);
    t.mock.timers.tick(30 * MINUTE);
    ownTurn();
    await flush();
    assert.equal(held.script.released(), true);
    assert.equal(held.first.finishedReports(), 1);
  } finally {
    await finish(held);
  }
});

test('a CronDelete of the last job lets the process go: in a fire\'s turn the work is reported done, in a handed-over turn nothing is', async () => {
  const firing = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'job1')));
  try {
    fireCronJob(firing.script, () => deleteCronJob(firing.script, 'job1'));
    await flush();
    assert.equal(firing.script.released(), true);
    assert.equal(firing.first.finishedReports(), 1);
  } finally {
    await finish(firing);
  }

  const held = await startHeldRun(announcingPrompt((script) => {
    createCronJob(script, 'job1');
    createCronJob(script, 'job2');
  }));
  const runs: Array<Promise<unknown>> = [];
  try {
    const first = await runHandedOverTurn(held, 'Cancel the first job', () => deleteCronJob(held.script, 'job1'));
    runs.push(first.run);
    assert.equal(held.script.released(), false, 'the other job still needs the process');
    const last = await runHandedOverTurn(held, 'And the other one', () => deleteCronJob(held.script, 'job2'));
    runs.push(last.run);
    assert.equal(held.script.released(), true);
    assert.deepEqual([held.first.finishedReports(), first.writer.finishedReports(), last.writer.finishedReports()], [0, 0, 0]);
  } finally {
    await finish(held, runs);
  }
});

test('a recurring job firing ahead of a handed-over prompt still holds the process after that turn, and nothing is reported finished', async () => {
  const held = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'job1')));
  const next = sendNext(held, 'What changed?');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    fireCronJob(held.script);
    held.script.emit(echo(promptUuid(held, 1), 'What changed?'));
    held.script.emit(resultFor([promptUuid(held, 1)]));
    await waitUntil(() => next.settled());
    await flush();
    assert.equal(completes(next.writer.sent), 1);
    assert.equal(held.script.released(), false, 'the job fires again');
    assert.deepEqual([held.first.finishedReports(), next.writer.finishedReports()], [0, 0]);
  } finally {
    await finish(held, [next.run]);
  }
});

test('a CronCreate the CLI refused holds nothing', async () => {
  const held = await startHeldRun(announcingPrompt((script) => {
    launchWorkflow(script);
    script.emit(toolUse('toolu_cron', 'CronCreate', { cron: 'every day', prompt: 'check the deploy' }));
    const refusal = toolResult('toolu_cron', 'Invalid cron expression');
    script.emit({ ...refusal, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_cron', content: 'Invalid cron expression', is_error: true }] } });
  }));
  try {
    relayFinishedTask(held.script, 'wf1', 'toolu_wf');
    await flush();
    assert.equal(held.script.released(), true, 'the workflow was all there was');
    assert.equal(held.first.finishedReports(), 1);
  } finally {
    await finish(held);
  }
});

test('a recurring job that fires keeps its process through HOLD_IDLE of silence between fires; one whose result named no time is held for HOLD_MAX from its creation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  // Hourly, on the hour: the job's id puts no lag on its fires.
  let nextFireAt = 0;
  const hourly = await startHeldRun(announcingPrompt((script) => {
    nextFireAt = nextScheduledFire({ cron: '0 * * * *', recurring: true, id: '00000000', createdAt: Date.now() }) as number;
    createCronJob(script, '00000000', { cron: '0 * * * *', nextFireAt });
  }));
  try {
    for (let fire = 1; fire <= 3; fire += 1) {
      t.mock.timers.tick(nextFireAt - Date.now());
      await flush();
      assert.equal(hourly.script.released(), false, `before fire ${fire}`);
      fireCronJob(hourly.script);
      await flush();
      nextFireAt = scheduledOf(hourly.sessionId)[0]?.nextFireAt as number;
      assert.equal(nextFireAt - Date.now(), 60 * MINUTE, `the next fire counts from fire ${fire}`);
    }
    assert.equal(hourly.first.finishedReports(), 0);
  } finally {
    await finish(hourly);
  }

  const untimed = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'job1', { output: false })));
  try {
    assert.equal(scheduledOf(untimed.sessionId)[0]?.nextFireAt, null);
    t.mock.timers.tick(HOLD_IDLE_MS + MINUTE);
    await flush();
    assert.equal(untimed.script.released(), false, 'silence says nothing about it');
    t.mock.timers.tick(12 * 60 * MINUTE);
    await flush();
    assert.equal(untimed.script.released(), true);
    assert.deepEqual(untimed.script.calls.filter((call) => !call.startsWith('prompt:')), ['release'], 'there is no task to stop');
    assert.equal(untimed.first.finishedReports(), 0);
  } finally {
    await finish(untimed);
  }
});

test('a one-shot job due past HOLD_IDLE keeps its process held until it fires, and one that never fires lets it go past its time, reporting nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  for (const fires of [true, false]) {
    let nextFireAt = 0;
    const held = await startHeldRun(announcingPrompt((script) => {
      nextFireAt = Date.now() + 2 * 60 * MINUTE;
      createCronJob(script, 'once1', { recurring: false, nextFireAt });
    }));
    try {
      t.mock.timers.tick(HOLD_IDLE_MS + MINUTE);
      await flush();
      assert.equal(held.script.released(), false, `fires ${fires}: the job is still to come`);
      if (fires) {
        t.mock.timers.tick(nextFireAt - Date.now());
        fireCronJob(held.script);
        await flush();
        assert.equal(held.script.released(), true);
        assert.equal(held.first.finishedReports(), 1);
        continue;
      }
      // The CLI sends nothing for a fire that never starts.
      t.mock.timers.tick(nextFireAt + 5 * MINUTE - Date.now() - 1);
      await flush();
      assert.equal(held.script.released(), false);
      t.mock.timers.tick(1);
      await flush();
      assert.equal(held.script.released(), true);
      assert.equal(held.first.finishedReports(), 0);
    } finally {
      await finish(held);
    }
  }
});

test('a wake-up or a one-shot job that never fired does not cut short the hold for a one-shot job due later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const earlier: Array<[string, (script: Scripted) => void]> = [
    ['a wake-up', (script) => armWakeup(script, Date.now() + 10 * MINUTE, 600)],
    ['a one-shot job', (script) => createCronJob(script, 'once0', { recurring: false, nextFireAt: Date.now() + 10 * MINUTE })],
  ];
  for (const [label, arm] of earlier) {
    let nextFireAt = 0;
    const held = await startHeldRun(announcingPrompt((script) => {
      arm(script);
      nextFireAt = Date.now() + 2 * 60 * MINUTE;
      createCronJob(script, 'once1', { recurring: false, nextFireAt });
    }));
    try {
      // The CLI sends nothing for the earlier fire, which never starts.
      t.mock.timers.tick(HOLD_IDLE_MS + MINUTE);
      await flush();
      assert.equal(held.script.released(), false, `${label}: the later job is still to come`);
      t.mock.timers.tick(nextFireAt + 5 * MINUTE - Date.now() - 1);
      await flush();
      assert.equal(held.script.released(), false, label);
      t.mock.timers.tick(1);
      await flush();
      assert.equal(held.script.released(), true, label);
    } finally {
      await finish(held);
    }
  }
});

test('a one-shot job due after HOLD_MAX runs out still holds its process until it fires; one due past the hold limit does not hold it at all', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const HOLD_MAX_MS = 12 * 60 * MINUTE;
  let nextFireAt = 0;
  const held = await startHeldRun(announcingPrompt((script) => {
    nextFireAt = Date.now() + 20 * 60 * MINUTE;
    createCronJob(script, 'once1', { recurring: false, nextFireAt });
  }));
  try {
    t.mock.timers.tick(HOLD_MAX_MS + MINUTE);
    await flush();
    assert.equal(held.script.released(), false, 'HOLD_MAX finds no task to stop, and the job still holds the process');
    assert.deepEqual(await claudeRuntime.planHandOver(held.sessionId, { cwd: held.cwd }), STILL_HELD);
    t.mock.timers.tick(nextFireAt - Date.now());
    fireCronJob(held.script);
    await flush();
    assert.equal(held.script.released(), true);
    assert.equal(held.first.finishedReports(), 1);
  } finally {
    await finish(held);
  }

  const far = await startHeldRun(announcingPrompt((script) => {
    createCronJob(script, 'once2', { recurring: false, nextFireAt: Date.now() + SCHEDULE_HOLD_MAX_MS + MINUTE });
  }), {}, { expectHeld: false });
  try {
    assert.equal(far.script.released(), true, 'it would not fire in this process anyway');
    assert.equal(far.first.finishedReports(), 0);
    assert.deepEqual(scheduledOf(far.sessionId), []);
  } finally {
    await finish(far);
  }
});

test('a wake-up due past HOLD_IDLE keeps its process held until it fires, and its turn that sets no other lets the process go', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  // delaySeconds 1800, which the CLI rounds up to the next minute.
  let scheduledFor = 0;
  const held = await startHeldRun(announcingPrompt((script) => {
    scheduledFor = Date.now() + 1804 * 1000;
    armWakeup(script, scheduledFor, 1800);
  }));
  try {
    t.mock.timers.tick(HOLD_IDLE_MS);
    await flush();
    assert.equal(held.script.released(), false, 'the wake-up is still to come');
    t.mock.timers.tick(4 * 1000);
    fireLoopWakeup(held.script, scheduledFor);
    await flush();
    assert.equal(held.script.released(), true);
    assert.equal(held.first.finishedReports(), 1);
  } finally {
    await finish(held);
  }
});

test('a wake-up an hour away still holds its process at 59 minutes, and one that never fires lets it go past its time, reporting nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  let scheduledFor = 0;
  const held = await startHeldRun(announcingPrompt((script) => {
    scheduledFor = Math.ceil((Date.now() + 3600 * 1000) / MINUTE) * MINUTE;
    armWakeup(script, scheduledFor, 3600);
  }));
  try {
    t.mock.timers.tick(30 * MINUTE);
    await flush();
    assert.equal(held.script.released(), false);
    t.mock.timers.tick(29 * MINUTE);
    await flush();
    assert.equal(held.script.released(), false);
    // The CLI sends nothing for a fire that never starts.
    t.mock.timers.tick(scheduledFor + 5 * MINUTE - Date.now() - 1);
    await flush();
    assert.equal(held.script.released(), false);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(held.script.released(), true);
    assert.equal(held.first.finishedReports(), 0);
  } finally {
    await finish(held);
  }
});

test('a wake-up whose result names no time is held for its delaySeconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  let dueBy = 0;
  const held = await startHeldRun(announcingPrompt((script) => {
    script.emit(toolUse('toolu_wakeup', 'ScheduleWakeup', { delaySeconds: 2400, prompt: '/loop check the build', reason: 'idle' }));
    script.emit(toolResult('toolu_wakeup', 'Next wakeup scheduled (in 2400s).'));
    // Clamped, rounded up to the minute, then five minutes of grace.
    dueBy = Math.ceil((Date.now() + 2400 * 1000) / MINUTE) * MINUTE + 5 * MINUTE;
  }));
  try {
    t.mock.timers.tick(HOLD_IDLE_MS);
    await flush();
    assert.equal(held.script.released(), false);
    t.mock.timers.tick(dueBy - Date.now() - 1);
    await flush();
    assert.equal(held.script.released(), false);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(held.script.released(), true);
  } finally {
    await finish(held);
  }
});

test('a fire for a wake-up a later call replaced leaves the newer one held', async () => {
  const first = Date.now() + 10 * MINUTE;
  const second = Date.now() + 20 * MINUTE;
  const held = await startHeldRun(announcingPrompt((script) => armWakeup(script, first, 600)));
  const runs: Array<Promise<unknown>> = [];
  try {
    // The user's turn sets another; the first's fire had already been queued.
    const next = await runHandedOverTurn(held, 'Check again in twenty minutes', () => armWakeup(held.script, second, 1200));
    runs.push(next.run);
    fireLoopWakeup(held.script, first);
    await flush();
    assert.equal(held.script.released(), false, 'the newer wake-up is still to come');
    fireLoopWakeup(held.script, second);
    await flush();
    assert.equal(held.script.released(), true);
  } finally {
    await finish(held, runs);
  }
});

test('a handed-over turn that ends the loop with stop: true lets the process go, reporting nothing', async () => {
  const held = await startHeldRun(announcingPrompt(scheduleWakeup));
  const runs: Array<Promise<unknown>> = [];
  try {
    assert.deepEqual(await claudeRuntime.planHandOver(held.sessionId, { cwd: held.cwd }), STILL_HELD);
    const next = await runHandedOverTurn(held, 'Stop the loop', () => stopLoop(held.script));
    runs.push(next.run);
    assert.equal(held.script.released(), true);
    assert.deepEqual(await claudeRuntime.planHandOver(held.sessionId, { cwd: held.cwd, effort: 'max' }), NOTHING_HELD);
    assert.deepEqual([held.first.finishedReports(), next.writer.finishedReports()], [0, 0]);
  } finally {
    await finish(held, runs);
  }
});

test('a handed-over turn that ends the loop and then sets a wake-up keeps the process held', async () => {
  const held = await startHeldRun(announcingPrompt(scheduleWakeup));
  const runs: Array<Promise<unknown>> = [];
  try {
    const next = await runHandedOverTurn(held, 'Restart the loop', () => {
      stopLoop(held.script);
      armWakeup(held.script, Date.now() + 5 * MINUTE, 300);
    });
    runs.push(next.run);
    assert.equal(held.script.released(), false);
    assert.deepEqual(await claudeRuntime.planHandOver(held.sessionId, { cwd: held.cwd }), STILL_HELD);
  } finally {
    await finish(held, runs);
  }
});

test('stop: true leaves the process held for a Monitor, a cron job or a task still going', async () => {
  const others: Array<[string, (script: Scripted) => void]> = [
    ['a Monitor', launchMonitor],
    ['a cron job', (script) => createCronJob(script, 'job1')],
    ['a backgrounded command', (script) => launchBackgroundCommand(script)],
  ];
  for (const [label, launch] of others) {
    const held = await startHeldRun(announcingPrompt((script) => {
      scheduleWakeup(script);
      launch(script);
    }));
    const runs: Array<Promise<unknown>> = [];
    try {
      const next = await runHandedOverTurn(held, 'Stop the loop', () => stopLoop(held.script));
      runs.push(next.run);
      assert.equal(held.script.released(), false, label);
      assert.equal((await claudeRuntime.planHandOver(held.sessionId, { cwd: held.cwd })).heldWork, true, label);
      if (label === 'a backgrounded command') {
        relayFinishedTask(held.script, 'bg1', 'toolu_bash');
        await flush();
        assert.equal(held.script.released(), true, 'once the command is relayed, nothing is left');
      }
    } finally {
      await finish(held, runs);
    }
  }
});

test('a wake-up turn that ends the loop ahead of a handed-over prompt lets the process go after that turn', async () => {
  const scheduledFor = Date.now() + 5 * MINUTE;
  const held = await startHeldRun(announcingPrompt((script) => armWakeup(script, scheduledFor, 300)));
  const next = sendNext(held, 'How is it going?');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    fireLoopWakeup(held.script, scheduledFor, () => stopLoop(held.script));
    await flush();
    assert.equal(held.first.finishedReports(), 1, 'the loop has ended, in a turn of the CLI\'s own');
    held.script.emit(echo(promptUuid(held, 1), 'How is it going?'));
    held.script.emit(resultFor([promptUuid(held, 1)]));
    await waitUntil(() => next.settled());
    await flush();
    assert.equal(held.script.released(), true);
    assert.equal(next.writer.finishedReports(), 0);
  } finally {
    await finish(held, [next.run]);
  }
});

// ---------------------------------------------------------------------------
// The scheduled work a held process lists (listScheduledWork), and turns that
// accept the process's own settings.
// ---------------------------------------------------------------------------

test('a held process lists its cron job and its wake-up with what the client shows of them', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const start = Date.now();
  const scheduledFor = Math.ceil((start + 20 * MINUTE) / MINUTE) * MINUTE;
  const cronNext = nextScheduledFire({ cron: '*/5 * * * *', recurring: true, id: 'b2148320', createdAt: start }) as number;
  const held = await startHeldRun(announcingPrompt((script) => {
    createCronJob(script, 'b2148320', { nextFireAt: cronNext });
    armWakeup(script, scheduledFor, 1200, 'toolu_wakeup_first');
  }));
  try {
    const [job, wakeup] = scheduledOf(held.sessionId);
    assert.deepEqual(
      [job.id, job.kind, job.toolUseId, job.prompt, job.startedAt, job.nextFireAt, job.recurring, job.holdUntil, job.cron, job.cadence, job.expiresAt, job.durable],
      ['cron:b2148320', 'cron', 'toolu_cron_b2148320', 'check the deploy', start, cronNext, true, start + SCHEDULE_HOLD_MAX_MS, '*/5 * * * *', 'Every 5 minutes', start + 7 * DAY, false],
    );
    assert.deepEqual(
      [wakeup.id, wakeup.kind, wakeup.toolUseId, wakeup.prompt, wakeup.startedAt, wakeup.nextFireAt, wakeup.recurring, wakeup.holdUntil, wakeup.reason],
      ['wakeup:toolu_wakeup_first', 'wakeup', 'toolu_wakeup_first', '/loop check the build', start, scheduledFor, true, start + SCHEDULE_HOLD_MAX_MS, 'polling'],
    );
    // The job fires on its time: its next one counts from this fire.
    t.mock.timers.tick(cronNext - Date.now());
    fireCronJob(held.script);
    await flush();
    assert.equal(scheduledOf(held.sessionId)[0]?.nextFireAt, cronNext + 285 * 1000);
  } finally {
    await finish(held);
  }
});

test('a dynamic loop keeps its id through the wake-up each fire sets, and leaves the list once a fire sets none', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const first = Math.ceil((Date.now() + 2 * MINUTE) / MINUTE) * MINUTE;
  const second = first + 2 * MINUTE;
  const held = await startHeldRun(announcingPrompt((script) => armWakeup(script, first, 60, 'toolu_wakeup_chain')));
  try {
    t.mock.timers.tick(first - Date.now());
    fireLoopWakeup(held.script, first, () => armWakeup(held.script, second, 120, 'toolu_wakeup_next'));
    await flush();
    const [wakeup] = scheduledOf(held.sessionId);
    assert.deepEqual([wakeup?.id, wakeup?.toolUseId, wakeup?.nextFireAt], ['wakeup:toolu_wakeup_chain', 'toolu_wakeup_next', second]);
    assert.equal(held.first.finishedReports(), 0);
    t.mock.timers.tick(second - Date.now());
    fireLoopWakeup(held.script, second);
    await flush();
    assert.deepEqual(scheduledOf(held.sessionId), []);
    assert.equal(held.script.released(), true);
    assert.equal(held.first.finishedReports(), 1, 'the loop ended on its own');
  } finally {
    await finish(held);
  }
});

test('a wake-up a fire\'s turn sets carries the chain on, even one whose result names no time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const first = Math.ceil((Date.now() + 2 * MINUTE) / MINUTE) * MINUTE;
  const held = await startHeldRun(announcingPrompt((script) => armWakeup(script, first, 60, 'toolu_wakeup_exact')));
  try {
    t.mock.timers.tick(first - Date.now());
    fireLoopWakeup(held.script, first, () => scheduleWakeup(held.script, 'toolu_wakeup_untimed'));
    await flush();
    assert.equal(held.script.released(), false, 'the wake-up the fire\'s turn set is still to come');
    const [wakeup] = scheduledOf(held.sessionId);
    assert.deepEqual([wakeup?.id, wakeup?.toolUseId], ['wakeup:toolu_wakeup_exact', 'toolu_wakeup_untimed']);
    assert.equal(held.first.finishedReports(), 0);
  } finally {
    await finish(held);
  }
});

test('scheduled work leaves the list as its fire, stop: true or CronDelete ends it, and when the process is let go', async () => {
  const held = await startHeldRun(announcingPrompt((script) => {
    launchWorkflow(script);
    createCronJob(script, 'b2148320');
    createCronJob(script, '7b7cd8fc', { recurring: false, nextFireAt: Date.now() - 1000 });
    armWakeup(script, Date.now() + 20 * MINUTE, 1200, 'toolu_wakeup_list');
  }));
  const ids = () => scheduledOf(held.sessionId).map((item) => item.id);
  const runs: Array<Promise<unknown>> = [];
  try {
    assert.deepEqual(ids(), ['cron:b2148320', 'cron:7b7cd8fc', 'wakeup:toolu_wakeup_list']);
    fireCronJob(held.script);
    await flush();
    assert.deepEqual(ids(), ['cron:b2148320', 'wakeup:toolu_wakeup_list'], 'the one-shot job has fired');
    runs.push((await runHandedOverTurn(held, 'Stop the dynamic loop', () => stopLoop(held.script))).run);
    assert.deepEqual(ids(), ['cron:b2148320']);
    runs.push((await runHandedOverTurn(held, 'And the job', () => deleteCronJob(held.script, 'b2148320'))).run);
    assert.deepEqual(ids(), []);
    assert.equal(held.script.released(), false, 'the workflow still runs');
    assert.equal(held.first.finishedReports(), 0);
  } finally {
    await finish(held, runs);
  }

  const shell = await startHeldRun(announcingPrompt((script) => armWakeup(script, Date.now() + 20 * MINUTE, 1200)));
  try {
    assert.equal(scheduledOf(shell.sessionId).length, 1);
    const letGo = claudeRuntime.release(shell.sessionId);
    await flush();
    assert.deepEqual(scheduledOf(shell.sessionId), []);
    shell.script.end();
    await letGo;
  } finally {
    await finish(shell);
  }
});

test('a recurring job is gone at its first fire seven days on, and the process lets go, reporting the work done once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const created = Date.now();
  const held = await startHeldRun(announcingPrompt((script) => {
    const nextFireAt = nextScheduledFire({ cron: '0 9 * * *', recurring: true, id: '00000000', createdAt: Date.now() }) as number;
    createCronJob(script, '00000000', { cron: '0 9 * * *', nextFireAt });
  }));
  try {
    let fires = 0;
    while (scheduledOf(held.sessionId).length > 0 && fires < 10) {
      t.mock.timers.tick((scheduledOf(held.sessionId)[0]?.nextFireAt as number) - Date.now());
      await flush();
      assert.equal(held.script.released(), false, `before fire ${fires + 1}: neither HOLD_IDLE nor HOLD_MAX lets the job go`);
      fireCronJob(held.script);
      await flush();
      fires += 1;
    }
    const age = Date.now() - created;
    assert.equal(age >= 7 * DAY && age < SCHEDULE_HOLD_MAX_MS, true, `the last fire came ${age} ms after the job was created`);
    assert.equal(held.script.released(), true);
    assert.equal(held.first.finishedReports(), 1);
  } finally {
    await finish(held);
  }
});

test('a ScheduleWakeup whose result sets no wake-up holds nothing', async () => {
  // The loop reached its maximum duration: "Wakeup not scheduled".
  const held = await startHeldRun(announcingPrompt((script) => {
    launchWorkflow(script);
    script.emit(toolUse('toolu_aged', 'ScheduleWakeup', { delaySeconds: 60, prompt: '/loop check the build', reason: 'polling' }));
    script.emit({
      ...toolResult('toolu_aged', 'Wakeup not scheduled. The loop reached its maximum duration.'),
      tool_use_result: { scheduledFor: 0, clampedDelaySeconds: 0, wasClamped: false },
    });
  }));
  try {
    assert.deepEqual(scheduledOf(held.sessionId), []);
    relayFinishedTask(held.script, 'wf1', 'toolu_wf');
    await flush();
    assert.equal(held.script.released(), true, 'the workflow was all there was');
    assert.equal(held.first.finishedReports(), 1);
  } finally {
    await finish(held);
  }
});

test('a Monitor the CLI reported no task for still gets its HOLD_IDLE of silence when the wake-up beside it is dropped earlier', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  let scheduledFor = 0;
  const held = await startHeldRun(announcingPrompt((script) => {
    launchUntrackedMonitor(script);
    scheduledFor = Math.ceil((Date.now() + 5 * MINUTE) / MINUTE) * MINUTE;
    armWakeup(script, scheduledFor, 300);
  }));
  const heldSince = Date.now();
  try {
    // The wake-up never fires: dropped five minutes past its time.
    t.mock.timers.tick(scheduledFor + 5 * MINUTE - Date.now());
    await flush();
    assert.deepEqual(scheduledOf(held.sessionId), []);
    assert.equal(held.script.released(), false, 'the Monitor still has the rest of its silence');
    t.mock.timers.tick(heldSince + HOLD_IDLE_MS - Date.now() - 1);
    await flush();
    assert.equal(held.script.released(), false);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(held.script.released(), true);
    assert.equal(held.first.finishedReports(), 0);
  } finally {
    await finish(held);
  }
});

test('a job due while a handed-over turn runs is matched to the fire that comes once the turn is over', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  let due = 0;
  const held = await startHeldRun(announcingPrompt((script) => {
    due = nextScheduledFire({ cron: '*/5 * * * *', recurring: true, id: 'b2148320', createdAt: Date.now() }) as number;
    createCronJob(script, 'b2148320', { nextFireAt: due });
  }));
  const next = sendNext(held, 'Run the whole suite');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(echo(promptUuid(held, 1), 'Run the whole suite'));
    await flush();
    // The turn runs twenty minutes, well past the job's time.
    t.mock.timers.tick(due + 20 * MINUTE - Date.now());
    held.script.emit(resultFor([promptUuid(held, 1)]));
    await waitUntil(() => next.settled());
    t.mock.timers.tick(800);
    fireCronJob(held.script);
    await flush();
    assert.equal(scheduledOf(held.sessionId)[0]?.nextFireAt, Date.now() + 285 * 1000, 'its next fire counts from this one');
    assert.equal(held.script.released(), false);
  } finally {
    await finish(held, [next.run]);
  }
});

test('HOLD_MAX running out during a long handed-over turn lets go of work past its hold limit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  // A job whose result named no time: held for HOLD_MAX from its creation.
  const held = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'job1', { output: false })));
  const next = sendNext(held, 'Run the whole suite');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(echo(promptUuid(held, 1), 'Run the whole suite'));
    await flush();
    t.mock.timers.tick(12 * 60 * MINUTE - 1);
    await flush();
    assert.equal(held.script.released(), false);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(held.script.released(), true, 'nothing holds the process past the turn');
    assert.deepEqual(scheduledOf(held.sessionId), []);
    held.script.emit(resultFor([promptUuid(held, 1)]));
    await waitUntil(() => next.settled());
    assert.equal(completes(next.writer.sent), 1);
    assert.deepEqual([held.first.finishedReports(), next.writer.finishedReports()], [0, 0]);
  } finally {
    await finish(held, [next.run]);
  }
});

const ASK_INPUT = { questions: [{ question: 'Re-run CI?', header: 'CI', multiSelect: false, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] };

test('a turn handed over behind a turn of the CLI\'s own that waits on a question nobody answers goes with the process HOLD_MAX after the CLI last spoke, though HOLD_MAX has run out before', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const HOUR = 60 * MINUTE;
  const held = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'b2148320', { cron: '0 0 * * *', nextFireAt: Date.now() + 20 * HOUR })));
  let next: ReturnType<typeof sendNext> | null = null;
  try {
    t.mock.timers.tick(12 * HOUR + MINUTE);
    await flush();
    assert.equal(held.script.released(), false, 'HOLD_MAX found the job still to fire');
    t.mock.timers.tick(8 * HOUR - MINUTE);
    held.script.emit(lifecycle(randomUUID(), 'started', { wakeup_source: 'schedule_wakeup' }));
    held.script.emit(init());
    held.script.emit(toolUse('toolu_ask', 'AskUserQuestion', ASK_INPUT));
    await flush();
    // The user stops the loop from its chip: the stop's turn waits behind the CLI's.
    next = sendNext(held, 'Cancel scheduled job b2148320 now', { inheritUnset: true });
    await waitUntil(() => held.script.prompts.length === 2);
    t.mock.timers.tick(12 * HOUR - MINUTE);
    await flush();
    assert.equal(held.script.released(), false);
    t.mock.timers.tick(MINUTE);
    await flush();
    assert.equal(held.script.released(), true, 'the hand-over left HOLD_MAX the only timer of the hold, and it kept watching');
    assert.deepEqual(scheduledOf(held.sessionId), []);
    assert.equal(next.later.script.created(), false);
  } finally {
    await finish(held, next ? [next.run] : []);
  }
});

test('a handed-over turn whose agent keeps talking past HOLD_MAX is not let go while a loop holds the process', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const HOUR = 60 * MINUTE;
  const held = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'b2148320', { cron: '0 0 * * *', nextFireAt: Date.now() + 20 * HOUR })));
  const next = sendNext(held, 'Bisect the failure');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(echo(promptUuid(held, 1), 'Bisect the failure'));
    held.script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'Bisect the failure', subagent_type: 'general-purpose' }));
    await flush();
    for (let minutes = 10; minutes <= 13 * 60; minutes += 10) {
      t.mock.timers.tick(10 * MINUTE);
      held.script.emit({ ...assistantText(`Bisecting (${minutes} min)`), parent_tool_use_id: 'toolu_agent' });
      await flush();
    }
    assert.equal(held.script.released(), false, 'the turn is busy, not stuck');
    held.script.emit(resultFor([promptUuid(held, 1)]));
    await waitUntil(() => next.settled());
    assert.equal(completes(next.writer.sent), 1);
    assert.deepEqual(scheduledOf(held.sessionId).map((item) => item.id), ['cron:b2148320']);
  } finally {
    await finish(held, [next.run]);
  }
});

const ACCEPT_PROCESS_SETTINGS = { inheritUnset: true, acceptProcessSettings: true };

test('a plan that accepts the process\'s own settings lets in a turn that changes the effort or ultracode of a process held only for scheduled work, but not stricter tool rules or another working directory', async () => {
  const held = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'b2148320')), { model: 'opus', effort: 'high' });
  try {
    const plan = (options: Record<string, unknown>, planOptions?: Record<string, unknown>) => claudeRuntime.planHandOver(
      held.sessionId,
      { sessionId: held.sessionId, cwd: held.cwd, model: 'opus', effort: 'high', ...options },
      planOptions,
    );
    const goesIn = { heldWork: true, canHandOver: true, changes: [], switches: [] };
    assert.deepEqual(
      await plan({ effort: 'max' }, INHERIT_UNSET),
      { heldWork: true, canHandOver: false, changes: ['effort'], switches: [], replaceKeepsWork: true },
      'without accepting, a process of its own brings the cron job back',
    );
    assert.deepEqual(await plan({ effort: 'max' }, ACCEPT_PROCESS_SETTINGS), goesIn);
    assert.deepEqual(await plan({ effort: 'max', acceptProcessSettings: true }, INHERIT_UNSET), goesIn, 'set in the options, as its run will be');
    assert.deepEqual(await plan({ ultracode: true }, ACCEPT_PROCESS_SETTINGS), goesIn);
    assert.deepEqual(
      await plan({ ultracode: true, toolsSettings: { disallowedTools: ['Bash'] } }, ACCEPT_PROCESS_SETTINGS),
      {
        heldWork: true,
        canHandOver: false,
        changes: ['tools'],
        switches: [],
        details: { tools: { notAllowed: [], alsoDenied: ['Bash'] } },
        replaceKeepsWork: true,
      },
      'tool rules that deny what the process allows need a process of their own',
    );
    assert.deepEqual(await plan({ effort: 'max', model: 'sonnet' }, ACCEPT_PROCESS_SETTINGS), { ...goesIn, switches: ['model'] }, 'what it can switch is still switched');
    assert.deepEqual(
      await plan({ effort: 'max', cwd: '/elsewhere' }, ACCEPT_PROCESS_SETTINGS),
      { heldWork: true, canHandOver: false, changes: ['cwd'], switches: [] },
      'another working directory still needs a process of its own',
    );
    assert.deepEqual(held.script.calls, [`prompt:${promptUuid(held, 0)}`], 'nothing was written or switched');
  } finally {
    await finish(held);
  }

  const others: Array<[string, (script: Scripted) => void]> = [
    ['a task', (script) => { createCronJob(script, 'b2148320'); launchWorkflow(script); }],
    ['a task still to be relayed', (script) => {
      createCronJob(script, 'b2148320');
      launchWorkflow(script);
      script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    }],
    ['a Monitor the CLI reported no task for', (script) => { createCronJob(script, 'b2148320'); launchUntrackedMonitor(script); }],
  ];
  for (const [label, launch] of others) {
    const busy = await startHeldRun(announcingPrompt(launch), { model: 'opus', effort: 'high' });
    try {
      assert.deepEqual(
        await claudeRuntime.planHandOver(busy.sessionId, { sessionId: busy.sessionId, cwd: busy.cwd, model: 'opus', effort: 'max' }, ACCEPT_PROCESS_SETTINGS),
        { heldWork: true, canHandOver: false, changes: ['effort'], switches: [] },
        `${label}: the process is not held only for scheduled work`,
      );
    } finally {
      await finish(busy);
    }
  }

  let failing = false;
  const lookup = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'b2148320')), {}, { context: createFailingLookupContext(() => failing) });
  try {
    failing = true;
    assert.deepEqual(
      await claudeRuntime.planHandOver(lookup.sessionId, { cwd: lookup.cwd, effort: 'max' }, { acceptProcessSettings: true }),
      { heldWork: true, canHandOver: false, changes: ['lookup'], switches: [] },
    );
  } finally {
    failing = false;
    await finish(lookup);
  }
});

test('a plan that accepts the process\'s own settings lets in tool rules no stricter than the process\'s, and keeps out rules that allow fewer tools or deny others', async () => {
  const held = await startHeldRun(
    announcingPrompt((script) => createCronJob(script, 'b2148320')),
    { model: 'opus', effort: 'high', ...toolsSettings(['Bash(git status:*)'], ['WebFetch'], false) },
  );
  try {
    const plan = (allowedTools: string[], disallowedTools: string[], planOptions: Record<string, unknown> = ACCEPT_PROCESS_SETTINGS) => claudeRuntime.planHandOver(
      held.sessionId,
      { sessionId: held.sessionId, cwd: held.cwd, model: 'opus', effort: 'high', ...toolsSettings(allowedTools, disallowedTools, false) },
      planOptions,
    );
    const keptOut = { heldWork: true, canHandOver: false, changes: ['tools'], switches: [], replaceKeepsWork: true };
    assert.deepEqual(await plan(['Bash(git status:*)', 'Read'], []), { heldWork: true, canHandOver: true, changes: [], switches: [] }, 'allows more, and denies less: the process denies WebFetch all the same');
    assert.deepEqual(await plan(['Bash(git status:*)', 'Read'], [], INHERIT_UNSET), keptOut, 'without accepting, any other rules need a process of their own');
    assert.deepEqual(
      await plan([], ['WebFetch']),
      { ...keptOut, details: { tools: { notAllowed: ['Bash(git status:*)'], alsoDenied: [] } } },
      'allows fewer tools than the process',
    );
    assert.deepEqual(
      await plan(['Bash(git status:*)'], ['WebFetch', 'Bash(git push:*)']),
      { ...keptOut, details: { tools: { notAllowed: [], alsoDenied: ['Bash(git push:*)'] } } },
      'denies a tool the process does not',
    );
  } finally {
    await finish(held);
  }

  // A loop started in plan mode was launched with no rules for what plan mode
  // allows (canUseTool grants those while it is in plan mode): a message from
  // the default mode with no rules of its own only switches it out of plan
  // mode for its turn.
  const planned = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'b2148320')), { model: 'opus', effort: 'high', permissionMode: 'plan', ...toolsSettings([], [], false) });
  try {
    assert.deepEqual(
      await claudeRuntime.planHandOver(
        planned.sessionId,
        { sessionId: planned.sessionId, cwd: planned.cwd, model: 'opus', effort: 'max', permissionMode: 'default', ...toolsSettings([], [], false) },
        ACCEPT_PROCESS_SETTINGS,
      ),
      { heldWork: true, canHandOver: true, changes: [], switches: ['permissionMode'] },
    );
  } finally {
    await finish(planned);
  }
});

test('a turn that accepts the process\'s own settings goes into a process held only for a loop on the process\'s deny rules; without accepting, a durable loop is stopped', async () => {
  const launch = { model: 'opus', effort: 'high', ...toolsSettings(['Bash(git status:*)'], ['WebFetch'], false) };
  const turn = { model: 'opus', effort: 'max', ...toolsSettings(['Bash(git status:*)', 'Read'], [], false) };
  const held = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'b2148320')), launch);
  const next = sendNext(held, 'Post a summary', { ...turn, acceptProcessSettings: true });
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    assert.equal(next.later.script.created(), false, 'no second CLI is started');
    assert.deepEqual(held.script.calls.filter((call) => !call.startsWith('prompt:')), [], 'nothing is switched, stopped or released');
    assert.deepEqual(workStoppedNotices(next.writer.sent), []);
    assert.deepEqual(held.script.options()?.allowedTools, ['Bash(git status:*)', 'Read'], 'the run\'s permission checks grant the turn\'s own allowed tools');
    const canUseTool = held.script.options()?.canUseTool as CanUseTool;
    assert.equal((await canUseTool('WebFetch', { url: 'https://example.com' }, {})).behavior, 'deny', 'what the process denies stays denied');
    held.script.emit(echo(promptUuid(held, 1), 'Post a summary'));
    held.script.emit(resultFor([promptUuid(held, 1)]));
    await waitUntil(() => next.settled());
    await flush();
    assert.equal(completes(next.writer.sent), 1);
    assert.equal(held.script.released(), false, 'the loop still holds the process');
    assert.deepEqual(scheduledOf(held.sessionId).map((item) => item.id), ['cron:b2148320']);
  } finally {
    await finish(held, [next.run]);
  }

  // Without accepting, a durable job, which no resume has been seen to bring
  // back, is stopped with the process.
  const plain = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'b2148320', { durable: true })), launch);
  const replaced = sendNext(plain, 'Post a summary', turn);
  try {
    await waitUntil(() => plain.script.released());
    assert.deepEqual(workStoppedNotices(replaced.writer.sent).map((notice) => notice.slice(0, 2)), [['BACKGROUND_WORK_STOPPED', ['effort', 'tools']]]);
    plain.script.end();
    await waitUntil(() => replaced.later.script.created());
  } finally {
    await finish(plain, [replaced.run]);
  }
});

test('a turn that accepts the process\'s own settings but denies what the loop\'s process allows fails, and leaves the process and the loop as they are', async () => {
  // The loop started while the user allowed Bash; the message was queued
  // once they had stopped allowing it and denied git push.
  const held = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'b2148320')), { model: 'opus', effort: 'high', ...toolsSettings(['Bash'], [], false) });
  const switchedBack: unknown[] = [];
  const writer = createWriter(2);
  const later = createScriptedQuery();
  held.laterQueries.push(later);
  const options = {
    sessionId: held.sessionId,
    cwd: held.cwd,
    model: 'opus',
    effort: 'high',
    ...toolsSettings([], ['Bash(git push:*)'], false),
    inheritUnset: true,
    restoreSwitchesAfterTurn: true,
    acceptProcessSettings: true,
    onSwitchesRestored: (restored: unknown) => { switchedBack.push(restored); },
  };
  try {
    const thrown = await queryClaudeSDK('Push the fix', options, writer.writer as never, { ...held.context, createQuery: later.createQuery })
      .then(() => null, (error: Error & { code?: unknown; reason?: unknown }) => error);
    const failure = thrown?.message;
    assert.equal(failure, 'Not sent: this message changes the tool permissions, which only a new Claude process can apply, and a new process would stop the session\'s scheduled work.');
    assert.deepEqual([thrown?.code, thrown?.reason], ['HAND_OVER_FAILED', 'stale-plan'], 'the run fails with the code and reason');
    assert.deepEqual(
      writer.sent.filter((message) => message.kind === 'error').map((message) => [message.code, message.reason, message.changes, message.content]),
      [['HAND_OVER_FAILED', 'stale-plan', ['tools'], failure]],
      'the turn\'s run hears why, by code and reason, and in English',
    );
    assert.equal(writer.sent.some((message) => message.code === 'BACKGROUND_WORK_STOPPED'), false, 'nothing was stopped');
    await flush();
    assert.deepEqual(switchedBack, [{ model: null, permissionMode: null }], 'the gateway hears that nothing was switched');
    assert.equal(later.script.created(), false, 'no new CLI');
    assert.equal(held.script.prompts.length, 1, 'nothing goes into the loop\'s process');
    assert.deepEqual(held.script.calls.filter((call) => !call.startsWith('prompt:')), [], 'nothing is interrupted, stopped or released');
    assert.deepEqual(scheduledOf(held.sessionId).map((item) => item.id), ['cron:b2148320']);
  } finally {
    await finish(held);
  }
});

test('a turn that accepts the process\'s own settings fails when its lookups fail, and leaves the loop\'s process as it is', async () => {
  let failing = false;
  const held = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'b2148320')), {}, { context: createFailingLookupContext(() => failing) });
  const writer = createWriter(2);
  const later = createScriptedQuery();
  held.laterQueries.push(later);
  try {
    failing = true;
    const thrown = await queryClaudeSDK(
      'Post a summary',
      { sessionId: held.sessionId, cwd: held.cwd, model: 'opus', acceptProcessSettings: true },
      writer.writer as never,
      { ...held.context, createQuery: later.createQuery },
    ).then(() => null, (error: Error & { code?: unknown; reason?: unknown }) => error);
    const failure = thrown?.message;
    assert.equal(failure, 'Not sent: the message could not be handed to the process the work ran in, and a new process would stop the session\'s scheduled work.');
    assert.deepEqual([thrown?.code, thrown?.reason], ['HAND_OVER_FAILED', 'lookup']);
    assert.deepEqual(
      writer.sent.filter((message) => message.kind === 'error').map((message) => [message.code, message.reason, message.changes, message.content]),
      [['HAND_OVER_FAILED', 'lookup', ['lookup'], failure]],
    );
    assert.equal(writer.sent.some((message) => message.code === 'BACKGROUND_WORK_STOPPED'), false, 'nothing was stopped');
    assert.equal(later.script.created(), false, 'no new CLI');
    assert.deepEqual(held.script.calls.filter((call) => !call.startsWith('prompt:')), [], 'nothing is interrupted, stopped or released');
    assert.deepEqual(scheduledOf(held.sessionId).map((item) => item.id), ['cron:b2148320']);
  } finally {
    failing = false;
    await finish(held);
  }
});

test('a turn planned to accept the process\'s own settings still goes in when the loop\'s fire starts a task before the hand-over', async () => {
  const held = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'b2148320')), { model: 'opus', effort: 'high' });
  const turn = { model: 'opus', effort: 'max', inheritUnset: true, restoreSwitchesAfterTurn: true };
  let next: ReturnType<typeof sendNext> | null = null;
  try {
    assert.deepEqual(
      await claudeRuntime.planHandOver(held.sessionId, { sessionId: held.sessionId, cwd: held.cwd, ...turn }, ACCEPT_PROCESS_SETTINGS),
      { heldWork: true, canHandOver: true, changes: [], switches: [] },
    );
    // The job fires, and its turn backgrounds a command before the
    // dispatcher's send reaches the runtime.
    held.script.emit(lifecycle(randomUUID(), 'started', { wakeup_source: 'schedule_wakeup' }));
    held.script.emit(init());
    held.script.emit(toolUse('toolu_bg', 'Bash', { command: 'npm test', run_in_background: true }));
    held.script.emit(taskStarted('bg1', 'toolu_bg', 'local_bash'));
    await flush();
    next = sendNext(held, 'Post the daily summary', { ...turn, acceptProcessSettings: true });
    await waitUntil(() => held.script.prompts.length === 2);
    assert.equal(next.later.script.created(), false, 'no second CLI is started');
    assert.deepEqual(held.script.calls.filter((call) => !call.startsWith('prompt:')), [], 'nothing is interrupted, stopped or released');
    assert.deepEqual(workStoppedNotices(next.writer.sent), []);
    assert.deepEqual(listedTaskIds(held.sessionId), ['bg1']);
    assert.deepEqual(scheduledOf(held.sessionId).map((item) => item.id), ['cron:b2148320']);
    // The fire's turn ends, then the handed-over one runs.
    held.script.emit(result());
    held.script.emit(echo(promptUuid(held, 1), 'Post the daily summary'));
    held.script.emit(resultFor([promptUuid(held, 1)]));
    await waitUntil(() => next?.settled() === true);
    assert.equal(completes(next.writer.sent), 1);
    assert.equal(held.script.released(), false, 'the loop and the command still hold the process');
  } finally {
    await finish(held, next ? [next.run] : []);
  }
});

/** A Claude settings file's bytes: UTF-8 with its byte order mark. */
const utf8WithBom = (text: string) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
/** UTF-16LE with its byte order mark (PowerShell 5's default). */
const utf16leWithBom = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
/** UTF-16BE with its byte order mark, which Claude Code does not read. */
const utf16beWithBom = (text: string) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);

test('a settings file saved with a byte order mark counts as Claude Code reads it', async () => {
  await withUserSettings(async (write) => {
    await write(utf8WithBom('{"ultracode": true}'));
    // The default model gets no ultracode choice, so the process runs with the file's.
    const held = await startHeldRun(launchWorkflow, { model: 'default', effort: 'high' });
    const laterRuns: Array<Promise<unknown>> = [];
    try {
      const plan = (options: Record<string, unknown>) => claudeRuntime.planHandOver(held.sessionId, { cwd: held.cwd, effort: 'high', ...options });
      assert.deepEqual(await plan({ model: 'opus', ultracode: false }), { heldWork: true, canHandOver: false, changes: ['ultracode'], switches: ['model'] });
      assert.deepEqual(await plan({ model: 'opus', ultracode: true }), { heldWork: true, canHandOver: true, changes: [], switches: ['model'] });

      const next = sendNext(held, 'With ultracode off', { model: 'opus', effort: 'high', ultracode: false });
      laterRuns.push(next.run);
      await waitUntil(() => held.script.released());
      assert.deepEqual(workStoppedNotices(next.writer.sent).map((notice) => notice.slice(0, 2)), [['BACKGROUND_WORK_STOPPED', ['ultracode']]]);
      assert.equal(held.script.prompts.length, 1, 'nothing goes into the process');
      assert.deepEqual(switchCalls(held), []);
      held.script.end();
      await waitUntil(() => next.later.script.created());
    } finally {
      await finish(held, laterRuns);
    }
  });
});

test('a settings file saved as UTF-16LE with its byte order mark counts, and a UTF-16BE one is skipped, as Claude Code does', async () => {
  await withUserSettings(async (write) => {
    await write(null);
    const held = await startHeldRun(launchWorkflow, { model: 'opus', effort: 'high', ultracode: false });
    try {
      const fileValueKeepsTheTurnOut = async () => (await claudeRuntime.planHandOver(held.sessionId, { cwd: held.cwd, model: 'default', effort: 'high' })).changes.includes('ultracode');
      await write({ ultracode: true });
      assert.equal(await fileValueKeepsTheTurnOut(), true, 'the user\'s file turns it on');
      await writeProjectSettings(held.cwd, 'settings.json', utf16leWithBom('{"ultracode": false}'));
      assert.equal(await fileValueKeepsTheTurnOut(), false, 'the project\'s UTF-16LE file turns it off again');
      await writeProjectSettings(held.cwd, 'settings.local.json', utf16beWithBom('{"ultracode": true}'));
      assert.equal(await fileValueKeepsTheTurnOut(), false, 'a UTF-16BE local file is skipped');
    } finally {
      await finish(held);
    }
  });
});

/** The model and the permission mode the CLI runs the prompt at `index` with, and those it is left with, read off what reached it in order. */
function replaySwitches(held: HeldRun, launch: { model: string; permissionMode: string }, index: number) {
  let model = launch.model;
  let permissionMode = launch.permissionMode;
  let prompt: { model: string; permissionMode: string } | null = null;
  for (const call of held.script.calls) {
    if (call.startsWith('setModel:')) {
      model = call.slice('setModel:'.length);
    } else if (call.startsWith('setPermissionMode:')) {
      permissionMode = call.slice('setPermissionMode:'.length);
    } else if (call === `prompt:${promptUuid(held, index)}`) {
      prompt = { model, permissionMode };
    }
  }
  return { prompt, final: { model, permissionMode } };
}

test('a turn handed over the moment the one before it ends, before the CLI answers its switches back, runs with its own settings and leaves the process with its own', async () => {
  const launch = { model: 'sonnet', permissionMode: 'default' };
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, { model: string; permissionMode: string }]> = [
    ['B names the process\'s own', { model: 'opus', permissionMode: 'acceptEdits' }, { model: 'sonnet', permissionMode: 'default' }, { model: 'sonnet', permissionMode: 'default' }],
    ['B names what A switched to', { model: 'opus', permissionMode: 'acceptEdits' }, { model: 'opus', permissionMode: 'acceptEdits' }, { model: 'opus', permissionMode: 'acceptEdits' }],
  ];
  for (const [label, a, b, bRunsWith] of cases) {
    const held = await startHeldRun(announcingPrompt(scheduleWakeup), SCHEDULED_OPTIONS);
    const first = sendNext(held, 'A', { ...SCHEDULED_OPTIONS, ...a, ...INHERIT_UNSET, ...RESTORE });
    // B goes in once A's turn is over, within the same turn of the event
    // loop, as the scheduled-messages dispatcher sends a session's next due
    // message: the CLI has not answered A's switches back yet.
    const second = first.run.then(() => sendNext(held, 'B', { ...SCHEDULED_OPTIONS, ...b, ...INHERIT_UNSET, ...RESTORE }));
    try {
      await waitUntil(() => held.script.prompts.length === 2);
      await flush();
      held.script.emit(echo(promptUuid(held, 1), 'A'));
      held.script.emit(resultFor([promptUuid(held, 1)]));
      await waitUntil(() => held.script.prompts.length === 3);
      const { run } = await second;
      held.script.emit(echo(promptUuid(held, 2), 'B'));
      held.script.emit(resultFor([promptUuid(held, 2)]));
      await run;
      await flush();
      const { prompt, final } = replaySwitches(held, launch, 2);
      assert.deepEqual(prompt, bRunsWith, `${label}: B's turn`);
      assert.deepEqual(final, launch, `${label}: the loop is left with its own`);
      assert.equal(held.script.released(), false, label);
      assert.deepEqual(
        await claudeRuntime.planHandOver(held.sessionId, { sessionId: held.sessionId, cwd: held.cwd, ...SCHEDULED_OPTIONS }, INHERIT_UNSET),
        STILL_HELD,
        `${label}: the process runs with what it had`,
      );
    } finally {
      held.script.end();
      const { run, later } = await second;
      later.script.end();
      await finish(held, [first.run, run]);
    }
  }
});

test('a switch back the CLI refuses leaves the next turn weighed against what the process runs with', async () => {
  const held = await startHeldRun(announcingPrompt(scheduleWakeup), SCHEDULED_OPTIONS);
  const first = sendNext(held, 'A', { ...SCHEDULED_OPTIONS, permissionMode: 'acceptEdits', ...INHERIT_UNSET, ...RESTORE });
  const runs: Array<Promise<unknown>> = [first.run];
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    await flush();
    held.script.setSwitchAnswer('refuse');
    held.script.emit(echo(promptUuid(held, 1), 'A'));
    held.script.emit(resultFor([promptUuid(held, 1)]));
    await waitUntil(() => first.settled());
    await flush();
    held.script.setSwitchAnswer('ok');
    assert.deepEqual(
      await claudeRuntime.planHandOver(held.sessionId, { sessionId: held.sessionId, cwd: held.cwd, ...SCHEDULED_OPTIONS }, INHERIT_UNSET),
      { heldWork: true, canHandOver: true, changes: [], switches: ['permissionMode'] },
      'the process still runs in acceptEdits',
    );
    const second = sendNext(held, 'B', { ...SCHEDULED_OPTIONS, ...INHERIT_UNSET });
    runs.push(second.run);
    await waitUntil(() => held.script.prompts.length === 3);
    assert.deepEqual(replaySwitches(held, { model: 'sonnet', permissionMode: 'default' }, 2).prompt, { model: 'sonnet', permissionMode: 'default' });
  } finally {
    await finish(held, runs);
  }
});

test('a turn handed over with restoreSwitchesAfterTurn tells its onSwitchesRestored what the process runs with once it is over, after the CLI has answered the switches back', async () => {
  const run = async (
    restoring: Record<string, unknown>,
    before: (held: HeldRun) => void = () => {},
    endTurn: (held: HeldRun) => void = (held) => held.script.emit(resultFor([promptUuid(held, 1)])),
  ) => {
    const restored: unknown[] = [];
    const held = await startHeldRun(announcingPrompt(scheduleWakeup), SCHEDULED_OPTIONS);
    const next = sendNext(held, 'Post a summary', {
      ...SCHEDULED_OPTIONS, ...restoring, ...INHERIT_UNSET, ...RESTORE,
      onSwitchesRestored: (switchedBack: unknown) => { restored.push(switchedBack); },
    });
    try {
      await waitUntil(() => held.script.prompts.length === 2);
      await flush();
      before(held);
      held.script.emit(echo(promptUuid(held, 1), 'Post a summary'));
      endTurn(held);
      await waitUntil(() => next.settled());
      const heardAtTheEnd = restored.length;
      await flush();
      return { heardAtTheEnd, restored };
    } finally {
      await finish(held, [next.run]);
    }
  };

  const switchedBoth = await run({ model: 'opus', permissionMode: 'acceptEdits' });
  assert.equal(switchedBoth.heardAtTheEnd, 0, 'not before the CLI answers');
  assert.deepEqual(switchedBoth.restored, [{ model: 'sonnet', permissionMode: 'default' }]);
  assert.deepEqual((await run({ model: 'opus' })).restored, [{ model: 'sonnet', permissionMode: null }]);
  // A turn that ends in an error is over all the same.
  assert.deepEqual(
    (await run({ model: 'opus' }, () => {}, (held) => held.script.emit({ ...resultFor([promptUuid(held, 1)]), subtype: 'error_during_execution', is_error: true }))).restored,
    [{ model: 'sonnet', permissionMode: null }],
  );
  assert.deepEqual(
    (await run({ model: 'opus' }, (held) => held.script.setSwitchAnswer('refuse'))).restored,
    [{ model: 'opus', permissionMode: null }],
    'a switch back the CLI refuses leaves the process on the turn\'s model',
  );
  assert.deepEqual((await run({})).restored, [{ model: null, permissionMode: null }], 'a turn that switches nothing hears it too');
  // The wake-up fires ahead of the message and sets no other: the process lets go after the turn.
  assert.deepEqual((await run({ model: 'opus' }, (held) => {
    held.script.emit(lifecycle(randomUUID(), 'started'));
    held.script.emit(result());
  })).restored, [], 'a process that lets go is not switched back, nor reported');
});

test('a turn handed over with restoreSwitchesAfterTurn whose prompt the user takes back still tells its onSwitchesRestored what the process runs with, switched back or never switched', async () => {
  const cases: Array<[string, Record<string, unknown>, boolean, string[], Record<string, unknown>]> = [
    ['waiting for the CLI\'s own turn', { model: 'opus' }, true, [], { model: 'sonnet', permissionMode: null }],
    ['waiting for the CLI\'s own turn, both switched', { model: 'opus', permissionMode: 'acceptEdits' }, true, [], { model: 'sonnet', permissionMode: 'default' }],
    ['written, not started', { model: 'opus' }, false, ['setModel:opus', 'setModel:sonnet'], { model: 'sonnet', permissionMode: null }],
  ];
  for (const [label, restoring, waitsForCliTurn, switches, expected] of cases) {
    const restored: unknown[] = [];
    const held = await startHeldRun(announcingPrompt(scheduleWakeup), SCHEDULED_OPTIONS);
    if (waitsForCliTurn) {
      // The wake-up fires: the message waits for its turn to end.
      held.script.emit(lifecycle(randomUUID(), 'started'));
      held.script.emit(assistantText('Checking the build again.'));
      await flush();
    }
    const next = sendNext(held, 'Post a summary', {
      ...SCHEDULED_OPTIONS, ...restoring, ...INHERIT_UNSET, ...RESTORE,
      onSwitchesRestored: (switchedBack: unknown) => { restored.push(switchedBack); },
    });
    try {
      await waitUntil(() => held.first.handOverReports() === 1);
      await flush();
      assert.equal(held.script.prompts.length, waitsForCliTurn ? 1 : 2, label);
      assert.equal(await abortClaudeSDKSession(held.sessionId), true, label);
      await waitUntil(() => next.settled());
      await flush();
      assert.deepEqual(switchCalls(held), switches, label);
      assert.deepEqual(restored, [expected], label);
      if (waitsForCliTurn) {
        // The wake-up's turn sets the next one and ends: the loop keeps its process.
        scheduleWakeup(held.script, 'toolu_wakeup_2');
        held.script.emit(result());
        await flush();
      }
      assert.equal(held.script.released(), false, label);
      assert.deepEqual(restored, [expected], `${label}: heard once`);
    } finally {
      await finish(held, [next.run]);
    }
  }
});

test('a turn with restoreSwitchesAfterTurn stopped while its hand-over makes its lookups tells its onSwitchesRestored once that nothing was switched', async () => {
  for (const lookupFails of [false, true]) {
    const label = lookupFails ? 'a lookup then fails' : 'the lookups then finish';
    const restored: unknown[] = [];
    const held = await startHeldRun(announcingPrompt(scheduleWakeup), SCHEDULED_OPTIONS);
    let settleLookup: () => void = () => {};
    const modelLookup = new Promise<undefined>((resolve, reject) => {
      settleLookup = () => (lookupFails ? reject(new Error('database is locked')) : resolve(undefined));
    });
    const next = sendNext(held, 'Post a summary', {
      ...SCHEDULED_OPTIONS, model: 'opus', ...INHERIT_UNSET, ...RESTORE,
      onSwitchesRestored: (switchedBack: unknown) => { restored.push(switchedBack); },
    }, createWriter(2), { ...held.context, resolveResumeModel: () => modelLookup });
    try {
      await flush();
      assert.equal(await abortClaudeSDKSession(held.sessionId), true, label);
      settleLookup();
      await waitUntil(() => next.settled());
      await flush();
      assert.deepEqual(switchCalls(held), [], `${label}: the held process is not switched`);
      assert.equal(held.script.prompts.length, 1, `${label}: the turn never goes in`);
      assert.deepEqual(restored, [{ model: null, permissionMode: null }], label);
      assert.equal(held.script.released(), false, label);
    } finally {
      await finish(held, [next.run]);
    }
  }
});

/** A notification as a desktop app socket received it: `[code, title]`. */
type DeliveredNotification = [string, string];

/**
 * Runs a test with notifications on: an isolated database holds a user whose
 * notifications reach only a desktop app socket (Web Push off), every event
 * switch on. Writers built with the user id report to it.
 */
async function withNotifications(
  runTest: (capture: { userId: number; delivered: () => DeliveredNotification[] }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-held-turn-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  const frames: Array<{ payload: { title: string; data: { code: string } } }> = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (message: string) => { frames.push(JSON.parse(message)); },
    close: () => undefined,
  } as unknown as WebSocket;
  try {
    await initializeDatabase();
    const userId = Number(userDb.createUser('held-turn-notifications', 'password-hash').id);
    notificationPreferencesDb.updatePreferences(userId, {
      channels: { webPush: false, desktop: true },
      events: { actionRequired: true, stop: true, error: true },
    });
    registerDesktopNotificationClient({ userId, deviceId: 'held-turn-device', ws: socket });
    await runTest({
      userId,
      delivered: () => frames.map((frame): DeliveredNotification => [frame.payload.data.code, frame.payload.title]),
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

for (const reportsAhead of [false, true]) {
  test(`each turn's notifications carry its own session name, and the work's end the turn it belongs to (${reportsAhead ? 'relayed ahead of the new turn' : 'outlasting the new turn'})`, async () => {
    await withNotifications(async ({ userId, delivered }) => {
      const held = await startHeldRun(launchWorkflow, { sessionSummary: 'Start the audit' }, { first: createWriter(1, userId) });
      if (reportsAhead) {
        held.script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
        await flush();
      }
      const next = sendNext(held, 'Check the logs', { sessionSummary: 'Check the logs' }, createWriter(2, userId));
      try {
        await waitUntil(() => held.script.prompts.length === 2);
        if (reportsAhead) {
          held.script.emit(relayResult());
        }
        held.script.emit(echo(promptUuid(held, 1), 'Check the logs'));
        held.script.emit(result());
        if (!reportsAhead) {
          held.script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
          held.script.emit(relayResult());
        }
        await flush();
        assert.deepEqual(delivered(), reportsAhead
          ? [
            ['run.stopped', 'Start the audit'],
            ['run.background_completed', 'Start the audit'],
            ['run.stopped', 'Check the logs'],
          ]
          : [
            ['run.stopped', 'Start the audit'],
            ['run.stopped', 'Check the logs'],
            ['run.background_completed', 'Check the logs'],
          ]);
      } finally {
        await finish(held, [next.run]);
      }
    });
  });
}

/** A socket in the gateway's broadcast set, as every connected tab's is. */
class FakeConnection {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withRegistry(runTest: (tab: FakeConnection) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-held-turn-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  const tab = new FakeConnection();
  connectedClients.add(tab as never);
  chatRunRegistry.setRetentionGuard((appSessionId) => listClaudeSDKBackgroundWork().some((entry) => entry.sessionId === appSessionId));
  try {
    await runTest(tab);
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    chatRunRegistry.setRetentionGuard(() => false);
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

const runEnds = (tab: FakeConnection) => tab.frames
  .filter((frame) => frame.kind === 'run_ended')
  .map((frame) => [frame.runStartedAt, frame.outcome, frame.backgroundWork]);

for (const reportsAhead of [false, true]) {
  test(`through the run registry, each run ends once and the work once (${reportsAhead ? 'work relayed ahead of the new turn' : 'work outlasting the new turn'})`, async () => {
    await withRegistry(async (tab) => {
      const sessionId = `app-held-turn-${randomUUID()}`;
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-held-turn-'));
      sessionsDb.createAppSession(sessionId, 'claude', cwd);
      const { createQuery, script } = createScriptedQuery();
      const later = createScriptedQuery();
      const context = createContext();
      const start = () => chatRunRegistry.startRun({ appSessionId: sessionId, provider: 'claude', providerSessionId: null, connection: null, userId: null });

      const firstRun = start();
      assert.ok(firstRun);
      const firstQuery = queryClaudeSDK('Start', { sessionId, cwd }, firstRun.writer, { ...context, createQuery });
      try {
        await waitUntil(() => script.prompts.length === 1);
        script.emit(init());
        launchWorkflow(script);
        script.emit(result());
        await waitUntil(() => !chatRunRegistry.isProcessing(sessionId));
        if (reportsAhead) {
          script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
          await flush();
        }

        const secondRun = start();
        assert.ok(secondRun, 'the registry takes a send once the turn has completed');
        const secondQuery = queryClaudeSDK('Next', { sessionId, cwd }, secondRun.writer, { ...context, createQuery: later.createQuery });
        await waitUntil(() => script.prompts.length === 2);
        if (reportsAhead) {
          script.emit(relayResult());
          await flush();
        }
        script.emit(echo(String(script.prompts[1]?.uuid), 'Next'));
        script.emit(result());
        await secondQuery;
        if (!reportsAhead) {
          script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
          script.emit(relayResult());
        }
        await flush();

        assert.equal(later.script.created(), false);
        assert.deepEqual(runEnds(tab), reportsAhead
          ? [
            [firstRun.startedAt, 'done', true],
            [firstRun.startedAt, 'backgroundDone', false],
            [secondRun.startedAt, 'done', false],
          ]
          : [
            [firstRun.startedAt, 'done', true],
            [secondRun.startedAt, 'done', true],
            [secondRun.startedAt, 'backgroundDone', false],
          ]);
      } finally {
        script.end();
        later.script.end();
        await firstQuery;
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });
}

test('a stopped handed-over turn leaves the work\'s end to the run that left it, which hears of each later hand-over too', async () => {
  const held = await startHeldRun();
  const stopped = sendNext(held, 'Look at the logs');
  const runs: Array<Promise<unknown>> = [stopped.run];
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(echo(promptUuid(held, 1), 'Look at the logs'));
    const aborting = abortClaudeSDKSession(held.sessionId);
    await waitUntil(() => held.script.calls.includes('interrupt'));
    held.script.emit(interruptedResultFor(promptUuid(held, 1)));
    assert.equal(await aborting, true);
    assert.equal(held.first.handOverReports(), 1);

    const next = await runHandedOverTurn(held, 'Now the docs', () => held.script.emit(assistantText('Done.')));
    runs.push(next.run);
    assert.deepEqual([held.first.handOverReports(), stopped.writer.handOverReports()], [2, 1], 'the first run hears of the second hand-over too');
    relayFinishedTask(held.script, 'wf1', 'toolu_wf');
    await flush();
    assert.deepEqual([held.first.finishedReports(), stopped.writer.finishedReports(), next.writer.finishedReports()], [0, 0, 1]);
  } finally {
    await finish(held, runs);
  }
});

for (const variant of ['a later turn queued behind the relay', 'every later turn stopped too'] as const) {
  test(`through the run registry, the work a stopped handed-over turn did not leave still ends as the first run's (${variant})`, async () => {
    await withRegistry(async (tab) => {
      const sessionId = `app-held-turn-${randomUUID()}`;
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-held-turn-'));
      sessionsDb.createAppSession(sessionId, 'claude', cwd);
      const { createQuery, script } = createScriptedQuery();
      const laterQueries: Array<ReturnType<typeof createScriptedQuery>> = [];
      const context = createContext();
      const queries: Array<Promise<unknown>> = [];
      const start = async () => {
        // Runs that start in the same millisecond would share their run-end key.
        await new Promise<void>((resolve) => { setTimeout(resolve, 3); });
        const run = chatRunRegistry.startRun({ appSessionId: sessionId, provider: 'claude', providerSessionId: null, connection: null, userId: null });
        assert.ok(run);
        return run;
      };
      const send = async (text: string) => {
        const run = await start();
        const later = createScriptedQuery();
        laterQueries.push(later);
        const index = script.prompts.length;
        queries.push(queryClaudeSDK(text, { sessionId, cwd }, run.writer, { ...context, createQuery: later.createQuery }));
        await waitUntil(() => script.prompts.length === index + 1);
        return { run, uuid: String(script.prompts[index]?.uuid) };
      };
      const stop = async (uuid: string) => {
        const interrupts = script.calls.filter((call) => call === 'interrupt').length;
        const aborting = chatRunRegistry.abortRun(sessionId, (_provider, id) => abortClaudeSDKSession(id));
        await waitUntil(() => script.calls.filter((call) => call === 'interrupt').length === interrupts + 1);
        script.emit(interruptedResultFor(uuid));
        assert.equal(await aborting, true);
        await flush();
      };

      const firstRun = await start();
      queries.push(queryClaudeSDK('Start', { sessionId, cwd }, firstRun.writer, { ...context, createQuery }));
      try {
        await waitUntil(() => script.prompts.length === 1);
        script.emit(init());
        launchWorkflow(script);
        script.emit(result());
        await waitUntil(() => !chatRunRegistry.isProcessing(sessionId));

        const second = await send('Look at the logs');
        script.emit(echo(second.uuid, 'Look at the logs'));
        await stop(second.uuid);

        let third: Awaited<ReturnType<typeof send>>;
        if (variant === 'a later turn queued behind the relay') {
          // The workflow finishes and the CLI starts relaying it; the next
          // message waits behind that turn.
          script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
          script.emit(notificationEcho('wf1', 'toolu_wf'));
          script.emit(assistantText('wf1 is done.'));
          third = await send('Now the docs');
          script.emit(relayResult());
          script.emit(echo(third.uuid, 'Now the docs'));
          script.emit(resultFor([third.uuid]));
        } else {
          third = await send('Now the docs');
          script.emit(echo(third.uuid, 'Now the docs'));
          await stop(third.uuid);
          relayFinishedTask(script, 'wf1', 'toolu_wf');
        }
        await waitUntil(() => runEnds(tab).length === 4);
        await flush();

        // A stopped turn's end says the work goes on (`backgroundWork`).
        assert.deepEqual(runEnds(tab), variant === 'a later turn queued behind the relay'
          ? [
            [firstRun.startedAt, 'done', true],
            [second.run.startedAt, 'aborted', true],
            [firstRun.startedAt, 'backgroundDone', false],
            [third.run.startedAt, 'done', false],
          ]
          : [
            [firstRun.startedAt, 'done', true],
            [second.run.startedAt, 'aborted', true],
            [third.run.startedAt, 'aborted', true],
            [firstRun.startedAt, 'backgroundDone', false],
          ]);
        assert.equal(chatRunRegistry.listRecentRunEnds().filter((end) => end.outcome === 'backgroundDone').length, 1);
        assert.equal(laterQueries.some((later) => later.script.created()), false, 'every turn went into the held process');
      } finally {
        script.end();
        for (const later of laterQueries) {
          later.script.end();
        }
        await Promise.all(queries);
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });
}

/** A record store like the database's for the runtime's holds for scheduled work: one row per session. */
function createHoldRecords() {
  const rows = new Map<string, { runId: string }>();
  const removed: string[] = [];
  const scheduleHolds: NonNullable<ProviderRuntimeContext['scheduleHolds']> = {
    save: (record) => { rows.set(record.sessionId, { runId: record.runId }); },
    remove: (sessionId, runId) => {
      removed.push(runId);
      if (rows.get(sessionId)?.runId === runId) {
        rows.delete(sessionId);
      }
    },
  };
  return { rows, removed, scheduleHolds };
}

test('a turn a process held for cron jobs alone cannot take starts a process of its own without a notice, takes what it leaves out from the held process, and takes the record of the hold over', async () => {
  const records = createHoldRecords();
  // The new CLI resumes the session and brings the job back from the transcript.
  let revives = false;
  const context = createContext({
    resolveProviderSessionId: () => NATIVE_ID,
    scheduleHolds: records.scheduleHolds,
    readRevivedCronJobs: async () => (revives
      ? [{ jobId: 'b2148320', toolUseId: 'toolu_cron_b2148320', cron: '*/5 * * * *', prompt: 'check the deploy', recurring: true, createdAt: Date.now() - MINUTE, humanSchedule: 'Every 5 minutes', predictable: true }]
      : []),
  });
  const launch = { model: 'opus', effort: 'high', permissionMode: 'acceptEdits', ...toolsSettings(['Bash(git status:*)', 'WebFetch'], [], false) };
  const held = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'b2148320')), launch, { context });
  // The user has stopped allowing WebFetch since the loop started.
  const turn = { model: 'opus', effort: 'high', ...toolsSettings(['Bash(git status:*)'], [], false) };
  const heldRunId = records.rows.get(held.sessionId)?.runId;
  let next: ReturnType<typeof sendNext> | null = null;
  try {
    assert.equal(typeof heldRunId, 'string', 'the hold is recorded');
    assert.deepEqual(
      await claudeRuntime.planHandOver(held.sessionId, { sessionId: held.sessionId, cwd: held.cwd, ...turn }, INHERIT_UNSET),
      {
        heldWork: true,
        canHandOver: false,
        changes: ['tools'],
        switches: [],
        details: { tools: { notAllowed: ['WebFetch'], alsoDenied: [] } },
        replaceKeepsWork: true,
      },
    );

    revives = true;
    next = sendNext(held, 'Check the deploy again', { ...turn, inheritUnset: true });
    await waitUntil(() => held.script.released());
    assert.deepEqual(workStoppedNotices(next.writer.sent), [], 'nothing is said to have stopped');
    assert.equal(held.script.prompts.length, 1, 'nothing goes into the held process');
    assert.equal(records.rows.get(held.sessionId)?.runId, heldRunId, 'the record outlives the process it was written for');

    held.script.end();
    await waitUntil(() => Boolean(next?.later.script.created()));
    const options = next.later.script.options();
    assert.deepEqual(options?.allowedTools, ['Bash(git status:*)'], 'the turn\'s own tool rules');
    assert.equal(options?.permissionMode, 'acceptEdits', 'the mode it leaves out is the held process\'s');
    assert.equal(options?.resume, NATIVE_ID);

    await waitUntil(() => Boolean(next?.later.script.prompts.length));
    next.later.script.emit(init());
    next.later.script.emit(result());
    await waitUntil(() => completes(next!.writer.sent) === 1);
    assert.equal(next.later.script.released(), false, 'the new process is held for the job it brought back');
    assert.deepEqual(scheduledOf(held.sessionId).map((item) => item.id), ['cron:b2148320']);
    const newRunId = records.rows.get(held.sessionId)?.runId;
    assert.equal(typeof newRunId === 'string' && newRunId !== heldRunId, true, 'the new run wrote the record over');
  } finally {
    await finish(held, next ? [next.run] : []);
  }
});

test('a process of its own that brings no job back removes the record of the hold it took over', async () => {
  const records = createHoldRecords();
  const context = createContext({ scheduleHolds: records.scheduleHolds });
  const held = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'b2148320')), { model: 'opus', effort: 'high' }, { context });
  const next = sendNext(held, 'Think harder', { model: 'opus', effort: 'max' });
  try {
    await waitUntil(() => held.script.released());
    assert.equal(records.rows.size, 1);
    held.script.end();
    await waitUntil(() => next.later.script.prompts.length === 1);
    next.later.script.emit(init());
    next.later.script.emit(result());
    await waitUntil(() => completes(next.writer.sent) === 1);
    assert.equal(records.rows.size, 0, 'its process let go, and the record went with it');
  } finally {
    await finish(held, [next.run]);
  }
});

/** A cron job's fire as CLI 2.1.312 starts it, its `result` still to come. */
function startCronFire(script: Scripted): void {
  script.emit(lifecycle(randomUUID(), 'started', { wakeup_source: 'schedule_wakeup' }));
  script.emit(init());
  script.emit(assistantText('Running the tests.'));
}

/** Starts a job's fire (startCronFire) and settles once the held run has read it: the CLI is in a turn of its own. */
async function cronFireUnderWay(held: HeldRun): Promise<void> {
  const seen = assistantTexts(held.first.sent).length;
  startCronFire(held.script);
  await waitUntil(() => assistantTexts(held.first.sent).length === seen + 1);
}

/**
 * Counts the turns that start waiting for the turn the CLI runs on its own
 * to be over (handTurnToHeldProcess logs each as it starts to wait), so a
 * test acts once a send waits, not while it still makes its lookups.
 */
function countCliTurnWaits(t: import('node:test').TestContext): () => number {
  let count = 0;
  const log = console.log.bind(console);
  t.mock.method(console, 'log', (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('it waits for the turn the CLI runs on its own to be over')) {
      count += 1;
    }
    log(...args);
  });
  return () => count;
}

test('while a job of a process held for cron jobs alone fires, a plan offers a process of the turn\'s own once the fire is over, and a turn sent then waits for the fire\'s end before replacing that process', async (t) => {
  const waits = countCliTurnWaits(t);
  const held = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'b2148320')), { model: 'opus', effort: 'high' });
  const turn = { model: 'opus', effort: 'max' };
  const plan = () => claudeRuntime.planHandOver(held.sessionId, { sessionId: held.sessionId, cwd: held.cwd, ...turn });
  let next: ReturnType<typeof sendNext> | null = null;
  try {
    assert.deepEqual(
      await plan(),
      { heldWork: true, canHandOver: false, changes: ['effort'], switches: [], replaceKeepsWork: true },
      'between fires',
    );
    await cronFireUnderWay(held);
    // The send goes, and nothing asks: its run waits for the fire's end.
    assert.deepEqual(
      await plan(),
      { heldWork: true, canHandOver: false, changes: ['effort'], switches: [], replaceKeepsWork: true, afterCliTurn: true },
    );

    next = sendNext(held, 'Think harder', turn);
    await waitUntil(() => waits() === 1);
    assert.equal(held.script.calls.includes('interrupt'), false, 'the fire is not interrupted');
    assert.equal(held.script.released(), false);
    assert.equal(next.later.script.created(), false, 'no process of its own yet');

    held.script.emit(result());
    await waitUntil(() => held.script.released());
    assert.deepEqual(workStoppedNotices(next.writer.sent), [], 'nothing is said to have stopped');
    assert.equal(held.script.prompts.length, 1, 'nothing goes into the held process');
    held.script.end();
    await waitUntil(() => Boolean(next?.later.script.created()));
    assert.equal(next.later.script.options()?.effort, 'max');
    assert.equal(waits(), 1, 'it waited once');
  } finally {
    await finish(held, next ? [next.run] : []);
  }
});

test('a turn waiting for a fire\'s end is stopped alone by an abort, and starts a plain process of its own when the fire ends the last job', async (t) => {
  const waits = countCliTurnWaits(t);
  const held = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'b2148320')), { model: 'opus', effort: 'high' });
  const runs: Array<Promise<unknown>> = [];
  try {
    await cronFireUnderWay(held);
    const stopped = sendNext(held, 'Think harder', { model: 'opus', effort: 'max' });
    runs.push(stopped.run);
    await waitUntil(() => waits() === 1);
    assert.equal(await abortClaudeSDKSession(held.sessionId), true);
    await waitUntil(() => stopped.settled());
    assert.equal(stopped.later.script.created(), false, 'it starts no process of its own');
    assert.deepEqual(held.script.calls.filter((call) => !call.startsWith('prompt:')), [], 'the held process and its fire are left alone');

    const next = sendNext(held, 'Think harder', { model: 'opus', effort: 'max', keepBackgroundWork: true });
    runs.push(next.run);
    await waitUntil(() => waits() === 2);
    deleteCronJob(held.script, 'b2148320');
    held.script.emit(result());
    await waitUntil(() => held.script.released());
    held.script.end();
    await waitUntil(() => next.later.script.created());
    assert.equal(held.script.calls.includes('interrupt'), false, 'a process that let go is sent nothing');
    assert.deepEqual(workStoppedNotices(next.writer.sent), [], 'no work was left to stop, nor a turn to fail');
  } finally {
    await finish(held, runs);
  }
});

test('a turn sent on the word that its process keeps the work fails, rather than stop the work the fire it waited for started, and leaves that work and the loop alone', async (t) => {
  const waits = countCliTurnWaits(t);
  const held = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'b2148320')), { model: 'opus', effort: 'high' });
  const switchedBack: unknown[] = [];
  const writer = createWriter(2);
  const later = createScriptedQuery();
  held.laterQueries.push(later);
  const options = {
    sessionId: held.sessionId,
    cwd: held.cwd,
    model: 'opus',
    effort: 'max',
    keepBackgroundWork: true,
    restoreSwitchesAfterTurn: true,
    onSwitchesRestored: (restored: unknown) => { switchedBack.push(restored); },
  };
  try {
    await cronFireUnderWay(held);
    const thrown = queryClaudeSDK('Think harder', options, writer.writer as never, { ...held.context, createQuery: later.createQuery })
      .then(() => null, (error: Error & { code?: unknown; reason?: unknown }) => error);
    await waitUntil(() => waits() === 1);
    // The fire backgrounds a command before its turn ends.
    launchBackgroundCommand(held.script);
    held.script.emit(result());

    const error = await thrown;
    const content = 'Not sent: this message changes the reasoning effort, which only a new Claude process can apply, and the turn Claude ran on its own meanwhile started work a new process would stop.';
    assert.deepEqual([error?.message, error?.code, error?.reason], [content, 'HAND_OVER_FAILED', 'work-started']);
    assert.deepEqual(
      writer.sent.filter((message) => message.kind === 'error').map((message) => [message.code, message.reason, message.changes, message.content]),
      [['HAND_OVER_FAILED', 'work-started', ['effort'], content]],
      'the turn\'s run hears why, and nothing is said to have stopped',
    );
    await flush();
    assert.deepEqual(switchedBack, [{ model: null, permissionMode: null }], 'the gateway hears that nothing was switched');
    assert.equal(later.script.created(), false, 'no new CLI');
    assert.equal(held.script.prompts.length, 1, 'nothing goes into the held process');
    assert.deepEqual(held.script.calls.filter((call) => !call.startsWith('prompt:')), [], 'nothing is interrupted, stopped or released');
    assert.deepEqual(listedTaskIds(held.sessionId), ['bg1']);
    assert.deepEqual(scheduledOf(held.sessionId).map((item) => item.id), ['cron:b2148320']);
  } finally {
    await finish(held);
  }
});

test('a turn sent on the word that its process keeps the work fails, rather than stop it, when the fire under way starts work while the turn makes its lookups', async () => {
  for (const fireEnds of [false, true]) {
    const label = fireEnds ? 'the fire over by the hand-over' : 'the fire still under way at the hand-over';
    const held = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'b2148320')), { model: 'opus', effort: 'high' });
    // Holds the turn's lookups until the fire has started a task.
    let lookUp = () => {};
    const lookedUp = new Promise<void>((resolve) => { lookUp = resolve; });
    let lookups = 0;
    const context = createContext({
      getProviderModels: async () => {
        lookups += 1;
        await lookedUp;
        return CLAUDE_PREDEFINED_MODELS as never;
      },
    });
    const turn = { model: 'opus', effort: 'max' };
    const writer = createWriter(2);
    const later = createScriptedQuery();
    held.laterQueries.push(later);
    let thrown: Promise<(Error & { code?: unknown; reason?: unknown }) | null> | null = null;
    try {
      await cronFireUnderWay(held);
      assert.deepEqual(
        await claudeRuntime.planHandOver(held.sessionId, { sessionId: held.sessionId, cwd: held.cwd, ...turn }),
        { heldWork: true, canHandOver: false, changes: ['effort'], switches: [], replaceKeepsWork: true, afterCliTurn: true },
        label,
      );
      thrown = queryClaudeSDK(
        'Think harder',
        { sessionId: held.sessionId, cwd: held.cwd, ...turn, keepBackgroundWork: true },
        writer.writer as never,
        { ...context, createQuery: later.createQuery },
      ).then(() => null, (error: Error & { code?: unknown; reason?: unknown }) => error);
      const settled = track(thrown);
      await waitUntil(() => lookups === 1);
      // The fire backgrounds a command before the turn is handed over.
      launchBackgroundCommand(held.script);
      if (fireEnds) {
        held.script.emit(result());
      }
      await flush();
      lookUp();
      await waitUntil(() => settled() || held.script.calls.includes('interrupt'));

      assert.deepEqual(held.script.calls.filter((call) => !call.startsWith('prompt:')), [], `${label}: nothing is interrupted, stopped or released`);
      const error = await thrown;
      assert.deepEqual([error?.code, error?.reason], ['HAND_OVER_FAILED', 'work-started'], label);
      assert.deepEqual(
        writer.sent.filter((message) => message.kind === 'error').map((message) => [message.code, message.reason, message.changes]),
        [['HAND_OVER_FAILED', 'work-started', ['effort']]],
        `${label}: the turn's run hears why, and nothing is said to have stopped`,
      );
      assert.equal(later.script.created(), false, `${label}: no new CLI`);
      assert.equal(held.script.prompts.length, 1, `${label}: nothing goes into the held process`);
      assert.deepEqual(listedTaskIds(held.sessionId), ['bg1'], label);
      assert.deepEqual(scheduledOf(held.sessionId).map((item) => item.id), ['cron:b2148320'], label);
    } finally {
      lookUp();
      await finish(held, thrown ? [thrown] : []);
    }
  }
});

test('a turn sent without that word still replaces the process once the fire it waited for is over, and says the work the fire started stopped', async (t) => {
  const waits = countCliTurnWaits(t);
  const held = await startHeldRun(announcingPrompt((script) => createCronJob(script, 'b2148320')), { model: 'opus', effort: 'high' });
  let next: ReturnType<typeof sendNext> | null = null;
  try {
    await cronFireUnderWay(held);
    next = sendNext(held, 'Think harder', { model: 'opus', effort: 'max' });
    await waitUntil(() => waits() === 1);
    launchBackgroundCommand(held.script);
    held.script.emit(result());
    await waitUntil(() => held.script.released());
    held.script.end();
    await waitUntil(() => Boolean(next?.later.script.created()));
    assert.deepEqual(workStoppedNotices(next.writer.sent).map(([code, changes]) => [code, changes]), [['BACKGROUND_WORK_STOPPED', ['effort']]]);
  } finally {
    await finish(held, next ? [next.run] : []);
  }
});

test('a turn that was to take its settings from the held process runs with its own when that process lets go before the hand-over', async () => {
  const held = await startHeldRun(
    announcingPrompt((script) => createCronJob(script, 'b2148320')),
    { model: 'opus', effort: 'high', permissionMode: 'plan', ...toolsSettings(['Read'], [], false) },
  );
  // Holds the turn's lookups until the process has let go.
  let lookUp = () => {};
  const lookedUp = new Promise<void>((resolve) => { lookUp = resolve; });
  let lookups = 0;
  const context = createContext({
    getProviderModels: async () => {
      lookups += 1;
      await lookedUp;
      return CLAUDE_PREDEFINED_MODELS as never;
    },
  });
  const own = { model: 'sonnet', effort: 'low', permissionMode: 'acceptEdits', toolsSettings: { allowedTools: ['Bash(git status:*)'], disallowedTools: [], skipPermissions: false } };
  // A message sent with the held process's settings, as the scheduled-messages dispatcher sends it.
  const next = sendNext(held, 'Post the summary', { inheritUnset: true, restoreSwitchesAfterTurn: true, keepBackgroundWork: true, ownSettings: own }, createWriter(2), context);
  try {
    await waitUntil(() => lookups === 1);
    // The loop's last fire deletes its job, and the process lets go.
    startCronFire(held.script);
    deleteCronJob(held.script, 'b2148320');
    held.script.emit(result());
    await waitUntil(() => held.script.released());
    held.script.end();
    lookUp();

    await waitUntil(() => next.later.script.created());
    const options = next.later.script.options();
    assert.deepEqual(
      [options?.model, options?.effort, options?.permissionMode, options?.allowedTools],
      ['sonnet', 'low', 'acceptEdits', ['Bash(git status:*)']],
      'the message\'s own settings, not the defaults',
    );
    assert.equal(held.script.prompts.length, 1, 'nothing went into the process that let go');
  } finally {
    lookUp();
    await finish(held, [next.run]);
  }
});

test('a process held for a wake-up, a durable job, a task or a Monitor as well, or a turn in another working directory, gets no process of the turn\'s own that keeps the work', async () => {
  const cases: Array<[string, (script: Scripted) => void, Record<string, unknown>]> = [
    ['a wake-up', (script) => { createCronJob(script, 'b2148320'); scheduleWakeup(script); }, {}],
    ['a durable job', (script) => createCronJob(script, 'b2148320', { durable: true }), {}],
    ['a task', (script) => { createCronJob(script, 'b2148320'); launchWorkflow(script); }, {}],
    ['a Monitor', (script) => { createCronJob(script, 'b2148320'); launchUntrackedMonitor(script); }, {}],
    ['another working directory', (script) => createCronJob(script, 'b2148320'), { cwd: '/elsewhere' }],
  ];
  for (const [label, launch, extra] of cases) {
    const held = await startHeldRun(announcingPrompt(launch), { model: 'opus', effort: 'high' });
    try {
      const plan = await claudeRuntime.planHandOver(held.sessionId, { sessionId: held.sessionId, cwd: held.cwd, model: 'opus', effort: 'max', ...extra });
      assert.equal(plan.canHandOver, false, label);
      assert.equal(plan.replaceKeepsWork, undefined, label);
    } finally {
      await finish(held);
    }
  }
});

test('a process launched in plan mode has canUseTool allow what plan mode allows, and only while it is in plan mode', async () => {
  const held = await startHeldRun(announcingPrompt(scheduleWakeup), { permissionMode: 'plan', ...toolsSettings([], [], false) });
  const canUseTool = held.script.options()?.canUseTool as CanUseTool;
  try {
    assert.deepEqual(held.script.options()?.allowedTools, [], 'no launch rule is added for plan mode');
    for (const tool of ['WebFetch', 'WebSearch', 'Read']) {
      assert.equal((await canUseTool(tool, {}, {})).behavior, 'allow', tool);
    }
    // A write in plan mode is the user's to allow: the CLI does not stop it.
    void canUseTool('Bash', { command: 'touch x' }, {});
    await flush();
    const asked = held.first.sent.filter((message) => message.kind === 'permission_request');
    assert.deepEqual(asked.map((message) => message.toolName), ['Bash']);
    claudeRuntime.permissions.resolve(String(asked[0]?.requestId), { allow: false });

    // Out of plan mode for a turn, the same tools are asked about.
    const next = sendNext(held, 'Go ahead', { permissionMode: 'default', ...toolsSettings([], [], false) });
    await waitUntil(() => held.script.prompts.length === 2);
    assert.equal(next.later.script.created(), false, 'the turn goes into the held process');
    assert.equal(held.script.calls.includes('setPermissionMode:default'), true);
    await flush();
    void canUseTool('WebFetch', { url: 'https://example.com' }, {});
    await flush();
    const askedNow = next.writer.sent.filter((message) => message.kind === 'permission_request');
    assert.deepEqual(askedNow.map((message) => message.toolName), ['WebFetch']);
    claudeRuntime.permissions.resolve(String(askedNow[0]?.requestId), { allow: false });
    await finish(held, [next.run]);
  } catch (error) {
    await finish(held);
    throw error;
  }
});

test('a process launched skipping permissions may switch to bypassPermissions for a turn; one the CLI refuses that switch tells the turn, and no plan counts on it again', async () => {
  const plain = await startHeldRun(announcingPrompt(scheduleWakeup), { permissionMode: 'default' });
  try {
    assert.equal(plain.script.options()?.allowDangerouslySkipPermissions, undefined, 'only when the user skips permissions');
  } finally {
    await finish(plain);
  }

  const held = await startHeldRun(announcingPrompt(scheduleWakeup), { permissionMode: 'plan', ...toolsSettings([], [], true) });
  const plan = () => claudeRuntime.planHandOver(held.sessionId, { sessionId: held.sessionId, cwd: held.cwd, permissionMode: 'default', ...toolsSettings([], [], true) });
  let next: ReturnType<typeof sendNext> | null = null;
  try {
    assert.equal(held.script.options()?.permissionMode, 'plan', 'it runs in the mode it was launched in');
    assert.equal(held.script.options()?.allowDangerouslySkipPermissions, true);
    assert.deepEqual(await plan(), { heldWork: true, canHandOver: true, changes: [], switches: ['permissionMode'] });

    held.script.setSwitchAnswer('refuse');
    next = sendNext(held, 'Fix it', { permissionMode: 'default', ...toolsSettings([], [], true) });
    await waitUntil(() => held.script.prompts.length === 2);
    await flush();
    assert.equal(held.script.calls.includes('setPermissionMode:bypassPermissions'), true);
    const notices = next.writer.sent.filter((message) => message.kind === 'error');
    assert.deepEqual(notices.map((message) => [message.code, message.reason]), [['PERMISSION_MODE_NOT_SWITCHED', 'plan']]);
    held.script.emit(echo(promptUuid(held, 1), 'Fix it'));
    held.script.emit(resultFor([promptUuid(held, 1)]));
    await waitUntil(() => Boolean(next?.settled()));
    assert.deepEqual(await plan(), {
      heldWork: true,
      canHandOver: false,
      changes: ['permissionMode'],
      switches: [],
      details: { permissionMode: { process: 'plan', message: 'bypassPermissions', reason: 'bypass_not_allowed' } },
    });
  } finally {
    await finish(held, next ? [next.run] : []);
  }
});
