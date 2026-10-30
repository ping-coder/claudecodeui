import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type {
  AnyRecord,
  ProviderHandOverPlan,
  ProviderHandOverPlanOptions,
  ProviderRuntimeWriter,
  ScheduledWorkStopResult,
  ScheduledWorkSummary,
} from '@/shared/types.js';

const SESSION_ID = 'held-session';

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

type StopCall = { provider: string; sessionId: string; taskId: string };

/**
 * A gateway whose runtime knows exactly one background task. There is no chat
 * run in progress: the turn that launched the task has ended, which is the
 * state a stop request arrives in.
 */
async function withGateway(
  knownTaskId: string,
  runTest: (context: {
    socket: ReturnType<typeof createFakeSocket>;
    stops: StopCall[];
  }) => Promise<void>,
): Promise<void> {
  await withSession(async () => {
    const stops: StopCall[] = [];
    const socket = createFakeSocket();

    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: {
          stopBackgroundTask: async (provider: string, sessionId: string, taskId: string) => {
            stops.push({ provider, sessionId, taskId });
            return taskId === knownTaskId;
          },
        } as never,
      },
    );

    await runTest({ socket, stops });
  });
}

/** Runs a test against a fresh database holding the one session, whose project is `projectPath`. */
async function withSession(runTest: (projectPath: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-stop-task-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);
    await runTest(tempDirectory);
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

test('chat.stop-task stops the task through the session\'s provider runtime', async () => {
  await withGateway('task-1', async ({ socket, stops }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: 'task-1' }));
    await settle();

    // The provider comes from the session row, never from the frame.
    assert.deepEqual(stops, [{ provider: 'claude', sessionId: SESSION_ID, taskId: 'task-1' }]);
    // The runtime reports the stop on the session's stream; nothing is echoed here.
    assert.deepEqual(socket.frames, []);
  });
});

test('a task the runtime is not tracking is refused with NO_SUCH_TASK', async () => {
  await withGateway('task-1', async ({ socket, stops }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: 'already-settled' }));
    await settle();

    assert.equal(stops.length, 1);
    assert.equal(socket.frames.length, 1);
    assert.equal(socket.frames[0].kind, 'protocol_error');
    assert.equal(socket.frames[0].code, 'NO_SUCH_TASK');
    assert.equal(socket.frames[0].sessionId, SESSION_ID);
  });
});

test('a stop without a task id never reaches the runtime', async () => {
  await withGateway('task-1', async ({ socket, stops }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID }));
    await settle();

    assert.equal(stops.length, 0);
    assert.equal(socket.frames.at(-1)?.code, 'TASK_ID_REQUIRED');
  });
});

test('a stop for a session that does not exist is refused', async () => {
  await withGateway('task-1', async ({ socket, stops }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: 'no-such-session', taskId: 'task-1' }));
    await settle();

    assert.equal(stops.length, 0);
    assert.equal(socket.frames.at(-1)?.code, 'SESSION_NOT_FOUND');
  });
});

type ScheduledStopCall = { provider: string; sessionId: string; id: string; options: unknown };
type TurnRun = { command: string; options: AnyRecord; userId: unknown };
type HeldWriter = ProviderRuntimeWriter & { sendComplete(opts: { exitCode: number }): void };

const CRON_ID = 'cron:b2148320';
const WAKEUP_ID = 'wakeup:toolu_01Wake';

/** One piece of the session's scheduled work, as the runtime lists it. */
const scheduledItem = (id: string): ScheduledWorkSummary => ({
  id,
  kind: id.startsWith('cron:') ? 'cron' : 'wakeup',
  toolUseId: `toolu_${id.replace(/\W/g, '')}`,
  prompt: 'check CI',
  startedAt: 1_000,
  nextFireAt: 61_000,
  recurring: true,
  holdUntil: 9_000_000,
});

/**
 * A gateway whose runtime answers a stop of scheduled work with `stop`
 * (recorded in `stops`), plans a turn with `plan` (recorded in `plans`), and
 * runs a turn as `turn` says, recording it in `runs`; by default the turn
 * ends at once. `listed` is the session's scheduled work as the runtime
 * lists it at the time. Nothing else is held, and no other method is called.
 */
