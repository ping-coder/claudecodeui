import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { readInputHistory } from '@/modules/chat/hooks/useInputHistory';
import { readDraftText, resetChatDrafts } from '@/shared/chatDrafts';
import type * as ChatDrafts from '@/shared/chatDrafts';
import type {
  ChatMessage,
  InsertStatus,
  OwnInsert,
  PermissionMode,
  Project,
  ProjectSession,
  SessionActivityMap,
} from '@/shared/types';

/**
 * While Claude works on a turn CloudCLI drives, Enter puts the message into
 * that turn (the CLI reads it after its current tool batch) instead of queueing
 * it for after the turn; Alt+Enter still queues. A message the turn cannot take
 * is queued as before, and an insert the server does not take falls back to
 * what its reason says. An insert that does not land gives its text back, only
 * in the composer that sent it, ahead of whatever was typed since.
 */

const { appendQueuedMessage } = vi.hoisted(() => ({ appendQueuedMessage: vi.fn() }));

vi.mock('@/shared/chatDrafts', async (importOriginal) => {
  const actual = await importOriginal<typeof ChatDrafts>();
  return {
    ...actual,
    appendQueuedMessage: (...args: Parameters<typeof actual.appendQueuedMessage>) => {
      appendQueuedMessage(...args);
      return actual.appendQueuedMessage(...args);
    },
  };
});

type ComposerArgs = Parameters<typeof useChatComposerState>[0];
type SentFrame = { type: string; sessionId?: string; insertId?: string; content?: string };

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION_1: ProjectSession = { id: 'session-1' };
const SESSION_2: ProjectSession = { id: 'session-2' };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The page's socket as the composers see it: every frame each one sends, in order. */
let sent: SentFrame[] = [];
/** The error rows each composer added to its transcript. */
let added: ChatMessage[] = [];
/** What the server answers about running a turn in the held process; null answers 404, as an older server does. */
let handOverPlan: { heldWork: boolean; canHandOver: boolean; changes: string[] } | null = null;
/** The store row id each added row was given, if any, in the order they were added. */
let addedRowIds: Array<string | undefined> = [];
/** The rows the composers took back out of a transcript. */
let removed: Array<[string, string]> = [];

const busyArgs = (overrides: Partial<ComposerArgs> = {}): ComposerArgs => ({
  selectedProject: PROJECT,
  selectedSession: SESSION_1,
  currentSessionId: SESSION_1.id,
  provider: 'claude',
  permissionMode: 'default',
  cyclePermissionMode: () => undefined,
  resolvePermissionModeForProvider: () => 'default' as PermissionMode,
  currentProviderModel: 'test-model',
  currentProviderEffort: 'medium',
  // A turn CloudCLI drives is running on an open socket, for a provider that takes inserts.
  isLoading: true,
  canAbortSession: true,
  supportsMidRunInsert: true,
  isConnected: true,
  tokenBudget: null,
  sendMessage: (message) => { sent.push(message as SentFrame); },
  scrollToBottom: () => undefined,
  addMessage: (message, options) => {
    added.push(message);
    addedRowIds.push(options?.rowId);
  },
  removeMessage: (sessionId, rowId) => { removed.push([sessionId, rowId]); },
  setIsUserScrolledUp: () => undefined,
  setPendingPermissionRequests: () => undefined,
  ...overrides,
});

const renderComposer = (overrides: Partial<ComposerArgs> = {}) => renderHook(
  (props: Partial<ComposerArgs>) => useChatComposerState(busyArgs(props)),
  { initialProps: overrides },
);

type Composer = ReturnType<typeof renderComposer>;

const framesOf = (type: string) => sent.filter((frame) => frame.type === type);

const type = async (composer: Composer, text: string) => {
  await act(async () => {
    composer.result.current.setInput(text);
  });
};

/** A keydown on the textarea, with the modifiers given. */
const pressEnter = async (
  composer: Composer,
  modifiers: { altKey?: boolean; ctrlKey?: boolean } = {},
) => {
  await act(async () => {
    composer.result.current.handleKeyDown({
      key: 'Enter',
      altKey: Boolean(modifiers.altKey),
      ctrlKey: Boolean(modifiers.ctrlKey),
      metaKey: false,
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: () => undefined,
    } as never);
  });
};

/**
 * Fakes only the clocks the composer schedules with. A faked performance.now()
 * would read every Enter as the one that ends an IME composition.
 */
const useFakeClocks = () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
};

const submit = async (composer: Composer) => {
  await act(async () => {
    await composer.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });
};

/** The insert this composer sent last, as its `chat.insert` frame named it. */
const lastInsertId = () => {
  const frames = framesOf('chat.insert');
  return frames[frames.length - 1]?.insertId ?? '';
};

const deliverStatus = (
  composer: Composer,
  insertId: string,
  insertStatus: InsertStatus,
  extra: { insertReason?: string; sessionId?: string; content?: string } = {},
) => {
  act(() => {
    composer.result.current.handleInsertStatus({
      sessionId: extra.sessionId ?? SESSION_1.id,
      insertId,
      insertStatus,
      content: extra.content ?? '',
      ...(extra.insertReason ? { insertReason: extra.insertReason } : {}),
    });
  });
};

