import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AgyMcpProvider } from '@/modules/providers/list/agy/agy-mcp.provider.js';
import { AgySkillsProvider } from '@/modules/providers/list/agy/agy-skills.provider.js';
import { AgyProvider } from '@/modules/providers/list/agy/agy.provider.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { AppError } from '@/shared/utils.js';

/**
 * CloudCLI manages neither agy's MCP servers nor its skills: both facets list
 * nothing and refuse writes, so nothing is ever written under ~/.gemini.
 */

test('the agy provider is registered with every facet and no fork', () => {
  const provider = providerRegistry.resolveProvider('agy');
  assert.ok(provider instanceof AgyProvider);
  assert.equal(provider.id, 'agy');
  for (const facet of ['runtime', 'models', 'mcp', 'auth', 'skills', 'sessions', 'sessionSynchronizer'] as const) {
    assert.ok(provider[facet], facet);
  }
  // No fork facet: forking an agy session is unavailable.
  assert.equal('fork' in provider, false);
});

test('agy MCP supports no scope: empty lists, refused writes', async () => {
  const mcp = new AgyMcpProvider();
  for (const scope of ['user', 'local', 'project'] as const) {
    assert.equal(mcp.supportsScope(scope), false, scope);
    assert.deepEqual(await mcp.listServersForScope(scope), []);
    await assert.rejects(
      mcp.upsertServer({ name: 'server', scope, transport: 'http', url: 'https://example.com/mcp' }),
      (error: unknown) => error instanceof AppError && error.code === 'MCP_SCOPE_NOT_SUPPORTED' && error.statusCode === 400,
    );
    await assert.rejects(
      mcp.removeServer({ name: 'server', scope }),
      (error: unknown) => error instanceof AppError && error.code === 'MCP_SCOPE_NOT_SUPPORTED',
    );
  }
  assert.deepEqual(await mcp.listServers(), { user: [], local: [], project: [] });
});

test('agy skills: none listed, writes refused', async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'agy-skills-'));
  try {
    const skills = new AgySkillsProvider();
    assert.deepEqual(await skills.listSkills({ workspacePath }), []);
    await assert.rejects(
      skills.addSkills({ entries: [{ content: '---\nname: demo\ndescription: Demo\n---\nBody' }] }),
      (error: unknown) => error instanceof AppError && error.code === 'PROVIDER_SKILLS_WRITE_UNSUPPORTED' && error.statusCode === 400,
    );
    await assert.rejects(
      skills.removeSkill({ directoryName: 'demo' }),
      (error: unknown) => error instanceof AppError && error.code === 'PROVIDER_SKILLS_WRITE_UNSUPPORTED',
    );
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});
