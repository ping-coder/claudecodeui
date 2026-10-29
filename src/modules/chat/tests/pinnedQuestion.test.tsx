import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { TURN_OPENER_ROW_CLASS } from '@/shared/constants';
import type { ChatMessage } from '@/shared/types';
import { usePinnedQuestion } from '@/modules/chat/hooks/usePinnedQuestion';

/**
 * Which question the pinned bar shows: the newest turn's while the transcript
 * follows its newest rows, else the turn at a line 20% down the transcript
 * (120px of these 600), found from the wrappers of the rows that open a turn.
 * When that turn's question is older than every loaded page, the server is
 * asked, once per first loaded row.
 *
 * jsdom has no layout: the transcript and the wrappers report the tops given
 * here, and every rect read is counted.
 */

const LINE_PX = 120;

let rectReads = 0;

function createTranscript(rows: Array<{ timestamp: string; top: number }>) {
  const container = document.createElement('div');
  container.getBoundingClientRect = () => {
    rectReads += 1;
    return { top: 0, bottom: 600, height: 600, left: 0, right: 800, width: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  const moves = rows.map(({ timestamp, top }) => {
    const wrapper = document.createElement('div');
    wrapper.className = TURN_OPENER_ROW_CLASS;
    wrapper.setAttribute('data-message-timestamp', timestamp);
    let currentTop = top;
    wrapper.getBoundingClientRect = () => {
      rectReads += 1;
      return { top: currentTop, bottom: currentTop + 80, height: 80, left: 0, right: 800, width: 800, x: 0, y: currentTop, toJSON: () => ({}) } as DOMRect;
    };
    container.appendChild(wrapper);
    return (next: number) => { currentTop = next; };
  });
  document.body.appendChild(container);
  return { container: container as HTMLDivElement, moves };
}

const user = (timestamp: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ type: 'user', timestamp, content, ...extra });
const assistant = (timestamp: string, content = 'working on it'): ChatMessage => ({ type: 'assistant', timestamp, content });
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 28, 12, 0, seconds)).toISOString();

let frames: FrameRequestCallback[] = [];
const flushFrames = () => act(() => {
  const pending = frames;
  frames = [];
  pending.forEach((callback) => callback(0));
});

const neverRead = () => new Promise<ChatMessage | null>(() => undefined);

