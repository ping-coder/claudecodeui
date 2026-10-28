import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
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

  const answerSwitch = (call: string) => {
    calls.push(call);
    return switchAnswer === 'ok' ? Promise.resolve() : Promise.reject(new Error(`refused ${call}`));
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
        return true;
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
const assistantText = (text: string) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const echo = (uuid: string, content: string) => ({
  type: 'user', isReplay: true, uuid, session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'user', content },
});
const lifecycle = (commandUuid: string, state: string) => ({
  type: 'command_lifecycle', uuid: randomUUID(), session_id: NATIVE_ID, command_uuid: commandUuid, state,
});
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'done', duration_ms: 1, num_turns: 1 });
// The `result` of a turn the CLI runs to relay a finished task.
const relayResult = () => ({ ...result(), result: 'relayed', origin: { kind: 'task-notification' } });

const completes = (sent: NormalizedMessage[]) => sent.filter((message) => message.kind === 'complete').length;
const userTexts = (sent: NormalizedMessage[]) => sent.filter((message) => message.kind === 'text' && message.role === 'user');
const assistantTexts = (sent: NormalizedMessage[]) => sent
  .filter((message) => message.kind === 'text' && message.role === 'assistant')
  .map((message) => message.content);
const listedTaskIds = (sessionId: string) => listClaudeSDKBackgroundWork()
  .filter((entry) => entry.sessionId === sessionId)
  .flatMap((entry) => entry.tasks.map((task) => task.taskId));

const MINUTE = 60 * 1000;
// The runtime's default; the tests run without the env override.
const HOLD_IDLE_MS = 30 * MINUTE;

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
 */
async function startHeldRun(
  launch: (script: Scripted) => void = launchWorkflow,
  runOptions: Record<string, unknown> = {},
  {
    behaviour = {},
    first = createWriter(1),
    context = createContext(),
  }: { behaviour?: ScriptedBehaviour; first?: Writer; context?: Omit<ProviderRuntimeContext, 'createQuery'> } = {},
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
  assert.equal(script.released(), false, 'the first process is held for its work');
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

function launchMonitor(script: Scripted): void {
  script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
  script.emit(toolResult('toolu_monitor', 'Monitor started'));
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
  const held = await startHeldRun(launchMonitor);
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
  const held = await startHeldRun(launchMonitor);
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
      { heldWork: true, canHandOver: false, changes: ['cwd', 'effort', 'ultracode', 'tools', 'permissionMode'], switches: [] },
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
      { heldWork: true, canHandOver: false, changes: ['model', 'permissionMode'], switches: [] },
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
  const monitored = await startHeldRun(launchMonitor);
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
    assert.deepEqual(await plan(), { heldWork: true, canHandOver: false, changes: ['tools'], switches: [] }, 'read as it is, the message allows fewer tools');
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
      { heldWork: true, canHandOver: false, changes: ['tools'], switches: [] },
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

test('an abort before the handed-over prompt has started takes it back before interrupting', async () => {
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
    assert.deepEqual(calls, [`cancel:${promptUuid(held, 1)}`, 'interrupt', 'stop:wf1', 'release'], 'the CLI would run a queued prompt after the interrupt');
    assert.equal(next.settled(), true);
    assert.equal(completes(next.writer.sent), 0, 'the abort\'s caller sends the terminal complete');
  } finally {
    await finish(held, [next.run]);
  }
});

test('a turn the CLI ends ahead of the handed-over prompt while the user stops it reports no work finished', async (t) => {
  const held = await startHeldRun(launchWorkflow, {}, { behaviour: { interrupt: 'hang' } });
  // The workflow finishes, and the CLI starts relaying it.
  held.script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
  held.script.emit(assistantText('The workflow is done.'));
  await flush();
  const next = sendNext(held, 'Never mind');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const aborting = abortClaudeSDKSession(held.sessionId);
    await flush();
    // The interrupt is not answered yet; the relaying turn ends meanwhile.
    held.script.emit(relayResult());
    await flush();
    assert.deepEqual([held.first.finishedReports(), next.writer.finishedReports()], [0, 0], 'the session is being stopped, work and all');
    t.mock.timers.tick(5 * 1000);
    assert.equal(await aborting, true);
    assert.equal(completes(next.writer.sent), 0, 'the abort\'s caller sends the terminal complete');
  } finally {
    await finish(held, [next.run]);
  }
});

test('an abort once the handed-over turn has started interrupts it like any turn', async () => {
  const held = await startHeldRun();
  const next = sendNext(held, 'Go');
  try {
    await waitUntil(() => held.script.prompts.length === 2);
    held.script.emit(echo(promptUuid(held, 1), 'Go'));
    held.script.emit(assistantText('Going.'));
    await flush();
    assert.equal(await abortClaudeSDKSession(held.sessionId), true);
    await flush();
    assert.deepEqual(held.script.calls.filter((call) => !call.startsWith('prompt:')), ['interrupt', 'stop:wf1', 'release']);
    assert.equal(next.settled(), true);
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
  launchMonitor(held.script);
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
  const held = await startHeldRun(launchMonitor);
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
