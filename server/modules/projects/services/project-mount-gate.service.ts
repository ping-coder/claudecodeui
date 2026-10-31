import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { MachineMountPoint, MountCall, MountCallOutcome } from '@/shared/types.js';
import { normalizeProjectPath } from '@/shared/utils.js';

// On a hard-mounted network share whose server is gone, filesystem calls hang
// in the kernel and never return. Node runs them on libuv's threadpool (4
// threads unless UV_THREADPOOL_SIZE says otherwise), and a hung call keeps its
// thread: a time limit cannot give it back. Every call the mounts make into a
// target on such a share therefore goes through this gate, which keeps a
// share that hangs to one thread and never lets hung calls take the threads
// the rest of the server needs, while the other shares go on answering.

// A share whose call timed out gets no new call for this long after, so the
// listings that follow answer at once.
const UNREACHABLE_SHARE_RETRY_MS = 30_000;

// A share whose call answered in time this recently is known to answer. A
// share that is not (never tried, or not lately) gets a call only while
// fewer than MAXIMUM_UNPROVEN_CALLS such calls run, so folders on shares
// nobody has tried yet (a browse through links into dead shares, a start
// while several are down) can never hold more than that many threads
// between them.
const PROVEN_SHARE_MS = 10 * 60_000;
const MAXIMUM_UNPROVEN_CALLS = 2;

// A whole folder read in the background (the File Tree's walk of a mount)
// can hold its share's turn for many seconds on a big folder. A short call
// someone waits for on a share known to answer does not wait that out: it
// runs beside the read, so the share then has two calls going, and if the
// share hangs right then, both keep their thread. That is never more than
// two threads for one share, and this many such calls for the whole server
// at a time, so shares that hang together take at most one thread more than
// one call each would. A folder read someone waits for (the folder browser's)
// never runs beside: it would hold the turn beside for as long as its folder
// is big, and a file opened meanwhile on any share a walk holds would find no
// turn, and come back busy.
const MAXIMUM_CALLS_BESIDE_BACKGROUND = 1;

// Filesystems of a local disk or of memory. Their calls answer, or fail, in
// time: it is a network share (nfs, cifs, a FUSE filesystem such as sshfs)
// whose calls hang for as long as its server is gone. Calls on one of these
// bypass the gate: a slow disk (spinning up, busy copying) never reads as
// unreachable, and never waits behind dead network shares.
const LOCAL_FILESYSTEM_TYPES = new Set([
  'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'jfs', 'reiserfs', 'bcachefs', 'nilfs2',
  'tmpfs', 'ramfs', 'overlay', 'vfat', 'msdos', 'exfat', 'ntfs3', 'hfs', 'hfsplus', 'iso9660', 'udf',
  'squashfs', 'erofs',
]);

// The machine's mount points are read again after this long, so a share
// mounted meanwhile gets a place of its own.
const MOUNT_POINTS_TTL_MS = 10_000;

const TIMED_OUT = Symbol('timed out');

type MountGateDependencies = {
  /**
   * The mount points of this machine, or null where they cannot be read (not
   * Linux): then a share is guessed from the path (see fallbackShareOf), and
   * none is taken for a local disk's, so every call is gated.
   */
  listMountPoints(): Promise<MachineMountPoint[] | null>;
  /** How long a call may take before its share counts as not answering. */
  timeoutMs: number;
  /** The same for a slow call (see run), which takes as long as a folder is big. */
  slowCallTimeoutMs: number;
  /** Milliseconds on a clock that never goes back. */
  monotonicNow(): number;
  logWarning(message: string): void;
};

/**
 * Why a wait for a slot ended. `rejected`: the share stopped answering
 * meanwhile. `beside`: the call runs beside the one holding the slot, on a
 * turn of its own (see mayRunBesideBackground).
 */
type SlotTurn = 'acquired' | 'timeout' | 'aborted' | 'rejected' | 'beside';

/**
 * Who a call is for. `interactive`: someone waits for it (a file opened,
 * read or saved, a probe, the folder browser). `background`: one of the many
 * calls of a walk, which nobody waits for one by one. An interactive call
 * gets its turn before every background call that waits.
 */
type CallPriority = 'interactive' | 'background';

/** `slow`: a whole folder read (see run), which never takes a turn beside a background call. */
type SlotWaiter = { priority: CallPriority; slow: boolean; settle(turn: SlotTurn): void };

