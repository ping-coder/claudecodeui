import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { getAgyDataRoots, isAgyConversationId } from '@/shared/agy-cli-path.js';
import { parseFilesInputTag, parseImagesInputTag } from '@/shared/image-attachments.js';
import type {
  AgyConversationSummary,
  AgyTokenUsage,
  AgyTranscript,
  AgyTranscriptStep,
} from '@/shared/types.js';
import {
  buildAgyTokenUsage,
  parseAgyTimestampMs,
  readObjectRecord,
  readOptionalString,
  unwrapAgyUserInput,
} from '@/shared/utils.js';

/**
 * Read-only access to agy's own conversation store under each data root
 * (`~/.gemini/antigravity-cli`, the legacy `~/.gemini/antigravity`, or the
 * `AGY_DATA_DIRS` override):
 *
 * - `conversation_summaries.db`: the conversation index (SQLite, WAL mode);
 * - `brain/<id>/.system_generated/logs/transcript_full.jsonl` (or the
 *   shortened `transcript.jsonl`): one JSON step per line;
 * - `conversations/<id>.db`: agy's private per-conversation state, which is
 *   only ever stat()ed here for its mtime, never opened.
 *
 * Nothing here writes under a data root, and SQLite never opens a file there:
 * even a read-only connection writes read marks into agy's live `-shm`, and
 * creates `-wal`/`-shm` (and leaves them behind) when agy's last connection
 * closes just as it opens. The index is always read from a private copy.
 */

const SUMMARIES_DATABASE_FILE_NAME = 'conversation_summaries.db';
const SUMMARIES_WAL_FILE_NAME = `${SUMMARIES_DATABASE_FILE_NAME}-wal`;
const FULL_TRANSCRIPT_FILE_NAME = 'transcript_full.jsonl';
const SHORT_TRANSCRIPT_FILE_NAME = 'transcript.jsonl';
/** Preference order: the shortened transcript is only a fallback. */
const TRANSCRIPT_FILE_NAMES = [FULL_TRANSCRIPT_FILE_NAME, SHORT_TRANSCRIPT_FILE_NAME];
const BRAIN_DIRECTORY_NAME = 'brain';
const TRANSCRIPT_DIRECTORY_SEGMENTS = ['.system_generated', 'logs'];
const HISTORY_FILE_NAME = 'history.jsonl';
const LEGACY_ROOT_NAME = 'antigravity';

/**
 * Nothing else opens the private copy, so a lock wait (synchronous in
 * better-sqlite3, blocking the event loop) stays short.
 */
const SUMMARIES_BUSY_TIMEOUT_MS = 200;

/** A copy that comes out torn (agy checkpointed meanwhile) is taken again after each of these pauses. */
const SUMMARIES_READ_RETRY_DELAYS_MS = [50, 100, 200];

/** Code of the error raised when agy's index changed while it was being copied. */
const INDEX_CHANGED_ERROR_CODE = 'AGY_INDEX_CHANGED';

/**
 * Error codes (prefixes) a fresh copy of the index may not hit again: a copy
 * torn while agy checkpointed or rewrote the index (malformed, not a database,
 * changed while copying), and lock errors.
 */
const RETRYABLE_READ_ERROR_CODES = [
  'SQLITE_CORRUPT',
  'SQLITE_NOTADB',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  INDEX_CHANGED_ERROR_CODE,
];

/** The first prompt sits near the top; past this many lines a transcript is not scanned for it. */
const FIRST_PROMPT_SCAN_LINE_LIMIT = 50;

/** Named columns only: `raw_summary` is a large blob nothing here needs. */
const SUMMARY_COLUMNS = [
  'conversation_id',
  'title',
  'preview',
  'last_modified_time',
  'workspace_uris',
  'parent_conversation_id',
  'nesting_depth',
  'killed',
] as const;

type AgySummaryRow = Record<(typeof SUMMARY_COLUMNS)[number], unknown>;

type AgyTranscriptLocation = {
  filePath: string;
  isComplete: boolean;
  modifiedAt: Date;
};

