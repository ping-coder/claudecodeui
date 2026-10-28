import assert from 'node:assert/strict';

import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { useLayoutEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { WorkspaceChromeProvider } from '@/modules/project-workspace/context/WorkspaceChromeContext';
import PaneTabBar from '@/modules/project-workspace/PaneTabBar';
import { ESCAPE_LAYER_SELECTOR } from '@/shared/constants';
import type {
  PaneTabDisplay,
  Project,
  WorkspaceLayoutActions,
  WorkspacePaneState,
  WorkspaceSessionTab,
} from '@/shared/types';

/**
 * Renaming a session on its pane tab. A double-click on the tab that was already active and kept, F2
 * on a session tab, "Rename session" in the tab menu or in the pane menu open a box over the tab,
 * portalled outside the tablist and marked as an Escape layer; a tab the strip scrolled out of sight
 * comes back first. It edits like the header title (the real useSessionTitleRename): Enter saves the
 * trimmed title (with or without modifiers, except the full-screen chord Mod+Shift+Enter; Tab and
 * Shift+Tab save too), Escape and a click away cancel, and after Enter, Tab or Escape the tab takes the
 * focus back. Drafts and missing sessions cannot be renamed.
 */

// A language switch saves the choice to the server; it must not reach the network.
vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));

const ALPHA: Project = { projectId: 'alpha', displayName: 'Alpha', fullPath: '/repo/alpha', sessions: [] };

const makeTab = (key: string, overrides: Partial<WorkspaceSessionTab> = {}): WorkspaceSessionTab => ({
  key,
  sessionId: `session-${key}`,
  projectId: 'alpha',
  provider: 'claude',
  title: key,
  view: 'chat',
  isPreview: false,
  session: { id: `session-${key}`, __projectId: 'alpha', __provider: 'claude' },
  ...overrides,
});

const TABS = [
  makeTab('t1'),
  makeTab('t2', { isPreview: true }),
  makeTab('t3', { sessionId: null, session: null }),
  makeTab('t4'),
  makeTab('t5', { isMissing: true, session: null }),
];
const PANE: WorkspacePaneState = { id: 'pane-left', tabs: TABS, activeTabKey: 't1', mru: ['t1'], draftActivation: 0, externalRevision: 0 };
const DISPLAY = new Map<string, PaneTabDisplay>([
  ['t1', { title: 'First chat', projectName: 'Alpha', activity: null }],
  ['t2', { title: 'Second chat', projectName: 'Alpha', activity: null }],
  ['t3', { title: 'New chat', projectName: 'Alpha', activity: null }],
  ['t4', { title: 'Fourth chat', projectName: 'Alpha', activity: null }],
  ['t5', { title: 'Gone chat', projectName: 'Alpha', activity: null }],
]);

const chrome = {
  isImmersive: false,
  isBrowserFullscreen: false,
  toggleImmersive: vi.fn(),
  exitImmersive: vi.fn(),
  isSidebarPeekOpen: false,
  setSidebarPeekOpen: vi.fn(),
  canSplit: true,
};

/** The harness's pane and labels, so the layout actions can change what the bar shows, as the real ones do. */
const harness: {
  setPane: Dispatch<SetStateAction<WorkspacePaneState>> | null;
  setDisplay: Dispatch<SetStateAction<ReadonlyMap<string, PaneTabDisplay>>> | null;
} = { setPane: null, setDisplay: null };

const makeActions = (): WorkspaceLayoutActions => ({
  openSession: vi.fn(),
  openSessionById: vi.fn(),
  openNewSession: vi.fn(),
  establishDraft: vi.fn(),
  // Like the layout: the tab becomes the active one, so the next press lands on an active tab.
  activateTab: vi.fn((_side, tabKey) => harness.setPane?.((pane) => ({ ...pane, activeTabKey: tabKey }))),
  closeTab: vi.fn(),
  closeOtherTabs: vi.fn(),
  closeTabsToRight: vi.fn(),
  closeAllTabs: vi.fn(),
  pinTab: vi.fn((_side, tabKey) => harness.setPane?.((pane) => ({
    ...pane,
    tabs: pane.tabs.map((tab) => (tab.key === tabKey ? { ...tab, isPreview: false } : tab)),
  }))),
  moveTab: vi.fn(),
  setTabView: vi.fn(),
  focusPane: vi.fn(),
  split: vi.fn(),
  toggleSplit: vi.fn(),
  closePane: vi.fn(),
  setSplitRatio: vi.fn(),
});

