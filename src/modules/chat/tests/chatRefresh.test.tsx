import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import type { ChangeEvent, ClipboardEvent, KeyboardEvent } from 'react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import '@/modules/i18n';
import ChatInterface from '@/modules/chat/ChatInterface';
import { ChatInstancesProvider } from '@/modules/chat/context/ChatInstancesContext';
import { SessionProtectionProvider, useSessionProtectionActions } from '@/shared/context/SessionProtectionContext';
import { WorkspacePaneProvider } from '@/shared/context/WorkspacePaneContext';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { PendingInsert, Project, ProjectSession, ServerEvent } from '@/shared/types';

/**
 * A tab's refresh reaches the chat as a bumped `refreshTrigger`. The chat is
 * refreshed in place: the transcript is read again, the session subscribed
 * again, and what else the chat read once (running sessions, scheduled
 * messages, token usage) is read again, while the composer's draft and
 * attachments, a pending insert and a stream being written stay as they were.
 *
 * The chat, its composer state and the activity map are real; the composer's
 * view and the transcript pane stand in with what this is about.
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
    sent: [] as Array<Record<string, unknown>>,
    /** The persisted transcript a history read returns. */
    history: [] as unknown[],
    /** The options of every history read, in order. */
    historyReads: [] as Array<{ limit?: number | null; offset?: number }>,
    reads: { runningSessions: 0, scheduledMessages: 0, tokenUsage: 0 },
    /** How many times the pinned question bar mounted: it caches the server's answers. */
    pinnedBarMounts: 0,
  };
});

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: page.subscribe, isConnected: true }),
}));

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  const notOk = () => Promise.resolve({ ok: false, json: async () => ({}) });
  return {
    ApiRequestError: class ApiRequestError extends Error {},
    api: {
      // Counted, and left out of the activity map these tests drive.
      runningSessions: () => {
        page.reads.runningSessions += 1;
        return notOk();
      },
      scheduledMessages: {
        list: () => {
          page.reads.scheduledMessages += 1;
          return okJson({ success: true, data: [] });
        },
      },
      user: {
        preferences: () => okJson({ success: true, preferences: {} }),
        savePreferences: () => okJson({ success: true, preferences: {} }),
        drafts: () => okJson({ success: true, drafts: [] }),
        saveDraft: () => okJson({ success: true }),
        deleteDraft: () => okJson({ success: true }),
        appendQueuedMessage: () => okJson({ queuedMessage: { content: 'queued' }, appended: false }),
        clearQueuedMessage: () => okJson({ success: true }),
      },
      commands: { list: () => okJson({ success: true, commands: [] }) },
      files: { search: () => okJson({ success: true, files: [] }) },
      getFiles: notOk,
      providers: {
        models: () => okJson({ success: false }),
        capabilities: () => okJson({ success: false }),
        sessionActiveModel: () => okJson({ success: false }),
        sessionTokenUsage: () => {
          page.reads.tokenUsage += 1;
          return notOk();
        },
        sessionMessages: (_sessionId: string, options: { limit?: number | null; offset?: number } = {}) => {
          page.historyReads.push({ limit: options.limit, offset: options.offset });
          const messages = page.history;
          return okJson({ success: true, data: { messages, total: messages.length, hasMore: false } });
        },
        skills: notOk,
      },
    },
  };
});

type StandInComposerProps = {
  input: string;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  attachedFiles?: File[];
  pendingInserts?: PendingInsert[];
};

