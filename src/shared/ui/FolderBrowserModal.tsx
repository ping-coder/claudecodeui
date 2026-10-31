import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, FolderOpen, FolderPlus, Loader2, Plus, X } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { Input } from '@/shared/ui/Input';
import { cn } from '@/shared/utils';
import type { FolderBrowseResult, FolderSuggestion } from '@/shared/types';

const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:\\?$/;

// The folder above `currentPath`, or null at a root; handles Unix and Windows paths. Used when the
// browse endpoint does not say what the parent is.
const getParentPath = (currentPath: string): string | null => {
  if (currentPath === '~' || currentPath === '/' || WINDOWS_DRIVE_PATTERN.test(currentPath)) {
    return null;
  }

  const lastSeparatorIndex = Math.max(currentPath.lastIndexOf('/'), currentPath.lastIndexOf('\\'));
  if (lastSeparatorIndex <= 0) {
    return '/';
  }

  if (lastSeparatorIndex === 2 && /^[A-Za-z]:/.test(currentPath)) {
    return `${currentPath.slice(0, 2)}\\`;
  }

  return currentPath.slice(0, lastSeparatorIndex);
};

type FolderBrowserModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onFolderSelected: (folderPath: string, advanceToConfirm: boolean) => void;
  // Passed back with the picked folder, for a caller that moves on once a folder is chosen.
  autoAdvanceOnSelect?: boolean;
  // Lists one folder; null asks the endpoint for its default folder. `signal` aborts when the user
  // opens another folder first, or closes the modal, before the listing came back.
  browse: (folderPath: string | null, options: { signal: AbortSignal }) => Promise<FolderBrowseResult>;
  // Creates `name` in `parentPath` and resolves to the new folder's path. Without it the modal
  // offers no way to create a folder.
  createFolder?: (parentPath: string, name: string) => Promise<string>;
  // Where browsing starts each time the modal opens.
  initialPath?: string | null;
  // Extra classes for the overlay, such as a z-index above the dialog that opened it.
  className?: string;
};

/**
 * Lets the user browse folders through an injected endpoint and pick one. Used by the
 * project-creation-wizard module (the new workspace's folder, under the workspace rules) and the
 * file-tree module (a mount's target folder, under the mount rules).
 */
