import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import type { WebSocket } from 'ws';

import {
  closeConnection,
  initializeDatabase,
  notificationPreferencesDb,
  pushSubscriptionsDb,
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
  sendTestWebPush,
  setNotificationRunLookup,
} from '../services/notification-orchestrator.service.js';

// The orchestrator's own web-push instance (one module cache for import and require), stubbed per
// test so nothing leaves the process. The package ships no type declarations.
const webPush = createRequire(import.meta.url)('web-push') as {
  sendNotification: (subscription: { endpoint: string }, payload: string, options?: unknown) => Promise<unknown>;
};

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

/** The error web-push rejects with when a push service answers outside 2xx. */
const pushServiceError = (statusCode: number, body: string) => Object.assign(new Error('Received unexpected response code'), {
  name: 'WebPushError',
  statusCode,
  body,
  headers: {},
});

/** A user with Web Push on for every event and one stored subscription per endpoint given. */
function pushUser(username: string, endpoints: string[]): number {
  const userId = Number(userDb.createUser(username, 'password-hash').id);
  notificationPreferencesDb.updatePreferences(userId, {
    channels: { webPush: true, desktop: false },
    events: { actionRequired: true, stop: true, error: true },
  });
  for (const endpoint of endpoints) {
    pushSubscriptionsDb.saveSubscription(userId, endpoint, 'p256dh-key', 'auth-key');
  }
  return userId;
}

const storedEndpoints = (userId: number) => pushSubscriptionsDb.getSubscriptions(userId).map((row) => row.endpoint).sort();

test('the test push goes to the one endpoint named, of this user only, and returns the push service\'s answer', async () => {
  await withIsolatedDatabase(async () => {
    const userId = pushUser('push-test-owner', ['https://fcm.googleapis.com/fcm/send/mine', 'https://fcm.googleapis.com/fcm/send/second']);
    pushUser('push-test-other', ['https://fcm.googleapis.com/fcm/send/theirs']);
    const sent: Array<{ endpoint: string; payload: unknown; options: unknown }> = [];
    const send = mock.method(webPush, 'sendNotification', async (subscription: { endpoint: string }, payload: string, options: unknown) => {
      sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload), options });
      return { statusCode: 201, body: '', headers: {} };
    });
    try {
      const delivery = await sendTestWebPush({ userId, endpoint: 'https://fcm.googleapis.com/fcm/send/mine', title: 'CloudCLI test', body: 'Through push' });

      assert.deepEqual(delivery, { accepted: true, statusCode: 201, host: 'fcm.googleapis.com' });
      assert.deepEqual(sent, [{
        endpoint: 'https://fcm.googleapis.com/fcm/send/mine',
        payload: {
          title: 'CloudCLI test',
          body: 'Through push',
          data: { sessionId: null, provider: null, code: 'push.test', tag: 'cloudcli:test:push' },
        },
        // A push service that never answers fails the send instead of holding it forever.
        options: { timeout: 10_000 },
      }]);

      assert.equal(await sendTestWebPush({ userId, endpoint: 'https://fcm.googleapis.com/fcm/send/theirs', title: 't', body: 'b' }), null);
      assert.equal(await sendTestWebPush({ userId, endpoint: 'https://fcm.googleapis.com/fcm/send/unknown', title: 't', body: 'b' }), null);
      assert.equal(sent.length, 1);
    } finally {
      send.mock.restore();
    }
  });
});

test('a failed push is logged with the push service host and status, never the endpoint; gone and mismatched subscriptions are dropped', async () => {
  await withIsolatedDatabase(async () => {
    const endpoints = {
      gone: 'https://gone.push.example/send/secret-gone',
      mismatch: 'https://fcm.googleapis.com/fcm/send/secret-mismatch',
      appleMismatch: 'https://web.push.apple.com/secret-apple',
      badToken: 'https://forbidden.push.example/send/secret-forbidden',
      unreachable: 'https://unreachable.push.example/send/secret-unreachable',
    };
    const userId = pushUser('push-failures', Object.values(endpoints));
    const answers: Record<string, () => never> = {
      [endpoints.gone]: () => { throw pushServiceError(410, 'push subscription has unsubscribed or expired.\n'); },
      [endpoints.mismatch]: () => {
        throw pushServiceError(403, 'the VAPID credentials in the authorization header do not correspond to the credentials used to create the subscriptions.\n');
      },
      [endpoints.appleMismatch]: () => { throw pushServiceError(403, '{"reason":"VapidPkHashMismatch"}'); },
      [endpoints.badToken]: () => { throw pushServiceError(403, '{"reason":"BadJwtToken"}'); },
      [endpoints.unreachable]: () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); },
    };
    const send = mock.method(webPush, 'sendNotification', async (subscription: { endpoint: string }) => answers[subscription.endpoint]());
    const warn = mock.method(console, 'warn', () => undefined);
    try {
      const results = [];
      for (const endpoint of Object.values(endpoints)) {
        results.push(await sendTestWebPush({ userId, endpoint, title: 't', body: 'b' }));
      }

      assert.deepEqual(results.map((result) => [result?.accepted, result?.statusCode, result?.dropped]), [
        [false, 410, true],
        [false, 403, true],
        [false, 403, true],
        [false, 403, false],
        [false, null, false],
      ]);
      assert.deepEqual(storedEndpoints(userId), [endpoints.badToken, endpoints.unreachable].sort());

      const lines = warn.mock.calls.map((call) => String(call.arguments[0]));
      assert.deepEqual(lines, [
        '[web-push] push to gone.push.example failed: 410 "push subscription has unsubscribed or expired."; subscription dropped',
        '[web-push] push to fcm.googleapis.com failed: 403 "the VAPID credentials in the authorization header do not correspond to the credentials used to create the subscriptions."; subscription dropped',
        '[web-push] push to web.push.apple.com failed: 403 "{\\"reason\\":\\"VapidPkHashMismatch\\"}"; subscription dropped',
        '[web-push] push to forbidden.push.example failed: 403 "{\\"reason\\":\\"BadJwtToken\\"}"',
        '[web-push] push to unreachable.push.example failed: no answer (ECONNREFUSED)',
      ]);
      assert.equal(lines.some((line) => line.includes('secret')), false);
    } finally {
      send.mock.restore();
      warn.mock.restore();
    }
  });
});

