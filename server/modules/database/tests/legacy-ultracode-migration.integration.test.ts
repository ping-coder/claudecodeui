import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { runMigrations } from '@/modules/database/migrations.js';

type SessionSelectionRow = { session_id: string; effort: string | null; ultracode: number | null };
type ModelEffortRow = { model_id: string; effort_values: string | null; effort_default: string | null };

/**
 * Writes a database as it looked while ultracode was the sixth Claude effort
 * level: the sessions table has an `effort` column but no `ultracode` one.
 */
const writeLegacyDatabase = (databasePath: string): void => {
  const legacyDb = new Database(databasePath);
  legacyDb.exec(`
    CREATE TABLE sessions (
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude',
      provider_session_id TEXT,
      custom_name TEXT,
      project_path TEXT,
      jsonl_path TEXT,
      model TEXT,
      effort TEXT,
      forked_from_session_id TEXT,
      isArchived BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (session_id)
    );
    INSERT INTO sessions (session_id, provider, provider_session_id, model, effort) VALUES
      ('legacy-ultracode', 'claude', 'legacy-ultracode', 'opus', 'ultracode'),
      ('plain-high', 'claude', 'plain-high', 'opus', 'high'),
      ('no-effort', 'claude', 'no-effort', 'opus', NULL);

    CREATE TABLE provider_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL CHECK (provider IN ('claude', 'cursor', 'codex', 'opencode')),
      model_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      effort_values TEXT DEFAULT NULL,
      effort_default TEXT DEFAULT NULL,
      UNIQUE(provider, model_id)
    );
    INSERT INTO provider_models (provider, model_id, model_name, effort_values, effort_default) VALUES
      ('claude', 'ultracode-default', 'Ultracode default', '["low","high","ultracode"]', 'ultracode'),
      ('claude', 'with-xhigh', 'With xhigh', '["low","xhigh","max","ultracode"]', 'max'),
      ('claude', 'with-max', 'With max', '["low","max","ultracode"]', NULL),
      ('claude', 'only-ultracode', 'Only ultracode', '["ultracode"]', NULL),
      ('claude', 'no-ultracode', 'No ultracode', '["low","high"]', 'high'),
      ('claude', 'malformed', 'Malformed', 'not json "ultracode"', 'ultracode'),
      ('claude', 'not-an-array', 'Not an array', '{"values":["ultracode"]}', NULL),
      ('codex', 'other-provider', 'Other provider', '["ultracode"]', 'ultracode');
  `);
  legacyDb.close();
};

const readSessions = (): SessionSelectionRow[] => getConnection()
  .prepare('SELECT session_id, effort, ultracode FROM sessions ORDER BY session_id')
  .all() as SessionSelectionRow[];

const readModels = (): Record<string, Omit<ModelEffortRow, 'model_id'>> => Object.fromEntries(
  (getConnection()
    .prepare('SELECT model_id, effort_values, effort_default FROM provider_models')
    .all() as ModelEffortRow[])
    .map(({ model_id: modelId, ...effort }) => [modelId, effort]),
);

test('migrations split the legacy ultracode effort into xhigh plus the ultracode switch', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'legacy-ultracode-migration-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  writeLegacyDatabase(databasePath);

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    assert.deepEqual(readSessions(), [
      { session_id: 'legacy-ultracode', effort: 'xhigh', ultracode: 1 },
      // Rows that never ran the legacy token keep "no choice recorded".
      { session_id: 'no-effort', effort: null, ultracode: null },
      { session_id: 'plain-high', effort: 'high', ultracode: null },
    ]);

    assert.deepEqual(readModels(), {
      'ultracode-default': { effort_values: '["low","high","xhigh"]', effort_default: 'xhigh' },
      // xhigh is never listed twice.
      'with-xhigh': { effort_values: '["low","xhigh","max"]', effort_default: 'max' },
      // Levels stay weakest first: xhigh goes before a declared max.
      'with-max': { effort_values: '["low","xhigh","max"]', effort_default: null },
      'only-ultracode': { effort_values: '["xhigh"]', effort_default: null },
      'no-ultracode': { effort_values: '["low","high"]', effort_default: 'high' },
      // Values the repository already reads as "no levels" are left as they are.
      malformed: { effort_values: 'not json "ultracode"', effort_default: 'ultracode' },
      'not-an-array': { effort_values: '{"values":["ultracode"]}', effort_default: null },
      // Only Claude ever offered ultracode as an effort level.
      'other-provider': { effort_values: '["ultracode"]', effort_default: 'ultracode' },
    });

    const migratedSessions = readSessions();
    const migratedModels = readModels();
    runMigrations(getConnection());
    assert.deepEqual(readSessions(), migratedSessions);
    assert.deepEqual(readModels(), migratedModels);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('a legacy ultracode effort written back later keeps an explicitly recorded switch', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'legacy-ultracode-writeback-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    // An older build replaying a queued message can write the token back onto
    // a row whose switch the user has since turned off.
    const db = getConnection();
    db.prepare(`
      INSERT INTO sessions (session_id, provider, provider_session_id, effort, ultracode)
      VALUES ('written-back-off', 'claude', 'written-back-off', 'ultracode', 0),
             ('written-back-unset', 'claude', 'written-back-unset', 'ultracode', NULL)
    `).run();

    runMigrations(db);

    assert.deepEqual(readSessions(), [
      { session_id: 'written-back-off', effort: 'xhigh', ultracode: 0 },
      { session_id: 'written-back-unset', effort: 'xhigh', ultracode: 1 },
    ]);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