export function FolderBrowserModal({
  isOpen,
  onClose,
  onFolderSelected,
  autoAdvanceOnSelect = false,
  browse,
  createFolder,
  initialPath = '~',
  className,
}: FolderBrowserModalProps) {
  const { t } = useTranslation();
  const [currentPath, setCurrentPath] = useState(initialPath ?? '');
  // The parent the browse endpoint reported for the folder shown; undefined when it reports none,
  // and the parent is then worked out from the path.
  const [reportedParentPath, setReportedParentPath] = useState<string | null | undefined>(undefined);
  const [folders, setFolders] = useState<FolderSuggestion[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [showHiddenFolders, setShowHiddenFolders] = useState(false);
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the endpoint had to say about the folder shown, such as that it is not listed in full.
  const [notice, setNotice] = useState<string | null>(null);

  // Keep the loader stable across locale changes and new `browse` identities: it lands in a ref so
  // an open browser does not reload and snap back to its first folder when the user switches
  // language or the caller re-renders.
  const loadFoldersRef = useRef<(pathToLoad: string | null) => Promise<void>>();
  const initialPathRef = useRef(initialPath);
  // The listing on its way, if any. Opening another folder aborts it, so a slow folder (a big one on a
  // network share) neither keeps the server busy nor replaces the newer listing when it answers late.
  const loadControllerRef = useRef<AbortController | null>(null);

  const loadFolders = useCallback(async (pathToLoad: string | null) => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    setLoadingFolders(true);
    setError(null);

    try {
      const result = await browse(pathToLoad, { signal: controller.signal });
      if (controller.signal.aborted) {
        return;
      }
      setCurrentPath(result.path);
      setReportedParentPath(result.parent);
      setFolders(result.folders);
      setNotice(result.notice ?? null);
    } catch (loadError) {
      if (controller.signal.aborted) {
        return;
      }
      setError(loadError instanceof Error ? loadError.message : t('folderBrowser.loadFailed'));
    } finally {
      if (loadControllerRef.current === controller) {
        loadControllerRef.current = null;
        setLoadingFolders(false);
      }
    }
  }, [browse, t]);

  // Declared before the opening effect, which reads both refs in the same commit.
  useEffect(() => {
    loadFoldersRef.current = loadFolders;
    initialPathRef.current = initialPath;
  }, [initialPath, loadFolders]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    // Shown until the first answer, so a folder that cannot be listed still offers its parent.
    setCurrentPath(initialPathRef.current ?? '');
    setReportedParentPath(undefined);
    setFolders([]);
    setNotice(null);
    void loadFoldersRef.current?.(initialPathRef.current ?? null);
    return () => {
      loadControllerRef.current?.abort();
      loadControllerRef.current = null;
    };
  }, [isOpen]);

  const visibleFolders = useMemo(
    () =>
      folders
        .filter((folder) => showHiddenFolders || !folder.name.startsWith('.'))
        .sort((firstFolder, secondFolder) =>
          firstFolder.name.toLowerCase().localeCompare(secondFolder.name.toLowerCase()),
        ),
    [folders, showHiddenFolders],
  );

  const resetNewFolderState = () => {
    setShowNewFolderInput(false);
    setNewFolderName('');
  };

  const handleClose = () => {
    setError(null);
    resetNewFolderState();
    onClose();
  };

  const handleCreateFolder = useCallback(async () => {
    if (!createFolder || !newFolderName.trim()) {
      return;
    }

    setCreatingFolder(true);
    setError(null);

    try {
      const createdPath = await createFolder(currentPath, newFolderName.trim());
      resetNewFolderState();
      await loadFolders(createdPath);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : t('folderBrowser.createFailed'));
    } finally {
      setCreatingFolder(false);
    }
  }, [createFolder, currentPath, loadFolders, newFolderName, t]);

  const parentPath = reportedParentPath !== undefined ? reportedParentPath : currentPath ? getParentPath(currentPath) : null;

  if (!isOpen) {
    return null;
  }

  return (
    <div className={cn('fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm', className)}>
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/50">
              <FolderOpen className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('folderBrowser.title')}</h3>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowHiddenFolders((previous) => !previous)}
              className={`rounded-md p-2 transition-colors ${
                showHiddenFolders
                  ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                  : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300'
              }`}
              title={showHiddenFolders ? t('folderBrowser.hideHidden') : t('folderBrowser.showHidden')}
            >
              {showHiddenFolders ? <Eye className="h-5 w-5" /> : <EyeOff className="h-5 w-5" />}
            </button>
            {createFolder && (
              <button
                onClick={() => setShowNewFolderInput((previous) => !previous)}
                className={`rounded-md p-2 transition-colors ${
                  showNewFolderInput
                    ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                    : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300'
                }`}
                title={t('folderBrowser.createNew')}
              >
                <Plus className="h-5 w-5" />
              </button>
            )}
            <button
              onClick={handleClose}
              className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {createFolder && showNewFolderInput && (
          <div className="border-b border-gray-200 bg-blue-50 px-4 py-3 dark:border-gray-700 dark:bg-blue-900/20">
            <div className="flex items-center gap-2">
              <Input
                type="text"
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.target.value)}
                placeholder={t('folderBrowser.newFolderPlaceholder')}
                className="flex-1"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleCreateFolder();
                  }
                  if (event.key === 'Escape') {
                    resetNewFolderState();
                  }
                }}
                autoFocus
              />
              <Button
                size="sm"
                onClick={handleCreateFolder}
                disabled={!newFolderName.trim() || creatingFolder}
              >
                {creatingFolder ? <Loader2 className="h-4 w-4 animate-spin" /> : t('folderBrowser.create')}
              </Button>
              <Button size="sm" variant="ghost" onClick={resetNewFolderState}>
                {t('common:cancel')}
              </Button>
            </div>
          </div>
        )}

        {error && (
          <div className="px-4 pt-3">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        {notice && (
          <div className="px-4 pt-3">
            <p role="status" className="text-sm text-amber-700 dark:text-amber-400">{notice}</p>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          {/* While the next folder loads, the one shown stays usable, so the user can open another
              folder instead of waiting for a slow one. */}
          {loadingFolders && folders.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
            </div>
          ) : (
            <div className={cn('space-y-1', loadingFolders && 'opacity-60')} aria-busy={loadingFolders}>
              {loadingFolders && (
                <div className="flex items-center gap-2 px-4 py-1 text-sm text-gray-500 dark:text-gray-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>{t('status.loading')}</span>
                </div>
              )}
              {parentPath && (
                <button
                  onClick={() => loadFolders(parentPath)}
                  className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-start hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <FolderOpen className="h-5 w-5 text-gray-400" />
                  <span className="font-medium text-gray-700 dark:text-gray-300">..</span>
                </button>
              )}

              {visibleFolders.length === 0 ? (
                <div className="py-8 text-center text-gray-500 dark:text-gray-400">
                  {t('folderBrowser.noSubfolders')}
                </div>
              ) : (
                visibleFolders.map((folder) => (
                  <div key={folder.path} className="flex items-center gap-2">
                    <button
                      onClick={() => loadFolders(folder.path)}
                      className="flex flex-1 items-center gap-3 rounded-lg px-4 py-3 text-start hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      <FolderPlus className="h-5 w-5 text-blue-500" />
                      <span className="font-medium text-gray-900 dark:text-white">
                        {folder.name}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onFolderSelected(folder.path, autoAdvanceOnSelect)}
                      className="px-3 text-xs"
                    >
                      {t('folderBrowser.select')}
                    </Button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <div className="border-t border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2 bg-gray-50 px-4 py-3 dark:bg-gray-900/50">
            <span className="text-sm text-gray-600 dark:text-gray-400">{t('folderBrowser.pathLabel')}</span>
            <code className="flex-1 truncate font-mono text-sm text-gray-900 dark:text-white">
              {currentPath}
            </code>
          </div>
          <div className="flex items-center justify-end gap-2 p-4">
            <Button variant="outline" onClick={handleClose}>
              {t('common:cancel')}
            </Button>
            <Button
              variant="outline"
              // Not before the first answer: until then the path shown is only what was asked for.
              disabled={loadingFolders || !currentPath}
              onClick={() => onFolderSelected(currentPath, autoAdvanceOnSelect)}
            >
              {t('folderBrowser.useThisFolder')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
