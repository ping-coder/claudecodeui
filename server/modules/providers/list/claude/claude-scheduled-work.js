/**
 * Scheduled work a held Claude process keeps for its session: the jobs
 * CronCreate schedules (a /loop with an interval, a reminder) and the next
 * wake-up of a self-paced /loop (ScheduleWakeup). No task event reports
 * either, so the runtime follows them by the calls, their results and the
 * scheduler's fires (see createScheduledWork), and holds its process for
 * them (claude-runtime.provider.js).
 *
 * The cron arithmetic is Claude Code 2.1.312's own (its `v6`, `AWt`, `_mn`,
 * `Mjo` and `OSt`), so the run can tell when a job fires next without the
 * CLI saying: a fire names no job, and nothing reports the next one.
 */

/**
 * The scheduler's settings as Claude Code 2.1.312 ships them (GrowthBook's
 * `tengu_kairos_cron_config`): how far past its cron time a job fires (a
 * share of the gap to the next match, capped), how early a one-shot job due
 * on the hour or half hour fires, when a recurring job expires, and how
 * early a `*\/5` job fires to keep the prompt cache warm.
 */
export const DEFAULT_CRON_CONFIG = Object.freeze({
  recurringFrac: 0.5,
  recurringCapMs: 30 * 60 * 1000,
  oneShotMaxMs: 90 * 1000,
  oneShotFloorMs: 0,
  oneShotMinuteMod: 30,
  recurringMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  cacheLeadMs: 15 * 1000,
});

// The value range of each cron field: minute, hour, day of month, month and
// day of week (where 7 is Sunday too).
const CRON_FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
];

// How far ahead a match is looked for: a year and a day, in minutes.
const MAX_SEARCH_MINUTES = 366 * 24 * 60;
const MINUTE_MS = 60 * 1000;

// A `*\/N * * * *` job whose gap is this long or more, but less than this
// plus `cacheLeadMs` (only `*\/5` with the defaults), fires `cacheLeadMs`
// before the gap is up, counted from its last fire.
const CACHE_LEAD_GAP_MS = 5 * MINUTE_MS;
const EVERY_N_MINUTES = /^\*\/\d+ \* \* \* \*$/;

/**
 * The values one cron field allows, sorted, or null when the field is not
 * one Claude Code accepts: numbers, `*`, `*\/n`, `a-b`, `a-b/n`, and comma
 * lists of them. A day of week of 7 is Sunday.
 * @param {string} field
 * @param {{ min: number, max: number }} range
 * @returns {Array<number>|null}
 */
function parseCronField(field, { min, max }) {
  const values = new Set();
  const isDayOfWeek = min === 0 && max === 6;
  for (const part of field.split(',')) {
    const every = part.match(/^\*(?:\/(\d+))?$/);
    if (every) {
      const step = every[1] ? parseInt(every[1], 10) : 1;
      if (step < 1) {
        return null;
      }
      for (let value = min; value <= max; value += step) {
        values.add(value);
      }
      continue;
    }
    const range = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (range) {
      const from = parseInt(range[1], 10);
      const to = parseInt(range[2], 10);
      const step = range[3] ? parseInt(range[3], 10) : 1;
      if (from > to || step < 1 || from < min || to > (isDayOfWeek ? 7 : max)) {
        return null;
      }
      for (let value = from; value <= to; value += step) {
        values.add(isDayOfWeek && value === 7 ? 0 : value);
      }
      continue;
    }
    if (/^\d+$/.test(part)) {
      let value = parseInt(part, 10);
      if (isDayOfWeek && value === 7) {
        value = 0;
      }
      if (value < min || value > max) {
        return null;
      }
      values.add(value);
      continue;
    }
    return null;
  }
  return values.size === 0 ? null : [...values].sort((first, second) => first - second);
}

/**
 * Parses a five-field cron expression (minute, hour, day of month, month,
 * day of week) as Claude Code does, or null when it would refuse it.
 * @param {unknown} expression
 * @returns {{ minute: number[], hour: number[], dayOfMonth: number[], month: number[], dayOfWeek: number[] }|null}
 */
export function parseCron(expression) {
  if (typeof expression !== 'string') {
    return null;
  }
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return null;
  }
  const parsed = [];
  for (let index = 0; index < 5; index += 1) {
    const values = parseCronField(fields[index], CRON_FIELDS[index]);
    if (!values) {
      return null;
    }
    parsed.push(values);
  }
  return { minute: parsed[0], hour: parsed[1], dayOfMonth: parsed[2], month: parsed[3], dayOfWeek: parsed[4] };
}

/**
 * Whether a minute is the second run of a local time a daylight saving
 * change repeats: setting its minutes again moves it to the first run.
 * @param {Date} date
 * @returns {boolean}
 */
function isRepeatedMinute(date) {
  const probe = new Date(date.getTime());
  probe.setMinutes(probe.getMinutes());
  return probe.getTime() !== date.getTime();
}

/**
 * The first minute after the one `from` falls in that a cron expression
 * matches, in the server's local time, looked for up to a year and a day
 * ahead; null when there is none, or the expression does not parse. With
 * both day of month and day of week restricted, either one matching is
 * enough; with one restricted, only that one counts. A minute a daylight
 * saving change repeats is skipped, except for a one-shot job.
 * @param {string|ReturnType<typeof parseCron>} cron - An expression, or one parseCron parsed
 * @param {number} from - Epoch ms
 * @param {{ oneShot?: boolean }} [options]
 * @returns {number|null} Epoch ms
 */
