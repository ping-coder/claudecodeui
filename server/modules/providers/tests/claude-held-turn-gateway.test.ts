import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { claudeRuntime, listClaudeSDKBackgroundWork } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { createProviderRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import { closeScheduledMessageDispatcher, initializeScheduledMessageDispatcher } from '@/modules/scheduled-messages/index.js';
import { chatRunRegistry, connectedClients, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { IProvider } from '@/shared/interfaces.js';
import type { ProviderRuntimeContext } from '@/shared/types.js';

/**
 * The chat gateway, the run registry and the provider runtime service around
 * the real Claude runtime, with only the SDK query scripted: a turn that
 * leaves a workflow running keeps its process, and the session's next turn
 * runs in it. Stopping that turn ends it as aborted, as stopping any turn
 * does, while the work goes on, and the dispatch of the turn that left the
 * work going is let go once its process has gone on to the next turn.
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
  // The prompts (`prompt:<text>`) and the switches the CLI got, in order.
  const switchesAndPrompts: string[] = [];
  // The CLI answers a switch on a line of its own, which the SDK reads in a
  // later turn of the event loop than the one that sent it.
  const answerSwitch = (entry: string) => {
    switchesAndPrompts.push(entry);
    return new Promise<void>((resolve) => { setImmediate(resolve); });
  };

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    created = true;
    void (async () => {
      for await (const message of prompt) {
        prompts.push(message as Message);
        switchesAndPrompts.push(`prompt:${String((message as { message?: { content?: unknown } }).message?.content)}`);
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
      setModel: (model?: string) => answerSwitch(`setModel:${String(model)}`),
      setPermissionMode: (mode: string) => answerSwitch(`setPermissionMode:${mode}`),
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
    switchesAndPrompts,
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
// The `result` that ends a prompt's turn the user interrupted, as CLI 2.1.312 writes it.
const interruptedResult = (uuid: unknown) => ({
  type: 'result', subtype: 'error_during_execution', is_error: true, session_id: NATIVE_ID, duration_ms: 1, num_turns: 1,
  origin: { kind: 'human' }, user_message_uuid: uuid, user_message_uuids: [uuid],
});
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

test('stopping a turn that went into the held process ends it as aborted, once, leaves the workflow running, and the first turn\'s dispatch is let go at the hand-over', async () => {
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

    const aborting = chatRunRegistry.abortRun(sessionId, (provider, id) => service.abort(provider, id));
    await waitUntil(() => held.calls.includes('interrupt'));
    // The CLI ends the interrupted turn, as CLI 2.1.312 does.
    held.emit(interruptedResult(held.prompts[1]?.uuid));
    assert.equal(await aborting, true);
    await secondDispatch;
    await flush();

    const secondCompletes = secondRun.events.filter((event) => event.kind === 'complete');
    assert.equal(secondCompletes.length, 1);
    assert.equal(secondCompletes[0]?.aborted, true);
    assert.equal(secondCompletes[0]?.exitCode, 0);
    assert.deepEqual(chatRunRegistry.listRecentRunEnds().map((end) => end.outcome), ['done', 'aborted']);
    assert.deepEqual(held.calls, ['interrupt'], 'the workflow is not stopped, and the process keeps its input');
    assert.deepEqual(
      listClaudeSDKBackgroundWork().filter((entry) => entry.sessionId === sessionId).flatMap((entry) => entry.tasks.map((task) => task.taskId)),
      ['wf1'],
    );
    assert.equal(chatRunRegistry.isProcessing(sessionId), false, 'the session takes the next send');
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

test('two messages sent into a held /loop back to back, as the scheduled-messages dispatcher sends due ones, run with their own model and permission mode, and leave the loop with its own', async () => {
  await withGateway(async ({ service, queries, sessionId, userId, cwd }) => {
    // The /loop, sent from the composer: sonnet, default permissions.
    const composer = { model: 'sonnet', effort: 'high', permissionMode: 'default', toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false } };
    void runDetachedChatTurn({ sessionId, userId, content: '/loop check the deploy', options: { cwd, ...composer } }, { runtime: service });
    await waitUntil(() => queries[0]?.prompts.length === 1);
    const held = queries[0];
    held.emit(init());
    held.emit(echo(held.prompts[0]?.uuid, '/loop check the deploy'));
    held.emit({
      type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_wakeup', name: 'ScheduleWakeup', input: { delaySeconds: 300, prompt: '/loop check the deploy', reason: 'polling' } }] },
    });
    held.emit({
      type: 'user', uuid: randomUUID(), session_id: NATIVE_ID, parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_wakeup', content: 'Next wakeup scheduled (in 300s).' }] },
      tool_use_result: { scheduledFor: Date.now() + 5 * 60 * 1000, clampedDelaySeconds: 300, wasClamped: false },
    });
    held.emit(result());
    await waitUntil(() => !chatRunRegistry.isProcessing(sessionId));
    await flush();

    // Two due messages, with the options the dispatcher gives them: A
    // switches both for its turn, B names the loop's own and goes as soon as
    // A's turn is over, before the CLI has answered A's switches back.
    const dispatched = (options: Message) => ({ ...options, inheritUnset: true, restoreSwitchesAfterTurn: true });
    const sendB = () => runDetachedChatTurn(
      { sessionId, userId, content: 'B', options: dispatched({ model: 'sonnet', effort: 'high', permissionMode: 'default' }) },
      { runtime: service },
    );
    let b: ReturnType<typeof sendB> | null = null;
    const a = runDetachedChatTurn(
      { sessionId, userId, content: 'A', options: dispatched({ model: 'opus', effort: 'high', permissionMode: 'acceptEdits' }), onTurnEnded: () => { b = sendB(); } },
      { runtime: service },
    );
    await waitUntil(() => held.prompts.length === 2);
    await flush();
    held.emit(echo(held.prompts[1]?.uuid, 'A'));
    held.emit(result());
    await waitUntil(() => held.prompts.length === 3);
    held.emit(echo(held.prompts[2]?.uuid, 'B'));
    held.emit(result());
    assert.deepEqual(await a, { started: true, error: null });
    assert.ok(b);
    assert.deepEqual(await b, { started: true, error: null });
    await flush(30);

    // What each prompt ran with, as the CLI applied the switches in order.
    let model = 'sonnet';
    let permissionMode = 'default';
    const ranWith: Record<string, string> = {};
    for (const entry of held.switchesAndPrompts) {
      if (entry.startsWith('setModel:')) {
        model = entry.slice('setModel:'.length);
      } else if (entry.startsWith('setPermissionMode:')) {
        permissionMode = entry.slice('setPermissionMode:'.length);
      } else {
        ranWith[entry] = `${model} ${permissionMode}`;
      }
    }
    assert.deepEqual(ranWith, {
      'prompt:/loop check the deploy': 'sonnet default',
      'prompt:A': 'opus acceptEdits',
      'prompt:B': 'sonnet default',
    });
    assert.equal(`${model} ${permissionMode}`, 'sonnet default', 'the loop is left with its own');
    assert.equal(queries.filter((query) => query.created()).length, 1, 'both went into the held process');
  });
});

test('a message sent into a held /loop while the loop runs a turn of its own, and stopped before it goes in, leaves the session\'s model as the user had it', async () => {
  await withGateway(async ({ service, queries, sessionId, userId, cwd }) => {
    const recordedModel = () => sessionsDb.getSessionById(sessionId)?.model ?? null;
    const scheduleWakeup = (query: ReturnType<typeof createScriptedQuery>, id: string) => {
      query.emit({
        type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'ScheduleWakeup', input: { delaySeconds: 300, prompt: '/loop check the deploy', reason: 'polling' } }] },
      });
      query.emit({
        type: 'user', uuid: randomUUID(), session_id: NATIVE_ID, parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Next wakeup scheduled (in 300s).' }] },
        tool_use_result: { scheduledFor: Date.now() + 5 * 60 * 1000, clampedDelaySeconds: 300, wasClamped: false },
      });
    };
    // The /loop, sent from the composer with sonnet.
    const loopDispatch = runDetachedChatTurn(
      { sessionId, userId, content: '/loop check the deploy', options: { cwd, model: 'sonnet', effort: 'high', permissionMode: 'default' } },
      { runtime: service },
    );
    let loopLetGo = false;
    void loopDispatch.then(() => { loopLetGo = true; });
    await waitUntil(() => queries[0]?.prompts.length === 1);
    const held = queries[0];
    held.emit(init());
    held.emit(echo(held.prompts[0]?.uuid, '/loop check the deploy'));
    scheduleWakeup(held, 'toolu_wakeup');
    held.emit(result());
    await waitUntil(() => !chatRunRegistry.isProcessing(sessionId));
    await flush();
    assert.equal(recordedModel(), 'sonnet');

    // The wake-up fires: the loop runs a turn of its own.
    held.emit({ type: 'command_lifecycle', uuid: randomUUID(), command_uuid: randomUUID(), state: 'started', wakeup_source: 'loop_wakeup', session_id: NATIVE_ID });
    held.emit(init());
    held.emit(assistantText('Checking the deploy'));
    await flush();

    // A due message with another model, with the options the dispatcher gives it.
    const message = runDetachedChatTurn(
      { sessionId, userId, content: 'Summarise with Opus', options: { model: 'opus', effort: 'high', permissionMode: 'default', inheritUnset: true, restoreSwitchesAfterTurn: true } },
      { runtime: service },
    );
    await waitUntil(() => loopLetGo);
    assert.equal(recordedModel(), 'opus', 'the message runs with its own model');
    assert.equal(held.prompts.length, 1, 'it waits for the loop\'s turn to end');

    assert.equal(await chatRunRegistry.abortRun(sessionId, (provider, id) => service.abort(provider, id)), true);
    assert.deepEqual(await message, { started: true, error: null });
    await flush();
    assert.equal(recordedModel(), 'sonnet', 'the session\'s model is the user\'s again');

    // The loop's turn sets the next wake-up and ends: the loop keeps its process, never switched.
    scheduleWakeup(held, 'toolu_wakeup_2');
    held.emit(result());
    await flush();
    assert.deepEqual(held.switchesAndPrompts.filter((entry) => entry.startsWith('set')), []);
    assert.equal(held.calls.includes('release'), false);
    assert.equal(recordedModel(), 'sonnet');
    assert.equal(queries.filter((query) => query.created()).length, 1);
  });
});

/** Starts a /loop from the composer, its process launched with `launch`, and waits for its first turn to end with the job held. */
async function startLoop(gateway: Gateway, launch: Message) {
  const { service, queries, sessionId, userId, cwd } = gateway;
  void runDetachedChatTurn({ sessionId, userId, content: '/loop 30m check CI', options: { cwd, ...launch } }, { runtime: service });
  await waitUntil(() => queries[0]?.prompts.length === 1);
  const held = queries[0];
  held.emit(init());
  held.emit(echo(held.prompts[0]?.uuid, '/loop 30m check CI'));
  held.emit({
    type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_cron', name: 'CronCreate', input: { cron: '*/30 * * * *', prompt: 'check CI', recurring: true } }] },
  });
  held.emit({
    type: 'user', uuid: randomUUID(), session_id: NATIVE_ID, parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_cron', content: 'Scheduled recurring job b2148320 (Every 30 minutes).' }] },
    tool_use_result: { id: 'b2148320', humanSchedule: 'Every 30 minutes', recurring: true, durable: false, nextFireAt: Date.now() + 30 * 60 * 1000 },
  });
  held.emit(result());
  await waitUntil(() => !chatRunRegistry.isProcessing(sessionId));
  await flush();
  assert.equal(service.hasScheduledWork(sessionId), true);
  return held;
}

// The loop started while the user allowed Bash outright.
const LOOP_LAUNCH = { model: 'sonnet', effort: 'high', permissionMode: 'default', toolsSettings: { allowedTools: ['Bash'], disallowedTools: [], skipPermissions: false } };
// A queued message's options as the scheduled-messages dispatcher sends them (its `dispatchedTurn`).
const dispatched = (options: Message) => ({ ...options, inheritUnset: true, restoreSwitchesAfterTurn: true, keepBackgroundWork: true });

test('a queued message whose tool rules deny what a /loop\'s process allows is kept out by both plans the dispatcher makes, and fails if sent all the same, leaving the loop as it was', async () => {
  await withGateway(async (gateway) => {
    const { service, queries, sessionId, userId } = gateway;
    const held = await startLoop(gateway, LOOP_LAUNCH);
    // Queued once the user had stopped allowing Bash and denied git push.
    const options = dispatched({ model: 'sonnet', effort: 'max', permissionMode: 'default', toolsSettings: { allowedTools: [], disallowedTools: ['Bash(git push:*)'], skipPermissions: false } });
    const plan = (planOptions: Message) => service.planHandOver('claude', sessionId, { ...options, sessionId, cwd: gateway.cwd }, planOptions);
    // A process of its own would bring the loop's cron job back, which the
    // dispatcher sends it to when its own settings keep it out
    // (`replaceKeepsWork`); a turn that accepts the process's settings never
    // starts one.
    const details = { tools: { notAllowed: ['Bash'], alsoDenied: ['Bash(git push:*)'] } };
    assert.deepEqual(
      await plan({ inheritUnset: true }),
      { heldWork: true, canHandOver: false, changes: ['effort', 'tools'], switches: [], details, replaceKeepsWork: true },
    );
    assert.deepEqual(
      await plan({ inheritUnset: true, acceptProcessSettings: true }),
      { heldWork: true, canHandOver: false, changes: ['tools'], switches: [], details, replaceKeepsWork: true },
    );

    const failures: unknown[] = [];
    const outcome = await runDetachedChatTurn({
      sessionId,
      userId,
      content: 'Push the fix',
      options: { ...options, acceptProcessSettings: true },
      onHandOverFailed: (failure) => { failures.push(failure); },
    }, { runtime: service });
    assert.deepEqual(outcome, {
      started: true,
      error: 'Not sent: this message changes the tool permissions, which only a new Claude process can apply, and a new process would stop the session\'s scheduled work.',
    });
    assert.deepEqual(failures, [{ reason: 'stale-plan', content: outcome.error }], 'the gateway reads why off the run\'s HAND_OVER_FAILED error');
    await flush();
    assert.equal(chatRunRegistry.isProcessing(sessionId), false, 'the run is over');
    assert.equal(held.prompts.length, 1, 'nothing went into the loop\'s process');
    assert.equal(queries.filter((query) => query.created()).length, 1, 'no new process');
    assert.deepEqual(held.calls, [], 'the loop\'s process is not interrupted, stopped or let go');
    assert.equal(service.hasScheduledWork(sessionId), true);
  });
});

test('a queued message whose tool rules are stricter than a cron loop\'s process goes in a process of its own, which takes the loop over, and waits for nothing', async () => {
  await withGateway(async (gateway) => {
    const { service, queries, sessionId, userId } = gateway;
    const held = await startLoop(gateway, LOOP_LAUNCH);
    const waits: unknown[] = [];
    connectedClients.add({
      readyState: 1,
      send: (data: string) => {
        const frame = JSON.parse(data) as Message;
        if (frame.kind === 'dispatch_waiting') {
          waits.push(frame.wait);
        }
      },
    } as never);
    try {
      // Queued once the user had stopped allowing Bash.
      sessionDraftsDb.appendQueuedMessage(userId, sessionId, {
        content: 'Check CI now',
        options: { model: 'sonnet', effort: 'high', permissionMode: 'default', toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false } },
        attachments: [],
      });
      // The dispatcher's first pass runs as it starts.
      initializeScheduledMessageDispatcher(service);
      await waitUntil(() => held.calls.includes('release'));
      assert.equal(held.prompts.length, 1, 'nothing went into the loop\'s process');
      held.end();
      await waitUntil(() => queries.length === 2 && queries[1].prompts.length === 1);
      assert.equal((queries[1].prompts[0]?.message as { content?: unknown } | undefined)?.content, 'Check CI now');
      queries[1].emit(init());
      queries[1].emit(result());
      await waitUntil(() => queries[1].calls.includes('release'));
      assert.deepEqual(sessionDraftsDb.listQueuedMessages(), [], 'sent');
      assert.deepEqual(waits, [], 'it never waited');
    } finally {
      closeScheduledMessageDispatcher();
    }
  });
});

test('a queued message whose tool rules are stricter than a cron loop\'s process goes while the loop fires, and its process of its own takes the loop over once the fire is over', async (t) => {
  // The runtime logs each turn that starts waiting for a turn of the CLI's own.
  let fireWaits = 0;
  const log = console.log.bind(console);
  t.mock.method(console, 'log', (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('it waits for the turn the CLI runs on its own to be over')) {
      fireWaits += 1;
    }
    log(...args);
  });
  await withGateway(async (gateway) => {
    const { service, queries, sessionId, userId } = gateway;
    const held = await startLoop(gateway, LOOP_LAUNCH);
    const waits: unknown[] = [];
    connectedClients.add({
      readyState: 1,
      send: (data: string) => {
        const frame = JSON.parse(data) as Message;
        if (frame.kind === 'dispatch_waiting') {
          waits.push(frame.wait);
        }
      },
    } as never);
    // Queued once the user had stopped allowing Bash.
    const options = { model: 'sonnet', effort: 'high', permissionMode: 'default', toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false } };
    try {
      // The loop's job fires.
      held.emit({ type: 'command_lifecycle', uuid: randomUUID(), session_id: NATIVE_ID, command_uuid: randomUUID(), state: 'started', wakeup_source: 'schedule_wakeup' });
      held.emit(init());
      held.emit(assistantText('Checking CI.'));
      const plan = () => service.planHandOver('claude', sessionId, { ...dispatched(options), sessionId, cwd: gateway.cwd }, { inheritUnset: true });
      const deadline = performance.now() + 5000;
      while (!(await plan()).afterCliTurn && performance.now() < deadline) {
        await flush(1);
      }
      assert.deepEqual(
        await plan(),
        { heldWork: true, canHandOver: false, changes: ['tools'], switches: [], details: { tools: { notAllowed: ['Bash'], alsoDenied: [] } }, replaceKeepsWork: true, afterCliTurn: true },
      );

      sessionDraftsDb.appendQueuedMessage(userId, sessionId, { content: 'Check CI now', options, attachments: [] });
      // The dispatcher's first pass runs as it starts; the message's run waits for the fire.
      initializeScheduledMessageDispatcher(service);
      await waitUntil(() => fireWaits === 1);
      assert.deepEqual(held.calls, [], 'the fire is not interrupted, and the loop\'s process is not let go');
      assert.deepEqual(waits, [], 'nothing waits, and nothing offers to stop the loop');

      held.emit(result());
      await waitUntil(() => held.calls.includes('release'));
      assert.equal(held.prompts.length, 1, 'nothing went into the loop\'s process');
      held.end();
      await waitUntil(() => queries.length === 2 && queries[1].prompts.length === 1);
      assert.equal((queries[1].prompts[0]?.message as { content?: unknown } | undefined)?.content, 'Check CI now');
      queries[1].emit(init());
      queries[1].emit(result());
      await waitUntil(() => queries[1].calls.includes('release'));
      assert.deepEqual(sessionDraftsDb.listQueuedMessages(), [], 'sent');
      assert.deepEqual(waits, [], 'it never waited');
    } finally {
      closeScheduledMessageDispatcher();
    }
  });
});

