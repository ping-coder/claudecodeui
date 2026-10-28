import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { InsertStatus, InsertStatusEvent, SendRefusedEvent, ServerEvent,MarkSessionIdle,MarkSessionProcessing,PendingPermissionRequest,ProjectSession,LLMProvider,NormalizedMessage,GetSessionActivity,MarkSessionBackground } from '@/shared/types';
import { playNotificationSound } from '@/shared/utils';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { collectRunningBackgroundTasks } from '@/modules/chat/utils/backgroundTasks';
import { hasRunningWorkflow, isCliDrivenActivity } from '@/modules/chat/utils/runProgress';
import {
  SESSION_MESSAGES_PAGE_SIZE,
  listToolIdsBeyondLatestRefresh,
  resolveLatestRefreshLimit,
} from '@/modules/chat/utils/sessionMessagePagination';

const isActionablePermissionRequest = (request: { toolName?: unknown } | null | undefined): boolean => {
  return request?.toolName !== 'ExitPlanMode' && request?.toolName !== 'exit_plan_mode';
};

const hasActionablePermissionRequests = (requests: Array<{ toolName?: unknown }> | null | undefined): boolean => {
  return Array.isArray(requests) && requests.some((request) => isActionablePermissionRequest(request));
};

/**
 * The tick of the timer that re-reads the viewed transcript while a Claude
 * CLI process CloudCLI does not drive runs a workflow in it: the
 * running-sessions poll's cadence, which is also how often the tab learns
 * whether that run goes on. A run within the newest page is re-read at every
 * tick, one further back less often (`WIDE_WINDOW_REFRESH_EVERY_TICKS`).
 */
const CLI_WORKFLOW_REFRESH_INTERVAL_MS = 5_000;

/**
 * While the run followed sits further back than the newest page, every
 * re-read re-sends the whole window up to its launch, each row with its tool
 * result folded in, which can come to megabytes. It is then re-read only on
 * every this-many-th tick, every 15 s, which still keeps up with a run whose
 * agents take minutes.
 */
const WIDE_WINDOW_REFRESH_EVERY_TICKS = 3;

/**
 * How many frames one session's replay record holds. The server buffers at
 * most this many events per run for replay (MAX_BUFFERED_EVENTS_PER_RUN in
 * chat-run-registry.service.ts), so no replay resends more.
 */
const REPLAY_FRAME_KEYS_PER_SESSION = 5_000;

/** How many inserts' statuses one chat remembers; inserts are rare, and the oldest are forgotten first. */
const REMEMBERED_INSERT_STATUSES = 1_000;

/**
 * How far along an insert each status is. An insert only moves forward, so a
 * status no further than the last one handled is a replay or a late copy: a
 * replayed `pending` after the live `delivered` must not list it again.
 */
const INSERT_STATUS_PROGRESS: Record<InsertStatus, number> = {
  pending: 1,
  cancel_failed: 2,
  delivered: 3,
  next_turn: 3,
  cancelled: 3,
  failed: 3,
  refused: 3,
};

const readInsertStatus = (value: unknown): InsertStatus | null => (
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(INSERT_STATUS_PROGRESS, value)
    ? value as InsertStatus
    : null
);

/** Text one session has streamed that is not in the store yet, and the timer that will write it there. */
type StreamBuffer = {
  text: string;
  timer: number | null;
  /** Seq of the last delta added. Each run counts seq from 1, so a delta numbered at or below it starts a later run. */
  lastSeq: number | null;
};

