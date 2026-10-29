import { memo, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { Check, CheckSquare, Edit2, Loader2, MoreHorizontal, Square, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Badge, Dialog, DialogContent, DialogTitle, LLMProviderLogo, Tooltip, buttonVariants } from '@/shared/ui';
import { cn, writeSessionDragPayload } from '@/shared/utils';
import type {
  LLMProvider,
  Project,
  SessionOpenOptions,
  SessionPanePlacement,
  SessionWithProvider,
  WorkspacePaneSide,
} from '@/shared/types';
import { PROVIDER_LABELS, createSessionViewModel, formatCompactAge } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import { useCompactSidebar } from '@/modules/sidebar/hooks/useCompactSidebar';
import { useProviderSessionIdCopy } from '@/modules/sidebar/hooks/useProviderSessionIdCopy';
import SessionOptions from '@/modules/sidebar/SessionOptions';
import { PanePlacementMarker } from '@/modules/sidebar/SessionPaneButtons';

type SidebarSessionItemProps = {
  project: Project;
  session: SessionWithProvider;
  /** This row is the focused pane's session. Resolved per row, so a focus switch re-renders only the rows it highlights or unhighlights. */
  isSelected: boolean;
  isProcessing: boolean;
  /** The session's turn has ended but the agents, workflows or commands it launched still run. */
  hasBackgroundWork: boolean;
  needsAttention: boolean;
  currentTime: Date;
  /** Resolved for this row, so a keystroke elsewhere does not invalidate it. */
  isEditing: boolean;
  renameDraft: string;
  onRenameDraftChange: (draft: string) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onSessionSelect: (session: SessionWithProvider, projectId: string, options?: SessionOpenOptions) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  /** Branches this session into an independent one; absent when its provider cannot. */
  onForkSession?: (session: SessionWithProvider) => void;
  /** This project's list is in bulk-selection mode: the row acts as a checkbox and hides its options. */
  isSelecting: boolean;
  /** Ticked for the pending bulk delete. Resolved by the list, which never ticks a running row. */
  isChecked: boolean;
  /** Takes the owning projectId so this memoized row binds itself without the list making a closure per row. */
  onToggleSessionSelected: (projectId: string, sessionId: string) => void;
  /** Which pane(s) show this session, resolved by the list so a tab opening elsewhere leaves this row alone. */
  panePlacement?: SessionPanePlacement;
  /** Desktop, and the workspace is split or wide enough to split: side buttons, side menu items, Alt+click to the other side. */
  canTargetSides?: boolean;
  /** A right pane exists: the placement marker shows and both sides are offered. */
  isWorkspaceSplit?: boolean;
  t: TFunction;
};

/** Rendered by SidebarProjectSessions for one session row, including its rename, copy and delete controls. */
function SidebarSessionItem({
  project,
  session,
  isSelected,
  isProcessing,
  hasBackgroundWork,
  needsAttention,
  currentTime,
  isEditing,
  renameDraft,
  onRenameDraftChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onSessionSelect,
  onDeleteSession,
  onForkSession,
  isSelecting,
  isChecked,
  onToggleSessionSelected,
  panePlacement = null,
  canTargetSides = false,
  isWorkspaceSplit = false,
  t,
}: SidebarSessionItemProps) {
  const isCompact = useCompactSidebar();
  const sessionView = createSessionViewModel(session, currentTime, t);
  const compactSessionAge = formatCompactAge(sessionView.sessionTime, currentTime, t);
  const [isMobileOptionsOpen, setIsMobileOptionsOpen] = useState(false);
  const showAttentionIndicator = needsAttention && !isSelected;
  // Background work takes the recent-activity dot's place: the session is
  // still doing something, which says more than that it was touched lately.
  const showBackgroundIndicator = !showAttentionIndicator && hasBackgroundWork;
  const showRecentIndicator = !showAttentionIndicator && !showBackgroundIndicator && !isProcessing && sessionView.isActive;
  const indicatorLabel = showAttentionIndicator
    ? t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })
    : showBackgroundIndicator
      ? t('tooltips.backgroundWorkIndicator', { defaultValue: 'Background work running' })
      : t('tooltips.activeSessionIndicator');
  const providerLabel = PROVIDER_LABELS[session.__provider];

  // The desktop controls live in SessionOptions, which owns the rename panel and
  // its outside-click dismissal. The mobile rename sits inside the bottom sheet,
  // which owns its own.
  const { copyState, copyLabel, setOptionsOpen, handleCopyAction, isCopyPending, CopyStateIcon } =
    useProviderSessionIdCopy(session.id, providerLabel, t);

  // Sessions are owned by a project identified by `projectId` (DB primary key)
  // after the projectName → projectId migration. A tap previews the session in the
  // focused pane, and the open itself closes the drawer.
  const selectMobileSession = () => {
    onSessionSelect(session, project.projectId, { preview: true });
  };

  // Alt/Option+click and Alt/Option+Enter: a kept tab on the other side, splitting first.
  // Where no split is possible it is an ordinary kept open in the focused pane.
  const openOnOtherSide = () => {
    onSessionSelect(session, project.projectId, { target: canTargetSides ? 'other' : 'focused' });
  };

  const openInPane = (side: WorkspacePaneSide) => {
    onSessionSelect(session, project.projectId, { target: side });
  };

  // Alt+Enter is the keyboard Alt+click. Prevented so the link is not followed as well.
  const handleRowKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' || !event.altKey) {
      return;
    }
    event.preventDefault();
    openOnOtherSide();
  };

  // A drag carries the session for the workspace's drop targets and keeps the link
  // for everything else (another browser tab, the address bar). The ticked rows of
  // a bulk selection stay put.
  const handleDragStart = (event: DragEvent<HTMLAnchorElement>) => {
    if (isSelecting) {
      event.preventDefault();
      return;
    }
    writeSessionDragPayload(
      event.dataTransfer,
      { sessionId: session.id, projectId: project.projectId, provider: session.__provider, title: sessionView.sessionName },
      `/session/${session.id}`,
    );
  };

  const saveEditedSession = () => {
    onSaveEditingSession(project.projectId, session.id, renameDraft, session.__provider);
  };

  const requestDeleteSession = () => {
    onDeleteSession(session.id, sessionView.sessionTitle);
  };

  // A running session cannot be deleted, so it cannot be ticked either; the row
  // still renders, locked, instead of disappearing from the list mid-selection.
  const isSelectable = isSelecting && !isProcessing;
  const toggleSelected = () => {
    onToggleSessionSelected(project.projectId, session.id);
  };
  // Space activates neither the desktop anchor nor the compact div, and Enter
  // only the anchor, so both keys are handled here and tick either row alike.
  const handleSelectionKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!isSelectable || (event.key !== ' ' && event.key !== 'Enter')) {
      return;
    }
    event.preventDefault();
    toggleSelected();
  };
  const SelectionIcon = isChecked ? CheckSquare : Square;
  const selectionIcon = isSelecting ? (
    <SelectionIcon
      className={cn(
        'h-4 w-4 flex-shrink-0',
        isChecked ? 'text-primary' : 'text-muted-foreground',
        !isSelectable && 'opacity-40',
      )}
      aria-hidden="true"
    />
  ) : null;

  const setMobileOptionsOpen = (open: boolean) => {
    setIsMobileOptionsOpen(open);
    setOptionsOpen(open);
    if (!open && isEditing) {
      onCancelEditingSession();
    }
  };

  const startMobileRename = () => {
    onStartEditingSession(project.projectId, session.id, sessionView.sessionName);
  };

  const saveMobileRename = () => {
    saveEditedSession();
    setMobileOptionsOpen(false);
  };

  return (
    <div className="group relative">
      {(showAttentionIndicator || showBackgroundIndicator || showRecentIndicator) && (
        <div className="absolute start-0 top-1/2 -translate-x-1 -translate-y-1/2 transform rtl:translate-x-1">
          <Tooltip content={indicatorLabel} position="right">
            <div
              role="status"
              aria-label={indicatorLabel}
              className={cn(
                'h-2 w-2 animate-pulse rounded-full',
                showAttentionIndicator
                  ? 'bg-amber-500'
                  : showBackgroundIndicator
                    ? 'bg-purple-500 dark:bg-purple-400'
                    : 'bg-green-500',
              )}
            />
          </Tooltip>
        </div>
      )}

      {isCompact && (
      <div>
        <div
          role={isSelecting ? 'checkbox' : undefined}
          aria-checked={isSelecting ? isChecked : undefined}
          aria-disabled={isSelecting && !isSelectable ? true : undefined}
          tabIndex={isSelecting ? 0 : undefined}
          className={cn(
            'p-2 mx-3 my-0.5 rounded-md bg-card border active:scale-[0.98] transition-all duration-150 relative',
            isSelected ? 'bg-primary/5 border-primary/20' : '',
            !isSelected && isProcessing
              ? 'border-border/60 bg-muted/20'
              : !isSelected && sessionView.isActive
              ? 'border-green-500/30 bg-green-50/5 dark:bg-green-900/5'
              : 'border-border/30',
            isChecked && 'border-primary/40 bg-primary/10',
          )}
          onClick={isSelecting ? (isSelectable ? toggleSelected : undefined) : selectMobileSession}
          onKeyDown={isSelecting ? handleSelectionKeyDown : undefined}
        >
          <div className="flex items-center gap-2">
            {selectionIcon}
            <div
              className={cn(
                'w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0',
                isSelected ? 'bg-primary/10' : 'bg-muted/50',
              )}
            >
              <LLMProviderLogo provider={session.__provider} className="h-3 w-3" />
            </div>
            <PanePlacementMarker isWorkspaceSplit={isWorkspaceSplit} panePlacement={panePlacement} t={t} />

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div
                  className="bidi-auto min-w-0 flex-1 truncate text-sm font-normal text-foreground"
                  title={sessionView.sessionTitle}
                >
                  {sessionView.sessionTitle}
                </div>
                {isProcessing ? (
                  <span className="ms-auto flex-shrink-0">
                    <Tooltip content={t('tooltips.processingSessionIndicator', 'Processing session')} position="top">
                      <span className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                      </span>
                    </Tooltip>
                  </span>
                ) : compactSessionAge && (
                  <span className="ms-auto flex-shrink-0 text-[11px] text-muted-foreground">{compactSessionAge}</span>
                )}
              </div>
              <div className="mt-0.5 flex items-center">
                {sessionView.messageCount > 0 && (
                  <Badge variant="secondary" className="px-1 py-0 text-xs">
                    {sessionView.messageCount}
                  </Badge>
                )}
              </div>
            </div>

            {!isSelecting && (
              <button
                type="button"
                aria-label={t('sessionMenu.optionsFor', { name: sessionView.sessionTitle })}
                aria-haspopup="dialog"
                aria-expanded={isMobileOptionsOpen}
                className="ms-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted active:scale-95"
                onClick={(event) => {
                  event.stopPropagation();
                  setMobileOptionsOpen(true);
                }}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        <Dialog open={isMobileOptionsOpen} onOpenChange={setMobileOptionsOpen}>
          <DialogContent
            aria-describedby="mobile-session-options-description"
            animationClassName="animate-bottom-sheet-content-show motion-reduce:animate-none"
            className="bottom-0 left-0 top-auto max-w-none translate-x-0 translate-y-0 rounded-b-none rounded-t-2xl border-x-0 border-b-0 px-4 pb-safe-area-inset-bottom pt-3"
          >
            <DialogTitle>{t('sessionMenu.title')}</DialogTitle>
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-muted-foreground/30" aria-hidden="true" />

            <div className="mb-4 flex items-center gap-3 px-1">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-muted">
                <LLMProviderLogo provider={session.__provider} className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="bidi-auto truncate text-sm font-medium text-foreground" title={sessionView.sessionTitle}>
                  {sessionView.sessionTitle}
                </p>
                <p id="mobile-session-options-description" className="text-xs text-muted-foreground">
                  {t('sessionMenu.providerSession', { provider: providerLabel })}
                </p>
              </div>
            </div>

            {isEditing ? (
              <div className="mb-3 space-y-2">
                <label htmlFor={`mobile-session-rename-${session.id}`} className="block px-1 text-xs font-medium text-muted-foreground">
                  {t('sessionMenu.nameLabel')}
                </label>
                <input
                  id={`mobile-session-rename-${session.id}`}
                  type="text"
                  value={renameDraft}
                  onChange={(event) => onRenameDraftChange(event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                      saveMobileRename();
                    }
                  }}
                  className="w-full rounded-xl border-2 border-primary/40 bg-background px-3 py-3 text-foreground shadow-sm focus:border-primary focus:outline-none"
                  autoFocus
                  autoComplete="off"
                  // 16px keeps iOS Safari from zooming the viewport on focus.
                  style={{ fontSize: '16px' }}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={saveMobileRename}
                    className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition-transform active:scale-95"
                  >
                    <Check className="h-5 w-5 flex-shrink-0" />
                    {t('actions.save')}
                  </button>
                  <button
                    type="button"
                    onClick={onCancelEditingSession}
                    className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-muted/35 px-4 py-3 text-sm font-medium text-foreground transition-colors active:bg-muted"
                  >
                    <X className="h-5 w-5 flex-shrink-0" />
                    {t('actions.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={startMobileRename}
                  className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-muted/35 px-4 py-3 text-start text-foreground transition-colors active:bg-muted"
                >
                  <Edit2 className="h-5 w-5 flex-shrink-0" />
                  <span className="text-sm font-medium">{t('common:workspace.renameSession')}</span>
                </button>

                <button
                  type="button"
                  onClick={handleCopyAction}
                  disabled={isCopyPending}
                  className={cn(
                    'flex min-h-12 w-full items-center gap-3 rounded-xl border px-4 py-3 text-start transition-colors',
                    copyState === 'copied'
                      ? 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300'
                      : copyState === 'error'
                        ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
                        : 'border-border bg-muted/35 text-foreground active:bg-muted',
                  )}
                >
                  {isCopyPending ? (
                    <Loader2 className="h-5 w-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <CopyStateIcon className="h-5 w-5 flex-shrink-0" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{copyLabel}</span>
                    {copyState === 'error' && (
                      <span className="mt-0.5 block text-xs">{t('sessionMenu.retryTap')}</span>
                    )}
                  </span>
                </button>

                {!isProcessing && (
                  <button
                    type="button"
                    onClick={() => {
                      setMobileOptionsOpen(false);
                      requestDeleteSession();
                    }}
                    className="flex min-h-12 w-full items-center gap-3 rounded-xl px-4 py-3 text-start text-red-600 transition-colors active:bg-red-500/10 dark:text-red-400"
                  >
                    <Trash2 className="h-5 w-5 flex-shrink-0" />
                    <span className="text-sm font-medium">{t('sessionMenu.archiveOrDelete')}</span>
                  </button>
                )}
              </div>
            )}

            {!isEditing && (
              <button
                type="button"
                onClick={() => setMobileOptionsOpen(false)}
                className="mb-3 mt-2 min-h-11 w-full rounded-xl text-sm font-medium text-muted-foreground transition-colors active:bg-muted"
              >
                {t('actions.cancel')}
              </button>
            )}
          </DialogContent>
        </Dialog>
      </div>
      )}

      {!isCompact && (
      <div>
        <a
          href={`/session/${session.id}`}
          role={isSelecting ? 'checkbox' : undefined}
          aria-checked={isSelecting ? isChecked : undefined}
          aria-disabled={isSelecting && !isSelectable ? true : undefined}
          className={cn(
            buttonVariants({ variant: 'ghost' }),
            'h-auto w-full justify-start rounded-md border bg-card p-2 text-start font-normal transition-all duration-150',
            isSelecting ? 'pe-2' : 'pe-11',
            isSelected ? 'border-primary/20 bg-primary/5' : 'border-border/30',
            !isSelected && isProcessing
              ? 'border-border/60 bg-muted/20 hover:bg-muted/25'
              : !isSelected && sessionView.isActive
                ? 'border-green-500/30 bg-green-50/5 hover:bg-green-50/10 dark:bg-green-900/5 dark:hover:bg-green-900/10'
                : 'hover:bg-accent/50',
            isChecked && 'border-primary/40 bg-primary/10',
          )}
          // A click previews the session in the focused pane and a double-click keeps
          // it; Alt+click sends it to the other side. Ctrl/Cmd/Shift/middle-click and
          // the native right-click menu use the href to open a new tab/window.
          // While selecting, every click ticks the row instead.
          onClick={(event) => {
            if (isSelecting) {
              event.preventDefault();
              if (isSelectable) {
                toggleSelected();
              }
              return;
            }
            if (event.button !== 0) return;
            if (event.altKey) {
              // Ahead of the modifier pass-through, and prevented first so the browser
              // does not take Alt+click as "download this link".
              event.preventDefault();
              // The second click of a double-click would send it back across.
              if (event.detail > 1) return;
              openOnOtherSide();
              return;
            }
            if (event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            onSessionSelect(session, project.projectId, { preview: true });
          }}
          onDoubleClick={(event) => {
            if (isSelecting || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            onSessionSelect(session, project.projectId, { preview: false });
          }}
          onKeyDown={isSelecting ? handleSelectionKeyDown : handleRowKeyDown}
          draggable={isSelecting ? false : undefined}
          onDragStart={handleDragStart}
        >
          <div className="flex w-full min-w-0 items-center gap-2">
            {selectionIcon}
            <div
              className={cn(
                'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md',
                isSelected ? 'bg-primary/10' : 'bg-muted/50',
              )}
            >
              <LLMProviderLogo provider={session.__provider} className="h-3 w-3" />
            </div>
            <PanePlacementMarker isWorkspaceSplit={isWorkspaceSplit} panePlacement={panePlacement} t={t} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div
                  className="bidi-auto min-w-0 flex-1 truncate text-sm font-normal text-foreground"
                  title={sessionView.sessionTitle}
                >
                  {sessionView.sessionTitle}
                </div>
                {isProcessing ? (
                  <span
                    className={cn(
                      'ms-auto flex-shrink-0 transition-opacity duration-200',
                      isEditing ? 'opacity-0' : !isSelecting && 'group-hover:opacity-0',
                    )}
                  >
                    <Tooltip content={t('tooltips.processingSessionIndicator', 'Processing session')} position="top">
                      <span className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                      </span>
                    </Tooltip>
                  </span>
                ) : compactSessionAge && (
                  <span
                    className={cn(
                      'ms-auto flex-shrink-0 text-[11px] text-muted-foreground transition-opacity duration-200',
                      isEditing ? 'opacity-0' : !isSelecting && 'group-hover:opacity-0',
                    )}
                  >
                    {compactSessionAge}
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex items-center">
                {sessionView.messageCount > 0 && <Badge variant="secondary" className="px-1 py-0 text-xs">{sessionView.messageCount}</Badge>}
              </div>
            </div>
          </div>
        </a>

        {!isSelecting && (
          <SessionOptions
            className="absolute end-2 top-1/2 -translate-y-1/2 transform transition-all duration-200"
            sessionId={session.id}
            sessionName={sessionView.sessionName}
            provider={session.__provider}
            projectId={project.projectId}
            isProcessing={isProcessing}
            isEditing={isEditing}
            renameDraft={renameDraft}
            onRenameDraftChange={onRenameDraftChange}
            onStartEditingSession={onStartEditingSession}
            onCancelEditingSession={onCancelEditingSession}
            onSaveEditingSession={onSaveEditingSession}
            onDeleteSession={onDeleteSession}
            onFork={onForkSession ? () => onForkSession(session) : undefined}
            canTargetSides={canTargetSides}
            isWorkspaceSplit={isWorkspaceSplit}
            panePlacement={panePlacement}
            onOpenInPane={openInPane}
            t={t}
          />
        )}
      </div>
      )}
    </div>
  );
}

/**
 * Memoized: a websocket session delta re-renders the sidebar roughly every
 * 0.5-2s during a run, and a rename keystroke re-renders it per character.
 *
 * SidebarProjectSessions hands every row but the one being renamed a constant
 * draft, and the session objects come from a per-project cache, so the compare
 * succeeds for the rest. See sidebarRowProps.test.tsx.
 */
export default memo(SidebarSessionItem);
