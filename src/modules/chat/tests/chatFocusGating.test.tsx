import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useLayoutEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import '@/modules/i18n';
import ChatInterface from '@/modules/chat/ChatInterface';
import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { ChatInstancesProvider } from '@/modules/chat/context/ChatInstancesContext';
import { ImageLightbox } from '@/modules/chat/transcript/ChatMessageImages';
import { EditorSidebar } from '@/modules/code-editor';
import { holdBrowserFullscreen } from '@/shared/browserFullscreen';
import { SessionProtectionProvider, useSessionProtectionActions } from '@/shared/context/SessionProtectionContext';
import { WorkspacePaneProvider } from '@/shared/context/WorkspacePaneContext';
import { ActionMenu, Dialog, DialogContent } from '@/shared/ui';
import type { ChatMessage, CodeEditorFile, NormalizedMessage, Project, ProjectSession, WorkspacePaneSide } from '@/shared/types';

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
  /** For each entry of providerWrites, whether it was marked automatic (the page's own write). */
  automaticProviderWrites: [] as boolean[],
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
    // Read by the code editor, which one test floats over the chat.
    usePaletteOps: () => ({ openSettings: () => undefined }),
  };
});

// The floating editor's surface and theme, as the code editor's own tests stub them.
vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value }: { value: string }) => <textarea data-testid="editor" value={value} readOnly />,
}));
vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

