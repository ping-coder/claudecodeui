import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { TFunction } from 'i18next';
import React from 'react';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type {
  Project,
  ProjectSession,
  SessionOpenOptions,
  SessionPanePlacement,
  SessionWithProvider,
  SidebarPaneTargeting,
  WorkspaceLayout,
  WorkspacePaneSide,
  WorkspaceSessionTab,
} from '@/shared/types';

/**
 * The sidebar region in immersive (full screen) mode. On the desktop the docked
 * sidebar goes away but stays mounted, since Settings and the delete dialogs live
 * in it; "Show sidebar" brings it back as an overlay drawer, full width even when
 * the user had collapsed it to the rail. The drawer takes the focus while it is
 * out and hands it back when it goes. It closes on a click outside, on Escape
 * (before the chat's abort or the editor's close can hear it, but after a rename
 * inside it has had its say) and once a conversation is opened from it: at once,
 * or, for a preview opened by a click, once a double-click is no longer coming.
 * A conversation dragged out of it reaches the panes' drop zones. The region also
 * tells the sidebar whether rows may offer the left and right sides.
 */

type SidebarStub = {
  sidebarOpen: boolean;
  setSidebarOpen: () => void;
  sidebarSharedProps: {
    showSettings: boolean;
    onSessionSelect: (session: ProjectSession, options?: SessionOpenOptions) => void;
    onNewSession: (project: Project, options?: SessionOpenOptions) => void;
  };
  paneTargetingBase: Omit<SidebarPaneTargeting, 'canTargetSides'>;
  focusedTabKey: string | null;
};

let sidebarState: SidebarStub;
// Provided by the immersive workspace below, which owns the focused tab; the region tests use `sidebarState`.
const WorkspaceSidebarStateContext = React.createContext<SidebarStub | null>(null);
vi.mock('@/modules/project-workspace/context/ProjectsStateContext', () => ({
  useProjectSidebarState: () => React.useContext(WorkspaceSidebarStateContext) ?? sidebarState,
}));

let uiPreferences = { sidebarVisible: true };
vi.mock('@/shared/context/UiPreferencesContext', () => ({
  useUiPreferences: () => uiPreferences,
}));

// The real session row is rendered in the drawer; its controls must not reach the network.
vi.mock('@/shared/api', () => ({
  api: {
    providerSessionId: () => Promise.resolve({ ok: false, json: async () => ({}) }),
  },
}));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useSessionForkingProviders: () => new Set(),
}));

type SidebarStubProps = {
  paneTargeting?: SidebarPaneTargeting | null;
  forceExpanded?: boolean;
  onSessionSelect?: (session: ProjectSession, options?: SessionOpenOptions) => void;
  onNewSession?: (project: Project, options?: SessionOpenOptions) => void;
};
const sidebarRenders: SidebarStubProps[] = [];
let sidebarMounts = 0;

const NOW = new Date('2026-08-21T10:00:00.000Z');
const ROW_PROJECT = { projectId: 'p1', name: 'p1', displayName: 'project one', fullPath: '/repo', sessions: [] } as unknown as Project;
const ROW_SESSION = {
  id: 's1',
  summary: 'session one',
  lastActivity: '2026-08-21T09:00:00.000Z',
  __provider: 'claude',
} as unknown as SessionWithProvider;
const rowT = ((key: string) => key) as unknown as TFunction;
// Whether the row's inline rename is open.
let isRenamingRow = false;
const cancelRename = vi.fn();

// A sidebar with a search box first and Settings last, around the real session row (its click,
// double-click, rename and side-button rules are what the drawer has to work with), which opens
// through the sidebar's open callback the way the sidebar's controller does. The row is loaded by
// path: the sidebar's barrel only exposes Sidebar.
vi.mock('@/modules/sidebar', async () => {
  const { default: SidebarSessionItem } = await vi.importActual<{ default: ComponentType<Record<string, unknown>> }>(
    '@/modules/sidebar/SidebarSessionItem',
  );
  return {
    Sidebar: (props: SidebarStubProps) => {
      React.useEffect(() => {
        sidebarMounts += 1;
      }, []);
      sidebarRenders.push(props);
      return (
        <div data-testid="sidebar">
          <input aria-label="Search" />
          <SidebarSessionItem
            project={ROW_PROJECT}
            session={ROW_SESSION}
            isSelected={false}
            isProcessing={false}
            hasBackgroundWork={false}
            needsAttention={false}
            currentTime={NOW}
            isEditing={isRenamingRow}
            renameDraft="draft"
            onRenameDraftChange={() => {}}
            onStartEditingSession={() => {}}
            onCancelEditingSession={cancelRename}
            onSaveEditingSession={() => {}}
            onSessionSelect={(session: SessionWithProvider, projectId: string, options?: SessionOpenOptions) => (
              props.onSessionSelect?.({ ...session, __projectId: projectId }, options)
            )}
            onDeleteSession={() => {}}
            isSelecting={false}
            isChecked={false}
            onToggleSessionSelected={() => {}}
            canTargetSides
            isWorkspaceSplit={false}
            panePlacement={null}
            t={rowT}
          />
          <button type="button" onClick={() => props.onNewSession?.(ROW_PROJECT)}>New session</button>
          <button type="button">Settings</button>
        </div>
      );
    },
  };
});

