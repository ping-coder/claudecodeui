import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { test, vi } from 'vitest';

/**
 * vitest.memory-guard.ts is the first of vitest.config.ts's setupFiles. It SIGKILLs a
 * test worker whose RSS plus swap passes VITEST_WORKER_RSS_LIMIT_MB, because a stuck
 * test once grew a worker to 58 GiB and froze the machine. These tests check that it
 * is armed in this worker and drive it in child processes with a low limit.
 *
 * Every child grows its memory in fixed steps up to a ceiling and then exits on its
 * own, so a broken guard costs at most the ceiling, and a child that hangs is
 * terminated after 15 s.
 */

/** What the guard leaves on `process`: its watchdog thread and the file it would name. */
type MemoryGuard = { watchdog: Worker; testFile: SharedArrayBuffer };

type ChildResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type ChildOptions = {
  /** Command prefix that starts the child, such as systemd-run with a memory cap. */
  launcher?: string[];
  /**
   * 'unread' leaves the child's stderr unread until it exits, like a paused pager, and
   * 'closed' closes it at once, like a vitest process that is gone. Both leave `stderr` empty.
   */
  stderr?: 'read' | 'unread' | 'closed';
};

// Not `new URL(…, import.meta.url)`: under jsdom, URL is jsdom's class, which node:url rejects.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const guardUrl = pathToFileURL(resolve(repoRoot, 'vitest.memory-guard.ts')).href;
const guardDisabled = process.env.VITEST_WORKER_RSS_LIMIT_MB?.trim() === '0';

/** Exit code of a child that reached its ceiling without being killed. */
const GREW_TO_CEILING = 3;

// Loads the guard the way vitest does (vitest records the file in progress first), runs
// `beforeGrowing`, then grows memory outside the V8 heap in a loop that never yields to the
// event loop.
const growScript = (beforeGrowing = '') => `
  import { readFileSync, writeSync } from 'node:fs';
  globalThis.__vitest_worker__ = { filepath: '/repo/src/stuck.test.ts' };
  await import(process.env.GUARD_URL);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  ${beforeGrowing}
  const chunks = [];
  while (chunks.length * 8 < Number(process.env.CEILING_MB)) {
    chunks.push(Buffer.alloc(8 * 1024 * 1024, 1)); // filled, so the pages are resident
    if (process.env.REPORT_MEMORY) {
      writeSync(1, readFileSync('/proc/self/status', 'utf8').match(/^Vm(RSS|Swap):.*$/gm).join(' ') + '\\n');
    }
    Atomics.wait(sleeper, 0, 0, 25); // paced, so the watchdog (every 250 ms) looks in well before the ceiling
  }
  process.exitCode = ${GREW_TO_CEILING};
`;

const GROW_SCRIPT = growScript();

// Uses up every file descriptor for a few of the watchdog's rounds, in which reading the memory
// use fails (process.memoryUsage.rss() opens /proc/self/stat), then frees them again.
const USE_UP_FILE_DESCRIPTORS = `
  const { closeSync, openSync } = await import('node:fs');
  const descriptors = [];
  try {
    for (;;) descriptors.push(openSync('/dev/null', 'r'));
  } catch (error) {
    if (error.code !== 'EMFILE') throw error;
  }
  Atomics.wait(sleeper, 0, 0, 600);
  descriptors.forEach((fd) => closeSync(fd));
`;

// Starts the child with 256 file descriptors, so USE_UP_FILE_DESCRIPTORS is quick. `ulimit -n`
// sets the hard limit too; Node would raise a soft limit alone to the hard one.
const LIMIT_FILE_DESCRIPTORS = ['sh', '-c', 'ulimit -n 256 && exec "$0" "$@"'];

// Fills stderr, which the parent leaves unread, until not one more byte fits. fd 2 is
// non-blocking, as it usually is in a vitest worker, so a write to the full pipe fails with
// EAGAIN. It is set here because tsx may have started esbuild with this stderr, and libuv makes
// inherited stdio blocking, a flag both processes share. The parent takes in some output
// before it stops reading, hence the rounds.
const FILL_STDERR = `
  process.stderr._handle.setBlocking(false);
  const filler = Buffer.alloc(4096, 120);
  let written;
  do {
    written = 0;
    try {
      for (;;) written += writeSync(2, filler);
    } catch (error) {
      if (error.code !== 'EAGAIN') throw error;
    }
    Atomics.wait(sleeper, 0, 0, 300);
  } while (written > 0);
`;

