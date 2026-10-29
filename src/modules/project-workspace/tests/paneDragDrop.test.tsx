import assert from 'node:assert/strict';

import { act, createEvent, fireEvent, render, within } from '@testing-library/react';
import type { NavigateFunction } from 'react-router-dom';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type {
  Project,
  SessionDragPayload,
  WorkspaceLayout,
  WorkspaceLayoutActions,
  WorkspacePaneState,
  WorkspaceSessionTab,
} from '@/shared/types';
import { writeSessionDragPayload } from '@/shared/utils';

/**
 * Dragging conversations and tabs onto the panes. Only a drag that carries the session payload
 * shows the drop zones (dragging a file does not). Unsplit, the right zone splits the workspace
 * and opens the conversation there as a kept tab. A tab dropped on the other pane moves there,
 * or with Alt held is copied; on a tab bar it lands at the insertion caret.
 */

const panes: { state: Record<string, unknown> } = { state: {} };
const NO_SESSIONS: ReadonlySet<string> = new Set();

vi.mock('@/modules/project-workspace/context/ProjectsStateContext', () => ({
  useProjectPanesState: () => panes.state,
}));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useBusySessionIdSet: () => NO_SESSIONS,
  useBackgroundSessionIdSet: () => NO_SESSIONS,
}));
vi.mock('@/modules/task-master', () => ({
  useTaskMasterProjectSync: () => undefined,
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }),
}));
vi.mock('@/modules/browser-use', () => ({ useBrowserUseEnabled: () => false }));
vi.mock('@/modules/plugins', () => ({ usePlugins: () => ({ plugins: [] }), PluginIcon: () => null }));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ connectionStatus: 'connected' }) }));
vi.mock('@/shared/context/UiPreferencesContext', () => ({ useUiPreferences: () => ({ sidebarVisible: true }) }));
vi.mock('@/modules/project-workspace/WorkspaceMain', () => ({
  default: ({ side }: { side: string }) => <textarea aria-label={`composer ${side}`} />,
}));

const { WorkspaceChromeProvider } = await import('@/modules/project-workspace/context/WorkspaceChromeContext');
const { default: ProjectMainRegion } = await import('@/modules/project-workspace/ProjectMainRegion');

const ALPHA: Project = { projectId: 'alpha', displayName: 'Alpha', fullPath: '/repo/alpha', sessions: [] };

const makeTab = (key: string, overrides: Partial<WorkspaceSessionTab> = {}): WorkspaceSessionTab => ({
  key,
  sessionId: `session-${key}`,
  projectId: 'alpha',
  provider: 'claude',
  title: `Chat ${key}`,
  view: 'chat',
  isPreview: false,
  session: { id: `session-${key}`, __projectId: 'alpha', __provider: 'claude' },
  ...overrides,
});

const makePane = (tabs: WorkspaceSessionTab[]): WorkspacePaneState => ({
  // Ids follow the first tab, so the two panes of a layout differ and a pane keeps its id across renders.
  id: `pane-${tabs[0]?.key ?? 'empty'}`,
  tabs,
  activeTabKey: tabs[0]?.key ?? null,
  mru: tabs[0] ? [tabs[0].key] : [],
  draftActivation: 0,
  externalRevision: 0,
});

const makeActions = (): WorkspaceLayoutActions => ({
  openSession: vi.fn(),
  openSessionById: vi.fn(),
  openNewSession: vi.fn(),
  establishDraft: vi.fn(),
  activateTab: vi.fn(),
  closeTab: vi.fn(),
  closeOtherTabs: vi.fn(),
  closeTabsToRight: vi.fn(),
  closeAllTabs: vi.fn(),
  pinTab: vi.fn(),
  moveTab: vi.fn(),
  setTabView: vi.fn(),
  focusPane: vi.fn(),
  split: vi.fn(),
  toggleSplit: vi.fn(),
  closePane: vi.fn(),
  setSplitRatio: vi.fn(),
});

let actions = makeActions();

