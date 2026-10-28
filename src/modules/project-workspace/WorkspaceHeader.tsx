import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useRef } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { AppTab, Project, ProjectSession, WorkspaceViewSetter } from '@/shared/types';
import { cn } from '@/shared/utils';
import { DeploymentEnvironmentBadge } from '@/shared/ui';
import { useHorizontalWheelScroll } from '@/modules/project-workspace/hooks/useHorizontalWheelScroll';
import MobileMenuButton from '@/modules/project-workspace/MobileMenuButton';
import WorkspaceConnectionStatus from '@/modules/project-workspace/WorkspaceConnectionStatus';
import WorkspaceTabs from '@/modules/project-workspace/WorkspaceTabs';
import WorkspaceTitle from '@/modules/project-workspace/WorkspaceTitle';

type WorkspaceHeaderProps = {
  activeTab: AppTab;
  setActiveTab: WorkspaceViewSetter;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
  shouldShowBrowserTab: boolean;
  isMobile: boolean;
  onMenuClick: () => void;
  /** Persists a new title for a session; resolves false when the backend refuses it. */
  onRenameSession: (sessionId: string, summary: string) => Promise<boolean>;
  /** Controls at the end of the first row: the phone's tabs and full-screen buttons. */
  headerActions?: ReactNode;
};

/**
 * Rendered by WorkspaceMain on phones to show the workspace title and chat connection status alongside
 * the scrollable view tabs. A desktop pane has no header: its tab names the session, and its view bar
 * sits in the tab bar or in a row of its own (PaneViewBar).
 */
export default function WorkspaceHeader({
  activeTab,
  setActiveTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  shouldShowBrowserTab,
  isMobile,
  onMenuClick,
  onRenameSession,
  headerActions = null,
}: WorkspaceHeaderProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { canScrollLeft, canScrollRight, updateScrollState, scrollByPage } = useHorizontalWheelScroll(scrollRef, activeTab);
  const hasOverflow = canScrollLeft || canScrollRight;

  return (
    <header className="pwa-header-safe flex-shrink-0 border-b border-border/60 bg-background/95 px-3 py-1.5 backdrop-blur-sm sm:px-4 sm:py-2">
      <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex min-w-0 items-center gap-2 sm:max-w-[min(34%,24rem)] sm:flex-[1_1_18rem]">
          {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
          {/* On phones the sidebar (which carries the badge) is a closed drawer, so the
              header marks a non-production deployment itself. */}
          {isMobile && <DeploymentEnvironmentBadge className="max-w-20" />}
          <WorkspaceTitle
            activeTab={activeTab}
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            shouldShowTasksTab={shouldShowTasksTab}
            onRenameSession={onRenameSession}
          />
          <WorkspaceConnectionStatus />
          {headerActions && <div className="ml-auto flex flex-shrink-0 items-center gap-1">{headerActions}</div>}
        </div>

        <div className="-mx-3 min-w-0 sm:mx-0 sm:flex-1">
          <div className="relative ml-auto w-fit max-w-full">
            {canScrollLeft && (
              <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-12 bg-gradient-to-r from-background via-background/90 to-transparent" />
            )}
            <div
              ref={scrollRef}
              onScroll={updateScrollState}
              className={cn(
                'scrollbar-hide max-w-full scroll-smooth overflow-x-auto overscroll-x-contain px-3 [-webkit-overflow-scrolling:touch]',
                hasOverflow ? 'sm:px-9' : 'sm:pl-3 sm:pr-0',
              )}
            >
              <WorkspaceTabs
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                shouldShowTasksTab={shouldShowTasksTab}
                shouldShowBrowserTab={shouldShowBrowserTab}
              />
            </div>
            {canScrollRight && (
              <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-12 bg-gradient-to-l from-background via-background/90 to-transparent" />
            )}

            {canScrollLeft && (
              <button
                type="button"
                onClick={() => scrollByPage(-1)}
                aria-label={t('navigation.scrollTabsLeft', { defaultValue: 'Scroll tabs left' })}
                className="absolute left-1 top-1/2 z-20 hidden h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md border border-border/70 bg-background/95 text-muted-foreground shadow-sm outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60 sm:flex"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            )}
            {canScrollRight && (
              <button
                type="button"
                onClick={() => scrollByPage(1)}
                aria-label={t('navigation.scrollTabsRight', { defaultValue: 'Scroll tabs right' })}
                className="absolute right-1 top-1/2 z-20 hidden h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md border border-border/70 bg-background/95 text-muted-foreground shadow-sm outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60 sm:flex"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
