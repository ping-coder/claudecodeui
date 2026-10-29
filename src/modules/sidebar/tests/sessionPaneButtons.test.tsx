import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import type { Project, SessionPanePlacement, SessionWithProvider, SidebarProjectListProps, WorkspacePaneSide } from '@/shared/types';

/**
 * The side buttons beside a row's "…": ◨ "open on the right (split view)" while
 * unsplit, ◧ ◨ once split, pressed for the side(s) the session is already on, and
 * absent wherever sides cannot be targeted. The "…" menu leads with the same
 * absolute sides, which is how touch screens choose one. Labels are asserted by
 * key, so the right string is shown in every language.
 */

vi.mock('@/shared/api', () => ({
  api: {
    providerSessionId: () => Promise.resolve({ ok: false, json: async () => ({}) }),
  },
}));

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useSessionForkingProviders: () => new Set(),
}));

const { default: SessionPaneButtons, PanePlacementMarker } = await import('@/modules/sidebar/SessionPaneButtons');
const { default: SessionOptions } = await import('@/modules/sidebar/SessionOptions');
const { default: SidebarSessionItem } = await import('@/modules/sidebar/SidebarSessionItem');

const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const noop = () => {};

const renderButtons = (props: {
  canTargetSides?: boolean;
  isWorkspaceSplit: boolean;
  panePlacement: SessionPanePlacement;
  onOpenInPane?: (side: WorkspacePaneSide) => void;
}) => render(
  <SessionPaneButtons
    canTargetSides={props.canTargetSides ?? true}
    isWorkspaceSplit={props.isWorkspaceSplit}
    panePlacement={props.panePlacement}
    onOpenInPane={props.onOpenInPane ?? noop}
    t={t}
  />,
);

const sideButton = (container: HTMLElement, side: WorkspacePaneSide) =>
  container.querySelector<HTMLButtonElement>(`button[data-pane-side="${side}"]`);

afterEach(() => {
  vi.useRealTimers();
});

