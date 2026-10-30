import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import spawn from 'cross-spawn';

import { getDatabasePath, projectMountsDb, projectsDb } from '@/modules/database/index.js';
import { createMountGate, readMachineMountPoints } from '@/modules/projects/services/project-mount-gate.service.js';
import type {
  MachineMountPoint,
  MountCall,
  MountCallOutcome,
  ProjectMount,
  ProjectMountDirectory,
  ProjectMountRecord,
  ProjectMountStatus,
} from '@/shared/types.js';
import { AppError, normalizeProjectPath, sanitizeLeafDirectoryName } from '@/shared/utils.js';

/**
 * The folder in the project root that holds every mount's link. Used by the
 * File Tree (through the projects barrel) to find the links and protect them.
 */
export const PROJECT_MOUNTS_DIRECTORY_NAME = 'mounts';

// The sentinel ignores every link and itself, so git stays clean in a repo,
// in a project git-initialized later, in clones, worktrees and nested
// projects, without touching .git or the tracked .gitignore.
const SENTINEL_FILE_NAME = '.gitignore';
const SENTINEL_MARKER = '# CloudCLI mounts: never committed';
const SENTINEL_CONTENT = `${SENTINEL_MARKER}\n*\n`;

// Names no mount may have (lower case; see validateMountName).
const RESERVED_MOUNT_NAMES = new Set([SENTINEL_FILE_NAME, '.git']);

const MAXIMUM_MOUNT_NAME_LENGTH = 100;

// The folder browser reads at most this many entries of one folder and lists
// at most this many folders, so a folder with millions of files still answers.
const MAXIMUM_BROWSE_ENTRIES_READ = 20_000;
const MAXIMUM_BROWSE_DIRECTORIES = 2_000;

// No git command here should take long; the limit only matters when git
// waits on something that never comes.
const GIT_COMMAND_TIMEOUT_MS = 10_000;

const IS_WINDOWS = process.platform === 'win32';

// System folders a mount may not point into or contain: pseudo-filesystems,
// the OS and its programs, and live system state.
const POSIX_SYSTEM_ROOTS = [
  '/proc', '/sys', '/dev', '/etc', '/boot', '/bin', '/sbin', '/usr',
  '/lib', '/lib32', '/lib64', '/libx32', '/run', '/var/lib',
];
// Any other /lib* folder at the top level (/libexec, /lib.usr-is-merged).
const POSIX_LIB_ROOT_PATTERN = /^\/lib[^/]*(\/|$)/;
const WINDOWS_SYSTEM_FOLDER_NAMES = new Set([
  'windows', 'program files', 'program files (x86)', 'programdata', 'system volume information', '$recycle.bin',
]);
// Removable drives that udisks mounts for the logged-in user, under the
// otherwise forbidden /run.
const ALLOWED_INSIDE_SYSTEM_ROOTS = IS_WINDOWS ? [] : ['/run/media'];

// Folders of the user's home that hold credentials or agent settings, and
// this app's own: ~/.claude-code-ui holds the plugins (code the server runs
// at boot and loads into the app page) and their settings (plugin-registry).
const SENSITIVE_HOME_FOLDER_NAMES = ['.ssh', '.gnupg', '.aws', '.config', '.claude', '.codex', '.cloudcli', '.claude-code-ui'];

// Where Claude and Codex keep their settings and credentials when the
// environment moves them out of ~/.claude and ~/.codex. The server hands its
// whole environment to every CLI it starts, so the CLIs read them there.
const AGENT_CONFIG_DIRECTORY_VARIABLES = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'];

// Every listing probes each target (realpath, then stat). On a hard-mounted
// network share whose server is gone those calls hang in the kernel and never
// return, so a probe, like any call into a target, goes through the mount
// gate (project-mount-gate.service.ts): one that has not answered in this
// long counts as unreachable, the mount reads as 'missing-target', and
// nothing walks, reads or hands on its target while its share hangs.
const TARGET_PROBE_TIMEOUT_MS = 2_000;

// A call that reads every name in a folder (the File Tree's walk in a mount,
// the folder browser) takes as long as the folder is big: on a NAS, a folder
// of 100k files can take many seconds, more over a VPN. Such a call has this
// long before its share counts as unreachable. It keeps its share's turn
// meanwhile, so a share that hangs still keeps only one thread.
const SLOW_CALL_TIMEOUT_MS = 30_000;

// How many targets' last answers (what a probe that comes back busy reads
// as) the service remembers. Past it the one answered longest ago is
// forgotten: the folder browser probes every link it lists, and a registered
// mount, probed by every listing, stays among the recent ones.
const MAXIMUM_REMEMBERED_ANSWERS = 1_000;

// How many links in a path are followed to find the share a call on it
// lands on (see runWhereItLands); Linux follows 40.
const MAXIMUM_LINK_HOPS = 40;

// A path with a line break or another control character could pass for
// lines of their own where it is written out, such as the system prompt
// lines that name a mount to Claude. No mount points at one.
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f]/;

type GitRunResult = {
  /** Exit code; null when git could not be started or was killed. */
  code: number | null;
  stdout: string;
};

type ProjectMountsRepository = Pick<
  typeof projectMountsDb,
  'listByProject' | 'getById' | 'getByName' | 'create' | 'delete' | 'deleteByProject'
>;

type ProjectMountsServiceDependencies = {
  mounts: ProjectMountsRepository;
  resolveProjectPathById(projectId: string): string | null;
  resolveProjectIdByPath(projectPath: string): string | null;
  /** The paths of every registered project, archived ones included. */
  listProjectPaths(): string[];
  /** Runs git in `cwd`; resolves with code null instead of rejecting when git cannot run. */
  runGit(args: string[], cwd: string): Promise<GitRunResult>;
  homeDirectory: string;
  /** Folders of this app's own data (its database and settings); never a mount target. */
  listAppDataDirectories(): string[];
  /**
   * Claude's and Codex's settings folders where the environment moves them
   * (AGENT_CONFIG_DIRECTORY_VARIABLES); never a mount target, like
   * ~/.claude and ~/.codex.
   */
  listAgentConfigDirectories(): string[];
  /** A target's realpath and whether that is a folder; rejects when it does not resolve. */
  probeFolder(targetPath: string): Promise<FolderProbe>;
  /**
   * The names in a folder on a network share, without their types, for the
   * folder browser: for an entry whose type the share does not report,
   * opendir runs a synchronous lstat on the event loop, which no time limit
   * can stop.
   */
  readFolderNames(folderPath: string): Promise<string[]>;
  /**
   * The machine's mount points, which tell the mount gate which share a path
   * is on and whether that is a local disk's; null where they cannot be read.
   */
  listMountPoints(): Promise<MachineMountPoint[] | null>;
  /** How long a call into a target (a probe, say) may take before its share counts as unreachable. */
  targetProbeTimeoutMs: number;
  /** The same for a call that reads every name in a folder (SLOW_CALL_TIMEOUT_MS). */
  slowCallTimeoutMs: number;
  /** Milliseconds on a clock that never goes back; times calls into targets. */
  monotonicNow(): number;
  createMountId(): string;
  now(): Date;
  logWarning(message: string, error?: unknown): void;
};

/** A link in the mounts folder that no row describes, which can be registered as it is. */
type AdoptableProjectMount = {
  name: string;
  targetPath: string;
};

type SentinelState = {
  /**
   * `link`: a symbolic link stands where the sentinel goes. It is never read
   * or written through (it may point out of the project), and git does not
   * read a `.gitignore` that is a link.
   */
  kind: 'ours' | 'missing' | 'link' | 'foreign';
  /** Whether it still holds the `*` line; only meaningful for `ours`. */
  ignoresEverything: boolean;
};

type LinkState =
  | { kind: 'missing' }
  | { kind: 'other' }
  | { kind: 'symlink'; target: string };

/** `unreachable`: the target did not answer in time, which is not the same as gone. */
type TargetState =
  | { kind: 'ok'; realPath: string }
  | { kind: 'not-directory'; realPath: string }
  | { kind: 'missing' }
  | { kind: 'unreachable' };

/** A target's realpath, and whether that is a folder. */
type FolderProbe = { realPath: string; isDirectory: boolean };

/** A folder, or a link that may lead to one, that the folder browser found in the folder it lists. */
type BrowseEntry = { name: string; path: string; isSymbolicLink: boolean };

/**
 * What probing a target found; `unreachable` when it did not answer in time
 * or its share has a call that never answered. `busy`: the gate did not
 * start the probe, as it waited too long for its turn (other calls on its
 * share, or on shares not known to answer, held every slot). That says
 * nothing about the target itself.
 */
