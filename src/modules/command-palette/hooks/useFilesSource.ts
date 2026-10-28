import { api } from '@/shared/api';
import { useApiSource } from '@/modules/command-palette/hooks/useApiSource';
import type { FileTreeNode } from '@/shared/types';

export type FileResult = {
  path: string;
  name: string;
  // Relative to the project root. The palette matches and shows this rather
  // than `path`: a query that hits the prefix every absolute path shares (the
  // project folder's name, say) would match all files alike.
  relativePath: string;
  // Matches the project's .gitignore: searchable, but not listed unprompted.
  isIgnored: boolean;
};

const MAX_FILES = 500;

/**
 * Collects files one tree level at a time, so the root files people look for
 * most (CLAUDE.md, package.json) are in before one deep folder can use up the
 * whole budget.
 */
function collectFiles(tree: FileTreeNode[]): FileResult[] {
  const files: FileResult[] = [];
  let level = tree.map((node) => ({ node, relativePath: node.name }));

  while (level.length > 0 && files.length < MAX_FILES) {
    const nextLevel: typeof level = [];
    for (const { node, relativePath } of level) {
      if (node.type === 'file') {
        files.push({ path: node.path, name: node.name, relativePath, isIgnored: node.isIgnored === true });
        if (files.length >= MAX_FILES) break;
      } else {
        for (const child of node.children ?? []) {
          nextLevel.push({ node: child, relativePath: `${relativePath}/${child.name}` });
        }
      }
    }
    level = nextLevel;
  }

  return files;
}

export function useFilesSource(projectId: string | undefined, enabled: boolean) {
  return useApiSource<FileResult, unknown>({
    enabled: enabled && !!projectId,
    deps: [projectId],
    fetcher: (signal) => api.getFiles(projectId!, { markIgnored: true }, { signal }),
    parse: (data) => collectFiles(Array.isArray(data) ? (data as FileTreeNode[]) : []),
  });
}
