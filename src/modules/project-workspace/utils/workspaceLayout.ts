import {
  WORKSPACE_PANE_SIDES,
  WORKSPACE_SPLIT_RATIO_DEFAULT,
  WORKSPACE_SPLIT_RATIO_MAX,
  WORKSPACE_SPLIT_RATIO_MIN,
} from '@/shared/constants';
import type {
  AppTab,
  LLMProvider,
  ProjectSession,
  SessionOpenTarget,
  SessionPanePlacement,
  WorkspaceLayout,
  WorkspacePaneSide,
  WorkspacePaneState,
  WorkspaceSessionTab,
} from '@/shared/types';
import { getOtherPaneSide as otherSide } from '@/shared/utils';

/**
 * The split workspace's pure layout reducer, its persistence format and the selectors
 * the workspace reads it through. useWorkspaceNavigation's commit is the only caller of
 * the reducer; it generates the keys of new tabs and the ids of new panes, so everything
 * here stays pure.
 */

/** A session being opened: the object handed to the chat plus the tab fields read off it. */
type OpenPayload = {
  session: ProjectSession;
  projectId: string;
  provider: LLMProvider;
  title: string;
};

/**
 * Every change the reducer understands. Deliberately file-local: other files derive it from
 * `workspaceLayoutReducer`'s signature, so the union has a single definition.
 */
type WorkspaceLayoutAction =
  // `focus: false` leaves the focused pane as it is (a late result opening in its own pane).
  | { type: 'open'; payload: OpenPayload; target: SessionOpenTarget; preview: boolean; view?: AppTab; focus?: boolean; newTabKey: string; newPaneId: string }
  | { type: 'openDraft'; projectId: string; provider: LLMProvider; target: SessionOpenTarget; view?: AppTab; newTabKey: string; newPaneId: string }
  // With draftTabKey only that draft converts; without it, the project's draft.
  | { type: 'establishDraft'; projectId: string; draftTabKey?: string; payload: OpenPayload }
  | { type: 'activate'; side: WorkspacePaneSide; tabKey: string }
  | { type: 'close'; side: WorkspacePaneSide; tabKey: string }
  | { type: 'closeOthers'; side: WorkspacePaneSide; tabKey: string }
  | { type: 'closeToRight'; side: WorkspacePaneSide; tabKey: string }
  // 'both': every tab of both panes in one change (the focused pane is the one left, empty).
  | { type: 'closeAll'; side: WorkspacePaneSide | 'both' }
  | { type: 'pin'; side: WorkspacePaneSide; tabKey: string }
  | { type: 'focus'; side: WorkspacePaneSide }
  | { type: 'split'; newPaneId: string }
  | { type: 'merge' }
  | { type: 'closePane'; side: WorkspacePaneSide }
  | { type: 'move'; from: WorkspacePaneSide; tabKey: string; to: WorkspacePaneSide; index?: number; copy?: boolean; newTabKey: string; newPaneId: string }
  | { type: 'setView'; side: WorkspacePaneSide; tabKey: string; view: AppTab; pin: boolean }
  | { type: 'patchSession'; sessionId: string; patch: Partial<ProjectSession>; dropSearchTarget?: boolean }
  | { type: 'replaceSessionId'; fromId: string; toId: string }
  | { type: 'removeSession'; sessionId: string }
  | { type: 'removeProject'; projectId: string }
  | { type: 'noteExternalUpdate'; sessionId: string }
  | { type: 'markMissing'; sessionId: string }
  | { type: 'pruneDrafts'; liveProjectIds: ReadonlySet<string> }
  | { type: 'setRatio'; ratio: number };

/** Tabs a pane keeps across reloads; at runtime a pane holds any number. */
const MAX_PERSISTED_TABS = 30;

/** The workspace views a tab may show besides plugin views. */
const BUILT_IN_VIEWS: ReadonlySet<string> = new Set(['chat', 'files', 'shell', 'git', 'tasks', 'browser']);

/** Whether a stored value names a workspace view; used to validate persisted tabs and the legacy 'activeTab' key. */
export const isWorkspaceView = (value: unknown): value is AppTab =>
  typeof value === 'string' && (BUILT_IN_VIEWS.has(value) || (value.startsWith('plugin:') && value.length > 'plugin:'.length));

/** Ids of the panes a page starts with. Never equal to the ids commit generates for the panes created later. */
const INITIAL_PANE_ID = 'pane-initial';
const RESTORED_LEFT_PANE_ID = 'pane-restored-left';
const RESTORED_RIGHT_PANE_ID = 'pane-restored-right';

const createEmptyPane = (id: string): WorkspacePaneState => ({
  id,
  tabs: [],
  activeTabKey: null,
  mru: [],
  draftActivation: 0,
  externalRevision: 0,
});

/** One empty, focused left pane at the default ratio: a fresh page with nothing open. */
export const createInitialLayout = (): WorkspaceLayout => ({
  left: createEmptyPane(INITIAL_PANE_ID),
  right: null,
  focusedSide: 'left',
  splitRatio: WORKSPACE_SPLIT_RATIO_DEFAULT,
});

const clampSplitRatio = (ratio: number): number => (
  Number.isFinite(ratio)
    ? Math.min(WORKSPACE_SPLIT_RATIO_MAX, Math.max(WORKSPACE_SPLIT_RATIO_MIN, ratio))
    : WORKSPACE_SPLIT_RATIO_DEFAULT
);

