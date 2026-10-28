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
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type {
  HandOverChange,
  HandOverSwitch,
  ProviderHandOverPlan,
  ProviderHandOverPlanOptions,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

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

/**
 * The gateway methods the dispatcher never calls, answered as a runtime with
 * nothing to stop, approve or insert into would. The doubles below are typed
 * as the full gateway, so a method added to it has to be answered here.
 */
const UNUSED_GATEWAY_METHODS = {
  stopBackgroundTask: async () => false,
  resolveToolApproval: () => {},
  getPendingApprovalsForSession: () => [],
  insert: async () => ({ accepted: false, reason: 'UNSUPPORTED' }) as const,
  cancelInsert: async () => ({ status: 'unsupported' }) as const,
} satisfies Partial<ProviderRuntimeGateway>;

/** The hand-over plan of a session whose process nothing holds. */
const NOTHING_HELD: ProviderHandOverPlan = { heldWork: false, canHandOver: false, changes: [], switches: [] };

/** The hand-over plan of a runtime that holds no session's process. */
const planNothingHeld: ProviderRuntimeGateway['planHandOver'] = async () => NOTHING_HELD;

/** Tool rules as a composer send carries them (`toolsSettings`). */
type ToolRules = { allowedTools?: string[]; disallowedTools?: string[]; skipPermissions?: boolean };

/**
 * A turn's run options with each setting they leave out taken from a process
 * launched with the run options `launched`, as Claude's runtime inherits
 * them (see `ProviderHandOverPlanOptions`): the working directory, model,
 * effort and permission mode when they name none, and each of the tool rules
 * (allowed and denied tools, `skipPermissions`) they do not carry. What they
 * carry is kept.
 */
function withSettingsInherited(launched: Record<string, unknown>, options: Record<string, unknown>): Record<string, unknown> {
  const named = (key: string) => typeof options[key] === 'string' && (options[key] as string).trim() !== '';
  const given = (options.toolsSettings ?? {}) as ToolRules;
  const live = (launched.toolsSettings ?? {}) as ToolRules;
  return {
    ...options,
    cwd: named('cwd') ? options.cwd : launched.cwd,
    model: named('model') ? options.model : launched.model,
    effort: named('effort') ? options.effort : launched.effort,
    permissionMode: named('permissionMode') ? options.permissionMode : launched.permissionMode,
    toolsSettings: {
      allowedTools: given.allowedTools ?? live.allowedTools ?? [],
      disallowedTools: given.disallowedTools ?? live.disallowedTools ?? [],
      skipPermissions: given.skipPermissions ?? live.skipPermissions ?? false,
    },
  };
}

/**
 * The permission mode run options give a process, as Claude's runtime maps
 * them: bypassPermissions when their tool rules skip permissions (outside
 * plan mode), else the mode they name, else the default one.
 */
function permissionModeOf(options: Record<string, unknown>): unknown {
  const rules = (options.toolsSettings ?? {}) as ToolRules;
  if (rules.skipPermissions && options.permissionMode !== 'plan') {
    return 'bypassPermissions';
  }
  return options.permissionMode ?? 'default';
}

/**
 * What a turn run with `options` would make of a held process launched with
 * the run options `launched`, compared as Claude's runtime compares them
 * (see `HandOverChange` and `HandOverSwitch`). `changes` are the settings
 * its CLI takes only at launch, which keep the turn out: the working
 * directory, the effort, ultracode when the turn chooses it, and tool rules
 * that allow fewer tools or deny others. `switches` are the ones a
 * hand-over would switch in the live process: another model, another
 * permission mode. The turn's options count as they are: a turn that names
 * no model runs on the session's, here the process's own, and one without
 * tool rules allows and denies nothing. With `inheritUnset`, what it leaves
 * out is the process's own (`withSettingsInherited`).
 */
function compareWithHeldProcess(
  launched: Record<string, unknown>,
  options: Record<string, unknown>,
  inheritUnset: boolean,
): Pick<ProviderHandOverPlan, 'changes' | 'switches'> {
  const turn = inheritUnset ? withSettingsInherited(launched, options) : options;
  const turnRules = (turn.toolsSettings ?? {}) as ToolRules;
  const liveRules = (launched.toolsSettings ?? {}) as ToolRules;

  const changes: HandOverChange[] = [];
  if ((turn.cwd ?? null) !== (launched.cwd ?? null)) {
    changes.push('cwd');
  }
  if ((turn.effort ?? null) !== (launched.effort ?? null)) {
    changes.push('effort');
  }
  if (typeof turn.ultracode === 'boolean' && turn.ultracode !== (launched.ultracode === true)) {
    changes.push('ultracode');
  }
  const turnAllowed = turnRules.allowedTools ?? [];
  const turnDenied = turnRules.disallowedTools ?? [];
  const liveDenied = liveRules.disallowedTools ?? [];
  if (
    (liveRules.allowedTools ?? []).some((tool) => !turnAllowed.includes(tool))
    || turnDenied.length !== liveDenied.length
    || turnDenied.some((tool) => !liveDenied.includes(tool))
  ) {
    changes.push('tools');
  }

  const switches: HandOverSwitch[] = [];
  if ((turn.model ?? launched.model) !== launched.model) {
    switches.push('model');
  }
  if (permissionModeOf(turn) !== permissionModeOf(launched)) {
    switches.push('permissionMode');
  }
  return { changes, switches };
}

/**
 * A hand-over plan as Claude's runtime makes one for `heldSessionId`, whose
 * process may be held after its turn for work of its own:
 * `heldLaunchOptions()` gives the run options that process was launched
 * with, or null while nothing is held. While it is, the plan reports the work
 * held (`heldWork`), lets a turn in (`canHandOver`) when it keeps those
 * launch settings, and names what the turn would switch
 * (`compareWithHeldProcess`), taking what the turn leaves out as the
 * process's own when asked to (`planOptions.inheritUnset`, or
 * `inheritUnset: true` in the options). While a turn is under way in the
 * process (the user's, handed to it), the process takes no other, and the
 * plan says only that the work is held, which interrupting that turn would
 * stop. As the real gateway asks the named provider's runtime, only the
 * sessions' provider (`claude`) answers that it holds anything.
 */
function planHeldProcess(
  heldSessionId: string,
  heldLaunchOptions: () => Record<string, unknown> | null,
): ProviderRuntimeGateway['planHandOver'] {
  return async (provider, sessionId, options, planOptions?: ProviderHandOverPlanOptions) => {
    const launched = provider === 'claude' && sessionId === heldSessionId ? heldLaunchOptions() : null;
    if (!launched) {
      return NOTHING_HELD;
    }
    if (chatRunRegistry.isProcessing(sessionId)) {
      return { heldWork: true, canHandOver: false, changes: [], switches: [] };
    }
    const inheritUnset = planOptions?.inheritUnset === true || options.inheritUnset === true;
    const { changes, switches } = compareWithHeldProcess(launched, options, inheritUnset);
    return { heldWork: true, canHandOver: changes.length === 0, changes, switches };
  };
}

function createRuntime(
  runs: RunCall[],
  behaviour: 'ok' | 'throw' = 'ok',
  aborts: string[] = [],
  hasBackgroundWork: (sessionId: string) => boolean = () => false,
): ProviderRuntimeGateway {
  return {
    ...UNUSED_GATEWAY_METHODS,
    hasRuntime: () => true,
    hasBackgroundWork,
    planHandOver: planNothingHeld,
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
  };
}

/**
 * A runtime whose run for `heldSessionId` ends its turn and then stays open
 * until `release` is called, like a Claude run whose turn backgrounded a long
 * build: the registry shows the turn completed, and the session reports
 * background work unless `reportsBackgroundWork` is false (the CLI is only
 * winding down). Runs after the release, and runs for other sessions, settle
 * at once. Its hand-over plan reports nothing held, so what holds a message
 * back in the tests using it is the dispatcher's own wait for its run.
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

  const runtime: ProviderRuntimeGateway = {
    ...UNUSED_GATEWAY_METHODS,
    hasRuntime: () => true,
    hasBackgroundWork: (sessionId: string) => reportsBackgroundWork && holding && sessionId === heldSessionId,
    planHandOver: planNothingHeld,
    run: async (
      provider: string,
      command: string,
      options: Record<string, unknown>,
      // The chat run's own writer, which can end the turn.
      writer: ProviderRuntimeWriter & { sendComplete(opts: { exitCode: number }): void },
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
  };

  return {
    runtime,
    aborts,
    release: () => {
      released = true;
      releaseHeldRun();
    },
  };
}

/**
 * A runtime whose runs for `heldSessionId` end their turn and keep their
 * process open, as a Claude turn does that left work going (a wake-up, a
 * CronCreate job, a backgrounded task): the process is held for that work
 * until the work reports back (`workDone`), and the run settles only once its
 * process exits (`exitAll`). While the work is held, its hand-over plan lets
 * in a turn that keeps what the latest open process was launched with
 * (`planHeldProcess`). Its runs always open a process of their own, so the
 * tests using it send, while the work is held, only turns that process cannot
 * take. `handOver` is the user's next send going into the latest open process
 * as its next turn, as Claude runs it: the send's run takes the session's
 * slot, the process's own run hears that its process was handed over, and
 * the user's turn ends, the process still held for the work. With
 * `reportsBackgroundWork` the tracker sees that work too (a task, not a
 * wake-up). Runs after `exitAll`, and runs for other sessions, settle at once.
 */
function createHandOverRuntime(
  runs: RunCall[],
  heldSessionId: string,
  { reportsBackgroundWork = false }: { reportsBackgroundWork?: boolean } = {},
) {
  type HeldWriter = ProviderRuntimeWriter & { sendComplete(opts: { exitCode: number }): void };
  const openProcesses: Array<{ writer: HeldWriter; exit: () => void; launched: Record<string, unknown> }> = [];
  const aborts: string[] = [];
  // Whether the latest open process is still held for the work its turn left going.
  let holdingWork = false;
  let exited = false;
  const holdsWork = (sessionId: string) => sessionId === heldSessionId && holdingWork;

  const runtime: ProviderRuntimeGateway = {
    ...UNUSED_GATEWAY_METHODS,
    hasRuntime: () => true,
    hasBackgroundWork: (sessionId: string) => reportsBackgroundWork && holdsWork(sessionId),
    planHandOver: planHeldProcess(heldSessionId, () => (holdingWork ? openProcesses.at(-1)?.launched ?? null : null)),
    run: async (provider: string, command: string, options: Record<string, unknown>, writer: HeldWriter) => {
      runs.push({ provider, command, options });
      if (options.sessionId !== heldSessionId || exited) {
        return;
      }
      holdingWork = true;
      writer.sendComplete({ exitCode: 0 });
      await new Promise<void>((resolve) => {
        openProcesses.push({ writer, exit: resolve, launched: options });
      });
    },
    abort: async (_provider: string, sessionId: string) => {
      aborts.push(sessionId);
      return true;
    },
  };

  return {
    runtime,
    aborts,
    handOver: (userId: number) => {
      const process = openProcesses.at(-1);
      assert.ok(process, 'a process is open to hand the turn to');
      const userRun = chatRunRegistry.startRun({
        appSessionId: heldSessionId,
        provider: 'claude',
        providerSessionId: null,
        connection: null,
        userId,
      });
      assert.ok(userRun, 'the user\'s send gets a run of its own');
      process.writer.reportProcessHandedOver?.();
      userRun.writer.sendComplete({ exitCode: 0 });
    },
    /** The work has reported back: the process lets go of the session, but has not exited yet. */
    workDone: () => {
      holdingWork = false;
    },
    exitAll: () => {
      exited = true;
      holdingWork = false;
      for (const process of openProcesses.splice(0)) {
        process.exit();
      }
    },
  };
}

/**
 * A runtime holding `heldSessionId`'s process open after its turn for work of
 * the session's own, as Claude holds it for a wake-up that ScheduleWakeup or
 * /loop set: the tracker sees nothing, unless `tracksWork` (a backgrounded
 * build runs in the process too). A self-paced /loop arms its next wake-up at
 * each, so the hold lasts until `endHold` (the user stopped the loop, or the
 * work reported back). The process was launched with the run options
 * `launched`. Its hand-over plan (`planHeldProcess`), whose every call
 * `plans` records, lets in a turn that keeps those launch settings and names
 * what the turn would switch. Its runs hand their turn over as Claude's
 * runtime does, judging the turn as its options say, or with the settings it
 * leaves out taken as the process's own when its options set `inheritUnset:
 * true`: a turn that goes in is the process's next turn, which ends at once,
 * after the switches it makes (`switched`), and the hold goes on; one that
 * cannot starts a process of its own, which replaces the held one and stops
 * the work (`stops`). An abort, which stops the turn under way in the process
 * with its background work, stops the work too.
 */
function createHeldProcessRuntime(
  runs: RunCall[],
  heldSessionId: string,
  launched: Record<string, unknown>,
  { tracksWork = false }: { tracksWork?: boolean } = {},
) {
  const plans: Array<{
    sessionId: string;
    options: Record<string, unknown>;
    planOptions: ProviderHandOverPlanOptions | undefined;
  }> = [];
  const stops: string[] = [];
  const switched: string[] = [];
  const aborts: string[] = [];
  let holding = true;
  const plan = planHeldProcess(heldSessionId, () => (holding ? launched : null));
  const stopWork = () => {
    holding = false;
    stops.push(heldSessionId);
  };

  const runtime: ProviderRuntimeGateway = {
    ...UNUSED_GATEWAY_METHODS,
    hasRuntime: () => true,
    hasBackgroundWork: (sessionId: string) => tracksWork && holding && sessionId === heldSessionId,
    planHandOver: async (provider, sessionId, options, planOptions?: ProviderHandOverPlanOptions) => {
      plans.push({ sessionId, options, planOptions });
      return plan(provider, sessionId, options, planOptions);
    },
    run: async (provider: string, command: string, options: Record<string, unknown>) => {
      runs.push({ provider, command, options });
      if (options.sessionId !== heldSessionId || !holding) {
        return;
      }
      const { changes, switches } = compareWithHeldProcess(launched, options, options.inheritUnset === true);
      if (changes.length > 0) {
        stopWork();
        return;
      }
      switched.push(...switches);
    },
    abort: async (_provider: string, sessionId: string) => {
      aborts.push(sessionId);
      if (sessionId === heldSessionId && holding) {
        stopWork();
      }
      return true;
    },
  };

  return {
    runtime,
    plans,
    stops,
    switched,
    aborts,
    endHold: () => {
      holding = false;
    },
  };
}

/** The project a session runs in, which its turns' run options carry as `cwd`. */
function projectPathOf(sessionId: string): string | null | undefined {
  return sessionsDb.getSessionById(sessionId)?.project_path;
}

/**
 * A turn's run options less its attachments, which the chat gateway checks
 * and sets for the run itself (see `buildTurnRunOptions`).
 */
function withoutAttachments(options: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(options).filter(([key]) => !['attachments', 'images', 'files'].includes(key)),
  );
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

test('a queued message that needs a new process waits while its session\'s process is held for work no task reports, and goes once the hold ends', async () => {
  await withIsolatedDatabase(async (userId) => {
    // The user's turn, at high effort, ended having scheduled a wake-up: its
    // process is held for it, though the tracker sees no task. A send at max
    // effort was refused rather than stop that, and the user chose to queue it.
    const userRun = chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });
    assert.ok(userRun);
    userRun.writer.sendComplete({ exitCode: 0 });
    sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, {
      content: 'now at max effort',
      options: { effort: 'max' },
      attachments: [],
    });

    const runs: RunCall[] = [];
    const { runtime, stops, endHold } = createHeldProcessRuntime(runs, SESSION_ID, {
      cwd: projectPathOf(SESSION_ID),
      effort: 'high',
    });

    // Sent now, it would replace that process and stop the wake-up.
    assert.equal(await dispatchQueuedMessages(runtime), 0);
    assert.equal(runs.length, 0);
    assert.deepEqual(stops, []);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, {
      content: 'now at max effort',
      options: { effort: 'max' },
      attachments: [],
    });

    // The wake-up has run and the process has let go: it goes on the next pass.
    endHold();
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.deepEqual(runs.map((run) => run.command), ['now at max effort']);
    assert.equal(runs[0].options.effort, 'max');
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

test('a due message that needs a new process waits while its session\'s process is held for work, rather than replace it, and goes once the hold ends', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'check on it at max effort',
      options: { effort: 'max' },
      scheduledFor: secondsAgo(1),
    });

    // The session's last turn ended with work still going (a wake-up, a
    // CronCreate job), and its process, launched at high effort, is held for
    // it. No turn is under way.
    const runs: RunCall[] = [];
    const { runtime, aborts, stops, endHold } = createHeldProcessRuntime(runs, SESSION_ID, {
      cwd: projectPathOf(SESSION_ID),
      effort: 'high',
    });

    assert.equal(await dispatchDueScheduledMessages(runtime), 0);
    assert.equal(runs.length, 0);
    assert.deepEqual(aborts, []);
    assert.deepEqual(stops, []);
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'pending');

    endHold();
    assert.equal(await dispatchDueScheduledMessages(runtime), 1);
    assert.deepEqual(runs.map((run) => run.command), ['check on it at max effort']);
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'sent');
  });
});

