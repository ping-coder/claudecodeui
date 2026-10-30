import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectTemplate } from '@/modules/project-templates/index.js';
import { resolveProjectTemplateAssetPath } from '@/modules/project-templates/project-template.registry.js';
import { applyProjectTemplate } from '@/modules/project-templates/services/project-template-apply.service.js';
import type { ProjectTemplateDefinition } from '@/shared/types.js';

const codingTemplate = resolveProjectTemplate('coding') as ProjectTemplateDefinition;
const codingTargets = codingTemplate.files.map((file) => file.target);
const silentDependencies = { fileSystem: fs, logError: () => undefined };

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'project-template-apply-'));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readTargets(projectRoot: string): Promise<Map<string, Buffer>> {
  const contents = new Map<string, Buffer>();
  for (const target of codingTargets) {
    contents.set(target, await fs.readFile(path.join(projectRoot, target)));
  }
  return contents;
}

function apply(projectRoot: string, locale: string | null = 'en', projectName = 'my-app') {
  return applyProjectTemplate({ projectRoot, template: codingTemplate, locale, projectName }, silentDependencies);
}

test('a fresh directory gets every file with the project name and LF endings', async () => {
  await withTempDirectory(async (projectRoot) => {
    const result = await apply(projectRoot);

    assert.deepEqual(result, { created: codingTargets, skipped: [], warnings: [] });
    const tasks = await fs.readFile(path.join(projectRoot, 'TASKS.md'), 'utf8');
    const claude = await fs.readFile(path.join(projectRoot, 'CLAUDE.md'), 'utf8');
    assert.equal(tasks.split('\n')[0], '# my-app tasks');
    assert.equal(claude.split('\n')[0], '# my-app');
    for (const target of codingTargets) {
      const content = await fs.readFile(path.join(projectRoot, target), 'utf8');
      assert.equal(content.includes('\r'), false, `${target} has CR characters`);
      assert.equal(content.includes('{{projectName}}'), false, `${target} kept a placeholder`);
    }
  });
});

test('the interface language picks the asset folder: zh* gets zh-CN, anything else en', async () => {
  for (const [locale, heading] of [
    ['zh-CN', '# demo 任务清单'],
    ['zh-TW', '# demo 任务清单'],
    ['fr', '# demo tasks'],
    [null, '# demo tasks'],
  ] as const) {
    await withTempDirectory(async (projectRoot) => {
      await apply(projectRoot, locale, 'demo');
      const tasks = await fs.readFile(path.join(projectRoot, 'TASKS.md'), 'utf8');
      assert.equal(tasks.split('\n')[0], heading, `locale ${String(locale)}`);
    });
  }
});

test('the project name is inserted literally on one line', async () => {
  await withTempDirectory(async (projectRoot) => {
    await apply(projectRoot, 'en', 'Price $& \n tracker');
    const claude = await fs.readFile(path.join(projectRoot, 'CLAUDE.md'), 'utf8');
    assert.equal(claude.split('\n')[0], '# Price $& tracker');
  });
});

test('a second run skips everything and leaves every byte as it was', async () => {
  await withTempDirectory(async (projectRoot) => {
    await apply(projectRoot);
    const before = await readTargets(projectRoot);

    const second = await apply(projectRoot);

    assert.deepEqual(second.created, []);
    assert.deepEqual(second.warnings, []);
    assert.deepEqual(second.skipped, [
      { path: 'TASKS.md', reason: 'exists' },
      { path: 'CLAUDE.md', reason: 'exists' },
      { path: '.gitignore', reason: 'exists' },
      { path: '.claude/skills/task-runner/SKILL.md', reason: 'group-exists' },
      { path: '.claude/skills/issue/SKILL.md', reason: 'group-exists' },
    ]);
    const after = await readTargets(projectRoot);
    for (const target of codingTargets) {
      assert.equal(Buffer.compare(before.get(target) as Buffer, after.get(target) as Buffer), 0, target);
    }
  });
});