type SlotPool = {
  /** Takes a free slot at once, when one is free and nobody waits ahead; never waits. */
  tryAcquire(priority?: CallPriority): boolean;
  acquire(waitMs: number, signal?: AbortSignal, priority?: CallPriority, slow?: boolean): Promise<SlotTurn>;
  release(): void;
  rejectWaiting(): void;
  /** Settles the first interactive waiter that is not slow with `beside`; false when none waits. */
  passBeside(): boolean;
};

type ShareState = {
  slot: SlotPool;
  /** Whether the call holding the slot is a whole folder read in the background (see MAXIMUM_CALLS_BESIDE_BACKGROUND). */
  slotHeldBySlowBackgroundCall: boolean;
  /** Calls of this share that did not answer in time and have not answered since. */
  hungCalls: number;
  /** No new call before this time (monotonic), after a call timed out. */
  retryAt: number;
  /** When a call last answered in time (monotonic), or null. */
  answeredAt: number | null;
};

/** The share a path is on: its mount point (or a guess, see fallbackShareOf), and whether that is a local disk's. */
type ShareLocation = { share: string; local: boolean };

/**
 * A pool of `capacity` slots handed out first come, first served, except
 * that interactive waiters go before background ones. A waiter gives up
 * after `waitMs`, when its signal aborts, or when the pool rejects every
 * waiter at once.
 */
