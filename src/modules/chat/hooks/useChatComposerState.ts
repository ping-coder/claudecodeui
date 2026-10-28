import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  SetStateAction,
  TouchEvent,
} from 'react';
import { useDropzone } from 'react-dropzone';
import { useTranslation } from 'react-i18next';

import { api, ApiRequestError, readApiJson } from '@/shared/api';
import { PROVIDER_PERMISSION_PREFERENCE_KEYS } from '@/shared/constants';
import { readUserPreference } from '@/shared/userSettings';
import { buildModelRunOptions, describeBackgroundTask, ownBackgroundTasks } from '@/shared/utils';
import type { AddChatMessageOptions, BackgroundSendChoice, BackgroundSendPrompt, BackgroundTaskSummary, BusySubmitMode, CommandModalPayload, CostCommandData, HelpCommandData, InsertUnavailableReason, MarkSessionBackground, MarkSessionProcessing, ModelCommandData, OwnInsert, OwnInsertOutcome, QueuedDraft, SendRefusedEvent, SessionActivityMap, StatusCommandData,QueuedSendOptions,ChatAttachment,ChatMessage,PendingPermissionRequest,PermissionMode,SessionEstablishedContext,Project,ProjectSession,LLMProvider,SlashCommand } from '@/shared/types';
import { grantClaudeToolPermission } from '@/modules/chat/utils/chatPermissions';
import {
  appendQueuedMessage,
  clearQueuedMessage,
  hydrateChatDrafts,
  readDraftText,
  readQueuedMessage,
  subscribeToChatDrafts,
  writeDraftText,
} from '@/shared/chatDrafts';
import { escapeRegExp } from '@/modules/chat/utils/chatFormatting';
import { useFileMentions } from '@/modules/chat/hooks/useFileMentions';
import { useInputHistory } from '@/modules/chat/hooks/useInputHistory';
import { usePendingInserts } from '@/modules/chat/hooks/usePendingInserts';
import { useSlashCommands } from '@/modules/chat/hooks/useSlashCommands';

type UseChatComposerStateArgs = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  permissionMode: PermissionMode | string;
  cyclePermissionMode: () => void;
  resolvePermissionModeForProvider: (provider: LLMProvider, requestedMode: PermissionMode | string) => PermissionMode;
  /**
   * Model every send and command carries: the open session's model when there
   * is one, otherwise the user's per-provider selection.
   */
  currentProviderModel: string;
  currentProviderEffort: string;
  /**
   * Ultracode switch every send carries when the current model can run it.
   * NULL or absent means it cannot, and sends leave `ultracode` out entirely.
   */
  currentProviderUltracode?: boolean | null;
  /**
   * Whether the active provider accepts image attachments and other file
   * attachments. Absent means it does. A file of a kind the provider rejects is
   * never attached. The drop zone stays on either way, because it is what stops
   * the browser from opening a file dropped on the composer.
   */
  supportsImageAttachments?: boolean;
  supportsFileAttachments?: boolean;
  isLoading: boolean;
  processingSessions?: SessionActivityMap;
  canAbortSession: boolean;
  /**
   * Whether the provider's runtime takes a message in the middle of a turn
   * (`chat.insert`), from the capability matrix. Absent means it does not, and
   * a message sent while a turn runs is queued. Such a runtime (Claude) also
   * runs a message sent once the turn has ended, while background work still
   * runs, as a new turn of the process that work runs in, so sending then
   * does not stop the work. It asks first only when the server's hand-over
   * plan says the message needs a new process, and its sends carry
   * `keepBackgroundWork`, so the server refuses one rather than stop the work.
   */
  supportsMidRunInsert?: boolean;
  /**
   * Whether the chat socket is open. An insert sent over a closed one would be
   * dropped without a word, so none is offered then; absent means closed.
   */
  isConnected?: boolean;
  /**
   * Which of the given message ids the session's transcript holds once its
   * latest page is re-read: how an insert whose run ended unheard is found to
   * have landed. Absent finds nothing, so such an insert's text comes back.
   */
  findTranscriptMessages?: (sessionId: string, messageIds: string[]) => Promise<Set<string>>;
  tokenBudget: Record<string, unknown> | null;
  sendMessage: (message: unknown) => void;
  sendByCtrlEnter?: boolean;
  onSessionProcessing?: MarkSessionProcessing;
  /**
   * Invoked with the freshly allocated session id when the user sends the
   * first message of a brand-new conversation. The backend allocates the id
   * via POST /api/providers/sessions BEFORE the websocket send, so the id is
   * stable for the conversation's whole lifetime — the consumer navigates to
   * /session/:id and records it as the current session.
   */
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  scrollToBottom: () => void;
  addMessage: (msg: ChatMessage, options?: AddChatMessageOptions) => void;
  /**
   * Takes a row this composer added (by the `rowId` it gave `addMessage`) out
   * of a session's transcript: the echo of a send the server refused, or a
   * notice that turned out wrong. Absent leaves such rows where they are.
   */
  removeMessage?: (sessionId: string, rowId: string) => void;
  /**
   * Reports the background tasks a session is left with, which a refused send
   * puts the session back to after it was marked busy for that send.
   */
  onSessionBackground?: MarkSessionBackground;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
};

type MentionableFile = {
  name: string;
  path: string;
};

type CommandExecutionResult = {
  type: 'builtin' | 'custom';
  action?: string;
  data?: any;
  content?: string;
  hasBashCommands?: boolean;
  hasFileIncludes?: boolean;
};





type SubmitOptions = {
  /**
   * Send the text as a chat message even when it starts with "/" (or is
   * "help"). Set only for the re-submit of a custom command's expanded body:
   * like the Claude Code CLI, that body is never read as a command again, so a
   * body that opens with its own or another command's name cannot loop or
   * run that command instead of being sent.
   */
  skipCommandInterception?: boolean;
  /**
   * What a message submitted while a turn runs does. Absent inserts it when it
   * can go into the turn (resolveInsertUnavailableReason) and queues it
   * otherwise; `queue` always queues. Once the turn has ended with background
   * work still running, `queue` queues the message until the work finishes
   * where a send would not ask first. No effect while the session is idle.
   */
  busySubmitMode?: BusySubmitMode;
};

const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

/**
 * A message as a submit took it from the composer: the draft scope it was
 * typed in, its text and its browser files. The composer stays editable while
 * a submit waits (on an upload, a new chat's session or the hand-over plan),
 * so once the message has left, the composer may hold more, or show another
 * scope.
 */
type ComposerSubmission = {
  scope: string | null;
  text: string;
  files: File[];
};

/**
 * A composer text with a message that has left it taken off the front: what
 * was typed after the message, without the blank space before it. A text that
 * no longer opens with the message (the user rewrote it) is kept whole.
 */
const withoutSubmittedText = (current: string, submittedText: string): string => {
  const message = submittedText.trimEnd();
  return current.startsWith(message) ? current.slice(message.length).trimStart() : current;
};

/**
 * A composer text without the first paragraph that is exactly `text` (set
 * off by the text's ends or a blank line) and the blank line that set it
 * apart; null when no such paragraph is left. `text` found only inside a
 * longer paragraph does not count.
 */
const withoutParagraph = (current: string, text: string): string | null => {
  if (!text) {
    return null;
  }
  for (let at = current.indexOf(text); at >= 0; at = current.indexOf(text, at + 1)) {
    const end = at + text.length;
    const opens = at === 0 || (at >= 2 && current.startsWith('\n\n', at - 2));
    const closes = end === current.length || current.startsWith('\n\n', end);
    if (opens && closes) {
      return at === 0 ? current.slice(end).replace(/^\n\n/, '') : current.slice(0, at - 2) + current.slice(end);
    }
  }
  return null;
};

/**
 * Why a message cannot go into the running turn, or null when it can. The
 * provider must take messages mid-turn; the CLI never reads a slash command
 * mid-turn, and inserts carry text only for now; and the turn must be one
 * CloudCLI drives (a terminal CLI's cannot be written to) over an open
 * socket, while no sent message is being replaced.
 */
const resolveInsertUnavailableReason = ({
  supportsMidRunInsert,
  canAbortSession,
  isConnected,
  isEditing,
  content,
  hasAttachments,
}: {
  supportsMidRunInsert: boolean;
  canAbortSession: boolean;
  isConnected: boolean;
  isEditing: boolean;
  content: string;
  hasAttachments: boolean;
}): InsertUnavailableReason | null => {
  if (!supportsMidRunInsert) {
    return 'provider';
  }
  if (content.trimStart().startsWith('/')) {
    return 'slashCommand';
  }
  if (hasAttachments) {
    return 'attachments';
  }
  if (!canAbortSession || !isConnected || isEditing) {
    return 'unavailable';
  }
  return null;
};

/** The transcript lookup used when the caller gives none: it finds nothing. */
const findNoTranscriptMessages = async (): Promise<Set<string>> => new Set<string>();

/** The refusals an insert falls back from by sending or queueing its text; any other gives the text back. */
const INSERT_FALLBACK_REASONS = new Set(['NO_ACTIVE_RUN', 'UNSUPPORTED', 'SLASH_COMMAND']);

/** How many notices of inserts given back unanswered are kept, to take out should one turn out delivered. */
const UNANSWERED_NOTICES_KEPT = 20;

/** How long a send waits for the server's hand-over plan before it goes without one. */
const HAND_OVER_PLAN_TIMEOUT_MS = 5_000;

/**
 * The server's word on whether a send with given options would run in the
 * process the session holds open for its background work: `heldWork` (such a
 * process holds work), `canHandOver` (the send would go in) and `changes`
 * (what keeps it out otherwise; see BackgroundSendPrompt).
 */
type HandOverPlan = {
  heldWork: boolean;
  canHandOver: boolean;
  changes: string[];
};

/**
 * Asks the server for a send's hand-over plan (see HandOverPlan). Null when
 * it cannot tell: a server older than the route, a failed or slow request, or
 * an answer of another shape.
 */
