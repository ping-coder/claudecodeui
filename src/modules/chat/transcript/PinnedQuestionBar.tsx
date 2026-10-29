import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent, ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpToLine, ChevronDown, Paperclip } from 'lucide-react';

import { useElementWidth } from '@/shared/hooks/useElementWidth';
import type { ChatMessage, RevealMessageOptions } from '@/shared/types';
import { convertMarkdownToPlainText } from '@/shared/utils';
import { usePinnedQuestion } from '@/modules/chat/hooks/usePinnedQuestion';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';
import { Markdown } from '@/modules/chat/transcript/Markdown';
import MessageCopyControl from '@/modules/chat/transcript/MessageCopyControl';

/** The open panel's tallest: this, or this share of the transcript's height where that is less. */
const PANEL_MAX_HEIGHT_PX = 320;
const PANEL_MAX_TRANSCRIPT_SHARE = 0.45;

/**
 * Bar widths at which its parts change: below the first the insert count
 * goes (the panel still lists the inserts); from the second, the 868px
 * message column with 56px either side, the export menu sits in the end
 * margin (the right one, or the left right to left) instead of after the controls.
 */
const SHOWS_INSERT_COUNT_MIN_WIDTH_PX = 520;
const EXPORT_IN_MARGIN_MIN_WIDTH_PX = 980;

/** How far the export menu sits from the end edge in the margin: where the transcript's header had it (end-4). */
const EXPORT_MENU_END_INSET_PX = 16;

/**
 * How the bar's jumps bring a message into view: its top just under the
 * transcript's top edge, flashing. Its own row or none: a user message is
 * never folded into another row, so the nearest one would be another message.
 */
const REVEAL_AT_START: RevealMessageOptions = { block: 'start', highlight: true, exact: true };

/** How much of an inserted message its line in the panel reads. */
const INSERT_PREVIEW_CHARS = 300;

/** A slash command as the user typed it: the command word first, then any arguments. */
const SLASH_COMMAND_PATTERN = /^\/[A-Za-z][\w:.-]*(?:\s|$)/;

type BarWidthTier = 'narrow' | 'medium' | 'wide';

const selectBarWidthTier = (width: number): BarWidthTier => {
  if (width >= EXPORT_IN_MARGIN_MIN_WIDTH_PX) {
    return 'wide';
  }
  return width >= SHOWS_INSERT_COUNT_MIN_WIDTH_PX ? 'medium' : 'narrow';
};

const isSlashCommand = (message: ChatMessage): boolean => (
  Boolean(message.isLocalCommand || message.commandName)
  || SLASH_COMMAND_PATTERN.test(String(message.content ?? '').trimStart())
);

/** The names of a message's attachments, by file name or the last part of their stored path. */
const listAttachmentNames = (message: ChatMessage): string[] => (
  [...(message.images ?? []), ...(message.files ?? [])]
    .map((attachment) => attachment.name || attachment.path?.split('/').pop() || '')
    .filter(Boolean)
);

const formatClock = (timestamp: ChatMessage['timestamp']): string => (
  new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
);

/** The panel open under the bar: for which question (its intrinsic key) and how tall it may get. */
type ExpandedPanel = {
  questionKey: string;
  maxHeight: number;
};

type PinnedQuestionBarProps = {
  scrollContainerRef: RefObject<HTMLDivElement>;
  /** Every loaded row, oldest first. */
  chatMessages: ChatMessage[];
  /** How many of the newest rows the transcript renders. */
  renderedCount: number;
  isUserScrolledUp: boolean;
  hasMoreMessages: boolean;
  /** Asks the server for the question of the turn the first loaded row is in. */
  readEarlierQuestion: (signal: AbortSignal) => Promise<ChatMessage | null>;
  revealMessage: (message: ChatMessage, options?: RevealMessageOptions) => void;
  /** Resolves whether every message came in; a call while a load runs waits for it. */
  loadAllMessages: () => Promise<boolean>;
  /** Once every message is loaded, the loaded row of a question the server named, as the transcript stamps it. */
  findLoadedQuestion: (question: ChatMessage) => ChatMessage;
  /** The conversation's export menu, which the bar carries while it shows. */
  exportMenu: ReactNode;
};

/**
 * Rendered by chat's ChatInterface above the transcript while the chat column
 * has room for it: the question of the turn the reader is in, on one line,
 * opening into a panel with the whole question and the messages inserted into
 * the turn, a jump back to the message, and the conversation's export menu.
 */
