import assert from 'node:assert/strict';

import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { Project } from '@/shared/types';

/**
 * A project the wizard creates is selected and opened: the project list refreshes first, then the
 * sidebar records it as the browsed project and opens a new chat in it, the way a click on its
 * New session would, so the focused pane shows it and the sidebar expands it.
 */

vi.mock('@/shared/api', () => ({
  api: {
    archivedProjects: () => Promise.resolve({ ok: true, json: async () => ({ data: { projects: [] } }) }),
    getArchivedSessions: () => Promise.resolve({ ok: true, json: async () => ({ data: { sessions: [] } }) }),
    recentConversations: () => Promise.resolve({ ok: true, json: async () => ({ data: { conversations: [] } }) }),
  },
}));

// The modal layer hands the wizard's callback over; the test plays the wizard.
let latestOnProjectCreated: ((project?: Record<string, unknown>) => void) | null = null;
vi.mock('@/modules/sidebar/SidebarModals', () => ({
  default: (props: { onProjectCreated: (project?: Record<string, unknown>) => void }) => {
    latestOnProjectCreated = props.onProjectCreated;
    return null;
  },
}));
vi.mock('@/modules/sidebar/SidebarProjectList', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarRecentConversations', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarFooter', () => ({ default: () => null }));

const events: string[] = [];
let finishRefresh: () => void = () => {};
vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({
    refreshProjects: () => {
      events.push('refresh');
      return new Promise<void>((resolve) => {
        finishRefresh = resolve;
      });
    },
  }),
}));
vi.mock('@/modules/task-master', () => ({
  useTaskMaster: () => ({ mcpServerStatus: null }),
  useTasksSettings: () => ({ tasksEnabled: false }),
}));
vi.mock('@/shared/hooks/useDeviceSettings', () => ({
  useDeviceSettings: () => ({ isPWA: false }),
}));
vi.mock('@/shared/hooks/useVersionCheck', () => ({
  useVersionCheck: () => ({
    updateAvailable: false,
    restartRequired: false,
    latestVersion: null,
    currentVersion: '1.0.0',
    releaseInfo: null,
    installMode: 'git',
  }),
}));
vi.mock('@/shared/context/UiPreferencesContext', () => ({
  useUiPreferences: () => ({ sidebarVisible: true, keepProjectsExpanded: false }),
  useSetUiPreference: () => () => {},
}));
const NO_SESSION_IDS: ReadonlySet<string> = new Set<string>();
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useBusySessionIdSet: () => NO_SESSION_IDS,
  useBackgroundSessionIdSet: () => NO_SESSION_IDS,
}));

const { default: Sidebar } = await import('@/modules/sidebar/Sidebar');

const noop = () => {};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
  events.length = 0;
  latestOnProjectCreated = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const renderSidebar = () => {
  const onProjectSelect = vi.fn((project: Project) => events.push(`select:${project.projectId}`));
  const onNewSession = vi.fn((project: Project) => events.push(`open:${project.projectId}`));
  render(
    <Sidebar
      projects={[]}
      selectedProject={null}
      selectedSession={null}
      attentionSessionIds={NO_SESSION_IDS}
      onProjectSelect={onProjectSelect}
      onSessionSelect={noop}
      onNewSession={onNewSession}
      isLoading={false}
      loadingProgress={null}
      onRefresh={noop}
      onShowSettings={noop}
      showSettings={false}
      settingsInitialTab="agents"
      onCloseSettings={noop}
      isMobile={false}
    />,
  );
  return { onProjectSelect, onNewSession };
};

test('a created project is opened once the project list has refreshed', async () => {
  const { onNewSession } = renderSidebar();
  const created = { projectId: 'project-new', displayName: 'new', fullPath: '/work/new', path: '/work/new', sessions: [] };

  act(() => latestOnProjectCreated?.(created));
  assert.deepEqual(events, ['refresh'], 'nothing opens before the list has the project');

  await act(async () => {
    finishRefresh();
  });
  await waitFor(() => assert.equal(onNewSession.mock.calls.length, 1));
  assert.deepEqual(events, ['refresh', 'select:project-new', 'open:project-new']);
  assert.equal(onNewSession.mock.calls[0]?.[0]?.projectId, 'project-new');
});

test('without a project from the wizard the list still refreshes and nothing opens', async () => {
  const { onNewSession, onProjectSelect } = renderSidebar();

  act(() => latestOnProjectCreated?.(undefined));
  await act(async () => {
    finishRefresh();
  });

  assert.deepEqual(events, ['refresh']);
  assert.equal(onNewSession.mock.calls.length, 0);
  assert.equal(onProjectSelect.mock.calls.length, 0);
});
