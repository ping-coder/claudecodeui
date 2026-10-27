import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';

/**
 * Immersive mode hides the workspace's docked columns, so the project workspace renders the panel
 * with allowDocking={false} there: no docked column, the handle opens an overlay, and the stored pin
 * is kept for when docking is allowed again (the same rules as a narrow, mobile viewport).
 */

const STORAGE_KEY = 'quickSettingsPanel';
const PREFERENCES = { showRawParameters: false, showThinking: false, sendByCtrlEnter: false, voiceEnabled: false };
const NO_COMMANDS = { commands: [], isLoading: false, error: false };

vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false }) }));
vi.mock('@/shared/context/UiPreferencesContext', () => ({
  useUiPreferences: () => PREFERENCES,
  useSetUiPreference: () => () => undefined,
}));
vi.mock('@/shared/hooks/useSelectedProvider', () => ({ useSelectedProvider: () => 'claude' }));
vi.mock('@/shared/hooks/useProjectSlashCommands', () => ({ useProjectSlashCommands: () => NO_COMMANDS }));
// The settings rows (theme, language, toggles) have nothing to do with docking.
vi.mock('@/modules/quick-settings-panel/QuickSettingsContent', () => ({ default: () => null }));

const { default: QuickSettingsPanelView } = await import('@/modules/quick-settings-panel/QuickSettingsPanelView');

const renderPanel = (allowDocking?: boolean) => {
  const view = render(<QuickSettingsPanelView selectedProject={null} allowDocking={allowDocking} />);
  return {
    ...view,
    rerenderWith: (next?: boolean) => view.rerender(<QuickSettingsPanelView selectedProject={null} allowDocking={next} />),
  };
};

/**
 * Where the panel body is: a docked column (a plain flex child of the workspace row), the fixed
 * overlay drawer slid in or out, or nowhere (a pinned panel collapsed behind its handle).
 */
const panelPlacement = (): 'docked' | 'overlay shown' | 'overlay hidden' | 'collapsed' => {
  const heading = screen.queryByRole('heading', { name: 'Quick Settings' });
  if (!heading) {
    return 'collapsed';
  }
  const overlay = heading.closest('.fixed');
  if (!overlay) {
    return 'docked';
  }
  return overlay.classList.contains('translate-x-0') ? 'overlay shown' : 'overlay hidden';
};
const storedPanelState = () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as { pinned: boolean } | null;
const clickButton = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
// A boolean rather than the node: a failed assertion on a jsdom node makes node:assert walk the whole tree.
const hasButton = (name: string) => screen.queryByRole('button', { name }) !== null;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ pinned: true, tab: 'settings' }));
});

test('by default a stored pin docks the panel into the workspace row', () => {
  renderPanel();

  assert.equal(panelPlacement(), 'docked');
  assert.equal(hasButton('Unpin panel'), true);
});

test('allowDocking=false renders no docked column, opens an overlay and keeps the pin', () => {
  renderPanel(false);

  assert.equal(panelPlacement(), 'overlay hidden');

  // The handle is still there and opens the panel as an overlay.
  clickButton('Open settings panel');
  assert.equal(panelPlacement(), 'overlay shown');
  // An overlay closes like one, and offers no pin while it cannot dock.
  assert.equal(hasButton('Unpin panel'), false);
  clickButton('Close panel');
  assert.equal(panelPlacement(), 'overlay hidden');

  assert.equal(storedPanelState()?.pinned, true);
});

test('docking switched off collapses a docked panel; switched back on, the kept pin docks it again', () => {
  const { rerenderWith } = renderPanel(true);
  assert.equal(panelPlacement(), 'docked');

  rerenderWith(false);
  assert.equal(panelPlacement(), 'overlay hidden');
  assert.equal(hasButton('Open settings panel'), true);
  assert.equal(storedPanelState()?.pinned, true);

  // Back from immersive mode: still pinned, collapsed behind the handle, which docks it again.
  rerenderWith(true);
  assert.equal(panelPlacement(), 'collapsed');
  clickButton('Open settings panel');
  assert.equal(panelPlacement(), 'docked');
});