let actions = makeActions();
const onRenameSession = vi.fn<(sessionId: string, summary: string) => Promise<boolean>>();

function Harness({ initialPane }: { initialPane: WorkspacePaneState }) {
  const [pane, setPane] = useState(initialPane);
  const [display, setDisplay] = useState<ReadonlyMap<string, PaneTabDisplay>>(DISPLAY);
  useLayoutEffect(() => {
    harness.setPane = setPane;
    harness.setDisplay = setDisplay;
  }, []);
  return (
    <WorkspaceChromeProvider value={chrome}>
      <PaneTabBar
        side="left"
        pane={pane}
        tabDisplay={display}
        actions={actions}
        newChatProject={ALPHA}
        panelId="pane-left-tabpanel"
        isFocused
        isSplit={false}
        isSideBySide={false}
        isCollapsed={false}
        hiddenPaneActivity={null}
        showWorkspaceControls
        isLeftmost
        onRenameSession={onRenameSession}
        showProjectNames={false}
      />
    </WorkspaceChromeProvider>
  );
}

const renderBar = (initialPane: WorkspacePaneState = PANE) => render(<Harness initialPane={initialPane} />);

// Frames run only when a test asks, so it can check what happens before and after the next frame.
let nextFrameId = 1;
const frames = new Map<number, FrameRequestCallback>();
const runFrames = () => {
  act(() => {
    // Frames requested while these run wait for the next call, as they would for the next frame.
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) {
      callback(0);
    }
  });
};

const tabNamed = (title: string) => screen.getByRole('tab', { name: new RegExp(title) });
const renameBox = () => screen.getByRole('textbox', { name: 'Session title' }) as HTMLInputElement;
const queryRenameBox = () => screen.queryByRole('textbox', { name: 'Session title' });

/** A real double-click: two presses and clicks, the second press counted as such, then dblclick. */
const doubleClick = (tab: HTMLElement) => {
  fireEvent.mouseDown(tab, { button: 0, detail: 1 });
  fireEvent.mouseUp(tab, { button: 0, detail: 1 });
  fireEvent.click(tab, { button: 0, detail: 1 });
  fireEvent.mouseDown(tab, { button: 0, detail: 2 });
  fireEvent.mouseUp(tab, { button: 0, detail: 2 });
  fireEvent.click(tab, { button: 0, detail: 2 });
  fireEvent.doubleClick(tab, { button: 0, detail: 2 });
};

const openRenameOnFirstChat = () => {
  doubleClick(tabNamed('First chat'));
  return renameBox();
};

beforeEach(() => {
  actions = makeActions();
  harness.setPane = null;
  harness.setDisplay = null;
  onRenameSession.mockReset();
  onRenameSession.mockResolvedValue(true);
  frames.clear();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = nextFrameId;
    nextFrameId += 1;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
});

afterEach(async () => {
  frames.clear();
  // Unmount first, so restoring the language cannot re-render this test's bar.
  cleanup();
  await i18n.changeLanguage('en');
});

test('a double-click on the active kept tab opens a box over it, outside the tablist, title selected', () => {
  renderBar();
  doubleClick(tabNamed('First chat'));

  const box = renameBox();
  assert.equal(box.value, 'First chat');
  assert.equal(document.activeElement === box, true);
  assert.equal(box.selectionStart, 0);
  assert.equal(box.selectionEnd, 'First chat'.length);
  assert.equal(box.closest('[role="tablist"]') === null, true, 'outside the tablist and its tab handlers');
  assert.equal(box.parentElement === document.body, true, 'portalled, so no ancestor clips or offsets it');
  assert.equal(box.hasAttribute('data-escape-layer'), true);
  assert.equal(vi.mocked(actions.pinTab).mock.calls.length, 0);
});

