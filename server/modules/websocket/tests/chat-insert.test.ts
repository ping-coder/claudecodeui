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
import type {
  InsertStatus,
  LLMProvider,
  NormalizedMessage,
  ProviderCancelInsertGatewayResult,
  ProviderInsertGatewayResult,
  ProviderInsertInput,
} from '@/shared/types.js';

/**
 * `chat.insert` writes a message into the session's running turn and
 * `chat.insert-cancel` withdraws one. An accepted insert is reported by the
 * runtime through the run's writer; everything the gateway answers itself
 * goes back to the asking socket alone, as an `insert_status` without `seq`
 * and never as a `protocol_error`, which the client would take as the run
 * failing.
 */

const SESSION_ID = 'insert-session';
const INSERT_ID = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';

type Frame = Record<string, unknown>;
type InsertCall = { provider: string; sessionId: string; input: ProviderInsertInput };
type CancelCall = { provider: string; sessionId: string; insertId: string };

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
 * A runtime gateway that answers inserts and withdrawals as the test says,
 * accepting and withdrawing by default, and records what reached it. The
 * rest answers like a runtime with nothing going on.
 */
function createGateway(answers: {
  hasRuntime?: (provider: string) => boolean;
  insert?: (call: InsertCall) => Promise<ProviderInsertGatewayResult>;
  cancelInsert?: (call: CancelCall) => Promise<ProviderCancelInsertGatewayResult>;
} = {}) {
  const inserts: InsertCall[] = [];
  const cancels: CancelCall[] = [];
  const runtime: ProviderRuntimeGateway = {
    hasRuntime: answers.hasRuntime ?? (() => true),
    run: async () => undefined,
    abort: async () => false,
    stopBackgroundTask: async () => false,
    hasBackgroundWork: () => false,
    hasScheduledWork: () => false,
    listScheduledWork: () => [],
    stopScheduledWork: async () => ({ status: 'not_found' }),
    resolveToolApproval: () => {},
    getPendingApprovalsForSession: () => [],
    insert: async (provider, sessionId, input) => {
      const call = { provider, sessionId, input };
      inserts.push(call);
      return answers.insert ? answers.insert(call) : { accepted: true };
    },
    cancelInsert: async (provider, sessionId, insertId) => {
      const call = { provider, sessionId, insertId };
      cancels.push(call);
      return answers.cancelInsert ? answers.cancelInsert(call) : { status: 'cancelled' };
    },
    planHandOver: async () => ({ heldWork: false, canHandOver: false, changes: [], switches: [] }),
  };
  return { runtime, inserts, cancels };
}

/**
 * Runs a test against a fresh database holding one session of `provider`,
 * with a chat socket connected to `runtime`.
 */
