import type { TFunction } from 'i18next';

import type { ScheduledWorkSummary, SessionActivity } from '@/shared/types';

/*
 * How chat words the scheduled work (loops, reminders) a session's held
 * Claude process keeps: how often an item runs and when it runs next, for the
 * transcript's background-tasks strip and the activity tab's details panel,
 * and what the composer and the strip make of it. A cron expression is in
 * the server's local time, so a cadence names no hour of the day; times come
 * from `nextFireAt`, told in the browser's time zone. `locale` is the
 * interface language, which words the weekdays and the times.
 */

/**
 * Whether what keeps a session busy is only scheduled work (a /loop, a
 * reminder): no background task, and some scheduled work. A message has
 * nothing to queue behind then, as a loop can go on for days, so the
 * composer treats the session as idle: it neither offers to queue a send nor,
 * when a send would stop the work, lets the prompt queue it.
 */
export const holdsOnlyScheduledWork = (work: Pick<SessionActivity, 'tasks' | 'scheduled'> | null | undefined): boolean =>
  Boolean(work && !work.tasks?.length && work.scheduled?.length);

/** The ids `chat.stop-task` can stop: a cron job's 8 hex digits, or a wake-up loop's first call id. */
const STOPPABLE_CRON_ID = /^cron:[0-9a-f]{8}$/i;
const STOPPABLE_WAKEUP_ID = /^wakeup:[\w-]{1,128}$/;

/**
 * Whether an item can be stopped from here. A job an older CLI reported no
 * id for (`cron:call:<toolUseId>`) cannot: there is nothing to cancel it by.
 */
export const canStopScheduledWork = (item: ScheduledWorkSummary): boolean =>
  (item.kind === 'wakeup' ? STOPPABLE_WAKEUP_ID : STOPPABLE_CRON_ID).test(item.id);

/** Whether any of the items is paused: a restart of the server left it with no process (see ScheduledWorkSummary). */
export const hasPausedScheduledWork = (items: readonly ScheduledWorkSummary[]): boolean =>
  items.some((item) => item.paused === true);

/**
 * Whether stopping `targets` lets go of the session's process rather than
 * running a turn, by the server's rule as far as this page can see: only a
 * wake-up is stopped, and the process keeps nothing else, no task
 * (`hasTasks`) and no cron job among `scheduled`. The server may know of more
 * (a task report it has yet to relay, a Monitor), and its answer is what
 * counts. Paused work has no process to let go of: stopping it always takes
 * a turn.
 */
export const stopReleasesProcess = (
  targets: readonly ScheduledWorkSummary[],
  scheduled: readonly ScheduledWorkSummary[],
  hasTasks: boolean,
): boolean => !hasTasks
  && !hasPausedScheduledWork(targets)
  && [...targets, ...scheduled].every((item) => item.kind === 'wakeup');

/**
 * A /loop command at the start of a prompt: `/loop`, and the interval when it opens with one as
 * the CLI reads it (`1m`, `2h`); what follows is what the loop runs. A loop whose prompt is
 * "/loop 1m Reply…" makes a loop whose prompt is "Reply…" each time it fires.
 */
const LOOP_COMMAND = /^\/loop(?:\s+\d+[smhd])?\s+/;

/** The longest prompt the server lists (its first line, in characters); a longer one is cut there. */
const LISTED_PROMPT_MAX_CHARS = 200;

/** A prompt as two items are compared by: whitespace folded, ends trimmed, any leading /loop command dropped. */
const promptKey = (prompt: string): string => {
  let key = prompt.replace(/\s+/g, ' ').trim();
  while (LOOP_COMMAND.test(key)) {
    key = key.replace(LOOP_COMMAND, '');
  }
  return key;
};

/** Whether the server cut this prompt at its limit, so only its start is known. */
const isCutPrompt = (prompt: string): boolean => Array.from(prompt).length >= LISTED_PROMPT_MAX_CHARS;

/**
 * Whether two items run the same prompt, by promptKey. A prompt the server cut matches one that
 * starts with what it kept: "/loop 1m " takes 9 of the 200 characters the loop that made the
 * other one is listed with.
 */
