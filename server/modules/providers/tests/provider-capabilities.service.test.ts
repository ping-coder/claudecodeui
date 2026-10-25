import assert from 'node:assert/strict';
import test from 'node:test';

import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { CODEX_PREDEFINED_MODELS } from '@/modules/providers/list/codex/codex-models.provider.js';
import { CURSOR_PREDEFINED_MODELS } from '@/modules/providers/list/cursor/cursor-models.provider.js';
import { OPENCODE_PREDEFINED_MODELS } from '@/modules/providers/list/opencode/opencode-models.provider.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import type { LLMProvider, ProviderModelsDefinition } from '@/shared/types.js';

/**
 * The full curated catalogs, before OpenCode narrows its list to the upstream
 * providers a machine has connected.
 */
const CURATED_CATALOGS: Record<LLMProvider, ProviderModelsDefinition> = {
  claude: CLAUDE_PREDEFINED_MODELS,
  codex: CODEX_PREDEFINED_MODELS,
  cursor: CURSOR_PREDEFINED_MODELS,
  opencode: OPENCODE_PREDEFINED_MODELS,
};

test('capability effort levels cover every level a curated model declares', () => {
  // Custom models may declare only these levels, so a level added to a curated
  // model has to be added here too, or users could not give it to their own.
  for (const [provider, catalog] of Object.entries(CURATED_CATALOGS) as Array<[LLMProvider, ProviderModelsDefinition]>) {
    const { effortLevels, supportsEffort } = providerCapabilitiesService.getProviderCapabilities(provider);

    assert.equal(supportsEffort, effortLevels.length > 0, `${provider}: supportsEffort disagrees with effortLevels`);
    assert.equal(new Set(effortLevels).size, effortLevels.length, `${provider}: effortLevels lists a level twice`);

    const declaredLevels = new Set(
      catalog.OPTIONS.flatMap((option) => option.effort?.values.map((level) => level.value) ?? []),
    );
    const missingLevels = [...declaredLevels].filter((level) => !effortLevels.includes(level));
    assert.deepEqual(missingLevels, [], `${provider}: effortLevels misses curated levels`);
  }
});

test('only Claude can run ultracode', () => {
  const supportsUltracode = Object.fromEntries(
    providerCapabilitiesService.listAllProviderCapabilities()
      .map((capabilities) => [capabilities.provider, capabilities.supportsUltracode]),
  );

  assert.deepEqual(supportsUltracode, { claude: true, cursor: false, codex: false, opencode: false });
});

test('ultracode is a switch beside the effort levels, never one of them', () => {
  for (const [provider, catalog] of Object.entries(CURATED_CATALOGS) as Array<[LLMProvider, ProviderModelsDefinition]>) {
    const { effortLevels, supportsUltracode } = providerCapabilitiesService.getProviderCapabilities(provider);
    assert.equal(effortLevels.includes('ultracode'), false, `${provider}: ultracode listed as an effort level`);

    for (const option of catalog.OPTIONS) {
      const declaredLevels = option.effort?.values.map((level) => level.value) ?? [];
      assert.equal(declaredLevels.includes('ultracode'), false, `${provider}/${option.value}: ultracode listed as an effort`);
      if (option.supportsUltracode) {
        // Claude Code only runs ultracode on xhigh-capable models.
        assert.equal(supportsUltracode, true, `${provider}/${option.value}: provider cannot run ultracode`);
        assert.ok(declaredLevels.includes('xhigh'), `${provider}/${option.value}: supportsUltracode without xhigh`);
      }
    }
  }
});
