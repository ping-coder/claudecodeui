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
import type { ProviderRuntimeWriter } from '@/shared/types.js';

/**
 * A turn whose switches last for it alone (`restoreSwitchesAfterTurn`, as the
 * scheduled-messages dispatcher sends a queued or due message) records its
 * model on the session while it runs, as every turn does, and puts the
 * session's own model back once the provider has switched its process back:
 * the composer shows the record when the session is opened again, and the
 * user's next send must not switch the /loop for good to a model only that
 * message ran on.
 */

const SESSION_ID = 'turn-model-session';

type Dependencies = Parameters<typeof runDetachedChatTurn>[1];
type HeldWriter = ProviderRuntimeWriter & { sendComplete(opts: { exitCode: number }): void };
type SwitchesRestored = { model: string | null; permissionMode: string | null };

/**
 * A runtime holding the session's process on `processModel`, in the default
 * permission mode, as Claude's does for a /loop. Each run reads its model off
 * the session's record, as the runtime resolves a resumed turn's, switches
 * the process to it, and to the permission mode its options name, for a
 * turn whose options set `restoreSwitchesAfterTurn`, and ends its turn at
 * once. The process stays, switched back, and the runtime calls the turn's
 * `onSwitchesRestored` only when the test confirms it (`confirmSwitchBacks`,
 * oldest first), as the CLI answers the switch back after the turn's
 * `complete` has gone out: with what the process runs with now for each of
 * the model and the permission mode the turn was to switch, null for one it
 * was not. With `stopsBeforeSwitching`, each such turn is stopped while it
 * waits for a turn the CLI runs on its own: it never runs, and nothing is
 * switched, but the runtime calls back the same. With `letsGo`, the process
 * lets go after the turn, and nothing is switched back.
 */
function createHeldProcessRuntime(
  processModel: string,
  { letsGo = false, stopsBeforeSwitching = false }: { letsGo?: boolean; stopsBeforeSwitching?: boolean } = {},
) {
  let live = processModel;
  const ranOn: string[] = [];
  const options: Array<Record<string, unknown>> = [];
  const pendingSwitchBacks: Array<() => void> = [];
  const dependencies = {
    runtime: {
      hasRuntime: () => true,
      run: async (_provider: string, _command: string, runOptions: Record<string, unknown>, writer: HeldWriter) => {
        options.push(runOptions);
        const turnModel = sessionsDb.getSessionById(SESSION_ID)?.model ?? live;
        const before = live;
        const switchesModel = turnModel !== before;
        const switchesPermissionMode = typeof runOptions.permissionMode === 'string'
          && runOptions.permissionMode !== 'default';
        const stopped = stopsBeforeSwitching && runOptions.restoreSwitchesAfterTurn === true;
        if (!stopped) {
          live = turnModel;
          ranOn.push(turnModel);
        }
        writer.sendComplete({ exitCode: 0 });
        if (letsGo || runOptions.restoreSwitchesAfterTurn !== true) {
          return;
        }
        // Switched back for planning at once; the CLI answers later.
        live = before;
        pendingSwitchBacks.push(() => {
          const report = runOptions.onSwitchesRestored;
          if (typeof report === 'function') {
            (report as (restored: SwitchesRestored) => void)({
              model: switchesModel ? live : null,
              permissionMode: switchesPermissionMode ? 'default' : null,
            });
          }
        });
      },
    },
  } as unknown as Dependencies;

  return {
    dependencies,
    ranOn,
    options,
    live: () => live,
    confirmSwitchBacks: (count = pendingSwitchBacks.length) => {
      for (const confirm of pendingSwitchBacks.splice(0, count)) {
        confirm();
      }
    },
  };
}

async function withSession(runTest: () => Promise<void>, recordedModel: string | null = 'sonnet'): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-turn-model-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Turn model session');
    if (recordedModel) {
      sessionsDb.setSessionModel(SESSION_ID, recordedModel);
    }
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