test('due messages the held process can take go into it when due, though a self-paced /loop keeps the process held', async () => {
  await withIsolatedDatabase(async (userId) => {
    // The user's /loop turn ended with its next wake-up armed, and each
    // wake-up arms another: the process, launched at high effort, stays held.
    const runs: RunCall[] = [];
    const { runtime, plans, stops, switched, aborts } = createHeldProcessRuntime(runs, SESSION_ID, {
      cwd: projectPathOf(SESSION_ID),
      effort: 'high',
    });
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'how is the loop doing?',
      options: { effort: 'high' },
      scheduledFor: secondsAgo(2),
    });
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'and the error rate?',
      options: { effort: 'high' },
      scheduledFor: secondsAgo(1),
    });

    assert.equal(await dispatchDueScheduledMessages(runtime), 2);
    assert.deepEqual(runs.map((run) => run.command), ['how is the loop doing?', 'and the error rate?']);
    assert.deepEqual(scheduledMessagesDb.listForSession(userId, SESSION_ID).map((row) => row.status), ['sent', 'sent']);
    assert.deepEqual(stops, [], 'both went into the held process, and the loop goes on');
    assert.deepEqual(switched, []);
    assert.deepEqual(aborts, []);
    // Each plan judged the turn that then ran: the message's own run options,
    // with what it leaves unset taken as the process's own.
    assert.equal(plans.length, 2);
    plans.forEach((plan, index) => {
      assert.deepEqual(withoutAttachments(plan.options), withoutAttachments(runs[index].options));
      assert.deepEqual(plan.planOptions, { inheritUnset: true });
    });
  });
});

