import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  listBusyClaudeCliSessions,
  listLiveClaudeCliRuns,
} from '@/modules/providers/services/claude-cli-liveness.service.js';
import type { LiveClaudeRun } from '@/shared/types.js';

/**
 * A pid no process can hold, so signal 0 cannot find it: what a crash leaves
 * in a registry file. 2^31 - 1 is the largest pid `process.kill` accepts (a
 * signed 32-bit pid_t), and no kernel hands it out. Linux keeps every pid
 * below pid_max, which cannot exceed 2^22, macOS and the BSDs stay below
 * 100,000, and a Windows pid is a multiple of four. A pid just under Linux's
 * default pid_max, as this used to be, can belong to a live process on a host
 * whose pid counter has wrapped.
 */
const DEAD_PID = 2 ** 31 - 1;

/**
 * Runs `runTest` against a registry directory holding exactly `files` (file
 * name to record, or to raw text), so no test reads the real
 * `~/.claude/sessions`.
 *
 * Live records use `process.pid`, the one pid guaranteed to be alive, and
 * omit `procStart` unless a test is about it: the start-time cross-check is
 * Linux-only, so the fixtures stay portable.
 */
async function withRegistry(
  files: Record<string, Record<string, unknown> | string>,
  runTest: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-cli-liveness-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(
        path.join(directory, name),
        typeof contents === 'string' ? contents : JSON.stringify(contents),
        'utf8',
      );
    }
    await runTest(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** This process's kernel start time, the value the CLI records as `procStart`. */
async function readOwnProcStart(): Promise<string> {
  const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}

/** The runs the lookup lists, in a fixed order: the registry's file order is the filesystem's. */
const sortRuns = (runs: LiveClaudeRun[]) =>
  [...runs].sort((left, right) => left.startedAt - right.startedAt);

test('a live Claude CLI process that is not at rest is listed with its start and entrypoint', async () => {
  // A REPL mid-turn, or holding a workflow or a background agent it launched,
  // writes `busy`; one at a permission prompt writes `waiting`; an Agent SDK
  // print-mode process writes no status at all. Any of them may still report.
  await withRegistry(
    {
      '1001.json': { pid: process.pid, sessionId: 'busy-native', status: 'busy', entrypoint: 'cli', startedAt: 1_000 },
      '1002.json': { pid: process.pid, sessionId: 'waiting-native', status: 'waiting', entrypoint: 'cli', startedAt: 2_000 },
      '1003.json': { pid: process.pid, sessionId: 'sdk-native', entrypoint: 'sdk-ts', startedAt: 3_000 },
      // A record that does not name its entrypoint is still a live run.
      '1004.json': { pid: process.pid, sessionId: 'unnamed-native', status: 'busy', startedAt: 4_000 },
      '1005.json': { pid: process.pid, sessionId: 'blank-native', status: 'busy', entrypoint: '', startedAt: 5_000 },
    },
    async (directory) => {
      assert.deepEqual(await listLiveClaudeCliRuns('busy-native', directory), [{ startedAt: 1_000, entrypoint: 'cli' }]);
      assert.deepEqual(await listLiveClaudeCliRuns('waiting-native', directory), [{ startedAt: 2_000, entrypoint: 'cli' }]);
      assert.deepEqual(await listLiveClaudeCliRuns('sdk-native', directory), [{ startedAt: 3_000, entrypoint: 'sdk-ts' }]);
      assert.deepEqual(await listLiveClaudeCliRuns('unnamed-native', directory), [{ startedAt: 4_000, entrypoint: null }]);
      assert.deepEqual(await listLiveClaudeCliRuns('blank-native', directory), [{ startedAt: 5_000, entrypoint: null }]);
    },
  );
});

test('a Claude CLI process at rest is never listed, since nothing it launched is still running', async () => {
  // The CLI writes `idle`, or `shell` when only background shell commands
  // are left, once no agent or workflow it started is unfinished. Listing it
  // let an idle Shell-tab `claude --resume` vouch for a dead CloudCLI run's
  // launches for as long as the tab's REPL lived.
  await withRegistry(
    {
      '1.json': { pid: process.pid, sessionId: 'resting', status: 'idle', entrypoint: 'cli', startedAt: 1_000 },
      '2.json': { pid: process.pid, sessionId: 'resting', status: 'shell', entrypoint: 'cli', startedAt: 2_000 },
    },
    async (directory) => {
      assert.deepEqual(await listLiveClaudeCliRuns('resting', directory), []);
    },
  );
});

test('the run lookup finds nothing for a record that is not a live process of the session', async () => {
  // The fixture's premise: signal 0 fails on DEAD_PID with something other
  // than EPERM, which would count as alive.
  assert.throws(
    () => process.kill(DEAD_PID, 0),
    (error: NodeJS.ErrnoException) => error.code !== undefined && error.code !== 'EPERM',
  );

  // Each record would be listed but for the one thing its label names.
  const cases: Array<[string, Record<string, Record<string, unknown> | string>]> = [
    // A crash leaves its file behind; the pid is long gone.
    ['a dead process', { '1.json': { pid: DEAD_PID, sessionId: 'target', status: 'busy', startedAt: 1_000 } }],
    ['another session', { '1.json': { pid: process.pid, sessionId: 'someone-else', status: 'busy', startedAt: 1_000 } }],
    ['a half-written file', { '1.json': '{"pid":' }],
    // Up, but with no start to place a launch before or after.
    ['a record without a start', { '1.json': { pid: process.pid, sessionId: 'target', status: 'busy' } }],
    // Only the `.json` records are ever opened.
    ['a key file', { '1.key': { pid: process.pid, sessionId: 'target', status: 'busy', startedAt: 1_000 } }],
  ];

  for (const [label, files] of cases) {
    await withRegistry(files, async (directory) => {
      assert.deepEqual(await listLiveClaudeCliRuns('target', directory), [], label);
    });
  }
});

test('the run lookup tells a reused pid from the process the registry recorded', { skip: process.platform !== 'linux' }, async () => {
  const procStart = await readOwnProcStart();
  await withRegistry(
    {
      '1.json': { pid: process.pid, sessionId: 'same-process', status: 'busy', entrypoint: 'cli', procStart, startedAt: 1_000 },
      // The pid is alive, but the kernel started it at another time: it now
      // belongs to some other program.
      '2.json': { pid: process.pid, sessionId: 'reused-pid', status: 'busy', entrypoint: 'cli', procStart: String(Number(procStart) + 1), startedAt: 2_000 },
    },
    async (directory) => {
      assert.deepEqual(await listLiveClaudeCliRuns('same-process', directory), [{ startedAt: 1_000, entrypoint: 'cli' }]);
      assert.deepEqual(await listLiveClaudeCliRuns('reused-pid', directory), []);
    },
  );
});

test('every live run of a session is listed, not only the earliest', async () => {
  // Which process wrote a given launch is the history reader's question: a
  // REPL and an SDK run on one session start at different times and write
  // under different entrypoints, so neither can stand in for the other.
  await withRegistry(
    {
      '1.json': { pid: process.pid, sessionId: 'shared', status: 'busy', entrypoint: 'cli', startedAt: 5_000 },
      '2.json': { pid: process.pid, sessionId: 'shared', entrypoint: 'sdk-ts', startedAt: 3_000 },
      '3.json': { pid: process.pid, sessionId: 'shared', status: 'idle', entrypoint: 'cli', startedAt: 1_000 },
    },
    async (directory) => {
      assert.deepEqual(sortRuns(await listLiveClaudeCliRuns('shared', directory)), [
        { startedAt: 3_000, entrypoint: 'sdk-ts' },
        { startedAt: 5_000, entrypoint: 'cli' },
      ]);
    },
  );
});

test('a missing registry directory means no live process and nothing busy', async () => {
  await withRegistry({}, async (directory) => {
    const missing = path.join(directory, 'never-created');
    assert.deepEqual(await listLiveClaudeCliRuns('target', missing), []);
    assert.deepEqual(await listBusyClaudeCliSessions(missing), []);
  });
});

test('the busy list still reports only processes that are mid-turn', async () => {
  await withRegistry(
    {
      '1.json': { pid: process.pid, sessionId: 'busy-native', status: 'busy', startedAt: 1_000 },
      '2.json': { pid: process.pid, sessionId: 'idle-native', status: 'idle', startedAt: 2_000 },
      '3.json': { pid: process.pid, sessionId: 'sdk-native', startedAt: 3_000 },
      '4.json': { pid: DEAD_PID, sessionId: 'dead-native', status: 'busy', startedAt: 4_000 },
      '5.json': { pid: process.pid, sessionId: 'unstamped-native', status: 'busy' },
      '6.json': { pid: process.pid, sessionId: 'waiting-native', status: 'waiting', startedAt: 6_000 },
    },
    async (directory) => {
      const before = Date.now();
      const busy = await listBusyClaudeCliSessions(directory);
      const after = Date.now();
      busy.sort((left, right) => left.providerSessionId.localeCompare(right.providerSessionId));

      assert.deepEqual(busy.map((session) => session.providerSessionId), ['busy-native', 'unstamped-native']);
      assert.equal(busy[0].startedAt, 1_000);
      // A busy record without a start is still listed, as running since now.
      assert.ok(busy[1].startedAt >= before && busy[1].startedAt <= after);
    },
  );
});