function createScheduledWorkGateway(answers: {
  stop: (call: ScheduledStopCall) => Promise<ScheduledWorkStopResult>;
  plan?: () => Promise<ProviderHandOverPlan>;
  listed?: () => ScheduledWorkSummary[];
  turn?: (writer: HeldWriter) => Promise<void>;
}) {
  const stops: ScheduledStopCall[] = [];
  const plans: Array<{ options: AnyRecord; planOptions: ProviderHandOverPlanOptions | undefined }> = [];
  const runs: TurnRun[] = [];
  const runtime: ProviderRuntimeGateway = {
    hasRuntime: () => true,
    run: async (_provider, command, options, writer) => {
      runs.push({ command, options, userId: (writer as unknown as { userId: unknown }).userId });
      const held = writer as HeldWriter;
      await (answers.turn ? answers.turn(held) : Promise.resolve(held.sendComplete({ exitCode: 0 })));
    },
    abort: async () => false,
    stopBackgroundTask: async () => false,
    hasBackgroundWork: () => false,
    hasScheduledWork: () => (answers.listed?.() ?? []).length > 0,
    listScheduledWork: () => answers.listed?.() ?? [],
    stopScheduledWork: async (provider, sessionId, id, options) => {
      const call = { provider, sessionId, id, options };
      stops.push(call);
      return answers.stop(call);
    },
    resolveToolApproval: () => {},
    getPendingApprovalsForSession: () => [],
    insert: async () => ({ accepted: false, reason: 'NO_ACTIVE_RUN' }),
    cancelInsert: async () => ({ status: 'not_found' }),
    planHandOver: async (_provider, _sessionId, options, planOptions) => {
      plans.push({ options, planOptions });
      return answers.plan ? answers.plan() : { heldWork: true, canHandOver: true, changes: [], switches: [] };
    },
  };
  return { runtime, stops, plans, runs };
}

/** Connects a chat socket, as user 7, to `runtime`. */
function connect(runtime: ProviderRuntimeGateway) {
  const socket = createFakeSocket();
  handleChatConnection(socket as never, { user: { id: 7 } } as never, { runtime });
  return socket;
}

const stopStatuses = (socket: ReturnType<typeof createFakeSocket>) =>
  socket.frames.filter((frame) => frame.kind === 'stop_task_status');

/** The message of the turn that cancels the job, as the runtime words it. */
const CANCEL_CONTENT = 'Cancel scheduled job b2148320 now: call CronDelete with id "b2148320". Do nothing else, and reply in one short sentence.';

/** The runtime's answer for a job of a process held in plan mode: a turn, run in the default mode. */
const CANCEL_TURN: ScheduledWorkStopResult = {
  status: 'turn',
  content: CANCEL_CONTENT,
  options: { inheritUnset: true, permissionMode: 'default', restoreSwitchesAfterTurn: true },
  targetIds: [CRON_ID],
};

test('a stop of scheduled work while a turn is under way answers busy, asks the runtime nothing and reports no protocol error', async () => {
  await withSession(async () => {
    const { runtime, stops } = createScheduledWorkGateway({ stop: async () => ({ status: 'stopped' }) });
    const socket = connect(runtime);
    const run = chatRunRegistry.startRun({
      appSessionId: SESSION_ID, provider: 'claude', providerSessionId: null, connection: null, userId: 7,
    });
    assert.ok(run);

    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: CRON_ID }));
    await settle();

    assert.deepEqual(stops, []);
    assert.deepEqual(stopStatuses(socket).map((frame) => [frame.sessionId, frame.taskId, frame.status]), [[SESSION_ID, CRON_ID, 'busy']]);
    assert.equal(socket.frames.some((frame) => frame.kind === 'protocol_error'), false);
    assert.equal('seq' in (stopStatuses(socket)[0] ?? {}), false, 'only the asking socket hears it, outside any run');
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), true, 'the turn under way goes on');
  });
});

