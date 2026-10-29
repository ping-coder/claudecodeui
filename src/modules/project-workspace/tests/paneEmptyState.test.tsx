import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import type { Project, ProjectSession, WorkspaceLayoutActions } from '@/shared/types';

/**
 * A pane without tabs. It offers the six most recent conversations to open on this side (not
 * ones the other pane already shows), a new chat in the default project or a picked one, while
 * split the other pane's conversation and a way to close this side, and hints that fit the
 * pointer. Without projects it falls back to the create-a-project guidance.
 */

vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ connectionStatus: 'connected' }) }));

const { default: PaneEmptyState } = await import('@/modules/project-workspace/PaneEmptyState');

const session = (id: string, lastActivity: string, overrides: Partial<ProjectSession> = {}): ProjectSession => ({
  id,
  summary: `Talk ${id}`,
  lastActivity,
  ...overrides,
});

const ALPHA: Project = {
  projectId: 'alpha',
  displayName: 'Alpha',
  fullPath: '/repo/alpha',
  sessions: [
    session('s1', '2026-10-20T10:00:00Z'),
    session('s2', '2026-10-27T10:00:00Z'),
    session('s3', '2026-10-25T10:00:00Z'),
  ],
};
const BETA: Project = {
  projectId: 'beta',
  displayName: 'Beta',
  fullPath: '/repo/beta',
  sessions: [
    session('s4', '2026-10-26T10:00:00Z', { __provider: 'codex' }),
    session('s5', '2026-10-21T10:00:00Z'),
    session('s6', '2026-10-22T10:00:00Z'),
    session('s7', '2026-10-19T10:00:00Z'),
  ],
};

const makeActions = (): WorkspaceLayoutActions => ({
  openSession: vi.fn(),
  openSessionById: vi.fn(),
  openNewSession: vi.fn(),
  establishDraft: vi.fn(),
  activateTab: vi.fn(),
  closeTab: vi.fn(),
  closeOtherTabs: vi.fn(),
  closeTabsToRight: vi.fn(),
  closeAllTabs: vi.fn(),
  pinTab: vi.fn(),
  moveTab: vi.fn(),
  setTabView: vi.fn(),
  focusPane: vi.fn(),
  split: vi.fn(),
  toggleSplit: vi.fn(),
  closePane: vi.fn(),
  setSplitRatio: vi.fn(),
});

let actions = makeActions();
const OTHER_SESSION: ProjectSession = { id: 's3', summary: 'Talk s3', __projectId: 'alpha', __provider: 'claude' };

const renderEmpty = (overrides: Partial<ComponentProps<typeof PaneEmptyState>> = {}) => render(
  <PaneEmptyState
    side="right"
    projects={[ALPHA, BETA]}
    defaultProject={ALPHA}
    isSplit
    canSplit
    isMobile={false}
    otherPaneSession={OTHER_SESSION}
    otherPaneSessionIds={new Set(['s3'])}
    actions={actions}
    onMenuClick={vi.fn()}
    {...overrides}
  />,
);

beforeEach(() => {
  actions = makeActions();
});

test('it lists the six most recent conversations, leaving out the other pane\'s, and opens one kept on this side', () => {
  renderEmpty();

  const list = screen.getByRole('region', { name: 'Recent conversations' });
  const titles = within(list).getAllByRole('button').map((button) => button.textContent);
  assert.deepEqual(titles, [
    'Talk s2Alpha',
    'Talk s4Beta',
    'Talk s6Beta',
    'Talk s5Beta',
    'Talk s1Alpha',
    'Talk s7Beta',
  ]);

  fireEvent.click(within(list).getByRole('button', { name: /Talk s4/ }));
  assert.deepEqual(vi.mocked(actions.openSession).mock.calls, [[
    { ...BETA.sessions?.[0], __projectId: 'beta', __provider: 'codex' },
    { target: 'right', preview: false },
  ]]);
});

test('a new chat starts in the default project, or in one picked from the menu', () => {
  renderEmpty();

  fireEvent.click(screen.getByRole('button', { name: 'New chat in Alpha' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose project' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Beta' }));

  assert.deepEqual(vi.mocked(actions.openNewSession).mock.calls, [
    [ALPHA, { target: 'right' }],
    [BETA, { target: 'right' }],
  ]);
});

