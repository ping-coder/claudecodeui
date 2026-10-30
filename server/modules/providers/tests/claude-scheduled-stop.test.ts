import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { buildScheduledStopMessage } from '@/modules/providers/list/claude/claude-scheduled-work.js';
import { claudeRuntime, queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { createProviderRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * Stopping scheduled work (`stopScheduledWork`): a dynamic loop alone is
 * stopped by letting go of its process; anything else takes a turn in which
 * the model cancels it, handed to the held process so its other work keeps
 * running. These drive `queryClaudeSDK` with a scripted SDK stream, as
 * claude-runtime-held-turn.test.ts does, and run the turns a stop asks for
 * through the same runtime.
 */

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  /** Every message read off the held prompt stream, in order. */
  prompts: Array<Record<string, unknown>>;
  /** `prompt:<uuid>`, `setModel:<model>`, `setPermissionMode:<mode>`, `interrupt`, `stop:<taskId>`, `release`. */
  calls: string[];
  released: () => boolean;
  created: () => boolean;
};

function createScriptedQuery(): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  let released = false;
  let closed = false;
  let created = false;
  const prompts: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  const script: Scripted = {
    emit: (message) => { queue.push(message); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
    prompts,
    calls,
    released: () => released,
    created: () => created,
  };
  // The CLI answers a switch in a later turn of the event loop.
  const answer = (call: string) => {
    calls.push(call);
    return new Promise<void>((resolve) => { setImmediate(resolve); });
  };
  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    created = true;
    void (async () => {
      for await (const message of prompt) {
        const record = message as Record<string, unknown>;
        prompts.push(record);
        calls.push(`prompt:${String(record.uuid)}`);
      }
      released = true;
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
      setModel: (model?: string) => answer(`setModel:${String(model)}`),
      setPermissionMode: (mode: string) => answer(`setPermissionMode:${mode}`),
      interrupt: async () => { calls.push('interrupt'); },
      stopTask: async (taskId: string) => { calls.push(`stop:${taskId}`); },
      cancelAsyncMessage: async () => true,
      close: () => {
        if (!closed) {
          closed = true;
          calls.push('close');
          wake?.();
        }
      },
    });
  };
  return { createQuery, script };
}

function createWriter() {
  const sent: NormalizedMessage[] = [];
  let finishedReports = 0;
  const writer = {
    send: (message: NormalizedMessage) => { sent.push(message); },
    userId: null,
    reportBackgroundWorkFinished: () => { finishedReports += 1; },
    reportProcessHandedOver: () => {},
  };
  return { writer, sent, finishedReports: () => finishedReports };
}

function createContext(): Omit<ProviderRuntimeContext, 'createQuery'> {
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  return {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
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

const MINUTE = 60 * 1000;
const NATIVE_ID = 'native-scheduled-stop-session';
const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id: string, text: string, output?: Record<string, unknown>) => ({
  type: 'user', uuid: randomUUID(), session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  ...(output ? { tool_use_result: output } : {}),
});
const taskStarted = (taskId: string, toolUseId: string) => ({
  type: 'system', subtype: 'task_started', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, description: `Task ${taskId}`, task_type: 'local_workflow',
});
const taskNotification = (taskId: string, toolUseId: string, status: string) => ({
  type: 'system', subtype: 'task_notification', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, status, summary: `Task ${taskId} ${status}`, output_file: '',
});
const echo = (uuid: string, content: string) => ({
  type: 'user', isReplay: true, uuid, session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'user', content },
});
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'done', duration_ms: 1, num_turns: 1 });
const resultFor = (uuid: string) => ({ ...result(), user_message_uuid: uuid, user_message_uuids: [uuid] });

function launchWorkflow(script: Scripted): void {
  script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
  script.emit(taskStarted('wf1', 'toolu_wf'));
  script.emit(toolResult('toolu_wf', 'Workflow launched in background. Task ID: wf1'));
}

function launchUntrackedMonitor(script: Scripted): void {
  script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
  script.emit(toolResult('toolu_monitor', 'Monitor started'));
}

