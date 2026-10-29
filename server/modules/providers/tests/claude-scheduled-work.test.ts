import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_CRON_CONFIG,
  DEFAULT_SCHEDULE_HOLD_MAX_MS,
  buildScheduledStopMessage,
  createScheduledWork,
  describeLoopPrompt,
  isStoppableScheduledWorkId,
  nextMatch,
  nextScheduledFire,
  parseCron,
  readWakeupTime,
  resolveScheduleHoldMax,
} from '@/modules/providers/list/claude/claude-scheduled-work.js';

/**
 * The cron arithmetic is Claude Code 2.1.312's own, so these pin it against
 * what the CLI reported for real jobs, and the record object against the
 * fires the CLI sends for them. Dates are built in local time, as the CLI
 * matches cron expressions in it.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GRACE = 5 * MINUTE;
const HOLD_MAX = 12 * HOUR;

const local = (...parts: [number, number, number, number?, number?, number?]) => new Date(...(parts as [number, number, number, number, number, number])).getTime();
const at = (time: number | null) => (time === null ? 'null' : new Date(time).toString());

test('nextMatch finds the first matching minute after the one it starts in', () => {
  const from = local(2026, 9, 30, 14, 2, 30);
  assert.equal(at(nextMatch('*/5 * * * *', from)), at(local(2026, 9, 30, 14, 5)));
  assert.equal(at(nextMatch('*/5 * * * *', local(2026, 9, 30, 14, 5))), at(local(2026, 9, 30, 14, 10)), 'never the minute it starts in');
  // Friday 30 October 2026: weekdays at nine go on on Monday.
  assert.equal(at(nextMatch('0 9 * * 1-5', local(2026, 9, 30, 10))), at(local(2026, 10, 2, 9)));
  assert.equal(at(nextMatch('0 9 * * 1-5', local(2026, 9, 30, 8, 59, 59))), at(local(2026, 9, 30, 9)));
});

test('nextMatch takes either day when both the day of month and the day of week are restricted, and only the restricted one otherwise', () => {
  const friday = local(2026, 9, 30, 10);
  assert.equal(at(nextMatch('0 0 1 * 1', friday)), at(local(2026, 10, 1)), 'the 1st, a Sunday');
  assert.equal(at(nextMatch('0 0 1 * 1', local(2026, 10, 1))), at(local(2026, 10, 2)), 'then Monday the 2nd');
  assert.equal(at(nextMatch('0 0 * * 1', friday)), at(local(2026, 10, 2)));
  assert.equal(at(nextMatch('0 0 1 * *', friday)), at(local(2026, 10, 1)));
});

test('nextMatch runs across months and years, reads a day of week of 7 as Sunday, and gives null when nothing matches', () => {
  assert.equal(at(nextMatch('0 12 31 * *', local(2026, 10, 1))), at(local(2026, 11, 31, 12)), 'November has no 31st');
  assert.equal(at(nextMatch('0 0 1 1 *', local(2026, 11, 31, 23, 59))), at(local(2027, 0, 1)));
  assert.equal(at(nextMatch('0 9 * * 7', local(2026, 9, 30))), at(local(2026, 10, 1, 9)));
  assert.equal(at(nextMatch('0 9 * * 5-7', local(2026, 9, 31, 10))), at(local(2026, 10, 1, 9)), 'a range may end on 7');
  assert.equal(nextMatch('0 0 30 2 *', local(2026, 9, 30)), null, 'February has no 30th');
  assert.equal(nextMatch('every day', local(2026, 9, 30)), null);
});

test('parseCron accepts what Claude Code accepts and nothing else', () => {
  assert.deepEqual(parseCron('*/20 9-17/4 1,15 * 1-5')?.minute, [0, 20, 40]);
  assert.deepEqual(parseCron('*/20 9-17/4 1,15 * 1-5')?.hour, [9, 13, 17]);
  assert.deepEqual(parseCron('0 9 * * 7')?.dayOfWeek, [0]);
  for (const refused of ['* * * *', '60 * * * *', '*/0 * * * *', '5-1 * * * *', '0 9 * * 8', '0 9 * * MON', '', null]) {
    assert.equal(parseCron(refused), null, String(refused));
  }
});

test('nextScheduledFire gives the times Claude Code reported for real jobs', () => {
  // CronCreate calls and results seen from CLI 2.1.312: the job was created
  // between the call and its result.
  const jobs: Array<[string, string, number, number]> = [
    ['b2148320', '*/1 * * * *', 1793255039645, 1793255060868.7646],
    ['7b7cd8fc', '* * * * *', 1793255403892, 1793255474471.2131],
    ['1369f394', '* * * * *', 1793255495700, 1793255522275.0632],
    ['eebdc3fb', '*/1 * * * *', 1793255527370, 1793255607977.4927],
  ];
  for (const [id, cron, createdAt, reported] of jobs) {
    assert.equal(nextScheduledFire({ cron, recurring: true, id, createdAt }), reported, id);
  }
  // Its next fire counts from when the scheduler fired it, 0.8 s after its time.
  assert.equal(
    nextScheduledFire({ cron: '*/1 * * * *', recurring: true, id: 'b2148320', createdAt: 1793255039645, lastFiredAt: 1793255061669 }),
    1793255120868.7646,
  );
});

test('a */5 job fires 285 s after its base, where */6 and any other fire on the minute plus their share of the gap', () => {
  const base = local(2026, 9, 30, 14, 2, 30);
  for (const id of ['00000000', 'ffffffff']) {
    assert.equal(nextScheduledFire({ cron: '*/5 * * * *', recurring: true, id, createdAt: base }), base + 285 * SECOND, id);
  }
  assert.equal(nextScheduledFire({ cron: '*/6 * * * *', recurring: true, id: '00000000', createdAt: base }), local(2026, 9, 30, 14, 6));
  assert.equal(nextScheduledFire({ cron: '*/6 * * * *', recurring: true, id: '80000000', createdAt: base }), local(2026, 9, 30, 14, 6) + 90 * SECOND);
  // The same */5 written with two spaces is not the shape the CLI special-cases.
  assert.equal(nextScheduledFire({ cron: '*/5  * * * *', recurring: true, id: '00000000', createdAt: base }), local(2026, 9, 30, 14, 5));
});