const readHandOverPlan = async (sessionId: string, options: QueuedSendOptions): Promise<HandOverPlan | null> => {
  try {
    const response = await api.providers.handOverPlan(sessionId, options, {
      ...(typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(HAND_OVER_PLAN_TIMEOUT_MS) } : {}),
    });
    const { data } = await readApiJson<{ data?: Partial<Record<keyof HandOverPlan, unknown>> }>(response);
    if (!data || typeof data.heldWork !== 'boolean' || typeof data.canHandOver !== 'boolean') {
      return null;
    }
    return {
      heldWork: data.heldWork,
      canHandOver: data.canHandOver,
      changes: Array.isArray(data.changes)
        ? data.changes.filter((change): change is string => typeof change === 'string')
        : [],
    };
  } catch {
    return null;
  }
};

/**
 * A store row id for a row this composer adds and may take out again. Shaped
 * like the ones chat's session state makes: a user echo needs the `local_`
 * prefix for the history refresh to match it with the persisted turn.
 */
const createLocalRowId = (): string => `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/** A send made with keepBackgroundWork, as its composer may have to undo and resend it. */
type KeepWorkSend = {
  /** The mounted composer that made it. */
  owner: symbol;
  sessionId: string;
  content: string;
  uploadedAttachments: unknown[];
  /** The browser files it carried, given back with its text if the user cancels. */
  browserFiles: File[];
  options: QueuedSendOptions;
  /** The store row of its echo in the transcript. */
  echoRowId: string;
  /** The session's background tasks when it was sent, which the session goes back to. */
  tasks: BackgroundTaskSummary[];
};

/**
 * The `chat.send`s this page made with keepBackgroundWork, by the
 * `clientRequestId` each carried. A `send_refused` comes on the socket every
 * pane on the page shares and hands that id back, so only the composer that
 * made the send undoes it, and two panes sending to one session at once each
 * undo their own. A send the server started is never refused afterwards, so
 * its record is never acted on; it goes with its composer's next send to the
 * session, or with the composer.
 */
const keepWorkSends = new Map<string, KeepWorkSend>();

/**
 * The `clientRequestId` of the latest `chat.send` or edit this page made to
 * each session. A `send_refused` without an id, from a server older than ids
 * (after a rollback), is matched as it was before them: it undoes the
 * session's latest send, if that one was made with keepBackgroundWork.
 */
const latestSendIds = new Map<string, string>();

/**
 * A `clientRequestId` for a new send: unique on the page, which is all the
 * server's `send_refused` needs to name the send it answers.
 */
const createClientRequestId = (): string => `send_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

const isImageAttachment = (attachment: ChatAttachment) => {
  if (attachment.mimeType?.startsWith('image/')) return true;
  return /\.(gif|jpe?g|png|svg|webp)$/i.test(attachment.path || attachment.name || '');
};

const uploadAttachmentFiles = async (files: File[]): Promise<unknown[]> => {
  if (files.length === 0) {
    return [];
  }

  const formData = new FormData();
  files.forEach((file) => {
    formData.append('files', file);
  });

  const response = await api.assets.uploadFiles(formData);

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || 'Failed to upload files');
  }

  const result = await response.json();
  if (!Array.isArray(result.attachments) || result.attachments.length !== files.length) {
    throw new Error('File upload returned an incomplete result');
  }
  return result.attachments;
};


const restoreQueuedDraft = (sessionKey: string): QueuedDraft | null => {
  const saved = readQueuedMessage(sessionKey);
  return saved
    ? {
        content: saved.content,
        attachments: [],
        uploadedAttachments: saved.attachments ?? saved.images,
        options: saved.options,
      }
    : null;
};

// Whether the card already shows this stored queued message. Send options are
// not compared: the card does not show them.
const showsQueuedMessage = (card: QueuedDraft, stored: QueuedDraft): boolean => (
  card.content === stored.content
  && JSON.stringify(card.uploadedAttachments ?? []) === JSON.stringify(stored.uploadedAttachments ?? [])
);

// Whether a stored queued message is the card's message with more added after
// it (by this tab or another one), rather than a different message: only then
// do the card's browser files still belong to it. A card holds browser files
// only for attachments it uploaded, and every upload gets its own descriptor,
// so the stored message must start with the card's descriptors.
const extendsQueuedMessage = (card: QueuedDraft, stored: QueuedDraft): boolean => {
  const cardUploads = card.uploadedAttachments ?? [];
  const storedUploads = stored.uploadedAttachments ?? [];
  return JSON.stringify(storedUploads.slice(0, cardUploads.length)) === JSON.stringify(cardUploads);
};

const getNotificationSessionSummary = (
  selectedSession: ProjectSession | null,
  fallbackInput: string,
): string | null => {
  const sessionSummary = selectedSession?.summary || selectedSession?.name || selectedSession?.title;
  if (typeof sessionSummary === 'string' && sessionSummary.trim()) {
    const normalized = sessionSummary.replace(/\s+/g, ' ').trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }

  const normalizedFallback = fallbackInput.replace(/\s+/g, ' ').trim();
  if (!normalizedFallback) {
    return null;
  }

  return normalizedFallback.length > 80 ? `${normalizedFallback.slice(0, 77)}...` : normalizedFallback;
};

/**
 * Enter that CONFIRMS an IME candidate must not also submit.
 *
 * `event.isComposing` alone is not enough: Safari fires `compositionend` BEFORE the confirming
 * Enter's `keydown`, so the flag is already `false` by the time the handler runs. Chrome and
 * Firefox fire it after, which is why the naive guard looks correct on those two and the bug
 * reads as Safari-only. A tight window after `compositionend` covers it — that sequence is
 * synchronous (microseconds), while a human pressing Enter a second time takes >= 100ms and
 * never lands inside it.
 */
const SAFARI_IME_RACE_WINDOW_MS = 30;

