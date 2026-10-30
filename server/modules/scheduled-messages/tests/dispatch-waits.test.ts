import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase, scheduledMessagesDb, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import scheduledMessagesRoutes from '@/modules/scheduled-messages/scheduled-messages.routes.js';
import {
  closeScheduledMessageDispatcher,
  dispatchDueScheduledMessages,
  dispatchQueuedMessages,
  listDispatchWaits,
} from '@/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js';
import { scheduledMessagesService } from '@/modules/scheduled-messages/services/scheduled-messages.service.js';
import { chatRunRegistry, connectedClients } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type {
  DispatchWaitingEvent,
  ProviderHandOverPlan,
  ProviderHandOverPlanOptions,
  RealtimeClientConnection,
  ScheduledWorkSummary,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Why the dispatcher holds a queued or scheduled message back, as it notes
 * it (`listDispatchWaits`), sends it on (`dispatch_waiting`) and serves it
 * (GET /api/scheduled-messages/waiting); and the user's ways out of a wait:
 * the held process's settings (`useProcessSettings`), or a process of the
 * message's own that keeps a cron-only loop (`replaceKeepsWork`).
 */

const SESSION_ID = 'waiting-session';

async function withIsolatedDatabase(runTest: (userId: number, otherUserId: number) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'dispatch-waits-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    const user = userDb.createUser('waiter', 'hash');
    const other = userDb.createUser('someone-else', 'hash');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Waiting session');
    await runTest(Number(user.id), Number(other.id));
  } finally {
    closeScheduledMessageDispatcher();
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

/** The `dispatch_waiting` frames a chat socket gets while `run` runs. */
async function withSocket(run: (frames: DispatchWaitingEvent[]) => Promise<void>): Promise<void> {
  const frames: DispatchWaitingEvent[] = [];
  const socket: RealtimeClientConnection = {
    readyState: 1,
    send: (data) => {
      const frame = JSON.parse(data) as DispatchWaitingEvent;
      if (frame.kind === 'dispatch_waiting') {
        frames.push(frame);
      }
    },
  };
  connectedClients.add(socket);
  try {
    await run(frames);
  } finally {
    connectedClients.delete(socket);
  }
}

type RunCall = { command: string; options: Record<string, unknown> };
type PlanCall = { options: Record<string, unknown>; planOptions: ProviderHandOverPlanOptions | undefined };

/** A cron job of a /loop, as the runtime lists it. */
const cronJob = (overrides: Partial<ScheduledWorkSummary> = {}): ScheduledWorkSummary => ({
  id: 'cron:b2148320',
  kind: 'cron',
  toolUseId: 'toolu_cron',
  prompt: 'check the deploy',
  startedAt: Date.now() - 60_000,
  nextFireAt: Date.now() + 5 * 60_000,
  recurring: true,
  holdUntil: Date.now() + 8 * 24 * 3_600_000,
  expiresAt: Date.now() + 7 * 24 * 3_600_000,
  ...overrides,
});

/**
 * A runtime whose process for the session is held for a /loop alone (or, with
 * `tasks`, for a task too) and plans every turn with `plan`, which sees the
 * options and plan options it is asked with. Runs are recorded and end at once.
 */
function createRuntime(
  plan: (call: PlanCall) => ProviderHandOverPlan,
  { tasks = false, scheduled = [cronJob()] }: { tasks?: boolean; scheduled?: ScheduledWorkSummary[] } = {},
) {
  const runs: RunCall[] = [];
  const plans: PlanCall[] = [];
  let holding = true;
  const runtime: ProviderRuntimeGateway = {
    hasRuntime: () => true,
    run: async (_provider, command, options) => {
      runs.push({ command, options });
    },
    abort: async () => true,
    stopBackgroundTask: async () => false,
    hasBackgroundWork: (sessionId) => holding && tasks && sessionId === SESSION_ID,
    hasScheduledWork: (sessionId) => holding && sessionId === SESSION_ID,
    listScheduledWork: (sessionId) => (holding && sessionId === SESSION_ID ? scheduled : []),
    stopScheduledWork: async () => ({ status: 'not_found' }),
    resolveToolApproval: () => {},
    getPendingApprovalsForSession: () => [],
    insert: async () => ({ accepted: false, reason: 'UNSUPPORTED' }),
    cancelInsert: async () => ({ status: 'unsupported' }),
    planHandOver: async (_provider, sessionId, options, planOptions) => {
      if (!holding || sessionId !== SESSION_ID) {
        return { heldWork: false, canHandOver: false, changes: [], switches: [] };
      }
      const call = { options, planOptions };
      plans.push(call);
      return plan(call);
    },
  };
  return { runtime, runs, plans, release: () => { holding = false; } };
}

const accepts = (call: PlanCall) => call.planOptions?.acceptProcessSettings === true;

/** A loop started in plan mode with WebFetch allowed; the message is in the default mode, skipping permissions, and no longer allows WebFetch. */
const PLAN_LOOP_KEEPS_OUT: ProviderHandOverPlan = {
  heldWork: true,
  canHandOver: false,
  changes: ['tools', 'permissionMode'],
  switches: [],
  details: {
    tools: { notAllowed: ['WebFetch'], alsoDenied: [] },
    permissionMode: { process: 'plan', message: 'bypassPermissions', reason: 'bypass_not_allowed' },
  },
};

test('a queued message the held process keeps out waits with what really keeps it out, once the loop\'s settings were tried, and what the user can do about it', async () => {
  await withIsolatedDatabase(async (userId, otherUserId) => {
    const scheduled = [cronJob(), cronJob({ id: 'cron:0badf00d', holdUntil: Date.now() + 60_000, expiresAt: undefined })];
    const { runtime, runs, plans } = createRuntime(
      (call) => (accepts(call)
        ? PLAN_LOOP_KEEPS_OUT
        : { ...PLAN_LOOP_KEEPS_OUT, changes: ['effort', 'tools', 'permissionMode'] }),
      { scheduled },
    );
    sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, { content: 'fetch the changelog', options: { effort: 'max' }, attachments: [] });

    assert.equal(await dispatchQueuedMessages(runtime), 0);
    assert.equal(runs.length, 0);
    assert.deepEqual(plans.map((call) => call.planOptions), [{ inheritUnset: true }, { inheritUnset: true, acceptProcessSettings: true }]);
    const [wait] = listDispatchWaits(userId, SESSION_ID);
    assert.deepEqual(
      { ...wait, since: typeof wait?.since },
      {
        target: { kind: 'queued' },
        sessionId: SESSION_ID,
        provider: 'claude',
        reason: 'held_settings',
        heldFor: 'loops',
        changes: ['tools', 'permissionMode'],
        details: PLAN_LOOP_KEEPS_OUT.details,
        since: 'string',
        // The latest any of the loop's jobs holds the process: the first one expires before its hold limit.
        holdUntil: scheduled[0].expiresAt,
        stopTaskId: 'cron:b2148320',
        actions: ['stop_work_and_send', 'use_process_settings', 'keep_waiting', 'cancel'],
      },
    );
    assert.deepEqual(listDispatchWaits(otherUserId, SESSION_ID), [], 'another user sees none of it');
  });
});

test('a wait is sent on when it starts, when its reason changes and when it ends, and not on every pass', async () => {
  await withIsolatedDatabase(async (userId) => {
    await withSocket(async (frames) => {
      let current: ProviderHandOverPlan = { heldWork: true, canHandOver: false, changes: ['tools'], switches: [] };
      const { runtime, runs } = createRuntime(() => current);
      sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, { content: 'go on', options: {}, attachments: [] });

      await dispatchQueuedMessages(runtime);
      await dispatchQueuedMessages(runtime);
      assert.deepEqual(frames.map((frame) => frame.wait?.changes ?? null), [['tools']], 'one frame for two passes that found the same');
      assert.deepEqual(frames[0]?.target, { kind: 'queued' });
      assert.equal(frames[0]?.sessionId, SESSION_ID);
      assert.equal(JSON.stringify(frames[0]).includes('go on'), false, 'the frame carries no message text');

      current = { heldWork: true, canHandOver: false, changes: ['cwd'], switches: [] };
      await dispatchQueuedMessages(runtime);
      assert.deepEqual(frames.map((frame) => frame.wait?.changes ?? null), [['tools'], ['cwd']]);
      assert.deepEqual(frames[1]?.wait?.actions, ['stop_work_and_send', 'keep_waiting', 'cancel'], 'a working directory is no setting the loop can lend');
      assert.equal(frames[1]?.wait?.since, frames[0]?.wait?.since, 'it has waited since it first did');

      current = { heldWork: true, canHandOver: true, changes: [], switches: [] };
      assert.equal(await dispatchQueuedMessages(runtime), 1);
      assert.deepEqual(runs.map((run) => run.command), ['go on']);
      assert.deepEqual(frames.map((frame) => frame.wait?.changes ?? null), [['tools'], ['cwd'], null], 'claimed: it waits no more');
      assert.deepEqual(listDispatchWaits(userId, SESSION_ID), []);
    });
  });
});

