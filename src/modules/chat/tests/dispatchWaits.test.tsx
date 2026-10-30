import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { afterEach, describe, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import BackgroundSendDialog from '@/modules/chat/composer/BackgroundSendDialog';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { useDispatchWaits } from '@/modules/chat/composer/useDispatchWaits';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { SessionProtectionProvider } from '@/shared/context/SessionProtectionContext';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, DispatchWait, DispatchWaitTarget, QueuedDraft, ScheduledMessage } from '@/shared/types';

/*
 * A queued or scheduled message the server holds back says why under it, in
 * one line, with what exactly keeps it out, and offers the ways out: stop the
 * loop and send, send with the loop's settings, keep waiting, cancel. The
 * waits come from GET /api/scheduled-messages/waiting and the shared socket's
 * `dispatch_waiting` frames, both stand-ins here.
 */

const page = vi.hoisted(() => {
  const listeners = new Set<(frame: Record<string, unknown>) => void>();
  return {
    listeners,
    waits: [] as unknown[],
    waitingReads: [] as string[],
    // Holds the answer to a read, which the server made when the read came in, until it opens.
    waitingGate: null as Promise<void> | null,
    useProcessSettings: [] as string[],
    useProcessSettingsForQueued: [] as string[],
    failUse: false,
    subscribe: (listener: (frame: Record<string, unknown>) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (frame: Record<string, unknown>) => {
      for (const listener of [...listeners]) {
        listener(frame);
      }
    },
  };
});

vi.mock('@/shared/api', () => ({
  api: {
    runningSessions: async () => ({ ok: true, json: async () => ({ data: { sessions: [] } }) }),
    scheduledMessages: {
      waiting: async (sessionId: string) => {
        page.waitingReads.push(sessionId);
        const waits = page.waits;
        await page.waitingGate;
        return { ok: true, json: async () => ({ data: { waits } }) };
      },
      useProcessSettings: async (id: string) => {
        page.useProcessSettings.push(id);
        return { ok: !page.failUse, status: page.failUse ? 409 : 200 };
      },
      useProcessSettingsForQueued: async (sessionId: string) => {
        page.useProcessSettingsForQueued.push(sessionId);
        return { ok: !page.failUse, status: page.failUse ? 409 : 200 };
      },
    },
  },
}));

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: page.subscribe }),
}));
vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));
vi.mock('@/modules/chat/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({ state: 'idle', toggle: () => undefined, stop: () => undefined }),
}));

afterEach(async () => {
  page.listeners.clear();
  page.waits = [];
  page.waitingReads = [];
  page.waitingGate = null;
  page.useProcessSettings = [];
  page.useProcessSettingsForQueued = [];
  page.failUse = false;
  await act(async () => { await i18n.changeLanguage('en'); });
});

const SESSION_ID = 'session-waiting';
const HOLD_UNTIL = Date.UTC(2026, 10, 6, 9, 30);

/** A loop started in plan mode, with WebFetch allowed; the queued message is in the default mode, skips permissions, and no longer allows WebFetch. */
const queuedWait: DispatchWait = {
  target: { kind: 'queued' },
  sessionId: SESSION_ID,
  provider: 'claude',
  reason: 'held_settings',
  changes: ['tools', 'permissionMode'],
  details: {
    tools: { notAllowed: ['WebFetch', 'WebSearch'], alsoDenied: [] },
    permissionMode: { process: 'plan', message: 'bypassPermissions', reason: 'bypass_not_allowed' },
  },
  since: new Date().toISOString(),
  holdUntil: HOLD_UNTIL,
  stopTaskId: 'cron:b2148320',
  actions: ['stop_work_and_send', 'use_process_settings', 'keep_waiting', 'cancel'],
};

const scheduledRow = (id: string, minutesAgo: number): ScheduledMessage => ({
  id,
  sessionId: SESSION_ID,
  content: `scheduled ${id}`,
  options: {},
  scheduledFor: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  status: 'pending',
  failureReason: null,
  createdAt: new Date().toISOString(),
});

const scheduledWait = (id: string, overrides: Partial<DispatchWait> = {}): DispatchWait => ({
  ...queuedWait,
  target: { kind: 'scheduled', id },
  details: { tools: { notAllowed: ['WebFetch'], alsoDenied: [] } },
  changes: ['tools'],
  ...overrides,
});

