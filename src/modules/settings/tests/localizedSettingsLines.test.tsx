import assert from 'node:assert/strict';

import { render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import type * as Api from '@/shared/api';
import { stripBidiIsolates } from '@/shared/direction';
import type { ProviderAuthStatus } from '@/shared/types';

/**
 * The Browser status chips take the colon and the order from the translation (full width in Chinese),
 * the About links and the git placeholders are translated, and the agent account view shows the
 * server's fixed English in the interface language.
 */

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof Api>();
  const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 }));
  return {
    ...actual,
    api: {
      ...actual.api,
      browserUse: {
        settings: () => json({ settings: { enabled: true } }),
        status: () => json({
          enabled: true,
          available: true,
          playwrightInstalled: true,
          chromiumInstalled: false,
          installInProgress: false,
          message: '',
        }),
      },
    },
  };
});

vi.mock('@/modules/settings/hooks/useGitSettings', () => ({
  useGitSettings: () => ({
    gitName: '',
    setGitName: () => {},
    gitEmail: '',
    setGitEmail: () => {},
    isLoading: false,
    isSaving: false,
    saveStatus: null,
    saveGitConfig: () => {},
  }),
}));

const { default: BrowserUseSettingsTab } = await import('@/modules/settings/tabs/browser-use-settings/BrowserUseSettingsTab');
const { default: GitSettingsTab } = await import('@/modules/settings/tabs/git-settings/GitSettingsTab');
const { default: AboutTab } = await import('@/modules/settings/tabs/AboutTab');
const { default: AccountContent } = await import('@/modules/settings/tabs/agents-settings/sections/content/AccountContent');

afterEach(async () => {
  await i18n.changeLanguage('en');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

test('the Browser status chips take their colon from the translation', async () => {
  await i18n.changeLanguage('zh-CN');
  const { container } = render(<BrowserUseSettingsTab />);

  await waitFor(() => assert.equal(container.textContent?.includes('状态：就绪'), true, container.textContent ?? ''));
  const chips = [...container.querySelectorAll('span.rounded-md.border')].map((chip) => chip.textContent);
  assert.deepEqual(chips, ['Playwright：已安装', 'Chromium：未安装', '状态：就绪']);
});

test('the About tab names its docs link in the interface language', async () => {
  await i18n.changeLanguage('zh-CN');
  render(<AboutTab />);
  assert.equal(screen.getByRole('link', { name: '文档' }).getAttribute('href'), 'https://cloudcli.ai/docs/plugin-overview');
});

test('the git identity placeholders are the onboarding\'s, in the interface language', async () => {
  await i18n.changeLanguage('zh-CN');
  const { container } = render(<GitSettingsTab />);
  const placeholders = [...container.querySelectorAll('input')].map((input) => input.placeholder);
  assert.deepEqual(placeholders, ['张三', 'zhangsan@example.com']);
});

const claudeStatus = (overrides: Partial<ProviderAuthStatus>): ProviderAuthStatus => ({
  authenticated: false,
  email: null,
  method: null,
  error: null,
  loading: false,
  installed: true,
  ...overrides,
});

test('the account view shows the server\'s fixed English in the interface language', async () => {
  await i18n.changeLanguage('zh-CN');
  const signedOut = render(
    <AccountContent
      agent="claude"
      authStatus={claudeStatus({ error: 'Claude CLI is not authenticated. Run claude /login or configure ANTHROPIC_API_KEY.' })}
      onLogin={() => {}}
    />,
  );
  assert.equal(signedOut.container.textContent?.includes('错误：Claude CLI 未登录。运行 claude /login，或者配置 ANTHROPIC_API_KEY。'), true);
  signedOut.unmount();

  const keyed = render(
    <AccountContent agent="claude" authStatus={claudeStatus({ authenticated: true, email: 'API Key Auth', method: 'api_key' })} />,
  );
  assert.equal(keyed.container.textContent?.includes('登录为 API 密钥'), true);
  keyed.unmount();

  // The server's bare "Authenticated" names no account.
  const bare = render(<AccountContent agent="claude" authStatus={claudeStatus({ authenticated: true, email: 'Authenticated' })} />);
  assert.equal(bare.container.textContent?.includes('登录为 已认证用户'), true);
  bare.unmount();

  // An error the server passed through from elsewhere stays as it came.
  render(<AccountContent agent="codex" authStatus={claudeStatus({ error: 'EACCES: permission denied' })} />);
  assert.equal(screen.getByText('错误：EACCES: permission denied').tagName, 'DIV');
});

test('right to left an English error the server passed through is isolated in the error line', async () => {
  await i18n.changeLanguage('he');
  const { container } = render(<AccountContent agent="codex" authStatus={claudeStatus({ error: 'EACCES: permission denied.' })} />);

  assert.equal(container.textContent?.includes('שגיאה: \u2068EACCES: permission denied.\u2069'), true);
  assert.equal(stripBidiIsolates(container.textContent ?? '').includes('שגיאה: EACCES: permission denied.'), true);
});
