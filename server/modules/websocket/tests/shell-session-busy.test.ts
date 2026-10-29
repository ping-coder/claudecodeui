import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, afterEach, before } from 'node:test';

import { WebSocket } from 'ws';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import type { BackgroundTaskSummary, LLMProvider, ScheduledWorkSummary, SessionHold } from '@/shared/types.js';

/**
 * The Shell tab must not start a CLI on a session CloudCLI itself still runs:
 * the CLI would be a second process writing the transcript, and it records
 * the background tasks still running in CloudCLI's process as stopped. These
 * drive handleShellConnection with fake sockets and ptys, a fake provider
 * runtime and the real chat run registry. What the real Claude runtime
 * reports through the provider runtime service is covered in the providers
 * module (claude-runtime-hold.test.ts).
 */

// A run the registry completes names its session from the database.
let databaseDirectory = '';
const previousDatabasePath = process.env.DATABASE_PATH;

before(async () => {
  databaseDirectory = await mkdtemp(path.join(os.tmpdir(), 'shell-session-busy-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(databaseDirectory, 'auth.db');
  await initializeDatabase();
});

after(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = previousDatabasePath;
  }
  await rm(databaseDirectory, { recursive: true, force: true });
});

afterEach(() => {
  chatRunRegistry.clearAll();
});

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: string[];
    send: (data: string) => void;
  };
  socket.readyState = WebSocket.OPEN;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(data);
  return socket;
}

type FakeSocket = ReturnType<typeof createFakeSocket>;

function createFakePty() {
  return {
    killed: false,
    onData() {
      return { dispose: () => undefined };
    },
    onExit() {
      return { dispose: () => undefined };
    },
    write() {},
    resize() {},
    kill() {
      this.killed = true;
    },
  };
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const task = (taskId: string, extra: Partial<BackgroundTaskSummary> = {}): BackgroundTaskSummary => ({
  taskId,
  toolUseId: `toolu_${taskId}`,
  taskType: 'local_workflow',
  description: `Task ${taskId}`,
  startedAt: 1,
  ...extra,
});

/**
 * A provider runtime stand-in: `holds` is what each session id is held for,
 * `calls` what was asked of it in order. A release can be made to wait
 * (`releaseGate`) and, unless `releaseKeepsHold`, drops the id's hold once done.
 */
function createHarness({ providerSessionId = 'native-1' as string | null } = {}) {
  const holds = new Map<string, SessionHold>();
  const calls: string[] = [];
  const askedIds: string[] = [];
  const spawned: string[] = [];
  const ptys: Array<ReturnType<typeof createFakePty>> = [];
  const state = {
    queued: false,
    releaseGate: null as Promise<void> | null,
    releaseKeepsHold: false,
  };
  const runtime = {
    describeSessionHold: (sessionId: string) => {
      askedIds.push(sessionId);
      return holds.get(sessionId) ?? null;
    },
    abort: async (provider: LLMProvider, sessionId: string) => {
      calls.push(`abort:${provider}:${sessionId}`);
      return true;
    },
    releaseSession: async (sessionId: string) => {
      calls.push(`release:${sessionId}`);
      if (state.releaseGate) {
        await state.releaseGate;
      }
      if (!state.releaseKeepsHold) {
        holds.delete(sessionId);
      }
    },
  };
  const dependencies = {
    resolveProviderSessionId: () => providerSessionId,
    spawnPty: (_shell: string, args: string | string[]) => {
      spawned.push(Array.isArray(args) ? args[args.length - 1] : args);
      const pty = createFakePty();
      ptys.push(pty);
      return pty as never;
    },
    runtime,
    hasQueuedMessage: () => state.queued,
  };
  return { holds, calls, askedIds, spawned, ptys, state, dependencies };
}

type Harness = ReturnType<typeof createHarness>;

let sessionCounter = 0;
// The pty map lives as long as the module does, so every test opens its own session.
const nextSessionId = (label: string) => `${label}-${(sessionCounter += 1)}-${Date.now()}`;

function connect(dependencies: Harness['dependencies']) {
  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  const init = (fields: Record<string, unknown>) => {
    socket.emit('message', JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      provider: 'claude',
      hasSession: true,
      cols: 80,
      rows: 24,
      ...fields,
    }));
  };
  return { socket, init };
}

