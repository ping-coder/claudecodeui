import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import type { ProjectTemplateReport, ProjectTemplateSummary } from '@/shared/types';

/**
 * The project wizard's three steps: Template, Configure, Confirm. Blank behaves as the wizard did
 * before templates; Coding chooses between a new repository (no URL) and a GitHub import (URL
 * required); the folder browser can jump to Confirm; a creation that skipped files or warned stays
 * open on a result view; the last template picked is remembered. The server is a stubbed fetch and
 * EventSource.
 */

// The real field debounces folder lookups and opens a browser that never jumps to Confirm by itself
// (autoAdvanceOnSelect is off); the stub types the path and can pick a folder and jump.
vi.mock('@/modules/project-creation-wizard/WorkspacePathField', () => ({
  default: ({
    value,
    onChange,
    onAdvanceToConfirm,
  }: {
    value: string;
    onChange: (path: string) => void;
    onAdvanceToConfirm: () => void;
  }) => (
    <div>
      <input aria-label="Workspace path" value={value} onChange={(event) => onChange(event.target.value)} />
      <button
        type="button"
        onClick={() => {
          onChange('/picked/folder');
          onAdvanceToConfirm();
        }}
      >
        Pick folder and confirm
      </button>
    </div>
  ),
}));

const { default: ProjectCreationWizard } = await import('@/modules/project-creation-wizard/ProjectCreationWizard');

