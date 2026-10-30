import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, scheduleHoldsDb, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type {
  AnyRecord,
  PausedScheduledWork,
  ProviderRuntimeWriter,
  ScheduledWorkStopOptions,
  ScheduledWorkSummary,
} from '@/shared/types.js';

/**
 * `chat.resume-loops` resumes the loops a restart of the server left with no
 * process, in a turn the gateway runs with no client attached; `chat.stop-task`
 * stops them in a turn too, naming the paused work to the runtime.
 */

const SESSION_ID = 'paused-session';

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

async function withSession(runTest: (projectPath: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-resume-loops-'));
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

const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

const PAUSED_CRON: ScheduledWorkSummary = {
  id: 'cron:a0000001', kind: 'cron', toolUseId: 'toolu_a', prompt: '/loop', startedAt: 1, nextFireAt: 2, recurring: true, holdUntil: 3, paused: true,
};
const PAUSED_WAKEUP: ScheduledWorkSummary = {
  id: 'wakeup:toolu_w', kind: 'wakeup', toolUseId: 'toolu_w', prompt: '/loop', startedAt: 4, nextFireAt: 5, recurring: true, holdUntil: 6, paused: true,
};
const RESUME_CONTENT = 'CloudCLI restarted. Scheduled job "a0000001" runs again on its own schedule. Do not call any tools. Do nothing else, and reply in one short sentence.';

type Paused = PausedScheduledWork & { heldHere: boolean };
type HeldWriter = ProviderRuntimeWriter & { sendComplete(opts: { exitCode: number }): void };

/** A gateway whose turns end with `exitCode` (1: as a CLI that could not start, which the runtime reports, not throws). */
function createGateway(paused: () => Paused, { exitCode = 0 }: { exitCode?: number } = {}) {
  const runs: Array<{ command: string; options: AnyRecord; userId: unknown }> = [];
  const stops: Array<{ id: string; options: ScheduledWorkStopOptions }> = [];
  const runtime: ProviderRuntimeGateway = {
    hasRuntime: () => true,
    run: async (_provider, command, options, writer) => {
      runs.push({ command, options, userId: (writer as unknown as { userId: unknown }).userId });
      (writer as HeldWriter).sendComplete({ exitCode });
    },
    abort: async () => false,
    stopBackgroundTask: async () => false,
    hasBackgroundWork: () => false,
    hasScheduledWork: () => false,
    listScheduledWork: () => [],
    stopScheduledWork: async (_provider, _sessionId, id, options) => {
      stops.push({ id, options });
      return { status: 'turn', content: 'stop them', options: {}, targetIds: [id] };
    },
    describePausedScheduledWork: async () => paused(),
    resolveToolApproval: () => {},
    getPendingApprovalsForSession: () => [],
    insert: async () => ({ accepted: false, reason: 'NO_ACTIVE_RUN' }),
    cancelInsert: async () => ({ status: 'not_found' }),
    planHandOver: async () => ({ heldWork: false, canHandOver: false, changes: [], switches: [] }),
  };
  const socket = createFakeSocket();
  handleChatConnection(socket as never, { user: { id: 7 } } as never, { runtime });
  return { socket, runs, stops };
}

const pausedNow = (): Paused => ({ items: [PAUSED_CRON, PAUSED_WAKEUP], resumeContent: RESUME_CONTENT, heldElsewhere: false, heldHere: false });
const statuses = (socket: ReturnType<typeof createFakeSocket>) => socket.frames
  .filter((frame) => frame.kind === 'resume_loops_status')
  .map((frame) => [frame.status, frame.clientRequestId]);

test('chat.resume-loops runs the resuming turn with the settings of the session\'s last hold, as the asking user, and lets go of that record', async () => {
  await withSession(async (projectPath) => {
    scheduleHoldsDb.save({
      sessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: 'native-1',
      projectPath,
      cwd: projectPath,
      userId: 7,
      runId: 'run-before-restart',
      launchOptions: {
        model: 'opus', permissionMode: 'plan', effort: 'high', ultracode: false,
        allowedTools: ['Read', 'WebFetch'], disallowedTools: ['Bash(rm:*)'], skipPermissions: false,
      },
    });
    const { socket, runs } = createGateway(pausedNow);

    socket.emit('message', JSON.stringify({
      type: 'chat.resume-loops', sessionId: SESSION_ID, clientRequestId: 'resume_1', options: { model: 'haiku', permissionMode: 'default' },
    }));
    await settle();

    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, RESUME_CONTENT);
    assert.equal(runs[0].userId, 7);
    assert.deepEqual(
      [runs[0].options.model, runs[0].options.permissionMode, runs[0].options.effort, runs[0].options.ultracode, runs[0].options.cwd],
      ['opus', 'plan', 'high', false, projectPath],
      'the record wins over the composer',
    );
    assert.deepEqual(runs[0].options.toolsSettings, { allowedTools: ['Read', 'WebFetch'], disallowedTools: ['Bash(rm:*)'], skipPermissions: false });
    assert.deepEqual(statuses(socket), [['started', 'resume_1'], ['finished', 'resume_1']]);
    assert.equal(scheduleHoldsDb.get(SESSION_ID), null, 'the resumed process records its own hold');
    assert.equal(socket.frames.some((frame) => frame.kind === 'protocol_error'), false);
  });
});

test('a resuming turn that fails, its CLI not starting say, keeps the record of the last hold for the next resume', async () => {
  await withSession(async (projectPath) => {
    scheduleHoldsDb.save({
      sessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: 'native-1',
      projectPath,
      cwd: projectPath,
      userId: 7,
      runId: 'run-before-restart',
      launchOptions: {
        model: 'opus', permissionMode: 'bypassPermissions', effort: null, ultracode: null,
        allowedTools: [], disallowedTools: [], skipPermissions: true,
      },
    });
    const { socket, runs } = createGateway(pausedNow, { exitCode: 1 });
    socket.emit('message', JSON.stringify({ type: 'chat.resume-loops', sessionId: SESSION_ID, clientRequestId: 'resume_1' }));
    await settle();

    assert.equal(runs.length, 1);
    assert.deepEqual(statuses(socket), [['started', 'resume_1'], ['finished', 'resume_1']]);
    assert.equal(scheduleHoldsDb.get(SESSION_ID)?.runId, 'run-before-restart');
  });
});

test('without a record, a resume runs with the composer\'s settings, and nothing else the client sent', async () => {
  await withSession(async () => {
    const { socket, runs } = createGateway(pausedNow);
    socket.emit('message', JSON.stringify({
      type: 'chat.resume-loops',
      sessionId: SESSION_ID,
      options: {
        model: 'sonnet',
        permissionMode: 'acceptEdits',
        toolsSettings: { allowedTools: ['Read'], disallowedTools: [], skipPermissions: false },
        images: [{ path: 'secret.png' }],
        acceptProcessSettings: true,
      },
    }));
    await settle();

    assert.equal(runs.length, 1);
    assert.deepEqual([runs[0].options.model, runs[0].options.permissionMode], ['sonnet', 'acceptEdits']);
    assert.deepEqual(runs[0].options.toolsSettings, { allowedTools: ['Read'], disallowedTools: [], skipPermissions: false });
    assert.deepEqual(runs[0].options.images, []);
    assert.equal(runs[0].options.acceptProcessSettings, undefined);
  });
});

test('a resume with nothing paused, a session another CLI holds, or a turn under way starts nothing', async () => {
  await withSession(async () => {
    let paused: Paused = { items: [], resumeContent: null, heldElsewhere: false, heldHere: true };
    const { socket, runs } = createGateway(() => paused);
    const resume = () => socket.emit('message', JSON.stringify({ type: 'chat.resume-loops', sessionId: SESSION_ID }));

    resume();
    await settle();
    paused = { items: [], resumeContent: null, heldElsewhere: true, heldHere: false };
    resume();
    await settle();
    paused = pausedNow();
    const run = chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider: 'claude', providerSessionId: null, connection: null, userId: 7 });
    assert.ok(run);
    resume();
    await settle();
    socket.emit('message', JSON.stringify({ type: 'chat.resume-loops', sessionId: 'no-such-session' }));
    await settle();

    assert.deepEqual(runs, []);
    assert.deepEqual(statuses(socket).map(([status]) => status), ['not_found', 'held_elsewhere', 'busy', 'not_found']);
  });
});

