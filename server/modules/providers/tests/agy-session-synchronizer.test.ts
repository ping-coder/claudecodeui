import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appConfigDb, closeConnection, initializeDatabase, scanStateDb, sessionsDb } from '@/modules/database/index.js';
import { AgySessionSynchronizer } from '@/modules/providers/list/agy/agy-session-synchronizer.provider.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import {
  AGY_ZERO_TIME,
  agySummariesDbPath,
  buildAgySummariesDb,
  insertAgySummaryRows,
  openAgySummariesWriter,
} from '@/modules/providers/tests/fixtures/agy/build-summaries-db.js';
import {
  type AgyTestRoots,
  agyTranscriptDirectory,
  createAgyTestRoots,
  placeAgyTranscript,
  setFileTime,
  snapshotTree,
} from '@/modules/providers/tests/fixtures/agy/agy-test-roots.js';

const ID_A = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const ID_B = '0b8f6a9e-1c2d-4e3f-8a5b-6c7d8e9f0a1b';
const ID_C = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const ID_D = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const ID_E = '3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f';
const ID_F = '4d5e6f7a-8b9c-4d0e-9f2a-3b4c5d6e7f8a';

const T0 = '2026-10-20 08:00:00.000000000+00:00';
const T0_MS = Date.UTC(2026, 9, 20, 8, 0, 0, 0);
const T1 = '2026-10-25 12:56:42.887272639+00:00';
const T1_MS = Date.UTC(2026, 9, 25, 12, 56, 42, 887);
const T2 = '2026-10-25 13:30:00.250000000+00:00';
const T2_MS = Date.UTC(2026, 9, 25, 13, 30, 0, 250);
const T3 = '2026-10-25 14:00:00+00:00';

const ROOT_WATERMARKS_KEY = 'agy_root_watermarks';
const WATERMARK_SAFETY_MARGIN_MS = 5_000;

/** The per-root watermarks the synchronizer persisted. */
function readWatermarks(): Record<string, number> {
  return JSON.parse(appConfigDb.get(ROOT_WATERMARKS_KEY) ?? '{}') as Record<string, number>;
}

/** agy's own time format (nanoseconds, explicit offset) for an epoch-milliseconds time. */
function agyTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').replace('Z', '000000+00:00');
}

/** A synchronizer whose clock reads `clock.now`, so tests decide when each scan starts. */
function synchronizerAt(clock: { now: number }): AgySessionSynchronizer {
  return new AgySessionSynchronizer(() => clock.now);
}

/** Writes index rows through a short-lived connection, the way an agy process commits them. */
function writeAgySummaryRows(root: string, rows: Parameters<typeof insertAgySummaryRows>[1]): void {
  const writer = openAgySummariesWriter(root);
  try {
    insertAgySummaryRows(writer, rows);
  } finally {
    writer.close();
  }
}

/** Deletes a session permanently, as the sidebar's "Delete permanently" does. */
async function forceDeleteSession(sessionId: string): Promise<void> {
  await sessionsService.deleteOrArchiveSessionById(sessionId, { force: true, deletedFromDisk: true });
}

/** Fresh CloudCLI database and agy roots per test; nothing touches the real ~/.cloudcli or ~/.gemini. */
async function withAgyEnvironment(run: (roots: AgyTestRoots) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const databaseDirectory = await mkdtemp(path.join(os.tmpdir(), 'agy-sync-db-'));
  const roots = await createAgyTestRoots();

  closeConnection();
  process.env.DATABASE_PATH = path.join(databaseDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await run(roots);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await roots.restore();
    await rm(databaseDirectory, { recursive: true, force: true });
  }
}

