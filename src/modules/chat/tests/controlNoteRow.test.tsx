import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { afterEach, describe, it } from 'vitest';

import { i18n } from '@/modules/i18n';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, ControlNote } from '@/shared/types';

/**
 * A prompt CloudCLI sent the model on its own, such as the turn that has Claude stop loops, is
 * drawn as one short note in the interface language, with the jobs it names in its title. It
 * offers no edit or fork, and the reply after it starts a group of its own.
 */

const renderRow = (message: ChatMessage, prevMessage: ChatMessage | null = null) => render(
  <UiPreferencesProvider>
    <MessageComponent
      message={message}
      prevMessage={prevMessage}
      createDiff={() => []}
      provider="claude"
      onEditMessage={() => undefined}
      onForkFromMessage={() => undefined}
    />
  </UiPreferencesProvider>,
);

const noteRow = (controlNote: ControlNote, content = 'Asked Claude to stop 2 loops'): ChatMessage => ({
  type: 'assistant',
  content,
  timestamp: '2026-10-30T10:00:00.000Z',
  controlNote,
});

afterEach(async () => {
  await act(async () => { await i18n.changeLanguage('en'); });
});

describe('a control note row', () => {
  it('says how many loops Claude was asked to stop, names the jobs in its title, and offers no edit or fork', () => {
    const { container } = renderRow(noteRow({ kind: 'scheduled-stop', count: 2, jobIds: ['b2148320', '7b7cd8fc'] }));

    assert.equal(container.textContent?.includes('Asked Claude to stop 2 loops'), true);
    assert.equal(container.querySelector('[title]')?.getAttribute('title'), 'b2148320, 7b7cd8fc');
    assert.equal(container.querySelectorAll('button').length, 0);
  });

  it('reads in the interface language, and names the dynamic loop when that is all it stops', async () => {
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    const counted = renderRow(noteRow({ kind: 'scheduled-stop', count: 3, jobIds: ['b2148320', '7b7cd8fc'], wakeup: true }));
    assert.equal(counted.container.textContent?.includes('已让 Claude 停止 3 个循环'), true);
    counted.unmount();

    const wakeup = renderRow(noteRow({ kind: 'scheduled-stop', count: 1, jobIds: [], wakeup: true }, 'Asked Claude to stop the dynamic loop'));
    assert.equal(wakeup.container.textContent?.includes('已让 Claude 停止动态循环'), true);
    assert.equal(wakeup.container.querySelector('[title]') === null, true, 'no jobs, no title');
  });

  it('shows the English line the server sent for a kind this client does not know', () => {
    const { container } = renderRow(noteRow({ kind: 'loops-resume', count: 2 } as unknown as ControlNote, 'Resumed 2 loops'));
    assert.equal(container.textContent?.includes('Resumed 2 loops'), true);
  });

  it('lets the reply after it start a group of its own', () => {
    const reply: ChatMessage = { type: 'assistant', content: 'Both loops are stopped.', timestamp: '2026-10-30T10:00:05.000Z' };
    const afterNote = renderRow(reply, noteRow({ kind: 'scheduled-stop', count: 2, jobIds: ['b2148320', '7b7cd8fc'] }));
    assert.equal(afterNote.container.querySelector('.chat-message')?.classList.contains('grouped'), false);
    afterNote.unmount();

    const afterReply = renderRow(reply, { type: 'assistant', content: 'Working on it', timestamp: '2026-10-30T10:00:01.000Z' });
    assert.equal(afterReply.container.querySelector('.chat-message')?.classList.contains('grouped'), true);
  });
});
