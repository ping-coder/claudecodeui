import assert from 'node:assert/strict';

import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { AuthProvider, useAuth } from '@/modules/auth/context/AuthContext';
import { i18n } from '@/modules/i18n';
import { AUTH_SESSION_EXPIRED_EVENT } from '@/shared/authToken';
import { WORKSPACE_LAYOUT_STORAGE_KEY } from '@/shared/constants';

/**
 * The split workspace's pane layout names the signed-in user's sessions and projects, in both
 * sessionStorage and localStorage. Signing out, or the session expiring, must remove both copies
 * so the next account on this device does not open onto the previous user's conversations.
 */

const makeToken = (issuedAtSeconds: number) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = { userId: 1, username: 'pane-user', iat: issuedAtSeconds, exp: issuedAtSeconds + 7 * 86400 };
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.sig${issuedAtSeconds}`;
};

const STORED_LAYOUT = JSON.stringify({ version: 1, left: { tabs: [], activeTabKey: null, mru: [] }, right: null, focusedSide: 'left', splitRatio: 0.5 });

let logout: (() => void) | null = null;

function Probe() {
  const { user, logout: authLogout } = useAuth();
  useEffect(() => {
    logout = authLogout;
  }, [authLogout]);
  return <div>{user ? 'signed in' : 'signed out'}</div>;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  logout = null;
  localStorage.setItem('auth-token', makeToken(Math.floor(Date.now() / 1000)));
  localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, STORED_LAYOUT);
  sessionStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, STORED_LAYOUT);
  sessionStorage.setItem('unrelated-key', 'kept');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = url === '/api/auth/status'
      ? { needsSetup: false }
      : url === '/api/auth/user'
        ? { user: { id: 1, username: 'pane-user' } }
        : url === '/api/user/onboarding-status'
          ? { hasCompletedOnboarding: true }
          : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
  vi.unstubAllGlobals();
});

test('signing out removes the pane layout from both stores', async () => {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await screen.findByText('signed in');
  assert.equal(sessionStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY), STORED_LAYOUT, 'signing in leaves the layout alone');

  await act(async () => {
    logout?.();
  });

  await screen.findByText('signed out');
  assert.equal(sessionStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY), null);
  assert.equal(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY), null);
  assert.equal(sessionStorage.getItem('unrelated-key'), 'kept');
});

test('an expired session removes it too', async () => {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await screen.findByText('signed in');

  await act(async () => {
    window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED_EVENT));
  });

  await screen.findByText('signed out');
  assert.equal(sessionStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY), null);
  assert.equal(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY), null);
});
