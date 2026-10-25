import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { AgySessionsProvider } from '@/modules/providers/list/agy/agy-sessions.provider.js';
import {
  type AgyTestRoots,
  AGY_FIXTURE_DIRECTORY,
  agyTranscriptDirectory,
  createAgyTestRoots,
  placeAgyTranscript,
  snapshotTree,
} from '@/modules/providers/tests/fixtures/agy/agy-test-roots.js';
import type { NormalizedMessage } from '@/shared/types.js';

const CONVERSATION_ID = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const SHORT_CONVERSATION_ID = '0b8f6a9e-1c2d-4e3f-8a5b-6c7d8e9f0a1b';
const C = CONVERSATION_ID;

const provider = new AgySessionsProvider();

async function withAgyRoots(run: (roots: AgyTestRoots) => Promise<void>): Promise<void> {
  const roots = await createAgyTestRoots();
  try {
    await run(roots);
  } finally {
    await roots.restore();
  }
}

/** The fields a row is drawn from, without the envelope noise. */
function project(message: NormalizedMessage): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    id: message.id,
    kind: message.kind,
    role: message.role,
    content: message.content,
    toolName: message.toolName,
    toolInput: message.toolInput,
    toolId: message.toolId,
    toolResult: message.toolResult,
    isError: message.isError,
    images: message.images,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function readStreamFixture(): unknown[] {
  return fs.readFileSync(path.join(AGY_FIXTURE_DIRECTORY, 'stream-resume-read-file.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as unknown);
}

function liveToolStep(
  stepIndex: number | undefined,
  state: string,
  name: string,
  parameters: Record<string, unknown>,
  output?: unknown,
): unknown {
  return {
    event: 'step_update',
    step_update: {
      conversation_id: C,
      step_index: stepIndex,
      state,
      step_type: 'tool',
      tool_name: name,
      tool_info: { name, parameters, ...(output === undefined ? {} : { output }) },
    },
  };
}

const EXPECTED_HISTORY = [
  { id: `agy:${C}:1:text`, kind: 'text', role: 'user', content: 'Read /tmp/agy-probe/hello.txt and list the folder' },
  { id: `agy:${C}:2:thinking`, kind: 'thinking', content: 'The user wants the file contents and a folder listing.' },
  { id: `agy:${C}:2:text`, kind: 'text', role: 'assistant', content: "I'll read the file and list the folder." },
  {
    id: `agy:${C}:3:tool`,
    kind: 'tool_use',
    toolName: 'Read',
    toolInput: { file_path: '/tmp/agy-probe/hello.txt' },
    toolId: `${C}:3`,
    toolResult: { content: 'probe-content-42\n', isError: false },
  },
  {
    id: `agy:${C}:4:tool`,
    kind: 'tool_use',
    toolName: 'Bash',
    toolInput: { command: 'ls -la /tmp/agy-probe' },
    toolId: `${C}:4`,
    toolResult: { content: 'total 8\n-rw-r--r-- 1 me me 17 Oct 25 20:56 hello.txt\n', isError: false },
  },
  { id: `agy:${C}:5:text`, kind: 'text', role: 'assistant', content: 'The file says probe-content-42.' },
  {
    id: `agy:${C}:6:text`,
    kind: 'text',
    role: 'user',
    content: 'Update the greeting in the file from the screenshot',
    images: [{ path: '/home/me/.cloudcli/assets/shot.png', name: 'shot.png' }],
  },
  {
    id: `agy:${C}:9#0:tool`,
    kind: 'tool_use',
    toolName: 'Edit',
    toolInput: { file_path: '/tmp/agy-probe/hello.txt', old_string: 'probe', new_string: 'hello' },
    toolId: `${C}:9#0`,
    toolResult: { content: 'The file /tmp/agy-probe/hello.txt has been updated.', isError: false },
  },
  {
    id: `agy:${C}:9#1:tool`,
    kind: 'tool_use',
    toolName: 'Edit',
    toolInput: { file_path: '/tmp/agy-probe/hello.txt', old_string: '42', new_string: '43' },
    toolId: `${C}:9#1`,
    toolResult: { content: 'The file /tmp/agy-probe/hello.txt has been updated.', isError: false },
  },
  {
    id: `agy:${C}:11:tool`,
    kind: 'tool_use',
    toolName: 'Write',
    toolInput: { file_path: '/tmp/agy-probe/notes.md', content: '# Notes\nline two\n' },
    toolId: `${C}:11`,
    toolResult: { content: 'Created file /tmp/agy-probe/notes.md', isError: false },
  },
  {
    id: `agy:${C}:12:tool`,
    kind: 'tool_use',
    toolName: 'WebSearch',
    toolInput: { query: 'antigravity cli stream-json' },
    toolId: `${C}:12`,
    toolResult: { content: 'search quota exceeded', isError: true },
  },
  {
    id: `agy:${C}:14:tool`,
    kind: 'tool_use',
    toolName: 'WebFetch',
    toolInput: { url: 'https://example.com/docs' },
    toolId: `${C}:14`,
    toolResult: { content: '<html>docs</html>', isError: false },
  },
  {
    id: `agy:${C}:15:tool`,
    kind: 'tool_use',
    toolName: 'list_dir',
    toolInput: { directory_path: '/tmp/agy-probe', recursive: false },
    toolId: `${C}:15`,
    toolResult: { content: 'hello.txt\nnotes.md', isError: false },
  },
  { id: `agy:${C}:16:text`, kind: 'text', role: 'user', content: 'Now run the tests' },
  { id: `agy:${C}:17:text`, kind: 'text', role: 'assistant', content: 'Running the tests now.' },
  // Its GENERIC step has not been written yet: a provisional id, no result.
  { id: `agy:${C}:17-0:tool`, kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'npm test' }, toolId: `${C}:17-0` },
];

test('fetchHistory turns the transcript into chat rows: prompts unwrapped, tools paired, system steps hidden', async () => {
  await withAgyRoots(async ({ legacyRoot }) => {
    placeAgyTranscript(legacyRoot, CONVERSATION_ID);

    const result = await provider.fetchHistory('app-session', { providerSessionId: CONVERSATION_ID, limit: null });

    assert.deepEqual(result.messages.map(project), EXPECTED_HISTORY);
    assert.equal(result.total, EXPECTED_HISTORY.length);
    assert.equal(result.hasMore, false);
    assert.ok(result.messages.every((message) => message.sessionId === 'app-session' && message.provider === 'agy'));
    // No system prompt and no agy envelope leaks into what the user sees.
    const shownText = JSON.stringify(result.messages);
    assert.doesNotMatch(shownText, /You are Antigravity|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|USER_REQUEST|images_input/);
  });
});

test('fetchHistory keeps each step on its transcript time', async () => {
  await withAgyRoots(async ({ legacyRoot }) => {
    placeAgyTranscript(legacyRoot, CONVERSATION_ID);

    const { messages } = await provider.fetchHistory('app-session', { providerSessionId: CONVERSATION_ID, limit: null });
    const timestampById = new Map(messages.map((message) => [message.id, message.timestamp]));

    assert.equal(timestampById.get(`agy:${C}:1:text`), '2026-10-25T12:56:31.123Z');
    assert.equal(timestampById.get(`agy:${C}:5:text`), '2026-10-25T12:56:42.887Z');
    // Go's text format, as agy may write it.
    assert.equal(timestampById.get(`agy:${C}:16:text`), '2026-10-25T13:05:00.500Z');
    // Step 13 has no created_at: it takes the time of the step before it.
    assert.equal(timestampById.get(`agy:${C}:14:tool`), '2026-10-25T13:00:09.000Z');
  });
});

test('fetchHistory pages from the end: null is everything, 0 an empty page, offset skips the newest', async () => {
  await withAgyRoots(async ({ legacyRoot }) => {
    placeAgyTranscript(legacyRoot, CONVERSATION_ID);
    const fetchPage = (limit: number | null, offset?: number) => provider.fetchHistory('app-session', {
      providerSessionId: CONVERSATION_ID,
      limit,
      offset,
    });
    const allIds = EXPECTED_HISTORY.map((message) => message.id);

    const everything = await fetchPage(null);
    assert.deepEqual(everything.messages.map((message) => message.id), allIds);
    assert.equal(everything.limit, null);

    const empty = await fetchPage(0);
    assert.deepEqual(empty.messages, []);
    assert.equal(empty.hasMore, true);
    assert.equal(empty.total, allIds.length);

    const newest = await fetchPage(5);
    assert.deepEqual(newest.messages.map((message) => message.id), allIds.slice(-5));
    assert.equal(newest.hasMore, true);
    assert.equal(newest.offset, 0);
    assert.equal(newest.limit, 5);

    const oldest = await fetchPage(5, 14);
    assert.deepEqual(oldest.messages.map((message) => message.id), allIds.slice(0, 2));
    assert.equal(oldest.hasMore, false);
    assert.equal(oldest.offset, 14);

    const beyond = await fetchPage(5, 100);
    assert.deepEqual(beyond.messages, []);
    assert.equal(beyond.hasMore, false);
  });
});

test('fetchHistory reports the context usage of the latest response', async () => {
  await withAgyRoots(async ({ legacyRoot }) => {
    placeAgyTranscript(legacyRoot, CONVERSATION_ID);

    const result = await provider.fetchHistory('app-session', { providerSessionId: CONVERSATION_ID, limit: 1 });

    assert.deepEqual(result.tokenUsage, {
      used: 23_030,
      inputTokens: 23_000,
      outputTokens: 30,
      breakdown: { input: 23_000, output: 30 },
    });
  });
});

test('fetchHistory shows a shortened transcript with its cut fields marked', async () => {
  await withAgyRoots(async ({ cliRoot }) => {
    placeAgyTranscript(cliRoot, SHORT_CONVERSATION_ID, 'transcript.jsonl');
    const S = SHORT_CONVERSATION_ID;

    const result = await provider.fetchHistory('app-session', { providerSessionId: S, limit: null });

    assert.deepEqual(result.messages.map(project), [
      { id: `agy:${S}:0:text`, kind: 'text', role: 'user', content: 'Summarize the design doc' },
      { id: `agy:${S}:1:thinking`, kind: 'thinking', content: 'Long thinking that was cut sh\n… (truncated)' },
      {
        id: `agy:${S}:1:text`,
        kind: 'text',
        role: 'assistant',
        content: 'The design doc describes a five-provider archi\n… (truncated)',
      },
      {
        id: `agy:${S}:2:tool`,
        kind: 'tool_use',
        toolName: 'Read',
        toolInput: { file_path: '/tmp/agy-probe/design.md' },
        toolId: `${S}:2`,
        toolResult: { content: '# Design\nSection one is very lo\n… (truncated)', isError: false },
      },
      { id: `agy:${S}:3:text`, kind: 'text', role: 'assistant', content: 'Done.' },
    ]);
  });
});

test('fetchHistory prefers the full transcript when both exist', async () => {
  await withAgyRoots(async ({ legacyRoot }) => {
    placeAgyTranscript(legacyRoot, CONVERSATION_ID);
    placeAgyTranscript(legacyRoot, CONVERSATION_ID, 'transcript.jsonl');

    const result = await provider.fetchHistory('app-session', { providerSessionId: CONVERSATION_ID, limit: null });

    assert.equal(result.total, EXPECTED_HISTORY.length);
  });
});

test('fetchHistory finds the conversation by its provider id and is empty without a transcript', async () => {
  await withAgyRoots(async ({ legacyRoot }) => {
    placeAgyTranscript(legacyRoot, CONVERSATION_ID);

    // Discovered from disk: the app id is the conversation id.
    const discovered = await provider.fetchHistory(CONVERSATION_ID, { limit: 2 });
    assert.equal(discovered.total, EXPECTED_HISTORY.length);

    for (const providerSessionId of [SHORT_CONVERSATION_ID, '../../etc/passwd', 'not-a-uuid']) {
      assert.deepEqual(await provider.fetchHistory('app-session', { providerSessionId, limit: 20, offset: 0 }), {
        messages: [],
        total: 0,
        hasMore: false,
        offset: 0,
        limit: 20,
      });
    }
  });
});

test('fetchHistory never modifies the data root', async () => {
  await withAgyRoots(async ({ legacyRoot }) => {
    placeAgyTranscript(legacyRoot, CONVERSATION_ID);
    placeAgyTranscript(legacyRoot, SHORT_CONVERSATION_ID, 'transcript.jsonl');
    const before = snapshotTree(legacyRoot);

    await provider.fetchHistory('app-session', { providerSessionId: CONVERSATION_ID, limit: null });
    await provider.fetchHistory('app-session', { providerSessionId: SHORT_CONVERSATION_ID, limit: 3 });

    assert.deepEqual(snapshotTree(legacyRoot), before);
  });
});

test('normalizeMessage maps the verbatim stream sample of a resumed read_file run', () => {
  const sampleId = '72cc0cfd-…';
  const mapped = readStreamFixture().map((event) => provider.normalizeMessage(event, 'app-session'));

  assert.deepEqual(mapped.map((messages) => messages.map(project)), [
    // init
    [],
    // user_input: the composer already shows the prompt
    [],
    // system_message
    [],
    // agent_response DONE without text (the step that called the tool)
    [{ id: `agy:${sampleId}:4:end`, kind: 'stream_end' }],
    // tool ACTIVE
    [{
      id: `agy:${sampleId}:5:tool`,
      kind: 'tool_use',
      toolName: 'Read',
      toolInput: { file_path: '/tmp/agy-probe/hello.txt' },
      toolId: `${sampleId}:5`,
    }],
    // tool DONE
    [{
      id: `agy:${sampleId}:5:result`,
      kind: 'tool_result',
      toolId: `${sampleId}:5`,
      content: '1 lines, 17 bytes',
      isError: false,
    }],
    [{ id: `agy:${sampleId}:6:text`, kind: 'stream_delta', content: 'probe-content-42' }],
    [
      { id: `agy:${sampleId}:6:text`, kind: 'stream_delta', content: '\n' },
      { id: `agy:${sampleId}:6:end`, kind: 'stream_end' },
    ],
    // result
    [],
  ]);
  assert.ok(mapped.flat().every((message) => message.sessionId === 'app-session' && message.provider === 'agy'));
});

test('live tool and text ids match the ids history gives the same steps', async () => {
  await withAgyRoots(async ({ legacyRoot }) => {
    placeAgyTranscript(legacyRoot, CONVERSATION_ID);
    const { messages } = await provider.fetchHistory('app-session', { providerSessionId: CONVERSATION_ID, limit: null });
    const historyRead = messages.find((message) => message.toolName === 'Read');
    const historyText = messages.find((message) => message.content === 'The file says probe-content-42.');

    const [liveRead] = provider.normalizeMessage(
      liveToolStep(3, 'ACTIVE', 'read_file', { Path: '/tmp/agy-probe/hello.txt' }),
      'app-session',
    );
    const [liveResult] = provider.normalizeMessage(
      liveToolStep(3, 'DONE', 'read_file', { Path: '/tmp/agy-probe/hello.txt' }, '1 lines, 17 bytes'),
      'app-session',
    );
    const [liveText] = provider.normalizeMessage({
      event: 'step_update',
      step_update: { conversation_id: C, step_index: 5, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'The file' },
    }, 'app-session');

    assert.equal(liveRead.id, historyRead?.id);
    assert.equal(liveRead.toolId, historyRead?.toolId);
    assert.deepEqual(liveRead.toolInput, historyRead?.toolInput);
    assert.equal(liveResult.toolId, historyRead?.toolId);
    assert.equal(liveText.id, historyText?.id);
  });
});

test('normalizeMessage maps live tools onto the canonical renderers', () => {
  const toolUse = (stepIndex: number, name: string, parameters: Record<string, unknown>) => provider
    .normalizeMessage(liveToolStep(stepIndex, 'ACTIVE', name, parameters), 'app-session')
    .map((message) => ({ toolName: message.toolName, toolInput: message.toolInput, toolId: message.toolId }));

  assert.deepEqual(toolUse(1, 'view_file', { AbsolutePath: '/w/a.ts' }), [
    { toolName: 'Read', toolInput: { file_path: '/w/a.ts' }, toolId: `${C}:1` },
  ]);
  assert.deepEqual(toolUse(2, 'read_file', { file_path: '/w/b.ts' })[0].toolInput, { file_path: '/w/b.ts' });
  assert.deepEqual(toolUse(3, 'run_command', { CommandLine: 'npm test', Cwd: '/w', Description: 'Run the tests' }), [
    { toolName: 'Bash', toolInput: { command: 'npm test', description: 'Run the tests' }, toolId: `${C}:3` },
  ]);
  assert.deepEqual(toolUse(4, 'run_command', { command: 'ls' })[0].toolInput, { command: 'ls' });
  assert.deepEqual(toolUse(5, 'write_to_file', { TargetFile: '/w/x.md', CodeContent: '# x\n' }), [
    { toolName: 'Write', toolInput: { file_path: '/w/x.md', content: '# x\n' }, toolId: `${C}:5` },
  ]);
  assert.deepEqual(toolUse(6, 'multi_replace_file_content', {
    TargetFile: '/w/y.ts',
    ReplacementChunks: [
      { TargetContent: 'a', ReplacementContent: 'b' },
      { TargetContent: 'c', ReplacementContent: 'd' },
    ],
  }), [
    { toolName: 'Edit', toolInput: { file_path: '/w/y.ts', old_string: 'a', new_string: 'b' }, toolId: `${C}:6#0` },
    { toolName: 'Edit', toolInput: { file_path: '/w/y.ts', old_string: 'c', new_string: 'd' }, toolId: `${C}:6#1` },
  ]);
  assert.deepEqual(toolUse(7, 'replace_file_content', {
    TargetFile: '/w/z.ts',
    TargetContent: 'old',
    ReplacementContent: 'new',
  }), [
    { toolName: 'Edit', toolInput: { file_path: '/w/z.ts', old_string: 'old', new_string: 'new' }, toolId: `${C}:7` },
  ]);
  assert.deepEqual(toolUse(8, 'search_web', { Query: 'agy docs' })[0], {
    toolName: 'WebSearch',
    toolInput: { query: 'agy docs' },
    toolId: `${C}:8`,
  });
  assert.deepEqual(toolUse(9, 'read_url_content', { Url: 'https://example.com' })[0].toolInput, { url: 'https://example.com' });
  // Live values are raw: a boolean stays a boolean, and text that looks like
  // JSON stays text (only the transcript JSON-encodes its values).
  assert.deepEqual(toolUse(10, 'grep_search', { SearchPath: '/w', Query: 'foo', MatchPerLine: true, Includes: 'true' })[0], {
    toolName: 'grep_search',
    toolInput: { search_path: '/w', query: 'foo', match_per_line: true, includes: 'true' },
    toolId: `${C}:10`,
  });
  assert.deepEqual(toolUse(11, 'mcp__github__create_issue', { Title: 'Bug' })[0].toolName, 'mcp__github__create_issue');
  assert.deepEqual(toolUse(11, 'mcp__github__create_issue', { Title: 'Bug' })[0].toolInput, { Title: 'Bug' });
  // Never a subagent or workflow card for a raw tool.
  assert.equal(toolUse(12, 'Task', { Prompt: 'x' })[0].toolName, 'agy_Task');
  assert.equal(toolUse(13, 'Workflow', {})[0].toolName, 'agy_Workflow');
});

test('normalizeMessage keeps raw live parameters as they are: JSON file content, quoted queries, JSON-looking edits', () => {
  const toolInput = (stepIndex: number, name: string, parameters: Record<string, unknown>) => provider
    .normalizeMessage(liveToolStep(stepIndex, 'ACTIVE', name, parameters), 'app-session')
    .map((message) => message.toolInput);
  const packageJson = '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n';

  assert.deepEqual(toolInput(1, 'write_to_file', { TargetFile: '/w/package.json', CodeContent: packageJson }), [
    { file_path: '/w/package.json', content: packageJson },
  ]);
  assert.deepEqual(toolInput(2, 'write_to_file', { TargetFile: '/w/empty.json', CodeContent: 'null' }), [
    { file_path: '/w/empty.json', content: 'null' },
  ]);
  assert.deepEqual(toolInput(3, 'search_web', { query: '"antigravity cli"' }), [{ query: '"antigravity cli"' }]);
  assert.deepEqual(toolInput(4, 'search_web', { Query: '"exact phrase" docs' }), [{ query: '"exact phrase" docs' }]);
  assert.deepEqual(toolInput(5, 'replace_file_content', {
    TargetFile: '/w/data.json',
    TargetContent: '[1, 2]',
    ReplacementContent: '[1, 2, 3]',
  }), [{ file_path: '/w/data.json', old_string: '[1, 2]', new_string: '[1, 2, 3]' }]);
  assert.deepEqual(toolInput(6, 'run_command', { CommandLine: '1e3' }), [{ command: '1e3' }]);
  // Chunks sent as a JSON string are still split into one row per chunk.
  assert.deepEqual(toolInput(7, 'multi_replace_file_content', {
    TargetFile: '/w/version.json',
    ReplacementChunks: JSON.stringify([
      { TargetContent: '"1.0.0"', ReplacementContent: '"1.1.0"' },
      { TargetContent: '{}', ReplacementContent: '{ "a": 1 }' },
    ]),
  }), [
    { file_path: '/w/version.json', old_string: '"1.0.0"', new_string: '"1.1.0"' },
    { file_path: '/w/version.json', old_string: '{}', new_string: '{ "a": 1 }' },
  ]);
});

test('a live JSON file write shows the same card as history, which decodes the transcript\'s encoded values', async () => {
  await withAgyRoots(async ({ legacyRoot }) => {
    const packageJson = '{\n  "name": "demo"\n}\n';
    const transcriptDirectory = agyTranscriptDirectory(legacyRoot, CONVERSATION_ID);
    fs.mkdirSync(transcriptDirectory, { recursive: true });
    const steps = [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nCreate package.json\n</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        content: '',
        tool_calls: [
          // The transcript JSON-encodes every argument value.
          { name: 'write_to_file', args: { TargetFile: JSON.stringify('/w/package.json'), CodeContent: JSON.stringify(packageJson) } },
          { name: 'search_web', args: { query: JSON.stringify('"antigravity cli"') } },
        ],
      },
      { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'Created file /w/package.json' },
      { step_index: 3, type: 'GENERIC', status: 'DONE', content: 'no results' },
    ];
    fs.writeFileSync(path.join(transcriptDirectory, 'transcript_full.jsonl'), steps.map((step) => JSON.stringify(step)).join('\n'));

    const { messages } = await provider.fetchHistory('app-session', { providerSessionId: CONVERSATION_ID, limit: null });
    const historyWrite = messages.find((message) => message.toolName === 'Write');
    const historySearch = messages.find((message) => message.toolName === 'WebSearch');
    const [liveWrite] = provider.normalizeMessage(
      liveToolStep(2, 'ACTIVE', 'write_to_file', { TargetFile: '/w/package.json', CodeContent: packageJson }),
      'app-session',
    );
    const [liveSearch] = provider.normalizeMessage(
      liveToolStep(3, 'ACTIVE', 'search_web', { query: '"antigravity cli"' }),
      'app-session',
    );

    assert.deepEqual(historyWrite?.toolInput, { file_path: '/w/package.json', content: packageJson });
    assert.deepEqual(liveWrite.toolInput, historyWrite?.toolInput);
    assert.equal(liveWrite.toolId, historyWrite?.toolId);
    assert.deepEqual(historySearch?.toolInput, { query: '"antigravity cli"' });
    assert.deepEqual(liveSearch.toolInput, historySearch?.toolInput);
  });
});

