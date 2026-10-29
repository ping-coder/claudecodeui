//----------------- TEXT DIRECTION ------------

/**
 * Whether an element is laid out right to left: true under <html dir="rtl"> (set by
 * i18n/config.ts for Hebrew and other right-to-left languages), false inside a forced
 * left-to-right island such as the code editor. Read it in event handlers that turn pointer
 * movement or arrow keys into a size or an index; classes should use logical utilities instead.
 */
export function isRtl(element?: Element | null): boolean {
  const target = element ?? (typeof document === 'undefined' ? null : document.documentElement);
  if (!target || typeof getComputedStyle !== 'function') {
    return false;
  }
  return getComputedStyle(target).direction === 'rtl';
}

/** The arrow key that moves forward (to the next item) along a row in this element's direction. */
export const forwardArrowKey = (element?: Element | null): 'ArrowLeft' | 'ArrowRight' =>
  (isRtl(element) ? 'ArrowLeft' : 'ArrowRight');

/**
 * +1, or -1 right to left: multiply a pointer's clientX movement by it to get how far it moved
 * along the row, so dragging a divider towards the end widens what comes before it.
 */
export const inlineSign = (element?: Element | null): 1 | -1 => (isRtl(element) ? -1 : 1);

/**
 * The side of the screen a workspace pane is on. Panes are named after their place left to
 * right ('left' is the first one, next to the sidebar); right to left the first pane is on the
 * right, so labels such as "Left pane" are picked by this, not by the name.
 */
export const visualPaneSide = (side: 'left' | 'right', element?: Element | null): 'left' | 'right' => {
  if (!isRtl(element)) return side;
  return side === 'left' ? 'right' : 'left';
};

/** LRI, RLI, FSI and PDI: the isolates right-to-left interface strings carry (modules/i18n/bidi.ts). */
const BIDI_ISOLATES = /[\u2066-\u2069]/g;

/**
 * Interface text without its bidi isolates, for text that leaves the screen: a system
 * notification, a message sent to a model, a manual copy. Other marks (LRM, RLM) stay, since
 * the interface never adds them and the user may have typed them.
 */
export const stripBidiIsolates = (text: string): string => text.replace(BIDI_ISOLATES, '');

// ---------------------------