const { WorkspaceChromeProvider } = await import('@/modules/project-workspace/context/WorkspaceChromeContext');
const { default: ProjectSidebarRegion } = await import('@/modules/project-workspace/ProjectSidebarRegion');
const { useWorkspaceShortcuts } = await import('@/modules/project-workspace/hooks/useWorkspaceShortcuts');

const noop = () => {};
const PLACEMENTS: ReadonlyMap<string, SessionPanePlacement> = new Map([['s1', 'left']]);
const focusPane = vi.fn();
const setSidebarPeekOpen = vi.fn();
const openSession = vi.fn<(session: ProjectSession, options?: SessionOpenOptions) => void>();
const openNewSession = vi.fn<(project: Project, options?: SessionOpenOptions) => void>();
const SHARED_PROPS = { showSettings: false, onSessionSelect: openSession, onNewSession: openNewSession };

const paneTargetingBase = (focusedSide: WorkspacePaneSide = 'left', isSplit = false) => ({
  isSplit,
  focusedSide,
  onFocusSide: focusPane,
  placements: PLACEMENTS,
});

type RegionState = {
  isMobile?: boolean;
  isImmersive?: boolean;
  isSidebarPeekOpen?: boolean;
  canSplit?: boolean;
};

const region = ({ isMobile = false, isImmersive = false, isSidebarPeekOpen = false, canSplit = true }: RegionState = {}) => (
  <WorkspaceChromeProvider
    value={{
      isImmersive,
      isBrowserFullscreen: false,
      toggleImmersive: noop,
      exitImmersive: noop,
      isSidebarPeekOpen,
      setSidebarPeekOpen,
      canSplit,
    }}
  >
    <ProjectSidebarRegion isMobile={isMobile} />
  </WorkspaceChromeProvider>
);

/**
 * The workspace around the region, immersive: a pane's "Show sidebar" button opens the drawer,
 * the region closes it, and opening a session makes its tab the focused one (a session that is
 * focused already leaves the workspace as it is).
 */
function ImmersiveWorkspace({ initialTabKey = 'tab-1' }: { initialTabKey?: string }) {
  const [isSidebarPeekOpen, setIsSidebarPeekOpen] = React.useState(false);
  const [focusedTabKey, setFocusedTabKey] = React.useState<string | null>(initialTabKey);
  React.useLayoutEffect(() => {
    openSession.mockImplementation((session) => setFocusedTabKey(`tab-${session.id}`));
  }, []);
  const setPeekOpen = (open: boolean) => {
    setSidebarPeekOpen(open);
    setIsSidebarPeekOpen(open);
  };

  return (
    <WorkspaceSidebarStateContext.Provider value={{ ...sidebarState, focusedTabKey }}>
      <WorkspaceChromeProvider
        value={{
          isImmersive: true,
          isBrowserFullscreen: false,
          toggleImmersive: noop,
          exitImmersive: noop,
          isSidebarPeekOpen,
          setSidebarPeekOpen: setPeekOpen,
          canSplit: true,
        }}
      >
        <ProjectSidebarRegion isMobile={false} />
        <main>
          <button type="button" onClick={() => setPeekOpen(true)}>Show sidebar</button>
        </main>
      </WorkspaceChromeProvider>
    </WorkspaceSidebarStateContext.Provider>
  );
}

const lastSidebarProps = (): SidebarStubProps => {
  const props = sidebarRenders.at(-1);
  assert.ok(props, 'the sidebar rendered');
  return props;
};

const showSidebarButton = () => screen.getByRole('button', { name: 'Show sidebar' });

/** Renders the immersive workspace and brings the drawer out through its button, focused first like a real press. */
const openDrawer = (initialTabKey?: string) => {
  const view = render(<ImmersiveWorkspace initialTabKey={initialTabKey} />);
  const trigger = showSidebarButton();
  trigger.focus();
  fireEvent.click(trigger);
  return { ...view, trigger };
};

