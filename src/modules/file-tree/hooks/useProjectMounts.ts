import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import type { AdoptableProjectMount, FolderBrowseResult, FolderSuggestion, ProjectMount } from '@/shared/types';

// The server's refusals of a mount request, said in the user's language; any other failure shows the server's own message.
const MOUNT_ERROR_KEYS: Record<string, string> = {
  INVALID_MOUNT_NAME: 'fileTree.mounts.errors.invalidName',
  MOUNT_NAME_TAKEN: 'fileTree.mounts.errors.nameTaken',
  // A row acted on after its mount (or, for Register, its link) was removed elsewhere.
  MOUNT_NOT_FOUND: 'fileTree.mounts.errors.alreadyRemoved',
  // Also sent for a folder that does not answer in time (an offline network share): the copy covers both.
  MOUNT_TARGET_NOT_FOUND: 'fileTree.mounts.errors.targetNotFound',
  MOUNT_TARGET_NOT_DIRECTORY: 'fileTree.mounts.errors.targetNotDirectory',
  MOUNT_TARGET_FORBIDDEN: 'fileTree.mounts.errors.targetForbidden',
  MOUNT_TARGET_LOOP: 'fileTree.mounts.errors.targetLoop',
  MOUNTS_DIR_IN_USE: 'fileTree.mounts.errors.mountsDirInUse',
  MOUNTS_DIR_TRACKED: 'fileTree.mounts.errors.mountsDirTracked',
  MOUNT_LINK_FAILED: 'fileTree.mounts.errors.linkFailed',
};

// Where one operation means something else by a code: Repair is refused MOUNT_NAME_TAKEN when a
// real file or folder now sits at the link's place, Unmount gets MOUNT_LINK_FAILED when the link
// cannot be removed, and the folder browser gets MOUNT_TARGET_NOT_FOUND for a folder it cannot read too.
const REPAIR_ERROR_KEYS: Record<string, string> = {
  MOUNT_NAME_TAKEN: 'fileTree.mounts.errors.repairSpotTaken',
};
const UNMOUNT_ERROR_KEYS: Record<string, string> = {
  MOUNT_LINK_FAILED: 'fileTree.mounts.errors.unlinkFailed',
};
const BROWSE_ERROR_KEYS: Record<string, string> = {
  MOUNT_TARGET_NOT_FOUND: 'fileTree.mounts.errors.browseUnavailable',
};

/** How one operation words the server's refusals: its own keys over the shared ones, and the mount's name. */
type MountErrorWording = { keys?: Record<string, string>; name?: string };

/** The last listing asked for, tagged with its project so another project's list is never shown. */
type MountsListing = {
  projectId: string;
  mounts: ProjectMount[];
  adoptable: AdoptableProjectMount[];
  loading: boolean;
  error: string | null;
};

// Create is refused MOUNT_NAME_TAKEN for a registered name, and also for anything else already at
// mounts/<name>: a link not registered yet, or a file or folder that is no mount. The listing tells
// which; while it is not there, the shared wording stays.
const createErrorKeys = (name: string, listing: MountsListing | null): Record<string, string> | undefined => {
  if (!listing || listing.loading || listing.error || listing.mounts.some((mount) => mount.name === name)) {
    return undefined;
  }
  return {
    MOUNT_NAME_TAKEN: listing.adoptable.some((link) => link.name === name)
      ? 'fileTree.mounts.errors.spotTakenByLink'
      : 'fileTree.mounts.errors.spotTaken',
  };
};

// Read off the error readApiJson throws (an ApiRequestError carrying the server's code, and for
// MOUNT_LINK_FAILED the system's reason in `details`).
const describeMountError = (error: unknown, t: TFunction, wording: MountErrorWording = {}): string => {
  const { code, details } = (error ?? {}) as { code?: unknown; details?: unknown };
  const key = typeof code === 'string' ? wording.keys?.[code] ?? MOUNT_ERROR_KEYS[code] : undefined;
  const message = error instanceof Error && error.message ? error.message : null;
  if (key) {
    const reason = typeof details === 'string' && details.trim() ? details : message ?? '';
    return t(key, { name: wording.name ?? '', reason });
  }
  return message ?? t('fileTree.mounts.errors.generic');
};

/** The mount a row or a tree node acts on, with its status as last listed. */
type MountRef = Pick<ProjectMount, 'mountId' | 'name' | 'status'>;

/** What an action came to, said in the mount dialog while it is open. */
export type MountsNotice = { text: string; type: 'success' | 'error' };