type TargetProbe =
  | { kind: 'directory' | 'not-directory'; realPath: string }
  | { kind: 'missing' }
  | { kind: 'unreachable' }
  | { kind: 'busy' };

/**
 * How far a walk along the links of a path has come (see runWhereItLands):
 * the part of the path known to hold no link, the names still to walk, and
 * how many links it has followed. `stopped`: it walks no further (a name
 * that does not resolve, or too many links), and the call runs on the share
 * where it stands.
 */
type LinkWalk = {
  resolved: string;
  pending: string[];
  hops: number;
  stopped: boolean;
};

/** A link taken out of a mounts folder, and its text, to put it back as it was (see detachMountLinks). */
type RemovedLink = { linkPath: string; linkText: string };

/**
 * A registered mount reconciled with the disk, with what the public status
 * folds away: whether the target's probe went unanswered (it did not answer
 * in time, or never got its turn, so the status is missing-target or the
 * last one known), and whether the link is still ours (a symlink to the
 * registered target).
 */
type InspectedMount = {
  mount: ProjectMount;
  targetUnanswered: boolean;
  linkInPlace: boolean;
};

/**
 * The places a mount may not point into, each spelled as written and, where
 * that differs, as the disk resolves it: ~/.claude may be a link into a
 * dotfiles folder, the home folder may sit under a linked /home, and macOS
 * keeps /etc in /private/etc. Read fresh for every check, since a folder
 * can turn into a link at any time.
 */
type BlockedPaths = {
  /** The sensitive home folders and the app's data folders. */
  sensitive: string[];
  /** The POSIX system roots; empty on Windows, which goes by folder names. */
  systemRoots: string[];
  /** The places inside a system root that may still be mounted (/run/media). */
  allowedExceptions: string[];
};

function runGitCommand(args: string[], cwd: string): Promise<GitRunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const settle = (code: number | null) => {
      if (!settled) {
        settled = true;
        resolve({ code, stdout });
      }
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', args, {
        cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
        timeout: GIT_COMMAND_TIMEOUT_MS,
      });
    } catch {
      settle(null);
      return;
    }
    child.stdout?.on('data', (data: Buffer | string) => {
      stdout += data.toString();
    });
    child.on('error', () => settle(null));
    child.on('close', (code) => settle(code));
  });
}

/** The agent settings folders the environment names (AGENT_CONFIG_DIRECTORY_VARIABLES), where set to an absolute path. */
function readAgentConfigDirectories(): string[] {
  return AGENT_CONFIG_DIRECTORY_VARIABLES
    .map((name) => process.env[name]?.trim() ?? '')
    .filter((directory) => directory !== '' && path.isAbsolute(directory));
}

const defaultDependencies: ProjectMountsServiceDependencies = {
  mounts: projectMountsDb,
  resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
  resolveProjectIdByPath: (projectPath) => projectsDb.getProjectPath(projectPath)?.project_id ?? null,
  listProjectPaths: () => [...projectsDb.getProjectPaths(), ...projectsDb.getArchivedProjectPaths()]
    .map((project) => project.project_path),
  runGit: runGitCommand,
  homeDirectory: os.homedir(),
  listAppDataDirectories: () => [path.dirname(getDatabasePath())],
  listAgentConfigDirectories: readAgentConfigDirectories,
  probeFolder: async (targetPath) => {
    const realPath = await fs.realpath(targetPath);
    return { realPath, isDirectory: (await fs.stat(realPath)).isDirectory() };
  },
  readFolderNames: (folderPath) => fs.readdir(folderPath),
  listMountPoints: readMachineMountPoints,
  targetProbeTimeoutMs: TARGET_PROBE_TIMEOUT_MS,
  slowCallTimeoutMs: SLOW_CALL_TIMEOUT_MS,
  monotonicNow: () => performance.now(),
  createMountId: () => randomUUID(),
  now: () => new Date(),
  logWarning: (message, error) => (error === undefined ? console.warn(message) : console.warn(message, error)),
};

function readErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : null;
}

function mountError(message: string, code: string, statusCode = 400): AppError {
  return new AppError(message, { code, statusCode });
}

/** A folder whose probe the mount gate did not start in time (see `TargetProbe`): worth another try soon. */
function folderBusy(folderPath: string): AppError {
  return mountError(
    `Folder could not be checked in time (its disk is busy, or offline network shares hold up the checks); try again shortly: ${folderPath}`,
    'MOUNT_TARGET_NOT_FOUND',
  );
}

function comparablePath(candidatePath: string): string {
  const normalized = normalizeProjectPath(candidatePath);
  return IS_WINDOWS ? normalized.toLowerCase() : normalized;
}

function isSamePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function isSameOrInside(candidatePath: string, parentPath: string): boolean {
  const candidate = comparablePath(candidatePath);
  const parent = comparablePath(parentPath);
  if (candidate === parent) {
    return true;
  }
  return candidate.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
}

function isStrictlyInside(candidatePath: string, parentPath: string): boolean {
  return !isSamePath(candidatePath, parentPath) && isSameOrInside(candidatePath, parentPath);
}

function isFilesystemRoot(candidatePath: string): boolean {
  const normalized = normalizeProjectPath(candidatePath);
  return path.parse(normalized).root === normalized;
}

function isInsideSystemRoot(candidatePath: string, systemRoots: string[]): boolean {
  const normalized = normalizeProjectPath(candidatePath);
  if (IS_WINDOWS) {
    const [firstFolder] = path.relative(path.parse(normalized).root, normalized).split(path.sep);
    return WINDOWS_SYSTEM_FOLDER_NAMES.has((firstFolder ?? '').toLowerCase());
  }
  return POSIX_LIB_ROOT_PATTERN.test(normalized)
    || systemRoots.some((root) => isSameOrInside(normalized, root));
}

function isInsideAllowedException(candidatePath: string, allowedExceptions: string[]): boolean {
  return allowedExceptions.some((allowed) => isSameOrInside(candidatePath, allowed));
}

function isAncestorOfAllowedException(candidatePath: string, allowedExceptions: string[]): boolean {
  return allowedExceptions.some((allowed) => isStrictlyInside(allowed, candidatePath));
}

/**
 * `candidatePath` as the disk resolves it: the realpath of its longest part
 * that exists, with the rest appended, so a folder that does not exist yet (a
 * home without ~/.aws) still resolves through a linked parent. Null when that
 * spells the same path, or is a filesystem root, which would block everything.
 */
async function resolveOnDisk(candidatePath: string): Promise<string | null> {
  const writtenPath = normalizeProjectPath(path.resolve(candidatePath));
  const missingNames: string[] = [];
  let existingPath = writtenPath;
  for (;;) {
    let realPath: string;
    try {
      realPath = await fs.realpath(existingPath);
    } catch (error) {
      const code = readErrorCode(error);
      const parentPath = path.dirname(existingPath);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parentPath === existingPath) {
        return null;
      }
      missingNames.unshift(path.basename(existingPath));
      existingPath = parentPath;
      continue;
    }
    const resolvedPath = normalizeProjectPath(path.join(realPath, ...missingNames));
    return isSamePath(resolvedPath, writtenPath) || isFilesystemRoot(resolvedPath) ? null : resolvedPath;
  }
}

/** `paths` as written, followed by each one's resolved spelling where it differs. */
async function withResolvedSpellings(paths: string[]): Promise<string[]> {
  const writtenPaths = paths.map((candidatePath) => normalizeProjectPath(path.resolve(candidatePath)));
  const resolvedPaths = await Promise.all(writtenPaths.map(resolveOnDisk));
  return [...writtenPaths, ...resolvedPaths.filter((resolvedPath): resolvedPath is string => resolvedPath !== null)];
}

function hasControlCharacters(candidatePath: string): boolean {
  return CONTROL_CHARACTER_PATTERN.test(candidatePath);
}

function expandHomePath(inputPath: string, homeDirectory: string): string {
  if (inputPath === '~') {
    return homeDirectory;
  }
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(homeDirectory, inputPath.slice(2));
  }
  return inputPath;
}

/**
 * The name of a mount: one folder name that every platform accepts, and
 * neither the sentinel's nor `.git`.
 */
