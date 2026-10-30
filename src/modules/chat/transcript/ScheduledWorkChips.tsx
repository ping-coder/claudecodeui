import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, Loader2, Play, X } from 'lucide-react';

import { useSessionProtectionActions } from '@/shared/context/SessionProtectionContext';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { ChatMessage, ResumeLoopsStatus, ScheduledWorkStopStatus, ScheduledWorkSummary } from '@/shared/types';
import { cn } from '@/shared/utils';
import {
  canStopScheduledWork,
  countSamePromptWork,
  describeScheduledTiming,
  describeScheduledWorkDetails,
  stopReleasesProcess,
} from '@/modules/chat/utils/scheduledWork';

/**
 * How often the chips read the clock again, so a next run whose time has
 * come reads "Due now", and a run tomorrow reads as today once the day turns.
 */
const CLOCK_TICK_MS = 15_000;

type ScheduledWorkChipsProps = {
  /**
   * The session's scheduled work, from the activity map, or its paused loops (`paused`, read while
   * no process holds the session): only the server adds or takes away an item.
   */
  items: ScheduledWorkSummary[];
  /** Whether the session has a background task running, which keeps its process held whatever a stop ends. */
  hasTasks: boolean;
  /** Every loaded row of the session, for the call that made an item. */
  messages: ChatMessage[];
  sessionId: string | null;
  /** Whether CloudCLI's own runtime drives the session, so it can stop the work (see the strip's `canStopTasks`). */
  canStop: boolean;
  /** A turn runs in the session: nothing is stopped until it is over. */
  isTurnRunning: boolean;
  sendMessage: (message: unknown) => void;
  onReveal: (message: ChatMessage) => void;
  onLoadAll: () => void;
  /** Reads the paused loops again, once a stop or a resume of them has its answer. */
  onPausedChange?: () => Promise<void> | void;
  /** The composer's settings, which a resume runs with when the server has none of the loops' own. */
  buildResumeOptions?: () => Record<string, unknown>;
};

/**
 * What a stop or a resume came to, said under the chips: it was not cancelled, or it has to wait
 * for the turn; the loops were not resumed, a Claude CLI elsewhere runs them, or the resume has to
 * wait for the turn. A resume's notice names no item (`id` null): it stands for every paused one.
 */
type StopNotice = {
  id: string | null;
  kind: 'failed' | 'afterTurn' | 'resumeFailed' | 'resumeHeldElsewhere' | 'resumeAfterTurn';
};

/** A stop this strip sent and has no final answer to: the item it named, and the items it stops. */
type StopRequest = { taskId: string; itemIds: readonly string[] };

