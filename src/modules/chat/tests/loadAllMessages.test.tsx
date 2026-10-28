import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';

/**
 * Loading every message of the transcript: the answer says whether the rows
 * came in, so a caller that looks for one of them afterwards (the pinned
 * question bar's jump) knows whether to. A call while a load runs waits for
 * that load rather than returning at once, and a read that fails leaves the
 * transcript paged as it was.
 */

vi.mock('@/shared/api', () => ({
  api: { providers: { sessionTokenUsage: () => Promise.resolve({ ok: false, json: async () => ({}) }) } },
}));

const project: Project = { projectId: 'project-1', path: '/repo', fullPath: '/repo', displayName: 'Repo', isStarred: false };
const session: ProjectSession = { id: 'session-a', summary: 'A', lastActivity: '2026-01-01T00:00:00.000Z', messageCount: 40 } as ProjectSession;
const other = { ...session, id: 'session-b' } as ProjectSession;

type Slot = { fetchedAt: number; status: 'idle' | 'loading' | 'error'; total: number; hasMore: boolean; offset: number; serverMessages: unknown[] };

const firstPage: Slot = { fetchedAt: 1, status: 'idle', total: 40, hasMore: true, offset: 20, serverMessages: [] };

let finishLoadAll: ((slot: Slot | null) => void) | null = null;
let failLoadAll: ((error: Error) => void) | null = null;

const createStore = () => ({
  fetchFromServer: vi.fn((_sessionId: string, options: { limit?: number | null }) => {
    if (options.limit === null) {
      return new Promise<Slot | null>((resolve, reject) => {
        finishLoadAll = resolve;
        failLoadAll = reject;
      });
    }
    return Promise.resolve(firstPage);
  }),
  fetchMore: vi.fn(),
  appendRealtime: vi.fn(),
  refreshLatestFromServer: vi.fn(),
  setActiveSession: vi.fn(),
  isStale: vi.fn(() => false),
  getMessages: vi.fn(() => []),
  getSessionSlot: vi.fn(() => firstPage),
});

let store = createStore();

const loadAllReads = () => store.fetchFromServer.mock.calls.filter(([, options]) => options.limit === null).length;

async function renderSessionState() {
  const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');
  const hook = renderHook(() =>
    useChatSessionState({
      isActive: true,
      selectedProject: project,
      selectedSession: session,
      ws: null,
      sendMessage: vi.fn(),
      provider: 'claude',
      statusCheckSentAtRef: { current: new Map() },
      lastSeqRef: { current: new Map() },
      sessionStore: store as never,
    }),
  );
  // The first page lands: there are older pages.
  await act(async () => { await Promise.resolve(); });
  assert.equal(hook.result.current.hasMoreMessages, true);
  return hook;
}

// The hook in a chat that can move to another session and back.
async function renderSwitchableSessionState() {
  const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');
  const hook = renderHook(
    ({ selectedSession }: { selectedSession: ProjectSession }) => useChatSessionState({
      isActive: true,
      selectedProject: project,
      selectedSession,
      ws: null,
      sendMessage: vi.fn(),
      provider: 'claude',
      statusCheckSentAtRef: { current: new Map() },
      lastSeqRef: { current: new Map() },
      sessionStore: store as never,
    }),
    { initialProps: { selectedSession: session } },
  );
  await act(async () => { await Promise.resolve(); });
  return hook;
}