// Returned while nothing is listed for the project, so a render without a listing gets the same arrays.
const NO_MOUNTS: ProjectMount[] = [];
const NO_ADOPTABLE: AdoptableProjectMount[] = [];

type UseProjectMountsOptions = {
  projectId: string | null;
  // Whether the mount dialog is open: its modal overlay covers the tree's toasts, so what an action
  // came to is said in the dialog instead while it is open.
  dialogOpen: boolean;
  // Runs after anything that changes mounts/, so the tree lists the change.
  onChanged: () => void;
  showToast: (message: string, type: 'success' | 'error') => void;
};

export type UseProjectMountsResult = {
  mounts: ProjectMount[];
  adoptable: AdoptableProjectMount[];
  loading: boolean;
  loadError: string | null;
  // Whether an action is running for a row: a mount's id, or `adopt:<name>` for a link being adopted.
  isBusy: (key: string) => boolean;
  // What the last action came to, for the dialog; the next action or closing the dialog clears it.
  notice: MountsNotice | null;
  clearNotice: () => void;
  loadMounts: () => Promise<void>;
  // Resolves to the message to show under the form, or null when there is none for it: the folder
  // is mounted, or the dialog was closed meanwhile and the refusal was said like any other outcome.
  createMount: (name: string, targetPath: string) => Promise<string | null>;
  adoptMount: (name: string) => Promise<void>;
  unmount: (mount: MountRef) => Promise<void>;
  repairMount: (mount: MountRef) => Promise<void>;
  // Lists folders a mount may point at, for the folder browser.
  browseFolders: (folderPath: string | null) => Promise<FolderBrowseResult>;
};

/**
 * The project's mounts and what can be done to them, for the mount dialog and the tree's own
 * Unmount and Repair actions. Nothing is fetched until the dialog asks or the tree shows a
 * mounts/ folder, so a project without mounts that never opens the dialog costs no request.
 */
