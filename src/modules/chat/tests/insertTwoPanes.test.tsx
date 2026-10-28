import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import '@/modules/i18n';
import ChatInterface from '@/modules/chat/ChatInterface';
import { ChatInstancesProvider } from '@/modules/chat/context/ChatInstancesContext';
import { SessionProtectionProvider, useSessionProtectionActions } from '@/shared/context/SessionProtectionContext';
import { WorkspacePaneProvider } from '@/shared/context/WorkspacePaneContext';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { BackgroundSendPrompt, OwnInsert, PendingInsert, Project, ProjectSession, ServerEvent, WorkspacePaneSide } from '@/shared/types';

/**
 * The real chats, composer state included, on one socket: an insert typed in
 * one pane is listed in both panes showing the session until the model reads
 * it, and its message then lands in both transcripts flagged as inserted. After
 * a reload, the composer adopts the tab's unsettled insert, and once the server
 * says the run is over, the transcript decides whether its text comes back. A
 * send the server refuses to run beside the session's background work is
 * undone in the pane that sent it.
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
    sent: [] as Array<{ side: string; message: Record<string, unknown> }>,
    history: new Map<string, unknown[]>(),
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
      runningSessions: notOk,
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
        // No matrix: the static fallback says Claude takes inserts.
        capabilities: () => okJson({ success: false }),
        sessionActiveModel: () => okJson({ success: false }),
        sessionTokenUsage: notOk,
        sessionMessages: (sessionId: string) => {
          const messages = page.history.get(sessionId) ?? [];
          return okJson({ success: true, data: { messages, total: messages.length, hasMore: false } });
        },
        // The held process would take the turn, as far as the server can tell before the send.
        handOverPlan: () => okJson({ success: true, data: { heldWork: true, canHandOver: true, changes: [] } }),
        skills: notOk,
      },
    },
  };
});

type StandInComposerProps = {
  input: string;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  pendingInserts?: PendingInsert[];
  onWithdrawInsert?: (insertId: string) => void;
  insertUnavailableReason?: string | null;
  onSubmitBusyMode?: (mode: 'insert' | 'queue') => void;
  backgroundSendPrompt?: BackgroundSendPrompt | null;
  onResolveBackgroundSendPrompt?: (choice: 'send' | 'queue' | 'cancel') => void;
};

// The composer's state is real; its view stands in with what this is about.
vi.mock('@/modules/chat/composer/ChatComposer', async () => {
  const { createElement } = await import('react');
  return {
    default: ({
      input,
      onInputChange,
      onTextareaKeyDown,
      pendingInserts = [],
      onWithdrawInsert,
      insertUnavailableReason,
      onSubmitBusyMode,
      backgroundSendPrompt = null,
      onResolveBackgroundSendPrompt,
    }: StandInComposerProps) => createElement(
      'div',
      null,
      createElement('textarea', { 'aria-label': 'Message', value: input, onChange: onInputChange, onKeyDown: onTextareaKeyDown }),
      createElement('output', { 'aria-label': 'Insert unavailable because' }, String(insertUnavailableReason)),
      createElement(
        'output',
        { 'aria-label': 'Background send prompt' },
        backgroundSendPrompt ? `changes: ${(backgroundSendPrompt.changes ?? []).join(', ')}` : 'closed',
      ),
      createElement('button', { type: 'button', onClick: () => onResolveBackgroundSendPrompt?.('cancel') }, 'Cancel the prompt'),
      createElement('button', { type: 'button', onClick: () => onSubmitBusyMode?.('queue') }, 'Queue from the menu'),
      createElement(
        'ul',
        { 'aria-label': 'Pending inserts' },
        pendingInserts.map((insert) => createElement(
          'li',
          { key: insert.insertId },
          `${insert.state}: ${insert.content}`,
          createElement('button', { type: 'button', onClick: () => onWithdrawInsert?.(insert.insertId) }, 'Withdraw'),
        )),
      ),
    ),
  };
});
vi.mock('@/modules/chat/transcript/ChatMessagesPane', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ chatMessages }: { chatMessages: Array<{ content?: string; inserted?: boolean }> }) => createElement(
      'ol',
      { 'aria-label': 'Transcript' },
      chatMessages.map((message, index) => createElement(
        'li',
        { key: index },
        `${message.inserted ? '[inserted] ' : ''}${message.content ?? ''}`,
      )),
    ),
  };
});
vi.mock('@/modules/chat/composer/useScheduledMessages', () => ({
  useScheduledMessages: () => ({ scheduledMessages: [], schedule: async () => false, cancel: () => undefined }),
}));
vi.mock('@/modules/chat/modals/CommandResultModal', () => ({ default: () => null }));
vi.mock('@/modules/task-master', () => ({ useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }) }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOpsRegister: () => undefined }));

const PROJECT: Project = { projectId: 'project-1', path: '/repo', fullPath: '/repo', displayName: 'Repo', isStarred: false };
const SESSION_A = { id: 'session-a', __provider: 'claude', __projectId: PROJECT.projectId } as ProjectSession;
const SOCKET = {} as WebSocket;

const sendFrom: Record<WorkspacePaneSide, (message: unknown) => void> = {
  left: (message) => {
    page.sent.push({ side: 'left', message: message as Record<string, unknown> });
  },
  right: (message) => {
    page.sent.push({ side: 'right', message: message as Record<string, unknown> });
  },
};

const activity: { actions: ReturnType<typeof useSessionProtectionActions> | null } = { actions: null };

function ActivityProbe() {
  const actions = useSessionProtectionActions();
  useLayoutEffect(() => {
    activity.actions = actions;
  });
  return null;
}

function Pane({ side, focused, isActive }: { side: WorkspacePaneSide; focused: boolean; isActive: boolean }) {
  return (
    <section data-testid={`pane-${side}`}>
      <WorkspacePaneProvider value={{ side, isFocusedPane: focused, isSplitPane: true, openFileInEditor: null, openDirectory: null }}>
        <ChatInterface isActive={isActive} selectedProject={PROJECT} selectedSession={SESSION_A} ws={SOCKET} sendMessage={sendFrom[side]} />
      </WorkspacePaneProvider>
    </section>
  );
}

const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

/** `chatHidden`: the panes show another view (Files, Shell), so their chats load no history. */
const renderWorkspace = async (sides: WorkspacePaneSide[], { chatHidden = false } = {}) => {
  render(
    <SessionProtectionProvider>
      <ChatInstancesProvider>
        <ActivityProbe />
        {sides.map((side) => <Pane key={side} side={side} focused={side === 'left'} isActive={!chatHidden} />)}
      </ChatInstancesProvider>
    </SessionProtectionProvider>,
  );
  await settle();
};