test('repeated failures of one push service and status are logged once per 10 minutes, with a count of the rest', async () => {
  await withIsolatedDatabase(async () => {
    let now = 5_000_000;
    const clock = mock.method(Date, 'now', () => now);
    const endpoint = 'https://busy.push.example/send/one';
    const userId = pushUser('push-busy', [endpoint]);
    const send = mock.method(webPush, 'sendNotification', async () => { throw pushServiceError(429, 'slow down'); });
    const warn = mock.method(console, 'warn', () => undefined);
    try {
      for (let index = 0; index < 3; index += 1) {
        await sendTestWebPush({ userId, endpoint, title: 't', body: 'b' });
        now += 60_000;
      }
      assert.equal(warn.mock.callCount(), 1);

      now += 10 * 60_000;
      await sendTestWebPush({ userId, endpoint, title: 't', body: 'b' });
      assert.deepEqual(warn.mock.calls.map((call) => call.arguments[0]), [
        '[web-push] push to busy.push.example failed: 429 "slow down"',
        '[web-push] push to busy.push.example failed: 429 "slow down"; 2 more like it since the last line',
      ]);
      // Neither gone nor mismatched: the subscription stays.
      assert.deepEqual(storedEndpoints(userId), [endpoint]);
    } finally {
      clock.mock.restore();
      send.mock.restore();
      warn.mock.restore();
    }
  });
});

test('a push service that never answers fails the push after 10 seconds in all, whatever the socket does', async () => {
  await withIsolatedDatabase(async () => {
    const endpoint = 'https://silent.push.example/send/secret-silent';
    const userId = pushUser('push-silent', [endpoint]);
    // Never settles, as a send does whose push service trickles its answer
    // and so never leaves the socket idle long enough for web-push's timeout.
    const send = mock.method(webPush, 'sendNotification', () => new Promise(() => {}));
    const warn = mock.method(console, 'warn', () => undefined);
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let settled = false;
      const delivery = sendTestWebPush({ userId, endpoint, title: 't', body: 'b' });
      void delivery.then(() => {
        settled = true;
      });
      mock.timers.tick(9_999);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);

      mock.timers.tick(1);
      assert.deepEqual(await delivery, {
        accepted: false,
        statusCode: null,
        host: 'silent.push.example',
        detail: 'timeout',
        dropped: false,
      });
      assert.deepEqual(warn.mock.calls.map((call) => call.arguments[0]), [
        '[web-push] push to silent.push.example failed: no answer (timeout)',
      ]);
      // Not answering says nothing about the subscription: it stays.
      assert.deepEqual(storedEndpoints(userId), [endpoint]);
    } finally {
      mock.timers.reset();
      send.mock.restore();
      warn.mock.restore();
    }
  });
});

test('a finished run\'s push that the push service calls gone is logged and its subscription dropped', async () => {
  await withIsolatedDatabase(async () => {
    const userId = pushUser('push-run-end', ['https://expired.push.example/send/run', 'https://fcm.googleapis.com/fcm/send/alive']);
    const sent: string[] = [];
    const send = mock.method(webPush, 'sendNotification', async (subscription: { endpoint: string }) => {
      sent.push(subscription.endpoint);
      if (subscription.endpoint.includes('expired')) {
        throw pushServiceError(410, 'expired');
      }
      return { statusCode: 201 };
    });
    const warn = mock.method(console, 'warn', () => undefined);
    try {
      notifyRunStopped({ userId, provider: 'claude', sessionId: 'push-run-end-session', runStartedAt: 42 });
      for (let tick = 0; tick < 20 && storedEndpoints(userId).length > 1; tick += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      assert.deepEqual(sent.sort(), ['https://expired.push.example/send/run', 'https://fcm.googleapis.com/fcm/send/alive']);
      assert.deepEqual(storedEndpoints(userId), ['https://fcm.googleapis.com/fcm/send/alive']);
      assert.deepEqual(warn.mock.calls.map((call) => call.arguments[0]), [
        '[web-push] push to expired.push.example failed: 410 "expired"; subscription dropped',
      ]);
    } finally {
      send.mock.restore();
      warn.mock.restore();
    }
  });
});
