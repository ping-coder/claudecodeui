import assert from 'node:assert/strict';

import { act, cleanup, render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, test, vi } from 'vitest';

import '@/modules/i18n';

/**
 * A non-production deployment is marked beside the app name in the sidebar
 * header (the desktop and the mobile layout both render it) and in the
 * collapsed icon rail, so the marker stays on screen whichever way the sidebar
 * is shown. Production renders no marker anywhere.
 */

const noop = () => {};
const t = ((key: string) => key) as unknown as TFunction;

const stubEnvironment = (environment: string | null) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (
    url === '/health'
      ? { ok: true, json: async () => ({ status: 'ok', environment }) }
      : { ok: false, json: async () => ({}) }
  )));
};

// The environment is cached in module state, so every test loads the sidebar afresh.
const loadSidebarParts = async () => {
  vi.resetModules();
  const { default: SidebarHeader } = await import('@/modules/sidebar/SidebarHeader');
  const { default: SidebarCollapsed } = await import('@/modules/sidebar/SidebarCollapsed');
  return { SidebarHeader, SidebarCollapsed };
};

const headerProps = {
  isPWA: false,
  isMobile: false,
  isLoading: false,
  projectsCount: 0,
  runningSessionsCount: 0,
  archivedSessionsCount: 0,
  isArchivedSessionsLoading: false,
  searchFilter: '',
  onSearchFilterChange: noop,
  onClearSearchFilter: noop,
  searchMode: 'projects' as const,
  onSearchModeChange: noop,
  onRefresh: noop,
  isRefreshing: false,
  onCreateProject: noop,
  onCollapseSidebar: noop,
  t,
};

const collapsedProps = {
  onExpand: noop,
  onShowSettings: noop,
  updateAvailable: false,
  restartRequired: false,
  onShowVersionModal: noop,
  t,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('on staging both header layouts show the badge right after the app name', async () => {
  stubEnvironment('staging');
  const { SidebarHeader } = await loadSidebarParts();

  render(<SidebarHeader {...headerProps} />);

  const badges = await screen.findAllByText('Stage');
  assert.equal(badges.length, 2, 'one in the desktop header, one in the mobile header');
  for (const badge of badges) {
    assert.equal(badge.previousElementSibling?.textContent, 'app.title');
  }
});

test('on staging the collapsed rail shows the badge too', async () => {
  stubEnvironment('staging');
  const { SidebarCollapsed } = await loadSidebarParts();

  render(<SidebarCollapsed {...collapsedProps} />);

  assert.ok(await screen.findByTitle('Deployment environment: Stage'));
});

test('in production neither the header nor the collapsed rail shows a badge', async () => {
  stubEnvironment(null);
  const { SidebarHeader, SidebarCollapsed } = await loadSidebarParts();

  render(
    <>
      <SidebarHeader {...headerProps} />
      <SidebarCollapsed {...collapsedProps} />
    </>,
  );
  // Let the /health answer arrive before looking for the badge.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(screen.queryByTitle(/^Deployment environment/), null);
  assert.equal(screen.getAllByText('app.title').length, 2);
});
