import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp, { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import Database from 'better-sqlite3';

import {
  classifyAgyDataPath,
  findAgyConversationRoot,
  isLegacyAgyRoot,
  readAgyConversationSummaries,
  readAgyTranscript,
  summarizeAgyTranscriptTokenUsage,
} from '@/modules/providers/list/agy/agy-store.js';
import {
  AGY_ZERO_TIME,
  agySummariesDbPath,
  buildAgySummariesDb,
  insertAgySummaryRows,
  openAgySummariesWriter,
} from '@/modules/providers/tests/fixtures/agy/build-summaries-db.js';
import {
  type AgyTestRoots,
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

const T1 = '2026-10-25 12:56:42.887272639+00:00';
const T1_MS = Date.UTC(2026, 9, 25, 12, 56, 42, 887);
const T2 = '2026-10-25 13:30:00.000000001+00:00';

async function withAgyRoots(run: (roots: AgyTestRoots) => Promise<void>): Promise<void> {
  const roots = await createAgyTestRoots();
  try {
    await run(roots);
  } finally {
    await roots.restore();
  }
}

test('lists top-level conversations and skips subagents, killed rows and malformed ids', async () => {
  await withAgyRoots(async ({ cliRoot, legacyRoot }) => {
    buildAgySummariesDb(legacyRoot, [
      { conversation_id: ID_A, title: 'Top level', last_modified_time: T1, workspace_uris: '["file:///srv/app"]' },
      { conversation_id: ID_B, title: 'Subagent', last_modified_time: T1, nesting_depth: 1 },
      { conversation_id: ID_C, title: 'Child', last_modified_time: T1, parent_conversation_id: ID_A },
      { conversation_id: ID_D, title: 'Killed', last_modified_time: T1, killed: 1 },
      { conversation_id: 'not-a-uuid', title: 'Malformed', last_modified_time: T1 },
      { conversation_id: ID_F, preview: 'Only a preview', last_modified_time: T2 },
    ]);

    const scan = await readAgyConversationSummaries([cliRoot, legacyRoot]);

    // The missing cli root is neither read nor unreadable.
    assert.deepEqual(scan.readRoots, [legacyRoot]);
    assert.deepEqual(scan.unreadableRoots, []);
    assert.deepEqual(scan.summaries.map((summary) => summary.conversationId), [ID_F, ID_A]);
    assert.deepEqual(scan.summaries[1], {
      conversationId: ID_A,
      root: legacyRoot,
      title: 'Top level',
      preview: null,
      projectPath: '/srv/app',
      lastModifiedMs: T1_MS,
    });
    assert.equal(scan.summaries[0].title, 'Only a preview');
    assert.equal(scan.summaries[0].preview, 'Only a preview');
  });
});

test('maps the first workspace URI to a decoded path and falls back to the home directory', async () => {
  await withAgyRoots(async ({ home, legacyRoot }) => {
    buildAgySummariesDb(legacyRoot, [
      {
        conversation_id: ID_A,
        last_modified_time: T1,
        workspace_uris: '["file:///home/me/my%20project%20%E4%B8%AD","file:///home/me/other"]',
      },
      { conversation_id: ID_B, last_modified_time: T1, workspace_uris: '[]' },
      { conversation_id: ID_C, last_modified_time: T1, workspace_uris: '["relative/path"]' },
      { conversation_id: ID_D, last_modified_time: T1, workspace_uris: '["file://remote-host/share"]' },
      { conversation_id: ID_E, last_modified_time: T1, workspace_uris: 'file:///srv/bare-uri' },
    ]);

    const { summaries } = await readAgyConversationSummaries([legacyRoot]);
    const projectPathById = new Map(summaries.map((summary) => [summary.conversationId, summary.projectPath]));

    assert.equal(projectPathById.get(ID_A), '/home/me/my project 中');
    assert.equal(projectPathById.get(ID_B), home);
    assert.equal(projectPathById.get(ID_C), home);
    assert.equal(projectPathById.get(ID_D), home);
    assert.equal(projectPathById.get(ID_E), '/srv/bare-uri');
  });
});

test('keeps the newest copy of a conversation found in several roots', async () => {
  await withAgyRoots(async ({ cliRoot, legacyRoot }) => {
    buildAgySummariesDb(cliRoot, [
      { conversation_id: ID_A, title: 'A in cli (older)', last_modified_time: T1 },
      { conversation_id: ID_B, title: 'B in cli (newer)', last_modified_time: T2 },
    ]);
    buildAgySummariesDb(legacyRoot, [
      { conversation_id: ID_A, title: 'A in legacy (newer)', last_modified_time: T2 },
      { conversation_id: ID_B, title: 'B in legacy (older)', last_modified_time: T1 },
      { conversation_id: ID_C, title: 'C only in legacy', last_modified_time: T1 },
    ]);

    const { summaries } = await readAgyConversationSummaries([cliRoot, legacyRoot]);
    const byId = new Map(summaries.map((summary) => [summary.conversationId, summary]));

    assert.equal(summaries.length, 3);
    assert.equal(byId.get(ID_A)?.root, legacyRoot);
    assert.equal(byId.get(ID_A)?.title, 'A in legacy (newer)');
    assert.equal(byId.get(ID_B)?.root, cliRoot);
    assert.equal(byId.get(ID_B)?.title, 'B in cli (newer)');
    assert.equal(byId.get(ID_C)?.root, legacyRoot);
  });
});

test('parses nanosecond times and dates zero-time rows from the transcript, then the conversation database', async () => {
  await withAgyRoots(async ({ legacyRoot }) => {
    buildAgySummariesDb(legacyRoot, [
      { conversation_id: ID_A, title: 'Nanoseconds', last_modified_time: T1 },
      { conversation_id: ID_B, title: 'Offset', last_modified_time: '2026-10-25 20:56:42.5+08:00' },
      { conversation_id: ID_C, title: 'Zero time, transcript', last_modified_time: AGY_ZERO_TIME },
      { conversation_id: ID_D, title: 'Zero time, conversation db', last_modified_time: AGY_ZERO_TIME },
      { conversation_id: ID_E, title: 'Zero time, nothing on disk', last_modified_time: AGY_ZERO_TIME, step_count: 0 },
    ]);
    const transcriptPath = placeAgyTranscript(legacyRoot, ID_C, 'transcript.jsonl');
    setFileTime(transcriptPath, Date.UTC(2026, 9, 20, 10, 0, 0, 0));
    const conversationsDirectory = path.join(legacyRoot, 'conversations');
    fs.mkdirSync(conversationsDirectory, { recursive: true });
    const conversationDatabase = path.join(conversationsDirectory, `${ID_D}.db`);
    fs.writeFileSync(conversationDatabase, 'not parsed, only stat()ed');
    setFileTime(conversationDatabase, Date.UTC(2026, 9, 21, 10, 0, 0, 0));

    const { summaries } = await readAgyConversationSummaries([legacyRoot]);
    const modifiedById = new Map(summaries.map((summary) => [summary.conversationId, summary.lastModifiedMs]));

    assert.equal(modifiedById.get(ID_A), T1_MS);
    assert.equal(modifiedById.get(ID_B), Date.UTC(2026, 9, 25, 12, 56, 42, 500));
    assert.equal(modifiedById.get(ID_C), Date.UTC(2026, 9, 20, 10, 0, 0, 0));
    assert.equal(modifiedById.get(ID_D), Date.UTC(2026, 9, 21, 10, 0, 0, 0));
    // Still listed (it can be resumed), just undated; never "now".
    assert.ok(modifiedById.has(ID_E));
    assert.equal(modifiedById.get(ID_E), null);
  });
});

test('titles conversations from the title, the preview, the first prompt, then history.jsonl', async () => {
  await withAgyRoots(async ({ legacyRoot }) => {
    buildAgySummariesDb(legacyRoot, [
      { conversation_id: ID_A, title: 'Agy title', preview: 'Agy preview', last_modified_time: T1 },
      { conversation_id: ID_B, preview: 'Agy preview', last_modified_time: T1 },
      { conversation_id: ID_C, last_modified_time: T1 },
      { conversation_id: ID_D, last_modified_time: T1 },
      { conversation_id: ID_E, last_modified_time: T1 },
    ]);
    placeAgyTranscript(legacyRoot, ID_C);
    fs.writeFileSync(path.join(legacyRoot, 'history.jsonl'), [
      JSON.stringify({ display: 'Earlier prompt from history', conversation_id: ID_D }),
      JSON.stringify({ display: 'Later prompt from history', conversation_id: ID_D }),
      '{not json',
    ].join('\n'));

    const { summaries } = await readAgyConversationSummaries([legacyRoot]);
    const titleById = new Map(summaries.map((summary) => [summary.conversationId, summary.title]));

    assert.equal(titleById.get(ID_A), 'Agy title');
    assert.equal(titleById.get(ID_B), 'Agy preview');
    // The transcript's first USER_INPUT, without agy's wrapper and metadata.
    assert.equal(titleById.get(ID_C), 'Read /tmp/agy-probe/hello.txt and list the folder');
    assert.equal(titleById.get(ID_D), 'Earlier prompt from history');
    assert.equal(titleById.get(ID_E), null);
  });
});

test('missing roots and indexes yield no conversations, no errors and no new directories', async () => {
  await withAgyRoots(async ({ home, cliRoot, legacyRoot }) => {
    const nothing = { summaries: [], readRoots: [], unreadableRoots: [] };
    assert.deepEqual(await readAgyConversationSummaries([cliRoot, legacyRoot]), nothing);
    assert.equal(fs.existsSync(path.join(home, '.gemini')), false);

    // The default roots come from HOME when AGY_DATA_DIRS is unset.
    delete process.env.AGY_DATA_DIRS;
    assert.deepEqual(await readAgyConversationSummaries(), nothing);
    assert.equal(fs.existsSync(path.join(home, '.gemini')), false);

    fs.mkdirSync(legacyRoot, { recursive: true });
    assert.deepEqual(await readAgyConversationSummaries([legacyRoot]), nothing);
    assert.deepEqual(fs.readdirSync(legacyRoot), []);
  });
});

test('reads the default roots under HOME when AGY_DATA_DIRS is unset', async () => {
  const roots = await createAgyTestRoots({ useDataDirsOverride: false });
  try {
    buildAgySummariesDb(roots.legacyRoot, [{ conversation_id: ID_A, title: 'Legacy', last_modified_time: T1 }]);

    const { summaries } = await readAgyConversationSummaries();

    assert.deepEqual(summaries.map((summary) => [summary.conversationId, summary.root]), [[ID_A, roots.legacyRoot]]);
  } finally {
    await roots.restore();
  }
});

test('an index that cannot be read is reported, while other roots still list', async () => {
  await withAgyRoots(async ({ cliRoot, legacyRoot }) => {
    fs.mkdirSync(cliRoot, { recursive: true });
    fs.writeFileSync(agySummariesDbPath(cliRoot), 'this is not a sqlite database at all, just text');
    buildAgySummariesDb(legacyRoot, [{ conversation_id: ID_A, title: 'Readable', last_modified_time: T1 }]);

    const scan = await readAgyConversationSummaries([cliRoot, legacyRoot]);

    assert.deepEqual(scan.unreadableRoots, [cliRoot]);
    assert.deepEqual(scan.readRoots, [legacyRoot]);
    assert.deepEqual(scan.summaries.map((summary) => summary.conversationId), [ID_A]);
  });
});

test('an older index without some columns still lists its conversations', async () => {
  await withAgyRoots(async ({ legacyRoot }) => {
    fs.mkdirSync(legacyRoot, { recursive: true });
    const database = new Database(agySummariesDbPath(legacyRoot));
    try {
      database.exec(`
        CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text, last_modified_time datetime);
        INSERT INTO conversation_summaries VALUES ('${ID_A}', 'Old layout', '${T1}');
      `);
    } finally {
      database.close();
    }

    const { summaries, unreadableRoots } = await readAgyConversationSummaries([legacyRoot]);

    assert.deepEqual(unreadableRoots, []);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].title, 'Old layout');
    assert.equal(summaries[0].lastModifiedMs, T1_MS);
  });
});

