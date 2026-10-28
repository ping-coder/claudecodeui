import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { claudeRuntime, listClaudeSDKBackgroundWork } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { createProviderRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import { chatRunRegistry, connectedClients, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { IProvider } from '@/shared/interfaces.js';
import type { ProviderRuntimeContext } from '@/shared/types.js';

/**
 * The chat gateway, the run registry and the provider runtime service around
 * the real Claude runtime, with only the SDK query scripted: a turn that
 * leaves a workflow running keeps its process, and the session's next turn
 * runs in it. Stopping that turn ends it as aborted, as stopping any turn
 * does, and the dispatch of the turn that left the work going is let go once
 * its process has gone on to the next turn.
 */

type Message = Record<string, unknown>;

/** One scripted SDK query: what the test emits is what the CLI says. */
function createScriptedQuery() {
  const queue: Array<Message | null> = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let created = false;
  const prompts: Message[] = [];
  const calls: string[] = [];

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    created = true;
    void (async () => {
      for await (const message of prompt) {
        prompts.push(message as Message);
      }
      calls.push('release');
    })();
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
      interrupt: async () => { calls.push('interrupt'); },
      stopTask: async (taskId: string) => { calls.push(`stop:${taskId}`); },
      cancelAsyncMessage: async () => true,
      setModel: async () => {},
      setPermissionMode: async () => {},
      close: () => {
        if (!closed) {
          closed = true;
          calls.push('close');
          wake?.();
        }
      },
    });
  };

  return {
    createQuery,
    prompts,
    calls,
    /** Whether the run built its query, which is when it starts a CLI of its own. */
    created: () => created,
    emit: (message: Message) => { queue.push(message); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
  };
}

async function flush(rounds = 10): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!condition() && performance.now() < deadline) {
    await flush(1);
  }
  assert.equal(condition(), true, 'condition never became true');
}

const NATIVE_ID = 'native-held-turn-gateway';
const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'done', duration_ms: 1, num_turns: 1 });
const echo = (uuid: unknown, content: string) => ({
  type: 'user', isReplay: true, uuid, session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'user', content },
});
const assistantText = (text: string) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

/** The first turn launches a workflow, which the runtime tracks, and completes. */
function launchWorkflowAndComplete(query: ReturnType<typeof createScriptedQuery>): void {
  query.emit(init());
  query.emit({
    type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_wf', name: 'Workflow', input: { script: 'x' } }] },
  });
  query.emit({
    type: 'system', subtype: 'task_started', session_id: NATIVE_ID,
    task_id: 'wf1', tool_use_id: 'toolu_wf', description: 'Task wf1', task_type: 'local_workflow',
  });
  query.emit({
    type: 'user', uuid: randomUUID(), session_id: NATIVE_ID, parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_wf', content: 'Workflow launched' }] },
  });
  query.emit(result());
}

type Gateway = {
  service: ReturnType<typeof createProviderRuntimeService>;
  queries: Array<ReturnType<typeof createScriptedQuery>>;
  sessionId: string;
  userId: number;
  cwd: string;
};

