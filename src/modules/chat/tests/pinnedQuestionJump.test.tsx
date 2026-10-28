import assert from 'node:assert/strict';

import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import '@/modules/i18n';
import ChatInterface from '@/modules/chat/ChatInterface';
import type * as Api from '@/shared/api';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { Project, ProjectSession } from '@/shared/types';

/**
 * The pinned question's jump to a question the server named, in the real chat:
 * ChatInterface with its session state, message store, transcript and bar;
 * only the history endpoints are faked. The jump loads every message, then
 * reveals the question's row, and only it: not while the load runs (pressed
 * twice, or while the transcript's own Load all runs), not after a load that
 * failed, and not by a time the rows no longer carry (Cursor stamps its rows
 * anew on every read).
 */

const history = vi.hoisted(() => {
  const BASE_MS = Date.UTC(2026, 9, 28, 12, 0, 0);
  // A short turn, then a long one: its question, then 60 steps; the newest page holds no question.
  const rows = [
    { id: 'q0', role: 'user', content: 'the first question' },
    ...Array.from({ length: 4 }, (_, index) => ({ id: `e${index + 1}`, role: 'assistant', content: `earlier step ${index + 1}` })),
    { id: 'q', role: 'user', content: 'the question on an older page' },
    ...Array.from({ length: 60 }, (_, index) => ({ id: `a${index + 1}`, role: 'assistant', content: `step ${index + 1}` })),
  ];
  const QUESTION_INDEX = 5;
  let release: (() => void) | null = null;
  const state = {
    rows,
    QUESTION_INDEX,
    /** Rows stamped from the time of each read, as Cursor's are, rather than with times of their own. */
    stampsEachRead: false,
    failLoadAll: false,
    reads: 0,
    loadAllCalls: 0,
    gate: null as Promise<void> | null,
    /** The question's time in the newest read of every message. */
    questionStampAfterLoadAll: '',
    stamp(index: number) {
      const base = state.stampsEachRead ? BASE_MS + state.reads * 1500 : BASE_MS;
      return new Date(base + index * (state.stampsEachRead ? 100 : 1000)).toISOString();
    },
    read(from: number, to: number) {
      state.reads += 1;
      return rows.slice(from, to).map((row, offset) => ({
        ...row,
        kind: 'text',
        provider: 'claude',
        sessionId: 's1',
        timestamp: state.stamp(from + offset),
      }));
    },
    holdLoadAll() {
      state.gate = new Promise<void>((resolve) => { release = resolve; });
    },
    releaseLoadAll() {
      release?.();
      release = null;
      state.gate = null;
    },
  };
  return state;
});

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof Api>();
  const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) } as Response);
  const failed = () => ({ ok: false, status: 500, json: async () => ({}) } as Response);
  return {
    ...actual,
    api: {
      ...actual.api,
      providers: {
        ...actual.api.providers,
        sessionMessages: async (_sessionId: string, pagination: { limit?: number | null; offset?: number } = {}) => {
          const total = history.rows.length;
          if (pagination.limit == null) {
            history.loadAllCalls += 1;
            await (history.gate ?? Promise.resolve());
            if (history.failLoadAll) {
              return failed();
            }
            const messages = history.read(0, total);
            history.questionStampAfterLoadAll = messages[history.QUESTION_INDEX].timestamp;
            return ok({ messages, total, hasMore: false });
          }
          const end = total - (pagination.offset ?? 0);
          const start = Math.max(0, end - pagination.limit);
          return ok({ messages: history.read(start, end), total, hasMore: start > 0 });
        },
        sessionTurnQuestion: async () => ok({ question: history.read(history.QUESTION_INDEX, history.QUESTION_INDEX + 1)[0] }),
        sessionTokenUsage: async () => failed(),
      },
    },
  };
});

const noop = () => undefined;

vi.mock('@/modules/chat/hooks/useChatProviderState', () => ({
  useChatProviderState: () => ({
    provider: 'claude',
    setProvider: noop,
    providerModels: {},
    setStoredProviderModel: noop,
    permissionMode: 'default',
    pendingPermissionRequests: [],
    setPendingPermissionRequests: noop,
    availablePermissionModes: [],
    providerModelCatalog: {},
    providerModelsLoading: false,
    providerModelActions: {},
    supportsMessageEditing: false,
    supportsSessionForking: false,
    supportsImageAttachments: false,
    supportsFileAttachments: false,
  }),
}));
vi.mock('@/modules/chat/hooks/useChatComposerState', async () => {
  const { createRef } = await import('react');
  const textareaRef = createRef<HTMLTextAreaElement>();
  return { useChatComposerState: () => ({ input: '', setInput: noop, textareaRef }) };
});
vi.mock('@/modules/chat/hooks/useChatRealtimeHandlers', () => ({ useChatRealtimeHandlers: () => undefined }));
vi.mock('@/modules/chat/composer/useScheduledMessages', () => ({
  useScheduledMessages: () => ({ scheduledMessages: [], schedule: async () => false, cancel: noop }),
}));
vi.mock('@/modules/chat/composer/ChatComposer', () => ({ default: () => null }));
vi.mock('@/modules/chat/modals/CommandResultModal', () => ({ default: () => null }));
vi.mock('@/modules/task-master', () => ({ useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }) }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOpsRegister: () => undefined }));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: () => noop }) }));
vi.mock('@/shared/context/SessionProtectionContext', () => {
  // Built as the module loads, before this file's own constants exist.
  const processing = new Map();
  const actions = {
    markSessionProcessing: () => undefined,
    markSessionIdle: () => undefined,
    markSessionBackground: () => undefined,
    getSessionActivity: () => undefined,
  };
  return { useProcessingSessions: () => processing, useSessionProtectionActions: () => actions };
});

