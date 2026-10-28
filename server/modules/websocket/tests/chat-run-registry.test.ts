import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * Minimal stand-in for a websocket connection: collects every JSON frame the
 * gateway writer forwards so assertions can inspect the outbound protocol.
 */
class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-run-registry-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
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

test('live events are remapped to the app session id and sequenced', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-1', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-1',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: 'user-1',
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'provider-id-9', content: 'hello' });
    run.writer.send({ kind: 'text', provider: 'claude', sessionId: 'provider-id-9', content: 'hello world' });

    assert.equal(connection.frames.length, 2);
    assert.equal(connection.frames[0]?.sessionId, 'app-run-1');
    assert.equal(connection.frames[0]?.seq, 1);
    assert.equal(connection.frames[1]?.sessionId, 'app-run-1');
    assert.equal(connection.frames[1]?.seq, 2);
  });
});

test('session_created is swallowed and persisted as the provider-id mapping', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-run-2', 'cursor', '/workspace/demo');
    const connection = new FakeConnection();
    connectedClients.add(connection as never);
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-2',
      provider: 'cursor',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({
      kind: 'session_created',
      provider: 'cursor',
      sessionId: 'cursor-native-7',
      newSessionId: 'cursor-native-7',
    });

    // The upsert is broadcast without blocking the run: resolving the owning
    // project's display name is async, so let that settle before asserting.
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    // The provider-native event itself is never forwarded...
    const sessionUpserts = connection.frames.filter((frame) => frame.kind === 'session_upserted');
    assert.equal(sessionUpserts.length, 1);
    assert.equal(sessionUpserts[0]?.sessionId, 'app-run-2');
    assert.equal(sessionUpserts[0]?.providerSessionId, 'cursor-native-7');
    // ...but the canonical mapping is recorded and persisted in the database.
    assert.equal(run.providerSessionId, 'cursor-native-7');
    assert.equal(sessionsDb.getSessionById('app-run-2')?.provider_session_id, 'cursor-native-7');
  });
});

test('complete marks the run finished and duplicate completes are dropped', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-3', 'codex', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-3',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-3', exitCode: 0 });
    // Late duplicate from a killed runtime's exit handler.
    run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-3', exitCode: 1 });

    const completes = connection.frames.filter((frame) => frame.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0]?.actualSessionId, 'app-run-3');
    assert.equal(chatRunRegistry.isProcessing('app-run-3'), false);

    // completeRun is also a no-op once the run already completed.
    chatRunRegistry.completeRun('app-run-3', { exitCode: 1 });
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 1);
  });
});

test('a finished run\'s safety net cannot complete the session\'s next run', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-9', 'codex', '/workspace/demo');
    const connection = new FakeConnection();

    const firstRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-9',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(firstRun);
    firstRun.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-9', exitCode: 0 });

    // A queued message starts the next run before the first run's runtime
    // promise settles (the chat handler's `finally` hasn't executed yet).
    const secondRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-9',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(secondRun);

    // First run's safety net fires late: it must not touch the new run.
    chatRunRegistry.completeRunIfCurrent(firstRun, { exitCode: 1 });
    assert.equal(chatRunRegistry.isProcessing('app-run-9'), true);
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 1);

    // The second run's own safety net still works while it is current.
    chatRunRegistry.completeRunIfCurrent(secondRun, { exitCode: 1 });
    assert.equal(chatRunRegistry.isProcessing('app-run-9'), false);
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 2);
  });
});

test('listRunningRuns returns only currently running app sessions', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-7', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('app-run-8', 'codex', '/workspace/demo');
    const connection = new FakeConnection();

    const completedRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-7',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(completedRun);

    const runningRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-8',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(runningRun);

    chatRunRegistry.completeRun('app-run-7', { exitCode: 0 });

    const runningSessions = chatRunRegistry.listRunningRuns();
    assert.deepEqual(runningSessions.map((session) => session.sessionId), ['app-run-8']);
    assert.equal(runningSessions[0]?.provider, 'codex');
  });
});

test('replayEvents returns only events after the requested seq', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-4', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-4',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'a' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'b' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'c' });

    const replayed = chatRunRegistry.replayEvents('app-run-4', 1);
    assert.deepEqual(replayed.map((event) => event.content), ['b', 'c']);
    assert.deepEqual(replayed.map((event) => event.seq), [2, 3]);
  });
});

