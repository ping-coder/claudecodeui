import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ChevronUp } from 'lucide-react';

import { Shimmer } from '@/shared/ui';
import type { ActivityDetails, ActivityProgress, BackgroundTaskSummary, SessionActivity } from '@/shared/types';
import { cn, describeBackgroundTask, ownBackgroundTasks } from '@/shared/utils';
import {
  computeProgressPercent,
  estimateRemainingMs,
  formatElapsed,
  formatProgressCount,
  formatRemainingEstimate,
} from '@/modules/chat/utils/runProgress';
import { RunProgressBar } from '@/modules/chat/tools/RunProgressBar';
import ActivityDetailsPanel from '@/modules/chat/composer/ActivityDetailsPanel';

type ActivityIndicatorProps = {
  activity: SessionActivity | null;
  /**
   * How far the activity's work has got — a running workflow's agents or the
   * turn's checklist — when the transcript has something to count. Null or
   * absent draws no progress readout.
   */
  progress?: ActivityProgress | null;
  /**
   * Reads what the details panel lists, at the tab's clock (epoch ms). Only
   * given one does the tab open the panel; it is called only while the panel
   * is open.
   */
  readDetails?: (nowMs: number) => ActivityDetails | null;
  /**
   * The transcript pane above the composer, which the details panel opens
   * over. The composer starts where the pane ends, so the pane's height is
   * all the room the panel has, and the panel is capped to fit it. Without
   * one, only the panel's own ceiling applies.
   */
  transcriptRef?: RefObject<HTMLElement>;
  /**
   * Hides the tab, and the panel with it, while something else holds the
   * space above the composer (a pending permission request), without
   * forgetting whether the panel was open.
   */
  isHidden?: boolean;
  onAbort?: () => void;
  isInputFocused?: boolean;
};

const ACTION_KEYS = [
  'claudeStatus.actions.thinking',
  'claudeStatus.actions.processing',
  'claudeStatus.actions.analyzing',
  'claudeStatus.actions.working',
  'claudeStatus.actions.computing',
  'claudeStatus.actions.reasoning',
];
const DEFAULT_ACTION_WORDS = ['Thinking', 'Processing', 'Analyzing', 'Working', 'Computing', 'Reasoning'];
const EXIT_ANIMATION_MS = 220;

/**
 * What gives way, whole, when the tab runs out of room beside Stop, most
 * worth keeping first; parts go from the end. Stop's esc hint goes first,
 * as it only repeats what Esc does. The progress readout's parts follow —
 * the workflow's phase, the count, the time left, the percent and last the
 * bar — so the activity label keeps its room. In a pane too narrow even for
 * that, the label truncates, and only once it has nothing left to give does
 * the elapsed time go. The details toggle never gives way: down to the
 * narrowest chat column (200px, beside a docked editor) the tab shows it.
 */
const FIT_PARTS = ['elapsed', 'bar', 'percent', 'estimate', 'count', 'phase', 'esc'] as const;

type FitPart = (typeof FIT_PARTS)[number];

/**
 * How far the tab's content runs past the room its row leaves it beside
 * Stop: positive when it overflows, negative when it has room to spare.
 */
type TabOverflow = {
  /** With the label in full: what every part but the elapsed time gives way by, so they all go before the label truncates. */
  full: number;
  /** With the label (and the background work's name) truncated to nothing: what the elapsed time gives way by. */
  bare: number;
};

/**
 * Room the tab must have to spare to count as fitting. A tab short of room
 * is squeezed to exactly the room it has, so even a fraction of a pixel
 * squeezed (enough to swap a word's last letter for an ellipsis) reads as
 * overflowing; the pixel also covers the rounding in the clipped widths.
 */
const FIT_SLACK_PX = 1;

/**
 * Room a hidden part needs to spare beyond its own width before it is shown
 * again. It is more than the elapsed time grows by a digit, so that does not
 * make a part come and go. The rotating action words need no margin: the
 * label counts at the widest of them (see `measureTabOverflow`), as in some
 * languages they differ by more than any margin would cover.
 */
