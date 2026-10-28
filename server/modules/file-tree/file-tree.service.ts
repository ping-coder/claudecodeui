import path from 'node:path';

import ignore from 'ignore';

import { createFileSearchScorer } from '@/modules/file-tree/file-search-score.service.js';
import type {
  FileTreeDirectoryEntry,
  FileTreeNode,
  FileTreeSearchMatch,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeUploadedFile,
} from '@/shared/types.js';
import {
  AppError,
  FORBIDDEN_WORKSPACE_PATHS,
  normalizeProjectPath,
  resolvePathUnderRoots,
} from '@/shared/utils.js';

const HARD_EXCLUDED_DIRECTORY_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg',
]);

const IGNORED_DIRECTORY_NAMES = new Set([
  ...HARD_EXCLUDED_DIRECTORY_NAMES,
  'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
  'target', 'vendor',
  '.gradle', '.idea', 'coverage', '.nyc_output',
]);

// OS clutter that a .gitignore usually lists. It stays hidden even when
// ignored entries are marked, or macOS would add a greyed row to almost every
// directory.
const QUIET_IGNORED_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db']);

const COMMON_WORKSPACE_DIRECTORY_NAMES = [
  'Desktop',
  'Documents',
  'Projects',
  'Development',
  'Dev',
  'Code',
  'workspace',
];

// File Tree consumes this guard when recursively listing a project so a very
// broad workspace (for example, a user's home directory) cannot exhaust the
// server heap before the browser has a chance to switch to a narrower project.
const MAXIMUM_FILE_TREE_ENTRIES = 10_000;

// Gitignored entries listed in mark mode draw on their own budget. Running out
// of it drops the rest silently instead of failing with a 413, so marking them
// can never make a project that lists today too large to open.
const MAXIMUM_IGNORED_FILE_TREE_ENTRIES = 2_000;

// How many levels below the root a project listing walks; the project file
// search walks as deep, so it finds the files the listing would hold.
const MAXIMUM_PROJECT_TREE_DEPTH = 10;

// The project file search reads at most this many directory entries, hidden
// ones included, and stops after this long. It keeps only the best matches
// rather than the tree, so it can afford ten times the listing's entries.
const MAXIMUM_FILE_SEARCH_ENTRIES = 100_000;
const FILE_SEARCH_TIME_LIMIT_MS = 2_000;

// How long the project file search works at a stretch before it lets the rest
// of the server run, which is also when it hears that its request was aborted.
const FILE_SEARCH_SLICE_MS = 10;

// Most matches one search returns; the command palette renders at most 100.
const MAXIMUM_FILE_SEARCH_RESULTS = 200;

// `visible` entries are listed and walked, `ignored` ones are listed but never
// walked, `hidden` ones are left out of the tree entirely.
type FileTreeEntryVisibility = 'visible' | 'ignored' | 'hidden';

type FileTreeEntryFilter = (entryPath: string, isDirectory: boolean) => FileTreeEntryVisibility;

// What is left of each budget. One object is shared by every branch of a walk,
// so the caps apply to the whole tree rather than per directory.
type FileTreeEntryBudget = { visible: number; ignored: number };

// One project file search in progress, shared by all of its directory reads:
// what is left of its entry budget, when it has to stop, whether it has
// stopped early, which makes its result incomplete, and when its current
// slice of work ends (see waitForNextSlice).
type FileSearchWalk = {
  remainingEntries: number;
  deadline: number;
  signal?: AbortSignal;
  stoppedEarly: boolean;
  sliceEnd: number;
  nextSlice: Promise<void> | null;
};

// A directory the search has yet to read, and its path from the project root.
type FileSearchDirectory = { path: string; relativePath: string };

// An entry of a directory the search read, as the listing would show it.
type FileSearchEntry = { name: string; isDirectory: boolean; isIgnored: boolean };

// A match and what ranks it: the score, then the order the palette breaks ties
// in, which is its listing order: shallowest first, then by the position of
// the directory in its level, then by the file's name, as a listing orders the
// files of a directory.
type RankedFileSearchMatch = {
  match: FileTreeSearchMatch;
  score: number;
  depth: number;
  directoryIndex: number;
};

function includeEntryByHardExclusions(entryPath: string, isDirectory: boolean): FileTreeEntryVisibility {
  return isDirectory && HARD_EXCLUDED_DIRECTORY_NAMES.has(path.basename(entryPath)) ? 'hidden' : 'visible';
}

