import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { listLiveClaudeCliRuns } from '@/modules/providers/services/claude-cli-liveness.service.js';
import type { FetchHistoryResult, LiveClaudeRun, WorkflowInfo } from '@/shared/types.js';

/**
 * Covers history read while a turn may be driven by a Claude CLI process that
 * CloudCLI's runtime does not own: a Shell-tab `claude --resume`, or a run of
 * another CloudCLI instance sharing `~/.claude`. Every provider here gets an
 * injected CLI probe (or a fixture registry directory), so nothing reads the
 * real `~/.claude/sessions`.
 */

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-cli-history-db-'));

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

const APP_SESSION_ID = 'app-cli-workflow-session';
const PROVIDER_SESSION_ID = 'claude-cli-workflow-session';
const WORKFLOW_TOOL_USE_ID = 'toolu_cli_workflow_1';
const WORKFLOW_RUN_ID = 'wf_0c1d2e3f-101';
const FINISHED_AGENT_ID = 'a1f0e1d2c3b4a5968';
const RUNNING_AGENT_ID = 'a2e1d0c9b8a7f6e54';

/** When the CLI wrote the Workflow's launch acknowledgement. */
const LAUNCHED_AT = '2026-08-21T10:32:15.000Z';
/** A process's start before the launch: it may be the process that launched it. */
const STARTED_BEFORE_LAUNCH = Date.parse('2026-08-21T10:30:00.000Z');
/** A process's start after the launch: a later process of the session. */
const STARTED_AFTER_LAUNCH = Date.parse('2026-08-21T11:00:00.000Z');

/** The entrypoint an interactive REPL writes its rows under, a Shell-tab `claude --resume` included. */
const REPL = 'cli';
/** The entrypoint an Agent SDK run writes its rows under, CloudCLI's own runs included. */
const SDK = 'sdk-ts';

type WorkflowSessionPaths = {
  transcriptPath: string;
  runDirectory: string;
  journalPath: string;
};

/**
 * Writes the session transcript: a Workflow launch that has not reported
 * back (the launch acknowledgement, and no `<task-notification>`). Every row
 * carries the `entrypoint` of the process that wrote it, as the CLI stamps
 * it, or none at all when `entrypoint` is null.
 */
