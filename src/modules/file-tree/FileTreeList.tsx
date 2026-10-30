import type { DragEvent, ReactNode, RefObject } from 'react';

import type { FileTreeDetailedColumn, FileTreeNode as FileTreeNodeType, FileTreeViewMode } from '@/shared/types';
import FileTreeNode from '@/modules/file-tree/FileTreeNode';

type FileTreeListProps = {
  items: FileTreeNodeType[];
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

/** Rendered by FileTreeBody to lay out the tree rows for the active view mode. */
export default function FileTreeList({
  items,
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
  mountsFolderPath,
  dropTarget,
  onItemDragOver,
  renamingItem,
  renameValue,
  setRenameValue,
  handleConfirmRename,
  handleCancelRename,
  renameInputRef,
  operationLoading,
}: FileTreeListProps) {
  return (
    <div>
      {items.map((item) => (
        <FileTreeNode
          key={item.path}
          item={item}
          level={0}
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
    </div>
  );
}
