import assert from 'node:assert/strict';

import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, it } from 'vitest';

import { i18n } from '@/modules/i18n';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { NormalizedMessage } from '@/shared/types';

/**
 * A send that needs a new Claude process stops the background work the
 * session's process was held for, and the runtime says why in an `error` row
 * with code BACKGROUND_WORK_STOPPED and the server's labels for what needed
 * the new process. The transcript words it in the user's language, and keeps
 * the row's English text when it names nothing this client knows.
 */

const stopRow = (changes: string[] | undefined, content = 'Background work stopped: in English.'): NormalizedMessage => ({
  id: 'error-1',
  sessionId: 'session-1',
  timestamp: '2026-10-28T10:00:00.000Z',
  provider: 'claude',
  kind: 'error',
  content,
  code: 'BACKGROUND_WORK_STOPPED',
  changes,
});

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

describe('the notice that a send stopped the background work', () => {
  afterEach(async () => {
    await showLanguage('en');
  });

  it('names every change that needed a new process', () => {
    renderRow(stopRow(['model', 'effort', 'cwd']));

    const notice = 'Background work stopped: this message changes the model, the reasoning effort and the working directory, which only a new Claude process can apply.';
    assert.equal(screen.queryAllByText(notice).length, 1);
  });

  it('speaks the user\'s language', async () => {
    await showLanguage('zh-CN');
    renderRow(stopRow(['permissionMode', 'tools']));

    assert.equal(screen.queryAllByText('后台工作已停止：这条消息改了权限模式和工具权限，只有新的 Claude 进程才能生效。').length, 1);
  });

  it('says the project\'s mounted folders changed, not that the message changed them', async () => {
    const english = renderRow(stopRow(['directories']));
    assert.equal(screen.queryAllByText('Background work stopped: the project\'s mounted folders changed after the process started, and only a new Claude process can pick them up.').length, 1);
    assert.equal(screen.queryAllByText(/this message changes/).length, 0);
    english.unmount();

    // With a setting of the message besides, each is said as what it is.
    const both = renderRow(stopRow(['directories', 'model']));
    assert.equal(screen.queryAllByText('Background work stopped: the project\'s mounted folders changed and this message changes the model, which only a new Claude process can apply.').length, 1);
    both.unmount();

    await showLanguage('zh-CN');
    renderRow(stopRow(['directories']));
    assert.equal(screen.queryAllByText('后台工作已停止：项目挂载的文件夹在进程启动后变了，只有新的 Claude 进程才能用上。').length, 1);
    assert.equal(screen.queryAllByText(/这条消息改了/).length, 0);
  });

  it('says the message could not be handed over when the lookup failed', async () => {
    await showLanguage('zh-CN');
    renderRow(stopRow(['lookup']));

    assert.equal(screen.queryAllByText('后台工作已停止：无法把这条消息交给后台工作所在的进程。').length, 1);
  });

  it('keeps the row\'s own text when it names no change this client knows', async () => {
    await showLanguage('zh-CN');
    const unknownChange = renderRow(stopRow(['somethingNew'], 'Background work stopped: something new.'));
    assert.equal(screen.queryAllByText('Background work stopped: something new.').length, 1);
    unknownChange.unmount();

    renderRow(stopRow(undefined, 'Background work stopped: no changes listed.'));
    assert.equal(screen.queryAllByText('Background work stopped: no changes listed.').length, 1);
  });

  it('leaves any other error as the provider wrote it', () => {
    renderRow({ ...stopRow(['model']), code: undefined, content: 'Claude CLI exited with code 1' });

    assert.equal(screen.queryAllByText('Claude CLI exited with code 1').length, 1);
    assert.equal(screen.queryAllByText(/Background work stopped/).length, 0);
  });
});
