import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: string[];
    send: (data: string) => void;
  };
  socket.readyState = WebSocket.OPEN;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(data);
  return socket;
}

function createFakePty() {
  let dataListener: ((data: string) => void) | null = null;
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;

  return {
    killed: false,
    onData(listener: (data: string) => void) {
      dataListener = listener;
      return { dispose: () => undefined };
    },
    onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
      exitListener = listener;
      return { dispose: () => undefined };
    },
    emitData(data: string) {
      dataListener?.(data);
    },
    emitExit() {
      exitListener?.({ exitCode: 0 });
    },
    write() {},
    resize() {},
    kill() {
      this.killed = true;
    },
  };
}

test('a stale socket close cannot detach the socket that replaced it', () => {
  const pty = createFakePty();
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: () => pty as never,
  };
  const initMessage = JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId: `stale-close-${Date.now()}`,
    hasSession: false,
    provider: 'plain-shell',
    isPlainShell: true,
    initialCommand: 'test-command',
  });

  const firstSocket = createFakeSocket();
  handleShellConnection(firstSocket as never, dependencies);
  firstSocket.emit('message', initMessage);

  const replacementSocket = createFakeSocket();
  handleShellConnection(replacementSocket as never, dependencies);
  replacementSocket.emit('message', initMessage);
  replacementSocket.frames.length = 0;

  // This ordering reproduces a delayed close from a backgrounded mobile tab.
  firstSocket.emit('close');
  pty.emitData('output-after-stale-close');

  assert.equal(pty.killed, false);
  assert.equal(replacementSocket.frames.length, 1);
  assert.match(replacementSocket.frames[0], /output-after-stale-close/);

  pty.emitExit();
});

test('shell output detects and normalizes a wrapped authentication URL', () => {
  const pty = createFakePty();
  const socket = createFakeSocket();
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: () => pty as never,
  };

  handleShellConnection(socket as never, dependencies);
  socket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `wrapped-url-${Date.now()}`,
      hasSession: false,
      provider: 'plain-shell',
      isPlainShell: true,
      initialCommand: 'test-command',
    })
  );
  socket.frames.length = 0;

  pty.emitData("Continue in your browser: https://example.com/authorize?\ncode=abc\x1b[0m");

  const frames = socket.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  const authenticationFrame = frames.find((frame) => frame.type === 'auth_url');
  assert.deepEqual(authenticationFrame, {
    type: 'auth_url',
    url: 'https://example.com/authorize?code=abc',
    autoOpen: false,
  });

  pty.emitExit();
});

test('bypassPermissions launches claude with --dangerously-skip-permissions', () => {
  const spawnedCommands: string[] = [];
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: (_shell: string, args: string | string[]) => {
      spawnedCommands.push(Array.isArray(args) ? args[args.length - 1] : args);
      return createFakePty() as never;
    },
  };

  const bypassSocket = createFakeSocket();
  handleShellConnection(bypassSocket as never, dependencies);
  bypassSocket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `bypass-on-${Date.now()}`,
      hasSession: false,
      provider: 'claude',
      bypassPermissions: true,
    })
  );

  const defaultSocket = createFakeSocket();
  handleShellConnection(defaultSocket as never, dependencies);
  defaultSocket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `bypass-off-${Date.now()}`,
      hasSession: false,
      provider: 'claude',
    })
  );

  assert.deepEqual(spawnedCommands, ['claude --dangerously-skip-permissions', 'claude']);
});

test('bypassPermissions carries through to resumed claude sessions', () => {
  const spawnedCommands: string[] = [];
  const dependencies = {
    resolveProviderSessionId: () => 'resumed-session-id',
    spawnPty: (_shell: string, args: string | string[]) => {
      spawnedCommands.push(Array.isArray(args) ? args[args.length - 1] : args);
      return createFakePty() as never;
    },
  };

  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  socket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `bypass-resume-${Date.now()}`,
      hasSession: true,
      provider: 'claude',
      bypassPermissions: true,
    })
  );

  assert.equal(spawnedCommands.length, 1);
  if (os.platform() !== 'win32') {
    assert.equal(
      spawnedCommands[0],
      'claude --resume "resumed-session-id" --dangerously-skip-permissions || claude --dangerously-skip-permissions'
    );
  }
});

test('a missing project directory is reported as an error frame and starts no pty', () => {
  const socket = createFakeSocket();
  let spawnCount = 0;
  const dependencies = {
    resolveProviderSessionId: () => null,
    spawnPty: () => {
      spawnCount += 1;
      return createFakePty() as never;
    },
  };

  handleShellConnection(socket as never, dependencies);
  socket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      // A project row survives its directory being deleted or unmounted, so
      // this is what the Shell tab sends for a stale sidebar entry.
      projectPath: path.join(os.tmpdir(), `shell-missing-${Date.now()}`),
      sessionId: `missing-path-${Date.now()}`,
      hasSession: false,
      provider: 'plain-shell',
      isPlainShell: true,
    })
  );

  assert.equal(spawnCount, 0);
  assert.deepEqual(
    socket.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>),
    [{ type: 'error', message: 'Invalid project path' }]
  );
});

