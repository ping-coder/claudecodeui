import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { afterAll, test } from 'vitest';

import GitPanelHeader from '@/modules/git-panel/GitPanelHeader';
import { i18n } from '@/modules/i18n';
import type { GitRemoteStatus } from '@/shared/types';

/**
 * In a pane at its minimum width (360 px) the header's fetch, pull and push buttons broke their
 * labels a character a line in Chinese ("抓/取") and a word a line in English ("Pull/1"), and pushed
 * the revert and refresh buttons out of the pane. The buttons keep their labels on one line, and
 * the row lets them move under the branch, at the end of the line, when they do not fit beside it.
 * jsdom lays nothing out, so this checks the classes that decide it; at full width the row is one
 * line as before.
 */

const REMOTE: GitRemoteStatus = {
  hasRemote: true,
  hasUpstream: true,
  remoteName: 'origin',
  remoteBranch: 'origin/main',
  ahead: 2,
  behind: 1,
  isUpToDate: false,
};

const noop = async () => undefined;

afterAll(async () => {
  await i18n.changeLanguage('en');
});

test('the action buttons keep one line and move under the branch when the pane is narrow', async () => {
  await i18n.changeLanguage('zh-CN');
  render(
    <GitPanelHeader
      isMobile={false}
      currentBranch="main"
      branches={['main']}
      remoteStatus={REMOTE}
      isLoading={false}
      isCreatingBranch={false}
      isFetching={false}
      isPulling={false}
      isPushing={false}
      isPublishing={false}
      isRevertingLocalCommit={false}
      operationError={null}
      onRefresh={() => undefined}
      onRevertLocalCommit={noop}
      onSwitchBranch={async () => true}
      onCreateBranch={async () => true}
      onFetch={noop}
      onPull={noop}
      onPush={noop}
      onPublish={noop}
      onClearError={() => undefined}
      onRequestConfirmation={() => undefined}
    />,
  );

  const pull = screen.getByRole('button', { name: '拉取 1' });
  const actions = pull.parentElement as HTMLElement;
  const row = actions.parentElement as HTMLElement;
  // The buttons' group: labels unbroken, and at the end of the line it lands on.
  assert.equal(actions.classList.contains('whitespace-nowrap'), true);
  assert.equal(actions.classList.contains('ms-auto'), true);
  // The row: the group may take a line of its own.
  assert.equal(row.classList.contains('flex-wrap'), true);
  // Every action still sits in that one group, the revert and refresh buttons included.
  const titles = [...actions.querySelectorAll('button')].map((button) => button.getAttribute('title') ?? '');
  assert.equal(titles.length, 5);
});