test('a double-click on a background tab only switches to it; on a preview tab, active or not, it only keeps it', () => {
  renderBar();

  doubleClick(tabNamed('Fourth chat'));
  assert.equal(queryRenameBox() === null, true, 'the tab was not active yet when the double-click began');
  assert.deepEqual(vi.mocked(actions.activateTab).mock.calls, [['left', 't4'], ['left', 't4']]);
  assert.equal(vi.mocked(actions.pinTab).mock.calls.length, 0);

  doubleClick(tabNamed('Second chat'));
  assert.equal(queryRenameBox() === null, true);
  assert.deepEqual(vi.mocked(actions.pinTab).mock.calls, [['left', 't2']]);
});

test('a double-click on the active preview tab keeps it open and does not rename it', () => {
  renderBar({ ...PANE, activeTabKey: 't2' });

  doubleClick(tabNamed('Second chat'));

  assert.deepEqual(vi.mocked(actions.pinTab).mock.calls, [['left', 't2']]);
  assert.equal(queryRenameBox() === null, true);
});

test('F2 on a background tab makes it active and opens the box over it', () => {
  renderBar();

  fireEvent.keyDown(tabNamed('Fourth chat'), { key: 'F2' });

  assert.deepEqual(vi.mocked(actions.activateTab).mock.calls, [['left', 't4']]);
  const box = renameBox();
  assert.equal(box.value, 'Fourth chat');
  assert.equal(document.activeElement === box, true);
});

test('F2 on a preview tab keeps it, then makes it active, then opens the box', () => {
  renderBar();

  fireEvent.keyDown(tabNamed('Second chat'), { key: 'F2' });

  assert.deepEqual(vi.mocked(actions.pinTab).mock.calls, [['left', 't2']]);
  assert.deepEqual(vi.mocked(actions.activateTab).mock.calls, [['left', 't2']]);
  assert.equal(
    vi.mocked(actions.pinTab).mock.invocationCallOrder[0] < vi.mocked(actions.activateTab).mock.invocationCallOrder[0],
    true,
  );
  assert.equal(renameBox().value, 'Second chat');
});

test('F2 on a draft or a missing session does nothing', () => {
  renderBar();

  for (const title of ['New chat', 'Gone chat']) {
    const press = createEvent.keyDown(tabNamed(title), { key: 'F2' });
    fireEvent(tabNamed(title), press);
    assert.equal(press.defaultPrevented, false, title);
  }

  assert.equal(queryRenameBox() === null, true);
  assert.equal(vi.mocked(actions.activateTab).mock.calls.length, 0);
  assert.equal(vi.mocked(actions.pinTab).mock.calls.length, 0);
});

test('Enter saves the trimmed title, closes the box, and the tab takes the focus back a frame later', async () => {
  renderBar();
  const box = openRenameOnFirstChat();

  fireEvent.change(box, { target: { value: '  Renamed  ' } });
  await act(async () => {
    fireEvent.keyDown(renameBox(), { key: 'Enter' });
  });

  assert.deepEqual(onRenameSession.mock.calls, [['session-t1', 'Renamed']]);
  assert.equal(queryRenameBox() === null, true);
  runFrames();
  assert.equal(document.activeElement === tabNamed('First chat'), true);
});