const framesOf = (socket: FakeSocket) => socket.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
const busyFramesOf = (socket: FakeSocket) => framesOf(socket).filter((frame) => frame.type === 'session_busy');

/** What the client sends back with a takeover: the turn and every task id of the notice's frame. */
const snapshotOf = (frame: Record<string, unknown> | undefined) => ({
  turnStartedAt: frame?.turnStartedAt ?? null,
  taskIds: ((frame?.tasks ?? []) as BackgroundTaskSummary[]).map((summary) => summary.taskId),
});

/** What a client that shows scheduled work sends back: `snapshotOf`, and every scheduled work id of the frame. */
const scheduledSnapshotOf = (frame: Record<string, unknown> | undefined) => ({
  ...snapshotOf(frame),
  scheduledIds: ((frame?.scheduled ?? []) as ScheduledWorkSummary[]).map((item) => item.id),
});

/** One piece of scheduled work a held process lists for the session. */
const scheduledItem = (id: string, extra: Partial<ScheduledWorkSummary> = {}): ScheduledWorkSummary => ({
  id,
  kind: id.startsWith('cron:') ? 'cron' : 'wakeup',
  toolUseId: `toolu_${id.replace(/\W/g, '')}`,
  prompt: 'check the deploy',
  startedAt: 1,
  nextFireAt: 60_001,
  recurring: true,
  holdUntil: 691_200_001,
  ...extra,
});

/**
 * Opens the Shell on a session the way the client does: the first init gets
 * the busy notice, and `takeOver` sends that notice's snapshot back.
 */
function openNotice(dependencies: Harness['dependencies'], sessionId: string) {
  const connection = connect(dependencies);
  connection.init({ sessionId });
  const notice = busyFramesOf(connection.socket).at(-1);
  assert.ok(notice, 'the first init gets a busy notice');
  const takeOver = (fields: Record<string, unknown> = {}) => {
    connection.init({ sessionId, takeOver: snapshotOf(notice), ...fields });
  };
  return { ...connection, notice, takeOver };
}

const startTurn = (sessionId: string, provider: LLMProvider = 'claude') => {
  const run = chatRunRegistry.startRun({ appSessionId: sessionId, provider, providerSessionId: null, connection: null, userId: null });
  assert.ok(run, 'the turn starts');
  return run;
};

async function flush(rounds = 10): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!condition() && performance.now() < deadline) {
    await flush(1);
  }
  assert.equal(condition(), true, 'condition never became true');
}

test('a resume of a session held for background work starts no CLI and says why, in one frame', () => {
  const harness = createHarness();
  const sessionId = nextSessionId('background');
  harness.holds.set(sessionId, { processState: 'running', tasks: [task('wf1', { workflowName: 'audit' })] });

  const { socket, init } = connect(harness.dependencies);
  init({ sessionId });

  assert.deepEqual(harness.spawned, []);
  const frames = framesOf(socket);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 'session_busy');
  assert.equal(frames[0].sessionId, sessionId);
  assert.equal(frames[0].provider, 'claude');
  assert.equal(frames[0].reason, 'background');
  assert.equal((frames[0].tasks as BackgroundTaskSummary[])[0].workflowName, 'audit');
  assert.equal(frames[0].hasQueuedMessage, false);
  assert.equal(frames[0].turnStartedAt, null);
  assert.equal(frames[0].changed, false);
  assert.equal('initId' in frames[0], false, 'an init without a number gets none back');
});

test('the notice names the running turn by its start, and answers the init it was asked by', () => {
  const harness = createHarness();
  const sessionId = nextSessionId('turn-identity');
  const run = startTurn(sessionId);

  const { socket, init } = connect(harness.dependencies);
  init({ sessionId, initId: 7 });
  init({ sessionId, initId: 8 });
  const frames = busyFramesOf(socket);
  assert.deepEqual(frames.map((frame) => frame.turnStartedAt), [run.startedAt, run.startedAt]);
  assert.deepEqual(frames.map((frame) => frame.initId), [7, 8]);
});

