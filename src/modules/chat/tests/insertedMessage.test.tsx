import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { describe, it } from 'vitest';

import '@/modules/i18n';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, NormalizedMessage } from '@/shared/types';

/**
 * A message the model read in the middle of a turn is recorded as an
 * attachment row, which no conversation can resume from. Its bubble says it
 * was inserted and offers no edit and no fork, even if an anchor came along.
 */

const renderBubble = (message: ChatMessage) => render(
  <UiPreferencesProvider>
    <MessageComponent
      message={message}
      prevMessage={null}
      createDiff={() => []}
      provider="claude"
      onEditMessage={() => undefined}
      onForkFromMessage={() => undefined}
    />
  </UiPreferencesProvider>,
);

const userMessage = (overrides: Partial<ChatMessage>): ChatMessage => ({
  type: 'user',
  content: 'also check the docs',
  timestamp: '2026-10-28T10:00:00.000Z',
  ...overrides,
});

describe('an inserted user message', () => {
  it('is labelled as inserted and offers neither edit nor fork', () => {
    renderBubble(userMessage({ inserted: true, transcriptAnchorId: 'insert-1' }));

    assert.equal(screen.queryAllByText('Inserted').length, 1);
    assert.equal(screen.queryAllByRole('button', { name: 'Edit and resend' }).length, 0);
    assert.equal(screen.queryAllByRole('button', { name: 'Fork from here' }).length, 0);
  });

  it('differs from an ordinary one, which keeps both and has no label', () => {
    renderBubble(userMessage({ transcriptAnchorId: 'turn-1' }));

    assert.equal(screen.queryAllByText('Inserted').length, 0);
    assert.equal(screen.queryAllByRole('button', { name: 'Edit and resend' }).length, 1);
    assert.equal(screen.queryAllByRole('button', { name: 'Fork from here' }).length, 1);
  });

  it('keeps its inserted flag from the store row it is drawn from', () => {
    const row: NormalizedMessage = {
      id: 'insert-1',
      sessionId: 'session-1',
      timestamp: '2026-10-28T10:00:00.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'user',
      content: 'also check the docs',
      inserted: true,
    };

    const [bubble] = normalizedToChatMessages([row]);
    assert.equal(bubble?.inserted, true);

    const [ordinary] = normalizedToChatMessages([{ ...row, id: 'turn-1', inserted: undefined }]);
    assert.equal(ordinary?.inserted, undefined);
  });
});
