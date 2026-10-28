import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import '@/modules/i18n';
import PinnedQuestionBar from '@/modules/chat/transcript/PinnedQuestionBar';
import type { ChatMessage, RevealMessageOptions } from '@/shared/types';

/**
 * The bar above the transcript: the turn's question on one line, a panel with
 * the whole of it and the turn's inserts, the jump back to the message, and
 * the export menu it carries. Escape and presses outside close the panel; the
 * panel only takes Escape while focus is in the bar, which it keeps there
 * after presses that would leave it nowhere.
 */

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 28, 12, 0, seconds)).toISOString();
const user = (seconds: number, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  type: 'user',
  timestamp: at(seconds),
  content,
  ...extra,
});
const assistant = (seconds: number): ChatMessage => ({ type: 'assistant', timestamp: at(seconds), content: 'on it' });

const neverRead = () => new Promise<ChatMessage | null>(() => undefined);
const START: RevealMessageOptions = { block: 'start', highlight: true, exact: true };

type BarOptions = {
  chatMessages: ChatMessage[];
  hasMoreMessages?: boolean;
  readEarlierQuestion?: (signal: AbortSignal) => Promise<ChatMessage | null>;
  revealMessage?: (message: ChatMessage, options?: RevealMessageOptions) => void;
  loadAllMessages?: () => Promise<boolean>;
  findLoadedQuestion?: (question: ChatMessage) => ChatMessage;
};

function renderBar(options: BarOptions) {
  const scrollContainerRef = { current: document.createElement('div') };
  const props = {
    scrollContainerRef,
    renderedCount: options.chatMessages.length,
    isUserScrolledUp: false,
    hasMoreMessages: options.hasMoreMessages ?? false,
    readEarlierQuestion: options.readEarlierQuestion ?? neverRead,
    revealMessage: options.revealMessage ?? vi.fn(),
    loadAllMessages: options.loadAllMessages ?? vi.fn(async () => true),
    findLoadedQuestion: options.findLoadedQuestion ?? ((question: ChatMessage) => question),
    exportMenu: <button type="button" data-testid="export">Export</button>,
  };
  const view = render(
    <div>
      <PinnedQuestionBar {...props} chatMessages={options.chatMessages} />
      <input data-testid="composer" />
    </div>,
  );
  return {
    ...view,
    rerenderMessages: (chatMessages: ChatMessage[]) => view.rerender(
      <div>
        <PinnedQuestionBar {...props} renderedCount={chatMessages.length} chatMessages={chatMessages} />
        <input data-testid="composer" />
      </div>,
    ),
  };
}

/** The bar reports this width; everything else measures 0, as jsdom does. */
const measureBar = (width: number) => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function measure(this: HTMLElement) {
    const measured = this.hasAttribute('data-pinned-question') ? width : 0;
    return { x: 0, y: 0, left: 0, top: 0, right: measured, bottom: 36, width: measured, height: measured ? 36 : 0, toJSON: () => ({}) } as DOMRect;
  });
};

const questionButton = () => document.querySelector<HTMLButtonElement>('[data-pinned-question] button[aria-expanded]') as HTMLButtonElement;
const panel = () => document.querySelector('[data-pinned-question] [role="dialog"]');
const hasEscapeLayer = () => document.querySelector('[data-escape-layer]') !== null;
const isFocusInBar = () => document.querySelector('[data-pinned-question]')?.contains(document.activeElement) === true;

/**
 * What a press does to focus before its click, as browsers do it: the nearest
 * element around the target that a press may focus takes it, else nothing has
 * it. Only explicit tabindex counts here, as in WebKit, where a pressed button
 * takes no focus.
 */
const focusAsPressed = (target: Element) => {
  const focusable = target.closest<HTMLElement>('[tabindex]');
  act(() => {
    if (focusable) {
      focusable.focus();
    } else {
      (document.activeElement as HTMLElement | null)?.blur();
    }
  });
};