const project: Project = { projectId: 'project-1', path: '/repo', fullPath: '/repo', displayName: 'Repo', isStarred: false };
const session = { id: 's1', summary: 'Long turn', lastActivity: '2026-10-28T12:01:05.000Z', messageCount: 66 } as ProjectSession;

class StubResizeObserver {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

// Frames run by hand, one batch per call.
let frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
const runFrames = async (count: number) => {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      const batch = [...frames.values()];
      frames = new Map();
      batch.forEach((callback) => callback(0));
      await Promise.resolve();
    });
  }
};
const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

// The text of every row that starts flashing, in order.
let flashed: string[] = [];
let flashObserver: MutationObserver | null = null;

beforeEach(() => {
  history.stampsEachRead = false;
  history.failLoadAll = false;
  history.reads = 0;
  history.loadAllCalls = 0;
  history.gate = null;
  history.questionStampAfterLoadAll = '';
  frames = new Map();
  nextFrameId = 1;
  flashed = [];
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrameId;
    nextFrameId += 1;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  // The chat column is 900x600, so the bar shows; everything else measures 0, as jsdom does.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function measure(this: HTMLElement) {
    const { width, height } = this.hasAttribute('data-chat-column') ? { width: 900, height: 600 } : { width: 0, height: 0 };
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
  });
  flashObserver = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target as HTMLElement;
      if (!String(record.oldValue ?? '').includes('search-highlight-flash') && target.classList.contains('search-highlight-flash')) {
        flashed.push(`${target.getAttribute('data-message-timestamp')} ${target.textContent?.includes('the question on an older page') ? 'question' : 'other row'}`);
      }
    }
  });
  flashObserver.observe(document.body, { attributes: true, attributeFilter: ['class'], attributeOldValue: true, subtree: true });
});

afterEach(() => {
  flashObserver?.disconnect();
  history.releaseLoadAll();
  vi.unstubAllGlobals();
});

const jumpButton = () => document.querySelector<HTMLButtonElement>('[data-pinned-question] button[aria-label="Load all messages and jump to this one"]');
const questionShown = () => document.querySelector('.chat-messages-pane')?.textContent?.includes('the question on an older page') === true;
const press = (element: Element | null) => act(async () => {
  fireEvent.click(element as HTMLElement);
  await Promise.resolve();
});

/** Opens the session: its newest page lands, and the bar has the server's question and offers to load and jump. */
async function openOnServerQuestion() {
  render(
    <UiPreferencesProvider>
      <ChatInterface isActive selectedProject={project} selectedSession={session} ws={null} sendMessage={noop} />
    </UiPreferencesProvider>,
  );
  await wait(50);
  await wait(300);
  await runFrames(3);
  assert.equal(jumpButton()?.disabled === false, true, 'the bar offers to load and jump');
  assert.equal(questionShown(), false, 'the question is not loaded');
}

describe('the jump to a question the server named', () => {
  it('reveals the question once its rows are in', async () => {
    await openOnServerQuestion();
    await press(jumpButton());
    await wait(20);
    await runFrames(12);

    assert.equal(history.loadAllCalls === 1, true);
    assert.equal(flashed.join(' | '), `${history.questionStampAfterLoadAll} question`);
  });

  it('pressed twice while its load runs, waits for that load and flashes nothing before it', async () => {
    history.holdLoadAll();
    await openOnServerQuestion();
    await press(jumpButton());
    await press(jumpButton());
    await runFrames(12);
    const flashedWhileLoading = flashed.length;

    history.releaseLoadAll();
    await wait(20);
    await runFrames(12);

    assert.equal(history.loadAllCalls === 1, true, `${history.loadAllCalls} loads`);
    assert.equal(flashedWhileLoading === 0, true, 'nothing flashes before the rows are in');
    assert.equal(flashed.length > 0 && flashed.every((entry) => entry === `${history.questionStampAfterLoadAll} question`), true, flashed.join(' | '));
  });

  it('pressed while the transcript\'s own Load all runs, reveals the question once that load is in', async () => {
    history.holdLoadAll();
    await openOnServerQuestion();
    // At the transcript's top its Load all offers itself.
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
    await act(async () => {
      fireEvent.scroll(pane);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const loadAll = [...pane.querySelectorAll('button')].find((button) => button.textContent?.includes('Load all messages')) ?? null;
    assert.equal(loadAll !== null, true, 'the transcript offers Load all');
    await press(loadAll);
    await press(jumpButton());
    await runFrames(12);
    const flashedWhileLoading = flashed.length;

    history.releaseLoadAll();
    await wait(20);
    await runFrames(12);

    assert.equal(history.loadAllCalls === 1, true, `${history.loadAllCalls} loads`);
    assert.equal(flashedWhileLoading === 0, true, 'nothing flashes before the rows are in');
    assert.equal(flashed.join(' | '), `${history.questionStampAfterLoadAll} question`);
  });

  it('after a load that failed, flashes nothing and still offers the jump', async () => {
    history.failLoadAll = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await openOnServerQuestion();
    await press(jumpButton());
    await wait(20);
    await runFrames(12);

    assert.equal(history.loadAllCalls === 1, true);
    assert.equal(flashed.length === 0, true, flashed.join(' | '));
    assert.equal(jumpButton()?.disabled === false, true, 'the jump is still offered');
    errors.mockRestore();
  });

  it('finds the question by its row when every read stamps the rows anew, as Cursor\'s do', async () => {
    history.stampsEachRead = true;
    await openOnServerQuestion();
    await press(jumpButton());
    await wait(20);
    await runFrames(12);

    assert.equal(questionShown(), true, 'the rows are in');
    assert.equal(flashed.join(' | '), `${history.questionStampAfterLoadAll} question`);
  });
});
