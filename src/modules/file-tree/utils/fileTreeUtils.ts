import type { TFunction } from 'i18next';

import type { FileTreeNode, ProjectMountStatus } from '@/shared/types';

const IMAGE_FILE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'ico',
  'bmp',
]);

/**
 * Whether a node is greyed out as matching a .gitignore rule. A registered mount, and the mounts/
 * folder holding mounts, are listed whatever a root rule says about mounts/: the server walks them.
 */
export function isGitignoredEntry(item: FileTreeNode): boolean {
  return item.isIgnored === true && !item.mount && !item.children?.some((child) => Boolean(child.mount));
}

/**
 * Whether a node is a mount root whose folder cannot be listed: the link is gone or points
 * elsewhere, or the target is gone or not a folder. Like a gitignored folder it has no children,
 * cannot be opened and takes no uploads; Repair or Unmount are what it offers. A mount that only
 * lost its ignore file ('not-ignored') still lists and opens.
 */
export function isBrokenMount(item: FileTreeNode): boolean {
  return Boolean(item.mount) && item.mount?.status !== 'ok' && item.mount?.status !== 'not-ignored';
}

// The folder at the project root that holds the mount links (the server's PROJECT_MOUNTS_DIRECTORY_NAME).
const MOUNTS_FOLDER_NAME = 'mounts';

/** The project's top-level mounts/ row, if the tree lists one. */
export function findMountsFolderRow(files: FileTreeNode[]): FileTreeNode | null {
  return files.find((node) => node.type === 'directory' && node.name === MOUNTS_FOLDER_NAME) ?? null;
}

/**
 * The path of mounts/ while the project has mounts, or null. It then holds only the links and
 * their ignore file: nothing is created, uploaded, renamed or deleted in it, and the server
 * refuses to rename or delete it. A mount listed in it says so; when every link is gone from
 * disk nothing is listed, and the project's registered mounts say so instead.
 */
export function findMountsFolderPath(files: FileTreeNode[], hasRegisteredMounts: boolean): string | null {
  const folder = findMountsFolderRow(files);
  if (!folder) {
    return null;
  }
  return hasRegisteredMounts || folder.children?.some((child) => Boolean(child.mount)) ? folder.path : null;
}

const MOUNT_STATUS_KEYS: Record<ProjectMountStatus, string> = {
  ok: 'fileTree.mounts.status.ok',
  'missing-link': 'fileTree.mounts.status.missingLink',
  'link-mismatch': 'fileTree.mounts.status.linkMismatch',
  'missing-target': 'fileTree.mounts.status.missingTarget',
  'not-directory': 'fileTree.mounts.status.notDirectory',
  'not-ignored': 'fileTree.mounts.status.notIgnored',
};

/** A mount's status in words, for the mount dialog's rows and a mount node's tooltip. */
export function describeMountStatus(status: ProjectMountStatus, t: TFunction): string {
  return t(MOUNT_STATUS_KEYS[status] ?? MOUNT_STATUS_KEYS['missing-link']);
}

export function filterFileTree(items: FileTreeNode[], query: string): FileTreeNode[] {
  return items.reduce<FileTreeNode[]>((filteredItems, item) => {
    const matchesName = item.name.toLowerCase().includes(query);
    const filteredChildren =
      item.type === 'directory' && item.children ? filterFileTree(item.children, query) : [];

    if (matchesName || filteredChildren.length > 0) {
      filteredItems.push({
        ...item,
        children: filteredChildren,
      });
    }

    return filteredItems;
  }, []);
}

// During search we auto-expand every directory present in the filtered subtree.
export function collectExpandedDirectoryPaths(items: FileTreeNode[]): string[] {
  const paths: string[] = [];

  const visit = (nodes: FileTreeNode[]) => {
    nodes.forEach((node) => {
      if (node.type === 'directory' && node.children && node.children.length > 0) {
        paths.push(node.path);
        visit(node.children);
      }
    });
  };

  visit(items);
  return paths;
}

export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes === 0) {
    return '0 B';
  }

  const base = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const index = Math.floor(Math.log(bytes) / Math.log(base));

  return `${(bytes / Math.pow(base, index)).toFixed(1).replace(/\.0$/, '')} ${sizes[index]}`;
}

export function formatRelativeTime(date: string | undefined, t: TFunction): string {
  if (!date) {
    return '-';
  }

  const now = new Date();
  const past = new Date(date);
  const diffInSeconds = Math.floor((now.getTime() - past.getTime()) / 1000);

  if (diffInSeconds < 60) {
    return t('fileTree.justNow');
  }

  if (diffInSeconds < 3600) {
    return t('fileTree.minAgo', { count: Math.floor(diffInSeconds / 60) });
  }

  if (diffInSeconds < 86400) {
    return t('fileTree.hoursAgo', { count: Math.floor(diffInSeconds / 3600) });
  }

  if (diffInSeconds < 2592000) {
    return t('fileTree.daysAgo', { count: Math.floor(diffInSeconds / 86400) });
  }

  return past.toLocaleDateString();
}

export function isImageFile(filename: string): boolean {
  const extension = filename.split('.').pop()?.toLowerCase();
  return Boolean(extension && IMAGE_FILE_EXTENSIONS.has(extension));
}

