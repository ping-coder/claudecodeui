import assert from 'node:assert/strict';

import { useRef } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useElementWidth } from '@/shared/hooks/useElementWidth';

/**
 * useElementWidth hands `select` the element's width and height and the value
 * it selected last, for an answer with hysteresis; a hidden element (width 0)
 * is not selected for at all. A select of the width alone works as before.
 */

/** A ResizeObserver jsdom lacks, driven by hand. */
class StubResizeObserver {
  static instances: StubResizeObserver[] = [];

  callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    StubResizeObserver.instances.push(this);
  }

  observe(): void {}

  disconnect(): void {}
}

let size = { width: 0, height: 0 };

/** The measured element takes a new size, and its observer hears of it. */
const resize = (width: number, height: number) => {
  size = { width, height };
  act(() => {
    StubResizeObserver.instances.forEach((observer) => observer.callback([], observer as unknown as ResizeObserver));
  });
};

function Measured<T>({ select, onValue }: { select: (width: number, height: number, previous: T | undefined) => T; onValue: (value: T) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  onValue(useElementWidth(ref, select));
  return <div ref={ref} data-measured="" />;
}

beforeEach(() => {
  StubResizeObserver.instances = [];
  size = { width: 0, height: 0 };
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function measure(this: HTMLElement) {
    const { width, height } = this.hasAttribute('data-measured') ? size : { width: 0, height: 0 };
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('select gets the width, the height and the value it selected last', () => {
  const calls: string[] = [];
  let value = '';
  const select = (width: number, height: number, previous: string | undefined) => {
    calls.push(`${width}x${height} after ${previous ?? 'nothing'}`);
    return `${width}x${height}`;
  };
  size = { width: 300.4, height: 199.6 };
  render(<Measured select={select} onValue={(next) => { value = next; }} />);
  assert.equal(value, '300x200');

  resize(310, 210);
  assert.equal(value, '310x210');
  assert.equal(calls.join(' | '), '0x0 after nothing | 300x200 after 0x0 | 310x210 after 300x200');
});

test('a width of 0 selects nothing and leaves the value as it was', () => {
  const select = vi.fn((width: number, height: number) => `${width}x${height}`);
  let value = '';
  size = { width: 300, height: 200 };
  render(<Measured select={select} onValue={(next) => { value = next; }} />);
  const callsBefore = select.mock.calls.length;

  resize(0, 0);

  assert.equal(select.mock.calls.length === callsBefore, true);
  assert.equal(value, '300x200');
});

test('a select of the width alone works as before', () => {
  let value: boolean | null = null;
  size = { width: 600, height: 400 };
  render(<Measured select={(width: number) => width >= 500} onValue={(next) => { value = next; }} />);
  assert.equal(value, true);

  resize(400, 400);
  assert.equal(value, false);
});
