import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pty, { type IPty } from 'node-pty';
import { WebSocket, type RawData } from 'ws';

import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/services/chat-websocket.service.js';
import { resolveAgyCliPath } from '@/shared/agy-cli-path.js';
import type { BackgroundTaskSummary, ProviderProcessState, ScheduledWorkSummary, SessionHold } from '@/shared/types.js';
import { parseIncomingJsonObject, stripAnsiSequences } from '@/shared/utils.js';

type ShellIncomingMessage = {
  type?: string;
  data?: string;
  cols?: number;
  rows?: number;
  projectPath?: string;
  sessionId?: string;
  hasSession?: boolean;
  provider?: string;
  initialCommand?: string;
  isPlainShell?: boolean;
  forceRestart?: boolean;
  bypassPermissions?: boolean;
  colorScheme?: string;
  // The model chosen for the session's provider; only the agy launch uses it.
  model?: string;
  // Set when the user chose to stop what CloudCLI still runs on the session
  // (see takeOverSession) so the CLI can start on it: what their busy notice
  // showed, read by readTakeOverSnapshot.
  takeOver?: unknown;
  // The client's number for this init, echoed on the `session_busy` that
  // answers it: a takeover's answer can arrive after an earlier init's.
  initId?: unknown;
};

type ShellColorScheme = 'light' | 'dark';

type PtySessionEntry = {
  pty: IPty;
  ws: WebSocket | null;
  buffer: string[];
  timeoutId: NodeJS.Timeout | null;
  projectPath: string;
  sessionId: string | null;
  // The app theme a Claude CLI in this pty was launched for; null for any other
  // program. A running CLI keeps its launch-time colours, so a reattaching
  // client needs this, not its own current theme, to know if they differ.
  claudeColorScheme: ShellColorScheme | null;
};

const ptySessionsMap = new Map<string, PtySessionEntry>();
const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;
const SHELL_URL_PARSE_BUFFER_LIMIT = 32768;
const TRAILING_URL_PUNCTUATION_REGEX = /[)\]}>.,;:!?]+$/;

function normalizeDetectedUrl(url: string): string | null {
  const cleanedUrl = url.trim().replace(TRAILING_URL_PUNCTUATION_REGEX, '');
  if (!cleanedUrl) {
    return null;
  }

  try {
    const parsedUrl = new URL(cleanedUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return null;
    }
    return parsedUrl.toString();
  } catch {
    return null;
  }
}

function extractUrlsFromText(value: string): string[] {
  const directMatches = value.match(/https?:\/\/[^\s<>"'`\\\x1b\x07]+/gi) ?? [];

  // Terminal width can split a URL across lines, so valid URL characters on
  // immediately following lines are joined before the URL is validated.
  const wrappedMatches: string[] = [];
  const urlContinuationPattern = /^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/;
  const lines = value.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex].trim();
    const startMatch = line.match(/https?:\/\/[^\s<>"'`\\\x1b\x07]+/i);
    if (!startMatch) {
      continue;
    }

    let combinedUrl = startMatch[0];
    let continuationIndex = lineIndex + 1;
    while (continuationIndex < lines.length) {
      const continuation = lines[continuationIndex].trim();
      if (!continuation || !urlContinuationPattern.test(continuation)) {
        break;
      }
      combinedUrl += continuation;
      continuationIndex += 1;
    }

    wrappedMatches.push(combinedUrl);
  }

  return Array.from(new Set([...directMatches, ...wrappedMatches]));
}

/**
 * Tells the client which app theme the Claude CLI in its pty was launched for,
 * so the Shell can suggest a restart once the app theme no longer matches it.
 * Clients that predate this frame ignore unknown frame types.
 */
function sendClaudeColorScheme(ws: WebSocket, colorScheme: ShellColorScheme | null): void {
  if (colorScheme && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'claude_theme', colorScheme }));
  }
}

function shouldAutoOpenUrlFromOutput(value: string): boolean {
  const normalizedOutput = value.toLowerCase();
  return (
    normalizedOutput.includes("browser didn't open") ||
    normalizedOutput.includes('open this url') ||
    normalizedOutput.includes('continue in your browser') ||
    normalizedOutput.includes('press enter to open') ||
    normalizedOutput.includes('open_url:')
  );
}

/**
 * What the Shell handler needs from the provider runtime gateway: what
 * CloudCLI's own processes still hold for a session, and stopping them when
 * the user takes the session over for the terminal.
 */
type ShellSessionRuntime = Pick<ProviderRuntimeGateway, 'abort'> & {
  describeSessionHold(sessionId: string): SessionHold | null;
  releaseSession(sessionId: string): Promise<void>;
};

type ShellWebSocketDependencies = {
  resolveProviderSessionId: (
    sessionId: string,
    provider: string,
  ) => string | null | undefined;
  spawnPty?: typeof pty.spawn;
  /**
   * The provider runtimes. Without them only a chat turn under way or a
   * queued message holds a CLI back, and a session cannot be taken over.
   */
  runtime?: ShellSessionRuntime;
  /** Whether a chat message is queued for the app session, which the dispatcher sends once it is idle. */
  hasQueuedMessage?: (appSessionId: string) => boolean;
};

