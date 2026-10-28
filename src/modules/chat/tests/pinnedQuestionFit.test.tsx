import assert from 'node:assert/strict';

import { createRef } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import '@/modules/i18n';
import ChatInterface from '@/modules/chat/ChatInterface';
import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import { TURN_OPENER_ROW_CLASS } from '@/shared/constants';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, Project, ProjectSession } from '@/shared/types';

/**
 * When the pinned question shows: the chat column (the bar and the
 * transcript, not the composer) has to be 440 wide and 400 tall for it to
 * appear, and narrower than 420 or shorter than 360 for it to go; in between
 * it stays as it was. While it shows it carries the export menu, and the
 * transcript's header keeps its height without it.
 *
 * ChatInterface is rendered with the real transcript pane and bar; the hooks
 * that own its session, provider, composer and realtime state stand in with
 * what they would hand it, and the composer draws nothing. With a run going,
 * Escape closes the open panel rather than stopping the run, however the
 * press that opened it left focus.
 */

const noop = () => undefined;
const abortSession = vi.fn();

const question: ChatMessage = { type: 'user', content: 'Why does the view jump?', timestamp: '2026-10-28T12:00:00.000Z' };
const reply: ChatMessage = { type: 'assistant', content: 'Because the follow timer fires late.', timestamp: '2026-10-28T12:00:05.000Z' };

const sessionState = {
  chatMessages: [question, reply],
  visibleMessages: [question, reply],
  sessionActivity: null,
  currentSessionId: 'session-1',
  scrollContainerRef: createRef<HTMLDivElement>(),
  addMessage: noop,
  setCurrentSessionId: noop,
  isProcessing: false,
  canAbortSession: false,
  isLoadingSessionMessages: false,
  isLoadingMoreMessages: false,
  hasMoreMessages: false,
  totalMessages: 2,
  isUserScrolledUp: false,
  setIsUserScrolledUp: noop,
  tokenBudget: null,
  setTokenBudget: noop,
  visibleMessageCount: 100,
  loadEarlierMessages: noop,
  revealMessage: noop,
  loadAllMessages: async () => undefined,
  loadFullTranscript: async () => [],
  allMessagesLoaded: true,
  isLoadingAllMessages: false,
  loadAllJustFinished: false,
  showLoadAllOverlay: false,
  createDiff: () => [],
  scrollToBottom: noop,
  scrollToBottomAndReset: noop,
  handleScroll: noop,
  requestLatestMessages: async () => undefined,
};

vi.mock('@/modules/chat/hooks/useChatSessionState', () => ({ useChatSessionState: () => sessionState }));
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
vi.mock('@/modules/chat/hooks/useChatComposerState', () => ({
  useChatComposerState: () => ({
    input: '',
    setInput: noop,
    textareaRef: createRef<HTMLTextAreaElement>(),
    handleAbortSession: abortSession,
  }),
}));
vi.mock('@/modules/chat/hooks/useChatRealtimeHandlers', () => ({ useChatRealtimeHandlers: () => undefined }));
vi.mock('@/modules/chat/hooks/useSessionStore', () => ({ useSessionStore: () => ({}) }));
vi.mock('@/modules/chat/composer/useScheduledMessages', () => ({
  useScheduledMessages: () => ({ scheduledMessages: [], schedule: async () => false, cancel: noop }),
}));
vi.mock('@/modules/chat/composer/ChatComposer', () => ({ default: () => null }));
vi.mock('@/modules/chat/modals/CommandResultModal', () => ({ default: () => null }));
vi.mock('@/modules/task-master', () => ({ useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }) }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOpsRegister: () => undefined }));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: () => noop }) }));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useProcessingSessions: () => new Map(),
  useSessionProtectionActions: () => ({
    markSessionProcessing: noop,
    markSessionIdle: noop,
    markSessionBackground: noop,
    getSessionActivity: noop,
  }),
}));

const project: Project = { projectId: 'project-1', path: '/repo', fullPath: '/repo', displayName: 'Repo', isStarred: false };
const session = { id: 'session-1', summary: 'Scroll', lastActivity: '2026-10-28T12:00:05.000Z', messageCount: 2 } as ProjectSession;

/** A ResizeObserver jsdom lacks, driven by hand: `resize(element)` reports a new size of that element. */
class StubResizeObserver {
  static instances: StubResizeObserver[] = [];