test('the reason is the first that applies: turn, exiting, background, held, queued', () => {
  const harness = createHarness();
  const reasonFor = (setUp: (sessionId: string) => void) => {
    const sessionId = nextSessionId('reason');
    setUp(sessionId);
    const { socket, init } = connect(harness.dependencies);
    init({ sessionId });
    const [frame] = busyFramesOf(socket);
    harness.state.queued = false;
    return frame ? [frame.reason, frame.hasQueuedMessage] : null;
  };
  const startRun = (sessionId: string) => {
    chatRunRegistry.startRun({ appSessionId: sessionId, provider: 'codex', providerSessionId: null, connection: null, userId: null });
  };

  assert.deepEqual(reasonFor((sessionId) => startRun(sessionId)), ['turn', false]);
  assert.deepEqual(reasonFor((sessionId) => harness.holds.set(sessionId, { processState: 'running', tasks: [] })), ['held', false]);
  assert.deepEqual(reasonFor((sessionId) => harness.holds.set(sessionId, { processState: 'exiting', tasks: [] })), ['exiting', false]);
  assert.deepEqual(reasonFor((sessionId) => harness.holds.set(sessionId, { processState: 'exiting', tasks: [task('t1')] })), ['exiting', false]);
  assert.deepEqual(reasonFor(() => { harness.state.queued = true; }), ['queued', true]);
  assert.deepEqual(reasonFor((sessionId) => {
    startRun(sessionId);
    harness.state.queued = true;
  }), ['turn', true]);
  assert.deepEqual(harness.spawned, []);
});