async function withChat(
  runtime: ProviderRuntimeGateway,
  runTest: (socket: ReturnType<typeof createFakeSocket>) => Promise<void>,
  provider: LLMProvider = 'claude',
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-insert-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    sessionsDb.createAppSession(SESSION_ID, provider, tempDirectory);
    const socket = createFakeSocket();
    handleChatConnection(socket as never, { user: { id: 1 } } as never, { runtime });
    await runTest(socket);
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

/** A turn in progress for the session, started from another tab: the test socket is not its audience. */
function startRun(provider: LLMProvider = 'claude') {
  const run = chatRunRegistry.startRun({
    appSessionId: SESSION_ID,
    provider,
    providerSessionId: 'native-1',
    connection: null,
    userId: 1,
  });
  assert.ok(run);
  return run;
}

/** Reports a status of an insert through the session's run, the way a runtime does. */
function sendRuntimeStatus(insertId: string, insertStatus: InsertStatus, content?: string): void {
  const status: NormalizedMessage = {
    id: `status-${insertId}-${insertStatus}`,
    kind: 'insert_status',
    provider: 'claude',
    sessionId: 'native-1',
    timestamp: new Date().toISOString(),
    insertId,
    insertStatus,
    content,
  };
  chatRunRegistry.getRun(SESSION_ID)?.writer.send(status);
}

/** The handlers are async and the socket listener does not await them. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

async function sendFrame(socket: ReturnType<typeof createFakeSocket>, frame: Frame): Promise<void> {
  socket.emit('message', JSON.stringify(frame));
  await settle();
}

const insertFrame = (overrides: Frame = {}): Frame => ({
  type: 'chat.insert',
  sessionId: SESSION_ID,
  insertId: INSERT_ID,
  content: 'also check the error log',
  ...overrides,
});

const cancelFrame = (overrides: Frame = {}): Frame => ({
  type: 'chat.insert-cancel',
  sessionId: SESSION_ID,
  insertId: INSERT_ID,
  ...overrides,
});

/** What the gateway itself answered: no `seq`, never a protocol_error. */
function readDirectReplies(socket: ReturnType<typeof createFakeSocket>): Frame[] {
  assert.equal(socket.frames.some((frame) => frame.kind === 'protocol_error'), false, 'no protocol_error may reach the client');
  const replies = socket.frames.filter((frame) => frame.kind === 'insert_status' && frame.seq === undefined);
  assert.equal(replies.length, socket.frames.length, 'the gateway sent something other than an insert_status');
  return replies;
}

test('an accepted insert reaches the runtime of the session row\'s provider and is not echoed', async () => {
  const { runtime, inserts } = createGateway();
  await withChat(runtime, async (socket) => {
    startRun();
    // The frame's own provider means nothing; the session row decides.
    await sendFrame(socket, insertFrame({ content: '  also check the error log\n', provider: 'codex' }));

    assert.deepEqual(inserts, [{
      provider: 'claude',
      sessionId: SESSION_ID,
      input: { insertId: INSERT_ID, content: '  also check the error log\n' },
    }]);
    assert.deepEqual(socket.frames, []);
  });
});

test('the asking socket hears the runtime\'s pending status although it never subscribed to the run', async () => {
  const { runtime } = createGateway({
    insert: async ({ input }) => {
      sendRuntimeStatus(input.insertId, 'pending', input.content);
      return { accepted: true };
    },
  });
  await withChat(runtime, async (socket) => {
    startRun();
    await sendFrame(socket, insertFrame());

    assert.equal(socket.frames.length, 1);
    assert.equal(socket.frames[0].kind, 'insert_status');
    assert.equal(socket.frames[0].insertStatus, 'pending');
    assert.equal(socket.frames[0].sessionId, SESSION_ID);
    assert.equal(typeof socket.frames[0].seq, 'number', 'the runtime\'s statuses are sequenced');
  });
});

test('a malformed insert is refused as INVALID without reaching the runtime', async () => {
  const { runtime, inserts } = createGateway();
  await withChat(runtime, async (socket) => {
    startRun();
    const malformed: Frame[] = [
      insertFrame({ sessionId: undefined }),
      insertFrame({ sessionId: 'no-such-session' }),
      insertFrame({ insertId: undefined }),
      insertFrame({ insertId: 'insert-1' }),
      insertFrame({ content: undefined }),
      insertFrame({ content: 42 }),
      insertFrame({ content: '  \n ' }),
      // Inserts are text only; the composer queues a message with attachments.
      insertFrame({ options: { images: [{ path: 'shot.png', name: 'shot.png' }] } }),
      insertFrame({ options: { attachments: ['notes.txt'] } }),
    ];
    for (const frame of malformed) {
      await sendFrame(socket, frame);
    }

    assert.equal(inserts.length, 0);
    const replies = readDirectReplies(socket);
    assert.equal(replies.length, malformed.length);
    for (const reply of replies) {
      assert.equal(reply.insertStatus, 'refused');
      assert.equal(reply.insertReason, 'INVALID');
    }
    // Echoed so the composer that sent it can claim it.
    assert.equal(replies[0].sessionId, null);
    assert.equal(replies[0].insertId, INSERT_ID);
    assert.equal(replies[0].content, 'also check the error log');
    assert.equal(replies[3].insertId, 'insert-1');
  });
});

test('an insert with no turn in progress is refused as NO_ACTIVE_RUN', async () => {
  const { runtime, inserts } = createGateway();
  await withChat(runtime, async (socket) => {
    await sendFrame(socket, insertFrame());

    assert.equal(inserts.length, 0);
    const replies = readDirectReplies(socket);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].insertStatus, 'refused');
    assert.equal(replies[0].insertReason, 'NO_ACTIVE_RUN');
    assert.equal(replies[0].sessionId, SESSION_ID);
    assert.equal(replies[0].insertId, INSERT_ID);
    assert.equal(replies[0].provider, 'claude');
  });
});

