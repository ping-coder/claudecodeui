import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import {
  cloneWorkspaceWithProgress,
  createProjectRequest,
  fetchProjectTemplates,
} from '@/modules/project-creation-wizard/utils/workspaceApi';
import type { ProjectTemplateReport } from '@/shared/types';

/**
 * A stand-in for the browser's EventSource: records the URL it was opened
 * with and lets a test push server events through `onmessage`.
 */
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

type RecordedRequest = { url: string; init?: RequestInit };

const requests: RecordedRequest[] = [];

const respondToStart = (status: number, body: Record<string, unknown>) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }));
};

const cloneParams = {
  workspacePath: '/workspace/root',
  githubUrl: 'https://github.com/example/repo.git',
  tokenMode: 'new' as const,
  selectedGithubToken: '',
  newGithubToken: 'ghp_supersecrettoken1234567890abcd',
};

beforeEach(() => {
  localStorage.clear();
  requests.length = 0;
  FakeEventSource.opened.length = 0;
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('cloneWorkspaceWithProgress posts the token in a body and opens the stream with only the clone id', async () => {
  respondToStart(200, { cloneId: 'clone-123' });
  const progress: string[] = [];

  const pending = cloneWorkspaceWithProgress(cloneParams, {
    onProgress: (message) => {
      progress.push(message);
    },
  });

  // The stream can only be opened once the POST has answered with an id.
  await vi.waitFor(() => assert.equal(FakeEventSource.opened.length, 1));

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, '/api/projects/clone');
  assert.equal(requests[0]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    path: '/workspace/root',
    githubUrl: 'https://github.com/example/repo.git',
    githubTokenId: null,
    newGithubToken: 'ghp_supersecrettoken1234567890abcd',
  });

  const stream = FakeEventSource.opened[0]!;
  assert.equal(stream.url, '/api/projects/clone-progress?cloneId=clone-123');
  assert.ok(!stream.url.includes(cloneParams.newGithubToken), `token leaked into the stream URL: ${stream.url}`);

  stream.emit({ type: 'progress', message: 'Receiving objects: 100% (20/20), done.' });
  stream.emit({ type: 'complete', project: { projectId: 'project-1' } });

  assert.deepEqual((await pending).project, { projectId: 'project-1' });
  assert.deepEqual(progress, ['Receiving objects: 100% (20/20), done.']);
  assert.equal(stream.closed, true);
});

test('cloneWorkspaceWithProgress sends a stored token selection as its numeric id', async () => {
  respondToStart(200, { cloneId: 'clone-123' });

  const pending = cloneWorkspaceWithProgress(
    { ...cloneParams, tokenMode: 'stored', selectedGithubToken: '12', newGithubToken: '' },
    { onProgress: () => undefined },
  );
  await vi.waitFor(() => assert.equal(FakeEventSource.opened.length, 1));

  const body = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
  assert.equal(body.githubTokenId, 12);
  assert.equal(body.newGithubToken, null);

  FakeEventSource.opened[0]!.emit({ type: 'complete', project: {} });
  await pending;
});

test('cloneWorkspaceWithProgress rejects with the server error and never opens a stream when the POST fails', async () => {
  respondToStart(400, { success: false, error: { code: 'INVALID', message: 'Invalid githubUrl' } });

  await assert.rejects(
    cloneWorkspaceWithProgress(cloneParams, { onProgress: () => undefined }),
    { message: 'Invalid githubUrl' },
  );
  assert.equal(FakeEventSource.opened.length, 0);
});

const REPORT: ProjectTemplateReport = {
  templateId: 'coding',
  created: ['TASKS.md'],
  skipped: [{ path: 'CLAUDE.md', reason: 'exists' }],
  git: { action: 'cloned', committed: false },
  warnings: [],
};