const SHOW_MARGIN_PX = 24;

/** How narrow the background work's name may be squeezed (it truncates) before the readout's parts give way instead. */
const DETAIL_RESERVE_PX = 96;

/**
 * What the details panel leaves free above the composer besides the tab's
 * row: its gap above the tab (the panel's `mb-1.5`) and a margin below the
 * top of the transcript, so its top edge never meets the header.
 */
const DETAILS_CLEARANCE_PX = 14;

/** What the background work is: the one task by kind and name, or how many when there are several. */
function describeBackgroundTasks(allTasks: BackgroundTaskSummary[], t: TFunction): string {
  const tasks = ownBackgroundTasks(allTasks);
  return tasks.length === 1
    ? describeBackgroundTask(tasks[0], t)
    : t('claudeStatus.backgroundTask.count', { count: tasks.length, defaultValue: '{{count}} tasks' });
}

/**
 * The width `element` takes with nothing in it truncated or clipped: its
 * width plus what it and its descendants marked `data-fit-clip` (the ones
 * that truncate or clip) hide. Widths are border boxes to the fraction of a
 * pixel; the tab's entry and exit animations scale it only vertically.
 */
function readUnclippedWidth(element: HTMLElement): number {
  let width = element.getBoundingClientRect().width;
  for (const clip of [element, ...element.querySelectorAll<HTMLElement>('[data-fit-clip]')]) {
    width += Math.max(0, clip.scrollWidth - clip.clientWidth);
  }
  return width;
}

/**
 * The room a part takes in its row when laid out: its unclipped width plus
 * the gap that sets it off from the part before it. Nothing for a part that
 * is laid out at no width at all (Stop's esc hint on a phone, where it never
 * shows), which no gap sets off either.
 */
function readPartWidth(part: HTMLElement): number {
  const width = readUnclippedWidth(part);
  if (width <= 0) {
    return 0;
  }
  const gap = part.parentElement ? parseFloat(getComputedStyle(part.parentElement).columnGap) || 0 : 0;
  return width + gap;
}

/**
 * The width of the widest action word the label rotates through, from the
 * hidden copies of them the tab carries while the label is one; 0 when it is
 * not (a status the provider names, background work).
 */
function readWidestRotatingLabel(tab: HTMLElement): number {
  const words = tab.querySelectorAll<HTMLElement>('[data-fit-label-words] > *');
  let widest = 0;
  for (const word of words) {
    widest = Math.max(widest, word.getBoundingClientRect().width);
  }
  return widest;
}

/**
 * How far the tab's content runs past the room its row leaves it beside
 * Stop, with the label in full and with nothing left of it (see
 * TabOverflow). Null while the row is not laid out (a chat in a hidden tab),
 * which decides nothing.
 *
 * A label rotating through the action words counts at the widest of them:
 * judged by the word on show, a part beside it came and went as the words
 * changed every few seconds.
 */
function measureTabOverflow(tab: HTMLElement): TabOverflow | null {
  const row = tab.parentElement;
  const rowWidth = row?.getBoundingClientRect().width ?? 0;
  if (!row || rowWidth <= 0) {
    return null;
  }
  const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
  let room = rowWidth;
  for (const sibling of row.children) {
    if (sibling !== tab) {
      room -= sibling.getBoundingClientRect().width + gap;
    }
  }
  let needed = readUnclippedWidth(tab);
  // The background work's name truncates before any part gives way, so only
  // up to DETAIL_RESERVE_PX of it counts as needed.
  const detail = tab.querySelector<HTMLElement>('[data-fit-detail]');
  const detailWidth = detail ? readUnclippedWidth(detail) : 0;
  const detailReserve = Math.min(detailWidth, DETAIL_RESERVE_PX);
  needed -= detailWidth - detailReserve;
  const label = tab.querySelector<HTMLElement>('[data-fit-label]');
  const labelWidth = label ? readUnclippedWidth(label) : 0;
  const labelFullWidth = Math.max(labelWidth, readWidestRotatingLabel(tab));
  needed += labelFullWidth - labelWidth;
  // What the tab needs once the label and the name have truncated to
  // nothing; the gaps around them stay.
  const bareNeeded = needed - detailReserve - labelFullWidth;
  return { full: needed - room, bare: bareNeeded - room };
}