vi.mock('@/shared/selectedProvider', () => ({
  readSelectedProvider: () => 'claude',
  writeSelectedProvider: (provider: string, options?: { automatic?: boolean }) => {
    page.providerWrites.push(provider);
    page.automaticProviderWrites.push(options?.automatic === true);
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
      readFile: () => okJson({ content: 'hello' }),
    },
    readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
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
  page.automaticProviderWrites.length = 0;
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

  it('closes an open menu without stopping the run, as a menu or dialog owns Escape', async () => {
    await renderWorkspace({ focused: true }, { focused: false });
    act(() => {
      sessionProtection.markSessionProcessing?.('session-a');
    });
    // The pane tab bar's "Pane actions" and "All tabs" are this shared menu.
    const menu = render(
      <ActionMenu label="Pane actions" items={[{ key: 'close', label: 'Close tab', onSelect: () => undefined }]} />,
    );
    fireEvent.click(menu.getByRole('button', { name: 'Pane actions' }));

    fireEvent.keyDown(menu.getByRole('menuitem', { name: 'Close tab' }), { key: 'Escape' });

    assert.equal(menu.queryByRole('menu') === null, true, 'the menu closed');
    assert.deepEqual(page.aborts, []);

    // With the menu gone, Escape is the run's again; so too after a modal dialog closes.
    const dialog = document.body.appendChild(document.createElement('div'));
    try {
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      fireEvent.keyDown(document, { key: 'Escape' });
      assert.deepEqual(page.aborts, []);
    } finally {
      dialog.remove();
    }
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.deepEqual(page.aborts, ['session-a']);
  });

  describe('that closes a dialog or an image preview', () => {
    // The command palette and the chat's modals are this shared dialog; a click on a
    // screenshot in a reply opens this preview. Both listen for Escape on the document's
    // capture phase, as the chat does.
    function OpenDialog() {
      // Open from the start; the dialog's own Escape handling closes it.
      const [open, setOpen] = useState(true);
      return (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <button type="button">Search</button>
          </DialogContent>
        </Dialog>
      );
    }

    function OpenImagePreview() {
      // Open from the start, as after a click on a thumbnail; the preview's Escape closes it.
      const [open, setOpen] = useState(true);
      return open ? <ImageLightbox src="data:image/png;base64,AA==" alt="Screenshot" onClose={() => setOpen(false)} /> : null;
    }

    const overlays = [
      { name: 'a dialog', Overlay: OpenDialog },
      { name: 'an image preview', Overlay: OpenImagePreview },
    ];

    /**
     * A browser runs the microtasks between two listeners of a key press it dispatches, and
     * React commits an update made in a keydown listener in one of them: a layer an earlier
     * listener closed is gone from the page by the time a later one looks. jsdom runs none
     * while a script dispatches, so this listener makes that commit. Registered once the
     * overlay is open and before the run starts, it runs between the overlay's and the chat's.
     */
    const commitBetweenListeners = () => {
      const commit = () => {
        flushSync(() => undefined);
      };
      document.addEventListener('keydown', commit, true);
      return () => document.removeEventListener('keydown', commit, true);
    };

    const openOverlayCount = () => screen.queryAllByRole('dialog').length;

    for (const { name, Overlay } of overlays) {
      it(`closes ${name} opened before the run started, and leaves the run going`, async () => {
        await renderWorkspace({ focused: true }, { focused: false });
        // Opened while nothing runs: its Escape listener is in place before the chat's.
        render(<Overlay />);
        const stopCommitting = commitBetweenListeners();
        try {
          // A queued message goes out, or another device starts a run: the chat starts listening.
          act(() => {
            sessionProtection.markSessionProcessing?.('session-a');
          });

          fireEvent.keyDown(document.body, { key: 'Escape' });

          assert.equal(openOverlayCount(), 0, 'the overlay closed');
          assert.deepEqual(page.aborts, []);

          // With it closed, Escape is the run's again.
          fireEvent.keyDown(document.body, { key: 'Escape' });
          assert.deepEqual(page.aborts, ['session-a']);
        } finally {
          stopCommitting();
        }
      });

      it(`closes ${name} opened while the run goes, and leaves the run going`, async () => {
        await renderWorkspace({ focused: true }, { focused: false });
        act(() => {
          sessionProtection.markSessionProcessing?.('session-a');
        });
        // Opened during the run: the chat's listener runs first and finds it still open.
        render(<Overlay />);

        fireEvent.keyDown(document.body, { key: 'Escape' });

        assert.equal(openOverlayCount(), 0, 'the overlay closed');
        assert.deepEqual(page.aborts, []);
      });
    }
  });

  it('leaves Escape to a maximized editor or preview over the page, which ends its maximize with it', async () => {
    await renderWorkspace({ focused: true }, { focused: false });
    act(() => {
      sessionProtection.markSessionProcessing?.('session-a');
    });
    // The editor's full screen as jsdom gets it: no Fullscreen API, so only the CSS maximize holds.
    const release = holdBrowserFullscreen({ source: 'codeEditor', onBrowserExit: () => undefined });
    try {
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.keyUp(document, { key: 'Escape' });
      assert.deepEqual(page.aborts, []);
    } finally {
      release();
    }
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.deepEqual(page.aborts, ['session-a']);
  });

  it('closes a floating editor over the page first, and stops the run on the next press', async () => {
    await renderWorkspace({ focused: true }, { focused: false });
    act(() => {
      sessionProtection.markSessionProcessing?.('session-a');
    });
    const onCloseEditor = vi.fn();
    // Floating, not maximized: on a phone, as a popped-out editor floats on a desktop.
    const editorSidebar = (editingFile: CodeEditorFile | null) => (
      <EditorSidebar
        editingFile={editingFile}
        isMobile
        editorExpanded={false}
        editorWidth={600}
        resizeHandleRef={{ current: null }}
        onResizeStart={() => undefined}
        onCloseEditor={onCloseEditor}
        onToggleEditorExpand={() => undefined}
      />
    );
    const editor = render(editorSidebar({ name: 'a.txt', path: '/repo/a.txt', projectId: PROJECT.projectId }));
    await screen.findByTestId('editor');

    fireEvent.keyDown(document.body, { key: 'Escape' });
    assert.equal(String(onCloseEditor.mock.calls.length), '1');
    assert.deepEqual(page.aborts, []);

    // The pane closes it; with nothing over the chat, Escape is the run's again.
    editor.rerender(editorSidebar(null));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    assert.deepEqual(page.aborts, ['session-a']);
  });

  describe('in the workspace\'s fullscreen, which holds the key', () => {
    let now = 0;
    const secureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');

    beforeEach(() => {
      // Chromium on a secure origin: the root fullscreen locked Escape (the shared browserFullscreen controller).
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => document.documentElement });
      Object.defineProperty(navigator, 'keyboard', { configurable: true, value: { lock: async () => undefined } });
      Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
      vi.spyOn(Date, 'now').mockImplementation(() => now);
    });

    afterEach(() => {
      Reflect.deleteProperty(document, 'fullscreenElement');
      Reflect.deleteProperty(navigator, 'keyboard');
      Reflect.deleteProperty(window, 'isSecureContext');
      if (secureContext) {
        Object.defineProperty(window, 'isSecureContext', secureContext);
      }
    });

    const renderRunningPane = async () => {
      await renderWorkspace({ focused: true }, { focused: false });
      act(() => {
        sessionProtection.markSessionProcessing?.('session-a');
      });
    };

    it('stops the run on a short press, once it is released', async () => {
      await renderRunningPane();

      now = 1_000;
      fireEvent.keyDown(document, { key: 'Escape' });
      assert.deepEqual(page.aborts, [], 'the press may still be the start of a hold');

      now = 1_120;
      fireEvent.keyUp(document, { key: 'Escape' });
      assert.deepEqual(page.aborts, ['session-a']);
    });

    it('leaves the run going when Escape is held to leave fullscreen', async () => {
      await renderRunningPane();

      now = 1_000;
      fireEvent.keyDown(document, { key: 'Escape' });
      // The held key repeats; no handler below (the editor's Escape) takes a repeat either.
      now = 1_600;
      assert.equal(fireEvent.keyDown(document, { key: 'Escape', repeat: true }), false, 'the repeat was claimed');
      now = 3_000;
      fireEvent.keyUp(document, { key: 'Escape' });

      assert.deepEqual(page.aborts, []);
    });
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
    // Both follow the pane, not a pick, so a hydrate that answers after them keeps the stored choice.
    assert.deepEqual(page.automaticProviderWrites, [true, true]);

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