test('the wait of a queued message that is deleted, or of a scheduled one that is cancelled, ends on the next pass', async () => {
  await withIsolatedDatabase(async (userId) => {
    await withSocket(async (frames) => {
      const { runtime } = createRuntime(() => ({ heldWork: true, canHandOver: false, changes: ['tools'], switches: [] }));
      sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, { content: 'queued', options: {}, attachments: [] });
      const first = scheduledMessagesService.schedule({ userId, sessionId: SESSION_ID, content: 'first', options: {}, scheduledFor: new Date(Date.now() - 2_000).toISOString() });
      const second = scheduledMessagesService.schedule({ userId, sessionId: SESSION_ID, content: 'second', options: {}, scheduledFor: new Date(Date.now() - 1_000).toISOString() });

      await dispatchDueScheduledMessages(runtime);
      await dispatchQueuedMessages(runtime);
      assert.deepEqual(
        listDispatchWaits(userId, SESSION_ID).map((wait) => [wait.target, wait.reason]),
        [
          [{ kind: 'queued' }, 'held_settings'],
          [{ kind: 'scheduled', id: first.id }, 'held_settings'],
          [{ kind: 'scheduled', id: second.id }, 'behind'],
        ],
      );
      const behind = listDispatchWaits(userId, SESSION_ID)[2];
      assert.deepEqual(behind?.actions, ['keep_waiting', 'cancel'], 'one behind another waits for that one');

      sessionDraftsDb.clearQueuedMessage(userId, SESSION_ID);
      scheduledMessagesService.cancel(userId, first.id);
      frames.length = 0;
      await dispatchDueScheduledMessages(runtime);
      await dispatchQueuedMessages(runtime);
      assert.deepEqual(
        listDispatchWaits(userId, SESSION_ID).map((wait) => [wait.target, wait.reason]),
        [[{ kind: 'scheduled', id: second.id }, 'held_settings']],
        'the second is first in line now',
      );
      assert.deepEqual(
        frames.map((frame) => [frame.target, frame.wait?.reason ?? null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        [
          [{ kind: 'queued' }, null],
          [{ kind: 'scheduled', id: first.id }, null],
          [{ kind: 'scheduled', id: second.id }, 'held_settings'],
        ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      );
    });
  });
});

test('a message the loop\'s settings would let in goes on them; one kept out by a task as well is not tried on them and offers no stop', async () => {
  await withIsolatedDatabase(async (userId) => {
    const keptOut: ProviderHandOverPlan = { heldWork: true, canHandOver: false, changes: ['permissionMode'], switches: [] };
    const { runtime, runs } = createRuntime((call) => (accepts(call) ? { heldWork: true, canHandOver: true, changes: [], switches: [] } : keptOut));
    sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, { content: 'on the loop\'s settings', options: {}, attachments: [] });
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.equal(runs[0]?.options.acceptProcessSettings, true);
  });

  await withIsolatedDatabase(async (userId) => {
    const keptOut: ProviderHandOverPlan = { heldWork: true, canHandOver: false, changes: ['effort'], switches: [] };
    const { runtime, plans } = createRuntime(() => keptOut, { tasks: true });
    sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, { content: 'waits', options: {}, attachments: [] });
    // The tracker reports the task, so the queued message waits for it before any plan.
    assert.equal(await dispatchQueuedMessages(runtime), 0);
    assert.deepEqual(plans, []);
    assert.deepEqual(
      listDispatchWaits(userId, SESSION_ID).map((wait) => [wait.reason, wait.actions]),
      [['held_work', ['keep_waiting', 'cancel']]],
    );
  });
});

