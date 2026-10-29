import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useSessionProtection } from '@/shared/hooks/useSessionProtection';
import type { BackgroundTaskSummary, ScheduledWorkSummary } from '@/shared/types';

/**
 * A session whose turn has ended while the agents, workflows or commands it
 * launched still run is busy — the CLI is held open for them — but it is not
 * producing a response: the composer must stay usable. The activity map
 * carries that as a `background` entry, which the running-sessions poll
 * keeps while the server lists it and drops when it no longer does.
 */

const task = (overrides: Partial<BackgroundTaskSummary> = {}): BackgroundTaskSummary => ({
  taskId: 'wxkj4kcvd',
  toolUseId: 'toolu_workflow_1',
  taskType: 'local_workflow',
  description: 'Audit the frontend',
  workflowName: 'audit',
  startedAt: Date.now() - 60_000,
  ...overrides,
});

test('a background-only entry is busy but not processing', () => {
  const { result } = renderHook(() => useSessionProtection());

  act(() => {
    result.current.markSessionBackground('session-1', [task()]);
  });

  const activity = result.current.getSessionActivity('session-1');
  assert.equal(activity?.background, true);
  assert.equal(activity?.canInterrupt, false);
  assert.deepEqual(activity?.tasks, [task({ startedAt: activity?.startedAt })]);
  assert.equal(result.current.isSessionProcessing('session-1'), false, 'no response is being produced');
  assert.ok(result.current.processingSessions.has('session-1'), 'but the session counts as busy');
});

test('the poll keeps a background entry it lists and drops one it no longer does', () => {
  const { result } = renderHook(() => useSessionProtection());
  const listed = task({ startedAt: Date.now() - 120_000 });

  act(() => {
    result.current.syncProcessingSessions([
      { sessionId: 'session-1', startedAt: listed.startedAt, canInterrupt: false, background: true, tasks: [listed] },
    ]);
  });
  assert.equal(result.current.getSessionActivity('session-1')?.background, true);
  assert.deepEqual(result.current.getSessionActivity('session-1')?.tasks, [listed]);
  assert.equal(result.current.isSessionProcessing('session-1'), false);

  act(() => {
    result.current.syncProcessingSessions([]);
  });
  assert.equal(result.current.getSessionActivity('session-1'), undefined, 'the task started two minutes ago: no local grace applies');
});

test('the idle acknowledgement of a subscribe leaves background work alone', () => {
  // The ack says no response is in flight, which is already true of a
  // background-only session; clearing it would blank the indicator on every
  // session open until the next poll.
  const { result } = renderHook(() => useSessionProtection());

  act(() => {
    result.current.markSessionBackground('session-1', [task()]);
    result.current.markSessionIdle('session-1', { ifStartedBefore: Date.now() + 1 });
  });
  assert.equal(result.current.getSessionActivity('session-1')?.background, true);

  act(() => {
    result.current.markSessionBackground('session-1', []);
  });
  assert.equal(result.current.getSessionActivity('session-1'), undefined, 'no task left marks it idle');
});

test('a run that left background work running keeps the tasks its turn entry lists as background work', () => {
  // What a tab that did not follow the run has to go on until the next poll.
  const { result } = renderHook(() => useSessionProtection());
  const running = task({ startedAt: Date.now() - 30_000 });

  act(() => {
    for (const sessionId of ['session-1', 'session-3']) {
      result.current.markSessionBackground(sessionId, [running]);
      result.current.markSessionProcessing(sessionId);
    }
    result.current.markSessionProcessing('session-2');
  });
  act(() => {
    result.current.markSessionIdle('session-1', { backgroundWorkGoesOn: true });
    result.current.markSessionIdle('session-2', { backgroundWorkGoesOn: true });
    result.current.markSessionIdle('session-3', { backgroundWorkGoesOn: false });
  });

  const kept = result.current.getSessionActivity('session-1');
  assert.equal(kept?.background, true);
  assert.equal(kept?.canInterrupt, false);
  assert.equal(kept?.statusText === null, true);
  assert.equal(kept?.startedAt === running.startedAt, true, 'timed from the earliest task, as background work is');
  assert.equal(kept?.tasks?.map((entry) => entry.taskId).join(','), running.taskId);
  assert.equal(result.current.isSessionProcessing('session-1'), false);
  assert.equal(result.current.getSessionActivity('session-2') === undefined, true, 'no task to keep: idle');
  assert.equal(result.current.getSessionActivity('session-3') === undefined, true, 'the work went with the turn');
});

test('a new turn on a background session is processing again, with its own clock', () => {
  const { result } = renderHook(() => useSessionProtection());
  const earlier = task({ startedAt: Date.now() - 300_000 });

  act(() => {
    result.current.markSessionBackground('session-1', [earlier]);
  });
  const sendAt = Date.now();
  act(() => {
    result.current.markSessionProcessing('session-1', { statusText: null, canInterrupt: true });
  });

  const activity = result.current.getSessionActivity('session-1');
  assert.equal(result.current.isSessionProcessing('session-1'), true);
  assert.equal(activity?.background, undefined);
  assert.equal(activity?.canInterrupt, true);
  assert.ok((activity?.startedAt ?? 0) >= sendAt, 'the elapsed time and the stale-ack guard count from the send');
  assert.deepEqual(activity?.tasks, [earlier], 'the tasks keep running under the new turn');
});

