import assert from 'node:assert/strict';

import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import '@/modules/i18n';
import ChatInterface from '@/modules/chat/ChatInterface';
import { ChatInstancesProvider } from '@/modules/chat/context/ChatInstancesContext';
import { SessionProtectionProvider } from '@/shared/context/SessionProtectionContext';
import { WorkspacePaneProvider } from '@/shared/context/WorkspacePaneContext';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { Project, ProjectSession, ServerEvent, WorkspacePaneSide } from '@/shared/types';

/**
 * Every chat on the page hears every frame of the one socket, also the frames
 * of a run it only overhears because another chat attached the socket to it.
 * A chat mounted while such a run was going (the right pane after a split, the
 * pane a phone remounts, a chat reopened after its last tab closed) used to
 * store what it overheard: the tail of a reply without its beginning, and a
 * seq high enough that opening the session asked the server for nothing
 * earlier. Opening it with nothing heard, the live frames that came before the
 * replay were stored first and the reply came out of order. Neither row was
 * ever replaced, as a history read only drops a live row whose text it has
 * word for word.
 *
 * A chat now stores a session's frames only from the start of its run: the
 * replay its own subscribe asks for, or the run's first live frame. The server
 * side here is what chat.subscribe does: attach, ack, then replay the running
 * run's frames after `lastSeq`.
 */

const page = vi.hoisted(() => {
  const listeners = new Set<(event: unknown) => void>();
  return {
    listeners,
    subscribe: (listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** What each pane wrote to the socket, in order. */
    sent: [] as Array<{ side: string; message: unknown }>,
    /** The persisted transcript a history read returns, per session; empty when unset. */
    history: new Map<string, unknown[]>(),
  };
});

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: page.subscribe }),
}));

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  const notOk = () => Promise.resolve({ ok: false, json: async () => ({}) });
  return {
    ApiRequestError: class ApiRequestError extends Error {},
    api: {
      runningSessions: notOk,
      user: {
        preferences: () => okJson({ success: true, preferences: {} }),
        savePreferences: () => okJson({ success: true, preferences: {} }),
      },
      providers: {
        models: () => okJson({ success: false }),
        capabilities: () => okJson({ success: false }),
        sessionActiveModel: () => okJson({ success: false }),
        sessionTokenUsage: notOk,
        sessionMessages: (sessionId: string) => {
          const messages = page.history.get(sessionId) ?? [];
          return okJson({ success: true, data: { messages, total: messages.length, hasMore: false } });
        },
        skills: notOk,
      },
    },
  };
});

vi.mock('@/modules/chat/hooks/useChatComposerState', () => ({
  useChatComposerState: () => ({ input: '', setInput: () => undefined, textareaRef: { current: null } }),
}));
vi.mock('@/modules/chat/composer/useScheduledMessages', () => ({
  useScheduledMessages: () => ({ scheduledMessages: [], schedule: async () => false, cancel: () => undefined }),
}));
vi.mock('@/modules/chat/composer/ChatComposer', () => ({ default: () => null }));
vi.mock('@/modules/chat/modals/CommandResultModal', () => ({ default: () => null }));
vi.mock('@/modules/task-master', () => ({ useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }) }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOpsRegister: () => undefined }));
vi.mock('@/modules/chat/transcript/ChatMessagesPane', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ chatMessages }: { chatMessages: Array<{ content?: string }> }) => createElement(
      'ol',
      null,
      chatMessages.map((message, index) => createElement('li', { key: index }, message.content ?? '')),
    ),
  };
});

const PROJECT: Project = { projectId: 'project-1', path: '/repo', fullPath: '/repo', displayName: 'Repo', isStarred: false };

// agy streams its replies as deltas, which is where a missing beginning shows.
const session = (id: string): ProjectSession => ({ id, __provider: 'agy', __projectId: PROJECT.projectId } as ProjectSession);
const SESSION_A = session('session-a');
const SESSION_B = session('session-b');

// Any object: the chats only check that a socket exists before subscribing.
const SOCKET = {} as WebSocket;