beforeEach(() => {
  sent = [];
  added = [];
  addedRowIds = [];
  removed = [];
  handOverPlan = null;
  appendQueuedMessage.mockReset();
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes('/hand-over-plan')) {
      return new Response(JSON.stringify(handOverPlan ? { success: true, data: handOverPlan } : { success: false }), {
        status: handOverPlan ? 200 : 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (String(url).includes('/api/assets/files')) {
      const form = init?.body instanceof FormData ? init.body : new FormData();
      const files = form.getAll('files') as File[];
      return new Response(JSON.stringify({ attachments: files.map((file) => ({ name: file.name, path: `/uploads/${file.name}` })) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (String(url).includes('/api/user/drafts/queued-message') && init?.method === 'POST') {
      // Nothing else is queued: the server queues the message on its own.
      const { queuedMessage } = JSON.parse(String(init.body)) as { queuedMessage: unknown };
      return new Response(JSON.stringify({ success: true, queuedMessage, appended: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  resetChatDrafts();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('sending while a turn runs', () => {
  it('Enter inserts the message into the turn: a chat.insert under a fresh UUID, the composer emptied, nothing queued', async () => {
    const composer = renderComposer();
    await type(composer, 'look at the tests too');

    await pressEnter(composer);

    const inserts = framesOf('chat.insert');
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0]?.sessionId, 'session-1');
    assert.equal(inserts[0]?.content, 'look at the tests too');
    assert.equal(UUID_V4.test(inserts[0]?.insertId ?? ''), true);
    assert.equal(framesOf('chat.send').length, 0);
    assert.equal(appendQueuedMessage.mock.calls.length, 0);
    assert.equal(composer.result.current.input, '');
    assert.equal(readDraftText('session-1'), '');
    assert.deepEqual(readInputHistory('session-1'), ['look at the tests too'], 'ArrowUp recalls it like any sent message');
    // Listed above the composer at once, before the server answers.
    assert.deepEqual(composer.result.current.pendingInserts.map((insert) => [insert.content, insert.state]), [
      ['look at the tests too', 'sending'],
    ]);
  });

  it('names the insert with a v4 UUID even where crypto.randomUUID is missing, as on a page served over plain HTTP', async () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const composer = renderComposer();
    await type(composer, 'from a LAN address');

    await pressEnter(composer);

    assert.equal(UUID_V4.test(lastInsertId()), true);
  });

  it('Alt+Enter queues it instead', async () => {
    const composer = renderComposer();
    await type(composer, 'after this turn');

    await pressEnter(composer, { altKey: true });

    await waitFor(() => assert.equal(appendQueuedMessage.mock.calls.length, 1));
    assert.equal(appendQueuedMessage.mock.calls[0]?.[1]?.content, 'after this turn');
    assert.equal(framesOf('chat.insert').length, 0);
  });

  it('with Ctrl+Enter to send, Ctrl+Enter inserts and Ctrl+Alt+Enter queues', async () => {
    const composer = renderComposer({ sendByCtrlEnter: true });
    await type(composer, 'inserted');
    await pressEnter(composer);
    assert.equal(framesOf('chat.insert').length, 0, 'plain Enter is a line break there');

    await pressEnter(composer, { ctrlKey: true });
    assert.equal(framesOf('chat.insert').length, 1);

    await type(composer, 'queued');
    await pressEnter(composer, { ctrlKey: true, altKey: true });
    await waitFor(() => assert.equal(appendQueuedMessage.mock.calls.length, 1));
    assert.equal(framesOf('chat.insert').length, 1);
  });

  it('the send button menu inserts or queues as picked', async () => {
    const composer = renderComposer();
    await type(composer, 'picked queue');
    await act(async () => {
      composer.result.current.submitWithBusyMode('queue');
    });
    await waitFor(() => assert.equal(appendQueuedMessage.mock.calls.length, 1));

    await type(composer, 'picked insert');
    await act(async () => {
      composer.result.current.submitWithBusyMode('insert');
    });
    assert.deepEqual(framesOf('chat.insert').map((frame) => frame.content), ['picked insert']);
  });

  const cannotInsert: Array<{
    name: string;
    overrides: Partial<ComposerArgs>;
    text: string;
    withFile?: boolean;
    reason: string;
  }> = [
    { name: 'a provider that cannot take messages mid-turn', overrides: { provider: 'codex', supportsMidRunInsert: false }, text: 'hello', reason: 'provider' },
    { name: 'a slash command', overrides: {}, text: '/compact', reason: 'slashCommand' },
    { name: 'a message with attachments', overrides: {}, text: 'see the file', withFile: true, reason: 'attachments' },
    { name: 'a closed socket', overrides: { isConnected: false }, text: 'hello', reason: 'unavailable' },
    { name: 'a turn a terminal CLI drives', overrides: { canAbortSession: false }, text: 'hello', reason: 'unavailable' },
  ];
  for (const variant of cannotInsert) {
    it(`queues ${variant.name}, and says why it cannot insert`, async () => {
      const composer = renderComposer(variant.overrides);
      await act(async () => {
        composer.result.current.setInput(variant.text);
        if (variant.withFile) {
          composer.result.current.setAttachedFiles([new File(['notes'], 'notes.txt', { type: 'text/plain' })]);
        }
      });
      assert.equal(composer.result.current.insertUnavailableReason, variant.reason);

      await submit(composer);

      await waitFor(() => assert.equal(appendQueuedMessage.mock.calls.length, 1));
      assert.equal(framesOf('chat.insert').length, 0);
    });
  }

  it('queues while an already-sent message is being replaced', async () => {
    const composer = renderComposer();
    await act(async () => {
      composer.result.current.beginEditMessage({
        type: 'user',
        content: 'the old question',
        timestamp: '2026-10-28T10:00:00.000Z',
        transcriptAnchorId: 'turn-1',
      });
    });

    assert.equal(composer.result.current.insertUnavailableReason, 'unavailable');
    await submit(composer);

    await waitFor(() => assert.equal(appendQueuedMessage.mock.calls.length, 1));
    assert.equal(framesOf('chat.insert').length, 0);
  });

  it('says Enter inserts while the message can go in', async () => {
    const composer = renderComposer();
    await type(composer, 'hello');
    assert.equal(composer.result.current.insertUnavailableReason, null);
  });
});

describe('an insert the server refuses', () => {
  it('NO_ACTIVE_RUN on a session gone idle sends it as a normal message, keeping what was typed since', async () => {
    const composer = renderComposer();
    await type(composer, 'one more thing');
    await pressEnter(composer);
    const insertId = lastInsertId();

    // The turn ended before the insert reached the server.
    composer.rerender({ isLoading: false, canAbortSession: false });
    await type(composer, 'typed since');
    deliverStatus(composer, insertId, 'refused', { insertReason: 'NO_ACTIVE_RUN' });

    await waitFor(() => assert.equal(framesOf('chat.send').length, 1));
    assert.equal(framesOf('chat.send')[0]?.content, 'one more thing');
    assert.equal(framesOf('chat.send')[0]?.sessionId, 'session-1');
    assert.equal(composer.result.current.input, 'typed since');
    assert.equal(appendQueuedMessage.mock.calls.length, 0);
    assert.deepEqual(composer.result.current.pendingInserts, []);
  });

  it('NO_ACTIVE_RUN while a turn is still in flight queues it', async () => {
    const composer = renderComposer();
    await type(composer, 'not yet');
    await pressEnter(composer);

    // The turn has started but its runtime cannot take inserts yet.
    deliverStatus(composer, lastInsertId(), 'refused', { insertReason: 'NO_ACTIVE_RUN' });

    await waitFor(() => assert.equal(appendQueuedMessage.mock.calls.length, 1));
    assert.equal(appendQueuedMessage.mock.calls[0]?.[0], 'session-1');
    assert.equal(appendQueuedMessage.mock.calls[0]?.[1]?.content, 'not yet');
    assert.equal(framesOf('chat.send').length, 0);
    assert.equal(composer.result.current.input, '');
  });

  for (const insertReason of ['UNSUPPORTED', 'SLASH_COMMAND']) {
    it(`${insertReason} queues it, keeping what was typed since`, async () => {
      const composer = renderComposer();
      await type(composer, 'queue me');
      await pressEnter(composer);
      await type(composer, 'typed since');

      deliverStatus(composer, lastInsertId(), 'refused', { insertReason });

      await waitFor(() => assert.equal(appendQueuedMessage.mock.calls.length, 1));
      assert.equal(appendQueuedMessage.mock.calls[0]?.[1]?.content, 'queue me');
      assert.equal(framesOf('chat.send').length, 0);
      // The card shows once the server has the message.
      await waitFor(() => assert.equal(composer.result.current.queuedDraft?.content, 'queue me'));
      assert.equal(composer.result.current.input, 'typed since');
    });
  }

  const backgroundOnly: SessionActivityMap = new Map([[
    'session-1',
    {
      statusText: null,
      canInterrupt: false,
      startedAt: 1,
      background: true,
      tasks: [{ taskId: 'w1', toolUseId: 'toolu_wf', taskType: 'local_workflow', description: 'Audit', workflowName: 'audit', startedAt: 1 }],
    },
  ]]);

  it('NO_ACTIVE_RUN on a session left with background work sends it at once, as a new turn the work keeps running beside', async () => {
    const composer = renderComposer();
    await type(composer, 'over the workflow');
    await pressEnter(composer);
    const insertId = lastInsertId();
    composer.rerender({ isLoading: false, canAbortSession: false, processingSessions: backgroundOnly });

    deliverStatus(composer, insertId, 'refused', { insertReason: 'NO_ACTIVE_RUN' });
    await waitFor(() => assert.equal(framesOf('chat.send').length, 1));
    assert.equal(framesOf('chat.send')[0]?.content, 'over the workflow');
    assert.equal((framesOf('chat.send')[0] as { options?: Record<string, unknown> })?.options?.keepBackgroundWork, true);
    assert.equal(composer.result.current.backgroundSendPrompt, null, 'nothing to ask: the work is not stopped');
    assert.equal(appendQueuedMessage.mock.calls.length, 0);
  });

  it('NO_ACTIVE_RUN on a session left with background work asks first, naming the change, when the turn cannot go into the process the work runs in', async () => {
    handOverPlan = { heldWork: true, canHandOver: false, changes: ['model'] };
    const composer = renderComposer();
    await type(composer, 'on another model');
    await pressEnter(composer);
    const insertId = lastInsertId();
    composer.rerender({ isLoading: false, canAbortSession: false, processingSessions: backgroundOnly });

    deliverStatus(composer, insertId, 'refused', { insertReason: 'NO_ACTIVE_RUN' });
    await waitFor(() => assert.deepEqual(composer.result.current.backgroundSendPrompt, { work: ['Workflow audit'], changes: ['model'] }));
    assert.equal(framesOf('chat.send').length, 0);
    await act(async () => {
      composer.result.current.resolveBackgroundSendPrompt('cancel');
    });

    assert.equal(composer.result.current.input, 'on another model');
    assert.equal(framesOf('chat.send').length, 0);
  });

  it('NO_ACTIVE_RUN on a session left with background work asks first once its provider no longer takes inserts: cancel gives the text back', async () => {
    const composer = renderComposer();
    await type(composer, 'after the workflow');
    await pressEnter(composer);
    const insertId = lastInsertId();
    composer.rerender({ isLoading: false, canAbortSession: false, processingSessions: backgroundOnly, supportsMidRunInsert: false });

    deliverStatus(composer, insertId, 'refused', { insertReason: 'NO_ACTIVE_RUN' });
    await waitFor(() => assert.notEqual(composer.result.current.backgroundSendPrompt, null));
    await act(async () => {
      composer.result.current.resolveBackgroundSendPrompt('cancel');
    });

    assert.equal(composer.result.current.input, 'after the workflow');
    assert.equal(framesOf('chat.send').length, 0);
    assert.equal(appendQueuedMessage.mock.calls.length, 0);
  });

  it('NO_ACTIVE_RUN on a session left with background work asks nothing when another session shows by the time the plan comes back, giving the text back to its session\'s draft', async () => {
    handOverPlan = { heldWork: true, canHandOver: false, changes: ['model'] };
    const composer = renderComposer();
    await type(composer, 'on another model');
    await pressEnter(composer);
    const insertId = lastInsertId();
    const idle: Partial<ComposerArgs> = { isLoading: false, canAbortSession: false, processingSessions: backgroundOnly };
    composer.rerender(idle);
    await type(composer, 'typed since');

    // The refusal sends for the plan, and session two opens before the plan
    // can come back: nothing else runs between these two lines.
    deliverStatus(composer, insertId, 'refused', { insertReason: 'NO_ACTIVE_RUN' });
    composer.rerender({ ...idle, selectedSession: SESSION_2, currentSessionId: SESSION_2.id });

    await waitFor(() => assert.equal(
      composer.result.current.backgroundSendPrompt !== null || readDraftText('session-1') !== 'typed since',
      true,
    ));
    assert.equal(composer.result.current.backgroundSendPrompt, null, 'nothing is asked over session two');
    assert.equal(readDraftText('session-1'), 'on another model\n\ntyped since');
    assert.equal(framesOf('chat.send').length, 0);
    assert.equal(appendQueuedMessage.mock.calls.length, 0);
    assert.equal(composer.result.current.input, '');
  });

  it('INVALID gives the text back and says it was not delivered', async () => {
    const composer = renderComposer();
    await type(composer, 'malformed');
    await pressEnter(composer);

    deliverStatus(composer, lastInsertId(), 'refused', { insertReason: 'INVALID' });

    assert.equal(composer.result.current.input, 'malformed');
    assert.equal(added.some((message) => message.type === 'error'), true);
    assert.equal(appendQueuedMessage.mock.calls.length, 0);
  });
});

describe('an insert that gets no answer', () => {
  it('gives its text back after 5 s without queueing it, and takes a late acceptance back', async () => {
    useFakeClocks();
    const composer = renderComposer();
    await type(composer, 'anyone there?');
    await pressEnter(composer);
    const insertId = lastInsertId();

    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    assert.equal(composer.result.current.input, '');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    assert.equal(composer.result.current.input, 'anyone there?');
    assert.deepEqual(composer.result.current.pendingInserts, []);
    assert.equal(appendQueuedMessage.mock.calls.length, 0);
    assert.equal(added.filter((message) => message.type === 'error').length, 1);

    // The server took it after all: the text is in the composer, so the insert is withdrawn.
    deliverStatus(composer, insertId, 'pending', { content: 'anyone there?' });
    assert.deepEqual(framesOf('chat.insert-cancel').map((frame) => frame.insertId), [insertId]);
    assert.deepEqual(composer.result.current.pendingInserts, []);
  });

  /** Sends one insert and lets it go unanswered, so its text comes back with a notice. */
  const sendUnanswered = async (composer: Composer, text: string) => {
    await type(composer, text);
    await pressEnter(composer);
    const insertId = lastInsertId();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    assert.equal(composer.result.current.input, text);
    const noticeIndex = added.findIndex((message) => message.type === 'error');
    return { insertId, noticeRowId: addedRowIds[noticeIndex] ?? '' };
  };

  it('takes the text back out, keeping what was typed after it, and drops the notice, once a late status says the model read it', async () => {
    useFakeClocks();
    const composer = renderComposer();
    const { insertId, noticeRowId } = await sendUnanswered(composer, 'anyone there?');
    assert.notEqual(noticeRowId, '', 'the notice was written under a row id it can be taken out by');
    await type(composer, 'anyone there?\n\ntyped since');

    // The server had it after all: the withdrawal comes too late.
    deliverStatus(composer, insertId, 'pending', { content: 'anyone there?' });
    deliverStatus(composer, insertId, 'cancel_failed', { insertReason: 'NOT_FOUND' });
    deliverStatus(composer, insertId, 'delivered', { content: 'anyone there?' });

    assert.equal(composer.result.current.input, 'typed since');
    assert.equal(readDraftText('session-1'), 'typed since');
    assert.deepEqual(removed, [['session-1', noticeRowId]]);
    assert.equal(added.filter((message) => message.type === 'error').length, 1, 'and says nothing more');
  });

  it('takes the text out of its session\'s draft when the composer has moved on, after a next-turn delivery', async () => {
    useFakeClocks();
    const composer = renderComposer();
    const { insertId } = await sendUnanswered(composer, 'ran as the next turn');
    composer.rerender({ selectedSession: SESSION_2, currentSessionId: SESSION_2.id });
    await type(composer, 'typing in session two');

    deliverStatus(composer, insertId, 'next_turn', { content: 'ran as the next turn' });

    assert.equal(readDraftText('session-1'), '');
    assert.equal(composer.result.current.input, 'typing in session two');
  });

  it('leaves text the user has changed since, and says the insert landed', async () => {
    useFakeClocks();
    const composer = renderComposer();
    const { insertId, noticeRowId } = await sendUnanswered(composer, 'anyone there?');
    await type(composer, 'anyone there? Please');

    deliverStatus(composer, insertId, 'delivered', { content: 'anyone there?' });

    assert.equal(composer.result.current.input, 'anyone there? Please');
    assert.deepEqual(removed, [['session-1', noticeRowId]]);
    const errors = added.filter((message) => message.type === 'error').map((message) => message.content);
    assert.deepEqual(errors, [
      'The insert got no answer, so the message is back in the composer.',
      'The insert was delivered after all, so it does not need sending again.',
    ]);
  });

  it('keeps the text and the notice when the late insert is withdrawn after all', async () => {
    useFakeClocks();
    const composer = renderComposer();
    const { insertId } = await sendUnanswered(composer, 'anyone there?');

    deliverStatus(composer, insertId, 'pending', { content: 'anyone there?' });
    deliverStatus(composer, insertId, 'cancelled', { content: 'anyone there?' });

    assert.equal(composer.result.current.input, 'anyone there?');
    assert.deepEqual(removed, []);
    assert.deepEqual(framesOf('chat.insert-cancel').map((frame) => frame.insertId), [insertId]);
  });

  it('takes the text back out when the transcript holds the insert once the run is over, with no status heard', async () => {
    useFakeClocks();
    const findTranscriptMessages = vi.fn(async (_sessionId: string, ids: string[]) => new Set(ids));
    const composer = renderComposer({ findTranscriptMessages });
    const { insertId, noticeRowId } = await sendUnanswered(composer, 'heard by nobody');
    vi.useRealTimers();

    // The socket was away; the subscribe on its return finds the run over.
    await act(async () => {
      composer.result.current.handleInsertRunEnded('session-1', Date.now() + 1);
    });

    await waitFor(() => assert.equal(composer.result.current.input, ''));
    assert.deepEqual(findTranscriptMessages.mock.calls[0], ['session-1', [insertId]]);
    assert.deepEqual(removed, [['session-1', noticeRowId]]);
  });

  it('keeps an accepted insert waiting however long its tool runs', async () => {
    useFakeClocks();
    const composer = renderComposer();
    await type(composer, 'after the build');
    await pressEnter(composer);
    deliverStatus(composer, lastInsertId(), 'pending', { content: 'after the build' });

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    assert.equal(composer.result.current.input, '');
    assert.deepEqual(composer.result.current.pendingInserts.map((insert) => insert.state), ['pending']);
  });
});

describe('an insert that does not land', () => {
  it('cancelled gives the text back ahead of what was typed since, without a word', async () => {
    const composer = renderComposer();
    await type(composer, 'first thought');
    await pressEnter(composer);
    const insertId = lastInsertId();
    deliverStatus(composer, insertId, 'pending', { content: 'first thought' });
    await type(composer, 'typed later');

    deliverStatus(composer, insertId, 'cancelled', { content: 'first thought' });

    assert.equal(composer.result.current.input, 'first thought\n\ntyped later');
    assert.equal(readDraftText('session-1'), 'first thought\n\ntyped later');
    assert.deepEqual(composer.result.current.pendingInserts, []);
    assert.equal(added.length, 0);
  });

  it('failed gives the text back and says it was not delivered', async () => {
    const composer = renderComposer();
    await type(composer, 'lost one');
    await pressEnter(composer);
    const insertId = lastInsertId();
    deliverStatus(composer, insertId, 'pending', { content: 'lost one' });

    deliverStatus(composer, insertId, 'failed', { content: 'lost one' });

    assert.equal(composer.result.current.input, 'lost one');
    assert.equal(added.filter((message) => message.type === 'error').length, 1);
  });

  it('texts given back in a burst line up in the order they were sent', async () => {
    useFakeClocks();
    vi.setSystemTime(new Date('2026-10-28T10:00:00.000Z'));
    const composer = renderComposer();
    const ids: string[] = [];
    for (const text of ['A', 'B', 'C']) {
      await type(composer, text);
      await pressEnter(composer);
      ids.push(lastInsertId());
      deliverStatus(composer, lastInsertId(), 'pending', { content: text });
      vi.setSystemTime(Date.now() + 1_000);
    }
    await type(composer, 'typed since');

    // A stop takes all three back, reported in another order.
    for (const index of [2, 0, 1]) {
      deliverStatus(composer, ids[index] ?? '', 'cancelled');
    }

    assert.equal(composer.result.current.input, 'A\n\nB\n\nC\n\ntyped since');
  });

  it('a text given back and sent again is no longer the block the next text goes in front of', async () => {
    useFakeClocks();
    vi.setSystemTime(new Date('2026-10-28T10:00:00.000Z'));
    const composer = renderComposer();
    await type(composer, 'A');
    await pressEnter(composer);
    const firstA = lastInsertId();
    deliverStatus(composer, firstA, 'pending', { content: 'A' });
    vi.setSystemTime(Date.now() + 1_000);
    await type(composer, 'C');
    await pressEnter(composer);
    const c = lastInsertId();
    deliverStatus(composer, c, 'pending', { content: 'C' });

    deliverStatus(composer, firstA, 'cancelled');
    assert.equal(composer.result.current.input, 'A');
    // Sent again as it came back, and then the same words typed anew with more after them.
    await pressEnter(composer);
    await type(composer, 'A\n\nX');
    deliverStatus(composer, c, 'cancelled');

    assert.equal(composer.result.current.input, 'C\n\nA\n\nX');
  });

  it('a delivered or next-turn insert leaves the list and gives nothing back', async () => {
    const composer = renderComposer();
    for (const insertStatus of ['delivered', 'next_turn'] as const) {
      await type(composer, insertStatus);
      await pressEnter(composer);
      deliverStatus(composer, lastInsertId(), 'pending', { content: insertStatus });
      deliverStatus(composer, lastInsertId(), insertStatus, { content: insertStatus });
    }

    assert.deepEqual(composer.result.current.pendingInserts, []);
    assert.equal(composer.result.current.input, '');
    assert.equal(added.length, 0);
  });

  it('goes back only to the composer that sent it, so two panes on the session show it once', async () => {
    const left = renderComposer();
    const right = renderComposer();
    await type(left, 'from the left pane');
    await pressEnter(left);
    const insertId = lastInsertId();

    // Both panes hear every frame of the page's one socket.
    for (const pane of [left, right]) {
      deliverStatus(pane, insertId, 'pending', { content: 'from the left pane' });
    }
    assert.deepEqual(right.result.current.pendingInserts.map((insert) => insert.content), ['from the left pane']);
    for (const pane of [left, right]) {
      deliverStatus(pane, insertId, 'cancelled', { content: 'from the left pane' });
    }

    // The session's one draft mirrors into both composers; given back once, it reads once.
    assert.equal(left.result.current.input, 'from the left pane');
    assert.equal(right.result.current.input, 'from the left pane');
    assert.deepEqual(right.result.current.pendingInserts, []);
  });

  // Two frames back to back with no render between them (a run that ends
  // fails every insert in one tick), in either order, heard by the panes in
  // either order: the pane giving back second must build on the text the
  // other wrote into the shared draft, not on the one it last rendered.
  for (const frameOrder of ['left first', 'right first'] as const) {
    for (const listenerOrder of ['left first', 'right first'] as const) {
      it(`keeps both texts when two panes on the session each give one back in one burst (frames ${frameOrder}, heard ${listenerOrder})`, async () => {
        const left = renderComposer();
        const right = renderComposer();
        await type(left, 'from the left');
        await pressEnter(left);
        const leftId = lastInsertId();
        await type(right, 'from the right');
        await pressEnter(right);
        const rightId = lastInsertId();
        for (const [insertId, content] of [[leftId, 'from the left'], [rightId, 'from the right']]) {
          for (const pane of [left, right]) {
            deliverStatus(pane, insertId, 'pending', { content });
          }
        }

        const ids = frameOrder === 'left first' ? [leftId, rightId] : [rightId, leftId];
        const panes = listenerOrder === 'left first' ? [left, right] : [right, left];
        act(() => {
          for (const insertId of ids) {
            for (const pane of panes) {
              pane.result.current.handleInsertStatus({ sessionId: SESSION_1.id, insertId, insertStatus: 'failed', content: '' });
            }
          }
        });

        for (const text of [left.result.current.input, right.result.current.input, readDraftText('session-1')]) {
          assert.equal(text.includes('from the left'), true, text);
          assert.equal(text.includes('from the right'), true, text);
        }
        assert.equal(left.result.current.input, right.result.current.input);
      });
    }
  }

  it('goes into its session\'s draft when the composer has moved to another session', async () => {
    const composer = renderComposer();
    await type(composer, 'meant for session one');
    await pressEnter(composer);
    const insertId = lastInsertId();
    deliverStatus(composer, insertId, 'pending', { content: 'meant for session one' });

    composer.rerender({ selectedSession: SESSION_2, currentSessionId: SESSION_2.id });
    await type(composer, 'typing in session two');
    deliverStatus(composer, insertId, 'failed');

    assert.equal(readDraftText('session-1'), 'meant for session one');
    assert.equal(composer.result.current.input, 'typing in session two');
    // Said in the transcript it belongs to, not in the one on screen.
    assert.equal(added.length, 0);
  });
});

describe('withdrawing an insert', () => {
  it('sends chat.insert-cancel for one the server holds, and shows when it is too late', async () => {
    const composer = renderComposer();
    await type(composer, 'never mind');
    await pressEnter(composer);
    const insertId = lastInsertId();

    act(() => {
      composer.result.current.withdrawInsert(insertId);
    });
    assert.equal(framesOf('chat.insert-cancel').length, 0, 'not before the server has it');

    deliverStatus(composer, insertId, 'pending', { content: 'never mind' });
    act(() => {
      composer.result.current.withdrawInsert(insertId);
    });
    assert.deepEqual(framesOf('chat.insert-cancel'), [{ type: 'chat.insert-cancel', sessionId: 'session-1', insertId }]);
    assert.deepEqual(composer.result.current.pendingInserts.map((insert) => insert.state), ['withdrawing']);

    deliverStatus(composer, insertId, 'cancel_failed');
    assert.deepEqual(composer.result.current.pendingInserts.map((insert) => insert.state), ['delivering']);
  });

  it('marks a withdrawal refused for another reason as failed', async () => {
    const composer = renderComposer();
    await type(composer, 'too late');
    await pressEnter(composer);
    const insertId = lastInsertId();
    deliverStatus(composer, insertId, 'pending', { content: 'too late' });
    act(() => {
      composer.result.current.withdrawInsert(insertId);
    });

    deliverStatus(composer, insertId, 'cancel_failed', { insertReason: 'NOT_FOUND' });

    assert.deepEqual(composer.result.current.pendingInserts.map((insert) => insert.state), ['withdrawFailed']);
  });
});

describe('inserts sent elsewhere', () => {
  it('are listed from their pending status and leave when the run is over', async () => {
    const composer = renderComposer();
    deliverStatus(composer, 'insert-from-another-tab', 'pending', { content: 'typed in another tab' });
    assert.deepEqual(composer.result.current.pendingInserts.map((insert) => [insert.content, insert.state]), [
      ['typed in another tab', 'pending'],
    ]);

    act(() => {
      composer.result.current.handleInsertRunEnded('session-1', Date.now());
    });

    assert.deepEqual(composer.result.current.pendingInserts, []);
    assert.equal(composer.result.current.input, '', 'another tab\'s text never lands here');
  });
});

describe('after a reload', () => {
  const sendAcceptedInsertThenReload = async (text: string) => {
    const before = renderComposer();
    await type(before, text);
    await pressEnter(before);
    const insertId = lastInsertId();
    deliverStatus(before, insertId, 'pending', { content: text });
    before.unmount();
    return insertId;
  };

  it('the composer adopts the tab\'s stored insert, and an idle ack gives it back when the transcript lacks it', async () => {
    await sendAcceptedInsertThenReload('sent before the reload');
    const findTranscriptMessages = vi.fn(async () => new Set<string>());

    const after = renderComposer({ findTranscriptMessages });
    assert.deepEqual(after.result.current.pendingInserts.map((insert) => [insert.content, insert.state]), [
      ['sent before the reload', 'pending'],
    ]);

    act(() => {
      after.result.current.handleInsertRunEnded('session-1', Date.now() + 1);
    });

    await waitFor(() => assert.equal(after.result.current.input, 'sent before the reload'));
    assert.deepEqual(after.result.current.pendingInserts, []);
    assert.equal(added.filter((message) => message.type === 'error').length, 1);
  });

  it('an idle ack drops a stored insert the transcript holds, giving nothing back', async () => {
    const insertId = await sendAcceptedInsertThenReload('it landed');
    const findTranscriptMessages = vi.fn(async () => new Set([insertId]));

    const after = renderComposer({ findTranscriptMessages });
    act(() => {
      after.result.current.handleInsertRunEnded('session-1', Date.now() + 1);
    });

    await waitFor(() => assert.deepEqual(after.result.current.pendingInserts, []));
    assert.deepEqual(findTranscriptMessages.mock.calls[0], ['session-1', [insertId]]);
    assert.equal(after.result.current.input, '');
    assert.equal(sessionStorage.length, 0, 'nothing of it is left to adopt');
  });

  it('an insert the server never answered gives its text back once, after the adopting composer\'s own wait', async () => {
    useFakeClocks();
    const before = renderComposer();
    await type(before, 'unanswered');
    await pressEnter(before);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    before.unmount();

    const after = renderComposer();
    assert.deepEqual(after.result.current.pendingInserts.map((insert) => insert.state), ['sending']);
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    assert.equal(after.result.current.input, '', 'the wait starts again with the reload');

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    assert.equal(after.result.current.input, 'unanswered');
  });

  it('a stored insert older than a day is dropped, not adopted', async () => {
    const stale: OwnInsert = {
      insertId: '0f6c8c9e-3a5b-4c7d-8e9f-0a1b2c3d4e5f',
      sessionId: 'session-1',
      content: 'from long ago',
      sentAt: Date.now() - 25 * 60 * 60 * 1000,
      accepted: true,
    };
    sessionStorage.setItem('chat-own-inserts', JSON.stringify([stale]));

    const composer = renderComposer();

    assert.deepEqual(composer.result.current.pendingInserts, []);
    assert.equal(sessionStorage.getItem('chat-own-inserts'), null);
  });

  it('an idle ack for a subscribe sent before the insert leaves the insert waiting', async () => {
    const findTranscriptMessages = vi.fn(async () => new Set<string>());
    const composer = renderComposer({ findTranscriptMessages });
    await type(composer, 'sent after the subscribe');
    await pressEnter(composer);
    deliverStatus(composer, lastInsertId(), 'pending', { content: 'sent after the subscribe' });

    await act(async () => {
      composer.result.current.handleInsertRunEnded('session-1', Date.now() - 60_000);
      // Whatever the lookup would settle has settled by now.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(findTranscriptMessages.mock.calls.length, 0);
    assert.deepEqual(composer.result.current.pendingInserts.map((insert) => insert.state), ['pending']);
    assert.equal(composer.result.current.input, '');
  });
});

describe('the end of a run that never reported an insert', () => {
  it('a complete settles an accepted insert from the transcript, giving it back when it is not there', async () => {
    const findTranscriptMessages = vi.fn(async () => new Set<string>());
    const composer = renderComposer({ findTranscriptMessages });
    await type(composer, 'reported nowhere');
    await pressEnter(composer);
    const insertId = lastInsertId();
    deliverStatus(composer, insertId, 'pending', { content: 'reported nowhere' });

    act(() => {
      composer.result.current.handleInsertRunEnded('session-1', null);
    });

    await waitFor(() => assert.equal(composer.result.current.input, 'reported nowhere'));
    assert.deepEqual(findTranscriptMessages.mock.calls[0], ['session-1', [insertId]]);
    assert.deepEqual(composer.result.current.pendingInserts, []);
  });

  it('a complete leaves an unanswered insert to the server\'s answer, which may be a refusal', async () => {
    const findTranscriptMessages = vi.fn(async () => new Set<string>());
    const composer = renderComposer({ findTranscriptMessages });
    await type(composer, 'just as it ended');
    await pressEnter(composer);

    act(() => {
      composer.result.current.handleInsertRunEnded('session-1', null);
    });

    assert.equal(findTranscriptMessages.mock.calls.length, 0);
    assert.deepEqual(composer.result.current.pendingInserts.map((insert) => insert.state), ['sending']);
    assert.equal(composer.result.current.input, '');
  });

  it('an idle ack settles an unanswered insert sent before its subscribe, whose answer went to a socket now gone', async () => {
    const composer = renderComposer({ findTranscriptMessages: async (_sessionId, ids) => new Set(ids) });
    await type(composer, 'answered while away');
    await pressEnter(composer);

    act(() => {
      composer.result.current.handleInsertRunEnded('session-1', Date.now() + 1);
    });

    await waitFor(() => assert.deepEqual(composer.result.current.pendingInserts, []));
    assert.equal(composer.result.current.input, '');
    assert.equal(added.length, 0);
  });
});

describe('an idle session', () => {
  it('sends Enter and Alt+Enter as normal messages, never as inserts', async () => {
    const composer = renderComposer({ isLoading: false, canAbortSession: false, processingSessions: new Map() as SessionActivityMap });
    await type(composer, 'plain send');
    await pressEnter(composer, { altKey: true });

    assert.deepEqual(framesOf('chat.send').map((frame) => frame.content), ['plain send']);
    assert.equal(framesOf('chat.insert').length, 0);
    assert.equal(appendQueuedMessage.mock.calls.length, 0);
  });
});
