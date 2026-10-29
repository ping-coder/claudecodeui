import assert from 'node:assert/strict';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, it } from 'vitest';

import { i18n } from '@/modules/i18n';
import { ToolRenderer } from '@/modules/chat/tools/ToolRenderer';
import { TOOL_CONFIGS } from '@/modules/chat/tools/configs/toolConfigs';
import ToolGroupContainer from '@/modules/chat/transcript/ToolGroupContainer';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import type { ChatMessage, ToolGroupItem } from '@/shared/types';

/**
 * A collapsed run of tools shows a letter beside its name. It was the first letter of the tool's
 * id, so a run of questions read "A 问题" in Chinese ("A" for AskUserQuestion) and a checklist
 * "T". It is now the first letter of the name beside it, in any language. TodoRead was named by
 * its id ("TodoRead") everywhere; it is named as the checklist it reads.
 */

const createDiff = createCachedDiffCalculator();

afterEach(async () => {
  await i18n.changeLanguage('en');
});

const call = (toolName: string, toolInput: Record<string, unknown>): ChatMessage => ({
  type: 'assistant',
  content: '',
  timestamp: new Date('2026-10-29T00:00:00.000Z'),
  isToolUse: true,
  toolName,
  toolInput: JSON.stringify(toolInput),
} as unknown as ChatMessage);

/** The group header's letter and name, as "letter|name". */
const header = (toolName: string, toolInput: Record<string, unknown> = {}) => {
  const group = { _isGroup: true, toolName, messages: [call(toolName, toolInput), call(toolName, toolInput)], timestamp: 't', preview: 'p' } as unknown as ToolGroupItem;
  const html = renderToStaticMarkup(createElement(ToolGroupContainer, {
    group,
    prevMessage: null,
    createDiff,
    getMessageKey: (message: ChatMessage) => String(message.timestamp),
    provider: 'claude' as const,
  }));
  const letter = /rounded bg-background\/80 text-xs font-medium">([^<]*)<\/span>/.exec(html)?.[1] ?? '';
  const name = /<span class="min-w-0 flex-shrink-0 text-xs font-medium text-foreground">([^<]*)<\/span>/.exec(html)?.[1] ?? '';
  return `${letter}|${name.replace(/[\u2066-\u2069]/g, '')}`;
};

describe('a collapsed run of tools', () => {
  it('takes its letter from its name in Chinese', async () => {
    await i18n.changeLanguage('zh-CN');
    assert.equal(header('AskUserQuestion', { questions: [] }), '问|问题');
    assert.equal(header('TodoWrite', { todos: [] }), '清|清单');
    assert.equal(header('TodoRead'), '清|清单');
    assert.equal(header('WebSearch', { query: 'x' }), '搜|搜索');
  });

  it('and in Hebrew', async () => {
    await i18n.changeLanguage('he');
    assert.equal(header('AskUserQuestion', { questions: [] }), 'ש|שאלה');
    assert.equal(header('WebFetch', { url: 'https://example.com' }), 'א|אחזור');
  });

  it('skips the isolates around an English name a right-to-left interface falls back to', async () => {
    // A name with no Hebrew yet reads in English, wrapped in LRI…PDI (i18n's bidi handling).
    TOOL_CONFIGS.NamedOnlyInEnglish = { input: { type: 'one-line', label: 'Probe', labelKey: 'chat:tools.labels.notTranslatedProbe' } };
    try {
      await i18n.changeLanguage('he');
      assert.equal(header('NamedOnlyInEnglish'), 'P|Probe');
    } finally {
      delete TOOL_CONFIGS.NamedOnlyInEnglish;
    }
  });

  it('in English, from the name as it reads; a terminal keeps its "$"', () => {
    assert.equal(header('AskUserQuestion', { questions: [] }), 'Q|Question');
    assert.equal(header('TodoRead'), 'C|Checklist');
    assert.equal(header('mcp__github__create_issue', { title: 'x' }), 'C|create_issue (github)');
    assert.equal(header('Read', { file_path: '/a.ts' }), 'R|Read');
    assert.equal(header('Bash', { command: 'ls' }), '$|Bash');
  });
});

describe('TodoRead on its own row', () => {
  const row = () => renderToStaticMarkup(createElement(ToolRenderer, { toolName: 'TodoRead', toolInput: '{}', mode: 'input', createDiff }));

  it('is named as the checklist in the interface language', async () => {
    await i18n.changeLanguage('zh-CN');
    assert.equal(row().includes('清单'), true);
    assert.equal(row().includes('TodoRead'), false);
    await i18n.changeLanguage('en');
    assert.equal(row().includes('Checklist'), true);
    assert.equal(row().includes('TodoRead'), false);
  });
});
