import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SCHEDULE_HOLD_MAX_MS,
  buildLoopsResumeMessage,
  buildScheduledStopMessage,
  createScheduledWork,
  describePausedScheduledWork,
  findPendingWakeup,
  findRevivedCronJobs,
  nextScheduledFire,
  parseControlPrompt,
  parseLoopsResumeMessage,
  readControlNote,
  resumedWakeupDelaySeconds,
} from '@/modules/providers/list/claude/claude-scheduled-work.js';
import { keepsScheduleHoldAtLoopEnd } from '@/modules/providers/list/claude/claude-runtime.provider.js';

/**
 * A resumed CLI brings back the session's cron jobs from its transcript and
 * says nothing (Claude Code 2.1.312's `L8t`, `os`, `ns`); a self-paced loop's
 * wake-up it does not bring back. These pin the port of those rules, how the
 * runtime holds a job brought back, and the turn that resumes loops after a
 * restart of the server. Dates are built in local time, as the CLI matches
 * cron expressions in it.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const HOLD_MAX = 12 * HOUR;

const local = (...parts: [number, number, number, number?, number?, number?]) => new Date(...(parts as [number, number, number, number, number, number])).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

let rowCount = 0;
const uuid = () => `row-${(rowCount += 1)}`;

const call = (calledAt: number, name: string, id: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  uuid: uuid(),
  timestamp: iso(calledAt),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (resultAt: number, id: string, toolUseResult: Record<string, unknown>, isError = false) => ({
  type: 'user',
  uuid: uuid(),
  timestamp: iso(resultAt),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...(isError ? { is_error: true } : {}) }] },
  toolUseResult,
});

/** A CronCreate call and its result, the result naming the time the defaults give. */
function cronCreate(
  calledAt: number,
  jobId: string,
  cron: string,
  { recurring = true, durable = false, prompt = `job ${jobId}`, nextFireAt }: { recurring?: boolean; durable?: boolean; prompt?: string; nextFireAt?: number } = {},
) {
  const toolUseId = `toolu_${jobId}_${calledAt}`;
  const reported = nextFireAt ?? nextScheduledFire({ cron, recurring, id: jobId, createdAt: calledAt + SECOND });
  return [
    call(calledAt, 'CronCreate', toolUseId, { cron, prompt, recurring, durable }),
    result(calledAt + SECOND, toolUseId, { id: jobId, humanSchedule: `schedule ${cron}`, recurring, durable, nextFireAt: reported }),
  ];
}

const loopFire = (at: number) => ({ type: 'system', subtype: 'scheduled_task_fire', uuid: uuid(), timestamp: iso(at), taskKind: 'loop', content: 'fire' });

function wakeup(calledAt: number, toolUseId: string, input: Record<string, unknown>, output: Record<string, unknown>) {
  return [call(calledAt, 'ScheduleWakeup', toolUseId, input), result(calledAt + SECOND, toolUseId, output)];
}

test('findRevivedCronJobs brings back the jobs the CLI does: not durable, deleted, expired, past or failed ones', () => {
  const now = local(2026, 9, 30, 14, 0, 30);
  const rows = [
    ...cronCreate(now - DAY, 'a0000001', '*/30 * * * *'),
    ...cronCreate(now - DAY, 'b0000002', '*/30 * * * *', { durable: true }),
    ...cronCreate(now - DAY, 'c0000003', '*/30 * * * *'),
    // A CronDelete deletes its id whether it worked or not, as the CLI reads it.
    call(now - HOUR, 'CronDelete', 'toolu_delete', { id: 'c0000003' }),
    result(now - HOUR, 'toolu_delete', { error: 'no such job' }, true),
    ...cronCreate(now - 7 * DAY, 'd0000004', '0 * * * *'),
    ...cronCreate(now - 7 * DAY + MINUTE, 'd0000005', '0 * * * *'),
    ...cronCreate(now - 2 * HOUR, 'e0000006', '0 13 30 10 *', { recurring: false }),
    ...cronCreate(now - 2 * HOUR, 'f0000007', '0 16 30 10 *', { recurring: false }),
    call(now - HOUR, 'CronCreate', 'toolu_failed', { cron: '*/5 * * * *', prompt: 'x' }),
    result(now - HOUR, 'toolu_failed', { id: 'a1111111' }, true),
    call(now - HOUR, 'CronCreate', 'toolu_no_id', { cron: '*/5 * * * *', prompt: 'x' }),
    result(now - HOUR, 'toolu_no_id', { humanSchedule: 'Every 5 minutes' }),
    // The same id again: the first job of an id wins.
    ...cronCreate(now - HOUR, 'a0000001', '*/10 * * * *'),
  ];

  const revived = findRevivedCronJobs(rows, now);
  assert.deepEqual(revived.map((job) => job.jobId), ['a0000001', 'd0000005', 'f0000007']);
  const [first, , oneShot] = revived;
  assert.deepEqual(
    [first.cron, first.recurring, first.createdAt, first.humanSchedule, first.predictable, first.prompt],
    ['*/30 * * * *', true, now - DAY, 'schedule */30 * * * *', true, 'job a0000001'],
  );
  assert.equal(first.toolUseId, `toolu_a0000001_${now - DAY}`);
  assert.deepEqual([oneShot.recurring, oneShot.predictable], [false, false]);
});

