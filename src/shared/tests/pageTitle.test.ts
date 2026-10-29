import assert from 'node:assert/strict';

import { test } from 'vitest';

import { i18n } from '@/modules/i18n';
import type { Project, ProjectSession } from '@/shared/types';
import { findLiveSessionTitle, getPageTitle, resolveDocumentSessionTitle } from '@/shared/utils';

/** English, as the browser tab read before the session placeholders followed the interface language. */
const en = i18n.getFixedT('en');

const project: Project = {
  projectId: 'project-1',
  displayName: 'My Project',
  fullPath: '/projects/my-project',
};

test('uses the selected session summary as the page title', () => {
  const session: ProjectSession = {
    id: 'session-1',
    summary: 'Fix browser tab title',
    __provider: 'claude',
  };

  assert.equal(getPageTitle(project, session, en), 'Fix browser tab title');
});

test('uses the selected Cursor session name as the page title', () => {
  const session: ProjectSession = {
    id: 'session-1',
    name: 'Cursor session name',
    __provider: 'cursor',
  };

  assert.equal(getPageTitle(project, session, en), 'Cursor session name');
});

test('prefers the persisted summary of a Cursor session, as the sessions API returns it', () => {
  // The sessions API carries every provider's custom name as `summary` and never
  // sets `name`, so a renamed Cursor session must not fall through to the placeholder.
  const session: ProjectSession = {
    id: 'session-1',
    summary: 'Cursor session renamed',
    __provider: 'cursor',
  };

  assert.equal(getPageTitle(project, session, en), 'Cursor session renamed');
  assert.equal(getPageTitle(project, { id: 'session-2', summary: '', __provider: 'cursor' }, en), 'Untitled Session');
});

test('names a session without a title in the interface language', () => {
  const zh = i18n.getFixedT('zh-CN');
  assert.equal(getPageTitle(project, { id: 'session-3', __provider: 'claude' }, zh), '新会话');
  assert.equal(getPageTitle(project, { id: 'session-4', summary: '', __provider: 'cursor' }, zh), '未命名会话');
  assert.equal(getPageTitle(project, { id: 'session-3', __provider: 'claude' }, en), 'New Session');
});

test('falls back to the project title when no session is selected', () => {
  assert.equal(getPageTitle(project, null, en), 'My Project - CloudCLI UI');
});

test('falls back to the app title when no project or session is selected', () => {
  assert.equal(getPageTitle(null, null, en), 'CloudCLI UI');
});

/** Loaded projects as the workspace holds them, one per list of sessions. */
const projectsWithSessions = (sessionsByProject: ProjectSession[][]): Project[] =>
  sessionsByProject.map((sessions, index) => ({
    projectId: `project-${index + 1}`,
    displayName: `Project ${index + 1}`,
    fullPath: `/projects/project-${index + 1}`,
    sessions,
  }));

test('the live session title is the summary, then the name', () => {
  const projects = projectsWithSessions([
    [{ id: 'session-1', summary: 'Renamed session', name: 'Cursor name', __provider: 'cursor' }],
    [{ id: 'session-2', name: 'Cursor name', __provider: 'cursor' }],
  ]);

  assert.equal(findLiveSessionTitle('session-1', projects), 'Renamed session');
  // Found in whichever project lists it, not only the first.
  assert.equal(findLiveSessionTitle('session-2', projects), 'Cursor name');
});

test('the live session title is trimmed, and a blank one counts as missing', () => {
  const projects = projectsWithSessions([[
    { id: 'padded', summary: '  Fix login bug \n', __provider: 'claude' },
    { id: 'blank-summary', summary: '   ', name: ' Cursor name ', __provider: 'cursor' },
    { id: 'blank-both', summary: ' ', name: '\t', __provider: 'cursor' },
    { id: 'untitled', __provider: 'claude' },
  ]]);

  assert.equal(findLiveSessionTitle('padded', projects), 'Fix login bug');
  assert.equal(findLiveSessionTitle('blank-summary', projects), 'Cursor name');
  // No placeholder: the caller falls back to its own next source.
  assert.equal(findLiveSessionTitle('blank-both', projects), null);
  assert.equal(findLiveSessionTitle('untitled', projects), null);
});

test('a session no loaded project lists has no live title', () => {
  const projects: Project[] = [
    { projectId: 'project-1', displayName: 'Not loaded yet', fullPath: '/projects/one' },
    ...projectsWithSessions([[{ id: 'session-1', summary: 'Fix login bug', __provider: 'claude' }]]),
  ];

  assert.equal(findLiveSessionTitle('session-9', projects), null);
  assert.equal(findLiveSessionTitle('session-1', []), null);
});

test('the tab title names a session by its live title, else its tab\'s snapshot, else Untitled session', () => {
  const t = i18n.getFixedT('en', 'common');
  const projects = projectsWithSessions([[
    { id: 'listed', summary: 'Renamed live', __provider: 'claude' },
    { id: 'untitled-cursor', summary: '', __provider: 'cursor' },
  ]]);

  assert.equal(resolveDocumentSessionTitle('listed', projects, 'Opened as', t), 'Renamed live');
  // Not listed: the snapshot of a pane tab holding it, trimmed; a blank one counts as missing.
  assert.equal(resolveDocumentSessionTitle('unlisted', projects, '  Snapshot title \n', t), 'Snapshot title');
  assert.equal(resolveDocumentSessionTitle('unlisted', projects, '   ', t), 'Untitled session');
  assert.equal(resolveDocumentSessionTitle('unlisted', projects, null, t), 'Untitled session');
  // Never getSessionTitle's English provider placeholders ("New Session", Cursor's "Untitled Session").
  assert.equal(resolveDocumentSessionTitle('untitled-cursor', projects, undefined, t), 'Untitled session');
});

test('the Untitled session placeholder follows the language and is read from common whatever namespace t defaults to', () => {
  assert.equal(resolveDocumentSessionTitle('unlisted', [], '', i18n.getFixedT('zh-CN', 'common')), '未命名会话');
  assert.equal(resolveDocumentSessionTitle('unlisted', [], '', i18n.getFixedT('zh-CN', 'settings')), '未命名会话');
  assert.equal(resolveDocumentSessionTitle('unlisted', [], '', i18n.getFixedT('en', 'settings')), 'Untitled session');
});
