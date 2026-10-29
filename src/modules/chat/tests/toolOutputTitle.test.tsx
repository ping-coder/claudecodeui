import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import { afterEach, describe, it } from 'vitest';

import { i18n } from '@/modules/i18n';
import { ToolRenderer } from '@/modules/chat/tools/ToolRenderer';

/**
 * A tool with no renderer of its own (an MCP tool, CronCreate) and a sandbox
 * script show their result under "Output", which reads in the interface language.
 */

const renderResult = (toolName: string) => render(
  <ToolRenderer toolName={toolName} toolInput="{}" toolResult={{ content: 'Scheduled job cron-1' }} mode="result" />,
);

/** The row's text as a string, so a failing assertion never inspects a DOM node. */
const rowText = (view: ReturnType<typeof renderResult>) => view.container.textContent ?? '';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('a tool result\'s heading', () => {
  it('reads "输出" in Chinese, for an unmapped tool and a sandbox script', async () => {
    await i18n.changeLanguage('zh-CN');
    for (const toolName of ['CronCreate', 'mcp__github__list_issues', 'exec']) {
      const view = renderResult(toolName);
      assert.equal(rowText(view).includes('输出'), true, toolName);
      assert.equal(rowText(view).includes('Output'), false, toolName);
      view.unmount();
    }
  });

  it('reads "Output" in English', () => {
    const view = renderResult('CronCreate');
    assert.equal(rowText(view).includes('Output'), true);
  });
});
