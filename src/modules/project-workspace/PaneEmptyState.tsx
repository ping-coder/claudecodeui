import { ChevronDown, Copy, MessageSquarePlus, X } from 'lucide-react';
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { formatSessionTitle } from '@/modules/sidebar';
import {
  WORKSPACE_FOCUS_LEFT_PANE_SHORTCUT,
  WORKSPACE_FOCUS_RIGHT_PANE_SHORTCUT,
  WORKSPACE_FULLSCREEN_SHORTCUT,
  WORKSPACE_SPLIT_SHORTCUT,
} from '@/shared/constants';
import type {
  Project,
  ProjectSession,
  WorkspaceLayoutActions,
  WorkspacePaneSide,
} from '@/shared/types';
import { ActionMenu, LLMProviderLogo } from '@/shared/ui';
import { formatShortcut, readSessionProvider } from '@/shared/utils';
import WorkspaceStateView from '@/modules/project-workspace/WorkspaceStateView';

/** How many recent conversations an empty pane offers. */
const MAX_RECENT_CONVERSATIONS = 6;

type PaneEmptyStateProps = {
  side: WorkspacePaneSide;
  projects: Project[];
  /** Project "New chat in" starts in unless another one is picked from its menu. */
  defaultProject: Project | null;
  /** A right pane exists. */
  isSplit: boolean;
  /** The main column has room for two panes, so Mod+\ splits while unsplit. */
  canSplit: boolean;
  isMobile: boolean;
  /** The other pane's active conversation, offered as "Also open the current conversation here" while split. */
  otherPaneSession: ProjectSession | null;
  /** Conversations open in the other pane: left out of the recent list, which should not show one conversation twice by accident. */
  otherPaneSessionIds: ReadonlySet<string>;
  actions: WorkspaceLayoutActions;
  /** The phone's header row (menu button, pane controls), drawn above the content. */
  mobileHeader?: ReactNode;
  onMenuClick: () => void;
};

/** When a session was last touched, for ordering; 0 when it carries no usable date. */
const getSessionTime = (session: ProjectSession): number => {
  const raw = session.lastActivity || session.updated_at || session.createdAt || session.created_at;
  const time = raw ? new Date(String(raw)).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
};

/**
 * Rendered by WorkspacePane for a pane without tabs: recent conversations to open on this side, a
 * new chat in a chosen project, while split the other pane's conversation and a way to close this
 * side, and hints for dragging (or tapping) and the shortcuts. Without any project it shows the
 * workspace's create-a-project guidance instead.
 */
