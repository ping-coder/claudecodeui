import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { Project,FileTreeNode } from '@/shared/types';

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  /** The first load of a project's tree: nothing to show yet. */
  loading: boolean;
  /** A reload of a tree already on screen, which stays up meanwhile. */
  refreshing: boolean;
  error: string | null;
  /** Lists the tree again after a change made here, which the server already knows of. */
  refreshFiles: () => void;
  /**
   * Lists the tree again because the user asked to: the server walks the mounts on network shares
   * again too, rather than answer with their last walk.
   */
  refreshFilesFresh: () => void;
};

const DEFAULT_LOAD_ERROR = 'Unable to load the file tree for this project.';

// The API reports refusals such as FILE_TREE_TOO_LARGE as { error: message }.
// Surfacing that message tells the user why the tree is missing and what to do
// about it, instead of leaving them with an unexplained empty tree.
function readResponseErrorMessage(responseBody: string): string | null {
  try {
    const parsedBody = JSON.parse(responseBody) as unknown;
    const message = typeof parsedBody === 'object' && parsedBody !== null && 'error' in parsedBody
      ? (parsedBody as { error: unknown }).error
      : null;
    return typeof message === 'string' && message.trim() ? message : null;
  } catch {
    return null;
  }
}

type UseFileTreeDataOptions = {
  /** The first listing is fresh, as refreshFilesFresh's are: set when a refresh landed while the tree was not on screen. */
  freshFirstLoad?: boolean;
};

export function useFileTreeData(
  selectedProject: Project | null,
  { freshFirstLoad = false }: UseFileTreeDataOptions = {},
): UseFileTreeDataResult {
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  // A reload behind a tree already shown: the header's refresh icon spins while the rows, an open
  // rename or new-item box and the scroll position stay where they are.
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  // The project whose tree is on screen; a reload of that same project keeps it up instead of the loading state.
  const shownProjectIdRef = useRef<string | null>(null);
  // Whether the next listing is one the user asked for (refreshFilesFresh), or the first one after a refresh
  // the tree missed.
  const freshRequestedRef = useRef(freshFirstLoad);

  const refreshFiles = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  const refreshFilesFresh = useCallback(() => {
    freshRequestedRef.current = true;
    setRefreshKey((prev) => prev + 1);
  }, []);

  useEffect(() => {
    // File-tree requests use the DB projectId; the backend resolves it to the
    // project's absolute path through the projects table.
    const projectId = selectedProject?.projectId;

    if (!projectId) {
      shownProjectIdRef.current = null;
      freshRequestedRef.current = false;
      setFiles([]);
      setLoading(false);
      setRefreshing(false);
      setError(null);
      return;
    }
    const isReload = shownProjectIdRef.current === projectId;
    const fresh = freshRequestedRef.current;
    freshRequestedRef.current = false;

    // Abort previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    // Track mount state so aborted or late responses do not enqueue stale state updates.
    let isActive = true;
    // A fresh listing cut short before the server answered (StrictMode's second mount run, or a reload
    // right behind it) leaves the next listing fresh instead.
    let answered = false;

    const fetchFiles = async () => {
      if (isActive) {
        if (isReload) {
          setRefreshing(true);
        } else {
          setLoading(true);
          setError(null);
        }
      }
      try {
        // Gitignored entries come back greyed out rather than missing, so files
        // such as CLAUDE.md stay reachable from the explorer.
        const response = await api.getFiles(
          projectId,
          { markIgnored: true, fresh },
          { signal: abortControllerRef.current!.signal },
        );
        answered = true;

        if (!response.ok) {
          const errorText = await response.text();
          console.error('File fetch failed:', response.status, errorText);
          if (isActive) {
            shownProjectIdRef.current = null;
            setFiles([]);
            setError(readResponseErrorMessage(errorText) ?? DEFAULT_LOAD_ERROR);
          }
          return;
        }

        const data = (await response.json()) as FileTreeNode[];
        if (isActive) {
          shownProjectIdRef.current = projectId;
          setFiles(data);
          setError(null);
        }
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') {
          return;
        }

        console.error('Error fetching files:', error);
        if (isActive) {
          shownProjectIdRef.current = null;
          setFiles([]);
          setError(DEFAULT_LOAD_ERROR);
        }
      } finally {
        if (isActive) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    };

    void fetchFiles();

    return () => {
      isActive = false;
      abortControllerRef.current?.abort();
      if (fresh && !answered) {
        freshRequestedRef.current = true;
      }
    };
  }, [selectedProject?.projectId, refreshKey]);

  return {
    files,
    loading,
    refreshing,
    error,
    refreshFiles,
    refreshFilesFresh,
  };
}
