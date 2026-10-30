import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { resolveProjectTemplateAssetPath } from '@/modules/project-templates/project-template.registry.js';
import type {
  ProjectTemplateApplyResult,
  ProjectTemplateDefinition,
  ProjectTemplateFile,
  ProjectTemplateSkipReason,
} from '@/shared/types.js';

type ApplyProjectTemplateInput = {
  projectRoot: string;
  template: ProjectTemplateDefinition;
  locale?: string | null;
  projectName: string;
};

type ApplyProjectTemplateDependencies = {
  fileSystem: Pick<typeof fs, 'lstat' | 'mkdir' | 'open' | 'readFile' | 'realpath' | 'rmdir' | 'unlink'>;
  logError: (message: string, error: unknown) => void;
};

const defaultDependencies: ApplyProjectTemplateDependencies = {
  fileSystem: fs,
  logError: (message: string, error: unknown): void => {
    console.error(message, error);
  },
};

/** Paths created by one run, so an unexpected failure can remove exactly those. */
type CreatedPaths = {
  files: string[];
  directories: string[];
};

/** Interface language to asset folder: any Chinese variant gets zh-CN, everything else en. */
function resolveTemplateLocale(template: ProjectTemplateDefinition, requestedLocale: string | null | undefined): string {
  const preferredLocale = typeof requestedLocale === 'string' && /^zh/i.test(requestedLocale.trim()) ? 'zh-CN' : 'en';
  return template.locales.includes(preferredLocale) ? preferredLocale : template.defaultLocale;
}

