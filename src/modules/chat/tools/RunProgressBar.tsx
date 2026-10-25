import { cn } from '@/shared/utils';

type RunProgressBarProps = {
  /** Units finished. */
  done: number;
  /** Every unit known so far. */
  total: number;
  /** Units in flight. While there are any, the first unfilled segment animates in place of the CLI's spinner. */
  running: number;
} & (
  | {
    /**
     * Drawn as decoration only, hidden from assistive technology, for a bar
     * whose count is already in the text beside it inside a control (the
     * Workflow card's header button). There a progressbar's value would be
     * read into the button's name as a stray number ahead of the count.
     */
    decorative: true;
    label?: undefined;
  }
  | {
    decorative?: false;
    /** What the bar counts, read out by assistive technology in place of the segments (e.g. `3/7 agents`). */
    label: string;
  }
);

/** The Claude Code CLI's dynamic-workflow row draws its bar in four segments. */
const SEGMENT_COUNT = 4;

type SegmentState = 'done' | 'running' | 'open';

const SEGMENT_STYLES: Record<SegmentState, string> = {
  done: 'bg-green-500 dark:bg-green-400',
  // Half-lit at rest, so with the animation off (reduced motion) it still
  // never reads as a finished segment; the animation brightens it in turn.
  running: 'chat-progress-segment-running bg-green-500 opacity-50 motion-reduce:animate-none dark:bg-green-400',
  open: 'bg-muted-foreground/20',
};

/**
 * Used by chat's ActivityIndicator (the run status tab above the composer)
 * and WorkflowPanel (a Workflow card's header) to draw how far a run has got
 * the way the CLI's workflow row does: round(done / total × 4) segments
 * filled in the success colour, the next one animated while units are in
 * flight, the rest dimmed.
 */
export function RunProgressBar({ done, total, running, decorative, label }: RunProgressBarProps) {
  const isComplete = total > 0 && done >= total;
  // Unlike the CLI's plain rounding, work with units still open never fills
  // the whole bar: 7 of 8 done would otherwise read as finished.
  const filled = isComplete
    ? SEGMENT_COUNT
    : total > 0
      ? Math.min(SEGMENT_COUNT - 1, Math.round((done / total) * SEGMENT_COUNT))
      : 0;
  const runningIndex = running > 0 && filled < SEGMENT_COUNT ? filled : -1;
  const semantics = decorative
    ? { 'aria-hidden': true }
    : {
      role: 'progressbar',
      'aria-label': label,
      'aria-valuemin': 0,
      'aria-valuemax': total,
      'aria-valuenow': done,
    };

  return (
    <span {...semantics} className="inline-flex shrink-0 items-center gap-0.5">
      {Array.from({ length: SEGMENT_COUNT }, (_, index) => {
        const state: SegmentState = index < filled ? 'done' : index === runningIndex ? 'running' : 'open';
        return (
          <span
            key={index}
            data-segment={state}
            className={cn('h-1.5 w-2.5 rounded-[2px]', SEGMENT_STYLES[state])}
          />
        );
      })}
    </span>
  );
}
