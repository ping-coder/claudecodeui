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
 * Keeps the scheduled work of one run's process: what its CronCreate and
 * ScheduleWakeup calls set up, which fire was whose, and when to give up on
 * work that never fires.
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

    /** A CronDelete call's result (not an error). @param {unknown} jobId */
    noteCronDeleted(jobId) {
      if (typeof jobId === 'string') {
        jobs.delete(jobId);
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
    },
  };
}
