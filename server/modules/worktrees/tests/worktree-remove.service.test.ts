import assert from 'node:assert/strict';
import test from 'node:test';

import { removeWorktree } from '@/modules/worktrees/services/worktree-remove.service.js';
import type { GitCommandResult, ProjectRepositoryRow } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const PORCELAIN = [
  'worktree /home/user/repo',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree /home/user/repo-worktrees/feature-login',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/feature/login',
  '',
].join('\n');

type RecordedCall = { args: string[]; cwd: string };

function createFakeRunner(options: {
  dirty?: boolean;
  branchDeleteFails?: boolean;
  statusFails?: boolean;
  removeFails?: boolean;
} = {}) {
  const calls: RecordedCall[] = [];
  const runner = async (args: string[], cwd: string): Promise<GitCommandResult> => {
    calls.push({ args, cwd });

    if (args[0] === 'worktree' && args[1] === 'list') {
      return { stdout: PORCELAIN, stderr: '' };
    }

    if (args[0] === 'status') {
      if (options.statusFails) {
        throw new AppError('status failed', { code: 'GIT_COMMAND_FAILED' });
      }
      return { stdout: options.dirty ? '?? new-file.txt\n' : '', stderr: '' };
    }

    if (args[0] === 'branch' && args[1] === '-D' && options.branchDeleteFails) {
      throw new AppError('branch delete failed', { code: 'GIT_COMMAND_FAILED' });
    }

    if (args[0] === 'worktree' && args[1] === 'remove' && options.removeFails) {
      // What git says for a locked worktree, `remove --force` included.
      throw new AppError('fatal: cannot remove a locked working tree, lock reason: busy', { code: 'GIT_COMMAND_FAILED' });
    }

    return { stdout: '', stderr: '' };
  };

  return { calls, runner };
}

function createDependencies(
  runner: ReturnType<typeof createFakeRunner>['runner'],
  linkedProject: ProjectRepositoryRow | null = null,
  archiveError: Error | null = null,
  mountOptions: { calls?: RecordedCall[]; detachError?: Error } = {},
) {
  const archivedProjectIds: string[] = [];
  // Each worktree whose mount links were taken out, and whether git had already been asked to remove it then.
  const detachedMounts: Array<{ worktreePath: string; afterGitRemove: boolean }> = [];
  // Each time the links taken out were put back, and how many git calls had been made by then.
  const reattachedMounts: Array<{ worktreePath: string; gitCallsBefore: number }> = [];

  return {
    archivedProjectIds,
    detachedMounts,
    reattachedMounts,
    dependencies: {
      runGit: runner,
      projects: {
        getProjectByPath: () => linkedProject,
        archiveProject: async (projectId: string) => {
          if (archiveError) {
            throw archiveError;
          }
          archivedProjectIds.push(projectId);
        },
      },
      mounts: {
        detachMountLinks: async (worktreePath: string) => {
          detachedMounts.push({
            worktreePath: worktreePath.replace(/\\/g, '/'),
            afterGitRemove: (mountOptions.calls ?? []).some((call) => call.args[0] === 'worktree' && call.args[1] === 'remove'),
          });
          if (mountOptions.detachError) {
            throw mountOptions.detachError;
          }
          return {
            reattach: async () => {
              reattachedMounts.push({
                worktreePath: worktreePath.replace(/\\/g, '/'),
                gitCallsBefore: (mountOptions.calls ?? []).length,
              });
            },
          };
        },
      },
    },
  };
}

test('removeWorktree removes a clean worktree and deletes its branch', async () => {
  const { calls, runner } = createFakeRunner();
  const { dependencies } = createDependencies(runner);

  const result = await removeWorktree(
    {
      projectPath: '/home/user/repo',
      worktreePath: '/home/user/repo-worktrees/feature-login',
      deleteBranch: true,
    },
    dependencies,
  );

  assert.equal(result.branch, 'feature/login');
  assert.equal(result.branchDeleted, true);
  assert.equal(result.archivedProjectId, null);
  assert.equal(result.archivalError, null);

  const removeCall = calls.find((call) => call.args[0] === 'worktree' && call.args[1] === 'remove');
  assert.ok(removeCall, 'expected a worktree remove call');
  assert.ok(!removeCall.args.includes('--force'));

  const branchDeleteCall = calls.find((call) => call.args[0] === 'branch' && call.args[1] === '-D');
  assert.ok(branchDeleteCall, 'expected the branch to be deleted');
  assert.equal(branchDeleteCall.args[2], 'feature/login');
});

