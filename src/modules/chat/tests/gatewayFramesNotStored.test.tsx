import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import type { NormalizedMessage, ProjectSession, ServerEvent } from '@/shared/types';

/**
 * Some gateway frames name a session but belong to another listener on the
 * page's socket: the run's end, the answers to a stop or a resume of scheduled
 * work, why a queued or scheduled message waits. They have no id. Stored as a
 * live row, one made every merge of a session with history throw, so the
 * resumed turn and everything after it never showed until the page reloaded.
 */

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

const SESSION = 'session-with-loops';

const HISTORY: NormalizedMessage[] = [
  {
    id: 'h1', kind: 'text', role: 'user', provider: 'claude', sessionId: SESSION, content: '/loop 10m check CI', timestamp: '2026-10-30T08:00:00.000Z',
  } as NormalizedMessage,
  {
    id: 'h2', kind: 'tool_use', provider: 'claude', sessionId: SESSION, toolName: 'CronCreate', toolId: 'toolu_cron', toolInput: { cron: '*/10 * * * *', prompt: 'check CI' }, timestamp: '2026-10-30T08:00:01.000Z',
  } as NormalizedMessage,
];

type Listener = (event: ServerEvent) => void;

/** The page's single socket, which, like WebSocketContext, logs a listener's error and goes on. */
const createSocket = () => {
  const listeners = new Set<Listener>();
  const errors: unknown[] = [];
  return {
    errors,
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch: (event: ServerEvent) => {
      act(() => {
        for (const listener of listeners) {
          try {
            listener(event);
          } catch (error) {
            errors.push(error);
          }
        }
      });
    },
  };
};

beforeEach(() => {
  sessionMessages.mockReset();
  sessionMessages.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { messages: HISTORY, total: HISTORY.length, hasMore: false } }),
  });
});

afterEach(() => {
  vi.resetModules();
});

/** One chat showing the session, its history loaded, listening on the socket. */
async function renderChatWithHistory(socket: ReturnType<typeof createSocket>) {
  const { useChatRealtimeHandlers } = await import('@/modules/chat/hooks/useChatRealtimeHandlers');
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  const { result } = renderHook(() => {
    const store = useSessionStore();
    useChatRealtimeHandlers({
      isActive: true,
      subscribe: socket.subscribe,
      provider: 'claude',
      selectedSession: { id: SESSION } as ProjectSession,
      currentSessionId: SESSION,
      setTokenBudget: () => {},
      pendingPermissionRequests: [],
      setPendingPermissionRequests: () => {},
      lastSeqRef: useRef(new Map<string, number>()),
      statusCheckSentAtRef: useRef(new Map<string, number>()),
      claimPageEffect: () => true,
      isBackgroundReporter: () => true,
      requestLatestMessages: async () => {},
      sessionStore: store,
    });
    return store;
  });
  act(() => {
    result.current.setActiveSession(SESSION);
  });
  await act(async () => {
    await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
  });
  return result;
}

const gatewayFrame = (kind: string, fields: Record<string, unknown> = {}): ServerEvent => ({
  kind,
  sessionId: SESSION,
  timestamp: new Date().toISOString(),
  ...fields,
} as ServerEvent);

describe('gateway frames another listener owns', () => {
  it('a resume of paused loops leaves the transcript live: its status frames are not stored, the resumed turn shows', async () => {
    const socket = createSocket();
    const store = await renderChatWithHistory(socket);

    socket.dispatch(gatewayFrame('resume_loops_status', { status: 'started', clientRequestId: 'resume_1' }));
    socket.dispatch({
      kind: 'text',
      id: 'resumed-note',
      role: 'assistant',
      provider: 'claude',
      sessionId: SESSION,
      content: 'The loop is back.',
      timestamp: '2026-10-30T08:30:00.000Z',
    } as unknown as ServerEvent);
    socket.dispatch(gatewayFrame('resume_loops_status', { status: 'finished', clientRequestId: 'resume_1' }));

    assert.equal(socket.errors.length, 0);
    const slot = store.current.getSessionSlot(SESSION);
    assert.deepEqual(slot?.realtimeMessages.map((row) => row.id), ['resumed-note']);
    assert.deepEqual(store.current.getMessages(SESSION).map((row) => row.id), ['h1', 'h2', 'resumed-note']);

    // A later read of the history still merges.
    await act(async () => {
      await store.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });
    assert.equal(store.current.getSessionSlot(SESSION)?.status, 'idle');
  });

  it('none of them becomes a transcript row', async () => {
    const socket = createSocket();
    const store = await renderChatWithHistory(socket);

    socket.dispatch(gatewayFrame('run_ended', { outcome: 'done', phase: 'turn', runStartedAt: 1 }));
    socket.dispatch(gatewayFrame('stop_task_status', { taskId: 'cron:b2148320', status: 'started' }));
    for (const status of ['started', 'finished', 'busy', 'held_elsewhere', 'not_found', 'failed']) {
      socket.dispatch(gatewayFrame('resume_loops_status', { status }));
    }
    socket.dispatch(gatewayFrame('dispatch_waiting', { target: { kind: 'queued' }, wait: null }));

    assert.equal(socket.errors.length, 0);
    assert.equal(store.current.getSessionSlot(SESSION)?.realtimeMessages.length, 0);
    assert.deepEqual(store.current.getMessages(SESSION).map((row) => row.id), ['h1', 'h2']);
  });
});
