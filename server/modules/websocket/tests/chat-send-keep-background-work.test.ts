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
import type { AnyRecord, ProviderHandOverPlan, ProviderRuntimeWriter } from '@/shared/types.js';

/**
 * A Claude session whose turn ended with background work left keeps its
 * process for that work, and the next message runs in it when its options
 * allow. One that changes what only a new process can apply would start a
 * process of its own and stop the work. A `chat.send` that sets
 * `options.keepBackgroundWork` is refused instead, straight back to the
 * asking socket as `send_refused`, and no run starts; without the flag the
 * send goes ahead as it always has.
 */

const SESSION_ID = 'held-session';

type Frame = Record<string, unknown>;

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
 * A runtime gateway that plans a hand-over as the test says and records the
 * plans it is asked for and the runs it starts. Each run ends at once, as
 * `turn` has it, or with its `complete`.
 */
function createGateway(
  plan: (options: AnyRecord) => Promise<ProviderHandOverPlan>,
  turn: (writer: ProviderRuntimeWriter) => Promise<void> = async (writer) => {
    writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode: 0 });
  },
) {
  const plans: AnyRecord[] = [];
  const runs: Array<{ command: string; options: AnyRecord }> = [];
  const runtime: ProviderRuntimeGateway = {
    hasRuntime: () => true,
    run: async (_provider, command, options, writer) => {
      runs.push({ command, options });
      await turn(writer);
    },
    abort: async () => false,
    stopBackgroundTask: async () => false,
    hasBackgroundWork: () => true,
    hasScheduledWork: () => false,
    listScheduledWork: () => [],
    stopScheduledWork: async () => ({ status: 'not_found' }),
    resolveToolApproval: () => {},
    getPendingApprovalsForSession: () => [],
    insert: async () => ({ accepted: false, reason: 'NO_ACTIVE_RUN' }),
    cancelInsert: async () => ({ status: 'not_found' }),
    planHandOver: async (_provider, _sessionId, options) => {
      plans.push(options);
      return plan(options);
    },
  };
  return { runtime, plans, runs };
}

async function withChat(
  runtime: ProviderRuntimeGateway,
  runTest: (context: { socket: ReturnType<typeof createFakeSocket>; projectPath: string }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-send-keep-background-work-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);
    const socket = createFakeSocket();
    handleChatConnection(socket as never, { user: { id: 1 } } as never, { runtime });
    await runTest({ socket, projectPath: tempDirectory });
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

const send = (socket: ReturnType<typeof createFakeSocket>, options: AnyRecord) => {
  socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION_ID, content: 'and now the docs', options }));
};

test('a send that asks to keep the background work is refused, and starts no run, when its turn cannot go into the held process', async () => {
  const { runtime, plans, runs } = createGateway(async () => ({ heldWork: true, canHandOver: false, changes: ['effort'], switches: [] }));
  await withChat(runtime, async ({ socket, projectPath }) => {
    send(socket, { model: 'opus', effort: 'max', keepBackgroundWork: true });
    await settle();

    assert.deepEqual(runs, []);
    assert.equal(chatRunRegistry.getRun(SESSION_ID), undefined, 'no run was registered');
    // Asked with the run options the turn would have run with.
    assert.equal(plans.length, 1);
    assert.equal(plans[0]?.cwd, projectPath);
    assert.equal(plans[0]?.sessionId, SESSION_ID);
    assert.equal(plans[0]?.effort, 'max');

    assert.equal(socket.frames.length, 1, 'only the refusal, and no protocol_error');
    const [refusal] = socket.frames;
    assert.equal(refusal?.kind, 'send_refused');
    assert.equal(refusal?.sessionId, SESSION_ID);
    assert.equal(refusal?.reason, 'BACKGROUND_WORK_WOULD_STOP');
    assert.deepEqual(refusal?.changes, ['effort']);
    assert.equal(refusal?.content, 'and now the docs');
    assert.equal(refusal?.seq, undefined);
  });
});

test('a send that asks to keep the background work starts as usual when its turn can go into the held process, or nothing is held', async () => {
  let plan: ProviderHandOverPlan = { heldWork: true, canHandOver: true, changes: [], switches: [] };
  const { runtime, runs } = createGateway(async () => plan);
  await withChat(runtime, async ({ socket }) => {
    send(socket, { keepBackgroundWork: true });
    await settle();
    plan = { heldWork: false, canHandOver: false, changes: [], switches: [] };
    send(socket, { keepBackgroundWork: true });
    await settle();

    assert.equal(runs.length, 2);
    // The runtime still sees the flag.
    assert.equal(runs[0]?.options.keepBackgroundWork, true);
    assert.equal(socket.frames.some((frame) => frame.kind === 'send_refused'), false);
  });
});