test('a carried job comes back with the jobs made since: the last carry row counts, and its ended ids are deleted', () => {
  const now = local(2026, 9, 30, 14, 0);
  const carry = (tasks: unknown[], ended: string[] = []) => ({
    type: 'attachment',
    uuid: uuid(),
    timestamp: iso(now - HOUR),
    attachment: { type: 'session_cron_carry', tasks, ended },
  });
  const task = (id: string, createdAt: number) => ({ id, cron: '*/15 * * * *', prompt: `carried ${id}`, createdAt, recurring: true });
  const rows = [
    carry([task('10000001', now - 2 * DAY), task('10000002', now - 2 * DAY)]),
    ...cronCreate(now - 3 * HOUR, 'a0000001', '*/30 * * * *'),
    ...cronCreate(now - 3 * HOUR, 'a0000002', '*/30 * * * *'),
    carry([task('10000003', now - DAY), { id: 'malformed' }], ['a0000002']),
  ];
  const revived = findRevivedCronJobs(rows, now);
  assert.deepEqual(revived.map((job) => job.jobId), ['a0000001', '10000003']);
  assert.deepEqual(
    [revived[1].toolUseId, revived[1].createdAt, revived[1].predictable, revived[1].prompt],
    ['carried:10000003', now - DAY, true, 'carried 10000003'],
  );
});

test('a job whose result named a time the defaults do not give is not predictable, and one whose call has no time is left out', () => {
  const now = local(2026, 9, 30, 14, 0);
  const created = now - HOUR;
  const rows = [
    ...cronCreate(created, 'a0000001', '*/30 * * * *', { nextFireAt: local(2026, 9, 30, 13, 47) }),
    { ...call(created, 'CronCreate', 'toolu_untimed_row', { cron: '*/5 * * * *', prompt: 'x' }), timestamp: undefined },
    result(created, 'toolu_untimed_row', { id: 'b0000002', recurring: true }),
  ];
  const revived = findRevivedCronJobs(rows, now);
  assert.deepEqual(revived.map((job) => [job.jobId, job.predictable]), [['a0000001', false]]);
});

test('findPendingWakeup finds the wake-up still to come, and none once it fired, stopped or set nothing', () => {
  const now = local(2026, 9, 30, 14, 0);
  const pending = wakeup(now - 5 * MINUTE, 'toolu_w1', { delaySeconds: 600, prompt: '<<autonomous-loop-dynamic>>', reason: ' watching CI ' }, { scheduledFor: now + 5 * MINUTE });

  assert.deepEqual(findPendingWakeup(pending, now), {
    toolUseId: 'toolu_w1',
    prompt: '<<autonomous-loop-dynamic>>',
    reason: 'watching CI',
    scheduledFor: now + 5 * MINUTE,
    calledAt: now - 5 * MINUTE,
  });
  assert.equal(findPendingWakeup([...pending, loopFire(now + 5 * MINUTE)], now + 6 * MINUTE), null, 'it fired and its turn set no other');
  const second = wakeup(now + 6 * MINUTE, 'toolu_w2', { delaySeconds: 300, prompt: 'p', reason: 'r' }, { scheduledFor: now + 11 * MINUTE });
  assert.equal(findPendingWakeup([...pending, loopFire(now + 5 * MINUTE), ...second], now + 7 * MINUTE)?.toolUseId, 'toolu_w2', 'the fire\'s turn set the next one');
  // A cron job's fire is not the loop's.
  const cronFire = { ...loopFire(now + MINUTE), taskKind: undefined };
  assert.equal(findPendingWakeup([...pending, cronFire], now + 2 * MINUTE)?.toolUseId, 'toolu_w1');
  const stop = wakeup(now - MINUTE, 'toolu_stop', { stop: true }, { scheduledFor: 0, stopped: true });
  assert.equal(findPendingWakeup([...pending, ...stop], now), null, 'stopped');
  assert.equal(findPendingWakeup(wakeup(now, 'toolu_w3', { delaySeconds: 60, prompt: 'p' }, { scheduledFor: 0 }), now), null, 'set nothing');
  // A call with no result (the process died on it) is passed over for the one before.
  const unanswered = call(now - MINUTE, 'ScheduleWakeup', 'toolu_w4', { delaySeconds: 60, prompt: 'p' });
  assert.equal(findPendingWakeup([...pending, unanswered], now)?.toolUseId, 'toolu_w1');
  assert.equal(findPendingWakeup(pending, now + 8 * DAY), null, 'due more than seven days ago');
});