test('a job on an irregular schedule lags each match by its share of the gap to the next one, capped at 30 minutes', () => {
  const id = '08000000'; // 1/32 of the gap, half of it with the defaults
  assert.equal(
    nextScheduledFire({ cron: '0 9,17 * * *', recurring: true, id, createdAt: local(2026, 9, 30, 8) }),
    local(2026, 9, 30, 9) + 8 * HOUR / 64,
  );
  assert.equal(
    nextScheduledFire({ cron: '0 9,17 * * *', recurring: true, id, createdAt: local(2026, 9, 30, 10) }),
    local(2026, 9, 30, 17) + 16 * HOUR / 64,
  );
  assert.equal(
    nextScheduledFire({ cron: '0 9 * * *', recurring: true, id: 'ffffffff', createdAt: local(2026, 9, 30, 10) }),
    local(2026, 9, 31, 9) + 30 * MINUTE,
  );
});

test('a one-shot job due on the hour or half hour fires up to 90 s early, but not before it was created; any other on its minute', () => {
  const id = '80000000'; // half of the 90 s
  const created = local(2026, 9, 30, 14, 10);
  assert.equal(nextScheduledFire({ cron: '0 15 30 10 *', recurring: false, id, createdAt: created }), local(2026, 9, 30, 15) - 45 * SECOND);
  assert.equal(nextScheduledFire({ cron: '30 15 30 10 *', recurring: false, id, createdAt: created }), local(2026, 9, 30, 15, 30) - 45 * SECOND);
  assert.equal(nextScheduledFire({ cron: '7 15 30 10 *', recurring: false, id, createdAt: created }), local(2026, 9, 30, 15, 7));
  const late = local(2026, 9, 30, 14, 59, 50);
  assert.equal(nextScheduledFire({ cron: '0 15 30 10 *', recurring: false, id, createdAt: late }), late);
  assert.equal(nextScheduledFire({ cron: 'not cron', recurring: false, id, createdAt: late }), null);
});

test('describeLoopPrompt shows the /loop sentinels as /loop, and any other prompt by its first line, up to 200 characters', () => {
  assert.equal(describeLoopPrompt('<<autonomous-loop>>'), '/loop');
  assert.equal(describeLoopPrompt('<<autonomous-loop-dynamic>>'), '/loop');
  assert.equal(describeLoopPrompt('<<loop.md>>'), '/loop (loop.md)');
  assert.equal(describeLoopPrompt(' <<loop.md-dynamic>>\n'), '/loop (loop.md)');
  assert.equal(describeLoopPrompt('\n  Check CI \r\nthen report'), 'Check CI');
  assert.equal(describeLoopPrompt(`${'检'.repeat(199)}查查`), `${'检'.repeat(199)}查`);
  assert.equal(describeLoopPrompt('🙂'.repeat(201)), '🙂'.repeat(200), 'counted in characters, not code units');
  assert.equal(describeLoopPrompt(undefined), '');
});

test('readWakeupTime reads the time a ScheduleWakeup set, and none when the CLI set none', () => {
  assert.equal(JSON.stringify(readWakeupTime({ scheduledFor: 1793255760000 }, { delaySeconds: 60 }, 0)), '{"at":1793255760000,"exact":true}');
  const calledAt = local(2026, 9, 30, 14, 0, 10);
  assert.equal(JSON.stringify(readWakeupTime(null, { delaySeconds: 90 }, calledAt)), JSON.stringify({ at: local(2026, 9, 30, 14, 2), exact: false }));
  assert.equal(JSON.stringify(readWakeupTime(null, { delaySeconds: 5 }, calledAt)), JSON.stringify({ at: local(2026, 9, 30, 14, 2), exact: false }), 'clamped to a minute');
  // The loop reached its maximum duration: "Wakeup not scheduled".
  assert.equal(readWakeupTime({ scheduledFor: 0, clampedDelaySeconds: 0, wasClamped: false }, { delaySeconds: 60 }, calledAt), null);
});

test('CLOUDCLI_CLAUDE_SCHEDULE_HOLD_MAX_MS is read as a positive integer, else the eight-day default with a warning', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal(DEFAULT_SCHEDULE_HOLD_MAX_MS, 691200000);
  assert.equal(resolveScheduleHoldMax({}), DEFAULT_SCHEDULE_HOLD_MAX_MS);
  assert.equal(resolveScheduleHoldMax({ CLOUDCLI_CLAUDE_SCHEDULE_HOLD_MAX_MS: ' 120000 ' }), 120000);
  assert.equal(resolveScheduleHoldMax({ CLOUDCLI_CLAUDE_SCHEDULE_HOLD_MAX_MS: String(30 * DAY) }), 30 * DAY, 'not capped at what a timer can wait');
  assert.equal(warn.mock.callCount(), 0);
  for (const raw of ['0', '-5', '1.5', '8d', '99999999999999999999']) {
    assert.equal(resolveScheduleHoldMax({ CLOUDCLI_CLAUDE_SCHEDULE_HOLD_MAX_MS: raw }), DEFAULT_SCHEDULE_HOLD_MAX_MS, raw);
  }
  assert.equal(warn.mock.callCount(), 5);
});