function validateMountName(rawName: unknown): string {
  const invalidName = (message: string) => mountError(message, 'INVALID_MOUNT_NAME');
  if (typeof rawName !== 'string') {
    throw invalidName('Mount name is required');
  }

  let name: string;
  try {
    name = sanitizeLeafDirectoryName(rawName, 'mount name');
  } catch (error) {
    throw invalidName(error instanceof Error ? error.message : 'Invalid mount name');
  }

  if (name.length > MAXIMUM_MOUNT_NAME_LENGTH) {
    throw invalidName(`Mount name is longer than ${MAXIMUM_MOUNT_NAME_LENGTH} characters`);
  }
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) {
    throw invalidName('Mount name contains characters a folder name cannot have');
  }
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(name)) {
    throw invalidName('Mount name is a reserved name');
  }
  if (/^\.+$/.test(name) || /[. ]$/.test(name)) {
    throw invalidName('Mount name cannot be only dots or end with a dot or a space');
  }
  // A link named .git to a git directory turns mounts/ into a nested
  // repository, whose own files git reads instead of the sentinel, so the
  // repository would pick mounts/ up. Compared case-insensitively, as macOS
  // and Windows match file names.
  if (RESERVED_MOUNT_NAMES.has(name.toLowerCase())) {
    throw invalidName(`"${name}" is reserved in the mounts folder`);
  }
  return name;
}

/**
 * Creates the mounts workflows: listing and reconciling, mount, adopt,
 * unmount, repair, the folder browser for picking a target, the directories a
 * runtime hands its CLI, and the cleanup when a project is deleted for good.
 * The disk is the source of truth; every answer reflects what is on it now.
 * Builds the production instance below; tests build their own with a home
 * folder of their own.
 */