type ReadFile = typeof fsp.readFile;
type WriteFile = typeof fsp.writeFile;

/**
 * Wraps fsp.readFile so the Buffer read from an agy file can be traced back to
 * its source when the store writes it into a private snapshot (the store copies
 * by reading agy's file and writing the bytes out).
 */
function traceReads(t: TestContext, onRead?: (source: string) => void): WeakMap<object, string> {
  const realReadFile = fsp.readFile;
  const sourcesByContents = new WeakMap<object, string>();
  t.mock.method(fsp, 'readFile', (async (source: Parameters<ReadFile>[0], ...rest: unknown[]) => {
    onRead?.(String(source));
    const contents = await (realReadFile as (...args: unknown[]) => Promise<unknown>)(source, ...rest);
    if (contents && typeof contents === 'object') {
      sourcesByContents.set(contents, String(source));
    }
    return contents;
  }) as ReadFile);
  return sourcesByContents;
}

/** Records how the store copies agy's index (sources, private directories) without changing what it does. */
function spyOnIndexCopies(t: TestContext): { sources: string[]; directories: string[]; directoryModes: number[] } {
  const realMkdtemp = fsp.mkdtemp;
  const realWriteFile = fsp.writeFile;
  const spy = { sources: [] as string[], directories: [] as string[], directoryModes: [] as number[] };
  t.mock.method(fsp, 'mkdtemp', async (prefix: string) => {
    const directory = await realMkdtemp(prefix);
    spy.directories.push(directory);
    return directory;
  });
  const sourcesByContents = traceReads(t);
  t.mock.method(fsp, 'writeFile', (async (destination: Parameters<WriteFile>[0], data: unknown, ...rest: unknown[]) => {
    const directory = path.dirname(String(destination));
    if (spy.directories.includes(directory)) {
      const source = data !== null && typeof data === 'object' ? sourcesByContents.get(data) : undefined;
      spy.sources.push(source ?? '<unknown>');
      spy.directoryModes.push(fs.statSync(directory).mode & 0o777);
    }
    return (realWriteFile as (...args: unknown[]) => Promise<void>)(destination, data, ...rest);
  }) as WriteFile);
  return spy;
}