const drawerElement = (): HTMLElement => {
  const drawer = screen.getByTestId('sidebar').parentElement;
  assert.ok(drawer, 'the sidebar sits in the region container');
  return drawer;
};

const isDrawerOut = () => !drawerElement().classList.contains('hidden');

const rowLink = (): HTMLAnchorElement => {
  const link = document.querySelector<HTMLAnchorElement>('a[href="/session/s1"]');
  assert.ok(link, 'the session row is in the drawer');
  return link;
};

/** One mouse click on the row, as the browser sends it: press, release, click (detail = the click count). */
const clickRow = (detail: number) => {
  const link = rowLink();
  fireEvent.pointerDown(link);
  fireEvent.pointerUp(link);
  fireEvent.click(link, { detail });
};

/** Escape as the page receives it, and whether it travelled on to the document's own listeners. */
const pressEscape = (target: Element = document.body) => {
  const documentListener = vi.fn();
  // The chat's abort listens here and leaves an Escape that is already claimed.
  let preventedAtDocument = false;
  const recordAtDocument = (event: KeyboardEvent) => {
    documentListener();
    preventedAtDocument = event.defaultPrevented;
  };
  document.addEventListener('keydown', recordAtDocument, true);
  const notPrevented = fireEvent.keyDown(target, { key: 'Escape' });
  document.removeEventListener('keydown', recordAtDocument, true);
  return { prevented: !notPrevented, reachedDocument: documentListener.mock.calls.length > 0, preventedAtDocument };
};

/** jsdom has no DataTransfer; this keeps what a dragstart handler writes and the drop's outcome. */
const createDataTransfer = () => {
  const store = new Map<string, string>();
  return {
    dropEffect: 'none',
    get types() {
      return [...store.keys()];
    },
    setData: (type: string, value: string) => {
      store.set(type, value);
    },
    getData: (type: string) => store.get(type) ?? '',
  };
};

beforeEach(() => {
  sidebarState = {
    sidebarOpen: false,
    setSidebarOpen: noop,
    sidebarSharedProps: SHARED_PROPS,
    paneTargetingBase: paneTargetingBase(),
    focusedTabKey: 'tab-1',
  };
  uiPreferences = { sidebarVisible: true };
  sidebarRenders.length = 0;
  sidebarMounts = 0;
  isRenamingRow = false;
  focusPane.mockReset();
  setSidebarPeekOpen.mockReset();
  cancelRename.mockReset();
  openNewSession.mockReset();
  openSession.mockReset();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.querySelectorAll('[data-test-layer]').forEach((element) => element.remove());
});

test('immersive mode hides the docked sidebar without unmounting it', () => {
  const { container, rerender } = render(region());
  const dock = container.firstElementChild as HTMLElement;
  assert.ok(!dock.classList.contains('hidden'));
  assert.ok(screen.getByRole('separator'), 'the docked sidebar can be resized');

  rerender(region({ isImmersive: true }));

  assert.ok(container.firstElementChild === dock, 'the same container, only its classes change');
  assert.ok(dock.classList.contains('hidden'));
  assert.ok(screen.getByTestId('sidebar'), 'still mounted, so its dialogs keep working');
  assert.equal(sidebarMounts, 1);
  assert.ok(screen.queryByRole('separator') === null, 'no resize handle while immersive');
  assert.equal(lastSidebarProps().forceExpanded, false);
  assert.ok(screen.queryByRole('button', { name: 'Close sidebar' }) === null, 'no overlay without the peek');
});

test('the peek shows the sidebar as a forced-open drawer, at the user\'s width, over an overlay', () => {
  // Collapsed to the rail: the drawer is still the full sidebar.
  uiPreferences = { sidebarVisible: false };
  const { container, rerender } = render(region({ isImmersive: true }));

  rerender(region({ isImmersive: true, isSidebarPeekOpen: true }));

  const drawer = container.firstElementChild as HTMLElement;
  for (const className of ['fixed', 'inset-y-0', 'start-0', 'z-40']) {
    assert.ok(drawer.classList.contains(className), className);
  }
  assert.ok(!drawer.classList.contains('hidden'));
  assert.equal(drawer.style.width, '288px');
  assert.ok(drawer.hasAttribute('data-escape-layer'), 'the drawer owns Escape');
  assert.equal(drawer.hasAttribute('aria-modal'), false, 'it owns Escape only, not the other shortcuts');
  assert.equal(lastSidebarProps().forceExpanded, true);
  assert.equal(sidebarMounts, 1, 'opening the drawer does not remount the sidebar');
  assert.ok(screen.queryByRole('separator') === null, 'the drawer cannot be resized');

  const overlay = screen.getByRole('button', { name: 'Close sidebar' });
  for (const className of ['fixed', 'inset-0', 'z-30']) {
    assert.ok(overlay.classList.contains(className), className);
  }
});

