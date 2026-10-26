import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ChevronUp } from 'lucide-react';

import { Shimmer } from '@/shared/ui';
import type { ActivityDetails, ActivityProgress, BackgroundTaskSummary, SessionActivity } from '@/shared/types';
import { cn } from '@/shared/utils';
import { describeBackgroundTask, ownBackgroundTasks } from '@/modules/chat/utils/backgroundTasks';
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
 * The progress readout's parts, most worth keeping first. When the tab runs
 * out of room they give way whole from the end — the workflow's phase, the
 * count, the time left, the percent and last the bar — so the activity
 * label, the elapsed time and Stop always keep theirs.
 */
const READOUT_PARTS = ['bar', 'percent', 'estimate', 'count', 'phase'] as const;

type ReadoutPart = (typeof READOUT_PARTS)[number];

/**
 * Room the tab must have to spare to count as fitting. A tab short of room
 * is squeezed to exactly the room it has, so even a fraction of a pixel
 * squeezed (enough to swap a word's last letter for an ellipsis) reads as
 * overflowing; the pixel also covers the rounding in the clipped widths.
 */
const FIT_SLACK_PX = 1;

/**
 * Room a hidden part needs to spare beyond its own width before it is shown
 * again. It is more than the rotating action words differ in width
 * (`Working` to `Processing`) and than the elapsed time grows by a digit, so
 * neither makes a part come and go.
 */
const SHOW_MARGIN_PX = 24;

/** How narrow the background work's name may be squeezed (it truncates) before the readout's parts give way instead. */
const DETAIL_RESERVE_PX = 96;

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
 * How far the tab's content runs past the room its row leaves it beside
 * Stop: positive when it overflows, negative when it has room to spare. Null
 * while the row is not laid out (a chat in a hidden tab), which decides
 * nothing.
 */
function measureTabOverflow(tab: HTMLElement): number | null {
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
  if (detail) {
    const detailWidth = readUnclippedWidth(detail);
    needed -= detailWidth - Math.min(detailWidth, DETAIL_RESERVE_PX);
  }
  return needed - room;
}

/**
 * The readout parts to hide after one measurement of the tab. Short of
 * FIT_SLACK_PX to spare, it hides the shown part least worth keeping; with
 * room to spare, it shows the hidden part most worth keeping once that
 * part's last laid-out width fits with SHOW_MARGIN_PX to spare (a part never
 * laid out is shown so it can be measured). One part per pass, each pass
 * measured again; returns `hidden` itself when nothing changes.
 */
