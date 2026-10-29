import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { afterEach, test } from 'vitest';

import { i18n } from '@/modules/i18n';
import CodeEditorBinaryFile from '@/modules/code-editor/CodeEditorBinaryFile';

/**
 * The binary-file view names its full-screen and close buttons in the UI language, with the
 * editor's own words for them (the same the media preview uses), docked and floating.
 */

const file = { name: 'logo.bin', path: '/home/u/demo/logo.bin' };

afterEach(async () => {
  await i18n.changeLanguage('en');
});

const renderBinaryFile = (props: { isSidebar?: boolean; isFullscreen?: boolean } = {}) =>
  render(
    <CodeEditorBinaryFile
      file={file}
      isSidebar={props.isSidebar ?? false}
      isFullscreen={props.isFullscreen ?? false}
      onClose={() => {}}
      onToggleFullscreen={() => {}}
      title="Binary File"
      message="Cannot be shown."
    />,
  );

/** The titles of the header buttons, in order. */
const headerTitles = (container: HTMLElement) =>
  [...container.querySelectorAll('button[title]')].map((button) => button.getAttribute('title')).join(' | ');

test('the floating view names full screen and close in English', () => {
  const { container, unmount } = renderBinaryFile();
  assert.equal(headerTitles(container), 'Fullscreen | Close');
  // The button under the message, besides the header's.
  assert.equal(screen.queryByText('Close', { selector: 'button' }) !== null, true);
  unmount();

  assert.equal(headerTitles(renderBinaryFile({ isFullscreen: true }).container), 'Exit fullscreen | Close');
});

test('in Simplified Chinese the buttons use the editor\'s translations, docked and floating', async () => {
  await i18n.changeLanguage('zh-CN');
  const floating = renderBinaryFile();
  assert.equal(headerTitles(floating.container), '全屏 | 关闭');
  assert.equal(screen.queryByText('关闭', { selector: 'button' }) !== null, true);
  floating.unmount();

  const maximized = renderBinaryFile({ isFullscreen: true });
  assert.equal(headerTitles(maximized.container), '退出全屏 | 关闭');
  maximized.unmount();

  assert.equal(headerTitles(renderBinaryFile({ isSidebar: true }).container), '关闭');
});