type SpawnCall = { shell: string; args: string[]; command: string; env: Record<string, string | undefined> };

function spawnRecorder(resumeSessionId: string | null = null) {
  const calls: SpawnCall[] = [];
  const dependencies = {
    resolveProviderSessionId: () => resumeSessionId,
    spawnPty: (shell: string, args: string | string[], options?: { env?: Record<string, string | undefined> }) => {
      calls.push({
        shell,
        args: Array.isArray(args) ? args : [args],
        command: Array.isArray(args) ? args[args.length - 1] : args,
        env: options?.env ?? {},
      });
      return createFakePty() as never;
    },
  };
  return { calls, dependencies };
}

let launchCount = 0;

function launch(
  dependencies: ReturnType<typeof spawnRecorder>['dependencies'],
  init: Record<string, unknown>,
  projectPath = process.cwd()
) {
  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  launchCount += 1;
  socket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath,
      sessionId: `scheme-${launchCount}-${Date.now()}`,
      hasSession: false,
      ...init,
    })
  );
  return socket;
}

type ClaudeConfigFixture = {
  configHome: string;
  home: string;
  projectPath: string;
  write: (filePath: string, contents: unknown) => void;
};

/**
 * Runs `body` against a throwaway CLAUDE_CONFIG_DIR, HOME and project folder,
 * so the user's real Claude config and app data folder never leak into (or
 * out of) the tests. `homeName` names the HOME folder, to test awkward paths.
 */
