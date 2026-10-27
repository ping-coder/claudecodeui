import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { LLMProvider, PermissionMode, Project, ProjectSession } from '@/shared/types';
import { resetUserPreferences } from '@/shared/userSettings';

/**
 * Antigravity's runtime refuses a turn that carries attachments. The composer
 * used to offer the paperclip, drag-and-drop and image paste for every
 * provider, so the user only learned this from an error after sending. It now
 * follows the provider's attachment capabilities.
 *
 * A dropped file is still caught for such a provider: turning the drop zone off
 * left a drop on the composer uncancelled, and the browser then opened the file
 * itself (Firefox and Safari in place of the app).
 */

// The voice hooks reach for a preferences provider and a health endpoint that
// have nothing to do with attachments.
vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));
vi.mock('@/modules/chat/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({ state: 'idle', toggle: () => undefined, stop: () => undefined }),
}));

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

const SESSION: ProjectSession = { id: 'session-1' };

type AttachmentSupport = { supportsImageAttachments?: boolean; supportsFileAttachments?: boolean };

const composerStateArgs = (
  provider: LLMProvider,
  attachmentSupport: AttachmentSupport,
): Parameters<typeof useChatComposerState>[0] => ({
  selectedProject: PROJECT,
  selectedSession: SESSION,
  currentSessionId: SESSION.id,
  provider,
  permissionMode: 'default',
  cyclePermissionMode: () => undefined,
  resolvePermissionModeForProvider: () => 'default' as PermissionMode,
  currentProviderModel: 'test-model',
  currentProviderEffort: 'default',
  ...attachmentSupport,
  isLoading: false,
  canAbortSession: false,
  tokenBudget: null,
  sendMessage: () => undefined,
  scrollToBottom: () => undefined,
  addMessage: () => undefined,
  setIsUserScrolledUp: () => undefined,
  setPendingPermissionRequests: () => undefined,
});

const renderComposerState = (provider: LLMProvider, attachmentSupport: AttachmentSupport = {}) => (
  renderHook(() => useChatComposerState(composerStateArgs(provider, attachmentSupport)))
);

/** A paste event carrying one image, the shape the composer's paste handler reads. */
const imagePasteEvent = (file: File) => ({
  clipboardData: {
    items: [{ type: file.type, getAsFile: () => file }],
    files: [],
  },
}) as never;

beforeEach(() => {
  // The composer's slash-command hook fetches commands and skills on mount.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })),
  );
  resetUserPreferences();
  localStorage.clear();
});

