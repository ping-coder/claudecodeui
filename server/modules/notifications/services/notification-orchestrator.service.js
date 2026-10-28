import webPush from 'web-push';

import { notificationPreferencesDb, pushSubscriptionsDb, sessionsDb } from '@/modules/database/index.js';
import { sendDesktopNotification as sendDesktopNotificationToClients } from '@/modules/notifications/services/desktop-notification-clients.service.js';

const KIND_TO_PREF_KEY = {
  action_required: 'actionRequired',
  stop: 'stop',
  error: 'error'
};

const PROVIDER_LABELS = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  agy: 'Antigravity',
  system: 'System'
};

const recentEventKeys = new Map();
const DEDUPE_WINDOW_MS = 20000;

/**
 * Codes that report how one run ended, or that the background work it left
 * behind finished. Their dedupe key names the run, so repeats for one run
 * collapse while the next run of the same session (a queued or scheduled
 * message) is notified even when it ends inside the dedupe window.
 */
const RUN_END_CODES = new Set(['run.stopped', 'run.failed', 'run.background_completed']);

/**
 * Finds the run an app session is running, or ran last, for a run-end report
 * that does not name its run. The server entrypoint installs the websocket
 * module's run registry here: this module cannot import it, as the registry's
 * module graph imports the provider runtimes, which import this module. Until
 * one is installed, such reports are keyed per session.
 *
 * @type {(appSessionId: string) => { provider: string, startedAt: number } | null | undefined}
 */
let findSessionRun = () => null;

const cleanupOldEventKeys = () => {
  const now = Date.now();
  for (const [key, timestamp] of recentEventKeys.entries()) {
    if (now - timestamp > DEDUPE_WINDOW_MS) {
      recentEventKeys.delete(key);
    }
  }
};

function isNotificationEventEnabled(preferences, event) {
  const prefEventKey = KIND_TO_PREF_KEY[event.kind];
  const eventEnabled = prefEventKey ? Boolean(preferences?.events?.[prefEventKey]) : true;

  return eventEnabled;
}

/**
 * The run a run-end event reports, as its start time (the identity `run_ended`
 * frames carry); null for other events.
 *
 * The runtimes pass the start time of the run they report, read from the
 * run's writer, and it wins: a runtime can report well after the run's
 * terminal `complete` (Cursor when its process closes, Codex when its event
 * stream ends), by which time the session's next run may hold the registry
 * slot. A report without one falls back to the run in the slot, looked up by
 * the app session id; that is only right while the reported run still holds
 * the slot. Null when the slot holds no run of the event's provider.
 */
function readRunStartedAt(event) {
  if (!RUN_END_CODES.has(event.code)) {
    return null;
  }
  if (Number.isFinite(event.runStartedAt)) {
    return event.runStartedAt;
  }
  if (!event.sessionId) {
    return null;
  }

  const run = findSessionRun(event.sessionId);
  return run && run.provider === event.provider ? run.startedAt : null;
}

function isDuplicate(event) {
  cleanupOldEventKeys();
  const eventKey = event.dedupeKey || `${event.provider}:${event.kind || 'info'}:${event.code || 'generic'}:${event.sessionId || 'none'}`;
  const runStartedAt = readRunStartedAt(event);
  const key = runStartedAt === null ? eventKey : `${eventKey}:run:${runStartedAt}`;
  if (recentEventKeys.has(key)) {
    return true;
  }
  recentEventKeys.set(key, Date.now());
  return false;
}

function createNotificationEvent({
  provider,
  sessionId = null,
  kind = 'info',
  code = 'generic.info',
  meta = {},
  severity = 'info',
  dedupeKey = null,
  requiresUserAction = false,
  runStartedAt = null
}) {
  return {
    provider,
    sessionId,
    kind,
    code,
    meta,
    severity,
    requiresUserAction,
    dedupeKey,
    runStartedAt,
    createdAt: new Date().toISOString()
  };
}

