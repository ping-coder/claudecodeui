import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import { api } from '@/shared/api';
import type { AddChatMessageOptions, MarkSessionIdle, SessionActivityMap,Project,ProjectSession,LLMProvider,NormalizedMessage,ChatMessage,DiffCalculator,RevealMessageOptions } from '@/shared/types';
import type { SessionSlot, SessionStore } from '@/modules/chat/hooks/useSessionStore';
import { resolveLatestRefreshLimit, SESSION_MESSAGES_PAGE_SIZE } from '@/modules/chat/utils/sessionMessagePagination';
import { createMessageHistoryRefreshCoordinator } from '@/modules/chat/utils/messageHistoryRefreshCoordinator';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { findSearchTargetIndex, resolveSearchWindowSize } from '@/modules/chat/utils/searchTargetLocator';
import type { SearchTarget } from '@/modules/chat/utils/searchTargetLocator';

const INITIAL_VISIBLE_MESSAGES = 100;

/** Messages kept below a search hit so it lands mid-viewport rather than at the edge. */
const SEARCH_TARGET_CONTEXT_MESSAGES = 20;

/**
 * Widening the window can commit thousands of rows on an old hit, each running
 * the markdown pipeline, so the scroll waits about three seconds for that render
 * — the same budget the previous DOM scan used.
 */
const SEARCH_SCROLL_RETRIES = 20;
const SEARCH_SCROLL_RETRY_DELAY_MS = 150;

/**
 * How long after a revealMessage call the transcript does not follow new rows
 * to the bottom: its retries, the scroll and the rows settling after it.
 */
const REVEAL_FOLLOW_PAUSE_MS = 1500;

/** How far below the transcript's top edge a row revealed at the start lands. */
const REVEAL_START_OFFSET_PX = 8;

/**
 * A row revealed at the start is held there for at most this many frames, and
 * no longer once it has stayed put for the second number of frames in a row.
 */
const REVEAL_HOLD_MAX_FRAMES = 60;
const REVEAL_HOLD_STILL_FRAMES = 3;

/** The user's own input, which ends the hold on a revealed row at once. */
const REVEAL_HOLD_CANCEL_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/** How long a revealed row flashes, as long as a search hit does. */
const REVEAL_HIGHLIGHT_MS = 4000;

/** The user's input on the transcript itself that scrolls it, its scrollbar included. */
const TRANSCRIPT_SCROLL_EVENTS = ['wheel', 'touchstart', 'pointerdown'] as const;

/** Keys that scroll the transcript when it has the keyboard. */
const TRANSCRIPT_SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

/**
 * Live rows younger than this survive a refresh of an idle transcript even
 * when the history read does not have them: a reply that just finished can
 * take a moment to reach the transcript on disk.
 */
const REFRESH_KEEP_REALTIME_MS = 15_000;

/** What a read of the newest rows did, as the store reports it (see refreshLatestFromServer). */
type LatestRefreshOutcome = { applied: boolean; deferred: boolean; latestTotal?: number };

/** The row a refresh keeps in place while the user reads above the bottom, found again by its time. */
type RefreshScrollAnchor = {
  timestamp: string;
  /** Which of the rows with this time it is: the rows of one tool run can share theirs. */
  occurrence: number;
  /** How far its top is below the transcript's top edge. */
  offset: number;
};

/**
 * The transcript's rows in order, each once: a lazy row's wrapper carries the
 * row's time, and so does the content inside it while mounted.
 */
function listTimestampedRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-message-timestamp]'))
    .filter((element) => {
      const outer = element.parentElement?.closest('[data-message-timestamp]');
      return !outer || !container.contains(outer);
    });
}

/** The first row still showing at the transcript's top edge; null when none is. */
function captureRefreshScrollAnchor(container: HTMLElement): RefreshScrollAnchor | null {
  const containerTop = container.getBoundingClientRect().top;
  const occurrences = new Map<string, number>();
  for (const row of listTimestampedRows(container)) {
    const timestamp = row.getAttribute('data-message-timestamp') ?? '';
    const occurrence = occurrences.get(timestamp) ?? 0;
    occurrences.set(timestamp, occurrence + 1);
    const bounds = row.getBoundingClientRect();
    if (bounds.bottom > containerTop) {
      return { timestamp, occurrence, offset: bounds.top - containerTop };
    }
  }
  return null;
}

/**
 * The first message of the visible window, found again by its time: which of
 * the window's messages with that time it is, counted from the newest, so
 * rows that come in after it or drop off above it do not change the count.
 */
type WindowTop = {
  timestamp: string;
  fromNewest: number;
};

function captureWindowTop(visibleMessages: ChatMessage[]): WindowTop | null {
  if (visibleMessages.length === 0) {
    return null;
  }
  const timestamp = String(visibleMessages[0].timestamp);
  return {
    timestamp,
    fromNewest: visibleMessages.filter((message) => String(message.timestamp) === timestamp).length,
  };
}

/** Where `top` is in `messages`; -1 when it is gone. */
function findWindowTop(messages: ChatMessage[], top: WindowTop): number {
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (String(messages[index].timestamp) === top.timestamp) {
      seen += 1;
      if (seen === top.fromNewest) {
        return index;
      }
    }
  }
  return -1;
}

/** The row `anchor` names in the transcript as it is now; null when it is gone. */
function findRefreshScrollAnchor(container: HTMLElement, anchor: RefreshScrollAnchor): HTMLElement | null {
  let occurrence = 0;
  for (const row of listTimestampedRows(container)) {
    if (row.getAttribute('data-message-timestamp') !== anchor.timestamp) {
      continue;
    }
    if (occurrence === anchor.occurrence) {
      return row;
    }
    occurrence += 1;
  }
  return null;
}

/**
 * Scrolls `container` so the top of `row` lands REVEAL_START_OFFSET_PX below
 * its top edge, then keeps it there once a frame while the rows above settle:
 * a lazy row that mounts trades its estimated height for its real one and
 * moves everything after it, and a smooth scroll aimed before that would miss.
 * Stops after a few still frames or REVEAL_HOLD_MAX_FRAMES, at the user's
 * first wheel, touch, pointer or key press, and when the transcript cannot
 * scroll that way any further. Returns what ends it early.
 */
function holdRowAtStart(container: HTMLElement, row: HTMLElement): () => void {
  let frameId = 0;
  let frames = 0;
  let stillFrames = 0;
  let isStopped = false;

  const stop = () => {
    isStopped = true;
    cancelAnimationFrame(frameId);
    for (const type of REVEAL_HOLD_CANCEL_EVENTS) {
      window.removeEventListener(type, stop, true);
    }
  };

  // Puts the row back in place; false when the scroll would not move.
  const moveRowToStart = (): boolean => {
    const drift = row.getBoundingClientRect().top
      - container.getBoundingClientRect().top
      - REVEAL_START_OFFSET_PX;
    if (Math.abs(drift) <= 1) {
      stillFrames += 1;
      return true;
    }
    stillFrames = 0;
    const previousTop = container.scrollTop;
    container.scrollTop = previousTop + drift;
    return container.scrollTop !== previousTop;
  };

  const tick = () => {
    if (isStopped) {
      return;
    }
    frames += 1;
    if (
      !row.isConnected
      || !moveRowToStart()
      || stillFrames >= REVEAL_HOLD_STILL_FRAMES
      || frames >= REVEAL_HOLD_MAX_FRAMES
    ) {
      stop();
      return;
    }
    frameId = requestAnimationFrame(tick);
  };

  for (const type of REVEAL_HOLD_CANCEL_EVENTS) {
    window.addEventListener(type, stop, { capture: true, passive: true });
  }
  if (moveRowToStart()) {
    frameId = requestAnimationFrame(tick);
  } else {
    stop();
  }
  return stop;
}

