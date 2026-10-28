import { sessionsDb } from '@/modules/database/index.js';
import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import { broadcastSessionUpserted } from '@/modules/websocket/services/session-upsert-broadcast.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type {
  LLMProvider,
  NormalizedMessage,
  RealtimeClientConnection,
  RunEndedEvent,
  RunEndOutcome,
} from '@/shared/types.js';

type ChatRunStatus = 'running' | 'completed';

/**
 * One live (or recently finished) provider run for a single app session.
 *
 * State notes — why each mutable field is essential:
 * - `providerSessionId`: the provider-native id captured mid-run. The abort
 *   handler needs it to address the provider runtime, and the DB mapping is
 *   written from it so history/resume work after the run.
 * - `status`: drives `chat_subscribed.isProcessing`, prevents double sends
 *   into the same session, and guards the synthetic-complete fallback in the
 *   chat handler (only emitted when a runtime died without completing).
 * - `lastSeq` / `events`: the per-run event log. Every live event gets a
 *   monotonically increasing `seq` and is buffered so a reconnecting client
 *   can replay exactly the events it missed via `chat.subscribe`.
 */
type ChatRun = {
  appSessionId: string;
  provider: LLMProvider;
  providerSessionId: string | null;
  status: ChatRunStatus;
  lastSeq: number;
  events: NormalizedMessage[];
  writer: ChatSessionWriter;
  startedAt: number;
  completedAt: number | null;
};

/**
 * How long a completed run stays available for replay. Covers the window
 * between a run finishing and the client refreshing history over REST (for
 * example when the browser tab was asleep while the run completed).
 */
const COMPLETED_RUN_RETENTION_MS = 5 * 60 * 1000;

/**
 * Upper bound on buffered events per run so a very long tool-heavy run cannot
 * grow memory unbounded. When exceeded, the oldest events are dropped —
 * a reconnecting client whose `lastSeq` predates the buffer falls back to a
 * REST history refresh, which is always the authoritative source.
 */
const MAX_BUFFERED_EVENTS_PER_RUN = 5000;

/**
 * How long a run's end stays listed for GET /api/providers/sessions/run-ends.
 * A tab whose socket dropped (laptop asleep, network change) reads the list
 * once it reconnects and catches up on the ends it missed in this window.
 */
const RECENT_RUN_ENDS_RETENTION_MS = 10 * 60 * 1000;

/**
 * Upper bound on listed run ends, so a burst of short runs cannot grow the
 * list without limit. When exceeded, the oldest ends are dropped first.
 */
const MAX_RECENT_RUN_ENDS = 200;

/**
 * Active and recently-completed runs keyed by app session id.
 *
 * This map is the single in-memory source of truth for "is something running
 * for this session" — the chat websocket handler, abort path, and subscribe
 * path all consult it instead of asking each provider runtime individually.
 */
const runs = new Map<string, ChatRun>();

/**
 * Every `run_ended` broadcast in the last RECENT_RUN_ENDS_RETENTION_MS, at most
 * MAX_RECENT_RUN_ENDS, oldest first: each end is appended as it is recorded.
 * Pruned on every write and read; lives only in memory, so a server restart
 * empties it.
 */
let recentRunEnds: RunEndedEvent[] = [];

/**
 * Answers whether a completed run must stay registered a while longer. Set by
 * the composition root to the provider runtimes' background-work check: a
 * session whose turn ended but whose agents, workflows or commands are still
 * running keeps sending live events through this run's writer, and a tab that
 * subscribes meanwhile needs the run to attach to.
 */
let retainCompletedRun: (appSessionId: string) => boolean = () => false;

/**
 * Schedules one run's eviction. The timer is bound to the run it was armed
 * for: a later run can take the session's slot while this one's retention —
 * re-armed for as long as the guard holds — is still pending, and firing on
 * the slot alone would evict that newer run early.
 */
