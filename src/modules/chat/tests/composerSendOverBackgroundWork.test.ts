import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { clearQueuedMessage, readDraftText, readQueuedMessage, resetChatDrafts, writeDraftText } from '@/shared/chatDrafts';
import type * as ChatDrafts from '@/shared/chatDrafts';
import type { BackgroundSendChoice, PermissionMode, Project, ProjectSession, SessionActivityMap } from '@/shared/types';

/**
 * A session whose turn has ended with background work still running keeps
 * its composer usable. Claude (a provider that takes inserts) runs the next
 * message as a new turn of the process the work runs in, so it sends, asking
 * the server first whether the message can go there: a setting that only a
 * new process can apply (or an edit) would stop the work, and then the
 * composer asks, naming it. Its sends carry keepBackgroundWork, so a send the
 * server cannot run beside the work comes back refused, and the composer
 * undoes it and asks. The send key with Alt queues the message until the work
 * finishes. Where every new turn replaces the CLI process that work runs
 * under (other providers, or an edit), the work is stopped or finishes where
 * nothing listens, so the composer says so and asks before sending: send
 * anyway, queue the message until the work finishes (the server holds it
 * while the work runs), or cancel. It asks only while it shows the session:
 * once the user has opened another, nothing is asked or sent, and the
 * message waits in its session's draft.
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

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };
const UPLOADED = { name: 'notes.txt', path: '/uploads/notes.txt', mimeType: 'text/plain', size: 5 };

const backgroundOnly: SessionActivityMap = new Map([[
  'session-1',
  {
    statusText: null,
    canInterrupt: false,
    startedAt: 1,
    background: true,
    tasks: [
      { taskId: 'w1', toolUseId: 'toolu_wf', taskType: 'local_workflow', description: 'Audit the frontend', workflowName: 'frontend-architecture-audit', startedAt: 1 },
      { taskId: 'b1', toolUseId: 'toolu_inner', taskType: 'local_bash', description: 'Sleep for 60 seconds', startedAt: 2, nested: true },
      { taskId: 'a1', toolUseId: 'toolu_agent', taskType: 'local_agent', description: 'Survey the repo', startedAt: 3 },
    ],
  },
]]);

const uploads = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/api/assets/files'));

/** What the server answers about running the next turn in the held process; null answers 404, as an older server does. */
let handOverPlan: { heldWork: boolean; canHandOver: boolean; changes: string[] } | null = null;
/** Held open by a test to keep the hand-over plan request in flight, as a slow connection would. */
let planGate: Promise<void> | null = null;
/** Held open by a test to keep a file upload in flight, as a slow connection would. */
let uploadGate: Promise<void> | null = null;
const planRequests = () => vi.mocked(fetch).mock.calls
  .filter(([url]) => String(url).includes('/hand-over-plan'))
  .map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init?.body)) as { options: Record<string, unknown> } }));

type ComposerArgs = Parameters<typeof useChatComposerState>[0];
type SentFrame = { type: string; sessionId?: string; content?: string; options?: Record<string, unknown> };

const render = (processingSessions: SessionActivityMap, overrides: Partial<ComposerArgs> = {}) => {
  const sent: SentFrame[] = [];
  const view = renderHook(({ session }: { session: ProjectSession }) =>
    useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: session,
      currentSessionId: session.id,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: false,
      processingSessions,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message) => { sent.push(message as SentFrame); },
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
      ...overrides,
    }),
    { initialProps: { session: SESSION } },
  );
  const sends = () => sent.filter((message) => message.type === 'chat.send');
  return { view, sends };
};

type View = ReturnType<typeof render>['view'];

const startSubmit = (view: View) => {
  let pending!: Promise<void>;
  act(() => {
    pending = view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });
  return pending;
};

// Submits, waits for the prompt, answers it, and lets the submit finish.
const submitAndAnswer = async (view: View, choice: BackgroundSendChoice) => {
  const pending = startSubmit(view);
  await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));
  await act(async () => {
    view.result.current.resolveBackgroundSendPrompt(choice);
    await pending;
  });
};