test('a send that asks to keep the background work starts when a process of its own keeps the work, and a refusal says what exactly keeps the turn out', async () => {
  let plan: ProviderHandOverPlan = { heldWork: true, canHandOver: false, changes: ['tools'], switches: [], replaceKeepsWork: true };
  const { runtime, runs } = createGateway(async () => plan);
  await withChat(runtime, async ({ socket }) => {
    send(socket, { keepBackgroundWork: true });
    await settle();
    assert.equal(runs.length, 1, 'cron jobs alone hold the process, and its own brings them back');
    assert.equal(socket.frames.some((frame) => frame.kind === 'send_refused'), false);

    plan = {
      heldWork: true,
      canHandOver: false,
      changes: ['permissionMode'],
      switches: [],
      details: { permissionMode: { process: 'plan', message: 'bypassPermissions', reason: 'bypass_not_allowed' } },
    };
    send(socket, { keepBackgroundWork: true });
    await settle();
    assert.equal(runs.length, 1);
    const refusal = socket.frames.find((frame) => frame.kind === 'send_refused');
    assert.deepEqual(refusal?.details, plan.details);
  });
});

test('a send without the flag never asks and goes ahead, stopping the work as before', async () => {
  const { runtime, plans, runs } = createGateway(async () => ({ heldWork: true, canHandOver: false, changes: ['effort'], switches: [] }));
  await withChat(runtime, async ({ socket }) => {
    send(socket, { effort: 'max' });
    await settle();

    assert.deepEqual(plans, []);
    assert.equal(runs.length, 1);
    assert.equal(socket.frames.some((frame) => frame.kind === 'send_refused'), false);
  });
});

test('a send to a session with a turn under way is refused as RUN_IN_PROGRESS, as before, without asking', async () => {
  const { runtime, plans, runs } = createGateway(async () => ({ heldWork: true, canHandOver: false, changes: ['effort'], switches: [] }));
  await withChat(runtime, async ({ socket }) => {
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId: 1,
    });
    send(socket, { keepBackgroundWork: true });
    await settle();

    assert.deepEqual(plans, []);
    assert.deepEqual(runs, []);
    assert.deepEqual(socket.frames.map((frame) => [frame.kind, frame.code]), [['protocol_error', 'RUN_IN_PROGRESS']]);
  });
});

test('a plan the runtime fails to make refuses the send rather than risk the work', async () => {
  const { runtime, runs } = createGateway(async () => { throw new Error('model lookup failed'); });
  await withChat(runtime, async ({ socket }) => {
    send(socket, { keepBackgroundWork: true });
    await settle();

    assert.deepEqual(runs, []);
    assert.deepEqual(socket.frames.map((frame) => [frame.kind, frame.changes]), [['send_refused', ['lookup']]]);
  });
});

test('the refusal hands back the send\'s clientRequestId, and leaves out one that is missing or out of pattern', async () => {
  const { runtime, runs } = createGateway(async () => ({ heldWork: true, canHandOver: false, changes: ['effort'], switches: [] }));
  await withChat(runtime, async ({ socket }) => {
    // Two panes of one page send over the same socket, then a send with no
    // id (a page from before ids) and sends with ids the gateway will not echo.
    const clientRequestIds: unknown[] = ['send_mf3k2_a1b2c3', 'send_mf3k2_d4e5f6', undefined, 'not an id', 'x'.repeat(129), 42];
    for (const clientRequestId of clientRequestIds) {
      socket.emit('message', JSON.stringify({
        type: 'chat.send',
        sessionId: SESSION_ID,
        content: 'and now the docs',
        options: { effort: 'max', keepBackgroundWork: true },
        clientRequestId,
      }));
    }
    await settle();

    assert.deepEqual(runs, []);
    const refusals = socket.frames.filter((frame) => frame.kind === 'send_refused');
    assert.deepEqual(
      refusals.map((frame) => ('clientRequestId' in frame ? frame.clientRequestId : 'none')),
      ['send_mf3k2_a1b2c3', 'send_mf3k2_d4e5f6', 'none', 'none', 'none', 'none'],
    );
  });
});

// A process held for cron jobs alone lets a send in that changes what only a
// new process can apply: the new process brings the jobs back. While a job's
// fire is under way the turn waits for it, and when that fire starts work a
// new process would stop, the runtime fails the turn (HAND_OVER_FAILED,
// `work-started`) rather than stop it. The composer hears it as a refusal.