test('Escape cancels without saving, leaves the running chat alone and gives the tab the focus back', () => {
  renderBar();
  const box = openRenameOnFirstChat();
  fireEvent.change(box, { target: { value: 'Discarded' } });

  // The chat stops its run on Escape from a document capture listener unless an Escape layer is open.
  const escapeLayerAtCapture: boolean[] = [];
  const recordEscapeLayer = (event: KeyboardEvent) => {
    escapeLayerAtCapture.push(event.key === 'Escape' && document.querySelector(ESCAPE_LAYER_SELECTOR) !== null);
  };
  const leaked = vi.fn();
  document.addEventListener('keydown', recordEscapeLayer, true);
  window.addEventListener('keydown', leaked);
  const escape = createEvent.keyDown(box, { key: 'Escape' });
  fireEvent(box, escape);
  document.removeEventListener('keydown', recordEscapeLayer, true);
  window.removeEventListener('keydown', leaked);

  assert.deepEqual(escapeLayerAtCapture, [true]);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(leaked.mock.calls.length, 0, 'the keys stop at the box');
  assert.equal(onRenameSession.mock.calls.length, 0);
  assert.equal(queryRenameBox() === null, true);
  runFrames();
  assert.equal(document.activeElement === tabNamed('First chat'), true);
});

test('Tab and Shift+Tab save like Enter instead of moving the focus away, and the tab takes it back a frame later', async () => {
  for (const shiftKey of [false, true]) {
    onRenameSession.mockClear();
    const view = renderBar();
    fireEvent.keyDown(tabNamed('First chat'), { key: 'F2' });
    fireEvent.change(renameBox(), { target: { value: '  Tabbed away  ' } });

    const press = createEvent.keyDown(renameBox(), { key: 'Tab', shiftKey });
    await act(async () => {
      fireEvent(renameBox(), press);
    });

    const label = shiftKey ? 'Shift+Tab' : 'Tab';
    assert.equal(press.defaultPrevented, true, `${label}: the browser does not move the focus`);
    assert.deepEqual(onRenameSession.mock.calls, [['session-t1', 'Tabbed away']], label);
    assert.equal(queryRenameBox() === null, true, label);
    runFrames();
    assert.equal(document.activeElement === tabNamed('First chat'), true, label);
    view.unmount();
  }
});

test('the full-screen chord, Mod+Shift+Enter from either Enter key, does nothing and the edit goes on', async () => {
  renderBar();
  const box = openRenameOnFirstChat();
  fireEvent.change(box, { target: { value: 'Half typed' } });

  // Ctrl is Mod off Apple platforms; the workspace takes the chord from the keypad's Enter too.
  for (const code of ['Enter', 'NumpadEnter']) {
    await act(async () => {
      fireEvent.keyDown(renameBox(), { key: 'Enter', code, ctrlKey: true, shiftKey: true });
    });
  }

  assert.equal(onRenameSession.mock.calls.length, 0);
  assert.equal(renameBox().value, 'Half typed');
  // Neither counted as ending the edit from the keyboard: a click away still leaves the focus alone.
  fireEvent.blur(renameBox());
  runFrames();
  assert.equal(queryRenameBox() === null, true);
  assert.equal(document.activeElement === document.body, true);
});

test('every other Enter saves like a plain one, whatever its modifiers, Shift held over from typing a capital among them', async () => {
  const chords: Array<{ label: string; modifiers: KeyboardEventInit }> = [
    { label: 'Shift+Enter', modifiers: { shiftKey: true } },
    { label: 'Ctrl+Enter', modifiers: { ctrlKey: true } },
    { label: 'Alt+Enter', modifiers: { altKey: true } },
    { label: 'Meta+Enter', modifiers: { metaKey: true } },
    // Command is not Mod off Apple platforms.
    { label: 'Meta+Shift+Enter', modifiers: { metaKey: true, shiftKey: true } },
    // The full-screen keys plus another modifier (AltGr is Ctrl+Alt on Windows).
    { label: 'Ctrl+Alt+Shift+Enter', modifiers: { ctrlKey: true, altKey: true, shiftKey: true } },
    { label: 'Ctrl+Meta+Shift+Enter', modifiers: { ctrlKey: true, metaKey: true, shiftKey: true } },
  ];
  for (const { label, modifiers } of chords) {
    onRenameSession.mockClear();
    const view = renderBar();
    fireEvent.keyDown(tabNamed('First chat'), { key: 'F2' });
    fireEvent.change(renameBox(), { target: { value: '  Fix API  ' } });

    await act(async () => {
      fireEvent.keyDown(renameBox(), { key: 'Enter', code: 'Enter', ...modifiers });
    });

    assert.deepEqual(onRenameSession.mock.calls, [['session-t1', 'Fix API']], label);
    assert.equal(queryRenameBox() === null, true, label);
    runFrames();
    assert.equal(document.activeElement === tabNamed('First chat'), true, label);
    view.unmount();
  }
});

