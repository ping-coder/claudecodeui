import { useCallback, useState, useEffect, useRef } from 'react';
import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, X, Loader2, Folder, FolderSymlink, Upload } from 'lucide-react';

import { cn, copyTextToClipboard } from '@/shared/utils';
import { ICON_SIZE_CLASS, getFileIconData } from '@/modules/file-tree/utils/fileIcons';
import { useExpandedDirectories } from '@/modules/file-tree/hooks/useExpandedDirectories';
import { useFileTreeData } from '@/modules/file-tree/hooks/useFileTreeData';
import { useFileTreeOperations } from '@/modules/file-tree/hooks/useFileTreeOperations';
import { useFileTreeSearch } from '@/modules/file-tree/hooks/useFileTreeSearch';
import { useFileTreeViewMode } from '@/modules/file-tree/hooks/useFileTreeViewMode';
import { useFileTreeUpload } from '@/modules/file-tree/hooks/useFileTreeUpload';
import { useProjectMounts } from '@/modules/file-tree/hooks/useProjectMounts';
import type { DirectoryRevealRequest, FileTreeDetailedColumn, FileTreeImageSelection, FileTreeNode,Project } from '@/shared/types';
import { useElementWidth } from '@/shared/hooks/useElementWidth';
import { useRefreshSignal } from '@/shared/hooks/useRefreshSignal';
import {
  findMountsFolderPath,
  findMountsFolderRow,
  formatFileSize,
  formatRelativeTime,
  isBrokenMount,
  isGitignoredEntry,
  isImageFile,
} from '@/modules/file-tree/utils/fileTreeUtils';
import { directoryRevealFolders } from '@/modules/file-tree/utils/revealDirectory';
import { ScrollArea, Input } from '@/shared/ui';
import FileContextMenu from '@/modules/file-tree/FileContextMenu';
import FileTreeBody from '@/modules/file-tree/FileTreeBody';
import FileTreeDetailedColumns from '@/modules/file-tree/FileTreeDetailedColumns';
import FileTreeHeader from '@/modules/file-tree/FileTreeHeader';
import FileTreeLoadingState from '@/modules/file-tree/FileTreeLoadingState';
import FileTreeRootRow from '@/modules/file-tree/FileTreeRootRow';
import FileTreeUploadProgress from '@/modules/file-tree/FileTreeUploadProgress';
import ImageViewer from '@/modules/file-tree/ImageViewer';
import MountFolderDialog from '@/modules/file-tree/MountFolderDialog';


// Detailed-view columns that fit a tree this wide, widest tier first. A width of 0 (not measured yet,
// or jsdom) keeps every column, as the tree always showed them.
const DETAILED_COLUMN_TIERS: ReadonlyArray<{ minWidth: number; columns: readonly FileTreeDetailedColumn[] }> = [
  { minWidth: 480, columns: ['size', 'modified', 'permissions'] },
  { minWidth: 380, columns: ['size', 'modified'] },
  { minWidth: 280, columns: ['size'] },
  { minWidth: 1, columns: [] },
];

// Fixed tracks keep the header and every row on one grid; the name takes what is left.
const DETAILED_COLUMN_TRACKS: Record<FileTreeDetailedColumn, string> = {
  size: '4.5rem',
  modified: '6.5rem',
  permissions: '5.5rem',
};

const selectDetailedColumns = (width: number): readonly FileTreeDetailedColumn[] =>
  (width === 0 ? DETAILED_COLUMN_TIERS[0] : DETAILED_COLUMN_TIERS.find((tier) => width >= tier.minWidth) ?? DETAILED_COLUMN_TIERS[0]).columns;

// A folder the tree cannot open: a gitignored one was never walked, and a broken mount has nothing to list.
const isClosedFolder = (item: FileTreeNode) => isGitignoredEntry(item) || isBrokenMount(item);

