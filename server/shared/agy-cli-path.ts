import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Paths and identifiers shared by everything that talks to the Antigravity
 * CLI (`agy`): the provider facets (auth, models, runtime, sessions,
 * synchronizer), the session watcher and the Shell tab.
 *
 * Every function reads the environment when it is called, never at import
 * time, so tests can point `AGY_CLI_PATH` / `AGY_DATA_DIRS` / `HOME` at
 * fixtures after the registry has been imported.
 *
 * Nothing here executes agy or reads its data: `~/.gemini/**` is agy's own
 * store and CloudCLI only ever opens it read-only, elsewhere.
 */

export type AgyPathDependencies = {
  existsSync?: (filePath: string) => boolean;
  isExecutable?: (filePath: string) => boolean;
  homedir?: () => string;
};

const defaultIsExecutable = (filePath: string): boolean => {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
};

/**
 * Resolves the agy executable, or null when it is not installed.
 *
 * Lookup order: `AGY_CLI_PATH` (an operator override; null when it names a
 * file that does not exist), then an executable `agy` on `PATH`, then
 * `~/.local/bin/agy` (agy's installer target, which a service PATH may lack).
 * Other locations are deliberately not searched, so a stray binary elsewhere
 * (e.g. `~/.gemini/bin/agy`) does not count as an installation.
 *
 * Used by the agy auth, models and runtime providers and by the Shell tab.
 */
export function resolveAgyCliPath(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: AgyPathDependencies = {},
): string | null {
  const existsSync = dependencies.existsSync ?? fs.existsSync;
  const isExecutable = dependencies.isExecutable ?? defaultIsExecutable;
  const homedir = dependencies.homedir ?? os.homedir;

  const configuredPath = env.AGY_CLI_PATH?.trim();
  if (configuredPath) {
    return existsSync(configuredPath) ? configuredPath : null;
  }

  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, 'agy');
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  const userLocalBinary = path.join(homedir(), '.local', 'bin', 'agy');
  return isExecutable(userLocalBinary) ? userLocalBinary : null;
}

/**
 * The agy data roots to read, newest layout first: `AGY_DATA_DIRS`
 * (colon-separated) when set, else `~/.gemini/antigravity-cli` (current CLI)
 * and `~/.gemini/antigravity` (left by older versions). Roots are returned
 * whether or not they exist; callers skip missing ones quietly.
 *
 * Used by the agy sessions provider, synchronizer and session watcher.
 */
export function getAgyDataRoots(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string[] {
  const configured = env.AGY_DATA_DIRS?.trim();
  if (configured) {
    return configured.split(':').map((root) => root.trim()).filter(Boolean);
  }

  const geminiDirectory = path.join(homedir(), '.gemini');
  return [path.join(geminiDirectory, 'antigravity-cli'), path.join(geminiDirectory, 'antigravity')];
}

/**
 * The directory of the current agy CLI's own files (settings, OAuth token),
 * independent of `AGY_DATA_DIRS`, which only redirects where conversations are
 * read from. Used by the auth and models providers.
 */
export function getAgyCliHome(homedir: () => string = os.homedir): string {
  return path.join(homedir(), '.gemini', 'antigravity-cli');
}

/**
 * Whether agy has been signed in on this machine: only the existence of its
 * OAuth token file is checked. The file's contents are secret and must never
 * be read or logged. Used by the agy auth provider.
 */
export function isAgyOauthTokenPresent(
  homedir: () => string = os.homedir,
  existsSync: (filePath: string) => boolean = fs.existsSync,
): boolean {
  return existsSync(path.join(getAgyCliHome(homedir), 'antigravity-oauth-token'));
}

/**
 * agy conversation ids are UUIDs. Every id must pass this before it is joined
 * into a path under an agy data root or passed to the CLI.
 */
export const AGY_CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` is a well-formed agy conversation id; see `AGY_CONVERSATION_ID_PATTERN`. */
export function isAgyConversationId(value: unknown): value is string {
  return typeof value === 'string' && AGY_CONVERSATION_ID_PATTERN.test(value);
}
