import type {
  AnyRecord,
  BackgroundTaskSummary,
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  McpScope,
  NormalizedMessage,
  PausedScheduledWork,
  ProviderSkill,
  ProviderSkillListOptions,
  ProviderAuthStatus,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderMcpServer,
  ProviderSkillCreateInput,
  ProviderSkillRemoveInput,
  ProviderCancelInsertResult,
  ProviderHandOverPlan,
  ProviderHandOverPlanOptions,
  ProviderInsertInput,
  ProviderInsertResult,
  ProviderProcessState,
  ProviderRuntimeContext,
  ProviderRuntimePermissionGateway,
  ProviderRuntimeWriter,
  RevivedCronJob,
  ScheduledWorkStopOptions,
  ScheduledWorkStopResult,
  ScheduledWorkSummary,
  UpsertProviderMcpServerInput,
  WorkflowAgentActivity,
} from '@/shared/types.js';

//----------------- PROVIDER CONTRACT INTERFACES ------------

/**
 * Live execution contract implemented by each provider SDK/CLI adapter.
 *
 * The provider registry owns this adapter as one facet of `IProvider`; runtime
 * execution context is supplied by the application service at call time.
 */
export interface IProviderRuntime {
  /**
   * Runs one turn of a session, reporting through `writer`, and resolves
   * when the runtime is done with the process it ran in. A runtime that keeps
   * its process open past a turn for background work may run the session's
   * next turn in that process instead of a new one, keeping the work going
   * (Claude); that call resolves once its own turn is over. Options that set
   * `inheritUnset: true` or `acceptProcessSettings: true` hand the turn over
   * the way `planHandOver` plans it with that option (see
   * `ProviderHandOverPlanOptions`); a turn with `acceptProcessSettings: true`
   * that the held process does not take fails (HAND_OVER_FAILED) rather
   * than replace that process. Options that set
   * `restoreSwitchesAfterTurn: true` keep the model and permission mode such a
   * turn switches the process to (see `HandOverSwitch`) for that turn alone:
   * the process is switched back once the turn is over, completed or
   * stopped, and a turn the CLI runs on its own meanwhile runs without them.
   * Their `onSwitchesRestored`, a callback the chat gateway sets to put the
   * session's recorded model back, hears `{ model, permissionMode }` once such
   * a turn is over, however it ended (stopped before it switched anything
   * included), and the CLI has answered the switches back: for each one the
   * turn was to switch, what the process runs with then, null for the others;
   * it is not called when the process lets go after the turn, nor for a turn
   * that started a process of its own. A turn the held process cannot take
   * while it is held for cron jobs alone that a resumed CLI brings back (see
   * `ProviderHandOverPlan.replaceKeepsWork`) starts a process of its own that
   * takes the jobs over, what the turn leaves out taken from the held process
   * when its options set `inheritUnset: true`; it waits for a turn the CLI
   * runs on its own first, and fails (HAND_OVER_FAILED, reason
   * `work-started`) rather than stop work that turn started when its options
   * set `keepBackgroundWork: true`. Options may carry `ownSettings`, the
   * settings a scheduled-messages dispatcher turn left out for the held
   * process to lend (only the dispatcher sets it; `buildTurnRunOptions` drops
   * a client's): a turn that starts a plain process of its own runs with them.
   */
  run(
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): Promise<unknown>;
  /**
   * Stops the session's turn under way, and resolves false when there is none
   * to stop. The caller sends the run's terminal `complete`. A turn the
   * runtime ran in a process it held for the session's background work
   * (Claude) is stopped alone: the work and the hold go on, and the session's
   * next turn can go into the process.
   */
  abort(sessionId: string): boolean | Promise<boolean>;
  permissions?: ProviderRuntimePermissionGateway;
  /**
   * Sessions with background tasks still outstanding, whether or not their
   * turn has ended. Only a runtime that keeps its process open past a turn for
   * such work has anything to report; the others leave this undefined and the
   * running-sessions list falls back to chat runs alone.
   */
  listBackgroundWork?(): Array<{ sessionId: string; tasks: BackgroundTaskSummary[] }>;
  /**
   * Stops one outstanding background task. Resolves false when the session has
   * no live process or that process is not tracking the task — it already
   * settled, or the id was never one of its own.
   */
  stopBackgroundTask?(sessionId: string, taskId: string): Promise<boolean>;
  /**
   * Sessions whose live process holds scheduled work (see
   * `ScheduledWorkSummary`), each session's oldest first: what it made, and
   * the jobs it brought back from the transcript as it resumed the session.
   * Listed apart from `listBackgroundWork`, which this leaves as it is: a
   * session with only scheduled work has no task. Only a process that owns
   * its session and has not let go of its input reports any; paused work
   * (`PausedScheduledWork`) never is. Only a runtime that keeps its process
   * past a turn for such work implements it (Claude).
   */
  listScheduledWork?(): Array<{ sessionId: string; scheduled: ScheduledWorkSummary[] }>;
  /**
   * Works out how to stop one piece of the session's scheduled work, or all
   * of it (`options.all`), and lets go of the process when that alone stops
   * it (see `ScheduledWorkStopResult`). When no process holds the session, a
   * stop of its paused work (`options.paused`) asks for a turn in a new
   * process, whatever kind: the CLI brings its jobs back from the transcript,
   * and the model ends a self-paced loop by a ScheduleWakeup with `stop: true`
   * there, which the transcript then keeps. Without paused work a job's id
   * (`cron:` and the CLI's eight-digit hex id) still asks for that turn. An id
   * of any other shape is `not_found`.
   */
  stopScheduledWork?(
    sessionId: string,
    id: string,
    options?: ScheduledWorkStopOptions,
  ): Promise<ScheduledWorkStopResult>;
  /**
   * Writes a user message into the session's running turn without stopping
   * it: the model reads it once its current tool batch ends, or as the next
   * turn of the same process when the turn ends first. Only a runtime whose
   * CLI keeps reading prompts while a turn runs implements it; for the others
   * the gateway answers UNSUPPORTED.
   *
   * `{ accepted: true }` means the runtime now owns the insert and reports it
   * only through the run's writer, as `insert_status` frames carrying the
   * content: `pending` first, then exactly one of `delivered`, `next_turn`,
   * `cancelled` or `failed` (see `InsertStatus`). `delivered` also sends a
   * user `text` message with `id` = insertId and `inserted: true`;
   * `next_turn` sends an ordinary user message anchored at the insertId.
   * While an accepted insert has not ended, the turn's `complete` waits.
   *
   * A refusal emits nothing: `NO_ACTIVE_RUN` when the session has no turn
   * that can take it (not started, already complete, being aborted),
   * `INVALID` for input it cannot use, `DUPLICATE` when the insertId was
   * already used in this run (the CLI acts on a message uuid once).
   */
  insert?(sessionId: string, input: ProviderInsertInput): Promise<ProviderInsertResult>;
  /**
   * Withdraws an accepted insert before the model reads it. `cancelled`: it
   * was withdrawn and the runtime has reported `insert_status cancelled`
   * through the run's writer. `cancel_failed`: the CLI is already delivering
   * it, so it carries on and still reports how it ends. `not_found`: the
   * session's run does not hold that insert, because it has already ended or
   * never existed. Nothing is emitted for the last two; the gateway answers
   * the asking socket.
   */
  cancelInsert?(sessionId: string, insertId: string): Promise<ProviderCancelInsertResult>;
  /**
   * Whether this runtime's own process still holds the session (see
   * `ProviderProcessState`): `running` from the moment a run starts, before
   * its CLI is up, through its turn and any hold for background work;
   * `exiting` while a process that let go of the session, or was retired or
   * aborted, winds down; null when none does. Only a runtime that keeps a
   * process past its turn implements it.
   */
  processState?(sessionId: string): ProviderProcessState | null;
  /**
   * Lets go of the session so a CLI can start on it: the run holding it is
   * stopped the way a newer run of the session would replace it (its turn
   * interrupted, its background tasks stopped), and the promise resolves once
   * its process, and any other of the session's still exiting, is gone.
   * Resolves at once when nothing holds the session. Only a runtime that
   * implements `processState` implements it.
   */
  release?(sessionId: string): Promise<void>;
  /**
   * Whether a turn of the session run with `options` would go into the
   * process this runtime holds open for the session's background work, as
   * that process's next turn, keeping the work running, and what it would
   * switch there (see `ProviderHandOverPlan`). Worked out without side
   * effects: nothing is written to the process and nothing is switched.
   * `options` are the run options `run` would get for the turn;
   * `planOptions.inheritUnset` counts the settings they leave out as the live
   * process's own (see `ProviderHandOverPlanOptions`), as does
   * `inheritUnset: true` in `options`; `acceptProcessSettings`, in either,
   * lets a process held only for scheduled work take a turn whose effort or
   * ultracode differ, or whose tool rules differ without being stricter
   * than the process's. The plan says what exactly keeps a turn out
   * (`details`), and whether a process of the turn's own keeps the work
   * (`replaceKeepsWork`), once a turn the CLI runs on its own is over
   * (`afterCliTurn`). Only a runtime that runs a new turn in a held
   * process implements it (Claude); the gateway answers for the others that
   * nothing is held.
   */
  planHandOver?(
    sessionId: string,
    options: AnyRecord,
    planOptions?: ProviderHandOverPlanOptions,
  ): Promise<ProviderHandOverPlan>;
  /**
   * The server is shutting down: the processes this runtime holds are about
   * to die with it, so the records of the ones held for scheduled work stay
   * for the next start to resume (see `ScheduleHoldRecord`). Only a runtime
   * that records them implements it.
   */
  prepareForShutdown?(): void;
}

