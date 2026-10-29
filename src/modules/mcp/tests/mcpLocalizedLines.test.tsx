import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import type { ProviderMcpServer } from '@/shared/types';

/**
 * An MCP server's config lines take the colon and the order from the translation (full width in
 * Chinese) and show the value as typed; right to left the value stays isolated, and the form keeps its
 * code examples (the args placeholder, the JSON field and its examples) left to right.
 */

const SERVER: ProviderMcpServer = {
  provider: 'claude',
  name: 'context7',
  scope: 'user',
  transport: 'stdio',
  command: 'npx',
  args: ['--header', 'X-Key: <token>'],
} as ProviderMcpServer;

vi.mock('@/modules/mcp/hooks/useMcpServers', () => ({
  useMcpServers: () => ({
    servers: [SERVER],
    isLoading: false,
    isLoadingProjectScopes: false,
    loadError: null,
    deleteError: null,
    saveStatus: null,
    serverForm: null,
    openForm: () => {},
    openGlobalForm: () => {},
    closeForm: () => {},
    submitForm: async () => {},
    submitGlobalForm: async () => {},
    deleteServer: () => {},
  }),
}));

const { default: McpServers } = await import('@/modules/mcp/McpServers');
const { default: McpServerFormModal } = await import('@/modules/mcp/McpServerFormModal');

afterEach(async () => {
  await i18n.changeLanguage('en');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

/** Each config line under the server: its text, and the text of its value. */
const readConfigLines = (container: HTMLElement) => [...container.querySelectorAll('code')]
  .map((code) => ({ line: code.parentElement?.textContent ?? '', value: code.textContent ?? '' }));

test('an MCP server\'s config lines put the label and the value as the translation says', async () => {
  await i18n.changeLanguage('zh-CN');
  const zh = render(<McpServers selectedProvider="claude" currentProjects={[]} />);
  assert.deepEqual(readConfigLines(zh.container), [
    { line: '命令：npx', value: 'npx' },
    // The value is rendered as typed: Trans would show the "<" escaped.
    { line: '参数：--header X-Key: <token>', value: '--header X-Key: <token>' },
  ]);
  zh.unmount();

  await i18n.changeLanguage('en');
  const en = render(<McpServers selectedProvider="claude" currentProjects={[]} />);
  assert.deepEqual(readConfigLines(en.container).map(({ line }) => line), ['Command: npx', 'Args: --header X-Key: <token>']);
});

test('right to left the value of a config line is isolated around its code element', async () => {
  await i18n.changeLanguage('he');
  const { container } = render(<McpServers selectedProvider="claude" currentProjects={[]} />);
  const [command] = readConfigLines(container);

  assert.equal(command.value, 'npx');
  assert.equal(command.line.endsWith(': \u2068npx\u2069'), true, command.line);
});

test('the MCP form keeps its code examples left to right', async () => {
  await i18n.changeLanguage('he');
  render(
    <McpServerFormModal
      provider="claude"
      editingServer={null}
      currentProjects={[]}
      onClose={() => {}}
      onSubmit={async () => {}}
    />,
  );

  const args = [...document.querySelectorAll('textarea')].find((field) => field.placeholder.includes('--port'));
  assert.equal(args?.placeholder, '\u2066--port\u2069\n3000');

  fireEvent.click(screen.getByRole('button', { name: i18n.t('settings:mcpForm.importMode.json') }));
  const json = [...document.querySelectorAll('textarea')].find((field) => field.placeholder.startsWith('{'));
  assert.equal(json?.getAttribute('dir'), 'ltr');
  const examples = [...document.querySelectorAll('p span[dir="ltr"]')].map((example) => example.textContent?.split(':')[0]);
  assert.deepEqual(examples, ['- stdio', '- http/sse']);
});

test('English keeps the args example as it was', async () => {
  render(
    <McpServerFormModal
      provider="claude"
      editingServer={null}
      currentProjects={[]}
      onClose={() => {}}
      onSubmit={async () => {}}
    />,
  );
  const args = [...document.querySelectorAll('textarea')].find((field) => field.placeholder.includes('--port'));
  assert.equal(args?.placeholder, '--port\n3000');
});