const isSamePrompt = (left: ScheduledWorkSummary, right: ScheduledWorkSummary): boolean => {
  const leftKey = promptKey(left.prompt);
  const rightKey = promptKey(right.prompt);
  if (!leftKey || !rightKey) {
    return false;
  }
  return leftKey === rightKey
    || (isCutPrompt(left.prompt) && rightKey.startsWith(leftKey))
    || (isCutPrompt(right.prompt) && leftKey.startsWith(rightKey));
};

/**
 * How many of `items`, `item` aside, are the same kind of work (a loop, or a reminder) with the
 * same prompt (isSamePrompt). A model that writes /loop into a loop's own prompt adds another
 * such loop every time it runs, so the strip's question to stop one says how many more there are.
 */
export const countSamePromptWork = (item: ScheduledWorkSummary, items: readonly ScheduledWorkSummary[]): number => (
  items.filter((other) => other !== item && other.recurring === item.recurring && isSamePrompt(item, other)).length
);

/** A field holding one number no greater than `max`, or null. */
const readNumber = (field: string, max: number): number | null =>
  (/^\d{1,2}$/.test(field) && Number(field) <= max ? Number(field) : null);

/** The step of a `*\/N` field, N from 1 to `max`, or null. */
const readStep = (field: string, max: number): number | null => {
  const match = /^\*\/(\d{1,2})$/.exec(field);
  const step = match ? Number(match[1]) : 0;
  return step >= 1 && step <= max ? step : null;
};

/** A weekday's name (0 is Sunday) in `locale`: 4 January 2026 was a Sunday. */
const weekdayName = (day: number, locale: string | undefined): string =>
  new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(new Date(2026, 0, 4 + day, 12));

/**
 * How often a cron expression runs, for the shapes /loop and a reminder use:
 * every minute or N minutes, every hour or N hours, every day, weekdays, one
 * weekday, every N days. Null for any other shape.
 */
function describeCronCadence(cron: string, t: TFunction, locale: string | undefined): string | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5 || fields[3] !== '*') {
    return null;
  }
  const [minute, hour, dayOfMonth, , dayOfWeek] = fields;
  const hourly = () => t('scheduledWork.cadence.hourly', { defaultValue: 'Every hour' });
  const daily = () => t('scheduledWork.cadence.daily', { defaultValue: 'Every day' });

  if (hour === '*' && dayOfMonth === '*' && dayOfWeek === '*') {
    const step = minute === '*' ? 1 : readStep(minute, 59);
    if (step === 1) {
      return t('scheduledWork.cadence.everyMinute', { defaultValue: 'Every minute' });
    }
    if (step !== null) {
      return t('scheduledWork.cadence.everyMinutes', { n: step, defaultValue: 'Every {{n}} minutes' });
    }
    return readNumber(minute, 59) === null ? null : hourly();
  }
  if (readNumber(minute, 59) === null) {
    return null;
  }
  if (dayOfMonth === '*' && dayOfWeek === '*') {
    const step = readStep(hour, 23);
    if (step === 1) {
      return hourly();
    }
    if (step !== null) {
      return t('scheduledWork.cadence.everyHours', { n: step, defaultValue: 'Every {{n}} hours' });
    }
    return readNumber(hour, 23) === null ? null : daily();
  }
  if (readNumber(hour, 23) === null) {
    return null;
  }
  if (dayOfMonth === '*') {
    if (dayOfWeek === '1-5') {
      return t('scheduledWork.cadence.weekdays', { defaultValue: 'Weekdays' });
    }
    // Day 7 is Sunday, as 0 is.
    const day = readNumber(dayOfWeek, 7);
    return day === null ? null : t('scheduledWork.cadence.weekly', { day: weekdayName(day % 7, locale), defaultValue: 'Every {{day}}' });
  }
  if (dayOfWeek !== '*') {
    return null;
  }
  const step = readStep(dayOfMonth, 31);
  if (step === 1) {
    return daily();
  }
  return step === null ? null : t('scheduledWork.cadence.everyDays', { n: step, defaultValue: 'Every {{n}} days' });
}

/**
 * How often an item runs, in the interface language: a wake-up loop paces
 * itself; a cron job's expression is worded when it has a shape this knows,
 * else the CLI's own wording stands, else the expression.
 */
