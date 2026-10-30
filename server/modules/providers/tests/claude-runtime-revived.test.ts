import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, userDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { abortClaudeSDKSession, claudeRuntime, queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext, RevivedCronJob, ScheduleHoldRecord } from '@/shared/types.js';

/**
 * A run that resumes a session starts a CLI that brings the session's cron
 * jobs back from the transcript, with nothing on its stream to say so. The
 * runtime reads them first (`context.readRevivedCronJobs`) and holds the
 * process for them, and records the hold (`context.scheduleHolds`) so a
 * restart of the server can resume the loops. These drive `queryClaudeSDK`
 * with a scripted SDK stream, as claude-runtime-hold.test.ts does.
 */

const NATIVE_ID = 'native-revived-session';

// The run's notifications look its session up: an isolated database of its own.
let databaseDirectory = '';
// The user whose turn left the process held, which the record names.
let userId = 0;
const previousDatabasePath = process.env.DATABASE_PATH;
test.before(async () => {
  databaseDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-revived-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(databaseDirectory, 'auth.db');
  await initializeDatabase();
  userId = Number(userDb.createUser('revived-loops', 'password-hash').id);
});
test.after(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = previousDatabasePath;
  }
  await rm(databaseDirectory, { recursive: true, force: true });
});
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  released: () => boolean;
  created: () => boolean;
  options: () => Record<string, unknown> | null;
};

function createScriptedQuery(): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  let released = false;
  let closed = false;
  let builtWith: Record<string, unknown> | null = null;
  const script: Scripted = {
    emit: (message) => { queue.push(message); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
    released: () => released,
    created: () => builtWith !== null,
    options: () => builtWith,
  };
  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt, options }) => {
    builtWith = options;
    void (async () => {
      for await (const _message of prompt) { /* the CLI reads its stdin */ }
      released = true;
    })();
    const iterator = (async function* () {
      for (;;) {
        if (closed) {
          return;
        }
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const next = queue.shift();
        if (next === null || next === undefined) {
          return;
        }
        yield next;
      }
    })();
    return Object.assign(iterator, {
      interrupt: async () => {},
      stopTask: async () => {},
      close: () => {
        closed = true;
        wake?.();
      },
    });
  };
  return { createQuery, script };
}

async function flush(rounds = 10): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!condition() && performance.now() < deadline) {
    await flush(1);
  }
  assert.equal(condition(), true, 'condition never became true');
}

/** What the run's context recorded of its hold. */
type HoldLog = { saved: ScheduleHoldRecord[]; removed: Array<[string, string]> };

type RevivedRun = {
  script: Scripted;
  sent: NormalizedMessage[];
  done: Promise<unknown>;
  holds: HoldLog;
  reads: Array<{ sessionId: string; anchorId: string | null }>;
};

/** A job a CLI resuming the session now brings back: every five minutes, made an hour ago. */
const revivedJob = (jobId = 'a0000001'): RevivedCronJob => ({
  jobId,
  toolUseId: `toolu_${jobId}`,
  cron: '*/5 * * * *',
  prompt: '<<autonomous-loop>>',
  recurring: true,
  createdAt: Date.now() - HOUR,
  humanSchedule: 'Every 5 minutes',
  predictable: true,
});

async function startRun(
  sessionId: string,
  {
    providerSessionId = NATIVE_ID,
    revived = [revivedJob()],
    options = {},
    holds = { saved: [], removed: [] },
    waitForCli = true,
    read,
  }: {
    providerSessionId?: string | null;
    revived?: RevivedCronJob[];
    options?: Record<string, unknown>;
    holds?: HoldLog;
    waitForCli?: boolean;
    /** How the read of the jobs goes, for one that takes a while; else it returns `revived` at once. */
    read?: () => Promise<RevivedCronJob[]>;
  } = {},
): Promise<RevivedRun & { cleanUp: () => Promise<void> }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-revived-'));
  const { createQuery, script } = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const reads: RevivedRun['reads'] = [];
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => providerSessionId,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, id) => sessions.normalizeMessage(raw, id),
    isProviderInstalled: async () => true,
    readRevivedCronJobs: async (id, { anchorId }) => {
      reads.push({ sessionId: id, anchorId });
      return read ? read() : revived;
    },
    scheduleHolds: {
      save: (record) => { holds.saved.push(structuredClone(record)); },
      remove: (id, runId) => { holds.removed.push([id, runId]); },
    },
    createQuery,
  };
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId };
  const done = queryClaudeSDK('hello', { sessionId, cwd, projectPath: cwd, permissionMode: 'plan', ...options }, writer as never, context);
  if (waitForCli) {
    await waitUntil(() => script.created());
  }
  return {
    script,
    sent,
    done,
    holds,
    reads,
    cleanUp: async () => {
      script.end();
      await done;
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'ok', duration_ms: 1, num_turns: 1 });
const listed = (sessionId: string) => claudeRuntime.listScheduledWork()
  .filter((entry) => entry.sessionId === sessionId)
  .flatMap((entry) => entry.scheduled.map((item) => item.id));

/** The first turn of the run, which ends with the process held for the jobs brought back. */
async function firstTurn(run: RevivedRun): Promise<void> {
  run.script.emit(init());
  run.script.emit(result());
  await waitUntil(() => run.sent.some((message) => message.kind === 'complete'));
  await flush();
}

