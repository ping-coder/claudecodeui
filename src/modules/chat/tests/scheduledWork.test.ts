import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { i18n } from '@/modules/i18n';
import {
  canStopScheduledWork,
  describeScheduledCadence,
  describeScheduledTiming,
  describeScheduledWorkDetails,
  formatScheduledTime,
  holdsOnlyScheduledWork,
  stopReleasesProcess,
} from '@/modules/chat/utils/scheduledWork';
import { stripBidiIsolates } from '@/shared/direction';
import type { ScheduledWorkSummary } from '@/shared/types';
import { countScheduledWork, describeScheduledWork, parseScheduledWork } from '@/shared/utils';

/**
 * A /loop or a reminder holds the session's Claude process, and the strip,
 * the details panel and the activity tab now say so: what it is, how often it
 * runs (worded from its cron expression, in the interface language, with no
 * hour, as the expression is in the server's time) and when it runs next
 * (told from its time in the browser's time zone: today, tomorrow, a date).
 */

const en = i18n.getFixedT('en', 'chat');
const zh = i18n.getFixedT('zh-CN', 'chat');
const he = i18n.getFixedT('he', 'chat');

// Local times, so the days fall the same in any time zone.
const NOW = new Date(2026, 9, 29, 10, 0).getTime();
const at = (day: number, hour: number, minute = 0, month = 9, year = 2026) => new Date(year, month, day, hour, minute).getTime();

const cron = (overrides: Partial<ScheduledWorkSummary> = {}): ScheduledWorkSummary => ({
  id: 'cron:b2148320',
  kind: 'cron',
  toolUseId: 'toolu_cron_1',
  prompt: 'check CI',
  startedAt: NOW - 60_000,
  nextFireAt: at(29, 14, 5),
  recurring: true,
  holdUntil: NOW + 8 * 86_400_000,
  cron: '*/5 * * * *',
  cadence: 'Every 5 minutes',
  ...overrides,
});

const wakeup = (overrides: Partial<ScheduledWorkSummary> = {}): ScheduledWorkSummary => ({
  id: 'wakeup:toolu_wake_1',
  kind: 'wakeup',
  toolUseId: 'toolu_wake_3',
  prompt: 'check the deploy',
  startedAt: NOW - 600_000,
  nextFireAt: at(29, 14, 5),
  recurring: true,
  holdUntil: NOW + 8 * 86_400_000,
  ...overrides,
});

const cadenceOf = (expression: string, t = en, locale = 'en') =>
  describeScheduledCadence(cron({ cron: expression, cadence: 'the CLI wording' }), t, locale);

describe('how often a piece of scheduled work runs', () => {
  test('words each cron shape a /loop or a reminder uses', () => {
    const rows: Array<[string, string]> = [
      ['* * * * *', 'Every minute'],
      ['*/1 * * * *', 'Every minute'],
      ['*/5 * * * *', 'Every 5 minutes'],
      ['7 * * * *', 'Every hour'],
      ['0 */1 * * *', 'Every hour'],
      ['0 */3 * * *', 'Every 3 hours'],
      ['30 9 * * *', 'Every day'],
      ['0 9 * * 1-5', 'Weekdays'],
      ['0 9 * * 1', 'Every Monday'],
      ['0 9 * * 0', 'Every Sunday'],
      ['0 9 * * 7', 'Every Sunday'],
      ['0 0 */1 * *', 'Every day'],
      ['0 0 */2 * *', 'Every 2 days'],
    ];
    assert.deepEqual(rows.map(([expression]) => [expression, cadenceOf(expression)]), rows);
  });

  test('falls back to the CLI\'s own wording for any other shape, else to the expression', () => {
    assert.equal(cadenceOf('0 9,17 * * *'), 'the CLI wording');
    assert.equal(cadenceOf('0 9 1 * *'), 'the CLI wording', 'monthly');
    assert.equal(cadenceOf('0 9 * 3 *'), 'the CLI wording', 'one month');
    assert.equal(cadenceOf('*/90 * * * *'), 'the CLI wording');
    assert.equal(cadenceOf('0 * * * 1'), 'the CLI wording', 'hourly on Mondays');
    assert.equal(describeScheduledCadence(cron({ cron: '0 9,17 * * *', cadence: undefined }), en), '0 9,17 * * *');
  });

  test('a self-paced loop paces itself', () => {
    assert.equal(describeScheduledCadence(wakeup(), en), 'Self-paced');
  });

  test('speaks the interface language, weekdays included', () => {
    assert.equal(cadenceOf('*/5 * * * *', zh, 'zh-CN'), '每 5 分钟');
    assert.equal(cadenceOf('0 9 * * 1', zh, 'zh-CN'), '每星期一');
    assert.equal(cadenceOf('0 9 * * 1-5', zh, 'zh-CN'), '工作日');
    assert.equal(stripBidiIsolates(cadenceOf('0 9 * * 1', he, 'he')), 'כל יום שני');
  });
});