async function writeTranscript(
  { transcriptPath, runDirectory }: WorkflowSessionPaths,
  entrypoint: string | null,
): Promise<void> {
  const rows = [
    {
      type: 'user',
      uuid: 'cli-u1',
      parentUuid: null,
      sessionId: PROVIDER_SESSION_ID,
      timestamp: '2026-08-21T10:32:00.000Z',
      message: { role: 'user', content: 'Audit the frontend.' },
    },
    {
      type: 'assistant',
      uuid: 'cli-a1',
      parentUuid: 'cli-u1',
      sessionId: PROVIDER_SESSION_ID,
      timestamp: '2026-08-21T10:32:10.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: WORKFLOW_TOOL_USE_ID, name: 'Workflow', input: { description: 'Audit the frontend' } }],
      },
    },
    {
      type: 'user',
      uuid: 'cli-u2',
      parentUuid: 'cli-a1',
      sessionId: PROVIDER_SESSION_ID,
      timestamp: LAUNCHED_AT,
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: WORKFLOW_TOOL_USE_ID,
          content: `Workflow launched in background. Task ID: wcli1\nTranscript dir: ${runDirectory}`,
        }],
      },
      toolUseResult: {
        status: 'async_launched',
        taskId: 'wcli1',
        taskType: 'local_workflow',
        workflowName: 'frontend-audit',
        runId: WORKFLOW_RUN_ID,
        summary: 'Audit the frontend',
        transcriptDir: runDirectory,
      },
    },
  ];
  const stamped = rows.map((row) => (entrypoint === null ? row : { ...row, entrypoint }));
  await writeFile(transcriptPath, `${stamped.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

/**
 * Writes a session whose Workflow launch, written by a REPL, has not reported
 * back, plus the run's journal under `<session>/subagents/workflows/<runId>/`,
 * where the launch row's `transcriptDir` points: one agent finished, one
 * still going.
 */
async function writeUnreportedWorkflowSession(projectDirectory: string): Promise<WorkflowSessionPaths> {
  const runDirectory = path.join(projectDirectory, PROVIDER_SESSION_ID, 'subagents', 'workflows', WORKFLOW_RUN_ID);
  const paths: WorkflowSessionPaths = {
    transcriptPath: path.join(projectDirectory, `${PROVIDER_SESSION_ID}.jsonl`),
    runDirectory,
    journalPath: path.join(runDirectory, 'journal.jsonl'),
  };
  await writeTranscript(paths, REPL);

  await mkdir(runDirectory, { recursive: true });
  const journal = [
    { type: 'started', key: 'v2:one', agentId: FINISHED_AGENT_ID, label: 'audit:chat', phase: 'Audit' },
    { type: 'result', key: 'v2:one', agentId: FINISHED_AGENT_ID, result: { area: 'chat' } },
    { type: 'started', key: 'v2:two', agentId: RUNNING_AGENT_ID, label: 'audit:sidebar', phase: 'Audit' },
  ];
  await writeFile(paths.journalPath, `${journal.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  return paths;
}

/**
 * Writes the transcript of the agent the journal has not settled, its rows
 * stamped like the launch's (or not at all when `entrypoint` is null).
 */
async function writeRunningAgentTranscript(runDirectory: string, entrypoint: string | null): Promise<void> {
  const rows = [
    { isSidechain: true, agentId: RUNNING_AGENT_ID, type: 'user', uuid: 'wa-u1', timestamp: '2026-08-21T10:33:00.000Z', message: { role: 'user', content: 'Audit the sidebar.' } },
    { isSidechain: true, agentId: RUNNING_AGENT_ID, type: 'assistant', uuid: 'wa-a1', timestamp: '2026-08-21T10:33:05.000Z', message: { role: 'assistant', model: 'claude-opus-4-1', content: [{ type: 'thinking', thinking: 'Reading the sidebar hooks.' }] } },
  ];
  const stamped = rows.map((row) => (entrypoint === null ? row : { ...row, entrypoint }));
  await writeFile(path.join(runDirectory, `agent-${RUNNING_AGENT_ID}.jsonl`), `${stamped.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

/**
 * Indexes the transcript the way a session CloudCLI started and the CLI then
 * resumed ends up: an app session mapped onto Claude's own session id.
 */
function indexSession(projectDirectory: string, transcriptPath: string): void {
  const now = new Date().toISOString();
  sessionsDb.createSession(PROVIDER_SESSION_ID, 'claude', projectDirectory, 'CLI workflow session', now, now, transcriptPath);
  sessionsDb.createAppSession(APP_SESSION_ID, 'claude', projectDirectory);
  sessionsDb.assignProviderSessionId(APP_SESSION_ID, PROVIDER_SESSION_ID);
}

async function withWorkflowSession(runTest: (paths: WorkflowSessionPaths) => Promise<void>): Promise<void> {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-cli-workflow-'));
  try {
    const paths = await writeUnreportedWorkflowSession(projectDirectory);
    await withIsolatedDatabase(async () => {
      indexSession(projectDirectory, paths.transcriptPath);
      await runTest(paths);
    });
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
}

/**
 * Runs `runTest` against a Claude CLI process registry holding exactly
 * `records`, written the way the CLI writes them (`<pid>.json`). Each record
 * stands for a process of this session; `process.pid` stands in for it, the
 * one pid sure to be up.
 */
async function withRegistry(
  records: Array<Record<string, unknown>>,
  runTest: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-cli-registry-'));
  try {
    for (const [index, record] of records.entries()) {
      await writeFile(
        path.join(directory, `${process.pid + index}.json`),
        JSON.stringify({ pid: process.pid, sessionId: PROVIDER_SESSION_ID, ...record }),
        'utf8',
      );
    }
    await runTest(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Runs `runTest` with CloudCLI's own environment naming `entrypoint` as the
 * one its SDK runs inherit, or naming none when it is undefined.
 */
async function withCloudCliEntrypoint(entrypoint: string | undefined, runTest: () => Promise<void>): Promise<void> {
  const previous = process.env.CLAUDE_CODE_ENTRYPOINT;
  if (entrypoint === undefined) {
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
  } else {
    process.env.CLAUDE_CODE_ENTRYPOINT = entrypoint;
  }
  try {
    await runTest();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_CODE_ENTRYPOINT;
    } else {
      process.env.CLAUDE_CODE_ENTRYPOINT = previous;
    }
  }
}

/** A provider whose only live runs are the CLI processes `cliRuns` lists; CloudCLI's runtime has none. */
const providerWithCliRuns = (cliRuns: LiveClaudeRun[]) => new ClaudeSessionsProvider({
  getLiveRunStartTime: () => null,
  listLiveCliRuns: async () => cliRuns,
});

/** A provider reading the fixture registry in `directory` through the real lookup. */
const providerReadingRegistry = (directory: string) => new ClaudeSessionsProvider({
  getLiveRunStartTime: () => null,
  listLiveCliRuns: (providerSessionId) => listLiveClaudeCliRuns(providerSessionId, directory),
});

function readWorkflow(history: FetchHistoryResult): WorkflowInfo | undefined {
  return history.messages.find(
    (message) => message.kind === 'tool_use' && message.toolId === WORKFLOW_TOOL_USE_ID,
  )?.workflow;
}

const fetchWorkflow = async (provider: ClaudeSessionsProvider) =>
  readWorkflow(await provider.fetchHistory(APP_SESSION_ID, { providerSessionId: PROVIDER_SESSION_ID }));

const readAgentStatus = async (provider: ClaudeSessionsProvider) =>
  (await provider.readWorkflowAgentActivity(APP_SESSION_ID, WORKFLOW_RUN_ID, RUNNING_AGENT_ID))?.agent.status;

const agentStatuses = (workflow: WorkflowInfo | undefined) =>
  workflow?.agents.map((agent) => [agent.label, agent.status]);

test('a workflow launched by a live Claude CLI process reads running, and so do its unsettled agents', { concurrency: false }, async () => {
  await withWorkflowSession(async () => {
    const askedFor: string[] = [];
    // CloudCLI's own runtime knows nothing of this run; the CLI's registry
    // has a busy REPL for the session that started before the launch.
    const provider = new ClaudeSessionsProvider({
      getLiveRunStartTime: () => null,
      listLiveCliRuns: async (providerSessionId) => {
        askedFor.push(providerSessionId);
        return providerSessionId === PROVIDER_SESSION_ID ? [{ startedAt: STARTED_BEFORE_LAUNCH, entrypoint: REPL }] : [];
      },
    });

    const workflow = await fetchWorkflow(provider);

    // Reading `stopped` here drew the run as "no result" in the progress
    // details while the CLI was still running it.
    assert.equal(workflow?.status, 'running');
    assert.deepEqual(agentStatuses(workflow), [['audit:chat', 'completed'], ['audit:sidebar', 'running']]);
    assert.deepEqual(workflow?.agentCounts, { total: 2, completed: 1, failed: 0, running: 1, stopped: 0 });
    assert.equal(workflow?.endedAt, undefined, 'a run that has not reported has no end time');
    // The registry records only Claude's own session id.
    assert.deepEqual(askedFor, [PROVIDER_SESSION_ID]);
  });
});

test('a workflow launched before every live CLI process started, or with none up, still reads stopped', { concurrency: false }, async () => {
  await withWorkflowSession(async () => {
    const cases: Array<[string, LiveClaudeRun[]]> = [
      // A later process of the session cannot report on an earlier one's run.
      ['a later CLI process', [{ startedAt: STARTED_AFTER_LAUNCH, entrypoint: REPL }]],
      ['no CLI process', []],
    ];

    for (const [label, cliRuns] of cases) {
      const workflow = await fetchWorkflow(providerWithCliRuns(cliRuns));

      assert.equal(workflow?.status, 'stopped', label);
      assert.deepEqual(agentStatuses(workflow), [['audit:chat', 'completed'], ['audit:sidebar', 'stopped']], label);
    }
  });
});

test('an unreported launch is live only while a live run of the kind that wrote it started before it', { concurrency: false }, async (t) => {
  await withWorkflowSession(async (paths) => {
    const before = (entrypoint: string | null): LiveClaudeRun => ({ startedAt: STARTED_BEFORE_LAUNCH, entrypoint });
    const after = (entrypoint: string | null): LiveClaudeRun => ({ startedAt: STARTED_AFTER_LAUNCH, entrypoint });
    // [label, the entrypoint the launch rows carry, the live CLI runs, expected status]
    const cases: Array<[string, string | null, LiveClaudeRun[], WorkflowInfo['status']]> = [
      ['a busy REPL vouches for its own launch', REPL, [before(REPL)], 'running'],
      ['an SDK run vouches for its own launch', SDK, [before(SDK)], 'running'],
      // A busy REPL next to CloudCLI's dead run, and the other way round: the
      // live process is not the one that wrote the launch.
      ['a busy REPL does not vouch for an SDK run\'s launch', SDK, [before(REPL)], 'stopped'],
      ['an SDK run does not vouch for a REPL\'s launch', REPL, [before(SDK)], 'stopped'],
      // Older rows, or a CLI that does not stamp them, cannot rule a run out.
      ['a launch row with no entrypoint matches a REPL', null, [before(REPL)], 'running'],
      ['a launch row with no entrypoint matches an SDK run', null, [before(SDK)], 'running'],
      ['a run that names no entrypoint matches any launch', SDK, [before(null)], 'running'],
      // One run has to match on both counts, not one on each.
      ['the matching kind started too late', REPL, [after(REPL), before(SDK)], 'stopped'],
      ['some run matches on both counts', REPL, [before(SDK), before(REPL)], 'running'],
    ];

    for (const [label, entrypoint, cliRuns, expected] of cases) {
      await t.test(label, async () => {
        await writeTranscript(paths, entrypoint);
        const workflow = await fetchWorkflow(providerWithCliRuns(cliRuns));

        assert.equal(workflow?.status, expected);
        assert.deepEqual(agentStatuses(workflow), [['audit:chat', 'completed'], ['audit:sidebar', expected]]);
      });
    }
  });
});

test('a live REPL\'s own launch reads running while CloudCLI\'s own run of the session is also up', { concurrency: false }, async () => {
  await withWorkflowSession(async () => {
    // CloudCLI's chat started a run of the session after the REPL's launch.
    // It cannot report on that launch, but the REPL still can: stopping at
    // CloudCLI's own run read the REPL's workflow as `stopped`.
    const provider = new ClaudeSessionsProvider({
      getLiveRunStartTime: (sessionId) => (sessionId === APP_SESSION_ID ? STARTED_AFTER_LAUNCH : null),
      listLiveCliRuns: async () => [{ startedAt: STARTED_BEFORE_LAUNCH, entrypoint: REPL }],
    });

    const workflow = await fetchWorkflow(provider);
    assert.equal(workflow?.status, 'running');
    assert.deepEqual(agentStatuses(workflow), [['audit:chat', 'completed'], ['audit:sidebar', 'running']]);
  });
});

test('CloudCLI\'s own run vouches for the launches it writes, under the entrypoint its runtime pins', { concurrency: false }, async () => {
  await withWorkflowSession(async (paths) => {
    // CloudCLI's own run started before the launch, and no CLI process is
    // registered for the session.
    const provider = new ClaudeSessionsProvider({
      getLiveRunStartTime: () => STARTED_BEFORE_LAUNCH,
      listLiveCliRuns: async () => [],
    });
    const statusOfLaunchWrittenBy = async (entrypoint: string) => {
      await writeTranscript(paths, entrypoint);
      return (await fetchWorkflow(provider))?.status;
    };

    // The runtime runs the CLI under `sdk-ts` (`buildClaudeSdkEnv`) whatever
    // entrypoint CloudCLI itself inherited, e.g. when it was started from
    // inside a Claude Code process: its runs write `sdk-ts` either way.
    for (const inherited of [undefined, REPL, SDK, 'sdk-cli']) {
      await withCloudCliEntrypoint(inherited, async () => {
        assert.equal(await statusOfLaunchWrittenBy(SDK), 'running', `inherited ${inherited}`);
        assert.equal(
          await statusOfLaunchWrittenBy(REPL),
          'stopped',
          `inherited ${inherited}: a dead REPL's launch is not CloudCLI's`,
        );
      });
    }
  });
});

test('a reported launch asks no run whether it is live', { concurrency: false }, async () => {
  await withWorkflowSession(async ({ transcriptPath }) => {
    await appendFile(transcriptPath, `${JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: '2026-08-21T10:50:00.000Z',
      sessionId: PROVIDER_SESSION_ID,
      content: [
        '<task-notification>',
        '<task-id>wcli1</task-id>',
        `<tool-use-id>${WORKFLOW_TOOL_USE_ID}</tool-use-id>`,
        '<status>completed</status>',
        '<summary>Dynamic workflow "Audit the frontend" completed</summary>',
        '<result>{"audits":2}</result>',
        '</task-notification>',
      ].join('\n'),
    })}\n`, 'utf8');

    // Its status comes from the report, so neither CloudCLI's runtime nor the
    // CLI's registry is consulted, which keeps the registry off the common
    // path.
    let sdkReads = 0;
    let cliReads = 0;
    const provider = new ClaudeSessionsProvider({
      getLiveRunStartTime: () => {
        sdkReads += 1;
        return STARTED_BEFORE_LAUNCH;
      },
      listLiveCliRuns: async () => {
        cliReads += 1;
        return [{ startedAt: STARTED_BEFORE_LAUNCH, entrypoint: REPL }];
      },
    });
    const workflow = await fetchWorkflow(provider);
    assert.equal(workflow?.status, 'completed');
    assert.equal(workflow?.endedAt, '2026-08-21T10:50:00.000Z');
    assert.equal(sdkReads, 0);
    assert.equal(cliReads, 0);
  });
});

test('a workflow agent the journal has not settled is running while a live process of its kind started before it', { concurrency: false }, async () => {
  await withWorkflowSession(async ({ runDirectory }) => {
    await writeRunningAgentTranscript(runDirectory, REPL);

    assert.equal(await readAgentStatus(providerWithCliRuns([{ startedAt: STARTED_BEFORE_LAUNCH, entrypoint: REPL }])), 'running');
    assert.equal(await readAgentStatus(providerWithCliRuns([{ startedAt: STARTED_AFTER_LAUNCH, entrypoint: REPL }])), 'stopped');
    assert.equal(await readAgentStatus(providerWithCliRuns([])), 'stopped');
    // Matched on the agent's own first row, like a launch: an SDK run does
    // not vouch for an agent a REPL's workflow spawned.
    assert.equal(await readAgentStatus(providerWithCliRuns([{ startedAt: STARTED_BEFORE_LAUNCH, entrypoint: SDK }])), 'stopped');

    // Rows that name no entrypoint are matched by time alone.
    await writeRunningAgentTranscript(runDirectory, null);
    assert.equal(await readAgentStatus(providerWithCliRuns([{ startedAt: STARTED_BEFORE_LAUNCH, entrypoint: SDK }])), 'running');
  });
});

test('an idle or shell REPL on the session never keeps a dead run\'s workflow running', { concurrency: false }, async () => {
  await withWorkflowSession(async (paths) => {
    // In each case the run that launched the workflow died before it
    // reported, and the Shell tab's `claude --resume`, opened before the
    // launch, sits at its prompt.
    // [label, the entrypoint the dead run's rows carry]
    const cases: Array<[string, string | null]> = [
      // CloudCLI's chat launched it, and its SDK process was then stopped or
      // crashed.
      ['a dead CloudCLI run', SDK],
      // A REPL in a terminal launched it and was closed. That process is of
      // the Shell-tab REPL's own kind, so only the status tells them apart.
      ['a dead terminal REPL', REPL],
      // Rows from a CLI that does not stamp them rule no process out.
      ['a dead run whose rows are unstamped', null],
    ];

    for (const [label, entrypoint] of cases) {
      await writeTranscript(paths, entrypoint);
      await writeRunningAgentTranscript(paths.runDirectory, entrypoint);

      for (const status of ['idle', 'shell']) {
        await withRegistry([{ status, entrypoint: REPL, kind: 'interactive', startedAt: STARTED_BEFORE_LAUNCH }], async (directory) => {
          const provider = providerReadingRegistry(directory);
          const workflow = await fetchWorkflow(provider);

          // Reading `running` here pinned a spinner on the card and listed a
          // run with a Stop that could not work, for as long as the REPL lived.
          assert.equal(workflow?.status, 'stopped', `${label}, ${status} REPL`);
          assert.deepEqual(agentStatuses(workflow), [['audit:chat', 'completed'], ['audit:sidebar', 'stopped']], `${label}, ${status} REPL`);
          assert.equal(await readAgentStatus(provider), 'stopped', `${label}, ${status} REPL`);
        });
      }
    }
  });
});

test('a busy or status-less registry process vouches only for the launches of its own kind', { concurrency: false }, async () => {
  await withWorkflowSession(async (paths) => {
    // [label, the registry records, the entrypoint the launch rows carry, expected status]
    const cases: Array<[string, Array<Record<string, unknown>>, string, WorkflowInfo['status']]> = [
      ['a busy REPL, its own launch', [{ status: 'busy', entrypoint: REPL }], REPL, 'running'],
      ['a busy REPL, an SDK run\'s launch', [{ status: 'busy', entrypoint: REPL }], SDK, 'stopped'],
      ['a REPL at a permission prompt, its own launch', [{ status: 'waiting', entrypoint: REPL }], REPL, 'running'],
      // An Agent SDK print-mode process registers without ever writing a status.
      ['a status-less SDK process, its own launch', [{ entrypoint: SDK }], SDK, 'running'],
      ['a status-less SDK process, a REPL\'s launch', [{ entrypoint: SDK }], REPL, 'stopped'],
      // Two processes on the session. The earlier one is of another kind, so
      // the later REPL that wrote the launch is the one that vouches for it.
      [
        'an earlier SDK process beside the busy REPL that wrote the launch',
        [{ entrypoint: SDK, startedAt: STARTED_BEFORE_LAUNCH - 60_000 }, { status: 'busy', entrypoint: REPL }],
        REPL,
        'running',
      ],
    ];

    for (const [label, records, entrypoint, expected] of cases) {
      await writeTranscript(paths, entrypoint);
      await withRegistry(records.map((record) => ({ startedAt: STARTED_BEFORE_LAUNCH, ...record })), async (directory) => {
        assert.equal((await fetchWorkflow(providerReadingRegistry(directory)))?.status, expected, label);
      });
    }
  });
});

test('the registry lookup reads a workflow running while its CLI process is busy with it, and stopped once that process is gone', { concurrency: false }, async () => {
  await withWorkflowSession(async () => {
    await withRegistry([], async (directory) => {
      const registryFile = path.join(directory, `${process.pid}.json`);
      // The REPL stays `busy` while the workflow it launched is unfinished,
      // even after its own turn has ended.
      await writeFile(
        registryFile,
        JSON.stringify({ pid: process.pid, sessionId: PROVIDER_SESSION_ID, status: 'busy', entrypoint: REPL, startedAt: STARTED_BEFORE_LAUNCH }),
        'utf8',
      );
      const provider = providerReadingRegistry(directory);

      const live = await fetchWorkflow(provider);
      assert.equal(live?.status, 'running');
      assert.deepEqual(agentStatuses(live), [['audit:chat', 'completed'], ['audit:sidebar', 'running']]);

      // The CLI removes its file on exit.
      await rm(registryFile);
      const exited = await fetchWorkflow(provider);
      assert.equal(exited?.status, 'stopped');
      assert.deepEqual(agentStatuses(exited), [['audit:chat', 'completed'], ['audit:sidebar', 'stopped']]);
    });
  });
});

test('the history freshness key follows the workflow journals and the live runs, and nothing else', { concurrency: false }, async () => {
  await withWorkflowSession(async ({ transcriptPath, journalPath }) => {
    let sdkRunStartedAt: number | null = null;
    let cliRuns: LiveClaudeRun[] = [{ startedAt: STARTED_BEFORE_LAUNCH, entrypoint: REPL }];
    const provider = new ClaudeSessionsProvider({
      getLiveRunStartTime: () => sdkRunStartedAt,
      listLiveCliRuns: async () => cliRuns,
    });
    const readKey = () => provider.readHistoryFreshnessKey(APP_SESSION_ID, PROVIDER_SESSION_ID, transcriptPath);

    const initial = await readKey();
    assert.equal(await readKey(), initial, 'nothing changed, so neither did the key');

    // An agent settling grows the journal; the transcript is untouched.
    await appendFile(journalPath, `${JSON.stringify({ type: 'result', key: 'v2:two', agentId: RUNNING_AGENT_ID, result: {} })}\n`, 'utf8');
    const grown = await readKey();
    assert.notEqual(grown, initial, 'a journal that grew changes the key');

    // A rewrite that keeps the size still moves the mtime.
    await utimes(journalPath, new Date('2026-08-21T12:00:00.000Z'), new Date('2026-08-21T12:00:00.000Z'));
    const touched = await readKey();
    assert.notEqual(touched, grown, 'a journal with a new mtime changes the key');

    // A second run of the session starts writing its own journal.
    const secondRun = path.join(path.dirname(path.dirname(journalPath)), 'wf_0c1d2e3f-102');
    await mkdir(secondRun, { recursive: true });
    await writeFile(path.join(secondRun, 'journal.jsonl'), `${JSON.stringify({ type: 'launched' })}\n`, 'utf8');
    const secondJournal = await readKey();
    assert.notEqual(secondJournal, touched, 'a new run\'s journal changes the key');

    // A second live process joins the session: the same runs listed in
    // another order are the same runs.
    cliRuns = [{ startedAt: STARTED_BEFORE_LAUNCH, entrypoint: REPL }, { startedAt: STARTED_AFTER_LAUNCH, entrypoint: SDK }];
    const twoRuns = await readKey();
    assert.notEqual(twoRuns, secondJournal, 'a process joining changes the key');
    cliRuns = [...cliRuns].reverse();
    assert.equal(await readKey(), twoRuns, 'the order the registry lists runs in does not matter');

    // The same start under another entrypoint vouches for other launches.
    cliRuns = [{ startedAt: STARTED_BEFORE_LAUNCH, entrypoint: SDK }, { startedAt: STARTED_AFTER_LAUNCH, entrypoint: SDK }];
    const otherKind = await readKey();
    assert.notEqual(otherKind, twoRuns, 'a run\'s entrypoint changes the key');

    // CloudCLI's own run starting is a live run too.
    sdkRunStartedAt = STARTED_AFTER_LAUNCH + 1_000;
    const ownRun = await readKey();
    assert.notEqual(ownRun, otherKind, 'CloudCLI\'s own run starting changes the key');

    // Every process exits, or comes to rest: no file of the session changes,
    // but the key must.
    sdkRunStartedAt = null;
    cliRuns = [];
    const exited = await readKey();
    assert.notEqual(exited, ownRun, 'the live runs ending changes the key');
    assert.equal(await readKey(), exited);
  });
});

test('the history freshness key follows a registry process coming to rest', { concurrency: false }, async () => {
  await withWorkflowSession(async ({ transcriptPath }) => {
    const registryRecord = (status: string) =>
      JSON.stringify({ pid: process.pid, sessionId: PROVIDER_SESSION_ID, status, entrypoint: REPL, startedAt: STARTED_BEFORE_LAUNCH });

    await withRegistry([], async (directory) => {
      const registryFile = path.join(directory, `${process.pid}.json`);
      const provider = providerReadingRegistry(directory);
      const readKey = () => provider.readHistoryFreshnessKey(APP_SESSION_ID, PROVIDER_SESSION_ID, transcriptPath);

      await writeFile(registryFile, registryRecord('busy'), 'utf8');
      const busy = await readKey();

      // Coming to rest drops the process from the runs a launch is matched
      // against, so a cached history built while it was busy is stale.
      await writeFile(registryFile, registryRecord('idle'), 'utf8');
      const idle = await readKey();
      assert.notEqual(idle, busy, 'a process coming to rest changes the key');

      // A process at rest exiting changes nothing the history depends on.
      await rm(registryFile);
      assert.equal(await readKey(), idle, 'a resting process exiting leaves the key as it was');
    });
  });
});

test('a session with no workflows has a stable freshness key', { concurrency: false }, async () => {
  await withWorkflowSession(async ({ transcriptPath, runDirectory }) => {
    await rm(path.dirname(path.dirname(runDirectory)), { recursive: true, force: true });
    const provider = providerWithCliRuns([]);

    const first = await provider.readHistoryFreshnessKey(APP_SESSION_ID, PROVIDER_SESSION_ID, transcriptPath);
    assert.equal(await provider.readHistoryFreshnessKey(APP_SESSION_ID, PROVIDER_SESSION_ID, transcriptPath), first);
  });
});