function armWakeup(script: Scripted, id = 'toolu_wakeup_1'): void {
  const scheduledFor = Math.ceil((Date.now() + 20 * MINUTE) / MINUTE) * MINUTE;
  script.emit(toolUse(id, 'ScheduleWakeup', { delaySeconds: 1200, prompt: '<<autonomous-loop-dynamic>>', reason: 'polling' }));
  script.emit(toolResult(id, 'Next wakeup scheduled.', { scheduledFor, clampedDelaySeconds: 1200, wasClamped: false }));
}

function stopLoop(script: Scripted): void {
  const id = `toolu_stop_${randomUUID()}`;
  script.emit(toolUse(id, 'ScheduleWakeup', { stop: true }));
  script.emit(toolResult(id, 'Loop stopped.', { scheduledFor: 0, clampedDelaySeconds: 0, wasClamped: false, stopped: true, cancelledWakeups: 1 }));
}

function createCronJob(script: Scripted, jobId: string | null, { output = true }: { output?: boolean } = {}): void {
  const id = `toolu_cron_${jobId ?? 'old'}`;
  script.emit(toolUse(id, 'CronCreate', { cron: '*/5 * * * *', prompt: 'check the deploy', recurring: true }));
  script.emit(toolResult(
    id,
    jobId ? `Scheduled recurring job ${jobId} (Every 5 minutes).` : 'Scheduled.',
    output && jobId ? { id: jobId, humanSchedule: 'Every 5 minutes', recurring: true, durable: false, nextFireAt: Date.now() + 5 * MINUTE } : undefined,
  ));
}

function deleteCronJob(script: Scripted, jobId: string): void {
  const id = `toolu_cron_delete_${randomUUID()}`;
  script.emit(toolUse(id, 'CronDelete', { id: jobId }));
  script.emit(toolResult(id, `Cancelled job ${jobId}.`, { id: jobId }));
}

type HeldRun = {
  sessionId: string;
  cwd: string;
  script: Scripted;
  first: ReturnType<typeof createWriter>;
  firstRun: Promise<unknown>;
  later: Array<ReturnType<typeof createScriptedQuery>>;
};

/** A run whose first turn sets up `launch` and completes. */
async function startRun(launch: (script: Scripted) => void, runOptions: Record<string, unknown> = {}, { complete = true } = {}): Promise<HeldRun> {
  const sessionId = `app-scheduled-stop-${randomUUID()}`;
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-scheduled-stop-'));
  const { createQuery, script } = createScriptedQuery();
  const first = createWriter();
  const firstRun = queryClaudeSDK('start the loop', { sessionId, cwd, ...runOptions }, first.writer as never, { ...createContext(), createQuery });
  await waitUntil(() => script.prompts.length === 1);
  script.emit(init());
  script.emit(echo(String(script.prompts[0]?.uuid), 'start the loop'));
  launch(script);
  if (complete) {
    script.emit(result());
    await waitUntil(() => first.sent.some((message) => message.kind === 'complete'));
  } else {
    await flush();
  }
  return { sessionId, cwd, script, first, firstRun, later: [] };
}

/** Runs a turn of the session the way the chat gateway runs the one a stop asks for. */
function runTurn(held: HeldRun, content: string, options: Record<string, unknown>) {
  const writer = createWriter();
  const later = createScriptedQuery();
  held.later.push(later);
  const run = queryClaudeSDK(content, { sessionId: held.sessionId, cwd: held.cwd, ...options }, writer.writer as never, { ...createContext(), createQuery: later.createQuery });
  return { writer, run, later };
}

async function finish(held: HeldRun, runs: Array<Promise<unknown>> = []): Promise<void> {
  held.script.end();
  for (const later of held.later) {
    later.script.end();
  }
  await held.firstRun;
  await Promise.all(runs);
  await rm(held.cwd, { recursive: true, force: true });
}