test('on Apple platforms the full-screen chord is Command+Shift+Enter, and Control+Shift+Enter saves', async () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' });
  try {
    renderBar();
    const box = openRenameOnFirstChat();
    fireEvent.change(box, { target: { value: 'Mac title' } });

    await act(async () => {
      fireEvent.keyDown(renameBox(), { key: 'Enter', code: 'Enter', metaKey: true, shiftKey: true });
    });
    assert.equal(onRenameSession.mock.calls.length, 0, 'Command+Shift+Enter');
    assert.equal(queryRenameBox() !== null, true, 'still editing');

    await act(async () => {
      fireEvent.keyDown(renameBox(), { key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey: true });
    });
    assert.deepEqual(onRenameSession.mock.calls, [['session-t1', 'Mac title']], 'Control+Shift+Enter');
    assert.equal(queryRenameBox() === null, true);
  } finally {
    Reflect.deleteProperty(navigator, 'platform');
  }
});

test('a click away cancels without saving and moves no focus', () => {
  renderBar();
  const box = openRenameOnFirstChat();
  fireEvent.change(box, { target: { value: 'Discarded' } });

  fireEvent.blur(box);

  assert.equal(onRenameSession.mock.calls.length, 0);
  assert.equal(queryRenameBox() === null, true);
  runFrames();
  assert.equal(document.activeElement === document.body, true);
});

test('an Enter that only confirms an IME candidate neither saves nor counts as ending the edit from the keyboard', async () => {
  renderBar();
  const box = openRenameOnFirstChat();

  fireEvent.change(box, { target: { value: '日本語' } });
  await act(async () => {
    fireEvent.keyDown(renameBox(), { key: 'Enter', isComposing: true });
  });

  assert.equal(onRenameSession.mock.calls.length, 0);
  assert.equal(renameBox().value, '日本語');

  // A click away after it still leaves the focus alone.
  fireEvent.blur(renameBox());
  runFrames();
  assert.equal(queryRenameBox() === null, true);
  assert.equal(document.activeElement === document.body, true);
});

test('an unchanged title saves nothing, compared with the live title even when it changed elsewhere meanwhile', async () => {
  renderBar();
  openRenameOnFirstChat();

  act(() => harness.setDisplay?.((display) => new Map(display).set('t1', { title: 'Renamed elsewhere', projectName: 'Alpha', activity: null })));
  fireEvent.change(renameBox(), { target: { value: 'Renamed elsewhere' } });
  await act(async () => {
    fireEvent.keyDown(renameBox(), { key: 'Enter' });
  });

  assert.equal(onRenameSession.mock.calls.length, 0);
  assert.equal(queryRenameBox() === null, true);
});

test('a refused rename is reported the way the sidebar reports it', async () => {
  onRenameSession.mockResolvedValue(false);
  const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  renderBar();
  const box = openRenameOnFirstChat();

  fireEvent.change(box, { target: { value: 'Refused' } });
  await act(async () => {
    fireEvent.keyDown(renameBox(), { key: 'Enter' });
  });

  assert.deepEqual(alertSpy.mock.calls, [['Failed to rename session. Please try again.']]);
  assert.equal(queryRenameBox() === null, true);
});

test('"Rename session" in the tab menu opens the box, and the closing menu does not take the focus from it', () => {
  renderBar();

  fireEvent.contextMenu(tabNamed('Fourth chat'), { clientX: 10, clientY: 10 });
  fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Rename session' }));
  runFrames();

  const box = renameBox();
  assert.equal(box.value, 'Fourth chat');
  assert.equal(document.activeElement === box, true);
});

