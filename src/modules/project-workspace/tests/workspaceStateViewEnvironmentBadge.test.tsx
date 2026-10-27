import assert from 'node:assert/strict';

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import '@/modules/i18n';

/**
 * While projects load, and on the "Choose project" screen, WorkspaceMain shows this state
 * view instead of the workspace header. On phones the sidebar, which carries the deployment
 * badge, is a closed drawer, so the view's own header must mark a non-production deployment,
 * as the workspace header does once a project is open; otherwise a phone (or a PWA launched
 * at "/") shows no in-page marker until a project is picked. Desktop keeps the sidebar badge.
 */

const noop = () => {};

const stubEnvironment = (environment: string | null) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (
    url === '/health'
      ? { ok: true, json: async () => ({ status: 'ok', environment }) }
      : { ok: false, json: async () => ({}) }
  )));
};

// The environment is cached in module state, so every test loads the view afresh.
const loadStateView = async () => {
  vi.resetModules();
  return (await import('@/modules/project-workspace/WorkspaceStateView')).default;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test.each(['loading', 'empty'] as const)('on a phone the %s screen shows the badge beside the menu button', async (mode) => {
  stubEnvironment('staging');
  const WorkspaceStateView = await loadStateView();

  render(<WorkspaceStateView mode={mode} isMobile onMenuClick={noop} />);

  const badge = await screen.findByTitle('Deployment environment: Stage');
  assert.equal(badge.previousElementSibling === screen.getByRole('button', { name: 'Open menu' }), true);
});

test.each([
  ['on desktop, where the sidebar shows it', 'staging', false],
  ['in production', null, true],
])('the screen shows no badge %s', async (_case, environment, isMobile) => {
  stubEnvironment(environment);
  const WorkspaceStateView = await loadStateView();

  render(<WorkspaceStateView mode="empty" isMobile={isMobile} onMenuClick={noop} />);
  // Let the /health answer arrive before looking for the badge.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(screen.queryByTitle(/^Deployment environment/) === null, true);
});
