import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import BrowserFullscreenNotice from '@/modules/project-workspace/BrowserFullscreenNotice';

/**
 * The notice says why a full screen (immersive mode, the editor, the PRD editor, Browser Use) did
 * not fill the screen: a refusal comes with the browser's reason and a retry, a full screen kept
 * inside the tab with the window's own full-screen shortcut for the platform, a window smaller than
 * the screen with both sizes, and a request that could not be made with what to do instead. It is
 * a status that never takes focus or the keyboard.
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
  render(<BrowserFullscreenNotice issue={{ reason: 'inWindow', kind: 'tab' }} onRetry={() => undefined} onDismiss={onDismiss} />);

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
  render(<BrowserFullscreenNotice issue={{ reason: 'inWindow', kind: 'tab' }} onRetry={() => undefined} onDismiss={() => undefined} />);

  assert.equal(hasButton('Retry'), false);
  assert.equal(noticeText().includes('F11'), true);
  assert.equal(noticeText().includes('⌘'), false);
});

test('a window smaller than the screen says both sizes and to leave Split View, without a retry', () => {
  setPlatform('MacIntel');
  render(
    <BrowserFullscreenNotice
      issue={{ reason: 'inWindow', kind: 'partial', window: { width: 1512, height: 945 }, screen: { width: 3024, height: 982 } }}
      onRetry={() => undefined}
      onDismiss={() => undefined}
    />,
  );

  assert.equal(noticeText().includes('window 1512×945, screen 3024×982'), true);
  assert.equal(noticeText().includes('Split View'), true);
  assert.equal(hasButton('Retry'), false);
  // In <body>, above the workspace shell and its maximized editor, under the run banners (z-40).
  assert.equal(screen.getByRole('status').parentElement === document.body, true);
  assert.equal(screen.getByRole('status').className.includes('z-[39]'), true);
});

test('where no request could be made, the notice says why, without a retry', () => {
  setPlatform('MacIntel');
  const { rerender } = render(
    <BrowserFullscreenNotice issue={{ reason: 'unavailable', cause: 'iframe' }} onRetry={() => undefined} onDismiss={() => undefined} />,
  );
  assert.equal(noticeText().includes('own tab'), true);
  assert.equal(hasButton('Retry'), false);

  rerender(<BrowserFullscreenNotice issue={{ reason: 'unavailable', cause: 'noApi' }} onRetry={() => undefined} onDismiss={() => undefined} />);
  assert.equal(noticeText().includes('no full screen for web pages'), true);
  assert.equal(noticeText().includes('⌘'), false);
});

test('in Chinese the notice reads from the zh-CN strings, the sizes filled in', async () => {
  await act(async () => {
    await i18n.changeLanguage('zh-CN');
  });
  try {
    const { rerender } = render(
      <BrowserFullscreenNotice
        issue={{ reason: 'inWindow', kind: 'partial', window: { width: 1512, height: 945 }, screen: { width: 3024, height: 982 } }}
        onRetry={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    assert.equal(noticeText().includes('窗口 1512×945，屏幕 3024×982'), true);
    assert.equal(noticeText().includes('先让窗口退出分屏或平铺'), true);

    // Not only immersive mode refuses now: the text no longer says the workspace.
    rerender(<BrowserFullscreenNotice issue={{ reason: 'refused', detail: 'not granted' }} onRetry={() => undefined} onDismiss={() => undefined} />);
    assert.equal(noticeText().includes('浏览器拒绝了全屏（not granted），现在只铺满了窗口。'), true);
  } finally {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  }
});