test('a poll that still lists only background work does not demote a send made moments ago', () => {
  const { result } = renderHook(() => useSessionProtection());

  act(() => {
    result.current.markSessionProcessing('session-1');
    result.current.syncProcessingSessions([
      { sessionId: 'session-1', startedAt: Date.now() - 60_000, canInterrupt: false, background: true, tasks: [task()] },
    ]);
  });

  assert.equal(result.current.isSessionProcessing('session-1'), true);
});

test('a poll that changes what it says about a listed task is not dropped as a repeat', () => {
  // The first poll can list a task before the server knows it is nested, or
  // with a start it later corrects; the same id is not the same word.
  const { result } = renderHook(() => useSessionProtection());
  const startedAt = Date.now() - 120_000;
  const first = task({ startedAt });

  act(() => {
    result.current.syncProcessingSessions([
      { sessionId: 'session-1', startedAt, canInterrupt: false, background: true, tasks: [first] },
    ]);
  });
  act(() => {
    result.current.syncProcessingSessions([
      { sessionId: 'session-1', startedAt, canInterrupt: false, background: true, tasks: [{ ...first, nested: true, description: 'Audit the whole frontend' }] },
    ]);
  });

  const listed = result.current.getSessionActivity('session-1')?.tasks?.[0];
  assert.equal(listed?.nested, true);
  assert.equal(listed?.description, 'Audit the whole frontend');
});

/**
 * A /loop or a reminder holds the session's process with no task running.
 * The server reports that scheduled work apart from the tasks, and only it
 * says when an item is gone; what the client reads from the transcript
 * changes the tasks alone.
 */

const scheduled = (overrides: Partial<ScheduledWorkSummary> = {}): ScheduledWorkSummary => ({
  id: 'cron:b2148320',
  kind: 'cron',
  toolUseId: 'toolu_cron_1',
  prompt: 'check CI',
  startedAt: Date.now() - 90_000,
  nextFireAt: Date.now() + 120_000,
  recurring: true,
  holdUntil: Date.now() + 8 * 86_400_000,
  cron: '*/5 * * * *',
  ...overrides,
});

test('a session with scheduled work alone is background work, timed from its earliest item', () => {
  const { result } = renderHook(() => useSessionProtection());
  const loop = scheduled();

  act(() => {
    result.current.syncProcessingSessions([
      { sessionId: 'session-1', startedAt: loop.startedAt, canInterrupt: false, background: true, tasks: [], scheduled: [loop] },
    ]);
  });
  const polled = result.current.getSessionActivity('session-1');
  assert.equal(polled?.background, true);
  assert.equal(polled?.tasks?.length, 0);
  assert.equal(polled?.scheduled?.map((item) => item.id).join(','), loop.id);
  assert.equal(result.current.isSessionProcessing('session-1'), false);

  const earlier = scheduled({ id: 'wakeup:toolu_wake_1', kind: 'wakeup', startedAt: Date.now() - 300_000 });
  act(() => {
    result.current.markSessionBackground('session-2', [], [loop, earlier]);
  });
  const marked = result.current.getSessionActivity('session-2');
  assert.equal(marked?.background, true);
  assert.equal(marked?.startedAt === earlier.startedAt, true);
});

test('reading the tasks from the transcript again leaves the scheduled work as the server reported it', () => {
  const { result } = renderHook(() => useSessionProtection());
  const loop = scheduled();
  const running = task({ startedAt: Date.now() - 30_000 });

  act(() => {
    result.current.markSessionBackground('session-1', [running], [loop]);
  });
  // A turn's `complete`, a task's notification: the tasks alone.
  act(() => {
    result.current.markSessionBackground('session-1', []);
  });
  const left = result.current.getSessionActivity('session-1');
  assert.equal(left?.background, true, 'the loop still holds the process');
  assert.equal(left?.tasks?.length, 0);
  assert.equal(left?.scheduled?.map((item) => item.id).join(','), loop.id);
  assert.equal(left?.startedAt === loop.startedAt, true);

  // Finished background work, as `run_ended` reports it, clears both.
  act(() => {
    result.current.markSessionBackground('session-1', [], []);
  });
  assert.equal(result.current.getSessionActivity('session-1') === undefined, true);
});

