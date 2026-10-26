import type { NormalizedMessage } from '@/shared/types';

export const SESSION_MESSAGES_PAGE_SIZE = 20;

export type SessionMessagesRequestOptions = {
  limit?: number | null;
  offset?: number;
};

export type LatestPageMergeResult = {
  messages: NormalizedMessage[];
  overlapLength: number;
};

export type LatestPageBridgeRequest = {
  limit: number;
  offset: number;
};

export type LatestPagePagination = {
  offset: number;
  hasMore: boolean;
};

export type OlderPageMergeResult = {
  messages: NormalizedMessage[];
  overlapLength: number;
  prependedCount: number;
};

// The unified session-history URL is declared with the rest of the endpoints;
// it is re-exported here because the pagination tests cover its shape.
export { sessionMessagesUrl as buildSessionMessagesUrl } from '@/shared/api';

function serializedValue(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Persisted IDs are preferred, but some provider readers (notably Codex)
 * generate fresh IDs on every read. The fallback uses stable transcript fields
 * and deliberately excludes enrichment such as toolResult, which may change
 * when the provider finishes writing a turn.
 */
export function messagesRepresentSamePersistedRow(
  first: NormalizedMessage,
  second: NormalizedMessage,
): boolean {
  if (first.id === second.id) return true;
  if (
    first.provider !== second.provider
    || first.kind !== second.kind
    || first.timestamp !== second.timestamp
    || first.role !== second.role
  ) {
    return false;
  }

  if (first.toolId || second.toolId) return first.toolId === second.toolId;
  if (first.rowid !== undefined || second.rowid !== undefined) return first.rowid === second.rowid;
  if (first.sequence !== undefined || second.sequence !== undefined) return first.sequence === second.sequence;

  return (
    (first.content ?? '') === (second.content ?? '')
    && (first.text ?? '') === (second.text ?? '')
    && (first.toolName ?? '') === (second.toolName ?? '')
    && (first.commandName ?? '') === (second.commandName ?? '')
    && (first.parentToolUseId ?? '') === (second.parentToolUseId ?? '')
    && serializedValue(first.toolInput) === serializedValue(second.toolInput)
  );
}

/** Returns the longest cached-suffix/latest-prefix overlap. */
export function findLatestPageOverlapLength(
  cachedMessages: NormalizedMessage[],
  latestMessages: NormalizedMessage[],
): number {
  const maximum = Math.min(cachedMessages.length, latestMessages.length);

  for (let length = maximum; length > 0; length--) {
    const cachedStart = cachedMessages.length - length;
    let matches = true;
    for (let index = 0; index < length; index++) {
      if (!messagesRepresentSamePersistedRow(cachedMessages[cachedStart + index], latestMessages[index])) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }

  return 0;
}

/**
 * Plans the next finite bridge chunk when a single turn added at least one
 * complete latest page. The common case asks for exactly the reported missing
 * rows plus one anchor; later chunks handle provider totals that omit rows.
 */
export function planLatestPageBridge(
  cachedMessages: NormalizedMessage[],
  latestMessages: NormalizedMessage[],
  previousTotal: number,
  nextTotal: number,
  bridgeRowsFetched = 0,
): LatestPageBridgeRequest | null {
  if (
    cachedMessages.length === 0
    || latestMessages.length === 0
    || findLatestPageOverlapLength(cachedMessages, latestMessages) > 0
  ) {
    return null;
  }

  const addedCount = Math.max(0, nextTotal - previousTotal);
  const predictedMissingRows = Math.max(
    0,
    addedCount - latestMessages.length - bridgeRowsFetched,
  );
  const preferredLimit = bridgeRowsFetched === 0
    ? Math.max(1, predictedMissingRows + 1)
    : SESSION_MESSAGES_PAGE_SIZE;

  return {
    offset: latestMessages.length + bridgeRowsFetched,
    limit: preferredLimit,
  };
}

/**
 * Returns true once a backward bridge has reached the time range already
 * represented by the cached tail. This prevents a rewritten transcript with
 * no semantic ID overlap from walking backward through old history forever.
 */
export function hasReachedCachedTailTimeBoundary(
  cachedMessages: NormalizedMessage[],
  fetchedMessages: NormalizedMessage[],
): boolean {
  const cachedNewest = cachedMessages[cachedMessages.length - 1];
  const fetchedOldest = fetchedMessages[0];
  if (!cachedNewest || !fetchedOldest) return false;

  const cachedNewestTime = Date.parse(cachedNewest.timestamp);
  const fetchedOldestTime = Date.parse(fetchedOldest.timestamp);
  if (!Number.isFinite(cachedNewestTime) || !Number.isFinite(fetchedOldestTime)) {
    return false;
  }

  return fetchedOldestTime <= cachedNewestTime;
}

/**
 * Atomically replaces the overlapping cached tail with the latest persisted
 * window while retaining every already-loaded older row.
 */
export function mergeLatestServerPage(
  cachedMessages: NormalizedMessage[],
  latestMessages: NormalizedMessage[],
): LatestPageMergeResult {
  if (cachedMessages.length === 0) {
    return { messages: latestMessages, overlapLength: 0 };
  }
  if (latestMessages.length === 0) {
    return { messages: cachedMessages, overlapLength: 0 };
  }

  const overlapLength = findLatestPageOverlapLength(cachedMessages, latestMessages);
  if (overlapLength === 0) {
    return { messages: cachedMessages, overlapLength: 0 };
  }

  return {
    messages: [
      ...cachedMessages.slice(0, cachedMessages.length - overlapLength),
      ...latestMessages,
    ],
    overlapLength,
  };
}

/**
 * Reconciles a tail-offset older-page response with the cached suffix when the
 * transcript grew while that request was in flight. With no overlap the page
 * is treated as the normal immediately-preceding page.
 */
export function mergeOlderServerPage(
  cachedMessages: NormalizedMessage[],
  olderMessages: NormalizedMessage[],
): OlderPageMergeResult {
  const maximum = Math.min(cachedMessages.length, olderMessages.length);
  let overlapLength = 0;

  for (let length = maximum; length > 0; length--) {
    const olderStart = olderMessages.length - length;
    let matches = true;
    for (let index = 0; index < length; index++) {
      if (!messagesRepresentSamePersistedRow(olderMessages[olderStart + index], cachedMessages[index])) {
        matches = false;
        break;
      }
    }
    if (matches) {
      overlapLength = length;
      break;
    }
  }

  const prependedCount = olderMessages.length - overlapLength;
  return {
    messages: [
      ...olderMessages.slice(0, prependedCount),
      ...cachedMessages,
    ],
    overlapLength,
    prependedCount,
  };
}

/** Preserves the cached oldest-page boundary after a successful tail stitch. */
export function resolveLatestPagePagination(
  previousMessageCount: number,
  mergedMessageCount: number,
  previousHasMore: boolean,
  oldestFetchedPageHasMore: boolean,
): LatestPagePagination {
  return {
    offset: mergedMessageCount,
    hasMore: previousMessageCount === 0
      ? oldestFetchedPageHasMore
      : previousHasMore && oldestFetchedPageHasMore,
  };
}

/**
 * How far back, in rows, a latest-page refresh reaches for a background launch
 * it follows (`resolveLatestRefreshLimit`). Every reload re-sends the whole
 * window, each row with its tool result folded in, and while the poll follows
 * a workflow the Claude CLI runs outside CloudCLI a reload of such a window
 * comes every 15 s, so the reach is bounded. 150 rows, about seven pages, spans the
 * several tool-using turns (tens of rows each) a session typically takes while
 * one of its runs works. A launch further back keeps the copy the last read
 * that reached it left, until the session is opened again.
 */
const MAX_LATEST_REFRESH_ROWS = 150;

/**
 * Whether a row cached from the server launched background work, a workflow
 * or an agent, that the history read it came from saw still running. A server
 * row carries no other status (the live stream's word on a task sits on
 * realtime rows, which a refresh keeps), so this is the transcript strip's
 * rule (`readBackgroundTaskStatus`) on such a row. It is also what a later
 * read can still change: the run's agents, its outcome, the result folded in.
 */
function isRunningBackgroundLaunch(message: NormalizedMessage): boolean {
  return message.kind === 'tool_use'
    && Boolean(message.toolId)
    && (message.workflow?.status ?? message.subagent?.status) === 'running';
}

/**
 * The latest-page refresh the rows cached from the server call for: how many
 * of the newest rows it requests, and the oldest cached row a read of that
 * window is sure to reach when at most one row is written while it is in
 * flight; a launch that is the oldest cached row, which gets no row of slack
 * (see below), is reached by a read no row outran.
 *
 * A page, unless a launch whose background work the cache last saw running
 * sits further back. Rows written after it push it out of the newest page, and
 * the merge keeps every cached row older than the page as it was, so its run
 * would stay frozen as it stood when it left the page: its agents, and still
 * `running` after it ends. The window then reaches back to the oldest such
 * launch, plus one row so that a row written while the request is in flight
 * does not push it out again (when more arrive between two reads, the next
 * read, sized from the grown cache, reaches it), and the merge replaces the
 * cached copy with the server's. Once that copy reads as over, the window
 * shrinks back to a page. A launch more than `MAX_LATEST_REFRESH_ROWS` back is
 * not reached for.
 *
 * The row of slack never reaches above the oldest cached row. The merge can
 * only place a window whose first row is cached, so a window starting one row
 * older than everything cached is dropped whole on every quiet read, and the
 * launch with it. A launch that is the oldest cached row therefore gets no
 * slack: a quiet read reaches it, and a read that rows outran still merges,
 * growing the cache, so the next one, sized from it, does.
 */
function planLatestRefresh(serverMessages: NormalizedMessage[]): { limit: number; firstReachedIndex: number } {
  // The launch at `index` is reached by the `length - index` rows from it to
  // the end, plus the row of slack.
  const firstReachableIndex = Math.max(0, serverMessages.length + 1 - MAX_LATEST_REFRESH_ROWS);
  for (let index = firstReachableIndex; index < serverMessages.length; index += 1) {
    if (isRunningBackgroundLaunch(serverMessages[index])) {
      const limit = Math.max(
        SESSION_MESSAGES_PAGE_SIZE,
        Math.min(serverMessages.length, serverMessages.length - index + 1),
      );
      return { limit, firstReachedIndex: Math.min(index, Math.max(0, serverMessages.length + 1 - limit)) };
    }
  }
  return {
    limit: SESSION_MESSAGES_PAGE_SIZE,
    // A page's row of slack counts as above the rows it reaches, as a row
    // written meanwhile pushes it out.
    firstReachedIndex: Math.max(0, serverMessages.length + 1 - SESSION_MESSAGES_PAGE_SIZE),
  };
}

/**
 * How many of the newest rows a latest-page refresh requests, given the rows
 * cached from the server (see `planLatestRefresh`).
 */
export function resolveLatestRefreshLimit(serverMessages: NormalizedMessage[]): number {
  return planLatestRefresh(serverMessages).limit;
}

/**
 * The tool calls among the rows cached from the server that the next
 * latest-page refresh leaves as they are: those above the rows the window
 * `resolveLatestRefreshLimit` sizes is sure to reach (see
 * `planLatestRefresh`). Re-reading the latest page cannot follow a launch
 * among them.
 */
export function listToolIdsBeyondLatestRefresh(serverMessages: NormalizedMessage[]): Set<string> {
  const { firstReachedIndex } = planLatestRefresh(serverMessages);
  const toolIds = new Set<string>();
  for (let index = 0; index < firstReachedIndex; index += 1) {
    const message = serverMessages[index];
    if (message.kind === 'tool_use' && message.toolId) {
      toolIds.add(message.toolId);
    }
  }
  return toolIds;
}
