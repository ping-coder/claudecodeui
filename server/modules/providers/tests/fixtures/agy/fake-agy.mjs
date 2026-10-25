#!/usr/bin/env node
/**
 * Test double for the Antigravity CLI (`agy`), injected through AGY_CLI_PATH.
 * The real binary is never run by tests.
 *
 * Every invocation appends one JSON line `{ argv, cwd }` to the file named by
 * FAKE_AGY_ARGV_FILE (when set). `agy models` (or the `models` scenario)
 * prints "Fetching available models..." and then `id<TAB>label` rows;
 * anything else replays a stream-json scenario, named by a prompt that starts
 * with `scenario:<name>` (so concurrent runs can differ), else by
 * FAKE_AGY_SCENARIO, else `new-session`:
 *
 * - new-session            a fresh conversation: init (full UUID), text, result
 * - resume                 replays stream-resume-read-file.jsonl verbatim
 * - tool-done-first        a tool DONE with no ACTIVE, plus repeated ACTIVE/DONE
 * - unknown-step-type      a step_update whose step_type nobody knows
 * - partial-lines          JSON lines split across chunks (mid-line and
 *                          mid-character), the last one without a newline
 * - failed-result          result status ERROR with a partial response, exit 0
 * - error-exit-3           an AGY_ERROR line and exit code 3
 * - stderr-exit-1          ANSI-styled stderr and exit code 1, no result
 * - abort                  init, then a child process, then hangs
 * - abort-ignores-sigterm  like abort, but agy and its child ignore SIGTERM
 * - abort-helper-ignores-sigterm
 *                          agy obeys SIGTERM but its child ignores it; init is
 *                          written once the child's SIGTERM handler is in place
 * - abort-before-read      once FAKE_AGY_GATE_FILE exists: init, text, a tool
 *                          step and a result in one write, then creates
 *                          FAKE_AGY_READY_FILE and hangs
 * - abort-before-read-no-init
 *                          the same without init (the steps carry the id)
 * - lingering-child        a successful turn that leaves a child holding stdout
 * - models-fail            (`agy models`) prints a banner, then exits 1
 * - models-lingering       (`agy models`) lists models, leaves a child holding stdout
 *
 * Scenarios that start a child (abort, abort-*sigterm, *lingering*) write its
 * pid to FAKE_AGY_CHILD_PID_FILE so tests can check on it and clean it up.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
if (process.env.FAKE_AGY_ARGV_FILE) {
  appendFileSync(process.env.FAKE_AGY_ARGV_FILE, `${JSON.stringify({ argv, cwd: process.cwd() })}\n`);
}

const prompt = argv[0] === '-p' ? String(argv[1] ?? '').trim() : '';
const scenario = /^scenario:([\w-]+)/.exec(prompt)?.[1] || process.env.FAKE_AGY_SCENARIO || 'new-session';
const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const conversationId = process.env.FAKE_AGY_CONVERSATION_ID || '3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b';
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const emit = (event) => { process.stdout.write(`${JSON.stringify(event)}\n`); };

const init = () => ({
  event: 'init',
  conversation_id: conversationId,
  init: { model: 'auto', cwd: process.cwd(), tools: ['read_file', 'run_command'], permission_mode: 'default' },
});
const step = (fields) => ({ event: 'step_update', step_update: { conversation_id: conversationId, ...fields } });
const result = (fields = {}) => ({
  event: 'result',
  result: {
    conversation_id: conversationId,
    status: 'SUCCESS',
    response: 'Hello from agy',
    duration_seconds: 3.2,
    num_turns: 1,
    usage: { input_tokens: 9000, output_tokens: 40, thinking_tokens: 12, cache_read_tokens: 1000, total_tokens: 9040 },
    ...fields,
  },
});

const textTurn = (text = ['Hello', ' from agy']) => [
  init(),
  step({ step_index: 0, state: 'DONE', step_type: 'user_input' }),
  step({ step_index: 1, state: 'DONE', step_type: 'system_message', duration_seconds: 0.001 }),
  step({ step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: text[0] }),
  step({
    step_index: 2,
    state: 'DONE',
    step_type: 'agent_response',
    text_delta: text[1],
    duration_seconds: 1.5,
    usage: { input_tokens: 1200, output_tokens: 30, thinking_tokens: 10, cache_read_tokens: 800, total_tokens: 1230 },
  }),
  result({ response: text.join('') }),
];

// A child in agy's process group, as a tool or language server would be.
// With `reportReady` it reports over IPC once it runs, so its SIGTERM handler
// is in place by then (see waitUntilReady).
const spawnChild = ({ ignoreSigterm = false, holdOutput = false, reportReady = false } = {}) => {
  const script = [
    ignoreSigterm ? "process.on('SIGTERM', () => {});" : '',
    reportReady ? "process.send('ready');" : '',
    'setInterval(() => {}, 1000);',
  ].join(' ');
  // `inherit` hands the child agy's own stdout/stderr pipes.
  const output = holdOutput ? 'inherit' : 'ignore';
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', output, output, ...(reportReady ? ['ipc'] : [])],
  });
  if (process.env.FAKE_AGY_CHILD_PID_FILE) {
    writeFileSync(process.env.FAKE_AGY_CHILD_PID_FILE, String(child.pid));
  }
  return child;
};

// Resolves once a `reportReady` child runs (or died), then closes the IPC
// channel so it ties neither process to the other.
const waitUntilReady = (child) => new Promise((resolve) => {
  const done = () => {
    if (child.connected) {
      child.disconnect();
    }
    resolve();
  };
  child.once('message', done);
  child.once('exit', done);
});

// Writes every line in one synchronous write once FAKE_AGY_GATE_FILE exists,
// then creates FAKE_AGY_READY_FILE: once a test sees that file, all of them
// are in the pipe, whether or not the runtime has read them yet.
const writeWhenGateOpens = async (events) => {
  const gateFile = process.env.FAKE_AGY_GATE_FILE;
  while (gateFile && !existsSync(gateFile)) {
    await sleep(5);
  }
  writeSync(1, events.map((event) => `${JSON.stringify(event)}\n`).join(''));
  if (process.env.FAKE_AGY_READY_FILE) {
    writeFileSync(process.env.FAKE_AGY_READY_FILE, '');
  }
};

// What a turn aborted before any of it was read still has in the pipe.
const outputUnreadAtAbort = () => [
  init(),
  step({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'must not show' }),
  step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } }),
  result({ response: 'must not show' }),
];

const runModels = () => {
  process.stdout.write('Fetching available models...\n');
  if (scenario === 'models-fail') {
    process.stderr.write('Error: not signed in\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write([
    'auto\tGemini Pro Next',
    'gemini-3.5-flash-lite\tGemini 3.5 Flash Lite',
    'gemini-launch-candidate-high\tGemini 4 Argon (High)',
    'opus-5.5-max\tClaude Opus 5.5 (Max)',
    '',
    'not a model row',
    '--evil\tFlag Lookalike',
    '',
  ].join('\n'));
  if (scenario === 'models-lingering') {
    spawnChild({ holdOutput: true }).unref();
  }
};

const scenarios = {
  'new-session': async () => {
    textTurn().forEach(emit);
  },

  resume: async () => {
    process.stdout.write(readFileSync(path.join(fixtureDirectory, 'stream-resume-read-file.jsonl'), 'utf8'));
  },

  'tool-done-first': async () => {
    const toolInfo = { name: 'read_file', parameters: { Path: '/tmp/agy-probe/notes.txt' } };
    [
      init(),
      step({ step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'read_file', tool_info: { ...toolInfo, output: '3 lines' } }),
      step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } }),
      step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } }),
      step({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' }, output: 'a\nb' } }),
      step({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' }, output: 'a\nb' } }),
      step({ step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: 'Done.' }),
      result({ response: 'Done.' }),
    ].forEach(emit);
  },

  'unknown-step-type': async () => {
    [
      init(),
      step({ step_index: 1, state: 'DONE', step_type: 'telepathy', text_delta: 'must not show' }),
      step({ step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'After the unknown step' }),
      step({ step_index: 2, state: 'DONE', step_type: 'agent_response' }),
      result({ response: 'After the unknown step' }),
    ].forEach(emit);
  },

  'partial-lines': async () => {
    const payload = Buffer.from(textTurn(['Split … 你好', ' – reassembled']).map((event) => JSON.stringify(event)).join('\n'));
    // Seven-byte chunks land mid-line and inside multi-byte characters; the
    // final line has no newline and is only complete when agy exits.
    for (let offset = 0; offset < payload.length; offset += 7) {
      process.stdout.write(payload.subarray(offset, offset + 7));
      await sleep(1);
    }
  },

  'failed-result': async () => {
    [
      init(),
      step({ step_index: 0, state: 'DONE', step_type: 'user_input' }),
      result({ status: 'ERROR', response: 'Partial answer before the failure' }),
    ].forEach(emit);
  },

  'error-exit-3': async () => {
    emit(init());
    process.stdout.write('AGY_ERROR: conversation could not be resumed: not found\n');
    process.stderr.write('\u001b[31mtrace\u001b[0m: resume failed\n');
    process.exitCode = 3;
  },

  'stderr-exit-1': async () => {
    emit(init());
    process.stderr.write('\u001b[1;31mError:\u001b[0m quota exhausted for this account\n');
    process.exitCode = 1;
  },

  abort: async () => {
    spawnChild();
    emit(init());
    emit(step({ step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Working on it' }));
    setInterval(() => {}, 1000);
  },

  'abort-ignores-sigterm': async () => {
    process.on('SIGTERM', () => {});
    spawnChild({ ignoreSigterm: true });
    emit(init());
    setInterval(() => {}, 1000);
  },

  'abort-helper-ignores-sigterm': async () => {
    // agy itself dies of SIGTERM; its child survives it and holds none of
    // agy's output, so agy closes at once while the child runs on.
    await waitUntilReady(spawnChild({ ignoreSigterm: true, reportReady: true }));
    emit(init());
    setInterval(() => {}, 1000);
  },

  'abort-before-read': async () => {
    await writeWhenGateOpens(outputUnreadAtAbort());
    setInterval(() => {}, 1000);
  },

  'abort-before-read-no-init': async () => {
    await writeWhenGateOpens(outputUnreadAtAbort().slice(1));
    setInterval(() => {}, 1000);
  },

  'lingering-child': async () => {
    textTurn().forEach(emit);
    spawnChild({ holdOutput: true }).unref();
  },
};

if (argv[0] === 'models' || scenario === 'models') {
  runModels();
} else {
  const run = scenarios[scenario];
  if (!run) {
    process.stderr.write(`fake agy: unknown scenario ${scenario}\n`);
    process.exitCode = 2;
  } else {
    await run();
  }
}
