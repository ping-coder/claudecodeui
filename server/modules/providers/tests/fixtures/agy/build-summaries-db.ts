import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

/**
 * Builds agy's conversation index (`conversation_summaries.db`) for tests, at
 * test time, so no binary database is committed.
 *
 * The schema is agy's own, as found in a real index. agy keeps the index in
 * WAL mode; after `buildAgySummariesDb` closes its connection SQLite has
 * checkpointed and removed `-wal`/`-shm` (the state of an index no agy process
 * has open), while `openAgySummariesWriter` keeps a connection open the way a
 * running agy does, so `-wal`/`-shm` exist and new rows sit in the WAL.
 */

/** Go's zero `time.Time`, which agy writes for a time it never set. */
export const AGY_ZERO_TIME = '0001-01-01 00:00:00+00:00';

const AGY_SUMMARIES_SCHEMA_SQL = `
CREATE TABLE \`conversation_summaries\` (\`conversation_id\` text,\`title\` text NOT NULL DEFAULT "",\`preview\` text NOT NULL DEFAULT "",\`step_count\` integer NOT NULL DEFAULT 0,\`last_modified_time\` datetime NOT NULL,\`workspace_uris\` text NOT NULL,\`status\` text NOT NULL DEFAULT "",\`source\` text NOT NULL DEFAULT "",\`project_id\` text NOT NULL DEFAULT "",\`agent_name\` text NOT NULL DEFAULT "",\`parent_conversation_id\` text NOT NULL DEFAULT "",\`nesting_depth\` integer NOT NULL DEFAULT 0,\`battle_id\` text NOT NULL DEFAULT "",\`winning_conversation_id\` text NOT NULL DEFAULT "",\`not_fully_idle\` numeric NOT NULL DEFAULT false,\`killed\` numeric NOT NULL DEFAULT false,\`last_user_input_time\` datetime NOT NULL,\`last_user_input_step_index\` integer NOT NULL DEFAULT -1,\`app_data_dir\` text NOT NULL DEFAULT "",\`raw_summary\` blob,\`group_id\` text NOT NULL DEFAULT "",PRIMARY KEY (\`conversation_id\`));
CREATE INDEX \`idx_conversation_summaries_last_modified_time\` ON \`conversation_summaries\`(\`last_modified_time\`);
CREATE INDEX \`idx_conversation_summaries_last_user_input_time\` ON \`conversation_summaries\`(\`last_user_input_time\`);
`;

/** One index row; omitted columns take agy's defaults. */
export type AgySummaryFixtureRow = {
  conversation_id: string;
  title?: string;
  preview?: string;
  step_count?: number;
  last_modified_time?: string;
  workspace_uris?: string;
  parent_conversation_id?: string;
  nesting_depth?: number;
  killed?: number;
  battle_id?: string;
  raw_summary?: Buffer | null;
};

/** Path of the index inside a data root. */
export function agySummariesDbPath(root: string): string {
  return path.join(root, 'conversation_summaries.db');
}

/** Inserts (or replaces) index rows through an open connection. */
export function insertAgySummaryRows(database: Database.Database, rows: AgySummaryFixtureRow[]): void {
  const insert = database.prepare(`
    INSERT OR REPLACE INTO conversation_summaries (
      conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
      parent_conversation_id, nesting_depth, killed, battle_id, last_user_input_time, raw_summary
    ) VALUES (
      @conversation_id, @title, @preview, @step_count, @last_modified_time, @workspace_uris,
      @parent_conversation_id, @nesting_depth, @killed, @battle_id, @last_user_input_time, @raw_summary
    )
  `);
  const insertAll = database.transaction((entries: AgySummaryFixtureRow[]) => {
    for (const row of entries) {
      insert.run({
        conversation_id: row.conversation_id,
        title: row.title ?? '',
        preview: row.preview ?? '',
        step_count: row.step_count ?? 0,
        last_modified_time: row.last_modified_time ?? AGY_ZERO_TIME,
        workspace_uris: row.workspace_uris ?? '[]',
        parent_conversation_id: row.parent_conversation_id ?? '',
        nesting_depth: row.nesting_depth ?? 0,
        killed: row.killed ?? 0,
        battle_id: row.battle_id ?? '',
        last_user_input_time: row.last_modified_time ?? AGY_ZERO_TIME,
        raw_summary: row.raw_summary ?? null,
      });
    }
  });
  insertAll(rows);
}

/**
 * Creates `<root>/conversation_summaries.db` (and `root` itself) in WAL mode
 * with the given rows, then closes it. Returns the database path.
 */
export function buildAgySummariesDb(root: string, rows: AgySummaryFixtureRow[]): string {
  fs.mkdirSync(root, { recursive: true });
  const databasePath = agySummariesDbPath(root);
  const database = new Database(databasePath);
  try {
    database.pragma('journal_mode = WAL');
    database.exec(AGY_SUMMARIES_SCHEMA_SQL);
    insertAgySummaryRows(database, rows);
  } finally {
    database.close();
  }
  return databasePath;
}

/** Opens an existing index read-write and keeps it open, like a running agy. */
export function openAgySummariesWriter(root: string): Database.Database {
  const database = new Database(agySummariesDbPath(root), { fileMustExist: true });
  database.pragma('journal_mode = WAL');
  // Keep commits in the WAL instead of checkpointing them into the main file.
  database.pragma('wal_autocheckpoint = 0');
  return database;
}
