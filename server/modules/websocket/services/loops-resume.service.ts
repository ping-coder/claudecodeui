import { scheduleHoldsDb, sessionsDb, type StoredScheduleHold } from '@/modules/database/index.js';
import type { AnyRecord, PausedScheduledWork, RunEndOutcome } from '@/shared/types.js';

/**
 * Resuming the loops of a session no process runs (see
 * `PausedScheduledWork`): the chat gateway's `chat.resume-loops`, and the
 * pass on start over the sessions the server held for scheduled work when it
 * went down (`ScheduleHoldRecord`).
 */

/** What reads a session's paused work: the provider runtime gateway. */
export type PausedWorkReader = {
  describePausedScheduledWork?(sessionId: string): Promise<PausedScheduledWork & { heldHere: boolean }>;
};

/** The options of the client's composer a resume falls back to: settings only, never attachments. */
const RESUME_CLIENT_OPTION_KEYS = ['model', 'permissionMode', 'effort', 'ultracode', 'toolsSettings'] as const;

/**
 * The run options a resumed turn gets from the record of the session's last
 * hold: the model, permission mode, effort, ultracode, tool settings and
 * working directory its process ran with. Null without a record.
 */
export function readResumeOptions(record: StoredScheduleHold | null): AnyRecord | null {
  if (!record) {
    return null;
  }
  const { launchOptions } = record;
  return {
    ...(launchOptions.model ? { model: launchOptions.model } : {}),
    permissionMode: launchOptions.permissionMode,
    ...(launchOptions.effort ? { effort: launchOptions.effort } : {}),
    ...(typeof launchOptions.ultracode === 'boolean' ? { ultracode: launchOptions.ultracode } : {}),
    toolsSettings: {
      allowedTools: [...launchOptions.allowedTools],
      disallowedTools: [...launchOptions.disallowedTools],
      skipPermissions: launchOptions.skipPermissions,
    },
    ...(record.cwd ? { cwd: record.cwd } : {}),
  };
}

/**
 * How a session's loops would be resumed now:
 * - `turn`: the turn that resumes them, its message and run options, and the
 *   paused items it resumes;
 * - `held`: a process of this server holds the session, so nothing is paused;
 * - `held_elsewhere`: a Claude CLI outside this server holds it and runs them;
 * - `nothing`: the transcript holds no loop to resume.
 */
export type LoopsResumePlan =
  | { status: 'turn'; content: string; options: AnyRecord; itemIds: string[] }
  | { status: 'held' | 'held_elsewhere' | 'nothing' };

/**
 * Works out the turn that resumes the session's paused loops. It runs with
 * what the session's last hold ran with (readResumeOptions), else with the
 * settings among `clientOptions` (a resume the user asks for sends the
 * composer's), else with the session's own.
 */
export async function planLoopsResume(
  sessionId: string,
  runtime: PausedWorkReader,
  clientOptions?: unknown,
): Promise<LoopsResumePlan> {
  if (!runtime.describePausedScheduledWork) {
    return { status: 'nothing' };
  }
  const paused = await runtime.describePausedScheduledWork(sessionId);
  if (paused.heldHere) {
    return { status: 'held' };
  }
  if (paused.heldElsewhere) {
    return { status: 'held_elsewhere' };
  }
  if (!paused.resumeContent || paused.items.length === 0) {
    return { status: 'nothing' };
  }
  let options = readResumeOptions(scheduleHoldsDb.get(sessionId));
  if (!options) {
    const client = clientOptions && typeof clientOptions === 'object' ? clientOptions as AnyRecord : {};
    options = Object.fromEntries(RESUME_CLIENT_OPTION_KEYS.filter((key) => key in client).map((key) => [key, client[key]]));
  }
  return { status: 'turn', content: paused.resumeContent, options, itemIds: paused.items.map((item) => item.id) };
}

/** How the boot pass starts one turn with no client attached (the chat gateway's runDetachedChatTurn). */
export type DetachedTurnRunner = (input: {
  sessionId: string;
  userId: string | number | null;
  content: string;
  options?: AnyRecord;
  onStarted?: () => void;
  onTurnEnded?: (ended: { outcome: Extract<RunEndOutcome, 'done' | 'failed' | 'aborted'> }) => void;
}) => Promise<{ started: boolean; error: string | null }>;

/** How long after the server has started the boot pass runs, so the sessions watcher has indexed the transcripts. */
export const RESUME_LOOPS_START_DELAY_MS = 10_000;
/** How many sessions the boot pass resumes at most, by default. */
export const DEFAULT_RESUME_LOOPS_MAX = 10;
/** How long the boot pass waits between two resumed sessions, so their CLIs do not all start at once. */
export const RESUME_LOOPS_STAGGER_MS = 5_000;

/**
 * Reads CLOUDCLI_RESUME_LOOPS_MAX: how many sessions the boot pass resumes
 * at most. A value that is not a whole number falls back to the default,
 * with a warning; 0 resumes none.
 */
export function resolveResumeLoopsMax(env: Record<string, string | undefined>): number {
  const raw = env.CLOUDCLI_RESUME_LOOPS_MAX?.trim();
  if (!raw) {
    return DEFAULT_RESUME_LOOPS_MAX;
  }
  if (/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) {
    return Number(raw);
  }
  console.warn(`[Loops] Ignoring CLOUDCLI_RESUME_LOOPS_MAX=${raw}: not a whole number`);
  return DEFAULT_RESUME_LOOPS_MAX;
}

const wait = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms).unref?.();
});

/** The session's record as stored now, when it is still the one `record` was read as (same run); null otherwise. */
function liveRecordOf(record: StoredScheduleHold): StoredScheduleHold | null {
  const current = scheduleHoldsDb.get(record.sessionId);
  return current && current.runId === record.runId ? current : null;
}