// Lets the held request a pending submit waits on come back, and tells what
// the submit did then: `settled` when it ended by itself, `asked` when it
// opened a prompt and now waits for an answer.
const releaseAndSettle = async (view: View, pending: Promise<void>, release: () => void) => {
  let settled = false;
  void pending.then(() => { settled = true; });
  await act(async () => { release(); });
  await waitFor(() => assert.equal(settled || view.result.current.backgroundSendPrompt !== null, true));
  return settled ? 'settled' : 'asked';
};

beforeEach(() => {
  handOverPlan = null;
  planGate = null;
  uploadGate = null;
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes('/hand-over-plan') && init?.method === 'POST') {
      await planGate;
      return handOverPlan
        ? new Response(JSON.stringify({ success: true, data: handOverPlan }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).includes('/api/assets/files')) {
      await uploadGate;
      return new Response(JSON.stringify({ attachments: [UPLOADED] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).includes('/api/user/drafts/queued-message') && init?.method === 'POST') {
      // Nothing else is queued: the server queues the message on its own.
      const { queuedMessage } = JSON.parse(String(init.body)) as { queuedMessage: unknown };
      return new Response(JSON.stringify({ success: true, queuedMessage, appended: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  // The drafts store is module state; a message queued, or a text given back,
  // by one test must not be restored into the next one's composer.
  resetChatDrafts();
  clearQueuedMessage(SESSION.id);
  appendQueuedMessage.mockReset();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('sending on a session with background work asks first, naming the session\'s own tasks', async () => {
  const { view, sends } = render(backgroundOnly);
  await act(async () => { view.result.current.setInput('hello'); });

  const pending = startSubmit(view);
  await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));

  assert.deepEqual(view.result.current.backgroundSendPrompt, {
    work: ['Workflow frontend-architecture-audit', 'Agent Survey the repo'],
  });
  assert.equal(sends().length, 0, 'nothing is sent while the prompt is open');

  await act(async () => {
    view.result.current.resolveBackgroundSendPrompt('cancel');
    await pending;
  });
});

test('cancel (the default answer to Enter, Esc or a click outside) sends nothing and keeps the draft', async () => {
  const { view, sends } = render(backgroundOnly);
  await act(async () => { view.result.current.setInput('hello'); });

  await submitAndAnswer(view, 'cancel');

  assert.equal(sends().length, 0, 'declined: nothing is sent');
  assert.equal(appendQueuedMessage.mock.calls.length, 0, 'and nothing is queued');
  assert.equal(view.result.current.input, 'hello', 'and the draft stays in the composer');
  assert.equal(view.result.current.backgroundSendPrompt, null, 'and the prompt closes');
});

test('queue persists the message behind the work with its uploaded files, sends nothing, and clears the composer', async () => {
  const { view, sends } = render(backgroundOnly);
  await act(async () => {
    view.result.current.setInput('hello');
    view.result.current.setAttachedFiles([new File(['notes'], 'notes.txt', { type: 'text/plain' })]);
  });

  await submitAndAnswer(view, 'queue');

  assert.equal(sends().length, 0, 'queued: nothing is sent now');
  assert.equal(uploads().length, 1, 'the files uploaded before the prompt are not uploaded again');
  // Queued on the server at once, the same as queueing during a turn.
  assert.equal(appendQueuedMessage.mock.calls.length, 1);
  assert.equal(appendQueuedMessage.mock.calls[0]?.[0], 'session-1');
  const stored = readQueuedMessage('session-1');
  assert.equal(stored?.content, 'hello');
  assert.deepEqual(stored?.attachments, [UPLOADED]);
  assert.equal(stored?.options?.model, 'test-model');
  assert.equal(view.result.current.queuedDraft?.content, 'hello', 'the queued card shows the message');
  assert.equal(view.result.current.input, '', 'and the composer is cleared, as when queueing during a turn');
  assert.equal(view.result.current.attachedFiles.length, 0);
});

test('send anyway sends the message', async () => {
  const { view, sends } = render(backgroundOnly);
  await act(async () => { view.result.current.setInput('hello'); });

  await submitAndAnswer(view, 'send');

  assert.equal(sends().length, 1);
  assert.equal(sends()[0]?.options?.keepBackgroundWork, undefined, 'such a provider has no process to keep');
  assert.equal(appendQueuedMessage.mock.calls.length, 0);
  assert.equal(planRequests().length, 0, 'and nothing to ask the server about');
});

test('a second submit while the prompt is open neither opens another prompt nor sends', async () => {
  const { view, sends } = render(backgroundOnly);
  await act(async () => { view.result.current.setInput('hello'); });

  const first = startSubmit(view);
  await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));
  const prompt = view.result.current.backgroundSendPrompt;

  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });
  assert.equal(view.result.current.backgroundSendPrompt, prompt, 'the same prompt is still the open one');
  assert.equal(sends().length, 0);

  await act(async () => {
    view.result.current.resolveBackgroundSendPrompt('cancel');
    await first;
  });
  assert.equal(sends().length, 0, 'exactly zero sends');
});

test('asks nothing and sends nothing when its files finish uploading after a switch to another session, leaving the message in its session\'s draft', async () => {
  let releaseUpload!: () => void;
  uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve; });
  writeDraftText('session-2', 'half-written note for two');
  const { view, sends } = render(backgroundOnly);
  await act(async () => {
    view.result.current.setInput('hello');
    view.result.current.setAttachedFiles([new File(['notes'], 'notes.txt', { type: 'text/plain' })]);
  });

  const pending = startSubmit(view);
  await waitFor(() => assert.equal(uploads().length, 1));
  await act(async () => { view.rerender({ session: { id: 'session-2' } }); });

  assert.equal(await releaseAndSettle(view, pending, releaseUpload), 'settled', 'no prompt over session two about session one');
  assert.equal(sends().length, 0);
  assert.equal(appendQueuedMessage.mock.calls.length, 0);
  assert.equal(view.result.current.input, 'half-written note for two');
  assert.equal(readDraftText('session-1'), 'hello');
});