test('reading an idle index (no -wal) changes nothing in the data root and reads a private copy', async (t) => {
  await withAgyRoots(async ({ cliRoot, legacyRoot }) => {
    buildAgySummariesDb(legacyRoot, [
      { conversation_id: ID_A, last_modified_time: AGY_ZERO_TIME },
      { conversation_id: ID_B, title: 'Indexed', last_modified_time: T1 },
    ]);
    placeAgyTranscript(legacyRoot, ID_A);
    placeAgyTranscript(legacyRoot, ID_B, 'transcript.jsonl');
    fs.writeFileSync(path.join(legacyRoot, 'history.jsonl'), `${JSON.stringify({ display: 'x', conversation_id: ID_B })}\n`);
    const before = snapshotTree(legacyRoot);
    assert.ok(!before.has('conversation_summaries.db-wal'));
    assert.ok(!before.has('conversation_summaries.db-shm'));
    const copies = spyOnIndexCopies(t);

    const { summaries } = await readAgyConversationSummaries([cliRoot, legacyRoot]);
    await readAgyTranscript(ID_A, [cliRoot, legacyRoot]);
    await readAgyTranscript(ID_B, [cliRoot, legacyRoot]);
    await findAgyConversationRoot(ID_C, [cliRoot, legacyRoot]);

    assert.equal(summaries.length, 2);
    assert.deepEqual(snapshotTree(legacyRoot), before);
    assert.equal(fs.existsSync(cliRoot), false);
    // Only the index (and its WAL, had there been one) is copied, into
    // private 0700 directories under the temp dir that are gone afterwards.
    const databasePath = agySummariesDbPath(legacyRoot);
    assert.ok(copies.sources.includes(databasePath));
    assert.ok(copies.sources.every((source) => source === databasePath || source === `${databasePath}-wal`));
    assert.ok(copies.directories.length >= 2);
    assert.ok(copies.directories.every((directory) => directory.startsWith(os.tmpdir()) && !fs.existsSync(directory)));
    assert.ok(copies.directoryModes.every((mode) => mode === 0o700));
  });
});

