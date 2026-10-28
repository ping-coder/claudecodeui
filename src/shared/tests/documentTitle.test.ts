import assert from 'node:assert/strict';

import { beforeEach, test, vi } from 'vitest';

/**
 * The tab title is composed from four parts: the page's own title, outside
 * production the deployment environment label, and two status parts, the
 * running part (project-workspace) and the alert part (run-notifications).
 * A status marker leads, so a narrow tab still shows it; the alert wins over
 * the running part, and either replaces the page title. With no status set
 * the title is what it was before the status parts existed: production comes
 * out exactly as the page set it, so a production tab never changes.
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

test('in production the running part covers the page title and the alert covers both', async () => {
  const {
    setDocumentPageTitle,
    setDocumentTitleActivity,
    setDocumentTitleAlert,
  } = await loadTitleHelpers();
  setDocumentPageTitle('Fix login bug');
  assert.equal(document.title, 'Fix login bug');

  setDocumentTitleActivity({ marker: '[Running 2]', subject: 'Audit deps' });
  assert.equal(document.title, '[Running 2] Audit deps');

  // Switching panes changes the page part, which stays hidden while a run is shown.
  setDocumentPageTitle('Write release notes');
  assert.equal(document.title, '[Running 2] Audit deps');

  setDocumentTitleAlert({ marker: '[Done]', subject: 'Fix login bug' });
  assert.equal(document.title, '[Done] Fix login bug');

  // Each part cleared gives the title back to the next one down.
  setDocumentTitleAlert(null);
  assert.equal(document.title, '[Running 2] Audit deps');

  setDocumentTitleActivity(null);
  assert.equal(document.title, 'Write release notes');

  // The workspace unmounting (sign-out) puts the app name back.
  setDocumentPageTitle(null);
  assert.equal(document.title, 'CloudCLI UI');
});

test('the alert wins over the running part whichever was set first', async () => {
  const { setDocumentPageTitle, setDocumentTitleActivity, setDocumentTitleAlert } = await loadTitleHelpers();
  setDocumentPageTitle('Fix login bug');

  setDocumentTitleAlert({ marker: '[Failed]', subject: 'Deploy staging' });
  setDocumentTitleActivity({ marker: '[Running]', subject: 'Audit deps' });
  assert.equal(document.title, '[Failed] Deploy staging');

  setDocumentTitleActivity(null);
  assert.equal(document.title, '[Failed] Deploy staging');

  setDocumentTitleAlert(null);
  assert.equal(document.title, 'Fix login bug');
});

test('outside production the status marker leads and the label follows it', async () => {
  const {
    setDocumentPageTitle,
    setDocumentTitleActivity,
    setDocumentTitleAlert,
    setDocumentTitleEnvironmentLabel,
  } = await loadTitleHelpers();
  setDocumentPageTitle('Write release notes');
  setDocumentTitleEnvironmentLabel('Stage');
  assert.equal(document.title, 'Stage · Write release notes');

  setDocumentTitleActivity({ marker: '[Running]', subject: 'Audit deps' });
  assert.equal(document.title, '[Running] Stage · Audit deps');

  setDocumentTitleAlert({ marker: '[Done]', subject: 'Fix login bug' });
  assert.equal(document.title, '[Done] Stage · Fix login bug');

  // A language switch swaps only the label; the status parts are set again by their owners.
  setDocumentTitleEnvironmentLabel('预发布');
  assert.equal(document.title, '[Done] 预发布 · Fix login bug');

  setDocumentTitleAlert(null);
  assert.equal(document.title, '[Running] 预发布 · Audit deps');

  setDocumentTitleActivity(null);
  assert.equal(document.title, '预发布 · Write release notes');
});

test('repeating a label or a status leaves the title alone until a part really changes', async () => {
  const {
    setDocumentPageTitle,
    setDocumentTitleActivity,
    setDocumentTitleAlert,
    setDocumentTitleEnvironmentLabel,
  } = await loadTitleHelpers();
  setDocumentPageTitle('Fix browser tab title');
  setDocumentTitleEnvironmentLabel('Stage');
  setDocumentTitleActivity({ marker: '[Running]', subject: 'Audit deps' });

  // A sentinel written straight into the title (a plugin can still do that) shows whether a setter rewrote it.
  document.title = 'sentinel';
  setDocumentTitleEnvironmentLabel('Stage');
  setDocumentTitleActivity({ marker: '[Running]', subject: 'Audit deps' });
  setDocumentTitleAlert(null);
  assert.equal(document.title, 'sentinel');

  setDocumentTitleActivity({ marker: '[Running 2]', subject: 'Audit deps' });
  assert.equal(document.title, '[Running 2] Stage · Audit deps');

  setDocumentTitleAlert({ marker: '[Done]', subject: 'Fix login bug' });
  document.title = 'sentinel';
  setDocumentTitleAlert({ marker: '[Done]', subject: 'Fix login bug' });
  assert.equal(document.title, 'sentinel');

  // A change to a part the title does not show still rewrites it, from all four parts.
  setDocumentTitleActivity(null);
  assert.equal(document.title, '[Done] Stage · Fix login bug');
});

test('a status object changed after it was set is compared by what was applied', async () => {
  const { setDocumentTitleActivity } = await loadTitleHelpers();
  const status = { marker: '[Running]', subject: 'Audit deps' };
  setDocumentTitleActivity(status);

  status.subject = 'Fix login bug';
  setDocumentTitleActivity(status);

  assert.equal(document.title, '[Running] Fix login bug');
});

test('the page part rewrites the title on every call, even unchanged', async () => {
  const { setDocumentPageTitle } = await loadTitleHelpers();
  setDocumentPageTitle('Fix browser tab title');

  document.title = 'sentinel';
  setDocumentPageTitle('Fix browser tab title');

  assert.equal(document.title, 'Fix browser tab title');
});