/**
 * The conversations of every data root. `readRoots` lists the roots whose
 * index was read, so the scan is complete for them. `unreadableRoots` lists
 * roots whose index exists but could not be read (still torn after retries,
 * corrupt or unreadable); their conversations are missing from `summaries`.
 * Roots without an index are in neither list.
 */
type AgyConversationSummaryScan = {
  summaries: AgyConversationSummary[];
  readRoots: string[];
  unreadableRoots: string[];
};

type AgyDataPathKind =
  | { kind: 'directory' }
  | { kind: 'index' }
  | { kind: 'transcript'; conversationId: string };

const statOrNull = async (filePath: string) => {
  try {
    return await fsp.stat(filePath);
  } catch {
    return null;
  }
};

const isFile = async (filePath: string): Promise<boolean> => Boolean((await statOrNull(filePath))?.isFile());

const isRetryableIndexReadError = (error: unknown): boolean => {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return (typeof code === 'string' && RETRYABLE_READ_ERROR_CODES.some((prefix) => code.startsWith(prefix)))
    || (typeof message === 'string' && /malformed/i.test(message));
};

const isMissingFileError = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'ENOENT';

/** agy stores booleans as 0/1, but tolerate text and real booleans too. */
const isTruthyFlag = (value: unknown): boolean => {
  if (typeof value === 'string') {
    return ['1', 'true', 't', 'yes'].includes(value.trim().toLowerCase());
  }
  if (typeof value === 'bigint') {
    return value !== 0n;
  }
  return Boolean(value);
};

/** Subagent conversations hang off a parent; a killed conversation was discarded. */
const isListedConversation = (row: AgySummaryRow): boolean => {
  const nestingDepth = Number(row.nesting_depth ?? 0);
  return !(Number.isFinite(nestingDepth) && nestingDepth > 0)
    && !readOptionalString(row.parent_conversation_id)
    && !isTruthyFlag(row.killed);
};

/** Relative path segments of `filePath` under `root`, or null when it is not inside it. */
const readSegmentsUnderRoot = (root: string, filePath: string): string[] | null => {
  const relativePath = path.relative(path.resolve(root), path.resolve(filePath));
  if (!relativePath) {
    return [];
  }
  if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return null;
  }
  return relativePath.split(path.sep);
};

/** True when `candidate` resolves (symlinks included) to a path strictly inside `root`. */
const resolvesInsideRoot = async (root: string, candidate: string): Promise<boolean> => {
  try {
    const [realRoot, realCandidate] = await Promise.all([fsp.realpath(root), fsp.realpath(candidate)]);
    const segments = readSegmentsUnderRoot(realRoot, realCandidate);
    return segments !== null && segments.length > 0;
  } catch {
    return false;
  }
};

/**
 * Finds a conversation's transcript inside one root: the full transcript,
 * else the shortened one. The id must already be validated.
 */
const locateTranscript = async (root: string, conversationId: string): Promise<AgyTranscriptLocation | null> => {
  const logsDirectory = path.join(root, BRAIN_DIRECTORY_NAME, conversationId, ...TRANSCRIPT_DIRECTORY_SEGMENTS);
  for (const fileName of TRANSCRIPT_FILE_NAMES) {
    const filePath = path.join(logsDirectory, fileName);
    const stats = await statOrNull(filePath);
    if (!stats?.isFile() || !(await resolvesInsideRoot(root, filePath))) {
      continue;
    }

    return {
      filePath,
      isComplete: fileName === FULL_TRANSCRIPT_FILE_NAME,
      modifiedAt: stats.mtime,
    };
  }

  return null;
};

const parseTranscriptLines = (content: string): AgyTranscriptStep[] => {
  const steps: AgyTranscriptStep[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const step = readObjectRecord(JSON.parse(line));
      if (step) {
        steps.push(step as AgyTranscriptStep);
      }
    } catch {
      // agy may still be writing the last line.
    }
  }
  return steps;
};