test('reading a live index (agy running) sees its WAL commits through a copy and changes nothing, -shm included', async (t) => {
  await withAgyRoots(async ({ legacyRoot }) => {
    buildAgySummariesDb(legacyRoot, [{ conversation_id: ID_A, title: 'Checkpointed', last_modified_time: T1 }]);
    const writer = openAgySummariesWriter(legacyRoot);
    try {
      insertAgySummaryRows(writer, [{ conversation_id: ID_B, title: 'Only in the WAL', last_modified_time: T2 }]);
      const databasePath = agySummariesDbPath(legacyRoot);
      assert.ok(fs.existsSync(`${databasePath}-wal`));
      assert.ok(fs.existsSync(`${databasePath}-shm`));
      const before = snapshotTree(legacyRoot);
      const copies = spyOnIndexCopies(t);

      const { summaries } = await readAgyConversationSummaries([legacyRoot]);
      assert.equal(await findAgyConversationRoot(ID_B, [legacyRoot]), legacyRoot);

      assert.deepEqual(summaries.map((summary) => summary.title), ['Only in the WAL', 'Checkpointed']);
      // No read marks in agy's -shm, no new files, no changed mtimes.
      assert.deepEqual(snapshotTree(legacyRoot), before);
      // The index and its WAL are copied, never agy's -shm.
      assert.deepEqual([...new Set(copies.sources)].sort(), [databasePath, `${databasePath}-wal`]);
      assert.ok(copies.directories.every((directory) => !fs.existsSync(directory)));
    } finally {
      writer.close();
    }
  });
});