test('a queued message the held process can take goes into it, though a self-paced /loop keeps the process held', async () => {
  await withIsolatedDatabase(async (userId) => {
    const runs: RunCall[] = [];
    const { runtime, plans, stops } = createHeldProcessRuntime(runs, SESSION_ID, {
      cwd: projectPathOf(SESSION_ID),
      effort: 'high',
    });
    sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, {
      content: 'also look at the logs',
      options: { effort: 'high' },
      attachments: [],
    });

    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.deepEqual(runs.map((run) => run.command), ['also look at the logs']);
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
    assert.deepEqual(stops, [], 'it went into the held process, and the loop goes on');
    assert.equal(plans.length, 1);
    assert.deepEqual(withoutAttachments(plans[0].options), withoutAttachments(runs[0].options));
    assert.deepEqual(plans[0].planOptions, { inheritUnset: true });
  });
});

/**
 * The run options of a process the composer launched for the user's /loop
 * (see `buildSendOptions` in the chat composer): the model, the effort, the
 * composer's permission mode and the user's Claude tool rules (`toolRules`).
 */
function composerLaunch(sessionId: string, toolRules: ToolRules, permissionMode = 'default'): Record<string, unknown> {
  return {
    cwd: projectPathOf(sessionId),
    model: 'sonnet',
    effort: 'high',
    permissionMode,
    toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false, ...toolRules },
  };
}

