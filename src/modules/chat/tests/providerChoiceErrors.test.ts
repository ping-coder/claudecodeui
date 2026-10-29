import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { resetUserPreferences } from '@/shared/userSettings';
import type { ProjectSession } from '@/shared/types';

/**
 * A model, effort or ultracode choice the server refuses for the open session fails with an error
 * the model picker shows as it is (CommandResultModal's notice), so its words are in the
 * interface language rather than always English.
 */

const { refused, okJson } = vi.hoisted(() => ({
  refused: () => Promise.resolve({ ok: false, json: async () => ({ success: false }) }),
  okJson: (data: unknown) => Promise.resolve({ ok: true, json: async () => data }),
}));

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: () => okJson({ success: true, data: null }),
      capabilities: () => okJson({ success: true, data: null }),
      sessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveModel: refused,
      setSessionActiveEffort: refused,
      setSessionActiveUltracode: refused,
    },
  },
}));

const SESSION: ProjectSession = { id: 'session-1', __provider: 'claude' };

/** The message of the error a promise rejects with, as a string. */
const rejection = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const renderProviderState = async () => {
  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  const view = renderHook(() => useChatProviderState({ selectedSession: SESSION, selectedProject: null }));
  await waitFor(() => assert.equal(view.result.current.providerModelsLoading, false));
  return view;
};

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
});

afterEach(async () => {
  await act(async () => {
    await i18n.changeLanguage('en');
  });
});

test('a refused session choice says so in Chinese', async () => {
  await act(async () => {
    await i18n.changeLanguage('zh-CN');
  });
  const { result } = await renderProviderState();

  let messages: string[] = [];
  await act(async () => {
    messages = [
      await rejection(result.current.selectProviderModel('claude', 'opus', 'session-1')),
      await rejection(result.current.selectProviderEffort('claude', 'high', 'session-1')),
      await rejection(result.current.selectProviderUltracode('claude', true, 'session-1')),
    ];
  });
  assert.deepEqual(messages, ['无法切换这个会话的模型。', '无法切换这个会话的推理级别。', '无法切换这个会话的 Ultracode。']);
});

test('in English it reads as before', async () => {
  const { result } = await renderProviderState();

  let messages: string[] = [];
  await act(async () => {
    messages = [
      await rejection(result.current.selectProviderModel('claude', 'opus', 'session-1')),
      await rejection(result.current.selectProviderEffort('claude', 'high', 'session-1')),
      await rejection(result.current.selectProviderUltracode('claude', true, 'session-1')),
    ];
  });
  assert.deepEqual(messages, [
    'Unable to change the active model for this session.',
    'Unable to change the reasoning effort for this session.',
    'Unable to change ultracode for this session.',
  ]);
});