const setLayout = (layout: WorkspaceLayout) => {
  panes.state = {
    layout,
    paneProjects: { left: ALPHA, right: layout.right ? ALPHA : null },
    projects: [ALPHA],
    isLoadingProjects: false,
    attentionSessionIds: NO_SESSIONS,
    fallbackProject: ALPHA,
    actions,
    openSettings: vi.fn(),
    setSidebarOpen: vi.fn(),
    renameSession: vi.fn(async () => true),
    refreshProjectsSilently: vi.fn(async () => undefined),
  };
};

const renderRegion = (canSplit = true) => render(
  <WorkspaceChromeProvider
    value={{
      isImmersive: false,
      isBrowserFullscreen: false,
      toggleImmersive: vi.fn(),
      exitImmersive: vi.fn(),
      isSidebarPeekOpen: false,
      setSidebarPeekOpen: vi.fn(),
      canSplit,
    }}
  >
    <ProjectMainRegion isMobile={false} ws={null} sendMessage={() => undefined} navigate={vi.fn() as unknown as NavigateFunction} />
  </WorkspaceChromeProvider>,
);

/** jsdom has no DataTransfer: a store with the methods and fields the drag handlers use. */
const makeDataTransfer = (extraTypes: string[] = []) => {
  const data = new Map<string, string>();
  return {
    get types() {
      return [...data.keys(), ...extraTypes];
    },
    getData: (type: string) => data.get(type) ?? '',
    setData: (type: string, value: string) => {
      data.set(type, value);
    },
    dropEffect: 'none',
    effectAllowed: 'uninitialized',
    files: [],
  };
};
type FakeDataTransfer = ReturnType<typeof makeDataTransfer>;

/** What a sidebar row writes when dragged. */
const rowTransfer = (payload: SessionDragPayload) => {
  const dataTransfer = makeDataTransfer();
  writeSessionDragPayload(dataTransfer as unknown as DataTransfer, payload, `/session/${payload.sessionId}`);
  return dataTransfer;
};

/** jsdom has no DragEvent either: fields such as altKey and clientX are set on the plain event. */
const fireDrag = (
  element: Element,
  type: 'dragStart' | 'dragEnter' | 'dragOver' | 'dragLeave' | 'drop',
  dataTransfer: FakeDataTransfer,
  fields: Record<string, unknown> = {},
) => {
  const event = createEvent[type](element, { dataTransfer });
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(event, key, { value });
  }
  fireEvent(element, event);
  return event;
};

const group = () => document.querySelector('[data-workspace-pane-group]') as HTMLElement;
const pane = (side: 'left' | 'right') => document.querySelector(`[data-workspace-pane="${side}"]`) as HTMLElement;
const bar = (side: 'left' | 'right') => document.querySelector(`[data-pane-tab-bar="${side}"]`) as HTMLElement;
const zone = (paneSide: 'left' | 'right', zoneSide: 'left' | 'right') =>
  pane(paneSide).querySelector(`[data-drop-zone="${zoneSide}"]`) as HTMLElement;
const isOverlayShown = () => document.querySelector('[data-pane-drop-overlay]') !== null;

const ROW_PAYLOAD: SessionDragPayload = { sessionId: 'session-row', projectId: 'alpha', provider: 'claude', title: 'From the sidebar' };

beforeEach(() => {
  actions = makeActions();
});

test('only a drag carrying a conversation shows the drop zones; dragging a file does not', () => {
  setLayout({ left: makePane([makeTab('a1')]), right: null, focusedSide: 'left', splitRatio: 0.5 });
  renderRegion();

  const files = makeDataTransfer(['Files']);
  fireDrag(group(), 'dragEnter', files);
  fireDrag(group(), 'dragOver', files);
  assert.equal(isOverlayShown(), false, 'a file drag leaves the composer alone');

  fireDrag(group(), 'dragEnter', rowTransfer(ROW_PAYLOAD));
  assert.equal(isOverlayShown(), true);
  const leftPane = pane('left');
  assert.ok(within(leftPane).getByText('Open here'));
  assert.ok(within(leftPane).getByText('Open on the right (split)'));
});