/** Reads JSON lines until `visit` returns true or the line budget runs out; unreadable files yield nothing. */
const scanJsonLines = async (
  filePath: string,
  visit: (record: Record<string, unknown>) => boolean,
  lineLimit = Number.POSITIVE_INFINITY,
): Promise<void> => {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let linesRead = 0;
  try {
    for await (const line of lines) {
      linesRead += 1;
      if (linesRead > lineLimit) {
        return;
      }
      if (!line.trim()) {
        continue;
      }
      let record: Record<string, unknown> | null = null;
      try {
        record = readObjectRecord(JSON.parse(line));
      } catch {
        // A malformed line says nothing about the others.
      }
      if (record && visit(record)) {
        return;
      }
    }
  } catch {
    // A missing or unreadable file has nothing to offer.
  } finally {
    lines.close();
    stream.destroy();
  }
};

/** What the user typed in a `USER_INPUT` step, without agy's wrapper or attachment blocks. */
const readUserPromptText = (content: unknown): string => {
  if (typeof content !== 'string') {
    return '';
  }
  const withoutImages = parseImagesInputTag(unwrapAgyUserInput(content)).text;
  return parseFilesInputTag(withoutImages).text.trim();
};

const readFirstUserPrompt = async (root: string, conversationId: string): Promise<string | null> => {
  const transcript = await locateTranscript(root, conversationId);
  if (!transcript) {
    return null;
  }

  let prompt: string | null = null;
  await scanJsonLines(transcript.filePath, (step) => {
    if (readOptionalString(step.type) !== 'USER_INPUT') {
      return false;
    }
    prompt = readUserPromptText(step.content) || null;
    return prompt !== null;
  }, FIRST_PROMPT_SCAN_LINE_LIMIT);
  return prompt;
};

/**
 * First `display` text per conversation from `<root>/history.jsonl`, the
 * prompt history agy may keep. Its id field name is unverified, so the usual
 * spellings are all accepted.
 */
const readHistoryDisplays = async (root: string): Promise<Map<string, string>> => {
  const displays = new Map<string, string>();
  const historyPath = path.join(root, HISTORY_FILE_NAME);
  if (!(await isFile(historyPath))) {
    return displays;
  }

  await scanJsonLines(historyPath, (entry) => {
    const conversationId = readOptionalString(
      entry.conversation_id ?? entry.conversationId ?? entry.session_id ?? entry.sessionId,
    );
    const display = readOptionalString(entry.display);
    if (conversationId && display && !displays.has(conversationId)) {
      displays.set(conversationId, display);
    }
    return false;
  });
  return displays;
};

/** `workspace_uris` is a JSON array of `file:` URIs; a bare URI (or one per line) is tolerated. */
const readWorkspaceUris = (value: unknown): string[] => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    return [];
  }

  if (!text.startsWith('[')) {
    return text.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => (typeof entry === 'string' ? entry : readOptionalString(readObjectRecord(entry)?.uri) ?? ''))
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

/**
 * The conversation's project: its first workspace URI as a decoded path (so
 * `file:///a%20b` is `/a b`; `normalizeProjectPath` would mangle the URI), or
 * the home directory when that entry is missing or not a local path.
 */
const resolveWorkspacePath = (workspaceUris: unknown): string => {
  const firstUri = readWorkspaceUris(workspaceUris)[0];
  if (firstUri) {
    try {
      if (firstUri.startsWith('file:')) {
        return fileURLToPath(firstUri);
      }
      if (path.isAbsolute(firstUri)) {
        return firstUri;
      }
    } catch {
      // A URI with a remote host or broken escapes is not a local project.
    }
  }
  return os.homedir();
};

const readFileMtimeMs = async (filePath: string): Promise<number | null> => {
  const stats = await statOrNull(filePath);
  const mtimeMs = stats?.isFile() ? Math.floor(stats.mtimeMs) : 0;
  return mtimeMs > 0 ? mtimeMs : null;
};

/**
 * Dates a conversation whose index row carries agy's zero time: the
 * transcript's mtime, else the conversation database's (stat only). Null when
 * neither exists; callers must not substitute "now".
 */
const readFallbackModifiedMs = async (root: string, conversationId: string): Promise<number | null> => {
  const transcript = await locateTranscript(root, conversationId);
  if (transcript) {
    return Math.floor(transcript.modifiedAt.getTime());
  }
  return readFileMtimeMs(path.join(root, 'conversations', `${conversationId}.db`));
};

