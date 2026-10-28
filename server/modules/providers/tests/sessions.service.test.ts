import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { IProvider } from '@/shared/interfaces.js';
import type { BackgroundTaskSummary, NormalizedMessage, WorkflowInfo } from '@/shared/types.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-service-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('provider session id returns the mapped native id', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-session-id', 'codex', '/tmp/session-id-copy-project');
    sessionsDb.assignProviderSessionId('app-session-id', 'codex-native-session-id');

    assert.equal(sessionsService.getProviderSessionId('app-session-id'), 'codex-native-session-id');
  });
});

test('app session names use at most four whole words from the initial message', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    const result = sessionsService.createAppSession(
      'codex',
      '/tmp/session-name-project',
      '  supercalifragilisticexpialidocious\nsecond   third fourth fifth  ',
    );

    assert.equal(result.sessionName, 'supercalifragilisticexpialidocious second third fourth');
    assert.equal(
      sessionsDb.getSessionById(result.sessionId)?.custom_name,
      'supercalifragilisticexpialidocious second third fourth',
    );
  });
});

test('app sessions without message text receive a stable fallback name', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    const result = sessionsService.createAppSession('claude', '/tmp/attachment-only-project', '  \n ');

    assert.equal(result.sessionName, 'Untitled Session');
    assert.equal(sessionsDb.getSessionById(result.sessionId)?.custom_name, 'Untitled Session');
  });
});

test('provider session id is unavailable until the provider assigns one', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('pending-app-session', 'claude', '/tmp/session-id-copy-project');

    assert.throws(
      () => sessionsService.getProviderSessionId('pending-app-session'),
      (error: unknown) => {
        const typedError = error as { code?: string; statusCode?: number };
        return typedError.code === 'PROVIDER_SESSION_ID_NOT_AVAILABLE' && typedError.statusCode === 409;
      },
    );
  });
});

test('provider session id reports a missing app session', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    assert.throws(
      () => sessionsService.getProviderSessionId('missing-session'),
      (error: unknown) => {
        const typedError = error as { code?: string; statusCode?: number };
        return typedError.code === 'SESSION_NOT_FOUND' && typedError.statusCode === 404;
      },
    );
  });
});

test('recent sessions map project metadata and preserve database pagination', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession(
      'older-session',
      'claude',
      '/tmp/recent-project',
      'Older conversation',
      '2026-08-01T08:00:00.000Z',
      '2026-08-01T09:00:00.000Z',
    );
    sessionsDb.createSession(
      'newer-session',
      'codex',
      '/tmp/recent-project',
      'Newer conversation',
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T11:00:00.000Z',
    );
    projectsDb.updateCustomProjectName('/tmp/recent-project', 'Recent Project');

    const project = projectsDb.getProjectPath('/tmp/recent-project');
    const page = sessionsService.listRecentSessions(1, 0);

    assert.deepEqual(page, {
      conversations: [{
        sessionId: 'newer-session',
        provider: 'codex',
        projectId: project?.project_id ?? null,
        projectDisplayName: 'Recent Project',
        sessionTitle: 'Newer conversation',
        lastActivity: '2026-08-01T11:00:00.000Z',
      }],
      total: 2,
      hasMore: true,
    });
  });
});

