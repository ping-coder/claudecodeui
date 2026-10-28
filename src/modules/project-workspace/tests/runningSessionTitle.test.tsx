import assert from 'node:assert/strict';

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { useRunningSessionTitle } from '@/modules/project-workspace/hooks/useRunningSessionTitle';
import type {
  BackgroundTaskSummary,
  DocumentTitleStatus,
  Project,
  ProjectSession,
  SessionActivity,
  SessionActivityMap,
  WorkspaceLayout,
  WorkspacePaneState,
  WorkspaceSessionTab,
} from '@/shared/types';
import type * as SharedUtils from '@/shared/utils';
import { setDocumentPageTitle } from '@/shared/utils';

/**
 * While anything runs, the browser tab title names the latest running session behind a marker
 * ("[Running 3] Fix login"). It counts CloudCLI turns, and the external Claude CLI's turns only for
 * sessions this tab has open; with no turn running, sessions busy with agents or workflows show as
 * "[Background]", while backgrounded shell commands (a dev server) never do. The session named is
 * the last to start of those open in this tab, else of all, by the order this tab saw them start.
 */

// Every write of the running part, so a test can tell a rewrite (or a clear) from no write at all.
const { activityWrites } = vi.hoisted(() => ({
  activityWrites: [] as Array<DocumentTitleStatus | null>,
}));

vi.mock('@/shared/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedUtils>();
  return {
    ...actual,
    setDocumentTitleActivity: (status: DocumentTitleStatus | null) => {
      activityWrites.push(status ? { ...status } : null);
      actual.setDocumentTitleActivity(status);
    },
  };
});

// A language switch saves the choice to the server; it must not reach the network.
vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));

type TitleInput = {
  activities: SessionActivityMap;
  projects: readonly Project[];
  layout: WorkspaceLayout;
};

const renderTitle = (initialProps: TitleInput) =>
  renderHook((input: TitleInput) => useRunningSessionTitle(input), { initialProps });

const activitiesOf = (entries: Record<string, SessionActivity>): SessionActivityMap => new Map(Object.entries(entries));

const turn = (startedAt: number, statusText: string | null = null): SessionActivity => ({ statusText, canInterrupt: true, startedAt });

// The poll lists a Claude CLI turn running outside CloudCLI as one that cannot be interrupted.
const cliTurn = (startedAt: number): SessionActivity => ({ statusText: null, canInterrupt: false, startedAt });

const backgroundWork = (startedAt: number, ...taskTypes: string[]): SessionActivity => ({
  statusText: null,
  canInterrupt: false,
  startedAt,
  background: true,
  tasks: taskTypes.map((taskType, index): BackgroundTaskSummary => ({
    taskId: `task-${index}`,
    toolUseId: `tool-${index}`,
    taskType,
    description: taskType,
    startedAt,
  })),
});

/** The loaded projects, listing each session id with its live title. */
const projectsWith = (titles: Record<string, string>): Project[] => [{
  projectId: 'alpha',
  displayName: 'Alpha',
  fullPath: '/repo/alpha',
  path: '/repo/alpha',
  sessions: Object.entries(titles).map(([id, summary]): ProjectSession => ({ id, summary, __provider: 'claude' })),
}];

const makeTab = (sessionId: string, title = ''): WorkspaceSessionTab => ({
  key: `tab-${sessionId}`,
  sessionId,
  projectId: 'alpha',
  provider: 'claude',
  title,
  view: 'chat',
  isPreview: false,
  session: { id: sessionId, __projectId: 'alpha', __provider: 'claude' },
});

const makePane = (id: string, tabs: WorkspaceSessionTab[]): WorkspacePaneState => ({
  id,
  tabs,
  activeTabKey: tabs[0]?.key ?? null,
  mru: tabs.map((tab) => tab.key),
  draftActivation: 0,
  externalRevision: 0,
});