/**
 * Main provider contract for CLI and SDK integrations.
 *
 * Each concrete provider owns its MCP/auth handlers plus the provider-specific
 * logic for converting native events/history into the app's normalized shape.
 */
export interface IProvider {
  readonly id: LLMProvider;
  readonly runtime: IProviderRuntime;
  readonly models: IProviderModels;
  readonly mcp: IProviderMcp;
  readonly auth: IProviderAuth;
  readonly skills: IProviderSkills;
  readonly sessions: IProviderSessions;
  readonly sessionSynchronizer: IProviderSessionSynchronizer;
  /**
   * Transcript branching. Present only for providers that can materialise a
   * prefix of one conversation as an independent, resumable provider session;
   * its absence is what makes "fork session" unavailable.
   */
  readonly fork?: IProviderFork;
}

// ---------------------------
//----------------- PROVIDER FORK INTERFACE ------------
/**
 * Transcript-branching contract for one provider.
 */
export interface IProviderFork {
  /**
   * Copies a session's transcript, up to and including `upToAnchorId` (the
   * whole conversation when omitted), into a brand-new provider session.
   *
   * Returns the new provider-native id and the path of the artifact it wrote,
   * so the caller can insert the database row before the filesystem watcher
   * notices the file and indexes it as an unrelated session.
   */
  forkSession(input: {
    providerSessionId: string;
    jsonlPath: string;
    /** The session's working directory — how providers scope a session lookup. */
    projectPath: string;
    upToAnchorId?: string;
    title?: string;
  }): Promise<{ providerSessionId: string; jsonlPath: string }>;
}

