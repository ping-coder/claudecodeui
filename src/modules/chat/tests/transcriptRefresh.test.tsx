import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { useEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import type { ChatMessage, NormalizedMessage, Project, ProjectSession, SessionActivity, SessionActivityMap } from '@/shared/types';

/**
 * refreshTranscript, the chat side of a tab's refresh: what it reads for an
 * idle session, a running one and a hidden chat, and where it leaves the
 * reader. jsdom has no layout, so the transcript here is a container whose
 * rows are 100px tall and stacked from its top edge.
 */

const tokenUsage = vi.hoisted(() => ({ reads: 0 }));

type PageOptions = { limit?: number | null; offset?: number };

/** The persisted transcript the real store's reads are served from, newest rows last. */
const server = vi.hoisted(() => ({
  rows: [] as unknown[],
  /** Holds a read back until the promise it returns settles; nothing lets it through. */
  hold: null as null | ((options: PageOptions) => Promise<void> | undefined),
}));

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionTokenUsage: () => {
        tokenUsage.reads += 1;
        return Promise.resolve({ ok: true, json: async () => ({ data: { used: tokenUsage.reads, total: 200000 } }) });
      },
      // Pages count back from the newest row, as the server's do.
      sessionMessages: async (_sessionId: string, options: PageOptions = {}) => {
        const total = server.rows.length;
        const end = Math.max(0, total - (options.offset ?? 0));
        const start = options.limit === null || options.limit === undefined ? 0 : Math.max(0, end - options.limit);
        const data = { messages: server.rows.slice(start, end), total, hasMore: start > 0 };
        await server.hold?.(options);
        return { ok: true, json: async () => ({ data }) };
      },
    },
  },
}));

const SESSION = 'session-a';
const project: Project = { projectId: 'project-1', path: '/repo', fullPath: '/repo', displayName: 'Repo', isStarred: false };
const session = { id: SESSION } as ProjectSession;

const ROW_HEIGHT = 100;
const VIEW_HEIGHT = 500;

const timestampOf = (index: number) => `2026-01-01T00:${String(index).padStart(2, '0')}:00.000Z`;

const buildMessage = (index: number): NormalizedMessage => ({
  id: `m-${index}`,
  kind: 'text',
  role: index % 2 === 0 ? 'user' : 'assistant',
  provider: 'claude',
  sessionId: SESSION,
  content: `message ${index}`,
  timestamp: timestampOf(index),
} as NormalizedMessage);

/** A transcript whose rows are ROW_HEIGHT tall, stacked from the top, scrolled to the bottom. */
function createTranscript(rowIndexes: number[]) {
  const element = document.createElement('div');
  const writes: number[] = [];
  let scrollTop = 0;

  const addRow = (index: number, before?: Element | null) => {
    const row = document.createElement('div');
    row.setAttribute('data-message-timestamp', timestampOf(index));
    // A mounted lazy row repeats its time on the content inside.
    const content = document.createElement('div');
    content.setAttribute('data-message-timestamp', timestampOf(index));
    row.appendChild(content);
    row.getBoundingClientRect = () => {
      const top = Array.from(element.children).indexOf(row) * ROW_HEIGHT - scrollTop;
      return { top, bottom: top + ROW_HEIGHT, height: ROW_HEIGHT } as DOMRect;
    };
    element.insertBefore(row, before ?? null);
  };
  rowIndexes.forEach((index) => addRow(index));

  Object.defineProperty(element, 'scrollHeight', { get: () => element.children.length * ROW_HEIGHT });
  Object.defineProperty(element, 'clientHeight', { get: () => VIEW_HEIGHT });
  Object.defineProperty(element, 'scrollTop', {
    get: () => scrollTop,
    set: (next: number) => {
      scrollTop = next;
      writes.push(next);
    },
  });
  element.getBoundingClientRect = () => ({ top: 0, bottom: VIEW_HEIGHT, height: VIEW_HEIGHT } as DOMRect);
  scrollTop = element.children.length * ROW_HEIGHT - VIEW_HEIGHT;

  /** Where the row with this index sits relative to the transcript's top edge. */
  const rowTop = (index: number) => {
    const row = Array.from(element.children).find((child) => child.getAttribute('data-message-timestamp') === timestampOf(index));
    return row ? row.getBoundingClientRect().top : null;
  };

  return {
    element: element as HTMLDivElement,
    writes,
    addRow,
    rowTop,
    setScrollTop: (next: number) => {
      scrollTop = next;
    },
  };
}

type SlotShape = { fetchedAt: number; status: 'idle'; total: number; hasMore: boolean; offset: number; tokenUsage?: unknown };

