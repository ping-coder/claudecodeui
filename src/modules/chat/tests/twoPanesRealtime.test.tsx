import assert from 'node:assert/strict';

import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { memo, useLayoutEffect } from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import '@/modules/i18n';
import { ChatInstancesProvider as BarrelChatInstancesProvider } from '@/modules/chat';
import ChatInterface from '@/modules/chat/ChatInterface';
import { ChatInstancesProvider, useChatInstanceCoordinator } from '@/modules/chat/context/ChatInstancesContext';
import {
  SessionProtectionProvider,
  useProcessingSessions,
  useSessionProtectionActions,
} from '@/shared/context/SessionProtectionContext';
import { WorkspacePaneProvider } from '@/shared/context/WorkspacePaneContext';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type * as ComposerStateModule from '@/modules/chat/hooks/useChatComposerState';
import type {
  PermissionMode,
  Project,
  ProjectSession,
  ServerEvent,
  SessionActivityMap,
  WorkspacePaneSide,
} from '@/shared/types';
import type * as SharedUtils from '@/shared/utils';

/**
 * A split workspace mounts two ChatInterfaces on one websocket, and each hears
 * every frame. Before the chats coordinated, two sessions streaming at once
 * mixed their text in one buffer, a session switch dropped a background
 * stream's text, a frame naming no session idled both panes' sessions, an idle
 * ack for the other pane's subscribe bypassed the stale-ack guard, both chats
 * wrote a session's background work (the last writer won), and every sound
 * played once per chat.
 *
 * The chats here are real, with their session, provider and realtime state
 * and the real activity map; the composer, which this is not about, stands in
 * with the little ChatInterface reads from it (only the test of one session
 * in both composers runs the real one), and the transcript pane lists the rows
 * it is handed.
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
    sounds: { completion: 0, notification: 0, title: 0 },
    /** What each pane wrote to the socket, in order. */
    sent: [] as Array<{ side: string; message: unknown }>,
    /** The persisted transcript a history read returns, per session; empty when unset. */
    history: new Map<string, unknown[]>(),
  };
});

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: page.subscribe }),
}));

vi.mock('@/shared/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedUtils>()),
  playChatCompletionSound: async () => {
    page.sounds.completion += 1;
  },
  playNotificationSound: async () => {
    page.sounds.notification += 1;
  },
}));

vi.mock('@/modules/chat/utils/pageTitleNotification', () => ({
  showCompletionTitleIndicator: () => {
    page.sounds.title += 1;
  },
}));

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  const notOk = () => Promise.resolve({ ok: false, json: async () => ({}) });
  return {
    ApiRequestError: class ApiRequestError extends Error {},
    api: {
      // The running-sessions poll stays out of the activity map these tests drive.
      runningSessions: notOk,
      user: {
        preferences: () => okJson({ success: true, preferences: {} }),
        savePreferences: () => okJson({ success: true, preferences: {} }),
        drafts: () => okJson({ success: true, drafts: [] }),
        saveDraft: () => okJson({ success: true }),
        deleteDraft: () => okJson({ success: true }),
        appendQueuedMessage: () => okJson({ queuedMessage: { content: 'queued from left' }, appended: false }),
        clearQueuedMessage: () => okJson({ success: true }),
      },
      commands: { list: () => okJson({ success: true, commands: [] }) },
      files: { search: () => okJson({ success: true, files: [] }) },
      getFiles: notOk,
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

const session = (id: string): ProjectSession => ({ id, __provider: 'claude', __projectId: PROJECT.projectId } as ProjectSession);
const SESSION_A = session('session-a');
const SESSION_B = session('session-b');

// Any object: the chats only check that a socket exists before subscribing.
const SOCKET = {} as WebSocket;

/** One stable writer per side, as the workspace hands each pane the page's `sendMessage`. */
const sendFrom: Record<WorkspacePaneSide, (message: unknown) => void> = {
  left: (message) => {
    page.sent.push({ side: 'left', message });
  },
  right: (message) => {
    page.sent.push({ side: 'right', message });
  },
};

/** What the activity map and its actions look like from inside the providers. */
const activity: { map: SessionActivityMap; actions: ReturnType<typeof useSessionProtectionActions> | null } = {
  map: new Map(),
  actions: null,
};

function ActivityProbe() {
  const map = useProcessingSessions();
  const actions = useSessionProtectionActions();
  useLayoutEffect(() => {
    activity.map = map;
    activity.actions = actions;
  });
  return null;
}

type PaneProps = { side: WorkspacePaneSide; session: ProjectSession | null; focused: boolean; newSessionTrigger?: number };

function Pane({ side, session: selectedSession, focused, newSessionTrigger }: PaneProps) {
  return (
    <section data-testid={`pane-${side}`}>
      <WorkspacePaneProvider
        value={{ side, isFocusedPane: focused, isSplitPane: true, openFileInEditor: null, openDirectory: null }}
      >
        <ChatInterface
          isActive
          selectedProject={PROJECT}
          selectedSession={selectedSession}
          ws={SOCKET}
          sendMessage={sendFrom[side]}
          newSessionTrigger={newSessionTrigger}
        />
      </WorkspacePaneProvider>
    </section>
  );
}

type WorkspaceProps = {
  left: Omit<PaneProps, 'side'>;
  /** Absent until the user splits. */
  right?: Omit<PaneProps, 'side'>;
};

function Workspace({ left, right }: WorkspaceProps) {
  return (
    <SessionProtectionProvider>
      <ChatInstancesProvider>
        <ActivityProbe />
        <Pane side="left" {...left} />
        {right && <Pane side="right" {...right} />}
      </ChatInstancesProvider>
    </SessionProtectionProvider>
  );
}

/** Mounts the workspace and lets the chats' first loads settle. */
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

const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

/** Waits out the chats' 100 ms stream flush. */
const flushStreams = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
});