test('attachConnection adds a socket without cutting off the ones already watching', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-5', 'opencode', '/workspace/demo');
    const firstConnection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-5',
      provider: 'opencode',
      providerSessionId: null,
      connection: firstConnection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'before' });

    // A second tab on the same session subscribes mid-run.
    const secondConnection = new FakeConnection();
    assert.equal(chatRunRegistry.attachConnection('app-run-5', secondConnection), true);
    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'after' });

    assert.deepEqual(firstConnection.frames.map((frame) => frame.content), ['before', 'after']);
    assert.deepEqual(secondConnection.frames.map((frame) => frame.content), ['after']);
  });
});

test('a refreshed tab stops receiving once its old socket is closed', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-5b', 'opencode', '/workspace/demo');
    const staleConnection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-5b',
      provider: 'opencode',
      providerSessionId: null,
      connection: staleConnection,
      userId: null,
    });
    assert.ok(run);

    // The page reloads: the original socket closes and the fresh one subscribes.
    staleConnection.readyState = 3;
    const reloadedConnection = new FakeConnection();
    assert.equal(chatRunRegistry.attachConnection('app-run-5b', reloadedConnection), true);

    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'after' });
    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'later' });

    assert.deepEqual(staleConnection.frames, []);
    assert.deepEqual(reloadedConnection.frames.map((frame) => frame.content), ['after', 'later']);
  });
});

test('startRun rejects a second concurrent run for the same session', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-6', 'opencode', '/workspace/demo');
    const connection = new FakeConnection();
    const first = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(first);

    const second = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.equal(second, null);

    // After the run finishes a new one is allowed again.
    chatRunRegistry.completeRun('app-run-6', { exitCode: 0 });
    const third = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(third);
  });
});

test('each run\'s writer names its run by the start time that run\'s ends carry', async () => {
  await withIsolatedDatabase(() => {
    let now = 7_000_000;
    const clock = mock.method(Date, 'now', () => now);
    try {
      sessionsDb.createAppSession('app-run-started', 'cursor', '/workspace/demo');
      const first = chatRunRegistry.startRun({ appSessionId: 'app-run-started', provider: 'cursor', providerSessionId: null, connection: null, userId: null });
      assert.ok(first);
      chatRunRegistry.completeRun('app-run-started', { exitCode: 0 });
      now = 7_000_300;
      const second = chatRunRegistry.startRun({ appSessionId: 'app-run-started', provider: 'cursor', providerSessionId: null, connection: null, userId: null });
      assert.ok(second);

      // The first run's writer still names the first run once the next one holds the slot.
      assert.deepEqual([first.writer.runStartedAt, second.writer.runStartedAt], [7_000_000, 7_000_300]);
      assert.deepEqual(chatRunRegistry.listRecentRunEnds().map((end) => end.runStartedAt), [7_000_000]);
    } finally {
      clock.mock.restore();
    }
  });
});

/** Resolves after the microtasks already queued, which is when a recorded run end has been broadcast. */
const flushMicrotasks = () => new Promise<void>((resolve) => { queueMicrotask(resolve); });

/** A socket in the gateway's broadcast set, as every connected tab's is. */
function connectTab(): FakeConnection {
  const connection = new FakeConnection();
  connectedClients.add(connection);
  return connection;
}

const runEndedFrames = (connection: FakeConnection) =>
  connection.frames.filter((frame) => frame.kind === 'run_ended');

test('a run\'s first complete reaches every open tab as run_ended, after the run\'s own listeners got the complete', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-end-1', 'claude', '/workspace/demo', 'Fix login bug');
    const listener = connectTab();
    const otherTab = connectTab();
    const closedTab = connectTab();
    closedTab.readyState = 3;
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-end-1',
      provider: 'claude',
      providerSessionId: null,
      connection: listener,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native-1', exitCode: 0, success: true, aborted: false });
    // Still in the writer's turn: the complete is out, the end is not yet.
    assert.deepEqual(listener.frames.map((frame) => frame.kind), ['complete']);
    assert.equal(otherTab.frames.length, 0);

    await flushMicrotasks();

    assert.deepEqual(listener.frames.map((frame) => frame.kind), ['complete', 'run_ended']);
    assert.deepEqual(otherTab.frames.map((frame) => frame.kind), ['run_ended']);
    assert.equal(closedTab.frames.length, 0);

    const ended = otherTab.frames[0];
    assert.equal(typeof ended?.endedAt, 'number');
    // A gateway frame: no seq, and nothing beyond the contract.
    assert.deepEqual(ended, {
      kind: 'run_ended',
      sessionId: 'app-end-1',
      provider: 'claude',
      runStartedAt: run.startedAt,
      endedAt: ended?.endedAt,
      outcome: 'done',
      backgroundWork: false,
      sessionName: 'Fix login bug',
      timestamp: new Date(ended?.endedAt as number).toISOString(),
    });
    assert.deepEqual(listener.frames[1], ended);
    // And it is listed for a tab that reconnects later.
    assert.deepEqual(chatRunRegistry.listRecentRunEnds(), [ended]);
  });
});