export function createProjectMountsService(dependencyOverrides: Partial<ProjectMountsServiceDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  // Every call into a target goes through this gate: the probes here, and
  // the File Tree's reads and walks through runInMountTarget. Shared by every
  // caller of this instance (the File Tree's listings, the runtimes' turn
  // starts, the mount routes), so what it learns about a share holds for all.
  const gate = createMountGate({
    listMountPoints: dependencies.listMountPoints,
    timeoutMs: dependencies.targetProbeTimeoutMs,
    slowCallTimeoutMs: dependencies.slowCallTimeoutMs,
    monotonicNow: dependencies.monotonicNow,
    logWarning: (message) => dependencies.logWarning(message),
  });
  // Target probes still out, by comparable path, so a target that several
  // callers ask about at once is probed once; and each target's last answer
  // (null: it did not resolve), oldest first, which a probe that comes back
  // busy reads as.
  const pendingTargetProbes = new Map<string, Promise<TargetProbe>>();
  const lastAnswers = new Map<string, FolderProbe | null>();

  function rememberAnswer(key: string, answer: FolderProbe | null): void {
    lastAnswers.delete(key);
    if (lastAnswers.size >= MAXIMUM_REMEMBERED_ANSWERS) {
      const oldest = lastAnswers.keys().next();
      if (!oldest.done) {
        lastAnswers.delete(oldest.value);
      }
    }
    lastAnswers.set(key, answer);
  }

  async function readBlockedPaths(): Promise<BlockedPaths> {
    const [sensitive, systemRoots, allowedExceptions] = await Promise.all([
      withResolvedSpellings([
        ...SENSITIVE_HOME_FOLDER_NAMES.map((name) => path.join(dependencies.homeDirectory, name)),
        ...dependencies.listAppDataDirectories(),
        ...dependencies.listAgentConfigDirectories(),
      ]),
      IS_WINDOWS ? [] : withResolvedSpellings(POSIX_SYSTEM_ROOTS),
      withResolvedSpellings(ALLOWED_INSIDE_SYSTEM_ROOTS),
    ]);
    return { sensitive, systemRoots, allowedExceptions };
  }

  /** Whether the folder browser refuses to list `candidatePath`: a system folder or a sensitive home folder. */
  function isBrowseForbidden(candidatePath: string, blockedPaths: BlockedPaths): boolean {
    if (blockedPaths.sensitive.some((directory) => isSameOrInside(candidatePath, directory))) {
      return true;
    }
    if (
      isInsideAllowedException(candidatePath, blockedPaths.allowedExceptions)
      || isAncestorOfAllowedException(candidatePath, blockedPaths.allowedExceptions)
    ) {
      return false;
    }
    return isInsideSystemRoot(candidatePath, blockedPaths.systemRoots);
  }

  /**
   * The folders and links the folder browser lists in `realPath`, a folder
   * on a local disk: streamed with opendir, which stops at the caps.
   */
  async function listLocalFolderEntries(realPath: string, blockedPaths: BlockedPaths): Promise<BrowseEntry[]> {
    const entries: BrowseEntry[] = [];
    let entriesRead = 0;
    for await (const entry of await fs.opendir(realPath)) {
      entriesRead += 1;
      if (entriesRead > MAXIMUM_BROWSE_ENTRIES_READ || entries.length >= MAXIMUM_BROWSE_DIRECTORIES) {
        break;
      }
      const entryPath = path.join(realPath, entry.name);
      if ((entry.isDirectory() || entry.isSymbolicLink()) && !isBrowseForbidden(entryPath, blockedPaths)) {
        entries.push({ name: entry.name, path: entryPath, isSymbolicLink: entry.isSymbolicLink() });
      }
    }
    return entries;
  }

  /**
   * The same for a folder on a network share, from its `names`: each
   * entry's type comes from its own lstat through the gate, by the entry's
   * path (a share mounted on it is a share of its own), one after another,
   * as the gate runs one call at a time on a share anyway. Asked by the
   * user like the folder's probe, so a time-out moments ago does not stop
   * them. An entry whose lstat does not answer is left out, like a link
   * whose probe does not; once the share stops answering, the rest come
   * back at once.
   */
  async function listSharedFolderEntries(
    realPath: string,
    names: string[],
    blockedPaths: BlockedPaths,
  ): Promise<BrowseEntry[]> {
    const entries: BrowseEntry[] = [];
    for (const name of names.slice(0, MAXIMUM_BROWSE_ENTRIES_READ)) {
      if (entries.length >= MAXIMUM_BROWSE_DIRECTORIES) {
        break;
      }
      const entryPath = path.join(realPath, name);
      if (isBrowseForbidden(entryPath, blockedPaths)) {
        continue;
      }
      const lstat = await gate.run(entryPath, () => fs.lstat(entryPath), { retryNow: true });
      if (lstat.kind === 'done' && (lstat.value.isDirectory() || lstat.value.isSymbolicLink())) {
        entries.push({ name, path: entryPath, isSymbolicLink: lstat.value.isSymbolicLink() });
      }
    }
    return entries;
  }

  /**
   * Whether a mount may not point at `candidatePath`: a filesystem root, a
   * system folder, a sensitive home folder, or a folder that holds one of
   * those (the home folder itself, /var). Read on both the path as given and
   * its realpath, against both spellings of every blocked place.
   */
  function isTargetForbidden(candidatePath: string, blockedPaths: BlockedPaths): boolean {
    if (isFilesystemRoot(candidatePath)) {
      return true;
    }
    if (blockedPaths.sensitive.some((directory) => isSameOrInside(candidatePath, directory)
      || isStrictlyInside(directory, candidatePath))) {
      return true;
    }
    if (isInsideAllowedException(candidatePath, blockedPaths.allowedExceptions)) {
      return false;
    }
    if (isInsideSystemRoot(candidatePath, blockedPaths.systemRoots)) {
      return true;
    }
    return blockedPaths.systemRoots.some((root) => isStrictlyInside(root, candidatePath));
  }

  /**
   * Walks `walk` along its names while they lie on `share` (see
   * runWhereItLands): a name that is a link gives way to where it leads,
   * walked from its root. Ends at a name on another share, with no name
   * left, or once the walk stops.
   */
  async function followLinksOnShare(walk: LinkWalk, share: string): Promise<void> {
    while (!walk.stopped && walk.pending.length > 0) {
      const candidate = path.join(walk.resolved, walk.pending[0]);
      if (await gate.shareOf(candidate) !== share) {
        return;
      }
      let linkText: string | null;
      try {
        linkText = (await fs.lstat(candidate)).isSymbolicLink() ? await fs.readlink(candidate) : null;
      } catch {
        // A name that does not resolve: the call itself says what is wrong.
        walk.stopped = true;
        return;
      }
      if (linkText === null) {
        walk.resolved = candidate;
        walk.pending.shift();
        continue;
      }
      if (walk.hops >= MAXIMUM_LINK_HOPS) {
        walk.stopped = true;
        return;
      }
      walk.hops += 1;
      const next = normalizeProjectPath(path.resolve(walk.resolved, linkText));
      const { root } = path.parse(next);
      walk.resolved = root;
      walk.pending = [...path.relative(root, next).split(path.sep).filter(Boolean), ...walk.pending.slice(1)];
    }
  }

  /**
   * Runs `operation`, a call on `candidatePath`, through the mount gate on
   * the share the path really lands on. A link in the path may lead onto
   * another share, and a call that hangs there would count against the
   * share the path is written on: a link in a target to a dead network share
   * would make every target on that disk read as unreachable, or, on a local
   * disk, which the gate does not hold back, leave the call to hang unseen.
   * So the names below `resolvedPrefix` (a part of the path known to hold no
   * link) are walked one share at a time, each step through the gate on its
   * own share: lstat and readlink read a link where it sits, never where it
   * points, and a name on another share (where a link leads, or a mount
   * point) ends the step. The step that walks to the end runs `operation`
   * in the same call.
   */
  async function runWhereItLands<T>(
    candidatePath: string,
    resolvedPrefix: string,
    operation: (call: MountCall) => Promise<T>,
    options: { retryNow?: boolean; signal?: AbortSignal; slow?: boolean } = {},
  ): Promise<MountCallOutcome<T>> {
    const target = normalizeProjectPath(path.resolve(candidatePath));
    const prefix = normalizeProjectPath(path.resolve(resolvedPrefix));
    const walk: LinkWalk = isSameOrInside(target, prefix)
      ? { resolved: prefix, pending: path.relative(prefix, target).split(path.sep).filter(Boolean), hops: 0, stopped: false }
      : { resolved: target, pending: [], hops: 0, stopped: true };
    for (;;) {
      const stepPath = walk.pending.length > 0 ? path.join(walk.resolved, walk.pending[0]) : walk.resolved;
      const step = await gate.run(stepPath, async (call): Promise<{ landed: true; value: T } | { landed: false }> => {
        await followLinksOnShare(walk, await gate.shareOf(stepPath));
        return walk.stopped || walk.pending.length === 0
          ? { landed: true, value: await operation(call) }
          : { landed: false };
      }, options);
      if (step.kind !== 'done') {
        return step;
      }
      if (step.value.landed) {
        return { kind: 'done', value: step.value.value };
      }
    }
  }

  /**
   * Resolves a target (realpath, then stat) through the mount gate, on the
   * share it really lands on (see runWhereItLands; `resolvedPrefix`, a part
   * of its path known to hold no link, is not walked again). A target
   * already being probed shares that probe; one whose share does not answer
   * reads as unreachable at once. `retryNow` (a user asking to mount or
   * repair) starts its own probe and skips the wait after a share's
   * time-out, but the gate still never starts a call beside one that hangs.
   */
  async function probeTarget(
    targetPath: string,
    options: { retryNow?: boolean; resolvedPrefix?: string } = {},
  ): Promise<TargetProbe> {
    const key = comparablePath(targetPath);
    const pending = pendingTargetProbes.get(key);
    if (pending && !options.retryNow) {
      return pending;
    }
    const probe = (async (): Promise<TargetProbe> => {
      const outcome = await runWhereItLands(
        targetPath,
        options.resolvedPrefix ?? path.parse(targetPath).root,
        () => dependencies.probeFolder(targetPath),
        { retryNow: options.retryNow },
      );
      if (outcome.kind === 'unreachable' || outcome.kind === 'busy') {
        return { kind: outcome.kind };
      }
      if (outcome.kind === 'failed') {
        rememberAnswer(key, null);
        return { kind: 'missing' };
      }
      const realPath = normalizeProjectPath(outcome.value.realPath);
      rememberAnswer(key, { realPath, isDirectory: outcome.value.isDirectory });
      return outcome.value.isDirectory ? { kind: 'directory', realPath } : { kind: 'not-directory', realPath };
    })();
    pendingTargetProbes.set(key, probe);
    void probe.finally(() => {
      if (pendingTargetProbes.get(key) === probe) {
        pendingTargetProbes.delete(key);
      }
    });
    return probe;
  }

  /** The project folder as stored and as resolved: a target may be neither, nor inside or above either. */
  async function resolveProjectRoots(projectRoot: string): Promise<string[]> {
    const roots = [normalizeProjectPath(path.resolve(projectRoot))];
    try {
      const realRoot = normalizeProjectPath(await fs.realpath(projectRoot));
      if (!roots.some((root) => isSamePath(root, realRoot))) {
        roots.push(realRoot);
      }
    } catch {
      // A missing project folder is reported by the caller that needs it.
    }
    return roots;
  }

  function loopsWithProject(candidatePath: string, projectRoots: string[]): boolean {
    return projectRoots.some((root) => isSameOrInside(candidatePath, root) || isStrictlyInside(root, candidatePath));
  }

  function requireProjectRoot(projectId: string): string {
    const projectRoot = dependencies.resolveProjectPathById(projectId);
    if (!projectRoot) {
      throw mountError(`Unknown projectId: ${projectId}`, 'PROJECT_NOT_FOUND', 404);
    }
    return projectRoot;
  }

  async function requireProjectDirectory(projectRoot: string): Promise<void> {
    try {
      if ((await fs.stat(projectRoot)).isDirectory()) {
        return;
      }
    } catch {
      // Reported below.
    }
    throw mountError(`Project path not found: ${projectRoot}`, 'PROJECT_PATH_NOT_FOUND', 404);
  }

  function requireMount(projectId: string, mountId: string): ProjectMountRecord {
    const record = dependencies.mounts.getById(mountId);
    if (!record || record.projectId !== projectId) {
      throw mountError('Mount not found', 'MOUNT_NOT_FOUND', 404);
    }
    return record;
  }

  function mountsDirectoryOf(projectRoot: string): string {
    return path.join(projectRoot, PROJECT_MOUNTS_DIRECTORY_NAME);
  }

  function linkPathOf(projectRoot: string, name: string): string {
    return path.join(mountsDirectoryOf(projectRoot), name);
  }

  /** An absolute target path from what the client sent, with `~` expanded; not resolved yet. */
  function parseTargetPath(rawTargetPath: unknown): string {
    if (typeof rawTargetPath !== 'string' || !rawTargetPath.trim()) {
      throw mountError('Choose the folder to mount', 'MOUNT_TARGET_NOT_FOUND');
    }
    const expandedPath = expandHomePath(rawTargetPath.trim(), dependencies.homeDirectory);
    if (!path.isAbsolute(expandedPath)) {
      throw mountError('Choose the folder to mount by its absolute path', 'MOUNT_TARGET_NOT_FOUND');
    }
    return normalizeProjectPath(path.resolve(expandedPath));
  }

  /**
   * Checks a target against the mount rules and returns its realpath. The
   * path as given is checked before anything on disk is touched, so a
   * pseudo-filesystem is never even stat'ed.
   */
  async function validateTarget(targetPath: string, projectRoots: string[]): Promise<string> {
    const forbidden = () => mountError(
      'This folder cannot be mounted: it is a system folder, holds credentials or settings, or contains such folders',
      'MOUNT_TARGET_FORBIDDEN',
    );
    const loop = () => mountError(
      'A mount cannot point at the project, a folder inside it, or a folder that contains it',
      'MOUNT_TARGET_LOOP',
    );
    const controlCharacters = () => mountError(
      'A folder whose path holds a line break or another control character cannot be mounted',
      'MOUNT_TARGET_FORBIDDEN',
    );
    if (hasControlCharacters(targetPath)) {
      throw controlCharacters();
    }
    const blockedPaths = await readBlockedPaths();
    if (isTargetForbidden(targetPath, blockedPaths)) {
      throw forbidden();
    }
    if (loopsWithProject(targetPath, projectRoots)) {
      throw loop();
    }

    const target = await probeTarget(targetPath, { retryNow: true });
    if (target.kind === 'unreachable') {
      throw mountError(`Folder does not answer (an offline network share?): ${targetPath}`, 'MOUNT_TARGET_NOT_FOUND');
    }
    if (target.kind === 'busy') {
      throw folderBusy(targetPath);
    }
    if (target.kind === 'missing') {
      throw mountError(`Folder not found: ${targetPath}`, 'MOUNT_TARGET_NOT_FOUND');
    }
    if (target.kind === 'not-directory') {
      throw mountError(`Not a folder: ${targetPath}`, 'MOUNT_TARGET_NOT_DIRECTORY');
    }
    if (hasControlCharacters(target.realPath)) {
      throw controlCharacters();
    }
    if (isTargetForbidden(target.realPath, blockedPaths)) {
      throw forbidden();
    }
    if (loopsWithProject(target.realPath, projectRoots)) {
      throw loop();
    }
    return target.realPath;
  }

  async function readSentinelState(mountsDirectory: string): Promise<SentinelState> {
    const sentinelPath = path.join(mountsDirectory, SENTINEL_FILE_NAME);
    try {
      const stats = await fs.lstat(sentinelPath);
      if (stats.isSymbolicLink()) {
        return { kind: 'link', ignoresEverything: false };
      }
      if (!stats.isFile()) {
        return { kind: 'foreign', ignoresEverything: false };
      }
      const lines = (await fs.readFile(sentinelPath, 'utf8'))
        .split(/\r?\n/)
        .map((line) => line.trim());
      return lines.includes(SENTINEL_MARKER)
        ? { kind: 'ours', ignoresEverything: lines.includes('*') }
        : { kind: 'foreign', ignoresEverything: false };
    } catch (error) {
      const code = readErrorCode(error);
      return { kind: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'foreign', ignoresEverything: false };
    }
  }

  async function inspectLink(linkPath: string): Promise<LinkState> {
    let stats;
    try {
      stats = await fs.lstat(linkPath);
    } catch (error) {
      const code = readErrorCode(error);
      return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'missing' } : { kind: 'other' };
    }
    if (!stats.isSymbolicLink()) {
      return { kind: 'other' };
    }
    let rawTarget: string;
    try {
      rawTarget = await fs.readlink(linkPath);
    } catch (error) {
      // Removed or replaced between the two calls.
      return readErrorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'other' };
    }
    if (path.isAbsolute(rawTarget)) {
      return { kind: 'symlink', target: normalizeProjectPath(path.resolve(rawTarget)) };
    }
    // The system follows a relative link from the folder it really sits in,
    // and applies `..` after that folder's own links are resolved. Resolving
    // it against the path as written lands elsewhere when the project is
    // reached through a link (/home/u/proj -> /mnt/ssd/proj).
    const linkFolder = path.dirname(linkPath);
    const realLinkFolder = await fs.realpath(linkFolder).catch(() => linkFolder);
    return { kind: 'symlink', target: normalizeProjectPath(path.resolve(realLinkFolder, rawTarget)) };
  }

  /**
   * A target's last answer as a probe (see `lastAnswers`): what a probe that
   * came back busy reads as, unreachable when there is none to go by.
   */
  function lastAnswerOf(targetPath: string): Exclude<TargetProbe, { kind: 'busy' }> {
    const answer = lastAnswers.get(comparablePath(targetPath));
    if (answer === undefined) {
      return { kind: 'unreachable' };
    }
    if (answer === null) {
      return { kind: 'missing' };
    }
    return { kind: answer.isDirectory ? 'directory' : 'not-directory', realPath: answer.realPath };
  }

  /** What a target resolves to, checked against the mount rules. */
  function checkTarget(
    target: Exclude<TargetProbe, { kind: 'busy' }>,
    projectRoots: string[],
    blockedPaths: BlockedPaths,
  ): TargetState {
    if (target.kind === 'missing' || target.kind === 'unreachable') {
      return { kind: target.kind };
    }
    if (target.kind === 'not-directory') {
      return { kind: 'not-directory', realPath: target.realPath };
    }
    // A target that has turned into a place a mount may not point to (it was
    // replaced by a link into /etc, or to a folder whose name holds a line
    // break, or the project moved inside it) is treated as gone, so nothing
    // hands it on. Checked on every probe: a link can change at any time.
    if (
      hasControlCharacters(target.realPath)
      || isTargetForbidden(target.realPath, blockedPaths)
      || loopsWithProject(target.realPath, projectRoots)
    ) {
      return { kind: 'missing' };
    }
    return { kind: 'ok', realPath: target.realPath };
  }

  /**
   * Probes a target and checks it (checkTarget). `answered` is false when
   * the probe did not answer in time or never got its turn. Waiting too
   * long for a turn says nothing about the target, so such a target keeps
   * the state of its last answer: a healthy mount does not read as gone
   * while other shares hold up the gate. Every call into it still goes
   * through the gate, which answers busy until a turn comes.
   */
  async function inspectTarget(
    targetPath: string,
    projectRoots: string[],
    blockedPaths: BlockedPaths,
  ): Promise<{ target: TargetState; answered: boolean }> {
    const probed = await probeTarget(targetPath);
    return {
      target: checkTarget(probed.kind === 'busy' ? lastAnswerOf(targetPath) : probed, projectRoots, blockedPaths),
      answered: probed.kind !== 'busy' && probed.kind !== 'unreachable',
    };
  }

  /** Whether git tracks anything at `mounts`, which the sentinel could not hide. */
  async function isMountsDirectoryTracked(projectRoot: string): Promise<boolean> {
    const result = await dependencies.runGit(['ls-files', '-z', '--', PROJECT_MOUNTS_DIRECTORY_NAME], projectRoot);
    return result.code === 0 && result.stdout.length > 0;
  }

  /**
   * The names among `names` whose link git ignores, or null outside a git
   * repository (or when git cannot run), where the sentinel alone decides.
   */
  async function readGitIgnoredNames(projectRoot: string, names: string[]): Promise<Set<string> | null> {
    const linkPaths = names.map((name) => `${PROJECT_MOUNTS_DIRECTORY_NAME}/${name}`);
    // One path per line, unquoted: a mount name holds no control character,
    // quote or backslash, the only things git would still quote. (-z works
    // only with --stdin.) A link git tracks is never reported as ignored.
    const result = await dependencies.runGit(
      ['-c', 'core.quotePath=false', 'check-ignore', '--', ...linkPaths],
      projectRoot,
    );
    if (result.code === 1) {
      return new Set();
    }
    if (result.code !== 0) {
      return null;
    }
    const prefix = `${PROJECT_MOUNTS_DIRECTORY_NAME}/`;
    return new Set(result.stdout
      .split(/\r?\n/)
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => entry.slice(prefix.length)));
  }

  async function inspectMounts(
    projectRoot: string,
    records: ProjectMountRecord[],
    options: { checkGit: boolean },
  ): Promise<InspectedMount[]> {
    if (records.length === 0) {
      return [];
    }
    const [projectRoots, blockedPaths] = await Promise.all([resolveProjectRoots(projectRoot), readBlockedPaths()]);
    const sentinel = await readSentinelState(mountsDirectoryOf(projectRoot));
    const sentinelIgnoresLinks = sentinel.kind === 'ours' && sentinel.ignoresEverything;
    const gitIgnoredNames = options.checkGit && sentinelIgnoresLinks
      ? await readGitIgnoredNames(projectRoot, records.map((record) => record.name))
      : null;

    return Promise.all(records.map(async (record): Promise<InspectedMount> => {
      const { target, answered } = await inspectTarget(record.targetPath, projectRoots, blockedPaths);
      const link = await inspectLink(linkPathOf(projectRoot, record.name));
      const linkInPlace = link.kind === 'symlink' && isSamePath(link.target, record.targetPath);

      let status: ProjectMountStatus;
      // A target that does not answer reads as gone: nothing may walk, read
      // or hand on a folder whose every access would hang.
      if (target.kind === 'missing' || target.kind === 'unreachable') {
        status = 'missing-target';
      } else if (target.kind === 'not-directory') {
        status = 'not-directory';
      } else if (link.kind === 'missing') {
        status = 'missing-link';
      } else if (!linkInPlace) {
        status = 'link-mismatch';
      } else if (!sentinelIgnoresLinks || (gitIgnoredNames && !gitIgnoredNames.has(record.name))) {
        status = 'not-ignored';
      } else {
        status = 'ok';
      }

      return {
        mount: {
          mountId: record.mountId,
          name: record.name,
          linkPath: `${PROJECT_MOUNTS_DIRECTORY_NAME}/${record.name}`,
          targetPath: record.targetPath,
          realTargetPath: target.kind === 'ok' || target.kind === 'not-directory' ? target.realPath : null,
          status,
          createdAt: record.createdAt,
        },
        targetUnanswered: !answered,
        linkInPlace,
      };
    }));
  }

  async function reconcileMounts(
    projectRoot: string,
    records: ProjectMountRecord[],
    options: { checkGit: boolean },
  ): Promise<ProjectMount[]> {
    return (await inspectMounts(projectRoot, records, options)).map(({ mount }) => mount);
  }

  function mountsDirectoryInUse(): AppError {
    return mountError(
      'The project already has a "mounts" folder of its own; rename it to add mounts',
      'MOUNTS_DIR_IN_USE',
      409,
    );
  }

  /**
   * Writes the sentinel, first removing the file or link in its place when
   * `replace` is set. It is created exclusively ('wx'), which fails on any
   * entry already there, a dangling link included, so the write never
   * follows a link out of the project.
   */
  async function writeSentinel(mountsDirectory: string, replace: boolean): Promise<void> {
    const sentinelPath = path.join(mountsDirectory, SENTINEL_FILE_NAME);
    if (replace) {
      try {
        await fs.unlink(sentinelPath);
      } catch (error) {
        if (readErrorCode(error) !== 'ENOENT') {
          throw error;
        }
      }
    }
    try {
      await fs.writeFile(sentinelPath, SENTINEL_CONTENT, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      // Something took its place in between.
      if (readErrorCode(error) === 'EEXIST') {
        throw mountsDirectoryInUse();
      }
      throw error;
    }
  }

  /**
   * Makes sure `mounts/` exists with an intact sentinel. Refuses a folder
   * git tracks and a folder of the user's own: one that is a link or a file,
   * holds a `.gitignore` that is not ours, or holds anything but links.
   */
  async function prepareMountsDirectory(projectRoot: string): Promise<void> {
    if (await isMountsDirectoryTracked(projectRoot)) {
      throw mountError(
        'Git tracks files in the project\'s "mounts" folder, so mounts cannot be kept out of the repository there',
        'MOUNTS_DIR_TRACKED',
        409,
      );
    }

    const mountsDirectory = mountsDirectoryOf(projectRoot);
    let stats;
    try {
      stats = await fs.lstat(mountsDirectory);
    } catch (error) {
      if (readErrorCode(error) !== 'ENOENT') {
        throw error;
      }
      await fs.mkdir(mountsDirectory);
      await writeSentinel(mountsDirectory, false);
      return;
    }
    if (!stats.isDirectory()) {
      throw mountsDirectoryInUse();
    }

    const sentinel = await readSentinelState(mountsDirectory);
    if (sentinel.kind === 'foreign') {
      throw mountsDirectoryInUse();
    }
    if (sentinel.kind === 'ours') {
      if (!sentinel.ignoresEverything) {
        await writeSentinel(mountsDirectory, true);
      }
      return;
    }
    // No sentinel, or a link in its place: an empty folder, or ours after the
    // sentinel alone was lost or replaced. A folder of nothing but links is
    // ours; a link where the sentinel goes is replaced, never written through.
    const entries = await fs.readdir(mountsDirectory, { withFileTypes: true });
    if (entries.some((entry) => !entry.isSymbolicLink())) {
      throw mountsDirectoryInUse();
    }
    await writeSentinel(mountsDirectory, sentinel.kind === 'link');
  }

  async function createLink(targetPath: string, linkPath: string): Promise<void> {
    try {
      // A junction needs no symlink rights on Windows; it takes a local absolute path.
      await fs.symlink(targetPath, linkPath, IS_WINDOWS ? 'junction' : 'dir');
    } catch (error) {
      if (readErrorCode(error) === 'EEXIST') {
        throw mountError(`Something is already at ${PROJECT_MOUNTS_DIRECTORY_NAME}/${path.basename(linkPath)}`, 'MOUNT_NAME_TAKEN', 409);
      }
      throw new AppError('Could not create the link to the folder', {
        code: 'MOUNT_LINK_FAILED',
        statusCode: 500,
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Removes the link at `linkPath` when it is a symlink to `targetPath`, and
   * nothing else: never a recursive delete, so what it points to is never
   * touched. Returns whether it removed one.
   */
  async function removeOwnLink(linkPath: string, targetPath: string): Promise<boolean> {
    const link = await inspectLink(linkPath);
    if (link.kind !== 'symlink' || !isSamePath(link.target, targetPath)) {
      return false;
    }
    try {
      await fs.unlink(linkPath);
      return true;
    } catch (error) {
      if (readErrorCode(error) === 'ENOENT') {
        return false;
      }
      throw new AppError('Could not remove the link to the folder', {
        code: 'MOUNT_LINK_FAILED',
        statusCode: 500,
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Removes `mounts/` once it holds nothing but our sentinel, so the last unmount leaves no trace. */
  async function removeEmptyMountsDirectory(projectRoot: string): Promise<void> {
    const mountsDirectory = mountsDirectoryOf(projectRoot);
    try {
      if (!(await fs.lstat(mountsDirectory)).isDirectory()) {
        return;
      }
      const entries = await fs.readdir(mountsDirectory);
      if (entries.length !== 1 || entries[0] !== SENTINEL_FILE_NAME) {
        return;
      }
      if ((await readSentinelState(mountsDirectory)).kind !== 'ours') {
        return;
      }
      await fs.unlink(path.join(mountsDirectory, SENTINEL_FILE_NAME));
      await fs.rmdir(mountsDirectory);
    } catch (error) {
      if (readErrorCode(error) !== 'ENOENT') {
        dependencies.logWarning(`[project-mounts] Could not tidy up ${mountsDirectory}:`, error);
      }
    }
  }

  async function listAdoptableLinks(projectRoot: string, registeredNames: Set<string>): Promise<AdoptableProjectMount[]> {
    const mountsDirectory = mountsDirectoryOf(projectRoot);
    let entries;
    try {
      if (!(await fs.lstat(mountsDirectory)).isDirectory()) {
        return [];
      }
      entries = await fs.readdir(mountsDirectory, { withFileTypes: true });
    } catch {
      return [];
    }

    const adoptable: AdoptableProjectMount[] = [];
    for (const entry of entries) {
      if (!entry.isSymbolicLink() || registeredNames.has(entry.name)) {
        continue;
      }
      try {
        validateMountName(entry.name);
        const link = await inspectLink(path.join(mountsDirectory, entry.name));
        if (link.kind === 'symlink') {
          adoptable.push({ name: entry.name, targetPath: link.target });
        }
      } catch {
        // A name no mount could have, or a link that vanished meanwhile.
      }
    }
    return adoptable.sort((left, right) => left.name.localeCompare(right.name));
  }

  function insertRecord(record: ProjectMountRecord): void {
    try {
      dependencies.mounts.create(record);
    } catch (error) {
      if (readErrorCode(error) === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw mountError(`A mount named "${record.name}" already exists`, 'MOUNT_NAME_TAKEN', 409);
      }
      throw error;
    }
  }

  async function reconcileOne(projectRoot: string, record: ProjectMountRecord): Promise<ProjectMount> {
    const [mount] = await reconcileMounts(projectRoot, [record], { checkGit: true });
    return mount;
  }

  /**
   * Takes every link out of the mounts folder of the project at
   * `projectRoot`, inside `folder` (see detachMountLinks), and notes each in
   * `removedLinks`. A mounts folder that is not ours is left alone. Throws
   * when a link cannot be removed; putting the others back is the caller's.
   */
  async function takeOutMountLinks(folder: string, projectRoot: string, removedLinks: RemovedLink[]): Promise<void> {
    const mountsDirectory = mountsDirectoryOf(projectRoot);
    try {
      if (!(await fs.lstat(mountsDirectory)).isDirectory()) {
        return;
      }
    } catch (error) {
      const code = readErrorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return;
      }
      throw error;
    }
    const projectId = dependencies.resolveProjectIdByPath(projectRoot);
    const hasRegisteredMounts = projectId !== null && dependencies.mounts.listByProject(projectId).length > 0;
    if (!hasRegisteredMounts && (await readSentinelState(mountsDirectory)).kind !== 'ours') {
      return;
    }

    for (const name of await fs.readdir(mountsDirectory)) {
      const linkPath = path.join(mountsDirectory, name);
      try {
        if (!(await fs.lstat(linkPath)).isSymbolicLink()) {
          continue;
        }
        const linkText = await fs.readlink(linkPath);
        await fs.unlink(linkPath);
        removedLinks.push({ linkPath, linkText });
      } catch (error) {
        if (readErrorCode(error) === 'ENOENT') {
          continue;
        }
        throw new AppError(`Could not remove the link ${path.relative(folder, linkPath)} before deleting the folder`, {
          code: 'MOUNT_LINK_FAILED',
          statusCode: 500,
          details: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    /** GET /:projectId/mounts: every registered mount with its status, and the links that could be adopted. */
    async listMountsOverview(projectId: string): Promise<{ mounts: ProjectMount[]; adoptable: AdoptableProjectMount[] }> {
      const projectRoot = requireProjectRoot(projectId);
      const records = dependencies.mounts.listByProject(projectId);
      const [mounts, adoptable] = await Promise.all([
        reconcileMounts(projectRoot, records, { checkGit: true }),
        listAdoptableLinks(projectRoot, new Set(records.map((record) => record.name))),
      ]);
      return { mounts, adoptable };
    },

    /**
     * The project's mounts for the File Tree, without the git check: none for
     * a project that is not registered.
     */
    async listProjectMounts(projectId: string): Promise<ProjectMount[]> {
      const projectRoot = dependencies.resolveProjectPathById(projectId);
      if (!projectRoot) {
        return [];
      }
      return reconcileMounts(projectRoot, dependencies.mounts.listByProject(projectId), { checkGit: false });
    },

    /** POST /:projectId/mounts: links `mounts/<name>` to the target and registers it. */
    async createMount(projectId: string, input: { name: unknown; targetPath: unknown }): Promise<ProjectMount> {
      const projectRoot = requireProjectRoot(projectId);
      const name = validateMountName(input.name);
      if (dependencies.mounts.getByName(projectId, name)) {
        throw mountError(`A mount named "${name}" already exists`, 'MOUNT_NAME_TAKEN', 409);
      }
      const targetPath = parseTargetPath(input.targetPath);
      await requireProjectDirectory(projectRoot);
      await validateTarget(targetPath, await resolveProjectRoots(projectRoot));
      await prepareMountsDirectory(projectRoot);

      const linkPath = linkPathOf(projectRoot, name);
      const record: ProjectMountRecord = {
        mountId: dependencies.createMountId(),
        projectId,
        name,
        targetPath,
        createdAt: dependencies.now().toISOString(),
      };
      let linkCreated = false;
      try {
        await createLink(targetPath, linkPath);
        linkCreated = true;
        insertRecord(record);
      } catch (error) {
        // Nothing of the failed mount stays: its link, and the mounts folder
        // and sentinel prepared for it when no other mount needs them (a
        // filesystem without symlinks would otherwise keep an unexplained
        // folder, which the File Tree shows only while mounts exist).
        if (linkCreated) {
          await removeOwnLink(linkPath, targetPath).catch(() => false);
        }
        if (dependencies.mounts.listByProject(projectId).length === 0) {
          await removeEmptyMountsDirectory(projectRoot);
        }
        throw error;
      }
      return reconcileOne(projectRoot, record);
    },

    /** POST /:projectId/mounts/adopt: registers a link already in `mounts/`, as it points. */
    async adoptMount(projectId: string, input: { name: unknown }): Promise<ProjectMount> {
      const projectRoot = requireProjectRoot(projectId);
      const name = validateMountName(input.name);
      if (dependencies.mounts.getByName(projectId, name)) {
        throw mountError(`A mount named "${name}" already exists`, 'MOUNT_NAME_TAKEN', 409);
      }
      const link = await inspectLink(linkPathOf(projectRoot, name));
      if (link.kind !== 'symlink') {
        throw mountError(`No link named "${name}" in the mounts folder`, 'MOUNT_NOT_FOUND', 404);
      }
      await validateTarget(link.target, await resolveProjectRoots(projectRoot));
      await prepareMountsDirectory(projectRoot);

      const record: ProjectMountRecord = {
        mountId: dependencies.createMountId(),
        projectId,
        name,
        targetPath: link.target,
        createdAt: dependencies.now().toISOString(),
      };
      insertRecord(record);
      return reconcileOne(projectRoot, record);
    },

    /**
     * DELETE /:projectId/mounts/:mountId: removes the link when it is still
     * ours, then the row. `linkRemoved` is false when something else stood
     * at the link's place; it is left alone and the row dropped anyway.
     */
    async removeMount(projectId: string, mountId: string): Promise<{ removed: true; linkRemoved: boolean }> {
      const projectRoot = requireProjectRoot(projectId);
      const record = requireMount(projectId, mountId);
      const linkRemoved = await removeOwnLink(linkPathOf(projectRoot, record.name), record.targetPath);
      dependencies.mounts.delete(record.mountId);
      if (dependencies.mounts.listByProject(projectId).length === 0) {
        await removeEmptyMountsDirectory(projectRoot);
      }
      return { removed: true, linkRemoved };
    },

    /**
     * POST /:projectId/mounts/:mountId/repair: recreates the sentinel and the
     * link (after `git clean -fdx`, or a link pointed elsewhere). A real file
     * or folder at the link's place is never replaced.
     */
    async repairMount(projectId: string, mountId: string): Promise<ProjectMount> {
      const projectRoot = requireProjectRoot(projectId);
      const record = requireMount(projectId, mountId);
      await requireProjectDirectory(projectRoot);
      await validateTarget(record.targetPath, await resolveProjectRoots(projectRoot));
      await prepareMountsDirectory(projectRoot);

      const linkPath = linkPathOf(projectRoot, record.name);
      const link = await inspectLink(linkPath);
      if (link.kind === 'other') {
        throw mountError(
          `${record.name} in the mounts folder is a real file or folder now; move it away, or unmount`,
          'MOUNT_NAME_TAKEN',
          409,
        );
      }
      if (link.kind === 'symlink' && !isSamePath(link.target, record.targetPath)) {
        await fs.unlink(linkPath);
      }
      if (link.kind === 'missing' || !isSamePath(link.target, record.targetPath)) {
        await createLink(record.targetPath, linkPath);
      }
      return reconcileOne(projectRoot, record);
    },

    /**
     * GET /mount-browse: the folders in `inputPath` (the home folder when
     * empty) for picking a target. System folders and sensitive home folders
     * are left out and refused; the folders above them can be browsed.
     */
    async browseMountTargets(inputPath: string | null): Promise<{
      path: string;
      parent: string | null;
      directories: Array<{ name: string; path: string }>;
    }> {
      const requestedPath = inputPath?.trim()
        ? expandHomePath(inputPath.trim(), dependencies.homeDirectory)
        : dependencies.homeDirectory;
      if (!path.isAbsolute(requestedPath)) {
        throw mountError('Browse a folder by its absolute path', 'MOUNT_TARGET_NOT_FOUND');
      }
      const forbidden = () => mountError('This folder cannot be browsed for mounts', 'MOUNT_TARGET_FORBIDDEN');
      const normalizedPath = normalizeProjectPath(path.resolve(requestedPath));
      const blockedPaths = await readBlockedPaths();
      if (isBrowseForbidden(normalizedPath, blockedPaths)) {
        throw forbidden();
      }

      const folder = await probeTarget(normalizedPath, { retryNow: true });
      if (folder.kind === 'unreachable') {
        throw mountError(`Folder does not answer (an offline network share?): ${normalizedPath}`, 'MOUNT_TARGET_NOT_FOUND');
      }
      if (folder.kind === 'busy') {
        throw folderBusy(normalizedPath);
      }
      if (folder.kind === 'missing') {
        throw mountError(`Folder not found: ${normalizedPath}`, 'MOUNT_TARGET_NOT_FOUND');
      }
      if (folder.kind === 'not-directory') {
        throw mountError(`Not a folder: ${normalizedPath}`, 'MOUNT_TARGET_NOT_DIRECTORY');
      }
      const realPath = folder.realPath;
      if (isBrowseForbidden(realPath, blockedPaths)) {
        throw forbidden();
      }

      // Read through the gate on the folder's share. On a local disk it is
      // streamed. On a network share opendir would run a synchronous lstat
      // on the event loop for an entry whose type the share does not report,
      // which no time limit can stop; so the names come in one slow call,
      // and the entries' types after it (listSharedFolderEntries).
      const read = await gate.run(
        realPath,
        async (call): Promise<{ entries: BrowseEntry[] } | { names: string[] }> => (call.gated
          ? { names: await dependencies.readFolderNames(realPath) }
          : { entries: await listLocalFolderEntries(realPath, blockedPaths) }),
        { retryNow: true, slow: true },
      );
      if (read.kind === 'unreachable') {
        throw mountError(`Folder does not answer (an offline network share?): ${realPath}`, 'MOUNT_TARGET_NOT_FOUND');
      }
      if (read.kind === 'busy') {
        throw folderBusy(realPath);
      }
      if (read.kind === 'failed') {
        throw new AppError(`Folder cannot be read: ${realPath}`, {
          code: 'MOUNT_TARGET_NOT_FOUND',
          statusCode: 400,
          details: read.error instanceof Error ? read.error.message : String(read.error),
        });
      }
      const entries = 'entries' in read.value
        ? read.value.entries
        : await listSharedFolderEntries(realPath, read.value.names, blockedPaths);
      // Links are resolved together and through the probe, so links into a
      // share that hangs cost the request one time limit, not one each. Each
      // is probed on the share it leads to (runWhereItLands, from this
      // folder, which is resolved already), so a link into a dead share never
      // counts against the share of this folder.
      const listed = await Promise.all(entries.map(async (entry) => {
        if (!entry.isSymbolicLink) {
          return true;
        }
        const linked = await probeTarget(entry.path, { resolvedPrefix: realPath });
        return linked.kind === 'directory' && !isBrowseForbidden(linked.realPath, blockedPaths);
      }));
      const directories = entries
        .filter((_entry, index) => listed[index])
        .map((entry) => ({ name: entry.name, path: entry.path }));

      directories.sort((left, right) => {
        const leftHidden = left.name.startsWith('.');
        const rightHidden = right.name.startsWith('.');
        if (leftHidden !== rightHidden) {
          return leftHidden ? 1 : -1;
        }
        return left.name.localeCompare(right.name);
      });

      return {
        path: realPath,
        parent: isFilesystemRoot(realPath) ? null : path.dirname(realPath),
        directories,
      };
    },

    /**
     * The mounts a runtime hands its CLI for the project at `projectPath`,
     * by name: those whose link is in place and whose target resolves to an
     * existing folder outside the project, with the target's realpath; and,
     * with a null realpath, those whose link is in place but whose target
     * did not answer in time, or could not be probed for want of a turn (see
     * `ProjectMountDirectory`): a realpath only last known is not handed to
     * a new process, which could hang on it. None for a path that is not a
     * registered project.
     */
    async listProjectMountDirectories(projectPath: string): Promise<ProjectMountDirectory[]> {
      const normalizedPath = normalizeProjectPath(projectPath);
      const projectId = normalizedPath ? dependencies.resolveProjectIdByPath(normalizedPath) : null;
      if (!projectId) {
        return [];
      }
      const projectRoot = dependencies.resolveProjectPathById(projectId) ?? normalizedPath;
      const inspected = await inspectMounts(projectRoot, dependencies.mounts.listByProject(projectId), { checkGit: false });
      return inspected
        .flatMap(({ mount, targetUnanswered, linkInPlace }): ProjectMountDirectory[] => {
          const { mountId, name, linkPath } = mount;
          if (targetUnanswered) {
            return linkInPlace ? [{ mountId, name, linkPath, realTargetPath: null }] : [];
          }
          if ((mount.status === 'ok' || mount.status === 'not-ignored') && mount.realTargetPath !== null) {
            return [{ mountId, name, linkPath, realTargetPath: mount.realTargetPath }];
          }
          return [];
        })
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    },

    /**
     * Runs one filesystem call on `realPath`, a path in a mount's target as
     * it really is, through the mount gate the probes use (see
     * `MountCallOutcome`). With `followLinksBelow` (the part of `realPath`
     * known to hold no link, the target's realpath), the links in the rest
     * are followed first, so the call runs on the share it lands on (see
     * runWhereItLands). `signal` gives up on a call still waiting for its
     * turn; `slow` gives a whole folder read the slow call time limit.
     */
    runInMountTarget<T>(
      realPath: string,
      operation: (call: MountCall) => Promise<T>,
      options: { signal?: AbortSignal; followLinksBelow?: string; slow?: boolean } = {},
    ): Promise<MountCallOutcome<T>> {
      const gateOptions = { signal: options.signal, slow: options.slow };
      return options.followLinksBelow === undefined
        ? gate.run(realPath, operation, gateOptions)
        : runWhereItLands(realPath, options.followLinksBelow, operation, gateOptions);
    },

    /**
     * Whether a call on `absolutePath` would find its filesystem not
     * answering, as the mount gate knows it (see `FileTreeMountsGateway`).
     */
    isShareUnreachable(absolutePath: string): Promise<boolean> {
      return gate.isUnreachable(absolutePath);
    },

    /**
     * For a project deleted for good: removes each mount's link where it is
     * still ours (never what it points to), the rows, and the emptied
     * `mounts/` folder. Problems are logged, never thrown, so they cannot
     * stop the deletion.
     */
    async releaseProjectMounts(projectId: string, projectRoot: string): Promise<void> {
      const records = dependencies.mounts.listByProject(projectId);
      for (const record of records) {
        try {
          await removeOwnLink(linkPathOf(projectRoot, record.name), record.targetPath);
        } catch (error) {
          dependencies.logWarning(`[project-mounts] Could not remove the link of mount ${record.name}:`, error);
        }
      }
      dependencies.mounts.deleteByProject(projectId);
      if (records.length > 0) {
        await removeEmptyMountsDirectory(projectRoot);
      }
    },

    /**
     * Before something else deletes the folder at `projectPath` with all it
     * holds (git removing a worktree): takes every link out of its mounts
     * folder, and out of the mounts folder of every project registered
     * inside it (a package of a monorepo opened as a project of its own),
     * without following any. Git for Windows before 2.54 walks into a
     * junction while it deletes a worktree and removes the files in its
     * target. The rows stay, so a worktree opened again lists its mounts as
     * missing-link and Repair brings them back. A `mounts` folder that is
     * not ours (no sentinel of ours, no registered mount) is left to the
     * caller. Throws when a link cannot be removed, so the caller can stop
     * before the folder is deleted; the links taken out by then are put
     * back first. `reattach` puts the links taken out back as they were
     * (the same link text, relative or absolute), for when the folder is not
     * deleted after all; a place something else took meanwhile is left
     * alone, and problems are logged, never thrown.
     */
    async detachMountLinks(projectPath: string): Promise<{ reattach(): Promise<void> }> {
      const removedLinks: RemovedLink[] = [];
      const detached = {
        async reattach() {
          for (const { linkPath, linkText } of removedLinks.splice(0)) {
            try {
              await fs.symlink(linkText, linkPath, IS_WINDOWS ? 'junction' : 'dir');
            } catch (error) {
              if (readErrorCode(error) !== 'EEXIST') {
                dependencies.logWarning(`[project-mounts] Could not put the link ${linkPath} back:`, error);
              }
            }
          }
        },
      };

      const folder = normalizeProjectPath(projectPath);
      if (!folder) {
        return detached;
      }
      // The folder first, then the projects inside it, shortest path first,
      // so the links above a nested project are out before it is looked at.
      const projectRoots = new Map<string, string>([[comparablePath(folder), folder]]);
      for (const candidate of dependencies.listProjectPaths().map(normalizeProjectPath)) {
        if (candidate && isStrictlyInside(candidate, folder) && !projectRoots.has(comparablePath(candidate))) {
          projectRoots.set(comparablePath(candidate), candidate);
        }
      }
      try {
        for (const projectRoot of [...projectRoots.values()].sort((left, right) => left.length - right.length)) {
          await takeOutMountLinks(folder, projectRoot, removedLinks);
        }
      } catch (error) {
        await detached.reattach();
        throw error;
      }
      return detached;
    },
  };
}

/** The mounts workflows as the Projects routes, the project delete service and the barrel use them. */
export type ProjectMountsService = ReturnType<typeof createProjectMountsService>;

// The production instance: the Projects routes and the project delete service use it directly.
export const projectMountsService: ProjectMountsService = createProjectMountsService();

/**
 * The project's mounts as the Providers module's runtimes hand them to the
 * CLI (Claude's and Codex's additional directories, Claude's system prompt
 * lines). See the service method of the same name.
 */
export function listProjectMountDirectories(projectPath: string): Promise<ProjectMountDirectory[]> {
  return projectMountsService.listProjectMountDirectories(projectPath);
}

/**
 * The project's mounts, reconciled without the git check, for the File Tree:
 * it lists their links as folders, protects them and reads their targets.
 */
export function listProjectMounts(projectId: string): Promise<ProjectMount[]> {
  return projectMountsService.listProjectMounts(projectId);
}

/**
 * Runs one filesystem call in a mount's target through the mount gate, for
 * the File Tree's reads and walks in a mount. See the service method of the
 * same name.
 */
export function runInMountTarget<T>(
  realPath: string,
  operation: (call: MountCall) => Promise<T>,
  options?: { signal?: AbortSignal; followLinksBelow?: string; slow?: boolean },
): Promise<MountCallOutcome<T>> {
  return projectMountsService.runInMountTarget(realPath, operation, options);
}

/**
 * Whether the filesystem of `absolutePath` is known not to answer, for the
 * File Tree's reads by a path outside every mount, which it resolves
 * without the mount gate. See the service method of the same name.
 */
export function isMountShareUnreachable(absolutePath: string): Promise<boolean> {
  return projectMountsService.isShareUnreachable(absolutePath);
}

/**
 * Takes the mount links out of the project folder at `projectPath`, and out
 * of the projects registered inside it, before the Worktrees module has git
 * delete it, and puts them back when git does not. See the service method of
 * the same name.
 */
export function detachProjectMountLinks(projectPath: string): Promise<{ reattach(): Promise<void> }> {
  return projectMountsService.detachMountLinks(projectPath);
}
