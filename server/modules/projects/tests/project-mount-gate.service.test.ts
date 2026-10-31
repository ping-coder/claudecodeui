import assert from 'node:assert/strict';
import test from 'node:test';

import { createMountGate } from '@/modules/projects/services/project-mount-gate.service.js';

const TIME_LIMIT_MS = 50;
const SLOW_CALL_TIME_LIMIT_MS = 400;

/**
 * A gate over the mount points `/`, `/data` and `/data/nas` (a share mounted
 * inside another), all network shares unless named in `localDisks`, with
 * short time limits and a clock the test moves, and calls that hang until
 * the test lets them answer.
 */
function createTestGate(mountPoints: string[] | null = ['/', '/data', '/data/nas'], localDisks: string[] = []) {
  const clock = { now: 0 };
  const releases: Array<() => void> = [];
  const gate = createMountGate({
    listMountPoints: async () => mountPoints?.map((mountPoint) => ({ path: mountPoint, local: localDisks.includes(mountPoint) })) ?? null,
    timeoutMs: TIME_LIMIT_MS,
    slowCallTimeoutMs: SLOW_CALL_TIME_LIMIT_MS,
    monotonicNow: () => clock.now,
    logWarning: () => {},
  });
  const started: string[] = [];
  return {
    gate,
    clock,
    started,
    /** A call on `label` that answers at once. */
    answering: (label: string) => async () => {
      started.push(label);
      return label;
    },
    /** A call on `label` that hangs until `releaseAll`. */
    hanging: (label: string) => () => {
      started.push(label);
      return new Promise<string>((resolve) => {
        releases.push(() => resolve(label));
      });
    },
    async releaseAll() {
      releases.splice(0).forEach((release) => release());
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('a share that hangs keeps one call and refuses new ones, while other shares answer', { timeout: 5_000 }, async () => {
  const { gate, started, answering, hanging, releaseAll } = createTestGate();
  // A share mounted inside another one is a share of its own.
  const hung = gate.run('/data/nas/videos/a.mkv', hanging('nas-1'));
  while (!started.includes('nas-1')) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const waiting = gate.run('/data/nas/videos/b.mkv', answering('nas-2'));
  assert.deepEqual(await gate.run('/data/local/c.txt', answering('data')), { kind: 'done', value: 'data' });
  assert.deepEqual(await gate.run('/home/user/d.txt', answering('root')), { kind: 'done', value: 'root' });

  assert.deepEqual(await hung, { kind: 'unreachable' });
  // The call that waited behind it on the same share never ran.
  assert.deepEqual(await waiting, { kind: 'unreachable' });
  assert.deepEqual(await gate.run('/data/nas/e.txt', answering('nas-3')), { kind: 'unreachable' });
  assert.deepEqual(started, ['nas-1', 'data', 'root']);
  await releaseAll();
});

test('a share is tried again once its call answered and the wait after its time-out is over', { timeout: 5_000 }, async () => {
  const { gate, clock, started, answering, hanging, releaseAll } = createTestGate();
  assert.deepEqual(await gate.run('/data/nas/a', hanging('first')), { kind: 'unreachable' });

  // While the call hangs, not even a user's retry starts another.
  assert.deepEqual(await gate.run('/data/nas/a', answering('retry'), { retryNow: true }), { kind: 'unreachable' });
  await releaseAll();

  // It answered, but the share timed out lately: a listing waits, a retry goes.
  clock.now = 10_000;
  assert.deepEqual(await gate.run('/data/nas/a', answering('listing')), { kind: 'unreachable' });
  assert.deepEqual(await gate.run('/data/nas/a', answering('retry'), { retryNow: true }), { kind: 'done', value: 'retry' });
  clock.now = 40_000;
  assert.deepEqual(await gate.run('/data/nas/a', answering('later')), { kind: 'done', value: 'later' });
  assert.deepEqual(started, ['first', 'retry', 'later']);
});

test('a call that fails answers with its error, and a share that answers slowly is not unreachable', { timeout: 5_000 }, async () => {
  const { gate } = createTestGate();
  const failure = Object.assign(new Error('no such file'), { code: 'ENOENT' });
  const failed = await gate.run('/data/x', async () => {
    throw failure;
  });
  assert.equal(failed.kind, 'failed');
  assert.equal(failed.kind === 'failed' && failed.error === failure, true);
  const slow = await gate.run('/data/x', () => new Promise((resolve) => setTimeout(() => resolve('slow'), TIME_LIMIT_MS / 5)));
  assert.deepEqual(slow, { kind: 'done', value: 'slow' });
  assert.deepEqual(await gate.run('/data/y', async () => 'next'), { kind: 'done', value: 'next' });
});

test('shares not seen answering get two calls between them; a share seen answering is not held back', { timeout: 5_000 }, async () => {
  const { gate, started, answering, hanging, releaseAll } = createTestGate(['/', '/mnt/a', '/mnt/b', '/mnt/c', '/srv']);
  // /srv answered lately.
  assert.deepEqual(await gate.run('/srv/x', answering('srv')), { kind: 'done', value: 'srv' });

  const results = await Promise.all([
    gate.run('/mnt/a/x', hanging('a')),
    gate.run('/mnt/b/x', hanging('b')),
    gate.run('/mnt/c/x', answering('c')),
  ]);
  assert.deepEqual(results, [{ kind: 'unreachable' }, { kind: 'unreachable' }, { kind: 'busy' }]);
  assert.deepEqual(await gate.run('/srv/y', answering('srv-again')), { kind: 'done', value: 'srv-again' });
  assert.deepEqual(started, ['srv', 'a', 'b', 'srv-again']);

  await releaseAll();
  assert.deepEqual(await gate.run('/mnt/c/x', answering('c')), { kind: 'done', value: 'c' });
});

test('a local disk is never held back by dead network shares, even before it answered', { timeout: 5_000 }, async () => {
  const { gate, started, answering, hanging, releaseAll } = createTestGate(
    ['/', '/mnt/a', '/mnt/b', '/mnt/c', '/data'],
    ['/', '/data'],
  );
  const results = await Promise.all([
    gate.run('/mnt/a/x', hanging('a')),
    gate.run('/mnt/b/x', hanging('b')),
    gate.run('/data/big/x', answering('data')),
    gate.run('/home/user/y', answering('root')),
    gate.run('/mnt/c/x', answering('c')),
  ]);
  assert.deepEqual(results, [
    { kind: 'unreachable' },
    { kind: 'unreachable' },
    { kind: 'done', value: 'data' },
    { kind: 'done', value: 'root' },
    // A network share not seen answering still waits for the two that hang.
    { kind: 'busy' },
  ]);
  // Long after, the local disk still goes at once.
  assert.deepEqual(await gate.run('/data/big/z', answering('data-later')), { kind: 'done', value: 'data-later' });
  assert.deepEqual(started, ['a', 'b', 'data', 'root', 'data-later']);
  await releaseAll();
});

test('a call on a local disk is not gated: it may run past the time limit, and its disk never reads as unreachable', { timeout: 5_000 }, async () => {
  const { gate, answering, hanging, releaseAll } = createTestGate(['/', '/mnt/nas'], ['/']);
  // A disk spinning up, or busy copying: slower than the limit, and the call beside it does not wait for it.
  const slow = gate.run('/home/user/big.iso', () => new Promise<string>((resolve) => {
    setTimeout(() => resolve('slow'), TIME_LIMIT_MS * 3);
  }));
  const beside = gate.run('/home/user/a.txt', answering('beside'));
  assert.deepEqual(await Promise.all([slow, beside]), [{ kind: 'done', value: 'slow' }, { kind: 'done', value: 'beside' }]);

  const hung = gate.run('/home/user/stuck', hanging('stuck'));
  await new Promise((resolve) => setTimeout(resolve, TIME_LIMIT_MS * 2));
  assert.equal(await gate.isUnreachable('/home/user/b.txt'), false);
  assert.deepEqual(await gate.run('/home/user/b.txt', answering('after')), { kind: 'done', value: 'after' });
  await releaseAll();
  assert.deepEqual(await hung, { kind: 'done', value: 'stuck' });
});

test('a slow call (a whole folder read) may run past the time limit on a share that answers, holding its turn', { timeout: 5_000 }, async () => {
  const { gate, started, answering, hanging, releaseAll } = createTestGate();
  // A NAS folder of 100k files takes longer to read than a probe may.
  const read = gate.run('/data/nas/scans', () => new Promise<string>((resolve) => {
    setTimeout(() => resolve('names'), TIME_LIMIT_MS * 3);
  }), { slow: true });
  // A call on the share meanwhile waits its turn, then gives up: busy, which
  // says nothing about the share.
  assert.deepEqual(await gate.run('/data/nas/models', answering('probe')), { kind: 'busy' });
  assert.equal(await gate.isUnreachable('/data/nas/models'), false);
  assert.deepEqual(await read, { kind: 'done', value: 'names' });
  assert.deepEqual(await gate.run('/data/nas/models', answering('after')), { kind: 'done', value: 'after' });

  // One that never answers still counts against its share, past its own limit.
  assert.deepEqual(await gate.run('/data/nas/huge', hanging('hung'), { slow: true }), { kind: 'unreachable' });
  assert.equal(await gate.isUnreachable('/data/nas/models'), true);
  assert.deepEqual(started, ['after', 'hung']);
  await releaseAll();
});

test('a call is told whether the gate times it: on a network share, not on a local disk', { timeout: 5_000 }, async () => {
  const { gate } = createTestGate(['/', '/data', '/data/nas'], ['/data']);
  assert.deepEqual(await gate.run('/data/local/a', async (call) => call.gated), { kind: 'done', value: false });
  assert.deepEqual(await gate.run('/data/nas/a', async (call) => call.gated), { kind: 'done', value: true });
});

test('a call that waits behind one that hangs is told the share is unreachable, not busy', { timeout: 5_000 }, async () => {
  const { gate, started, answering, hanging, releaseAll } = createTestGate();
  // Asked in the same turn of the event loop, as the listings of two
  // mounts on one network share do.
  const results = await Promise.all([
    gate.run('/data/nas/a', hanging('first')),
    gate.run('/data/nas/b', answering('second')),
    gate.run('/data/nas/c', answering('third')),
  ]);
  assert.deepEqual(results, [{ kind: 'unreachable' }, { kind: 'unreachable' }, { kind: 'unreachable' }]);
  assert.deepEqual(started, ['first']);
  await releaseAll();
});

test('the gate tells whether a path is on a share that does not answer', { timeout: 5_000 }, async () => {
  const { gate, clock, hanging, releaseAll } = createTestGate();
  assert.equal(await gate.shareOf('/data/nas/videos/a.mkv'), '/data/nas');
  assert.equal(await gate.shareOf('/data/local/b.txt'), '/data');
  assert.equal(await gate.isUnreachable('/data/nas/videos/a.mkv'), false);

  assert.deepEqual(await gate.run('/data/nas/videos/a.mkv', hanging('nas')), { kind: 'unreachable' });
  assert.equal(await gate.isUnreachable('/data/nas/other/c.txt'), true);
  assert.equal(await gate.isUnreachable('/data/local/b.txt'), false);
  assert.equal(await gate.isUnreachable('/home/user/d.txt'), false);

  // Once the call answered and the wait after its time-out is over, it answers again.
  await releaseAll();
  assert.equal(await gate.isUnreachable('/data/nas/other/c.txt'), true);
  clock.now = 40_000;
  assert.equal(await gate.isUnreachable('/data/nas/other/c.txt'), false);
});

test('a call waiting for its turn gives up when its signal aborts', { timeout: 5_000 }, async () => {
  const { gate, started, answering, releaseAll } = createTestGate();
  let finishFirst = () => {};
  const first = gate.run('/data/a', () => new Promise<string>((resolve) => {
    finishFirst = () => resolve('first');
  }));
  const controller = new AbortController();
  const second = gate.run('/data/b', answering('second'), { signal: controller.signal });
  controller.abort();
  assert.deepEqual(await second, { kind: 'busy' });
  finishFirst();
  assert.deepEqual(await first, { kind: 'done', value: 'first' });
  assert.deepEqual(await gate.run('/data/c', answering('third'), { signal: controller.signal }), { kind: 'busy' });
  assert.deepEqual(started, []);
  await releaseAll();
});

test('without mount points a share is guessed from the top folder', { timeout: 5_000 }, async () => {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return;
  }
  const { gate, answering, hanging, releaseAll } = createTestGate(null);
  assert.deepEqual(await gate.run('/mnt/nas1/x', hanging('nas1')), { kind: 'unreachable' });
  assert.deepEqual(await gate.run('/mnt/nas2/x', answering('nas2')), { kind: 'unreachable' });
  assert.deepEqual(await gate.run('/data/x', answering('data')), { kind: 'done', value: 'data' });
  await releaseAll();
});

/** A call on `label` that answers when the test calls `answer`, noted in `started` when it starts. */
function heldCall(started: string[], label: string) {
  let answer = () => {};
  return {
    call: () => {
      started.push(label);
      return new Promise<string>((resolve) => {
        answer = () => resolve(label);
      });
    },
    answer: () => answer(),
  };
}

/** Lets the event loop turn until `condition` holds, or gives up after many turns. */
async function turnsUntil(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 1_000 && !condition(); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('a call someone waits for gets its turn before the background calls of a walk that waited longer', { timeout: 5_000 }, async () => {
  const { gate, started, answering } = createTestGate();
  const holder = heldCall(started, 'holder');
  const holding = gate.run('/data/nas/a', holder.call);
  await turnsUntil(() => started.includes('holder'));

  // A walk's lstats queue up, then the user opens a file.
  const walk = [
    gate.run('/data/nas/b', answering('lstat-1'), { background: true }),
    gate.run('/data/nas/c', answering('lstat-2'), { background: true }),
  ];
  const open = gate.run('/data/nas/d', answering('open'));
  // And a probe, which is not a walk's either.
  const probe = gate.run('/data/nas/e', answering('probe'));
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  holder.answer();

  assert.deepEqual(await Promise.all([holding, open, probe, ...walk]), [
    { kind: 'done', value: 'holder' },
    { kind: 'done', value: 'open' },
    { kind: 'done', value: 'probe' },
    { kind: 'done', value: 'lstat-1' },
    { kind: 'done', value: 'lstat-2' },
  ]);
  assert.deepEqual(started, ['holder', 'open', 'probe', 'lstat-1', 'lstat-2']);
});

test('on a share known to answer, a call someone waits for runs beside a folder read in the background, one such call for the whole server at a time', { timeout: 5_000 }, async () => {
  const { gate, started, answering } = createTestGate();
  // Both shares answered lately.
  assert.deepEqual(await gate.run('/data/nas/x', answering('nas')), { kind: 'done', value: 'nas' });
  assert.deepEqual(await gate.run('/data/x', answering('data')), { kind: 'done', value: 'data' });
  const nasRead = heldCall(started, 'nas-read');
  const dataRead = heldCall(started, 'data-read');
  const nasReading = gate.run('/data/nas/big', nasRead.call, { slow: true, background: true });
  const dataReading = gate.run('/data/big', dataRead.call, { slow: true, background: true });
  await turnsUntil(() => started.includes('nas-read') && started.includes('data-read'));

  // A file opened on the NAS meanwhile goes at once, beside its folder read.
  const nasOpen = heldCall(started, 'nas-open');
  const nasOpening = gate.run('/data/nas/notes.md', nasOpen.call);
  await turnsUntil(() => started.includes('nas-open'));
  // Another walk call on the NAS waits for the read; a file on the other
  // share waits for the turn beside to be free, and takes it once it is.
  const nasLstat = gate.run('/data/nas/y', answering('nas-lstat'), { background: true });
  const dataOpening = gate.run('/data/notes.md', answering('data-open'));
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(started.includes('data-open'), false);
  nasOpen.answer();
  assert.deepEqual(await nasOpening, { kind: 'done', value: 'nas-open' });
  assert.deepEqual(await dataOpening, { kind: 'done', value: 'data-open' });
  assert.equal(started.includes('nas-lstat'), false);

  nasRead.answer();
  dataRead.answer();
  assert.deepEqual(await Promise.all([nasReading, dataReading, nasLstat]), [
    { kind: 'done', value: 'nas-read' },
    { kind: 'done', value: 'data-read' },
    { kind: 'done', value: 'nas-lstat' },
  ]);
});

test('a folder read the user waits for never runs beside a folder read in the background, and files opened meanwhile still do', { timeout: 5_000 }, async () => {
  const { gate, started, answering } = createTestGate();
  assert.deepEqual(await gate.run('/data/nas/x', answering('nas')), { kind: 'done', value: 'nas' });
  assert.deepEqual(await gate.run('/data/x', answering('data')), { kind: 'done', value: 'data' });
  const nasRead = heldCall(started, 'nas-read');
  const nasReading = gate.run('/data/nas/big', nasRead.call, { slow: true, background: true });
  await turnsUntil(() => started.includes('nas-read'));

  // The folder browser reads a NAS folder while the File Tree walks the
  // NAS: it waits for the walk's read, and gives up busy, while a file
  // opened meanwhile still goes beside the walk's read.
  const browsing = gate.run('/data/nas/scans', answering('browse'), { slow: true });
  assert.deepEqual(await gate.run('/data/nas/notes.md', answering('open')), { kind: 'done', value: 'open' });
  assert.deepEqual(await browsing, { kind: 'busy' });

  // With the turn beside taken by a file opened on the other share, beside
  // its own walk's read, a browse and then a file on the NAS wait for it:
  // once it is free, the file takes it, past the browse waiting ahead.
  const dataRead = heldCall(started, 'data-read');
  const dataReading = gate.run('/data/big', dataRead.call, { slow: true, background: true });
  await turnsUntil(() => started.includes('data-read'));
  const dataOpen = heldCall(started, 'data-open');
  const dataOpening = gate.run('/data/notes.md', dataOpen.call);
  await turnsUntil(() => started.includes('data-open'));
  const browsingAgain = gate.run('/data/nas/scans', answering('browse-again'), { slow: true });
  const nasOpening = gate.run('/data/nas/todo.md', answering('open-again'));
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(started.includes('open-again'), false);
  dataOpen.answer();
  assert.deepEqual(await dataOpening, { kind: 'done', value: 'data-open' });
  assert.deepEqual(await nasOpening, { kind: 'done', value: 'open-again' });
  assert.deepEqual(await browsingAgain, { kind: 'busy' });

  nasRead.answer();
  dataRead.answer();
  assert.deepEqual(await Promise.all([nasReading, dataReading]), [
    { kind: 'done', value: 'nas-read' },
    { kind: 'done', value: 'data-read' },
  ]);
  assert.deepEqual(started, ['nas', 'data', 'nas-read', 'open', 'data-read', 'data-open', 'open-again']);
});

test('a share not seen answering runs nothing beside a folder read in the background, and nothing runs beside a read the user waits for', { timeout: 5_000 }, async () => {
  const { gate, started, answering } = createTestGate();
  const read = heldCall(started, 'read');
  const reading = gate.run('/data/nas/big', read.call, { slow: true, background: true });
  await turnsUntil(() => started.includes('read'));
  assert.deepEqual(await gate.run('/data/nas/notes.md', answering('open')), { kind: 'busy' });
  read.answer();
  assert.deepEqual(await reading, { kind: 'done', value: 'read' });

  // Seen answering now, but a folder read for the folder browser is not a background one.
  const browse = heldCall(started, 'browse');
  const browsing = gate.run('/data/nas/big', browse.call, { slow: true });
  await turnsUntil(() => started.includes('browse'));
  assert.deepEqual(await gate.run('/data/nas/notes.md', answering('open')), { kind: 'busy' });
  browse.answer();
  assert.deepEqual(await browsing, { kind: 'done', value: 'browse' });
  assert.deepEqual(started, ['read', 'browse']);
});

test('a share that hangs during a folder read in the background keeps two calls at most, and the turn beside stays taken while it hangs', { timeout: 5_000 }, async () => {
  const { gate, started, answering, hanging, releaseAll } = createTestGate();
  assert.deepEqual(await gate.run('/data/nas/x', answering('nas')), { kind: 'done', value: 'nas' });
  assert.deepEqual(await gate.run('/data/x', answering('data')), { kind: 'done', value: 'data' });
  const reading = gate.run('/data/nas/big', hanging('read'), { slow: true, background: true });
  await turnsUntil(() => started.includes('read'));

  // The server went away: the call beside the read hangs too, and tells.
  assert.deepEqual(await gate.run('/data/nas/notes.md', hanging('open')), { kind: 'unreachable' });
  assert.deepEqual(await gate.run('/data/nas/other.md', answering('again')), { kind: 'unreachable' });
  assert.deepEqual(await gate.run('/data/nas/y', answering('lstat'), { background: true }), { kind: 'unreachable' });

  // Another share known to answer gets no call beside its own read while that one hangs.
  const dataRead = heldCall(started, 'data-read');
  const dataReading = gate.run('/data/big', dataRead.call, { slow: true, background: true });
  await turnsUntil(() => started.includes('data-read'));
  assert.deepEqual(await gate.run('/data/notes.md', answering('data-open')), { kind: 'busy' });
  dataRead.answer();
  assert.deepEqual(await dataReading, { kind: 'done', value: 'data-read' });

  assert.deepEqual(started, ['nas', 'data', 'read', 'open', 'data-read']);
  assert.deepEqual(await reading, { kind: 'unreachable' });
  await releaseAll();
});
