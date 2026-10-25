import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import '@/modules/i18n';
import AgentsSettingsTab from '@/modules/settings/tabs/agents-settings/AgentsSettingsTab';
import AgentSelectorSection from '@/modules/settings/tabs/agents-settings/sections/AgentSelectorSection';
import AccountContent from '@/modules/settings/tabs/agents-settings/sections/content/AccountContent';
import type { AgentContextByProvider, AgentProvider, ProviderAuthStatus } from '@/shared/types';

// Antigravity is signed into by running `agy` once in a terminal; CloudCLI
// cannot drive that login. Its account panel has to explain this instead of
// offering a Login button, and a CLI that is simply not installed is a state
// to explain, not an error to report in red.

const TERMINAL_HINT = 'provider-terminal-sign-in';

const agyStatus = (overrides: Partial<ProviderAuthStatus> = {}): ProviderAuthStatus => ({
  authenticated: false,
  email: null,
  method: null,
  error: null,
  loading: false,
  ...overrides,
});

describe('Antigravity account settings', () => {
  it('explains the terminal sign-in instead of offering a Login button', () => {
    render(<AccountContent agent="agy" authStatus={agyStatus({
      installed: true,
      error: 'Run `agy` once in a terminal to sign in',
    })} />);

    expect(screen.queryByRole('button', { name: /login/i })).toBeNull();
    const hint = screen.getByTestId(TERMINAL_HINT);
    expect(hint.textContent).toContain('Sign in from a terminal');
    expect(hint.textContent).toContain('Run agy once in a terminal on this machine to sign in.');
    expect(hint.querySelector('code')?.textContent).toBe('agy');
    // The hint already says what the server's message would; it is not an error.
    expect(screen.queryByText(/^Error:/)).toBeNull();
    expect(screen.getByText('Disconnected')).toBeTruthy();
  });

  it('reads a missing CLI as not installed, with an install hint and no error', () => {
    render(<AccountContent agent="agy" authStatus={agyStatus({
      installed: false,
      error: 'Antigravity CLI (agy) is not installed',
    })} />);

    expect(screen.getByText('Not installed')).toBeTruthy();
    expect(screen.getByText('The Antigravity CLI is not installed on this machine')).toBeTruthy();
    expect(screen.getByTestId(TERMINAL_HINT).textContent)
      .toContain('Install the Antigravity CLI on this machine, then run agy once in a terminal to sign in.');
    expect(screen.queryByText(/^Error:/)).toBeNull();
  });

  it('reads a token left behind without the CLI as not installed, not connected', () => {
    // agy's token outlives an uninstalled CLI, and the status reported it as
    // signed in while every turn failed as "not installed".
    render(<AccountContent agent="agy" authStatus={agyStatus({
      installed: false,
      authenticated: true,
      method: 'oauth',
      error: 'Antigravity CLI (agy) is not installed',
    })} />);

    expect(screen.getByText('Not installed')).toBeTruthy();
    expect(screen.getByText('The Antigravity CLI is not installed on this machine')).toBeTruthy();
    expect(screen.queryByText('Connected')).toBeNull();
    expect(screen.queryByText(/^Logged in as/)).toBeNull();
    expect(screen.getByTestId(TERMINAL_HINT).textContent)
      .toContain('Install the Antigravity CLI on this machine, then run agy once in a terminal to sign in.');
    expect(screen.queryByText(/^Error:/)).toBeNull();
  });

  it('gives the agent selector no connected dot for a token left behind without the CLI', () => {
    const signedIn = agyStatus({ installed: true, authenticated: true, method: 'oauth' });
    const contextWithAgy = (agy: ProviderAuthStatus): AgentContextByProvider => ({
      claude: { authStatus: signedIn },
      cursor: { authStatus: signedIn },
      codex: { authStatus: signedIn },
      opencode: { authStatus: signedIn },
      agy: { authStatus: agy },
    });
    const connectedDotOf = (agentName: string) => (
      screen.getByText(agentName).closest('button')?.querySelector('[data-testid="agent-connected-dot"]') ?? null
    );
    const renderSelector = (agy: ProviderAuthStatus) => render(
      <AgentSelectorSection
        agents={['claude', 'agy']}
        selectedAgent="claude"
        onSelectAgent={() => {}}
        agentContextById={contextWithAgy(agy)}
      />,
    );

    const tokenWithoutCli = renderSelector(agyStatus({
      installed: false,
      authenticated: true,
      method: 'oauth',
      error: 'Antigravity CLI (agy) is not installed',
    }));
    expect(connectedDotOf('Antigravity')).toBeNull();
    expect(connectedDotOf('Claude')).not.toBeNull();
    tokenWithoutCli.unmount();

    renderSelector(signedIn);
    expect(connectedDotOf('Antigravity')).not.toBeNull();
  });

  it('still reports a status check that failed', () => {
    // No `installed` field: the request itself failed, so nothing is known.
    render(<AccountContent agent="agy" authStatus={agyStatus({
      error: 'Failed to check authentication status',
    })} />);

    expect(screen.getByText('Error: Failed to check authentication status')).toBeTruthy();
  });

  it('shows the signed-in account without the hint', () => {
    render(<AccountContent agent="agy" authStatus={agyStatus({ installed: true, authenticated: true })} />);

    expect(screen.getByText('Logged in as authenticated user')).toBeTruthy();
    expect(screen.queryByTestId(TERMINAL_HINT)).toBeNull();
  });

  it('offers only the Account tab for Antigravity', () => {
    const signedOut = agyStatus({ installed: true });
    const providerAuthStatus: Record<AgentProvider, ProviderAuthStatus> = {
      claude: signedOut,
      cursor: signedOut,
      codex: signedOut,
      opencode: signedOut,
      agy: signedOut,
    };
    render(
      <AgentsSettingsTab
        providerAuthStatus={providerAuthStatus}
        onProviderLogin={() => {}}
        claudePermissions={{ allowedTools: [], disallowedTools: [], skipPermissions: false }}
        onClaudePermissionsChange={() => {}}
        cursorPermissions={{ allowedCommands: [], disallowedCommands: [], skipPermissions: false }}
        onCursorPermissionsChange={() => {}}
        codexPermissionMode="default"
        onCodexPermissionModeChange={() => {}}
        projects={[]}
      />,
    );
    expect(screen.getAllByRole('tab')).toHaveLength(4);

    fireEvent.click(screen.getByText('Antigravity'));

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Account']);
    expect(screen.getByTestId(TERMINAL_HINT)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /login/i })).toBeNull();
  });
});
