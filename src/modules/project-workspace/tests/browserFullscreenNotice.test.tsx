import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import '@/modules/i18n';
import BrowserFullscreenNotice from '@/modules/project-workspace/BrowserFullscreenNotice';

/**
 * The notice says why workspace full screen did not fill the screen: a refusal comes with the
 * browser's reason and a retry, a full screen kept inside the window with the window's own
 * full-screen shortcut for the platform. It is a status that never takes focus or the keyboard.
 */

afterEach(() => {
  Reflect.deleteProperty(navigator, 'platform');
});

const setPlatform = (platform: string) => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
};

// Strings and booleans, never nodes: a failed node:assert on a jsdom node walks the whole tree.
const noticeText = () => screen.getByRole('status').textContent ?? '';
const hasButton = (name: string) => screen.queryByRole('button', { name }) !== null;

test('a refusal shows the browser\'s reason and a retry, without taking focus', () => {
  const onRetry = vi.fn();
  const onDismiss = vi.fn();
  render(<BrowserFullscreenNotice issue={{ reason: 'refused', detail: 'not granted' }} onRetry={onRetry} onDismiss={onDismiss} />);

  assert.equal(noticeText().includes('The browser refused full screen (not granted)'), true);
  assert.equal(document.activeElement === document.body, true);
  assert.equal(document.querySelector('[data-escape-layer]') === null, true);
  assert.equal(screen.queryByRole('dialog') === null, true);

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  assert.equal(onRetry.mock.calls.length, 1);
  assert.equal(onDismiss.mock.calls.length, 0);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  assert.equal(onDismiss.mock.calls.length, 1);
});

test('on a Mac, full screen kept inside the window offers ⌃⌘F and the View menu\'s toolbar item instead of a retry', () => {
  setPlatform('MacIntel');
  const onDismiss = vi.fn();
  render(<BrowserFullscreenNotice issue={{ reason: 'inWindow' }} onRetry={() => undefined} onDismiss={onDismiss} />);

  assert.equal(noticeText().includes('kept full screen inside the window'), true);
  assert.equal(hasButton('Retry'), false);
  assert.equal(noticeText().includes('⌃⌘F'), true);
  assert.equal(noticeText().includes('View > Always Show Toolbar in Full Screen (⇧⌘F)'), true);
  assert.equal(noticeText().includes('F11'), false);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  assert.equal(onDismiss.mock.calls.length, 1);
});

test('elsewhere, full screen kept inside the window offers F11', () => {
  setPlatform('Linux x86_64');
  render(<BrowserFullscreenNotice issue={{ reason: 'inWindow' }} onRetry={() => undefined} onDismiss={() => undefined} />);

  assert.equal(hasButton('Retry'), false);
  assert.equal(noticeText().includes('F11'), true);
  assert.equal(noticeText().includes('⌘'), false);
});
