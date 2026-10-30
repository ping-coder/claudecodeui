import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
  TouchEvent,
} from 'react';
import { PaperclipIcon, MessageSquareIcon, XIcon, Loader2, ArrowUpIcon, PencilIcon } from 'lucide-react';

import { useVoiceInput } from '@/modules/chat/hooks/useVoiceInput';
import { useVoiceAvailable } from '@/modules/chat/hooks/useVoiceAvailable';
import type { ActivityDetails, ActivityProgress, BackgroundSendChoice, BackgroundSendPrompt, BusySubmitMode, DispatchWait, InsertUnavailableReason, PendingInsert, QueuedDraft, ScheduledMessage, SlashCommand,SessionActivity,PendingPermissionRequest,PermissionMode,ProviderModelOption } from '@/shared/types';
import {
  PromptInput,
  PromptInputHeader,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
} from '@/modules/chat/composer/PromptInput';
import CommandMenu from '@/modules/chat/composer/CommandMenu';
import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import ComposerAttachment from '@/modules/chat/composer/ComposerAttachment';
import VoiceInputButton from '@/modules/chat/composer/VoiceInputButton';
import PermissionRequestsBanner from '@/modules/chat/composer/PermissionRequestsBanner';
import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';
import QueuedMessageCard from '@/modules/chat/composer/QueuedMessageCard';
import PendingInsertsCard from '@/modules/chat/composer/PendingInsertsCard';
import BusySendMenu from '@/modules/chat/composer/BusySendMenu';
import BackgroundSendDialog from '@/modules/chat/composer/BackgroundSendDialog';
import { ScheduleMessagePopover } from '@/modules/chat/composer/ScheduleMessagePopover';
import { ScheduledMessageList } from '@/modules/chat/composer/ScheduledMessageList';
import DispatchWaitNotice from '@/modules/chat/composer/DispatchWaitNotice';
import type { useDispatchWaits } from '@/modules/chat/composer/useDispatchWaits';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import ComposerPermissionMenu from '@/modules/chat/composer/ComposerPermissionMenu';
import { holdsOnlyScheduledWork } from '@/modules/chat/utils/scheduledWork';

type MentionableFile = {
  name: string;
  path: string;
};

// How long the notice explaining refused dropped files stays up.
const REFUSED_DROP_NOTICE_MS = 4000;

// Whether a drag carries files rather than text or a link, read the same way
// react-dropzone reads it ('application/x-moz-file' is Firefox's type).
const dragCarriesFiles = (event: DragEvent<HTMLElement>): boolean => (
  Array.from(event.dataTransfer?.types ?? []).some(
    (type) => type === 'Files' || type === 'application/x-moz-file',
  )
);