function PinnedQuestionBar({
  scrollContainerRef,
  chatMessages,
  renderedCount,
  isUserScrolledUp,
  hasMoreMessages,
  readEarlierQuestion,
  revealMessage,
  loadAllMessages,
  findLoadedQuestion,
  exportMenu,
}: PinnedQuestionBarProps) {
  const { t } = useTranslation('chat');
  const { question, isLoaded, inserts, status, preview } = usePinnedQuestion({
    scrollContainerRef,
    chatMessages,
    renderedCount,
    isUserScrolledUp,
    hasMoreMessages,
    readEarlierQuestion,
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const questionButtonRef = useRef<HTMLButtonElement>(null);
  const isMountedRef = useRef(false);
  const panelId = useId();
  // Which parts fit the bar's width (see SHOWS_INSERT_COUNT_MIN_WIDTH_PX).
  const widthTier = useElementWidth(rootRef, selectBarWidthTier);
  // The open panel, null while closed. Keyed by the question's intrinsic key,
  // so a refresh that hands over an equal message keeps it open and a move to
  // another turn closes it.
  const [expandedPanel, setExpandedPanel] = useState<ExpandedPanel | null>(null);
  // Whether focus is in the bar or its panel: only then does the open panel
  // take Escape from the chat's stop-the-run. Opening the panel puts focus on
  // the question, and a press on a part of the bar that takes no focus leaves
  // it on the bar itself (it has tabIndex -1), so a press never drops focus
  // out of the bar while the panel is open.
  const [hasFocusWithin, setHasFocusWithin] = useState(false);
  // The transcript's scrollbar narrows its message column and not the bar's:
  // the bar leaves the same room at its end, so the question lines up with
  // the messages and the export menu stays where the transcript had it.
  // Browsers put the scrollbar on the end side: the right, or the left right to left.
  const [scrollbarWidth, setScrollbarWidth] = useState(0);

  const questionKey = question ? getIntrinsicMessageKey(question) ?? String(question.timestamp) : null;
  const isExpanded = expandedPanel !== null && expandedPanel.questionKey === questionKey;
  // Another turn under the bar closes the panel for good: coming back to the
  // turn does not reopen it.
  if (expandedPanel !== null && !isExpanded) {
    setExpandedPanel(null);
  }

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return undefined;
    }
    const measure = () => {
      // A hidden transcript has no scrollbar to read; the last width stands.
      if (container.offsetWidth > 0) {
        setScrollbarWidth(container.offsetWidth - container.clientWidth);
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    // The content box narrows when the scrollbar appears, which is what the observer reports.
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [scrollContainerRef]);

  // A press anywhere outside the bar closes the panel.
  useEffect(() => {
    if (!isExpanded) {
      return undefined;
    }
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setExpandedPanel(null);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePress, true);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePress, true);
  }, [isExpanded]);

  // Focus inside a panel that closes goes with it, without a blur event in
  // every browser: read where it is now.
  useEffect(() => {
    if (!isExpanded) {
      setHasFocusWithin(Boolean(rootRef.current?.contains(document.activeElement)));
    }
  }, [isExpanded]);

  const toggleExpanded = () => {
    if (isExpanded) {
      setExpandedPanel(null);
      return;
    }
    if (!questionKey) {
      return;
    }
    // Sized once, as it opens: most of a short transcript stays readable.
    const transcriptHeight = scrollContainerRef.current?.clientHeight ?? 0;
    setExpandedPanel({
      questionKey,
      maxHeight: transcriptHeight > 0
        ? Math.min(PANEL_MAX_HEIGHT_PX, Math.floor(transcriptHeight * PANEL_MAX_TRANSCRIPT_SHARE))
        : PANEL_MAX_HEIGHT_PX,
    });
    // WebKit gives a pressed button no focus, which would leave it outside
    // the bar and Escape with the chat's stop-the-run.
    questionButtonRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // An export menu open in the bar takes its own Escape.
    if (
      event.key !== 'Escape'
      || !isExpanded
      || event.defaultPrevented
      || rootRef.current?.querySelector('[role="menu"]')
    ) {
      return;
    }
    event.preventDefault();
    setExpandedPanel(null);
    questionButtonRef.current?.focus();
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!rootRef.current?.contains(event.relatedTarget as Node | null)) {
      setHasFocusWithin(false);
    }
  };

  const jumpToQuestion = async () => {
    setExpandedPanel(null);
    if (!question) {
      return;
    }
    let target = question;
    if (!isLoaded) {
      // Named by the server, so its row is on a page not loaded: load the
      // rest, as the background-tasks strip does, then find it by time, the
      // time the loaded row carries. Rows that did not come in leave nothing
      // to reveal.
      const isAllLoaded = await loadAllMessages();
      if (!isAllLoaded || !isMountedRef.current) {
        return;
      }
      target = findLoadedQuestion(question);
    }
    revealMessage(target, REVEAL_AT_START);
  };

  const jumpToInsert = (insert: ChatMessage) => {
    // Closed first, or the panel would cover the message it lands under.
    setExpandedPanel(null);
    questionButtonRef.current?.focus();
    revealMessage(insert, REVEAL_AT_START);
  };

  const label = t('pinnedQuestion.label', { defaultValue: 'Question of this turn' });
  const content = String(question?.content ?? '');
  const isCommand = question !== null && isSlashCommand(question);
  const attachmentCount = (question?.images?.length ?? 0) + (question?.files?.length ?? 0);
  const attachmentsLabel = t('pinnedQuestion.attachments', {
    count: attachmentCount,
    defaultValue_one: '{{count}} attachment',
    defaultValue_other: '{{count}} attachments',
  });

  let questionLine: ReactNode = null;
  if (status === 'reading') {
    questionLine = t('pinnedQuestion.reading', { defaultValue: 'Reading this turn\'s question…' });
  } else if (status === 'failed') {
    questionLine = t('pinnedQuestion.notLoaded', { defaultValue: 'This turn\'s question is in earlier messages' });
  } else if (preview) {
    questionLine = preview;
  } else if (attachmentCount > 0) {
    questionLine = (
      <span className="inline-flex items-center gap-1">
        <Paperclip aria-hidden className="h-3.5 w-3.5 flex-shrink-0" />
        {attachmentsLabel}
      </span>
    );
  }
  const jumpLabel = isLoaded
    ? t('pinnedQuestion.jump', { defaultValue: 'Jump to this message' })
    : t('pinnedQuestion.loadAndJump', { defaultValue: 'Load all messages and jump to this one' });
  const attachmentNames = isExpanded && question ? listAttachmentNames(question) : [];
  const exportMenuInMargin = widthTier === 'wide';

  return (
    <div
      ref={rootRef}
      data-pinned-question=""
      // What a press on a part that takes no focus focuses (see hasFocusWithin).
      tabIndex={-1}
      className="relative h-9 flex-shrink-0 border-b border-border bg-background outline-none [@media(pointer:coarse)]:h-11"
      onKeyDown={handleKeyDown}
      onFocus={() => setHasFocusWithin(true)}
      onBlur={handleBlur}
    >
      <div className="h-full" style={{ paddingInlineEnd: scrollbarWidth }}>
        <div className="mx-auto flex h-full w-full max-w-[54.25rem] items-center gap-1 px-4">
          <button
            ref={questionButtonRef}
            type="button"
            onClick={toggleExpanded}
            disabled={!question}
            aria-expanded={isExpanded}
            aria-controls={isExpanded ? panelId : undefined}
            // text-left, not text-start: the dir="auto" line below inherits the keyword, and an inherited
            // start would follow the line's own direction, putting a Hebrew question at the far end left
            // to right. Right to left, the line's bidi-auto aligns it.
            className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-default disabled:hover:bg-transparent [@media(pointer:coarse)]:h-9"
          >
            <span
              aria-hidden
              className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-[10px] font-medium text-white"
            >
              U
            </span>
            <span className="sr-only">{`${label}: `}</span>
            <span
              dir="auto"
              // bidi-auto: right to left, a line that fits starts by the avatar as a title does, whichever way its text runs.
              className={`bidi-auto min-w-0 flex-1 truncate text-sm ${isCommand ? 'font-mono' : 'font-serif'} ${
                status === 'ready' ? 'text-foreground' : 'text-muted-foreground'
              }`}
            >
              {questionLine}
            </span>
            {inserts.length > 0 && widthTier !== 'narrow' && (
              <span className="flex-shrink-0 rounded-full border border-primary/20 bg-primary/5 px-1.5 text-[10px] font-medium leading-4 text-primary/80">
                {t('pinnedQuestion.inserts', {
                  count: inserts.length,
                  defaultValue_one: '+{{count}} inserted',
                  defaultValue_other: '+{{count}} inserted',
                })}
              </span>
            )}
            {question && (
              <ChevronDown
                aria-hidden
                className={`h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform ${isExpanded ? 'rotate-180' : ''}`}
              />
            )}
          </button>
          {status === 'failed' ? (
            // The question could not be read: loading the rest of the
            // conversation is what is left, and it brings the question in.
            <button
              type="button"
              onClick={() => { void loadAllMessages(); }}
              className="h-7 flex-shrink-0 rounded-md px-2 text-xs font-medium text-primary transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 [@media(pointer:coarse)]:h-9"
            >
              {t('session.messages.loadAll', { defaultValue: 'Load all messages' })}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => { void jumpToQuestion(); }}
              disabled={!question}
              aria-label={jumpLabel}
              title={jumpLabel}
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:pointer-events-none disabled:opacity-40 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9"
            >
              <ArrowUpToLine aria-hidden className="h-4 w-4" />
            </button>
          )}
          {!exportMenuInMargin && <div className="flex flex-shrink-0 items-center">{exportMenu}</div>}
        </div>
      </div>
      {exportMenuInMargin && (
        <div
          className="absolute inset-y-0 flex items-center"
          style={{ insetInlineEnd: EXPORT_MENU_END_INSET_PX + scrollbarWidth }}
        >
          {exportMenu}
        </div>
      )}

      {isExpanded && question && (
        // Over the transcript rather than pushing it down, as wide as its
        // message column.
        <div className="pointer-events-none absolute inset-x-0 top-full z-10 pt-1" style={{ paddingInlineEnd: scrollbarWidth }}>
          <div className="mx-auto w-full max-w-[54.25rem] px-4">
            <div
              id={panelId}
              role="dialog"
              aria-label={label}
              data-escape-layer={hasFocusWithin ? '' : undefined}
              style={{ maxHeight: expandedPanel?.maxHeight }}
              className="pointer-events-auto flex flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg"
            >
              <div
                tabIndex={0}
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60"
              >
                {content.trim() && (
                  <div dir="auto" className="break-words font-serif text-sm">
                    <Markdown breaks className="prose prose-sm max-w-none font-serif dark:prose-invert">
                      {content}
                    </Markdown>
                  </div>
                )}
                {attachmentNames.length > 0 ? (
                  <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                    {attachmentNames.map((name, index) => (
                      <li key={`${index}:${name}`} className="flex min-w-0 items-center gap-1">
                        <Paperclip aria-hidden className="h-3 w-3 flex-shrink-0" />
                        <span dir="auto" className="truncate">{name}</span>
                      </li>
                    ))}
                  </ul>
                ) : attachmentCount > 0 && (
                  <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                    <Paperclip aria-hidden className="h-3 w-3 flex-shrink-0" />
                    {attachmentsLabel}
                  </p>
                )}
                {inserts.length > 0 && (
                  <div className="mt-2 space-y-1 border-t border-border/60 pt-2">
                    {inserts.map((insert, index) => (
                      <button
                        key={getIntrinsicMessageKey(insert) ?? index}
                        type="button"
                        onClick={() => jumpToInsert(insert)}
                        // text-left for the dir="auto" preview, as on the question line above.
                        className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                      >
                        <span className="flex flex-shrink-0 items-center gap-1.5 pt-0.5 text-xs text-muted-foreground">
                          <span className="rounded-full border border-primary/20 bg-primary/5 px-1.5 text-[10px] font-medium leading-4 text-primary/80">
                            {t('message.inserted', { defaultValue: 'Inserted' })}
                          </span>
                          {/* In the browser's locale: a <bdi> keeps "5:02 PM" in order in a right-to-left row. */}
                          <bdi>{formatClock(insert.timestamp)}</bdi>
                        </span>
                        <span dir="auto" className="bidi-auto line-clamp-2 min-w-0 flex-1 break-words font-serif text-sm text-foreground">
                          {convertMarkdownToPlainText(String(insert.content ?? '').slice(0, INSERT_PREVIEW_CHARS))}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex flex-shrink-0 items-center justify-end gap-1 border-t border-border/60 px-2 py-1 text-xs text-muted-foreground">
                {content.trim() && <MessageCopyControl content={content} messageType="user" />}
                <bdi>{new Date(question.timestamp).toLocaleTimeString()}</bdi>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(PinnedQuestionBar);
