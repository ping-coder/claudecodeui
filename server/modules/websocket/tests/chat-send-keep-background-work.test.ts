import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { AnyRecord, ProviderHandOverPlan } from '@/shared/types.js';

/**
 * A Claude session whose turn ended with background work left keeps its
 * process for that work, and the next message runs in it when its options
 * allow. One that changes what only a new process can apply would start a
 * process of its own and stop the work. A `chat.send` that sets
 * `options.keepBackgroundWork` is refused instead, straight back to the
 * asking socket as `send_refused`, and no run starts; without the flag the
 * send goes ahead as it always has.
 */

const SESSION_ID = 'held-session';

type Frame = Record<string, unknown>;

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Frame[];
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Frame);
  return socket;
}

/**
 * A runtime gateway that plans a hand-over as the test says and records the
 * plans it is asked for and the runs it starts. Each run ends at once.
 */
function createGateway(plan: (options: AnyRecord) => Promise<ProviderHandOverPlan>) {
  const plans: AnyRecord[] = [];
  const runs: Array<{ command: string; options: AnyRecord }> = [];
  const runtime: ProviderRuntimeGateway = {
    hasRuntime: () => true,
    run: async (_provider, command, options, writer) => {
      runs.push({ command, options });
      writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode: 0 });
    },
    abort: async () => false,
    stopBackgroundTask: async () => false,
    hasBackgroundWork: () => true,
    resolveToolApproval: () => {},
    getPendingApprovalsForSession: () => [],
    insert: async () => ({ accepted: false, reason: 'NO_ACTIVE_RUN' }),
    cancelInsert: async () => ({ status: 'not_found' }),
    planHandOver: async (_provider, _sessionId, options) => {
      plans.push(options);
      return plan(options);
    },
  };
  return { runtime, plans, runs };
}

async function withChat(
  runtime: ProviderRuntimeGateway,
  runTest: (context: { socket: ReturnType<typeof createFakeSocket>; projectPath: string }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-send-keep-background-work-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);
    const socket = createFakeSocket();
    handleChatConnection(socket as never, { user: { id: 1 } } as never, { runtime });
    await runTest({ socket, projectPath: tempDirectory });
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** The handler is async and the socket listener does not await it. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

const send = (socket: ReturnType<typeof createFakeSocket>, options: AnyRecord) => {
  socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION_ID, content: 'and now the docs', options }));
};

test('a send that asks to keep the background work is refused, and starts no run, when its turn cannot go into the held process', async () => {
  const { runtime, plans, runs } = createGateway(async () => ({ heldWork: true, canHandOver: false, changes: ['effort'], switches: [] }));
  await withChat(runtime, async ({ socket, projectPath }) => {
    send(socket, { model: 'opus', effort: 'max', keepBackgroundWork: true });
    await settle();

    assert.deepEqual(runs, []);
    assert.equal(chatRunRegistry.getRun(SESSION_ID), undefined, 'no run was registered');
    // Asked with the run options the turn would have run with.
    assert.equal(plans.length, 1);
    assert.equal(plans[0]?.cwd, projectPath);
    assert.equal(plans[0]?.sessionId, SESSION_ID);
    assert.equal(plans[0]?.effort, 'max');

    assert.equal(socket.frames.length, 1, 'only the refusal, and no protocol_error');
    const [refusal] = socket.frames;
    assert.equal(refusal?.kind, 'send_refused');
    assert.equal(refusal?.sessionId, SESSION_ID);
    assert.equal(refusal?.reason, 'BACKGROUND_WORK_WOULD_STOP');
    assert.deepEqual(refusal?.changes, ['effort']);
    assert.equal(refusal?.content, 'and now the docs');
    assert.equal(refusal?.seq, undefined);
  });
});

test('a send that asks to keep the background work starts as usual when its turn can go into the held process, or nothing is held', async () => {
  let plan: ProviderHandOverPlan = { heldWork: true, canHandOver: true, changes: [], switches: [] };
  const { runtime, runs } = createGateway(async () => plan);
  await withChat(runtime, async ({ socket }) => {
    send(socket, { keepBackgroundWork: true });
    await settle();
    plan = { heldWork: false, canHandOver: false, changes: [], switches: [] };
    send(socket, { keepBackgroundWork: true });
    await settle();

    assert.equal(runs.length, 2);
    // The runtime still sees the flag.
    assert.equal(runs[0]?.options.keepBackgroundWork, true);
    assert.equal(socket.frames.some((frame) => frame.kind === 'send_refused'), false);
  });
});

test('a send without the flag never asks and goes ahead, stopping the work as before', async () => {
  const { runtime, plans, runs } = createGateway(async () => ({ heldWork: true, canHandOver: false, changes: ['effort'], switches: [] }));
  await withChat(runtime, async ({ socket }) => {
    send(socket, { effort: 'max' });
    await settle();

    assert.deepEqual(plans, []);
    assert.equal(runs.length, 1);
    assert.equal(socket.frames.some((frame) => frame.kind === 'send_refused'), false);
  });
});

test('a send to a session with a turn under way is refused as RUN_IN_PROGRESS, as before, without asking', async () => {
  const { runtime, plans, runs } = createGateway(async () => ({ heldWork: true, canHandOver: false, changes: ['effort'], switches: [] }));
  await withChat(runtime, async ({ socket }) => {
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId: 1,
    });
    send(socket, { keepBackgroundWork: true });
    await settle();

    assert.deepEqual(plans, []);
    assert.deepEqual(runs, []);
    assert.deepEqual(socket.frames.map((frame) => [frame.kind, frame.code]), [['protocol_error', 'RUN_IN_PROGRESS']]);
  });
});

test('a plan the runtime fails to make refuses the send rather than risk the work', async () => {
  const { runtime, runs } = createGateway(async () => { throw new Error('model lookup failed'); });
  await withChat(runtime, async ({ socket }) => {
    send(socket, { keepBackgroundWork: true });
    await settle();

    assert.deepEqual(runs, []);
    assert.deepEqual(socket.frames.map((frame) => [frame.kind, frame.changes]), [['send_refused', ['lookup']]]);
  });
});

test('the refusal hands back the send\'s clientRequestId, and leaves out one that is missing or out of pattern', async () => {
  const { runtime, runs } = createGateway(async () => ({ heldWork: true, canHandOver: false, changes: ['effort'], switches: [] }));
  await withChat(runtime, async ({ socket }) => {
    // Two panes of one page send over the same socket, then a send with no
    // id (a page from before ids) and sends with ids the gateway will not echo.
    const clientRequestIds: unknown[] = ['send_mf3k2_a1b2c3', 'send_mf3k2_d4e5f6', undefined, 'not an id', 'x'.repeat(129), 42];
    for (const clientRequestId of clientRequestIds) {
      socket.emit('message', JSON.stringify({
        type: 'chat.send',
        sessionId: SESSION_ID,
        content: 'and now the docs',
        options: { effort: 'max', keepBackgroundWork: true },
        clientRequestId,
      }));
    }
    await settle();

    assert.deepEqual(runs, []);
    const refusals = socket.frames.filter((frame) => frame.kind === 'send_refused');
    assert.deepEqual(
      refusals.map((frame) => ('clientRequestId' in frame ? frame.clientRequestId : 'none')),
      ['send_mf3k2_a1b2c3', 'send_mf3k2_d4e5f6', 'none', 'none', 'none', 'none'],
    );
  });
});