describe('when a piece of scheduled work runs next', () => {
  test('a time today, tomorrow, or further off with its date', () => {
    assert.equal(formatScheduledTime(at(29, 14, 5), NOW, en, 'en-GB'), '14:05');
    assert.equal(formatScheduledTime(at(30, 9), NOW, en, 'en-GB'), 'tomorrow 09:00');
    assert.equal(formatScheduledTime(at(3, 9, 0, 10), NOW, en, 'en-GB'), '3 Nov, 09:00');
    assert.equal(formatScheduledTime(at(2, 9, 0, 0, 2027), NOW, en, 'en-GB'), '2 Jan 2027, 09:00');
    assert.equal(formatScheduledTime(at(30, 9), NOW, zh, 'zh-CN'), '明天 09:00');
    assert.equal(formatScheduledTime(at(3, 9, 0, 10), NOW, zh, 'zh-CN'), '11月3日 09:00');
  });

  test('reads a loop\'s cadence and next run, a reminder\'s time, a self-paced loop\'s next wake-up', () => {
    const timing = (item: ScheduledWorkSummary, t = en, locale = 'en-GB') => describeScheduledTiming(item, NOW, t, locale).join(' · ');

    assert.equal(timing(cron()), 'Every 5 minutes · Next: 14:05');
    assert.equal(timing(cron({ recurring: false, cron: '30 14 29 10 *', nextFireAt: at(29, 14, 30) })), '14:30');
    assert.equal(timing(wakeup()), 'Self-paced · Next: 14:05');
    assert.equal(timing(cron({ nextFireAt: at(30, 9) })), 'Every 5 minutes · Next: tomorrow 09:00');
    assert.equal(timing(cron(), zh, 'zh-CN'), '每 5 分钟 · 下次 14:05');
  });

  test('says a time that has come is due now', () => {
    const due = NOW - 1_000;
    assert.deepEqual(describeScheduledTiming(cron({ nextFireAt: due }), NOW, en, 'en-GB'), ['Every 5 minutes', 'Due now']);
    assert.deepEqual(describeScheduledTiming(cron({ recurring: false, nextFireAt: due }), NOW, en, 'en-GB'), ['Due now']);
    assert.deepEqual(describeScheduledTiming(cron({ recurring: false, nextFireAt: NOW }), NOW, en, 'en-GB'), ['Due now'], 'due right now');
    assert.deepEqual(describeScheduledTiming(cron({ nextFireAt: NOW }), NOW, zh, 'zh-CN'), ['每 5 分钟', '即将触发']);
  });

  test('shows the cadence alone when the next run is unknown', () => {
    assert.deepEqual(describeScheduledTiming(cron({ nextFireAt: null }), NOW, en), ['Every 5 minutes']);
    assert.deepEqual(describeScheduledTiming(wakeup({ nextFireAt: null }), NOW, en), ['Self-paced']);
    assert.deepEqual(
      describeScheduledTiming(cron({ recurring: false, nextFireAt: null, cron: '30 14 29 10 *', cadence: 'Once at 14:30' }), NOW, en),
      ['Once at 14:30'],
    );
  });

  test('says a run due past the time CloudCLI holds the process for it will not happen', () => {
    const item = cron({ cron: '0 9 * * *', cadence: 'Every day at 9:00 AM', nextFireAt: at(8, 9, 0, 10), holdUntil: at(6, 10, 0, 10) });
    assert.deepEqual(describeScheduledTiming(item, NOW, en, 'en-GB'), ['Every day', 'Next: 8 Nov, 09:00', 'Past the hold limit, will not run']);
    assert.equal(describeScheduledTiming(cron({ holdUntil: at(29, 14, 5) }), NOW, en, 'en-GB').length, 2, 'due right at the limit still runs');
  });
});

