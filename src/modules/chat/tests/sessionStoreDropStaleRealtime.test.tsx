import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';

/**
 * A history read only drops the live rows the transcript on disk already has,
 * so some never leave: a protocol error, an echo the server never claimed, the
 * rest of a run whose end the socket missed. The tab's refresh of an idle chat
 * asks the read to drop those once they are old enough, but never the stream
 * being written or the echo of an edit, which the history cannot have yet.
 * Old enough is counted from when the read went out, and the refresh can call
 * the drop off when the read lands (a turn started meanwhile).
 */

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

const SESSION = 'session-1';

const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

const historyRow = (id: string, content: string): NormalizedMessage => ({
  id,
  kind: 'text',
  role: 'assistant',
  provider: 'claude',
  sessionId: SESSION,
  content,
  timestamp: secondsAgo(600),
} as NormalizedMessage);

const HISTORY = [historyRow('h1', 'first answer'), historyRow('h2', 'second answer')];

const respondWithHistory = () => {
  sessionMessages.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { messages: HISTORY, total: HISTORY.length, hasMore: false } }),
  });
};

/** Makes the next history read wait until the returned function is called. */
const holdNextRead = () => {
  let release = () => undefined as void;
  sessionMessages.mockImplementationOnce(() => new Promise((resolve) => {
    release = () => resolve({
      ok: true,
      json: async () => ({ data: { messages: HISTORY, total: HISTORY.length, hasMore: false } }),
    });
  }));
  return () => release();
};

