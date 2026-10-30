import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, FolderSymlink, FolderX, Loader2, X } from 'lucide-react';

import { Button, Dialog, DialogContent, DialogTitle, FolderBrowserModal, Input } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { ProjectMount } from '@/shared/types';
import type { UseProjectMountsResult } from '@/modules/file-tree/hooks/useProjectMounts';
import { describeMountStatus } from '@/modules/file-tree/utils/fileTreeUtils';

// The characters a file name may not hold anywhere; the server checks the name again.
const INVALID_NAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/;
const INVALID_NAME_CHARS_GLOBAL = /[<>:"/\\|?*\x00-\x1f]/g;

const isAbsolutePath = (value: string) => value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value);

// A mount named after the folder it links to, for a name the user has not typed yet.
const suggestMountName = (folderPath: string) => {
  const baseName = folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const name = baseName.replace(INVALID_NAME_CHARS_GLOBAL, '-').trim();
  return /^\.*$/.test(name) ? '' : name;
};

type MountFolderDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  mounts: UseProjectMountsResult;
};

/** Opened by FileTree (header button and the empty-area menu) to mount a folder into the project and manage the mounts it has. */
export default function MountFolderDialog({ isOpen, onClose, mounts }: MountFolderDialogProps) {
  const { t } = useTranslation();
  // The form's two fields, as typed or as the folder browser filled them.
  const [name, setName] = useState('');
  const [targetPath, setTargetPath] = useState('');
  // Whether the name is the user's own; until then, picking a folder names the mount after it.
  const [nameEdited, setNameEdited] = useState(false);
  // Why the form was not sent, or the server's refusal; shown under the form until the next try.
  const [formError, setFormError] = useState<string | null>(null);
  // A mount request is out: the form waits for its answer instead of sending it twice.
  const [submitting, setSubmitting] = useState(false);
  // The folder browser takes the dialog's place while it is open, so the two never fight over focus and Escape.
  const [browsing, setBrowsing] = useState(false);
  // The row whose Unmount asks for confirmation instead of its usual buttons.
  const [confirmUnmountId, setConfirmUnmountId] = useState<string | null>(null);

  // Read through a ref, so a language switch while the dialog is open does not list the mounts again.
  const loadMountsRef = useRef(mounts.loadMounts);
  useEffect(() => {
    loadMountsRef.current = mounts.loadMounts;
  }, [mounts.loadMounts]);

  // Each opening lists the mounts afresh: a terminal or Claude may have changed mounts/ since.
  useEffect(() => {
    if (isOpen) {
      void loadMountsRef.current();
    }
  }, [isOpen]);

  // Every way out (the close button, Escape, a click outside) leaves the next opening a blank form.
  const closeDialog = () => {
    setName('');
    setNameEdited(false);
    setTargetPath('');
    setFormError(null);
    setConfirmUnmountId(null);
    setBrowsing(false);
    mounts.clearNotice();
    onClose();
  };

  const validate = (): string | null => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return t('fileTree.mounts.validation.nameRequired');
    }
    if (INVALID_NAME_CHARS.test(trimmedName) || /^\.+$/.test(trimmedName)) {
      return t('fileTree.mounts.validation.nameInvalid');
    }
    const trimmedTarget = targetPath.trim();
    if (!trimmedTarget) {
      return t('fileTree.mounts.validation.targetRequired');
    }
    if (!isAbsolutePath(trimmedTarget)) {
      return t('fileTree.mounts.validation.targetAbsolute');
    }
    return null;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) {
      return;
    }
    mounts.clearNotice();
    const validationError = validate();
    if (validationError) {
      setFormError(validationError);
      return;
    }
    setSubmitting(true);
    setFormError(null);
    // No message either when the dialog was closed while the request was out: the hook then says
    // what came of it in a toast or this dialog's notice, never under a form opened since.
    const error = await mounts.createMount(name.trim(), targetPath.trim());
    setSubmitting(false);
    if (error) {
      setFormError(error);
      return;
    }
    setName('');
    setNameEdited(false);
    setTargetPath('');
  };

  const handleFolderPicked = (folderPath: string) => {
    setTargetPath(folderPath);
    if (!nameEdited) {
      setName(suggestMountName(folderPath));
    }
    setFormError(null);
    setBrowsing(false);
  };

  const renderMountRow = (mount: ProjectMount) => {
    const isBusy = mounts.isBusy(mount.mountId);
    const isHealthy = mount.status === 'ok';
    const canOpen = isHealthy || mount.status === 'not-ignored';
    const StatusIcon = canOpen ? FolderSymlink : FolderX;

    return (
      <li key={mount.mountId} className="flex items-start gap-3 rounded-md border border-border px-3 py-2" data-mount-row={mount.name}>
        <StatusIcon className={cn('mt-0.5 h-4 w-4 flex-shrink-0', canOpen ? 'text-sky-500' : 'text-red-500')} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2">
            <span className="truncate text-sm font-medium text-foreground">{mount.name}</span>
            <span className={cn('text-xs', isHealthy ? 'text-muted-foreground' : canOpen ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400')}>
              {describeMountStatus(mount.status, t)}
            </span>
          </div>
          <div className="bidi-ltr truncate font-mono text-xs text-muted-foreground" title={mount.targetPath}>
            {mount.targetPath}
          </div>
          {confirmUnmountId === mount.mountId && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('fileTree.mounts.unmountConfirm', { name: mount.name, target: mount.targetPath })}
            </p>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          {isBusy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />}
          {confirmUnmountId === mount.mountId ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                className="h-7 px-2 text-xs"
                disabled={isBusy}
                onClick={() => {
                  setConfirmUnmountId(null);
                  void mounts.unmount(mount);
                }}
              >
                {t('fileTree.mounts.unmount')}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setConfirmUnmountId(null)}>
                {t('common:cancel')}
              </Button>
            </>
          ) : (
            <>
              {!isHealthy && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  disabled={isBusy}
                  onClick={() => void mounts.repairMount(mount)}
                >
                  {t('fileTree.mounts.repair')}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-red-600 hover:text-red-700 dark:text-red-400"
                disabled={isBusy}
                onClick={() => setConfirmUnmountId(mount.mountId)}
              >
                {t('fileTree.mounts.unmount')}
              </Button>
            </>
          )}
        </div>
      </li>
    );
  };

  return (
    <>
      <Dialog open={isOpen && !browsing} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent
          wrapperClassName="z-[10000]"
          className="flex max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-lg flex-col overflow-hidden p-0"
        >
          <DialogTitle>{t('fileTree.mounts.title')}</DialogTitle>
          <div className="flex items-start gap-3 border-b border-border px-4 py-3">
            <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-muted">
              <FolderSymlink className="h-4 w-4 text-sky-500" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-base font-medium text-foreground">{t('fileTree.mounts.title')}</div>
              <p className="mt-1 text-sm text-muted-foreground">{t('fileTree.mounts.description')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('fileTree.mounts.providers')}</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
              aria-label={t('fileTree.mounts.close')}
              onClick={closeDialog}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
            <form className="space-y-3" onSubmit={handleSubmit} noValidate>
              <div className="space-y-1">
                <label htmlFor="mount-folder-target" className="text-sm font-medium text-foreground">
                  {t('fileTree.mounts.targetLabel')}
                </label>
                <div className="flex gap-2">
                  <Input
                    id="mount-folder-target"
                    type="text"
                    value={targetPath}
                    onChange={(event) => {
                      setTargetPath(event.target.value);
                      setFormError(null);
                    }}
                    placeholder="/mnt/data"
                    className="bidi-ltr flex-1 font-mono text-sm"
                    disabled={submitting}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="px-3"
                    onClick={() => setBrowsing(true)}
                    title={t('misc.browseFolders')}
                    aria-label={t('misc.browseFolders')}
                    disabled={submitting}
                  >
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="space-y-1">
                <label htmlFor="mount-folder-name" className="text-sm font-medium text-foreground">
                  {t('fileTree.mounts.nameLabel')}
                </label>
                <Input
                  id="mount-folder-name"
                  type="text"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setNameEdited(true);
                    setFormError(null);
                  }}
                  className="text-sm"
                  disabled={submitting}
                />
                <p className="text-xs text-muted-foreground">
                  {t('fileTree.mounts.nameHint', { name: name.trim() || t('fileTree.mounts.namePlaceholder') })}
                </p>
              </div>

              {formError && (
                <p role="alert" className="text-sm text-red-600 dark:text-red-400">{formError}</p>
              )}

              <div className="flex justify-end">
                <Button type="submit" size="sm" disabled={submitting}>
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t('fileTree.mounts.submit')}
                </Button>
              </div>
            </form>

            <section aria-label={t('fileTree.mounts.listTitle')} className="space-y-2">
              <h4 className="text-sm font-medium text-foreground">{t('fileTree.mounts.listTitle')}</h4>
              {mounts.loading && mounts.mounts.length === 0 ? (
                <div className="flex justify-center py-3">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : mounts.loadError ? (
                <p className="text-sm text-red-600 dark:text-red-400">{mounts.loadError}</p>
              ) : mounts.mounts.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('fileTree.mounts.empty')}</p>
              ) : (
                <ul className="space-y-2">{mounts.mounts.map(renderMountRow)}</ul>
              )}
            </section>

            {mounts.adoptable.length > 0 && (
              <section aria-label={t('fileTree.mounts.adoptableTitle')} className="space-y-2">
                <h4 className="text-sm font-medium text-foreground">{t('fileTree.mounts.adoptableTitle')}</h4>
                <p className="text-xs text-muted-foreground">{t('fileTree.mounts.adoptableHint')}</p>
                <ul className="space-y-2">
                  {mounts.adoptable.map((link) => {
                    const isBusy = mounts.isBusy(`adopt:${link.name}`);
                    return (
                      <li key={link.name} className="flex items-center gap-3 rounded-md border border-dashed border-border px-3 py-2">
                        <FolderSymlink className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground">{link.name}</div>
                          <div className="bidi-ltr truncate font-mono text-xs text-muted-foreground" title={link.targetPath}>
                            {link.targetPath}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          disabled={isBusy}
                          onClick={() => void mounts.adoptMount(link.name)}
                        >
                          {isBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                          {t('fileTree.mounts.adopt')}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </div>

          {/* What Mount, Repair, Unmount or Register came to: kept below the scrolling lists, so it
              shows whichever row was acted on, and in the dialog, whose overlay hides the tree's toasts. */}
          {mounts.notice && (
            <div className="border-t border-border px-4 py-2">
              <p
                role={mounts.notice.type === 'error' ? 'alert' : 'status'}
                className={cn('text-sm', mounts.notice.type === 'error' ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400')}
              >
                {mounts.notice.text}
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <FolderBrowserModal
        isOpen={isOpen && browsing}
        onClose={() => setBrowsing(false)}
        onFolderSelected={handleFolderPicked}
        browse={mounts.browseFolders}
        initialPath={isAbsolutePath(targetPath.trim()) ? targetPath.trim() : null}
        className="z-[10000]"
      />
    </>
  );
}