test('a slash command is refused as SLASH_COMMAND during a turn, and as NO_ACTIVE_RUN when idle', async () => {
  const { runtime, inserts } = createGateway();
  await withChat(runtime, async (socket) => {
    // Idle first: NO_ACTIVE_RUN is what makes the client send it normally.
    await sendFrame(socket, insertFrame({ content: '/compact' }));
    startRun();
    await sendFrame(socket, insertFrame({ content: '/compact' }));
    await sendFrame(socket, insertFrame({ content: '  /model opus' }));

    assert.equal(inserts.length, 0);
    const replies = readDirectReplies(socket);
    assert.deepEqual(replies.map((reply) => reply.insertReason), ['NO_ACTIVE_RUN', 'SLASH_COMMAND', 'SLASH_COMMAND']);
    assert.equal(replies.every((reply) => reply.insertStatus === 'refused'), true);
  });
});

test('a provider that cannot insert is refused as UNSUPPORTED', async () => {
  const { runtime, inserts } = createGateway({ insert: async () => ({ accepted: false, reason: 'UNSUPPORTED' }) });
  await withChat(runtime, async (socket) => {
    startRun('codex');
    await sendFrame(socket, insertFrame());

    assert.deepEqual(inserts.map((call) => call.provider), ['codex']);
    const replies = readDirectReplies(socket);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].insertStatus, 'refused');
    assert.equal(replies[0].insertReason, 'UNSUPPORTED');
    assert.equal(replies[0].provider, 'codex');
  }, 'codex');
});

test('a provider with no runtime is refused as UNSUPPORTED without reaching the gateway\'s insert', async () => {
  const { runtime, inserts } = createGateway({ hasRuntime: () => false });
  await withChat(runtime, async (socket) => {
    startRun();
    await sendFrame(socket, insertFrame());

    assert.equal(inserts.length, 0);
    const replies = readDirectReplies(socket);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].insertReason, 'UNSUPPORTED');
  });
});

test('a runtime\'s refusal reaches the client as a reason it acts on', async () => {
  const reasons = ['NO_ACTIVE_RUN', 'INVALID', 'DUPLICATE'] as const;
  let next = 0;
  const { runtime, inserts } = createGateway({
    insert: async () => ({ accepted: false, reason: reasons[next++] }),
  });
  await withChat(runtime, async (socket) => {
    startRun();
    for (let index = 0; index < reasons.length; index += 1) {
      await sendFrame(socket, insertFrame());
    }

    assert.equal(inserts.length, reasons.length);
    const replies = readDirectReplies(socket);
    // A reused insertId is a malformed request from the client's side.
    assert.deepEqual(replies.map((reply) => reply.insertReason), ['NO_ACTIVE_RUN', 'INVALID', 'INVALID']);
    assert.equal(replies.every((reply) => reply.insertStatus === 'refused'), true);
  });
});

