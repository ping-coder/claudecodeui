import assert from 'node:assert/strict';

import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import PaneSplitter from '@/modules/project-workspace/PaneSplitter';

/**
 * The divider between two side-by-side panes. Dragging rewrites only the group's
 * --pane-left-width variable, once per animation frame, and saves the ratio once on
 * release; every pane keeps PANE_MIN_WIDTH_PX (360px). Keys step it by 4%, Home and a
 * double-click put it back in the middle, and a drag cut short by an unmount must not
 * leave the page unselectable.
 */

// The group is 1006px wide: 1000px for the panes after the 6px divider, so 360px is a 0.36 share.
const GROUP_WIDTH = 1006;
const MIN_SHARE = 0.36;
const MAX_SHARE = 0.64;

let frames: Array<FrameRequestCallback | null> = [];
const flushFrames = () => {
  const pending = frames;
  frames = [];
  for (const callback of pending) {
    callback?.(0);
  }
};

beforeEach(() => {
  frames = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames[id - 1] = null;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function measure(this: HTMLElement) {
    const width = this.dataset.testid === 'group' ? GROUP_WIDTH : 0;
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 600, width, height: 600, toJSON: () => ({}) } as DOMRect;
  });
});

afterEach(() => {
  document.body.style.userSelect = '';
});

function SplitterHarness({ ratio, onCommit }: { ratio: number; onCommit: (ratio: number) => void }) {
  const groupRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={groupRef} data-testid="group">
      <PaneSplitter containerRef={groupRef} ratio={ratio} onCommit={onCommit} />
    </div>
  );
}

/** jsdom has no PointerEvent: build the event and give it the fields React reads. */
const firePointer = (
  element: Element,
  type: 'pointerDown' | 'pointerMove' | 'pointerUp',
  clientX: number,
) => {
  const event = createEvent[type](element);
  Object.defineProperties(event, {
    clientX: { value: clientX },
    button: { value: 0 },
    pointerId: { value: 1 },
  });
  fireEvent(element, event);
};