const QUEUED: QueuedDraft = { content: 'fetch the changelog', attachments: [] };

type ChatComposerProps = ComponentProps<typeof ChatComposer>;

const composerProps = (overrides: Partial<ChatComposerProps>): ChatComposerProps => {
  const noop = () => undefined;
  return {
    pendingPermissionRequests: [],
    handlePermissionDecision: noop,
    handleGrantToolPermission: () => ({ success: true }),
    activity: null,
    isLoading: false,
    input: '',
    hasInput: false,
    onAbortSession: noop,
    permissionMode: 'default',
    availablePermissionModes: ['default'],
    onSelectPermissionMode: noop,
    providerLabel: 'Claude',
    effort: 'default',
    availableEffortOptions: [],
    onSelectEffort: noop,
    ultracode: null,
    onToggleUltracode: noop,
    model: 'default',
    availableModelOptions: [],
    onSelectModel: noop,
    modelsLoading: false,
    tokenBudget: null,
    onShowTokenUsage: noop,
    slashCommandsCount: 0,
    onToggleCommandMenu: noop,
    onClearInput: noop,
    onSubmit: noop,
    isDragActive: false,
    queuedDraft: null,
    backgroundSendPrompt: null,
    onResolveBackgroundSendPrompt: noop,
    isEditingSentMessage: false,
    onCancelEditMessage: noop,
    scheduledMessages: [],
    onScheduleMessage: noop,
    onCancelScheduledMessage: noop,
    onEditQueuedDraft: noop,
    onDeleteQueuedDraft: noop,
    pendingInserts: [],
    attachedFiles: [],
    onRemoveAttachment: noop,
    fileErrors: new Map(),
    showFileDropdown: false,
    filteredFiles: [],
    selectedFileIndex: -1,
    onSelectFile: noop,
    filteredCommands: [],
    selectedCommandIndex: -1,
    onCommandSelect: noop,
    onCloseCommandMenu: noop,
    isCommandMenuOpen: false,
    frequentCommands: [],
    getRootProps: () => ({}),
    getInputProps: () => ({}),
    openAttachmentPicker: noop,
    inputHighlightRef: createRef<HTMLDivElement>(),
    renderInputWithMentions: (text) => text,
    textareaRef: createRef<HTMLTextAreaElement>(),
    onInputChange: noop,
    onTextareaClick: noop,
    onTextareaKeyDown: noop,
    onTextareaPaste: noop,
    onTextareaScrollSync: noop,
    onTextareaInput: noop,
    placeholder: 'Ask Claude anything...',
    isTextareaExpanded: false,
    ...overrides,
  };
};

/** The composer as ChatInterface wires it: the waits read for the session, and what the user does with them. */
function Composer({
  sessionId = SESSION_ID,
  sent,
  ended,
  ...overrides
}: Partial<ChatComposerProps> & { sessionId?: string; sent: Array<Record<string, unknown>>; ended: DispatchWaitTarget[] }) {
  const dispatchWaits = useDispatchWaits(
    sessionId,
    (message) => { sent.push(message as Record<string, unknown>); },
    (target) => { ended.push(target); },
  );
  return <ChatComposer {...composerProps({ ...overrides, dispatchWaits })} />;
}

function renderComposer(overrides: Partial<ChatComposerProps> = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const ended: DispatchWaitTarget[] = [];
  const view = render(
    <SessionProtectionProvider>
      <Composer sent={sent} ended={ended} {...overrides} />
    </SessionProtectionProvider>,
  );
  return { ...view, sent, ended };
}

const waitingFrame = (target: DispatchWaitTarget, wait: DispatchWait | null, sessionId = SESSION_ID) => ({
  kind: 'dispatch_waiting',
  sessionId,
  target,
  wait,
  timestamp: new Date().toISOString(),
});

