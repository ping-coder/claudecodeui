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

test('in the header the badge gives way before the app name and keeps clear of the buttons', async () => {
  stubEnvironment('qa-east-1-canary');
  const { SidebarHeader } = await loadSidebarParts();

  render(<SidebarHeader {...headerProps} />);

  // jsdom does no layout, so this pins the classes that make the badge yield: it starts from
  // no width (basis-0), grows only into the room the whole app name leaves (grow), and stops
  // at its own text width (max-w-max), ellipsizing below that. A fixed cap such as max-w-24,
  // with the badge refusing to shrink, cut the app name to a sliver in a narrow sidebar and
  // ran a long name under the header buttons.
  const badges = await screen.findAllByText('qa-east-1-canary');
  assert.equal(badges.length, 2, 'one in the desktop header, one in the mobile header');
  for (const badge of badges) {
    const classes = badge.className.split(/\s+/);
    assert.ok(classes.includes('basis-0') && classes.includes('grow'), badge.className);
    assert.deepEqual(classes.filter((name) => name.startsWith('max-w-')), ['max-w-max']);
    assert.ok(classes.includes('truncate'), badge.className);
    // An ellipsized name stays readable in full in the tooltip.
    assert.equal(badge.getAttribute('title'), 'Deployment environment: qa-east-1-canary');
    // The header row keeps a gap between the logo block and the buttons.
    assert.ok(badge.parentElement?.parentElement?.classList.contains('gap-2'));
  }
});

test('on staging the collapsed rail shows the badge too', async () => {
  stubEnvironment('staging');
  const { SidebarCollapsed } = await loadSidebarParts();

  render(<SidebarCollapsed {...collapsedProps} />);

  assert.ok(await screen.findByTitle('Deployment environment: Stage'));
});

test('the collapsed rail badge keeps the line height of the other badges', async () => {
  stubEnvironment('staging');
  const { SidebarCollapsed } = await loadSidebarParts();

  render(<SidebarCollapsed {...collapsedProps} />);

  // cn lets a later font-size class drop an earlier line height, so the rail restates it;
  // without it the 9px pill takes the page's 1.5 line height and stands taller than the rest.
  const badge = await screen.findByTitle('Deployment environment: Stage');
  assert.ok(badge.classList.contains('text-[9px]'), badge.className);
  assert.ok(badge.classList.contains('leading-none'), badge.className);
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