test('a session with nothing in the background sends without asking', async () => {
  const { view, sends } = render(new Map());
  await act(async () => { view.result.current.setInput('hello'); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });

  assert.equal(view.result.current.backgroundSendPrompt, null);
  assert.equal(sends().length, 1);
});

describe('a provider whose runtime runs the message beside the work', () => {
  const takesInserts: Partial<ComposerArgs> = { supportsMidRunInsert: true, isConnected: true };

  test('sends at once, without asking', async () => {
    const { view, sends } = render(backgroundOnly, takesInserts);
    await act(async () => { view.result.current.setInput('and also this'); });
    await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });

    assert.equal(view.result.current.backgroundSendPrompt, null, 'nothing is stopped, so nothing is asked');
    assert.equal(sends().length, 1);
    assert.equal(appendQueuedMessage.mock.calls.length, 0);
    assert.equal(view.result.current.input, '');
  });

  test('asks the server first with the send\'s own options, and sends with keepBackgroundWork when the turn can go into the process the work runs in', async () => {
    handOverPlan = { heldWork: true, canHandOver: true, changes: [] };
    const { view, sends } = render(backgroundOnly, takesInserts);
    await act(async () => { view.result.current.setInput('and also this'); });
    await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });

    const requests = planRequests();
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, '/api/providers/sessions/session-1/hand-over-plan');
    assert.equal(requests[0]?.body.options.model, 'test-model');
    assert.equal(requests[0]?.body.options.effort, 'medium');
    assert.equal(view.result.current.backgroundSendPrompt, null);
    assert.equal(sends().length, 1);
    assert.equal(sends()[0]?.options?.keepBackgroundWork, true);
    assert.equal(sends()[0]?.options?.model, requests[0]?.body.options.model, 'the send carries the options the plan was asked for');
  });

  test('asks first, naming what only a new process can apply, when the turn cannot go into that process; send anyway sends without keepBackgroundWork', async () => {
    handOverPlan = { heldWork: true, canHandOver: false, changes: ['effort', 'ultracode'] };
    const { view, sends } = render(backgroundOnly, takesInserts);
    await act(async () => { view.result.current.setInput('think harder'); });

    const pending = startSubmit(view);
    await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));
    assert.deepEqual(view.result.current.backgroundSendPrompt, {
      work: ['Workflow frontend-architecture-audit', 'Agent Survey the repo'],
      changes: ['effort', 'ultracode'],
    });
    assert.equal(sends().length, 0, 'nothing is sent while the prompt is open');

    await act(async () => {
      view.result.current.resolveBackgroundSendPrompt('send');
      await pending;
    });
    assert.equal(sends().length, 1);
    assert.equal(sends()[0]?.content, 'think harder');
    assert.equal(sends()[0]?.options?.keepBackgroundWork, undefined, 'the user chose to stop the work');
  });

  test('cancel keeps the draft and queue queues it, when the turn cannot go into that process', async () => {
    handOverPlan = { heldWork: true, canHandOver: false, changes: ['permissionMode'] };
    const { view, sends } = render(backgroundOnly, takesInserts);
    await act(async () => { view.result.current.setInput('in bypass mode'); });

    await submitAndAnswer(view, 'cancel');
    assert.equal(sends().length, 0);
    assert.equal(view.result.current.input, 'in bypass mode');

    await submitAndAnswer(view, 'queue');
    assert.equal(sends().length, 0);
    assert.equal(appendQueuedMessage.mock.calls.length, 1);
    assert.equal(appendQueuedMessage.mock.calls[0]?.[1]?.content, 'in bypass mode');
    assert.equal(view.result.current.input, '');
  });

  test('sends with keepBackgroundWork, without asking, when the server cannot say or holds no work', async () => {
    const { view, sends } = render(backgroundOnly, takesInserts);
    // No plan: the route is missing (an older server).
    await act(async () => { view.result.current.setInput('first'); });
    await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });

    handOverPlan = { heldWork: false, canHandOver: false, changes: [] };
    await act(async () => { view.result.current.setInput('second'); });
    await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });

    assert.equal(planRequests().length, 2);
    assert.equal(view.result.current.backgroundSendPrompt, null);
    assert.deepEqual(sends().map((frame) => [frame.content, frame.options?.keepBackgroundWork]), [
      ['first', true],
      ['second', true],
    ]);
  });

  test('a session with no background work showing sends with keepBackgroundWork without asking the server', async () => {
    const { view, sends } = render(new Map(), takesInserts);
    await act(async () => { view.result.current.setInput('plain send'); });
    await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });

    assert.equal(planRequests().length, 0);
    assert.equal(sends()[0]?.options?.keepBackgroundWork, true, 'the server refuses it should it hold work this page has not heard of');
  });

  test('the send key with Alt queues it until the work finishes, without asking', async () => {
    const { view, sends } = render(backgroundOnly, takesInserts);
    await act(async () => { view.result.current.setInput('after the work'); });
    await act(async () => {
      view.result.current.handleKeyDown({
        key: 'Enter',
        altKey: true,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        nativeEvent: { isComposing: false },
        preventDefault: () => undefined,
      } as never);
    });

    await waitFor(() => assert.equal(appendQueuedMessage.mock.calls.length, 1));
    assert.equal(appendQueuedMessage.mock.calls[0]?.[1]?.content, 'after the work');
    assert.equal(view.result.current.backgroundSendPrompt, null);
    assert.equal(sends().length, 0);
  });

  test('the send button\'s menu sends or queues as picked', async () => {
    const { view, sends } = render(backgroundOnly, takesInserts);
    await act(async () => { view.result.current.setInput('now'); });
    await act(async () => { view.result.current.submitWithBusyMode('insert'); });
    await waitFor(() => assert.equal(sends().length, 1));

    await act(async () => { view.result.current.setInput('later'); });
    await act(async () => { view.result.current.submitWithBusyMode('queue'); });
    await waitFor(() => assert.equal(appendQueuedMessage.mock.calls.length, 1));
    assert.equal(sends().length, 1);
    assert.equal(view.result.current.backgroundSendPrompt, null);
  });

  test('an edit still asks first: it replaces the process the work runs in', async () => {
    const { view, sends } = render(backgroundOnly, takesInserts);
    await act(async () => {
      view.result.current.beginEditMessage({ type: 'user', content: 'old', timestamp: new Date(), transcriptAnchorId: 'anchor-1' });
    });
    await act(async () => { view.result.current.setInput('replacement'); });

    const pending = startSubmit(view);
    await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));
    assert.equal(view.result.current.backgroundSendPrompt?.changes, undefined, 'any edit needs a new process; there is nothing to name');
    assert.equal(sends().length, 0);
    assert.equal(planRequests().length, 0);
    await act(async () => {
      view.result.current.resolveBackgroundSendPrompt('cancel');
      await pending;
    });
  });
});

