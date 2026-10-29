import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { BashCommandDisplay } from '@/modules/chat/tools/BashCommandDisplay';
import { getToolConfig } from '@/modules/chat/tools/configs/toolConfigs';
import ToolGroupContainer from '@/modules/chat/transcript/ToolGroupContainer';
import ProviderSelectionEmptyState from '@/modules/chat/transcript/ProviderSelectionEmptyState';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import type { ChatMessage, ProviderModelActions, ProviderModelsDefinition, ToolGroupItem } from '@/shared/types';

/**
 * Words the tool cards still wrote in English, found on screen in the Chinese and Hebrew
 * interfaces: a command row's output line count, the badge over an Edit or a patch diff, a
 * collapsed run's name for the tools that have one in the interface language (a question, a
 * checklist, an MCP tool), and the name screen readers hear for the model picker's list (cmdk's
 * default "Suggestions"). English reads as before, apart from that list name.
 */

// The picker's task banner pulls in the terminal stack; these tests never show it.
vi.mock('@/modules/task-master', () => ({ NextTaskBanner: () => null }));

const markup = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const createDiff = createCachedDiffCalculator();

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('a command row with output', () => {
  const row = (output: string) => markup(createElement(BashCommandDisplay, { command: 'npm test', output }));

  it('counts its lines in Chinese and in Hebrew', async () => {
    await i18n.changeLanguage('zh-CN');
    assert.equal(row('a\nb\nc\nd').includes('>4 行<'), true);
    assert.equal(row('a\nb\nc\nd').includes('lines'), false);
    await i18n.changeLanguage('he');
    assert.equal(row('a').includes('>שורה אחת<'), true);
    assert.equal(row('a\nb').includes('>שתי שורות<'), true);
    assert.equal(row('a\nb\nc\nd').includes('שורות'), true);
    assert.equal(row('a\nb\nc\nd').includes('lines'), false);
  });

  it('reads as before in English', () => {
    assert.equal(row('a\nb\nc\nd').includes('>4 lines<'), true);
    assert.equal(row('a').includes('>1 line<'), true);
  });
});

describe('the badge over a diff', () => {
  // What ToolRenderer hands the diff viewer for the card: the helpers carry the interface's t.
  const badge = (toolName: string, language: string) => getToolConfig(toolName).input.getContentProps?.(
    { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' },
    { t: i18n.getFixedT(language) },
  )?.badge;

  it('names an Edit and a patch in Chinese and in Hebrew', () => {
    assert.equal(badge('Edit', 'zh-CN'), '编辑');
    assert.equal(badge('ApplyPatch', 'zh-CN'), '补丁');
    assert.equal(badge('Edit', 'he'), 'עריכה');
    assert.equal(badge('Write', 'zh-CN'), '新建');
  });

  it('reads as before in English, and without helpers', () => {
    assert.equal(badge('Edit', 'en'), 'Edit');
    assert.equal(badge('ApplyPatch', 'en'), 'Patch');
    assert.equal(getToolConfig('Edit').input.getContentProps?.({ file_path: '/a', old_string: 'a', new_string: 'b' })?.badge, 'Edit');
  });
});

describe('a collapsed run of tools', () => {
  const call = (toolName: string, toolInput: Record<string, unknown>): ChatMessage => ({
    type: 'assistant',
    content: '',
    timestamp: new Date('2026-10-29T00:00:00.000Z'),
    isToolUse: true,
    toolName,
    toolInput: JSON.stringify(toolInput),
  } as unknown as ChatMessage);
  const header = (toolName: string, toolInput: Record<string, unknown>) => {
    const group = { _isGroup: true, toolName, messages: [call(toolName, toolInput), call(toolName, toolInput)], timestamp: 't', preview: 'p' } as unknown as ToolGroupItem;
    const html = markup(createElement(ToolGroupContainer, {
      group,
      prevMessage: null,
      createDiff,
      getMessageKey: (message: ChatMessage) => String(message.timestamp),
      provider: 'claude' as const,
    }));
    // the name sits in the header's first text-xs font-medium span
    return /<span class="min-w-0 flex-shrink-0 text-xs font-medium text-foreground">([^<]*)<\/span>/.exec(html)?.[1] ?? '';
  };

  it('is named as its cards are, in Chinese', async () => {
    await i18n.changeLanguage('zh-CN');
    assert.equal(header('AskUserQuestion', { questions: [] }), '问题');
    assert.equal(header('TodoWrite', { todos: [] }), '清单');
    assert.equal(header('mcp__github__create_issue', { title: 'x' }), 'create_issue (github)');
    assert.equal(header('WebSearch', { query: 'x' }), '搜索');
  });

  it('is named as its cards are in English, a tool with no worded name by its own name', () => {
    assert.equal(header('AskUserQuestion', { questions: [] }), 'Question');
    assert.equal(header('TodoWrite', { todos: [] }), 'Checklist');
    assert.equal(header('Bash', { command: 'ls' }), 'Bash');
  });
});

describe('the model picker\'s list', () => {
  const CATALOG = {
    claude: { OPTIONS: [{ value: 'default', label: 'Default (recommended)' }], DEFAULT: 'default' },
  } as unknown as Record<string, ProviderModelsDefinition>;
  const ACTIONS = new Proxy({}, { get: () => vi.fn() }) as ProviderModelActions;
  const scrollIntoView = Element.prototype.scrollIntoView;

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    Element.prototype.scrollIntoView = () => undefined;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  it('is named in the interface language, not by cmdk\'s English default', async () => {
    await i18n.changeLanguage('zh-CN');
    render(
      <ProviderSelectionEmptyState
        selectedSession={null}
        currentSessionId={null}
        provider="claude"
        setProvider={() => {}}
        textareaRef={{ current: null }}
        providerModels={{ claude: 'default', codex: '', cursor: '', opencode: '', agy: '' }}
        setProviderModel={() => {}}
        providerModelCatalog={CATALOG as never}
        providerModelActions={ACTIONS}
        providerModelsLoading={false}
        tasksEnabled={false}
        isTaskMasterInstalled={null}
        setInput={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /点击更换模型/ }));
    const labels = [...document.querySelectorAll('[cmdk-list]')].map((list) => list.getAttribute('aria-label') ?? '');
    assert.deepEqual(labels, ['选择模型']);
  });
});
