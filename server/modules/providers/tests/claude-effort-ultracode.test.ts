import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderModelsDefinition, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * Ultracode is an on/off switch independent of reasoning effort: Claude Code
 * takes it as the session-scoped `ultracode` settings key (which also needs
 * Workflows enabled), only on xhigh-capable models, while the effort level
 * goes to the SDK's own `effort` option. These drive `queryClaudeSDK` through
 * its `context.createQuery` seam and inspect the SDK options it built.
 */

type RunSelection = {
  model: string;
  effort?: unknown;
  ultracode?: unknown;
};

/** Runs one scripted turn with the given selection and returns the SDK options handed to the query. */
async function captureSdkOptions(
  selection: RunSelection,
  catalog: ProviderModelsDefinition = CLAUDE_PREDEFINED_MODELS,
): Promise<Record<string, unknown>> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-effort-ultracode-'));
  const nativeId = `native-${selection.model}`;
  const capturedOptions: Record<string, unknown>[] = [];
  const writer = { send: (_message: NormalizedMessage) => {}, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => catalog,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery: ({ prompt, options }) => {
      capturedOptions.push(options);
      // Drain the held prompt like the CLI would read its stdin.
      void (async () => { for await (const _message of prompt) { /* read */ } })();
      const iterator = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: nativeId };
        yield {
          type: 'result',
          subtype: 'success',
          session_id: nativeId,
          result: 'ok',
          duration_ms: 1,
          num_turns: 1,
        };
      })();
      return Object.assign(iterator, { interrupt: async () => {} });
    },
  };

  try {
    await queryClaudeSDK(
      'hello',
      { sessionId: `app-${selection.model}`, cwd, ...selection },
      writer as never,
      context,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }

  assert.equal(capturedOptions.length, 1, 'the runtime builds exactly one query');
  return capturedOptions[0];
}

test('ultracode on combines with a low effort level on an xhigh-capable model', async () => {
  const options = await captureSdkOptions({ model: 'opus', effort: 'low', ultracode: true });

  assert.equal(options.effort, 'low');
  assert.deepEqual(options.settings, { ultracode: true, enableWorkflows: true });
});

test('ultracode on combines with max effort', async () => {
  const options = await captureSdkOptions({ model: 'opus', effort: 'max', ultracode: true });

  assert.equal(options.effort, 'max');
  assert.deepEqual(options.settings, { ultracode: true, enableWorkflows: true });
});

test('ultracode off is sent explicitly and does not enable Workflows', async () => {
  const options = await captureSdkOptions({ model: 'opus', ultracode: false });

  // Explicit, so an `ultracode: true` in the user's settings files cannot win.
  assert.deepEqual(options.settings, { ultracode: false });
  assert.equal('effort' in options, false);
});

test('no ultracode choice sends no settings key at all', async () => {
  const options = await captureSdkOptions({ model: 'opus', effort: 'high' });

  assert.equal(options.effort, 'high');
  assert.equal('settings' in options, false);
});

test('ultracode is dropped on models that cannot run it', async () => {
  const options = await captureSdkOptions({ model: 'default', ultracode: true });
  assert.equal('settings' in options, false, 'default must not receive ultracode settings');
});

test('every current Claude family alias, Haiku 5.5 included, can run ultracode', async () => {
  for (const model of ['best', 'fable', 'sonnet', 'sonnet[1m]', 'opus', 'opus[1m]', 'haiku', 'opusplan']) {
    const options = await captureSdkOptions({ model, effort: 'low', ultracode: true });
    assert.equal(options.effort, 'low', `${model} keeps its effort level`);
    assert.deepEqual(options.settings, { ultracode: true, enableWorkflows: true }, `${model} runs ultracode`);
  }
});

test('a legacy ultracode effort runs at xhigh with ultracode on', async () => {
  const options = await captureSdkOptions({ model: 'opus', effort: 'ultracode' });

  assert.equal(options.effort, 'xhigh');
  assert.deepEqual(options.settings, { ultracode: true, enableWorkflows: true });
});

test('a legacy ultracode effort is dropped whole on a model without xhigh', async () => {
  const options = await captureSdkOptions({ model: 'default', effort: 'ultracode' });

  assert.equal('effort' in options, false);
  assert.equal('settings' in options, false);
});

test('an explicit ultracode off wins over a legacy ultracode effort', async () => {
  const options = await captureSdkOptions({ model: 'opus', effort: 'ultracode', ultracode: false });

  assert.equal(options.effort, 'xhigh');
  assert.deepEqual(options.settings, { ultracode: false });
});

test('a non-boolean ultracode value is ignored', async () => {
  const options = await captureSdkOptions({ model: 'opus', effort: 'medium', ultracode: 'true' });

  assert.equal(options.effort, 'medium');
  assert.equal('settings' in options, false);
});

test('a custom catalog option is honoured only when it supports ultracode', async () => {
  const xhighEfforts = {
    default: 'high',
    values: ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value })),
  };
  const catalog: ProviderModelsDefinition = {
    OPTIONS: [
      ...CLAUDE_PREDEFINED_MODELS.OPTIONS,
      {
        value: 'gateway/claude-xhigh',
        label: 'Gateway xhigh',
        isCustom: true,
        effort: xhighEfforts,
        supportsUltracode: true,
      },
      {
        value: 'gateway/claude-plain',
        label: 'Gateway plain',
        isCustom: true,
        effort: xhighEfforts,
      },
    ],
    DEFAULT: CLAUDE_PREDEFINED_MODELS.DEFAULT,
  };

  const supported = await captureSdkOptions(
    { model: 'gateway/claude-xhigh', effort: 'low', ultracode: true },
    catalog,
  );
  assert.equal(supported.effort, 'low');
  assert.deepEqual(supported.settings, { ultracode: true, enableWorkflows: true });

  const unsupported = await captureSdkOptions(
    { model: 'gateway/claude-plain', effort: 'low', ultracode: true },
    catalog,
  );
  assert.equal(unsupported.effort, 'low');
  assert.equal('settings' in unsupported, false);
});