function createStore(messages: NormalizedMessage[], slot: Partial<SlotShape> = {}) {
  const current: SlotShape = {
    fetchedAt: 1,
    status: 'idle',
    total: messages.length,
    hasMore: false,
    offset: messages.length,
    ...slot,
  };
  const hooks = {
    /** Runs while a history read is out, as the rows it brings change the transcript. */
    onFetch: null as null | (() => void),
    /** Keeps history reads out until it settles. */
    gate: null as null | Promise<void>,
  };
  return {
    hooks,
    slot: current,
    fetchFromServer: vi.fn(async (_sessionId: string, _options?: Record<string, unknown>) => {
      await hooks.gate;
      hooks.onFetch?.();
      return current;
    }),
    fetchMore: vi.fn(async () => ({ slot: current, prependedCount: 0 })),
    appendRealtime: vi.fn(),
    refreshLatestFromServer: vi.fn(async () => ({ slot: current, applied: true, changed: false, deferred: false })),
    setActiveSession: vi.fn(),
    isStale: vi.fn(() => false),
    updateStreaming: vi.fn(),
    finalizeStreaming: vi.fn(),
    getMessages: vi.fn(() => messages),
    getSessionSlot: vi.fn(() => current),
  };
}

async function renderSessionState(store: ReturnType<typeof createStore>, initial: { isActive?: boolean; processingSessions?: SessionActivityMap } = {}) {
  const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');
  return renderHook(
    ({ isActive, processingSessions }: { isActive: boolean; processingSessions?: SessionActivityMap }) => useChatSessionState({
      isActive,
      selectedProject: project,
      selectedSession: session,
      ws: null,
      sendMessage: vi.fn(),
      provider: 'claude',
      processingSessions,
      statusCheckSentAtRef: { current: new Map() },
      lastSeqRef: { current: new Map() },
      sessionStore: store as never,
    }),
    { initialProps: { isActive: initial.isActive ?? true, processingSessions: initial.processingSessions } },
  );
}

const refresh = async (result: { current: { refreshTranscript: () => Promise<void> } }) => {
  await act(async () => {
    await result.current.refreshTranscript();
  });
};

/** The rows a window read asks for: its limit is sized from the slot when the read runs. */
const readLimit = (options: Record<string, unknown>, slot: unknown) => (
  typeof options.limit === 'function' ? (options.limit as (current: unknown) => unknown)(slot) : options.limit
);

/** Keeps the store's history reads out until the returned function is called. */
const holdReads = (store: ReturnType<typeof createStore>) => {
  let release = () => undefined as void;
  store.hooks.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => release();
};

/** The hook as ChatInterface hosts it: a bumped trigger refreshes, in the commit that bumped it. */
async function renderRefreshingSessionState(store: ReturnType<typeof createStore>) {
  const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');
  return renderHook(
    ({ selectedSession, refreshTrigger }: { selectedSession: ProjectSession; refreshTrigger: number }) => {
      const state = useChatSessionState({
        isActive: true,
        selectedProject: project,
        selectedSession,
        ws: null,
        sendMessage: vi.fn(),
        provider: 'claude',
        statusCheckSentAtRef: { current: new Map() },
        lastSeqRef: { current: new Map() },
        sessionStore: store as never,
      });
      const { refreshTranscript } = state;
      const previousTrigger = useRef(refreshTrigger);
      useEffect(() => {
        if (refreshTrigger === previousTrigger.current) return;
        previousTrigger.current = refreshTrigger;
        void refreshTranscript();
      }, [refreshTranscript, refreshTrigger]);
      return state;
    },
    { initialProps: { selectedSession: session, refreshTrigger: 0 } },
  );
}

/** A server row; seconds apart, so the store's merges can order them. */
const serverRow = (index: number): NormalizedMessage => ({
  ...buildMessage(index),
  timestamp: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
} as NormalizedMessage);

/** A server row that is a Read call: consecutive ones fold into one group row, timed by its first call. */
const serverReadRow = (index: number): NormalizedMessage => ({
  id: `m-${index}`,
  kind: 'tool_use',
  provider: 'claude',
  sessionId: SESSION,
  toolName: 'Read',
  toolId: `t-${index}`,
  toolInput: { file_path: `/repo/file-${index}.ts` },
  timestamp: serverRow(index).timestamp,
} as NormalizedMessage);

/** The server row a chat row was drawn from: its text says `message N`, a tool call's id is `t-N`. */
const serverIndexOf = (message: ChatMessage) => String(message.toolId ?? message.content ?? '').replace(/^\D+/, '');

/** The hook on the real store, its first page loaded from `server`. */
async function renderOnRealStore() {
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');
  const view = renderHook(() => {
    const store = useSessionStore();
    const state = useChatSessionState({
      isActive: true,
      selectedProject: project,
      selectedSession: session,
      ws: null,
      sendMessage: vi.fn(),
      provider: 'claude',
      statusCheckSentAtRef: { current: new Map() },
      lastSeqRef: { current: new Map() },
      sessionStore: store,
    });
    return { store, state };
  });
  await act(async () => undefined);
  return view;
}

