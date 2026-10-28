import assert from 'node:assert/strict';
import * as nodeCrypto from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import express from 'express';

import type { LLMProvider } from '@/shared/types.js';

import { createAgentRouter } from '../agent.routes.js';

// The routes log clone progress to stdout while requests run. node:test's
// parent reads this file's results from the same stdout, and under the full
// parallel suite that async output can interleave with a result frame and
// corrupt it ("Unable to deserialize cloned data"), dropping the whole file's
// results. Nothing here asserts on stdout, so keep it quiet.
test.mock.method(console, 'log', () => undefined);
test.mock.method(console, 'info', () => undefined);

type AgentDependencies = Parameters<typeof createAgentRouter>[0];
type AgentRunFunction = ReturnType<AgentDependencies['getRunner']>;

function createDependencies({
  runners = {},
  ...overrides
}: Partial<AgentDependencies> & {
  /** Provider runtimes by provider id; the runner of any other provider fails the request if called. */
  runners?: Partial<Record<LLMProvider, AgentRunFunction>>;
} = {}): AgentDependencies {
  const unexpectedProviderCall = async (): Promise<never> => {
    throw new Error('Provider runtime should not be called');
  };

  return {
    fileSystem: {} as AgentDependencies['fileSystem'],
    crypto: nodeCrypto,
    homeDirectory: () => '/home/test',
    spawnProcess: (() => { throw new Error('spawn should not run'); }) as unknown as
      AgentDependencies['spawnProcess'],
    platformMode: true,
    users: { getFirstUser: () => ({ id: 1, username: 'test-user' }) },
    apiKeys: { validateApiKey: () => undefined },
    githubTokens: { getActiveGithubToken: () => null },
    projects: { createProjectPath: () => ({ outcome: 'created' }) },
    models: {} as AgentDependencies['models'],
    sessions: {
      getSessionById: () => null,
      getSessionByProviderSessionId: () => null,
      createAppSession: () => ({ sessionId: 'app-session-1' }),
    },
    // A registry stand-in: the runtime writes straight to the audience, which
    // is all the tests above this file's registration tests need.
    runs: {
      startRun: ((input: { connection: { send(data: string): void } | null }) => ({
        // The gateway writer's shape: a runtime that feature-detects it (codex)
        // hands it objects to serialize, as the real one expects.
        writer: { isWebSocketWriter: true, send: (data: unknown) => input.connection?.send(JSON.stringify(data)), getSessionId: () => null },
        events: [],
      })) as unknown as AgentDependencies['runs']['startRun'],
      completeRunIfCurrent: () => undefined,
      isProcessing: () => false,
      pendingAbort: () => null,
    },
    getRunner: (provider) => runners[provider] ?? unexpectedProviderCall,
    GithubClient: class {} as unknown as AgentDependencies['GithubClient'],
    ...overrides,
  };
}

async function withAgentServer(
  dependencies: AgentDependencies,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', createAgentRouter(dependencies));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('Agent route rejects missing project input before invoking provider dependencies', async () => {
  await withAgentServer(createDependencies(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Inspect this project', stream: false }),
    });
    const body = await response.json() as { error: string };

    assert.equal(response.status, 400);
    assert.equal(body.error, 'Either githubUrl or projectPath is required');
  });
});

test('Agent route validates API keys through the injected repository', async () => {
  const receivedKeys: string[] = [];
  await withAgentServer(createDependencies({
    platformMode: false,
    apiKeys: {
      validateApiKey: (apiKey) => {
        receivedKeys.push(apiKey);
        return undefined;
      },
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'invalid-key' },
      body: JSON.stringify({ projectPath: '/workspace/project', message: 'Run' }),
    });
    assert.equal(response.status, 401);
  });

  assert.deepEqual(receivedKeys, ['invalid-key']);
});

test('Agent route rejects GitHub lookalike hosts before cloning', async () => {
  await withAgentServer(createDependencies(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        githubUrl: 'https://github.com.evil.example/owner/repo',
        message: 'Run',
        stream: false,
      }),
    });
    const body = await response.json() as { error: string };

    assert.equal(response.status, 500);
    assert.equal(body.error, 'Invalid GitHub URL');
  });
});

