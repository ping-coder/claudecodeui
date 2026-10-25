import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';
import { resetUserPreferences } from '@/shared/userSettings';

/**
 * Ultracode is a switch beside the effort, and the composer only knows a value
 * for it when the current model can run it. A `chat.send` therefore carries
 * `ultracode` only as a real boolean; NULL (unsupported) and an omitted value
 * must leave the key out so the runtime never sees a switch it would drop.
 */

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

const SESSION: ProjectSession = { id: 'session-1' };

type SentMessage = {
  type: string;
  options?: Record<string, unknown>;
};

/** Sends one message through the real submit path and returns its `chat.send` options. */
const submit = async (currentProviderUltracode?: boolean | null) => {
  const sent: SentMessage[] = [];
  const view = renderHook(() =>
    useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION.id,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'opus',
      currentProviderEffort: 'low',
      ...(currentProviderUltracode === undefined ? {} : { currentProviderUltracode }),
      isLoading: false,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message) => {
        sent.push(message as SentMessage);
      },
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );

  await act(async () => {
    view.result.current.setInput('hello');
  });
  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });

  const send = sent.find((message) => message.type === 'chat.send');
  assert.ok(send, 'expected the composer to dispatch a chat.send');
  return send.options ?? {};
};

beforeEach(() => {
  // The composer's slash-command hook fetches commands and skills on mount.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })),
  );
  resetUserPreferences();
  localStorage.clear();
});

afterEach(() => {
  resetUserPreferences();
  vi.unstubAllGlobals();
  localStorage.clear();
});

test.each([true, false])('a send carries ultracode=%s beside the effort', async (ultracode) => {
  const options = await submit(ultracode);

  assert.equal(options.ultracode, ultracode);
  assert.equal(options.effort, 'low');
});

test.each([null, undefined])('a send leaves ultracode out when the switch is %s', async (ultracode) => {
  const options = await submit(ultracode);

  assert.equal('ultracode' in options, false);
  assert.equal(options.effort, 'low');
});
