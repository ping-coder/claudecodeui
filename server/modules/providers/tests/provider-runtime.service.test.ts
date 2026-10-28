import assert from 'node:assert/strict';
import test from 'node:test';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { createProviderRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import type { IProvider, IProviderRuntime } from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';

function createRuntime(overrides: Partial<IProviderRuntime> = {}): IProviderRuntime {
  return {
    async run() {
      return undefined;
    },
    abort() {
      return false;
    },
    ...overrides,
  };
}

function createProvider(id: LLMProvider, runtime: IProviderRuntime): IProvider {
  return {
    id,
    runtime,
    auth: {
      async getStatus() {
        return {
          provider: id,
          installed: true,
          authenticated: true,
          method: 'test',
          details: {},
        };
      },
    },
    sessions: {
      normalizeMessage(raw: unknown, sessionId: string | null) {
        return [{ kind: 'assistant', content: String(raw), sessionId, provider: id }];
      },
      async fetchHistory() {
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      },
    },
  } as unknown as IProvider;
}

function createService(
  providers: IProvider[],
  sessions: Record<string, { provider: string; project_path: string | null }> = {},
) {
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  return createProviderRuntimeService({
    getSession: (sessionId) => sessions[sessionId] ?? null,
    listProviders: () => providers,
    resolveProvider(providerName) {
      const provider = providerMap.get(providerName as LLMProvider);
      if (!provider) {
        throw new Error(`Missing provider: ${providerName}`);
      }
      return provider;
    },
    resolveProviderSessionId: (sessionId) => sessionId ? `native-${sessionId}` : null,
    async resolveResumeModel(_provider, _sessionId, requestedModel) {
      return requestedModel?.trim() || undefined;
    },
    async getProviderModels() {
      return {
        OPTIONS: [],
        DEFAULT: 'default-model',
      };
    },
  });
}

test('providerRegistry owns one runtime for every registered provider', () => {
  const providers = providerRegistry.listProviders();

  assert.deepEqual(providers.map((provider) => provider.id), [
    'claude',
    'codex',
    'cursor',
    'opencode',
    'agy',
  ]);
  assert.equal(providers.every((provider) => typeof provider.runtime.run === 'function'), true);
  assert.equal(providers.every((provider) => typeof provider.runtime.abort === 'function'), true);
});

test('dispatches runs and aborts through the runtime owned by providerRegistry', async () => {
  const calls: unknown[][] = [];
  const runtime = createRuntime({
    async run(command, options, writer, context) {
      calls.push(['run', command, options, writer]);
      assert.equal(context.resolveProviderSessionId('session-1'), 'native-session-1');
      assert.equal(await context.resolveResumeModel('session-1', 'sonnet'), 'sonnet');
      assert.deepEqual(await context.getProviderModels(), { OPTIONS: [], DEFAULT: 'default-model' });
      assert.equal(context.normalizeMessage('hello', 'session-1')[0]?.provider, 'claude');
      assert.equal(await context.isProviderInstalled(), true);
      return 'complete';
    },
    async abort(sessionId) {
      calls.push(['abort', sessionId]);
      return true;
    },
  });
  const service = createService([createProvider('claude', runtime)]);
  const writer = { send() {} };

  assert.equal(service.hasRuntime('claude'), true);
  assert.equal(service.hasRuntime('unknown'), false);
  assert.equal(await service.getRunner('claude')('hello', { model: 'sonnet' }, writer), 'complete');
  assert.equal(await service.abort('claude', 'session-1'), true);
  assert.deepEqual(calls, [
    ['run', 'hello', { model: 'sonnet' }, writer],
    ['abort', 'session-1'],
  ]);
});

test('routes permission decisions through provider-owned runtime capabilities', () => {
  const decisions: unknown[][] = [];
  const claudeRuntime = createRuntime({
    permissions: {
      resolve(requestId, decision) {
        decisions.push([requestId, decision]);
      },
      listPending(sessionId) {
        return [{ requestId: 'request-1', sessionId }];
      },
    },
  });
  const service = createService([
    createProvider('claude', claudeRuntime),
    createProvider('cursor', createRuntime()),
  ]);
  const decision = { allow: true, message: 'approved' };

  service.resolveToolApproval('request-1', decision);

  assert.deepEqual(decisions, [['request-1', decision]]);
  assert.deepEqual(service.getPendingApprovalsForSession('session-1'), [
    { requestId: 'request-1', sessionId: 'session-1' },
  ]);
});

test('inserts and withdrawals reach the named provider\'s runtime', async () => {
  const calls: unknown[][] = [];
  const claudeRuntime = createRuntime({
    async insert(sessionId, input) {
      calls.push(['insert', sessionId, input]);
      return { accepted: false, reason: 'DUPLICATE' };
    },
    async cancelInsert(sessionId, insertId) {
      calls.push(['cancelInsert', sessionId, insertId]);
      return { status: 'cancel_failed' };
    },
  });
  const service = createService([
    createProvider('claude', claudeRuntime),
    createProvider('cursor', createRuntime()),
  ]);
  const input = { insertId: 'insert-1', content: 'also check the logs' };

  // The runtime's own answers come back unchanged.
  assert.deepEqual(await service.insert('claude', 'session-1', input), { accepted: false, reason: 'DUPLICATE' });
  assert.deepEqual(await service.cancelInsert('claude', 'session-1', 'insert-1'), { status: 'cancel_failed' });
  assert.deepEqual(calls, [
    ['insert', 'session-1', input],
    ['cancelInsert', 'session-1', 'insert-1'],
  ]);
});

test('a runtime without inserts is answered UNSUPPORTED', async () => {
  const service = createService([createProvider('cursor', createRuntime())]);

  assert.deepEqual(
    await service.insert('cursor', 'session-1', { insertId: 'insert-1', content: 'hello' }),
    { accepted: false, reason: 'UNSUPPORTED' },
  );
  assert.deepEqual(await service.cancelInsert('cursor', 'session-1', 'insert-1'), { status: 'unsupported' });
});

test('describeSessionHold merges every runtime: a running process wins over an exiting one, and all tasks are listed', () => {
  const task = (taskId: string) => ({ taskId, toolUseId: `toolu_${taskId}`, taskType: 'local_bash', description: taskId, startedAt: 1 });
  const service = createService([
    createProvider('claude', createRuntime({
      processState: (sessionId) => (sessionId === 'session-1' ? 'exiting' : null),
      listBackgroundWork: () => [{ sessionId: 'session-1', tasks: [task('a')] }, { sessionId: 'session-2', tasks: [task('other')] }],
    })),
    createProvider('codex', createRuntime({
      processState: (sessionId) => (sessionId === 'session-1' ? 'running' : null),
    })),
    // Listed after the running one: still outweighed by it.
    createProvider('opencode', createRuntime({
      processState: (sessionId) => (sessionId === 'session-1' ? 'exiting' : null),
    })),
    createProvider('cursor', createRuntime()),
  ]);

  assert.deepEqual(service.describeSessionHold('session-1'), { processState: 'running', tasks: [task('a')] });
  assert.equal(service.describeSessionHold('session-3'), null);
});

test('describeSessionHold reports a process on its way out, or tasks alone', () => {
  const task = { taskId: 'b', toolUseId: 'toolu_b', taskType: 'local_agent', description: 'b', startedAt: 1 };
  const service = createService([
    createProvider('claude', createRuntime({
      processState: (sessionId) => (sessionId === 'exiting-session' ? 'exiting' : null),
      listBackgroundWork: () => [{ sessionId: 'tasks-session', tasks: [task] }],
    })),
  ]);

  assert.deepEqual(service.describeSessionHold('exiting-session'), { processState: 'exiting', tasks: [] });
  assert.deepEqual(service.describeSessionHold('tasks-session'), { processState: null, tasks: [task] });
});

test('releaseSession asks every runtime that can let go of a session, once each, and waits for them', async () => {
  const released: string[] = [];
  let finishCodexRelease = () => {};
  const service = createService([
    createProvider('claude', createRuntime({
      async release(sessionId) {
        released.push(`claude:${sessionId}`);
      },
    })),
    createProvider('codex', createRuntime({
      release(sessionId) {
        released.push(`codex:${sessionId}`);
        return new Promise<void>((resolve) => { finishCodexRelease = resolve; });
      },
    })),
    createProvider('cursor', createRuntime()),
  ]);

  let settled = false;
  const release = service.releaseSession('session-1').then(() => { settled = true; });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.deepEqual(released, ['claude:session-1', 'codex:session-1']);
  assert.equal(settled, false, 'one runtime has not let go yet');

  finishCodexRelease();
  await release;
  assert.equal(settled, true);
});

test('planHandOver asks the named provider\'s runtime, and answers that nothing is held for one that cannot hand over', async () => {
  const calls: unknown[][] = [];
  const service = createService([
    createProvider('claude', createRuntime({
      async planHandOver(sessionId, options) {
        calls.push([sessionId, options]);
        return { heldWork: true, canHandOver: false, changes: ['effort', 'tools'], switches: ['model'] };
      },
    })),
    createProvider('cursor', createRuntime()),
  ]);

  assert.deepEqual(
    await service.planHandOver('claude', 'session-1', { effort: 'max' }),
    { heldWork: true, canHandOver: false, changes: ['effort', 'tools'], switches: ['model'] },
  );
  assert.deepEqual(calls, [['session-1', { effort: 'max' }]]);
  assert.deepEqual(
    await service.planHandOver('cursor', 'session-1', {}),
    { heldWork: false, canHandOver: false, changes: [], switches: [] },
  );
});

test('planHandOver passes how to read the options on to the runtime, and reads its switches field by field', async () => {
  const planOptionsSeen: unknown[] = [];
  let switches: unknown = ['permissionMode'];
  const service = createService([
    createProvider('claude', createRuntime({
      async planHandOver(_sessionId, _options, planOptions) {
        planOptionsSeen.push(planOptions);
        return { heldWork: true, canHandOver: true, changes: [], switches } as never;
      },
    })),
  ]);

  assert.deepEqual(
    await service.planHandOver('claude', 'session-1', { model: 'opus' }, { inheritUnset: true }),
    { heldWork: true, canHandOver: true, changes: [], switches: ['permissionMode'] },
  );
  // A runtime from before switches existed answers without them.
  switches = undefined;
  assert.deepEqual(
    await service.planHandOver('claude', 'session-1', { model: 'opus' }),
    { heldWork: true, canHandOver: true, changes: [], switches: [] },
  );
  assert.deepEqual(planOptionsSeen, [{ inheritUnset: true }, undefined], 'a caller that asks nothing passes nothing');
});

test('planSessionHandOver plans a send with the run options chat.send would build, and refuses a session that does not exist', async () => {
  const seen: unknown[] = [];
  const service = createService(
    [createProvider('claude', createRuntime({
      async planHandOver(_sessionId, options) {
        seen.push(options);
        return { heldWork: true, canHandOver: true, changes: [], switches: [] };
      },
    }))],
    { 'session-1': { provider: 'claude', project_path: '/workspace/demo' } },
  );

  assert.deepEqual(
    await service.planSessionHandOver('session-1', { model: 'opus', effort: ' ultracode ', permissionMode: 'default' }),
    { heldWork: true, canHandOver: true, changes: [], switches: [] },
  );
  // The session's project is the working directory, the legacy effort is
  // split, and the turn is named by the app session id, as for a run.
  assert.deepEqual(seen, [{
    model: 'opus',
    effort: 'xhigh',
    ultracode: true,
    permissionMode: 'default',
    sessionId: 'session-1',
    cwd: '/workspace/demo',
    projectPath: '/workspace/demo',
  }]);

  await assert.rejects(
    service.planSessionHandOver('missing-session', {}),
    (error: Error & { code?: string; statusCode?: number }) =>
      error.code === 'SESSION_NOT_FOUND' && error.statusCode === 404,
  );
  assert.equal(seen.length, 1);
});