test('GitHub cloning keeps credentials out of arguments and remote URL', async () => {
  const token = 'secret-token';
  let cloneArgs: readonly string[] = [];
  let cloneEnvironment: NodeJS.ProcessEnv | undefined;
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  await withAgentServer(createDependencies({
    fileSystem: {
      access: async () => { throw new Error('missing'); },
      mkdir: async () => undefined,
    } as unknown as AgentDependencies['fileSystem'],
    githubTokens: { getActiveGithubToken: () => token },
    spawnProcess: ((_command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      cloneArgs = args;
      cloneEnvironment = options.env;
      process.nextTick(() => child.emit('error', new Error('expected test failure')));
      return child;
    }) as unknown as AgentDependencies['spawnProcess'],
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        githubUrl: 'https://github.com/owner/repo.git',
        message: 'Run',
        stream: false,
      }),
    });
    assert.equal(response.status, 500);
  });

  assert.deepEqual(cloneArgs.slice(0, 5), [
    'clone', '--depth', '1', '--', 'https://github.com/owner/repo.git',
  ]);
  assert.equal(cloneArgs.length, 6);
  assert.equal(cloneArgs.join(' ').includes(token), false);
  assert.equal(cloneEnvironment?.CLOUDCLI_GITHUB_TOKEN, token);
  assert.equal(cloneEnvironment?.GIT_CONFIG_KEY_0, 'credential.helper');
  assert.equal(cloneEnvironment?.GIT_CONFIG_VALUE_0, '');
  assert.equal(cloneEnvironment?.GIT_CONFIG_KEY_1, 'credential.https://github.com.helper');
});

test('Agent route reuses a matching checkout without cloning or deleting it', async () => {
  const spawnedArguments: string[][] = [];
  const removedPaths: string[] = [];
  const spawnProcess = ((_command: string, args: readonly string[]) => {
    spawnedArguments.push([...args]);
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      child.stdout.end('https://github.com/owner/repo.git\n');
      child.emit('close', 0);
    });
    return child;
  }) as unknown as AgentDependencies['spawnProcess'];

  await withAgentServer(createDependencies({
    fileSystem: {
      access: async () => undefined,
      rm: async (targetPath: string) => { removedPaths.push(targetPath); },
    } as unknown as AgentDependencies['fileSystem'],
    spawnProcess,
    models: {
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'default-model' }),
    } as unknown as AgentDependencies['models'],
    runners: { claude: async () => undefined },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        githubUrl: 'https://github.com/owner/repo.git',
        projectPath: '/home/test/.claude/external-projects/existing',
        message: 'Run',
        stream: false,
        cleanup: true,
      }),
    });
    assert.equal(response.status, 200);
  });

  assert.deepEqual(spawnedArguments, [['config', '--get', 'remote.origin.url']]);
  assert.deepEqual(removedPaths, []);
});

test('Agent route starts opencode on the catalog default when the request names no model', async () => {
  const opencodeCalls: { model?: string }[] = [];

  await withAgentServer(createDependencies({
    fileSystem: {
      access: async () => undefined,
    } as unknown as AgentDependencies['fileSystem'],
    models: {
      getProviderModels: async (provider: string) => ({ OPTIONS: [], DEFAULT: `${provider}-catalog-default` }),
    } as unknown as AgentDependencies['models'],
    runners: {
      opencode: (async (_prompt: string, options: { model?: string }) => {
        opencodeCalls.push(options);
      }) as unknown as AgentRunFunction,
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/home/test/project',
        message: 'Run',
        provider: 'opencode',
        stream: false,
      }),
    });
    assert.equal(response.status, 200);
  });

  assert.deepEqual(opencodeCalls.map((call) => call.model), ['opencode-catalog-default']);
});

test('Agent route starts codex on the catalog default when the request names no model', async () => {
  const codexCalls: { model?: string }[] = [];

  await withAgentServer(createDependencies({
    fileSystem: {
      access: async () => undefined,
    } as unknown as AgentDependencies['fileSystem'],
    models: {
      // `getProviderModels` resolves to a `ProviderModelsDefinition` - `OPTIONS`
      // and `DEFAULT`, with nothing wrapped around it.
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'catalog-default' }),
    } as unknown as AgentDependencies['models'],
    runners: {
      codex: (async (_prompt: string, options: { model?: string }) => {
        codexCalls.push(options);
      }) as unknown as AgentRunFunction,
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/home/test/project',
        message: 'Run',
        provider: 'codex',
        stream: false,
      }),
    });
    assert.equal(response.status, 200);
  });

  assert.deepEqual(codexCalls.map((call) => call.model), ['catalog-default']);
});

/**
 * Runs one Agent request with no `model` against stub catalogs and returns the
 * model each provider runtime was started with, plus the catalogs read.
 */