describe('a send the server refuses to run beside the work', () => {
  const OWN_TASKS = backgroundOnly.get('session-1')?.tasks ?? [];
  const refusal = (changes: string[]) => ({ sessionId: 'session-1', reason: 'BACKGROUND_WORK_WOULD_STOP', changes });

  /** A Claude composer whose echoes and their row ids, removals and background reports are recorded. */
  const renderClaude = (overrides: Partial<ComposerArgs> = {}) => {
    const echoes: Array<{ content?: string; rowId?: string }> = [];
    const removeMessage = vi.fn<(sessionId: string, rowId: string) => void>();
    const onSessionBackground = vi.fn();
    const composer = render(backgroundOnly, {
      supportsMidRunInsert: true,
      isConnected: true,
      addMessage: (message, options) => {
        if (message.type === 'user') {
          echoes.push({ content: message.content, rowId: options?.rowId });
        }
      },
      removeMessage,
      onSessionBackground,
      ...overrides,
    });
    return { ...composer, echoes, removeMessage, onSessionBackground };
  };

  const sendOver = async (view: View, text: string) => {
    await act(async () => { view.result.current.setInput(text); });
    await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });
  };

  test('is undone (its echo goes, the session is back to its background work, the text is back) and asks, naming the changes; cancel leaves the text', async () => {
    handOverPlan = { heldWork: true, canHandOver: true, changes: [] };
    const { view, sends, echoes, removeMessage, onSessionBackground } = renderClaude();
    await sendOver(view, 'check the logs');
    assert.equal(sends()[0]?.options?.keepBackgroundWork, true);
    const echoRowId = echoes[0]?.rowId ?? '';
    assert.match(echoRowId, /^local_/);
    await act(async () => { view.result.current.setInput('typed since'); });

    // The process changed hands between the plan and the send.
    act(() => { view.result.current.handleSendRefused(refusal(['permissionMode'])); });

    assert.deepEqual(removeMessage.mock.calls, [['session-1', echoRowId]]);
    assert.deepEqual(onSessionBackground.mock.calls, [['session-1', OWN_TASKS]]);
    assert.equal(view.result.current.input, 'check the logs\n\ntyped since', 'back ahead of what was typed since, before any answer');
    assert.equal(readDraftText('session-1'), 'check the logs\n\ntyped since');
    await waitFor(() => assert.deepEqual(view.result.current.backgroundSendPrompt, {
      work: ['Workflow frontend-architecture-audit', 'Agent Survey the repo'],
      changes: ['permissionMode'],
    }));
    await act(async () => { view.result.current.resolveBackgroundSendPrompt('cancel'); });

    assert.equal(view.result.current.input, 'check the logs\n\ntyped since');
    assert.equal(sends().length, 1, 'nothing more is sent');
  });

  test('send anyway sends it again without keepBackgroundWork, and queue queues it, each taking the text out again', async () => {
    handOverPlan = { heldWork: true, canHandOver: true, changes: [] };
    const { view, sends } = renderClaude();
    await sendOver(view, 'stop it then');
    await act(async () => { view.result.current.setInput('typed since'); });
    act(() => { view.result.current.handleSendRefused(refusal(['effort'])); });
    await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));
    assert.equal(view.result.current.input, 'stop it then\n\ntyped since');
    await act(async () => { view.result.current.resolveBackgroundSendPrompt('send'); });

    assert.deepEqual(sends().map((frame) => [frame.content, frame.options?.keepBackgroundWork]), [
      ['stop it then', true],
      ['stop it then', undefined],
    ]);
    assert.equal(view.result.current.input, 'typed since');
    await act(async () => { view.result.current.setInput(''); });

    await sendOver(view, 'after the work');
    act(() => { view.result.current.handleSendRefused(refusal(['effort'])); });
    await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));
    await act(async () => { view.result.current.resolveBackgroundSendPrompt('queue'); });

    await waitFor(() => assert.equal(appendQueuedMessage.mock.calls.length, 1));
    assert.equal(appendQueuedMessage.mock.calls[0]?.[1]?.content, 'after the work');
    assert.equal(sends().length, 3, 'queued, not sent again');
    assert.equal(view.result.current.input, '');
  });

  test('is taken only by the composer that sent it: the other pane on the session hears it and does nothing', async () => {
    handOverPlan = { heldWork: true, canHandOver: true, changes: [] };
    const left = renderClaude();
    const right = renderClaude();
    await sendOver(left.view, 'from the left');

    // Both panes hear the frame on the page's one socket.
    act(() => {
      right.view.result.current.handleSendRefused(refusal(['tools']));
      left.view.result.current.handleSendRefused(refusal(['tools']));
    });

    assert.equal(right.removeMessage.mock.calls.length, 0);
    assert.equal(right.onSessionBackground.mock.calls.length, 0);
    assert.equal(right.view.result.current.backgroundSendPrompt, null);
    assert.equal(left.removeMessage.mock.calls.length, 1);
    await waitFor(() => assert.notEqual(left.view.result.current.backgroundSendPrompt, null));
    await act(async () => { left.view.result.current.resolveBackgroundSendPrompt('cancel'); });
  });

  test('is taken once, and never about a send made without keepBackgroundWork', async () => {
    handOverPlan = { heldWork: true, canHandOver: true, changes: [] };
    const { view, removeMessage } = renderClaude();
    await sendOver(view, 'first');
    act(() => { view.result.current.handleSendRefused(refusal([])); });
    await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));
    await act(async () => { view.result.current.resolveBackgroundSendPrompt('cancel'); });
    assert.equal(view.result.current.input, 'first');

    // A second copy of the frame finds nothing left to undo.
    act(() => { view.result.current.handleSendRefused(refusal([])); });
    assert.equal(removeMessage.mock.calls.length, 1);
    assert.equal(view.result.current.backgroundSendPrompt, null);

    // Sent anyway: without keepBackgroundWork, so no refusal can be about it.
    handOverPlan = { heldWork: true, canHandOver: false, changes: ['cwd'] };
    const pending = startSubmit(view);
    await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));
    await act(async () => {
      view.result.current.resolveBackgroundSendPrompt('send');
      await pending;
    });
    act(() => { view.result.current.handleSendRefused(refusal([])); });
    assert.equal(removeMessage.mock.calls.length, 1);
    assert.equal(view.result.current.backgroundSendPrompt, null);
  });

  test('once the composer shows another session, puts the text into its session\'s draft and asks nothing', async () => {
    handOverPlan = { heldWork: true, canHandOver: true, changes: [] };
    let session: ProjectSession = SESSION;
    const removeMessage = vi.fn();
    const sent: SentFrame[] = [];
    const view = renderHook(() => useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: session,
      currentSessionId: session.id,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: false,
      processingSessions: backgroundOnly,
      canAbortSession: false,
      supportsMidRunInsert: true,
      isConnected: true,
      tokenBudget: null,
      sendMessage: (message) => { sent.push(message as SentFrame); },
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      removeMessage,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }));
    await act(async () => { view.result.current.setInput('meant for session one'); });
    await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });
    assert.equal(sent.find((frame) => frame.type === 'chat.send')?.options?.keepBackgroundWork, true);
    session = { id: 'session-2' };
    view.rerender();

    act(() => { view.result.current.handleSendRefused(refusal(['model'])); });

    assert.equal(removeMessage.mock.calls.length, 1);
    assert.equal(view.result.current.backgroundSendPrompt, null);
    assert.equal(readDraftText('session-1'), 'meant for session one');
    assert.equal(view.result.current.input, '');
  });
});