test('the stop message names every job to delete, and the wake-up', () => {
  const tail = 'Make the calls yourself, not through an agent. Do nothing else, and reply in one short sentence.';
  assert.equal(buildScheduledStopMessage({ jobIds: ['b2148320'], wakeup: false }), `Cancel scheduled job b2148320 now: call CronDelete with id "b2148320". ${tail}`);
  assert.equal(buildScheduledStopMessage({ jobIds: ['b2148320', '7b7cd8fc'], wakeup: false }), `Cancel these scheduled jobs now: call CronDelete once for each id: "b2148320", "7b7cd8fc". ${tail}`);
  assert.equal(buildScheduledStopMessage({ jobIds: [], wakeup: true }), `End the dynamic /loop now: call ScheduleWakeup with stop: true. ${tail}`);
  assert.equal(buildScheduledStopMessage({ jobIds: ['b2148320', '7b7cd8fc'], wakeup: true }), `Stop these loops now: call CronDelete once for each id: "b2148320", "7b7cd8fc"; then call ScheduleWakeup with stop: true. ${tail}`);
});

test('only a job with the CLI\'s eight-digit hex id, or a wake-up chain, can be stopped', () => {
  for (const id of ['cron:b2148320', 'wakeup:toolu_vrtx_01XmrNNf2aA6qGMkfWkfZZJF', `wakeup:${'a'.repeat(128)}`]) {
    assert.equal(isStoppableScheduledWorkId(id), true, id);
  }
  for (const id of ['cron:call:toolu_1', 'cron:B2148320', 'cron:b214832', 'cron:b2148320 ', 'wakeup:', `wakeup:${'a'.repeat(129)}`, 'wakeup:a b', 'wf1', null]) {
    assert.equal(isStoppableScheduledWorkId(id), false, String(id));
  }
});

// ---------------------------------------------------------------------------
// The record object, driven as the runtime drives it.
// ---------------------------------------------------------------------------

type Work = ReturnType<typeof createScheduledWork>;

function createWork(t: import('node:test').TestContext, start: number, overrides: Record<string, number> = {}) {
  let now = start;
  t.mock.method(Date, 'now', () => now);
  const logs: string[] = [];
  const work = createScheduledWork({
    holdMaxMs: HOLD_MAX,
    scheduleHoldMaxMs: DEFAULT_SCHEDULE_HOLD_MAX_MS,
    graceMs: GRACE,
    log: (line: string) => { logs.push(line); },
    ...overrides,
  });
  return {
    work,
    logs,
    now: () => now,
    setNow: (time: number) => { now = time; },
  };
}

/** A CronCreate whose result names the time the CLI works out (called a few ms before it). */
function createJob(work: Work, now: number, jobId: string, cron: string, { recurring = true, nextFireAt }: { recurring?: boolean; nextFireAt?: number | null } = {}) {
  const reported = nextFireAt === undefined ? nextScheduledFire({ cron, recurring, id: jobId, createdAt: now - 5 }) : nextFireAt;
  work.noteCronCreated({
    toolUseId: `toolu_${jobId}`,
    jobId,
    input: { cron, prompt: `job ${jobId}`, recurring },
    output: { id: jobId, humanSchedule: 'Every 5 minutes', recurring, durable: false, ...(reported === null ? {} : { nextFireAt: reported }) },
    calledAt: now - 5,
  });
}

const listed = (work: Work) => work.list().map((item) => `${item.id}@${item.nextFireAt}`);
const nextOf = (work: Work, id: string) => work.list().find((item) => item.id === id)?.nextFireAt;

test('a */5 job is matched to each of five fires that come 50 ms late, and its next time counts from each', (t) => {
  const start = local(2026, 9, 30, 14, 2, 30);
  const { work, setNow } = createWork(t, start);
  createJob(work, start, 'b2148320', '*/5 * * * *');
  let next = nextOf(work, 'cron:b2148320') as number;
  assert.equal(next, start - 5 + 285 * SECOND);
  let turnEnded = start + 2 * SECOND;
  for (let fire = 1; fire <= 5; fire += 1) {
    const firedAt = next + 50;
    setNow(firedAt);
    work.noteCronFire(firedAt, turnEnded);
    next = nextOf(work, 'cron:b2148320') as number;
    assert.equal(next, firedAt + 285 * SECOND, `fire ${fire}`);
    turnEnded = firedAt + 3 * SECOND;
  }
});

test('two jobs that fire in turn are each matched to their own fires', (t) => {
  const start = local(2026, 9, 30, 14, 0, 30);
  const { work, setNow } = createWork(t, start);
  createJob(work, start, '40000000', '*/2 * * * *');
  createJob(work, start, 'c0000000', '1-59/2 * * * *');
  const order: string[] = [];
  for (let fire = 0; fire < 4; fire += 1) {
    const due = work.list().filter((item) => item.nextFireAt !== null).sort((a, b) => (a.nextFireAt as number) - (b.nextFireAt as number))[0];
    const firedAt = (due.nextFireAt as number) + 800;
    setNow(firedAt);
    work.noteCronFire(firedAt, firedAt - 30 * SECOND);
    order.push(due.id);
    const after = work.list().find((item) => item.id === due.id);
    assert.equal(after?.nextFireAt, nextScheduledFire({ cron: after?.cron as string, recurring: true, id: due.id.slice(5), createdAt: start, lastFiredAt: firedAt }), `fire ${fire}`);
  }
  assert.deepEqual(order, ['cron:c0000000', 'cron:40000000', 'cron:c0000000', 'cron:40000000']);
});

test('two jobs that fire on the same tick are both matched, whichever takes which', (t) => {
  const start = local(2026, 9, 30, 14, 2, 30);
  const { work, setNow } = createWork(t, start);
  createJob(work, start, '11111111', '*/5 * * * *');
  createJob(work, start, '22222222', '*/5 * * * *');
  const firedAt = start - 5 + 285 * SECOND + 400;
  setNow(firedAt);
  work.noteCronFire(firedAt, start);
  work.noteCronFire(firedAt + 2, start);
  const nexts = work.list().map((item) => item.nextFireAt as number).sort((first, second) => first - second);
  assert.deepEqual(nexts.map((time) => time - firedAt), [285 * SECOND, 285 * SECOND + 2]);
});