test('a message kept out of a process held for cron jobs alone that a process of its own keeps goes, with its own settings', async () => {
  await withIsolatedDatabase(async (userId) => {
    // Its tool rules are stricter than the loop's, which no hand-over takes.
    const keptOut: ProviderHandOverPlan = {
      heldWork: true,
      canHandOver: false,
      changes: ['tools'],
      switches: [],
      details: { tools: { notAllowed: ['WebFetch'], alsoDenied: [] } },
      replaceKeepsWork: true,
    };
    const { runtime, runs, plans } = createRuntime(() => keptOut);
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'check again',
      options: { toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false } },
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    assert.equal(await dispatchDueScheduledMessages(runtime), 1);
    assert.deepEqual(plans.map((call) => call.planOptions), [{ inheritUnset: true }, { inheritUnset: true, acceptProcessSettings: true }]);
    assert.equal('acceptProcessSettings' in (runs[0]?.options ?? {}), false, 'it goes as it is, not on the loop\'s settings');
    assert.deepEqual((runs[0]?.options.toolsSettings as Record<string, unknown> | undefined)?.allowedTools, []);
    assert.deepEqual(listDispatchWaits(userId, SESSION_ID), []);
  });
});

test('a message the user sends with the loop\'s settings names none of the settings the loop can lend, and still names its working directory', async () => {
  await withIsolatedDatabase(async (userId) => {
    const { runtime, runs, plans } = createRuntime(() => ({ heldWork: true, canHandOver: true, changes: [], switches: [] }));
    const message = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'on the loop\'s settings',
      options: {
        model: 'opus',
        effort: 'max',
        ultracode: true,
        permissionMode: 'default',
        toolsSettings: { allowedTools: [], disallowedTools: ['WebFetch'], skipPermissions: true },
        skipPermissions: true,
        cwd: '/checkout',
      },
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    scheduledMessagesService.useProcessSettings(userId, message.id);
    assert.equal(JSON.parse(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0]!.options).useProcessSettings, true);

    assert.equal(await dispatchDueScheduledMessages(runtime), 1);
    for (const options of [plans[0]?.options, runs[0]?.options]) {
      for (const key of ['model', 'permissionMode', 'toolsSettings', 'skipPermissions', 'useProcessSettings']) {
        assert.equal(options?.[key] === undefined, true, key);
      }
      // Effort and ultracode are always named in the run options, unset here.
      assert.equal(options?.effort, undefined);
      assert.equal(options?.ultracode, undefined);
      assert.equal(options?.cwd, '/checkout');
      assert.equal(options?.inheritUnset, true);
    }
    // What the run goes back to should the process let go before the hand-over.
    assert.deepEqual(runs[0]?.options.ownSettings, {
      model: 'opus',
      effort: 'max',
      ultracode: true,
      permissionMode: 'default',
      toolsSettings: { allowedTools: [], disallowedTools: ['WebFetch'], skipPermissions: true },
      skipPermissions: true,
    });
    assert.equal(plans[0]?.options.ownSettings, undefined, 'nothing to plan with');
  });

  await withIsolatedDatabase(async (userId) => {
    const { runtime, runs } = createRuntime(() => ({ heldWork: true, canHandOver: true, changes: [], switches: [] }));
    sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, {
      content: 'queued on the loop\'s settings',
      options: { model: 'opus', permissionMode: 'acceptEdits', toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false } },
      attachments: [],
    });
    scheduledMessagesService.useProcessSettingsForQueued(userId, SESSION_ID);
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.equal(runs[0]?.options.model, undefined);
    assert.equal(runs[0]?.options.permissionMode, undefined);
    assert.equal(runs[0]?.options.toolsSettings, undefined);
    assert.throws(() => scheduledMessagesService.useProcessSettingsForQueued(userId, SESSION_ID), (error: unknown) => (
      error instanceof AppError && error.code === 'QUEUED_MESSAGE_NOT_FOUND'
    ));
  });
});

