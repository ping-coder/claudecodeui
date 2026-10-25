import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import type { ActivityProgress, SessionActivity } from '@/shared/types';

/**
 * The run status tab above the composer named the work and its elapsed time,
 * but not how far it had got. When the transcript has something to count it
 * now carries a readout like the CLI's workflow row: a four-segment bar, the
 * count, the percent done and an estimate of the time left.
 */

const NOW = Date.parse('2026-10-26T10:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const runningTurn = (startedAgoMs: number): SessionActivity => ({
  statusText: 'Thinking',
  canInterrupt: true,
  startedAt: NOW - startedAgoMs,
});

const backgroundWork = (startedAgoMs: number): SessionActivity => ({
  statusText: null,
  canInterrupt: false,
  startedAt: NOW - startedAgoMs,
  background: true,
  tasks: [{
    taskId: 'wxkj4kcvd',
    toolUseId: 'toolu_workflow_1',
    taskType: 'local_workflow',
    description: 'Audit the frontend',
    workflowName: 'frontend-architecture-audit',
    startedAt: NOW - startedAgoMs,
  }],
});

// One agent at a time, so the estimate extrapolates the pace so far (agents
// running side by side give none without their own timing).
const progress = (overrides: Partial<ActivityProgress>): ActivityProgress => ({
  unit: 'agents',
  done: 3,
  total: 7,
  running: 1,
  startedAt: NOW - 180_000,
  ...overrides,
});

/** The state of each of the bar's four segments, left to right. */
const segments = () => [...screen.getByRole('progressbar').querySelectorAll('[data-segment]')]
  .map((segment) => segment.getAttribute('data-segment'));