test('a job whose result names a time the defaults do not give is shown with that time, then with none once it has fired', (t) => {
  const start = local(2026, 9, 30, 14, 2, 30);
  const { work, setNow } = createWork(t, start);
  const reported = start + 7 * MINUTE;
  createJob(work, start, 'b2148320', '*/5 * * * *', { nextFireAt: reported });
  assert.equal(nextOf(work, 'cron:b2148320'), reported);
  setNow(reported + 900);
  work.noteCronFire(reported + 900, start);
  assert.equal(nextOf(work, 'cron:b2148320'), null);
  assert.equal(work.holdsProcess(), true, 'a job with no known time still holds the process, up to its hold limit');
});

test('a recurring job\'s first fire seven days after its creation is its last', (t) => {
  // A week with no daylight saving change in either hemisphere.
  const start = local(2026, 6, 6, 14, 0, 30);
  const { work, logs, setNow } = createWork(t, start);
  createJob(work, start, '00000000', '0 * * * *');
  let fires = 0;
  let lastFiredAt = 0;
  while (work.list().length > 0 && fires < 200) {
    lastFiredAt = (nextOf(work, 'cron:00000000') as number) + 500;
    setNow(lastFiredAt);
    work.noteCronFire(lastFiredAt, lastFiredAt - 30 * MINUTE);
    fires += 1;
  }
  // Hourly from 15:00, the fire at 14:00 a week on is still short of seven
  // days; the one at 15:00 is past them, and the last.
  assert.equal(fires, 7 * 24 + 1);
  assert.equal(at(lastFiredAt), at(local(2026, 6, 13, 15) + 500));
  assert.equal(logs.filter((line) => line.includes('fired for the last time')).length, 1);
});

test('a job that never fires is dropped once missed', (t) => {
  const start = local(2026, 9, 30, 14, 2, 30);
  const { work, logs, setNow } = createWork(t, start);
  createJob(work, start, 'b2148320', '*/5 * * * *');
  const due = nextOf(work, 'cron:b2148320') as number;
  const turnEnded = start + 2 * SECOND;
  setNow(due + GRACE - 1);
  work.cleanUp(due + GRACE - 1, { inTurn: false, lastTurnEndedAt: turnEnded });
  assert.equal(work.list().length, 1);
  setNow(due + GRACE);
  work.cleanUp(due + GRACE, { inTurn: false, lastTurnEndedAt: turnEnded });
  assert.deepEqual(listed(work), []);
  assert.equal(logs.filter((line) => line.includes('did not fire')).length, 1);
});

test('a job that looks missed takes a fire no job was matched to first, and is kept when its next fire counts from it', (t) => {
  const start = local(2026, 9, 30, 14, 2, 30);
  const { work, logs, setNow } = createWork(t, start);
  createJob(work, start, 'b2148320', '*/5 * * * *');
  const due = nextOf(work, 'cron:b2148320') as number;
  // The CLI fired it a minute early: no job was due then.
  const early = due - MINUTE;
  setNow(early);
  work.noteCronFire(early, start + 2 * SECOND);
  assert.equal(nextOf(work, 'cron:b2148320'), due, 'not matched: it was not due yet');
  setNow(due + GRACE);
  work.cleanUp(due + GRACE, { inTurn: false, lastTurnEndedAt: early + 2 * SECOND });
  assert.equal(nextOf(work, 'cron:b2148320'), early + 285 * SECOND, 'the early fire was its own');
  assert.deepEqual(logs, []);
  // The fire is used up: missed again, the job is dropped.
  setNow(due + 2 * GRACE);
  work.cleanUp(due + 2 * GRACE, { inTurn: false, lastTurnEndedAt: early + 2 * SECOND });
  assert.deepEqual(listed(work), []);
});

test('missing counts from the end of the CLI\'s last turn, and not at all while it runs one', (t) => {
  const start = local(2026, 9, 30, 14, 2, 30);
  const { work, setNow } = createWork(t, start);
  createJob(work, start, 'b2148320', '*/5 * * * *');
  const due = nextOf(work, 'cron:b2148320') as number;
  // A turn handed to the process runs from before the job is due to 20 minutes after.
  setNow(due + 10 * MINUTE);
  work.cleanUp(due + 10 * MINUTE, { inTurn: true, lastTurnEndedAt: start });
  assert.equal(work.list().length, 1, 'the CLI fires nothing while it runs a turn');
  assert.equal(work.nextCheckAt({ inTurn: true, lastTurnEndedAt: start }), start + DEFAULT_SCHEDULE_HOLD_MAX_MS, 'only the hold limit counts then');
  const turnEnded = due + 20 * MINUTE;
  assert.equal(work.nextCheckAt({ inTurn: false, lastTurnEndedAt: turnEnded }), turnEnded + GRACE);
  setNow(turnEnded + GRACE - 1);
  work.cleanUp(turnEnded + GRACE - 1, { inTurn: false, lastTurnEndedAt: turnEnded });
  assert.equal(work.list().length, 1);
  setNow(turnEnded + GRACE);
  work.cleanUp(turnEnded + GRACE, { inTurn: false, lastTurnEndedAt: turnEnded });
  assert.equal(work.list().length, 0);
});

