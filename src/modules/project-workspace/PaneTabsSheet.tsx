import { Loader2, MessageSquarePlus, X } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  PaneTabActivity,
  PaneTabDisplay,
  Project,
  WorkspaceLayout,
  WorkspaceLayoutActions,
  WorkspacePaneSide,
} from '@/shared/types';
import { Dialog, DialogContent, DialogTitle, LLMProviderLogo } from '@/shared/ui';
import { cn } from '@/shared/utils';

type PaneTabsSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  layout: WorkspaceLayout;
  /** tabKey -> label and activity, for both panes. */
  tabDisplay: ReadonlyMap<string, PaneTabDisplay>;
  /** Project "New chat" starts in: the focused pane's, else the workspace default. */
  newChatProject: Project | null;
  actions: WorkspaceLayoutActions;
};

type SheetActivityMarkProps = {
  activity: PaneTabActivity | null;
};

/** Running sessions spin and ones needing attention get an amber dot, as in the sidebar. */
function SheetActivityMark({ activity }: SheetActivityMarkProps) {
  const { t } = useTranslation('sidebar');
  if (activity === 'running') {
    return (
      <span role="img" aria-label={t('tooltips.processingSessionIndicator', { defaultValue: 'Processing session' })} className="flex flex-shrink-0">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
      </span>
    );
  }
  if (activity === 'attention') {
    return (
      <span
        role="img"
        aria-label={t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })}
        className="h-2 w-2 flex-shrink-0 rounded-full bg-amber-500"
      />
    );
  }
  return null;
}

/**
 * Rendered by ProjectMainRegion on phones, opened from the header's Tabs button: a bottom sheet
 * (the same Dialog form as the sidebar's session sheet) listing the focused pane's tabs, grouped
 * left/right while a right pane exists. A row switches to its tab (and its side), × closes it,
 * and the footer starts a new chat or closes every listed tab.
 */
export default function PaneTabsSheet({
  open,
  onOpenChange,
  layout,
  tabDisplay,
  newChatProject,
  actions,
}: PaneTabsSheetProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const isSplit = layout.right !== null;
  const groups: Array<{ side: WorkspacePaneSide; label: string }> = isSplit
    ? [
      { side: 'left', label: t('workspace.leftPane', { defaultValue: 'Left pane' }) },
      { side: 'right', label: t('workspace.rightPane', { defaultValue: 'Right pane' }) },
    ]
    : [{ side: 'left', label: t('workspace.leftPane', { defaultValue: 'Left pane' }) }];
  const hasTabs = layout.left.tabs.length > 0 || (layout.right?.tabs.length ?? 0) > 0;

  const close = () => onOpenChange(false);

  const startNewChat = () => {
    if (newChatProject) {
      actions.openNewSession(newChatProject, { target: 'focused' });
    }
    close();
  };

  const closeAllTabs = () => {
    // One change for both panes, never half done. The pane on screen is the one left, so its chat and an
    // unsaved edit in its editor stay, hidden, as after closing its own last tab.
    actions.closeAllTabs('both');
    close();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-labelledby={titleId}
        animationClassName="animate-bottom-sheet-content-show motion-reduce:animate-none"
        className="bottom-0 left-0 top-auto max-h-[80vh] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-b-none rounded-t-2xl border-x-0 border-b-0 px-4 pb-safe-area-inset-bottom pt-3"
      >
        <DialogTitle id={titleId}>{t('workspace.allTabs', { defaultValue: 'All tabs' })}</DialogTitle>
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted-foreground/30" aria-hidden="true" />

        {groups.map(({ side, label }) => {
          const pane = side === 'left' ? layout.left : layout.right;
          if (!pane) {
            return null;
          }
          return (
            <section key={side} aria-label={label} className="mb-3">
              {isSplit && (
                <h3 className={cn('mb-1 px-1 text-xs font-medium uppercase tracking-wide', layout.focusedSide === side ? 'text-foreground' : 'text-muted-foreground')}>
                  {label}
                </h3>
              )}
              <ul className="space-y-1">
                {pane.tabs.map((tab) => {
                  const display = tabDisplay.get(tab.key);
                  const title = display?.title ?? tab.title;
                  const isCurrent = layout.focusedSide === side && pane.activeTabKey === tab.key;
                  return (
                    <li key={tab.key} className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-current={isCurrent ? 'page' : undefined}
                        onClick={() => {
                          actions.activateTab(side, tab.key);
                          close();
                        }}
                        className={cn(
                          'flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors active:bg-muted',
                          isCurrent ? 'border-primary/30 bg-primary/5' : 'border-border bg-muted/35',
                        )}
                      >
                        <LLMProviderLogo provider={tab.provider} className="h-4 w-4 flex-shrink-0" />
                        <span className="min-w-0 flex-1">
                          <span className={cn('block truncate text-sm text-foreground', tab.isPreview && 'italic')}>{title}</span>
                          {display?.projectName && (
                            <span className="block truncate text-xs text-muted-foreground">{display.projectName}</span>
                          )}
                        </span>
                        <SheetActivityMark activity={display?.activity ?? null} />
                      </button>
                      <button
                        type="button"
                        aria-label={t('workspace.closeTab', { defaultValue: 'Close tab' })}
                        onClick={() => actions.closeTab(side, tab.key)}
                        className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors active:bg-muted"
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}

        <div className="mb-3 mt-2 flex gap-2">
          <button
            type="button"
            onClick={startNewChat}
            disabled={!newChatProject}
            className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors active:bg-primary/80 disabled:opacity-50"
          >
            <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
            {t('workspace.newChat', { defaultValue: 'New chat' })}
          </button>
          <button
            type="button"
            onClick={closeAllTabs}
            disabled={!hasTabs}
            className="flex min-h-11 flex-1 items-center justify-center rounded-xl border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors active:bg-muted disabled:opacity-50"
          >
            {t('workspace.closeAllTabs', { defaultValue: 'Close all tabs' })}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
