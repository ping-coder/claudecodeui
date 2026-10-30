import path from 'node:path';

import ignore from 'ignore';

import { createFileSearchScorer } from '@/modules/file-tree/file-search-score.service.js';
import type {
  FileTreeDirectoryEntry,
  FileTreeNode,
  FileTreeSearchMatch,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeStats,
  FileTreeUploadedFile,
  MountCallOutcome,
  ProjectMount,
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

// The contents of all mounts of one listing share this many entries. Past it
// a mount is cut short and flagged `truncated`: a big mount never makes the
// project too large to open.
const MAXIMUM_MOUNT_TREE_ENTRIES = 2_000;

// A listing lists what is in its mounts for at most this long, then flags
// the mounts not done `truncated`: a slow network share never holds up the
// explorer, not even with a folder read that runs on past it. Every call in
// a mount goes through the projects module's mount gate besides, so a share
// that hangs costs a call its time limit, not a request that never answers
// and a thread for each entry.
const MOUNT_WALK_TIME_LIMIT_MS = 5_000;

// The largest file readTextFile reads into memory; the editor reports bigger
// ones as too large to open.
const MAXIMUM_TEXT_FILE_BYTES = 10 * 1024 * 1024;

// The `.gitignore` the projects module keeps in the mounts folder so git
// never sees the links. Hidden from listings and protected like the links.
const MOUNTS_SENTINEL_FILE_NAME = '.gitignore';

// How many entries of a directory in a mount have their lstat asked for at
// once. A directory read there comes as names alone, and its entries' types
// come from these calls, so a huge directory costs no more of them than the
// mounts' budget has room for, give or take one turn.
const MOUNT_ENTRY_LSTAT_BATCH = 64;

// Whether this platform's disks usually match file names case-insensitively
// (Windows, and macOS's default APFS), so `MOUNTS` names the mounts folder.
const FOLDS_FILE_NAME_CASE = process.platform === 'win32' || process.platform === 'darwin';

// A mount's contents are listed only while its target is a reachable folder.
const WALKABLE_MOUNT_STATUSES = new Set<ProjectMount['status']>(['ok', 'not-ignored']);

// A file can be read by its path in a mount's target while the target
// resolves to a folder, even when the link itself needs repair.
const READABLE_MOUNT_STATUSES = new Set<ProjectMount['status']>(['ok', 'not-ignored', 'missing-link', 'link-mismatch']);

// `visible` entries are listed and walked, `ignored` ones are listed but never
// walked, `hidden` ones are left out of the tree entirely.
type FileTreeEntryVisibility = 'visible' | 'ignored' | 'hidden';

type FileTreeEntryFilter = (entryPath: string, isDirectory: boolean) => FileTreeEntryVisibility;

// What is left of each budget. One object is shared by every branch of a walk,
// so the caps apply to the whole tree rather than per directory.
type FileTreeEntryBudget = { visible: number; ignored: number };

// An entry of a directory a listing walks, and whether it is listed as
// gitignored. Inside a mount it comes with its lstat, read through the mount
// gate along with it (null when that failed).
type FileTreeListedEntry = {
  entry: FileTreeDirectoryEntry;
  isIgnored: boolean;
  stats?: FileTreeStats | null;
};

// The project's registered mounts as one request sees them: the mounts
// folder, its sentinel, and each mount by the absolute path of its link.
type FileTreeMountListing = {
  mountsDirectory: string;
  sentinelPath: string;
  mountsByLinkPath: Map<string, ProjectMount>;
};

// The mount a walk is in: its link, where its target really is (every call
// in it goes through the mount gate by that path), and the flag to raise
// when not all of it gets listed.
type FileTreeMountPlace = {
  linkPath: string;
  realTargetPath: string;
  truncated: boolean;
};

// How a listing treats the mounts while it walks: whether it lists their
// contents at all, the budget all of them share, the signal that ends their
// walk when its time is up, and the mount the walk is in, if any.
type FileTreeMountWalk = {
  listing: FileTreeMountListing;
  walkContents: boolean;
  remainingEntries: FileTreeEntryBudget;
  timeLimit: AbortSignal;
  insideMount: FileTreeMountPlace | null;
};

// Where a path the File Tree reads or writes lies in a mount whose link
// leads into its target: the mount, and the path as it really is there.
type FileTreeMountLocation = {
  mount: ProjectMount;
  realPath: string;
};

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

function applyEntryStats(item: FileTreeNode, stats: FileTreeStats): void {
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
}

/** A path inside a mount, as it really is: the same place below the target's realpath. */
function realPathInMount(place: FileTreeMountPlace, linkedPath: string): string {
  const relativePath = path.relative(place.linkPath, linkedPath);
  return relativePath ? path.join(place.realTargetPath, relativePath) : place.realTargetPath;
}

/** The names of a directory's entries, as it streams them. */
async function* streamEntryNames(entries: AsyncIterable<FileTreeDirectoryEntry>): AsyncGenerator<string> {
  for await (const entry of entries) {
    yield entry.name;
  }
}

/**
 * The outcome of `call`, or busy once `signal` aborts first. For a slow
 * call in a mount, which the walk stops waiting for at its time limit; the
 * call runs on, and keeps its share's turn until it answers.
 */
function stopWaitingOnAbort<T>(call: Promise<MountCallOutcome<T>>, signal: AbortSignal): Promise<MountCallOutcome<T>> {
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve({ kind: 'busy' });
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    void call.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** A file name or path as this platform's disks usually compare them (see FOLDS_FILE_NAME_CASE). */
function comparableName(name: string): string {
  return FOLDS_FILE_NAME_CASE ? name.toLowerCase() : name;
}

function isSameOrInsidePath(candidatePath: string, parentPath: string): boolean {
  return candidatePath === parentPath
    || candidatePath.startsWith(parentPath.endsWith(path.sep) ? parentPath : `${parentPath}${path.sep}`);
}

function createMountUnreachableError(mount: ProjectMount): AppError {
  return createFileTreeError(
    `The mounted folder "${mount.name}" does not answer or is gone (an offline network share or an unplugged disk?)`,
    503,
    'MOUNT_UNREACHABLE',
  );
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
 * Lists the mounts folder and every registered mount's link whatever the
 * project's `.gitignore` says (a root rule matching `mounts/` must not hide
 * them), and hides the sentinel. Everything else is left to `includeEntry`.
 */
function createMountAwareEntryFilter(
  listing: FileTreeMountListing,
  includeEntry: FileTreeEntryFilter,
): FileTreeEntryFilter {
  return (entryPath, isDirectory) => {
    if (entryPath === listing.sentinelPath) return 'hidden';
    if (entryPath === listing.mountsDirectory || listing.mountsByLinkPath.has(entryPath)) return 'visible';
    return includeEntry(entryPath, isDirectory);
  };
}

/**
 * Hides the registered mounts' links and the sentinel from the project file
 * search: a link would come back as a file the palette cannot open, and the
 * search never walks into what a link points to.
 */
function createMountHidingEntryFilter(
  listing: FileTreeMountListing,
  includeEntry: FileTreeEntryFilter,
): FileTreeEntryFilter {
  return (entryPath, isDirectory) => (
    entryPath === listing.sentinelPath || listing.mountsByLinkPath.has(entryPath)
      ? 'hidden'
      : includeEntry(entryPath, isDirectory)
  );
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
   * being read into memory in full first. Running out of the visible budget
   * fails with a 413.
   */
  async function collectListedEntries(
    directoryPath: string,
    includeEntry: FileTreeEntryFilter,
    remainingEntries: FileTreeEntryBudget,
  ): Promise<FileTreeListedEntry[]> {
    const listedEntries: FileTreeListedEntry[] = [];

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

  /**
   * Reads one directory inside a mount, under the hard exclusions only and
   * on the mounts' budget: like collectListedEntries, but every call goes
   * through the mount gate (by where the directory really is) instead of the
   * listing's own limiter, so a share that hangs costs this read its time
   * limit, and running out of the budget flags the mount `truncated` rather
   * than failing the request. So does a call that does not answer in time,
   * the walk's time limit, and a directory the budget has no room left for,
   * which is not read at all; the entries read by then are kept.
   *
   * On a local disk the directory is streamed (openDirectory) and read only
   * as far as the budget goes. On a network share its names come in one
   * slow call (readDirectoryNames, never opendir, see `FileTreeFileSystem`),
   * which the walk stops waiting for at its time limit. Either way each
   * entry's type and metadata come from its lstat, MOUNT_ENTRY_LSTAT_BATCH
   * entries at a time.
   */
  async function collectMountEntries(
    directoryPath: string,
    remainingEntries: FileTreeEntryBudget,
    place: FileTreeMountPlace,
    timeLimit: AbortSignal,
  ): Promise<FileTreeListedEntry[]> {
    if (remainingEntries.visible <= 0 || timeLimit.aborted) {
      place.truncated = true;
      return [];
    }
    const read = await stopWaitingOnAbort(
      dependencies.mounts.runInMountTarget(
        realPathInMount(place, directoryPath),
        async (call): Promise<Iterable<string> | AsyncIterable<string> | null> => {
          // Other folders may have used up the budget while this one waited for its turn.
          if (remainingEntries.visible <= 0) {
            return null;
          }
          return call.gated
            ? fileSystem.readDirectoryNames(directoryPath)
            : streamEntryNames(fileSystem.openDirectory(directoryPath));
        },
        { signal: timeLimit, slow: true },
      ),
      timeLimit,
    );
    if (read.kind === 'failed') {
      logUnreadableDirectory(directoryPath, read.error);
      return [];
    }
    if (read.kind !== 'done' || read.value === null) {
      place.truncated = true;
      return [];
    }

    const listedEntries: FileTreeListedEntry[] = [];
    let names: string[] = [];
    try {
      for await (const name of read.value) {
        if (remainingEntries.visible <= 0 || timeLimit.aborted) {
          place.truncated = true;
          return listedEntries;
        }
        names.push(name);
        if (names.length >= Math.min(remainingEntries.visible, MOUNT_ENTRY_LSTAT_BATCH)) {
          const complete = await listMountEntries(directoryPath, names, remainingEntries, place, timeLimit, listedEntries);
          names = [];
          if (!complete) {
            place.truncated = true;
            return listedEntries;
          }
        }
      }
    } catch (error) {
      // Only a directory streamed on a local disk is read here.
      logUnreadableDirectory(directoryPath, error);
      return listedEntries;
    }
    if (names.length > 0 && !(await listMountEntries(directoryPath, names, remainingEntries, place, timeLimit, listedEntries))) {
      place.truncated = true;
    }
    return listedEntries;
  }

  /**
   * Adds `names`, entries of `directoryPath` in a mount, to `listedEntries`,
   * each with its lstat through the mount gate, as far as the mounts' budget
   * goes. False when not all of them could be listed: the budget ran out
   * (the walks of other folders share it), or an lstat did not answer.
   */
  async function listMountEntries(
    directoryPath: string,
    names: string[],
    remainingEntries: FileTreeEntryBudget,
    place: FileTreeMountPlace,
    timeLimit: AbortSignal,
    listedEntries: FileTreeListedEntry[],
  ): Promise<boolean> {
    const lstats = await Promise.all(names.map((name) => {
      const entryPath = path.join(directoryPath, name);
      return dependencies.mounts.runInMountTarget(
        realPathInMount(place, entryPath),
        () => fileSystem.lstat(entryPath),
        { signal: timeLimit },
      );
    }));
    let complete = true;
    for (const [index, name] of names.entries()) {
      const lstat = lstats[index];
      if (lstat.kind === 'unreachable' || lstat.kind === 'busy') {
        // Its type is not known, so it is left out, and the rest with it.
        complete = false;
        continue;
      }
      // An entry whose lstat failed is still listed, as a file without metadata.
      const stats = lstat.kind === 'done' ? lstat.value : null;
      const isDirectory = stats?.isDirectory() === true;
      if (includeEntryByHardExclusions(path.join(directoryPath, name), isDirectory) === 'hidden') {
        continue;
      }
      if (remainingEntries.visible <= 0) {
        return false;
      }
      remainingEntries.visible -= 1;
      listedEntries.push({ entry: { name, isDirectory: () => isDirectory }, isIgnored: false, stats });
    }
    return complete;
  }

  /** Logs a directory that could not be read, unless only permission was refused. */
  function logUnreadableDirectory(directoryPath: string, error: unknown): void {
    const errorCode = readErrorCode(error);
    if (errorCode !== 'EACCES' && errorCode !== 'EPERM') {
      dependencies.logger.error(`Error reading directory "${directoryPath}"`, error);
    }
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
    mountWalk: FileTreeMountWalk | null = null,
  ): Promise<FileTreeNode[]> {
    const insideMount = mountWalk?.insideMount ?? null;
    const listedEntries = insideMount && mountWalk
      ? await collectMountEntries(directoryPath, remainingEntries, insideMount, mountWalk.timeLimit)
      : await collectListedEntries(directoryPath, includeEntry, remainingEntries);

    const items = await Promise.all(listedEntries.map(async ({ entry, isIgnored, stats }): Promise<FileTreeNode> => {
      const itemPath = path.join(directoryPath, entry.name);
      // Mount links sit in the project's mounts folder, never inside another mount.
      const mount = insideMount ? undefined : mountWalk?.listing.mountsByLinkPath.get(itemPath);
      const item: FileTreeNode = {
        name: entry.name,
        path: itemPath,
        type: entry.isDirectory() || mount ? 'directory' : 'file',
        size: 0,
        modified: null,
        permissions: '000',
        permissionsRwx: '---------',
      };
      if (isIgnored) {
        item.isIgnored = true;
      }
      if (mount) {
        item.isSymlink = true;
        item.mount = {
          mountId: mount.mountId,
          name: mount.name,
          targetPath: mount.targetPath,
          status: mount.status,
        };
      }
      if (insideMount) {
        item.inMount = true;
        // Read with the entry, through the mount gate (collectMountEntries).
        if (stats) {
          applyEntryStats(item, stats);
        }
      } else {
        try {
          await acquire();
          try {
            applyEntryStats(item, await fileSystem.lstat(itemPath));
          } finally {
            release();
          }
        } catch {
          // Metadata failures should not hide an otherwise readable tree entry.
        }
      }

      if (mount && mountWalk) {
        // Walked through the link, so every path stays under the project, on
        // the mounts' own budget and with only the hard exclusions: the
        // project's .gitignore says nothing about a folder outside it.
        if (
          mountWalk.walkContents
          && WALKABLE_MOUNT_STATUSES.has(mount.status)
          && mount.realTargetPath !== null
          && currentDepth < maximumDepth
        ) {
          const mountState: FileTreeMountPlace = {
            linkPath: itemPath,
            realTargetPath: mount.realTargetPath,
            truncated: false,
          };
          item.children = await buildFileTree(
            itemPath,
            maximumDepth,
            currentDepth + 1,
            includeEntryByHardExclusions,
            mountWalk.remainingEntries,
            { ...mountWalk, insideMount: mountState },
          );
          if (mountState.truncated) {
            item.truncated = true;
          }
        }
        return item;
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
          mountWalk,
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

  /** The project's registered mounts for one request, or null when it has none. */
  async function readMountListing(projectId: string, projectRoot: string): Promise<FileTreeMountListing | null> {
    const mounts = await dependencies.mounts.listProjectMounts(projectId);
    if (mounts.length === 0) {
      return null;
    }
    const mountsDirectory = path.join(projectRoot, dependencies.mounts.directoryName);
    return {
      mountsDirectory,
      sentinelPath: path.join(mountsDirectory, MOUNTS_SENTINEL_FILE_NAME),
      mountsByLinkPath: new Map(mounts.map((mount) => [path.join(mountsDirectory, mount.name), mount])),
    };
  }

  /**
   * Like readMountListing for the read paths, where mounts are an extra: a
   * failed lookup is logged and the request goes on as if there were none.
   */
  async function readMountListingOrNone(projectId: string, projectRoot: string): Promise<FileTreeMountListing | null> {
    try {
      return await readMountListing(projectId, projectRoot);
    } catch (error) {
      dependencies.logger.error(`Error reading the mounts of project "${projectId}"`, error);
      return null;
    }
  }

  /**
   * Where `resolvedPath`, a path under the project, lies in one of its
   * mounts: null for a path outside the mounts folder, outside every mount,
   * or in a mount whose link does not lead into its target (a link that is
   * missing or points elsewhere), which is then used as it is. A path in a
   * mount whose target is gone or does not answer is refused with a 503
   * (`MOUNT_UNREACHABLE`) before anything touches it. Only paths in the
   * mounts folder are looked up, so other paths cost nothing.
   */
  async function locateInMountLink(
    projectId: string,
    projectRoot: string,
    resolvedPath: string,
  ): Promise<FileTreeMountLocation | null> {
    const mountsDirectory = path.join(path.resolve(projectRoot), dependencies.mounts.directoryName);
    if (!resolvedPath.startsWith(`${mountsDirectory}${path.sep}`)) {
      return null;
    }
    const [name, ...rest] = path.relative(mountsDirectory, resolvedPath).split(path.sep);
    const listing = await readMountListingOrNone(projectId, projectRoot);
    const mount = listing ? [...listing.mountsByLinkPath.values()].find((candidate) => candidate.name === name) : undefined;
    if (!mount) {
      return null;
    }
    if (mount.status === 'missing-target') {
      throw createMountUnreachableError(mount);
    }
    if (!WALKABLE_MOUNT_STATUSES.has(mount.status) || mount.realTargetPath === null) {
      return null;
    }
    return { mount, realPath: path.join(mount.realTargetPath, ...rest) };
  }

  /**
   * Runs `operation`, a filesystem call on a path the File Tree reads or
   * writes, through the mount gate when the path lies in a mount
   * (`location`), so a share that hangs costs the request a 503
   * (`MOUNT_UNREACHABLE`) instead of an answer that never comes and a thread
   * kept for good. The links in the path below the target are followed
   * first, so a link in the target into another share counts against that
   * share, not the target's. The call's own error is thrown as it is.
   */
  async function callOnPath<T>(location: FileTreeMountLocation | null, operation: () => Promise<T>): Promise<T> {
    if (!location) {
      return operation();
    }
    const outcome = await dependencies.mounts.runInMountTarget(location.realPath, operation, {
      followLinksBelow: location.mount.realTargetPath ?? undefined,
    });
    if (outcome.kind === 'done') {
      return outcome.value;
    }
    if (outcome.kind === 'failed') {
      throw outcome.error;
    }
    throw createMountUnreachableError(location.mount);
  }

  /** A path as the disk resolves it, case-folded where names are (FOLDS_FILE_NAME_CASE); null when it does not resolve. */
  async function readRealIdentity(candidatePath: string): Promise<string | null> {
    try {
      return comparableName(normalizeProjectPath(await fileSystem.realpath(candidatePath)));
    } catch {
      return null;
    }
  }

  /**
   * Refuses to rename or delete the mounts folder, the sentinel or a mount's
   * link while the project has mounts: those are changed by unmounting.
   * Judged by what the path is on disk, not by how it is written: the folder
   * that holds it, resolved, against the mounts folder (or the project root),
   * resolved, and its name case-folded where the disk folds case, so
   * `MOUNTS/data` on macOS, or `self/mounts/data` through a link
   * `self -> .`, is refused too. A path inside a mount's link belongs to the
   * mount and is let through without resolving it, which would reach into
   * its target outside the mount gate.
   */
  async function assertNotMountProtected(projectId: string, projectRoot: string, resolvedPath: string): Promise<void> {
    const root = path.resolve(projectRoot);
    const mountsDirectory = path.join(root, dependencies.mounts.directoryName);
    const parentPath = path.dirname(resolvedPath);
    if (resolvedPath.startsWith(`${mountsDirectory}${path.sep}`) && parentPath !== mountsDirectory) {
      return;
    }
    const realMountsDirectory = await readRealIdentity(mountsDirectory);
    if (realMountsDirectory === null) {
      return;
    }
    const [realParent, realRoot] = await Promise.all([
      readRealIdentity(parentPath).then((identity) => identity ?? comparableName(normalizeProjectPath(parentPath))),
      readRealIdentity(root).then((identity) => identity ?? comparableName(normalizeProjectPath(root))),
    ]);
    const name = comparableName(path.basename(resolvedPath));
    const isMountsDirectory = realParent === realRoot && name === comparableName(dependencies.mounts.directoryName);
    if (!isMountsDirectory && realParent !== realMountsDirectory) {
      return;
    }
    const listing = await readMountListing(projectId, root);
    if (!listing) {
      return;
    }
    if (
      isMountsDirectory
      || name === comparableName(MOUNTS_SENTINEL_FILE_NAME)
      || [...listing.mountsByLinkPath.values()].some((mount) => comparableName(mount.name) === name)
    ) {
      throw createFileTreeError(
        'Mounted folders cannot be renamed or deleted here; unmount them instead',
        403,
        'MOUNT_PROTECTED',
      );
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
   * readable too. So is anything in the target of one of the project's
   * mounts, which the agent quotes by its real path. Symlinks are resolved
   * before those comparisons. The writing endpoints keep using
   * `resolvePathInsideProject` alone, so nothing outside the project can be
   * changed, except through a link inside it (a mount's, for one).
   *
   * Resolving a path is a call into the share it is on, which may hang, so
   * an absolute path inside the project is taken as it is written, exactly
   * like a relative one (a path in the mounts folder then goes through the
   * mount gate, see locateInMountLink). An absolute path outside it that
   * lies in a mount's target is checked first and resolved through the
   * mount gate; any other on a filesystem the gate knows to hang is refused
   * with a 503. Only a project with mounts pays for those lookups. The path
   * comes back with where it lies in a mount, if it does.
   */
  async function resolveReadablePath(
    projectId: string,
    projectRoot: string,
    targetPath: string,
  ): Promise<{ resolvedPath: string; location: FileTreeMountLocation | null }> {
    if (path.isAbsolute(targetPath) && !path.resolve(targetPath).startsWith(`${path.resolve(projectRoot)}${path.sep}`)) {
      const mountListing = await readMountListingOrNone(projectId, projectRoot);
      const normalizedTarget = normalizeProjectPath(path.resolve(targetPath));
      const mount = mountListing
        ? [...mountListing.mountsByLinkPath.values()].find((candidate) => (
          isSameOrInsidePath(normalizedTarget, candidate.realTargetPath ?? normalizeProjectPath(candidate.targetPath))
        ))
        : undefined;
      if (mount?.status === 'missing-target') {
        throw createMountUnreachableError(mount);
      }
      if (mount && mount.realTargetPath !== null && READABLE_MOUNT_STATUSES.has(mount.status)) {
        const mountTarget = mount.realTargetPath;
        const resolved = await dependencies.mounts.runInMountTarget(
          normalizedTarget,
          () => resolvePathUnderRoots(targetPath, [mountTarget]),
          { followLinksBelow: mountTarget },
        );
        if (resolved.kind === 'unreachable' || resolved.kind === 'busy') {
          throw createMountUnreachableError(mount);
        }
        if (resolved.kind === 'done' && resolved.value) {
          return { resolvedPath: resolved.value, location: { mount, realPath: resolved.value } };
        }
        // A path that resolves elsewhere through a link in the target goes by
        // the other rules.
      }

      // The rules below resolve the path without the mount gate, which
      // would hang on a filesystem that does not answer. A mount's target
      // reached through a link (~/nas -> /mnt/nas) matches no mount by its
      // real path while it does not answer, but its probe taught the gate
      // that its filesystem hangs.
      if (mountListing && await dependencies.mounts.isShareUnreachable(normalizedTarget)) {
        throw createFileTreeError(
          'The folder of this file does not answer (an offline network share or an unplugged disk?)',
          503,
          'MOUNT_UNREACHABLE',
        );
      }

      const readOnlyPath = await dependencies.workspace.resolveReadOnlyRootPath(targetPath);
      if (readOnlyPath) {
        return { resolvedPath: readOnlyPath, location: null };
      }

      const workspacePath = await resolvePathUnderRoots(targetPath, [dependencies.workspace.rootPath]);
      if (workspacePath) {
        return { resolvedPath: workspacePath, location: null };
      }
    }

    const resolvedPath = resolvePathInsideProject(projectRoot, targetPath);
    return { resolvedPath, location: await locateInMountLink(projectId, projectRoot, resolvedPath) };
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
      const { resolvedPath, location } = await resolveReadablePath(projectId, projectRoot, filePath);
      try {
        // In a mount, through the mount gate: a file that answers this goes on to be read.
        const stats = await callOnPath(location, () => fileSystem.stat(resolvedPath));
        // A directory goes on to the read, which reports it as one.
        if (!stats.isDirectory() && stats.size > MAXIMUM_TEXT_FILE_BYTES) {
          throw new AppError('File is too large to open', {
            code: 'FILE_TOO_LARGE',
            statusCode: 413,
            details: { size: stats.size, limit: MAXIMUM_TEXT_FILE_BYTES },
          });
        }
        const content = await fileSystem.readTextFile(resolvedPath);
        return { content, path: resolvedPath };
      } catch (error) {
        if (error instanceof AppError) throw error;
        mapFileSystemError(error, {
          ENOENT: { message: 'File not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
          EISDIR: { message: 'Path is a directory, not a file', statusCode: 400 },
        });
      }
    },

    async openFile(projectId, filePath) {
      const projectRoot = await resolveProjectRoot(projectId);
      const { resolvedPath, location } = await resolveReadablePath(projectId, projectRoot, filePath);
      try {
        await callOnPath(location, () => fileSystem.access(resolvedPath));
      } catch (error) {
        if (error instanceof AppError) throw error;
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
      const location = await locateInMountLink(projectId, projectRoot, resolvedPath);
      if (location) {
        // The folder the file goes in answers, through the mount gate,
        // before the write that could otherwise hang.
        await callOnPath(location, async () => {
          try {
            await fileSystem.access(path.dirname(resolvedPath));
          } catch {
            // The write reports what is wrong with the folder.
          }
        });
      }
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

      const mountListing = await readMountListingOrNone(projectId, projectRoot);
      if (!mountListing) {
        return buildFileTree(projectRoot, MAXIMUM_PROJECT_TREE_DEPTH, 0, includeEntry);
      }
      const mountWalkTimeLimit = new AbortController();
      const timer = setTimeout(() => mountWalkTimeLimit.abort(), MOUNT_WALK_TIME_LIMIT_MS);
      try {
        return await buildFileTree(
          projectRoot,
          MAXIMUM_PROJECT_TREE_DEPTH,
          0,
          createMountAwareEntryFilter(mountListing, includeEntry ?? includeEntryByFallbackDirectoryNames),
          undefined,
          {
            listing: mountListing,
            // Only the explorer's listing (which the palette shares) lists what
            // is in a mount; the @ mention list sees the mount as a folder.
            walkContents: options?.markIgnored === true,
            remainingEntries: { visible: MAXIMUM_MOUNT_TREE_ENTRIES, ignored: 0 },
            timeLimit: mountWalkTimeLimit.signal,
            insideMount: null,
          },
        );
      } finally {
        clearTimeout(timer);
      }
    },

    async searchProjectFiles(projectId, input) {
      const projectRoot = await resolveExistingProjectRoot(projectId);
      // The command palette's listing: gitignored entries marked, not hidden.
      const listingEntryFilter = await readGitignoreEntryFilter(projectRoot, true)
        ?? includeEntryByFallbackDirectoryNames;
      const mountListing = await readMountListingOrNone(projectId, projectRoot);
      const includeEntry = mountListing
        ? createMountHidingEntryFilter(mountListing, listingEntryFilter)
        : listingEntryFilter;
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
      const location = await locateInMountLink(input.projectId, projectRoot, resolvedPath);

      try {
        await callOnPath(location, () => fileSystem.access(resolvedPath));
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
      await assertNotMountProtected(input.projectId, projectRoot, resolvedOldPath);
      const location = await locateInMountLink(input.projectId, projectRoot, resolvedOldPath);

      try {
        await callOnPath(location, () => fileSystem.access(resolvedOldPath));
      } catch (error) {
        if (error instanceof AppError) throw error;
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
      // A mount's link goes only by unmounting, which checks it still points at the target.
      await assertNotMountProtected(input.projectId, projectRoot, resolvedPath);
      const location = await locateInMountLink(input.projectId, projectRoot, resolvedPath);
      let stats;
      try {
        stats = await callOnPath(location, () => fileSystem.stat(resolvedPath));
      } catch (error) {
        if (error instanceof AppError) throw error;
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
        const location = await locateInMountLink(input.projectId, projectRoot, resolvedTargetDirectory);

        try {
          await callOnPath(location, () => fileSystem.access(resolvedTargetDirectory));
        } catch (error) {
          if (error instanceof AppError) throw error;
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