test('work is dropped at its hold limit, and work due after it is listed but holds nothing', (t) => {
  const start = local(2026, 9, 30, 14, 2, 30);
  const { work, logs, setNow } = createWork(t, start, { scheduleHoldMaxMs: 2 * DAY });
  // Every 1 January: its next fire is past the two-day limit.
  createJob(work, start, '00000000', '0 0 1 1 *');
  assert.equal(work.list().length, 1);
  assert.equal(work.holdsProcess(), false);
  createJob(work, start, '11111111', '0 * * * *');
  assert.equal(work.holdsProcess(), true);
  assert.equal(work.list().find((item) => item.id === 'cron:11111111')?.holdUntil, start + 2 * DAY);
  // A wake-up chain started now: renewed for two days, its last wake-up still before the limit.
  work.noteWakeupCall({ toolUseId: 'toolu_w1', input: { delaySeconds: 3600, prompt: 'x' }, output: { scheduledFor: start + HOUR }, calledAt: start });
  setNow(start + 2 * DAY - HOUR);
  work.noteWakeupCall({ toolUseId: 'toolu_w2', input: { delaySeconds: 3600, prompt: 'x' }, output: { scheduledFor: start + 2 * DAY - MINUTE }, calledAt: start + 2 * DAY - HOUR });
  assert.equal(work.list().find((item) => item.kind === 'wakeup')?.holdUntil, start + 2 * DAY);
  setNow(start + 2 * DAY);
  work.cleanUp(start + 2 * DAY, { inTurn: true, lastTurnEndedAt: start });
  assert.deepEqual(listed(work), []);
  assert.equal(logs.filter((line) => line.includes('hold limit')).length, 3);
});

test('a job whose result names no time is shown, held for HOLD_MAX and cannot be stopped; a one-shot one goes with the next fire', (t) => {
  const start = local(2026, 9, 30, 14, 2, 30);
  const { work } = createWork(t, start);
  work.noteCronCreated({ toolUseId: 'toolu_old', jobId: null, input: { cron: '*/5 * * * *', prompt: 'check' }, output: null, calledAt: start });
  work.noteCronCreated({ toolUseId: 'toolu_once', jobId: null, input: { cron: '30 15 30 10 *', prompt: 'remind', recurring: false }, output: null, calledAt: start });
  const [recurring, oneShot] = work.list();
  assert.deepEqual([recurring.id, recurring.nextFireAt, recurring.holdUntil, recurring.recurring], ['cron:call:toolu_old', null, start + HOLD_MAX, true]);
  assert.deepEqual([oneShot.id, oneShot.recurring], ['cron:call:toolu_once', false]);
  assert.equal(work.stopTargets('cron:call:toolu_old'), null);
  assert.equal(work.nextCheckAt({ inTurn: false, lastTurnEndedAt: start }), start + HOLD_MAX);
  work.noteCronFire(start + MINUTE, start);
  assert.deepEqual(work.list().map((item) => item.id), ['cron:call:toolu_old']);
});

test('a recurring job whose result names no time is held HOLD_MAX past each turn that may have been its fire, and no longer than the schedule limit past its creation', (t) => {
  const start = local(2026, 9, 30, 14, 2, 30);
  const { work, logs, setNow } = createWork(t, start, { scheduleHoldMaxMs: 2 * DAY });
  work.noteCronCreated({ toolUseId: 'toolu_old', jobId: null, input: { cron: '0 */5 * * *', prompt: 'check' }, output: null, calledAt: start });
  // Daily at 00:00 plus its lag: due before ten in the morning.
  createJob(work, start, 'b2148320', '0 0 * * *');
  const daily = nextOf(work, 'cron:b2148320') as number;
  const heldFor = () => work.list().map((item) => `${item.id}+${(item.holdUntil - start) / MINUTE}m`);
  assert.deepEqual(heldFor(), [`cron:call:toolu_old+${HOLD_MAX / MINUTE}m`, `cron:b2148320+${2 * DAY / MINUTE}m`]);

  // A fire no job with a known time takes, its turn over 20 s later.
  setNow(start + 3 * HOUR + 20 * SECOND);
  work.noteCronFire(start + 3 * HOUR, start + 2 * SECOND);
  assert.equal(heldFor()[0], `cron:call:toolu_old+${(3 * HOUR + 20 * SECOND + HOLD_MAX) / MINUTE}m`);
  // A turn of the CLI's own for no fire it named.
  setNow(start + 8 * HOUR);
  work.noteUnnamedFire(start + 8 * HOUR);
  assert.equal(heldFor()[0], `cron:call:toolu_old+${(8 * HOUR + HOLD_MAX) / MINUTE}m`);
  work.noteUnnamedFire(start + 5 * HOUR);
  assert.equal(heldFor()[0], `cron:call:toolu_old+${(8 * HOUR + HOLD_MAX) / MINUTE}m`, 'an earlier turn takes nothing off');
  // A fire the daily job takes is its own.
  setNow(daily + 30 * SECOND);
  work.noteCronFire(daily + 500, start + 8 * HOUR);
  assert.equal(nextOf(work, 'cron:b2148320') as number > daily + HOUR, true, 'the daily job took the fire');
  assert.equal(heldFor()[0], `cron:call:toolu_old+${(8 * HOUR + HOLD_MAX) / MINUTE}m`);
  // Near the limit, held up to it and no further.
  setNow(start + 2 * DAY - HOUR);
  work.noteUnnamedFire(start + 2 * DAY - HOUR);
  assert.deepEqual(heldFor(), [`cron:call:toolu_old+${2 * DAY / MINUTE}m`, `cron:b2148320+${2 * DAY / MINUTE}m`]);
  work.cleanUp(start + 2 * DAY - 1, { inTurn: false, lastTurnEndedAt: start + 2 * DAY - HOUR });
  assert.equal(work.list().some((item) => item.id === 'cron:call:toolu_old'), true);
  work.cleanUp(start + 2 * DAY, { inTurn: false, lastTurnEndedAt: start + 2 * DAY - HOUR });
  assert.equal(work.list().some((item) => item.id === 'cron:call:toolu_old'), false);
  assert.equal(logs.some((line) => line.includes('scheduled job from call toolu_old: it reached the hold limit')), true);

  // A schedule limit under HOLD_MAX bounds it from the start.
  const short = createWork(t, start, { scheduleHoldMaxMs: 2 * HOUR });
  short.work.noteCronCreated({ toolUseId: 'toolu_old', jobId: null, input: { cron: '*/5 * * * *', prompt: 'check' }, output: null, calledAt: start });
  assert.equal(short.work.list()[0]?.holdUntil, start + 2 * HOUR);
  short.setNow(start + HOUR);
  short.work.noteUnnamedFire(start + HOUR);
  assert.equal(short.work.list()[0]?.holdUntil, start + 2 * HOUR);
});