// IGNORED_DIRECTORY_NAMES includes the hard exclusions, so one lookup covers both.
function includeEntryByFallbackDirectoryNames(entryPath: string, isDirectory: boolean): FileTreeEntryVisibility {
  return isDirectory && IGNORED_DIRECTORY_NAMES.has(path.basename(entryPath)) ? 'hidden' : 'visible';
}

// Pseudo-filesystems and other system-critical directories (e.g. /proc, /sys)
// are never walked: they are never valid project roots, and /proc in particular
// can contain thousands of virtual entries that make traversal from a broad
// root (e.g. "/") pathologically slow.
function isForbiddenSystemDirectory(directoryPath: string): boolean {
  return FORBIDDEN_WORKSPACE_PATHS.includes(normalizeProjectPath(directoryPath));
}

// The order a listing shows a directory in: directories first, then by name.
// The project file search ranks equal scores in this order too, because the
// palette breaks ties in listing order.
function compareListingOrder(
  leftIsDirectory: boolean,
  leftName: string,
  rightIsDirectory: boolean,
  rightName: string,
): number {
  if (leftIsDirectory !== rightIsDirectory) {
    return leftIsDirectory ? -1 : 1;
  }
  return leftName.localeCompare(rightName);
}

// Matches are files only, so their names alone give their order in a
// directory: the search never sorts a directory's files.
function compareRankedMatches(left: RankedFileSearchMatch, right: RankedFileSearchMatch): number {
  return right.score - left.score
    || left.depth - right.depth
    || left.directoryIndex - right.directoryIndex
    || compareListingOrder(false, left.match.name, false, right.match.name);
}

function createFileTreeError(message: string, statusCode: number, code: string): AppError {
  return new AppError(message, { statusCode, code });
}

function readErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : null;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function permissionBitsToRwx(permissionBits: number): string {
  const read = permissionBits & 4 ? 'r' : '-';
  const write = permissionBits & 2 ? 'w' : '-';
  const execute = permissionBits & 1 ? 'x' : '-';
  return read + write + execute;
}

function validateFilename(name: string): void {
  if (!name.trim()) {
    throw createFileTreeError('Filename cannot be empty', 400, 'INVALID_FILENAME');
  }

  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) {
    throw createFileTreeError('Filename contains invalid characters', 400, 'INVALID_FILENAME');
  }

  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) {
    throw createFileTreeError('Filename is a reserved name', 400, 'INVALID_FILENAME');
  }

  if (/^\.+$/.test(name)) {
    throw createFileTreeError('Filename cannot be only dots', 400, 'INVALID_FILENAME');
  }
}

function resolvePathInsideProject(projectRoot: string, targetPath: string): string {
  const resolvedPath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(projectRoot, targetPath);
  const normalizedProjectRoot = path.resolve(projectRoot) + path.sep;

  if (!resolvedPath.startsWith(normalizedProjectRoot)) {
    throw createFileTreeError('Path must be under project root', 403, 'PATH_OUTSIDE_PROJECT');
  }

  return resolvedPath;
}

function expandWorkspacePath(workspaceRoot: string, inputPath: string): string {
  if (inputPath === '~') {
    return workspaceRoot;
  }
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(workspaceRoot, inputPath.slice(2));
  }
  return inputPath;
}

function createConcurrencyLimiter(maximumConcurrency: number) {
  let activeOperations = 0;
  const pendingOperations: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (activeOperations < maximumConcurrency) {
      activeOperations += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      pendingOperations.push(resolve);
    });
  }

  function release(): void {
    const nextOperation = pendingOperations.shift();
    if (nextOperation) {
      nextOperation();
      return;
    }

    activeOperations = Math.max(0, activeOperations - 1);
  }

  return { acquire, release };
}

function mapFileSystemError(
  error: unknown,
  messages: Partial<Record<string, { message: string; statusCode: number }>>,
): never {
  const errorCode = readErrorCode(error);
  const mappedError = errorCode ? messages[errorCode] : undefined;
  if (mappedError) {
    throw createFileTreeError(mappedError.message, mappedError.statusCode, errorCode ?? 'FILE_TREE_ERROR');
  }

  throw error;
}

/**
 * Classifies entries against the project root's `.gitignore`.
 *
 * A matching entry is hidden, unless `markIgnored` asks for it to be listed as
 * ignored. Matching build and cache folders and OS clutter stay hidden even
 * then: those rows would bury the few ignored entries worth seeing, such as
 * CLAUDE.md or `.claude/`.
 */
