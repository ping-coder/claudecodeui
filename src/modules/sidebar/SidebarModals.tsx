import { useEffect, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom';
import { AlertTriangle, EyeOff, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';
import { Trans } from 'react-i18next';

import { Button } from '@/shared/ui';
import { Settings } from '@/modules/settings';
import { VersionUpgradeModal } from '@/modules/version-upgrade';
import type { InstallMode, PendingSidebarDeletion, Project, ReleaseInfo, SettingsProject } from '@/shared/types';
import { formatSessionTitle, normalizeProjectForSettings } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import { splitTranslationAtValue } from '@/modules/sidebar/utils/translationSlots';
import { ProjectCreationWizard } from '@/modules/project-creation-wizard';

type SidebarModalsProps = {
  projects: Project[];
  showSettings: boolean;
  settingsInitialTab: string;
  onCloseSettings: () => void;
  showNewProject: boolean;
  onCloseNewProject: () => void;
  /** Gets the project the wizard created, so the sidebar can open it. */
  onProjectCreated: (project?: Record<string, unknown>) => void;
  pendingDeletion: PendingSidebarDeletion | null;
  onCancelDeletion: () => void;
  onConfirmDeleteProject: (deleteData?: boolean) => void;
  onConfirmDeleteSession: (hardDelete?: boolean) => void;
  /** Archives or permanently deletes every session of the pending bulk selection. */
  onConfirmDeleteSessions: (hardDelete?: boolean) => void;
  showVersionModal: boolean;
  onCloseVersionModal: () => void;
  releaseInfo: ReleaseInfo | null;
  currentVersion: string;
  latestVersion: string | null;
  installMode: InstallMode;
  t: TFunction;
};

/**
 * "What would you like to do with <name>?", the name in bold. The translation places the name and
 * carries the question mark; the name is rendered here (splitTranslationAtValue), as it is user text.
 */
function DeleteQuestion({ name, t }: { name: string; t: TFunction }) {
  const [before, after] = splitTranslationAtValue(t, 'deleteConfirmation.confirmDeleteNamed', 'name');
  return (
    <>
      {before}
      <span className="font-medium text-foreground">{name}</span>
      {after}
    </>
  );
}

type TypedSettingsProps = {
  isOpen: boolean;
  onClose: () => void;
  projects: SettingsProject[];
  initialTab: string;
};

const SettingsComponent = Settings as (props: TypedSettingsProps) => JSX.Element;

function TypedSettings(props: TypedSettingsProps) {
  return <SettingsComponent {...props} />;
}

/** Rendered by Sidebar to host its settings, new-project, delete-confirmation and version modals in one place. */
export default function SidebarModals({
  projects,
  showSettings,
  settingsInitialTab,
  onCloseSettings,
  showNewProject,
  onCloseNewProject,
  onProjectCreated,
  pendingDeletion,
  onCancelDeletion,
  onConfirmDeleteProject,
  onConfirmDeleteSession,
  onConfirmDeleteSessions,
  showVersionModal,
  onCloseVersionModal,
  releaseInfo,
  currentVersion,
  latestVersion,
  installMode,
  t,
}: SidebarModalsProps) {
  // Settings expects project identity/path fields to be present for dropdown labels and local-scope MCP config.
  const settingsProjects = useMemo(
    () => projects.map(normalizeProjectForSettings),
    [projects],
  );

  // Read by the Escape listener, which stays put while the parent hands over a new callback each render.
  const cancelDeletionRef = useRef(onCancelDeletion);
  useEffect(() => {
    cancelDeletionRef.current = onCancelDeletion;
  }, [onCancelDeletion]);

  // Escape cancels a delete confirmation, as it closes the app's other modals. Window capture, so
  // the chat's abort never hears it; the confirmations carry the Escape-layer marker, which is what
  // makes the code editor, the workspace shortcuts and the immersive sidebar drawer behind them
  // leave the key alone.
  const isDeletionPending = pendingDeletion !== null;
  useEffect(() => {
    if (!isDeletionPending) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      cancelDeletionRef.current();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isDeletionPending]);

  return (
    <>
      {showNewProject &&
        ReactDOM.createPortal(
          <ProjectCreationWizard
            onClose={onCloseNewProject}
            onProjectCreated={onProjectCreated}
          />,
          document.body,
        )}

      {showSettings &&
        ReactDOM.createPortal(
          <TypedSettings
            isOpen={showSettings}
            onClose={onCloseSettings}
            projects={settingsProjects}
            initialTab={settingsInitialTab}
          />,
          document.body,
        )}

      {pendingDeletion?.kind === 'project' &&
        ReactDOM.createPortal(
          <div data-escape-layer className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
            <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
              <div className="p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-orange-100 dark:bg-orange-900/30">
                    <AlertTriangle className="h-6 w-6 text-orange-600 dark:text-orange-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="mb-2 text-lg font-semibold text-foreground">
                      {t('deleteConfirmation.deleteProject')}
                    </h3>
                    <p className="mb-1 text-sm text-muted-foreground">
                      <DeleteQuestion
                        name={pendingDeletion.project.displayName || pendingDeletion.project.projectId}
                        t={t}
                      />
                    </p>
                    {pendingDeletion.sessionCount > 0 && (
                      <p className="mt-2 text-sm text-muted-foreground">
                        {t('deleteConfirmation.sessionCount', { count: pendingDeletion.sessionCount })}
                      </p>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-2 border-t border-border bg-muted/30 p-4">
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => onConfirmDeleteProject(false)}
                >
                  <EyeOff className="me-2 h-4 w-4" />
                  {t('deleteConfirmation.archiveProject', 'Archive project')}
                </Button>
                <Button
                  variant="destructive"
                  className="w-full justify-start bg-red-600 text-white hover:bg-red-700"
                  onClick={() => onConfirmDeleteProject(true)}
                >
                  <Trash2 className="me-2 h-4 w-4" />
                  {t('deleteConfirmation.deleteAllData')}
                </Button>
                <Button variant="ghost" className="w-full" onClick={onCancelDeletion}>
                  {t('actions.cancel')}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {pendingDeletion?.kind === 'session' &&
        ReactDOM.createPortal(
          <div data-escape-layer className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
            <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
              <div className="p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
                    <AlertTriangle className="h-6 w-6 text-red-600 dark:text-red-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="mb-2 text-lg font-semibold text-foreground">
                      {t('deleteConfirmation.deleteSession')}
                    </h3>
                    <p className="mb-1 text-sm text-muted-foreground">
                      {/* The archive hands over the title as stored; the rows already formatted theirs. */}
                      <DeleteQuestion name={formatSessionTitle(pendingDeletion.sessionTitle, t) || t('sessions.unnamed')} t={t} />
                    </p>
                    <p className="mt-3 text-xs text-muted-foreground">
                      {pendingDeletion.isArchived
                        ? t('deleteConfirmation.archivedSessionNotice', 'This session is already archived. You can keep it hidden or delete it permanently.')
                        : t('deleteConfirmation.archiveSessionNotice', 'Archive keeps the session out of the active list while preserving its history.')}
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-2 border-t border-border bg-muted/30 p-4">
                {!pendingDeletion.isArchived && (
                  <Button
                    variant="outline"
                    className="w-full justify-start"
                    onClick={() => onConfirmDeleteSession(false)}
                  >
                    <EyeOff className="me-2 h-4 w-4" />
                    {t('deleteConfirmation.archiveSession', 'Archive session')}
                  </Button>
                )}
                <Button
                  variant="destructive"
                  className="w-full justify-start bg-red-600 text-white hover:bg-red-700"
                  onClick={() => onConfirmDeleteSession(true)}
                >
                  <Trash2 className="me-2 h-4 w-4" />
                  {t('deleteConfirmation.deleteSessionPermanently', 'Delete permanently')}
                </Button>
                <Button variant="ghost" className="w-full" onClick={onCancelDeletion}>
                  {t('actions.cancel')}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {pendingDeletion?.kind === 'sessions' &&
        ReactDOM.createPortal(
          <div data-escape-layer className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
            <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
              <div className="p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
                    <AlertTriangle className="h-6 w-6 text-red-600 dark:text-red-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="mb-2 text-lg font-semibold text-foreground">
                      {t('deleteConfirmation.deleteSessions', { count: pendingDeletion.sessionIds.length })}
                    </h3>
                    <p className="mb-1 text-sm text-muted-foreground">
                      <Trans
                        t={t}
                        i18nKey="deleteConfirmation.confirmDeleteSelected"
                        count={pendingDeletion.sessionIds.length}
                        values={{ count: pendingDeletion.sessionIds.length }}
                        components={{ strong: <span className="font-medium text-foreground" /> }}
                      />
                    </p>
                    <p className="mt-3 text-xs text-muted-foreground">
                      {t('deleteConfirmation.archiveSessionsNotice', { count: pendingDeletion.sessionIds.length })}
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-2 border-t border-border bg-muted/30 p-4">
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => onConfirmDeleteSessions(false)}
                >
                  <EyeOff className="me-2 h-4 w-4" />
                  {t('deleteConfirmation.archiveSessions', { count: pendingDeletion.sessionIds.length })}
                </Button>
                <Button
                  variant="destructive"
                  className="w-full justify-start bg-red-600 text-white hover:bg-red-700"
                  onClick={() => onConfirmDeleteSessions(true)}
                >
                  <Trash2 className="me-2 h-4 w-4" />
                  {t('deleteConfirmation.deleteSessionPermanently', 'Delete permanently')}
                </Button>
                <Button variant="ghost" className="w-full" onClick={onCancelDeletion}>
                  {t('actions.cancel')}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      <VersionUpgradeModal
        isOpen={showVersionModal}
        onClose={onCloseVersionModal}
        releaseInfo={releaseInfo}
        currentVersion={currentVersion}
        latestVersion={latestVersion}
        installMode={installMode}
      />
    </>
  );
}