test('indexes top-level conversations with a null jsonl_path, their project, name and time', { concurrency: false }, async () => {
  await withAgyEnvironment(async ({ home, legacyRoot }) => {
    buildAgySummariesDb(legacyRoot, [
      { conversation_id: ID_A, title: 'Top level', last_modified_time: T1, workspace_uris: '["file:///srv/my%20app"]' },
      { conversation_id: ID_B, title: 'Subagent', last_modified_time: T1, nesting_depth: 1, parent_conversation_id: ID_A },
      { conversation_id: ID_C, title: 'Killed', last_modified_time: T1, killed: 1 },
      { conversation_id: ID_D, title: 'Zero time', last_modified_time: AGY_ZERO_TIME, workspace_uris: '["file:///srv/app"]' },
      { conversation_id: ID_E, last_modified_time: T2, workspace_uris: '["file:///srv/app"]' },
      { conversation_id: ID_F, preview: 'Only a preview', last_modified_time: T2, workspace_uris: '[]' },
    ]);
    setFileTime(placeAgyTranscript(legacyRoot, ID_D, 'transcript.jsonl'), Date.UTC(2026, 9, 21, 9, 0, 0, 0));
    placeAgyTranscript(legacyRoot, ID_E);

    const processed = await new AgySessionSynchronizer().synchronize();

    assert.equal(processed, 4);
    const indexed = sessionsDb.getSessionById(ID_A);
    assert.equal(indexed?.provider, 'agy');
    assert.equal(indexed?.provider_session_id, ID_A);
    assert.equal(indexed?.jsonl_path, null);
    assert.equal(indexed?.project_path, '/srv/my app');
    assert.equal(indexed?.custom_name, 'Top level');
    assert.equal(indexed?.updated_at, new Date(T1_MS).toISOString());
    assert.equal(sessionsDb.getSessionById(ID_B), null);
    assert.equal(sessionsDb.getSessionById(ID_C), null);
    assert.equal(sessionsDb.getSessionById(ID_D)?.updated_at, '2026-10-21T09:00:00.000Z');
    assert.equal(sessionsDb.getSessionById(ID_E)?.custom_name, 'Read /tmp/agy-probe/hello.txt and list the folder');
    assert.equal(sessionsDb.getSessionById(ID_F)?.project_path, home);
    assert.equal(sessionsDb.getSessionById(ID_F)?.custom_name, 'Only a preview');
    assert.ok(sessionsDb.getAllSessions().every((session) => session.jsonl_path === null));
  });
});

test('returns 0 without errors and creates nothing when no agy root exists', { concurrency: false }, async () => {
  await withAgyEnvironment(async ({ home, cliRoot, legacyRoot }) => {
    const synchronizer = new AgySessionSynchronizer();

    assert.equal(await synchronizer.synchronize(), 0);
    assert.equal(await synchronizer.synchronize(new Date()), 0);
    assert.equal(await synchronizer.synchronizeFile(agySummariesDbPath(legacyRoot)), null);
    assert.equal(await synchronizer.synchronizeFile(path.join(agyTranscriptDirectory(cliRoot, ID_A), 'transcript_full.jsonl')), null);
    assert.equal(fs.existsSync(path.join(home, '.gemini')), false);
    assert.deepEqual(sessionsDb.getAllSessions(), []);
    // A root without an index has nothing to mark: it is scanned in full once it has one.
    assert.equal(appConfigDb.get(ROOT_WATERMARKS_KEY), null);
  });
});

test('never claims a pending CloudCLI session for a conversation', { concurrency: false }, async () => {
  await withAgyEnvironment(async ({ legacyRoot }) => {
    sessionsDb.createAppSession('pending-app-session', 'agy', '/srv/app', 'New chat');
    buildAgySummariesDb(legacyRoot, [
      { conversation_id: ID_A, title: 'Started in a terminal', last_modified_time: T1, workspace_uris: '["file:///srv/app"]' },
    ]);

    await new AgySessionSynchronizer().synchronize();

    assert.equal(sessionsDb.getSessionById('pending-app-session')?.provider_session_id, null);
    assert.equal(sessionsDb.getSessionById(ID_A)?.custom_name, 'Started in a terminal');
  });
});