/**
 * Calls `onInput` at the user's first input that scrolls `container` by
 * hand: a wheel, touch or press on it, or a scrolling key pressed outside a
 * text field. Typing in the composer or clicking elsewhere does not count.
 * Returns what stops watching.
 */
function watchScrollInput(container: HTMLElement, onInput: () => void): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target;
    const isTextField = target instanceof HTMLElement
      && (target.isContentEditable || target.matches('input, textarea, select'));
    if (!isTextField && TRANSCRIPT_SCROLL_KEYS.has(event.key)) {
      onInput();
    }
  };
  for (const type of TRANSCRIPT_SCROLL_EVENTS) {
    container.addEventListener(type, onInput, { capture: true, passive: true });
  }
  window.addEventListener('keydown', onKeyDown, true);
  return () => {
    for (const type of TRANSCRIPT_SCROLL_EVENTS) {
      container.removeEventListener(type, onInput, true);
    }
    window.removeEventListener('keydown', onKeyDown, true);
  };
}

/**
 * Finds the rendered row for a resolved search target.
 *
 * Only an exact timestamp match counts while retries remain: the widened window
 * may not be committed yet, and accepting the nearest row then would scroll to
 * an arbitrary message and flash the highlight on it — the silent wrong answer
 * this rewrite exists to remove. `allowNearest` is used on the final attempt
 * because a hit on the second or later call of a collapsed tool group has no row
 * of its own; groupConsecutiveTools stamps the group with the run's FIRST
 * timestamp, so the group row is the nearest, not an exact, match.
 */
function findRenderedMessageElement(
  container: HTMLElement,
  timestamp: unknown,
  allowNearest: boolean,
): HTMLElement | null {
  const targetTimestamp = String(timestamp);
  const targetTime = new Date(targetTimestamp).getTime();
  const candidates = container.querySelectorAll<HTMLElement>('[data-message-timestamp]');

  let nearest: HTMLElement | null = null;
  let nearestDistance = Infinity;

  for (const candidate of candidates) {
    const candidateTimestamp = candidate.getAttribute('data-message-timestamp');
    if (!candidateTimestamp) {
      continue;
    }
    if (candidateTimestamp === targetTimestamp) {
      return candidate;
    }

    if (!allowNearest) {
      continue;
    }

    const candidateTime = new Date(candidateTimestamp).getTime();
    if (!Number.isFinite(candidateTime) || !Number.isFinite(targetTime)) {
      continue;
    }

    const distance = Math.abs(candidateTime - targetTime);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = candidate;
    }
  }

  return nearest;
}
/** Stable empty list so `chatMessages` keeps its identity while no session is selected. */
const NO_MESSAGES: NormalizedMessage[] = [];

/**
 * The visible-window size that shows the row at `index` of `total` rows, with
 * a page of context above it; the current size when the row already shows.
 * The window is a tail slice, so a row is visible when at most `count` rows
 * follow it, itself included.
 */
export function visibleCountToReveal(total: number, index: number, current: number): number {
  const needed = total - index;
  return needed <= current ? current : needed + SESSION_MESSAGES_PAGE_SIZE;
}

type UseChatSessionStateArgs = {
  isActive: boolean;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  /**
   * The provider this chat sends under. Stamps the local echo of a sent
   * message; the page-wide selected provider may belong to the other pane.
   */
  provider: LLMProvider;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  processingSessions?: SessionActivityMap;
  onSessionIdle?: MarkSessionIdle;
  /** When each session's `chat.subscribe` was last sent, by any chat on the page; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  /** Highest live seq observed per session; sent as `lastSeq` on subscribe. */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  sessionStore: SessionStore;
};

type ScrollRestoreState = {
  height: number;
  top: number;
  anchor: HTMLElement | null;
  anchorOffset: number | null;
};

function captureScrollRestoreState(container: HTMLDivElement): ScrollRestoreState {
  const containerBounds = container.getBoundingClientRect();
  const anchor = Array.from(container.querySelectorAll<HTMLElement>('.chat-message'))
    .find((element) => element.getBoundingClientRect().bottom >= containerBounds.top)
    ?? null;

  return {
    height: container.scrollHeight,
    top: container.scrollTop,
    anchor,
    anchorOffset: anchor
      ? anchor.getBoundingClientRect().top - containerBounds.top
      : null,
  };
}

/* ------------------------------------------------------------------ */
/*  Helper: Convert a ChatMessage to a NormalizedMessage for the store */
/* ------------------------------------------------------------------ */