test('normalizeMessage reports finished and failed tools against every row of the call', () => {
  const edit = {
    TargetFile: '/w/y.ts',
    ReplacementChunks: [{ TargetContent: 'a', ReplacementContent: 'b' }, { TargetContent: 'c', ReplacementContent: 'd' }],
  };
  const results = provider.normalizeMessage(liveToolStep(6, 'DONE', 'replace_file_content', edit, { applied: 2 }), 's');
  assert.deepEqual(results.map(project), [
    { id: `agy:${C}:6#0:result`, kind: 'tool_result', toolId: `${C}:6#0`, content: '{\n  "applied": 2\n}', isError: false },
    { id: `agy:${C}:6#1:result`, kind: 'tool_result', toolId: `${C}:6#1`, content: '{\n  "applied": 2\n}', isError: false },
  ]);

  const [failed] = provider.normalizeMessage(liveToolStep(7, 'ERROR', 'run_command', { CommandLine: 'false' }, 'exit 1'), 's');
  assert.equal(failed.kind, 'tool_result');
  assert.equal(failed.isError, true);
  assert.equal(failed.content, 'exit 1');
});

test('normalizeMessage maps nothing for init, result, echoes, unpairable tools and unknown step types', (t) => {
  const debug = t.mock.method(console, 'debug', () => {});
  const unknownStep = { event: 'step_update', step_update: { conversation_id: C, step_index: 9, state: 'DONE', step_type: 'browser_snapshot' } };

  assert.deepEqual(provider.normalizeMessage({ event: 'init', conversation_id: C }, 's'), []);
  assert.deepEqual(provider.normalizeMessage({ event: 'result', result: { status: 'SUCCESS', response: 'hi' } }, 's'), []);
  assert.deepEqual(provider.normalizeMessage({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'user_input' } }, 's'), []);
  assert.deepEqual(provider.normalizeMessage({ event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'system_message' } }, 's'), []);
  assert.deepEqual(provider.normalizeMessage(liveToolStep(undefined, 'ACTIVE', 'read_file', { Path: '/a' }), 's'), []);
  assert.deepEqual(provider.normalizeMessage(liveToolStep(4, 'PENDING', 'read_file', { Path: '/a' }), 's'), []);
  assert.deepEqual(provider.normalizeMessage(unknownStep, 's'), []);
  assert.deepEqual(provider.normalizeMessage(unknownStep, 's'), []);
  assert.deepEqual(provider.normalizeMessage('not an event', 's'), []);
  assert.deepEqual(provider.normalizeMessage(null, 's'), []);

  assert.equal(debug.mock.callCount(), 1);
});

test('normalizeMessage closes the text bubble of a failed response step', () => {
  const messages = provider.normalizeMessage({
    event: 'step_update',
    step_update: { conversation_id: C, step_index: 8, state: 'ERROR', step_type: 'agent_response' },
  }, null);

  assert.deepEqual(messages.map(project), [{ id: `agy:${C}:8:end`, kind: 'stream_end' }]);
  assert.equal(messages[0].sessionId, C);
});