function withClaudeConfig(body: (fixture: ClaudeConfigFixture) => void, homeName = 'home') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-claude-theme-'));
  const configHome = path.join(root, 'config');
  const home = path.join(root, homeName);
  const projectPath = path.join(root, 'project');
  fs.mkdirSync(configHome, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });
  const savedEnv = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.CLAUDE_CONFIG_DIR = configHome;
  // os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  const write = (filePath: string, contents: unknown) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, typeof contents === 'string' ? contents : JSON.stringify(contents));
  };

  try {
    body({ configHome, home, projectPath, write });
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// The server-owned settings file a light launch points `--settings` at. The
// default fixture HOME has no quote in it, so bash quoting is a plain wrap.
const themeSettingsPath = (theme: string) =>
  path.join(os.homedir(), '.cloudcli', `claude-shell-theme-${theme}.json`);
const themeFlag = (theme: string) => ` --settings '${themeSettingsPath(theme)}'`;

type AgyCliFixture = {
  root: string;
  home: string;
  /** The fake agy, or where it would be when `installed` is false. */
  agyPath: string;
  /** The only PATH entry while `body` runs; it is empty. */
  pathDirectory: string;
};

/**
 * Runs `body` with a fake agy at AGY_CLI_PATH, AGY_DATA_DIRS cleared, a
 * throwaway HOME and PATH reduced to an empty folder, so neither a real agy
 * nor the user's ~/.gemini can leak into a launch. `installed: false` unsets
 * AGY_CLI_PATH too, so the lookup finds no agy at all. The pty is stubbed, so
 * nothing runs the fake unless a test runs a launch line itself.
 */
function withAgyCli<T>(
  body: (fixture: AgyCliFixture) => T,
  { installed = true, agyFolderName = 'agy-bin' } = {},
): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-agy-'));
  const home = path.join(root, 'home');
  const pathDirectory = path.join(root, 'empty-path');
  const agyPath = path.join(root, agyFolderName, 'agy');
  fs.mkdirSync(home);
  fs.mkdirSync(pathDirectory);
  const savedEnv = {
    AGY_CLI_PATH: process.env.AGY_CLI_PATH,
    AGY_DATA_DIRS: process.env.AGY_DATA_DIRS,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PATH: process.env.PATH,
  };
  if (installed) {
    fs.mkdirSync(path.dirname(agyPath));
    fs.writeFileSync(agyPath, '');
    process.env.AGY_CLI_PATH = agyPath;
  } else {
    delete process.env.AGY_CLI_PATH;
  }
  delete process.env.AGY_DATA_DIRS;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PATH = pathDirectory;

  try {
    return body({ root, home, agyPath, pathDirectory });
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// The launch line of a fake agy in a folder whose name has no quote in it.
const agyLaunch = (agyPath: string) => `${os.platform() === 'win32' ? '& ' : ''}'${agyPath}'`;

// The flag outranks the user's own settings, so a dark Shell tab must not send
// one: it would turn a daltonized or ANSI theme back into the plain dark one.
test('a dark Shell tab launches claude exactly as before, whatever the user theme is', () => {
  withClaudeConfig(({ configHome, home, projectPath, write }) => {
    write(path.join(configHome, 'settings.json'), { theme: 'dark-daltonized' });
    const { calls, dependencies } = spawnRecorder('resumed-session-id');

    launch(dependencies, { provider: 'claude', colorScheme: 'dark' }, projectPath);
    launch(dependencies, { provider: 'claude', colorScheme: 'dark', bypassPermissions: true }, projectPath);
    launch(dependencies, { provider: 'claude', colorScheme: 'dark', hasSession: true }, projectPath);
    launch(dependencies, { provider: 'claude' }, projectPath);
    launch(dependencies, { provider: 'claude', colorScheme: 'sepia' }, projectPath);

    if (os.platform() !== 'win32') {
      assert.deepEqual(
        calls.map((call) => call.command),
        [
          'claude',
          'claude --dangerously-skip-permissions',
          'claude --resume "resumed-session-id" || claude',
          'claude',
          'claude',
        ]
      );
    }
    assert.equal(calls[0].env.COLORFGBG, '15;0');
    assert.equal(calls[3].env.COLORFGBG, process.env.COLORFGBG);
    assert.equal(calls[4].env.COLORFGBG, process.env.COLORFGBG);
    assert.equal(fs.existsSync(path.join(home, '.cloudcli')), false, 'a dark launch writes no file');
  });
});

// Claude Code defaults to its dark theme whatever the terminal looks like, so a
// light Shell tab showed dark prompt bands until the launch carried a light one.
test('a light Shell tab swaps a dark Claude theme for its light variant', () => {
  const cases: Array<[string | undefined, string]> = [
    [undefined, 'light'],
    ['dark', 'light'],
    ['dark-daltonized', 'light-daltonized'],
    ['dark-ansi', 'light-ansi'],
  ];

  for (const [userTheme, expectedTheme] of cases) {
    withClaudeConfig(({ configHome, projectPath, write }) => {
      if (userTheme) {
        write(path.join(configHome, 'settings.json'), { theme: userTheme, verbose: true });
      }
      const { calls, dependencies } = spawnRecorder();

      launch(dependencies, { provider: 'claude', colorScheme: 'light' }, projectPath);

      assert.equal(calls.length, 1);
      if (os.platform() !== 'win32') {
        assert.equal(calls[0].command, `claude${themeFlag(expectedTheme)}`, `user theme ${userTheme}`);
      }
      assert.deepEqual(JSON.parse(fs.readFileSync(themeSettingsPath(expectedTheme), 'utf8')), {
        theme: expectedTheme,
      });
      assert.equal(calls[0].env.COLORFGBG, '0;15');
    });
  }
});

test('a light Shell tab keeps a light, auto or custom theme the user chose', () => {
  for (const userTheme of ['light', 'light-daltonized', 'light-ansi', 'auto', 'custom:solarized']) {
    withClaudeConfig(({ configHome, projectPath, write }) => {
      write(path.join(configHome, 'settings.json'), { theme: userTheme });
      const { calls, dependencies } = spawnRecorder();

      launch(dependencies, { provider: 'claude', colorScheme: 'light' }, projectPath);

      assert.deepEqual(calls.map((call) => call.command), ['claude'], `user theme ${userTheme}`);
      assert.equal(calls[0].env.COLORFGBG, '0;15');
    });
  }
});

// Mirrors resolveSetting("theme") of Claude Code 2.1.280: local, project and user
// settings first, then the legacy `theme` key of the global config.
test('the Claude theme is read in the CLI order, including the legacy global config', () => {
  const lightLaunch = (projectPath: string) => {
    const { calls, dependencies } = spawnRecorder();
    launch(dependencies, { provider: 'claude', colorScheme: 'light' }, projectPath);
    return calls[0].command;
  };
  if (os.platform() === 'win32') {
    return;
  }

  withClaudeConfig(({ configHome, projectPath, write }) => {
    write(path.join(configHome, '.claude.json'), { theme: 'dark-daltonized' });
    assert.equal(lightLaunch(projectPath), `claude${themeFlag('light-daltonized')}`);

    write(path.join(configHome, 'settings.json'), { theme: 'sepia' });
    assert.equal(lightLaunch(projectPath), `claude${themeFlag('light-daltonized')}`, 'invalid value is unset');

    write(path.join(configHome, 'settings.json'), { theme: 'dark-ansi' });
    assert.equal(lightLaunch(projectPath), `claude${themeFlag('light-ansi')}`, 'settings beat legacy config');

    write(path.join(projectPath, '.claude', 'settings.json'), { theme: 'light' });
    assert.equal(lightLaunch(projectPath), 'claude', 'project settings beat user settings');

    write(path.join(projectPath, '.claude', 'settings.local.json'), { theme: 'dark-daltonized' });
    assert.equal(lightLaunch(projectPath), `claude${themeFlag('light-daltonized')}`, 'local beats project');
  });

  withClaudeConfig(({ configHome, projectPath, write }) => {
    write(path.join(configHome, '.claude.json'), { theme: 'dark-daltonized' });
    write(path.join(configHome, '.config.json'), { theme: 'dark-ansi' });
    assert.equal(lightLaunch(projectPath), `claude${themeFlag('light-ansi')}`, 'legacy .config.json wins');
  });

  // Without CLAUDE_CONFIG_DIR the CLI reads ~/.claude/settings.json and ~/.claude.json.
  withClaudeConfig(({ projectPath, write }) => {
    delete process.env.CLAUDE_CONFIG_DIR;
    const home = process.env.HOME as string;
    write(path.join(home, '.claude.json'), { theme: 'dark-ansi' });
    assert.equal(lightLaunch(projectPath), `claude${themeFlag('light-ansi')}`);

    write(path.join(home, '.claude', 'settings.json'), { theme: 'light-daltonized' });
    assert.equal(lightLaunch(projectPath), 'claude');
  });
});

test('an unreadable or unparsable Claude config counts as unset and never blocks the launch', () => {
  withClaudeConfig(({ configHome, projectPath, write }) => {
    // A directory where a file is expected fails to read with EISDIR.
    fs.mkdirSync(path.join(configHome, 'settings.json'));
    write(path.join(configHome, '.claude.json'), '{"theme": "dark-daltonized",');
    write(path.join(projectPath, '.claude', 'settings.local.json'), 'not json');
    write(path.join(projectPath, '.claude', 'settings.json'), '["dark-ansi"]');
    const { calls, dependencies } = spawnRecorder();

    const socket = launch(dependencies, { provider: 'claude', colorScheme: 'light' }, projectPath);

    assert.equal(calls.length, 1);
    if (os.platform() !== 'win32') {
      assert.equal(calls[0].command, `claude${themeFlag('light')}`);
    }
    const frames = socket.frames.map((frame) => JSON.parse(frame) as { type: string });
    assert.deepEqual(frames.map((frame) => frame.type), ['output', 'claude_theme']);
  });
});

// The project can be a cloned repository, and the repository decides what its
// `.claude/settings.local.json` is. Reading a symlink to a FIFO blocked the
// server until something wrote to it; one to /dev/zero exhausted its memory.
test('a Claude config that is not a regular file is skipped without being opened', (t) => {
  if (os.platform() === 'win32') {
    t.skip('needs mkfifo and /dev/null');
    return;
  }
  withClaudeConfig(({ configHome, projectPath }) => {
    const fifoPath = path.join(projectPath, 'settings.fifo');
    execFileSync('mkfifo', [fifoPath]);
    fs.mkdirSync(path.join(projectPath, '.claude'));
    fs.symlinkSync(fifoPath, path.join(projectPath, '.claude', 'settings.local.json'));
    fs.symlinkSync('/dev/null', path.join(projectPath, '.claude', 'settings.json'));
    fs.symlinkSync(os.tmpdir(), path.join(configHome, 'settings.json'));
    // A reader that opened the FIFO would get a dark-daltonized theme from this
    // writer (and so launch light-daltonized) instead of blocking forever. A
    // launch that skips it falls through to the default dark theme.
    const writer = spawn('sh', ['-c', `printf %s '{"theme":"dark-daltonized"}' > "$0"`, fifoPath], {
      stdio: 'ignore',
    });
    try {
      const { calls, dependencies } = spawnRecorder();
      const startedAt = Date.now();

      const socket = launch(dependencies, { provider: 'claude', colorScheme: 'light' }, projectPath);

      assert.ok(Date.now() - startedAt < 1000, 'the launch did not wait for the FIFO');
      assert.deepEqual(calls.map((call) => call.command), [`claude${themeFlag('light')}`]);
      const frames = socket.frames.map((frame) => JSON.parse(frame) as { type: string });
      assert.deepEqual(frames.map((frame) => frame.type), ['output', 'claude_theme']);
    } finally {
      writer.kill();
    }
  });
});

test('an oversized Claude config is skipped without being read', (t) => {
  withClaudeConfig(({ configHome, projectPath }) => {
    const settingsPath = path.join(configHome, 'settings.json');
    // The CLI refuses settings files over 2 MiB. A sparse tail takes the file
    // past that cap without using the disk.
    fs.writeFileSync(settingsPath, '{"theme":"dark-daltonized"}');
    fs.truncateSync(settingsPath, 2 * 1024 * 1024 + 1);
    const readFileSync = t.mock.method(fs, 'readFileSync');
    const { calls, dependencies } = spawnRecorder();

    launch(dependencies, { provider: 'claude', colorScheme: 'light' }, projectPath);

    const readPaths = readFileSync.mock.calls.map((call) => String(call.arguments[0]));
    assert.equal(readPaths.includes(settingsPath), false, 'the oversized file was read');
    assert.equal(calls.length, 1);
    if (os.platform() !== 'win32') {
      assert.equal(calls[0].command, `claude${themeFlag('light')}`);
    }
  });
});

test('the legacy global config may be bigger than a settings file', () => {
  withClaudeConfig(({ configHome, projectPath, write }) => {
    // `~/.claude.json` keeps per-project history and can grow to several MB.
    write(path.join(configHome, '.claude.json'), {
      theme: 'dark-daltonized',
      padding: 'x'.repeat(3 * 1024 * 1024),
    });
    const { calls, dependencies } = spawnRecorder();

    launch(dependencies, { provider: 'claude', colorScheme: 'light' }, projectPath);

    assert.equal(calls.length, 1);
    if (os.platform() !== 'win32') {
      assert.equal(calls[0].command, `claude${themeFlag('light-daltonized')}`);
    }
  });
});

test('the light theme rides along with bypass and resume launches', () => {
  withClaudeConfig(({ projectPath }) => {
    const { calls, dependencies } = spawnRecorder('resumed-session-id');

    launch(
      dependencies,
      { hasSession: true, provider: 'claude', bypassPermissions: true, colorScheme: 'light' },
      projectPath
    );

    assert.equal(calls.length, 1);
    if (os.platform() !== 'win32') {
      const flags = ` --dangerously-skip-permissions${themeFlag('light')}`;
      assert.equal(calls[0].command, `claude --resume "resumed-session-id"${flags} || claude${flags}`);
    }
  });
});

// The file lives in the app's own data folder: the user's Claude config and
// the project are only ever read.
test('the light theme settings file is written once to the app data folder', () => {
  withClaudeConfig(({ configHome, home, projectPath, write }) => {
    write(path.join(configHome, 'settings.json'), { theme: 'dark-daltonized' });
    const configBefore = fs.readdirSync(configHome).sort();
    const settingsPath = path.join(home, '.cloudcli', 'claude-shell-theme-light-daltonized.json');
    const { calls, dependencies } = spawnRecorder();

    launch(dependencies, { provider: 'claude', colorScheme: 'light' }, projectPath);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), '{"theme":"light-daltonized"}\n');

    // Unchanged contents are not rewritten.
    const past = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(settingsPath, past, past);
    launch(dependencies, { provider: 'claude', colorScheme: 'light' }, projectPath);
    assert.equal(fs.statSync(settingsPath).mtimeMs, past.getTime());

    // Stale contents are replaced.
    fs.writeFileSync(settingsPath, '{"theme":"dark"}');
    launch(dependencies, { provider: 'claude', colorScheme: 'light' }, projectPath);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), '{"theme":"light-daltonized"}\n');

    assert.equal(calls.length, 3);
    assert.deepEqual(fs.readdirSync(path.join(home, '.cloudcli')), ['claude-shell-theme-light-daltonized.json']);
    assert.deepEqual(fs.readdirSync(configHome).sort(), configBefore);
    assert.equal(fs.existsSync(path.join(projectPath, '.claude')), false);
  });
});