test('a sessionless launch, a plain shell and a reconnect to a running pty are not held back', () => {
  const harness = createHarness();
  const sessionId = nextSessionId('not-held');
  harness.holds.set(sessionId, { processState: 'running', tasks: [] });

  connect(harness.dependencies).init({ sessionId, hasSession: false });
  connect(harness.dependencies).init({ sessionId, isPlainShell: true, initialCommand: 'ls' });
  if (os.platform() !== 'win32') {
    assert.deepEqual(harness.spawned, ['claude', 'ls']);
  }
  assert.equal(harness.spawned.length, 2);

  // A CLI started while the session was free keeps its terminal when
  // CloudCLI takes the session up again.
  const reattachId = nextSessionId('reattach');
  connect(harness.dependencies).init({ sessionId: reattachId });
  assert.equal(harness.spawned.length, 3);
  harness.holds.set(reattachId, { processState: 'running', tasks: [] });
  const { socket, init } = connect(harness.dependencies);
  init({ sessionId: reattachId });
  assert.equal(harness.spawned.length, 3);
  assert.equal(busyFramesOf(socket).length, 0);
  assert.match(String(framesOf(socket)[0].data), /\[Reconnected/);
});

test('the same socket resumes the session once it is free', () => {
  const harness = createHarness();
  const sessionId = nextSessionId('later');
  harness.holds.set(sessionId, { processState: 'running', tasks: [] });
  const { socket, init } = connect(harness.dependencies);
  init({ sessionId });
  assert.equal(busyFramesOf(socket).length, 1);

  harness.holds.delete(sessionId);
  init({ sessionId });
  assert.equal(harness.spawned.length, 1);
  if (os.platform() !== 'win32') {
    assert.deepEqual(harness.spawned, ['claude --resume "native-1" || claude']);
  }
});

test('a restart while CloudCLI holds the session still ends the old CLI, and starts none', () => {
  const harness = createHarness();
  const sessionId = nextSessionId('restart');
  connect(harness.dependencies).init({ sessionId });
  assert.equal(harness.spawned.length, 1);

  harness.holds.set(sessionId, { processState: 'running', tasks: [] });
  const { socket, init } = connect(harness.dependencies);
  init({ sessionId, forceRestart: true });
  assert.equal(harness.ptys[0].killed, true);
  assert.equal(harness.spawned.length, 1);
  assert.equal(busyFramesOf(socket).length, 1);
});

test('a new session whose first turn has not reported its provider id yet is held back too', () => {
  const harness = createHarness({ providerSessionId: null });
  const sessionId = nextSessionId('first-turn');
  chatRunRegistry.startRun({ appSessionId: sessionId, provider: 'claude', providerSessionId: null, connection: null, userId: null });

  const { socket, init } = connect(harness.dependencies);
  init({ sessionId });
  assert.deepEqual(harness.spawned, []);
  assert.equal(busyFramesOf(socket)[0]?.reason, 'turn');
});

test('a hold kept under the provider id alone holds the resume back as well', () => {
  const harness = createHarness({ providerSessionId: 'native-only' });
  const sessionId = nextSessionId('provider-key');
  harness.holds.set('native-only', { processState: 'running', tasks: [] });

  const { socket, init } = connect(harness.dependencies);
  init({ sessionId });
  assert.deepEqual(harness.spawned, []);
  assert.equal(busyFramesOf(socket)[0]?.reason, 'held');
  assert.deepEqual([...new Set(harness.askedIds)], [sessionId, 'native-only']);
});

test('a running process under one id outweighs an exiting one under the other', () => {
  const harness = createHarness({ providerSessionId: 'native-mixed' });
  const sessionId = nextSessionId('mixed');
  harness.holds.set(sessionId, { processState: 'running', tasks: [] });
  harness.holds.set('native-mixed', { processState: 'exiting', tasks: [] });

  const { socket, init } = connect(harness.dependencies);
  init({ sessionId });
  assert.equal(busyFramesOf(socket)[0]?.reason, 'held');
});

test('a takeover of a held session starts the CLI only once the runtime has let go', async () => {
  const harness = createHarness();
  const sessionId = nextSessionId('takeover-hold');
  harness.holds.set(sessionId, { processState: 'running', tasks: [] });
  const gate = deferred();
  harness.state.releaseGate = gate.promise;

  const { socket, takeOver } = openNotice(harness.dependencies, sessionId);
  takeOver();
  await flush();
  assert.deepEqual(harness.calls, [`release:${sessionId}`]);
  assert.deepEqual(harness.spawned, [], 'nothing starts while the process is still on its way out');

  gate.resolve();
  await waitUntil(() => harness.spawned.length > 0);
  await flush();
  assert.equal(harness.spawned.length, 1);
  assert.equal(busyFramesOf(socket).length, 1, 'only the notice the takeover came from');
});

test('a takeover of a running turn aborts it first, then releases, then starts the CLI', async () => {
  const harness = createHarness();
  const sessionId = nextSessionId('takeover-turn');
  startTurn(sessionId);

  const { socket, takeOver } = openNotice(harness.dependencies, sessionId);
  takeOver();
  await waitUntil(() => harness.spawned.length > 0);

  assert.deepEqual(harness.calls, [`abort:claude:${sessionId}`, `release:${sessionId}`, 'release:native-1']);
  assert.equal(chatRunRegistry.isProcessing(sessionId), false);
  assert.equal(chatRunRegistry.getRun(sessionId)?.events.at(-1)?.aborted, true);
  assert.equal(busyFramesOf(socket).length, 1);
});

test('a takeover stops nothing when a turn and a task started after the notice it comes from', async () => {
  const harness = createHarness();
  const sessionId = nextSessionId('takeover-stale');
  harness.holds.set(sessionId, { processState: 'running', tasks: [] });
  const { socket, init, notice, takeOver } = openNotice(harness.dependencies, sessionId);
  assert.equal(notice.reason, 'held');

  // With the notice still up, a chat turn goes to the held process and starts a workflow.
  const run = startTurn(sessionId);
  harness.holds.set(sessionId, { processState: 'running', tasks: [task('wf-new')] });

  takeOver({ initId: 2 });
  await flush();
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.spawned, []);
  assert.equal(chatRunRegistry.isProcessing(sessionId), true);
  const refusal = busyFramesOf(socket).at(-1);
  assert.equal(refusal?.reason, 'turn');
  assert.equal(refusal?.changed, true);
  assert.equal(refusal?.turnStartedAt, run.startedAt);
  assert.deepEqual(snapshotOf(refusal).taskIds, ['wf-new']);
  assert.equal(refusal?.initId, 2);

  // Taken over from the notice that shows them, they are stopped.
  init({ sessionId, takeOver: snapshotOf(refusal) });
  await waitUntil(() => harness.spawned.length > 0);
  assert.deepEqual(harness.calls, [`abort:claude:${sessionId}`, `release:${sessionId}`, 'release:native-1']);
});

