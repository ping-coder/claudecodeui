import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  abortClaudeSDKSession,
  claudeRuntime,
  queryClaudeSDK,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * Mid-run inserts: a user message written into the CLI while a turn runs.
 * These drive `queryClaudeSDK` with a scripted SDK stream (the seam is
 * `context.createQuery`), read what the run writes to the CLI off the held
 * prompt stream, and answer `cancelAsyncMessage` the way the CLI would.
 */

type CancelAnswer = 'cancelled' | 'kept' | 'hang';

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  fail: (error: Error) => void;
  /** Every message the run wrote to the CLI's stdin, in order. */
  prompts: Array<Record<string, unknown>>;
  released: () => boolean;
  /** `cancel:<uuid>`, `interrupt`, `stop:<taskId>`, `release`, `close`, in order. */
  calls: string[];
  created: () => boolean;
  options: () => Record<string, unknown> | null;
  /** How the CLI answers the next cancel_async_message requests. */
  setCancelAnswer: (answer: CancelAnswer) => void;
  /**
   * What the CLI says while it handles the next cancel_async_message
   * requests: its answer comes once the run has read that.
   */
  setCancelHook: (hook: (uuid: string) => void) => void;
};

/**
 * `request` stands for an SDK whose query has no `cancelAsyncMessage`, only
 * the generic control request it is built on.
 */
type CancelMethod = 'cancelAsyncMessage' | 'request';

function createScriptedQuery(
  cancelMethod: CancelMethod = 'cancelAsyncMessage',
): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  const queue: Array<Record<string, unknown> | Error | null> = [];
  let wake: (() => void) | null = null;
  let released = false;
  let closed = false;
  let builtWith: Record<string, unknown> | null = null;
  let cancelAnswer: CancelAnswer = 'cancelled';
  let cancelHook: ((uuid: string) => void) | null = null;
  const prompts: Array<Record<string, unknown>> = [];
  const calls: string[] = [];

  const script: Scripted = {
    emit: (message) => { queue.push(message); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
    fail: (error) => { queue.push(error); wake?.(); },
    prompts,
    released: () => released,
    calls,
    created: () => builtWith !== null,
    options: () => builtWith,
    setCancelAnswer: (answer) => { cancelAnswer = answer; },
    setCancelHook: (hook) => { cancelHook = hook; },
  };

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt, options }) => {
    builtWith = options;
    void (async () => {
      for await (const message of prompt) {
        prompts.push(message as Record<string, unknown>);
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
        if (next instanceof Error) {
          throw next;
        }
        yield next;
      }
    })();

    const answerCancel = (uuid: string) => {
      calls.push(`cancel:${uuid}`);
      if (cancelHook) {
        cancelHook(uuid);
        if (cancelAnswer !== 'hang') {
          return flush().then(() => cancelAnswer === 'cancelled');
        }
      }
      if (cancelAnswer === 'hang') {
        return new Promise<boolean>(() => {});
      }
      return Promise.resolve(cancelAnswer === 'cancelled');
    };
    const cancelling = cancelMethod === 'cancelAsyncMessage'
      ? { cancelAsyncMessage: answerCancel }
      : {
        request: async (request: { subtype: string; message_uuid: string }) => {
          assert.equal(request.subtype, 'cancel_async_message');
          return { subtype: 'success', request_id: 'r1', response: { cancelled: await answerCancel(request.message_uuid) } };
        },
      };

    return Object.assign(iterator, cancelling, {
      interrupt: async () => { calls.push('interrupt'); },
      stopTask: async (taskId: string) => { calls.push(`stop:${taskId}`); },
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

// Gives up after five seconds of real time; works while `setTimeout` is mocked.
async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!condition() && performance.now() < deadline) {
    await flush(1);
  }
  assert.equal(condition(), true, 'condition never became true');
}

type RunContext = {
  sessionId: string;
  script: Scripted;
  sent: NormalizedMessage[];
  done: Promise<unknown>;
  finishedReports: () => number;
  /** The uuid the run's own prompt went out with. */
  promptUuid: () => string;
};

/** Runs one scripted run on a session of its own. */
async function withRun(runTest: (run: RunContext) => Promise<void>, cancelMethod?: CancelMethod): Promise<void> {
  const sessionId = `app-insert-${randomUUID()}`;
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-insert-'));
  const { createQuery, script } = createScriptedQuery(cancelMethod);
  const { writer, sent, finishedReports } = createWriter();

  try {
    const done = queryClaudeSDK('hello', { sessionId, cwd }, writer as never, { ...createContext(), createQuery });
    await waitUntil(() => script.prompts.length === 1);
    try {
      await runTest({ sessionId, script, sent, done, finishedReports, promptUuid: () => String(script.prompts[0].uuid) });
    } finally {
      script.end();
    }
    await done;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const NATIVE_ID = 'native-insert-session';
const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const echo = (uuid: string, content: string, extra: Record<string, unknown> = {}) => ({
  type: 'user', isReplay: true, uuid, session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'user', content }, ...extra,
});
const lifecycle = (commandUuid: string, state: string) => ({
  type: 'command_lifecycle', uuid: randomUUID(), session_id: NATIVE_ID, command_uuid: commandUuid, state,
});
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id: string, text: string) => ({
  type: 'user', uuid: randomUUID(), session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
});
const assistantText = (text: string) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'done', duration_ms: 1, num_turns: 1 });

