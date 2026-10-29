import { Fragment } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { forwardArrowKey } from '@/shared/direction';
import { Tooltip, PillBar, Pill } from '@/shared/ui';
import type { AppTab, WorkspaceViewLabels, WorkspaceViewSetter } from '@/shared/types';
import { cn } from '@/shared/utils';
import { PluginIcon } from '@/modules/plugins';
import { useWorkspaceViews } from '@/modules/project-workspace/hooks/useWorkspaceViews';

type WorkspaceTabsProps = {
  activeTab: AppTab;
  /** Called with userInitiated, so picking a view keeps a preview tab open. */
  setActiveTab: WorkspaceViewSetter;
  shouldShowTasksTab: boolean;
  shouldShowBrowserTab: boolean;
  /**
   * 'phone' (default): the phone header's bordered bar, where only the active view keeps its label below
   * the lg breakpoint. 'pane': a desktop pane's view bar, with larger icons and labels set by `labels`.
   */
  variant?: 'phone' | 'pane';
  /** Which views show their label in the 'pane' variant; ignored by 'phone'. Default 'all'. */
  labels?: WorkspaceViewLabels;
};

/**
 * Rendered by WorkspaceHeader (the phone header) and by PaneViewBar (a desktop pane's view bar) to
 * show the built-in workspace tabs plus any enabled plugin tabs.
 */
export default function WorkspaceTabs({
  activeTab,
  setActiveTab,
  shouldShowTasksTab,
  shouldShowBrowserTab,
  variant = 'phone',
  labels = 'all',
}: WorkspaceTabsProps) {
  const { t } = useTranslation();
  const { builtInViews, pluginViews } = useWorkspaceViews({ shouldShowTasksTab, shouldShowBrowserTab });
  const isPane = variant === 'pane';

  const tabs = [...builtInViews, ...pluginViews];

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const tabList = event.currentTarget.closest('[role="tablist"]');
    if (!tabList) return;

    const tabButtons = Array.from(tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const currentIndex = tabButtons.indexOf(event.currentTarget);
    let nextIndex: number;

    // The arrow pointing along the row moves on: ArrowLeft right to left.
    const forward = forwardArrowKey(tabList);
    if (event.key === forward) nextIndex = (currentIndex + 1) % tabButtons.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') nextIndex = (currentIndex - 1 + tabButtons.length) % tabButtons.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabButtons.length - 1;
    else return;

    event.preventDefault();
    tabButtons[nextIndex]?.focus();
    tabButtons[nextIndex]?.click();
  };

  return (
    <PillBar
      role="tablist"
      aria-label={t('tabs.views', { defaultValue: 'Workspace views' })}
      className={cn(
        'min-w-max bg-muted/50',
        // The pane bar drops the border and keeps a slim padding so it fits a 40px row.
        isPane ? 'p-0.5' : 'border border-border/40 shadow-inner shadow-black/[0.025] dark:shadow-black/10',
      )}
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTab;
        const displayLabel = tab.kind === 'builtin' ? t(tab.labelKey) : tab.label;

        return (
          <Fragment key={`${tab.id}-${index}`}>
            {index === builtInViews.length && pluginViews.length > 0 && (
              <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
            )}
            <Tooltip content={displayLabel} position="bottom">
              <Pill
                role="tab"
                aria-label={displayLabel}
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                isActive={isActive}
                onClick={() => setActiveTab(tab.id, { userInitiated: true })}
                onKeyDown={handleTabKeyDown}
                className={isPane ? 'h-8 max-w-40 gap-1.5 px-2.5 py-0' : 'h-8 max-w-44 px-2.5 py-[5px]'}
              >
                {tab.kind === 'builtin' ? (
                  <tab.icon className={cn(isPane ? 'h-4 w-4' : 'h-3.5 w-3.5', 'shrink-0')} strokeWidth={isActive ? 2.2 : 1.8} />
                ) : (
                  <PluginIcon
                    pluginName={tab.pluginName}
                    iconFile={tab.iconFile}
                    className={cn(
                      isPane ? 'h-4 w-4' : 'h-3.5 w-3.5',
                      'flex shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full',
                    )}
                  />
                )}
                {/* The pane bar labels by the pane's width (WorkspacePane), never by the viewport. */}
                <span
                  className={isPane
                    ? cn('max-w-32 truncate', labels === 'active' && !isActive && 'hidden')
                    : cn(isActive ? 'inline max-w-28' : 'hidden', 'truncate sm:max-w-36', 'lg:inline')}
                >
                  {displayLabel}
                </span>
              </Pill>
            </Tooltip>
          </Fragment>
        );
      })}
    </PillBar>
  );
}
