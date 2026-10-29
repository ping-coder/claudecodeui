import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { afterAll, test } from 'vitest';

import MergeWorktreeModal from '@/modules/git-panel/modals/MergeWorktreeModal';
import { i18n } from '@/modules/i18n';
import type { MergeWorktreeOptions, WorktreeInfo } from '@/shared/types';

/**
 * The default message of a worktree merge goes into the git history, so it is in
 * English whatever the interface language, and carries none of the bidi isolates a
 * right-to-left interface puts around values.
 */

const WORKTREE: WorktreeInfo = {
  path: '/tmp/project-one-rtl',
  branch: 'feature/rtl',
  headSha: 'a1b2c3d',
  isMain: false,
  isCurrent: false,
  isLocked: false,
  isDetached: false,
  changedFileCount: 0,
  ahead: 2,
  behind: 0,
  lastCommitSubject: null,
  lastCommitDate: null,
  linkedProjectId: null,
  linkedProjectArchived: false,
};

afterAll(async () => {
  await i18n.changeLanguage('en');
});

test.each(['he', 'zh-CN'])('the default merge message is plain English in %s', async (language) => {
  await i18n.changeLanguage(language);
  const merged: MergeWorktreeOptions[] = [];
  const view = render(
    <MergeWorktreeModal
      worktree={WORKTREE}
      baseBranch="main"
      isMerging={false}
      onClose={() => undefined}
      onMerge={async (_path, options) => {
        merged.push(options);
        return false;
      }}
    />,
  );
  const message = () => (screen.getByRole('textbox') as HTMLTextAreaElement).value;
  const squashed = message();
  fireEvent.click(screen.getAllByRole('checkbox')[0]);
  const plain = message();
  fireEvent.click(screen.getAllByRole('button')[1]);
  view.unmount();
  assert.deepEqual([squashed, plain], ["Squash merge branch 'feature/rtl'", "Merge branch 'feature/rtl'"]);
  assert.equal(merged[0]?.message, "Merge branch 'feature/rtl'");
});