describe('why a queued message waits', () => {
  it('says why in one line, what exactly keeps it out, and offers the ways out, instead of "Will send when this finishes"', async () => {
    page.waits = [queuedWait];
    renderComposer({ queuedDraft: QUEUED });

    await screen.findByText(/^Waiting for the loop to end \(by .+\): this message changes the tool permissions and the permission mode$/);
    assert.equal(screen.queryByText(/Will send when this finishes/) === null, true);
    assert.equal(screen.getByText('The loop was started in plan mode, without skipping permissions') !== null, true);
    assert.equal(screen.getByText('Your tool permissions no longer allow WebFetch, WebSearch') !== null, true);
    for (const name of ['Stop the loop and send', 'Send with the loop\'s settings', 'Keep waiting', 'Cancel']) {
      assert.equal(screen.getByRole('button', { name }) !== null, true, name);
    }
    assert.equal(screen.getByText(/runs in plan mode, like the loop: Claude only makes a plan/) !== null, true, 'the loop\'s settings are said before they are picked');
    assert.deepEqual(page.waitingReads, [SESSION_ID]);
  });

  it('reads in the interface language', async () => {
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    page.waits = [queuedWait];
    renderComposer({ queuedDraft: QUEUED });

    await screen.findByText(/^在等循环结束（最晚 .+）：这条消息改了工具权限和权限模式$/);
    assert.equal(screen.getByText('循环是在 plan 模式下启动的，没有跳过权限') !== null, true);
    assert.equal(screen.getByText('你的工具权限不再允许 WebFetch、WebSearch') !== null, true);
    assert.equal(screen.getByRole('button', { name: '停掉循环再发' }) !== null, true);
    assert.equal(screen.getByRole('button', { name: '用循环的设置发' }) !== null, true);
    assert.equal(screen.getByText(/会像循环一样以 plan 模式运行/) !== null, true);
  });

  it('stops the loop with chat.stop-task for all its scheduled work, follows only its own answer, and says when the loop was not stopped', async () => {
    page.waits = [queuedWait];
    const { sent } = renderComposer({ queuedDraft: QUEUED });
    fireEvent.click(await screen.findByRole('button', { name: 'Stop the loop and send' }));

    assert.equal(sent.length, 1);
    const [stop] = sent;
    assert.deepEqual([stop.type, stop.sessionId, stop.taskId, stop.allScheduled], ['chat.stop-task', SESSION_ID, 'cron:b2148320', true]);
    assert.equal(typeof stop.clientRequestId, 'string');
    assert.equal(screen.getByText('Stopping the loop…') !== null, true);

    act(() => { page.emit({ kind: 'stop_task_status', sessionId: SESSION_ID, taskId: 'cron:b2148320', status: 'failed', clientRequestId: 'another-pane' }); });
    assert.equal(screen.getByText('Stopping the loop…') !== null, true, 'another pane\'s answer is not this one\'s');

    act(() => { page.emit({ kind: 'stop_task_status', sessionId: SESSION_ID, taskId: 'cron:b2148320', status: 'finished', stillHeld: true, clientRequestId: stop.clientRequestId }); });
    await screen.findByText('The loop was not stopped. Try again, or stop it from the task strip.');
    assert.equal(screen.getByRole('button', { name: 'Stop the loop and send' }) !== null, true, 'and can be asked again');
  });

  it('sends with the loop\'s settings through the server, and says when that did not work', async () => {
    page.waits = [queuedWait];
    renderComposer({ queuedDraft: QUEUED });
    fireEvent.click(await screen.findByRole('button', { name: 'Send with the loop\'s settings' }));
    await waitFor(() => assert.deepEqual(page.useProcessSettingsForQueued, [SESSION_ID]));

    page.failUse = true;
    fireEvent.click(await screen.findByRole('button', { name: 'Send with the loop\'s settings' }));
    await screen.findByText('That did not work. The message may have gone already.');
  });

  it('keeps waiting with the actions folded away, the reason kept, and a way to unfold them; cancel takes the message off', async () => {
    page.waits = [queuedWait];
    const deleted: number[] = [];
    renderComposer({ queuedDraft: QUEUED, onDeleteQueuedDraft: () => { deleted.push(1); } });
    fireEvent.click(await screen.findByRole('button', { name: 'Keep waiting' }));

    assert.equal(screen.queryByRole('button', { name: 'Stop the loop and send' }) === null, true);
    assert.equal(screen.getByText(/^Waiting for the loop to end/) !== null, true);
    fireEvent.click(screen.getByRole('button', { name: 'Options' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    assert.equal(deleted.length, 1);
    assert.equal(screen.queryByText(/^Waiting for the loop to end/) === null, true, 'its wait goes with it');
  });

  it('follows the dispatch_waiting frames of its own session, and reads again once the socket reconnects', async () => {
    const { ended } = renderComposer({ queuedDraft: QUEUED });
    await waitFor(() => assert.deepEqual(page.waitingReads, [SESSION_ID]));
    assert.equal(screen.getByText(/Will send when this finishes/) !== null, true);

    act(() => { page.emit(waitingFrame({ kind: 'queued' }, { ...queuedWait, sessionId: 'another-session' }, 'another-session')); });
    assert.equal(screen.queryByText(/^Waiting for the loop to end/) === null, true, 'another session\'s');

    act(() => { page.emit(waitingFrame({ kind: 'queued' }, queuedWait)); });
    await screen.findByText(/^Waiting for the loop to end/);
    act(() => { page.emit(waitingFrame({ kind: 'queued' }, { ...queuedWait, reason: 'held_work', changes: [], details: undefined, actions: ['keep_waiting', 'cancel'] })); });
    await screen.findByText('Waiting for the background work to finish');
    act(() => { page.emit(waitingFrame({ kind: 'queued' }, null)); });
    await screen.findByText(/Will send when this finishes/);
    assert.deepEqual(ended, [{ kind: 'queued' }]);

    act(() => { page.emit({ kind: 'websocket_reconnected' }); });
    await waitFor(() => assert.deepEqual(page.waitingReads, [SESSION_ID, SESSION_ID]));
  });
});

describe('why a scheduled message waits', () => {
  it('says a due message is due and waiting, why, and what can be done, and a message behind it waits for it', async () => {
    page.waits = [
      scheduledWait('first'),
      scheduledWait('second', { reason: 'behind', changes: [], details: undefined, stopTaskId: undefined, actions: ['keep_waiting', 'cancel'] }),
    ];
    const cancelled: string[] = [];
    renderComposer({
      scheduledMessages: [scheduledRow('first', 10), scheduledRow('second', 5), { ...scheduledRow('later', -60) }],
      onCancelScheduledMessage: (id) => { cancelled.push(id); },
    });

    await screen.findByText(/this message changes the tool permissions$/);
    assert.equal(screen.getAllByText(/^Due .+, still waiting$/).length, 2);
    assert.equal(screen.getAllByText(/^Scheduled for /).length, 1, 'one not due yet reads as before');
    assert.equal(screen.getByText('Waiting for an earlier scheduled message to go') !== null, true);
    assert.equal(screen.getByText(/uses the loop's tool permissions, which allow WebFetch/) !== null, true);

    fireEvent.click(screen.getByRole('button', { name: 'Send with the loop\'s settings' }));
    await waitFor(() => assert.deepEqual(page.useProcessSettings, ['first']));

    // The one behind offers only to cancel: there is nothing to stop or lend for it.
    const cancelButtons = screen.getAllByRole('button', { name: 'Cancel' });
    assert.equal(cancelButtons.length, 2);
    fireEvent.click(cancelButtons[1]!);
    assert.deepEqual(cancelled, ['second']);
  });

  it('keeps the answer of a read that frames overtook, with those frames laid over it', async () => {
    let openGate: () => void = () => undefined;
    page.waitingGate = new Promise<void>((resolve) => { openGate = resolve; });
    page.waits = [queuedWait, scheduledWait('first')];
    const { ended } = renderComposer({
      queuedDraft: QUEUED,
      scheduledMessages: [scheduledRow('first', 10), scheduledRow('second', 5)],
    });
    await waitFor(() => assert.deepEqual(page.waitingReads, [SESSION_ID]));

    // While the read is out, the first scheduled message goes and the second starts waiting. The
    // queued message's wait does not change, so no frame says it again.
    act(() => { page.emit(waitingFrame({ kind: 'scheduled', id: 'first' }, null)); });
    act(() => {
      page.emit(waitingFrame({ kind: 'scheduled', id: 'second' }, scheduledWait('second', { details: { tools: { notAllowed: ['WebSearch'], alsoDenied: [] } } })));
    });
    await act(async () => { openGate(); });

    await screen.findByText(/^Waiting for the loop to end \(by .+\): this message changes the tool permissions and the permission mode$/);
    assert.equal(screen.queryByText('Your tool permissions no longer allow WebSearch') !== null, true, 'the frame that came during the read');
    assert.equal(screen.queryByText('Your tool permissions no longer allow WebFetch') === null, true, 'the read\'s answer for a message that has gone since');
    assert.deepEqual(ended, [{ kind: 'scheduled', id: 'first' }]);
  });

  it('reads the list again once a scheduled message stops waiting', async () => {
    page.waits = [scheduledWait('first')];
    const { ended } = renderComposer({ scheduledMessages: [scheduledRow('first', 10)] });
    await screen.findByText(/this message changes the tool permissions$/);
    act(() => { page.emit(waitingFrame({ kind: 'scheduled', id: 'first' }, null)); });
    assert.deepEqual(ended, [{ kind: 'scheduled', id: 'first' }]);
  });
});

describe('a wait for a process a task holds besides the loop', () => {
  const workWait = scheduledWait('first', {
    heldFor: 'work',
    changes: ['permissionMode'],
    details: { permissionMode: { process: 'plan', message: 'bypassPermissions', reason: 'bypass_not_allowed' } },
    stopTaskId: undefined,
    actions: ['use_process_settings', 'keep_waiting', 'cancel'],
  });

  it('says the message waits for the background work, and offers the background process\'s settings, naming no loop', async () => {
    page.waits = [workWait];
    const { container } = renderComposer({ scheduledMessages: [scheduledRow('first', 10)] });

    await screen.findByText('Waiting for the background work to finish: this message changes the permission mode');
    assert.equal(screen.getByText('The background process was started in plan mode, without skipping permissions') !== null, true);
    assert.equal(screen.getByRole('button', { name: 'Send with the background process\'s settings' }) !== null, true);
    assert.equal(screen.getByText('With the background process\'s settings it runs in plan mode: Claude only makes a plan.') !== null, true);
    const noticeText = container.querySelector('[data-dispatch-wait]')?.textContent ?? '';
    assert.equal(/loop/i.test(noticeText), false, 'no loop is named');
  });

  it('reads in the interface language', async () => {
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    page.waits = [workWait];
    renderComposer({ scheduledMessages: [scheduledRow('first', 10)] });

    await screen.findByText('在等后台工作结束：这条消息改了权限模式');
    assert.equal(screen.getByText('后台进程是在 plan 模式下启动的，没有跳过权限') !== null, true);
    assert.equal(screen.getByRole('button', { name: '用后台进程的设置发' }) !== null, true);
  });
});

describe('what keeps a send out, in the dialog and the transcript', () => {
  it('the background-send dialog says what exactly keeps the message out', () => {
    render(
      <BackgroundSendDialog
        prompt={{ work: ['Loop check CI'], changes: ['tools'], details: { tools: { notAllowed: [], alsoDenied: ['Bash'] } }, queue: false }}
        onResolve={() => undefined}
      />,
    );
    assert.equal(screen.getByText('Your tool permissions now deny Bash') !== null, true);
  });

  it('the background-send dialog calls the process the loop\'s only when loops alone hold it', () => {
    const details = { permissionMode: { process: 'default', message: 'bypassPermissions', reason: 'bypass_not_allowed' as const } };
    const { rerender } = render(
      <BackgroundSendDialog prompt={{ work: ['Review the diff', 'Loop check CI'], changes: ['permissionMode'], details }} onResolve={() => undefined} />,
    );
    assert.equal(screen.queryByText('The background process was started without skipping permissions, and cannot skip them now') !== null, true);
    assert.equal(screen.queryByText(/^The loop was started/) === null, true);

    rerender(
      <BackgroundSendDialog prompt={{ work: ['Loop check CI'], changes: ['permissionMode'], details, queue: false }} onResolve={() => undefined} />,
    );
    assert.equal(screen.queryByText('The loop was started without skipping permissions, and cannot skip them now') !== null, true);
  });

  it('a turn the CLI would not switch to skipping permissions says so, in the interface language', async () => {
    const notice: ChatMessage = {
      type: 'error',
      content: 'Claude Code refused to switch to bypassPermissions: this turn runs in plan mode, and asks before it uses tools.',
      timestamp: new Date().toISOString(),
      errorCode: 'PERMISSION_MODE_NOT_SWITCHED',
      errorReason: 'plan',
    };
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    render(
      <UiPreferencesProvider>
        <MessageComponent message={notice} prevMessage={null} createDiff={() => []} provider="claude" />
      </UiPreferencesProvider>,
    );
    assert.equal(screen.getByText(/Claude Code 拒绝跳过权限：这一轮以 plan 模式运行/) !== null, true);
  });
});
