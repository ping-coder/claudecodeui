import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import type { ActivityProgress, SessionActivity } from '@/shared/types';

/**
 * A code editor docked beside the chat can pin the chat column at its 200px
 * minimum. The tab's label already truncated there, but the elapsed time and
 * the details toggle kept their widths and the toggle came last, so in
 * columns up to about 237px it was clipped first, and focusing it scrolled
 * the tab. Stop's esc hint and then the elapsed time now give way before it.
 */

const NOW = Date.parse('2026-10-26T10:06:00.000Z');

// A turn sent from here, six minutes in: the tab reads `6m 0s` and Stop shows.
const runningTurn: SessionActivity = { statusText: 'Thinking', canInterrupt: true, startedAt: NOW - 360_000 };

const workflowProgress: ActivityProgress = {
  unit: 'agents',
  done: 3,
  total: 7,
  running: 1,
  phase: 'Verify',
  startedAt: NOW - 180_000,
};

// jsdom lays nothing out, so a model stands in for the browser's desktop
// (sm:) layout, in Tailwind's sizes: the tab and Stop are surfaces with px-3
// and 1px borders, set gap-2 and gap-1.5 apart inside, and the row sets them
// gap-2 apart; the toggle is h-5 w-5 less its -mr-1. Text is CHAR_PX a
// character (text-xs), the esc hint's KBD_CHAR_PX (10px). The row is as wide
// as the chat column less the composer's 2rem. Nothing truncates in the
// model, so every element reports the width it would take in full.
const CHAR_PX = 6.5;
const KBD_CHAR_PX = 5.5;
const SURFACE_EXTRA_PX = 26;
const KBD_EXTRA_PX = 10;
const DOT_PX = 6;
const TOGGLE_PX = 16;
const STOP_ICON_PX = 10;
const SEGMENT_PX = 10;
const TAB_GAP_PX = 8;
const STOP_GAP_PX = 6;
const COMPOSER_INSET_PX = 32;

let rowWidth = 0;
const resizeCallbacks = new Set<() => void>();

const isTab = (element: Element) => element.tagName === 'DIV' && element.classList.contains('chat-activity-tab');
const isRow = (element: Element) => [...element.children].some(isTab);
const isStop = (element: Element) => element.tagName === 'BUTTON' && element.getAttribute('aria-label') === 'Stop';
const isToggle = (element: Element) => element.tagName === 'BUTTON' && element.hasAttribute('aria-expanded');
// The readout is the one span whose children are fit parts (the bar and its words).
const isReadout = (element: Element) => element.tagName === 'SPAN' && [...element.children].some((child) => child.hasAttribute('data-fit-part'));
const ownText = (element: Element) => [...element.childNodes]
  .filter((node) => node.nodeType === Node.TEXT_NODE)
  .map((node) => node.textContent ?? '')
  .join('');

/** The gap a container sets between its children, by the classes the component gives it. */
const modelGap = (element: Element): number | undefined => {
  if (isRow(element) || isTab(element)) {
    return TAB_GAP_PX;
  }
  if (isStop(element) || isReadout(element)) {
    return STOP_GAP_PX;
  }
  return undefined;
};

const modelWidth = (element: Element): number => {
  if (isToggle(element)) {
    return TOGGLE_PX;
  }
  // The hidden copies of the rotating action words are positioned out of
  // the row at no width; each copy still lays out at its own.
  if (element.hasAttribute('data-fit-label-words')) {
    return 0;
  }
  if (element.tagName.toLowerCase() === 'svg') {
    return STOP_ICON_PX;
  }
  if (element.hasAttribute('data-segment')) {
    return SEGMENT_PX;
  }
  if (element.tagName === 'KBD') {
    return KBD_EXTRA_PX + ownText(element).trim().length * KBD_CHAR_PX;
  }
  if (element.tagName === 'SPAN' && element.classList.contains('rounded-full') && element.children.length === 0) {
    return DOT_PX;
  }
  const children = [...element.children];
  const childrenWidth = children.reduce((sum, child) => sum + modelWidth(child), 0);
  const gaps = Math.max(0, children.length - 1) * (modelGap(element) ?? 0);
  const surface = isTab(element) || isStop(element) ? SURFACE_EXTRA_PX : 0;
  return childrenWidth + gaps + surface + ownText(element).length * CHAR_PX;
};