afterEach(() => {
  vi.useRealTimers();
});

describe('the pinned question line', () => {
  it('shows the question as plain text, a slash command in a monospace font, and an attachment-only one by its count', () => {
    const { rerenderMessages } = renderBar({
      chatMessages: [user(0, '**Fix** the `scroll` bug\n\nin the [chat](src/chat) pane'), assistant(1)],
    });
    assert.equal(questionButton().textContent?.includes('Fix the scroll bug in the chat pane'), true);
    assert.equal(questionButton().querySelector('.font-serif') !== null, true);

    rerenderMessages([user(0, '/review src/modules/chat', { commandName: '/review', isLocalCommand: true }), assistant(1)]);
    assert.equal(questionButton().querySelector('.font-mono')?.textContent, '/review src/modules/chat');

    rerenderMessages([user(0, '', { images: [{ name: 'shot.png' }], files: [{ name: 'notes.txt' }] }), assistant(1)]);
    assert.equal(questionButton().textContent?.includes('2 attachments'), true);
  });

  it('shows the insert count only from 520px', () => {
    const messages = [user(0, 'the question'), user(5, 'also this', { inserted: true }), assistant(6)];
    measureBar(500);
    const narrow = renderBar({ chatMessages: messages });
    assert.equal(questionButton().textContent?.includes('+1 inserted'), false);
    narrow.unmount();

    measureBar(600);
    renderBar({ chatMessages: messages });
    assert.equal(questionButton().textContent?.includes('+1 inserted'), true);
  });

  it('puts the export menu in the right margin from 980px, after the controls below that', () => {
    measureBar(979);
    const medium = renderBar({ chatMessages: [user(0, 'the question')] });
    assert.equal(screen.getByTestId('export').closest('.max-w-\\[54\\.25rem\\]') !== null, true);
    medium.unmount();

    measureBar(980);
    renderBar({ chatMessages: [user(0, 'the question')] });
    assert.equal(screen.getByTestId('export').closest('.max-w-\\[54\\.25rem\\]') === null, true);
    assert.equal(screen.getByTestId('export').closest('[data-pinned-question]') !== null, true);
  });

  it('says it is reading while the server is asked for a question older than every loaded page', () => {
    renderBar({ chatMessages: [assistant(1), assistant(2)], hasMoreMessages: true });
    assert.equal(questionButton().textContent?.includes('Reading this turn\'s question…'), true);
    assert.equal(questionButton().disabled, true);
  });
});