const sendFrom: Record<WorkspacePaneSide, (message: unknown) => void> = {
  left: (message) => {
    page.sent.push({ side: 'left', message });
  },
  right: (message) => {
    page.sent.push({ side: 'right', message });
  },
};

type PaneProps = {
  session: ProjectSession;
  focused: boolean;
  /** The page's socket: null while the connection is lost, a new object once it is back, as the WebSocket context hands it out. */
  socket?: WebSocket | null;
};

function Pane({ side, session: selectedSession, focused, socket = SOCKET }: PaneProps & { side: WorkspacePaneSide }) {
  return (
    <section data-testid={`pane-${side}`}>
      <WorkspacePaneProvider
        value={{ side, isFocusedPane: focused, isSplitPane: true, openFileInEditor: null, openDirectory: null }}
      >
        <ChatInterface
          isActive
          selectedProject={PROJECT}
          selectedSession={selectedSession}
          ws={socket}
          sendMessage={sendFrom[side]}
        />
      </WorkspacePaneProvider>
    </section>
  );
}

type WorkspaceProps = {
  /** Changing it remounts the left chat, as reopening a closed pane does. */
  leftMount?: number;
  left?: PaneProps;
  right?: PaneProps;
};

function Workspace({ leftMount = 0, left, right }: WorkspaceProps) {
  return (
    <SessionProtectionProvider>
      <ChatInstancesProvider>
        {left && <Pane key={leftMount} side="left" {...left} />}
        {right && <Pane side="right" {...right} />}
      </ChatInstancesProvider>
    </SessionProtectionProvider>
  );
}

const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

/** Waits out the chats' 100 ms stream flush. */
const flushStreams = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
});

async function renderWorkspace(props: WorkspaceProps) {
  const view = render(<Workspace {...props} />);
  await settle();
  return {
    rerender: async (next: WorkspaceProps) => {
      view.rerender(<Workspace {...next} />);
      await settle();
    },
  };
}

const dispatch = (frame: Record<string, unknown>) => {
  act(() => {
    for (const listener of page.listeners) {
      listener({ provider: 'agy', timestamp: '2026-01-01T10:00:00.000Z', ...frame } as ServerEvent);
    }
  });
};

/** The server's side of a session: its current run's frames, numbered from 1 as the run registry does. */
type Run = { processing: boolean; frames: Array<Record<string, unknown>> };
const runs = new Map<string, Run>();

/** Starts a run of `sessionId`; its frames count seq from 1 again. */
const startRun = (sessionId: string) => {
  runs.set(sessionId, { processing: true, frames: [] });
};

/** Numbers a frame of the session's run and buffers it for replay, as the run registry does. */
const record = (sessionId: string, frame: Record<string, unknown>) => {
  const run = runs.get(sessionId);
  if (!run) {
    throw new Error(`no run for ${sessionId}`);
  }
  const sequenced = { ...frame, sessionId, seq: run.frames.length + 1 };
  run.frames.push(sequenced);
  if (frame.kind === 'complete') {
    run.processing = false;
  }
  return sequenced;
};

/** A live frame of the session's run, sent to the page (some chat attached the socket to the run). */
const emit = (sessionId: string, frame: Record<string, unknown>) => {
  dispatch(record(sessionId, frame));
};

const deltaFrame = (sessionId: string, content: string) => ({
  kind: 'stream_delta',
  // agy streams every delta of a part under the part's id.
  id: `${sessionId}:part:text`,
  content,
});

const delta = (sessionId: string, content: string) => emit(sessionId, deltaFrame(sessionId, content));

/** A delta streamed while the page's socket is away: the server only buffers it. */
const deltaWhileAway = (sessionId: string, content: string) => {
  record(sessionId, deltaFrame(sessionId, content));
};

const endRun = (sessionId: string) => {
  emit(sessionId, { kind: 'stream_end', id: `${sessionId}:part:end` });
  emit(sessionId, { kind: 'complete', id: `${sessionId}:complete`, success: true });
};

type SubscribeMessage = { type?: string; sessions?: Array<{ sessionId: string; lastSeq?: number }> };

