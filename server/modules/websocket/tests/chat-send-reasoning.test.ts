import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection, runDetachedChatTurn } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

const SESSION_ID = 'reasoning-session';

type RunCall = { provider: string; options: Record<string, unknown> };
type ChatWebSocketDependencies = Parameters<typeof runDetachedChatTurn>[1];

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

async function withGateway(
  runTest: (context: {
    socket: ReturnType<typeof createFakeSocket>;
    runs: RunCall[];
    dependencies: ChatWebSocketDependencies;
  }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-send-reasoning-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const runs: RunCall[] = [];
  const socket = createFakeSocket();
  const dependencies = {
    runtime: {
      hasRuntime: () => true,
      run: async (provider: string, _command: string, options: Record<string, unknown>) => {
        runs.push({ provider, options });
      },
    },
  } as unknown as ChatWebSocketDependencies;

  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Reasoning session');
    handleChatConnection(socket as never, { user: { id: 1 } } as never, dependencies);

    await runTest({ socket, runs, dependencies });
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

const send = async (socket: ReturnType<typeof createFakeSocket>, options: Record<string, unknown>) => {
  socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION_ID, content: 'hi', options }));
  await settle();
};

const readRecordedSelection = () => {
  const row = sessionsDb.getSessionById(SESSION_ID);
  return { model: row?.model, effort: row?.effort, ultracode: row?.ultracode };
};

test('a send records the ultracode switch beside the effort and passes both to the runtime', async () => {
  await withGateway(async ({ socket, runs }) => {
    await send(socket, { model: 'opus', effort: 'low', ultracode: true });

    assert.equal(runs.length, 1);
    assert.equal(runs[0].options.effort, 'low');
    assert.equal(runs[0].options.ultracode, true);
    assert.deepEqual(readRecordedSelection(), { model: 'opus', effort: 'low', ultracode: 1 });

    await send(socket, { model: 'opus', effort: 'max', ultracode: false });

    assert.equal(runs[1].options.effort, 'max');
    assert.equal(runs[1].options.ultracode, false);
    assert.deepEqual(readRecordedSelection(), { model: 'opus', effort: 'max', ultracode: 0 });
  });
});

test('a send without a real boolean makes no ultracode choice', async () => {
  await withGateway(async ({ socket, runs }) => {
    sessionsDb.setSessionUltracode(SESSION_ID, true);

    // Clients omit it for models that cannot run ultracode.
    await send(socket, { model: 'haiku', effort: 'high' });
    // A string is not a choice, and must never reach the runtime as one.
    await send(socket, { model: 'opus', effort: 'high', ultracode: 'true' });

    assert.equal(runs.length, 2);
    for (const run of runs) {
      assert.equal(run.options.ultracode, undefined);
    }
    assert.equal(readRecordedSelection().ultracode, 1);
  });
});

test('a legacy ultracode effort is split before it is recorded or run', async () => {
  await withGateway(async ({ socket, runs }) => {
    await send(socket, { model: 'opus', effort: 'ultracode' });

    assert.equal(runs[0].options.effort, 'xhigh');
    assert.equal(runs[0].options.ultracode, true);
    assert.deepEqual(readRecordedSelection(), { model: 'opus', effort: 'xhigh', ultracode: 1 });

    // An explicit switch from a client that knows the new shape wins.
    await send(socket, { model: 'opus', effort: 'ultracode', ultracode: false });

    assert.equal(runs[1].options.effort, 'xhigh');
    assert.equal(runs[1].options.ultracode, false);
    assert.deepEqual(readRecordedSelection(), { model: 'opus', effort: 'xhigh', ultracode: 0 });
  });
});

test('a scheduled message saved with the legacy ultracode effort replays as xhigh with ultracode on', async () => {
  await withGateway(async ({ runs, dependencies }) => {
    const result = await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: 'scheduled', options: { model: 'opus', effort: 'ultracode' } },
      dependencies,
    );

    assert.deepEqual(result, { started: true, error: null });
    assert.equal(runs[0].options.effort, 'xhigh');
    assert.equal(runs[0].options.ultracode, true);
    assert.deepEqual(readRecordedSelection(), { model: 'opus', effort: 'xhigh', ultracode: 1 });
  });
});