test('a click on the overlay closes the peek', () => {
  render(region({ isImmersive: true, isSidebarPeekOpen: true }));

  fireEvent.click(screen.getByRole('button', { name: 'Close sidebar' }));

  assert.deepEqual(setSidebarPeekOpen.mock.calls, [[false]]);
});

test('Escape closes the peek before the chat\'s abort or the editor\'s close can hear it', () => {
  render(region({ isImmersive: true, isSidebarPeekOpen: true }));

  const escape = pressEscape();

  assert.deepEqual(setSidebarPeekOpen.mock.calls, [[false]]);
  assert.equal(escape.prevented, true);
  assert.equal(escape.reachedDocument, false, 'stopped in the window capture phase');
});

test('Escape is left to a menu or dialog opened over the drawer', () => {
  render(region({ isImmersive: true, isSidebarPeekOpen: true }));

  // The last one is how the sidebar's own delete confirmations mark themselves.
  for (const [attribute, value] of [['role', 'menu'], ['aria-modal', 'true'], ['data-escape-layer', '']]) {
    const layer = document.createElement('div');
    layer.setAttribute(attribute, value);
    layer.setAttribute('data-test-layer', '');
    document.body.appendChild(layer);

    const escape = pressEscape();
    assert.equal(escape.reachedDocument, true, `${attribute} closes first`);
    layer.remove();
  }

  assert.equal(setSidebarPeekOpen.mock.calls.length, 0);
});

test('while Settings is open over the drawer, the drawer stops marking itself as an Escape layer', () => {
  // Settings only takes Escape while no `data-escape-layer` is on the page.
  sidebarState = { ...sidebarState, sidebarSharedProps: { ...SHARED_PROPS, showSettings: true } };
  const { container } = render(region({ isImmersive: true, isSidebarPeekOpen: true }));

  assert.equal((container.firstElementChild as HTMLElement).hasAttribute('data-escape-layer'), false);
});

test('without the peek, Escape is not the region\'s to take', () => {
  render(region({ isImmersive: true }));

  const escape = pressEscape();

  assert.equal(escape.reachedDocument, true);
  assert.equal(escape.prevented, false);
  assert.equal(setSidebarPeekOpen.mock.calls.length, 0);
});

test('Escape in a rename inside the drawer cancels the rename and leaves the drawer out', () => {
  isRenamingRow = true;
  openDrawer();
  const renameInput = within(drawerElement()).getByDisplayValue('draft');

  const escape = pressEscape(renameInput);

  assert.equal(cancelRename.mock.calls.length, 1, 'the rename heard its Escape');
  assert.equal(isDrawerOut(), true);
  assert.equal(escape.preventedAtDocument, true, 'claimed on the way down, so the chat does not abort a run on it');
});

test('Escape in a field of a dialog opened from the drawer is that field\'s to answer', () => {
  openDrawer();
  // Like the project wizard's folder field, portaled outside the drawer and answering Escape itself.
  const field = document.createElement('input');
  field.setAttribute('data-test-layer', '');
  const answerEscape = vi.fn((event: KeyboardEvent) => event.stopPropagation());
  field.addEventListener('keydown', answerEscape);
  document.body.appendChild(field);

  pressEscape(field);

  assert.equal(answerEscape.mock.calls.length, 1);
  assert.equal(isDrawerOut(), true);
});

test('Escape in a field inside the drawer that has no use for it still closes the drawer', () => {
  openDrawer();

  const escape = pressEscape(screen.getByRole('textbox', { name: 'Search' }));

  assert.equal(isDrawerOut(), false);
  assert.equal(!escape.reachedDocument || escape.preventedAtDocument, true, 'the chat\'s abort leaves it alone');
});

test('a focused tab changed from outside the drawer (palette, shortcut) closes the peek', () => {
  const { rerender } = render(region({ isImmersive: true, isSidebarPeekOpen: true }));
  assert.equal(setSidebarPeekOpen.mock.calls.length, 0, 'opening it is not a tab change');

  sidebarState = { ...sidebarState, focusedTabKey: 'tab-2' };
  rerender(region({ isImmersive: true, isSidebarPeekOpen: true }));

  assert.deepEqual(setSidebarPeekOpen.mock.calls, [[false]]);
});