test('a stop of a paused loop names the paused work to the runtime, which runs the cancelling turn in a new process', async () => {
  await withSession(async () => {
    const { socket, runs, stops } = createGateway(pausedNow);
    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: PAUSED_WAKEUP.id, allScheduled: true }));
    await settle();

    assert.deepEqual(stops, [{ id: PAUSED_WAKEUP.id, options: { all: true, paused: [PAUSED_CRON, PAUSED_WAKEUP] } }]);
    assert.deepEqual(runs.map((run) => run.command), ['stop them']);
    assert.deepEqual(
      socket.frames.filter((frame) => frame.kind === 'stop_task_status').map((frame) => [frame.status, frame.stillHeld]),
      [['started', undefined], ['finished', false]],
    );
  });
});

test('a stop of one paused loop runs with the settings of the session\'s last hold: its process goes on holding the others', async () => {
  await withSession(async (projectPath) => {
    scheduleHoldsDb.save({
      sessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: 'native-1',
      projectPath,
      cwd: projectPath,
      userId: 7,
      runId: 'run-before-restart',
      launchOptions: {
        model: 'opus', permissionMode: 'bypassPermissions', effort: 'high', ultracode: null,
        allowedTools: ['WebFetch'], disallowedTools: [], skipPermissions: true,
      },
    });
    const { socket, runs } = createGateway(pausedNow);
    socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId: PAUSED_CRON.id }));
    await settle();

    assert.equal(runs.length, 1);
    assert.deepEqual(
      [runs[0].options.model, runs[0].options.permissionMode, runs[0].options.effort, runs[0].options.cwd],
      ['opus', 'bypassPermissions', 'high', projectPath],
    );
    assert.deepEqual(runs[0].options.toolsSettings, { allowedTools: ['WebFetch'], disallowedTools: [], skipPermissions: true });
  });
});