// Windows runs the command through `powershell.exe -Command`, which is why the
// theme travels as a file path: PowerShell strips the double quotes of inline
// JSON when it hands an argument to a native program.
test('the settings file path is quoted for bash and for PowerShell', (t) => {
  if (os.platform() === 'win32') {
    t.skip('asserts the bash launch and POSIX paths first');
    return;
  }
  withClaudeConfig(({ home, projectPath }) => {
    const settingsPath = path.join(home, '.cloudcli', 'claude-shell-theme-light.json');
    const { calls, dependencies } = spawnRecorder('resumed-session-id');

    launch(dependencies, { provider: 'claude', colorScheme: 'light' }, projectPath);
    launch(dependencies, { provider: 'claude', colorScheme: 'light', hasSession: true }, projectPath);
    t.mock.method(os, 'platform', () => 'win32');
    launch(dependencies, { provider: 'claude', colorScheme: 'light' }, projectPath);
    launch(dependencies, { provider: 'claude', colorScheme: 'light', hasSession: true }, projectPath);

    const bashFlag = ` --settings '${settingsPath.replace(/'/g, `'\\''`)}'`;
    const powerShellFlag = ` --settings '${settingsPath.replace(/['\u2019]/g, '$&$&')}'`;
    assert.ok(settingsPath.includes("it's a \u2019quoted\u2019 home"), settingsPath);
    assert.deepEqual(calls.map((call) => [call.shell, ...call.args]), [
      ['bash', '-c', `claude${bashFlag}`],
      ['bash', '-c', `claude --resume "resumed-session-id"${bashFlag} || claude${bashFlag}`],
      ['powershell.exe', '-Command', `claude${powerShellFlag}`],
      [
        'powershell.exe',
        '-Command',
        `claude --resume "resumed-session-id"${powerShellFlag}; if ($LASTEXITCODE -ne 0) { claude${powerShellFlag} }`,
      ],
    ]);
    // Spelled out once, so the escaping above is not only checked against itself.
    assert.ok(calls[0].command.endsWith(`/it'\\''s a \u2019quoted\u2019 home/.cloudcli/claude-shell-theme-light.json'`));
    assert.ok(calls[2].command.endsWith(`/it''s a \u2019\u2019quoted\u2019\u2019 home/.cloudcli/claude-shell-theme-light.json'`));
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { theme: 'light' });
  }, "it's a \u2019quoted\u2019 home");
});

