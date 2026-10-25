import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AGY_PREDEFINED_MODELS, AgyProviderModels } from '@/modules/providers/list/agy/agy-models.provider.js';

/**
 * The agy catalog comes from `agy models` (a fake CLI here, via AGY_CLI_PATH),
 * falls back to the built-in list, and takes its DEFAULT from the label in
 * agy's settings.json. Every case runs in a throwaway HOME.
 */

const FAKE_AGY = fileURLToPath(new URL('./fixtures/agy/fake-agy.mjs', import.meta.url));
const ISOLATED_ENV_KEYS = ['HOME', 'AGY_CLI_PATH', 'AGY_DATA_DIRS', 'FAKE_AGY_SCENARIO', 'FAKE_AGY_ARGV_FILE', 'FAKE_AGY_CHILD_PID_FILE'];
const EFFORT_VALUES = [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }, { value: 'max' }];

type AgyModelsSandbox = {
  argvFile: string;
  childPidFile: string;
  writeSettings: (contents: string) => Promise<void>;
};

async function withAgyModelsSandbox(
  run: (sandbox: AgyModelsSandbox) => Promise<void>,
  { installed = true }: { installed?: boolean } = {},
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-models-'));
  const savedEnv = ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]] as const);
  const cliHome = path.join(root, 'home', '.gemini', 'antigravity-cli');
  const argvFile = path.join(root, 'argv.jsonl');
  const childPidFile = path.join(root, 'child.pid');

  process.env.HOME = path.join(root, 'home');
  process.env.AGY_CLI_PATH = installed ? FAKE_AGY : path.join(root, 'not-installed', 'agy');
  process.env.AGY_DATA_DIRS = path.join(root, 'data');
  process.env.FAKE_AGY_ARGV_FILE = argvFile;
  process.env.FAKE_AGY_CHILD_PID_FILE = childPidFile;
  delete process.env.FAKE_AGY_SCENARIO;

  try {
    await run({
      argvFile,
      childPidFile,
      writeSettings: async (contents) => {
        await mkdir(cliHome, { recursive: true });
        await writeFile(path.join(cliHome, 'settings.json'), contents, 'utf8');
      },
    });
  } finally {
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}

const values = (definition: { OPTIONS: Array<{ value: string }> }) => definition.OPTIONS.map((option) => option.value);

test('the built-in agy catalog is the 19-model fallback, each with every effort level', () => {
  assert.deepEqual(
    AGY_PREDEFINED_MODELS.OPTIONS.map((option) => `${option.value}|${option.label}`),
    [
      'auto|Gemini Pro Next',
      'gemini-flash-next|Gemini Flash Next',
      'gemini-launch-candidate-high|Gemini 4 Argon (High)',
      'gemini-launch-candidate-medium|Gemini 4 Argon (Medium)',
      'gemini-launch-candidate-low|Gemini 4 Argon (Low)',
      'gemini-pro-coordinator|Gemini Pro Orchestrator',
      'gemini-3.8-flash-high|Gemini 3.8 Flash (High)',
      'gemini-3.8-flash-medium|Gemini 3.8 Flash (Medium)',
      'gemini-3.8-flash-low|Gemini 3.8 Flash (Low)',
      'gemini-3.5-flash-lite|Gemini 3.5 Flash Lite',
      'gemini-3.1-pro-high|Gemini 3.1 Pro',
      'fable-5.1-max|Claude Fable 5.1 (Max)',
      'fable-5.1-high|Claude Fable 5.1 (High)',
      'fable-5.1-medium|Claude Fable 5.1 (Medium)',
      'fable-5.1-low|Claude Fable 5.1 (Low)',
      'opus-5.5-max|Claude Opus 5.5 (Max)',
      'opus-5.5-high|Claude Opus 5.5 (High)',
      'opus-5.5-medium|Claude Opus 5.5 (Medium)',
      'opus-5.5-low|Claude Opus 5.5 (Low)',
    ],
  );
  assert.equal(AGY_PREDEFINED_MODELS.DEFAULT, 'auto');
  for (const option of AGY_PREDEFINED_MODELS.OPTIONS) {
    assert.deepEqual(option.effort, { values: EFFORT_VALUES }, option.value);
  }
});

test('`agy models` rows become the catalog; the banner and malformed rows are skipped', async () => {
  await withAgyModelsSandbox(async (sandbox) => {
    const models = await new AgyProviderModels().getSupportedModels();

    assert.deepEqual(models.OPTIONS.map((option) => [option.value, option.label]), [
      ['auto', 'Gemini Pro Next'],
      ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite'],
      ['gemini-launch-candidate-high', 'Gemini 4 Argon (High)'],
      ['opus-5.5-max', 'Claude Opus 5.5 (Max)'],
    ]);
    for (const option of models.OPTIONS) {
      assert.deepEqual(option.effort, { values: EFFORT_VALUES }, option.value);
    }
    assert.equal(models.DEFAULT, 'auto');

    assert.deepEqual(JSON.parse((await readFile(sandbox.argvFile, 'utf8')).trim()).argv, ['models']);
  });
});

