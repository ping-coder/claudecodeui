import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useWorkspaceChrome } from '@/modules/project-workspace/context/WorkspaceChromeContext';
import { useBrowserFullscreen } from '@/shared/hooks/useBrowserFullscreen';
import type { CommandPaletteWorkspaceCommands, WorkspaceLayout, WorkspaceLayoutActions } from '@/shared/types';

/**
 * ProjectWorkspaceShell owns the workspace chrome every region reads: whether the main column can
 * hold two panes (measured, not guessed from the viewport), immersive mode and its sidebar drawer.
 * The regions are probes here, owned by other parts of the workspace; the shell is real, and so are
 * ProjectQuickSettingsRegion and ProjectCommandPalette, whose panel and palette are probes.
 */

const UNSPLIT: WorkspaceLayout = {
  left: { id: 'pane-left', tabs: [], activeTabKey: null, mru: [], draftActivation: 0, externalRevision: 0 },
  right: null,
  focusedSide: 'left',
  splitRatio: 0.5,
};

const SPLIT: WorkspaceLayout = {
  ...UNSPLIT,
  right: { id: 'pane-right', tabs: [], activeTabKey: null, mru: [], draftActivation: 0, externalRevision: 0 },
};

const toggleSplit = vi.fn<() => void>();
const setSidebarOpen = vi.fn<(open: boolean) => void>();
// What the shell reports to the pane state about the room for two panes.
const setCanShowBothPanes = vi.fn<(canShowBothPanes: boolean) => void>();
const refreshWorkspace = vi.fn<() => Promise<void>>(async () => undefined);
const PANES_STATE = {
  layout: UNSPLIT as WorkspaceLayout,
  actions: { toggleSplit, focusPane: vi.fn(), split: vi.fn() } as unknown as WorkspaceLayoutActions,
  setSidebarOpen,
  setCanShowBothPanes,
  refreshWorkspace,
  isRefreshingWorkspace: false,
  projects: [],
  paneProjects: { left: null, right: null },
};
const COMMAND_STATE = {
  selectedProject: null,
  handleNewSession: () => undefined,
  openSettings: () => undefined,
  setActiveTab: () => undefined,
  openSessionById: () => undefined,
  layout: UNSPLIT,
  actions: PANES_STATE.actions,
};

vi.mock('@/modules/project-workspace/context/ProjectsStateContext', () => ({
  useProjectPanesState: () => PANES_STATE,
  useProjectCommandState: () => COMMAND_STATE,
}));
vi.mock('@/modules/project-workspace/controllers/ProjectEffects', () => ({ default: () => null }));
// Run alerts need the socket, the activity map and the UI preferences, none of which this is about; a probe
// stands in, so the shell is still seen to mount them.
vi.mock('@/modules/project-workspace/ProjectRunNotifications', () => ({ default: RunNotificationsProbe }));
vi.mock('@/modules/project-workspace/ProjectSidebarRegion', () => ({ default: SidebarRegionProbe }));
vi.mock('@/modules/project-workspace/ProjectMainRegion', () => ({ default: MainRegionProbe }));
vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({ insertComposerText: () => undefined }),
  CommandPalette: CommandPaletteProbe,
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
      <EditorFullscreenProbe />
    </div>
  );
}

/** Stands in for the floating editor's full-screen button: another holder of the browser fullscreen. */
function EditorFullscreenProbe() {
  const { isMaximized, toggle } = useBrowserFullscreen({ source: 'codeEditor' });
  return <button type="button" data-maximized={String(isMaximized)} onClick={toggle}>Editor full screen</button>;
}

// How many run-notification bindings are mounted, and what the last one rendered with.
const runNotificationsProbe = { mounted: 0, last: null as { isMobile: boolean; canSplit: boolean } | null };