async function runWithoutModel(
  provider: 'claude' | 'cursor',
  catalogs: Record<string, { OPTIONS: { value: string; isCustom?: boolean }[]; DEFAULT: string; CUSTOM_MODELS_ONLY?: boolean }>,
  requestedModel?: string,
): Promise<{ models: (string | undefined)[]; catalogReads: string[] }> {
  const models: (string | undefined)[] = [];
  const catalogReads: string[] = [];
  const recordModel = (async (_prompt: string, options: { model?: string }) => {
    models.push(options.model);
  }) as unknown as AgentRunFunction;

  await withAgentServer(createDependencies({
    fileSystem: {
      access: async () => undefined,
    } as unknown as AgentDependencies['fileSystem'],
    models: {
      getProviderModels: async (catalogProvider: string) => {
        catalogReads.push(catalogProvider);
        return catalogs[catalogProvider];
      },
    } as unknown as AgentDependencies['models'],
    runners: { claude: recordModel, cursor: recordModel },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/home/test/project',
        message: 'Run',
        provider,
        stream: false,
        ...(requestedModel ? { model: requestedModel } : {}),
      }),
    });
    assert.equal(response.status, 200);
  });

  return { models, catalogReads };
}

test('Agent route starts Claude and Cursor on the first custom model while only custom models are listed', async () => {
  // What the Providers service returns with "Use only my models" on.
  const customOnly = (value: string) => ({
    OPTIONS: [{ value, isCustom: true }, { value: `${value}-mini`, isCustom: true }],
    DEFAULT: value,
    CUSTOM_MODELS_ONLY: true,
  });
  const catalogs = { claude: customOnly('gateway/claude'), cursor: customOnly('gateway/cursor') };

  assert.deepEqual(await runWithoutModel('claude', catalogs), {
    models: ['gateway/claude'],
    catalogReads: ['claude'],
  });
  assert.deepEqual(await runWithoutModel('cursor', catalogs), {
    models: ['gateway/cursor'],
    catalogReads: ['cursor'],
  });
  // A model named in the request still wins.
  assert.deepEqual((await runWithoutModel('claude', catalogs, 'opus')).models, ['opus']);
  assert.deepEqual((await runWithoutModel('cursor', catalogs, 'gpt-5')).models, ['gpt-5']);
});

test('Agent route starts Claude on its built-in default and leaves Cursor to its CLI while built-in models are listed', async () => {
  const catalogs = {
    claude: {
      OPTIONS: [{ value: 'default', isCustom: false }, { value: 'gateway/claude', isCustom: true }],
      DEFAULT: 'default',
      CUSTOM_MODELS_ONLY: false,
    },
    cursor: {
      OPTIONS: [{ value: 'auto', isCustom: false }, { value: 'gateway/cursor', isCustom: true }],
      DEFAULT: 'auto',
      CUSTOM_MODELS_ONLY: false,
    },
  };

  // Claude's built-in DEFAULT is what its runtime falls back to anyway.
  assert.deepEqual((await runWithoutModel('claude', catalogs)).models, ['default']);
  // Cursor leaves the choice to its CLI, as before.
  assert.deepEqual((await runWithoutModel('cursor', catalogs)).models, [undefined]);

  // The flag on with no custom models lists the built-ins, so Cursor still
  // leaves the choice to its CLI.
  const flagWithoutCustomModels = {
    ...catalogs,
    cursor: { OPTIONS: [{ value: 'auto', isCustom: false }], DEFAULT: 'auto', CUSTOM_MODELS_ONLY: true },
  };
  assert.deepEqual((await runWithoutModel('cursor', flagWithoutCustomModels)).models, [undefined]);
});

test('Agent route reads no model catalog for a continued session of an unregistered provider', async () => {
  // A legacy row (e.g. 'gemini', removed in #964) has no catalog: the
  // Providers service throws "Unsupported provider" for it. Continuing such a
  // session runs no provider runtime, as before, instead of failing on the
  // catalog read.
  const catalogReads: string[] = [];

  await withAgentServer(createDependencies({
    fileSystem: {
      access: async () => undefined,
    } as unknown as AgentDependencies['fileSystem'],
    models: {
      getProviderModels: async (catalogProvider: string) => {
        catalogReads.push(catalogProvider);
        throw new Error(`Unsupported provider "${catalogProvider}"`);
      },
    } as unknown as AgentDependencies['models'],
    sessions: {
      getSessionById: () => ({
        session_id: 'legacy-session',
        provider: 'gemini',
        provider_session_id: null,
        project_path: '/home/test/project',
      }),
      getSessionByProviderSessionId: () => null,
      createAppSession: () => { throw new Error('a continued session must not create a row'); },
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/home/test/project',
        message: 'Run',
        sessionId: 'legacy-session',
        stream: false,
      }),
    });
    assert.equal(response.status, 200);
  });

  assert.deepEqual(catalogReads, []);
});

/**
 * Runs one Agent request with the given extra body fields and returns the
 * options each provider runtime was started with.
 */
