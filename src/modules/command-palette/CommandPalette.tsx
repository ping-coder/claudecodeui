import * as React from 'react';
import { useTranslation } from 'react-i18next';
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
import type { AppTab, CommandPaletteWorkspaceCommands, Project, SessionOpenOptions } from '@/shared/types';
import { formatShortcut } from '@/shared/utils';
import { useSessionsSource } from '@/modules/command-palette/hooks/useSessionsSource';
import { useFilesSource } from '@/modules/command-palette/hooks/useFilesSource';
import { useCommitsSource } from '@/modules/command-palette/hooks/useCommitsSource';
import { useSessionMessageSearch } from '@/modules/command-palette/hooks/useSessionMessageSearch';
import { useBranchesSource } from '@/modules/command-palette/hooks/useBranchesSource';
import { useGitActions } from '@/modules/command-palette/hooks/useGitActions';

type Page = 'actions' | 'files' | 'sessions' | 'commits' | 'branches';

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
  const files = useFilesSource(projectId, open && showFiles);
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
  const filesShown = page === 'files' ? files : files.slice(0, browseLimit);
  const commitsShown = page === 'commits' ? commits : commits.slice(0, browseLimit);
  const sessionsShown = page === 'sessions' ? sessionRows : sessionRows.slice(0, browseLimit);
  const branchesShown = page === 'branches' ? branches : branches.slice(0, browseLimit);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl overflow-hidden p-0">
        <DialogTitle>{t('commandPalette.title')}</DialogTitle>
        <Command label={t('commandPalette.title')} onKeyDown={handleKeyDown}>
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

            {showActions && (
              <CommandGroup heading={t('commandPalette.groupActions')}>
                <CommandItem
                  value={`${t('commandPalette.startNewChat')} new chat`}
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
                <CommandItem value={`${t('commandPalette.openSettings')} settings`} onSelect={() => run(() => onOpenSettings())}>
                  <Settings className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('commandPalette.openSettings')}</span>
                </CommandItem>
                <CommandItem value={`${t('commandPalette.toggleTheme')} dark light mode`} onSelect={() => run(toggleDarkMode)}>
                  <SunMoon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('commandPalette.toggleTheme')}</span>
                </CommandItem>
              </CommandGroup>
            )}

            {showActions && workspace && <WorkspaceCommandGroup workspace={workspace} run={run} />}

            {showActions && workspace && workspace.openTabs.some((tab) => !tab.isActive) && (
              <OpenTabsCommandGroup workspace={workspace} run={run} />
            )}

            {showActions && (
              <CommandGroup heading={t('commandPalette.groupNavigate')}>
                {NAV_TABS.map((tab) => (
                  <CommandItem
                    key={tab.id as string}
                    value={`${t(tab.labelKey)} ${tab.keywords}`}
                    onSelect={() => run(() => onShowTab?.(tab.id))}
                  >
                    <span className="flex-1">{t(tab.labelKey)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {showActions && projectId && (
              <CommandGroup heading={t('commandPalette.groupGit')}>
                <CommandItem
                  value={`${t('commandPalette.gitFetch')} fetch remote`}
                  onSelect={() => run(() => { void git.fetch(); onShowTab?.('git'); })}
                >
                  <RefreshCw className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('commandPalette.gitFetch')}</span>
                </CommandItem>
                <CommandItem
                  value={`${t('commandPalette.gitPull')} pull merge upstream`}
                  onSelect={() => run(() => { void git.pull(); onShowTab?.('git'); })}
                >
                  <ArrowDownToLine className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('commandPalette.gitPull')}</span>
                </CommandItem>
                <CommandItem
                  value={`${t('commandPalette.gitPush')} push origin remote`}
                  onSelect={() => run(() => { void git.push(); onShowTab?.('git'); })}
                >
                  <ArrowUpFromLine className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('commandPalette.gitPush')}</span>
                </CommandItem>
              </CommandGroup>
            )}

            {showActions && (
              <CommandGroup heading={t('commandPalette.groupSettings')}>
                {SETTINGS_MAIN_TABS.map(({ id, label, keywords, icon: Icon }) => (
                  <CommandItem
                    key={id}
                    value={`Settings ${label} ${keywords}`}
                    onSelect={() => run(() => onOpenSettings(id))}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1">{t('commandPalette.settingsItem', { label })}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {showSessions && projectId && sessionsShown.length > 0 && (
              <CommandGroup heading={t('commandPalette.groupSessions')}>
                {sessionsShown.map((s) => (
                  <CommandItem
                    key={s.id}
                    value={`${s.label} ${s.snippet ?? ''} ${s.id}`.trim()}
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
                {!page && sessionRows.length > browseLimit && (
                  <BrowseAllItem label={t('commandPalette.browseAllSessions', { count: sessionRows.length })} onSelect={() => pushPage('sessions')} />
                )}
              </CommandGroup>
            )}

            {showFiles && projectId && filesShown.length > 0 && (
              <CommandGroup heading={t('commandPalette.groupFiles')}>
                {filesShown.map((f) => (
                  <CommandItem
                    key={f.path}
                    value={f.path}
                    onSelect={() => run(() => ops.openFile(f.path))}
                  >
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1 truncate">{f.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{f.path}</span>
                  </CommandItem>
                ))}
                {!page && files.length > browseLimit && (
                  <BrowseAllItem label={t('commandPalette.browseAllFiles', { count: files.length })} onSelect={() => pushPage('files')} />
                )}
              </CommandGroup>
            )}

            {showCommits && projectId && commitsShown.length > 0 && (
              <CommandGroup heading={t('commandPalette.groupCommits')}>
                {commitsShown.map((c) => (
                  <CommandItem
                    key={c.hash}
                    value={`${c.message} ${c.author} ${c.shortHash}`}
                    onSelect={() => run(() => onShowTab?.('git'))}
                  >
                    <GitCommit className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="font-mono text-xs text-muted-foreground">{c.shortHash}</span>
                    <span className="flex-1 truncate">{c.message}</span>
                    <span className="truncate text-xs text-muted-foreground">{c.author}</span>
                  </CommandItem>
                ))}
                {!page && commits.length > browseLimit && (
                  <BrowseAllItem label={t('commandPalette.browseAllCommits', { count: commits.length })} onSelect={() => pushPage('commits')} />
                )}
              </CommandGroup>
            )}

            {showBranches && projectId && branchesShown.length > 0 && (
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
                {!page && branches.length > browseLimit && (
                  <BrowseAllItem label={t('commandPalette.browseAllBranches', { count: branches.length })} onSelect={() => pushPage('branches')} />
                )}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

export default React.memo(CommandPalette);

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

type WorkspaceCommandGroupProps = {
  workspace: CommandPaletteWorkspaceCommands;
  /** Closes the palette, then runs the command. */
  run: (fn: () => void) => void;
};

/**
 * Split or merge, focus a pane, move or close tabs, close a side, full screen. Commands that would do
 * nothing right now are left out; Split stays, disabled, to say why it is unavailable.
 */
function WorkspaceCommandGroup({ workspace, run }: WorkspaceCommandGroupProps) {
  const { t } = useTranslation();
  const { canSplit, isSplit, isImmersive, openTabs } = workspace;
  // The focused pane's active tab: the tab commands act on it, and its side is the focused pane.
  const currentTab = openTabs.find((tab) => tab.isActive) ?? null;
  const focusedPaneTabCount = currentTab ? openTabs.filter((tab) => tab.side === currentTab.side).length : 0;
  const isSplitUnavailable = !isSplit && !canSplit;
  // Unsplit, moving a pane's only tab would split and fold straight back, changing nothing.
  const canMoveTab = currentTab !== null && (isSplit || (canSplit && focusedPaneTabCount > 1));
  const splitLabel = isSplit ? t('workspace.merge') : t('workspace.split');
  const fullscreenLabel = isImmersive ? t('workspace.exitFullscreen') : t('workspace.fullscreen');
  const SplitIcon = isSplit ? PanelRightClose : Columns2;
  const FullscreenIcon = isImmersive ? Minimize2 : Maximize2;

  return (
    <CommandGroup heading={t('workspace.paletteGroup')}>
      <CommandItem
        value={`${splitLabel} split view merge panes 分屏 拆分 合并`}
        disabled={isSplitUnavailable}
        onSelect={() => run(workspace.onToggleSplit)}
      >
        <SplitIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="flex-1">{splitLabel}</span>
        {isSplitUnavailable && (
          <span className="text-xs text-muted-foreground">{t('workspace.splitDisabled')}</span>
        )}
        <ShortcutHint keys={WORKSPACE_SPLIT_SHORTCUT} />
      </CommandItem>
      {isSplit && (
        <CommandItem
          value={`${t('workspace.focusLeftPane')} focus left pane switch`}
          onSelect={() => run(() => workspace.onFocusPane('left'))}
        >
          <PanelLeft className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex-1">{t('workspace.focusLeftPane')}</span>
          <ShortcutHint keys={WORKSPACE_FOCUS_LEFT_PANE_SHORTCUT} />
        </CommandItem>
      )}
      {isSplit && (
        <CommandItem
          value={`${t('workspace.focusRightPane')} focus right pane switch`}
          onSelect={() => run(() => workspace.onFocusPane('right'))}
        >
          <PanelRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex-1">{t('workspace.focusRightPane')}</span>
          <ShortcutHint keys={WORKSPACE_FOCUS_RIGHT_PANE_SHORTCUT} />
        </CommandItem>
      )}
      {canMoveTab && (
        <CommandItem
          value={`${t('workspace.moveToOtherSide')} move tab other side pane`}
          onSelect={() => run(workspace.onMoveActiveTabToOtherSide)}
        >
          <ArrowLeftRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex-1">{t('workspace.moveToOtherSide')}</span>
        </CommandItem>
      )}
      {focusedPaneTabCount > 1 && (
        <CommandItem
          value={`${t('workspace.closeOtherTabs')} close other tabs`}
          onSelect={() => run(workspace.onCloseOtherTabs)}
        >
          <CopyX className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex-1">{t('workspace.closeOtherTabs')}</span>
        </CommandItem>
      )}
      {isSplit && (
        <CommandItem
          value={`${t('workspace.closePane')} close this side pane`}
          onSelect={() => run(workspace.onCloseFocusedPane)}
        >
          <SquareX className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex-1">{t('workspace.closePane')}</span>
        </CommandItem>
      )}
      <CommandItem
        value={`${fullscreenLabel} fullscreen full screen immersive 全屏`}
        onSelect={() => run(workspace.onToggleFullscreen)}
      >
        <FullscreenIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="flex-1">{fullscreenLabel}</span>
        <ShortcutHint keys={WORKSPACE_FULLSCREEN_SHORTCUT} />
      </CommandItem>
    </CommandGroup>
  );
}

/** Every tab of both panes, left first; picking one activates it and focuses its pane. */
function OpenTabsCommandGroup({ workspace, run }: WorkspaceCommandGroupProps) {
  const { t } = useTranslation();
  const { isSplit, openTabs } = workspace;

  return (
    <CommandGroup heading={t('workspace.openTabsGroup')}>
      {openTabs.map((tab, index) => {
        const sideLabel = tab.side === 'left' ? t('workspace.leftPane') : t('workspace.rightPane');
        const details = [tab.projectName, isSplit ? sideLabel : ''].filter(Boolean).join(' · ');
        return (
          <CommandItem
            key={`${tab.side}:${tab.tabKey}`}
            // Unique among all items, even with one session open on both sides or two tabs sharing a title.
            value={`${tab.title} ${details} open tab ${tab.side}-${index}`}
            aria-current={tab.isActive ? 'true' : undefined}
            onSelect={() => run(() => workspace.onActivateTab(tab.side, tab.tabKey))}
          >
            <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{tab.title}</span>
              {details && <span className="truncate text-xs text-muted-foreground">{details}</span>}
            </div>
            <span className="text-xs text-muted-foreground">{tab.provider}</span>
            {tab.isActive && <Check className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}