function normalizeErrorMessage(error) {
  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error.message === 'string') {
    return error.message;
  }

  if (error == null) {
    return 'Unknown error';
  }

  return String(error);
}

function normalizeSessionName(sessionName) {
  if (typeof sessionName !== 'string') {
    return null;
  }

  const normalized = sessionName.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function rowMatchesProvider(row, provider) {
  return row && (!provider || row.provider === provider);
}

function resolveSessionRow(sessionId, provider) {
  if (!sessionId) {
    return null;
  }

  const appSessionRow = sessionsDb.getSessionById(sessionId);
  if (rowMatchesProvider(appSessionRow, provider)) {
    return appSessionRow;
  }

  const providerSessionRow = sessionsDb.getSessionByProviderSessionId(sessionId);
  if (rowMatchesProvider(providerSessionRow, provider)) {
    return providerSessionRow;
  }

  return null;
}

function normalizeNotificationSession(event) {
  if (!event?.sessionId || !event.provider || event.provider === 'system') {
    return event;
  }

  const row = resolveSessionRow(event.sessionId, event.provider);
  if (!row || row.session_id === event.sessionId) {
    return event;
  }

  return {
    ...event,
    sessionId: row.session_id
  };
}

function resolveSessionName(event) {
  const explicitSessionName = normalizeSessionName(event.meta?.sessionName);
  if (explicitSessionName) {
    return explicitSessionName;
  }

  if (!event.sessionId || !event.provider) {
    return null;
  }

  return normalizeSessionName(sessionsDb.getSessionName(event.sessionId, event.provider));
}

function buildNotificationPayload(event) {
  const normalizedEvent = normalizeNotificationSession(event);
  const CODE_MAP = {
    'permission.required': normalizedEvent.meta?.toolName
      ? `Action Required: Tool "${normalizedEvent.meta.toolName}" needs approval`
      : 'Action Required: A tool needs your approval',
    'run.stopped': normalizedEvent.meta?.stopReason || 'Run Stopped: The run has stopped',
    'run.background_completed': 'Background work finished',
    'run.failed': normalizedEvent.meta?.error ? `Run Failed: ${normalizedEvent.meta.error}` : 'Run Failed: The run encountered an error',
    'agent.notification': normalizedEvent.meta?.message ? String(normalizedEvent.meta.message) : 'You have a new notification',
    'push.enabled': 'Push notifications are now enabled!'
  };
  const providerLabel = PROVIDER_LABELS[normalizedEvent.provider] || 'Assistant';
  const sessionName = resolveSessionName(normalizedEvent);
  const message = CODE_MAP[normalizedEvent.code] || 'You have a new notification';

  return {
    title: sessionName || 'CloudCLI',
    body: `${providerLabel}: ${message}`,
    data: {
      sessionId: normalizedEvent.sessionId || null,
      code: normalizedEvent.code,
      provider: normalizedEvent.provider || null,
      sessionName,
      tag: `${normalizedEvent.provider || 'assistant'}:${normalizedEvent.sessionId || 'none'}:${normalizedEvent.code}`
    }
  };
}

function sendWebPushPayload(userId, payload) {
  const subscriptions = pushSubscriptionsDb.getSubscriptions(userId);
  if (!subscriptions.length) return Promise.resolve();

  const serializedPayload = JSON.stringify(payload);
  return Promise.allSettled(
    subscriptions.map((sub) =>
      webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.keys_p256dh,
            auth: sub.keys_auth
          }
        },
        serializedPayload
      )
    )
  ).then((results) => {
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const statusCode = result.reason?.statusCode;
        if (statusCode === 410 || statusCode === 404) {
          pushSubscriptionsDb.removeSubscription(subscriptions[index].endpoint);
        }
      }
    });
  });
}

const notificationChannels = [
  {
    id: 'webPush',
    // TODO: Web push still uses push_subscriptions. Do not remove that table until
    // browser push subscriptions are migrated into notification_channel_endpoints.
    isEnabled: (preferences) => Boolean(preferences?.channels?.webPush),
    send: ({ userId, payload }) => sendWebPushPayload(userId, payload)
  },
  {
    id: 'desktop',
    isEnabled: (preferences) => Boolean(preferences?.channels?.desktop),
    send: ({ userId, payload }) => sendDesktopNotificationToClients(userId, payload)
  }
];