  callback: ResizeObserverCallback;
  observed: Element[] = [];

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    StubResizeObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observed.push(element);
  }

  unobserve(element: Element): void {
    this.observed = this.observed.filter((observed) => observed !== element);
  }

  disconnect(): void {
    this.observed = [];
  }
}

let columnSize = { width: 0, height: 0 };

const renderChat = () => render(
  <UiPreferencesProvider>
    <ChatInterface isActive selectedProject={project} selectedSession={session} ws={null} sendMessage={noop} />
  </UiPreferencesProvider>,
);

const chatColumn = () => document.querySelector('[data-chat-column]') as HTMLElement;
const hasBar = () => document.querySelector('[data-pinned-question]') !== null;

/** The chat column takes a new size, and its observers hear of it. */
const resizeColumn = (width: number, height: number) => {
  columnSize = { width, height };
  act(() => {
    for (const observer of StubResizeObserver.instances) {
      if (observer.observed.includes(chatColumn())) {
        observer.callback([], observer as unknown as ResizeObserver);
      }
    }
  });
};

beforeEach(() => {
  StubResizeObserver.instances = [];
  columnSize = { width: 0, height: 0 };
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  // The chat column reports `columnSize`; everything else measures 0, as jsdom does.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function measure(this: HTMLElement) {
    const { width, height } = this.hasAttribute('data-chat-column') ? columnSize : { width: 0, height: 0 };
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the pinned question in the chat column', () => {
  it('shows from 440x400, stays down to 420x360, and once gone needs 440x400 again', () => {
    columnSize = { width: 440, height: 400 };
    renderChat();
    assert.equal(hasBar(), true, 'shows at 440x400');

    resizeColumn(430, 380);
    assert.equal(hasBar(), true, 'stays at 430x380');

    resizeColumn(419, 380);
    assert.equal(hasBar(), false, 'goes below 420 wide');

    resizeColumn(430, 380);
    assert.equal(hasBar(), false, 'does not come back at 430x380');

    resizeColumn(440, 400);
    assert.equal(hasBar(), true, 'comes back at 440x400');

    resizeColumn(440, 359);
    assert.equal(hasBar(), false, 'goes below 360 tall');
  });

  it('keeps its last answer while the column is hidden, and starts hidden', () => {
    renderChat();
    assert.equal(hasBar(), false, 'nothing measured yet');

    resizeColumn(900, 600);
    assert.equal(hasBar(), true);
    resizeColumn(0, 0);
    assert.equal(hasBar(), true, 'a hidden column changes nothing');
  });

  it('carries the export menu while it shows, which the transcript then leaves out', () => {
    columnSize = { width: 900, height: 600 };
    renderChat();
    const exportButtons = () => [...document.querySelectorAll('button[aria-label="Export conversation"]')];

    assert.equal(exportButtons().length === 1, true);
    assert.equal(exportButtons()[0].closest('[data-pinned-question]') !== null, true);
    assert.equal(exportButtons()[0].closest('.chat-messages-pane') === null, true);

    resizeColumn(400, 600);
    assert.equal(hasBar(), false);
    assert.equal(exportButtons().length === 1, true);
    assert.equal(exportButtons()[0].closest('.chat-messages-pane') !== null, true);
  });
});