/**
 * The hook on the real store, rendering the rows of its window as the pane
 * does (a run of calls to one tool folds into one row) into a transcript
 * VIEW_HEIGHT tall whose rows are ROW_HEIGHT tall and stacked from its top
 * edge; its first page loaded from `server`.
 */
async function renderTranscriptOnRealStore(processingSessions?: SessionActivityMap) {
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');
  const { groupConsecutiveTools, isToolGroupItem } = await import('@/modules/chat/utils/toolGrouping');
  const t = ((key: string) => key) as unknown as TFunction;
  type Rendered = { store: ReturnType<typeof useSessionStore>; state: ReturnType<typeof useChatSessionState> };
  const latest = { current: null as Rendered | null };
  let scrollTop = 0;

  const placeRow = (row: HTMLDivElement | null) => {
    if (!row) return;
    row.getBoundingClientRect = () => {
      const top = Array.from(row.parentElement?.children ?? []).indexOf(row) * ROW_HEIGHT - scrollTop;
      return { top, bottom: top + ROW_HEIGHT, height: ROW_HEIGHT } as DOMRect;
    };
  };
  let container: HTMLDivElement | null = null;
  const attachContainer = (element: HTMLDivElement | null) => {
    if (!element) return;
    container = element;
    Object.defineProperty(element, 'scrollHeight', { get: () => element.children.length * ROW_HEIGHT });
    Object.defineProperty(element, 'clientHeight', { get: () => VIEW_HEIGHT });
    Object.defineProperty(element, 'scrollTop', {
      get: () => scrollTop,
      set: (next: number) => {
        scrollTop = next;
      },
    });
    element.getBoundingClientRect = () => ({ top: 0, bottom: VIEW_HEIGHT, height: VIEW_HEIGHT } as DOMRect);
    (latest.current!.state.scrollContainerRef as { current: HTMLDivElement | null }).current = element;
  };

  function Host({ onRender }: { onRender: (rendered: Rendered) => void }) {
    const store = useSessionStore();
    const state = useChatSessionState({
      isActive: true,
      selectedProject: project,
      selectedSession: session,
      ws: null,
      sendMessage: vi.fn(),
      provider: 'claude',
      processingSessions,
      statusCheckSentAtRef: { current: new Map() },
      lastSeqRef: { current: new Map() },
      sessionStore: store,
    });
    onRender({ store, state });
    return (
      <div ref={attachContainer}>
        {groupConsecutiveTools(state.visibleMessages, t).map((item) => {
          const rows = (isToolGroupItem(item) ? item.messages : [item]).map(serverIndexOf).join(',');
          return <div key={rows} ref={placeRow} data-rows={rows} data-message-timestamp={String(item.timestamp)} />;
        })}
      </div>
    );
  }

  render(<Host onRender={(rendered) => {
    latest.current = rendered;
  }} />);
  await act(async () => undefined);
  return {
    get current() {
      return latest.current!;
    },
    setScrollTop: (next: number) => {
      scrollTop = next;
    },
    /** Where the row drawing server row `index` sits relative to the transcript's top edge; null when it is not rendered. */
    rowTop: (index: number) => {
      const row = Array.from(container?.children ?? [])
        .find((child) => (child.getAttribute('data-rows') ?? '').split(',').includes(String(index)));
      return row ? row.getBoundingClientRect().top : null;
    },
  };
}

/** The ids of the rows the store holds from the server, oldest first. */
const loadedIds = (store: { getSessionSlot: (sessionId: string) => { serverMessages: NormalizedMessage[] } | undefined }) => (
  (store.getSessionSlot(SESSION)?.serverMessages ?? []).map((message) => message.id)
);

const idsFrom = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, index) => `m-${first + index}`);

