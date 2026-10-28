import assert from 'node:assert/strict';

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';

/**
 * The environment comes from the public /health route. Many components read it
 * (the badge in each header, the tab title), so one request per page load must
 * serve them all, and an answer that cannot be read must count as production:
 * a production tab should never gain a marker because a health check failed.
 */

type HealthReply = { ok: boolean; readBody: () => Promise<unknown> } | Error;

let healthRequests = 0;

const replyWith = (body: unknown, ok = true): HealthReply => ({ ok, readBody: async () => body });

// Any other request (the language preference write, for one) gets an error status.
const stubHealth = (reply: HealthReply) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url !== '/health') {
      return { ok: false, json: async () => ({}) };
    }

    healthRequests += 1;
    if (reply instanceof Error) {
      throw reply;
    }
    return { ok: reply.ok, json: reply.readBody };
  }));
};

// The answer is cached in module state, so every test loads the hooks afresh.
const loadHooks = async () => {
  vi.resetModules();
  return import('@/shared/hooks/useDeploymentEnvironment');
};

// Lets the stubbed request settle and its listeners run.
const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

/** Adds a tab icon link like the ones index.html declares; jsdom starts with an empty head. */
const addIconLink = (rel: string, type: string, href: string): HTMLLinkElement => {
  const link = document.createElement('link');
  link.rel = rel;
  link.type = type;
  link.setAttribute('href', href);
  document.head.append(link);
  return link;
};

beforeEach(() => {
  healthRequests = 0;
  document.title = 'CloudCLI UI';
});

afterEach(async () => {
  // Unmount first, so restoring the language cannot re-render this test's hooks.
  cleanup();
  await i18n.changeLanguage('en');
  vi.unstubAllGlobals();
  document.head.querySelectorAll('link').forEach((link) => link.remove());
});

test('every caller shares one /health request for the whole page load', async () => {
  stubHealth(replyWith({ status: 'ok', environment: 'staging' }));
  const { useDeploymentEnvironment } = await loadHooks();

  const first = renderHook(() => useDeploymentEnvironment());
  const second = renderHook(() => useDeploymentEnvironment());
  await waitFor(() => assert.equal(first.result.current, 'staging'));
  assert.equal(second.result.current, 'staging');

  // A caller mounted after the answer has it on its very first render.
  const laterRenders: (string | null)[] = [];
  renderHook(() => {
    const environment = useDeploymentEnvironment();
    laterRenders.push(environment);
    return environment;
  });
  assert.equal(laterRenders[0], 'staging');
  assert.equal(healthRequests, 1);
});

test('the name is reported trimmed', async () => {
  stubHealth(replyWith({ environment: '  qa-east-1 \n' }));
  const { useDeploymentEnvironment } = await loadHooks();

  const { result } = renderHook(() => useDeploymentEnvironment());

  await waitFor(() => assert.equal(result.current, 'qa-east-1'));
});

test('a request that fails counts as production and is not retried', async () => {
  stubHealth(new TypeError('Failed to fetch'));
  const { useDeploymentEnvironment } = await loadHooks();

  const { result } = renderHook(() => useDeploymentEnvironment());
  await settle();
  renderHook(() => useDeploymentEnvironment());
  await settle();

  assert.equal(result.current, null);
  assert.equal(healthRequests, 1);
});

test.each([
  ['an error status', replyWith({ environment: 'staging' }, false)],
  ['a production server', replyWith({ status: 'ok', environment: null })],
  ['a server that predates the field', replyWith({ status: 'ok', version: '1.37.5' })],
  ['a blank name', replyWith({ environment: '   ' })],
  ['a name that is not a string', replyWith({ environment: 42 })],
  ['a body that is not an object', replyWith('staging')],
  ['a body that is not JSON', { ok: true, readBody: async () => { throw new SyntaxError('Unexpected token <'); } }],
])('%s means production', async (_answer, reply) => {
  stubHealth(reply);
  const { useDeploymentEnvironment } = await loadHooks();

  const { result } = renderHook(() => useDeploymentEnvironment());
  await settle();

  assert.equal(healthRequests, 1);
  assert.equal(result.current, null);
});

test('the title hook leads the tab title with the label in the current language', async () => {
  stubHealth(replyWith({ environment: 'staging' }));
  const { useDeploymentEnvironmentTitle } = await loadHooks();
  // Loaded after the reset, so this is the same title state the hook writes to.
  const { setDocumentPageTitle } = await import('@/shared/utils');
  setDocumentPageTitle('Fix browser tab title');

  const { unmount } = renderHook(() => useDeploymentEnvironmentTitle());
  await waitFor(() => assert.equal(document.title, 'Stage · Fix browser tab title'));

  await act(async () => {
    await i18n.changeLanguage('zh-CN');
  });
  assert.equal(document.title, '预发布 · Fix browser tab title');

  setDocumentPageTitle('My Project - CloudCLI UI');
  assert.equal(document.title, '预发布 · My Project - CloudCLI UI');

  unmount();
  assert.equal(document.title, 'My Project - CloudCLI UI');
});

test('the title hook marks the login screen, which sets no page title of its own', async () => {
  stubHealth(replyWith({ environment: 'dev' }));
  const { useDeploymentEnvironmentTitle } = await loadHooks();

  renderHook(() => useDeploymentEnvironmentTitle());

  await waitFor(() => assert.equal(document.title, 'Dev · CloudCLI UI'));
});

