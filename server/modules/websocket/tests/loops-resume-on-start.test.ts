import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, scheduleHoldsDb, sessionsDb } from '@/modules/database/index.js';
import {
  RESUME_LOOPS_STAGGER_MS,
  readResumeOptions,
  resolveResumeLoopsMax,
  resumeHeldLoopsOnStart,
} from '@/modules/websocket/services/loops-resume.service.js';
import type { DetachedTurnRunner } from '@/modules/websocket/services/loops-resume.service.js';
import type { PausedScheduledWork, ScheduleHoldRecord } from '@/shared/types.js';

/**
 * Once started, the server resumes the loops of the sessions it held for
 * scheduled work when it went down (`schedule_holds`), staggered and capped,
 * drops the records with nothing left to resume, and marks those it leaves
 * paused, which later starts do not resume until a process holds them again.
 */

async function withDatabase(runTest: (projectPath: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'loops-resume-on-start-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest(directory);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

const record = (sessionId: string, projectPath: string, extra: Partial<ScheduleHoldRecord> = {}): ScheduleHoldRecord => ({
  sessionId,
  provider: 'claude',
  providerSessionId: `native-${sessionId}`,
  projectPath,
  cwd: projectPath,
  userId: 3,
  runId: `run-${sessionId}`,
  launchOptions: {
    model: 'opus', permissionMode: 'default', effort: null, ultracode: null,
    allowedTools: ['Read'], disallowedTools: [], skipPermissions: false,
  },
  ...extra,
});

type Paused = PausedScheduledWork & { heldHere: boolean };
const paused = (sessionId: string): Paused => ({
  items: [{ id: `cron:${sessionId}`, kind: 'cron', toolUseId: 't', prompt: 'p', startedAt: 1, nextFireAt: 2, recurring: true, holdUntil: 3, paused: true }],
  resumeContent: `resume ${sessionId}`,
  heldElsewhere: false,
  heldHere: false,
});

type TurnOutcome = Parameters<NonNullable<Parameters<DetachedTurnRunner>[0]['onTurnEnded']>>[0]['outcome'];

/**
 * A runner whose turns start, recorded in `turns`, unless the session is in
 * `refused`, and end as `outcomes` says (`done` by default). `endTurns`
 * ends the turns started so far.
 */
function createRunner(refused: string[] = [], outcomes: Record<string, TurnOutcome> = {}) {
  const turns: Array<{ sessionId: string; userId: unknown; content: string; model: unknown }> = [];
  const ends: Array<() => void> = [];
  const runTurn: DetachedTurnRunner = async (input) => {
    if (refused.includes(input.sessionId)) {
      return { started: false, error: 'A run was already in progress for this session.' };
    }
    turns.push({ sessionId: input.sessionId, userId: input.userId, content: input.content, model: input.options?.model });
    input.onStarted?.();
    ends.push(() => input.onTurnEnded?.({ outcome: outcomes[input.sessionId] ?? 'done' }));
    // The run settles once its process lets go, days later.
    return new Promise(() => {});
  };
  const endTurns = () => {
    for (const end of ends.splice(0)) {
      end();
    }
  };
  return { runTurn, turns, endTurns };
}

/** One pass on start over `records`, the records as the server found them at boot (all of them by default). */
const pass = (
  runtime: { describePausedScheduledWork: (sessionId: string) => Promise<Paused> },
  runTurn: DetachedTurnRunner,
  env: Record<string, string> = {},
  records = scheduleHoldsDb.list(),
) => {
  const lines: string[] = [];
  return resumeHeldLoopsOnStart({ records, runtime, runTurn, env, pause: async () => {}, log: (line) => lines.push(line) }).then(() => lines);
};

test('on start the loops of every recorded session are resumed with its settings, a few seconds apart, and what is left to resume decides each record', async () => {
  await withDatabase(async (projectPath) => {
    const sessions = ['s-resume-1', 's-resume-2', 's-nothing', 's-elsewhere', 's-held', 's-gone'];
    for (const sessionId of sessions.filter((id) => id !== 's-gone')) {
      sessionsDb.createAppSession(sessionId, 'claude', projectPath);
    }
    for (const sessionId of sessions) {
      scheduleHoldsDb.save(record(sessionId, projectPath));
    }
    const answers: Record<string, Paused> = {
      's-resume-1': paused('s-resume-1'),
      's-resume-2': paused('s-resume-2'),
      's-nothing': { items: [], resumeContent: null, heldElsewhere: false, heldHere: false },
      's-elsewhere': { items: [], resumeContent: null, heldElsewhere: true, heldHere: false },
      's-held': { items: [], resumeContent: null, heldElsewhere: false, heldHere: true },
    };
    const { runTurn, turns, endTurns } = createRunner();
    const pauses: number[] = [];
    const lines: string[] = [];

    await resumeHeldLoopsOnStart({
      records: scheduleHoldsDb.list(),
      runtime: { describePausedScheduledWork: async (sessionId) => answers[sessionId] },
      runTurn,
      env: {},
      pause: async (ms) => { pauses.push(ms); },
      log: (line) => lines.push(line),
    });

    assert.deepEqual(turns.map((turn) => turn.sessionId).sort(), ['s-resume-1', 's-resume-2']);
    assert.deepEqual(turns.map((turn) => [turn.userId, turn.model]), [[3, 'opus'], [3, 'opus']]);
    assert.deepEqual(turns.map((turn) => turn.content).sort(), ['resume s-resume-1', 'resume s-resume-2']);
    // One wait before each resume after the first.
    assert.deepEqual(pauses, [RESUME_LOOPS_STAGGER_MS]);
    assert.equal(lines.length, sessions.length, 'one line per session');
    // A resumed session's record stays until its turn has finished.
    assert.deepEqual(scheduleHoldsDb.list().map((entry) => entry.sessionId).sort(), ['s-held', 's-resume-1', 's-resume-2']);
    endTurns();
    // The resumed processes record their own holds; a held session's process keeps its record,
    // marked until that process writes it anew.
    assert.deepEqual(scheduleHoldsDb.list().map((entry) => entry.sessionId), ['s-held']);
    assert.equal(scheduleHoldsDb.get('s-held')?.leftPausedAt === null, false);
  });
});

test('the pass on start acts only on the records the server found at boot: one a process of this server wrote since is left to that process', async () => {
  await withDatabase(async (projectPath) => {
    for (const sessionId of ['s-live', 's-ended', 's-new', 's-off', 's-off-live']) {
      sessionsDb.createAppSession(sessionId, 'claude', projectPath);
    }
    scheduleHoldsDb.save(record('s-live', projectPath));
    scheduleHoldsDb.save(record('s-ended', projectPath));
    const atBoot = scheduleHoldsDb.list();
    // Before the pass runs, runs of this server write their own records:
    // s-live's process holds its loops, s-ended's has let them go since, and
    // s-new had no record at boot.
    scheduleHoldsDb.save(record('s-live', projectPath, { runId: 'run-live' }));
    scheduleHoldsDb.save(record('s-ended', projectPath, { runId: 'run-ended-live' }));
    scheduleHoldsDb.save(record('s-new', projectPath, { runId: 'run-new' }));
    const answers: Record<string, Paused> = {
      's-live': { items: [], resumeContent: null, heldElsewhere: false, heldHere: true },
      's-ended': { items: [], resumeContent: null, heldElsewhere: false, heldHere: false },
    };
    const lines = await pass({ describePausedScheduledWork: async (sessionId) => answers[sessionId] }, createRunner().runTurn, {}, atBoot);

    assert.deepEqual(lines.sort(), [
      '[Loops] Session s-ended: nothing left to resume; record removed',
      '[Loops] Session s-live: a process of this server already holds it',
    ]);
    assert.deepEqual(
      scheduleHoldsDb.list().map((entry) => [entry.sessionId, entry.runId, entry.leftPausedAt === null]).sort(),
      [['s-ended', 'run-ended-live', true], ['s-live', 'run-live', true], ['s-new', 'run-new', true]],
      'the records written since boot are neither marked nor removed',
    );

    // The pass turned off leaves paused only the loops recorded at boot.
    scheduleHoldsDb.save(record('s-off', projectPath));
    scheduleHoldsDb.save(record('s-off-live', projectPath));
    const offAtBoot = scheduleHoldsDb.list().filter((entry) => entry.sessionId.startsWith('s-off'));
    scheduleHoldsDb.save(record('s-off-live', projectPath, { runId: 'run-off-live' }));
    await pass({ describePausedScheduledWork: async (sessionId) => paused(sessionId) }, createRunner().runTurn, { CLOUDCLI_RESUME_LOOPS_ON_START: '0' }, offAtBoot);
    assert.equal(scheduleHoldsDb.get('s-off')?.leftPausedAt === null, false);
    assert.equal(scheduleHoldsDb.get('s-off-live')?.leftPausedAt, null);
    assert.equal(scheduleHoldsDb.get('s-new')?.leftPausedAt, null);
  });
});

test('the pass on start resumes no loops from a record a run of this server has written over or removed since boot, before the pass reaches it or while it waits between sessions', async () => {
  await withDatabase(async (projectPath) => {
    const sessions = ['s-first', 's-stopped', 's-rewritten', 's-stopped-meanwhile'];
    for (const sessionId of sessions) {
      sessionsDb.createAppSession(sessionId, 'claude', projectPath);
      scheduleHoldsDb.save(record(sessionId, projectPath));
    }
    const atBoot = scheduleHoldsDb.list().sort((a, b) => sessions.indexOf(a.sessionId) - sessions.indexOf(b.sessionId));
    // Since boot, runs of this server have held the loops of s-stopped and
    // s-rewritten under records of their own: the user has stopped
    // s-stopped's, which removed its record, and s-rewritten's process wrote
    // its own over the one read at boot.
    scheduleHoldsDb.save(record('s-stopped', projectPath, { runId: 'run-stopped-live' }));
    scheduleHoldsDb.removeForRun('s-stopped', 'run-stopped-live');
    scheduleHoldsDb.save(record('s-rewritten', projectPath, { runId: 'run-rewritten-live' }));
    const { runTurn, turns } = createRunner();
    const lines: string[] = [];

    await resumeHeldLoopsOnStart({
      records: atBoot,
      // Every transcript still shows a loop to resume, and no process holds it.
      runtime: { describePausedScheduledWork: async (sessionId) => paused(sessionId) },
      runTurn,
      env: {},
      // s-stopped-meanwhile's loops are resumed from the chat, then stopped,
      // while the pass waits to resume them.
      pause: async () => {
        scheduleHoldsDb.save(record('s-stopped-meanwhile', projectPath, { runId: 'run-meanwhile-live' }));
        scheduleHoldsDb.removeForRun('s-stopped-meanwhile', 'run-meanwhile-live');
      },
      log: (line) => lines.push(line),
    });

    assert.deepEqual(turns.map((turn) => turn.sessionId), ['s-first']);
    assert.deepEqual(lines, [
      '[Loops] Session s-first: resuming 1 loop(s): cron:s-first',
      '[Loops] Session s-stopped: not resumed: a run of this server has rewritten or removed its record since boot',
      '[Loops] Session s-rewritten: not resumed: a run of this server has rewritten or removed its record since boot',
      '[Loops] Session s-stopped-meanwhile: not resumed: a run of this server has rewritten or removed its record since boot',
    ]);
    assert.deepEqual(
      scheduleHoldsDb.list().map((entry) => [entry.sessionId, entry.runId, entry.leftPausedAt === null]).sort(),
      [['s-first', 'run-s-first', true], ['s-rewritten', 'run-rewritten-live', true]],
      'the record written since boot is neither marked nor removed',
    );
  });
});

test('a session whose resuming turn does not start keeps its record, and stays paused at later starts until a process holds it again', async () => {
  await withDatabase(async (projectPath) => {
    sessionsDb.createAppSession('s-refused', 'claude', projectPath);
    scheduleHoldsDb.save(record('s-refused', projectPath));
    const runtime = { describePausedScheduledWork: async (sessionId: string) => paused(sessionId) };
    const refused = createRunner(['s-refused']);
    const lines = await pass(runtime, refused.runTurn);
    assert.deepEqual(refused.turns, []);
    assert.equal(scheduleHoldsDb.get('s-refused')?.runId, 'run-s-refused');
    assert.equal(scheduleHoldsDb.get('s-refused')?.leftPausedAt === null, false);
    assert.deepEqual(lines, ['[Loops] Session s-refused: could not resume its loops (A run was already in progress for this session.); left paused']);

    const later = createRunner();
    assert.deepEqual(await pass(runtime, later.runTurn), ['[Loops] Session s-refused: not resumed: an earlier start left it paused']);
    assert.deepEqual(later.turns, []);
    assert.equal(scheduleHoldsDb.get('s-refused')?.runId, 'run-s-refused', 'kept for a resume from the chat');

    // A process holds the loops again: its record is resumed at the next start.
    scheduleHoldsDb.save(record('s-refused', projectPath, { runId: 'run-held-again' }));
    assert.equal(scheduleHoldsDb.get('s-refused')?.leftPausedAt, null);
    const again = createRunner();
    await pass(runtime, again.runTurn);
    assert.deepEqual(again.turns.map((turn) => turn.sessionId), ['s-refused']);
  });
});

test('a resuming turn that fails, its CLI not starting say, keeps the record for the next start; one the user stops leaves the loops paused', async () => {
  await withDatabase(async (projectPath) => {
    for (const sessionId of ['s-failed', 's-stopped']) {
      sessionsDb.createAppSession(sessionId, 'claude', projectPath);
      scheduleHoldsDb.save(record(sessionId, projectPath));
    }
    const runtime = { describePausedScheduledWork: async (sessionId: string) => paused(sessionId) };
    const first = createRunner([], { 's-failed': 'failed', 's-stopped': 'aborted' });
    await pass(runtime, first.runTurn);
    first.endTurns();
    assert.deepEqual(
      scheduleHoldsDb.list().map((entry) => [entry.sessionId, entry.runId, entry.leftPausedAt === null]).sort(),
      [['s-failed', 'run-s-failed', true], ['s-stopped', 'run-s-stopped', false]],
    );

    const next = createRunner();
    await pass(runtime, next.runTurn);
    assert.deepEqual(next.turns.map((turn) => turn.sessionId), ['s-failed']);
  });
});

test('CLOUDCLI_RESUME_LOOPS_MAX caps the sessions resumed, the rest left paused; CLOUDCLI_RESUME_LOOPS_ON_START=0 resumes none', async () => {
  await withDatabase(async (projectPath) => {
    for (const sessionId of ['s-1', 's-2', 's-3']) {
      sessionsDb.createAppSession(sessionId, 'claude', projectPath);
      scheduleHoldsDb.save(record(sessionId, projectPath));
    }
    const runtime = { describePausedScheduledWork: async (sessionId: string) => paused(sessionId) };

    const off = createRunner();
    const offLines = await pass(runtime, off.runTurn, { CLOUDCLI_RESUME_LOOPS_ON_START: '0' });
    assert.deepEqual(off.turns, []);
    assert.equal(scheduleHoldsDb.list().length, 3);
    assert.deepEqual(offLines, ['[Loops] Not resuming loops on start: CLOUDCLI_RESUME_LOOPS_ON_START=0']);
    // Left paused: turning the pass back on does not resume them.
    const backOn = createRunner();
    await pass(runtime, backOn.runTurn);
    assert.deepEqual(backOn.turns, []);
    assert.equal(scheduleHoldsDb.list().length, 3);

    // Held again, as each process that holds the loops writes its record anew.
    for (const sessionId of ['s-1', 's-2', 's-3']) {
      scheduleHoldsDb.save(record(sessionId, projectPath));
    }
    const capped = createRunner();
    const lines = await pass(runtime, capped.runTurn, { CLOUDCLI_RESUME_LOOPS_MAX: '2' });
    capped.endTurns();
    assert.equal(capped.turns.length, 2);
    assert.equal(scheduleHoldsDb.list().length, 1, 'the one not resumed keeps its record');
    assert.equal(lines.filter((line) => line.includes('CLOUDCLI_RESUME_LOOPS_MAX (2) reached')).length, 1);
    const later = createRunner();
    await pass(runtime, later.runTurn);
    assert.deepEqual(later.turns, [], 'nor does a later start resume it');
  });

  assert.equal(resolveResumeLoopsMax({}), 10);
  assert.equal(resolveResumeLoopsMax({ CLOUDCLI_RESUME_LOOPS_MAX: '0' }), 0);
  assert.equal(resolveResumeLoopsMax({ CLOUDCLI_RESUME_LOOPS_MAX: 'many' }), 10);
});

test('a hold records table made before the left-paused mark gets the column, its rows unmarked', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'loops-resume-migration-'));
  const databasePath = path.join(directory, 'auth.db');
  const before = new Database(databasePath);
  before.exec(`
    CREATE TABLE schedule_holds (
      session_id TEXT PRIMARY KEY NOT NULL, provider TEXT NOT NULL, provider_session_id TEXT, project_path TEXT,
      cwd TEXT, user_id TEXT, run_id TEXT NOT NULL, launch_options TEXT NOT NULL DEFAULT '{}', updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO schedule_holds (session_id, provider, run_id) VALUES ('s-old', 'claude', 'run-old');
  `);
  before.close();
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  try {
    assert.deepEqual([scheduleHoldsDb.get('s-old')?.runId, scheduleHoldsDb.get('s-old')?.leftPausedAt], ['run-old', null]);
    scheduleHoldsDb.markLeftPaused('s-old', 'run-other');
    assert.equal(scheduleHoldsDb.get('s-old')?.leftPausedAt, null, 'only the record the run named wrote');
    scheduleHoldsDb.markLeftPaused('s-old', 'run-old');
    assert.equal(typeof scheduleHoldsDb.get('s-old')?.leftPausedAt, 'string');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('the hold records keep one row per session, and a run removes only its own', async () => {
  await withDatabase(async (projectPath) => {
    scheduleHoldsDb.save(record('s-1', projectPath, { runId: 'run-a' }));
    scheduleHoldsDb.save(record('s-1', projectPath, {
      runId: 'run-b',
      userId: null,
      launchOptions: {
        model: null, permissionMode: 'bypassPermissions', effort: 'xhigh', ultracode: true,
        allowedTools: [], disallowedTools: ['WebFetch'], skipPermissions: true,
      },
    }));
    assert.equal(scheduleHoldsDb.list().length, 1);
    const stored = scheduleHoldsDb.get('s-1');
    assert.deepEqual([stored?.runId, stored?.userId, stored?.launchOptions.permissionMode, stored?.launchOptions.ultracode], ['run-b', null, 'bypassPermissions', true]);
    assert.deepEqual(readResumeOptions(stored), {
      permissionMode: 'bypassPermissions',
      effort: 'xhigh',
      ultracode: true,
      toolsSettings: { allowedTools: [], disallowedTools: ['WebFetch'], skipPermissions: true },
      cwd: projectPath,
    });

    scheduleHoldsDb.removeForRun('s-1', 'run-a');
    assert.equal(scheduleHoldsDb.get('s-1')?.runId, 'run-b', 'an older run does not remove a newer run\'s record');
    scheduleHoldsDb.removeForRun('s-1', 'run-b');
    assert.equal(scheduleHoldsDb.get('s-1'), null);
  });
});