test('"Rename session" in the pane menu opens the box over the active tab and keeps the focus there', () => {
  renderBar();

  fireEvent.click(screen.getByRole('button', { name: 'Pane actions' }));
  fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Rename session' }));
  runFrames();

  const box = renameBox();
  assert.equal(box.value, 'First chat');
  assert.equal(document.activeElement === box, true);
});

test('presses, clicks and keys on the open box never reach the tab under it', () => {
  renderBar();
  const box = openRenameOnFirstChat();
  vi.mocked(actions.activateTab).mockClear();
  vi.mocked(actions.pinTab).mockClear();

  fireEvent(box, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
  fireEvent.contextMenu(box);
  fireEvent.doubleClick(box);
  fireEvent.keyDown(box, { key: 'Delete' });
  fireEvent.keyDown(box, { key: ' ' });
  fireEvent.keyDown(box, { key: 'ArrowRight' });

  assert.equal(vi.mocked(actions.closeTab).mock.calls.length, 0);
  assert.equal(vi.mocked(actions.activateTab).mock.calls.length, 0);
  assert.equal(vi.mocked(actions.pinTab).mock.calls.length, 0);
  assert.equal(vi.mocked(actions.openNewSession).mock.calls.length, 0);
  assert.equal(screen.queryByRole('menu') === null, true, 'no tab menu');
  assert.equal(queryRenameBox() !== null, true, 'still editing');
});

test('the box sits over the tab inside the viewport and follows it when the strip scrolls or the window resizes', () => {
  const tabRect = { left: 900, top: 0, width: 120, height: 40 };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function measure(this: HTMLElement) {
    const { left, top, width, height } = this.dataset.tabKey === 't1' ? tabRect : { left: 0, top: 0, width: 0, height: 0 };
    return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect;
  });
  renderBar();
  openRenameOnFirstChat();
  const boxPlace = () => {
    const { left, top, width, height } = renameBox().style;
    return { left, top, width, height };
  };

  // 20rem wide at least, pulled back 8px inside the 1024px viewport, 4px inside the tab's top and bottom.
  assert.equal(window.innerWidth, 1024);
  assert.deepEqual(boxPlace(), { left: '696px', top: '4px', width: '320px', height: '32px' });

  tabRect.left = 100;
  // A scroll that cannot move the tab (a chat streaming below) does not measure it.
  act(() => {
    screen.getByRole('button', { name: 'New chat in Alpha' }).dispatchEvent(new Event('scroll'));
  });
  assert.deepEqual(boxPlace(), { left: '696px', top: '4px', width: '320px', height: '32px' });
  act(() => {
    screen.getByRole('tablist', { name: 'Open tabs' }).dispatchEvent(new Event('scroll'));
  });
  assert.deepEqual(boxPlace(), { left: '100px', top: '4px', width: '320px', height: '32px' });

  Object.assign(tabRect, { left: 40, width: 400, height: 44 });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
  assert.deepEqual(boxPlace(), { left: '40px', top: '4px', width: '400px', height: '36px' });
});