/** The prompt's turn has begun, as the CLI reports it. */
function startPromptTurn(run: RunContext): void {
  run.script.emit(init());
  run.script.emit(lifecycle(run.promptUuid(), 'started'));
  run.script.emit(echo(run.promptUuid(), 'hello'));
}

const insertStatuses = (sent: NormalizedMessage[], insertId: string) => sent
  .filter((message) => message.kind === 'insert_status' && message.insertId === insertId)
  .map((message) => (message.insertReason ? `${message.insertStatus}:${message.insertReason}` : String(message.insertStatus)));
const userTexts = (sent: NormalizedMessage[]) => sent.filter((message) => message.kind === 'text' && message.role === 'user');
const completes = (sent: NormalizedMessage[]) => sent.filter((message) => message.kind === 'complete').length;
const writtenInserts = (script: Scripted) => script.prompts.slice(1).map((message) => message.uuid);

const NEXT_TURN_WAIT_MS = 30 * 1000;

test('the CLI is started with --replay-user-messages and the prompt carries a uuid', async () => {
  await withRun(async (run) => {
    const extraArgs = run.script.options()?.extraArgs as Record<string, unknown> | undefined;
    assert.equal(extraArgs?.['replay-user-messages'], null);
    assert.equal(Object.hasOwn(extraArgs ?? {}, 'replay-user-messages'), true);
    assert.match(run.promptUuid(), /^[0-9a-f-]{36}$/);
  });
});

test('an insert read mid-turn is written once, reported delivered once, and shows as an inserted message', async () => {
  await withRun(async (run) => {
    const { script, sent, sessionId } = run;
    startPromptTurn(run);
    script.emit(toolUse('toolu_sleep', 'Bash', { command: 'sleep 12' }));
    await flush();

    const insertId = randomUUID();
    assert.deepEqual(await claudeRuntime.insert(sessionId, { insertId, content: 'Also say INSERTED' }), { accepted: true });
    await flush();
    assert.equal(script.prompts.length, 2);
    const written = script.prompts[1];
    assert.equal(written.type, 'user');
    assert.equal(written.uuid, insertId);
    assert.equal(written.priority, 'next');
    assert.deepEqual(written.origin, { kind: 'human' });
    assert.deepEqual(written.message, { role: 'user', content: 'Also say INSERTED' });
    const pending = sent.find((message) => message.kind === 'insert_status' && message.insertId === insertId);
    assert.equal(pending?.insertStatus, 'pending');
    assert.equal(pending?.content, 'Also say INSERTED', 'other tabs draw the card from the status');

    // The tool batch ends; the CLI echoes the insert, then reports it started.
    script.emit(lifecycle(insertId, 'queued'));
    script.emit(toolResult('toolu_sleep', ''));
    script.emit(echo(insertId, 'Also say INSERTED', { origin: { kind: 'human' } }));
    script.emit(lifecycle(insertId, 'started'));
    await flush();
    assert.deepEqual(insertStatuses(sent, insertId), ['pending', 'delivered']);
    const bubbles = userTexts(sent);
    assert.equal(bubbles.length, 1, 'one message for the insert, none for the prompt echo or the insert echo');
    assert.equal(bubbles[0].id, insertId);
    assert.equal(bubbles[0].inserted, true);
    assert.equal(bubbles[0].content, 'Also say INSERTED');
    assert.equal(bubbles[0].transcriptAnchorId, undefined, 'an attachment row is no edit or fork anchor');

    script.emit(assistantText('FIRST INSERTED'));
    script.emit(lifecycle(insertId, 'completed'));
    script.emit(result());
    script.emit(lifecycle(run.promptUuid(), 'completed'));
    await flush();
    assert.equal(completes(sent), 1);
    assert.equal(script.released(), true);
  });
});

