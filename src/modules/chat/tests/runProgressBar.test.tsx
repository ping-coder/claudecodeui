import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RunProgressBar } from '@/modules/chat/tools/RunProgressBar';

/**
 * The segmented bar the activity tab and the Workflow card's header draw a
 * run's progress with, like the CLI's workflow row.
 */

const segmentsOf = (container: HTMLElement) => [...container.querySelectorAll('[data-segment]')];

describe('the run progress bar', () => {
  it('is a progressbar named by what it counts, valued by the units done', () => {
    render(<RunProgressBar done={3} total={7} running={1} label="3/7 agents" />);

    const bar = screen.getByRole('progressbar', { name: '3/7 agents' });
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('7');
    expect(bar.getAttribute('aria-valuenow')).toBe('3');
  });

  it('can be drawn as decoration only, with no progressbar semantics for a control to read into its name', () => {
    const { container } = render(<RunProgressBar decorative done={1} total={3} running={1} />);

    expect(screen.queryByRole('progressbar')).toBeNull();
    const bar = container.firstElementChild;
    expect(bar?.getAttribute('aria-hidden')).toBe('true');
    for (const attribute of ['role', 'aria-label', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow']) {
      expect(bar?.hasAttribute(attribute)).toBe(false);
    }
    // The same segments as the real bar.
    expect(segmentsOf(container).map((segment) => segment.getAttribute('data-segment'))).toEqual(['done', 'running', 'open', 'open']);
  });

  it('never draws a running segment like a finished one once its animation is off, as under reduced motion', () => {
    // Reduced motion ends the animation at once (and turns it off outright
    // here), leaving the segment's resting look. That look was the done
    // segments' solid green, so 7 of 8 with one running read as finished.
    const { container } = render(<RunProgressBar done={7} total={8} running={1} label="7/8 agents" />);

    const [done, , , running] = segmentsOf(container);
    expect(done.getAttribute('data-segment')).toBe('done');
    expect(running.getAttribute('data-segment')).toBe('running');
    const restingLook = (segment: Element) => [...segment.classList]
      .filter((name) => name !== 'chat-progress-segment-running' && !name.startsWith('motion-reduce:'))
      .sort()
      .join(' ');
    expect(restingLook(running)).not.toBe(restingLook(done));
    expect(running.classList.contains('motion-reduce:animate-none')).toBe(true);
  });
});
