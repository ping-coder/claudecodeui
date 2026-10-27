import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import '@/modules/i18n';
import ChatInterface from '@/modules/chat/ChatInterface';
import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { ChatInstancesProvider } from '@/modules/chat/context/ChatInstancesContext';
import { SessionProtectionProvider, useSessionProtectionActions } from '@/shared/context/SessionProtectionContext';
import { WorkspacePaneProvider } from '@/shared/context/WorkspacePaneContext';
import type { ChatMessage, NormalizedMessage, Project, ProjectSession, WorkspacePaneSide } from '@/shared/types';

/**
 * Two chats share the page in a split workspace, but a key press, text handed
 * over by another module and the page-wide provider choice each mean one
 * pane: the focused one. Before, the first chat to register its Esc listener
 * stopped its run whichever pane the user was in, the composer that last
 * registered took quick-settings text, and a session opened in the background
 * pane changed the provider new chats start with. A sent message's local echo
 * read that page-wide provider too, rather than the chat's own.
 */

type ComposerStandIn = {
  input: string;
  setInput: (next: string | ((previous: string) => string)) => void;
  textareaRef: { current: null };
  handleAbortSession: () => void;
};

const page = vi.hoisted(() => ({
  aborts: [] as string[],
  inputs: new Map<string, string>(),
  composerInserts: [] as Array<(text: string) => void>,
  providerWrites: [] as string[],
  composersBySession: new Map<string, ComposerStandIn>(),
}));

// Stands in for the composer: Esc's abort and the input setter are all
// ChatInterface takes from it here, one stable set per session so each pane's
// are told apart.
vi.mock('@/modules/chat/hooks/useChatComposerState', () => ({
  useChatComposerState: ({ selectedSession }: { selectedSession: ProjectSession | null }) => {
    const sessionKey = selectedSession?.id ?? 'draft';
    let composer = page.composersBySession.get(sessionKey);
    if (!composer) {
      composer = {
        input: '',
        setInput: (next) => {
          const previous = page.inputs.get(sessionKey) ?? '';
          page.inputs.set(sessionKey, typeof next === 'function' ? next(previous) : next);
        },
        textareaRef: { current: null },
        handleAbortSession: () => {
          page.aborts.push(sessionKey);
        },
      };
      page.composersBySession.set(sessionKey, composer);
    }
    return composer;
  },
}));

// The palette's registry, as a stack: the newest registration answers, and a
// cleanup removes only its own entry.
vi.mock('@/modules/command-palette', async () => {
  const { useEffect } = await import('react');
  return {
    usePaletteOpsRegister: ({ insertComposerText }: { insertComposerText?: (text: string) => void }) => {
      useEffect(() => {
        if (!insertComposerText) {
          return undefined;
        }
        page.composerInserts.push(insertComposerText);
        return () => {
          page.composerInserts.splice(page.composerInserts.indexOf(insertComposerText), 1);
        };
      }, [insertComposerText]);
    },
  };
});

vi.mock('@/shared/selectedProvider', () => ({
  readSelectedProvider: () => 'claude',
  writeSelectedProvider: (provider: string) => {
    page.providerWrites.push(provider);
  },
}));

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  const notOk = () => Promise.resolve({ ok: false, json: async () => ({}) });
  return {
    api: {
      runningSessions: notOk,
      providers: {
        models: () => okJson({ success: false }),
        capabilities: () => okJson({ success: false }),
        sessionActiveModel: () => okJson({ success: false }),
        sessionTokenUsage: notOk,
        sessionMessages: () => okJson({ success: true, data: { messages: [], total: 0, hasMore: false } }),
      },
    },
  };
});

vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: () => () => undefined }) }));
vi.mock('@/modules/chat/composer/useScheduledMessages', () => ({
  useScheduledMessages: () => ({ scheduledMessages: [], schedule: async () => false, cancel: () => undefined }),
}));
vi.mock('@/modules/chat/composer/ChatComposer', () => ({ default: () => null }));
vi.mock('@/modules/chat/modals/CommandResultModal', () => ({ default: () => null }));
vi.mock('@/modules/chat/transcript/ChatMessagesPane', () => ({ default: () => null }));
vi.mock('@/modules/task-master', () => ({ useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }) }));

