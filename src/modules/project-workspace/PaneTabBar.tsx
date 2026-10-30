import { ChevronDown, Columns2, Loader2, Maximize2, Minimize2, MoreHorizontal, PanelLeftOpen, Plus, RefreshCw, RotateCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { useWorkspaceChrome } from '@/modules/project-workspace/context/WorkspaceChromeContext';
import { useHorizontalWheelScroll } from '@/modules/project-workspace/hooks/useHorizontalWheelScroll';
import PaneTabContextMenu from '@/modules/project-workspace/PaneTabContextMenu';
import PaneTabRenameInput from '@/modules/project-workspace/PaneTabRenameInput';
import { formatSessionTitle } from '@/modules/sidebar';
import {
  PANE_TAB_DRAG_EFFECT,
  WORKSPACE_FULLSCREEN_REFRESH_SHORTCUT,
  WORKSPACE_FULLSCREEN_SHORTCUT,
  WORKSPACE_PANE_SIDES,
  WORKSPACE_SPLIT_SHORTCUT,
} from '@/shared/constants';
import type {
  PaneTabActivity,
  PaneTabDisplay,
  Project,
  WorkspaceLayoutActions,
  WorkspacePaneSide,
  WorkspacePaneState,
  WorkspaceSessionTab,
} from '@/shared/types';
import { forwardArrowKey, isRtl, visualPaneSide } from '@/shared/direction';
import { ActionMenu, LLMProviderLogo, PaneSideGlyph, Tooltip } from '@/shared/ui';
import {
  cn,
  copyTextToClipboard,
  formatShortcut,
  getOtherPaneSide,
  hasSessionDragPayload,
  readSessionDragPayload,
  writeSessionDragPayload,
} from '@/shared/utils';

type PaneTabBarProps = {
  side: WorkspacePaneSide;
  pane: WorkspacePaneState;
  /** tabKey -> label and activity, for both panes. */
  tabDisplay: ReadonlyMap<string, PaneTabDisplay>;
  actions: WorkspaceLayoutActions;
  /** Project the "+" button and a double-click on the empty strip start a new chat in; null disables both. */
  newChatProject: Project | null;
  /** id of the pane's tab panel; each tab's id is `${panelId}-${tab.key}`. */
  panelId: string;
  isFocused: boolean;
  /** A right pane exists. */
  isSplit: boolean;
  /** Both panes are on screen: the focused pane's active tab is underlined and the other bar is dimmed. */
  isSideBySide: boolean;
  /** Split but too narrow for two panes: the bar starts with the left/right switcher. */
  isCollapsed: boolean;
  /** What the hidden pane's tabs are doing, drawn as a dot on the switcher; null for nothing. */
  hiddenPaneActivity: PaneTabActivity | null;
  /** The rightmost visible pane carries the split/merge and full-screen buttons, so they stay in the workspace's top-right corner. */
  showWorkspaceControls: boolean;
  /** The leftmost visible pane offers "Show sidebar" while immersive. */
  isLeftmost: boolean;
  /** Persists a new title for a session; resolves false when the backend refuses it. Saves the tab's rename box. */
  onRenameSession: (sessionId: string, summary: string) => Promise<boolean>;
  /**
   * Tabs alone cannot tell which project they belong to (tabs of several projects are open, or the
   * sidebar is out of sight): every tab names its project after its title. A draft always does.
   */
  showProjectNames: boolean;
  /** What follows the tabs, right-aligned before the pane menu: the view bar (wide panes, immersive) and the connection status. */
  trailingContent?: ReactNode;
  /**
   * The trailing content may shrink along with the tabs (immersive below the wide tier, where the view
   * bar has to share the one row), so the pane menu and the full-screen button always fit. Otherwise it
   * keeps its width and the tabs give way. Default false.
   */
  trailingCanShrink?: boolean;
  /** The pane shows a tab's content, so "Refresh tab" has something to refresh. */
  canRefreshTab?: boolean;
  /** Refreshes this pane's active tab; without it the bar offers no refresh. */
  onRefreshTab?: () => void;
  /** Refreshes everything; the rightmost pane's bar carries its button, every pane menu the item. */
  onRefreshWorkspace?: () => void;
  /** A workspace refresh is on its way: Refresh all spins and does nothing. */
  isRefreshingWorkspace?: boolean;
};

/** Open state of the tab context menu: which tab it acts on and the viewport point it opens at. */
type TabMenuState = { tabKey: string; anchor: { x: number; y: number } };

/** Marks the split/merge button, so focus can follow it into whichever tab bar carries it after the layout changed. */
const SPLIT_TOGGLE_SELECTOR = '[data-workspace-split-toggle]';

/** The key that renames the focused tab, also shown in its context menu. */
const RENAME_TAB_SHORTCUT = 'F2';

const ICON_BUTTON_CLASS_NAME = 'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60';

/** Only a session can be renamed: a draft has no session yet, and a missing one is gone. */
const canRenameTab = (tab: WorkspaceSessionTab): boolean => Boolean(tab.sessionId) && !tab.isMissing;

/**
 * Whether nothing holds the focus: it fell back to the body when its element went away. Focus handed
 * back a frame later only lands then, so it never takes the focus from where something else put it.
 */
const isFocusOnBody = (): boolean => {
  const active = document.activeElement;
  return !active || active === document.body;
};

/**
 * Where a drag over the strip would land: the index of the first tab whose middle lies past the
 * pointer in reading order (right of it, or left of it right to left), or the tab count when the
 * pointer is past the last tab.
 */
const getDropIndex = (strip: HTMLElement | null, clientX: number): number => {
  const tabElements = Array.from(strip?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
  const rtl = isRtl(strip);
  const index = tabElements.findIndex((element) => {
    const rect = element.getBoundingClientRect();
    const middle = rect.left + rect.width / 2;
    return rtl ? clientX > middle : clientX < middle;
  });
  return index < 0 ? tabElements.length : index;
};

/**
 * Scrolls the strip by as little as shows the whole tab, as inline 'nearest' does; a tab wider than the
 * strip shows its start. Unlike scrollIntoView it moves nothing but the strip, which a resize must not.
 */
const revealTabInStrip = (strip: HTMLElement, tab: HTMLElement) => {
  const stripRect = strip.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  if (tabRect.left < stripRect.left || tabRect.width > stripRect.width) {
    strip.scrollLeft += tabRect.left - stripRect.left;
  } else if (tabRect.right > stripRect.right) {
    strip.scrollLeft += tabRect.right - stripRect.right;
  }
};

type TabActivityMarkProps = {
  activity: PaneTabActivity | null;
};

/** The spinner or dot a tab shows for its session's activity. */
function TabActivityMark({ activity }: TabActivityMarkProps) {
  const { t } = useTranslation('sidebar');
  if (activity === 'running') {
    return (
      <span role="img" aria-label={t('tooltips.processingSessionIndicator', { defaultValue: 'Processing session' })} className="flex flex-shrink-0">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
      </span>
    );
  }
  if (activity === 'attention' || activity === 'background') {
    const label = activity === 'attention'
      ? t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })
      : t('tooltips.backgroundWorkIndicator', { defaultValue: 'Background work running' });
    return (
      <span
        role="img"
        aria-label={label}
        className={cn(
          'h-2 w-2 flex-shrink-0 rounded-full',
          activity === 'attention' ? 'bg-amber-500' : 'bg-purple-500 dark:bg-purple-400',
        )}
      />
    );
  }
  return null;
}

