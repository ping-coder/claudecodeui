import { useRef } from 'react';

import { useHorizontalWheelScroll } from '@/modules/project-workspace/hooks/useHorizontalWheelScroll';
import WorkspaceTabs from '@/modules/project-workspace/WorkspaceTabs';
import type { AppTab, WorkspaceViewLabels, WorkspaceViewSetter } from '@/shared/types';

type PaneViewBarProps = {
  activeTab: AppTab;
  /** Called with userInitiated, so picking a view keeps a preview tab open. */
  setActiveTab: WorkspaceViewSetter;
  shouldShowTasksTab: boolean;
  shouldShowBrowserTab: boolean;
  /** Which views show their label, picked by WorkspacePane from the pane's width. */
  labels: WorkspaceViewLabels;
};

/**
 * Rendered by WorkspacePane in the pane's tab bar (wide panes, immersive) and by WorkspaceMain as the
 * row under it (narrower panes): a desktop pane's view switcher. When it does not fit it scrolls
 * sideways, a vertical wheel included, with fades over the hidden part.
 */
export default function PaneViewBar({
  activeTab,
  setActiveTab,
  shouldShowTasksTab,
  shouldShowBrowserTab,
  labels,
}: PaneViewBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { canScrollLeft, canScrollRight, updateScrollState } = useHorizontalWheelScroll(scrollRef, activeTab);

  return (
    <div className="relative min-w-0">
      {canScrollLeft && (
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-8 bg-gradient-to-r from-background/90 to-transparent" />
      )}
      {/* The 1px padding keeps a focused pill's ring (3px past it, 2px of which the bar's padding holds) from being clipped. */}
      <div ref={scrollRef} onScroll={updateScrollState} className="scrollbar-hide overflow-x-auto overscroll-x-contain p-px">
        <WorkspaceTabs
          variant="pane"
          labels={labels}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          shouldShowTasksTab={shouldShowTasksTab}
          shouldShowBrowserTab={shouldShowBrowserTab}
        />
      </div>
      {canScrollRight && (
        <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-background/90 to-transparent" />
      )}
    </div>
  );
}
