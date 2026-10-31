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

/**
 * How long one request to a push service may take, from start to answer. web-push
 * waits forever by default, and its `timeout` option is only how long the socket
 * may sit idle, which a service that answers a little at a time never runs out;
 * so deliverWebPush holds the send to this deadline itself as well.
 */
const WEB_PUSH_TIMEOUT_MS = 10_000;

/** What the deadline in deliverWebPush settles with when it comes first. */
const WEB_PUSH_DEADLINE_PASSED = Symbol('web push deadline passed');

/**
 * A failure is logged at most once per this long for each push service host and
 * status; the next line says how many came in between. A dropped subscription is
 * always logged, as that happens once per subscription.
 */
const WEB_PUSH_FAILURE_LOG_INTERVAL_MS = 10 * 60 * 1000;

/** The longest part of a push service's answer that reaches the log. */
const WEB_PUSH_FAILURE_DETAIL_LENGTH = 160;

/**
 * A 403 that says the subscription was made with another VAPID key: FCM's
 * wording, and Apple's reason code. Such a subscription never takes a push from
 * this server again, so it goes like an expired one.
 */
const VAPID_MISMATCH_PATTERN = /do not correspond to the credentials used to create the subscriptions|VapidPkHashMismatch/i;

// Per `${host} ${status}`: when its last line was logged and how many failures were not.
const webPushFailureLog = new Map();

/** The push service's host (fcm.googleapis.com, web.push.apple.com): the endpoint's path names the browser and stays out of the log. */
function readPushServiceHost(endpoint) {
  try {
    return new URL(endpoint).host || 'unknown';
  } catch {
    return 'invalid-endpoint';
  }
}

/** Control characters and line breaks would split the log line; the text is cut short too. */
function cleanLogDetail(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .trim()
    .slice(0, WEB_PUSH_FAILURE_DETAIL_LENGTH);
}

function shouldDropSubscription(statusCode, body) {
  return statusCode === 404 || statusCode === 410 || (statusCode === 403 && VAPID_MISMATCH_PATTERN.test(body));
}

function logWebPushFailure({ host, statusCode, detail, dropped }) {
  const key = `${host} ${statusCode ?? 'network'}`;
  const now = Date.now();
  const entry = webPushFailureLog.get(key);
  if (!dropped && entry && now - entry.loggedAt < WEB_PUSH_FAILURE_LOG_INTERVAL_MS) {
    entry.suppressed += 1;
    return;
  }

  const suppressed = entry?.suppressed ?? 0;
  webPushFailureLog.set(key, { loggedAt: now, suppressed: 0 });
  const answer = statusCode === null ? `no answer (${detail || 'unknown error'})` : `${statusCode} ${JSON.stringify(detail)}`;
  const parts = [`[web-push] push to ${host} failed: ${answer}`];
  if (dropped) {
    parts.push('subscription dropped');
  }
  if (suppressed > 0) {
    parts.push(`${suppressed} more like it since the last line`);
  }
  console.warn(parts.join('; '));
}

/**
 * Sends one push to one stored subscription and resolves to how the push service
 * answered: accepted with its status, or failed with its status (null when it
 * never answered, or not within WEB_PUSH_TIMEOUT_MS) and a short detail. A
 * subscription the service calls gone, or made with another VAPID key, is removed.
 */
async function deliverWebPush(subscription, serializedPayload) {
  const host = readPushServiceHost(subscription.endpoint);
  let deadlineTimer;
  const deadline = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => resolve(WEB_PUSH_DEADLINE_PASSED), WEB_PUSH_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([
      webPush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.keys_p256dh,
            auth: subscription.keys_auth
          }
        },
        serializedPayload,
        { timeout: WEB_PUSH_TIMEOUT_MS }
      ),
      deadline
    ]);
    if (response === WEB_PUSH_DEADLINE_PASSED) {
      // The request may still answer later; nothing waits for that answer.
      logWebPushFailure({ host, statusCode: null, detail: 'timeout', dropped: false });
      return { accepted: false, statusCode: null, host, detail: 'timeout', dropped: false };
    }
    return { accepted: true, statusCode: Number.isInteger(response?.statusCode) ? response.statusCode : null, host };
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : null;
    const body = typeof error?.body === 'string' ? error.body : '';
    const dropped = statusCode !== null && shouldDropSubscription(statusCode, body);
    if (dropped) {
      pushSubscriptionsDb.removeSubscription(subscription.endpoint);
    }
    const detail = cleanLogDetail(statusCode === null ? error?.code || error?.message || error : body);
    logWebPushFailure({ host, statusCode, detail, dropped });
    return { accepted: false, statusCode, host, detail, dropped };
  } finally {
    clearTimeout(deadlineTimer);
  }
}

function sendWebPushPayload(userId, payload) {
  const subscriptions = pushSubscriptionsDb.getSubscriptions(userId);
  if (!subscriptions.length) return Promise.resolve();

  const serializedPayload = JSON.stringify(payload);
  return Promise.all(subscriptions.map((subscription) => deliverWebPush(subscription, serializedPayload)));
}

/**
 * Sends Settings' test push to one subscription of the user, whatever their
 * channel and event switches say, and resolves to the push service's answer (see
 * `deliverWebPush`); null when the user holds no subscription with this endpoint.
 * The worker shows it with sound and a banner like any push that is not a run's.
 *
 * @param {{ userId: number, endpoint: string, title: string, body: string }} test
 */
async function sendTestWebPush({ userId, endpoint, title, body }) {
  const subscription = pushSubscriptionsDb.getPushSubscriptionForUser(userId, endpoint);
  if (!subscription) {
    return null;
  }

  const payload = {
    title,
    body,
    data: { sessionId: null, provider: null, code: 'push.test', tag: 'cloudcli:test:push' }
  };
  return deliverWebPush(subscription, JSON.stringify(payload));
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
  notifyBackgroundWorkCompleted,
  sendTestWebPush
};
