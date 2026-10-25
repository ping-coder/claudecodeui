import path from 'node:path';

import { appConfigDb, sessionsDb } from '@/modules/database/index.js';
import { classifyAgyDataPath, readAgyConversationSummaries } from '@/modules/providers/list/agy/agy-store.js';
import { getAgyDataRoots } from '@/shared/agy-cli-path.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import type { AgyConversationSummary } from '@/shared/types.js';
import { normalizeSessionName, readObjectRecord } from '@/shared/utils.js';

const FALLBACK_SESSION_NAME = 'Untitled';

/**
 * app_config key holding each data root's watermark: a JSON object mapping
 * the resolved root path to epoch milliseconds. A scan indexes only the
 * conversations agy modified at or after their root's watermark; a root
 * without one is scanned in full.
 *
 * agy keeps its own marks instead of the scan cursor all providers share:
 * builds that do not know agy (after a `cloudcli-ctl rollback`, say) keep
 * advancing that cursor without indexing agy, which would hide everything agy
 * wrote meanwhile. Those builds never write this key, so the first scan after
 * a re-deploy covers the gap. A root that fails to read keeps its mark rather
 * than being scanned in full again, which would bring back every session the
 * user deleted from it.
 */
const ROOT_WATERMARKS_KEY = 'agy_root_watermarks';

/**
 * A scan's watermark sits this long before the scan started, so a change agy
 * dated slightly before the scan but committed after the index was copied is
 * still new to the next scan.
 */
const WATERMARK_SAFETY_MARGIN_MS = 5_000;

type AgyArtifact =
  | { kind: 'index' }
  | { kind: 'transcript'; conversationId: string };

type IndexedSessionRow = NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;

/** Watermarks are keyed by resolved path, so `AGY_DATA_DIRS` spellings of one root share theirs. */
const toWatermarkKey = (root: string): string => path.resolve(root);

/**
 * True when agy modified the conversation at or after `watermarkMs`; every
 * conversation counts for a root that has no watermark. Undated
 * conversations only enter full scans.
 */
const isModifiedSince = (summary: AgyConversationSummary, watermarkMs: number | undefined): boolean =>
  watermarkMs === undefined || (summary.lastModifiedMs !== null && summary.lastModifiedMs >= watermarkMs);

/**
 * True when the conversation's modification time moved past the one
 * `recorded` holds for it, or `recorded` has none. An undated conversation
 * never counts as moved.
 */
const hasMovedSince = (recorded: Map<string, number | null>, summary: AgyConversationSummary): boolean => {
  if (!recorded.has(summary.conversationId)) {
    return true;
  }
  const recordedMs = recorded.get(summary.conversationId) ?? null;
  return summary.lastModifiedMs !== null && (recordedMs === null || summary.lastModifiedMs > recordedMs);
};

/**
 * Indexes Antigravity CLI (agy) conversations from each data root's
 * `conversation_summaries.db` into the sessions table.
 *
 * Rows always carry a null `jsonl_path`: agy's files hold every conversation
 * (index) or belong to agy, so deleting a session in CloudCLI must only ever
 * remove CloudCLI's row. Pending app sessions are never claimed here; a new
 * chat binds to its conversation through the runtime's `init` event.
 *
 * Used by the agy provider as its `sessionSynchronizer` facet.
 */