test('unsplit, a single button opens the session on the right and splits', () => {
  const onOpenInPane = vi.fn();
  const { container } = renderButtons({ isWorkspaceSplit: false, panePlacement: 'left', onOpenInPane });

  const buttons = container.querySelectorAll('button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].getAttribute('aria-label'), 'sessions.openOnRightSplit');
  assert.equal(buttons[0].hasAttribute('aria-pressed'), false, 'an action while unsplit, not a toggle');

  fireEvent.click(buttons[0]);
  assert.deepEqual(onOpenInPane.mock.calls, [['right']]);
});

test('split, ◧ and ◨ are pressed for the side or sides the session is on', () => {
  const expectations: Array<[SessionPanePlacement, string, string]> = [
    ['left', 'true', 'false'],
    ['right', 'false', 'true'],
    ['both', 'true', 'true'],
    [null, 'false', 'false'],
  ];

  for (const [placement, leftPressed, rightPressed] of expectations) {
    const { container, unmount } = renderButtons({ isWorkspaceSplit: true, panePlacement: placement });
    assert.equal(container.querySelectorAll('button').length, 2);
    assert.equal(sideButton(container, 'left')?.getAttribute('aria-label'), 'sessions.openOnLeft');
    assert.equal(sideButton(container, 'right')?.getAttribute('aria-label'), 'sessions.openOnRight');
    assert.equal(sideButton(container, 'left')?.getAttribute('aria-pressed'), leftPressed, `left for ${placement}`);
    assert.equal(sideButton(container, 'right')?.getAttribute('aria-pressed'), rightPressed, `right for ${placement}`);
    unmount();
  }
});

test('a pressed side still opens there: that is how one session gets onto both sides', () => {
  const onOpenInPane = vi.fn();
  const { container } = renderButtons({ isWorkspaceSplit: true, panePlacement: 'left', onOpenInPane });

  fireEvent.click(sideButton(container, 'left') as HTMLButtonElement);
  fireEvent.click(sideButton(container, 'right') as HTMLButtonElement);

  assert.deepEqual(onOpenInPane.mock.calls, [['left'], ['right']]);
});

test('nothing renders where sides cannot be targeted', () => {
  const { container } = renderButtons({ canTargetSides: false, isWorkspaceSplit: true, panePlacement: 'left' });

  assert.equal(container.innerHTML, '');
});

test('the buttons stay out of sight and out of reach until the row is hovered or keyboard-focused', () => {
  const { container } = renderButtons({ isWorkspaceSplit: true, panePlacement: null });
  const group = container.firstElementChild as HTMLElement;

  for (const className of [
    'invisible',
    'opacity-0',
    'group-hover:visible',
    'group-hover:opacity-100',
    'group-has-[:focus-visible]:visible',
    'group-has-[:focus-visible]:opacity-100',
  ]) {
    assert.ok(group.classList.contains(className), className);
  }
  // A mouse click focuses the row's link as well; that must not pin the buttons over its time label.
  assert.ok(![...group.classList].some((className) => className.startsWith('group-focus-within:')));
  for (const button of group.querySelectorAll('button')) {
    assert.ok(button.className.includes('bg-'), 'an opaque background over the row it covers');
  }
});

test('touch screens never get the buttons: the menu and the Open-in switch choose a side there', () => {
  const { container } = renderButtons({ isWorkspaceSplit: true, panePlacement: null });
  const group = container.firstElementChild as HTMLElement;

  assert.ok(group.classList.contains('[@media(pointer:coarse)]:hidden'));
  assert.ok(![...group.classList].some((className) => className.includes('touch:')), 'not shown permanently on touch screens');
});

/** Hovers a side button long enough for its tooltip, and returns the tooltip's text. */
const readTooltip = (container: HTMLElement, side: WorkspacePaneSide): string => {
  const button = sideButton(container, side) as HTMLButtonElement;
  fireEvent.mouseEnter(container.firstElementChild as HTMLElement);
  fireEvent.mouseEnter(button.parentElement as HTMLElement);
  act(() => {
    vi.advanceTimersByTime(400);
  });
  const text = document.body.querySelector('.pointer-events-none.whitespace-nowrap')?.textContent ?? '';
  fireEvent.mouseLeave(button.parentElement as HTMLElement);
  return text;
};

test('the Alt+click hint is on the side an Alt+click on the row would open', () => {
  vi.useFakeTimers();

  // The sidebar marks the focused pane on its root; Alt+click opens on the other one.
  const { container } = render(
    <div data-focused-pane-side="right">
      <SessionPaneButtons canTargetSides isWorkspaceSplit panePlacement={null} onOpenInPane={noop} t={t} />
    </div>,
  );
  const buttons = container.firstElementChild as HTMLElement;

  assert.equal(readTooltip(buttons, 'left'), 'sessions.openOnLefttooltips.altClickOtherSide');
  assert.equal(readTooltip(buttons, 'right'), 'sessions.openOnRight');
});

test('unsplit, the one button carries the Alt+click hint', () => {
  vi.useFakeTimers();
  const { container } = renderButtons({ isWorkspaceSplit: false, panePlacement: null });

  assert.equal(readTooltip(container, 'right'), 'sessions.openOnRightSplittooltips.altClickOtherSide');
});

// ------------------------------------------------------------------ In the "…" control

const renderOptions = (props: {
  isEditing?: boolean;
  canTargetSides?: boolean;
  isWorkspaceSplit?: boolean;
  onOpenInPane?: (side: WorkspacePaneSide) => void;
}) => render(
  <SessionOptions
    sessionId="s1"
    sessionName="session one"
    provider="claude"
    projectId="project-1"
    isProcessing={false}
    isEditing={props.isEditing ?? false}
    renameDraft=""
    onRenameDraftChange={noop}
    onStartEditingSession={noop}
    onCancelEditingSession={noop}
    onSaveEditingSession={noop}
    onDeleteSession={noop}
    canTargetSides={props.canTargetSides ?? true}
    isWorkspaceSplit={props.isWorkspaceSplit ?? false}
    panePlacement={null}
    onOpenInPane={props.onOpenInPane ?? noop}
    t={t}
  />,
);

const openMenu = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Session options for session one' }));
  return screen.getByRole('menu');
};

const menuItemLabels = (menu: HTMLElement) =>
  within(menu).getAllByRole('menuitem').map((item) => item.textContent);

