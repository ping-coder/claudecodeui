import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { test } from 'vitest';

import { LLMProviderLogo } from '@/shared/ui';

/**
 * LLMProviderLogo draws the provider mark in every place a session, model
 * group or agent is shown, and it falls back to the Claude mark for anything
 * it does not recognise — so a provider missing from it is silently drawn as
 * Claude everywhere rather than failing to compile.
 */

test('an Antigravity provider is drawn with its own mark, not the Claude fallback', () => {
  render(<LLMProviderLogo provider="agy" className="h-4 w-4" />);

  const logo = screen.getByRole('img', { name: 'Antigravity' });
  assert.equal(logo.getAttribute('class'), 'h-4 w-4');
  assert.equal(screen.queryByRole('img', { name: 'Claude' }) === null, true);
});

test('an unrecognised provider still falls back to the Claude mark', () => {
  render(<LLMProviderLogo provider="not-a-provider" />);

  assert.ok(screen.getByRole('img', { name: 'Claude' }));
});