test('a CloudCLI chat bound to its conversation keeps its project and name', { concurrency: false }, async () => {
  await withAgyEnvironment(async ({ legacyRoot }) => {
    sessionsDb.createAppSession('app-session', 'agy', '/projects/web', 'CloudCLI title');
    sessionsDb.assignProviderSessionId('app-session', ID_A);
    buildAgySummariesDb(legacyRoot, [
      { conversation_id: ID_A, title: 'agy title', last_modified_time: T1, workspace_uris: '[]' },
    ]);
    const synchronizer = new AgySessionSynchronizer();

    await synchronizer.synchronize();

    const session = sessionsDb.getSessionById('app-session');
    assert.equal(session?.project_path, '/projects/web');
    assert.equal(session?.custom_name, 'CloudCLI title');
    assert.equal(session?.updated_at, new Date(T1_MS).toISOString());
    assert.equal(sessionsDb.getSessionById(ID_A), null);

    placeAgyTranscript(legacyRoot, ID_A);
    const transcript = path.join(agyTranscriptDirectory(legacyRoot, ID_A), 'transcript_full.jsonl');
    assert.equal(await synchronizer.synchronizeFile(transcript), 'app-session');
  });
});

test('keeps a name the user gave and lets agy\'s title replace a name taken from its preview', { concurrency: false }, async () => {
  await withAgyEnvironment(async ({ legacyRoot }) => {
    buildAgySummariesDb(legacyRoot, [
      { conversation_id: ID_A, preview: 'First prompt of A', last_modified_time: T1 },
      { conversation_id: ID_B, preview: 'First prompt of B', last_modified_time: T1 },
      { conversation_id: ID_C, last_modified_time: T1 },
    ]);
    const synchronizer = synchronizerAt({ now: T1_MS + 60_000 });
    await synchronizer.synchronize();
    assert.equal(sessionsDb.getSessionById(ID_A)?.custom_name, 'First prompt of A');
    assert.equal(sessionsDb.getSessionById(ID_C)?.custom_name, 'Untitled');

    sessionsDb.updateSessionCustomName(ID_B, 'Renamed by the user');
    const writer = openAgySummariesWriter(legacyRoot);
    try {
      insertAgySummaryRows(writer, [
        { conversation_id: ID_A, title: 'Agy title A', preview: 'First prompt of A', last_modified_time: T2 },
        { conversation_id: ID_B, title: 'Agy title B', preview: 'First prompt of B', last_modified_time: T2 },
        { conversation_id: ID_C, title: 'Agy title C', last_modified_time: T2 },
      ]);
    } finally {
      writer.close();
    }

    assert.equal(await synchronizer.synchronize(), 3);
    assert.equal(sessionsDb.getSessionById(ID_A)?.custom_name, 'Agy title A');
    assert.equal(sessionsDb.getSessionById(ID_B)?.custom_name, 'Renamed by the user');
    assert.equal(sessionsDb.getSessionById(ID_C)?.custom_name, 'Agy title C');
  });
});

test('scans a root in full once, then only what agy modified since the root\'s watermark', { concurrency: false }, async () => {
  await withAgyEnvironment(async ({ legacyRoot }) => {
    buildAgySummariesDb(legacyRoot, [
      { conversation_id: ID_A, title: 'Old', last_modified_time: T0 },
      { conversation_id: ID_B, title: 'B', last_modified_time: T1 },
      { conversation_id: ID_C, title: 'C', last_modified_time: T2 },
      { conversation_id: ID_D, title: 'Undated', last_modified_time: AGY_ZERO_TIME },
    ]);
    const clock = { now: T2_MS + 3_600_000 };
    const synchronizer = synchronizerAt(clock);

    // The first scan is full whatever the shared cursor says (an install that already has one).
    assert.equal(await synchronizer.synchronize(new Date(T2_MS + 60_000)), 4);
    assert.deepEqual(readWatermarks(), { [legacyRoot]: clock.now - WATERMARK_SAFETY_MARGIN_MS });

    // Nothing modified since: nothing to do, with or without a cursor.
    clock.now += 60_000;
    assert.equal(await synchronizer.synchronize(), 0);
    assert.equal(await synchronizer.synchronize(new Date(0)), 0);
    assert.equal(await new AgySessionSynchronizer(() => clock.now).synchronize(), 0);

    // agy changes B and adds E. B is dated inside the safety margin, just
    // before the last scan started, as a commit that landed after the index
    // was copied can be: it still counts.
    const watermark = readWatermarks()[legacyRoot];
    writeAgySummaryRows(legacyRoot, [
      { conversation_id: ID_B, title: 'B changed', last_modified_time: agyTime(watermark + 1_000) },
      { conversation_id: ID_E, title: 'E', last_modified_time: agyTime(clock.now + 10_000) },
    ]);
    clock.now += 60_000;
    assert.equal(await synchronizer.synchronize(), 2);
    assert.equal(sessionsDb.getSessionById(ID_B)?.updated_at, new Date(watermark + 1_000).toISOString());
    assert.equal(sessionsDb.getSessionById(ID_E)?.custom_name, 'E');
    assert.equal(await synchronizer.synchronize(), 0);
  });
});

