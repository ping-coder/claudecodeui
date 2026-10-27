import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useWorkspaceChrome } from '@/modules/project-workspace/context/WorkspaceChromeContext';
import type { WorkspaceLayout, WorkspaceLayoutActions } from '@/shared/types';

/**
 * ProjectWorkspaceShell owns the workspace chrome every region reads: whether the main column can
 * hold two panes (measured, not guessed from the viewport), immersive mode and its sidebar drawer.
 * The regions are probes here, owned by other parts of the workspace; the shell is real, and so is
 * ProjectQuickSettingsRegion, whose panel is replaced by a probe.
 */

const UNSPLIT: WorkspaceLayout = {
  left: { tabs: [], activeTabKey: null, mru: [], draftActivation: 0, externalRevision: 0 },
  right: null,
  focusedSide: 'left',
  splitRatio: 0.5,
};

const toggleSplit = vi.fn<() => void>();
const setSidebarOpen = vi.fn<(open: boolean) => void>();
const PANES_STATE = {
  layout: UNSPLIT,
  actions: { toggleSplit, focusPane: vi.fn(), split: vi.fn() } as unknown as WorkspaceLayoutActions,
  setSidebarOpen,
};
const COMMAND_STATE = { selectedProject: null, setActiveTab: () => undefined };

vi.mock('@/modules/project-workspace/context/ProjectsStateContext', () => ({
  useProjectPanesState: () => PANES_STATE,
  useProjectCommandState: () => COMMAND_STATE,
}));
vi.mock('@/modules/project-workspace/controllers/ProjectEffects', () => ({ default: () => null }));
vi.mock('@/modules/project-workspace/ProjectCommandPalette', () => ({ default: () => null }));
vi.mock('@/modules/project-workspace/ProjectSidebarRegion', () => ({ default: SidebarRegionProbe }));
vi.mock('@/modules/project-workspace/ProjectMainRegion', () => ({ default: MainRegionProbe }));
vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({ insertComposerText: () => undefined }),
}));
vi.mock('@/modules/quick-settings-panel', () => ({ QuickSettingsPanel: QuickSettingsPanelProbe }));

// How often the sidebar region mounted and unmounted: immersive mode must only hide it.
const sidebarRegionLifecycle = { mounts: 0, unmounts: 0 };

/** Stands in for the sidebar region; like the real Sidebar, it opens Settings in a portal. */
function SidebarRegionProbe() {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  useEffect(() => {
    sidebarRegionLifecycle.mounts += 1;
    return () => {
      sidebarRegionLifecycle.unmounts += 1;
    };
  }, []);
  return (
    <div>
      <button type="button" onClick={() => setIsSettingsOpen(true)}>Open settings</button>
      {isSettingsOpen && createPortal(<div role="dialog" aria-label="Settings" />, document.body)}
    </div>
  );
}

/** Stands in for the pane group: shows what it reads from the chrome and offers the pane buttons. */
function MainRegionProbe() {
  const chrome = useWorkspaceChrome();
  return (
    <div
      data-testid="main-region"
      data-can-split={String(chrome.canSplit)}
      data-immersive={String(chrome.isImmersive)}
      data-peek={String(chrome.isSidebarPeekOpen)}
    >
      <button type="button" onClick={chrome.toggleImmersive}>Toggle full screen</button>
      <button type="button" onClick={chrome.exitImmersive}>Pane exit full screen</button>
      <button type="button" onClick={() => chrome.setSidebarPeekOpen(true)}>Pane show sidebar</button>
    </div>
  );
}

function QuickSettingsPanelProbe({ allowDocking }: { allowDocking?: boolean }) {
  return <div data-testid="quick-settings" data-allow-docking={String(allowDocking)} />;
}

const { default: ProjectWorkspaceShell } = await import('@/modules/project-workspace/ProjectWorkspaceShell');

// The main column's width as the stubbed layout engine reports it.
let mainColumnWidth = 1200;
const resizeObserverCallbacks: Array<() => void> = [];

class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe() {
    resizeObserverCallbacks.push(() => this.callback([], this as unknown as ResizeObserver));
  }

  unobserve() {}

  disconnect() {}
}

const resizeMainColumn = (width: number) => {
  mainColumnWidth = width;
  act(() => {
    resizeObserverCallbacks.forEach((notify) => notify());
  });
};

const renderShell = ({ isMobile = false }: { isMobile?: boolean } = {}) => render(
  <ProjectWorkspaceShell
    isMobile={isMobile}
    ws={null}
    sendMessage={() => undefined}
    navigate={(() => undefined) as unknown as NavigateFunction}
  />,
);

const mainRegion = () => screen.getByTestId('main-region');
const canSplit = () => mainRegion().dataset.canSplit;
const isImmersive = () => mainRegion().dataset.immersive;
const isPeekOpen = () => mainRegion().dataset.peek;
const clickButton = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
// Booleans rather than nodes: a failed assertion on a jsdom node makes node:assert walk the whole tree.
const hasButton = (name: string) => screen.queryByRole('button', { name }) !== null;
const isSettingsOpen = () => screen.queryByRole('dialog', { name: 'Settings' }) !== null;
const pressModBackslash = () => fireEvent.keyDown(document.body, { code: 'Backslash', key: '\\', ctrlKey: true });