class FakeEventSource {
  static opened: FakeEventSource[] = [];

  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.opened.push(this);
  }

  close() {
    this.closed = true;
  }

  emit(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

const TEMPLATES: ProjectTemplateSummary[] = [
  { id: 'blank', files: [], skills: [], git: { init: false, clone: true } },
  {
    id: 'coding',
    files: ['TASKS.md', 'CLAUDE.md', '.gitignore', '.claude/skills/task-runner/SKILL.md', '.claude/skills/issue/SKILL.md'],
    skills: ['task-runner', 'issue'],
    git: { init: true, clone: true },
  },
];

const cleanReport = (overrides: Partial<ProjectTemplateReport> = {}): ProjectTemplateReport => ({
  templateId: 'coding',
  created: ['TASKS.md', 'CLAUDE.md'],
  skipped: [],
  git: { action: 'initialized', committed: true, commitSha: 'abc1234' },
  warnings: [],
  ...overrides,
});

type RouteReply = { status: number; body: unknown };
const routes = new Map<string, () => RouteReply | Promise<RouteReply>>();
const requests: Array<{ url: string; body: unknown }> = [];

const bodyOf = (url: string) => requests.find((request) => request.url === url)?.body;

beforeEach(() => {
  localStorage.clear();
  requests.length = 0;
  routes.clear();
  FakeEventSource.opened.length = 0;
  routes.set('/api/projects/templates', () => ({ status: 200, body: { success: true, data: { templates: TEMPLATES } } }));
  routes.set('/api/settings/credentials', () => ({ status: 200, body: { credentials: [] } }));
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split('?')[0];
    requests.push({ url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes.get(path);
    const { status, body } = route ? await route() : { status: 404, body: {} };
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const renderWizard = () => {
  const onClose = vi.fn();
  const onProjectCreated = vi.fn();
  const view = render(<ProjectCreationWizard onClose={onClose} onProjectCreated={onProjectCreated} />);
  return { ...view, onClose, onProjectCreated };
};

const templateCard = (title: string) => screen.getByRole('button', { name: new RegExp(`^${title}`) });
const isPressed = (title: string) => templateCard(title).getAttribute('aria-pressed') === 'true';
const waitForTemplates = () => waitFor(() => assert.equal(screen.queryByText('Loading templates…') === null, true));
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const typePath = (path: string) => fireEvent.change(screen.getByLabelText('Workspace path'), { target: { value: path } });
const isOnTemplateStep = () => screen.queryByText('Start from a template') !== null;
const isOnConfigureStep = () => screen.queryByLabelText('Workspace path') !== null;
const isOnConfirmStep = () => screen.queryByText('Review Your Configuration') !== null;

test('walks Template, Configure and Confirm forward and back, and Blank creates with only the path', async () => {
  const { onClose, onProjectCreated } = renderWizard();
  routes.set('/api/projects/create-project', () => ({ status: 200, body: { success: true, project: { projectId: 'p1' } } }));

  assert.equal(screen.queryByText('Template') !== null, true);
  assert.equal(screen.queryByText('Configure') !== null, true);
  assert.equal(screen.queryByText('Confirm') !== null, true);
  await waitForTemplates();
  assert.equal(isOnTemplateStep(), true);
  assert.equal(isPressed('Blank'), true, 'the first run starts on Blank');

  click(/^Next/);
  assert.equal(isOnConfigureStep(), true);
  click(/^Back/);
  assert.equal(isOnTemplateStep(), true);

  click(/^Next/);
  click(/^Next/);
  assert.equal(screen.queryByText('Please provide a workspace path') !== null, true);
  assert.equal(isOnConfigureStep(), true);

  typePath('/work/new-project');
  click(/^Next/);
  assert.equal(isOnConfirmStep(), true);
  click(/^Back/);
  assert.equal(isOnConfigureStep(), true);
  click(/^Next/);

  click(/Create Project/);
  await waitFor(() => assert.equal(onClose.mock.calls.length, 1));
  assert.deepEqual(bodyOf('/api/projects/create-project'), { path: '/work/new-project' });
  assert.deepEqual(onProjectCreated.mock.calls, [[{ projectId: 'p1' }]]);
});

test('Next waits for the template list', async () => {
  let answer: (reply: RouteReply) => void = () => {};
  routes.set('/api/projects/templates', () => new Promise<RouteReply>((resolve) => { answer = resolve; }));
  renderWizard();

  assert.equal((screen.getByRole('button', { name: /^Next/ }) as HTMLButtonElement).disabled, true);

  await act(async () => {
    answer({ status: 200, body: { success: true, data: { templates: TEMPLATES } } });
  });
  await waitForTemplates();
  assert.equal((screen.getByRole('button', { name: /^Next/ }) as HTMLButtonElement).disabled, false);
});

test('Coding with a new repository hides the GitHub URL and creates with git init in the interface language', async () => {
  const { onClose, onProjectCreated } = renderWizard();
  routes.set('/api/projects/create-project', () => ({
    status: 200,
    body: { success: true, project: { projectId: 'p2' }, template: cleanReport() },
  }));
  await waitForTemplates();

  fireEvent.click(templateCard('Coding'));
  assert.equal(isPressed('Coding'), true);
  assert.equal(screen.queryByText('.claude/skills/task-runner/SKILL.md') !== null, true, 'the card lists the files it adds');
  click(/^Next/);

  assert.equal(screen.getByRole('radio', { name: 'New repository' }).getAttribute('aria-checked'), 'true');
  assert.equal(
    screen.queryByText(/If the folder is already a Git repository, the files are added but not committed\./) !== null,
    true,
    'the help says an existing repository gets no init and no commit',
  );
  assert.equal(screen.queryByLabelText('GitHub URL') === null, true);
  assert.equal(screen.queryByLabelText('GitHub URL (Optional)') === null, true);

  typePath('/work/app');
  click(/^Next/);
  assert.equal(
    screen.queryByText('New repository, first commit with the template files (left uncommitted if the folder is already a repository)') !== null,
    true,
  );
  assert.equal(screen.queryByText('task-runner, issue') !== null, true);

  click(/Create Project/);
  await waitFor(() => assert.equal(onClose.mock.calls.length, 1));
  assert.deepEqual(bodyOf('/api/projects/create-project'), {
    path: '/work/app',
    templateId: 'coding',
    git: 'init',
    locale: i18n.language,
  });
  assert.deepEqual(onProjectCreated.mock.calls, [[{ projectId: 'p2' }]]);
});

test('importing from GitHub requires the URL, clones into <path>/<repo> and stays open when files were skipped', async () => {
  const { onClose, onProjectCreated } = renderWizard();
  routes.set('/api/projects/clone', () => ({ status: 200, body: { cloneId: 'clone-1' } }));
  await waitForTemplates();

  fireEvent.click(templateCard('Coding'));
  click(/^Next/);
  fireEvent.click(screen.getByRole('radio', { name: 'Import from GitHub' }));
  assert.equal(
    screen.queryByText(/^Clones the repository into a subfolder named after it, then adds the template files there/) !== null,
    true,
    'the help says the clone lands in <path>/<repo>, not in the folder itself',
  );
  typePath('/work/root');
  click(/^Next/);
  assert.equal(screen.queryByText('Enter the GitHub URL of the repository to import') !== null, true);
  assert.equal(isOnConfigureStep(), true);

  fireEvent.change(screen.getByLabelText('GitHub URL'), { target: { value: 'https://github.com/example/repo.git' } });
  click(/^Next/);
  assert.equal(isOnConfirmStep(), true);
  assert.equal(screen.queryByText('/work/root/repo') !== null, true, 'the final path follows the server rule');
  assert.equal(screen.queryByText('Clone, then add the template files uncommitted') !== null, true);

  click(/Create Project/);
  await waitFor(() => assert.equal(FakeEventSource.opened.length, 1));
  const cloneBody = bodyOf('/api/projects/clone') as Record<string, unknown>;
  assert.equal(cloneBody.templateId, 'coding');
  assert.equal(cloneBody.locale, i18n.language);
  assert.equal(cloneBody.githubUrl, 'https://github.com/example/repo.git');

  const stream = FakeEventSource.opened[0]!;
  act(() => stream.emit({ type: 'progress', message: 'Receiving objects: 100%' }));
  assert.equal(screen.queryByText('Clone the repository') !== null, true);
  assert.equal(screen.queryByText('Add the template files') !== null, true);
  assert.equal(screen.queryByText('Receiving objects: 100%') !== null, true);

  act(() => stream.emit({ type: 'progress', message: 'Adding template files...', phase: 'template' }));
  assert.equal(screen.queryByText('Receiving objects: 100%') === null, true, 'the git output goes once the clone is done');
  assert.equal(screen.queryByText('Adding template files...') === null, true, 'the server text is not shown');
  assert.equal(screen.queryByText('Clone the repository') !== null, true);

  const report = cleanReport({
    created: ['TASKS.md'],
    skipped: [{ path: 'CLAUDE.md', reason: 'exists' }],
    git: { action: 'cloned', committed: false },
  });
  act(() => stream.emit({ type: 'template', report }));
  act(() => stream.emit({ type: 'complete', project: { projectId: 'p3' }, template: report }));

  await waitFor(() => assert.equal(screen.queryByText('Project created') !== null, true));
  assert.equal(onClose.mock.calls.length, 0);
  assert.deepEqual(onProjectCreated.mock.calls, [[{ projectId: 'p3' }]]);
  assert.equal(screen.queryByText('CLAUDE.md') !== null, true);
  assert.equal(screen.queryByText(/already exists/) !== null, true);
  assert.equal(screen.queryByText('The template files are uncommitted in the clone. Review them in Source Control.') !== null, true);

  click(/^Done/);
  assert.equal(onClose.mock.calls.length, 1);
});

test('a warning keeps the wizard open on the result view, in the interface language', async () => {
  const { onClose } = renderWizard();
  routes.set('/api/projects/create-project', () => ({
    status: 200,
    body: {
      success: true,
      project: { projectId: 'p4' },
      template: cleanReport({ git: { action: 'initialized', committed: false }, warnings: ['GIT_IDENTITY_MISSING'] }),
    },
  }));
  await waitForTemplates();

  fireEvent.click(templateCard('Coding'));
  click(/^Next/);
  typePath('/work/app');
  click(/^Next/);
  click(/Create Project/);

  await waitFor(() => assert.equal(screen.queryByText('Warnings') !== null, true));
  assert.equal(screen.queryByText(/Git has no name and email set/) !== null, true);
  assert.equal(screen.queryByText('Created a Git repository. Nothing was committed.') !== null, true);
  assert.equal(screen.queryByRole('button', { name: /Create Project/ }) === null, true);
  assert.equal(onClose.mock.calls.length, 0);

  click(/^Done/);
  assert.equal(onClose.mock.calls.length, 1);
});

test('an unknown template error is shown in the interface language', async () => {
  renderWizard();
  routes.set('/api/projects/create-project', () => ({
    status: 400,
    body: { success: false, error: { code: 'UNKNOWN_PROJECT_TEMPLATE', message: 'Unknown project template' } },
  }));
  await waitForTemplates();

  fireEvent.click(templateCard('Coding'));
  click(/^Next/);
  typePath('/work/app');
  click(/^Next/);
  click(/Create Project/);

  await waitFor(() => assert.equal(
    screen.queryByText('The server no longer offers this template. Go back and pick another one.') !== null,
    true,
  ));
  assert.equal(isOnConfirmStep(), true);
});

test('a template refused at the home folder or workspace root is explained in the interface language', async () => {
  renderWizard();
  routes.set('/api/projects/create-project', () => ({
    status: 400,
    body: { success: false, error: { code: 'TEMPLATE_NOT_ALLOWED_AT_ROOT', message: 'Templates cannot be added to the home folder or the workspace root. Choose a folder inside it.' } },
  }));
  await waitForTemplates();

  fireEvent.click(templateCard('Coding'));
  click(/^Next/);
  typePath('/home/user');
  click(/^Next/);
  click(/Create Project/);

  await waitFor(() => assert.equal(
    screen.queryByText(/Templates can't go straight into the home folder or the workspace root/) !== null,
    true,
  ));
  assert.equal(isOnConfirmStep(), true);
});

test('the folder browser can jump to Confirm, except for an import still missing its URL', async () => {
  renderWizard();
  await waitForTemplates();

  click(/^Next/);
  click('Pick folder and confirm');
  assert.equal(isOnConfirmStep(), true);
  assert.equal(screen.queryByText('/picked/folder') !== null, true);

  click(/^Back/);
  click(/^Back/);
  fireEvent.click(templateCard('Coding'));
  click(/^Next/);
  fireEvent.click(screen.getByRole('radio', { name: 'Import from GitHub' }));
  click('Pick folder and confirm');
  assert.equal(isOnConfigureStep(), true);
  assert.equal(screen.queryByText('Enter the GitHub URL of the repository to import') !== null, true);
});

test('the last template picked is remembered for the next wizard', async () => {
  const first = renderWizard();
  await waitForTemplates();
  fireEvent.click(templateCard('Coding'));
  assert.equal(localStorage.getItem('project-wizard-template'), 'coding');
  first.unmount();

  renderWizard();
  await waitForTemplates();
  assert.equal(isPressed('Coding'), true);
  assert.equal(isPressed('Blank'), false);
});

test('a remembered template the server no longer offers falls back to Blank', async () => {
  localStorage.setItem('project-wizard-template', 'retired');
  renderWizard();
  await waitForTemplates();

  assert.equal(isPressed('Blank'), true);
  click(/^Next/);
  assert.equal(screen.queryByLabelText('GitHub URL (Optional)') !== null, true, 'Blank keeps its optional URL');
});

test('a template list that fails to load leaves only Blank', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  localStorage.setItem('project-wizard-template', 'coding');
  routes.set('/api/projects/templates', () => ({ status: 500, body: { success: false, error: { message: 'boom' } } }));
  renderWizard();
  await waitForTemplates();

  assert.equal(screen.queryByText("Couldn't load the template list, so only Blank is offered.") !== null, true);
  assert.equal(screen.queryByRole('button', { name: /^Coding/ }) === null, true);
  assert.equal(isPressed('Blank'), true);
});