test('in production the title hook never writes the tab title', async () => {
  stubHealth(replyWith({ status: 'ok', environment: null }));
  const { useDeploymentEnvironmentTitle } = await loadHooks();
  const { setDocumentPageTitle } = await import('@/shared/utils');
  setDocumentPageTitle('Fix browser tab title');
  // A sentinel written straight into the title: any rewrite by the hook would replace it.
  document.title = 'sentinel';

  const { unmount } = renderHook(() => useDeploymentEnvironmentTitle());
  await settle();
  await act(async () => {
    await i18n.changeLanguage('zh-CN');
  });
  unmount();

  assert.equal(healthRequests, 1);
  assert.equal(document.title, 'sentinel');
});

test('the title hook swaps the label behind a status marker and keeps the alert', async () => {
  stubHealth(replyWith({ environment: 'staging' }));
  const { useDeploymentEnvironmentTitle } = await loadHooks();
  const { setDocumentPageTitle, setDocumentTitleAlert } = await import('@/shared/utils');
  setDocumentPageTitle('Write release notes');
  setDocumentTitleAlert({ marker: '[Done]', subject: 'Fix login bug' });

  const { unmount } = renderHook(() => useDeploymentEnvironmentTitle());
  await waitFor(() => assert.equal(document.title, '[Done] Stage · Fix login bug'));

  await act(async () => {
    await i18n.changeLanguage('zh-CN');
  });
  assert.equal(document.title, '[Done] 预发布 · Fix login bug');

  unmount();
  assert.equal(document.title, '[Done] Fix login bug');
});

test('the favicon hook swaps the tab icons for the amber ones, and back on unmount', async () => {
  stubHealth(replyWith({ environment: 'staging' }));
  const svgIcon = addIconLink('icon', 'image/svg+xml', '/favicon.svg');
  const pngIcon = addIconLink('icon', 'image/png', '/favicon.png');
  // A home screen icon is read once, when the app is added, so it is left alone.
  const touchIcon = addIconLink('apple-touch-icon', 'image/png', '/icons/icon-152x152.png');
  const { useDeploymentEnvironmentFavicon } = await loadHooks();

  const { unmount } = renderHook(() => useDeploymentEnvironmentFavicon());
  await waitFor(() => assert.equal(new URL(svgIcon.href).pathname, '/favicon-stage.svg'));
  assert.equal(new URL(pngIcon.href).pathname, '/favicon-stage.png');
  assert.equal(touchIcon.getAttribute('href'), '/icons/icon-152x152.png');

  unmount();
  assert.equal(svgIcon.getAttribute('href'), '/favicon.svg');
  assert.equal(pngIcon.getAttribute('href'), '/favicon.png');
});

test('the favicon hook takes the amber icon from beside the production one under a sub-path', async () => {
  stubHealth(replyWith({ environment: 'staging' }));
  const svgIcon = addIconLink('icon', 'image/svg+xml', '/cloudcli/favicon.svg?v=2');
  const { useDeploymentEnvironmentFavicon } = await loadHooks();

  renderHook(() => useDeploymentEnvironmentFavicon());

  await waitFor(() => assert.equal(new URL(svgIcon.href).pathname, '/cloudcli/favicon-stage.svg'));
});

// The swap runs above every error boundary, so an icon the amber file cannot be resolved
// beside (inlined by the deployer, or rewritten by an extension) must be skipped: throwing
// there would blank the whole tab.
test.each([
  ['an inlined data: icon', 'data:image/png;base64,iVBORw0KGgo='],
  ['a blob: icon', 'blob:http://localhost:3000/4f6c5a8e-7b0e-4d3c-9a1f-2c8d6e5b4a3f'],
  ['an about: icon', 'about:blank'],
  ['an icon whose URL does not parse', 'http://[::1'],
])('the favicon hook leaves %s alone and still swaps the others', async (_icon, href) => {
  stubHealth(replyWith({ environment: 'staging' }));
  const unusableIcon = addIconLink('icon', 'image/png', href);
  const svgIcon = addIconLink('icon', 'image/svg+xml', '/favicon.svg');
  const { useDeploymentEnvironmentFavicon } = await loadHooks();

  const { unmount } = renderHook(() => useDeploymentEnvironmentFavicon());
  await waitFor(() => assert.equal(new URL(svgIcon.href).pathname, '/favicon-stage.svg'));
  assert.equal(unusableIcon.getAttribute('href'), href);

  unmount();
  assert.equal(svgIcon.getAttribute('href'), '/favicon.svg');
  assert.equal(unusableIcon.getAttribute('href'), href);
});

test('in production the favicon hook leaves the tab icons alone', async () => {
  stubHealth(replyWith({ status: 'ok', environment: null }));
  const svgIcon = addIconLink('icon', 'image/svg+xml', '/favicon.svg');
  const pngIcon = addIconLink('icon', 'image/png', '/favicon.png');
  const { useDeploymentEnvironmentFavicon } = await loadHooks();

  const { unmount } = renderHook(() => useDeploymentEnvironmentFavicon());
  await settle();
  unmount();

  assert.equal(healthRequests, 1);
  assert.equal(svgIcon.getAttribute('href'), '/favicon.svg');
  assert.equal(pngIcon.getAttribute('href'), '/favicon.png');
});