test('noteCronRevived keeps a job\'s creation, counts a recurring one\'s next fire from the revival, and a one-shot one\'s from its creation', () => {
  const revivedAt = local(2026, 9, 30, 14, 2, 30);
  const createdAt = revivedAt - DAY;
  const work = createScheduledWork({ holdMaxMs: HOLD_MAX, scheduleHoldMaxMs: DEFAULT_SCHEDULE_HOLD_MAX_MS, graceMs: 5 * MINUTE });
  const job = (jobId: string, cron: string, extra: Record<string, unknown> = {}) => ({
    jobId, toolUseId: `toolu_${jobId}`, cron, prompt: `job ${jobId}`, recurring: true, createdAt, humanSchedule: '', predictable: true, ...extra,
  });
  work.noteCronRevived(job('a0000001', '*/30 * * * *'), revivedAt);
  work.noteCronRevived(job('b0000002', '*/30 * * * *', { predictable: false }), revivedAt);
  work.noteCronRevived(job('c0000003', '0 16 30 10 *', { recurring: false, predictable: false }), revivedAt);
  work.noteCronRevived(job('a0000001', '0 0 * * *'), revivedAt);

  const [timed, untimed, oneShot] = work.list();
  assert.deepEqual(
    [timed.id, timed.startedAt, timed.nextFireAt, timed.holdUntil, timed.expiresAt, timed.cron, timed.durable],
    [
      'cron:a0000001',
      createdAt,
      nextScheduledFire({ cron: '*/30 * * * *', recurring: true, id: 'a0000001', createdAt, lastFiredAt: revivedAt }),
      createdAt + DEFAULT_SCHEDULE_HOLD_MAX_MS,
      createdAt + 7 * DAY,
      '*/30 * * * *',
      false,
    ],
  );
  assert.deepEqual([untimed.nextFireAt, untimed.holdUntil], [null, revivedAt + HOLD_MAX]);
  assert.equal(oneShot.nextFireAt, nextScheduledFire({ cron: '0 16 30 10 *', recurring: false, id: 'c0000003', createdAt }));
  assert.equal(work.holdsProcess(), true);

  // Its fire is put down to it, and its next one counts from there.
  const firedAt = timed.nextFireAt as number;
  work.noteCronFire(firedAt, null);
  assert.equal(
    work.list()[0].nextFireAt,
    nextScheduledFire({ cron: '*/30 * * * *', recurring: true, id: 'a0000001', createdAt, lastFiredAt: firedAt }),
  );
});

test('confirmRevivedTimes keeps a job\'s time when the CLI\'s first word agrees, and makes it unknown when a cron time fell in between', () => {
  const work = createScheduledWork({ holdMaxMs: HOLD_MAX, scheduleHoldMaxMs: DEFAULT_SCHEDULE_HOLD_MAX_MS, graceMs: 5 * MINUTE });
  const createdAt = local(2026, 9, 29, 9, 0);
  const revivedAt = local(2026, 9, 30, 13, 59, 59) + 600;
  const initAt = revivedAt + 800;
  const job = (jobId: string, cron: string) => ({
    jobId, toolUseId: `toolu_${jobId}`, cron, prompt: 'p', recurring: true, createdAt, humanSchedule: '', predictable: true,
  });
  // Id 00000000 has no lag: the hourly job is due at 14:00, between the two.
  work.noteCronRevived(job('00000000', '0 * * * *'), revivedAt);
  work.noteCronRevived(job('a0000001', '15,45 * * * *'), revivedAt);
  const before = work.list().map((item) => item.nextFireAt);

  work.confirmRevivedTimes(initAt);
  const [hourly, quarterPast] = work.list();
  assert.deepEqual([hourly.nextFireAt, hourly.holdUntil], [null, initAt + HOLD_MAX]);
  assert.equal(quarterPast.nextFireAt, before[1]);
  assert.notEqual(before[1], null);
  // Once only: a later word changes nothing.
  work.confirmRevivedTimes(initAt + HOUR);
  assert.equal(work.list()[1].nextFireAt, before[1]);
});