export function describeScheduledCadence(item: ScheduledWorkSummary, t: TFunction, locale?: string): string {
  if (item.kind === 'wakeup') {
    return t('scheduledWork.selfPaced', { defaultValue: 'Self-paced' });
  }
  return (item.cron ? describeCronCadence(item.cron, t, locale) : null) ?? item.cadence ?? item.cron ?? '';
}

const isSameDay = (left: Date, right: Date): boolean =>
  left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();

/** A moment as the strip and the panel tell it, against `nowMs`: `14:05` today, `tomorrow 09:00`, else its date and time. */
export function formatScheduledTime(at: number, nowMs: number, t: TFunction, locale?: string): string {
  const date = new Date(at);
  const now = new Date(nowMs);
  const clock = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date);
  if (isSameDay(date, now)) {
    return clock;
  }
  if (isSameDay(date, new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))) {
    return t('scheduledWork.tomorrow', { time: clock, defaultValue: 'tomorrow {{time}}' });
  }
  return new Intl.DateTimeFormat(locale, {
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * What follows an item's name in the strip and the panel, part by part: a
 * loop's cadence and next run (`Every 5 minutes`, `Next: 14:05`), a
 * reminder's time. A time that has come reads `Due now`; an item whose next
 * run is unknown shows its cadence alone; one due past the time CloudCLI
 * holds the process for it is said not to run. A paused item (no process
 * runs it: a restart of the server, an abort or a CLI that ended left it so)
 * says so, then a loop's cadence: it runs nothing until it is resumed.
 */
export function describeScheduledTiming(item: ScheduledWorkSummary, nowMs: number, t: TFunction, locale?: string): string[] {
  const { nextFireAt } = item;
  const dueNow = () => t('scheduledWork.dueNow', { defaultValue: 'Due now' });
  const parts: string[] = [];
  if (item.paused) {
    parts.push(t('scheduledWork.paused', { defaultValue: 'Paused (no process running)' }));
    const cadence = item.recurring ? describeScheduledCadence(item, t, locale) : '';
    return cadence ? [...parts, cadence] : parts;
  }
  if (!item.recurring && nextFireAt !== null) {
    parts.push(nextFireAt <= nowMs ? dueNow() : formatScheduledTime(nextFireAt, nowMs, t, locale));
  } else {
    const cadence = describeScheduledCadence(item, t, locale);
    if (cadence) {
      parts.push(cadence);
    }
    if (nextFireAt !== null) {
      parts.push(nextFireAt <= nowMs
        ? dueNow()
        : t('scheduledWork.next', { time: formatScheduledTime(nextFireAt, nowMs, t, locale), defaultValue: 'Next: {{time}}' }));
    }
  }
  if (nextFireAt !== null && nextFireAt > item.holdUntil) {
    parts.push(t('scheduledWork.pastHold', { defaultValue: 'Past the hold limit, will not run' }));
  }
  return parts;
}

/**
 * An item in full, a line each, for the strip's tooltip: its whole prompt; a
 * cron job's expression and the CLI's wording of it, in server time, when a
 * loop expires and whether the project's file keeps it; why a wake-up loop
 * picked its delay.
 */
export function describeScheduledWorkDetails(item: ScheduledWorkSummary, nowMs: number, t: TFunction, locale?: string): string {
  const lines = [item.prompt];
  if (item.kind === 'cron') {
    const schedule = [item.cron, item.cadence].filter(Boolean).join(' · ');
    if (schedule) {
      lines.push(t('scheduledWork.serverSchedule', { schedule, defaultValue: '{{schedule}} (server time)' }));
    }
    if (item.recurring && item.expiresAt !== undefined) {
      lines.push(t('scheduledWork.expires', { time: formatScheduledTime(item.expiresAt, nowMs, t, locale), defaultValue: 'Expires {{time}}' }));
    }
    if (item.durable) {
      lines.push(t('scheduledWork.durable', { defaultValue: 'Kept in the project\'s .claude/scheduled_tasks.json' }));
    }
  } else if (item.reason) {
    lines.push(t('scheduledWork.reason', { reason: item.reason, defaultValue: 'Reason: {{reason}}' }));
  }
  return lines.filter(Boolean).join('\n');
}
