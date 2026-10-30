import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { buildScheduledStopMessage } from '@/modules/providers/list/claude/claude-scheduled-work.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { IProvider } from '@/shared/interfaces.js';
import type { BackgroundTaskSummary, ScheduledWorkSummary, WorkflowAgentActivity } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

async function withProviderServer(
  run: (baseUrl: string, workspacePath: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'provider-routes-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  const app = express().use(express.json()).use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`, path.join(tempDirectory, 'workspace'));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * Runs `run` with a throwaway HOME, so a route that reads the Claude CLI's
 * process registry under `~/.claude/sessions` finds an empty one instead of
 * the developer's real one.
 */
async function withIsolatedHome(run: () => Promise<void>): Promise<void> {
  const previousHome = process.env.HOME;
  const isolatedHome = await mkdtemp(path.join(os.tmpdir(), 'provider-routes-home-'));
  process.env.HOME = isolatedHome;
  try {
    await run();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(isolatedHome, { recursive: true, force: true });
  }
}

test('session creation route names a CloudCLI session from the initial message', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    const response = await fetch(`${baseUrl}/api/providers/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'codex',
        projectPath: workspacePath,
        initialMessage: 'abcd  efg\nhij klm nop',
      }),
    });
    const payload = await response.json() as {
      data: { sessionId: string; sessionName: string };
    };

    assert.equal(response.status, 201);
    assert.equal(payload.data.sessionName, 'abcd efg hij klm');
    assert.equal(
      sessionsDb.getSessionById(payload.data.sessionId)?.custom_name,
      'abcd efg hij klm',
    );
  });
});

test('conversation search streams title matches before transcript results', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession(
      'title-only-session',
      'codex',
      workspacePath,
      'Release planning notes',
    );
    const transcriptPath = path.join(path.dirname(workspacePath), 'codex-search.jsonl');
    await writeFile(transcriptPath, `${JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-08-12T09:00:00.000Z',
      payload: {
        type: 'user_message',
        kind: 'plain',
        message: 'Release planning also appears in this conversation.',
      },
    })}\n`);
    sessionsDb.createSession(
      'transcript-session',
      'codex',
      workspacePath,
      'Unrelated session',
      undefined,
      undefined,
      transcriptPath,
    );

    const response = await fetch(
      `${baseUrl}/api/providers/search/sessions?q=release%20planning&limit=50`,
    );
    const eventStream = await response.text();
    const titleEventIndex = eventStream.indexOf('event: title-results');
    const conversationEventIndex = eventStream.indexOf('event: result');
    const doneEventIndex = eventStream.indexOf('event: done');

    assert.equal(response.status, 200);
    assert.ok(titleEventIndex >= 0);
    assert.ok(conversationEventIndex > titleEventIndex);
    assert.ok(doneEventIndex > titleEventIndex);

    const titleDataLine = eventStream
      .slice(titleEventIndex, conversationEventIndex)
      .split('\n')
      .find((line) => line.startsWith('data: '));
    assert.ok(titleDataLine);

    const titlePayload = JSON.parse(titleDataLine.slice('data: '.length)) as {
      titleResults: Array<{
        sessionId: string;
        sessionTitle: string;
        provider: string;
      }>;
    };
    assert.equal(titlePayload.titleResults.length, 1);
    assert.equal(titlePayload.titleResults[0]?.sessionId, 'title-only-session');
    assert.equal(titlePayload.titleResults[0]?.sessionTitle, 'Release planning notes');
    assert.equal(titlePayload.titleResults[0]?.provider, 'codex');
  });
});

test('conversation search leaves out the prompt CloudCLI sends to stop loops', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    const sessionId = 'claude-search-control-prompt';
    const transcriptPath = path.join(path.dirname(workspacePath), `${sessionId}.jsonl`);
    const row = (uuid: string, role: 'user' | 'assistant', content: unknown) => JSON.stringify({
      type: role, uuid, sessionId, timestamp: '2026-10-30T09:00:00.000Z', message: { role, content },
    });
    await writeFile(transcriptPath, `${[
      row('question', 'user', 'Watch the deploy every five minutes'),
      row('stop', 'user', buildScheduledStopMessage({ jobIds: ['b2148320'], wakeup: false })),
      row('reply', 'assistant', [{ type: 'text', text: 'Cancelled the loop.' }]),
    ].join('\n')}\n`);
    sessionsDb.createSession(sessionId, 'claude', workspacePath, 'Loop session', undefined, undefined, transcriptPath);

    const matchedRows = async (query: string) => {
      const response = await fetch(`${baseUrl}/api/providers/search/sessions?q=${encodeURIComponent(query)}&limit=50`);
      const eventStream = await response.text();
      return eventStream
        .split('\n\n')
        .filter((event) => event.startsWith('event: result\n'))
        .flatMap((event) => {
          const payload = JSON.parse(event.slice(event.indexOf('data: ') + 'data: '.length)) as {
            projectResult: { sessions: Array<{ matches: Array<{ messageUuid: string | null }> }> } | null;
          };
          return payload.projectResult?.sessions.flatMap((session) => session.matches.map((match) => match.messageUuid)) ?? [];
        });
    };
    assert.deepEqual(await matchedRows('deploy'), ['question']);
    assert.deepEqual(await matchedRows('CronDelete'), []);
  });
});

test('reasoning effort is persisted and returned with the active session model', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('effort-session', 'codex', workspacePath);

    const updateResponse = await fetch(
      `${baseUrl}/api/providers/codex/sessions/effort-session/active-effort`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effort: 'ultra' }),
      },
    );
    const updatePayload = await updateResponse.json() as {
      data: { effort: string; sessionId: string };
    };

    assert.equal(updateResponse.status, 200);
    assert.equal(updatePayload.data.effort, 'ultra');
    assert.equal(sessionsDb.getSessionById('effort-session')?.effort, 'ultra');

    const readResponse = await fetch(
      `${baseUrl}/api/providers/codex/sessions/effort-session/active-model`,
    );
    const readPayload = await readResponse.json() as {
      data: { effort: string | null; sessionId: string };
    };

    assert.equal(readResponse.status, 200);
    assert.equal(readPayload.data.sessionId, 'effort-session');
    assert.equal(readPayload.data.effort, 'ultra');
  });
});

test('the ultracode switch is persisted and returned with the active session model', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('ultracode-session', 'claude', workspacePath);
    sessionsDb.setSessionEffort('ultracode-session', 'low');
    const postUltracode = async (sessionId: string, body: unknown) => {
      const response = await fetch(
        `${baseUrl}/api/providers/claude/sessions/${sessionId}/active-ultracode`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      return {
        status: response.status,
        payload: await response.json() as {
          data?: { sessionId: string; effort: string | null; ultracode: boolean | null; source: string };
          error?: { code: string };
        },
      };
    };
    const readUltracode = async () => {
      const response = await fetch(`${baseUrl}/api/providers/claude/sessions/ultracode-session/active-model`);
      return (await response.json() as { data: { effort: string | null; ultracode: boolean | null } }).data;
    };

    const initial = await readUltracode();
    assert.equal(initial.effort, 'low');
    assert.equal(initial.ultracode, null);

    const turnedOn = await postUltracode('ultracode-session', { ultracode: true });
    assert.equal(turnedOn.status, 200);
    assert.deepEqual(turnedOn.payload.data, {
      provider: 'claude',
      sessionId: 'ultracode-session',
      effort: 'low',
      ultracode: true,
      source: 'session',
    });
    assert.equal(sessionsDb.getSessionById('ultracode-session')?.ultracode, 1);
    // Independent of the effort level: low effort keeps ultracode on.
    assert.equal((await readUltracode()).ultracode, true);
    assert.equal((await readUltracode()).effort, 'low');

    const turnedOff = await postUltracode('ultracode-session', { ultracode: false });
    assert.equal(turnedOff.status, 200);
    assert.equal(turnedOff.payload.data?.ultracode, false);
    assert.equal(sessionsDb.getSessionById('ultracode-session')?.ultracode, 0);
    assert.equal((await readUltracode()).ultracode, false);

    // A session the gateway has not created yet gets its choice echoed back.
    const pending = await postUltracode('not-created-yet', { ultracode: true });
    assert.equal(pending.status, 200);
    assert.deepEqual(pending.payload.data, {
      provider: 'claude',
      sessionId: 'not-created-yet',
      effort: null,
      ultracode: true,
      source: 'session',
    });

    for (const invalid of [{}, { ultracode: 'true' }, { ultracode: 1 }, { ultracode: null }, []]) {
      const rejected = await postUltracode('ultracode-session', invalid);
      assert.equal(rejected.status, 400, JSON.stringify(invalid));
      assert.equal(rejected.payload.error?.code, 'ULTRACODE_REQUIRED', JSON.stringify(invalid));
    }
    assert.equal(sessionsDb.getSessionById('ultracode-session')?.ultracode, 0);
  });
});

test('a legacy ultracode effort posted by an old client is stored as xhigh with ultracode on', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('legacy-effort-session', 'claude', workspacePath);

    const response = await fetch(
      `${baseUrl}/api/providers/claude/sessions/legacy-effort-session/active-effort`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effort: 'ultracode' }),
      },
    );
    const payload = await response.json() as { data: { effort: string; ultracode: boolean | null } };

    assert.equal(response.status, 200);
    assert.equal(payload.data.effort, 'xhigh');
    assert.equal(payload.data.ultracode, true);
    assert.equal(sessionsDb.getSessionById('legacy-effort-session')?.effort, 'xhigh');
    assert.equal(sessionsDb.getSessionById('legacy-effort-session')?.ultracode, 1);
  });
});

test('the capabilities route reports which providers can run ultracode', async () => {
  await withProviderServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/providers/capabilities`);
    const payload = await response.json() as {
      data: { providers: Array<{ provider: string; supportsUltracode: boolean }> };
    };

    assert.equal(response.status, 200);
    assert.deepEqual(
      Object.fromEntries(payload.data.providers.map((row) => [row.provider, row.supportsUltracode])),
      { claude: true, cursor: false, codex: false, opencode: false, agy: false },
    );
  });
});

