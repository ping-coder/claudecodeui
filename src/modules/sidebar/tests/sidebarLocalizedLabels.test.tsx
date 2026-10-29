import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterAll, afterEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { stripBidiIsolates } from '@/shared/direction';
import type { PendingSidebarDeletion, Project, SessionWithProvider } from '@/shared/types';

/**
 * The sidebar in the interface language: row ages ("23hr" read as English everywhere), the server's
 * placeholder session names, the session menu and its phone sheet, the GitHub badge, and the delete
 * questions, whose question mark and word order come from the translation. A rename starts from the
 * stored title, not from its translation.
 */

vi.mock('@/shared/api', () => ({
  api: {
    providerSessionId: () => Promise.resolve({ ok: false, json: async () => ({}) }),
  },
}));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useSessionForkingProviders: () => new Set(['claude']),
}));
let isCompactLayout = false;
vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({
  useCompactSidebar: () => isCompactLayout,
}));
vi.mock('@/modules/sidebar/hooks/useGitHubStars', () => ({
  useGitHubStars: () => ({ formattedCount: '9.8k', isDismissed: false, dismiss: () => {} }),
}));
vi.mock('@/modules/settings', () => ({ Settings: () => null }));
vi.mock('@/modules/version-upgrade', () => ({ VersionUpgradeModal: () => null }));
vi.mock('@/modules/project-creation-wizard', () => ({ ProjectCreationWizard: () => null }));

const { formatCompactAge, formatSessionTitle } = await import('@/modules/sidebar/utils/sidebarProjectFormatting');
const { default: SessionOptions } = await import('@/modules/sidebar/SessionOptions');
const { default: SidebarSessionItem } = await import('@/modules/sidebar/SidebarSessionItem');
const { default: GitHubStarBadge } = await import('@/modules/sidebar/GitHubStarBadge');
const { default: SidebarModals } = await import('@/modules/sidebar/SidebarModals');

const NOW = new Date('2026-08-21T10:00:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const noop = () => {};
const sidebarT = (language: string) => i18n.getFixedT(language, ['sidebar', 'common']) as TFunction;

afterEach(async () => {
  isCompactLayout = false;
  await i18n.changeLanguage('en');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

// ------------------------------------------------------------------ Ages and placeholder names

test('a row\'s age is short and in the interface language', () => {
  const ages = (language: string) => [0, 5, 60, 120, 23 * 60, 24 * 60, 2 * 24 * 60, 12 * 24 * 60]
    .map((minutes) => stripBidiIsolates(formatCompactAge(ago(minutes), NOW, sidebarT(language))));

  assert.deepEqual(ages('en'), ['<1m', '5m', '1hr', '2hr', '23hr', '1d', '2d', '12d']);
  assert.deepEqual(ages('zh-CN'), ['刚刚', '5 分钟', '1 小时', '2 小时', '23 小时', '1 天', '2 天', '12 天']);
  assert.deepEqual(ages('he'), ['עכשיו', '5 דק׳', 'שעה', 'שעתיים', '23 שע׳', 'יום', 'יומיים', '12 ימים']);
  assert.equal(formatCompactAge(null, NOW, sidebarT('zh-CN')), '');
  assert.equal(formatCompactAge('not a date', NOW, sidebarT('zh-CN')), '');
});

test('the server\'s placeholder names are shown in the interface language, other titles as they are', () => {
  const titles = ['Untitled Claude Session', 'Untitled OpenCode Session', 'Untitled Session', 'Untitled', 'Untitled draft', 'Fix login'];

  assert.deepEqual(titles.map((title) => formatSessionTitle(title, sidebarT('en'))), [
    'Untitled Claude Session', 'Untitled OpenCode Session', 'Untitled Session', 'Untitled Session', 'Untitled draft', 'Fix login',
  ]);
  assert.deepEqual(titles.map((title) => formatSessionTitle(title, sidebarT('zh-CN'))), [
    '未命名的 Claude 会话', '未命名的 OpenCode 会话', '未命名会话', '未命名会话', 'Untitled draft', 'Fix login',
  ]);
  assert.equal(formatSessionTitle('Untitled Codex Session', sidebarT('he')), 'סשן \u2068Codex\u2069 ללא שם');
});

// ------------------------------------------------------------------ The session menu

const renderOptions = (t: TFunction, handlers: {
  onStartEditingSession?: (projectId: string, sessionId: string, name: string) => void;
  onDeleteSession?: (sessionId: string, title: string) => void;
} = {}) => render(
  <SessionOptions
    sessionId="s1"
    sessionName="Untitled Claude Session"
    provider="claude"
    projectId="p1"
    isProcessing={false}
    isEditing={false}
    renameDraft=""
    onRenameDraftChange={noop}
    onStartEditingSession={handlers.onStartEditingSession ?? noop}
    onCancelEditingSession={noop}
    onSaveEditingSession={noop}
    onDeleteSession={handlers.onDeleteSession ?? noop}
    onFork={noop}
    t={t}
  />,
);

const menuTexts = (menu: HTMLElement) => within(menu).getAllByRole('menuitem').map((item) => item.textContent ?? '');

test('the session menu speaks the interface language, and renames from the stored title', async () => {
  await i18n.changeLanguage('zh-CN');
  const onStartEditingSession = vi.fn();
  const onDeleteSession = vi.fn();
  renderOptions(sidebarT('zh-CN'), { onStartEditingSession, onDeleteSession });

  fireEvent.click(screen.getByRole('button', { name: '会话选项：未命名的 Claude 会话' }));
  const menu = screen.getByRole('menu');
  assert.equal(menu.textContent?.includes('Claude 会话'), true, 'the header names the provider');
  // The id fetch fails (the api stub), which leaves the copy item offering a retry.
  await waitFor(() => assert.equal(menuTexts(menu).some((text) => text.includes('Claude 会话 ID 不可用')), true));
  assert.deepEqual(menuTexts(menu), [
    '重命名会话',
    'Claude 会话 ID 不可用点击重试。',
    '派生会话在副本上继续，这个会话保持不变。',
    '归档或删除会话',
  ]);

  fireEvent.click(within(menu).getByRole('menuitem', { name: '重命名会话' }));
  assert.deepEqual(onStartEditingSession.mock.calls, [['p1', 's1', 'Untitled Claude Session']]);

  fireEvent.click(screen.getByRole('button', { name: '会话选项：未命名的 Claude 会话' }));
  fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '归档或删除会话' }));
  assert.deepEqual(onDeleteSession.mock.calls, [['s1', '未命名的 Claude 会话']]);
});