type ChatComposerProps = {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  activity: SessionActivity | null;
  /**
   * The session `activity` belongs to: the viewed one. The activity tab
   * starts afresh in each, so a details panel opened in one session never
   * opens over another's transcript.
   */
  activitySessionId?: string | null;
  /** How far the activity's work has got, for the activity tab's progress readout; null when there is nothing to count. */
  activityProgress?: ActivityProgress | null;
  /** Reads what the activity tab's details panel lists, at the tab's clock (epoch ms); called only while the panel is open. */
  readActivityDetails?: (nowMs: number) => ActivityDetails | null;
  /** The transcript pane above the composer, whose height is the room the activity tab's details panel can open into. */
  transcriptRef?: RefObject<HTMLElement>;
  isLoading: boolean;
  onAbortSession: () => void;
  permissionMode: PermissionMode;
  availablePermissionModes: PermissionMode[];
  onSelectPermissionMode: (mode: PermissionMode) => void;
  providerLabel: string;
  effort: string;
  availableEffortOptions: NonNullable<ProviderModelOption['effort']>['values'];
  onSelectEffort: (effort: string) => void;
  /** Ultracode switch for the next turn; `null` when the active model cannot run it. */
  ultracode: boolean | null;
  onToggleUltracode: (ultracode: boolean) => void;
  model: string;
  availableModelOptions: ProviderModelOption[];
  onSelectModel: (model: string) => void;
  modelsLoading: boolean;
  tokenBudget: Record<string, unknown> | null;
  onShowTokenUsage: () => void;
  slashCommandsCount: number;
  onToggleCommandMenu: () => void;
  hasInput: boolean;
  onClearInput: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement> | MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>) => void;
  isDragActive: boolean;
  queuedDraft: QueuedDraft | null;
  backgroundSendPrompt: BackgroundSendPrompt | null;
  onResolveBackgroundSendPrompt: (choice: BackgroundSendChoice) => void;
  /** Set while the composer is replacing an already-sent message. */
  isEditingSentMessage: boolean;
  onCancelEditMessage: () => void;
  /** Messages waiting to be sent to this session later. */
  scheduledMessages: ScheduledMessage[];
  onScheduleMessage: (scheduledFor: Date) => void;
  onCancelScheduledMessage: (id: string) => void;
  onEditQueuedDraft: () => void;
  onDeleteQueuedDraft: () => void;
  /** Why the server holds the queued and scheduled messages back, and the user's ways out (useDispatchWaits). */
  dispatchWaits?: ReturnType<typeof useDispatchWaits>;
  /** Messages inserted into this session's running turn that the model has not read yet. */
  pendingInserts?: PendingInsert[];
  onWithdrawInsert?: (insertId: string) => void;
  /**
   * Why the message in the box would be queued rather than inserted if sent
   * now, or null when Enter inserts it; read while a turn runs. After the
   * turn, while only background work runs, anything but `provider` means the
   * provider runs the message as a new turn beside that work. Absent means
   * it cannot be inserted.
   */
  insertUnavailableReason?: InsertUnavailableReason | null;
  /**
   * Sends the message in the box while a turn runs, into the turn or queued
   * behind it. Absent, the send button offers no choice and Enter decides.
   */
  onSubmitBusyMode?: (mode: BusySubmitMode) => void;
  attachedFiles: File[];
  onRemoveAttachment: (index: number) => void;
  fileErrors: Map<string, string>;
  showFileDropdown: boolean;
  filteredFiles: MentionableFile[];
  selectedFileIndex: number;
  onSelectFile: (file: MentionableFile) => void;
  filteredCommands: SlashCommand[];
  selectedCommandIndex: number;
  onCommandSelect: (command: SlashCommand, index: number, isHover: boolean) => void;
  onCloseCommandMenu: () => void;
  isCommandMenuOpen: boolean;
  frequentCommands: SlashCommand[];
  getRootProps: (...args: unknown[]) => Record<string, unknown>;
  getInputProps: (...args: unknown[]) => Record<string, unknown>;
  openAttachmentPicker: () => void;
  /**
   * False when the active provider takes no attachments. The attach button is
   * then disabled and says why, dragging shows no drop overlay, and dropped
   * files are refused with a notice saying why.
   */
  attachmentsSupported?: boolean;
  inputHighlightRef: RefObject<HTMLDivElement>;
  renderInputWithMentions: (text: string) => ReactNode;
  textareaRef: RefObject<HTMLTextAreaElement>;
  input: string;
  onVoiceTranscript?: (text: string, send?: boolean) => void;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onTextareaScrollSync: (target: HTMLTextAreaElement) => void;
  onTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  isInputFocused?: boolean;
  onInputFocusChange?: (focused: boolean) => void;
  placeholder: string;
  isTextareaExpanded: boolean;
  sendByCtrlEnter?: boolean;
};

/**
 * Rendered by chat's ChatInterface as the whole input area: textarea, pending
 * attachments, pending inserts, queued message, permission banner, voice input
 * and the model/permission popovers that drive the next turn.
 */