/** One Claude transcript row of user or assistant text, linked by uuid chain. */
function claudeTextRow(
  sessionId: string,
  role: 'user' | 'assistant',
  text: string,
  ordinal: number,
): Record<string, unknown> {
  return {
    type: role,
    uuid: `row-${ordinal}`,
    parentUuid: ordinal === 0 ? null : `row-${ordinal - 1}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, ordinal)).toISOString(),
    sessionId,
    message: { role, content: [{ type: 'text', text }] },
  };
}

test('history pages are sliced from the cached full transcript and see appended rows', { concurrency: false }, async () => {
  const transcriptDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-service-history-'));
  const sessionId = 'claude-history-cache-session';
  const transcriptPath = path.join(transcriptDirectory, `${sessionId}.jsonl`);

  try {
    // Every Claude history read asks the CLI's process registry whether a run
    // is live, so it gets an empty one rather than the real ~/.claude.
    await withClaudeCliRegistry([], async () => await withIsolatedDatabase(async () => {
      const rows = [
        claudeTextRow(sessionId, 'user', 'one', 0),
        claudeTextRow(sessionId, 'assistant', 'reply one', 1),
        claudeTextRow(sessionId, 'user', 'two', 2),
        claudeTextRow(sessionId, 'assistant', 'reply two', 3),
      ];
      await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
      sessionsDb.createSession(
        sessionId,
        'claude',
        '/tmp/history-cache-project',
        'History cache conversation',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:10.000Z',
        transcriptPath,
      );

      const page = await sessionsService.fetchHistory(sessionId, { limit: 2, offset: 0 });
      assert.equal(page.total, 4);
      assert.equal(page.hasMore, true);
      assert.deepEqual(page.messages.map((message) => message.content), ['two', 'reply two']);

      // A row appended after the page was cached must appear on the next read.
      await appendFile(
        transcriptPath,
        `${JSON.stringify(claudeTextRow(sessionId, 'user', 'three', 4))}\n`,
        'utf8',
      );
      const refreshed = await sessionsService.fetchHistory(sessionId, { limit: 2, offset: 0 });
      assert.equal(refreshed.total, 5);
      assert.deepEqual(refreshed.messages.map((message) => message.content), ['reply two', 'three']);

      // An older page keeps the tail-offset contract while served from cache.
      const older = await sessionsService.fetchHistory(sessionId, { limit: 2, offset: 2 });
      assert.deepEqual(older.messages.map((message) => message.content), ['reply one', 'two']);
      assert.equal(older.hasMore, true);
    }));
  } finally {
    await rm(transcriptDirectory, { recursive: true, force: true });
  }
});

/**
 * Stands in for the provider registry with one provider per id, each with the
 * runtime given — the seam through which a runtime's background work reaches
 * the running-sessions list without an SDK run behind it.
 */
async function withProviders(
  runtimes: Partial<Record<'claude' | 'codex', IProvider['runtime']>>,
  runTest: () => void | Promise<void>,
): Promise<void> {
  const realListProviders = providerRegistry.listProviders;
  providerRegistry.listProviders = () =>
    Object.entries(runtimes).map(([id, runtime]) => ({ id, runtime }) as IProvider);
  try {
    await runTest();
  } finally {
    providerRegistry.listProviders = realListProviders;
    chatRunRegistry.clearAll();
  }
}

/**
 * Runs `runTest` against a Claude CLI process registry containing exactly
 * `records`, so the running-sessions tests never read the developer's real
 * `~/.claude/sessions`.
 */
async function withClaudeCliRegistry(
  records: Array<Record<string, unknown>>,
  runTest: () => void | Promise<void>,
): Promise<void> {
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-cli-registry-'));
  await mkdir(path.join(homeDirectory, '.claude', 'sessions'), { recursive: true });
  for (const record of records) {
    await writeFile(
      path.join(homeDirectory, '.claude', 'sessions', `${record.pid}.json`),
      JSON.stringify(record),
      'utf8',
    );
  }

  const realHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => homeDirectory;
  try {
    await runTest();
  } finally {
    (os as unknown as { homedir: () => string }).homedir = realHomedir;
    await rm(homeDirectory, { recursive: true, force: true });
  }
}

const task = (taskId: string, startedAt: number): BackgroundTaskSummary => ({
  taskId,
  toolUseId: `toolu_${taskId}`,
  taskType: 'local_agent',
  description: `Task ${taskId}`,
  startedAt,
});

test('running sessions list a session whose background work outlived its turn', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('held-session', 'claude', '/tmp/running-project');
    // The turn ran and completed: the registry still holds the finished run.
    const run = chatRunRegistry.startRun({
      appSessionId: 'held-session', provider: 'claude', providerSessionId: null, connection: null, userId: null,
    });
    assert.ok(run);
    run.writer.send({ kind: 'text', content: 'launched', sessionId: 'held-session', provider: 'claude' });
    run.writer.sendComplete({ exitCode: 0 });
    assert.equal(run.status, 'completed');

    const tasks = [task('late', 2_000), task('early', 1_000)];
    await withClaudeCliRegistry([], async () => await withProviders(
      { claude: { run: async () => undefined, abort: () => false, listBackgroundWork: () => [{ sessionId: 'held-session', tasks }] } },
      async () => {
        assert.deepEqual(await sessionsService.listRunningSessions(), [{
          sessionId: 'held-session',
          provider: 'claude',
          startedAt: 1_000,
          lastSeq: run.lastSeq,
          background: true,
          canInterrupt: false,
          tasks,
        }]);
        assert.ok(run.lastSeq > 0, 'the finished run still reports its sequence for replay');
      },
    ));
  });
});

test('running sessions carry their tasks on a chat run that is still going', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('busy-session', 'claude', '/tmp/running-project');
    sessionsDb.createAppSession('idle-session', 'codex', '/tmp/running-project');
    const run = chatRunRegistry.startRun({
      appSessionId: 'busy-session', provider: 'claude', providerSessionId: null, connection: null, userId: null,
    });
    assert.ok(run);

    const tasks = [task('agent', 5_000)];
    await withClaudeCliRegistry([], async () => await withProviders(
      {
        claude: { run: async () => undefined, abort: () => false, listBackgroundWork: () => [{ sessionId: 'busy-session', tasks }] },
        // A runtime without background work contributes chat runs alone.
        codex: { run: async () => undefined, abort: () => false },
      },
      async () => {
        const sessions = await sessionsService.listRunningSessions();
        assert.equal(sessions.length, 1, 'a session with a running chat run is listed once');
        assert.deepEqual(sessions[0], {
          sessionId: 'busy-session',
          provider: 'claude',
          startedAt: run.startedAt,
          lastSeq: 0,
          tasks,
        });
      },
    ));
  });
});

test('running sessions with no background work are the chat runs alone', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('plain-session', 'codex', '/tmp/running-project');
    const run = chatRunRegistry.startRun({
      appSessionId: 'plain-session', provider: 'codex', providerSessionId: null, connection: null, userId: null,
    });
    assert.ok(run);

    await withClaudeCliRegistry([], async () => await withProviders(
      { codex: { run: async () => undefined, abort: () => false } },
      async () => {
        assert.deepEqual(await sessionsService.listRunningSessions(), [{
          sessionId: 'plain-session', provider: 'codex', startedAt: run.startedAt, lastSeq: 0,
        }]);
      },
    ));
  });
});

test('running sessions report a turn driven by the Claude CLI', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('cli-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('cli-session', 'claude-native-1');

    // `process.pid` is the one pid guaranteed to be alive; omitting procStart
    // keeps the fixture portable, since the start-time cross-check is Linux-only.
    await withClaudeCliRegistry(
      [{ pid: process.pid, sessionId: 'claude-native-1', status: 'busy', entrypoint: 'cli', startedAt: 4_000 }],
      async () => await withProviders(
        { claude: { run: async () => undefined, abort: () => false } },
        async () => {
          assert.deepEqual(await sessionsService.listRunningSessions(), [{
            sessionId: 'cli-session',
            provider: 'claude',
            startedAt: 4_000,
            lastSeq: 0,
            canInterrupt: false,
            statusText: 'Running in the Claude CLI',
          }]);
        },
      ),
    );
  });
});

test('running sessions ignore registry files a crash left behind', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('stale-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('stale-session', 'claude-native-stale');

    await withClaudeCliRegistry(
      [
        // The process is gone: no kernel hands out 2^31 - 1, the largest pid
        // `process.kill` accepts, so signal 0 cannot find it. A pid under
        // Linux's default pid_max can belong to a live process.
        { pid: 2 ** 31 - 1, sessionId: 'claude-native-stale', status: 'busy', startedAt: 1_000 },
        // Alive, but waiting for input rather than producing a response.
        { pid: process.pid, sessionId: 'claude-native-idle', status: 'idle', startedAt: 2_000 },
      ],
      async () => await withProviders(
        { claude: { run: async () => undefined, abort: () => false } },
        async () => {
          assert.deepEqual(await sessionsService.listRunningSessions(), []);
        },
      ),
    );
  });
});

test('a CLI turn does not duplicate a session already running a chat run', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('both-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('both-session', 'claude-native-both');
    const run = chatRunRegistry.startRun({
      appSessionId: 'both-session', provider: 'claude', providerSessionId: 'claude-native-both', connection: null, userId: null,
    });
    assert.ok(run);

    await withClaudeCliRegistry(
      [{ pid: process.pid, sessionId: 'claude-native-both', status: 'busy', startedAt: 3_000 }],
      async () => await withProviders(
        { claude: { run: async () => undefined, abort: () => false } },
        async () => {
          const sessions = await sessionsService.listRunningSessions();
          assert.equal(sessions.length, 1, 'the chat run already covers this session');
          assert.equal(sessions[0].canInterrupt, undefined, 'the interruptible chat run entry wins');
        },
      ),
    );
  });
});

test('a CLI turn does not duplicate a session whose background work CloudCLI holds', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('held-cli-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('held-cli-session', 'claude-native-held');

    // The process CloudCLI holds open for the work registers itself `busy`
    // until the work is done, so the registry names the same session.
    const tasks = [task('workflow', 6_000)];
    await withClaudeCliRegistry(
      [{ pid: process.pid, sessionId: 'claude-native-held', status: 'busy', entrypoint: 'sdk-ts', startedAt: 5_500 }],
      async () => await withProviders(
        {
          claude: {
            run: async () => undefined,
            abort: () => false,
            listBackgroundWork: () => [{ sessionId: 'held-cli-session', tasks }],
          },
        },
        async () => {
          assert.deepEqual(await sessionsService.listRunningSessions(), [{
            sessionId: 'held-cli-session',
            provider: 'claude',
            startedAt: 6_000,
            lastSeq: 0,
            background: true,
            canInterrupt: false,
            tasks,
          }]);
        },
      ),
    );
  });
});

test('an unreadable registry never fails the running-sessions poll', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('safe-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('safe-session', 'claude-native-safe');

    await withClaudeCliRegistry(
      [{ pid: process.pid, sessionId: 'claude-native-safe', status: 'busy', startedAt: 5_000 }],
      async () => {
        // A half-written file sits alongside the good one; it must be skipped
        // rather than abort the whole poll.
        await writeFile(path.join(os.homedir(), '.claude', 'sessions', 'broken.json'), '{"pid":', 'utf8');
        await withProviders(
          { claude: { run: async () => undefined, abort: () => false } },
          async () => {
            const sessions = await sessionsService.listRunningSessions();
            assert.deepEqual(sessions.map((session) => session.sessionId), ['safe-session']);
          },
        );
      },
    );
  });
});

test('a cached Claude history follows a CLI-driven workflow through its journal and its process', { concurrency: false }, async () => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-service-cli-workflow-'));
  const appSessionId = 'cli-workflow-app-session';
  const providerSessionId = 'claude-native-cli-workflow';
  const toolUseId = 'toolu_cli_workflow';
  const transcriptPath = path.join(projectDirectory, `${providerSessionId}.jsonl`);
  const runDirectory = path.join(projectDirectory, providerSessionId, 'subagents', 'workflows', 'wf_cli-1');
  const journalPath = path.join(runDirectory, 'journal.jsonl');
  const journalRow = (type: string, agentId: string, label?: string) => `${JSON.stringify({ type, agentId, label })}\n`;

  try {
    // A Workflow launch the CLI has not reported back on yet, and its journal.
    const rows = [
      {
        type: 'assistant',
        uuid: 'wf-a1',
        parentUuid: null,
        sessionId: providerSessionId,
        timestamp: '2026-08-21T10:32:10.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Workflow', input: {} }] },
      },
      {
        type: 'user',
        uuid: 'wf-u1',
        parentUuid: 'wf-a1',
        sessionId: providerSessionId,
        timestamp: '2026-08-21T10:32:15.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Workflow launched in background.' }] },
        toolUseResult: { status: 'async_launched', runId: 'wf_cli-1', workflowName: 'audit', transcriptDir: runDirectory },
      },
    ];
    await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      journalPath,
      journalRow('started', 'ag1', 'audit:chat') + journalRow('result', 'ag1') + journalRow('started', 'ag2', 'audit:sidebar'),
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(providerSessionId, 'claude', projectDirectory, 'CLI workflow', now, now, transcriptPath);
      sessionsDb.createAppSession(appSessionId, 'claude', projectDirectory);
      sessionsDb.assignProviderSessionId(appSessionId, providerSessionId);

      // Counts the full-transcript parses the cache lets through.
      const claudeSessions = providerRegistry.resolveProvider('claude').sessions;
      const realFetchHistory = claudeSessions.fetchHistory;
      let parses = 0;
      claudeSessions.fetchHistory = (sessionId, options) => {
        parses += 1;
        return realFetchHistory.call(claudeSessions, sessionId, options);
      };

      const readWorkflow = async () => (await sessionsService.fetchHistory(appSessionId)).messages
        .find((message) => message.kind === 'tool_use' && message.toolId === toolUseId)?.workflow;
      const agentStatuses = (workflow: WorkflowInfo | undefined) =>
        workflow?.agents.map((agent) => [agent.label, agent.status]);

      // A Shell-tab `claude --resume` that launched the workflow. The CLI keeps
      // its registry status `busy` for as long as a workflow it launched is
      // unfinished, even after its own turn has ended.
      const registryRecord = (status: string) => ({
        pid: process.pid,
        sessionId: providerSessionId,
        status,
        entrypoint: 'cli',
        startedAt: Date.parse('2026-08-21T10:30:00.000Z'),
      });
      const registryFile = () => path.join(os.homedir(), '.claude', 'sessions', `${process.pid}.json`);

      try {
        await withClaudeCliRegistry(
          [registryRecord('busy')],
          async () => {
            const live = await readWorkflow();
            assert.equal(live?.status, 'running');
            assert.deepEqual(agentStatuses(live), [['audit:chat', 'completed'], ['audit:sidebar', 'running']]);
            assert.equal(parses, 1);

            await readWorkflow();
            assert.equal(parses, 1, 'nothing changed, so the cached transcript is served');

            // One agent settles and the next starts, all in the journal: the
            // transcript itself stays quiet.
            await appendFile(journalPath, journalRow('result', 'ag2') + journalRow('started', 'ag3', 'synthesize'), 'utf8');
            const progressed = await readWorkflow();
            assert.equal(parses, 2);
            assert.deepEqual(agentStatuses(progressed), [
              ['audit:chat', 'completed'],
              ['audit:sidebar', 'completed'],
              ['synthesize', 'running'],
            ]);

            // The CLI comes to rest, which it does only once nothing it
            // launched is unfinished; again, no file of the session changed.
            // A process at rest cannot report, so the cached copy that read
            // the run as live is stale.
            await writeFile(registryFile(), JSON.stringify(registryRecord('idle')), 'utf8');
            const resting = await readWorkflow();
            assert.equal(parses, 3);
            assert.equal(resting?.status, 'stopped');
            assert.deepEqual(agentStatuses(resting), [
              ['audit:chat', 'completed'],
              ['audit:sidebar', 'completed'],
              ['synthesize', 'stopped'],
            ]);

            // The resting CLI then exits and removes its registry file. That
            // changes nothing the history depends on, so the cache holds.
            await rm(registryFile());
            const exited = await readWorkflow();
            assert.equal(parses, 3, 'a resting process exiting does not invalidate the cached transcript');
            assert.equal(exited?.status, 'stopped');
          },
        );
      } finally {
        claudeSessions.fetchHistory = realFetchHistory;
      }
    });
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});

/** One row of a hand-written history, stamped `second` seconds into 2026. */
function historyRow(id: string, second: number, fields: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id,
    sessionId: 'cursor-native-turn-question',
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString(),
    provider: 'cursor',
    kind: 'text',
    ...fields,
  };
}

/**
 * Four turns: two opened by text, with every kind of user row that opens no
 * turn between the second question and its answer, and two opened by
 * attachments alone.
 */
const TURN_HISTORY: NormalizedMessage[] = [
  historyRow('q1', 0, { role: 'user', content: 'First question' }),
  historyRow('a1', 1, { role: 'assistant', content: 'First answer' }),
  historyRow('q2', 2, { role: 'user', content: 'Second question' }),
  historyRow('insert', 3, { role: 'user', content: 'Also update the README', inserted: true }),
  historyRow('notification', 4, {
    role: 'user',
    content: '\n<task-notification><status>completed</status><summary>Agent done</summary></task-notification>',
  }),
  historyRow('blank', 5, { role: 'user', content: ' \n ', images: [], files: [] }),
  historyRow('summary', 6, { role: 'user', content: 'Summary of the conversation so far', isCompactSummary: true }),
  // A compaction row never draws as a user bubble, whatever its role.
  historyRow('boundary', 7, { role: 'user', content: 'Compacted', compact: { phase: 'done' } }),
  historyRow('tool', 8, { kind: 'tool_use', toolName: 'Bash', toolId: 'toolu_1' }),
  // A tool result is a user turn in the provider's own transcript.
  historyRow('tool-result', 9, { kind: 'tool_result', role: 'user', content: 'exit 0', toolId: 'toolu_1' }),
  historyRow('a2', 10, { role: 'assistant', content: 'Second answer' }),
  historyRow('images-only', 11, { role: 'user', content: '', images: [{ name: 'screen.png', data: 'iVBORw0KGgo=' }] }),
  historyRow('a3', 12, { role: 'assistant', content: 'Third answer' }),
  historyRow('files-only', 13, { role: 'user', content: '', files: [{ name: 'notes.txt', path: '/tmp/notes.txt' }] }),
  historyRow('a4', 14, { role: 'assistant', content: 'Fourth answer' }),
];

const TURN_QUESTION_SESSION_ID = 'turn-question-session';

/**
 * Runs `runTest` against a Cursor session whose history is `TURN_HISTORY`.
 * Cursor history is read from the provider on every request, never through
 * the transcript cache, so the rows reach `findTurnQuestion` exactly as given.
 */
async function withTurnHistory(runTest: () => Promise<void>): Promise<void> {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession(TURN_QUESTION_SESSION_ID, 'cursor', '/tmp/turn-question-project');
    sessionsDb.assignProviderSessionId(TURN_QUESTION_SESSION_ID, 'cursor-native-turn-question');

    const cursorSessions = providerRegistry.resolveProvider('cursor').sessions;
    const realFetchHistory = cursorSessions.fetchHistory;
    cursorSessions.fetchHistory = async () => ({
      messages: TURN_HISTORY,
      total: TURN_HISTORY.length,
      hasMore: false,
      offset: 0,
      limit: null,
    });
    try {
      await runTest();
    } finally {
      cursorSessions.fetchHistory = realFetchHistory;
    }
  });
}

/** The id of the turn question `findTurnQuestion` returns, or null. */
async function findTurnQuestionId(beforeId: string, at?: number): Promise<string | null> {
  const question = await sessionsService.findTurnQuestion(TURN_QUESTION_SESSION_ID, { beforeId, at });
  return question?.id ?? null;
}

const turnHistoryTime = (id: string): number =>
  Date.parse(TURN_HISTORY.find((row) => row.id === id)?.timestamp ?? '');

test('the turn question is the nearest question before the row, past user rows that open no turn', { concurrency: false }, async () => {
  await withTurnHistory(async () => {
    assert.equal(await findTurnQuestionId('a1'), 'q1');
    assert.equal(
      await findTurnQuestionId('a2'),
      'q2',
      'an insert, a task notification, a blank row, compaction rows and a tool result sit in between',
    );
    assert.equal(await findTurnQuestionId('q2'), 'q1', 'a question row asks for the turn before its own');

    // The row as the history route serves it, under the app session id.
    const question = await sessionsService.findTurnQuestion(TURN_QUESTION_SESSION_ID, { beforeId: 'a2' });
    const { messages } = await sessionsService.fetchHistory(TURN_QUESTION_SESSION_ID);
    assert.equal(question?.sessionId, TURN_QUESTION_SESSION_ID);
    assert.deepEqual(question, messages.find((message) => message.id === 'q2'));
  });
});

test('a user row with only attachments is a turn question', { concurrency: false }, async () => {
  await withTurnHistory(async () => {
    assert.equal(await findTurnQuestionId('a3'), 'images-only');
    assert.equal(await findTurnQuestionId('a4'), 'files-only');
  });
});

test('no turn question comes before the first row', { concurrency: false }, async () => {
  await withTurnHistory(async () => {
    assert.equal(await findTurnQuestionId('q1'), null);
  });
});

test('a row id the history does not have is found by at, and without at finds nothing', { concurrency: false }, async () => {
  await withTurnHistory(async () => {
    // The first row stamped at or after `at` is the row itself, so its own
    // question is the one before it.
    assert.equal(await findTurnQuestionId('gone', turnHistoryTime('images-only')), 'q2');
    assert.equal(await findTurnQuestionId('gone', turnHistoryTime('images-only') - 500), 'q2');
    assert.equal(await findTurnQuestionId('gone', turnHistoryTime('a4') + 1), null, 'no row is that recent');
    assert.equal(await findTurnQuestionId('gone'), null);
    assert.equal(await findTurnQuestionId('a1', turnHistoryTime('a4')), 'q1', 'a known id wins over at');
  });
});

test('a Claude row without a uuid gets a new id on every parse, and at finds it once the transcript changes', { concurrency: false }, async () => {
  const transcriptDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-service-turn-question-'));
  const sessionId = 'claude-turn-question-session';
  const transcriptPath = path.join(transcriptDirectory, `${sessionId}.jsonl`);
  // Rows written without a `uuid`, which the reader gives a random id instead.
  const unanchoredRow = (role: 'user' | 'assistant', text: string, second: number) => JSON.stringify({
    type: role,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString(),
    sessionId,
    message: { role, content: [{ type: 'text', text }] },
  });

  try {
    await withClaudeCliRegistry([], async () => await withIsolatedDatabase(async () => {
      const rows = [
        unanchoredRow('user', 'First question', 0),
        unanchoredRow('assistant', 'First answer', 1),
        unanchoredRow('user', 'Second question', 2),
        unanchoredRow('assistant', 'Working on it', 3),
        unanchoredRow('assistant', 'Still going', 4),
      ];
      await writeFile(transcriptPath, `${rows.join('\n')}\n`, 'utf8');
      sessionsDb.createSession(
        sessionId,
        'claude',
        '/tmp/turn-question-project',
        'Turn question conversation',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:04.000Z',
        transcriptPath,
      );

      // The pane opened on the last two rows, the middle of the second turn.
      const page = await sessionsService.fetchHistory(sessionId, { limit: 2, offset: 0 });
      const oldestLoaded = page.messages[0];
      assert.equal(oldestLoaded?.content, 'Working on it');
      const findContent = async (anchor: { beforeId: string; at?: number }) =>
        (await sessionsService.findTurnQuestion(sessionId, anchor))?.content ?? null;

      // While the file is unchanged, the cached parse keeps the ids it gave.
      assert.equal(await findContent({ beforeId: oldestLoaded.id }), 'Second question');

      // The turn goes on, and the next read parses the transcript again.
      await appendFile(transcriptPath, `${unanchoredRow('assistant', 'Done', 5)}\n`, 'utf8');
      const reparsed = await sessionsService.fetchHistory(sessionId);
      assert.equal(reparsed.messages.length, 6);
      assert.equal(reparsed.messages.some((message) => message.id === oldestLoaded.id), false);

      assert.equal(await findContent({ beforeId: oldestLoaded.id }), null);
      assert.equal(
        await findContent({ beforeId: oldestLoaded.id, at: Date.parse(oldestLoaded.timestamp) }),
        'Second question',
      );
    }));
  } finally {
    await rm(transcriptDirectory, { recursive: true, force: true });
  }
});
