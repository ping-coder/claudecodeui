import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import { afterAll, test } from 'vitest';

import CommitHistoryItem from '@/modules/git-panel/history/CommitHistoryItem';
import GitViewTabs from '@/modules/git-panel/GitViewTabs';
import { i18n } from '@/modules/i18n';
import type { GitCommitSummary } from '@/shared/types';

/**
 * A commit's "author • date" line isolates both parts: right to left, the day that starts a Hebrew
 * date joined the Latin name before it ("Dana Levi • 29" and then the month). The commit message is
 * laid out by its own first letter. The panel's tabs keep their labels on one line: in a narrow panel
 * the Chinese "更改" broke over two.
 */

const COMMIT: GitCommitSummary = {
  hash: '1a2532600000000000000000000000000000000',
  author: 'Dana Levi',
  date: '2026-10-29T12:00:00.000Z',
  message: 'Isolate inserted values.',
};

afterAll(async () => {
  await i18n.changeLanguage('en');
});

test('right to left the author and the date are each isolated', async () => {
  await i18n.changeLanguage('he');
  const { container } = render(
    <CommitHistoryItem commit={COMMIT} isExpanded={false} isMobile={false} wrapText={false} onToggle={() => {}} />,
  );

  const isolated = [...container.querySelectorAll('bdi')];
  const parts = isolated.map((part) => part.textContent);
  assert.deepEqual(parts, ['Dana Levi', new Date(COMMIT.date).toLocaleDateString('he', { year: 'numeric', month: 'short', day: 'numeric' })]);
  assert.equal(isolated[0]?.parentElement === isolated[1]?.parentElement, true);
  assert.equal(isolated[0]?.parentElement?.textContent, `Dana Levi • ${parts[1]}`);

  const message = [...container.querySelectorAll('p')].find((line) => line.textContent === COMMIT.message);
  assert.equal(message?.classList.contains('bidi-auto'), true);
});

test('the tab labels stay on one line, and a narrow panel scrolls the tabs instead', async () => {
  await i18n.changeLanguage('zh-CN');
  const { container } = render(<GitViewTabs activeView="changes" isHidden={false} changeCount={6} onChange={() => {}} />);

  const tabs = [...container.querySelectorAll('[role="tab"]')];
  assert.equal(tabs.length, 5);
  // No tab may shrink below its label: the strip scrolls (overflow-x-auto) instead.
  assert.deepEqual(tabs.map((tab) => tab.className.includes('min-w-0')), [false, false, false, false, false]);
  const labels = tabs.map((tab) => tab.querySelector('.whitespace-nowrap')?.textContent);
  assert.deepEqual(labels, ['更改', '比较', '提交', '分支', '工作树']);
});