test('agy closing its last connection during a read leaves no -wal/-shm behind', async (t) => {
  await withAgyRoots(async ({ legacyRoot }) => {
    buildAgySummariesDb(legacyRoot, [{ conversation_id: ID_A, title: 'Checkpointed', last_modified_time: T1 }]);
    const databasePath = agySummariesDbPath(legacyRoot);
    // An old mtime, so the checkpoint agy runs as it closes surely changes it.
    setFileTime(databasePath, Date.UTC(2026, 9, 20, 10, 0, 0, 0));
    const writer = openAgySummariesWriter(legacyRoot);
    insertAgySummaryRows(writer, [{ conversation_id: ID_B, title: 'Only in the WAL', last_modified_time: T2 }]);
    // agy's last close checkpoints the WAL into the index and removes -wal/-shm.
    const closeAgy = () => {
      if (writer.open) {
        writer.close();
      }
    };
    const realStat = fsp.stat;
    let indexCopies = 0;
    // agy closes right after a reader saw its side files...
    t.mock.method(fsp, 'stat', async (filePath: string) => {
      const stats = await realStat(filePath);
      if (filePath.endsWith('-shm')) {
        closeAgy();
      }
      return stats;
    });
    // ...or just as the index is being copied.
    traceReads(t, (source) => {
      if (source === databasePath) {
        indexCopies += 1;
        closeAgy();
      }
    });

    try {
      const { summaries, unreadableRoots } = await readAgyConversationSummaries([legacyRoot]);

      assert.deepEqual(unreadableRoots, []);
      assert.deepEqual(summaries.map((summary) => summary.title), ['Only in the WAL', 'Checkpointed']);
      assert.deepEqual(fs.readdirSync(legacyRoot), ['conversation_summaries.db']);
      // The first copy was taken while agy checkpointed, so it was taken again.
      assert.equal(indexCopies, 2);
    } finally {
      closeAgy();
    }
  });
});