/** The pane on one side; null for the right side while unsplit. */
export const getPane = (layout: WorkspaceLayout, side: WorkspacePaneSide): WorkspacePaneState | null =>
  (side === 'left' ? layout.left : layout.right);

/** A pane's active tab; null for an empty or absent pane. */
export const getActiveTab = (pane: WorkspacePaneState | null): WorkspaceSessionTab | null =>
  pane?.tabs.find((tab) => tab.key === pane.activeTabKey) ?? null;

/** Whether no pane holds a tab: a fresh page, or everything was closed. */
export const isLayoutEmpty = (layout: WorkspaceLayout): boolean =>
  layout.left.tabs.length === 0 && (layout.right?.tabs.length ?? 0) === 0;

const withPane = (layout: WorkspaceLayout, side: WorkspacePaneSide, pane: WorkspacePaneState): WorkspaceLayout =>
  (side === 'left' ? { ...layout, left: pane } : { ...layout, right: pane });

/** The pane on `side`, created (with `newPaneId`) when that side has none; only the right side ever does. */
const ensurePane = (layout: WorkspaceLayout, side: WorkspacePaneSide, newPaneId: string): WorkspaceLayout =>
  (getPane(layout, side) ? layout : withPane(layout, side, createEmptyPane(newPaneId)));

const touchMru = (mru: string[], key: string): string[] => [key, ...mru.filter((candidate) => candidate !== key)];

const hasSearchTarget = (session: ProjectSession): boolean =>
  Boolean(session.__searchTargetSnippet || session.__searchTargetTimestamp);

const clampIndex = (index: number, length: number): number => Math.max(0, Math.min(index, length));

const resolveTargetSide = (layout: WorkspaceLayout, target: SessionOpenTarget): WorkspacePaneSide => {
  if (target === 'focused') {
    return layout.focusedSide;
  }
  return target === 'other' ? otherSide(layout.focusedSide) : target;
};

const findTab = (
  layout: WorkspaceLayout,
  match: (tab: WorkspaceSessionTab) => boolean,
): { side: WorkspacePaneSide; tab: WorkspaceSessionTab } | null => {
  for (const side of [layout.focusedSide, otherSide(layout.focusedSide)]) {
    const tab = getPane(layout, side)?.tabs.find(match);
    if (tab) {
      return { side, tab };
    }
  }
  return null;
};

/** Where a session is open, focused pane first; null when no tab holds it. */
export const findSessionTab = (
  layout: WorkspaceLayout,
  sessionId: string,
): { side: WorkspacePaneSide; tab: WorkspaceSessionTab } | null =>
  findTab(layout, (tab) => tab.sessionId === sessionId);

const isDraftOf = (projectId: string) => (tab: WorkspaceSessionTab): boolean =>
  tab.sessionId === null && tab.projectId === projectId;

/** A missing tab an open found again: it takes the open's session, project and provider and shows the conversation again. */
const reviveTab = (tab: WorkspaceSessionTab, payload: OpenPayload): WorkspaceSessionTab => {
  const { isMissing: _isMissing, ...rest } = tab;
  return {
    ...rest,
    session: payload.session,
    projectId: payload.projectId,
    provider: payload.provider,
    title: payload.title || tab.title,
  };
};

type ActivateOptions = {
  pin?: boolean;
  /** The session object an open hands over; a search target in it reaches the tab. */
  incoming?: ProjectSession;
  view?: AppTab;
  /** false leaves the focused pane as it is. Default true. */
  takesFocus?: boolean;
};

const activateInPane = (
  layout: WorkspaceLayout,
  side: WorkspacePaneSide,
  tabKey: string,
  options: ActivateOptions = {},
): WorkspaceLayout => {
  const pane = getPane(layout, side);
  const current = pane?.tabs.find((tab) => tab.key === tabKey);
  if (!pane || !current) {
    return layout;
  }

  const needsPin = Boolean(options.pin && current.isPreview);
  // A search hit re-opening an open session must still jump: the chat reads the target
  // off every new session identity, so the tab gets one carrying it.
  const incoming = options.incoming && hasSearchTarget(options.incoming) && current.session ? options.incoming : null;
  const view = options.view && options.view !== current.view ? options.view : null;
  const focusedSide = options.takesFocus === false ? layout.focusedSide : side;
  // Every click in a pane re-focuses it, so a no-op must keep the state object.
  if (layout.focusedSide === focusedSide && pane.activeTabKey === tabKey && !needsPin && !incoming && !view) {
    return layout;
  }

  const tabs = !needsPin && !incoming && !view
    ? pane.tabs
    : pane.tabs.map((tab) => {
      if (tab.key !== tabKey) {
        return tab;
      }
      const next: WorkspaceSessionTab = { ...tab };
      if (needsPin) {
        next.isPreview = false;
      }
      if (view) {
        next.view = view;
      }
      if (incoming && tab.session) {
        next.session = { ...tab.session, ...incoming };
      }
      return next;
    });
  const mru = pane.mru[0] === tabKey ? pane.mru : touchMru(pane.mru, tabKey);
  return withPane({ ...layout, focusedSide }, side, { ...pane, tabs, activeTabKey: tabKey, mru });
};

/**
 * Inserts a tab right of the active one (a preview replaces the pane's preview in place) and activates
 * it; its pane takes the focus unless `takesFocus` is false. A missing right pane is created with `newPaneId`.
 */