test('a stop the runtime makes by letting go of its process, or for work it does not hold, is answered as the runtime said, and starts no turn', async () => {
  await withSession(async () => {
    const answers: Record<string, ScheduledWorkStopResult> = {
      [WAKEUP_ID]: { status: 'stopped' },
      'cron:00000000': { status: 'not_found' },
      'wakeup:still-first-turn': { status: 'busy' },
    };
    const { runtime, stops, runs, plans } = createScheduledWorkGateway({ stop: async (call) => answers[call.id] });
    const socket = connect(runtime);

    for (const taskId of Object.keys(answers)) {
      socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId }));
    }
    await settle();

    // The provider comes from the session row; `all` only when asked.
    assert.deepEqual(stops, Object.keys(answers).map((id) => ({ provider: 'claude', sessionId: SESSION_ID, id, options: { all: false } })));
    assert.deepEqual(
      stopStatuses(socket).map((frame) => [frame.taskId, frame.status, 'stillHeld' in frame]),
      [[WAKEUP_ID, 'stopped', false], ['cron:00000000', 'not_found', false], ['wakeup:still-first-turn', 'busy', false]],
    );
    assert.deepEqual(runs, []);
    assert.deepEqual(plans, []);
    assert.equal(socket.frames.some((frame) => frame.kind === 'protocol_error'), false);
  });
});

test('allScheduled asks the runtime to stop all of the session\'s scheduled work', async () => {
  await withSession(async () => {
    const { runtime, stops } = createScheduledWorkGateway({ stop: async () => ({ status: 'stopped' }) });
    const socket = connect(runtime);

    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: WAKEUP_ID, allScheduled: true }));
    await settle();

    assert.deepEqual(stops.map((call) => call.options), [{ all: true }]);
    assert.deepEqual(stopStatuses(socket).map((frame) => frame.status), ['stopped']);
  });
});

test('a stop that needs a turn runs it with the runtime\'s content and options as the asking user, answers started, then finished once it is over, saying whether the work is still held', async () => {
  for (const cancelled of [true, false]) {
    await withSession(async (projectPath) => {
      let listed = [scheduledItem(CRON_ID), scheduledItem(WAKEUP_ID)];
      const frameKindsWhenTurnRan: string[] = [];
      const { runtime, runs, plans } = createScheduledWorkGateway({
        stop: async () => CANCEL_TURN,
        listed: () => listed,
        turn: async (writer) => {
          frameKindsWhenTurnRan.push(...stopStatuses(socket).map((frame) => String(frame.status)));
          if (cancelled) {
            // The model called CronDelete; the runtime no longer lists the job.
            listed = listed.filter((item) => item.id !== CRON_ID);
          }
          writer.sendComplete({ exitCode: 0 });
        },
      });
      const socket = connect(runtime);

      socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: CRON_ID }));
      await settle();

      // Planned as the turn's run sees it, with unset settings the process's own.
      assert.equal(plans.length, 1);
      assert.deepEqual(plans[0].planOptions, { inheritUnset: true });
      assert.equal(plans[0].options.permissionMode, 'default');
      assert.equal(plans[0].options.restoreSwitchesAfterTurn, true);
      assert.equal(plans[0].options.cwd, projectPath);
      // Run as the runtime asked, for the user who asked.
      assert.equal(runs.length, 1);
      assert.equal(runs[0].command, CANCEL_CONTENT);
      assert.equal(runs[0].options.inheritUnset, true);
      assert.equal(runs[0].options.permissionMode, 'default');
      assert.equal(runs[0].options.restoreSwitchesAfterTurn, true);
      assert.equal(runs[0].userId, 7);
      assert.deepEqual(frameKindsWhenTurnRan, ['started'], 'started goes out before the turn runs');
      assert.deepEqual(
        stopStatuses(socket).map((frame) => [frame.taskId, frame.status, frame.stillHeld]),
        [[CRON_ID, 'started', undefined], [CRON_ID, 'finished', !cancelled]],
      );
      assert.equal(socket.frames.some((frame) => frame.kind === 'protocol_error'), false);
    });
  }
});

