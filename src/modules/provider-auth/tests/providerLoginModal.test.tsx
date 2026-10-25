import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import '@/modules/i18n';
import ProviderLoginModal from '@/modules/provider-auth/ProviderLoginModal';

// The modal used to fall back to Claude's login command for any provider it
// did not know, so opening it for Antigravity would have run another CLI's
// login in the embedded shell. Antigravity is signed into from the user's own
// terminal, so the modal must not open a shell for it at all.

vi.mock('@/modules/standalone-shell', () => ({
  StandaloneShell: ({ command }: { command: string }) => <div data-testid="login-shell">{command}</div>,
}));

describe('ProviderLoginModal', () => {
  it('never opens a login shell for Antigravity, not even with a caller-supplied command', () => {
    const { rerender } = render(<ProviderLoginModal isOpen onClose={() => {}} provider="agy" />);
    expect(screen.queryByTestId('login-shell')).toBeNull();

    rerender(<ProviderLoginModal isOpen onClose={() => {}} provider="agy" customCommand="cursor-agent login" />);
    expect(screen.queryByTestId('login-shell')).toBeNull();
  });

  it('still runs the login of a provider that has one', () => {
    render(<ProviderLoginModal isOpen onClose={() => {}} provider="cursor" />);

    expect(screen.getByTestId('login-shell').textContent).toBe('cursor-agent login');
  });
});
