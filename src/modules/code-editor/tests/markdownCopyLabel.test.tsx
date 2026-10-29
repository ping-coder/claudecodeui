import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import type * as SharedUtils from '@/shared/utils';

/**
 * The copy button on a code block in the Markdown preview (the code editor's and the PRD editor's)
 * says "Copy" and "Copied!" in the UI language.
 */

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

const copyTextToClipboard = vi.fn(async (_text: string) => true);
vi.mock('@/shared/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedUtils>()),
  copyTextToClipboard,
}));

const { i18n } = await import('@/modules/i18n');
const { default: MarkdownCodeBlock } = await import('@/modules/code-editor/markdown/MarkdownCodeBlock');

afterEach(async () => {
  await i18n.changeLanguage('en');
});

const CODE = 'const a = 1;\nconst b = 2;\n';

/** The copy button's text before and after a click. */
const copyLabels = async () => {
  const { container, unmount } = render(<MarkdownCodeBlock className="language-js">{CODE}</MarkdownCodeBlock>);
  const button = container.querySelector('button');
  const before = button?.textContent ?? '';
  await act(async () => {
    fireEvent.click(button as HTMLButtonElement);
  });
  const after = container.querySelector('button')?.textContent ?? '';
  unmount();
  return { before, after };
};

test('in English the button says Copy, then Copied!', async () => {
  assert.deepEqual(await copyLabels(), { before: 'Copy', after: 'Copied!' });
  assert.equal(copyTextToClipboard.mock.calls.at(-1)?.[0], CODE);
});

test('in Simplified Chinese and Hebrew it uses the editor\'s translations', async () => {
  await i18n.changeLanguage('zh-CN');
  assert.deepEqual(await copyLabels(), { before: '复制', after: '已复制' });

  await i18n.changeLanguage('he');
  const hebrew = i18n.getFixedT('he', 'codeEditor');
  const labels = await copyLabels();
  assert.deepEqual(labels, { before: hebrew('markdownPreview.copy'), after: hebrew('markdownPreview.copied') });
  assert.equal(/[A-Za-z]/.test(labels.before + labels.after), false);
  // The block itself is still shown, whatever the language.
  render(<MarkdownCodeBlock className="language-js">{CODE}</MarkdownCodeBlock>);
  assert.equal(screen.queryByText('js') !== null, true);
});