describe('a piece of scheduled work in full, for the tooltip', () => {
  test('a cron job: its prompt, its expression and the CLI\'s wording in server time, its expiry, and where it is kept', () => {
    const details = describeScheduledWorkDetails(
      cron({ prompt: 'check CI and report back', expiresAt: at(5, 14, 3, 10), durable: true }),
      NOW,
      en,
      'en-GB',
    );
    assert.equal(details, [
      'check CI and report back',
      '*/5 * * * * · Every 5 minutes (server time)',
      'Expires 5 Nov, 14:03',
      'Kept in the project\'s .claude/scheduled_tasks.json',
    ].join('\n'));
  });

  test('a reminder has no expiry, and a self-paced loop gives its reason', () => {
    assert.equal(
      describeScheduledWorkDetails(cron({ recurring: false, cron: '30 14 29 10 *', cadence: 'Once', expiresAt: at(5, 14, 3, 10) }), NOW, en),
      'check CI\n30 14 29 10 * · Once (server time)',
    );
    assert.equal(describeScheduledWorkDetails(wakeup({ reason: 'waiting for the deploy' }), NOW, en), 'check the deploy\nReason: waiting for the deploy');
    assert.equal(describeScheduledWorkDetails(wakeup(), NOW, en), 'check the deploy');
  });
});

describe('what can be stopped, and how', () => {
  test('a cron job by its id, a self-paced loop by its first call; not a job an older CLI gave no id', () => {
    assert.equal(canStopScheduledWork(cron()), true);
    assert.equal(canStopScheduledWork(cron({ id: 'cron:call:toolu_cron_1' })), false);
    assert.equal(canStopScheduledWork(cron({ id: 'cron:b21483' })), false);
    assert.equal(canStopScheduledWork(wakeup()), true);
    assert.equal(canStopScheduledWork(wakeup({ id: 'wakeup:' })), false);
    assert.equal(canStopScheduledWork(cron({ id: 'wakeup:toolu_wake_1' })), false);
  });

  test('stopping only a self-paced loop of a process that holds nothing else lets the process go; anything else takes a turn', () => {
    assert.equal(stopReleasesProcess([wakeup()], [wakeup()], false), true);
    assert.equal(stopReleasesProcess([wakeup()], [wakeup()], true), false, 'a task keeps the process held');
    assert.equal(stopReleasesProcess([wakeup()], [wakeup(), cron()], false), false, 'a cron job stays in the transcript');
    assert.equal(stopReleasesProcess([cron()], [cron()], false), false);
  });

  test('a session busy with scheduled work alone, no task', () => {
    assert.equal(holdsOnlyScheduledWork({ tasks: [], scheduled: [cron()] }), true);
    assert.equal(holdsOnlyScheduledWork({ scheduled: [wakeup()] }), true);
    assert.equal(
      holdsOnlyScheduledWork({ tasks: [{ taskId: 't1', toolUseId: 'toolu_t1', taskType: 'local_bash', description: 'npm test', startedAt: 1 }], scheduled: [cron()] }),
      false,
    );
    assert.equal(holdsOnlyScheduledWork({ tasks: [], scheduled: [] }), false);
    assert.equal(holdsOnlyScheduledWork(null), false);
  });
});