function createSlotPool(capacity: number): SlotPool {
  let used = 0;
  // Interactive waiters first, then background ones, each in the order they came.
  const waiters: SlotWaiter[] = [];

  /** Whether a call of `priority` has to let a waiter go first. */
  function hasWaiterAhead(priority: CallPriority): boolean {
    return priority === 'background' ? waiters.length > 0 : waiters[0]?.priority === 'interactive';
  }

  return {
    tryAcquire(priority = 'interactive') {
      if (used < capacity && !hasWaiterAhead(priority)) {
        used += 1;
        return true;
      }
      return false;
    },
    acquire(waitMs, signal, priority = 'interactive', slow = false) {
      if (signal?.aborted) {
        return Promise.resolve('aborted');
      }
      if (used < capacity && !hasWaiterAhead(priority)) {
        used += 1;
        return Promise.resolve('acquired');
      }
      return new Promise<SlotTurn>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const onAbort = () => waiter.settle('aborted');
        const waiter: SlotWaiter = {
          priority,
          slow,
          settle(turn) {
            const index = waiters.indexOf(waiter);
            if (index === -1) {
              return;
            }
            waiters.splice(index, 1);
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(turn);
          },
        };
        const firstBackgroundWaiter = priority === 'interactive'
          ? waiters.findIndex((other) => other.priority === 'background')
          : -1;
        if (firstBackgroundWaiter === -1) {
          waiters.push(waiter);
        } else {
          waiters.splice(firstBackgroundWaiter, 0, waiter);
        }
        timer = setTimeout(() => waiter.settle('timeout'), waitMs);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    release() {
      const next = waiters[0];
      if (next) {
        // The slot passes on as it is: `used` stays.
        next.settle('acquired');
      } else {
        used = Math.max(0, used - 1);
      }
    },
    rejectWaiting() {
      for (const waiter of [...waiters]) {
        waiter.settle('rejected');
      }
    },
    passBeside() {
      // A slow waiter is passed over: it waits for the slot itself.
      const next = waiters.find((waiter) => waiter.priority === 'interactive' && !waiter.slow);
      if (!next) {
        return false;
      }
      next.settle('beside');
      return true;
    },
  };
}

/** Settles with `promise`, or with TIMED_OUT once `timeoutMs` has passed. */
function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A mount point as /proc/self/mountinfo writes it: space, tab, newline and backslash as octal escapes. */
function unescapeMountPoint(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/**
 * The mount points listed in /proc/self/mountinfo, each with whether its
 * filesystem is a local disk's (by the type after the ` - ` separator), or
 * null where there is none to read. Reading it asks the kernel, never a
 * share, so it cannot hang on one. The default `listMountPoints` of the
 * mounts service's gate (project-mounts.service.ts).
 */
export async function readMachineMountPoints(): Promise<MachineMountPoint[] | null> {
  if (process.platform !== 'linux') {
    return null;
  }
  try {
    const mountInfo = await fs.readFile('/proc/self/mountinfo', 'utf8');
    const mountPoints = mountInfo
      .split('\n')
      .flatMap((line): MachineMountPoint[] => {
        // ID, parent ID, device, root, mount point, options, optional
        // fields, then `-`, the filesystem type, the source and its options.
        const fields = line.split(' ');
        const mountPoint = fields[4];
        if (!mountPoint) {
          return [];
        }
        const separator = fields.indexOf('-', 6);
        const fileSystemType = separator === -1 ? '' : fields[separator + 1] ?? '';
        return [{ path: unescapeMountPoint(mountPoint), local: LOCAL_FILESYSTEM_TYPES.has(fileSystemType) }];
      });
    return mountPoints.length > 0 ? mountPoints : null;
  } catch {
    return null;
  }
}

/**
 * The share of `candidatePath` where the mount points are unknown: the drive
 * or UNC share on Windows, the volume under /Volumes on macOS, otherwise the
 * top folder (/mnt, /data, /media), where other disks are usually mounted.
 */
function fallbackShareOf(candidatePath: string): string {
  const { root } = path.parse(candidatePath);
  if (process.platform === 'win32') {
    return root.toLowerCase();
  }
  const [first, second] = path.relative(root, candidatePath).split(path.sep);
  if (process.platform === 'darwin' && first === 'Volumes' && second) {
    return path.join(root, first, second);
  }
  return first ? path.join(root, first) : root;
}

function isSameOrInside(candidatePath: string, parentPath: string): boolean {
  return candidatePath === parentPath
    || candidatePath.startsWith(parentPath.endsWith(path.sep) ? parentPath : `${parentPath}${path.sep}`);
}

/**
 * Creates the gate the projects module's mounts service
 * (project-mounts.service.ts) runs every call into a mount's target through:
 * its target probes, and through the barrel the File Tree's reads and walks
 * in a mount. The production mounts service holds the one instance the whole
 * server shares, so what it learns about a share holds for every caller.
 *
 * - Calls are grouped by share: the mount point the path is on (its longest
 *   mount point), so a share mounted inside a target is a share of its own.
 * - A call on a local disk's filesystem (see LOCAL_FILESYSTEM_TYPES) runs at
 *   once, outside every rule below: no time limit, no turn to wait for, and
 *   its disk never reads as unreachable. Only network shares, FUSE and
 *   filesystems of unknown type are gated.
 * - A share runs one call at a time, so a share that hangs keeps one thread.
 * - A call that has not answered in time marks its share as not answering:
 *   while it hangs, and for UNREACHABLE_SHARE_RETRY_MS after it timed out,
 *   new calls on that share come back `unreachable` at once. `retryNow` (a
 *   user asking to mount or repair) skips the wait after the time-out, but
 *   never starts a call beside one that hangs.
 * - A slow call (reading every name in a folder, which takes as long as the
 *   folder is big) has the slow call time limit instead, so a big folder on
 *   a share that answers never makes the share read as unreachable. It
 *   holds its share's turn all along, keeping a share that hangs to one
 *   thread; the calls behind it wait, and come back busy.
 * - A call waits for its share's turn at most the time limit, then comes
 *   back `busy`; so does a call whose signal aborts while it waits.
 * - A background call (`background`: the File Tree's walk of a mount, many
 *   calls nobody waits for one by one) waits behind every interactive call,
 *   so a file the user opens or saves never queues behind a walk's calls,
 *   only behind the one call running. On a share known to answer, an
 *   interactive call that is not slow does not wait for a whole folder read
 *   in the background either: it runs beside it (see
 *   MAXIMUM_CALLS_BESIDE_BACKGROUND).
 * - Calls on shares not known to answer lately share MAXIMUM_UNPROVEN_CALLS
 *   slots (see PROVEN_SHARE_MS).
 */
export function createMountGate(dependencies: MountGateDependencies) {
  const shares = new Map<string, ShareState>();
  const unprovenSlots = createSlotPool(MAXIMUM_UNPROVEN_CALLS);
  // Taken at once or not at all: a call that finds none free waits for its share's turn.
  const besideSlots = createSlotPool(MAXIMUM_CALLS_BESIDE_BACKGROUND);
  let mountPoints: { list: MachineMountPoint[] | null; readAt: number } | null = null;
  let mountPointsRead: Promise<MachineMountPoint[] | null> | null = null;

  async function readMountPoints(): Promise<MachineMountPoint[] | null> {
    const now = dependencies.monotonicNow();
    if (mountPoints && now - mountPoints.readAt < MOUNT_POINTS_TTL_MS) {
      return mountPoints.list;
    }
    mountPointsRead ??= dependencies.listMountPoints()
      .catch(() => null)
      .then((list) => {
        // One entry per mount point, the last one mounted there (it covers
        // the ones before it), longest first, so the first one that holds a
        // path is its own.
        const byPath = new Map<string, MachineMountPoint>();
        for (const mountPoint of list ?? []) {
          const normalizedPath = normalizeProjectPath(mountPoint.path);
          if (normalizedPath) {
            byPath.delete(normalizedPath);
            byPath.set(normalizedPath, { path: normalizedPath, local: mountPoint.local });
          }
        }
        const sorted = list
          ? [...byPath.values()].sort((left, right) => right.path.length - left.path.length)
          : null;
        mountPoints = { list: sorted, readAt: dependencies.monotonicNow() };
        return sorted;
      })
      .finally(() => {
        mountPointsRead = null;
      });
    return mountPointsRead;
  }

  async function locateShare(locationPath: string): Promise<ShareLocation> {
    const normalizedPath = normalizeProjectPath(path.resolve(locationPath));
    const points = await readMountPoints();
    const mountPoint = points?.find((point) => isSameOrInside(normalizedPath, point.path));
    return mountPoint
      ? { share: mountPoint.path, local: mountPoint.local }
      : { share: fallbackShareOf(normalizedPath), local: false };
  }

  function shareState(share: string): ShareState {
    let state = shares.get(share);
    if (!state) {
      state = { slot: createSlotPool(1), slotHeldBySlowBackgroundCall: false, hungCalls: 0, retryAt: 0, answeredAt: null };
      shares.set(share, state);
    }
    return state;
  }

  function isProven(state: ShareState, now: number): boolean {
    return state.answeredAt !== null && now - state.answeredAt < PROVEN_SHARE_MS;
  }

  /** Whether calls on the share come back `unreachable` without being started (see run). */
  function isShareUnreachable(state: ShareState, retryNow: boolean): boolean {
    return state.hungCalls > 0 || (!retryNow && dependencies.monotonicNow() < state.retryAt);
  }

  /**
   * Whether an interactive call that is not slow, finding its share's slot
   * taken, may run beside the call holding it, on one of the
   * MAXIMUM_CALLS_BESIDE_BACKGROUND turns: while a whole folder read in the
   * background holds the slot of a share known to answer. A share not known
   * to answer may be one that hangs, and would keep both threads. Behind a
   * background call that reads one entry an interactive call waits for that
   * call alone, as it goes before the rest.
   */
  function mayRunBesideBackground(state: ShareState): boolean {
    return state.slotHeldBySlowBackgroundCall && isProven(state, dependencies.monotonicNow());
  }

  /**
   * Hands a turn beside a background call, once one is free, to the first
   * interactive call that is not slow waiting on a share where it may run
   * beside (see mayRunBesideBackground), so a second click on a share does
   * not wait out its folder read just because the first one took the turn.
   */
  function passBesideTurn(): void {
    for (const state of shares.values()) {
      if (!mayRunBesideBackground(state)) {
        continue;
      }
      if (!besideSlots.tryAcquire() || state.slot.passBeside()) {
        return;
      }
      besideSlots.release();
    }
  }

  return {
    /**
     * The share `locationPath` is on, which decides which calls wait for
     * one another. The mounts service follows a target's links while they
     * stay on one share, to probe the target on the share it lands on.
     */
    async shareOf(locationPath: string): Promise<string> {
      return (await locateShare(locationPath)).share;
    },

    /**
     * Whether a call on `locationPath` would come back `unreachable` now: its
     * share has a call that never answered, or one timed out lately; never
     * on a local disk. For a caller about to make a call there that cannot
     * go through the gate (a realpath that may land anywhere), which a hung
     * share would hang too.
     */
    async isUnreachable(locationPath: string): Promise<boolean> {
      const { share, local } = await locateShare(locationPath);
      const state = local ? undefined : shares.get(share);
      return state !== undefined && isShareUnreachable(state, false);
    },

    /**
     * Runs `operation`, a filesystem call on `locationPath` (where it really
     * is, links resolved as far as known), under the rules above, and tells
     * it whether it is gated (see `MountCall`). A call is interactive unless
     * `background` says it is one of a walk's (see CallPriority).
     */
    async run<T>(
      locationPath: string,
      operation: (call: MountCall) => Promise<T>,
      options: { retryNow?: boolean; signal?: AbortSignal; slow?: boolean; background?: boolean } = {},
    ): Promise<MountCallOutcome<T>> {
      const { share, local } = await locateShare(locationPath);
      if (local) {
        try {
          return { kind: 'done', value: await operation({ gated: false }) };
        } catch (error) {
          return { kind: 'failed', error };
        }
      }
      const state = shareState(share);
      const isUnreachable = () => isShareUnreachable(state, options.retryNow === true);
      if (isUnreachable()) {
        return { kind: 'unreachable' };
      }
      const priority: CallPriority = options.background === true ? 'background' : 'interactive';

      // A free slot is taken without a turn of the event loop, so a call
      // starts its time limit before any call that comes after it starts
      // waiting: one that waits behind a call that hangs is then told the
      // share is unreachable, rather than give up first and come back busy,
      // which would say nothing about the share. Behind a slow call it does
      // give up first, and comes back busy, unless it may run beside it.
      let turn: SlotTurn;
      if (!options.signal?.aborted && state.slot.tryAcquire(priority)) {
        turn = 'acquired';
      } else if (
        !options.signal?.aborted
        && priority === 'interactive'
        && options.slow !== true
        && mayRunBesideBackground(state)
        && besideSlots.tryAcquire()
      ) {
        turn = 'beside';
      } else {
        turn = await state.slot.acquire(dependencies.timeoutMs, options.signal, priority, options.slow === true);
      }
      if (turn === 'rejected') {
        return { kind: 'unreachable' };
      }
      if (turn !== 'acquired' && turn !== 'beside') {
        return { kind: 'busy' };
      }
      const runsBesideBackground = turn === 'beside';
      const releaseTurn = () => {
        if (runsBesideBackground) {
          besideSlots.release();
          passBesideTurn();
        } else {
          state.slotHeldBySlowBackgroundCall = false;
          state.slot.release();
        }
      };
      // The share may have stopped answering while this call waited.
      if (isUnreachable()) {
        releaseTurn();
        return { kind: 'unreachable' };
      }
      let holdsUnprovenSlot = false;
      // A call beside a background one runs on a share known to answer only.
      if (!runsBesideBackground && !isProven(state, dependencies.monotonicNow())) {
        const unprovenTurn = !options.signal?.aborted && unprovenSlots.tryAcquire(priority)
          ? 'acquired'
          : await unprovenSlots.acquire(dependencies.timeoutMs, options.signal, priority);
        if (unprovenTurn !== 'acquired') {
          releaseTurn();
          return { kind: 'busy' };
        }
        holdsUnprovenSlot = true;
      }
      const releaseSlots = () => {
        if (holdsUnprovenSlot) {
          unprovenSlots.release();
        }
        releaseTurn();
      };
      if (!runsBesideBackground) {
        state.slotHeldBySlowBackgroundCall = priority === 'background' && options.slow === true;
      }

      let call: Promise<MountCallOutcome<T>>;
      try {
        call = operation({ gated: true }).then(
          (value): MountCallOutcome<T> => ({ kind: 'done', value }),
          (error: unknown): MountCallOutcome<T> => ({ kind: 'failed', error }),
        );
      } catch (error) {
        releaseSlots();
        return { kind: 'failed', error };
      }
      const outcome = await settleWithin(
        call,
        options.slow === true ? dependencies.slowCallTimeoutMs : dependencies.timeoutMs,
      );
      if (outcome !== TIMED_OUT) {
        state.answeredAt = dependencies.monotonicNow();
        releaseSlots();
        return outcome;
      }

      // The call keeps its thread, and so its slots, until it answers.
      if (state.hungCalls === 0) {
        dependencies.logWarning(`[project-mounts] ${share} did not answer in time; treating it as unreachable`);
      }
      state.hungCalls += 1;
      state.retryAt = dependencies.monotonicNow() + UNREACHABLE_SHARE_RETRY_MS;
      state.slot.rejectWaiting();
      void call.finally(() => {
        state.hungCalls -= 1;
        releaseSlots();
      });
      return { kind: 'unreachable' };
    },
  };
}