test('an index agy holds exclusively is still read, through the copy', async () => {
  await withAgyRoots(async ({ legacyRoot }) => {
    buildAgySummariesDb(legacyRoot, [{ conversation_id: ID_A, title: 'Checkpointed', last_modified_time: T1 }]);
    const writer = openAgySummariesWriter(legacyRoot);
    try {
      writer.pragma('locking_mode = EXCLUSIVE');
      insertAgySummaryRows(writer, [{ conversation_id: ID_B, title: 'Written under the lock', last_modified_time: T2 }]);
      const before = snapshotTree(legacyRoot);

      const { summaries, unreadableRoots } = await readAgyConversationSummaries([legacyRoot]);

      assert.deepEqual(unreadableRoots, []);
      assert.deepEqual(summaries.map((summary) => summary.title), ['Written under the lock', 'Checkpointed']);
      assert.deepEqual(snapshotTree(legacyRoot), before);
    } finally {
      writer.close();
    }
  });
});

/** Copies of the index cut short, as a copy taken while agy's checkpoint grows the file can be. */
const truncateCopy = (copyPath: string) => fs.truncateSync(copyPath, 4096);
/** Copies of the index whose header is gone. */
const overwriteCopyHeader = (copyPath: string) => {
  const descriptor = fs.openSync(copyPath, 'r+');
  try {
    fs.writeSync(descriptor, Buffer.alloc(16, 0x41), 0, 16, 0);
  } finally {
    fs.closeSync(descriptor);
  }
};

/** Makes the first `tornCopies` copies of `databasePath` come out torn; returns how many copies were taken. */
function tearIndexCopies(t: TestContext, databasePath: string, tornCopies: number, tear: (copyPath: string) => void) {
  const realWriteFile = fsp.writeFile;
  const counter = { indexCopies: 0 };
  const sourcesByContents = traceReads(t);
  t.mock.method(fsp, 'writeFile', (async (destination: Parameters<WriteFile>[0], data: unknown, ...rest: unknown[]) => {
    await (realWriteFile as (...args: unknown[]) => Promise<void>)(destination, data, ...rest);
    if (data && typeof data === 'object' && sourcesByContents.get(data) === databasePath) {
      counter.indexCopies += 1;
      if (counter.indexCopies <= tornCopies) {
        tear(String(destination));
      }
    }
  }) as WriteFile);
  return counter;
}

for (const [label, tear] of [['truncated (malformed)', truncateCopy], ['not a database', overwriteCopyHeader]] as const) {
  test(`a torn copy of the index is taken again: ${label}`, async (t) => {
    await withAgyRoots(async ({ legacyRoot }) => {
      buildAgySummariesDb(legacyRoot, [
        { conversation_id: ID_A, title: 'A', last_modified_time: T1 },
        { conversation_id: ID_B, title: 'B', last_modified_time: T2 },
      ]);
      const copies = tearIndexCopies(t, agySummariesDbPath(legacyRoot), 1, tear);

      const scan = await readAgyConversationSummaries([legacyRoot]);

      assert.deepEqual(scan.unreadableRoots, []);
      assert.deepEqual(scan.readRoots, [legacyRoot]);
      assert.deepEqual(scan.summaries.map((summary) => summary.title), ['B', 'A']);
      assert.equal(copies.indexCopies, 2);
    });
  });
}

test('an index whose every copy comes out torn is reported as unreadable after the retries', async (t) => {
  await withAgyRoots(async ({ legacyRoot }) => {
    buildAgySummariesDb(legacyRoot, [{ conversation_id: ID_A, title: 'A', last_modified_time: T1 }]);
    const copies = tearIndexCopies(t, agySummariesDbPath(legacyRoot), Number.POSITIVE_INFINITY, truncateCopy);
    t.mock.method(console, 'warn', () => {});

    const scan = await readAgyConversationSummaries([legacyRoot]);

    assert.deepEqual(scan, { summaries: [], readRoots: [], unreadableRoots: [legacyRoot] });
    // The first copy and one per retry.
    assert.equal(copies.indexCopies, 4);
  });
});