test('cloneWorkspaceWithProgress sends the template and locale, and hands the template event over before complete', async () => {
  respondToStart(200, { cloneId: 'clone-123' });
  const reports: ProjectTemplateReport[] = [];
  const progress: string[] = [];
  let templatePhases = 0;

  const pending = cloneWorkspaceWithProgress(
    { ...cloneParams, templateId: 'coding', locale: 'zh-CN' },
    {
      onProgress: (message) => progress.push(message),
      onTemplatePhase: () => {
        templatePhases += 1;
      },
      onTemplate: (report) => reports.push(report),
    },
  );
  await vi.waitFor(() => assert.equal(FakeEventSource.opened.length, 1));

  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    path: '/workspace/root',
    githubUrl: 'https://github.com/example/repo.git',
    githubTokenId: null,
    newGithubToken: 'ghp_supersecrettoken1234567890abcd',
    templateId: 'coding',
    locale: 'zh-CN',
  });

  const stream = FakeEventSource.opened[0]!;
  // The template step's progress line is the server's English; the wizard shows its own words instead.
  stream.emit({ type: 'progress', message: 'Adding template files...', phase: 'template' });
  assert.equal(templatePhases, 1);
  assert.deepEqual(progress, []);

  stream.emit({ type: 'template', report: REPORT });
  assert.deepEqual(reports, [REPORT]);
  assert.equal(stream.closed, false, 'the stream stays open until complete');

  // A complete without its own copy still resolves with the report the template event carried.
  stream.emit({ type: 'complete', project: { projectId: 'project-1' } });
  const result = await pending;
  assert.deepEqual(result.project, { projectId: 'project-1' });
  assert.deepEqual(result.template, REPORT);
});

test('cloneWorkspaceWithProgress prefers the report the complete event carries', async () => {
  respondToStart(200, { cloneId: 'clone-123' });

  const pending = cloneWorkspaceWithProgress(
    { ...cloneParams, templateId: 'coding', locale: 'en' },
    { onProgress: () => undefined },
  );
  await vi.waitFor(() => assert.equal(FakeEventSource.opened.length, 1));

  const finalReport = { ...REPORT, skipped: [] };
  FakeEventSource.opened[0]!.emit({ type: 'template', report: REPORT });
  FakeEventSource.opened[0]!.emit({ type: 'complete', project: {}, template: finalReport });

  assert.deepEqual((await pending).template, finalReport);
});

test('createProjectRequest sends only the path for Blank, as before templates', async () => {
  respondToStart(200, { success: true, project: { projectId: 'project-1' } });

  const result = await createProjectRequest({ path: '/workspace/new' });

  assert.equal(requests[0]?.url, '/api/projects/create-project');
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), { path: '/workspace/new' });
  assert.deepEqual(result.project, { projectId: 'project-1' });
  assert.equal(result.template, undefined);
});

test('createProjectRequest sends the template, git mode and locale, and returns the report beside the project', async () => {
  respondToStart(200, { success: true, project: { projectId: 'project-1' }, template: REPORT });

  const result = await createProjectRequest({ path: '/workspace/new', templateId: 'coding', git: 'init', locale: 'he' });

  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    path: '/workspace/new',
    templateId: 'coding',
    git: 'init',
    locale: 'he',
  });
  assert.deepEqual(result, { project: { projectId: 'project-1' }, template: REPORT });
});

test('createProjectRequest keeps the server error code for the wizard to localize', async () => {
  respondToStart(400, { success: false, error: { code: 'UNKNOWN_PROJECT_TEMPLATE', message: 'Unknown project template' } });

  await assert.rejects(
    createProjectRequest({ path: '/workspace/new', templateId: 'gone', git: 'init', locale: 'en' }),
    { message: 'Unknown project template', code: 'UNKNOWN_PROJECT_TEMPLATE' },
  );
});

test('fetchProjectTemplates reads the list from the success envelope and throws when there is none', async () => {
  const templates = [
    { id: 'blank', files: [], skills: [], git: { init: false, clone: true } },
    { id: 'coding', files: ['TASKS.md'], skills: ['task-runner'], git: { init: true, clone: true } },
  ];
  respondToStart(200, { success: true, data: { templates } });

  assert.deepEqual(await fetchProjectTemplates(), templates);
  assert.equal(requests[0]?.url, '/api/projects/templates');

  respondToStart(500, { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  await assert.rejects(fetchProjectTemplates(), { message: 'Internal server error' });
});