beforeEach(() => {
  store = createStore();
  finishLoadAll = null;
  failLoadAll = null;
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

test('a call while a load runs waits for that load, which reads once, and both resolve true once its rows are in', async () => {
  const hook = await renderSessionState();

  let first: Promise<boolean> = Promise.resolve(false);
  await act(async () => { first = hook.result.current.loadAllMessages(); });
  // A later render's function, as a second press on the jump gets it.
  let second: Promise<boolean> = Promise.resolve(false);
  await act(async () => { second = hook.result.current.loadAllMessages(); });

  assert.equal(second === first, true, 'the second call gets the load in flight');
  assert.equal(loadAllReads() === 1, true, `read ${loadAllReads()} times`);

  let settled = false;
  void second.then(() => { settled = true; });
  await act(async () => { await Promise.resolve(); });
  assert.equal(settled, false, 'not before the rows are in');

  await act(async () => { finishLoadAll?.({ ...firstPage, hasMore: false, offset: 40 }); });
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(hook.result.current.hasMoreMessages, false);
  assert.equal(hook.result.current.allMessagesLoaded, true);

  // Done: the next call reads again.
  await act(async () => { void hook.result.current.loadAllMessages(); });
  assert.equal(loadAllReads() === 2, true);
});

test('a read that fails resolves false and leaves the transcript paged as it was', async () => {
  const hook = await renderSessionState();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  let loaded: Promise<boolean> = Promise.resolve(true);
  await act(async () => { loaded = hook.result.current.loadAllMessages(); });
  // The store swallows the error and hands back its slot, marked.
  await act(async () => { finishLoadAll?.({ ...firstPage, status: 'error' }); });

  assert.equal(await loaded, false);
  assert.equal(hook.result.current.hasMoreMessages, true, 'older pages are still offered');
  assert.equal(hook.result.current.allMessagesLoaded, false);
  assert.equal(hook.result.current.showLoadAllOverlay, false);
  assert.equal(hook.result.current.isLoadingAllMessages, false);
  errors.mockRestore();
});

test('a load that lands after the chat has moved to another session resolves false and leaves that session paged as it was', async () => {
  const hook = await renderSwitchableSessionState();

  let loaded: Promise<boolean> = Promise.resolve(true);
  await act(async () => { loaded = hook.result.current.loadAllMessages(); });
  hook.rerender({ selectedSession: other });
  await act(async () => { await Promise.resolve(); });
  assert.equal(hook.result.current.hasMoreMessages, true, 'the other session has older pages');

  await act(async () => { finishLoadAll?.({ ...firstPage, hasMore: false, offset: 40 }); });
  assert.equal(await loaded, false);
  assert.equal(hook.result.current.hasMoreMessages, true);
  assert.equal(hook.result.current.allMessagesLoaded, false);
});

test('back on a session after another, a load reads afresh, and the one from before lands without touching the transcript', async () => {
  const hook = await renderSwitchableSessionState();

  let before: Promise<boolean> = Promise.resolve(true);
  await act(async () => { before = hook.result.current.loadAllMessages(); });
  const finishBefore = finishLoadAll;
  hook.rerender({ selectedSession: other });
  await act(async () => { await Promise.resolve(); });
  hook.rerender({ selectedSession: session });
  await act(async () => { await Promise.resolve(); });
  assert.equal(hook.result.current.hasMoreMessages, true, 'the session opened afresh, on its first page');

  let after: Promise<boolean> = Promise.resolve(false);
  await act(async () => { after = hook.result.current.loadAllMessages(); });
  assert.equal(after === before, false, 'the load from before the switch is not shared');
  assert.equal(loadAllReads() === 2, true, `read ${loadAllReads()} times`);

  // Its rows were read for the transcript the switch replaced, whose first
  // page the store reads again after them.
  await act(async () => { finishBefore?.({ ...firstPage, hasMore: false, offset: 40 }); });
  assert.equal(await before, false);
  assert.equal(hook.result.current.allMessagesLoaded, false);
  assert.equal(hook.result.current.hasMoreMessages, true);
  assert.equal(hook.result.current.isLoadingAllMessages, true, 'the load after the switch still runs');

  await act(async () => { finishLoadAll?.({ ...firstPage, hasMore: false, offset: 40 }); });
  assert.equal(await after, true);
  assert.equal(hook.result.current.allMessagesLoaded, true);
  assert.equal(hook.result.current.hasMoreMessages, false);
  assert.equal(hook.result.current.isLoadingAllMessages, false);
});

test('a load from before a switch that throws when it lands leaves the load after the switch alone', async () => {
  const hook = await renderSwitchableSessionState();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  let before: Promise<boolean> = Promise.resolve(true);
  await act(async () => { before = hook.result.current.loadAllMessages(); });
  const failBefore = failLoadAll;
  hook.rerender({ selectedSession: other });
  await act(async () => { await Promise.resolve(); });
  hook.rerender({ selectedSession: session });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { void hook.result.current.loadAllMessages(); });

  await act(async () => { failBefore?.(new Error('connection reset')); });
  assert.equal(await before, false);
  assert.equal(hook.result.current.isLoadingAllMessages, true);
  assert.equal(hook.result.current.showLoadAllOverlay, true);
  errors.mockRestore();
});

test('a load the chat moved away from leaves the session opened free to load its older pages', async () => {
  const hook = await renderSwitchableSessionState();

  let loaded: Promise<boolean> = Promise.resolve(true);
  await act(async () => { loaded = hook.result.current.loadAllMessages(); });
  hook.rerender({ selectedSession: other });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { finishLoadAll?.({ ...firstPage, hasMore: false, offset: 40 }); });
  assert.equal(await loaded, false);

  // Scrolled to the top of the other session's transcript.
  store.fetchMore.mockResolvedValue({ slot: { ...firstPage, hasMore: false, offset: 40 }, prependedCount: 20 });
  (hook.result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = document.createElement('div');
  await act(async () => { await hook.result.current.handleScroll(); });
  assert.equal(store.fetchMore.mock.calls.length === 1, true, `${store.fetchMore.mock.calls.length} older pages asked for`);
});

test('a read the chat may not make resolves false', async () => {
  const hook = await renderSessionState();

  let loaded: Promise<boolean> = Promise.resolve(true);
  await act(async () => { loaded = hook.result.current.loadAllMessages(); });
  await act(async () => { finishLoadAll?.(null); });

  assert.equal(await loaded, false);
  assert.equal(hook.result.current.hasMoreMessages, true);
});