test('a helper that keeps `agy models` output open does not hold up the listing', async () => {
  await withAgyModelsSandbox(async (sandbox) => {
    process.env.FAKE_AGY_SCENARIO = 'models-lingering';
    let childPid: number | null = null;
    try {
      const startedAt = Date.now();
      const models = await new AgyProviderModels().getSupportedModels();
      childPid = existsSync(sandbox.childPidFile) ? Number(readFileSync(sandbox.childPidFile, 'utf8')) : null;

      assert.deepEqual(values(models), ['auto', 'gemini-3.5-flash-lite', 'gemini-launch-candidate-high', 'opus-5.5-max']);
      assert.ok(Date.now() - startedAt < 4_000, 'answered once agy exited, not at the timeout');
    } finally {
      if (childPid) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
  });
});

test('a failing `agy models` falls back to the built-in catalog', async () => {
  await withAgyModelsSandbox(async () => {
    process.env.FAKE_AGY_SCENARIO = 'models-fail';
    const models = await new AgyProviderModels().getSupportedModels();

    assert.deepEqual(values(models), values(AGY_PREDEFINED_MODELS));
    assert.equal(models.DEFAULT, 'auto');
  });
});

test('without agy installed the built-in catalog is served and nothing is spawned', async () => {
  await withAgyModelsSandbox(async (sandbox) => {
    const models = await new AgyProviderModels().getSupportedModels();

    assert.deepEqual(values(models), values(AGY_PREDEFINED_MODELS));
    assert.equal(existsSync(sandbox.argvFile), false);
  }, { installed: false });
});

test('DEFAULT follows the model label in agy\'s settings.json', async () => {
  await withAgyModelsSandbox(async (sandbox) => {
    const adapter = new AgyProviderModels();

    await sandbox.writeSettings(JSON.stringify({ model: 'Gemini 4 Argon (High)', theme: 'dark' }));
    assert.equal((await adapter.getSupportedModels()).DEFAULT, 'gemini-launch-candidate-high');
    // The adapter answers "no session-specific model" with that same DEFAULT.
    assert.deepEqual(await adapter.getCurrentActiveModel(), { model: 'gemini-launch-candidate-high' });

    // A label this catalog does not list, or unreadable settings: auto.
    await sandbox.writeSettings(JSON.stringify({ model: 'Gemini 9 Unknown' }));
    assert.equal((await adapter.getSupportedModels()).DEFAULT, 'auto');
    await sandbox.writeSettings('{ not json');
    assert.equal((await adapter.getSupportedModels()).DEFAULT, 'auto');
  });

  // The fallback catalog maps labels the same way.
  await withAgyModelsSandbox(async (sandbox) => {
    await sandbox.writeSettings(JSON.stringify({ model: 'Claude Fable 5.1 (Medium)' }));
    assert.equal((await new AgyProviderModels().getSupportedModels()).DEFAULT, 'fable-5.1-medium');
  }, { installed: false });
});

test('a listing without `auto` defaults to its first model', async () => {
  const adapter = new AgyProviderModels(
    async () => [{ value: 'gemini-flash-next', label: 'Gemini Flash Next' }, { value: 'opus-5.5-low', label: 'Claude Opus 5.5 (Low)' }],
    Date.now,
    async () => undefined,
  );
  assert.equal((await adapter.getSupportedModels()).DEFAULT, 'gemini-flash-next');
});

test('the `agy models` listing is cached for ten minutes and refreshed in the background', async () => {
  let now = 0;
  let listing = [{ value: 'auto', label: 'Gemini Pro Next' }];
  let readCount = 0;
  const pendingReads: Array<() => void> = [];
  const adapter = new AgyProviderModels(
    () => {
      readCount += 1;
      const snapshot = listing;
      return new Promise((resolve) => {
        pendingReads.push(() => resolve(snapshot));
      });
    },
    () => now,
    async () => undefined,
  );
  const flushRead = async (): Promise<void> => {
    pendingReads.shift()?.();
    await new Promise((resolve) => { setImmediate(resolve); });
  };

  // Concurrent first loads share one CLI invocation.
  const firstLoads = Promise.all([adapter.getSupportedModels(), adapter.getSupportedModels()]);
  await new Promise((resolve) => { setImmediate(resolve); });
  await flushRead();
  const [first, second] = await firstLoads;
  assert.equal(readCount, 1);
  assert.deepEqual(values(first), ['auto']);
  assert.deepEqual(second, first);

  now = 9 * 60_000;
  await adapter.getSupportedModels();
  assert.equal(readCount, 1, 'still fresh');

  // Stale: answered from the cache while a refresh runs behind it.
  now = 10 * 60_000;
  listing = [{ value: 'auto', label: 'Gemini Pro Next' }, { value: 'opus-5.5-max', label: 'Claude Opus 5.5 (Max)' }];
  assert.deepEqual(values(await adapter.getSupportedModels()), ['auto']);
  assert.equal(readCount, 2);
  await flushRead();
  assert.deepEqual(values(await adapter.getSupportedModels()), ['auto', 'opus-5.5-max']);
});

test('an empty or failed listing is retried after thirty seconds', async () => {
  let now = 0;
  let readCount = 0;
  const adapter = new AgyProviderModels(
    async () => {
      readCount += 1;
      if (readCount === 1) {
        throw new Error('agy unavailable');
      }
      return [{ value: 'gemini-flash-next', label: 'Gemini Flash Next' }];
    },
    () => now,
    async () => undefined,
  );

  assert.deepEqual(values(await adapter.getSupportedModels()), values(AGY_PREDEFINED_MODELS));
  now = 29_000;
  await adapter.getSupportedModels();
  assert.equal(readCount, 1);

  now = 30_000;
  await adapter.getSupportedModels();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(readCount, 2);
  assert.deepEqual(values(await adapter.getSupportedModels()), ['gemini-flash-next']);
});
