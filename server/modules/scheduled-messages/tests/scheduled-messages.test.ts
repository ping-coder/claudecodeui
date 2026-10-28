import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { closeConnection, initializeDatabase, scheduledMessagesDb, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import {
  closeScheduledMessageDispatcher,
  dispatchDueScheduledMessages,
  dispatchQueuedMessages,
  initializeScheduledMessageDispatcher,
} from '@/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js';
import { scheduledMessagesService } from '@/modules/scheduled-messages/services/scheduled-messages.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

const SESSION_ID = 'scheduled-session';
const OTHER_SESSION_ID = 'other-session';
const ANOTHER_SESSION_ID = 'another-session';
/** The dispatcher's poll interval. */
const POLL_INTERVAL_MS = 30_000;

async function withIsolatedDatabase(runTest: (userId: number) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'scheduled-messages-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const user = userDb.createUser('scheduler', 'hash');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Scheduled session');
    await runTest(Number(user.id));
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

type RunCall = { provider: string; command: string; options: Record<string, unknown> };

function createRuntime(
  runs: RunCall[],
  behaviour: 'ok' | 'throw' = 'ok',
  aborts: string[] = [],
  hasBackgroundWork: (sessionId: string) => boolean = () => false,
) {
  return {
    hasRuntime: () => true,
    hasBackgroundWork,
    run: async (provider: string, command: string, options: Record<string, unknown>) => {
      if (behaviour === 'throw') {
        throw new Error('provider exploded');
      }
      runs.push({ provider, command, options });
    },
    abort: async (_provider: string, sessionId: string) => {
      aborts.push(sessionId);
      return true;
    },
  } as never;
}

/**
 * A runtime whose run for `heldSessionId` ends its turn and then stays open
 * until `release` is called, like a Claude run whose turn backgrounded a long
 * build: the registry shows the turn completed, and the session reports
 * background work unless `reportsBackgroundWork` is false (the CLI is only
 * winding down). Runs after the release, and runs for other sessions, settle
 * at once.
 */
function createHoldingRuntime(
  runs: RunCall[],
  heldSessionId: string,
  { reportsBackgroundWork = true }: { reportsBackgroundWork?: boolean } = {},
) {
  const aborts: string[] = [];
  let holding = false;
  let released = false;
  let releaseHeldRun = () => {};

  const runtime = {
    hasRuntime: () => true,
    hasBackgroundWork: (sessionId: string) => reportsBackgroundWork && holding && sessionId === heldSessionId,
    run: async (
      provider: string,
      command: string,
      options: Record<string, unknown>,
      writer: { sendComplete(opts: { exitCode: number }): void },
    ) => {
      runs.push({ provider, command, options });
      if (options.sessionId !== heldSessionId || released) {
        return;
      }
      holding = true;
      writer.sendComplete({ exitCode: 0 });
      await new Promise<void>((resolve) => {
        releaseHeldRun = resolve;
      });
      holding = false;
    },
    abort: async (_provider: string, sessionId: string) => {
      aborts.push(sessionId);
      return true;
    },
  } as never;

  return {
    runtime,
    aborts,
    release: () => {
      released = true;
      releaseHeldRun();
    },
  };
}

/** Lets the passes started so far run as far as they can without a real provider. */
function flushPasses(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function commandsFor(runs: RunCall[], sessionId: string): string[] {
  return runs.filter((run) => run.options.sessionId === sessionId).map((run) => run.command);
}

function secondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1_000).toISOString();
}

test('a message due in the past is sent on the next pass, not skipped', async () => {
  await withIsolatedDatabase(async (userId) => {
    // The server was down when this came due.
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'run the nightly checks',
      scheduledFor: new Date(Date.now() - 60_000).toISOString(),
    });

    const runs: RunCall[] = [];
    const sent = await dispatchDueScheduledMessages(createRuntime(runs));

    assert.equal(sent, 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'run the nightly checks');
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'sent');
  });
});

test('a queued message is sent by the server without a browser connection', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: {
        content: 'continue on the VPS',
        options: { model: 'claude-opus-5' },
        attachments: [{ path: '/tmp/upload.png' }],
      },
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'continue on the VPS');
    assert.equal(runs[0].options.model, 'claude-opus-5');
    assert.deepEqual(runs[0].options.attachments, []);
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});