/**
 * What a scheduled message stores as its options (see
 * `handleScheduleMessage` in the chat interface): the composer's model,
 * effort and permission mode, and no tool rules.
 */
const SCHEDULED_AT_THE_LOOP_SETTINGS = { model: 'sonnet', effort: 'high', permissionMode: 'default' };

test('a due message naming the default mode goes into a /loop\'s process held in bypassPermissions when due, and leaves it in bypassPermissions', async () => {
  await withIsolatedDatabase(async (userId) => {
    // The user skips permissions, so the composer launched the /loop in
    // bypassPermissions. The message names the composer's default mode and,
    // as every scheduled message, carries no tool rules: the user's
    // skipPermissions is the process's.
    const runs: RunCall[] = [];
    const { runtime, plans, stops, switched, aborts } = createHeldProcessRuntime(
      runs,
      SESSION_ID,
      composerLaunch(SESSION_ID, { skipPermissions: true }),
    );
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'post a summary',
      options: SCHEDULED_AT_THE_LOOP_SETTINGS,
      scheduledFor: secondsAgo(1),
    });

    assert.equal(await dispatchDueScheduledMessages(runtime), 1);
    assert.deepEqual(runs.map((run) => run.command), ['post a summary']);
    assert.deepEqual(switched, [], 'the loop keeps running in bypassPermissions');
    assert.deepEqual(stops, [], 'it went into the held process, and the loop goes on');
    assert.deepEqual(aborts, []);
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'sent');
    // Planned and run alike, with what it leaves out taken from the process.
    assert.deepEqual(plans[0].planOptions, { inheritUnset: true });
    assert.equal(runs[0].options.inheritUnset, true);
  });
});