test('confirmRevivedTimes keeps the time of a */5 job, which counts from the moment itself: the CLI\'s comes no earlier', () => {
  const work = createScheduledWork({ holdMaxMs: HOLD_MAX, scheduleHoldMaxMs: DEFAULT_SCHEDULE_HOLD_MAX_MS, graceMs: 5 * MINUTE });
  const createdAt = local(2026, 9, 29, 9, 0);
  const revivedAt = local(2026, 9, 30, 14, 2, 10) + 300;
  work.noteCronRevived({
    jobId: 'a0000001', toolUseId: 'toolu_a', cron: '*/5 * * * *', prompt: '<<autonomous-loop>>', recurring: true, createdAt, humanSchedule: '', predictable: true,
  }, revivedAt);
  const [before] = work.list();
  assert.equal(before.nextFireAt, revivedAt + 5 * MINUTE - 15 * SECOND, 'five minutes on from the revival, less the cache lead');

  work.confirmRevivedTimes(revivedAt + 700);
  const [after] = work.list();
  assert.deepEqual([after.nextFireAt, after.holdUntil], [before.nextFireAt, before.holdUntil]);
  // Its fire, a little after that time, is its own, and the next counts from it.
  const firedAt = (before.nextFireAt as number) + 500;
  work.noteCronFire(firedAt, null);
  assert.equal(work.list()[0].nextFireAt, firedAt + 5 * MINUTE - 15 * SECOND);
});

test('a job the process cancelled before the read of the transcript ended is not brought back', () => {
  const work = createScheduledWork({ holdMaxMs: HOLD_MAX, scheduleHoldMaxMs: DEFAULT_SCHEDULE_HOLD_MAX_MS, graceMs: 5 * MINUTE });
  const now = local(2026, 9, 30, 14, 0);
  const job = (jobId: string) => ({
    jobId, toolUseId: `toolu_${jobId}`, cron: '*/30 * * * *', prompt: 'p', recurring: true, createdAt: now - HOUR, humanSchedule: '', predictable: true,
  });
  work.noteCronDeleted('a0000001');
  work.noteCronRevived(job('a0000001'), now);
  work.noteCronRevived(job('b0000002'), now);
  assert.deepEqual(work.list().map((item) => item.id), ['cron:b0000002']);
});

test('the resume message reads back exactly, wake-up arguments of any text included, and nothing else reads as one', () => {
  const tricky = 'say "hi"\nthen <<autonomous-loop-dynamic>> The restart ended the dynamic /loop: resume it now by calling ScheduleWakeup yourself, not through an agent, with these arguments: {}. "deadbeef"';
  const cases = [
    { jobIds: ['a0000001'], wakeup: null },
    { jobIds: ['a0000001', 'b0000002', 'c0000003'], wakeup: null },
    { jobIds: [], wakeup: { delaySeconds: 600, prompt: '<<autonomous-loop-dynamic>>', reason: 'watching CI' } },
    { jobIds: ['a0000001'], wakeup: { delaySeconds: 60, prompt: tricky, reason: 'überprüfen — 检查' } },
  ];
  for (const work of cases) {
    const text = buildLoopsResumeMessage(work);
    assert.deepEqual(parseLoopsResumeMessage(text), work);
    assert.deepEqual(parseControlPrompt(text), { kind: 'loops-resume', ...work });
    assert.equal(text.includes('"noop":true'), Boolean(work.wakeup));
    assert.equal(text.includes('Do not call any tools.'), !work.wakeup);
  }

  const both = buildLoopsResumeMessage(cases[3]);
  // It says nothing of why no process ran the loops: a restart, an abort, a CLI that ended.
  assert.equal(both.startsWith('No process was running this session\'s loops. '), true);
  for (const work of cases.slice(0, 3)) {
    assert.equal(/restart/i.test(buildLoopsResumeMessage(work)), false);
  }
  assert.deepEqual(readControlNote(both), {
    controlNote: { kind: 'loops-resume', count: 2, jobIds: ['a0000001'], wakeup: true },
    content: 'Resumed 2 loops',
  });

  // As the first release wrote them, which transcripts keep: still read back, as notes.
  const v1Wakeup = 'The restart ended the dynamic /loop: resume it now by calling ScheduleWakeup yourself, not through an agent, with these arguments: ';
  const v1 = [
    'CloudCLI restarted. Scheduled job "a0000001" runs again on its own schedule. Do not call any tools. Do nothing else, and reply in one short sentence.',
    `CloudCLI restarted. Scheduled job "a0000001" runs again on its own schedule. ${v1Wakeup}${JSON.stringify({ ...cases[3].wakeup, noop: true })}. Do nothing else, and reply in one short sentence.`,
  ];
  assert.deepEqual(parseLoopsResumeMessage(v1[0]), cases[0]);
  assert.deepEqual(parseLoopsResumeMessage(v1[1]), cases[3]);
  assert.equal(readControlNote(v1[1])?.content, 'Resumed 2 loops');
  // Each wording keeps its own wake-up sentence.
  assert.equal(parseLoopsResumeMessage(v1[1].replace('CloudCLI restarted.', 'No process was running this session\'s loops.')), null);
  assert.deepEqual(readControlNote(buildLoopsResumeMessage(cases[0]))?.controlNote, { kind: 'loops-resume', count: 1, jobIds: ['a0000001'] });

  const negatives = [
    buildLoopsResumeMessage({ jobIds: [], wakeup: null }),
    both.replace('"delaySeconds":60', '"delaySeconds":60.5'),
    both.replace('"noop":true', '"noop":false'),
    both.replace('Scheduled job', 'Scheduled jobs'),
    `${both} `,
    ` ${both}`,
    both.replace('}. Do nothing', '} Do nothing'),
    buildScheduledStopMessage({ jobIds: ['a0000001'], wakeup: false }),
  ];
  for (const text of negatives) {
    assert.equal(parseLoopsResumeMessage(text), null, text);
  }
  assert.equal(parseControlPrompt(buildScheduledStopMessage({ jobIds: ['a0000001'], wakeup: true }))?.kind, 'scheduled-stop');
});

