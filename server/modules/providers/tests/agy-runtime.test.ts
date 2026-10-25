import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AGY_PREDEFINED_MODELS } from '@/modules/providers/list/agy/agy-models.provider.js';
import {
  agyRuntime,
  buildAgyArgs,
  resolveAgyPermissionFlags,
} from '@/modules/providers/list/agy/agy-runtime.provider.js';
import { AgySessionsProvider } from '@/modules/providers/list/agy/agy-sessions.provider.js';
import type { AnyRecord, NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * The agy runtime runs against a fake CLI (fixtures/agy/fake-agy.mjs, picked
 * up through AGY_CLI_PATH) inside a throwaway HOME and data root, so the real
 * agy and ~/.gemini are never touched. Message mapping goes through the real
 * AgySessionsProvider, as it does in production.
 */

const FAKE_AGY = fileURLToPath(new URL('./fixtures/agy/fake-agy.mjs', import.meta.url));
const NEW_CONVERSATION_ID = '3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b';
const RESUMED_CONVERSATION_ID = '72cc0cfd-1c2d-4e3f-8a9b-0c1d2e3f4a42';
const APP_SESSION_ID = 'app-session-agy';
const ISOLATED_ENV_KEYS = [
  'HOME',
  'AGY_CLI_PATH',
  'AGY_DATA_DIRS',
  'FAKE_AGY_SCENARIO',
  'FAKE_AGY_ARGV_FILE',
  'FAKE_AGY_CHILD_PID_FILE',
  'FAKE_AGY_CONVERSATION_ID',
  'FAKE_AGY_GATE_FILE',
  'FAKE_AGY_READY_FILE',
];

type AgySandbox = {
  root: string;
  project: string;
  dataRoots: { current: string; legacy: string };
  argvFile: string;
  childPidFile: string;
  /** Created by a test to let a gated scenario write its output. */
  gateFile: string;
  /** Created by a gated scenario once its output is in the pipe. */
  readyFile: string;
};

async function withAgySandbox(
  run: (sandbox: AgySandbox) => Promise<void>,
  { installed = true, signedIn = true }: { installed?: boolean; signedIn?: boolean } = {},
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-runtime-'));
  const savedEnv = ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]] as const);
  const home = path.join(root, 'home');
  const sandbox: AgySandbox = {
    root,
    project: path.join(root, 'project'),
    dataRoots: { current: path.join(root, 'data', 'antigravity-cli'), legacy: path.join(root, 'data', 'antigravity') },
    argvFile: path.join(root, 'argv.jsonl'),
    childPidFile: path.join(root, 'child.pid'),
    gateFile: path.join(root, 'gate'),
    readyFile: path.join(root, 'ready'),
  };

  await mkdir(sandbox.project, { recursive: true });
  await mkdir(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  if (signedIn) {
    // Only the file's existence counts as "signed in"; its content is never read.
    await writeFile(path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'placeholder');
  }

  process.env.HOME = home;
  process.env.AGY_CLI_PATH = installed ? FAKE_AGY : path.join(root, 'not-installed', 'agy');
  process.env.AGY_DATA_DIRS = `${sandbox.dataRoots.current}:${sandbox.dataRoots.legacy}`;
  process.env.FAKE_AGY_ARGV_FILE = sandbox.argvFile;
  process.env.FAKE_AGY_CHILD_PID_FILE = sandbox.childPidFile;
  process.env.FAKE_AGY_GATE_FILE = sandbox.gateFile;
  process.env.FAKE_AGY_READY_FILE = sandbox.readyFile;
  delete process.env.FAKE_AGY_SCENARIO;
  delete process.env.FAKE_AGY_CONVERSATION_ID;

  try {
    await run(sandbox);
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

const sessionsProvider = new AgySessionsProvider();

function createContext(overrides: Partial<ProviderRuntimeContext> = {}): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async (_sessionId, requestedModel) => requestedModel ?? undefined,
    getProviderModels: async () => AGY_PREDEFINED_MODELS,
    normalizeMessage: (raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    ...overrides,
  };
}

function createWriter() {
  const messages: NormalizedMessage[] = [];
  const boundSessionIds: string[] = [];
  return {
    messages,
    boundSessionIds,
    writer: {
      userId: null,
      send: (message: unknown) => {
        messages.push(message as NormalizedMessage);
      },
      setSessionId: (sessionId: string) => {
        boundSessionIds.push(sessionId);
      },
    },
  };
}

const ofKind = (messages: NormalizedMessage[], kind: NormalizedMessage['kind']) =>
  messages.filter((message) => message.kind === kind);

/** Runs one turn and returns everything it wrote; `rejected` is the error a failed turn rejects with. */
async function runTurn(
  prompt: string,
  options: AnyRecord,
  context: ProviderRuntimeContext = createContext(),
): Promise<ReturnType<typeof createWriter> & { rejected: Error | null }> {
  const output = createWriter();
  let rejected: Error | null = null;
  try {
    await agyRuntime.run(prompt, { sessionId: APP_SESSION_ID, ...options }, output.writer, context);
  } catch (error) {
    rejected = error as Error;
  }
  return { ...output, rejected };
}

async function readLaunches(argvFile: string): Promise<Array<{ argv: string[]; cwd: string }>> {
  if (!existsSync(argvFile)) {
    return [];
  }
  return (await readFile(argvFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // A zombie still answers signal 0 until it is reaped.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    return state !== 'Z' && state !== 'X';
  } catch {
    return process.platform !== 'linux';
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}

/** Like waitFor, but blocks the event loop meanwhile, so nothing else (agy's output included) is handled. */
function waitForSync(condition: () => boolean, timeoutMs: number, label: string): void {
  const deadline = Date.now() + timeoutMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    Atomics.wait(pause, 0, 0, 5);
  }
}

function killQuietly(pid: number | null): void {
  if (!pid) {
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

const readChildPid = (childPidFile: string): number | null =>
  existsSync(childPidFile) ? Number(readFileSync(childPidFile, 'utf8')) || null : null;

// ---------------------------------------------------------------------------
// Pure argument building
// ---------------------------------------------------------------------------

test('agy argv: a new turn is a headless stream-json run with the prompt as one element', () => {
  assert.deepEqual(buildAgyArgs({ prompt: 'Fix the bug\nin two lines' }), [
    '-p', 'Fix the bug\nin two lines', '--output-format', 'stream-json',
  ]);
});

test('agy argv: resume, model, permission and effort flags', () => {
  assert.deepEqual(
    buildAgyArgs({
      prompt: 'Continue',
      conversationId: RESUMED_CONVERSATION_ID,
      model: 'gemini-3.5-flash-lite',
      permissionMode: 'acceptEdits',
      effort: 'xhigh',
    }),
    [
      '-p', 'Continue', '--output-format', 'stream-json',
      '--conversation', RESUMED_CONVERSATION_ID,
      '--model', 'gemini-3.5-flash-lite',
      '--mode', 'accept-edits',
      '--effort', 'xhigh',
    ],
  );
});

test('agy argv: placeholders and unsafe values never reach the CLI', () => {
  for (const model of ['', 'default', '--dangerously-skip-permissions', 'bad\nmodel', null, undefined]) {
    assert.equal(buildAgyArgs({ prompt: 'x', model }).includes('--model'), false, `model ${JSON.stringify(model)}`);
  }
  assert.equal(buildAgyArgs({ prompt: 'x', effort: 'default' }).includes('--effort'), false);
  assert.equal(buildAgyArgs({ prompt: 'x', effort: '' }).includes('--effort'), false);
  // Only a real conversation id can be resumed.
  assert.equal(buildAgyArgs({ prompt: 'x', conversationId: 'not-a-uuid' }).includes('--conversation'), false);
});

test('agy argv: a prompt that starts with a dash stays one element and cannot read as a flag', () => {
  const args = buildAgyArgs({ prompt: '--help me write tests' });
  assert.equal(args.length, 4);
  assert.equal(args[0], '-p');
  assert.equal(args[1], ' --help me write tests');
  assert.equal(args[1].trim(), '--help me write tests');
});

test('agy permission modes map onto agy flags', () => {
  assert.deepEqual(resolveAgyPermissionFlags('default'), []);
  assert.deepEqual(resolveAgyPermissionFlags(undefined), []);
  assert.deepEqual(resolveAgyPermissionFlags('auto'), []);
  assert.deepEqual(resolveAgyPermissionFlags('acceptEdits'), ['--mode', 'accept-edits']);
  assert.deepEqual(resolveAgyPermissionFlags('plan'), ['--mode', 'plan']);
  assert.deepEqual(resolveAgyPermissionFlags('bypassPermissions'), ['--dangerously-skip-permissions']);
  // "Skip permissions" from the tool settings is bypass, except in read-only plan mode.
  assert.deepEqual(resolveAgyPermissionFlags('default', true), ['--dangerously-skip-permissions']);
  assert.deepEqual(resolveAgyPermissionFlags('acceptEdits', true), ['--dangerously-skip-permissions']);
  assert.deepEqual(resolveAgyPermissionFlags('plan', true), ['--mode', 'plan']);
});

// ---------------------------------------------------------------------------
// Turns against the fake CLI
// ---------------------------------------------------------------------------

test('a new chat binds to agy\'s conversation id before any text streams', async () => {
  await withAgySandbox(async (sandbox) => {
    const turn = await runTurn('Hi there', {
      cwd: sandbox.project,
      model: 'gemini-3.5-flash-lite',
      effort: 'high',
      permissionMode: 'plan',
    });

    assert.equal(turn.rejected, null);
    assert.deepEqual(turn.boundSessionIds, [NEW_CONVERSATION_ID]);
    const created = ofKind(turn.messages, 'session_created');
    assert.equal(created.length, 1);
    assert.equal(created[0].newSessionId, NEW_CONVERSATION_ID);
    const firstDelta = turn.messages.findIndex((message) => message.kind === 'stream_delta');
    assert.ok(turn.messages.indexOf(created[0]) < firstDelta, 'session_created comes before the text');
    assert.deepEqual(ofKind(turn.messages, 'stream_delta').map((message) => message.content), ['Hello', ' from agy']);
    assert.ok(ofKind(turn.messages, 'stream_end').length >= 1);
    // The streamed text is not repeated from result.response.
    assert.equal(ofKind(turn.messages, 'text').length, 0);
    assert.equal(ofKind(turn.messages, 'error').length, 0);

    // The budget is the latest step's context (new plus cache-read input, and
    // output), never result.usage, which is cumulative.
    const [budget] = ofKind(turn.messages, 'status');
    assert.equal(budget.text, 'token_budget');
    assert.deepEqual(budget.tokenBudget, {
      used: 2030,
      inputTokens: 2000,
      outputTokens: 30,
      breakdown: { input: 2000, output: 30 },
    });

    const completes = ofKind(turn.messages, 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0].exitCode, 0);
    assert.equal(turn.messages.at(-1)?.kind, 'complete');

    const [launch] = await readLaunches(sandbox.argvFile);
    assert.equal(launch.cwd, sandbox.project);
    assert.deepEqual(launch.argv, [
      '-p', 'Hi there', '--output-format', 'stream-json',
      '--model', 'gemini-3.5-flash-lite',
      '--mode', 'plan',
      '--effort', 'high',
    ]);
  });
});

test('a resumed chat keeps its conversation and maps the verbatim stream sample', async () => {
  await withAgySandbox(async (sandbox) => {
    process.env.FAKE_AGY_SCENARIO = 'resume';
    const turn = await runTurn('What does hello.txt say?', {
      cwd: sandbox.project,
      model: 'default',
      effort: 'default',
      permissionMode: 'bypassPermissions',
    }, createContext({ resolveProviderSessionId: () => RESUMED_CONVERSATION_ID }));

    assert.equal(turn.rejected, null);
    assert.deepEqual(ofKind(turn.messages, 'session_created'), []);
    assert.deepEqual(turn.boundSessionIds, []);

    const [launch] = await readLaunches(sandbox.argvFile);
    assert.deepEqual(launch.argv, [
      '-p', 'What does hello.txt say?', '--output-format', 'stream-json',
      '--conversation', RESUMED_CONVERSATION_ID,
      '--dangerously-skip-permissions',
    ]);

    const toolUses = ofKind(turn.messages, 'tool_use');
    const toolResults = ofKind(turn.messages, 'tool_result');
    assert.equal(toolUses.length, 1);
    assert.equal(toolResults.length, 1);
    assert.equal(toolUses[0].toolName, 'Read');
    assert.deepEqual(toolUses[0].toolInput, { file_path: '/tmp/agy-probe/hello.txt' });
    assert.equal(toolResults[0].toolId, toolUses[0].toolId);
    assert.equal(toolResults[0].content, '1 lines, 17 bytes');
    assert.ok(turn.messages.indexOf(toolUses[0]) < turn.messages.indexOf(toolResults[0]));
    assert.equal(ofKind(turn.messages, 'stream_delta').map((message) => message.content).join(''), 'probe-content-42\n');
    // The user's echo and agy's system prompt are not chat rows.
    assert.equal(turn.messages.some((message) => message.role === 'user'), false);

    const [budget] = ofKind(turn.messages, 'status');
    assert.deepEqual(budget.tokenBudget, {
      used: 2223 + 16082 + 45,
      inputTokens: 2223 + 16082,
      outputTokens: 45,
      breakdown: { input: 2223 + 16082, output: 45 },
    });
    assert.deepEqual(ofKind(turn.messages, 'complete').map((message) => message.exitCode), [0]);
  });
});

test('each tool call becomes one card even when agy repeats or skips its ACTIVE update', async () => {
  await withAgySandbox(async (sandbox) => {
    process.env.FAKE_AGY_SCENARIO = 'tool-done-first';
    const turn = await runTurn('List files', { cwd: sandbox.project });

    assert.equal(turn.rejected, null);
    const toolUses = ofKind(turn.messages, 'tool_use');
    const toolResults = ofKind(turn.messages, 'tool_result');
    assert.deepEqual(toolUses.map((message) => message.toolName), ['Read', 'Bash']);
    assert.equal(toolResults.length, 2);
    // The DONE that arrived without an ACTIVE was announced first, with its input.
    assert.deepEqual(toolUses[0].toolInput, { file_path: '/tmp/agy-probe/notes.txt' });
    for (const result of toolResults) {
      const use = toolUses.find((candidate) => candidate.toolId === result.toolId);
      assert.ok(use, 'every result has its call');
      assert.ok(turn.messages.indexOf(use) < turn.messages.indexOf(result));
    }
    assert.equal(new Set(toolUses.map((message) => message.toolId)).size, 2);
  });
});

test('an unknown step type is ignored and the turn still completes', async () => {
  await withAgySandbox(async (sandbox) => {
    process.env.FAKE_AGY_SCENARIO = 'unknown-step-type';
    const turn = await runTurn('Hi', { cwd: sandbox.project });

    assert.equal(turn.rejected, null);
    assert.equal(turn.messages.some((message) => JSON.stringify(message).includes('must not show')), false);
    assert.deepEqual(ofKind(turn.messages, 'stream_delta').map((message) => message.content), ['After the unknown step']);
    assert.equal(ofKind(turn.messages, 'error').length, 0);
    assert.deepEqual(ofKind(turn.messages, 'complete').map((message) => message.exitCode), [0]);
  });
});

test('JSON lines split across chunks (even inside a character) are reassembled', async () => {
  await withAgySandbox(async (sandbox) => {
    process.env.FAKE_AGY_SCENARIO = 'partial-lines';
    const turn = await runTurn('Hi', { cwd: sandbox.project });

    assert.equal(turn.rejected, null);
    assert.deepEqual(
      ofKind(turn.messages, 'stream_delta').map((message) => message.content),
      ['Split … 你好', ' – reassembled'],
    );
    assert.equal(ofKind(turn.messages, 'error').length, 0);
    // The final `result` line had no newline; it still counted.
    assert.deepEqual(ofKind(turn.messages, 'complete').map((message) => message.exitCode), [0]);
  });
});

test('exit 3 with an AGY_ERROR line ends in one error row and one failed complete', async () => {
  await withAgySandbox(async (sandbox) => {
    process.env.FAKE_AGY_SCENARIO = 'error-exit-3';
    const turn = await runTurn('Hi', { cwd: sandbox.project });

    assert.ok(turn.rejected instanceof Error);
    const errors = ofKind(turn.messages, 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].content, 'conversation could not be resumed: not found');
    // The AGY_ERROR line is never shown as assistant text.
    assert.equal(ofKind(turn.messages, 'stream_delta').length, 0);
    assert.equal(ofKind(turn.messages, 'text').length, 0);
    const completes = ofKind(turn.messages, 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0].exitCode, 1);
    assert.equal(turn.messages.at(-1)?.kind, 'complete');
  });
});

test('a failed result shows the partial answer once, then the error', async () => {
  await withAgySandbox(async (sandbox) => {
    process.env.FAKE_AGY_SCENARIO = 'failed-result';
    const turn = await runTurn('Hi', { cwd: sandbox.project });

    assert.ok(turn.rejected instanceof Error);
    const texts = ofKind(turn.messages, 'text');
    assert.deepEqual(texts.map((message) => [message.role, message.content]), [['assistant', 'Partial answer before the failure']]);
    const errors = ofKind(turn.messages, 'error');
    assert.deepEqual(errors.map((message) => message.content), ['Antigravity stopped with status ERROR.']);
    assert.ok(turn.messages.indexOf(texts[0]) < turn.messages.indexOf(errors[0]));
    assert.deepEqual(ofKind(turn.messages, 'complete').map((message) => message.exitCode), [1]);
  });
});

test('a crash reports the exit code with stderr stripped of terminal styling', async () => {
  await withAgySandbox(async (sandbox) => {
    process.env.FAKE_AGY_SCENARIO = 'stderr-exit-1';
    const turn = await runTurn('Hi', { cwd: sandbox.project });

    assert.ok(turn.rejected instanceof Error);
    const [error] = ofKind(turn.messages, 'error');
    assert.equal(error.content, 'The Antigravity CLI exited with code 1.\n\nError: quota exhausted for this account');
    assert.deepEqual(ofKind(turn.messages, 'complete').map((message) => message.exitCode), [1]);
  });
});

test('a failed resume of a conversation kept only by older agy versions says so', async () => {
  await withAgySandbox(async (sandbox) => {
    await mkdir(path.join(sandbox.dataRoots.legacy, 'brain', RESUMED_CONVERSATION_ID), { recursive: true });
    process.env.FAKE_AGY_SCENARIO = 'error-exit-3';
    const context = createContext({ resolveProviderSessionId: () => RESUMED_CONVERSATION_ID });

    const legacy = await runTurn('Continue', { cwd: sandbox.project }, context);
    const [legacyError] = ofKind(legacy.messages, 'error');
    assert.match(String(legacyError.content), /^conversation could not be resumed: not found\n\n/);
    assert.match(String(legacyError.content), /~\/\.gemini\/antigravity/);
    assert.match(String(legacyError.content), /Start a new chat/);

    // Also present in the current root: no hint.
    await mkdir(path.join(sandbox.dataRoots.current, 'brain', RESUMED_CONVERSATION_ID), { recursive: true });
    const current = await runTurn('Continue', { cwd: sandbox.project }, context);
    assert.deepEqual(ofKind(current.messages, 'error').map((message) => message.content), [
      'conversation could not be resumed: not found',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Turns that never start
// ---------------------------------------------------------------------------

async function assertRefusedBeforeSpawn(
  sandbox: AgySandbox,
  turn: Awaited<ReturnType<typeof runTurn>>,
  expectedError: RegExp,
): Promise<void> {
  assert.ok(turn.rejected instanceof Error);
  assert.deepEqual(turn.messages.map((message) => message.kind), ['error', 'complete']);
  assert.match(String(turn.messages[0].content), expectedError);
  assert.equal(turn.messages[1].exitCode, 1);
  assert.deepEqual(await readLaunches(sandbox.argvFile), [], 'agy was never started');
}

test('a turn without agy installed says so instead of failing to spawn', async () => {
  await withAgySandbox(async (sandbox) => {
    const turn = await runTurn('Hi', { cwd: sandbox.project });
    await assertRefusedBeforeSpawn(sandbox, turn, /Antigravity CLI \(agy\) is not installed/);
  }, { installed: false });
});

test('a turn before agy was ever signed in asks for a terminal sign-in', async () => {
  await withAgySandbox(async (sandbox) => {
    const turn = await runTurn('Hi', { cwd: sandbox.project });
    await assertRefusedBeforeSpawn(sandbox, turn, /Run `agy` once in a terminal to sign in/);
  }, { signedIn: false });
});

test('attachments are refused, not dropped silently', async () => {
  await withAgySandbox(async (sandbox) => {
    const image = await runTurn('Look', { cwd: sandbox.project, images: [{ path: '/tmp/screenshot.png' }] });
    await assertRefusedBeforeSpawn(sandbox, image, /Antigravity does not support attachments yet/);

    const file = await runTurn('Read', { cwd: sandbox.project, files: [{ path: '/tmp/brief.pdf', name: 'brief.pdf' }] });
    await assertRefusedBeforeSpawn(sandbox, file, /Antigravity does not support attachments yet/);
  });
});

test('a missing project directory is reported as such, not as a missing CLI', async () => {
  await withAgySandbox(async (sandbox) => {
    const missing = path.join(sandbox.root, 'gone');
    const turn = await runTurn('Hi', { cwd: missing, projectPath: missing });
    await assertRefusedBeforeSpawn(sandbox, turn, /project directory does not exist/);
    assert.doesNotMatch(String(turn.messages[0].content), /not installed/);
  });
});

test('a prompt too large for one argument is reported as such', async () => {
  await withAgySandbox(async (sandbox) => {
    // Larger than the per-argument limit on 4 KiB- and 64 KiB-page kernels alike.
    const turn = await runTurn('x'.repeat(3 * 1024 * 1024), { cwd: sandbox.project });
    await assertRefusedBeforeSpawn(sandbox, turn, /too large/);
  });
});

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

test('abort stops agy and everything it started, and the turn reports nothing more', async () => {
  await withAgySandbox(async (sandbox) => {
    process.env.FAKE_AGY_SCENARIO = 'abort';
    const output = createWriter();
    let childPid: number | null = null;
    try {
      const turn = agyRuntime.run('Work', { sessionId: APP_SESSION_ID, cwd: sandbox.project }, output.writer, createContext());
      await waitFor(
        () => existsSync(sandbox.childPidFile) && output.messages.some((message) => message.kind === 'stream_delta'),
        10_000,
        'the fake agy to start its child and stream',
      );
      childPid = readChildPid(sandbox.childPidFile);
      assert.ok(childPid && isProcessAlive(childPid));
      const writtenBeforeAbort = output.messages.length;

      const startedAt = Date.now();
      assert.equal(await agyRuntime.abort(APP_SESSION_ID), true);
      await turn;
      assert.ok(Date.now() - startedAt < 4_000, 'the abort resolves once agy closed, not after the kill delay');
      // No orphan: the child was in agy's process group.
      await waitFor(() => !isProcessAlive(childPid as number), 3_000, 'the child process to exit');
      await new Promise((resolve) => { setTimeout(resolve, 100); });

      assert.equal(output.messages.length, writtenBeforeAbort, 'nothing is written after the abort');
      assert.equal(ofKind(output.messages, 'complete').length, 0, 'the abort handler owns the complete');
      assert.equal(await agyRuntime.abort(APP_SESSION_ID), false, 'nothing is left to abort');
    } finally {
      killQuietly(childPid);
    }
  });
});

test('abort escalates to SIGKILL for a process group that ignores SIGTERM', async () => {
  await withAgySandbox(async (sandbox) => {
    process.env.FAKE_AGY_SCENARIO = 'abort-ignores-sigterm';
    const output = createWriter();
    let childPid: number | null = null;
    try {
      const turn = agyRuntime.run('Work', { sessionId: APP_SESSION_ID, cwd: sandbox.project }, output.writer, createContext());
      await waitFor(
        () => existsSync(sandbox.childPidFile) && output.boundSessionIds.length === 1,
        10_000,
        'the fake agy to start',
      );
      childPid = readChildPid(sandbox.childPidFile);

      const startedAt = Date.now();
      assert.equal(await agyRuntime.abort(APP_SESSION_ID), true);
      assert.ok(Date.now() - startedAt >= 4_500, 'SIGKILL only after the SIGTERM grace');
      await turn;
      await waitFor(() => !isProcessAlive(childPid as number), 3_000, 'the child process to exit');
      assert.equal(ofKind(output.messages, 'complete').length, 0);
    } finally {
      killQuietly(childPid);
    }
  });
});

test('abort kills a helper that ignores SIGTERM even though agy itself exited at once', async () => {
  await withAgySandbox(async (sandbox) => {
    process.env.FAKE_AGY_SCENARIO = 'abort-helper-ignores-sigterm';
    const output = createWriter();
    const turn = agyRuntime.run('Work', { sessionId: APP_SESSION_ID, cwd: sandbox.project }, output.writer, createContext());
    let helperPid: number | null = null;
    try {
      // The fake reports init only once the helper's SIGTERM handler is in place.
      await waitFor(() => output.boundSessionIds.length === 1, 10_000, 'the fake agy to start its helper');
      helperPid = readChildPid(sandbox.childPidFile);
      assert.ok(helperPid && isProcessAlive(helperPid));

      const startedAt = Date.now();
      assert.equal(await agyRuntime.abort(APP_SESSION_ID), true);
      await turn;
      // The abort ends with agy's close, not after the kill delay ...
      assert.ok(Date.now() - startedAt < 4_000, 'the abort resolves once agy closed');
      // ... while the helper shrugged off SIGTERM and outlived agy ...
      assert.ok(isProcessAlive(helperPid as number), 'the helper survived SIGTERM');
      // ... until the group SIGKILL, which follows the kill delay whatever agy did.
      await waitFor(() => !isProcessAlive(helperPid as number), 7_000, 'the helper to be killed');
      assert.equal(ofKind(output.messages, 'complete').length, 0);
    } finally {
      // Stops agy if anything above failed; answers false otherwise.
      await agyRuntime.abort(APP_SESSION_ID);
      await turn.catch(() => undefined);
      killQuietly(helperPid);
    }
  });
});

test('an abort calls off the group SIGKILL once nothing of agy\'s process group is left', async (t) => {
  await withAgySandbox(async (sandbox) => {
    // agy alone, without helpers: nothing of its group outlives its close.
    process.env.FAKE_AGY_SCENARIO = 'abort-before-read';
    writeFileSync(sandbox.gateFile, '');
    const output = createWriter();
    const turn = agyRuntime.run('Work', { sessionId: APP_SESSION_ID, cwd: sandbox.project }, output.writer, createContext());
    try {
      await waitFor(() => output.boundSessionIds.length === 1, 10_000, 'the fake agy to start');

      const kill = t.mock.method(process, 'kill');
      t.mock.timers.enable({ apis: ['setTimeout'] });
      try {
        assert.equal(await agyRuntime.abort(APP_SESSION_ID), true);
        await turn;
        // Far past the kill delay: a group that is gone is never signalled
        // again, so a reused group id cannot be hit.
        t.mock.timers.tick(60_000);
      } finally {
        t.mock.timers.reset();
      }
      const groupSignals = kill.mock.calls
        .filter((call) => call.arguments[0] < 0)
        .map((call) => call.arguments[1])
        // Signal 0 only asks whether the group still exists.
        .filter((signal) => signal !== 0);
      assert.deepEqual(groupSignals, ['SIGTERM']);
    } finally {
      // Stops agy if anything above failed; answers false otherwise.
      await agyRuntime.abort(APP_SESSION_ID);
      await turn.catch(() => undefined);
    }
  });
});

/**
 * Starts a new chat's turn and aborts it while agy's output is in the pipe
 * but still unread, as when a Stop click is handled before the runtime gets
 * to agy's first lines. The gated scenario writes its output only once the
 * test opens the gate (see fake-agy.mjs).
 */
async function abortWithOutputUnread(sandbox: AgySandbox, scenario: string): Promise<ReturnType<typeof createWriter>> {
  process.env.FAKE_AGY_SCENARIO = scenario;
  const output = createWriter();
  const turn = agyRuntime.run('Work', { sessionId: APP_SESSION_ID, cwd: sandbox.project }, output.writer, createContext());
  try {
    await waitFor(() => existsSync(sandbox.argvFile), 10_000, 'the fake agy to start');
    // The event loop stays blocked from here until the abort is requested,
    // so the runtime cannot read agy's lines before the turn is aborted.
    writeFileSync(sandbox.gateFile, '');
    waitForSync(() => existsSync(sandbox.readyFile), 10_000, 'the fake agy to write its output');
    const aborting = agyRuntime.abort(APP_SESSION_ID);
    assert.deepEqual(output.messages, [], 'nothing was read before the abort');

    assert.equal(await aborting, true);
    await turn;
    return output;
  } finally {
    // Stops agy if an assertion above failed; answers false otherwise.
    await agyRuntime.abort(APP_SESSION_ID);
    await turn.catch(() => undefined);
  }
}

test('an abort handled before agy\'s init was read still binds the new chat, and shows nothing', async () => {
  await withAgySandbox(async (sandbox) => {
    const output = await abortWithOutputUnread(sandbox, 'abort-before-read');

    assert.deepEqual(output.boundSessionIds, [NEW_CONVERSATION_ID]);
    // session_created only records the mapping (the chat writer swallows
    // it); the text, the tool step and the result are dropped.
    assert.deepEqual(
      output.messages.map((message) => [message.kind, message.newSessionId]),
      [['session_created', NEW_CONVERSATION_ID]],
    );
  });
});

test('after an abort, a step update binds the new chat when no init was read', async () => {
  await withAgySandbox(async (sandbox) => {
    const output = await abortWithOutputUnread(sandbox, 'abort-before-read-no-init');

    assert.deepEqual(output.boundSessionIds, [NEW_CONVERSATION_ID]);
    assert.deepEqual(output.messages.map((message) => message.kind), ['session_created']);
  });
});

test('abort while the turn is still resolving its model stops it before agy starts', async () => {
  await withAgySandbox(async (sandbox) => {
    let releaseModel: (model: string | undefined) => void = () => undefined;
    const output = createWriter();
    const turn = agyRuntime.run('Work', { sessionId: APP_SESSION_ID, cwd: sandbox.project }, output.writer, createContext({
      resolveResumeModel: () => new Promise((resolve) => { releaseModel = resolve; }),
    }));

    const aborting = agyRuntime.abort(APP_SESSION_ID);
    releaseModel('auto');
    assert.equal(await aborting, true);
    await turn;

    assert.deepEqual(output.messages, []);
    assert.deepEqual(await readLaunches(sandbox.argvFile), []);
  });
});

test('a finished turn does not unregister a newer turn of the same session', async () => {
  await withAgySandbox(async (sandbox) => {
    const first = createWriter();
    const second = createWriter();
    let childPid: number | null = null;
    try {
      // Same app session: the second turn takes over the abort registration.
      const firstTurn = agyRuntime.run('scenario:new-session', { sessionId: APP_SESSION_ID, cwd: sandbox.project }, first.writer, createContext());
      const secondTurn = agyRuntime.run('scenario:abort', { sessionId: APP_SESSION_ID, cwd: sandbox.project }, second.writer, createContext());
      await firstTurn;
      assert.deepEqual(ofKind(first.messages, 'complete').map((message) => message.exitCode), [0]);

      await waitFor(() => existsSync(sandbox.childPidFile), 10_000, 'the second turn to start');
      childPid = readChildPid(sandbox.childPidFile);
      assert.equal(await agyRuntime.abort(APP_SESSION_ID), true, 'the second turn is still abortable');
      await secondTurn;
      assert.equal(ofKind(second.messages, 'complete').length, 0);
    } finally {
      killQuietly(childPid);
    }
  });
});

test('a helper that keeps agy\'s output open after agy exits does not hang the turn', async () => {
  await withAgySandbox(async (sandbox) => {
    process.env.FAKE_AGY_SCENARIO = 'lingering-child';
    let childPid: number | null = null;
    try {
      const startedAt = Date.now();
      const turn = await runTurn('Hi', { cwd: sandbox.project });
      childPid = readChildPid(sandbox.childPidFile);

      assert.equal(turn.rejected, null);
      assert.deepEqual(ofKind(turn.messages, 'complete').map((message) => message.exitCode), [0]);
      assert.ok(Date.now() - startedAt < 10_000);
    } finally {
      killQuietly(childPid);
    }
  });
});

test('abort for a session with nothing running answers false', async () => {
  assert.equal(await agyRuntime.abort('no-such-session'), false);
});
