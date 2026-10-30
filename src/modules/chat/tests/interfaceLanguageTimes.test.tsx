import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { ScheduledMessageList } from '@/modules/chat/composer/ScheduledMessageList';
import { ScheduleMessagePopover } from '@/modules/chat/composer/ScheduleMessagePopover';
import { formatDateTime, formatTimeOfDay } from '@/modules/chat/utils/chatFormatting';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, ScheduledMessage } from '@/shared/types';

/**
 * Times in the chat follow the interface language, not the browser's: a
 * Chinese interface in an English browser reads 18:33:22, not 6:33:22 PM.
 * The expected strings come from Intl itself, so the test holds in any time
 * zone; the two languages are checked to differ, so a time that follows
 * neither (the browser's) fails one of them.
 */

const AT = '2026-10-29T10:33:22.000Z';

afterEach(async () => {
  vi.useRealTimers();
  await i18n.changeLanguage('en');
});

describe('the time formatting', () => {
  it('follows the language it is given, and the browser\'s without one', () => {
    assert.equal(formatTimeOfDay(AT, 'zh-CN'), new Date(AT).toLocaleTimeString('zh-CN'));
    assert.equal(formatTimeOfDay(AT, 'en'), new Date(AT).toLocaleTimeString('en'));
    assert.notEqual(formatTimeOfDay(AT, 'zh-CN'), formatTimeOfDay(AT, 'en'));
    assert.equal(formatTimeOfDay(AT, 'zh-CN', { hour: '2-digit', minute: '2-digit' }), new Date(AT).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
    assert.equal(formatTimeOfDay(AT, undefined), new Date(AT).toLocaleTimeString());
    assert.equal(formatDateTime(AT, 'zh-CN'), new Date(AT).toLocaleString('zh-CN'));
  });

  it('falls back to the browser\'s language for one Intl rejects', () => {
    assert.equal(formatTimeOfDay(AT, 'not a language!'), new Date(AT).toLocaleTimeString());
    assert.equal(formatDateTime(AT, 'not a language!'), new Date(AT).toLocaleString());
  });
});

const renderMessage = (message: ChatMessage) => render(
  <UiPreferencesProvider>
    <MessageComponent message={message} prevMessage={null} createDiff={() => []} provider="claude" />
  </UiPreferencesProvider>,
);

/** The texts of the row's <bdi> elements, where the message time is shown. */
const bdiTexts = () => [...document.querySelectorAll('bdi')].map((bdi) => bdi.textContent ?? '');

describe('a message\'s time', () => {
  const message: ChatMessage = { type: 'user', content: 'check the deploy', timestamp: AT };

  it('reads in Chinese in a Chinese interface', async () => {
    await i18n.changeLanguage('zh-CN');
    renderMessage(message);
    assert.equal(bdiTexts().includes(new Date(AT).toLocaleTimeString('zh-CN')), true);
  });

  it('reads in English in an English interface', () => {
    renderMessage(message);
    assert.equal(bdiTexts().includes(new Date(AT).toLocaleTimeString('en')), true);
  });

  it('follows a change of language', async () => {
    renderMessage(message);
    await i18n.changeLanguage('zh-CN');
    assert.equal(bdiTexts().includes(new Date(AT).toLocaleTimeString('zh-CN')), true);
  });
});

describe('a scheduled message\'s time', () => {
  // Before its time: a message past it reads as due and waiting.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.parse(AT) - 60 * 60_000));
  });

  const scheduled: ScheduledMessage = {
    id: 'scheduled-1',
    sessionId: 'session-1',
    content: 'Ship the release notes',
    options: {},
    scheduledFor: AT,
    status: 'pending',
    failureReason: null,
    createdAt: AT,
  };

  it('reads in Chinese, with no isolate around it, in a Chinese interface', async () => {
    await i18n.changeLanguage('zh-CN');
    render(<ScheduledMessageList scheduledMessages={[scheduled]} onCancel={() => {}} />);
    const text = document.body.textContent ?? '';
    assert.equal(text.includes(`将于 ${new Date(AT).toLocaleString('zh-CN')} 发送`), true);
    assert.equal(/[\u2066-\u2069]/.test(text), false);
  });

  it('reads in English in an English interface', () => {
    render(<ScheduledMessageList scheduledMessages={[scheduled]} onCancel={() => {}} />);
    assert.equal(document.body.textContent?.includes(`Scheduled for ${new Date(AT).toLocaleString('en')}`), true);
  });

  it('keeps its order inside a Hebrew sentence, and the message reads by its own first letter', async () => {
    await i18n.changeLanguage('he');
    render(<ScheduledMessageList scheduledMessages={[scheduled]} onCancel={() => {}} />);
    const text = document.body.textContent ?? '';
    assert.equal(text.includes(`\u2068${new Date(AT).toLocaleString('he')}\u2069`), true);
    assert.equal(screen.getByText('Ship the release notes').classList.contains('bidi-auto'), true);
  });
});

describe('the send-later menu\'s times', () => {
  const quickTimes = () => [...document.querySelectorAll('[role="menu"] bdi')].map((bdi) => bdi.textContent ?? '');
  const expected = (language: string) => [15, 60, 8 * 60].map((minutes) => (
    new Date(Date.now() + minutes * 60_000).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
  ));

  it('read in Chinese in a Chinese interface', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(AT));
    await i18n.changeLanguage('zh-CN');
    render(<ScheduleMessagePopover disabled={false} onSchedule={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '定时发送这条消息' }));
    const shown = quickTimes();
    assert.deepEqual(shown.slice(0, 3), expected('zh-CN'));
    assert.notDeepEqual(shown.slice(0, 3), expected('en'));
  });

  it('read in English in an English interface', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(AT));
    render(<ScheduleMessagePopover disabled={false} onSchedule={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Schedule this message' }));
    assert.deepEqual(quickTimes().slice(0, 3), expected('en'));
  });
});
