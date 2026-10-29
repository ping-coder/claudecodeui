import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createClientDiagnosticsService } from '../client-diagnostics.service.js';
import { createSystemModule } from '../system.module.js';
import { createSystemRouter } from '../system.routes.js';
import type { createSystemUpdateService } from '../system.service.js';

/**
 * POST /api/system/client-diagnostics as the browser reaches it: behind the token check (stood in
 * for here by a middleware that sets the user), one report per request, the status the service
 * decides, and the User-Agent read from the request rather than the body.
 */

const REPORT = {
  event: 'fullscreen',
  source: 'codeEditor',
  outcome: 'whole',
  elapsedMs: 120,
  displayModeBefore: 'browser',
  displayModeAfter: 'fullscreen',
  standalone: false,
  inIframe: false,
  secure: true,
  focused: true,
  userActivation: true,
  keyboardLock: 'requested',
  outer: [1512, 945],
  inner: [1512, 945],
  screen: [1512, 982],
  avail: [1512, 944],
  position: [0, 0],
  dpr: 2,
  platform: 'macOS',
};

const unusedUpdateService = {
  updateSystem: async () => {
    throw new Error('not used');
  },
} as unknown as ReturnType<typeof createSystemUpdateService>;

/** Serves the router at /api/system with the signed-in user set, as authenticateToken leaves it. */
const serve = async (router: express.Router) => {
  const app = express();
  app.use(express.json());
  app.use('/api/system', (request, _response, next) => {
    (request as express.Request & { user?: { id: number } }).user = { id: 7 };
    next();
  }, router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    post: (body: unknown, userAgent = 'Mozilla/5.0 (Macintosh) Chrome/156') => fetch(`http://127.0.0.1:${port}/api/system/client-diagnostics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': userAgent },
      body: JSON.stringify(body),
    }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

test('a report is logged as one line for the signed-in user, with the request\'s own User-Agent', async () => {
  const lines: string[] = [];
  const service = createClientDiagnosticsService({ logInfo: (line) => lines.push(line), now: () => 0, environment: 'staging' });
  const server = await serve(createSystemRouter(unusedUpdateService, service));
  try {
    const response = await server.post({ ...REPORT, ua: 'forged', userId: 99 }, 'RealAgent/1.0');
    assert.equal(response.status, 204);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].startsWith('[client-diag] fullscreen env=staging user=7 outcome=whole source=codeEditor '), true);
    assert.equal(lines[0].endsWith(' ua="RealAgent/1.0"'), true);
    assert.equal(lines[0].includes('forged'), false);
  } finally {
    await server.close();
  }
});

test('a bad report gets 400 and a report over the limit 429, each with a JSON error', async () => {
  const lines: string[] = [];
  const service = createClientDiagnosticsService({ logInfo: (line) => lines.push(line), now: () => 0, environment: 'staging' });
  const server = await serve(createSystemRouter(unusedUpdateService, service));
  try {
    const bad = await server.post({ ...REPORT, outcome: 'maybe' });
    assert.equal(bad.status, 400);
    const badBody = await bad.json() as { success: boolean; error: { code: string } };
    assert.equal(badBody.success, false);
    assert.equal(badBody.error.code, 'INVALID_DIAGNOSTICS');
    assert.equal(lines.length, 0);

    for (let index = 0; index < 20; index += 1) {
      assert.equal((await server.post(REPORT)).status, 204);
    }
    const limited = await server.post(REPORT);
    assert.equal(limited.status, 429);
    const limitedBody = await limited.json() as { error: { code: string } };
    assert.equal(limitedBody.error.code, 'RATE_LIMITED');
  } finally {
    await server.close();
  }
});

test('the system module logs the deployment named by CLOUDCLI_DEPLOY_ENV, production when unset', async (context) => {
  const logged: string[] = [];
  context.mock.method(console, 'log', (line: unknown) => {
    logged.push(String(line));
  });
  const previous = process.env.CLOUDCLI_DEPLOY_ENV;
  const environmentOf = async (value: string | undefined) => {
    if (value === undefined) {
      delete process.env.CLOUDCLI_DEPLOY_ENV;
    } else {
      process.env.CLOUDCLI_DEPLOY_ENV = value;
    }
    const server = await serve(createSystemModule({ appRoot: '/app/cloudcli', installMode: 'git', isPlatform: false }));
    try {
      assert.equal((await server.post(REPORT)).status, 204);
    } finally {
      await server.close();
    }
    return logged.at(-1)?.split(' ')[2];
  };
  try {
    assert.equal(await environmentOf('staging'), 'env=staging');
    assert.equal(await environmentOf(undefined), 'env=production');
    assert.equal(await environmentOf('prod'), 'env=production');
  } finally {
    if (previous === undefined) {
      delete process.env.CLOUDCLI_DEPLOY_ENV;
    } else {
      process.env.CLOUDCLI_DEPLOY_ENV = previous;
    }
  }
});
