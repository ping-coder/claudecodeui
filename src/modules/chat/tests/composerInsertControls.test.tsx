import assert from 'node:assert/strict';

import { fireEvent, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import type { PendingInsert } from '@/shared/types';
import { resetUserPreferences } from '@/shared/userSettings';

/**
 * While a turn runs and the composer holds a message, the send button becomes
 * two halves: the button does what Enter does (insert when the message can go
 * into the turn, queue otherwise), and a menu offers Insert and Queue with
 * their keys. Insert is dimmed, saying why, when the message cannot go in, as
 * for every provider but Claude. Inserts the model has not read yet are listed
 * above the composer with a withdraw button each.
 */

vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));
vi.mock('@/modules/chat/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({ state: 'idle', toggle: () => undefined, stop: () => undefined }),
}));

type ChatComposerProps = ComponentProps<typeof ChatComposer>;

const composerProps = (overrides: Partial<ChatComposerProps>): ChatComposerProps => {
  const noop = () => undefined;
  return {
    pendingPermissionRequests: [],
    handlePermissionDecision: noop,
    handleGrantToolPermission: () => ({ success: true }),
    activity: null,
    // A turn is running and the composer holds a message.
    isLoading: true,
    input: 'look at the tests too',
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
    insertUnavailableReason: null,
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

const openSendMenu = () => {
  fireEvent.click(screen.getByRole('button', { name: 'More ways to send' }));
  return within(screen.getByRole('menu'));
};

const insert = (overrides: Partial<PendingInsert>): PendingInsert => ({
  insertId: 'i1',
  sessionId: 'session-1',
  content: 'also check the docs',
  state: 'pending',
  ...overrides,
});

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

describe('the send button while a turn runs', () => {
  it('inserts on Enter when the message can go in, and says so', () => {
    renderComposer();

    assert.equal(screen.queryAllByRole('button', { name: 'Insert message' }).length, 1);
    assert.equal(screen.queryAllByText('Enter to insert • Alt+Enter to queue').length, 1);
  });

  it('names Ctrl+Enter and Ctrl+Alt+Enter when Ctrl+Enter sends', () => {
    renderComposer({ sendByCtrlEnter: true });

    assert.equal(screen.queryAllByText('Ctrl+Enter to insert • Ctrl+Alt+Enter to queue').length, 1);
  });

  it('says Alt+Enter adds to a queued message that is waiting', () => {
    renderComposer({ queuedDraft: { content: 'queued earlier', attachments: [] } });

    assert.equal(screen.queryAllByText('Enter to insert • Alt+Enter to add to the queued message').length, 1);
    assert.equal(openSendMenu().queryAllByText('Add to the queued message').length, 1);
  });

  it('opens a menu whose Insert and Queue send as picked', () => {
    const onSubmitBusyMode = vi.fn();
    renderComposer({ onSubmitBusyMode });

    let menu = openSendMenu();
    assert.equal(menu.getByRole('menuitem', { name: /Insert/ }).getAttribute('aria-disabled'), null);
    assert.equal(menu.queryAllByText('Claude reads it at its next step').length, 1);
    // The dispatcher sends a queued message once the session is idle, which a
    // turn that leaves background work going is not: the item says so.
    assert.equal(menu.queryAllByText('Send when this turn and any background work are done').length, 1);
    // Each choice shows its key.
    assert.equal(menu.getByRole('menuitem', { name: /Insert/ }).querySelector('kbd')?.textContent, 'Enter');
    assert.equal(menu.getByRole('menuitem', { name: /Queue/ }).querySelector('kbd')?.textContent, 'Alt+Enter');
    fireEvent.click(menu.getByRole('menuitem', { name: /Queue/ }));
    assert.deepEqual(onSubmitBusyMode.mock.calls, [['queue']]);
    assert.equal(screen.queryAllByRole('menu').length, 0, 'a pick closes the menu');

    menu = openSendMenu();
    fireEvent.click(menu.getByRole('menuitem', { name: /Insert/ }));
    assert.deepEqual(onSubmitBusyMode.mock.calls, [['queue'], ['insert']]);
  });

  it('dims Insert for a provider that cannot insert, saying it will queue, and queues on Enter', () => {
    const onSubmitBusyMode = vi.fn();
    renderComposer({ providerLabel: 'Codex', insertUnavailableReason: 'provider', onSubmitBusyMode });

    assert.equal(screen.queryAllByRole('button', { name: 'Queue next message' }).length, 1);
    assert.equal(screen.queryAllByText('Enter to queue your next message').length, 1);

    const menu = openSendMenu();
    const insertItem = menu.getByRole('menuitem', { name: /Insert/ });
    assert.equal(insertItem.getAttribute('aria-disabled'), 'true');
    assert.equal(insertItem.querySelector('kbd') === null, true);
    assert.equal(menu.getByRole('menuitem', { name: /Queue/ }).querySelector('kbd')?.textContent, 'Enter');
    assert.equal(insertItem.getAttribute('title'), 'Codex does not support insert, so it will be queued');
    assert.equal(menu.queryAllByText('Codex does not support insert, so it will be queued').length, 1);
    fireEvent.click(insertItem);
    assert.equal(onSubmitBusyMode.mock.calls.length, 0, 'a dimmed Insert does nothing');
  });

  it('dims Insert for a slash command, saying why', () => {
    renderComposer({ input: '/compact', insertUnavailableReason: 'slashCommand' });

    const menu = openSendMenu();
    assert.equal(menu.getByRole('menuitem', { name: /Insert/ }).getAttribute('aria-disabled'), 'true');
    assert.equal(menu.queryAllByText('A slash command cannot be inserted, so it will be queued').length, 1);
  });

  it('queues as before when the composer is given no insert controls', () => {
    renderComposer({ insertUnavailableReason: undefined, onSubmitBusyMode: undefined });

    assert.equal(screen.queryAllByRole('button', { name: 'Queue next message' }).length, 1);
    assert.equal(screen.queryAllByText('Enter to queue your next message').length, 1);
    assert.equal(screen.queryAllByRole('button', { name: 'More ways to send' }).length, 0);
  });

  it('is one plain button while the session is idle', () => {
    renderComposer({ isLoading: false });

    assert.equal(screen.queryAllByRole('button', { name: 'More ways to send' }).length, 0);
    assert.equal(screen.queryAllByRole('button', { name: 'Send' }).length, 1);
  });

  it('is the stop button while a turn runs and the composer is empty', () => {
    renderComposer({ input: '', hasInput: false });

    assert.equal(screen.queryAllByRole('button', { name: 'More ways to send' }).length, 0);
    assert.equal(screen.queryAllByRole('button', { name: 'Stop' }).length, 1);
  });
});

describe('the strings', () => {
  it('are written in English and Simplified Chinese', () => {
    const keys = [
      'input.hintText.insert',
      'input.hintText.insertAppendQueued',
      'input.insert.send',
      'input.insert.moreOptions',
      'input.insert.menuLabel',
      'input.insert.insert',
      'input.insert.willRead',
      'input.insert.queue',
      'input.insert.queueDescription',
      'input.insert.queueAppend',
      'input.insert.unsupported',
      'input.insert.slashCommand',
      'input.insert.attachments',
      'input.insert.unavailable',
      'input.insert.label',
      'input.insert.afterApproval',
      'input.insert.withdraw',
      'input.insert.delivering',
      'input.insert.withdrawFailed',
      'input.insert.notDelivered',
      'input.insert.noResponse',
      'input.insert.deliveredLate',
      'message.inserted',
      'message.insertedHint',
    ];
    const missing = ['en', 'zh-CN'].flatMap((language) => keys
      .filter((key) => typeof i18n.getResource(language, 'chat', key) !== 'string')
      .map((key) => `${language}:${key}`));

    assert.deepEqual(missing, []);
    assert.equal(i18n.getResource('zh-CN', 'chat', 'input.insert.unsupported'), '{{provider}} 不支持插入，将排队');
    assert.equal(i18n.getResource('zh-CN', 'chat', 'input.insert.queueDescription'), '本轮和后台工作都结束后发送');
  });
});

describe('the pending inserts card', () => {
  it('lists each insert with a withdraw button that names it', () => {
    const onWithdrawInsert = vi.fn();
    renderComposer({
      input: '',
      hasInput: false,
      pendingInserts: [insert({ insertId: 'i1', content: 'first' }), insert({ insertId: 'i2', content: 'second' })],
      onWithdrawInsert,
    });

    assert.equal(screen.queryAllByText('Inserting').length, 1);
    assert.equal(screen.queryAllByText('· Claude reads it at its next step').length, 1);
    assert.equal(screen.queryAllByText('first').length, 1);
    assert.equal(screen.queryAllByText('second').length, 1);
    const withdrawButtons = screen.getAllByRole('button', { name: 'Withdraw inserted message' });
    assert.equal(withdrawButtons.length, 2);
    fireEvent.click(withdrawButtons[1]);
    assert.deepEqual(onWithdrawInsert.mock.calls, [['i2']]);
  });

  it('cannot withdraw before the server holds the insert or while a withdrawal is on its way', () => {
    renderComposer({
      pendingInserts: [insert({ insertId: 'i1', state: 'sending' }), insert({ insertId: 'i2', state: 'withdrawing' })],
    });

    const disabled = screen.getAllByRole('button', { name: 'Withdraw inserted message' })
      .map((button) => (button as HTMLButtonElement).disabled);
    assert.deepEqual(disabled, [true, true]);
  });

  it('says when the insert is already being delivered, or could not be withdrawn', () => {
    renderComposer({
      pendingInserts: [insert({ insertId: 'i1', state: 'delivering' }), insert({ insertId: 'i2', state: 'withdrawFailed' })],
    });

    assert.equal(screen.queryAllByText('Already being delivered, cannot withdraw').length, 1);
    assert.equal(screen.queryAllByText('Could not withdraw').length, 1);
    assert.equal(screen.queryAllByRole('button', { name: 'Withdraw inserted message' }).length, 0);
  });

  it('says the inserts wait for a permission request or plan approval to be answered', () => {
    renderComposer({
      pendingInserts: [insert({})],
      pendingPermissionRequests: [{ requestId: 'r1', toolName: 'ExitPlanMode', input: { plan: 'Plan' } }],
    });

    assert.equal(screen.queryAllByText('· Delivered once the request above is answered').length, 1);
    assert.equal(screen.queryAllByText('· Claude reads it at its next step').length, 0);
  });

  it('is not shown with nothing pending', () => {
    renderComposer({ pendingInserts: [] });

    assert.equal(screen.queryAllByText('Inserting').length, 0);
  });
});