test('unsplit, a conversation dropped on the right half splits and opens there as a kept tab', () => {
  setLayout({ left: makePane([makeTab('a1')]), right: null, focusedSide: 'left', splitRatio: 0.5 });
  renderRegion();
  const transfer = rowTransfer(ROW_PAYLOAD);

  fireDrag(group(), 'dragEnter', transfer);
  const drop = fireDrag(zone('left', 'right'), 'drop', transfer);

  assert.equal(drop.defaultPrevented, true, 'nothing underneath gets the drop');
  // The row's title travels along, so a conversation the loaded pages lack still has one in its tab and header.
  assert.deepEqual(vi.mocked(actions.openSession).mock.calls, [[
    { id: 'session-row', __projectId: 'alpha', __provider: 'claude', summary: 'From the sidebar' },
    { target: 'right', preview: false },
  ]]);
  assert.equal(isOverlayShown(), false, 'the zones go away after the drop');

  fireDrag(group(), 'dragEnter', transfer);
  fireDrag(zone('left', 'left'), 'drop', transfer);
  assert.deepEqual(vi.mocked(actions.openSession).mock.calls[1][1], { target: 'left', preview: false });
});

test('the zones go when the drag leaves the panes or ends, and stay while it moves between them', async () => {
  setLayout({ left: makePane([makeTab('a1')]), right: null, focusedSide: 'left', splitRatio: 0.5 });
  renderRegion();
  const transfer = rowTransfer(ROW_PAYLOAD);

  fireDrag(group(), 'dragEnter', transfer);
  fireDrag(group(), 'dragLeave', transfer, { relatedTarget: zone('left', 'left') });
  assert.equal(isOverlayShown(), true, 'moving onto a zone inside the panes keeps them');

  fireDrag(group(), 'dragLeave', transfer, { relatedTarget: document.body });
  assert.equal(isOverlayShown(), false);

  fireDrag(group(), 'dragEnter', transfer);
  fireEvent.dragEnd(document.body);
  // Cleared on the next task, once the drag's events have all been handed out.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(isOverlayShown(), false, 'a cancelled drag clears them');
});

test('a drop clears the zones only after the next task, so a zone still gets the drop a browser hands it', async () => {
  setLayout({ left: makePane([makeTab('a1')]), right: null, focusedSide: 'left', splitRatio: 0.5 });
  renderRegion();
  fireDrag(group(), 'dragEnter', rowTransfer(ROW_PAYLOAD));

  // A browser runs the window's capture listener first, then microtasks (where React commits a
  // discrete event's update), then hands the drop to the zone. Dispatched outside act, as a browser
  // does it. React takes an update's priority from window.event, which jsdom leaves at the previous
  // event here, so the test sets it to the drop the way a browser does during dispatch.
  const drop = new Event('drop', { bubbles: true });
  Object.defineProperty(window, 'event', { configurable: true, get: () => drop });
  try {
    document.body.dispatchEvent(drop);
  } finally {
    Reflect.deleteProperty(window, 'event');
  }
  // Microtasks only, outside act: an async act also waits out a task, which is when the zones go.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(isOverlayShown(), true, 'the zones outlast the microtasks between listeners');

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(isOverlayShown(), false, 'and go on the next task');
});

test('a tab dropped on the other pane moves there, with Alt it is copied, and on its own pane nothing happens', () => {
  setLayout({
    left: makePane([makeTab('a1'), makeTab('a2')]),
    right: makePane([makeTab('b1')]),
    focusedSide: 'left',
    splitRatio: 0.5,
  });
  renderRegion();

  const dragTab = (fields: Record<string, unknown>, targetPane: 'left' | 'right') => {
    const transfer = makeDataTransfer();
    fireDrag(within(bar('left')).getByRole('tab', { name: /Chat a2/ }), 'dragStart', transfer);
    assert.equal(transfer.effectAllowed, 'copyMove');
    fireDrag(group(), 'dragEnter', transfer);
    fireDrag(zone(targetPane, targetPane), 'drop', transfer, fields);
  };

  dragTab({ altKey: false }, 'right');
  dragTab({ altKey: true }, 'right');
  dragTab({ altKey: false }, 'left');

  assert.deepEqual(vi.mocked(actions.moveTab).mock.calls, [
    ['left', 'a2', 'right', { copy: false }],
    ['left', 'a2', 'right', { copy: true }],
  ]);
});

