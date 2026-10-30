import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type { DispatchWaitingEvent } from '@/shared/types.js';

/**
 * Sends a gateway event that other modules raise to every open chat socket,
 * as `run_ended` and `session_upserted` go: the sockets are not tied to
 * users, so the event carries nothing but ids and codes. One socket that
 * fails to take it keeps it from no other.
 */
export function broadcastGatewayEvent(event: DispatchWaitingEvent): void {
  const payload = JSON.stringify(event);
  for (const client of connectedClients) {
    if (client.readyState !== WS_OPEN_STATE) {
      continue;
    }
    try {
      client.send(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Chat] Failed to broadcast a gateway event', { kind: event.kind, error: message });
    }
  }
}
