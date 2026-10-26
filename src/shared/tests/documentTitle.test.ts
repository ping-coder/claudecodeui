import assert from 'node:assert/strict';

import { beforeEach, test, vi } from 'vitest';

/**
 * The tab title is composed from the page's own title and, outside production,
 * the deployment environment label in front of it. Production must come out
 * exactly as the page set it, so a production tab never changes.
 */

// The title parts live in module state, so every test starts from a fresh module.
const loadTitleHelpers = async () => {
  vi.resetModules();
  return import('@/shared/utils');
};

beforeEach(() => {
  document.title = 'CloudCLI UI';
});

test('in production the page title is written exactly as given', async () => {
  const { setDocumentPageTitle, setDocumentTitleEnvironmentLabel } = await loadTitleHelpers();

  setDocumentPageTitle('Fix browser tab title');
  assert.equal(document.title, 'Fix browser tab title');

  setDocumentTitleEnvironmentLabel(null);
  assert.equal(document.title, 'Fix browser tab title');

  setDocumentPageTitle('My Project - CloudCLI UI');
  assert.equal(document.title, 'My Project - CloudCLI UI');
});

test('outside production the label leads every page title', async () => {
  const { setDocumentPageTitle, setDocumentTitleEnvironmentLabel } = await loadTitleHelpers();

  setDocumentPageTitle('Fix browser tab title');
  setDocumentTitleEnvironmentLabel('Stage');
  assert.equal(document.title, 'Stage · Fix browser tab title');

  setDocumentPageTitle('My Project - CloudCLI UI');
  assert.equal(document.title, 'Stage · My Project - CloudCLI UI');

  // A language switch swaps the label and keeps the page title.
  setDocumentTitleEnvironmentLabel('预发布');
  assert.equal(document.title, '预发布 · My Project - CloudCLI UI');

  setDocumentTitleEnvironmentLabel(null);
  assert.equal(document.title, 'My Project - CloudCLI UI');
});

test('before any page sets a title, the label leads the app name', async () => {
  // The login and setup screens set no page title of their own.
  const { setDocumentTitleEnvironmentLabel } = await loadTitleHelpers();

  setDocumentTitleEnvironmentLabel('Stage');
  assert.equal(document.title, 'Stage · CloudCLI UI');
});

test('repeating the current label leaves the title alone', async () => {
  const { setDocumentPageTitle, setDocumentTitleEnvironmentLabel } = await loadTitleHelpers();
  setDocumentPageTitle('Fix browser tab title');
  setDocumentTitleEnvironmentLabel('Stage');

  // The chat module's completion marker is written straight into the title.
  document.title = `[Done] ${document.title}`;
  setDocumentTitleEnvironmentLabel('Stage');

  assert.equal(document.title, '[Done] Stage · Fix browser tab title');
});
