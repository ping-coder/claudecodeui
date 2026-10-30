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
import type { BackgroundSendPrompt, OwnInsert, PendingInsert, Project, ProjectSession, ScheduledWorkSummary, ServerEvent, WorkspacePaneSide } from '@/shared/types';

/**
 * The real chats, composer state included, on one socket: an insert typed in
 * one pane is listed in both panes showing the session until the model reads
 * it, and its message then lands in both transcripts flagged as inserted. After
 * a reload, the composer adopts the tab's unsettled insert, and once the server
 * says the run is over, the transcript decides whether its text comes back. A
 * send the server refuses to run beside the session's background work is
 * undone in the pane that sent it, each pane's own when both panes sent, and
 * each answer in the stacked dialogs takes out of the shared composer only
 * the message it was about.
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
    // Held open by a test to keep hand-over plan requests in flight.
    planGate: Promise.resolve() as Promise<void>,
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
        handOverPlan: () => page.planGate.then(() => okJson({ success: true, data: { heldWork: true, canHandOver: true, changes: [] } })),
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

// The composer's state is real; its view stands in with what this is about,
// the real dialog that asks before sending over background work included.
vi.mock('@/modules/chat/composer/ChatComposer', async () => {
  const { createElement } = await import('react');
  const { default: BackgroundSendDialog } = await import('@/modules/chat/composer/BackgroundSendDialog');
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
      createElement(BackgroundSendDialog, {
        prompt: backgroundSendPrompt,
        onResolve: (choice: 'send' | 'queue' | 'cancel') => onResolveBackgroundSendPrompt?.(choice),
      }),
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
  page.planGate = Promise.resolve();
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

describe('a send whose run fails at the hand-over, the loop\'s fire having started a task while it waited', () => {
  const loop: ScheduledWorkSummary = {
    id: 'cron:b2148320',
    kind: 'cron',
    toolUseId: 'toolu_cron_1',
    prompt: 'check CI',
    startedAt: 1,
    nextFireAt: 300_001,
    recurring: true,
    holdUntil: 691_200_001,
    cron: '*/5 * * * *',
  };
  const failure = 'Not sent: the turn Claude ran on its own meanwhile started work a new process would stop.';

  it('comes back in the pane that sent it once the run is over, and the dialog lists the work as the page hears of it', async () => {
    await renderWorkspace(['left', 'right']);
    act(() => {
      activity.actions?.markSessionBackground('session-a', [], [loop]);
    });

    const textarea = pane('left').getByRole('textbox', { name: 'Message' });
    fireEvent.change(textarea, { target: { value: 'and check the logs' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    const sends = () => page.sent.filter(({ message }) => message.type === 'chat.send');
    await waitFor(() => assert.equal(sends().length, 1));
    assert.equal((sends()[0]?.message.options as Record<string, unknown> | undefined)?.keepBackgroundWork, true);
    assert.deepEqual(transcript('left'), ['and check the logs']);

    // The run: its turn waited for the loop's fire, which started a task, so
    // the runtime failed it rather than stop that task; then the refusal.
    dispatch({ kind: 'error', id: 'e1', sessionId: 'session-a', seq: 1, code: 'HAND_OVER_FAILED', reason: 'work-started', changes: ['effort'], content: failure });
    dispatch({ kind: 'complete', id: 'c1', sessionId: 'session-a', seq: 2, exitCode: 1 });
    dispatch({
      kind: 'send_refused',
      sessionId: 'session-a',
      reason: 'HAND_OVER_FAILED',
      changes: ['effort'],
      content: 'and check the logs',
      clientRequestId: sends()[0]?.message.clientRequestId,
    });

    await waitFor(() => assert.equal(backgroundSendPrompt('left'), 'changes: effort'));
    assert.equal(backgroundSendPrompt('right'), 'closed');
    assert.deepEqual(transcript('left'), [failure], 'the echo goes, the failure stays');
    assert.equal(composerText('left'), 'and check the logs');
    const dialog = () => {
      const [only, ...others] = Array.from(document.body.querySelectorAll<HTMLElement>('[role="dialog"]'));
      assert.equal(others.length, 0);
      assert.ok(only, 'a dialog is open');
      return within(only);
    };
    assert.equal(dialog().queryByRole('button', { name: 'Queue' }) === null, true, 'the loop alone leaves nothing to queue behind');

    // The page hears of the task the fire started.
    act(() => {
      activity.actions?.markSessionBackground('session-a', [
        { taskId: 'b1', toolUseId: 'toolu_bash', taskType: 'local_bash', description: 'Run the e2e suite', startedAt: 2 },
      ], [loop]);
    });
    await waitFor(() => assert.equal(dialog().queryByText('Command Run the e2e suite') === null, false));
    fireEvent.click(dialog().getByRole('button', { name: 'Queue' }));

    await waitFor(() => assert.equal(backgroundSendPrompt('left'), 'closed'));
    await settle();
    assert.equal(composerText('left'), '');
    assert.equal(sends().length, 1, 'queued, not sent again');
  });

  it('comes back as well when the page reconnected while the turn waited for the fire', async () => {
    await renderWorkspace(['left', 'right']);
    act(() => {
      activity.actions?.markSessionBackground('session-a', [], [loop]);
    });

    const textarea = pane('left').getByRole('textbox', { name: 'Message' });
    fireEvent.change(textarea, { target: { value: 'and check the logs' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    const sends = () => page.sent.filter(({ message }) => message.type === 'chat.send');
    await waitFor(() => assert.equal(sends().length, 1));

    // The socket drops while the turn waits. Back online, the chats re-read
    // the session and subscribe again; the run is still under way.
    dispatch({ kind: 'websocket_reconnected' });
    await settle();
    assert.equal(page.sent.some(({ message }) => message.type === 'chat.subscribe'), true);
    dispatch({ kind: 'chat_subscribed', sessionId: 'session-a', isProcessing: true, lastSeq: 0, pendingPermissions: [] });
    await settle();
    assert.equal(composerText('left'), '', 'the message is still out');

    // The new socket watches the run, and hears its end and the refusal.
    dispatch({ kind: 'error', id: 'e1', sessionId: 'session-a', seq: 1, code: 'HAND_OVER_FAILED', reason: 'work-started', changes: ['effort'], content: failure });
    dispatch({ kind: 'complete', id: 'c1', sessionId: 'session-a', seq: 2, exitCode: 1 });
    dispatch({
      kind: 'send_refused',
      sessionId: 'session-a',
      reason: 'HAND_OVER_FAILED',
      changes: ['effort'],
      content: 'and check the logs',
      clientRequestId: sends()[0]?.message.clientRequestId,
    });

    await waitFor(() => assert.equal(backgroundSendPrompt('left'), 'changes: effort'));
    assert.equal(backgroundSendPrompt('right'), 'closed');
    assert.deepEqual(transcript('left'), [failure], 'the echo goes, the failure stays');
    assert.equal(composerText('left'), 'and check the logs');

    fireEvent.click(pane('left').getByRole('button', { name: 'Cancel the prompt' }));
    await waitFor(() => assert.equal(backgroundSendPrompt('left'), 'closed'));
    assert.equal(composerText('left'), 'and check the logs');
    assert.equal(sends().length, 1);
  });

  it('comes back once the page subscribes again when it was offline as the run failed, and the same refusal on a later subscribe changes nothing', async () => {
    await renderWorkspace(['left', 'right']);
    act(() => {
      activity.actions?.markSessionBackground('session-a', [], [loop]);
    });

    const textarea = pane('left').getByRole('textbox', { name: 'Message' });
    fireEvent.change(textarea, { target: { value: 'and check the logs' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    const sends = () => page.sent.filter(({ message }) => message.type === 'chat.send');
    await waitFor(() => assert.equal(sends().length, 1));
    const refusal = {
      kind: 'send_refused',
      sessionId: 'session-a',
      reason: 'HAND_OVER_FAILED',
      changes: ['effort'],
      content: 'and check the logs',
      clientRequestId: sends()[0]?.message.clientRequestId,
    };

    // The page was offline while the turn waited and failed, so it heard
    // neither the run's end nor the refusal. Back online, the chats subscribe
    // again: the run is over, and the server sends the refusal it kept after
    // the ack.
    dispatch({ kind: 'websocket_reconnected' });
    await settle();
    assert.equal(page.sent.some(({ message }) => message.type === 'chat.subscribe'), true);
    dispatch({ kind: 'chat_subscribed', sessionId: 'session-a', isProcessing: false, lastSeq: 2, pendingPermissions: [] });
    dispatch(refusal);

    await waitFor(() => assert.equal(backgroundSendPrompt('left'), 'changes: effort'));
    assert.equal(backgroundSendPrompt('right'), 'closed');
    assert.deepEqual(transcript('left'), [], 'the echo goes');
    assert.equal(composerText('left'), 'and check the logs');

    fireEvent.click(pane('left').getByRole('button', { name: 'Cancel the prompt' }));
    await waitFor(() => assert.equal(backgroundSendPrompt('left'), 'closed'));

    // The next subscribe brings the same refusal again, already answered.
    dispatch({ kind: 'chat_subscribed', sessionId: 'session-a', isProcessing: false, lastSeq: 2, pendingPermissions: [] });
    dispatch(refusal);
    await settle();
    assert.equal(backgroundSendPrompt('left'), 'closed');
    assert.equal(backgroundSendPrompt('right'), 'closed');
    assert.equal(composerText('left'), 'and check the logs', 'not put back a second time');
    assert.equal(sends().length, 1);
  });
});

describe('sends from both panes the server refuses to run beside the background work', () => {
  it('are each undone in the pane that sent it, and each pane asks', async () => {
    await renderWorkspace(['left', 'right']);
    act(() => {
      activity.actions?.markSessionBackground('session-a', [
        { taskId: 'w1', toolUseId: 'toolu_wf', taskType: 'local_workflow', description: 'Audit', workflowName: 'audit', startedAt: 1 },
      ]);
    });
    let releasePlans = () => {};
    page.planGate = new Promise<void>((resolve) => { releasePlans = resolve; });

    // Both submits wait on the hand-over plan, so both go out as sends.
    for (const [side, text] of [['left', 'from the left'], ['right', 'from the right']] as const) {
      const textarea = pane(side).getByRole('textbox', { name: 'Message' });
      fireEvent.change(textarea, { target: { value: text } });
      fireEvent.keyDown(textarea, { key: 'Enter' });
    }
    await act(async () => { releasePlans(); });
    const sends = () => page.sent.filter(({ message }) => message.type === 'chat.send');
    await waitFor(() => assert.equal(sends().length, 2));
    const requestIdOf = (side: WorkspacePaneSide) => sends().find((send) => send.side === side)?.message.clientRequestId;
    assert.equal(typeof requestIdOf('left'), 'string');
    assert.equal(typeof requestIdOf('right'), 'string');
    assert.notEqual(requestIdOf('left'), requestIdOf('right'));
    // Each pane shows the echo of its own send.
    assert.deepEqual(transcript('left'), ['from the left']);
    assert.deepEqual(transcript('right'), ['from the right']);

    // The server refuses both, the left one first.
    for (const side of ['left', 'right'] as const) {
      dispatch({
        kind: 'send_refused',
        sessionId: 'session-a',
        reason: 'BACKGROUND_WORK_WOULD_STOP',
        changes: ['effort'],
        clientRequestId: requestIdOf(side),
      });
    }

    assert.deepEqual(transcript('left'), []);
    assert.deepEqual(transcript('right'), []);
    assert.equal(activity.actions?.getSessionActivity('session-a')?.background, true);
    await waitFor(() => assert.equal(backgroundSendPrompt('left'), 'changes: effort'));
    await waitFor(() => assert.equal(backgroundSendPrompt('right'), 'changes: effort'));
    for (const side of ['left', 'right'] as const) {
      assert.equal(composerText(side).includes('from the left'), true, `${side}: the left message is back`);
      assert.equal(composerText(side).includes('from the right'), true, `${side}: the right message is back`);
    }

    fireEvent.click(pane('left').getByRole('button', { name: 'Cancel the prompt' }));
    fireEvent.click(pane('right').getByRole('button', { name: 'Cancel the prompt' }));
    await waitFor(() => assert.equal(backgroundSendPrompt('left'), 'closed'));
    await waitFor(() => assert.equal(backgroundSendPrompt('right'), 'closed'));
    assert.equal(sends().length, 2, 'nothing more is sent');
  });
});

describe('sends from both panes refused at once, answered in the dialogs as they stack', () => {
  const sends = () => page.sent.filter(({ message }) => message.type === 'chat.send');
  // Each dialog is portaled into the body over the whole page, so the one
  // mounted last covers the other and is the one the user answers.
  const dialogs = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="dialog"]'));
  const answerTopDialog = (label: 'Cancel' | 'Queue' | 'Send anyway') => {
    const top = dialogs().at(-1);
    assert.ok(top, 'a dialog is open');
    fireEvent.click(within(top).getByRole('button', { name: label }));
  };
  const refusalOf = (side: WorkspacePaneSide) => ({
    provider: 'claude',
    timestamp: '2026-10-28T10:00:00.000Z',
    kind: 'send_refused',
    sessionId: 'session-a',
    reason: 'BACKGROUND_WORK_WOULD_STOP',
    changes: ['effort'],
    clientRequestId: sends().find((send) => send.side === side)?.message.clientRequestId,
  });

  // Both panes send while the hand-over plan is out, so both go out as sends.
  const sendFromBothPanes = async () => {
    await renderWorkspace(['left', 'right']);
    act(() => {
      activity.actions?.markSessionBackground('session-a', [
        { taskId: 'w1', toolUseId: 'toolu_wf', taskType: 'local_workflow', description: 'Audit', workflowName: 'audit', startedAt: 1 },
      ]);
    });
    let releasePlans = () => {};
    page.planGate = new Promise<void>((resolve) => { releasePlans = resolve; });
    for (const [side, text] of [['left', 'from the left'], ['right', 'from the right']] as const) {
      const textarea = pane(side).getByRole('textbox', { name: 'Message' });
      fireEvent.change(textarea, { target: { value: text } });
      fireEvent.keyDown(textarea, { key: 'Enter' });
    }
    await act(async () => { releasePlans(); });
    await waitFor(() => assert.equal(sends().length, 2));
  };

  // The left send is refused first, each refusal rendered before the next:
  // the right message goes back ahead of the left one, and the right dialog
  // goes on top.
  const refuseLeftThenRight = async () => {
    await sendFromBothPanes();
    dispatch(refusalOf('left'));
    dispatch(refusalOf('right'));
    await waitFor(() => assert.equal(dialogs().length, 2));
    assert.equal(composerText('left'), 'from the right\n\nfrom the left');
  };

  it('answered top first, send anyway in both, leave nothing behind', async () => {
    await refuseLeftThenRight();

    answerTopDialog('Send anyway');
    await waitFor(() => assert.equal(sends().length, 3));
    assert.equal(sends()[2]?.side, 'right');
    answerTopDialog('Send anyway');
    await waitFor(() => assert.equal(sends().length, 4));
    await settle();

    assert.equal(sends()[3]?.side, 'left');
    assert.equal(composerText('left'), '');
    assert.equal(composerText('right'), '');
  });

  it('the top one cancelled and the one under it sent anyway, leave only the cancelled message', async () => {
    await refuseLeftThenRight();

    answerTopDialog('Cancel');
    await waitFor(() => assert.equal(dialogs().length, 1));
    answerTopDialog('Send anyway');
    await waitFor(() => assert.equal(sends().length, 3));
    await settle();

    assert.deepEqual(sends().map(({ side, message }) => [side, message.content]).at(-1), ['left', 'from the left']);
    assert.equal(composerText('left'), 'from the right');
    assert.equal(composerText('right'), 'from the right');
  });

  it('the top one cancelled and the one under it queued, leave only the cancelled message', async () => {
    await refuseLeftThenRight();

    answerTopDialog('Cancel');
    await waitFor(() => assert.equal(dialogs().length, 1));
    answerTopDialog('Queue');
    await waitFor(() => assert.equal(dialogs().length, 0));
    await settle();

    assert.equal(sends().length, 2, 'queued, not sent');
    assert.equal(composerText('left'), 'from the right');
    assert.equal(composerText('right'), 'from the right');
  });

  it('refused together, the right one first, the top dialog\'s message is taken out though the other went back ahead of it', async () => {
    await sendFromBothPanes();
    // One render for both refusals: both dialogs mount in that commit, the
    // right pane's last, so on top.
    act(() => {
      for (const side of ['right', 'left'] as const) {
        const refusal = refusalOf(side);
        for (const listener of page.listeners) {
          listener(refusal as ServerEvent);
        }
      }
    });
    await waitFor(() => assert.equal(dialogs().length, 2));
    assert.equal(composerText('left'), 'from the left\n\nfrom the right');

    answerTopDialog('Send anyway');
    await waitFor(() => assert.equal(sends().length, 3));
    await settle();

    assert.equal(sends()[2]?.side, 'right');
    assert.equal(composerText('left'), 'from the left');
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