/** Every `chat.subscribe` a pane sent, as `session@lastSeq`. */
const subscribesFrom = (side: WorkspacePaneSide) => page.sent
  .filter((entry) => entry.side === side && (entry.message as SubscribeMessage).type === 'chat.subscribe')
  .map((entry) => (entry.message as SubscribeMessage).sessions?.[0])
  .map((target) => `${target?.sessionId}@${target?.lastSeq}`);

/** Answers a subscribe as the server does: the ack, then the running run's frames after `lastSeq`. */
const answerSubscribe = (sessionId: string, lastSeq: number) => {
  const run = runs.get(sessionId);
  dispatch({
    kind: 'chat_subscribed',
    sessionId,
    isProcessing: Boolean(run?.processing),
    lastSeq: run?.frames.length ?? 0,
    pendingPermissions: [],
  });
  if (run?.processing) {
    for (const frame of run.frames) {
      if ((frame.seq as number) > lastSeq) {
        dispatch(frame);
      }
    }
  }
};

/** Answers the latest subscribe a pane sent for `sessionId`, with the `lastSeq` it asked from. */
const answerLatestSubscribe = (side: WorkspacePaneSide, sessionId: string) => {
  const latest = subscribesFrom(side).filter((entry) => entry.startsWith(`${sessionId}@`)).at(-1);
  if (!latest) {
    throw new Error(`${side} never subscribed ${sessionId}`);
  }
  answerSubscribe(sessionId, Number(latest.split('@')[1]));
};

/** The rows a pane's transcript shows, as text. */
const transcript = (side: WorkspacePaneSide) => within(screen.getByTestId(`pane-${side}`))
  .queryAllByRole('listitem')
  .map((row) => row.textContent);

/** What A's history read returns once its run is persisted. */
const persistA = () => {
  page.history.set('session-a', [
    { id: 'h-user', kind: 'text', role: 'user', content: 'question', sessionId: 'session-a', provider: 'agy', timestamp: '2026-01-01T09:59:00.000Z' },
    { id: 'h-reply', kind: 'text', role: 'assistant', content: 'Hello brave new world', sessionId: 'session-a', provider: 'agy', timestamp: '2026-01-01T10:00:30.000Z' },
  ]);
};