const recordedModel = () => sessionsDb.getSessionById(SESSION_ID)?.model ?? null;

/** A queued or due message's turn, as the dispatcher sends it. */
const runMessage = (
  dependencies: Dependencies,
  content: string,
  model: string,
  composerOptions: Record<string, unknown> = {},
) => runDetachedChatTurn(
  {
    sessionId: SESSION_ID,
    userId: 1,
    content,
    options: { ...composerOptions, model, inheritUnset: true, restoreSwitchesAfterTurn: true },
  },
  dependencies,
);

test('a message\'s turn runs on its own model, and once the process is switched back the session\'s recorded model is the one before it', async () => {
  await withSession(async () => {
    const held = createHeldProcessRuntime('sonnet');

    await runMessage(held.dependencies, 'check on the loop', 'opus');

    assert.deepEqual(held.ranOn, ['opus'], 'the runtime read the message\'s model off the record');
    assert.equal(recordedModel(), 'opus', 'recorded while the switch back is still to come');
    held.confirmSwitchBacks();
    assert.equal(recordedModel(), 'sonnet');
    assert.equal(held.live(), 'sonnet');
  });
});

test('the model recorded before goes back, not the one the process went back to, when the user had picked another since the /loop started', async () => {
  await withSession(async () => {
    const held = createHeldProcessRuntime('sonnet');

    await runMessage(held.dependencies, 'check on the loop', 'opus');
    held.confirmSwitchBacks();

    assert.equal(held.live(), 'sonnet');
    assert.equal(recordedModel(), 'haiku');
  }, 'haiku');
});

test('a model the user picks while the message\'s turn runs is kept once the process is switched back', async () => {
  await withSession(async () => {
    const held = createHeldProcessRuntime('sonnet');

    await runMessage(held.dependencies, 'check on the loop', 'opus');
    // POST active-model, from a composer.
    sessionsDb.setSessionModel(SESSION_ID, 'haiku');
    held.confirmSwitchBacks();

    assert.equal(recordedModel(), 'haiku');
  });
});

test('the model recorded before goes back though the turn switched only the permission mode, or nothing, and once only', async () => {
  // The user picked haiku after scheduling; the message names the process's own model.
  for (const permissionMode of ['acceptEdits', 'default']) {
    await withSession(async () => {
      const held = createHeldProcessRuntime('sonnet');

      await runMessage(held.dependencies, `in ${permissionMode} mode`, 'sonnet', { permissionMode });
      assert.equal(recordedModel(), 'sonnet');
      held.confirmSwitchBacks();
      assert.equal(recordedModel(), 'haiku', permissionMode);

      // A second call is no news: the user's pick since stays.
      sessionsDb.setSessionModel(SESSION_ID, 'sonnet');
      const report = held.options[0]?.onSwitchesRestored as (restored: SwitchesRestored) => void;
      report({ model: null, permissionMode: null });
      assert.equal(recordedModel(), 'sonnet', permissionMode);
    }, 'haiku');
  }
});

test('with no switch back (the process let go after the turn), the turn\'s model stays recorded', async () => {
  await withSession(async () => {
    const held = createHeldProcessRuntime('sonnet', { letsGo: true });

    await runMessage(held.dependencies, 'check on the loop', 'opus');
    held.confirmSwitchBacks();

    assert.equal(recordedModel(), 'opus');
  });
});

test('with nothing recorded before, the model the process went back to is recorded, and a turn that switched no model leaves its own', async () => {
  await withSession(async () => {
    const held = createHeldProcessRuntime('sonnet');

    await runMessage(held.dependencies, 'check on the loop', 'opus');
    held.confirmSwitchBacks();
    assert.equal(recordedModel(), 'sonnet');
  }, null);

  await withSession(async () => {
    const held = createHeldProcessRuntime('sonnet');

    await runMessage(held.dependencies, 'in acceptEdits mode', 'sonnet', { permissionMode: 'acceptEdits' });
    held.confirmSwitchBacks();
    assert.equal(recordedModel(), 'sonnet');
  }, null);
});

