import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { setNotificationRunLookup } from '@/modules/notifications/index.js';
import { cursorRuntime } from '@/modules/providers/list/cursor/cursor-runtime.provider.js';
import { withRunNotificationCapture } from '@/modules/providers/tests/fixtures/run-notifications.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { ProviderRuntimeContext } from '@/shared/types.js';

/**
 * The Cursor runtime runs against a fake `cursor-agent` placed at the front of
 * PATH, so the real CLI is never run. The fake prints one stream-json `result`
 * line and exits 0. A prompt containing `fail` makes it exit 1 without a
 * result; one containing `linger` keeps it running after the result line
 * until FAKE_CURSOR_GATE_FILE exists (10 s at most).
 */
const FAKE_CURSOR_AGENT_SCRIPT = `
const fs = require('node:fs');
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
if (prompt.includes('fail')) {
  process.stderr.write('Cursor failed\\n');
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
  const gateFile = process.env.FAKE_CURSOR_GATE_FILE;
  if (prompt.includes('linger') && gateFile) {
    const lingerStartedAt = Date.now();
    const timer = setInterval(() => {
      if (fs.existsSync(gateFile) || Date.now() - lingerStartedAt > 10000) {
        clearInterval(timer);
      }
    }, 10);
  }
}
`;

type FakeCursorAgent = {
  /** Working directory for the runs. */
  projectDir: string;
  /** Created by a test to let a lingering fake exit. */
  gateFile: string;
};

const findEnvKey = (name: string) =>
  Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase()) || name;

async function withFakeCursorAgent(run: (fake: FakeCursorAgent) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-runtime-'));
  const binDir = path.join(root, 'bin');
  const scriptPath = path.join(root, 'cursor-agent.js');
  const fake: FakeCursorAgent = { projectDir: root, gateFile: path.join(root, 'gate') };
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const savedEnv = [pathKey, pathExtKey, 'FAKE_CURSOR_GATE_FILE'].map((key) => [key, process.env[key]] as const);

  try {
    await mkdir(binDir);
    await writeFile(scriptPath, FAKE_CURSOR_AGENT_SCRIPT, 'utf8');
    if (process.platform === 'win32') {
      await writeFile(path.join(binDir, 'cursor-agent.cmd'), `@echo off\r\nnode "${scriptPath}" %*\r\n`, 'utf8');
      const previousPathExt = process.env[pathExtKey];
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    } else {
      const commandPath = path.join(binDir, 'cursor-agent');
      await writeFile(commandPath, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`, 'utf8');
      await chmod(commandPath, 0o755);
    }
    process.env[pathKey] = `${binDir}${path.delimiter}${process.env[pathKey] || ''}`;
    process.env.FAKE_CURSOR_GATE_FILE = fake.gateFile;

    await run(fake);
  } finally {
    // Lets a fake that still lingers exit.
    await writeFile(fake.gateFile, '').catch(() => undefined);
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}

const context: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
};

/** A writer that names its run by `runStartedAt`, as the chat gateway's writer does. */
const writerOf = (userId: number, runStartedAt: number) => ({
  userId,
  runStartedAt,
  isWebSocketWriter: true,
  send: () => undefined,
  setSessionId: () => undefined,
});

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

test('Cursor names the run it reports stopped, so two runs ending inside the dedupe window both notify', async () => {
  await withFakeCursorAgent(async ({ projectDir }) => {
    await withRunNotificationCapture(async ({ userId, delivered }) => {
      const options = { sessionId: 'cursor-stopped', cwd: projectDir };
      await cursorRuntime.run('hello', options, writerOf(userId, 1_000), context);
      await cursorRuntime.run('hello again', options, writerOf(userId, 2_000), context);

      assert.deepEqual(delivered(), ['run.stopped@cursor-stopped', 'run.stopped@cursor-stopped']);
    });
  });
});

test('Cursor names the run it reports failed', async () => {
  await withFakeCursorAgent(async ({ projectDir }) => {
    await withRunNotificationCapture(async ({ userId, delivered }) => {
      const options = { sessionId: 'cursor-failed', cwd: projectDir };
      for (const runStartedAt of [1_000, 2_000]) {
        await assert.rejects(cursorRuntime.run('fail please', options, writerOf(userId, runStartedAt), context), /exited with code 1/);
      }

      assert.deepEqual(delivered(), ['run.failed@cursor-failed', 'run.failed@cursor-failed']);
    });
  });
});

test('a Cursor run whose process closes after the session\'s next run started is notified, and so is that next run', async () => {
  await withFakeCursorAgent(async ({ projectDir, gateFile }) => {
    await withRunNotificationCapture(async ({ userId, delivered }) => {
      setNotificationRunLookup((sessionId) => chatRunRegistry.getRun(sessionId));
      try {
        const options = { sessionId: 'cursor-late', cwd: projectDir };
        const startRun = () => chatRunRegistry.startRun({ appSessionId: 'cursor-late', provider: 'cursor', providerSessionId: null, connection: null, userId });

        const first = startRun();
        assert.ok(first);
        const firstTurn = cursorRuntime.run('linger', options, first.writer, context);
        // The `result` line ends the run while the process keeps running.
        await waitFor(() => first.status === 'completed', 'the first run\'s result line');
        const second = startRun();
        assert.ok(second, 'the first run has ended');
        assert.notEqual(second.startedAt, first.startedAt);
        assert.deepEqual(delivered(), [], 'nothing is reported before the process closes');

        await writeFile(gateFile, '');
        await firstTurn;
        await cursorRuntime.run('hello', options, second.writer, context);

        assert.deepEqual(delivered(), ['run.stopped@cursor-late', 'run.stopped@cursor-late']);
      } finally {
        setNotificationRunLookup(() => null);
        chatRunRegistry.clearAll();
      }
    });
  });
});