const insertTab = (
  layout: WorkspaceLayout,
  side: WorkspacePaneSide,
  tab: WorkspaceSessionTab,
  newPaneId: string,
  takesFocus = true,
): WorkspaceLayout => {
  const withTarget = ensurePane(layout, side, newPaneId);
  const pane = getPane(withTarget, side) as WorkspacePaneState;
  const previewIndex = tab.isPreview ? pane.tabs.findIndex((candidate) => candidate.isPreview) : -1;
  let tabs: WorkspaceSessionTab[];
  let mru = pane.mru;
  if (previewIndex >= 0) {
    const replacedKey = pane.tabs[previewIndex].key;
    tabs = pane.tabs.map((candidate, index) => (index === previewIndex ? tab : candidate));
    mru = mru.filter((key) => key !== replacedKey);
  } else {
    const activeIndex = pane.tabs.findIndex((candidate) => candidate.key === pane.activeTabKey);
    const insertAt = activeIndex >= 0 ? activeIndex + 1 : pane.tabs.length;
    tabs = [...pane.tabs.slice(0, insertAt), tab, ...pane.tabs.slice(insertAt)];
  }
  return withPane({ ...withTarget, focusedSide: takesFocus ? side : withTarget.focusedSide }, side, {
    ...pane,
    tabs,
    activeTabKey: tab.key,
    mru: touchMru(mru, tab.key),
  });
};

/**
 * A pane whose last tab is gone closes; an emptied left pane hands its place to the right one, which
 * keeps its id and counters: its chat moves along with it (ProjectMainRegion keys panes by id).
 */
const dropEmptyPane = (layout: WorkspaceLayout, side: WorkspacePaneSide): WorkspaceLayout => {
  const pane = getPane(layout, side);
  if (!pane || pane.tabs.length > 0) {
    return layout;
  }
  if (side === 'right') {
    return { ...layout, right: null, focusedSide: 'left' };
  }
  if (layout.right) {
    return { ...layout, left: layout.right, right: null, focusedSide: 'left' };
  }
  return layout;
};

/** Removes matching tabs from one pane; a closed active tab falls back to the most recently used one. */
const removeTabs = (
  layout: WorkspaceLayout,
  side: WorkspacePaneSide,
  shouldRemove: (tab: WorkspaceSessionTab, index: number) => boolean,
): WorkspaceLayout => {
  const pane = getPane(layout, side);
  if (!pane) {
    return layout;
  }
  const removed = new Set(pane.tabs.filter(shouldRemove).map((tab) => tab.key));
  if (removed.size === 0) {
    return layout;
  }
  const tabs = pane.tabs.filter((tab) => !removed.has(tab.key));
  const mru = pane.mru.filter((key) => !removed.has(key));
  let activeTabKey = pane.activeTabKey;
  if (activeTabKey && removed.has(activeTabKey)) {
    const closedIndex = pane.tabs.findIndex((tab) => tab.key === activeTabKey);
    activeTabKey = mru[0] ?? tabs[Math.min(closedIndex, tabs.length - 1)]?.key ?? null;
  }
  return dropEmptyPane(withPane(layout, side, { ...pane, tabs, mru, activeTabKey }), side);
};

/** Maps every tab of both panes; panes (and the layout) whose tabs all come back unchanged keep their identity. */
const mapAllTabs = (layout: WorkspaceLayout, map: (tab: WorkspaceSessionTab) => WorkspaceSessionTab): WorkspaceLayout => {
  let changed = false;
  const mapPane = (pane: WorkspacePaneState | null): WorkspacePaneState | null => {
    if (!pane) {
      return pane;
    }
    let paneChanged = false;
    const tabs = pane.tabs.map((tab) => {
      const next = map(tab);
      if (next !== tab) {
        paneChanged = true;
      }
      return next;
    });
    if (!paneChanged) {
      return pane;
    }
    changed = true;
    return { ...pane, tabs };
  };
  const left = mapPane(layout.left) as WorkspacePaneState;
  const right = mapPane(layout.right);
  return changed ? { ...layout, left, right } : layout;
};

/** Keeps one tab per session in a pane (an alias rewrite can leave two), preferring the tab on screen. */
const dedupePaneSessions = (layout: WorkspaceLayout, side: WorkspacePaneSide): WorkspaceLayout => {
  const pane = getPane(layout, side);
  if (!pane) {
    return layout;
  }
  const activeSessionId = getActiveTab(pane)?.sessionId ?? null;
  const seen = new Set<string>();
  return removeTabs(layout, side, (tab) => {
    if (!tab.sessionId) {
      return false;
    }
    if (tab.sessionId === activeSessionId) {
      return tab.key !== pane.activeTabKey;
    }
    if (seen.has(tab.sessionId)) {
      return true;
    }
    seen.add(tab.sessionId);
    return false;
  });
};

const createSessionTab = (payload: OpenPayload, key: string, preview: boolean, view: AppTab = 'chat'): WorkspaceSessionTab => ({
  key,
  sessionId: payload.session.id,
  projectId: payload.projectId,
  provider: payload.provider,
  title: payload.title,
  view,
  isPreview: preview,
  session: payload.session,
});