const dispatch = (event: Record<string, unknown>) => {
  act(() => {
    for (const listener of page.listeners) {
      listener({ provider: 'claude', timestamp: '2026-10-27T10:00:00.000Z', ...event } as ServerEvent);
    }
  });
};

/** The rows a pane's transcript shows, as text. */
const transcript = (side: WorkspacePaneSide) => within(screen.getByTestId(`pane-${side}`))
  .queryAllByRole('listitem')
  .map((row) => row.textContent);

/** The seq each session's run has reached: the server numbers every run's frames from 1. */
const runSeqs = new Map<string, number>();
const delta = (sessionId: string, content: string) => {
  const seq = (runSeqs.get(sessionId) ?? 0) + 1;
  runSeqs.set(sessionId, seq);
  dispatch({ kind: 'stream_delta', id: `${sessionId}-delta-${seq}`, sessionId, seq, content });
};

beforeEach(() => {
  page.sounds.completion = 0;
  page.sounds.notification = 0;
  page.sounds.title = 0;
  page.sent.length = 0;
  page.history.clear();
  runSeqs.clear();
  localStorage.clear();
  resetChatDrafts();
  // The transcript pane is a stand-in, so nothing is there to scroll.
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('streamed text', () => {
  it('stays with its own session when two sessions stream at once', async () => {
    await renderWorkspace({
      left: { session: SESSION_A, focused: true },
      right: { session: SESSION_B, focused: false },
    });

    delta('session-a', 'Hello ');
    delta('session-b', 'Bonjour ');
    delta('session-a', 'world');
    delta('session-b', 'le monde');
    await flushStreams();

    assert.deepEqual(transcript('left'), ['Hello world']);
    assert.deepEqual(transcript('right'), ['Bonjour le monde']);
  });

  for (const away of ['another session', 'a new chat'] as const) {
    it(`a session keeps what it streamed while the pane showed ${away}`, async () => {
      const workspace = await renderWorkspace({ left: { session: SESSION_A, focused: true } });

      delta('session-a', 'Hello ');
      await flushStreams();
      assert.deepEqual(transcript('left'), ['Hello ']);

      // The pane moves on while A goes on streaming in the background.
      await workspace.rerender({
        left: away === 'a new chat'
          ? { session: null, focused: true, newSessionTrigger: 1 }
          : { session: SESSION_B, focused: true },
      });
      delta('session-a', 'world');
      await flushStreams();

      await workspace.rerender({
        left: { session: SESSION_A, focused: true, newSessionTrigger: away === 'a new chat' ? 1 : undefined },
      });
      assert.deepEqual(transcript('left'), ['Hello world']);
    });
  }
});

describe('a frame that names no session', () => {
  it('shows in the focused pane only, and idles only the session it shows', async () => {
    await renderWorkspace({
      left: { session: SESSION_A, focused: true },
      right: { session: SESSION_B, focused: false },
    });
    act(() => {
      activity.actions?.markSessionProcessing('session-a');
      activity.actions?.markSessionProcessing('session-b');
    });

    dispatch({ kind: 'protocol_error', code: 'INTERNAL_ERROR', error: 'Request failed: boom' });

    assert.deepEqual(transcript('left'), ['Request failed: boom']);
    assert.deepEqual(transcript('right'), []);
    assert.equal(activity.map.has('session-a'), false);
    assert.equal(activity.map.has('session-b'), true, 'the unfocused pane\'s session keeps running');
  });

  it('reaches the unfocused pane too when it is the reconnect, so each pane subscribes its session again', async () => {
    await renderWorkspace({
      left: { session: SESSION_A, focused: true },
      right: { session: SESSION_B, focused: false },
    });
    page.sent.length = 0;

    // The socket came back: only a fresh subscribe re-attaches a run's live stream to it.
    dispatch({ kind: 'websocket_reconnected' });

    await waitFor(() => {
      const resubscribed = page.sent
        .map(({ side, message }) => ({ side, message: message as { type?: string; sessions?: Array<{ sessionId: string }> } }))
        .filter(({ message }) => message.type === 'chat.subscribe')
        .map(({ side, message }) => `${side}:${message.sessions?.[0]?.sessionId}`);
      assert.deepEqual(resubscribed.sort(), ['left:session-a', 'right:session-b']);
    });
  });
});

describe('an idle subscribe ack', () => {
  it('leaves a turn that started after the subscribe running, in the pane that never subscribed too', async () => {
    // The left pane subscribes A on mount; the right pane never does.
    await renderWorkspace({
      left: { session: SESSION_A, focused: true },
      right: { session: SESSION_B, focused: false },
    });
    // A send starts a new turn on A before the server's ack for that subscribe comes back.
    act(() => {
      activity.actions?.markSessionProcessing('session-a');
    });

    dispatch({ kind: 'chat_subscribed', sessionId: 'session-a', isProcessing: false, pendingPermissions: [] });

    assert.equal(activity.map.has('session-a'), true);
  });
});

describe('a session\'s background work', () => {
  /** A's workflow launch: the call, its background ack and the task's start. */
  const workflowLaunchRows = (): Array<Record<string, unknown>> => [
    { kind: 'tool_use', id: 'launch', sessionId: 'session-a', toolId: 'toolu_workflow_1', toolName: 'Workflow', toolInput: { script: '', description: 'Audit' } },
    { kind: 'tool_result', id: 'launch-ack', sessionId: 'session-a', toolId: 'toolu_workflow_1', content: 'Workflow launched in background', toolUseResult: { status: 'async_launched', taskId: 'w1' } },
    { kind: 'task_status', id: 'launch-status', sessionId: 'session-a', event: 'started', taskId: 'w1', toolUseId: 'toolu_workflow_1', taskType: 'local_workflow', workflowName: 'audit', description: 'Audit' },
  ];

  it('is written by the chat that shows the session, not overwritten by the other pane\'s empty view of it', async () => {
    const workspace = await renderWorkspace({ left: { session: SESSION_A, focused: true } });
    act(() => {
      activity.actions?.markSessionProcessing('session-a');
    });

    // A launches a workflow while only the left pane is open.
    workflowLaunchRows().forEach((row, index) => dispatch({ ...row, seq: index + 1 }));

    // The user splits; the right pane's store has never seen A's launch.
    await workspace.rerender({
      left: { session: SESSION_A, focused: false },
      right: { session: SESSION_B, focused: true },
    });
    dispatch({ kind: 'complete', id: 'done', sessionId: 'session-a', seq: 4, success: true });

    const entry = activity.map.get('session-a');
    assert.equal(entry?.background, true);
    assert.deepEqual(entry?.tasks?.map((task) => task.taskId), ['w1']);
  });

  it('is written by the focused one of two chats showing the session, as it is now', async () => {
    // The left pane read A's history before it held the launch.
    const workspace = await renderWorkspace({ left: { session: SESSION_A, focused: true } });
    act(() => {
      activity.actions?.markSessionProcessing('session-a');
    });
    page.history.set('session-a', workflowLaunchRows().map((row) => ({
      provider: 'claude',
      timestamp: '2026-10-27T10:00:00.000Z',
      ...row,
    })));

    // The user splits, then opens A in the focused right pane, whose read has the launch.
    await workspace.rerender({
      left: { session: SESSION_A, focused: false },
      right: { session: SESSION_B, focused: true },
    });
    await workspace.rerender({
      left: { session: SESSION_A, focused: false },
      right: { session: SESSION_A, focused: true },
    });
    dispatch({ kind: 'complete', id: 'done', sessionId: 'session-a', seq: 4, success: true });

    const entry = activity.map.get('session-a');
    assert.equal(entry?.background, true);
    assert.deepEqual(entry?.tasks?.map((task) => task.taskId), ['w1']);
  });
});

describe('sounds and the title marker', () => {
  it('play once on the page for a completion and for a permission prompt', async () => {
    await renderWorkspace({
      left: { session: SESSION_A, focused: true },
      right: { session: SESSION_B, focused: false },
    });

    dispatch({ kind: 'complete', id: 'c1', sessionId: 'session-a', seq: 9, success: true });
    dispatch({ kind: 'permission_request', id: 'p1', requestId: 'r1', toolName: 'Bash', sessionId: 'session-b', seq: 3 });

    assert.deepEqual(page.sounds, { completion: 1, title: 1, notification: 1 });
  });

  it('play again for the next run of the same session that completes', async () => {
    await renderWorkspace({
      left: { session: SESSION_A, focused: true },
      right: { session: SESSION_B, focused: false },
    });

    dispatch({ kind: 'complete', id: 'run-1-complete', sessionId: 'session-a', seq: 4, success: true });
    // The next run counts seq from 1 again, under its own ids.
    dispatch({ kind: 'complete', id: 'run-2-complete', sessionId: 'session-a', seq: 2, success: true });

    assert.deepEqual(page.sounds, { completion: 2, title: 2, notification: 0 });
  });

  it('do not sound again for a prompt the subscribe ack already announced and the replay delivers', async () => {
    await renderWorkspace({
      left: { session: SESSION_A, focused: true },
      right: { session: SESSION_B, focused: false },
    });

    // A mid-run refresh of A: the ack lists the open prompt, then the replay re-sends its request.
    dispatch({
      kind: 'chat_subscribed',
      sessionId: 'session-a',
      isProcessing: true,
      pendingPermissions: [{ requestId: 'r2', toolName: 'Bash', sessionId: 'session-a' }],
    });
    dispatch({ kind: 'permission_request', id: 'p2', requestId: 'r2', toolName: 'Bash', sessionId: 'session-a', seq: 5 });

    assert.equal(page.sounds.notification, 1);
  });
});

describe('one session open in both panes', () => {
  // What showing one session twice is accepted to do (SPEC, accepted limits),
  // pinned here so that a change to it is a deliberate one.
  it('mirrors the composer text, while a queued follow-up shows only in the pane that queued it', async () => {
    const { useChatComposerState: useRealComposerState } = await vi.importActual<typeof ComposerStateModule>(
      '@/modules/chat/hooks/useChatComposerState',
    );
    const renderComposer = () => renderHook(() => useRealComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION_A,
      currentSessionId: SESSION_A.id,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      // A turn is running, so a send queues instead.
      isLoading: true,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: () => undefined,
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }));
    const left = renderComposer();
    const right = renderComposer();

    // Both composers write the session's one draft.
    await act(async () => {
      left.result.current.setInput('typed in left');
    });
    assert.equal(right.result.current.input, 'typed in left');

    await act(async () => {
      await left.result.current.handleSubmit({ preventDefault: () => undefined } as never);
    });
    assert.equal(left.result.current.queuedDraft?.content, 'queued from left');
    assert.equal(right.result.current.queuedDraft, null);
    assert.equal(right.result.current.input, '');
  });
});