test('English keeps the menu it had', () => {
  renderOptions(sidebarT('en'));
  fireEvent.click(screen.getByRole('button', { name: 'Session options for Untitled Claude Session' }));
  assert.deepEqual(menuTexts(screen.getByRole('menu')).map((text) => text.replace(/^(Loading|Copy).*/, '<copy>')), [
    'Rename session',
    '<copy>',
    'Fork sessionContinue from a copy, leaving this one untouched.',
    'Archive or delete session',
  ]);
});

// ------------------------------------------------------------------ The phone sheet

const PROJECT = { projectId: 'p1', displayName: 'demo-app', fullPath: '/repo/demo-app', sessions: [] } as unknown as Project;
const SESSION = { id: 's1', summary: 'Untitled Claude Session', lastActivity: ago(23 * 60), __provider: 'claude' } as unknown as SessionWithProvider;

const renderCompactRow = (t: TFunction, isEditing: boolean) => (
  <SidebarSessionItem
    project={PROJECT}
    session={SESSION}
    isSelected={false}
    isProcessing={false}
    hasBackgroundWork={false}
    needsAttention={false}
    currentTime={NOW}
    isEditing={isEditing}
    renameDraft="Untitled Claude Session"
    onRenameDraftChange={noop}
    onStartEditingSession={noop}
    onCancelEditingSession={noop}
    onSaveEditingSession={noop}
    onSessionSelect={noop}
    onDeleteSession={noop}
    isSelecting={false}
    isChecked={false}
    onToggleSessionSelected={noop}
    t={t}
  />
);

test('the phone row and its options sheet speak the interface language', async () => {
  await i18n.changeLanguage('zh-CN');
  isCompactLayout = true;
  const t = sidebarT('zh-CN');
  const view = render(renderCompactRow(t, false));

  assert.equal(view.container.textContent?.includes('未命名的 Claude 会话'), true);
  assert.equal(view.container.textContent?.includes('23 小时'), true);

  fireEvent.click(screen.getByRole('button', { name: '会话选项：未命名的 Claude 会话' }));
  const sheet = screen.getByRole('dialog');
  for (const text of ['会话选项', 'Claude 会话', '重命名会话', '归档或删除会话', '取消']) {
    assert.equal(sheet.textContent?.includes(text), true, text);
  }
  await waitFor(() => assert.equal(sheet.textContent?.includes('轻触重试。'), true));

  view.rerender(renderCompactRow(t, true));
  const editing = screen.getByRole('dialog');
  assert.equal(screen.getByLabelText('会话名称').tagName, 'INPUT');
  assert.deepEqual(
    within(editing).getAllByRole('button').map((button) => button.textContent?.trim()).filter((text) => text === '保存' || text === '取消'),
    ['保存', '取消'],
  );
});