const scheduledIds = (sessionId: string) => claudeRuntime.listScheduledWork()
  .filter((entry) => entry.sessionId === sessionId)
  .flatMap((entry) => entry.scheduled.map((item) => item.id));

const TAIL = 'Make the calls yourself, not through an agent. Do nothing else, and reply in one short sentence.';
const STOP_WAKEUP = `End the dynamic /loop now: call ScheduleWakeup with stop: true. ${TAIL}`;

test('a dynamic loop alone is stopped by letting go of its process, with no turn and nothing reported', async () => {
  const held = await startRun((script) => armWakeup(script));
  try {
    assert.deepEqual(scheduledIds(held.sessionId), ['wakeup:toolu_wakeup_1']);
    assert.deepEqual(await claudeRuntime.stopScheduledWork(held.sessionId, 'wakeup:toolu_wakeup_1'), { status: 'stopped' });
    await flush();
    assert.equal(held.script.released(), true);
    assert.equal(held.script.prompts.length, 1, 'no turn was written to it');
    assert.deepEqual(scheduledIds(held.sessionId), []);
    assert.equal(held.first.finishedReports(), 0);
    assert.deepEqual(
      await claudeRuntime.stopScheduledWork(held.sessionId, 'wakeup:toolu_wakeup_1'),
      { status: 'not_found' },
      'a wake-up ends with its process',
    );
  } finally {
    await finish(held);
  }
});

test('a dynamic loop beside other work takes a turn that ends it with stop: true, and leaves the process held', async () => {
  const others: Array<[string, (script: Scripted) => void]> = [
    ['a task still running', launchWorkflow],
    ['a task still to be relayed', (script) => {
      launchWorkflow(script);
      script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    }],
    ['a cron job', (script) => createCronJob(script, 'b2148320')],
    ['a Monitor the CLI reported no task for', launchUntrackedMonitor],
  ];
  for (const [label, launch] of others) {
    const held = await startRun((script) => {
      armWakeup(script);
      launch(script);
    });
    try {
      assert.deepEqual(
        await claudeRuntime.stopScheduledWork(held.sessionId, 'wakeup:toolu_wakeup_1'),
        { status: 'turn', content: STOP_WAKEUP, options: { inheritUnset: true }, targetIds: ['wakeup:toolu_wakeup_1'] },
        label,
      );
      assert.equal(held.script.released(), false, label);
    } finally {
      await finish(held);
    }
  }
});

test('a cron job takes a turn that deletes it; the turn goes into the held process, and the job leaves the list with nothing reported', async () => {
  const held = await startRun((script) => createCronJob(script, 'b2148320'));
  const runs: Array<Promise<unknown>> = [];
  try {
    const stop = await claudeRuntime.stopScheduledWork(held.sessionId, 'cron:b2148320');
    assert.deepEqual(stop, {
      status: 'turn',
      content: `Cancel scheduled job b2148320 now: call CronDelete with id "b2148320". ${TAIL}`,
      options: { inheritUnset: true },
      targetIds: ['cron:b2148320'],
    });
    if (stop.status !== 'turn') {
      return;
    }
    assert.equal(held.script.released(), false, 'nothing is let go yet');
    const turn = runTurn(held, stop.content, stop.options);
    runs.push(turn.run);
    await waitUntil(() => held.script.prompts.length === 2);
    assert.equal(turn.later.script.created(), false, 'no second CLI is started');
    const uuid = String(held.script.prompts[1]?.uuid);
    held.script.emit(echo(uuid, stop.content));
    deleteCronJob(held.script, 'b2148320');
    held.script.emit(resultFor(uuid));
    await waitUntil(() => turn.writer.sent.some((message) => message.kind === 'complete'));
    await flush();
    assert.deepEqual(scheduledIds(held.sessionId), []);
    assert.equal(held.script.released(), true, 'nothing else held the process');
    assert.deepEqual([held.first.finishedReports(), turn.writer.finishedReports()], [0, 0]);
  } finally {
    await finish(held, runs);
  }
});

