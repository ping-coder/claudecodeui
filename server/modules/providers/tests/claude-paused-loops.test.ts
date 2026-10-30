import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { nextScheduledFire, parseLoopsResumeMessage } from '@/modules/providers/list/claude/claude-scheduled-work.js';
import { createProviderRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import type { IProvider, IProviderRuntime } from '@/shared/interfaces.js';
import type { PausedScheduledWork } from '@/shared/types.js';

/**
 * What a session's transcript says of its loops once no process runs them:
 * the jobs a resumed CLI brings back, read off the chain the resume replays,
 * and a self-paced loop's wake-up that was still to come (the Claude sessions
 * provider); and what the gateway makes of it while a process holds the
 * session, or none does.
 */

const SESSION = 'paused-loops-session';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

async function withTranscript(
  rows: Array<Record<string, unknown>>,
  runTest: (context: { jsonlPath: string }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-paused-loops-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  const jsonlPath = path.join(directory, `${SESSION}.jsonl`);
  await writeFile(jsonlPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  const now = new Date().toISOString();
  sessionsDb.createSession(SESSION, 'claude', directory, 'Paused loops', now, now, jsonlPath);
  try {
    await runTest({ jsonlPath });
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

const base = Date.now() - 3 * HOUR;
let clock = 0;
const row = (uuid: string, parentUuid: string | null, fields: Record<string, unknown>) => ({
  parentUuid,
  isSidechain: false,
  uuid,
  sessionId: SESSION,
  timestamp: new Date(base + (clock += MINUTE)).toISOString(),
  ...fields,
});
const prompt = (uuid: string, parentUuid: string | null, text: string) => row(uuid, parentUuid, { type: 'user', message: { role: 'user', content: text } });
const toolCall = (uuid: string, parentUuid: string, id: string, name: string, input: Record<string, unknown>) => row(uuid, parentUuid, {
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (uuid: string, parentUuid: string, id: string, toolUseResult: Record<string, unknown>) => row(uuid, parentUuid, {
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  toolUseResult,
});
const cronResult = (jobId: string, cron: string) => ({
  id: jobId,
  humanSchedule: cron,
  recurring: true,
  durable: false,
  nextFireAt: nextScheduledFire({ cron, recurring: true, id: jobId, createdAt: Date.now() }),
});

test('the jobs a resume brings back are read off the chain it replays, or up to the row a resume at a row names', async () => {
  const rows = [
    prompt('u1', null, '/loop 5m check'),
    toolCall('a1', 'u1', 'toolu_a', 'CronCreate', { cron: '*/5 * * * *', prompt: 'check' }),
    toolResult('r1', 'a1', 'toolu_a', cronResult('a0000001', '*/5 * * * *')),
    prompt('u2', 'r1', 'one more'),
    toolCall('a2', 'u2', 'toolu_b', 'CronCreate', { cron: '*/10 * * * *', prompt: 'more' }),
    toolResult('r2', 'a2', 'toolu_b', cronResult('b0000002', '*/10 * * * *')),
    // The user edited "one more": the branch the next resume replays.
    prompt('u3', 'r1', 'something else'),
    row('a3', 'u3', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
  ];
  await withTranscript(rows, async ({ jsonlPath }) => {
    const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null, hasLiveCliProcess: async () => false });
    assert.deepEqual((await sessions.readRevivedCronJobs(SESSION)).map((job) => job.jobId), ['a0000001']);
    assert.deepEqual(
      (await sessions.readRevivedCronJobs(SESSION, { anchorId: 'r2' })).map((job) => job.jobId),
      ['a0000001', 'b0000002'],
    );

    // A cancel written since: the file changed, so it is read again.
    await appendFile(jsonlPath, `${[
      toolCall('a4', 'a3', 'toolu_del', 'CronDelete', { id: 'a0000001' }),
      toolResult('r4', 'a4', 'toolu_del', { id: 'a0000001' }),
    ].map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    assert.deepEqual(await sessions.readRevivedCronJobs(SESSION), []);
  });
});

test('a scan parses only what was written since the one before, a line still being written once it is whole, and a file that shrank again from its start', async () => {
  const rows = [
    prompt('u1', null, '/loop 5m check'),
    toolCall('a1', 'u1', 'toolu_a', 'CronCreate', { cron: '*/5 * * * *', prompt: 'check' }),
    toolResult('r1', 'a1', 'toolu_a', cronResult('a0000001', '*/5 * * * *')),
  ];
  const lines = (entries: Array<Record<string, unknown>>) => entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
  await withTranscript(rows, async ({ jsonlPath }) => {
    const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null, hasLiveCliProcess: async () => false });
    const jobIds = async () => (await sessions.readRevivedCronJobs(SESSION)).map((job) => job.jobId);
    assert.deepEqual(await jobIds(), ['a0000001']);

    // The part already read, changed in place: a scan that parsed the whole
    // file again would read the other id.
    const original = await readFile(jsonlPath, 'utf8');
    await writeFile(jsonlPath, original.replaceAll('a0000001', 'f000000f'));
    await appendFile(jsonlPath, lines([
      prompt('u2', 'r1', 'one more'),
      toolCall('a2', 'u2', 'toolu_b', 'CronCreate', { cron: '*/10 * * * *', prompt: 'more' }),
      toolResult('r2', 'a2', 'toolu_b', cronResult('b0000002', '*/10 * * * *')),
    ]));
    // Two scans at once: each goes on from where the one before stopped.
    const [both, paused] = await Promise.all([jobIds(), sessions.readPausedScheduledWork(SESSION)]);
    assert.deepEqual(both, ['a0000001', 'b0000002']);
    assert.deepEqual(paused.items.map((item) => item.id).sort(), ['cron:a0000001', 'cron:b0000002']);

    // A cancel the CLI is still writing counts once its line is whole.
    const cancel = lines([toolCall('a3', 'r2', 'toolu_del', 'CronDelete', { id: 'b0000002' }), toolResult('r3', 'a3', 'toolu_del', { id: 'b0000002' })]);
    const cut = 30;
    await appendFile(jsonlPath, cancel.slice(0, cut));
    assert.deepEqual(await jobIds(), ['a0000001', 'b0000002']);
    await appendFile(jsonlPath, cancel.slice(cut));
    assert.deepEqual(await jobIds(), ['a0000001']);

    // Shorter than what was read: read again from its start.
    await writeFile(jsonlPath, original.replaceAll('a0000001', 'f000000f'));
    assert.deepEqual(await jobIds(), ['f000000f']);
  });
});

test('a transcript with no scheduling row has nothing to bring back', async () => {
  const rows = [
    prompt('u1', null, 'hello'),
    // Tool definitions name the tools, but no call is made.
    row('x1', 'u1', { type: 'api-request-shape', shape: { tools: [{ name: 'CronCreate' }, { name: 'ScheduleWakeup' }] } }),
  ];
  await withTranscript(rows, async ({ jsonlPath }) => {
    const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null, hasLiveCliProcess: async () => false });
    assert.deepEqual(await sessions.readRevivedCronJobs(SESSION), []);
    assert.deepEqual(await sessions.readPausedScheduledWork(SESSION), { items: [], resumeContent: null, heldElsewhere: false });

    // Once one is written, the whole file is read.
    await appendFile(jsonlPath, `${[
      toolCall('a1', 'u1', 'toolu_a', 'CronCreate', { cron: '*/5 * * * *', prompt: 'check' }),
      toolResult('r1', 'a1', 'toolu_a', cronResult('a0000001', '*/5 * * * *')),
    ].map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    assert.deepEqual((await sessions.readRevivedCronJobs(SESSION)).map((job) => job.jobId), ['a0000001']);
  });
});

test('paused work lists the jobs and the wake-up still to come, with the turn that resumes them; none while a CLI elsewhere holds the session', async () => {
  const scheduledFor = Date.now() + 10 * MINUTE;
  const rows = [
    prompt('u1', null, '/loop check'),
    toolCall('a1', 'u1', 'toolu_a', 'CronCreate', { cron: '*/5 * * * *', prompt: 'check' }),
    toolResult('r1', 'a1', 'toolu_a', cronResult('a0000001', '*/5 * * * *')),
    toolCall('a2', 'r1', 'toolu_w', 'ScheduleWakeup', { delaySeconds: 1200, prompt: '<<autonomous-loop-dynamic>>', reason: 'watching CI', noop: false }),
    toolResult('r2', 'a2', 'toolu_w', { scheduledFor, clampedDelaySeconds: 1200, wasClamped: false }),
  ];
  await withTranscript(rows, async () => {
    let heldElsewhere = false;
    const probed: string[] = [];
    const sessions = new ClaudeSessionsProvider({
      getLiveRunStartTime: () => null,
      hasLiveCliProcess: async (providerSessionId) => {
        probed.push(providerSessionId);
        return heldElsewhere;
      },
    });
    const now = Date.now();
    const paused = await sessions.readPausedScheduledWork(SESSION, { now });
    assert.deepEqual(probed, [SESSION]);
    assert.deepEqual(paused.items.map((item) => [item.id, item.kind, item.paused]), [
      ['cron:a0000001', 'cron', true],
      ['wakeup:toolu_w', 'wakeup', true],
    ]);
    assert.deepEqual(parseLoopsResumeMessage(paused.resumeContent), {
      jobIds: ['a0000001'],
      wakeup: { delaySeconds: Math.ceil((scheduledFor - now) / 1000), prompt: '<<autonomous-loop-dynamic>>', reason: 'watching CI' },
    });

    heldElsewhere = true;
    assert.deepEqual(await sessions.readPausedScheduledWork(SESSION), { items: [], resumeContent: null, heldElsewhere: true });
  });
});

function createGateway(runtime: Partial<IProviderRuntime>, readPaused: () => Promise<PausedScheduledWork>) {
  const provider = {
    id: 'claude',
    runtime: { async run() { return undefined; }, abort: () => false, ...runtime },
    sessions: {
      normalizeMessage: () => [],
      fetchHistory: async () => ({ messages: [], total: 0, hasMore: false, offset: 0, limit: null }),
      readPausedScheduledWork: readPaused,
    },
  } as unknown as IProvider;
  return createProviderRuntimeService({
    getSession: (sessionId) => (sessionId === SESSION ? { provider: 'claude', project_path: '/p' } : null),
    listProviders: () => [provider],
    resolveProvider: (name) => {
      if (name !== 'claude') {
        throw new Error(`Missing provider: ${name}`);
      }
      return provider;
    },
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'default-model' }),
  });
}

test('the gateway lists paused work only while no process of this server holds the session, and never as live scheduled work', async () => {
  const pausedItem = {
    id: 'cron:a0000001', kind: 'cron' as const, toolUseId: 'toolu_a', prompt: 'check', startedAt: 1, nextFireAt: 2, recurring: true, holdUntil: 3, paused: true as const,
  };
  let state: 'running' | null = null;
  let reads = 0;
  const gateway = createGateway(
    { processState: () => state },
    async () => {
      reads += 1;
      return { items: [pausedItem], resumeContent: 'resume', heldElsewhere: false };
    },
  );

  assert.deepEqual(await gateway.describePausedScheduledWork(SESSION), {
    items: [pausedItem], resumeContent: 'resume', heldElsewhere: false, heldHere: false,
  });
  assert.equal(gateway.hasScheduledWork(SESSION), false, 'paused work keeps no process');
  assert.deepEqual(gateway.listScheduledWork(SESSION), []);

  state = 'running';
  assert.deepEqual(await gateway.describePausedScheduledWork(SESSION), {
    items: [], resumeContent: null, heldElsewhere: false, heldHere: true,
  });
  assert.equal(reads, 1, 'a held session\'s transcript is not read');
  assert.deepEqual(await gateway.describePausedScheduledWork('unknown-session'), {
    items: [], resumeContent: null, heldElsewhere: false, heldHere: false,
  });
});

test('a shutdown reaches every runtime that keeps hold records', () => {
  let prepared = 0;
  const gateway = createGateway({ prepareForShutdown: () => { prepared += 1; } }, async () => ({ items: [], resumeContent: null, heldElsewhere: false }));
  gateway.prepareForShutdown();
  assert.equal(prepared, 1);
});