test('a cancelling turn that would need a process of its own while the held one runs other work is not started, and the stop fails', async () => {
  await withSession(async () => {
    const { runtime, runs } = createScheduledWorkGateway({
      stop: async () => CANCEL_TURN,
      plan: async () => ({ heldWork: true, canHandOver: false, changes: ['lookup'], switches: [] }),
    });
    const socket = connect(runtime);

    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: CRON_ID }));
    await settle();

    assert.deepEqual(runs, []);
    assert.deepEqual(stopStatuses(socket).map((frame) => frame.status), ['failed']);
    assert.equal(chatRunRegistry.getRun(SESSION_ID), undefined, 'no run was registered');
  });
});

test('a cancelling turn whose plan the runtime fails to make, or whose stop the runtime fails to work out, is not started, and the stop fails', async () => {
  await withSession(async () => {
    const failingPlan = createScheduledWorkGateway({
      stop: async () => CANCEL_TURN,
      plan: async () => {
        throw new Error('the runtime could not plan');
      },
    });
    const failingStop = createScheduledWorkGateway({
      stop: async () => {
        throw new Error('the runtime could not stop');
      },
    });

    for (const { runtime, runs } of [failingPlan, failingStop]) {
      const socket = connect(runtime);
      socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: CRON_ID }));
      await settle();
      assert.deepEqual(runs, []);
      assert.deepEqual(stopStatuses(socket).map((frame) => frame.status), ['failed']);
      assert.equal(socket.frames.some((frame) => frame.kind === 'protocol_error'), false);
    }
  });
});

test('a cancelling turn for a session whose process has gone starts a new one, as nothing is held', async () => {
  await withSession(async () => {
    const { runtime, runs } = createScheduledWorkGateway({
      stop: async () => ({ ...CANCEL_TURN, options: {} }),
      plan: async () => ({ heldWork: false, canHandOver: false, changes: [], switches: [] }),
    });
    const socket = connect(runtime);

    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: CRON_ID }));
    await settle();

    assert.equal(runs.length, 1);
    assert.deepEqual(stopStatuses(socket).map((frame) => [frame.status, frame.stillHeld]), [['started', undefined], ['finished', false]]);
  });
});

test('a cancelling turn that a run started meanwhile keeps from starting answers busy, and never started or finished', async () => {
  await withSession(async () => {
    const { runtime, runs } = createScheduledWorkGateway({
      stop: async () => CANCEL_TURN,
      plan: async () => {
        // The user's send reserves the session while the runtime plans.
        chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider: 'claude', providerSessionId: null, connection: null, userId: 7 });
        return { heldWork: true, canHandOver: true, changes: [], switches: [] };
      },
    });
    const socket = connect(runtime);

    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: CRON_ID }));
    await settle();

    assert.deepEqual(runs, []);
    assert.deepEqual(stopStatuses(socket).map((frame) => frame.status), ['busy']);
  });
});

test('a stop of scheduled work for a session that does not exist answers not_found, not a protocol error', async () => {
  await withSession(async () => {
    const { runtime, stops } = createScheduledWorkGateway({ stop: async () => ({ status: 'stopped' }) });
    const socket = connect(runtime);

    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: 'no-such-session', taskId: WAKEUP_ID }));
    await settle();

    assert.deepEqual(stops, []);
    assert.deepEqual(stopStatuses(socket).map((frame) => [frame.sessionId, frame.status]), [['no-such-session', 'not_found']]);
    assert.equal(socket.frames.some((frame) => frame.kind === 'protocol_error'), false);
  });
});

test('a task id that names no scheduled work still goes to stopBackgroundTask, refused with NO_SUCH_TASK', async () => {
  await withSession(async () => {
    const { runtime, stops } = createScheduledWorkGateway({ stop: async () => ({ status: 'stopped' }) });
    const socket = connect(runtime);

    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: 'crontab-like-task' }));
    await settle();

    assert.deepEqual(stops, []);
    assert.deepEqual(stopStatuses(socket), []);
    assert.equal(socket.frames.at(-1)?.code, 'NO_SUCH_TASK');
  });
});

