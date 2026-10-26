import assert from 'node:assert/strict';

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';

/**
 * The badge is the in-page marker of a non-production deployment: an amber pill
 * whose text names the environment, so it does not rely on colour alone. In
 * production, or when the environment cannot be read, it must render nothing.
 */

const stubHealth = (environment: string | null | Error) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (environment instanceof Error) {
      throw environment;
    }
    return url === '/health'
      ? { ok: true, json: async () => ({ status: 'ok', environment }) }
      : { ok: false, json: async () => ({}) };
  }));
};

// The environment is cached in module state, so every test loads the badge afresh.
const loadBadge = async () => {
  vi.resetModules();
  return (await import('@/shared/ui/DeploymentEnvironmentBadge')).DeploymentEnvironmentBadge;
};

// Lets the stubbed request settle and its listeners run.
const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
  vi.unstubAllGlobals();
});

test('on a staging server it reads "Stage", with the full name as its tooltip', async () => {
  stubHealth('staging');
  const DeploymentEnvironmentBadge = await loadBadge();

  render(<DeploymentEnvironmentBadge className="extra-class" />);

  const badge = await screen.findByText('Stage');
  assert.equal(badge.getAttribute('title'), 'Deployment environment: Stage');
  assert.ok(badge.classList.contains('extra-class'));
});

test('in Chinese the staging badge reads "预发布"', async () => {
  await i18n.changeLanguage('zh-CN');
  stubHealth('staging');
  const DeploymentEnvironmentBadge = await loadBadge();

  render(<DeploymentEnvironmentBadge />);

  const badge = await screen.findByText('预发布');
  assert.equal(badge.getAttribute('title'), '部署环境：预发布');
});

test('an environment without a translated label is shown as configured', async () => {
  stubHealth('qa-east-1');
  const DeploymentEnvironmentBadge = await loadBadge();

  render(<DeploymentEnvironmentBadge />);

  assert.ok(await screen.findByText('qa-east-1'));
});

test.each([
  ['in production', null],
  ['when /health cannot be reached', new TypeError('Failed to fetch')],
])('renders nothing %s', async (_case, environment) => {
  stubHealth(environment);
  const DeploymentEnvironmentBadge = await loadBadge();

  const { container } = render(<DeploymentEnvironmentBadge />);
  await settle();

  assert.equal(container.innerHTML, '');
});