/** Stands in for ProjectRunNotifications: records its props and the chrome it reads. */
function RunNotificationsProbe({ isMobile }: { isMobile: boolean }) {
  const { canSplit: chromeCanSplit } = useWorkspaceChrome();
  useLayoutEffect(() => {
    runNotificationsProbe.last = { isMobile, canSplit: chromeCanSplit };
  });
  useEffect(() => {
    runNotificationsProbe.mounted += 1;
    return () => {
      runNotificationsProbe.mounted -= 1;
    };
  }, []);
  return null;
}

function QuickSettingsPanelProbe({ allowDocking }: { allowDocking?: boolean }) {
  return <div data-testid="quick-settings" data-allow-docking={String(allowDocking)} />;
}

/** Stands in for the palette UI: its Full screen command runs the workspace command straight from the click, as the palette's run() does. */
function CommandPaletteProbe({ workspace }: { workspace?: CommandPaletteWorkspaceCommands }) {
  return <button type="button" onClick={() => workspace?.onToggleFullscreen()}>Palette full screen</button>;
}

const { default: ProjectWorkspaceShell } = await import('@/modules/project-workspace/ProjectWorkspaceShell');

// The matchMedia stand-in vitest.setup.ts installs; stubChromiumWindow wraps it and afterEach puts it back.
const setupMatchMedia = window.matchMedia;

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
  PANES_STATE.layout = UNSPLIT;
  PANES_STATE.isRefreshingWorkspace = false;
  refreshWorkspace.mockClear();
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
  // The Fullscreen API and the Chromium window some tests install (see stubFullscreenApi, stubChromiumWindow).
  const fullscreenStubs: Array<[object, string]> = [
    [document, 'fullscreenEnabled'],
    [document, 'fullscreenElement'],
    [document, 'exitFullscreen'],
    [document.documentElement, 'requestFullscreen'],
    [navigator, 'userAgent'],
  ];
  for (const [target, key] of fullscreenStubs) {
    Reflect.deleteProperty(target, key);
  }
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: setupMatchMedia });
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

