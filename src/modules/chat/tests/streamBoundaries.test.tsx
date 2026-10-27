import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage, ProjectSession, ServerEvent } from '@/shared/types';

/**
 * Streamed text is buffered per session and written into the store at most
 * every 100 ms. Where a stream ends decides what each row holds: `stream_end`
 * closes one segment of a reply (text, a tool call, more text), `complete` the
 * run, and the text not yet written when either arrives belongs to that row.
 * A run counts seq from 1, which is also how the buffer tells a new reply from
 * the rest of one whose end the socket was away for.
 *
 * Only the frames of a run a chat followed from its start are stored: a chat
 * that joined a run part-way waits for the replay that starts it.
 */

type Listener = (event: ServerEvent) => void;

const renderChat = (sessionId = 'S') => {
  const listeners = new Set<Listener>();
  const { result } = renderHook(() => {
    const store = useSessionStore();
    const lastSeqRef = useRef(new Map<string, number>());
    const statusCheckSentAtRef = useRef(new Map<string, number>());
    useChatRealtimeHandlers({
      isActive: true,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      provider: 'agy',
      selectedSession: { id: sessionId } as ProjectSession,
      currentSessionId: sessionId,
      setTokenBudget: () => {},
      pendingPermissionRequests: [],
      setPendingPermissionRequests: () => {},
      lastSeqRef,
      statusCheckSentAtRef,
      claimPageEffect: () => true,
      isBackgroundReporter: () => true,
      requestLatestMessages: async () => {},
      sessionStore: store,
    });
    return { store, lastSeqRef };
  });

  const dispatch = (frame: Record<string, unknown>) => {
    act(() => {
      for (const listener of listeners) {
        listener({ sessionId, provider: 'agy', timestamp: '2026-10-27T10:00:00.000Z', ...frame } as ServerEvent);
      }
    });
  };

  return {
    dispatch,
    rows: (): NormalizedMessage[] => result.current.store.getMessages(sessionId),
    lastSeq: () => result.current.lastSeqRef.current.get(sessionId),
  };
};

const delta = (seq: number, content: string, id = 'agy:conv:1:text') => ({ kind: 'stream_delta', id, seq, content });
const streamEnd = (seq: number) => ({ kind: 'stream_end', id: `end-${seq}`, seq });
const complete = (seq: number) => ({ kind: 'complete', id: `complete-${seq}`, seq, success: true });
const toolUse = (seq: number) => ({ kind: 'tool_use', id: `tool-${seq}`, seq, toolName: 'Bash', toolId: `toolu_${seq}`, toolInput: {} });

/** The reply rows as the transcript shows them: finished text, then a stream still running. */
const replyTexts = (rows: NormalizedMessage[]) => rows
  .filter((row) => (row.kind === 'text' && row.role === 'assistant') || row.kind === 'stream_delta')
  .map((row) => `${row.kind === 'stream_delta' ? 'streaming: ' : ''}${row.content}`);