test('run_ended reads the outcome from the complete: an abort first, then success, then the exit code', async () => {
  await withIsolatedDatabase(() => {
    const cases: Array<{ complete: Record<string, unknown>; outcome: string }> = [
      { complete: { exitCode: 0, success: true, aborted: false }, outcome: 'done' },
      { complete: { exitCode: 1, success: false, aborted: false }, outcome: 'failed' },
      // `success` decides whenever it is there...
      { complete: { exitCode: 0, success: false }, outcome: 'failed' },
      { complete: { exitCode: 1, success: true }, outcome: 'done' },
      // ...and the exit code when it is not.
      { complete: { exitCode: 1 }, outcome: 'failed' },
      { complete: { exitCode: 0 }, outcome: 'done' },
      // Codex's live turn_complete carries neither; the chat client has always read that as success.
      { complete: {}, outcome: 'done' },
      { complete: { exitCode: 0, success: false, aborted: true }, outcome: 'aborted' },
    ];

    for (const [index, { complete }] of cases.entries()) {
      sessionsDb.createAppSession(`app-outcome-${index}`, 'codex', '/workspace/demo');
      const run = chatRunRegistry.startRun({
        appSessionId: `app-outcome-${index}`,
        provider: 'codex',
        providerSessionId: null,
        connection: null,
        userId: null,
      });
      assert.ok(run);
      run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native', ...complete });
    }

    assert.deepEqual(
      chatRunRegistry.listRecentRunEnds().map((end) => [end.sessionId, end.outcome, end.sessionName]),
      cases.map(({ outcome }, index) => [`app-outcome-${index}`, outcome, null]),
    );
  });
});

test('an aborted run ends once, as aborted, however many completes follow', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-end-abort', 'claude', '/workspace/demo');
    const tab = connectTab();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-end-abort',
      provider: 'claude',
      providerSessionId: null,
      connection: tab,
      userId: null,
    });
    assert.ok(run);

    // What chat.abort does, then the killed runtime's own late complete and the dispatcher's safety net.
    chatRunRegistry.completeRun('app-end-abort', { exitCode: 0, aborted: true });
    run.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode: 1 });
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
    await flushMicrotasks();

    assert.deepEqual(runEndedFrames(tab).map((frame) => frame.outcome), ['aborted']);
    assert.deepEqual(chatRunRegistry.listRecentRunEnds().map((end) => end.outcome), ['aborted']);
  });
});

test('a done turn that leaves background work running says so; other outcomes never do', async () => {
  await withIsolatedDatabase(() => {
    chatRunRegistry.setRetentionGuard((sessionId) => sessionId.startsWith('app-held-'));
    try {
      for (const [sessionId, exitCode] of [['app-held-done', 0], ['app-held-failed', 1], ['app-idle-done', 0]] as const) {
        sessionsDb.createAppSession(sessionId, 'claude', '/workspace/demo');
        const run = chatRunRegistry.startRun({
          appSessionId: sessionId,
          provider: 'claude',
          providerSessionId: null,
          connection: null,
          userId: null,
        });
        assert.ok(run);
        run.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode });
      }

      assert.deepEqual(
        chatRunRegistry.listRecentRunEnds().map((end) => [end.sessionId, end.outcome, end.backgroundWork]),
        [
          ['app-held-done', 'done', true],
          ['app-held-failed', 'failed', false],
          ['app-idle-done', 'done', false],
        ],
      );
    } finally {
      chatRunRegistry.setRetentionGuard(() => false);
    }
  });
});