test('choosing a side in the Open-in switch keeps the peek open for the click that follows', () => {
  sidebarState = { ...sidebarState, paneTargetingBase: paneTargetingBase('left', true) };
  const { rerender } = render(region({ isImmersive: true, isSidebarPeekOpen: true }));

  lastSidebarProps().paneTargeting?.onFocusSide('right');
  assert.deepEqual(focusPane.mock.calls, [['right']]);

  // The workspace focuses the right pane, whose active tab is another one.
  sidebarState = { ...sidebarState, paneTargetingBase: paneTargetingBase('right', true), focusedTabKey: 'tab-right' };
  rerender(region({ isImmersive: true, isSidebarPeekOpen: true }));
  assert.equal(setSidebarPeekOpen.mock.calls.length, 0);

  // Then a conversation is opened there.
  sidebarState = { ...sidebarState, focusedTabKey: 'tab-opened' };
  rerender(region({ isImmersive: true, isSidebarPeekOpen: true }));
  assert.deepEqual(setSidebarPeekOpen.mock.calls, [[false]]);
});

test('a double-click on a row in the drawer keeps the tab: the drawer waits for the second click', () => {
  openDrawer();

  clickRow(1);
  assert.deepEqual(openSession.mock.calls.map(([, options]) => options), [{ preview: true }]);
  assert.equal(isDrawerOut(), true, 'the first click previewed the session; the drawer stays for a second one');

  clickRow(2);
  fireEvent.dblClick(rowLink(), { detail: 2 });

  assert.deepEqual(openSession.mock.calls.at(-1)?.[1], { preview: false }, 'the double-click reached the row and kept the tab');
  assert.equal(isDrawerOut(), false, 'and the drawer closes at once');
});

test('a single click previews the session and closes the drawer once a double-click is no longer coming', () => {
  vi.useFakeTimers();
  openDrawer();

  clickRow(1);
  act(() => {
    vi.advanceTimersByTime(400);
  });
  assert.equal(isDrawerOut(), true);

  act(() => {
    vi.advanceTimersByTime(200);
  });
  assert.equal(isDrawerOut(), false);
  assert.deepEqual(openSession.mock.calls.map(([, options]) => options), [{ preview: true }]);
});

test('a slow double-click still lands on the row: pressing the row holds the close until the release', () => {
  vi.useFakeTimers();
  openDrawer();

  clickRow(1);
  act(() => {
    vi.advanceTimersByTime(450);
  });
  fireEvent.pointerDown(rowLink());
  act(() => {
    vi.advanceTimersByTime(300);
  });
  assert.equal(isDrawerOut(), true, 'still out while the row is pressed');

  fireEvent.pointerUp(rowLink());
  fireEvent.click(rowLink(), { detail: 2 });
  fireEvent.dblClick(rowLink(), { detail: 2 });

  assert.deepEqual(openSession.mock.calls.at(-1)?.[1], { preview: false });
  assert.equal(isDrawerOut(), false);
});

test('dragging the row right after a click keeps the drawer out for the drag', () => {
  vi.useFakeTimers();
  openDrawer();
  const dataTransfer = createDataTransfer();

  clickRow(1);
  fireEvent.pointerDown(rowLink());
  fireEvent.dragStart(rowLink(), { dataTransfer });
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  assert.equal(isDrawerOut(), true, 'the drag is still under way');

  // Dropped where nothing took it, the drawer is simply out again: nothing put off is left over
  // to keep a focused tab changed from elsewhere (the palette) from closing it.
  fireEvent.dragEnd(rowLink(), { dataTransfer });
  act(() => {
    openSession({ id: 'from-palette' } as ProjectSession);
  });
  assert.equal(isDrawerOut(), false);
});

test('a press elsewhere in the drawer meanwhile keeps it out: the user is still browsing it', () => {
  vi.useFakeTimers();
  openDrawer();

  clickRow(1);
  const search = screen.getByRole('textbox', { name: 'Search' });
  fireEvent.pointerDown(search);
  fireEvent.pointerUp(search);
  act(() => {
    vi.advanceTimersByTime(2000);
  });

  assert.equal(isDrawerOut(), true);
});

test('opening the conversation that is already on screen closes the drawer too', () => {
  vi.useFakeTimers();
  // s1 is the focused tab already, so opening it changes nothing in the workspace.
  openDrawer('tab-s1');

  clickRow(1);
  act(() => {
    vi.advanceTimersByTime(600);
  });

  assert.equal(openSession.mock.calls.length, 1);
  assert.equal(isDrawerOut(), false);
});

