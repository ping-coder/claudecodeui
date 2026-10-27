import assert from 'node:assert/strict';

import { afterEach, test } from 'vitest';

import type { UntitledPaneTabLabels, WorkspaceSessionTab } from '@/shared/types';
import { focusWorkspacePaneElement, resolvePaneTabTitle } from '@/shared/utils';

/**
 * Pane helpers the tab bar, the command palette and the pane shortcuts share: the label a tab
 * shows, and where DOM focus lands when a pane takes over. Focus checks compare booleans, never
 * DOM nodes: a failing node:assert comparison of jsdom nodes walks the whole document.
 */

const LABELS: UntitledPaneTabLabels = { newChat: 'New chat', missing: 'This conversation no longer exists' };

const makeTab = (overrides: Partial<WorkspaceSessionTab> = {}): WorkspaceSessionTab => ({
  key: 'tab-1',
  sessionId: 'session-1',
  projectId: 'alpha',
  provider: 'claude',
  title: 'Snapshot title',
  view: 'chat',
  isPreview: false,
  session: null,
  ...overrides,
});

afterEach(() => {
  document.body.innerHTML = '';
});

test('a draft is always the new chat, whatever titles are around', () => {
  assert.equal(resolvePaneTabTitle(makeTab({ sessionId: null }), 'Live title', LABELS), 'New chat');
});

test('the live title wins over the snapshot, which wins over the placeholders', () => {
  assert.equal(resolvePaneTabTitle(makeTab(), 'Live title', LABELS), 'Live title');
  assert.equal(resolvePaneTabTitle(makeTab(), undefined, LABELS), 'Snapshot title');
  assert.equal(resolvePaneTabTitle(makeTab(), null, LABELS), 'Snapshot title');
  assert.equal(resolvePaneTabTitle(makeTab(), '', LABELS), 'Snapshot title');
});

test('without any title a missing session says so and others get the generic session title', () => {
  assert.equal(resolvePaneTabTitle(makeTab({ title: '', isMissing: true }), undefined, LABELS), LABELS.missing);
  assert.equal(resolvePaneTabTitle(makeTab({ title: '' }), undefined, LABELS), 'New Session');
  assert.equal(resolvePaneTabTitle(makeTab({ title: '', provider: 'cursor' }), undefined, LABELS), 'Untitled Session');
  assert.equal(
    resolvePaneTabTitle(makeTab({ title: '', session: { id: 'session-1', summary: 'From the session object' } }), undefined, LABELS),
    'From the session object',
  );
});

const renderPanes = () => {
  document.body.innerHTML = `
    <div data-workspace-pane="left" tabindex="-1">
      <button type="button" data-test="inside">inside</button>
      <textarea data-slot="prompt-input-textarea"></textarea>
    </div>
    <div data-workspace-pane="right" tabindex="-1"></div>
    <button type="button" data-test="outside">outside</button>
  `;
  const select = (selector: string) => document.querySelector<HTMLElement>(selector) as HTMLElement;
  return {
    leftPane: select('[data-workspace-pane="left"]'),
    leftComposer: select('[data-workspace-pane="left"] textarea'),
    insideButton: select('[data-test="inside"]'),
    rightPane: select('[data-workspace-pane="right"]'),
    outsideButton: select('[data-test="outside"]'),
  };
};

test('focus lands in the composer on the Chat view and on the pane root elsewhere', () => {
  const { leftPane, leftComposer, rightPane, outsideButton } = renderPanes();

  outsideButton.focus();
  focusWorkspacePaneElement('left', 'chat');
  assert.equal(document.activeElement === leftComposer, true);

  focusWorkspacePaneElement('left', 'files');
  assert.equal(document.activeElement === leftPane, true);

  // A Chat view without a composer on the page (an empty pane, a missing session) takes the pane root.
  focusWorkspacePaneElement('right', 'chat');
  assert.equal(document.activeElement === rightPane, true);
});

test('keepFocusInside leaves focus that is already inside the pane alone; by default it moves', () => {
  const { leftComposer, insideButton, outsideButton } = renderPanes();

  insideButton.focus();
  focusWorkspacePaneElement('left', 'chat', { keepFocusInside: true });
  assert.equal(document.activeElement === insideButton, true);

  outsideButton.focus();
  focusWorkspacePaneElement('left', 'chat', { keepFocusInside: true });
  assert.equal(document.activeElement === leftComposer, true);

  insideButton.focus();
  focusWorkspacePaneElement('left', 'chat');
  assert.equal(document.activeElement === leftComposer, true);
});

test('a pane that is not on the page leaves focus where it is', () => {
  const { outsideButton } = renderPanes();
  document.querySelector('[data-workspace-pane="right"]')?.remove();

  outsideButton.focus();
  focusWorkspacePaneElement('right', 'chat');
  assert.equal(document.activeElement === outsideButton, true);
});
