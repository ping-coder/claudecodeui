import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';

/**
 * The background-tasks strip reveals a task's row by widening the visible
 * window and then scrolling to the row's wrapper. The widened window commits
 * after the current frame, so the first lookup runs before the row exists;
 * settling for the nearest row there scrolled to an unrelated row and ended
 * the retry chain, and the task's row never came into view.
 */

vi.mock('@/shared/api', () => ({
  api: { providers: { sessionTokenUsage: () => Promise.resolve({ ok: false, json: async () => ({}) }) } },
}));

const project: Project = { projectId: 'project-1', path: '/repo', fullPath: '/repo', displayName: 'Repo', isStarred: false };
const session: ProjectSession = { id: 'session-a', summary: 'A', lastActivity: '2026-01-01T00:00:00.000Z', messageCount: 1 } as ProjectSession;
const slot = { fetchedAt: 1, status: 'idle' as const, total: 0, hasMore: false, offset: 0 };
const store = {
  fetchFromServer: vi.fn(async () => slot),
  fetchMore: vi.fn(),
  appendRealtime: vi.fn(),
  refreshLatestFromServer: vi.fn(),
  setActiveSession: vi.fn(),
  isStale: vi.fn(() => false),
  updateStreaming: vi.fn(),
  finalizeStreaming: vi.fn(),
  getMessages: vi.fn(() => []),
  getSessionSlot: vi.fn(() => slot),
};

const row = (timestamp: string) => {
  const element = document.createElement('div');
  element.setAttribute('data-message-timestamp', timestamp);
  element.scrollIntoView = vi.fn();
  return element;
};

// Frames run by hand, so a row can be added between two attempts the way a
// React commit adds it.
const frames: FrameRequestCallback[] = [];

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  frames.length = 0;
  vi.unstubAllGlobals();
  vi.resetModules();
});