test('Enter on a row, a side button and a new chat close the drawer at once', () => {
  const opens: Array<[string, () => void]> = [
    ['Enter on the row', () => fireEvent.click(rowLink(), { detail: 0 })],
    ['the side button', () => fireEvent.click(screen.getByRole('button', { name: 'sessions.openOnRightSplit' }))],
    ['New session', () => fireEvent.click(screen.getByRole('button', { name: 'New session' }))],
  ];

  for (const [label, open] of opens) {
    // The session is on screen already: nothing in the workspace changes to close the drawer.
    const { unmount } = openDrawer('tab-s1');
    open();
    assert.equal(isDrawerOut(), false, label);
    unmount();
  }

  assert.deepEqual(openSession.mock.calls.map(([, options]) => options), [{ preview: true }, { target: 'right' }]);
  assert.equal(openNewSession.mock.calls.length, 1);
});

test('the open callbacks handed to the sidebar keep their identity as the drawer comes and goes', () => {
  // The rows bind them; a new identity on every open and close would re-render every row.
  const { rerender } = render(region({ isImmersive: true }));
  const { onSessionSelect, onNewSession } = lastSidebarProps();

  rerender(region({ isImmersive: true, isSidebarPeekOpen: true }));
  rerender(region({ isImmersive: true }));

  assert.equal(lastSidebarProps().onSessionSelect === onSessionSelect, true);
  assert.equal(lastSidebarProps().onNewSession === onNewSession, true);
});

test('opening the drawer moves the focus into it, and closing it hands the focus back to "Show sidebar"', () => {
  const closes: Array<[string, () => void]> = [
    ['Escape', () => pressEscape(document.activeElement ?? document.body)],
    ['Enter on a row', () => {
      rowLink().focus();
      fireEvent.click(rowLink(), { detail: 0 });
    }],
    ['the overlay', () => fireEvent.click(screen.getByRole('button', { name: 'Close sidebar' }))],
  ];

  for (const [label, close] of closes) {
    const { trigger, unmount } = openDrawer();
    const drawer = drawerElement();
    assert.equal(document.activeElement === drawer, true, `${label}: the drawer has the focus while it is out`);
    assert.equal(drawer.getAttribute('role'), 'dialog');
    assert.equal(drawer.getAttribute('aria-label'), 'Sidebar');

    close();

    assert.equal(isDrawerOut(), false, label);
    assert.equal(document.activeElement === trigger, true, `${label}: focus is back on the button that opened it`);
    unmount();
  }
});

test('Tab and Shift+Tab wrap around inside the drawer instead of walking into the panes it covers', () => {
  // jsdom lays nothing out; every element counts as rendered here.
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  openDrawer();
  const drawer = drawerElement();
  const search = screen.getByRole('textbox', { name: 'Search' });
  const settings = screen.getByRole('button', { name: 'Settings' });

  fireEvent.keyDown(drawer, { key: 'Tab', shiftKey: true });
  assert.equal(document.activeElement === settings, true, 'back from the drawer itself to its last stop');

  fireEvent.keyDown(settings, { key: 'Tab' });
  assert.equal(document.activeElement === search, true, 'on from the last stop to the first');

  fireEvent.keyDown(search, { key: 'Tab', shiftKey: true });
  assert.equal(document.activeElement === settings, true, 'back from the first stop to the last');
});

test('a conversation dragged out of the drawer gets through the overlay to the panes, and a drop closes the drawer', () => {
  openDrawer();
  const overlay = screen.getByRole('button', { name: 'Close sidebar' });
  const dataTransfer = createDataTransfer();

  fireEvent.dragStart(rowLink(), { dataTransfer });
  assert.equal(overlay.classList.contains('pointer-events-none'), true, 'the panes underneath get the drag');

  // Dropped where nothing took it: the drawer stays and its overlay catches clicks again.
  fireEvent.dragEnd(rowLink(), { dataTransfer });
  assert.equal(isDrawerOut(), true);
  assert.equal(overlay.classList.contains('pointer-events-none'), false);

  // Dropped on a pane: the conversation opened there.
  fireEvent.dragStart(rowLink(), { dataTransfer });
  dataTransfer.dropEffect = 'copy';
  fireEvent.dragEnd(rowLink(), { dataTransfer });
  assert.equal(isDrawerOut(), false);
});

