import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { TURN_OPENER_ROW_CLASS } from '@/shared/constants';
import type { ChatMessage } from '@/shared/types';
import { convertMarkdownToPlainText, isTurnOpener } from '@/shared/utils';

/**
 * Where the probe line sits: this share of the transcript's height below its
 * top edge, kept between the two bounds. The turn whose rows cross it is the
 * turn the reader is in.
 */
const PROBE_LINE_SHARE = 0.2;
const PROBE_LINE_MIN_PX = 48;
const PROBE_LINE_MAX_PX = 160;

/**
 * How long a turn whose question is not loaded waits before the server is
 * asked for it: a page just prepended shows the probe its own question a frame
 * later, and asking in that frame would fetch a question already loaded.
 */
const SERVER_READ_DELAY_MS = 200;

/** How much of a question the one-line preview reads: the head of its markdown, then of its plain text. */
const PREVIEW_SOURCE_CHARS = 2000;
const PREVIEW_CHARS = 300;

/** What the probe last read at the line, about the rendered rows that open a turn. */
type ProbeReading = {
  /**
   * The `data-message-timestamp` of the last such row at or above the line,
   * or, when none is, of the first one below it; null when the rendered rows
   * hold none. A timestamp rather than a position, so rows prepended or
   * appended before the next probe still map onto the same message.
   */
  timestamp: string | null;
  /**
   * Whether that row is at or above the line (its turn is the one there) or
   * below it (the turn before it is, unless the row is the first rendered one).
   */
  isAboveLine: boolean;
  /** Its position among the rendered rows that open a turn: what settles two of them sharing a timestamp. */
  position: number;
};

/** The server's word on the question of the turn the first loaded row is in. */
type ServerAnswer = {
  /** When the first loaded row was stamped as the server was asked (epoch ms): what the answer is about. */
  anchorAt: number;
  question: ChatMessage | null;
  failed: boolean;
};

/** The question of the turn the reader is in, as the pinned question bar shows it. */
type PinnedQuestion = {
  /** The message that opened the turn; null while it is being read, after a failed read, or when there is none. */
  question: ChatMessage | null;
  /** Whether `question` is a loaded row; false when the server named it. */
  isLoaded: boolean;
  /** The messages inserted into the turn, oldest first (loaded rows only). */
  inserts: ChatMessage[];
  /** Where finding the question stands: `reading` and `failed` only for one the server is asked for. */
  status: 'ready' | 'reading' | 'failed';
  /** The question's plain text on one line; empty for one with attachments only, or no question. */
  preview: string;
};

type UsePinnedQuestionArgs = {
  scrollContainerRef: RefObject<HTMLDivElement>;
  /** Every loaded row, oldest first. */
  chatMessages: ChatMessage[];
  /** How many of the newest rows the transcript renders (its tail window). */
  renderedCount: number;
  /** False while the transcript follows its newest rows: the newest turn is the one there, and nothing is probed. */
  isUserScrolledUp: boolean;
  /** Whether older pages exist that are not loaded. */
  hasMoreMessages: boolean;
  /** Asks the server for the question of the turn the first loaded row is in. */
  readEarlierQuestion: (signal: AbortSignal) => Promise<ChatMessage | null>;
};

const toEpochMs = (timestamp: ChatMessage['timestamp']): number => new Date(timestamp).getTime();

const sameReading = (a: ProbeReading | null, b: ProbeReading): boolean => (
  a !== null && a.timestamp === b.timestamp && a.isAboveLine === b.isAboveLine && a.position === b.position
);

/**
 * Reads which rendered row that opens a turn sits at the probe line, with a
 * binary search over their wrappers in document order: a few rects however
 * long the transcript is. Undefined while the transcript is not laid out
 * (another view of the pane shows), when the last reading stands.
 */
function readProbe(container: HTMLElement, openerRows: HTMLCollectionOf<Element>): ProbeReading | undefined {
  const bounds = container.getBoundingClientRect();
  if (bounds.width === 0 && bounds.height === 0) {
    return undefined;
  }
  if (openerRows.length === 0) {
    return { timestamp: null, isAboveLine: false, position: -1 };
  }
  const line = bounds.top + Math.min(PROBE_LINE_MAX_PX, Math.max(PROBE_LINE_MIN_PX, bounds.height * PROBE_LINE_SHARE));
  let low = 0;
  let high = openerRows.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (openerRows[middle].getBoundingClientRect().top <= line) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const position = found >= 0 ? found : 0;
  return {
    timestamp: openerRows[position].getAttribute('data-message-timestamp'),
    isAboveLine: found >= 0,
    position,
  };
}