test('existing TASKS.md, CLAUDE.md and .gitignore are left untouched', async () => {
  await withTempDirectory(async (projectRoot) => {
    await fs.writeFile(path.join(projectRoot, 'TASKS.md'), 'mine\r\n');
    await fs.writeFile(path.join(projectRoot, 'CLAUDE.md'), 'my rules');
    await fs.writeFile(path.join(projectRoot, '.gitignore'), 'target/\n');

    const result = await apply(projectRoot);

    assert.deepEqual(result.created, ['.claude/skills/task-runner/SKILL.md', '.claude/skills/issue/SKILL.md']);
    assert.equal(await fs.readFile(path.join(projectRoot, 'TASKS.md'), 'utf8'), 'mine\r\n');
    assert.equal(await fs.readFile(path.join(projectRoot, 'CLAUDE.md'), 'utf8'), 'my rules');
    assert.equal(await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8'), 'target/\n');
  });
});

test('a skill folder that already exists skips the whole skill', async () => {
  await withTempDirectory(async (projectRoot) => {
    const userSkill = path.join(projectRoot, '.claude', 'skills', 'task-runner');
    await fs.mkdir(userSkill, { recursive: true });
    await fs.writeFile(path.join(userSkill, 'notes.md'), 'my own skill');

    const result = await apply(projectRoot);

    assert.deepEqual(result.skipped, [{ path: '.claude/skills/task-runner/SKILL.md', reason: 'group-exists' }]);
    assert.ok(result.created.includes('.claude/skills/issue/SKILL.md'));
    assert.deepEqual(await fs.readdir(userSkill), ['notes.md']);
  });
});

test('a .claude symlink pointing outside the project gets nothing written through it', async () => {
  await withTempDirectory(async (sandbox) => {
    const projectRoot = path.join(sandbox, 'project');
    const outside = path.join(sandbox, 'outside');
    await fs.mkdir(projectRoot);
    await fs.mkdir(path.join(outside, 'skills'), { recursive: true });
    await fs.symlink(outside, path.join(projectRoot, '.claude'), 'dir');

    const result = await apply(projectRoot);

    assert.deepEqual(result.created, ['TASKS.md', 'CLAUDE.md', '.gitignore']);
    assert.deepEqual(result.skipped, [
      { path: '.claude/skills/task-runner/SKILL.md', reason: 'unsafe-path' },
      { path: '.claude/skills/issue/SKILL.md', reason: 'unsafe-path' },
    ]);
    assert.deepEqual(await fs.readdir(path.join(outside, 'skills')), []);
  });
});

test('a symlinked target file is skipped and its outside target is not created', async () => {
  await withTempDirectory(async (sandbox) => {
    const projectRoot = path.join(sandbox, 'project');
    const outsideFile = path.join(sandbox, 'outside-tasks.md');
    await fs.mkdir(projectRoot);
    await fs.symlink(outsideFile, path.join(projectRoot, 'TASKS.md'));

    const result = await apply(projectRoot);

    assert.deepEqual(result.skipped, [{ path: 'TASKS.md', reason: 'exists' }]);
    assert.equal(await pathExists(outsideFile), false);
  });
});

test('an unexpected failure creating a file removes only what this run created and reports a warning', async () => {
  await withTempDirectory(async (projectRoot) => {
    await fs.writeFile(path.join(projectRoot, 'CLAUDE.md'), 'my rules');
    let opens = 0;
    const failingFileSystem = {
      ...fs,
      open: (async (...args: Parameters<typeof fs.open>) => {
        opens += 1;
        // TASKS.md, CLAUDE.md (exists), .gitignore, then the first skill file fails.
        if (opens === 4) {
          throw Object.assign(new Error('disk on fire'), { code: 'EIO' });
        }
        return fs.open(...args);
      }) as typeof fs.open,
    };

    const result = await applyProjectTemplate(
      { projectRoot, template: codingTemplate, locale: 'en', projectName: 'my-app' },
      { fileSystem: failingFileSystem, logError: () => undefined },
    );

    assert.deepEqual(result.created, []);
    assert.deepEqual(result.warnings, ['TEMPLATE_APPLY_FAILED']);
    assert.deepEqual((await fs.readdir(projectRoot)).sort(), ['CLAUDE.md']);
    assert.equal(await fs.readFile(path.join(projectRoot, 'CLAUDE.md'), 'utf8'), 'my rules');
  });
});

test('a write that fails after the file was created removes the half-written file too', async () => {
  await withTempDirectory(async (projectRoot) => {
    const skillPath = path.join(projectRoot, '.claude', 'skills', 'task-runner', 'SKILL.md');
    // Like a full disk: the file is created, part of the content lands, then the write fails.
    const failingFileSystem = {
      ...fs,
      open: (async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args);
        if (args[0] === skillPath) {
          const writeFile = handle.writeFile.bind(handle);
          handle.writeFile = (async (data: string) => {
            await writeFile(data.slice(0, 100), 'utf8');
            throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
          }) as typeof handle.writeFile;
        }
        return handle;
      }) as typeof fs.open,
    };

    const result = await applyProjectTemplate(
      { projectRoot, template: codingTemplate, locale: 'en', projectName: 'my-app' },
      { fileSystem: failingFileSystem, logError: () => undefined },
    );

    assert.deepEqual(result.created, []);
    assert.deepEqual(result.warnings, ['TEMPLATE_APPLY_FAILED']);
    assert.equal(await pathExists(skillPath), false);
    assert.deepEqual(await fs.readdir(projectRoot), []);

    // Nothing half-written is left to be skipped, so the next run writes the whole skill.
    const retry = await apply(projectRoot);
    assert.deepEqual(retry, { created: codingTargets, skipped: [], warnings: [] });
    const asset = await fs.readFile(
      resolveProjectTemplateAssetPath('coding', 'en', 'skills/task-runner/SKILL.md.tpl'),
      'utf8',
    );
    assert.equal(await fs.readFile(skillPath, 'utf8'), asset.replace(/\r\n?/g, '\n'));
  });
});