test('the stop prompt\'s echo goes on as a note where its turn starts, ahead of the CronDelete, while the echo of a prompt the user wrote is dropped', async () => {
  const held = await startRun((script) => createCronJob(script, 'b2148320'));
  const runs: Array<Promise<unknown>> = [];
  try {
    const stop = await claudeRuntime.stopScheduledWork(held.sessionId, 'cron:b2148320');
    assert.equal(stop.status, 'turn');
    if (stop.status !== 'turn') {
      return;
    }
    const turn = runTurn(held, stop.content, stop.options);
    runs.push(turn.run);
    await waitUntil(() => held.script.prompts.length === 2);
    const uuid = String(held.script.prompts[1]?.uuid);
    held.script.emit(echo(uuid, stop.content));
    deleteCronJob(held.script, 'b2148320');
    held.script.emit(resultFor(uuid));
    await waitUntil(() => turn.writer.sent.some((message) => message.kind === 'complete'));

    const rows = turn.writer.sent
      .filter((message) => message.kind === 'text' || message.kind === 'tool_use')
      .map((message) => ({ id: message.id, kind: message.kind, role: message.role, toolName: message.toolName, controlNote: message.controlNote }));
    assert.deepEqual(rows.slice(0, 2), [
      {
        id: uuid,
        kind: 'text',
        role: 'assistant',
        toolName: undefined,
        controlNote: { kind: 'scheduled-stop', count: 1, jobIds: ['b2148320'] },
      },
      { id: rows[1]?.id, kind: 'tool_use', role: undefined, toolName: 'CronDelete', controlNote: undefined },
    ]);
    assert.equal(turn.writer.sent.some((message) => message.role === 'user' && message.kind === 'text'), false, 'no user row for the stop');
    assert.equal(
      held.first.sent.some((message) => message.role === 'user' && message.kind === 'text'),
      false,
      'the echo of the run\'s own prompt is still dropped',
    );
  } finally {
    await finish(held, runs);
  }
});