type UseChatRealtimeHandlersArgs = {
  isActive: boolean;
  /**
   * Whether this chat's pane is the focused one. Only the focused pane takes a
   * frame that names no session, showing it in the session on screen; the
   * others drop it. Defaults to true: outside the split workspace the lone chat
   * is the focused one.
   */
  isFocusedPane?: boolean;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  pendingPermissionRequests: PendingPermissionRequest[];
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  /**
   * Seq of the last live frame heard per session, of the run a subscribe can
   * still replay. Essential for reconnect catch-up: `chat.subscribe` sends this
   * value as `lastSeq` so the server replays only the events this client
   * actually missed. Written here on every sequenced frame of a run this chat
   * follows from its start (absent for a run it only joined part-way, so its
   * subscribe asks for the whole run), dropped once that run ends (its
   * `complete`, or a subscribe the server answers with no run going on), so a
   * subscribe during the session's next run asks for it from its start; read
   * wherever a `chat.subscribe` is sent (session open, reconnect).
   */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  /**
   * When each session's `chat.subscribe` was last sent, by any chat on the
   * page; guards stale idle acks. Shared because every chat hears every ack.
   */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  /**
   * Claims a page-wide effect (a permission prompt's sound) by event key; false
   * when another chat on the page already ran it for the same event.
   */
  claimPageEffect: (eventKey: string) => boolean;
  /** Whether this chat is the one that writes a session's remaining background work into the activity map. */
  isBackgroundReporter: (sessionId: string) => boolean;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  /** Reports the tasks a session still runs once its turn ends, so it reads as background work rather than idle. */
  onSessionBackground?: MarkSessionBackground;
  getSessionActivity?: GetSessionActivity;
  onWebSocketReconnect?: () => void;
  /**
   * Hands over a mid-run insert's status, once per insert and status, from
   * any session: the composer lists the insert and acts on its own ones.
   * These frames never reach the transcript store.
   */
  onInsertStatus?: (event: InsertStatusEvent) => void;
  /**
   * Says a session's run is over, so its inserts report nothing more: at its
   * `complete` (`sentBefore` null), and at an idle subscribe ack, which speaks
   * only for inserts sent before that subscribe (`sentBefore` is when it was
   * sent, or null when unknown).
   */
  onInsertRunEnded?: (sessionId: string, sentBefore: number | null) => void;
  /**
   * Hands over a `send_refused`: the server did not start a `chat.send` this
   * page sent with `keepBackgroundWork`, as it would have stopped the
   * session's background work. Never a transcript row.
   */
  onSendRefused?: (event: SendRefusedEvent) => void;
  requestLatestMessages: (sessionId: string, allowNetwork?: boolean) => Promise<void>;
  sessionStore: SessionStore;
};

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

/**
 * Routes server events into the session store and processing-state map.
 *
 * This is intentionally a thin reducer over the unified `kind`-based
 * protocol: every frame is keyed by the stable app session id, so there is
 * no session-id handoff, no provider branching, and no navigation here.
 * Sidebar events (`session_upserted`, `loading_progress`) are handled by
 * `useProjectsState`, not in this hook — except that the viewed transcript
 * reloads here on `session_upserted` while a Claude CLI process CloudCLI does
 * not drive runs its turn, since the sidebar's reload skips a busy session.
 * While such a turn's transcript shows a workflow still running, and a re-read
 * of its latest rows reaches the launch, it is also re-read on a timer, as the
 * run's progress is written where no event reports it.
 *
 * Every chat on the page hears every frame of the one shared socket (a split
 * workspace mounts two), so streamed text is buffered per session, a replay
 * this chat has already handled is dropped, and the work only one chat may do
 * (a permission prompt's sound, a background-work report) goes through the
 * page's coordinator. A chat stores a session's frames only from the start of
 * its run: the frames of a run it joined part-way, because another chat had
 * attached the socket to it, wait for the replay its own subscribe asks for.
 * How a finished run is announced (the chime, the title alert, banners) is not
 * the chat's business: run-notifications does it from `run_ended`, for every
 * run on the server, followed here or not.
 */
