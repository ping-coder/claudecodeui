import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { handleChatConnection, runDetachedChatTurn } from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

const SESSION_ID = 'abort-session';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

/** A chat gateway whose runtime only records aborts. */
async function withGateway(
  runTest: (context: { socket: ReturnType<typeof createFakeSocket>; aborts: string[] }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-abort-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const aborts: string[] = [];
  const socket = createFakeSocket();

  try {
    sessionsDb.createAppSession(SESSION_ID, 'codex', tempDirectory);
    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: {
          abort: async (provider: string, sessionId: string) => {
            aborts.push(`${provider}:${sessionId}`);
            return true;
          },
        } as never,
      },
    );

    await runTest({ socket, aborts });
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

test('chat.abort aborts the running run through its provider and completes it as aborted', async () => {
  await withGateway(async ({ socket, aborts }) => {
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'codex',
      providerSessionId: null,
      connection: socket as never,
      userId: 1,
    });

    socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: SESSION_ID }));
    await settle();

    assert.deepEqual(aborts, [`codex:${SESSION_ID}`]);
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);
    const completes = socket.frames.filter((frame) => frame.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0].aborted, true);
    assert.equal(socket.frames.some((frame) => frame.kind === 'protocol_error'), false);
  });
});

test('chat.abort with no run in progress is refused with NO_ACTIVE_RUN and reaches no runtime', async () => {
  await withGateway(async ({ socket, aborts }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: SESSION_ID }));
    await settle();

    assert.deepEqual(aborts, []);
    assert.equal(socket.frames.length, 1);
    assert.equal(socket.frames[0].kind, 'protocol_error');
    assert.equal(socket.frames[0].code, 'NO_ACTIVE_RUN');
  });
});

/**
 * A runtime whose runs end only when told, and whose abort lets the run's
 * promise settle before it answers, as Claude does for a turn it handed to
 * the process the session's previous turn left running for background work.
 * Runs started once `quickRuns` is set end at once, with their own complete.
 */
function createHandedOverTurnRuntime() {
  const runs: string[] = [];
  const aborts: string[] = [];
  let settleTurn = () => {};
  const state = { quickRuns: false };
  const runtime = {
    hasRuntime: () => true,
    hasBackgroundWork: () => false,
    getPendingApprovalsForSession: () => [],
    run: (_provider: string, command: string, _options: Record<string, unknown>, writer: { send(message: unknown): void }) => {
      runs.push(command);
      if (state.quickRuns) {
        writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode: 0 });
        return Promise.resolve();
      }
      // A handed-over turn's promise settles once the turn is over; it sends
      // no complete of its own for an aborted turn.
      return new Promise<void>((resolve) => { settleTurn = resolve; });
    },
    abort: async (_provider: string, sessionId: string) => {
      aborts.push(sessionId);
      settleTurn();
      return true;
    },
  };
  return { runtime, runs, aborts, state };
}

async function withClaudeSession(
  runTest: (context: { socket: ReturnType<typeof createFakeSocket>; tempDirectory: string }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-abort-handed-over-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);
    await runTest({ socket: createFakeSocket(), tempDirectory });
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

test('chat.abort of a turn whose promise settles as the abort reaches it ends the turn as aborted, not failed', async () => {
  await withClaudeSession(async ({ socket }) => {
    const { runtime, aborts } = createHandedOverTurnRuntime();
    handleChatConnection(socket as never, { user: { id: 1 } } as never, { runtime: runtime as never });

    socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION_ID, content: 'next step' }));
    await settle();
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), true);

    socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: SESSION_ID }));
    await settle();

    assert.deepEqual(aborts, [SESSION_ID]);
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);
    const completes = socket.frames.filter((frame) => frame.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0].aborted, true);
    assert.equal(completes[0].exitCode, 0);
    assert.deepEqual(socket.frames.filter((frame) => frame.kind === 'run_ended').map((frame) => frame.outcome), ['aborted']);
    assert.equal(socket.frames.some((frame) => frame.kind === 'protocol_error'), false);
  });
});

test('a scheduled message that interrupts such a turn ends it as aborted before its own turn starts', async () => {
  await withClaudeSession(async ({ socket }) => {
    const { runtime, runs, state } = createHandedOverTurnRuntime();
    handleChatConnection(socket as never, { user: { id: 1 } } as never, { runtime: runtime as never });

    socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION_ID, content: 'next step' }));
    await settle();
    const interrupted = chatRunRegistry.getRun(SESSION_ID);
    assert.ok(interrupted);

    state.quickRuns = true;
    const result = await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: 'the scheduled message', interruptActiveRun: true },
      { runtime: runtime as never },
    );
    await settle();

    assert.deepEqual(result, { started: true, error: null });
    assert.deepEqual(runs, ['next step', 'the scheduled message']);
    const interruptedCompletes = interrupted.events.filter((event) => event.kind === 'complete');
    assert.equal(interruptedCompletes.length, 1);
    assert.equal(interruptedCompletes[0]?.aborted, true);
    assert.deepEqual(
      socket.frames.filter((frame) => frame.kind === 'run_ended').map((frame) => frame.outcome),
      ['aborted', 'done'],
    );
  });
});