const selectSummaryRows = (database: Database.Database): AgySummaryRow[] => {
  const columns = new Set(
    (database.prepare('PRAGMA table_info(conversation_summaries)').all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  // No index table yet (or a layout this reader does not know): nothing to list.
  if (!columns.has('conversation_id')) {
    return [];
  }

  // Older agy builds may lack some columns; read those as NULL.
  const selectList = SUMMARY_COLUMNS
    .map((column) => (columns.has(column) ? `"${column}"` : `NULL AS "${column}"`))
    .join(', ');
  return database.prepare(`SELECT ${selectList} FROM conversation_summaries`).all() as AgySummaryRow[];
};

/**
 * Copies a file by reading it to EOF and writing the bytes out. Unlike
 * `fs.copyFile` (copy_file_range/sendfile in libuv), a read cannot hang when
 * SQLite shrinks the file mid-copy (WAL truncation, VACUUM); a short or torn
 * copy is caught by the change check and the retries instead. agy's index and
 * WAL are small, so holding them in memory is fine.
 */
const copyFileContents = async (sourcePath: string, targetPath: string): Promise<void> => {
  const contents = await fsp.readFile(sourcePath);
  await fsp.writeFile(targetPath, contents, { mode: 0o600 });
};

/**
 * Copies agy's index to `snapshotPath`, with its `-wal` when there is one so
 * the commits still in the WAL are seen. The `-shm` is never copied: it only
 * coordinates live connections, and SQLite rebuilds it from the WAL.
 *
 * The index goes first: a checkpoint running meanwhile only writes pages the
 * WAL (copied after) still holds. Throws a retryable error when the index
 * itself changed during the copy, since the copy may then be torn.
 */
const copySummariesIndex = async (databasePath: string, snapshotPath: string): Promise<void> => {
  const before = await fsp.stat(databasePath);
  await copyFileContents(databasePath, snapshotPath);
  try {
    await copyFileContents(`${databasePath}-wal`, `${snapshotPath}-wal`);
  } catch (error) {
    // No WAL: agy has no connection open, or its last one just checkpointed
    // and removed it (a checkpoint that wrote pages fails the check below).
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
  const after = await fsp.stat(databasePath);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw Object.assign(new Error(`${databasePath} changed while it was being copied`), {
      code: INDEX_CHANGED_ERROR_CODE,
    });
  }
};

/**
 * Runs `read` against a private copy of agy's index (it is small), made in a
 * fresh directory only this user can enter and removed afterwards. agy's own
 * files are only ever copied, never opened by SQLite.
 */
const withSummariesSnapshot = async <T>(
  databasePath: string,
  read: (database: Database.Database) => T,
): Promise<T> => {
  const snapshotDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'cloudcli-agy-index-'));
  try {
    await fsp.chmod(snapshotDirectory, 0o700);
    const snapshotPath = path.join(snapshotDirectory, SUMMARIES_DATABASE_FILE_NAME);
    await copySummariesIndex(databasePath, snapshotPath);
    // Read-write on the private copy, so SQLite can recover a copied WAL.
    const database = new Database(snapshotPath, { fileMustExist: true, timeout: SUMMARIES_BUSY_TIMEOUT_MS });
    try {
      return read(database);
    } finally {
      database.close();
    }
  } finally {
    await fsp.rm(snapshotDirectory, { recursive: true, force: true });
  }
};

/**
 * Raw index rows of one root, or null when the root or its index does not
 * exist. Throws when the index exists but cannot be read, after taking a
 * fresh copy a few times when one comes out torn.
 */
const readRootSummaryRows = async (root: string): Promise<AgySummaryRow[] | null> => {
  const databasePath = path.join(root, SUMMARIES_DATABASE_FILE_NAME);
  if (!(await isFile(databasePath))) {
    return null;
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withSummariesSnapshot(databasePath, selectSummaryRows);
    } catch (error) {
      const retryDelayMs = SUMMARIES_READ_RETRY_DELAYS_MS[attempt];
      if (!isRetryableIndexReadError(error) || retryDelayMs === undefined) {
        throw error;
      }
      await sleep(retryDelayMs);
    }
  }
};

