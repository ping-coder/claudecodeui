import assert from 'node:assert/strict';

import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useWorkspaceShortcuts } from '@/modules/project-workspace/hooks/useWorkspaceShortcuts';
import type {
  AppTab,
  WorkspaceLayout,
  WorkspaceLayoutActions,
  WorkspacePaneState,
  WorkspaceSessionTab,
} from '@/shared/types';

/**
 * The workspace shortcuts have one registration point: a window keydown listener in the capture
 * phase, so the terminal (xterm stops propagation of the keys it handles) and the editors cannot
 * swallow them first. Mod is Ctrl here unless a test switches the platform to Apple (Command).
 */

type HarnessProps = {
  isMobile?: boolean;
  canSplit?: boolean;
  layout: WorkspaceLayout;
  hiddenRightComposer?: boolean;
};

const actions = {
  focusPane: vi.fn<WorkspaceLayoutActions['focusPane']>(),
  split: vi.fn<WorkspaceLayoutActions['split']>(),
  toggleSplit: vi.fn<WorkspaceLayoutActions['toggleSplit']>(),
};
const toggleImmersive = vi.fn<() => void>();
// Animation frames requested by the hook, run by hand to move DOM focus after a pane change.
const frames: FrameRequestCallback[] = [];

const tab = (key: string, view: AppTab): WorkspaceSessionTab => ({
  key,
  sessionId: key,
  projectId: 'project-1',
  provider: 'claude',
  title: key,
  view,
  isPreview: false,
  session: null,
});

const pane = (tabs: WorkspaceSessionTab[]): WorkspacePaneState => ({
  id: `pane-${tabs[0]?.key ?? 'empty'}`,
  tabs,
  activeTabKey: tabs[0]?.key ?? null,
  mru: tabs.map((paneTab) => paneTab.key),
  draftActivation: 0,
  externalRevision: 0,
});

const UNSPLIT: WorkspaceLayout = {
  left: pane([tab('left-session', 'chat')]),
  right: null,
  focusedSide: 'left',
  splitRatio: 0.5,
};

const splitLayout = (rightView: AppTab | null, focusedSide: 'left' | 'right' = 'left'): WorkspaceLayout => ({
  left: pane([tab('left-session', 'chat')]),
  right: pane(rightView ? [tab('right-session', rightView)] : []),
  focusedSide,
  splitRatio: 0.5,
});

// Pane roots as WorkspacePane renders them: not focusable until a shortcut lends them a tabindex.
function ShortcutsHarness({ isMobile = false, canSplit = true, layout, hiddenRightComposer = false }: HarnessProps) {
  useWorkspaceShortcuts({ isMobile, canSplit, layout, actions, toggleImmersive });
  return (
    <div>
      <div data-workspace-pane="left" role="group">
        <textarea data-slot="prompt-input-textarea" aria-label="left composer" />
        <p>left transcript text</p>
      </div>
      {layout.right && (
        <div data-workspace-pane="right" role="group">
          {/* disabled stands in for display:none (an editor expanded over the chat): focus() does nothing. */}
          <textarea data-slot="prompt-input-textarea" aria-label="right composer" disabled={hiddenRightComposer} />
        </div>
      )}
      <div className="xterm">
        <textarea className="xterm-helper-textarea" aria-label="terminal input" />
      </div>
    </div>
  );
}

const renderShortcuts = (props: HarnessProps) => {
  const view = render(<ShortcutsHarness {...props} />);
  return {
    ...view,
    rerenderWith: (next: HarnessProps) => view.rerender(<ShortcutsHarness {...next} />),
  };
};

/** Dispatches a keydown the way the browser does (bubbling, cancelable) and returns it for inspection. */
const press = (init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};

const MOD_BACKSLASH: KeyboardEventInit = { code: 'Backslash', key: '\\', ctrlKey: true };
const MOD_1: KeyboardEventInit = { code: 'Digit1', key: '1', ctrlKey: true };
const MOD_2: KeyboardEventInit = { code: 'Digit2', key: '2', ctrlKey: true };
const MOD_SHIFT_ENTER: KeyboardEventInit = { code: 'Enter', key: 'Enter', ctrlKey: true, shiftKey: true };

const runFrames = () => {
  act(() => {
    frames.splice(0).forEach((frame) => frame(0));
  });
};

const actionCalls = () => ({
  focusPane: actions.focusPane.mock.calls.length,
  split: actions.split.mock.calls.length,
  toggleSplit: actions.toggleSplit.mock.calls.length,
  toggleImmersive: toggleImmersive.mock.calls.length,
});
const NO_CALLS = { focusPane: 0, split: 0, toggleSplit: 0, toggleImmersive: 0 };

