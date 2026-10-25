import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Test environment for the agy provider: a temporary HOME holding both agy
 * data roots, with `AGY_DATA_DIRS` pointing at them and `AGY_CLI_PATH`
 * cleared, so nothing reads or writes the developer's real `~/.gemini`.
 */

/** This folder: the committed agy fixtures (transcripts, stream samples). */
export const AGY_FIXTURE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

export type AgyTestRoots = {
  home: string;
  /** `<home>/.gemini/antigravity-cli`, the current CLI's root (not created). */
  cliRoot: string;
  /** `<home>/.gemini/antigravity`, the legacy root (not created). */
  legacyRoot: string;
  restore: () => Promise<void>;
};

const ENVIRONMENT_KEYS = ['HOME', 'USERPROFILE', 'AGY_DATA_DIRS', 'AGY_CLI_PATH'] as const;

/**
 * Points HOME at a fresh temporary directory and `AGY_DATA_DIRS` at its two
 * agy roots (pass `useDataDirsOverride: false` to leave `AGY_DATA_DIRS` unset
 * so the roots are derived from HOME). `restore` puts the environment back and
 * deletes the directory.
 */
export async function createAgyTestRoots(options: { useDataDirsOverride?: boolean } = {}): Promise<AgyTestRoots> {
  const saved = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
  const home = await mkdtemp(path.join(os.tmpdir(), 'agy-test-home-'));
  const cliRoot = path.join(home, '.gemini', 'antigravity-cli');
  const legacyRoot = path.join(home, '.gemini', 'antigravity');

  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.AGY_CLI_PATH;
  if (options.useDataDirsOverride === false) {
    delete process.env.AGY_DATA_DIRS;
  } else {
    process.env.AGY_DATA_DIRS = `${cliRoot}:${legacyRoot}`;
  }

  return {
    home,
    cliRoot,
    legacyRoot,
    restore: async () => {
      for (const key of ENVIRONMENT_KEYS) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** Directory of a conversation's transcripts inside a data root. */
export function agyTranscriptDirectory(root: string, conversationId: string): string {
  return path.join(root, 'brain', conversationId, '.system_generated', 'logs');
}

/**
 * Copies a committed transcript fixture into a root as
 * `brain/<id>/.system_generated/logs/<targetName>`. Returns the file path.
 */
export function placeAgyTranscript(
  root: string,
  conversationId: string,
  fixtureName = 'transcript_full.jsonl',
  targetName = fixtureName,
): string {
  const directory = agyTranscriptDirectory(root, conversationId);
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, targetName);
  fs.copyFileSync(path.join(AGY_FIXTURE_DIRECTORY, fixtureName), target);
  return target;
}

/** Sets a file's mtime (and atime) to the given epoch milliseconds. */
export function setFileTime(filePath: string, epochMs: number): void {
  const time = new Date(epochMs);
  fs.utimesSync(filePath, time, time);
}

/**
 * Every entry under `root` (the root included) to prove a reader left a data
 * root untouched: each file with its size, mtime and content hash, and each
 * directory with its mtime, so even a file created and removed again shows.
 * Nothing is exempt, not even the index's `-shm`: CloudCLI never opens agy's
 * files with SQLite, so it must not write read marks there either.
 */
export function snapshotTree(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const visit = (directory: string) => {
    snapshot.set(`${path.relative(root, directory)}${path.sep}`, `directory:${fs.statSync(directory).mtimeMs}`);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      const stats = fs.statSync(fullPath);
      const hash = createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
      snapshot.set(path.relative(root, fullPath), `${stats.size}:${stats.mtimeMs}:${hash}`);
    }
  };
  if (fs.existsSync(root)) {
    visit(root);
  }
  return snapshot;
}
