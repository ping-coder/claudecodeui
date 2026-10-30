import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { LiveClaudeRun } from '@/shared/types.js';

/**
 * One Claude CLI process that is currently producing a response.
 *
 * `providerSessionId` is Claude's own session id, which is what the registry
 * records; callers map it onto an app session themselves.
 */
type LiveClaudeCliSession = {
  providerSessionId: string;
  startedAt: number;
};

/**
 * What one registry file says about its process, before anything has checked
 * that the process is still the one it describes.
 */
type ClaudeCliRegistryRecord = {
  providerSessionId: string;
  pid: number;
  procStart: unknown;
  /** The CLI's own word (`busy`, `idle`, ...), kept as written. */
  status: unknown;
  /** When the process started (epoch ms), or null when the file does not say. */
  startedAt: number | null;
  /** The `CLAUDE_CODE_ENTRYPOINT` the process runs under, or null when the file does not say. */
  entrypoint: string | null;
};

/**
 * Claude Code keeps one file per running session here, named `<pid>.json`.
 * The directory belongs to the CLI, not to CloudCLI: it is only ever read.
 */
const registryDirectory = () => path.join(os.homedir(), '.claude', 'sessions');

/**
 * Upper bound on registry files inspected per poll.
 *
 * The running-sessions endpoint is polled continuously, so a directory left
 * full of stale files by repeated crashes must not turn every poll into
 * unbounded filesystem work. Real installations hold a handful of entries.
 */
const MAX_REGISTRY_FILES = 256;

/**
 * Registry statuses of a CLI that has no agent or workflow of its own left
 * running.
 *
 * The CLI writes `busy` while a turn runs and also whenever an agent, a
 * teammate or a workflow it started is unfinished. It writes `waiting` while
 * a turn waits on a permission prompt. It writes `idle`, or `shell` (idle
 * with only background shell commands left), only once no such task is
 * outstanding. So a process at rest has nothing that could still report,
 * and counting it would only let it vouch for another process's launch: an
 * idle Shell-tab `claude --resume` would keep a dead CloudCLI run's
 * unreported workflow `running` for as long as the tab's REPL lives.
 */
const AT_REST_STATUSES: ReadonlySet<unknown> = new Set(['idle', 'shell']);

/**
 * Whether `pid` is still the process the registry recorded.
 *
 * A registry file outlives a crash, so its mere presence proves nothing. The
 * signal-0 probe answers "does this pid exist" (EPERM means it exists but is
 * owned by someone else, which still counts), and on Linux the recorded
 * `procStart` is compared against the kernel's start-time for that pid so a
 * reused pid cannot be mistaken for the original process.
 */
async function isRecordedProcessAlive(pid: number, procStart: unknown): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EPERM') {
      return false;
    }
  }

  if (process.platform !== 'linux' || typeof procStart !== 'string' || !procStart) {
    return true;
  }

  try {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
    // The comm field is parenthesised and may itself contain spaces, so the
    // fields are counted from the last ')'. starttime is the 22nd field
    // overall, i.e. the 20th of what follows the comm field.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] === procStart;
  } catch {
    // No procfs entry means the process is gone between the two checks.
    return false;
  }
}

/** Reads one registry file, returning null for anything that does not name a session and a pid. */
async function readRegistryRecord(filePath: string): Promise<ClaudeCliRegistryRecord | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    // Unreadable, half-written or malformed entries are simply not evidence
    // of a running session.
    return null;
  }

  const record = parsed as Record<string, unknown> | null;
  if (!record || typeof record !== 'object') {
    return null;
  }

  const providerSessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
  const pid = typeof record.pid === 'number' ? record.pid : NaN;
  if (!providerSessionId || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  return {
    providerSessionId,
    pid,
    procStart: record.procStart,
    status: record.status,
    startedAt: typeof record.startedAt === 'number' ? record.startedAt : null,
    entrypoint: typeof record.entrypoint === 'string' && record.entrypoint ? record.entrypoint : null,
  };
}

/**
 * Returns the registry records `isWanted` accepts whose process is still the
 * one they describe.
 *
 * Records are filtered before the liveness check, so a lookup for one session
 * probes only that session's processes rather than every file's.
 */