test('a new turn carries the scheduled work, and its end keeps the session as background work for it', () => {
  const { result } = renderHook(() => useSessionProtection());
  const loop = scheduled();

  act(() => {
    result.current.markSessionBackground('session-1', [], [loop]);
  });
  act(() => {
    result.current.markSessionProcessing('session-1', { statusText: null, canInterrupt: true });
  });
  assert.equal(result.current.isSessionProcessing('session-1'), true);
  assert.equal(result.current.getSessionActivity('session-1')?.scheduled?.length, 1);

  act(() => {
    result.current.markSessionIdle('session-1', { backgroundWorkGoesOn: true });
  });
  const after = result.current.getSessionActivity('session-1');
  assert.equal(after?.background, true);
  assert.equal(after?.scheduled?.map((item) => item.id).join(','), loop.id);

  act(() => {
    result.current.markSessionProcessing('session-2');
    result.current.markSessionIdle('session-2', { backgroundWorkGoesOn: true });
  });
  assert.equal(result.current.getSessionActivity('session-2') === undefined, true, 'nothing to keep: idle');
});

test('a poll that only moves an item\'s next run is not dropped as a repeat, and one that drops the item clears it', () => {
  const { result } = renderHook(() => useSessionProtection());
  const loop = scheduled();
  const snapshot = (items: ScheduledWorkSummary[]) => [
    { sessionId: 'session-1', startedAt: loop.startedAt, canInterrupt: false, background: true, tasks: [], scheduled: items },
  ];

  act(() => {
    result.current.syncProcessingSessions(snapshot([loop]));
  });
  const first = result.current.getSessionActivity('session-1');
  act(() => {
    result.current.syncProcessingSessions(snapshot([{ ...loop }]));
  });
  assert.equal(result.current.getSessionActivity('session-1') === first, true, 'the same word keeps the entry');

  const nextRun = (loop.nextFireAt ?? 0) + 300_000;
  act(() => {
    result.current.syncProcessingSessions(snapshot([{ ...loop, nextFireAt: nextRun }]));
  });
  assert.equal(result.current.getSessionActivity('session-1')?.scheduled?.[0]?.nextFireAt === nextRun, true);

  act(() => {
    result.current.syncProcessingSessions(snapshot([{ ...loop, nextFireAt: nextRun, holdUntil: loop.holdUntil + 1 }]));
  });
  assert.equal(result.current.getSessionActivity('session-1')?.scheduled?.[0]?.holdUntil === loop.holdUntil + 1, true);

  act(() => {
    result.current.syncProcessingSessions([]);
  });
  assert.equal(result.current.getSessionActivity('session-1') === undefined, true);
});

test('a run the poll lists where the map had only background work is a turn CloudCLI can stop, whatever the background entry said', () => {
  // The turn a stop of a loop starts, a due message, another tab's send: a run
  // of the chat registry, which the poll lists without canInterrupt.
  for (const tasks of [[], [task()]]) {
    const { result } = renderHook(() => useSessionProtection());
    const loop = scheduled();
    const runStartedAt = Date.now() - 2_000;

    act(() => {
      result.current.syncProcessingSessions([
        { sessionId: 'session-1', startedAt: loop.startedAt, canInterrupt: false, background: true, tasks, scheduled: [loop] },
      ]);
    });
    act(() => {
      result.current.syncProcessingSessions([
        { sessionId: 'session-1', startedAt: runStartedAt, tasks: tasks.length ? tasks : undefined, scheduled: [loop] },
      ]);
    });

    const activity = result.current.getSessionActivity('session-1');
    const label = `${tasks.length} task(s)`;
    assert.equal(result.current.isSessionProcessing('session-1'), true, label);
    assert.equal(activity?.canInterrupt, true, label);
    assert.equal(activity?.statusText === null, true, label);
    assert.equal(activity?.startedAt === runStartedAt, true, label);
    assert.equal(activity?.scheduled?.map((item) => item.id).join(','), loop.id, label);
  }
});

test('a turn the Claude CLI drives, listed where the map had only background work, stays one CloudCLI cannot stop; a followed turn keeps its status', () => {
  const { result } = renderHook(() => useSessionProtection());
  const loop = scheduled();

  act(() => {
    result.current.syncProcessingSessions([
      { sessionId: 'session-1', startedAt: loop.startedAt, canInterrupt: false, background: true, tasks: [], scheduled: [loop] },
    ]);
  });
  act(() => {
    result.current.syncProcessingSessions([
      { sessionId: 'session-1', startedAt: Date.now() - 1_000, canInterrupt: false, statusText: 'Running in the Claude CLI' },
    ]);
  });
  const cliTurn = result.current.getSessionActivity('session-1');
  assert.equal(result.current.isSessionProcessing('session-1'), true);
  assert.equal(cliTurn?.canInterrupt, false);
  assert.equal(cliTurn?.statusText, 'Running in the Claude CLI');

  // A turn this page follows, its status from the stream, listed as a run.
  act(() => {
    result.current.markSessionProcessing('session-2', { statusText: 'Reading files', canInterrupt: true });
  });
  act(() => {
    result.current.syncProcessingSessions([
      { sessionId: 'session-2', startedAt: Date.now() - 1_000 },
    ]);
  });
  const followed = result.current.getSessionActivity('session-2');
  assert.equal(followed?.statusText, 'Reading files');
  assert.equal(followed?.canInterrupt, true);
});
