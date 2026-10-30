import type { DragEvent, ReactNode, RefObject } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Folder, FolderOpen, FolderSymlink, FolderX, Upload } from 'lucide-react';

import { cn } from '@/shared/utils';
import type { FileTreeDetailedColumn, FileTreeNode as FileTreeNodeType, FileTreeViewMode } from '@/shared/types';
import { Input } from '@/shared/ui';
import FileContextMenu from '@/modules/file-tree/FileContextMenu';
import { describeMountStatus, isBrokenMount, isGitignoredEntry } from '@/modules/file-tree/utils/fileTreeUtils';

type FileTreeNodeProps = {
  item: FileTreeNodeType;
  level: number;
  viewMode: FileTreeViewMode;
  // Detailed view only: the metadata columns that fit and the grid they share with the header.
  detailedColumns: readonly FileTreeDetailedColumn[];
  detailedGridTemplate: string;
  expandedDirs: Set<string>;
  onItemClick: (item: FileTreeNodeType) => void;
  renderFileIcon: (filename: string) => ReactNode;
  formatFileSize: (bytes?: number) => string;
  formatRelativeTime: (date?: string) => string;
  onRename?: (item: FileTreeNodeType) => void;
  onDelete?: (item: FileTreeNodeType) => void;
  onNewFile?: (path: string) => void;
  onNewFolder?: (path: string) => void;
  onCopyPath?: (item: FileTreeNodeType) => void;
  onDownload?: (item: FileTreeNodeType) => void;
  onUpload?: (path: string) => void;
  onRefresh?: () => void;
  // Mount roots' own actions
  onUnmount?: (item: FileTreeNodeType) => void;
  onRepairMount?: (item: FileTreeNodeType) => void;
  onCopyTargetPath?: (item: FileTreeNodeType) => void;
  // The mounts/ folder's own action, and its path while the project has mounts (findMountsFolderPath)
  onMountFolder?: () => void;
  mountsFolderPath?: string | null;
  // Drag-and-drop upload targeting
  dropTarget?: string | null;
  onItemDragOver?: (event: DragEvent<HTMLDivElement>, targetPath: string) => void;
  // Rename state for inline editing
  renamingItem?: FileTreeNodeType | null;
  renameValue?: string;
  setRenameValue?: (value: string) => void;
  handleConfirmRename?: () => void;
  handleCancelRename?: () => void;
  renameInputRef?: RefObject<HTMLInputElement>;
  operationLoading?: boolean;
};

type TreeItemIconProps = {
  item: FileTreeNodeType;
  isOpen: boolean;
  renderFileIcon: (filename: string) => ReactNode;
};

// A file dropped onto a file row should land next to it, in its parent folder.
function getParentDirectoryPath(itemPath: string) {
  const segments = itemPath.split(/[\\/]/);
  segments.pop();
  return segments.join('/');
}

// What hovering a mount root says: the folder it links to, and what is wrong with it if anything is.
function describeMountRow(item: FileTreeNodeType, t: TFunction): string | undefined {
  if (!item.mount) {
    return undefined;
  }
  const { status, targetPath } = item.mount;
  if (status === 'ok') {
    return t('fileTree.mounts.nodeTitle', { target: targetPath });
  }
  return t(isBrokenMount(item) ? 'fileTree.mounts.nodeBrokenTitle' : 'fileTree.mounts.nodeWarningTitle', {
    target: targetPath,
    status: describeMountStatus(status, t),
  });
}