test('a due message that would switch the held process\'s permission mode waits, poll after poll, rather than leave a /loop asking for what it was allowed to do', async () => {
  await withIsolatedDatabase(async (userId) => {
    // The /loop was launched in acceptEdits; the composer was back in the
    // default mode when the message was scheduled.
    const runs: RunCall[] = [];
    const { runtime, stops, switched, aborts, endHold } = createHeldProcessRuntime(
      runs,
      SESSION_ID,
      composerLaunch(SESSION_ID, {}, 'acceptEdits'),
    );
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'post a summary',
      options: SCHEDULED_AT_THE_LOOP_SETTINGS,
      scheduledFor: secondsAgo(1),
    });

    for (let poll = 0; poll < 3; poll += 1) {
      assert.equal(await dispatchDueScheduledMessages(runtime), 0);
    }
    assert.equal(runs.length, 0);
    assert.deepEqual(switched, [], 'the loop keeps editing without asking');
    assert.deepEqual(stops, []);
    assert.deepEqual(aborts, []);
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'pending');

    // The loop is stopped and the process lets go: it goes, in the mode it names.
    endHold();
    assert.equal(await dispatchDueScheduledMessages(runtime), 1);
    assert.deepEqual(runs.map((run) => run.command), ['post a summary']);
    assert.equal(runs[0].options.permissionMode, 'default');
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'sent');
  });
});

test('a queued message that would switch the held process\'s model waits for the hold to end', async () => {
  await withIsolatedDatabase(async (userId) => {
    const runs: RunCall[] = [];
    const { runtime, switched, stops, endHold } = createHeldProcessRuntime(runs, SESSION_ID, composerLaunch(SESSION_ID, {}));
    // Queued from the composer after the user picked another model.
    const queuedMessage = {
      content: 'now on opus',
      options: {
        model: 'opus',
        effort: 'high',
        permissionMode: 'default',
        toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false },
      },
      attachments: [],
    };
    sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, queuedMessage);

    assert.equal(await dispatchQueuedMessages(runtime), 0);
    assert.equal(runs.length, 0);
    assert.deepEqual(switched, [], 'the loop keeps its model');
    assert.deepEqual(stops, []);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, queuedMessage);

    endHold();
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.deepEqual(runs.map((run) => run.command), ['now on opus']);
    assert.equal(runs[0].options.model, 'opus');
  });
});

