import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AgyProviderAuth } from '@/modules/providers/list/agy/agy-auth.provider.js';

/**
 * agy status is read without running agy: the binary resolves (a fake one,
 * via AGY_CLI_PATH) and the OAuth token file exists in a throwaway HOME.
 */

const FAKE_AGY = fileURLToPath(new URL('./fixtures/agy/fake-agy.mjs', import.meta.url));

async function withAgyHome(
  run: (tokenPath: string) => Promise<void>,
  { installed, signedIn }: { installed: boolean; signedIn: boolean },
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-auth-'));
  const savedEnv = ['HOME', 'PATH', 'AGY_CLI_PATH', 'AGY_DATA_DIRS'].map((key) => [key, process.env[key]] as const);
  const tokenPath = path.join(root, 'home', '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  await mkdir(path.dirname(tokenPath), { recursive: true });
  if (signedIn) {
    await writeFile(tokenPath, 'placeholder');
  }

  process.env.HOME = path.join(root, 'home');
  process.env.AGY_CLI_PATH = installed ? FAKE_AGY : path.join(root, 'not-installed', 'agy');
  process.env.AGY_DATA_DIRS = path.join(root, 'data');
  try {
    await run(tokenPath);
  } finally {
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await chmod(tokenPath, 0o600).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

test('agy installed and signed in', async () => {
  await withAgyHome(async () => {
    assert.deepEqual(await new AgyProviderAuth().getStatus(), {
      installed: true,
      provider: 'agy',
      authenticated: true,
      email: null,
      method: 'oauth',
      error: undefined,
    });
  }, { installed: true, signedIn: true });
});

test('agy installed but never signed in points at a terminal sign-in', async () => {
  await withAgyHome(async () => {
    const status = await new AgyProviderAuth().getStatus();
    assert.equal(status.installed, true);
    assert.equal(status.authenticated, false);
    assert.equal(status.method, null);
    assert.match(String(status.error), /Run `agy` once in a terminal/);
  }, { installed: true, signedIn: false });
});

const NOT_INSTALLED_STATUS = {
  installed: false,
  provider: 'agy',
  authenticated: false,
  email: null,
  method: null,
  error: 'Antigravity CLI (agy) is not installed',
};

test('agy not installed is reported as data, not thrown', async () => {
  await withAgyHome(async () => {
    assert.deepEqual(await new AgyProviderAuth().getStatus(), NOT_INSTALLED_STATUS);
  }, { installed: false, signedIn: false });
});

test('a token left behind without an installed agy is not a sign-in', async () => {
  // AGY_CLI_PATH names a binary that is gone (agy uninstalled after signing in).
  await withAgyHome(async () => {
    assert.deepEqual(await new AgyProviderAuth().getStatus(), NOT_INSTALLED_STATUS);
  }, { installed: false, signedIn: true });
});

test('a token from an agy outside the lookup path is not a sign-in', async () => {
  // Signed in with a stray binary (~/.gemini/bin/agy) that neither PATH nor
  // ~/.local/bin provides, so agy does not count as installed.
  await withAgyHome(async () => {
    const home = String(process.env.HOME);
    const strayBinary = path.join(home, '.gemini', 'bin', 'agy');
    await mkdir(path.dirname(strayBinary), { recursive: true });
    await copyFile(FAKE_AGY, strayBinary);
    await chmod(strayBinary, 0o755);
    const emptyPathDirectory = path.join(home, 'empty-path');
    await mkdir(emptyPathDirectory);
    delete process.env.AGY_CLI_PATH;
    process.env.PATH = emptyPathDirectory;

    assert.deepEqual(await new AgyProviderAuth().getStatus(), NOT_INSTALLED_STATUS);
  }, { installed: false, signedIn: true });
});

test('sign-in is judged by the token file existing; its contents are never read', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root reads unreadable files');
    return;
  }
  await withAgyHome(async (tokenPath) => {
    await chmod(tokenPath, 0o000);
    const status = await new AgyProviderAuth().getStatus();
    assert.equal(status.authenticated, true);
  }, { installed: true, signedIn: true });
});
