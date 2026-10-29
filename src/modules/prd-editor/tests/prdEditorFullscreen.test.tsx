import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * The PRD editor's full screen is the browser's: its button asks for the root fullscreen in the
 * click, the editor fills the viewport while it lasts, Escape leaves it before it closes the editor,
 * and the browser ending it only restores the editor's size.
 */

vi.mock('@uiw/react-codemirror', () => ({
  default: function CodeMirrorStub({ value }: { value: string }) {
    return <textarea data-testid="prd-body" value={value} readOnly />;
  },
}));

const { default: PRDEditor } = await import('@/modules/prd-editor/PRDEditor');

const onClose = vi.fn();
let fullscreenElement: Element | null = null;
const requestFullscreen = vi.fn(async () => {
  fullscreenElement = document.documentElement;
  document.dispatchEvent(new Event('fullscreenchange'));
});
const exitFullscreen = vi.fn(async () => {
  fullscreenElement = null;
  document.dispatchEvent(new Event('fullscreenchange'));
});

beforeEach(() => {
  fullscreenElement = null;
  onClose.mockClear();
  requestFullscreen.mockClear();
  exitFullscreen.mockClear();
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true });
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
  Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, writable: true, value: requestFullscreen });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, writable: true, value: exitFullscreen });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
});

afterEach(() => {
  for (const [target, key] of [[document, 'fullscreenEnabled'], [document, 'fullscreenElement'], [document.documentElement, 'requestFullscreen'], [document, 'exitFullscreen']] as const) {
    Reflect.deleteProperty(target, key);
  }
  vi.unstubAllGlobals();
});

// A new PRD needs no project and no request: the template, or the given content, opens at once.
const renderEditor = async () => {
  const view = render(<PRDEditor onClose={onClose} isNewFile initialContent="# PRD" />);
  await screen.findByTestId('prd-body');
  return view;
};

const backdropClass = (container: HTMLElement) => container.querySelector('.fixed.inset-0')?.className ?? '';

const pressEscape = (init: KeyboardEventInit = {}) => {
  act(() => {
    fireEvent.keyDown(document, { key: 'Escape', ...init });
  });
};

test('full screen asks for the root fullscreen in the click and the browser ending it only restores the size', async () => {
  const { container } = await renderEditor();
  assert.equal(backdropClass(container).includes('md:p-4'), true);

  act(() => {
    fireEvent.click(screen.getByTitle('Fullscreen'));
  });
  assert.equal(requestFullscreen.mock.calls.length, 1);
  assert.equal(requestFullscreen.mock.contexts[0] === document.documentElement, true);
  await act(async () => undefined);
  assert.equal(backdropClass(container).includes('md:p-0'), true);

  act(() => {
    fullscreenElement = null;
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  assert.equal(backdropClass(container).includes('md:p-4'), true);
  assert.equal(screen.queryByTestId('prd-body') !== null, true);
  assert.equal(onClose.mock.calls.length, 0);
});

test('Escape leaves full screen first and closes the editor on the next press, after anything above took its own', async () => {
  const { container } = await renderEditor();
  act(() => {
    fireEvent.click(screen.getByTitle('Fullscreen'));
  });
  await act(async () => undefined);

  // CodeMirror's completion list or search panel took this one.
  document.addEventListener('keydown', (event) => event.preventDefault(), { capture: true, once: true });
  pressEscape();
  assert.equal(backdropClass(container).includes('md:p-0'), true);

  pressEscape();
  assert.equal(exitFullscreen.mock.calls.length, 1);
  assert.equal(backdropClass(container).includes('md:p-4'), true);
  assert.equal(onClose.mock.calls.length, 0);

  pressEscape({ repeat: true });
  assert.equal(onClose.mock.calls.length, 0);

  // A dialog over the editor owns Escape.
  const dialog = document.body.appendChild(document.createElement('div'));
  dialog.setAttribute('aria-modal', 'true');
  pressEscape();
  dialog.remove();
  assert.equal(onClose.mock.calls.length, 0);

  pressEscape();
  assert.equal(onClose.mock.calls.length, 1);
});

test('closing the PRD editor while full screen leaves the browser fullscreen', async () => {
  const { unmount } = await renderEditor();
  act(() => {
    fireEvent.click(screen.getByTitle('Fullscreen'));
  });
  await act(async () => undefined);

  unmount();

  assert.equal(exitFullscreen.mock.calls.length, 1);
});