function notifyUserIfEnabled({ userId, event }) {
  if (!userId || !event) {
    return;
  }

  const normalizedEvent = normalizeNotificationSession(event);
  const preferences = notificationPreferencesDb.getPreferences(userId);
  if (!isNotificationEventEnabled(preferences, normalizedEvent)) {
    return;
  }
  if (isDuplicate(normalizedEvent)) {
    return;
  }

  const payload = buildNotificationPayload(normalizedEvent);
  for (const channel of notificationChannels) {
    if (!channel.isEnabled(preferences)) {
      continue;
    }
    Promise.resolve(channel.send({ userId, event: normalizedEvent, payload })).catch((err) => {
      console.error(`Notification channel "${channel.id}" send error:`, err);
    });
  }
}

/**
 * Reports a run that ended without failing: `completed`, or `aborted` by the user.
 * `runStartedAt` is the reported run's start time, from its writer; it keeps
 * the report from being taken for the session's next run (see `readRunStartedAt`).
 *
 * @param {{ userId: string | number | null | undefined, provider: string, sessionId?: string | null, stopReason?: string, sessionName?: string | null, runStartedAt?: number | null }} event
 */
function notifyRunStopped({ userId, provider, sessionId = null, stopReason = 'completed', sessionName = null, runStartedAt = null }) {
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason, sessionName },
      severity: 'info',
      dedupeKey: `${provider}:run:stop:${sessionId || 'none'}:${stopReason}`,
      runStartedAt
    })
  });
}

/**
 * Reports background work that finished after its turn had already completed.
 *
 * Uses the `stop` kind so it rides the existing "run stopped" preference rather
 * than needing a new opt-in that would default to off. No explicit dedupeKey, so
 * the default composite key, with the run added, collapses that run's repeats
 * inside the dedupe window. `runStartedAt` names the run, as for `notifyRunStopped`.
 *
 * @param {{ userId: string | number | null | undefined, provider: string, sessionId?: string | null, sessionName?: string | null, runStartedAt?: number | null }} event
 */
function notifyBackgroundWorkCompleted({ userId, provider, sessionId = null, sessionName = null, runStartedAt = null }) {
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'stop',
      code: 'run.background_completed',
      meta: { sessionName },
      severity: 'info',
      runStartedAt
    })
  });
}

/**
 * Reports a run that failed; `error` is an Error, a message, or anything with one.
 * `runStartedAt` names the run, as for `notifyRunStopped`.
 *
 * @param {{ userId: string | number | null | undefined, provider: string, sessionId?: string | null, error: unknown, sessionName?: string | null, runStartedAt?: number | null }} event
 */
function notifyRunFailed({ userId, provider, sessionId = null, error, sessionName = null, runStartedAt = null }) {
  const errorMessage = normalizeErrorMessage(error);

  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'error',
      code: 'run.failed',
      meta: { error: errorMessage, sessionName },
      severity: 'error',
      dedupeKey: `${provider}:run:error:${sessionId || 'none'}:${errorMessage}`,
      runStartedAt
    })
  });
}

/**
 * Installs how run-end dedupe finds a session's run when a report does not
 * name it. Used by the server entrypoint, which wires in the websocket
 * module's run registry (`chatRunRegistry.getRun`), so repeats of one run
 * collapse but the next run of the session is notified.
 *
 * @param {(appSessionId: string) => { provider: string, startedAt: number } | null | undefined} lookup
 */
export function setNotificationRunLookup(lookup) {
  findSessionRun = lookup;
}

export {
  buildNotificationPayload,
  createNotificationEvent,
  notifyUserIfEnabled,
  notifyRunStopped,
  notifyRunFailed,
  notifyBackgroundWorkCompleted
};
