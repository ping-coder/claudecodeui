import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import type { Project } from '@/shared/types';

/**
 * Screen readers name the palette's result list in the interface language. Left unnamed, cmdk
 * calls it "Suggestions" in every language.
 */

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ toggleDarkMode: () => undefined }),
}));
vi.mock('@/modules/command-palette/hooks/useSessionsSource', () => ({ useSessionsSource: () => [] }));
vi.mock('@/modules/command-palette/hooks/useSessionMessageSearch', () => ({ useSessionMessageSearch: () => [] }));
vi.mock('@/modules/command-palette/hooks/useFilesSource', () => ({ useFilesSource: () => ({ files: [], tooLarge: false }) }));
vi.mock('@/modules/command-palette/hooks/useCommitsSource', () => ({ useCommitsSource: () => [] }));
vi.mock('@/modules/command-palette/hooks/useBranchesSource', () => ({ useBranchesSource: () => [] }));
vi.mock('@/modules/command-palette/hooks/useGitActions', () => ({
  useGitActions: () => ({
    fetch: async () => undefined,
    pull: async () => undefined,
    push: async () => undefined,
    checkout: async () => undefined,
  }),
}));

const { default: CommandPalette } = await import('@/modules/command-palette/CommandPalette');

const project: Project = { projectId: 'project-1', displayName: 'repo', fullPath: '/repo', path: '/repo', sessions: [] };

const scrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  // jsdom ships no ResizeObserver or scrollIntoView, which cmdk's list uses.
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  Element.prototype.scrollIntoView = scrollIntoView;
  await i18n.changeLanguage('en');
});

const listLabels = () => {
  render(
    <CommandPalette
      selectedProject={project}
      onStartNewChat={() => undefined}
      onOpenSettings={() => undefined}
      onShowTab={() => undefined}
      onOpenSession={() => undefined}
    />,
  );
  act(() => {
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
  });
  assert.equal(screen.queryByRole('dialog') !== null, true);
  return [...document.querySelectorAll('[cmdk-list]')].map((list) => list.getAttribute('aria-label') ?? '');
};

test('the result list is named in Chinese', async () => {
  await i18n.changeLanguage('zh-CN');
  assert.deepEqual(listLabels(), ['命令面板']);
});

test('the result list is named in Hebrew', async () => {
  await i18n.changeLanguage('he');
  assert.deepEqual(listLabels(), ['לוח הפקודות']);
});

test('the result list is named in English, not "Suggestions"', () => {
  assert.deepEqual(listLabels(), ['Command palette']);
});