// Then makes fd 2 blocking, so a write to the full pipe never returns, as on a paused terminal.
const FILL_AND_BLOCK_STDERR = `
  ${FILL_STDERR}
  process.stderr._handle.setBlocking(true);
`;

// The threads pool runs the test, and so the guard, in a worker thread of the vitest
// process. The thread inherits --import tsx and --input-type=module, so it runs GROW_SCRIPT as is.
const GROW_IN_THREAD_SCRIPT = `
  import { Worker } from 'node:worker_threads';
  new Worker(${JSON.stringify(GROW_SCRIPT)}, { eval: true }).on('exit', (code) => {
    process.exitCode = code;
  });
`;

// Prints whether loading the guard started a watchdog.
const REPORT_ARMED_SCRIPT = `
  await import(process.env.GUARD_URL);
  process.stdout.write(String(process.__vitestMemoryGuard !== undefined));
`;

// Swap only fills up under memory pressure, so that test confines a child to 128 MB of RAM
// with systemd. It runs where a user systemd can cap the child's memory and there is swap, as
// on peace-cc. The kernel must also be willing to swap the child out: at vm.swappiness 0, or
// with too little free swap, the cgroup's OOM killer ends the child before the guard does.
const CONFINE_TO_128_MB = [
  'systemd-run', '--user', '--scope', '--quiet', '-p', 'MemoryMax=128M', '-p', 'MemorySwapMax=1G', '--',
];

/**
 * Whether `launcher` starts a command under the 128 MB cap. Its exit code does not tell:
 * systemd starts the scope and exits 0 even where it cannot apply MemoryMax, as when the
 * memory controller is not delegated to the user's systemd (cgroup v1 or hybrid). So this
 * reads memory.max from inside the scope; outside cgroup v2 there is no such file, and the
 * answer is no.
 */
function appliesMemoryCap(launcher: string[]): boolean {
  const [command, ...args] = launcher;
  const probe = spawnSync(
    command,
    [...args, 'sh', '-c', 'cat "/sys/fs/cgroup$(sed -n "s/^0:://p" /proc/self/cgroup)/memory.max"'],
    { encoding: 'utf8', timeout: 5_000 },
  );
  return probe.status === 0 && probe.stdout.trim() === String(128 * 1024 * 1024);
}

function canConfineWithSwap(): boolean {
  try {
    const hasSwap = readFileSync('/proc/swaps', 'utf8').trim().split('\n').length > 1;
    return hasSwap && appliesMemoryCap(CONFINE_TO_128_MB);
  } catch {
    return false;
  }
}