// ---------------------------
//----------------- PROVIDER MODEL INTERFACE ------------
/**
 * Model catalog contract for one provider.
 *
 * Implementations supply CloudCLI's curated predefined models and can inspect
 * provider-native session state. The Providers service merges these immutable
 * source-controlled definitions with user-created SQLite rows at read time.
 */
export interface IProviderModels {
  /**
   * Returns the curated predefined catalog owned by this provider adapter.
   */
  getSupportedModels(): Promise<ProviderModelsDefinition>;

  /**
   * Reads the model the provider itself believes one session is running with.
   *
   * Only consulted for sessions the app has never recorded a model for — a
   * session started directly in the provider CLI, for example. Selecting a
   * model in the app is persisted on the session row instead, so adapters here
   * are read-only and must fall back to the catalog default when the
   * provider-specific lookup finds nothing.
   */
  getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel>;
}

// ---------------------------
//----------------- PROVIDER AUTH INTERFACE ------------
/**
 * Auth contract for one provider.
 *
 * Implementations should return a complete installation/authentication status
 * without throwing for normal "not installed" or "not authenticated" states.
 */
export interface IProviderAuth {
  /**
   * Checks whether the provider is installed and has usable credentials.
   */
  getStatus(): Promise<ProviderAuthStatus>;
}

// ---------------------------
//----------------- PROVIDER SKILLS INTERFACE ------------
/**
 * Skills contract for one provider.
 *
 * Implementations discover provider-native skill markdown locations and return
 * normalized skill records with the exact command syntax expected by that
 * provider. Each skill is read from a `SKILL.md` file under its skill directory.
 */
export interface IProviderSkills {
  /**
   * Lists all skills visible to this provider for the optional workspace.
   */
  listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]>;

  /**
   * Writes one or more global user-scoped skills for this provider.
   *
   * Implementations should install the supplied markdown entries into the
   * provider's writable user skill folder and return the normalized skill
   * records that were written.
   */
  addSkills(input: ProviderSkillCreateInput): Promise<ProviderSkill[]>;

  removeSkill(
    input: ProviderSkillRemoveInput,
  ): Promise<{ removed: boolean; provider: LLMProvider; directoryName: string }>;
}

// ---------------------------
//----------------- PROVIDER MCP INTERFACE ------------
/**
 * MCP contract for one provider.
 *
 * Implementations must map provider-native MCP config formats to shared
 * `ProviderMcpServer` records used by routes and frontend state.
 */