test('agy routes: new chats, capabilities, status, catalog and the read-only facets', async () => {
  // A throwaway HOME and data root, and an agy that is not installed: nothing
  // may reach the real ~/.gemini or run the real CLI.
  const isolatedEnv = ['HOME', 'AGY_CLI_PATH', 'AGY_DATA_DIRS'].map((key) => [key, process.env[key]] as const);
  const agyHome = await mkdtemp(path.join(os.tmpdir(), 'provider-routes-agy-'));
  process.env.HOME = agyHome;
  process.env.AGY_CLI_PATH = path.join(agyHome, 'not-installed', 'agy');
  process.env.AGY_DATA_DIRS = path.join(agyHome, 'agy-data');

  try {
    await withProviderServer(async (baseUrl, workspacePath) => {
      const readData = async (route: string, init?: RequestInit) => {
        const response = await fetch(`${baseUrl}/api/providers${route}`, init);
        return { status: response.status, data: (await response.json() as { data: any }).data };
      };

      const created = await readData('/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'agy', projectPath: workspacePath, initialMessage: 'Hello agy' }),
      });
      assert.equal(created.status, 201);
      assert.equal(sessionsDb.getSessionById(created.data.sessionId)?.provider, 'agy');

      const capabilities = await readData('/agy/capabilities');
      assert.equal(capabilities.status, 200);
      assert.equal(capabilities.data.provider, 'agy');
      assert.equal(capabilities.data.supportsImages, false);

      const auth = await readData('/agy/auth/status');
      assert.equal(auth.status, 200);
      assert.equal(auth.data.provider, 'agy');
      assert.equal(auth.data.installed, false);
      assert.equal(auth.data.authenticated, false);

      // Not installed: the built-in catalog, without spawning anything.
      const catalog = await readData('/agy/models');
      assert.equal(catalog.status, 200);
      assert.equal(catalog.data.models.DEFAULT, 'auto');
      assert.equal(catalog.data.models.OPTIONS.length, 19);
      assert.deepEqual(catalog.data.models.EFFORT_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max']);

      const mcp = await readData('/agy/mcp/servers');
      assert.equal(mcp.status, 200);
      assert.deepEqual(mcp.data.scopes, { user: [], local: [], project: [] });

      const skills = await readData('/agy/skills');
      assert.equal(skills.status, 200);
      assert.deepEqual(skills.data.skills, []);
    });
  } finally {
    for (const [key, value] of isolatedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(agyHome, { recursive: true, force: true });
  }
});

test('model routes expose immutable defaults and full custom model CRUD', async () => {
  await withProviderServer(async (baseUrl) => {
    const initialResponse = await fetch(`${baseUrl}/api/providers/codex/models`);
    const initialPayload = await initialResponse.json() as {
      data: {
        cache?: unknown;
        models: {
          OPTIONS: Array<{ recordId?: number; value: string; isCustom: boolean }>;
        };
      };
    };
    assert.equal(initialResponse.status, 200);
    assert.equal('cache' in initialPayload.data, false);
    const predefined = initialPayload.data.models.OPTIONS[0];
    assert.equal(predefined.isCustom, false);
    assert.equal(predefined.recordId, undefined);

    const createResponse = await fetch(`${baseUrl}/api/providers/codex/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'Gateway GPT', id: 'gateway/gpt' }),
    });
    const createPayload = await createResponse.json() as {
      data: { model: { recordId: number; value: string; label: string; isCustom: boolean } };
    };
    assert.equal(createResponse.status, 201);
    assert.equal(createPayload.data.model.isCustom, true);
    const customRecordId = createPayload.data.model.recordId;

    const updateResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/${customRecordId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Gateway GPT Updated', id: 'gateway/gpt-v2' }),
      },
    );
    const updatePayload = await updateResponse.json() as {
      data: { model: { value: string; label: string } };
    };
    assert.equal(updateResponse.status, 200);
    assert.equal(updatePayload.data.model.value, 'gateway/gpt-v2');
    assert.equal(updatePayload.data.model.label, 'Gateway GPT Updated');

    const immutableResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/999999`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Changed', id: 'changed' }),
      },
    );
    const immutablePayload = await immutableResponse.json() as { error: { code: string } };
    assert.equal(immutableResponse.status, 404);
    assert.equal(immutablePayload.error.code, 'MODEL_NOT_FOUND');

    const deleteResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/${customRecordId}`,
      { method: 'DELETE' },
    );
    const deletePayload = await deleteResponse.json() as {
      data: { models: { OPTIONS: Array<{ recordId: number }> } };
    };
    assert.equal(deleteResponse.status, 200);
    assert.equal(
      deletePayload.data.models.OPTIONS.some((option) => option.recordId === customRecordId),
      false,
    );
  });
});

test('the custom-only route restricts a provider catalog to its custom models', async () => {
  await withProviderServer(async (baseUrl) => {
    type Catalog = {
      OPTIONS: Array<{ value: string; isCustom: boolean }>;
      DEFAULT: string;
      CUSTOM_MODELS_ONLY?: boolean;
    };
    const readCatalog = async (provider: string): Promise<Catalog> => {
      const response = await fetch(`${baseUrl}/api/providers/${provider}/models`);
      return (await response.json() as { data: { models: Catalog } }).data.models;
    };
    const putCustomOnly = async (provider: string, body: unknown) => {
      const response = await fetch(`${baseUrl}/api/providers/${provider}/models/custom-only`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        payload: await response.json() as {
          data?: { provider: string; models: Catalog };
          error?: { code: string };
        },
      };
    };

    const builtIn = await readCatalog('codex');
    assert.equal(builtIn.CUSTOM_MODELS_ONLY, false);
    assert.ok(builtIn.OPTIONS.length > 0);

    for (const [model, id] of [['Gateway One', 'gateway/one'], ['Gateway Two', 'gateway/two']]) {
      const created = await fetch(`${baseUrl}/api/providers/codex/models`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, id }),
      });
      assert.equal(created.status, 201);
    }

    const enabled = await putCustomOnly('codex', { enabled: true });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.payload.data?.provider, 'codex');
    assert.deepEqual(
      enabled.payload.data?.models.OPTIONS.map((option) => option.value),
      ['gateway/one', 'gateway/two'],
    );
    assert.equal(enabled.payload.data?.models.DEFAULT, 'gateway/one');
    assert.equal(enabled.payload.data?.models.CUSTOM_MODELS_ONLY, true);
    // Persisted, and scoped to the one provider.
    assert.deepEqual(await readCatalog('codex'), enabled.payload.data?.models);
    assert.equal((await readCatalog('cursor')).CUSTOM_MODELS_ONLY, false);

    for (const invalid of [{}, { enabled: 'true' }, { enabled: 1 }, []]) {
      const rejected = await putCustomOnly('codex', invalid);
      assert.equal(rejected.status, 400, JSON.stringify(invalid));
      assert.equal(rejected.payload.error?.code, 'INVALID_CUSTOM_MODELS_ONLY');
    }
    assert.equal((await readCatalog('codex')).CUSTOM_MODELS_ONLY, true);

    const disabled = await putCustomOnly('codex', { enabled: false });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.payload.data?.models.DEFAULT, builtIn.DEFAULT);
    assert.equal(
      disabled.payload.data?.models.OPTIONS.length,
      builtIn.OPTIONS.length + 2,
    );
  });
});

test('custom model routes accept, validate, and return reasoning-effort levels', async () => {
  await withProviderServer(async (baseUrl) => {
    const postModel = async (provider: string, body: unknown) => {
      const response = await fetch(`${baseUrl}/api/providers/${provider}/models`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        payload: await response.json() as {
          data?: {
            model: { recordId: number; effort?: unknown };
            models: { OPTIONS: Array<{ value: string; effort?: unknown }> };
          };
          error?: { code: string; message?: string };
        },
      };
    };

    const created = await postModel('claude', {
      model: 'My Custom Model',
      id: 'my-custom-model',
      effort: { values: [' low ', 'high'], default: 'high' },
    });
    const expectedEffort = { default: 'high', values: [{ value: 'low' }, { value: 'high' }] };
    assert.equal(created.status, 201);
    assert.deepEqual(created.payload.data?.model.effort, expectedEffort);

    const catalogResponse = await fetch(`${baseUrl}/api/providers/claude/models`);
    const catalogPayload = await catalogResponse.json() as {
      data: { models: { OPTIONS: Array<{ value: string; effort?: unknown }>; EFFORT_LEVELS?: string[] } };
    };
    assert.deepEqual(
      catalogPayload.data.models.OPTIONS.find((option) => option.value === 'my-custom-model')?.effort,
      expectedEffort,
    );
    // The model library's toggles come from here, not from the built-in models.
    assert.deepEqual(
      catalogPayload.data.models.EFFORT_LEVELS,
      ['low', 'medium', 'high', 'xhigh', 'max'],
    );

    // OpenCode's allowed levels do not depend on which upstream providers the
    // machine running the tests has connected.
    const openCodeModel = await postModel('opencode', {
      model: 'Router model',
      id: 'openrouter/router-model',
      effort: { values: ['none', 'high'] },
    });
    assert.equal(openCodeModel.status, 201, JSON.stringify(openCodeModel.payload));
    assert.deepEqual(openCodeModel.payload.data?.model.effort, { values: [{ value: 'none' }, { value: 'high' }] });

    // A PATCH from a client that predates effort metadata keeps the levels.
    const renameResponse = await fetch(
      `${baseUrl}/api/providers/claude/models/${created.payload.data?.model.recordId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Renamed', id: 'my-custom-model' }),
      },
    );
    const renamePayload = await renameResponse.json() as { data: { model: { effort?: unknown } } };
    assert.equal(renameResponse.status, 200);
    assert.deepEqual(renamePayload.data.model.effort, expectedEffort);

    const invalidPayloads: Array<{ provider: string; effort: unknown; code: string }> = [
      { provider: 'claude', effort: { values: ['low', 'low'] }, code: 'INVALID_MODEL_EFFORT' },
      { provider: 'claude', effort: { values: ['low', ''] }, code: 'INVALID_MODEL_EFFORT' },
      { provider: 'claude', effort: { values: ['low'], default: 'high' }, code: 'INVALID_MODEL_EFFORT' },
      { provider: 'claude', effort: { values: ['turbo'] }, code: 'INVALID_MODEL_EFFORT' },
      { provider: 'claude', effort: 'high', code: 'INVALID_MODEL_EFFORT' },
      { provider: 'cursor', effort: { values: ['low'] }, code: 'MODEL_EFFORT_NOT_SUPPORTED' },
    ];
    for (const [index, invalid] of invalidPayloads.entries()) {
      const rejected = await postModel(invalid.provider, {
        model: `Invalid ${index}`,
        id: `invalid-${index}`,
        effort: invalid.effort,
      });
      assert.equal(rejected.status, 400, JSON.stringify(invalid));
      assert.equal(rejected.payload.error?.code, invalid.code, JSON.stringify(invalid));
    }

    // An oversized list is refused by its length, before any entry is walked:
    // the JSON parser accepts bodies of up to 50 MB.
    const oversized = await postModel('claude', {
      model: 'Oversized',
      id: 'oversized',
      effort: { values: Array.from({ length: 33 }, (_, index) => `level-${index}`) },
    });
    assert.equal(oversized.status, 400);
    assert.equal(oversized.payload.error?.code, 'INVALID_MODEL_EFFORT');
    assert.match(oversized.payload.error?.message ?? '', /at most 32 effort levels/);
  });
});