/**
 * Why CloudCLI itself still holds a session, and what it runs there: sent as
 * `session_busy` instead of starting a CLI on it. `tasks` are the background
 * tasks still outstanding; `scheduled` the scheduled work its process holds
 * (a /loop's next wake-up, a CronCreate job), always sent, empty for none;
 * `turnStartedAt` is when the chat turn under way started (its run's
 * `startedAt`, null when none is), which tells that turn from a later one;
 * `hasQueuedMessage` rules out a takeover, as the dispatcher would send the
 * message, in a new process, as soon as the session is free.
 */
type ShellSessionBusy = {
  reason: 'turn' | 'exiting' | 'background' | 'held' | 'queued';
  tasks: BackgroundTaskSummary[];
  scheduled: ScheduledWorkSummary[];
  turnStartedAt: number | null;
  hasQueuedMessage: boolean;
};

/**
 * What the busy notice the user acted on showed, sent back with a takeover:
 * the chat turn then under way (`turnStartedAt`, null for none), the id of
 * every task its frame carried, nested and unlisted ones included, and the id
 * of every piece of scheduled work it carried (`scheduledIds`), null from a
 * client that sends none, which never shows scheduled work. A takeover stops
 * nothing beyond it (see hasChangedSinceSnapshot).
 */
type ShellTakeOverSnapshot = {
  turnStartedAt: number | null;
  taskIds: string[];
  scheduledIds: string[] | null;
};

/**
 * The ids a session's runs may be registered under: the app session id, and
 * the provider-native id when it differs (a run started without an app
 * session id is keyed by the provider's).
 */
function listSessionIds(appSessionId: string, providerSessionId: string | null): string[] {
  return providerSessionId && providerSessionId !== appSessionId
    ? [appSessionId, providerSessionId]
    : [appSessionId];
}

/**
 * Whether CloudCLI itself still holds the session a CLI would open, and why.
 * A CLI started on it now would be a second process writing the same
 * transcript, and the Claude CLI would record the background tasks still
 * running in CloudCLI's process as stopped (it only knows its own).
 *
 * The first reason that applies wins: a chat turn under way, for any
 * provider (`turn`); a Claude process on its way out (`exiting`); one held
 * open for background tasks (`background`) or for work no task stands for,
 * such as a Monitor or scheduled work (`held`); or only a queued chat
 * message (`queued`). Null when nothing holds it. The scheduled work a
 * process holds is listed whatever the reason.
 */
function readSessionBusy(
  appSessionId: string,
  providerSessionId: string | null,
  dependencies: ShellWebSocketDependencies,
): ShellSessionBusy | null {
  let processState: ProviderProcessState | null = null;
  const tasks: BackgroundTaskSummary[] = [];
  const scheduled: ScheduledWorkSummary[] = [];
  for (const sessionId of listSessionIds(appSessionId, providerSessionId)) {
    const hold = dependencies.runtime?.describeSessionHold(sessionId) ?? null;
    if (hold?.processState === 'running' || (hold?.processState === 'exiting' && processState === null)) {
      processState = hold.processState;
    }
    tasks.push(...(hold?.tasks ?? []));
    scheduled.push(...(hold?.scheduled ?? []));
  }
  const hasQueuedMessage = dependencies.hasQueuedMessage?.(appSessionId) ?? false;
  const run = chatRunRegistry.getRun(appSessionId);
  const turnStartedAt = run?.status === 'running' ? run.startedAt : null;

  let reason: ShellSessionBusy['reason'] | null = null;
  if (turnStartedAt !== null) {
    reason = 'turn';
  } else if (processState === 'exiting') {
    reason = 'exiting';
  } else if (tasks.length > 0) {
    reason = 'background';
  } else if (processState === 'running') {
    reason = 'held';
  } else if (hasQueuedMessage) {
    reason = 'queued';
  }
  return reason ? { reason, tasks, scheduled, turnStartedAt, hasQueuedMessage } : null;
}

/**
 * Reads an init's `takeOver`: the snapshot of the notice the user acted on,
 * or null when the init asks for no takeover. A malformed field reads as a
 * notice that showed nothing.
 *
 * A bare `true` is what clients from before the snapshot send, from a page
 * loaded before an upgrade. It reads as that empty notice too: such a client
 * can still take over a process held with no turn and no tasks, but gets
 * `session_busy` with `changed` for a turn or tasks, which it cannot show it
 * saw, until the page is reloaded.
 *
 * `scheduledIds` is left out by clients from before scheduled work was
 * shown, which read as null: their takeover stops the scheduled work as it
 * always did.
 */
