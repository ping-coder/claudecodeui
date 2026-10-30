import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { Project } from '@/shared/types';

/**
 * The workspace's refresh token reloads the source-control panel in place: status, branches and remote
 * every time, the commit list only while the Commits view shows it. The panel is not remounted, so the
 * view the user picked stays.
 */

const { calls } = vi.hoisted(() => ({ calls: { status: 0, branches: 0, remoteStatus: 0, commits: 0 } }));
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

vi.mock('@/shared/api', () => ({
  api: {
    git: {
      status: async () => {
        calls.status += 1;
        return json({ branch: 'main', modified: [], added: [], deleted: [], untracked: [] });
      },
      branches: async () => {
        calls.branches += 1;
        return json({ branches: ['main'], localBranches: ['main'], remoteBranches: [], remoteRefs: [] });
      },
      remoteStatus: async () => {
        calls.remoteStatus += 1;
        return json({ hasRemote: false });
      },
      commits: async () => {
        calls.commits += 1;
        return json({ commits: [{ hash: 'abc1234', author: 'Dana', date: '2026-10-29T12:00:00.000Z', message: 'First commit' }] });
      },
    },
  },
}));

const { default: GitPanel } = await import('@/modules/git-panel/GitPanel');

const PROJECT: Project = { projectId: 'p1', displayName: 'repo', fullPath: '/repo', path: '/repo' };

beforeEach(() => {
  calls.status = 0;
  calls.branches = 0;
  calls.remoteStatus = 0;
  calls.commits = 0;
});

test('a new refresh token reloads status, branches and remote in place, and the commits while they are shown', async () => {
  const view = render(<GitPanel selectedProject={PROJECT} refreshToken={0} />);
  await waitFor(() => assert.deepEqual(calls, { status: 1, branches: 1, remoteStatus: 1, commits: 0 }));

  view.rerender(<GitPanel selectedProject={PROJECT} refreshToken={1} />);
  await waitFor(() => assert.deepEqual(calls, { status: 2, branches: 2, remoteStatus: 2, commits: 0 }, 'no commit list off the Commits view'));

  fireEvent.click(screen.getByRole('tab', { name: /Commits/ }));
  await waitFor(() => assert.equal(calls.commits, 1));
  view.rerender(<GitPanel selectedProject={PROJECT} refreshToken={2} />);
  await waitFor(() => assert.deepEqual(calls, { status: 3, branches: 3, remoteStatus: 3, commits: 2 }));
  assert.equal(screen.getByRole('tab', { name: /Commits/ }).getAttribute('aria-selected'), 'true', 'the view the user picked stays');
});
