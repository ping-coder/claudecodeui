import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * A project of more than 10,000 entries cannot be listed, so the palette asks the server to
 * search it: once per pause in typing, with the search as typed, aborting the request of a search
 * that was typed over. The answer of the last search stays until the next lands, never across
 * projects.
 */

const ROOT = '/home/u/monorepo';

type SearchCall = { projectId: string; query: string; limit: number; signal: AbortSignal | undefined };

const server = vi.hoisted(() => ({
  calls: [] as SearchCall[],
  answer: null as null | ((call: SearchCall) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>),
}));

vi.mock('@/shared/api', () => ({
  api: {
    searchFiles: (projectId: string, query: string, limit: number, options: { signal?: AbortSignal } = {}) => {
      const call = { projectId, query, limit, signal: options.signal };
      server.calls.push(call);
      return server.answer?.(call) ?? new Promise(() => undefined);
    },
  },
}));

const { useFileSearch } = await import('@/modules/command-palette/hooks/useFileSearch');

const fileAt = (relativePath: string, isIgnored = false) => ({
  path: `${ROOT}/${relativePath}`,
  name: relativePath.split('/').pop() ?? relativePath,
  relativePath,
  isIgnored,
});

const answerWith = (files: unknown[], incomplete = false) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ files, totalMatches: files.length, incomplete }),
});

type HookProps = { projectId: string | undefined; search: string; enabled: boolean };

const renderSearch = (initialProps: HookProps) => renderHook(
  ({ projectId, search, enabled }: HookProps) => useFileSearch(projectId, search, enabled, 100),
  { initialProps },
);

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const relativePaths = (files: Array<{ relativePath: string }>) => files.map((file) => file.relativePath).join(', ');

beforeEach(() => {
  vi.useFakeTimers();
  server.calls = [];
  server.answer = null;
});

afterEach(() => {
  vi.useRealTimers();
});

test('a burst of keystrokes sends one search, as typed, once the typing rests', async () => {
  server.answer = answerWith([fileAt('src/Button.tsx'), fileAt('.env.local', true)]);
  const { result, rerender } = renderSearch({ projectId: 'project-1', search: 'b', enabled: true });
  assert.equal(result.current.status, 'pending');

  rerender({ projectId: 'project-1', search: 'bu', enabled: true });
  await advance(100);
  rerender({ projectId: 'project-1', search: 'but ', enabled: true });
  await advance(200);
  assert.equal(server.calls.length, 0, 'still typing');
  assert.equal(result.current.status, 'pending');

  await advance(100);

  assert.deepEqual(
    server.calls.map(({ projectId, query, limit }) => ({ projectId, query, limit })),
    [{ projectId: 'project-1', query: 'but ', limit: 100 }],
  );
  assert.equal(result.current.status, 'done');
  assert.equal(relativePaths(result.current.files), 'src/Button.tsx, .env.local');
  assert.deepEqual(result.current.files[1], fileAt('.env.local', true));
  assert.equal(result.current.incomplete, false);
});

test('an incomplete answer says so', async () => {
  server.answer = answerWith([fileAt('README.md')], true);
  const { result } = renderSearch({ projectId: 'project-1', search: 'readme', enabled: true });

  await advance(300);

  assert.equal(result.current.status, 'done');
  assert.equal(result.current.incomplete, true);
});

test('a search typed over aborts its request, and its late answer is not shown', async () => {
  const answers: Array<() => void> = [];
  server.answer = (call) => new Promise((resolve) => {
    answers.push(() => resolve({
      ok: true,
      status: 200,
      json: async () => ({ files: [fileAt(`${call.query}.md`)], incomplete: false }),
    }));
  });
  const { result, rerender } = renderSearch({ projectId: 'project-1', search: 'first', enabled: true });
  await advance(300);
  assert.equal(server.calls.length, 1);

  rerender({ projectId: 'project-1', search: 'second', enabled: true });
  assert.equal(server.calls[0]?.signal?.aborted, true);
  await advance(300);
  await act(async () => {
    answers[0]?.();
  });
  assert.equal(result.current.files.length, 0, 'the first answer came too late');

  await act(async () => {
    answers[1]?.();
  });
  assert.equal(relativePaths(result.current.files), 'second.md');
  assert.equal(result.current.status, 'done');
});

test('the last answer stays while the next search runs, but not into another project', async () => {
  server.answer = answerWith([fileAt('src/Button.tsx')]);
  const { result, rerender } = renderSearch({ projectId: 'project-1', search: 'butt', enabled: true });
  await advance(300);

  server.answer = null;
  rerender({ projectId: 'project-1', search: 'butto', enabled: true });
  assert.equal(result.current.status, 'pending');
  assert.equal(relativePaths(result.current.files), 'src/Button.tsx', 'narrowed by the palette meanwhile');

  rerender({ projectId: 'project-2', search: 'butto', enabled: true });
  assert.equal(result.current.status, 'pending');
  assert.equal(result.current.files.length, 0);
});

test('a failed search reports itself and lists nothing', async () => {
  server.answer = async () => ({ ok: false, status: 404, json: async () => ({ error: 'Not found' }) });
  const { result } = renderSearch({ projectId: 'project-1', search: 'readme', enabled: true });

  await advance(300);

  assert.equal(result.current.status, 'failed');
  assert.equal(result.current.files.length, 0);
});

test('nothing is searched while disabled, without a project, or for a blank search', async () => {
  const { result, rerender } = renderSearch({ projectId: 'project-1', search: 'readme', enabled: false });
  await advance(300);
  assert.equal(result.current.status, 'idle');

  rerender({ projectId: undefined, search: 'readme', enabled: true });
  await advance(300);
  assert.equal(result.current.status, 'idle');

  rerender({ projectId: 'project-1', search: '   ', enabled: true });
  await advance(300);
  assert.equal(result.current.status, 'idle');

  assert.equal(server.calls.length, 0);
});
