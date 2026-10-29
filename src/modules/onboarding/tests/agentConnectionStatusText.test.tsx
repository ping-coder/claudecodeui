import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import { afterAll, afterEach, test } from 'vitest';

import { i18n } from '@/modules/i18n';
import AgentConnectionCard from '@/modules/onboarding/AgentConnectionCard';
import type { ProviderAuthStatus } from '@/shared/types';

/**
 * An onboarding card shows the sign-in state the server words in English. The sentences it always
 * words the same way read in the interface language; anything else, an email included, stays as it
 * came and is laid out by its own first letter, so right to left an English sentence keeps its full
 * stop at its end.
 */

const status = (overrides: Partial<ProviderAuthStatus>): ProviderAuthStatus => ({
  authenticated: false,
  email: null,
  method: null,
  error: null,
  loading: false,
  installed: true,
  ...overrides,
});

const statusLine = (providerStatus: ProviderAuthStatus) => {
  const { container, unmount } = render(
    <AgentConnectionCard
      provider="claude"
      title="Claude Code"
      status={providerStatus}
      connectedClassName="connected"
      iconContainerClassName=""
      onLogin={() => {}}
    />,
  );
  const line = container.querySelector('.text-xs.text-muted-foreground');
  const reading = { text: line?.textContent ?? '', laidOutByItself: line?.classList.contains('bidi-auto') ?? false };
  unmount();
  return reading;
};

afterEach(async () => {
  await i18n.changeLanguage('en');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

test('the server\'s fixed sentences read in the interface language', async () => {
  await i18n.changeLanguage('zh-CN');

  assert.deepEqual(statusLine(status({ error: 'Claude CLI is not authenticated. Run claude /login or configure ANTHROPIC_API_KEY.' })), {
    text: 'Claude CLI 未登录。运行 claude /login，或者配置 ANTHROPIC_API_KEY。',
    laidOutByItself: true,
  });
  assert.equal(statusLine(status({ error: 'Cursor CLI not found or not installed' })).text, '找不到 Cursor CLI，或者没有安装');
  assert.equal(statusLine(status({ authenticated: true, email: 'API Key Auth' })).text, 'API 密钥');
  // The bare "Authenticated" names no account: the card says it is connected.
  assert.equal(statusLine(status({ authenticated: true, email: 'Authenticated' })).text, '已连接');
  assert.equal(statusLine(status({ authenticated: true, email: 'dana@example.com' })).text, 'dana@example.com');
});

test('anything else stays as it came, laid out by its own first letter', async () => {
  await i18n.changeLanguage('he');

  assert.deepEqual(statusLine(status({ error: 'spawn claude ENOENT.' })), { text: 'spawn claude ENOENT.', laidOutByItself: true });
});

test('English keeps the server\'s words', () => {
  assert.equal(
    statusLine(status({ error: 'Claude login has expired. Run claude /login again.' })).text,
    'Claude login has expired. Run claude /login again.',
  );
  assert.equal(statusLine(status({ authenticated: true, email: 'OAuth Token (long-lived)' })).text, 'OAuth Token (long-lived)');
});