test('the right pane can show the other pane\'s conversation too, or close', () => {
  renderEmpty();

  assert.ok(screen.getByRole('heading', { name: 'This side is empty' }));
  fireEvent.click(screen.getByRole('button', { name: 'Also open the current conversation here' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close this side' }));

  assert.deepEqual(vi.mocked(actions.openSession).mock.calls, [[OTHER_SESSION, { target: 'right', preview: false }]]);
  assert.deepEqual(vi.mocked(actions.closePane).mock.calls, [['right']]);
});

test('a lone empty pane has neither the duplicate nor the close action', () => {
  renderEmpty({ side: 'left', isSplit: false, otherPaneSession: null, otherPaneSessionIds: new Set() });

  assert.ok(screen.getByRole('heading', { name: 'No conversation open' }));
  // Seven conversations, nothing open elsewhere: the six newest are offered, the oldest is not.
  const recent = within(screen.getByRole('region', { name: 'Recent conversations' })).getAllByRole('button');
  assert.equal(recent.length, 6);
  assert.equal(recent.some((button) => button.textContent?.includes('Talk s7')), false);
  assert.equal(screen.queryByRole('button', { name: 'Also open the current conversation here' }) === null, true);
  assert.equal(screen.queryByRole('button', { name: 'Close this side' }) === null, true);
});

test('desktop hints cover dragging and the shortcuts; touch pointers and phones get the tap hint', () => {
  const desktop = renderEmpty();
  const dragHint = screen.getByText('Drag a conversation here from the sidebar');
  assert.ok(dragHint.className.includes('[@media(pointer:coarse)]:hidden'), 'hidden on touch screens');
  assert.ok(screen.getByText('Ctrl+\\ split or merge · Ctrl+1 / Ctrl+2 switch panes · Ctrl+Shift+Enter full screen'));
  const touchHint = screen.getByText('Tap a conversation in the sidebar to open it on this side');
  assert.ok(touchHint.className.includes('hidden') && touchHint.className.includes('[@media(pointer:coarse)]:block'));
  desktop.unmount();

  renderEmpty({ isMobile: true, mobileHeader: <div>phone header</div> });
  assert.ok(screen.getByText('phone header'));
  assert.equal(screen.queryByText('Drag a conversation here from the sidebar') === null, true);
  assert.equal(screen.queryByText(/split or merge/) === null, true);
  assert.equal(screen.getByText('Tap a conversation in the sidebar to open it on this side').className.includes('hidden'), false);
});

test('the shortcut hint names only keys that act: unsplit, Mod+1/2 belong to the browser, and Mod+\\ needs room to split', () => {
  const lonePane = { side: 'left', isSplit: false, otherPaneSession: null, otherPaneSessionIds: new Set<string>() } as const;
  const unsplit = renderEmpty(lonePane);
  assert.ok(screen.getByText('Ctrl+\\ split · Ctrl+Shift+Enter full screen'));
  assert.equal(screen.queryByText(/switch panes/) === null, true);
  unsplit.unmount();

  renderEmpty({ ...lonePane, canSplit: false });
  assert.ok(screen.getByText('Ctrl+Shift+Enter full screen'));
  assert.equal(screen.queryByText(/Ctrl\+\\/) === null, true);
});

test('without any project the pane shows the create-a-project guidance', () => {
  renderEmpty({ projects: [], defaultProject: null });

  assert.ok(screen.getByRole('heading', { name: 'Choose Your Project' }));
  assert.equal(screen.queryByRole('button', { name: /New chat/ }) === null, true);
});

test('the recent list reads the server\'s placeholder names in the interface language', async () => {
  // A language switch saves the choice to the server; it must not reach the network.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
  await act(async () => {
    await i18n.changeLanguage('zh-CN');
  });
  try {
    const gamma: Project = {
      projectId: 'gamma',
      displayName: 'Gamma',
      fullPath: '/repo/gamma',
      sessions: [
        session('u1', '2026-10-27T10:00:00Z', { summary: 'Untitled Claude Session' }),
        session('u2', '2026-10-26T10:00:00Z', { summary: 'Untitled', __provider: 'agy' }),
        session('u3', '2026-10-25T10:00:00Z', { summary: 'Untitled Session', __provider: 'cursor' }),
        session('u4', '2026-10-24T10:00:00Z', { summary: 'Untitled draft' }),
      ],
    };
    renderEmpty({ side: 'left', projects: [gamma], defaultProject: gamma, isSplit: false, otherPaneSession: null, otherPaneSessionIds: new Set() });

    const list = screen.getByRole('region', { name: '最近的对话' });
    assert.deepEqual(within(list).getAllByRole('button').map((button) => button.textContent), [
      '未命名的 Claude 会话Gamma',
      '未命名会话Gamma',
      '未命名会话Gamma',
      'Untitled draftGamma',
    ]);
  } finally {
    // Unmount first, so restoring the language cannot re-render this test's tree.
    cleanup();
    await act(async () => {
      await i18n.changeLanguage('en');
    });
    vi.unstubAllGlobals();
  }
});
