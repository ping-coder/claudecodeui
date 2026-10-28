import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { abortClaudeSDKSession, queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * A run starts its CLI through the SDK's `spawnClaudeCodeProcess` option, so
 * that the SDK's `initialize` request declares a stop control per background
 * task (`perTaskStopAffordance`): Claude Code then leaves background agents
 * and workflows running when a turn is interrupted. This drives one scripted
 * run to get the option the SDK would be given, then starts a stand-in CLI
 * with it that echoes back what it reads.
 */

type SpawnOption = (options: {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}) => import('node:child_process').ChildProcess;

// Writes a line to stderr, then echoes every line it reads to stdout.
const ECHOING_CLI = [
  "process.stderr.write('ready\\n');",
  "let buffer = '';",
  "process.stdin.on('data', (chunk) => {",
  '  buffer += chunk;',
  '  let end;',
  "  while ((end = buffer.indexOf('\\n')) >= 0) {",
  '    process.stdout.write(buffer.slice(0, end + 1));',
  '    buffer = buffer.slice(end + 1);',
  '  }',
  '});',
  "process.stdin.on('end', () => process.exit(0));",
].join('\n');

/** Runs one scripted turn and returns the spawn option the run handed to the SDK. */
async function captureSpawnOption(sessionId: string, cwd: string): Promise<SpawnOption> {
  let spawnOption: SpawnOption | null = null;
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, id) => sessions.normalizeMessage(raw, id),
    isProviderInstalled: async () => true,
    createQuery: ({ prompt, options }) => {
      spawnOption = options.spawnClaudeCodeProcess as SpawnOption;
      void (async () => { for await (const _message of prompt) { /* the CLI reads its stdin */ } })();
      const iterator = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'native-spawn' };
        yield { type: 'result', subtype: 'success', session_id: 'native-spawn', result: 'ok', duration_ms: 1, num_turns: 1 };
      })();
      return Object.assign(iterator, { interrupt: async () => {} });
    },
  };
  const writer = { send: (_message: NormalizedMessage) => {}, userId: null };
  await queryClaudeSDK('hello', { sessionId, cwd }, writer as never, context);
  assert.ok(spawnOption, 'the run hands the SDK a spawn option');
  return spawnOption;
}

test('the CLI is started declaring a stop control per background task in the SDK\'s first initialize request, and its stderr reaches the log', async (t) => {
  const sessionId = 'app-spawn-session';
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-spawn-'));
  try {
    const spawnOption = await captureSpawnOption(sessionId, cwd);
    const logged: string[] = [];
    t.mock.method(console, 'error', (...parts: unknown[]) => { logged.push(parts.map(String).join(' ')); });

    const { NODE_OPTIONS: _nodeOptions, ...env } = process.env;
    const child = spawnOption({ command: process.execPath, args: ['-e', ECHOING_CLI], cwd, env, signal: new AbortController().signal });
    let echoed = '';
    child.stdout?.on('data', (chunk) => { echoed += String(chunk); });

    const initialize = { request_id: 'init-1', type: 'control_request', request: { subtype: 'initialize', hooks: {} } };
    const prompt = { type: 'user', message: { role: 'user', content: 'say "initialize"' }, parent_tool_use_id: null };
    child.stdin?.write(`${JSON.stringify(initialize)}\n`);
    child.stdin?.write(`${JSON.stringify(prompt)}\n`);
    child.stdin?.write(`${JSON.stringify({ ...initialize, request_id: 'init-2' })}\n`);
    child.stdin?.end();
    await once(child, 'exit');

    const lines = echoed.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(lines, [
      { ...initialize, request: { ...initialize.request, perTaskStopAffordance: true } },
      prompt,
      { ...initialize, request_id: 'init-2' },
    ], 'only the first initialize request declares it; the CLI reads no other');
    assert.equal(logged.some((line) => line.includes(`[Claude CLI ${sessionId}] ready`)), true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

async function flush(rounds = 10): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

// Gives up after five seconds of real time; works while `setTimeout` is mocked.
async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!condition() && performance.now() < deadline) {
    await flush(1);
  }
  assert.equal(condition(), true, 'condition never became true');
}

// Runs until it is killed, as a CLI holding its stdin open does.
const LINGERING_CLI = 'process.stdin.resume(); setInterval(() => {}, 1000);';

test('a closed process lets the session\'s next run start once it has exited, rather than after the full wait for its kill', async (t) => {
  const sessionId = 'app-spawn-closed';
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-spawn-'));
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const spawned: { child: import('node:child_process').ChildProcess | null } = { child: null };
  let nextStarted = false;
  const lookups = {
    resolveProviderSessionId: () => null,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw: unknown, id: string | null) => sessions.normalizeMessage(raw as never, id),
    isProviderInstalled: async () => true,
  };
  const writer = { send: (_message: NormalizedMessage) => {}, userId: null };
  const emit = (message: Record<string, unknown> | null) => { queue.push(message); wake?.(); };
  // The SDK's query, standing in: it starts the CLI with the run's spawn
  // option, and closing it kills that CLI, as the SDK does seconds later.
  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt, options }) => {
    const { NODE_OPTIONS: _nodeOptions, ...env } = process.env;
    spawned.child = (options.spawnClaudeCodeProcess as SpawnOption)({ command: process.execPath, args: ['-e', LINGERING_CLI], cwd, env, signal: new AbortController().signal });
    void (async () => { for await (const _message of prompt) { /* the CLI reads its stdin */ } })();
    const iterator = (async function* () {
      for (;;) {
        if (closed) {
          return;
        }
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const next = queue.shift();
        if (next === null || next === undefined) {
          return;
        }
        yield next;
      }
    })();
    return Object.assign(iterator, {
      interrupt: async () => {},
      stopTask: async () => {},
      close: () => {
        if (!closed) {
          closed = true;
          spawned.child?.kill('SIGTERM');
          wake?.();
        }
      },
    });
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });

  try {
    const firstRun = queryClaudeSDK('start', { sessionId, cwd }, writer as never, { ...lookups, resolveResumeModel: async () => undefined, createQuery });
    await waitUntil(() => spawned.child !== null);
    emit({ type: 'system', subtype: 'init', session_id: 'native-spawn' });
    await flush();
    assert.equal(await abortClaudeSDKSession(sessionId), true);
    // The CLI starts another turn once let go of, which closes it.
    emit({ type: 'system', subtype: 'init', session_id: 'native-spawn' });
    await waitUntil(() => closed);
    await firstRun;

    const nextQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
      void (async () => { for await (const _message of prompt) { /* the CLI reads its stdin */ } })();
      const iterator = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'native-spawn' };
        yield { type: 'result', subtype: 'success', session_id: 'native-spawn', result: 'ok', duration_ms: 1, num_turns: 1 };
      })();
      return Object.assign(iterator, { interrupt: async () => {} });
    };
    const nextRun = queryClaudeSDK('next', { sessionId, cwd }, writer as never, {
      ...lookups,
      resolveResumeModel: async () => { nextStarted = true; return undefined; },
      createQuery: nextQuery,
    });
    // No time passes on the mocked clock: only the killed CLI's exit lets it start.
    await waitUntil(() => nextStarted);
    await nextRun;
  } finally {
    emit(null);
    spawned.child?.kill('SIGKILL');
    t.mock.timers.tick(8 * 1000);
    await rm(cwd, { recursive: true, force: true });
  }
});