test('nothing is written before the prompt\'s own turn has started', async () => {
  await withRun(async (run) => {
    const { script, sessionId } = run;
    script.emit(init());
    await flush();
    const insertId = randomUUID();
    assert.deepEqual(await claudeRuntime.insert(sessionId, { insertId, content: 'early' }), { accepted: true });
    await flush();
    assert.deepEqual(writtenInserts(script), [], 'the CLI would run it together with the prompt');

    script.emit(lifecycle(run.promptUuid(), 'started'));
    await flush();
    assert.deepEqual(writtenInserts(script), [insertId]);
  });
});

test('inserts are written one at a time, the next once the CLI has read the one before', async () => {
  await withRun(async (run) => {
    const { script, sent, sessionId } = run;
    startPromptTurn(run);
    await flush();
    const first = randomUUID();
    const second = randomUUID();
    await claudeRuntime.insert(sessionId, { insertId: first, content: 'one' });
    await claudeRuntime.insert(sessionId, { insertId: second, content: 'two' });
    await flush();
    assert.deepEqual(writtenInserts(script), [first]);
    assert.deepEqual(insertStatuses(sent, second), ['pending']);

    script.emit(echo(first, 'one'));
    await flush();
    assert.deepEqual(writtenInserts(script), [first, second]);
    script.emit(lifecycle(second, 'started'));
    await flush();
    assert.deepEqual(insertStatuses(sent, first), ['pending', 'delivered']);
    assert.deepEqual(insertStatuses(sent, second), ['pending', 'delivered']);
    assert.deepEqual(userTexts(sent).map((message) => message.id), [first, second]);
  });
});

test('an insert the turn ends before reading runs as the next turn, and the run still completes once', async () => {
  await withRun(async (run) => {
    const { script, sent, sessionId, finishedReports } = run;
    startPromptTurn(run);
    await flush();
    const insertId = randomUUID();
    await claudeRuntime.insert(sessionId, { insertId, content: 'and then this' });
    await flush();

    script.emit(assistantText('Done.'));
    script.emit(result());
    await flush();
    assert.equal(completes(sent), 0, 'the turn goes on with the insert');
    assert.equal(script.released(), false);

    script.emit(lifecycle(insertId, 'started'));
    script.emit(init());
    script.emit(echo(insertId, 'and then this'));
    await flush();
    assert.deepEqual(insertStatuses(sent, insertId), ['pending', 'next_turn']);
    const bubbles = userTexts(sent);
    assert.equal(bubbles.length, 1);
    assert.equal(bubbles[0].id, insertId);
    assert.equal(bubbles[0].transcriptAnchorId, insertId, 'the next turn\'s prompt row can be edited and forked from');
    assert.equal(bubbles[0].inserted, undefined);

    script.emit(assistantText('Then this.'));
    script.emit(result());
    await flush();
    assert.equal(completes(sent), 1);
    assert.equal(script.released(), true);
    assert.equal(finishedReports(), 0);
  });
});

test('an insert with no receipt by the time the next turn should start is reported lost, and the turn completes', async (t) => {
  await withRun(async (run) => {
    const { script, sent, sessionId } = run;
    startPromptTurn(run);
    await flush();
    const insertId = randomUUID();
    await claudeRuntime.insert(sessionId, { insertId, content: 'lost' });
    await flush();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    script.emit(result());
    await flush();

    t.mock.timers.tick(NEXT_TURN_WAIT_MS - 1);
    await flush();
    assert.equal(completes(sent), 0);
    t.mock.timers.tick(1);
    await flush();
    assert.deepEqual(insertStatuses(sent, insertId), ['pending', 'failed:LOST']);
    assert.equal(script.calls.includes(`cancel:${insertId}`), true, 'the CLI is asked to drop it in case it still holds it');
    assert.equal(completes(sent), 1);
    assert.equal(script.released(), true);
  });
});