/**
 * Which loaded row opens the turn at the probe line, as an index into
 * `chatMessages`; -1 when that turn's opening row is not loaded.
 */
function resolveProbedOpener(
  reading: ProbeReading,
  chatMessages: ChatMessage[],
  openerIndexes: number[],
  windowStart: number,
): number {
  const newestOpener = openerIndexes.length > 0 ? openerIndexes[openerIndexes.length - 1] : -1;
  if (reading.timestamp === null) {
    // No rendered row opened a turn: the whole window is the newest turn.
    return newestOpener;
  }
  let firstRendered = openerIndexes.findIndex((index) => index >= windowStart);
  if (firstRendered < 0) {
    firstRendered = openerIndexes.length;
  }
  // The probed row by its timestamp, the one nearest its position on a tie;
  // by its position alone if it is gone (an edit cut it away) until the next
  // probe reads the rows again.
  const expected = firstRendered + reading.position;
  let match = -1;
  openerIndexes.forEach((messageIndex, openerPosition) => {
    if (
      String(chatMessages[messageIndex].timestamp) === reading.timestamp
      && (match < 0 || Math.abs(openerPosition - expected) < Math.abs(match - expected))
    ) {
      match = openerPosition;
    }
  });
  if (match < 0) {
    match = Math.min(expected, openerIndexes.length - 1);
    if (match < 0) {
      return -1;
    }
  }
  // Below the line, the turn there is the one before the probed row's, unless
  // that row is the first rendered one: then only the transcript's header is
  // above it, and its own turn is the one the reader is at the top of.
  if (reading.isAboveLine || openerIndexes[match] === windowStart) {
    return openerIndexes[match];
  }
  return match > 0 ? openerIndexes[match - 1] : -1;
}

/** The question on one line: the head of its plain text with the whitespace folded. */
function buildPreview(question: ChatMessage): string {
  const source = String(question.content ?? '').slice(0, PREVIEW_SOURCE_CHARS);
  return convertMarkdownToPlainText(source).replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
}

/**
 * The question of the turn the reader is in, for chat's PinnedQuestionBar:
 * the newest turn while the transcript follows its newest rows, else the turn
 * at a line just below the transcript's top edge. A turn opens with a user
 * message (isTurnOpener) and runs to the next; messages inserted into it are
 * listed with it. When its opening message is older than every loaded page,
 * the server names it, once per first loaded row: a page prepended without a
 * question of its own changes nothing, and one that brings a question either
 * answers it or moves the turn.
 */