test('a message the user chose to send with the loop\'s settings runs with its own once no process is held to lend them', async () => {
  const own = {
    model: 'opus',
    effort: 'max',
    permissionMode: 'acceptEdits',
    toolsSettings: { allowedTools: ['Bash(git status:*)'], disallowedTools: [], skipPermissions: false },
  };
  await withIsolatedDatabase(async (userId) => {
    const { runtime, runs, release } = createRuntime(() => ({ heldWork: true, canHandOver: true, changes: [], switches: [] }));
    const message = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'after the loop',
      options: own,
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    scheduledMessagesService.useProcessSettings(userId, message.id);
    // The loop ended (or the server restarted) before the message went.
    release();
    assert.equal(await dispatchDueScheduledMessages(runtime), 1);
    const options = runs[0]?.options;
    assert.deepEqual(
      [options?.model, options?.effort, options?.permissionMode, options?.toolsSettings],
      [own.model, own.effort, own.permissionMode, own.toolsSettings],
    );
    assert.equal(options?.useProcessSettings, undefined);
  });

  await withIsolatedDatabase(async (userId) => {
    const { runtime, runs, release } = createRuntime(() => ({ heldWork: true, canHandOver: true, changes: [], switches: [] }));
    sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, { content: 'queued after the loop', options: own, attachments: [] });
    scheduledMessagesService.useProcessSettingsForQueued(userId, SESSION_ID);
    release();
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.deepEqual([runs[0]?.options.model, runs[0]?.options.permissionMode], [own.model, own.permissionMode]);
    assert.deepEqual(runs[0]?.options.toolsSettings, own.toolsSettings);
  });
});