test('the running-sessions route reports a session held open for background work', async () => {
  // The client polls this route to keep every tab's activity map in step, so
  // a session whose turn ended but whose agent is still running has to be in
  // the payload — flagged as background work, with the tasks to show and stop.
  const tasks: BackgroundTaskSummary[] = [{
    taskId: 'a73dc7a6442f7c415',
    toolUseId: 'toolu_013sUz4iWcNjN6BskVkHUCAr',
    taskType: 'local_agent',
    description: 'Investigate the flaky test',
    startedAt: 1_700_000_000_000,
  }];
  const realListProviders = providerRegistry.listProviders;
  providerRegistry.listProviders = () => [{
    id: 'claude',
    runtime: { listBackgroundWork: () => [{ sessionId: 'held-session', tasks }] },
  } as unknown as IProvider];

  try {
    await withIsolatedHome(() => withProviderServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/providers/sessions/running`);
      const payload = await response.json() as { data: { sessions: unknown[] } };

      assert.equal(response.status, 200);
      assert.deepEqual(payload.data.sessions, [{
        sessionId: 'held-session',
        provider: 'claude',
        startedAt: 1_700_000_000_000,
        lastSeq: 0,
        background: true,
        canInterrupt: false,
        tasks,
      }]);
    }));
  } finally {
    providerRegistry.listProviders = realListProviders;
  }
});

test('the running-sessions route lists a session held only for scheduled work when asked with scheduled=1, and leaves it out otherwise', async () => {
  // A /loop holds the session's process for its next firing, with no task.
  const scheduled: ScheduledWorkSummary[] = [{
    id: 'cron:b2148320',
    kind: 'cron',
    toolUseId: 'toolu_01CronCreate',
    prompt: 'check CI',
    startedAt: 1_700_000_000_000,
    nextFireAt: 1_700_000_300_000,
    recurring: true,
    holdUntil: 1_700_691_200_000,
    cron: '*/5 * * * *',
    cadence: 'Every 5 minutes',
  }];
  const realListProviders = providerRegistry.listProviders;
  providerRegistry.listProviders = () => [{
    id: 'claude',
    runtime: {
      listBackgroundWork: () => [],
      listScheduledWork: () => [{ sessionId: 'loop-session', scheduled }],
    },
  } as unknown as IProvider];

  try {
    await withIsolatedHome(() => withProviderServer(async (baseUrl) => {
      const read = async (query: string) => {
        const response = await fetch(`${baseUrl}/api/providers/sessions/running${query}`);
        assert.equal(response.status, 200);
        return (await response.json() as { data: { sessions: unknown[] } }).data.sessions;
      };

      assert.deepEqual(await read(''), []);
      assert.deepEqual(await read('?scheduled=0'), []);
      assert.deepEqual(await read('?scheduled=1'), [{
        sessionId: 'loop-session',
        provider: 'claude',
        startedAt: 1_700_000_000_000,
        lastSeq: 0,
        background: true,
        canInterrupt: false,
        tasks: [],
        scheduled,
      }]);
    }));
  } finally {
    providerRegistry.listProviders = realListProviders;
  }
});

test('the run-ends route lists the runs that ended recently, as they were broadcast', async () => {
  // A tab reads this after its socket comes back, to catch up on the
  // `run_ended` frames it missed; the registry is the only source.
  try {
    await withProviderServer(async (baseUrl, workspacePath) => {
      sessionsDb.createAppSession('ended-session', 'codex', workspacePath, 'Release notes');
      const run = chatRunRegistry.startRun({
        appSessionId: 'ended-session',
        provider: 'codex',
        providerSessionId: null,
        connection: null,
        userId: null,
      });
      assert.ok(run);
      run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-ended', exitCode: 1 });

      const response = await fetch(`${baseUrl}/api/providers/sessions/run-ends`);
      const payload = await response.json() as { success: boolean; data: { ends: Array<Record<string, unknown>> } };

      assert.equal(response.status, 200);
      assert.deepEqual(payload, { success: true, data: { ends: chatRunRegistry.listRecentRunEnds() } });
      assert.deepEqual(
        payload.data.ends.map((end) => [end.sessionId, end.provider, end.runStartedAt, end.outcome, end.sessionName]),
        [['ended-session', 'codex', run.startedAt, 'failed', 'Release notes']],
      );
    });
  } finally {
    chatRunRegistry.clearAll();
  }
});

const WORKFLOW_SESSION_ID = 'claude-workflow-routes-session';
const WORKFLOW_RUN_ID = 'wf_16fbf852-274';
const FINISHED_AGENT_ID = 'aa1e064cf8bd159d6';
const UNREPORTED_AGENT_ID = 'ab89f2cde612a51b1';

/**
 * Writes a workflow run's directory the way a real run leaves it under the
 * session's transcript directory: one `agent-<id>.jsonl` per agent, in the
 * row shape an Agent subagent's transcript has, and the journal beside them.
 */
async function writeWorkflowRun(projectDirectory: string): Promise<string> {
  const sessionPath = path.join(projectDirectory, `${WORKFLOW_SESSION_ID}.jsonl`);
  await mkdir(projectDirectory, { recursive: true });
  await writeFile(sessionPath, `${JSON.stringify({ type: 'user', uuid: 'u1', sessionId: WORKFLOW_SESSION_ID, timestamp: '2026-08-21T10:32:10.000Z', message: { role: 'user', content: 'audit the frontend' } })}\n`, 'utf8');

  const runDir = path.join(projectDirectory, WORKFLOW_SESSION_ID, 'subagents', 'workflows', WORKFLOW_RUN_ID);
  await mkdir(runDir, { recursive: true });

  const agentRows = (agentId: string) => [
    { parentUuid: null, isSidechain: true, agentId, type: 'user', uuid: `${agentId}-u1`, timestamp: '2026-08-21T10:32:20.000Z', message: { role: 'user', content: 'You are the analysis step of a code-quality audit.' } },
    { parentUuid: `${agentId}-u1`, isSidechain: true, agentId, type: 'assistant', uuid: `${agentId}-a1`, timestamp: '2026-08-21T10:32:25.000Z', message: { role: 'assistant', model: 'claude-opus-4-1', content: [{ type: 'tool_use', id: `toolu_${agentId}_1`, name: 'Grep', input: { pattern: 'useSidebar' } }] } },
    { parentUuid: `${agentId}-a1`, isSidechain: true, agentId, type: 'user', uuid: `${agentId}-u2`, timestamp: '2026-08-21T10:32:26.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${agentId}_1`, content: 'src/modules/sidebar/useSidebar.ts' }] } },
    { parentUuid: `${agentId}-u2`, isSidechain: true, agentId, type: 'assistant', uuid: `${agentId}-a2`, timestamp: '2026-08-21T10:32:40.000Z', message: { role: 'assistant', model: 'claude-opus-4-1', content: [{ type: 'text', text: 'One hook owns the sidebar.' }] } },
  ];
  for (const agentId of [FINISHED_AGENT_ID, UNREPORTED_AGENT_ID]) {
    await writeFile(path.join(runDir, `agent-${agentId}.jsonl`), `${agentRows(agentId).map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    await writeFile(path.join(runDir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }), 'utf8');
  }
  const journal = [
    { type: 'started', key: 'v2:one', agentId: FINISHED_AGENT_ID, label: 'audit:sidebar', phase: 'Audit' },
    { type: 'started', key: 'v2:two', agentId: UNREPORTED_AGENT_ID, label: 'synthesize', phase: 'Synthesize' },
    { type: 'result', key: 'v2:one', agentId: FINISHED_AGENT_ID, result: { area: 'sidebar' } },
  ];
  await writeFile(path.join(runDir, 'journal.jsonl'), `${journal.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  return sessionPath;
}

test('the workflow agent route reads an agent\'s timeline and status from its run directory', async () => {
  await withIsolatedHome(() => withProviderServer(async (baseUrl, workspacePath) => {
    const sessionPath = await writeWorkflowRun(workspacePath);
    const now = new Date().toISOString();
    sessionsDb.createSession(WORKFLOW_SESSION_ID, 'claude', workspacePath, 'Workflow session', now, now, sessionPath);

    const agentUrl = (runId: string, agentId: string) =>
      `${baseUrl}/api/providers/sessions/${WORKFLOW_SESSION_ID}/workflows/${runId}/agents/${agentId}`;

    // The SDK streams none of an agent's rows to the parent, so its transcript
    // is the only record of what it did — read on demand, capped like an
    // Agent card's, and settled by the journal beside it.
    const finishedResponse = await fetch(agentUrl(WORKFLOW_RUN_ID, FINISHED_AGENT_ID));
    const finished = (await finishedResponse.json() as { data: WorkflowAgentActivity }).data;
    assert.equal(finishedResponse.status, 200);
    assert.deepEqual(finished.agent, { id: FINISHED_AGENT_ID, label: 'audit:sidebar', model: 'claude-opus-4-1', status: 'completed' });
    assert.equal(finished.activityCount, 2);
    assert.deepEqual(finished.activity.map((entry) => entry.kind), ['tool', 'text']);
    assert.equal(finished.activity[0]?.toolName, 'Grep');
    assert.deepEqual(finished.activity[0]?.toolInput, { pattern: 'useSidebar' });
    assert.deepEqual(finished.activity[0]?.toolResult, { content: 'src/modules/sidebar/useSidebar.ts', isError: false });
    assert.equal(finished.activity[1]?.content, 'One hook owns the sidebar.');

    // A `started` with no `result` or `failed`, and no live run of the session
    // to still be working in: nothing can report for it any more.
    const unreportedResponse = await fetch(agentUrl(WORKFLOW_RUN_ID, UNREPORTED_AGENT_ID));
    const unreported = (await unreportedResponse.json() as { data: WorkflowAgentActivity }).data;
    assert.equal(unreportedResponse.status, 200);
    assert.equal(unreported.agent.status, 'stopped');
    assert.equal(unreported.agent.label, 'synthesize');

    // Both ids name a file under the session directory, so neither may carry
    // anything but the harness's own shapes — not even a well-formed
    // directory that happens to exist.
    for (const [runId, agentId, code] of [
      [`${WORKFLOW_RUN_ID}%2F..`, FINISHED_AGENT_ID, 'INVALID_WORKFLOW_RUN_ID'],
      ['subagents', FINISHED_AGENT_ID, 'INVALID_WORKFLOW_RUN_ID'],
      [WORKFLOW_RUN_ID, '..%2Fjournal', 'INVALID_WORKFLOW_AGENT_ID'],
      [WORKFLOW_RUN_ID, 'aa1e064cf8bd159d', 'INVALID_WORKFLOW_AGENT_ID'],
    ] as const) {
      const response = await fetch(agentUrl(runId, agentId));
      const payload = await response.json() as { error: { code: string } };
      assert.equal(response.status, 400, `${runId}/${agentId}`);
      assert.equal(payload.error.code, code);
    }

    const missingResponse = await fetch(agentUrl(WORKFLOW_RUN_ID, 'a0000000000000000'));
    const missing = await missingResponse.json() as { error: { code: string } };
    assert.equal(missingResponse.status, 404);
    assert.equal(missing.error.code, 'WORKFLOW_AGENT_NOT_FOUND');
  }));
});

test('the hand-over plan route answers whether a send with these options keeps the session\'s background work', async () => {
  // The composer asks this before it sends to a session whose turn ended
  // with background work left; the runtime plans with the run options the
  // send would get.
  const planned: Array<{ sessionId: string; options: Record<string, unknown> }> = [];
  let answer: Record<string, unknown> = { heldWork: true, canHandOver: false, changes: ['effort'] };
  const realResolveProvider = providerRegistry.resolveProvider;
  providerRegistry.resolveProvider = ((provider: string) => {
    if (provider !== 'claude') {
      return realResolveProvider(provider);
    }
    return {
      id: 'claude',
      runtime: {
        planHandOver: async (sessionId: string, options: Record<string, unknown>) => {
          planned.push({ sessionId, options });
          return answer;
        },
      },
    } as unknown as IProvider;
  }) as typeof providerRegistry.resolveProvider;

  try {
    await withProviderServer(async (baseUrl, workspacePath) => {
      sessionsDb.createAppSession('held-session', 'claude', workspacePath, 'Background build');
      const ask = (sessionId: string, body: unknown) => fetch(
        `${baseUrl}/api/providers/sessions/${sessionId}/hand-over-plan`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      );

      const response = await ask('held-session', { options: { model: 'opus', effort: 'max' } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        success: true,
        data: { heldWork: true, canHandOver: false, changes: ['effort'] },
      });
      assert.equal(planned.length, 1);
      assert.equal(planned[0]?.sessionId, 'held-session');
      assert.equal(planned[0]?.options.cwd, workspacePath, 'the session\'s project is the turn\'s directory');
      assert.equal(planned[0]?.options.effort, 'max');

      const unknown = await ask('no-such-session', { options: {} });
      assert.equal(unknown.status, 404);
      assert.equal((await unknown.json() as { error: { code: string } }).error.code, 'SESSION_NOT_FOUND');

      const malformed = await ask('held-session', { options: ['effort'] });
      assert.equal(malformed.status, 400);
      assert.equal(planned.length, 1, 'neither reaches the runtime');

      // What exactly keeps the turn out, and a process of its own that keeps
      // the work, go out as the runtime said, field by field.
      answer = {
        heldWork: true,
        canHandOver: false,
        changes: ['tools', 'permissionMode'],
        details: {
          tools: { notAllowed: ['WebFetch'], alsoDenied: [], extra: 1 },
          permissionMode: { process: 'plan', message: 'bypassPermissions', reason: 'bypass_not_allowed' },
          model: 'not an object',
        },
        replaceKeepsWork: true,
      };
      const detailed = await ask('held-session', { options: {} });
      assert.deepEqual((await detailed.json() as { data: unknown }).data, {
        heldWork: true,
        canHandOver: false,
        changes: ['tools', 'permissionMode'],
        details: {
          tools: { notAllowed: ['WebFetch'], alsoDenied: [] },
          permissionMode: { process: 'plan', message: 'bypassPermissions', reason: 'bypass_not_allowed' },
        },
        replaceKeepsWork: true,
      });
    });
  } finally {
    providerRegistry.resolveProvider = realResolveProvider;
  }
});

test('the turn-question route answers with the question of the turn a row belongs to', async () => {
  await withIsolatedHome(() => withProviderServer(async (baseUrl, workspacePath) => {
    const sessionId = 'claude-turn-question-route-session';
    const transcriptPath = path.join(workspacePath, `${sessionId}.jsonl`);
    const transcriptRow = (uuid: string, parentUuid: string | null, role: 'user' | 'assistant', text: string, second: number) => ({
      type: role,
      uuid,
      parentUuid,
      sessionId,
      timestamp: new Date(Date.UTC(2026, 7, 21, 10, 0, second)).toISOString(),
      message: role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] },
    });
    const rows = [
      transcriptRow('u1', null, 'user', 'First question', 0),
      transcriptRow('a1', 'u1', 'assistant', 'First answer', 1),
      transcriptRow('u2', 'a1', 'user', 'Second question', 2),
      transcriptRow('a2', 'u2', 'assistant', 'Working on it', 3),
      transcriptRow('a3', 'a2', 'assistant', 'Done', 4),
    ];
    await mkdir(workspacePath, { recursive: true });
    await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    const now = new Date().toISOString();
    sessionsDb.createSession(sessionId, 'claude', workspacePath, 'Turn question', now, now, transcriptPath);

    const historyResponse = await fetch(`${baseUrl}/api/providers/sessions/${sessionId}/messages`);
    const history = (await historyResponse.json() as { data: { messages: Array<Record<string, unknown>> } }).data.messages;
    const rowWithContent = (content: string) => history.find((message) => message.content === content);
    const midTurnRow = rowWithContent('Working on it');
    assert.ok(midTurnRow);

    const ask = async (query: string) => {
      const response = await fetch(`${baseUrl}/api/providers/sessions/${sessionId}/turn-question?${query}`);
      return { status: response.status, payload: await response.json() as Record<string, unknown> };
    };
    const at = encodeURIComponent(String(midTurnRow.timestamp));

    // The question is the same row the history route serves.
    const answered = await ask(`before=${encodeURIComponent(String(midTurnRow.id))}`);
    assert.equal(answered.status, 200);
    assert.deepEqual(answered.payload, { success: true, data: { question: rowWithContent('Second question') } });

    const byTime = await ask(`before=row-from-an-older-parse&at=${at}`);
    assert.equal(byTime.status, 200);
    assert.deepEqual(byTime.payload, answered.payload);

    // An `at` that does not parse counts as not sent rather than failing the request.
    const garbledTime = await ask(`before=${encodeURIComponent(String(midTurnRow.id))}&at=yesterday-ish`);
    assert.equal(garbledTime.status, 200);
    assert.deepEqual(garbledTime.payload, answered.payload);
    const lost = await ask('before=row-from-an-older-parse&at=yesterday-ish');
    assert.equal(lost.status, 200);
    assert.deepEqual(lost.payload, { success: true, data: { question: null } });

    const firstRow = await ask(`before=${encodeURIComponent(String(rowWithContent('First question')?.id))}`);
    assert.equal(firstRow.status, 200);
    assert.deepEqual(firstRow.payload, { success: true, data: { question: null } });
  }));
});