beforeEach(() => {
  page.sent.length = 0;
  page.history.clear();
  runs.clear();
  localStorage.clear();
  resetChatDrafts();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The left pane shows A from the start of its run and streams "Hello brave ". */
async function startWithLeftOnA() {
  startRun('session-a');
  const workspace = await renderWorkspace({ left: { session: SESSION_A, focused: true } });
  answerLatestSubscribe('left', 'session-a');
  delta('session-a', 'Hello ');
  delta('session-a', 'brave ');
  await flushStreams();
  assert.deepEqual(transcript('left'), ['Hello brave ']);
  return workspace;
}

describe('a chat that opens a session another chat already follows mid-run', () => {
  it('asks for the whole run and shows it from its beginning, after a part it only overheard', async () => {
    const workspace = await startWithLeftOnA();

    // The user splits and opens B on the right; A goes on streaming.
    await workspace.rerender({
      left: { session: SESSION_A, focused: false },
      right: { session: SESSION_B, focused: true },
    });
    answerLatestSubscribe('right', 'session-b');
    delta('session-a', 'new ');

    // The right pane takes A (◨, "open on the other side", a dragged tab).
    await workspace.rerender({
      left: { session: SESSION_A, focused: false },
      right: { session: SESSION_A, focused: true },
    });
    assert.deepEqual(subscribesFrom('right'), ['session-b@0', 'session-a@0']);
    answerLatestSubscribe('right', 'session-a');
    delta('session-a', 'world');
    await flushStreams();

    assert.deepEqual(transcript('right'), ['Hello brave new world']);
    assert.deepEqual(transcript('left'), ['Hello brave new world']);

    // The run ends and the history read has the reply word for word.
    persistA();
    endRun('session-a');
    await settle();
    assert.deepEqual(transcript('right'), ['question', 'Hello brave new world']);
  });

  it('keeps the order of a reply whose live frames arrive before the replay', async () => {
    const workspace = await startWithLeftOnA();

    // "Also open the current conversation here": a fresh right chat subscribes A from scratch,
    // and a live frame reaches the page before the server answers that subscribe.
    await workspace.rerender({
      left: { session: SESSION_A, focused: false },
      right: { session: SESSION_A, focused: true },
    });
    assert.deepEqual(subscribesFrom('right'), ['session-a@0']);
    delta('session-a', 'new ');
    answerLatestSubscribe('right', 'session-a');
    delta('session-a', 'world');
    await flushStreams();

    assert.deepEqual(transcript('right'), ['Hello brave new world']);
  });

  it('shows the same for a single pane whose chat was remounted mid-run', async () => {
    const workspace = await startWithLeftOnA();

    // The last tab of A closed and A reopened from the sidebar: a new chat on the same socket.
    await workspace.rerender({ leftMount: 1, left: { session: SESSION_A, focused: true } });
    delta('session-a', 'new ');
    answerLatestSubscribe('left', 'session-a');
    delta('session-a', 'world');
    await flushStreams();

    assert.deepEqual(transcript('left'), ['Hello brave new world']);
  });

  it('leaves nothing it overheard behind once the run it missed the start of is over', async () => {
    const workspace = await startWithLeftOnA();
    await workspace.rerender({
      left: { session: SESSION_A, focused: false },
      right: { session: SESSION_B, focused: true },
    });
    answerLatestSubscribe('right', 'session-b');

    // A finishes while the right pane shows B.
    delta('session-a', 'new world');
    persistA();
    endRun('session-a');
    await settle();

    // Opened afterwards, the finished run has nothing to replay: the history read shows it.
    await workspace.rerender({
      left: { session: SESSION_A, focused: false },
      right: { session: SESSION_A, focused: true },
    });
    answerLatestSubscribe('right', 'session-a');
    await settle();

    assert.deepEqual(transcript('right'), ['question', 'Hello brave new world']);
  });
});

describe('a run whose end the page never heard', () => {
  it('leaves no unfinished text on screen, nor for the next run of the session to continue, in either pane', async () => {
    startRun('session-a');
    const workspace = await renderWorkspace({
      left: { session: SESSION_A, focused: true },
      right: { session: SESSION_B, focused: false },
    });
    answerLatestSubscribe('left', 'session-a');
    answerLatestSubscribe('right', 'session-b');
    delta('session-a', 'Partial ');
    await flushStreams();
    assert.deepEqual(transcript('left'), ['Partial ']);

    // The socket drops and the run ends meanwhile. Back online, the left pane re-reads A's
    // history and subscribes again, and the server answers that A runs nothing now.
    runs.get('session-a')!.processing = false;
    page.history.set('session-a', [
      { id: 'h-user', kind: 'text', role: 'user', content: 'question', sessionId: 'session-a', provider: 'agy', timestamp: '2026-01-01T09:59:00.000Z' },
      { id: 'h-reply', kind: 'text', role: 'assistant', content: 'Partial answer', sessionId: 'session-a', provider: 'agy', timestamp: '2026-01-01T10:00:01.000Z' },
    ]);
    dispatch({ kind: 'websocket_reconnected' });
    await settle();
    answerLatestSubscribe('left', 'session-a');
    await settle();
    assert.deepEqual(transcript('left'), ['question', 'Partial answer']);

    // The left pane goes to B and back; the user sends again. The new run opens with a status
    // frame, so its first delta is numbered past the unfinished one.
    await workspace.rerender({ left: { session: SESSION_B, focused: true }, right: { session: SESSION_B, focused: false } });
    await workspace.rerender({ left: { session: SESSION_A, focused: true }, right: { session: SESSION_B, focused: false } });
    answerLatestSubscribe('left', 'session-a');
    startRun('session-a');
    emit('session-a', { kind: 'status', id: 'run-2:status', text: 'Thinking' });
    emit('session-a', { kind: 'stream_delta', id: 'run-2:part:text', content: 'Fresh answer' });
    await flushStreams();
    assert.deepEqual(transcript('left'), ['question', 'Partial answer', 'Fresh answer']);

    // The right pane overheard the first run from its start, and the same ack reached it.
    await workspace.rerender({ left: { session: SESSION_A, focused: false }, right: { session: SESSION_A, focused: true } });
    answerLatestSubscribe('right', 'session-a');
    await flushStreams();
    assert.deepEqual(transcript('right'), ['question', 'Partial answer', 'Fresh answer']);
  });
});

// The seq a chat subscribes with is the last one it heard of the session's run. A run counts seq
// from 1 again, and two runs in a row send no subscribe in between, so a chat that kept the seq
// the earlier run ended on asked a reconnect during the later one for frames past that number:
// the server had none to replay, the text streamed while the socket was away never came, and the
// unfinished reply stayed beside the history's whole one.
describe('a reconnect during a later run of the session', () => {
  const RECONNECTED_SOCKET = {} as WebSocket;

  const historyRow = (id: string, role: 'user' | 'assistant', content: string, timestamp: string) => (
    { id, kind: 'text', role, content, sessionId: 'session-a', provider: 'agy', timestamp }
  );
  const FIRST_TURN = [
    historyRow('h-q1', 'user', 'q1', '2026-01-01T09:58:00.000Z'),
    historyRow('h-a1', 'assistant', 'one two three four five six ', '2026-01-01T09:58:30.000Z'),
  ];
  const SECOND_QUESTION = historyRow('h-q2', 'user', 'q2', '2026-01-01T09:59:00.000Z');
  const SECOND_REPLY = historyRow('h-a2', 'assistant', 'Hello brave new world', '2026-01-01T10:00:30.000Z');

  it('replays what the run streamed while the socket was away, in a single pane', async () => {
    // The first run's reply, numbered 1 to 8 with its stream_end and complete.
    startRun('session-a');
    const workspace = await renderWorkspace({ left: { session: SESSION_A, focused: true } });
    answerLatestSubscribe('left', 'session-a');
    for (const word of ['one ', 'two ', 'three ', 'four ', 'five ', 'six ']) {
      delta('session-a', word);
    }
    page.history.set('session-a', FIRST_TURN);
    endRun('session-a');
    await settle();
    assert.deepEqual(transcript('left'), ['q1', 'one two three four five six ']);

    // The user sends again from the same chat, and the second run streams.
    startRun('session-a');
    page.history.set('session-a', [...FIRST_TURN, SECOND_QUESTION]);
    delta('session-a', 'Hello ');
    delta('session-a', 'brave ');
    await flushStreams();

    // The connection drops, and the run streams on meanwhile.
    await workspace.rerender({ left: { session: SESSION_A, focused: true, socket: null } });
    deltaWhileAway('session-a', 'new ');
    deltaWhileAway('session-a', 'world');

    // Back online: the socket comes back and the chat hears the reconnect, re-reads the history and
    // subscribes again. The server answers each subscribe from the seq it carries.
    dispatch({ kind: 'websocket_reconnected' });
    await workspace.rerender({ left: { session: SESSION_A, focused: true, socket: RECONNECTED_SOCKET } });
    await settle();
    const resubscribes = subscribesFrom('left').slice(1);
    for (const target of resubscribes) {
      answerSubscribe('session-a', Number(target.split('@')[1]));
    }
    await flushStreams();
    assert.deepEqual(transcript('left'), ['q1', 'one two three four five six ', 'q2', 'Hello brave new world']);
    // From the last frame of this run the chat heard, not the last of the run before.
    assert.deepEqual(resubscribes, ['session-a@2', 'session-a@2']);

    // The run ends, and the history read has the reply word for word: nothing of it is left over.
    page.history.set('session-a', [...FIRST_TURN, SECOND_QUESTION, SECOND_REPLY]);
    endRun('session-a');
    await settle();
    assert.deepEqual(transcript('left'), ['q1', 'one two three four five six ', 'q2', 'Hello brave new world']);
  });
});
