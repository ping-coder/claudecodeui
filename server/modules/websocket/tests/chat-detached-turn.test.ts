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
 * A runtime gateway whose runs do what `behave` says with the run's writer;
 * every other method is never called here.
 */
function createDependencies(behave: (writer: HeldWriter) => Promise<void>): Dependencies {
  return {
    runtime: {
      hasRuntime: () => true,
      run: async (_provider: string, _command: string, _options: Record<string, unknown>, writer: HeldWriter) => {
        await behave(writer);
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
