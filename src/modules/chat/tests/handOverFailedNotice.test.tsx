import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { afterEach, describe, it } from 'vitest';

import { i18n } from '@/modules/i18n';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { NormalizedMessage } from '@/shared/types';

/**
 * A queued or scheduled message that was to go into the process the session holds for its loops
 * (acceptProcessSettings) and did not is not sent, and the runtime says so in an `error` row with
 * code HAND_OVER_FAILED and a `reason`. The transcript words it by the code, in the interface
 * language; the row's English text is only the server's fallback.
 */

const failedRow = (reason: string | undefined): NormalizedMessage => ({
  id: 'error-1',
  sessionId: 'session-1',
  timestamp: '2026-10-29T10:00:00.000Z',
  provider: 'claude',
  kind: 'error',
  content: 'Not sent: the runtime\'s own English.',
  code: 'HAND_OVER_FAILED',
  ...(reason ? { reason } : {}),
} as NormalizedMessage);

const renderRow = (row: NormalizedMessage) => {
  const [message] = normalizedToChatMessages([row]);
  return render(
    <UiPreferencesProvider>
      <MessageComponent message={message} prevMessage={null} createDiff={() => []} provider="claude" />
    </UiPreferencesProvider>,
  );
};

const showLanguage = async (language: string) => {
  await act(async () => {
    await i18n.changeLanguage(language);
  });
};

/** The row's text, read as a string so a failing assertion never inspects a DOM node. */
const pageText = () => document.body.textContent ?? '';

describe('the notice that a message did not go into the held process', () => {
  afterEach(async () => {
    await showLanguage('en');
  });

  it('says why in English, by the reason', () => {
    const stale = renderRow(failedRow('stale-plan'));
    assert.equal(pageText().includes('Not sent: the process that runs this session\'s loops and reminders no longer takes this message as planned, and a new process would stop them.'), true);
    stale.unmount();

    const lookup = renderRow(failedRow('lookup'));
    assert.equal(pageText().includes('Not sent: the message could not be handed to the process that runs this session\'s loops and reminders.'), true);
    lookup.unmount();

    renderRow(failedRow('something-new'));
    assert.equal(pageText().includes('Not sent: the message could not go into the process that runs this session\'s loops and reminders, and a new process would stop them.'), true);
    assert.equal(pageText().includes('the runtime\'s own English'), false);
  });

  it('speaks Chinese', async () => {
    await showLanguage('zh-CN');
    const stale = renderRow(failedRow('stale-plan'));
    assert.equal(pageText().includes('没有发送：运行这个会话循环和定时的进程已不再按计划接收这条消息，换新进程会停掉它们。'), true);
    stale.unmount();

    const lookup = renderRow(failedRow('lookup'));
    assert.equal(pageText().includes('没有发送：无法把这条消息交给运行这个会话循环和定时的进程。'), true);
    lookup.unmount();

    renderRow(failedRow(undefined));
    assert.equal(pageText().includes('没有发送：这条消息进不了运行这个会话循环和定时的进程，换新进程会停掉它们。'), true);
    assert.equal(pageText().includes('Not sent'), false);
  });

  it('speaks Hebrew', async () => {
    await showLanguage('he');
    renderRow(failedRow('lookup'));
    assert.equal(pageText().includes('לא נשלחה: לא ניתן היה להעביר את ההודעה לתהליך שמריץ את הלולאות והתזכורות של הסשן.'), true);
    assert.equal(pageText().includes('Not sent'), false);
  });
});
