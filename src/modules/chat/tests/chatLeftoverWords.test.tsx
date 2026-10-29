import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { afterEach, describe, it } from 'vitest';

import { i18n } from '@/modules/i18n';
import { ScheduledMessageList } from '@/modules/chat/composer/ScheduledMessageList';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { buildTranscriptExport } from '@/modules/chat/utils/chatExport';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, NormalizedMessage, ScheduledMessage } from '@/shared/types';

/**
 * Words chat still wrote in English whatever the interface language: the Markdown export's
 * headings and labels, the rows for an error or a background task's report that came without
 * words of their own, and why a scheduled message did not go, which the server now records as a
 * code for a hand-over failure. English reads as before, apart from the export's "(s)" plural.
 */

const createDiff = createCachedDiffCalculator();
const exportedAt = new Date('2026-10-29T09:30:00.000Z');

const showLanguage = async (language: string) => {
  await act(async () => {
    await i18n.changeLanguage(language);
  });
};

/** The page's text, read as a string so a failing assertion never inspects a DOM node. */
const pageText = () => document.body.textContent ?? '';

afterEach(async () => {
  await showLanguage('en');
});

const TRANSCRIPT: ChatMessage[] = [
  {
    type: 'user',
    content: 'Rename the helper',
    timestamp: new Date('2026-10-29T09:00:00.000Z'),
    images: [{ name: 'a.png', data: 'x' }, { name: 'b.png', data: 'y' }],
    files: [{ name: 'notes.txt', path: '/repo/notes.txt' }],
  },
  { type: 'assistant', isThinking: true, content: 'Read the helper first.', timestamp: new Date('2026-10-29T09:00:10.000Z') },
  {
    type: 'assistant',
    content: '',
    isToolUse: true,
    toolName: 'Bash',
    toolInput: JSON.stringify({ command: 'npm test' }),
    toolResult: { content: 'ok', isError: false },
    timestamp: new Date('2026-10-29T09:00:20.000Z'),
  },
  {
    type: 'assistant',
    content: '',
    isToolUse: true,
    toolName: 'Bash',
    toolInput: JSON.stringify({ command: 'npm run lint' }),
    toolResult: { content: 'lint failed', isError: true },
    timestamp: new Date('2026-10-29T09:00:30.000Z'),
  },
  { type: 'assistant', content: 'Done.', reasoning: 'It was a rename.', timestamp: new Date('2026-10-29T09:00:40.000Z') },
  { type: 'error', content: 'Rate limited', timestamp: new Date('2026-10-29T09:00:50.000Z') },
  { type: 'error', content: '', timestamp: new Date('2026-10-29T09:00:55.000Z') },
] as ChatMessage[];

const markdownIn = (language: string) => buildTranscriptExport('markdown', {
  messages: TRANSCRIPT,
  sessionTitle: 'Rename the helper',
  provider: 'claude',
  createDiff,
  t: i18n.getFixedT(language),
  language,
}, exportedAt);

describe('the Markdown export', () => {
  it('writes its headings and labels in Chinese', async () => {
    const markdown = await markdownIn('zh-CN');
    for (const line of ['### 你', '_2 张图片附件_', '_附件：notes.txt_', '### Claude 的思考', '_结果：_', '_失败：_', '<summary>推理过程</summary>', '### 错误', '未知错误']) {
      assert.equal(markdown.includes(line), true, line);
    }
    for (const english of ['### You', 'image attachment', 'Attached:', 'thinking', '_Result:_', '_Failed:_', 'Reasoning', '### Error', 'Unknown error']) {
      assert.equal(markdown.includes(english), false, english);
    }
  });

  it('carries no bidi isolates in Hebrew: the file leaves the screen', async () => {
    const markdown = await markdownIn('he');
    assert.equal(markdown.includes('### את/ה'), true);
    assert.equal(markdown.includes('_2 תמונות מצורפות_'), false, 'two is said in words');
    assert.equal(markdown.includes('_שתי תמונות מצורפות_'), true);
    assert.equal(markdown.includes('### החשיבה של Claude'), true);
    assert.equal(/[\u2066-\u2069]/.test(markdown), false);
  });

  it('reads as before in English, with a real plural', async () => {
    const markdown = await markdownIn('en');
    for (const line of ['### You', '_2 image attachments_', '_Attached: notes.txt_', '### Claude — thinking', '_Result:_', '_Failed:_', '<summary>Reasoning</summary>', '### Error', 'Unknown error']) {
      assert.equal(markdown.includes(line), true, line);
    }
  });
});