test('a due message without tool rules goes into the held process when due, though the user\'s Claude settings allow tools the process was launched with', async () => {
  await withIsolatedDatabase(async (userId) => {
    // The user once chose "always allow" for a command, so the composer
    // launched the /loop with that rule. The message carries no tool rules.
    const runs: RunCall[] = [];
    const { runtime, plans, stops, switched, aborts } = createHeldProcessRuntime(
      runs,
      SESSION_ID,
      composerLaunch(SESSION_ID, { allowedTools: ['Bash(git status:*)'] }),
    );
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'post a summary',
      options: SCHEDULED_AT_THE_LOOP_SETTINGS,
      scheduledFor: secondsAgo(1),
    });

    assert.equal(await dispatchDueScheduledMessages(runtime), 1);
    assert.deepEqual(runs.map((run) => run.command), ['post a summary']);
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'sent');
    assert.deepEqual(stops, [], 'it went into the held process, and the loop goes on');
    assert.deepEqual(switched, []);
    assert.deepEqual(aborts, []);
    // Planned and run alike, with the process's tool rules for the ones it leaves out.
    assert.equal(plans.length, 1);
    assert.deepEqual(plans[0].planOptions, { inheritUnset: true });
    assert.equal(runs[0].options.inheritUnset, true);
  });
});

test('a due message does not interrupt the user\'s turn under way in the held process while the tracker reports the session\'s background work, and goes once the work is done', async () => {
  await withIsolatedDatabase(async (userId) => {
    // A /loop holds the session's process, launched at high effort, and a
    // build it backgrounded runs there, which the tracker reports.
    const runs: RunCall[] = [];
    const held = createHeldProcessRuntime(
      runs,
      SESSION_ID,
      { cwd: projectPathOf(SESSION_ID), effort: 'high' },
      { tracksWork: true },
    );
    const runtime: ProviderRuntimeGateway = {
      ...held.runtime,
      // While a turn runs in the process, the plan sees nothing held, as
      // Claude's runtime answered before it told such a turn apart.
      planHandOver: async (provider, sessionId, options, planOptions?: ProviderHandOverPlanOptions) => (
        chatRunRegistry.isProcessing(sessionId)
          ? NOTHING_HELD
          : held.runtime.planHandOver(provider, sessionId, options, planOptions)
      ),
    };
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'check on it at max effort',
      options: { effort: 'max' },
      scheduledFor: secondsAgo(1),
    });
    const status = () => scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status;

    // It needs a process of its own, which would stop the build and the loop.
    assert.equal(await dispatchDueScheduledMessages(runtime), 0);

    // The user's send goes into the held process as its next turn, and is under way.
    const userTurn = chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });
    assert.ok(userTurn);
    assert.equal(await dispatchDueScheduledMessages(runtime), 0);
    assert.deepEqual(held.aborts, [], 'the user\'s turn is not interrupted');
    assert.deepEqual(held.stops, [], 'the build and the loop go on');
    assert.equal(runs.length, 0);
    assert.equal(status(), 'pending');

    // The turn ends; the build still runs, so the message still waits.
    userTurn.writer.sendComplete({ exitCode: 0 });
    assert.equal(await dispatchDueScheduledMessages(runtime), 0);

    // The build reports back and the user stops the loop: it goes.
    held.endHold();
    assert.equal(await dispatchDueScheduledMessages(runtime), 1);
    assert.deepEqual(runs.map((run) => run.command), ['check on it at max effort']);
    assert.deepEqual(held.aborts, []);
    assert.equal(status(), 'sent');
  });
});

test('a due message the held process could take does not interrupt the user\'s turn under way in it, and goes into it once that turn has ended', async () => {
  await withIsolatedDatabase(async (userId) => {
    // A /loop holds the session's process for its next wake-up, which the
    // tracker cannot see. The user's send went into the process as its next
    // turn and is under way, and the plan reports the work held. The message
    // fits the process, but sending it now would interrupt the turn first,
    // and the interrupt stops the loop.
    const runs: RunCall[] = [];
    const { runtime, aborts, stops, switched } = createHeldProcessRuntime(runs, SESSION_ID, {
      cwd: projectPathOf(SESSION_ID),
      effort: 'high',
    });
    const userTurn = chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });
    assert.ok(userTurn);
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'how is the loop doing?',
      options: { effort: 'high' },
      scheduledFor: secondsAgo(1),
    });
    const status = () => scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status;

    assert.equal(await dispatchDueScheduledMessages(runtime), 0);
    assert.deepEqual(aborts, [], 'the user\'s turn is not interrupted');
    assert.deepEqual(stops, [], 'the loop goes on');
    assert.equal(runs.length, 0);
    assert.equal(status(), 'pending');

    // The user's turn ends, the process still held: the message goes into it.
    userTurn.writer.sendComplete({ exitCode: 0 });
    assert.equal(await dispatchDueScheduledMessages(runtime), 1);
    assert.deepEqual(runs.map((run) => run.command), ['how is the loop doing?']);
    assert.deepEqual(aborts, [], 'no turn was under way to interrupt');
    assert.deepEqual(stops, [], 'it went into the held process, and the loop goes on');
    assert.deepEqual(switched, []);
    assert.equal(status(), 'sent');
  });
});

