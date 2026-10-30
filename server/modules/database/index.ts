export { initializeDatabase } from '@/modules/database/init-db.js';
export { closeConnection, getConnection, getDatabasePath } from '@/modules/database/connection.js';
export { apiKeysDb } from '@/modules/database/repositories/api-keys.js';
export { appConfigDb } from '@/modules/database/repositories/app-config.js';
export { credentialsDb } from '@/modules/database/repositories/credentials.js';
export { githubTokensDb } from '@/modules/database/repositories/github-tokens.js';
export { notificationChannelEndpointsDb } from '@/modules/database/repositories/notification-channel-endpoints.js';
export { notificationPreferencesDb } from '@/modules/database/repositories/notification-preferences.js';
// providerModelsDb: used by Providers to persist user-managed custom model rows.
export { providerModelsDb } from '@/modules/database/repositories/provider-models.js';
// projectsDb: used by Projects, Worktrees, Git, WebSocket, and notification modules to persist and resolve project records.
export { projectsDb } from '@/modules/database/repositories/projects.db.js';
export { pushSubscriptionsDb } from '@/modules/database/repositories/push-subscriptions.js';
export { scanStateDb } from '@/modules/database/repositories/scan-state.db.js';
// scheduleHoldsDb: written by Providers (the Claude runtime, through its run context) for the sessions it holds for scheduled work; read by WebSocket to resume their loops after a restart.
export { scheduleHoldsDb } from '@/modules/database/repositories/schedule-holds.db.js';
export type { StoredScheduleHold } from '@/modules/database/repositories/schedule-holds.db.js';
// sessionDraftsDb: used by User for drafts, Scheduled Messages for server-owned queued turns, and the WebSocket Shell handler (wired in server/index.ts), which holds a CLI back while a queued turn waits.
export { sessionDraftsDb } from '@/modules/database/repositories/session-drafts.db.js';
export type {
  QueuedSessionMessageRecord,
  SessionDraftRecord,
} from '@/modules/database/repositories/session-drafts.db.js';
export { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
export { userDb } from '@/modules/database/repositories/users.js';
// userPreferencesDb: used by the User module to persist the settings that used to live in browser localStorage.
export { userPreferencesDb } from '@/modules/database/repositories/user-preferences.db.js';
export { vapidKeysDb } from '@/modules/database/repositories/vapid-keys.js';
export { scheduledMessagesDb } from './repositories/scheduled-messages.db.js';
export type { ScheduledMessageRow, ScheduledMessageStatus } from './repositories/scheduled-messages.db.js';
