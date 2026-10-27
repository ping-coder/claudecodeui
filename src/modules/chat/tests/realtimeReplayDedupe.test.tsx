import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { ProjectSession, ServerEvent } from '@/shared/types';

/**
 * The page has one websocket, and every chat on it hears every frame. When a
 * second pane opens a session that is still running, its `chat.subscribe`
 * (lastSeq 0) makes the server replay the whole run to that socket, so the
 * chat that already had those frames received them again and showed every
 * row twice. A chat now drops a sequenced frame it has already handled, by
 * `${seq}:${id}` per session: not by id alone, since agy and OpenCode stream
 * every delta of a part under one id, and not by seq alone, since every run
 * counts seq from 1 again.
 */

type Listener = (event: ServerEvent) => void;

/** The page's single socket: every chat's listener hears every frame, in order. */
const createSocket = () => {
  const listeners = new Set<Listener>();
  return {
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch: (event: ServerEvent) => {
      act(() => {
        for (const listener of listeners) {
          listener(event);
        }
      });
    },
  };
};

type Socket = ReturnType<typeof createSocket>;

/** One chat showing `sessionId`, with its own store, listening on the page's socket. */
const renderChat = (socket: Socket, sessionId: string) => {
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
      requestLatestMessages: async () => {},
      sessionStore: store,
    });
    return { store, lastSeqRef };
  });
  return {
    rows: (sid: string) => result.current.store.getMessages(sid),
    lastSeq: (sid: string) => result.current.lastSeqRef.current.get(sid),
  };
};

const toolUse = (sessionId: string, id: string, seq: number): ServerEvent => ({
  kind: 'tool_use',
  id,
  sessionId,
  seq,
  provider: 'claude',
  timestamp: new Date(1_700_000_000_000 + seq * 1_000).toISOString(),
  toolName: 'Bash',
  toolId: `tool-${id}`,
  toolInput: { command: 'ls' },
} as unknown as ServerEvent);

const delta = (sessionId: string, id: string, seq: number, content: string): ServerEvent => ({
  kind: 'stream_delta',
  id,
  sessionId,
  seq,
  provider: 'agy',
  timestamp: new Date(1_700_000_000_000 + seq * 1_000).toISOString(),
  content,
} as unknown as ServerEvent);

const complete = (sessionId: string, id: string, seq: number): ServerEvent => ({
  kind: 'complete',
  id,
  sessionId,
  seq,
  provider: 'claude',
  timestamp: new Date(1_700_000_000_000 + seq * 1_000).toISOString(),
  success: true,
  aborted: false,
} as unknown as ServerEvent);

const toolIds = (rows: ReturnType<ReturnType<typeof renderChat>['rows']>) => rows
  .filter((row) => row.kind === 'tool_use')
  .map((row) => row.id);

describe('a replayed run', () => {
  it('adds nothing to the chat that already had it, and reaches the pane that asked for it once', () => {
    const socket = createSocket();
    const left = renderChat(socket, 'S');

    socket.dispatch(toolUse('S', 'e1', 1));
    socket.dispatch(toolUse('S', 'e2', 2));
    assert.deepEqual(toolIds(left.rows('S')), ['e1', 'e2']);

    // A second pane opens S mid-run; its subscribe replays seq 1..2 to the socket.
    const right = renderChat(socket, 'S');
    socket.dispatch(toolUse('S', 'e1', 1));
    socket.dispatch(toolUse('S', 'e2', 2));

    assert.deepEqual(toolIds(left.rows('S')), ['e1', 'e2']);
    assert.deepEqual(toolIds(right.rows('S')), ['e1', 'e2']);
    // Reconnect catch-up still knows how far each chat got.
    assert.equal(left.lastSeq('S'), 2);
    assert.equal(right.lastSeq('S'), 2);
  });

  it('is told apart per session', () => {
    const socket = createSocket();
    const chat = renderChat(socket, 'A');

    socket.dispatch(toolUse('A', 'same-id', 1));
    socket.dispatch(toolUse('B', 'same-id', 1));

    assert.deepEqual(toolIds(chat.rows('A')), ['same-id']);
    assert.deepEqual(toolIds(chat.rows('B')), ['same-id']);
  });
});

describe('frames that only look alike', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps every agy or OpenCode delta that shares its part\'s id', () => {
    const socket = createSocket();
    const chat = renderChat(socket, 'S');

    // agy streams a step's text as many deltas under `agy:<conversation>:<step>:text`,
    // each numbered on in the run.
    socket.dispatch(delta('S', 'agy:conv-1:4:text', 1, 'Hel'));
    socket.dispatch(delta('S', 'agy:conv-1:4:text', 2, 'lo, '));
    socket.dispatch(delta('S', 'agy:conv-1:4:text', 3, 'world'));
    act(() => {
      vi.advanceTimersByTime(150);
    });

    const streaming = chat.rows('S').find((row) => row.id === '__streaming_S');
    assert.equal(streaming?.content, 'Hello, world');
  });

  it('keeps a run\'s frames when an earlier run used the same seq, even with that run\'s complete missed', () => {
    const socket = createSocket();
    const chat = renderChat(socket, 'S');

    // The first run's `complete` never arrives (the socket dropped across it);
    // the next run counts seq from 1 again, under fresh ids.
    socket.dispatch(toolUse('S', 'run-1-frame', 1));
    socket.dispatch(toolUse('S', 'run-2-frame', 1));

    assert.deepEqual(toolIds(chat.rows('S')), ['run-1-frame', 'run-2-frame']);
  });

  it('does not deduplicate frames that carry no seq', () => {
    const socket = createSocket();
    const chat = renderChat(socket, 'S');

    socket.dispatch({ ...toolUse('S', 'unsequenced', 1), seq: undefined });
    socket.dispatch({ ...toolUse('S', 'unsequenced', 1), seq: undefined });

    assert.deepEqual(toolIds(chat.rows('S')), ['unsequenced', 'unsequenced']);
  });
});

describe('a run\'s complete', () => {
  it('forgets the frames of that session\'s run, and only of that session', () => {
    const socket = createSocket();
    const chat = renderChat(socket, 'A');

    socket.dispatch(toolUse('A', 'a-frame', 1));
    socket.dispatch(toolUse('B', 'b-frame', 1));
    socket.dispatch(complete('A', 'a-complete', 2));

    // The server replays only running runs, so a frame of A's finished run can
    // only be new; B's run is still going, and its replay is still a replay.
    socket.dispatch(toolUse('A', 'a-frame', 1));
    socket.dispatch(toolUse('B', 'b-frame', 1));

    assert.deepEqual(toolIds(chat.rows('A')), ['a-frame', 'a-frame']);
    assert.deepEqual(toolIds(chat.rows('B')), ['b-frame']);
  });
});