/** The kinds of the frames a socket got, leaving out the stop's own answers and what every tab gets. */
const runFrameKinds = (socket: ReturnType<typeof createFakeSocket>) => socket.frames
  .filter((frame) => !['stop_task_status', 'run_ended', 'chat_subscribed'].includes(String(frame.kind)))
  .map((frame) => String(frame.kind));

test('the cancelling turn, handed to the held process, reaches the asking socket and every socket that watched the process, and so does the work that process goes on with', async () => {
  await withSession(async () => {
    // Two loops; the turn that set them up has ended, its process held for them.
    let listed = [scheduledItem(CRON_ID), scheduledItem('cron:0b0b0b0b')];
    const heldRun = chatRunRegistry.startRun({
      appSessionId: SESSION_ID, provider: 'claude', providerSessionId: null, connection: null, userId: 7,
    });
    assert.ok(heldRun);
    heldRun.writer.sendComplete({ exitCode: 0 });
    const { runtime } = createScheduledWorkGateway({
      stop: async () => CANCEL_TURN,
      listed: () => listed,
      turn: async (writer) => {
        // As Claude's runtime hands a turn to the process it holds: the run
        // the process ran last hears it first, then the turn writes.
        heldRun.writer.reportProcessHandedOver();
        writer.send({ kind: 'text', provider: 'claude', sessionId: 'native', content: 'Cancelled job b2148320.' });
        listed = listed.filter((item) => item.id !== CRON_ID);
        writer.sendComplete({ exitCode: 0 });
      },
    });
    // Another tab opened the session while the loops were held.
    const otherTab = connect(runtime);
    otherTab.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 0 }] }));
    const asker = connect(runtime);

    asker.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: CRON_ID }));
    await settle();
    // The other loop fires and asks for a tool, through the writer the process writes to now.
    chatRunRegistry.getRun(SESSION_ID)?.writer.send({
      kind: 'permission_request', provider: 'claude', sessionId: 'native', requestId: 'req-b', toolName: 'Bash',
    });

    assert.deepEqual(stopStatuses(asker).map((frame) => [frame.status, frame.stillHeld]), [['started', undefined], ['finished', false]]);
    assert.deepEqual(runFrameKinds(asker), ['text', 'complete', 'permission_request']);
    assert.deepEqual(runFrameKinds(otherTab), ['text', 'complete', 'permission_request']);
  });
});

test('the cancelling turn of a session whose process has gone reaches the asking socket from its first frame', async () => {
  await withSession(async () => {
    const { runtime } = createScheduledWorkGateway({
      stop: async () => ({ ...CANCEL_TURN, options: {} }),
      plan: async () => ({ heldWork: false, canHandOver: false, changes: [], switches: [] }),
      turn: async (writer) => {
        writer.send({ kind: 'text', provider: 'claude', sessionId: 'native', content: 'Cancelled job b2148320.' });
        writer.sendComplete({ exitCode: 0 });
      },
    });
    const asker = connect(runtime);

    asker.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: CRON_ID }));
    await settle();

    assert.deepEqual(asker.frames.map((frame) => [String(frame.kind), frame.status ?? frame.seq]), [
      ['stop_task_status', 'started'],
      ['text', 1],
      ['complete', 2],
      ['run_ended', undefined],
      ['stop_task_status', 'finished'],
    ]);
  });
});