beforeEach(() => {
  vi.useFakeTimers();
  // The initial settle re-scrolls to the bottom every frame; silenced, as in
  // the other scroll tests, so only the writers under test move the view.
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  tokenUsage.reads = 0;
  server.rows = [];
  server.hold = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

describe('a refresh of an idle transcript', () => {
  it('reads the loaded rows again as one window and drops old live rows', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => buildMessage(index));
    const store = createStore(messages, { hasMore: true, total: 120, offset: 45 });
    const { result } = await renderSessionState(store);
    store.fetchFromServer.mockClear();

    await refresh(result);

    assert.equal(store.refreshLatestFromServer.mock.calls.length, 1, 'rows written since are stitched on first');
    assert.equal(store.fetchFromServer.mock.calls.length, 1);
    assert.equal(
      store.refreshLatestFromServer.mock.invocationCallOrder[0] < store.fetchFromServer.mock.invocationCallOrder[0],
      true,
    );
    const options = store.fetchFromServer.mock.calls[0]?.[1] as Record<string, unknown>;
    assert.equal(readLimit(options, store.slot), 45, 'as deep as the pages loaded so far');
    assert.equal(options.offset, 0);
    const drop = options.dropStaleRealtime as { keepNewerThanMs: number; shouldDrop?: () => boolean };
    assert.equal(drop.keepNewerThanMs, 15_000);
    assert.equal(drop.shouldDrop?.(), true);
    assert.equal(result.current.hasMoreMessages, true);
    assert.equal(result.current.totalMessages, 120);
    assert.equal(tokenUsage.reads >= 2, true, 'the token usage is read again');
  });

  it('reads every message again when every message was loaded', async () => {
    const store = createStore([buildMessage(0), buildMessage(1)], { hasMore: false });
    const { result } = await renderSessionState(store);
    store.fetchFromServer.mockClear();

    await refresh(result);

    const options = store.fetchFromServer.mock.calls[0]?.[1] as Record<string, unknown>;
    assert.equal(readLimit(options, store.slot), null);
    assert.equal(store.refreshLatestFromServer.mock.calls.length, 0, 'the read of every row needs no tail read first');
  });

  it('keeps the live rows when a turn starts while the read is out', async () => {
    const store = createStore([buildMessage(0)]);
    const { result, rerender } = await renderSessionState(store);
    store.fetchFromServer.mockClear();

    await refresh(result);
    const options = store.fetchFromServer.mock.calls[0]?.[1] as Record<string, unknown>;
    const drop = options.dropStaleRealtime as { shouldDrop?: () => boolean };

    // The store asks once the read lands; by then the user has sent.
    const running = new Map([[SESSION, { startedAt: 1, canInterrupt: true } as SessionActivity]]);
    rerender({ isActive: true, processingSessions: running });
    assert.equal(drop.shouldDrop?.(), false);
  });

  it('keeps the live rows while background work runs', async () => {
    const background = new Map([[SESSION, { startedAt: 1, background: true } as SessionActivity]]);
    const store = createStore([buildMessage(0)]);
    const { result } = await renderSessionState(store, { processingSessions: background });
    store.fetchFromServer.mockClear();

    await refresh(result);

    const options = store.fetchFromServer.mock.calls[0]?.[1] as Record<string, unknown>;
    assert.equal(options.dropStaleRealtime, undefined);
  });
});

describe('a refresh while a turn runs', () => {
  it('reads only the newest rows, as a reconnect does', async () => {
    const running = new Map([[SESSION, { startedAt: 1, canInterrupt: true } as SessionActivity]]);
    const store = createStore([buildMessage(0)], { hasMore: true, offset: 45 });
    const { result } = await renderSessionState(store, { processingSessions: running });
    store.fetchFromServer.mockClear();

    await refresh(result);

    assert.equal(store.fetchFromServer.mock.calls.length, 0, 'no window swapped under the stream');
    assert.equal(store.refreshLatestFromServer.mock.calls.length, 1);
  });
});

describe('a refresh of a hidden chat', () => {
  it('reads nothing until the chat shows, then reads the window once', async () => {
    const store = createStore([buildMessage(0)]);
    const { result, rerender } = await renderSessionState(store);
    // The user switches the pane to Files.
    rerender({ isActive: false, processingSessions: undefined });
    store.fetchFromServer.mockClear();
    store.refreshLatestFromServer.mockClear();

    await refresh(result);
    assert.equal(store.fetchFromServer.mock.calls.length, 0);
    assert.equal(store.refreshLatestFromServer.mock.calls.length, 0);

    await act(async () => {
      rerender({ isActive: true, processingSessions: undefined });
    });

    assert.equal(store.fetchFromServer.mock.calls.length, 1);
    const options = store.fetchFromServer.mock.calls[0]?.[1] as Record<string, unknown>;
    assert.equal(readLimit(options, store.slot), null);
    assert.equal(store.refreshLatestFromServer.mock.calls.length, 0, 'the refresh stands in for the tail read');
  });
});