describe('the pinned question panel', () => {
  const question = user(0, 'Change the scroll code:\n\n1. keep the view\n2. run the tests');
  const insert = user(8, 'and update the README', { inserted: true });
  const messages = [question, assistant(4), insert, assistant(9)];

  it('opens under the line as a dialog, and owns Escape only while focus is in the bar', () => {
    renderBar({ chatMessages: messages });
    fireEvent.click(questionButton());

    assert.equal(questionButton().getAttribute('aria-expanded'), 'true');
    assert.equal(panel() !== null, true);
    assert.equal(questionButton().getAttribute('aria-controls'), panel()?.id);
    assert.equal(panel()?.hasAttribute('aria-modal'), false);
    // The line still shows the question while the panel is open.
    assert.equal(questionButton().textContent?.includes('Change the scroll code: keep the view run the tests'), true);

    act(() => { questionButton().focus(); });
    assert.equal(hasEscapeLayer(), true);
    act(() => { screen.getByTestId('composer').focus(); });
    assert.equal(hasEscapeLayer(), false);
    act(() => { questionButton().focus(); });
    assert.equal(hasEscapeLayer(), true);
  });

  it('closes on Escape from inside the bar and gives focus back to the question, but not on Escape from elsewhere', () => {
    renderBar({ chatMessages: messages });
    fireEvent.click(questionButton());
    act(() => { screen.getByTestId('composer').focus(); });
    fireEvent.keyDown(screen.getByTestId('composer'), { key: 'Escape' });
    assert.equal(panel() !== null, true, 'Escape outside the bar leaves it open');

    const firstInsert = panel()?.querySelector('button') as HTMLButtonElement;
    act(() => { firstInsert.focus(); });
    fireEvent.keyDown(firstInsert, { key: 'Escape' });
    assert.equal(panel() === null, true);
    assert.equal(document.activeElement === questionButton(), true);
  });

  it('takes focus into the bar as it opens, so it owns Escape after a press that gives no focus, as in WebKit', () => {
    renderBar({ chatMessages: messages });
    act(() => { screen.getByTestId('composer').focus(); });
    // jsdom's click focuses nothing, as WebKit's press on a button does not.
    fireEvent.click(questionButton());

    assert.equal(document.activeElement === questionButton(), true);
    assert.equal(hasEscapeLayer(), true);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    assert.equal(panel() === null, true);
    assert.equal(document.activeElement === questionButton(), true);
  });

  it('keeps focus in the bar after a press on its parts that take none: the panel\'s footer, the line\'s padding', () => {
    renderBar({ chatMessages: messages });
    fireEvent.click(questionButton());
    const footerTime = [...(panel()?.querySelectorAll('span') ?? [])].pop() as HTMLElement;
    focusAsPressed(footerTime);
    assert.equal(isFocusInBar(), true, 'a press on the footer\'s time');
    assert.equal(hasEscapeLayer(), true);

    focusAsPressed(questionButton().parentElement as HTMLElement);
    assert.equal(isFocusInBar(), true, 'a press beside the controls');
    assert.equal(hasEscapeLayer(), true);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    assert.equal(panel() === null, true);
  });

  it('keeps focus in the bar when the copy falls back to a hidden text field (no Clipboard API, as over plain http)', async () => {
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
    try {
      renderBar({ chatMessages: messages });
      fireEvent.click(questionButton());
      const copyButton = panel()?.querySelector('button[aria-label="Copy message"]') as HTMLButtonElement;
      focusAsPressed(copyButton);
      await act(async () => { fireEvent.click(copyButton); });

      assert.equal(execCommand.mock.calls.length === 1, true);
      assert.equal(isFocusInBar(), true);
      assert.equal(hasEscapeLayer(), true);
    } finally {
      Reflect.deleteProperty(document, 'execCommand');
    }
  });

  it('closes on a press outside the bar, and when another turn comes under it', () => {
    const { rerenderMessages } = renderBar({ chatMessages: messages });
    fireEvent.click(questionButton());
    fireEvent.pointerDown(questionButton());
    assert.equal(panel() !== null, true, 'a press inside keeps it open');
    fireEvent.pointerDown(screen.getByTestId('composer'));
    assert.equal(panel() === null, true);

    fireEvent.click(questionButton());
    assert.equal(panel() !== null, true);
    const next = user(20, 'the next question');
    rerenderMessages([...messages, next]);
    assert.equal(panel() === null, true);
    // Coming back to the turn does not reopen it.
    rerenderMessages(messages);
    assert.equal(panel() === null, true);
  });

  it('lists the turn\'s inserts, and a click on one jumps there', () => {
    const revealMessage = vi.fn();
    renderBar({ chatMessages: messages, revealMessage });
    fireEvent.click(questionButton());
    const insertButton = panel()?.querySelector('button') as HTMLButtonElement;
    assert.equal(insertButton.textContent?.includes('and update the README'), true);
    fireEvent.click(insertButton);

    assert.equal(revealMessage.mock.calls.length === 1, true);
    assert.equal(revealMessage.mock.calls[0][0] === insert, true);
    assert.equal(JSON.stringify(revealMessage.mock.calls[0][1]), JSON.stringify(START));
  });
});