const moveTab = (
  layout: WorkspaceLayout,
  from: WorkspacePaneSide,
  tabKey: string,
  to: WorkspacePaneSide,
  index: number | undefined,
  copy: boolean,
  newTabKey: string,
  newPaneId: string,
): WorkspaceLayout => {
  const source = getPane(layout, from);
  const tab = source?.tabs.find((candidate) => candidate.key === tabKey);
  if (!source || !tab) {
    return layout;
  }

  // Dragging a tab is a deliberate act, so the tab is kept from now on.
  const kept = tab.isPreview ? { ...tab, isPreview: false } : tab;

  if (from === to) {
    const rest = source.tabs.filter((candidate) => candidate.key !== tabKey);
    const at = clampIndex(index ?? rest.length, rest.length);
    const tabs = [...rest.slice(0, at), kept, ...rest.slice(at)];
    if (tabs.every((candidate, position) => candidate === source.tabs[position])) {
      return layout;
    }
    return withPane(layout, from, { ...source, tabs });
  }

  // A draft has one home (one unsent chat per project), so copying it is a move.
  const isCopy = copy && tab.sessionId !== null;
  let next = ensurePane(layout, to, newPaneId);
  const destination = getPane(next, to) as WorkspacePaneState;
  const duplicate = destination.tabs.find((candidate) => (
    tab.sessionId ? candidate.sessionId === tab.sessionId : isDraftOf(tab.projectId)(candidate)
  ));
  if (duplicate) {
    next = activateInPane(next, to, duplicate.key, { pin: true });
  } else {
    const at = clampIndex(index ?? destination.tabs.length, destination.tabs.length);
    // A copy opens on Chat: a second Shell on the same session would fight over one terminal.
    const placed: WorkspaceSessionTab = isCopy ? { ...kept, key: newTabKey, view: 'chat' } : kept;
    next = withPane({ ...next, focusedSide: to }, to, {
      ...destination,
      tabs: [...destination.tabs.slice(0, at), placed, ...destination.tabs.slice(at)],
      activeTabKey: placed.key,
      mru: touchMru(destination.mru, placed.key),
    });
  }
  if (isCopy) {
    return next;
  }
  const afterRemoval = removeTabs(next, from, (candidate) => candidate.key === tabKey);
  // An emptied source pane closed, so the moved tab now lives in the only (left) pane.
  return afterRemoval.right === null && afterRemoval.focusedSide !== 'left'
    ? { ...afterRemoval, focusedSide: 'left' }
    : afterRemoval;
};

const omitSearchTarget = (session: ProjectSession): ProjectSession => {
  const { __searchTargetSnippet: _snippet, __searchTargetTimestamp: _timestamp, ...rest } = session;
  return rest as ProjectSession;
};

const sameValue = (left: unknown, right: unknown): boolean =>
  Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);

/** Merges the closing pane's tabs into the other one (no session or draft twice) and leaves a single pane. */
const closePane = (layout: WorkspaceLayout, side: WorkspacePaneSide): WorkspaceLayout => {
  if (!layout.right) {
    return layout;
  }
  const survivor = getPane(layout, otherSide(side)) as WorkspacePaneState;
  const closing = getPane(layout, side) as WorkspacePaneState;
  const openSessionIds = new Set(survivor.tabs.map((tab) => tab.sessionId).filter(Boolean));
  const draftProjects = new Set(survivor.tabs.filter((tab) => tab.sessionId === null).map((tab) => tab.projectId));
  const incoming = closing.tabs
    .filter((tab) => (tab.sessionId ? !openSessionIds.has(tab.sessionId) : !draftProjects.has(tab.projectId)))
    .map((tab) => (tab.isPreview ? { ...tab, isPreview: false } : tab));
  const incomingKeys = new Set(incoming.map((tab) => tab.key));
  const closingActiveKey = closing.activeTabKey && incomingKeys.has(closing.activeTabKey) ? closing.activeTabKey : null;
  const merged: WorkspacePaneState = {
    ...survivor,
    tabs: [...survivor.tabs, ...incoming],
    activeTabKey: survivor.activeTabKey ?? closingActiveKey ?? incoming[0]?.key ?? null,
    // The closing pane's recency order follows the survivor's, so a later close falls back sensibly.
    mru: [
      ...survivor.mru,
      ...closing.mru.filter((key) => incomingKeys.has(key)),
      ...incoming.map((tab) => tab.key).filter((key) => !closing.mru.includes(key)),
    ],
  };
  return { ...layout, left: merged, right: null, focusedSide: 'left' };
};

/**
 * Merge (toggleSplit): one pane holding the left tabs, then the right ones, with no session or draft
 * twice. The focused pane is the one that stays (its id, counters, active tab and recency order), so the
 * chat and editor the user works in survive and keep showing what they showed; an empty focused pane
 * gives way to the other one when that one has tabs. With no tabs on either side the left pane stays: a
 * right pane never stays empty once it showed something (its last tab closing closes it), so only the
 * left one can hold a chat and an editor, kept hidden. Of a duplicated session the staying pane's tab is kept.
 */