describe('a send waiting for the hand-over plan', () => {
  const takesInserts: Partial<ComposerArgs> = { supportsMidRunInsert: true, isConnected: true };

  /** Holds the plan request open until the returned release is called. */
  const holdPlan = () => {
    let release!: () => void;
    planGate = new Promise<void>((resolve) => { release = resolve; });
    return release;
  };

  // Submits what the composer holds and waits until the plan request is out.
  // The pending submit comes back wrapped: awaiting it here would wait for the plan.
  const submitWhilePlanIsHeld = async (view: View) => {
    const pending = startSubmit(view);
    await waitFor(() => assert.equal(planRequests().length, 1));
    return { pending };
  };

  test('takes only the sent text and files out of the composer, keeping what was typed and attached while it waited', async () => {
    handOverPlan = { heldWork: true, canHandOver: true, changes: [] };
    const releasePlan = holdPlan();
    const sentFile = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    const laterFile = new File(['later'], 'later.txt', { type: 'text/plain' });
    const { view, sends } = render(backgroundOnly, takesInserts);
    await act(async () => {
      view.result.current.setInput('hello');
      view.result.current.setAttachedFiles([sentFile]);
    });

    const { pending } = await submitWhilePlanIsHeld(view);
    assert.equal(view.result.current.input, 'hello', 'the composer is left as it is while the plan is out');
    await act(async () => {
      view.result.current.setInput('hello and more');
      view.result.current.setAttachedFiles((files) => [...files, laterFile]);
    });
    await act(async () => {
      releasePlan();
      await pending;
    });

    assert.deepEqual(sends().map((frame) => frame.content), ['hello']);
    assert.equal(view.result.current.input, 'and more');
    assert.equal(readDraftText('session-1'), 'and more');
    assert.deepEqual(view.result.current.attachedFiles.map((file) => file.name), ['later.txt']);
  });

  test('after a switch to another session, takes the sent text out of the draft it was typed in and leaves the open session\'s draft alone', async () => {
    handOverPlan = { heldWork: true, canHandOver: true, changes: [] };
    const releasePlan = holdPlan();
    writeDraftText('session-2', 'half-written note for two');
    const { view, sends } = render(backgroundOnly, takesInserts);
    await act(async () => { view.result.current.setInput('hello'); });

    const { pending } = await submitWhilePlanIsHeld(view);
    await act(async () => { view.rerender({ session: { id: 'session-2' } }); });
    assert.equal(view.result.current.input, 'half-written note for two');
    await act(async () => {
      releasePlan();
      await pending;
    });

    assert.deepEqual(sends().map((frame) => [frame.sessionId, frame.content]), [['session-1', 'hello']]);
    assert.equal(view.result.current.input, 'half-written note for two');
    assert.equal(readDraftText('session-2'), 'half-written note for two');
    assert.equal(readDraftText('session-1'), '', 'going back does not offer the sent message again');
  });

  test('after a switch to another session, asks nothing and sends nothing when the turn cannot go into the process the work runs in, leaving the message in the draft it was typed in', async () => {
    handOverPlan = { heldWork: true, canHandOver: false, changes: ['effort'] };
    const releasePlan = holdPlan();
    writeDraftText('session-2', 'half-written note for two');
    const { view, sends } = render(backgroundOnly, takesInserts);
    await act(async () => { view.result.current.setInput('hello'); });

    const { pending } = await submitWhilePlanIsHeld(view);
    await act(async () => { view.rerender({ session: { id: 'session-2' } }); });

    assert.equal(await releaseAndSettle(view, pending, releasePlan), 'settled', 'no prompt over session two about session one\'s message');
    assert.equal(sends().length, 0);
    assert.equal(appendQueuedMessage.mock.calls.length, 0);
    assert.equal(view.result.current.input, 'half-written note for two');
    assert.equal(readDraftText('session-2'), 'half-written note for two');
    assert.equal(readDraftText('session-1'), 'hello', 'the message is in its draft once');
    await act(async () => { view.rerender({ session: SESSION }); });
    assert.equal(view.result.current.input, 'hello', 'and back in the composer on going back');
  });

  test('after a switch to another session, puts the message back ahead of what its draft holds when that no longer opens with it', async () => {
    handOverPlan = { heldWork: true, canHandOver: false, changes: ['effort'] };
    const releasePlan = holdPlan();
    const { view, sends } = render(backgroundOnly, takesInserts);
    await act(async () => { view.result.current.setInput('hello'); });

    const { pending } = await submitWhilePlanIsHeld(view);
    await act(async () => { view.result.current.setInput('on second thought'); });
    await act(async () => { view.rerender({ session: { id: 'session-2' } }); });

    assert.equal(await releaseAndSettle(view, pending, releasePlan), 'settled');
    assert.equal(sends().length, 0);
    assert.equal(readDraftText('session-1'), 'hello\n\non second thought');
    assert.equal(view.result.current.input, '');
  });

  test('queued from the prompt, keeps what was typed while the plan was out', async () => {
    handOverPlan = { heldWork: true, canHandOver: false, changes: ['effort'] };
    const releasePlan = holdPlan();
    const { view, sends } = render(backgroundOnly, takesInserts);
    await act(async () => { view.result.current.setInput('hello'); });

    const { pending } = await submitWhilePlanIsHeld(view);
    await act(async () => { view.result.current.setInput('hello\nand more'); });
    await act(async () => { releasePlan(); });
    await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));
    await act(async () => {
      view.result.current.resolveBackgroundSendPrompt('queue');
      await pending;
    });

    assert.equal(sends().length, 0);
    assert.equal(appendQueuedMessage.mock.calls[0]?.[1]?.content, 'hello');
    assert.equal(view.result.current.input, 'and more');
    assert.equal(readDraftText('session-1'), 'and more');
  });

  test('an edit begun while it waited stays in progress', async () => {
    handOverPlan = { heldWork: true, canHandOver: true, changes: [] };
    const releasePlan = holdPlan();
    const { view, sends } = render(backgroundOnly, takesInserts);
    await act(async () => { view.result.current.setInput('hello'); });

    const { pending } = await submitWhilePlanIsHeld(view);
    await act(async () => {
      view.result.current.beginEditMessage({ type: 'user', content: 'old', timestamp: new Date(), transcriptAnchorId: 'anchor-1' });
    });
    await act(async () => {
      releasePlan();
      await pending;
    });

    assert.deepEqual(sends().map((frame) => frame.content), ['hello']);
    assert.equal(view.result.current.editingAnchorId, 'anchor-1');
    assert.equal(view.result.current.input, 'old');
  });
});