test('the turn-question route refuses a missing, empty, oversized or unprintable row id', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    // A session that has not run yet: an empty history, so nothing to find.
    sessionsDb.createAppSession('fresh-turn-question-session', 'claude', workspacePath);
    const ask = async (sessionId: string, query: string) => {
      const response = await fetch(`${baseUrl}/api/providers/sessions/${sessionId}/turn-question?${query}`);
      return {
        status: response.status,
        payload: await response.json() as { data?: { question: unknown }; error?: { code: string } },
      };
    };

    for (const query of [
      '',
      'at=2026-08-21T10%3A00%3A03.000Z',
      'before=',
      'before=%20%20',
      `before=${'r'.repeat(301)}`,
      'before=row%0A',
      'before=row%00id',
      'before=row-1&before=row-2',
    ]) {
      const rejected = await ask('fresh-turn-question-session', query);
      assert.equal(rejected.status, 400, query);
      assert.equal(rejected.payload.error?.code, 'INVALID_QUERY_PARAMETER', query);
    }

    const longest = await ask('fresh-turn-question-session', `before=${'r'.repeat(300)}`);
    assert.equal(longest.status, 200);
    assert.equal(longest.payload.data?.question, null);

    const unknown = await ask('no-such-session', 'before=row-1');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.payload.error?.code, 'SESSION_NOT_FOUND');
  });
});

