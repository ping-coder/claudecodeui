import assert from 'node:assert/strict';

import { act, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { afterEach, describe, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { Reasoning, ReasoningTrigger } from '@/modules/chat/transcript/Reasoning';
import PermissionRequestsBanner from '@/modules/chat/composer/PermissionRequestsBanner';
import { SubagentPanel } from '@/modules/chat/tools/SubagentPanel';
import { SubagentTimeline } from '@/modules/chat/tools/SubagentTimeline';
import { PlanDisplay } from '@/modules/chat/tools/PlanDisplay';
import { CollapsibleDisplay } from '@/modules/chat/tools/CollapsibleDisplay';
import { AskUserQuestionPanel } from '@/modules/chat/tools/InteractiveRenderers/AskUserQuestionPanel';
import { QuestionAnswerContent } from '@/modules/chat/tools/ContentRenderers/QuestionAnswerContent';
import { TaskListContent } from '@/modules/chat/tools/ContentRenderers/TaskListContent';
import TodoList from '@/modules/chat/tools/ContentRenderers/TodoList';
import { ToolRenderer } from '@/modules/chat/tools/ToolRenderer';
import { ToolStatusBadge } from '@/modules/chat/tools/ToolStatusBadge';
import { DiffStatsBadge } from '@/modules/chat/tools/DiffStatsBadge';
import { MemoryCitations } from '@/modules/chat/transcript/MemoryCitations';
import ChatMessageFiles from '@/modules/chat/transcript/ChatMessageFiles';
import ComposerAttachment from '@/modules/chat/composer/ComposerAttachment';
import QueuedMessageCard from '@/modules/chat/composer/QueuedMessageCard';
import { groupConsecutiveTools, isToolGroupItem } from '@/modules/chat/utils/toolGrouping';
import { formatUsageLimitText } from '@/modules/chat/utils/chatFormatting';
import { buildTranscriptExport } from '@/modules/chat/utils/chatExport';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, PendingPermissionRequest } from '@/shared/types';

/**
 * The chat words that were written into the code in English read in the interface language:
 * the reasoning toggle, the permission request, the agent card, the plan, the question panel and
 * its answers, the tool rows' titles, labels and states, the usage-limit notice and the exported
 * file's header line. The English interface reads as before.
 */

const zh = i18n.getFixedT('zh-CN');
const en = i18n.getFixedT('en');
const markup = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
/** The page's text, as a string: a failing assertion never inspects a DOM node. */
const pageText = () => document.body.textContent ?? '';

const showLanguage = (language: string) => i18n.changeLanguage(language);

afterEach(async () => {
  await showLanguage('en');
});

describe('the reasoning toggle', () => {
  const trigger = (isStreaming: boolean, duration?: number) => markup(
    createElement(Reasoning, { isStreaming, duration, defaultOpen: false }, createElement(ReasoningTrigger)),
  );

  it('says it thinks, and for how long it thought, in Chinese and in Hebrew', async () => {
    await showLanguage('zh-CN');
    assert.equal(trigger(true).includes('思考中…'), true);
    assert.equal(trigger(false).includes('思考了几秒'), true);
    assert.equal(trigger(false, 5).includes('思考了 5 秒'), true);
    assert.equal(trigger(false, 5).includes('Thought'), false);
    await showLanguage('he');
    assert.equal(trigger(false, 2).includes('חשב שתי שניות'), true);
  });

  it('reads as before in English, a single second in the singular', () => {
    assert.equal(trigger(true).includes('Thinking...'), true);
    assert.equal(trigger(false).includes('Thought for a few seconds'), true);
    assert.equal(trigger(false, 7).includes('Thought for 7 seconds'), true);
    assert.equal(trigger(false, 1).includes('Thought for 1 second<'), true);
  });
});

describe('the permission request', () => {
  const request: PendingPermissionRequest = {
    requestId: 'r1',
    toolName: 'Bash',
    input: { command: 'git status' },
    sessionId: 's1',
    receivedAt: new Date(),
  };
  const renderBanner = () => render(
    <PermissionRequestsBanner
      pendingPermissionRequests={[request]}
      handlePermissionDecision={() => {}}
      handleGrantToolPermission={() => ({ success: true })}
    />,
  );

  it('asks in Chinese', async () => {
    await showLanguage('zh-CN');
    renderBanner();
    for (const words of ['需要权限', '工具：', '允许规则：', '查看工具输入', '拒绝', '允许并记住', '仅允许这次']) {
      assert.equal(pageText().includes(words), true, words);
    }
    assert.equal(pageText().includes('Permission required'), false);
  });

  it('reads as before in English', () => {
    renderBanner();
    for (const words of ['Permission required', 'Tool:', 'Allow rule:', 'View tool input', 'Deny', 'Allow & remember', 'Allow once']) {
      assert.equal(pageText().includes(words), true, words);
    }
  });
});

describe('the agent card', () => {
  const createDiff = createCachedDiffCalculator();
  const card = (props: Partial<Parameters<typeof SubagentPanel>[0]>) => markup(createElement(SubagentPanel, {
    toolInput: JSON.stringify({ description: 'Survey the repo', prompt: 'Look around' }),
    createDiff,
    ...props,
  }));

  it('names the agent and its state in Chinese', async () => {
    await showLanguage('zh-CN');
    assert.equal(card({}).includes('智能体'), true);
    assert.equal(card({}).includes('运行中'), true);
    const stopped = card({ subagent: { status: 'stopped' } as never });
    assert.equal(stopped.includes('无结果'), true);
    assert.equal(stopped.includes('title="这次运行在智能体回报结果之前就结束了"'), true);
    const done = card({
      toolResult: { content: 'All good', isError: false },
      activity: [{ kind: 'tool', toolName: 'Read', toolId: 't1' }, { kind: 'tool', toolName: 'Read', toolId: 't2' }] as never,
    });
    assert.equal(done.includes('2 次工具调用'), true);
    assert.equal(card({ toolResult: { content: 'All good', isError: false } }).includes('已完成'), true);
  });

  it('labels the task and the result in Chinese once open', async () => {
    await showLanguage('zh-CN');
    render(createElement(SubagentPanel, {
      toolInput: JSON.stringify({ description: 'Survey', prompt: 'Look around' }),
      toolResult: { content: 'Found it', isError: false },
      createDiff,
    }));
    screen.getByRole('button').click();
    await vi.waitFor(() => assert.equal(pageText().includes('任务'), true));
    assert.equal(pageText().includes('结果'), true);
  });

  it('says in Chinese how many steps are hidden or left out', async () => {
    await showLanguage('zh-CN');
    const steps = Array.from({ length: 30 }, (_value, index) => ({ kind: 'text', text: `step ${index}` }));
    assert.equal(markup(createElement(SubagentTimeline, { activity: steps as never, createDiff })).includes('再显示 5 步'), true);
    assert.equal(markup(createElement(SubagentTimeline, { activity: steps.slice(0, 3) as never, activityCount: 7, createDiff })).includes('前面还有 4 步没有包含在内'), true);
  });
});

describe('the plan and the raw parameters', () => {
  it('say what they are in Chinese', async () => {
    await showLanguage('zh-CN');
    const plan = markup(createElement(PlanDisplay, { title: 'x', content: '', isStreaming: true, defaultOpen: true, toolName: 'ExitPlanMode' }));
    assert.equal(plan.includes('正在生成计划…'), true);
    assert.equal(plan.includes('展开或收起计划'), true);
    const params = markup(<CollapsibleDisplay toolName="Tool" title="t" defaultOpen showRawParameters rawContent="{}">{null}</CollapsibleDisplay>);
    assert.equal(params.includes('原始参数'), true);
    assert.equal(params.includes('raw params'), false);
  });
});

describe('the question panel and its answers', () => {
  const questions = [
    { question: 'Which files?', header: 'Files', multiSelect: true, options: [{ label: 'a.ts' }, { label: 'b.ts' }] },
    { question: 'Go ahead?', header: 'Confirm', multiSelect: false, options: [{ label: 'Yes' }] },
  ];

  it('ask in Chinese', async () => {
    await showLanguage('zh-CN');
    render(<AskUserQuestionPanel request={{ requestId: 'q1', toolName: 'AskUserQuestion', input: { questions }, sessionId: 's1', receivedAt: new Date() }} onDecision={() => {}} />);
    for (const words of ['Claude 需要你回答', '可多选', '其他…', '下一步']) {
      assert.equal(pageText().includes(words), true, words);
    }
    assert.equal(pageText().includes('Select all that apply'), false);
  });

  it('show the answers, a custom one and a skipped question in Chinese', async () => {
    await showLanguage('zh-CN');
    const answered = markup(createElement(QuestionAnswerContent, { questions, answers: { 'Which files?': 'c.ts' } }));
    assert.equal(answered.includes('（自定义）'), true);
    assert.equal(answered.includes('已跳过'), true);
    const none = markup(createElement(QuestionAnswerContent, { questions: questions.slice(1), answers: {} }));
    assert.equal(none.includes('已跳过'), true);
  });
});

describe('the tool rows', () => {
  const row = (toolName: string, toolInput: unknown, mode: 'input' | 'result' = 'input', toolResult?: unknown) => markup(createElement(ToolRenderer, {
    toolName,
    toolInput: JSON.stringify(toolInput),
    toolResult,
    mode,
    createDiff: createCachedDiffCalculator(),
  }));

  it('title, label and word their state in Chinese', async () => {
    await showLanguage('zh-CN');
    assert.equal(row('WebSearch', { query: 'x' }, 'result', { content: 'r' }).includes('搜索结果'), true);
    assert.equal(row('WebSearch', { query: 'x' }).includes('>搜索<'), true);
    assert.equal(row('Grep', { pattern: 'x' }, 'result', { content: '', toolUseResult: { numFiles: 3 } }).includes('找到 3 个文件'), true);
    assert.equal(row('Grep', { pattern: 'x', path: 'src' }).includes('位于 src'), true);
    assert.equal(row('TodoWrite', { todos: [] }).includes('正在更新清单'), true);
    assert.equal(row('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }] }).includes('全部完成 — 2/2'), true);
    assert.equal(row('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] }).includes('已完成 1/2'), true);
    assert.equal(row('TodoWrite', { todos: [] }).includes('清单'), true);
    assert.equal(row('TodoRead', {}).includes('正在读取清单'), true);
    assert.equal(row('AskUserQuestion', { questions: [{ question: 'q', options: [] }] }).includes('问题'), true);
    assert.equal(row('ExitPlanMode', { plan: 'p' }).includes('实施计划'), true);
    assert.equal(row('exec', 'print(1)').includes('沙箱脚本'), true);
    assert.equal(row('Task', { subagent_type: 'Explore', description: 'Survey' }).includes('子智能体 / Explore：Survey'), true);
    assert.equal(row('TaskList', {}, 'result', { content: 'x' }).includes('任务列表'), true);
    assert.equal(row('Read', { file_path: '/a.ts' }).includes('运行中'), true);
  });

  it('read as before in English', () => {
    assert.equal(row('Grep', { pattern: 'x' }, 'result', { content: '', toolUseResult: { numFiles: 1 } }).includes('Found 1 file<'), true);
    assert.equal(row('Grep', { pattern: 'x', path: 'src' }).includes('in src'), true);
    assert.equal(row('TodoWrite', { todos: [{ content: 'a', status: 'completed' }] }).includes('Done — 1/1'), true);
    assert.equal(row('TodoRead', {}).includes('reading list'), true);
    assert.equal(row('Read', { file_path: '/a.ts' }).includes('Running'), true);
  });

  it('sum up a collapsed run in Chinese', () => {
    const read = (path: string): ChatMessage => ({ type: 'tool', content: '', timestamp: 't', isToolUse: true, toolName: 'Read', toolInput: JSON.stringify({ file_path: path }) });
    const [group] = groupConsecutiveTools([read('/a.ts'), read('/b.ts'), read('/c.ts'), read('/d.ts')], zh);
    assert.equal(isToolGroupItem(group) && group.preview, '/a.ts, /b.ts, 另有 2 个');
  });

  it('word a task list, a checklist and a badge in Chinese', async () => {
    await showLanguage('zh-CN');
    const tasks = markup(createElement(TaskListContent, { content: '#1. [completed] Ship\n#2. [in_progress] Test' }));
    assert.equal(tasks.includes('已完成 1/2'), true);
    assert.equal(tasks.includes('进行中'), true);
    assert.equal(markup(createElement(TodoList, { todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }] as never, isResult: true })).includes('待办列表（2 项）'), true);
    assert.equal(markup(createElement(ToolStatusBadge, { status: 'denied' })).includes('已拒绝'), true);
    assert.equal(markup(createElement(DiffStatsBadge, { stats: { added: 2, removed: 1 } })).includes('aria-label="新增 2 行，删除 1 行"'), true);
  });
});

describe('the attachments and citations', () => {
  it('are labelled in Chinese', async () => {
    await showLanguage('zh-CN');
    assert.equal(markup(createElement(MemoryCitations, { citations: [{ source: 'a.md' }, { source: 'b.md' }] as never })).includes('用到 2 条记忆'), true);
    assert.equal(markup(createElement(ChatMessageFiles, { files: [{ name: 'notes.txt' }] })).includes('aria-label="下载 notes.txt"'), true);
    assert.equal(markup(createElement(ChatMessageFiles, { files: [{ name: 'notes.txt' }] })).includes('文件附件'), true);
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    assert.equal(markup(createElement(ComposerAttachment, { file, onRemove: () => {} })).includes('aria-label="移除 a.txt"'), true);
    assert.equal(markup(createElement(QueuedMessageCard, { content: 'hi', attachmentCount: 2, onEdit: () => {}, onDelete: () => {} })).includes('附带 2 个文件'), true);
  });
});

describe('the usage-limit notice', () => {
  const marker = 'Claude AI usage limit reached|1793000000';

  it('is a sentence in Chinese', () => {
    const text = formatUsageLimitText(marker, zh, 'zh-CN');
    assert.equal(text.startsWith('Claude 用量已达上限，将在 **'), true);
    assert.equal(text.includes('usage limit'), false);
  });

  it('reads as before in English', () => {
    const reset = new Date(1793000000 * 1000);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const text = formatUsageLimitText(marker, en, 'en');
    assert.equal(text.startsWith('Claude usage limit reached. Your limit will reset at **'), true);
    assert.equal(text.endsWith(` - ${reset.getDate()} ${months[reset.getMonth()]} ${reset.getFullYear()}`), true);
  });
});

describe('the usage-limit notice in a reply', () => {
  it('is worded where the row is drawn, so a change of language reaches it', async () => {
    const [message] = normalizedToChatMessages([{
      id: 'text-1',
      sessionId: 'session-1',
      timestamp: '2026-10-29T10:00:00.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'assistant',
      content: 'Claude AI usage limit reached|1793000000',
    }]);
    assert.equal(message.content, 'Claude AI usage limit reached|1793000000');
    const view = render(
      <UiPreferencesProvider>
        <MessageComponent message={message} prevMessage={null} createDiff={() => []} provider="claude" />
      </UiPreferencesProvider>,
    );
    assert.equal(pageText().includes('Claude usage limit reached. Your limit will reset at'), true);
    await act(async () => {
      await showLanguage('zh-CN');
    });
    view.rerender(
      <UiPreferencesProvider>
        <MessageComponent message={message} prevMessage={null} createDiff={() => []} provider="claude" />
      </UiPreferencesProvider>,
    );
    assert.equal(pageText().includes('Claude 用量已达上限，将在'), true);
    assert.equal(pageText().includes('usage limit'), false);
  });
});

describe('the exported file\'s header line', () => {
  const exportedAt = new Date('2026-08-24T09:30:00.000Z');
  const messages: ChatMessage[] = [
    { type: 'user', content: 'Hi', timestamp: '2026-08-24T09:00:00.000Z' },
    { type: 'assistant', content: 'Hello', timestamp: '2026-08-24T09:00:01.000Z' },
  ];
  const input = (language: string) => ({
    messages,
    sessionTitle: 'Greeting',
    provider: 'claude',
    createDiff: createCachedDiffCalculator(),
    t: i18n.getFixedT(language),
    language,
  });

  it('counts the messages and says when, in Chinese, in both formats', async () => {
    const time = exportedAt.toLocaleString('zh-CN');
    const md = await buildTranscriptExport('markdown', input('zh-CN'), exportedAt);
    assert.equal(md.includes(`_2 条消息 · 导出于 ${time}_`), true);
    const html = await buildTranscriptExport('html', input('zh-CN'), exportedAt);
    assert.equal(html.includes(`2 条消息 · 导出于 ${time}`), true);
    assert.equal(html.includes('<html lang="zh-CN" class='), true);
    assert.equal(html.includes('切换主题'), true);
  });

  it('sets the page right to left in Hebrew', async () => {
    const html = await buildTranscriptExport('html', input('he'), exportedAt);
    assert.equal(html.includes('<html lang="he" dir="rtl"'), true);
  });

  it('reads as before in English', async () => {
    const md = await buildTranscriptExport('markdown', input('en'), exportedAt);
    assert.equal(md.includes(`_2 messages · exported ${exportedAt.toLocaleString('en')}_`), true);
    const html = await buildTranscriptExport('html', input('en'), exportedAt);
    assert.equal(html.includes('<html lang="en" class='), true);
    assert.equal(html.includes('Toggle theme'), true);
  });
});
