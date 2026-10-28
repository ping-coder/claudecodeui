// Kills this test worker once its memory passes a hard limit.
//
// On Oct 27, 2026 a stuck test grew one vitest worker to 58 GiB within minutes and
// froze peace-cc. The growth was outside the V8 heap, so --max-old-space-size could
// not have stopped it. This guard watches the worker's RSS plus swap (pages the kernel
// swaps out leave RSS, so RSS alone stalls under memory pressure) from a separate
// thread, which keeps running even when a test blocks the main thread, and SIGKILLs
// the worker past the limit. vitest then stops the whole run with a "Channel closed"
// error that does not say which file was running, so the guard's message names it.
//
// The limit is per test file only in the forks pool (vitest's default), where every test
// file runs in a process of its own. The threads pools run test files inside the vitest
// process, so there the limit covers all of them together and the kill takes vitest down.
//
// Default limit 4096 MB; override with VITEST_WORKER_RSS_LIMIT_MB (0 turns it off).
import { Buffer } from 'node:buffer';
import { isMainThread, Worker } from 'node:worker_threads';

const DEFAULT_LIMIT_MB = 4096;
// An empty or mistyped value keeps the default rather than switching the guard off.
const configuredMb = Number(process.env.VITEST_WORKER_RSS_LIMIT_MB?.trim() || DEFAULT_LIMIT_MB);
const limitMb = Number.isFinite(configuredMb) && configuredMb >= 0 ? configuredMb : DEFAULT_LIMIT_MB;
// The vm pools give every test file a fresh globalThis but keep `process`, so the guard
// lives on `process` to start one watchdog per worker. A test reads it to check the watchdog.
const state = process as typeof process & {
  __vitestMemoryGuard?: { watchdog: Worker; testFile: SharedArrayBuffer };
};

if (limitMb > 0) {
  state.__vitestMemoryGuard ??= startWatchdog();
  // vitest's worker state holds the file in progress (expect.getState().testPath reads it), and
  // setup files run again before every test file, so the watchdog can name the file it kills.
  const filepath = (globalThis as { __vitest_worker__?: { filepath?: string } }).__vitest_worker__?.filepath;
  Buffer.from(state.__vitestMemoryGuard.testFile).fill(0).write(filepath ?? '');
}

function startWatchdog() {
  const testFile = new SharedArrayBuffer(1024);
  const watchdog = new Worker(
    `
    const { workerData } = require('node:worker_threads');
    const { readFileSync, write } = require('node:fs');
    const testFile = Buffer.from(workerData.testFile);
    const kill = () => process.kill(process.pid, 'SIGKILL');
    const swapMb = () => {
      try {
        return Number(/^VmSwap:\\s+(\\d+) kB/m.exec(readFileSync('/proc/self/status', 'utf8'))[1]) / 1024;
      } catch {
        return 0; // no /proc outside Linux
      }
    };
    setInterval(() => {
      try {
        const usedMb = process.memoryUsage.rss() / 1048576 + swapMb();
        if (usedMb > workerData.limitMb) {
          // Kill whether or not the message gets out: stderr may be closed (vitest is gone), full
          // with nobody reading it, or full and blocking. fs.write runs on libuv's thread pool, so
          // this timer still fires when the write never returns.
          setTimeout(kill, 200);
          const end = testFile.indexOf(0);
          const file = testFile.toString('utf8', 0, end === -1 ? testFile.length : end);
          write(2, '[memory-guard] ' + workerData.target + ' ' + process.pid + (file ? ' running ' + file : '') +
            ' reached ' + Math.round(usedMb) + ' MB (limit ' + workerData.limitMb + ' MB) and was killed. ' +
            workerData.hint + '\\n', kill);
        }
      } catch {
        // Skip a round that fails, as rss() does with EMFILE once the worker has used up its file
        // descriptors: an exception escaping here would end this thread, and the guard with it.
      }
    }, 250);
    `,
    {
      eval: true,
      // Not the test worker's flags: --input-type=module, for one, would load this script as ESM and crash it.
      execArgv: [],
      workerData: {
        limitMb,
        testFile,
        target: isMainThread ? 'test worker' : 'vitest process',
        hint: isMainThread
          ? 'A test is probably stuck in a loop.'
          : 'The threads pool runs all test files in this process, so the limit covers them together; rerun with the forks pool to find the test.',
      },
    },
  );
  watchdog.unref();
  return { watchdog, testFile };
}