/**
 * Rendered by WorkspacePane on desktop: the pane's row of session tabs (a tablist with roving focus, tabs
 * that shrink to fit before the row scrolls, preview tabs in italics, a project suffix when tabs alone
 * cannot tell the project, drag to reorder or onto the other pane, Alt to copy, a right-click menu,
 * renaming a session in place on its tab), then what the pane puts after them (its view bar, the
 * connection status) and the pane's controls. The rightmost visible pane also carries split/merge and
 * full screen.
 */
export default function PaneTabBar({
  side,
  pane,
  tabDisplay,
  actions,
  newChatProject,
  panelId,
  isFocused,
  isSplit,
  isSideBySide,
  isCollapsed,
  hiddenPaneActivity,
  showWorkspaceControls,
  isLeftmost,
  onRenameSession,
  showProjectNames,
  trailingContent,
  trailingCanShrink = false,
  canRefreshTab = false,
  onRefreshTab,
  onRefreshWorkspace,
  isRefreshingWorkspace = false,
}: PaneTabBarProps) {
  const { t } = useTranslation();
  const { canSplit, isImmersive, toggleImmersive, isSidebarPeekOpen, setSidebarPeekOpen } = useWorkspaceChrome();
  const stripRef = useRef<HTMLDivElement>(null);
  const { canScrollLeft, canScrollRight, updateScrollState } = useHorizontalWheelScroll(stripRef, pane.activeTabKey);
  // Where a dragged tab or conversation would be inserted (drawn as a 2px caret); null while nothing is dragged over the bar.
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // The tab context menu, while open.
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null);
  // Which tab the rename box covers, at most one per tab bar; null while no tab is being renamed.
  const [renamingTabKey, setRenamingTabKey] = useState<string | null>(null);
  // The tab the first press of the latest click landed on, if it was already the active tab then: only
  // that tab's double-click renames it (the click before already activated any other tab).
  const activeTabAtPressRef = useRef<string | null>(null);

  const tabs = pane.tabs;
  // What a tab reads on screen. A rename starts from the title tabDisplay holds and a drag carries it,
  // while the strip, its tooltips and menus show the server's placeholder names ("Untitled Claude
  // Session") in the interface language.
  const getTabLabel = (tab: WorkspaceSessionTab): string => (
    formatSessionTitle(tabDisplay.get(tab.key)?.title ?? tab.title, t)
  );
  // Changes only when tabs open, close or move, unlike `tabs`, which a session update replaces too.
  const tabKeys = tabs.map((tab) => tab.key).join('\n');
  // The tabs shrink before the strip scrolls, so it only overflows once they are all at their minimum
  // width. A lone tab gets no menu: there is nothing to switch to.
  const showAllTabsMenu = (canScrollLeft || canScrollRight) && tabs.length > 1;
  const isDimmed = isSideBySide && !isFocused;
  const canTargetOtherSide = isSplit || canSplit;
  const activeTab = tabs.find((tab) => tab.key === pane.activeTabKey) ?? null;

  const renamingTab = renamingTabKey
    ? tabs.find((tab) => tab.key === renamingTabKey && canRenameTab(tab)) ?? null
    : null;
  if (renamingTabKey && !renamingTab) {
    // The tab closed, moved to the other pane or lost its session under the box: the edit goes with it, unsaved.
    // Adjusting state while rendering: React re-renders right away, before anything is committed.
    setRenamingTabKey(null);
  }

  const getTabElement = useCallback(
    (tabKey: string) => document.getElementById(`${panelId}-${tabKey}`),
    [panelId],
  );

  /** After a close or a menu action the focused tab may be gone: hand focus to the pane's active tab. */
  const focusActiveTabSoon = useCallback(() => {
    window.requestAnimationFrame(() => {
      stripRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    });
  }, []);

  // Tabs opening, closing or getting renamed change the overflow without resizing the strip once
  // it is at full width, which the resize observer alone would miss (stale fades and tab menu).
  useEffect(() => {
    updateScrollState();
  }, [tabs, tabDisplay, updateScrollState]);

  // A size change (a window or divider drag, the All tabs menu appearing, a renamed tab) can leave the
  // active tab cut at an edge, close button and all: whenever the strip or a tab changes size, the active
  // tab comes back whole, at once. Observing the tabs afresh when they open, close or move reports them
  // all once, which also covers a tab added while every width stays put. A session update keeps the
  // keys, so it does not snap back a strip the user has scrolled.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      const activeTabElement = strip.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (activeTabElement) {
        revealTabInStrip(strip, activeTabElement);
      }
      updateScrollState();
    });
    observer.observe(strip);
    strip.querySelectorAll<HTMLElement>('[role="tab"]').forEach((tabElement) => observer.observe(tabElement));
    return () => observer.disconnect();
  }, [tabKeys, updateScrollState]);

  // A cancelled drag ends without a drop on the bar: the caret must not stay behind.
  useEffect(() => {
    if (dropIndex === null) {
      return undefined;
    }
    const clearDropIndex = () => setDropIndex(null);
    window.addEventListener('dragend', clearDropIndex, true);
    window.addEventListener('drop', clearDropIndex, true);
    return () => {
      window.removeEventListener('dragend', clearDropIndex, true);
      window.removeEventListener('drop', clearDropIndex, true);
    };
  }, [dropIndex]);

  const startNewChat = () => {
    if (newChatProject) {
      actions.openNewSession(newChatProject, { target: side });
    }
  };

  const openTabMenu = (tabKey: string, x: number, y: number) => {
    setTabMenu({ tabKey, anchor: { x, y } });
  };

  const closeTabMenu = (restoreFocus: boolean) => {
    const closingTabKey = tabMenu?.tabKey;
    setTabMenu(null);
    if (!restoreFocus || !closingTabKey) {
      return;
    }
    // The menu closes before its item runs, and an item may move the focus itself (the rename box
    // takes it): only focus the closed menu left on the body goes back to the tab.
    window.requestAnimationFrame(() => {
      if (!isFocusOnBody()) {
        return;
      }
      (getTabElement(closingTabKey) ?? stripRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'))?.focus();
    });
  };

  /**
   * Opens the rename box over a session tab. The tab is kept and made active first: typing in the pane
   * keeps its active tab open (WorkspacePane), so the box must belong to that tab.
   */
  const startRename = (tabKey: string) => {
    const tab = tabs.find((candidate) => candidate.key === tabKey);
    if (!tab || !canRenameTab(tab)) {
      return;
    }
    if (tab.isPreview) {
      actions.pinTab(side, tab.key);
    }
    if (tab.key !== pane.activeTabKey) {
      actions.activateTab(side, tab.key);
    }
    setRenamingTabKey(tab.key);
  };

  /** Closes the rename box; after Enter, Tab or Escape the tab takes the focus back, after a click away it stays put. */
  const finishRename = (tabKey: string, restoreFocus: boolean) => {
    setRenamingTabKey((current) => (current === tabKey ? null : current));
    if (!restoreFocus) {
      return;
    }
    window.requestAnimationFrame(() => {
      if (isFocusOnBody()) {
        getTabElement(tabKey)?.focus();
      }
    });
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, index: number) => {
    const tab = tabs[index];
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      // Under the tab's start edge: its right edge right to left, where the menu opens leftwards.
      openTabMenu(tab.key, isRtl(event.currentTarget) ? rect.right : rect.left, rect.bottom);
      return;
    }
    if (event.key === RENAME_TAB_SHORTCUT) {
      if (canRenameTab(tab)) {
        event.preventDefault();
        startRename(tab.key);
      }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      actions.activateTab(side, tab.key);
      return;
    }
    if (event.key === 'Delete') {
      event.preventDefault();
      actions.closeTab(side, tab.key);
      focusActiveTabSoon();
      return;
    }

    // The arrow pointing along the row moves on: ArrowLeft right to left.
    const forward = forwardArrowKey(event.currentTarget);
    let nextIndex: number;
    if (event.key === forward) {
      nextIndex = (index + 1) % tabs.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      nextIndex = (index - 1 + tabs.length) % tabs.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = tabs.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    getTabElement(nextTab.key)?.focus();
    actions.activateTab(side, nextTab.key);
  };

  const handleTabMouseDown = (event: ReactMouseEvent<HTMLDivElement>, tab: WorkspaceSessionTab, isActive: boolean) => {
    // A middle press would start the browser's autoscroll; the release closes the tab instead.
    if (event.button === 1) {
      event.preventDefault();
      return;
    }
    // The first press of a click (detail 1; the second press of a double-click is 2).
    if (event.button === 0 && event.detail === 1) {
      activeTabAtPressRef.current = isActive ? tab.key : null;
    }
  };

  const handleTabDoubleClick = (tab: WorkspaceSessionTab) => {
    const wasActiveAtPress = activeTabAtPressRef.current === tab.key;
    activeTabAtPressRef.current = null;
    // A double-click keeps a preview tab open; on the tab already active it renames the session.
    if (tab.isPreview) {
      actions.pinTab(side, tab.key);
      return;
    }
    if (wasActiveAtPress) {
      startRename(tab.key);
    }
  };

  const handleTabAuxClick = (event: ReactMouseEvent<HTMLDivElement>, tab: WorkspaceSessionTab) => {
    if (event.button !== 1) {
      return;
    }
    event.preventDefault();
    actions.closeTab(side, tab.key);
  };

  const handleTabDragStart = (event: ReactDragEvent<HTMLDivElement>, tab: WorkspaceSessionTab) => {
    const display = tabDisplay.get(tab.key);
    writeSessionDragPayload(
      event.dataTransfer,
      {
        sessionId: tab.sessionId,
        projectId: tab.projectId || null,
        provider: tab.provider,
        title: display?.title ?? tab.title,
        fromTab: { side, tabKey: tab.key },
      },
      // Dragged out of the app (another browser tab, the address bar) a session tab is still a link.
      tab.sessionId ? `/session/${tab.sessionId}` : undefined,
    );
    event.dataTransfer.effectAllowed = PANE_TAB_DRAG_EFFECT;
    // Dragging a tab is a deliberate act: a preview becomes a kept tab.
    if (tab.isPreview) {
      actions.pinTab(side, tab.key);
    }
  };

  const handleBarDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasSessionDragPayload(event.dataTransfer)) {
      return;
    }
    // Allows the drop; the event still bubbles so the pane group keeps its drag state.
    event.preventDefault();
    // Only a dragged tab lands at a position: a conversation from the sidebar opens like any other open
    // (right of the active tab), so it gets no insertion caret that would promise otherwise.
    if (event.dataTransfer.effectAllowed !== PANE_TAB_DRAG_EFFECT) {
      return;
    }
    event.dataTransfer.dropEffect = event.altKey ? 'copy' : 'move';
    const nextDropIndex = getDropIndex(stripRef.current, event.clientX);
    setDropIndex((current) => (current === nextDropIndex ? current : nextDropIndex));
  };

  const handleBarDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget as Node | null;
    if (nextTarget && event.currentTarget.contains(nextTarget)) {
      return;
    }
    setDropIndex(null);
  };

  const handleBarDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasSessionDragPayload(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setDropIndex(null);
    const payload = readSessionDragPayload(event.dataTransfer);
    if (!payload) {
      return;
    }
    const insertAt = getDropIndex(stripRef.current, event.clientX);

    if (payload.fromTab) {
      const { side: fromSide, tabKey } = payload.fromTab;
      if (fromSide !== side) {
        actions.moveTab(fromSide, tabKey, side, { index: insertAt, copy: event.altKey });
        return;
      }
      // moveTab counts the target index without the moved tab.
      const fromIndex = tabs.findIndex((tab) => tab.key === tabKey);
      if (fromIndex < 0) {
        return;
      }
      const index = insertAt > fromIndex ? insertAt - 1 : insertAt;
      if (index !== fromIndex) {
        actions.moveTab(side, tabKey, side, { index });
      }
      return;
    }

    if (payload.sessionId) {
      // The row's title travels with the drop: a conversation the loaded pages lack still gets one.
      actions.openSession(
        {
          id: payload.sessionId,
          __projectId: payload.projectId ?? undefined,
          __provider: payload.provider,
          ...(payload.title ? { summary: payload.title } : {}),
        },
        { target: side, preview: false },
      );
    }
  };

  // The split/merge button moves to whichever pane is rightmost after the change, so the one that was
  // pressed is gone: keyboard focus follows the button to its new place instead of dropping to the page.
  const toggleSplitKeepingFocus = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const hadFocus = document.activeElement === event.currentTarget;
    actions.toggleSplit();
    if (!hadFocus) {
      return;
    }
    window.requestAnimationFrame(() => {
      if (isFocusOnBody()) {
        document.querySelector<HTMLElement>(SPLIT_TOGGLE_SELECTOR)?.focus();
      }
    });
  };

  const handleStripDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    // Only the empty part of the strip; a double-click on a tab keeps it open instead.
    if (event.target === event.currentTarget) {
      startNewChat();
    }
  };

  const refreshTabLabel = t('workspace.refreshTab', { defaultValue: 'Refresh tab' });
  const refreshAllLabel = t('workspace.refreshAll', { defaultValue: 'Refresh all' });

  /** Refresh always acts on the pane's active tab: a background tab is brought up first, then refreshed. */
  const refreshTabFromMenu = (tabKey: string) => {
    if (tabKey !== pane.activeTabKey) {
      actions.activateTab(side, tabKey);
    }
    onRefreshTab?.();
  };

  const refreshWorkspaceUnlessBusy = () => {
    if (!isRefreshingWorkspace) {
      onRefreshWorkspace?.();
    }
  };

  const menuTab = tabMenu ? tabs.find((tab) => tab.key === tabMenu.tabKey) ?? null : null;
  const menuTabIndex = menuTab ? tabs.indexOf(menuTab) : -1;
  const otherSide = getOtherPaneSide(side);
  const menuItems = menuTab ? [
    { key: 'close', label: t('workspace.closeTab', { defaultValue: 'Close tab' }), onSelect: () => actions.closeTab(side, menuTab.key) },
    {
      key: 'closeOthers',
      label: t('workspace.closeOtherTabs', { defaultValue: 'Close other tabs' }),
      disabled: tabs.length < 2,
      onSelect: () => actions.closeOtherTabs(side, menuTab.key),
    },
    {
      key: 'closeToRight',
      // The tabs after this one: on its right, or on its left right to left.
      label: isRtl()
        ? t('workspace.closeTabsToLeft', { defaultValue: 'Close tabs to the left' })
        : t('workspace.closeTabsToRight', { defaultValue: 'Close tabs to the right' }),
      disabled: menuTabIndex === tabs.length - 1,
      onSelect: () => actions.closeTabsToRight(side, menuTab.key),
    },
    { key: 'closeAll', label: t('workspace.closeAllTabs', { defaultValue: 'Close all tabs' }), onSelect: () => actions.closeAllTabs(side) },
    ...(menuTab.isPreview ? [{
      key: 'keepOpen',
      label: t('workspace.keepOpen', { defaultValue: 'Keep open' }),
      separatorBefore: true,
      onSelect: () => actions.pinTab(side, menuTab.key),
    }] : []),
    // A draft has one home (one unsent chat per project), so it can move but never be copied.
    ...(menuTab.sessionId ? [{
      key: 'openOnOtherSide',
      label: t('workspace.openOnOtherSide', { defaultValue: 'Open on the other side' }),
      separatorBefore: !menuTab.isPreview,
      disabled: !canTargetOtherSide,
      onSelect: () => actions.moveTab(side, menuTab.key, otherSide, { copy: true }),
    }] : []),
    {
      key: 'moveToOtherSide',
      label: t('workspace.moveToOtherSide', { defaultValue: 'Move to the other side' }),
      separatorBefore: !menuTab.isPreview && !menuTab.sessionId,
      // Unsplit, the only tab would go to a new right pane that the emptied left one hands straight back.
      disabled: !canTargetOtherSide || (!isSplit && tabs.length < 2),
      onSelect: () => actions.moveTab(side, menuTab.key, otherSide),
    },
    ...(canRenameTab(menuTab) ? [{
      key: 'rename',
      label: t('workspace.renameSession', { defaultValue: 'Rename session' }),
      shortcut: RENAME_TAB_SHORTCUT,
      separatorBefore: true,
      onSelect: () => startRename(menuTab.key),
    }] : []),
    ...(menuTab.sessionId ? [{
      key: 'copySessionId',
      label: t('workspace.copySessionId', { defaultValue: 'Copy session ID' }),
      separatorBefore: !canRenameTab(menuTab),
      onSelect: () => {
        void copyTextToClipboard(menuTab.sessionId as string);
      },
    }] : []),
    ...(onRefreshTab ? [{
      key: 'refresh',
      label: refreshTabLabel,
      separatorBefore: true,
      // A conversation that is gone has nothing to reload.
      disabled: Boolean(menuTab.isMissing),
      onSelect: () => refreshTabFromMenu(menuTab.key),
    }] : []),
  ] : [];

  const allTabsItems = tabs.map((tab) => {
    const display = tabDisplay.get(tab.key);
    return {
      key: tab.key,
      label: getTabLabel(tab),
      description: display?.projectName || undefined,
      onSelect: () => actions.activateTab(side, tab.key),
    };
  });

  const paneMenuItems = [
    // The visible way in to renaming, for a touch screen or anyone who does not know the double-click or F2.
    {
      key: 'rename',
      label: t('workspace.renameSession', { defaultValue: 'Rename session' }),
      disabled: !activeTab || !canRenameTab(activeTab),
      onSelect: () => {
        if (activeTab) {
          startRename(activeTab.key);
        }
      },
    },
    ...(onRefreshTab ? [{
      key: 'refreshTab',
      label: refreshTabLabel,
      disabled: !canRefreshTab,
      showDividerBefore: true,
      onSelect: onRefreshTab,
    }] : []),
    ...(onRefreshWorkspace ? [{
      key: 'refreshAll',
      label: isRefreshingWorkspace ? t('workspace.refreshing', { defaultValue: 'Refreshing…' }) : refreshAllLabel,
      disabled: isRefreshingWorkspace,
      showDividerBefore: !onRefreshTab,
      onSelect: refreshWorkspaceUnlessBusy,
    }] : []),
    {
      key: 'closeAll',
      label: t('workspace.closeAllTabs', { defaultValue: 'Close all tabs' }),
      disabled: tabs.length === 0,
      showDividerBefore: true,
      onSelect: () => actions.closeAllTabs(side),
    },
    ...(isSplit ? [{
      key: 'closePane',
      label: t('workspace.closePane', { defaultValue: 'Close this side' }),
      onSelect: () => actions.closePane(side),
    }] : []),
  ];

  const splitShortcut = formatShortcut(WORKSPACE_SPLIT_SHORTCUT);
  const fullscreenShortcut = formatShortcut(WORKSPACE_FULLSCREEN_SHORTCUT);
  const isSplitUnavailable = !isSplit && !canSplit;
  const splitLabel = isSplit ? t('workspace.merge', { defaultValue: 'Merge panes' }) : t('workspace.split', { defaultValue: 'Split view' });
  // The shortcut goes in as a value, which a right-to-left language isolates: written into the
  // sentence, "Ctrl+\" would read "\+Ctrl" and "⌘⇧↵" "↵⇧⌘".
  const splitTooltip = isSplitUnavailable
    ? t('workspace.splitDisabled', { defaultValue: 'Widen the window to split' })
    : t('workspace.labelWithShortcut', { label: splitLabel, shortcut: splitShortcut });
  const fullscreenLabel = isImmersive
    ? t('workspace.exitFullscreen', { defaultValue: 'Exit full screen' })
    : t('workspace.fullscreen', { defaultValue: 'Full screen' });
  const fullscreenTooltip = t('workspace.labelWithShortcut', { label: fullscreenLabel, shortcut: fullscreenShortcut });
  // F5 (and Ctrl/Cmd+R) refresh all only while the browser is in full screen, where a page reload would leave it.
  const refreshAllTooltip = isRefreshingWorkspace
    ? t('workspace.refreshing', { defaultValue: 'Refreshing…' })
    : t('workspace.labelWithShortcut', {
      label: refreshAllLabel,
      shortcut: t('workspace.refreshAllInFullscreen', { shortcut: formatShortcut(WORKSPACE_FULLSCREEN_REFRESH_SHORTCUT) }),
    });
  const newChatLabel = newChatProject
    ? t('workspace.newChatIn', { project: newChatProject.displayName, defaultValue: 'New chat in {{project}}' })
    : t('workspace.newChat', { defaultValue: 'New chat' });
  const previewHint = t('workspace.previewHint', { defaultValue: 'Preview · double-click to keep open' });
  const renameHint = t('workspace.renameHint', { defaultValue: 'Double-click or F2 to rename' });

  return (
    <div
      data-pane-tab-bar={side}
      className={cn(
        'pwa-header-safe flex h-10 flex-shrink-0 items-stretch border-b border-border/60 py-0 [@media(pointer:coarse)]:h-11',
        isDimmed ? 'bg-muted/50' : 'bg-muted/30',
      )}
      onDragOver={handleBarDragOver}
      onDragLeave={handleBarDragLeave}
      onDrop={handleBarDrop}
    >
      {isCollapsed && (
        <div className="flex flex-shrink-0 items-center gap-0.5 border-e border-border/50 px-1">
          {WORKSPACE_PANE_SIDES.map((switchSide) => {
            const isCurrent = switchSide === side;
            const label = visualPaneSide(switchSide) === 'left'
              ? t('workspace.focusLeftPane', { defaultValue: 'Focus left pane' })
              : t('workspace.focusRightPane', { defaultValue: 'Focus right pane' });
            return (
              <button
                key={switchSide}
                type="button"
                aria-pressed={isCurrent}
                aria-label={label}
                title={isCurrent ? label : t('workspace.showHiddenSide', { defaultValue: 'Show the hidden pane' })}
                onClick={() => {
                  if (!isCurrent) {
                    actions.focusPane(switchSide);
                  }
                }}
                className={cn(
                  'relative flex h-8 w-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                  isCurrent ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <PaneSideGlyph placement={switchSide} />
                {!isCurrent && hiddenPaneActivity && (
                  <span
                    data-hidden-pane-activity={hiddenPaneActivity}
                    aria-hidden="true"
                    className={cn(
                      'absolute end-0.5 top-0.5 h-1.5 w-1.5 rounded-full',
                      hiddenPaneActivity === 'attention' ? 'bg-amber-500' : 'bg-primary',
                    )}
                  />
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Workspace-wide controls (data-workspace-control): pressing them does not focus this pane. */}
      {isImmersive && isLeftmost && (
        <div data-workspace-control="" className="flex flex-shrink-0 items-center px-1">
          <Tooltip content={t('workspace.showSidebar', { defaultValue: 'Show sidebar' })} position="bottom">
            <button
              type="button"
              aria-label={t('workspace.showSidebar', { defaultValue: 'Show sidebar' })}
              aria-haspopup="dialog"
              aria-expanded={isSidebarPeekOpen}
              onClick={() => setSidebarPeekOpen(true)}
              className={ICON_BUTTON_CLASS_NAME}
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
      )}

      <div className="relative flex min-w-0 flex-initial">
        {canScrollLeft && (
          <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-8 bg-gradient-to-r from-background/90 to-transparent" />
        )}
        {/*
          One grid column per tab. Short of room, the columns share it out evenly, none wider than its tab
          wants (max-w-64 at most) nor narrower than the tab's minimum: a short tab stays whole while a long
          one truncates, where flex shrinking would trim every tab in proportion. Past the minimum, it scrolls.
        */}
        <div
          ref={stripRef}
          role="tablist"
          aria-label={t('workspace.openTabsGroup', { defaultValue: 'Open tabs' })}
          aria-orientation="horizontal"
          onScroll={updateScrollState}
          onDoubleClick={handleStripDoubleClick}
          className="scrollbar-hide grid min-w-0 grid-flow-col items-stretch overflow-x-auto overscroll-x-contain"
        >
          {tabs.map((tab, index) => {
            const display = tabDisplay.get(tab.key);
            const title = getTabLabel(tab);
            const projectName = display?.projectName ?? '';
            const isActive = tab.key === pane.activeTabKey;
            const isRenamable = canRenameTab(tab);
            // A draft is named "New chat" whatever its project, and before its first send nothing else
            // on screen says where it will run.
            const showsProjectName = Boolean(projectName) && (showProjectNames || tab.sessionId === null);
            const tooltipLines = [
              title,
              projectName,
              tab.isPreview ? previewHint : null,
              // A double-click renames only the active kept tab (it keeps a preview open instead).
              isActive && !tab.isPreview && isRenamable ? renameHint : null,
            ].filter(Boolean);
            return (
              <div
                key={tab.key}
                id={`${panelId}-${tab.key}`}
                role="tab"
                aria-selected={isActive}
                aria-controls={panelId}
                aria-keyshortcuts={isRenamable ? RENAME_TAB_SHORTCUT : undefined}
                tabIndex={isActive ? 0 : -1}
                title={tooltipLines.join('\n')}
                draggable
                data-tab-key={tab.key}
                data-preview={tab.isPreview ? '' : undefined}
                onClick={() => actions.activateTab(side, tab.key)}
                onDoubleClick={() => handleTabDoubleClick(tab)}
                onMouseDown={(event) => handleTabMouseDown(event, tab, isActive)}
                onAuxClick={(event) => handleTabAuxClick(event, tab)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openTabMenu(tab.key, event.clientX, event.clientY);
                }}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                onDragStart={(event) => handleTabDragStart(event, tab)}
                // At its minimum a tab still shows its icon, about three letters and an ellipsis, and its
                // close button (32px under a coarse pointer, hence the wider minimum); with an activity mark
                // and a project suffix as well, the title and the suffix give way and nothing is clipped.
                className={cn(
                  'group relative flex h-full min-w-28 max-w-64 cursor-pointer select-none items-center gap-2 border-e border-border/50 pe-1.5 ps-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60 [@media(pointer:coarse)]:min-w-[7.5rem]',
                  isActive
                    ? (isDimmed ? 'bg-background/70 text-foreground/70' : 'bg-background text-foreground')
                    : (isDimmed ? 'text-muted-foreground/70 hover:bg-accent/40' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'),
                )}
              >
                {isActive && isSplit && isFocused && (
                  <span data-focus-accent="" aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5 bg-primary" />
                )}
                {dropIndex === index && (
                  <span data-drop-caret="before" aria-hidden="true" className="pointer-events-none absolute inset-y-1 -start-px w-0.5 rounded-full bg-primary" />
                )}
                {dropIndex === tabs.length && index === tabs.length - 1 && (
                  <span data-drop-caret="after" aria-hidden="true" className="pointer-events-none absolute inset-y-1 -end-px w-0.5 rounded-full bg-primary" />
                )}
                <LLMProviderLogo provider={tab.provider} className="h-4 w-4 flex-shrink-0" />
                <span data-tab-title="" className={cn('bidi-auto min-w-0 truncate', tab.isPreview && 'italic')}>{title}</span>
                {showsProjectName && (
                  // Gives way before the title does. The separator is drawn, a screen reader hears a comma.
                  <span data-tab-project="" className="min-w-0 max-w-24 shrink-[4] truncate text-[11px] text-muted-foreground">
                    <span aria-hidden="true">· </span>
                    <span className="sr-only">, </span>
                    {projectName}
                  </span>
                )}
                {/* Never shrinks, and keeps to the right edge of a short tab held at its minimum width. */}
                <span data-tab-end="" className="ms-auto flex flex-shrink-0 items-center gap-2">
                  <TabActivityMark activity={display?.activity ?? null} />
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={t('workspace.closeTab', { defaultValue: 'Close tab' })}
                    onClick={(event) => {
                      event.stopPropagation();
                      actions.closeTab(side, tab.key);
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                    className={cn(
                      'touch:opacity-100 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded transition-colors hover:bg-accent hover:text-foreground group-hover:opacity-100 group-focus-visible:opacity-100 [@media(pointer:coarse)]:h-8 [@media(pointer:coarse)]:w-8',
                      isActive ? 'opacity-100' : 'opacity-0',
                    )}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
        {canScrollRight && (
          <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-background/90 to-transparent" />
        )}
      </div>

      <div className="flex flex-shrink-0 items-center gap-0.5 px-1">
        <Tooltip content={newChatLabel} position="bottom">
          <button
            type="button"
            aria-label={newChatLabel}
            aria-disabled={!newChatProject || undefined}
            onClick={startNewChat}
            className={cn(ICON_BUTTON_CLASS_NAME, !newChatProject && 'cursor-not-allowed opacity-50')}
          >
            <Plus className="h-4 w-4" />
          </button>
        </Tooltip>
        {showAllTabsMenu && (
          <ActionMenu
            label={t('workspace.allTabs', { defaultValue: 'All tabs' })}
            icon={ChevronDown}
            iconOnly
            portal
            variant="ghost"
            size="sm"
            items={allTabsItems}
            triggerClassName="h-8 w-8 px-0 text-muted-foreground"
            menuClassName="max-h-80 overflow-y-auto"
          />
        )}
      </div>

      {/* The bar's empty stretch: a double-click there starts a new chat, as on the strip's own blank space. */}
      <div data-tab-bar-blank="" className="min-w-4 flex-1" onDoubleClick={handleStripDoubleClick} />

      {/* The view bar scrolls itself (PaneViewBar) once this container gets less than it needs. */}
      {trailingContent && (
        <div data-tab-bar-trailing="" className={cn('flex min-w-0 items-center gap-2 px-1', trailingCanShrink ? 'flex-shrink' : 'flex-shrink-0')}>
          {trailingContent}
        </div>
      )}

      <div className="flex flex-shrink-0 items-center gap-0.5 pe-1">
        {onRefreshTab && (
          <Tooltip content={refreshTabLabel} position="bottom">
            <button
              type="button"
              aria-label={refreshTabLabel}
              aria-disabled={!canRefreshTab || undefined}
              onClick={() => {
                if (canRefreshTab) {
                  onRefreshTab();
                }
              }}
              className={cn(ICON_BUTTON_CLASS_NAME, !canRefreshTab && 'cursor-not-allowed opacity-50 hover:bg-transparent')}
            >
              <RotateCw className="h-4 w-4" />
            </button>
          </Tooltip>
        )}
        {(tabs.length > 0 || isSplit) && (
          <ActionMenu
            label={t('workspace.paneMenu', { defaultValue: 'Pane actions' })}
            icon={MoreHorizontal}
            iconOnly
            portal
            variant="ghost"
            size="sm"
            items={paneMenuItems}
            triggerClassName="h-8 w-8 px-0 text-muted-foreground"
          />
        )}
        {showWorkspaceControls && (
          // The tooltips open toward the start of the line: these buttons end the row at the edge of
          // the window (its left edge right to left), where a tooltip centred below them was cut off.
          <div data-workspace-control="" className="flex items-center gap-0.5">
            {onRefreshWorkspace && (
              <Tooltip content={refreshAllTooltip} position="left">
                <button
                  type="button"
                  aria-label={refreshAllLabel}
                  aria-disabled={isRefreshingWorkspace || undefined}
                  aria-busy={isRefreshingWorkspace || undefined}
                  onClick={refreshWorkspaceUnlessBusy}
                  className={ICON_BUTTON_CLASS_NAME}
                >
                  <RefreshCw className={cn('h-4 w-4', isRefreshingWorkspace && 'animate-spin')} />
                </button>
              </Tooltip>
            )}
            <Tooltip content={splitTooltip} position="left">
              <button
                type="button"
                data-workspace-split-toggle=""
                aria-label={splitLabel}
                aria-disabled={isSplitUnavailable || undefined}
                onClick={(event) => {
                  if (!isSplitUnavailable) {
                    toggleSplitKeepingFocus(event);
                  }
                }}
                className={cn(ICON_BUTTON_CLASS_NAME, isSplitUnavailable && 'cursor-not-allowed opacity-50 hover:bg-transparent')}
              >
                <Columns2 className="h-4 w-4" />
              </button>
            </Tooltip>
            <Tooltip content={fullscreenTooltip} position="left">
              <button
                type="button"
                aria-label={fullscreenLabel}
                onClick={toggleImmersive}
                className={ICON_BUTTON_CLASS_NAME}
              >
                {isImmersive ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>
            </Tooltip>
          </div>
        )}
      </div>

      {tabMenu && menuTab && (
        <PaneTabContextMenu
          anchor={tabMenu.anchor}
          label={getTabLabel(menuTab)}
          items={menuItems}
          onClose={closeTabMenu}
        />
      )}

      {renamingTab?.sessionId && (
        <PaneTabRenameInput
          key={renamingTab.key}
          tabElementId={`${panelId}-${renamingTab.key}`}
          sessionId={renamingTab.sessionId}
          title={tabDisplay.get(renamingTab.key)?.title ?? renamingTab.title}
          onRenameSession={onRenameSession}
          onClose={(restoreFocus) => finishRename(renamingTab.key, restoreFocus)}
        />
      )}
    </div>
  );
}
