import assert from 'node:assert/strict';

import { fireEvent, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import type { SessionActivity } from '@/shared/types';
import { resetUserPreferences } from '@/shared/userSettings';

/**
 * Once a Claude turn has ended with background work still running, a new
 * message runs as a new turn of the process the work runs in, so the composer
 * sends it on Enter without asking. Queueing it until the work finishes stays
 * available: the send key with Alt, and the send button's menu, which a touch
 * screen needs. A provider that starts a process per turn, or an edit, keeps
 * the plain send button: its send asks first.
 */

vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));
vi.mock('@/modules/chat/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({ state: 'idle', toggle: () => undefined, stop: () => undefined }),
}));

type ChatComposerProps = ComponentProps<typeof ChatComposer>;

const backgroundOnly: SessionActivity = {
  statusText: null,
  canInterrupt: false,
  startedAt: 1,
  background: true,
  tasks: [{ taskId: 'w1', toolUseId: 'toolu_wf', taskType: 'local_workflow', description: 'Audit', workflowName: 'audit', startedAt: 1 }],
};

const composerProps = (overrides: Partial<ChatComposerProps>): ChatComposerProps => {
  const noop = () => undefined;
  return {
    pendingPermissionRequests: [],
    handlePermissionDecision: noop,
    handleGrantToolPermission: () => ({ success: true }),
    // The turn has ended; only its background work runs, and the composer holds a message.
    activity: backgroundOnly,
    isLoading: false,
    input: 'and check the logs',
    hasInput: true,
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
    // Claude: no turn is running to insert into, but the provider takes inserts.
    insertUnavailableReason: 'unavailable',
    onSubmitBusyMode: noop,
    pendingInserts: [],
    onWithdrawInsert: noop,
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

const renderComposer = (overrides: Partial<ChatComposerProps> = {}) => render(<ChatComposer {...composerProps(overrides)} />);

const moreWaysToSend = () => screen.queryAllByRole('button', { name: 'More ways to send' });

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })));
  resetUserPreferences();
  localStorage.clear();
});

afterEach(() => {
  resetUserPreferences();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('the send button beside background work', () => {
  it('sends on Enter and queues with Alt+Enter, and says so while the message is typed', () => {
    renderComposer();
    const hints = screen.queryAllByText('Enter to send • Alt+Enter to queue until background work finishes');
    assert.equal(hints.length, 1);
    assert.equal(hints[0]?.className.includes('opacity-0'), false, 'not hidden while there is a message to send');
  });

  it('offers to send now or once the work finishes, and picks the mode', () => {
    const picked: string[] = [];
    renderComposer({ onSubmitBusyMode: (mode) => { picked.push(mode); } });

    fireEvent.click(moreWaysToSend()[0]);
    const menu = within(screen.getByRole('menu'));
    assert.equal(menu.queryAllByText('Send while background work runs').length, 1);
    assert.equal(menu.queryAllByText('Starts a new turn; the background work keeps running').length, 1);
    assert.equal(menu.queryAllByText('Send when the background work finishes').length, 1);
    assert.equal(menu.queryAllByText('Insert').length, 0, 'there is no turn to insert into');

    fireEvent.click(menu.getByRole('menuitem', { name: /^Send/ }));
    fireEvent.click(moreWaysToSend()[0]);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /^Queue/ }));
    assert.deepEqual(picked, ['insert', 'queue']);
  });

  it('names the keys a Ctrl+Enter sender uses', () => {
    renderComposer({ sendByCtrlEnter: true });
    assert.equal(screen.queryAllByText('Ctrl+Enter to send • Ctrl+Alt+Enter to queue until background work finishes').length, 1);
  });

  it('stays a plain send button where a send would stop the work', () => {
    renderComposer({ insertUnavailableReason: 'provider' });
    assert.equal(moreWaysToSend().length, 0, 'a provider that starts a process per turn asks before sending');

    renderComposer({ isEditingSentMessage: true });
    assert.equal(moreWaysToSend().length, 0, 'an edit replaces the process, so it asks too');
  });

  it('stays a plain send button for an empty composer, and for a session with no background work', () => {
    renderComposer({ input: '', hasInput: false });
    assert.equal(moreWaysToSend().length, 0);

    renderComposer({ activity: null });
    assert.equal(moreWaysToSend().length, 0);
  });

  it('has its strings in English and Simplified Chinese', () => {
    const keys = [
      'input.hintText.sendBesideBackgroundWork',
      'input.backgroundSend.menuLabel',
      'input.backgroundSend.send',
      'input.backgroundSend.sendDescription',
      'input.backgroundSend.queueDescription',
    ];
    // Read from each language's own strings: a lookup would fall back to English.
    const missing = ['en', 'zh-CN'].flatMap((language) => keys
      .filter((key) => typeof i18n.getResource(language, 'chat', key) !== 'string')
      .map((key) => `${language} ${key}`));
    assert.deepEqual(missing, []);
    assert.equal(i18n.getResource('zh-CN', 'chat', 'input.backgroundSend.queueDescription'), '后台工作结束后发送');
  });
});