test('a queued message stays pending while its session is busy', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: { content: 'send after this run' },
    });
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 0);
    assert.equal(runs.length, 0);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, {
      content: 'send after this run',
    });
  });
});

test('a queued message waits for background work its session\'s last turn left running', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: { content: 'send after the background job' },
    });
    // Turn A ended, so its run is completed, but it backgrounded a command
    // that is still running under A's CLI process.
    const runA = chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });
    runA!.writer.sendComplete({ exitCode: 0 });
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);

    let backgroundWork = true;
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs, 'ok', [], (sessionId) => sessionId === SESSION_ID && backgroundWork);

    // Starting B now would replace that process and stop the command.
    assert.equal(await dispatchQueuedMessages(runtime), 0);
    assert.equal(runs.length, 0);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, {
      content: 'send after the background job',
    });

    // Once the work has reported back, B goes on the next pass.
    backgroundWork = false;
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'send after the background job');
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});

test('follow-ups queued during one turn are all sent, once, in order, as the next turn', async () => {
  await withIsolatedDatabase(async (userId) => {
    for (const content of ['follow-up A', 'follow-up B', 'follow-up C']) {
      sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, { content, options: { model: 'opus' }, attachments: [] });
    }

    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 0, 'nothing is left to send');

    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'follow-up A\n\nfollow-up B\n\nfollow-up C');
    assert.equal(runs[0].options.model, 'opus');
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});

test('a draft-text save after the queued message was sent does not send it again', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, { content: 'send me once', attachments: [] });
    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);

    // The composer keeps saving its text while the user types the next
    // follow-up; its copy of the queue still holds the message just sent.
    sessionDraftsDb.saveDraftText(userId, SESSION_ID, 'typing the next one');

    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 0);
    assert.deepEqual(runs.map((run) => run.command), ['send me once']);
  });
});

test('a due message interrupts a run in progress instead of failing', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'the schedule wins',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });

    const runs: RunCall[] = [];
    const aborts: string[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs, 'ok', aborts)), 1);

    assert.deepEqual(aborts, [SESSION_ID]);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'the schedule wins');
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'sent');
  });
});

test('a message that is not due yet is left alone', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'later',
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs)), 0);
    assert.equal(runs.length, 0);
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'pending');
  });
});

test('a due message is claimed once, so overlapping passes cannot double-send it', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'only once',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    await Promise.all([
      dispatchDueScheduledMessages(runtime),
      dispatchDueScheduledMessages(runtime),
    ]);

    assert.equal(runs.length, 1);
  });
});

test('a dispatched turn holding its process open for background work does not hold up other sessions', { timeout: 10_000 }, async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    await withIsolatedDatabase(async (userId) => {
      sessionsDb.createAppSession(OTHER_SESSION_ID, 'claude', '/workspace/demo', 'Other session');
      sessionsDb.createAppSession(ANOTHER_SESSION_ID, 'claude', '/workspace/demo', 'Another session');
      const runs: RunCall[] = [];
      const { runtime, release } = createHoldingRuntime(runs, SESSION_ID);

      // A queued turn backgrounds a build that runs for hours. The turn ends,
      // but its run stays open until the build reports back.
      sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, { content: 'start the build', attachments: [] });
      initializeScheduledMessageDispatcher(runtime);
      try {
        await flushPasses();
        assert.deepEqual(runs.map((run) => run.command), ['start the build']);
        assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);

        sessionDraftsDb.appendQueuedMessage(userId, OTHER_SESSION_ID, {
          content: 'queued for another session',
          attachments: [],
        });
        scheduledMessagesService.schedule({
          userId,
          sessionId: ANOTHER_SESSION_ID,
          content: 'due for another session',
          scheduledFor: secondsAgo(1),
        });

        mock.timers.tick(POLL_INTERVAL_MS);
        await flushPasses();

        assert.deepEqual(commandsFor(runs, OTHER_SESSION_ID), ['queued for another session']);
        assert.deepEqual(commandsFor(runs, ANOTHER_SESSION_ID), ['due for another session']);
        assert.equal(scheduledMessagesDb.listForSession(userId, ANOTHER_SESSION_ID)[0].status, 'sent');
      } finally {
        release();
        await flushPasses();
      }
    });
  } finally {
    closeScheduledMessageDispatcher();
    mock.timers.reset();
  }
});