const terminalInput = () => document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
const paneRoot = (side: 'left' | 'right') => document.querySelector(`[data-workspace-pane="${side}"]`) as HTMLElement;
const composer = (side: 'left' | 'right') => paneRoot(side).querySelector('textarea') as HTMLTextAreaElement;
// Names the focused element rather than comparing nodes: a failed assertion on a jsdom node makes
// node:assert inspect the whole DOM tree, which can hang the worker.
const focusedElement = (): string => {
  const active = document.activeElement;
  if (!active || active === document.body) {
    return 'body';
  }
  const paneSide = active.getAttribute('data-workspace-pane');
  return active.getAttribute('aria-label') ?? (paneSide ? `${paneSide} pane` : active.tagName);
};

const useApplePlatform = () => {
  Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' });
};

beforeEach(() => {
  actions.focusPane.mockReset();
  actions.split.mockReset();
  actions.toggleSplit.mockReset();
  toggleImmersive.mockReset();
  frames.length = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'platform');
});

test('Mod+\\ splits when the main column has room, and merges once split', () => {
  const { rerenderWith } = renderShortcuts({ layout: UNSPLIT, canSplit: true });

  const splitPress = press(MOD_BACKSLASH);
  assert.equal(actions.toggleSplit.mock.calls.length, 1);
  assert.equal(splitPress.defaultPrevented, true);

  // Merging needs no room, so it still works where splitting would not.
  rerenderWith({ layout: splitLayout('chat'), canSplit: false });
  press(MOD_BACKSLASH);
  assert.equal(actions.toggleSplit.mock.calls.length, 2);
});

test('Mod+\\ with no room to split and nothing to merge stays with the page', () => {
  renderShortcuts({ layout: UNSPLIT, canSplit: false });

  const event = press(MOD_BACKSLASH);

  assert.deepEqual(actionCalls(), NO_CALLS);
  assert.equal(event.defaultPrevented, false);
});

test('Mod+1 focuses the left pane and puts the caret in its composer on the Chat view', () => {
  renderShortcuts({ layout: splitLayout('files', 'right') });

  const event = press(MOD_1, composer('right'));
  assert.deepEqual(actions.focusPane.mock.calls, [['left']]);
  assert.equal(event.defaultPrevented, true);

  runFrames();
  assert.equal(focusedElement(), 'left composer');
});

test('Mod+2 focuses the right pane; off the Chat view the pane itself takes focus', () => {
  renderShortcuts({ layout: splitLayout('files') });

  press(MOD_2);
  assert.deepEqual(actions.focusPane.mock.calls, [['right']]);
  assert.equal(actions.split.mock.calls.length, 0);

  runFrames();
  assert.equal(focusedElement(), 'right pane');
});

test('Mod+2 on the Chat view lands in the right composer', () => {
  renderShortcuts({ layout: splitLayout('chat') });

  press(MOD_2);
  runFrames();

  assert.equal(focusedElement(), 'right composer');
});

test('unsplit, Mod+1 and Mod+2 stay with the browser, which switches its tabs with them', () => {
  renderShortcuts({ layout: UNSPLIT, canSplit: true });

  const events = [press(MOD_1), press(MOD_2), press({ ...MOD_2, repeat: true })];
  runFrames();

  assert.deepEqual(actionCalls(), NO_CALLS);
  assert.equal(events.some((event) => event.defaultPrevented), false);
  assert.equal(focusedElement(), 'body');
});

test('Mod+2 with no room and no right pane stays with the browser', () => {
  renderShortcuts({ layout: UNSPLIT, canSplit: false });

  const event = press(MOD_2);

  assert.deepEqual(actionCalls(), NO_CALLS);
  assert.equal(event.defaultPrevented, false);
});

test('Mod+Shift+Enter toggles full screen, from either Enter key', () => {
  renderShortcuts({ layout: UNSPLIT });

  const event = press(MOD_SHIFT_ENTER, composer('left'));
  press({ ...MOD_SHIFT_ENTER, code: 'NumpadEnter' });

  assert.equal(toggleImmersive.mock.calls.length, 2);
  assert.equal(event.defaultPrevented, true);
});

test('on Apple platforms Mod is Command, and Control does not match', () => {
  useApplePlatform();
  renderShortcuts({ layout: UNSPLIT, canSplit: true });

  press(MOD_BACKSLASH);
  assert.equal(actions.toggleSplit.mock.calls.length, 0);

  press({ code: 'Backslash', key: '\\', metaKey: true });
  assert.equal(actions.toggleSplit.mock.calls.length, 1);
});

