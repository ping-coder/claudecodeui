import * as React from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { defaultFilter } from 'cmdk';
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  Check,
  ChevronRight,
  Columns2,
  CopyX,
  FileText,
  GitCommit,
  GitMerge,
  Maximize2,
  MessageSquare,
  MessageSquarePlus,
  Minimize2,
  PanelLeft,
  PanelRight,
  PanelRightClose,
  RefreshCw,
  Settings,
  SquareX,
  SunMoon,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/shared/ui';
import { useTheme } from '@/shared/context/ThemeContext';
import { usePaletteOps } from '@/modules/command-palette/context/PaletteOpsContext';
import {
  SETTINGS_MAIN_TABS,
  WORKSPACE_FOCUS_LEFT_PANE_SHORTCUT,
  WORKSPACE_FOCUS_RIGHT_PANE_SHORTCUT,
  WORKSPACE_FULLSCREEN_SHORTCUT,
  WORKSPACE_SPLIT_SHORTCUT,
} from '@/shared/constants';
import type {
  AppTab,
  CommandPaletteWorkspaceCommands,
  Project,
  SessionOpenOptions,
  WorkspaceOpenTabSummary,
} from '@/shared/types';
import { formatShortcut } from '@/shared/utils';
import { useSessionsSource } from '@/modules/command-palette/hooks/useSessionsSource';
import { useFilesSource } from '@/modules/command-palette/hooks/useFilesSource';
import { useFileSearch } from '@/modules/command-palette/hooks/useFileSearch';
import { useCommitsSource } from '@/modules/command-palette/hooks/useCommitsSource';
import { useSessionMessageSearch } from '@/modules/command-palette/hooks/useSessionMessageSearch';
import { useBranchesSource } from '@/modules/command-palette/hooks/useBranchesSource';
import { useGitActions } from '@/modules/command-palette/hooks/useGitActions';

type Page = 'actions' | 'files' | 'sessions' | 'commits' | 'branches';

/** How well a row's value matches the search, from 0 (hidden) to 1: the shape of cmdk's `filter`. */
type RowScorer = (value: string, search: string, keywords?: string[]) => number;

/** Where a file is, absolutely and from the project root: all that scoring it takes. */
type FilePaths = { path: string; relativePath: string };

/** One group of results, with what places it among the others while searching. */
type PaletteGroup = {
  id: string;
  /** The value of every row in the group that can be picked; disabled rows are left out. */
  values: string[];
  node: React.ReactNode;
};

type CommandPaletteProps = {
  selectedProject: Project | null;
  onStartNewChat: (project: Project) => void;
  onOpenSettings: (tab?: string) => void;
  onShowTab?: (tab: AppTab) => void;
  /** Replaces navigate('/session/:id'): Enter -> { target: 'focused', preview: false }, Ctrl/Cmd+Enter -> { target: 'other' }. */
  onOpenSession: (sessionId: string, options: SessionOpenOptions) => void;
  /** Split-workspace commands and open tabs; without it the Workspace and Open tabs groups are not offered. */
  workspace?: CommandPaletteWorkspaceCommands;
};

/** Picks a session result for the other pane instead of the focused one. Handled here, inside the palette. */
const OPEN_ON_OTHER_SIDE_SHORTCUT = ['mod', 'enter'] as const;

/**
 * Most file rows the files page renders. cmdk scores and re-sorts every rendered row on each
 * keystroke, so the rest are reached by typing; a note below the list says some are left out.
 */
const FILES_PAGE_LIMIT = 100;

const NAV_TABS: Array<{ id: AppTab; labelKey: string; keywords: string }> = [
  { id: 'chat', labelKey: 'commandPalette.navChat', keywords: 'chat messages conversation' },
  { id: 'files', labelKey: 'commandPalette.navFiles', keywords: 'files file tree explorer' },
  { id: 'shell', labelKey: 'commandPalette.navShell', keywords: 'shell terminal console' },
  { id: 'git', labelKey: 'commandPalette.navGit', keywords: 'git diff branches' },
  { id: 'tasks', labelKey: 'commandPalette.navTasks', keywords: 'tasks taskmaster' },
];

/**
 * Rendered by the project-workspace module to search projects, sessions, files, branches and commits
 * and run their actions, and to drive the split workspace: pane commands and the open tabs of both panes.
 */