export function usePinnedQuestion({
  scrollContainerRef,
  chatMessages,
  renderedCount,
  isUserScrolledUp,
  hasMoreMessages,
  readEarlierQuestion,
}: UsePinnedQuestionArgs): PinnedQuestion {
  // Where the line falls among the rows that open a turn, as the last probe
  // read it while the user reads up the transcript; null while it follows its
  // newest rows, so a reading left from an earlier visit is never shown.
  const [reading, setReading] = useState<ProbeReading | null>(null);
  // What the server said about the question of the turn the first loaded row
  // is in, kept while the loaded rows leave it true.
  const [serverAnswer, setServerAnswer] = useState<ServerAnswer | null>(null);
  const probeFrameRef = useRef(0);
  // The live list of the wrappers of rows that open a turn, taken once per transcript element.
  const openerRowsRef = useRef<{ container: HTMLElement; rows: HTMLCollectionOf<Element> } | null>(null);
  const readEarlierQuestionRef = useRef(readEarlierQuestion);
  useEffect(() => {
    readEarlierQuestionRef.current = readEarlierQuestion;
  });

  // At most one probe a frame, and a re-render only when what it reads changes.
  const scheduleProbe = useCallback(() => {
    if (probeFrameRef.current) {
      return;
    }
    probeFrameRef.current = requestAnimationFrame(() => {
      probeFrameRef.current = 0;
      const container = scrollContainerRef.current;
      if (!container) {
        return;
      }
      if (openerRowsRef.current?.container !== container) {
        openerRowsRef.current = { container, rows: container.getElementsByClassName(TURN_OPENER_ROW_CLASS) };
      }
      const next = readProbe(container, openerRowsRef.current.rows);
      if (next !== undefined) {
        setReading((previous) => (sameReading(previous, next) ? previous : next));
      }
    });
  }, [scrollContainerRef]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!isUserScrolledUp || !container) {
      setReading(null);
      return undefined;
    }
    container.addEventListener('scroll', scheduleProbe, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleProbe);
    observer?.observe(container);
    return () => {
      container.removeEventListener('scroll', scheduleProbe);
      observer?.disconnect();
      cancelAnimationFrame(probeFrameRef.current);
      probeFrameRef.current = 0;
    };
  }, [isUserScrolledUp, scheduleProbe, scrollContainerRef]);

  // Rows added, removed or prepended, and a wider window, move the rows with
  // no scroll event of their own.
  useEffect(() => {
    if (isUserScrolledUp) {
      scheduleProbe();
    }
  }, [chatMessages, renderedCount, isUserScrolledUp, scheduleProbe]);

  const openerIndexes = useMemo(() => {
    const indexes: number[] = [];
    chatMessages.forEach((message, index) => {
      if (isTurnOpener(message)) {
        indexes.push(index);
      }
    });
    return indexes;
  }, [chatMessages]);

  const windowStart = Math.max(0, chatMessages.length - renderedCount);
  const openerIndex = useMemo(() => {
    if (isUserScrolledUp && reading) {
      return resolveProbedOpener(reading, chatMessages, openerIndexes, windowStart);
    }
    return openerIndexes.length > 0 ? openerIndexes[openerIndexes.length - 1] : -1;
  }, [chatMessages, isUserScrolledUp, openerIndexes, reading, windowStart]);

  // The turn's opening message is older than every loaded row: the server is
  // asked, about the first loaded row, unless its last answer still holds —
  // no row has gone from the front since, and no question has come in before
  // the row it was about.
  const firstRowAt = chatMessages.length > 0 ? toEpochMs(chatMessages[0].timestamp) : Number.NaN;
  const firstOpenerAt = openerIndexes.length > 0 ? toEpochMs(chatMessages[openerIndexes[0]].timestamp) : null;
  const needsServerQuestion = openerIndex < 0 && hasMoreMessages && Number.isFinite(firstRowAt);
  const currentAnswer = needsServerQuestion
    && serverAnswer !== null
    && firstRowAt <= serverAnswer.anchorAt
    && (firstOpenerAt === null || firstOpenerAt >= serverAnswer.anchorAt)
    ? serverAnswer
    : null;
  const askAboutRowAt = needsServerQuestion && currentAnswer === null ? firstRowAt : null;

  useEffect(() => {
    if (askAboutRowAt === null) {
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      readEarlierQuestionRef.current(controller.signal).then(
        (question) => {
          if (!controller.signal.aborted) {
            setServerAnswer({ anchorAt: askAboutRowAt, question, failed: false });
          }
        },
        () => {
          if (!controller.signal.aborted) {
            setServerAnswer({ anchorAt: askAboutRowAt, question: null, failed: true });
          }
        },
      );
    }, SERVER_READ_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [askAboutRowAt]);

  const question = openerIndex >= 0 ? chatMessages[openerIndex] : currentAnswer?.question ?? null;

  // The messages inserted into the turn: the loaded rows from its opening
  // message (or the first loaded row) to the next turn's, oldest first.
  const inserts = useMemo(() => {
    const nextOpener = openerIndexes.find((index) => index > openerIndex) ?? chatMessages.length;
    return chatMessages
      .slice(openerIndex + 1, nextOpener)
      .filter((message) => message.type === 'user' && message.inserted)
      .sort((a, b) => (toEpochMs(a.timestamp) - toEpochMs(b.timestamp)) || 0);
  }, [chatMessages, openerIndex, openerIndexes]);

  const preview = useMemo(() => (question ? buildPreview(question) : ''), [question]);

  let status: PinnedQuestion['status'] = 'ready';
  if (needsServerQuestion) {
    status = currentAnswer === null ? 'reading' : currentAnswer.failed ? 'failed' : 'ready';
  }
  return { question, isLoaded: openerIndex >= 0, inserts, status, preview };
}
