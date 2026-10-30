import { scheduleHoldsDb, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import type { IProvider } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  BackgroundTaskSummary,
  HandOverBlockDetail,
  LLMProvider,
  PausedScheduledWork,
  ProviderCancelInsertGatewayResult,
  ProviderHandOverPlan,
  ProviderHandOverPlanOptions,
  ProviderInsertGatewayResult,
  ProviderInsertInput,
  ProviderPermissionDecision,
  ProviderProcessState,
  ProviderRunFunction,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
  ScheduledWorkStopOptions,
  ScheduledWorkStopResult,
  ScheduledWorkSummary,
  SessionHold,
} from '@/shared/types.js';
import { AppError, buildTurnRunOptions } from '@/shared/utils.js';

type ProviderRuntimeServiceDependencies = {
  listProviders(): IProvider[];
  resolveProvider(provider: string): IProvider;
  resolveProviderSessionId(sessionId: string | null | undefined): string | null;
  resolveResumeModel(
    provider: LLMProvider,
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined>;
  getProviderModels: typeof providerModelsService.getProviderModels;
  /** The session's row: which provider runs it and its project. Null for an unknown session. */
  getSession(sessionId: string): { provider: string; project_path: string | null } | null;
  /** Where runtimes record the sessions they hold for scheduled work (see `ScheduleHoldRecord`). */
  scheduleHolds: NonNullable<ProviderRuntimeContext['scheduleHolds']>;
};

const defaultDependencies: ProviderRuntimeServiceDependencies = {
  listProviders: () => providerRegistry.listProviders(),
  resolveProvider: (provider) => providerRegistry.resolveProvider(provider),
  resolveProviderSessionId: (sessionId) => sessionsService.resolveProviderSessionId(sessionId),
  resolveResumeModel: (provider, sessionId, requestedModel) =>
    providerModelsService.resolveResumeModel(provider, sessionId, requestedModel),
  getProviderModels: (provider) => providerModelsService.getProviderModels(provider),
  getSession: (sessionId) => sessionsDb.getSessionById(sessionId),
  scheduleHolds: {
    save: (record) => scheduleHoldsDb.save(record),
    remove: (sessionId, runId) => scheduleHoldsDb.removeForRun(sessionId, runId),
  },
};

/**
 * A session's paused scheduled work as the gateway reads it (see
 * `PausedScheduledWork`): `heldHere` when a process of this server holds the
 * session, which then has nothing paused.
 */
export type SessionPausedScheduledWork = PausedScheduledWork & { heldHere: boolean };

const readStrings = (value: unknown): string[] => (
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
);
const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

/**
 * A runtime's `details` of a hand-over plan (see `HandOverBlockDetail`), read
 * field by field as the plan goes out over REST; undefined when nothing in it
 * reads.
 */
function readHandOverDetails(value: unknown): HandOverBlockDetail | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const details: HandOverBlockDetail = {};
  if (isRecord(value.tools)) {
    details.tools = { notAllowed: readStrings(value.tools.notAllowed), alsoDenied: readStrings(value.tools.alsoDenied) };
  }
  const mode = value.permissionMode;
  if (isRecord(mode) && typeof mode.process === 'string' && typeof mode.message === 'string') {
    details.permissionMode = {
      process: mode.process,
      message: mode.message,
      reason: mode.reason === 'cannot_switch' ? 'cannot_switch' : 'bypass_not_allowed',
    };
  }
  const model = value.model;
  if (isRecord(model) && typeof model.process === 'string' && typeof model.message === 'string') {
    details.model = { process: model.process, message: model.message };
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

/**
 * Creates the application-facing provider runtime dispatcher.
 *
 * The provider registry owns each concrete runtime. This service supplies the
 * registry-backed model/session lookups at execution time so runtime adapters
 * never import services that resolve back through the registry.
 */
export function createProviderRuntimeService(
  dependencyOverrides: Partial<ProviderRuntimeServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  const createRuntimeContext = (
    provider: IProvider,
  ): ProviderRuntimeContext => ({
    resolveProviderSessionId: dependencies.resolveProviderSessionId,
    resolveResumeModel: (sessionId, requestedModel) =>
      dependencies.resolveResumeModel(provider.id, sessionId, requestedModel),
    getProviderModels: async () => dependencies.getProviderModels(provider.id),
    normalizeMessage: (raw, sessionId) => provider.sessions.normalizeMessage(raw, sessionId),
    ...(provider.sessions.readRevivedCronJobs
      ? {
        readRevivedCronJobs: (sessionId: string, options: { anchorId: string | null; now: number }) =>
          provider.sessions.readRevivedCronJobs!(sessionId, options),
      }
      : {}),
    scheduleHolds: dependencies.scheduleHolds,
    async isProviderInstalled() {
      try {
        return (await provider.auth.getStatus()).installed;
      } catch {
        // Preserve the runtime's original error when installation probing fails.
        return true;
      }
    },
  });

  const run = (
    providerName: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown> => {
    const provider = dependencies.resolveProvider(providerName);
    return provider.runtime.run(command, options, writer, createRuntimeContext(provider));
  };

  // Every runtime's scheduled work for one session, oldest first.
  const listSessionScheduledWork = (sessionId: string): ScheduledWorkSummary[] => dependencies.listProviders()
    .flatMap((provider) => (provider.runtime.listScheduledWork?.() ?? [])
      .filter((entry) => entry.sessionId === sessionId)
      .flatMap((entry) => entry.scheduled))
    .sort((first, second) => first.startedAt - second.startedAt);

  // Whether a piece of scheduled work keeps its process held: its next fire
  // is unknown, or no later than its hold limit (see `ScheduledWorkSummary`).
  // Work due later is listed all the same, and goes with the process.
  const holdsProcess = (item: ScheduledWorkSummary): boolean => item.nextFireAt === null
    || item.nextFireAt <= item.holdUntil;

  const describeSessionHold = (sessionId: string): SessionHold | null => {
    let processState: ProviderProcessState | null = null;
    const tasks: BackgroundTaskSummary[] = [];
    for (const provider of dependencies.listProviders()) {
      const state = provider.runtime.processState?.(sessionId) ?? null;
      if (state === 'running' || (state === 'exiting' && processState === null)) {
        processState = state;
      }
      for (const entry of provider.runtime.listBackgroundWork?.() ?? []) {
        if (entry.sessionId === sessionId) {
          tasks.push(...entry.tasks);
        }
      }
    }
    const scheduled = listSessionScheduledWork(sessionId);
    return processState === null && tasks.length === 0 && scheduled.length === 0
      ? null
      : { processState, tasks, scheduled };
  };

  const planHandOver = async (
    providerName: LLMProvider,
    sessionId: string,
    options: AnyRecord,
    planOptions?: ProviderHandOverPlanOptions,
  ): Promise<ProviderHandOverPlan> => {
    const { runtime } = dependencies.resolveProvider(providerName);
    const plan = await runtime.planHandOver?.(sessionId, options, planOptions);
    // A runtime that never holds a process has nothing to hand over. The
    // runtime's answer is read field by field: it goes out over REST as is.
    const details = readHandOverDetails(plan?.details);
    return {
      heldWork: plan?.heldWork === true,
      canHandOver: plan?.canHandOver === true,
      changes: Array.isArray(plan?.changes) ? [...plan.changes] : [],
      switches: Array.isArray(plan?.switches) ? [...plan.switches] : [],
      ...(details ? { details } : {}),
      ...(plan?.replaceKeepsWork === true ? { replaceKeepsWork: true } : {}),
      ...(plan?.replaceKeepsWork === true && plan.afterCliTurn === true ? { afterCliTurn: true } : {}),
    };
  };

  return {
    run,

    /**
     * Whether a turn of the session run with `options` would go into the
     * process the provider's runtime holds open for the session's background
     * work, keeping that work, and what it would switch there (see
     * `ProviderHandOverPlan`); a runtime that never holds one answers that
     * nothing is held. `options` are the run options `run` would get: the
     * chat gateway passes a `chat.send`'s own when it set
     * `keepBackgroundWork`, the scheduled-messages dispatcher a queued or due
     * message's, and `planSessionHandOver` builds them from a client's.
     * `planOptions` go to the runtime as given (see
     * `ProviderHandOverPlanOptions`): the dispatcher counts the settings a
     * message leaves out as the live process's own, and takes the process's
     * own effort, ultracode and tool rules when it is held only for
     * scheduled work (`acceptProcessSettings`), unless the message's tool
     * rules are stricter than the process's.
     */
    planHandOver,

    /**
     * Plans a `chat.send` of the session with the options a client would send
     * with it (see `planHandOver`): the session's row says which provider runs
     * it and its project, and the run options are built from the client's as
     * the chat gateway builds a turn's (`buildTurnRunOptions`), so the plan
     * sees the turn the send would run. The providers module's POST
     * /api/providers/sessions/:sessionId/hand-over-plan answers with it.
     * Throws SESSION_NOT_FOUND (404) for a session that does not exist.
     */
    async planSessionHandOver(sessionId: string, clientOptions: AnyRecord): Promise<ProviderHandOverPlan> {
      const session = dependencies.getSession(sessionId);
      if (!session) {
        throw new AppError(`Session "${sessionId}" was not found.`, {
          code: 'SESSION_NOT_FOUND',
          statusCode: 404,
        });
      }
      return planHandOver(
        session.provider as LLMProvider,
        sessionId,
        buildTurnRunOptions({ sessionId, projectPath: session.project_path, clientOptions }),
      );
    },

    hasRuntime(providerName: string): boolean {
      try {
        return Boolean(dependencies.resolveProvider(providerName).runtime);
      } catch {
        return false;
      }
    },

    getRunner(provider: LLMProvider): ProviderRunFunction {
      return (command, options, writer) => run(provider, command, options, writer);
    },

    async abort(providerName: LLMProvider, sessionId: string): Promise<boolean> {
      return Boolean(await dependencies.resolveProvider(providerName).runtime.abort(sessionId));
    },

    async stopBackgroundTask(providerName: LLMProvider, sessionId: string, taskId: string): Promise<boolean> {
      // A runtime that never holds background work has no task to stop.
      const { runtime } = dependencies.resolveProvider(providerName);
      return Boolean(await runtime.stopBackgroundTask?.(sessionId, taskId));
    },

    async insert(
      providerName: LLMProvider,
      sessionId: string,
      input: ProviderInsertInput,
    ): Promise<ProviderInsertGatewayResult> {
      // Only a runtime whose CLI reads prompts while a turn runs can insert.
      const { runtime } = dependencies.resolveProvider(providerName);
      if (!runtime.insert) {
        return { accepted: false, reason: 'UNSUPPORTED' };
      }
      return runtime.insert(sessionId, input);
    },

    async cancelInsert(
      providerName: LLMProvider,
      sessionId: string,
      insertId: string,
    ): Promise<ProviderCancelInsertGatewayResult> {
      const { runtime } = dependencies.resolveProvider(providerName);
      if (!runtime.cancelInsert) {
        return { status: 'unsupported' };
      }
      return runtime.cancelInsert(sessionId, insertId);
    },

    hasBackgroundWork(sessionId: string): boolean {
      return dependencies.listProviders().some((provider) =>
        (provider.runtime.listBackgroundWork?.() ?? []).some((entry) => entry.sessionId === sessionId));
    },

    /**
     * Whether any runtime's live process is held for scheduled work of the
     * session (see `ScheduledWorkSummary`): work whose next fire is past its
     * hold limit does not count, as it keeps no process. Apart from
     * `hasBackgroundWork`, which counts tasks only.
     */
    hasScheduledWork(sessionId: string): boolean {
      return listSessionScheduledWork(sessionId).some(holdsProcess);
    },

    /**
     * The scheduled work every runtime's live process holds for the session,
     * oldest first, including work due past its hold limit.
     */
    listScheduledWork(sessionId: string): ScheduledWorkSummary[] {
      return listSessionScheduledWork(sessionId);
    },

    /**
     * Works out how to stop scheduled work of the session (see
     * `IProviderRuntime.stopScheduledWork`): `id` is a
     * `ScheduledWorkSummary.id`, `options.all` takes every piece that can be
     * stopped. A runtime that holds none answers `not_found`.
     */
    async stopScheduledWork(
      providerName: LLMProvider,
      sessionId: string,
      id: string,
      options: ScheduledWorkStopOptions = {},
    ): Promise<ScheduledWorkStopResult> {
      const { runtime } = dependencies.resolveProvider(providerName);
      return (await runtime.stopScheduledWork?.(sessionId, id, options)) ?? { status: 'not_found' };
    },

    /**
     * What this server's own provider processes still hold for one session
     * (see `SessionHold`): `running` when any runtime still runs it, else
     * `exiting` when a process of it is winding down, with every runtime's
     * outstanding tasks and scheduled work for it. Null when nothing holds
     * it. The websocket module's Shell handler reads it before starting a CLI
     * on the session.
     */
    describeSessionHold,

    /**
     * The session's loops that no process runs (see `PausedScheduledWork`):
     * what a restart of the server leaves of them. Nothing, with `heldHere`,
     * while a process of this server holds the session (`describeSessionHold`):
     * its work is listed by `listScheduledWork` then, and paused work never
     * is, nor counts for `hasScheduledWork`. The providers routes list it, and
     * the chat gateway resumes or stops it.
     */
    async describePausedScheduledWork(sessionId: string): Promise<SessionPausedScheduledWork> {
      const none: SessionPausedScheduledWork = { items: [], resumeContent: null, heldElsewhere: false, heldHere: false };
      const session = dependencies.getSession(sessionId);
      if (!session) {
        return none;
      }
      if (describeSessionHold(sessionId) !== null) {
        return { ...none, heldHere: true };
      }
      const provider = dependencies.resolveProvider(session.provider);
      if (!provider.sessions.readPausedScheduledWork) {
        return none;
      }
      const paused = await provider.sessions.readPausedScheduledWork(sessionId);
      // A process may have started while the transcript was read.
      if (describeSessionHold(sessionId) !== null) {
        return { ...none, heldHere: true };
      }
      return { ...paused, heldHere: false };
    },

    /**
     * The server is shutting down: every runtime that records its holds for
     * scheduled work keeps the records (see `IProviderRuntime.prepareForShutdown`).
     */
    prepareForShutdown(): void {
      for (const provider of dependencies.listProviders()) {
        provider.runtime.prepareForShutdown?.();
      }
    },

    /**
     * Lets go of the session in every runtime that can (see
     * `IProviderRuntime.release`), and resolves once each has. The Shell
     * handler calls it when the user takes the session over for the terminal.
     */
    async releaseSession(sessionId: string): Promise<void> {
      await Promise.all(
        dependencies.listProviders().map((provider) => provider.runtime.release?.(sessionId)),
      );
    },

    resolveToolApproval(requestId: string, decision: ProviderPermissionDecision): void {
      for (const provider of dependencies.listProviders()) {
        provider.runtime.permissions?.resolve(requestId, decision);
      }
    },

    getPendingApprovalsForSession(sessionId: string): unknown[] {
      return dependencies.listProviders().flatMap(
        (provider) => provider.runtime.permissions?.listPending(sessionId) ?? [],
      );
    },
  };
}

/**
 * The composition root (server/index.ts) hands this to the websocket module
 * as the chat gateway's runtime (runs, aborts, approvals, background tasks,
 * scheduled work, mid-run inserts and whether a send keeps background work)
 * and as the Shell handler's (what a session's processes still hold, and
 * letting go of it), to the scheduled-messages dispatcher, and to the git and
 * agent modules as their per-provider runners. The providers routes ask it
 * for a session's hand-over plan.
 */
export const providerRuntimeService = createProviderRuntimeService();