export function useProjectMounts({ projectId, dialogOpen, onChanged, showToast }: UseProjectMountsOptions): UseProjectMountsResult {
  const { t } = useTranslation();
  // The registered mounts and the unregistered links as the last listing returned them, or its failure.
  const [listing, setListing] = useState<MountsListing | null>(null);
  // The rows actions are running for, one entry per action: a row's buttons wait while its action
  // runs, the other rows stay usable, and each action frees only its own entry when it ends.
  const [busyKeys, setBusyKeys] = useState<readonly string[]>([]);
  // What the last action came to while the dialog was open, tagged with its project like the listing.
  const [notice, setNotice] = useState<(MountsNotice & { projectId: string }) | null>(null);
  // Counts listings, so an answer to an earlier request never replaces a later one.
  const loadGenerationRef = useRef(0);
  const currentListing = listing?.projectId === projectId ? listing : null;

  // Read when an answer arrives, not when the action started: an action begun in the tree reports in
  // the dialog if the dialog opened meanwhile, and one begun in the dialog in a toast if it closed.
  const dialogOpenRef = useRef(dialogOpen);
  // Counts the dialog's closings, so a mount request knows whether the form it was sent from is gone.
  const dialogClosingsRef = useRef(0);
  useEffect(() => {
    if (dialogOpenRef.current && !dialogOpen) {
      dialogClosingsRef.current += 1;
    }
    dialogOpenRef.current = dialogOpen;
  }, [dialogOpen]);

  const report = useCallback((text: string, type: MountsNotice['type']) => {
    if (dialogOpenRef.current && projectId) {
      setNotice({ projectId, text, type });
    } else {
      showToast(text, type);
    }
  }, [projectId, showToast]);

  const clearNotice = useCallback(() => setNotice(null), []);

  const loadMounts = useCallback(async () => {
    if (!projectId) {
      return;
    }
    const generation = ++loadGenerationRef.current;
    // The rows already shown for this project stay up while they are listed again.
    setListing((previous) => ({
      projectId,
      mounts: previous?.projectId === projectId ? previous.mounts : [],
      adoptable: previous?.projectId === projectId ? previous.adoptable : [],
      loading: true,
      error: null,
    }));
    try {
      const { data } = await readApiJson<{ data: { mounts?: ProjectMount[]; adoptable?: AdoptableProjectMount[] } }>(
        await api.mounts.list(projectId),
      );
      if (generation === loadGenerationRef.current) {
        setListing({ projectId, mounts: data.mounts ?? [], adoptable: data.adoptable ?? [], loading: false, error: null });
      }
    } catch (error) {
      if (generation === loadGenerationRef.current) {
        setListing({ projectId, mounts: [], adoptable: [], loading: false, error: describeMountError(error, t) });
      }
    }
  }, [projectId, t]);

  const createMount = useCallback(async (name: string, targetPath: string) => {
    if (!projectId) {
      return t('fileTree.mounts.errors.generic');
    }
    setNotice(null);
    const closingsAtStart = dialogClosingsRef.current;
    try {
      await readApiJson(await api.mounts.create(projectId, { name, targetPath }));
    } catch (error) {
      const message = describeMountError(error, t, { keys: createErrorKeys(name, currentListing), name });
      if (dialogClosingsRef.current === closingsAtStart) {
        return message;
      }
      // The dialog was closed while the server checked the folder, so the form it was sent from is
      // gone: said in a toast, or in the dialog's notice if it was opened again.
      report(message, 'error');
      return null;
    }
    report(t('fileTree.mounts.toast.mounted', { name }), 'success');
    onChanged();
    void loadMounts();
    return null;
  }, [currentListing, loadMounts, onChanged, projectId, report, t]);

  // Runs one row action, then lists again and refreshes the tree whatever the outcome: a failed
  // repair still says why in the row's new status.
  const runRowAction = useCallback(async (key: string, action: () => Promise<string>, wording?: MountErrorWording) => {
    setBusyKeys((keys) => [...keys, key]);
    setNotice(null);
    try {
      report(await action(), 'success');
    } catch (error) {
      report(describeMountError(error, t, wording), 'error');
    } finally {
      setBusyKeys((keys) => {
        const index = keys.indexOf(key);
        return index === -1 ? keys : [...keys.slice(0, index), ...keys.slice(index + 1)];
      });
      onChanged();
      void loadMounts();
    }
  }, [loadMounts, onChanged, report, t]);

  const isBusy = useCallback((key: string) => busyKeys.includes(key), [busyKeys]);

  const adoptMount = useCallback(async (name: string) => {
    if (!projectId) {
      return;
    }
    await runRowAction(`adopt:${name}`, async () => {
      await readApiJson(await api.mounts.adopt(projectId, name));
      return t('fileTree.mounts.toast.adopted', { name });
    }, { name });
  }, [projectId, runRowAction, t]);

  const unmount = useCallback(async ({ mountId, name, status }: MountRef) => {
    if (!projectId) {
      return;
    }
    await runRowAction(mountId, async () => {
      const { data } = await readApiJson<{ data: { linkRemoved?: boolean } }>(await api.mounts.remove(projectId, mountId));
      // linkRemoved is false both when nothing was at mounts/<name> and when something other than
      // this app's link was. A mount listed with its link missing had nothing there: a plain unmount.
      return data.linkRemoved === false && status !== 'missing-link'
        ? t('fileTree.mounts.toast.unmountedRowOnly', { name })
        : t('fileTree.mounts.toast.unmounted', { name });
    }, { keys: UNMOUNT_ERROR_KEYS, name });
  }, [projectId, runRowAction, t]);

  const repairMount = useCallback(async ({ mountId, name }: MountRef) => {
    if (!projectId) {
      return;
    }
    await runRowAction(mountId, async () => {
      await readApiJson(await api.mounts.repair(projectId, mountId));
      return t('fileTree.mounts.toast.repaired', { name });
    }, { keys: REPAIR_ERROR_KEYS, name });
  }, [projectId, runRowAction, t]);

  const browseFolders = useCallback(async (folderPath: string | null): Promise<FolderBrowseResult> => {
    try {
      const { data } = await readApiJson<{ data: { path: string; parent: string | null; directories?: FolderSuggestion[] } }>(
        await api.mounts.browse(folderPath),
      );
      return { path: data.path, parent: data.parent, folders: data.directories ?? [] };
    } catch (error) {
      throw new Error(describeMountError(error, t, { keys: BROWSE_ERROR_KEYS }));
    }
  }, [t]);

  return {
    mounts: currentListing?.mounts ?? NO_MOUNTS,
    adoptable: currentListing?.adoptable ?? NO_ADOPTABLE,
    loading: currentListing?.loading ?? false,
    loadError: currentListing?.error ?? null,
    isBusy,
    notice: notice?.projectId === projectId ? notice : null,
    clearNotice,
    loadMounts,
    createMount,
    adoptMount,
    unmount,
    repairMount,
    browseFolders,
  };
}