const mergePanes = (layout: WorkspaceLayout): WorkspaceLayout => {
  if (!layout.right) {
    return layout;
  }
  const focusedPane = getPane(layout, layout.focusedSide) as WorkspacePaneState;
  const unfocusedPane = getPane(layout, otherSide(layout.focusedSide)) as WorkspacePaneState;
  let keptSide: WorkspacePaneSide = 'left';
  if (focusedPane.tabs.length > 0) {
    keptSide = layout.focusedSide;
  } else if (unfocusedPane.tabs.length > 0) {
    keptSide = otherSide(layout.focusedSide);
  }
  const kept = getPane(layout, keptSide) as WorkspacePaneState;
  const other = getPane(layout, otherSide(keptSide)) as WorkspacePaneState;
  const keptSessionIds = new Set(kept.tabs.map((tab) => tab.sessionId).filter(Boolean));
  const keptDraftProjects = new Set(kept.tabs.filter((tab) => tab.sessionId === null).map((tab) => tab.projectId));
  // The other pane's preview turns into a kept tab: one pane holds at most one preview.
  const joining = other.tabs
    .filter((tab) => (tab.sessionId ? !keptSessionIds.has(tab.sessionId) : !keptDraftProjects.has(tab.projectId)))
    .map((tab) => (tab.isPreview ? { ...tab, isPreview: false } : tab));
  const joiningKeys = new Set(joining.map((tab) => tab.key));
  const tabs = keptSide === 'left' ? [...kept.tabs, ...joining] : [...joining, ...kept.tabs];
  const activeTabKey = kept.activeTabKey ?? (other.activeTabKey && joiningKeys.has(other.activeTabKey) ? other.activeTabKey : null) ?? tabs[0]?.key ?? null;
  // The other pane's recency order follows the kept one's, so a later close falls back sensibly.
  const mru = [
    ...kept.mru,
    ...other.mru.filter((key) => joiningKeys.has(key)),
    ...joining.map((tab) => tab.key).filter((key) => !other.mru.includes(key)),
  ];
  return { ...layout, left: { ...kept, tabs, activeTabKey, mru }, right: null, focusedSide: 'left' };
};