vi.mock('@/modules/chat/composer/ChatComposer', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ input, onInputChange, onTextareaKeyDown, onTextareaPaste, attachedFiles = [], pendingInserts = [] }: StandInComposerProps) => createElement(
      'div',
      null,
      createElement('textarea', { 'aria-label': 'Message', value: input, onChange: onInputChange, onKeyDown: onTextareaKeyDown }),
      createElement('button', {
        type: 'button',
        onClick: () => {
          const file = new File(['png'], 'shot.png', { type: 'image/png' });
          onTextareaPaste({ clipboardData: { items: [{ type: file.type, getAsFile: () => file }], files: [] } } as never);
        },
      }, 'Paste an image'),
      createElement('ul', { 'aria-label': 'Attachments' }, attachedFiles.map((file) => createElement('li', { key: file.name }, file.name))),
      createElement(
        'ul',
        { 'aria-label': 'Pending inserts' },
        pendingInserts.map((insert) => createElement('li', { key: insert.insertId }, `${insert.state}: ${insert.content}`)),
      ),
    ),
  };
});
vi.mock('@/modules/chat/transcript/ChatMessagesPane', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ chatMessages }: { chatMessages: Array<{ content?: string }> }) => createElement(
      'ol',
      { 'aria-label': 'Transcript' },
      chatMessages.map((message, index) => createElement('li', { key: index }, message.content ?? '')),
    ),
  };
});
// The chat column has room for the pinned question; the bar stands in, counting its mounts.
vi.mock('@/shared/hooks/useElementWidth', () => ({ useElementWidth: () => true }));
vi.mock('@/modules/chat/transcript/PinnedQuestionBar', async () => {
  const { useLayoutEffect: useMountEffect } = await import('react');
  return {
    default: function PinnedQuestionBarStandIn() {
      useMountEffect(() => {
        page.pinnedBarMounts += 1;
      }, []);
      return null;
    },
  };
});
vi.mock('@/modules/chat/modals/CommandResultModal', () => ({ default: () => null }));
vi.mock('@/modules/task-master', () => ({ useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }) }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOpsRegister: () => undefined }));

const PROJECT: Project = { projectId: 'project-1', path: '/repo', fullPath: '/repo', displayName: 'Repo', isStarred: false };
const SESSION_A = { id: 'session-a', __provider: 'claude', __projectId: PROJECT.projectId } as ProjectSession;
const SOCKET = {} as WebSocket;

const sendMessage = (message: unknown) => {
  page.sent.push(message as Record<string, unknown>);
};

const activity: { actions: ReturnType<typeof useSessionProtectionActions> | null } = { actions: null };

function ActivityProbe() {
  const actions = useSessionProtectionActions();
  useLayoutEffect(() => {
    activity.actions = actions;
  });
  return null;
}

/** Counts the chat's mounts: a refresh must not remount it. */
const mounts = { count: 0 };
function MountCounter() {
  useLayoutEffect(() => {
    mounts.count += 1;
  }, []);
  return null;
}

type PaneProps = { refreshTrigger: number; isActive?: boolean };

function Workspace({ refreshTrigger, isActive = true }: PaneProps) {
  return (
    <SessionProtectionProvider>
      <ChatInstancesProvider>
        <ActivityProbe />
        <section data-testid="pane-left">
          <WorkspacePaneProvider value={{ side: 'left', isFocusedPane: true, isSplitPane: false, openFileInEditor: null, openDirectory: null }}>
            <MountCounter />
            <ChatInterface
              isActive={isActive}
              selectedProject={PROJECT}
              selectedSession={SESSION_A}
              ws={SOCKET}
              sendMessage={sendMessage}
              refreshTrigger={refreshTrigger}
            />
          </WorkspacePaneProvider>
        </section>
      </ChatInstancesProvider>
    </SessionProtectionProvider>
  );
}

const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

/** Waits out the chat's 100 ms stream flush. */
const flushStreams = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
});

async function renderWorkspace(props: PaneProps) {
  const view = render(<Workspace {...props} />);
  await settle();
  return {
    rerender: async (next: PaneProps) => {
      view.rerender(<Workspace {...next} />);
      await settle();
      await settle();
    },
  };
}

const dispatch = (event: Record<string, unknown>) => {
  act(() => {
    for (const listener of page.listeners) {
      listener({ provider: 'claude', timestamp: new Date().toISOString(), ...event } as ServerEvent);
    }
  });
};

