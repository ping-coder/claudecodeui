import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import spawn from 'cross-spawn';

import type { ProjectTemplateGitResult, ProjectTemplateWarning } from '@/shared/types.js';

type InitializeTemplateGitRepositoryInput = {
  projectRoot: string;
  /** Template files this run created, relative to the project root; the only files committed. */
  files: string[];
  commitMessage: string;
};

type InitializeTemplateGitRepositoryResult = {
  git: ProjectTemplateGitResult;
  warnings: ProjectTemplateWarning[];
};

type GitChildProcess = {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
};

type InitializeTemplateGitRepositoryDependencies = {
  spawnGit: (args: string[], cwd: string) => GitChildProcess;
};

type GitRunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  /** git itself could not be started (not installed or not on PATH). */
  notFound: boolean;
};

/**
 * No git command here should take long; the limit only matters when something
 * waits on input that never comes, such as a signing passphrase prompt.
 */
const GIT_COMMAND_TIMEOUT_MS = 60_000;

/**
 * What `git rev-parse` prints when it looked in the folder and every folder
 * above it (up to the root, a mount point or GIT_CEILING_DIRECTORIES) and found
 * no repository. A broken `.git` file above prints "not a git repository: <path>"
 * instead, which must not count as "no repository".
 */
const NO_REPOSITORY_FOUND = /not a git repository \(or any/i;

const defaultDependencies: InitializeTemplateGitRepositoryDependencies = {
  spawnGit: (args: string[], cwd: string): GitChildProcess =>
    spawn('git', args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      // LC_ALL=C keeps git's messages in English so NO_REPOSITORY_FOUND matches in any server locale.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      timeout: GIT_COMMAND_TIMEOUT_MS,
    }) as unknown as GitChildProcess,
};

function runGit(
  args: string[],
  cwd: string,
  dependencies: InitializeTemplateGitRepositoryDependencies,
): Promise<GitRunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (result: GitRunResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    let child: GitChildProcess;
    try {
      child = dependencies.spawnGit(args, cwd);
    } catch (error) {
      settle({ code: null, stdout, stderr, notFound: (error as NodeJS.ErrnoException).code === 'ENOENT' });
      return;
    }

    child.stdout?.on('data', (data: Buffer | string) => {
      stdout += data.toString();
    });
    child.stderr?.on('data', (data: Buffer | string) => {
      stderr += data.toString();
    });
    child.on('error', (error) => {
      settle({ code: null, stdout, stderr: stderr || error.message, notFound: error.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      settle({ code, stdout, stderr, notFound: false });
    });
  });
}

async function hasGitMarker(directory: string): Promise<boolean> {
  try {
    const markerStats = await stat(path.join(directory, '.git'));
    return markerStats.isDirectory() || markerStats.isFile();
  } catch {
    return false;
  }
}

/** Whether any folder above the project root has a `.git` entry, read from the real path the way git sees it. */
async function hasGitMarkerAbove(projectRoot: string): Promise<boolean> {
  let current = await realpath(projectRoot).catch(() => path.resolve(projectRoot));
  for (let parent = path.dirname(current); parent !== current; parent = path.dirname(current)) {
    if (await hasGitMarker(parent)) {
      return true;
    }
    current = parent;
  }
  return false;
}

