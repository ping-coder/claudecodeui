import { ChevronDown, Columns2, Loader2, Maximize2, Minimize2, MoreHorizontal, PanelLeftOpen, Plus, X } from 'lucide-react';
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
import { PANE_TAB_DRAG_EFFECT } from '@/shared/constants';
import type {
  PaneTabActivity,
  PaneTabDisplay,
  Project,
  WorkspaceLayoutActions,
  WorkspacePaneSide,
  WorkspacePaneState,
  WorkspaceSessionTab,
} from '@/shared/types';
import { ActionMenu, LLMProviderLogo, PaneSideGlyph, Tooltip } from '@/shared/ui';
import {
  cn,
  copyTextToClipboard,
  formatShortcut,
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
  /** Immersive: the compact view bar and the connection status that replace the hidden header. */
  immersiveContent?: ReactNode;
};

/** Open state of the tab context menu: which tab it acts on and the viewport point it opens at. */
type TabMenuState = { tabKey: string; anchor: { x: number; y: number } };

const otherSideOf = (side: WorkspacePaneSide): WorkspacePaneSide => (side === 'left' ? 'right' : 'left');

const ICON_BUTTON_CLASS_NAME = 'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60';

/**
 * Where a drag over the strip would land: the index of the first tab whose middle lies right of
 * the pointer, or the tab count when the pointer is past the last tab.
 */
const getDropIndex = (strip: HTMLElement | null, clientX: number): number => {
  const tabElements = Array.from(strip?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
  const index = tabElements.findIndex((element) => {
    const rect = element.getBoundingClientRect();
    return clientX < rect.left + rect.width / 2;
  });
  return index < 0 ? tabElements.length : index;
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
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-hidden="true" />
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
          'h-1.5 w-1.5 flex-shrink-0 rounded-full',
          activity === 'attention' ? 'bg-amber-500' : 'bg-purple-500 dark:bg-purple-400',
        )}
      />
    );
  }
  return null;
}