test('the side buttons sit left of the "…" and give way to an open rename', () => {
  const { container, rerender } = renderOptions({ isWorkspaceSplit: true });

  const controls = [...container.querySelectorAll('button')];
  assert.deepEqual(
    controls.map((button) => button.getAttribute('aria-label')),
    ['sessions.openOnLeft', 'sessions.openOnRight', 'Session options for session one'],
  );
  // Hung off the "…" rather than laid out beside it: the controls' box stays the "…" button's
  // size, so while the side buttons are hidden the row's time label still takes the click.
  const sideButtons = controls[0].closest('.invisible');
  const optionsRoot = container.firstElementChild;
  assert.ok(sideButtons && optionsRoot);
  assert.deepEqual(
    ['absolute', 'end-full'].map((className) => sideButtons.classList.contains(className)),
    [true, true],
  );
  assert.equal(optionsRoot.classList.contains('relative'), true, 'the "…" control is what they hang off');

  rerender(
    <SessionOptions
      sessionId="s1"
      sessionName="session one"
      provider="claude"
      projectId="project-1"
      isProcessing={false}
      isEditing
      renameDraft="renamed"
      onRenameDraftChange={noop}
      onStartEditingSession={noop}
      onCancelEditingSession={noop}
      onSaveEditingSession={noop}
      onDeleteSession={noop}
      canTargetSides
      isWorkspaceSplit
      panePlacement={null}
      onOpenInPane={noop}
      t={t}
    />,
  );
  assert.ok(container.querySelector('button[data-pane-side]') === null, 'the rename takes their place');
});

test('split, the menu leads with absolute left and right, set apart from the rest', () => {
  const onOpenInPane = vi.fn();
  renderOptions({ isWorkspaceSplit: true, onOpenInPane });
  const menu = openMenu();

  assert.deepEqual(menuItemLabels(menu).slice(0, 3), ['sessions.openOnLeft', 'sessions.openOnRight', 'Rename session']);
  // The divider sits right before the first item that is not a side.
  const renameItem = within(menu).getByRole('menuitem', { name: 'Rename session' });
  assert.ok(renameItem.previousElementSibling?.classList.contains('h-px'));

  fireEvent.click(within(menu).getByRole('menuitem', { name: 'sessions.openOnLeft' }));
  assert.deepEqual(onOpenInPane.mock.calls, [['left']]);
});

test('unsplit, the menu offers only the right side, as the split view', () => {
  const onOpenInPane = vi.fn();
  renderOptions({ isWorkspaceSplit: false, onOpenInPane });
  const menu = openMenu();

  assert.deepEqual(menuItemLabels(menu).slice(0, 2), ['sessions.openOnRightSplit', 'Rename session']);
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'sessions.openOnRightSplit' }));
  assert.deepEqual(onOpenInPane.mock.calls, [['right']]);
});

test('where sides cannot be targeted the menu is as it was', () => {
  renderOptions({ canTargetSides: false });
  const menu = openMenu();

  assert.equal(menuItemLabels(menu)[0], 'Rename session');
  const renameItem = within(menu).getByRole('menuitem', { name: 'Rename session' });
  assert.equal(renameItem.previousElementSibling?.classList.contains('h-px') ?? false, false);
  assert.ok(document.querySelector('button[data-pane-side]') === null, 'no side buttons either');
});

// ------------------------------------------------------------------ On the Projects row

const PROJECT = { projectId: 'project-1', displayName: 'project one', fullPath: '/repo', sessions: [] } as unknown as Project;
const SESSION = { id: 's1', summary: 'session one', __provider: 'claude' } as unknown as SessionWithProvider;

const renderRow = (props: { isWorkspaceSplit: boolean; panePlacement: SessionPanePlacement; onSessionSelect?: () => void }) =>
  render(
    <SidebarSessionItem
      project={PROJECT}
      session={SESSION}
      isSelected={false}
      isProcessing={false}
      hasBackgroundWork={false}
      needsAttention={false}
      currentTime={new Date('2026-08-21T10:00:00.000Z')}
      isEditing={false}
      renameDraft=""
      onRenameDraftChange={noop}
      onStartEditingSession={noop}
      onCancelEditingSession={noop}
      onSaveEditingSession={noop}
      onSessionSelect={props.onSessionSelect ?? noop}
      onDeleteSession={noop}
      isSelecting={false}
      isChecked={false}
      onToggleSessionSelected={noop}
      canTargetSides
      isWorkspaceSplit={props.isWorkspaceSplit}
      panePlacement={props.panePlacement}
      t={t}
    />,
  );