test('a settings file that cannot be written drops the flag, logs once and still launches', (t) => {
  withClaudeConfig(({ home, projectPath, write }) => {
    // A file where the app data folder should be makes every write fail.
    write(path.join(home, '.cloudcli'), 'not a folder');
    const warn = t.mock.method(console, 'warn', () => undefined);
    const { calls, dependencies } = spawnRecorder();

    const firstSocket = launch(dependencies, { provider: 'claude', colorScheme: 'light' }, projectPath);
    const secondSocket = launch(dependencies, { provider: 'claude', colorScheme: 'light' }, projectPath);

    assert.deepEqual(calls.map((call) => call.command), ['claude', 'claude']);
    assert.deepEqual(calls.map((call) => call.env.COLORFGBG), ['0;15', '0;15']);
    // The CLI paints its dark default in either app theme, so no restart hint.
    for (const socket of [firstSocket, secondSocket]) {
      const frames = socket.frames.map((frame) => JSON.parse(frame) as { type: string });
      assert.deepEqual(frames.map((frame) => frame.type), ['output']);
    }
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /Claude theme settings file/);
  });
});

// A running CLI keeps its launch-time colours. The client is told the theme the
// pty's claude was launched for, also when it reattaches later in another theme,
// so the Shell can suggest a restart when they differ.
test('claude launches report the app theme they started in, also on reattach', () => {
  withClaudeConfig(({ projectPath }) => {
    const { calls, dependencies } = spawnRecorder();
    const themeFrames = (socket: ReturnType<typeof createFakeSocket>) =>
      socket.frames
        .map((frame) => JSON.parse(frame) as Record<string, unknown>)
        .filter((frame) => frame.type === 'claude_theme');
    const sessionId = `claude-theme-${Date.now()}`;
    const attach = (colorScheme: string) => {
      const socket = createFakeSocket();
      handleShellConnection(socket as never, dependencies);
      socket.emit(
        'message',
        JSON.stringify({ type: 'init', projectPath, sessionId, hasSession: false, provider: 'claude', colorScheme })
      );
      return socket;
    };

    const firstSocket = attach('light');
    const reattachedSocket = attach('dark');

    assert.equal(calls.length, 1, 'the second init reattached to the running pty');
    assert.deepEqual(themeFrames(firstSocket), [{ type: 'claude_theme', colorScheme: 'light' }]);
    assert.deepEqual(themeFrames(reattachedSocket), [{ type: 'claude_theme', colorScheme: 'light' }]);

    const darkSocket = launch(dependencies, { provider: 'claude', colorScheme: 'dark' }, projectPath);
    assert.deepEqual(themeFrames(darkSocket), [{ type: 'claude_theme', colorScheme: 'dark' }]);

    const silentLaunches = [
      launch(dependencies, { provider: 'claude' }, projectPath),
      launch(dependencies, { provider: 'claude', initialCommand: 'claude /login', colorScheme: 'light' }, projectPath),
      launch(dependencies, { provider: 'codex', colorScheme: 'light' }, projectPath),
      withAgyCli(() => launch(dependencies, { provider: 'agy', colorScheme: 'light' }, projectPath)),
      launch(dependencies, { provider: 'plain-shell', isPlainShell: true, colorScheme: 'light' }, projectPath),
    ];
    assert.deepEqual(silentLaunches.map(themeFrames), [[], [], [], [], []]);
  });
});

