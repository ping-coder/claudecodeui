import assert from 'node:assert/strict';

import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { Plugin } from '@/shared/types';

/**
 * The workspace view switcher in its two looks. On a phone (the default) it keeps today's bordered
 * bar, where only the active view is labelled below the lg breakpoint. In a desktop pane its pills
 * are larger and the pane decides the labels: every view, or only the active one, at any viewport.
 * Browser and Tasks come and go with their settings; enabled plugins follow a separator.
 */

const plugins: { list: Plugin[] } = { list: [] };

vi.mock('@/modules/plugins', () => ({
  usePlugins: () => ({ plugins: plugins.list }),
  PluginIcon: ({ pluginName, className }: { pluginName: string; className?: string }) => (
    <span data-plugin-icon={pluginName} className={className} />
  ),
}));

const { default: WorkspaceTabs } = await import('@/modules/project-workspace/WorkspaceTabs');

const makePlugin = (name: string, enabled: boolean): Plugin => ({
  name,
  displayName: `${name} board`,
  version: '1.0.0',
  description: '',
  author: '',
  icon: 'icon.svg',
  type: 'react',
  slot: 'tab',
  entry: 'index.js',
  server: null,
  permissions: [],
  enabled,
  serverRunning: false,
  dirName: name,
  repoUrl: null,
});

type TabsProps = ComponentProps<typeof WorkspaceTabs>;

const renderTabs = (overrides: Partial<TabsProps> = {}) => render(
  <WorkspaceTabs
    activeTab="chat"
    setActiveTab={vi.fn()}
    shouldShowTasksTab={false}
    shouldShowBrowserTab={false}
    {...overrides}
  />,
);

const BUILT_IN_LABELS = ['Chat', 'Shell', 'Files', 'Source Control'];
const viewTab = (name: string) => screen.getByRole('tab', { name });
const labelOf = (name: string) => within(viewTab(name)).getByText(name);
const isLabelHidden = (name: string) => labelOf(name).classList.contains('hidden');
const tabNames = () => screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'));

beforeEach(() => {
  plugins.list = [];
});

test('a pane bar labelling every view shows each label, in 32px pills with 16px icons', () => {
  renderTabs({ variant: 'pane', labels: 'all' });

  assert.deepEqual(BUILT_IN_LABELS.map(isLabelHidden), [false, false, false, false]);
  for (const name of BUILT_IN_LABELS) {
    assert.equal(viewTab(name).classList.contains('h-8'), true, name);
    assert.equal(viewTab(name).querySelector('svg')?.classList.contains('h-4') ?? false, true, name);
    // The pane decides, not the viewport: no breakpoint brings a label back or takes it away.
    assert.equal(labelOf(name).className.includes('lg:'), false, name);
  }
  assert.equal(screen.getByRole('tablist', { name: 'Workspace views' }).classList.contains('border'), false);
});

test('a pane bar labelling the active view only hides the other labels, which keep their names for screen readers', () => {
  renderTabs({ variant: 'pane', labels: 'active', activeTab: 'files' });

  assert.deepEqual(BUILT_IN_LABELS.map(isLabelHidden), [true, true, false, true]);
  assert.deepEqual(tabNames(), BUILT_IN_LABELS);
});

test('the phone bar is unchanged: bordered, small icons, the other labels only from the lg breakpoint', () => {
  renderTabs();

  assert.equal(screen.getByRole('tablist', { name: 'Workspace views' }).classList.contains('border'), true);
  assert.equal(isLabelHidden('Chat'), false);
  for (const name of ['Shell', 'Files', 'Source Control']) {
    assert.equal(isLabelHidden(name), true, name);
    assert.equal(labelOf(name).classList.contains('lg:inline'), true, name);
  }
  assert.equal(viewTab('Files').querySelector('svg')?.classList.contains('h-3.5') ?? false, true);
});

test('Browser and Tasks follow their settings, enabled plugins follow a separator, and a pick is the user\'s', () => {
  const setActiveTab = vi.fn();
  plugins.list = [makePlugin('kanban', true), makePlugin('notes', false)];
  const view = renderTabs({ variant: 'pane', setActiveTab });
  assert.deepEqual(tabNames(), [...BUILT_IN_LABELS, 'kanban board']);

  view.rerender(
    <WorkspaceTabs variant="pane" activeTab="chat" setActiveTab={setActiveTab} shouldShowTasksTab shouldShowBrowserTab />,
  );
  assert.deepEqual(tabNames(), [...BUILT_IN_LABELS, 'Browser', 'Tasks', 'kanban board']);

  // The separator sits right before the first plugin.
  const separator = viewTab('kanban board').closest('[role="tablist"]')?.querySelector('span[aria-hidden="true"].w-px');
  assert.equal(separator?.nextElementSibling?.contains(viewTab('kanban board')) ?? false, true);
  assert.equal(viewTab('kanban board').querySelector('[data-plugin-icon="kanban"]')?.classList.contains('h-4') ?? false, true);

  fireEvent.click(viewTab('kanban board'));
  assert.deepEqual(setActiveTab.mock.calls, [['plugin:kanban', { userInitiated: true }]]);
});