function chatMessageToNormalized(
  msg: ChatMessage,
  sessionId: string,
  provider: LLMProvider,
  rowId?: string,
): NormalizedMessage | null {
  const id = rowId || `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = msg.timestamp instanceof Date
    ? msg.timestamp.toISOString()
    : typeof msg.timestamp === 'number'
      ? new Date(msg.timestamp).toISOString()
      : String(msg.timestamp);
  const base = { id, sessionId, timestamp: ts, provider };

  if (msg.isToolUse) {
    return {
      ...base,
      kind: 'tool_use',
      toolName: msg.toolName,
      toolInput: msg.toolInput,
      toolId: msg.toolId || id,
    } as NormalizedMessage;
  }
  if (msg.isThinking) {
    return { ...base, kind: 'thinking', content: msg.content || '' } as NormalizedMessage;
  }
  if (msg.isTaskNotification) {
    return {
      ...base,
      kind: 'task_notification',
      status: msg.taskNotificationStatus || 'completed',
      summary: msg.content || '',
    } as NormalizedMessage;
  }
  if (msg.type === 'error') {
    return { ...base, kind: 'error', content: msg.content || '' } as NormalizedMessage;
  }
  return {
    ...base,
    kind: 'text',
    role: msg.type === 'user' ? 'user' : 'assistant',
    content: msg.content || '',
    // Keep attachment references on the local echo so the user bubble shows
    // its files immediately, before the server-backed copy replaces it.
    images: Array.isArray(msg.images) && msg.images.length > 0 ? msg.images : undefined,
    files: Array.isArray(msg.files) && msg.files.length > 0 ? msg.files : undefined,
    // Survives the truncation that follows an edit, which clears every other
    // live row.
    replacesAnchorId: msg.replacesAnchorId,
  } as NormalizedMessage;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useChatSessionState({
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
}: UseChatSessionStateArgs) {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id || null);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [tokenBudget, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);
  const [loadAllJustFinished, setLoadAllJustFinished] = useState(false);
  const [showLoadAllOverlay, setShowLoadAllOverlay] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const wasNearTopRef = useRef(false);
  // The sidebar-search hit this transcript still owes the user a scroll to.
  // State rather than a ref because resolving it widens the render window,
  // and it is cleared once the row is on screen or the retries run out.
  const [searchTarget, setSearchTarget] = useState<SearchTarget | null>(null);
  const searchScrollActiveRef = useRef(false);
  /**
   * Until when (epoch ms) the follow-to-bottom stands down for a row
   * revealMessage brings into view. Rows that arrive meanwhile (a page loaded
   * just before, a streamed reply) would otherwise pull the view back down.
   */
  const revealUntilRef = useRef(0);
  /** Ends the hold on the row the last start-aligned reveal brought into view, while it runs. */
  const stopRevealHoldRef = useRef<(() => void) | null>(null);
  /**
   * Counts the jumps to a row: revealMessage calls and search hits scrolled
   * to. The retries of a reveal a later jump replaced give up, and a refresh
   * whose read was out leaves the view where a jump took it.
   */
  const revealCountRef = useRef(0);
  /**
   * The load of every message in flight, with the session it is for: a call
   * while it runs gets its promise, so a caller that looks for one of its rows
   * afterwards (the pinned question bar's jump) waits for the rows. A ref
   * rather than `isLoadingAllMessages`, so two calls in one frame share it.
   * A reset of the transcript drops it, so a call after one reads afresh.
   */
  const loadAllInFlightRef = useRef<{ sessionId: string; promise: Promise<boolean> } | null>(null);
  /**
   * Counts the resets of the transcript (another session opened, or a draft).
   * A load of every message that a reset overtook writes nothing when it
   * lands: the reset took back the flags it set, `isLoadingMoreRef` among
   * them, and a load started since owns them.
   */
  const loadAllGenerationRef = useRef(0);
  /**
   * The pending step of the search-jump retry chain, so a session change can
   * cancel a jump that belongs to the transcript the user just left.
   */
  const searchScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * `isUserScrolledUp` readable from a timer callback. Both deferred
   * scroll-to-bottom calls are armed while the user is at the bottom and fire
   * tens to hundreds of milliseconds later; without re-reading this at fire
   * time, a scroll-up inside that window is silently undone.
   */
  const isUserScrolledUpRef = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const allMessagesLoadedRef = useRef(false);
  const topLoadLockRef = useRef(false);
  const pendingScrollRestoreRef = useRef<ScrollRestoreState | null>(null);
  const pendingInitialScrollRef = useRef(true);
  const messagesOffsetRef = useRef(0);
  const scrollPositionRef = useRef({ height: 0, top: 0 });
  const loadAllFinishedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadAllOverlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoadedSessionKeyRef = useRef<string | null>(null);
  /**
   * Tracks the last processed value of `newSessionTrigger`.
   *
   * The trigger is the hosting pane's `draftActivation` (each pane has its
   * own), bumped whenever that pane switches onto a draft tab and routed via:
   * the pane in project-workspace -> WorkspaceMain -> ChatInterface -> this hook.
   * It is increment-only; comparing values ensures each switch onto a draft
   * runs exactly one reset pass in this local chat state domain.
   */
  const previousNewSessionTriggerRef = useRef(newSessionTrigger ?? 0);
  /**
   * The session a refresh asked for while the chat was hidden. A hidden chat
   * reads no history, so the refresh runs once the chat shows this session.
   */
  const pendingRefreshRef = useRef<string | null>(null);
  /** refreshTranscript, for the activation effect that runs a refresh left pending. */
  const refreshTranscriptRef = useRef<() => Promise<void>>(async () => undefined);
  /**
   * The row a refresh keeps in place, and the tick whose layout effect puts it
   * back once the new rows are committed. A tick of its own: the scroll
   * restore of a loaded page waits for the row count to change, which a
   * refresh need not do.
   */
  const refreshAnchorRef = useRef<RefreshScrollAnchor | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  /** The deferred scroll to the bottom after a refresh of a transcript that followed its newest rows. */
  const refreshFollowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);

  useEffect(() => {
    const trigger = newSessionTrigger ?? 0;
    if (trigger === previousNewSessionTriggerRef.current) {
      return;
    }
    previousNewSessionTriggerRef.current = trigger;

    /**
     * Consumer-side reset for a switch onto a draft tab (a new chat).
     *
     * Why this is essential:
     * - Chat keeps local state that is not fully derived from `selectedSession`:
     *   `currentSessionId`, `pendingUserMessage`, status flags, message
     *   pagination/scroll bookkeeping, and provider-specific sessionStorage keys.
     * - A draft's `selectedSession` is null, and that alone does not clear this
     *   state: the loading effect keeps `currentSessionId` (and so the session
     *   left on screen) while that session still has a response in flight, and
     *   a `pendingUserMessage` stays until a session takes it.
     *
     * What this reset guarantees:
     * - A clean draft state every time the pane switches onto a draft tab.
     * - No dependence on route/tab/session-object identity changes.
     * - No coupling to unrelated external update signals.
     *
     * Streamed text is left alone: it is buffered per session by the realtime
     * handler, and the session just left may still be streaming in the
     * background.
     */
    setCurrentSessionId(null);
    setPendingUserMessage(null);
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    
    setTokenBudget(null);
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    // A load of every message still running was for the transcript left
    // (see loadAllGenerationRef).
    loadAllGenerationRef.current += 1;
    loadAllInFlightRef.current = null;
    isLoadingMoreRef.current = false;
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    setSearchTarget(null);
    wasNearTopRef.current = false;
    searchScrollActiveRef.current = false;
    topLoadLockRef.current = false;
    pendingScrollRestoreRef.current = null;
    pendingInitialScrollRef.current = true;
    lastLoadedSessionKeyRef.current = null;
    pendingRefreshRef.current = null;

    if (loadAllOverlayTimerRef.current) {
      clearTimeout(loadAllOverlayTimerRef.current);
      loadAllOverlayTimerRef.current = null;
    }
    if (loadAllFinishedTimerRef.current) {
      clearTimeout(loadAllFinishedTimerRef.current);
      loadAllFinishedTimerRef.current = null;
    }
  }, [newSessionTrigger, onSessionIdle]);

  /* ---------------------------------------------------------------- */
  /*  Derive processing state for the viewed session                  */
  /* ---------------------------------------------------------------- */

  const activeSessionId = selectedSession?.id || currentSessionId || null;

  // The activity indicator always reflects the latest status of the session
  // being viewed — never stale local UI state from the last time it was
  // open. Session ids are concrete before any send, so no pending
  // placeholder entry exists anymore. Background-only work shows in the
  // indicator but is not a response in flight: the composer can send.
  const sessionActivity = (activeSessionId && processingSessions?.get(activeSessionId)) || null;
  const isProcessing = sessionActivity !== null && !sessionActivity.background;
  const canAbortSession = isProcessing && sessionActivity.canInterrupt;

  // Ref mirror so effects can read the latest map without re-running on
  // every activity transition.
  const processingSessionsRef = useRef(processingSessions);
  processingSessionsRef.current = processingSessions;

  const isActiveRef = useRef(isActive);
  const activeSessionIdRef = useRef(activeSessionId);
  isActiveRef.current = isActive;
  activeSessionIdRef.current = activeSessionId;

  // Stitches the session's newest rows onto the loaded ones and mirrors the
  // slot's paging. Resolves to what the store reports: whether the rows went
  // on, the total the server gave, and whether the read waits for the chat.
  const latestRefreshExecutorRef = useRef<(sessionId: string) => Promise<LatestRefreshOutcome>>(
    async () => ({ applied: false, deferred: false }),
  );
  latestRefreshExecutorRef.current = async (sessionId: string) => {
    const result = await sessionStore.refreshLatestFromServer(sessionId, {
      // A page, or as far back as a cached launch whose background work was
      // last seen running: no other read would replace its copy once later
      // rows push it out of the newest page.
      limit: resolveLatestRefreshLimit(sessionStore.getSessionSlot(sessionId)?.serverMessages ?? []),
      canRequest: () => (
        isActiveRef.current
        && activeSessionIdRef.current === sessionId
      ),
    });
    const slot = result.slot;
    if (slot && activeSessionIdRef.current === sessionId) {
      setHasMoreMessages(slot.hasMore);
      setTotalMessages(slot.total);
      messagesOffsetRef.current = slot.offset;
      if (slot.tokenUsage !== undefined) {
        setTokenBudget((slot.tokenUsage as Record<string, unknown> | null) ?? null);
      }
    }
    return result;
  };

  const refreshCoordinatorRef = useRef<ReturnType<typeof createMessageHistoryRefreshCoordinator> | null>(null);
  if (!refreshCoordinatorRef.current) {
    refreshCoordinatorRef.current = createMessageHistoryRefreshCoordinator(
      async (sessionId) => !(await latestRefreshExecutorRef.current(sessionId)).deferred,
      (sessionId) => isActiveRef.current && activeSessionIdRef.current === sessionId,
    );
  }

  const requestLatestMessages = useCallback((sessionId: string, allowNetwork = isActiveRef.current) => (
    refreshCoordinatorRef.current?.request(sessionId, allowNetwork) ?? Promise.resolve()
  ), []);

  /* ---------------------------------------------------------------- */
  /*  Derive chatMessages from the store                              */
  /* ---------------------------------------------------------------- */
  const [pendingUserMessage, setPendingUserMessage] = useState<ChatMessage | null>(null);
  const flushedPendingUserMessageRef = useRef<ChatMessage | null>(null);

  // Hidden Chat tabs keep collecting realtime rows without re-rendering the
  // CSS-hidden tree. Activation itself renders once and reads the latest cache.
  const activeSessionForStore = isActive ? activeSessionId : null;
  const prevActiveForStoreRef = useRef<string | null>(null);
  if (activeSessionForStore !== prevActiveForStoreRef.current) {
    prevActiveForStoreRef.current = activeSessionForStore;
    sessionStore.setActiveSession(activeSessionForStore);
  }

  useEffect(() => {
    if (!pendingUserMessage) {
      flushedPendingUserMessageRef.current = null;
      return;
    }

    if (!activeSessionId) {
      return;
    }

    if (flushedPendingUserMessageRef.current === pendingUserMessage) {
      return;
    }

    const normalized = chatMessageToNormalized(pendingUserMessage, activeSessionId, provider);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }

    flushedPendingUserMessageRef.current = pendingUserMessage;
    setPendingUserMessage(null);
  }, [activeSessionId, pendingUserMessage, provider, sessionStore]);

  const storeMessages = activeSessionId ? sessionStore.getMessages(activeSessionId) : NO_MESSAGES;

  const chatMessages = useMemo(() => {
    const all = normalizedToChatMessages(storeMessages);
    // Show pending user message when no session data exists yet (new session, pre-backend-response)
    if (pendingUserMessage && all.length === 0) {
      return [pendingUserMessage];
    }
    return all;
  }, [storeMessages, pendingUserMessage]);

  /* ---------------------------------------------------------------- */
  /*  addMessage                                                       */
  /* ---------------------------------------------------------------- */

  // `options.rowId` names the row, so its writer can take it out again; a
  // message shown as pending (no session yet) gets an id of its own later.
  const addMessage = useCallback((msg: ChatMessage, options?: AddChatMessageOptions) => {
    if (!activeSessionId) {
      // No session yet — show as pending until the backend creates one
      setPendingUserMessage(msg);
      return;
    }
    const normalized = chatMessageToNormalized(msg, activeSessionId, provider, options?.rowId);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }
  }, [activeSessionId, provider, sessionStore]);

  // Mirrors the state into a ref so the two deferred scroll-to-bottom timers
  // can re-read it at fire time. An effect rather than assignments next to each
  // `setIsUserScrolledUp` call, because the setter is also returned from this
  // hook and driven from the composer.
  useEffect(() => {
    isUserScrolledUpRef.current = isUserScrolledUp;
  }, [isUserScrolledUp]);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, []);

  const scrollToBottomAndReset = useCallback(() => {
    scrollToBottom();
    if (allMessagesLoaded) {
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
      setAllMessagesLoaded(false);
      allMessagesLoadedRef.current = false;
    }
  }, [allMessagesLoaded, scrollToBottom]);

  const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return false;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  const loadOlderMessages = useCallback(
    async (container: HTMLDivElement) => {
      if (!isActive) return false;
      if (!container || isLoadingMoreRef.current || isLoadingMoreMessages) return false;
      if (allMessagesLoadedRef.current) return false;
      if (!hasMoreMessages || !selectedSession || !selectedProject) return false;

      isLoadingMoreRef.current = true;
      setIsLoadingMoreMessages(true);
      const scrollRestoreState = captureScrollRestoreState(container);

      try {
        const result = await sessionStore.fetchMore(selectedSession.id, {
          limit: SESSION_MESSAGES_PAGE_SIZE,
          canRequest: () => (
            isActiveRef.current
            && activeSessionIdRef.current === selectedSession.id
          ),
        });
        const { slot, prependedCount } = result;
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.offset;
        if (slot.tokenUsage !== undefined) {
          setTokenBudget((slot.tokenUsage as Record<string, unknown> | null) ?? null);
        }

        if (prependedCount === 0) {
          if (!slot.hasMore) {
            allMessagesLoadedRef.current = true;
            setAllMessagesLoaded(true);
            if (loadAllOverlayTimerRef.current) {
              clearTimeout(loadAllOverlayTimerRef.current);
              loadAllOverlayTimerRef.current = null;
            }
            setShowLoadAllOverlay(false);
          }
          return false;
        }

        pendingScrollRestoreRef.current = scrollRestoreState;
        setVisibleMessageCount((prev) => prev + SESSION_MESSAGES_PAGE_SIZE);
        if (!slot.hasMore) {
          allMessagesLoadedRef.current = true;
          setAllMessagesLoaded(true);
          if (loadAllOverlayTimerRef.current) {
            clearTimeout(loadAllOverlayTimerRef.current);
            loadAllOverlayTimerRef.current = null;
          }
          setShowLoadAllOverlay(false);
        }
        return true;
      } finally {
        isLoadingMoreRef.current = false;
        setIsLoadingMoreMessages(false);
      }
    },
    [hasMoreMessages, isActive, isLoadingMoreMessages, selectedProject, selectedSession, sessionStore],
  );

  const handleScroll = useCallback(async () => {
    if (!isActive) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const nearBottom = isNearBottom();
    setIsUserScrolledUp(!nearBottom);
    scrollPositionRef.current = {
      height: container.scrollHeight,
      top: container.scrollTop,
    };

    const scrolledNearTop = container.scrollTop < 100;

    // "Load all" prompt: appear (with fade-in) when the user reaches the top
    if (scrolledNearTop && hasMoreMessages && !allMessagesLoadedRef.current) {
      if (!wasNearTopRef.current) {
        wasNearTopRef.current = true;
        if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);

        setShowLoadAllOverlay(true);
        loadAllOverlayTimerRef.current = setTimeout(() => {
          setShowLoadAllOverlay(false);
          loadAllOverlayTimerRef.current = null;
        }, 2500);
      }
    } else if (!scrolledNearTop) {
      wasNearTopRef.current = false;
    }

    if (!allMessagesLoadedRef.current) {
      if (!scrolledNearTop) { topLoadLockRef.current = false; return; }
      if (topLoadLockRef.current) {
        if (container.scrollTop > 20) topLoadLockRef.current = false;
        return;
      }
      const didLoad = await loadOlderMessages(container);
      if (didLoad) topLoadLockRef.current = true;
    }
  }, [hasMoreMessages, isActive, isNearBottom, loadOlderMessages]);

  const wasChatActiveRef = useRef(isActive);
  useLayoutEffect(() => {
    const becameActive = isActive && !wasChatActiveRef.current;
    wasChatActiveRef.current = isActive;
    if (!isActive || !scrollContainerRef.current) return;

    const container = scrollContainerRef.current;
    if (pendingScrollRestoreRef.current) {
      const { height, top, anchor, anchorOffset } = pendingScrollRestoreRef.current;
      if (anchor?.isConnected && anchorOffset !== null) {
        const nextAnchorOffset = (
          anchor.getBoundingClientRect().top
          - container.getBoundingClientRect().top
        );
        container.scrollTop += nextAnchorOffset - anchorOffset;
      } else {
        container.scrollTop = top + Math.max(container.scrollHeight - height, 0);
      }
      pendingScrollRestoreRef.current = null;
      return;
    }

    if (becameActive) {
      container.scrollTop = isUserScrolledUp
        ? scrollPositionRef.current.top
        : container.scrollHeight;
    }
  }, [chatMessages.length, isActive, isUserScrolledUp]);

  // Ends whatever owns the transcript's scroll for a while: a search jump
  // still retrying and a revealed row being held in place. Their retries give
  // up, so the transcript follows its newest rows, or keeps the user's place,
  // as it would without them.
  const cancelScrollHolds = useCallback(() => {
    if (searchScrollTimerRef.current) {
      clearTimeout(searchScrollTimerRef.current);
      searchScrollTimerRef.current = null;
    }
    searchScrollActiveRef.current = false;
    setSearchTarget(null);
    stopRevealHoldRef.current?.();
    stopRevealHoldRef.current = null;
    revealUntilRef.current = 0;
    revealCountRef.current += 1;
  }, []);

  // Reset scroll/pagination state on session change
  useEffect(() => {
    // A search jump belongs to the transcript it was requested against. Left
    // armed across a session change it did two visible things to the session
    // the user actually opened: the initial scroll bailed (it declines while a
    // jump is pending) so the transcript opened part-way up, and then, once the
    // retries ran out and started accepting the nearest row by timestamp, it
    // scrolled to an unrelated message and flashed the search highlight on it.
    //
    // Clearing it here is safe for the jump itself: the effect that reads
    // `__searchTargetSnippet` off the newly selected session runs after this
    // one, so a session opened *from* a search result re-arms immediately.
    // So does a reveal: its retries give up, and the session opened follows
    // its newest rows from the start.
    cancelScrollHolds();
    // A refresh waiting for the chat to show, or for its rows to commit, was
    // for the transcript left.
    pendingRefreshRef.current = null;
    refreshAnchorRef.current = null;
    if (refreshFollowTimerRef.current) {
      clearTimeout(refreshFollowTimerRef.current);
      refreshFollowTimerRef.current = null;
    }

    pendingInitialScrollRef.current = true;
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    topLoadLockRef.current = false;
    pendingScrollRestoreRef.current = null;
    wasNearTopRef.current = false;
    // The ref too, at once: a refresh asked for in this same commit (a tab's
    // menu opens the tab and refreshes it in one click) reads it before the
    // effect mirroring the state runs, and would keep the place the session
    // left had as if it were the reader's in this one.
    isUserScrolledUpRef.current = false;
    setIsUserScrolledUp(false);
  }, [cancelScrollHolds, selectedProject?.projectId, selectedSession?.id]);

  // Initial scroll to bottom — robust to lazy content reflow.
  // The previous implementation fired one scrollToBottom() at +200ms and
  // cleared the pending flag. When markdown blocks, code highlighting, or
  // images finished rendering after that window, scrollHeight grew but
  // nothing re-anchored the viewport, leaving the chat tab visually
  // "scrolled way up" with the latest assistant message off-screen.
  //
  // This version re-scrolls every animation frame while scrollHeight is
  // still growing, capped at ~1s (60 frames) or 3 consecutive stable
  // frames. Cancels cleanly on session change via the pending flag.
  useEffect(() => {
    if (!isActive) return;
    if (!pendingInitialScrollRef.current || !scrollContainerRef.current || isLoadingSessionMessages) return;
    if (chatMessages.length === 0) { pendingInitialScrollRef.current = false; return; }
    if (searchScrollActiveRef.current) { pendingInitialScrollRef.current = false; return; }

    const container = scrollContainerRef.current;
    let frame = 0;
    let lastHeight = 0;
    let stableCount = 0;
    let rafId = 0;

    const tick = () => {
      if (!pendingInitialScrollRef.current || !scrollContainerRef.current) return;
      container.scrollTop = container.scrollHeight;
      if (container.scrollHeight === lastHeight) {
        stableCount++;
      } else {
        stableCount = 0;
        lastHeight = container.scrollHeight;
      }
      frame++;
      if (stableCount < 3 && frame < 60) {
        rafId = requestAnimationFrame(tick);
      } else {
        pendingInitialScrollRef.current = false;
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [chatMessages.length, isActive, isLoadingSessionMessages, scrollToBottom]);

  // Session replay/subscription remains active regardless of which main tab is
  // visible. Only persisted-history HTTP traffic is visibility-gated below.
  useEffect(() => {
    if (!selectedSession || !selectedProject || !ws) return;

    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: lastSeqRef.current.get(selectedSession.id) ?? 0,
      }],
    });
  }, [lastSeqRef, selectedProject, selectedSession, sendMessage, statusCheckSentAtRef, ws]);

  // Main session loading effect — store-based.
  //
  // The dependency list is deliberately narrower than the values the body
  // reads. `selectedSession` is tracked by id only, so a websocket-driven list
  // refresh that hands back a new object for the same session does not reload
  // it; `currentSessionId` is read as the previously-loaded session (the body
  // itself is what advances it), so listing it would re-enter the effect right
  // after every load. Both are always current when the effect does run,
  // because React recreates the closure on each render.
  useEffect(() => {
    if (!selectedSession || !selectedProject) {
      // A freshly created session can be mid-run before the pane's tab hands
      // it back as selectedSession (the layout converts the draft tab in
      // place). Keep the active view intact instead of wiping it — but
      // only for a response in flight: a session whose turn has ended with
      // background work still running has a canonical id, so a missing
      // selection there is a real navigation away. The session left keeps its
      // streamed text either way: the realtime handler buffers it per session.
      const activity = currentSessionId ? processingSessionsRef.current?.get(currentSessionId) : undefined;
      if (activity && !activity.background) {
        return;
      }

      setCurrentSessionId(null);
      messagesOffsetRef.current = 0;
      setHasMoreMessages(false);
      setTotalMessages(0);
      setTokenBudget(null);
      lastLoadedSessionKeyRef.current = null;
      return;
    }

    if (!isActive) {
      setIsLoadingSessionMessages(false);
      return;
    }

    const selectedSessionId = selectedSession.id;
    const sessionKey = `${selectedSessionId}:${selectedProject.projectId}`;

    const existingSlot = sessionStore.getSessionSlot(selectedSessionId);
    const isCurrentHydratedSession =
      lastLoadedSessionKeyRef.current === sessionKey
      && Boolean(existingSlot?.fetchedAt);

    // Returning from another tab must not reset pagination or scroll. Refresh
    // a stale hydrated session through the bounded tail path instead, unless
    // a refresh asked for while hidden is about to read it whole.
    if (isCurrentHydratedSession) {
      if (sessionStore.isStale(selectedSessionId) && pendingRefreshRef.current !== selectedSessionId) {
        void requestLatestMessages(selectedSessionId);
      }
      return;
    }

    const sessionChanged = currentSessionId !== null && currentSessionId !== selectedSessionId;

    // Reset pagination/scroll state
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    // A load of every message still running was for the transcript this
    // replaces, even when it is this session's (see loadAllGenerationRef).
    loadAllGenerationRef.current += 1;
    loadAllInFlightRef.current = null;
    isLoadingMoreRef.current = false;
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    wasNearTopRef.current = false;
    if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
    if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);

    if (sessionChanged) {
      setTokenBudget(null);
    }

    setCurrentSessionId(selectedSessionId);

    lastLoadedSessionKeyRef.current = sessionKey;

    // Fetch from server → store updates → chatMessages re-derives automatically
    setIsLoadingSessionMessages(true);
    sessionStore.fetchFromServer(selectedSessionId, {
      limit: SESSION_MESSAGES_PAGE_SIZE,
      offset: 0,
      canRequest: () => (
        isActiveRef.current
        && activeSessionIdRef.current === selectedSessionId
      ),
    }).then(slot => {
      if (slot) {
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.offset;
        if (slot.tokenUsage !== undefined) {
          setTokenBudget((slot.tokenUsage as Record<string, unknown> | null) ?? null);
        }
      }
      setIsLoadingSessionMessages(false);
    }).catch(() => {
      setIsLoadingSessionMessages(false);
    });
  }, [
    isActive,
    requestLatestMessages,
    selectedProject,
    selectedSession?.id,
    sessionStore,
  ]);

  // Hidden refresh signals are coalesced. An initial page load supersedes a
  // pending latest refresh for an unhydrated/loading slot; otherwise activation
  // flushes exactly one request for the selected session, or runs the refresh
  // the user asked for while the chat was hidden, which reads more.
  useEffect(() => {
    if (!isActive || !activeSessionId) return;

    const slot = sessionStore.getSessionSlot(activeSessionId);
    if (!slot?.fetchedAt || slot.status === 'loading') {
      refreshCoordinatorRef.current?.discardPending(activeSessionId);
      if (pendingRefreshRef.current === activeSessionId) {
        pendingRefreshRef.current = null;
      }
      return;
    }

    if (pendingRefreshRef.current === activeSessionId) {
      void refreshTranscriptRef.current();
      return;
    }

    void refreshCoordinatorRef.current?.flushPending(activeSessionId);
  }, [activeSessionId, isActive, sessionStore]);

  // External message update (e.g. WebSocket reconnect, background refresh)
  useEffect(() => {
    if (!externalMessageUpdate || !selectedSession || !selectedProject) return;

    const reloadExternalMessages = async () => {
      try {
        // Skip store refresh during active streaming
        if (!isProcessing) {
          const shouldStickToBottom = isActiveRef.current && isNearBottom();
          await requestLatestMessages(selectedSession.id);

          if (shouldStickToBottom) {
            setTimeout(() => {
              if (!isUserScrolledUpRef.current && Date.now() >= revealUntilRef.current) {
                scrollToBottom();
              }
            }, 200);
          }
        }
      } catch (error) {
        console.error('Error reloading messages from external update:', error);
      }
    };

    reloadExternalMessages();
  }, [
    externalMessageUpdate,
    requestLatestMessages,
    scrollToBottom,
    selectedProject,
    selectedSession,
    isProcessing,
  ]);

  // Search navigation target
  useEffect(() => {
    const session = selectedSession as Record<string, unknown> | null;
    const targetSnippet = session?.__searchTargetSnippet;
    const targetTimestamp = session?.__searchTargetTimestamp;
    if (typeof targetSnippet === 'string' && targetSnippet) {
      searchScrollActiveRef.current = true;
      setSearchTarget({
        snippet: targetSnippet,
        timestamp: typeof targetTimestamp === 'string' ? targetTimestamp : undefined,
      });
    }
  }, [selectedSession]);

  // Scroll to search target
  useEffect(() => {
    if (!isActive || !searchTarget || chatMessages.length === 0 || isLoadingSessionMessages) return;

    const target = searchTarget;
    setSearchTarget(null);

    const scrollToTarget = async () => {
      if (!allMessagesLoadedRef.current && selectedSession && selectedProject) {
          try {
            // Load all messages into the store for search navigation
            const slot = await sessionStore.fetchFromServer(selectedSession.id, {
              limit: null,
              offset: 0,
              canRequest: () => (
                isActiveRef.current
                && activeSessionIdRef.current === selectedSession.id
              ),
            });
            if (slot) {
              // Fetch the whole transcript so an old hit can be found, but do
              // not render all of it — the window below is widened to exactly
              // what the resolved target needs.
              setHasMoreMessages(false);
              setTotalMessages(slot.total);
              messagesOffsetRef.current = slot.offset;
              setAllMessagesLoaded(true);
              allMessagesLoadedRef.current = true;
            } else if (!isActiveRef.current) {
              setSearchTarget(target);
              return;
            }
          } catch {
            // Fall through and scroll in current messages
          }
      }
      // Resolve the target against the loaded transcript rather than the DOM.
      // The store is the freshest source here: the `fetchFromServer` above has
      // landed but `chatMessages` is from the render that scheduled this effect.
      const messagesForSearch = activeSessionIdRef.current
        ? normalizedToChatMessages(sessionStore.getMessages(activeSessionIdRef.current))
        : chatMessages;
      const targetIndex = findSearchTargetIndex(messagesForSearch, target);
      if (targetIndex < 0) {
        // The target is not in the transcript at all. Scrolling somewhere
        // plausible would claim a hit that does not exist.
        searchScrollActiveRef.current = false;
        return;
      }

      // Widen the window so the target is rendered. `visibleMessages` is a tail
      // slice, so covering index N means rendering everything after it.
      const requiredVisibleCount = resolveSearchWindowSize(
        messagesForSearch.length,
        targetIndex,
        SEARCH_TARGET_CONTEXT_MESSAGES,
      );
      setVisibleMessageCount((previous) => Math.max(previous, requiredVisibleCount));

      const targetTimestamp = messagesForSearch[targetIndex].timestamp;

      const scrollToRenderedTarget = (retriesLeft: number) => {
        const container = scrollContainerRef.current;
        if (!container) return;

        // The target is inside the window by construction, so this only waits
        // for React to commit the widened list. A target collapsed inside a
        // tool group resolves to that group, which carries the same timestamp.
        const targetElement = findRenderedMessageElement(
          container,
          targetTimestamp,
          retriesLeft === 0,
        );

        if (targetElement) {
          revealCountRef.current += 1;
          targetElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
          targetElement.classList.add('search-highlight-flash');
          setTimeout(() => targetElement.classList.remove('search-highlight-flash'), 4000);
          searchScrollTimerRef.current = null;
          searchScrollActiveRef.current = false;
          return;
        }

        if (retriesLeft > 0) {
          searchScrollTimerRef.current = setTimeout(
            () => scrollToRenderedTarget(retriesLeft - 1),
            SEARCH_SCROLL_RETRY_DELAY_MS,
          );
          return;
        }

        searchScrollTimerRef.current = null;
        searchScrollActiveRef.current = false;
      };

      searchScrollTimerRef.current = setTimeout(
        () => scrollToRenderedTarget(SEARCH_SCROLL_RETRIES),
        150,
      );
    };

    scrollToTarget();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages.length, isActive, isLoadingSessionMessages, searchTarget]);

  // Initial token usage fetch for providers with file-backed usage data.
  useEffect(() => {
    if (!selectedSession?.id) {
      setTokenBudget(null);
      return;
    }
    const fetchInitialTokenUsage = async () => {
      try {
        // The provider module resolves storage and provider details from the session id.
        const response = await api.providers.sessionTokenUsage(selectedSession.id);
        if (response.ok) {
          const payload = await response.json();
          setTokenBudget(payload.data ?? null);
        } else {
          setTokenBudget(null);
        }
      } catch (error) {
        console.error('Failed to fetch initial token usage:', error);
      }
    };
    fetchInitialTokenUsage();
  }, [selectedSession?.id]);

  const visibleMessages = useMemo(() => {
    if (chatMessages.length <= visibleMessageCount) return chatMessages;
    return chatMessages.slice(-visibleMessageCount);
  }, [chatMessages, visibleMessageCount]);
  // The window as last rendered, for a refresh to keep its first row.
  const visibleMessagesRef = useRef(visibleMessages);
  visibleMessagesRef.current = visibleMessages;

  useEffect(() => {
    if (!isActive) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    scrollPositionRef.current = { height: container.scrollHeight, top: container.scrollTop };
  });

  useEffect(() => {
    if (!isActive) return;
    if (!scrollContainerRef.current || chatMessages.length === 0) return;
    if (isLoadingMoreRef.current || isLoadingMoreMessages || pendingScrollRestoreRef.current) return;
    if (searchScrollActiveRef.current || Date.now() < revealUntilRef.current) return;

    if (!isUserScrolledUp) {
      setTimeout(() => {
        if (!isUserScrolledUpRef.current && Date.now() >= revealUntilRef.current) {
          scrollToBottom();
        }
      }, 50);
    }
  }, [chatMessages.length, isActive, isLoadingMoreMessages, isUserScrolledUp, scrollToBottom]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // "Load all" overlay visibility is driven by scroll-to-top in handleScroll;
  // timers are cleared on session change via the reset effect above.

  // Resolves true once every message is in the store and the window shows
  // them all; false when they did not come in (the read failed or was not
  // made, or the chat has moved to another session since, even if it came
  // back), leaving the transcript paged as it was. A call while a load for
  // the transcript on screen runs gets that load's promise.
  const loadAllMessages = useCallback((): Promise<boolean> => {
    if (!isActive || !selectedSession || !selectedProject) {
      return Promise.resolve(false);
    }
    const requestSessionId = selectedSession.id;
    const inFlight = loadAllInFlightRef.current;
    if (inFlight?.sessionId === requestSessionId) {
      return inFlight.promise;
    }

    const load = async (): Promise<boolean> => {
      const generation = loadAllGenerationRef.current;
      const isOvertaken = () => loadAllGenerationRef.current !== generation;
      allMessagesLoadedRef.current = true;
      isLoadingMoreRef.current = true;
      setIsLoadingAllMessages(true);
      setShowLoadAllOverlay(true);
      if (loadAllOverlayTimerRef.current) {
        clearTimeout(loadAllOverlayTimerRef.current);
        loadAllOverlayTimerRef.current = null;
      }

      const container = scrollContainerRef.current;
      const scrollRestoreState = container ? captureScrollRestoreState(container) : null;

      try {
        const slot = await sessionStore.fetchFromServer(requestSessionId, {
          limit: null,
          offset: 0,
          canRequest: () => (
            isActiveRef.current
            && activeSessionIdRef.current === requestSessionId
          ),
        });

        if (
          isOvertaken()
          || currentSessionId !== requestSessionId
          || activeSessionIdRef.current !== requestSessionId
        ) {
          return false;
        }

        // A read that fails comes back as the slot it left, marked `error`.
        if (!slot || slot.status === 'error') {
          allMessagesLoadedRef.current = false;
          setShowLoadAllOverlay(false);
          return false;
        }

        if (scrollRestoreState) {
          pendingScrollRestoreRef.current = scrollRestoreState;
        }

        setHasMoreMessages(false);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.offset;
        setVisibleMessageCount(Infinity);
        setAllMessagesLoaded(true);

        setLoadAllJustFinished(true);
        if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
        loadAllFinishedTimerRef.current = setTimeout(() => {
          setLoadAllJustFinished(false);
          setShowLoadAllOverlay(false);
          loadAllFinishedTimerRef.current = null;
        }, 2500);
        return true;
      } catch (error) {
        console.error('Error loading all messages:', error);
        if (!isOvertaken()) {
          allMessagesLoadedRef.current = false;
          setShowLoadAllOverlay(false);
        }
        return false;
      } finally {
        if (!isOvertaken()) {
          isLoadingMoreRef.current = false;
          setIsLoadingAllMessages(false);
        }
      }
    };

    const promise = load();
    loadAllInFlightRef.current = { sessionId: requestSessionId, promise };
    void promise.finally(() => {
      if (loadAllInFlightRef.current?.promise === promise) {
        loadAllInFlightRef.current = null;
      }
    });
    return promise;
  }, [isActive, selectedSession, selectedProject, currentSessionId, sessionStore]);

  /**
   * Fetches the whole transcript into the store and returns it, without
   * touching the render window.
   *
   * Export needs every message; the screen does not. Keeping those separate is
   * why exporting a long conversation no longer silently produces a file
   * containing only its last page.
   */
  const loadFullTranscript = useCallback(async (): Promise<ChatMessage[]> => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      return [];
    }

    await sessionStore.fetchFromServer(sessionId, {
      limit: null,
      offset: 0,
      canRequest: () => activeSessionIdRef.current === sessionId,
    });

    return normalizedToChatMessages(sessionStore.getMessages(sessionId));
  }, [sessionStore]);

  // Re-reads the session's file-backed token usage for a refresh. A failed
  // read leaves the count shown, and one that lands after the chat moved to
  // another session is dropped.
  const reloadTokenUsage = useCallback(async (sessionId: string) => {
    try {
      const response = await api.providers.sessionTokenUsage(sessionId);
      if (!response.ok) {
        return;
      }
      const payload = await response.json();
      if (activeSessionIdRef.current === sessionId) {
        setTokenBudget(payload.data ?? null);
      }
    } catch (error) {
      console.error('Failed to refresh token usage:', error);
    }
  }, []);

  /**
   * Reads the session's transcript again, as the user asked to: the tab's
   * refresh. The chat stays mounted, so the composer, its attachments and a
   * stream being written are kept.
   *
   * - Hidden: nothing is read (a hidden chat sends no history requests); the
   *   refresh runs once the chat shows the session again.
   * - A turn running: only the newest rows are read, as after a reconnect.
   *   Swapping the whole window under a live stream would show rows twice.
   * - Otherwise: the rows loaded so far are read again as one window, all of
   *   them when every message was loaded, and live rows the history never
   *   took are dropped once old enough, but only when no work at all runs.
   *
   * A reader at the bottom stays there, and so does one who went back there
   * while the read was out; one scrolled up keeps the row at the top of the
   * view where it was, unless they scrolled meanwhile or a jump to a row
   * moved the view.
   */
  const refreshTranscript = useCallback(async (): Promise<void> => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      return;
    }

    if (!isActiveRef.current) {
      pendingRefreshRef.current = sessionId;
      // Also marked dirty for the history coordinator, as any refresh signal a
      // hidden chat gets is; the refresh run on activation takes its place.
      void refreshCoordinatorRef.current?.request(sessionId, false);
      return;
    }
    pendingRefreshRef.current = null;

    cancelScrollHolds();
    if (refreshFollowTimerRef.current) {
      clearTimeout(refreshFollowTimerRef.current);
      refreshFollowTimerRef.current = null;
    }
    const container = scrollContainerRef.current;
    const anchor = isUserScrolledUpRef.current && container ? captureRefreshScrollAnchor(container) : null;
    const windowTop = anchor ? captureWindowTop(visibleMessagesRef.current) : null;
    // Putting the row back would undo where the user, or a jump to a row,
    // moved the view while the read was out.
    let isViewMoved = false;
    const revealCount = revealCountRef.current;
    const stopWatchingScroll = anchor && container
      ? watchScrollInput(container, () => {
        isViewMoved = true;
      })
      : null;
    // The window renders only the newest rows, so rows that come in push the
    // oldest out, the anchor row among them. Widened by exactly as many, the
    // window still starts at the same message, so the rows above the anchor
    // group and count as when it was captured, and it can be found and put
    // back. A window that grew meanwhile stays as wide.
    const keepAnchorRendered = () => {
      if (!windowTop) {
        return;
      }
      const messages = normalizedToChatMessages(sessionStore.getMessages(sessionId));
      const index = findWindowTop(messages, windowTop);
      if (index >= 0) {
        setVisibleMessageCount((count) => Math.max(count, messages.length - index));
      }
    };

    try {
      const activity = processingSessionsRef.current?.get(sessionId);
      if (activity && !activity.background) {
        await requestLatestMessages(sessionId);
      } else {
        // Comes after a load of every message still running, so it reads them all.
        const loadAll = loadAllInFlightRef.current;
        if (loadAll?.sessionId === sessionId) {
          await loadAll.promise;
        }
        if (activeSessionIdRef.current !== sessionId) {
          return;
        }

        const isLoadedEverything = (slot: SessionSlot | undefined) => (
          allMessagesLoadedRef.current || Boolean(slot?.fetchedAt && !slot.hasMore)
        );
        // This refresh covers whatever tail refresh was waiting.
        refreshCoordinatorRef.current?.discardPending(sessionId);
        // The total the server reported when the rows written since could not
        // be stitched on; 0 when they were, or nothing was read.
        let unstitchedTotal = 0;
        if (!isLoadedEverything(sessionStore.getSessionSlot(sessionId))) {
          // Rows written since the last read are stitched onto the loaded ones
          // first, keeping every loaded row: read at the depth loaded before,
          // the window would lose its oldest rows, the reader's among them, to
          // as many new ones.
          const tail = await latestRefreshExecutorRef.current(sessionId);
          if (activeSessionIdRef.current !== sessionId) {
            return;
          }
          unstitchedTotal = tail.applied ? 0 : tail.latestTotal ?? 0;
          keepAnchorRendered();
        }

        const slot = await sessionStore.fetchFromServer(sessionId, {
          // Sized when the read runs, so a page loaded before it counts too.
          // Rows that could not be stitched on leave the loaded depth as it
          // was, so the read reaches back as many rows further as the
          // transcript grew.
          limit: (current) => (
            isLoadedEverything(current)
              ? null
              : Math.max(SESSION_MESSAGES_PAGE_SIZE, current.offset + Math.max(0, unstitchedTotal - current.total))
          ),
          offset: 0,
          canRequest: () => (
            isActiveRef.current
            && activeSessionIdRef.current === sessionId
          ),
          // Background work can still write rows the history does not have yet,
          // and so can a turn started while the read is out.
          dropStaleRealtime: processingSessionsRef.current?.get(sessionId)
            ? undefined
            : {
              keepNewerThanMs: REFRESH_KEEP_REALTIME_MS,
              shouldDrop: () => !processingSessionsRef.current?.get(sessionId),
            },
        });
        if (activeSessionIdRef.current !== sessionId) {
          return;
        }
        if (!slot) {
          // Hidden before the read could start: it runs when the chat shows.
          if (!isActiveRef.current) {
            pendingRefreshRef.current = sessionId;
          }
          return;
        }
        if (slot.status !== 'error') {
          setHasMoreMessages(slot.hasMore);
          setTotalMessages(slot.total);
          messagesOffsetRef.current = slot.offset;
          if (slot.tokenUsage !== undefined) {
            setTokenBudget((slot.tokenUsage as Record<string, unknown> | null) ?? null);
          }
        }
      }
    } finally {
      stopWatchingScroll?.();
    }

    if (activeSessionIdRef.current !== sessionId) {
      return;
    }
    void reloadTokenUsage(sessionId);

    if (!isUserScrolledUpRef.current) {
      refreshFollowTimerRef.current = setTimeout(() => {
        refreshFollowTimerRef.current = null;
        if (!isUserScrolledUpRef.current && Date.now() >= revealUntilRef.current) {
          scrollToBottom();
        }
      }, 200);
    } else if (anchor && !isViewMoved && revealCountRef.current === revealCount) {
      keepAnchorRendered();
      refreshAnchorRef.current = anchor;
      setRefreshTick((tick) => tick + 1);
    }
  }, [cancelScrollHolds, reloadTokenUsage, requestLatestMessages, scrollToBottom, sessionStore]);
  refreshTranscriptRef.current = refreshTranscript;

  // Puts the row a refresh kept back where it was, once the rows the refresh
  // read are committed: rows above it may have come or gone, or changed
  // height as they mounted afresh.
  useLayoutEffect(() => {
    const anchor = refreshAnchorRef.current;
    refreshAnchorRef.current = null;
    const container = scrollContainerRef.current;
    if (!anchor || !container) {
      return;
    }
    const row = findRefreshScrollAnchor(container, anchor);
    if (!row) {
      return;
    }
    const offset = row.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTop += offset - anchor.offset;
  }, [refreshTick]);

  useEffect(() => () => {
    if (refreshFollowTimerRef.current) {
      clearTimeout(refreshFollowTimerRef.current);
    }
  }, []);

  const loadEarlierMessages = useCallback(() => {
    setVisibleMessageCount((prev) => prev + 100);
  }, []);

  // Brings one row into view even when it is outside the visible window or
  // sits in a lazy row that has not mounted: widen the window to include it,
  // then scroll to the row's wrapper, which is in the DOM as soon as the row
  // is inside the window, mounted or not. `center` (the default) scrolls there
  // smoothly; `start` puts the row's top just under the transcript's top edge
  // at once and holds it there while the rows above settle. `exact` takes the
  // message's own row or none.
  const revealMessage = useCallback((message: ChatMessage, options: RevealMessageOptions = {}) => {
    const { block = 'center', highlight = false, exact = false } = options;
    // The follow-to-bottom stands down meanwhile, and so does the initial
    // settle if it still runs: either would pull the view back to the bottom.
    revealUntilRef.current = Date.now() + REVEAL_FOLLOW_PAUSE_MS;
    pendingInitialScrollRef.current = false;
    stopRevealHoldRef.current?.();
    stopRevealHoldRef.current = null;
    revealCountRef.current += 1;
    const revealId = revealCountRef.current;

    const index = chatMessages.indexOf(message);
    if (index >= 0) {
      setVisibleMessageCount((prev) => visibleCountToReveal(chatMessages.length, index, prev));
    }

    const attempt = (remaining: number) => {
      if (revealId !== revealCountRef.current) {
        return;
      }
      const container = scrollContainerRef.current;
      // The widened window commits after this frame, so the row can be absent
      // on the first attempts; only the last one may settle for the nearest
      // row (a hit collapsed inside a tool group carries the group's
      // timestamp), or the first attempt scrolls to an unrelated row and the
      // retries never run. An exact reveal never settles: its message has a
      // row of its own, so the nearest one would be another message.
      const element = container ? findRenderedMessageElement(container, message.timestamp, !exact && remaining === 0) : null;
      if (element && container) {
        if (block === 'start') {
          stopRevealHoldRef.current = holdRowAtStart(container, element);
        } else {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        if (highlight) {
          element.classList.add('search-highlight-flash');
          setTimeout(() => element.classList.remove('search-highlight-flash'), REVEAL_HIGHLIGHT_MS);
        }
        return;
      }
      if (remaining > 0) {
        requestAnimationFrame(() => attempt(remaining - 1));
      }
    };
    requestAnimationFrame(() => attempt(10));
  }, [chatMessages]);

  // A hold still running when the chat unmounts would scroll a detached transcript.
  useEffect(() => () => {
    stopRevealHoldRef.current?.();
  }, []);

  return {
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
    refreshTranscript,
  };
}