test('a queued message whose tool rules are no stricter than a /loop\'s process goes into it on the process\'s effort and deny rules', async () => {
  await withGateway(async (gateway) => {
    const { service, queries, sessionId, userId } = gateway;
    const held = await startLoop(gateway, { ...LOOP_LAUNCH, toolsSettings: { allowedTools: ['Bash'], disallowedTools: ['WebFetch'], skipPermissions: false } });
    const options = dispatched({ model: 'sonnet', effort: 'max', permissionMode: 'default', toolsSettings: { allowedTools: ['Bash', 'Read'], disallowedTools: [], skipPermissions: false } });
    assert.deepEqual(
      await service.planHandOver('claude', sessionId, { ...options, sessionId, cwd: gateway.cwd }, { inheritUnset: true, acceptProcessSettings: true }),
      { heldWork: true, canHandOver: true, changes: [], switches: [] },
    );
    const turn = runDetachedChatTurn({ sessionId, userId, content: 'Summarise the failures', options: { ...options, acceptProcessSettings: true } }, { runtime: service });
    await waitUntil(() => held.prompts.length === 2);
    assert.equal(queries.filter((query) => query.created()).length, 1, 'it went into the loop\'s process');
    const uuid = held.prompts[1]?.uuid;
    held.emit(echo(uuid, 'Summarise the failures'));
    held.emit({ ...result(), user_message_uuid: uuid, user_message_uuids: [uuid] });
    assert.deepEqual(await turn, { started: true, error: null });
    await flush();
    assert.deepEqual(held.calls, [], 'the loop keeps its process');
    assert.equal(service.hasScheduledWork(sessionId), true);
  });
});