function evictRunLater(run: ChatRun): void {
  const timer = setTimeout(() => {
    if (runs.get(run.appSessionId) !== run || run.status !== 'completed') {
      return;
    }
    if (retainCompletedRun(run.appSessionId)) {
      evictRunLater(run);
      return;
    }
    runs.delete(run.appSessionId);
  }, COMPLETED_RUN_RETENTION_MS);

  // Never keep the process alive just to evict a buffered run.
  timer.unref?.();
}

/**
 * Reads how a turn ended from its terminal `complete`. An abort wins, then
 * `success`, which `createCompleteMessage` always sets, then a numeric
 * `exitCode`. A `complete` with neither — Codex sends its live
 * `turn_complete` that way, ahead of its own `createCompleteMessage` — is
 * `done`, as the chat client has always read it (only `success === false`
 * counts as failed there).
 */
function readRunEndOutcome(message: NormalizedMessage): RunEndOutcome {
  if (message.aborted === true) {
    return 'aborted';
  }
  if (typeof message.success === 'boolean') {
    return message.success ? 'done' : 'failed';
  }
  if (typeof message.exitCode === 'number') {
    return message.exitCode === 0 ? 'done' : 'failed';
  }
  return 'done';
}

/**
 * The session's custom name for a `run_ended` frame. The lookup runs inside
 * the writer while the terminal `complete` is on its way out, so a failing
 * read must not throw: the end goes out unnamed rather than taking the
 * `complete` down with it.
 */
function readSessionName(run: ChatRun): string | null {
  try {
    return sessionsDb.getSessionName(run.appSessionId, run.provider)?.trim() || null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[ChatRunRegistry] Failed to read the session name for run_ended', {
      appSessionId: run.appSessionId,
      error: message,
    });
    return null;
  }
}

/** Drops ends older than the retention window, then all but the newest MAX_RECENT_RUN_ENDS. */
function pruneRecentRunEnds(now: number): void {
  const cutoff = now - RECENT_RUN_ENDS_RETENTION_MS;
  recentRunEnds = recentRunEnds.filter((end) => end.endedAt >= cutoff).slice(-MAX_RECENT_RUN_ENDS);
}

/**
 * Records one end of `run` and broadcasts it as `run_ended` to every open
 * chat socket, whether or not it watches the run: other tabs and devices
 * raise their own alerts from it.
 *
 * The list entry is written at once, so the run-ends route has it as soon as
 * it happened. The broadcast waits a microtask: a turn's end is recorded
 * while its `complete` is being decorated, before the writer forwards it,
 * and the run's own listeners must get that `complete` first.
 */
function recordRunEnded(run: ChatRun, outcome: RunEndOutcome, backgroundWork: boolean): void {
  const endedAt = Date.now();
  const event: RunEndedEvent = {
    kind: 'run_ended',
    sessionId: run.appSessionId,
    provider: run.provider,
    runStartedAt: run.startedAt,
    endedAt,
    outcome,
    backgroundWork,
    sessionName: readSessionName(run),
    timestamp: new Date(endedAt).toISOString(),
  };

  recentRunEnds.push(event);
  pruneRecentRunEnds(endedAt);

  const payload = JSON.stringify(event);
  queueMicrotask(() => {
    for (const client of connectedClients) {
      if (client.readyState !== WS_OPEN_STATE) {
        continue;
      }
      // A throw inside a microtask is an uncaught exception, and one broken
      // socket must not keep the end from the others.
      try {
        client.send(payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ChatRunRegistry] Failed to send run_ended', {
          appSessionId: run.appSessionId,
          error: message,
        });
      }
    }
  });
}

/**
 * Decorates one outbound live event for a run and records it in the event log.
 *
 * Responsibilities:
 * 1. Remap `sessionId` (and `actualSessionId` on `complete`) to the stable
 *    app session id — provider-native ids never leave the backend.
 * 2. Assign the next `seq` so clients can detect/replay gaps.
 * 3. Buffer the event for `chat.subscribe` replay.
 * 4. Flip the run to `completed` when the terminal `complete` event passes by,
 *    and record the run's end for every connected tab.
 */
