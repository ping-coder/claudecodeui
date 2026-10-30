import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import spawn from 'cross-spawn';

import { initializeTemplateGitRepository } from '@/modules/project-templates/services/project-template-git.service.js';

const execFileAsync = promisify(execFile);

// Real git, isolated from the developer's setup: GIT_CONFIG_GLOBAL points at a
// file each test fills (or leaves empty for "no identity"), system config is
// off, and identity variables that would bypass the config are cleared.
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'project-template-git-'));
const gitConfigPath = path.join(fixtureRoot, 'gitconfig');
const identityVariables = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL'];
const savedEnvironment = Object.fromEntries(
  ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', ...identityVariables].map((name) => [name, process.env[name]]),
);
process.env.GIT_CONFIG_GLOBAL = gitConfigPath;
process.env.GIT_CONFIG_NOSYSTEM = '1';
for (const name of identityVariables) {
  delete process.env[name];
}

process.on('exit', () => {
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

const templateFiles = ['TASKS.md', 'CLAUDE.md', '.claude/skills/task-runner/SKILL.md'];
const commitMessage = 'Initial commit from the coding template';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function setIdentity(configured: boolean): Promise<void> {
  await writeFile(
    gitConfigPath,
    configured ? '[user]\n\tname = Template Test\n\temail = template@example.test\n' : '',
  );
}

async function withProject(run: (projectRoot: string, sandbox: string) => Promise<void>): Promise<void> {
  const sandbox = await mkdtemp(path.join(fixtureRoot, 'case-'));
  const projectRoot = path.join(sandbox, 'project');
  await mkdir(path.join(projectRoot, '.claude', 'skills', 'task-runner'), { recursive: true });
  for (const file of templateFiles) {
    await writeFile(path.join(projectRoot, file), `${file}\n`);
  }
  // Something the user already had; it must stay out of the initial commit.
  await writeFile(path.join(projectRoot, 'secrets.env'), 'TOKEN=1\n');
  try {
    await run(projectRoot, sandbox);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

test('a new repository is initialized on main and commits only the template files', async () => {
  await setIdentity(true);
  await withProject(async (projectRoot) => {
    const outcome = await initializeTemplateGitRepository({ projectRoot, files: templateFiles, commitMessage });

    assert.deepEqual(outcome.warnings, []);
    assert.equal(outcome.git.action, 'initialized');
    assert.equal(outcome.git.committed, true);
    assert.equal(outcome.git.commitSha, await git(projectRoot, 'rev-parse', 'HEAD'));
    assert.equal(await git(projectRoot, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(await git(projectRoot, 'log', '-1', '--format=%s'), commitMessage);
    assert.deepEqual(
      (await git(projectRoot, 'ls-tree', '-r', '--name-only', 'HEAD')).split('\n').sort(),
      [...templateFiles].sort(),
    );
    assert.equal(await git(projectRoot, 'status', '--porcelain'), '?? secrets.env');
  });
});

test('a folder that is already a repository is left alone', async () => {
  await setIdentity(true);
  await withProject(async (projectRoot) => {
    await git(projectRoot, 'init', '-q');

    const outcome = await initializeTemplateGitRepository({ projectRoot, files: templateFiles, commitMessage });

    assert.deepEqual(outcome, { git: { action: 'already-repository', committed: false }, warnings: [] });
    await assert.rejects(git(projectRoot, 'rev-parse', '--verify', 'HEAD'), 'no commit may be made');
  });
});

test('a folder inside another repository is not initialized and gets a warning', async () => {
  await setIdentity(true);
  await withProject(async (projectRoot, sandbox) => {
    await git(sandbox, 'init', '-q');

    const outcome = await initializeTemplateGitRepository({ projectRoot, files: templateFiles, commitMessage });

    assert.deepEqual(outcome, {
      git: { action: 'inside-parent-repository', committed: false },
      warnings: ['INSIDE_PARENT_REPOSITORY'],
    });
    assert.equal(fs.existsSync(path.join(projectRoot, '.git')), false);
  });
});

// rev-parse fails in these parents instead of printing their top level; init
// must still not nest a repository inside them.
const unreadableParents: {
  name: string;
  setUp: (sandbox: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}[] = [
  {
    name: 'uses a repository extension this git does not know',
    setUp: async (sandbox) => {
      await git(sandbox, 'init', '-q');
      await git(sandbox, 'config', 'core.repositoryformatversion', '1');
      await git(sandbox, 'config', 'extensions.cloudcliUnknownExtension', 'true');
    },
  },
  {
    // A Docker volume owned by the host user while the server runs as another one.
    name: 'is owned by another user',
    setUp: async (sandbox) => {
      await git(sandbox, 'init', '-q');
    },
    env: { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' },
  },
  {
    name: 'has a .git file pointing at a missing repository',
    setUp: async (sandbox) => {
      await writeFile(path.join(sandbox, '.git'), `gitdir: ${path.join(sandbox, 'moved-away')}\n`);
    },
  },
];

for (const parent of unreadableParents) {
  test(`a folder inside a repository that ${parent.name} is not initialized`, async () => {
    await setIdentity(true);
    await withProject(async (projectRoot, sandbox) => {
      await parent.setUp(sandbox);

      const outcome = await initializeTemplateGitRepository(
        { projectRoot, files: templateFiles, commitMessage },
        parent.env
          ? {
            spawnGit: (args, cwd) =>
              spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...parent.env } }),
          }
          : undefined,
      );

      assert.deepEqual(outcome, {
        git: { action: 'inside-parent-repository', committed: false },
        warnings: ['INSIDE_PARENT_REPOSITORY'],
      });
      assert.equal(fs.existsSync(path.join(projectRoot, '.git')), false);
    });
  });
}

test('a folder git cannot place, with no .git above, is not initialized and reports GIT_INIT_FAILED', async () => {
  await setIdentity(true);
  await withProject(async (projectRoot, sandbox) => {
    // Inside a bare repository rev-parse says it needs a work tree, not that no repository exists.
    await git(sandbox, 'init', '-q', '--bare');

    const outcome = await initializeTemplateGitRepository({ projectRoot, files: templateFiles, commitMessage });

    assert.deepEqual(outcome, { git: { action: 'none', committed: false }, warnings: ['GIT_INIT_FAILED'] });
    assert.equal(fs.existsSync(path.join(projectRoot, '.git')), false);
  });
});

test('without a git identity the repository exists, nothing is committed and a warning says why', async () => {
  await setIdentity(false);
  await withProject(async (projectRoot) => {
    const outcome = await initializeTemplateGitRepository({ projectRoot, files: templateFiles, commitMessage });

    assert.deepEqual(outcome, {
      git: { action: 'initialized', committed: false },
      warnings: ['GIT_IDENTITY_MISSING'],
    });
    assert.equal(fs.existsSync(path.join(projectRoot, '.git')), true);
    await assert.rejects(git(projectRoot, 'rev-parse', '--verify', 'HEAD'));
    for (const file of templateFiles) {
      assert.equal(fs.existsSync(path.join(projectRoot, file)), true, file);
    }
  });
});

test('git that cannot be started is reported as GIT_NOT_FOUND', async () => {
  await setIdentity(true);
  await withProject(async (projectRoot) => {
    const outcome = await initializeTemplateGitRepository(
      { projectRoot, files: templateFiles, commitMessage },
      {
        spawnGit: (args, cwd) => spawn('cloudcli-no-such-git-binary', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }),
      },
    );

    assert.deepEqual(outcome, { git: { action: 'none', committed: false }, warnings: ['GIT_NOT_FOUND'] });
  });
});

test('git without --initial-branch still ends up on main', async () => {
  await setIdentity(true);
  await withProject(async (projectRoot) => {
    const seenInitArgs: string[][] = [];
    const outcome = await initializeTemplateGitRepository(
      { projectRoot, files: templateFiles, commitMessage },
      {
        spawnGit: (args, cwd) => {
          if (args[0] === 'init') {
            seenInitArgs.push(args);
          }
          // Old git rejects the option the way any git rejects an unknown one.
          const effectiveArgs = args[0] === 'init' && args.includes('--initial-branch=main')
            ? ['init', '--cloudcli-unknown-option']
            : args;
          return spawn('git', effectiveArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        },
      },
    );

    assert.deepEqual(seenInitArgs, [['init', '--initial-branch=main'], ['init']]);
    assert.equal(outcome.git.committed, true);
    assert.equal(await git(projectRoot, 'symbolic-ref', '--short', 'HEAD'), 'main');
  });
});