test('the background work a completed run left behind ends as backgroundDone of that run', async () => {
  await withIsolatedDatabase(async () => {
    chatRunRegistry.setRetentionGuard((sessionId) => sessionId === 'app-bg-1');
    try {
      sessionsDb.createAppSession('app-bg-1', 'claude', '/workspace/demo', 'Audit deps');
      const tab = connectTab();
      const run = chatRunRegistry.startRun({
        appSessionId: 'app-bg-1',
        provider: 'claude',
        providerSessionId: null,
        connection: null,
        userId: null,
      });
      assert.ok(run);

      // Reported while the turn is still going: that ends nothing.
      run.writer.reportBackgroundWorkFinished();
      assert.deepEqual(chatRunRegistry.listRecentRunEnds(), []);

      run.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode: 0 });
      run.writer.reportBackgroundWorkFinished();
      await flushMicrotasks();

      assert.deepEqual(
        runEndedFrames(tab).map((frame) => [frame.outcome, frame.backgroundWork, frame.runStartedAt, frame.sessionName]),
        [
          ['done', true, run.startedAt, 'Audit deps'],
          ['backgroundDone', false, run.startedAt, 'Audit deps'],
        ],
      );
      assert.deepEqual(chatRunRegistry.listRecentRunEnds(), runEndedFrames(tab));
    } finally {
      chatRunRegistry.setRetentionGuard(() => false);
    }
  });
});

test('a background report from a run a newer run replaced is stale and records nothing', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-bg-2', 'claude', '/workspace/demo');
    const start = () => chatRunRegistry.startRun({
      appSessionId: 'app-bg-2',
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId: null,
    });

    const first = start();
    assert.ok(first);
    first.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode: 0 });

    // The user's next message takes the slot, which stops the first run's work.
    const second = start();
    assert.ok(second);
    first.writer.reportBackgroundWorkFinished();
    second.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode: 0 });
    first.writer.reportBackgroundWorkFinished();

    assert.deepEqual(chatRunRegistry.listRecentRunEnds().map((end) => end.outcome), ['done', 'done']);
  });
});

test('a background report from a run whose process the next run took over still counts, until a later run replaces that one', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-bg-handover', 'claude', '/workspace/demo');
    const start = () => chatRunRegistry.startRun({
      appSessionId: 'app-bg-handover',
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId: null,
    });

    const first = start();
    assert.ok(first);
    first.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode: 0 });

    // The next message runs as a turn of the first run's held process, so
    // the work the first turn left going carries on.
    const second = start();
    assert.ok(second);
    first.writer.reportProcessHandedOver();
    first.writer.reportBackgroundWorkFinished();
    assert.deepEqual(
      chatRunRegistry.listRecentRunEnds().map((end) => [end.runStartedAt === first.startedAt, end.outcome]),
      [[true, 'done'], [true, 'backgroundDone']],
    );

    // A later run that replaced the second one stopped whatever was left.
    second.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode: 0 });
    const third = start();
    assert.ok(third);
    first.writer.reportBackgroundWorkFinished();
    assert.equal(chatRunRegistry.listRecentRunEnds().filter((end) => end.outcome === 'backgroundDone').length, 1);
  });
});

test('a background report still counts once the finished run was evicted, while no newer run took its place', async () => {
  // Eviction only asks whether tasks are outstanding. The last one settling
  // ends that, but the follow-up turn that reports it can outlast the window.
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await withIsolatedDatabase(() => {
      sessionsDb.createAppSession('app-bg-3', 'claude', '/workspace/demo');
      const run = chatRunRegistry.startRun({
        appSessionId: 'app-bg-3',
        provider: 'claude',
        providerSessionId: null,
        connection: null,
        userId: null,
      });
      assert.ok(run);
      run.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode: 0 });

      mock.timers.tick(5 * 60 * 1000);
      assert.equal(chatRunRegistry.getRun('app-bg-3'), undefined);

      run.writer.reportBackgroundWorkFinished();
      assert.deepEqual(chatRunRegistry.listRecentRunEnds().map((end) => end.outcome), ['done', 'backgroundDone']);
    });
  } finally {
    mock.timers.reset();
  }
});