// The mount root `itemPath` is in or is, found by walking the tree already loaded, so the delete
// dialog can name the folder outside the project that the files really live in.
const findContainingMount = (nodes: FileTreeNode[], itemPath: string): FileTreeNode | null => {
  for (const node of nodes) {
    if (node.type !== 'directory') {
      continue;
    }
    const containsItem = itemPath === node.path || itemPath.startsWith(`${node.path}/`) || itemPath.startsWith(`${node.path}\\`);
    if (!containsItem) {
      continue;
    }
    return node.mount ? node : findContainingMount(node.children ?? [], itemPath);
  }
  return null;
};

type FileTreeProps = {
  selectedProject: Project | null;
  onFileOpen?: (filePath: string) => void;
  // Directory to reveal (from an in-chat `path/` reference): its ancestors are
  // expanded so the folder is visible without hunting through the tree.
  revealDirectory?: DirectoryRevealRequest | null;
  // The workspace pane's refresh token: when it moves, the tree reloads behind the rows already shown.
  refreshToken?: number;
  // The token moved while the tree was not on screen: its first load lists afresh, as that refresh asked.
  freshFirstLoad?: boolean;
};

/** Exported through the file-tree barrel; the project-workspace module renders it as the Files sidebar tab. */
export default function FileTree({ selectedProject, onFileOpen, revealDirectory, refreshToken, freshFirstLoad }: FileTreeProps) {
  const { t } = useTranslation();
  const [selectedImage, setSelectedImage] = useState<FileTreeImageSelection | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  // Whether the mount dialog is open; the header button and the root's menu open it.
  const [mountDialogOpen, setMountDialogOpen] = useState(false);
  // The mount root whose Unmount, picked from its menu, waits for confirmation.
  const [unmountCandidate, setUnmountCandidate] = useState<FileTreeNode | null>(null);
  const newItemInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Show toast notification
  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    setToast({ message, type });
  }, []);

  // Auto-hide toast
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // A refresh the user asks for (the header's button, a Refresh menu item, the tab's or the
  // workspace's refresh, also one that landed while another view was shown) lists the mounts on
  // network shares afresh; the reloads after a change made here do not need to, as the server
  // already knows of it.
  const { files, loading, refreshing, error, refreshFiles, refreshFilesFresh } = useFileTreeData(selectedProject, { freshFirstLoad });
  useRefreshSignal(refreshToken, refreshFilesFresh);
  const { viewMode, changeViewMode } = useFileTreeViewMode();
  const { expandedDirs, toggleDirectory, expandDirectories, collapseAll } = useExpandedDirectories();
  const { searchQuery, setSearchQuery, filteredFiles } = useFileTreeSearch({
    files,
    expandDirectories,
  });

  const projectRoot = selectedProject?.path || selectedProject?.fullPath || '';

  // The reveal request already served, so a later tree refresh does not fold
  // the folders open again over a collapse the user has since made.
  const revealedRef = useRef<DirectoryRevealRequest | null>(null);

  // Expand every ancestor between the project root and the requested folder.
  // A request that arrives before the tree finds no folder and is retried when
  // `files` lands.
  useEffect(() => {
    if (!revealDirectory || !projectRoot || revealedRef.current === revealDirectory) {
      return;
    }
    const folders = directoryRevealFolders(files, projectRoot, revealDirectory.path);
    if (folders.length === 0) {
      return;
    }
    revealedRef.current = revealDirectory;
    // Reaching a gitignored folder serves the request too, but the folder is
    // not recorded as expanded: it cannot open, and the record would open it
    // on a refresh once it stops being ignored.
    expandDirectories(folders.filter((folder) => !isClosedFolder(folder)).map((folder) => folder.path));
  }, [revealDirectory, projectRoot, expandDirectories, files]);

  // File operations
  const operations = useFileTreeOperations({
    selectedProject,
    onRefresh: refreshFiles,
    showToast,
  });

  // File upload (drag and drop). `treeRef` is pulled out of the returned object
  // so the remaining plain values are not treated as render-time ref reads.
  const { treeRef, ...upload } = useFileTreeUpload({
    selectedProject,
    onRefresh: refreshFiles,
    showToast,
  });
  const operationLoading = operations.operationLoading || upload.operationLoading;

  const projectMounts = useProjectMounts({
    projectId: selectedProject?.projectId ?? null,
    dialogOpen: mountDialogOpen,
    onChanged: refreshFiles,
    showToast,
  });
  const { loadMounts, repairMount, unmount } = projectMounts;

  // A tree showing mounts/ lists the project's mounts once, so mounts/ is known for what it is
  // even when every link in it is gone from disk and nothing is listed under it. The dialog and
  // the mount actions list them again whenever they change.
  const showsMountsFolder = findMountsFolderRow(files) !== null;
  useEffect(() => {
    if (showsMountsFolder) {
      void loadMounts();
    }
  }, [loadMounts, showsMountsFolder]);
  const mountsFolderPath = findMountsFolderPath(files, projectMounts.mounts.length > 0);

  const openMountDialog = useCallback(() => setMountDialogOpen(true), []);

  const handleRepairMount = useCallback((item: FileTreeNode) => {
    if (item.mount) {
      void repairMount(item.mount);
    }
  }, [repairMount]);

  // copyTextToClipboard still copies where the Clipboard API is missing, as on a plain-HTTP server.
  const copyPath = useCallback(async (path: string) => {
    const copied = await copyTextToClipboard(path);
    showToast(
      copied ? t('fileTree.toast.pathCopied', 'Path copied to clipboard') : t('fileTree.toast.copyFailed', 'Failed to copy path'),
      copied ? 'success' : 'error',
    );
  }, [showToast, t]);

  const handleCopyTargetPath = useCallback((item: FileTreeNode) => {
    void copyPath(item.mount?.targetPath ?? '');
  }, [copyPath]);

  const handleCopyRootPath = useCallback(() => {
    void copyPath(projectRoot);
  }, [copyPath, projectRoot]);

  const handleConfirmUnmount = useCallback(() => {
    const mount = unmountCandidate?.mount;
    setUnmountCandidate(null);
    if (mount) {
      void unmount(mount);
    }
  }, [unmount, unmountCandidate]);

  // Which detailed columns fit the tree's own width (a docked editor, a split pane or a phone narrows it).
  // `loading` re-measures once the root replaces the loading state.
  const detailedColumns = useElementWidth(treeRef, selectDetailedColumns, loading);
  const detailedGridTemplate = ['minmax(0, 1fr)', ...detailedColumns.map((column) => DETAILED_COLUMN_TRACKS[column])].join(' ');

  // Folder-targeted uploads (context menu / hover button) share one hidden
  // input; the target path is remembered until the user picks the files.
  const folderUploadInputRef = useRef<HTMLInputElement>(null);
  const folderUploadTargetRef = useRef('');
  const { uploadFiles } = upload;

  const handleUploadToFolder = useCallback((targetPath: string) => {
    folderUploadTargetRef.current = targetPath;
    folderUploadInputRef.current?.click();
  }, []);

  const handleFolderUploadInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const { files: pickedFiles } = event.target;
      if (pickedFiles && pickedFiles.length > 0) {
        uploadFiles(Array.from(pickedFiles), folderUploadTargetRef.current);
      }
      event.target.value = '';
    },
    [uploadFiles],
  );

  // Focus input when creating new item
  useEffect(() => {
    if (operations.isCreating && newItemInputRef.current) {
      newItemInputRef.current.focus();
      newItemInputRef.current.select();
    }
  }, [operations.isCreating]);

  // Focus input when renaming
  useEffect(() => {
    if (operations.renamingItem && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [operations.renamingItem]);

  const renderFileIcon = useCallback((filename: string) => {
    const { icon: Icon, color } = getFileIconData(filename);
    return <Icon className={cn(ICON_SIZE_CLASS, color)} />;
  }, []);

  // Centralized click behavior keeps file actions identical across all presentation modes.
  const handleItemClick = useCallback(
    (item: FileTreeNode) => {
      if (item.type === 'directory') {
        // A gitignored folder cannot be opened. Recording it as expanded would
        // only leave stale state that opens it once it stops being ignored.
        if (!isClosedFolder(item)) {
          toggleDirectory(item.path);
        }
        return;
      }

      if (isImageFile(item.name) && selectedProject) {
        setSelectedImage({
          name: item.name,
          path: item.path,
          projectPath: selectedProject.path,
          // Image URL uses the DB projectId so ImageViewer can hit the
          // /api/file-tree/projects/:projectId/files/content endpoint directly.
          projectId: selectedProject.projectId,
        });
        return;
      }

      onFileOpen?.(item.path);
    },
    [onFileOpen, selectedProject, toggleDirectory],
  );

  const formatRelativeTimeLabel = useCallback(
    (date?: string) => formatRelativeTime(date, t),
    [t],
  );

  // The project root's menu, the same from its row and from the empty area around the rows.
  const rootMenuActions = {
    onNewFile: (path: string) => operations.handleStartCreate(path, 'file'),
    onNewFolder: (path: string) => operations.handleStartCreate(path, 'directory'),
    onUpload: handleUploadToFolder,
    onRefresh: refreshFilesFresh,
    onMountFolder: selectedProject ? openMountDialog : undefined,
    onCopyRootPath: projectRoot ? handleCopyRootPath : undefined,
  };

  // The mount the item up for deletion lives in, if any: its files are the real ones, outside the project.
  const deleteMountRoot = operations.deleteConfirmation.item
    ? findContainingMount(files, operations.deleteConfirmation.item.path)
    : null;

  const treeView = (
    <div
      ref={treeRef}
      className="relative flex h-full flex-col bg-background"
      onDragEnter={upload.handleDragEnter}
      onDragOver={upload.handleDragOver}
      onDragLeave={upload.handleDragLeave}
      onDrop={upload.handleDrop}
    >
      {/* Hidden input for folder-targeted uploads (context menu / hover button) */}
      <input
        ref={folderUploadInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFolderUploadInputChange}
        tabIndex={-1}
        aria-hidden="true"
      />

      {/* Drag overlay; pointer-events-none keeps folder rows reachable as drop targets */}
      {upload.isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center border-2 border-dashed border-blue-500 bg-blue-500/10">
          <div className="flex items-center gap-3 rounded-lg bg-background/95 px-6 py-4 shadow-lg">
            <Upload className="h-6 w-6 text-blue-500" />
            <span className="text-sm font-medium">
              {upload.dropTarget
                ? t('fileTree.dropToUploadTo', 'Drop files to upload to "{{folder}}"', {
                    folder: upload.dropTarget.split(/[\\/]/).pop(),
                  })
                : t('fileTree.dropToUpload', 'Drop files to upload')}
            </span>
          </div>
        </div>
      )}

      <FileTreeHeader
        viewMode={viewMode}
        onViewModeChange={changeViewMode}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onUploadFiles={upload.handleFileSelect}
        onNewFile={() => operations.handleStartCreate('', 'file')}
        onNewFolder={() => operations.handleStartCreate('', 'directory')}
        onMountFolder={selectedProject ? openMountDialog : undefined}
        onRefresh={refreshFilesFresh}
        onCollapseAll={collapseAll}
        loading={loading || refreshing}
        operationLoading={operationLoading}
        isUploading={upload.uploadProgress?.status === 'uploading'}
        uploadProgress={upload.uploadProgress?.progress ?? null}
      />

      <FileTreeUploadProgress upload={upload.uploadProgress} />

      {/* Outside the scroller and the states in it: the root's menu is always one right-click or tap away. */}
      {selectedProject && (
        <FileTreeRootRow
          name={selectedProject.displayName || projectRoot}
          path={projectRoot}
          isDropTarget={upload.isDragOver && !upload.dropTarget}
          {...rootMenuActions}
        />
      )}

      {/* The empty area's menu: rows open their own and stop the event, so this one only opens around them. */}
      <FileContextMenu {...rootMenuActions}>
        <ScrollArea className="flex-1 px-2 py-1">
          {/* Inside the scroller, so a vertical scrollbar narrows the labels and the rows alike. */}
          {viewMode === 'detailed' && filteredFiles.length > 0 && (
            <FileTreeDetailedColumns columns={detailedColumns} gridTemplate={detailedGridTemplate} />
          )}

          {/* New item input */}
          {operations.isCreating && (
            <div
              className="mb-1 flex items-center gap-1.5 py-[3px] pe-2"
              style={{ paddingInlineStart: `${(operations.newItemParent.split('/').length - 1) * 16 + 4}px` }}
            >
              {operations.newItemType === 'directory' ? (
                <Folder className={cn(ICON_SIZE_CLASS, 'text-blue-500')} />
              ) : (
                <span className="ms-[18px]">{renderFileIcon(operations.newItemName)}</span>
              )}
              <Input
                ref={newItemInputRef}
                type="text"
                value={operations.newItemName}
                onChange={(e) => operations.setNewItemName(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') operations.handleConfirmCreate();
                  if (e.key === 'Escape') operations.handleCancelCreate();
                }}
                onBlur={() => {
                  setTimeout(() => {
                    if (operations.isCreating) operations.handleConfirmCreate();
                  }, 100);
                }}
                className="h-6 flex-1 text-sm"
                disabled={operationLoading}
              />
            </div>
          )}

          <FileTreeBody
            files={files}
            filteredFiles={filteredFiles}
            error={error}
            searchQuery={searchQuery}
            viewMode={viewMode}
            detailedColumns={detailedColumns}
            detailedGridTemplate={detailedGridTemplate}
            expandedDirs={expandedDirs}
            onItemClick={handleItemClick}
            renderFileIcon={renderFileIcon}
            formatFileSize={formatFileSize}
            formatRelativeTime={formatRelativeTimeLabel}
            onRename={operations.handleStartRename}
            onDelete={operations.handleStartDelete}
            onNewFile={(path) => operations.handleStartCreate(path, 'file')}
            onNewFolder={(path) => operations.handleStartCreate(path, 'directory')}
            onCopyPath={operations.handleCopyPath}
            onDownload={operations.handleDownload}
            onUpload={handleUploadToFolder}
            onRefresh={refreshFilesFresh}
            onUnmount={setUnmountCandidate}
            onRepairMount={handleRepairMount}
            onCopyTargetPath={handleCopyTargetPath}
            onMountFolder={selectedProject ? openMountDialog : undefined}
            mountsFolderPath={mountsFolderPath}
            dropTarget={upload.dropTarget}
            onItemDragOver={upload.handleItemDragOver}
            // Pass rename state and handlers for inline editing
            renamingItem={operations.renamingItem}
            renameValue={operations.renameValue}
            setRenameValue={operations.setRenameValue}
            handleConfirmRename={operations.handleConfirmRename}
            handleCancelRename={operations.handleCancelRename}
            renameInputRef={renameInputRef}
            operationLoading={operationLoading}
          />
        </ScrollArea>
      </FileContextMenu>

      {selectedImage && (
        <ImageViewer
          file={selectedImage}
          onClose={() => setSelectedImage(null)}
        />
      )}

      {/* Delete Confirmation Dialog */}
      {operations.deleteConfirmation.isOpen && operations.deleteConfirmation.item && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
          <div className="mx-4 max-w-sm rounded-lg border border-border bg-background p-4 shadow-lg">
            <div className="mb-4 flex items-center gap-3">
              <div className="rounded-full bg-red-100 p-2 dark:bg-red-900/30">
                <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
              </div>
              <div>
                <h3 className="font-medium text-foreground">
                  {operations.deleteConfirmation.item.type === 'directory'
                    ? t('fileTree.delete.titleFolder', 'Delete Folder')
                    : t('fileTree.delete.titleFile', 'Delete File')}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {operations.deleteConfirmation.item.name}
                </p>
              </div>
            </div>
            <p className="mb-4 text-sm text-muted-foreground">
              {operations.deleteConfirmation.item.type === 'directory'
                ? t('fileTree.delete.folderWarning', 'This folder and all its contents will be permanently deleted.')
                : t('fileTree.delete.fileWarning', 'This file will be permanently deleted.')}
            </p>
            {deleteMountRoot ? (
              <p className="mb-4 text-sm font-medium text-red-600 dark:text-red-400" data-delete-warning="mount">
                {t('fileTree.delete.inMountWarning', {
                  mount: deleteMountRoot.mount?.name ?? deleteMountRoot.name,
                  target: deleteMountRoot.mount?.targetPath ?? '',
                })}
              </p>
            ) : operations.deleteConfirmation.item.inMount ? (
              <p className="mb-4 text-sm font-medium text-red-600 dark:text-red-400" data-delete-warning="mount">
                {t('fileTree.delete.inMountWarningNoTarget')}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                onClick={operations.handleCancelDelete}
                disabled={operationLoading}
                className="rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                onClick={operations.handleConfirmDelete}
                disabled={operationLoading}
                className="flex items-center gap-2 rounded-md bg-red-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-red-700 disabled:opacity-50"
              >
                {operationLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('fileTree.delete.confirm', 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  // Beside the tree rather than in it, so a reload that brings back the loading state (a mount action
  // on a tree that failed to load) leaves the mount dialog, an Unmount confirmation and a toast as they were.
  const overlays = (
    <>
      {/* Unmount confirmation, for a mount root's menu: only the link goes, the folder stays */}
      {unmountCandidate?.mount && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
          <div className="mx-4 max-w-sm rounded-lg border border-border bg-background p-4 shadow-lg">
            <div className="mb-4 flex items-center gap-3">
              <div className="rounded-full bg-sky-100 p-2 dark:bg-sky-900/30">
                <FolderSymlink className="h-5 w-5 text-sky-600 dark:text-sky-400" />
              </div>
              <h3 className="font-medium text-foreground">
                {t('fileTree.mounts.unmountTitle', { name: unmountCandidate.mount.name })}
              </h3>
            </div>
            <p className="mb-4 text-sm text-muted-foreground">
              {t('fileTree.mounts.unmountConfirm', { name: unmountCandidate.mount.name, target: unmountCandidate.mount.targetPath })}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setUnmountCandidate(null)}
                className="rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                onClick={handleConfirmUnmount}
                className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90"
              >
                {t('fileTree.mounts.unmount')}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedProject && (
        <MountFolderDialog
          isOpen={mountDialogOpen}
          onClose={() => setMountDialogOpen(false)}
          mounts={projectMounts}
        />
      )}

      {/* Toast Notification */}
      {toast && (
        <div
          className={cn(
            'fixed bottom-4 end-4 z-[9999] px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 animate-in slide-in-from-bottom-2',
            toast.type === 'success'
              ? 'bg-green-600 text-white'
              : 'bg-red-600 text-white'
          )}
        >
          {toast.type === 'success' ? (
            <Check className="h-4 w-4" />
          ) : (
            <X className="h-4 w-4" />
          )}
          <span className="text-sm">{toast.message}</span>
        </div>
      )}
    </>
  );

  return (
    <>
      {loading ? <FileTreeLoadingState /> : treeView}
      {overlays}
    </>
  );
}