test('while a self-paced /loop keeps the process held, a due message that needs a new process waits poll after poll, and the session\'s later messages wait behind it', { timeout: 10_000 }, async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    await withIsolatedDatabase(async (userId) => {
      const runs: RunCall[] = [];
      const { runtime, stops, endHold } = createHeldProcessRuntime(runs, SESSION_ID, {
        cwd: projectPathOf(SESSION_ID),
        effort: 'high',
      });
      const first = scheduledMessagesService.schedule({
        userId,
        sessionId: SESSION_ID,
        content: 'now at max effort',
        options: { effort: 'max' },
        scheduledFor: secondsAgo(2),
      });
      const second = scheduledMessagesService.schedule({
        userId,
        sessionId: SESSION_ID,
        content: 'then at the loop\'s effort',
        options: { effort: 'high' },
        scheduledFor: secondsAgo(1),
      });
      sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, {
        content: 'queued after them',
        options: { effort: 'high' },
        attachments: [],
      });
      const statusOf = (id: string) =>
        scheduledMessagesDb.listForSession(userId, SESSION_ID).find((row) => row.id === id)?.status;

      initializeScheduledMessageDispatcher(runtime);
      await flushPasses();
      for (let poll = 0; poll < 3; poll += 1) {
        mock.timers.tick(POLL_INTERVAL_MS);
        await flushPasses();
      }

      // The first would replace the process and stop the loop. The second and
      // the queued one could go into it, but not ahead of the first.
      assert.equal(runs.length, 0);
      assert.deepEqual(stops, []);
      assert.equal(statusOf(first.id), 'pending');
      assert.equal(statusOf(second.id), 'pending');
      assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, {
        content: 'queued after them',
        options: { effort: 'high' },
        attachments: [],
      });

      // The user stops the loop and the process lets go: the due ones go in
      // order, and the queued one on the poll after them.
      endHold();
      mock.timers.tick(POLL_INTERVAL_MS);
      await flushPasses();
      assert.deepEqual(runs.map((run) => run.command), ['now at max effort', 'then at the loop\'s effort']);
      mock.timers.tick(POLL_INTERVAL_MS);
      await flushPasses();
      assert.deepEqual(runs.map((run) => run.command), [
        'now at max effort',
        'then at the loop\'s effort',
        'queued after them',
      ]);
      assert.equal(statusOf(first.id), 'sent');
      assert.equal(statusOf(second.id), 'sent');
    });
  } finally {
    closeScheduledMessageDispatcher();
    mock.timers.reset();
  }
});

test('a hand-over plan the runtime fails to make counts as nothing held, so due and queued messages still go', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionsDb.createAppSession(OTHER_SESSION_ID, 'claude', '/workspace/demo', 'Other session');
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'due all the same',
      scheduledFor: secondsAgo(1),
    });
    sessionDraftsDb.appendQueuedMessage(userId, OTHER_SESSION_ID, { content: 'queued all the same', attachments: [] });

    const runs: RunCall[] = [];
    const runtime: ProviderRuntimeGateway = {
      ...createRuntime(runs),
      planHandOver: async () => {
        throw new Error('the runtime could not plan');
      },
    };

    assert.equal(await dispatchDueScheduledMessages(runtime), 1);
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.deepEqual(commandsFor(runs, SESSION_ID), ['due all the same']);
    assert.deepEqual(commandsFor(runs, OTHER_SESSION_ID), ['queued all the same']);
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

test('once the user\'s turn has taken over a queued turn\'s process, the session\'s next queued turn, which needs a new process, waits for the work, not for that process to exit', { timeout: 10_000 }, async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    await withIsolatedDatabase(async (userId) => {
      const runs: RunCall[] = [];
      const { runtime, handOver, workDone, exitAll } = createHandOverRuntime(runs, SESSION_ID);
      sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, { content: 'first follow-up', attachments: [] });
      initializeScheduledMessageDispatcher(runtime);
      try {
        await flushPasses();
        assert.deepEqual(commandsFor(runs, SESSION_ID), ['first follow-up']);

        // The user sends the next message: it runs in the process the queued
        // turn left open, and ends. The process stays held for the work, so
        // the next queued turn, at an effort only a new process can apply,
        // waits, as it would in any session.
        handOver(userId);
        await flushPasses();
        sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, {
          content: 'second follow-up',
          options: { effort: 'max' },
          attachments: [],
        });
        mock.timers.tick(POLL_INTERVAL_MS);
        await flushPasses();
        assert.deepEqual(commandsFor(runs, SESSION_ID), ['first follow-up']);

        // The work reports back and the process lets go of the session. It
        // has not exited, so the first follow-up's run has not settled, but
        // the dispatcher stopped waiting for that run at the hand-over.
        workDone();
        mock.timers.tick(POLL_INTERVAL_MS);
        await flushPasses();
        assert.deepEqual(commandsFor(runs, SESSION_ID), ['first follow-up', 'second follow-up']);
      } finally {
        exitAll();
        await flushPasses();
      }
    });
  } finally {
    closeScheduledMessageDispatcher();
    mock.timers.reset();
  }
});