function TreeItemIcon({ item, isOpen, renderFileIcon }: TreeItemIconProps) {
  if (item.type === 'directory') {
    const brokenMount = isBrokenMount(item);
    const ignored = isGitignoredEntry(item);
    // A mount's own icon says the folder lives elsewhere; a broken one is drawn red and crossed out.
    const folderIcon = item.mount ? (
      brokenMount ? (
        <FolderX className="h-4 w-4 flex-shrink-0 text-red-500" data-mount-icon="broken" />
      ) : (
        <FolderSymlink className="h-4 w-4 flex-shrink-0 text-sky-500" data-mount-icon="ok" />
      )
    ) : isOpen ? (
      <FolderOpen className="h-4 w-4 flex-shrink-0 text-blue-500" />
    ) : (
      <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
    );
    return (
      <span className={cn('flex flex-shrink-0 items-center gap-0.5', ignored && 'opacity-60')}>
        {ignored || brokenMount ? (
          // A gitignored folder or a broken mount cannot be opened, so it gets
          // no chevron; the blank keeps its icon aligned with its siblings.
          <span className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight
            className={cn(
              'w-3.5 h-3.5 text-muted-foreground/70 transition-transform duration-150',
              isOpen && 'rotate-90',
            )}
          />
        )}
        {folderIcon}
      </span>
    );
  }

  return (
    <span className={cn('ms-[18px] flex flex-shrink-0 items-center', isGitignoredEntry(item) && 'opacity-60')}>
      {renderFileIcon(item.name)}
    </span>
  );
}