test('a drag whose end never reached the drawer does not leave the next drawer\'s overlay letting clicks through', () => {
  openDrawer();
  // The row the drag started from went away, so no dragend comes back to the drawer.
  fireEvent.dragStart(rowLink(), { dataTransfer: createDataTransfer() });
  pressEscape();
  assert.equal(isDrawerOut(), false);

  fireEvent.click(showSidebarButton());

  assert.equal(screen.getByRole('button', { name: 'Close sidebar' }).classList.contains('pointer-events-none'), false);
});

test('a drag that carries no conversation leaves the overlay in place', () => {
  openDrawer();
  const overlay = screen.getByRole('button', { name: 'Close sidebar' });

  fireEvent.dragStart(screen.getByRole('button', { name: 'Settings' }), { dataTransfer: createDataTransfer() });

  assert.equal(overlay.classList.contains('pointer-events-none'), false);
});

test('rows may target sides on the desktop wherever two panes fit or already stand', () => {
  const cases: Array<[RegionState & { isSplit: boolean }, boolean]> = [
    [{ canSplit: true, isSplit: false }, true],
    [{ canSplit: false, isSplit: true }, true],
    [{ canSplit: false, isSplit: false }, false],
    [{ isMobile: true, canSplit: true, isSplit: true }, false],
  ];

  for (const [{ isSplit, ...chrome }, canTargetSides] of cases) {
    sidebarState = { ...sidebarState, paneTargetingBase: paneTargetingBase('right', isSplit) };
    const { unmount } = render(region(chrome));
    assert.deepEqual(lastSidebarProps().paneTargeting, {
      isSplit,
      focusedSide: 'right',
      onFocusSide: lastSidebarProps().paneTargeting?.onFocusSide,
      placements: PLACEMENTS,
      canTargetSides,
    }, JSON.stringify({ ...chrome, isSplit }));
    unmount();
  }
});

test('the targeting handed to the sidebar keeps its identity while nothing in it changes', () => {
  const { rerender } = render(region());
  const first = lastSidebarProps().paneTargeting;

  rerender(region());

  assert.equal(lastSidebarProps().paneTargeting, first);
});

/** Puts a layer over the drawer the way Settings (a modal dialog) or a delete confirmation (an Escape layer) marks itself. */
const addLayerOverDrawer = (attribute: 'aria-modal' | 'data-escape-layer') => {
  const layer = document.createElement('div');
  layer.setAttribute(attribute, attribute === 'aria-modal' ? 'true' : '');
  if (attribute === 'aria-modal') {
    layer.setAttribute('role', 'dialog');
  }
  layer.setAttribute('data-test-layer', '');
  document.body.appendChild(layer);
  return layer;
};

test('while Settings or a delete confirmation is open over the drawer, Tab walks out of it instead of wrapping', () => {
  // jsdom lays nothing out; every element counts as rendered here.
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  openDrawer();
  const settings = screen.getByRole('button', { name: 'Settings' });
  const search = screen.getByRole('textbox', { name: 'Search' });

  for (const attribute of ['aria-modal', 'data-escape-layer'] as const) {
    const layer = addLayerOverDrawer(attribute);
    settings.focus();
    const forward = fireEvent.keyDown(settings, { key: 'Tab' });
    search.focus();
    const backward = fireEvent.keyDown(search, { key: 'Tab', shiftKey: true });
    layer.remove();

    // Neither layer takes the focus itself: the browser's own Tab order has to be able to reach it.
    assert.equal(forward && backward, true, `${attribute}: the keys are left to the browser`);
    assert.equal(document.activeElement === search, true, attribute);
  }
});

test('the drawer is focusable only for the focus it takes when it opens: a press inside, or a Tab, gives that back', () => {
  const { unmount } = openDrawer();
  const drawer = drawerElement();
  assert.equal(document.activeElement === drawer, true);
  assert.equal(drawer.getAttribute('tabindex'), '-1');

  // A press on blank space in the list must not park focus on the drawer, whose keyboard scrolling then goes nowhere.
  fireEvent.pointerDown(screen.getByTestId('sidebar'));
  assert.equal(drawer.hasAttribute('tabindex'), false);
  unmount();

  // Tabbing in moves focus on to the first stop; the drawer gives its tabindex back then too.
  openDrawer();
  screen.getByRole('textbox', { name: 'Search' }).focus();
  assert.equal(drawerElement().hasAttribute('tabindex'), false);

  // Closed, it is the docked (here hidden) sidebar again, which is never focusable itself.
  fireEvent.click(showSidebarButton());
  pressEscape(document.activeElement ?? document.body);
  assert.equal(isDrawerOut(), false);
  assert.equal(drawerElement().hasAttribute('tabindex'), false);
});