const flushTimers = () => {
  act(() => {
    vi.advanceTimersByTime(150);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('stream_end', () => {
  it('closes a segment, so text after a tool call starts a row of its own', () => {
    const chat = renderChat();

    chat.dispatch(delta(1, 'First '));
    chat.dispatch(delta(2, 'segment.'));
    flushTimers();
    chat.dispatch(streamEnd(3));
    chat.dispatch(toolUse(4));
    chat.dispatch(delta(5, 'Second segment.', 'agy:conv:2:text'));
    flushTimers();
    chat.dispatch(streamEnd(6));

    assert.deepEqual(replyTexts(chat.rows()), ['First segment.', 'Second segment.']);
  });

  it('writes the text the last flush has not reached yet', () => {
    const chat = renderChat();

    // The segment ends within the 100 ms the buffer waits.
    chat.dispatch(delta(1, 'Quick '));
    chat.dispatch(delta(2, 'reply.'));
    chat.dispatch(streamEnd(3));

    assert.deepEqual(replyTexts(chat.rows()), ['Quick reply.']);
  });
});

describe('complete', () => {
  it('writes what the session still buffered and forgets it, so later text is a row of its own', () => {
    const chat = renderChat();

    chat.dispatch(delta(1, 'Done.'));
    chat.dispatch(complete(2));
    assert.deepEqual(replyTexts(chat.rows()), ['Done.']);

    // The run goes on numbering what comes after its turn (the CLI pushes a turn when a task reports).
    chat.dispatch(delta(3, 'Later.', 'agy:conv:3:text'));
    chat.dispatch(streamEnd(4));
    assert.deepEqual(replyTexts(chat.rows()), ['Done.', 'Later.']);
  });
});

describe('a run whose end the socket was away for', () => {
  it('is not continued by the next run, whose deltas count from 1 again', () => {
    const chat = renderChat();

    chat.dispatch(delta(1, 'Partial ', 'run-1:text'));
    flushTimers();
    // No stream_end, no complete: the next frames are the next run's.
    chat.dispatch(delta(1, 'Fresh answer', 'run-2:text'));
    flushTimers();

    assert.deepEqual(replyTexts(chat.rows()), ['streaming: Fresh answer']);
  });

  it('is dropped once the server answers a subscribe with no run going on', () => {
    const chat = renderChat();

    chat.dispatch(delta(1, 'Partial '));
    flushTimers();
    assert.deepEqual(replyTexts(chat.rows()), ['streaming: Partial ']);

    chat.dispatch({ kind: 'chat_subscribed', isProcessing: false, lastSeq: 7, pendingPermissions: [] });

    assert.deepEqual(replyTexts(chat.rows()), []);
    // Nothing of that run can be replayed; a later subscribe asks for the next run in full.
    assert.equal(chat.lastSeq(), undefined);
  });
});

describe('a run this chat joined part-way', () => {
  const toolIds = (rows: NormalizedMessage[]) => rows.filter((row) => row.kind === 'tool_use').map((row) => row.id);

  it('stores none of it until the replay from its start, then all of it in order', () => {
    const chat = renderChat();

    // Overheard: another chat attached the socket to the run before this one mounted.
    chat.dispatch(toolUse(4));
    chat.dispatch(toolUse(5));
    assert.deepEqual(toolIds(chat.rows()), []);
    assert.equal(chat.lastSeq(), undefined, 'so its subscribe asks for the whole run');

    chat.dispatch({ kind: 'chat_subscribed', isProcessing: true, lastSeq: 5, pendingPermissions: [] });
    [1, 2, 3, 4, 5].forEach((seq) => chat.dispatch(toolUse(seq)));

    assert.deepEqual(toolIds(chat.rows()), ['tool-1', 'tool-2', 'tool-3', 'tool-4', 'tool-5']);
    assert.equal(chat.lastSeq(), 5);
  });

  it('follows a long run from the first frame the server still buffers', () => {
    const chat = renderChat();

    chat.dispatch(toolUse(6_999));
    // The server keeps a run's last 5000 frames: this replay starts at 2001.
    chat.dispatch({ kind: 'chat_subscribed', isProcessing: true, lastSeq: 7_000, pendingPermissions: [] });
    chat.dispatch(toolUse(2_001));
    chat.dispatch(toolUse(2_002));

    assert.deepEqual(toolIds(chat.rows()), ['tool-2001', 'tool-2002']);
  });

  it('stores the run\'s background work once the server says its turn is over', () => {
    const chat = renderChat();

    chat.dispatch(toolUse(8));
    chat.dispatch({ kind: 'chat_subscribed', isProcessing: false, lastSeq: 8, pendingPermissions: [] });
    chat.dispatch({ kind: 'task_status', id: 'task-9', seq: 9, event: 'progress', taskId: 't1', toolUseId: 'toolu_1' });

    assert.deepEqual(chat.rows().map((row) => row.id), ['task-9']);
  });
});