describe('the jump back to the question', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('reveals a loaded question at the top, flashing', () => {
    const revealMessage = vi.fn();
    const loadAllMessages = vi.fn();
    const question = user(0, 'the question');
    renderBar({ chatMessages: [question, assistant(1)], revealMessage, loadAllMessages });
    fireEvent.click(screen.getByRole('button', { name: 'Jump to this message' }));

    assert.equal(loadAllMessages.mock.calls.length === 0, true);
    assert.equal(revealMessage.mock.calls.length === 1, true);
    assert.equal(revealMessage.mock.calls[0][0] === question, true);
    assert.equal(JSON.stringify(revealMessage.mock.calls[0][1]), JSON.stringify(START));
  });

  it('loads every message before revealing a question the server named', async () => {
    const calls: string[] = [];
    const fromServer = user(-60, 'the question on an older page');
    const revealMessage = vi.fn<(message: ChatMessage, options?: RevealMessageOptions) => void>((message) => {
      calls.push(`reveal:${message.content}`);
    });
    const loadAllMessages = vi.fn(async () => { calls.push('loadAll'); return true; });
    renderBar({
      chatMessages: [assistant(1), assistant(2)],
      hasMoreMessages: true,
      readEarlierQuestion: async () => fromServer,
      revealMessage,
      loadAllMessages,
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    assert.equal(questionButton().textContent?.includes('the question on an older page'), true);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load all messages and jump to this one' }));
    });
    assert.equal(calls.join(' > '), 'loadAll > reveal:the question on an older page');
    assert.equal(JSON.stringify(revealMessage.mock.calls[0][1]), JSON.stringify(START));
  });

  it('reveals the loaded row of a question the server named, found from the row it came from', async () => {
    // A provider that stamps rows anew on every read (Cursor) gives the loaded row another time.
    const fromServer = user(-60, 'the question on an older page', { historyRowId: 'row-q' });
    const loaded = { ...fromServer, timestamp: at(-55) };
    const revealMessage = vi.fn();
    const findLoadedQuestion = vi.fn((question: ChatMessage) => (question.historyRowId === 'row-q' ? loaded : question));
    renderBar({
      chatMessages: [assistant(1), assistant(2)],
      hasMoreMessages: true,
      readEarlierQuestion: async () => fromServer,
      revealMessage,
      findLoadedQuestion,
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load all messages and jump to this one' }));
    });

    assert.equal(findLoadedQuestion.mock.calls.length === 1, true);
    assert.equal(revealMessage.mock.calls.length === 1, true);
    assert.equal(revealMessage.mock.calls[0][0] === loaded, true);
    assert.equal(JSON.stringify(revealMessage.mock.calls[0][1]), JSON.stringify(START));
  });

  it('reveals nothing when the messages could not all be loaded', async () => {
    const revealMessage = vi.fn();
    renderBar({
      chatMessages: [assistant(1), assistant(2)],
      hasMoreMessages: true,
      readEarlierQuestion: async () => user(-60, 'the question on an older page'),
      revealMessage,
      loadAllMessages: vi.fn(async () => false),
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load all messages and jump to this one' }));
    });

    assert.equal(revealMessage.mock.calls.length === 0, true);
    // Still offered, for another try.
    assert.equal(screen.getByRole('button', { name: 'Load all messages and jump to this one' }).hasAttribute('disabled'), false);
  });

  it('turns into a plain Load all messages when the server could not name the question', async () => {
    const revealMessage = vi.fn();
    const loadAllMessages = vi.fn();
    renderBar({
      chatMessages: [assistant(1), assistant(2)],
      hasMoreMessages: true,
      readEarlierQuestion: async () => { throw new Error('HTTP 500'); },
      revealMessage,
      loadAllMessages,
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    assert.equal(questionButton().textContent?.includes('This turn\'s question is in earlier messages'), true);

    fireEvent.click(screen.getByRole('button', { name: 'Load all messages' }));
    assert.equal(loadAllMessages.mock.calls.length === 1, true);
    assert.equal(revealMessage.mock.calls.length === 0, true);
  });
});