test('removeWorktree rejects a dirty worktree unless forced', async () => {
  const { runner } = createFakeRunner({ dirty: true });
  const { dependencies } = createDependencies(runner);

  await assert.rejects(
    removeWorktree(
      {
        projectPath: '/home/user/repo',
        worktreePath: '/home/user/repo-worktrees/feature-login',
      },
      dependencies,
    ),
    (error: unknown) =>
      error instanceof AppError && error.code === 'WORKTREE_DIRTY' && error.statusCode === 409,
  );
});

test('removeWorktree does not remove when status cannot confirm the worktree is clean', async () => {
  const { calls, runner } = createFakeRunner({ statusFails: true });
  const { dependencies } = createDependencies(runner);

  await assert.rejects(removeWorktree({
    projectPath: '/home/user/repo',
    worktreePath: '/home/user/repo-worktrees/feature-login',
  }, dependencies));

  assert.equal(calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'remove'), false);
});

test('removeWorktree passes --force through and skips the dirty check', async () => {
  const { calls, runner } = createFakeRunner({ dirty: true });
  const { dependencies } = createDependencies(runner);

  await removeWorktree(
    {
      projectPath: '/home/user/repo',
      worktreePath: '/home/user/repo-worktrees/feature-login',
      force: true,
    },
    dependencies,
  );

  const removeCall = calls.find((call) => call.args[0] === 'worktree' && call.args[1] === 'remove');
  assert.ok(removeCall);
  assert.ok(removeCall.args.includes('--force'));
});

test('removeWorktree reports branchDeleted=false when branch deletion fails', async () => {
  const { runner } = createFakeRunner({ branchDeleteFails: true });
  const { dependencies } = createDependencies(runner);

  const result = await removeWorktree(
    {
      projectPath: '/home/user/repo',
      worktreePath: '/home/user/repo-worktrees/feature-login',
      deleteBranch: true,
    },
    dependencies,
  );

  assert.equal(result.branchDeleted, false);
});

test('removeWorktree archives an active project linked to the removed path', async () => {
  const { runner } = createFakeRunner();
  const linkedProject: ProjectRepositoryRow = {
    project_id: 'project-1',
    project_path: '/home/user/repo-worktrees/feature-login',
    custom_project_name: 'repo · feature/login',
    isStarred: 0,
    isArchived: 0,
  };
  const { archivedProjectIds, dependencies } = createDependencies(runner, linkedProject);

  const result = await removeWorktree(
    {
      projectPath: '/home/user/repo',
      worktreePath: linkedProject.project_path,
    },
    dependencies,
  );

  assert.equal(result.archivedProjectId, 'project-1');
  assert.equal(result.archivalError, null);
  assert.deepEqual(archivedProjectIds, ['project-1']);
});

test('removeWorktree reports archival failure after successful Git removal', async () => {
  const { runner } = createFakeRunner();
  const linkedProject: ProjectRepositoryRow = {
    project_id: 'project-1',
    project_path: '/home/user/repo-worktrees/feature-login',
    custom_project_name: 'feature/login',
    isStarred: 0,
    isArchived: 0,
  };
  const { dependencies } = createDependencies(runner, linkedProject, new Error('archive failed'));

  const result = await removeWorktree({
    projectPath: '/home/user/repo',
    worktreePath: linkedProject.project_path,
  }, dependencies);

  assert.equal(result.removedPath.replace(/\\/g, '/'), linkedProject.project_path);
  assert.equal(result.archivedProjectId, null);
  assert.equal(result.archivalError, 'archive failed');
});

