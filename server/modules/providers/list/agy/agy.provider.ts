import { AgyProviderAuth } from '@/modules/providers/list/agy/agy-auth.provider.js';
import { AgyMcpProvider } from '@/modules/providers/list/agy/agy-mcp.provider.js';
import { AgyProviderModels } from '@/modules/providers/list/agy/agy-models.provider.js';
import { agyRuntime } from '@/modules/providers/list/agy/agy-runtime.provider.js';
import { AgySessionSynchronizer } from '@/modules/providers/list/agy/agy-session-synchronizer.provider.js';
import { AgySessionsProvider } from '@/modules/providers/list/agy/agy-sessions.provider.js';
import { AgySkillsProvider } from '@/modules/providers/list/agy/agy-skills.provider.js';
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import type {
  IProviderAuth,
  IProviderModels,
  IProviderRuntime,
  IProviderSessionSynchronizer,
  IProviderSessions,
  IProviderSkills,
} from '@/shared/interfaces.js';

/**
 * The Antigravity CLI (`agy`) provider. Registered at import time, so none of
 * its facets touch the filesystem or spawn anything until they are used. It
 * has no fork facet: agy conversations cannot be branched. Used by the
 * provider registry.
 */
export class AgyProvider extends AbstractProvider {
  readonly runtime: IProviderRuntime = agyRuntime;
  readonly models: IProviderModels = new AgyProviderModels();
  readonly mcp = new AgyMcpProvider();
  readonly auth: IProviderAuth = new AgyProviderAuth();
  readonly skills: IProviderSkills = new AgySkillsProvider();
  readonly sessions: IProviderSessions = new AgySessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new AgySessionSynchronizer();

  constructor() {
    super('agy');
  }
}
