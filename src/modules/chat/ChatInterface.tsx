import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon } from 'lucide-react';

import { useTasksSettings } from '@/modules/task-master';
import { usePaletteOpsRegister } from '@/modules/command-palette';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import { useWorkspacePane } from '@/shared/context/WorkspacePaneContext';
import { useChatInstanceCoordinator } from '@/modules/chat/context/ChatInstancesContext';
import PermissionContext from '@/modules/chat/context/PermissionContext';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';
import { TranscriptSessionContext } from '@/modules/chat/context/TranscriptSessionContext';
import { api } from '@/shared/api';
import { ESCAPE_LAYER_SELECTOR } from '@/shared/constants';
import { useElementWidth } from '@/shared/hooks/useElementWidth';
import { buildModelRunOptions } from '@/shared/utils';
import type {
  ChatMessage,
  KeyboardLockNavigator,
  Project,
  ProjectSession,
  SessionEstablishedContext,
  SessionNavigationOptions,
} from '@/shared/types';
import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import { useScheduledMessages } from '@/modules/chat/composer/useScheduledMessages';
import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import {
  useProcessingSessions,
  useSessionProtectionActions,
} from '@/shared/context/SessionProtectionContext';
import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import ChatExportMenu from '@/modules/chat/transcript/ChatExportMenu';
import PinnedQuestionBar from '@/modules/chat/transcript/PinnedQuestionBar';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';
import { deriveActivityDetails, deriveActivityProgress, isCliDrivenActivity } from '@/modules/chat/utils/runProgress';

type ChatInterfaceProps = {
  isActive: boolean;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  onFileOpen?: (filePath: string, diffInfo?: any) => void;
  onNavigateToSession?: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings?: () => void;
  showRawParameters?: boolean;
  showThinking?: boolean;
  sendByCtrlEnter?: boolean;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  onTaskClick?: (...args: unknown[]) => void;
  onShowAllTasks?: (() => void) | null;
};

/**
 * The longest Escape press that still stops a run while the workspace's
 * fullscreen holds the key; a longer one is the user holding Escape to leave
 * fullscreen, as the browser tells them to.
 */
const SHORT_ESCAPE_PRESS_MS = 500;


/**
 * Whether the browser holds Escape for the page: the workspace's fullscreen of
 * the root element locks the key where Keyboard Lock exists (Chromium, secure
 * origins). A press then reaches the page as it starts and only holding it on
 * leaves fullscreen, so its start cannot tell the two apart.
 */
const isEscapeHeldByFullscreen = (): boolean => (
  document.fullscreenElement === document.documentElement
  && window.isSecureContext
  && typeof (navigator as KeyboardLockNavigator).keyboard?.lock === 'function'
);

/**
 * The chat column sizes the pinned question shows and hides at: a column (the
 * transcript and the bar, not the composer) at least the first pair wide and
 * tall gets it; one narrower or shorter than the second pair loses it; in
 * between it stays as it was, so a column near a threshold does not flicker.
 * A phone held upright is at most about 430px wide, and an iPad's on-screen
 * keyboard leaves its column about 170px.
 */
const PINNED_QUESTION_SHOW_MIN_WIDTH_PX = 440;
const PINNED_QUESTION_SHOW_MIN_HEIGHT_PX = 400;
const PINNED_QUESTION_HIDE_BELOW_WIDTH_PX = 420;
const PINNED_QUESTION_HIDE_BELOW_HEIGHT_PX = 360;

/** Whether the chat column has room for the pinned question, given whether it had at the last measurement. */
const selectFitsPinnedQuestion = (width: number, height: number, previous: boolean | undefined): boolean => {
  if (width >= PINNED_QUESTION_SHOW_MIN_WIDTH_PX && height >= PINNED_QUESTION_SHOW_MIN_HEIGHT_PX) {
    return true;
  }
  if (width < PINNED_QUESTION_HIDE_BELOW_WIDTH_PX || height < PINNED_QUESTION_HIDE_BELOW_HEIGHT_PX) {
    return false;
  }
  return previous ?? false;
};

/**
 * Used by the project-workspace module (via the chat barrel) to render each
 * pane's Chat view, one instance per pane that follows the pane's active tab;
 * it owns the session, provider, realtime and composer state that
 * ChatMessagesPane and ChatComposer render.
 */