test('an ownSettings a message\'s stored options carry is dropped: only a message sent with the loop\'s settings has one', async () => {
  await withIsolatedDatabase(async (userId) => {
    const { runtime, runs } = createRuntime(() => ({ heldWork: true, canHandOver: true, changes: [], switches: [] }));
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'as scheduled',
      options: { model: 'opus', ownSettings: { permissionMode: 'bypassPermissions' } },
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    assert.equal(await dispatchDueScheduledMessages(runtime), 1);
    assert.equal(runs[0]?.options.model, 'opus');
    assert.equal('ownSettings' in (runs[0]?.options ?? {}), false);
  });
});

/** What Claude's runtime says when a turn that waited for the loop's fire is turned away because the fire started work. */
const WORK_STARTED_CONTENT = 'Not sent: this message changes the tool permissions, which only a new Claude process can apply, and the turn Claude ran on its own meanwhile started work a new process would stop.';

/**
 * `runtime` whose first `times` runs fail as Claude's runtime fails a turn
 * sent with `keepBackgroundWork: true` that waited for the loop's fire,
 * which started work a process of the turn's own would stop: an `error`
 * with code HAND_OVER_FAILED and reason `work-started`, then a throw that
 * carries the same. The loop and that work go on.
 */
function turningAwayAfterFire(runtime: ProviderRuntimeGateway, times: number) {
  const turnedAway: Array<Record<string, unknown>> = [];
  const failing: ProviderRuntimeGateway = {
    ...runtime,
    run: async (provider, command, options, writer) => {
      if (turnedAway.length >= times) {
        return runtime.run(provider, command, options, writer);
      }
      turnedAway.push(options);
      writer.send({ kind: 'error', code: 'HAND_OVER_FAILED', reason: 'work-started', changes: ['tools'], content: WORK_STARTED_CONTENT, sessionId: 'native', provider: 'claude' });
      throw Object.assign(new Error(WORK_STARTED_CONTENT), { code: 'HAND_OVER_FAILED', reason: 'work-started' });
    },
  };
  return { runtime: failing, turnedAway };
}

