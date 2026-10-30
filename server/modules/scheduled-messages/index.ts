// The HTTP surface for scheduling a message to a session, mounted by the app.
export { default as scheduledMessagesRoutes } from './scheduled-messages.routes.js';

// The timer that sends them, started and stopped with the server.
// requestDispatchPass: the chat gateway asks for a pass once a stop has
// ended a session's loops, so the messages that waited on them go at once.
export {
  initializeScheduledMessageDispatcher,
  closeScheduledMessageDispatcher,
  requestDispatchPass,
} from './services/scheduled-message-dispatcher.service.js';