describe('scheduled work by name and by count', () => {
  test('a loop or a reminder by its prompt', () => {
    assert.equal(describeScheduledWork(cron(), en), 'Loop check CI');
    assert.equal(describeScheduledWork(cron({ recurring: false, prompt: 'stretch' }), en), 'Reminder stretch');
    assert.equal(describeScheduledWork(wakeup(), zh), '循环 check the deploy');
    assert.equal(describeScheduledWork(cron({ recurring: false, prompt: '提醒伸展' }), zh), '定时 提醒伸展');
  });

  test('counts loops, or scheduled items once a reminder is among them', () => {
    assert.equal(countScheduledWork([cron(), wakeup()], en), '2 loops');
    assert.equal(countScheduledWork([cron(), cron({ recurring: false })], en), '2 scheduled items');
    assert.equal(countScheduledWork([cron(), wakeup(), cron()], zh), '3 个循环');
    assert.equal(countScheduledWork([cron({ recurring: false }), wakeup()], zh), '2 个定时项');
  });
});

describe('scheduled work off the wire', () => {
  test('keeps each item that has the shape the UI reads, its optional fields included', () => {
    const parsed = parseScheduledWork([
      { ...cron(), expiresAt: 5, durable: true },
      { ...wakeup(), nextFireAt: null, reason: 'pace' },
      { ...cron(), id: 'cron:bad', kind: 'interval' },
      { ...cron(), startedAt: 'yesterday' },
      { ...cron(), nextFireAt: undefined },
      { ...cron(), holdUntil: Number.NaN },
      null,
      'cron:b2148320',
    ]);
    assert.equal(JSON.stringify(parsed), JSON.stringify([
      { ...cron(), expiresAt: 5, durable: true },
      { ...wakeup(), nextFireAt: null, reason: 'pace' },
    ]));
  });

  test('drops fields of the wrong type, and reads no list as none reported', () => {
    const [item] = parseScheduledWork([{ ...cron(), cadence: 5, durable: 'yes', expiresAt: 'soon' }]) ?? [];
    assert.equal(JSON.stringify(item), JSON.stringify({ ...cron(), cadence: undefined }));
    assert.equal(parseScheduledWork(undefined), undefined);
    assert.equal(parseScheduledWork({ id: 'cron:b2148320' }), undefined);
  });
});

test('its strings are in English, Simplified Chinese and Hebrew', () => {
  const keys = [
    'scheduledWork.loop',
    'scheduledWork.reminder',
    'scheduledWork.kind.loop',
    'scheduledWork.kind.reminder',
    'scheduledWork.cadence.everyMinute',
    'scheduledWork.cadence.everyMinutes',
    'scheduledWork.cadence.hourly',
    'scheduledWork.cadence.everyHours',
    'scheduledWork.cadence.daily',
    'scheduledWork.cadence.weekdays',
    'scheduledWork.cadence.weekly',
    'scheduledWork.cadence.everyDays',
    'scheduledWork.selfPaced',
    'scheduledWork.next',
    'scheduledWork.dueNow',
    'scheduledWork.tomorrow',
    'scheduledWork.pastHold',
    'scheduledWork.serverSchedule',
    'scheduledWork.expires',
    'scheduledWork.durable',
    'scheduledWork.reason',
    'scheduledWork.listTitle',
    'scheduledWork.stop',
    'scheduledWork.stopAfterTurn',
    'scheduledWork.confirm.release',
    'scheduledWork.confirm.turnLoop',
    'scheduledWork.confirm.turnReminder',
    'scheduledWork.confirm.stop',
    'scheduledWork.confirm.cancel',
    'scheduledWork.confirm.stopAll',
    'scheduledWork.stopping',
    'scheduledWork.stopFailed',
    'shell.sessionBusy.reason.heldScheduled',
    'shell.sessionBusy.reason.backgroundScheduled',
    'claudeStatus.backgroundTask.prompt.descriptionScheduled',
  ];
  const plurals: Record<string, string[]> = { en: ['one', 'other'], 'zh-CN': ['other'], he: ['one', 'two', 'other'] };
  // Read from each language's own strings: a lookup would fall back to English.
  const missing = Object.entries(plurals).flatMap(([language, categories]) => [
    ...keys,
    ...categories.flatMap((category) => [`scheduledWork.count.loops_${category}`, `scheduledWork.count.items_${category}`]),
  ]
    .filter((key) => typeof i18n.getResource(language, 'chat', key) !== 'string')
    .map((key) => `${language} ${key}`));
  assert.deepEqual(missing, []);
});