test('a watermark compares at millisecond precision with agy\'s nanosecond times', { concurrency: false }, async () => {
  await withAgyEnvironment(async ({ legacyRoot }) => {
    buildAgySummariesDb(legacyRoot, [
      { conversation_id: ID_A, title: 'Just before', last_modified_time: agyTime(T1_MS - 1) },
      // 12:56:42.887272639
      { conversation_id: ID_B, title: 'At the watermark', last_modified_time: T1 },
    ]);
    const synchronizer = synchronizerAt({ now: T1_MS + WATERMARK_SAFETY_MARGIN_MS });

    assert.equal(await synchronizer.synchronize(), 2);
    assert.equal(readWatermarks()[legacyRoot], T1_MS);
    // A watermark of .887 still includes .887272639.
    assert.equal(await synchronizer.synchronize(), 1);
  });
});

test('an unchanged rescan neither moves nor un-archives a session, dated or not', { concurrency: false }, async () => {
  await withAgyEnvironment(async ({ legacyRoot }) => {
    buildAgySummariesDb(legacyRoot, [
      { conversation_id: ID_A, title: 'Dated', last_modified_time: T1 },
      { conversation_id: ID_B, title: 'Undated', last_modified_time: AGY_ZERO_TIME },
    ]);
    const synchronizer = new AgySessionSynchronizer();
    await synchronizer.synchronize();
    sessionsDb.updateSessionIsArchived(ID_A, true);
    sessionsDb.updateSessionIsArchived(ID_B, true);
    const undatedBefore = sessionsDb.getSessionById(ID_B)?.updated_at;

    await synchronizer.synchronize();
    // Even a full rescan (a root without a watermark) rewrites them unchanged.
    appConfigDb.set(ROOT_WATERMARKS_KEY, '{}');
    assert.equal(await new AgySessionSynchronizer().synchronize(), 2);

    assert.equal(sessionsDb.getSessionById(ID_A)?.isArchived, 1);
    assert.equal(sessionsDb.getSessionById(ID_A)?.updated_at, new Date(T1_MS).toISOString());
    assert.equal(sessionsDb.getSessionById(ID_B)?.isArchived, 1);
    assert.equal(sessionsDb.getSessionById(ID_B)?.updated_at, undatedBefore);
  });
});

test('keeps the newest copy of a conversation stored in both roots', { concurrency: false }, async () => {
  await withAgyEnvironment(async ({ cliRoot, legacyRoot }) => {
    buildAgySummariesDb(cliRoot, [{ conversation_id: ID_A, title: 'Newer in cli', last_modified_time: T2, workspace_uris: '["file:///srv/new"]' }]);
    buildAgySummariesDb(legacyRoot, [{ conversation_id: ID_A, title: 'Older in legacy', last_modified_time: T1, workspace_uris: '["file:///srv/old"]' }]);

    assert.equal(await new AgySessionSynchronizer().synchronize(), 1);

    assert.equal(sessionsDb.getSessionById(ID_A)?.project_path, '/srv/new');
    assert.equal(sessionsDb.getSessionById(ID_A)?.updated_at, new Date(T2_MS).toISOString());
  });
});