const WORK_STARTED_CONTENT = 'Not sent: this message changes the reasoning effort, which only a new Claude process can apply, and the turn Claude ran on its own meanwhile started work a new process would stop.';

/** As Claude's runtime fails such a turn (failHandOver, `work-started`). */
const failAtHandOver = async (writer: ProviderRuntimeWriter) => {
  writer.send({ kind: 'error', code: 'HAND_OVER_FAILED', reason: 'work-started', changes: ['effort'], content: WORK_STARTED_CONTENT, sessionId: 'native', provider: 'claude' });
  throw Object.assign(new Error(WORK_STARTED_CONTENT), { code: 'HAND_OVER_FAILED', reason: 'work-started' });
};

const cronJobsAlone = async (): Promise<ProviderHandOverPlan> => ({ heldWork: true, canHandOver: false, changes: ['effort'], switches: [], replaceKeepsWork: true });

test('a send that asks to keep the background work, failed at the hand-over once its run began, is refused to the asking socket after the run\'s complete', async () => {
  const { runtime, runs } = createGateway(cronJobsAlone, failAtHandOver);
  await withChat(runtime, async ({ socket }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: 'and now the docs',
      options: { effort: 'max', keepBackgroundWork: true },
      clientRequestId: 'send_mf3k2_a1b2c3',
    }));
    await settle();

    assert.equal(runs.length, 1, 'the run started');
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false, 'and is over');
    // `run_ended` goes to every socket, this one included.
    assert.deepEqual(
      socket.frames.filter((frame) => frame.kind !== 'run_ended').map((frame) => [frame.kind, frame.code ?? null]),
      [['error', 'HAND_OVER_FAILED'], ['complete', null], ['send_refused', null]],
      'the refusal comes after the run\'s complete',
    );
    const refusal = socket.frames.at(-1);
    assert.equal(refusal?.sessionId, SESSION_ID);
    assert.equal(refusal?.reason, 'HAND_OVER_FAILED');
    assert.deepEqual(refusal?.changes, ['effort']);
    assert.equal(refusal?.content, 'and now the docs');
    assert.equal(refusal?.clientRequestId, 'send_mf3k2_a1b2c3');
    assert.equal(refusal?.seq, undefined);
  });
});

/**
 * A gateway whose turn waits until the test lets it go (`failTurn`), as one
 * held for a loop's fire does, then fails at the hand-over.
 */
function createGatewayWaitingForFire() {
  let failTurn = () => {};
  const fireOver = new Promise<void>((resolve) => { failTurn = resolve; });
  const gateway = createGateway(cronJobsAlone, async (writer) => {
    await fireOver;
    await failAtHandOver(writer);
  });
  return { ...gateway, failTurn };
}

/** Another socket of the same user, which subscribes to the session. */
function subscribeAnotherSocket(runtime: ProviderRuntimeGateway) {
  const other = createFakeSocket();
  handleChatConnection(other as never, { user: { id: 1 } } as never, { runtime });
  other.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 0 }] }));
  return other;
}

const kindsBesidesRunEnded = (frames: Frame[]) => frames
  .filter((frame) => frame.kind !== 'run_ended')
  .map((frame) => [frame.kind, frame.code ?? null]);

test('a refusal after the run reaches the socket a page reconnected with while the turn waited for the fire', async () => {
  const { runtime, failTurn } = createGatewayWaitingForFire();
  await withChat(runtime, async ({ socket }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: 'and now the docs',
      options: { effort: 'max', keepBackgroundWork: true },
      clientRequestId: 'send_mf3k2_a1b2c3',
    }));
    await settle();
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), true, 'the turn waits for the fire');

    // The page's socket drops, and the page subscribes again on a new one.
    socket.readyState = 3;
    socket.emit('close');
    const framesBeforeClose = socket.frames.length;
    const reconnected = subscribeAnotherSocket(runtime);
    await settle();

    failTurn();
    await settle();

    assert.equal(socket.frames.length, framesBeforeClose, 'nothing is sent on the closed socket');
    assert.deepEqual(
      kindsBesidesRunEnded(reconnected.frames),
      [['chat_subscribed', null], ['error', 'HAND_OVER_FAILED'], ['complete', null], ['send_refused', null]],
      'the new socket hears the run end and then the refusal',
    );
    const refusal = reconnected.frames.find((frame) => frame.kind === 'send_refused');
    assert.equal(refusal?.sessionId, SESSION_ID);
    assert.equal(refusal?.reason, 'HAND_OVER_FAILED');
    assert.deepEqual(refusal?.changes, ['effort']);
    assert.equal(refusal?.content, 'and now the docs');
    assert.equal(refusal?.clientRequestId, 'send_mf3k2_a1b2c3');
    assert.equal(refusal?.seq, undefined, 'outside the run\'s stream');
    assert.deepEqual(
      chatRunRegistry.replayEvents(SESSION_ID, 0).map((event) => event.kind),
      ['error', 'complete'],
      'and not in its replay buffer',
    );
  });
});

