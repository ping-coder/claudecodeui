import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * A session's turn ends while its agents, workflow or backgrounded command are
 * still going. The run registry marks the run completed at the turn's
 * `complete`, but the runtime keeps producing events through that run's
 * writer — task progress, and the turn the CLI pushes when the task reports.
 * A tab opened during that work has to attach to the run to see them, and the
 * run has to still be there to attach to.
 */

const SESSION_ID = 'held-session';
const FIVE_MINUTES = 5 * 60 * 1000;

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

/**
 * A runtime gateway with nothing going on except what `overrides` says. Typed
 * as the full gateway so a method added to it has to be answered here too.
 */
function createGateway(overrides: Partial<ProviderRuntimeGateway> = {}): ProviderRuntimeGateway {
  return {
    hasRuntime: () => true,
    run: async () => undefined,
    abort: async () => false,
    stopBackgroundTask: async () => false,
    hasBackgroundWork: () => false,
    hasScheduledWork: () => false,
    listScheduledWork: () => [],
    stopScheduledWork: async () => ({ status: 'not_found' }),
    resolveToolApproval: () => {},
    getPendingApprovalsForSession: () => [],
    insert: async () => ({ accepted: true }),
    cancelInsert: async () => ({ status: 'cancelled' }),
    planHandOver: async () => ({ heldWork: false, canHandOver: false, changes: [], switches: [] }),
    ...overrides,
  };
}

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-background-subscribe-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);
    await runTest();
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
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Starts a run for the session and ends its turn, leaving the run completed but registered. */
function startAndCompleteRun(connection: ReturnType<typeof createFakeSocket>) {
  const run = chatRunRegistry.startRun({
    appSessionId: SESSION_ID,
    provider: 'claude',
    providerSessionId: 'native-1',
    connection: connection as never,
    userId: 1,
  });
  assert.ok(run);
  run.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native-1', exitCode: 0 });
  assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);
  return run;
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

test('a tab that subscribes during background work receives the run\'s later events', async () => {
  await withIsolatedDatabase(async () => {
    const run = startAndCompleteRun(createFakeSocket());

    const newTab = createFakeSocket();
    handleChatConnection(
      newTab as never,
      { user: { id: 1 } } as never,
      { runtime: createGateway({ hasBackgroundWork: (sessionId) => sessionId === SESSION_ID }) },
    );
    newTab.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 0 }] }));
    await settle();

    // Not processing — the composer stays usable — but attached.
    assert.equal(newTab.frames[0]?.kind, 'chat_subscribed');
    assert.equal(newTab.frames[0]?.isProcessing, false);

    run.writer.send({ kind: 'task_status', provider: 'claude', sessionId: 'native-1', event: 'notification', taskId: 't1', status: 'completed' } as never);
    assert.ok(
      newTab.frames.some((frame) => frame.kind === 'task_status'),
      'the task event must reach the tab that subscribed after the turn ended',
    );
  });
});

test('a tab that subscribes while only scheduled work is left receives the run\'s later events', async () => {
  // The turn set up a /loop: no task is outstanding, but the process is held
  // for the loop's next firing, whose turn reports through the same writer.
  await withIsolatedDatabase(async () => {
    const run = startAndCompleteRun(createFakeSocket());

    const newTab = createFakeSocket();
    handleChatConnection(
      newTab as never,
      { user: { id: 1 } } as never,
      { runtime: createGateway({ hasScheduledWork: (sessionId) => sessionId === SESSION_ID }) },
    );
    newTab.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 0 }] }));
    await settle();

    assert.equal(newTab.frames[0]?.kind, 'chat_subscribed');
    assert.equal(newTab.frames[0]?.isProcessing, false);
    run.writer.send({ kind: 'text', provider: 'claude', sessionId: 'native-1', role: 'assistant', content: 'TICK' } as never);
    assert.equal(
      newTab.frames.some((frame) => frame.kind === 'text' && frame.content === 'TICK'),
      true,
      'the firing\'s turn must reach the tab that subscribed after the turn ended',
    );
  });
});