export default function PaneEmptyState({
  side,
  projects,
  defaultProject,
  isSplit,
  canSplit,
  isMobile,
  otherPaneSession,
  otherPaneSessionIds,
  actions,
  mobileHeader,
  onMenuClick,
}: PaneEmptyStateProps) {
  const { t } = useTranslation();

  const recentConversations = useMemo(() => {
    const entries: Array<{ session: ProjectSession; project: Project; time: number }> = [];
    for (const project of projects) {
      for (const session of project.sessions ?? []) {
        if (!otherPaneSessionIds.has(session.id)) {
          entries.push({ session, project, time: getSessionTime(session) });
        }
      }
    }
    entries.sort((left, right) => right.time - left.time);
    return entries.slice(0, MAX_RECENT_CONVERSATIONS);
  }, [otherPaneSessionIds, projects]);

  if (projects.length === 0) {
    return <WorkspaceStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  const projectMenuItems = projects.map((project) => ({
    key: project.projectId,
    label: project.displayName,
    onSelect: () => actions.openNewSession(project, { target: side }),
  }));
  // Only the keys that act right now: unsplit, Mod+1/2 stay with the browser (they switch its tabs),
  // and Mod+\ splits only where two panes fit.
  const shortcutKeys = {
    split: formatShortcut(WORKSPACE_SPLIT_SHORTCUT),
    left: formatShortcut(WORKSPACE_FOCUS_LEFT_PANE_SHORTCUT),
    right: formatShortcut(WORKSPACE_FOCUS_RIGHT_PANE_SHORTCUT),
    fullscreen: formatShortcut(WORKSPACE_FULLSCREEN_SHORTCUT),
  };
  let shortcutsHint: string;
  if (isSplit) {
    shortcutsHint = t('workspace.shortcutsHint', {
      ...shortcutKeys,
      defaultValue: '{{split}} split or merge · {{left}} / {{right}} switch panes · {{fullscreen}} full screen',
    });
  } else if (canSplit) {
    shortcutsHint = t('workspace.shortcutsHintUnsplit', {
      ...shortcutKeys,
      defaultValue: '{{split}} split · {{fullscreen}} full screen',
    });
  } else {
    shortcutsHint = t('workspace.shortcutsHintFullscreen', {
      ...shortcutKeys,
      defaultValue: '{{fullscreen}} full screen',
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {mobileHeader}
      <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-4 py-8">
        <div className="my-auto w-full max-w-md">
          <h2 className="mb-4 text-center text-lg font-semibold text-foreground">
            {side === 'right'
              ? t('workspace.emptyOtherTitle', { defaultValue: 'This side is empty' })
              : t('workspace.emptyTitle', { defaultValue: 'No conversation open' })}
          </h2>

          {defaultProject && (
            <div className="mb-3 flex items-stretch gap-1">
              <button
                type="button"
                onClick={() => actions.openNewSession(defaultProject, { target: side })}
                className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                <MessageSquarePlus className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {t('workspace.newChatIn', { project: defaultProject.displayName, defaultValue: 'New chat in {{project}}' })}
                </span>
              </button>
              {projects.length > 1 && (
                <ActionMenu
                  label={t('workspace.chooseProject', { defaultValue: 'Choose project' })}
                  icon={ChevronDown}
                  iconOnly
                  portal
                  items={projectMenuItems}
                  triggerClassName="h-full px-2"
                  menuClassName="max-h-72 overflow-y-auto"
                />
              )}
            </div>
          )}

          {isSplit && otherPaneSession && (
            <button
              type="button"
              onClick={() => actions.openSession(otherPaneSession, { target: side, preview: false })}
              className="mb-3 flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              <Copy className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
              <span className="truncate">{t('workspace.openCurrentHere', { defaultValue: 'Also open the current conversation here' })}</span>
            </button>
          )}

          {recentConversations.length > 0 && (
            <section className="mb-4" aria-labelledby={`pane-${side}-recent-heading`}>
              <h3 id={`pane-${side}-recent-heading`} className="mb-1.5 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('workspace.recentConversations', { defaultValue: 'Recent conversations' })}
              </h3>
              <ul className="space-y-0.5">
                {recentConversations.map(({ session, project }) => {
                  const provider = readSessionProvider(session);
                  // The server's placeholder names ("Untitled Claude Session") read in the interface language.
                  const title = formatSessionTitle(
                    String(session.summary || session.name || session.title || t('mainContent.newSession', { defaultValue: 'New Session' })),
                    t,
                  );
                  return (
                    <li key={`${project.projectId}:${session.id}`}>
                      <button
                        type="button"
                        onClick={() => actions.openSession(
                          { ...session, __projectId: project.projectId, __provider: provider },
                          { target: side, preview: false },
                        )}
                        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                      >
                        <LLMProviderLogo provider={provider} className="h-3.5 w-3.5 flex-shrink-0" />
                        <span className="bidi-auto min-w-0 flex-1 truncate text-sm text-foreground">{title}</span>
                        <span className="bidi-auto max-w-[40%] flex-shrink-0 truncate text-xs text-muted-foreground">{project.displayName}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <div className="space-y-1 text-center text-xs text-muted-foreground">
            {/* The pointer decides which hint applies: drag and drop is a mouse feature. */}
            {!isMobile && (
              <p className="[@media(pointer:coarse)]:hidden">{t('workspace.dragHint', { defaultValue: 'Drag a conversation here from the sidebar' })}</p>
            )}
            <p className={isMobile ? undefined : 'hidden [@media(pointer:coarse)]:block'}>
              {t('workspace.touchHint', { defaultValue: 'Tap a conversation in the sidebar to open it on this side' })}
            </p>
            {!isMobile && <p className="[@media(pointer:coarse)]:hidden">{shortcutsHint}</p>}
          </div>

          {side === 'right' && (
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                onClick={() => actions.closePane('right')}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
                {t('workspace.closePane', { defaultValue: 'Close this side' })}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
