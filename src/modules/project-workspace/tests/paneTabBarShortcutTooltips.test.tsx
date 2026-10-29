import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, onTestFinished, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { WorkspaceChromeProvider } from '@/modules/project-workspace/context/WorkspaceChromeContext';
import PaneTabBar from '@/modules/project-workspace/PaneTabBar';
import type { PaneTabDisplay, Project, WorkspaceLayoutActions, WorkspacePaneState } from '@/shared/types';

/**
 * The split and full-screen buttons say their shortcut in the tooltip. The shortcut goes into the
 * translation as a value, so a right-to-left language isolates it ("Ctrl+\" read "\+Ctrl", "⌘⇧↵"
 * "↵⇧⌘"), and Chinese puts it in full-width brackets. The buttons end the bar at the window's edge,
 * so their tooltips open toward the start of the line rather than centred below, where they were cut
 * off: to the left left to right, to the right right to left.
 */

const ALPHA: Project = { projectId: 'alpha', displayName: 'Alpha', fullPath: '/repo/alpha', sessions: [] };
const PANE: WorkspacePaneState = {
  id: 'pane-left',
  tabs: [{
    key: 't1',
    sessionId: 'session-t1',
    projectId: 'alpha',
    provider: 'claude',
    title: 'First chat',
    view: 'chat',
    isPreview: false,
    session: { id: 'session-t1', __projectId: 'alpha', __provider: 'claude' },
  }],
  activeTabKey: 't1',
  mru: ['t1'],
  draftActivation: 0,
  externalRevision: 0,
};
const DISPLAY = new Map<string, PaneTabDisplay>([['t1', { title: 'First chat', projectName: 'Alpha', activity: null }]]);
const actions = new Proxy({}, { get: () => vi.fn() }) as WorkspaceLayoutActions;

const renderBar = (isImmersive = false) => render(
  <WorkspaceChromeProvider
    value={{
      isImmersive,
      isBrowserFullscreen: false,
      toggleImmersive: vi.fn(),
      exitImmersive: vi.fn(),
      isSidebarPeekOpen: false,
      setSidebarPeekOpen: vi.fn(),
      canSplit: true,
    }}
  >
    <PaneTabBar
      side="left"
      pane={PANE}
      tabDisplay={DISPLAY}
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
      onRenameSession={async () => true}
      showProjectNames={false}
    />
  </WorkspaceChromeProvider>,
);

/** Hovers the button long enough for its tooltip; returns the tooltip's text and how it is placed. */
const hoverTooltip = (buttonName: string) => {
  const button = screen.getByRole('button', { name: buttonName });
  fireEvent.mouseEnter(button.parentElement as HTMLElement);
  act(() => {
    vi.advanceTimersByTime(400);
  });
  // The position is set on the next animation frame.
  act(() => {
    vi.advanceTimersByTime(20);
  });
  const tooltip = document.body.querySelector<HTMLElement>('.pointer-events-none.whitespace-nowrap');
  const reading = { text: tooltip?.textContent ?? '', transform: tooltip?.style.transform ?? '' };
  fireEvent.mouseLeave(button.parentElement as HTMLElement);
  return reading;
};

afterEach(async () => {
  vi.useRealTimers();
  await i18n.changeLanguage('en');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

/** Opens toward the start of the line, beside the button: to its left. */
const BESIDE_ON_THE_LEFT = 'translate(-100%, -50%)';
/** Beside the button on its right. */
const BESIDE_ON_THE_RIGHT = 'translateY(-50%)';

test('English: the label and the shortcut, opening to the left of the button', () => {
  vi.useFakeTimers();
  renderBar();

  assert.deepEqual(hoverTooltip('Split view'), { text: 'Split view (Ctrl+\\)', transform: BESIDE_ON_THE_LEFT });
  assert.deepEqual(hoverTooltip('Full screen'), { text: 'Full screen (Ctrl+Shift+Enter)', transform: BESIDE_ON_THE_LEFT });
});

test('Chinese puts the shortcut in full-width brackets', async () => {
  await i18n.changeLanguage('zh-CN');
  vi.useFakeTimers();
  renderBar(true);

  assert.equal(hoverTooltip('拆分视图').text, '拆分视图（Ctrl+\\）');
  assert.equal(hoverTooltip('退出全屏').text, '退出全屏（Ctrl+Shift+Enter）');
});

/** Lays the document out right to left as <html dir="rtl"> does in a browser; jsdom does not map dir to direction. */
const layOutRightToLeft = () => {
  const style = document.createElement('style');
  style.textContent = '[dir="rtl"], [dir="rtl"] * { direction: rtl; }';
  document.head.append(style);
  return () => style.remove();
};

test('right to left the shortcut is isolated and the tooltip opens to the right, into the window', async () => {
  await i18n.changeLanguage('he');
  const restore = layOutRightToLeft();
  onTestFinished(restore);
  assert.equal(document.documentElement.getAttribute('dir'), 'rtl');
  vi.useFakeTimers();
  renderBar();

  const split = hoverTooltip(i18n.t('workspace.split'));
  assert.equal(split.text.includes('(\u2068Ctrl+\\\u2069)'), true, split.text);
  assert.equal(split.transform, BESIDE_ON_THE_RIGHT);
  const fullscreen = hoverTooltip(i18n.t('workspace.fullscreen'));
  assert.equal(fullscreen.text.includes('(\u2068Ctrl+Shift+Enter\u2069)'), true, fullscreen.text);
  assert.equal(fullscreen.transform, BESIDE_ON_THE_RIGHT);
});