test('a root that fails to read does not stop the others, and one never read is scanned in full once readable', { concurrency: false }, async (t) => {
  await withAgyEnvironment(async ({ cliRoot, legacyRoot }) => {
    t.mock.method(console, 'warn', () => {});
    fs.mkdirSync(cliRoot, { recursive: true });
    fs.writeFileSync(agySummariesDbPath(cliRoot), 'not a sqlite database, just text');
    buildAgySummariesDb(legacyRoot, [{ conversation_id: ID_A, title: 'Readable', last_modified_time: T1 }]);
    const clock = { now: T2_MS + 60_000 };
    const synchronizer = synchronizerAt(clock);

    assert.equal(await synchronizer.synchronize(), 1);
    // Only the root that was read gets a watermark.
    assert.deepEqual(readWatermarks(), { [legacyRoot]: clock.now - WATERMARK_SAFETY_MARGIN_MS });

    fs.rmSync(agySummariesDbPath(cliRoot));
    buildAgySummariesDb(cliRoot, [{ conversation_id: ID_B, title: 'Written while unreadable', last_modified_time: T0 }]);
    clock.now += 60_000;

    // T0 is long before the legacy root's watermark, but the cli root was never read.
    assert.equal(await synchronizer.synchronize(), 1);
    assert.equal(sessionsDb.getSessionById(ID_B)?.custom_name, 'Written while unreadable');
    const watermark = clock.now - WATERMARK_SAFETY_MARGIN_MS;
    assert.deepEqual(readWatermarks(), { [cliRoot]: watermark, [legacyRoot]: watermark });
  });
});

test('a root that fails to read keeps its watermark, so sessions the user deleted do not come back', { concurrency: false }, async (t) => {
  await withAgyEnvironment(async ({ home, legacyRoot }) => {
    t.mock.method(console, 'warn', () => {});
    buildAgySummariesDb(legacyRoot, [
      { conversation_id: ID_A, title: 'Deleted by the user', last_modified_time: T0 },
      { conversation_id: ID_B, title: 'Kept', last_modified_time: T1 },
    ]);
    const clock = { now: T2_MS + 60_000 };
    const synchronizer = synchronizerAt(clock);
    assert.equal(await synchronizer.synchronize(), 2);
    const watermark = readWatermarks()[legacyRoot];
    await forceDeleteSession(ID_A);

    // The index turns unreadable for a while (corrupt, unreadable, torn every time).
    const databasePath = agySummariesDbPath(legacyRoot);
    const savedIndexPath = path.join(home, 'saved-index.db');
    fs.renameSync(databasePath, savedIndexPath);
    fs.writeFileSync(databasePath, 'not a sqlite database, just text');
    clock.now += 60_000;
    assert.equal(await synchronizer.synchronize(), 0);
    assert.deepEqual(readWatermarks(), { [legacyRoot]: watermark });

    // Readable again, with a conversation agy wrote meanwhile.
    fs.rmSync(databasePath);
    fs.renameSync(savedIndexPath, databasePath);
    writeAgySummaryRows(legacyRoot, [
      { conversation_id: ID_C, title: 'Written while unreadable', last_modified_time: agyTime(clock.now - 30_000) },
    ]);
    clock.now += 60_000;

    // Even a fresh process (no memory of what it indexed) picks up only the new one.
    assert.equal(await synchronizerAt(clock).synchronize(), 1);
    assert.equal(sessionsDb.getSessionById(ID_A), null);
    assert.equal(sessionsDb.getSessionById(ID_C)?.custom_name, 'Written while unreadable');
  });
});

test('after a rollback and re-deploy, what agy wrote meanwhile is indexed though the shared cursor moved past it', { concurrency: false }, async () => {
  await withAgyEnvironment(async ({ legacyRoot }) => {
    const deployedAt = Date.UTC(2026, 9, 25, 10, 0, 0, 0);
    buildAgySummariesDb(legacyRoot, [{ conversation_id: ID_A, title: 'Before the deploy', last_modified_time: T0 }]);
    scanStateDb.updateLastScannedAt(new Date(deployedAt - 3_600_000));

    // The agy build's first scan indexes the root.
    const deployed = synchronizerAt({ now: deployedAt });
    assert.equal(await deployed.synchronize(scanStateDb.getLastScannedAt() ?? undefined), 1);

    // Rolled back: agy keeps writing while a build without agy advances the
    // shared cursor on every sync without ever indexing agy.
    writeAgySummaryRows(legacyRoot, [
      { conversation_id: ID_B, title: 'Written during the rollback', last_modified_time: agyTime(deployedAt + 90 * 60_000) },
    ]);
    scanStateDb.updateLastScannedAt(new Date(deployedAt + 2 * 3_600_000));

    // Re-deployed: a fresh process syncs from the shared cursor.
    const redeployed = synchronizerAt({ now: deployedAt + 2 * 3_600_000 + 60_000 });
    assert.equal(await redeployed.synchronize(scanStateDb.getLastScannedAt() ?? undefined), 1);
    assert.equal(sessionsDb.getSessionById(ID_B)?.custom_name, 'Written during the rollback');
    assert.notEqual(sessionsDb.getSessionById(ID_A), null);
  });
});