const reduceLayout = (layout: WorkspaceLayout, action: WorkspaceLayoutAction): WorkspaceLayout => {
  switch (action.type) {
    case 'open': {
      const sessionId = action.payload.session.id;
      const takesFocus = action.focus !== false;
      const revealOptions: ActivateOptions = { pin: !action.preview, incoming: action.payload.session, view: action.view, takesFocus };
      // An open that names the owning project proves the session is there: every tab of it flagged
      // missing takes the open's session and shows the conversation again.
      const revived = action.payload.projectId
        ? mapAllTabs(layout, (tab) => (tab.sessionId === sessionId && tab.isMissing ? reviveTab(tab, action.payload) : tab))
        : layout;
      // A plain open never duplicates: it goes wherever the session already is.
      if (action.target === 'focused') {
        const hit = findSessionTab(revived, sessionId);
        if (hit) {
          return activateInPane(revived, hit.side, hit.tab.key, revealOptions);
        }
      }
      const side = resolveTargetSide(revived, action.target);
      const existing = getPane(revived, side)?.tabs.find((tab) => tab.sessionId === sessionId);
      if (existing) {
        return activateInPane(revived, side, existing.key, revealOptions);
      }
      return insertTab(
        revived,
        side,
        createSessionTab(action.payload, action.newTabKey, action.preview, action.view),
        action.newPaneId,
        takesFocus,
      );
    }
    case 'openDraft': {
      const existing = findTab(layout, isDraftOf(action.projectId));
      if (existing) {
        if (action.target === 'focused') {
          return activateInPane(layout, existing.side, existing.tab.key, { view: action.view });
        }
        const side = resolveTargetSide(layout, action.target);
        if (existing.side === side) {
          return activateInPane(layout, side, existing.tab.key, { view: action.view });
        }
        // An explicit side moves the draft there: two panes never share a project's draft scope.
        const moved = moveTab(layout, existing.side, existing.tab.key, side, undefined, false, action.newTabKey, action.newPaneId);
        const movedHit = findTab(moved, (tab) => tab.key === existing.tab.key);
        return movedHit ? activateInPane(moved, movedHit.side, movedHit.tab.key, { view: action.view }) : moved;
      }
      const side = resolveTargetSide(layout, action.target);
      return insertTab(layout, side, {
        key: action.newTabKey,
        sessionId: null,
        projectId: action.projectId,
        provider: action.provider,
        title: '',
        view: action.view ?? 'chat',
        isPreview: false,
        session: null,
      }, action.newPaneId);
    }
    case 'establishDraft': {
      // The key of the draft that sent survives tab switches and moves to the other side; once that
      // draft is closed nothing converts, not even a newer draft of the same project.
      const isEstablishingDraft = action.draftTabKey
        ? (tab: WorkspaceSessionTab) => tab.key === action.draftTabKey && isDraftOf(action.projectId)(tab)
        : isDraftOf(action.projectId);
      const hit = findTab(layout, isEstablishingDraft);
      if (!hit) {
        return layout;
      }
      const pane = getPane(layout, hit.side) as WorkspacePaneState;
      return withPane(layout, hit.side, {
        ...pane,
        tabs: pane.tabs.map((tab) => (tab.key === hit.tab.key
          ? {
            ...tab,
            sessionId: action.payload.session.id,
            session: action.payload.session,
            provider: action.payload.provider,
            title: action.payload.title,
            isPreview: false,
          }
          : tab)),
      });
    }
    case 'activate':
      return activateInPane(layout, action.side, action.tabKey);
    case 'close':
      return removeTabs(layout, action.side, (tab) => tab.key === action.tabKey);
    case 'closeOthers':
      return getPane(layout, action.side)?.tabs.some((tab) => tab.key === action.tabKey)
        ? removeTabs(layout, action.side, (tab) => tab.key !== action.tabKey)
        : layout;
    case 'closeToRight': {
      const index = getPane(layout, action.side)?.tabs.findIndex((tab) => tab.key === action.tabKey) ?? -1;
      return index < 0 ? layout : removeTabs(layout, action.side, (_tab, tabIndex) => tabIndex > index);
    }
    case 'closeAll': {
      if (action.side !== 'both') {
        return removeTabs(layout, action.side, () => true);
      }
      // The unfocused side first: the focused pane is then the one left, empty, in the left slot, keeping
      // its chat and editor (an unsaved buffer too) mounted and hidden, as after its own last tab closed.
      const withoutUnfocused = removeTabs(layout, otherSide(layout.focusedSide), () => true);
      return removeTabs(withoutUnfocused, 'left', () => true);
    }
    case 'pin': {
      const pane = getPane(layout, action.side);
      if (!pane || !pane.tabs.some((tab) => tab.key === action.tabKey && tab.isPreview)) {
        return layout;
      }
      return withPane(layout, action.side, {
        ...pane,
        tabs: pane.tabs.map((tab) => (tab.key === action.tabKey ? { ...tab, isPreview: false } : tab)),
      });
    }
    case 'focus':
      return layout.focusedSide === action.side || !getPane(layout, action.side)
        ? layout
        : { ...layout, focusedSide: action.side };
    case 'split':
      return layout.right
        ? { ...layout, focusedSide: otherSide(layout.focusedSide) }
        : { ...layout, right: createEmptyPane(action.newPaneId), focusedSide: 'right' };
    case 'merge':
      return mergePanes(layout);
    case 'closePane':
      return closePane(layout, action.side);
    case 'move':
      return moveTab(
        layout,
        action.from,
        action.tabKey,
        action.to,
        action.index,
        Boolean(action.copy),
        action.newTabKey,
        action.newPaneId,
      );
    case 'setView': {
      const pane = getPane(layout, action.side);
      const tab = pane?.tabs.find((candidate) => candidate.key === action.tabKey);
      if (!pane || !tab || (tab.view === action.view && (!action.pin || !tab.isPreview))) {
        return layout;
      }
      return withPane(layout, action.side, {
        ...pane,
        tabs: pane.tabs.map((candidate) => (candidate.key === action.tabKey
          ? { ...candidate, view: action.view, isPreview: action.pin ? false : candidate.isPreview }
          : candidate)),
      });
    }
    case 'patchSession': {
      // A patch naming the owning project is an authoritative row (the loaded pages, a lookup, an
      // upsert): it settles the tab's project and provider, and a tab flagged missing shows again.
      const owner = typeof action.patch.__projectId === 'string' && action.patch.__projectId ? action.patch.__projectId : null;
      const ownerProvider = owner && typeof action.patch.__provider === 'string' && action.patch.__provider
        ? action.patch.__provider
        : null;
      return mapAllTabs(layout, (tab) => {
        if (tab.sessionId !== action.sessionId || !tab.session) {
          return tab;
        }
        const current = tab.session;
        const dropsTarget = Boolean(action.dropSearchTarget)
          && ('__searchTargetSnippet' in current || '__searchTargetTimestamp' in current);
        const changesFields = Object.entries(action.patch).some(([key, value]) => !sameValue(current[key], value));
        const relocates = owner !== null && owner !== tab.projectId;
        const reprovides = ownerProvider !== null && ownerProvider !== tab.provider;
        const revives = owner !== null && Boolean(tab.isMissing);
        // A refresh that brings nothing new keeps the session identity, so the chat does not react.
        if (!dropsTarget && !changesFields && !relocates && !reprovides && !revives) {
          return tab;
        }
        const base = dropsTarget ? omitSearchTarget(current) : current;
        const title = typeof action.patch.summary === 'string' && action.patch.summary ? action.patch.summary : tab.title;
        const { isMissing: _isMissing, ...rest } = tab;
        return {
          ...(revives ? rest : tab),
          session: changesFields || dropsTarget ? { ...base, ...action.patch } : current,
          title,
          projectId: owner ?? tab.projectId,
          provider: ownerProvider ?? tab.provider,
        };
      });
    }
    case 'replaceSessionId': {
      if (action.fromId === action.toId) {
        return layout;
      }
      const rewritten = mapAllTabs(layout, (tab) => (tab.sessionId === action.fromId
        ? { ...tab, sessionId: action.toId, session: tab.session ? { ...tab.session, id: action.toId } : tab.session }
        : tab));
      return dedupePaneSessions(dedupePaneSessions(rewritten, 'right'), 'left');
    }
    // The right pane goes first: emptying the left pane first would move the right pane's
    // tabs into the left slot, out of reach of the second pass.
    case 'removeSession':
      return removeTabs(
        removeTabs(layout, 'right', (tab) => tab.sessionId === action.sessionId),
        'left',
        (tab) => tab.sessionId === action.sessionId,
      );
    case 'removeProject':
      return removeTabs(
        removeTabs(layout, 'right', (tab) => tab.projectId === action.projectId),
        'left',
        (tab) => tab.projectId === action.projectId,
      );
    case 'pruneDrafts': {
      const isDeadDraft = (tab: WorkspaceSessionTab) => tab.sessionId === null && !action.liveProjectIds.has(tab.projectId);
      return removeTabs(removeTabs(layout, 'right', isDeadDraft), 'left', isDeadDraft);
    }
    case 'noteExternalUpdate': {
      // Only panes showing the session reload it; a background tab loads fresh when activated.
      let next = layout;
      for (const side of WORKSPACE_PANE_SIDES) {
        const pane = getPane(next, side);
        if (pane && getActiveTab(pane)?.sessionId === action.sessionId) {
          next = withPane(next, side, { ...pane, externalRevision: pane.externalRevision + 1 });
        }
      }
      return next;
    }
    case 'markMissing':
      return mapAllTabs(layout, (tab) => (tab.sessionId === action.sessionId && !tab.isMissing ? { ...tab, isMissing: true } : tab));
    case 'setRatio': {
      const ratio = clampSplitRatio(action.ratio);
      return ratio === layout.splitRatio ? layout : { ...layout, splitRatio: ratio };
    }
    default:
      return layout;
  }
};