// ------------------------------------------------------------------ The GitHub badge

test('the GitHub badge speaks the interface language', async () => {
  await i18n.changeLanguage('zh-CN');
  const { container } = render(<GitHubStarBadge />);

  assert.equal(container.querySelector('a')?.textContent, '加星标9.8k');
  assert.equal(container.querySelector('button')?.getAttribute('aria-label'), '关闭');
});

// ------------------------------------------------------------------ The delete questions

const renderQuestion = (pendingDeletion: PendingSidebarDeletion, t: TFunction) => render(
  <SidebarModals
    projects={[PROJECT]}
    showSettings={false}
    settingsInitialTab="agents"
    onCloseSettings={noop}
    showNewProject={false}
    onCloseNewProject={noop}
    onProjectCreated={noop}
    pendingDeletion={pendingDeletion}
    onCancelDeletion={noop}
    onConfirmDeleteProject={noop}
    onConfirmDeleteSession={noop}
    onConfirmDeleteSessions={noop}
    showVersionModal={false}
    onCloseVersionModal={noop}
    releaseInfo={null}
    currentVersion="1.0.0"
    latestVersion={null}
    installMode="npm"
    t={t}
  />,
);

/** The question line of the open confirmation, and the text of its bold part. */
const readQuestion = () => {
  const question = document.querySelector('[data-escape-layer] p.mb-1');
  return {
    text: question?.textContent ?? '',
    bold: question?.querySelector('.font-medium')?.textContent ?? '',
  };
};

const PROJECT_WITH_TAG = { ...PROJECT, displayName: 'demo <app>' } as Project;

test('the delete questions take their punctuation and word order from the translation', async () => {
  await i18n.changeLanguage('zh-CN');
  const t = sidebarT('zh-CN');

  const project = renderQuestion({ kind: 'project', project: PROJECT_WITH_TAG, sessionCount: 2 }, t);
  // A "<" in the name is shown as typed: the name is not run through Trans.
  assert.deepEqual(readQuestion(), { text: '要怎么处理 demo <app>？', bold: 'demo <app>' });
  project.unmount();

  const session = renderQuestion({ kind: 'session', sessionId: 's1', sessionTitle: '未命名的 Claude 会话', isArchived: false }, t);
  assert.deepEqual(readQuestion(), { text: '要怎么处理 未命名的 Claude 会话？', bold: '未命名的 Claude 会话' });
  session.unmount();

  renderQuestion({ kind: 'sessions', sessionIds: ['s1', 's2', 's3'] }, t);
  assert.deepEqual(readQuestion(), { text: '要怎么处理选中的 3 个会话？', bold: '选中的 3 个会话' });
});

test('right to left the name is isolated, so the question mark stays at the end', async () => {
  await i18n.changeLanguage('he');
  const t = sidebarT('he');

  const project = renderQuestion({ kind: 'project', project: { ...PROJECT, displayName: '/home/u/demo-app' } as Project, sessionCount: 0 }, t);
  assert.deepEqual(readQuestion(), { text: 'מה לעשות עם \u2068/home/u/demo-app\u2069?', bold: '/home/u/demo-app' });
  project.unmount();

  renderQuestion({ kind: 'sessions', sessionIds: ['s1', 's2'] }, t);
  assert.deepEqual(readQuestion(), { text: 'מה לעשות עם שני סשנים נבחרים?', bold: 'שני סשנים נבחרים' });
});

test('English keeps its questions', () => {
  const t = sidebarT('en');
  const project = renderQuestion({ kind: 'project', project: PROJECT, sessionCount: 1 }, t);
  assert.deepEqual(readQuestion(), { text: 'What would you like to do with demo-app?', bold: 'demo-app' });
  project.unmount();

  renderQuestion({ kind: 'sessions', sessionIds: ['s1'] }, t);
  assert.deepEqual(readQuestion(), { text: 'What would you like to do with 1 selected session?', bold: '1 selected session' });
});