const buildRootSummaries = async (root: string, rows: AgySummaryRow[]): Promise<AgyConversationSummary[]> => {
  const summaries: AgyConversationSummary[] = [];
  let historyDisplays: Map<string, string> | null = null;

  for (const row of rows) {
    const conversationId = readOptionalString(row.conversation_id);
    if (!isAgyConversationId(conversationId) || !isListedConversation(row)) {
      continue;
    }

    const preview = readOptionalString(row.preview) ?? null;
    let title = readOptionalString(row.title) ?? preview ?? await readFirstUserPrompt(root, conversationId);
    if (!title) {
      historyDisplays ??= await readHistoryDisplays(root);
      title = historyDisplays.get(conversationId) ?? null;
    }

    summaries.push({
      conversationId,
      root,
      title,
      preview,
      projectPath: resolveWorkspacePath(row.workspace_uris),
      lastModifiedMs: parseAgyTimestampMs(row.last_modified_time)
        ?? await readFallbackModifiedMs(root, conversationId),
    });
  }

  return summaries;
};

/**
 * Lists the top-level conversations of every agy data root.
 *
 * Missing roots and roots without an index contribute nothing and are not
 * errors. A root whose index was read is reported in `readRoots`; one whose
 * index exists but cannot be read is logged and reported in `unreadableRoots`.
 * A conversation found in several roots is reported once, from the root with
 * the newest modification time. Newest first.
 *
 * Used by the agy session synchronizer.
 */