function decorateAndRecordEvent(run: ChatRun, message: NormalizedMessage): NormalizedMessage | null {
  // Exactly-one-complete contract: when a run is aborted the chat handler
  // emits the terminal `complete` immediately, but the killed runtime may
  // still emit its own `complete` from its exit handler moments later.
  // Whichever arrives first wins; the duplicate is dropped here.
  if (message.kind === 'complete' && run.status === 'completed') {
    return null;
  }

  run.lastSeq += 1;

  const outbound: NormalizedMessage = {
    ...message,
    sessionId: run.appSessionId,
    seq: run.lastSeq,
  };

  if (message.kind === 'complete') {
    // The provider may report its own id here; the frontend only ever knows
    // the app id, so the "actual" id is by definition the app id as well.
    outbound.actualSessionId = run.appSessionId;
    run.status = 'completed';
    run.completedAt = Date.now();
    evictRunLater(run);

    // Only the first `complete` gets here (a duplicate returned above), so
    // each turn ends exactly once. Background work is asked about now, as the
    // turn ends: the runtime has already counted the tasks this turn started.
    const outcome = readRunEndOutcome(message);
    recordRunEnded(run, outcome, outcome === 'done' && retainCompletedRun(run.appSessionId));
  }

  run.events.push(outbound);
  if (run.events.length > MAX_BUFFERED_EVENTS_PER_RUN) {
    run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS_PER_RUN);
  }

  return outbound;
}

/**
 * Records the provider-native session id for a run and persists the
 * app-id-to-provider-id mapping so history fetches and future resumes can
 * address the provider transcript.
 *
 * Called from the gateway writer when the runtime either calls
 * `setSessionId(...)` or emits its `session_created` event — whichever
 * happens first wins; later calls with the same id are no-ops.
 */
function recordProviderSessionId(run: ChatRun, providerSessionId: string): void {
  if (!providerSessionId || run.providerSessionId === providerSessionId) {
    return;
  }

  run.providerSessionId = providerSessionId;

  try {
    sessionsDb.assignProviderSessionId(run.appSessionId, providerSessionId);
    void broadcastSessionUpserted(run.appSessionId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ChatRunRegistry] Failed to broadcast canonical session mapping', {
        appSessionId: run.appSessionId,
        providerSessionId,
        error: message,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ChatRunRegistry] Failed to persist provider session id mapping', {
      appSessionId: run.appSessionId,
      providerSessionId,
      error: message,
    });
  }
}

/**
 * Registry of live provider runs keyed by the stable app session id.
 *
 * The registry is what makes the websocket protocol provider-independent:
 * every run gets a `ChatSessionWriter` that remaps provider-native session
 * ids to the app id, assigns `seq` numbers, and buffers events for replay —
 * regardless of which provider runtime produced them.
 */