async function isSameDirectory(left: string, right: string): Promise<boolean> {
  try {
    const [realLeft, realRight] = await Promise.all([realpath(left), realpath(right)]);
    const comparable = (value: string) => {
      const resolved = path.resolve(value);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    return comparable(realLeft) === comparable(realRight);
  } catch {
    return false;
  }
}

/**
 * Whether git has a configured author and committer. `user.useConfigOnly`
 * stops git from inventing one from the login and host name, which would
 * otherwise commit as something like `user@host.localdomain`.
 */
async function hasGitIdentity(
  projectRoot: string,
  dependencies: InitializeTemplateGitRepositoryDependencies,
): Promise<boolean> {
  for (const identity of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const result = await runGit(['-c', 'user.useConfigOnly=true', 'var', identity], projectRoot, dependencies);
    if (result.code !== 0) {
      return false;
    }
  }
  return true;
}

/**
 * Turns a template project into a new repository on branch `main` and commits
 * the template files. Used by the projects module when a template project is
 * created with the "new repository" git source.
 *
 * Nothing here fails the project creation; every problem becomes a warning:
 * - the folder is already a repository: no init, no commit;
 * - the folder sits inside another repository: no init (a nested repository
 *   would confuse the outer one), `INSIDE_PARENT_REPOSITORY`. This includes a
 *   parent repository git refuses to open, such as one owned by another user
 *   or using a format this git does not know;
 * - git is missing: `GIT_NOT_FOUND`; init fails, or git cannot tell whether
 *   the folder is inside a repository: `GIT_INIT_FAILED`;
 * - no configured identity: the repository is initialized and the files are
 *   left uncommitted, `GIT_IDENTITY_MISSING`;
 * - add or commit fails: `GIT_COMMIT_FAILED`.
 *
 * Only the listed files are staged, so other files in the folder never land in
 * the initial commit.
 */
export async function initializeTemplateGitRepository(
  input: InitializeTemplateGitRepositoryInput,
  dependencies: InitializeTemplateGitRepositoryDependencies = defaultDependencies,
): Promise<InitializeTemplateGitRepositoryResult> {
  const { projectRoot } = input;

  if (await hasGitMarker(projectRoot)) {
    return { git: { action: 'already-repository', committed: false }, warnings: [] };
  }

  const topLevel = await runGit(['rev-parse', '--show-toplevel'], projectRoot, dependencies);
  if (topLevel.notFound) {
    return { git: { action: 'none', committed: false }, warnings: ['GIT_NOT_FOUND'] };
  }
  if (topLevel.code === 0) {
    if (await isSameDirectory(topLevel.stdout.trim(), projectRoot)) {
      return { git: { action: 'already-repository', committed: false }, warnings: [] };
    }
    return { git: { action: 'inside-parent-repository', committed: false }, warnings: ['INSIDE_PARENT_REPOSITORY'] };
  }
  // rev-parse failed. Unless it says it found no repository, git may have found
  // one above and refused to open it (dubious ownership, an unknown repository
  // extension, a bare repository). `git init` does not look upward, so it would
  // nest a repository inside that one. The `.git` walk only picks the warning.
  if (!NO_REPOSITORY_FOUND.test(topLevel.stderr)) {
    if (await hasGitMarkerAbove(projectRoot)) {
      return { git: { action: 'inside-parent-repository', committed: false }, warnings: ['INSIDE_PARENT_REPOSITORY'] };
    }
    return { git: { action: 'none', committed: false }, warnings: ['GIT_INIT_FAILED'] };
  }

  const init = await runGit(['init', '--initial-branch=main'], projectRoot, dependencies);
  if (init.notFound) {
    return { git: { action: 'none', committed: false }, warnings: ['GIT_NOT_FOUND'] };
  }
  if (init.code !== 0) {
    // Git before 2.28 has no --initial-branch: init on its default branch, then point HEAD at main.
    const plainInit = await runGit(['init'], projectRoot, dependencies);
    if (plainInit.code !== 0) {
      return { git: { action: 'none', committed: false }, warnings: ['GIT_INIT_FAILED'] };
    }
    await runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], projectRoot, dependencies);
  }

  if (input.files.length === 0) {
    return { git: { action: 'initialized', committed: false }, warnings: [] };
  }

  if (!(await hasGitIdentity(projectRoot, dependencies))) {
    return { git: { action: 'initialized', committed: false }, warnings: ['GIT_IDENTITY_MISSING'] };
  }

  // --force: a global excludes file may ignore CLAUDE.md or .claude/, but these
  // are the files the user asked the template to commit.
  const add = await runGit(['add', '--force', '--', ...input.files], projectRoot, dependencies);
  if (add.code !== 0) {
    return { git: { action: 'initialized', committed: false }, warnings: ['GIT_COMMIT_FAILED'] };
  }

  const commit = await runGit(
    ['-c', 'user.useConfigOnly=true', 'commit', '-m', input.commitMessage],
    projectRoot,
    dependencies,
  );
  if (commit.code !== 0) {
    return { git: { action: 'initialized', committed: false }, warnings: ['GIT_COMMIT_FAILED'] };
  }

  const head = await runGit(['rev-parse', 'HEAD'], projectRoot, dependencies);
  const commitSha = head.code === 0 ? head.stdout.trim() : '';
  return {
    git: { action: 'initialized', committed: true, ...(commitSha ? { commitSha } : {}) },
    warnings: [],
  };
}