function CommandPalette({
  selectedProject,
  onStartNewChat,
  onOpenSettings,
  onShowTab,
  onOpenSession,
  workspace,
}: CommandPaletteProps) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [pages, setPages] = React.useState<Page[]>([]);
  const { toggleDarkMode } = useTheme();
  const ops = usePaletteOps();
  // Whether Ctrl/Cmd is held in the gesture that is picking an item. cmdk calls onSelect from inside
  // its own Enter keydown handling or from the item's click, so the Command's keydown (which runs
  // before cmdk's) and the list's pointerdown (before the click) record it for onSelect to read.
  const primaryModifierRef = React.useRef(false);

  const page = pages.at(-1);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isCmdK = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k';
      if (!isCmdK) return;
      e.preventDefault();
      setOpen((prev) => !prev);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  React.useEffect(() => {
    if (!open) {
      setSearch('');
      setPages([]);
      primaryModifierRef.current = false;
    }
  }, [open]);

  const projectId = selectedProject?.projectId;

  const showActions = !page || page === 'actions';
  const showSessions = !page || page === 'sessions';
  const showFiles = !page || page === 'files';
  const showCommits = !page || page === 'commits';
  const showBranches = !page || page === 'branches' || page === 'actions';

  const sessions = useSessionsSource(projectId, open && showSessions);
  const messageMatches = useSessionMessageSearch(projectId, search, open && showSessions);
  const { files, tooLarge: filesTooLarge } = useFilesSource(projectId, open && showFiles);
  // A project too large to list is searched on the server, which sends back only the best matches.
  const fileSearch = useFileSearch(projectId, search, open && showFiles && filesTooLarge, FILES_PAGE_LIMIT);
  // The files a search ranks: every file of the project, or the server's best matches.
  const searchableFiles = filesTooLarge ? fileSearch.files : files;
  const commits = useCommitsSource(projectId, open && showCommits);
  const branches = useBranchesSource(projectId, open && showBranches);
  const git = useGitActions(projectId);

  const sessionRows = React.useMemo(() => {
    if (!showSessions) return [];
    type Row = { id: string; label: string; provider?: string; snippet?: string };
    const byId = new Map<string, Row>();
    for (const s of sessions) {
      byId.set(s.id, { id: s.id, label: s.label, provider: s.provider });
    }
    for (const m of messageMatches) {
      const existing = byId.get(m.sessionId);
      if (existing) {
        existing.snippet = m.snippet;
      } else {
        byId.set(m.sessionId, {
          id: m.sessionId,
          label: m.label,
          provider: m.provider,
          snippet: m.snippet,
        });
      }
    }
    return Array.from(byId.values());
  }, [sessions, messageMatches, showSessions]);

  // A file row's value is the file's absolute path, which no other row's value can equal; a relative
  // path could equal a branch name, and cmdk highlights and runs every row holding the selected
  // value. cmdk is handed this scorer, so files are still matched by their relative path.
  const filesByPath = React.useMemo(
    () => new Map(searchableFiles.map((f) => [f.path.trim(), f])),
    [searchableFiles],
  );
  const scoreRow = React.useCallback<RowScorer>(
    (value, query, keywords) => {
      const file = filesByPath.get(value);
      return file ? scoreFile(file, query) : defaultFilter(value, query, keywords);
    },
    [filesByPath],
  );

  const run = React.useCallback((fn: () => void) => {
    setOpen(false);
    fn();
  }, []);

  const pushPage = React.useCallback((next: Page) => {
    setSearch('');
    setPages((prev) => [...prev, next]);
  }, []);

  const popPage = React.useCallback(() => {
    setSearch('');
    setPages((prev) => prev.slice(0, -1));
  }, []);

  const handleKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      primaryModifierRef.current = e.metaKey || e.ctrlKey;
    }
    if (e.key === 'Backspace' && !search && pages.length > 0) {
      e.preventDefault();
      popPage();
    }
  }, [search, pages.length, popPage]);

  const recordPointerModifier = React.useCallback((e: React.PointerEvent) => {
    primaryModifierRef.current = e.metaKey || e.ctrlKey;
  }, []);

  // There is another pane to send a session to, or room to make one; otherwise Ctrl/Cmd+Enter opens
  // like a plain Enter.
  const canOpenOnOtherSide = Boolean(workspace && (workspace.canSplit || workspace.isSplit));

  const openSessionResult = React.useCallback((sessionId: string) => {
    const options: SessionOpenOptions = canOpenOnOtherSide && primaryModifierRef.current
      ? { target: 'other' }
      : { target: 'focused', preview: false };
    run(() => onOpenSession(sessionId, options));
  }, [canOpenOnOtherSide, onOpenSession, run]);

  const startNewChatDisabled = !selectedProject;
  const browseLimit = 5;
  // Gitignored files (CLAUDE.md, .env, logs) are found by searching, but are not
  // listed while the search is empty, so the palette never opens on `.env`.
  const unignoredFiles = React.useMemo(() => files.filter((f) => !f.isIgnored), [files]);
  // cmdk filters only the rows it is given, so with a search the palette ranks every file itself,
  // once per keystroke, and renders the best few (root page) or the best FILES_PAGE_LIMIT (files page).
  // The server's matches are ranked again too: those of the search before the last keystroke stay
  // until its answer lands, narrowed to what is typed now.
  const fileMatches = React.useMemo(
    () => (search ? rankPathMatches(searchableFiles, search) : null),
    [searchableFiles, search],
  );
  const fileCandidates = fileMatches ?? unignoredFiles;
  const filesShown = fileCandidates.slice(0, page === 'files' ? FILES_PAGE_LIMIT : browseLimit);
  // Below the list: why no file can be found, or that the files page leaves some out.
  let filesNote: string | null = null;
  if (showFiles && projectId) {
    if (filesTooLarge) {
      // Not while the search is empty: the palette is often opened for its actions.
      if (search && fileSearch.status === 'failed') {
        filesNote = t('commandPalette.filesTooLarge', {
          defaultValue: 'Files are not listed for projects with more than 10,000 entries. Open a smaller folder as the project, or ignore build output in the root .gitignore.',
        });
      } else if (search && fileSearch.status === 'pending') {
        filesNote = t('commandPalette.filesSearching', { defaultValue: 'Searching files…' });
      } else if (search && fileSearch.incomplete) {
        filesNote = t('commandPalette.filesSearchIncomplete', {
          defaultValue: 'Only part of this large project was searched, so some files may be missing. Open a smaller folder as the project, or ignore build output in the root .gitignore.',
        });
      }
    } else if (page === 'files' && fileCandidates.length > filesShown.length) {
      filesNote = search
        ? t('commandPalette.filesBestMatches', {
          shown: filesShown.length,
          defaultValue: 'Showing the {{shown}} best matches. Keep typing to narrow them down.',
        })
        : t('commandPalette.filesShownOf', {
          shown: filesShown.length,
          total: fileCandidates.length,
          defaultValue: 'Showing {{shown}} of {{total}} files. Type to find the rest.',
        });
    }
  }
  const commitsShown = page === 'commits' ? commits : commits.slice(0, browseLimit);
  const sessionsShown = page === 'sessions' ? sessionRows : sessionRows.slice(0, browseLimit);
  const branchesShown = page === 'branches' ? branches : branches.slice(0, browseLimit);

  // The root page's way into the full page of a kind of result, when it lists only part of them.
  const browseAllLabel = (labelKey: string, total: number) => (
    !page && total > browseLimit ? t(labelKey, { count: total }) : null
  );
  const withBrowseAll = (values: string[], label: string | null) => (label ? [...values, label] : values);

  // Every group this page shows, in their resting order.
  const groups: PaletteGroup[] = [];

  if (showActions) {
    const startNewChatValue = `${t('commandPalette.startNewChat')} new chat`;
    const openSettingsValue = `${t('commandPalette.openSettings')} settings`;
    const toggleThemeValue = `${t('commandPalette.toggleTheme')} dark light mode`;
    groups.push({
      id: 'actions',
      values: startNewChatDisabled
        ? [openSettingsValue, toggleThemeValue]
        : [startNewChatValue, openSettingsValue, toggleThemeValue],
      node: (
        <CommandGroup heading={t('commandPalette.groupActions')}>
          <CommandItem
            value={startNewChatValue}
            disabled={startNewChatDisabled}
            onSelect={() => {
              if (!selectedProject) return;
              run(() => onStartNewChat(selectedProject));
            }}
          >
            <MessageSquarePlus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex-1">{t('commandPalette.startNewChat')}</span>
            {startNewChatDisabled && (
              <span className="text-xs text-muted-foreground">{t('commandPalette.selectProjectFirst')}</span>
            )}
          </CommandItem>
          <CommandItem value={openSettingsValue} onSelect={() => run(() => onOpenSettings())}>
            <Settings className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex-1">{t('commandPalette.openSettings')}</span>
          </CommandItem>
          <CommandItem value={toggleThemeValue} onSelect={() => run(toggleDarkMode)}>
            <SunMoon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex-1">{t('commandPalette.toggleTheme')}</span>
          </CommandItem>
        </CommandGroup>
      ),
    });
  }

  if (showActions && workspace) {
    const commands = workspaceCommands(workspace, t);
    groups.push({
      id: 'workspace',
      values: commands.filter((command) => command.unavailableReason === undefined).map((command) => command.value),
      node: <WorkspaceCommandGroup commands={commands} run={run} />,
    });
  }

  if (showActions && workspace && workspace.openTabs.some((tab) => !tab.isActive)) {
    const rows = openTabRows(workspace, t);
    groups.push({
      id: 'open-tabs',
      values: rows.map((row) => row.value),
      node: <OpenTabsCommandGroup rows={rows} onActivateTab={workspace.onActivateTab} run={run} />,
    });
  }

  if (showActions) {
    const navRows = NAV_TABS.map((tab) => ({ tab, value: `${t(tab.labelKey)} ${tab.keywords}` }));
    groups.push({
      id: 'navigate',
      values: navRows.map((row) => row.value),
      node: (
        <CommandGroup heading={t('commandPalette.groupNavigate')}>
          {navRows.map(({ tab, value }) => (
            <CommandItem
              key={tab.id as string}
              value={value}
              onSelect={() => run(() => onShowTab?.(tab.id))}
            >
              <span className="flex-1">{t(tab.labelKey)}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      ),
    });
  }

  if (showActions && projectId) {
    const gitFetchValue = `${t('commandPalette.gitFetch')} fetch remote`;
    const gitPullValue = `${t('commandPalette.gitPull')} pull merge upstream`;
    const gitPushValue = `${t('commandPalette.gitPush')} push origin remote`;
    groups.push({
      id: 'git',
      values: [gitFetchValue, gitPullValue, gitPushValue],
      node: (
        <CommandGroup heading={t('commandPalette.groupGit')}>
          <CommandItem
            value={gitFetchValue}
            onSelect={() => run(() => { void git.fetch(); onShowTab?.('git'); })}
          >
            <RefreshCw className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex-1">{t('commandPalette.gitFetch')}</span>
          </CommandItem>
          <CommandItem
            value={gitPullValue}
            onSelect={() => run(() => { void git.pull(); onShowTab?.('git'); })}
          >
            <ArrowDownToLine className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex-1">{t('commandPalette.gitPull')}</span>
          </CommandItem>
          <CommandItem
            value={gitPushValue}
            onSelect={() => run(() => { void git.push(); onShowTab?.('git'); })}
          >
            <ArrowUpFromLine className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex-1">{t('commandPalette.gitPush')}</span>
          </CommandItem>
        </CommandGroup>
      ),
    });
  }

  if (showActions) {
    const settingsRows = SETTINGS_MAIN_TABS.map((tab) => ({ tab, value: `Settings ${tab.label} ${tab.keywords}` }));
    groups.push({
      id: 'settings',
      values: settingsRows.map((row) => row.value),
      node: (
        <CommandGroup heading={t('commandPalette.groupSettings')}>
          {settingsRows.map(({ tab: { id, label, icon: Icon }, value }) => (
            <CommandItem
              key={id}
              value={value}
              onSelect={() => run(() => onOpenSettings(id))}
            >
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="flex-1">{t('commandPalette.settingsItem', { label })}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      ),
    });
  }

  if (showSessions && projectId && sessionsShown.length > 0) {
    const rows = sessionsShown.map((s) => ({ session: s, value: `${s.label} ${s.snippet ?? ''} ${s.id}`.trim() }));
    const browseAll = browseAllLabel('commandPalette.browseAllSessions', sessionRows.length);
    groups.push({
      id: 'sessions',
      values: withBrowseAll(rows.map((row) => row.value), browseAll),
      node: (
        <CommandGroup heading={t('commandPalette.groupSessions')}>
          {rows.map(({ session: s, value }) => (
            <CommandItem
              key={s.id}
              value={value}
              onSelect={() => openSessionResult(s.id)}
              className="group"
            >
              <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{s.label}</span>
                {s.snippet && (
                  <span className="truncate text-xs text-muted-foreground">{s.snippet}</span>
                )}
              </div>
              {s.provider && (
                <span className="text-xs text-muted-foreground">{s.provider}</span>
              )}
              {canOpenOnOtherSide && (
                // Shown on the highlighted row only: how to send it to the other pane instead.
                <span className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground group-data-[selected=true]:inline-flex">
                  <ShortcutHint keys={OPEN_ON_OTHER_SIDE_SHORTCUT} />
                  {t('workspace.openOnOtherSide')}
                </span>
              )}
            </CommandItem>
          ))}
          {browseAll && <BrowseAllItem label={browseAll} onSelect={() => pushPage('sessions')} />}
        </CommandGroup>
      ),
    });
  }

  if (showFiles && projectId && filesShown.length > 0) {
    // Counts what the files page lists before anything is typed, so gitignored files are left out.
    const browseAll = browseAllLabel('commandPalette.browseAllFiles', unignoredFiles.length);
    groups.push({
      id: 'files',
      values: withBrowseAll(filesShown.map((f) => f.path), browseAll),
      node: (
        <CommandGroup heading={t('commandPalette.groupFiles')}>
          {filesShown.map((f) => (
            <CommandItem
              key={f.path}
              value={f.path}
              onSelect={() => run(() => ops.openFile(f.path))}
            >
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="flex-1 truncate">{f.name}</span>
              <span className="truncate text-xs text-muted-foreground">{f.relativePath}</span>
            </CommandItem>
          ))}
          {browseAll && <BrowseAllItem label={browseAll} onSelect={() => pushPage('files')} />}
        </CommandGroup>
      ),
    });
  }

  if (showCommits && projectId && commitsShown.length > 0) {
    const rows = commitsShown.map((c) => ({ commit: c, value: `${c.message} ${c.author} ${c.shortHash}` }));
    const browseAll = browseAllLabel('commandPalette.browseAllCommits', commits.length);
    groups.push({
      id: 'commits',
      values: withBrowseAll(rows.map((row) => row.value), browseAll),
      node: (
        <CommandGroup heading={t('commandPalette.groupCommits')}>
          {rows.map(({ commit: c, value }) => (
            <CommandItem
              key={c.hash}
              value={value}
              onSelect={() => run(() => onShowTab?.('git'))}
            >
              <GitCommit className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="font-mono text-xs text-muted-foreground">{c.shortHash}</span>
              <span className="flex-1 truncate">{c.message}</span>
              <span className="truncate text-xs text-muted-foreground">{c.author}</span>
            </CommandItem>
          ))}
          {browseAll && <BrowseAllItem label={browseAll} onSelect={() => pushPage('commits')} />}
        </CommandGroup>
      ),
    });
  }

  if (showBranches && projectId && branchesShown.length > 0) {
    const browseAll = browseAllLabel('commandPalette.browseAllBranches', branches.length);
    groups.push({
      id: 'branches',
      values: withBrowseAll(branchesShown.map((b) => b.name), browseAll),
      node: (
        <CommandGroup heading={t('commandPalette.groupBranches')}>
          {branchesShown.map((b) => (
            <CommandItem
              key={`branch-${b.name}`}
              value={b.name}
              onSelect={() => run(() => { void git.checkout(b.name); onShowTab?.('git'); })}
            >
              <GitMerge className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="flex-1 truncate">{t('commandPalette.switchTo', { name: b.name })}</span>
            </CommandItem>
          ))}
          {browseAll && <BrowseAllItem label={browseAll} onSelect={() => pushPage('branches')} />}
        </CommandGroup>
      ),
    });
  }

  const orderedGroups = search ? rankGroupsByBestMatch(groups, search, scoreRow) : groups;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl overflow-hidden p-0">
        <DialogTitle>{t('commandPalette.title')}</DialogTitle>
        <TopRowCommand label={t('commandPalette.title')} filter={scoreRow} search={search} onKeyDown={handleKeyDown}>
          {page && (
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <span className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">
                {t(`commandPalette.pages.${page}`)}
                <button
                  type="button"
                  onClick={popPage}
                  aria-label={t('commandPalette.backToAll')}
                  className="ml-0.5 rounded-sm opacity-70 hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
              <span className="text-xs text-muted-foreground">{t('commandPalette.backspaceHint')}</span>
            </div>
          )}
          <CommandInput
            placeholder={page
              ? t('commandPalette.searchPage', { page: t(`commandPalette.pages.${page}`).toLowerCase() })
              : t('commandPalette.searchAnything')}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList onPointerDownCapture={recordPointerModifier}>
            <CommandEmpty>{t('commandPalette.noResults')}</CommandEmpty>
            {orderedGroups.map((group) => (
              <React.Fragment key={group.id}>{group.node}</React.Fragment>
            ))}
          </CommandList>
          {filesNote && (
            <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">{filesNote}</p>
          )}
        </TopRowCommand>
      </DialogContent>
    </Dialog>
  );
}

export default React.memo(CommandPalette);

/**
 * `groups` with the best match first: each group is placed by its best-scoring
 * row, and groups that score the same keep their resting order. cmdk 1.1.1
 * sorts the rows inside each group but leaves the groups where they are
 * rendered (its group sort looks them up by an id they do not carry), then
 * highlights the first row of the list for Enter to run. Without this, Enter
 * runs the best row of whichever matching group is rendered first.
 */
function rankGroupsByBestMatch(groups: PaletteGroup[], search: string, scoreRow: RowScorer): PaletteGroup[] {
  // One group has nowhere to move, and the files page's one group holds up to FILES_PAGE_LIMIT rows.
  if (groups.length < 2) {
    return groups;
  }
  return groups
    .map((group) => ({
      group,
      // Trimmed as cmdk trims a row's value before scoring it.
      best: group.values.reduce((best, value) => Math.max(best, scoreRow(value.trim(), search)), 0),
    }))
    // Array sort is stable, so equal scores keep the resting order.
    .sort((left, right) => right.best - left.best)
    .map(({ group }) => group);
}

/** Rows cmdk can highlight, with its keys or the pointer: all but the disabled ones. */
const HIGHLIGHTABLE_ROW = '[cmdk-item]:not([aria-disabled="true"])';

/**
 * Highlightable rows on screen. Every row of the palette sits in a group, and cmdk hides a group
 * when none of its rows match.
 */
const SHOWN_HIGHLIGHTABLE_ROW = `[cmdk-group]:not([hidden]) ${HIGHLIGHTABLE_ROW}`;

/** Keys that move cmdk's highlight. */
const HIGHLIGHT_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

/** cmdk's vim bindings: these keys move its highlight while Ctrl is held. */
const HIGHLIGHT_CTRL_KEYS = new Set(['n', 'j', 'p', 'k']);

type TopRowCommandProps = Omit<React.ComponentPropsWithoutRef<typeof Command>, 'value' | 'onValueChange'> & {
  /** What is typed in the palette; the highlight follows the top row only while it is not empty. */
  search: string;
};

/**
 * The palette's Command. cmdk highlights the top row when the search changes, but not when rows
 * land after the last keystroke: the files list and session search answer late, and
 * rankGroupsByBestMatch then puts their group above the highlighted row, so Enter would run a row
 * that is no longer first and is often scrolled out of view. Here a new top row takes the
 * highlight, until the user moves it with the keys or the pointer; then it stays where they put
 * it until the search changes.
 */
function TopRowCommand({ search, onKeyDown, onPointerMove, children, ...props }: TopRowCommandProps) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  // cmdk's value prop, set to a row that landed on top for a single render. cmdk highlights the row
  // its value prop names and keeps its own highlight while the prop is unset, so the moves it makes
  // itself (search changes, keys, pointer) stay uncontrolled: aria-activedescendant stays right,
  // and the palette does not re-render on every move.
  const [landedTopValue, setLandedTopValue] = React.useState<string | undefined>(undefined);
  // Whether the user has moved the highlight since the search last changed.
  const userMovedHighlightRef = React.useRef(false);
  // The search, for the observer below, which is set up once.
  const searchRef = React.useRef(search);

  React.useLayoutEffect(() => {
    searchRef.current = search;
    // A new search puts cmdk's highlight back on the top row.
    userMovedHighlightRef.current = false;
  }, [search]);

  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return undefined;
    }
    // Rows that land render only once cmdk has scored them, and cmdk sorts rows by moving their
    // elements, both after React's commit. The observer sees the list once it has settled.
    const observer = new MutationObserver(() => {
      if (!searchRef.current || userMovedHighlightRef.current) {
        return;
      }
      const topRow = root.querySelector<HTMLElement>(SHOWN_HIGHLIGHTABLE_ROW);
      const topValue = topRow?.getAttribute('data-value');
      if (!topRow || !topValue || topRow.getAttribute('aria-selected') === 'true') {
        return;
      }
      // Handed to cmdk and taken back, each rendered at once: the highlight moves before the browser
      // paints, and before a key press can run the old row.
      flushSync(() => setLandedTopValue(topValue));
      flushSync(() => setLandedTopValue(undefined));
      // Brought into view as cmdk brings a row it highlights, together with its group's heading.
      const heading = topRow.closest('[cmdk-group]')?.querySelector('[cmdk-group-heading]');
      heading?.scrollIntoView({ block: 'nearest' });
      topRow.scrollIntoView({ block: 'nearest' });
    });
    observer.observe(root, { childList: true, subtree: true, attributeFilter: ['hidden', 'aria-disabled'] });
    return () => observer.disconnect();
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (movesHighlight(event)) {
      userMovedHighlightRef.current = true;
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    onPointerMove?.(event);
    // cmdk highlights the row under a moving pointer.
    if (event.target instanceof Element && event.target.closest(HIGHLIGHTABLE_ROW)) {
      userMovedHighlightRef.current = true;
    }
  };

  return (
    <Command {...props} ref={rootRef} value={landedTopValue} onKeyDown={handleKeyDown} onPointerMove={handlePointerMove}>
      {children}
    </Command>
  );
}

/** Whether cmdk moves its highlight on this key press; it leaves keys alone while an IME composes. */
function movesHighlight(event: React.KeyboardEvent): boolean {
  if (event.nativeEvent.isComposing) {
    return false;
  }
  return HIGHLIGHT_KEYS.has(event.key) || (event.ctrlKey && HIGHLIGHT_CTRL_KEYS.has(event.key));
}

/**
 * How well `search` matches a file, scored by cmdk's own filter on the path
 * relative to the project root: every absolute path shares the root, so a
 * query that hits the root folder's name ("claude" in .../claudecodeui/) would
 * match all files alike. A pasted absolute path (the file tree's Copy Path) is
 * read relative to the root first; separators are levelled so a Windows path
 * pasted with backslashes still matches. The server's file search, used for a
 * project too large to list, ranks with a port of this and of cmdk's filter
 * (server/modules/file-tree/file-search-score.service.ts): change them together.
 */
function scoreFile(file: FilePaths, search: string): number {
  const query = search.replace(/\\/g, '/');
  const relativePath = file.relativePath.replace(/\\/g, '/');
  const absolutePath = file.path.replace(/\\/g, '/');
  // The root as this file's own path spells it, trailing separator included.
  const root = absolutePath.endsWith(relativePath) ? absolutePath.slice(0, -relativePath.length) : '';
  return defaultFilter(relativePath, root && query.startsWith(root) ? query.slice(root.length) : query);
}

/**
 * Every file that matches `search`, best first. Scored the way cmdk scores file
 * rows (scoreFile), so cmdk keeps every file rendered from this list and orders
 * them the same way.
 */
function rankPathMatches<T extends FilePaths>(files: T[], search: string): T[] {
  return files
    .map((file) => ({ file, score: scoreFile(file, search) }))
    .filter(({ score }) => score > 0)
    // Array sort is stable, so equal scores keep the shallow-first order.
    .sort((left, right) => right.score - left.score)
    .map(({ file }) => file);
}

function BrowseAllItem({ label, onSelect }: { label: string; onSelect: () => void }) {
  return (
    <CommandItem value={label} onSelect={onSelect}>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex-1 text-muted-foreground">{label}</span>
    </CommandItem>
  );
}

/** A workspace shortcut beside its command, e.g. Ctrl+Shift+Enter, or ⌘⇧↵ on Apple platforms. */
function ShortcutHint({ keys }: { keys: readonly string[] }) {
  return (
    <kbd className="shrink-0 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {formatShortcut(keys)}
    </kbd>
  );
}

/** One command of the Workspace group. */
type WorkspaceCommand = {
  id: string;
  /** What cmdk matches: the label plus the words the command is also found by. */
  value: string;
  label: string;
  Icon: LucideIcon;
  /** Set when the command is offered but cannot run now: it is shown disabled, with this reason. */
  unavailableReason?: string;
  shortcut?: readonly string[];
  onSelect: () => void;
};

/**
 * Split or merge, focus a pane, move or close tabs, close a side, full screen. Commands that would do
 * nothing right now are left out; Split stays, disabled, to say why it is unavailable.
 */
function workspaceCommands(workspace: CommandPaletteWorkspaceCommands, t: TFunction): WorkspaceCommand[] {
  const { canSplit, isSplit, isImmersive, openTabs } = workspace;
  // The focused pane's active tab: the tab commands act on it, and its side is the focused pane.
  const currentTab = openTabs.find((tab) => tab.isActive) ?? null;
  const focusedPaneTabCount = currentTab ? openTabs.filter((tab) => tab.side === currentTab.side).length : 0;
  const isSplitUnavailable = !isSplit && !canSplit;
  // Unsplit, moving a pane's only tab would split and fold straight back, changing nothing.
  const canMoveTab = currentTab !== null && (isSplit || (canSplit && focusedPaneTabCount > 1));
  const splitLabel = isSplit ? t('workspace.merge') : t('workspace.split');
  const fullscreenLabel = isImmersive ? t('workspace.exitFullscreen') : t('workspace.fullscreen');

  const commands: WorkspaceCommand[] = [{
    id: 'split',
    value: `${splitLabel} split view merge panes 分屏 拆分 合并`,
    label: splitLabel,
    Icon: isSplit ? PanelRightClose : Columns2,
    unavailableReason: isSplitUnavailable ? t('workspace.splitDisabled') : undefined,
    shortcut: WORKSPACE_SPLIT_SHORTCUT,
    onSelect: workspace.onToggleSplit,
  }];
  if (isSplit) {
    commands.push(
      {
        id: 'focus-left',
        value: `${t('workspace.focusLeftPane')} focus left pane switch`,
        label: t('workspace.focusLeftPane'),
        Icon: PanelLeft,
        shortcut: WORKSPACE_FOCUS_LEFT_PANE_SHORTCUT,
        onSelect: () => workspace.onFocusPane('left'),
      },
      {
        id: 'focus-right',
        value: `${t('workspace.focusRightPane')} focus right pane switch`,
        label: t('workspace.focusRightPane'),
        Icon: PanelRight,
        shortcut: WORKSPACE_FOCUS_RIGHT_PANE_SHORTCUT,
        onSelect: () => workspace.onFocusPane('right'),
      },
    );
  }
  if (canMoveTab) {
    commands.push({
      id: 'move-tab',
      value: `${t('workspace.moveToOtherSide')} move tab other side pane`,
      label: t('workspace.moveToOtherSide'),
      Icon: ArrowLeftRight,
      onSelect: workspace.onMoveActiveTabToOtherSide,
    });
  }
  if (focusedPaneTabCount > 1) {
    commands.push({
      id: 'close-other-tabs',
      value: `${t('workspace.closeOtherTabs')} close other tabs`,
      label: t('workspace.closeOtherTabs'),
      Icon: CopyX,
      onSelect: workspace.onCloseOtherTabs,
    });
  }
  if (isSplit) {
    commands.push({
      id: 'close-pane',
      value: `${t('workspace.closePane')} close this side pane`,
      label: t('workspace.closePane'),
      Icon: SquareX,
      onSelect: workspace.onCloseFocusedPane,
    });
  }
  commands.push({
    id: 'fullscreen',
    value: `${fullscreenLabel} fullscreen full screen immersive 全屏`,
    label: fullscreenLabel,
    Icon: isImmersive ? Minimize2 : Maximize2,
    shortcut: WORKSPACE_FULLSCREEN_SHORTCUT,
    onSelect: workspace.onToggleFullscreen,
  });
  return commands;
}

type WorkspaceCommandGroupProps = {
  commands: WorkspaceCommand[];
  /** Closes the palette, then runs the command. */
  run: (fn: () => void) => void;
};

/** The Workspace group: each command with its shortcut, and the reason beside one that is unavailable. */
function WorkspaceCommandGroup({ commands, run }: WorkspaceCommandGroupProps) {
  const { t } = useTranslation();

  return (
    <CommandGroup heading={t('workspace.paletteGroup')}>
      {commands.map(({ id, value, label, Icon, unavailableReason, shortcut, onSelect }) => (
        <CommandItem
          key={id}
          value={value}
          disabled={unavailableReason !== undefined}
          onSelect={() => run(onSelect)}
        >
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex-1">{label}</span>
          {unavailableReason !== undefined && (
            <span className="text-xs text-muted-foreground">{unavailableReason}</span>
          )}
          {shortcut && <ShortcutHint keys={shortcut} />}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

/** One tab of the Open tabs group. */
type OpenTabRow = {
  tab: WorkspaceOpenTabSummary;
  /** Its project, and its side while split. */
  details: string;
  value: string;
};

/** Every tab of both panes, left first. */
function openTabRows({ isSplit, openTabs }: CommandPaletteWorkspaceCommands, t: TFunction): OpenTabRow[] {
  return openTabs.map((tab, index) => {
    const sideLabel = tab.side === 'left' ? t('workspace.leftPane') : t('workspace.rightPane');
    const details = [tab.projectName, isSplit ? sideLabel : ''].filter(Boolean).join(' · ');
    // Unique among all items, even with one session open on both sides or two tabs sharing a title.
    return { tab, details, value: `${tab.title} ${details} open tab ${tab.side}-${index}` };
  });
}

type OpenTabsCommandGroupProps = {
  rows: OpenTabRow[];
  onActivateTab: CommandPaletteWorkspaceCommands['onActivateTab'];
  /** Closes the palette, then runs the command. */
  run: (fn: () => void) => void;
};

/** The Open tabs group; picking a tab activates it and focuses its pane. */
function OpenTabsCommandGroup({ rows, onActivateTab, run }: OpenTabsCommandGroupProps) {
  const { t } = useTranslation();

  return (
    <CommandGroup heading={t('workspace.openTabsGroup')}>
      {rows.map(({ tab, details, value }) => (
        <CommandItem
          key={`${tab.side}:${tab.tabKey}`}
          value={value}
          aria-current={tab.isActive ? 'true' : undefined}
          onSelect={() => run(() => onActivateTab(tab.side, tab.tabKey))}
        >
          <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{tab.title}</span>
            {details && <span className="truncate text-xs text-muted-foreground">{details}</span>}
          </div>
          <span className="text-xs text-muted-foreground">{tab.provider}</span>
          {tab.isActive && <Check className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}