test('anything the CLI says restarts the wait for the next turn', async (t) => {
  await withRun(async (run) => {
    const { script, sent, sessionId } = run;
    startPromptTurn(run);
    await flush();
    const insertId = randomUUID();
    await claudeRuntime.insert(sessionId, { insertId, content: 'slow' });
    await flush();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    script.emit(result());
    await flush();

    t.mock.timers.tick(NEXT_TURN_WAIT_MS - 1000);
    script.emit({ type: 'system', subtype: 'status', session_id: NATIVE_ID, status: 'requesting' });
    await flush();
    t.mock.timers.tick(NEXT_TURN_WAIT_MS - 1000);
    await flush();
    assert.equal(completes(sent), 0);
    assert.deepEqual(insertStatuses(sent, insertId), ['pending']);

    t.mock.timers.tick(1000);
    await flush();
    assert.deepEqual(insertStatuses(sent, insertId), ['pending', 'failed:LOST']);
    assert.equal(completes(sent), 1);
  });
});

test('an insert still waiting for the prompt\'s turn to show is written once that turn ends', async () => {
  await withRun(async (run) => {
    const { script, sent, sessionId } = run;
    // A CLI that sends neither the prompt's echo nor its lifecycle.
    script.emit(init());
    await flush();
    const insertId = randomUUID();
    await claudeRuntime.insert(sessionId, { insertId, content: 'after all' });
    await flush();
    assert.deepEqual(writtenInserts(script), []);

    script.emit(result());
    await flush();
    assert.deepEqual(writtenInserts(script), [insertId], 'it runs as the next turn');
    assert.equal(completes(sent), 0);
    script.emit(echo(insertId, 'after all'));
    script.emit(result());
    await flush();
    assert.deepEqual(insertStatuses(sent, insertId), ['pending', 'next_turn']);
    assert.equal(completes(sent), 1);
  });
});

test('a waiting insert is withdrawn without asking the CLI; a written one through cancel_async_message', async () => {
  await withRun(async (run) => {
    const { script, sent, sessionId } = run;
    startPromptTurn(run);
    await flush();
    const first = randomUUID();
    const second = randomUUID();
    await claudeRuntime.insert(sessionId, { insertId: first, content: 'one' });
    await claudeRuntime.insert(sessionId, { insertId: second, content: 'two' });
    await flush();

    assert.deepEqual(await claudeRuntime.cancelInsert(sessionId, second), { status: 'cancelled' });
    assert.deepEqual(insertStatuses(sent, second), ['pending', 'cancelled']);
    assert.equal(script.calls.includes(`cancel:${second}`), false);

    const third = randomUUID();
    await claudeRuntime.insert(sessionId, { insertId: third, content: 'three' });
    assert.deepEqual(await claudeRuntime.cancelInsert(sessionId, first), { status: 'cancelled' });
    await flush();
    assert.deepEqual(script.calls.filter((call) => call.startsWith('cancel:')), [`cancel:${first}`]);
    assert.deepEqual(insertStatuses(sent, first), ['pending', 'cancelled']);
    assert.deepEqual(writtenInserts(script), [first, third], 'the next insert goes out once the CLI has dropped the first');

    assert.deepEqual(await claudeRuntime.cancelInsert(sessionId, first), { status: 'not_found' }, 'it has ended');
    assert.deepEqual(await claudeRuntime.cancelInsert(sessionId, randomUUID()), { status: 'not_found' });
  });
});

test('an insert the CLI will not give back keeps going and still reports how it ends', async () => {
  await withRun(async (run) => {
    const { script, sent, sessionId } = run;
    startPromptTurn(run);
    await flush();
    const insertId = randomUUID();
    await claudeRuntime.insert(sessionId, { insertId, content: 'too late' });
    await flush();

    script.setCancelAnswer('kept');
    assert.deepEqual(await claudeRuntime.cancelInsert(sessionId, insertId), { status: 'cancel_failed' });
    assert.deepEqual(insertStatuses(sent, insertId), ['pending'], 'nothing is reported for a failed withdrawal');

    script.emit(echo(insertId, 'too late'));
    await flush();
    assert.deepEqual(insertStatuses(sent, insertId), ['pending', 'delivered']);
  });
});

