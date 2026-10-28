import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { WebSocket } from 'ws';

import { closeConnection, initializeDatabase, notificationPreferencesDb, userDb } from '@/modules/database/index.js';
import { registerDesktopNotificationClient, unregisterDesktopNotificationClient } from '@/modules/notifications/index.js';

/**
 * What the runtime tests see of the run notifications: one user whose
 * notifications reach only a desktop app socket.
 */
type RunNotificationCapture = {
  userId: number;
  /** Each notification the socket got so far, as `code@sessionId`. */
  delivered: () => string[];
};

/**
 * Used by the Cursor, Codex, OpenCode and agy runtime tests to check the run
 * notifications a runtime sends.
 *
 * Runs `runTest` against a throwaway database with one user who has every
 * event switched on and only the desktop channel enabled, so nothing leaves
 * the process. No run lookup is installed, so a run-end report that does not
 * name its run collapses with the session's other reports inside the dedupe
 * window. Every test must use its own session ids: the dedupe window spans
 * the whole test file.
 */
export async function withRunNotificationCapture(
  runTest: (capture: RunNotificationCapture) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runtime-notifications-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');

  const frames: string[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (message: string) => {
      const frame = JSON.parse(message) as { payload: { data: { code: string; sessionId: string | null } } };
      frames.push(`${frame.payload.data.code}@${frame.payload.data.sessionId}`);
    },
    close: () => undefined,
  } as unknown as WebSocket;

  try {
    await initializeDatabase();
    const userId = Number(userDb.createUser(`runtime-${randomUUID()}`, 'password-hash').id);
    notificationPreferencesDb.updatePreferences(userId, {
      channels: { webPush: false, desktop: true },
      events: { actionRequired: true, stop: true, error: true },
    });
    registerDesktopNotificationClient({ userId, deviceId: 'runtime-test-device', ws: socket });
    await runTest({ userId, delivered: () => [...frames] });
  } finally {
    unregisterDesktopNotificationClient(socket);
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
}
