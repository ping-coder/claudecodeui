import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { describe, it, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import type { InsertStatusEvent, ProjectSession, SendRefusedEvent, ServerEvent } from '@/shared/types';

/**
 * An insert's progress comes as `insert_status` frames: sequenced ones through
 * the run (replayed to every pane that subscribes) and unsequenced answers to
 * the socket that asked. None is a transcript row. The composer must hear each
 * insert's status once, never one the insert is already past, and must hear
 * when a run is over, so an insert whose end went unheard can be settled.
 */

type Listener = (event: ServerEvent) => void;

const createSocket = () => {
  const listeners = new Set<Listener>();
  return {
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch: (event: Record<string, unknown>) => {
      act(() => {
        for (const listener of listeners) {
          listener({ provider: 'claude', timestamp: '2026-10-28T10:00:00.000Z', ...event } as ServerEvent);
        }
      });
    },
  };
};

const renderChat = (socket: ReturnType<typeof createSocket>, sessionId: string) => {
  const onInsertStatus = vi.fn<(event: InsertStatusEvent) => void>();
  const onInsertRunEnded = vi.fn<(sessionId: string, sentBefore: number | null) => void>();
  const onSendRefused = vi.fn<(event: SendRefusedEvent) => void>();
  const onSessionIdle = vi.fn();
  const { result } = renderHook(() => {
    const store = useSessionStore();
    const lastSeqRef = useRef(new Map<string, number>());
    const statusCheckSentAtRef = useRef(new Map<string, number>());
    useChatRealtimeHandlers({
      isActive: true,
      subscribe: socket.subscribe,
      provider: 'claude',
      selectedSession: { id: sessionId } as ProjectSession,
      currentSessionId: sessionId,
      setTokenBudget: () => {},
      pendingPermissionRequests: [],
      setPendingPermissionRequests: () => {},
      lastSeqRef,
      statusCheckSentAtRef,
      claimPageEffect: () => true,
      isBackgroundReporter: () => true,
      onInsertStatus,
      onInsertRunEnded,
      onSendRefused,
      onSessionIdle,
      requestLatestMessages: async () => {},
      sessionStore: store,
    });
    return { store, statusCheckSentAtRef };
  });
  return {
    onInsertStatus,
    onInsertRunEnded,
    onSendRefused,
    onSessionIdle,
    rows: (sid: string) => result.current.store.getMessages(sid),
    markSubscribeSent: (sid: string, at: number) => result.current.statusCheckSentAtRef.current.set(sid, at),
  };
};

const statusesHeard = (chat: ReturnType<typeof renderChat>) => chat.onInsertStatus.mock.calls
  .map(([event]) => `${event.insertId}:${event.insertStatus}`);

describe('an insert_status frame', () => {
  it('reaches the composer with its fields and never the transcript store', () => {
    const socket = createSocket();
    const chat = renderChat(socket, 'S');

    socket.dispatch({ kind: 'insert_status', id: 'f1', sessionId: 'S', seq: 1, insertId: 'i1', insertStatus: 'pending', content: 'also check the docs' });
    socket.dispatch({ kind: 'insert_status', sessionId: 'S', insertId: 'i2', insertStatus: 'refused', insertReason: 'NO_ACTIVE_RUN', content: 'late' });

    assert.deepEqual(chat.onInsertStatus.mock.calls.map(([event]) => event), [
      { sessionId: 'S', insertId: 'i1', insertStatus: 'pending', content: 'also check the docs' },
      { sessionId: 'S', insertId: 'i2', insertStatus: 'refused', content: 'late', insertReason: 'NO_ACTIVE_RUN' },
    ]);
    assert.equal(chat.rows('S').some((row) => String(row.kind) === 'insert_status'), false);
    assert.equal(chat.rows('S').length, 0);
  });

  it('is heard once per status, and never once the insert is past it', () => {
    const socket = createSocket();
    const chat = renderChat(socket, 'S');

    socket.dispatch({ kind: 'insert_status', id: 'f1', sessionId: 'S', seq: 1, insertId: 'i1', insertStatus: 'pending', content: 'x' });
    // A direct answer has no seq, so nothing else drops a second copy of it.
    socket.dispatch({ kind: 'insert_status', sessionId: 'S', insertId: 'i1', insertStatus: 'cancel_failed' });
    socket.dispatch({ kind: 'insert_status', sessionId: 'S', insertId: 'i1', insertStatus: 'cancel_failed' });
    socket.dispatch({ kind: 'insert_status', id: 'f2', sessionId: 'S', seq: 2, insertId: 'i1', insertStatus: 'delivered', content: 'x' });
    // A late copy of the insert's acceptance must not list it again.
    socket.dispatch({ kind: 'insert_status', id: 'f3', sessionId: 'S', seq: 3, insertId: 'i1', insertStatus: 'pending', content: 'x' });
    socket.dispatch({ kind: 'insert_status', id: 'f4', sessionId: 'S', seq: 4, insertId: 'i1', insertStatus: 'failed', content: 'x' });

    assert.deepEqual(statusesHeard(chat), ['i1:pending', 'i1:cancel_failed', 'i1:delivered']);
  });

  it('of a run this chat joined part-way is heard live, and its replay adds nothing', () => {
    const socket = createSocket();
    const chat = renderChat(socket, 'S');

    // Another pane attached the socket mid-run, so these come live before this chat's replay.
    socket.dispatch({ kind: 'insert_status', id: 'p', sessionId: 'S', seq: 5, insertId: 'i1', insertStatus: 'pending', content: 'x' });
    socket.dispatch({ kind: 'insert_status', id: 'd', sessionId: 'S', seq: 6, insertId: 'i1', insertStatus: 'delivered', content: 'x' });
    // Its own subscribe replays the run from the start.
    socket.dispatch({ kind: 'text', id: 'u', sessionId: 'S', seq: 1, role: 'user', content: 'go' });
    socket.dispatch({ kind: 'insert_status', id: 'p', sessionId: 'S', seq: 5, insertId: 'i1', insertStatus: 'pending', content: 'x' });
    socket.dispatch({ kind: 'insert_status', id: 'd', sessionId: 'S', seq: 6, insertId: 'i1', insertStatus: 'delivered', content: 'x' });

    assert.deepEqual(statusesHeard(chat), ['i1:pending', 'i1:delivered']);
  });

  it('of an unknown status is ignored', () => {
    const socket = createSocket();
    const chat = renderChat(socket, 'S');

    socket.dispatch({ kind: 'insert_status', sessionId: 'S', insertId: 'i1', insertStatus: 'teleported' });
    socket.dispatch({ kind: 'insert_status', sessionId: 'S', insertStatus: 'pending' });

    assert.equal(chat.onInsertStatus.mock.calls.length, 0);
  });
});

describe('a send_refused frame', () => {
  it('reaches the composer with its reason and changes, leaves the session as it was, and is never stored', () => {
    const socket = createSocket();
    const chat = renderChat(socket, 'S');

    socket.dispatch({ kind: 'send_refused', sessionId: 'S', reason: 'BACKGROUND_WORK_WOULD_STOP', changes: ['effort', 7, 'cwd'] });

    assert.deepEqual(chat.onSendRefused.mock.calls.map(([event]) => event), [
      { sessionId: 'S', reason: 'BACKGROUND_WORK_WOULD_STOP', changes: ['effort', 'cwd'] },
    ]);
    assert.equal(chat.onSessionIdle.mock.calls.length, 0, 'unlike a protocol_error, it does not idle the session');
    assert.equal(chat.rows('S').length, 0);
  });

  it('hands over the send\'s clientRequestId when it carries one, and nothing for one that is not a string', () => {
    const socket = createSocket();
    const chat = renderChat(socket, 'S');

    socket.dispatch({ kind: 'send_refused', sessionId: 'S', reason: 'BACKGROUND_WORK_WOULD_STOP', changes: [], clientRequestId: 'send_mf3k2_a1b2c3' });
    socket.dispatch({ kind: 'send_refused', sessionId: 'S', reason: 'BACKGROUND_WORK_WOULD_STOP', changes: [], clientRequestId: 7 });

    assert.deepEqual(chat.onSendRefused.mock.calls.map(([event]) => event), [
      { sessionId: 'S', reason: 'BACKGROUND_WORK_WOULD_STOP', changes: [], clientRequestId: 'send_mf3k2_a1b2c3' },
      { sessionId: 'S', reason: 'BACKGROUND_WORK_WOULD_STOP', changes: [] },
    ]);
  });

  it('that names no session is dropped', () => {
    const socket = createSocket();
    const chat = renderChat(socket, 'S');

    socket.dispatch({ kind: 'send_refused', reason: 'BACKGROUND_WORK_WOULD_STOP', changes: [] });

    assert.equal(chat.onSendRefused.mock.calls.length, 0);
    assert.equal(chat.rows('S').length, 0);
  });
});

describe('the message an insert became', () => {
  it('is stored as a user text that renders with its inserted flag', () => {
    const socket = createSocket();
    const chat = renderChat(socket, 'S');

    socket.dispatch({ kind: 'text', id: 'i1', sessionId: 'S', seq: 1, role: 'user', content: 'also check the docs', inserted: true });

    const [bubble] = normalizedToChatMessages(chat.rows('S'));
    assert.equal(bubble?.type, 'user');
    assert.equal(bubble?.inserted, true);
    assert.equal(bubble?.transcriptAnchorId, undefined);
  });
});

describe('the end of a run', () => {
  it('is told at an idle subscribe ack, for inserts sent before that subscribe', () => {
    const socket = createSocket();
    const chat = renderChat(socket, 'S');
    chat.markSubscribeSent('S', 1_234);

    socket.dispatch({ kind: 'chat_subscribed', sessionId: 'S', isProcessing: false, pendingPermissions: [] });

    assert.deepEqual(chat.onInsertRunEnded.mock.calls, [['S', 1_234]]);
  });

  it('is not told by a busy subscribe ack', () => {
    const socket = createSocket();
    const chat = renderChat(socket, 'S');

    socket.dispatch({ kind: 'chat_subscribed', sessionId: 'S', isProcessing: true, lastSeq: 3, pendingPermissions: [] });

    assert.equal(chat.onInsertRunEnded.mock.calls.length, 0);
  });

  it('is told at the run\'s complete, for every insert', () => {
    const socket = createSocket();
    const chat = renderChat(socket, 'S');

    socket.dispatch({ kind: 'complete', id: 'c', sessionId: 'S', seq: 1, success: true });

    assert.deepEqual(chat.onInsertRunEnded.mock.calls, [['S', null]]);
  });
});
