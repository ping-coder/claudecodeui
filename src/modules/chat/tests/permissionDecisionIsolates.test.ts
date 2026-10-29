import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';
import { resetUserPreferences } from '@/shared/userSettings';

/**
 * Denying a tool or asking for a revised plan sends interface text to the model.
 * In a right-to-left interface that text can carry bidi isolates (a fallback
 * string, a value); they must not reach the model.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };

beforeEach(() => {
  // The composer's slash-command hook fetches commands and skills on mount.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })));
  resetUserPreferences();
  localStorage.clear();
});

afterEach(() => {
  resetUserPreferences();
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('a permission answer reaches the server without bidi isolates', async () => {
  const sent: Array<{ type: string; message?: string }> = [];
  const view = renderHook(() =>
    useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION.id,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: false,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message) => {
        sent.push(message as { type: string; message?: string });
      },
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );

  await act(async () => {
    view.result.current.handlePermissionDecision('request-1', { allow: false, message: '\u2066The user denied this tool.\u2069' });
    view.result.current.handlePermissionDecision('request-2', { allow: true });
  });

  const answers = sent.filter((message) => message.type === 'chat.permission-response');
  assert.deepEqual(answers.map((answer) => answer.message), ['The user denied this tool.', undefined]);
});