describe('Escape with the pinned question open while a run goes', () => {
  const panelOpen = () => document.querySelector('[data-pinned-question] [role="dialog"]') !== null;
  const questionText = () => document.querySelector('[data-pinned-question] button[aria-expanded] span[dir="auto"]') as HTMLElement;
  let composer: HTMLTextAreaElement;

  /**
   * A press as WebKit makes it: focus goes to the nearest element around the
   * target that takes it from a press (a text field, or one with tabindex; a
   * button only with tabindex), else nothing keeps it. Then the click.
   */
  const pressLikeWebKit = (target: HTMLElement) => {
    act(() => {
      fireEvent.pointerDown(target);
      fireEvent.mouseDown(target);
      const focusable = target.closest<HTMLElement>('[tabindex], textarea, input');
      if (focusable) {
        focusable.focus();
      } else {
        (document.activeElement as HTMLElement | null)?.blur();
      }
      fireEvent.pointerUp(target);
      fireEvent.mouseUp(target);
      fireEvent.click(target);
    });
  };

  const pressEscape = () => {
    const target = (document.activeElement as HTMLElement | null) ?? document.body;
    act(() => {
      fireEvent.keyDown(target, { key: 'Escape' });
      fireEvent.keyUp(target, { key: 'Escape' });
    });
  };

  beforeEach(() => {
    sessionState.canAbortSession = true;
    sessionState.isProcessing = true;
    columnSize = { width: 900, height: 600 };
    // Where focus was before the press: the composer stands outside the chat tree here.
    composer = document.createElement('textarea');
    document.body.appendChild(composer);
  });

  afterEach(() => {
    composer.remove();
    sessionState.canAbortSession = false;
    sessionState.isProcessing = false;
  });

  it('closes the panel opened with a press that gives no focus, and leaves the run going', () => {
    renderChat();
    act(() => { composer.focus(); });
    pressLikeWebKit(questionText());
    assert.equal(panelOpen(), true);

    pressEscape();
    assert.equal(abortSession.mock.calls.length === 0, true, 'the run is not stopped');
    assert.equal(panelOpen(), false);
  });

  it('closes the panel after a press on a part of it that takes no focus', () => {
    renderChat();
    act(() => { composer.focus(); });
    pressLikeWebKit(questionText());
    const footerTime = [...document.querySelectorAll('[data-pinned-question] [role="dialog"] span')].pop() as HTMLElement;
    pressLikeWebKit(footerTime);
    assert.equal(panelOpen(), true);

    pressEscape();
    assert.equal(abortSession.mock.calls.length === 0, true, 'the run is not stopped');
    assert.equal(panelOpen(), false);
  });

  it('still stops the run, leaving the panel open, once focus has gone back to the composer', () => {
    renderChat();
    pressLikeWebKit(questionText());
    act(() => { composer.focus(); });

    pressEscape();
    assert.equal(abortSession.mock.calls.length === 1, true, 'the run is stopped');
    assert.equal(panelOpen(), true);
  });
});

describe('the transcript under the pinned question', () => {
  const inserted: ChatMessage = { type: 'user', content: 'and the README', timestamp: '2026-10-28T12:00:03.000Z', inserted: true };
  const messages = [question, inserted, reply];

  const renderPane = (showExportMenu: boolean) => render(
    <UiPreferencesProvider>
      <ChatMessagesPane
        {...({
          scrollContainerRef: createRef<HTMLDivElement>(),
          textareaRef: createRef<HTMLTextAreaElement>(),
          onWheel: noop,
          onTouchMove: noop,
          isLoadingSessionMessages: false,
          chatMessages: messages,
          selectedSession: session,
          currentSessionId: 'session-1',
          provider: 'claude',
          setProvider: noop,
          providerModels: {},
          setProviderModel: noop,
          providerModelCatalog: {},
          providerModelActions: {},
          providerModelsLoading: false,
          tasksEnabled: false,
          isTaskMasterInstalled: false,
          onShowAllTasks: null,
          setInput: noop,
          isLoadingMoreMessages: false,
          hasMoreMessages: false,
          totalMessages: messages.length,
          sessionMessagesCount: messages.length,
          visibleMessageCount: 100,
          visibleMessages: messages,
          loadEarlierMessages: noop,
          revealMessage: noop,
          canStopBackgroundTasks: false,
          sendMessage: noop,
          loadAllMessages: noop,
          allMessagesLoaded: true,
          isLoadingAllMessages: false,
          loadAllJustFinished: false,
          showLoadAllOverlay: false,
          createDiff: () => [],
          onGrantToolPermission: () => ({ success: true }),
          selectedProject: project,
        } as unknown as Parameters<typeof ChatMessagesPane>[0])}
        showExportMenu={showExportMenu}
      />
    </UiPreferencesProvider>,
  );

  it('leaves the export menu out on request, and its header keeps the button\'s height', () => {
    const { container } = renderPane(false);
    assert.equal(container.querySelector('button[aria-label="Export conversation"]') === null, true);
    const header = container.querySelector('.chat-messages-pane > .sticky');
    assert.equal(header?.classList.contains('min-h-8'), true);
  });

  it('marks the wrapper of every row that opens a turn, and of no other row', () => {
    const { container } = renderPane(true);
    assert.equal(container.querySelector('button[aria-label="Export conversation"]') !== null, true);
    const marked = [...container.getElementsByClassName(TURN_OPENER_ROW_CLASS)]
      .map((wrapper) => wrapper.getAttribute('data-message-timestamp'));
    assert.equal(marked.join(','), question.timestamp);
  });
});