const leftWidthOf = (share: number) => `calc((100% - 6px) * ${share})`;
const readLeftWidth = () => screen.getByTestId('group').style.getPropertyValue('--pane-left-width');
const readShare = () => Number(/\* ([\d.]+)\)$/.exec(readLeftWidth())?.[1]);
const assertClose = (actual: number | undefined, expected: number, message?: string) => {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${message ?? 'share'}: expected ${expected}, got ${actual}`);
};

test('the committed ratio sets the left pane width before paint and follows later commits', () => {
  const onCommit = vi.fn();
  const view = render(<SplitterHarness ratio={0.5} onCommit={onCommit} />);

  assert.equal(readLeftWidth(), leftWidthOf(0.5));
  const separator = screen.getByRole('separator', { name: 'Resize panes' });
  assert.equal(separator.getAttribute('aria-valuenow'), '50');
  assert.equal(separator.getAttribute('aria-orientation'), 'vertical');

  view.rerender(<SplitterHarness ratio={0.4} onCommit={onCommit} />);
  assert.equal(readLeftWidth(), leftWidthOf(0.4));
  assert.equal(onCommit.mock.calls.length, 0);
});

test('a drag rewrites only the CSS variable, once per frame, clamped to the pane minimums, and commits once on release', () => {
  const onCommit = vi.fn();
  render(<SplitterHarness ratio={0.5} onCommit={onCommit} />);
  const separator = screen.getByRole('separator');

  firePointer(separator, 'pointerDown', 500);
  assert.equal(document.body.style.userSelect, 'none', 'text selection is off while dragging');

  firePointer(separator, 'pointerMove', 600);
  assert.equal(readLeftWidth(), leftWidthOf(0.5), 'nothing is written before the frame');
  flushFrames();
  assertClose(readShare(), 0.6, 'a 100px move shifts a tenth of the width');

  // Two moves inside one frame produce one write, with the latest position.
  firePointer(separator, 'pointerMove', 900);
  firePointer(separator, 'pointerMove', 950);
  assert.equal(frames.filter(Boolean).length, 1, 'moves within a frame share one write');
  flushFrames();
  assertClose(readShare(), MAX_SHARE, 'the right pane keeps 360px');

  firePointer(separator, 'pointerMove', 0);
  flushFrames();
  assertClose(readShare(), MIN_SHARE, 'the left pane keeps 360px');
  assert.equal(onCommit.mock.calls.length, 0, 'nothing is saved while dragging');

  firePointer(separator, 'pointerUp', 0);
  assert.equal(onCommit.mock.calls.length, 1, 'the release saves once');
  assertClose(onCommit.mock.calls[0][0] as number, MIN_SHARE, 'the saved share');
  assert.equal(document.body.style.userSelect, '');

  // Later moves without a press do nothing.
  firePointer(separator, 'pointerMove', 700);
  flushFrames();
  assert.equal(onCommit.mock.calls.length, 1);
});

test('a press and release without a move saves nothing', () => {
  const onCommit = vi.fn();
  render(<SplitterHarness ratio={0.5} onCommit={onCommit} />);
  const separator = screen.getByRole('separator');

  firePointer(separator, 'pointerDown', 500);
  firePointer(separator, 'pointerUp', 500);

  assert.equal(onCommit.mock.calls.length, 0);
});

test('arrow keys step the share by 4% within the minimums, and Home resets it', () => {
  const onCommit = vi.fn();
  const view = render(<SplitterHarness ratio={0.5} onCommit={onCommit} />);
  const separator = screen.getByRole('separator');

  fireEvent.keyDown(separator, { key: 'ArrowRight' });
  fireEvent.keyDown(separator, { key: 'ArrowLeft' });
  fireEvent.keyDown(separator, { key: 'Home' });
  const committed = onCommit.mock.calls.map(([share]) => share as number);
  assert.equal(committed.length, 3);
  assertClose(committed[0], 0.54, 'ArrowRight');
  assertClose(committed[1], 0.46, 'ArrowLeft');
  assertClose(committed[2], 0.5, 'Home');

  view.rerender(<SplitterHarness ratio={0.62} onCommit={onCommit} />);
  fireEvent.keyDown(separator, { key: 'ArrowRight' });
  assertClose(onCommit.mock.calls[3][0] as number, MAX_SHARE, 'a step never squeezes the right pane under 360px');
});

test('a double-click puts the divider back in the middle', () => {
  const onCommit = vi.fn();
  render(<SplitterHarness ratio={0.4} onCommit={onCommit} />);

  fireEvent.doubleClick(screen.getByRole('separator'));

  assert.equal(onCommit.mock.calls.length, 1);
  assertClose(onCommit.mock.calls[0][0] as number, 0.5);
  assert.equal(readLeftWidth(), leftWidthOf(0.5));
});

test('unmounting mid-drag gives text selection back', () => {
  const onCommit = vi.fn();
  const view = render(<SplitterHarness ratio={0.5} onCommit={onCommit} />);

  firePointer(screen.getByRole('separator'), 'pointerDown', 500);
  assert.equal(document.body.style.userSelect, 'none');

  view.unmount();
  assert.equal(document.body.style.userSelect, '');
  assert.equal(onCommit.mock.calls.length, 0);
});

test('a saved share under a pane\'s pixel minimum drags, steps and reports from where the divider is drawn', () => {
  // A 1212px column: 1206px after the divider, so 360px is a 0.2985 share. The saved 0.241 came from a
  // wider column (immersive, the sidebar collapsed); CSS draws the left pane at 360px anyway.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function measure(this: HTMLElement) {
    const width = this.dataset.testid === 'group' ? 1212 : 0;
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 600, width, height: 600, toJSON: () => ({}) } as DOMRect;
  });
  const drawnShare = 360 / 1206;
  const onCommit = vi.fn();
  render(<SplitterHarness ratio={0.241} onCommit={onCommit} />);
  const separator = screen.getByRole('separator');

  assert.equal(separator.getAttribute('aria-valuenow'), String(Math.round(drawnShare * 100)), 'it reports where it is drawn');

  firePointer(separator, 'pointerDown', 360);
  firePointer(separator, 'pointerMove', 380);
  flushFrames();
  assertClose(readShare(), drawnShare + 20 / 1206, 'the first 20px already move it');
  firePointer(separator, 'pointerUp', 380);
  assertClose(onCommit.mock.calls[0][0] as number, drawnShare + 20 / 1206);

  fireEvent.keyDown(separator, { key: 'ArrowRight' });
  assertClose(onCommit.mock.calls[1][0] as number, drawnShare + 0.04, 'a step starts from the drawn share too');
});