/**
 * Resumes, once the server has started, the loops of the sessions it held
 * for scheduled work when it went down (`records`, read from
 * `scheduleHoldsDb` at boot, before this server could start a run that
 * writes its own): each one whose
 * transcript still holds a loop to resume and that no process holds, with
 * the settings its process ran with, one turn per session, started
 * RESUME_LOOPS_STAGGER_MS apart and at most CLOUDCLI_RESUME_LOOPS_MAX of
 * them; the rest stay paused, for the user to resume from the chat. A record
 * with nothing left to resume, of a session gone, or of one a Claude CLI
 * outside this server holds is removed; one whose session a process of this
 * server already holds is left to that process, and so is one a run of this
 * server has written over or removed since boot: no turn goes from it.
 * CLOUDCLI_RESUME_LOOPS_ON_START=0 turns the pass off. Logs one line per
 * session.
 *
 * A record whose loops the pass leaves paused (the cap reached, the pass
 * off, a process of this server holding the session, loops that could not
 * be read, a turn that did not start, a turn the user stopped) is marked
 * (markLeftPaused) and kept for the settings a resume from the chat runs
 * with: a later start does not resume it, until a process holds the
 * session's loops again and writes it anew. A resumed session's record goes
 * once its turn has finished, the resumed process having written its own if
 * it holds the loops; it stays, for the next start, when the turn failed
 * (its CLI could not start, say).
 */
export async function resumeHeldLoopsOnStart({
  records,
  runtime,
  runTurn,
  env = process.env,
  pause = wait,
  log = (line: string) => console.log(line),
}: {
  records: StoredScheduleHold[];
  runtime: PausedWorkReader;
  runTurn: DetachedTurnRunner;
  env?: Record<string, string | undefined>;
  pause?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}): Promise<void> {
  // Every mark and removal below names the run of the record read at boot,
  // so it misses a row a run of this server has saved since.
  if (env.CLOUDCLI_RESUME_LOOPS_ON_START?.trim() === '0') {
    for (const record of records) {
      scheduleHoldsDb.markLeftPaused(record.sessionId, record.runId);
    }
    log('[Loops] Not resuming loops on start: CLOUDCLI_RESUME_LOOPS_ON_START=0');
    return;
  }
  const max = resolveResumeLoopsMax(env);
  let started = 0;
  for (const record of records) {
    const prefix = `[Loops] Session ${record.sessionId}:`;
    const leavePaused = (why: string) => {
      scheduleHoldsDb.markLeftPaused(record.sessionId, record.runId);
      log(`${prefix} ${why}; left paused`);
    };
    if (!sessionsDb.getSessionById(record.sessionId)) {
      scheduleHoldsDb.removeForRun(record.sessionId, record.runId);
      log(`${prefix} the session is gone; record removed`);
      continue;
    }
    let plan: LoopsResumePlan;
    try {
      plan = await planLoopsResume(record.sessionId, runtime);
    } catch (error) {
      leavePaused(`could not read its loops (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    if (plan.status === 'held') {
      // A row that process has already saved is not touched; one still of
      // the run before is written anew if that process holds the loops.
      scheduleHoldsDb.markLeftPaused(record.sessionId, record.runId);
      log(`${prefix} a process of this server already holds it`);
      continue;
    }
    if (plan.status !== 'turn') {
      scheduleHoldsDb.removeForRun(record.sessionId, record.runId);
      log(plan.status === 'held_elsewhere'
        ? `${prefix} a Claude CLI outside this server holds it; record removed`
        : `${prefix} nothing left to resume; record removed`);
      continue;
    }
    // A turn goes only from the record as it was at boot. A run of this
    // server that has held the loops since wrote its own over it, and removed
    // that when the user stopped them, which the transcript does not show.
    const rewritten = `${prefix} not resumed: a run of this server has rewritten or removed its record since boot`;
    const current = liveRecordOf(record);
    if (!current) {
      log(rewritten);
      continue;
    }
    if (current.leftPausedAt) {
      log(`${prefix} not resumed: an earlier start left it paused`);
      continue;
    }
    if (started >= max) {
      leavePaused(`not resumed: CLOUDCLI_RESUME_LOOPS_MAX (${max}) reached`);
      continue;
    }
    if (started > 0) {
      await pause(RESUME_LOOPS_STAGGER_MS);
      if (!liveRecordOf(record)) {
        log(rewritten);
        continue;
      }
    }
    const { content, options, itemIds } = plan;
    // The turn's run settles only once its process lets go, which a loop
    // puts off for days: the pass goes on once the turn has started.
    const result = await new Promise<{ started: boolean; error: string | null }>((resolve) => {
      runTurn({
        sessionId: record.sessionId,
        userId: record.userId,
        content,
        options,
        onStarted: () => resolve({ started: true, error: null }),
        onTurnEnded: ({ outcome }) => {
          if (outcome === 'done') {
            // The resumed process wrote its own record over this one if it
            // holds the loops: one still of the run before is stale.
            scheduleHoldsDb.removeForRun(record.sessionId, record.runId);
          } else if (outcome === 'aborted') {
            scheduleHoldsDb.markLeftPaused(record.sessionId, record.runId);
            log(`${prefix} the resuming turn was stopped; left paused`);
          } else {
            log(`${prefix} the resuming turn failed; record kept for the next start`);
          }
        },
      }).then(resolve, (error: unknown) => resolve({
        started: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    });
    if (result.started) {
      started += 1;
      log(`${prefix} resuming ${itemIds.length} loop(s): ${itemIds.join(', ')}`);
    } else {
      leavePaused(`could not resume its loops (${result.error ?? 'not started'})`);
    }
  }
}