afterEach(() => {
  resetUserPreferences();
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('a pasted image is not attached for a provider that takes no attachments', async () => {
  const view = renderComposerState('agy', { supportsImageAttachments: false, supportsFileAttachments: false });

  await act(async () => {
    view.result.current.handlePaste(imagePasteEvent(new File(['png'], 'shot.png', { type: 'image/png' })));
  });

  assert.deepEqual(view.result.current.attachedFiles, []);
});

test('a pasted image is still attached for a provider that takes images', async () => {
  // Capabilities left out: every existing caller keeps attachments working.
  const view = renderComposerState('claude');

  await act(async () => {
    view.result.current.handlePaste(imagePasteEvent(new File(['png'], 'shot.png', { type: 'image/png' })));
  });

  assert.deepEqual(view.result.current.attachedFiles.map((file) => file.name), ['shot.png']);
});

type ChatComposerProps = ComponentProps<typeof ChatComposer>;

const composerProps = (overrides: Partial<ChatComposerProps>): ChatComposerProps => {
  const noop = () => undefined;
  return {
    pendingPermissionRequests: [],
    handlePermissionDecision: noop,
    handleGrantToolPermission: () => ({ success: true }),
    activity: null,
    isLoading: false,
    onAbortSession: noop,
    permissionMode: 'default',
    availablePermissionModes: ['default'],
    onSelectPermissionMode: noop,
    providerLabel: 'Antigravity',
    effort: 'default',
    availableEffortOptions: [],
    onSelectEffort: noop,
    ultracode: null,
    onToggleUltracode: noop,
    model: 'auto',
    availableModelOptions: [],
    onSelectModel: noop,
    modelsLoading: false,
    tokenBudget: null,
    onShowTokenUsage: noop,
    slashCommandsCount: 0,
    onToggleCommandMenu: noop,
    hasInput: false,
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
    input: '',
    onInputChange: noop,
    onTextareaClick: noop,
    onTextareaKeyDown: noop,
    onTextareaPaste: noop,
    onTextareaScrollSync: noop,
    onTextareaInput: noop,
    placeholder: 'Ask Antigravity anything...',
    isTextareaExpanded: false,
    ...overrides,
  };
};

const renderComposer = (overrides: Partial<ChatComposerProps>) => render(<ChatComposer {...composerProps(overrides)} />);

test('the attach button is disabled and says why for a provider that takes no attachments', () => {
  const openAttachmentPicker = vi.fn();
  renderComposer({ attachmentsSupported: false, openAttachmentPicker });

  const button = screen.getByRole('button', { name: 'Antigravity does not support attachments yet' });
  assert.equal((button as HTMLButtonElement).disabled, true);
  assert.equal(screen.queryByRole('button', { name: 'Attach files' }) === null, true);
});

test('the attach button stays available by default', () => {
  renderComposer({ providerLabel: 'Claude' });

  const button = screen.getByRole('button', { name: 'Attach files' });
  assert.equal((button as HTMLButtonElement).disabled, false);
});

test('dragging files over the composer shows the drop overlay only when attachments are supported', () => {
  const unsupported = renderComposer({ isDragActive: true, attachmentsSupported: false });
  assert.ok(screen.queryByText('Drop files here') === null, 'no drop overlay without attachment support');
  unsupported.unmount();

  renderComposer({ isDragActive: true, providerLabel: 'Claude' });
  assert.ok(screen.getByText('Drop files here'));
});

/**
 * The real composer state wired into the real composer the way ChatInterface
 * wires them, so a drop goes through react-dropzone's own handlers.
 */
function ComposerWithState({ provider, providerLabel, attachmentsSupported }: {
  provider: LLMProvider;
  providerLabel: string;
  attachmentsSupported: boolean;
}) {
  const state = useChatComposerState(composerStateArgs(provider, {
    supportsImageAttachments: attachmentsSupported,
    supportsFileAttachments: attachmentsSupported,
  }));
  return (
    <ChatComposer
      {...composerProps({
        providerLabel,
        attachmentsSupported,
        attachedFiles: state.attachedFiles,
        fileErrors: state.fileErrors,
        getRootProps: state.getRootProps as ChatComposerProps['getRootProps'],
        getInputProps: state.getInputProps as ChatComposerProps['getInputProps'],
        isDragActive: state.isDragActive,
        openAttachmentPicker: state.openAttachmentPicker,
        inputHighlightRef: state.inputHighlightRef,
        textareaRef: state.textareaRef,
      })}
    />
  );
}

/**
 * Drops files from the desktop onto the composer's textarea, as a browser
 * would, and waits for react-dropzone to read them. Resolves to whether the
 * drop's default action (the browser opening the file) was left to run.
 */
const dropFilesOnComposer = async (files: File[]): Promise<boolean> => {
  const textarea = screen.getByRole('textbox');
  const dataTransfer = { files, types: ['Files'] };
  let defaultActionRuns = true;
  await act(async () => {
    fireEvent.dragEnter(textarea, { dataTransfer });
    fireEvent.dragOver(textarea, { dataTransfer });
    defaultActionRuns = fireEvent.drop(textarea, { dataTransfer });
    // react-dropzone reads the dropped files asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return defaultActionRuns;
};

test('a file dropped on the composer of a provider that takes no attachments is caught, not attached, and explained', async () => {
  render(<ComposerWithState provider="agy" providerLabel="Antigravity" attachmentsSupported={false} />);

  const defaultActionRuns = await dropFilesOnComposer([
    new File(['png'], 'shot.png', { type: 'image/png' }),
    new File(['notes'], 'notes.txt', { type: 'text/plain' }),
  ]);

  assert.equal(defaultActionRuns, false, 'the browser must not open the dropped file');
  assert.ok(screen.queryByRole('button', { name: /^Remove / }) === null, 'no dropped file is attached');
  assert.equal(screen.getByRole('alert').textContent, 'Antigravity does not support attachments yet');
});

test('a file dropped on the composer is still attached for a provider that takes attachments', async () => {
  render(<ComposerWithState provider="claude" providerLabel="Claude" attachmentsSupported />);

  const defaultActionRuns = await dropFilesOnComposer([
    new File(['notes'], 'notes.txt', { type: 'text/plain' }),
  ]);

  assert.equal(defaultActionRuns, false);
  assert.ok(await screen.findByRole('button', { name: 'Remove notes.txt' }));
  assert.ok(screen.queryByRole('alert') === null, 'no refusal notice when attachments are supported');
});
