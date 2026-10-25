import assert from 'node:assert/strict';

import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type * as Api from '@/shared/api';
import type { Project, ProjectSession } from '@/shared/types';
import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

/**
 * The shell's bypass toggle used to be seeded from Claude's skip-permissions
 * setting while the launch flag was sent for every provider, so an Antigravity
 * shell (whose launch honours it) could start with
 * --dangerously-skip-permissions without a visible toggle. Now each CLI with a
 * toggle starts from its own setting.
 *
 * An agy shell also gets a model. Resuming a session, it is the model that
 * session recorded, the one the chat sends for it. It used to be the
 * provider-wide last pick, which may come from another session. A new agy
 * shell starts on that last pick.
 */

const runtimeOptions = vi.hoisted(() => [] as Array<{ bypassPermissions: boolean; model?: string | null }>);
// The session active-model request; each test decides what it answers.
const sessionActiveModel = vi.hoisted(() => vi.fn());

vi.mock('@/modules/shell/hooks/useShellRuntime', () => ({
  useShellRuntime: (options: { bypassPermissions: boolean; model?: string | null }) => {
    runtimeOptions.push(options);
    return {
      terminalContainerRef: { current: null },
      terminalRef: { current: null },
      wsRef: { current: null },
      isConnected: false,
      isInitialized: false,
      isConnecting: false,
      isClaudeThemeOutdated: false,
      connectToShell: () => undefined,
      disconnectFromShell: () => undefined,
    };
  },
}));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof Api>();
  return {
    ...actual,
    api: {
      ...actual.api,
      providers: { ...actual.api.providers, sessionActiveModel },
    },
  };
});

const { Shell } = await import('@/modules/shell');

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

const SESSION_ID = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';

const sessionOf = (provider: ProjectSession['__provider'], id = SESSION_ID): ProjectSession => ({
  id,
  __provider: provider,
});

/** The server's answer to the session active-model request. */
const activeModelAnswer = (
  sessionId: string,
  data: { model: string; source: 'session' | 'provider' | 'default' },
) => ({
  ok: true,
  json: async () => ({
    success: true,
    data: { provider: 'agy', sessionId, effort: null, ultracode: null, ...data },
  }),
}) as Response;

/** Lets a settled lookup reach the component. */
const flushLookups = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
  runtimeOptions.length = 0;
  // Pending unless a test answers it.
  sessionActiveModel.mockReset();
  sessionActiveModel.mockReturnValue(new Promise(() => {}));
  // Claude's chat setting has permission prompts skipped.
  writeUserPreference('claudePermissions', { allowedTools: [], disallowedTools: [], skipPermissions: true });
});

afterEach(() => {
  resetUserPreferences();
  localStorage.clear();
});

test('an Antigravity shell never launches with Claude\'s bypass setting', () => {
  render(<Shell selectedProject={PROJECT} selectedSession={sessionOf('agy')} />);

  assert.ok(runtimeOptions.length > 0);
  assert.equal(runtimeOptions.at(-1)?.bypassPermissions, false);
});

test('a Claude shell still launches with it', () => {
  render(<Shell selectedProject={PROJECT} selectedSession={sessionOf('claude')} />);

  assert.equal(runtimeOptions.at(-1)?.bypassPermissions, true);
});

test('an Antigravity shell starts from its own skip-permissions setting and shows the toggle', () => {
  writeUserPreference('agyPermissions', { allowedTools: [], disallowedTools: [], skipPermissions: true });
  const { getByRole } = render(<Shell selectedProject={PROJECT} selectedSession={sessionOf('agy')} />);

  assert.equal(runtimeOptions.at(-1)?.bypassPermissions, true);
  assert.ok(getByRole('button', { name: /bypass/i }));
});