test('the pane state hears whether both panes fit, so a hidden pane\'s session can still need attention', () => {
  setCanShowBothPanes.mockReset();
  renderShell();
  assert.equal(setCanShowBothPanes.mock.calls.at(-1)?.[0], true);

  resizeMainColumn(725);
  assert.equal(setCanShowBothPanes.mock.calls.at(-1)?.[0], false);
  resizeMainColumn(900);
  assert.equal(setCanShowBothPanes.mock.calls.at(-1)?.[0], true);
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

test('the phone capsule reads menu, refresh, exit; refresh refreshes everything in place and waits while one runs', () => {
  const view = renderShell({ isMobile: true });
  clickButton('Toggle full screen');
  const capsuleLabels = () => Array.from(
    (screen.getByRole('button', { name: 'Exit full screen' }).parentElement as HTMLElement).querySelectorAll('button'),
  ).map((button) => button.getAttribute('aria-label'));
  assert.deepEqual(capsuleLabels(), ['Show sidebar', 'Refresh all', 'Exit full screen']);

  clickButton('Refresh all');
  assert.equal(refreshWorkspace.mock.calls.length, 1);
  assert.equal(isImmersive(), 'true', 'still full screen');

  PANES_STATE.isRefreshingWorkspace = true;
  view.rerender(
    <ProjectWorkspaceShell isMobile ws={null} sendMessage={() => undefined} navigate={(() => undefined) as unknown as NavigateFunction} />,
  );
  assert.equal(screen.getByRole('button', { name: 'Refresh all' }).getAttribute('aria-busy'), 'true');
  clickButton('Refresh all');
  assert.equal(refreshWorkspace.mock.calls.length, 1, 'a press while one runs does nothing');
});

test('in browser full screen F5 refreshes the workspace instead of reloading the page', () => {
  renderShell();
  const pressF5 = () => fireEvent.keyDown(document.body, { key: 'F5', code: 'F5' });

  assert.equal(pressF5(), true, 'outside full screen the browser reloads');
  assert.equal(refreshWorkspace.mock.calls.length, 0);

  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => document.documentElement });
  assert.equal(pressF5(), false, 'the reload is cancelled');
  assert.equal(refreshWorkspace.mock.calls.length, 1);
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

test('a pane key that keeps the focused tab still closes the drawer once it has moved the focus', () => {
  PANES_STATE.layout = SPLIT;
  // The pane keys move DOM focus a frame later; the frames run by hand.
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  renderShell();
  clickButton('Toggle full screen');
  clickButton('Pane show sidebar');
  assert.equal(isPeekOpen(), 'true');

  // Mod+1 with the left pane focused already: the focused tab does not change.
  fireEvent.keyDown(document.body, { code: 'Digit1', key: '1', ctrlKey: true });
  assert.equal(isPeekOpen(), 'true', 'not before the focus moved');
  act(() => {
    frames.splice(0).forEach((callback) => callback(0));
  });

  assert.equal(isPeekOpen(), 'false');
});

test('the run notifications are mounted once, inside the workspace chrome, told whether this is a phone', () => {
  const view = renderShell();
  assert.equal(runNotificationsProbe.mounted, 1);
  assert.deepEqual(runNotificationsProbe.last, { isMobile: false, canSplit: true });
  view.unmount();
  assert.equal(runNotificationsProbe.mounted, 0);

  renderShell({ isMobile: true });
  assert.equal(runNotificationsProbe.mounted, 1);
  assert.deepEqual(runNotificationsProbe.last, { isMobile: true, canSplit: false });
});

// ---- The browser full-screen notice. jsdom has no Fullscreen API, so these tests install one.

// What the stubbed browser shows fullscreen.
let shownFullscreenElement: Element | null = null;

/** A Fullscreen API whose requests play the given outcomes in turn, the last one repeating; afterEach removes it. */
const stubFullscreenApi = (outcomes: Array<'grant' | 'refuse'>) => {
  shownFullscreenElement = null;
  const remaining = [...outcomes];
  const show = (element: Element | null) => {
    shownFullscreenElement = element;
    document.dispatchEvent(new Event('fullscreenchange'));
  };
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true });
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => shownFullscreenElement });
  const requestFullscreen = vi.fn(async () => {
    const outcome = remaining.length > 1 ? remaining.shift() : remaining[0];
    if (outcome === 'refuse') {
      throw new TypeError('not granted');
    }
    show(document.documentElement);
  });
  Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, writable: true, value: requestFullscreen });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, writable: true, value: async () => show(null) });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  return { requestFullscreen, warn };
};

// Booleans, not nodes (see hasButton).
const hasRefusedNotice = () => screen.queryByText(/The browser refused full screen \(not granted\)/) !== null;
const pressModShiftEnter = () => fireEvent.keyDown(document.body, { code: 'Enter', key: 'Enter', ctrlKey: true, shiftKey: true });
// Lets the browser's answer to a request arrive.
const settle = async () => {
  await act(async () => undefined);
};

test('a refused browser full screen shows why with a retry, and the retry asks again inside its click', async () => {
  const { requestFullscreen } = stubFullscreenApi(['refuse', 'grant']);
  renderShell();

  clickButton('Toggle full screen');
  await settle();
  assert.equal(isImmersive(), 'true');
  assert.equal(hasRefusedNotice(), true);

  clickButton('Retry');
  // Synchronously within the click, so the browser still sees the user's gesture.
  assert.equal(requestFullscreen.mock.calls.length, 2);
  await settle();
  assert.equal(hasRefusedNotice(), false);
  assert.equal(isImmersive(), 'true');
});