beforeEach(() => {
  mainColumnWidth = 1200;
  resizeObserverCallbacks.length = 0;
  sidebarRegionLifecycle.mounts = 0;
  sidebarRegionLifecycle.unmounts = 0;
  toggleSplit.mockReset();
  setSidebarOpen.mockReset();
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ width: mainColumnWidth, height: 800, top: 0, left: 0, right: mainColumnWidth, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('the panes may split only while the main column holds two of them', () => {
  renderShell();
  // Measured before the first paint.
  assert.equal(canSplit(), 'true');

  // 2 x 360px panes + the 6px splitter.
  resizeMainColumn(725);
  assert.equal(canSplit(), 'false');
  resizeMainColumn(726);
  assert.equal(canSplit(), 'true');
});

test('phones never split, however wide', () => {
  const desktop = renderShell();
  assert.equal(canSplit(), 'true');
  desktop.unmount();

  // Same 1200px main column.
  renderShell({ isMobile: true });
  assert.equal(canSplit(), 'false');
});

test('the split shortcut follows the measured width', () => {
  renderShell();

  pressModBackslash();
  assert.equal(toggleSplit.mock.calls.length, 1);

  resizeMainColumn(600);
  pressModBackslash();
  assert.equal(toggleSplit.mock.calls.length, 1);
});

test('immersive mode keeps the sidebar mounted, so Settings still opens', () => {
  renderShell();
  assert.equal(isImmersive(), 'false');

  clickButton('Toggle full screen');
  assert.equal(isImmersive(), 'true');
  clickButton('Open settings');
  assert.equal(isSettingsOpen(), true);

  // Leaving keeps the same sidebar instance, and the open Settings dialog with it.
  clickButton('Toggle full screen');
  assert.equal(isImmersive(), 'false');
  assert.equal(isSettingsOpen(), true);
  assert.deepEqual(sidebarRegionLifecycle, { mounts: 1, unmounts: 0 });
});

test('the full-screen shortcut enters and leaves immersive mode', () => {
  renderShell();

  fireEvent.keyDown(document.body, { code: 'Enter', key: 'Enter', ctrlKey: true, shiftKey: true });
  assert.equal(isImmersive(), 'true');

  fireEvent.keyDown(document.body, { code: 'Enter', key: 'Enter', ctrlKey: true, shiftKey: true });
  assert.equal(isImmersive(), 'false');
});

test('quick settings never dock while immersive', () => {
  renderShell();
  const quickSettings = () => screen.getByTestId('quick-settings').dataset.allowDocking;
  assert.equal(quickSettings(), 'true');

  clickButton('Toggle full screen');
  assert.equal(quickSettings(), 'false');

  clickButton('Pane exit full screen');
  assert.equal(quickSettings(), 'true');
});

test('the immersive sidebar drawer ends with immersive mode and starts closed next time', () => {
  renderShell();

  clickButton('Toggle full screen');
  clickButton('Pane show sidebar');
  assert.equal(isPeekOpen(), 'true');

  clickButton('Pane exit full screen');
  assert.equal(isPeekOpen(), 'false');

  clickButton('Toggle full screen');
  assert.equal(isPeekOpen(), 'false');
});

test('the drawer only opens in desktop immersive mode', () => {
  const desktop = renderShell();
  // Not immersive: the sidebar is docked, there is nothing to peek past.
  clickButton('Pane show sidebar');
  assert.equal(isPeekOpen(), 'false');
  clickButton('Toggle full screen');
  clickButton('Pane show sidebar');
  assert.equal(isPeekOpen(), 'true');
  desktop.unmount();

  // Phones open the sidebar as their usual drawer (the capsule's menu button) instead.
  renderShell({ isMobile: true });
  clickButton('Toggle full screen');
  clickButton('Pane show sidebar');
  assert.equal(isPeekOpen(), 'false');
});

test('phones in immersive mode get the floating menu and exit capsule', () => {
  renderShell({ isMobile: true });
  assert.equal(hasButton('Exit full screen'), false);

  clickButton('Toggle full screen');
  clickButton('Show sidebar');
  assert.deepEqual(setSidebarOpen.mock.calls, [[true]]);

  clickButton('Exit full screen');
  assert.equal(isImmersive(), 'false');
  assert.equal(hasButton('Exit full screen'), false);
});

test('desktop immersive mode has no capsule: the pane tab bar carries the exit button', () => {
  renderShell();

  clickButton('Toggle full screen');

  assert.equal(isImmersive(), 'true');
  assert.equal(hasButton('Show sidebar'), false);
  assert.equal(hasButton('Exit full screen'), false);
});

test('the capsule fades to 40% after three seconds and a touch brings it back', () => {
  vi.useFakeTimers();
  renderShell({ isMobile: true });
  clickButton('Toggle full screen');
  const capsule = () => screen.getByRole('button', { name: 'Exit full screen' }).parentElement as HTMLElement;
  const isFaded = () => capsule().classList.contains('opacity-40');
  assert.equal(isFaded(), false);

  act(() => {
    vi.advanceTimersByTime(3000);
  });
  assert.equal(isFaded(), true);

  fireEvent.pointerDown(screen.getByRole('button', { name: 'Show sidebar' }));
  assert.equal(isFaded(), false);

  // The touch restarts the three seconds.
  act(() => {
    vi.advanceTimersByTime(2999);
  });
  assert.equal(isFaded(), false);
  act(() => {
    vi.advanceTimersByTime(1);
  });
  assert.equal(isFaded(), true);
});