export interface IProviderMcp {
  /**
   * Whether this provider manages MCP servers in `scope` at all. "Add to (or
   * remove from) every provider" skips providers that answer false instead
   * of reporting their unsupported-scope error as a failure.
   */
  supportsScope(scope: McpScope): boolean;
  listServers(options?: { workspacePath?: string }): Promise<Record<McpScope, ProviderMcpServer[]>>;
  listServersForScope(scope: McpScope, options?: { workspacePath?: string }): Promise<ProviderMcpServer[]>;
  upsertServer(input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer>;
  removeServer(
    input: { name: string; scope?: McpScope; workspacePath?: string },
  ): Promise<{ removed: boolean; provider: LLMProvider; name: string; scope: McpScope }>;
}

// ---------------------------
//----------------- PROVIDER SESSION INTERFACE ------------
/**
 * Session/history contract for one provider.
 *
 * Implementations normalize provider-specific events and message history into
 * shared transport shapes consumed by API routes and realtime streams.
 */
export interface IProviderSessions {
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[];
  fetchHistory(sessionId: string, options?: FetchHistoryOptions): Promise<FetchHistoryResult>;

  /**
   * Resolves where a conversation must resume from so that the turn identified
   * by `anchorId`, and everything after it, is replaced.
   *
   * `resumeThroughId` is the last transcript row to KEEP — resuming is
   * inclusive of it — or `null` when the edited turn is the first prompt and
   * the conversation should start over. `found` is false when `anchorId` is not
   * in the transcript, which the caller must report rather than guess at.
   *
   * Implemented only by providers whose transcripts have stable per-row
   * identity; its absence is what makes "edit this message" unavailable.
   */
  resolveEditAnchor?(
    sessionId: string,
    anchorId: string,
  ): Promise<{ found: boolean; resumeThroughId: string | null }>;

  /**
   * The cron jobs the provider's CLI brings back from the session's
   * transcript when it resumes the session, with nothing on its stream to
   * say so (see `RevivedCronJob`); `anchorId` is the row a resume at a row
   * replays up to. The runtime holds the resumed process for them. Only a
   * provider whose CLI does so implements it (Claude).
   */
  readRevivedCronJobs?(
    sessionId: string,
    options?: { anchorId?: string | null; now?: number },
  ): Promise<RevivedCronJob[]>;

  /**
   * The session's loops that no process runs (see `PausedScheduledWork`),
   * read off its transcript; the caller has checked that no process of this
   * server holds the session. Only a provider whose CLI brings loops back on
   * resume implements it (Claude).
   */
  readPausedScheduledWork?(sessionId: string, options?: { now?: number }): Promise<PausedScheduledWork>;

  /**
   * Rewinds the session so `keepThroughId` is the last row of its
   * conversation, and points the session at whatever provider session now
   * holds it. `null` keeps nothing: the conversation starts over.
   *
   * Implemented only by providers whose runtime cannot resume a transcript
   * partway and have to branch instead. Codex is one — it has no
   * resume-at-a-row, so the rewind is a `thread/fork` that leaves the pre-edit
   * thread on disk and moves the session onto the copy. Providers that can
   * resume partway leave this undefined, and the anchor is handed to their
   * runtime as a resume option instead; that is the difference the edit
   * gateway branches on.
   */
  rewindSession?(sessionId: string, keepThroughId: string | null): Promise<void>;

  /**
   * Reads what one agent of a workflow run did, from the transcript the run
   * wrote for it, with the status its journal gives it. Returns `null` when the
   * run left no transcript for that agent.
   *
   * Implemented only by providers whose runtime spawns workflow agents; its
   * absence is what makes an agent's timeline unavailable in the card.
   */
  readWorkflowAgentActivity?(
    sessionId: string,
    runId: string,
    agentId: string,
  ): Promise<WorkflowAgentActivity | null>;

  /**
   * Fingerprints what a session's history depends on besides its transcript
   * file, for the history cache: a cached history is reused only while both
   * the file's stat and this key are unchanged. Called on every history read
   * that goes through the cache, so it must stay cheap.
   *
   * `transcriptPath` is the session's `jsonl_path`, the file the cache stats.
   * Implemented only by providers whose history reader consults something
   * that can change while that file does not. Claude's reads its workflows'
   * journals, and reads an unreported background launch as running or
   * stopped by whether the process behind the session is alive. Without it,
   * the file alone decides when a cached history is stale.
   */
  readHistoryFreshnessKey?(
    sessionId: string,
    providerSessionId: string,
    transcriptPath: string,
  ): Promise<string | null>;
}

// ---------------------------
//----------------- PROVIDER SESSION SYNCHRONIZER INTERFACE ------------
/**
 * Session indexing contract for one provider.
 *
 * Implementations scan provider-specific session artifacts on disk and upsert
 * normalized session metadata into the database. The service layer uses this
 * interface for both full rescans and single-file incremental sync triggered
 * by filesystem watcher events.
 */
export interface IProviderSessionSynchronizer {
  /**
   * Scans provider session artifacts and upserts discovered sessions into DB.
   */
  synchronize(since?: Date): Promise<number>;

  /**
   * Parses and upserts one provider artifact file without running a full scan.
   */
  synchronizeFile(filePath: string): Promise<string | null>;
}