test('withdrawing the insert a held-back turn waits for completes the turn', async () => {
  await withRun(async (run) => {
    const { script, sent, sessionId } = run;
    startPromptTurn(run);
    await flush();
    const insertId = randomUUID();
    await claudeRuntime.insert(sessionId, { insertId, content: 'never mind' });
    await flush();
    script.emit(result());
    await flush();
    assert.equal(completes(sent), 0);

    assert.deepEqual(await claudeRuntime.cancelInsert(sessionId, insertId), { status: 'cancelled' });
    await flush();
    assert.equal(completes(sent), 1);
    assert.equal(script.released(), true);
  });
});

test('an insert the CLI refuses fails, and a turn held back for it completes', async () => {
  await withRun(async (run) => {
    const { script, sent, sessionId } = run;
    startPromptTurn(run);
    await flush();
    const insertId = randomUUID();
    await claudeRuntime.insert(sessionId, { insertId, content: 'blocked' });
    await flush();
    script.emit(result());
    script.emit(lifecycle(insertId, 'refused'));
    await flush();
    assert.deepEqual(insertStatuses(sent, insertId), ['pending', 'failed:CLI_REFUSED']);
    assert.equal(completes(sent), 1);
  });
});

test('an abort withdraws the pending inserts before it interrupts, and reports them cancelled', async () => {
  await withRun(async (run) => {
    const { script, sent, sessionId } = run;
    startPromptTurn(run);
    await flush();
    const first = randomUUID();
    const second = randomUUID();
    await claudeRuntime.insert(sessionId, { insertId: first, content: 'one' });
    await claudeRuntime.insert(sessionId, { insertId: second, content: 'two' });
    await flush();

    assert.equal(await abortClaudeSDKSession(sessionId), true);
    await flush();
    assert.deepEqual(script.calls, [`cancel:${first}`, 'interrupt', 'release']);
    assert.deepEqual(insertStatuses(sent, first), ['pending', 'cancelled:ABORTED']);
    assert.deepEqual(insertStatuses(sent, second), ['pending', 'cancelled:ABORTED']);
    assert.deepEqual(writtenInserts(script), [first]);
    assert.equal(completes(sent), 0, 'the abort\'s caller sends the terminal complete');
  });
});

test('an abort reports an insert cancelled even when the CLI does not answer the withdrawal', async (t) => {
  await withRun(async (run) => {
    const { script, sent, sessionId } = run;
    startPromptTurn(run);
    await flush();
    const insertId = randomUUID();
    await claudeRuntime.insert(sessionId, { insertId, content: 'unsure' });
    await flush();
    script.setCancelAnswer('hang');
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const aborting = abortClaudeSDKSession(sessionId);
    await flush();
    assert.deepEqual(script.calls, [`cancel:${insertId}`], 'the interrupt waits for the withdrawal');
    assert.deepEqual(
      await claudeRuntime.insert(sessionId, { insertId: randomUUID(), content: 'late' }),
      { accepted: false, reason: 'NO_ACTIVE_RUN' },
      'a run being aborted takes no insert',
    );
    t.mock.timers.tick(1000);
    assert.equal(await aborting, true);
    await flush();
    assert.deepEqual(script.calls, [`cancel:${insertId}`, 'interrupt', 'release']);
    assert.deepEqual(insertStatuses(sent, insertId), ['pending', 'cancelled:ABORTED']);
  });
});

test('an insert the CLI drops while an abort waits is reported as the abort\'s', async (t) => {
  await withRun(async (run) => {
    const { script, sent, sessionId } = run;
    startPromptTurn(run);
    await flush();
    const insertId = randomUUID();
    await claudeRuntime.insert(sessionId, { insertId, content: 'dropped' });
    await flush();
    script.setCancelAnswer('hang');
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const aborting = abortClaudeSDKSession(sessionId);
    await flush();
    script.emit(lifecycle(insertId, 'cancelled'));
    await flush();
    t.mock.timers.tick(1000);
    assert.equal(await aborting, true);
    assert.deepEqual(insertStatuses(sent, insertId), ['pending', 'cancelled:ABORTED']);
  });
});