/**
 * Rendered by WorkspacePane on desktop: the pane's row of session tabs (a tablist with roving focus,
 * preview tabs in italics, drag to reorder or onto the other pane, Alt to copy, a right-click menu),
 * plus the pane's controls. The rightmost visible pane also carries split/merge and full screen.
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
  immersiveContent,
}: PaneTabBarProps) {
  const { t } = useTranslation();
  const { canSplit, isImmersive, toggleImmersive, setSidebarPeekOpen } = useWorkspaceChrome();
  const stripRef = useRef<HTMLDivElement>(null);
  const { canScrollLeft, canScrollRight, updateScrollState } = useHorizontalWheelScroll(stripRef, pane.activeTabKey);
  const hasOverflow = canScrollLeft || canScrollRight;
  // Where a dragged tab or conversation would be inserted (drawn as a 2px caret); null while nothing is dragged over the bar.
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // The tab context menu, while open.
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null);

  const tabs = pane.tabs;
  const isDimmed = isSideBySide && !isFocused;
  const canTargetOtherSide = isSplit || canSplit;

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
    window.requestAnimationFrame(() => {
      (getTabElement(closingTabKey) ?? stripRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'))?.focus();
    });
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, index: number) => {
    const tab = tabs[index];
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openTabMenu(tab.key, rect.left, rect.bottom);
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

    let nextIndex: number;
    if (event.key === 'ArrowRight') {
      nextIndex = (index + 1) % tabs.length;
    } else if (event.key === 'ArrowLeft') {
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

  const handleTabMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    // A middle press would start the browser's autoscroll; the release closes the tab instead.
    if (event.button === 1) {
      event.preventDefault();
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
    if (event.dataTransfer.effectAllowed === PANE_TAB_DRAG_EFFECT) {
      event.dataTransfer.dropEffect = event.altKey ? 'copy' : 'move';
    }
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
      actions.openSession(
        { id: payload.sessionId, __projectId: payload.projectId ?? undefined, __provider: payload.provider },
        { target: side, preview: false },
      );
    }
  };

  const handleStripDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    // Only the empty part of the strip; a double-click on a tab keeps it open instead.
    if (event.target === event.currentTarget) {
      startNewChat();
    }
  };

  const menuTab = tabMenu ? tabs.find((tab) => tab.key === tabMenu.tabKey) ?? null : null;
  const menuTabIndex = menuTab ? tabs.indexOf(menuTab) : -1;
  const otherSide = otherSideOf(side);
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
      label: t('workspace.closeTabsToRight', { defaultValue: 'Close tabs to the right' }),
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
    ...(menuTab.sessionId ? [{
      key: 'copySessionId',
      label: t('workspace.copySessionId', { defaultValue: 'Copy session ID' }),
      separatorBefore: true,
      onSelect: () => {
        void copyTextToClipboard(menuTab.sessionId as string);
      },
    }] : []),
  ] : [];

  const allTabsItems = tabs.map((tab) => {
    const display = tabDisplay.get(tab.key);
    return {
      key: tab.key,
      label: display?.title ?? tab.title,
      description: display?.projectName || undefined,
      onSelect: () => actions.activateTab(side, tab.key),
    };
  });

  const paneMenuItems = [
    {
      key: 'closeAll',
      label: t('workspace.closeAllTabs', { defaultValue: 'Close all tabs' }),
      disabled: tabs.length === 0,
      onSelect: () => actions.closeAllTabs(side),
    },
    ...(isSplit ? [{
      key: 'closePane',
      label: t('workspace.closePane', { defaultValue: 'Close this side' }),
      onSelect: () => actions.closePane(side),
    }] : []),
  ];

  const splitShortcut = formatShortcut(['mod', '\\']);
  const fullscreenShortcut = formatShortcut(['mod', 'shift', 'enter']);
  const isSplitUnavailable = !isSplit && !canSplit;
  const splitLabel = isSplit ? t('workspace.merge', { defaultValue: 'Merge panes' }) : t('workspace.split', { defaultValue: 'Split view' });
  const splitTooltip = isSplitUnavailable
    ? t('workspace.splitDisabled', { defaultValue: 'Widen the window to split' })
    : `${splitLabel} (${splitShortcut})`;
  const fullscreenLabel = isImmersive
    ? t('workspace.exitFullscreen', { defaultValue: 'Exit full screen' })
    : t('workspace.fullscreen', { defaultValue: 'Full screen' });
  const newChatLabel = newChatProject
    ? t('workspace.newChatIn', { project: newChatProject.displayName, defaultValue: 'New chat in {{project}}' })
    : t('workspace.newChat', { defaultValue: 'New chat' });
  const previewHint = t('workspace.previewHint', { defaultValue: 'Preview · double-click to keep open' });

  return (
    <div
      data-pane-tab-bar={side}
      className={cn(
        'pwa-header-safe flex h-9 flex-shrink-0 items-stretch border-b border-border/60 py-0 [@media(pointer:coarse)]:h-10',
        isDimmed ? 'bg-muted/50' : 'bg-muted/30',
      )}
      onDragOver={handleBarDragOver}
      onDragLeave={handleBarDragLeave}
      onDrop={handleBarDrop}
    >
      {isCollapsed && (
        <div className="flex flex-shrink-0 items-center gap-0.5 border-r border-border/50 px-1">
          {(['left', 'right'] as const).map((switchSide) => {
            const isCurrent = switchSide === side;
            const label = switchSide === 'left'
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
                  'relative flex h-7 w-7 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                  isCurrent ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <PaneSideGlyph placement={switchSide} />
                {!isCurrent && hiddenPaneActivity && (
                  <span
                    data-hidden-pane-activity={hiddenPaneActivity}
                    aria-hidden="true"
                    className={cn(
                      'absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full',
                      hiddenPaneActivity === 'attention' ? 'bg-amber-500' : 'bg-primary',
                    )}
                  />
                )}
              </button>
            );
          })}
        </div>
      )}

      {isImmersive && isLeftmost && (
        <div className="flex flex-shrink-0 items-center px-1">
          <Tooltip content={t('workspace.showSidebar', { defaultValue: 'Show sidebar' })} position="bottom">
            <button
              type="button"
              aria-label={t('workspace.showSidebar', { defaultValue: 'Show sidebar' })}
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
        <div
          ref={stripRef}
          role="tablist"
          aria-label={t('workspace.openTabsGroup', { defaultValue: 'Open tabs' })}
          aria-orientation="horizontal"
          onScroll={updateScrollState}
          onDoubleClick={handleStripDoubleClick}
          className="scrollbar-hide flex min-w-0 items-stretch overflow-x-auto overscroll-x-contain"
        >
          {tabs.map((tab, index) => {
            const display = tabDisplay.get(tab.key);
            const title = display?.title ?? tab.title;
            const isActive = tab.key === pane.activeTabKey;
            const tooltipLines = [title, display?.projectName, tab.isPreview ? previewHint : null].filter(Boolean);
            return (
              <div
                key={tab.key}
                id={`${panelId}-${tab.key}`}
                role="tab"
                aria-selected={isActive}
                aria-controls={panelId}
                tabIndex={isActive ? 0 : -1}
                title={tooltipLines.join('\n')}
                draggable
                data-tab-key={tab.key}
                data-preview={tab.isPreview ? '' : undefined}
                onClick={() => actions.activateTab(side, tab.key)}
                onDoubleClick={() => actions.pinTab(side, tab.key)}
                onMouseDown={handleTabMouseDown}
                onAuxClick={(event) => handleTabAuxClick(event, tab)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openTabMenu(tab.key, event.clientX, event.clientY);
                }}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                onDragStart={(event) => handleTabDragStart(event, tab)}
                className={cn(
                  'group relative flex h-full max-w-56 flex-none cursor-pointer select-none items-center gap-1.5 border-r border-border/50 pl-2.5 pr-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60',
                  isActive
                    ? (isDimmed ? 'bg-background/70 text-foreground/70' : 'bg-background text-foreground')
                    : (isDimmed ? 'text-muted-foreground/70 hover:bg-accent/40' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'),
                )}
              >
                {isActive && isSplit && isFocused && (
                  <span data-focus-accent="" aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5 bg-primary" />
                )}
                {dropIndex === index && (
                  <span data-drop-caret="before" aria-hidden="true" className="pointer-events-none absolute inset-y-1 -left-px w-0.5 rounded-full bg-primary" />
                )}
                {dropIndex === tabs.length && index === tabs.length - 1 && (
                  <span data-drop-caret="after" aria-hidden="true" className="pointer-events-none absolute inset-y-1 -right-px w-0.5 rounded-full bg-primary" />
                )}
                <LLMProviderLogo provider={tab.provider} className="h-3.5 w-3.5 flex-shrink-0" />
                <span className={cn('min-w-0 truncate', tab.isPreview && 'italic')}>{title}</span>
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
                    'touch:opacity-100 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded transition-colors hover:bg-accent hover:text-foreground group-hover:opacity-100 group-focus-visible:opacity-100',
                    isActive ? 'opacity-100' : 'opacity-0',
                  )}
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
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
        {hasOverflow && (
          <ActionMenu
            label={t('workspace.allTabs', { defaultValue: 'All tabs' })}
            icon={ChevronDown}
            iconOnly
            portal
            variant="ghost"
            size="sm"
            items={allTabsItems}
            triggerClassName="h-7 w-7 px-0 text-muted-foreground"
            menuClassName="max-h-80 overflow-y-auto"
          />
        )}
      </div>

      {/* The bar's empty stretch: a double-click there starts a new chat, as on the strip's own blank space. */}
      <div data-tab-bar-blank="" className="min-w-4 flex-1" onDoubleClick={handleStripDoubleClick} />

      {immersiveContent && (
        <div className="scrollbar-hide flex min-w-0 flex-shrink items-center gap-2 overflow-x-auto px-1">{immersiveContent}</div>
      )}

      <div className="flex flex-shrink-0 items-center gap-0.5 pr-1">
        {(tabs.length > 0 || isSplit) && (
          <ActionMenu
            label={t('workspace.paneMenu', { defaultValue: 'Pane actions' })}
            icon={MoreHorizontal}
            iconOnly
            portal
            variant="ghost"
            size="sm"
            items={paneMenuItems}
            triggerClassName="h-7 w-7 px-0 text-muted-foreground"
          />
        )}
        {showWorkspaceControls && (
          <>
            <Tooltip content={splitTooltip} position="bottom">
              <button
                type="button"
                aria-label={splitLabel}
                aria-disabled={isSplitUnavailable || undefined}
                onClick={() => {
                  if (!isSplitUnavailable) {
                    actions.toggleSplit();
                  }
                }}
                className={cn(ICON_BUTTON_CLASS_NAME, isSplitUnavailable && 'cursor-not-allowed opacity-50 hover:bg-transparent')}
              >
                <Columns2 className="h-4 w-4" />
              </button>
            </Tooltip>
            <Tooltip content={`${fullscreenLabel} (${fullscreenShortcut})`} position="bottom">
              <button
                type="button"
                aria-label={fullscreenLabel}
                onClick={toggleImmersive}
                className={ICON_BUTTON_CLASS_NAME}
              >
                {isImmersive ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>
            </Tooltip>
          </>
        )}
      </div>

      {tabMenu && menuTab && (
        <PaneTabContextMenu
          anchor={tabMenu.anchor}
          label={tabDisplay.get(menuTab.key)?.title ?? menuTab.title}
          items={menuItems}
          onClose={closeTabMenu}
        />
      )}
    </div>
  );
}