test('an Antigravity shell resuming a session launches on the model that session recorded', async () => {
  // The provider-wide pick, made since in another agy session.
  localStorage.setItem('agy-model', 'gemini-3.8-flash-low');
  let answer: (response: Response) => void = () => undefined;
  sessionActiveModel.mockReturnValue(new Promise<Response>((resolve) => {
    answer = resolve;
  }));

  render(<Shell selectedProject={PROJECT} selectedSession={sessionOf('agy')} />);

  assert.deepEqual(sessionActiveModel.mock.calls[0], ['agy', SESSION_ID]);
  // Not known yet: no model, rather than the provider-wide pick.
  assert.equal(runtimeOptions.at(-1)?.model, null);

  await act(async () => {
    answer(activeModelAnswer(SESSION_ID, { model: 'opus-5.5-high', source: 'session' }));
  });
  await waitFor(() => assert.equal(runtimeOptions.at(-1)?.model, 'opus-5.5-high'));
  assert.ok(runtimeOptions.every((options) => options.model !== 'gemini-3.8-flash-low'));
});

test('a resumed Antigravity session with nothing recorded, or whose lookup fails, launches with no model', async () => {
  localStorage.setItem('agy-model', 'gemini-3.8-flash-low');
  // Nothing recorded: the answer is only the catalog default.
  sessionActiveModel.mockResolvedValue(activeModelAnswer(SESSION_ID, { model: 'auto', source: 'default' }));
  const nothingRecorded = render(<Shell selectedProject={PROJECT} selectedSession={sessionOf('agy')} />);
  await flushLookups();
  assert.equal(sessionActiveModel.mock.calls.length, 1);
  assert.ok(runtimeOptions.every((options) => options.model === null));
  nothingRecorded.unmount();

  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  sessionActiveModel.mockRejectedValue(new Error('Network error'));
  render(<Shell selectedProject={PROJECT} selectedSession={sessionOf('agy')} />);
  await flushLookups();
  assert.equal(sessionActiveModel.mock.calls.length, 2);
  assert.ok(runtimeOptions.every((options) => options.model === null));
});

test('a resumed Antigravity shell never carries one session\'s model over to another', async () => {
  const answers = new Map<string, (response: Response) => void>();
  sessionActiveModel.mockImplementation((_provider: string, sessionId: string) => (
    new Promise<Response>((resolve) => {
      answers.set(sessionId, resolve);
    })
  ));

  const view = render(<Shell selectedProject={PROJECT} selectedSession={sessionOf('agy', 'session-a')} />);
  await act(async () => {
    answers.get('session-a')?.(activeModelAnswer('session-a', { model: 'opus-5.5-high', source: 'session' }));
  });
  await waitFor(() => assert.equal(runtimeOptions.at(-1)?.model, 'opus-5.5-high'));

  view.rerender(<Shell selectedProject={PROJECT} selectedSession={sessionOf('agy', 'session-b')} />);
  assert.equal(runtimeOptions.at(-1)?.model, null);

  await act(async () => {
    answers.get('session-b')?.(activeModelAnswer('session-b', { model: 'gemini-flash-next', source: 'session' }));
  });
  await waitFor(() => assert.equal(runtimeOptions.at(-1)?.model, 'gemini-flash-next'));
});

test('a new Antigravity shell launches on the model the chat last picked for agy', () => {
  writeUserPreference('selectedProvider', 'agy');
  localStorage.setItem('agy-model', 'gemini-3.5-flash-lite');
  render(<Shell selectedProject={PROJECT} selectedSession={null} />);
  assert.equal(runtimeOptions.at(-1)?.model, 'gemini-3.5-flash-lite');

  localStorage.setItem('agy-model', 'default');
  render(<Shell selectedProject={PROJECT} selectedSession={null} />);
  assert.equal(runtimeOptions.at(-1)?.model, null);

  // With no session there is nothing recorded to ask for.
  assert.equal(sessionActiveModel.mock.calls.length, 0);
});

test('a Claude shell sends no model', () => {
  localStorage.setItem('claude-model', 'opus');
  render(<Shell selectedProject={PROJECT} selectedSession={sessionOf('claude')} />);

  assert.equal(runtimeOptions.at(-1)?.model, null);
  assert.equal(sessionActiveModel.mock.calls.length, 0);
});
