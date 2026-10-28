import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { Codex } from '@openai/codex-sdk';
import type { Thread, ThreadOptions } from '@openai/codex-sdk';

import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { withRunNotificationCapture } from '@/modules/providers/tests/fixtures/run-notifications.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/index.js';

for (const resumed of [false, true]) {
  for (const permissionMode of [undefined, 'default', 'unknown', 'acceptEdits', 'bypassPermissions']) {
    test(`Codex ${resumed ? 'resumes' : 'starts'} with supported permissions (${permissionMode ?? 'omitted'})`, async (t) => {
      let capturedOptions: ThreadOptions | undefined;
      let capturedPrompt: unknown;
      const messages: unknown[] = [];
      const thread = {
        id: 'native-thread',
        async runStreamed(prompt: unknown) {
          capturedPrompt = prompt;
          return { events: (async function* () {
            yield { type: 'thread.started', thread_id: 'native-thread' };
          })() };
        },
      } as unknown as Thread;

      const start = t.mock.method(Codex.prototype, 'startThread', (options?: ThreadOptions) => {
        capturedOptions = options;
        return thread;
      });
      const resume = t.mock.method(Codex.prototype, 'resumeThread', (id: string, options?: ThreadOptions) => {
        assert.equal(id, 'native-thread');
        capturedOptions = options;
        return thread;
      });
      const context: ProviderRuntimeContext = {
        resolveProviderSessionId: () => resumed ? 'native-thread' : null,
        resolveResumeModel: async () => 'test-model',
        getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
        normalizeMessage: () => [],
        isProviderInstalled: async () => true,
      };

      await codexRuntime.run('hey there', {
        sessionId: resumed ? 'app-session' : undefined,
        permissionMode,
        cwd: process.cwd(),
      }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, context);

      assert.equal(start.mock.callCount(), resumed ? 0 : 1);
      assert.equal(resume.mock.callCount(), resumed ? 1 : 0);
      assert.equal(capturedPrompt, 'hey there');
      assert.equal(capturedOptions?.sandboxMode, permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write');
      assert.equal(capturedOptions?.approvalPolicy, permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions' ? 'never' : 'on-request');
      assert.ok(messages.some((message: any) => message.kind === 'complete' && message.exitCode === 0));
      assert.ok(!messages.some((message: any) => message.kind === 'error'));
    });
  }
}

for (const command of ['', '  \n\t']) {
  test(`Codex supplies a prompt for an image-only turn (${JSON.stringify(command)})`, async (t) => {
    let capturedPrompt: unknown;
    const imagePath = path.join(process.cwd(), 'public', 'favicon.png');
    const thread = {
      id: 'native-thread',
      async runStreamed(prompt: unknown) {
        capturedPrompt = prompt;
        return { events: (async function* () {
          yield { type: 'thread.started', thread_id: 'native-thread' };
        })() };
      },
    } as unknown as Thread;

    t.mock.method(Codex.prototype, 'startThread', () => thread);
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => null,
      resolveResumeModel: async () => 'test-model',
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
      normalizeMessage: () => [],
      isProviderInstalled: async () => true,
    };

    await codexRuntime.run(command, {
      cwd: process.cwd(),
      images: [{ path: imagePath, mimeType: 'image/png' }],
    }, { isWebSocketWriter: true, send: () => {} }, context);

    assert.deepEqual(capturedPrompt, [
      { type: 'text', text: 'Please analyze the attached image(s).' },
      { type: 'local_image', path: imagePath },
    ]);
  });
}

/**
 * Scripts the threads Codex runs on and returns a function that runs one turn
 * of a session, through a writer that names its run by `runStartedAt` as the
 * chat gateway's writer does. The turn's stream yields `events` after
 * `thread.started`, or `runStreamed` throws `streamError`.
 */
function scriptCodexTurns(t: TestContext) {
  let script: { events: AnyRecord[]; streamError: Error | null } = { events: [], streamError: null };
  t.mock.method(Codex.prototype, 'startThread', () => ({
    id: 'native-thread',
    async runStreamed() {
      const { events, streamError } = script;
      if (streamError) {
        throw streamError;
      }
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: 'native-thread' };
        yield* events;
      })() };
    },
  }) as unknown as Thread);
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };

  return async (turn: { userId: number; sessionId: string; runStartedAt: number; events?: AnyRecord[]; streamError?: Error }) => {
    script = { events: turn.events ?? [], streamError: turn.streamError ?? null };
    await codexRuntime.run('hey there', { sessionId: turn.sessionId, cwd: process.cwd() }, {
      isWebSocketWriter: true,
      userId: turn.userId,
      runStartedAt: turn.runStartedAt,
      send: () => {},
    }, context);
  };
}

test('Codex names the run it reports stopped, so two runs ending inside the dedupe window both notify', async (t) => {
  const runTurn = scriptCodexTurns(t);
  await withRunNotificationCapture(async ({ userId, delivered }) => {
    const events = [{ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }];
    await runTurn({ userId, sessionId: 'codex-stopped', runStartedAt: 1_000, events });
    await runTurn({ userId, sessionId: 'codex-stopped', runStartedAt: 2_000, events });

    assert.deepEqual(delivered(), ['run.stopped@codex-stopped', 'run.stopped@codex-stopped']);
  });
});

test('Codex names the run a failed turn belongs to', async (t) => {
  const runTurn = scriptCodexTurns(t);
  await withRunNotificationCapture(async ({ userId, delivered }) => {
    const events = [{ type: 'turn.failed', error: { message: 'Rate limited' } }];
    await runTurn({ userId, sessionId: 'codex-turn-failed', runStartedAt: 1_000, events });
    await runTurn({ userId, sessionId: 'codex-turn-failed', runStartedAt: 2_000, events });

    assert.deepEqual(delivered(), ['run.failed@codex-turn-failed', 'run.failed@codex-turn-failed']);
  });
});

test('Codex names the run whose stream threw', async (t) => {
  const runTurn = scriptCodexTurns(t);
  t.mock.method(console, 'error', () => undefined);
  await withRunNotificationCapture(async ({ userId, delivered }) => {
    await runTurn({ userId, sessionId: 'codex-threw', runStartedAt: 1_000, streamError: new Error('Codex Exec exited with code 1') });
    await runTurn({ userId, sessionId: 'codex-threw', runStartedAt: 2_000, streamError: new Error('Codex Exec exited with code 1') });

    assert.deepEqual(delivered(), ['run.failed@codex-threw', 'run.failed@codex-threw']);
  });
});