// A restart only helps when the CLI's colours follow the app theme. A light or
// custom theme the user chose paints the same in either app theme.
test('the restart hint is only offered when a restart would change the CLI colours', () => {
  for (const [userTheme, expectsHint] of [
    ['dark-daltonized', true],
    ['auto', true],
    ['light', false],
    ['light-daltonized', false],
    ['custom:mine', false],
  ] as const) {
    withClaudeConfig(({ configHome, projectPath, write }) => {
      write(path.join(configHome, 'settings.json'), { theme: userTheme });
      const { dependencies } = spawnRecorder();

      for (const colorScheme of ['light', 'dark']) {
        const socket = launch(dependencies, { provider: 'claude', colorScheme }, projectPath);
        const themeFrames = socket.frames
          .map((frame) => JSON.parse(frame) as Record<string, unknown>)
          .filter((frame) => frame.type === 'claude_theme');
        assert.deepEqual(
          themeFrames,
          expectsHint ? [{ type: 'claude_theme', colorScheme }] : [],
          `${userTheme} in a ${colorScheme} tab`,
        );
      }
    });
  }
});

test('other shells and initial commands only get the COLORFGBG hint', () => {
  withClaudeConfig(({ projectPath }) => {
    const { calls, dependencies } = spawnRecorder();
    const loginCommand = 'claude --dangerously-skip-permissions /login';

    launch(
      dependencies,
      { provider: 'plain-shell', isPlainShell: true, initialCommand: 'npx task-master init', colorScheme: 'light' },
      projectPath
    );
    launch(dependencies, { provider: 'claude', initialCommand: loginCommand, colorScheme: 'light' }, projectPath);
    launch(dependencies, { provider: 'codex', colorScheme: 'light' }, projectPath);
    launch(dependencies, { provider: 'codex', colorScheme: 'dark' }, projectPath);
    const agyPath = withAgyCli(({ agyPath: fakeAgyPath }) => {
      launch(dependencies, { provider: 'agy', colorScheme: 'light' }, projectPath);
      return fakeAgyPath;
    });

    assert.deepEqual(
      calls.map((call) => call.command),
      ['npx task-master init', loginCommand, 'codex', 'codex', agyLaunch(agyPath)]
    );
    assert.deepEqual(
      calls.map((call) => call.env.COLORFGBG),
      ['0;15', '0;15', '0;15', '15;0', '0;15']
    );
  });
});