/** The loop fires as the message is planned: a process of its own keeps the loop once the fire is over. */
const AFTER_FIRE: ProviderHandOverPlan = {
  heldWork: true,
  canHandOver: false,
  changes: ['tools'],
  switches: [],
  details: { tools: { notAllowed: ['WebFetch'], alsoDenied: [] } },
  replaceKeepsWork: true,
  afterCliTurn: true,
};

test('a due message a process of its own keeps the loop for goes while the loop fires, and is tried again, not failed, when the fire starts work that process would stop', async () => {
  await withIsolatedDatabase(async (userId) => {
    await withSocket(async (frames) => {
      const { runtime: held, runs } = createRuntime(() => AFTER_FIRE);
      const { runtime, turnedAway } = turningAwayAfterFire(held, 1);
      const message = scheduledMessagesService.schedule({
        userId,
        sessionId: SESSION_ID,
        content: 'check again',
        options: { toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false } },
        scheduledFor: new Date(Date.now() - 1_000).toISOString(),
      });
      const row = () => scheduledMessagesDb.listForSession(userId, SESSION_ID)[0];
      const start = Date.now();

      // Sent at once, with no wait and no offer to stop the loop: the run waits for the fire.
      assert.equal(await dispatchDueScheduledMessages(runtime, new Date(start)), 1);
      assert.equal(turnedAway.length, 1);
      assert.equal(turnedAway[0]?.keepBackgroundWork, true, 'the run fails rather than stop the work');
      assert.deepEqual([row()?.status, row()?.failure_reason], ['pending', null], 'not marked failed');
      assert.equal(frames.length, 0, 'it never waited for the loop');

      // Not tried again before its time, then it goes.
      assert.equal(await dispatchDueScheduledMessages(runtime, new Date(start + 10_000)), 0);
      assert.equal(runs.length, 0);
      assert.deepEqual(
        frames.map((frame) => [frame.target, frame.wait?.reason ?? null, frame.wait?.retryAt ?? null]),
        [[{ kind: 'scheduled', id: message.id }, 'retry', start + 30_000 - 1_000]],
      );
      assert.equal(await dispatchDueScheduledMessages(runtime, new Date(start + 30_000)), 1);
      assert.deepEqual(runs.map((run) => run.command), ['check again']);
      assert.equal(row()?.status, 'sent');
      assert.deepEqual(listDispatchWaits(userId, SESSION_ID), []);
    });
  });

  await withIsolatedDatabase(async (userId) => {
    const { runtime: held, runs } = createRuntime(() => AFTER_FIRE);
    const { runtime, turnedAway } = turningAwayAfterFire(held, 1);
    sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, { content: 'queued again', options: {}, attachments: [] });
    const start = Date.now();
    assert.equal(await dispatchQueuedMessages(runtime, new Date(start)), 1);
    assert.equal(turnedAway[0]?.keepBackgroundWork, true);
    assert.equal(sessionDraftsDb.listQueuedMessages().length, 1, 'back in the queue');
    assert.equal(await dispatchQueuedMessages(runtime, new Date(start + 10_000)), 0);
    assert.deepEqual(listDispatchWaits(userId, SESSION_ID).map((wait) => wait.reason), ['retry']);
    assert.equal(await dispatchQueuedMessages(runtime, new Date(start + 30_000)), 1);
    assert.deepEqual(runs.map((run) => run.command), ['queued again']);
  });
});

