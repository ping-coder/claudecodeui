import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { runMigrations } from '@/modules/database/migrations.js';
import { INIT_SCHEMA_SQL } from '@/modules/database/schema.js';
import { checkDatabaseCopy } from '@/modules/database/tests/helpers/check-database-copy.js';

const ISOLATED_ENV_KEYS = ['DATABASE_PATH', 'HOME', 'AGY_CLI_PATH', 'AGY_DATA_DIRS'] as const;

/**
 * Runs `runTest` with HOME and DATABASE_PATH pointed into a fresh temp
 * directory, so the helper's live-database guard resolves to files the test
 * owns instead of the user's real ~/.cloudcli/auth.db.
 */
async function withIsolatedHome(
  runTest: (paths: { tempDirectory: string; homeDirectory: string }) => Promise<void>,
): Promise<void> {
  const previousEnv = Object.fromEntries(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'check-database-copy-'));
  const homeDirectory = path.join(tempDirectory, 'home');
  await mkdir(path.join(homeDirectory, '.cloudcli'), { recursive: true });

  process.env.HOME = homeDirectory;
  process.env.DATABASE_PATH = path.join(tempDirectory, 'configured-live.db');
  delete process.env.AGY_CLI_PATH;
  delete process.env.AGY_DATA_DIRS;

  try {
    await runTest({ tempDirectory, homeDirectory });
  } finally {
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

/** A database as the current release left it, except provider_models still has the pre-agy constraint. */
const writePreAgyDatabase = (databasePath: string): void => {
  const db = new Database(databasePath);
  db.exec(INIT_SCHEMA_SQL);
  runMigrations(db);
  db.exec(`
    DROP TABLE provider_models;
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
    CREATE INDEX idx_provider_models_provider_order ON provider_models(provider, sort_order, id);
    INSERT INTO provider_models (id, provider, model_id, model_name) VALUES (2, 'claude', 'a', 'A'), (5, 'codex', 'b', 'B');
    INSERT INTO users (username, password_hash) VALUES ('peace', 'hash');
  `);
  db.close();
};

const hashFile = async (filePath: string): Promise<string> =>
  createHash('sha256').update(await readFile(filePath)).digest('hex');

test('the copy check migrates a working copy and never writes to the file it was given', async () => {
  await withIsolatedHome(async ({ tempDirectory }) => {
    const copyPath = path.join(tempDirectory, 'auth-copy.db');
    writePreAgyDatabase(copyPath);
    const sourceHash = await hashFile(copyPath);

    const report = await checkDatabaseCopy(copyPath);

    assert.deepEqual(report.problems, []);
    assert.equal(report.before.integrity, 'ok');
    assert.equal(report.after.integrity, 'ok');
    assert.deepEqual(report.before.providerCheck, ['claude', 'cursor', 'codex', 'opencode']);
    assert.ok(report.after.providerCheck?.includes('agy'));
    assert.equal(report.agyInsertAccepted, true);
    assert.equal(report.after.tables.provider_models?.rows, 2);
    assert.equal(report.after.tables.users?.rows, 1);
    assert.equal(report.after.tables.users?.digest, report.before.tables.users?.digest);
    assert.equal(await hashFile(copyPath), sourceHash);
    assert.equal(existsSync(report.workingCopyPath), false);

    const keptReport = await checkDatabaseCopy(copyPath, { keepCopy: true });
    try {
      assert.equal(existsSync(keptReport.workingCopyPath), true);
      assert.equal(await hashFile(copyPath), sourceHash);
    } finally {
      await rm(path.dirname(keptReport.workingCopyPath), { recursive: true, force: true });
    }
  });
});

test('the copy check refuses the live database however it is reached', async () => {
  await withIsolatedHome(async ({ tempDirectory, homeDirectory }) => {
    const livePath = path.join(homeDirectory, '.cloudcli', 'auth.db');
    writePreAgyDatabase(livePath);
    const liveHash = await hashFile(livePath);
    const symlinkPath = path.join(tempDirectory, 'symlinked.db');
    const hardLinkPath = path.join(tempDirectory, 'hard-linked.db');
    await symlink(livePath, symlinkPath);
    await link(livePath, hardLinkPath);

    for (const candidate of [livePath, symlinkPath, hardLinkPath]) {
      await assert.rejects(checkDatabaseCopy(candidate), /Refusing to run against the live database/);
    }

    // DATABASE_PATH names the live database on machines that keep it elsewhere.
    const configuredLivePath = process.env.DATABASE_PATH ?? '';
    writePreAgyDatabase(configuredLivePath);
    await assert.rejects(checkDatabaseCopy(configuredLivePath), /Refusing to run against the live database/);

    await assert.rejects(checkDatabaseCopy(path.join(tempDirectory, 'missing.db')), /No database file/);
    assert.equal(await hashFile(livePath), liveHash);
  });
});
