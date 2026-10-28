import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import type { WebSocket } from 'ws';

import {
  closeConnection,
  initializeDatabase,
  notificationPreferencesDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

import {
  registerDesktopNotificationClient,
  unregisterDesktopNotificationClient,
} from '../services/desktop-notification-clients.service.js';
import {
  buildNotificationPayload,
  notifyBackgroundWorkCompleted,
  notifyRunFailed,
  notifyRunStopped,
  setNotificationRunLookup,
} from '../services/notification-orchestrator.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'notification-orchestrator-'));
  const databasePath = path.join(temporaryDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

test('notification payload uses the app session id for a provider session id', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-session-1', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-session-1', 'claude-native-1');

    const payload = buildNotificationPayload({
      provider: 'claude',
      sessionId: 'claude-native-1',
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason: 'completed' },
    });

    assert.equal(payload.data.sessionId, 'app-session-1');
    assert.match(payload.data.tag, /app-session-1/);
  });
});

/** What a desktop app socket was sent: one frame per notification. */
type DesktopFrame = { payload: { data: { code: string; sessionId: string | null } } };

/**
 * A user whose notifications reach only a desktop app socket (Web Push off, so
 * nothing leaves the process), every event switch on, with the run lookup the
 * server entrypoint installs. Returns the frames the socket receives and a
 * cleanup that forgets the socket, the lookup and every registry run.
 */
function connectDesktopApp(username: string): { userId: number; frames: DesktopFrame[]; disconnect: () => void } {
  setNotificationRunLookup((sessionId) => chatRunRegistry.getRun(sessionId));
  const userId = Number(userDb.createUser(username, 'password-hash').id);
  notificationPreferencesDb.updatePreferences(userId, {
    channels: { webPush: false, desktop: true },
    events: { actionRequired: true, stop: true, error: true },
  });

  const frames: DesktopFrame[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (message: string) => {
      frames.push(JSON.parse(message) as DesktopFrame);
    },
    close: () => undefined,
  } as unknown as WebSocket;
  registerDesktopNotificationClient({ userId, deviceId: `${username}-device`, ws: socket });

  return {
    userId,
    frames,
    disconnect: () => {
      unregisterDesktopNotificationClient(socket);
      setNotificationRunLookup(() => null);
      chatRunRegistry.clearAll();
    },
  };
}

/**
 * Runs one registry turn of the session that starts at `startedAt` and ends, as
 * a runtime's run does before it reports. The tests that use it report without
 * naming the run, so the dedupe falls back to the run in the session's slot.
 */
function runTurn(appSessionId: string, startedAt: number, setNow: (value: number) => void, provider: 'claude' | 'codex' = 'claude'): void {
  setNow(startedAt);
  const run = chatRunRegistry.startRun({ appSessionId, provider, providerSessionId: null, connection: null, userId: null });
  assert.ok(run, 'the previous run of the session has ended');
  chatRunRegistry.completeRun(appSessionId, { exitCode: 0 });
}

/** Each notification the socket got, as `code@sessionId`. */
const delivered = (frames: DesktopFrame[]) => frames.map((frame) => `${frame.payload.data.code}@${frame.payload.data.sessionId}`);

/**
 * Starts a Cursor run of the session at `startedAt`. Cursor ends a run at its
 * `result` line but reports it only once the process closes, so the session's
 * next run can start before the report; the tests end runs with `completeRun`
 * and report them separately, naming each by its writer as the runtimes do.
 */
function startCursorRun(appSessionId: string, startedAt: number, setNow: (value: number) => void) {
  setNow(startedAt);
  const run = chatRunRegistry.startRun({ appSessionId, provider: 'cursor', providerSessionId: null, connection: null, userId: null });
  assert.ok(run, 'the previous run of the session has ended');
  return run;
}

test('a second run of a session that stops inside the dedupe window is notified; repeats for one run are not', async () => {
  await withIsolatedDatabase(() => {
    let now = 1_000_000;
    const clock = mock.method(Date, 'now', () => now);
    const { userId, frames, disconnect } = connectDesktopApp('dedupe-stop');
    const setNow = (value: number) => { now = value; };
    try {
      const report = () => notifyRunStopped({ userId, provider: 'claude', sessionId: 'queued-session', stopReason: 'completed' });

      runTurn('queued-session', 1_000_000, setNow);
      report();
      report();
      assert.deepEqual(delivered(frames), ['run.stopped@queued-session']);

      // The queued message's run ends 5 s later, well inside the 20 s window.
      runTurn('queued-session', 1_005_000, setNow);
      report();
      report();
      assert.deepEqual(delivered(frames), ['run.stopped@queued-session', 'run.stopped@queued-session']);
    } finally {
      disconnect();
      clock.mock.restore();
    }
  });
});

test('failures and finished background work collapse per run too', async () => {
  await withIsolatedDatabase(() => {
    let now = 2_000_000;
    const clock = mock.method(Date, 'now', () => now);
    const { userId, frames, disconnect } = connectDesktopApp('dedupe-failed');
    const setNow = (value: number) => { now = value; };
    try {
      const fail = () => notifyRunFailed({ userId, provider: 'claude', sessionId: 'retried-session', error: 'Rate limited' });
      const finishBackground = () => notifyBackgroundWorkCompleted({ userId, provider: 'claude', sessionId: 'retried-session' });

      runTurn('retried-session', 2_000_000, setNow);
      fail();
      fail();
      finishBackground();
      finishBackground();
      // The same error from the next run, 3 s later.
      runTurn('retried-session', 2_003_000, setNow);
      fail();
      finishBackground();

      assert.deepEqual(delivered(frames), [
        'run.failed@retried-session',
        'run.background_completed@retried-session',
        'run.failed@retried-session',
        'run.background_completed@retried-session',
      ]);
    } finally {
      disconnect();
      clock.mock.restore();
    }
  });
});

