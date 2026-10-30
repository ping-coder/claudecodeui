import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Download, FileText, FolderPlus, FolderSymlink, Pencil, RefreshCw, Trash2, Unlink, Upload, Wrench, type LucideIcon } from 'lucide-react';

import { isRtl } from '@/shared/direction';
import { cn } from '@/shared/utils';
import type { FileTreeNode } from '@/shared/types';
import { isBrokenMount, isGitignoredEntry } from '@/modules/file-tree/utils/fileTreeUtils';

type ContextMenuAction = {
  key: string;
  label: string;
  icon?: LucideIcon;
  onSelect?: () => void;
  isDanger?: boolean;
  isDisabled?: boolean;
  // Says why a disabled item cannot be used.
  title?: string;
  shortcut?: string;
  showDividerBefore?: boolean;
};

const CONTEXT_MENU_WIDTH = 200;
const CONTEXT_MENU_HEIGHT = 300;
const VIEWPORT_PADDING = 10;

/** Where the menu's fixed box goes: its left edge, or right to left its right edge, and its top. */
type ContextMenuPosition = { left?: number; right?: number; top: number };

function calculateViewportSafePosition(clientX: number, clientY: number): ContextMenuPosition {
  // Keep the context menu inside the visible viewport.
  const safeY =
    clientY + CONTEXT_MENU_HEIGHT > window.innerHeight
      ? window.innerHeight - CONTEXT_MENU_HEIGHT - VIEWPORT_PADDING
      : clientY;
  const top = Math.max(VIEWPORT_PADDING, safeY);

  if (isRtl()) {
    // Right to left it opens leftwards: its right edge at the pointer, however wide the labels make it.
    // Near the left edge of the viewport it is pushed back in, as near the right edge left to right.
    if (clientX - CONTEXT_MENU_WIDTH < 0) {
      return { left: VIEWPORT_PADDING, top };
    }
    return { right: Math.max(VIEWPORT_PADDING, window.innerWidth - clientX), top };
  }

  const safeX =
    clientX + CONTEXT_MENU_WIDTH > window.innerWidth
      ? window.innerWidth - CONTEXT_MENU_WIDTH - VIEWPORT_PADDING
      : clientX;
  return { left: Math.max(VIEWPORT_PADDING, safeX), top };
}

// A right-click inside an open menu stays with it. A row's menu sits inside the empty area's menu
// wrapper, so the event would otherwise open that menu on top of this one.
const keepContextMenuInMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
  event.preventDefault();
  event.stopPropagation();
};

/**
 * Rendered by FileTreeNode to show the right-click actions available on one file or directory row,
 * and by FileTree, without an item, for the empty area around the rows.
 */