test('removeWorktree never removes the main worktree', async () => {
  const { runner } = createFakeRunner();
  const { dependencies } = createDependencies(runner);

  await assert.rejects(
    removeWorktree(
      {
        projectPath: '/home/user/repo-worktrees/feature-login',
        worktreePath: '/home/user/repo',
      },
      dependencies,
    ),
    (error: unknown) =>
      error instanceof AppError
      && error.code === 'WORKTREE_MAIN_NOT_REMOVABLE'
      && error.statusCode === 400,
  );
});

test('removeWorktree takes the worktree\'s mount links out before git deletes it', async () => {
  for (const force of [false, true]) {
    const { calls, runner } = createFakeRunner();
    const { dependencies, detachedMounts } = createDependencies(runner, null, null, { calls });

    await removeWorktree({
      projectPath: '/home/user/repo',
      worktreePath: '/home/user/repo-worktrees/feature-login',
      force,
    }, dependencies);

    assert.deepEqual(detachedMounts, [
      { worktreePath: '/home/user/repo-worktrees/feature-login', afterGitRemove: false },
    ], `force ${force}`);
    assert.equal(calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'remove'), true);
  }
});

test('removeWorktree leaves the worktree alone when a mount link cannot be taken out', async () => {
  const { calls, runner } = createFakeRunner();
  const linkedProject: ProjectRepositoryRow = {
    project_id: 'project-1',
    project_path: '/home/user/repo-worktrees/feature-login',
    custom_project_name: 'feature/login',
    isStarred: 0,
    isArchived: 0,
  };
  const detachError = new AppError('Could not remove the link mounts/data', { code: 'MOUNT_LINK_FAILED', statusCode: 500 });
  const { archivedProjectIds, dependencies } = createDependencies(runner, linkedProject, null, { calls, detachError });

  await assert.rejects(
    removeWorktree({
      projectPath: '/home/user/repo',
      worktreePath: linkedProject.project_path,
      deleteBranch: true,
    }, dependencies),
    (error: unknown) => error instanceof AppError && error.code === 'MOUNT_LINK_FAILED',
  );

  assert.equal(calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'remove'), false);
  assert.equal(calls.some((call) => call.args[0] === 'branch'), false);
  assert.deepEqual(archivedProjectIds, []);
});

test('removeWorktree puts the mount links back when git refuses to remove the worktree', async () => {
  for (const force of [false, true]) {
    const { calls, runner } = createFakeRunner({ removeFails: true });
    const linkedProject: ProjectRepositoryRow = {
      project_id: 'project-1',
      project_path: '/home/user/repo-worktrees/feature-login',
      custom_project_name: 'feature/login',
      isStarred: 0,
      isArchived: 0,
    };
    const { archivedProjectIds, dependencies, detachedMounts, reattachedMounts } = createDependencies(
      runner,
      linkedProject,
      null,
      { calls },
    );

    await assert.rejects(
      removeWorktree({
        projectPath: '/home/user/repo',
        worktreePath: linkedProject.project_path,
        deleteBranch: true,
        force,
      }, dependencies),
      (error: unknown) => error instanceof AppError && /locked working tree/.test(error.message),
      `force ${force}`,
    );

    assert.equal(detachedMounts.length, 1, `force ${force}`);
    const removeCallCount = calls.findIndex((call) => call.args[0] === 'worktree' && call.args[1] === 'remove') + 1;
    assert.deepEqual(reattachedMounts, [
      { worktreePath: '/home/user/repo-worktrees/feature-login', gitCallsBefore: removeCallCount },
    ], `force ${force}: the links are back right after git refused`);
    assert.equal(calls.some((call) => call.args[0] === 'branch'), false);
    assert.deepEqual(archivedProjectIds, []);
  }

  // A removal git carries out leaves the links out.
  const { runner } = createFakeRunner();
  const { dependencies, reattachedMounts } = createDependencies(runner);
  await removeWorktree({
    projectPath: '/home/user/repo',
    worktreePath: '/home/user/repo-worktrees/feature-login',
  }, dependencies);
  assert.deepEqual(reattachedMounts, []);
});