function readTakeOverSnapshot(value: unknown): ShellTakeOverSnapshot | null {
  if (value === true) {
    return { turnStartedAt: null, taskIds: [], scheduledIds: null };
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const snapshot = value as Record<string, unknown>;
  const readIds = (ids: unknown) => (Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
  return {
    turnStartedAt:
      typeof snapshot.turnStartedAt === 'number' && Number.isFinite(snapshot.turnStartedAt)
        ? snapshot.turnStartedAt
        : null,
    taskIds: readIds(snapshot.taskIds),
    scheduledIds: snapshot.scheduledIds === undefined ? null : readIds(snapshot.scheduledIds),
  };
}

/**
 * Whether CloudCLI has started something on the session since the notice a
 * takeover comes from: a chat turn other than the one it showed (a session's
 * next run starts after the last one ended, so with a later `startedAt`), a
 * task it did not carry, or, when the notice sent its scheduled work back,
 * scheduled work it did not carry (a self-paced /loop keeps its id from one
 * wake-up to the next). Its turn, tasks or scheduled work having ended since
 * is no change, there is only less to stop; nor is the process going from
 * held to exiting or back, as a process carries no identity here.
 */
function hasChangedSinceSnapshot(busy: ShellSessionBusy, snapshot: ShellTakeOverSnapshot): boolean {
  if (busy.turnStartedAt !== null && busy.turnStartedAt !== snapshot.turnStartedAt) {
    return true;
  }
  const shownTaskIds = new Set(snapshot.taskIds);
  if (busy.tasks.some((task) => !shownTaskIds.has(task.taskId))) {
    return true;
  }
  if (snapshot.scheduledIds === null) {
    return false;
  }
  const shownScheduledIds = new Set(snapshot.scheduledIds);
  return busy.scheduled.some((item) => !shownScheduledIds.has(item.id));
}

/**
 * Stops what CloudCLI runs on a session the user takes over for the
 * terminal: the chat turn under way, if any, is aborted and completed as
 * `chat.abort` does, then every runtime lets go of the session under either
 * id, which waits for its process to exit. A failure is only logged: the
 * caller checks the session again either way.
 */
async function takeOverSession(
  appSessionId: string,
  providerSessionId: string | null,
  runtime: ShellSessionRuntime,
): Promise<void> {
  try {
    await chatRunRegistry.abortRun(appSessionId, (provider, sessionId) => runtime.abort(provider, sessionId));
    for (const sessionId of listSessionIds(appSessionId, providerSessionId)) {
      await runtime.releaseSession(sessionId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ERROR] Shell: taking session ${appSessionId} over failed: ${message}`);
  }
}

/**
 * Reads a string field from untyped payloads and falls back when absent.
 */
function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Reads a boolean field from untyped payloads and falls back when absent.
 */
function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Reads a finite number field from untyped payloads and falls back when absent.
 */
function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Reads the app theme the Shell tab is painted in. Older clients send none and
 * anything unexpected is ignored, which keeps the launch exactly as before.
 */
function readColorScheme(value: unknown): ShellColorScheme | null {
  return value === 'light' || value === 'dark' ? value : null;
}

/**
 * Parses incoming websocket shell messages and keeps processing safe when
 * malformed payloads are received.
 */
function parseShellMessage(rawMessage: RawData): ShellIncomingMessage | null {
  const payload = parseIncomingJsonObject(rawMessage);
  if (!payload) {
    return null;
  }

  return payload as ShellIncomingMessage;
}

const SAFE_SESSION_ID_PATTERN = /^[a-zA-Z0-9_.\-:]+$/;

function resolveResumeSessionId(
  message: ShellIncomingMessage,
  dependencies: ShellWebSocketDependencies
): string {
  const hasSession = readBoolean(message.hasSession);
  const sessionId = readString(message.sessionId);
  const provider = readString(message.provider, 'claude');

  if (!hasSession || !sessionId) {
    return '';
  }

  let resumeSessionId: string | null | undefined;
  try {
    resumeSessionId = dependencies.resolveProviderSessionId(sessionId, provider);
  } catch (error) {
    console.error('Failed to resolve provider session ID:', error);
    resumeSessionId = undefined;
  }

  const resolvedSessionId = resumeSessionId === undefined ? sessionId : resumeSessionId;
  if (!resolvedSessionId || !SAFE_SESSION_ID_PATTERN.test(resolvedSessionId)) {
    return '';
  }

  return resolvedSessionId;
}

type ShellLaunch = {
  command: string;
  /**
   * Whether the command starts a Claude CLI that paints in the app's colour
   * scheme, so a later theme toggle can be applied by restarting it.
   */
  claudeFollowsAppTheme: boolean;
};

/**
 * Resolves provider command line for plain shell and agent-backed shell modes.
 */
function buildShellCommand(
  message: ShellIncomingMessage,
  dependencies: ShellWebSocketDependencies,
  projectPath: string
): ShellLaunch {
  const hasSession = readBoolean(message.hasSession);
  const initialCommand = readString(message.initialCommand);
  const provider = readString(message.provider, 'claude');
  const resumeSessionId = resolveResumeSessionId(message, dependencies);
  const isPlainShell =
    readBoolean(message.isPlainShell) ||
    (!!initialCommand && !hasSession) ||
    provider === 'plain-shell';

  const otherProgram = (command: string): ShellLaunch => ({ command, claudeFollowsAppTheme: false });

  if (isPlainShell) {
    return otherProgram(initialCommand);
  }

  if (provider === 'cursor') {
    if (resumeSessionId) {
      return otherProgram(`cursor-agent --resume="${resumeSessionId}"`);
    }
    return otherProgram('cursor-agent');
  }

  if (provider === 'codex') {
    if (resumeSessionId) {
      if (os.platform() === 'win32') {
        return otherProgram(`codex resume "${resumeSessionId}"; if ($LASTEXITCODE -ne 0) { codex }`);
      }
      return otherProgram(`codex resume "${resumeSessionId}" || codex`);
    }
    return otherProgram('codex');
  }

  if (provider === 'opencode') {
    if (resumeSessionId) {
      return otherProgram(`opencode --session "${resumeSessionId}"`);
    }
    return otherProgram(initialCommand || 'opencode');
  }

  if (provider === 'agy') {
    if (!resumeSessionId && initialCommand) {
      // A caller's own command is launched as given, as for claude and opencode.
      return otherProgram(initialCommand);
    }
    return otherProgram(buildAgyShellCommand(message, resumeSessionId));
  }

  // Launching with the flag is what unlocks "bypass permissions" in the CLI's
  // shift+tab permission-mode cycle; it cannot be enabled from inside a
  // session started without it.
  const bypassFlag = readBoolean(message.bypassPermissions)
    ? ' --dangerously-skip-permissions'
    : '';
  const theme = buildClaudeThemeLaunch(readColorScheme(message.colorScheme), projectPath);
  const launchFlags = `${bypassFlag}${theme.flag}`;
  if (resumeSessionId) {
    const command = os.platform() === 'win32'
      ? `claude --resume "${resumeSessionId}"${launchFlags}; if ($LASTEXITCODE -ne 0) { claude${launchFlags} }`
      : `claude --resume "${resumeSessionId}"${launchFlags} || claude${launchFlags}`;
    return { command, claudeFollowsAppTheme: theme.followsAppTheme };
  }
  if (initialCommand) {
    // A caller's own command (e.g. `claude /login`) is launched as given.
    return otherProgram(initialCommand);
  }
  return { command: `claude${launchFlags}`, claudeFollowsAppTheme: theme.followsAppTheme };
}

// agy model ids are slugs such as `gemini-3.8-flash-high`. An id must start
// with a letter or digit, so it is never read as a flag, and hold nothing a
// shell would interpret; any other value is left out of the launch.
const SAFE_AGY_MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.\-:/@+]*$/;

// Printed instead of the shell's bare "command not found" when no agy exists.
const AGY_NOT_INSTALLED_MESSAGE =
  'Antigravity CLI (agy) is not installed on this machine. Install it, or set AGY_CLI_PATH to its full path and restart CloudCLI.';

/**
 * Builds the Antigravity CLI launch. A conversation is resumed when there is
 * one, falling back to a fresh agy when that fails, as for claude and codex.
 * agy installs into `~/.local/bin`, which a service PATH often lacks, so the
 * binary that `resolveAgyCliPath` finds is run by its quoted full path. When
 * the lookup finds none, a bare `agy` still gets the shell's own lookup (the
 * only one that knows Windows' `.exe` and `.cmd` names), and a shell that
 * cannot find it either says what is missing.
 */
function buildAgyShellCommand(message: ShellIncomingMessage, resumeSessionId: string): string {
  const isWindows = os.platform() === 'win32';
  const agyPath = resolveAgyCliPath();
  // PowerShell runs a quoted path only through its call operator.
  const agy = agyPath ? `${isWindows ? '& ' : ''}${quoteShellArgument(agyPath)}` : 'agy';
  const model = readString(message.model);
  const modelFlag =
    model !== 'default' && SAFE_AGY_MODEL_ID_PATTERN.test(model) ? ` --model "${model}"` : '';
  const bypassFlag = readBoolean(message.bypassPermissions) ? ' --dangerously-skip-permissions' : '';
  const freshLaunch = `${agy}${modelFlag}${bypassFlag}`;

  let launch = freshLaunch;
  if (resumeSessionId) {
    const resumeLaunch = `${agy} --conversation "${resumeSessionId}"${modelFlag}${bypassFlag}`;
    launch = isWindows
      ? `${resumeLaunch}; if ($LASTEXITCODE -ne 0) { ${freshLaunch} }`
      : `${resumeLaunch} || ${freshLaunch}`;
  }
  if (agyPath) {
    return launch;
  }

  const notInstalled = quoteShellArgument(AGY_NOT_INSTALLED_MESSAGE);
  return isWindows
    ? `if (Get-Command agy -ErrorAction SilentlyContinue) { ${launch} } else { Write-Host ${notInstalled}; exit 127 }`
    : `if command -v agy >/dev/null 2>&1; then ${launch}; else echo ${notInstalled}; exit 127; fi`;
}

// Claude Code's built-in theme ids (the `/theme` picker of CLI 2.1.280). A
// `custom:<slug>` theme is valid too; any other value is ignored by the CLI.
const CLAUDE_THEME_IDS = new Set([
  'auto',
  'dark',
  'light',
  'dark-daltonized',
  'light-daltonized',
  'dark-ansi',
  'light-ansi',
]);

// Dark themes and their light counterparts. A light theme, `auto` (it asks the
// terminal for its background, which xterm answers from the live theme) or a
// custom theme is the user's own choice and is left alone.
const LIGHT_CLAUDE_THEME_BY_DARK_THEME = new Map([
  ['dark', 'light'],
  ['dark-daltonized', 'light-daltonized'],
  ['dark-ansi', 'light-ansi'],
]);

// The CLI refuses settings files over 2 MiB, so a bigger one holds no theme it
// would use. The legacy global config (`~/.claude.json`) is not a settings file
// and can grow to several MB; its cap is only there so a huge file is never
// pulled into the server's memory.
const MAX_CLAUDE_SETTINGS_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CLAUDE_GLOBAL_CONFIG_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Reads a config file only when it is a regular, non-empty file of sane size,
 * else returns null. The project can be a cloned repository whose
 * `.claude/settings.local.json` is a symlink to a FIFO or to a device such as
 * /dev/zero: reading one would stall the server's event loop or exhaust its
 * memory. `statSync` follows the symlink without opening the target. Empty
 * files are skipped too: they hold no theme, and kernel pseudo-files (procfs,
 * tracefs) report a size of 0 even when a read would block.
 */
function readRegularConfigFile(filePath: string, maxBytes = MAX_CLAUDE_SETTINGS_FILE_BYTES): string | null {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size === 0 || stats.size > maxBytes) {
      return null;
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Reads the `theme` key of one Claude config file. A missing, unreadable,
 * special (FIFO, device) or unparsable file, or a value the CLI would reject,
 * counts as unset.
 */
function readClaudeThemeFile(filePath: string, maxBytes: number): string | null {
  const text = readRegularConfigFile(filePath, maxBytes);
  if (text === null) {
    return null;
  }
  try {
    const config: unknown = JSON.parse(text);
    const theme = config && typeof config === 'object' ? (config as Record<string, unknown>).theme : undefined;
    if (typeof theme !== 'string') {
      return null;
    }
    return CLAUDE_THEME_IDS.has(theme) || theme.startsWith('custom:') ? theme : null;
  } catch {
    return null;
  }
}

/**
 * Finds the theme Claude Code would start with in `projectPath`, read-only and
 * in the CLI's own order: local, project and user settings, then the legacy
 * global config key, then its "dark" default. Managed settings are not read:
 * they outrank `--settings`, so no flag could change their theme anyway.
 */
function resolveClaudeTheme(projectPath: string): string {
  const configDirOverride = process.env.CLAUDE_CONFIG_DIR;
  const configHome = configDirOverride || path.join(os.homedir(), '.claude');
  const legacyGlobalConfigPath = path.join(configHome, '.config.json');
  const configFiles: Array<[string, number]> = [
    [path.join(projectPath, '.claude', 'settings.local.json'), MAX_CLAUDE_SETTINGS_FILE_BYTES],
    [path.join(projectPath, '.claude', 'settings.json'), MAX_CLAUDE_SETTINGS_FILE_BYTES],
    [path.join(configHome, 'settings.json'), MAX_CLAUDE_SETTINGS_FILE_BYTES],
    [
      fs.existsSync(legacyGlobalConfigPath)
        ? legacyGlobalConfigPath
        : path.join(configDirOverride || os.homedir(), '.claude.json'),
      MAX_CLAUDE_GLOBAL_CONFIG_FILE_BYTES,
    ],
  ];

  for (const [filePath, maxBytes] of configFiles) {
    const theme = readClaudeThemeFile(filePath, maxBytes);
    if (theme) {
      return theme;
    }
  }
  return 'dark';
}

let hasLoggedThemeSettingsFileError = false;

/**
 * Returns a settings file that holds only `{"theme": theme}`, writing it when
 * it is missing or differs. It lives in the app's own data folder
 * (`~/.cloudcli`, like the chat assets); the user's Claude config is never
 * written. The write goes through a temp file and a rename, so a CLI starting
 * at the same time never reads half a file. Returns null, and logs once, when
 * the file cannot be written (a read-only home, say): the launch then simply
 * goes ahead without a theme.
 */
function ensureClaudeThemeSettingsFile(theme: string): string | null {
  const contents = `${JSON.stringify({ theme })}\n`;
  let tempPath: string | null = null;
  try {
    const filePath = path.join(os.homedir(), '.cloudcli', `claude-shell-theme-${theme}.json`);
    // Anything but the expected regular file is replaced; the rename never
    // opens what it replaces.
    if (readRegularConfigFile(filePath) !== contents) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      tempPath = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tempPath, contents);
      fs.renameSync(tempPath, filePath);
    }
    return filePath;
  } catch (error) {
    if (tempPath) {
      // Asynchronous and unchecked: cleaning up must not throw into the launch.
      fs.rm(tempPath, { force: true }, () => undefined);
    }
    if (!hasLoggedThemeSettingsFileError) {
      hasLoggedThemeSettingsFileError = true;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[WARN] Shell: cannot write the Claude theme settings file, launching without it: ${message}`);
    }
    return null;
  }
}

/**
 * Quotes one argument for the shell that runs the launch command. bash takes
 * everything between single quotes literally, so a `'` closes the quote, adds
 * an escaped one and reopens it. PowerShell (win32) single quotes are literal
 * too, backslashes included; a quote is doubled, and PowerShell also treats
 * the typographic single quotes as quote characters.
 */
function quoteShellArgument(value: string): string {
  if (os.platform() === 'win32') {
    return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

type ClaudeThemeLaunch = {
  flag: string;
  /** Whether the CLI will paint in the app's colour scheme. */
  followsAppTheme: boolean;
};

/**
 * Claude Code paints its own colours in its own theme, dark by default, so in
 * a light Shell tab its prompt rows became dark bands. Only a light tab gets a
 * flag, and only when the user's theme is a dark one: it is swapped for the
 * matching light variant. `--settings` applies it to this launch only. It is
 * given a file path rather than inline JSON because PowerShell strips the
 * JSON's double quotes when it passes an argument to a native program.
 *
 * The CLI follows the app theme when it gets that flag, when a dark tab runs a
 * dark theme, and with `auto` (it asks the terminal, which xterm answers from
 * the live theme). A light or custom theme the user chose, or a flag that
 * could not be written, paints the same in either app theme, so restarting
 * after a toggle would change nothing.
 */
function buildClaudeThemeLaunch(colorScheme: ShellColorScheme | null, projectPath: string): ClaudeThemeLaunch {
  if (!colorScheme) {
    return { flag: '', followsAppTheme: false };
  }
  const userTheme = resolveClaudeTheme(projectPath);
  if (userTheme === 'auto') {
    return { flag: '', followsAppTheme: true };
  }
  const lightTheme = LIGHT_CLAUDE_THEME_BY_DARK_THEME.get(userTheme);
  if (!lightTheme) {
    return { flag: '', followsAppTheme: false };
  }
  if (colorScheme === 'dark') {
    return { flag: '', followsAppTheme: true };
  }
  const settingsPath = ensureClaudeThemeSettingsFile(lightTheme);
  return settingsPath
    ? { flag: ` --settings ${quoteShellArgument(settingsPath)}`, followsAppTheme: true }
    : { flag: '', followsAppTheme: false };
}

function readEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const resolvedKey = Object.keys(env).find((envKey) => envKey.toLowerCase() === key.toLowerCase());
  return resolvedKey ? env[resolvedKey] : undefined;
}

function getPathEnvKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
}

function prioritizeUserNpmGlobalBin(env: NodeJS.ProcessEnv): { key: string; value: string | undefined } {
  const pathKey = getPathEnvKey(env);
  const currentPath = env[pathKey];
  if (!currentPath) {
    return { key: pathKey, value: currentPath };
  }

  const delimiter = path.delimiter;
  const pathEntries = currentPath.split(delimiter).filter(Boolean);
  const npmPrefix = readEnvValue(env, 'npm_config_prefix');
  const appData = readEnvValue(env, 'APPDATA');
  const candidates = [
    npmPrefix || '',
    npmPrefix ? path.join(npmPrefix, 'bin') : '',
    appData ? path.join(appData, 'npm') : '',
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
    path.join(os.homedir(), '.npm-global', 'bin'),
  ].filter(Boolean);

  const normalizedPathEntries = pathEntries.map((entry) => os.platform() === 'win32' ? entry.toLowerCase() : entry);
  const preferredEntries = candidates.filter((candidate, index) => {
    const normalizedCandidate = os.platform() === 'win32' ? candidate.toLowerCase() : candidate;
    return (
      candidates.indexOf(candidate) === index &&
      normalizedPathEntries.includes(normalizedCandidate)
    );
  });

  if (preferredEntries.length === 0) {
    return { key: pathKey, value: currentPath };
  }

  const normalizedPreferredEntries = preferredEntries.map((entry) =>
    os.platform() === 'win32' ? entry.toLowerCase() : entry
  );

  const value = [
    ...preferredEntries,
    ...pathEntries.filter((entry) => {
      const normalizedEntry = os.platform() === 'win32' ? entry.toLowerCase() : entry;
      return !normalizedPreferredEntries.includes(normalizedEntry);
    }),
  ].join(delimiter);

  return { key: pathKey, value };
}

/**
 * Used by this module's websocket gateway to connect the standalone Shell UI
 * to a retained PTY while keeping process lifecycle ownership on the server.
 */
export function handleShellConnection(
  ws: WebSocket,
  dependencies: ShellWebSocketDependencies
): void {
  console.log('[INFO] Shell websocket connected');

  let shellProcess: IPty | null = null;
  let ptySessionKey: string | null = null;
  let urlDetectionBuffer = '';
  const announcedAuthUrls = new Set<string>();
  // How many init frames this socket has sent. A takeover waits for
  // CloudCLI's processes to exit; an init that arrives meanwhile replaces
  // it, so the takeover then starts nothing.
  let initCount = 0;

  // Gives this socket a pty that is already running: replays its output and
  // takes its live output over from whichever socket had it.
  const attachToExistingPty = (existingSession: PtySessionEntry): void => {
    shellProcess = existingSession.pty;
    if (existingSession.timeoutId) {
      clearTimeout(existingSession.timeoutId);
      existingSession.timeoutId = null;
    }

    ws.send(
      JSON.stringify({
        type: 'output',
        data: '\x1b[36m[Reconnected to existing session]\x1b[0m\r\n',
      })
    );

    if (existingSession.buffer.length > 0) {
      existingSession.buffer.forEach((bufferedData) => {
        ws.send(
          JSON.stringify({
            type: 'output',
            data: bufferedData,
          })
        );
      });
    }

    existingSession.ws = ws;
    sendClaudeColorScheme(ws, existingSession.claudeColorScheme);
  };

  ws.on('message', async (rawMessage) => {
    try {
      const data = parseShellMessage(rawMessage);
      if (!data?.type) {
        throw new Error('Invalid websocket payload');
      }

      if (data.type === 'init') {
        initCount += 1;
        const initNumber = initCount;
        const projectPath = readString(data.projectPath, process.cwd());
        const sessionId = readString(data.sessionId) || null;
        const hasSession = readBoolean(data.hasSession);
        const provider = readString(data.provider, 'claude');
        const initialCommand = readString(data.initialCommand);
        const forceRestart = readBoolean(data.forceRestart);
        const colorScheme = readColorScheme(data.colorScheme);
        const isPlainShell =
          readBoolean(data.isPlainShell) ||
          (!!initialCommand && !hasSession) ||
          provider === 'plain-shell';

        urlDetectionBuffer = '';
        announcedAuthUrls.clear();

        const isLoginCommand =
          !!initialCommand &&
          (initialCommand.includes('setup-token') ||
            initialCommand.includes('cursor-agent login') ||
            initialCommand.includes('auth login'));

        const commandSuffix =
          isPlainShell && initialCommand
            ? `_cmd_${Buffer.from(initialCommand).toString('base64').slice(0, 16)}`
            : '';
        const sessionKey = `${projectPath}_${sessionId ?? 'default'}${commandSuffix}`;
        ptySessionKey = sessionKey;

        if (isLoginCommand || forceRestart) {
          const oldSession = ptySessionsMap.get(sessionKey);
          if (oldSession) {
            if (oldSession.timeoutId) {
              clearTimeout(oldSession.timeoutId);
            }
            oldSession.pty.kill();
            ptySessionsMap.delete(sessionKey);
          }
        }

        const existingSession =
          isLoginCommand || forceRestart ? null : ptySessionsMap.get(sessionKey);
        if (existingSession) {
          attachToExistingPty(existingSession);
          return;
        }

        const resolvedProjectPath = path.resolve(projectPath);
        try {
          const stats = fs.statSync(resolvedProjectPath);
          if (!stats.isDirectory()) {
            throw new Error('Not a directory');
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid project path' }));
          return;
        }

        const safeSessionIdPattern = /^[a-zA-Z0-9_.\-:]+$/;
        if (sessionId && !safeSessionIdPattern.test(sessionId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid session ID' }));
          return;
        }

        // A provider CLI on a session CloudCLI itself still runs would be a
        // second process on it (see readSessionBusy), so the socket is told
        // why instead, and stays open for another init. Checked whether or
        // not the provider id is known yet: a new session's first turn has
        // none, and the launch would then start an unrelated CLI.
        if (!isPlainShell && hasSession && sessionId) {
          const providerSessionId = resolveResumeSessionId(data, dependencies) || null;
          let busy = readSessionBusy(sessionId, providerSessionId, dependencies);
          const takeOver = readTakeOverSnapshot(data.takeOver);
          // Set when a takeover is refused, having stopped nothing, because
          // the session now runs more than the user's notice showed.
          let changed = false;
          if (busy && takeOver && !busy.hasQueuedMessage && dependencies.runtime) {
            // Compared with the read just above, with no await in between, and
            // takeOverSession picks the run it aborts in this same tick: nothing
            // can start on the session between the check and the stop.
            changed = hasChangedSinceSnapshot(busy, takeOver);
            if (!changed) {
              console.log(`[INFO] Shell: taking session ${sessionId} over for the terminal (${busy.reason})`);
              await takeOverSession(sessionId, providerSessionId, dependencies.runtime);
              // A later init replaced this one, or the socket went away:
              // CloudCLI has let go, but nobody waits for this CLI any more.
              if (initNumber !== initCount || ws.readyState !== WebSocket.OPEN) {
                return;
              }
              // Another tab started the CLI meanwhile: share it, as a reconnect does.
              const startedMeanwhile = ptySessionsMap.get(sessionKey);
              if (startedMeanwhile) {
                attachToExistingPty(startedMeanwhile);
                return;
              }
              busy = readSessionBusy(sessionId, providerSessionId, dependencies);
            }
          }
          if (busy) {
            console.log(
              changed
                ? `[INFO] Shell: not taking session ${sessionId} over, CloudCLI started more on it since the notice (${busy.reason})`
                : `[INFO] Shell: not starting a CLI on session ${sessionId}, CloudCLI still holds it (${busy.reason})`,
            );
            // The init's own number goes back with the answer, so the client
            // can tell it from the answer to an earlier init.
            const initId = typeof data.initId === 'number' && Number.isFinite(data.initId) ? data.initId : null;
            ws.send(JSON.stringify({
              type: 'session_busy',
              sessionId,
              provider,
              ...busy,
              changed,
              ...(initId === null ? {} : { initId }),
            }));
            return;
          }
        }

        const { command: shellCommand, claudeFollowsAppTheme } = buildShellCommand(
          data,
          dependencies,
          resolvedProjectPath,
        );
        const resumeSessionId = resolveResumeSessionId(data, dependencies);
        const claudeColorScheme = claudeFollowsAppTheme ? colorScheme : null;
        const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
        const shellArgs =
          os.platform() === 'win32' ? ['-Command', shellCommand] : ['-c', shellCommand];
        const termCols = readNumber(data.cols, 80);
        const termRows = readNumber(data.rows, 24);
        const prioritizedPath = prioritizeUserNpmGlobalBin(process.env);
        // A CloudCLI started from inside a Claude Code process inherits its
        // entrypoint, and an interactive `claude` keeps an inherited one, so
        // the Shell tab's REPL would label itself as that kind of process.
        // Without it the REPL writes `cli`, which is how the Claude history
        // reader tells its launches from CloudCLI's own runs.
        const { CLAUDE_CODE_ENTRYPOINT: _inheritedEntrypoint, ...hostEnv } = process.env;

        shellProcess = (dependencies.spawnPty ?? pty.spawn)(shell, shellArgs, {
          name: 'xterm-256color',
          cols: termCols,
          rows: termRows,
          cwd: resolvedProjectPath,
          env: {
            ...hostEnv,
            [prioritizedPath.key]: prioritizedPath.value,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            FORCE_COLOR: '3',
            // rxvt's "foreground;background" palette indices (15 = white, 0 = black).
            // Programs that cannot query the terminal (vim, Claude Code's "auto"
            // theme before its OSC 11 reply arrives) read it to pick light or dark.
            ...(colorScheme ? { COLORFGBG: colorScheme === 'light' ? '0;15' : '15;0' } : {}),
          },
        });

        ptySessionsMap.set(sessionKey, {
          pty: shellProcess,
          ws,
          buffer: [],
          timeoutId: null,
          projectPath,
          sessionId,
          claudeColorScheme,
        });

        shellProcess.onData((chunk) => {
          if (!ptySessionKey) {
            return;
          }

          const session = ptySessionsMap.get(ptySessionKey);
          if (!session) {
            return;
          }

          if (session.buffer.length < 5000) {
            session.buffer.push(chunk);
          } else {
            session.buffer.shift();
            session.buffer.push(chunk);
          }

          if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            let outputData = chunk;
            const cleanChunk = stripAnsiSequences(chunk);
            urlDetectionBuffer = `${urlDetectionBuffer}${cleanChunk}`.slice(-SHELL_URL_PARSE_BUFFER_LIMIT);

            outputData = outputData.replace(
              /OPEN_URL:\s*(https?:\/\/[^\s\x1b\x07]+)/g,
              '[INFO] Opening in browser: $1'
            );

            const emitAuthUrl = (detectedUrl: string, autoOpen = false) => {
              const normalizedUrl = normalizeDetectedUrl(detectedUrl);
              if (!normalizedUrl) {
                return;
              }

              const isNewUrl = !announcedAuthUrls.has(normalizedUrl);
              if (isNewUrl) {
                announcedAuthUrls.add(normalizedUrl);
                session.ws?.send(
                  JSON.stringify({
                    type: 'auth_url',
                    url: normalizedUrl,
                    autoOpen,
                  })
                );
              }
            };

            const normalizedDetectedUrls = extractUrlsFromText(urlDetectionBuffer)
              .map((url) => normalizeDetectedUrl(url))
              .filter((url): url is string => Boolean(url));

            const dedupedDetectedUrls = Array.from(new Set(normalizedDetectedUrls)).filter(
              (url, _, urls) =>
                !urls.some((otherUrl) => otherUrl !== url && otherUrl.startsWith(url))
            );

            dedupedDetectedUrls.forEach((url) => emitAuthUrl(url, false));

            if (
              shouldAutoOpenUrlFromOutput(cleanChunk) &&
              dedupedDetectedUrls.length > 0
            ) {
              const bestUrl = dedupedDetectedUrls.reduce((longest, current) =>
                current.length > longest.length ? current : longest
              );
              emitAuthUrl(bestUrl, true);
            }

            session.ws.send(
              JSON.stringify({
                type: 'output',
                data: outputData,
              })
            );
          }
        });

        shellProcess.onExit((exitCode) => {
          if (!ptySessionKey) {
            return;
          }

          const session = ptySessionsMap.get(ptySessionKey);
          if (session && session.pty !== shellProcess) {
            return;
          }

          if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(
              JSON.stringify({
                type: 'output',
                data: `\r\n\x1b[33mProcess exited with code ${exitCode.exitCode}${
                  exitCode.signal != null ? ` (${exitCode.signal})` : ''
                }\x1b[0m\r\n`,
              })
            );
          }

          if (session?.timeoutId) {
            clearTimeout(session.timeoutId);
          }

          ptySessionsMap.delete(ptySessionKey);
          shellProcess = null;
        });

        let welcomeMsg = `\x1b[36mStarting terminal in: ${projectPath}\x1b[0m\r\n`;
        if (!isPlainShell) {
          const providerName =
            provider === 'cursor'
              ? 'Cursor'
              : provider === 'codex'
                ? 'Codex'
                : provider === 'opencode'
                  ? 'OpenCode'
                  : provider === 'agy'
                    ? 'Antigravity'
                    : 'Claude';
          welcomeMsg = hasSession && resumeSessionId
            ? `\x1b[36mResuming ${providerName} session ${resumeSessionId} in: ${projectPath}\x1b[0m\r\n`
            : `\x1b[36mStarting new ${providerName} session in: ${projectPath}\x1b[0m\r\n`;
        }

        ws.send(
          JSON.stringify({
            type: 'output',
            data: welcomeMsg,
          })
        );
        sendClaudeColorScheme(ws, claudeColorScheme);
        return;
      }

      if (data.type === 'input') {
        if (shellProcess) {
          shellProcess.write(readString(data.data));
        }
        return;
      }

      if (data.type === 'resize') {
        if (shellProcess) {
          shellProcess.resize(readNumber(data.cols, 80), readNumber(data.rows, 24));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Shell WebSocket error:', message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'output',
            data: `\r\n\x1b[31mError: ${message}\x1b[0m\r\n`,
          })
        );
      }
    }
  });

  ws.on('close', () => {
    if (!ptySessionKey) {
      return;
    }

    const session = ptySessionsMap.get(ptySessionKey);
    if (!session) {
      return;
    }

    // Mobile networks can deliver an old socket's close after its replacement
    // has attached. Only the socket that currently owns the PTY may detach it.
    if (session.ws !== ws) {
      return;
    }

    session.ws = null;
    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
    }
    session.timeoutId = setTimeout(() => {
      // A reconnect may win just as this timer becomes runnable. Re-check the
      // active socket so a queued cleanup can never kill a reattached PTY.
      if (ptySessionsMap.get(ptySessionKey as string) !== session || session.ws !== null) {
        return;
      }

      session.pty.kill();
      ptySessionsMap.delete(ptySessionKey as string);
    }, PTY_SESSION_TIMEOUT);
  });

  ws.on('error', (error) => {
    console.error('[ERROR] Shell WebSocket error:', error);
  });
}