function ChatInterface({
  isActive,
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  onFileOpen,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  showRawParameters,
  showThinking,
  sendByCtrlEnter,
  externalMessageUpdate,
  newSessionTrigger,
  onShowAllTasks,
}: ChatInterfaceProps) {
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { subscribe, isConnected } = useWebSocket();
  const { t } = useTranslation('chat');
  // Only the focused pane answers page-wide keys and takes text from other modules.
  const { isFocusedPane } = useWorkspacePane();
  const processingSessions = useProcessingSessions();
  const {
    markSessionProcessing: onSessionProcessing,
    markSessionIdle: onSessionIdle,
    markSessionBackground: onSessionBackground,
    getSessionActivity,
  } = useSessionProtectionActions();

  const sessionStore = useSessionStore();
  // Highest live `seq` observed per session. Written by the realtime handler
  // on every sequenced frame of a run this chat follows from its start, read
  // whenever a `chat.subscribe` is sent so the server replays only the events
  // this client actually missed. Kept per chat: a pane opened mid-run needs the
  // replay its own subscribe asks for, whatever the other pane has heard.
  const lastSeqRef = useRef(new Map<string, number>());

  // What the page's coordinator reads when it elects a chat for page-wide work:
  // the session this chat shows and whether its pane is focused. Synced after
  // every commit, below, once the session state is known.
  const viewedSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  const isFocusedPaneRef = useRef(isFocusedPane);
  // Shared with every chat on the page: when each session's `chat.subscribe`
  // was last sent (idle acks older than a later request are discarded as
  // stale), the once-per-page permission prompt sounds, and the one chat that
  // reports a session's background work.
  const { statusCheckSentAtRef, claimPageEffect, isBackgroundReporter } = useChatInstanceCoordinator({
    getViewedSessionId: () => viewedSessionIdRef.current,
    getIsFocused: () => isFocusedPaneRef.current,
  });

  const {
    provider,
    setProvider,
    providerModels,
    setStoredProviderModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    currentProviderUltracode,
    currentProviderModel,
    currentProviderModelOptions,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    availablePermissionModes,
    selectPermissionMode,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelsLoading,
    providerModelActions,
    selectProviderModel,
    selectProviderEffort,
    selectProviderUltracode,
    resolvePermissionModeForProvider,
    supportsMessageEditing,
    supportsSessionForking,
    supportsImageAttachments,
    supportsFileAttachments,
    supportsMidRunInsert,
  } = useChatProviderState({
    selectedSession,
    selectedProject,
    isFocusedPane,
  });

  const {
    chatMessages,
    addMessage,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    revealMessage,
    loadAllMessages,
    loadFullTranscript,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
    requestLatestMessages,
  } = useChatSessionState({
    isActive,
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    provider,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    statusCheckSentAtRef,
    lastSeqRef,
    sessionStore,
  });

  useLayoutEffect(() => {
    viewedSessionIdRef.current = selectedSession?.id || currentSessionId || null;
    isFocusedPaneRef.current = isFocusedPane;
  });

  // The pinned question shows while the chat column has room for it, measured
  // on the element that holds the bar and the transcript (so the bar coming and
  // going does not change the measure), and once there is a message to pin.
  // Without a project the column is not rendered; the key re-measures it once
  // it is, and when the Chat view comes back into sight.
  const chatColumnRef = useRef<HTMLDivElement>(null);
  const fitsPinnedQuestion = useElementWidth(
    chatColumnRef,
    selectFitsPinnedQuestion,
    `${Boolean(selectedProject)}:${isActive}`,
  );
  const showPinnedQuestion = fitsPinnedQuestion && chatMessages.length > 0;

  // The bar coming or going changes the transcript's height by its own: a
  // transcript that followed its newest rows is put back at the bottom before
  // that frame paints.
  const wasPinnedQuestionShownRef = useRef(showPinnedQuestion);
  useLayoutEffect(() => {
    if (wasPinnedQuestionShownRef.current === showPinnedQuestion) {
      return;
    }
    wasPinnedQuestionShownRef.current = showPinnedQuestion;
    if (!isUserScrolledUp) {
      scrollToBottom();
    }
  }, [isUserScrolledUp, scrollToBottom, showPinnedQuestion]);

  // The question of the turn the first loaded row is in, for the pinned bar
  // when that question is older than every loaded page: the server names it
  // from the earliest stored row this chat holds, so no page is fetched.
  const readEarlierQuestion = useCallback(async (signal: AbortSignal): Promise<ChatMessage | null> => {
    const sessionId = selectedSession?.id || currentSessionId;
    const firstRow = sessionId ? sessionStore.getSessionSlot(sessionId)?.serverMessages[0] : undefined;
    if (!sessionId || !firstRow) {
      return null;
    }
    const response = await api.providers.sessionTurnQuestion(
      sessionId,
      { id: firstRow.id, timestamp: firstRow.timestamp },
      { signal },
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    const question = payload?.data?.question;
    if (!question) {
      return null;
    }
    // Drawn the way the transcript would draw the row: a background task's
    // report, for one, is not a question. Its row's id goes with it, for
    // findLoadedQuestion.
    const [message] = normalizedToChatMessages([question]);
    return message?.type === 'user' ? { ...message, historyRowId: question.id } : null;
  }, [currentSessionId, selectedSession?.id, sessionStore]);

  // A question readEarlierQuestion got, once the pinned bar has loaded every
  // message to jump to it: stamped as its loaded row is, found by that row's
  // id, since Cursor stamps its rows from the time of each read. Left as it
  // was when no loaded row has the id: Claude and Codex give a row without an
  // id of its own a new one on every read, and keep its time.
  const findLoadedQuestion = useCallback((question: ChatMessage): ChatMessage => {
    const sessionId = selectedSession?.id || currentSessionId;
    const rowId = question.historyRowId;
    const row = sessionId && rowId
      ? sessionStore.getMessages(sessionId).find((message) => message.id === rowId)
      : undefined;
    return row ? { ...question, timestamp: row.timestamp } : question;
  }, [currentSessionId, selectedSession?.id, sessionStore]);

  // Which of the given message ids a session's transcript holds after its
  // latest page is re-read: how the composer tells whether an insert whose run
  // ended unheard landed. A delivered insert's message has the insertId as its
  // id; one that ran as the next turn has it as its anchor. Read even while
  // this chat is hidden, as the answer decides whether text comes back: one
  // bounded request, made only for an insert that has not settled.
  const findTranscriptMessages = useCallback(async (sessionId: string, messageIds: string[]) => {
    await sessionStore.refreshLatestFromServer(sessionId);
    const wanted = new Set(messageIds);
    const found = new Set<string>();
    for (const message of sessionStore.getMessages(sessionId)) {
      for (const id of [message.id, message.transcriptAnchorId]) {
        if (id && wanted.has(id)) {
          found.add(id);
        }
      }
    }
    return found;
  }, [sessionStore]);

  // Brand-new conversation: the composer allocated a stable session id via
  // the session gateway before the first send. Record it locally and put it
  // in the URL — this id never changes again, so there is no later handoff.
  const handleSessionEstablished = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((sessionId, context) => {
    setCurrentSessionId(sessionId);
    onSessionEstablished?.(sessionId, context);
    onNavigateToSession?.(sessionId);
  }, [setCurrentSessionId, onSessionEstablished, onNavigateToSession]);

  const {
    input,
    setInput,
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
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker,
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
    editingAnchorId,
    beginEditMessage,
    cancelEditMessage,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode,
    currentProviderModel,
    currentProviderEffort,
    currentProviderUltracode,
    supportsImageAttachments,
    supportsFileAttachments,
    isLoading: isProcessing,
    processingSessions,
    canAbortSession,
    supportsMidRunInsert,
    isConnected,
    findTranscriptMessages,
    tokenBudget,
    sendMessage,
    sendByCtrlEnter,
    onSessionProcessing,
    onSessionEstablished: handleSessionEstablished,
    onFileOpen,
    onShowSettings,
    scrollToBottom,
    addMessage,
    removeMessage: sessionStore.removeRealtime,
    onSessionBackground,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
    resolvePermissionModeForProvider,
  });

  // On WebSocket reconnect, request a bounded persisted-tail sync (deferred
  // while Chat is hidden), then re-subscribe — the
  // `chat_subscribed` ack restores or clears the activity indicator, replays
  // missed live events, and re-attaches a still-running stream to this socket.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    await requestLatestMessages(selectedSession.id, isActive);
    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: lastSeqRef.current.get(selectedSession.id) ?? 0,
      }],
    });
  }, [isActive, requestLatestMessages, selectedProject, selectedSession, sendMessage, statusCheckSentAtRef]);

  useChatRealtimeHandlers({
    isActive,
    isFocusedPane,
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    lastSeqRef,
    statusCheckSentAtRef,
    claimPageEffect,
    isBackgroundReporter,
    onSessionProcessing,
    onSessionIdle,
    onSessionBackground,
    getSessionActivity,
    onWebSocketReconnect: handleWebSocketReconnect,
    onInsertStatus: handleInsertStatus,
    onInsertRunEnded: handleInsertRunEnded,
    onSendRefused: handleSendRefused,
    requestLatestMessages,
    sessionStore,
  });

  // Lets other modules (the quick settings Commands tab) hand text to the
  // composer: append it after a separating space, then focus the textarea with
  // the caret at the end once React has rendered the new value. Registered by
  // the focused pane only, so the text lands in the pane the user is in.
  const insertComposerText = useCallback((text: string) => {
    setInput((previous) => {
      const separator = previous && !/\s$/.test(previous) ? ' ' : '';
      return `${previous}${separator}${text}`;
    });
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      const caretPosition = textarea.value.length;
      textarea.setSelectionRange(caretPosition, caretPosition);
    });
  }, [setInput, textareaRef]);

  usePaletteOpsRegister(isFocusedPane ? { insertComposerText } : {});

  // Esc stops the run on screen: only while Chat is the visible view of the
  // focused pane, so another pane's run, or one behind the Files view, is
  // never stopped by a key meant for something else, and never while a menu,
  // dialog or drawer that owns Escape is open: that Escape closes it alone.
  // Where the workspace's fullscreen holds the key, a press stops the run when
  // it is released early, since holding it is how fullscreen is left.
  useEffect(() => {
    if (!canAbortSession || !isActive || !isFocusedPane) {
      return;
    }

    // When the press being held began, while fullscreen holds Escape; null when none is.
    let heldPressStartedAt: number | null = null;

    const handleEscapeDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      if (event.repeat) {
        // The rest of a press being timed stays this handler's, as its start did.
        if (heldPressStartedAt !== null) {
          event.preventDefault();
        }
        return;
      }
      heldPressStartedAt = null;
      // A layer that owns Escape takes this press whichever listener ran
      // first. One whose listener came before this one has claimed it, and a
      // browser may have committed its close in between, so it can be gone
      // from the page by now; one whose listener comes after is still open.
      if (event.defaultPrevented || document.querySelector(ESCAPE_LAYER_SELECTOR)) {
        return;
      }

      event.preventDefault();
      if (isEscapeHeldByFullscreen()) {
        heldPressStartedAt = Date.now();
        return;
      }
      handleAbortSession();
    };

    const handleEscapeUp = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || heldPressStartedAt === null) {
        return;
      }
      const heldForMs = Date.now() - heldPressStartedAt;
      heldPressStartedAt = null;
      if (heldForMs < SHORT_ESCAPE_PRESS_MS) {
        handleAbortSession();
      }
    };

    document.addEventListener('keydown', handleEscapeDown, { capture: true });
    document.addEventListener('keyup', handleEscapeUp, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleEscapeDown, { capture: true });
      document.removeEventListener('keyup', handleEscapeUp, { capture: true });
    };
  }, [canAbortSession, handleAbortSession, isActive, isFocusedPane]);

  /**
   * Branches the conversation into a new session that ends at this message,
   * then opens it. The session being viewed is left exactly as it was.
   */
  const handleForkFromMessage = useCallback(async (message: ChatMessage) => {
    const anchorId = message.transcriptAnchorId;
    const sourceSessionId = selectedSession?.id;
    if (!anchorId || !sourceSessionId) return;

    try {
      const response = await api.forkSession(sourceSessionId, { upToAnchorId: anchorId });
      const payload = await response.json();
      const forkedSessionId = payload?.data?.sessionId;
      if (!response.ok || typeof forkedSessionId !== 'string') {
        throw new Error(payload?.message || `HTTP ${response.status}`);
      }
      onNavigateToSession?.(forkedSessionId);
    } catch (error) {
      console.error('Error forking session:', error);
    }
  }, [onNavigateToSession, selectedSession?.id]);

  const { scheduledMessages, schedule: scheduleMessage, cancel: cancelScheduledMessage } =
    useScheduledMessages(currentSessionId || selectedSession?.id || null);

  /**
   * Hands the composer's current text to the server to send later, and clears
   * the box as a send would — the message has left the composer either way.
   */
  const handleScheduleMessage = useCallback(async (scheduledFor: Date) => {
    const content = input.trim();
    if (!content) return;

    const scheduled = await scheduleMessage({
      content,
      scheduledFor,
      options: {
        // The same model/effort/ultracode rule as a live send.
        ...buildModelRunOptions({
          model: currentProviderModel,
          effort: currentProviderEffort,
          ultracode: currentProviderUltracode,
        }),
        permissionMode,
      },
    });
    if (scheduled) {
      setInput('');
    }
  }, [
    currentProviderEffort,
    currentProviderModel,
    currentProviderUltracode,
    input,
    permissionMode,
    scheduleMessage,
    setInput,
  ]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
  }), [pendingPermissionRequests, handlePermissionDecision]);

  // Lets markdown image paths in the transcript resolve against this project.
  const markdownWorkspaceValue = useMemo(() => ({
    projectId: selectedProject?.projectId ?? null,
  }), [selectedProject?.projectId]);

  // Lets a workflow card fetch its agents' timelines for this session.
  const transcriptSessionValue = useMemo(() => ({ sessionId: currentSessionId }), [currentSessionId]);

  // A composer pick becomes the default for new chats and, when a session is
  // open, is recorded against that session so reopening it restores this model.
  const handleSelectComposerModel = useCallback(async (model: string) => {
    try {
      await selectProviderModel(provider, model, currentSessionId || selectedSession?.id || null);
    } catch (error) {
      console.error('Error changing the active session model:', error);
    }
  }, [currentSessionId, provider, selectProviderModel, selectedSession?.id]);

  const handleSelectComposerEffort = useCallback(async (effort: string) => {
    try {
      await selectProviderEffort(provider, effort, currentSessionId || selectedSession?.id || null);
    } catch (error) {
      console.error('Error changing the active session reasoning effort:', error);
    }
  }, [currentSessionId, provider, selectProviderEffort, selectedSession?.id]);

  const handleToggleComposerUltracode = useCallback(async (ultracode: boolean) => {
    try {
      await selectProviderUltracode(provider, ultracode, currentSessionId || selectedSession?.id || null);
    } catch (error) {
      console.error('Error changing ultracode for the active session:', error);
    }
  }, [currentSessionId, provider, selectProviderUltracode, selectedSession?.id]);

  // Mirrors ChatComposer's own visibility check so the message pane can
  // reserve enough bottom space to keep the floating status tab from
  // overlapping the last message.
  const hasActivityIndicator = Boolean(sessionActivity && pendingPermissionRequests.length === 0);

  // The session whose activity the tab shows, picked by the rule
  // useChatSessionState reads `sessionActivity` by (the selection first, as
  // `currentSessionId` catches up with it only after a render), so the tab
  // starts afresh in the same render as the activity it shows changes hands.
  const activitySessionId = selectedSession?.id || currentSessionId || null;

  // Only CloudCLI's own runtime can stop a background task, so the
  // transcript's strip offers to stop the tasks its rows name only while that
  // runtime drives the viewed session: a turn sent from here, or the
  // background work one left running. A turn a Claude CLI outside CloudCLI
  // drives has launches a history load can read as running, which nothing
  // here can stop, and with no activity nothing here runs at all.
  const canStopBackgroundTasks = sessionActivity !== null && !isCliDrivenActivity(sessionActivity);

  // What the activity tab's progress readout counts, read from the same rows
  // the transcript's cards draw: a running workflow's agents, else the turn's
  // checklist. Every loaded row, since a workflow launched pages back can
  // still be the one running.
  const activityProgress = useMemo(
    () => deriveActivityProgress(chatMessages, sessionActivity),
    [chatMessages, sessionActivity],
  );

  // What the tab's details panel lists, from the same rows: each workflow with
  // its agents, the turn's checklist and the background tasks. A reader rather
  // than a value, so it runs only while the panel is open, at the tab's clock.
  const readActivityDetails = useCallback(
    (nowMs: number) => deriveActivityDetails(chatMessages, sessionActivity, nowMs),
    [chatMessages, sessionActivity],
  );

  // Carried by the pinned question bar while it shows, and by the transcript's
  // header otherwise; one element, so the memoized bar is not redrawn for it.
  const exportMenu = useMemo(() => (
    <ChatExportMenu
      messages={chatMessages}
      sessionTitle={selectedSession?.summary || selectedSession?.title}
      provider={provider}
      selectedProject={selectedProject}
      createDiff={createDiff}
      onLoadFullTranscript={loadFullTranscript}
    />
  ), [chatMessages, createDiff, loadFullTranscript, provider, selectedProject, selectedSession?.summary, selectedSession?.title]);

  const selectedProviderLabel =
    provider === 'cursor'
      ? t('messageTypes.cursor')
      : provider === 'codex'
        ? t('messageTypes.codex')
        : provider === 'opencode'
            ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
          : provider === 'agy'
            ? t('messageTypes.agy', { defaultValue: 'Antigravity' })
            : t('messageTypes.claude');

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }


  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <div className="flex h-full min-h-0 flex-col">
        <MarkdownWorkspaceContext.Provider value={markdownWorkspaceValue}>
          <TranscriptSessionContext.Provider value={transcriptSessionValue}>
            <div ref={chatColumnRef} data-chat-column="" className="flex min-h-0 flex-1 flex-col">
              {showPinnedQuestion && (
                <PinnedQuestionBar
                  // A session's own: its cached answer and open panel go with it.
                  key={activitySessionId ?? ''}
                  scrollContainerRef={scrollContainerRef}
                  chatMessages={chatMessages}
                  renderedCount={visibleMessages.length}
                  isUserScrolledUp={isUserScrolledUp}
                  hasMoreMessages={hasMoreMessages}
                  readEarlierQuestion={readEarlierQuestion}
                  revealMessage={revealMessage}
                  loadAllMessages={loadAllMessages}
                  findLoadedQuestion={findLoadedQuestion}
                  exportMenu={exportMenu}
                />
              )}
              <ChatMessagesPane
                scrollContainerRef={scrollContainerRef}
                // Not redundant with the `scroll` listener. A first page is 20 rows,
                // tool results fold into their calls, and the "load earlier" link is
                // hidden while more pages exist — so a short transcript is often not
                // scrollable at all and never emits `scroll`. Wheel and touch are
                // then the only way to reach the top pager or the "load all" overlay.
                onWheel={handleScroll}
                onTouchMove={handleScroll}
                isLoadingSessionMessages={isLoadingSessionMessages}
                isProcessing={isProcessing}
                hasActivityIndicator={hasActivityIndicator}
                chatMessages={chatMessages}
                selectedSession={selectedSession}
                currentSessionId={currentSessionId}
                provider={provider}
                setProvider={setProvider}
                textareaRef={textareaRef}
                providerModels={providerModels}
                setProviderModel={setStoredProviderModel}
                providerModelCatalog={providerModelCatalog}
                providerModelActions={providerModelActions}
                providerModelsLoading={providerModelsLoading}
                tasksEnabled={tasksEnabled}
                isTaskMasterInstalled={isTaskMasterInstalled}
                onShowAllTasks={onShowAllTasks}
                setInput={setInput}
                isLoadingMoreMessages={isLoadingMoreMessages}
                hasMoreMessages={hasMoreMessages}
                totalMessages={totalMessages}
                sessionMessagesCount={chatMessages.length}
                visibleMessageCount={visibleMessageCount}
                visibleMessages={visibleMessages}
                loadEarlierMessages={loadEarlierMessages}
                revealMessage={revealMessage}
                backgroundTasks={sessionActivity?.tasks}
                canStopBackgroundTasks={canStopBackgroundTasks}
                sendMessage={sendMessage}
                loadAllMessages={loadAllMessages}
                allMessagesLoaded={allMessagesLoaded}
                isLoadingAllMessages={isLoadingAllMessages}
                loadAllJustFinished={loadAllJustFinished}
                showLoadAllOverlay={showLoadAllOverlay}
                createDiff={createDiff}
                onFileOpen={onFileOpen}
                onShowSettings={onShowSettings}
                onGrantToolPermission={handleGrantToolPermission}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                selectedProject={selectedProject}
                // Editing replaces the turn and everything after it, so it is only
                // offered when the session is idle — a half-truncated transcript with
                // a live stream writing into it is not recoverable.
                onEditMessage={supportsMessageEditing && !isProcessing ? beginEditMessage : undefined}
                onForkFromMessage={supportsSessionForking ? handleForkFromMessage : undefined}
                onLoadFullTranscript={loadFullTranscript}
                showExportMenu={!showPinnedQuestion}
              />
            </div>
          </TranscriptSessionContext.Provider>
        </MarkdownWorkspaceContext.Provider>

        <div className="relative flex-shrink-0">
          {isUserScrolledUp && chatMessages.length > 0 && (
            <div className="pointer-events-none absolute -top-11 end-0 start-0 z-20 flex justify-center">
              <button
                type="button"
                onClick={scrollToBottomAndReset}
                aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
                className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground"
                title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
              >
                <ArrowDownIcon className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}

          <ChatComposer
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          activity={sessionActivity}
          activitySessionId={activitySessionId}
          activityProgress={activityProgress}
          readActivityDetails={readActivityDetails}
          transcriptRef={scrollContainerRef}
          isLoading={isProcessing}
          onAbortSession={handleAbortSession}
          permissionMode={permissionMode}
          availablePermissionModes={availablePermissionModes}
          onSelectPermissionMode={selectPermissionMode}
          providerLabel={selectedProviderLabel}
          effort={currentProviderEffort}
          availableEffortOptions={currentProviderEffortOptions}
          onSelectEffort={handleSelectComposerEffort}
          ultracode={currentProviderUltracode}
          onToggleUltracode={handleToggleComposerUltracode}
          model={currentProviderModel}
          availableModelOptions={currentProviderModelOptions}
          onSelectModel={handleSelectComposerModel}
          modelsLoading={providerModelsLoading}
          tokenBudget={tokenBudget}
          onShowTokenUsage={showCostModal}
          isEditingSentMessage={Boolean(editingAnchorId)}
          onCancelEditMessage={cancelEditMessage}
          scheduledMessages={scheduledMessages}
          onScheduleMessage={handleScheduleMessage}
          onCancelScheduledMessage={cancelScheduledMessage}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          hasInput={Boolean(input.trim())}
          onClearInput={handleClearInput}
          onSubmit={handleSubmit}
          isDragActive={isDragActive}
          queuedDraft={queuedDraft}
          backgroundSendPrompt={backgroundSendPrompt}
          onResolveBackgroundSendPrompt={resolveBackgroundSendPrompt}
          onEditQueuedDraft={editQueuedDraft}
          onDeleteQueuedDraft={deleteQueuedDraft}
          pendingInserts={pendingInserts}
          onWithdrawInsert={withdrawInsert}
          insertUnavailableReason={insertUnavailableReason}
          onSubmitBusyMode={submitWithBusyMode}
          attachedFiles={attachedFiles}
          onRemoveAttachment={(index) =>
            setAttachedFiles((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          fileErrors={fileErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          openAttachmentPicker={openAttachmentPicker}
          attachmentsSupported={supportsImageAttachments || supportsFileAttachments}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onVoiceTranscript={handleVoiceTranscript}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          isInputFocused={isInputFocused}
          onInputFocusChange={handleInputFocusChange}
          placeholder={t('input.placeholder', { provider: selectedProviderLabel })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
        />
        </div>
      </div>

      <CommandResultModal
        payload={commandModalPayload}
        onClose={closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        providerModelActions={providerModelActions}
        activeProvider={provider}
        activeProviderModel={currentProviderModel}
        currentSessionId={currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={selectProviderModel}
      />
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