test('the pane button, the shortcut and the command palette each ask inside their gesture and each show the refusal', async () => {
  const { requestFullscreen } = stubFullscreenApi(['refuse']);
  renderShell();

  // The pane tab bar's button.
  clickButton('Toggle full screen');
  assert.equal(requestFullscreen.mock.calls.length, 1);
  await settle();
  assert.equal(hasRefusedNotice(), true);
  clickButton('Pane exit full screen');
  assert.equal(hasRefusedNotice(), false);

  // The full-screen shortcut.
  pressModShiftEnter();
  assert.equal(requestFullscreen.mock.calls.length, 2);
  await settle();
  assert.equal(hasRefusedNotice(), true);
  // The notice takes no keys: the same shortcut still leaves immersive mode, and the notice goes with it.
  pressModShiftEnter();
  assert.equal(isImmersive(), 'false');
  assert.equal(hasRefusedNotice(), false);

  // The command palette's Full screen command, through the real ProjectCommandPalette binding.
  clickButton('Palette full screen');
  assert.equal(requestFullscreen.mock.calls.length, 3);
  await settle();
  assert.equal(isImmersive(), 'true');
  assert.equal(hasRefusedNotice(), true);
});

test('the notice goes with immersive mode and with its close button, and comes back on the next refusal', async () => {
  stubFullscreenApi(['refuse']);
  renderShell();
  clickButton('Toggle full screen');
  await settle();
  clickButton('Pane exit full screen');
  assert.equal(hasRefusedNotice(), false);

  clickButton('Toggle full screen');
  await settle();
  assert.equal(hasRefusedNotice(), true);
  // A status, not a dialog or an escape layer that would take Escape and the shortcuts.
  assert.equal(document.querySelector('[data-escape-layer]') === null, true);
  assert.equal(screen.queryByRole('dialog') === null, true);
  clickButton('Close');
  assert.equal(hasRefusedNotice(), false);
  assert.equal(isImmersive(), 'true');
});

test('phones get no notice, only the console warning', async () => {
  const { warn } = stubFullscreenApi(['refuse']);
  renderShell({ isMobile: true });

  clickButton('Toggle full screen');
  await settle();

  assert.equal(isImmersive(), 'true');
  assert.equal(hasRefusedNotice(), false);
  assert.equal(warn.mock.calls.length, 1);
});

/** Chrome on a Mac whose window stays out of fullscreen, as when this tab is being captured; afterEach removes it. */
const stubChromiumWindow = () => {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({ ...setupMatchMedia(query), matches: false }),
  });
};

const hasInWindowNotice = () => screen.queryByText(/The browser kept full screen inside the window/) !== null;

test('a full screen kept inside the window is explained after three seconds, with the window shortcut instead of a retry', async () => {
  vi.useFakeTimers();
  stubFullscreenApi(['grant']);
  stubChromiumWindow();
  renderShell();

  clickButton('Toggle full screen');
  await settle();
  act(() => {
    vi.advanceTimersByTime(2999);
  });
  assert.equal(hasInWindowNotice(), false);
  act(() => {
    vi.advanceTimersByTime(1);
  });

  assert.equal(hasInWindowNotice(), true);
  assert.equal(screen.queryByText(/Press F11 for a full-screen window/) !== null, true);
  assert.equal(hasButton('Retry'), false);
  clickButton('Pane exit full screen');
  assert.equal(hasInWindowNotice(), false);
});

test('a refusal for another maximize (the editor) shows the same notice outside immersive mode, but not on phones', async () => {
  stubFullscreenApi(['refuse']);
  const desktop = renderShell();

  clickButton('Editor full screen');
  await settle();
  assert.equal(isImmersive(), 'false');
  assert.equal(screen.getByRole('button', { name: 'Editor full screen' }).dataset.maximized, 'true');
  assert.equal(hasRefusedNotice(), true);
  clickButton('Editor full screen');
  assert.equal(hasRefusedNotice(), false);
  desktop.unmount();

  renderShell({ isMobile: true });
  clickButton('Editor full screen');
  await settle();
  assert.equal(hasRefusedNotice(), false);
});