test('reads commits from a WAL left without its -shm through a private copy', async () => {
  await withAgyRoots(async ({ cliRoot, legacyRoot }) => {
    buildAgySummariesDb(cliRoot, [{ conversation_id: ID_A, title: 'Checkpointed', last_modified_time: T1 }]);
    const writer = openAgySummariesWriter(cliRoot);
    try {
      insertAgySummaryRows(writer, [{ conversation_id: ID_B, title: 'Only in the WAL', last_modified_time: T2 }]);
      // A crashed agy can leave the WAL behind without its -shm.
      fs.mkdirSync(legacyRoot, { recursive: true });
      fs.copyFileSync(agySummariesDbPath(cliRoot), agySummariesDbPath(legacyRoot));
      fs.copyFileSync(`${agySummariesDbPath(cliRoot)}-wal`, `${agySummariesDbPath(legacyRoot)}-wal`);
    } finally {
      writer.close();
    }
    const before = snapshotTree(legacyRoot);

    const { summaries } = await readAgyConversationSummaries([legacyRoot]);

    assert.deepEqual(summaries.map((summary) => summary.title), ['Only in the WAL', 'Checkpointed']);
    assert.deepEqual(snapshotTree(legacyRoot), before);
    assert.equal(fs.existsSync(`${agySummariesDbPath(legacyRoot)}-shm`), false);
  });
});

test('readAgyTranscript prefers the full transcript, falls back to the short one and validates ids', async () => {
  await withAgyRoots(async ({ cliRoot, legacyRoot }) => {
    placeAgyTranscript(cliRoot, ID_A);
    placeAgyTranscript(cliRoot, ID_A, 'transcript.jsonl');
    placeAgyTranscript(legacyRoot, ID_B, 'transcript.jsonl');
    const roots = [cliRoot, legacyRoot];

    const full = await readAgyTranscript(ID_A, roots);
    assert.equal(full?.isComplete, true);
    assert.equal(full?.root, cliRoot);
    assert.equal(full?.steps.length, 18);
    assert.equal(full?.filePath, path.join(cliRoot, 'brain', ID_A, '.system_generated', 'logs', 'transcript_full.jsonl'));

    const short = await readAgyTranscript(ID_B, roots);
    assert.equal(short?.isComplete, false);
    assert.equal(short?.root, legacyRoot);
    assert.equal(short?.steps.length, 4);
    assert.deepEqual(short?.steps[1].truncated_fields, ['thinking', 'content']);

    assert.equal(await readAgyTranscript(ID_C, roots), null);
    assert.equal(await readAgyTranscript('../../etc', roots), null);
    assert.equal(await readAgyTranscript(`${ID_A}/..`, roots), null);
  });
});