test('synchronizeFile re-indexes what moved when the index or its WAL changes', { concurrency: false }, async () => {
  await withAgyEnvironment(async ({ legacyRoot }) => {
    buildAgySummariesDb(legacyRoot, [{ conversation_id: ID_A, title: 'A', last_modified_time: T1 }]);
    const synchronizer = synchronizerAt({ now: T1_MS + 60_000 });
    await synchronizer.synchronize();
    const databasePath = agySummariesDbPath(legacyRoot);

    assert.equal(await synchronizer.synchronizeFile(databasePath), null);

    const writer = openAgySummariesWriter(legacyRoot);
    try {
      insertAgySummaryRows(writer, [{ conversation_id: ID_B, title: 'B, still in the WAL', last_modified_time: T2 }]);
      assert.equal(await synchronizer.synchronizeFile(`${databasePath}-wal`), ID_B);
      assert.equal(sessionsDb.getSessionById(ID_B)?.custom_name, 'B, still in the WAL');
      assert.equal(await synchronizer.synchronizeFile(`${databasePath}-wal`), null);

      insertAgySummaryRows(writer, [{ conversation_id: ID_A, title: 'A', last_modified_time: T3 }]);
      assert.equal(await synchronizer.synchronizeFile(databasePath), ID_A);
      assert.equal(sessionsDb.getSessionById(ID_A)?.updated_at, '2026-10-25T14:00:00.000Z');

      // Never the -shm: agy's connections touch it on every access.
      assert.equal(await synchronizer.synchronizeFile(`${databasePath}-shm`), null);
    } finally {
      writer.close();
    }
  });
});

test('one index event indexes every conversation that moved and reports the newest', { concurrency: false }, async () => {
  await withAgyEnvironment(async ({ legacyRoot }) => {
    buildAgySummariesDb(legacyRoot, [{ conversation_id: ID_A, title: 'A', last_modified_time: T0 }]);
    const synchronizer = synchronizerAt({ now: T0_MS + 60_000 });
    await synchronizer.synchronize();

    const writer = openAgySummariesWriter(legacyRoot);
    try {
      insertAgySummaryRows(writer, [
        { conversation_id: ID_B, title: 'B', last_modified_time: T1 },
        { conversation_id: ID_C, title: 'C', last_modified_time: T3 },
        { conversation_id: ID_A, title: 'A', last_modified_time: T2 },
      ]);

      assert.equal(await synchronizer.synchronizeFile(agySummariesDbPath(legacyRoot)), ID_C);
    } finally {
      writer.close();
    }

    assert.equal(sessionsDb.getSessionById(ID_A)?.updated_at, new Date(T2_MS).toISOString());
    assert.equal(sessionsDb.getSessionById(ID_B)?.updated_at, new Date(T1_MS).toISOString());
    assert.equal(sessionsDb.getSessionById(ID_C)?.custom_name, 'C');
  });
});