const layoutWidth = function (this: Element) {
  return isRow(this) ? rowWidth : modelWidth(this);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  rowWidth = 0;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const width = layoutWidth.call(this);
    return { x: 0, y: 0, top: 0, left: 0, bottom: 0, height: 0, right: width, width, toJSON: () => ({}) };
  });
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(layoutWidth);
  vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(layoutWidth);
  // The fit check reads the gaps from the computed style; jsdom applies no
  // Tailwind, so the model's gaps are handed in here.
  const realGetComputedStyle = document.defaultView!.getComputedStyle.bind(document.defaultView);
  vi.stubGlobal('getComputedStyle', (element: Element, pseudoElement?: string | null) => {
    const style = realGetComputedStyle(element, pseudoElement);
    const gap = modelGap(element);
    return gap === undefined
      ? style
      : new Proxy(style, {
        get(target, property) {
          if (property === 'columnGap') {
            return `${gap}px`;
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
  });
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
  vi.useRealTimers();
  resizeCallbacks.clear();
});

/** The chat column changes width (a docked editor, the sidebar): only the row's observer hears of it. */
const resizeColumn = (columnWidth: number) => act(() => {
  rowWidth = columnWidth - COMPOSER_INSET_PX;
  resizeCallbacks.forEach((callback) => callback());
});

const renderTab = (props: { progress?: ActivityProgress } = {}) => render(
  <ActivityIndicator activity={runningTurn} readDetails={() => null} onAbort={() => {}} {...props} />,
);

const parts = (container: HTMLElement) => {
  const tab = container.querySelector<HTMLElement>('div.chat-activity-tab')!;
  const stop = screen.getByRole('button', { name: 'Stop' });
  const label = tab.querySelector<HTMLElement>('[data-fit-label]')!;
  const room = rowWidth - modelWidth(stop) - TAB_GAP_PX;
  return {
    toggle: screen.queryByRole('button', { name: 'Progress details' }),
    escHint: stop.querySelector('kbd'),
    elapsed: screen.queryByText('6m 0s'),
    /** The toggle sits inside the tab's box once the label has truncated to nothing: no clip, no scroll on focus. */
    toggleFits: modelWidth(tab) - modelWidth(label) <= room,
    /** The label shows in full. */
    labelFits: modelWidth(tab) <= room,
  };
};

describe('the activity tab in the narrowest chat columns', () => {
  it('keeps the details toggle in view down to a 200px column, giving up Stop\'s esc hint and then the elapsed time first', () => {
    rowWidth = 500 - COMPOSER_INSET_PX;
    const { container } = renderTab();
    let shown = parts(container);
    expect(shown.escHint).not.toBeNull();
    expect(shown.elapsed).not.toBeNull();
    expect(shown.labelFits).toBe(true);

    // The esc hint goes before the label loses a letter.
    resizeColumn(300);
    shown = parts(container);
    expect(shown.escHint).toBeNull();
    expect(shown.elapsed).not.toBeNull();
    expect(shown.labelFits).toBe(true);

    // The band the toggle was clipped in, down to the 200px minimum.
    for (const columnWidth of [237, 230, 220, 210, 200]) {
      resizeColumn(columnWidth);
      shown = parts(container);
      expect(shown.toggle, `${columnWidth}px`).not.toBeNull();
      expect(shown.toggleFits, `${columnWidth}px`).toBe(true);
      expect(shown.escHint, `${columnWidth}px`).toBeNull();
    }
    // At the minimum even the elapsed time has had to go; the label has the rest.
    expect(shown.elapsed).toBeNull();

    // And everything comes back as the column widens.
    resizeColumn(500);
    shown = parts(container);
    expect(shown.escHint).not.toBeNull();
    expect(shown.elapsed).not.toBeNull();
    expect(shown.labelFits).toBe(true);
  });

  it('truncates the label away before it gives up the elapsed time', () => {
    rowWidth = 500 - COMPOSER_INSET_PX;
    const { container } = renderTab();

    resizeColumn(225);
    const shown = parts(container);
    expect(shown.elapsed).not.toBeNull();
    expect(shown.toggleFits).toBe(true);
  });

  it('fits a workflow\'s readout away and the toggle in, in a 200px column on the first paint', () => {
    rowWidth = 200 - COMPOSER_INSET_PX;
    const { container } = renderTab({ progress: workflowProgress });

    const shown = parts(container);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText('43%')).toBeNull();
    expect(shown.escHint).toBeNull();
    expect(shown.toggle).not.toBeNull();
    expect(shown.toggleFits).toBe(true);
  });

  it('keeps Stop\'s esc hint steady while the label rotates through action words of different widths', async () => {
    // German's action words, which differ by six characters (Arbeitet to
    // Schlussfolgert): more than the margin a hidden part must clear to
    // come back, so judging by the word on show flipped the hint each time
    // the word changed. English labels stay, so the model still finds Stop.
    const actionWords = {
      thinking: 'Denkt nach',
      processing: 'Verarbeitet',
      analyzing: 'Analysiert',
      working: 'Arbeitet',
      computing: 'Berechnet',
      reasoning: 'Schlussfolgert',
    };
    const englishActionWords = { ...i18n.getResource('en', 'chat', 'claudeStatus.actions') };
    i18n.addResourceBundle('en', 'chat', { claudeStatus: { actions: actionWords } }, true, true);
    try {
      // A turn sent from here: nothing names its status, so the label rotates.
      const rotatingTurn: SessionActivity = { ...runningTurn, statusText: null };
      rowWidth = 900;
      const { container } = render(<ActivityIndicator activity={rotatingTurn} readDetails={() => null} onAbort={() => {}} />);

      // A column where the hint fits beside the narrowest word but not the
      // widest: the room the tab has without the hint falls 5px short of the
      // widest word plus the hint.
      const tab = container.querySelector<HTMLElement>('div.chat-activity-tab')!;
      const stop = screen.getByRole('button', { name: 'Stop' });
      const escPartWidth = modelWidth(stop.querySelector('kbd')!) + STOP_GAP_PX;
      const stopWithoutEsc = modelWidth(stop) - escPartWidth;
      const tabWithoutLabel = modelWidth(tab) - modelWidth(tab.querySelector('[data-fit-label]')!);
      const widestLabel = (Math.max(...Object.values(actionWords).map((word) => word.length)) + 1) * CHAR_PX;
      resizeColumn(tabWithoutLabel + widestLabel + escPartWidth - 5 + stopWithoutEsc + TAB_GAP_PX + COMPOSER_INSET_PX);

      const escShownPerWord: boolean[] = [];
      for (let step = 0; step < 6; step += 1) {
        escShownPerWord.push(stop.querySelector('kbd') !== null);
        act(() => {
          vi.advanceTimersByTime(4_000);
        });
      }
      expect(escShownPerWord).toEqual([false, false, false, false, false, false]);
    } finally {
      i18n.addResourceBundle('en', 'chat', { claudeStatus: { actions: englishActionWords } }, true, true);
    }
  });

  it('measures a word a language uses twice once, without duplicate React keys', () => {
    // Italian names both "thinking" and "reasoning" Ragionamento.
    const actionWords = {
      thinking: 'Ragionamento',
      processing: 'Elaborazione',
      analyzing: 'Analisi',
      working: 'In lavorazione',
      computing: 'Calcolo',
      reasoning: 'Ragionamento',
    };
    const englishActionWords = { ...i18n.getResource('en', 'chat', 'claudeStatus.actions') };
    i18n.addResourceBundle('en', 'chat', { claudeStatus: { actions: actionWords } }, true, true);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      rowWidth = 900;
      const { container } = render(
        <ActivityIndicator activity={{ ...runningTurn, statusText: null }} readDetails={() => null} onAbort={() => {}} />,
      );
      act(() => {
        vi.advanceTimersByTime(8_000);
      });

      const copies = [...container.querySelectorAll('[data-fit-label-words] > *')].map((copy) => copy.textContent);
      expect(copies).toEqual(['Ragionamento…', 'Elaborazione…', 'Analisi…', 'In lavorazione…', 'Calcolo…']);
      expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key');
    } finally {
      consoleError.mockRestore();
      i18n.addResourceBundle('en', 'chat', { claudeStatus: { actions: englishActionWords } }, true, true);
    }
  });
});
