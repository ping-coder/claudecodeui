import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import type { TFunction } from 'i18next';
import type { ComponentProps } from 'react';
import { afterAll, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { stripBidiIsolates } from '@/shared/direction';
import type {
  ArchivedProjectListItem,
  ArchivedSessionListItem,
  ConversationSearchResults,
  SidebarProjectListProps,
  SidebarSearchMode,
} from '@/shared/types';

/**
 * Right to left, the archive and the conversation search keep mixed text in order: paths read left
 * to right (their leading "/" stayed at the end), titles and message excerpts follow their own first
 * letter (an English excerpt ended with its full stop at the start of the line). Ages, counts, the
 * search's progress and the server's placeholder titles are in the interface language.
 */

vi.mock('@/modules/sidebar/SidebarHeader', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarFooter', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarPaneTargetBar', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarProjectList', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarRecentConversations', () => ({ default: () => null }));

const { default: SidebarContent } = await import('@/modules/sidebar/SidebarContent');

const NOW = new Date('2026-08-21T10:00:00.000Z');
const HOURS_AGO_3 = '2026-08-21T07:00:00.000Z';
const noop = () => {};

const ARCHIVED_PROJECT = {
  projectId: 'p-archived',
  displayName: 'demo-app',
  fullPath: '/home/u/demo-app',
  isArchived: true,
  sessions: [{ id: 's-a', summary: 'Untitled Claude Session', lastActivity: HOURS_AGO_3, __provider: 'claude' }],
} as unknown as ArchivedProjectListItem;

const ARCHIVED_SESSION: ArchivedSessionListItem = {
  sessionId: 's-b',
  provider: 'codex',
  projectId: 'p-other',
  projectPath: '/home/u/other',
  projectDisplayName: 'other',
  sessionTitle: 'Untitled Codex Session',
  createdAt: null,
  updatedAt: null,
  lastActivity: HOURS_AGO_3,
  isProjectArchived: false,
};

const SEARCH: ConversationSearchResults = {
  query: 'deploy',
  totalMatches: 1,
  titleResults: [{
    sessionId: 's-c',
    provider: 'claude',
    projectId: 'p1',
    projectDisplayName: 'demo-app',
    sessionTitle: 'Untitled Claude Session',
    lastActivity: HOURS_AGO_3,
  }],
  results: [{
    projectId: 'p1',
    projectName: 'demo-app',
    projectDisplayName: 'demo-app',
    sessions: [{
      sessionId: 's-d',
      sessionSummary: 'Check the deploy',
      provider: 'claude',
      matches: [{ role: 'user', snippet: 'Keep checking the deploy every 10 minutes.', highlights: [{ start: 18, end: 24 }], timestamp: null }],
    }],
  }],
};

const renderContent = (
  t: TFunction,
  searchMode: SidebarSearchMode,
  overrides: Partial<ComponentProps<typeof SidebarContent>> = {},
) => render(
  <SidebarContent
    isPWA={false}
    isMobile={false}
    isLoading={false}
    projects={[]}
    runningSessionsCount={0}
    archivedProjects={[ARCHIVED_PROJECT]}
    archivedSessions={[ARCHIVED_SESSION]}
    archivedSessionsCount={5}
    isArchivedSessionsLoading={false}
    recentConversations={[]}
    recentConversationsTotal={0}
    recentConversationsHasMore={false}
    isRecentConversationsLoading={false}
    isLoadingMoreRecentConversations={false}
    recentConversationsError={false}
    searchFilter={searchMode === 'conversations' ? 'deploy' : ''}
    onSearchFilterChange={noop}
    onClearSearchFilter={noop}
    searchMode={searchMode}
    onSearchModeChange={noop}
    conversationResults={searchMode === 'conversations' ? SEARCH : null}
    isSearching={false}
    searchProgress={null}
    onRestoreArchivedProject={noop}
    onLoadMoreRecentConversations={noop}
    onRetryRecentConversations={noop}
    onArchivedSessionClick={noop}
    onRestoreArchivedSession={noop}
    onDeleteArchivedSession={noop}
    onConversationResultClick={noop}
    onRefresh={noop}
    isRefreshing={false}
    onCreateProject={noop}
    updateAvailable={false}
    restartRequired={false}
    releaseInfo={null}
    latestVersion={null}
    currentVersion="1.0.0"
    onShowVersionModal={noop}
    onShowSettings={noop}
    projectListProps={{
      currentTime: NOW,
      activeRename: null,
      filteredProjects: [],
      selectedSession: null,
      paneTargeting: null,
    } as unknown as SidebarProjectListProps}
    t={t}
    {...overrides}
  />,
);

afterAll(async () => {
  await i18n.changeLanguage('en');
});

test('right to left the archive reads its paths left to right, and its titles and ages in Hebrew', async () => {
  await i18n.changeLanguage('he');
  const { container } = renderContent(i18n.getFixedT('he', 'sidebar') as TFunction, 'archived');

  const paths = [...container.querySelectorAll('p[title^="/home/u/"]')];
  assert.deepEqual(paths.map((path) => path.textContent), ['/home/u/demo-app', '/home/u/other']);
  assert.deepEqual(paths.map((path) => path.classList.contains('bidi-ltr')), [true, true]);

  const titles = [...container.querySelectorAll('p.bidi-auto')].map((title) => stripBidiIsolates(title.textContent ?? ''));
  assert.deepEqual(titles, ['סשן Claude ללא שם', 'סשן Codex ללא שם']);
  assert.equal(container.textContent?.includes('3 שע׳'), true);
  assert.equal(container.textContent?.includes('3hr'), false);

  const count = container.querySelector('span[title]');
  assert.equal(count?.textContent, '2/5');
  assert.equal(count?.getAttribute('title'), '2 מתוך 5');
});

test('right to left a search excerpt and the titles follow their own first letter', async () => {
  await i18n.changeLanguage('he');
  const { container } = renderContent(i18n.getFixedT('he', 'sidebar') as TFunction, 'conversations');

  const excerpt = container.querySelector('mark')?.parentElement;
  assert.equal(excerpt?.textContent, 'Keep checking the deploy every 10 minutes.');
  assert.equal(excerpt?.getAttribute('dir'), 'auto');

  const titles = [...container.querySelectorAll('span.bidi-auto')].map((title) => stripBidiIsolates(title.textContent ?? ''));
  assert.deepEqual(titles, ['סשן Claude ללא שם', 'demo-app', 'demo-app', 'Check the deploy']);
});

test('English keeps its archive', async () => {
  const { container } = renderContent(i18n.getFixedT('en', 'sidebar') as TFunction, 'archived');

  assert.equal(container.textContent?.includes('Untitled Claude Session'), true);
  assert.equal(container.textContent?.includes('3hr'), true);
  assert.equal(container.querySelector('span[title]')?.getAttribute('title'), '2 of 5');
});

test('the search in progress counts the projects it has scanned in one sentence of the interface language', () => {
  const progressText = (language: string, scannedProjects = 3, totalProjects = 5) => {
    const { container, unmount } = renderContent(i18n.getFixedT(language, 'sidebar') as TFunction, 'conversations', {
      conversationResults: null,
      isSearching: true,
      searchProgress: { scannedProjects, totalProjects },
    });
    const text = container.querySelector('p.mt-1')?.textContent ?? '';
    unmount();
    return stripBidiIsolates(text);
  };

  assert.equal(progressText('en'), '3 of 5 projects scanned');
  assert.equal(progressText('zh-CN'), '已扫描 3/5 个项目');
  assert.equal(progressText('he'), 'נסרקו 3 מתוך 5 פרויקטים');
  // The noun follows the total.
  assert.equal(progressText('en', 0, 1), '0 of 1 project scanned');
  assert.equal(progressText('he', 1, 2), 'נסרקו 1 מתוך 2 פרויקטים');
});
