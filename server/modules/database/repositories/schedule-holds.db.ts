import { getConnection } from '@/modules/database/connection.js';
import type { LLMProvider, ScheduleHoldLaunchOptions, ScheduleHoldRecord } from '@/shared/types.js';

type ScheduleHoldRow = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  project_path: string | null;
  cwd: string | null;
  user_id: string | null;
  run_id: string;
  launch_options: string;
  updated_at: string;
  left_paused_at: string | null;
};

/**
 * A stored record as the runtime wrote it, plus when it last wrote it, and
 * when a pass on start left its loops paused (`leftPausedAt`, see
 * markLeftPaused), null while it has not.
 */
export type StoredScheduleHold = ScheduleHoldRecord & { updatedAt: string; leftPausedAt: string | null };

const COLUMNS = 'session_id, provider, provider_session_id, project_path, cwd, user_id, run_id, launch_options, updated_at, left_paused_at';

const readStringList = (value: unknown): string[] => (
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
);

/** The stored launch options, field by field: a value that does not read is left at its default. */
function parseLaunchOptions(raw: string): ScheduleHoldLaunchOptions {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    // A row that no longer parses resumes with the defaults.
  }
  return {
    model: typeof parsed.model === 'string' ? parsed.model : null,
    permissionMode: typeof parsed.permissionMode === 'string' ? parsed.permissionMode : 'default',
    effort: typeof parsed.effort === 'string' ? parsed.effort : null,
    ultracode: typeof parsed.ultracode === 'boolean' ? parsed.ultracode : null,
    allowedTools: readStringList(parsed.allowedTools),
    disallowedTools: readStringList(parsed.disallowedTools),
    skipPermissions: parsed.skipPermissions === true,
  };
}

function toRecord(row: ScheduleHoldRow): StoredScheduleHold {
  const numericUserId = row.user_id !== null && /^\d+$/.test(row.user_id) ? Number(row.user_id) : null;
  return {
    sessionId: row.session_id,
    provider: row.provider as LLMProvider,
    providerSessionId: row.provider_session_id,
    projectPath: row.project_path,
    cwd: row.cwd,
    userId: numericUserId ?? row.user_id,
    runId: row.run_id,
    launchOptions: parseLaunchOptions(row.launch_options),
    updatedAt: row.updated_at,
    leftPausedAt: row.left_paused_at ?? null,
  };
}

/**
 * The sessions whose process this server holds for scheduled work (see
 * `ScheduleHoldRecord`), one row per session. The Claude runtime writes and
 * removes them through its run context; the websocket module reads them to
 * resume the loops after a restart, drops the ones with nothing left to
 * resume, and marks the ones whose loops it leaves paused, which a later
 * restart does not resume until a process holds the session again.
 */
export const scheduleHoldsDb = {
  /** Writes the session's record, replacing whatever an earlier run wrote, its mark (markLeftPaused) included. */
  save(record: ScheduleHoldRecord): void {
    getConnection()
      .prepare(
        `INSERT INTO schedule_holds (session_id, provider, provider_session_id, project_path, cwd, user_id, run_id, launch_options, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(session_id) DO UPDATE SET
           provider = excluded.provider,
           provider_session_id = excluded.provider_session_id,
           project_path = excluded.project_path,
           cwd = excluded.cwd,
           user_id = excluded.user_id,
           run_id = excluded.run_id,
           launch_options = excluded.launch_options,
           updated_at = CURRENT_TIMESTAMP,
           left_paused_at = NULL`,
      )
      .run(
        record.sessionId,
        record.provider,
        record.providerSessionId,
        record.projectPath,
        record.cwd,
        record.userId === null ? null : String(record.userId),
        record.runId,
        JSON.stringify(record.launchOptions),
      );
  },

  /** Removes the session's record if the run named wrote it last. */
  removeForRun(sessionId: string, runId: string): void {
    getConnection().prepare('DELETE FROM schedule_holds WHERE session_id = ? AND run_id = ?').run(sessionId, runId);
  },

  /**
   * Marks the session's record, if the run named wrote it last, as left
   * paused by a pass on start: kept for the settings a resume from the chat
   * runs with, not resumed on start. The next save clears it. An earlier
   * mark keeps its time.
   */
  markLeftPaused(sessionId: string, runId: string): void {
    getConnection()
      .prepare('UPDATE schedule_holds SET left_paused_at = CURRENT_TIMESTAMP WHERE session_id = ? AND run_id = ? AND left_paused_at IS NULL')
      .run(sessionId, runId);
  },

  get(sessionId: string): StoredScheduleHold | null {
    const row = getConnection()
      .prepare(`SELECT ${COLUMNS} FROM schedule_holds WHERE session_id = ?`)
      .get(sessionId) as ScheduleHoldRow | undefined;
    return row ? toRecord(row) : null;
  },

  /** Every record, the most recently written first. */
  list(): StoredScheduleHold[] {
    const rows = getConnection()
      .prepare(`SELECT ${COLUMNS} FROM schedule_holds ORDER BY updated_at DESC, session_id ASC`)
      .all() as ScheduleHoldRow[];
    return rows.map(toRecord);
  },
};