export function useChatRealtimeHandlers({
  isActive,
  isFocusedPane = true,
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
  onWebSocketReconnect,
  onInsertStatus,
  onInsertRunEnded,
  onSendRefused,
  requestLatestMessages,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  const viewedSessionId = selectedSession?.id || currentSessionId || null;
  // Session switches can send `chat.subscribe` before this effect has a chance
  // to rebind the websocket listener. Read the visible session id from a ref
  // so a fast `chat_subscribed` ack is matched against the current view, not
  // the previous render's closed-over selection.
  const activeViewSessionIdRef = useRef<string | null>(viewedSessionId);
  activeViewSessionIdRef.current = viewedSessionId;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  // Focus as of the last commit, read by the listener at event time, so a
  // focus change does not resubscribe it.
  const isFocusedPaneRef = useRef(isFocusedPane);
  useLayoutEffect(() => {
    isFocusedPaneRef.current = isFocusedPane;
  }, [isFocusedPane]);

  // Streamed text not yet written into the store, per session. Each session
  // keeps its own text and flush timer, so two sessions streaming at once
  // never mix, and switching the session on screen leaves a background
  // stream's text where it is. Read and written only by this hook.
  const streamBuffersRef = useRef(new Map<string, StreamBuffer>());
  // `${seq}:${id}` of each sequenced frame this chat has handled, per session.
  // Another chat subscribing a running session makes the server replay the run
  // to the page's single socket, and every chat hears that replay.
  const handledFrameKeysRef = useRef(new Map<string, Set<string>>());
  // Sessions whose run this chat has followed from its first frame: it heard
  // the run start, or the replay of a subscribe from scratch, or the server
  // said no run was going on. Only their sequenced frames are stored. A run
  // joined part-way (the socket was already attached for another chat when
  // this one mounted) would store the tail of a reply without its beginning,
  // which no history refresh removes, and a seq that makes this chat's
  // subscribe ask the server for nothing earlier; such a chat holds no seq for
  // the session, so its subscribe asks for the whole run. Never cleared: a
  // followed session's later runs are heard from their start.
  const followedRunsRef = useRef(new Set<string>());
  // For a session not followed yet, the seq of the frame a replay of its run
  // starts at, when the server no longer buffers the run's first frame (see
  // REPLAY_FRAME_KEYS_PER_SESSION); 1 when absent.
  const replayStartSeqRef = useRef(new Map<string, number>());
  // Per session, the seq the run that ended last had reached when this chat
  // learned it was over, until the session's next run is heard. The run goes
  // on numbering the background work it left going (task progress, the turn
  // the CLI pushes when a task reports), and no replay resends any of it, so
  // frames numbered past this set no lastSeq record; the next run counts from
  // 1 again, so its first frame comes in at or below it and clears it.
  const endedRunSeqRef = useRef(new Map<string, number>());
  // The last status handled for each insert. An insert's frames reach a chat
  // more than once and out of order (live, then in the replay a subscribe asks
  // for), and the composer must act on each status once.
  const insertStatusesRef = useRef(new Map<string, InsertStatus>());

  // A flush still pending when the chat goes away has no transcript to write.
  useEffect(() => {
    const streamBuffers = streamBuffersRef.current;
    return () => {
      for (const buffer of streamBuffers.values()) {
        if (buffer.timer !== null) {
          window.clearTimeout(buffer.timer);
        }
      }
      streamBuffers.clear();
    };
  }, []);

  // Keep the latest pending-permission snapshot available to the websocket
  // listener so back-to-back permission events can dedupe and re-arm the
  // notification sound before React finishes a rerender.
  const pendingPermissionRequestsRef = useRef(pendingPermissionRequests);

  useEffect(() => {
    pendingPermissionRequestsRef.current = pendingPermissionRequests;
  }, [pendingPermissionRequests]);

  // A workflow the Claude CLI runs outside CloudCLI moves on in its own
  // journal while the transcript stays quiet, and the sessions watcher does
  // not report on the journal: the `session_upserted` reload below never
  // comes, so the view would keep the run's agents as they stood at the last
  // transcript write. While the viewed session's turn is such a run and its
  // transcript shows a workflow still running (by the details panel's rule),
  // the transcript is re-read at every tick, or at every third tick (15 s)
  // while the re-read has to reach back past the newest page, as it then
  // re-sends the whole window; the history reader folds the journal in on
  // each read, and the refresh coordinator folds overlapping reloads into
  // one. The re-read reaches back to a launch still running, but only so far
  // (`resolveLatestRefreshLimit`): a run whose launch sits further back would
  // come back unchanged at every read, so it is not followed, and its card
  // keeps what the last read that reached it said. Both conditions are read
  // at each tick, so the reloads stop at the first tick after either ends; a
  // session switch or unmount clears the timer.
  useEffect(() => {
    if (!viewedSessionId || !getSessionActivity) {
      return undefined;
    }
    let tick = 0;
    const timer = window.setInterval(() => {
      tick += 1;
      if (!isCliDrivenActivity(getSessionActivity(viewedSessionId))) {
        return;
      }
      const serverMessages = sessionStore.getSessionSlot(viewedSessionId)?.serverMessages ?? [];
      const beyondReach = listToolIdsBeyondLatestRefresh(serverMessages);
      if (!hasRunningWorkflow(normalizedToChatMessages(sessionStore.getMessages(viewedSessionId)), beyondReach)) {
        return;
      }
      if (
        resolveLatestRefreshLimit(serverMessages) > SESSION_MESSAGES_PAGE_SIZE
        && tick % WIDE_WINDOW_REFRESH_EVERY_TICKS !== 0
      ) {
        return;
      }
      void requestLatestMessages(viewedSessionId);
    }, CLI_WORKFLOW_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [viewedSessionId, getSessionActivity, requestLatestMessages, sessionStore]);

  useEffect(() => {
    // What a session that has finished responding is left with: the tasks it
    // launched that are still running, or nothing, which marks it idle. The
    // store's records are what the transcript's cards fold their live status
    // from, so this reads the same answer they draw. Only the chat the page
    // elects writes it: each chat reads its own store, and of two that
    // disagree the last writer would win.
    const reportRemainingBackgroundWork = (sid: string) => {
      if (!isBackgroundReporter(sid)) {
        return;
      }
      onSessionBackground?.(sid, collectRunningBackgroundTasks(normalizedToChatMessages(sessionStore.getMessages(sid))));
    };

    // Writes a session's buffered text into the store and forgets the buffer;
    // true when there was text to write.
    const flushStreamBuffer = (sid: string): boolean => {
      const buffer = streamBuffersRef.current.get(sid);
      if (!buffer) {
        return false;
      }
      if (buffer.timer !== null) {
        window.clearTimeout(buffer.timer);
      }
      streamBuffersRef.current.delete(sid);
      if (!buffer.text) {
        return false;
      }
      sessionStore.updateStreaming(sid, buffer.text, provider);
      return true;
    };

    // Forgets what this chat holds of a session's run once the server says no
    // run is going on. A stream still buffered then is one whose end the socket
    // was away for (it dropped, or the server restarted): its text stays
    // unfinished, and the session's next run must neither continue it nor find
    // it on screen. No replay can resend that run, so its frame keys and seq go
    // too, and a later subscribe asks for whatever run comes next in full.
    const forgetFinishedRun = (sid: string) => {
      const buffer = streamBuffersRef.current.get(sid);
      if (buffer && buffer.timer !== null) {
        window.clearTimeout(buffer.timer);
      }
      streamBuffersRef.current.delete(sid);
      handledFrameKeysRef.current.delete(sid);
      lastSeqRef.current.delete(sid);
      sessionStore.discardStreaming(sid);
    };

    // Records a sequenced frame as handled; false when this chat already
    // handled it, so this delivery is a replay. The oldest keys go first once a
    // session holds a whole run's worth.
    const rememberHandledFrame = (sid: string, frameKey: string): boolean => {
      let frameKeys = handledFrameKeysRef.current.get(sid);
      if (!frameKeys) {
        frameKeys = new Set<string>();
        handledFrameKeysRef.current.set(sid, frameKeys);
      }
      if (frameKeys.has(frameKey)) {
        return false;
      }
      frameKeys.add(frameKey);
      if (frameKeys.size > REPLAY_FRAME_KEYS_PER_SESSION) {
        const oldestKey = frameKeys.values().next().value;
        if (oldestKey !== undefined) {
          frameKeys.delete(oldestKey);
        }
      }
      return true;
    };

    // Records an insert's status as handled; false when the insert has
    // already got this far, so this frame is a replay or a late copy.
    const rememberInsertStatus = (insertId: string, insertStatus: InsertStatus): boolean => {
      const statuses = insertStatusesRef.current;
      const previous = statuses.get(insertId);
      if (previous && INSERT_STATUS_PROGRESS[insertStatus] <= INSERT_STATUS_PROGRESS[previous]) {
        return false;
      }
      // Re-inserted, so the most recently moved insert is the last forgotten.
      statuses.delete(insertId);
      statuses.set(insertId, insertStatus);
      if (statuses.size > REMEMBERED_INSERT_STATUSES) {
        const oldestInsertId = statuses.keys().next().value;
        if (oldestInsertId !== undefined) {
          statuses.delete(oldestInsertId);
        }
      }
      return true;
    };

    const handleEvent = (msg: ServerEvent) => {
      if (!msg.kind) {
        return;
      }

      // Not about any session: every chat re-syncs the session it shows.
      if (msg.kind === 'websocket_reconnected') {
        onWebSocketReconnect?.();
        return;
      }

      // A gateway frame for run-notifications, which announces the run's end;
      // it is no transcript row, so no chat stores it.
      if (msg.kind === 'run_ended') {
        return;
      }

      const activeViewSessionId = activeViewSessionIdRef.current;
      const frameSessionId = typeof msg.sessionId === 'string' && msg.sessionId ? msg.sessionId : null;
      // A frame that names no session (a request the server rejected before it
      // knew the session) belongs to the session on screen, but only in the
      // focused pane: an unfocused one would file it under its own session and
      // idle that session too.
      if (!frameSessionId && !isFocusedPaneRef.current) {
        return;
      }
      const sid = frameSessionId ?? activeViewSessionId;

      // Whether this frame may be written into the store. A sequenced frame of
      // a run this chat has not followed from its start is not: its effects on
      // the page (activity, prompts, sounds) still run, and the replay this
      // chat's own subscribe asks for delivers it again, in order.
      let storesFrame = true;
      if (sid && typeof msg.seq === 'number') {
        if (!followedRunsRef.current.has(sid)) {
          if (msg.seq === (replayStartSeqRef.current.get(sid) ?? 1)) {
            // The run's first frame: its live start, or a replay from scratch.
            followedRunsRef.current.add(sid);
            replayStartSeqRef.current.delete(sid);
          } else {
            storesFrame = false;
          }
        }

        if (storesFrame) {
          // A replay of a frame already handled. Keyed by both: agy and
          // OpenCode stream every delta of a part under one id, each with its
          // own seq, and every run counts seq from 1 again.
          if (typeof msg.id === 'string' && msg.id && !rememberHandledFrame(sid, `${msg.seq}:${msg.id}`)) {
            return;
          }

          // Record replay progress: this frame's seq. A frame numbered at or
          // below the record is no replay (those were dropped above) but a
          // later run's, which counts from 1 again, so the record starts over
          // from it: kept at the earlier run's number, a reconnect would skip
          // whatever this run streams up to that number. The background work
          // of the run that ended last records nothing (see endedRunSeqRef).
          const endedRunSeq = endedRunSeqRef.current.get(sid);
          if (endedRunSeq === undefined || msg.seq <= endedRunSeq) {
            endedRunSeqRef.current.delete(sid);
            lastSeqRef.current.set(sid, msg.seq);
          }
        }
      }

      switch (msg.kind) {
        case 'history_truncated': {
          // An already-sent message was replaced. Every client watching this
          // session drops the superseded turns before the replacement streams
          // in, so a second tab does not end up showing the question twice.
          if (sid && storesFrame && typeof msg.anchorId === 'string') {
            sessionStore.truncateAt(sid, msg.anchorId);
          }
          return;
        }

        case 'chat_subscribed': {
          // Ack for chat.subscribe: authoritative processing state plus any
          // pending tool-permission prompts for the run.
          if (!sid) return;

          if (msg.isProcessing) {
            onSessionProcessing?.(sid);
            if (!followedRunsRef.current.has(sid)) {
              // A replay follows this ack, from the run's first frame the
              // server still buffers: its last REPLAY_FRAME_KEYS_PER_SESSION.
              const runLastSeq = typeof msg.lastSeq === 'number' ? msg.lastSeq : 0;
              replayStartSeqRef.current.set(sid, Math.max(1, runLastSeq - REPLAY_FRAME_KEYS_PER_SESSION + 1));
            }
          } else {
            // Idle ack: ignore it if a newer request started after the
            // subscribe was sent — the ack describes the older state.
            onSessionIdle?.(sid, {
              ifStartedBefore: statusCheckSentAtRef.current.get(sid),
            });
            // Acks come after every frame sent before them, so whatever this
            // chat holds of the session belongs to a run that is over, and any
            // frame from here on starts the next run or is the background work
            // of the one that ended: either can be stored as it comes.
            forgetFinishedRun(sid);
            followedRunsRef.current.add(sid);
            replayStartSeqRef.current.delete(sid);
            // A run the server still holds has numbered its frames up to the
            // ack's lastSeq; any it numbers after are its background work.
            if (typeof msg.lastSeq === 'number' && msg.lastSeq > 0) {
              endedRunSeqRef.current.set(sid, msg.lastSeq);
            }
            // No run is going on, so an insert sent before this subscribe has
            // ended, whether or not this page heard how.
            onInsertRunEnded?.(sid, statusCheckSentAtRef.current.get(sid) ?? null);
          }

          const isViewedSession = sid === activeViewSessionId;
          if (isViewedSession && Array.isArray(msg.pendingPermissions)) {
            const nextPendingPermissionRequests = msg.pendingPermissions as PendingPermissionRequest[];
            const hadActionablePermissionRequests = hasActionablePermissionRequests(pendingPermissionRequestsRef.current);
            const hasPendingActionablePermissionRequests = hasActionablePermissionRequests(nextPendingPermissionRequests);

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);

            if (hasPendingActionablePermissionRequests && !hadActionablePermissionRequests) {
              // Every request is claimed under the key its own frame uses, so
              // the replayed `permission_request` that follows this ack, or the
              // other pane hearing it, does not sound again.
              const claims = nextPendingPermissionRequests
                .filter((request) => isActionablePermissionRequest(request))
                .map((request) => claimPageEffect(`perm:${sid}:${request.requestId}`));
              if (claims.includes(true)) {
                void playNotificationSound();
              }
            }
          }
          return;
        }

        // The answer to this page's own `chat.send`, before any run began: no
        // seq, nothing to store, and the session is left as it was. Only the
        // composer that sent the message acts on it.
        case 'send_refused': {
          if (frameSessionId) {
            onSendRefused?.({
              sessionId: frameSessionId,
              reason: typeof msg.reason === 'string' ? msg.reason : '',
              changes: Array.isArray(msg.changes)
                ? msg.changes.filter((change): change is string => typeof change === 'string')
                : [],
            });
          }
          return;
        }

        case 'protocol_error': {
          console.error('[Chat] Protocol error:', msg.code, msg.error);
          if (sid) {
            // Surface the failure in the conversation and stop the spinner —
            // the run never started (or was rejected), so no `complete` follows.
            // A refused stop request is not about the run: the task had
            // already settled, and idling here would drop a response in
            // flight on that session.
            if (msg.code !== 'NO_SUCH_TASK' && msg.code !== 'TASK_ID_REQUIRED') {
              onSessionIdle?.(sid);
            }
            sessionStore.appendRealtime(sid, {
              id: `protocol_error_${Date.now()}`,
              sessionId: sid,
              timestamp: new Date().toISOString(),
              provider,
              kind: 'error',
              content: String(msg.error || 'Request failed'),
            } as NormalizedMessage);
          }
          return;
        }

        // Sidebar/global events — owned by useProjectsState, whose reload of
        // the viewed transcript skips a busy session: a run CloudCLI drives
        // streams its rows here live. A turn the Claude CLI drives outside
        // CloudCLI streams nothing, so its transcript on disk is the only
        // source; reload it as the CLI writes it (the refresh coordinator
        // folds a burst of writes into one trailing reload).
        case 'session_upserted': {
          const upsertedSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null;
          if (
            upsertedSessionId
            && upsertedSessionId === activeViewSessionId
            && isCliDrivenActivity(getSessionActivity?.(upsertedSessionId))
          ) {
            void requestLatestMessages(upsertedSessionId);
          }
          return;
        }
        case 'loading_progress':
          return;

        default:
          break;
      }

      /* -------------------------------------------------------------- */
      /*  Provider NormalizedMessage handling                            */
      /* -------------------------------------------------------------- */

      // --- Streaming: buffered per session for performance ---
      // Every session, on screen or not, streams into its own buffer, flushed
      // into its store row at most every 100 ms, so a session the user opens
      // mid-stream shows everything streamed so far in one row.
      if (msg.kind === 'stream_delta') {
        const text = (msg.content as string) || '';
        if (!text || !sid || !storesFrame) return;
        const buffer = streamBuffersRef.current.get(sid) ?? { text: '', timer: null, lastSeq: null };
        streamBuffersRef.current.set(sid, buffer);
        if (typeof msg.seq === 'number') {
          if (buffer.lastSeq !== null && msg.seq <= buffer.lastSeq) {
            // A later run, while the buffer still holds text of a run whose
            // end the socket was away for: that text is no part of this reply.
            buffer.text = '';
          }
          buffer.lastSeq = msg.seq;
        }
        buffer.text += text;
        if (buffer.timer === null) {
          buffer.timer = window.setTimeout(() => {
            buffer.timer = null;
            sessionStore.updateStreaming(sid, buffer.text, provider);
          }, 100);
        }
        return;
      }

      if (msg.kind === 'stream_end') {
        if (sid && storesFrame) {
          flushStreamBuffer(sid);
          sessionStore.finalizeStreaming(sid);
        }
        return;
      }

      // --- All other messages: route to store ---
      // An insert's status is no transcript row: the card above the composer
      // shows a pending insert, and the message itself arrives as a `text`.
      const shouldPersist =
        msg.kind !== 'complete'
        && msg.kind !== 'status'
        && msg.kind !== 'permission_request'
        && msg.kind !== 'permission_resolved'
        && msg.kind !== 'permission_cancelled'
        && msg.kind !== 'insert_status';

      if (sid && shouldPersist && storesFrame) {
        sessionStore.appendRealtime(sid, msg as unknown as NormalizedMessage);
      }

      // --- UI side effects for specific kinds ---
      switch (msg.kind) {
        case 'complete': {
          if (sid && storesFrame) {
            // Flush what the session still has buffered.
            if (flushStreamBuffer(sid)) {
              sessionStore.finalizeStreaming(sid);
            }
            // The server replays only a running run, so nothing of this one
            // can arrive again: its frame keys go, and its seq, which would
            // ask a reconnect during the next run (two runs in a row send no
            // subscribe in between) for frames past this one's end.
            handledFrameKeysRef.current.delete(sid);
            lastSeqRef.current.delete(sid);
            if (typeof msg.seq === 'number') {
              endedRunSeqRef.current.set(sid, msg.seq);
            }
          } else if (sid) {
            // Not followed: the session's next run starts at seq 1 again.
            replayStartSeqRef.current.delete(sid);
          }

          // `complete` is the unified terminal event — every provider run ends
          // with exactly one, regardless of success, failure, or abort. The
          // indicator derives from the processing map, so the entry changes
          // immediately and atomically: a turn that ended with tasks still
          // running leaves the session as background work — the CLI is held
          // open for them — and any other leaves it idle. An abort releases
          // the CLI and takes that work down with it.
          if (sid && !msg.aborted) {
            reportRemainingBackgroundWork(sid);
          } else {
            onSessionIdle?.(sid);
          }
          if (sid === activeViewSessionId) {
            pendingPermissionRequestsRef.current = [];
            setPendingPermissionRequests([]);
          }
          // A turn's `complete` waits for every insert it took to end, so
          // none of them reports anything after it.
          if (sid) {
            onInsertRunEnded?.(sid, null);
          }

          if (msg.aborted) {
            // Abort was requested — the complete event confirms it. No
            // further UI action is needed beyond clearing the entry above.
            break;
          }

          // The session id is stable for the whole conversation (allocated
          // before the first send), so the only follow-up is syncing the
          // viewed conversation with the now-persisted transcript.
          if (sid && sid === activeViewSessionId) {
            void requestLatestMessages(sid, isActiveRef.current);
          }

          break;
        }

        // 'error' is an informational message row, not a terminal event —
        // providers emit it for mid-run stderr output too. Run teardown is
        // always signalled by the unified 'complete' that follows.

        case 'permission_request': {
          if (!msg.requestId) break;
          // One sound per request on the page, shared with the subscribe ack
          // that may have announced it already.
          if (
            isActionablePermissionRequest({ toolName: msg.toolName })
            && claimPageEffect(`perm:${sid}:${String(msg.requestId)}`)
          ) {
            void playNotificationSound();
          }

          if (sid === activeViewSessionId) {
            const previousPendingPermissionRequests = pendingPermissionRequestsRef.current;
            if (!previousPendingPermissionRequests.some((request) => request.requestId === msg.requestId)) {
              const nextPendingPermissionRequests = [...previousPendingPermissionRequests, {
                requestId: msg.requestId as string,
                toolName: (msg.toolName as string) || 'UnknownTool',
                input: msg.input,
                context: msg.context,
                sessionId: sid || null,
                receivedAt: new Date(),
              }];

              pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
              setPendingPermissionRequests(nextPendingPermissionRequests);
            }
          }
          if (sid) {
            onSessionProcessing?.(sid);
          }
          break;
        }

        // `permission_resolved` arrives when any client answers the prompt: it
        // retracts a replayed `permission_request` after a mid-run refresh and
        // clears the prompt in other tabs watching the same run.
        case 'permission_resolved':
        case 'permission_cancelled': {
          if (msg.requestId && sid === activeViewSessionId) {
            const nextPendingPermissionRequests = pendingPermissionRequestsRef.current.filter(
              (request: PendingPermissionRequest) => request.requestId !== msg.requestId,
            );

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);
          }
          break;
        }

        case 'status': {
          if (msg.text === 'token_budget' && msg.tokenBudget) {
            // The counter shows the viewed session's context; budgets from
            // other concurrently running sessions must not overwrite it.
            if (sid === activeViewSessionId) {
              setTokenBudget(msg.tokenBudget as Record<string, unknown>);
            }
          } else if (msg.text && sid) {
            onSessionProcessing?.(sid, {
              statusText: msg.text as string,
              canInterrupt: msg.canInterrupt !== false,
            });
          }
          break;
        }

        case 'task_status': {
          // A task's notification, or the patch that killed it, can leave a
          // session that was only doing background work with nothing left
          // to do. A turn in flight is left alone: its `complete` reports.
          if (
            sid
            && (msg.event === 'notification' || msg.event === 'updated')
            && getSessionActivity?.(sid)?.background
          ) {
            reportRemainingBackgroundWork(sid);
          }
          // The notification carries only a summary; the task's actual result
          // is folded onto its card by the history reader, so a card that
          // just settled live shows it only after a sync — the same sync a
          // turn's `complete` triggers. Without it the result waited for a
          // manual reload.
          if (sid && sid === activeViewSessionId && msg.event === 'notification') {
            void requestLatestMessages(sid, isActiveRef.current);
          }
          break;
        }

        // Handled whether or not this chat stores the run's frames: the
        // replay its own subscribe asks for repeats them, which the status
        // record drops.
        case 'insert_status': {
          const insertId = typeof msg.insertId === 'string' ? msg.insertId : '';
          const insertStatus = readInsertStatus(msg.insertStatus);
          if (!insertId || !insertStatus || !rememberInsertStatus(insertId, insertStatus)) {
            break;
          }
          onInsertStatus?.({
            sessionId: sid,
            insertId,
            insertStatus,
            content: typeof msg.content === 'string' ? msg.content : '',
            ...(typeof msg.insertReason === 'string' && msg.insertReason ? { insertReason: msg.insertReason } : {}),
          });
          break;
        }

        // text, tool_use, tool_result, thinking, task_notification
        // → already routed to store above, no UI side effects needed
        default:
          break;
      }
    };

    return subscribe(handleEvent);
  }, [
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
    onWebSocketReconnect,
    onInsertStatus,
    onInsertRunEnded,
    onSendRefused,
    requestLatestMessages,
    sessionStore,
  ]);
}