async function readLiveRegistryRecords(
  directory: string,
  isWanted: (record: ClaudeCliRegistryRecord) => boolean,
): Promise<ClaudeCliRegistryRecord[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(directory);
  } catch {
    // No registry directory at all is the normal case for an install that has
    // never run the CLI, and an unreadable one is not worth failing a read for.
    return [];
  }

  // Only the `.json` records are opened; the other files kept in this
  // directory, such as `.key` files, are never read.
  const registryFiles = entries.filter((entry) => entry.endsWith('.json')).slice(0, MAX_REGISTRY_FILES);
  const records = await Promise.all(registryFiles.map(async (entry) => {
    const record = await readRegistryRecord(path.join(directory, entry));
    return record && isWanted(record) && (await isRecordedProcessAlive(record.pid, record.procStart))
      ? record
      : null;
  }));

  return records.filter((record): record is ClaudeCliRegistryRecord => record !== null);
}

/**
 * Lists the Claude CLI sessions that are mid-turn right now.
 *
 * Used by the providers module's sessions service so the running-sessions poll
 * also reports turns driven outside CloudCLI's own chat runs — including the
 * `claude` processes CloudCLI itself spawns for the Shell view, which live in
 * the PTY map rather than the chat-run registry. Liveness is ephemeral, so it
 * is recomputed on every read instead of being cached or persisted.
 *
 * `directory` defaults to the CLI's own registry; tests point it at a fixture.
 */
export async function listBusyClaudeCliSessions(directory = registryDirectory()): Promise<LiveClaudeCliSession[]> {
  const busy = await readLiveRegistryRecords(directory, (record) => record.status === 'busy');
  return busy.map((record) => ({
    providerSessionId: record.providerSessionId,
    startedAt: record.startedAt ?? Date.now(),
  }));
}

/**
 * The live Claude CLI processes registered for `providerSessionId` that may
 * still be running background work they launched: each one's start (epoch ms)
 * and the entrypoint it runs under. Empty when there are none.
 *
 * Used by the providers module's Claude sessions provider to tell whether an
 * unreported background launch can still report back when the process that
 * wrote it is not CloudCLI's own run: a Shell-tab `claude --resume`, a REPL
 * in a terminal, or a run of another CloudCLI instance sharing `~/.claude`.
 * The registry's `startedAt` is the process's start, so a launch row older
 * than it belongs to an earlier process. Its `entrypoint` is the one the
 * process stamps on every row it writes, so a launch can be matched to the
 * kind of process that wrote it.
 *
 * A process at rest (`idle` or `shell`) is left out, since nothing it
 * launched is still running (see `AT_REST_STATUSES`). A process mid-turn
 * (`busy`), at a permission prompt (`waiting`), or with no status at all is
 * kept: an Agent SDK print-mode process never writes one. Every such process
 * is listed rather than one chosen among them, because which one wrote a
 * given launch is the caller's question. Like the busy list, this is never
 * cached.
 *
 * `directory` defaults to the CLI's own registry; tests point it at a fixture.
 */
export async function listLiveClaudeCliRuns(
  providerSessionId: string,
  directory = registryDirectory(),
): Promise<LiveClaudeRun[]> {
  if (!providerSessionId) {
    return [];
  }

  // A record without `startedAt` says the process is up but not since when,
  // which cannot place a launch before or after it.
  const live = await readLiveRegistryRecords(
    directory,
    (record) => record.providerSessionId === providerSessionId
      && record.startedAt !== null
      && !AT_REST_STATUSES.has(record.status),
  );
  return live.flatMap((record) => (
    record.startedAt === null ? [] : [{ startedAt: record.startedAt, entrypoint: record.entrypoint }]
  ));
}

/**
 * Whether any live Claude CLI process is registered for `providerSessionId`,
 * at rest or not: a Shell-tab `claude --resume`, a REPL in a terminal, or a
 * run of another CloudCLI instance sharing `~/.claude`. Unlike
 * `listLiveClaudeCliRuns`, a process at rest counts: it holds the session's
 * cron jobs, which it brought back from the transcript and fires itself.
 *
 * Used by the providers module's Claude sessions provider before it reports
 * a session's loops as paused, which a resume would otherwise run twice.
 *
 * `directory` defaults to the CLI's own registry; tests point it at a fixture.
 */
export async function hasLiveClaudeCliProcess(
  providerSessionId: string,
  directory = registryDirectory(),
): Promise<boolean> {
  if (!providerSessionId) {
    return false;
  }
  const live = await readLiveRegistryRecords(directory, (record) => record.providerSessionId === providerSessionId);
  return live.length > 0;
}
