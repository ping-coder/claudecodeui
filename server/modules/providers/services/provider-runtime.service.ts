import { sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import type { IProvider } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  BackgroundTaskSummary,
  LLMProvider,
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
};

const defaultDependencies: ProviderRuntimeServiceDependencies = {
  listProviders: () => providerRegistry.listProviders(),
  resolveProvider: (provider) => providerRegistry.resolveProvider(provider),
  resolveProviderSessionId: (sessionId) => sessionsService.resolveProviderSessionId(sessionId),
  resolveResumeModel: (provider, sessionId, requestedModel) =>
    providerModelsService.resolveResumeModel(provider, sessionId, requestedModel),
  getProviderModels: (provider) => providerModelsService.getProviderModels(provider),
  getSession: (sessionId) => sessionsDb.getSessionById(sessionId),
};

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
    return {
      heldWork: plan?.heldWork === true,
      canHandOver: plan?.canHandOver === true,
      changes: Array.isArray(plan?.changes) ? [...plan.changes] : [],
      switches: Array.isArray(plan?.switches) ? [...plan.switches] : [],
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
     * message leaves out as the live process's own.
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
     * What this server's own provider processes still hold for one session
     * (see `SessionHold`): `running` when any runtime still runs it, else
     * `exiting` when a process of it is winding down, with every runtime's
     * outstanding tasks for it. Null when nothing holds it. The websocket
     * module's Shell handler reads it before starting a CLI on the session.
     */
    describeSessionHold(sessionId: string): SessionHold | null {
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
      return processState === null && tasks.length === 0 ? null : { processState, tasks };
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
 * mid-run inserts and whether a send keeps background work) and as the Shell
 * handler's (what a session's processes still hold, and letting go of it),
 * to the scheduled-messages dispatcher, and to the git and agent modules as
 * their per-provider runners. The providers routes ask it for a session's
 * hand-over plan.
 */
export const providerRuntimeService = createProviderRuntimeService();