export default function ChatComposer({
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  activity,
  activitySessionId = null,
  activityProgress = null,
  readActivityDetails,
  transcriptRef,
  isLoading,
  onAbortSession,
  permissionMode,
  availablePermissionModes,
  onSelectPermissionMode,
  providerLabel,
  effort,
  availableEffortOptions,
  onSelectEffort,
  ultracode,
  onToggleUltracode,
  model,
  availableModelOptions,
  onSelectModel,
  modelsLoading,
  tokenBudget,
  onShowTokenUsage,
  slashCommandsCount,
  onToggleCommandMenu,
  hasInput,
  onClearInput,
  onSubmit,
  isDragActive,
  queuedDraft,
  backgroundSendPrompt,
  onResolveBackgroundSendPrompt,
  isEditingSentMessage,
  onCancelEditMessage,
  scheduledMessages,
  onScheduleMessage,
  onCancelScheduledMessage,
  onEditQueuedDraft,
  onDeleteQueuedDraft,
  dispatchWaits,
  pendingInserts = [],
  onWithdrawInsert,
  insertUnavailableReason = 'provider',
  onSubmitBusyMode,
  attachedFiles,
  onRemoveAttachment,
  fileErrors,
  showFileDropdown,
  filteredFiles,
  selectedFileIndex,
  onSelectFile,
  filteredCommands,
  selectedCommandIndex,
  onCommandSelect,
  onCloseCommandMenu,
  isCommandMenuOpen,
  frequentCommands,
  getRootProps,
  getInputProps,
  openAttachmentPicker,
  attachmentsSupported = true,
  inputHighlightRef,
  renderInputWithMentions,
  textareaRef,
  input,
  onVoiceTranscript,
  onInputChange,
  onTextareaClick,
  onTextareaKeyDown,
  onTextareaPaste,
  onTextareaScrollSync,
  onTextareaInput,
  isInputFocused = false,
  onInputFocusChange,
  placeholder,
  isTextareaExpanded,
  sendByCtrlEnter,
}: ChatComposerProps) {
  const { t } = useTranslation('chat');
  // A waiting message's notice; `cancel` takes the message off as its ✕ does.
  const renderWait = (wait: DispatchWait, cancel: () => void) => dispatchWaits && (
    <DispatchWaitNotice
      wait={wait}
      folded={dispatchWaits.isFolded(wait)}
      busy={dispatchWaits.busyOf(wait)}
      notice={dispatchWaits.noticeOf(wait)}
      onStopAndSend={() => dispatchWaits.stopAndSend(wait)}
      onUseProcessSettings={() => void dispatchWaits.sendWithProcessSettings(wait)}
      onKeepWaiting={() => dispatchWaits.keepWaiting(wait)}
      onShowActions={() => dispatchWaits.showActions(wait)}
      onCancel={() => {
        cancel();
        dispatchWaits.forget(wait.target);
      }}
    />
  );
  const queuedWait = queuedDraft ? dispatchWaits?.waitFor({ kind: 'queued' }) ?? null : null;
  const fileDropdownRef = useRef<HTMLDivElement | null>(null);
  const selectedFileRef = useRef<HTMLDivElement | null>(null);
  const commandMenuPosition = useMemo(() => {
    if (!isCommandMenuOpen) {
      return { top: 0, left: 16, bottom: 90 };
    }
    const textareaRect = textareaRef.current?.getBoundingClientRect();
    return {
      top: textareaRect ? Math.max(16, textareaRect.top - 316) : 0,
      left: textareaRect ? textareaRect.left : 16,
      bottom: textareaRect ? window.innerHeight - textareaRect.top + 8 : 90,
    };
  }, [isCommandMenuOpen, textareaRef]);

  useEffect(() => {
    const dropdown = fileDropdownRef.current;
    const selectedFile = selectedFileRef.current;
    if (!showFileDropdown || !dropdown || !selectedFile) {
      return;
    }

    const itemTop = selectedFile.offsetTop;
    const itemBottom = itemTop + selectedFile.offsetHeight;
    const visibleTop = dropdown.scrollTop;
    const visibleBottom = visibleTop + dropdown.clientHeight;

    if (itemTop < visibleTop) {
      dropdown.scrollTop = itemTop;
    } else if (itemBottom > visibleBottom) {
      dropdown.scrollTop = itemBottom - dropdown.clientHeight;
    }
  }, [selectedFileIndex, showFileDropdown]);

  // Voice state is hosted here (not in the mic button) so the main Send button can stop
  // recording and send the transcript in one tap, the way the mic button drops it in the box.
  const voiceAvailable = useVoiceAvailable();
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const voiceErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleVoiceError = useCallback((msg: string) => {
    setVoiceError(msg);
    if (voiceErrorTimer.current) clearTimeout(voiceErrorTimer.current);
    voiceErrorTimer.current = setTimeout(() => setVoiceError(null), 4000);
  }, []);
  useEffect(() => () => {
    if (voiceErrorTimer.current) clearTimeout(voiceErrorTimer.current);
  }, []);
  const noopTranscript = useCallback(() => {}, []);
  const { state: voiceState, toggle: voiceToggle, stop: voiceStop } = useVoiceInput(
    onVoiceTranscript ?? noopTranscript,
    handleVoiceError,
  );
  const isRecording = voiceState === 'recording';
  const isTranscribing = voiceState === 'transcribing';

  // When files were last dropped on the composer of a provider that takes no
  // attachments, or null once the notice saying so has timed out. The drop
  // zone still catches such a drop, so the browser does not open the file, and
  // the files are not attached. Without the notice the drop would seem to do
  // nothing at all. A new drop restarts the countdown.
  const [refusedDropAt, setRefusedDropAt] = useState<number | null>(null);
  useEffect(() => {
    if (refusedDropAt === null) return;
    const timer = setTimeout(() => setRefusedDropAt(null), REFUSED_DROP_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [refusedDropAt]);
  // Runs ahead of the drop zone's own drop handler, which still cancels the
  // drop and hands the files to the composer state that refuses them.
  const handleRefusedDrop = useCallback((event: DragEvent<HTMLElement>) => {
    if (dragCarriesFiles(event)) setRefusedDropAt(Date.now());
  }, []);

  // Detect if the AskUserQuestion interactive panel is active
  const hasQuestionPanel = pendingPermissionRequests.some(
    (r) => r.toolName === 'AskUserQuestion'
  );

  // Hide the thinking/status bar while any permission request is pending
  const hasPendingPermissions = pendingPermissionRequests.length > 0;
  const hasActivityIndicator = Boolean(activity && !hasPendingPermissions);

  const hasQueuedDraft = Boolean(queuedDraft);
  const canQueueDraft = isLoading && Boolean(input.trim() || attachedFiles.length > 0);
  // While a turn runs, the send key puts the message into the turn when it
  // can go in, and the same key with Alt queues it.
  const insertsByDefault = canQueueDraft && insertUnavailableReason === null;
  // After the turn, while only its background work runs, a provider that
  // takes inserts (the reason is `provider` otherwise) runs the message as a
  // new turn of the process the work runs in: the send key sends, asking
  // first only when the message needs a new process, and the same key with
  // Alt queues it until the work finishes. An edit asks first. Work that is
  // only scheduled work (loops, reminders) leaves nothing to queue behind, as
  // a loop can go on for days: the composer reads as idle, and a send that
  // needs a new process still asks (see useChatComposerState).
  const sendsBesideBackgroundWork = !isLoading
    && activity?.background === true
    && !holdsOnlyScheduledWork(activity)
    && insertUnavailableReason !== 'provider'
    && !isEditingSentMessage
    && Boolean(input.trim() || attachedFiles.length > 0);
  const sendKey = sendByCtrlEnter ? 'Ctrl+Enter' : 'Enter';
  const queueKey = sendByCtrlEnter ? 'Ctrl+Alt+Enter' : 'Alt+Enter';
  const submitHint = insertsByDefault
    ? hasQueuedDraft
      ? t('input.hintText.insertAppendQueued', {
          insertKey: sendKey,
          queueKey,
          defaultValue: '{{insertKey}} to insert • {{queueKey}} to add to the queued message',
        })
      : t('input.hintText.insert', {
          insertKey: sendKey,
          queueKey,
          defaultValue: '{{insertKey}} to insert • {{queueKey}} to queue',
        })
    : canQueueDraft
      ? hasQueuedDraft
        ? t('input.hintText.appendQueued', { defaultValue: 'Enter to add to the queued message' })
        : t('input.hintText.queue', { defaultValue: 'Enter to queue your next message' })
      : sendsBesideBackgroundWork
        ? t('input.hintText.sendBesideBackgroundWork', {
            sendKey,
            queueKey,
            defaultValue: '{{sendKey}} to send • {{queueKey}} to queue until background work finishes',
          })
        : sendByCtrlEnter
          ? t('input.hintText.ctrlEnter')
          : t('input.hintText.enter');
  const attachmentsUnsupportedLabel = t('input.attachmentsUnsupported', {
    provider: providerLabel,
    defaultValue: '{{provider}} does not support attachments yet',
  });
  const attachButtonLabel = attachmentsSupported ? t('input.attachFiles') : attachmentsUnsupportedLabel;
  const submitAriaLabel = insertsByDefault
    ? t('input.insert.send', { defaultValue: 'Insert message' })
    : canQueueDraft
      ? hasQueuedDraft
        ? t('input.queue.append', { defaultValue: 'Add to queued message' })
        : t('input.queue.sendNext', { defaultValue: 'Queue next message' })
      : isLoading
        ? t('input.stop')
        : t('input.send');
  // The send button splits in two while a turn runs and there is something
  // to send, or after it beside background work: the button does what Enter
  // does, the menu offers both.
  const showsBusySendMenu = (canQueueDraft || sendsBesideBackgroundWork) && Boolean(onSubmitBusyMode);

  return (
    <div className="chat-composer-shell relative flex-shrink-0 px-2 pb-2 pt-0 sm:px-4 sm:pb-4 md:px-4 md:pb-6">
      {/* Hidden rather than unmounted while a permission request takes this
          space, so a details panel the user opened is open again once the
          request is answered. */}
      <div className="pointer-events-none absolute bottom-full left-1/2 z-10 w-[calc(100%-1rem)] max-w-[54.25rem] -translate-x-1/2 translate-y-px bg-transparent sm:w-[calc(100%-2rem)]">
        <ActivityIndicator
          // A fresh tab for each session, its details panel collapsed: the
          // switch from one busy session to another passes no idle moment
          // that would collapse it.
          key={activitySessionId ?? undefined}
          activity={activity}
          progress={activityProgress}
          readDetails={readActivityDetails}
          transcriptRef={transcriptRef}
          isHidden={hasPendingPermissions}
          onAbort={onAbortSession}
          isInputFocused={isInputFocused}
        />
      </div>

      {pendingPermissionRequests.length > 0 && (
        <div className="mx-auto mb-3 max-w-[54.25rem]">
          <PermissionRequestsBanner
            pendingPermissionRequests={pendingPermissionRequests}
            handlePermissionDecision={handlePermissionDecision}
            handleGrantToolPermission={handleGrantToolPermission}
          />
        </div>
      )}

      <ScheduledMessageList
        scheduledMessages={scheduledMessages}
        onCancel={onCancelScheduledMessage}
        waitFor={(id) => dispatchWaits?.waitFor({ kind: 'scheduled', id }) ?? null}
        renderWait={(wait) => renderWait(wait, () => {
          if (wait.target.kind === 'scheduled') {
            onCancelScheduledMessage(wait.target.id);
          }
        })}
      />

      {isEditingSentMessage && (
        <div className="mx-auto mb-2 flex max-w-[54.25rem] items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground">
          <PencilIcon className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="min-w-0 flex-1">
            {t('composer.editing.title')}
            {' — '}
            <span className="text-muted-foreground">{t('composer.editing.filesNotReverted')}</span>
          </span>
          <button
            type="button"
            onClick={onCancelEditMessage}
            className="shrink-0 rounded-md px-2 py-1 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {t('composer.editing.cancel')}
          </button>
        </div>
      )}

      {refusedDropAt !== null && !attachmentsSupported && (
        <div
          role="alert"
          className="mx-auto mb-2 flex max-w-[54.25rem] items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
        >
          <PaperclipIcon className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          <span className="min-w-0 flex-1">{attachmentsUnsupportedLabel}</span>
        </div>
      )}

      <BackgroundSendDialog
        prompt={backgroundSendPrompt}
        onResolve={onResolveBackgroundSendPrompt}
      />

      {/* Above the queued message: inserts reach the model first. */}
      {pendingInserts.length > 0 && onWithdrawInsert && (
        <PendingInsertsCard
          inserts={pendingInserts}
          providerLabel={providerLabel}
          isAwaitingApproval={hasPendingPermissions}
          onWithdraw={onWithdrawInsert}
        />
      )}

      {queuedDraft && (
        <QueuedMessageCard
          content={queuedDraft.content}
          attachmentCount={
            queuedDraft.uploadedAttachments?.length ?? queuedDraft.attachments.length
          }
          onEdit={onEditQueuedDraft}
          onDelete={onDeleteQueuedDraft}
          waitNotice={queuedWait ? renderWait(queuedWait, onDeleteQueuedDraft) : undefined}
        />
      )}

      {!hasQuestionPanel && <div className="relative mx-auto max-w-[54.25rem]">
        {showFileDropdown && filteredFiles.length > 0 && (
          <div
            ref={fileDropdownRef}
            className="absolute bottom-full end-0 start-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-xl border border-border/50 bg-card/95 shadow-lg backdrop-blur-md"
          >
            {filteredFiles.map((file, index) => (
              <div
                key={file.path}
                ref={index === selectedFileIndex ? selectedFileRef : undefined}
                className={`cursor-pointer touch-manipulation border-b border-border/30 px-4 py-3 last:border-b-0 ${
                  index === selectedFileIndex
                    ? 'bg-primary/8 text-primary'
                    : 'text-foreground hover:bg-accent/50'
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectFile(file);
                }}
              >
                <div className="text-sm font-medium">{file.name}</div>
                <div className="font-mono text-xs text-muted-foreground">{file.path}</div>
              </div>
            ))}
          </div>
        )}

        <CommandMenu
          commands={filteredCommands}
          selectedIndex={selectedCommandIndex}
          onSelect={onCommandSelect}
          onClose={onCloseCommandMenu}
          position={commandMenuPosition}
          isOpen={isCommandMenuOpen}
          frequentCommands={frequentCommands}
        />

        <PromptInput
          onSubmit={onSubmit as (event: FormEvent<HTMLFormElement>) => void}
          status={isLoading ? 'streaming' : 'ready'}
          className={[
            isTextareaExpanded ? 'chat-input-expanded' : '',
            hasActivityIndicator ? 'rounded-t-none' : '',
          ].filter(Boolean).join(' ')}
          {...getRootProps(attachmentsSupported ? undefined : { onDrop: handleRefusedDrop })}
        >
          {isDragActive && attachmentsSupported && (
            <div className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-primary/15">
              <div className="rounded-xl border border-border/30 bg-card p-4 shadow-lg">
                <svg className="mx-auto mb-2 h-8 w-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                  />
                </svg>
                <p className="text-sm font-medium">{t('input.dropFiles')}</p>
              </div>
            </div>
          )}

          {attachedFiles.length > 0 && (
            <PromptInputHeader>
              <div className="rounded-xl bg-muted/40 p-2">
                <div className="flex flex-wrap gap-2">
                  {attachedFiles.map((file, index) => (
                    <ComposerAttachment
                      key={`${file.name}-${file.lastModified}-${index}`}
                      file={file}
                      onRemove={() => onRemoveAttachment(index)}
                      // Attached before switching to a provider that takes none:
                      // marked so they are removed rather than sent and refused.
                      error={attachmentsSupported ? fileErrors.get(file.name) : attachButtonLabel}
                    />
                  ))}
                </div>
              </div>
            </PromptInputHeader>
          )}

          <input {...getInputProps()} />

          <PromptInputBody>
            <div ref={inputHighlightRef} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl">
              {/* The highlights have to wrap exactly as the textarea's text does: dir="auto" like it, and the
                  unicode-bidi: plaintext browsers give a textarea[dir=auto], so each paragraph takes its own direction. */}
              <div dir="auto" className="chat-input-placeholder block w-full whitespace-pre-wrap break-words px-4 py-2 text-sm leading-6 text-transparent [unicode-bidi:plaintext]">
                {renderInputWithMentions(input)}
              </div>
            </div>

            <PromptInputTextarea
              ref={textareaRef}
              dir="auto"
              value={input}
              onChange={onInputChange}
              onClick={onTextareaClick}
              onKeyDown={onTextareaKeyDown}
              onPaste={onTextareaPaste}
              onScroll={(event) => onTextareaScrollSync(event.target as HTMLTextAreaElement)}
              onFocus={() => onInputFocusChange?.(true)}
              onBlur={() => onInputFocusChange?.(false)}
              onInput={onTextareaInput}
              placeholder={placeholder}
            />
        </PromptInputBody>

        <PromptInputFooter className="flex-wrap gap-y-1">
          <PromptInputTools className="min-w-0">
            <PromptInputButton
              tooltip={{ content: attachButtonLabel }}
              onClick={openAttachmentPicker}
              aria-label={attachButtonLabel}
              disabled={!attachmentsSupported}
            >
              <PaperclipIcon />
            </PromptInputButton>

            {onVoiceTranscript && voiceAvailable && (
              <VoiceInputButton state={voiceState} onToggle={voiceToggle} errorMsg={voiceError} />
            )}

            <TokenUsageSummary usage={tokenBudget} onClick={onShowTokenUsage} />

            <PromptInputButton
              tooltip={{ content: t('input.showAllCommands') }}
              onClick={onToggleCommandMenu}
              className="relative"
            >
              <MessageSquareIcon />
              {slashCommandsCount > 0 && (
                <span
                  className="absolute -end-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground"
                >
                  {slashCommandsCount}
                </span>
              )}
            </PromptInputButton>

            {hasInput && (
              <PromptInputButton
                tooltip={{ content: t('input.clearInput', { defaultValue: 'Clear input' }) }}
                onClick={onClearInput}
                className="hidden sm:flex"
              >
                <XIcon />
              </PromptInputButton>
            )}

          </PromptInputTools>

          <div className="ms-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
            <ScheduleMessagePopover
              disabled={!input.trim()}
              onSchedule={onScheduleMessage}
            />

            <ComposerModelMenu
              effort={effort}
              effortOptions={availableEffortOptions}
              onSelectEffort={onSelectEffort}
              model={model}
              modelOptions={availableModelOptions}
              onSelectModel={onSelectModel}
              modelsLoading={modelsLoading}
              ultracode={ultracode}
              onToggleUltracode={onToggleUltracode}
            />

            <ComposerPermissionMenu
              permissionMode={permissionMode}
              permissionModes={availablePermissionModes}
              onSelectPermissionMode={onSelectPermissionMode}
              providerLabel={providerLabel}
            />

            {/* One control in two halves while the menu shows, so no gap between them. */}
            <div className="flex shrink-0 items-center">
              <PromptInputSubmit
                onClick={
                  canQueueDraft
                    ? (e: MouseEvent<HTMLButtonElement>) => {
                        e.preventDefault();
                        onSubmit(e);
                      }
                    : isLoading
                      ? onAbortSession
                      : isRecording
                        ? (e: MouseEvent<HTMLButtonElement>) => {
                            e.preventDefault();
                            voiceStop({ send: true });
                          }
                        : undefined
                }
                disabled={
                  isLoading
                    ? false
                    : isRecording
                      ? false
                      : isTranscribing
                        ? true
                        : !input.trim() && attachedFiles.length === 0
                }
                aria-label={submitAriaLabel}
                title={submitAriaLabel}
                className={showsBusySendMenu ? 'h-10 w-10 rounded-e-none sm:h-10 sm:w-10' : 'h-10 w-10 sm:h-10 sm:w-10'}
              >
                {isTranscribing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : canQueueDraft ? (
                  <ArrowUpIcon className="h-4 w-4" />
                ) : undefined}
              </PromptInputSubmit>
              {showsBusySendMenu && onSubmitBusyMode && (
                <BusySendMenu
                  insertUnavailableReason={insertUnavailableReason}
                  providerLabel={providerLabel}
                  hasQueuedDraft={hasQueuedDraft}
                  sendByCtrlEnter={sendByCtrlEnter}
                  afterTurn={sendsBesideBackgroundWork}
                  onSelect={onSubmitBusyMode}
                />
              )}
            </div>
          </div>

          <div
            className={`order-last hidden basis-full px-2 text-center text-xs leading-4 text-muted-foreground/50 transition-opacity duration-200 lg:block ${
              input.trim() && !canQueueDraft && !sendsBesideBackgroundWork ? 'opacity-0' : 'opacity-100'
            }`}
          >
            {submitHint}
          </div>
        </PromptInputFooter>
      </PromptInput>
      </div>}
    </div>
  );
}
