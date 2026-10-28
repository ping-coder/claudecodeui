import { useCallback, useRef } from 'react';

import { api } from '@/shared/api';
import type { FileTreeNode, Project } from '@/shared/types';

type FlatFile = {
  name: string;
  path: string;
  // Relative to the project root (`src/foo.ts`), joined from node names. A
  // suffix match on it stays inside the project, unlike one on `path`.
  relativePath: string;
  // Directories between the project root and the file; 0 for a root file.
  depth: number;
};

// `diffInfo` is intentionally `any` so this resolver can wrap editor handlers
// that expect a concrete diff payload type as well as generic callers.
type OnFileOpen = (filePath: string, diffInfo?: any, line?: number | null) => void;

const normalize = (value: string): string => value.replace(/\\/g, '/');

// Backslashes are already normalized above, so a Windows path arrives as
// `C:/…`; counting it as absolute lets a Windows server resolve it as-is and a
// POSIX one answer an honest 404 instead of opening some other file.
const isAbsoluteRef = (value: string): boolean => /^(\/|[A-Za-z]:\/)/.test(value);

const flatten = (nodes: FileTreeNode[], out: FlatFile[], parentPath = '', depth = 0): void => {
  for (const node of nodes) {
    const relativePath = parentPath ? `${parentPath}/${node.name}` : node.name;
    if (node.type === 'file') {
      out.push({ name: node.name, path: node.path, relativePath, depth });
    } else if (node.children && node.children.length > 0) {
      flatten(node.children, out, relativePath, depth + 1);
    }
  }
};

// The tree lists directories before files and is flattened depth first, so the
// first file that fits is often a nested namesake: `README.md` used to open
// `deploy/peace-cc/README.md` rather than the root one. The file nearest the
// root wins instead; among equally deep files, tree order still decides.
const findShallowest = (
  files: FlatFile[],
  isMatch: (file: FlatFile) => boolean,
): FlatFile | undefined => {
  let shallowest: FlatFile | undefined;
  for (const file of files) {
    // Strictly shallower only, so a later file never displaces an equally deep one.
    if (isMatch(file) && (!shallowest || file.depth < shallowest.depth)) {
      shallowest = file;
    }
  }
  return shallowest;
};

// Whole segments only: `foo.ts` ends `src/foo.ts` but not `src/xfoo.ts`.
const endsWithPath = (filePath: string, target: string): boolean =>
  filePath === target || filePath.endsWith(`/${target}`);

// References inside chat messages are often bare basenames (`foo.ts`) or partial
// paths (`utils/foo.ts`) rather than full paths. Each step below takes the
// shallowest candidate: a suffix of the project-relative path, then a suffix of
// the absolute path, then the filename alone.
const findBestMatch = (files: FlatFile[], ref: string): string | null => {
  const target = normalize(ref).replace(/^\.\//, '').replace(/^\/+/, '');
  if (!target) {
    return null;
  }

  // On absolute paths the project folder's own name can match: in a project
  // named `tokio`, `tokio/Cargo.toml` fits the root `Cargo.toml` as well as the
  // crate's, and the root one is shallower. So absolute paths are tried only
  // when no relative path fits, which keeps references that start with the
  // project folder's name (`claudecodeui/src/foo.ts`) working.
  const suffixMatch =
    findShallowest(files, (file) => endsWithPath(file.relativePath, target))
    ?? findShallowest(files, (file) => endsWithPath(normalize(file.path), target));
  if (suffixMatch) {
    return suffixMatch.path;
  }

  const base = target.split('/').pop() || target;
  return findShallowest(files, (file) => file.name === base)?.path ?? null;
};

/**
 * Wraps an `onFileOpen` handler so a possibly bare/partial file reference is
 * resolved against the project's file tree (cached per project) before the file
 * is opened in the in-app editor.
 */
export function useFileOpenResolver(
  selectedProject: Project | null | undefined,
  onFileOpen: OnFileOpen,
): OnFileOpen {
  const projectId = selectedProject?.projectId;
  const cacheRef = useRef<{ projectId?: string; files: Promise<FlatFile[]> | null }>({
    projectId: undefined,
    files: null,
  });

  const loadFiles = useCallback((): Promise<FlatFile[]> => {
    if (!projectId) {
      return Promise.resolve([]);
    }
    if (cacheRef.current.projectId === projectId && cacheRef.current.files) {
      return cacheRef.current.files;
    }

    const filesPromise = (async () => {
      try {
        const response = await api.getFiles(projectId);
        if (!response.ok) {
          return [];
        }
        const data = await response.json();
        const tree: FileTreeNode[] = Array.isArray(data) ? data : [];
        const flat: FlatFile[] = [];
        flatten(tree, flat);
        return flat;
      } catch {
        return [];
      }
    })();

    cacheRef.current = { projectId, files: filesPromise };
    return filesPromise;
  }, [projectId]);

  return useCallback(
    (filePath: string, diffInfo?: any, line?: number | null) => {
      // Normalized once and used for every outcome: a reference picked up from
      // link text can carry surrounding whitespace, which the API would take as
      // part of the filename and answer with a 404.
      const ref = normalize(filePath).trim();
      // An absolute path already names one exact file: matching it against the
      // tree can only send it somewhere else — `/home/user/.config/NOTES.md`
      // used to fall through to the filename match and silently open the
      // project's own `NOTES.md`. A path that exists is unaffected; one that no
      // longer does now reports that instead of opening a same-named file.
      if (isAbsoluteRef(ref)) {
        onFileOpen(ref, diffInfo, line);
        return;
      }
      void loadFiles().then((files) => {
        const match = findBestMatch(files, ref);
        onFileOpen(match ?? ref, diffInfo, line);
      });
    },
    [loadFiles, onFileOpen],
  );
}