const paneTab = (key: string): WorkspaceSessionTab => ({
  key,
  sessionId: key,
  projectId: 'p1',
  provider: 'claude',
  title: key,
  view: 'chat',
  isPreview: false,
  session: null,
});

const PANE_PAIR: WorkspaceLayout = {
  left: { id: 'pane-left', tabs: [paneTab('a1')], activeTabKey: 'a1', mru: ['a1'], draftActivation: 0, externalRevision: 0 },
  right: { id: 'pane-right', tabs: [paneTab('b1')], activeTabKey: 'b1', mru: ['b1'], draftActivation: 0, externalRevision: 0 },
  focusedSide: 'left',
  splitRatio: 0.5,
};

/**
 * Two panes side by side in immersive mode, the drawer and the pane keys wired the way ProjectWorkspaceShell
 * wires them. As in the layout reducer, focusing the focused pane changes nothing, and a merge keeps the
 * focused pane and its active tab.
 */
function SplitImmersiveWorkspace() {
  const [layout, setLayout] = React.useState<WorkspaceLayout>(PANE_PAIR);
  const [isSidebarPeekOpen, setIsSidebarPeekOpen] = React.useState(false);
  const actions = React.useMemo(() => ({
    focusPane: (side: WorkspacePaneSide) => setLayout((current) => (current.focusedSide === side ? current : { ...current, focusedSide: side })),
    toggleSplit: () => setLayout((current) => (current.right
      ? { ...current, left: { ...current.left, tabs: [...current.left.tabs, ...current.right.tabs] }, right: null, focusedSide: 'left' }
      : current)),
  }), []);
  const closeSidebarPeek = React.useCallback(() => setIsSidebarPeekOpen(false), []);
  useWorkspaceShortcuts({ isMobile: false, canSplit: true, layout, actions, toggleImmersive: noop, closeSidebarPeek });
  const focusedPane = layout.focusedSide === 'left' ? layout.left : layout.right;

  return (
    <WorkspaceSidebarStateContext.Provider
      value={{
        ...sidebarState,
        paneTargetingBase: paneTargetingBase(layout.focusedSide, layout.right !== null),
        focusedTabKey: focusedPane?.activeTabKey ?? null,
      }}
    >
      <WorkspaceChromeProvider
        value={{
          isImmersive: true,
          isBrowserFullscreen: false,
          toggleImmersive: noop,
          exitImmersive: noop,
          isSidebarPeekOpen,
          setSidebarPeekOpen: setIsSidebarPeekOpen,
          canSplit: true,
        }}
      >
        <ProjectSidebarRegion isMobile={false} />
        <main>
          <div data-workspace-pane="left" role="group">
            <div data-workspace-control="">
              <button type="button" onClick={() => setIsSidebarPeekOpen(true)}>Show sidebar</button>
            </div>
            <textarea data-slot="prompt-input-textarea" aria-label="left composer" />
          </div>
          {layout.right && (
            <div data-workspace-pane="right" role="group">
              <textarea data-slot="prompt-input-textarea" aria-label="right composer" />
            </div>
          )}
        </main>
      </WorkspaceChromeProvider>
    </WorkspaceSidebarStateContext.Provider>
  );
}

test('a pane key that puts focus in a pane closes the drawer over it, also when the focused tab stays the same', () => {
  // The pane keys move DOM focus a frame later; the frames run by hand.
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  const cases: Array<[string, KeyboardEventInit, string]> = [
    ['Mod+1 with the left pane focused already', { code: 'Digit1', key: '1', ctrlKey: true }, 'left composer'],
    ['Mod+2, moving to the right pane', { code: 'Digit2', key: '2', ctrlKey: true }, 'right composer'],
    ['Mod+\\, merging into the focused left pane', { code: 'Backslash', key: '\\', ctrlKey: true }, 'left composer'],
  ];

  for (const [label, keys, expectedFocus] of cases) {
    const { unmount } = render(<SplitImmersiveWorkspace />);
    const trigger = showSidebarButton();
    trigger.focus();
    fireEvent.click(trigger);
    assert.equal(isDrawerOut(), true, label);

    fireEvent.keyDown(document.activeElement ?? document.body, keys);
    act(() => {
      frames.splice(0).forEach((callback) => callback(0));
    });

    assert.equal(isDrawerOut(), false, `${label}: no drawer and overlay left over the pane that has the focus`);
    assert.equal(document.activeElement?.getAttribute('aria-label'), expectedFocus, `${label}: the caret is in the composer`);
    unmount();
  }
});