test('one socket that throws does not keep a run end from the others', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-end-throw', 'opencode', '/workspace/demo');
    const brokenTab = connectTab();
    brokenTab.send = () => { throw new Error('socket is gone'); };
    const healthyTab = connectTab();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-end-throw',
      provider: 'opencode',
      providerSessionId: null,
      connection: null,
      userId: null,
    });
    assert.ok(run);

    const consoleError = mock.method(console, 'error', () => {});
    try {
      run.writer.send({ kind: 'complete', provider: 'opencode', sessionId: 'native', exitCode: 0 });
      await flushMicrotasks();
    } finally {
      consoleError.mock.restore();
    }

    assert.deepEqual(runEndedFrames(healthyTab).map((frame) => frame.sessionId), ['app-end-throw']);
    assert.equal(consoleError.mock.callCount(), 1);
  });
});

test('run_ended names the session from its row: trimmed, null when blank or when the lookup throws', async () => {
  await withIsolatedDatabase(async () => {
    const tab = connectTab();
    const endRun = (sessionId: string) => {
      const run = chatRunRegistry.startRun({
        appSessionId: sessionId,
        provider: 'claude',
        providerSessionId: null,
        connection: tab,
        userId: null,
      });
      assert.ok(run);
      run.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode: 0 });
    };

    sessionsDb.createAppSession('app-name-padded', 'claude', '/workspace/demo', '  Fix login bug  ');
    sessionsDb.createAppSession('app-name-blank', 'claude', '/workspace/demo', '   ');
    sessionsDb.createAppSession('app-name-throws', 'claude', '/workspace/demo', 'Audit deps');
    endRun('app-name-padded');
    endRun('app-name-blank');

    // The name is read while the turn's complete is on its way out: a failing
    // read must not keep that complete from the tab.
    const lookup = mock.method(sessionsDb, 'getSessionName', () => { throw new Error('database is locked'); });
    const consoleWarn = mock.method(console, 'warn', () => {});
    try {
      endRun('app-name-throws');
      await flushMicrotasks();
    } finally {
      lookup.mock.restore();
      consoleWarn.mock.restore();
    }

    assert.deepEqual(
      tab.frames.map((frame) => [frame.kind, frame.sessionId]),
      [
        ['complete', 'app-name-padded'],
        ['complete', 'app-name-blank'],
        ['complete', 'app-name-throws'],
        ['run_ended', 'app-name-padded'],
        ['run_ended', 'app-name-blank'],
        ['run_ended', 'app-name-throws'],
      ],
    );
    assert.deepEqual(runEndedFrames(tab).map((frame) => frame.sessionName), ['Fix login bug', null, null]);
    assert.equal(chatRunRegistry.isProcessing('app-name-throws'), false);
    assert.equal(consoleWarn.mock.callCount(), 1);
  });
});

test('listRecentRunEnds lists ends oldest first and forgets them after 10 minutes or past 200', async () => {
  await withIsolatedDatabase(() => {
    let now = 1_800_000_000_000;
    const clock = mock.method(Date, 'now', () => now);
    try {
      sessionsDb.createAppSession('app-list', 'opencode', '/workspace/demo');
      const endRunAt = (time: number) => {
        now = time;
        const run = chatRunRegistry.startRun({
          appSessionId: 'app-list',
          provider: 'opencode',
          providerSessionId: null,
          connection: null,
          userId: null,
        });
        assert.ok(run);
        run.writer.send({ kind: 'complete', provider: 'opencode', sessionId: 'native', exitCode: 0 });
      };

      const start = now;
      endRunAt(start);
      endRunAt(start + 1_000);
      endRunAt(start + 2_000);
      const listed = chatRunRegistry.listRecentRunEnds();
      assert.deepEqual(listed.map((end) => [end.runStartedAt, end.endedAt]), [
        [start, start],
        [start + 1_000, start + 1_000],
        [start + 2_000, start + 2_000],
      ]);
      // A copy: emptying it changes nothing.
      listed.length = 0;
      assert.equal(chatRunRegistry.listRecentRunEnds().length, 3);

      // Ten minutes old is still listed; a millisecond more is not.
      now = start + 10 * 60 * 1000;
      assert.equal(chatRunRegistry.listRecentRunEnds().length, 3);
      now += 1;
      assert.deepEqual(chatRunRegistry.listRecentRunEnds().map((end) => end.endedAt), [start + 1_000, start + 2_000]);

      // Past 200, the oldest go first.
      chatRunRegistry.clearAll();
      assert.deepEqual(chatRunRegistry.listRecentRunEnds(), []);
      const burst = now;
      for (let index = 0; index < 201; index += 1) {
        endRunAt(burst + index);
      }
      const capped = chatRunRegistry.listRecentRunEnds();
      assert.equal(capped.length, 200);
      assert.equal(capped[0]?.endedAt, burst + 1);
      assert.equal(capped.at(-1)?.endedAt, burst + 200);

      chatRunRegistry.clearAll();
      assert.deepEqual(chatRunRegistry.listRecentRunEnds(), []);
    } finally {
      clock.mock.restore();
    }
  });
});

