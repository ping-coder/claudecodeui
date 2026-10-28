import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

/**
 * Whether a message sent while a turn runs may go into that turn comes from
 * the capability matrix's `supportsMidRunInsert`. Before the matrix loads, a
 * static fallback says Claude can, so Enter does not change meaning mid-load.
 * A matrix without the flag comes from a server that cannot take `chat.insert`
 * at all, so there the answer is no.
 */

type CapabilityRow = { provider: string; supportsMidRunInsert?: boolean };

let capabilityRows: CapabilityRow[] = [];
let capabilitiesGate: Promise<void> = Promise.resolve();

const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });

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
                supportsImages: true,
                supportsFiles: true,
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

test('before the matrix loads, only Claude takes inserts', () => {
  capabilitiesGate = new Promise(() => {});

  const claude = renderProviderState('claude');
  assert.equal(claude.result.current.supportsMidRunInsert, true);
  claude.unmount();

  const codex = renderProviderState('codex');
  assert.equal(codex.result.current.provider, 'codex');
  assert.equal(codex.result.current.supportsMidRunInsert, false);
});

test('the loaded matrix decides, and a matrix without the flag means no', async () => {
  // Made-up rows against the fallback, so each answer can only come from the matrix.
  capabilityRows = [
    { provider: 'claude' },
    { provider: 'codex', supportsMidRunInsert: true },
  ];

  const claude = renderProviderState('claude');
  await waitFor(() => assert.equal(claude.result.current.supportsMidRunInsert, false));
  claude.unmount();

  const codex = renderProviderState('codex');
  await waitFor(() => assert.equal(codex.result.current.supportsMidRunInsert, true));
});