function nextHiddenParts(
  hidden: ReadonlySet<ReadoutPart>,
  present: readonly ReadoutPart[],
  overflow: number,
  lastWidths: ReadonlyMap<ReadoutPart, number>,
): ReadonlySet<ReadoutPart> {
  if (overflow > -FIT_SLACK_PX) {
    const shown = present.filter((part) => !hidden.has(part));
    const leastKept = shown[shown.length - 1];
    return leastKept ? new Set([...hidden, leastKept]) : hidden;
  }
  const mostKept = present.find((part) => hidden.has(part));
  if (!mostKept) {
    return hidden;
  }
  const lastWidth = lastWidths.get(mostKept);
  if (lastWidth !== undefined && lastWidth + SHOW_MARGIN_PX > -overflow) {
    return hidden;
  }
  const next = new Set(hidden);
  next.delete(mostKept);
  return next;
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
 * its parts give way whole, least useful first, so the label, the elapsed
 * time and Stop always keep theirs.
 *
 * Given a details reader, the tab is also the toggle of a panel above it
 * that lists the work in full: each workflow with its agents, the turn's
 * checklist, the background tasks. A click anywhere on the tab opens or
 * closes it; Esc keeps its meaning of stopping the turn.
 *
 * Rendered by chat's ChatComposer above the input so the user can see and
 * interrupt the in-flight turn without leaving the composer.
 */
export default function ActivityIndicator({
  activity,
  progress = null,
  readDetails,
  isHidden = false,
  onAbort,
  isInputFocused = false,
}: ActivityIndicatorProps) {
  const { t } = useTranslation('chat');
  const [renderedActivity, setRenderedActivity] = useState<SessionActivity | null>(activity);
  const [isExiting, setIsExiting] = useState(false);
  const startedAt = renderedActivity?.startedAt ?? null;
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // Whether the user opened the details panel. It stays as they left it for
  // as long as the activity lasts — through a turn ending into background
  // work or a permission request hiding the tab — and the next activity
  // starts collapsed.
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  if (!activity && isDetailsOpen) {
    // Reset while rendering, so the panel never paints once the activity is over.
    setIsDetailsOpen(false);
  }
  const detailsPanelId = useId();
  // The readout parts the fit check took out because the tab had no room for
  // them. Only a laid-out DOM can say what fits, so every part starts shown
  // and the layout pass hides what does not fit before the browser paints.
  const [hiddenParts, setHiddenParts] = useState<ReadonlySet<ReadoutPart>>(() => new Set());
  // Each part's width when it was last laid out (gap included). A hidden part
  // is not in the DOM to measure, so this is what says it fits again.
  const partWidthsRef = useRef(new Map<ReadoutPart, number>());
  const tabRef = useRef<HTMLDivElement>(null);
  // The latest render's fit check, for the resize observer to run.
  const fitReadoutRef = useRef<() => void>(() => {});

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

  // A count of nothing draws no bar, and a hidden tab draws none (which also
  // lets the resize observer go, to come back with the tab).
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
  const presentParts = shownProgress
    ? READOUT_PARTS.filter((part) => (
      part === 'estimate' ? remainingMs !== null : part === 'phase' ? Boolean(shownProgress.phase) : true
    ))
    : [];
  const hasReadout = presentParts.length > 0;

  // After every render: the label, the elapsed time and the readout itself
  // all change the room the tab needs.
  useLayoutEffect(() => {
    fitReadoutRef.current = () => {
      const tab = tabRef.current;
      const overflow = tab && hasReadout ? measureTabOverflow(tab) : null;
      if (!tab || overflow === null) {
        return;
      }
      const readout = tab.querySelector<HTMLElement>('[data-readout]');
      const gap = readout ? parseFloat(getComputedStyle(readout).columnGap) || 0 : 0;
      for (const element of tab.querySelectorAll<HTMLElement>('[data-readout-part]')) {
        partWidthsRef.current.set(element.dataset.readoutPart as ReadoutPart, readUnclippedWidth(element) + gap);
      }
      setHiddenParts((hidden) => nextHiddenParts(hidden, presentParts, overflow, partWidthsRef.current));
    };
    fitReadoutRef.current();
  });

  useLayoutEffect(() => {
    const row = tabRef.current?.parentElement;
    if (!hasReadout || !row || typeof ResizeObserver === 'undefined') {
      return;
    }
    // The row changes width with the window, the sidebar and a docked
    // editor, none of which re-renders the tab.
    const observer = new ResizeObserver(() => fitReadoutRef.current());
    observer.observe(row);
    return () => observer.disconnect();
  }, [hasReadout]);

  if (!renderedActivity || isHidden) return null;

  const isBackground = Boolean(renderedActivity.background);
  const actionWords = ACTION_KEYS.map((key, i) => t(key, { defaultValue: DEFAULT_ACTION_WORDS[i] }));
  const label = isBackground
    ? t('claudeStatus.backgroundWork', 'Background work')
    : (renderedActivity.statusText || actionWords[Math.floor(elapsedSeconds / 4) % actionWords.length])
      .replace(/\.+$/, '');
  const detail = isBackground ? describeBackgroundTasks(renderedActivity.tasks ?? [], t) : '';
  const elapsedLabel = formatElapsed(elapsedSeconds * 1000, t);
  const canOpenDetails = Boolean(readDetails);
  const toggleDetails = () => setIsDetailsOpen((isOpen) => !isOpen);

  const isPartShown = (part: ReadoutPart) => presentParts.includes(part) && !hiddenParts.has(part);
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
          <Shimmer className="shrink-0 font-medium">{`${label}…`}</Shimmer>
          {detail && (
            // Only the room the rest leaves it (flex-basis 0), so it is the
            // first to truncate.
            <span data-fit-clip data-fit-detail className="min-w-0 flex-1 truncate text-muted-foreground" title={detail}>
              {detail}
            </span>
          )}
          {shownProgress && (isPartShown('bar') || readoutWords.length > 0) && (
            <span
              data-readout
              data-fit-clip
              className="flex min-w-0 items-center gap-1.5 overflow-hidden tabular-nums text-muted-foreground"
            >
              {isPartShown('bar') && (
                <span data-readout-part="bar" className="flex shrink-0">
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
                  data-readout-part={part}
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
          <span className="shrink-0 tabular-nums text-muted-foreground/60">{elapsedLabel}</span>
          {canOpenDetails && (
            // The tab's toggle for the keyboard and assistive technology, its
            // name steady while the label beside it rotates and ticks. It has
            // no handler of its own: its click (a tap, Enter or Space) bubbles
            // to the tab's.
            <button
              type="button"
              aria-expanded={details !== null}
              aria-controls={detailsPanelId}
              aria-label={t('activityDetails.title', 'Progress details')}
              className="-mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover:text-foreground"
            >
              <ChevronUp
                className={cn('h-3.5 w-3.5 transition-transform duration-200', details !== null && 'rotate-180')}
                aria-hidden
              />
            </button>
          )}
        </div>

        {renderedActivity.canInterrupt && onAbort && (
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
            <kbd className="hidden rounded border border-border/60 px-1 text-[10px] text-muted-foreground/70 sm:inline-block">
              esc
            </kbd>
          </button>
        )}
      </div>

      {details && <ActivityDetailsPanel id={detailsPanelId} details={details} />}
    </div>
  );
}