/** A registry target must be a plain relative POSIX path that stays inside the project. */
function isSafeRelativeTarget(target: string): boolean {
  if (!target || target.includes('\\') || path.posix.isAbsolute(target) || path.win32.isAbsolute(target)) {
    return false;
  }

  return target.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${path.sep}`);
}

function readErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function renderTemplateContent(content: string, file: ProjectTemplateFile, projectName: string): string {
  const withLineFeeds = content.replace(/\r\n?/g, '\n');
  // A function replacement keeps `$&` and friends in a project name literal.
  return file.render ? withLineFeeds.replaceAll('{{projectName}}', () => projectName) : withLineFeeds;
}

/**
 * Walks the directories of `relativeDirectory` below the project root one level
 * at a time. A symlink anywhere on the way, or a directory whose real path
 * leaves the project, makes the path unsafe: a cloned repository can link
 * `.claude` to somewhere like ~/.ssh. A file where a directory should be means
 * the path is taken. Missing directories are created when `createMissing` is
 * set; otherwise the walk stops at the first missing one, since nothing below
 * it can exist.
 */
async function prepareDirectoryChain(
  projectRoot: string,
  rootRealPath: string,
  relativeDirectory: string,
  createMissing: boolean,
  createdPaths: CreatedPaths,
  fileSystem: ApplyProjectTemplateDependencies['fileSystem'],
): Promise<ProjectTemplateSkipReason | null> {
  if (relativeDirectory === '.' || relativeDirectory === '') {
    return null;
  }

  let currentPath = projectRoot;
  for (const segment of relativeDirectory.split('/')) {
    currentPath = path.join(currentPath, segment);

    let stats;
    try {
      stats = await fileSystem.lstat(currentPath);
    } catch (error) {
      if (readErrorCode(error) !== 'ENOENT') {
        throw error;
      }
      if (!createMissing) {
        return null;
      }
      await fileSystem.mkdir(currentPath);
      createdPaths.directories.push(currentPath);
      continue;
    }

    if (stats.isSymbolicLink()) {
      return 'unsafe-path';
    }
    if (!stats.isDirectory()) {
      return 'exists';
    }
    if (!isWithinRoot(await fileSystem.realpath(currentPath), rootRealPath)) {
      return 'unsafe-path';
    }
  }

  return null;
}

/**
 * Decides once per group whether its files may be written: the group directory
 * (a skill folder) must not exist yet, so a template never mixes its files into
 * a skill the user already has.
 */
async function checkGroupDirectory(
  projectRoot: string,
  rootRealPath: string,
  group: string,
  createdPaths: CreatedPaths,
  fileSystem: ApplyProjectTemplateDependencies['fileSystem'],
): Promise<ProjectTemplateSkipReason | null> {
  if (!isSafeRelativeTarget(group)) {
    return 'unsafe-path';
  }

  const parentReason = await prepareDirectoryChain(
    projectRoot,
    rootRealPath,
    path.posix.dirname(group),
    false,
    createdPaths,
    fileSystem,
  );
  if (parentReason) {
    return parentReason;
  }

  try {
    const stats = await fileSystem.lstat(path.join(projectRoot, group));
    return stats.isSymbolicLink() ? 'unsafe-path' : 'group-exists';
  } catch (error) {
    if (readErrorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function removeCreatedPaths(
  createdPaths: CreatedPaths,
  fileSystem: ApplyProjectTemplateDependencies['fileSystem'],
): Promise<void> {
  for (const filePath of [...createdPaths.files].reverse()) {
    await fileSystem.unlink(filePath).catch(() => undefined);
  }
  // rmdir only removes empty directories, so anything someone else put there stays.
  for (const directoryPath of [...createdPaths.directories].reverse()) {
    await fileSystem.rmdir(directoryPath).catch(() => undefined);
  }
}

/**
 * Writes a template's files into an existing project directory. Used by the
 * projects module after a project is created or a repository is cloned.
 *
 * Nothing that exists is ever overwritten: each file is opened with `wx`, so an
 * existing file (or symlink) is reported as skipped `exists`. Files that share
 * a group are skipped together when the group directory already exists, and
 * paths through a symlink or outside the project are skipped `unsafe-path`.
 * Running it again on the same directory changes nothing. Content is written
 * with LF line endings and only `{{projectName}}` is substituted.
 *
 * It does not throw for I/O problems: on an unexpected error it removes only
 * the files (including one whose write failed partway) and directories this
 * run created and reports `TEMPLATE_APPLY_FAILED`, so the project that already
 * exists stays usable.
 */
export async function applyProjectTemplate(
  input: ApplyProjectTemplateInput,
  dependencies: ApplyProjectTemplateDependencies = defaultDependencies,
): Promise<ProjectTemplateApplyResult> {
  const { fileSystem } = dependencies;
  const result: ProjectTemplateApplyResult = { created: [], skipped: [], warnings: [] };
  const createdPaths: CreatedPaths = { files: [], directories: [] };
  const projectName = input.projectName.replace(/\s+/g, ' ').trim() || path.basename(input.projectRoot);

  try {
    const locale = resolveTemplateLocale(input.template, input.locale);
    // Read every asset before writing anything, so a missing one leaves the project untouched.
    const contents = await Promise.all(
      input.template.files.map(async (file) => renderTemplateContent(
        await fileSystem.readFile(resolveProjectTemplateAssetPath(input.template.id, locale, file.source), 'utf8'),
        file,
        projectName,
      )),
    );
    const rootRealPath = await fileSystem.realpath(input.projectRoot);
    const groupDecisions = new Map<string, ProjectTemplateSkipReason | null>();

    for (const [index, file] of input.template.files.entries()) {
      if (!isSafeRelativeTarget(file.target)) {
        result.skipped.push({ path: file.target, reason: 'unsafe-path' });
        continue;
      }

      if (file.group) {
        if (!groupDecisions.has(file.group)) {
          groupDecisions.set(
            file.group,
            await checkGroupDirectory(input.projectRoot, rootRealPath, file.group, createdPaths, fileSystem),
          );
        }
        const groupReason = groupDecisions.get(file.group);
        if (groupReason) {
          result.skipped.push({ path: file.target, reason: groupReason });
          continue;
        }
      }

      const directoryReason = await prepareDirectoryChain(
        input.projectRoot,
        rootRealPath,
        path.posix.dirname(file.target),
        true,
        createdPaths,
        fileSystem,
      );
      if (directoryReason) {
        result.skipped.push({ path: file.target, reason: directoryReason });
        continue;
      }

      const targetPath = path.join(input.projectRoot, file.target);
      let handle: FileHandle;
      try {
        handle = await fileSystem.open(targetPath, 'wx');
      } catch (error) {
        if (readErrorCode(error) === 'EEXIST') {
          result.skipped.push({ path: file.target, reason: 'exists' });
          continue;
        }
        throw error;
      }
      // The file exists from here on, so a write that fails partway (a full
      // disk, a quota) gets the truncated file rolled back too.
      createdPaths.files.push(targetPath);
      try {
        await handle.writeFile(contents[index], 'utf8');
      } finally {
        await handle.close();
      }
      result.created.push(file.target);
    }
  } catch (error) {
    dependencies.logError('Failed to apply project template:', error);
    await removeCreatedPaths(createdPaths, fileSystem);
    return { created: [], skipped: result.skipped, warnings: ['TEMPLATE_APPLY_FAILED'] };
  }

  return result;
}