test('dragging a preview tab keeps it, and the drag stays a link outside the app', () => {
  setLayout({ left: makePane([makeTab('a1'), makeTab('a2', { isPreview: true })]), right: null, focusedSide: 'left', splitRatio: 0.5 });
  renderRegion();
  const transfer = makeDataTransfer();

  fireDrag(within(bar('left')).getByRole('tab', { name: /Chat a2/ }), 'dragStart', transfer);

  assert.deepEqual(vi.mocked(actions.pinTab).mock.calls, [['left', 'a2']]);
  assert.match(transfer.getData('text/uri-list'), /\/session\/session-a2$/);
});

test('on a tab bar a dragged tab lands at the caret, and a sidebar conversation opens kept on that side', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function measure(this: HTMLElement) {
    // Tabs are 100px wide, side by side from the strip's left edge.
    const index = this.getAttribute('role') === 'tab' ? Array.from(this.parentElement?.children ?? []).indexOf(this) : -1;
    const left = Math.max(0, index) * 100;
    const width = index >= 0 ? 100 : 0;
    return { x: left, y: 0, left, top: 0, right: left + width, bottom: 36, width, height: 36, toJSON: () => ({}) } as DOMRect;
  });
  setLayout({
    left: makePane([makeTab('a1'), makeTab('a2'), makeTab('a3')]),
    right: makePane([makeTab('b1')]),
    focusedSide: 'left',
    splitRatio: 0.5,
  });
  renderRegion();

  // a1 dragged past a3 (the pointer right of a3's middle) goes last: index 2 among the other tabs.
  let transfer = makeDataTransfer();
  fireDrag(within(bar('left')).getByRole('tab', { name: /Chat a1/ }), 'dragStart', transfer);
  fireDrag(bar('left'), 'dragOver', transfer, { clientX: 120 });
  const a2 = within(bar('left')).getByRole('tab', { name: /Chat a2/ });
  assert.ok(a2.querySelector('[data-drop-caret="before"]'), 'the caret shows before a2');
  fireDrag(bar('left'), 'drop', transfer, { clientX: 260 });
  assert.equal(document.querySelector('[data-drop-caret]') === null, true, 'the caret goes after the drop');

  // Dropped right back where it was: nothing to do.
  transfer = makeDataTransfer();
  fireDrag(within(bar('left')).getByRole('tab', { name: /Chat a1/ }), 'dragStart', transfer);
  fireDrag(bar('left'), 'drop', transfer, { clientX: 120 });

  // A right tab dropped between a1 and a2 of the left bar.
  transfer = makeDataTransfer();
  fireDrag(within(bar('right')).getByRole('tab', { name: /Chat b1/ }), 'dragStart', transfer);
  fireDrag(bar('left'), 'drop', transfer, { clientX: 120, altKey: false });

  assert.deepEqual(vi.mocked(actions.moveTab).mock.calls, [
    ['left', 'a1', 'left', { index: 2 }],
    ['right', 'b1', 'left', { index: 1, copy: false }],
  ]);

  fireDrag(bar('right'), 'drop', rowTransfer(ROW_PAYLOAD), { clientX: 10 });
  assert.deepEqual(vi.mocked(actions.openSession).mock.calls, [[
    { id: 'session-row', __projectId: 'alpha', __provider: 'claude', summary: 'From the sidebar' },
    { target: 'right', preview: false },
  ]]);
});