describe('the page coordinator', () => {
  /** `render` only forces a render of this probe alone. */
  type ChatProbeProps = { name: string; view: string | null; focused: boolean; render?: number };
  const coordinators = new Map<string, ReturnType<typeof useChatInstanceCoordinator>>();

  function ChatProbe({ name, view, focused }: ChatProbeProps) {
    coordinators.set(name, useChatInstanceCoordinator({ getViewedSessionId: () => view, getIsFocused: () => focused }));
    return null;
  }

  const renderChats = (chats: ChatProbeProps[], wrapper: (children: ReactNode) => ReactNode = (children) => (
    <ChatInstancesProvider>{children}</ChatInstancesProvider>
  )) => {
    const tree = (list: ChatProbeProps[]) => wrapper(list.map((chat) => <ChatProbe key={chat.name} {...chat} />));
    const view = render(<>{tree(chats)}</>);
    return { rerender: (next: ChatProbeProps[]) => view.rerender(<>{tree(next)}</>) };
  };

  const reporterOf = (sessionId: string) => [...coordinators]
    .filter(([, coordinator]) => coordinator.isBackgroundReporter(sessionId))
    .map(([name]) => name);

  beforeEach(() => {
    coordinators.clear();
  });

  it('elects the focused chat among those showing a session, else the earliest of them', () => {
    const chats = renderChats([
      { name: 'left', view: 'S', focused: false },
      { name: 'right', view: 'S', focused: true },
    ]);
    assert.deepEqual(reporterOf('S'), ['right']);

    chats.rerender([
      { name: 'left', view: 'S', focused: false },
      { name: 'right', view: 'S', focused: false },
    ]);
    assert.deepEqual(reporterOf('S'), ['left']);

    // A chat showing the session wins over the focused chat that does not.
    chats.rerender([
      { name: 'left', view: 'S', focused: false },
      { name: 'right', view: 'T', focused: true },
    ]);
    assert.deepEqual(reporterOf('S'), ['left']);
    assert.deepEqual(reporterOf('T'), ['right']);
  });

  it('gives a session nobody shows to the earliest chat still mounted', () => {
    const chats = renderChats([
      { name: 'left', view: 'S', focused: true },
      { name: 'right', view: 'T', focused: false },
    ]);
    assert.deepEqual(reporterOf('unseen'), ['left']);

    chats.rerender([{ name: 'right', view: 'T', focused: true }]);
    coordinators.delete('left');
    assert.deepEqual(reporterOf('unseen'), ['right']);
  });

  it('shares subscribe times and lets one chat claim each page effect', () => {
    renderChats([
      { name: 'left', view: 'S', focused: true },
      { name: 'right', view: 'T', focused: false },
    ]);
    const left = coordinators.get('left')!;
    const right = coordinators.get('right')!;

    assert.equal(left.statusCheckSentAtRef, right.statusCheckSentAtRef);
    assert.equal(left.claimPageEffect('complete:S:9:c1'), true);
    assert.equal(right.claimPageEffect('complete:S:9:c1'), false);
    assert.equal(left.claimPageEffect('complete:S:9:c1'), false);
    assert.equal(right.claimPageEffect('perm:T:r1'), true);
  });

  it('remembers a bounded number of page effects', () => {
    renderChats([{ name: 'only', view: 'S', focused: true }]);
    const only = coordinators.get('only')!;

    assert.equal(only.claimPageEffect('first'), true);
    for (let index = 0; index < 500; index += 1) {
      only.claimPageEffect(`later-${index}`);
    }
    assert.equal(only.claimPageEffect('first'), true, 'the oldest key is forgotten first');
  });

  it('without a provider leaves each chat on its own, as before the split', () => {
    renderChats([
      { name: 'left', view: 'S', focused: true },
      { name: 'right', view: 'S', focused: false },
    ], (children) => <>{children}</>);
    const left = coordinators.get('left')!;
    const right = coordinators.get('right')!;

    assert.notEqual(left.statusCheckSentAtRef, right.statusCheckSentAtRef);
    assert.equal(left.claimPageEffect('complete:S:9:c1'), true);
    assert.equal(right.claimPageEffect('complete:S:9:c1'), true);
    assert.deepEqual(reporterOf('S'), ['left', 'right']);
  });

  it('keeps what the page claimed, and its chats, when the provider renders again', () => {
    // The provider re-renders with the route above it; a registry made anew on a render would
    // forget the keys claimed so far and sound every effect a second time.
    function PageAbove({ generation }: { generation: number }) {
      return (
        <ChatInstancesProvider>
          <ChatProbe name="left" view="S" focused={false} render={generation} />
          <ChatProbe name="right" view="T" focused render={generation} />
        </ChatInstancesProvider>
      );
    }
    const view = render(<PageAbove generation={0} />);
    assert.equal(coordinators.get('left')!.claimPageEffect('complete:S:9:c1'), true);

    view.rerender(<PageAbove generation={1} />);

    assert.equal(coordinators.get('right')!.claimPageEffect('complete:S:9:c1'), false);
    assert.equal(coordinators.get('left')!.statusCheckSentAtRef, coordinators.get('right')!.statusCheckSentAtRef);
    assert.deepEqual(reporterOf('S'), ['left']);
    assert.deepEqual(reporterOf('unseen'), ['left']);
  });

  it('is the provider the chat barrel exports for the workspace route to mount', () => {
    assert.equal(BarrelChatInstancesProvider, ChatInstancesProvider);
  });

  it('keeps a chat\'s place in the election when it renders again on its own', () => {
    // Each render hands the coordinator new getters; the chat must not move
    // behind a chat mounted after it, which did not render.
    const MemoChatProbe = memo(ChatProbe);
    const tree = (leftRender: number) => (
      <ChatInstancesProvider>
        <MemoChatProbe key="left" name="left" view="S" focused={false} render={leftRender} />
        <MemoChatProbe key="right" name="right" view="S" focused={false} render={0} />
      </ChatInstancesProvider>
    );
    const view = render(tree(0));
    assert.deepEqual(reporterOf('S'), ['left']);

    view.rerender(tree(1));
    assert.deepEqual(reporterOf('S'), ['left']);
  });
});