test('a change a full sync indexed first is still reported by the next index event', { concurrency: false }, async () => {
  await withAgyEnvironment(async ({ legacyRoot }) => {
    buildAgySummariesDb(legacyRoot, [{ conversation_id: ID_A, title: 'A', last_modified_time: T1 }]);
    const synchronizer = synchronizerAt({ now: T1_MS + 60_000 });
    await synchronizer.synchronize();
    const walPath = `${agySummariesDbPath(legacyRoot)}-wal`;

    const writer = openAgySummariesWriter(legacyRoot);
    try {
      insertAgySummaryRows(writer, [
        { conversation_id: ID_B, title: 'B', last_modified_time: T2 },
        { conversation_id: ID_A, title: 'A', last_modified_time: T3 },
      ]);
      // A sidebar load syncs first...
      assert.equal(await synchronizer.synchronize(new Date(T1_MS + 1)), 2);
      // ...and the watcher still reports the newest change to every client.
      assert.equal(await synchronizer.synchronizeFile(walPath), ID_A);
      assert.equal(await synchronizer.synchronizeFile(walPath), null);
    } finally {
      writer.close();
    }
  });
});

test('a session deleted after a sidebar sync indexed it is not brought back by the watcher or the next sync', { concurrency: false }, async () => {
  await withAgyEnvironment(async ({ legacyRoot }) => {
    buildAgySummariesDb(legacyRoot, [{ conversation_id: ID_A, title: 'A', last_modified_time: T0 }]);
    const clock = { now: T1_MS };
    const synchronizer = synchronizerAt(clock);
    // The startup sync.
    await synchronizer.synchronize();
    const databasePath = agySummariesDbPath(legacyRoot);
    const writer = openAgySummariesWriter(legacyRoot);
    try {
      // agy writes X, and a sidebar load indexes it before the watcher's event runs.
      clock.now += 60_000;
      const writtenAt = clock.now - 2_000;
      insertAgySummaryRows(writer, [{ conversation_id: ID_B, title: 'X', last_modified_time: agyTime(writtenAt) }]);
      assert.equal(await synchronizer.synchronize(new Date(T1_MS)), 1);
      // X is inside the safety margin: newer than the watermark that sync recorded.
      assert.ok(writtenAt > readWatermarks()[legacyRoot]);

      await forceDeleteSession(ID_B);

      // The watcher's pending event, a later one, and the next sidebar load leave it deleted.
      assert.equal(await synchronizer.synchronizeFile(`${databasePath}-wal`), null);
      assert.equal(await synchronizer.synchronizeFile(databasePath), null);
      assert.equal(await synchronizer.synchronize(new Date(T1_MS + 60_000)), 0);
      assert.equal(sessionsDb.getSessionById(ID_B), null);

      // Once agy changes X again, it is back and reported.
      clock.now += 60_000;
      insertAgySummaryRows(writer, [{ conversation_id: ID_B, title: 'X changed by agy', last_modified_time: agyTime(clock.now - 1_000) }]);
      assert.equal(await synchronizer.synchronizeFile(`${databasePath}-wal`), ID_B);
      assert.equal(sessionsDb.getSessionById(ID_B)?.custom_name, 'X changed by agy');
    } finally {
      writer.close();
    }
  });
});

test('the watcher only creates rows for conversations modified after their root\'s watermark', { concurrency: false }, async () => {
  await withAgyEnvironment(async ({ legacyRoot }) => {
    buildAgySummariesDb(legacyRoot, [
      { conversation_id: ID_A, title: 'A', last_modified_time: T1 },
      { conversation_id: ID_B, title: 'Deleted in a previous run', last_modified_time: T1 },
    ]);
    const clock = { now: T2_MS };
    await synchronizerAt(clock).synchronize();
    await forceDeleteSession(ID_B);

    // A restarted process whose watcher fires before it has read the root
    // (its startup sync failed, say) has no baseline: every conversation
    // looks moved.
    const restarted = synchronizerAt(clock);
    const walPath = `${agySummariesDbPath(legacyRoot)}-wal`;
    const writer = openAgySummariesWriter(legacyRoot);
    try {
      insertAgySummaryRows(writer, [{ conversation_id: ID_C, title: 'New', last_modified_time: agyTime(clock.now + 1_000) }]);

      assert.equal(await restarted.synchronizeFile(walPath), ID_C);
      assert.equal(sessionsDb.getSessionById(ID_B), null);
      assert.notEqual(sessionsDb.getSessionById(ID_A), null);
    } finally {
      writer.close();
    }
  });
});