test('a tab that subscribes to an idle session is not attached to its old run', async () => {
  await withIsolatedDatabase(async () => {
    const run = startAndCompleteRun(createFakeSocket());

    const newTab = createFakeSocket();
    handleChatConnection(
      newTab as never,
      { user: { id: 1 } } as never,
      { runtime: createGateway() },
    );
    newTab.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 0 }] }));
    await settle();

    run.writer.send({ kind: 'task_status', provider: 'claude', sessionId: 'native-1', event: 'notification', taskId: 't1', status: 'completed' } as never);
    assert.ok(!newTab.frames.some((frame) => frame.kind === 'task_status'));
  });
});

test('an insert while only background work is left is refused as NO_ACTIVE_RUN', async () => {
  // The turn has ended, so there is nothing to insert into: the client sends
  // the message normally, which Claude runs as a new turn of the process the
  // work runs in.
  await withIsolatedDatabase(async () => {
    startAndCompleteRun(createFakeSocket());

    const inserts: string[] = [];
    const tab = createFakeSocket();
    handleChatConnection(
      tab as never,
      { user: { id: 1 } } as never,
      {
        runtime: createGateway({
          hasBackgroundWork: (sessionId) => sessionId === SESSION_ID,
          insert: async (_provider, _sessionId, input) => {
            inserts.push(input.insertId);
            return { accepted: true };
          },
        }),
      },
    );
    tab.emit('message', JSON.stringify({
      type: 'chat.insert',
      sessionId: SESSION_ID,
      insertId: '0b9f3a52-7c1d-4e8a-a6b2-5d4c3b2a1f0e',
      content: 'and run the linter',
    }));
    await settle();

    assert.deepEqual(inserts, []);
    // The turn's run_ended broadcast reaches every tab as well.
    const replies = tab.frames.filter((frame) => frame.kind === 'insert_status');
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.insertStatus, 'refused');
    assert.equal(replies[0]?.insertReason, 'NO_ACTIVE_RUN');
  });
});

test('a completed run stays registered while its session still has background work', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await withIsolatedDatabase(async () => {
      let working = true;
      chatRunRegistry.setRetentionGuard((sessionId) => sessionId === SESSION_ID && working);
      startAndCompleteRun(createFakeSocket());

      mock.timers.tick(FIVE_MINUTES);
      assert.ok(chatRunRegistry.getRun(SESSION_ID), 'the run must outlive the retention window while work is outstanding');

      working = false;
      mock.timers.tick(FIVE_MINUTES);
      assert.equal(chatRunRegistry.getRun(SESSION_ID), undefined, 'once the work is gone the run is evicted as before');
    });
  } finally {
    mock.timers.reset();
  }
});

test('a retained run\'s eviction timer cannot evict the session\'s next run early', async () => {
  // Run one completes with work outstanding and is re-armed at five minutes;
  // run two takes the slot and completes with two minutes of retention to
  // go. Run one's timer firing on the slot alone would evict run two.
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await withIsolatedDatabase(async () => {
      let working = true;
      chatRunRegistry.setRetentionGuard((sessionId) => sessionId === SESSION_ID && working);
      const first = startAndCompleteRun(createFakeSocket());
      mock.timers.tick(FIVE_MINUTES);
      assert.equal(chatRunRegistry.getRun(SESSION_ID), first);

      working = false;
      mock.timers.tick(FIVE_MINUTES - 2 * 60 * 1000);
      const second = startAndCompleteRun(createFakeSocket());
      assert.equal(chatRunRegistry.getRun(SESSION_ID), second);

      // Run one's re-armed timer fires now; run two's has two minutes left.
      mock.timers.tick(2 * 60 * 1000);
      assert.equal(chatRunRegistry.getRun(SESSION_ID), second, 'run two keeps its own retention window');
      mock.timers.tick(FIVE_MINUTES);
      assert.equal(chatRunRegistry.getRun(SESSION_ID), undefined);
    });
  } finally {
    mock.timers.reset();
  }
});
