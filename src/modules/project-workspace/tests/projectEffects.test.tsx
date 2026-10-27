import assert from 'node:assert/strict';

import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession, SessionOpenOptions } from '@/shared/types';

/**
 * The page-wide effects the workspace runs once: the browser tab title follows the focused pane, and
 * a notification click opens its session kept, on the Chat view, in the focused pane. The route mounts
 * one ChatInstancesProvider, so every chat on the page shares one realtime coordinator.
 */

type EffectsState = {
  openSettings: (tab?: string) => void;
  refreshProjectsSilently: () => Promise<void>;
  setSidebarOpen: (open: boolean) => void;
  openSessionById: (sessionId: string, options?: SessionOpenOptions) => void;
  focusedProject: Project | null;
  focusedSession: ProjectSession | null;
};

const effects: { state: EffectsState | null } = { state: null };
const registeredPaletteOps: Array<Record<string, unknown>> = [];

vi.mock('@/modules/project-workspace/context/ProjectsStateContext', () => ({
  useProjectEffectsState: () => effects.state,
  ProjectsStateProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/modules/command-palette', () => ({
  usePaletteOpsRegister: (ops: Record<string, unknown>) => {
    registeredPaletteOps.push(ops);
  },
  PaletteOpsProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/modules/chat', () => ({
  ChatInstancesProvider: ({ children }: { children: ReactNode }) => <div data-testid="chat-instances">{children}</div>,
}));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  SessionProtectionProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useSessionProtectionActions: () => ({ isSessionProcessing: () => false }),
}));
vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ ws: null, sendMessage: () => undefined, subscribe: () => () => undefined }),
}));
vi.mock('@/shared/hooks/useDeviceSettings', () => ({ useDeviceSettings: () => ({ isMobile: false }) }));
vi.mock('@/modules/project-workspace/ProjectWorkspaceShell', () => ({ default: () => <div data-testid="workspace-shell" /> }));

const { default: ProjectEffects } = await import('@/modules/project-workspace/controllers/ProjectEffects');
const { default: ProjectWorkspaceRoute } = await import('@/modules/project-workspace/ProjectWorkspaceRoute');

const ALPHA: Project = { projectId: 'alpha', displayName: 'Alpha', fullPath: '/repo/alpha', path: '/repo/alpha', sessions: [] };

// jsdom has no service worker container; this one stays for the file (the effect cleans up against it on unmount).
const serviceWorker = new EventTarget();
Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker });

const makeState = (overrides: Partial<EffectsState> = {}): EffectsState => ({
  openSettings: vi.fn(),
  refreshProjectsSilently: vi.fn(async () => undefined),
  setSidebarOpen: vi.fn(),
  openSessionById: vi.fn(),
  focusedProject: ALPHA,
  focusedSession: null,
  ...overrides,
});

beforeEach(() => {
  registeredPaletteOps.length = 0;
});

test('the browser tab title follows the focused pane: its session, else its project', () => {
  effects.state = makeState({ focusedSession: { id: 's1', summary: 'Fix the login bug', __provider: 'claude' } });
  const view = render(<ProjectEffects />);
  assert.equal(document.title, 'Fix the login bug');

  effects.state = makeState({ focusedSession: { id: 's2', summary: 'Other pane chat', __provider: 'claude' } });
  view.rerender(<ProjectEffects />);
  assert.equal(document.title, 'Other pane chat');

  effects.state = makeState({ focusedSession: null });
  view.rerender(<ProjectEffects />);
  assert.equal(document.title, 'Alpha - CloudCLI UI');
});

test('a notification click opens its session kept, on the Chat view, and closes the drawer', () => {
  const state = makeState();
  effects.state = state;
  render(<ProjectEffects />);

  act(() => {
    serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'notification:navigate', sessionId: 'notified-1' } }));
  });

  assert.deepEqual(vi.mocked(state.openSessionById).mock.calls, [['notified-1', { preview: false, view: 'chat' }]]);
  assert.deepEqual(vi.mocked(state.setSidebarOpen).mock.calls, [[false]]);
  assert.equal(vi.mocked(state.refreshProjectsSilently).mock.calls.length, 1);

  // Other messages, and a notification without a session, open nothing.
  act(() => {
    serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'something-else', sessionId: 'x' } }));
    serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'notification:navigate' } }));
  });
  assert.equal(vi.mocked(state.openSessionById).mock.calls.length, 1);
});

test('the palette gets the page-wide operations from here', () => {
  const state = makeState();
  effects.state = state;
  render(<ProjectEffects />);

  const ops = registeredPaletteOps.at(-1) ?? {};
  assert.equal(ops.openSettings, state.openSettings);
  assert.equal(ops.refreshProjects, state.refreshProjectsSilently);
});

test('the route mounts one realtime coordinator around the whole workspace', () => {
  render(
    <MemoryRouter initialEntries={['/session/s1']}>
      <ProjectWorkspaceRoute />
    </MemoryRouter>,
  );

  const coordinators = screen.getAllByTestId('chat-instances');
  assert.equal(coordinators.length, 1);
  assert.equal(coordinators[0].contains(screen.getByTestId('workspace-shell')), true);
});