test('readAgyTranscript refuses a transcript that resolves outside its root', async () => {
  await withAgyRoots(async ({ home, legacyRoot }) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'agy-outside-'));
    try {
      placeAgyTranscript(outside, ID_A);
      fs.mkdirSync(path.join(legacyRoot, 'brain'), { recursive: true });
      fs.symlinkSync(path.join(outside, 'brain', ID_A), path.join(legacyRoot, 'brain', ID_A), 'dir');

      assert.equal(await readAgyTranscript(ID_A, [legacyRoot]), null);
      assert.ok(home);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test('skips malformed transcript lines', async () => {
  await withAgyRoots(async ({ legacyRoot }) => {
    const transcriptPath = placeAgyTranscript(legacyRoot, ID_A);
    fs.appendFileSync(transcriptPath, '{"step_index": 18, "type": "PLANNER_RESP');

    const transcript = await readAgyTranscript(ID_A, [legacyRoot]);

    assert.equal(transcript?.steps.length, 18);
  });
});

test('summarizeAgyTranscriptTokenUsage reads the latest planner step with token counts', async () => {
  await withAgyRoots(async ({ legacyRoot }) => {
    placeAgyTranscript(legacyRoot, ID_A);

    assert.deepEqual(summarizeAgyTranscriptTokenUsage(await readAgyTranscript(ID_A, [legacyRoot])), {
      used: 23_030,
      inputTokens: 23_000,
      outputTokens: 30,
      breakdown: { input: 23_000, output: 30 },
    });
    assert.equal(summarizeAgyTranscriptTokenUsage(null), undefined);
  });
});

test('findAgyConversationRoot finds the holding root, newest layout first, and isLegacyAgyRoot names the legacy one', async () => {
  await withAgyRoots(async ({ cliRoot, legacyRoot }) => {
    const roots = [cliRoot, legacyRoot];
    placeAgyTranscript(legacyRoot, ID_A);
    placeAgyTranscript(legacyRoot, ID_B);
    placeAgyTranscript(cliRoot, ID_B);
    fs.mkdirSync(path.join(cliRoot, 'conversations'), { recursive: true });
    fs.writeFileSync(path.join(cliRoot, 'conversations', `${ID_C}.db`), '');
    buildAgySummariesDb(legacyRoot, [{ conversation_id: ID_D, last_modified_time: AGY_ZERO_TIME }]);

    assert.equal(await findAgyConversationRoot(ID_A, roots), legacyRoot);
    assert.equal(await findAgyConversationRoot(ID_B, roots), cliRoot);
    assert.equal(await findAgyConversationRoot(ID_C, roots), cliRoot);
    // No steps yet: only its index row knows it.
    assert.equal(await findAgyConversationRoot(ID_D, roots), legacyRoot);
    assert.equal(await findAgyConversationRoot(ID_E, roots), null);
    assert.equal(await findAgyConversationRoot('not-a-uuid', roots), null);

    assert.equal(isLegacyAgyRoot(legacyRoot), true);
    assert.equal(isLegacyAgyRoot(`${legacyRoot}${path.sep}`), true);
    assert.equal(isLegacyAgyRoot(cliRoot), false);
  });
});

test('classifyAgyDataPath recognizes the index, its WAL, transcripts and the folders leading to them', () => {
  const root = path.join(os.tmpdir(), 'agy-root');
  const logs = path.join(root, 'brain', ID_A, '.system_generated', 'logs');

  assert.deepEqual(classifyAgyDataPath(root, root), { kind: 'directory' });
  assert.deepEqual(classifyAgyDataPath(root, path.join(root, 'conversation_summaries.db')), { kind: 'index' });
  assert.deepEqual(classifyAgyDataPath(root, path.join(root, 'conversation_summaries.db-wal')), { kind: 'index' });
  assert.deepEqual(classifyAgyDataPath(root, path.join(root, 'brain')), { kind: 'directory' });
  assert.deepEqual(classifyAgyDataPath(root, path.join(root, 'brain', ID_A)), { kind: 'directory' });
  assert.deepEqual(classifyAgyDataPath(root, logs), { kind: 'directory' });
  assert.deepEqual(classifyAgyDataPath(root, path.join(logs, 'transcript_full.jsonl')), { kind: 'transcript', conversationId: ID_A });
  assert.deepEqual(classifyAgyDataPath(root, path.join(logs, 'transcript.jsonl')), { kind: 'transcript', conversationId: ID_A });

  assert.equal(classifyAgyDataPath(root, path.join(root, 'conversation_summaries.db-shm')), null);
  assert.equal(classifyAgyDataPath(root, path.join(root, 'conversations', `${ID_A}.db`)), null);
  assert.equal(classifyAgyDataPath(root, path.join(root, 'brain', 'not-a-uuid')), null);
  assert.equal(classifyAgyDataPath(root, path.join(root, 'brain', ID_A, 'scratch', 'notes.md')), null);
  assert.equal(classifyAgyDataPath(root, path.join(root, 'brain', ID_A, '.system_generated', 'steps')), null);
  assert.equal(classifyAgyDataPath(root, path.join(logs, 'other.jsonl')), null);
  assert.equal(classifyAgyDataPath(root, path.join(root, '..', 'conversation_summaries.db')), null);
});
