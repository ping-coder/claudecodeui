import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { beforeEach, test, vi } from 'vitest';

import { ESCAPE_LAYER_SELECTOR } from '@/shared/constants';
import type { PendingSidebarDeletion, Project } from '@/shared/types';

/**
 * The sidebar's delete confirmations own Escape while they are open: they carry
 * the app's Escape-layer marker, so the layers underneath (the code editor, the
 * immersive sidebar drawer, the workspace shortcuts) leave the key to them, and
 * Escape cancels them before the chat's abort can hear it.
 */

vi.mock('@/modules/settings', () => ({ Settings: () => null }));
vi.mock('@/modules/version-upgrade', () => ({ VersionUpgradeModal: () => null }));
vi.mock('@/modules/project-creation-wizard', () => ({ ProjectCreationWizard: () => null }));

const { default: SidebarModals } = await import('@/modules/sidebar/SidebarModals');

const t = ((key: string) => key) as unknown as TFunction;
const noop = () => {};
const onCancelDeletion = vi.fn();

const PROJECT = { projectId: 'p1', name: 'p1', displayName: 'project one', fullPath: '/repo' } as unknown as Project;
const PENDING: PendingSidebarDeletion[] = [
  { kind: 'project', project: PROJECT, sessionCount: 2 },
  { kind: 'session', sessionId: 's1', sessionTitle: 'session one', isArchived: false },
  { kind: 'sessions', sessionIds: ['s1', 's2'] },
];

const renderModals = (pendingDeletion: PendingSidebarDeletion | null) => render(
  <SidebarModals
    projects={[PROJECT]}
    showSettings={false}
    settingsInitialTab="agents"
    onCloseSettings={noop}
    showNewProject={false}
    onCloseNewProject={noop}
    onProjectCreated={noop}
    pendingDeletion={pendingDeletion}
    // A new callback every render, as the sidebar hands it over.
    onCancelDeletion={() => onCancelDeletion()}
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

/** Escape as the page receives it, and whether it travelled on to the document, where the chat's abort listens. */
const pressEscape = () => {
  const documentListener = vi.fn();
  document.addEventListener('keydown', documentListener, true);
  const notPrevented = fireEvent.keyDown(document.body, { key: 'Escape' });
  document.removeEventListener('keydown', documentListener, true);
  return { prevented: !notPrevented, reachedDocument: documentListener.mock.calls.length > 0 };
};

beforeEach(() => {
  onCancelDeletion.mockReset();
});

test('each delete confirmation marks itself as an Escape layer', () => {
  for (const pendingDeletion of PENDING) {
    const { unmount } = renderModals(pendingDeletion);
    assert.equal(document.querySelectorAll(ESCAPE_LAYER_SELECTOR).length, 1, pendingDeletion.kind);
    unmount();
  }
  renderModals(null);
  assert.equal(document.querySelectorAll(ESCAPE_LAYER_SELECTOR).length, 0, 'none while nothing is pending');
});

test('Escape cancels a delete confirmation before the chat\'s abort can hear it', () => {
  for (const pendingDeletion of PENDING) {
    onCancelDeletion.mockReset();
    const { rerender, unmount } = renderModals(pendingDeletion);
    // Re-rendered with a fresh callback, the listener still cancels exactly once.
    rerender(
      <SidebarModals
        projects={[PROJECT]}
        showSettings={false}
        settingsInitialTab="agents"
        onCloseSettings={noop}
        showNewProject={false}
        onCloseNewProject={noop}
        onProjectCreated={noop}
        pendingDeletion={pendingDeletion}
        onCancelDeletion={() => onCancelDeletion()}
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

    const escape = pressEscape();

    assert.equal(onCancelDeletion.mock.calls.length, 1, pendingDeletion.kind);
    assert.equal(escape.prevented, true, pendingDeletion.kind);
    assert.equal(escape.reachedDocument, false, `${pendingDeletion.kind}: stopped in the window capture phase`);
    unmount();
  }
});

test('without a confirmation open, Escape is not the sidebar\'s to take', () => {
  renderModals(null);

  const escape = pressEscape();

  assert.equal(onCancelDeletion.mock.calls.length, 0);
  assert.equal(escape.prevented, false);
  assert.equal(escape.reachedDocument, true);
});