const AGY_CONVERSATION_ID = '0f6b2c1e-8d3a-4f5b-9c7e-2a1d3b4c5e6f';
const AGY_NOT_INSTALLED_MESSAGE =
  'Antigravity CLI (agy) is not installed on this machine. Install it, or set AGY_CLI_PATH to its full path and restart CloudCLI.';

// The service PATH often lacks agy's install folder, so a bare `agy` would
// not be found: the launch names the binary the lookup found, quoted.
test('agy launches by its resolved, quoted path and resumes the conversation when there is one', (t) => {
  if (os.platform() === 'win32') {
    t.skip('asserts the bash launch and POSIX paths');
    return;
  }
  withAgyCli(({ root, agyPath }) => {
    const resumable = spawnRecorder(AGY_CONVERSATION_ID);
    const neverRun = spawnRecorder(null);
    const unsafe = spawnRecorder(`${AGY_CONVERSATION_ID}; rm -rf ~`);

    const resumedSocket = launch(resumable.dependencies, { provider: 'agy', hasSession: true });
    const freshSocket = launch(resumable.dependencies, { provider: 'agy' });
    // An app session that never ran has no conversation id yet.
    launch(neverRun.dependencies, { provider: 'agy', hasSession: true });
    launch(unsafe.dependencies, { provider: 'agy', hasSession: true });
    // A caller's own command is launched as given, as for claude and opencode.
    launch(neverRun.dependencies, { provider: 'agy', hasSession: true, initialCommand: 'agy --help' });

    const agy = `'${agyPath.replace(/'/g, `'\\''`)}'`;
    assert.deepEqual(resumable.calls.map((call) => [call.shell, ...call.args]), [
      ['bash', '-c', `${agy} --conversation "${AGY_CONVERSATION_ID}" || ${agy}`],
      ['bash', '-c', agy],
    ]);
    assert.deepEqual(neverRun.calls.map((call) => call.command), [agy, 'agy --help']);
    assert.deepEqual(unsafe.calls.map((call) => call.command), [agy]);
    // Spelled out once, so the quoting is not only checked against itself.
    assert.equal(resumable.calls[1].command, `'${root}/agy'\\''s bin/agy'`);

    const welcome = (socket: ReturnType<typeof createFakeSocket>) =>
      (JSON.parse(socket.frames[0]) as { data: string }).data;
    assert.match(welcome(resumedSocket), new RegExp(`Resuming Antigravity session ${AGY_CONVERSATION_ID} in: `));
    assert.match(welcome(freshSocket), /Starting new Antigravity session in: /);
  }, { agyFolderName: "agy's bin" });
});

test('agy starts with --dangerously-skip-permissions for bypass and --model for a chosen model', (t) => {
  if (os.platform() === 'win32') {
    t.skip('asserts the bash launch');
    return;
  }
  withAgyCli(({ agyPath }) => {
    const { calls, dependencies } = spawnRecorder(AGY_CONVERSATION_ID);
    const agy = agyLaunch(agyPath);

    launch(dependencies, { provider: 'agy', bypassPermissions: true });
    launch(dependencies, { provider: 'agy', model: 'gemini-3.8-flash-high' });
    launch(dependencies, { provider: 'agy', model: 'vendor/model-1.5:latest@2026+exp' });
    launch(dependencies, { provider: 'agy', hasSession: true, model: 'auto', bypassPermissions: true });
    // Never passed: no model, the default one, and ids a shell or agy would misread.
    const ignoredModels = ['', 'default', '--help', '-m', 'a b', 'x;rm -rf ~', '$(id)', '`id`', "it's", 'a"b', 42, null];
    for (const model of ignoredModels) {
      launch(dependencies, { provider: 'agy', model });
    }

    const flags = ' --model "auto" --dangerously-skip-permissions';
    assert.deepEqual(calls.map((call) => call.command), [
      `${agy} --dangerously-skip-permissions`,
      `${agy} --model "gemini-3.8-flash-high"`,
      `${agy} --model "vendor/model-1.5:latest@2026+exp"`,
      `${agy} --conversation "${AGY_CONVERSATION_ID}"${flags} || ${agy}${flags}`,
      ...ignoredModels.map(() => agy),
    ]);
  });
});