beforeEach(() => {
  rectReads = 0;
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('the pinned question', () => {
  const q1 = user(at(0), 'first question');
  const a1 = assistant(at(5));
  const q2 = user(at(10), 'second question');
  const insertLate = user(at(18), 'and the README', { inserted: true });
  const insertEarly = user(at(14), 'also the tests', { inserted: true });
  const a2 = assistant(at(20));
  const q3 = user(at(30), 'third question');
  const a3 = assistant(at(35));

  it('is the newest turn\'s while the transcript follows its newest rows, without reading a rect', () => {
    // The line is inside the first turn, which the reader would see at the top.
    const { container } = createTranscript([
      { timestamp: q1.timestamp as string, top: -500 },
      { timestamp: q2.timestamp as string, top: 300 },
    ]);
    const scrollContainerRef = { current: container };
    const messages = [q1, a1, q2, a2];
    const { result } = renderHook(() => usePinnedQuestion({
      scrollContainerRef,
      chatMessages: messages,
      renderedCount: messages.length,
      isUserScrolledUp: false,
      hasMoreMessages: false,
      readEarlierQuestion: neverRead,
    }));
    flushFrames();
    container.dispatchEvent(new Event('scroll'));
    flushFrames();

    assert.equal(result.current.question === q2, true);
    assert.equal(rectReads === 0, true, `read ${rectReads} rects while following`);
  });

  it('is the question of the turn at the line once scrolled up, with that turn\'s inserts oldest first', () => {
    const { container } = createTranscript([
      { timestamp: q1.timestamp as string, top: -900 },
      { timestamp: q2.timestamp as string, top: -300 },
      { timestamp: q3.timestamp as string, top: 400 },
    ]);
    const scrollContainerRef = { current: container };
    // The later insert reached the transcript first.
    const messages = [q1, a1, q2, insertLate, insertEarly, a2, q3, a3];
    const { result } = renderHook(() => usePinnedQuestion({
      scrollContainerRef,
      chatMessages: messages,
      renderedCount: messages.length,
      isUserScrolledUp: true,
      hasMoreMessages: false,
      readEarlierQuestion: neverRead,
    }));
    flushFrames();

    assert.equal(result.current.question === q2, true);
    assert.equal(result.current.isLoaded, true);
    assert.equal(result.current.inserts.map((insert) => insert.content).join(' | '), 'also the tests | and the README');
    assert.equal(result.current.preview, 'second question');
  });

  it('keeps the turn\'s question when the last user row above the line is an insert', () => {
    // Inserts open no turn, so their wrappers are not among the rows probed:
    // the insert at 10px is above the line, and the question above it is the turn's.
    const { container } = createTranscript([
      { timestamp: q1.timestamp as string, top: -900 },
      { timestamp: q2.timestamp as string, top: -600 },
      { timestamp: q3.timestamp as string, top: 500 },
    ]);
    const scrollContainerRef = { current: container };
    const messages = [q1, a1, q2, insertEarly, a2, q3, a3];
    const { result } = renderHook(() => usePinnedQuestion({
      scrollContainerRef,
      chatMessages: messages,
      renderedCount: messages.length,
      isUserScrolledUp: true,
      hasMoreMessages: false,
      readEarlierQuestion: neverRead,
    }));
    flushFrames();

    assert.equal(result.current.question === q2, true);
    assert.equal(result.current.inserts.length === 1, true);
  });

  it('stays on the turn\'s question past a local command written into it, such as a model switch', () => {
    // A local command asks the model nothing, so it opens no turn and is no insert either.
    const modelSwitch = user(at(21), '/model claude-opus-5-5', { commandName: '/model', isLocalCommand: true });
    const switched: ChatMessage = { type: 'assistant', timestamp: at(21), content: 'Set model to claude-opus-5-5', isLocalCommandStdout: true };
    const { container } = createTranscript([
      { timestamp: q1.timestamp as string, top: -900 },
      { timestamp: q2.timestamp as string, top: -300 },
    ]);
    const scrollContainerRef = { current: container };
    const messages = [q1, a1, q2, a2, modelSwitch, switched, assistant(at(25))];
    const { result } = renderHook(() => usePinnedQuestion({
      scrollContainerRef,
      chatMessages: messages,
      renderedCount: messages.length,
      isUserScrolledUp: false,
      hasMoreMessages: false,
      readEarlierQuestion: neverRead,
    }));
    flushFrames();

    assert.equal(result.current.question === q2, true);
    assert.equal(result.current.inserts.length === 0, true);
  });

  it('is the turn of the first rendered row when no turn opens above the line, even with its question loaded but not rendered', () => {
    const a2b = assistant(at(22));
    const a2c = assistant(at(24));
    // The window renders the last five rows: q2 is loaded but above it.
    const messages = [q1, a1, q2, a2, a2b, a2c, q3, a3];
    const { container } = createTranscript([{ timestamp: q3.timestamp as string, top: 400 }]);
    const scrollContainerRef = { current: container };
    const readEarlierQuestion = vi.fn(neverRead);
    const { result } = renderHook(() => usePinnedQuestion({
      scrollContainerRef,
      chatMessages: messages,
      renderedCount: 5,
      isUserScrolledUp: true,
      hasMoreMessages: true,
      readEarlierQuestion,
    }));
    flushFrames();

    assert.equal(result.current.question === q2, true);
    assert.equal(result.current.status, 'ready');
    assert.equal(readEarlierQuestion.mock.calls.length === 0, true);
  });

  it('is the first rendered row\'s own turn when that row opens a turn below the line, with only the header above it', () => {
    // All loaded, the window renders from q3; at the transcript's top its
    // header (the sticky row, the count of rows shown) puts q3 under the line.
    const a2b = assistant(at(22));
    const messages = [q1, a1, q2, a2, a2b, q3, a3];
    const { container } = createTranscript([{ timestamp: q3.timestamp as string, top: LINE_PX + 4 }]);
    const scrollContainerRef = { current: container };
    const { result } = renderHook(() => usePinnedQuestion({
      scrollContainerRef,
      chatMessages: messages,
      renderedCount: 2,
      isUserScrolledUp: true,
      hasMoreMessages: false,
      readEarlierQuestion: neverRead,
    }));
    flushFrames();

    assert.equal(result.current.question === q3, true);
    assert.equal(result.current.isLoaded, true);
    assert.equal(result.current.status, 'ready');
  });

  it('does not ask the server when the first loaded row opens a turn below the line', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    const messages = [q3, a3];
    const { container } = createTranscript([{ timestamp: q3.timestamp as string, top: LINE_PX + 4 }]);
    const scrollContainerRef = { current: container };
    const readEarlierQuestion = vi.fn(neverRead);
    const { result } = renderHook(() => usePinnedQuestion({
      scrollContainerRef,
      chatMessages: messages,
      renderedCount: messages.length,
      isUserScrolledUp: true,
      hasMoreMessages: true,
      readEarlierQuestion,
    }));
    flushFrames();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    assert.equal(result.current.question === q3, true);
    assert.equal(result.current.status, 'ready');
    assert.equal(readEarlierQuestion.mock.calls.length === 0, true);
  });

  it('asks the server for a question older than every loaded page once per first loaded row', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    const fromServer = user(at(-100), 'the question before the first page');
    const olderFromServer = user(at(-300), 'an even older question');
    const readEarlierQuestion = vi.fn(async () => (readEarlierQuestion.mock.calls.length === 1 ? fromServer : olderFromServer));
    const midTurn = [assistant(at(1)), assistant(at(2)), assistant(at(3))];
    const { container } = createTranscript([]);
    const scrollContainerRef = { current: container };
    const { result, rerender } = renderHook(
      ({ messages, isUserScrolledUp }: { messages: ChatMessage[]; isUserScrolledUp: boolean }) => usePinnedQuestion({
        scrollContainerRef,
        chatMessages: messages,
        renderedCount: messages.length,
        isUserScrolledUp,
        hasMoreMessages: true,
        readEarlierQuestion,
      }),
      { initialProps: { messages: midTurn, isUserScrolledUp: false } },
    );

    assert.equal(result.current.status, 'reading');
    await act(async () => { await vi.advanceTimersByTimeAsync(199); });
    assert.equal(readEarlierQuestion.mock.calls.length === 0, true, 'not asked within 200ms');
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    assert.equal(readEarlierQuestion.mock.calls.length === 1, true, 'asked at 200ms');
    assert.equal(result.current.question === fromServer, true);
    assert.equal(result.current.isLoaded, false);
    assert.equal(result.current.status, 'ready');

    // A page with no question of its own comes in at the front: the answer stands.
    const pageWithoutQuestion = [assistant(at(-20)), assistant(at(-10)), ...midTurn];
    rerender({ messages: pageWithoutQuestion, isUserScrolledUp: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    assert.equal(readEarlierQuestion.mock.calls.length === 1, true, 'not asked again');
    assert.equal(result.current.question === fromServer, true);

    // A page that brings a question comes in, and the line falls before it:
    // the first loaded row is in a turn of its own now, asked about once.
    const opener = user(at(-40), 'a question from the new page');
    const pageWithQuestion = [assistant(at(-60)), opener, assistant(at(-30)), ...pageWithoutQuestion];
    const wrapper = document.createElement('div');
    wrapper.className = TURN_OPENER_ROW_CLASS;
    wrapper.setAttribute('data-message-timestamp', opener.timestamp as string);
    wrapper.getBoundingClientRect = () => ({ top: 400, bottom: 480, height: 80, left: 0, right: 800, width: 800, x: 0, y: 400, toJSON: () => ({}) }) as DOMRect;
    container.appendChild(wrapper);
    rerender({ messages: pageWithQuestion, isUserScrolledUp: true });
    flushFrames();
    await act(async () => { await vi.advanceTimersByTimeAsync(199); });
    assert.equal(readEarlierQuestion.mock.calls.length === 1, true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    assert.equal(readEarlierQuestion.mock.calls.length === 2, true, 'asked about the new first row');
    assert.equal(result.current.question === olderFromServer, true);
  });

  it('asks again once rows have gone from the front, which the answer may have been about', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    const readEarlierQuestion = vi.fn(async () => user(at(-100), 'the question before the first page'));
    const midTurn = [assistant(at(1)), assistant(at(2)), assistant(at(3))];
    const { container } = createTranscript([]);
    const scrollContainerRef = { current: container };
    const { rerender } = renderHook(
      ({ messages }: { messages: ChatMessage[] }) => usePinnedQuestion({
        scrollContainerRef,
        chatMessages: messages,
        renderedCount: messages.length,
        isUserScrolledUp: false,
        hasMoreMessages: true,
        readEarlierQuestion,
      }),
      { initialProps: { messages: midTurn } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    assert.equal(readEarlierQuestion.mock.calls.length === 1, true);

    // A refresh kept only the newest rows: the first loaded row is later than the one asked about.
    rerender({ messages: midTurn.slice(1) });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    assert.equal(readEarlierQuestion.mock.calls.length === 2, true);
  });

  it('re-renders at most once for ten scrolls within a turn, and moves on only when a question crosses the line', () => {
    const { container, moves } = createTranscript([
      { timestamp: q1.timestamp as string, top: -100 },
      { timestamp: q2.timestamp as string, top: 300 },
    ]);
    const scrollContainerRef = { current: container };
    const messages = [q1, a1, q2, a2];
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return usePinnedQuestion({
        scrollContainerRef,
        chatMessages: messages,
        renderedCount: messages.length,
        isUserScrolledUp: true,
        hasMoreMessages: false,
        readEarlierQuestion: neverRead,
      });
    });
    flushFrames();
    assert.equal(result.current.question === q1, true);

    const settled = renders;
    for (const top of [280, 260, 240, 220, 200, 180, 160, 150, 140, LINE_PX + 1]) {
      moves[1](top);
      act(() => { container.dispatchEvent(new Event('scroll')); });
      flushFrames();
    }
    assert.equal(renders - settled <= 1, true, `re-rendered ${renders - settled} times`);
    assert.equal(result.current.question === q1, true);

    moves[1](LINE_PX);
    act(() => { container.dispatchEvent(new Event('scroll')); });
    flushFrames();
    assert.equal(result.current.question === q2, true);
  });
});