test('a job whose result names no time, recurring or one-shot, is held HOLD_MAX past anything said during a turn, up to the schedule limit', (t) => {
  const start = local(2026, 9, 30, 14, 2, 30);
  const { work, setNow } = createWork(t, start, { scheduleHoldMaxMs: 2 * DAY });
  work.noteCronCreated({ toolUseId: 'toolu_old', jobId: null, input: { cron: '0 */5 * * *', prompt: 'check' }, output: null, calledAt: start });
  work.noteCronCreated({ toolUseId: 'toolu_once', jobId: null, input: { cron: '30 15 31 10 *', prompt: 'remind', recurring: false }, output: null, calledAt: start });
  createJob(work, start, 'b2148320', '0 0 * * *');
  const heldFor = () => work.list().map((item) => `${item.id}+${(item.holdUntil - start) / HOUR}h`);

  // A turn still talking thirteen hours on, past HOLD_MAX from the jobs' creation.
  setNow(start + 13 * HOUR);
  work.noteTurnActivity(start + 13 * HOUR);
  assert.deepEqual(heldFor(), ['cron:call:toolu_old+25h', 'cron:call:toolu_once+25h', 'cron:b2148320+48h']);
  work.cleanUp(start + 13 * HOUR, { inTurn: true, lastTurnEndedAt: start });
  assert.equal(work.list().length, 3, 'nothing reached its hold limit');
  work.noteTurnActivity(start + 10 * HOUR);
  assert.deepEqual(heldFor(), ['cron:call:toolu_old+25h', 'cron:call:toolu_once+25h', 'cron:b2148320+48h'], 'an earlier time takes nothing off');

  setNow(start + 47 * HOUR);
  work.noteTurnActivity(start + 47 * HOUR);
  assert.deepEqual(heldFor(), ['cron:call:toolu_old+48h', 'cron:call:toolu_once+48h', 'cron:b2148320+48h'], 'no longer than the schedule limit');
});

test('a one-shot job is not matched to a fire ahead of the time its result named, but to its own fire, and gone', (t) => {
  const start = local(2026, 9, 30, 14, 10);
  const { work, setNow } = createWork(t, start);
  createJob(work, start, '80000000', '30 15 30 10 *', { recurring: false });
  const due = nextOf(work, 'cron:80000000') as number;
  assert.equal(due, local(2026, 9, 30, 15, 30) - 45 * SECOND);
  setNow(due - 10 * SECOND);
  work.noteCronFire(due - 10 * SECOND, start);
  setNow(due - 4 * SECOND);
  work.noteCronFire(due - 4 * SECOND, start);
  assert.deepEqual(listed(work), [`cron:80000000@${due}`], 'the CLI never fires a job before the time it named: those fires were another\'s');
  setNow(due + 600);
  work.noteCronFire(due + 600, start);
  assert.deepEqual(listed(work), []);

  // A fire four seconds ahead is kept for the job, should it turn out to
  // have missed (the CLI's settings changed).
  const early = createWork(t, start);
  createJob(early.work, start, '80000000', '30 15 30 10 *', { recurring: false });
  early.setNow(due - 4 * SECOND);
  early.work.noteCronFire(due - 4 * SECOND, start);
  assert.equal(early.work.list().length, 1);
  early.setNow(due + GRACE);
  early.work.cleanUp(due + GRACE, { inTurn: false, lastTurnEndedAt: due - 2 * SECOND });
  assert.deepEqual(listed(early.work), []);
  assert.deepEqual(early.logs, [], 'the kept fire was its own: nothing is dropped as missed');
});

test('a fire at one job\'s time goes to it, not to a one-shot job due three seconds later that has not fired', (t) => {
  const start = local(2026, 9, 29, 14, 28, 50);
  const { work, setNow } = createWork(t, start);
  createJob(work, start, 'd5555555', '* * * * *');
  setNow(start + 2 * SECOND);
  createJob(work, start + 2 * SECOND, '5b05b05b', '30 14 29 10 *', { recurring: false });
  const reminder = nextOf(work, 'cron:5b05b05b') as number;
  assert.equal(at(nextOf(work, 'cron:d5555555') as number), at(local(2026, 9, 29, 14, 29, 25)));
  assert.equal(at(reminder), at(local(2026, 9, 29, 14, 29, 28)));
  // The CLI's tick fires the every-minute job, and its turn takes 20 s.
  const firedAt = local(2026, 9, 29, 14, 29, 25) + 670;
  setNow(firedAt + 20 * SECOND);
  work.noteCronFire(firedAt, firedAt - 40 * SECOND);
  assert.equal(nextOf(work, 'cron:5b05b05b'), reminder, 'the reminder is still to fire');
  assert.equal(at(nextOf(work, 'cron:d5555555') as number), at(local(2026, 9, 29, 14, 30, 25)), 'the every-minute job counts its next fire from this one');
  // The reminder fires on the CLI's first tick once that turn is over.
  setNow(firedAt + 21 * SECOND);
  work.noteCronFire(firedAt + 21 * SECOND, firedAt + 20 * SECOND);
  assert.deepEqual(work.list().map((item) => item.id), ['cron:d5555555']);
  assert.equal(at(nextOf(work, 'cron:d5555555') as number), at(local(2026, 9, 29, 14, 30, 25)));
});

