import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { SessionPanePlacement, SidebarPaneTargeting, WorkspacePaneSide } from '@/shared/types';

/**
 * The sidebar region in immersive (full screen) mode. On the desktop the docked
 * sidebar goes away but stays mounted, since Settings and the delete dialogs live
 * in it; "Show sidebar" brings it back as an overlay drawer, full width even when
 * the user had collapsed it to the rail. The drawer closes on a click outside,
 * on Escape (before the chat's abort or the editor's close can hear it) and once
 * a conversation is opened from it. The region also tells the sidebar whether
 * rows may offer the left and right sides.
 */

type SidebarStub = {
  sidebarOpen: boolean;
  setSidebarOpen: () => void;
  sidebarSharedProps: { showSettings: boolean };
  paneTargetingBase: Omit<SidebarPaneTargeting, 'canTargetSides'>;
  focusedTabKey: string | null;
};

let sidebarState: SidebarStub;
vi.mock('@/modules/project-workspace/context/ProjectsStateContext', () => ({
  useProjectSidebarState: () => sidebarState,
}));

let uiPreferences = { sidebarVisible: true };
vi.mock('@/shared/context/UiPreferencesContext', () => ({
  useUiPreferences: () => uiPreferences,
}));

type SidebarStubProps = { paneTargeting?: SidebarPaneTargeting | null; forceExpanded?: boolean };
const sidebarRenders: SidebarStubProps[] = [];
let sidebarMounts = 0;
vi.mock('@/modules/sidebar', () => ({
  Sidebar: (props: SidebarStubProps) => {
    React.useEffect(() => {
      sidebarMounts += 1;
    }, []);
    sidebarRenders.push(props);
    return <div data-testid="sidebar" />;
  },
}));

const { WorkspaceChromeProvider } = await import('@/modules/project-workspace/context/WorkspaceChromeContext');
const { default: ProjectSidebarRegion } = await import('@/modules/project-workspace/ProjectSidebarRegion');

const noop = () => {};
const PLACEMENTS: ReadonlyMap<string, SessionPanePlacement> = new Map([['s1', 'left']]);
const SHARED_PROPS = { showSettings: false };
const focusPane = vi.fn();
const setSidebarPeekOpen = vi.fn();

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

const lastSidebarProps = (): SidebarStubProps => {
  const props = sidebarRenders.at(-1);
  assert.ok(props, 'the sidebar rendered');
  return props;
};

/** Escape as the page receives it, and whether it travelled on to the document's own listeners. */
const pressEscape = () => {
  const documentListener = vi.fn();
  document.addEventListener('keydown', documentListener, true);
  const notPrevented = fireEvent.keyDown(document.body, { key: 'Escape' });
  document.removeEventListener('keydown', documentListener, true);
  return { prevented: !notPrevented, reachedDocument: documentListener.mock.calls.length > 0 };
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
  focusPane.mockReset();
  setSidebarPeekOpen.mockReset();
  localStorage.clear();
});

afterEach(() => {
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
  for (const className of ['fixed', 'inset-y-0', 'left-0', 'z-40']) {
    assert.ok(drawer.classList.contains(className), className);
  }
  assert.ok(!drawer.classList.contains('hidden'));
  assert.equal(drawer.style.width, '288px');
  assert.ok(drawer.hasAttribute('data-escape-layer'), 'the drawer owns Escape');
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

  for (const [attribute, value] of [['role', 'menu'], ['aria-modal', 'true']]) {
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
  sidebarState = { ...sidebarState, sidebarSharedProps: { showSettings: true } };
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

test('a new focused tab closes the peek: the conversation opened from it is on screen', () => {
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