/** This tab's layout: the given tabs in the left pane and, when given, more in a right one. */
const layoutWith = (leftTabs: WorkspaceSessionTab[], rightTabs?: WorkspaceSessionTab[]): WorkspaceLayout => ({
  left: makePane('pane-left', leftTabs),
  right: rightTabs ? makePane('pane-right', rightTabs) : null,
  focusedSide: 'left',
  splitRatio: 0.5,
});

const NOTHING_OPEN = layoutWith([]);

beforeEach(() => {
  setDocumentPageTitle('Page title');
  activityWrites.length = 0;
});

afterEach(async () => {
  // Unmount first, so restoring the language cannot re-render this test's hook.
  cleanup();
  await i18n.changeLanguage('en');
});

test('a turn shows as [Running] and its session; CLI turns count only for sessions open in this tab', () => {
  const projects = projectsWith({
    login: 'Fix login',
    deps: 'Audit deps',
    cli: 'Terminal chat',
    elsewhere: 'Other terminal',
  });
  const view = renderTitle({ activities: activitiesOf({ login: turn(1000) }), projects, layout: NOTHING_OPEN });
  assert.equal(document.title, '[Running] Fix login');

  // Two CloudCLI turns, a CLI turn this tab has open, and a later CLI turn it does not have open.
  view.rerender({
    activities: activitiesOf({ login: turn(1000), deps: turn(2000), cli: cliTurn(3000), elsewhere: cliTurn(4000) }),
    projects,
    layout: layoutWith([makeTab('deps'), makeTab('cli')]),
  });
  assert.equal(document.title, '[Running 3] Terminal chat');

  // A CLI turn this tab does not have open is not in the title at all.
  view.rerender({ activities: activitiesOf({ elsewhere: cliTurn(4000) }), projects, layout: layoutWith([makeTab('deps')]) });
  assert.equal(document.title, 'Page title');
});

test('a session open in this tab, in any tab of either pane, wins over a later one that is not; with none open, the latest', () => {
  const projects = projectsWith({ a: 'Session A', b: 'Session B', other: 'Other chat' });
  const aOpenBehindAnotherTab = layoutWith([makeTab('other')], [makeTab('other-2'), makeTab('a')]);
  const view = renderTitle({ activities: activitiesOf({ a: turn(1000) }), projects, layout: aOpenBehindAnotherTab });

  view.rerender({ activities: activitiesOf({ a: turn(1000), b: turn(2000) }), projects, layout: aOpenBehindAnotherTab });
  assert.equal(document.title, '[Running 2] Session A');

  view.rerender({ activities: activitiesOf({ a: turn(1000), b: turn(2000) }), projects, layout: layoutWith([makeTab('other')]) });
  assert.equal(document.title, '[Running 2] Session B');
});

test('the latest is the last this tab saw start: startedAt orders only the ones found together', () => {
  const projects = projectsWith({ a: 'Session A', b: 'Session B', c: 'Session C' });

  // Already running when the page loads: the later start is the latest.
  const view = renderTitle({ activities: activitiesOf({ a: turn(5000), b: turn(1000) }), projects, layout: NOTHING_OPEN });
  assert.equal(document.title, '[Running 2] Session A');

  // c starts after them, though the server's clock puts its start before both.
  view.rerender({ activities: activitiesOf({ a: turn(5000), b: turn(1000), c: turn(500) }), projects, layout: NOTHING_OPEN });
  assert.equal(document.title, '[Running 3] Session C');

  // A poll that rewrites a start moves nothing.
  view.rerender({ activities: activitiesOf({ a: turn(9000), b: turn(1000), c: turn(500) }), projects, layout: NOTHING_OPEN });
  assert.equal(document.title, '[Running 3] Session C');

  // b's turn ends and a new one starts: b is the latest now.
  view.rerender({ activities: activitiesOf({ a: turn(9000), c: turn(500) }), projects, layout: NOTHING_OPEN });
  assert.equal(document.title, '[Running 2] Session C');
  view.rerender({ activities: activitiesOf({ a: turn(9000), b: turn(100), c: turn(500) }), projects, layout: NOTHING_OPEN });
  assert.equal(document.title, '[Running 3] Session B');
});