test('an insert that starts the next turn as the user stops the run is the abort\'s, not delivered', async () => {
  await withRun(async (run) => {
    const { script, sent, sessionId } = run;
    startPromptTurn(run);
    await flush();
    const insertId = randomUUID();
    await claudeRuntime.insert(sessionId, { insertId, content: 'and then this' });
    await flush();
    script.emit(assistantText('Done.'));
    script.emit(result());
    await flush();
    assert.equal(completes(sent), 0, 'the result waits for the insert');

    // The CLI starts the insert as the next turn while it handles the withdrawal.
    script.setCancelAnswer('kept');
    script.setCancelHook((uuid) => { script.emit(lifecycle(uuid, 'started')); });
    assert.equal(await abortClaudeSDKSession(sessionId), true);
    await flush();
    assert.deepEqual(insertStatuses(sent, insertId), ['pending', 'cancelled:ABORTED'], 'the abort interrupts the turn it started, so the text goes back');
    assert.deepEqual(userTexts(sent), [], 'no message for it');
    assert.deepEqual(script.calls, [`cancel:${insertId}`, 'interrupt', 'release']);
  });
});

test('an insert that starts the next turn after a result the abort let through is the abort\'s too', async () => {
  await withRun(async (run) => {
    const { script, sent, sessionId } = run;
    startPromptTurn(run);
    await flush();
    const insertId = randomUUID();
    await claudeRuntime.insert(sessionId, { insertId, content: 'and then this' });
    await flush();
    script.emit(assistantText('Almost done.'));
    await flush();

    // The turn ends, and the insert starts the next one, before the CLI reads the withdrawal.
    script.setCancelAnswer('kept');
    script.setCancelHook((uuid) => {
      script.emit(result());
      script.emit(lifecycle(uuid, 'started'));
    });
    assert.equal(await abortClaudeSDKSession(sessionId), true);
    await flush();
    assert.deepEqual(insertStatuses(sent, insertId), ['pending', 'cancelled:ABORTED']);
    assert.deepEqual(userTexts(sent), []);
    assert.equal(completes(sent), 0, 'the abort\'s caller sends the terminal complete');
  });
});

test('an insert the CLI reads mid-turn as the user stops the run is still delivered', async () => {
  await withRun(async (run) => {
    const { script, sent, sessionId } = run;
    startPromptTurn(run);
    script.emit(toolUse('toolu_sleep', 'Bash', { command: 'sleep 12' }));
    await flush();
    const insertId = randomUUID();
    await claudeRuntime.insert(sessionId, { insertId, content: 'also this' });
    await flush();

    // The tool batch ends and the CLI reads the insert into the turn before the withdrawal.
    script.setCancelAnswer('kept');
    script.setCancelHook((uuid) => {
      script.emit(toolResult('toolu_sleep', ''));
      script.emit(echo(uuid, 'also this', { origin: { kind: 'human' } }));
      script.emit(lifecycle(uuid, 'started'));
    });
    assert.equal(await abortClaudeSDKSession(sessionId), true);
    await flush();
    assert.deepEqual(insertStatuses(sent, insertId), ['pending', 'delivered'], 'the transcript keeps it as an attachment of the turn');
    const bubbles = userTexts(sent);
    assert.equal(bubbles.length === 1 && bubbles[0].id === insertId && bubbles[0].inserted === true, true);
  });
});

test('an insert is refused when no turn can take it', async () => {
  await withRun(async (run) => {
    const { script, sessionId } = run;
    assert.deepEqual(await claudeRuntime.insert(sessionId, { insertId: 'not-a-uuid', content: 'x' }), { accepted: false, reason: 'INVALID' });
    assert.deepEqual(await claudeRuntime.insert(sessionId, { insertId: randomUUID(), content: '   ' }), { accepted: false, reason: 'INVALID' });
    assert.deepEqual(await claudeRuntime.insert(`app-insert-${randomUUID()}`, { insertId: randomUUID(), content: 'x' }), { accepted: false, reason: 'NO_ACTIVE_RUN' });
    assert.deepEqual(await claudeRuntime.insert(sessionId, { insertId: run.promptUuid(), content: 'x' }), { accepted: false, reason: 'DUPLICATE' });

    startPromptTurn(run);
    const insertId = randomUUID();
    assert.deepEqual(await claudeRuntime.insert(sessionId, { insertId, content: 'x' }), { accepted: true });
    assert.deepEqual(await claudeRuntime.insert(sessionId, { insertId, content: 'x' }), { accepted: false, reason: 'DUPLICATE' });
    script.emit(echo(insertId, 'x'));
    script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
    script.emit(toolResult('toolu_monitor', 'Monitor started'));
    script.emit(result());
    await flush();
    assert.equal(script.released(), false, 'the process is held for the Monitor');
    // The turn has completed; only background work is left.
    assert.deepEqual(await claudeRuntime.insert(sessionId, { insertId: randomUUID(), content: 'x' }), { accepted: false, reason: 'NO_ACTIVE_RUN' });
  });
});

