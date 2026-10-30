import { api } from '@/shared/api';
import { useApiSource } from '@/modules/command-palette/hooks/useApiSource';
import type { CommandPaletteFile, FileTreeNode } from '@/shared/types';

// The file tree answers 413 (FILE_TREE_TOO_LARGE) for a project of more than 10,000 entries.
const FILE_TREE_TOO_LARGE_STATUS = 413;

/**
 * Lists every file one tree level at a time, so root files (CLAUDE.md,
 * package.json) come first: they lead the list before anything is typed and
 * win ties when a search scores files alike. The server's entry caps bound the
 * list, so it needs no cap of its own. A mount's files are left out: they live
 * in a folder outside the project, often a large one.
 */
function collectFiles(tree: FileTreeNode[]): CommandPaletteFile[] {
  const files: CommandPaletteFile[] = [];
  let level = tree.map((node) => ({ node, relativePath: node.name }));

  while (level.length > 0) {
    const nextLevel: typeof level = [];
    for (const { node, relativePath } of level) {
      if (node.type === 'file') {
        files.push({ path: node.path, name: node.name, relativePath, isIgnored: node.isIgnored === true });
      } else if (!node.mount) {
        for (const child of node.children ?? []) {
          nextLevel.push({ node: child, relativePath: `${relativePath}/${child.name}` });
        }
      }
    }
    level = nextLevel;
  }

  return files;
}

/** Every file of the project, and whether the server refused to list them because the project is too large. */
export function useFilesSource(projectId: string | undefined, enabled: boolean) {
  const { items, status } = useApiSource<CommandPaletteFile, unknown>({
    enabled: enabled && !!projectId,
    deps: [projectId],
    fetcher: (signal) => api.getFiles(projectId!, { markIgnored: true }, { signal }),
    parse: (data) => collectFiles(Array.isArray(data) ? (data as FileTreeNode[]) : []),
  });
  return { files: items, tooLarge: status === FILE_TREE_TOO_LARGE_STATUS };
}