/** The pane with this id, wherever it sits; null when the layout has none. */
const findPaneById = (layout: WorkspaceLayout, paneId: string): WorkspacePaneState | null => {
  if (layout.left.id === paneId) {
    return layout.left;
  }
  return layout.right?.id === paneId ? layout.right : null;
};

/**
 * Bumps a pane's draft counter whenever a different draft becomes its active tab (feeds
 * ChatInterface.newSessionTrigger). Compared per pane id, not per side: a pane moving into the left slot
 * keeps its chat, which already shows that draft.
 */
const bumpDraftActivations = (previous: WorkspaceLayout, next: WorkspaceLayout): WorkspaceLayout => {
  let result = next;
  for (const side of WORKSPACE_PANE_SIDES) {
    const pane = getPane(result, side);
    const activeTab = getActiveTab(pane);
    if (!pane || !activeTab || activeTab.sessionId !== null) {
      continue;
    }
    if (getActiveTab(findPaneById(previous, pane.id))?.key === activeTab.key) {
      continue;
    }
    result = withPane(result, side, { ...pane, draftActivation: pane.draftActivation + 1 });
  }
  return result;
};

/** The pure reducer behind the workspace layout; returns the same object when an action changes nothing. */
export function workspaceLayoutReducer(layout: WorkspaceLayout, action: WorkspaceLayoutAction): WorkspaceLayout {
  const next = reduceLayout(layout, action);
  return next === layout ? layout : bumpDraftActivations(layout, next);
}

// ---------------------------------------------------------------- persistence

/** One tab as both stores hold it: no runtime session object or missing flag. */
type StoredTab = Omit<WorkspaceSessionTab, 'session' | 'isMissing'>;

/** One pane as both stores hold it: no runtime id or counters. */
type StoredPane = { tabs: StoredTab[]; activeTabKey: string | null; mru: string[] };

/** The JSON written to sessionStorage and localStorage under WORKSPACE_LAYOUT_STORAGE_KEY. */
type StoredLayout = {
  version: 1;
  left: StoredPane;
  right: StoredPane | null;
  focusedSide: WorkspacePaneSide;
  splitRatio: number;
};

const toStoredPane = (pane: WorkspacePaneState): StoredPane => {
  let tabs = pane.tabs;
  // Over the cap, the most recently used tabs survive (the active one first), in tab order.
  if (tabs.length > MAX_PERSISTED_TABS) {
    const keptKeys = new Set<string>();
    for (const key of [pane.activeTabKey, ...pane.mru, ...pane.tabs.map((tab) => tab.key)]) {
      if (key && keptKeys.size < MAX_PERSISTED_TABS) {
        keptKeys.add(key);
      }
    }
    tabs = tabs.filter((tab) => keptKeys.has(tab.key));
  }
  const storedKeys = new Set(tabs.map((tab) => tab.key));
  return {
    tabs: tabs.map(({ session: _session, isMissing: _isMissing, ...tab }) => tab),
    activeTabKey: pane.activeTabKey && storedKeys.has(pane.activeTabKey) ? pane.activeTabKey : null,
    mru: pane.mru.filter((key) => storedKeys.has(key)),
  };
};

/** The persisted form of a layout: tab identity, order, views, focus and ratio; never session objects, missing flags, pane ids or counters. */
export const serializeLayout = (layout: WorkspaceLayout): StoredLayout => ({
  version: 1,
  left: toStoredPane(layout.left),
  right: layout.right ? toStoredPane(layout.right) : null,
  focusedSide: layout.focusedSide,
  splitRatio: layout.splitRatio,
});

const parseTab = (raw: unknown): WorkspaceSessionTab | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.key !== 'string' || !value.key) {
    return null;
  }
  if (value.sessionId !== null && (typeof value.sessionId !== 'string' || !value.sessionId)) {
    return null;
  }
  if (typeof value.projectId !== 'string' || !value.projectId) {
    return null;
  }
  const sessionId = value.sessionId as string | null;
  const provider = (typeof value.provider === 'string' && value.provider ? value.provider : 'claude') as LLMProvider;
  const title = typeof value.title === 'string' ? value.title : '';
  return {
    key: value.key,
    sessionId,
    projectId: value.projectId,
    provider,
    title,
    view: isWorkspaceView(value.view) ? value.view : 'chat',
    isPreview: value.isPreview === true,
    // Enough for the chat to start loading; the first projects load or a lookup replaces it.
    session: sessionId ? { id: sessionId, summary: title, __provider: provider, __projectId: value.projectId } : null,
  };
};

