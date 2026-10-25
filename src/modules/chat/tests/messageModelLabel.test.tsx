import assert from 'node:assert/strict';

import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, test } from 'vitest';

import '@/modules/i18n';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { formatAnsweringModelLabel } from '@/modules/chat/utils/modelLabel';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, NormalizedMessage } from '@/shared/types';

// The model ids that actually appear on assistant rows in real Claude Code
// transcripts, taken from a ~86k-row sample of this machine's `~/.claude`.
describe('the label a reported model is shortened to', () => {
  it('names the family and version of an undated id', () => {
    expect(formatAnsweringModelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(formatAnsweringModelLabel('claude-fable-5-1')).toBe('Fable 5.1');
    expect(formatAnsweringModelLabel('claude-mythos-5-1')).toBe('Mythos 5.1');
    expect(formatAnsweringModelLabel('claude-opus-5')).toBe('Opus 5');
    expect(formatAnsweringModelLabel('claude-sonnet-5')).toBe('Sonnet 5');
  });

  it('drops the release date from a dated id', () => {
    expect(formatAnsweringModelLabel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(formatAnsweringModelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(formatAnsweringModelLabel('claude-haiku-4-5@20251001')).toBe('Haiku 4.5');
    expect(formatAnsweringModelLabel('claude-opus-4-20250514')).toBe('Opus 4');
    expect(formatAnsweringModelLabel('claude-opus-4-1@20250805')).toBe('Opus 4.1');
  });

  it('reads the version of an id written in the older version-first order', () => {
    expect(formatAnsweringModelLabel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5');
    expect(formatAnsweringModelLabel('claude-3-opus-20240229')).toBe('Opus 3');
    expect(formatAnsweringModelLabel('anthropic.claude-3-5-sonnet-20240620-v1:0')).toBe('Sonnet 3.5');
  });

  it('ignores a cloud or gateway prefix and suffix around the id', () => {
    expect(formatAnsweringModelLabel('us.anthropic.claude-opus-5-5-v1:0')).toBe('Opus 5.5');
    expect(formatAnsweringModelLabel('anthropic/claude-sonnet-5')).toBe('Sonnet 5');
    expect(formatAnsweringModelLabel('anthropic/claude-opus-4.5')).toBe('Opus 4.5');
  });

  it('names only the family for a bare alias', () => {
    expect(formatAnsweringModelLabel('opus')).toBe('Opus');
    expect(formatAnsweringModelLabel('Sonnet')).toBe('Sonnet');
  });

  it('keeps a 1M-context id distinct from the base model if one is ever reported', () => {
    // Claude Code writes the base id on assistant rows today, so this guards
    // the mapping rather than describing current transcripts: the same family
    // at a different context window and price must not read as the base.
    expect(formatAnsweringModelLabel('claude-opus-5[1m]')).toBe('Opus 5 1M');
    expect(formatAnsweringModelLabel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5 1M');
    expect(formatAnsweringModelLabel('sonnet[1m]')).toBe('Sonnet 1M');
    expect(formatAnsweringModelLabel('claude-opus-5')).toBe('Opus 5');
  });

  it('shows an unrecognized id verbatim rather than dropping it', () => {
    expect(formatAnsweringModelLabel('grok-4.6')).toBe('grok-4.6');
  });

  it('has nothing to show when the provider reported no model', () => {
    expect(formatAnsweringModelLabel(undefined)).toBeNull();
    expect(formatAnsweringModelLabel('   ')).toBeNull();
  });
});

const normalized = (overrides: Partial<NormalizedMessage>): NormalizedMessage => ({
  id: 'row-1',
  sessionId: 'session-1',
  timestamp: '2026-08-19T12:00:00.000Z',
  provider: 'claude',
  kind: 'text',
  role: 'assistant',
  content: 'Here is the plan.',
  ...overrides,
});

test('the model the backend reported survives the conversion into a rendered message', () => {
  const [reply] = normalizedToChatMessages([normalized({ model: 'claude-opus-5' })]);
  assert.equal(reply?.model, 'claude-opus-5');

  // A reply the provider named no model for must not inherit one.
  const [unlabelled] = normalizedToChatMessages([normalized({ id: 'row-2', model: undefined })]);
  assert.equal(unlabelled?.model, undefined);
});

const renderMessage = (message: ChatMessage) =>
  render(
    <UiPreferencesProvider>
      <MessageComponent message={message} prevMessage={null} createDiff={() => []} provider="claude" />
    </UiPreferencesProvider>,
  );

describe('the model label in the message footer', () => {
  it('names the model that answered, beside the copy control', () => {
    const { container } = renderMessage({
      type: 'assistant',
      content: 'Here is the plan.',
      timestamp: '2026-08-19T12:00:00.000Z',
      model: 'claude-opus-5',
    });

    const label = container.querySelector('[title="Answered by claude-opus-5"]');
    assert.ok(label, 'the footer must carry the model the provider reported');
    assert.equal(label?.textContent, 'Opus 5');
  });

  it('shows nothing for a reply the provider reported no model for', () => {
    // A row Claude Code fabricated locally — the usage-limit notice — reaches
    // the client with no model, and a guessed label would claim a request that
    // never ran.
    const { container } = renderMessage({
      type: 'assistant',
      content: 'Claude usage limit reached.',
      timestamp: '2026-08-19T12:00:00.000Z',
    });

    assert.equal(container.querySelector('[title^="Answered by"]'), null);
  });

  it('leaves the user turn unlabelled', () => {
    const { container } = renderMessage({
      type: 'user',
      content: 'Plan the refactor.',
      timestamp: '2026-08-19T12:00:00.000Z',
    });

    assert.equal(container.querySelector('[title^="Answered by"]'), null);
  });
});
