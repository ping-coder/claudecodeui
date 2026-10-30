import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { test, vi } from 'vitest';

import { useRefreshSignal } from '@/shared/hooks/useRefreshSignal';

/**
 * A view reloads when the workspace's refresh token moves, never when it mounts: a view that mounts after
 * a refresh already loads fresh data. The callback of the latest render runs.
 */

test('never fires on mount, StrictMode\'s second run included, and fires once per token change', () => {
  const calls: number[] = [];
  const { rerender } = renderHook(
    ({ token }: { token: number }) => useRefreshSignal(token, () => calls.push(token)),
    { initialProps: { token: 3 }, wrapper: StrictMode },
  );
  assert.deepEqual(calls, []);

  rerender({ token: 3 });
  assert.deepEqual(calls, [], 'a render with the same token is no refresh');
  rerender({ token: 4 });
  rerender({ token: 5 });
  assert.deepEqual(calls, [4, 5]);
});

test('runs the callback of the latest render', () => {
  const first = vi.fn();
  const latest = vi.fn();
  const { rerender } = renderHook(
    ({ token, onRefresh }: { token: number; onRefresh: () => void }) => useRefreshSignal(token, onRefresh),
    { initialProps: { token: 0, onRefresh: first } },
  );

  rerender({ token: 1, onRefresh: latest });
  assert.equal(first.mock.calls.length, 0);
  assert.equal(latest.mock.calls.length, 1);
});

test('no token is no signal', () => {
  const onRefresh = vi.fn();
  const { rerender } = renderHook(
    ({ token }: { token: number | undefined }) => useRefreshSignal(token, onRefresh),
    { initialProps: { token: undefined as number | undefined } },
  );

  rerender({ token: undefined });
  assert.equal(onRefresh.mock.calls.length, 0);
  rerender({ token: 1 });
  assert.equal(onRefresh.mock.calls.length, 1);
  rerender({ token: undefined });
  assert.equal(onRefresh.mock.calls.length, 1, 'losing the token refreshes nothing');
});