test('a turn that replaced the one the notice showed is not aborted', async (t) => {
  const harness = createHarness();
  const sessionId = nextSessionId('takeover-next-turn');
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const shownRun = startTurn(sessionId);
  const { socket, notice, takeOver } = openNotice(harness.dependencies, sessionId);
  assert.equal(notice.turnStartedAt, shownRun.startedAt);

  // That turn ends, and a scheduled message starts the next one.
  chatRunRegistry.completeRun(sessionId, { exitCode: 0 });
  now += 1;
  const nextRun = startTurn(sessionId);

  takeOver();
  await flush();
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.spawned, []);
  assert.equal(chatRunRegistry.getRun(sessionId), nextRun);
  assert.equal(nextRun.status, 'running');
  const refusal = busyFramesOf(socket).at(-1);
  assert.equal(refusal?.changed, true);
  assert.equal(refusal?.turnStartedAt, nextRun.startedAt);
});

test('a task the notice did not carry holds the takeover back, nested or not', async () => {
  const harness = createHarness();
  const sessionId = nextSessionId('takeover-new-task');
  harness.holds.set(sessionId, { processState: 'running', tasks: [task('wf1')] });
  const { socket, takeOver } = openNotice(harness.dependencies, sessionId);

  harness.holds.set(sessionId, { processState: 'running', tasks: [task('wf1'), task('wf2', { nested: true })] });
  takeOver();
  await flush();
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.spawned, []);
  const refusal = busyFramesOf(socket).at(-1);
  assert.equal(refusal?.reason, 'background');
  assert.equal(refusal?.changed, true);
  assert.deepEqual(snapshotOf(refusal).taskIds, ['wf1', 'wf2']);
});

test('tasks the notice carried that have ended since, nested ones too, hold no takeover back', async () => {
  const harness = createHarness();
  const sessionId = nextSessionId('takeover-fewer-tasks');
  startTurn(sessionId);
  harness.holds.set(sessionId, {
    processState: 'running',
    tasks: [task('wf1'), task('wf2'), task('n1', { nested: true })],
  });
  const { takeOver } = openNotice(harness.dependencies, sessionId);

  harness.holds.set(sessionId, { processState: 'running', tasks: [task('wf1'), task('n1', { nested: true })] });
  takeOver();
  await waitUntil(() => harness.spawned.length > 0);
  assert.deepEqual(harness.calls, [`abort:claude:${sessionId}`, `release:${sessionId}`, 'release:native-1']);
});

test('a held process that started exiting since the notice is still taken over', async () => {
  const harness = createHarness();
  const sessionId = nextSessionId('takeover-now-exiting');
  harness.holds.set(sessionId, { processState: 'running', tasks: [] });
  const { socket, takeOver } = openNotice(harness.dependencies, sessionId);

  harness.holds.set(sessionId, { processState: 'exiting', tasks: [] });
  takeOver();
  await waitUntil(() => harness.spawned.length > 0);
  assert.deepEqual(harness.calls, [`release:${sessionId}`, 'release:native-1']);
  assert.equal(busyFramesOf(socket).length, 1);
});

test('a bare takeOver from a page loaded before the snapshot stops a held process, but no turn or task', async () => {
  const harness = createHarness();

  const heldId = nextSessionId('legacy-held');
  harness.holds.set(heldId, { processState: 'running', tasks: [] });
  connect(harness.dependencies).init({ sessionId: heldId, takeOver: true });
  await waitUntil(() => harness.spawned.length > 0);
  assert.deepEqual(harness.calls, [`release:${heldId}`, 'release:native-1']);

  const turnId = nextSessionId('legacy-turn');
  startTurn(turnId);
  const turn = connect(harness.dependencies);
  turn.init({ sessionId: turnId, takeOver: true });

  const tasksId = nextSessionId('legacy-tasks');
  harness.holds.set(tasksId, { processState: 'running', tasks: [task('wf1')] });
  const tasks = connect(harness.dependencies);
  tasks.init({ sessionId: tasksId, takeOver: true });

  // A malformed snapshot reads as one that showed nothing.
  const malformedId = nextSessionId('legacy-malformed');
  startTurn(malformedId);
  const malformed = connect(harness.dependencies);
  malformed.init({ sessionId: malformedId, takeOver: { turnStartedAt: 'earlier', taskIds: 'all' } });

  await flush();
  assert.equal(harness.calls.length, 2, 'nothing more was stopped');
  assert.equal(harness.spawned.length, 1);
  for (const { socket } of [turn, tasks, malformed]) {
    assert.deepEqual(busyFramesOf(socket).map((frame) => frame.changed), [true]);
  }
  assert.equal(chatRunRegistry.isProcessing(turnId), true);
});