describe('the progress readout in the activity tab', () => {
  it('shows a running turn\'s bar, count, percent and time left beside its elapsed time and Stop', () => {
    const { container } = render(
      <ActivityIndicator activity={runningTurn(180_000)} progress={progress({})} onAbort={() => {}} />,
    );

    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-label')).toBe('3/7 agents');
    expect(bar.getAttribute('aria-valuenow')).toBe('3');
    expect(bar.getAttribute('aria-valuemax')).toBe('7');
    // round(3 / 7 × 4) = 2 filled, the next animated while agents run.
    expect(segments()).toEqual(['done', 'done', 'running', 'open']);

    expect(screen.getByText('3/7 agents')).toBeTruthy();
    expect(screen.getByText('43%')).toBeTruthy();
    // 3 done in 3 minutes, 4 to go: about 4 more minutes.
    const estimate = screen.getByText('~4m left');
    expect(estimate.getAttribute('title')).toBe('Estimated from the pace so far');
    // In the order the CLI's row reads, separators included.
    expect(container.textContent).toContain('3/7 agents· 43%· ~4m left');
    expect(container.textContent).toContain('Thinking…');
    expect(container.textContent).toContain('3m 0s');
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
  });

  it('counts the workflow a finished turn left running, in the background state', () => {
    const { container } = render(
      <ActivityIndicator
        activity={backgroundWork(360_000)}
        progress={progress({ done: 2, total: 6, running: 1, startedAt: NOW - 360_000 })}
        onAbort={() => {}}
      />,
    );

    expect(container.textContent).toContain('Background work…');
    expect(container.textContent).toContain('Workflow frontend-architecture-audit');
    expect(segments()).toEqual(['done', 'running', 'open', 'open']);
    expect(screen.getByText('2/6 agents')).toBeTruthy();
    expect(screen.getByText('33%')).toBeTruthy();
    // 2 done in 6 minutes, 4 to go.
    expect(screen.getByText('~12m left')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('extrapolates from when the counted work began, not when the current turn did', () => {
    // A workflow launched ten minutes ago by an earlier turn, half done; the
    // turn now running began a minute ago.
    render(
      <ActivityIndicator
        activity={runningTurn(60_000)}
        progress={progress({ done: 5, total: 10, running: 1, startedAt: NOW - 600_000 })}
      />,
    );

    expect(screen.getByText('~10m left')).toBeTruthy();
  });

  it('keeps the time left on the tab\'s own clock as it ticks', () => {
    // A checklist begun with the turn: one task done in the first minute.
    render(
      <ActivityIndicator activity={runningTurn(60_000)} progress={progress({ unit: 'tasks', done: 1, total: 4, startedAt: NOW - 60_000 })} />,
    );
    expect(screen.getByText('~3m left')).toBeTruthy();

    // A minute on with nothing more done, the pace has halved.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText('2m 0s')).toBeTruthy();
    expect(screen.getByText('~6m left')).toBeTruthy();
  });

  it('gives no estimate before a unit has finished, or while the pace is too young to trust', () => {
    const notStarted = render(
      <ActivityIndicator activity={runningTurn(300_000)} progress={progress({ done: 0, total: 4, running: 1, startedAt: NOW - 300_000 })} />,
    );
    expect(segments()).toEqual(['running', 'open', 'open', 'open']);
    expect(screen.getByText('0%')).toBeTruthy();
    expect(notStarted.container.textContent).not.toMatch(/left/);
    notStarted.unmount();

    const tooEarly = render(
      <ActivityIndicator activity={runningTurn(10_000)} progress={progress({ done: 1, total: 4, running: 1, startedAt: NOW - 10_000 })} />,
    );
    expect(screen.getByText('25%')).toBeTruthy();
    expect(tooEarly.container.textContent).not.toMatch(/left/);
  });

  it('counts a checklist in tasks', () => {
    render(
      <ActivityIndicator activity={runningTurn(120_000)} progress={progress({ unit: 'tasks', done: 3, total: 7, running: 1, startedAt: NOW - 120_000 })} />,
    );

    expect(screen.getByText('3/7 tasks')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-label')).toBe('3/7 tasks');
  });

  it('fills the bar only when every unit is done, and drops the estimate then', () => {
    const finished = render(
      <ActivityIndicator activity={runningTurn(300_000)} progress={progress({ done: 7, total: 7, running: 0 })} />,
    );
    expect(segments()).toEqual(['done', 'done', 'done', 'done']);
    expect(screen.getByText('100%')).toBeTruthy();
    expect(finished.container.textContent).not.toMatch(/left/);
    finished.unmount();

    // 7 of 8 rounds to four segments; one still running keeps the last open.
    render(<ActivityIndicator activity={runningTurn(300_000)} progress={progress({ done: 7, total: 8, running: 1 })} />);
    expect(segments()).toEqual(['done', 'done', 'done', 'running']);
    expect(screen.getByText('88%')).toBeTruthy();
  });

  it('leads the count with the workflow\'s phase, as the CLI\'s row does', () => {
    const { container } = render(
      <ActivityIndicator activity={backgroundWork(180_000)} progress={progress({ phase: 'Verify' })} />,
    );

    expect(screen.getByText('Verify')).toBeTruthy();
    expect(container.textContent).toContain('Verify· 3/7 agents· 43%· ~4m left');
  });

  it('clips and truncates rather than running under Stop, and decides nothing by the viewport', () => {
    // Before, every part was shrink-0 and picked by sm:/md: breakpoints, so
    // a chat pane narrowed by a docked editor on a wide screen showed them
    // all and ran under Stop, losing the elapsed time.
    const { container } = render(
      <ActivityIndicator activity={runningTurn(180_000)} progress={progress({ phase: 'Verify' })} onAbort={() => {}} />,
    );

    const tab = container.querySelector('div.chat-activity-tab');
    expect(tab?.classList.contains('min-w-0')).toBe(true);
    expect(tab?.classList.contains('overflow-hidden')).toBe(true);
    const readout = screen.getByText('43%').parentElement;
    expect(readout?.classList.contains('min-w-0')).toBe(true);
    expect(readout?.classList.contains('overflow-hidden')).toBe(true);
    for (const optional of [screen.getByText('Verify'), screen.getByText('3/7 agents'), screen.getByText('~4m left')]) {
      expect(optional.classList.contains('min-w-0')).toBe(true);
      expect(optional.classList.contains('truncate')).toBe(true);
    }
    expect(screen.getByText('3m 0s').classList.contains('shrink-0')).toBe(true);
    for (const element of tab?.querySelectorAll('*') ?? []) {
      expect(element.getAttribute('class') ?? '').not.toMatch(/(^|\s)(sm|md|lg):(inline|hidden|block|flex)/);
    }
  });

  it('draws no readout when there is nothing to count', () => {
    const { container, rerender } = render(<ActivityIndicator activity={backgroundWork(65_000)} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(container.textContent).toContain('Workflow frontend-architecture-audit');
    expect(container.textContent).toContain('1m 5s');

    rerender(<ActivityIndicator activity={backgroundWork(65_000)} progress={progress({ done: 0, total: 0, running: 0 })} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(container.textContent).not.toMatch(/%/);
  });
});

describe('the readout in a narrow chat pane', () => {
  // jsdom lays nothing out, so a model stands in for the browser: every
  // character is CHAR_PX wide, a bar segment SEGMENT_PX, Stop STOP_PX, and the
  // tab's row is `rowWidth` wide, whatever the viewport. Nothing truncates in
  // the model, so a tab that does not fit shows as one wider than its room.
  const CHAR_PX = 6;
  const SEGMENT_PX = 10;
  const TAB_PADDING_PX = 24;
  const STOP_PX = 70;
  let rowWidth = 0;
  const resizeCallbacks = new Set<() => void>();

  const isTab = (element: Element) => element.tagName === 'DIV' && element.classList.contains('chat-activity-tab');
  const isRow = (element: Element) => [...element.children].some(isTab);
  const ownText = (element: Element) => [...element.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? '')
    .join('');
  const modelWidth = (element: Element): number => {
    if (element.tagName === 'BUTTON') {
      return STOP_PX;
    }
    if (element.hasAttribute('data-segment')) {
      return SEGMENT_PX;
    }
    const childrenWidth = [...element.children].reduce((sum, child) => sum + modelWidth(child), 0);
    return childrenWidth + ownText(element).length * CHAR_PX + (isTab(element) ? TAB_PADDING_PX : 0);
  };
  const layoutWidth = function (this: HTMLElement) {
    return isRow(this) ? rowWidth : modelWidth(this);
  };

  beforeEach(() => {
    rowWidth = 0;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const width = layoutWidth.call(this);
      return { x: 0, y: 0, top: 0, left: 0, bottom: 0, height: 0, right: width, width, toJSON: () => ({}) };
    });
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(layoutWidth);
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(layoutWidth);
    vi.stubGlobal('ResizeObserver', class {
      private readonly callback: () => void;

      constructor(callback: () => void) {
        this.callback = callback;
      }

      observe() {
        resizeCallbacks.add(this.callback);
      }

      disconnect() {
        resizeCallbacks.delete(this.callback);
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resizeCallbacks.clear();
  });

  /** The pane changes width (a docked editor, the sidebar): only the row's observer hears of it. */
  const resizeRow = (width: number) => act(() => {
    rowWidth = width;
    resizeCallbacks.forEach((callback) => callback());
  });

  /** Which of the readout's parts are drawn, as the CLI's row reads them. */
  const shownParts = () => ({
    phase: screen.queryByText('Verify') !== null,
    count: screen.queryByText('3/7 agents') !== null,
    percent: screen.queryByText('43%') !== null,
    estimate: screen.queryByText('~4m left') !== null,
    bar: screen.queryByRole('progressbar') !== null,
  });

  it('gives up the phase, then the count, the time left, the percent and the bar as the pane narrows, and takes them back as it widens', () => {
    rowWidth = 500;
    const { container } = render(
      <ActivityIndicator activity={runningTurn(180_000)} progress={progress({ phase: 'Verify' })} onAbort={() => {}} />,
    );
    const tab = container.querySelector<HTMLElement>('div.chat-activity-tab');
    const all = { phase: true, count: true, percent: true, estimate: true, bar: true };
    expect(shownParts()).toEqual(all);

    const steps: Array<[number, Partial<typeof all>]> = [
      [400, { phase: false }],
      [340, { phase: false, count: false }],
      [280, { phase: false, count: false, estimate: false }],
      [230, { phase: false, count: false, estimate: false, percent: false }],
      [200, { phase: false, count: false, estimate: false, percent: false, bar: false }],
    ];
    for (const [width, hidden] of steps) {
      resizeRow(width);
      expect(shownParts()).toEqual({ ...all, ...hidden });
      // Whatever goes, the label, the elapsed time and Stop stay, and the tab
      // fits beside Stop.
      expect(container.textContent).toContain('Thinking…');
      expect(screen.getByText('3m 0s')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
      expect(modelWidth(tab!)).toBeLessThanOrEqual(width - STOP_PX);
    }

    resizeRow(500);
    expect(shownParts()).toEqual(all);
  });

  it('fits by the pane it is in, already on the first paint', () => {
    rowWidth = 340;
    render(<ActivityIndicator activity={runningTurn(180_000)} progress={progress({ phase: 'Verify' })} onAbort={() => {}} />);

    expect(shownParts()).toEqual({ phase: false, count: false, percent: true, estimate: true, bar: true });
  });

  it('truncates the background work\'s name before giving up the bar, the percent and the time left', () => {
    // The name alone is 216px wide: counted in full, it would push the whole
    // readout out of a 400px row.
    rowWidth = 400;
    const { container } = render(
      <ActivityIndicator
        activity={backgroundWork(360_000)}
        progress={progress({ done: 2, total: 6, running: 1, startedAt: NOW - 360_000 })}
      />,
    );

    expect(container.textContent).toContain('Workflow frontend-architecture-audit');
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(screen.getByText('33%')).toBeTruthy();
    expect(screen.getByText('~12m left')).toBeTruthy();
    expect(screen.queryByText('2/6 agents')).toBeNull();
    expect(screen.getByText('6m 0s')).toBeTruthy();
  });
});