test('extra modifiers do not match (AltGr is Ctrl+Alt on Windows)', () => {
  renderShortcuts({ layout: splitLayout('chat') });

  press({ ...MOD_BACKSLASH, altKey: true });
  press({ ...MOD_1, shiftKey: true });
  press({ ...MOD_2, metaKey: true });
  press({ ...MOD_SHIFT_ENTER, shiftKey: false });

  assert.deepEqual(actionCalls(), NO_CALLS);
});

test('ignored while a dialog, a menu or another Escape layer is open', () => {
  renderShortcuts({ layout: UNSPLIT, canSplit: true });

  for (const attribute of ['aria-modal', 'role', 'data-escape-layer'] as const) {
    const layer = document.createElement('div');
    layer.setAttribute(attribute, attribute === 'aria-modal' ? 'true' : attribute === 'role' ? 'menu' : '');
    document.body.appendChild(layer);

    const event = press(MOD_SHIFT_ENTER);
    press(MOD_BACKSLASH);

    layer.remove();
    assert.equal(event.defaultPrevented, false, attribute);
  }
  assert.deepEqual(actionCalls(), NO_CALLS);
});

test('ignored while an IME is composing', () => {
  renderShortcuts({ layout: UNSPLIT, canSplit: true });

  const event = press({ ...MOD_BACKSLASH, isComposing: true }, composer('left'));

  assert.deepEqual(actionCalls(), NO_CALLS);
  assert.equal(event.defaultPrevented, false);
});

test('ignored when an earlier handler already consumed the key', () => {
  const consume = (event: KeyboardEvent) => event.preventDefault();
  window.addEventListener('keydown', consume, { capture: true });
  try {
    renderShortcuts({ layout: UNSPLIT, canSplit: true });

    press(MOD_BACKSLASH);
    press(MOD_SHIFT_ENTER);

    assert.deepEqual(actionCalls(), NO_CALLS);
  } finally {
    window.removeEventListener('keydown', consume, { capture: true });
  }
});

test('ignored on phones', () => {
  renderShortcuts({ layout: splitLayout('chat'), isMobile: true, canSplit: false });

  const events = [press(MOD_BACKSLASH), press(MOD_1), press(MOD_2), press(MOD_SHIFT_ENTER)];

  assert.deepEqual(actionCalls(), NO_CALLS);
  assert.equal(events.some((event) => event.defaultPrevented), false);
});

test('a held key acts once; its repeats are only kept from the browser and the focused field', () => {
  renderShortcuts({ layout: splitLayout('chat') });

  press(MOD_SHIFT_ENTER);
  const repeats = [press({ ...MOD_SHIFT_ENTER, repeat: true }), press({ ...MOD_SHIFT_ENTER, repeat: true })];
  const focusRepeat = press({ ...MOD_2, repeat: true });

  assert.equal(toggleImmersive.mock.calls.length, 1);
  assert.equal(actions.focusPane.mock.calls.length, 0);
  // Not acting on a repeat must not hand it to the browser either (Ctrl+2 would switch browser tabs).
  assert.equal(repeats.every((event) => event.defaultPrevented), true);
  assert.equal(focusRepeat.defaultPrevented, true);
});

test('a terminal stopping propagation in the bubble phase cannot hide the keys', () => {
  renderShortcuts({ layout: splitLayout('chat') });
  // xterm handles keys on its own element and stops them there.
  const terminal = document.querySelector('.xterm') as HTMLElement;
  const terminalKeyDown = vi.fn((event: KeyboardEvent) => event.stopPropagation());
  terminal.addEventListener('keydown', terminalKeyDown);

  press(MOD_SHIFT_ENTER, terminalInput());
  press(MOD_1, terminalInput());

  assert.equal(toggleImmersive.mock.calls.length, 1);
  assert.deepEqual(actions.focusPane.mock.calls, [['left']]);
  // Handled keys are stopped before they reach the terminal.
  assert.equal(terminalKeyDown.mock.calls.length, 0);
});

test('Ctrl+\\ in the terminal is SIGQUIT on Windows and Linux, so it reaches the terminal', () => {
  renderShortcuts({ layout: UNSPLIT, canSplit: true });
  const terminal = document.querySelector('.xterm') as HTMLElement;
  const terminalKeyDown = vi.fn();
  terminal.addEventListener('keydown', terminalKeyDown);

  const event = press(MOD_BACKSLASH, terminalInput());

  assert.equal(actions.toggleSplit.mock.calls.length, 0);
  assert.equal(event.defaultPrevented, false);
  assert.equal(terminalKeyDown.mock.calls.length, 1);
});

test('Cmd+\\ in the terminal still splits on Apple platforms', () => {
  useApplePlatform();
  renderShortcuts({ layout: UNSPLIT, canSplit: true });

  press({ code: 'Backslash', key: '\\', metaKey: true }, terminalInput());

  assert.equal(actions.toggleSplit.mock.calls.length, 1);
});

