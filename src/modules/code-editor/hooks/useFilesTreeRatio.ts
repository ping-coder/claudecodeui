import { useCallback, useState } from 'react';

import { FILES_TREE_RATIO_DEFAULT } from '@/shared/constants';

/** localStorage key of the file tree's share in the Files view. */
const FILES_TREE_RATIO_STORAGE_KEY = 'files-tree-ratio';

/** A stored share that is missing, unparseable or not strictly between 0 and 1 falls back to the default. */
const parseStoredRatio = (raw: string | null): number => {
  // Number(), not parseFloat(): the latter takes a numeric prefix, so '0.4px' would pass.
  const value = raw !== null && raw.trim() !== '' ? Number(raw) : Number.NaN;
  return Number.isFinite(value) && value > 0 && value < 1 ? value : FILES_TREE_RATIO_DEFAULT;
};

const readStoredRatio = (): number => {
  try {
    return parseStoredRatio(window.localStorage.getItem(FILES_TREE_RATIO_STORAGE_KEY));
  } catch {
    return FILES_TREE_RATIO_DEFAULT;
  }
};

/**
 * The file tree's share of the pane beside a docked editor in the Files view, persisted across reloads.
 * Read once per mount: a pane picks up a share another pane saved the next time it mounts.
 */
export function useFilesTreeRatio() {
  // The committed share; a drag only rewrites a CSS variable and lands here once, on release.
  const [ratio, setRatio] = useState<number>(readStoredRatio);

  const commitRatio = useCallback((next: number) => {
    setRatio(next);
    try {
      window.localStorage.setItem(FILES_TREE_RATIO_STORAGE_KEY, String(next));
    } catch {
      // Storage unavailable: the share just stops persisting.
    }
  }, []);

  return { ratio, commitRatio };
}