/**
 * The parts to hide after one measurement of the tab, each judged by its own
 * overflow (the elapsed time by the bare one, the rest by the full one).
 * Short of FIT_SLACK_PX to spare, it hides the shown part least worth
 * keeping; with room to spare, it shows the hidden part most worth keeping
 * once that part's last laid-out width fits with SHOW_MARGIN_PX to spare (a
 * part never laid out is shown so it can be measured). One part per pass,
 * each pass measured again; returns `hidden` itself when nothing changes.
 */
function nextHiddenParts(
  hidden: ReadonlySet<FitPart>,
  present: readonly FitPart[],
  overflow: TabOverflow,
  lastWidths: ReadonlyMap<FitPart, number>,
): ReadonlySet<FitPart> {
  const overflowOf = (part: FitPart) => (part === 'elapsed' ? overflow.bare : overflow.full);
  const shown = present.filter((part) => !hidden.has(part));
  const leastKept = shown[shown.length - 1];
  if (leastKept && overflowOf(leastKept) > -FIT_SLACK_PX) {
    return new Set([...hidden, leastKept]);
  }
  const mostKept = present.find((part) => hidden.has(part));
  if (!mostKept) {
    return hidden;
  }
  const spare = -overflowOf(mostKept);
  const lastWidth = lastWidths.get(mostKept);
  if (spare < FIT_SLACK_PX || (lastWidth !== undefined && lastWidth + SHOW_MARGIN_PX > spare)) {
    return hidden;
  }
  const next = new Set(hidden);
  next.delete(mostKept);
  return next;
}

/**
 * The tallest the details panel may be, in px, to open inside the transcript
 * rather than past its top, where the chat column clips it and no scrolling
 * of its own brings its first rows back: the transcript's height (the room
 * above the composer) less the tab's row and DETAILS_CLEARANCE_PX. The row is
 * taken at its layout height, which the tab's entry animation does not
 * scale. Null while the transcript is not laid out (a chat in a hidden tab),
 * which caps nothing.
 */
function measureDetailsRoom(transcript: HTMLElement, tabRow: HTMLElement): number | null {
  const room = transcript.getBoundingClientRect().height;
  if (room <= 0) {
    return null;
  }
  return Math.max(0, Math.floor(room - tabRow.offsetHeight - DETAILS_CLEARANCE_PX));
}

/**
 * Minimal response-in-progress indicator, in the spirit of the inline status
 * lines in Claude Code / Codex / OpenCode: a shimmering activity label, the
 * elapsed time, and an interrupt affordance. Rendered only while the viewed
 * session has an entry in the processing map; it disappears the instant that
 * entry is removed.
 *
 * A session whose turn has ended while the tasks it launched still run is
 * drawn in the workflow and agent cards' purple, naming the work, and with no
 * Stop: nothing is responding, and the composer can send.
 *
 * When the work has something to count, a progress readout follows, like the
 * CLI's workflow row: a segmented bar, the workflow's phase, `3/7 agents`,
 * the percent done and an estimate of the time left. What it shows follows
 * the room the tab has beside Stop, not the viewport — a code editor docked
 * beside the chat leaves a laptop's composer as narrow as a phone's — and
 * what gives way goes whole, least useful first: Stop's esc hint, then the
 * readout's parts, so the label, the elapsed time and Stop keep theirs.
 * Narrower still, the label truncates, and only once it is gone does the
 * elapsed time give way. The details toggle never does (see FIT_PARTS).
 *
 * Given a details reader, the tab is also the toggle of a panel above it
 * that lists the work in full: each workflow with its agents, the turn's
 * checklist, the background tasks. A click anywhere on the tab opens or
 * closes it; Esc keeps its meaning of stopping the turn. The panel fits the
 * room above the composer, which an on-screen keyboard or a long draft can
 * leave short, and scrolls within.
 *
 * Rendered by chat's ChatComposer above the input so the user can see and
 * interrupt the in-flight turn without leaving the composer.
 */