export function nextMatch(cron, from, { oneShot = false } = {}) {
  const parsed = typeof cron === 'string' ? parseCron(cron) : cron;
  if (!parsed) {
    return null;
  }
  const minutes = new Set(parsed.minute);
  const hours = new Set(parsed.hour);
  const daysOfMonth = new Set(parsed.dayOfMonth);
  const months = new Set(parsed.month);
  const daysOfWeek = new Set(parsed.dayOfWeek);
  const anyDayOfMonth = parsed.dayOfMonth.length === 31;
  const anyDayOfWeek = parsed.dayOfWeek.length === 7;
  const dayMatches = (date) => {
    if (anyDayOfMonth && anyDayOfWeek) {
      return true;
    }
    if (anyDayOfMonth) {
      return daysOfWeek.has(date.getDay());
    }
    if (anyDayOfWeek) {
      return daysOfMonth.has(date.getDate());
    }
    return daysOfMonth.has(date.getDate()) || daysOfWeek.has(date.getDay());
  };

  const candidate = new Date(Math.floor(new Date(from).getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
  if (Number.isNaN(candidate.getTime())) {
    return null;
  }
  for (let step = 0; step < MAX_SEARCH_MINUTES; step += 1) {
    if (isRepeatedMinute(candidate)) {
      if (
        oneShot
        && months.has(candidate.getMonth() + 1)
        && dayMatches(candidate)
        && hours.has(candidate.getHours())
        && minutes.has(candidate.getMinutes())
      ) {
        return candidate.getTime();
      }
      candidate.setTime(candidate.getTime() + MINUTE_MS);
      continue;
    }
    if (!months.has(candidate.getMonth() + 1)) {
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(candidate)) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }
    if (!hours.has(candidate.getHours()) || !minutes.has(candidate.getMinutes())) {
      if (oneShot) {
        candidate.setTime(candidate.getTime() + MINUTE_MS);
      } else if (!hours.has(candidate.getHours())) {
        candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      } else {
        candidate.setMinutes(candidate.getMinutes() + 1);
      }
      continue;
    }
    return candidate.getTime();
  }
  return null;
}

/**
 * The share of the gap a job's fires lag behind its cron time, as Claude
 * Code reads it off the job id: its first eight hex digits over 2^32, or 0
 * when they do not parse.
 * @param {string} id
 * @returns {number}
 */
function jitterFraction(id) {
  const fraction = parseInt(String(id).slice(0, 8), 16) / 4294967296;
  return Number.isFinite(fraction) ? fraction : 0;
}

/**
 * When a CronCreate job fires next, as Claude Code 2.1.312 works it out.
 *
 * A recurring job counts from its last fire (the moment the scheduler fired
 * it), else from its creation: the next match `i`, and the gap `n` from it
 * to the match after. A `*\/N * * * *` job whose gap is at least five
 * minutes and less than five minutes plus `cacheLeadMs` (`*\/5`, with the
 * defaults) fires `n - cacheLeadMs` after that base, not on the five
 * minutes. Any other fires at `i` plus `min(frac(id) × recurringFrac × n,
 * recurringCapMs)`. A one-shot job fires at its first match after creation,
 * one due at a minute `oneShotMinuteMod` divides (on the hour or half hour)
 * up to `frac(id) × oneShotMaxMs` earlier, but not before its creation.
 * @param {{ cron: string, recurring: boolean, id: string, createdAt: number, lastFiredAt?: number|null }} job
 * @param {typeof DEFAULT_CRON_CONFIG} [config]
 * @returns {number|null} Epoch ms, null when the expression does not parse
 *   or never matches within a year
 */
export function nextScheduledFire({ cron, recurring, id, createdAt, lastFiredAt }, config = DEFAULT_CRON_CONFIG) {
  const parsed = parseCron(cron);
  if (!parsed) {
    return null;
  }
  if (recurring) {
    const base = lastFiredAt ?? createdAt;
    const first = nextMatch(parsed, base);
    if (first === null) {
      return null;
    }
    const second = nextMatch(parsed, first);
    if (second === null) {
      return first;
    }
    const gap = second - first;
    if (
      EVERY_N_MINUTES.test(cron)
      && config.cacheLeadMs > 0
      && config.cacheLeadMs < gap
      && gap >= CACHE_LEAD_GAP_MS
      && gap - config.cacheLeadMs < CACHE_LEAD_GAP_MS
    ) {
      return base + gap - config.cacheLeadMs;
    }
    const lag = Math.min(jitterFraction(id) * config.recurringFrac * gap, config.recurringCapMs);
    return first + lag;
  }
  const due = nextMatch(parsed, createdAt, { oneShot: true });
  if (due === null) {
    return null;
  }
  if (new Date(due).getMinutes() % config.oneShotMinuteMod !== 0) {
    return due;
  }
  const lead = config.oneShotFloorMs + jitterFraction(id) * (config.oneShotMaxMs - config.oneShotFloorMs);
  return Math.max(due - lead, createdAt);
}

// The prompts a /loop passes for its default tasks, and how they are shown.
const LOOP_SENTINELS = new Map([
  ['<<autonomous-loop>>', '/loop'],
  ['<<autonomous-loop-dynamic>>', '/loop'],
  ['<<loop.md>>', '/loop (loop.md)'],
  ['<<loop.md-dynamic>>', '/loop (loop.md)'],
]);
const MAX_PROMPT_CHARS = 200;

/**
 * How a piece of scheduled work's prompt is shown: a /loop sentinel as
 * `/loop` or `/loop (loop.md)`, any other prompt by its first line, at most
 * MAX_PROMPT_CHARS characters.
 * @param {unknown} prompt
 * @returns {string}
 */
export function describeLoopPrompt(prompt) {
  if (typeof prompt !== 'string') {
    return '';
  }
  const trimmed = prompt.trim();
  const sentinel = LOOP_SENTINELS.get(trimmed);
  if (sentinel) {
    return sentinel;
  }
  const firstLine = trimmed.split(/\r?\n/, 1)[0].trim();
  return Array.from(firstLine).slice(0, MAX_PROMPT_CHARS).join('');
}

// The shortest and the longest wait a ScheduleWakeup sets: the CLI clamps
// `delaySeconds` to them.
const WAKEUP_MIN_DELAY_S = 60;
const WAKEUP_MAX_DELAY_S = 3600;

/**
 * When the wake-up a ScheduleWakeup call set fires, in epoch ms: the
 * `scheduledFor` its result carries (`tool_use_result`), else worked out from
 * its `delaySeconds` as the CLI does (clamped, then rounded up to the
 * minute). `exact` when the result said: the fire names the time it was set
 * for (`scheduled_for`), which then has to match it. Null when the result
 * says none was set: a `scheduledFor` of 0 without `stopped` is the CLI
 * refusing to set one for a loop that reached its maximum duration.
 * @param {Object|null} output - The call's `tool_use_result`
 * @param {Object} input - The call's input
 * @param {number} calledAt - When the call came, in epoch ms
 * @returns {{ at: number, exact: boolean }|null}
 */
export function readWakeupTime(output, input, calledAt) {
  if (Number.isFinite(output?.scheduledFor)) {
    return output.scheduledFor > 0 ? { at: output.scheduledFor, exact: true } : null;
  }
  const requested = Math.round(Number(input?.delaySeconds));
  const delaySeconds = Number.isNaN(requested)
    ? WAKEUP_MIN_DELAY_S
    : Math.min(WAKEUP_MAX_DELAY_S, Math.max(WAKEUP_MIN_DELAY_S, requested));
  return { at: Math.ceil((calledAt + delaySeconds * 1000) / 60000) * 60000, exact: false };
}

/** How long CloudCLI holds a process for scheduled work by default: eight days. */
export const DEFAULT_SCHEDULE_HOLD_MAX_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * Reads CLOUDCLI_CLAUDE_SCHEDULE_HOLD_MAX_MS: the longest CloudCLI holds a
 * process for one piece of scheduled work, counted from its creation (a
 * wake-up chain's start). A value that is not a positive integer falls back
 * to the default, with a warning. Not capped: the hold's timer never waits
 * longer than HOLD_IDLE at a time.
 * @param {Record<string, string | undefined>} env
 * @returns {number}
 */
export function resolveScheduleHoldMax(env) {
  const raw = env.CLOUDCLI_CLAUDE_SCHEDULE_HOLD_MAX_MS?.trim();
  if (!raw) {
    return DEFAULT_SCHEDULE_HOLD_MAX_MS;
  }
  const value = /^\d+$/.test(raw) ? Number(raw) : 0;
  if (value > 0 && Number.isSafeInteger(value)) {
    return value;
  }
  console.warn(`[Claude SDK] Ignoring CLOUDCLI_CLAUDE_SCHEDULE_HOLD_MAX_MS=${raw}: not a positive integer`);
  return DEFAULT_SCHEDULE_HOLD_MAX_MS;
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Whether a task a `session_cron_carry` row carries has the fields the CLI requires of one. */
const isCarriedCronTask = (task) => isPlainObject(task)
  && typeof task.id === 'string'
  && typeof task.cron === 'string'
  && typeof task.prompt === 'string'
  && Number.isFinite(task.createdAt)
  && typeof task.recurring === 'boolean';

/**
 * What a session's transcript says about its scheduled work, read as Claude
 * Code 2.1.312 reads it when it resumes a session (its `L8t`): `rows` are
 * the rows of the chain the resume replays, in file order.
 *
 * - `cronCalls`: each CronCreate call, `calledAt` its row's time, plus each
 *   task the last `session_cron_carry` row carries (a compaction carries the
 *   jobs made before it), as `carried:<id>`;
 * - `results`: each tool_result that is not an error, by tool_use id, with
 *   its row's `toolUseResult` and time;
 * - `deletedCronIds`: the id of every CronDelete call, whether it worked or
 *   not, and the ids carry rows say have ended;
 * - `wakeupCalls`: each ScheduleWakeup call; `wakeupCallsAtLastLoopFire`
 *   how many of them came before the last fire of a self-paced loop.
 * @param {Array<Record<string, any>>} rows
 */
export function scanTranscriptScheduling(rows) {
  const cronCalls = [];
  const results = new Map();
  const deletedCronIds = new Set();
  const wakeupCalls = [];
  let wakeupCallsAtLastLoopFire = 0;
  let carried = [];
  for (const row of rows) {
    if (row?.type === 'system' && row.subtype === 'scheduled_task_fire' && row.taskKind === 'loop') {
      wakeupCallsAtLastLoopFire = wakeupCalls.length;
    }
    if (row?.type === 'assistant') {
      const content = row.message?.content;
      if (!Array.isArray(content)) {
        continue;
      }
      const calledAt = Date.parse(row.timestamp);
      for (const block of content) {
        if (block?.type !== 'tool_use') {
          continue;
        }
        const input = isPlainObject(block.input) ? block.input : {};
        if (block.name === 'CronCreate') {
          cronCalls.push({ toolUseId: block.id, input, calledAt });
        } else if (block.name === 'CronDelete') {
          if (typeof input.id === 'string') {
            deletedCronIds.add(input.id);
          }
        } else if (block.name === 'ScheduleWakeup') {
          wakeupCalls.push({ toolUseId: block.id, input, calledAt });
        }
      }
    } else if (row?.type === 'user') {
      const content = row.message?.content;
      if (!Array.isArray(content) || !isPlainObject(row.toolUseResult)) {
        continue;
      }
      const resultAt = Date.parse(row.timestamp);
      for (const block of content) {
        if (block?.type === 'tool_result' && !block.is_error) {
          results.set(block.tool_use_id, { output: row.toolUseResult, resultAt });
        }
      }
    } else if (row?.type === 'attachment' && row.attachment?.type === 'session_cron_carry') {
      const { tasks, ended } = row.attachment;
      carried = Array.isArray(tasks) ? tasks.filter(isCarriedCronTask) : [];
      for (const id of Array.isArray(ended) ? ended : []) {
        if (typeof id === 'string') {
          deletedCronIds.add(id);
        }
      }
    }
  }
  for (const task of carried) {
    const toolUseId = `carried:${task.id}`;
    cronCalls.push({ toolUseId, input: { cron: task.cron, prompt: task.prompt }, calledAt: task.createdAt, carried: true });
    results.set(toolUseId, { output: { id: task.id, recurring: task.recurring, durable: false }, resultAt: task.createdAt });
  }
  return { cronCalls, results, deletedCronIds, wakeupCalls, wakeupCallsAtLastLoopFire };
}

/**
 * The cron jobs a CLI that resumes the session brings back, by Claude Code
 * 2.1.312's rules (its `os` and `ns`; 2.1.309 has the same), with nothing on
 * its stream to say so. A job counts when its CronCreate result names an id;
 * not when it is durable (the project's .claude/scheduled_tasks.json keeps
 * it), deleted, or lacks a cron or a prompt. A recurring job lasts until
 * `recurringMaxAgeMs` past its creation, a one-shot job until its time; the
 * first job of an id wins. The CLI dates a job by its call's row; one whose
 * row has no readable time is left out here (the CLI would keep it, with no
 * date to work its times out from).
 *
 * `predictable` as for a job made live (see createScheduledWork): the time
 * its result named lies between the times its call's and its result's rows
 * give, a second either way. A carried job is taken as predictable.
 * @param {Array<Record<string, any>>|ReturnType<typeof scanTranscriptScheduling>} rowsOrScan
 * @param {number} now - Epoch ms
 * @param {typeof DEFAULT_CRON_CONFIG} [config]
 * @returns {Array<{ jobId: string, toolUseId: string, cron: string, prompt: string, recurring: boolean, createdAt: number, humanSchedule: string, predictable: boolean }>}
 */
export function findRevivedCronJobs(rowsOrScan, now, config = DEFAULT_CRON_CONFIG) {
  const scan = Array.isArray(rowsOrScan) ? scanTranscriptScheduling(rowsOrScan) : rowsOrScan;
  const revived = [];
  const seen = new Set();
  for (const call of scan.cronCalls) {
    const result = scan.results.get(call.toolUseId);
    const output = result?.output;
    if (!output || typeof output.id !== 'string' || output.durable === true || scan.deletedCronIds.has(output.id)) {
      continue;
    }
    const { cron, prompt } = call.input;
    if (typeof cron !== 'string' || typeof prompt !== 'string' || !Number.isFinite(call.calledAt)) {
      continue;
    }
    const recurring = output.recurring !== false;
    if (recurring) {
      if (config.recurringMaxAgeMs !== 0 && now - call.calledAt >= config.recurringMaxAgeMs) {
        continue;
      }
    } else {
      const due = nextScheduledFire({ cron, recurring: false, id: output.id, createdAt: call.calledAt }, config);
      if (due === null || due < now) {
        continue;
      }
    }
    if (seen.has(output.id)) {
      continue;
    }
    seen.add(output.id);
    let predictable = call.carried === true;
    if (!predictable && recurring && Number.isFinite(output.nextFireAt)) {
      const resultAt = Number.isFinite(result.resultAt) ? result.resultAt : call.calledAt;
      const atCall = nextScheduledFire({ cron, recurring, id: output.id, createdAt: call.calledAt }, config);
      const atResult = nextScheduledFire({ cron, recurring, id: output.id, createdAt: resultAt }, config);
      predictable = atCall !== null
        && atResult !== null
        && output.nextFireAt >= Math.min(atCall, atResult) - 1000
        && output.nextFireAt <= Math.max(atCall, atResult) + 1000;
    }
    revived.push({
      jobId: output.id,
      toolUseId: call.toolUseId,
      cron,
      prompt,
      recurring,
      createdAt: call.calledAt,
      humanSchedule: typeof output.humanSchedule === 'string' ? output.humanSchedule : '',
      predictable,
    });
  }
  return revived;
}

/**
 * The wake-up of a self-paced /loop that was still to come when the
 * session's last process ended, or null. The CLI brings it back only from a
 * job directory, which CloudCLI's processes do not have, so a resumed
 * session has none: the loop is over until the model calls ScheduleWakeup
 * again. As the CLI tells a pending one (its `rs`): the last ScheduleWakeup
 * that has a result, which set a time (`scheduledFor`), was not a stop, has
 * a prompt, and no fire of a self-paced loop came after it. CloudCLI also
 * lets go of one due more than `recurringMaxAgeMs` ago.
 * @param {Array<Record<string, any>>|ReturnType<typeof scanTranscriptScheduling>} rowsOrScan
 * @param {number} now - Epoch ms
 * @param {typeof DEFAULT_CRON_CONFIG} [config]
 * @returns {{ toolUseId: string, prompt: string, reason: string, scheduledFor: number, calledAt: number } | null}
 */
export function findPendingWakeup(rowsOrScan, now, config = DEFAULT_CRON_CONFIG) {
  const scan = Array.isArray(rowsOrScan) ? scanTranscriptScheduling(rowsOrScan) : rowsOrScan;
  const index = scan.wakeupCalls.findLastIndex((call) => scan.results.has(call.toolUseId));
  if (index === -1 || scan.wakeupCallsAtLastLoopFire > index) {
    return null;
  }
  const call = scan.wakeupCalls[index];
  const { output } = scan.results.get(call.toolUseId);
  if (
    call.input.stop === true
    || output.stopped === true
    || !Number.isFinite(output.scheduledFor)
    || output.scheduledFor <= 0
    || typeof call.input.prompt !== 'string'
    || now - output.scheduledFor >= config.recurringMaxAgeMs
  ) {
    return null;
  }
  return {
    toolUseId: call.toolUseId,
    prompt: call.input.prompt,
    reason: typeof call.input.reason === 'string' ? call.input.reason.trim() : '',
    scheduledFor: output.scheduledFor,
    calledAt: Number.isFinite(call.calledAt) ? call.calledAt : output.scheduledFor,
  };
}

/**
 * How long the wake-up of a resumed self-paced loop waits: what was left of
 * its wait, at least the CLI's shortest, at most its longest.
 * @param {number} scheduledFor - When the wake-up was due, epoch ms
 * @param {number} now - Epoch ms
 * @returns {number} Seconds
 */
export function resumedWakeupDelaySeconds(scheduledFor, now) {
  return Math.min(WAKEUP_MAX_DELAY_S, Math.max(WAKEUP_MIN_DELAY_S, Math.ceil((scheduledFor - now) / 1000)));
}

// How far ahead of its time a fire may be put down to a job whose time the
// run worked out itself (see createScheduledWork).
const FIRE_EARLY_MS = 5 * 1000;
// How many fires no job could be found for are kept for the jobs that miss.
const UNATTRIBUTED_FIRES_KEPT = 20;

/** The ids scheduled work can be stopped by: a job's and a wake-up chain's. */
const STOPPABLE_ID = /^(?:cron:[0-9a-f]{8}|wakeup:[\w-]{1,128})$/;

/**
 * Whether an id names scheduled work that can be stopped: `cron:` and the
 * CLI's eight-digit hex job id, or `wakeup:` and a tool_use id.
 * @param {unknown} id
 * @returns {boolean}
 */
export function isStoppableScheduledWorkId(id) {
  return typeof id === 'string' && STOPPABLE_ID.test(id);
}

const STOP_REPLY = 'Make the calls yourself, not through an agent. Do nothing else, and reply in one short sentence.';

/**
 * The message of the turn that has the model cancel scheduled work: a
 * CronDelete for each job, and a ScheduleWakeup with `stop: true` for the
 * wake-up. Always in English: it goes to the model.
 * @param {{ jobIds: string[], wakeup: boolean }} targets
 * @returns {string}
 */
export function buildScheduledStopMessage({ jobIds, wakeup }) {
  if (jobIds.length === 0) {
    return `End the dynamic /loop now: call ScheduleWakeup with stop: true. ${STOP_REPLY}`;
  }
  const quoted = jobIds.map((jobId) => `"${jobId}"`).join(', ');
  if (wakeup) {
    return `Stop these loops now: call CronDelete once for each id: ${quoted}; then call ScheduleWakeup with stop: true. ${STOP_REPLY}`;
  }
  if (jobIds.length === 1) {
    return `Cancel scheduled job ${jobIds[0]} now: call CronDelete with id "${jobIds[0]}". ${STOP_REPLY}`;
  }
  return `Cancel these scheduled jobs now: call CronDelete once for each id: ${quoted}. ${STOP_REPLY}`;
}

/**
 * Reads a stop message back: the jobs and the wake-up it names, for a text
 * buildScheduledStopMessage writes exactly, and null for any other. Strict
 * by construction: what it reads is accepted only when building the message
 * from it gives the same text back.
 * @param {unknown} text
 * @returns {{ jobIds: string[], wakeup: boolean } | null}
 */
export function parseScheduledStopMessage(text) {
  if (typeof text !== 'string' || !text.endsWith(` ${STOP_REPLY}`)) {
    return null;
  }
  const targets = {
    jobIds: [...text.matchAll(/"([0-9a-f]{8})"/g)].map((match) => match[1]),
    wakeup: text.includes(' call ScheduleWakeup with stop: true. '),
  };
  if (targets.jobIds.length === 0 && !targets.wakeup) {
    return null;
  }
  return buildScheduledStopMessage(targets) === text ? targets : null;
}

// The resume message's fixed sentences: the current ones, which hold true
// however the loops were left with no process, and those of the first
// release, which blamed a restart and are still read back from transcripts.
const RESUME_WORDING = {
  lead: 'No process was running this session\'s loops.',
  wakeupLead: 'The dynamic /loop\'s wake-up ended with its process: resume it now by calling ScheduleWakeup yourself, not through an agent, with these arguments: ',
};
const RESUME_WORDING_V1 = {
  lead: 'CloudCLI restarted.',
  wakeupLead: 'The restart ended the dynamic /loop: resume it now by calling ScheduleWakeup yourself, not through an agent, with these arguments: ',
};
const RESUME_NO_TOOLS = 'Do not call any tools.';
const RESUME_REPLY = 'Do nothing else, and reply in one short sentence.';

/**
 * The message of the turn that resumes the loops of a session no process
 * runs (see readPausedScheduledWork in claude-sessions.provider.ts): a
 * restart of the server left them so, an abort, or a CLI that ended on its
 * own. The CLI brings the cron jobs back on its own as it resumes the
 * session, so for those it asks only for a short reply, with no tool. A
 * self-paced loop the CLI does not bring back: the model calls ScheduleWakeup
 * again with the arguments given (the loop's prompt and reason, the wait
 * left), and `noop: true`, as nothing changed on this tick. Always in
 * English: it goes to the model.
 * @param {{ jobIds: string[], wakeup: { delaySeconds: number, prompt: string, reason: string } | null }} work
 * @returns {string}
 */
export function buildLoopsResumeMessage(work) {
  return composeLoopsResumeMessage(work, RESUME_WORDING);
}

/** The resume message in the wording given (see RESUME_WORDING). */
function composeLoopsResumeMessage({ jobIds, wakeup }, { lead, wakeupLead }) {
  const parts = [lead];
  if (jobIds.length > 0) {
    const quoted = jobIds.map((jobId) => `"${jobId}"`).join(', ');
    parts.push(jobIds.length === 1
      ? `Scheduled job ${quoted} runs again on its own schedule.`
      : `Scheduled jobs ${quoted} run again on their own schedule.`);
  }
  if (wakeup) {
    const args = JSON.stringify({ delaySeconds: wakeup.delaySeconds, prompt: wakeup.prompt, reason: wakeup.reason, noop: true });
    parts.push(`${wakeupLead}${args}.`);
  } else {
    parts.push(RESUME_NO_TOOLS);
  }
  parts.push(RESUME_REPLY);
  return parts.join(' ');
}

/**
 * Reads a resume message back: the jobs and the wake-up it names, for a text
 * buildLoopsResumeMessage writes exactly, in its current wording or that of
 * the first release (RESUME_WORDING_V1), and null for any other. The
 * wake-up's arguments are one JSON object between a fixed lead and the fixed
 * end, so a prompt of any text reads back whole. Strict by construction, as
 * parseScheduledStopMessage.
 * @param {unknown} text
 * @returns {{ jobIds: string[], wakeup: { delaySeconds: number, prompt: string, reason: string } | null } | null}
 */
export function parseLoopsResumeMessage(text) {
  if (typeof text !== 'string' || !text.endsWith(` ${RESUME_REPLY}`)) {
    return null;
  }
  const wording = [RESUME_WORDING, RESUME_WORDING_V1].find(({ lead }) => text.startsWith(`${lead} `));
  if (!wording) {
    return null;
  }
  const leadAt = text.indexOf(wording.wakeupLead);
  let wakeup = null;
  if (leadAt !== -1) {
    const argsEnd = text.length - RESUME_REPLY.length - 2;
    if (text[argsEnd] !== '.') {
      return null;
    }
    try {
      const args = JSON.parse(text.slice(leadAt + wording.wakeupLead.length, argsEnd));
      if (
        !args
        || !Number.isInteger(args.delaySeconds)
        || typeof args.prompt !== 'string'
        || typeof args.reason !== 'string'
        || args.noop !== true
      ) {
        return null;
      }
      wakeup = { delaySeconds: args.delaySeconds, prompt: args.prompt, reason: args.reason };
    } catch {
      return null;
    }
  }
  const jobsPart = leadAt === -1 ? text : text.slice(0, leadAt);
  const jobIds = [...jobsPart.matchAll(/"([0-9a-f]{8})"/g)].map((match) => match[1]);
  if (jobIds.length === 0 && !wakeup) {
    return null;
  }
  const work = { jobIds, wakeup };
  return composeLoopsResumeMessage(work, wording) === text ? work : null;
}

/**
 * The prompts CloudCLI sends the model on its own, by kind: how to read one
 * back from its text, how each of its texts starts (`leads`, for the cut-down
 * copy the CLI keeps of a long prompt, see isControlLastPrompt), and the note
 * the chat shows for it. Nothing the CLI writes marks such a prompt, so its
 * transcript row reads like one the user typed, and only its text tells it
 * apart (see parseControlPrompt).
 *
 * `scheduled-stop`: the turn that has Claude stop loops. Its note counts the
 * cron jobs and the wake-up it stops, and names the jobs.
 *
 * `loops-resume`: the turn that resumes the loops no process runs. Its note
 * counts the cron jobs and the self-paced loop it resumes, and names the
 * jobs.
 */
const CONTROL_PROMPTS = {
  'scheduled-stop': {
    parse: parseScheduledStopMessage,
    leads: [
      'End the dynamic /loop now: ',
      'Stop these loops now: call CronDelete once for each id: ',
      'Cancel scheduled job ',
      'Cancel these scheduled jobs now: call CronDelete once for each id: ',
    ],
    note: ({ jobIds, wakeup }) => {
      const count = jobIds.length + (wakeup ? 1 : 0);
      return {
        note: { count, jobIds, ...(wakeup ? { wakeup: true } : {}) },
        content: jobIds.length === 0
          ? 'Asked Claude to stop the dynamic loop'
          : `Asked Claude to stop ${count} ${count === 1 ? 'loop' : 'loops'}`,
      };
    },
  },
  'loops-resume': {
    parse: parseLoopsResumeMessage,
    leads: [`${RESUME_WORDING.lead} `, `${RESUME_WORDING_V1.lead} `],
    note: ({ jobIds, wakeup }) => {
      const count = jobIds.length + (wakeup ? 1 : 0);
      return {
        note: { count, jobIds, ...(wakeup ? { wakeup: true } : {}) },
        content: `Resumed ${count} ${count === 1 ? 'loop' : 'loops'}`,
      };
    },
  },
};

/**
 * Reads a prompt CloudCLI sent the model on its own back from its text: its
 * kind and what that kind's parser read. Null for any other text, the
 * user's own messages included.
 * @param {unknown} text
 * @returns {({ kind: 'scheduled-stop', jobIds: string[], wakeup: boolean }
 *   | { kind: 'loops-resume', jobIds: string[], wakeup: { delaySeconds: number, prompt: string, reason: string } | null }) | null}
 */
export function parseControlPrompt(text) {
  if (typeof text !== 'string') {
    return null;
  }
  for (const [kind, { parse }] of Object.entries(CONTROL_PROMPTS)) {
    const parsed = parse(text);
    if (parsed) {
      return { kind, ...parsed };
    }
  }
  return null;
}

// What the CLI keeps of a prompt as a session's `lastPrompt` (Claude Code
// 2.1.312): newlines made spaces, and one longer than this cut to its first
// this many characters, trimmed, then "…".
const LAST_PROMPT_MAX_CHARS = 200;
// How short a cut-down prompt can come out: a few characters go with the
// trim and a split surrogate pair.
const LAST_PROMPT_MIN_CUT_CHARS = LAST_PROMPT_MAX_CHARS - 10;

/**
 * Whether the text of a session's `last-prompt` row is a prompt CloudCLI sent
 * the model on its own (parseControlPrompt). One longer than the CLI keeps
 * whole is checked by how it starts (the kinds' `leads`) and the length the
 * CLI cuts it to, as the rest is gone.
 * @param {unknown} text
 * @returns {boolean}
 */
export function isControlLastPrompt(text) {
  if (typeof text !== 'string') {
    return false;
  }
  if (parseControlPrompt(text)) {
    return true;
  }
  if (!text.endsWith('…')) {
    return false;
  }
  const kept = text.slice(0, -1);
  return kept.length >= LAST_PROMPT_MIN_CUT_CHARS
    && kept.length <= LAST_PROMPT_MAX_CHARS
    && Object.values(CONTROL_PROMPTS).some(({ leads }) => leads.some((lead) => kept.startsWith(lead)));
}

/**
 * The note that stands in for a prompt CloudCLI sent the model on its own:
 * `controlNote` (`{ kind, count, jobIds?, wakeup? }`), which the client words
 * in the user's language, and `content`, the English fallback. Null for any
 * other text.
 * @param {unknown} text
 * @returns {{ controlNote: import('@/shared/types.js').ControlNote, content: string } | null}
 */
export function readControlNote(text) {
  const prompt = parseControlPrompt(text);
  if (!prompt) {
    return null;
  }
  const { kind, ...parsed } = prompt;
  const { note, content } = CONTROL_PROMPTS[kind].note(parsed);
  return { controlNote: { kind, ...note }, content };
}

/**
 * Keeps the scheduled work of one run's process: what its CronCreate and
 * ScheduleWakeup calls set up, the jobs its CLI brought back from the
 * transcript as it resumed the session (noteCronRevived), which fire was
 * whose, and when to give up on work that never fires.
 *
 * A cron job keeps its id, call, cron, the CLI's `humanSchedule`, prompt,
 * `recurring`, `durable`, `createdAt` (when its result came), `nextFireAt`,
 * `predictable`, `lastFiredAt`, `timed` (its result named a time) and
 * `holdUntil`. `predictable` when the time its result names lies between
 * the times nextScheduledFire gives for its call and for its result (a
 * second either way): the scheduler runs with the defaults, so its later
 * fires can be worked out too. Otherwise its result's time is used once, and
 * `nextFireAt` is null after its first fire.
 *
 * The wake-up keeps its time (`at`, `exact`), its chain (`chainId`, the
 * chain's first call, and `chainStartedAt`), its latest call, prompt and
 * reason, and `holdUntil`. A ScheduleWakeup while one is pending, the one
 * whose fire this turn is included, carries the chain on; one with nothing
 * pending starts a new chain. `stop: true`, a result that sets nothing, and
 * a fire whose turn sets no other end it.
 *
 * `holdUntil` is creation (a chain's start) plus `scheduleHoldMaxMs`. A job
 * that is not `timed` (an older CLI) is held `holdMaxMs` past its creation,
 * past anything the CLI says during a turn (noteTurnActivity) and, if
 * recurring, past the end of each turn of the CLI's own that may have been
 * its fire (noteCronFire, noteUnnamedFire), never later than
 * `scheduleHoldMaxMs` past its creation: it lasts as long as it keeps firing,
 * and a fire's turn that runs longer than `holdMaxMs` does not cut it off.
 *
 * A cron fire names no job. Of the jobs created before it started and not
 * missed by then, it is put down to the one due latest of those due by then
 * (jobs that fire on the same tick share their base time, so which takes
 * which does not matter), else to the one due earliest in the FIRE_EARLY_MS
 * after it whose time the run worked out from a fire it heard (any time
 * after a job's first fire): the run hears a fire a little after the CLI's
 * tick, so that time can come out a little late. The time a CronCreate
 * result names never does: the CLI never fires a job before it. A fire put
 * down to no job takes the first one-shot job with no time, else is kept
 * (the last UNATTRIBUTED_FIRES_KEPT) for a job that turns out to have
 * missed. A one-shot job is gone once it has fired,
 * and so is a recurring one at its first fire seven days
 * (`recurringMaxAgeMs`) after its creation; any other recurring job counts
 * its next fire from this one.
 *
 * Work is missed once `graceMs` has passed since its time, or since the end
 * of the CLI's last turn if that is later: the CLI fires nothing while it
 * runs a turn, and fires in a second when it is idle. Work with no known time
 * is never missed. cleanUp drops missed work (a missed job takes a kept fire
 * first, when one came after its last fire or creation, and is dropped only
 * if it is still missed after it) and work past its `holdUntil`, logging a
 * line for each. Work holds the process while its next fire is unknown or no
 * later than its `holdUntil`.
 *
 * @param {{
 *   holdMaxMs: number,
 *   scheduleHoldMaxMs: number,
 *   graceMs: number,
 *   config?: typeof DEFAULT_CRON_CONFIG,
 *   log?: (line: string) => void,
 * }} options
 */
export function createScheduledWork({
  holdMaxMs,
  scheduleHoldMaxMs,
  graceMs,
  config = DEFAULT_CRON_CONFIG,
  log = () => {},
}) {
  /** Cron jobs by key: the CLI's job id, or `call:<toolUseId>` when it named none. */
  const jobs = new Map();
  let wakeup = null;
  /** Fires put down to no job, oldest first. */
  const unattributedFires = [];
  /** The ids of the jobs a CronDelete cancelled, which a job brought back late (noteCronRevived) does not undo. */
  const deletedJobIds = new Set();

  const holds = (nextFireAt, holdUntil) => nextFireAt === null || nextFireAt <= holdUntil;
  const missedAt = (nextFireAt, at, lastTurnEndedAt) => nextFireAt !== null
    && at >= Math.max(nextFireAt, lastTurnEndedAt ?? -Infinity) + graceMs;
  const describeJob = (job) => `scheduled job ${job.jobId ?? `from call ${job.toolUseId}`}`;

  // Holds a job whose result named no time `holdMaxMs` past `at`, up to its
  // limit.
  const holdUntimedJobPast = (job, at) => {
    job.holdUntil = Math.max(job.holdUntil, Math.min(at + holdMaxMs, job.createdAt + scheduleHoldMaxMs));
  };

  // A turn of the CLI's own that may have been the fire of a recurring job
  // whose result named no time ended at `endedAt`: the job is held
  // `holdMaxMs` past it, up to its limit.
  const holdUntimedJobsPast = (endedAt) => {
    for (const job of jobs.values()) {
      if (job.recurring && !job.timed) {
        holdUntimedJobPast(job, endedAt);
      }
    }
  };

  // A fire at `firedAt` was this job's.
  const applyFire = (job, firedAt) => {
    if (!job.recurring) {
      jobs.delete(job.key);
      return;
    }
    if (firedAt - job.createdAt >= config.recurringMaxAgeMs) {
      log(`${describeJob(job)} fired for the last time: Claude Code ends a recurring job ${config.recurringMaxAgeMs} ms after its creation`);
      jobs.delete(job.key);
      return;
    }
    job.lastFiredAt = firedAt;
    job.nextFireAt = job.predictable
      ? nextScheduledFire({ cron: job.cron, recurring: true, id: job.jobId, createdAt: job.createdAt, lastFiredAt: firedAt }, config)
      : null;
  };

  const jobSummary = (job) => ({
    id: `cron:${job.key}`,
    kind: 'cron',
    toolUseId: job.toolUseId,
    prompt: describeLoopPrompt(job.prompt),
    startedAt: job.createdAt,
    nextFireAt: job.nextFireAt,
    recurring: job.recurring,
    holdUntil: job.holdUntil,
    cron: job.cron,
    ...(job.humanSchedule ? { cadence: job.humanSchedule } : {}),
    ...(job.recurring ? { expiresAt: job.createdAt + config.recurringMaxAgeMs } : {}),
    durable: job.durable,
  });

  const wakeupSummary = () => ({
    id: `wakeup:${wakeup.chainId}`,
    kind: 'wakeup',
    toolUseId: wakeup.toolUseId,
    prompt: describeLoopPrompt(wakeup.prompt),
    startedAt: wakeup.chainStartedAt,
    nextFireAt: wakeup.at,
    recurring: true,
    holdUntil: wakeup.holdUntil,
    ...(wakeup.reason ? { reason: wakeup.reason } : {}),
  });

  return {
    /**
     * A ScheduleWakeup call's result (not an error): sets the wake-up, or
     * ends the chain.
     * @param {{ toolUseId: string, input: Object, output: Object|null, calledAt: number }} call
     */
    noteWakeupCall({ toolUseId, input, output, calledAt }) {
      if (input?.stop === true || output?.stopped === true) {
        wakeup = null;
        return;
      }
      const time = readWakeupTime(output, input, calledAt);
      if (!time) {
        wakeup = null;
        return;
      }
      const now = Date.now();
      const chain = wakeup
        ? { chainId: wakeup.chainId, chainStartedAt: wakeup.chainStartedAt, holdUntil: wakeup.holdUntil }
        : { chainId: toolUseId, chainStartedAt: now, holdUntil: now + scheduleHoldMaxMs };
      wakeup = {
        ...chain,
        at: time.at,
        exact: time.exact,
        toolUseId,
        prompt: typeof input?.prompt === 'string' ? input.prompt : '',
        reason: typeof input?.reason === 'string' ? input.reason.trim() : '',
      };
    },

    /**
     * A CronCreate call's result (not an error).
     * @param {{ toolUseId: string, jobId: string|null, input: Object, output: Object|null, calledAt: number }} call
     */
    noteCronCreated({ toolUseId, jobId, input, output, calledAt }) {
      const now = Date.now();
      const cron = typeof input?.cron === 'string' ? input.cron : '';
      // A job is recurring unless the call says otherwise.
      const recurring = typeof output?.recurring === 'boolean' ? output.recurring : input?.recurring !== false;
      const reported = Number.isFinite(output?.nextFireAt) ? output.nextFireAt : null;
      let predictable = false;
      if (recurring && reported !== null && jobId !== null) {
        const atCall = nextScheduledFire({ cron, recurring, id: jobId, createdAt: calledAt }, config);
        const atResult = nextScheduledFire({ cron, recurring, id: jobId, createdAt: now }, config);
        predictable = atCall !== null
          && atResult !== null
          && reported >= Math.min(atCall, atResult) - 1000
          && reported <= Math.max(atCall, atResult) + 1000;
      }
      const key = jobId ?? `call:${toolUseId}`;
      jobs.set(key, {
        key,
        jobId,
        toolUseId,
        cron,
        humanSchedule: typeof output?.humanSchedule === 'string' ? output.humanSchedule : '',
        prompt: typeof input?.prompt === 'string' ? input.prompt : '',
        recurring,
        durable: typeof output?.durable === 'boolean' ? output.durable : input?.durable === true,
        createdAt: now,
        nextFireAt: reported,
        predictable,
        lastFiredAt: null,
        timed: reported !== null,
        holdUntil: now + (reported === null ? Math.min(holdMaxMs, scheduleHoldMaxMs) : scheduleHoldMaxMs),
      });
    },

    /**
     * A job the CLI brings back from the transcript as it resumes the session
     * (findRevivedCronJobs), `revivedAt` no later than the CLI starts. It
     * keeps its creation, so it expires and is held as it would have been. A
     * recurring job counts its next fire from `revivedAt`, as the CLI counts
     * from the moment it brought the job back, when its times are predictable;
     * otherwise its time is not known. A one-shot job keeps its time. A job
     * already kept, or one a CronDelete of this process cancelled (the read
     * of the transcript can finish after the first turn's calls), is left as
     * it is.
     * @param {ReturnType<typeof findRevivedCronJobs>[number]} job
     * @param {number} revivedAt
     */
    noteCronRevived({ jobId, toolUseId, cron, prompt, recurring, createdAt, humanSchedule, predictable }, revivedAt) {
      if (jobs.has(jobId) || deletedJobIds.has(jobId)) {
        return;
      }
      const nextFireAt = recurring
        ? (predictable ? nextScheduledFire({ cron, recurring: true, id: jobId, createdAt, lastFiredAt: revivedAt }, config) : null)
        : nextScheduledFire({ cron, recurring: false, id: jobId, createdAt }, config);
      const timed = nextFireAt !== null;
      jobs.set(jobId, {
        key: jobId,
        jobId,
        toolUseId,
        cron,
        humanSchedule: humanSchedule ?? '',
        prompt,
        recurring,
        durable: false,
        createdAt,
        nextFireAt,
        predictable: recurring && predictable,
        lastFiredAt: recurring ? revivedAt : null,
        timed,
        holdUntil: timed
          ? createdAt + scheduleHoldMaxMs
          : Math.min(revivedAt + holdMaxMs, createdAt + scheduleHoldMaxMs),
        // Until the CLI's first word (confirmRevivedTimes).
        revivedAt: recurring && timed ? revivedAt : null,
      });
    },

    /**
     * The CLI's first word (its init) came at `at`: it brought its jobs back
     * by then. A recurring job revived at `revivedAt` whose next fire counted
     * from `at` is another (a cron time fell between the two) cannot be told
     * from the CLI's, which counts from somewhere in between: its time is not
     * known from now on, as for a job whose result named none. A time that
     * moves with the moment it counts from (the `*\/5` case of
     * nextScheduledFire) is kept: the CLI's comes no earlier.
     * @param {number} at
     */
    confirmRevivedTimes(at) {
      for (const job of jobs.values()) {
        if (job.revivedAt === null || job.revivedAt === undefined) {
          continue;
        }
        const revivedAt = job.revivedAt;
        job.revivedAt = null;
        if (job.lastFiredAt !== revivedAt || job.nextFireAt === null) {
          continue;
        }
        const atInit = nextScheduledFire({ cron: job.cron, recurring: true, id: job.jobId, createdAt: job.createdAt, lastFiredAt: at }, config);
        const movesWithBase = atInit !== null && atInit - job.nextFireAt === at - revivedAt;
        if (atInit !== job.nextFireAt && !movesWithBase) {
          log(`${describeJob(job)} may have come back after one of its cron times; its next fire is not known`);
          job.nextFireAt = null;
          job.timed = false;
          job.predictable = false;
          job.holdUntil = Math.min(at + holdMaxMs, job.createdAt + scheduleHoldMaxMs);
        }
      }
    },

    /** A CronDelete call's result (not an error). @param {unknown} jobId */
    noteCronDeleted(jobId) {
      if (typeof jobId === 'string') {
        jobs.delete(jobId);
        deletedJobIds.add(jobId);
      }
    },

    /**
     * A cron job fired, its turn starting at `firedAt`, after a turn of the
     * CLI that ended at `turnEndedBefore` (see above). Called once the
     * fire's turn is over: a fire no job with a known time takes holds the
     * recurring jobs whose result named no time past now.
     * @param {number} firedAt
     * @param {number|null} turnEndedBefore
     */
    noteCronFire(firedAt, turnEndedBefore) {
      // The job due latest of those due by the fire, and the one due earliest
      // of those whose worked-out time is just after it.
      let due = null;
      let dueJustAfter = null;
      for (const job of jobs.values()) {
        if (job.nextFireAt === null || job.createdAt > firedAt || missedAt(job.nextFireAt, firedAt, turnEndedBefore)) {
          continue;
        }
        if (job.nextFireAt <= firedAt) {
          if (due === null || job.nextFireAt > due.nextFireAt) {
            due = job;
          }
        } else if (
          job.lastFiredAt !== null
          && job.nextFireAt <= firedAt + FIRE_EARLY_MS
          && (dueJustAfter === null || job.nextFireAt < dueJustAfter.nextFireAt)
        ) {
          dueJustAfter = job;
        }
      }
      const fired = due ?? dueJustAfter;
      if (fired) {
        applyFire(fired, firedAt);
        return;
      }
      holdUntimedJobsPast(Date.now());
      const untimed = [...jobs.values()].find((job) => !job.recurring && job.nextFireAt === null);
      if (untimed) {
        jobs.delete(untimed.key);
        return;
      }
      unattributedFires.push(firedAt);
      if (unattributedFires.length > UNATTRIBUTED_FIRES_KEPT) {
        unattributedFires.shift();
      }
    },

    /**
     * A wake-up fired for `scheduledFor` (null when the CLI did not say): it
     * takes the pending wake-up unless that one was set for another time.
     * @param {number|null} scheduledFor
     */
    noteWakeupFire(scheduledFor) {
      if (wakeup && (!wakeup.exact || scheduledFor === null || scheduledFor === wakeup.at)) {
        wakeup = null;
      }
    },

    /** The wake-up chain ends: its fire's turn set no other. */
    endWakeupChain() {
      wakeup = null;
    },

    /**
     * A turn of the CLI's own for no fire it named, from a CLI that names
     * none, ended at `endedAt`: it may have been the fire of any job. Every
     * one-shot job due by then, or with no time, is gone, and a recurring job
     * whose result named no time is held past it (see above).
     * @param {number} endedAt
     */
    noteUnnamedFire(endedAt) {
      for (const job of [...jobs.values()]) {
        if (!job.recurring && (job.nextFireAt === null || job.nextFireAt <= endedAt)) {
          jobs.delete(job.key);
        }
      }
      holdUntimedJobsPast(endedAt);
    },

    /**
     * The CLI said something at `at` during a turn. It fires nothing while
     * it runs one, and the turn may be the fire of a job whose result named
     * no time: every such job is held `holdMaxMs` past it, up to its limit,
     * so the hold does not drop it, and let go of the process, in the middle
     * of a turn that is still talking.
     * @param {number} at
     */
    noteTurnActivity(at) {
      for (const job of jobs.values()) {
        if (!job.timed) {
          holdUntimedJobPast(job, at);
        }
      }
    },

    /**
     * Drops work past its `holdUntil`, and, unless the CLI is in a turn,
     * work that missed its fire (see above), logging a line for each.
     * @param {number} now
     * @param {{ inTurn: boolean, lastTurnEndedAt: number|null }} state
     */
    cleanUp(now, { inTurn, lastTurnEndedAt }) {
      if (wakeup && now >= wakeup.holdUntil) {
        log(`letting go of the /loop wake-up (chain ${wakeup.chainId}): it reached the hold limit`);
        wakeup = null;
      } else if (wakeup && !inTurn && missedAt(wakeup.at, now, lastTurnEndedAt)) {
        log(`letting go of the /loop wake-up (chain ${wakeup.chainId}): it did not fire by ${graceMs} ms past its time`);
        wakeup = null;
      }
      for (const job of [...jobs.values()]) {
        if (now >= job.holdUntil) {
          log(`letting go of ${describeJob(job)}: it reached the hold limit`);
          jobs.delete(job.key);
          continue;
        }
        if (inTurn || !missedAt(job.nextFireAt, now, lastTurnEndedAt)) {
          continue;
        }
        const since = job.lastFiredAt ?? job.createdAt;
        const index = unattributedFires.findLastIndex((firedAt) => firedAt > since);
        if (index !== -1) {
          const [firedAt] = unattributedFires.splice(index, 1);
          applyFire(job, firedAt);
          if (!jobs.has(job.key) || !missedAt(job.nextFireAt, now, lastTurnEndedAt)) {
            continue;
          }
        }
        log(`letting go of ${describeJob(job)}: it did not fire by ${graceMs} ms past its time`);
        jobs.delete(job.key);
      }
    },

    /** Whether any work holds the process (see above). @returns {boolean} */
    holdsProcess() {
      if (wakeup && holds(wakeup.at, wakeup.holdUntil)) {
        return true;
      }
      for (const job of jobs.values()) {
        if (holds(job.nextFireAt, job.holdUntil)) {
          return true;
        }
      }
      return false;
    },

    /**
     * When cleanUp may next have something to drop: the earliest `holdUntil`
     * and, unless the CLI is in a turn, the earliest time work with a known
     * next fire would count as missed. Null with no work.
     * @param {{ inTurn: boolean, lastTurnEndedAt: number|null }} state
     * @returns {number|null}
     */
    nextCheckAt({ inTurn, lastTurnEndedAt }) {
      const items = [
        ...(wakeup ? [{ nextFireAt: wakeup.at, holdUntil: wakeup.holdUntil }] : []),
        ...jobs.values(),
      ];
      let next = null;
      for (const item of items) {
        let due = item.holdUntil;
        if (!inTurn && item.nextFireAt !== null) {
          due = Math.min(due, Math.max(item.nextFireAt, lastTurnEndedAt ?? -Infinity) + graceMs);
        }
        next = next === null ? due : Math.min(next, due);
      }
      return next;
    },

    /** Whether any cron job is kept, holding the process or not. @returns {boolean} */
    hasCronJobs() {
      return jobs.size > 0;
    },

    /**
     * Whether a CLI that resumes the session brings all of this work back
     * (findRevivedCronJobs): there are cron jobs and no wake-up, which no
     * resume brings back, and each job has the id the CLI named and is not
     * durable (the project's .claude/scheduled_tasks.json keeps those, which
     * no spike has followed across a resume).
     * @returns {boolean}
     */
    revivesOnResume() {
      return wakeup === null
        && jobs.size > 0
        && [...jobs.values()].every((job) => typeof job.jobId === 'string' && !job.durable);
    },

    /**
     * The work as the runtime lists it (`ScheduledWorkSummary`), oldest first.
     * @returns {Array<import('@/shared/types.js').ScheduledWorkSummary>}
     */
    list() {
      const summaries = [...jobs.values()].map(jobSummary);
      if (wakeup) {
        summaries.push(wakeupSummary());
      }
      return summaries.sort((first, second) => first.startedAt - second.startedAt);
    },

    /**
     * The work a stop names: the one piece `id` names, or with `all` every
     * piece that can be stopped (isStoppableScheduledWorkId); null when `id`
     * names none. Each target carries its summary id, and a job its CLI id.
     * @param {string} id
     * @param {{ all?: boolean }} [options]
     * @returns {Array<{ id: string, kind: 'cron' | 'wakeup', jobId?: string }>|null}
     */
    stopTargets(id, { all = false } = {}) {
      const stoppable = [
        ...[...jobs.values()].map((job) => ({ id: `cron:${job.key}`, kind: 'cron', jobId: job.key })),
        ...(wakeup ? [{ id: `wakeup:${wakeup.chainId}`, kind: 'wakeup' }] : []),
      ].filter((target) => isStoppableScheduledWorkId(target.id));
      if (!stoppable.some((target) => target.id === id)) {
        return null;
      }
      return all ? stoppable : stoppable.filter((target) => target.id === id);
    },

    /** Forgets everything: the process has let go. */
    clear() {
      jobs.clear();
      wakeup = null;
      unattributedFires.length = 0;
      deletedJobIds.clear();
    },
  };
}

/**
 * The scheduled work a session's transcript holds that no process runs: the
 * cron jobs a CLI that resumes the session would bring back, and the wake-up
 * of a self-paced loop that was still to come (findPendingWakeup), as the
 * runtime lists work (`ScheduledWorkSummary`), each `paused`, oldest first.
 * The jobs' times are those of a process that would resume the session at
 * `now`; the wake-up keeps the time it was due, its id the call that set it
 * (`wakeup:<toolUseId>`).
 * @param {{ cronJobs: ReturnType<typeof findRevivedCronJobs>, wakeup: ReturnType<typeof findPendingWakeup> }} work
 * @param {number} now - Epoch ms
 * @param {{ holdMaxMs: number, scheduleHoldMaxMs: number, config?: typeof DEFAULT_CRON_CONFIG }} limits
 * @returns {Array<import('@/shared/types.js').ScheduledWorkSummary>}
 */
export function describePausedScheduledWork({ cronJobs, wakeup }, now, { holdMaxMs, scheduleHoldMaxMs, config = DEFAULT_CRON_CONFIG }) {
  const work = createScheduledWork({ holdMaxMs, scheduleHoldMaxMs, graceMs: 0, config });
  for (const job of cronJobs) {
    work.noteCronRevived(job, now);
  }
  const items = work.list();
  if (wakeup) {
    items.push({
      id: `wakeup:${wakeup.toolUseId}`,
      kind: 'wakeup',
      toolUseId: wakeup.toolUseId,
      prompt: describeLoopPrompt(wakeup.prompt),
      startedAt: wakeup.calledAt,
      nextFireAt: wakeup.scheduledFor,
      recurring: true,
      holdUntil: wakeup.calledAt + scheduleHoldMaxMs,
      ...(wakeup.reason ? { reason: wakeup.reason } : {}),
    });
  }
  return items
    .map((item) => ({ ...item, paused: true }))
    .sort((first, second) => first.startedAt - second.startedAt);
}