function createGitignoreEntryFilter(
  projectRoot: string,
  gitignoreContent: string,
  markIgnored: boolean,
): FileTreeEntryFilter {
  const gitignore = ignore().add(gitignoreContent);

  return (entryPath, isDirectory) => {
    if (includeEntryByHardExclusions(entryPath, isDirectory) === 'hidden') return 'hidden';

    const relativePath = path.relative(projectRoot, entryPath).split(path.sep).join('/');
    const matchPath = isDirectory ? `${relativePath}/` : relativePath;
    if (!gitignore.ignores(matchPath)) return 'visible';

    const name = path.basename(entryPath);
    const isNoise = isDirectory
      ? IGNORED_DIRECTORY_NAMES.has(name)
      : QUIET_IGNORED_FILE_NAMES.has(name);
    return markIgnored && !isNoise ? 'ignored' : 'hidden';
  };
}

/**
 * Creates File Tree workflows for the module composition root and route tests.
 * Every filesystem, project, workspace, environment, and logging dependency is
 * required explicitly so this service has no machine-wide production defaults.
 */
export function createFileTreeService(dependencies: FileTreeServiceDependencies): FileTreeServices {
  const fileSystem = dependencies.fileSystem;
  const concurrencyLimit = Number.isFinite(dependencies.fileSystemConcurrency)
    && dependencies.fileSystemConcurrency > 0
    ? Math.floor(dependencies.fileSystemConcurrency)
    : 1;
  const { acquire, release } = createConcurrencyLimiter(concurrencyLimit);

  async function resolveProjectRoot(projectId: string): Promise<string> {
    const projectRoot = await dependencies.projects.getProjectPathById(projectId);
    if (!projectRoot) {
      throw createFileTreeError('Project not found', 404, 'PROJECT_NOT_FOUND');
    }
    return projectRoot;
  }

  /**
   * Streams one directory and keeps only the entries the tree will show, each
   * flagged with whether it is listed as gitignored.
   *
   * Entries are filtered and charged against the shared budget one at a time,
   * so a pathologically large directory stops the walk at the cap instead of
   * being read into memory in full first.
   */
  async function collectListedEntries(
    directoryPath: string,
    includeEntry: FileTreeEntryFilter,
    remainingEntries: FileTreeEntryBudget,
  ): Promise<Array<{ entry: FileTreeDirectoryEntry; isIgnored: boolean }>> {
    const listedEntries: Array<{ entry: FileTreeDirectoryEntry; isIgnored: boolean }> = [];

    await acquire();
    try {
      for await (const entry of fileSystem.openDirectory(directoryPath)) {
        const visibility = includeEntry(path.join(directoryPath, entry.name), entry.isDirectory());
        if (visibility === 'hidden') {
          continue;
        }

        if (visibility === 'ignored') {
          // Past this cap ignored entries are dropped, not reported: they are
          // extras, and listing them must never fail a tree that loads today.
          if (remainingEntries.ignored > 0) {
            remainingEntries.ignored -= 1;
            listedEntries.push({ entry, isIgnored: true });
          }
          continue;
        }

        // Charged after visibility filtering so hidden and ignored entries
        // never consume this budget.
        if (remainingEntries.visible <= 0) {
          throw createFileTreeError(
            `Project file tree exceeds the ${MAXIMUM_FILE_TREE_ENTRIES.toLocaleString()} entry limit. Choose a narrower project directory or add ignore rules.`,
            413,
            'FILE_TREE_TOO_LARGE',
          );
        }
        remainingEntries.visible -= 1;
        listedEntries.push({ entry, isIgnored: false });
      }
    } catch (error) {
      // The entry cap is a caller-visible outcome, not an unreadable directory.
      if (error instanceof AppError) {
        throw error;
      }
      const errorCode = readErrorCode(error);
      if (errorCode !== 'EACCES' && errorCode !== 'EPERM') {
        dependencies.logger.error(`Error reading directory "${directoryPath}"`, error);
      }
      return [];
    } finally {
      release();
    }

    return listedEntries;
  }

  async function buildFileTree(
    directoryPath: string,
    maximumDepth: number,
    currentDepth = 0,
    includeEntry: FileTreeEntryFilter = includeEntryByFallbackDirectoryNames,
    remainingEntries: FileTreeEntryBudget = {
      visible: MAXIMUM_FILE_TREE_ENTRIES,
      ignored: MAXIMUM_IGNORED_FILE_TREE_ENTRIES,
    },
  ): Promise<FileTreeNode[]> {
    const listedEntries = await collectListedEntries(directoryPath, includeEntry, remainingEntries);

    const items = await Promise.all(listedEntries.map(async ({ entry, isIgnored }): Promise<FileTreeNode> => {
      const itemPath = path.join(directoryPath, entry.name);
      const item: FileTreeNode = {
        name: entry.name,
        path: itemPath,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: 0,
        modified: null,
        permissions: '000',
        permissionsRwx: '---------',
      };
      if (isIgnored) {
        item.isIgnored = true;
      }

      try {
        await acquire();
        try {
          const stats = await fileSystem.lstat(itemPath);
          const ownerPermissions = (stats.mode >> 6) & 7;
          const groupPermissions = (stats.mode >> 3) & 7;
          const otherPermissions = stats.mode & 7;

          item.size = stats.size;
          item.modified = stats.mtime.toISOString();
          item.permissions = `${ownerPermissions}${groupPermissions}${otherPermissions}`;
          item.permissionsRwx = permissionBitsToRwx(ownerPermissions)
            + permissionBitsToRwx(groupPermissions)
            + permissionBitsToRwx(otherPermissions);
          if (stats.isSymbolicLink()) {
            item.isSymlink = true;
          }
        } finally {
          release();
        }
      } catch {
        // Metadata failures should not hide an otherwise readable tree entry.
      }

      // An ignored directory is listed but never walked: its contents would
      // cost directory reads and budget for rows the explorer does not open.
      if (entry.isDirectory() && !isIgnored && currentDepth < maximumDepth && !isForbiddenSystemDirectory(itemPath)) {
        item.children = await buildFileTree(
          itemPath,
          maximumDepth,
          currentDepth + 1,
          includeEntry,
          remainingEntries,
        );
      }

      return item;
    }));

    return items.sort((left, right) => compareListingOrder(
      left.type === 'directory',
      left.name,
      right.type === 'directory',
      right.name,
    ));
  }

  // Whether the project file search has to stop: it already has, its time is
  // up or its request was aborted.
  function hasFileSearchRunOut(walk: FileSearchWalk): boolean {
    return walk.stoppedEarly || walk.signal?.aborted === true || dependencies.now() >= walk.deadline;
  }

  /**
   * The next slice of the project file search's time, which starts on a later
   * turn of the event loop. The reads of one search share their slices: once
   * one is used up they all wait for the same next one, and each checks the
   * clock again before going on, so however many run at once, the search holds
   * up the rest of the server for one slice of FILE_SEARCH_SLICE_MS at a time.
   * Awaited directly by the code that does the work: returning from an async
   * function in between would let every read pass that check first.
   */
  function waitForNextSlice(walk: FileSearchWalk): Promise<void> {
    walk.nextSlice ??= new Promise<void>((resolve) => {
      setImmediate(resolve);
    }).then(() => {
      walk.nextSlice = null;
      walk.sliceEnd = dependencies.now() + FILE_SEARCH_SLICE_MS;
    });
    return walk.nextSlice;
  }

  /**
   * Reads one directory for the project file search: yields the entries a
   * listing would show, in the order the directory gives them, each flagged
   * with whether it is gitignored.
   *
   * Every entry read is charged to the walk's budget, hidden ones included,
   * since reading is the cost being capped. An entry that arrives once the
   * budget is spent, the deadline has passed or the request was aborted stops
   * the read and marks the walk as stopped early. Before each entry the read
   * waits if the walk has used up its slice (see waitForNextSlice), so the
   * time the caller takes over an entry counts against the slice and the time
   * limit alike. A directory that cannot be read gives nothing, as in a
   * listing; one that fails part way has given the entries before.
   */
  async function* readFileSearchEntries(
    directoryPath: string,
    includeEntry: FileTreeEntryFilter,
    walk: FileSearchWalk,
  ): AsyncGenerator<FileSearchEntry> {
    await acquire();
    try {
      // Checked again once a slot is free: the walk may have run out while
      // this read waited for one.
      if (hasFileSearchRunOut(walk)) {
        walk.stoppedEarly = true;
        return;
      }
      for await (const entry of fileSystem.openDirectory(directoryPath)) {
        while (dependencies.now() >= walk.sliceEnd) {
          await waitForNextSlice(walk);
        }
        if (walk.remainingEntries <= 0 || hasFileSearchRunOut(walk)) {
          walk.stoppedEarly = true;
          break;
        }
        walk.remainingEntries -= 1;
        const isDirectory = entry.isDirectory();
        const visibility = includeEntry(path.join(directoryPath, entry.name), isDirectory);
        if (visibility !== 'hidden') {
          yield { name: entry.name, isDirectory, isIgnored: visibility === 'ignored' };
        }
      }
    } catch (error) {
      // What the caller throws over an entry ends the read without landing here.
      const errorCode = readErrorCode(error);
      if (errorCode !== 'EACCES' && errorCode !== 'EPERM') {
        dependencies.logger.error(`Error reading directory "${directoryPath}"`, error);
      }
    } finally {
      release();
    }
  }

  /**
   * The entry filter of a listing that respects the project root's
   * `.gitignore`, or undefined when there is none, which leaves the listing to
   * the conventional build and cache folder names.
   */
  async function readGitignoreEntryFilter(
    projectRoot: string,
    markIgnored: boolean,
  ): Promise<FileTreeEntryFilter | undefined> {
    try {
      const gitignoreContent = await fileSystem.readTextFile(path.join(projectRoot, '.gitignore'));
      return createGitignoreEntryFilter(projectRoot, gitignoreContent, markIgnored);
    } catch (error) {
      if (readErrorCode(error) !== 'ENOENT') {
        dependencies.logger.error(`Error reading .gitignore in "${projectRoot}"`, error);
      }
      return undefined;
    }
  }

  async function resolveExistingProjectRoot(projectId: string): Promise<string> {
    const projectRoot = await resolveProjectRoot(projectId);
    try {
      await fileSystem.access(projectRoot);
    } catch {
      throw createFileTreeError(`Project path not found: ${projectRoot}`, 404, 'PROJECT_PATH_NOT_FOUND');
    }
    return projectRoot;
  }

  /**
   * Resolves a directory the browser may list.
   *
   * The read-only roots (the system temp directory and the Claude projects
   * directory, see `READ_ONLY_ROOTS` in shared/utils) are browsable but never
   * writable, so they are checked before the workspace policy rejects them.
   * `createWorkspaceFolder` deliberately does not do this, which is what keeps
   * them read-only.
   */
  async function resolveBrowsablePath(targetPath: string): Promise<string> {
    const readOnlyPath = await dependencies.workspace.resolveReadOnlyRootPath(targetPath);
    if (readOnlyPath) {
      return readOnlyPath;
    }

    const validation = await dependencies.workspace.validatePath(targetPath);
    if (!validation.valid) {
      throw createFileTreeError(validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
    }

    return validation.resolvedPath || targetPath;
  }

  /**
   * Resolves a path the viewer is allowed to read.
   *
   * A file reference in a transcript is normally inside the project, but a
   * background command's log lives in the system temp directory and a
   * background agent's output file is a link from there into the Claude
   * projects directory, and the transcript quotes those paths verbatim. Those
   * resolve through the read-only root policy instead of the project root.
   *
   * The agent may also point at a file in another folder of the workspace, the
   * same tree `browseWorkspace` lists, so anything under the workspace root is
   * readable too. Symlinks are resolved before that comparison. The writing
   * endpoints keep using `resolvePathInsideProject` alone, so nothing outside
   * the project can be changed.
   */
  async function resolveReadablePath(projectRoot: string, targetPath: string): Promise<string> {
    if (path.isAbsolute(targetPath)) {
      const readOnlyPath = await dependencies.workspace.resolveReadOnlyRootPath(targetPath);
      if (readOnlyPath) {
        return readOnlyPath;
      }

      const workspacePath = await resolvePathUnderRoots(targetPath, [dependencies.workspace.rootPath]);
      if (workspacePath) {
        return workspacePath;
      }
    }

    return resolvePathInsideProject(projectRoot, targetPath);
  }

  async function cleanupTemporaryFiles(files: FileTreeUploadedFile[]): Promise<void> {
    await Promise.all(files.map(async (file) => {
      try {
        await fileSystem.unlink(file.temporaryPath);
      } catch {
        // A successfully moved file no longer has a temporary source to clean.
      }
    }));
  }

  return {
    async browseWorkspace(inputPath) {
      const requestedPath = inputPath
        ? expandWorkspacePath(dependencies.workspace.rootPath, inputPath)
        : dependencies.workspace.rootPath;
      const targetPath = path.resolve(requestedPath);
      const resolvedPath = await resolveBrowsablePath(targetPath);

      try {
        await fileSystem.access(resolvedPath);
        const stats = await fileSystem.stat(resolvedPath);
        if (!stats.isDirectory()) {
          throw createFileTreeError('Path is not a directory', 400, 'NOT_A_DIRECTORY');
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw createFileTreeError('Directory not accessible', 404, 'DIRECTORY_NOT_ACCESSIBLE');
      }

      const fileTree = await buildFileTree(resolvedPath, 1);
      const directories = fileTree
        .filter((item) => item.type === 'directory')
        .map((item) => ({ path: item.path, name: item.name, type: 'directory' as const }))
        .sort((left, right) => {
          const leftHidden = left.name.startsWith('.');
          const rightHidden = right.name.startsWith('.');
          if (leftHidden && !rightHidden) return 1;
          if (!leftHidden && rightHidden) return -1;
          return left.name.localeCompare(right.name);
        });

      let resolvedWorkspaceRoot = dependencies.workspace.rootPath;
      try {
        resolvedWorkspaceRoot = await fileSystem.realpath(dependencies.workspace.rootPath);
      } catch {
        // The configured workspace root remains the comparison fallback.
      }

      const suggestions = resolvedPath === resolvedWorkspaceRoot
        ? [
            ...directories.filter((directory) => COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
            ...directories.filter((directory) => !COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
          ]
        : directories;

      return { path: resolvedPath, suggestions };
    },

    async createWorkspaceFolder(folderPath) {
      const expandedPath = expandWorkspacePath(dependencies.workspace.rootPath, folderPath);
      const resolvedInput = path.resolve(expandedPath);
      const validation = await dependencies.workspace.validatePath(resolvedInput);
      if (!validation.valid) {
        throw createFileTreeError(validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
      }

      const targetPath = validation.resolvedPath || resolvedInput;
      try {
        await fileSystem.access(path.dirname(targetPath));
      } catch {
        throw createFileTreeError('Parent directory does not exist', 404, 'PARENT_DIRECTORY_NOT_FOUND');
      }

      try {
        await fileSystem.access(targetPath);
        throw createFileTreeError('Folder already exists', 409, 'FOLDER_ALREADY_EXISTS');
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.makeDirectory(targetPath, false);
      } catch (error) {
        mapFileSystemError(error, {
          EEXIST: { message: 'Folder already exists', statusCode: 409 },
        });
      }

      return { success: true, path: targetPath };
    },

    async readTextFile(projectId, filePath) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = await resolveReadablePath(projectRoot, filePath);
      try {
        const content = await fileSystem.readTextFile(resolvedPath);
        return { content, path: resolvedPath };
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
          EISDIR: { message: 'Path is a directory, not a file', statusCode: 400 },
        });
      }
    },

    async openFile(projectId, filePath) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = await resolveReadablePath(projectRoot, filePath);
      try {
        await fileSystem.access(resolvedPath);
      } catch {
        throw createFileTreeError('File not found', 404, 'FILE_NOT_FOUND');
      }

      return {
        contentType: dependencies.resolveMimeType(resolvedPath),
        stream: fileSystem.createReadStream(resolvedPath),
      };
    },

    async saveTextFile(projectId, filePath, content) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = resolvePathInsideProject(projectRoot, filePath);
      try {
        await fileSystem.writeTextFile(resolvedPath, content);
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
        });
      }

      return { success: true, path: resolvedPath, message: 'File saved successfully' };
    },

    async listProjectFiles(projectId, options) {
      const projectRoot = await resolveExistingProjectRoot(projectId);
      const includeEntry = options?.respectGitignore
        ? await readGitignoreEntryFilter(projectRoot, options.markIgnored === true)
        : undefined;

      return buildFileTree(projectRoot, MAXIMUM_PROJECT_TREE_DEPTH, 0, includeEntry);
    },

    async searchProjectFiles(projectId, input) {
      const projectRoot = await resolveExistingProjectRoot(projectId);
      // The command palette's listing: gitignored entries marked, not hidden.
      const includeEntry = await readGitignoreEntryFilter(projectRoot, true)
        ?? includeEntryByFallbackDirectoryNames;
      const limit = Number.isFinite(input.limit)
        ? Math.min(Math.max(Math.floor(input.limit), 1), MAXIMUM_FILE_SEARCH_RESULTS)
        : MAXIMUM_FILE_SEARCH_RESULTS;
      const scoreRelativePath = createFileSearchScorer(projectRoot, input.query);
      const startedAt = dependencies.now();
      const walk: FileSearchWalk = {
        remainingEntries: MAXIMUM_FILE_SEARCH_ENTRIES,
        deadline: startedAt + FILE_SEARCH_TIME_LIMIT_MS,
        signal: input.signal,
        stoppedEarly: false,
        sliceEnd: startedAt + FILE_SEARCH_SLICE_MS,
        nextSlice: null,
      };

      let bestMatches: RankedFileSearchMatch[] = [];
      let totalMatches = 0;
      // One level at a time, so a walk that stops early has covered the
      // shallow files, which the palette prefers on equal scores, first.
      let level: FileSearchDirectory[] = [{ path: projectRoot, relativePath: '' }];
      for (let depth = 0; level.length > 0 && !walk.stoppedEarly; depth += 1) {
        const subdirectoriesByDirectory = await Promise.all(level.map(async (directory, directoryIndex) => {
          const subdirectoryNames: string[] = [];
          // Each file is scored as it is read, so scoring is timed with the walk.
          for await (const entry of readFileSearchEntries(directory.path, includeEntry, walk)) {
            const entryPath = path.join(directory.path, entry.name);
            if (entry.isDirectory) {
              // Walked as a listing walks them: an ignored directory is never
              // opened, and neither is one past the depth or a system directory.
              if (!entry.isIgnored && depth < MAXIMUM_PROJECT_TREE_DEPTH && !isForbiddenSystemDirectory(entryPath)) {
                subdirectoryNames.push(entry.name);
              }
              continue;
            }

            // Checked again right before scoring, the costly part: the read checks
            // before handing over an entry, but other reads of the walk may score
            // theirs in between.
            if (dependencies.now() >= walk.sliceEnd) {
              do {
                await waitForNextSlice(walk);
              } while (dependencies.now() >= walk.sliceEnd);
              if (hasFileSearchRunOut(walk)) {
                walk.stoppedEarly = true;
                break;
              }
            }
            const relativePath = directory.relativePath ? `${directory.relativePath}/${entry.name}` : entry.name;
            const score = scoreRelativePath(relativePath);
            if (score <= 0) {
              continue;
            }
            totalMatches += 1;
            bestMatches.push({
              match: { name: entry.name, path: entryPath, relativePath, isIgnored: entry.isIgnored },
              score,
              depth,
              directoryIndex,
            });
            // Cut back to the best `limit` now and then rather than kept sorted.
            if (bestMatches.length >= limit * 2) {
              bestMatches = bestMatches.sort(compareRankedMatches).slice(0, limit);
            }
          }
          // In listing order, which ranks the files of the next level.
          return subdirectoryNames
            .sort((left, right) => compareListingOrder(true, left, true, right))
            .map((name) => ({
              path: path.join(directory.path, name),
              relativePath: directory.relativePath ? `${directory.relativePath}/${name}` : name,
            }));
        }));
        // Concatenated in level order, which is the next level's listing order.
        level = subdirectoriesByDirectory.flat();
      }

      return {
        files: bestMatches.sort(compareRankedMatches).slice(0, limit).map(({ match }) => match),
        totalMatches,
        incomplete: walk.stoppedEarly,
      };
    },

    async createEntry(input) {
      validateFilename(input.name);
      const projectRoot = await resolveProjectRoot(input.projectId);
      const targetPath = input.parentPath
        ? path.join(input.parentPath, input.name)
        : input.name;
      const resolvedPath = resolvePathInsideProject(projectRoot, targetPath);

      try {
        await fileSystem.access(resolvedPath);
        throw createFileTreeError(
          `${input.type === 'file' ? 'File' : 'Directory'} already exists`,
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        if (input.type === 'directory') {
          await fileSystem.makeDirectory(resolvedPath, false);
        } else {
          const parentDirectory = path.dirname(resolvedPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }
          await fileSystem.writeTextFile(resolvedPath, '');
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'Parent directory not found', statusCode: 404 },
        });
      }

      return {
        success: true,
        path: resolvedPath,
        name: input.name,
        type: input.type,
        message: `${input.type === 'file' ? 'File' : 'Directory'} created successfully`,
      };
    },

    async renameEntry(input) {
      validateFilename(input.newName);
      const projectRoot = await resolveProjectRoot(input.projectId);
      const resolvedOldPath = resolvePathInsideProject(projectRoot, input.oldPath);

      try {
        await fileSystem.access(resolvedOldPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      const resolvedNewPath = path.join(path.dirname(resolvedOldPath), input.newName);
      resolvePathInsideProject(projectRoot, resolvedNewPath);
      try {
        await fileSystem.access(resolvedNewPath);
        throw createFileTreeError(
          'A file or directory with this name already exists',
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.rename(resolvedOldPath, resolvedNewPath);
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EXDEV: { message: 'Cannot move across different filesystems', statusCode: 400 },
        });
      }

      return {
        success: true,
        oldPath: resolvedOldPath,
        newPath: resolvedNewPath,
        newName: input.newName,
        message: 'Renamed successfully',
      };
    },

    async deleteEntry(input) {
      const projectRoot = await resolveProjectRoot(input.projectId);
      const resolvedPath = resolvePathInsideProject(projectRoot, input.targetPath);
      let stats;
      try {
        stats = await fileSystem.stat(resolvedPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      if (resolvedPath === path.resolve(projectRoot)) {
        throw createFileTreeError('Cannot delete project root directory', 403, 'PROJECT_ROOT_DELETE_FORBIDDEN');
      }

      try {
        if (stats.isDirectory()) {
          await fileSystem.removeDirectory(resolvedPath);
        } else {
          await fileSystem.unlink(resolvedPath);
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          ENOTEMPTY: { message: 'Directory is not empty', statusCode: 400 },
        });
      }

      const entryType = stats.isDirectory() ? 'directory' as const : 'file' as const;
      return {
        success: true,
        path: resolvedPath,
        type: entryType,
        message: 'Deleted successfully',
      };
    },

    async storeUploadedFiles(input) {
      if (input.files.length === 0) {
        throw createFileTreeError('No files provided', 400, 'UPLOAD_FILES_REQUIRED');
      }

      try {
        const projectRoot = await resolveProjectRoot(input.projectId);
        const normalizedProjectRoot = path.resolve(projectRoot);
        // The root itself is a valid destination however it is written: empty, `.`, or its
        // absolute path, which older clients send for a file dropped onto a top-level row.
        // resolvePathInsideProject accepts only paths below the root.
        const resolvedTargetDirectory = path.resolve(normalizedProjectRoot, input.targetPath) === normalizedProjectRoot
          ? normalizedProjectRoot
          : resolvePathInsideProject(projectRoot, input.targetPath);

        try {
          await fileSystem.access(resolvedTargetDirectory);
        } catch {
          await fileSystem.makeDirectory(resolvedTargetDirectory, true);
        }

        const uploadedFiles: Array<{ name: string; path: string; size: number; mimeType: string }> = [];
        for (let fileIndex = 0; fileIndex < input.files.length; fileIndex += 1) {
          const file = input.files[fileIndex];
          const fileName = input.relativePaths[fileIndex] || file.originalName;
          const destinationPath = path.join(resolvedTargetDirectory, fileName);

          try {
            resolvePathInsideProject(projectRoot, destinationPath);
          } catch (error) {
            if (error instanceof AppError && error.statusCode === 403) {
              await cleanupTemporaryFiles([file]);
              continue;
            }
            throw error;
          }

          const parentDirectory = path.dirname(destinationPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }

          await fileSystem.copyFile(file.temporaryPath, destinationPath);
          await fileSystem.unlink(file.temporaryPath);
          uploadedFiles.push({
            name: fileName,
            path: destinationPath,
            size: file.size,
            mimeType: file.mimeType,
          });
        }

        return {
          success: true,
          files: uploadedFiles,
          uploadedCount: uploadedFiles.length,
          requestedFileCount: input.requestedFileCount,
          targetPath: resolvedTargetDirectory,
          message: `Uploaded ${uploadedFiles.length} ${uploadedFiles.length === 1 ? 'file' : 'files'} successfully`,
        };
      } catch (error) {
        await cleanupTemporaryFiles(input.files);
        if (readErrorCode(error) === 'EACCES') {
          throw createFileTreeError('Permission denied', 403, 'EACCES');
        }
        if (error instanceof AppError) throw error;
        dependencies.logger.error(`Error uploading files: ${readErrorMessage(error)}`, error);
        throw error;
      }
    },
  };
}