function runChild(script: string, env: Record<string, string>, options: ChildOptions = {}): Promise<ChildResult> {
  const { launcher = [], stderr: stderrHandling = 'read' } = options;
  const [command, ...args] = [...launcher, process.execPath, '--import', 'tsx', '--input-type=module', '-e', script];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: { ...process.env, GUARD_URL: guardUrl, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    if (stderrHandling === 'read') {
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    } else if (stderrHandling === 'closed') {
      child.stderr.destroy();
    } else {
      // 'close' waits for every pipe to close, this one included.
      child.on('exit', () => child.stderr.destroy());
    }
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test.skipIf(guardDisabled)('the guard is armed in this vitest worker', async () => {
  const guard = (process as typeof process & { __vitestMemoryGuard?: MemoryGuard }).__vitestMemoryGuard;

  assert.ok(guard, 'vitest.config.ts loads vitest.memory-guard.ts before the tests');
  assert.equal(guard.watchdog instanceof Worker, true);
  // The watchdog idles between its checks, so idle time shows that its thread is running.
  await vi.waitFor(() => assert.equal(guard.watchdog.performance.eventLoopUtilization().idle > 0, true));
  assert.equal(guard.watchdog.threadId > 0, true, 'the watchdog has not exited');
  const testFile = Buffer.from(guard.testFile);
  assert.equal(
    testFile.subarray(0, testFile.indexOf(0)).toString().endsWith('/src/shared/tests/vitestMemoryGuard.test.ts'),
    true,
    'a kill would name this file',
  );
});

test('kills a process that grows past the limit, even while its main thread is blocked', async () => {
  const result = await runChild(GROW_SCRIPT, { VITEST_WORKER_RSS_LIMIT_MB: '192', CEILING_MB: '768' });

  assert.equal(result.signal, 'SIGKILL', `the child was not killed: ${result.stderr}`);
  assert.match(
    result.stderr,
    /^\[memory-guard\] test worker \d+ running \/repo\/src\/stuck\.test\.ts reached \d+ MB \(limit 192 MB\) and was killed\. A test is probably stuck in a loop\.$/m,
  );
}, 20_000);

test('keeps watching after a round fails to read the memory use', async () => {
  const result = await runChild(
    growScript(USE_UP_FILE_DESCRIPTORS),
    { VITEST_WORKER_RSS_LIMIT_MB: '192', CEILING_MB: '768' },
    { launcher: LIMIT_FILE_DESCRIPTORS },
  );

  assert.equal(result.signal, 'SIGKILL', `the child was not killed: ${result.stderr}`);
  assert.match(result.stderr, /^\[memory-guard\] test worker \d+ running \/repo\/src\/stuck\.test\.ts reached \d+ MB/m);
}, 20_000);

test.each([
  ['closed, as when vitest itself is gone', GROW_SCRIPT, 'closed' as const],
  ['full and nobody reads it, as behind a paused pager', growScript(FILL_STDERR), 'unread' as const],
  ['full and a write to it blocks', growScript(FILL_AND_BLOCK_STDERR), 'unread' as const],
])('kills the process even when its stderr is %s', async (_case, script, stderr) => {
  const result = await runChild(script, { VITEST_WORKER_RSS_LIMIT_MB: '192', CEILING_MB: '768' }, { stderr });

  assert.equal(result.signal, 'SIGKILL', `the child was not killed (exit code ${result.code})`);
}, 20_000);

test('leaves a process under the limit alone and does not keep it alive', async () => {
  const result = await runChild(GROW_SCRIPT, { VITEST_WORKER_RSS_LIMIT_MB: '512', CEILING_MB: '128' });

  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, GREW_TO_CEILING, 'the child reached its ceiling and exited on its own');
  assert.equal(result.stderr.includes('[memory-guard]'), false);
}, 20_000);

test('an empty or mistyped limit keeps the guard on; only 0 turns it off', async () => {
  const results = await Promise.all(
    ['', 'lots', '0'].map((limit) => runChild(REPORT_ARMED_SCRIPT, { VITEST_WORKER_RSS_LIMIT_MB: limit })),
  );

  assert.deepEqual(results.map(({ stdout }) => stdout), ['true', 'true', 'false']);
}, 20_000);

test.skipIf(!canConfineWithSwap())('counts memory the kernel swapped out', async () => {
  const result = await runChild(
    GROW_SCRIPT,
    { VITEST_WORKER_RSS_LIMIT_MB: '320', CEILING_MB: '768', REPORT_MEMORY: '1' },
    { launcher: CONFINE_TO_128_MB },
  );

  assert.equal(result.signal, 'SIGKILL', `the child was not killed: ${result.stderr}`);
  assert.match(
    result.stderr,
    /^\[memory-guard\] test worker \d+ running \/repo\/src\/stuck\.test\.ts reached \d+ MB \(limit 320 MB\)/m,
  );
  // The child's last report before the kill: RSS alone never reached the limit.
  const lastReport = result.stdout.trim().split('\n').at(-1) ?? '';
  const rssKb = Number(/VmRSS:\s+(\d+)/.exec(lastReport)?.[1]);
  const swapKb = Number(/VmSwap:\s+(\d+)/.exec(lastReport)?.[1]);
  assert.equal(rssKb < 320 * 1024, true, `RSS alone reached the limit, so the cap did not hold: ${lastReport}`);
  assert.equal(swapKb > 0, true, `nothing was swapped out: ${lastReport}`);
}, 20_000);

test('the swap test runs only where the cap is applied, not wherever its launcher exits 0', () => {
  // `env` runs the command and exits 0 without a cap, as systemd-run does where it cannot apply MemoryMax.
  assert.equal(appliesMemoryCap(['env']), false);
});

test('in the threads pool the kill takes the whole vitest process and says so', async () => {
  const result = await runChild(GROW_IN_THREAD_SCRIPT, { VITEST_WORKER_RSS_LIMIT_MB: '192', CEILING_MB: '768' });

  assert.equal(result.signal, 'SIGKILL', `the child was not killed: ${result.stderr}`);
  assert.match(
    result.stderr,
    /^\[memory-guard\] vitest process \d+ running \/repo\/src\/stuck\.test\.ts reached \d+ MB \(limit 192 MB\) and was killed\. The threads pool runs all test files in this process/m,
  );
}, 20_000);