const PROJECT: Project = { projectId: 'project-1', path: '/repo', fullPath: '/repo', displayName: 'Repo', isStarred: false };

const session = (id: string, provider: ProjectSession['__provider'] = 'claude'): ProjectSession => (
  { id, __provider: provider, __projectId: PROJECT.projectId } as ProjectSession
);
const SESSION_A = session('session-a');
const SESSION_B = session('session-b');

/** The activity map's actions, as the providers hand them out. */
const sessionProtection: { markSessionProcessing: ((sessionId: string) => void) | null } = { markSessionProcessing: null };

function ActionsProbe() {
  const { markSessionProcessing } = useSessionProtectionActions();
  useLayoutEffect(() => {
    sessionProtection.markSessionProcessing = markSessionProcessing;
  });
  return null;
}

type PaneState = { focused: boolean; isActive?: boolean };

function Pane({ side, session: selectedSession, focused, isActive = true }: PaneState & { side: WorkspacePaneSide; session: ProjectSession }) {
  return (
    <WorkspacePaneProvider value={{ side, isFocusedPane: focused, isSplitPane: true, openFileInEditor: null, openDirectory: null }}>
      <ChatInterface
        isActive={isActive}
        selectedProject={PROJECT}
        selectedSession={selectedSession}
        ws={{} as WebSocket}
        sendMessage={() => undefined}
      />
    </WorkspacePaneProvider>
  );
}

function Workspace({ left, right }: { left: PaneState; right: PaneState }) {
  return (
    <SessionProtectionProvider>
      <ChatInstancesProvider>
        <ActionsProbe />
        <Pane side="left" session={SESSION_A} {...left} />
        <Pane side="right" session={SESSION_B} {...right} />
      </ChatInstancesProvider>
    </SessionProtectionProvider>
  );
}

const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

async function renderWorkspace(left: PaneState, right: PaneState) {
  const view = render(<Workspace left={left} right={right} />);
  await settle();
  return {
    rerender: async (nextLeft: PaneState, nextRight: PaneState) => {
      view.rerender(<Workspace left={nextLeft} right={nextRight} />);
      await settle();
    },
  };
}

beforeEach(() => {
  page.aborts.length = 0;
  page.inputs.clear();
  page.composerInserts.length = 0;
  page.providerWrites.length = 0;
  page.composersBySession.clear();
  localStorage.clear();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Esc', () => {
  it('stops the run of the focused pane, and only while its Chat view is showing', async () => {
    const workspace = await renderWorkspace({ focused: true }, { focused: false });
    // Both panes show a run that can be stopped.
    act(() => {
      sessionProtection.markSessionProcessing?.('session-a');
      sessionProtection.markSessionProcessing?.('session-b');
    });

    fireEvent.keyDown(document, { key: 'Escape' });
    assert.deepEqual(page.aborts, ['session-a']);

    await workspace.rerender({ focused: false }, { focused: true });
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.deepEqual(page.aborts, ['session-a', 'session-b']);

    // The focused pane switches to its Files view: Esc there is not about the run.
    await workspace.rerender({ focused: false }, { focused: true, isActive: false });
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.deepEqual(page.aborts, ['session-a', 'session-b']);
  });
});

describe('text handed to the composer', () => {
  it('lands in the focused pane\'s composer, following focus', async () => {
    const workspace = await renderWorkspace({ focused: true }, { focused: false });

    // Only the focused chat offers its composer to the palette.
    assert.equal(page.composerInserts.length, 1);
    act(() => {
      page.composerInserts.at(-1)?.('/compact');
    });
    assert.equal(page.inputs.get('session-a'), '/compact');
    assert.equal(page.inputs.has('session-b'), false);

    await workspace.rerender({ focused: false }, { focused: true });
    assert.equal(page.composerInserts.length, 1);
    act(() => {
      page.composerInserts.at(-1)?.('/review');
    });
    assert.equal(page.inputs.get('session-b'), '/review');
    assert.equal(page.inputs.get('session-a'), '/compact');
  });
});