test('a stop turn that starts a process of its own sends the note for its first prompt, where a prompt the user wrote is dropped', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-scheduled-stop-'));
  const content = buildScheduledStopMessage({ jobIds: ['b2148320', '7b7cd8fc'], wakeup: false });
  try {
    for (const [prompt, note] of [
      ['What changed?', false],
      [content, true],
    ] as const) {
      const { createQuery, script } = createScriptedQuery();
      const writer = createWriter();
      const sessionId = `app-scheduled-stop-new-${randomUUID()}`;
      const run = queryClaudeSDK(prompt, { sessionId, cwd }, writer.writer as never, { ...createContext(), createQuery });
      await waitUntil(() => script.prompts.length === 1);
      const uuid = String(script.prompts[0]?.uuid);
      script.emit(init());
      script.emit(echo(uuid, prompt));
      script.emit(resultFor(uuid));
      await waitUntil(() => writer.sent.some((message) => message.kind === 'complete'));
      script.end();
      await run;
      assert.deepEqual(
        writer.sent
          .filter((message) => message.kind === 'text')
          .map((message) => ({ id: message.id, role: message.role, controlNote: message.controlNote })),
        note
          ? [{ id: uuid, role: 'assistant', controlNote: { kind: 'scheduled-stop', count: 2, jobIds: ['b2148320', '7b7cd8fc'] } }]
          : [],
        prompt,
      );
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('stopping all of a session\'s scheduled work takes one turn for every piece that can be stopped', async () => {
  const held = await startRun((script) => {
    createCronJob(script, 'b2148320');
    createCronJob(script, '7b7cd8fc');
    createCronJob(script, null);
    armWakeup(script);
  });
  try {
    assert.deepEqual(scheduledIds(held.sessionId), ['cron:b2148320', 'cron:7b7cd8fc', 'cron:call:toolu_cron_old', 'wakeup:toolu_wakeup_1']);
    assert.deepEqual(await claudeRuntime.stopScheduledWork(held.sessionId, '7b7cd8fc'), { status: 'not_found' });
    assert.deepEqual(
      await claudeRuntime.stopScheduledWork(held.sessionId, 'cron:7b7cd8fc', { all: true }),
      {
        status: 'turn',
        content: `Stop these loops now: call CronDelete once for each id: "b2148320", "7b7cd8fc"; then call ScheduleWakeup with stop: true. ${TAIL}`,
        options: { inheritUnset: true },
        targetIds: ['cron:b2148320', 'cron:7b7cd8fc', 'wakeup:toolu_wakeup_1'],
      },
      'a job whose id the CLI did not report is no target',
    );
  } finally {
    await finish(held);
  }

  const jobs = await startRun((script) => {
    createCronJob(script, 'b2148320');
    createCronJob(script, '7b7cd8fc');
  });
  try {
    assert.deepEqual(
      await claudeRuntime.stopScheduledWork(jobs.sessionId, 'cron:b2148320', { all: true }),
      {
        status: 'turn',
        content: `Cancel these scheduled jobs now: call CronDelete once for each id: "b2148320", "7b7cd8fc". ${TAIL}`,
        options: { inheritUnset: true },
        targetIds: ['cron:b2148320', 'cron:7b7cd8fc'],
      },
    );
  } finally {
    await finish(jobs);
  }
});

/** A message of the nested agent the model started with the `toolu_agent` call. */
const nested = (message: Record<string, unknown>) => ({ ...message, parent_tool_use_id: 'toolu_agent' });

test('a stop turn whose model hands the calls to an agent still ends the work they cancel, and lets the process go', async () => {
  const held = await startRun((script) => {
    createCronJob(script, 'b2148320');
    armWakeup(script);
  });
  const runs: Array<Promise<unknown>> = [];
  try {
    const stop = await claudeRuntime.stopScheduledWork(held.sessionId, 'cron:b2148320', { all: true });
    assert.equal(stop.status, 'turn');
    if (stop.status !== 'turn') {
      return;
    }
    const turn = runTurn(held, stop.content, stop.options);
    runs.push(turn.run);
    await waitUntil(() => held.script.prompts.length === 2);
    const uuid = String(held.script.prompts[1]?.uuid);
    held.script.emit(echo(uuid, stop.content));
    // The model forks an agent in the foreground, and the agent makes the calls.
    held.script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'Stop all scheduled loops', subagent_type: 'fork' }));
    held.script.emit(taskStarted('a1', 'toolu_agent'));
    held.script.emit(nested(toolUse('toolu_nested_delete', 'CronDelete', { id: 'b2148320' })));
    held.script.emit(nested(toolResult('toolu_nested_delete', 'Cancelled job b2148320.')));
    held.script.emit(nested(toolUse('toolu_nested_stop', 'ScheduleWakeup', { stop: true })));
    held.script.emit(nested(toolResult('toolu_nested_stop', 'Loop stopped.')));
    await flush();
    assert.deepEqual(scheduledIds(held.sessionId), [], 'the CLI has cancelled both');
    held.script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    held.script.emit(toolResult('toolu_agent', 'Both loops are cancelled.'));
    held.script.emit(resultFor(uuid));
    await waitUntil(() => turn.writer.sent.some((message) => message.kind === 'complete'));
    await flush();
    assert.equal(held.script.released(), true, 'nothing else held the process');
    assert.deepEqual([held.first.finishedReports(), turn.writer.finishedReports()], [0, 0]);
  } finally {
    await finish(held, runs);
  }
});

