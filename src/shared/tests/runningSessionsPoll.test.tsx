import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import type * as SharedApi from '@/shared/api';

/**
 * The running-sessions poll is what a refreshed page or a second tab learns a
 * session's background work from. Its task entries must reach the activity
 * map whole — including the `nested` flag that tells a task the session's own
 * turn launched from one its agents launched for themselves — or the pill
 * counts an agent's backgrounded command as a second task of the session's.
 */

const runningSessions = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { runningSessions: () => runningSessions() },
}));

beforeEach(() => {
  vi.resetModules();
  runningSessions.mockReset();
});

test('the poll carries each task through whole, nested flag included', async () => {
  runningSessions.mockResolvedValue({
    ok: true,
    json: async () => ({
      data: {
        sessions: [{
          sessionId: 'held-session',
          provider: 'claude',
          startedAt: 1_700_000_000_000,
          lastSeq: 0,
          background: true,
          canInterrupt: false,
          tasks: [
            { taskId: 'w1', toolUseId: 'toolu_wf', taskType: 'local_workflow', description: 'one agent that waits', workflowName: 'probe', startedAt: 1_700_000_000_000 },
            { taskId: 'b1', toolUseId: 'toolu_inner', taskType: 'local_bash', description: 'Sleep for 60 seconds', startedAt: 1_700_000_001_000, nested: true },
          ],
        }],
      },
    }),
  });

  const { SessionProtectionProvider, useProcessingSessions } = await import('@/shared/context/SessionProtectionContext');
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(SessionProtectionProvider, null, children);
  const { result } = renderHook(() => useProcessingSessions(), { wrapper });

  await waitFor(() => assert.ok(result.current.get('held-session')));
  const activity = result.current.get('held-session');
  assert.equal(activity?.background, true);
  assert.deepEqual(activity?.tasks?.map((task) => [task.taskId, task.nested ?? false]), [['w1', false], ['b1', true]]);
});

test('one task entry in a shape the client does not read hides only itself', async () => {
  // A newer server may list a task kind this client never learned; the
  // session's other work must still show.
  runningSessions.mockResolvedValue({
    ok: true,
    json: async () => ({
      data: {
        sessions: [{
          sessionId: 'held-session',
          provider: 'claude',
          startedAt: 1_700_000_000_000,
          lastSeq: 0,
          background: true,
          canInterrupt: false,
          tasks: [
            { taskId: 'w1', toolUseId: 'toolu_wf', taskType: 'local_workflow', description: 'one agent that waits', startedAt: 1_700_000_000_000 },
            { taskId: 'x1', toolUseId: 'toolu_x', taskType: 'remote_agent', description: 'Unreadable', startedAt: 'yesterday' },
          ],
        }],
      },
    }),
  });

  const { SessionProtectionProvider, useProcessingSessions } = await import('@/shared/context/SessionProtectionContext');
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(SessionProtectionProvider, null, children);
  const { result } = renderHook(() => useProcessingSessions(), { wrapper });

  await waitFor(() => assert.ok(result.current.get('held-session')));
  assert.deepEqual(result.current.get('held-session')?.tasks?.map((task) => task.taskId), ['w1']);
});

const reply = (sessions: unknown[]) => ({ ok: true, json: async () => ({ data: { sessions } }) });

const loopEntry = {
  id: 'cron:b2148320',
  kind: 'cron',
  toolUseId: 'toolu_cron_1',
  prompt: 'check CI',
  startedAt: 1_700_000_000_000,
  nextFireAt: 1_700_000_300_000,
  recurring: true,
  holdUntil: 1_700_691_200_000,
  cron: '*/5 * * * *',
  cadence: 'Every 5 minutes',
};

test('the poll asks for the sessions held for scheduled work too', async () => {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const { api } = await vi.importActual<typeof SharedApi>('@/shared/api');
    await api.runningSessions();
    assert.equal(String(fetchMock.mock.calls[0]?.[0]), '/api/providers/sessions/running?scheduled=1');
  } finally {
    vi.unstubAllGlobals();
  }
});

test('the poll reads each session\'s scheduled work, skipping an item it cannot read', async () => {
  runningSessions.mockResolvedValue(reply([{
    sessionId: 'looping-session',
    provider: 'claude',
    startedAt: 1_700_000_000_000,
    background: true,
    canInterrupt: false,
    tasks: [],
    scheduled: [loopEntry, { ...loopEntry, id: 'wakeup:toolu_wake_1', kind: 'wakeup', nextFireAt: 'soon' }],
  }]));

  const { SessionProtectionProvider, useProcessingSessions } = await import('@/shared/context/SessionProtectionContext');
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(SessionProtectionProvider, null, children);
  const { result } = renderHook(() => useProcessingSessions(), { wrapper });

  await waitFor(() => assert.equal(result.current.has('looping-session'), true));
  const activity = result.current.get('looping-session');
  assert.equal(activity?.background, true);
  assert.equal(JSON.stringify(activity?.scheduled), JSON.stringify([loopEntry]));
});

test('a read asked for at once settles with the map holding its answer, and an older answer that comes back later is dropped', async () => {
  const replies: Array<(value: unknown) => void> = [];
  runningSessions.mockImplementation(() => new Promise((resolve) => { replies.push(resolve); }));

  const { SessionProtectionProvider, useProcessingSessions, useSessionProtectionActions } = await import('@/shared/context/SessionProtectionContext');
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(SessionProtectionProvider, null, children);
  const { result } = renderHook(() => ({ map: useProcessingSessions(), actions: useSessionProtectionActions() }), { wrapper });
  // The mount's own read is out.
  await waitFor(() => assert.equal(replies.length, 1));

  let settled = false;
  act(() => {
    void result.current.actions.refreshRunningSessions().then(() => { settled = true; });
  });
  assert.equal(replies.length, 2);

  // The later read comes back first: the loop is listed.
  await act(async () => {
    replies[1](reply([{ sessionId: 'looping-session', startedAt: 1_700_000_000_000, background: true, canInterrupt: false, tasks: [], scheduled: [loopEntry] }]));
  });
  await waitFor(() => assert.equal(settled, true));
  assert.equal(result.current.map.get('looping-session')?.scheduled?.length, 1);

  // The mount's read, sent before it, says nothing runs: an older moment.
  await act(async () => {
    replies[0](reply([]));
  });
  assert.equal(result.current.map.has('looping-session'), true);
});
