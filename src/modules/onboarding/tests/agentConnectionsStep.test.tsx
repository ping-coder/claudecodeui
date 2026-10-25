import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import '@/modules/i18n';
import AgentConnectionsStep from '@/modules/onboarding/AgentConnectionsStep';
import type { ProviderAuthStatus, ProviderAuthStatusMap } from '@/shared/types';

// Antigravity has no login flow CloudCLI can drive: the user signs in by
// running `agy` once in their own terminal. Its onboarding card must say so
// instead of offering a Login button that would open somebody else's login.

const signedOut = (overrides: Partial<ProviderAuthStatus> = {}): ProviderAuthStatus => ({
  authenticated: false,
  email: null,
  method: null,
  error: 'Not authenticated',
  loading: false,
  installed: true,
  ...overrides,
});

const statusesWithAgy = (agy: ProviderAuthStatus): ProviderAuthStatusMap => ({
  claude: signedOut(),
  cursor: signedOut(),
  codex: signedOut(),
  opencode: signedOut(),
  agy,
});

describe('AgentConnectionsStep with Antigravity', () => {
  it('shows a terminal sign-in hint for Antigravity instead of a Login button', () => {
    const onOpenProviderLogin = vi.fn();
    render(
      <AgentConnectionsStep
        providerStatuses={statusesWithAgy(signedOut({ error: 'Run `agy` once in a terminal to sign in' }))}
        onOpenProviderLogin={onOpenProviderLogin}
      />,
    );

    // One Login button for each of the four other providers, none for Antigravity.
    const loginButtons = screen.getAllByRole('button', { name: 'Login' });
    expect(loginButtons).toHaveLength(4);
    loginButtons.forEach((button) => fireEvent.click(button));
    expect(onOpenProviderLogin.mock.calls.map(([provider]) => provider)).not.toContain('agy');

    const hint = screen.getByTestId('terminal-sign-in-hint');
    expect(hint.textContent).toBe('Run agy once in a terminal to sign in.');
    expect(hint.querySelector('code')?.textContent).toBe('agy');
  });

  it('reads a missing CLI as "Not installed" with an install hint, not as an error', () => {
    render(
      <AgentConnectionsStep
        providerStatuses={statusesWithAgy(signedOut({
          installed: false,
          error: 'Antigravity CLI (agy) is not installed',
        }))}
        onOpenProviderLogin={() => {}}
      />,
    );

    expect(screen.getByText('Not installed')).toBeTruthy();
    expect(screen.queryByText('Antigravity CLI (agy) is not installed')).toBeNull();
    expect(screen.getByTestId('terminal-sign-in-hint').textContent)
      .toBe('Install the Antigravity CLI, then run agy once in a terminal to sign in.');
  });

  it('reads a token left behind without the CLI as "Not installed", with the install hint and no check', () => {
    // agy's token outlives an uninstalled CLI, and the status reported it as
    // signed in while every turn failed as "not installed".
    render(
      <AgentConnectionsStep
        providerStatuses={statusesWithAgy(signedOut({
          installed: false,
          authenticated: true,
          method: 'oauth',
          error: 'Antigravity CLI (agy) is not installed',
        }))}
        onOpenProviderLogin={() => {}}
      />,
    );

    expect(screen.getByText('Not installed')).toBeTruthy();
    expect(screen.queryByText('Connected')).toBeNull();
    expect(screen.getByTestId('terminal-sign-in-hint').textContent)
      .toBe('Install the Antigravity CLI, then run agy once in a terminal to sign in.');
    const card = screen.getByText('Antigravity').closest('.rounded-xl');
    expect(card?.querySelector('.lucide-check')).toBeNull();
    expect(card?.className).not.toContain('bg-cyan-50');
  });

  it('shows the account once Antigravity is signed in, with no hint', () => {
    render(
      <AgentConnectionsStep
        providerStatuses={statusesWithAgy(signedOut({ authenticated: true, error: null }))}
        onOpenProviderLogin={() => {}}
      />,
    );

    expect(screen.queryByTestId('terminal-sign-in-hint')).toBeNull();
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByText('Antigravity').closest('.rounded-xl')?.querySelector('.lucide-check')).not.toBeNull();
  });
});