export async function readAgyConversationSummaries(
  roots: string[] = getAgyDataRoots(),
): Promise<AgyConversationSummaryScan> {
  const newestByConversationId = new Map<string, AgyConversationSummary>();
  const readRoots: string[] = [];
  const unreadableRoots: string[] = [];

  for (const root of roots) {
    let rootSummaries: AgyConversationSummary[];
    try {
      const rows = await readRootSummaryRows(root);
      if (!rows) {
        continue;
      }
      rootSummaries = await buildRootSummaries(root, rows);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[AgyStore] Failed to read ${path.join(root, SUMMARIES_DATABASE_FILE_NAME)}:`, message);
      unreadableRoots.push(root);
      continue;
    }

    readRoots.push(root);
    for (const summary of rootSummaries) {
      const kept = newestByConversationId.get(summary.conversationId);
      if (!kept || (summary.lastModifiedMs ?? -1) > (kept.lastModifiedMs ?? -1)) {
        newestByConversationId.set(summary.conversationId, summary);
      }
    }
  }

  const summaries = [...newestByConversationId.values()]
    .sort((left, right) => (right.lastModifiedMs ?? -1) - (left.lastModifiedMs ?? -1));
  return { summaries, readRoots, unreadableRoots };
}

/**
 * Reads a conversation's transcript: `transcript_full.jsonl` from the first
 * root that has one, else the shortened `transcript.jsonl` (`isComplete`
 * false), else null. The id is validated and the file must resolve inside its
 * root. agy's per-conversation database and `chunks/` are never read.
 *
 * Used by the agy sessions provider (history) and the provider token-usage
 * service.
 */
export async function readAgyTranscript(
  conversationId: string,
  roots: string[] = getAgyDataRoots(),
): Promise<AgyTranscript | null> {
  if (!isAgyConversationId(conversationId)) {
    return null;
  }

  for (const root of roots) {
    const location = await locateTranscript(root, conversationId);
    if (!location) {
      continue;
    }

    let content: string;
    try {
      content = await fsp.readFile(location.filePath, 'utf8');
    } catch {
      continue;
    }

    return {
      conversationId,
      root,
      filePath: location.filePath,
      isComplete: location.isComplete,
      modifiedAt: location.modifiedAt.toISOString(),
      steps: parseTranscriptLines(content),
    };
  }

  return null;
}

/**
 * Context usage from the latest planner step that reports token counts, or
 * undefined when the transcript has none.
 *
 * Used by the agy sessions provider (history `tokenUsage`) and the provider
 * token-usage service, so both report the same numbers.
 */
export function summarizeAgyTranscriptTokenUsage(transcript: AgyTranscript | null): AgyTokenUsage | undefined {
  const steps = transcript?.steps ?? [];
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (readOptionalString(step.type) !== 'PLANNER_RESPONSE') {
      continue;
    }
    const usage = buildAgyTokenUsage(step);
    if (usage) {
      return usage;
    }
  }
  return undefined;
}

/**
 * The first root (in the given order, newest layout first) that holds the
 * conversation: its `brain/<id>` folder, its `conversations/<id>.db`, or, for
 * a conversation with no steps yet, a row in the root's index. Null when no
 * root has it or the id is invalid.
 *
 * Used by the agy runtime to explain a failed resume of a conversation that
 * only the legacy root holds.
 */
export async function findAgyConversationRoot(
  conversationId: string,
  roots: string[] = getAgyDataRoots(),
): Promise<string | null> {
  if (!isAgyConversationId(conversationId)) {
    return null;
  }

  for (const root of roots) {
    const brainStats = await statOrNull(path.join(root, BRAIN_DIRECTORY_NAME, conversationId));
    if (brainStats?.isDirectory() || await isFile(path.join(root, 'conversations', `${conversationId}.db`))) {
      return root;
    }

    try {
      const rows = await readRootSummaryRows(root);
      if (rows?.some((row) => readOptionalString(row.conversation_id) === conversationId)) {
        return root;
      }
    } catch {
      // An unreadable index is no evidence either way.
    }
  }

  return null;
}

/**
 * True for the data root older agy versions used (`~/.gemini/antigravity`),
 * which the current CLI may not resume conversations from.
 *
 * Used by the agy runtime's resume-failure hint.
 */
export function isLegacyAgyRoot(root: string): boolean {
  return path.basename(path.resolve(root)) === LEGACY_ROOT_NAME;
}

/**
 * Says what `filePath` is within the agy data root `root`: a directory on the
 * way to a transcript (`brain`, `brain/<id>`, `…/.system_generated`,
 * `…/logs`; the root itself counts too), the conversation index
 * (`conversation_summaries.db` or its `-wal`), or a transcript. Null for
 * everything else, including the index's `-shm` (agy's live connections
 * touch it on every access; it holds no data), other brain artifacts
 * (`scratch/`, `.user_uploaded/`, …) and paths outside the root. Conversation
 * ids must be valid.
 *
 * Used by the sessions watcher (what to watch) and the agy session
 * synchronizer (what a watcher event names).
 */
export function classifyAgyDataPath(root: string, filePath: string): AgyDataPathKind | null {
  const segments = readSegmentsUnderRoot(root, filePath);
  if (!segments) {
    return null;
  }

  const [first, conversationId, ...rest] = segments;
  if (segments.length === 0) {
    return { kind: 'directory' };
  }
  if (segments.length === 1) {
    if (first === SUMMARIES_DATABASE_FILE_NAME || first === SUMMARIES_WAL_FILE_NAME) {
      return { kind: 'index' };
    }
    return first === BRAIN_DIRECTORY_NAME ? { kind: 'directory' } : null;
  }
  if (first !== BRAIN_DIRECTORY_NAME || !isAgyConversationId(conversationId)) {
    return null;
  }

  const directoryDepth = Math.min(rest.length, TRANSCRIPT_DIRECTORY_SEGMENTS.length);
  for (let index = 0; index < directoryDepth; index += 1) {
    if (rest[index] !== TRANSCRIPT_DIRECTORY_SEGMENTS[index]) {
      return null;
    }
  }
  if (rest.length <= TRANSCRIPT_DIRECTORY_SEGMENTS.length) {
    return { kind: 'directory' };
  }
  if (rest.length === TRANSCRIPT_DIRECTORY_SEGMENTS.length + 1 && TRANSCRIPT_FILE_NAMES.includes(rest[rest.length - 1])) {
    return { kind: 'transcript', conversationId };
  }
  return null;
}