describe('the page-wide selected provider', () => {
  const renderProviderState = (initial: { session: ProjectSession | null; focused: boolean }) => renderHook(
    ({ session: selectedSession, focused }: { session: ProjectSession | null; focused: boolean }) => useChatProviderState({
      selectedSession,
      selectedProject: null,
      isFocusedPane: focused,
    }),
    { initialProps: initial },
  );

  it('is written by the focused pane only, and once by a pane as it gains focus', async () => {
    const view = renderProviderState({ session: session('codex-session', 'codex'), focused: false });
    await settle();
    // The background pane's composer follows its session without touching the page-wide choice.
    assert.equal(view.result.current.provider, 'codex');
    assert.deepEqual(page.providerWrites, []);

    view.rerender({ session: session('codex-session', 'codex'), focused: true });
    await settle();
    assert.deepEqual(page.providerWrites, ['codex']);

    view.rerender({ session: session('agy-session', 'agy'), focused: true });
    await settle();
    assert.deepEqual(page.providerWrites, ['codex', 'agy']);

    view.rerender({ session: session('claude-session', 'claude'), focused: false });
    await settle();
    assert.equal(view.result.current.provider, 'claude');
    assert.deepEqual(page.providerWrites, ['codex', 'agy']);
  });

  it('takes the provider of the session that arrives with focus, not the one the pane had', async () => {
    // A background pane on a new chat; a click opens a Codex session there and focuses it.
    const view = renderProviderState({ session: null, focused: false });
    await settle();

    view.rerender({ session: session('codex-session', 'codex'), focused: true });
    await settle();

    assert.equal(view.result.current.provider, 'codex');
    assert.deepEqual(page.providerWrites, ['codex']);
  });
});

describe('the local echo of a sent message', () => {
  const echoes: NormalizedMessage[] = [];
  const store = {
    fetchFromServer: async () => ({ fetchedAt: 1, status: 'idle' as const, total: 0, hasMore: false, offset: 0 }),
    fetchMore: async () => ({ slot: null, prependedCount: 0 }),
    appendRealtime: (_sessionId: string, message: NormalizedMessage) => {
      echoes.push(message);
    },
    refreshLatestFromServer: async () => ({ slot: null, applied: false, changed: false, deferred: false }),
    setActiveSession: () => undefined,
    isStale: () => false,
    updateStreaming: () => undefined,
    finalizeStreaming: () => undefined,
    getMessages: () => [],
    getSessionSlot: () => ({ fetchedAt: 1, status: 'idle' as const, total: 0, hasMore: false, offset: 0 }),
  };

  const renderSessionState = (selectedSession: ProjectSession | null) => renderHook(
    ({ session: current }: { session: ProjectSession | null }) => useChatSessionState({
      isActive: true,
      selectedProject: PROJECT,
      selectedSession: current,
      ws: null,
      sendMessage: () => undefined,
      // The page-wide choice (mocked above) is Claude; this chat sends with Codex.
      provider: 'codex',
      statusCheckSentAtRef: { current: new Map() },
      lastSeqRef: { current: new Map() },
      sessionStore: store as never,
    }),
    { initialProps: { session: selectedSession } },
  );

  const userMessage = (content: string): ChatMessage => ({ type: 'user', content, timestamp: '2026-10-27T10:00:00.000Z' });

  beforeEach(() => {
    echoes.length = 0;
  });

  it('carries the chat\'s own provider', async () => {
    const view = renderSessionState(session('codex-session', 'codex'));
    await settle();

    act(() => {
      view.result.current.addMessage(userMessage('in an open session'));
    });

    assert.deepEqual(echoes.map((echo) => echo.provider), ['codex']);
  });

  it('carries it too when a new chat\'s first message is written once the session exists', async () => {
    const view = renderSessionState(null);
    await settle();

    act(() => {
      view.result.current.addMessage(userMessage('first message'));
    });
    assert.equal(echoes.length, 0, 'held until the session exists');

    view.rerender({ session: session('new-session', 'codex') });
    await settle();

    assert.deepEqual(echoes.map((echo) => echo.provider), ['codex']);
  });
});