test('work a nested agent sets up is not followed: only calls that end scheduled work count from an agent', async () => {
  const held = await startRun((script) => {
    createCronJob(script, 'b2148320');
    script.emit(nested(toolUse('toolu_nested_cron', 'CronCreate', { cron: '*/5 * * * *', prompt: 'check', recurring: true })));
    script.emit(nested(toolResult('toolu_nested_cron', 'Scheduled recurring job 7b7cd8fc.', {
      id: '7b7cd8fc', humanSchedule: 'Every 5 minutes', recurring: true, durable: false, nextFireAt: Date.now() + 5 * MINUTE,
    })));
    script.emit(nested(toolUse('toolu_nested_wakeup', 'ScheduleWakeup', { delaySeconds: 600, prompt: 'check', reason: 'polling' })));
    script.emit(nested(toolResult('toolu_nested_wakeup', 'Next wakeup scheduled.', {
      scheduledFor: Math.ceil((Date.now() + 10 * MINUTE) / MINUTE) * MINUTE, clampedDelaySeconds: 600, wasClamped: false,
    })));
  });
  try {
    assert.deepEqual(scheduledIds(held.sessionId), ['cron:b2148320']);
  } finally {
    await finish(held);
  }
});

test('a process in plan mode runs the stop turn in the default mode, permissions not skipped, and is switched back after it', async () => {
  const PLAN_STOP = { inheritUnset: true, permissionMode: 'default', restoreSwitchesAfterTurn: true, toolsSettings: { skipPermissions: false } };
  for (const skipPermissions of [false, true]) {
    const label = `skipPermissions ${skipPermissions}`;
    // Two jobs: the one left keeps the process held after the turn, which is
    // then switched back.
    const held = await startRun((script) => {
      createCronJob(script, 'b2148320');
      createCronJob(script, '7b7cd8fc');
    }, {
      permissionMode: 'plan',
      toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions },
    });
    const runs: Array<Promise<unknown>> = [];
    try {
      const stop = await claudeRuntime.stopScheduledWork(held.sessionId, 'cron:b2148320');
      assert.equal(stop.status, 'turn', label);
      if (stop.status !== 'turn') {
        continue;
      }
      assert.deepEqual(stop.options, PLAN_STOP, label);
      assert.deepEqual(
        await claudeRuntime.planHandOver(held.sessionId, { sessionId: held.sessionId, cwd: held.cwd, ...stop.options }, { inheritUnset: true }),
        { heldWork: true, canHandOver: true, changes: [], switches: ['permissionMode'] },
        label,
      );
      const turn = runTurn(held, stop.content, stop.options);
      runs.push(turn.run);
      await waitUntil(() => held.script.prompts.length === 2);
      assert.equal(turn.later.script.created(), false, label);
      const uuid = String(held.script.prompts[1]?.uuid);
      held.script.emit(echo(uuid, stop.content));
      deleteCronJob(held.script, 'b2148320');
      held.script.emit(resultFor(uuid));
      await waitUntil(() => held.script.calls.includes('setPermissionMode:plan'));
      assert.deepEqual(scheduledIds(held.sessionId), ['cron:7b7cd8fc'], label);
      assert.deepEqual(
        held.script.calls.filter((call) => !call.startsWith('prompt:') || call === `prompt:${uuid}`),
        ['setPermissionMode:default', `prompt:${uuid}`, 'setPermissionMode:plan'],
        `${label}: switched for the turn alone`,
      );
    } finally {
      await finish(held, runs);
    }
  }

  // Auto mode is left as it is: the stop turn's tools are ordinary ones.
  const auto = await startRun((script) => createCronJob(script, 'b2148320'), { permissionMode: 'auto' });
  try {
    const stop = await claudeRuntime.stopScheduledWork(auto.sessionId, 'cron:b2148320');
    assert.deepEqual(stop.status === 'turn' ? stop.options : null, { inheritUnset: true });
  } finally {
    await finish(auto);
  }
});