const renderRow = (row: NormalizedMessage) => {
  const [message] = normalizedToChatMessages([row]);
  return render(
    <UiPreferencesProvider>
      <MessageComponent message={message} prevMessage={null} createDiff={createDiff} provider="claude" />
    </UiPreferencesProvider>,
  );
};

const base = { sessionId: 'session-1', timestamp: '2026-10-29T10:00:00.000Z', provider: 'claude' as const };

describe('a row the server sent no words for', () => {
  it('keeps no English in the row itself', () => {
    const [error] = normalizedToChatMessages([{ ...base, id: 'e1', kind: 'error' }]);
    const [report] = normalizedToChatMessages([{ ...base, id: 't1', kind: 'task_notification', status: 'info' }]);
    const [xmlReport] = normalizedToChatMessages([{ ...base, id: 'x1', kind: 'text', role: 'user', content: '<task-notification><status>completed</status></task-notification>' }]);
    assert.deepEqual([error.content, report.content, xmlReport.content], ['', '', '']);
  });

  it('is worded in the interface language where it is drawn', async () => {
    await showLanguage('zh-CN');
    const error = renderRow({ ...base, id: 'e1', kind: 'error' });
    assert.equal(pageText().includes('未知错误'), true);
    error.unmount();

    const finished = renderRow({ ...base, id: 'x1', kind: 'text', role: 'user', content: '<task-notification><status>completed</status></task-notification>' });
    assert.equal(pageText().includes('后台任务已完成'), true);
    finished.unmount();

    const update = renderRow({ ...base, id: 't1', kind: 'task_notification', status: 'info' });
    assert.equal(pageText().includes('后台任务有更新'), true);
    update.unmount();
  });

  it('reads as before in English', () => {
    const error = renderRow({ ...base, id: 'e1', kind: 'error' });
    assert.equal(pageText().includes('Unknown error'), true);
    error.unmount();

    const finished = renderRow({ ...base, id: 'x1', kind: 'text', role: 'user', content: '<task-notification><status>completed</status></task-notification>' });
    assert.equal(pageText().includes('Background task finished'), true);
    finished.unmount();

    const update = renderRow({ ...base, id: 't1', kind: 'task_notification', status: 'info' });
    assert.equal(pageText().includes('Background task update'), true);
    update.unmount();
  });
});

const failed = (id: string, failureReason: string): ScheduledMessage => ({
  id,
  sessionId: 'session-1',
  content: `message ${id}`,
  options: {},
  scheduledFor: '2026-10-29T10:00:00.000Z',
  status: 'failed',
  failureReason,
  createdAt: '2026-10-29T09:00:00.000Z',
});

const FAILED = [
  failed('m1', 'hand_over_failed:stale-plan'),
  failed('m2', 'hand_over_failed:lookup'),
  failed('m3', 'The session was unavailable when this was due.'),
];

describe('a scheduled message that did not go', () => {
  it('says why in Chinese for the codes the server records, and shows any other reason as it is', async () => {
    await showLanguage('zh-CN');
    render(<ScheduledMessageList scheduledMessages={FAILED} onCancel={() => undefined} />);
    const text = pageText();
    assert.equal(text.includes('未发送 — 运行这个会话循环和定时的进程已不再按计划接收这条消息，换新进程会停掉它们。'), true);
    assert.equal(text.includes('未发送 — 无法把这条消息交给运行这个会话循环和定时的进程。'), true);
    assert.equal(text.includes('未发送 — The session was unavailable when this was due.'), true);
    assert.equal(text.includes('hand_over_failed'), false);
  });

  it('words the codes in English too', () => {
    render(<ScheduledMessageList scheduledMessages={FAILED} onCancel={() => undefined} />);
    const text = pageText();
    assert.equal(text.includes('Not sent — the process that runs this session\'s loops and reminders no longer takes this message as planned, and a new process would stop them.'), true);
    assert.equal(text.includes('Not sent — the message could not be handed to the process that runs this session\'s loops and reminders.'), true);
    assert.equal(text.includes('hand_over_failed'), false);
  });
});