test('the pane menu renaming an active tab the strip has scrolled out of sight brings it back at once, then places the box over it', () => {
  // The strip shows viewport x 300..700 of a row of 150px tabs; scrollIntoView scrolls it as little as
  // shows the whole tab, as block and inline 'nearest' do.
  const STRIP_LEFT = 300;
  const STRIP_RIGHT = 700;
  const TAB_WIDTH = 150;
  let scrollLeft = 0;
  const tabLeft = (tabKey: string) => STRIP_LEFT + TABS.findIndex((tab) => tab.key === tabKey) * TAB_WIDTH - scrollLeft;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function measure(this: HTMLElement) {
    const tabKey = this.dataset.tabKey;
    const left = tabKey ? tabLeft(tabKey) : 0;
    const width = tabKey ? TAB_WIDTH : 0;
    const height = tabKey ? 40 : 0;
    return { x: left, y: 0, left, top: 0, width, height, right: left + width, bottom: height, toJSON: () => ({}) } as DOMRect;
  });
  const reveals: Array<{ tabKey: string | undefined; options: unknown }> = [];
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: function scrollIntoView(this: HTMLElement, options?: boolean | ScrollIntoViewOptions) {
      const tabKey = this.dataset.tabKey;
      reveals.push({ tabKey, options });
      if (!tabKey) {
        return;
      }
      const left = tabLeft(tabKey);
      if (left < STRIP_LEFT) {
        scrollLeft -= STRIP_LEFT - left;
      } else if (left + TAB_WIDTH > STRIP_RIGHT) {
        scrollLeft += left + TAB_WIDTH - STRIP_RIGHT;
      }
    },
  });
  try {
    for (const { activeTabKey, wheeledTo, boxLeft } of [
      // Wheeled to the end: the first tab sits at -50..100, past the strip's left edge.
      { activeTabKey: 't1', wheeledTo: 350, boxLeft: '300px' },
      // Wheeled to the start: the fourth tab sits at 750..900, past its right edge.
      { activeTabKey: 't4', wheeledTo: 0, boxLeft: '550px' },
    ]) {
      const view = renderBar({ ...PANE, activeTabKey });
      // The strip's own reveal of the active tab runs first; then the user wheels the strip.
      runFrames();
      scrollLeft = wheeledTo;
      reveals.length = 0;

      fireEvent.click(screen.getByRole('button', { name: 'Pane actions' }));
      fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Rename session' }));

      assert.deepEqual(reveals, [{ tabKey: activeTabKey, options: { block: 'nearest', inline: 'nearest' } }], activeTabKey);
      assert.equal(renameBox().style.left, boxLeft, `${activeTabKey}: the box covers the tab where it came back`);
      view.unmount();
    }
  } finally {
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
});

test('a tab closed while it is being renamed takes its box along, unsaved, and does not bring it back', () => {
  renderBar();
  openRenameOnFirstChat();

  act(() => harness.setPane?.((pane) => ({ ...pane, tabs: pane.tabs.filter((tab) => tab.key !== 't1'), activeTabKey: 't4' })));
  assert.equal(queryRenameBox() === null, true);

  act(() => harness.setPane?.((pane) => ({ ...pane, tabs: TABS, activeTabKey: 't1' })));
  assert.equal(queryRenameBox() === null, true, 'the tab coming back is not still being renamed');
  assert.equal(onRenameSession.mock.calls.length, 0);
});

test('keyboard only: Shift+F10, End, ArrowUp to "Rename session", pick it, type, Enter saves', async () => {
  renderBar();
  const tab = tabNamed('First chat');
  tab.focus();

  fireEvent.keyDown(tab, { key: 'F10', shiftKey: true });
  const menu = screen.getByRole('menu');
  fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
  fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
  const renameItem = within(menu).getByRole('menuitem', { name: 'Rename session' });
  assert.equal(document.activeElement === renameItem, true);
  fireEvent.click(renameItem);
  runFrames();

  const box = renameBox();
  assert.equal(document.activeElement === box, true);
  fireEvent.change(box, { target: { value: 'Typed with keys' } });
  await act(async () => {
    fireEvent.keyDown(renameBox(), { key: 'Enter' });
  });
  assert.deepEqual(onRenameSession.mock.calls, [['session-t1', 'Typed with keys']]);
  runFrames();
  assert.equal(document.activeElement === tabNamed('First chat'), true);
});

test('the rename entries and the box speak the interface language', async () => {
  await act(async () => {
    await i18n.changeLanguage('zh-CN');
  });
  renderBar();

  assert.equal((tabNamed('First chat').getAttribute('title') ?? '').includes('双击或按 F2 重命名'), true);

  fireEvent.click(screen.getByRole('button', { name: '窗格操作' }));
  assert.equal(within(screen.getByRole('menu')).getAllByRole('menuitem')[0]?.textContent, '重命名会话');
  fireEvent.click(screen.getByRole('button', { name: '窗格操作' }));

  fireEvent.contextMenu(tabNamed('First chat'), { clientX: 10, clientY: 10 });
  fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '重命名会话' }));
  runFrames();
  assert.equal(screen.queryByRole('textbox', { name: '会话标题' }) !== null, true);
});