test('with no process holding the session, a cron job still takes a turn, in a new process; a wake-up has ended', async () => {
  const none = `app-scheduled-stop-none-${randomUUID()}`;
  assert.deepEqual(
    await claudeRuntime.stopScheduledWork(none, 'cron:b2148320', { all: true }),
    { status: 'turn', content: `Cancel scheduled job b2148320 now: call CronDelete with id "b2148320". ${TAIL}`, options: {}, targetIds: ['cron:b2148320'] },
  );
  assert.deepEqual(await claudeRuntime.stopScheduledWork(none, 'wakeup:toolu_wakeup_1'), { status: 'not_found' });
  for (const id of ['cron:call:toolu_cron_old', 'cron:B2148320', 'cron:b2148320x']) {
    assert.deepEqual(await claudeRuntime.stopScheduledWork(none, id), { status: 'not_found' }, id);
  }

  // A process that has let go of its input is as good as gone.
  const exiting = await startRun(() => {});
  try {
    assert.equal(exiting.script.released(), true);
    assert.deepEqual(
      await claudeRuntime.stopScheduledWork(exiting.sessionId, 'cron:b2148320'),
      { status: 'turn', content: `Cancel scheduled job b2148320 now: call CronDelete with id "b2148320". ${TAIL}`, options: {}, targetIds: ['cron:b2148320'] },
    );
  } finally {
    await finish(exiting);
  }
});

test('an id of any other shape, or one the live process does not hold, is not found, and nothing changes', async () => {
  const held = await startRun((script) => {
    createCronJob(script, 'b2148320');
    armWakeup(script);
  });
  try {
    for (const id of ['cron:call:toolu_cron_old', 'cron:B2148320', 'cron:b214832', 'wf1', '', 'wakeup:', 'wakeup:a b', 'cron:7b7cd8fc', 'wakeup:toolu_other']) {
      assert.deepEqual(await claudeRuntime.stopScheduledWork(held.sessionId, id), { status: 'not_found' }, id);
      assert.deepEqual(await claudeRuntime.stopScheduledWork(held.sessionId, id, { all: true }), { status: 'not_found' }, `${id}, all`);
    }
    assert.equal(held.script.released(), false);
    assert.deepEqual(scheduledIds(held.sessionId), ['cron:b2148320', 'wakeup:toolu_wakeup_1']);
  } finally {
    await finish(held);
  }
});

test('a process in a turn it has not handed over is busy', async () => {
  const firstTurn = await startRun((script) => {
    armWakeup(script);
    createCronJob(script, 'b2148320');
  }, {}, { complete: false });
  try {
    assert.deepEqual(scheduledIds(firstTurn.sessionId).sort(), ['cron:b2148320', 'wakeup:toolu_wakeup_1'], 'listed while the turn runs');
    assert.deepEqual(await claudeRuntime.stopScheduledWork(firstTurn.sessionId, 'wakeup:toolu_wakeup_1'), { status: 'busy' });
    assert.equal(firstTurn.script.released(), false);
  } finally {
    await finish(firstTurn);
  }

  const held = await startRun((script) => armWakeup(script));
  const runs: Array<Promise<unknown>> = [];
  try {
    const turn = runTurn(held, 'What changed?', {});
    runs.push(turn.run);
    await waitUntil(() => held.script.prompts.length === 2);
    assert.deepEqual(await claudeRuntime.stopScheduledWork(held.sessionId, 'wakeup:toolu_wakeup_1'), { status: 'busy' }, 'while a handed-over turn runs');
    const uuid = String(held.script.prompts[1]?.uuid);
    held.script.emit(echo(uuid, 'What changed?'));
    stopLoop(held.script);
    held.script.emit(resultFor(uuid));
    await waitUntil(() => turn.writer.sent.some((message) => message.kind === 'complete'));
  } finally {
    await finish(held, runs);
  }
});

test('the runtime service passes a stop to the Claude runtime', async () => {
  const held = await startRun((script) => armWakeup(script));
  const service = createProviderRuntimeService({ listProviders: () => [{ id: 'claude', runtime: claudeRuntime }] as never, resolveProvider: () => ({ id: 'claude', runtime: claudeRuntime }) as never });
  try {
    assert.equal(service.hasScheduledWork(held.sessionId), true);
    assert.deepEqual(await service.stopScheduledWork('claude', held.sessionId, 'wakeup:toolu_wakeup_1'), { status: 'stopped' });
    assert.equal(service.hasScheduledWork(held.sessionId), false);
  } finally {
    await finish(held);
  }
});