test('a due message waiting for its session\'s previous turn stays pending while other sessions\' messages go', { timeout: 10_000 }, async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionsDb.createAppSession(OTHER_SESSION_ID, 'claude', '/workspace/demo', 'Other session');
    const first = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'first',
      scheduledFor: secondsAgo(3),
    });
    const other = scheduledMessagesService.schedule({
      userId,
      sessionId: OTHER_SESSION_ID,
      content: 'for another session',
      scheduledFor: secondsAgo(2),
    });
    const second = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'second',
      scheduledFor: secondsAgo(1),
    });
    const statusOf = (sessionId: string, id: string) =>
      scheduledMessagesDb.listForSession(userId, sessionId).find((row) => row.id === id)?.status;

    // The first message's turn backgrounds a long build, so its run stays open.
    const runs: RunCall[] = [];
    const { runtime, release } = createHoldingRuntime(runs, SESSION_ID);
    const pass = dispatchDueScheduledMessages(runtime);
    try {
      await flushPasses();
      assert.deepEqual(commandsFor(runs, SESSION_ID), ['first']);
      assert.deepEqual(commandsFor(runs, OTHER_SESSION_ID), ['for another session']);
      assert.equal(statusOf(OTHER_SESSION_ID, other.id), 'sent');
      // Not marked sent before it goes: it can still be cancelled meanwhile,
      // and a restart now would not lose it.
      assert.equal(statusOf(SESSION_ID, second.id), 'pending');
    } finally {
      release();
      await pass;
    }

    // Once the build has reported back, the second follows the first.
    assert.equal(await pass, 3);
    assert.deepEqual(commandsFor(runs, SESSION_ID), ['first', 'second']);
    assert.equal(statusOf(SESSION_ID, first.id), 'sent');
    assert.equal(statusOf(SESSION_ID, second.id), 'sent');
  });
});

test('a due message waiting for its session\'s previous turn can still be cancelled, and then never goes', { timeout: 10_000 }, async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'first',
      scheduledFor: secondsAgo(2),
    });
    const second = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'second',
      scheduledFor: secondsAgo(1),
    });

    const runs: RunCall[] = [];
    const { runtime, release } = createHoldingRuntime(runs, SESSION_ID);
    const pass = dispatchDueScheduledMessages(runtime);
    try {
      await flushPasses();
      scheduledMessagesService.cancel(userId, second.id);
    } finally {
      release();
      await pass;
    }

    assert.equal(await pass, 1);
    assert.deepEqual(runs.map((run) => run.command), ['first']);
    assert.equal(
      scheduledMessagesDb.listForSession(userId, SESSION_ID).find((row) => row.id === second.id)?.status,
      'cancelled',
    );
  });
});

test('a message that comes due while a dispatched turn holds its session waits for it instead of interrupting it', { timeout: 10_000 }, async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    await withIsolatedDatabase(async (userId) => {
      const runs: RunCall[] = [];
      const { runtime, aborts, release } = createHoldingRuntime(runs, SESSION_ID);
      sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, { content: 'start the build', attachments: [] });
      initializeScheduledMessageDispatcher(runtime);
      try {
        await flushPasses();
        scheduledMessagesService.schedule({
          userId,
          sessionId: SESSION_ID,
          content: 'due during the build',
          scheduledFor: secondsAgo(1),
        });

        mock.timers.tick(POLL_INTERVAL_MS);
        await flushPasses();

        assert.deepEqual(runs.map((run) => run.command), ['start the build']);
        assert.deepEqual(aborts, []);
        assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'pending');
      } finally {
        release();
        await flushPasses();
      }

      // The build has reported back and the run has settled: the next poll sends it.
      mock.timers.tick(POLL_INTERVAL_MS);
      await flushPasses();
      assert.deepEqual(runs.map((run) => run.command), ['start the build', 'due during the build']);
      assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'sent');
    });
  } finally {
    closeScheduledMessageDispatcher();
    mock.timers.reset();
  }
});

