import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { runDetachedChatTurn } from '@/modules/websocket/services/chat-websocket.service.js';
import type { ProviderRuntimeWriter } from '@/shared/types.js';

/**
 * A turn run with no client attached (a scheduled or queued message) tells
 * its caller when the turn is over (`onTurnEnded`), while its run may stay
 * open much longer, holding its process for work the turn left going.
 */

const SESSION_ID = 'detached-turn-session';

type Dependencies = Parameters<typeof runDetachedChatTurn>[1];
type HeldWriter = ProviderRuntimeWriter & { sendComplete(opts: { exitCode: number }): void };

/**
 * A runtime gateway whose runs do what `behave` says with the run's writer
 * and options; every other method is never called here.
 */
function createDependencies(behave: (writer: HeldWriter, options: Record<string, unknown>) => Promise<void>): Dependencies {
  return {
    runtime: {
      hasRuntime: () => true,
      run: async (_provider: string, _command: string, options: Record<string, unknown>, writer: HeldWriter) => {
        await behave(writer, options);
      },
    },
  } as unknown as Dependencies;
}

async function withSession(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-detached-turn-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Detached turn session');
    await runTest();
  } finally {
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

const flush = () => new Promise<void>((resolve) => { setImmediate(resolve); });

test('onTurnEnded is called once the turn\'s complete is out, while the run holding its process has not settled', async () => {
  await withSession(async () => {
    let exitProcess = () => {};
    const dependencies = createDependencies(async (writer) => {
      writer.send({ kind: 'text', provider: 'claude', sessionId: 'native', content: 'started the loop' });
      writer.sendComplete({ exitCode: 0 });
      // The process stays open for the loop's next wake-up.
      await new Promise<void>((resolve) => { exitProcess = resolve; });
    });

    let turnsEnded = 0;
    let settled = false;
    const result = runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: '/loop 5m check CI', onTurnEnded: () => { turnsEnded += 1; } },
      dependencies,
    );
    void result.then(() => { settled = true; });
    await flush();

    assert.equal(turnsEnded, 1);
    assert.equal(settled, false, 'the run settles only once its process exits');
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);

    exitProcess();
    assert.deepEqual(await result, { started: true, error: null });
    await flush();
    assert.equal(turnsEnded, 1, 'told once');
  });
});

test('onTurnEnded is called for a turn the safety net ends, and the run\'s failure still reaches the result', async () => {
  await withSession(async () => {
    const dependencies = createDependencies(async () => {
      throw new Error('provider exploded');
    });

    let turnsEnded = 0;
    const result = await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: 'will fail', onTurnEnded: () => { turnsEnded += 1; } },
      dependencies,
    );
    await flush();

    assert.equal(turnsEnded, 1);
    assert.deepEqual(result, { started: true, error: 'provider exploded' });
  });
});

test('onTurnEnded is never called for a turn whose run did not start', async () => {
  await withSession(async () => {
    const busy = chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId: 1,
    });
    assert.ok(busy);

    let turnsEnded = 0;
    const result = await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: 'not now', onTurnEnded: () => { turnsEnded += 1; } },
      createDependencies(async () => {}),
    );
    busy.writer.sendComplete({ exitCode: 0 });
    await flush();

    assert.equal(result.started, false);
    assert.equal(turnsEnded, 0, 'the turn under way is someone else\'s');
  });
});

test('onStarted is called once the run has started, before the provider runtime gets the turn, and never for a run that did not start', async () => {
  await withSession(async () => {
    const order: string[] = [];
    const dependencies = createDependencies(async (writer) => {
      order.push('run');
      writer.sendComplete({ exitCode: 0 });
    });

    const result = await runDetachedChatTurn(
      {
        sessionId: SESSION_ID,
        userId: 1,
        content: 'cancel the loop',
        onStarted: () => { order.push(`started, session busy: ${chatRunRegistry.isProcessing(SESSION_ID)}`); },
      },
      dependencies,
    );
    await flush();

    assert.deepEqual(result, { started: true, error: null });
    assert.deepEqual(order, ['started, session busy: true', 'run'], 'called once, with the session reserved, before the turn runs');

    // A session busy with someone else's turn starts no run.
    const busy = chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId: 1,
    });
    assert.ok(busy);
    let startedWhileBusy = 0;
    const refused = await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: 'not now', onStarted: () => { startedWhileBusy += 1; } },
      createDependencies(async () => {}),
    );
    busy.writer.sendComplete({ exitCode: 0 });
    await flush();

    assert.equal(refused.started, false);
    assert.equal(startedWhileBusy, 0);
  });
});