const parsePane = (raw: unknown, id: string, usedKeys: Set<string>, draftProjects: Set<string>): WorkspacePaneState | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const tabs: WorkspaceSessionTab[] = [];
  const sessionIds = new Set<string>();
  for (const rawTab of (Array.isArray(value.tabs) ? value.tabs : []).slice(0, MAX_PERSISTED_TABS)) {
    const tab = parseTab(rawTab);
    if (!tab || usedKeys.has(tab.key)) {
      continue;
    }
    if (tab.sessionId && sessionIds.has(tab.sessionId)) {
      continue;
    }
    // One unsent chat per project across the whole layout.
    if (!tab.sessionId && draftProjects.has(tab.projectId)) {
      continue;
    }
    usedKeys.add(tab.key);
    if (tab.sessionId) {
      sessionIds.add(tab.sessionId);
    } else {
      draftProjects.add(tab.projectId);
    }
    tabs.push(tab);
  }
  // At most one preview per pane: the last one stays a preview, the rest are kept tabs.
  const lastPreview = tabs.map((tab) => tab.isPreview).lastIndexOf(true);
  const normalized = tabs.map((tab, index) => (tab.isPreview && index !== lastPreview ? { ...tab, isPreview: false } : tab));
  const keys = new Set(normalized.map((tab) => tab.key));
  const activeTabKey = typeof value.activeTabKey === 'string' && keys.has(value.activeTabKey)
    ? value.activeTabKey
    : normalized[0]?.key ?? null;
  const mru = Array.isArray(value.mru)
    ? value.mru.filter((key): key is string => typeof key === 'string' && keys.has(key))
    : [];
  return {
    id,
    tabs: normalized,
    activeTabKey,
    mru: activeTabKey ? touchMru([...new Set(mru)], activeTabKey) : [],
    draftActivation: 0,
    externalRevision: 0,
  };
};

/** Reads a stored layout field by field, dropping what does not validate; null when there is none or it is unreadable. */
export const parseStoredLayout = (raw: string | null): WorkspaceLayout | null => {
  if (!raw) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) {
    return null;
  }
  const stored = value as Record<string, unknown>;
  const usedKeys = new Set<string>();
  const draftProjects = new Set<string>();
  const left = parsePane(stored.left, RESTORED_LEFT_PANE_ID, usedKeys, draftProjects) ?? createEmptyPane(RESTORED_LEFT_PANE_ID);
  const right = parsePane(stored.right, RESTORED_RIGHT_PANE_ID, usedKeys, draftProjects);
  // A pane Split just created (still empty) survives a reload; an empty left hands its place to the right.
  const panes = left.tabs.length === 0 && right ? { left: right, right: null } : { left, right };
  const focusedSide: WorkspacePaneSide = stored.focusedSide === 'right' && panes.right ? 'right' : 'left';
  return {
    ...panes,
    focusedSide,
    splitRatio: clampSplitRatio(typeof stored.splitRatio === 'number' ? stored.splitRatio : Number.NaN),
  };
};

// ---------------------------------------------------------------- selectors

/** sessionId -> the side(s) showing it, for the sidebar's per-row marker and side buttons. Sessions in no tab are absent. */
export const collectSessionPlacements = (layout: WorkspaceLayout): Map<string, Exclude<SessionPanePlacement, null>> => {
  const placements = new Map<string, Exclude<SessionPanePlacement, null>>();
  for (const side of WORKSPACE_PANE_SIDES) {
    for (const tab of getPane(layout, side)?.tabs ?? []) {
      if (!tab.sessionId) {
        continue;
      }
      const current = placements.get(tab.sessionId);
      placements.set(tab.sessionId, current && current !== side ? 'both' : side);
    }
  }
  return placements;
};

/**
 * Ids of the panes the workspace mounts: both, except on a phone, which mounts the focused pane only
 * (ProjectMainRegion renders from this). A layout change that drops an id unmounts that pane's chat and
 * editor, which is what useWorkspaceNavigation's commit asks about before discarding unsaved edits.
 */
export const collectMountedPaneIds = (layout: WorkspaceLayout, { isMobile }: { isMobile: boolean }): string[] => {
  if (!layout.right) {
    return [layout.left.id];
  }
  if (isMobile) {
    return [(getPane(layout, layout.focusedSide) as WorkspacePaneState).id];
  }
  return [layout.left.id, layout.right.id];
};

/** Sessions on screen: each pane's active tab, or only the focused pane's when `focusedOnly` (a phone, or a split too narrow to show both). */
export const collectVisibleSessionIds = (
  layout: WorkspaceLayout,
  { focusedOnly = false }: { focusedOnly?: boolean } = {},
): Set<string> => {
  const ids = new Set<string>();
  const sides: WorkspacePaneSide[] = focusedOnly ? [layout.focusedSide] : ['left', 'right'];
  for (const side of sides) {
    const sessionId = getActiveTab(getPane(layout, side))?.sessionId;
    if (sessionId) {
      ids.add(sessionId);
    }
  }
  return ids;
};

/** Whether any tab of either pane holds the session. */
export const layoutHasSession = (layout: WorkspaceLayout, sessionId: string): boolean =>
  [layout.left, layout.right].some((pane) => pane?.tabs.some((tab) => tab.sessionId === sessionId));
