import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  providerModelsDb,
} from '@/modules/database/index.js';
import { runMigrations } from '@/modules/database/migrations.js';
import { PROVIDER_MODELS_ALLOWED_PROVIDERS } from '@/modules/database/schema.js';

type SqliteConnection = ReturnType<typeof getConnection>;
type Row = Record<string, unknown>;

const CANONICAL_COLUMNS = [
  'id',
  'provider',
  'model_id',
  'model_name',
  'sort_order',
  'created_at',
  'updated_at',
  'effort_values',
  'effort_default',
];

// The constraint every database stored before agy existed.
const LEGACY_CHECK_LIST = "'claude', 'cursor', 'codex', 'opencode'";

const ISOLATED_ENV_KEYS = ['DATABASE_PATH', 'HOME', 'AGY_CLI_PATH', 'AGY_DATA_DIRS'] as const;

/**
 * Runs `runTest` against a database file in a fresh temp directory, with HOME
 * pointed into it and the agy overrides cleared, so nothing can reach the
 * user's real database or CLI data (the shell may export DATABASE_PATH).
 */
async function withIsolatedDatabase(
  prefix: string,
  runTest: (databasePath: string) => Promise<void>,
): Promise<void> {
  const previousEnv = Object.fromEntries(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const homeDirectory = path.join(tempDirectory, 'home');
  await mkdir(homeDirectory);

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.HOME = homeDirectory;
  delete process.env.AGY_CLI_PATH;
  delete process.env.AGY_DATA_DIRS;

  try {
    await runTest(process.env.DATABASE_PATH);
  } finally {
    closeConnection();
    for (const key of ISOLATED_ENV_KEYS) {
      const value = previousEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const readTableSql = (db: SqliteConnection, tableName = 'provider_models'): string | undefined =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
    | { sql: string }
    | undefined)?.sql;

const readRootPage = (db: SqliteConnection): number =>
  (db.prepare("SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'provider_models'").get() as {
    rootpage: number;
  }).rootpage;

/** The provider list of the stored CHECK constraint, or null when there is none. */
const readCheckedProviders = (db: SqliteConnection): string[] | null => {
  const match = /CHECK \(provider IN \(([^)]*)\)\)/.exec(readTableSql(db) ?? '');
  return match ? match[1].split(',').map((literal) => literal.trim().replace(/^'|'$/g, '')) : null;
};

const readColumnNames = (db: SqliteConnection): string[] =>
  (db.prepare('PRAGMA table_info(provider_models)').all() as Array<{ name: string }>).map((column) => column.name);

const readProviderModelRows = (db: SqliteConnection): Row[] =>
  db.prepare('SELECT * FROM provider_models ORDER BY id').all() as Row[];

const readSequence = (db: SqliteConnection): number | undefined =>
  (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'provider_models'").get() as { seq: number } | undefined)
    ?.seq;

const insertAgyModel = (db: SqliteConnection, modelId: string): void => {
  db.prepare("INSERT INTO provider_models (provider, model_id, model_name) VALUES ('agy', ?, ?)").run(modelId, modelId);
};

/**
 * Replaces provider_models with the table as an older build created it: the
 * given CHECK list (or none), the original seven columns plus any extra ones,
 * the order index, and the effort columns appended by `ALTER TABLE` the way
 * the effort migration added them on real upgrades.
 */
const replaceWithLegacyProviderModelsTable = (
  db: SqliteConnection,
  checkList: string | null,
  extraColumnsSql = '',
): void => {
  const providerCheck = checkList === null ? '' : ` CHECK (provider IN (${checkList}))`;
  db.exec(`
    DROP TABLE provider_models;
    CREATE TABLE provider_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL${providerCheck},
      model_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,${extraColumnsSql}
      UNIQUE(provider, model_id)
    );
    CREATE INDEX idx_provider_models_provider_order ON provider_models(provider, sort_order, id);
    ALTER TABLE provider_models ADD COLUMN effort_values TEXT DEFAULT NULL;
    ALTER TABLE provider_models ADD COLUMN effort_default TEXT DEFAULT NULL;
  `);
};

/** Rows in every other table, used to prove the rebuild touches nothing else. */
const seedOtherTables = (db: SqliteConnection): void => {
  db.exec(`
    INSERT INTO users (id, username, password_hash) VALUES (1, 'peace', 'hash');
    INSERT INTO api_keys (user_id, key_name, api_key) VALUES (1, 'ci', 'ck_test');
    INSERT INTO app_config (key, value) VALUES ('jwt_secret', 'secret');
    INSERT INTO projects (project_id, project_path) VALUES ('project-1', '/workspace/demo');
    INSERT INTO sessions (session_id, provider, provider_session_id, project_path, model, effort)
    VALUES ('session-1', 'claude', 'session-1', '/workspace/demo', 'opus', 'high'),
           ('session-2', 'agy', '7f1c2b9e-1111-4c5d-8e9f-000000000001', '/workspace/demo', 'auto', NULL);
    INSERT INTO user_preferences (user_id, preference_key, preference_value) VALUES (1, 'theme', '"dark"');
    INSERT INTO session_drafts (user_id, draft_scope, draft_text) VALUES (1, 'session-1', 'half a thought');
    INSERT INTO scheduled_messages (id, user_id, session_id, content, scheduled_for)
    VALUES ('scheduled-1', 1, 'session-1', 'later', '2030-01-01 00:00:00');
    INSERT INTO superseded_provider_sessions (provider_session_id, provider, session_id)
    VALUES ('old-codex-id', 'codex', 'session-1');
  `);
};

/** Contents of every table except provider_models, plus the other AUTOINCREMENT counters. */
const snapshotOtherTables = (db: SqliteConnection): Record<string, Row[]> => {
  const tableNames = (db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>)
    .map((table) => table.name)
    .filter((name) => name !== 'provider_models');

  return {
    ...Object.fromEntries(
      tableNames.map((name) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() as Row[]]),
    ),
    sqlite_sequence: db
      .prepare("SELECT name, seq FROM sqlite_sequence WHERE name <> 'provider_models' ORDER BY name")
      .all() as Row[],
  };
};

test('fresh installs create provider_models accepting agy without a rebuild', async () => {
  await withIsolatedDatabase('provider-models-check-fresh-', async () => {
    await initializeDatabase();
    const db = getConnection();

    assert.deepEqual(readCheckedProviders(db), [...PROVIDER_MODELS_ALLOWED_PROVIDERS]);
    assert.ok(PROVIDER_MODELS_ALLOWED_PROVIDERS.includes('agy'));
    // A rebuilt table is renamed into place, which quotes its name in the stored SQL.
    assert.match(readTableSql(db) ?? '', /^CREATE TABLE provider_models \(/);
    assert.deepEqual(readColumnNames(db), CANONICAL_COLUMNS);

    const created = providerModelsDb.createCustomProviderModel('agy', {
      model: 'Gemini 4 Argon (High)',
      id: 'gemini-launch-candidate-high',
      effort: { values: ['low', 'high'], default: 'high' },
    });
    assert.equal(created.provider, 'agy');
    assert.deepEqual(
      providerModelsDb.listCustomProviderModels('agy').map((model) => model.modelId),
      ['gemini-launch-candidate-high'],
    );
  });
});

test('a legacy provider_models table is rebuilt to accept agy with rows, ids, index and counter intact', async () => {
  await withIsolatedDatabase('provider-models-check-legacy-', async () => {
    await initializeDatabase();
    const legacyDb = getConnection();
    seedOtherTables(legacyDb);
    replaceWithLegacyProviderModelsTable(legacyDb, LEGACY_CHECK_LIST);
    legacyDb.exec(`
      INSERT INTO provider_models (id, provider, model_id, model_name, sort_order, created_at, updated_at, effort_values, effort_default)
      VALUES
        (3, 'claude', 'claude-custom', 'Claude Custom', 0, '2026-01-02 03:04:05', '2026-01-03 03:04:05', '["low","high"]', 'high'),
        (7, 'codex', 'gateway/model-v1', 'Gateway', 1, '2026-02-02 03:04:05', '2026-02-03 03:04:05', NULL, NULL),
        (12, 'opencode', 'local/qwen', 'Qwen', 0, '2026-03-02 03:04:05', '2026-03-03 03:04:05', '["max"]', NULL);
      -- Rows 13..40 were created and deleted, so the counter sits above MAX(id).
      UPDATE sqlite_sequence SET seq = 40 WHERE name = 'provider_models';
    `);
    assert.throws(() => insertAgyModel(legacyDb, 'rejected-before-upgrade'), /CHECK constraint failed/);
    const legacyRows = readProviderModelRows(legacyDb);
    const otherTables = snapshotOtherTables(legacyDb);
    closeConnection();

    await initializeDatabase();
    const db = getConnection();

    assert.deepEqual(readCheckedProviders(db), [...PROVIDER_MODELS_ALLOWED_PROVIDERS]);
    assert.deepEqual(readColumnNames(db), CANONICAL_COLUMNS);
    assert.deepEqual(readProviderModelRows(db), legacyRows);
    assert.equal(readSequence(db), 40);
    assert.deepEqual(
      (db.prepare('PRAGMA index_info(idx_provider_models_provider_order)').all() as Array<{ name: string }>)
        .map((column) => column.name),
      ['provider', 'sort_order', 'id'],
    );
    const uniqueIndexes = (db.prepare('PRAGMA index_list(provider_models)').all() as Array<{
      name: string;
      unique: number;
      origin: string;
    }>).filter((index) => index.unique === 1 && index.origin === 'u');
    assert.equal(uniqueIndexes.length, 1);
    assert.deepEqual(
      (db.prepare(`PRAGMA index_info(${uniqueIndexes[0].name})`).all() as Array<{ name: string }>)
        .map((column) => column.name),
      ['provider', 'model_id'],
    );
    assert.equal(readTableSql(db, 'provider_models__new'), undefined);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(snapshotOtherTables(db), otherTables);

    // AUTOINCREMENT continues above the old high-water mark instead of reusing ids.
    const agyModel = providerModelsDb.createCustomProviderModel('agy', { model: 'Gemini Pro Next', id: 'auto' });
    assert.equal(agyModel.recordId, 41);
    assert.equal(providerModelsDb.createCustomProviderModel('codex', { model: 'Next', id: 'next' }).recordId, 42);
    assert.throws(
      () => providerModelsDb.createCustomProviderModel('claude', { model: 'Duplicate', id: 'claude-custom' }),
      /UNIQUE constraint failed/,
    );
    assert.deepEqual(providerModelsDb.listCustomProviderModels('claude')[0]?.effort, {
      values: ['low', 'high'],
      default: 'high',
    });
  });
});

test('rerunning the migrations after the rebuild changes nothing', async () => {
  await withIsolatedDatabase('provider-models-check-rerun-', async () => {
    await initializeDatabase();
    replaceWithLegacyProviderModelsTable(getConnection(), LEGACY_CHECK_LIST);
    getConnection().exec(`
      INSERT INTO provider_models (id, provider, model_id, model_name) VALUES (5, 'cursor', 'custom', 'Custom');
      UPDATE sqlite_sequence SET seq = 9 WHERE name = 'provider_models';
    `);
    closeConnection();
    await initializeDatabase();

    const db = getConnection();
    const storedSql = readTableSql(db);
    const rootPage = readRootPage(db);
    const rows = readProviderModelRows(db);
    const schemaVersion = db.pragma('schema_version', { simple: true });
    assert.match(storedSql ?? '', /'agy'/);

    runMigrations(db);

    assert.equal(readTableSql(db), storedSql);
    // A second rebuild would have moved the table to a new root page.
    assert.equal(readRootPage(db), rootPage);
    assert.equal(db.pragma('schema_version', { simple: true }), schemaVersion);
    assert.deepEqual(readProviderModelRows(db), rows);
    assert.equal(readSequence(db), 9);
  });
});

test('the rebuilt constraint survives an older build re-running its CREATE IF NOT EXISTS statements', async () => {
  await withIsolatedDatabase('provider-models-check-old-ddl-', async () => {
    await initializeDatabase();
    replaceWithLegacyProviderModelsTable(getConnection(), LEGACY_CHECK_LIST);
    closeConnection();
    await initializeDatabase();

    const db = getConnection();
    // What INIT_SCHEMA_SQL and runMigrations execute in builds without agy (a rollback).
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_models (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT NOT NULL CHECK (provider IN (${LEGACY_CHECK_LIST})),
          model_id TEXT NOT NULL,
          model_name TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          effort_values TEXT DEFAULT NULL,
          effort_default TEXT DEFAULT NULL,
          UNIQUE(provider, model_id)
      );
      CREATE INDEX IF NOT EXISTS idx_provider_models_provider_order
      ON provider_models(provider, sort_order, id);
    `);

    assert.deepEqual(readCheckedProviders(db), [...PROVIDER_MODELS_ALLOWED_PROVIDERS]);
    insertAgyModel(db, 'auto');
    assert.equal(providerModelsDb.listCustomProviderModels('agy').length, 1);
  });
});

test('the rebuild keeps providers the stored constraint already accepted', async () => {
  await withIsolatedDatabase('provider-models-check-superset-', async () => {
    await initializeDatabase();
    replaceWithLegacyProviderModelsTable(getConnection(), `${LEGACY_CHECK_LIST}, 'gemini'`);
    getConnection().exec(`
      INSERT INTO provider_models (id, provider, model_id, model_name) VALUES (2, 'gemini', 'gemini-pro', 'Gemini Pro');
    `);
    closeConnection();
    await initializeDatabase();

    const db = getConnection();
    assert.deepEqual(readCheckedProviders(db), [...PROVIDER_MODELS_ALLOWED_PROVIDERS, 'gemini']);
    assert.deepEqual(
      readProviderModelRows(db).map((row) => [row.id, row.provider, row.model_id]),
      [[2, 'gemini', 'gemini-pro']],
    );
    insertAgyModel(db, 'auto');
  });
});

test('a provider_models table without a provider constraint is left alone', async () => {
  await withIsolatedDatabase('provider-models-check-none-', async () => {
    await initializeDatabase();
    replaceWithLegacyProviderModelsTable(getConnection(), null);
    const storedSql = readTableSql(getConnection());
    const rootPage = readRootPage(getConnection());
    closeConnection();
    await initializeDatabase();

    const db = getConnection();
    assert.equal(readTableSql(db), storedSql);
    assert.equal(readRootPage(db), rootPage);
    insertAgyModel(db, 'auto');
  });
});

test('a provider_models table with columns this build does not know is left alone', async () => {
  await withIsolatedDatabase('provider-models-check-unknown-column-', async () => {
    await initializeDatabase();
    replaceWithLegacyProviderModelsTable(getConnection(), LEGACY_CHECK_LIST, '\n      notes TEXT,');
    getConnection().exec(`
      INSERT INTO provider_models (id, provider, model_id, model_name, notes) VALUES (4, 'claude', 'kept', 'Kept', 'precious');
    `);
    const storedSql = readTableSql(getConnection());
    closeConnection();
    await initializeDatabase();

    const db = getConnection();
    assert.equal(readTableSql(db), storedSql);
    assert.equal(
      (db.prepare('SELECT notes FROM provider_models WHERE id = 4').get() as { notes: string }).notes,
      'precious',
    );
    assert.equal(readTableSql(db, 'provider_models__new'), undefined);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  });
});

test('a failed rebuild rolls back and leaves provider_models as it was', async () => {
  await withIsolatedDatabase('provider-models-check-rollback-', async () => {
    await initializeDatabase();
    const legacyDb = getConnection();
    replaceWithLegacyProviderModelsTable(legacyDb, LEGACY_CHECK_LIST);
    // A row its own constraint rejects makes the copy into the new table fail.
    legacyDb.pragma('ignore_check_constraints = ON');
    legacyDb.exec(`
      INSERT INTO provider_models (id, provider, model_id, model_name) VALUES (6, 'claude', 'fine', 'Fine');
      INSERT INTO provider_models (id, provider, model_id, model_name) VALUES (8, 'bogus', 'broken', 'Broken');
      UPDATE sqlite_sequence SET seq = 11 WHERE name = 'provider_models';
    `);
    legacyDb.pragma('ignore_check_constraints = OFF');
    const storedSql = readTableSql(legacyDb);
    const rows = readProviderModelRows(legacyDb);
    closeConnection();

    await assert.rejects(initializeDatabase(), /CHECK constraint failed/);

    const db = getConnection();
    assert.equal(db.inTransaction, false);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(readTableSql(db), storedSql);
    assert.equal(readTableSql(db, 'provider_models__new'), undefined);
    assert.deepEqual(readProviderModelRows(db), rows);
    assert.equal(readSequence(db), 11);
  });
});

test('rebuilding an empty table keeps the counter of deleted rows and otherwise starts ids at 1', async () => {
  await withIsolatedDatabase('provider-models-check-empty-', async () => {
    await initializeDatabase();
    replaceWithLegacyProviderModelsTable(getConnection(), LEGACY_CHECK_LIST);
    getConnection().exec(`
      INSERT INTO provider_models (provider, model_id, model_name) VALUES ('claude', 'a', 'A'), ('claude', 'b', 'B');
      DELETE FROM provider_models;
    `);
    closeConnection();
    await initializeDatabase();

    // The copy inserts nothing, so the old counter has to be written back.
    assert.equal(readSequence(getConnection()), 2);
    insertAgyModel(getConnection(), 'auto');
    assert.equal(readProviderModelRows(getConnection())[0]?.id, 3);
  });

  await withIsolatedDatabase('provider-models-check-never-used-', async () => {
    await initializeDatabase();
    // Like the live peace-cc database: an empty table that never had a row.
    replaceWithLegacyProviderModelsTable(getConnection(), LEGACY_CHECK_LIST);
    closeConnection();
    await initializeDatabase();

    const db = getConnection();
    assert.deepEqual(readCheckedProviders(db), [...PROVIDER_MODELS_ALLOWED_PROVIDERS]);
    // SQLite may record a zero counter for the empty copy; either way ids start at 1.
    assert.equal(readSequence(db) ?? 0, 0);
    insertAgyModel(db, 'auto');
    assert.equal(readProviderModelRows(db)[0]?.id, 1);
  });
});