test('no takeover while a chat message is queued: nothing is stopped', async () => {
  const harness = createHarness();
  const sessionId = nextSessionId('takeover-queued');
  harness.holds.set(sessionId, { processState: 'running', tasks: [] });
  harness.state.queued = true;

  const { socket, takeOver } = openNotice(harness.dependencies, sessionId);
  takeOver();
  await flush();
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.spawned, []);
  const frames = busyFramesOf(socket);
  assert.equal(frames.length, 2);
  assert.equal(frames[1].reason, 'held');
  assert.equal(frames[1].hasQueuedMessage, true);
  assert.equal(frames[1].changed, false);
});

test('a takeover that a later init or a closed socket overtakes starts nothing', async () => {
  const harness = createHarness();
  const gate = deferred();
  harness.state.releaseGate = gate.promise;

  const retriedId = nextSessionId('takeover-retried');
  harness.holds.set(retriedId, { processState: 'running', tasks: [] });
  const retried = openNotice(harness.dependencies, retriedId);
  retried.takeOver();
  await flush();
  retried.init({ sessionId: retriedId });
  assert.equal(busyFramesOf(retried.socket).length, 2, 'the plain init still finds the session held');

  const closedId = nextSessionId('takeover-closed');
  harness.holds.set(closedId, { processState: 'running', tasks: [] });
  const closed = openNotice(harness.dependencies, closedId);
  closed.takeOver();
  await flush();
  closed.socket.readyState = WebSocket.CLOSED;

  gate.resolve();
  await flush(30);
  assert.equal(harness.calls.filter((call) => call.startsWith('release:')).length, 4, 'both takeovers did let go');
  assert.deepEqual(harness.spawned, []);
  assert.equal(busyFramesOf(retried.socket).length, 2);
  assert.equal(closed.socket.frames.length, 1, 'only the notice');
});