test('a queued turn waits until the dispatcher\'s previous run for its session has settled', { timeout: 10_000 }, async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    await withIsolatedDatabase(async (userId) => {
      const runs: RunCall[] = [];
      // The turn has ended and reports no background work, but its run has
      // not settled yet: the CLI is still winding down.
      const { runtime, release } = createHoldingRuntime(runs, SESSION_ID, { reportsBackgroundWork: false });
      sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, { content: 'first follow-up', attachments: [] });
      initializeScheduledMessageDispatcher(runtime);
      try {
        await flushPasses();
        sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, { content: 'second follow-up', attachments: [] });

        mock.timers.tick(POLL_INTERVAL_MS);
        await flushPasses();

        assert.deepEqual(runs.map((run) => run.command), ['first follow-up']);
        assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, {
          content: 'second follow-up',
          attachments: [],
        });
      } finally {
        release();
        await flushPasses();
      }

      mock.timers.tick(POLL_INTERVAL_MS);
      await flushPasses();
      assert.deepEqual(runs.map((run) => run.command), ['first follow-up', 'second follow-up']);
    });
  } finally {
    closeScheduledMessageDispatcher();
    mock.timers.reset();
  }
});

test('the composer settings it was scheduled with travel with it', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'with options',
      options: { model: 'claude-opus-5', permissionMode: 'plan' },
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    const runs: RunCall[] = [];
    await dispatchDueScheduledMessages(createRuntime(runs));

    assert.equal(runs[0].options.model, 'claude-opus-5');
    assert.equal(runs[0].options.permissionMode, 'plan');
  });
});

test('a provider failure is recorded on the message instead of vanishing', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'will fail',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    await dispatchDueScheduledMessages(createRuntime([], 'throw'));

    const row = scheduledMessagesDb.listForSession(userId, SESSION_ID)[0];
    assert.equal(row.status, 'failed');
    assert.match(row.failure_reason ?? '', /provider exploded/);
  });
});

test('a cancelled message never fires', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'never mind',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    scheduledMessagesService.cancel(userId, scheduled.id);

    const runs: RunCall[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs)), 0);
    assert.equal(runs.length, 0);
  });
});

test('a failed message can be dismissed, and stays dismissed', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'will fail',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    await dispatchDueScheduledMessages(createRuntime([], 'throw'));
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'failed');

    scheduledMessagesService.cancel(userId, scheduled.id);

    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'cancelled');
  });
});

test('cancelling something that already fired is refused', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'gone',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    await dispatchDueScheduledMessages(createRuntime([]));

    assert.throws(
      () => scheduledMessagesService.cancel(userId, scheduled.id),
      (error: Error & { code?: string }) => error.code === 'SCHEDULED_MESSAGE_NOT_PENDING',
    );
  });
});

test('one user cannot cancel another user\'s scheduled message', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'mine',
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });

    assert.throws(
      () => scheduledMessagesService.cancel(userId + 1, scheduled.id),
      (error: Error & { code?: string }) => error.code === 'SCHEDULED_MESSAGE_NOT_PENDING',
    );
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'pending');
  });
});

test('scheduling validates its input', async () => {
  await withIsolatedDatabase(async (userId) => {
    const base = { userId, sessionId: SESSION_ID, scheduledFor: new Date(Date.now() + 1000).toISOString() };

    assert.throws(
      () => scheduledMessagesService.schedule({ ...base, content: '   ' }),
      (error: Error & { code?: string }) => error.code === 'CONTENT_REQUIRED',
    );
    assert.throws(
      () => scheduledMessagesService.schedule({ ...base, content: 'hi', scheduledFor: 'not a date' }),
      (error: Error & { code?: string }) => error.code === 'INVALID_SCHEDULE_TIME',
    );
    assert.throws(
      () => scheduledMessagesService.schedule({
        ...base,
        content: 'hi',
        scheduledFor: new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString(),
      }),
      (error: Error & { code?: string }) => error.code === 'SCHEDULE_TOO_FAR_AHEAD',
    );
    assert.throws(
      () => scheduledMessagesService.schedule({ ...base, sessionId: 'nope', content: 'hi' }),
      (error: Error & { code?: string }) => error.code === 'SESSION_NOT_FOUND',
    );
  });
});