test('a runtime that throws ends the insert as failed instead of a protocol_error', async () => {
  const errors: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const { runtime } = createGateway({ insert: async () => { throw new Error('stdin closed'); } });
    await withChat(runtime, async (socket) => {
      startRun();
      await sendFrame(socket, insertFrame());

      const replies = readDirectReplies(socket);
      assert.equal(replies.length, 1);
      assert.equal(replies[0].insertStatus, 'failed');
      assert.equal(replies[0].insertReason, 'INTERNAL_ERROR');
      assert.equal(replies[0].insertId, INSERT_ID);
      assert.equal(replies[0].content, 'also check the error log');
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(errors.length, 1);
});

test('a withdrawal reaches the runtime of the session row\'s provider, and the asking socket hears it cancelled', async () => {
  const { runtime, cancels } = createGateway({
    cancelInsert: async ({ insertId }) => {
      sendRuntimeStatus(insertId, 'cancelled');
      return { status: 'cancelled' };
    },
  });
  await withChat(runtime, async (socket) => {
    startRun();
    await sendFrame(socket, cancelFrame({ provider: 'codex' }));

    assert.deepEqual(cancels, [{ provider: 'claude', sessionId: SESSION_ID, insertId: INSERT_ID }]);
    // Only the runtime's own sequenced status; the gateway echoes nothing.
    assert.equal(socket.frames.length, 1);
    assert.equal(socket.frames[0].insertStatus, 'cancelled');
    assert.equal(typeof socket.frames[0].seq, 'number');
  });
});

test('a withdrawal that did not happen comes back as cancel_failed', async () => {
  const errors: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const answers: Array<() => Promise<ProviderCancelInsertGatewayResult>> = [
      async () => ({ status: 'cancel_failed' }),
      async () => ({ status: 'not_found' }),
      async () => ({ status: 'unsupported' }),
      async () => { throw new Error('query closed'); },
    ];
    let next = 0;
    const { runtime, cancels } = createGateway({ cancelInsert: () => answers[next++]() });
    await withChat(runtime, async (socket) => {
      startRun();
      for (let index = 0; index < answers.length; index += 1) {
        await sendFrame(socket, cancelFrame());
      }

      assert.equal(cancels.length, answers.length);
      const replies = readDirectReplies(socket);
      assert.equal(replies.length, answers.length);
      assert.equal(replies.every((reply) => reply.insertStatus === 'cancel_failed'), true);
      assert.equal(replies.every((reply) => reply.insertId === INSERT_ID && reply.sessionId === SESSION_ID), true);
      // No reason when the CLI is already delivering it.
      assert.deepEqual(replies.map((reply) => reply.insertReason), [undefined, 'NOT_FOUND', 'UNSUPPORTED', 'INTERNAL_ERROR']);
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(errors.length, 1);
});

test('a malformed withdrawal is answered cancel_failed INVALID without reaching the runtime', async () => {
  const { runtime, cancels } = createGateway();
  await withChat(runtime, async (socket) => {
    startRun();
    const malformed: Frame[] = [
      cancelFrame({ sessionId: undefined }),
      cancelFrame({ sessionId: 'no-such-session' }),
      cancelFrame({ insertId: undefined }),
      cancelFrame({ insertId: 'insert-1' }),
    ];
    for (const frame of malformed) {
      await sendFrame(socket, frame);
    }

    assert.equal(cancels.length, 0);
    const replies = readDirectReplies(socket);
    assert.equal(replies.length, malformed.length);
    assert.equal(replies.every((reply) => reply.insertStatus === 'cancel_failed' && reply.insertReason === 'INVALID'), true);
  });
});

test('a withdrawal for a provider with no runtime is answered cancel_failed UNSUPPORTED', async () => {
  const { runtime, cancels } = createGateway({ hasRuntime: () => false });
  await withChat(runtime, async (socket) => {
    await sendFrame(socket, cancelFrame());

    assert.equal(cancels.length, 0);
    const replies = readDirectReplies(socket);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].insertStatus, 'cancel_failed');
    assert.equal(replies[0].insertReason, 'UNSUPPORTED');
  });
});