test('one listener for the life of the workspace, removed on unmount', () => {
  const addListener = vi.spyOn(window, 'addEventListener');
  const { rerenderWith, unmount } = renderShortcuts({ layout: UNSPLIT, canSplit: true });
  rerenderWith({ layout: splitLayout('chat'), canSplit: false });
  rerenderWith({ layout: UNSPLIT, canSplit: true });

  const keydownRegistrations = addListener.mock.calls.filter(([type]) => type === 'keydown');
  assert.equal(keydownRegistrations.length, 1);
  // The listener reads the newest props: canSplit is true again.
  press(MOD_BACKSLASH);
  assert.equal(actions.toggleSplit.mock.calls.length, 1);

  unmount();
  press(MOD_BACKSLASH);
  assert.equal(actions.toggleSplit.mock.calls.length, 1);
});

test('after Mod+\\ DOM focus follows the pane focus: into the new pane on a split, into the one that stays on a merge', () => {
  const { rerenderWith } = renderShortcuts({ layout: UNSPLIT, canSplit: true });
  composer('left').focus();

  press(MOD_BACKSLASH, composer('left'));
  // The split renders the new, empty right pane (focused) before the focus frame runs.
  rerenderWith({ layout: splitLayout(null, 'right'), canSplit: true });
  runFrames();
  assert.equal(focusedElement(), 'right pane', 'Ctrl/Cmd+S and Escape now reach the focused pane, not the left editor');

  press(MOD_BACKSLASH);
  rerenderWith({ layout: UNSPLIT, canSplit: true });
  runFrames();
  assert.equal(focusedElement(), 'left composer');

  // Focus already inside the pane that stays is left where it is.
  const transcriptButton = document.createElement('button');
  transcriptButton.textContent = 'tool card';
  paneRoot('left').appendChild(transcriptButton);
  transcriptButton.focus();
  rerenderWith({ layout: splitLayout('chat', 'left'), canSplit: true });
  press(MOD_BACKSLASH, transcriptButton);
  rerenderWith({ layout: UNSPLIT, canSplit: true });
  runFrames();
  assert.equal(focusedElement(), 'BUTTON');
  transcriptButton.remove();
});

test('Mod+2 lands on the pane itself when its composer cannot take focus (an editor expanded over the chat)', () => {
  renderShortcuts({ layout: splitLayout('chat'), hiddenRightComposer: true });
  composer('left').focus();

  press(MOD_2, composer('left'));
  runFrames();

  assert.equal(focusedElement(), 'right pane', 'focus does not stay behind in the left composer');
});

test('a pane root is focusable only while a shortcut put focus there: a press inside or leaving gives the tabindex back', () => {
  renderShortcuts({ layout: splitLayout('files') });
  assert.equal(paneRoot('right').hasAttribute('tabindex'), false);

  press(MOD_2);
  runFrames();
  assert.equal(focusedElement(), 'right pane');
  assert.equal(paneRoot('right').getAttribute('tabindex'), '-1');

  // A press on plain text in the pane must not park focus on the root (keyboard scrolling stops there).
  fireEvent.pointerDown(paneRoot('right'));
  assert.equal(paneRoot('right').hasAttribute('tabindex'), false);

  press(MOD_2);
  runFrames();
  assert.equal(paneRoot('right').getAttribute('tabindex'), '-1');
  composer('left').focus();
  assert.equal(paneRoot('right').hasAttribute('tabindex'), false, 'focus moving on gives it back too');
});

test('the immersive sidebar drawer (a non-modal dialog) owns Escape only: the workspace keys still work under it', () => {
  renderShortcuts({ layout: splitLayout('chat'), canSplit: true });
  const drawer = document.createElement('div');
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('data-escape-layer', '');
  document.body.appendChild(drawer);
  try {
    const focusRight = press(MOD_2);
    const fullScreen = press(MOD_SHIFT_ENTER);
    assert.deepEqual(actions.focusPane.mock.calls, [['right']]);
    assert.equal(toggleImmersive.mock.calls.length, 1);
    assert.equal(focusRight.defaultPrevented && fullScreen.defaultPrevented, true);

    // A modal dialog over it owns the whole keyboard; a pane key is still kept from the browser.
    drawer.setAttribute('aria-modal', 'true');
    const blocked = press(MOD_1);
    assert.equal(actions.focusPane.mock.calls.length, 1, 'not acted on');
    assert.equal(blocked.defaultPrevented, true, 'and not handed to the browser to switch tabs');
  } finally {
    drawer.remove();
  }
});
