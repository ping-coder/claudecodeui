import assert from 'node:assert/strict';

import { act, cleanup, render, screen } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import type * as ProjectsStateContextModule from '@/modules/project-workspace/context/ProjectsStateContext';
import { createInitialLayout } from '@/modules/project-workspace/utils/workspaceLayout';
import type {
  Project,
  ProjectSession,
  SessionActivity,
  SessionActivityMap,
  SessionOpenOptions,
  WorkspaceLayout,
  WorkspaceSessionTab,
} from '@/shared/types';

/**
 * The page-wide effects the workspace runs once: the browser tab title follows the focused pane (by
 * the session's live title, else its tab's snapshot), names the latest running session while one
 * runs, a focused one by the same text, and goes back to the app name when the workspace unmounts;
 * a notification click opens its session kept, on the Chat view, in the focused pane. The provider
 * hands these effects the current projects and layout. The route mounts one ChatInstancesProvider,
 * so every chat on the page shares one realtime coordinator.
 */

type EffectsState = {
  openSettings: (tab?: string) => void;
  refreshProjectsSilently: () => Promise<void>;
  setSidebarOpen: (open: boolean) => void;
  openSessionById: (sessionId: string, options?: SessionOpenOptions) => void;
  focusedProject: Project | null;
  focusedSession: ProjectSession | null;
  projects: Project[];
  layout: WorkspaceLayout;
};

const effects: { state: EffectsState | null } = { state: null };
const processing: { activities: SessionActivityMap } = { activities: new Map() };
const registeredPaletteOps: Array<Record<string, unknown>> = [];
// What the real provider reads from the project state hook, in the one test that renders it.
const projectsState: { current: EffectsState | null } = { current: null };

vi.mock('@/modules/project-workspace/context/ProjectsStateContext', () => ({
  useProjectEffectsState: () => effects.state,
  ProjectsStateProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/modules/project-workspace/hooks/useProjectsState', () => ({ useProjectsState: () => projectsState.current }));
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
  useProcessingSessions: () => processing.activities,
}));
vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ ws: null, sendMessage: () => undefined, subscribe: () => () => undefined }),
}));
vi.mock('@/shared/hooks/useDeviceSettings', () => ({ useDeviceSettings: () => ({ isMobile: false }) }));
vi.mock('@/modules/project-workspace/ProjectWorkspaceShell', () => ({ default: () => <div data-testid="workspace-shell" /> }));

const { default: ProjectEffects } = await import('@/modules/project-workspace/controllers/ProjectEffects');
const { default: ProjectWorkspaceRoute } = await import('@/modules/project-workspace/ProjectWorkspaceRoute');
const {
  ProjectsStateProvider: RealProjectsStateProvider,
  useProjectEffectsState: useRealProjectEffectsState,
} = await vi.importActual<typeof ProjectsStateContextModule>('@/modules/project-workspace/context/ProjectsStateContext');

// The effects state the real provider hands over, as ProjectEffects would read it.
const providedEffectsState: { current: ReturnType<typeof useRealProjectEffectsState> | null } = { current: null };
function EffectsStateProbe() {
  const effectsState = useRealProjectEffectsState();
  useLayoutEffect(() => {
    providedEffectsState.current = effectsState;
  });
  return null;
}

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
  projects: [ALPHA],
  layout: createInitialLayout(),
  ...overrides,
});

/**
 * The focused pane showing `session` in its only tab, the way the provider hands it over: the focused
 * session is that tab's session object, and the tab keeps `tabTitle` as its snapshot.
 */
const focusing = (
  session: ProjectSession,
  tabTitle = typeof session.summary === 'string' ? session.summary : '',
): Pick<EffectsState, 'focusedSession' | 'layout'> => {
  const tab: WorkspaceSessionTab = {
    key: `tab-${session.id}`,
    sessionId: session.id,
    projectId: ALPHA.projectId,
    provider: 'claude',
    title: tabTitle,
    view: 'chat',
    isPreview: false,
    session,
  };
  const layout = createInitialLayout();
  return {
    focusedSession: session,
    layout: { ...layout, left: { ...layout.left, tabs: [tab], activeTabKey: tab.key, mru: [tab.key] } },
  };
};

/** A CloudCLI turn in flight, as the activity map lists it. */
const turnStartedAt = (startedAt: number): SessionActivity => ({ statusText: null, canInterrupt: true, startedAt });

// A language switch saves the choice to the server; it must not reach the network.
vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));

beforeEach(() => {
  registeredPaletteOps.length = 0;
  processing.activities = new Map();
});

afterEach(async () => {
  // Unmount first, so restoring the language cannot re-render this test's tree.
  cleanup();
  await i18n.changeLanguage('en');
});

test('the browser tab title follows the focused pane: its session, else its project', () => {
  effects.state = makeState(focusing({ id: 's1', summary: 'Fix the login bug', __provider: 'claude' }));
  const view = render(<ProjectEffects />);
  assert.equal(document.title, 'Fix the login bug');

  effects.state = makeState(focusing({ id: 's2', summary: 'Other pane chat', __provider: 'claude' }));
  view.rerender(<ProjectEffects />);
  assert.equal(document.title, 'Other pane chat');

  effects.state = makeState({ focusedSession: null });
  view.rerender(<ProjectEffects />);
  assert.equal(document.title, 'Alpha - CloudCLI UI');
});