beforeEach(() => {
  sessionMessages.mockReset();
  respondWithHistory();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

async function loadedStore() {
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  const view = renderHook(() => useSessionStore());
  act(() => {
    view.result.current.setActiveSession(SESSION);
  });
  await act(async () => {
    await view.result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
  });
  return view;
}

const contents = (messages: NormalizedMessage[]) => messages.map((message) => message.content);

describe('fetchFromServer with dropStaleRealtime', () => {
  it('drops the live rows the read did not take once older than the window, and keeps younger ones', async () => {
    const { result } = await loadedStore();
    act(() => {
      result.current.appendRealtime(SESSION, {
        id: 'protocol_error_1', kind: 'error', provider: 'claude', sessionId: SESSION, content: 'Request failed', timestamp: secondsAgo(60),
      } as NormalizedMessage);
      result.current.appendRealtime(SESSION, {
        id: 'local_echo', kind: 'text', role: 'user', provider: 'claude', sessionId: SESSION, content: 'never claimed', timestamp: secondsAgo(30),
      } as NormalizedMessage);
      result.current.appendRealtime(SESSION, {
        id: 'text_fresh', kind: 'text', role: 'assistant', provider: 'claude', sessionId: SESSION, content: 'just finished', timestamp: secondsAgo(2),
      } as NormalizedMessage);
    });
    const realtimeBefore = result.current.getSessionSlot(SESSION)?.realtimeMessages;

    await act(async () => {
      await result.current.fetchFromServer(SESSION, {
        limit: null,
        offset: 0,
        dropStaleRealtime: { keepNewerThanMs: 15_000 },
      });
    });

    assert.deepEqual(contents(result.current.getMessages(SESSION)), ['first answer', 'second answer', 'just finished']);
    assert.equal(result.current.getSessionSlot(SESSION)?.realtimeMessages === realtimeBefore, false, 'a new array, so the merge is recomputed');
  });

  it('keeps the stream being written and the echo of an edit, however old', async () => {
    const { result } = await loadedStore();
    act(() => {
      result.current.appendRealtime(SESSION, {
        id: `__streaming_${SESSION}`, kind: 'stream_delta', provider: 'claude', sessionId: SESSION, content: 'still streaming', timestamp: secondsAgo(120),
      } as NormalizedMessage);
      result.current.appendRealtime(SESSION, {
        id: 'local_edit', kind: 'text', role: 'user', provider: 'claude', sessionId: SESSION, content: 'second prompt, corrected', timestamp: secondsAgo(120), replacesAnchorId: 'u2',
      } as NormalizedMessage);
      result.current.appendRealtime(SESSION, {
        id: 'protocol_error_2', kind: 'error', provider: 'claude', sessionId: SESSION, content: 'Request failed', timestamp: secondsAgo(120),
      } as NormalizedMessage);
    });

    await act(async () => {
      await result.current.fetchFromServer(SESSION, {
        limit: null,
        offset: 0,
        dropStaleRealtime: { keepNewerThanMs: 15_000 },
      });
    });

    const realtime = result.current.getSessionSlot(SESSION)?.realtimeMessages ?? [];
    assert.deepEqual(realtime.map((message) => message.id).sort(), [`__streaming_${SESSION}`, 'local_edit']);
  });

  it('leaves every live row when the read fails', async () => {
    const { result } = await loadedStore();
    act(() => {
      result.current.appendRealtime(SESSION, {
        id: 'protocol_error_3', kind: 'error', provider: 'claude', sessionId: SESSION, content: 'Request failed', timestamp: secondsAgo(60),
      } as NormalizedMessage);
    });
    sessionMessages.mockResolvedValue({ ok: false, json: async () => ({}) });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await act(async () => {
        await result.current.fetchFromServer(SESSION, {
          limit: null,
          offset: 0,
          dropStaleRealtime: { keepNewerThanMs: 15_000 },
        });
      });
    } finally {
      consoleError.mockRestore();
    }

    assert.equal(result.current.getSessionSlot(SESSION)?.status, 'error');
    assert.deepEqual(contents(result.current.getMessages(SESSION)), ['first answer', 'second answer', 'Request failed']);
  });

  it('keeps a live row that came while the read was out, however long the read took', async () => {
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start);
    const { result } = await loadedStore();
    act(() => {
      result.current.appendRealtime(SESSION, {
        id: 'protocol_error_5', kind: 'error', provider: 'claude', sessionId: SESSION, content: 'Request failed', timestamp: secondsAgo(60),
      } as NormalizedMessage);
    });

    const release = holdNextRead();
    let reading: Promise<unknown> = Promise.resolve();
    act(() => {
      reading = result.current.fetchFromServer(SESSION, {
        limit: null,
        offset: 0,
        dropStaleRealtime: { keepNewerThanMs: 15_000 },
      });
    });
    await act(async () => undefined);
    assert.equal(sessionMessages.mock.calls.length, 2, 'the read went out');

    // Two seconds in, a turn sends its echo, which the read cannot have.
    vi.setSystemTime(start + 2_000);
    act(() => {
      result.current.appendRealtime(SESSION, {
        id: 'local_echo_2', kind: 'text', role: 'user', provider: 'claude', sessionId: SESSION, content: 'sent during the read', timestamp: new Date().toISOString(),
      } as NormalizedMessage);
    });
    // The read lands twenty seconds after it went out.
    vi.setSystemTime(start + 20_000);
    await act(async () => {
      release();
      await reading;
    });

    assert.deepEqual(contents(result.current.getMessages(SESSION)), ['first answer', 'second answer', 'sent during the read']);
  });

  it('asks shouldDrop once the read lands, and drops nothing when it says no', async () => {
    const { result } = await loadedStore();
    act(() => {
      result.current.appendRealtime(SESSION, {
        id: 'protocol_error_6', kind: 'error', provider: 'claude', sessionId: SESSION, content: 'Request failed', timestamp: secondsAgo(60),
      } as NormalizedMessage);
    });

    const release = holdNextRead();
    let isIdle = true;
    let reading: Promise<unknown> = Promise.resolve();
    act(() => {
      reading = result.current.fetchFromServer(SESSION, {
        limit: null,
        offset: 0,
        dropStaleRealtime: { keepNewerThanMs: 15_000, shouldDrop: () => isIdle },
      });
    });
    await act(async () => undefined);
    // A turn starts while the read is out.
    isIdle = false;
    await act(async () => {
      release();
      await reading;
    });

    assert.deepEqual(contents(result.current.getMessages(SESSION)), ['first answer', 'second answer', 'Request failed']);
  });

  it('drops nothing old without the option, as every other read does', async () => {
    const { result } = await loadedStore();
    act(() => {
      result.current.appendRealtime(SESSION, {
        id: 'protocol_error_4', kind: 'error', provider: 'claude', sessionId: SESSION, content: 'Request failed', timestamp: secondsAgo(60),
      } as NormalizedMessage);
    });

    await act(async () => {
      await result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
    });

    assert.deepEqual(contents(result.current.getMessages(SESSION)), ['first answer', 'second answer', 'Request failed']);
  });
});