const pane = () => within(screen.getByTestId('pane-left'));
const transcript = () => Array.from(pane().getByRole('list', { name: 'Transcript' }).querySelectorAll('li'), (row) => row.textContent);
const attachments = () => Array.from(pane().getByRole('list', { name: 'Attachments' }).querySelectorAll('li'), (row) => row.textContent);
const pendingInserts = () => Array.from(pane().getByRole('list', { name: 'Pending inserts' }).querySelectorAll('li'), (row) => row.textContent);
const composerText = () => (pane().getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value;

type SubscribeMessage = { type?: string; sessions?: Array<{ sessionId: string; lastSeq?: number }> };
const subscribes = () => page.sent
  .filter((message) => (message as SubscribeMessage).type === 'chat.subscribe')
  .map((message) => (message as SubscribeMessage).sessions?.[0])
  .map((target) => `${target?.sessionId}@${target?.lastSeq}`);

const historyRow = (id: string, role: 'user' | 'assistant', content: string, timestamp: string) => (
  { id, kind: 'text', role, content, sessionId: 'session-a', provider: 'claude', timestamp }
);
const FIRST_TURN = [
  historyRow('h-q1', 'user', 'first question', '2026-10-28T09:00:00.000Z'),
  historyRow('h-a1', 'assistant', 'first answer', '2026-10-28T09:00:30.000Z'),
];
// A turn another device ran: this socket heard none of it.
const SECOND_TURN = [
  historyRow('h-q2', 'user', 'asked on the phone', '2026-10-28T09:30:00.000Z'),
  historyRow('h-a2', 'assistant', 'answered on the phone', '2026-10-28T09:30:30.000Z'),
];

beforeEach(() => {
  page.sent.length = 0;
  page.history = FIRST_TURN;
  page.historyReads.length = 0;
  page.reads.runningSessions = 0;
  page.reads.scheduledMessages = 0;
  page.reads.tokenUsage = 0;
  page.pinnedBarMounts = 0;
  mounts.count = 0;
  localStorage.clear();
  sessionStorage.clear();
  resetChatDrafts();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('refreshing an idle chat', () => {
  it('reads the transcript again and drops a stale live row, while the draft and attachments stay', async () => {
    // Only the clock is faked, so the live error row can be made old.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T10:00:00.000Z'));
    const workspace = await renderWorkspace({ refreshTrigger: 0 });
    dispatch({ kind: 'chat_subscribed', sessionId: 'session-a', isProcessing: false, pendingPermissions: [] });
    assert.deepEqual(transcript(), ['first question', 'first answer']);

    fireEvent.change(pane().getByRole('textbox', { name: 'Message' }), { target: { value: 'half written' } });
    fireEvent.click(pane().getByRole('button', { name: 'Paste an image' }));
    await settle();
    assert.deepEqual(attachments(), ['shot.png']);

    // A send the server refused leaves an error row only this page holds.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dispatch({ kind: 'protocol_error', sessionId: 'session-a', error: 'Request failed' });
    consoleError.mockRestore();
    assert.deepEqual(transcript(), ['first question', 'first answer', 'Request failed']);

    // A minute later, after the phone ran a turn.
    vi.setSystemTime(new Date('2026-10-28T10:01:00.000Z'));
    page.history = [...FIRST_TURN, ...SECOND_TURN];
    const readsBefore = { ...page.reads };
    const subscribesBefore = subscribes().length;
    const pinnedBarMountsBefore = page.pinnedBarMounts;

    await workspace.rerender({ refreshTrigger: 1 });

    assert.deepEqual(transcript(), ['first question', 'first answer', 'asked on the phone', 'answered on the phone']);
    assert.deepEqual(page.historyReads.at(-1), { limit: null, offset: 0 }, 'every loaded row read as one window');
    assert.deepEqual(subscribes().slice(subscribesBefore), ['session-a@0']);
    assert.equal(page.reads.runningSessions > readsBefore.runningSessions, true, 'running sessions read again');
    assert.equal(page.reads.scheduledMessages, readsBefore.scheduledMessages + 1, 'scheduled messages read again');
    assert.equal(page.reads.tokenUsage, readsBefore.tokenUsage + 1, 'token usage read again');
    assert.equal(page.pinnedBarMounts, pinnedBarMountsBefore + 1, 'the pinned question starts afresh');

    assert.equal(composerText(), 'half written');
    assert.deepEqual(attachments(), ['shot.png']);
    assert.equal(mounts.count, 1, 'the chat was not remounted');
  });

  it('does nothing on mount, nor for a value it already refreshed for', async () => {
    const workspace = await renderWorkspace({ refreshTrigger: 3 });
    // The chat's own first read and subscribe, nothing more.
    assert.deepEqual(page.historyReads, [{ limit: 20, offset: 0 }]);
    assert.deepEqual(subscribes(), ['session-a@0']);

    await workspace.rerender({ refreshTrigger: 3 });

    assert.equal(page.historyReads.length, 1);
    assert.equal(subscribes().length, 1);
  });
});

describe('refreshing a chat while its turn runs', () => {
  it('reads only the newest rows and subscribes from the last frame heard, keeping the stream and the pending insert', async () => {
    const workspace = await renderWorkspace({ refreshTrigger: 0 });
    act(() => {
      activity.actions?.markSessionProcessing('session-a', { statusText: null, canInterrupt: true });
    });
    dispatch({ kind: 'stream_delta', id: 'd1', sessionId: 'session-a', seq: 1, content: 'Working on ' });
    await flushStreams();

    const textarea = pane().getByRole('textbox', { name: 'Message' });
    fireEvent.change(textarea, { target: { value: 'also check the docs' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    const insert = page.sent.find((message) => message.type === 'chat.insert');
    const insertId = String(insert?.insertId);
    dispatch({ kind: 'insert_status', id: 's2', sessionId: 'session-a', seq: 2, insertId, insertStatus: 'pending', content: 'also check the docs' });
    fireEvent.change(textarea, { target: { value: 'next idea' } });
    assert.deepEqual(pendingInserts(), ['pending: also check the docs']);
    assert.deepEqual(transcript(), ['first question', 'first answer', 'Working on ']);
    const subscribesBefore = subscribes().length;

    await workspace.rerender({ refreshTrigger: 1 });

    assert.deepEqual(page.historyReads.at(-1), { limit: 20, offset: 0 }, 'the bounded tail read a reconnect makes');
    assert.deepEqual(subscribes().slice(subscribesBefore), ['session-a@2']);
    assert.deepEqual(transcript(), ['first question', 'first answer', 'Working on ']);
    assert.deepEqual(pendingInserts(), ['pending: also check the docs']);
    assert.equal(composerText(), 'next idea');

    // The stream goes on in the same row.
    dispatch({ kind: 'stream_delta', id: 'd3', sessionId: 'session-a', seq: 3, content: 'it' });
    await flushStreams();
    assert.deepEqual(transcript(), ['first question', 'first answer', 'Working on it']);
    assert.equal(mounts.count, 1);
  });
});

describe('refreshing a hidden chat', () => {
  it('subscribes at once and reads the transcript only once the chat shows', async () => {
    const workspace = await renderWorkspace({ refreshTrigger: 0 });
    // The pane shows Files.
    await workspace.rerender({ refreshTrigger: 0, isActive: false });
    page.history = [...FIRST_TURN, ...SECOND_TURN];
    const readsBefore = page.historyReads.length;
    const subscribesBefore = subscribes().length;

    await workspace.rerender({ refreshTrigger: 1, isActive: false });

    assert.deepEqual(subscribes().slice(subscribesBefore), ['session-a@0']);
    assert.equal(page.historyReads.length, readsBefore, 'a hidden chat reads no history');

    await workspace.rerender({ refreshTrigger: 1, isActive: true });

    assert.deepEqual(page.historyReads.slice(readsBefore), [{ limit: null, offset: 0 }]);
    assert.deepEqual(transcript(), ['first question', 'first answer', 'asked on the phone', 'answered on the phone']);
  });
});