test('without a run of the reporting provider, a session\'s repeats inside the window still collapse', async () => {
  await withIsolatedDatabase(() => {
    let now = 3_000_000;
    const clock = mock.method(Date, 'now', () => now);
    const { userId, frames, disconnect } = connectDesktopApp('dedupe-unregistered');
    try {
      const report = () => notifyRunStopped({ userId, provider: 'claude', sessionId: 'unregistered-session', stopReason: 'completed' });

      report();
      now += 1_000;
      report();
      // A run of another provider in the session's slot is not the run reported.
      runTurn('unregistered-session', now + 1_000, (value) => { now = value; }, 'codex');
      report();

      assert.deepEqual(delivered(frames), ['run.stopped@unregistered-session']);
    } finally {
      disconnect();
      clock.mock.restore();
    }
  });
});

test('a run reported after the session\'s next run started is notified, and so is that next run', async () => {
  await withIsolatedDatabase(() => {
    let now = 4_000_000;
    const clock = mock.method(Date, 'now', () => now);
    const { userId, frames, disconnect } = connectDesktopApp('dedupe-late-report');
    const setNow = (value: number) => { now = value; };
    try {
      const report = (run: ReturnType<typeof startCursorRun>) => notifyRunStopped({
        userId, provider: 'cursor', sessionId: 'late-session', stopReason: 'completed', runStartedAt: run.writer.runStartedAt,
      });

      const first = startCursorRun('late-session', 4_000_000, setNow);
      chatRunRegistry.completeRun('late-session', { exitCode: 0 });
      // The next run starts while the first run's process is still closing.
      const second = startCursorRun('late-session', 4_000_300, setNow);
      report(first);
      // The next run ends 8 s later, inside the window of the first report.
      setNow(4_008_300);
      chatRunRegistry.completeRun('late-session', { exitCode: 0 });
      report(second);
      report(second);

      assert.deepEqual(delivered(frames), ['run.stopped@late-session', 'run.stopped@late-session']);
    } finally {
      disconnect();
      clock.mock.restore();
    }
  });
});

test('a run reported only after the session\'s next run ended and reported is notified too', async () => {
  await withIsolatedDatabase(() => {
    let now = 5_000_000;
    const clock = mock.method(Date, 'now', () => now);
    const { userId, frames, disconnect } = connectDesktopApp('dedupe-last-report');
    const setNow = (value: number) => { now = value; };
    try {
      const report = (run: ReturnType<typeof startCursorRun>) => notifyRunStopped({
        userId, provider: 'cursor', sessionId: 'slow-report-session', stopReason: 'completed', runStartedAt: run.writer.runStartedAt,
      });

      const first = startCursorRun('slow-report-session', 5_000_000, setNow);
      chatRunRegistry.completeRun('slow-report-session', { exitCode: 0 });
      const second = startCursorRun('slow-report-session', 5_000_300, setNow);
      setNow(5_002_000);
      chatRunRegistry.completeRun('slow-report-session', { exitCode: 0 });
      report(second);
      // The first run's process closes only now.
      setNow(5_003_000);
      report(first);

      assert.deepEqual(delivered(frames), ['run.stopped@slow-report-session', 'run.stopped@slow-report-session']);
    } finally {
      disconnect();
      clock.mock.restore();
    }
  });
});

test('late failures and finished background work are named by their own run too', async () => {
  await withIsolatedDatabase(() => {
    let now = 6_000_000;
    const clock = mock.method(Date, 'now', () => now);
    const { userId, frames, disconnect } = connectDesktopApp('dedupe-late-failed');
    const setNow = (value: number) => { now = value; };
    try {
      const fail = (run: ReturnType<typeof startCursorRun>) => notifyRunFailed({
        userId, provider: 'cursor', sessionId: 'late-failed-session', error: 'Rate limited', runStartedAt: run.writer.runStartedAt,
      });
      const finishBackground = (run: ReturnType<typeof startCursorRun>) => notifyBackgroundWorkCompleted({
        userId, provider: 'cursor', sessionId: 'late-failed-session', runStartedAt: run.writer.runStartedAt,
      });

      const first = startCursorRun('late-failed-session', 6_000_000, setNow);
      chatRunRegistry.completeRun('late-failed-session', { exitCode: 1 });
      const second = startCursorRun('late-failed-session', 6_000_300, setNow);
      fail(first);
      finishBackground(first);
      setNow(6_003_000);
      chatRunRegistry.completeRun('late-failed-session', { exitCode: 1 });
      fail(second);
      finishBackground(second);
      fail(second);

      assert.deepEqual(delivered(frames), [
        'run.failed@late-failed-session',
        'run.background_completed@late-failed-session',
        'run.failed@late-failed-session',
        'run.background_completed@late-failed-session',
      ]);
    } finally {
      disconnect();
      clock.mock.restore();
    }
  });
});