test('a refusal after the run goes to every socket watching it once, and to the asking socket alone for a send without a clientRequestId', async () => {
  const withId = createGatewayWaitingForFire();
  await withChat(withId.runtime, async ({ socket }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: 'and now the docs',
      options: { effort: 'max', keepBackgroundWork: true },
      clientRequestId: 'send_mf3k2_a1b2c3',
    }));
    await settle();
    const otherTab = subscribeAnotherSocket(withId.runtime);
    await settle();
    withId.failTurn();
    await settle();

    // The other page has no send by this id and leaves it alone.
    assert.equal(socket.frames.filter((frame) => frame.kind === 'send_refused').length, 1);
    assert.equal(otherTab.frames.filter((frame) => frame.kind === 'send_refused').length, 1);
  });

  // Without an id any page would take the refusal for its own latest send.
  const withoutId = createGatewayWaitingForFire();
  await withChat(withoutId.runtime, async ({ socket }) => {
    send(socket, { effort: 'max', keepBackgroundWork: true });
    await settle();
    const otherTab = subscribeAnotherSocket(withoutId.runtime);
    await settle();
    withoutId.failTurn();
    await settle();

    assert.equal(socket.frames.filter((frame) => frame.kind === 'send_refused').length, 1);
    assert.equal(otherTab.frames.some((frame) => frame.kind === 'complete'), true, 'the other page watched the run');
    assert.equal(otherTab.frames.some((frame) => frame.kind === 'send_refused'), false);
  });
});

test('a run that fails otherwise, or a send made without the flag, gets no refusal after its run', async () => {
  let turn: (writer: ProviderRuntimeWriter) => Promise<void> = async () => {
    throw new Error('CLI exited');
  };
  const { runtime, runs } = createGateway(cronJobsAlone, (writer) => turn(writer));
  await withChat(runtime, async ({ socket }) => {
    send(socket, { effort: 'max', keepBackgroundWork: true });
    await settle();
    turn = failAtHandOver;
    send(socket, { effort: 'max' });
    await settle();

    assert.equal(runs.length, 2);
    assert.equal(socket.frames.some((frame) => frame.kind === 'send_refused'), false);
  });
});

// The page that sent the message may have no socket on the run when its turn
// fails: offline (asleep, network gone), or showing another session when it
// reconnected, which subscribes only the session shown. The refusal is kept
// and goes with the session's next subscribes.

test('a refusal after the run that found no open socket reaches the page once it subscribes to the session again, after the ack, and with every later subscribe', async () => {
  const { runtime, failTurn } = createGatewayWaitingForFire();
  await withChat(runtime, async ({ socket }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: 'and now the docs',
      options: { effort: 'max', keepBackgroundWork: true },
      clientRequestId: 'send_mf3k2_a1b2c3',
    }));
    await settle();

    // The page goes offline while the turn waits, and the turn fails with no
    // socket watching it.
    socket.readyState = 3;
    socket.emit('close');
    const framesBeforeClose = socket.frames.length;
    failTurn();
    await settle();
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false, 'the run is over');
    assert.equal(socket.frames.length, framesBeforeClose, 'nothing is sent on the closed socket');

    // Back online, or back on the session, the page subscribes to it.
    const back = subscribeAnotherSocket(runtime);
    await settle();
    assert.deepEqual(
      kindsBesidesRunEnded(back.frames),
      [['chat_subscribed', null], ['send_refused', null]],
      'the ack, then the refusal, and no replay of the run that is over',
    );
    assert.equal(back.frames[0]?.isProcessing, false);
    const refusal = back.frames[1];
    assert.equal(refusal?.sessionId, SESSION_ID);
    assert.equal(refusal?.reason, 'HAND_OVER_FAILED');
    assert.deepEqual(refusal?.changes, ['effort']);
    assert.equal(refusal?.content, 'and now the docs');
    assert.equal(refusal?.clientRequestId, 'send_mf3k2_a1b2c3');
    assert.equal(refusal?.seq, undefined);

    // Every later subscribe gets the same refusal again; the composer that
    // made the send acts on it once.
    back.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 2 }] }));
    await settle();
    const refusals = back.frames.filter((frame) => frame.kind === 'send_refused');
    assert.equal(refusals.length, 2);
    assert.equal(refusals[1]?.id, refusal?.id);

    // Another session's subscribe gets none of it.
    back.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: 'other-session', lastSeq: 0 }] }));
    await settle();
    assert.equal(back.frames.filter((frame) => frame.kind === 'send_refused').length, 2);

    // Nor does another user's subscribe to the session.
    const stranger = createFakeSocket();
    handleChatConnection(stranger as never, { user: { id: 2 } } as never, { runtime });
    stranger.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 0 }] }));
    await settle();
    assert.deepEqual(kindsBesidesRunEnded(stranger.frames), [['chat_subscribed', null]]);
  });
});