test('every answer to a stop of scheduled work carries back the stop\'s clientRequestId, and only a well-formed one', async () => {
  await withSession(async () => {
    const answers: Record<string, ScheduledWorkStopResult> = {
      [WAKEUP_ID]: { status: 'stopped' },
      'cron:00000000': { status: 'not_found' },
      'wakeup:still-first-turn': { status: 'busy' },
      [CRON_ID]: CANCEL_TURN,
    };
    const { runtime } = createScheduledWorkGateway({ stop: async (call) => answers[call.id] });
    const socket = connect(runtime);
    const requestIdOf = (taskId: string) => `stop_${taskId.replace(/\W/g, '_')}`;

    for (const taskId of Object.keys(answers)) {
      socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId, clientRequestId: requestIdOf(taskId) }));
      await settle();
    }

    assert.deepEqual(stopStatuses(socket).map((frame) => [frame.status, frame.clientRequestId === requestIdOf(String(frame.taskId))]), [
      ['stopped', true],
      ['not_found', true],
      ['busy', true],
      ['started', true],
      ['finished', true],
    ]);
  });

  await withSession(async () => {
    // A turn under way, a session that does not exist, and a turn the plan says would stop other work.
    const failing = createScheduledWorkGateway({
      stop: async () => CANCEL_TURN,
      plan: async () => ({ heldWork: true, canHandOver: false, changes: ['effort'], switches: [] }),
    });
    const socket = connect(failing.runtime);
    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: CRON_ID, clientRequestId: 'stop_failed' }));
    await settle();
    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: 'no-such-session', taskId: CRON_ID, clientRequestId: 'stop_gone' }));
    await settle();
    chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider: 'claude', providerSessionId: null, connection: null, userId: 7 });
    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: CRON_ID, clientRequestId: 'stop_busy' }));
    await settle();
    // Out of pattern, or not a string: left out of the answer.
    for (const clientRequestId of ['has space', 'x'.repeat(129), 42]) {
      socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: CRON_ID, clientRequestId }));
      await settle();
    }

    assert.deepEqual(stopStatuses(socket).map((frame) => [frame.status, 'clientRequestId' in frame ? frame.clientRequestId : null]), [
      ['failed', 'stop_failed'],
      ['not_found', 'stop_gone'],
      ['busy', 'stop_busy'],
      ['busy', null],
      ['busy', null],
      ['busy', null],
    ]);
  });
});

test('two stops of one item on a socket that two panes share are told apart: the second, while the first one\'s turn runs, is busy under its own id', async () => {
  await withSession(async () => {
    let listed = [scheduledItem(CRON_ID)];
    let releaseTurn = () => {};
    const { runtime, runs } = createScheduledWorkGateway({
      stop: async () => CANCEL_TURN,
      listed: () => listed,
      turn: async (writer) => {
        await new Promise<void>((resolve) => { releaseTurn = resolve; });
        listed = [];
        writer.sendComplete({ exitCode: 0 });
      },
    });
    const socket = connect(runtime);

    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: CRON_ID, clientRequestId: 'stop_left' }));
    await settle();
    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: CRON_ID, clientRequestId: 'stop_right' }));
    await settle();
    releaseTurn();
    await settle();

    assert.equal(runs.length, 1);
    assert.deepEqual(stopStatuses(socket).map((frame) => [frame.status, frame.clientRequestId]), [
      ['started', 'stop_left'],
      ['busy', 'stop_right'],
      ['finished', 'stop_left'],
    ]);
  });
});

test('a stop that ends the session\'s scheduled work, by letting go of its process or by a turn that cancels it all, asks for a dispatch pass; one that leaves work held does not', async () => {
  for (const [label, answer, cancels, expected] of [
    ['let go', { status: 'stopped' }, false, 1],
    ['cancelled in a turn', CANCEL_TURN, true, 1],
    ['still held after the turn', CANCEL_TURN, false, 0],
    ['nothing held', { status: 'not_found' }, false, 0],
  ] as const) {
    await withSession(async () => {
      let listed = [scheduledItem(CRON_ID)];
      const { runtime } = createScheduledWorkGateway({
        stop: async () => answer as ScheduledWorkStopResult,
        listed: () => listed,
        turn: async (writer) => {
          if (cancels) {
            listed = [];
          }
          writer.sendComplete({ exitCode: 0 });
        },
      });
      const released: string[] = [];
      const socket = createFakeSocket();
      handleChatConnection(socket as never, { user: { id: 7 } } as never, {
        runtime,
        onScheduledWorkReleased: (sessionId) => { released.push(sessionId); },
      });

      socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: CRON_ID, allScheduled: true }));
      await settle();

      assert.deepEqual(released, expected === 1 ? [SESSION_ID] : [], label);
    });
  }
});
