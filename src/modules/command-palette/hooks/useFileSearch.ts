import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { CommandPaletteFile } from '@/shared/types';

/** What the palette knows of the server's search for what is typed now. */
type FileSearchState = {
  /**
   * The best matches of the latest answer, best first. While the next search runs they stay, for
   * the palette to narrow by what is typed now; they never outlive their project.
   */
  files: CommandPaletteFile[];
  /** The server stopped at its entry or time limit, so part of the project was not searched. */
  incomplete: boolean;
  /** 'pending' from the first keystroke until the answer for what is typed arrives. */
  status: 'idle' | 'pending' | 'done' | 'failed';
};

/** The server's latest answer, with the search it answers. */
type FileSearchAnswer = {
  projectId: string;
  search: string;
  limit: number;
  files: CommandPaletteFile[];
  incomplete: boolean;
  failed: boolean;
};

const NO_FILES: CommandPaletteFile[] = [];

const IDLE: FileSearchState = { files: NO_FILES, incomplete: false, status: 'idle' };

/** Waits out a burst of keystrokes, since every search walks the project on the server. */
const FILE_SEARCH_DEBOUNCE_MS = 250;

const isCommandPaletteFile = (value: unknown): value is CommandPaletteFile => {
  const file = value as Partial<Record<keyof CommandPaletteFile, unknown>> | null;
  return typeof file?.path === 'string' && typeof file.name === 'string' && typeof file.relativePath === 'string';
};

/** Reads the search endpoint's `{ files, incomplete }`, keeping only well-formed files. */
function parseFileSearch(body: unknown): Pick<FileSearchAnswer, 'files' | 'incomplete'> {
  const { files, incomplete } = (body ?? {}) as Record<string, unknown>;
  return {
    files: Array.isArray(files)
      ? files.filter(isCommandPaletteFile).map(({ path, name, relativePath, isIgnored }) => ({
        path,
        name,
        relativePath,
        isIgnored: isIgnored === true,
      }))
      : NO_FILES,
    incomplete: incomplete === true,
  };
}

/**
 * Searches the files of a project too large to list, on the server, once the search has rested
 * for FILE_SEARCH_DEBOUNCE_MS: its best `limit` matches, and whether only part of the project was
 * searched. A newer search aborts the request of the one it replaces. Used by CommandPalette.
 */
export function useFileSearch(
  projectId: string | undefined,
  search: string,
  enabled: boolean,
  limit: number,
): FileSearchState {
  // The latest answer. Rendering compares the search it answers with the current one, so a
  // search still waiting for its answer reads as pending without a state update of its own.
  const [answer, setAnswer] = useState<FileSearchAnswer | null>(null);
  const isActive = enabled && Boolean(projectId) && search.trim() !== '';

  useEffect(() => {
    if (!isActive || !projectId) {
      return undefined;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        let result: Pick<FileSearchAnswer, 'files' | 'incomplete' | 'failed'>;
        try {
          const response = await api.searchFiles(projectId, search, limit, { signal: controller.signal });
          if (!response.ok) {
            throw new Error(`File search failed (${response.status})`);
          }
          result = { ...parseFileSearch(await response.json()), failed: false };
        } catch {
          result = { files: NO_FILES, incomplete: false, failed: true };
        }
        if (!controller.signal.aborted) {
          setAnswer({ projectId, search, limit, ...result });
        }
      })();
    }, FILE_SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [isActive, projectId, search, limit]);

  if (!isActive || !answer || answer.projectId !== projectId) {
    return isActive ? { ...IDLE, status: 'pending' } : IDLE;
  }
  const isCurrent = answer.search === search && answer.limit === limit;
  return {
    files: answer.files,
    incomplete: answer.incomplete,
    status: !isCurrent ? 'pending' : answer.failed ? 'failed' : 'done',
  };
}