test('two messages\' turns faster than the first one\'s switch back leave the model recorded before the first, whichever models they name', async () => {
  for (const [first, second] of [['opus', 'haiku'], ['opus', 'opus']] as const) {
    await withSession(async () => {
      const held = createHeldProcessRuntime('sonnet');

      // Due messages of one session in one pass: the second goes as soon as
      // the first one's turn is over, before its switch back is answered.
      await runMessage(held.dependencies, 'first', first);
      await runMessage(held.dependencies, 'second', second);
      assert.deepEqual(held.ranOn, [first, second]);
      held.confirmSwitchBacks();

      assert.equal(recordedModel(), 'sonnet', `${first} then ${second}`);
      assert.equal(held.live(), 'sonnet');
    });
  }
});

test('of two messages\' turns on one model faster than the first one\'s switch back, the second one\'s model stays recorded until its own, and a model the user picked while the first ran is kept', async () => {
  for (const userPick of ['haiku', null] as const) {
    await withSession(async () => {
      const held = createHeldProcessRuntime('sonnet');

      await runMessage(held.dependencies, 'first', 'opus');
      if (userPick) {
        // POST active-model, from a composer, before the first one's turn was over.
        sessionsDb.setSessionModel(SESSION_ID, userPick);
      }
      await runMessage(held.dependencies, 'second', 'opus');
      assert.deepEqual(held.ranOn, ['opus', 'opus']);

      held.confirmSwitchBacks(1);
      assert.equal(recordedModel(), 'opus', `the second one's turn is still on its own (picked ${userPick})`);
      held.confirmSwitchBacks();
      assert.equal(recordedModel(), userPick ?? 'sonnet');
      assert.equal(held.live(), 'sonnet');
    });
  }
});

test('a message\'s turn stopped before it switched anything, as it waited for a turn the CLI ran on its own, puts the model recorded before back once the runtime calls back, and once only', async () => {
  await withSession(async () => {
    const held = createHeldProcessRuntime('sonnet', { stopsBeforeSwitching: true });

    await runMessage(held.dependencies, 'check on the loop', 'opus');
    assert.deepEqual(held.ranOn, []);
    assert.equal(recordedModel(), 'opus', 'recorded while it waited');
    held.confirmSwitchBacks();
    assert.equal(recordedModel(), 'sonnet');
    assert.equal(held.live(), 'sonnet');

    // A second call is no news: the user's pick since stays, though it is the message's model.
    sessionsDb.setSessionModel(SESSION_ID, 'opus');
    const report = held.options[0]?.onSwitchesRestored as (restored: SwitchesRestored) => void;
    report({ model: 'sonnet', permissionMode: null });
    assert.equal(recordedModel(), 'opus');
  });

  await withSession(async () => {
    const held = createHeldProcessRuntime('sonnet', { stopsBeforeSwitching: true });

    await runMessage(held.dependencies, 'check on the loop', 'opus');
    // POST active-model, from a composer, while it waited.
    sessionsDb.setSessionModel(SESSION_ID, 'haiku');
    held.confirmSwitchBacks();
    assert.equal(recordedModel(), 'haiku');
  });
});

test('a composer\'s send keeps its model recorded, and its run gets no callback, whatever the client sent under that name', async () => {
  await withSession(async () => {
    const held = createHeldProcessRuntime('sonnet');
    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: (data: string) => void };
    socket.readyState = 1;
    socket.send = () => {};
    handleChatConnection(socket as never, { user: { id: 1 } } as never, held.dependencies as never);

    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: 'switch the loop to opus',
      options: { model: 'opus', onSwitchesRestored: 'not a callback' },
    }));
    for (let round = 0; round < 5 && held.options.length === 0; round += 1) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }

    assert.equal(held.options.length, 1);
    assert.equal('onSwitchesRestored' in (held.options[0] ?? {}), false);
    assert.equal(recordedModel(), 'opus');
  });
});
