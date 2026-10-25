import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';

// The watcher resolves the other providers' roots from HOME when it is first
// imported, and its initial sync runs every real synchronizer, so HOME, the
// agy roots and the database must all point at fixtures before that import.
const fixtureHome = await mkdtemp(path.join(os.tmpdir(), 'agy-watcher-home-'));
const databaseDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-watcher-db-'));
const cliRoot = path.join(fixtureHome, '.gemini', 'antigravity-cli');
const legacyRoot = path.join(fixtureHome, '.gemini', 'antigravity');
const savedEnvironment = Object.fromEntries(
  ['HOME', 'USERPROFILE', 'AGY_DATA_DIRS', 'AGY_CLI_PATH', 'DATABASE_PATH'].map((key) => [key, process.env[key]]),
);
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;
process.env.AGY_DATA_DIRS = `${cliRoot}:${legacyRoot}`;
delete process.env.AGY_CLI_PATH;
process.env.DATABASE_PATH = path.join(databaseDirectory, 'auth.db');

const { closeSessionsWatcher, initializeSessionsWatcher } = await import(
  '@/modules/providers/services/sessions-watcher.service.js'
);

test.after(async () => {
  closeConnection();
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await rm(fixtureHome, { recursive: true, force: true });
  await rm(databaseDirectory, { recursive: true, force: true });
});

test('the sessions watcher never creates a missing agy root, and watches one that exists', async () => {
  closeConnection();
  await initializeDatabase();

  await initializeSessionsWatcher();
  try {
    // CloudCLI creates the roots it owns, never agy's.
    assert.ok(fs.existsSync(path.join(fixtureHome, '.claude', 'projects')));
    assert.equal(fs.existsSync(path.join(fixtureHome, '.gemini')), false);
  } finally {
    await closeSessionsWatcher();
  }

  fs.mkdirSync(legacyRoot, { recursive: true });
  await initializeSessionsWatcher();
  try {
    assert.equal(fs.existsSync(cliRoot), false);
    assert.deepEqual(fs.readdirSync(legacyRoot), []);
  } finally {
    await closeSessionsWatcher();
  }
});