export class AgySessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'agy' as const;

  /**
   * Modification time per conversation as of the last watcher sync (null when
   * unknown), so an index change only re-indexes and reports the
   * conversations that moved. The process's first scan sets the baseline from
   * every conversation it reads; later scans leave it alone, so a change they
   * index first is still broadcast when the watcher sees it.
   */
  private readonly lastSeenModifiedMs = new Map<string, number | null>();
  private hasBaseline = false;

  /**
   * Modification time per conversation when this process last wrote its row.
   * Once that row is gone the user deleted it, and it is only re-created when
   * agy modifies the conversation again: the watermark's safety margin alone
   * would let a conversation indexed just before a scan back in.
   */
  private readonly indexedModifiedMs = new Map<string, number | null>();

  /** Used by the agy provider; the synchronizer tests inject the clock. */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Upserts the conversations agy modified since their root's watermark (all
   * of a root that has none), then moves the watermark of every root whose
   * index was read. `_since`, the cursor all providers share, is ignored on
   * purpose (see `ROOT_WATERMARKS_KEY`). Returns 0 without error when no root
   * or index exists; a root whose index cannot be read is skipped and keeps
   * its mark.
   */
  async synchronize(_since?: Date): Promise<number> {
    const scanStartedAt = this.now();
    const { summaries, readRoots } = await readAgyConversationSummaries(getAgyDataRoots());
    const watermarks = this.readRootWatermarks();

    let processed = 0;
    for (const summary of summaries) {
      if (!this.hasBaseline) {
        this.lastSeenModifiedMs.set(summary.conversationId, summary.lastModifiedMs);
      }
      const watermarkMs = watermarks.get(toWatermarkKey(summary.root));
      if (isModifiedSince(summary, watermarkMs) && this.indexConversation(summary, watermarkMs) !== null) {
        processed += 1;
      }
    }

    this.recordRootWatermarks(readRoots, scanStartedAt - WATERMARK_SAFETY_MARGIN_MS);
    this.hasBaseline = true;

    return processed;
  }

  /**
   * Handles a watcher event. A transcript change re-indexes its conversation;
   * an index (or index WAL) change re-indexes the conversations whose
   * modification time moved since this process last read them. A
   * conversation without a session row only gets one when agy modified it
   * after its root's watermark, so a session the user deleted stays deleted.
   * Returns the session id to broadcast (the newest changed one), or null.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    const roots = getAgyDataRoots();
    const artifact = this.classifyArtifact(filePath, roots);
    if (!artifact) {
      return null;
    }

    const { summaries } = await readAgyConversationSummaries(roots);
    const watermarks = this.readRootWatermarks();
    if (artifact.kind === 'transcript') {
      const summary = summaries.find((candidate) => candidate.conversationId === artifact.conversationId);
      if (!summary) {
        // agy has not indexed it yet; the index's own change will bring it in.
        return null;
      }
      this.lastSeenModifiedMs.set(summary.conversationId, summary.lastModifiedMs);
      return this.indexConversation(summary, watermarks.get(toWatermarkKey(summary.root)));
    }

    let newestSessionId: string | null = null;
    for (const summary of summaries) {
      if (!hasMovedSince(this.lastSeenModifiedMs, summary)) {
        continue;
      }
      this.lastSeenModifiedMs.set(summary.conversationId, summary.lastModifiedMs);
      const sessionId = this.indexConversation(summary, watermarks.get(toWatermarkKey(summary.root)));
      // Summaries are newest first, so the first one indexed is reported.
      newestSessionId ??= sessionId;
    }
    return newestSessionId;
  }

  private classifyArtifact(filePath: string, roots: string[]): AgyArtifact | null {
    for (const root of roots) {
      const classified = classifyAgyDataPath(root, filePath);
      if (classified && classified.kind !== 'directory') {
        return classified;
      }
    }
    return null;
  }

  /**
   * Upserts one conversation and returns its canonical session id, or null
   * when it has no row and must not get one: a missing row is only (re)created
   * when agy modified the conversation after its root's watermark and after
   * this process last wrote the row.
   */
  private indexConversation(summary: AgyConversationSummary, watermarkMs: number | undefined): string | null {
    const existing = sessionsDb.getSessionByProviderSessionId(summary.conversationId)
      ?? sessionsDb.getSessionById(summary.conversationId);
    if (!existing && !(isModifiedSince(summary, watermarkMs) && hasMovedSince(this.indexedModifiedMs, summary))) {
      return null;
    }

    const sessionId = this.upsertConversation(summary, existing);
    this.indexedModifiedMs.set(summary.conversationId, summary.lastModifiedMs);
    return sessionId;
  }

  /** Returns the canonical session id (the app's id once a CloudCLI chat is bound to the conversation). */
  private upsertConversation(summary: AgyConversationSummary, existing: IndexedSessionRow | null): string {
    // A chat started in CloudCLI stays in the project it was started from;
    // agy's workspace may name a parent folder or the home directory instead.
    const isAppSession = Boolean(existing && existing.session_id !== existing.provider_session_id);
    const projectPath = isAppSession && existing?.project_path ? existing.project_path : summary.projectPath;
    // Without a modification time the stored one is kept: "now" would move the
    // session to the top and un-archive it on every scan.
    const updatedAt = summary.lastModifiedMs === null
      ? existing?.updated_at
      : new Date(summary.lastModifiedMs).toISOString();

    return sessionsDb.createSession(
      summary.conversationId,
      this.provider,
      projectPath,
      this.resolveSessionName(summary, existing?.custom_name ?? null),
      updatedAt,
      updatedAt,
      null,
    );
  }

  /**
   * Keeps a name the user gave the session. A name this synchronizer derived
   * (the fallback, or agy's preview before agy titled the conversation) gives
   * way to the current title.
   */
  private resolveSessionName(summary: AgyConversationSummary, existingName: string | null): string {
    const derivedNames = new Set([FALLBACK_SESSION_NAME]);
    if (summary.preview) {
      derivedNames.add(normalizeSessionName(summary.preview, FALLBACK_SESSION_NAME));
    }
    if (existingName && !derivedNames.has(existingName)) {
      return existingName;
    }
    return normalizeSessionName(summary.title ?? undefined, FALLBACK_SESSION_NAME);
  }

  private readRootWatermarks(): Map<string, number> {
    const watermarks = new Map<string, number>();
    let stored: unknown = null;
    try {
      stored = JSON.parse(appConfigDb.get(ROOT_WATERMARKS_KEY) ?? '{}');
    } catch {
      // A corrupt value counts as no marks.
    }
    for (const [root, watermarkMs] of Object.entries(readObjectRecord(stored) ?? {})) {
      if (typeof watermarkMs === 'number' && Number.isFinite(watermarkMs)) {
        watermarks.set(root, watermarkMs);
      }
    }
    return watermarks;
  }

  /**
   * Moves the watermark of each root whose index was read. The stored marks
   * are read again right before writing, so the marks another scan recorded
   * for other roots meanwhile are kept.
   */
  private recordRootWatermarks(readRoots: string[], watermarkMs: number): void {
    if (readRoots.length === 0) {
      return;
    }
    const watermarks = this.readRootWatermarks();
    for (const root of readRoots) {
      watermarks.set(toWatermarkKey(root), watermarkMs);
    }
    const sortedEntries = [...watermarks].sort(([left], [right]) => left.localeCompare(right));
    appConfigDb.set(ROOT_WATERMARKS_KEY, JSON.stringify(Object.fromEntries(sortedEntries)));
  }
}