test('abortRun aborts a running run through the runtime and completes it as aborted; with no run running it does nothing', async () => {
  await withIsolatedDatabase(async () => {
    const aborts: string[] = [];
    const abort = async (provider: string, appSessionId: string) => {
      aborts.push(`${provider}:${appSessionId}`);
      return true;
    };

    assert.equal(await chatRunRegistry.abortRun('app-abort-none', abort), false);
    assert.deepEqual(aborts, []);

    sessionsDb.createAppSession('app-abort-run', 'codex', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-abort-run',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    assert.equal(await chatRunRegistry.abortRun('app-abort-run', abort), true);
    assert.deepEqual(aborts, ['codex:app-abort-run']);
    assert.equal(chatRunRegistry.isProcessing('app-abort-run'), false);
    const completes = connection.frames.filter((frame) => frame.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0]?.aborted, true);
    assert.equal(completes[0]?.exitCode, 0);

    // Completed already: nothing more to abort.
    assert.equal(await chatRunRegistry.abortRun('app-abort-run', abort), false);
    assert.deepEqual(aborts, ['codex:app-abort-run']);
  });
});

test('abortRun completes a run the runtime could not abort with exit code 1', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-abort-failed', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    chatRunRegistry.startRun({
      appSessionId: 'app-abort-failed',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });

    assert.equal(await chatRunRegistry.abortRun('app-abort-failed', async () => false), true);
    const completes = connection.frames.filter((frame) => frame.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0]?.aborted, true);
    assert.equal(completes[0]?.exitCode, 1);
  });
});

test('abortRun leaves alone a newer run that took the slot while the abort was under way', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-abort-raced', 'codex', '/workspace/demo');
    const connection = new FakeConnection();
    const startRun = () => chatRunRegistry.startRun({
      appSessionId: 'app-abort-raced',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    const firstRun = startRun();
    assert.ok(firstRun);

    let nextRun: ReturnType<typeof startRun> = null;
    const aborted = await chatRunRegistry.abortRun('app-abort-raced', async () => {
      // The runtime ends the turn on its own before it answers the abort,
      // and another send starts the session's next run.
      firstRun.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native', exitCode: 0 });
      nextRun = startRun();
      return true;
    });

    assert.equal(aborted, true);
    assert.ok(nextRun);
    assert.equal(chatRunRegistry.getRun('app-abort-raced'), nextRun);
    assert.equal(chatRunRegistry.isProcessing('app-abort-raced'), true);
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 1);
  });
});

/** Lets the microtasks and immediates queued so far run, a run's `run_ended` broadcast among them. */
const flushRegistry = () => new Promise<void>((resolve) => { setImmediate(resolve); });

test('abortRun ends a run as aborted even when the runtime lets the run settle, and its safety net fire, before it answers', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-abort-settled', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    connectedClients.add(connection as never);
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-abort-settled',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);
    // The chat gateway's dispatch: once the runtime's promise settles, its
    // safety net completes a run the runtime left running.
    let settleRuntime = () => {};
    const dispatch = new Promise<void>((resolve) => { settleRuntime = resolve; })
      .then(() => chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 }));

    // A turn handed to a held process: the abort lets the turn's promise
    // settle before the runtime's answer gets back here.
    const aborted = await chatRunRegistry.abortRun('app-abort-settled', async () => {
      settleRuntime();
      await Promise.resolve();
      return true;
    });
    await dispatch;
    await flushRegistry();

    assert.equal(aborted, true);
    const completes = connection.frames.filter((frame) => frame.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0]?.aborted, true);
    assert.equal(completes[0]?.exitCode, 0);
    assert.deepEqual(
      connection.frames.filter((frame) => frame.kind === 'run_ended').map((frame) => frame.outcome),
      ['aborted'],
    );
  });
});