test('of two every-minute jobs due 1.25 s apart, each fire goes to the job whose time it is, round after round', (t) => {
  const start = local(2026, 9, 29, 14, 20, 10);
  const { work, setNow } = createWork(t, start);
  createJob(work, start, 'd5555555', '* * * * *');
  createJob(work, start, 'e0000000', '* * * * *');
  for (let minute = 21; minute <= 23; minute += 1) {
    const first = local(2026, 9, 29, 14, minute, 25);
    const second = first + 1250;
    assert.deepEqual([nextOf(work, 'cron:d5555555'), nextOf(work, 'cron:e0000000')], [first, second], `before the fires at 14:${minute}`);
    setNow(first + 670);
    work.noteCronFire(first + 670, first - 30 * SECOND);
    assert.equal(nextOf(work, 'cron:e0000000'), second, `the first fire at 14:${minute} is not the second job's`);
    setNow(second + 670);
    work.noteCronFire(second + 670, first + 670 + SECOND);
  }
  assert.deepEqual(
    [nextOf(work, 'cron:d5555555'), nextOf(work, 'cron:e0000000')],
    [local(2026, 9, 29, 14, 24, 25), local(2026, 9, 29, 14, 24, 25) + 1250],
  );
});

test('a fire the run does not know of, three seconds before the only reminder is due, leaves the reminder holding the process', (t) => {
  const start = local(2026, 9, 29, 14, 20, 12);
  const { work, setNow } = createWork(t, start);
  createJob(work, start, '5b05b05b', '30 14 29 10 *', { recurring: false });
  const reminder = nextOf(work, 'cron:5b05b05b') as number;
  // A job the CLI revived on resume, or one an agent created, fires.
  const unknown = reminder - 3 * SECOND + 670;
  setNow(unknown + 20 * SECOND);
  work.noteCronFire(unknown, null);
  assert.equal(nextOf(work, 'cron:5b05b05b'), reminder);
  assert.equal(work.holdsProcess(), true);
});

test('a fire heard a little before the worked-out times of two jobs goes to the one due first', (t) => {
  const start = local(2026, 9, 29, 14, 20, 10);
  const { work, setNow } = createWork(t, start);
  createJob(work, start, 'd5555555', '* * * * *');
  createJob(work, start, 'e0000000', '* * * * *');
  // Each fires once on its time; their next times count from when the run heard them.
  const first = local(2026, 9, 29, 14, 21, 25);
  setNow(first + 600);
  work.noteCronFire(first + 600, first - 30 * SECOND);
  setNow(first + 1250 + 600);
  work.noteCronFire(first + 1250 + 600, first + 2 * SECOND);
  const nextFirst = nextOf(work, 'cron:d5555555') as number;
  const nextSecond = nextOf(work, 'cron:e0000000') as number;
  assert.deepEqual([nextFirst, nextSecond], [local(2026, 9, 29, 14, 22, 25), local(2026, 9, 29, 14, 22, 25) + 1250]);
  // A fire heard just before both worked-out times is the next one due.
  setNow(nextFirst - 400);
  work.noteCronFire(nextFirst - 400, nextFirst - 30 * SECOND);
  assert.equal(nextOf(work, 'cron:e0000000'), nextSecond, 'the second job\'s time has not come');
  assert.notEqual(nextOf(work, 'cron:d5555555'), nextFirst);
});

test('a */5 fire heard a little before the time the run worked out from its last fire is still its own', (t) => {
  const start = local(2026, 9, 30, 14, 2, 30);
  const { work, setNow } = createWork(t, start);
  createJob(work, start, 'b2148320', '*/5 * * * *');
  // Heard 40 ms after the CLI's tick: the next time the run works out is 40 ms
  // later than the CLI's, which counts from the tick.
  const firstFire = (nextOf(work, 'cron:b2148320') as number) + 40;
  setNow(firstFire + 3 * SECOND);
  work.noteCronFire(firstFire, firstFire - MINUTE);
  const secondFire = (nextOf(work, 'cron:b2148320') as number) - 35;
  setNow(secondFire + 3 * SECOND);
  work.noteCronFire(secondFire, firstFire + 3 * SECOND);
  assert.equal(nextOf(work, 'cron:b2148320'), secondFire + 285 * SECOND);
});

test('a fire goes to the job due latest of those due by then, and not to one already missed by then', (t) => {
  const start = local(2026, 9, 30, 14, 0, 30);
  const { work, setNow } = createWork(t, start);
  createJob(work, start, '00000000', '*/2 * * * *');
  createJob(work, start, '00000001', '*/3 * * * *');
  const twoMinute = nextOf(work, 'cron:00000000') as number;
  const threeMinute = nextOf(work, 'cron:00000001') as number;
  assert.equal(threeMinute - twoMinute, MINUTE);
  // A turn ran past both: the CLI fires once it is over.
  const firedAt = threeMinute + 2 * SECOND;
  setNow(firedAt);
  work.noteCronFire(firedAt, threeMinute + SECOND);
  assert.equal(nextOf(work, 'cron:00000000'), twoMinute, 'the job due earlier waits for a fire of its own');
  assert.notEqual(nextOf(work, 'cron:00000001'), threeMinute);

  // A job missed by the time of a fire does not take it: the fire is kept,
  // and only cleanUp, finding the job missed, puts it down to it.
  const late = createWork(t, start);
  createJob(late.work, start, '00000000', '*/2 * * * *');
  const due = nextOf(late.work, 'cron:00000000') as number;
  const lateFire = due + GRACE + SECOND;
  late.setNow(lateFire);
  late.work.noteCronFire(lateFire, start + SECOND);
  assert.equal(nextOf(late.work, 'cron:00000000'), due);
  late.setNow(lateFire + GRACE + 2 * SECOND);
  late.work.cleanUp(lateFire + GRACE + 2 * SECOND, { inTurn: false, lastTurnEndedAt: lateFire + SECOND });
  assert.equal(nextOf(late.work, 'cron:00000000'), nextScheduledFire({ cron: '*/2 * * * *', recurring: true, id: '00000000', createdAt: start, lastFiredAt: lateFire }));
});