test('the paused-work route lists the loops no process runs, and none while a process of this server holds the session', async () => {
  const paused: ScheduledWorkSummary[] = [{
    id: 'cron:b2148320',
    kind: 'cron',
    toolUseId: 'toolu_01CronCreate',
    prompt: 'check CI',
    startedAt: 1_700_000_000_000,
    nextFireAt: 1_700_000_300_000,
    recurring: true,
    holdUntil: 1_700_691_200_000,
    paused: true,
  }];
  let processState: 'running' | null = null;
  const claude = {
    id: 'claude',
    runtime: {
      processState: () => processState,
      listBackgroundWork: () => [],
      listScheduledWork: () => [],
    },
    sessions: {
      readPausedScheduledWork: async () => ({ items: paused, resumeContent: 'resume', heldElsewhere: false }),
    },
  } as unknown as IProvider;
  const realListProviders = providerRegistry.listProviders;
  const realResolveProvider = providerRegistry.resolveProvider;
  providerRegistry.listProviders = () => [claude];
  providerRegistry.resolveProvider = () => claude;

  try {
    await withIsolatedHome(() => withProviderServer(async (baseUrl, workspacePath) => {
      await mkdir(workspacePath, { recursive: true });
      sessionsDb.createSession('paused-session', 'claude', workspacePath);
      const read = async (sessionId: string) => {
        const response = await fetch(`${baseUrl}/api/providers/sessions/${sessionId}/paused-scheduled-work`);
        assert.equal(response.status, 200);
        return (await response.json() as { data: { scheduled: unknown[] } }).data.scheduled;
      };

      assert.deepEqual(await read('paused-session'), paused);
      processState = 'running';
      assert.deepEqual(await read('paused-session'), []);
      assert.deepEqual(await read('no-such-session'), []);
    }));
  } finally {
    providerRegistry.listProviders = realListProviders;
    providerRegistry.resolveProvider = realResolveProvider;
  }
});