test('a resumed process holds the cron jobs the CLI brings back, lists them, and records the hold', async () => {
  const sessionId = 'app-revived-held';
  const run = await startRun(sessionId);
  try {
    assert.deepEqual(run.reads, [{ sessionId, anchorId: null }]);
    await firstTurn(run);
    assert.equal(run.script.released(), false, 'held after the first turn');
    assert.deepEqual(listed(sessionId), ['cron:a0000001']);

    assert.equal(run.holds.saved.length, 1);
    const [record] = run.holds.saved;
    assert.deepEqual(
      [record.sessionId, record.provider, record.providerSessionId, record.userId, record.launchOptions.permissionMode],
      [sessionId, 'claude', NATIVE_ID, userId, 'plan'],
    );
    assert.deepEqual(record.launchOptions.allowedTools, [], 'the tools the process allows now: plan mode adds no rule, canUseTool grants its tools');
    assert.equal(typeof record.runId, 'string');

    // A turn of the CLI's own that cancels the job: nothing holds the process
    // any more, which lets go of it, and of the record.
    run.script.emit({
      type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_del', name: 'CronDelete', input: { id: 'a0000001' } }] },
    });
    run.script.emit({
      type: 'user', session_id: NATIVE_ID, parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_del', content: 'Cancelled job a0000001.' }] },
      tool_use_result: { id: 'a0000001' },
    });
    run.script.emit(result());
    await waitUntil(() => run.script.released());
    assert.deepEqual(run.holds.removed, [[sessionId, record.runId]]);
    assert.deepEqual(listed(sessionId), []);
  } finally {
    await run.cleanUp();
  }
});

test('the CLI starts while the jobs it brings back are read; the first turn\'s end waits for them, their times counted from before the CLI started', async () => {
  const sessionId = 'app-revived-slow-read';
  let finishRead: (jobs: RevivedCronJob[]) => void = () => {};
  const reading = new Promise<RevivedCronJob[]>((resolve) => { finishRead = resolve; });
  const before = Date.now();
  const run = await startRun(sessionId, { read: () => reading });
  const startedBy = Date.now();
  try {
    assert.deepEqual(run.reads, [{ sessionId, anchorId: null }]);
    // The CLI's first word comes before the read ends.
    run.script.emit(init());
    run.script.emit(result());
    await flush();
    assert.equal(run.sent.some((message) => message.kind === 'complete'), false, 'the turn\'s end waits for the read');

    await new Promise((resolve) => { setTimeout(resolve, 30); });
    finishRead([revivedJob()]);
    await waitUntil(() => run.sent.some((message) => message.kind === 'complete'));
    await flush();
    assert.equal(run.script.released(), false, 'held for the job brought back');
    assert.deepEqual(listed(sessionId), ['cron:a0000001']);
    assert.equal(run.holds.saved.length, 1);

    // Every five minutes less the cache lead, from the moment the CLI was started.
    const [item] = claudeRuntime.listScheduledWork().find((entry) => entry.sessionId === sessionId)?.scheduled ?? [];
    const countedFrom = (item.nextFireAt as number) - (5 * MINUTE - 15 * 1000);
    assert.equal(countedFrom >= before && countedFrom <= startedBy, true, `counted from ${countedFrom}, CLI started between ${before} and ${startedBy}`);
  } finally {
    await run.cleanUp();
  }
});

test('a run that resumes nothing reads no jobs; one resumed at a row reads the chain up to it', async () => {
  const fresh = await startRun('app-revived-fresh', { providerSessionId: null });
  try {
    assert.deepEqual(fresh.reads, []);
    await firstTurn(fresh);
    assert.equal(fresh.script.released(), true, 'nothing holds a new session\'s process');
    assert.deepEqual(fresh.holds, { saved: [], removed: [] });
  } finally {
    await fresh.cleanUp();
  }

  const edited = await startRun('app-revived-edited', { options: { resumeAnchorId: 'row-12' }, revived: [] });
  try {
    assert.deepEqual(edited.reads, [{ sessionId: 'app-revived-edited', anchorId: 'row-12' }]);
    assert.equal(edited.script.options()?.resumeSessionAt, 'row-12');
  } finally {
    await edited.cleanUp();
  }
});

test('the record of a hold goes when the server lets go: an abort, a newer run, a CLI that ends on its own', async () => {
  const aborted = await startRun('app-revived-aborted');
  try {
    await firstTurn(aborted);
    const [record] = aborted.holds.saved;
    assert.equal(await abortClaudeSDKSession('app-revived-aborted'), true);
    assert.deepEqual(aborted.holds.removed, [['app-revived-aborted', record.runId]]);
  } finally {
    await aborted.cleanUp();
  }

  // A newer run takes the session over: the old run's record goes, and the
  // newer one records its own once it holds the jobs.
  const holds: HoldLog = { saved: [], removed: [] };
  const older = await startRun('app-revived-superseded', { holds });
  await firstTurn(older);
  const newer = await startRun('app-revived-superseded', { holds, options: { resumeAnchorId: 'row-3' }, waitForCli: false });
  try {
    await waitUntil(() => holds.removed.length > 0);
    assert.deepEqual(holds.removed, [['app-revived-superseded', holds.saved[0].runId]]);
    // The retired process exits; the newer run starts its own once it has.
    older.script.end();
    await waitUntil(() => newer.script.created());
    await firstTurn(newer);
    assert.equal(holds.saved.length, 2);
    assert.notEqual(holds.saved[1].runId, holds.saved[0].runId);
  } finally {
    await older.cleanUp();
    await newer.cleanUp();
  }
  assert.deepEqual(holds.removed.map(([, runId]) => runId), [holds.saved[0].runId, holds.saved[1].runId], 'the CLI ending on its own lets go too');
});

// Last: the shutdown flag stays set for the rest of the process.
test('the record of a hold stays when the server shuts down under it', async () => {
  const run = await startRun('app-revived-shutdown');
  await firstTurn(run);
  assert.equal(run.holds.saved.length, 1);
  claudeRuntime.prepareForShutdown();
  await run.cleanUp();
  assert.deepEqual(run.holds.removed, [], 'the next start resumes the loops');
});
