import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

/**
 * The capability matrix has always carried `supportsImages` and
 * `supportsFiles`, but nothing read them: the composer offered attachments for
 * every provider. Antigravity's runtime rejects attachments, so the provider
 * state now reports both flags, from the matrix once it loads and from a
 * fallback before that.
 */

const okJson = (data: unknown) => Promise.resolve({
  ok: true,
  json: async () => data,
});

type CapabilityRow = {
  provider: string;
  supportsImages: boolean;
  supportsFiles: boolean;
};

// What the capabilities request answers, and a gate that holds it back so a
// test can look at the state before the matrix has loaded.
let capabilityRows: CapabilityRow[] = [];
let capabilitiesGate: Promise<void> = Promise.resolve();

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: () => okJson({ success: true, data: null }),
      capabilities: async () => {
        await capabilitiesGate;
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: {
              providers: capabilityRows.map((row) => ({
                permissionModes: ['default'],
                defaultPermissionMode: 'default',
                supportsAbort: true,
                supportsPermissionRequests: false,
                supportsTokenUsage: false,
                ...row,
              })),
            },
          }),
        };
      },
      sessionActiveModel: () => okJson({ success: true, data: null }),
    },
  },
}));

const renderProviderState = (provider: string) => {
  // Read once, by the hook's initial provider state.
  writeUserPreference('selectedProvider', provider);
  return renderHook(() => useChatProviderState({ selectedSession: null, selectedProject: null }));
};

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
  capabilityRows = [];
  capabilitiesGate = Promise.resolve();
});

afterEach(() => {
  resetUserPreferences();
});

test('Antigravity takes no attachments even before the capability matrix loads', async () => {
  capabilitiesGate = new Promise(() => {});

  const agy = renderProviderState('agy');
  assert.equal(agy.result.current.provider, 'agy');
  assert.equal(agy.result.current.supportsImageAttachments, false);
  assert.equal(agy.result.current.supportsFileAttachments, false);
  agy.unmount();

  // Every other provider keeps its attachment controls during that window.
  const claude = renderProviderState('claude');
  assert.equal(claude.result.current.supportsImageAttachments, true);
  assert.equal(claude.result.current.supportsFileAttachments, true);
});

test('the loaded capability matrix decides, not the provider id', async () => {
  // Made-up rows that contradict both fallbacks, so each flag can only have
  // come from the matrix: Claude without images, Antigravity with files.
  capabilityRows = [
    { provider: 'claude', supportsImages: false, supportsFiles: true },
    { provider: 'agy', supportsImages: false, supportsFiles: true },
  ];

  const claude = renderProviderState('claude');
  await waitFor(() => assert.equal(claude.result.current.supportsImageAttachments, false));
  assert.equal(claude.result.current.supportsFileAttachments, true);
  claude.unmount();

  const agy = renderProviderState('agy');
  assert.equal(agy.result.current.provider, 'agy');
  await waitFor(() => assert.equal(agy.result.current.supportsFileAttachments, true));
  assert.equal(agy.result.current.supportsImageAttachments, false);
});
