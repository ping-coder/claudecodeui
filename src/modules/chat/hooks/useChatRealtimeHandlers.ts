import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ServerEvent,MarkSessionIdle,MarkSessionProcessing,PendingPermissionRequest,ProjectSession,LLMProvider,NormalizedMessage,GetSessionActivity,MarkSessionBackground } from '@/shared/types';
import { showCompletionTitleIndicator } from '@/modules/chat/utils/pageTitleNotification';
import { playChatCompletionSound, playNotificationSound } from '@/shared/utils';
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

type UseChatRealtimeHandlersArgs = {
  isActive: boolean;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  pendingPermissionRequests: PendingPermissionRequest[];
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  streamTimerRef: MutableRefObject<number | null>;
  accumulatedStreamRef: MutableRefObject<string>;
  /**
   * Highest live `seq` observed per session. Essential for reconnect catch-up:
   * `chat.subscribe` sends this value as `lastSeq` so the server replays only
   * the events this client actually missed. Written here on every sequenced
   * frame; read wherever a `chat.subscribe` is sent (session open, reconnect).
   */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  /** Reports the tasks a session still runs once its turn ends, so it reads as background work rather than idle. */
  onSessionBackground?: MarkSessionBackground;
  getSessionActivity?: GetSessionActivity;
  onWebSocketReconnect?: () => void;
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
 */
export function useChatRealtimeHandlers({
  isActive,
  subscribe,
  provider,
  selectedSession,
  currentSessionId,
  setTokenBudget,
  pendingPermissionRequests,
  setPendingPermissionRequests,
  streamTimerRef,
  accumulatedStreamRef,
  lastSeqRef,
  statusCheckSentAtRef,
  onSessionProcessing,
  onSessionIdle,
  onSessionBackground,
  getSessionActivity,
  onWebSocketReconnect,
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
    // from, so this reads the same answer they draw.
    const reportRemainingBackgroundWork = (sid: string) => {
      onSessionBackground?.(sid, collectRunningBackgroundTasks(normalizedToChatMessages(sessionStore.getMessages(sid))));
    };

    const handleEvent = (msg: ServerEvent) => {
      if (!msg.kind) {
        return;
      }

      const activeViewSessionId = activeViewSessionIdRef.current;
      const sid = (typeof msg.sessionId === 'string' && msg.sessionId) || activeViewSessionId;

      // Record replay progress for every sequenced live event.
      if (sid && typeof msg.seq === 'number') {
        const known = lastSeqRef.current.get(sid) ?? 0;
        if (msg.seq > known) {
          lastSeqRef.current.set(sid, msg.seq);
        }
      }

      switch (msg.kind) {
        case 'websocket_reconnected':
          onWebSocketReconnect?.();
          return;

        case 'history_truncated': {
          // An already-sent message was replaced. Every client watching this
          // session drops the superseded turns before the replacement streams
          // in, so a second tab does not end up showing the question twice.
          if (sid && typeof msg.anchorId === 'string') {
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
          } else {
            // Idle ack: ignore it if a newer request started after the
            // subscribe was sent — the ack describes the older state.
            onSessionIdle?.(sid, {
              ifStartedBefore: statusCheckSentAtRef.current.get(sid),
            });
          }

          const isViewedSession = sid === activeViewSessionId;
          if (isViewedSession && Array.isArray(msg.pendingPermissions)) {
            const nextPendingPermissionRequests = msg.pendingPermissions as PendingPermissionRequest[];
            const hadActionablePermissionRequests = hasActionablePermissionRequests(pendingPermissionRequestsRef.current);
            const hasPendingActionablePermissionRequests = hasActionablePermissionRequests(nextPendingPermissionRequests);

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);

            if (hasPendingActionablePermissionRequests && !hadActionablePermissionRequests) {
              void playNotificationSound();
            }
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

      // --- Streaming: buffer for performance ---
      if (msg.kind === 'stream_delta') {
        const text = (msg.content as string) || '';
        if (!text) return;
        accumulatedStreamRef.current += text;
        if (!streamTimerRef.current) {
          streamTimerRef.current = window.setTimeout(() => {
            streamTimerRef.current = null;
            if (sid) {
              sessionStore.updateStreaming(sid, accumulatedStreamRef.current, provider);
            }
          }, 100);
        }
        // Also route to store for non-active sessions
        if (sid && sid !== activeViewSessionId) {
          sessionStore.appendRealtime(sid, msg as unknown as NormalizedMessage);
        }
        return;
      }

      if (msg.kind === 'stream_end') {
        if (streamTimerRef.current) {
          clearTimeout(streamTimerRef.current);
          streamTimerRef.current = null;
        }
        if (sid) {
          if (accumulatedStreamRef.current) {
            sessionStore.updateStreaming(sid, accumulatedStreamRef.current, provider);
          }
          sessionStore.finalizeStreaming(sid);
        }
        accumulatedStreamRef.current = '';
        return;
      }

      // --- All other messages: route to store ---
      const shouldPersist =
        msg.kind !== 'complete'
        && msg.kind !== 'status'
        && msg.kind !== 'permission_request'
        && msg.kind !== 'permission_resolved'
        && msg.kind !== 'permission_cancelled';

      if (sid && shouldPersist) {
        sessionStore.appendRealtime(sid, msg as unknown as NormalizedMessage);
      }

      // --- UI side effects for specific kinds ---
      switch (msg.kind) {
        case 'complete': {
          // Flush any remaining streaming state
          if (streamTimerRef.current) {
            clearTimeout(streamTimerRef.current);
            streamTimerRef.current = null;
          }
          if (sid && accumulatedStreamRef.current) {
            sessionStore.updateStreaming(sid, accumulatedStreamRef.current, provider);
            sessionStore.finalizeStreaming(sid);
          }
          accumulatedStreamRef.current = '';

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

          if (msg.aborted) {
            // Abort was requested — the complete event confirms it. No
            // further UI action is needed beyond clearing the entry above.
            break;
          }

          // Celebrate only successful runs (failed runs end with success: false).
          if (msg.success !== false) {
            showCompletionTitleIndicator();
            void playChatCompletionSound();
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
          if (isActionablePermissionRequest({ toolName: msg.toolName })) {
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
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onSessionBackground,
    getSessionActivity,
    onWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
  ]);
}