async function runWithBody(
  provider: 'claude' | 'codex' | 'opencode' | 'agy',
  body: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const calls: Record<string, unknown>[] = [];
  const recordOptions = (async (_prompt: string, options: Record<string, unknown>) => {
    calls.push(options);
  }) as unknown as AgentRunFunction;

  await withAgentServer(createDependencies({
    fileSystem: {
      access: async () => undefined,
    } as unknown as AgentDependencies['fileSystem'],
    models: {
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'catalog-default' }),
    } as unknown as AgentDependencies['models'],
    runners: { claude: recordOptions, codex: recordOptions, opencode: recordOptions, agy: recordOptions },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/home/test/project',
        message: 'Run',
        provider,
        stream: false,
        ...body,
      }),
    });
    assert.equal(response.status, 200);
  });

  return calls;
}

test('Agent route passes the ultracode switch to Claude as a boolean', async () => {
  const ultracodeFor = async (body: Record<string, unknown>) => (await runWithBody('claude', body)).map((call) => call.ultracode);

  assert.deepEqual(await ultracodeFor({ effort: 'low', ultracode: true }), [true]);
  assert.deepEqual(await ultracodeFor({ ultracode: false }), [false]);
  // curl sends form-ish strings, as for stream and cleanup.
  assert.deepEqual(await ultracodeFor({ ultracode: 'true' }), [true]);
  assert.deepEqual(await ultracodeFor({ ultracode: 'false' }), [false]);
  // No choice, or a value that is not one, leaves Claude Code's settings in charge.
  assert.deepEqual(await ultracodeFor({}), [undefined]);
  assert.deepEqual(await ultracodeFor({ ultracode: 'yes' }), [undefined]);
  assert.deepEqual(await ultracodeFor({ ultracode: 1 }), [undefined]);

  // The legacy effort token reaches the runtime untouched; it splits it there.
  const [legacyCall] = await runWithBody('claude', { effort: 'ultracode' });
  assert.equal(legacyCall.effort, 'ultracode');
  assert.equal(legacyCall.ultracode, undefined);
});

test('Agent route does not pass ultracode to Codex, OpenCode or Antigravity', async () => {
  for (const provider of ['codex', 'opencode', 'agy'] as const) {
    const [call] = await runWithBody(provider, { effort: 'high', ultracode: true });
    assert.equal(call.effort, 'high');
    assert.equal('ultracode' in call, false, `${provider} must not receive ultracode`);
  }
});

test('Agent route runs Antigravity non-interactively on the catalog default', async () => {
  const [call] = await runWithBody('agy', { effort: 'high' });

  assert.equal(call.model, 'catalog-default');
  assert.equal(call.effort, 'high');
  assert.equal(call.permissionMode, 'bypassPermissions');
  assert.equal(call.cwd, '/home/test/project');
  assert.equal(call.sessionId, 'app-session-1');
});

test('Agent route continues an Antigravity session found by the sync through its runner', async () => {
  const calls: Array<{ provider: LLMProvider; options: Record<string, unknown> }> = [];
  const catalogReads: string[] = [];
  const requestedRunners: LLMProvider[] = [];

  await withAgentServer(createDependencies({
    fileSystem: {
      access: async () => undefined,
    } as unknown as AgentDependencies['fileSystem'],
    models: {
      getProviderModels: async (provider: string) => {
        catalogReads.push(provider);
        return { OPTIONS: [], DEFAULT: 'auto' };
      },
    } as unknown as AgentDependencies['models'],
    sessions: {
      getSessionById: () => null,
      // An id the caller kept from agy itself resolves to the indexed row.
      getSessionByProviderSessionId: () => ({
        session_id: 'agy-app-session',
        provider: 'agy',
        provider_session_id: '3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b',
        project_path: '/home/test/project',
      }),
      createAppSession: () => { throw new Error('a continued session must not create a row'); },
    },
    getRunner: (provider) => {
      requestedRunners.push(provider);
      return (async (_prompt: string, options: Record<string, unknown>) => {
        calls.push({ provider, options });
      }) as unknown as AgentRunFunction;
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/home/test/project',
        message: 'Continue',
        sessionId: '3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b',
        stream: false,
      }),
    });
    assert.equal(response.status, 200);
  });

  assert.deepEqual(requestedRunners, ['agy']);
  assert.deepEqual(catalogReads, ['agy']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.sessionId, 'agy-app-session');
  assert.equal(calls[0].options.model, 'auto');
});

test('Agent route names agy among the providers it accepts when refusing an unknown one', async () => {
  await withAgentServer(createDependencies(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: '/home/test/project', message: 'Run', provider: 'gemini', stream: false }),
    });
    const body = await response.json() as { error: string };

    assert.equal(response.status, 400);
    assert.match(body.error, /"agy"/);
  });
});