const dispatch = (event: Record<string, unknown>) => {
  act(() => {
    for (const listener of page.listeners) {
      listener({ provider: 'claude', timestamp: '2026-10-28T10:00:00.000Z', ...event } as ServerEvent);
    }
  });
};

const pane = (side: WorkspacePaneSide) => within(screen.getByTestId(`pane-${side}`));
const pendingInserts = (side: WorkspacePaneSide) => pane(side)
  .getByRole('list', { name: 'Pending inserts' })
  .querySelectorAll('li');
const pendingInsertTexts = (side: WorkspacePaneSide) => Array.from(
  pendingInserts(side),
  (row) => (row.textContent ?? '').replace(/Withdraw$/, ''),
);
const insertUnavailableReason = (side: WorkspacePaneSide) => pane(side)
  .getByRole('status', { name: 'Insert unavailable because' }).textContent;
const transcript = (side: WorkspacePaneSide) => Array.from(
  pane(side).getByRole('list', { name: 'Transcript' }).querySelectorAll('li'),
  (row) => row.textContent,
);
const composerText = (side: WorkspacePaneSide) => (pane(side).getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value;
const backgroundSendPrompt = (side: WorkspacePaneSide) => pane(side)
  .getByRole('status', { name: 'Background send prompt' }).textContent;

beforeEach(() => {
  page.sent.length = 0;
  page.history.clear();
  localStorage.clear();
  sessionStorage.clear();
  resetChatDrafts();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('an insert typed in one of two panes showing the session', () => {
  it('is listed in both until the model reads it, then lands in both transcripts as inserted', async () => {
    await renderWorkspace(['left', 'right']);
    // A turn CloudCLI drives is running on the session.
    act(() => {
      activity.actions?.markSessionProcessing('session-a', { statusText: null, canInterrupt: true });
    });

    const textarea = pane('left').getByRole('textbox', { name: 'Message' });
    fireEvent.change(textarea, { target: { value: 'also check the docs' } });
    assert.equal(insertUnavailableReason('left'), 'null', 'Enter would insert it');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    const inserts = page.sent.filter(({ message }) => message.type === 'chat.insert');
    assert.deepEqual(inserts.map(({ side, message }) => [side, message.sessionId, message.content]), [
      ['left', 'session-a', 'also check the docs'],
    ]);
    const insertId = String(inserts[0]?.message.insertId);

    dispatch({ kind: 'insert_status', id: 's1', sessionId: 'session-a', seq: 1, insertId, insertStatus: 'pending', content: 'also check the docs' });
    assert.deepEqual(pendingInsertTexts('left'), ['pending: also check the docs']);
    assert.deepEqual(pendingInsertTexts('right'), ['pending: also check the docs']);

    // Either pane may withdraw it.
    fireEvent.click(pane('right').getByRole('button', { name: 'Withdraw' }));
    assert.deepEqual(
      page.sent.filter(({ message }) => message.type === 'chat.insert-cancel').map(({ side, message }) => [side, message.insertId]),
      [['right', insertId]],
    );
    // Too late: the CLI is reading it already.
    dispatch({ kind: 'insert_status', sessionId: 'session-a', insertId, insertStatus: 'cancel_failed' });
    assert.deepEqual(pendingInsertTexts('right'), ['delivering: also check the docs']);

    dispatch({ kind: 'text', id: insertId, sessionId: 'session-a', seq: 2, role: 'user', content: 'also check the docs', inserted: true });
    dispatch({ kind: 'insert_status', id: 's2', sessionId: 'session-a', seq: 3, insertId, insertStatus: 'delivered', content: 'also check the docs' });

    assert.deepEqual(pendingInsertTexts('left'), []);
    assert.deepEqual(pendingInsertTexts('right'), []);
    assert.deepEqual(transcript('left'), ['[inserted] also check the docs']);
    assert.deepEqual(transcript('right'), ['[inserted] also check the docs']);
    assert.equal(composerText('left'), '');
  });
});

describe('a send the server refuses to run beside the background work', () => {
  it('is undone in the pane that sent it: its echo leaves the transcript, the session is back to its work, and the dialog names the change', async () => {
    await renderWorkspace(['left', 'right']);
    act(() => {
      activity.actions?.markSessionBackground('session-a', [
        { taskId: 'w1', toolUseId: 'toolu_wf', taskType: 'local_workflow', description: 'Audit', workflowName: 'audit', startedAt: 1 },
      ]);
    });

    const textarea = pane('left').getByRole('textbox', { name: 'Message' });
    fireEvent.change(textarea, { target: { value: 'and check the logs' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => assert.equal(page.sent.filter(({ message }) => message.type === 'chat.send').length, 1));
    const send = page.sent.find(({ message }) => message.type === 'chat.send');
    assert.equal(send?.side, 'left');
    const sendOptions = send?.message.options as Record<string, unknown> | undefined;
    assert.equal(sendOptions?.keepBackgroundWork, true);
    assert.deepEqual(transcript('left'), ['and check the logs']);
    assert.equal(activity.actions?.getSessionActivity('session-a')?.background, undefined, 'marked busy for the send');

    // Changed hands since the plan: the server will not start it.
    dispatch({ kind: 'send_refused', sessionId: 'session-a', reason: 'BACKGROUND_WORK_WOULD_STOP', changes: ['effort'] });

    assert.deepEqual(transcript('left'), []);
    assert.equal(activity.actions?.getSessionActivity('session-a')?.background, true);
    await waitFor(() => assert.equal(backgroundSendPrompt('left'), 'changes: effort'));
    assert.equal(backgroundSendPrompt('right'), 'closed');
    assert.equal(composerText('left'), 'and check the logs', 'the message is back while the dialog asks');
    assert.equal(composerText('right'), 'and check the logs', 'the session\'s draft is shared');

    fireEvent.click(pane('left').getByRole('button', { name: 'Cancel the prompt' }));

    await waitFor(() => assert.equal(backgroundSendPrompt('left'), 'closed'));
    assert.equal(composerText('left'), 'and check the logs');
    assert.equal(page.sent.filter(({ message }) => message.type === 'chat.send').length, 1);
  });
});

describe('the send button menu while a turn runs', () => {
  it('queues the message when Queue is picked', async () => {
    await renderWorkspace(['left']);
    act(() => {
      activity.actions?.markSessionProcessing('session-a', { statusText: null, canInterrupt: true });
    });
    fireEvent.change(pane('left').getByRole('textbox', { name: 'Message' }), { target: { value: 'after this turn' } });

    fireEvent.click(pane('left').getByRole('button', { name: 'Queue from the menu' }));

    await waitFor(() => assert.equal(composerText('left'), ''));
    assert.equal(page.sent.filter(({ message }) => message.type === 'chat.insert').length, 0);
  });
});

describe('after a reload', () => {
  const storeAcceptedInsert = (insert: OwnInsert) => {
    sessionStorage.setItem('chat-own-inserts', JSON.stringify([insert]));
  };

  const acceptedInsert: OwnInsert = {
    insertId: '6f1c0f3e-1d2b-4c3a-9e8f-7a6b5c4d3e2f',
    sessionId: 'session-a',
    content: 'sent before the reload',
    sentAt: Date.now() - 60_000,
    accepted: true,
  };

  it('an idle ack drops the adopted insert the transcript holds', async () => {
    storeAcceptedInsert(acceptedInsert);
    page.history.set('session-a', [{
      id: acceptedInsert.insertId,
      sessionId: 'session-a',
      timestamp: '2026-10-28T10:00:00.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'user',
      content: 'sent before the reload',
      inserted: true,
    }]);
    await renderWorkspace(['left']);
    assert.deepEqual(pendingInsertTexts('left'), ['pending: sent before the reload']);

    dispatch({ kind: 'chat_subscribed', sessionId: 'session-a', isProcessing: false, pendingPermissions: [] });

    await waitFor(() => assert.deepEqual(pendingInsertTexts('left'), []));
    assert.equal(composerText('left'), '');
    assert.equal(sessionStorage.getItem('chat-own-inserts'), null);
  });

  it('an idle ack reads the transcript even while the chat is hidden, so a delivered insert does not come back', async () => {
    storeAcceptedInsert(acceptedInsert);
    page.history.set('session-a', [{
      id: acceptedInsert.insertId,
      sessionId: 'session-a',
      timestamp: '2026-10-28T10:00:00.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'user',
      content: 'sent before the reload',
      inserted: true,
    }]);
    await renderWorkspace(['left'], { chatHidden: true });

    dispatch({ kind: 'chat_subscribed', sessionId: 'session-a', isProcessing: false, pendingPermissions: [] });

    await waitFor(() => assert.deepEqual(pendingInsertTexts('left'), []));
    assert.equal(composerText('left'), '');
  });

  it('an idle ack gives the adopted insert back when the transcript lacks it', async () => {
    storeAcceptedInsert(acceptedInsert);
    await renderWorkspace(['left']);

    dispatch({ kind: 'chat_subscribed', sessionId: 'session-a', isProcessing: false, pendingPermissions: [] });

    await waitFor(() => assert.equal(composerText('left'), 'sent before the reload'));
    assert.deepEqual(pendingInsertTexts('left'), []);
  });
});