test('the page title takes the focused session\'s live title over the one its tab was opened with', () => {
  const projects = [{ ...ALPHA, sessions: [{ id: 's1', summary: 'Renamed in the sidebar', __provider: 'claude' as const }] }];
  effects.state = makeState({ projects, ...focusing({ id: 's1', summary: 'Fix the login bug', __provider: 'claude' }) });
  const view = render(<ProjectEffects />);
  assert.equal(document.title, 'Renamed in the sidebar');

  // A session the loaded projects do not list keeps its tab's title.
  effects.state = makeState({ projects, ...focusing({ id: 's2', summary: 'Other pane chat', __provider: 'claude' }) });
  view.rerender(<ProjectEffects />);
  assert.equal(document.title, 'Other pane chat');
});

test('unmounting the workspace (signing out, leaving its route) puts the app name back in the tab title', () => {
  effects.state = makeState(focusing({ id: 's1', summary: 'Fix the login bug', __provider: 'claude' }));
  const view = render(<ProjectEffects />);
  assert.equal(document.title, 'Fix the login bug');

  view.unmount();
  assert.equal(document.title, 'CloudCLI UI');
});

test('while a session runs, the tab title names it behind the running marker instead of the focused pane', () => {
  const projects = [{ ...ALPHA, sessions: [{ id: 's2', summary: 'Audit deps', __provider: 'claude' as const }] }];
  processing.activities = new Map([['s2', turnStartedAt(1000)]]);
  effects.state = makeState({ projects, ...focusing({ id: 's1', summary: 'Fix the login bug', __provider: 'claude' }) });
  const view = render(<ProjectEffects />);
  assert.equal(document.title, '[Running] Audit deps');

  processing.activities = new Map();
  view.rerender(<ProjectEffects />);
  assert.equal(document.title, 'Fix the login bug');
});

test('a focused session that starts running keeps its title and only gains the marker', () => {
  const cases: Array<{ name: string; projects: Project[]; session: ProjectSession; tabTitle: string; expected: string }> = [
    {
      name: 'live title',
      projects: [{ ...ALPHA, sessions: [{ id: 's1', summary: 'Renamed live', __provider: 'claude' }] }],
      session: { id: 's1', summary: 'Opened as', __provider: 'claude' },
      tabTitle: 'Opened as',
      expected: 'Renamed live',
    },
    {
      // Not listed, and opened from an object with only a `title`: the tab's snapshot took it, while
      // the session object has no summary or name for getSessionTitle to read.
      name: 'tab snapshot',
      projects: [ALPHA],
      session: { id: 's1', title: 'Snapshot title', __provider: 'claude' },
      tabTitle: 'Snapshot title',
      expected: 'Snapshot title',
    },
    {
      name: 'no title anywhere',
      projects: [ALPHA],
      session: { id: 's1', __provider: 'claude' },
      tabTitle: '',
      expected: 'Untitled session',
    },
  ];

  for (const { name, projects, session, tabTitle, expected } of cases) {
    processing.activities = new Map();
    effects.state = makeState({ projects, ...focusing(session, tabTitle) });
    const view = render(<ProjectEffects />);
    assert.equal(document.title, expected, `${name}: idle`);

    processing.activities = new Map([['s1', turnStartedAt(1000)]]);
    view.rerender(<ProjectEffects />);
    assert.equal(document.title, `[Running] ${expected}`, `${name}: running`);
    view.unmount();
  }
});

test('an untitled focused session reads Untitled session in the interface language, idle and running', async () => {
  effects.state = makeState(focusing({ id: 's1', __provider: 'claude' }, ''));
  const view = render(<ProjectEffects />);
  assert.equal(document.title, 'Untitled session');

  // A language switch alone rewrites the placeholder.
  await act(async () => {
    await i18n.changeLanguage('zh-CN');
  });
  assert.equal(document.title, '未命名会话');

  processing.activities = new Map([['s1', turnStartedAt(1000)]]);
  view.rerender(<ProjectEffects />);
  assert.equal(document.title, '[运行中] 未命名会话');
});

test('the provider renews the effects state when only the projects or only the layout changes, so renames and opened tabs reach the title', () => {
  const navigate = vi.fn() as unknown as NavigateFunction;
  const renderProvider = () => (
    <RealProjectsStateProvider navigate={navigate} subscribe={() => () => undefined} isMobile={false} isSessionProcessing={() => false}>
      <EffectsStateProbe />
    </RealProjectsStateProvider>
  );

  // Every other field keeps its identity, so only the field that changed can renew the state.
  const base = makeState();
  projectsState.current = base;
  const view = render(renderProvider());
  assert.equal(providedEffectsState.current?.projects === base.projects, true);
  assert.equal(providedEffectsState.current?.layout === base.layout, true);

  const renamed = [{ ...ALPHA, sessions: [{ id: 's1', summary: 'Renamed in the sidebar', __provider: 'claude' as const }] }];
  projectsState.current = { ...base, projects: renamed };
  view.rerender(renderProvider());
  assert.equal(providedEffectsState.current?.projects === renamed, true);

  // Opening or closing a tab gives a new layout object.
  const changedLayout = createInitialLayout();
  projectsState.current = { ...base, projects: renamed, layout: changedLayout };
  view.rerender(renderProvider());
  assert.equal(providedEffectsState.current?.layout === changedLayout, true);
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