export function useChatComposerState({
  selectedProject,
  selectedSession,
  currentSessionId,
  provider,
  permissionMode,
  cyclePermissionMode,
  resolvePermissionModeForProvider,
  currentProviderModel,
  currentProviderEffort,
  currentProviderUltracode,
  supportsImageAttachments = true,
  supportsFileAttachments = true,
  isLoading,
  processingSessions,
  canAbortSession,
  supportsMidRunInsert = false,
  isConnected = false,
  findTranscriptMessages = findNoTranscriptMessages,
  tokenBudget,
  sendMessage,
  sendByCtrlEnter,
  onSessionProcessing,
  onSessionEstablished,
  onFileOpen,
  onShowSettings,
  scrollToBottom,
  addMessage,
  removeMessage,
  onSessionBackground,
  setIsUserScrolledUp,
  setPendingPermissionRequests,
}: UseChatComposerStateArgs) {
  const { t } = useTranslation('chat');
  // The composer text together with the chat scope it belongs to. They are one
  // state rather than a value plus a ref because they have to move in lockstep:
  // on a session switch there is one commit where the scope has already changed
  // while the text has not, and anything that persisted the text in that commit
  // would write the previous session's message into the new session's draft.
  // A ref cannot express this — React evaluates a state updater eagerly, so a
  // ref set inside one is already ahead by the time the effects run.
  //
  // Restored synchronously from the draft mirror so a reload shows what was
  // being typed on the first paint rather than after the drafts request lands.
  /**
   * The already-sent message the composer is currently replacing, or null.
   *
   * Holds the anchor rather than the message, because that is all the send
   * needs and it keeps a stale message object from being captured while the
   * transcript refreshes underneath the composer.
   */
  const [editingAnchorId, setEditingAnchorId] = useState<string | null>(null);

  const [inputState, setInputState] = useState<{ scope: string | null; value: string }>(() => {
    if (typeof window === 'undefined') {
      return { scope: null, value: '' };
    }
    const initialScope = selectedSession?.id || currentSessionId
      || (selectedProject ? `project:${selectedProject.projectId}` : null);
    return {
      scope: initialScope,
      value: initialScope ? readDraftText(initialScope) : '',
    };
  });
  const input = inputState.value;
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [fileErrors, setFileErrors] = useState<Map<string, string>>(new Map());
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  const [commandModalPayload, setCommandModalPayload] = useState<CommandModalPayload | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const textareaLineHeightRef = useRef<number | null>(null);
  const lastAutosizedInputRef = useRef<string | null>(null);
  const handleSubmitRef = useRef<
    ((
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: QueuedDraft,
      submitOptions?: SubmitOptions,
    ) => Promise<void>) | null
  >(null);
  const inputValueRef = useRef(input);
  // The draft text this composer last agreed with for its scope: the text it
  // last wrote there or followed from there. A draft that reads otherwise was
  // written by another composer on the scope, the other pane of a split on
  // the same session (see restoreDraft).
  const syncedDraftRef = useRef({ scope: inputState.scope, text: inputState.value });
  const selectedProjectId = selectedProject?.projectId;
  // Prefer the stable backend-allocated id (selectedSession.id) but fall back
  // to currentSessionId for a just-established session that hasn't been
  // handed back to the parent's `selectedSession` prop yet.
  const sessionKey = selectedSession?.id || currentSessionId || null;
  // The chat scope a draft belongs to: the open session, or the project for a
  // chat that has not been sent yet and so has no session id. Drafts used to be
  // keyed by project alone, so every session in a project shared one draft.
  const draftScope = sessionKey ?? (selectedProjectId ? `project:${selectedProjectId}` : null);
  const draftScopeRef = useRef(draftScope);
  draftScopeRef.current = draftScope;
  // Composition is tracked on `window` in the capture phase rather than on the textarea, so a
  // composition that starts in one field and ends after focus moves still closes cleanly.
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);

  useEffect(() => {
    const onStart = () => {
      isComposingRef.current = true;
    };
    const onEnd = () => {
      isComposingRef.current = false;
      lastCompositionEndAtRef.current = performance.now();
    };
    // `blur` does not bubble, but a capture-phase listener on `window` still sees it on the way
    // down — otherwise a composition abandoned by clicking away would stay open forever.
    const onBlur = () => {
      isComposingRef.current = false;
    };
    window.addEventListener('compositionstart', onStart, true);
    window.addEventListener('compositionend', onEnd, true);
    window.addEventListener('blur', onBlur, true);
    return () => {
      window.removeEventListener('compositionstart', onStart, true);
      window.removeEventListener('compositionend', onEnd, true);
      window.removeEventListener('blur', onBlur, true);
    };
  }, []);

  const setInput = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    setInputState((previous) => ({
      scope: draftScopeRef.current,
      value: typeof next === 'function' ? next(previous.value) : next,
    }));
  }, []);
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;
  // Read when a refused insert falls back, which happens on a server frame
  // rather than in a render: whether a turn is still in flight then.
  const isLoadingRef = useRef(isLoading);
  useEffect(() => {
    isLoadingRef.current = isLoading;
  }, [isLoading]);
  // Per session, the own inserts whose text was given back and the block of
  // text they form at the start of its composer or draft. Texts this composer
  // gives back in a burst (a stop takes back every pending insert) go there in
  // the order they were sent, whatever order their frames come in; the other
  // pane of a split on the session keeps its own block, so between the two
  // the order is the order their frames came in.
  const restoredInsertsRef = useRef(new Map<string, { inserts: OwnInsert[]; text: string }>());
  // The transcript notice that an own insert went back unanswered, by insert
  // id, with the session it was written to: taken out again should the insert
  // turn out to have been delivered.
  const unansweredNoticesRef = useRef(new Map<string, { sessionId: string; rowId: string }>());
  // This composer's mark on the sends it made with keepBackgroundWork (see
  // keepWorkSends), made once per mount.
  const [composerToken] = useState(() => Symbol('chat-composer'));

  // Recall writes go through the same pair of stores a send reads: the state
  // (for the render) and inputValueRef (so an immediate Enter submits the
  // recalled text, not a stale value).
  const setInputFromHistory = useCallback((value: string) => {
    setInput(value);
    inputValueRef.current = value;
  }, [setInput]);
  const { recordSentMessage, handleHistoryKeyDown } = useInputHistory({
    setInput: setInputFromHistory,
    textareaRef,
    scope: draftScope,
  });

  const [queuedDraft, setQueuedDraft] = useState<QueuedDraft | null>(() => {
    if (typeof window === 'undefined' || !sessionKey) {
      return null;
    }
    return restoreQueuedDraft(sessionKey);
  });
  // Which session the in-memory `queuedDraft` belongs to, so editing or
  // deleting the card clears that session's queued message. On a session
  // switch there is one commit where `sessionKey` already points at the new
  // session while `queuedDraft` still holds the old session's draft.
  const queuedDraftSessionRef = useRef<string | null>(sessionKey);

  const handleBuiltInCommand = useCallback(
    (result: CommandExecutionResult) => {
      const { action, data } = result;
      switch (action) {
        case 'help':
          setCommandModalPayload({
            kind: 'help',
            data: (data || {}) as HelpCommandData,
          });
          break;

        case 'models':
          setCommandModalPayload({
            kind: 'models',
            data: (data || {}) as ModelCommandData,
          });
          break;

        case 'cost': {
          setCommandModalPayload({
            kind: 'cost',
            data: (data || {}) as CostCommandData,
          });
          break;
        }

        case 'status': {
          setCommandModalPayload({
            kind: 'status',
            data: (data || {}) as StatusCommandData,
          });
          break;
        }

        case 'memory':
          if (data.error) {
            addMessage({
              type: 'assistant',
              content: `Warning: ${data.message}`,
              timestamp: Date.now(),
            });
          } else {
            addMessage({
              type: 'assistant',
              content: `${data.message}\n\nPath: \`${data.path}\``,
              timestamp: Date.now(),
            });
            if (data.exists && onFileOpen) {
              onFileOpen(data.path);
            }
          }
          break;

        case 'config':
          onShowSettings?.();
          break;

        default:
          console.warn('Unknown built-in command action:', action);
      }
    },
    [onFileOpen, onShowSettings, addMessage],
  );

  const closeCommandModal = useCallback(() => {
    setCommandModalPayload(null);
  }, []);

  const handleCustomCommand = useCallback(async (result: CommandExecutionResult) => {
    const { content, hasBashCommands } = result;

    if (hasBashCommands) {
      const confirmed = window.confirm(
        'This command contains bash commands that will be executed. Do you want to proceed?',
      );
      if (!confirmed) {
        addMessage({
          type: 'assistant',
          content: 'Command execution cancelled',
          timestamp: Date.now(),
        });
        return;
      }
    }

    const commandContent = content || '';
    setInput(commandContent);
    inputValueRef.current = commandContent;

    // Defer submit to next tick so the command text is reflected in UI before dispatching.
    // The expanded body is the message itself: it skips slash-command interception.
    setTimeout(() => {
      if (handleSubmitRef.current) {
        handleSubmitRef.current(createFakeSubmitEvent(), undefined, { skipCommandInterception: true });
      }
    }, 0);
  }, [addMessage]);

  const executeCommand = useCallback(
    async (command: SlashCommand, rawInput?: string, options?: { preserveInput?: boolean }) => {
      if (!command || !selectedProject) {
        return;
      }

      try {
        const effectiveInput = rawInput ?? input;
        // Everything typed after the command name is its argument text, line
        // breaks included (`[\s\S]`, unlike `.`), trimmed as the Claude Code CLI
        // does. `$ARGUMENTS` gets it verbatim; `$1`, `$2`, … get its tokens.
        // The name must open the input and end at whitespace or the end: a pick
        // from the slash menu passes the whole composer, where the name may
        // appear later or inside a longer word ("see /echo2 …" has no arguments).
        const commandMatch = effectiveInput
          .trimStart()
          .match(new RegExp(`^${escapeRegExp(command.name)}(?=\\s|$)([\\s\\S]*)`));
        const rawArgs = commandMatch ? commandMatch[1].trim() : '';
        const args = rawArgs ? rawArgs.split(/\s+/) : [];

        // The `/api/commands/execute` context sends `projectId` now instead of
        // a folder-derived project name; the path is still included verbatim.
        const context = {
          projectPath: selectedProject.fullPath || selectedProject.path,
          projectId: selectedProject.projectId,
          sessionId: currentSessionId || selectedSession?.id || null,
          provider,
          model: currentProviderModel,
          tokenUsage: tokenBudget,
        };

        const response = await api.commands.execute({
          commandName: command.name,
          commandPath: command.path,
          args,
          rawArgs,
          context,
        });

        if (!response.ok) {
          let errorMessage = `Failed to execute command (${response.status})`;
          try {
            const errorData = await response.json();
            errorMessage = errorData?.message || errorData?.error || errorMessage;
          } catch {
            // Ignore JSON parse failures and use fallback message.
          }
          throw new Error(errorMessage);
        }

        const result = (await response.json()) as CommandExecutionResult;
        if (result.type === 'builtin') {
          handleBuiltInCommand(result);
          if (!options?.preserveInput) {
            setInput('');
            inputValueRef.current = '';
          }
        } else if (result.type === 'custom') {
          await handleCustomCommand(result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error executing command:', error);
        addMessage({
          type: 'assistant',
          content: `Error executing command: ${message}`,
          timestamp: Date.now(),
        });
      }
    },
    [
      currentProviderModel,
      currentSessionId,
      handleBuiltInCommand,
      handleCustomCommand,
      input,
      provider,
      selectedProject,
      selectedSession?.id,
      addMessage,
      tokenBudget,
    ],
  );

  const showCostModal = useCallback(() => {
    executeCommand(
      {
        name: '/cost',
        description: 'Display token usage information',
        namespace: 'builtin',
        metadata: { type: 'builtin' },
      } as SlashCommand,
      '/cost',
      { preserveInput: true },
    );
  }, [executeCommand]);

  const {
    slashCommands,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  } = useSlashCommands({
    selectedProject,
    provider,
    input,
    setInput,
    textareaRef,
    onExecuteCommand: executeCommand,
  });

  const {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  } = useFileMentions({
    selectedProject,
    input,
    setInput,
    textareaRef,
  });

  // Takes a submitted message out of the composer once it has left: sent,
  // queued or inserted. Only what the submit took goes (see
  // ComposerSubmission): its browser files, and its text from the scope it
  // was typed in, while it still opens that scope's text, keeping whatever
  // was typed after it. Once the composer shows another scope, the text comes
  // out of its scope's draft, so going back does not offer it to be sent
  // again, and the scope now open is left alone.
  const takeSubmissionOutOfComposer = useCallback(({ scope, text, files }: ComposerSubmission) => {
    if (files.length > 0) {
      setAttachedFiles((attached) => attached.filter((file) => !files.includes(file)));
    }
    const showsScope = draftScopeRef.current === scope;
    if (showsScope) {
      setFileErrors(new Map());
    }
    const current = showsScope ? inputValueRef.current : scope ? readDraftText(scope) : '';
    const remaining = withoutSubmittedText(current, text);
    if (remaining === current) {
      return;
    }
    if (showsScope) {
      setInput(remaining);
      inputValueRef.current = remaining;
      resetCommandMenuState();
      setIsTextareaExpanded(false);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }
    if (scope) {
      writeDraftText(scope, remaining);
      restoredInsertsRef.current.delete(scope);
    }
  }, [resetCommandMenuState, setInput]);

  const syncInputOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!inputHighlightRef.current || !target) {
      return;
    }
    inputHighlightRef.current.scrollTop = target.scrollTop;
    inputHighlightRef.current.scrollLeft = target.scrollLeft;
  }, []);

  const resizeTextarea = useCallback((target: HTMLTextAreaElement) => {
    target.style.height = 'auto';
    const nextHeight = Math.max(22, target.scrollHeight);
    target.style.height = `${nextHeight}px`;

    let lineHeight = textareaLineHeightRef.current;
    if (!lineHeight) {
      lineHeight = parseInt(window.getComputedStyle(target).lineHeight);
      textareaLineHeightRef.current = Number.isFinite(lineHeight) ? lineHeight : 24;
    }

    const expanded = nextHeight > (textareaLineHeightRef.current || 24) * 2;
    setIsTextareaExpanded((previous) => previous === expanded ? previous : expanded);
    lastAutosizedInputRef.current = target.value;
  }, []);

  const handleAttachmentFiles = useCallback((files: File[]) => {
    const validFiles = files.filter((file) => {
      try {
        if (!file || typeof file !== 'object') {
          console.warn('Invalid file object:', file);
          return false;
        }

        // Sending it would only fail the turn: the provider's runtime rejects
        // attachments of a kind it cannot take.
        const isSupportedKind = file.type.startsWith('image/')
          ? supportsImageAttachments
          : supportsFileAttachments;
        if (!isSupportedKind) {
          return false;
        }

        if (file.size > MAX_ATTACHMENT_SIZE) {
          const fileName = file.name || 'Unknown file';
          setFileErrors((previous) => {
            const next = new Map(previous);
            next.set(fileName, 'File too large (max 10MB)');
            return next;
          });
          return false;
        }

        return true;
      } catch (error) {
        console.error('Error validating file:', error, file);
        return false;
      }
    });

    if (validFiles.length > 0) {
      setAttachedFiles((previous) => [...previous, ...validFiles].slice(0, MAX_ATTACHMENT_COUNT));
    }
  }, [supportsFileAttachments, supportsImageAttachments]);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);

      items.forEach((item) => {
        if (!item.type.startsWith('image/')) {
          return;
        }
        const file = item.getAsFile();
        if (file) {
          handleAttachmentFiles([file]);
        }
      });

      if (items.length === 0 && event.clipboardData.files.length > 0) {
        const files = Array.from(event.clipboardData.files);
        const imageFiles = files.filter((file) => file.type.startsWith('image/'));
        if (imageFiles.length > 0) {
          handleAttachmentFiles(imageFiles);
        }
      }
    },
    [handleAttachmentFiles],
  );

  // Never `disabled`, even for a provider that takes no attachments. Disabled,
  // the dropzone removes the composer's drop handler, yet its document listener
  // still leaves drops inside the composer to that handler. Nothing cancels
  // them, so the browser opens the dropped file (Firefox and Safari replace the
  // app with it). Enabled, it cancels the drop, and handleAttachmentFiles
  // refuses the files the provider cannot take.
  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    maxSize: MAX_ATTACHMENT_SIZE,
    maxFiles: MAX_ATTACHMENT_COUNT,
    onDrop: handleAttachmentFiles,
    noClick: true,
    noKeyboard: true,
  });

  // Snapshot of everything `chat.send` needs beyond the text itself. Built at
  // send time for immediate sends and at queue time for queued ones, so a
  // queued message keeps the provider settings it was composed under even if
  // it is later dispatched outside this composer (app-level auto-send).
  const buildSendOptions = useCallback((currentInput: string): QueuedSendOptions => {
    const getToolsSettings = () => readUserPreference(
      PROVIDER_PERMISSION_PREFERENCE_KEYS[provider],
      {
        allowedTools: [],
        disallowedTools: [],
        skipPermissions: false,
      },
    );

    const toolsSettings = getToolsSettings();

    return {
      ...buildModelRunOptions({
        model: currentProviderModel,
        effort: currentProviderEffort,
        ultracode: currentProviderUltracode,
      }),
      permissionMode: resolvePermissionModeForProvider(provider, permissionMode),
      toolsSettings,
      skipPermissions: toolsSettings?.skipPermissions || false,
      sessionSummary: getNotificationSessionSummary(selectedSession, currentInput),
    };
  }, [
    currentProviderEffort,
    currentProviderModel,
    currentProviderUltracode,
    permissionMode,
    provider,
    resolvePermissionModeForProvider,
    selectedSession,
  ]);

  // Read at send time through a ref: the map changes on every poll, and a
  // submit handler rebuilt that often would re-render the whole composer.
  const processingSessionsRef = useRef(processingSessions);
  useEffect(() => {
    processingSessionsRef.current = processingSessions;
  }, [processingSessions]);

  // Sending over background work asks first when the send would stop it. The
  // dialog is rendered by the composer; the submit awaits the user's choice
  // through this resolver.
  const [backgroundSendPrompt, setBackgroundSendPrompt] = useState<BackgroundSendPrompt | null>(null);
  const backgroundSendResolverRef = useRef<((choice: BackgroundSendChoice) => void) | null>(null);

  const askBeforeSendingOverBackgroundWork = useCallback(
    (prompt: BackgroundSendPrompt) => new Promise<BackgroundSendChoice>((resolve) => {
      // Only one prompt at a time: a stale one is answered "cancel".
      backgroundSendResolverRef.current?.('cancel');
      backgroundSendResolverRef.current = resolve;
      setBackgroundSendPrompt(prompt);
    }),
    [],
  );

  const resolveBackgroundSendPrompt = useCallback((choice: BackgroundSendChoice) => {
    const resolve = backgroundSendResolverRef.current;
    backgroundSendResolverRef.current = null;
    setBackgroundSendPrompt(null);
    resolve?.(choice);
  }, []);

  // An unmounted composer cannot answer; let the pending submit finish.
  useEffect(() => () => {
    backgroundSendResolverRef.current?.('cancel');
    backgroundSendResolverRef.current = null;
  }, []);

  // What a send to a session whose turn has ended does while its background
  // work runs: `send` (with keepBackgroundWork when the work is to keep
  // running), `queue` behind the work, or `cancel`. A provider whose runtime
  // runs the turn in the process the work runs in asks the server first. When
  // the turn can go there, or the server cannot say, it is sent with
  // keepBackgroundWork, so the server refuses it rather than stop the work;
  // when it cannot, the user is asked, told what only a new process can
  // apply. Elsewhere, and for an edit, every new turn replaces that process,
  // so the user is asked. Only while the composer shows the session, though:
  // once it shows another, the answer is `cancel`, unasked, and the caller
  // leaves the message in the session's draft.
  const decideSendOverBackgroundWork = useCallback(async (
    sessionId: string,
    options: QueuedSendOptions,
    isEdit: boolean,
  ): Promise<{ choice: BackgroundSendChoice; keepBackgroundWork: boolean }> => {
    const work = ownBackgroundTasks(processingSessionsRef.current?.get(sessionId)?.tasks ?? [])
      .map((task) => describeBackgroundTask(task, t));
    let prompt: BackgroundSendPrompt = { work };
    if (supportsMidRunInsert && !isEdit) {
      const plan = await readHandOverPlan(sessionId, options);
      if (!plan || !plan.heldWork || plan.canHandOver) {
        return { choice: 'send', keepBackgroundWork: true };
      }
      prompt = { work, changes: plan.changes };
    }
    // The plan, or the upload a submit waits on before it, can come back
    // after the user has opened another session. A prompt there would ask
    // about work and a message that session does not have, and send anyway
    // would send the message to a session the user is not looking at.
    if (sessionKeyRef.current !== sessionId) {
      return { choice: 'cancel', keepBackgroundWork: false };
    }
    return { choice: await askBeforeSendingOverBackgroundWork(prompt), keepBackgroundWork: false };
  }, [askBeforeSendingOverBackgroundWork, supportsMidRunInsert, t]);

  // Persist a message to send "when this finishes" and show it as the queued
  // card. Used while a turn is in flight and when the user chooses to queue
  // behind background work. Attachments must already be uploaded.
  //
  // A session has one queued turn. A message queued while another is still
  // waiting is added after it rather than replacing it, so a burst of
  // follow-ups all reach the provider, in order, as that turn. The server
  // does the append against what it has stored, and the card shows what it
  // returns: exactly what will be sent.
  //
  // A message submitted from the composer (`submission`) comes out of it when
  // the message is taken, as for a direct send, not when the server answers:
  // what the user types during that round trip is the next follow-up and
  // must not be erased with this one. If the server refuses the message, it
  // goes back into the composer, in front of anything typed since, and the
  // composer says so, rather than showing a card nothing will send.
  //
  // Without `submission` it queues a message that already left the composer
  // (an insert or a send the server refused), so nothing in the composer is
  // taken out: it was emptied when the message was taken, and what it holds
  // now came after.
  const queueMessage = useCallback(
    async (
      durableDraft: QueuedDraft,
      queuedSessionKey: string | null,
      { submission }: { submission?: ComposerSubmission } = {},
    ) => {
      if (submission) {
        takeSubmissionOutOfComposer(submission);
      }

      let queuedCard = durableDraft;
      let appendedToEarlierMessage = false;
      if (queuedSessionKey) {
        try {
          const { queuedMessage, appended } = await appendQueuedMessage(queuedSessionKey, {
            content: durableDraft.content,
            options: durableDraft.options,
            attachments: durableDraft.uploadedAttachments,
          });
          appendedToEarlierMessage = appended;
          queuedCard = {
            content: queuedMessage.content,
            attachments: durableDraft.attachments,
            uploadedAttachments: queuedMessage.attachments,
            options: queuedMessage.options,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Failed to queue message:', error);
          addMessage({
            type: 'error',
            // A slash command is refused by design, and the reason is said in
            // the user's language; any other failure shows the server's text.
            content: error instanceof ApiRequestError && error.code === 'QUEUED_MESSAGE_NOT_COMBINABLE'
              ? t('input.queue.notCombinable')
              : `Failed to queue message: ${message}`,
            timestamp: new Date(),
          });
          const withTypedSince = (typedSince: string) => (
            [durableDraft.content, typedSince].filter((part) => part.trim()).join('\n\n')
          );
          if (sessionKeyRef.current === queuedSessionKey) {
            const restored = withTypedSince(inputValueRef.current);
            setInput(restored);
            inputValueRef.current = restored;
            if (submission) {
              setAttachedFiles((current) => [...submission.files, ...current]);
            }
            if (draftScopeRef.current) {
              writeDraftText(draftScopeRef.current, restored);
            }
          } else {
            // Browser files cannot follow it into a composer that is not open.
            writeDraftText(queuedSessionKey, withTypedSince(readDraftText(queuedSessionKey)));
          }
          return;
        }
      }

      // Recorded under the session the message was queued FOR, and before
      // the session-switch return below — the queued text must be
      // recallable even when it dispatches without this composer.
      recordSentMessage(durableDraft.content, queuedSessionKey);

      // The server owns dispatch after persistence. If the user changed
      // sessions meanwhile, the durable record is already enough; do not
      // attach its UI card to the newly opened composer.
      if (queuedSessionKey && sessionKeyRef.current !== queuedSessionKey) {
        return;
      }

      queuedDraftSessionRef.current = queuedSessionKey;
      // The browser files of the messages queued before this one stay with
      // the card, so editing it brings all of them back into the composer;
      // not when the earlier one was already sent and this one queued alone.
      setQueuedDraft((previous) => ({
        ...queuedCard,
        attachments: appendedToEarlierMessage && previous && extendsQueuedMessage(previous, queuedCard)
          ? [...previous.attachments, ...queuedCard.attachments]
          : queuedCard.attachments,
      }));
    },
    [addMessage, recordSentMessage, setInput, t, takeSubmissionOutOfComposer],
  );

  // Starts a turn: the message's echo in the transcript, the session marked
  // busy, and the frame that sends it. Shared by a submit, by the normal send
  // an insert falls back to when its run ended before it got there, and by the
  // send the user confirms after the server refused one.
  const startTurn = useCallback((turn: {
    sessionId: string;
    content: string;
    uploadedAttachments: unknown[];
    options: QueuedSendOptions;
    /** The already-sent message this one replaces, or null for a new turn. */
    anchorId: string | null;
    /**
     * Asks the server to keep the session's background work: a turn that
     * cannot run in the process the work runs in is refused (`send_refused`,
     * see handleSendRefused) rather than started in a new process, which
     * would stop the work. A plain `chat.send` only.
     */
    keepBackgroundWork: boolean;
    /** The browser files behind `uploadedAttachments`, given back with the text if a refusal is cancelled. */
    browserFiles?: File[];
  }) => {
    const attachmentRecords = turn.uploadedAttachments as ChatAttachment[];
    const userMessage: ChatMessage = {
      type: 'user',
      content: turn.content,
      images: attachmentRecords.filter(isImageAttachment),
      files: attachmentRecords.filter((attachment) => !isImageAttachment(attachment)),
      timestamp: new Date(),
      // Tags this echo as the replacement, so the truncation the server
      // broadcasts a moment later cuts the turns being replaced without
      // taking the message the user just sent with them.
      ...(turn.anchorId ? { replacesAnchorId: turn.anchorId } : {}),
    };

    const echoRowId = createLocalRowId();
    addMessage(userMessage, { rowId: echoRowId });
    const keepBackgroundWork = turn.keepBackgroundWork && !turn.anchorId;
    const clientRequestId = createClientRequestId();
    // This composer's earlier send to the session has had its answer: a
    // composer submits once at a time, and its send marks the session busy.
    for (const [requestId, send] of keepWorkSends) {
      if (send.owner === composerToken && send.sessionId === turn.sessionId) {
        keepWorkSends.delete(requestId);
      }
    }
    latestSendIds.set(turn.sessionId, clientRequestId);
    if (keepBackgroundWork) {
      keepWorkSends.set(clientRequestId, {
        owner: composerToken,
        sessionId: turn.sessionId,
        content: turn.content,
        uploadedAttachments: turn.uploadedAttachments,
        browserFiles: turn.browserFiles ?? [],
        options: turn.options,
        echoRowId,
        tasks: processingSessionsRef.current?.get(turn.sessionId)?.tasks ?? [],
      });
    }
    // Mark this request as processing in the per-session activity map (the
    // single source of truth the indicator derives from). The id is always
    // concrete at this point — no pending placeholder exists anymore.
    onSessionProcessing?.(turn.sessionId, {
      statusText: null,
      canInterrupt: true,
    });

    setIsUserScrolledUp(false);
    setTimeout(() => scrollToBottom(), 100);

    // One message shape for every provider. The backend resolves the
    // provider, project path, and provider-native resume id from the
    // session row; `options` only carries composer-level preferences.
    sendMessage({
      // Replacing an already-sent message is its own frame: it changes the
      // shape of the conversation, so it gets validated separately and can
      // report why it was refused.
      type: turn.anchorId ? 'chat.edit-send' : 'chat.send',
      sessionId: turn.sessionId,
      // A plain send names itself, so a refusal can say which one it answers.
      ...(turn.anchorId ? { anchorId: turn.anchorId } : { clientRequestId }),
      content: turn.content,
      options: {
        ...turn.options,
        attachments: turn.uploadedAttachments,
        ...(keepBackgroundWork ? { keepBackgroundWork: true } : {}),
      },
    });
  }, [addMessage, composerToken, onSessionProcessing, scrollToBottom, sendMessage, setIsUserScrolledUp]);

  // A session's composer text: this composer's when it shows the session
  // (inputValueRef, which restoreDraft keeps up with the other pane of a
  // split), else the session's draft.
  const readSessionText = useCallback((sessionId: string): string => (
    sessionKeyRef.current === sessionId ? inputValueRef.current : readDraftText(sessionId)
  ), []);

  // Writes a session's composer text: into the composer and its draft when it
  // shows the session, else into that session's draft.
  const writeSessionText = useCallback((sessionId: string, text: string) => {
    if (sessionKeyRef.current === sessionId) {
      setInput(text);
      inputValueRef.current = text;
      if (draftScopeRef.current) {
        writeDraftText(draftScopeRef.current, text);
      }
      return;
    }
    writeDraftText(sessionId, text);
  }, [setInput]);

  // Puts a message that did not go back into its composer, ahead of anything
  // typed since, with its browser files; or, once the composer shows another
  // session, into that session's draft, where browser files cannot follow.
  const putTextBack = useCallback((sessionId: string, text: string, browserFiles: File[] = []) => {
    const current = readSessionText(sessionId);
    writeSessionText(sessionId, current.trim() ? `${text}\n\n${current}` : text);
    if (browserFiles.length > 0 && sessionKeyRef.current === sessionId) {
      setAttachedFiles((attached) => [...browserFiles, ...attached]);
    }
  }, [readSessionText, writeSessionText]);

  // Takes a message putTextBack gave back out again, as it is sent or queued
  // after all: its text while it is still a paragraph of its own in the
  // composer (or the session's draft), keeping the rest, and its browser
  // files. Not only at the top: two panes on one session can both have a
  // refused send put back, the later one ahead of the earlier, and the user
  // may answer the earlier one's dialog first.
  const takeTextBack = useCallback((sessionId: string, text: string, browserFiles: File[] = []) => {
    const remaining = withoutParagraph(readSessionText(sessionId), text);
    if (remaining !== null) {
      writeSessionText(sessionId, remaining);
    }
    if (browserFiles.length > 0 && sessionKeyRef.current === sessionId) {
      setAttachedFiles((attached) => attached.filter((file) => !browserFiles.includes(file)));
    }
  }, [readSessionText, writeSessionText]);

  // Gives an own insert's text back: into the composer when it shows the
  // insert's session, else into that session's draft, ahead of anything typed
  // since. Texts given back in a burst line up in the order they were sent.
  const restoreInsertText = useCallback((insert: OwnInsert) => {
    const current = readSessionText(insert.sessionId);
    const block = restoredInsertsRef.current.get(insert.sessionId);
    // Still the block given back before, possibly with typing after it.
    const continuesBlock = Boolean(block && (current === block.text || current.startsWith(`${block.text}\n\n`)));
    const inserts = [...(continuesBlock && block ? block.inserts : []), insert]
      .sort((first, second) => first.sentAt - second.sentAt);
    const text = inserts.map((restored) => restored.content).join('\n\n');
    const typedSince = continuesBlock && block
      ? current.slice(block.text.length)
      : current.trim() ? `\n\n${current}` : '';
    restoredInsertsRef.current.set(insert.sessionId, { inserts, text });
    writeSessionText(insert.sessionId, `${text}${typedSince}`);
  }, [readSessionText, writeSessionText]);

  // Takes an own insert's text back out of the block restoreInsertText gave
  // back, as it reached the model after all: only while the block still opens
  // the composer (or the session's draft) as it was given back, with any
  // typing after it kept. False when the user has changed the block, or sent
  // it, since.
  const takeBackRestoredInsert = useCallback((insert: OwnInsert): boolean => {
    const block = restoredInsertsRef.current.get(insert.sessionId);
    if (!block || !block.inserts.some((restored) => restored.insertId === insert.insertId)) {
      return false;
    }
    const current = readSessionText(insert.sessionId);
    if (current !== block.text && !current.startsWith(`${block.text}\n\n`)) {
      return false;
    }
    const inserts = block.inserts.filter((restored) => restored.insertId !== insert.insertId);
    const text = inserts.map((restored) => restored.content).join('\n\n');
    // Empty, or the typing after the block with the blank line before it.
    const typedSince = current.slice(block.text.length);
    if (inserts.length > 0) {
      restoredInsertsRef.current.set(insert.sessionId, { inserts, text });
    } else {
      restoredInsertsRef.current.delete(insert.sessionId);
    }
    writeSessionText(insert.sessionId, text ? `${text}${typedSince}` : typedSince.replace(/^\n\n/, ''));
    return true;
  }, [readSessionText, writeSessionText]);

  // Sends an insert the server refused the way its reason says: a session
  // whose turn ended before the insert got there takes a normal send (decided
  // over background work like any other: see decideSendOverBackgroundWork),
  // and the rest is queued, as is everything when a turn is in flight again
  // or the composer has moved to another session. The composer is never
  // cleared here: it was emptied when the insert was sent, and anything in it
  // now was typed since.
  const fallBackFromRefusedInsert = useCallback(async (insert: OwnInsert, reason: string) => {
    const draft: QueuedDraft = {
      content: insert.content,
      attachments: [],
      uploadedAttachments: [],
      options: buildSendOptions(insert.content),
    };
    const sendsNow = reason === 'NO_ACTIVE_RUN'
      && !isLoadingRef.current
      && sessionKeyRef.current === insert.sessionId;
    if (!sendsNow) {
      await queueMessage(draft, insert.sessionId);
      return;
    }

    const options = draft.options ?? {};
    let keepBackgroundWork = supportsMidRunInsert;
    if (processingSessionsRef.current?.get(insert.sessionId)?.background) {
      const decision = await decideSendOverBackgroundWork(insert.sessionId, options, false);
      // Cancelled, or left unasked once the composer shows another session:
      // the text goes back to the insert's session either way.
      if (decision.choice === 'cancel') {
        restoreInsertText(insert);
        return;
      }
      if (decision.choice === 'queue') {
        await queueMessage(draft, insert.sessionId);
        return;
      }
      keepBackgroundWork = decision.keepBackgroundWork;
    }

    startTurn({
      sessionId: insert.sessionId,
      content: insert.content,
      uploadedAttachments: [],
      options,
      anchorId: null,
      keepBackgroundWork,
    });
  }, [buildSendOptions, decideSendOverBackgroundWork, queueMessage, restoreInsertText, startTurn, supportsMidRunInsert]);

  // What the composer does when an insert it sent ends. Only this composer
  // hears it, so in a split workspace the text goes back only where it was
  // typed. A stop or a withdrawal is the user's own doing and says nothing;
  // any other text given back says why in the transcript, when it is the one
  // on screen.
  const handleOwnInsertSettled = useCallback((insert: OwnInsert, outcome: OwnInsertOutcome) => {
    if (outcome.kind === 'delivered') {
      return;
    }
    if (outcome.kind === 'refused' && INSERT_FALLBACK_REASONS.has(outcome.reason)) {
      void fallBackFromRefusedInsert(insert, outcome.reason);
      return;
    }

    restoreInsertText(insert);
    if (outcome.kind === 'returned' && outcome.reason === 'cancelled') {
      return;
    }
    if (sessionKeyRef.current !== insert.sessionId) {
      return;
    }
    const unanswered = outcome.kind === 'returned' && outcome.reason === 'noResponse';
    const rowId = createLocalRowId();
    addMessage({
      type: 'error',
      content: unanswered
        ? t('input.insert.noResponse', {
            defaultValue: 'The insert got no answer, so the message is back in the composer.',
          })
        : t('input.insert.notDelivered', {
            defaultValue: 'The insert was not delivered, so the message is back in the composer.',
          }),
      timestamp: new Date(),
    }, { rowId });
    if (unanswered) {
      // An unanswered insert may still turn out delivered (see
      // handleReturnedInsertEnded), and this notice wrong.
      const notices = unansweredNoticesRef.current;
      notices.set(insert.insertId, { sessionId: insert.sessionId, rowId });
      if (notices.size > UNANSWERED_NOTICES_KEPT) {
        const oldestInsertId = notices.keys().next().value;
        if (oldestInsertId !== undefined) {
          notices.delete(oldestInsertId);
        }
      }
    }
  }, [addMessage, fallBackFromRefusedInsert, restoreInsertText, t]);

  // How an own insert whose text went back unanswered turned out. Delivered
  // after all, its text comes back out of the composer (or its session's
  // draft) while it is still there as given back, and the notice that said
  // it went back goes, being wrong. When the user has changed or sent the
  // text since, the text stays, and the transcript says the insert landed.
  const handleReturnedInsertEnded = useCallback((insert: OwnInsert, delivered: boolean) => {
    const notice = unansweredNoticesRef.current.get(insert.insertId);
    unansweredNoticesRef.current.delete(insert.insertId);
    if (!delivered) {
      return;
    }
    if (notice) {
      removeMessage?.(notice.sessionId, notice.rowId);
    }
    if (takeBackRestoredInsert(insert) || sessionKeyRef.current !== insert.sessionId) {
      return;
    }
    addMessage({
      type: 'error',
      content: t('input.insert.deliveredLate', {
        defaultValue: 'The insert was delivered after all, so it does not need sending again.',
      }),
      timestamp: new Date(),
    });
  }, [addMessage, removeMessage, takeBackRestoredInsert, t]);

  const {
    pendingInserts,
    sendInsert,
    withdrawInsert,
    handleInsertStatus,
    handleInsertRunEnded,
  } = usePendingInserts({
    sessionId: sessionKey,
    sendMessage,
    onOwnInsertSettled: handleOwnInsertSettled,
    onReturnedInsertEnded: handleReturnedInsertEnded,
    findTranscriptMessages,
  });

  // The server did not start a send this composer made with
  // keepBackgroundWork: the turn could not run in the process the session's
  // background work runs in, and a new process would have stopped the work.
  // Only the composer that made the send acts, found by the refusal's
  // clientRequestId, or, for a refusal without one, as the composer of the
  // session's latest send (see keepWorkSends and latestSendIds). It undoes
  // the optimistic turn (the echo, the session marked busy), puts the message
  // back in the composer at once, so nothing is lost whatever happens next,
  // and asks as it would have before sending, naming what keeps the turn out
  // of that process: cancel leaves the message in the composer, queue and
  // send anyway take it out again. Once the composer shows another session,
  // the text goes back into that session's draft and nothing is asked.
  const handleSendRefused = useCallback((event: SendRefusedEvent) => {
    const requestId = event.clientRequestId ?? latestSendIds.get(event.sessionId);
    const refused = requestId ? keepWorkSends.get(requestId) : undefined;
    if (!requestId || !refused || refused.owner !== composerToken || refused.sessionId !== event.sessionId) {
      return;
    }
    keepWorkSends.delete(requestId);
    removeMessage?.(refused.sessionId, refused.echoRowId);
    onSessionBackground?.(refused.sessionId, refused.tasks);
    putTextBack(refused.sessionId, refused.content, refused.browserFiles);
    if (sessionKeyRef.current !== refused.sessionId) {
      return;
    }

    void (async () => {
      const work = ownBackgroundTasks(refused.tasks).map((task) => describeBackgroundTask(task, t));
      const choice = await askBeforeSendingOverBackgroundWork({ work, changes: event.changes });
      if (choice === 'cancel') {
        return;
      }
      takeTextBack(refused.sessionId, refused.content, refused.browserFiles);
      if (choice === 'queue') {
        await queueMessage({
          content: refused.content,
          attachments: refused.browserFiles,
          uploadedAttachments: refused.uploadedAttachments,
          options: refused.options,
        }, refused.sessionId);
        return;
      }
      startTurn({
        sessionId: refused.sessionId,
        content: refused.content,
        uploadedAttachments: refused.uploadedAttachments,
        options: refused.options,
        anchorId: null,
        keepBackgroundWork: false,
      });
    })();
  }, [askBeforeSendingOverBackgroundWork, composerToken, onSessionBackground, putTextBack, queueMessage, removeMessage, startTurn, t, takeTextBack]);

  // A send this composer made can be refused only while it is mounted to undo it.
  useEffect(() => () => {
    for (const [requestId, send] of keepWorkSends) {
      if (send.owner === composerToken) {
        keepWorkSends.delete(requestId);
      }
    }
  }, [composerToken]);

  const submitMessage = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: QueuedDraft,
      submitOptions?: SubmitOptions,
    ) => {
      event.preventDefault();
      const currentInput = queuedSubmission?.content ?? inputValueRef.current;
      const currentAttachments = queuedSubmission?.attachments ?? attachedFiles;
      const previouslyUploadedAttachments = queuedSubmission?.uploadedAttachments ?? [];
      if (
        (
          !currentInput.trim()
          && currentAttachments.length === 0
          && previouslyUploadedAttachments.length === 0
        )
        || !selectedProject
      ) {
        return;
      }

      // What comes out of the composer once the message has left (see
      // takeSubmissionOutOfComposer), fixed now: the awaits below leave the
      // composer editable, and the user may type on or change sessions.
      const submission: ComposerSubmission = {
        scope: draftScopeRef.current,
        text: currentInput,
        files: currentAttachments,
      };

      // A turn is already in flight: stash this message instead of sending it.
      // Upload attached files now so the queued record contains durable image
      // descriptors that can be sent even if another session is open later.
      if (isLoading) {
        // A run can restart in the tiny gap between scheduling and flushing a
        // queued submission. Put the same durable draft back without uploading
        // its files again.
        if (queuedSubmission) {
          queuedDraftSessionRef.current = sessionKey;
          setQueuedDraft(queuedSubmission);
          return;
        }

        // Into the running turn, which the model reads at its next step,
        // unless the user picked Queue or the message cannot go in. The
        // composer empties as for any send; the card above it shows the
        // insert until the model has read it.
        const insertUnavailable = resolveInsertUnavailableReason({
          supportsMidRunInsert,
          canAbortSession,
          isConnected,
          isEditing: Boolean(editingAnchorId),
          content: currentInput,
          hasAttachments: currentAttachments.length > 0,
        });
        if (submitOptions?.busySubmitMode !== 'queue' && insertUnavailable === null && sessionKey) {
          sendInsert(sessionKey, currentInput);
          recordSentMessage(currentInput, sessionKey);
          takeSubmissionOutOfComposer(submission);
          return;
        }

        const queuedOptions = buildSendOptions(currentInput);
        const queuedSessionKey = sessionKey;
        let uploadedAttachments: unknown[] = [];
        try {
          uploadedAttachments = await uploadAttachmentFiles(currentAttachments);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Queued file upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload files: ${message}`,
            timestamp: new Date(),
          });
          return;
        }

        await queueMessage({
          content: currentInput,
          attachments: currentAttachments,
          uploadedAttachments,
          options: queuedOptions,
        }, queuedSessionKey, { submission });
        return;
      }

      // Intercept slash commands only when "/" is the first input character.
      // Also accept exact "help" as a convenience alias for users who expect CLI-style help.
      const commandInput = currentInput.trimEnd();
      const isHelpAlias = commandInput.trim().toLowerCase() === 'help';
      if (!submitOptions?.skipCommandInterception && (commandInput.startsWith('/') || isHelpAlias)) {
        // The name ends at the first whitespace of any kind, so "/cmd" followed
        // by a line break still runs /cmd (the Claude Code CLI splits the same way).
        const firstWhitespace = commandInput.search(/\s/);
        const commandName = isHelpAlias
          ? '/help'
          : firstWhitespace > 0 ? commandInput.slice(0, firstWhitespace) : commandInput;
        const matchedCommand =
          slashCommands.find((cmd: SlashCommand) => cmd.name === commandName) ||
          (commandName === '/help'
            ? ({
                name: '/help',
                description: 'Show help documentation for Claude Code',
                namespace: 'builtin',
                metadata: { type: 'builtin' },
              } as SlashCommand)
            : undefined);
        if (matchedCommand && matchedCommand.type !== 'skill') {
          executeCommand(matchedCommand, isHelpAlias ? '/help' : commandInput);
          recordSentMessage(currentInput);
          setInput('');
          inputValueRef.current = '';
          setAttachedFiles([]);
          setFileErrors(new Map());
          resetCommandMenuState();
          setIsTextareaExpanded(false);
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
          return;
        }
      }

      const messageContent = currentInput;

      let uploadedAttachments = previouslyUploadedAttachments;
      if (uploadedAttachments.length === 0 && currentAttachments.length > 0) {
        try {
          uploadedAttachments = await uploadAttachmentFiles(currentAttachments);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('File upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload files: ${message}`,
            timestamp: new Date(),
          });
          return;
        }
      }

      const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';
      const sessionSummary = getNotificationSessionSummary(selectedSession, currentInput);

      // The conversation always has a stable backend-allocated session id
      // BEFORE the first websocket send: brand-new chats allocate one here
      // via the session gateway. There is no client-visible session-id
      // handoff later — this id stays valid for the conversation's lifetime.
      let targetSessionId = selectedSession?.id || currentSessionId || null;
      if (!targetSessionId) {
        let createdSessionName = sessionSummary;
        try {
          const response = await api.providers.createSession({
            provider,
            projectPath: resolvedProjectPath,
            initialMessage: messageContent,
          });
          if (!response.ok) {
            throw new Error(`Failed to create session (${response.status})`);
          }
          const body = await response.json();
          targetSessionId = body?.data?.sessionId || null;
          // A blank server name would leave the session unlabeled, so the local
          // summary stays the fallback unless a real name comes back.
          const returnedSessionName = typeof body?.data?.sessionName === 'string'
            ? body.data.sessionName.trim()
            : '';
          if (returnedSessionName) {
            createdSessionName = returnedSessionName;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Session creation failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to start a new session: ${message}`,
            timestamp: new Date(),
          });
          return;
        }

        if (!targetSessionId) {
          addMessage({
            type: 'error',
            content: 'Failed to start a new session: no session id returned.',
            timestamp: new Date(),
          });
          return;
        }

        onSessionEstablished?.(targetSessionId, {
          provider,
          project: selectedProject,
          summary: createdSessionName,
        });
      }

      // A session whose turn has ended can still have background work going.
      // A provider that takes inserts (Claude) runs the message as a new turn
      // of the process that work runs in, which keeps it going, unless the
      // message needs a new process; the send key with Alt queues it behind
      // the work instead. Elsewhere, and for an edit (it resumes the
      // conversation partway, in a process of its own), a new turn replaces
      // that process: the agents, workflows and commands it still has going
      // are stopped, or finish where nothing is listening. Sending is then the
      // user's call, but not one to make for them, and queueing behind the
      // work, which the server holds until it finishes, is the safe
      // alternative (see decideSendOverBackgroundWork). Every send of such a
      // provider asks the server to keep the work, even where none shows here
      // yet: the server refuses it rather than stop work it holds.
      const sendOptions = queuedSubmission?.options ?? buildSendOptions(messageContent);
      const runsBesideWork = supportsMidRunInsert && !editingAnchorId;
      let keepBackgroundWork = runsBesideWork;
      if (processingSessionsRef.current?.get(targetSessionId)?.background) {
        let choice: BackgroundSendChoice = 'queue';
        if (!runsBesideWork || submitOptions?.busySubmitMode !== 'queue') {
          const decision = await decideSendOverBackgroundWork(targetSessionId, sendOptions, Boolean(editingAnchorId));
          choice = decision.choice;
          keepBackgroundWork = decision.keepBackgroundWork;
        }
        if (choice === 'cancel') {
          // Also the answer, unasked, once the composer shows another session
          // (see decideSendOverBackgroundWork). Nothing has come out of that
          // session's draft, so the message is still there to send on coming
          // back, unless the draft no longer opens with it (rewritten before
          // the switch, or since by the other pane of a split): then it goes
          // back in ahead of what the draft holds now.
          if (
            sessionKeyRef.current !== targetSessionId
            && !readSessionText(targetSessionId).startsWith(submission.text.trimEnd())
          ) {
            putTextBack(targetSessionId, submission.text);
          }
          return;
        }
        if (choice === 'queue') {
          if (queuedSubmission) {
            queuedDraftSessionRef.current = sessionKey;
            setQueuedDraft(queuedSubmission);
            return;
          }
          // Attachments were uploaded above; queue the same descriptors.
          await queueMessage({
            content: currentInput,
            attachments: currentAttachments,
            uploadedAttachments,
            options: buildSendOptions(currentInput),
          }, targetSessionId, { submission });
          return;
        }
      }

      startTurn({
        sessionId: targetSessionId,
        content: messageContent,
        uploadedAttachments,
        options: sendOptions,
        anchorId: editingAnchorId,
        keepBackgroundWork,
        browserFiles: currentAttachments,
      });
      // Only the edit this message made ends; one begun while it waited stays.
      setEditingAnchorId((current) => (current === editingAnchorId ? null : current));

      // Recorded under the (possibly just-allocated) session id, so the first
      // message of a new chat lands in the history of the session the user is
      // navigated to. Queued drafts were recorded when they were queued; the
      // consecutive-duplicate check keeps this second call a no-op.
      recordSentMessage(currentInput, targetSessionId);
      takeSubmissionOutOfComposer(submission);
    },
    [
      selectedSession,
      attachedFiles,
      buildSendOptions,
      canAbortSession,
      currentSessionId,
      decideSendOverBackgroundWork,
      editingAnchorId,
      executeCommand,
      isConnected,
      isLoading,
      onSessionEstablished,
      provider,
      putTextBack,
      queueMessage,
      readSessionText,
      recordSentMessage,
      resetCommandMenuState,
      selectedProject,
      sendInsert,
      sessionKey,
      addMessage,
      slashCommands,
      startTurn,
      supportsMidRunInsert,
      takeSubmissionOutOfComposer,
    ],
  );

  // Chat scopes with a submit still awaiting its upload or, for a brand-new
  // chat, its session id. The composer does not change until that returns (the
  // text stays, send stays enabled), so on a slow server the user submits
  // again — and each extra submit of a new chat allocated its own session and
  // sent it the same first message.
  const submittingScopesRef = useRef(new Set<string>());

  const handleSubmit = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: QueuedDraft,
      submitOptions?: SubmitOptions,
    ) => {
      const scope = draftScopeRef.current ?? '';
      if (submittingScopesRef.current.has(scope)) {
        // Still cancel the event: an ignored form submit must not reload the page.
        event.preventDefault();
        return;
      }
      submittingScopesRef.current.add(scope);
      try {
        await submitMessage(event, queuedSubmission, submitOptions);
      } finally {
        submittingScopesRef.current.delete(scope);
      }
    },
    [submitMessage],
  );

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  // The send button's menu while a turn runs: the submit Enter makes, with
  // the mode picked. Focus goes back to the textarea the menu took it from.
  const submitWithBusyMode = useCallback((mode: BusySubmitMode) => {
    void handleSubmit(createFakeSubmitEvent(), undefined, { busySubmitMode: mode });
    textareaRef.current?.focus();
  }, [handleSubmit]);

  // Why the message in the composer would be queued rather than inserted if
  // it were sent now; the send button and its hint follow it.
  const insertUnavailableReason = resolveInsertUnavailableReason({
    supportsMidRunInsert,
    canAbortSession,
    isConnected,
    isEditing: Boolean(editingAnchorId),
    content: input,
    hasAttachments: attachedFiles.length > 0,
  });

  // The VPS dispatcher owns sending. While the card is visible, periodically
  // reconcile it with the server, so the UI notices when the server claims it
  // or another tab adds to it.
  useEffect(() => {
    if (!sessionKey || !queuedDraft) {
      return;
    }
    let cancelled = false;
    const reconcile = async () => {
      await hydrateChatDrafts();
      if (!cancelled && !readQueuedMessage(sessionKey)) {
        queuedDraftSessionRef.current = sessionKey;
        setQueuedDraft(null);
      }
      // Another tab may have added to the queued message; the card shows what
      // will be sent, so it follows the server's copy.
      const stored = cancelled ? null : restoreQueuedDraft(sessionKey);
      if (stored) {
        setQueuedDraft((card) => {
          if (!card || showsQueuedMessage(card, stored)) {
            return card;
          }
          // This tab's browser files stay with its part of the message, so
          // editing the card still brings them back into the composer.
          return extendsQueuedMessage(card, stored) ? { ...stored, attachments: card.attachments } : stored;
        });
      }
    };
    const timer = setInterval(() => void reconcile(), 5_000);
    // A hidden tab's timers are throttled (to about once a minute after a few
    // minutes), so its card can be far behind; catch up as soon as it is shown.
    const reconcileWhenShown = () => {
      if (document.visibilityState === 'visible') {
        void reconcile();
      }
    };
    document.addEventListener('visibilitychange', reconcileWhenShown);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', reconcileWhenShown);
    };
  }, [queuedDraft, sessionKey]);

  // Editing or deleting the card takes the message off the server's queue at
  // once, before the dispatcher's next poll can send it.
  const editQueuedDraft = useCallback(() => {
    if (!queuedDraft) {
      return;
    }
    if (queuedDraftSessionRef.current) {
      clearQueuedMessage(queuedDraftSessionRef.current);
    }
    setQueuedDraft(null);
    setInput(queuedDraft.content);
    inputValueRef.current = queuedDraft.content;
    setAttachedFiles(queuedDraft.attachments);
    textareaRef.current?.focus();
  }, [queuedDraft]);

  const deleteQueuedDraft = useCallback(() => {
    if (queuedDraftSessionRef.current) {
      clearQueuedMessage(queuedDraftSessionRef.current);
    }
    setQueuedDraft(null);
  }, []);

  // A voice transcript either fills the input (to edit before sending) or, when the
  // user tapped "stop and send", is submitted straight away. Mirror the value into
  // inputValueRef synchronously so handleSubmit reads the new text, not the stale state.
  const handleVoiceTranscript = useCallback((text: string, send?: boolean) => {
    const base = inputValueRef.current.trim();
    const next = base ? `${base} ${text}` : text;
    setInput(next);
    inputValueRef.current = next;
    if (send) handleSubmitRef.current?.(createFakeSubmitEvent());
  }, [setInput]);

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  // Swap in the open scope's draft, and pick up one that arrives from another
  // device with the hydrated drafts.
  useEffect(() => {
    if (!draftScope) {
      return;
    }

    const restoreDraft = () => {
      const savedInput = readDraftText(draftScope);
      const synced = syncedDraftRef.current;
      if (synced.scope !== draftScope || synced.text !== savedInput) {
        // Another composer wrote the scope's draft (or the scope is new):
        // what a send, or a text given back, reads follows at once. React runs
        // the updater below at once only while this component has no other
        // update queued, so in a burst of frames it can wait for the next
        // render, and a text given back meanwhile would be written over the
        // other composer's.
        syncedDraftRef.current = { scope: draftScope, text: savedInput };
        inputValueRef.current = savedInput;
      }
      setInputState((previous) => {
        if (previous.scope === draftScope && previous.value === savedInput) {
          return previous;
        }
        inputValueRef.current = savedInput;
        return { scope: draftScope, value: savedInput };
      });
    };

    restoreDraft();
    return subscribeToChatDrafts(restoreDraft);
  }, [draftScope]);

  // Only persist text that was typed for the scope it is about to be written
  // to; see the inputState declaration for why the scope travels with the text.
  useEffect(() => {
    if (!draftScope || inputState.scope !== draftScope) {
      return;
    }
    // Before the write, whose notice comes back to restoreDraft at once.
    syncedDraftRef.current = { scope: draftScope, text: inputState.value };
    writeDraftText(draftScope, inputState.value);
  }, [inputState, draftScope]);

  // The card is never written back to storage: the server owns the queued
  // message, and this page's copy of it may already be out of date (sent, or
  // added to from another tab). Queueing appends on the server; editing and
  // deleting clear it there.

  // Switching sessions swaps in that session's queued draft. Browser File
  // objects are local to the mounted composer, while their already-uploaded
  // descriptors restore from storage and remain sendable.
  useEffect(() => {
    queuedDraftSessionRef.current = sessionKey;
    if (!sessionKey) {
      setQueuedDraft(null);
      return;
    }
    setQueuedDraft(restoreQueuedDraft(sessionKey));
  }, [sessionKey]);

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    if (lastAutosizedInputRef.current === input) {
      return;
    }
    // Re-run for restored drafts and programmatic input changes. User typing is
    // already resized in onInput, so this avoids doing the same forced layout twice.
    resizeTextarea(textareaRef.current);
  }, [input, resizeTextarea]);

  useEffect(() => {
    if (!textareaRef.current || input.trim()) {
      return;
    }
    textareaRef.current.style.height = 'auto';
    setIsTextareaExpanded(false);
  }, [input]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      const cursorPos = event.target.selectionStart;

      setInput(newValue);
      inputValueRef.current = newValue;
      setCursorPosition(cursorPos);

      if (!newValue.trim()) {
        event.target.style.height = 'auto';
        setIsTextareaExpanded(false);
        resetCommandMenuState();
        return;
      }

      handleCommandInputChange(newValue, cursorPos);
    },
    [handleCommandInputChange, resetCommandMenuState, setCursorPosition],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleCommandMenuKeyDown(event)) {
        return;
      }

      if (handleFileMentionsKeyDown(event)) {
        return;
      }

      if (handleHistoryKeyDown(event)) {
        return;
      }

      if (event.key === 'Tab' && !showFileDropdown && !showCommandMenu) {
        event.preventDefault();
        cyclePermissionMode();
        return;
      }

      if (event.key === 'Enter') {
        const endedJustNow =
          performance.now() - lastCompositionEndAtRef.current < SAFARI_IME_RACE_WINDOW_MS;
        if (event.nativeEvent.isComposing || isComposingRef.current || endedJustNow) {
          return;
        }

        // Alt with the send key queues a message the turn in flight would
        // otherwise take as an insert, or one a Claude session would run next
        // to its background work until that work finishes; on an idle
        // session it just sends.
        const submitOptions: SubmitOptions | undefined = event.altKey ? { busySubmitMode: 'queue' } : undefined;
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          handleSubmit(event, undefined, submitOptions);
        } else if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !sendByCtrlEnter) {
          event.preventDefault();
          handleSubmit(event, undefined, submitOptions);
        }
      }
    },
    [
      cyclePermissionMode,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleHistoryKeyDown,
      handleSubmit,
      sendByCtrlEnter,
      showCommandMenu,
      showFileDropdown,
    ],
  );

  const handleTextareaClick = useCallback(
    (event: MouseEvent<HTMLTextAreaElement>) => {
      setCursorPosition(event.currentTarget.selectionStart);
    },
    [setCursorPosition],
  );

  const handleTextareaInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      resizeTextarea(target);
      setCursorPosition(target.selectionStart);
      syncInputOverlayScroll(target);
    },
    [resizeTextarea, setCursorPosition, syncInputOverlayScroll],
  );

  const handleClearInput = useCallback(() => {
    setInput('');
    inputValueRef.current = '';
    resetCommandMenuState();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
    setIsTextareaExpanded(false);
  }, [resetCommandMenuState]);

  const handleAbortSession = useCallback(() => {
    if (!canAbortSession) {
      return;
    }

    const targetSessionId = selectedSession?.id || currentSessionId || null;
    if (!targetSessionId) {
      console.warn('Abort requested but no session ID is available.');
      return;
    }

    // The backend resolves the provider from the session row, so no provider
    // field is needed here.
    sendMessage({
      type: 'chat.abort',
      sessionId: targetSessionId,
    });
  }, [canAbortSession, currentSessionId, selectedSession?.id, sendMessage]);

  const handleGrantToolPermission = useCallback(
    (suggestion: { entry: string; toolName: string }) => {
      if (!suggestion || provider !== 'claude') {
        return { success: false };
      }
      return grantClaudeToolPermission(suggestion.entry);
    },
    [provider],
  );

  const handlePermissionDecision = useCallback(
    (
      requestIds: string | string[],
      decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
    ) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      const validIds = ids.filter(Boolean);
      if (validIds.length === 0) {
        return;
      }

      validIds.forEach((requestId) => {
        sendMessage({
          type: 'chat.permission-response',
          requestId,
          allow: Boolean(decision?.allow),
          updatedInput: decision?.updatedInput,
          message: decision?.message,
          rememberEntry: decision?.rememberEntry,
        });
      });

      setPendingPermissionRequests((previous) =>
        previous.filter((request) => !validIds.includes(request.requestId)),
      );
    },
    [sendMessage, setPendingPermissionRequests],
  );

  const [isInputFocused, setIsInputFocused] = useState(false);

  const handleInputFocusChange = useCallback(
    (focused: boolean) => {
      setIsInputFocused(focused);
    },
    [],
  );

  /** Loads an already-sent message back into the composer to be replaced. */
  const beginEditMessage = useCallback((message: ChatMessage) => {
    if (!message.transcriptAnchorId) return;
    setEditingAnchorId(message.transcriptAnchorId);
    setInput(message.content || '');
    inputValueRef.current = message.content || '';
    textareaRef.current?.focus();
  }, [setInput]);

  const cancelEditMessage = useCallback(() => {
    setEditingAnchorId(null);
    setInput('');
    inputValueRef.current = '';
  }, [setInput]);

  return {
    input,
    setInput,
    editingAnchorId,
    beginEditMessage,
    cancelEditMessage,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles: filteredFiles as MentionableFile[],
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker: open,
    handleSubmit,
    submitWithBusyMode,
    insertUnavailableReason,
    pendingInserts,
    withdrawInsert,
    handleInsertStatus,
    handleInsertRunEnded,
    handleSendRefused,
    backgroundSendPrompt,
    resolveBackgroundSendPrompt,
    queuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
  };
}