test('with no turn running, agent and workflow work shows as [Background]; shell commands never do', () => {
  const projects = projectsWith({ server: 'Dev server', audit: 'Audit deps', release: 'Release flow', login: 'Fix login' });
  const devServer = backgroundWork(1000, 'local_bash');
  const view = renderTitle({ activities: activitiesOf({ server: devServer }), projects, layout: NOTHING_OPEN });
  assert.equal(document.title, 'Page title');

  view.rerender({
    activities: activitiesOf({ server: devServer, audit: backgroundWork(2000, 'local_bash', 'local_agent') }),
    projects,
    layout: NOTHING_OPEN,
  });
  assert.equal(document.title, '[Background] Audit deps');

  const twoWorking = {
    server: devServer,
    audit: backgroundWork(2000, 'local_bash', 'local_agent'),
    release: backgroundWork(3000, 'local_workflow'),
  };
  view.rerender({ activities: activitiesOf(twoWorking), projects, layout: NOTHING_OPEN });
  assert.equal(document.title, '[Background 2] Release flow');

  // Any turn in flight takes the title back.
  view.rerender({ activities: activitiesOf({ ...twoWorking, login: turn(4000) }), projects, layout: NOTHING_OPEN });
  assert.equal(document.title, '[Running] Fix login');
});

test('the session is named by its live title, else its tab\'s snapshot, else Untitled session', () => {
  const activities = activitiesOf({ s1: turn(1000) });
  const snapshotOnly = layoutWith([makeTab('s1', 'Snapshot title')]);
  const view = renderTitle({ activities, projects: projectsWith({ s1: 'Renamed live' }), layout: snapshotOnly });
  assert.equal(document.title, '[Running] Renamed live');

  view.rerender({ activities, projects: projectsWith({}), layout: snapshotOnly });
  assert.equal(document.title, '[Running] Snapshot title');

  view.rerender({ activities, projects: projectsWith({}), layout: NOTHING_OPEN });
  assert.equal(document.title, '[Running] Untitled session');
});

test('the marker and the placeholder follow the interface language', async () => {
  const projects = projectsWith({ a: 'Session A', b: 'Session B', c: 'Session C' });
  const view = renderTitle({ activities: activitiesOf({ a: turn(1000), b: turn(2000) }), projects, layout: NOTHING_OPEN });
  assert.equal(document.title, '[Running 2] Session B');

  await act(async () => {
    await i18n.changeLanguage('zh-CN');
  });
  assert.equal(document.title, '[运行中 2] Session B');

  view.rerender({ activities: activitiesOf({ c: backgroundWork(3000, 'local_agent') }), projects, layout: NOTHING_OPEN });
  assert.equal(document.title, '[后台] Session C');

  view.rerender({ activities: activitiesOf({ unknown: turn(4000) }), projects, layout: NOTHING_OPEN });
  assert.equal(document.title, '[运行中] 未命名会话');
});

test('a status line rewrite writes nothing, a change writes over the last value, and only unmounting clears it', () => {
  const projects = projectsWith({ a: 'Session A', b: 'Session B' });
  const view = renderTitle({ activities: activitiesOf({ a: turn(1000, 'Thinking') }), projects, layout: NOTHING_OPEN });
  view.rerender({ activities: activitiesOf({ a: turn(1000, 'Reading files') }), projects, layout: NOTHING_OPEN });
  view.rerender({ activities: activitiesOf({ a: turn(1000, 'Editing'), b: turn(2000) }), projects, layout: NOTHING_OPEN });
  assert.equal(document.title, '[Running 2] Session B');

  view.unmount();
  assert.equal(document.title, 'Page title');
  assert.deepEqual(activityWrites, [
    { marker: '[Running]', subject: 'Session A' },
    { marker: '[Running 2]', subject: 'Session B' },
    null,
  ]);
});