test('side by side each pane offers its own side; collapsed the visible pane offers both; without room only "here"', () => {
  const split = (): WorkspaceLayout => ({
    left: makePane([makeTab('a1')]),
    right: makePane([makeTab('b1')]),
    focusedSide: 'left',
    splitRatio: 0.5,
  });
  const zonesIn = (side: 'left' | 'right') => Array.from(pane(side).querySelectorAll('[data-drop-zone]'))
    .map((element) => `${element.getAttribute('data-drop-zone')}:${element.textContent}`);
  const transfer = rowTransfer(ROW_PAYLOAD);

  setLayout(split());
  const sideBySide = renderRegion(true);
  fireDrag(group(), 'dragEnter', transfer);
  assert.deepEqual(zonesIn('left'), ['left:Open on the left'], 'the zones line up with the divider');
  assert.deepEqual(zonesIn('right'), ['right:Open on the right']);
  sideBySide.unmount();

  setLayout(split());
  const collapsed = renderRegion(false);
  fireDrag(group(), 'dragEnter', transfer);
  assert.deepEqual(zonesIn('left'), ['left:Open on the left', 'right:Open on the right']);
  assert.deepEqual(zonesIn('right'), [], 'the hidden pane shows no zones');
  fireDrag(zone('left', 'right'), 'drop', transfer);
  assert.deepEqual(vi.mocked(actions.openSession).mock.calls[0][1], { target: 'right', preview: false }, 'a drop can land on the hidden side');
  collapsed.unmount();

  setLayout({ left: makePane([makeTab('a1')]), right: null, focusedSide: 'left', splitRatio: 0.5 });
  renderRegion(false);
  fireDrag(group(), 'dragEnter', transfer);
  assert.deepEqual(zonesIn('left'), ['left:Open here'], 'no room to split, no right zone');
});

test('right to left the zones are named after where they are drawn: the first pane is on the right', () => {
  // What <html dir="rtl"> computes in a browser; jsdom neither maps dir to direction nor inherits it.
  const style = document.createElement('style');
  style.textContent = '[dir="rtl"], [dir="rtl"] * { direction: rtl; }';
  document.head.append(style);
  document.documentElement.setAttribute('dir', 'rtl');
  try {
    const zonesIn = (side: 'left' | 'right') => Array.from(pane(side).querySelectorAll('[data-drop-zone]'))
      .map((element) => `${element.getAttribute('data-drop-zone')}:${element.textContent}`);
    const transfer = rowTransfer(ROW_PAYLOAD);

    setLayout({ left: makePane([makeTab('a1')]), right: null, focusedSide: 'left', splitRatio: 0.5 });
    const unsplit = renderRegion();
    fireDrag(group(), 'dragEnter', transfer);
    assert.deepEqual(zonesIn('left'), ['left:Open here', 'right:Open on the left (split)'], 'the new pane opens on the left');
    unsplit.unmount();

    setLayout({ left: makePane([makeTab('a1')]), right: makePane([makeTab('b1')]), focusedSide: 'left', splitRatio: 0.5 });
    renderRegion(false);
    fireDrag(group(), 'dragEnter', transfer);
    assert.deepEqual(zonesIn('left'), ['left:Open on the right', 'right:Open on the left']);
    fireDrag(zone('left', 'left'), 'drop', transfer);
    assert.deepEqual(vi.mocked(actions.openSession).mock.calls[0][1], { target: 'left', preview: false }, 'still the first pane');
  } finally {
    document.documentElement.removeAttribute('dir');
    style.remove();
  }
});

test('a conversation dragged from the sidebar over a tab bar gets no insertion caret; only a dragged tab lands at a position', () => {
  setLayout({ left: makePane([makeTab('a1'), makeTab('a2')]), right: null, focusedSide: 'left', splitRatio: 0.5 });
  renderRegion();

  const row = rowTransfer(ROW_PAYLOAD);
  const over = fireDrag(bar('left'), 'dragOver', row, { clientX: 500 });
  assert.equal(over.defaultPrevented, true, 'the bar still takes the drop');
  assert.equal(document.querySelector('[data-drop-caret]') === null, true, 'no caret promising a position the open will not honour');

  const tabDrag = makeDataTransfer();
  fireDrag(within(bar('left')).getByRole('tab', { name: /Chat a1/ }), 'dragStart', tabDrag);
  fireDrag(bar('left'), 'dragOver', tabDrag, { clientX: 500 });
  assert.equal(document.querySelector('[data-drop-caret]') !== null, true);
});