test('a row\'s side buttons and side menu items open the session on that absolute side', () => {
  const onSessionSelect = vi.fn();
  const { container } = renderRow({ isWorkspaceSplit: true, panePlacement: 'right', onSessionSelect });

  fireEvent.click(sideButton(container, 'left') as HTMLButtonElement);
  fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'sessions.openOnRight' }));

  assert.deepEqual(onSessionSelect.mock.calls, [
    [SESSION, 'project-1', { target: 'left' }],
    [SESSION, 'project-1', { target: 'right' }],
  ]);
});

test('a split workspace marks the row with where the session is open', () => {
  const { container, unmount } = renderRow({ isWorkspaceSplit: true, panePlacement: 'both' });
  const marker = container.querySelector('[data-pane-placement]');
  assert.equal(marker?.getAttribute('data-pane-placement'), 'both');
  assert.equal(marker?.getAttribute('aria-label'), 'tooltips.openedBoth');
  unmount();

  // Unsplit there is only one place to be; a session open nowhere has nothing to mark.
  assert.ok(renderRow({ isWorkspaceSplit: false, panePlacement: 'left' }).container.querySelector('[data-pane-placement]') === null, 'unsplit');
  assert.ok(renderRow({ isWorkspaceSplit: true, panePlacement: null }).container.querySelector('[data-pane-placement]') === null, 'open nowhere');
});

test('the marker names each placement', () => {
  const labels = (['left', 'right', 'both'] as const).map((placement) => {
    const { container, unmount } = render(<PanePlacementMarker isWorkspaceSplit panePlacement={placement} t={t} />);
    const label = container.querySelector('[role="img"]')?.getAttribute('aria-label');
    unmount();
    return label;
  });

  assert.deepEqual(labels, ['tooltips.openedLeft', 'tooltips.openedRight', 'tooltips.openedBoth']);
});

// ------------------------------------------------------------------ Right to left

/** Lays the document out right to left as <html dir="rtl"> does in a browser; jsdom neither maps dir to direction nor inherits it. */
const layOutRightToLeft = () => {
  const style = document.createElement('style');
  style.textContent = '[dir="rtl"], [dir="rtl"] * { direction: rtl; }';
  document.head.append(style);
  document.documentElement.setAttribute('dir', 'rtl');
  return () => {
    document.documentElement.removeAttribute('dir');
    style.remove();
  };
};

test('right to left the first pane is drawn on the right, and the buttons, marker and menu say so', () => {
  const restore = layOutRightToLeft();
  try {
    const onOpenInPane = vi.fn();
    const split = renderButtons({ isWorkspaceSplit: true, panePlacement: null, onOpenInPane });
    assert.equal(sideButton(split.container, 'left')?.getAttribute('aria-label'), 'sessions.openOnRight');
    assert.equal(sideButton(split.container, 'right')?.getAttribute('aria-label'), 'sessions.openOnLeft');
    fireEvent.click(sideButton(split.container, 'left') as HTMLButtonElement);
    assert.deepEqual(onOpenInPane.mock.calls, [['left']], 'it still opens in the first pane');
    split.unmount();

    // Unsplit, the second pane opens on the left.
    const unsplit = renderButtons({ isWorkspaceSplit: false, panePlacement: null });
    assert.equal(sideButton(unsplit.container, 'right')?.getAttribute('aria-label'), 'sessions.openOnLeftSplit');
    unsplit.unmount();

    const marker = render(<PanePlacementMarker isWorkspaceSplit panePlacement="left" t={t} />);
    assert.equal(marker.container.querySelector('[role="img"]')?.getAttribute('aria-label'), 'tooltips.openedRight');
    marker.unmount();

    const splitMenu = renderOptions({ isWorkspaceSplit: true });
    assert.deepEqual(menuItemLabels(openMenu()).slice(0, 2), ['sessions.openOnRight', 'sessions.openOnLeft']);
    splitMenu.unmount();

    renderOptions({ isWorkspaceSplit: false });
    assert.equal(menuItemLabels(openMenu())[0], 'sessions.openOnLeftSplit');
  } finally {
    restore();
  }
});
