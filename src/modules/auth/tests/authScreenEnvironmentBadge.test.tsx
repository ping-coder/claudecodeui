import assert from 'node:assert/strict';

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import '@/modules/i18n';

/**
 * The login and setup screens share one card layout, which carries the
 * deployment environment badge in its corner so a staging sign-in is told
 * apart from production before any password is typed. Production shows none.
 */

const stubEnvironment = (environment: string | null) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (
    url === '/health'
      ? { ok: true, json: async () => ({ status: 'ok', environment }) }
      : { ok: false, json: async () => ({}) }
  )));
};

// The environment is cached in module state, so every test loads the layout afresh.
const renderAuthCard = async () => {
  vi.resetModules();
  const { default: AuthScreenLayout } = await import('@/modules/auth/AuthScreenLayout');
  return render(
    <AuthScreenLayout title="Welcome Back" description="Sign in to your account" footerText="Footer">
      <form aria-label="Sign in" />
    </AuthScreenLayout>,
  );
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('on staging the auth card shows the environment badge', async () => {
  stubEnvironment('staging');

  await renderAuthCard();

  const badge = await screen.findByText('Stage');
  assert.equal(badge.getAttribute('title'), 'Deployment environment: Stage');
  assert.ok(screen.getByRole('heading', { name: 'Welcome Back' }));
});

test('in production the auth card shows no badge', async () => {
  stubEnvironment(null);

  await renderAuthCard();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(screen.queryByTitle(/^Deployment environment/), null);
  assert.ok(screen.getByRole('heading', { name: 'Welcome Back' }));
});
