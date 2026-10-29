import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { ChatMessage, PermissionMode, Project } from '@/shared/types';

/**
 * What the composer says on its own when a command does not go as asked (the question before a
 * command that runs bash, the note that it was cancelled, the error when it failed) is in the
 * interface language.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const ECHO_COMMAND = { name: '/echo', path: '/tmp/project-one/.claude/commands/echo.md', namespace: 'project', description: 'Repeat' };

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let executeResponse: () => Response;

const runEcho = async () => {
  const added: ChatMessage[] = [];
  const view = renderHook(() =>
    useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: { id: 'session-1' },
      currentSessionId: 'session-1',
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: false,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: () => undefined,
      onSessionEstablished: () => undefined,
      scrollToBottom: () => undefined,
      addMessage: (message) => { added.push(message as ChatMessage); },
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }));
  await waitFor(() => assert.equal(view.result.current.slashCommandsCount, 1));
  await act(async () => { view.result.current.setInput('/echo hi'); });
  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return added;
};

beforeEach(() => {
  executeResponse = () => jsonResponse({ type: 'custom', command: '/echo', content: 'echo hi', hasBashCommands: true });
  vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    if (target === '/api/commands/list' && init?.method === 'POST') {
      return Promise.resolve(jsonResponse({ builtIn: [], custom: [ECHO_COMMAND], count: 1 }));
    }
    if (target === '/api/commands/execute' && init?.method === 'POST') {
      return Promise.resolve(executeResponse());
    }
    if (target.startsWith('/api/providers/claude/skills')) {
      return Promise.resolve(jsonResponse({ success: true, data: { skills: [] } }));
    }
    return Promise.resolve(jsonResponse([]));
  }));
  localStorage.clear();
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  vi.unstubAllGlobals();
  localStorage.clear();
  await i18n.changeLanguage('en');
});

test('asks before a command that runs bash, and notes the cancel, in Chinese', async () => {
  await i18n.changeLanguage('zh-CN');
  const confirm = vi.fn((_message?: string) => false);
  vi.stubGlobal('confirm', confirm);
  const added = await runEcho();
  await waitFor(() => assert.equal(added.length, 1));
  assert.equal(confirm.mock.calls[0]?.[0], '这个命令里有会执行的 bash 命令，确定继续吗？');
  assert.equal(added[0].content, '已取消执行命令');
});

test('says a command failed in Chinese', async () => {
  await i18n.changeLanguage('zh-CN');
  executeResponse = () => new Response('oops', { status: 500 });
  const added = await runEcho();
  await waitFor(() => assert.equal(added.length, 1));
  assert.equal(added[0].content, '执行命令出错：命令执行失败（500）');
});

test('reads as before in English', async () => {
  executeResponse = () => new Response('oops', { status: 502 });
  const added = await runEcho();
  await waitFor(() => assert.equal(added.length, 1));
  assert.equal(added[0].content, 'Error executing command: Failed to execute command (502)');
});