describe('the window a refresh reads, on the real store', () => {
  it('keeps every loaded row when the transcript grew since the last read', async () => {
    server.rows = Array.from({ length: 100 }, (_, index) => serverRow(index));
    const { result } = await renderOnRealStore();
    // The user has read back three pages.
    await act(async () => {
      await result.current.store.fetchMore(SESSION, { limit: 20 });
      await result.current.store.fetchMore(SESSION, { limit: 20 });
    });
    assert.deepEqual(loadedIds(result.current.store), idsFrom(40, 99));

    // A terminal ran a turn: 25 rows this chat never heard of.
    server.rows = [...server.rows, ...Array.from({ length: 25 }, (_, index) => serverRow(100 + index))];
    await refresh({ current: result.current.state });

    assert.deepEqual(loadedIds(result.current.store), idsFrom(40, 124), 'the oldest rows the reader had stay');
    assert.equal(result.current.state.hasMoreMessages, true);
  });

  it('keeps every loaded row when the rows written since cannot be stitched on', async () => {
    server.rows = Array.from({ length: 100 }, (_, index) => serverRow(index));
    const { result } = await renderOnRealStore();
    await act(async () => {
      await result.current.store.fetchMore(SESSION, { limit: 20 });
      await result.current.store.fetchMore(SESSION, { limit: 20 });
    });
    assert.deepEqual(loadedIds(result.current.store), idsFrom(40, 99));

    // A terminal ran a turn of 25 rows, and the task list it wrote last
    // replaced the one this chat read last: the history no longer has that row.
    server.rows = [...server.rows.slice(0, 99), ...Array.from({ length: 25 }, (_, index) => serverRow(100 + index))];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await refresh({ current: result.current.state });

    assert.equal(warn.mock.calls.some(([text]) => String(text).includes('Could not bridge')), true, 'the stitch did not take');
    assert.deepEqual(loadedIds(result.current.store), [...idsFrom(40, 98), ...idsFrom(100, 124)]);
  });

  it('keeps every loaded row when a row is written while the rows written since are stitched on', async () => {
    server.rows = Array.from({ length: 100 }, (_, index) => serverRow(index));
    const { result } = await renderOnRealStore();
    await act(async () => {
      await result.current.store.fetchMore(SESSION, { limit: 20 });
      await result.current.store.fetchMore(SESSION, { limit: 20 });
    });

    server.rows = [...server.rows, ...Array.from({ length: 25 }, (_, index) => serverRow(100 + index))];
    // One more row lands between the read of the newest page and the read that bridges to the loaded rows.
    let isWritten = false;
    server.hold = (options) => {
      if (!isWritten && options.offset === 0 && options.limit === 20) {
        isWritten = true;
        server.rows = [...server.rows, serverRow(125)];
      }
      return undefined;
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await refresh({ current: result.current.state });

    assert.equal(warn.mock.calls.some(([text]) => String(text).includes('History changed while bridging')), true, 'the stitch did not take');
    assert.deepEqual(loadedIds(result.current.store), idsFrom(40, 125));
  });

  it('keeps a page loaded just before the refresh', async () => {
    server.rows = Array.from({ length: 100 }, (_, index) => serverRow(index));
    const { result } = await renderOnRealStore();
    await act(async () => {
      await result.current.store.fetchMore(SESSION, { limit: 20 });
    });
    assert.deepEqual(loadedIds(result.current.store), idsFrom(60, 99));

    // The user reaches the top, and refreshes while that page is still coming.
    let releaseOlderPage = () => undefined as void;
    const olderPage = new Promise<void>((resolve) => {
      releaseOlderPage = resolve;
    });
    server.hold = (options) => (options.offset === 40 ? olderPage : undefined);
    let loadingMore: Promise<unknown> = Promise.resolve();
    let refreshing: Promise<void> = Promise.resolve();
    act(() => {
      loadingMore = result.current.store.fetchMore(SESSION, { limit: 20 });
      refreshing = result.current.state.refreshTranscript();
    });
    await act(async () => {
      releaseOlderPage();
      await loadingMore;
      await refreshing;
    });

    assert.deepEqual(loadedIds(result.current.store), idsFrom(40, 99));
  });

  it('keeps a page that comes in while the rows written since are read', async () => {
    server.rows = Array.from({ length: 100 }, (_, index) => serverRow(index));
    const { result } = await renderOnRealStore();
    await act(async () => {
      await result.current.store.fetchMore(SESSION, { limit: 20 });
    });

    let releaseTail = () => undefined as void;
    let releaseOlderPage = () => undefined as void;
    const tail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    const olderPage = new Promise<void>((resolve) => {
      releaseOlderPage = resolve;
    });
    server.hold = (options) => {
      if (options.offset === 0 && options.limit === 20) return tail;
      if (options.offset === 40) return olderPage;
      return undefined;
    };
    let refreshing: Promise<void> = Promise.resolve();
    let loadingMore: Promise<unknown> = Promise.resolve();
    act(() => {
      refreshing = result.current.state.refreshTranscript();
    });
    // The user reaches the top while the newest rows are being read.
    act(() => {
      loadingMore = result.current.store.fetchMore(SESSION, { limit: 20 });
    });
    // The window read is queued behind the page before the page lands.
    await act(async () => {
      releaseTail();
    });
    await act(async () => {
      releaseOlderPage();
      await loadingMore;
      await refreshing;
    });

    assert.deepEqual(loadedIds(result.current.store), idsFrom(40, 99));
  });
});

describe('the reader\'s place after a refresh', () => {
  it('keeps the row at the top of the view where it was when the user reads above the bottom', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => buildMessage(index + 10));
    const store = createStore(messages);
    const { result } = await renderSessionState(store);
    const transcript = createTranscript(messages.map((_, index) => index + 10));
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = transcript.element;

    // Scrolled up: row 12 is cut 50px by the top edge.
    transcript.setScrollTop(250);
    act(() => {
      result.current.setIsUserScrolledUp(true);
    });
    assert.equal(transcript.rowTop(12), -50);

    // The read brings three older rows above it (rows that came back with new ids remount the same way).
    store.hooks.onFetch = () => {
      const first = transcript.element.firstElementChild;
      [7, 8, 9].forEach((index) => transcript.addRow(index, first));
    };
    transcript.writes.length = 0;
    await refresh(result);
    act(() => {
      vi.advanceTimersByTime(500);
    });

    assert.equal(transcript.rowTop(12), -50, 'the same row at the same place');
    assert.deepEqual(transcript.writes, [550]);
  });

  it('follows the newest rows when the user was at the bottom', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => buildMessage(index));
    const store = createStore(messages);
    const { result } = await renderSessionState(store);
    const transcript = createTranscript(messages.map((_, index) => index));
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = transcript.element;

    store.hooks.onFetch = () => {
      transcript.addRow(10);
      transcript.addRow(11);
    };
    transcript.writes.length = 0;
    await refresh(result);
    act(() => {
      vi.advanceTimersByTime(250);
    });

    assert.equal(transcript.element.scrollTop, transcript.element.scrollHeight);
    assert.equal(transcript.writes.includes(1200), true);
  });

  it('follows the newest rows though a revealed row held the view', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => buildMessage(index));
    const store = createStore(messages);
    const { result } = await renderSessionState(store);
    const transcript = createTranscript(messages.map((_, index) => index));
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = transcript.element;

    // The pinned question's jump revealed a row; its hold would keep the view off the bottom for a while.
    act(() => {
      result.current.revealMessage(result.current.chatMessages[2], { block: 'start' });
    });
    store.hooks.onFetch = () => {
      transcript.addRow(10);
    };
    await refresh(result);
    act(() => {
      vi.advanceTimersByTime(250);
    });

    assert.equal(transcript.element.scrollTop, transcript.element.scrollHeight);
  });

  it('stays put when the user scrolls up before the deferred follow fires', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => buildMessage(index));
    const store = createStore(messages);
    const { result } = await renderSessionState(store);
    const transcript = createTranscript(messages.map((_, index) => index));
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = transcript.element;

    await refresh(result);
    act(() => {
      result.current.setIsUserScrolledUp(true);
    });
    transcript.writes.length = 0;
    act(() => {
      vi.advanceTimersByTime(250);
    });

    assert.deepEqual(transcript.writes, []);
  });

  it('leaves the view where the user scrolled while the read was out', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => buildMessage(index + 10));
    const store = createStore(messages);
    const { result } = await renderSessionState(store);
    const transcript = createTranscript(messages.map((_, index) => index + 10));
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = transcript.element;
    transcript.setScrollTop(250);
    act(() => {
      result.current.setIsUserScrolledUp(true);
    });

    const release = holdReads(store);
    store.hooks.onFetch = () => {
      const first = transcript.element.firstElementChild;
      [7, 8, 9].forEach((index) => transcript.addRow(index, first));
    };
    let refreshing: Promise<void> = Promise.resolve();
    act(() => {
      refreshing = result.current.refreshTranscript();
    });
    // The user wheels further up meanwhile.
    fireEvent.wheel(transcript.element);
    transcript.setScrollTop(150);
    transcript.writes.length = 0;
    await act(async () => {
      release();
      await refreshing;
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    assert.deepEqual(transcript.writes, []);
    assert.equal(transcript.element.scrollTop, 150);
  });

  it('follows the newest rows when the user went back to the bottom while the read was out', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => buildMessage(index + 10));
    const store = createStore(messages);
    const { result } = await renderSessionState(store);
    const transcript = createTranscript(messages.map((_, index) => index + 10));
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = transcript.element;
    transcript.setScrollTop(250);
    act(() => {
      result.current.setIsUserScrolledUp(true);
    });

    const release = holdReads(store);
    store.hooks.onFetch = () => {
      transcript.addRow(20);
      transcript.addRow(21);
    };
    let refreshing: Promise<void> = Promise.resolve();
    act(() => {
      refreshing = result.current.refreshTranscript();
    });
    // The user sends a message: the composer takes the view to the bottom.
    act(() => {
      result.current.setIsUserScrolledUp(false);
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    await act(async () => {
      release();
      await refreshing;
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });

    assert.equal(transcript.element.scrollTop, transcript.element.scrollHeight);
  });

  it('leaves the row a jump revealed while the read was out', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => buildMessage(index + 10));
    const store = createStore(messages);
    const { result } = await renderSessionState(store);
    const transcript = createTranscript(messages.map((_, index) => index + 10));
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = transcript.element;
    transcript.setScrollTop(250);
    act(() => {
      result.current.setIsUserScrolledUp(true);
    });

    const release = holdReads(store);
    store.hooks.onFetch = () => {
      const first = transcript.element.firstElementChild;
      [7, 8, 9].forEach((index) => transcript.addRow(index, first));
    };
    let refreshing: Promise<void> = Promise.resolve();
    act(() => {
      refreshing = result.current.refreshTranscript();
    });
    // The pinned question's jump.
    act(() => {
      result.current.revealMessage(result.current.chatMessages[5], { block: 'start' });
    });
    transcript.writes.length = 0;
    await act(async () => {
      release();
      await refreshing;
    });

    assert.deepEqual(transcript.writes, []);
  });

  it('leaves the search hit the user jumped to while the read was out', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => buildMessage(index + 10));
    const store = createStore(messages);
    const { result, rerender } = await renderRefreshingSessionState(store);
    // Every message is loaded, so the search jump needs no read of its own.
    await act(async () => {
      await result.current.loadAllMessages();
    });
    const transcript = createTranscript(messages.map((_, index) => index + 10));
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = transcript.element;
    transcript.setScrollTop(250);
    act(() => {
      result.current.setIsUserScrolledUp(true);
    });

    const release = holdReads(store);
    store.hooks.onFetch = () => {
      const first = transcript.element.firstElementChild;
      [7, 8, 9].forEach((index) => transcript.addRow(index, first));
    };
    let refreshing: Promise<void> = Promise.resolve();
    act(() => {
      refreshing = result.current.refreshTranscript();
    });
    // The user opens a sidebar search hit in this same session.
    const hit = Array.from(transcript.element.children)
      .find((row) => row.getAttribute('data-message-timestamp') === timestampOf(16)) as HTMLElement;
    let jumps = 0;
    hit.scrollIntoView = () => {
      jumps += 1;
      transcript.element.scrollTop = 400;
    };
    act(() => {
      rerender({
        selectedSession: { id: SESSION, __searchTargetSnippet: 'message 16', __searchTargetTimestamp: timestampOf(16) } as unknown as ProjectSession,
        refreshTrigger: 0,
      });
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    assert.equal(jumps, 1);
    transcript.writes.length = 0;
    await act(async () => {
      release();
      await refreshing;
    });

    assert.deepEqual(transcript.writes, []);
  });

  it('keeps the reader\'s row rendered when more rows come in than the window has room for', async () => {
    server.rows = Array.from({ length: 100 }, (_, index) => serverRow(index));
    const view = await renderTranscriptOnRealStore();
    // The user has read back three pages and reads at the top: row 42 is cut 50px by the top edge.
    await act(async () => {
      await view.current.store.fetchMore(SESSION, { limit: 20 });
      await view.current.store.fetchMore(SESSION, { limit: 20 });
    });
    view.setScrollTop(250);
    act(() => {
      view.current.state.setIsUserScrolledUp(true);
    });
    assert.equal(view.rowTop(42), -50);

    // A terminal ran a long turn: 60 rows, more than the 40 the window still has room for.
    server.rows = [...server.rows, ...Array.from({ length: 60 }, (_, index) => serverRow(100 + index))];
    let releaseWindow = () => undefined as void;
    let reachWindow = () => undefined as void;
    const windowRead = new Promise<void>((resolve) => {
      releaseWindow = resolve;
    });
    const windowAsked = new Promise<void>((resolve) => {
      reachWindow = resolve;
    });
    server.hold = (options) => {
      if (options.limit !== 120) return undefined;
      reachWindow();
      return windowRead;
    };
    let refreshing: Promise<void> = Promise.resolve();
    await act(async () => {
      refreshing = view.current.state.refreshTranscript();
      await windowAsked;
    });
    // The newest rows are stitched on; the read of the whole window is still out.
    assert.equal(view.rowTop(42), -50, 'the row stays rendered while the window is read');

    await act(async () => {
      releaseWindow();
      await refreshing;
    });

    assert.deepEqual(loadedIds(view.current.store), idsFrom(40, 159));
    assert.equal(view.rowTop(42), -50, 'the same row at the same place');
  });

  it('keeps the reader\'s row rendered when a refresh while a turn runs brings more rows than the window has room for', async () => {
    server.rows = Array.from({ length: 100 }, (_, index) => serverRow(index));
    const running = new Map([[SESSION, { startedAt: 1, canInterrupt: true } as SessionActivity]]);
    const view = await renderTranscriptOnRealStore(running);
    await act(async () => {
      await view.current.store.fetchMore(SESSION, { limit: 20 });
      await view.current.store.fetchMore(SESSION, { limit: 20 });
    });
    view.setScrollTop(250);
    act(() => {
      view.current.state.setIsUserScrolledUp(true);
    });

    server.rows = [...server.rows, ...Array.from({ length: 60 }, (_, index) => serverRow(100 + index))];
    await act(async () => {
      await view.current.state.refreshTranscript();
    });

    assert.deepEqual(loadedIds(view.current.store), idsFrom(40, 159));
    assert.equal(view.rowTop(42), -50, 'the same row at the same place');
  });

  it('keeps the reader\'s row in place when the window\'s first row shares its time with the row above the window', async () => {
    // One entry written as two rows: row 49 has row 50's time.
    server.rows = Array.from({ length: 150 }, (_, index) => serverRow(index));
    server.rows[49] = { ...serverRow(49), timestamp: serverRow(50).timestamp };
    const view = await renderTranscriptOnRealStore();
    // Five pages read back: 120 rows loaded, the window renders the newest 100, rows 50 to 149.
    await act(async () => {
      for (let page = 0; page < 5; page += 1) {
        await view.current.store.fetchMore(SESSION, { limit: 20 });
      }
    });
    // The user reads at the window's top: row 50 is cut 50px by the top edge.
    view.setScrollTop(50);
    act(() => {
      view.current.state.setIsUserScrolledUp(true);
    });
    assert.equal(view.rowTop(49), null);
    assert.equal(view.rowTop(50), -50);

    await act(async () => {
      await view.current.state.refreshTranscript();
    });

    assert.equal(view.rowTop(50), -50, 'the same row at the same place');
    assert.equal(view.rowTop(49), null);
    assert.equal(view.current.state.visibleMessageCount, 100, 'nothing came in, so the window starts where it did');
  });

  it('keeps the reader\'s row in place when the window starts inside a run of tool calls and rows come in', async () => {
    // Rows 47 to 52 are Read calls; cut at row 50, the window's first row is the group of 50 to 52.
    server.rows = Array.from({ length: 150 }, (_, index) => (index >= 47 && index <= 52 ? serverReadRow(index) : serverRow(index)));
    const view = await renderTranscriptOnRealStore();
    await act(async () => {
      for (let page = 0; page < 5; page += 1) {
        await view.current.store.fetchMore(SESSION, { limit: 20 });
      }
    });
    view.setScrollTop(50);
    act(() => {
      view.current.state.setIsUserScrolledUp(true);
    });
    assert.equal(view.rowTop(47), null);
    assert.equal(view.rowTop(50), -50);

    // A terminal wrote 10 rows.
    server.rows = [...server.rows, ...Array.from({ length: 10 }, (_, index) => serverRow(150 + index))];
    await act(async () => {
      await view.current.state.refreshTranscript();
    });

    assert.equal(view.rowTop(50), -50, 'the same row at the same place');
    assert.equal(view.rowTop(47), null, 'the calls above the window stay out of its first group');
    assert.equal(view.current.state.visibleMessageCount, 110, 'widened by the rows that came in, no more');
  });

  it('keeps the window a jump widened while the read was out', async () => {
    server.rows = Array.from({ length: 150 }, (_, index) => serverRow(index));
    const view = await renderTranscriptOnRealStore();
    await act(async () => {
      for (let page = 0; page < 5; page += 1) {
        await view.current.store.fetchMore(SESSION, { limit: 20 });
      }
    });
    view.setScrollTop(50);
    act(() => {
      view.current.state.setIsUserScrolledUp(true);
    });

    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.hold = () => gate;
    let refreshing: Promise<void> = Promise.resolve();
    act(() => {
      refreshing = view.current.state.refreshTranscript();
    });
    // A jump to row 35, above the window, widens it to 135 rows.
    act(() => {
      view.current.state.revealMessage(view.current.state.chatMessages[5], { block: 'start' });
    });
    await act(async () => {
      release();
      await refreshing;
    });

    assert.equal(view.current.state.visibleMessageCount, 135);
    assert.equal(view.rowTop(35) === null, false, 'the row the jump went to stays rendered');
  });

  it('follows the newest rows of a session opened and refreshed in one commit', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => buildMessage(index + 10));
    const store = createStore(messages);
    const { result, rerender } = await renderRefreshingSessionState(store);
    const transcript = createTranscript(messages.map((_, index) => index + 10));
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = transcript.element;
    // The session on screen is read part-way up.
    transcript.setScrollTop(250);
    act(() => {
      result.current.setIsUserScrolledUp(true);
    });

    // The tab menu's Refresh on another session's tab opens it and refreshes it in one click.
    const release = holdReads(store);
    act(() => {
      rerender({ selectedSession: { id: 'session-b' } as ProjectSession, refreshTrigger: 1 });
    });
    // The newly opened session settles at the bottom before the refresh's read lands.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    await act(async () => {
      release();
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });

    assert.equal(transcript.element.scrollTop, transcript.element.scrollHeight);
  });
});
