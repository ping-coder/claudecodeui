import { FolderOpen, MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';
import FileContextMenu from '@/modules/file-tree/FileContextMenu';

type FileTreeRootRowProps = {
  /** The project's name, and the folder it is in, shown on hover. */
  name: string;
  path: string;
  // Lit while a drop would land in the project root: over this row, empty space or a top-level file.
  isDropTarget: boolean;
  // The project root's menu, as the empty area around the rows has it.
  onNewFile: (path: string) => void;
  onNewFolder: (path: string) => void;
  onUpload: (path: string) => void;
  onRefresh: () => void;
  onMountFolder?: () => void;
  onCopyRootPath?: () => void;
};

/**
 * Rendered by FileTree above the scroller, so the project root always has a row to right-click, even
 * with a long list, an empty project or a listing that failed. Its ⋯ opens the same menu on a touch
 * screen and from the keyboard. A click on the row does nothing: folding the whole tree away would
 * look like the files were gone, and Collapse All is in the header. A drop on it is left to the
 * tree's own handler, which aims it at the root.
 */
export default function FileTreeRootRow({
  name,
  path,
  isDropTarget,
  onNewFile,
  onNewFolder,
  onUpload,
  onRefresh,
  onMountFolder,
  onCopyRootPath,
}: FileTreeRootRowProps) {
  const { t } = useTranslation();
  const actionsLabel = t('fileTree.rootActions', { name });

  return (
    <div className="select-none px-2 pt-1">
      <FileContextMenu
        onNewFile={onNewFile}
        onNewFolder={onNewFolder}
        onUpload={onUpload}
        onRefresh={onRefresh}
        onMountFolder={onMountFolder}
        onCopyRootPath={onCopyRootPath}
      >
        {(menuTrigger) => (
          <div
            data-file-tree-root=""
            title={path}
            className={cn(
              'group flex items-center gap-1.5 rounded-sm border-s-2 border-transparent py-[3px] pe-1 ps-1 transition-colors duration-100 hover:bg-accent/60',
              isDropTarget && 'bg-blue-500/10 ring-1 ring-inset ring-blue-500/40',
            )}
          >
            <FolderOpen className="h-4 w-4 flex-shrink-0 text-blue-500" />
            <span className="bidi-auto truncate text-[13px] font-semibold leading-tight text-foreground">{name}</span>
            {/* Shown on hover or focus where there is a mouse, always on a touch screen, which has no right-click. */}
            <button
              type="button"
              {...menuTrigger}
              title={actionsLabel}
              aria-label={actionsLabel}
              className={cn(
                'ms-auto flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity',
                'hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                'group-hover:opacity-100 aria-expanded:opacity-100',
                '[@media(pointer:coarse)]:h-7 [@media(pointer:coarse)]:w-7 [@media(pointer:coarse)]:opacity-100',
              )}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </FileContextMenu>
    </div>
  );
}