/** Rendered by FileTreeList for each file or directory row, including its context menu and inline rename input. */
export default function FileTreeNode({
  item,
  level,
  viewMode,
  detailedColumns,
  detailedGridTemplate,
  expandedDirs,
  onItemClick,
  renderFileIcon,
  formatFileSize,
  formatRelativeTime,
  onRename,
  onDelete,
  onNewFile,
  onNewFolder,
  onCopyPath,
  onDownload,
  onUpload,
  onRefresh,
  onUnmount,
  onRepairMount,
  onCopyTargetPath,
  onMountFolder,
  mountsFolderPath = null,
  dropTarget,
  onItemDragOver,
  renamingItem,
  renameValue,
  setRenameValue,
  handleConfirmRename,
  handleCancelRename,
  renameInputRef,
  operationLoading,
}: FileTreeNodeProps) {
  const { t } = useTranslation();
  const isDirectory = item.type === 'directory';
  const isIgnored = isGitignoredEntry(item);
  const brokenMount = isBrokenMount(item);
  // A gitignored folder was never walked, so it has nothing to show. Clicks
  // and chat reveals do not record it as expanded; this check also keeps a
  // folder closed that was opened before a rule started matching it. A
  // broken mount has nothing to list either.
  const isOpen = isDirectory && !isIgnored && !brokenMount && expandedDirs.has(item.path);
  const hasChildren = Boolean(isDirectory && item.children && item.children.length > 0);
  const isRenaming = renamingItem?.path === item.path;
  // A top-level file's folder is the project root, sent as '' like a drop on
  // empty space: an older server refuses the root's own absolute path (403).
  const dragTargetPath = isDirectory ? item.path : level === 0 ? '' : getParentDirectoryPath(item.path);
  const isDropTarget = isDirectory && dropTarget === item.path;
  const holdsMounts = isDirectory && mountsFolderPath !== null && item.path === mountsFolderPath;
  // Whatever lands in a gitignored folder would not show up in the tree, so it
  // offers no upload button and does not claim drops: a file dragged over it
  // goes to the root, as over empty space. A broken mount has no folder to
  // write to, and mounts/ holds only the links.
  const refusesUploads = isDirectory && (isIgnored || brokenMount || holdsMounts);
  // A file row aims a drop at its folder (joined with '/'), so a file left in mounts/ does not claim it either.
  const claimsDrops = !refusesUploads
    && (mountsFolderPath === null || dragTargetPath.replace(/\\/g, '/') !== mountsFolderPath.replace(/\\/g, '/'));

  const nameClassName = cn(
    'bidi-auto text-[13px] leading-tight truncate',
    isDirectory ? 'font-medium text-foreground' : 'text-foreground/90',
    // Greyed on the icon and name only: on the row it would fade the hover background too.
    isIgnored && 'opacity-60',
  );

  // View mode only changes the row layout; selection, expansion, and recursion stay shared.
  const rowClassName = cn(
    viewMode === 'detailed'
      ? 'group grid gap-x-2 py-[3px] pe-2 hover:bg-accent/60 cursor-pointer items-center rounded-sm transition-colors duration-100'
      : viewMode === 'compact'
      ? 'group flex items-center justify-between py-[3px] pe-2 hover:bg-accent/60 cursor-pointer rounded-sm transition-colors duration-100'
      : 'group flex items-center gap-1.5 py-[3px] pe-2 cursor-pointer rounded-sm hover:bg-accent/60 transition-colors duration-100',
    isDirectory && isOpen && 'border-s-2 border-primary/30',
    (isDirectory && !isOpen) || !isDirectory ? 'border-s-2 border-transparent' : '',
    'relative',
    isDropTarget && 'bg-blue-500/10 ring-1 ring-inset ring-blue-500/40',
  );

  // Render rename input if this item is being renamed
  if (isRenaming && setRenameValue && handleConfirmRename && handleCancelRename) {
    return (
      <div
        className={cn(rowClassName, 'bg-accent/30')}
        // In the detailed grid the input spans the row instead of one metadata track.
        style={{
          paddingInlineStart: `${level * 16 + 4}px`,
          ...(viewMode === 'detailed' ? { gridTemplateColumns: 'auto minmax(0, 1fr)' } : null),
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <TreeItemIcon item={item} isOpen={isOpen} renderFileIcon={renderFileIcon} />
        <Input
          ref={renameInputRef}
          type="text"
          value={renameValue || ''}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') handleConfirmRename();
            if (e.key === 'Escape') handleCancelRename();
          }}
          onBlur={() => {
            setTimeout(() => {
              handleConfirmRename();
            }, 100);
          }}
          className="h-6 flex-1 text-sm"
          disabled={operationLoading}
        />
      </div>
    );
  }

  const uploadHoverButton = isDirectory && !refusesUploads && onUpload && (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onUpload(item.path);
      }}
      title={t('fileTree.uploadToFolder', 'Upload files to "{{folder}}"', { folder: item.name })}
      aria-label={t('fileTree.uploadToFolder', 'Upload files to "{{folder}}"', { folder: item.name })}
      className={cn(
        'absolute end-1 top-1/2 -translate-y-1/2 rounded p-1',
        'bg-background/80 text-muted-foreground opacity-0 transition-opacity',
        'group-hover:opacity-100 focus-visible:opacity-100 hover:bg-accent hover:text-foreground',
      )}
    >
      <Upload className="h-3.5 w-3.5" />
    </button>
  );

  const rowContent = (
    <div
      className={rowClassName}
      style={{
        paddingInlineStart: `${level * 16 + 4}px`,
        ...(viewMode === 'detailed' ? { gridTemplateColumns: detailedGridTemplate } : null),
      }}
      // "Matches a rule" rather than "ignored by git": a tracked file that
      // matches a rule is greyed out too.
      title={item.mount ? describeMountRow(item, t) : isIgnored ? t('fileTree.ignoredByGitignore', { defaultValue: 'Matches a .gitignore rule' }) : undefined}
      onClick={() => onItemClick(item)}
      onDragOver={onItemDragOver && claimsDrops ? (event) => onItemDragOver(event, dragTargetPath) : undefined}
    >
      {viewMode === 'detailed' ? (
        <>
          <div data-column="name" className="flex min-w-0 items-center gap-1.5">
            <TreeItemIcon item={item} isOpen={isOpen} renderFileIcon={renderFileIcon} />
            <span className={nameClassName}>{item.name}</span>
          </div>
          {detailedColumns.includes('size') && (
            <div data-column="size" className="bidi-ltr truncate text-sm tabular-nums text-muted-foreground">
              {item.type === 'file' ? formatFileSize(item.size) : ''}
            </div>
          )}
          {detailedColumns.includes('modified') && (
            <div data-column="modified" className="truncate text-sm text-muted-foreground">{formatRelativeTime(item.modified)}</div>
          )}
          {detailedColumns.includes('permissions') && (
            <div data-column="permissions" className="truncate font-mono text-sm text-muted-foreground">{item.permissionsRwx || ''}</div>
          )}
        </>
      ) : viewMode === 'compact' ? (
        <>
          <div className="flex min-w-0 items-center gap-1.5">
            <TreeItemIcon item={item} isOpen={isOpen} renderFileIcon={renderFileIcon} />
            <span className={nameClassName}>{item.name}</span>
          </div>
          <div className="ms-2 flex flex-shrink-0 items-center gap-3 text-sm text-muted-foreground">
            {item.type === 'file' && (
              <>
                <span className="tabular-nums">{formatFileSize(item.size)}</span>
                <span className="font-mono">{item.permissionsRwx}</span>
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <TreeItemIcon item={item} isOpen={isOpen} renderFileIcon={renderFileIcon} />
          <span className={nameClassName}>{item.name}</span>
        </>
      )}
      {uploadHoverButton}
    </div>
  );

  // Check if context menu callbacks are provided
  const hasContextMenu = onRename || onDelete || onNewFile || onNewFolder || onCopyPath || onDownload || onRefresh || onUnmount;

  return (
    <div className="select-none">
      {hasContextMenu ? (
        <FileContextMenu
          item={item}
          onRename={onRename}
          onDelete={onDelete}
          onNewFile={onNewFile}
          onNewFolder={onNewFolder}
          onUpload={onUpload}
          onCopyPath={onCopyPath}
          onDownload={onDownload}
          onRefresh={onRefresh}
          onUnmount={onUnmount}
          onRepairMount={onRepairMount}
          onCopyTargetPath={onCopyTargetPath}
          onMountFolder={holdsMounts ? onMountFolder : undefined}
          holdsMounts={holdsMounts}
        >
          {rowContent}
        </FileContextMenu>
      ) : (
        rowContent
      )}

      {/* A truncated folder says so even when the budget ran out before its first entry. */}
      {isDirectory && isOpen && (hasChildren || item.truncated) && (
        <div className="relative">
          <span
            className="absolute bottom-0 top-0 border-s border-border/40"
            style={{ insetInlineStart: `${level * 16 + 14}px` }}
            aria-hidden="true"
          />
          {item.children?.map((child) => (
            <FileTreeNode
              key={child.path}
              item={child}
              level={level + 1}
              viewMode={viewMode}
              detailedColumns={detailedColumns}
              detailedGridTemplate={detailedGridTemplate}
              expandedDirs={expandedDirs}
              onItemClick={onItemClick}
              renderFileIcon={renderFileIcon}
              formatFileSize={formatFileSize}
              formatRelativeTime={formatRelativeTime}
              onRename={onRename}
              onDelete={onDelete}
              onNewFile={onNewFile}
              onNewFolder={onNewFolder}
              onCopyPath={onCopyPath}
              onDownload={onDownload}
              onUpload={onUpload}
              onRefresh={onRefresh}
              onUnmount={onUnmount}
              onRepairMount={onRepairMount}
              onCopyTargetPath={onCopyTargetPath}
              onMountFolder={onMountFolder}
              mountsFolderPath={mountsFolderPath}
              dropTarget={dropTarget}
              onItemDragOver={onItemDragOver}
              renamingItem={renamingItem}
              renameValue={renameValue}
              setRenameValue={setRenameValue}
              handleConfirmRename={handleConfirmRename}
              handleCancelRename={handleCancelRename}
              renameInputRef={renameInputRef}
              operationLoading={operationLoading}
            />
          ))}
          {item.truncated && (
            <div
              className="py-[3px] pe-2 text-xs text-muted-foreground"
              style={{ paddingInlineStart: `${(level + 1) * 16 + 22}px` }}
            >
              {t('fileTree.mounts.truncated')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