test('revealing a row not yet rendered waits for it instead of scrolling to its neighbour', async () => {
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
  const container = document.createElement('div');
  const neighbour = row('2026-08-21T10:32:09.000Z');
  container.appendChild(neighbour);
  (hook.result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container;
  frames.length = 0;

  await act(async () => {
    hook.result.current.revealMessage({ type: 'assistant', content: '', timestamp: '2026-08-21T10:32:10.000Z' });
  });

  // First attempt: the target row has not been committed yet.
  assert.equal(frames.length, 1);
  await act(async () => { frames.shift()?.(0); });
  assert.equal((neighbour.scrollIntoView as ReturnType<typeof vi.fn>).mock.calls.length, 0, 'the neighbour must not be scrolled to');
  assert.equal(frames.length, 1, 'the chain goes on');

  // The commit lands the row; the next attempt finds it.
  const target = row('2026-08-21T10:32:10.000Z');
  container.appendChild(target);
  await act(async () => { frames.shift()?.(0); });
  assert.equal((target.scrollIntoView as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  assert.equal(frames.length, 0);
});

test('the last attempt settles for the nearest row, for a hit collapsed inside a tool group', async () => {
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
  const container = document.createElement('div');
  const group = row('2026-08-21T10:32:09.000Z');
  container.appendChild(group);
  (hook.result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container;
  frames.length = 0;

  await act(async () => {
    hook.result.current.revealMessage({ type: 'assistant', content: '', timestamp: '2026-08-21T10:32:10.000Z' });
  });
  while (frames.length > 0) {
    await act(async () => { frames.shift()?.(0); });
  }
  assert.equal((group.scrollIntoView as ReturnType<typeof vi.fn>).mock.calls.length, 1);
});

/**
 * The pinned question's jumps put the row's top just under the transcript's
 * top edge (`block: 'start'`) and keep it there while the rows above settle:
 * no smooth scroll, which a row mounting above would knock off target. The
 * user's own input ends that at once, and the follow-to-bottom stands down for
 * a moment so a row arriving meanwhile does not pull the view away. They look
 * for their own row only (`exact`): a user row is never folded into another.
 */

const CONTAINER_TOP = 100;

/** A transcript 5000px tall in a 600px viewport whose rows sit where `rowOffsets` says, as layout would put them. */
function createLaidOutTranscript() {
  const container = document.createElement('div');
  const writes: number[] = [];
  let scrollTop = 0;
  Object.defineProperty(container, 'scrollHeight', { get: () => 5000 });
  Object.defineProperty(container, 'clientHeight', { get: () => 600 });
  Object.defineProperty(container, 'scrollTop', {
    get: () => scrollTop,
    set: (next: number) => {
      scrollTop = Math.max(0, Math.min(next, 4400));
      writes.push(scrollTop);
    },
  });
  container.getBoundingClientRect = () => ({ top: CONTAINER_TOP, bottom: CONTAINER_TOP + 600, height: 600, left: 0, right: 800, width: 800, x: 0, y: CONTAINER_TOP, toJSON: () => ({}) }) as DOMRect;
  const target = row('2026-08-21T10:32:10.000Z');
  let rowOffset = 1200;
  target.getBoundingClientRect = () => {
    const top = CONTAINER_TOP + rowOffset - scrollTop;
    return { top, bottom: top + 80, height: 80, left: 0, right: 800, width: 800, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  };
  container.appendChild(target);
  document.body.appendChild(container);
  return {
    container,
    target,
    writes,
    /** Where the row's top sits below the transcript's top edge. */
    rowTopInView: () => target.getBoundingClientRect().top - CONTAINER_TOP,
    moveRow: (offset: number) => { rowOffset = offset; },
  };
}

async function renderSessionState(sessionStore: unknown = store) {
  const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');
  return renderHook(() =>
    useChatSessionState({
      isActive: true,
      selectedProject: project,
      selectedSession: session,
      ws: null,
      sendMessage: vi.fn(),
      provider: 'claude',
      statusCheckSentAtRef: { current: new Map() },
      lastSeqRef: { current: new Map() },
      sessionStore: sessionStore as never,
    }),
  );
}

const runFrames = async (count: number) => {
  for (let index = 0; index < count && frames.length > 0; index += 1) {
    await act(async () => { frames.shift()?.(0); });
  }
};

const startTarget = { type: 'user', content: 'the question', timestamp: '2026-08-21T10:32:10.000Z' };

test('a start-aligned reveal sets the scroll so the row\'s top is 8px under the transcript\'s top, without scrollIntoView', async () => {
  const hook = await renderSessionState();
  const transcript = createLaidOutTranscript();
  (hook.result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = transcript.container;
  frames.length = 0;

  await act(async () => {
    hook.result.current.revealMessage(startTarget, { block: 'start', highlight: true });
  });
  await runFrames(1);

  assert.equal(String(transcript.rowTopInView()), '8');
  assert.equal((transcript.target.scrollIntoView as ReturnType<typeof vi.fn>).mock.calls.length === 0, true);
  assert.equal(transcript.target.classList.contains('search-highlight-flash'), true);
});

test('a start-aligned reveal puts the row back when it moves on a later frame', async () => {
  const hook = await renderSessionState();
  const transcript = createLaidOutTranscript();
  (hook.result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = transcript.container;
  frames.length = 0;

  await act(async () => {
    hook.result.current.revealMessage(startTarget, { block: 'start' });
  });
  await runFrames(1);
  // A row above mounts and trades its 100px estimate for 260px.
  transcript.moveRow(1360);
  assert.equal(String(transcript.rowTopInView()), '168');
  await runFrames(1);

  assert.equal(String(transcript.rowTopInView()), '8');
});

test('a wheel ends the hold on a start-aligned reveal', async () => {
  const hook = await renderSessionState();
  const transcript = createLaidOutTranscript();
  (hook.result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = transcript.container;
  frames.length = 0;

  await act(async () => {
    hook.result.current.revealMessage(startTarget, { block: 'start' });
  });
  await runFrames(1);
  const writesBefore = transcript.writes.length;

  transcript.container.dispatchEvent(new Event('wheel', { bubbles: true }));
  transcript.moveRow(1360);
  await runFrames(5);

  assert.equal(transcript.writes.length === writesBefore, true, `wrote ${JSON.stringify(transcript.writes.slice(writesBefore))} after the wheel`);
});

test('for 1.5s after a reveal a new row does not pull the view to the bottom, and after that it does', async () => {
  vi.useFakeTimers();
  // Frames never run here: this is about the follow-to-bottom, not the reveal's own scroll.
  vi.stubGlobal('requestAnimationFrame', () => 0);
  try {
    let messages = [{ id: 'm-0', kind: 'text', role: 'user', provider: 'claude', sessionId: session.id, content: 'the question', timestamp: '2026-08-21T10:32:10.000Z' }];
    const followStore = { ...store, getMessages: vi.fn(() => messages) };
    const hook = await renderSessionState(followStore);
    const transcript = createLaidOutTranscript();
    (hook.result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = transcript.container;

    await act(async () => {
      hook.result.current.revealMessage(startTarget, { block: 'start' });
    });
    const append = (index: number) => {
      messages = [...messages, { ...messages[0], id: `m-${index}`, role: 'assistant', content: `reply ${index}`, timestamp: `2026-08-21T10:33:0${index}.000Z` }];
      hook.rerender();
    };

    transcript.writes.length = 0;
    await act(async () => { append(1); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    assert.equal(transcript.writes.includes(5000) || transcript.writes.includes(4400), false, `followed within 1.5s: ${JSON.stringify(transcript.writes)}`);

    await act(async () => { await vi.advanceTimersByTimeAsync(1400); });
    transcript.writes.length = 0;
    await act(async () => { append(2); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    assert.equal(transcript.writes.includes(4400), true, `did not follow after 1.5s: ${JSON.stringify(transcript.writes)}`);
  } finally {
    vi.useRealTimers();
  }
});

test('an exact reveal whose row never renders flashes nothing and leaves the scroll alone', async () => {
  const hook = await renderSessionState();
  const transcript = createLaidOutTranscript();
  (hook.result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = transcript.container;
  frames.length = 0;

  // A minute before the only row there is: the nearest, were nearest good enough.
  await act(async () => {
    hook.result.current.revealMessage(
      { type: 'user', content: 'the question on an older page', timestamp: '2026-08-21T10:31:10.000Z' },
      { block: 'start', highlight: true, exact: true },
    );
  });
  await runFrames(20);

  assert.equal(frames.length === 0, true, 'the retries ran out');
  assert.equal(transcript.target.classList.contains('search-highlight-flash'), false);
  assert.equal(transcript.writes.length === 0, true, `wrote ${JSON.stringify(transcript.writes)}`);
});

test('a reveal replaced by a later one gives up its retries', async () => {
  const hook = await renderSessionState();
  const container = document.createElement('div');
  (hook.result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container;
  frames.length = 0;

  // The first target's row is not rendered yet when the second reveal comes.
  await act(async () => {
    hook.result.current.revealMessage({ type: 'user', content: 'first', timestamp: '2026-08-21T10:30:00.000Z' }, { block: 'start' });
  });
  const second = row('2026-08-21T10:40:00.000Z');
  container.appendChild(second);
  await act(async () => {
    hook.result.current.revealMessage({ type: 'assistant', content: '', timestamp: '2026-08-21T10:40:00.000Z' });
  });
  const first = row('2026-08-21T10:30:00.000Z');
  // A hold on this row would start by reading where it is.
  const measureFirst = vi.fn(() => ({ top: 500, bottom: 580, height: 80, left: 0, right: 800, width: 800, x: 0, y: 500, toJSON: () => ({}) }) as DOMRect);
  first.getBoundingClientRect = measureFirst;
  container.appendChild(first);
  while (frames.length > 0) {
    await act(async () => { frames.shift()?.(0); });
  }

  assert.equal((second.scrollIntoView as ReturnType<typeof vi.fn>).mock.calls.length === 1, true);
  assert.equal(measureFirst.mock.calls.length === 0, true, 'the replaced reveal must not hold its row');
});