test('an insert is refused while the run waits to start its CLI', async () => {
  const sessionId = `app-insert-${randomUUID()}`;
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-insert-'));
  const { createQuery, script } = createScriptedQuery();
  const { writer } = createWriter();
  let startModelLookup: () => void = () => {};
  const modelLookup = new Promise<undefined>((resolve) => { startModelLookup = () => resolve(undefined); });
  const context = { ...createContext(), resolveResumeModel: () => modelLookup, createQuery };

  try {
    const done = queryClaudeSDK('hello', { sessionId, cwd }, writer as never, context);
    await flush();
    assert.deepEqual(await claudeRuntime.insert(sessionId, { insertId: randomUUID(), content: 'x' }), { accepted: false, reason: 'NO_ACTIVE_RUN' });
    startModelLookup();
    await waitUntil(() => script.created());
    script.end();
    await done;
  } finally {
    script.end();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('pending inserts fail when the process exits, ahead of the run\'s complete', async () => {
  await withRun(async (run) => {
    const { script, sent, sessionId, done } = run;
    startPromptTurn(run);
    await flush();
    const insertId = randomUUID();
    await claudeRuntime.insert(sessionId, { insertId, content: 'orphaned' });
    await flush();
    script.end();
    await done;
    assert.deepEqual(insertStatuses(sent, insertId), ['pending', 'failed:RUN_ENDED']);
    const statusIndex = sent.findIndex((message) => message.kind === 'insert_status' && message.insertStatus === 'failed');
    const completeIndex = sent.findIndex((message) => message.kind === 'complete');
    assert.equal(statusIndex !== -1 && completeIndex > statusIndex, true);
  });
});

test('pending inserts fail when the stream throws, ahead of the error', async () => {
  await withRun(async (run) => {
    const { script, sent, sessionId, done } = run;
    startPromptTurn(run);
    await flush();
    const insertId = randomUUID();
    await claudeRuntime.insert(sessionId, { insertId, content: 'doomed' });
    await flush();
    script.fail(new Error('boom'));
    await done;
    assert.deepEqual(insertStatuses(sent, insertId), ['pending', 'failed:RUN_FAILED']);
    const statusIndex = sent.findIndex((message) => message.kind === 'insert_status' && message.insertStatus === 'failed');
    const errorIndex = sent.findIndex((message) => message.kind === 'error');
    assert.equal(statusIndex !== -1 && errorIndex > statusIndex, true);
  });
});

test('pending inserts fail when a newer run takes the session over', async () => {
  const sessionId = `app-insert-${randomUUID()}`;
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-insert-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const old = createWriter();
  const next = createWriter();

  try {
    const firstRun = queryClaudeSDK('hello', { sessionId, cwd }, old.writer as never, { ...createContext(), createQuery: first.createQuery });
    await waitUntil(() => first.script.prompts.length === 1);
    first.script.emit(init());
    first.script.emit(lifecycle(String(first.script.prompts[0].uuid), 'started'));
    await flush();
    const insertId = randomUUID();
    await claudeRuntime.insert(sessionId, { insertId, content: 'superseded' });
    await flush();

    const secondRun = queryClaudeSDK('next', { sessionId, cwd }, next.writer as never, { ...createContext(), createQuery: second.createQuery });
    await flush();
    assert.deepEqual(insertStatuses(old.sent, insertId), ['pending', 'failed:SUPERSEDED']);

    first.script.end();
    await firstRun;
    await waitUntil(() => second.script.created());
    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
  } finally {
    first.script.end();
    second.script.end();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('echoes of what the run wrote are dropped; local command output still shows', async () => {
  await withRun(async (run) => {
    const { script, sent } = run;
    startPromptTurn(run);
    // A task notification the CLI fed itself, by origin and by content.
    script.emit(echo(randomUUID(), '<task-notification>\n<task-id>a1</task-id>\n</task-notification>', { origin: { kind: 'task-notification' } }));
    script.emit(echo(randomUUID(), '<task-notification>\n<task-id>a2</task-id>\n</task-notification>'));
    script.emit(echo(randomUUID(), '<local-command-stdout>Total cost: $0.01</local-command-stdout>'));
    await flush();

    assert.deepEqual(userTexts(sent), [], 'neither the prompt nor a notification shows as a user message');
    const stdout = sent.filter((message) => message.kind === 'text' && message.isLocalCommandStdout === true);
    assert.deepEqual(stdout.map((message) => message.content), ['Total cost: $0.01']);
  });
});

test('background work a held-back turn started still holds the process once the insert\'s turn ends', async () => {
  await withRun(async (run) => {
    const { script, sent, sessionId } = run;
    startPromptTurn(run);
    script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
    script.emit(toolResult('toolu_monitor', 'Monitor started'));
    await flush();
    const insertId = randomUUID();
    await claudeRuntime.insert(sessionId, { insertId, content: 'next' });
    await flush();
    script.emit(result());
    script.emit(lifecycle(insertId, 'started'));
    script.emit(assistantText('Okay.'));
    script.emit(result());
    await flush();

    assert.equal(completes(sent), 1);
    assert.equal(script.released(), false, 'the Monitor from the first turn keeps the process held');
  });
});

test('an abort whose turn ends while it withdraws the inserts closes the process instead of interrupting it', async (t) => {
  await withRun(async (run) => {
    const { script, sessionId } = run;
    startPromptTurn(run);
    await flush();
    const insertId = randomUUID();
    await claudeRuntime.insert(sessionId, { insertId, content: 'x' });
    await flush();
    script.setCancelAnswer('hang');
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const aborting = abortClaudeSDKSession(sessionId);
    await flush();
    script.emit(result());
    await flush();
    assert.equal(script.released(), true, 'the turn ended and let go of the input');
    t.mock.timers.tick(1000);
    assert.equal(await aborting, true);
    await flush();
    assert.deepEqual(script.calls, [`cancel:${insertId}`, 'release', 'close'], 'an interrupt written now would be dropped');
  });
});

test('a task-notification turn that reads the insert ends the turn held back for it', async () => {
  await withRun(async (run) => {
    const { script, sent, sessionId } = run;
    startPromptTurn(run);
    await flush();
    const insertId = randomUUID();
    await claudeRuntime.insert(sessionId, { insertId, content: 'x' });
    await flush();
    script.emit(result());
    await flush();
    assert.equal(completes(sent), 0);

    // The CLI runs a turn for a background task's notification first and
    // reads the insert in it; that turn's result names the notification.
    script.emit(init());
    script.emit(echo(randomUUID(), '<task-notification>\n<task-id>a1</task-id>\n</task-notification>', { origin: { kind: 'task-notification' } }));
    script.emit(toolUse('toolu_read', 'Read', { file_path: '/repo/a.ts' }));
    script.emit(toolResult('toolu_read', 'contents'));
    script.emit(echo(insertId, 'x', { origin: { kind: 'human' } }));
    script.emit(assistantText('Both handled.'));
    script.emit({ ...result(), origin: { kind: 'task-notification' } });
    await flush();
    assert.equal(completes(sent), 1);
    assert.equal(script.released(), true);
  });
});

test('an SDK without cancelAsyncMessage gets the cancel_async_message control request', async () => {
  await withRun(async (run) => {
    const { script, sent, sessionId } = run;
    startPromptTurn(run);
    await flush();
    const insertId = randomUUID();
    await claudeRuntime.insert(sessionId, { insertId, content: 'x' });
    await flush();

    assert.deepEqual(await claudeRuntime.cancelInsert(sessionId, insertId), { status: 'cancelled' });
    assert.deepEqual(script.calls, [`cancel:${insertId}`]);
    assert.deepEqual(insertStatuses(sent, insertId), ['pending', 'cancelled']);
  }, 'request');
});