export const chatRunRegistry = {
  /** Installs the check that keeps a completed run registered while its session still has background work. */
  setRetentionGuard(guard: (appSessionId: string) => boolean): void {
    retainCompletedRun = guard;
  },

  /**
   * Starts tracking a run and returns it, or `null` when a run is already in
   * progress for the session (callers must reject the duplicate send).
   */
  startRun(input: {
    appSessionId: string;
    provider: LLMProvider;
    providerSessionId: string | null;
    /**
     * The socket that asked for this run, or `null` for one nobody is watching
     * — a scheduled message fires with no browser attached. The writer's event
     * buffer still records everything, so a client that subscribes later
     * replays the run from its start.
     */
    connection: RealtimeClientConnection | null;
    userId: string | number | null;
  }): ChatRun | null {
    const existing = runs.get(input.appSessionId);
    if (existing && existing.status === 'running') {
      return null;
    }

    const run: ChatRun = {
      appSessionId: input.appSessionId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      status: 'running',
      lastSeq: 0,
      events: [],
      writer: null as unknown as ChatSessionWriter,
      startedAt: Date.now(),
      completedAt: null,
    };

    run.writer = new ChatSessionWriter({
      connection: input.connection,
      userId: input.userId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      onProviderSessionId: (providerSessionId) => {
        recordProviderSessionId(run, providerSessionId);
      },
      decorateOutboundEvent: (message) => decorateAndRecordEvent(run, message),
      onBackgroundWorkFinished: () => {
        // Only news about a turn that has ended and still is the session's
        // latest run counts. A newer run in the slot stopped this run's work
        // when it started, so a late report from it is stale. An empty slot
        // still counts: eviction only asks whether tasks are outstanding, and
        // the follow-up turn that reports the last of them can outlast that.
        const current = runs.get(run.appSessionId);
        if (run.status === 'completed' && (current === undefined || current === run)) {
          recordRunEnded(run, 'backgroundDone', false);
        }
      },
    });

    runs.set(input.appSessionId, run);
    return run;
  },

  getRun(appSessionId: string): ChatRun | undefined {
    return runs.get(appSessionId);
  },

  isProcessing(appSessionId: string): boolean {
    return runs.get(appSessionId)?.status === 'running';
  },

  listRunningRuns(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
  }> {
    return Array.from(runs.values())
      .filter((run) => run.status === 'running')
      .map((run) => ({
        sessionId: run.appSessionId,
        provider: run.provider,
        startedAt: run.startedAt,
        lastSeq: run.lastSeq,
      }));
  },

  /**
   * Adds a websocket connection to a run's live audience.
   *
   * This is the generic replacement for the Claude-only writer reconnect:
   * after a page refresh the new socket subscribes and immediately starts
   * receiving the still-running stream, for every provider.
   *
   * Subscribing does not take the stream away from sockets that were already
   * watching — a session open in two places stays live in both, and the
   * refreshed tab's abandoned socket is dropped when the next event finds it
   * closed. Replay stays per-connection because each client sends its own
   * `lastSeq` with `chat.subscribe`.
   */
  attachConnection(appSessionId: string, connection: RealtimeClientConnection): boolean {
    const run = runs.get(appSessionId);
    if (!run) {
      return false;
    }

    run.writer.updateWebSocket(connection);
    return true;
  },

  /**
   * Returns buffered events with `seq` greater than `afterSeq` for replay.
   *
   * An empty array with `run.lastSeq > afterSeq` not covered by the buffer
   * means the buffer was truncated; the client should refresh over REST.
   */
  replayEvents(appSessionId: string, afterSeq: number): NormalizedMessage[] {
    const run = runs.get(appSessionId);
    if (!run) {
      return [];
    }

    return run.events.filter((event) => typeof event.seq === 'number' && event.seq > afterSeq);
  },

  /**
   * Emits a synthetic terminal `complete` if (and only if) the run is still
   * marked running. Used when a provider runtime throws or resolves without
   * having produced its own terminal event, and by the abort path.
   */
  completeRun(appSessionId: string, opts: { exitCode: number; aborted?: boolean }): void {
    const run = runs.get(appSessionId);
    if (!run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Safety-net variant of `completeRun` scoped to one specific run: a no-op
   * unless `run` is still the session's current, running run. A runtime
   * promise can resolve after its own `complete` already streamed AND a new
   * run has replaced it in the registry (a queued message sends within
   * milliseconds of the previous turn ending) — the session-keyed
   * `completeRun` would terminate that newer run.
   */
  completeRunIfCurrent(run: ChatRun, opts: { exitCode: number; aborted?: boolean }): void {
    if (runs.get(run.appSessionId) !== run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Run ends broadcast in the last 10 minutes (at most 200), oldest first, as
   * the `run_ended` frames that went out. Used by the providers module's
   * sessions service for GET /api/providers/sessions/run-ends, which a tab
   * reads on mount and after a reconnect to catch up on ends it missed.
   * Returns a copy; callers cannot change the list.
   */
  listRecentRunEnds(): RunEndedEvent[] {
    pruneRecentRunEnds(Date.now());
    return [...recentRunEnds];
  },

  /**
   * Test-only escape hatch: clears every tracked run and every recorded end.
   */
  clearAll(): void {
    runs.clear();
    recentRunEnds = [];
  },
};