export default function ActivityIndicator({
  activity,
  progress = null,
  readDetails,
  transcriptRef,
  isHidden = false,
  onAbort,
  isInputFocused = false,
}: ActivityIndicatorProps) {
  const { t } = useTranslation('chat');
  const [renderedActivity, setRenderedActivity] = useState<SessionActivity | null>(activity);
  const [isExiting, setIsExiting] = useState(false);
  const startedAt = renderedActivity?.startedAt ?? null;
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // Whether the user opened the details panel. It starts collapsed in every
  // session (ChatComposer keys the tab by the viewed session, as switching
  // between two busy sessions passes no idle moment) and for every activity
  // that begins from idle. It then stays as the user left it for as long as
  // the session stays busy: through a turn ending into background work, a
  // permission request hiding the tab, and background work giving way to a
  // new turn, since the tasks it lists run on under that turn.
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  if (!activity && isDetailsOpen) {
    // Reset while rendering, so the panel never paints once the activity is over.
    setIsDetailsOpen(false);
  }
  // The tallest the open panel may be to stay inside the transcript (see
  // measureDetailsRoom). Only a laid-out DOM can say, so it is measured
  // whenever the panel opens and whenever that room changes; null caps
  // nothing beyond the panel's own ceiling.
  const [detailsRoomPx, setDetailsRoomPx] = useState<number | null>(null);
  const detailsPanelId = useId();
  // The parts the fit check took out because the tab had no room for them.
  // Only a laid-out DOM can say what fits, so every part starts shown and
  // the layout pass hides what does not fit before the browser paints.
  const [hiddenParts, setHiddenParts] = useState<ReadonlySet<FitPart>>(() => new Set());
  // Each part's width when it was last laid out (gap included). A hidden part
  // is not in the DOM to measure, so this is what says it fits again.
  const partWidthsRef = useRef(new Map<FitPart, number>());
  const tabRef = useRef<HTMLDivElement>(null);
  // The latest render's fit check, for the resize observer to run.
  const fitTabRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (activity) {
      setRenderedActivity(activity);
      setIsExiting(false);
      return;
    }

    if (!renderedActivity) return;

    setIsExiting(true);
    const timer = setTimeout(() => {
      setRenderedActivity(null);
      setIsExiting(false);
    }, EXIT_ANIMATION_MS);

    return () => clearTimeout(timer);
  }, [activity, renderedActivity]);

  useEffect(() => {
    if (startedAt === null) return;
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  // A count of nothing draws no bar, and a hidden tab draws none.
  const shownProgress = renderedActivity && !isHidden && progress && progress.total > 0 ? progress : null;
  // The tab's own clock — the activity's start plus the elapsed time it shows
  // — so the time left, the details and the elapsed time all tick together.
  const tabNowMs = startedAt === null ? null : startedAt + elapsedSeconds * 1000;
  const remainingMs = shownProgress && tabNowMs !== null ? estimateRemainingMs(shownProgress, tabNowMs) : null;
  // Read only while the panel is open and shown; null keeps it closed.
  const details = useMemo(
    () => (isDetailsOpen && activity && !isHidden && readDetails && tabNowMs !== null ? readDetails(tabNowMs) : null),
    [isDetailsOpen, activity, isHidden, readDetails, tabNowMs],
  );
  // Whether the tab is drawn, and so has a row for the resize observer to
  // watch; it lets go while the tab is hidden and comes back with it.
  const isTabShown = Boolean(renderedActivity) && !isHidden;
  // Stop, and with it its esc hint, is drawn only for a turn that can be stopped.
  const canStop = Boolean(renderedActivity?.canInterrupt && onAbort);
  const presentParts = FIT_PARTS.filter((part) => {
    switch (part) {
      case 'elapsed':
        return true;
      case 'esc':
        return canStop;
      case 'estimate':
        return shownProgress !== null && remainingMs !== null;
      case 'phase':
        return Boolean(shownProgress?.phase);
      default:
        return shownProgress !== null;
    }
  });

  // After every render: the label, the elapsed time and the readout itself
  // all change the room the tab needs.
  useLayoutEffect(() => {
    fitTabRef.current = () => {
      const tab = tabRef.current;
      const overflow = tab ? measureTabOverflow(tab) : null;
      if (!tab || overflow === null) {
        return;
      }
      // The row's, not the tab's: Stop's esc hint sits beside the tab.
      for (const element of tab.parentElement?.querySelectorAll<HTMLElement>('[data-fit-part]') ?? []) {
        partWidthsRef.current.set(element.dataset.fitPart as FitPart, readPartWidth(element));
      }
      setHiddenParts((hidden) => nextHiddenParts(hidden, presentParts, overflow, partWidthsRef.current));
    };
    fitTabRef.current();
  });

  useLayoutEffect(() => {
    const row = tabRef.current?.parentElement;
    if (!isTabShown || !row || typeof ResizeObserver === 'undefined') {
      return;
    }
    // The row changes width with the window, the sidebar and a docked
    // editor, none of which re-renders the tab.
    const observer = new ResizeObserver(() => fitTabRef.current());
    observer.observe(row);
    return () => observer.disconnect();
  }, [isTabShown]);

  const isDetailsShown = details !== null;
  useLayoutEffect(() => {
    const transcript = transcriptRef?.current;
    const tabRow = tabRef.current?.parentElement;
    if (!isDetailsShown || !transcript || !tabRow) {
      return;
    }
    // Before the open panel paints, and again whenever the room changes:
    // the window or the visual viewport resizing (an on-screen keyboard
    // coming up) and the composer growing with a long draft all resize the
    // transcript, and none of them re-renders the tab.
    const fitDetails = () => setDetailsRoomPx(measureDetailsRoom(transcript, tabRow));
    fitDetails();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitDetails);
    observer?.observe(transcript);
    const { visualViewport } = window;
    window.addEventListener('resize', fitDetails);
    visualViewport?.addEventListener('resize', fitDetails);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', fitDetails);
      visualViewport?.removeEventListener('resize', fitDetails);
    };
  }, [isDetailsShown, transcriptRef]);

  if (!renderedActivity || isHidden) return null;

  const isBackground = Boolean(renderedActivity.background);
  const actionWords = ACTION_KEYS.map((key, i) => t(key, { defaultValue: DEFAULT_ACTION_WORDS[i] }));
  // The action words take turns as the label while nothing names the status.
  // A language may use one word twice (Italian does), and each copy is keyed
  // by its word, so each word is kept once.
  const rotatingWords = isBackground || renderedActivity.statusText
    ? null
    : [...new Set(actionWords.map((word) => word.replace(/\.+$/, '')))];
  const label = isBackground
    ? t('claudeStatus.backgroundWork', 'Background work')
    : (renderedActivity.statusText || actionWords[Math.floor(elapsedSeconds / 4) % actionWords.length])
      .replace(/\.+$/, '');
  const detail = isBackground ? describeBackgroundTasks(renderedActivity.tasks ?? [], t) : '';
  const elapsedLabel = formatElapsed(elapsedSeconds * 1000, t);
  const canOpenDetails = Boolean(readDetails);
  const toggleDetails = () => setIsDetailsOpen((isOpen) => !isOpen);
  // The tab clips rather than scrolls. The fit check gives up everything
  // before the toggle so it is never clipped, but only once it has measured;
  // should the toggle be clipped meanwhile, the browser scrolls the tab to
  // bring it into view when focused. Once focus moves on, the tab is
  // scrolled back, so the label is not left cut off.
  const resetTabScroll = () => {
    if (tabRef.current) {
      tabRef.current.scrollLeft = 0;
    }
  };

  const isPartShown = (part: FitPart) => presentParts.includes(part) && !hiddenParts.has(part);
  const progressCountLabel = shownProgress ? formatProgressCount(shownProgress, t) : '';
  // The readout's words in the order the CLI's row reads them; each after the
  // first is set off by a dot.
  const readoutWords = shownProgress
    ? ([
      ['phase', shownProgress.phase ?? ''],
      ['count', progressCountLabel],
      ['percent', t('runProgress.percent', { percent: computeProgressPercent(shownProgress), defaultValue: '{{percent}}%' })],
      ['estimate', remainingMs === null ? '' : formatRemainingEstimate(remainingMs, t)],
    ] as const).filter(([part]) => isPartShown(part))
    : [];
  const tabSurfaceClassName = [
    'chat-activity-tab inline-flex h-8 items-center rounded-b-none rounded-t-lg border border-b-0 bg-card px-3 text-xs transition-all duration-200',
    isInputFocused
      ? 'border-primary/30 shadow-[0_-1px_2px_hsl(var(--foreground)/0.08),1px_0_2px_hsl(var(--foreground)/0.06),-1px_0_2px_hsl(var(--foreground)/0.06)]'
      : 'border-border/50 shadow-[0_-1px_1px_hsl(var(--foreground)/0.04),1px_0_1px_hsl(var(--foreground)/0.03),-1px_0_1px_hsl(var(--foreground)/0.03)]',
  ].join(' ');

  return (
    // Column-reversed so the panel, after the tab in reading and focus order
    // like any disclosure's content, still opens above it.
    <div
      className={`pointer-events-none flex flex-col-reverse bg-transparent ${
        isExiting ? 'chat-activity-exit' : 'chat-activity-enter'
      }`}
    >
      <div className="flex items-end justify-between gap-2">
        {/* Clips rather than running under Stop; the fit check keeps it from having to.
            A click anywhere on it toggles the details panel. */}
        <div
          ref={tabRef}
          onClick={canOpenDetails ? toggleDetails : undefined}
          className={cn(
            tabSurfaceClassName,
            'min-w-0 max-w-full gap-2 overflow-hidden',
            canOpenDetails && 'group pointer-events-auto cursor-pointer',
          )}
        >
          <span
            className={`h-1.5 w-1.5 shrink-0 animate-pulse rounded-full ${
              isBackground ? 'bg-purple-500 dark:bg-purple-400' : 'bg-primary'
            }`}
            aria-hidden
          />
          {/* Truncates once Stop's esc hint and the readout have given way
              and the tab still has no room, before the elapsed time gives
              way; marked so the fit check counts it in full, and can tell
              what the tab needs with nothing left of it. The shimmer is drawn
              inline so the ellipsis can cut into its text. */}
          <span data-fit-clip data-fit-label className="min-w-0 truncate font-medium text-muted-foreground">
            <Shimmer className="inline">{`${label}…`}</Shimmer>
            {rotatingWords && (
              // Every word the label rotates through, laid out in its type
              // but taking no room and never seen, for the fit check to
              // count the label at the widest (see measureTabOverflow).
              <span
                data-fit-label-words
                aria-hidden
                className="pointer-events-none invisible absolute h-0 w-0 overflow-hidden whitespace-nowrap"
              >
                {rotatingWords.map((word) => (
                  <span key={word} className="inline-block">{`${word}…`}</span>
                ))}
              </span>
            )}
          </span>
          {detail && (
            // Only the room the rest leaves it (flex-basis 0), so it is the
            // first to truncate.
            <span data-fit-clip data-fit-detail className="min-w-0 flex-1 truncate text-muted-foreground" title={detail}>
              {detail}
            </span>
          )}
          {shownProgress && (isPartShown('bar') || readoutWords.length > 0) && (
            <span
              data-fit-clip
              className="flex min-w-0 items-center gap-1.5 overflow-hidden tabular-nums text-muted-foreground"
            >
              {isPartShown('bar') && (
                <span data-fit-part="bar" className="flex shrink-0">
                  <RunProgressBar
                    done={shownProgress.done}
                    total={shownProgress.total}
                    running={shownProgress.running}
                    label={progressCountLabel}
                  />
                </span>
              )}
              {readoutWords.map(([part, text], index) => (
                <span
                  key={part}
                  data-fit-part={part}
                  // Truncating is only the fallback until the fit check has
                  // measured; the percent never needs it, as only the bar
                  // outlasts it.
                  data-fit-clip={part === 'percent' ? undefined : ''}
                  className={cn(
                    part === 'percent' ? 'shrink-0' : 'min-w-0 truncate',
                    part === 'estimate' && 'pointer-events-auto cursor-help',
                  )}
                  title={part === 'estimate' ? t('runProgress.eta.hint', { defaultValue: 'Estimated from the pace so far' }) : undefined}
                >
                  {index > 0 && <span aria-hidden>· </span>}
                  {text}
                </span>
              ))}
            </span>
          )}
          {isPartShown('elapsed') && (
            // Gives way whole, and only once the label has nothing left to
            // give, so the toggle after it keeps its room.
            <span data-fit-part="elapsed" className="shrink-0 tabular-nums text-muted-foreground/60">{elapsedLabel}</span>
          )}
          {canOpenDetails && (
            // The tab's toggle for the keyboard and assistive technology, its
            // name steady while the label beside it rotates and ticks. It has
            // no click handler of its own: its click (a tap, Enter or Space)
            // bubbles to the tab's. At rest it is the only sign the tab opens,
            // so it is drawn at full muted contrast, and in the foreground
            // colour while hovered, focused or open. Everything before it
            // gives way first, so the tab never clips it once the fit check
            // has measured; until then the blur reset is the fallback.
            <button
              type="button"
              aria-expanded={isDetailsShown}
              aria-controls={detailsPanelId}
              aria-label={t('activityDetails.title', 'Progress details')}
              onBlur={resetTabScroll}
              className={cn(
                '-mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover:text-foreground',
                isDetailsShown && 'text-foreground',
              )}
            >
              <ChevronUp
                className={cn('h-3.5 w-3.5 transition-transform duration-200', isDetailsShown && 'rotate-180')}
                aria-hidden
              />
            </button>
          )}
        </div>

        {canStop && (
          <button
            type="button"
            onClick={onAbort}
            className={`${tabSurfaceClassName} pointer-events-auto gap-1.5 text-muted-foreground hover:bg-card hover:text-destructive`}
            aria-label={t('claudeStatus.stop', { defaultValue: 'Stop' })}
          >
            <svg className="h-2.5 w-2.5 fill-current" viewBox="0 0 24 24" aria-hidden>
              <rect x="5" y="5" width="14" height="14" rx="2" />
            </svg>
            <span>{t('claudeStatus.stop', { defaultValue: 'Stop' })}</span>
            {isPartShown('esc') && (
              // Never on a phone, which has no Esc key; elsewhere the first
              // thing to give way when the tab beside it runs out of room.
              <kbd data-fit-part="esc" className="hidden rounded border border-border/60 px-1 text-[10px] text-muted-foreground/70 sm:inline-block">
                esc
              </kbd>
            )}
          </button>
        )}
      </div>

      {details && <ActivityDetailsPanel id={detailsPanelId} details={details} maxHeightPx={detailsRoomPx} />}
    </div>
  );
}