test('a kept refusal outlives a newer run in the session\'s slot; a refusal without a clientRequestId, or no refusal, is never kept', async () => {
  let turn: (writer: ProviderRuntimeWriter) => Promise<void> = failAtHandOver;
  const { runtime, runs } = createGateway(cronJobsAlone, (writer) => turn(writer));
  await withChat(runtime, async ({ socket }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: 'and now the docs',
      options: { effort: 'max', keepBackgroundWork: true },
      clientRequestId: 'send_mf3k2_a1b2c3',
    }));
    await settle();
    // Another page's message runs in the session meanwhile.
    turn = async (writer) => {
      writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode: 0 });
    };
    send(socket, { effort: 'max' });
    await settle();
    assert.equal(runs.length, 2);

    const later = subscribeAnotherSocket(runtime);
    await settle();
    assert.deepEqual(
      later.frames.filter((frame) => frame.kind === 'send_refused').map((frame) => frame.clientRequestId),
      ['send_mf3k2_a1b2c3'],
    );
  });

  turn = failAtHandOver;
  const second = createGateway(cronJobsAlone, (writer) => turn(writer));
  await withChat(second.runtime, async ({ socket }) => {
    // A refusal without an id, which any page would take for its own.
    send(socket, { effort: 'max', keepBackgroundWork: true });
    await settle();
    assert.equal(socket.frames.filter((frame) => frame.kind === 'send_refused').length, 1, 'the asking socket heard it');
    // A send without the flag, failed the same way, is refused nowhere.
    send(socket, { effort: 'max' });
    await settle();
    assert.equal(second.runs.length, 2);

    const later = subscribeAnotherSocket(second.runtime);
    await settle();
    assert.deepEqual(kindsBesidesRunEnded(later.frames), [['chat_subscribed', null]]);
    assert.equal(chatRunRegistry.listSendRefusals(SESSION_ID, 1).length, 0);
  });
});

// `acceptProcessSettings` lets a turn into a process held only for scheduled
// work on that process's own effort, ultracode and tool rules. Only the
// scheduled-messages dispatcher decides that, once its plan says so; a
// client that sends it has it dropped (see buildTurnRunOptions).

test('a send that carries acceptProcessSettings runs without it', async () => {
  const { runtime, runs } = createGateway(async () => ({ heldWork: true, canHandOver: false, changes: ['effort'], switches: [] }));
  await withChat(runtime, async ({ socket }) => {
    send(socket, { effort: 'max', acceptProcessSettings: true });
    await settle();

    assert.equal(runs.length, 1);
    assert.equal('acceptProcessSettings' in (runs[0]?.options ?? {}), false);
    assert.equal(runs[0]?.options.effort, 'max', 'at the effort the user picked');
  });
});

test('a send that asks to keep the background work is planned without acceptProcessSettings, and refused when only that would let its turn in', async () => {
  // Lets the turn in on the process's own effort only when asked to.
  const { runtime, plans, runs } = createGateway(async (options) => (
    options.acceptProcessSettings === true
      ? { heldWork: true, canHandOver: true, changes: [], switches: [] }
      : { heldWork: true, canHandOver: false, changes: ['effort'], switches: [] }
  ));
  await withChat(runtime, async ({ socket }) => {
    send(socket, { effort: 'max', keepBackgroundWork: true, acceptProcessSettings: true });
    await settle();

    assert.equal(plans.length, 1);
    assert.equal('acceptProcessSettings' in (plans[0] ?? {}), false);
    assert.equal(runs.length, 0);
    assert.equal(JSON.stringify(socket.frames.map((frame) => [frame.kind, frame.changes])), JSON.stringify([['send_refused', ['effort']]]));
  });
});