/** A database with a user and a Claude session, and the runtime service around the real Claude runtime. */
async function withGateway(runTest: (gateway: Gateway) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-held-turn-gateway-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const queries: Array<ReturnType<typeof createScriptedQuery>> = [];
  try {
    // Run notifications read the user's preferences.
    const userId = Number(userDb.createUser(`held-turn-${randomUUID()}`, 'not-a-real-hash').id);
    const sessionId = `app-held-turn-gateway-${randomUUID()}`;
    sessionsDb.createAppSession(sessionId, 'claude', tempDirectory);

    const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
    // Every run gets a query of its own; a turn that goes into a held process never builds one.
    const provider = {
      id: 'claude',
      runtime: {
        ...claudeRuntime,
        run: (command: string, options: Message, writer: never, context: ProviderRuntimeContext) => {
          const query = createScriptedQuery();
          queries.push(query);
          return claudeRuntime.run(command, options, writer, { ...context, createQuery: query.createQuery });
        },
      },
      sessions: { normalizeMessage: (raw: unknown, id: string | null) => sessions.normalizeMessage(raw as never, id) },
      auth: { getStatus: async () => ({ installed: true }) },
    } as unknown as IProvider;
    const service = createProviderRuntimeService({
      listProviders: () => [provider],
      resolveProvider: () => provider,
      resolveProviderSessionId: () => null,
      resolveResumeModel: async () => undefined,
      getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
      getSession: (id) => sessionsDb.getSessionById(id),
    });
    chatRunRegistry.setRetentionGuard((id) => listClaudeSDKBackgroundWork().some((entry) => entry.sessionId === id));

    await runTest({ service, queries, sessionId, userId, cwd: tempDirectory });
  } finally {
    for (const query of queries) {
      query.end();
    }
    await flush(30);
    connectedClients.clear();
    chatRunRegistry.clearAll();
    chatRunRegistry.setRetentionGuard(() => false);
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('stopping a turn that went into the held process ends it as aborted, once, and the first turn\'s dispatch is let go at the hand-over', async () => {
  await withGateway(async ({ service, queries, sessionId, userId, cwd }) => {
    const firstDispatch = runDetachedChatTurn({ sessionId, userId, content: 'Start the workflow', options: { cwd } }, { runtime: service });
    let firstLetGo = false;
    void firstDispatch.then(() => { firstLetGo = true; });
    await waitUntil(() => queries[0]?.prompts.length === 1);
    const held = queries[0];
    launchWorkflowAndComplete(held);
    await waitUntil(() => !chatRunRegistry.isProcessing(sessionId));
    const firstRun = chatRunRegistry.getRun(sessionId);
    assert.ok(firstRun);
    await flush();
    assert.equal(firstLetGo, false, 'the process is still the first turn\'s own');

    const secondDispatch = runDetachedChatTurn({ sessionId, userId, content: 'Now the docs', options: { cwd } }, { runtime: service });
    await waitUntil(() => held.prompts.length === 2);
    assert.equal(queries[1]?.created(), false, 'the second turn went into the held process');
    const secondRun = chatRunRegistry.getRun(sessionId);
    assert.ok(secondRun && secondRun !== firstRun);
    await waitUntil(() => firstLetGo);
    assert.deepEqual(await firstDispatch, { started: true, error: null });

    held.emit(echo(held.prompts[1]?.uuid, 'Now the docs'));
    held.emit(assistantText('Writing the docs'));
    await flush();

    assert.equal(await chatRunRegistry.abortRun(sessionId, (provider, id) => service.abort(provider, id)), true);
    await secondDispatch;
    await flush();

    const secondCompletes = secondRun.events.filter((event) => event.kind === 'complete');
    assert.equal(secondCompletes.length, 1);
    assert.equal(secondCompletes[0]?.aborted, true);
    assert.equal(secondCompletes[0]?.exitCode, 0);
    assert.deepEqual(chatRunRegistry.listRecentRunEnds().map((end) => end.outcome), ['done', 'aborted']);
  });
});

test('the hand-over plan of a session reads the send as its run would: same options go in, another effort does not', async () => {
  await withGateway(async ({ service, queries, sessionId, userId, cwd }) => {
    void runDetachedChatTurn({ sessionId, userId, content: 'Start the workflow', options: {} }, { runtime: service });
    await waitUntil(() => queries[0]?.prompts.length === 1);
    launchWorkflowAndComplete(queries[0]);
    await waitUntil(() => !chatRunRegistry.isProcessing(sessionId));
    await flush();

    // The client's options name no directory: the session's project is the
    // turn's, as it was the first turn's.
    assert.deepEqual(await service.planSessionHandOver(sessionId, {}), { heldWork: true, canHandOver: true, changes: [], switches: [] });
    const withAnotherEffort = await service.planSessionHandOver(sessionId, { cwd, effort: 'max' });
    assert.equal(withAnotherEffort.heldWork, true);
    assert.equal(withAnotherEffort.canHandOver, false);
    assert.ok(withAnotherEffort.changes.includes('effort'));
    assert.equal(queries[0]?.prompts.length, 1, 'planning wrote nothing to the process');
  });
});