test('a queued turn still waits for background work the session reports after the user\'s turn took the process over', { timeout: 10_000 }, async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    await withIsolatedDatabase(async (userId) => {
      const runs: RunCall[] = [];
      const { runtime, handOver, exitAll } = createHandOverRuntime(runs, SESSION_ID, { reportsBackgroundWork: true });
      sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, { content: 'first follow-up', attachments: [] });
      initializeScheduledMessageDispatcher(runtime);
      try {
        await flushPasses();
        handOver(userId);
        await flushPasses();
        // The held process could take this turn, but a queued turn waits for
        // work the tracker reports.
        sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, { content: 'after the build', attachments: [] });

        mock.timers.tick(POLL_INTERVAL_MS);
        await flushPasses();
        assert.deepEqual(commandsFor(runs, SESSION_ID), ['first follow-up']);
        assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, {
          content: 'after the build',
          attachments: [],
        });
      } finally {
        exitAll();
        await flushPasses();
      }
    });
  } finally {
    closeScheduledMessageDispatcher();
    mock.timers.reset();
  }
});

test('once the user\'s turn has taken over a dispatched turn\'s process, a message that comes due and needs a new process waits for the work, not for that process to exit', { timeout: 10_000 }, async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    await withIsolatedDatabase(async (userId) => {
      const runs: RunCall[] = [];
      const { runtime, aborts, handOver, workDone, exitAll } = createHandOverRuntime(runs, SESSION_ID);
      scheduledMessagesService.schedule({
        userId,
        sessionId: SESSION_ID,
        content: 'start the build',
        scheduledFor: secondsAgo(2),
      });
      initializeScheduledMessageDispatcher(runtime);
      try {
        await flushPasses();
        assert.deepEqual(commandsFor(runs, SESSION_ID), ['start the build']);

        handOver(userId);
        await flushPasses();
        const later = scheduledMessagesService.schedule({
          userId,
          sessionId: SESSION_ID,
          content: 'check on the build',
          options: { effort: 'max' },
          scheduledFor: secondsAgo(1),
        });
        const statusOfLater = () =>
          scheduledMessagesDb.listForSession(userId, SESSION_ID).find((row) => row.id === later.id)?.status;

        // The process is still held for the work the first message's turn
        // left going: sent now, at an effort only a new process can apply,
        // the message would replace it and stop that.
        mock.timers.tick(POLL_INTERVAL_MS);
        await flushPasses();
        assert.deepEqual(commandsFor(runs, SESSION_ID), ['start the build']);
        assert.equal(statusOfLater(), 'pending');

        // The work reports back; the process has not exited yet.
        workDone();
        mock.timers.tick(POLL_INTERVAL_MS);
        await flushPasses();
        assert.deepEqual(commandsFor(runs, SESSION_ID), ['start the build', 'check on the build']);
        assert.deepEqual(aborts, [], 'the user\'s turn had ended, so nothing was interrupted');
        assert.equal(statusOfLater(), 'sent');
      } finally {
        exitAll();
        await flushPasses();
      }
    });
  } finally {
    closeScheduledMessageDispatcher();
    mock.timers.reset();
  }
});

test('a due message that needs a new process, behind another of its session\'s, stays pending once the user\'s turn has left the first one\'s process held', { timeout: 10_000 }, async () => {
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
      options: { effort: 'max' },
      scheduledFor: secondsAgo(1),
    });

    const runs: RunCall[] = [];
    const { runtime, aborts, handOver, exitAll } = createHandOverRuntime(runs, SESSION_ID);
    const pass = dispatchDueScheduledMessages(runtime);
    try {
      await flushPasses();
      assert.deepEqual(commandsFor(runs, SESSION_ID), ['first']);

      // The user's turn takes over the first message's process and ends,
      // leaving it held for the work. The pass stops waiting for the first
      // message's run there, and the second, at an effort only a new process
      // can apply, waits for the work in turn.
      handOver(userId);
      await flushPasses();
      assert.deepEqual(commandsFor(runs, SESSION_ID), ['first']);
      assert.deepEqual(aborts, []);
      assert.equal(
        scheduledMessagesDb.listForSession(userId, SESSION_ID).find((row) => row.id === second.id)?.status,
        'pending',
      );
    } finally {
      exitAll();
      await pass;
    }

    assert.equal(await pass, 1);
  });
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
