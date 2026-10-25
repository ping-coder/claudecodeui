import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';

/**
 * Antigravity skills adapter with no sources: CloudCLI lists no agy skills,
 * and adding or removing one fails with the base class's
 * PROVIDER_SKILLS_WRITE_UNSUPPORTED error, so nothing is written under
 * ~/.gemini. Used by AgyProvider as its skills facet.
 */
export class AgySkillsProvider extends SkillsProvider {
  constructor() {
    super('agy');
  }

  protected async getSkillSources(): Promise<ProviderSkillSource[]> {
    return [];
  }
}
