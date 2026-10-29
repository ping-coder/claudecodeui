import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import type { Project, ProjectSession } from '@/shared/types';

/**
 * The terminal names its session in the header and in the "Resume session" line as the workspace
 * hands it over (sidebar's formatSessionTitle: the server's placeholder names in the interface
 * language). Without that, a session with no title takes getSessionTitle's placeholder, now in the
 * interface language too ("New Session" was English everywhere).
 */

vi.mock('@/modules/shell/hooks/useShellRuntime', () => ({
  // Ready to connect, not connected: the overlay offers to resume the session.
  useShellRuntime: () => ({
    terminalContainerRef: { current: null },
    terminalRef: { current: null },
    wsRef: { current: null },
    isConnected: false,
    isInitialized: true,
    isConnecting: false,
    isClaudeThemeOutdated: false,
    connectToShell: () => undefined,
    disconnectFromShell: () => undefined,
  }),
}));

const { Shell } = await import('@/modules/shell');
const { StandaloneShell } = await import('@/modules/standalone-shell');

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };

const session = (summary?: string): ProjectSession => ({
  id: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b',
  __provider: 'claude',
  ...(summary ? { summary } : {}),
});

/** The page's text without the isolates a right-to-left value carries, read as a string. */
const pageText = () => (document.body.textContent ?? '').replace(/[\u2066-\u2069]/g, '');

afterEach(async () => {
  await act(async () => {
    await i18n.changeLanguage('en');
  });
});

test('the header and the resume line name the session as the workspace hands it over', () => {
  render(<Shell selectedProject={PROJECT} selectedSession={session('Untitled Claude Session')} sessionTitle="Untitled Claude Session, named" />);
  assert.equal(pageText().includes('(Untitled Claude Session, named...)'), true);
  assert.equal(pageText().includes('Resume session: Untitled Claude Session, named...'), true);
});

test('the workspace\'s terminal hands the name over to the shell', () => {
  render(<StandaloneShell project={PROJECT} session={session('Untitled Claude Session')} sessionTitle="未命名的 Claude 会话" showHeader={false} />);
  assert.equal(pageText().includes('(未命名的 Claude 会话...)'), true);
});

test('a session with no title is named in the interface language', async () => {
  await act(async () => {
    await i18n.changeLanguage('zh-CN');
  });
  render(<Shell selectedProject={PROJECT} selectedSession={session()} />);
  assert.equal(pageText().includes('(新会话...)'), true);
  assert.equal(pageText().includes('恢复会话：新会话…'), true);
  assert.equal(pageText().includes('New Session'), false);
});