test('abortRun still ends the run, as aborted with exit code 1, when the runtime\'s abort throws, and passes the error on', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-abort-throws', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-abort-throws',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);
    let settleRuntime = () => {};
    const dispatch = new Promise<void>((resolve) => { settleRuntime = resolve; })
      .then(() => chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 }));

    // The safety net fires while the abort is under way and holds off for
    // the abort's own complete, which must come even though the abort fails.
    await assert.rejects(
      chatRunRegistry.abortRun('app-abort-throws', async () => {
        settleRuntime();
        await Promise.resolve();
        throw new Error('the interrupt failed');
      }),
      /the interrupt failed/,
    );
    await dispatch;

    assert.equal(chatRunRegistry.isProcessing('app-abort-throws'), false);
    const completes = connection.frames.filter((frame) => frame.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0]?.aborted, true);
    assert.equal(completes[0]?.exitCode, 1);
  });
});

test('a second abortRun of a run already being aborted waits for the first instead of calling the runtime again', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-abort-twice', 'codex', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-abort-twice',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);
    const aborts: string[] = [];
    let answerAbort = () => {};
    const abort = (_provider: string, appSessionId: string) => {
      aborts.push(appSessionId);
      return new Promise<boolean>((resolve) => { answerAbort = () => resolve(true); });
    };

    const first = chatRunRegistry.abortRun('app-abort-twice', abort);
    let secondSettled = false;
    const second = chatRunRegistry.abortRun('app-abort-twice', abort).then((result) => {
      secondSettled = true;
      return result;
    });
    await flushRegistry();
    assert.deepEqual(aborts, ['app-abort-twice']);
    assert.equal(secondSettled, false, 'the second abort waits for the first');

    answerAbort();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    const completes = connection.frames.filter((frame) => frame.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0]?.aborted, true);
  });
});

test('pendingAbort is the abort under way until it has completed the run, and null otherwise', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-abort-pending', 'claude', '/workspace/demo');
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-abort-pending',
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId: null,
    });
    assert.ok(run);
    assert.equal(chatRunRegistry.pendingAbort(run), null);

    let answerAbort = () => {};
    const aborting = chatRunRegistry.abortRun(
      'app-abort-pending',
      () => new Promise<boolean>((resolve) => { answerAbort = () => resolve(true); }),
    );
    const pending = chatRunRegistry.pendingAbort(run);
    assert.ok(pending);
    let completesWhenSettled: number | null = null;
    const settled = pending.then(() => {
      completesWhenSettled = run.events.filter((event) => event.kind === 'complete' && event.aborted === true).length;
    });

    answerAbort();
    await aborting;
    await settled;
    assert.equal(completesWhenSettled, 1, 'it settles with the aborted complete already out');
    assert.equal(chatRunRegistry.pendingAbort(run), null);
  });
});

test('whenHandedOver settles once the run\'s turn has completed and its process went on to the session\'s next run, and only then', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-handed-over', 'claude', '/workspace/demo');
    const start = () => chatRunRegistry.startRun({
      appSessionId: 'app-handed-over',
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId: null,
    });

    const first = start();
    assert.ok(first);
    let firstHandedOver = false;
    void chatRunRegistry.whenHandedOver(first).then(() => { firstHandedOver = true; });
    first.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode: 0 });
    await flushRegistry();
    assert.equal(firstHandedOver, false, 'a completed turn whose process is still its own is not handed over');

    // The user's next message runs as a turn of the first run's held process.
    const second = start();
    assert.ok(second);
    first.writer.reportProcessHandedOver();
    await flushRegistry();
    assert.equal(firstHandedOver, true);

    // A run whose turn completes and is then replaced, rather than handed
    // over, never settles; nor does one that reports a hand-over with no
    // other run in the slot.
    let secondHandedOver = false;
    void chatRunRegistry.whenHandedOver(second).then(() => { secondHandedOver = true; });
    second.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode: 0 });
    second.writer.reportProcessHandedOver();
    const third = start();
    assert.ok(third);
    await flushRegistry();
    assert.equal(secondHandedOver, false);
  });
});