test('a turn handed to the process an earlier run left held reaches every socket that watched that run, and so does the work that process goes on with', async () => {
  await withSession(async () => {
    // The /loop's turn, from a tab, has ended; its process is held for the loop.
    const tab = { readyState: 1, frames: [] as Array<Record<string, unknown>>, send(data: string) { this.frames.push(JSON.parse(data) as Record<string, unknown>); } };
    const loopRun = chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: tab,
      userId: 1,
    });
    assert.ok(loopRun);
    loopRun.writer.sendComplete({ exitCode: 0 });

    let writeFiring = () => {};
    const dependencies = createDependencies(async (writer) => {
      // A due message goes into that process, as Claude's runtime hands it over.
      loopRun.writer.reportProcessHandedOver();
      writer.send({ kind: 'text', provider: 'claude', sessionId: 'native', content: 'Posted.' });
      writer.sendComplete({ exitCode: 0 });
      // The loop's next firing writes through the turn's writer.
      writeFiring = () => writer.send({ kind: 'text', provider: 'claude', sessionId: 'native', content: 'TICK' });
    });

    const result = await runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'post a summary' }, dependencies);
    writeFiring();

    assert.deepEqual(result, { started: true, error: null });
    assert.deepEqual(
      tab.frames.map((frame) => (frame.kind === 'text' ? `text:${String(frame.content)}` : String(frame.kind))),
      ['complete', 'text:Posted.', 'complete', 'text:TICK'],
    );
  });
});

test('a detached turn keeps the acceptProcessSettings its options carry: the scheduled-messages dispatcher\'s, which a client\'s send never does', async () => {
  await withSession(async () => {
    const runOptions: Array<Record<string, unknown>> = [];
    const dependencies = createDependencies(async (writer, options) => {
      runOptions.push(options);
      writer.sendComplete({ exitCode: 0 });
    });

    await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: 'dig deeper', options: { effort: 'max', acceptProcessSettings: true } },
      dependencies,
    );
    await runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'and again', options: { effort: 'max' } }, dependencies);

    assert.equal(runOptions.length, 2);
    assert.equal(runOptions[0]?.acceptProcessSettings, true);
    assert.equal(runOptions[0]?.effort, 'max');
    assert.equal('acceptProcessSettings' in (runOptions[1] ?? {}), false);
  });
});

test('a detached turn the runtime turns away at the hand-over (HAND_OVER_FAILED) tells its caller why, and its result reads as before', async () => {
  await withSession(async () => {
    const content = 'Not sent: this message changes the reasoning effort, which only a new Claude process can apply, and a new process would stop the session\'s scheduled work.';
    const failures: Array<{ reason: string | null; content: string | null }> = [];
    const result = await runDetachedChatTurn(
      {
        sessionId: SESSION_ID,
        userId: 1,
        content: 'dig deeper',
        options: { effort: 'max', acceptProcessSettings: true },
        onHandOverFailed: (failure) => { failures.push(failure); },
      },
      createDependencies(async (writer) => {
        // As Claude's runtime fails such a turn (failHandOver).
        writer.send({ kind: 'error', code: 'HAND_OVER_FAILED', reason: 'stale-plan', content, sessionId: 'native', provider: 'claude' });
        throw Object.assign(new Error(content), { code: 'HAND_OVER_FAILED', reason: 'stale-plan' });
      }),
    );

    assert.equal(JSON.stringify(failures), JSON.stringify([{ reason: 'stale-plan', content }]));
    assert.equal(JSON.stringify(result), JSON.stringify({ started: true, error: content }), 'nothing new in the result');
  });
});

test('a detached turn whose run fails otherwise, or does not start, tells its caller of no hand-over failure', async () => {
  await withSession(async () => {
    let told = 0;
    const onHandOverFailed = () => { told += 1; };

    const failed = await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: 'will fail', onHandOverFailed },
      createDependencies(async (writer) => {
        writer.send({ kind: 'error', code: 'BACKGROUND_WORK_STOPPED', changes: ['effort'], content: 'Background work stopped.', sessionId: 'native', provider: 'claude' });
        throw new Error('provider exploded');
      }),
    );
    const done = await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: 'fine', onHandOverFailed },
      createDependencies(async (writer) => { writer.sendComplete({ exitCode: 0 }); }),
    );
    const busy = chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId: 1,
    });
    assert.ok(busy);
    const refused = await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: 'not now', onHandOverFailed },
      createDependencies(async () => {}),
    );
    busy.writer.sendComplete({ exitCode: 0 });

    assert.equal(failed.error, 'provider exploded');
    assert.equal(done.error, null);
    assert.equal(refused.started, false);
    assert.equal(told, 0);
  });
});
