import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useProviderAuthStatus } from '@/modules/provider-auth/hooks/useProviderAuthStatus';

// The status map is keyed by every provider, but the list of providers the
// hook actually asks about is separate. A provider in the map and missing from
// that list stays "Checking..." forever in onboarding and settings.

const requestedProviders: string[] = [];
const responses: Record<string, () => Response> = {};

const jsonResponse = (status: number, body: unknown) => new Response(
  JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json' } },
);

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      authStatus: async (provider: string) => {
        requestedProviders.push(provider);
        return responses[provider]?.()
          ?? jsonResponse(200, { success: true, data: { installed: true, authenticated: false } });
      },
    },
  },
}));

describe('useProviderAuthStatus with Antigravity', () => {
  it('starts Antigravity out as checking, like every other provider', () => {
    const { result } = renderHook(() => useProviderAuthStatus());

    expect(result.current.providerAuthStatus.agy).toEqual({
      authenticated: false,
      email: null,
      method: null,
      error: null,
      loading: true,
    });
  });

  it('asks about Antigravity when every provider is refreshed', async () => {
    requestedProviders.length = 0;
    responses.agy = () => jsonResponse(200, {
      success: true,
      data: { installed: true, provider: 'agy', authenticated: true, email: null, method: 'oauth' },
    });

    const { result } = renderHook(() => useProviderAuthStatus());
    await act(async () => {
      await result.current.refreshProviderAuthStatuses();
    });

    expect(requestedProviders).toContain('agy');
    expect(result.current.providerAuthStatus.agy).toMatchObject({
      authenticated: true,
      loading: false,
      installed: true,
    });
  });

  it('keeps "not installed" apart from a status that could not be checked', async () => {
    responses.agy = () => jsonResponse(200, {
      success: true,
      data: {
        installed: false,
        provider: 'agy',
        authenticated: false,
        email: null,
        method: null,
        error: 'Antigravity CLI (agy) is not installed',
      },
    });

    const { result } = renderHook(() => useProviderAuthStatus({ initialLoading: false }));
    await act(async () => {
      await result.current.checkProviderAuthStatus('agy');
    });
    expect(result.current.providerAuthStatus.agy.installed).toBe(false);

    // A failed request knows nothing about the install, so the field stays out.
    responses.agy = () => jsonResponse(500, { success: false });
    await act(async () => {
      await result.current.checkProviderAuthStatus('agy');
    });
    expect('installed' in result.current.providerAuthStatus.agy).toBe(false);
    expect(result.current.providerAuthStatus.agy.error).toBe('Failed to check authentication status');
  });
});
