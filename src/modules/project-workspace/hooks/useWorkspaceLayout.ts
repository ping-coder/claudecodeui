import { useCallback, useEffect, useRef, useState } from 'react';

import { WORKSPACE_LAYOUT_STORAGE_KEY } from '@/shared/constants';
import type { AppTab, WorkspaceLayout } from '@/shared/types';
import {
  createInitialLayout,
  isWorkspaceView,
  layoutHasSession,
  parseStoredLayout,
  serializeLayout,
} from '@/modules/project-workspace/utils/workspaceLayout';

type UseWorkspaceLayoutArgs = {
  /** Session id in the URL when the page loads; decides whether the localStorage seed applies. */
  initialSessionId?: string;
};

/** The single app-wide view the pre-split workspace remembered in localStorage. */
const LEGACY_ACTIVE_TAB_STORAGE_KEY = 'activeTab';

/** Storage writes wait this long, so a burst of tab switches writes once. */
const LAYOUT_WRITE_DELAY_MS = 300;

type LayoutStore = 'sessionStorage' | 'localStorage';

/** Storage can throw (disabled storage, sandboxed frames); the layout then simply lives in memory. */
const readStoredLayout = (store: LayoutStore): string | null => {
  try {
    return window[store].getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
  } catch {
    return null;
  }
};

/**
 * Writes this browser tab's own copy (sessionStorage) and, when `includeSeed`, the seed new pages start
 * from (localStorage).
 */
const writeStoredLayout = (layout: WorkspaceLayout, includeSeed: boolean): void => {
  const raw = JSON.stringify(serializeLayout(layout));
  const stores: LayoutStore[] = includeSeed ? ['sessionStorage', 'localStorage'] : ['sessionStorage'];
  for (const store of stores) {
    try {
      window[store].setItem(WORKSPACE_LAYOUT_STORAGE_KEY, raw);
    } catch {
      // Quota or disabled storage: keep the in-memory layout.
    }
  }
};

/**
 * 1. sessionStorage: this browser tab's own layout (a refresh).
 * 2. localStorage, when the URL names no session or one the seed holds (the browser reopened).
 * 3. Otherwise (a Ctrl/Cmd+click into a new browser tab, an external deep link) one empty pane,
 *    which the URL sync then opens the session in, instead of importing another tab's layout.
 */
const readInitialLayout = (initialSessionId?: string): WorkspaceLayout => {
  const own = parseStoredLayout(readStoredLayout('sessionStorage'));
  if (own) {
    return own;
  }
  const seed = parseStoredLayout(readStoredLayout('localStorage'));
  if (seed && (!initialSessionId || layoutHasSession(seed, initialSessionId))) {
    return seed;
  }
  return createInitialLayout();
};

/** Tab keys made in this page; with the time and a random part, never equal to a restored key. */
let createdTabKeyCount = 0;

/** A key for a new tab; stable for the tab's life and unique across reloads. */
const createTabKey = (): string => {
  createdTabKeyCount += 1;
  return `tab-${Date.now().toString(36)}-${createdTabKeyCount.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
};

/** Pane ids made in this page; never repeated, so a pane created later never takes over an earlier pane's chat. */
let createdPaneIdCount = 0;

/** An id for a pane a layout change may create (WorkspacePaneState.id); never equal to the ids a page starts with. */
const createPaneId = (): string => {
  createdPaneIdCount += 1;
  return `pane-new-${createdPaneIdCount.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
};

/**
 * Hands the pre-split app-wide view to the first tab an empty layout creates, once: the key is
 * deleted on read, valid or not.
 */
const takeLegacyView = (): AppTab | undefined => {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(LEGACY_ACTIVE_TAB_STORAGE_KEY);
    if (stored !== null) {
      window.localStorage.removeItem(LEGACY_ACTIVE_TAB_STORAGE_KEY);
    }
  } catch {
    return undefined;
  }
  return isWorkspaceView(stored) ? stored : undefined;
};

/**
 * Owns the workspace layout and its persistence. useWorkspaceNavigation's commit is its only
 * writer: it reads `layoutRef`, runs the reducer and hands the result to `setLayout`.
 */
export function useWorkspaceLayout({ initialSessionId }: UseWorkspaceLayoutArgs) {
  // What each pane shows; the single source of truth the whole workspace renders from.
  const [layout, setLayoutState] = useState<WorkspaceLayout>(() => readInitialLayout(initialSessionId));
  // Mirror of `layout` that commit reads and writes synchronously, so several actions in one tick
  // (a click and a websocket frame, say) each build on the previous result rather than on the last render.
  const layoutRef = useRef(layout);
  // Whether the layout changed since it was last written. The layout a page starts with is never
  // written back.
  const hasUnsavedChangesRef = useRef(false);
  // Whether this page may write the localStorage seed: only once the user changed the layout. What the
  // page does on its own (opening the URL's session, restoring rows, resolving tabs) stays in its own
  // sessionStorage, so a deep link opened in a new browser tab leaves the shared seed alone.
  const isSeedWritableRef = useRef(false);

  /** `byUser: false` marks a change the page made on its own; it does not unlock the seed. */
  const setLayout = useCallback((next: WorkspaceLayout, { byUser = true }: { byUser?: boolean } = {}) => {
    if (next === layoutRef.current) {
      return;
    }
    layoutRef.current = next;
    hasUnsavedChangesRef.current = true;
    if (byUser) {
      isSeedWritableRef.current = true;
    }
    setLayoutState(next);
  }, []);

  useEffect(() => {
    if (!hasUnsavedChangesRef.current) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      hasUnsavedChangesRef.current = false;
      writeStoredLayout(layoutRef.current, isSeedWritableRef.current);
    }, LAYOUT_WRITE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [layout]);

  // A closing or refreshing page cannot wait for the debounce.
  useEffect(() => {
    const flush = () => {
      if (!hasUnsavedChangesRef.current) {
        return;
      }
      hasUnsavedChangesRef.current = false;
      writeStoredLayout(layoutRef.current, isSeedWritableRef.current);
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  return { layout, layoutRef, setLayout, createTabKey, createPaneId, takeLegacyView };
}