// PowerShell runs a quoted path only through its call operator, `&`.
test('agy launches through PowerShell on Windows', (t) => {
  if (os.platform() === 'win32') {
    t.skip('asserts POSIX paths');
    return;
  }
  withAgyCli(({ root, agyPath }) => {
    const { calls, dependencies } = spawnRecorder(AGY_CONVERSATION_ID);
    t.mock.method(os, 'platform', () => 'win32');

    launch(dependencies, { provider: 'agy', hasSession: true, bypassPermissions: true });
    launch(dependencies, { provider: 'agy', model: 'gemini-flash-next' });

    const agy = `& '${agyPath.replace(/['’]/g, '$&$&')}'`;
    const bypass = ' --dangerously-skip-permissions';
    assert.deepEqual(calls.map((call) => [call.shell, ...call.args]), [
      [
        'powershell.exe',
        '-Command',
        `${agy} --conversation "${AGY_CONVERSATION_ID}"${bypass}; if ($LASTEXITCODE -ne 0) { ${agy}${bypass} }`,
      ],
      ['powershell.exe', '-Command', `${agy} --model "gemini-flash-next"`],
    ]);
    assert.equal(calls[1].command, `& '${root}/agy''s ’’bin’’/agy' --model "gemini-flash-next"`);
  }, { agyFolderName: "agy's ’bin’" });
});

// Without an explicit message the user would only see the shell's
// "agy: command not found" and exit code 127.
test('a missing agy says it is not installed instead of "command not found"', (t) => {
  if (os.platform() === 'win32') {
    t.skip('asserts the bash launch first');
    return;
  }
  withAgyCli(({ root }) => {
    const { calls, dependencies } = spawnRecorder(AGY_CONVERSATION_ID);

    launch(dependencies, { provider: 'agy' });
    launch(dependencies, { provider: 'agy', hasSession: true, bypassPermissions: true });
    // An AGY_CLI_PATH that names no file is not an installation either.
    process.env.AGY_CLI_PATH = path.join(root, 'missing', 'agy');
    const socket = launch(dependencies, { provider: 'agy' });
    t.mock.method(os, 'platform', () => 'win32');
    launch(dependencies, { provider: 'agy', hasSession: true });

    const guarded = (agyLaunchLine: string) =>
      `if command -v agy >/dev/null 2>&1; then ${agyLaunchLine}; else echo '${AGY_NOT_INSTALLED_MESSAGE}'; exit 127; fi`;
    const bypass = ' --dangerously-skip-permissions';
    assert.deepEqual(calls.map((call) => call.command), [
      guarded('agy'),
      guarded(`agy --conversation "${AGY_CONVERSATION_ID}"${bypass} || agy${bypass}`),
      guarded('agy'),
      `if (Get-Command agy -ErrorAction SilentlyContinue) { agy --conversation "${AGY_CONVERSATION_ID}"; ` +
        `if ($LASTEXITCODE -ne 0) { agy } } else { Write-Host '${AGY_NOT_INSTALLED_MESSAGE}'; exit 127 }`,
    ]);
    // Still a provider launch: the welcome line names Antigravity.
    assert.match((JSON.parse(socket.frames[0]) as { data: string }).data, /Starting new Antigravity session in: /);
  }, { installed: false });
});

// Runs a launch line the way the pty does, `bash -c`, but never with the
// user's own startup files: HOME is the fixture's, and stdin is not a socket
// (libuv's default), which some bash builds take for an ssh session and answer
// by sourcing ~/.bashrc.
function runBash(bashPath: string, command: string, home: string, pathDirectory: string) {
  return spawnSync(bashPath, ['-c', command], {
    env: { HOME: home, PATH: pathDirectory },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}

// The launch lines are shell code, so they are also run once through bash: a
// fake agy that prints its arguments stands in for the real one.
test('the agy launch lines work when bash runs them', (t) => {
  if (os.platform() === 'win32') {
    t.skip('runs bash');
    return;
  }
  // Looked up before the fixture empties PATH.
  const bashPath = execFileSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();
  withAgyCli(({ home, agyPath, pathDirectory }) => {
    fs.writeFileSync(agyPath, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n');
    fs.chmodSync(agyPath, 0o755);
    const { calls, dependencies } = spawnRecorder(AGY_CONVERSATION_ID);
    launch(dependencies, { provider: 'agy', hasSession: true, model: 'auto' });

    const result = runBash(bashPath, calls[0].command, home, pathDirectory);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `--conversation\n${AGY_CONVERSATION_ID}\n--model\nauto\n`);
    assert.equal(result.status, 0);
  }, { agyFolderName: "agy's bin" });

  withAgyCli(({ home, pathDirectory }) => {
    const { calls, dependencies } = spawnRecorder();
    launch(dependencies, { provider: 'agy' });

    const result = runBash(bashPath, calls[0].command, home, pathDirectory);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${AGY_NOT_INSTALLED_MESSAGE}\n`);
    assert.equal(result.status, 127);
  }, { installed: false });
});