test('synchronizeFile re-indexes a conversation when its transcript changes', { concurrency: false }, async () => {
  await withAgyEnvironment(async ({ cliRoot, legacyRoot }) => {
    buildAgySummariesDb(legacyRoot, [{ conversation_id: ID_A, title: 'A', last_modified_time: T1 }]);
    const synchronizer = new AgySessionSynchronizer();
    const fullTranscript = placeAgyTranscript(legacyRoot, ID_A);
    const shortTranscript = placeAgyTranscript(legacyRoot, ID_A, 'transcript.jsonl');

    assert.equal(await synchronizer.synchronizeFile(fullTranscript), ID_A);
    assert.equal(sessionsDb.getSessionById(ID_A)?.jsonl_path, null);
    assert.equal(await synchronizer.synchronizeFile(shortTranscript), ID_A);

    // Not in agy's index yet: its index change will bring it in.
    assert.equal(await synchronizer.synchronizeFile(placeAgyTranscript(legacyRoot, ID_B)), null);

    const ignoredPaths = [
      path.join(legacyRoot, 'conversations', `${ID_A}.db`),
      path.join(legacyRoot, 'brain', ID_A, 'scratch', 'notes.md'),
      path.join(legacyRoot, 'brain', 'not-a-uuid', '.system_generated', 'logs', 'transcript_full.jsonl'),
      path.join(os.tmpdir(), 'elsewhere', 'conversation_summaries.db'),
      path.join(cliRoot, '..', 'conversation_summaries.db'),
    ];
    for (const ignoredPath of ignoredPaths) {
      assert.equal(await synchronizer.synchronizeFile(ignoredPath), null, ignoredPath);
    }
  });
});

test('synchronizing never modifies the data roots', { concurrency: false }, async () => {
  await withAgyEnvironment(async ({ cliRoot, legacyRoot }) => {
    buildAgySummariesDb(legacyRoot, [
      { conversation_id: ID_A, last_modified_time: AGY_ZERO_TIME },
      { conversation_id: ID_B, title: 'B', last_modified_time: T1 },
    ]);
    placeAgyTranscript(legacyRoot, ID_A);
    placeAgyTranscript(legacyRoot, ID_B, 'transcript.jsonl');
    buildAgySummariesDb(cliRoot, [{ conversation_id: ID_C, title: 'C', last_modified_time: T1 }]);
    const writer = openAgySummariesWriter(cliRoot);
    try {
      insertAgySummaryRows(writer, [{ conversation_id: ID_D, title: 'D', last_modified_time: T2 }]);
      const legacyBefore = snapshotTree(legacyRoot);
      const cliBefore = snapshotTree(cliRoot);
      const synchronizer = new AgySessionSynchronizer();

      assert.equal(await synchronizer.synchronize(), 4);
      await synchronizer.synchronizeFile(agySummariesDbPath(legacyRoot));
      await synchronizer.synchronizeFile(`${agySummariesDbPath(cliRoot)}-wal`);
      await synchronizer.synchronizeFile(path.join(agyTranscriptDirectory(legacyRoot, ID_A), 'transcript_full.jsonl'));

      assert.deepEqual(snapshotTree(legacyRoot), legacyBefore);
      assert.deepEqual(snapshotTree(cliRoot), cliBefore);
    } finally {
      writer.close();
    }
  });
});

test('deleting an agy session removes only CloudCLI\'s row, never agy\'s files', { concurrency: false }, async () => {
  await withAgyEnvironment(async ({ legacyRoot }) => {
    buildAgySummariesDb(legacyRoot, [{ conversation_id: ID_A, title: 'A', last_modified_time: T1 }]);
    placeAgyTranscript(legacyRoot, ID_A);
    await new AgySessionSynchronizer().synchronize();
    const before = snapshotTree(legacyRoot);

    const result = await sessionsService.deleteOrArchiveSessionById(ID_A, { force: true, deletedFromDisk: true });

    assert.deepEqual(result, { sessionId: ID_A, action: 'deleted', deletedFromDisk: false });
    assert.equal(sessionsDb.getSessionById(ID_A), null);
    assert.deepEqual(snapshotTree(legacyRoot), before);
  });
});