test('paused work lists each job and the wake-up, paused, oldest first; a resumed wake-up waits what was left of its wait', () => {
  const now = local(2026, 9, 30, 14, 0);
  const items = describePausedScheduledWork({
    cronJobs: [{ jobId: 'a0000001', toolUseId: 'toolu_a', cron: '*/30 * * * *', prompt: '<<autonomous-loop>>', recurring: true, createdAt: now - HOUR, humanSchedule: 'Every 30 minutes', predictable: true }],
    wakeup: { toolUseId: 'toolu_w', prompt: 'check the deploy\nthen report', reason: 'watching CI', scheduledFor: now - MINUTE, calledAt: now - 2 * HOUR },
  }, now, { holdMaxMs: HOLD_MAX, scheduleHoldMaxMs: DEFAULT_SCHEDULE_HOLD_MAX_MS });
  assert.deepEqual(items.map((item) => [item.id, item.kind, item.prompt, item.paused]), [
    ['wakeup:toolu_w', 'wakeup', 'check the deploy', true],
    ['cron:a0000001', 'cron', '/loop', true],
  ]);
  assert.deepEqual([items[0].nextFireAt, items[0].reason, items[0].recurring], [now - MINUTE, 'watching CI', true]);
  assert.equal(items[1].cadence, 'Every 30 minutes');

  assert.equal(resumedWakeupDelaySeconds(now + 600.4 * SECOND, now), 601);
  assert.equal(resumedWakeupDelaySeconds(now - HOUR, now), 60, 'overdue: the shortest wait');
  assert.equal(resumedWakeupDelaySeconds(now + 5 * HOUR, now), 3600, 'never longer than the CLI allows');
});

test('a hold\'s record outlives the end of the loop only when the server did not let go: shutting down, or the CLI killed', () => {
  assert.equal(keepsScheduleHoldAtLoopEnd({ shuttingDown: true, exit: null }), true);
  assert.equal(keepsScheduleHoldAtLoopEnd({ shuttingDown: false, exit: { code: 143, signal: null } }), true, 'the CLI\'s own exit on SIGTERM');
  assert.equal(keepsScheduleHoldAtLoopEnd({ shuttingDown: false, exit: { code: null, signal: 'SIGKILL' } }), true);
  assert.equal(keepsScheduleHoldAtLoopEnd({ shuttingDown: false, exit: { code: 0, signal: null } }), false);
  assert.equal(keepsScheduleHoldAtLoopEnd({ shuttingDown: false, exit: { code: 1, signal: null } }), false);
  assert.equal(keepsScheduleHoldAtLoopEnd({ shuttingDown: false, exit: null }), false);
});
