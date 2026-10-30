import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { listProjectTemplates, resolveProjectTemplate } from '@/modules/project-templates/index.js';
import { resolveProjectTemplateAssetPath } from '@/modules/project-templates/project-template.registry.js';
import type { ProjectTemplateDefinition } from '@/shared/types.js';
import {
  AppError,
  findApplicationRoot,
  findServerRoot,
  getModuleDirectory,
  readProviderSkillMarkdownDefinitionFromContent,
} from '@/shared/utils.js';

const execFileAsync = promisify(execFile);
const templatesRoot = path.join(
  findServerRoot(getModuleDirectory(import.meta.url)),
  'modules',
  'project-templates',
  'templates',
);

function templateDefinitions(): ProjectTemplateDefinition[] {
  return listProjectTemplates()
    .map((summary) => resolveProjectTemplate(summary.id))
    .filter((template): template is ProjectTemplateDefinition => template !== null);
}

async function listFilesRecursively(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursively(entryPath));
    } else {
      files.push(entryPath);
    }
  }
  return files;
}

test('template ids are unique and Blank comes first with nothing to write', () => {
  const summaries = listProjectTemplates();
  const ids = summaries.map((summary) => summary.id);

  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids[0], 'blank');
  assert.deepEqual(summaries[0], { id: 'blank', files: [], skills: [], git: { init: false, clone: true } });
  assert.equal(resolveProjectTemplate('blank'), null);
  assert.equal(resolveProjectTemplate(undefined), null);
  assert.equal(resolveProjectTemplate(''), null);
});

test('the coding summary lists its files, skills and both git sources', () => {
  const coding = listProjectTemplates().find((summary) => summary.id === 'coding');

  assert.deepEqual(coding, {
    id: 'coding',
    files: [
      'TASKS.md',
      'CLAUDE.md',
      '.gitignore',
      '.claude/skills/task-runner/SKILL.md',
      '.claude/skills/issue/SKILL.md',
    ],
    skills: ['task-runner', 'issue'],
    git: { init: true, clone: true },
  });
});

test('an unknown template id is a 400 UNKNOWN_PROJECT_TEMPLATE', () => {
  assert.throws(
    () => resolveProjectTemplate('no-such-template'),
    (error: unknown) => error instanceof AppError
      && error.code === 'UNKNOWN_PROJECT_TEMPLATE'
      && error.statusCode === 400,
  );
});

test('every source of every locale exists where the server reads it at runtime', async () => {
  for (const template of templateDefinitions()) {
    assert.ok(template.locales.includes(template.defaultLocale), `${template.id} default locale has no assets`);
    for (const locale of template.locales) {
      for (const file of template.files) {
        await access(resolveProjectTemplateAssetPath(template.id, locale, file.source));
      }
    }
  }
});

test('every target is a safe relative path and every group contains its files', () => {
  for (const template of templateDefinitions()) {
    for (const file of template.files) {
      assert.ok(!path.posix.isAbsolute(file.target) && !path.win32.isAbsolute(file.target), file.target);
      assert.ok(!file.target.includes('\\'), file.target);
      assert.ok(
        file.target.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
        file.target,
      );
      if (file.group) {
        assert.ok(file.target.startsWith(`${file.group}/`), `${file.target} is outside group ${file.group}`);
      }
    }
  }
});

test('asset names survive npm packing and the repository .gitignore', async (t) => {
  const assetFiles = await listFilesRecursively(templatesRoot);
  assert.ok(assetFiles.length > 0);

  for (const assetFile of assetFiles) {
    const baseName = path.basename(assetFile);
    assert.ok(baseName.endsWith('.tpl'), `${baseName} must use a .tpl name`);
    assert.ok(!['.gitignore', '.npmignore', '.npmrc'].includes(baseName), `${baseName} would be dropped by npm`);
  }

  const repositoryRoot = findApplicationRoot(getModuleDirectory(import.meta.url));
  try {
    await execFileAsync('git', ['-C', repositoryRoot, 'rev-parse', '--git-dir']);
  } catch {
    t.skip('not running from a git checkout');
    return;
  }

  // Exit code 1 means no path is ignored; 0 means at least one is.
  let ignoredOutput = '';
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repositoryRoot, 'check-ignore', '--no-index', '--', ...assetFiles],
    );
    ignoredOutput = stdout;
  } catch (error) {
    const exitCode = (error as { code?: number }).code;
    assert.equal(exitCode, 1, `git check-ignore failed: ${String(error)}`);
  }
  assert.equal(ignoredOutput.trim(), '', `ignored by the repository: ${ignoredOutput}`);
});

test('every skill parses with the providers\' frontmatter reader and is named after its folder', async () => {
  for (const template of templateDefinitions()) {
    const skillFiles = template.files.filter((file) => file.target.endsWith('/SKILL.md'));
    assert.deepEqual(
      skillFiles.map((file) => path.posix.basename(path.posix.dirname(file.target))),
      template.skills,
      `${template.id} skills list does not match its SKILL.md files`,
    );

    for (const locale of template.locales) {
      for (const file of skillFiles) {
        const folderName = path.posix.basename(path.posix.dirname(file.target));
        const content = await readFile(resolveProjectTemplateAssetPath(template.id, locale, file.source), 'utf8');
        // The sentinel fallback makes a missing `name` fail instead of borrowing the folder name.
        const definition = readProviderSkillMarkdownDefinitionFromContent(content, '<missing name>');

        assert.equal(definition.name, folderName, `${locale}/${file.source}`);
        assert.ok(definition.description.length > 0, `${locale}/${file.source} has no description`);
      }
    }
  }
});