export default function FileContextMenu({
  children,
  item,
  onRename,
  onDelete,
  onNewFile,
  onNewFolder,
  onUpload,
  onRefresh,
  onCopyPath,
  onDownload,
  onUnmount,
  onRepairMount,
  onCopyTargetPath,
  onMountFolder,
  holdsMounts = false,
  isLoading = false,
  className = '',
}: {
  children: ReactNode;
  item?: FileTreeNode | null;
  onRename?: (item: FileTreeNode) => void;
  onDelete?: (item: FileTreeNode) => void;
  onNewFile?: (path: string) => void;
  onNewFolder?: (path: string) => void;
  onUpload?: (path: string) => void;
  onRefresh?: () => void;
  onCopyPath?: (item: FileTreeNode) => void;
  onDownload?: (item: FileTreeNode) => void;
  // Mount roots: remove the link, recreate it, copy the folder it links to.
  onUnmount?: (item: FileTreeNode) => void;
  onRepairMount?: (item: FileTreeNode) => void;
  onCopyTargetPath?: (item: FileTreeNode) => void;
  // The empty area's and the mounts/ folder's menus: open the mount dialog.
  onMountFolder?: () => void;
  // The item is mounts/ while the project has mounts (findMountsFolderPath): it holds only the links.
  holdsMounts?: boolean;
  isLoading?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<ContextMenuPosition>({ left: 0, top: 0 });
  const menuRef = useRef<HTMLDivElement>(null);

  const closeContextMenu = useCallback(() => {
    setIsMenuOpen(false);
  }, []);

  const openContextMenuAtCursor = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    // A text box (the new item or rename input) keeps the browser's own menu, with paste and spelling.
    if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]')) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    setMenuPosition(calculateViewportSafePosition(event.clientX, event.clientY));
    setIsMenuOpen(true);
  }, []);

  const runMenuActionAndClose = useCallback((action?: () => void) => {
    closeContextMenu();
    action?.();
  }, [closeContextMenu]);

  const menuActions = useMemo<ContextMenuAction[]>(() => {
    if (item?.type === 'file') {
      return [
        {
          key: 'rename',
          icon: Pencil,
          label: t('fileTree.context.rename', 'Rename'),
          onSelect: () => onRename?.(item),
        },
        {
          key: 'delete',
          icon: Trash2,
          label: t('fileTree.context.delete', 'Delete'),
          onSelect: () => onDelete?.(item),
          isDanger: true,
        },
        {
          key: 'copyPath',
          icon: Copy,
          label: t('fileTree.context.copyPath', 'Copy Path'),
          onSelect: () => onCopyPath?.(item),
          showDividerBefore: true,
        },
        {
          key: 'download',
          icon: Download,
          label: t('fileTree.context.download', 'Download'),
          onSelect: () => onDownload?.(item),
        },
      ];
    }

    const createActions = (folderPath: string): ContextMenuAction[] => [
      {
        key: 'newFile',
        icon: FileText,
        label: t('fileTree.context.newFile', 'New File'),
        onSelect: () => onNewFile?.(folderPath),
      },
      {
        key: 'newFolder',
        icon: FolderPlus,
        label: t('fileTree.context.newFolder', 'New Folder'),
        onSelect: () => onNewFolder?.(folderPath),
      },
      {
        key: 'upload',
        icon: Upload,
        label: t('fileTree.context.upload', 'Upload Files'),
        onSelect: () => onUpload?.(folderPath),
      },
    ];

    const mountFolderActions: ContextMenuAction[] = onMountFolder
      ? [
          {
            key: 'mountFolder',
            icon: FolderSymlink,
            label: t('fileTree.mounts.open'),
            onSelect: onMountFolder,
          },
        ]
      : [];

    // A mount root is the link, not a folder of the project: it is unmounted rather than renamed or
    // deleted (the server refuses both), and offers no ZIP of what may be a very large folder.
    // Anything wrong with it is fixed by Repair, which the row's tooltip points to. A broken one
    // lists nothing to add to; one that only lost its ignore file still lists and opens.
    if (item?.type === 'directory' && item.mount) {
      const broken = isBrokenMount(item);
      return [
        ...(item.mount.status !== 'ok'
          ? [
              {
                key: 'repairMount',
                icon: Wrench,
                label: t('fileTree.context.repairMount'),
                onSelect: () => onRepairMount?.(item),
              },
            ]
          : []),
        ...(broken ? [] : createActions(item.path)),
        {
          key: 'unmount',
          icon: Unlink,
          label: t('fileTree.context.unmount'),
          onSelect: () => onUnmount?.(item),
          isDanger: true,
          showDividerBefore: true,
        },
        {
          key: 'copyTargetPath',
          icon: Copy,
          label: t('fileTree.context.copyTargetPath'),
          onSelect: () => onCopyTargetPath?.(item),
          showDividerBefore: true,
        },
        {
          key: 'refresh',
          icon: RefreshCw,
          label: t('fileTree.context.refresh', 'Refresh'),
          onSelect: onRefresh,
        },
      ];
    }

    if (item?.type === 'directory') {
      // A gitignored folder is listed but never walked: whatever is created or
      // uploaded in it would not show up, and a download would be an empty
      // archive because its children were never loaded.
      const listsContents = !isGitignoredEntry(item);
      // A folder in a mount, or one holding mounts, may be huge: the browser would zip it all in memory.
      const zipDisabled = item.inMount === true || holdsMounts;
      return [
        // mounts/ holds only the links: whatever was made there would sit on the project's own disk,
        // ignored by git, rather than in a mounted folder. Mounting another folder is what it offers.
        ...(holdsMounts ? mountFolderActions : listsContents ? createActions(item.path) : []),
        // The server refuses to rename or delete mounts/ while the project has mounts.
        ...(holdsMounts
          ? []
          : [
              {
                key: 'rename',
                icon: Pencil,
                label: t('fileTree.context.rename', 'Rename'),
                onSelect: () => onRename?.(item),
                showDividerBefore: true,
              },
              {
                key: 'delete',
                icon: Trash2,
                label: t('fileTree.context.delete', 'Delete'),
                onSelect: () => onDelete?.(item),
                isDanger: true,
              },
            ]),
        {
          key: 'copyPath',
          icon: Copy,
          label: t('fileTree.context.copyPath', 'Copy Path'),
          onSelect: () => onCopyPath?.(item),
          showDividerBefore: true,
        },
        ...(listsContents
          ? [
              {
                key: 'download',
                icon: Download,
                label: t('fileTree.context.download', 'Download'),
                onSelect: () => onDownload?.(item),
                isDisabled: zipDisabled,
                title: zipDisabled ? t('fileTree.context.downloadDisabledInMount') : undefined,
              },
            ]
          : []),
      ];
    }

    return [
      ...createActions(''),
      ...mountFolderActions,
      {
        key: 'refresh',
        icon: RefreshCw,
        label: t('fileTree.context.refresh', 'Refresh'),
        onSelect: onRefresh,
        showDividerBefore: true,
      },
    ];
  }, [holdsMounts, item, onCopyPath, onCopyTargetPath, onDelete, onDownload, onMountFolder, onNewFile, onNewFolder, onRefresh, onRename, onRepairMount, onUnmount, onUpload, t]);

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    const handleOutsideMouseDown = (event: MouseEvent) => {
      const menuElement = menuRef.current;
      if (menuElement && !menuElement.contains(event.target as Node)) {
        closeContextMenu();
      }
    };

    const handleEscapeKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeContextMenu();
      }
    };

    document.addEventListener('mousedown', handleOutsideMouseDown);
    document.addEventListener('keydown', handleEscapeKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleOutsideMouseDown);
      document.removeEventListener('keydown', handleEscapeKeyDown);
    };
  }, [closeContextMenu, isMenuOpen]);

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    // Arrow key support keeps the menu accessible without a mouse.
    const handleKeyboardMenuNavigation = (event: KeyboardEvent) => {
      const menuItems = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])');
      if (!menuItems || menuItems.length === 0) {
        return;
      }

      const activeElement = document.activeElement as HTMLElement | null;
      const currentIndex = Array.from(menuItems).findIndex((menuItem) => menuItem === activeElement);

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const nextIndex = currentIndex < menuItems.length - 1 ? currentIndex + 1 : 0;
        menuItems[nextIndex]?.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        const previousIndex = currentIndex > 0 ? currentIndex - 1 : menuItems.length - 1;
        menuItems[previousIndex]?.focus();
      } else if (event.key === 'Enter' || event.key === ' ') {
        if (activeElement?.hasAttribute('role')) {
          event.preventDefault();
          activeElement.click();
        }
      }
    };

    document.addEventListener('keydown', handleKeyboardMenuNavigation);

    return () => {
      document.removeEventListener('keydown', handleKeyboardMenuNavigation);
    };
  }, [isMenuOpen]);

  return (
    <>
      <div onContextMenu={openContextMenuAtCursor} className={cn('contents', className)}>
        {children}
      </div>

      {isMenuOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t('fileTree.context.menuLabel', 'File context menu')}
          style={{ position: 'fixed', ...menuPosition, zIndex: 9999 }}
          onContextMenu={keepContextMenuInMenu}
          className={cn(
            'min-w-[180px] py-1 px-1',
            'bg-popover border border-border rounded-lg shadow-lg',
            'animate-in fade-in-0 zoom-in-95',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          )}
        >
          {isLoading ? (
            <div className="flex items-center justify-center py-4">
              <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="ms-2 text-sm text-muted-foreground">{t('fileTree.context.loading', 'Loading...')}</span>
            </div>
          ) : (
            menuActions.map((action, index) => (
              <Fragment key={action.key}>
                {/* Only a separator between groups, never above the first item. */}
                {action.showDividerBefore && index > 0 && <div className="mx-2 my-1 h-px bg-border" />}
                <button
                  role="menuitem"
                  tabIndex={action.isDisabled ? -1 : 0}
                  disabled={isLoading || action.isDisabled}
                  title={action.title}
                  onClick={() => runMenuActionAndClose(action.onSelect)}
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2 text-sm text-start rounded-md transition-colors',
                    'focus:outline-none focus:bg-accent',
                    action.isDisabled
                      ? 'opacity-50 cursor-not-allowed'
                      : action.isDanger
                      ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950'
                      : 'hover:bg-accent',
                    isLoading && 'pointer-events-none',
                  )}
                >
                  {action.icon && <action.icon className="h-4 w-4 flex-shrink-0" />}
                  <span className="flex-1">{action.label}</span>
                  {action.shortcut && <span className="font-mono text-xs text-muted-foreground">{action.shortcut}</span>}
                </button>
              </Fragment>
            ))
          )}
        </div>
      )}
    </>
  );
}