/** A `clientRequestId` for a stop or a resume: unique on the page, which is all the server's answers need to name it. */
const createRequestId = (kind: 'stop' | 'resume'): string => `${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

/**
 * Rendered by chat's BackgroundTasksStrip after the session's tasks, while
 * its held process keeps scheduled work: one chip per loop or reminder, with
 * a clock in blue and no pulse (it waits rather than runs), its prompt, how
 * often and when it runs next, and its details in the tooltip. A click
 * scrolls to the call that made it, or loads the rest of the transcript when
 * that row is not loaded yet.
 *
 * An item CloudCLI can stop has a ✕, greyed out while a turn runs. The ✕
 * asks on the strip itself, in words that follow the server's rule as far as
 * this page can see it: letting go of the process for a self-paced loop
 * alone, else a turn of the current model that has Claude cancel the work.
 * With two or more items to stop it also offers to stop them all; when
 * others of the same kind have the item's prompt (a model that writes /loop
 * into a loop's prompt adds a loop every run), it says how many and puts
 * stopping them all first, as the main action. The stop
 * goes out as `chat.stop-task`; the item then reads "Stopping…" until the
 * server's `stop_task_status` for it says how it ended, the item leaves the
 * activity map, or the socket reconnects. No time limit: a slow cancelling
 * turn is waited for, and shows as the session's turn from its start, which
 * the pane can stop. The answers come on the socket every pane shares: each
 * stop carries an id of its own, which its answers carry back, so only the
 * stops this strip asked for count.
 *
 * A paused item (a restart of the server ended its process) reads so, and
 * its ✕ asks for a turn in a new process, whatever its kind. While any is
 * paused, Resume follows the chips: `chat.resume-loops` has CloudCLI run one
 * turn that brings all of them back, with the settings their process ran
 * with (else the composer's, `buildResumeOptions`). It reads "Resuming…"
 * until the turn starts, which takes the session out of the paused state,
 * or the server's `resume_loops_status` says why it did not.
 */
export function ScheduledWorkChips({
  items,
  hasTasks,
  messages,
  sessionId,
  canStop,
  isTurnRunning,
  sendMessage,
  onReveal,
  onLoadAll,
  onPausedChange,
  buildResumeOptions,
}: ScheduledWorkChipsProps) {
  const { t, i18n } = useTranslation('chat');
  const { subscribe } = useWebSocket();
  const { markSessionProcessing, refreshRunningSessions } = useSessionProtectionActions();
  const [nowMs, setNowMs] = useState(() => Date.now());
  // The item whose ✕ asks for a confirmation on the strip, if any.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // The stops this strip sent and has no final answer to, by the id each
  // carried, which its `stop_task_status` frames carry back.
  const [stopping, setStopping] = useState<ReadonlyMap<string, StopRequest>>(() => new Map());
  const [notice, setNotice] = useState<StopNotice | null>(null);
  // The resume this strip sent and has no answer to, by the id it carried.
  const [resumeRequestId, setResumeRequestId] = useState<string | null>(null);
  const stopButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  // What the socket listener reads when a frame comes, synced after every commit.
  const stoppingRef = useRef(stopping);
  const resumeRequestIdRef = useRef(resumeRequestId);
  const onPausedChangeRef = useRef(onPausedChange);
  useLayoutEffect(() => {
    stoppingRef.current = stopping;
    resumeRequestIdRef.current = resumeRequestId;
    onPausedChangeRef.current = onPausedChange;
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // A stop that has its answer, with what to say about it, if anything.
  const settleStop = useCallback((requestId: string, stopNotice?: StopNotice) => {
    setStopping((current) => {
      if (!current.has(requestId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(requestId);
      return next;
    });
    if (stopNotice) {
      setNotice(stopNotice);
    }
  }, []);

  useEffect(() => {
    if (!sessionId) {
      return undefined;
    }
    // The running sessions read again, and the paused loops with them.
    const readAgain = () => Promise.all([refreshRunningSessions(), onPausedChangeRef.current?.()]);
    return subscribe((event) => {
      // A frame the socket lost is lost for good: the items show what the
      // next poll says.
      if (event.kind === 'websocket_reconnected') {
        setStopping(new Map());
        setResumeRequestId(null);
        return;
      }
      if (
        event.kind === 'resume_loops_status'
        && event.sessionId === sessionId
        && resumeRequestIdRef.current !== null
        && (event.clientRequestId === undefined || event.clientRequestId === resumeRequestIdRef.current)
      ) {
        const status = event.status as ResumeLoopsStatus;
        const settleResume = (resumeNotice?: StopNotice) => {
          setResumeRequestId(null);
          if (resumeNotice) {
            setNotice(resumeNotice);
          }
        };
        switch (status) {
          case 'started':
            // The resuming turn runs, a turn like any other; once it is over
            // the session's process lists the loops it holds.
            markSessionProcessing(sessionId);
            break;
          case 'finished':
          case 'not_found':
            void readAgain().then(() => settleResume());
            break;
          case 'busy':
            settleResume({ id: null, kind: 'resumeAfterTurn' });
            break;
          case 'held_elsewhere':
            // Said rather than read again: a read would list nothing, and the
            // items would go without a word.
            settleResume({ id: null, kind: 'resumeHeldElsewhere' });
            break;
          case 'failed':
            settleResume({ id: null, kind: 'resumeFailed' });
            break;
          default:
            break;
        }
        return;
      }
      if (event.kind !== 'stop_task_status' || event.sessionId !== sessionId || typeof event.taskId !== 'string') {
        return;
      }
      // By the id the stop carried; a server that hands none back names
      // only the item, which then stands for the stop.
      const requestId = typeof event.clientRequestId === 'string'
        ? event.clientRequestId
        : [...stoppingRef.current].find(([, request]) => request.taskId === event.taskId)?.[0];
      const request = requestId === undefined ? undefined : stoppingRef.current.get(requestId);
      // Another pane's stop, or one already answered.
      if (requestId === undefined || !request) {
        return;
      }
      const status = event.status as ScheduledWorkStopStatus;
      // Gone, or never there: the item reads "Stopping…" until the running
      // sessions read again say so, and it is not drawn any more.
      const settleOnceRead = () => {
        void readAgain().then(() => settleStop(requestId));
      };
      switch (status) {
        case 'stopped':
        case 'not_found':
          settleOnceRead();
          break;
        case 'finished':
          if (event.stillHeld === false) {
            settleOnceRead();
          } else {
            settleStop(requestId, { id: request.taskId, kind: 'failed' });
          }
          break;
        case 'failed':
          settleStop(requestId, { id: request.taskId, kind: 'failed' });
          break;
        case 'busy':
          settleStop(requestId, { id: request.taskId, kind: 'afterTurn' });
          break;
        case 'started':
          // The cancelling turn runs, a turn like any other: the pane shows
          // it, and can stop it, without waiting for the next poll. The item
          // stays "Stopping…".
          markSessionProcessing(sessionId);
          break;
        default:
          break;
      }
    });
  }, [markSessionProcessing, refreshRunningSessions, sessionId, settleStop, subscribe]);

  // A turn that starts while the strip asks closes the question: nothing is
  // stopped until the turn is over, and Escape stops the turn again.
  if (isTurnRunning && confirmingId !== null) {
    setConfirmingId(null);
  }

  // A paused item has no process to drive: CloudCLI's runtime starts one to stop it.
  const stoppable = sessionId ? items.filter((item) => (canStop || item.paused) && canStopScheduledWork(item)) : [];
  const stoppingIds = new Set([...stopping.values()].flatMap((request) => request.itemIds));
  const confirming = stoppable.find((item) => item.id === confirmingId);
  const paused = items.filter((item) => item.paused);
  const shownNotice = notice && (notice.id === null ? paused.length > 0 : items.some((item) => item.id === notice.id))
    ? notice
    : null;

  // While it asks, the question owns Escape (it carries data-escape-layer, so
  // nothing underneath takes the key): Escape closes it wherever the focus
  // is, as a press anywhere outside it does. A press, not a blur: Safari and
  // Firefox on macOS do not focus a button on click, so its Stop would blur
  // the question away before the click landed.
  const questionRef = useRef<HTMLDivElement>(null);
  const askingId = confirming?.id ?? null;
  useEffect(() => {
    if (!askingId) {
      return undefined;
    }
    const closeOnPressOutside = (event: PointerEvent) => {
      if (!questionRef.current?.contains(event.target as Node | null)) {
        setConfirmingId(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      if (questionRef.current?.contains(document.activeElement)) {
        stopButtonsRef.current.get(askingId)?.focus();
      }
      setConfirmingId(null);
    };
    document.addEventListener('pointerdown', closeOnPressOutside, true);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPressOutside, true);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [askingId]);

  const cancelConfirmation = () => {
    if (confirmingId) {
      stopButtonsRef.current.get(confirmingId)?.focus();
    }
    setConfirmingId(null);
  };

  const resume = () => {
    if (!sessionId || resumeRequestId !== null) {
      return;
    }
    if (isTurnRunning) {
      setNotice({ id: null, kind: 'resumeAfterTurn' });
      return;
    }
    const requestId = createRequestId('resume');
    sendMessage({ type: 'chat.resume-loops', sessionId, options: buildResumeOptions?.() ?? {}, clientRequestId: requestId });
    setResumeRequestId(requestId);
    setConfirmingId(null);
    setNotice(null);
  };

  const stop = (item: ScheduledWorkSummary, all: boolean) => {
    if (!sessionId) {
      return;
    }
    const requestId = createRequestId('stop');
    sendMessage({ type: 'chat.stop-task', sessionId, taskId: item.id, ...(all ? { allScheduled: true } : {}), clientRequestId: requestId });
    setStopping((current) => new Map(current).set(requestId, {
      taskId: item.id,
      itemIds: all ? stoppable.map((entry) => entry.id) : [item.id],
    }));
    setConfirmingId(null);
    setNotice(null);
  };

  const confirmationText = (item: ScheduledWorkSummary): string => {
    if (stopReleasesProcess([item], items, hasTasks)) {
      return t('scheduledWork.confirm.release', { defaultValue: 'Stop this loop?' });
    }
    return item.recurring
      ? t('scheduledWork.confirm.turnLoop', {
        defaultValue: 'Stop this loop? CloudCLI runs one turn with the current model to have Claude cancel it. Other background tasks are not affected.',
      })
      : t('scheduledWork.confirm.turnReminder', {
        defaultValue: 'Cancel this reminder? CloudCLI runs one turn with the current model to have Claude cancel it. Other background tasks are not affected.',
      });
  };

  const afterTurnLabel = t('scheduledWork.stopAfterTurn', { defaultValue: 'Stop it after this turn ends' });

  const describeNotice = (kind: StopNotice['kind']): string => {
    switch (kind) {
      case 'failed':
        return t('scheduledWork.stopFailed', {
          defaultValue: 'It was not cancelled. Try again, or ask Claude in the message box to cancel it.',
        });
      case 'resumeFailed':
        return t('scheduledWork.resumeFailed', { defaultValue: 'The loops were not resumed. Try again.' });
      case 'resumeHeldElsewhere':
        return t('scheduledWork.resumeHeldElsewhere', {
          defaultValue: 'Another Claude CLI holds this session and runs its loops.',
        });
      case 'resumeAfterTurn':
        return t('scheduledWork.resumeAfterTurn', { defaultValue: 'Resume them after this turn ends' });
      default:
        return afterTurnLabel;
    }
  };

  // The others of its kind that "Stop all" would take too, and have its prompt.
  const samePromptCount = confirming ? countSamePromptWork(confirming, stoppable) : 0;
  const stopAllFirst = samePromptCount > 0;
  const solidButton = 'rounded bg-destructive px-2 py-0.5 font-medium text-destructive-foreground hover:bg-destructive/90';
  const quietButton = 'rounded px-2 py-0.5 font-medium text-destructive hover:bg-destructive/10';
  const stopAllButton = (className: string) => confirming && (
    <button type="button" onClick={() => stop(confirming, true)} className={className}>
      {t('scheduledWork.confirm.stopAll', { n: stoppable.length, defaultValue: 'Stop all ({{n}})' })}
    </button>
  );

  return (
    <>
      {items.map((item) => {
        const kind = item.recurring
          ? t('scheduledWork.kind.loop', { defaultValue: 'Loop' })
          : t('scheduledWork.kind.reminder', { defaultValue: 'Reminder' });
        const timing = describeScheduledTiming(item, nowMs, t, i18n.language);
        const launch = messages.find((message) => message.toolId === item.toolUseId);
        const isStopping = stoppingIds.has(item.id);
        const canStopItem = stoppable.includes(item);
        return (
          <span key={item.id} className="flex min-w-0 max-w-full items-center">
            <button
              type="button"
              onClick={() => (launch ? onReveal(launch) : onLoadAll())}
              title={describeScheduledWorkDetails(item, nowMs, t, i18n.language)}
              className="flex min-w-0 max-w-xs items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
            >
              <Clock className="h-3 w-3 flex-shrink-0 text-blue-500 dark:text-blue-400" aria-hidden />
              <span className="flex-shrink-0 font-medium text-foreground">{kind}</span>
              {(item.prompt || timing.length > 0) && (
                // Short of room, the prompt gives way first, to nothing if it
                // has to, so how often and when the item runs stays in view;
                // that is cut only where it does not fit on its own.
                <span className="flex min-w-0 items-center">
                  {/* bidi-auto: right to left, the prompt keeps its own order ("/loop", not "loop/") and is cut at its end. */}
                  {item.prompt && <span className="bidi-auto min-w-0 truncate">{item.prompt}</span>}
                  {timing.length > 0 && (
                    <span className={cn('max-w-full flex-shrink-0 truncate text-muted-foreground/70', item.prompt && 'ps-1.5')}>
                      · {timing.join(' · ')}
                    </span>
                  )}
                </span>
              )}
            </button>
            {isStopping ? (
              <span className="flex flex-shrink-0 items-center gap-1 px-1 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                {t('scheduledWork.stopping', { defaultValue: 'Stopping…' })}
              </span>
            ) : canStopItem && (
              <button
                type="button"
                ref={(button) => {
                  if (button) {
                    stopButtonsRef.current.set(item.id, button);
                  } else {
                    stopButtonsRef.current.delete(item.id);
                  }
                }}
                // Greyed out rather than disabled, so its tooltip still says
                // when it can stop, and a tap says it where there is none.
                aria-disabled={isTurnRunning || undefined}
                onClick={() => {
                  if (isTurnRunning) {
                    setNotice({ id: item.id, kind: 'afterTurn' });
                    return;
                  }
                  setNotice(null);
                  setConfirmingId(item.id);
                }}
                aria-label={t('scheduledWork.stop', { defaultValue: 'Stop' })}
                title={isTurnRunning ? afterTurnLabel : t('scheduledWork.stop', { defaultValue: 'Stop' })}
                className={cn(
                  'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground/60',
                  isTurnRunning ? 'cursor-not-allowed opacity-40' : 'hover:bg-muted hover:text-destructive',
                )}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        );
      })}
      {confirming && (
        <div
          ref={questionRef}
          role="group"
          aria-label={t('scheduledWork.stop', { defaultValue: 'Stop' })}
          data-escape-layer=""
          className="flex basis-full flex-wrap items-center gap-1.5 px-1.5 py-0.5 text-foreground"
        >
          <span className="min-w-0">{confirmationText(confirming)}</span>
          {stopAllFirst && (
            <span className="min-w-0 font-medium">
              {confirming.recurring
                ? t('scheduledWork.confirm.sameLoops', { count: samePromptCount })
                : t('scheduledWork.confirm.sameReminders', { count: samePromptCount })}
            </span>
          )}
          {stopAllFirst && stopAllButton(solidButton)}
          <button
            type="button"
            onClick={() => stop(confirming, false)}
            className={stopAllFirst ? quietButton : solidButton}
          >
            {t('scheduledWork.confirm.stop', { defaultValue: 'Stop' })}
          </button>
          {/* Focused on open, so an Enter pressed by mistake cancels. */}
          <button
            type="button"
            autoFocus
            onClick={cancelConfirmation}
            className="rounded px-2 py-0.5 font-medium hover:bg-muted"
          >
            {t('scheduledWork.confirm.cancel', { defaultValue: 'Cancel' })}
          </button>
          {!stopAllFirst && stoppable.length >= 2 && stopAllButton(quietButton)}
        </div>
      )}
      {paused.length > 0 && sessionId && (
        resumeRequestId !== null ? (
          <span className="flex flex-shrink-0 items-center gap-1 px-1 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            {t('scheduledWork.resuming', { defaultValue: 'Resuming…' })}
          </span>
        ) : (
          <button
            type="button"
            // Greyed out rather than disabled, as the ✕ is.
            aria-disabled={isTurnRunning || undefined}
            onClick={resume}
            title={isTurnRunning
              ? t('scheduledWork.resumeAfterTurn', { defaultValue: 'Resume them after this turn ends' })
              : t('scheduledWork.resumeTitle', { defaultValue: 'Resume the paused loops: CloudCLI runs one turn to start them again' })}
            className={cn(
              'flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-foreground',
              isTurnRunning ? 'cursor-not-allowed opacity-40' : 'hover:bg-muted',
            )}
          >
            <Play className="h-3 w-3 text-blue-500 dark:text-blue-400" aria-hidden />
            {t('scheduledWork.resume', { defaultValue: 'Resume' })}
          </button>
        )
      )}
      {shownNotice && (
        // Read out by the strip, which is a live region.
        <span className="basis-full px-1.5 text-muted-foreground">
          {describeNotice(shownNotice.kind)}
        </span>
      )}
    </>
  );
}