test('a message kept out of a process a task holds besides the loop says it waits for the background work, not for a loop', async () => {
  await withIsolatedDatabase(async (userId) => {
    const { runtime, runs } = createRuntime(() => ({ heldWork: true, canHandOver: false, changes: ['effort'], switches: [] }), { tasks: true });
    const message = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'think harder',
      options: { effort: 'max' },
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    assert.equal(await dispatchDueScheduledMessages(runtime), 0);
    assert.equal(runs.length, 0);
    const [wait] = listDispatchWaits(userId, SESSION_ID);
    assert.deepEqual(
      [wait?.target, wait?.reason, wait?.heldFor, wait?.changes, wait?.actions],
      [{ kind: 'scheduled', id: message.id }, 'held_settings', 'work', ['effort'], ['use_process_settings', 'keep_waiting', 'cancel']],
    );
  });
});

/** The scheduled-messages routes, the request's user named by its `x-user` header. */
async function withRoutes(run: (request: (method: string, url: string, userId: number, body?: unknown) => Promise<{ status: number; body: any }>) => Promise<void>): Promise<void> {
  const app = express()
    .use(express.json())
    .use((req, _res, next) => {
      (req as Request & { user?: { id: number } }).user = { id: Number(req.header('x-user')) };
      next();
    })
    .use('/api/scheduled-messages', scheduledMessagesRoutes);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, error: { code: error.code } });
      return;
    }
    res.status(500).json({ success: false });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    await run(async (method, url, userId, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-user': String(userId) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
}

test('GET /waiting gives a session\'s waits to the user they belong to, and the user can send a waiting message on the loop\'s settings', async () => {
  await withIsolatedDatabase(async (userId, otherUserId) => {
    const { runtime } = createRuntime(() => ({ heldWork: true, canHandOver: false, changes: ['tools'], switches: [] }));
    const message = scheduledMessagesService.schedule({ userId, sessionId: SESSION_ID, content: 'due', options: {}, scheduledFor: new Date(Date.now() - 1_000).toISOString() });
    sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, { content: 'queued', options: {}, attachments: [] });
    await dispatchDueScheduledMessages(runtime);
    await dispatchQueuedMessages(runtime);

    await withRoutes(async (request) => {
      const mine = await request('GET', `/api/scheduled-messages/waiting?sessionId=${SESSION_ID}`, userId);
      assert.equal(mine.status, 200);
      assert.deepEqual(mine.body.data.waits.map((wait: { target: unknown }) => wait.target), [{ kind: 'queued' }, { kind: 'scheduled', id: message.id }]);
      const theirs = await request('GET', `/api/scheduled-messages/waiting?sessionId=${SESSION_ID}`, otherUserId);
      assert.deepEqual(theirs.body.data.waits, []);

      assert.equal((await request('PATCH', `/api/scheduled-messages/${message.id}`, otherUserId, { useProcessSettings: true })).status, 409, 'not theirs');
      assert.equal((await request('PATCH', `/api/scheduled-messages/${message.id}`, userId, { content: 'changed' })).status, 400, 'nothing else can be changed');
      assert.equal((await request('PATCH', `/api/scheduled-messages/${message.id}`, userId, { useProcessSettings: true })).status, 200);
      assert.equal(JSON.parse(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0]!.options).useProcessSettings, true);

      assert.equal((await request('POST', '/api/scheduled-messages/queued/use-process-settings', otherUserId, { sessionId: SESSION_ID })).status, 409);
      assert.equal((await request('POST', '/api/scheduled-messages/queued/use-process-settings', userId, { sessionId: SESSION_ID })).status, 200);
      const queued = sessionDraftsDb.listQueuedMessages()[0]?.queuedMessage as { options?: Record<string, unknown> } | undefined;
      assert.equal(queued?.options?.useProcessSettings, true);
    });
  });
});