test('a reminder set during a fire\'s turn is not taken for that fire, even one due a second later', (t) => {
  const firedAt = local(2026, 9, 30, 14, 0, 59);
  const { work, setNow } = createWork(t, firedAt);
  setNow(firedAt + 500);
  createJob(work, firedAt + 500, '00000001', '1 14 30 10 *', { recurring: false });
  const due = nextOf(work, 'cron:00000001') as number;
  assert.equal(due, local(2026, 9, 30, 14, 1));
  work.noteCronFire(firedAt, firedAt - MINUTE);
  assert.equal(nextOf(work, 'cron:00000001'), due, 'it was created after that fire started');
  setNow(due + 500);
  work.noteCronFire(due + 500, firedAt + 2 * SECOND);
  assert.deepEqual(listed(work), [], 'its own fire takes it');
});

test('a wake-up chain keeps its id through each wake-up it sets, and ends with stop, with a result that sets none, or with a fire that sets none', (t) => {
  const start = local(2026, 9, 30, 14, 0, 10);
  const { work, setNow } = createWork(t, start);
  const arm = (toolUseId: string, scheduledFor: number, reason = 'polling') => work.noteWakeupCall({
    toolUseId,
    input: { delaySeconds: 60, prompt: '<<autonomous-loop-dynamic>>', reason },
    output: { scheduledFor, clampedDelaySeconds: 60, wasClamped: false },
    calledAt: Date.now(),
  });
  arm('toolu_w1', local(2026, 9, 30, 14, 2));
  setNow(start + 2 * MINUTE);
  arm('toolu_w2', local(2026, 9, 30, 14, 4), 'still building');
  const [wakeup] = work.list();
  assert.deepEqual(
    [wakeup.id, wakeup.kind, wakeup.toolUseId, wakeup.prompt, wakeup.startedAt, wakeup.nextFireAt, wakeup.recurring, wakeup.holdUntil, wakeup.reason],
    ['wakeup:toolu_w1', 'wakeup', 'toolu_w2', '/loop', start, local(2026, 9, 30, 14, 4), true, start + DEFAULT_SCHEDULE_HOLD_MAX_MS, 'still building'],
  );
  // A fire for the time the first one was set for leaves the second.
  work.noteWakeupFire(local(2026, 9, 30, 14, 2));
  assert.equal(work.list().length, 1);
  work.noteWakeupFire(local(2026, 9, 30, 14, 4));
  assert.equal(work.list().length, 0, 'its fire takes it');

  arm('toolu_w3', local(2026, 9, 30, 14, 6));
  assert.equal(work.list()[0]?.id, 'wakeup:toolu_w3', 'a wake-up with none pending starts a new chain');
  work.noteWakeupCall({ toolUseId: 'toolu_stop', input: { stop: true }, output: { scheduledFor: 0, stopped: true, cancelledWakeups: 1 }, calledAt: Date.now() });
  assert.equal(work.list().length, 0);

  arm('toolu_w4', local(2026, 9, 30, 14, 6));
  work.noteWakeupCall({ toolUseId: 'toolu_w5', input: { delaySeconds: 60, prompt: 'x' }, output: { scheduledFor: 0, clampedDelaySeconds: 0, wasClamped: false }, calledAt: Date.now() });
  assert.equal(work.list().length, 0, 'the CLI set none: the loop reached its maximum duration');
  assert.equal(work.holdsProcess(), false);
});

test('the work is listed oldest first with what the client shows, and stopTargets picks what a stop names', (t) => {
  const start = local(2026, 9, 30, 14, 2, 30);
  const { work, setNow } = createWork(t, start);
  work.noteWakeupCall({ toolUseId: 'toolu_w1', input: { delaySeconds: 600, prompt: 'check the deploy\nthen report', reason: '' }, output: { scheduledFor: start + 10 * MINUTE }, calledAt: start });
  setNow(start + SECOND);
  createJob(work, start + SECOND, 'b2148320', '*/5 * * * *');
  setNow(start + 2 * SECOND);
  work.noteCronCreated({
    toolUseId: 'toolu_once',
    jobId: '7b7cd8fc',
    input: { cron: '30 15 30 10 *', prompt: 'remind me', recurring: false, durable: true },
    output: { id: '7b7cd8fc', humanSchedule: 'Oct 30 at 3:30 PM', recurring: false, durable: true, nextFireAt: local(2026, 9, 30, 15, 30) },
    calledAt: start + 2 * SECOND,
  });
  const [wakeup, recurring, oneShot] = work.list();
  assert.equal(wakeup.id, 'wakeup:toolu_w1');
  assert.equal(wakeup.prompt, 'check the deploy');
  assert.equal('reason' in wakeup, false, 'no reason given, none listed');
  assert.deepEqual(
    [recurring.id, recurring.kind, recurring.toolUseId, recurring.prompt, recurring.cron, recurring.cadence, recurring.expiresAt, recurring.durable, recurring.recurring],
    ['cron:b2148320', 'cron', 'toolu_b2148320', 'job b2148320', '*/5 * * * *', 'Every 5 minutes', start + SECOND + 7 * DAY, false, true],
  );
  assert.deepEqual([oneShot.id, oneShot.recurring, oneShot.durable, 'expiresAt' in oneShot, oneShot.cadence], ['cron:7b7cd8fc', false, true, false, 'Oct 30 at 3:30 PM']);

  assert.deepEqual(work.stopTargets('cron:b2148320'), [{ id: 'cron:b2148320', kind: 'cron', jobId: 'b2148320' }]);
  assert.deepEqual(work.stopTargets('wakeup:toolu_w1', { all: true })?.map((target) => target.id), ['cron:b2148320', 'cron:7b7cd8fc', 'wakeup:toolu_w1']);
  assert.equal(work.stopTargets('cron:00000000'), null);
  assert.equal(work.hasCronJobs(), true);
  work.noteCronDeleted('b2148320');
  work.noteCronDeleted('7b7cd8fc');
  assert.equal(work.hasCronJobs(), false);
  work.clear();
  assert.deepEqual(work.list(), []);
});