test('two tabs taking the session over at once start one CLI and share it', async () => {
  const harness = createHarness();
  const sessionId = nextSessionId('takeover-two-tabs');
  harness.holds.set(sessionId, { processState: 'running', tasks: [] });
  const gate = deferred();
  harness.state.releaseGate = gate.promise;

  const first = openNotice(harness.dependencies, sessionId);
  const second = openNotice(harness.dependencies, sessionId);
  first.takeOver();
  second.takeOver();
  await flush();

  gate.resolve();
  await waitUntil(() => first.socket.frames.length > 1 && second.socket.frames.length > 1);
  await flush();
  assert.equal(harness.spawned.length, 1);
  const reattached = [first.socket, second.socket]
    .filter((socket) => framesOf(socket).some((frame) => /\[Reconnected/.test(String(frame.data))));
  assert.equal(reattached.length, 1);
  assert.equal(busyFramesOf(first.socket).length + busyFramesOf(second.socket).length, 2, 'only the two notices');
});

test('a takeover that fails is only logged: the session is checked again and reported busy', async () => {
  const harness = createHarness();
  const sessionId = nextSessionId('takeover-fails');
  harness.holds.set(sessionId, { processState: 'running', tasks: [] });
  harness.dependencies.runtime.releaseSession = async () => {
    throw new Error('the runtime could not let go');
  };

  const { socket, takeOver } = openNotice(harness.dependencies, sessionId);
  takeOver();
  await waitUntil(() => socket.frames.length > 1);
  await flush();
  assert.deepEqual(harness.spawned, []);
  assert.deepEqual(framesOf(socket).map((frame) => frame.type), ['session_busy', 'session_busy']);
});

test('a session still held after the takeover is reported busy again, in answer to the takeover', async () => {
  const harness = createHarness();
  const sessionId = nextSessionId('takeover-still-held');
  harness.holds.set(sessionId, { processState: 'running', tasks: [] });
  harness.state.releaseKeepsHold = true;

  const { socket, takeOver } = openNotice(harness.dependencies, sessionId);
  takeOver({ initId: 5 });
  await waitUntil(() => busyFramesOf(socket).length > 1);
  assert.deepEqual(harness.spawned, []);
  const answer = busyFramesOf(socket).at(-1);
  assert.equal(answer?.reason, 'held');
  assert.equal(answer?.changed, false, 'the takeover did stop what it could');
  assert.equal(answer?.initId, 5);
});

test('the busy notice lists the scheduled work the held process keeps for the session, and always carries the list', () => {
  const harness = createHarness();
  const loopId = nextSessionId('scheduled-held');
  const loops = [scheduledItem('wakeup:toolu_01Chain'), scheduledItem('cron:7b7cd8fc', { cron: '*/5 * * * *' })];
  harness.holds.set(loopId, { processState: 'running', tasks: [], scheduled: loops });
  const loopNotice = connect(harness.dependencies);
  loopNotice.init({ sessionId: loopId });

  const [frame] = busyFramesOf(loopNotice.socket);
  assert.equal(frame?.reason, 'held', 'the reason is what it was');
  assert.deepEqual(frame?.scheduled, loops);
  assert.deepEqual(harness.spawned, []);

  const plainId = nextSessionId('scheduled-none');
  harness.holds.set(plainId, { processState: 'running', tasks: [task('wf1')] });
  const plainNotice = connect(harness.dependencies);
  plainNotice.init({ sessionId: plainId });
  const [plain] = busyFramesOf(plainNotice.socket);
  assert.equal(plain?.reason, 'background');
  assert.deepEqual(plain?.scheduled, []);
});

test('a takeover that sends scheduled work back is held back by scheduled work its notice did not carry, not by a self-paced /loop\'s next wake-up', async () => {
  const harness = createHarness();
  const sessionId = nextSessionId('takeover-scheduled');
  harness.holds.set(sessionId, { processState: 'running', tasks: [], scheduled: [scheduledItem('wakeup:toolu_01Chain')] });
  const { socket, init, notice } = openNotice(harness.dependencies, sessionId);

  // With the notice up, the model sets a reminder in the held process.
  harness.holds.set(sessionId, {
    processState: 'running',
    tasks: [],
    scheduled: [scheduledItem('wakeup:toolu_01Chain'), scheduledItem('cron:b2148320', { recurring: false })],
  });
  init({ sessionId, takeOver: scheduledSnapshotOf(notice), initId: 2 });
  await flush();
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.spawned, []);
  const refusal = busyFramesOf(socket).at(-1);
  assert.equal(refusal?.changed, true);
  assert.deepEqual(scheduledSnapshotOf(refusal).scheduledIds, ['wakeup:toolu_01Chain', 'cron:b2148320']);

  // The loop wakes up and arms its next wake-up, which keeps the chain's id;
  // the reminder fired and is gone. Nothing was started since this notice.
  harness.holds.set(sessionId, {
    processState: 'running',
    tasks: [],
    scheduled: [scheduledItem('wakeup:toolu_01Chain', { toolUseId: 'toolu_02Next', nextFireAt: 120_001 })],
  });
  init({ sessionId, takeOver: scheduledSnapshotOf(refusal) });
  await waitUntil(() => harness.spawned.length > 0);
  assert.deepEqual(harness.calls, [`release:${sessionId}`, 'release:native-1']);
});

test('a takeover from a client that sends no scheduled work back stops scheduled work as it always did', async () => {
  const harness = createHarness();
  const sessionId = nextSessionId('takeover-scheduled-legacy');
  harness.holds.set(sessionId, { processState: 'running', tasks: [] });
  const { socket, takeOver } = openNotice(harness.dependencies, sessionId);

  harness.holds.set(sessionId, { processState: 'running', tasks: [], scheduled: [scheduledItem('cron:b2148320')] });
  takeOver();
  await waitUntil(() => harness.spawned.length > 0);
  assert.deepEqual(harness.calls, [`release:${sessionId}`, 'release:native-1']);
  assert.equal(busyFramesOf(socket).length, 1, 'only the notice the takeover came from');

  // A bare `takeOver: true`, from a page loaded before the snapshot, too.
  const bareId = nextSessionId('takeover-scheduled-bare');
  harness.holds.set(bareId, { processState: 'running', tasks: [], scheduled: [scheduledItem('wakeup:toolu_01Chain')] });
  connect(harness.dependencies).init({ sessionId: bareId, takeOver: true });
  await waitUntil(() => harness.spawned.length > 1);
  assert.deepEqual(harness.calls.slice(2), [`release:${bareId}`, 'release:native-1']);
});
