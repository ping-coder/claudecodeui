import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { useRunEndedFeed } from '@/modules/run-notifications/hooks/useRunEndedFeed';
import {
  SessionProtectionProvider,
  useProcessingSessions,
  useSessionProtectionActions,
} from '@/shared/context/SessionProtectionContext';
import type { ResolveRunSessionLabel, RunAlert, SessionActivityMap } from '@/shared/types';

/**
 * The server broadcasts `run_ended` to every tab when a run ends, and keeps ten minutes of them for a tab whose
 * socket dropped. The feed turns each end into one alert (none for an aborted run), brings the activity map up
 * to date for a run this tab did not follow, reads the recent ends on mount as a baseline and after a reconnect
 * to catch up, and names the session from the workspace, else from the server, else as untitled.
 */

const page = vi.hoisted(() => {
  const listeners = new Set<(event: unknown) => void>();
  return {
    listeners,
    subscribe: (listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** What each GET /run-ends answers, in order: a list of ends, or 'fail'. An empty list once they run out. */
    runEndsReplies: [] as Array<unknown[] | 'fail'>,
  };
});

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: page.subscribe }),
}));

vi.mock('@/shared/api', () => ({
  api: {
    // The running-sessions poll stays out of the activity map these tests drive.
    runningSessions: async () => ({ ok: false, json: async () => ({}) }),
    runEnds: async () => {
      const reply = page.runEndsReplies.shift() ?? [];
      return reply === 'fail'
        ? { ok: false, json: async () => ({}) }
        : { ok: true, json: async () => ({ success: true, data: { ends: reply } }) };
    },
  },
}));

const alerts: RunAlert[] = [];
const activity: { map: SessionActivityMap; actions: ReturnType<typeof useSessionProtectionActions> | null } = {
  map: new Map(),
  actions: null,
};

function FeedProbe({ resolveSessionLabel }: { resolveSessionLabel: ResolveRunSessionLabel }) {
  useRunEndedFeed({ resolveSessionLabel, onAlert: (alert) => alerts.push(alert) });
  const map = useProcessingSessions();
  const actions = useSessionProtectionActions();
  useLayoutEffect(() => {
    activity.map = map;
    activity.actions = actions;
  });
  return null;
}

const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

/** Mounts the feed and lets its baseline read finish. */
const renderFeed = async (resolveSessionLabel: ResolveRunSessionLabel = () => null) => {
  const view = render(
    <SessionProtectionProvider>
      <FeedProbe resolveSessionLabel={resolveSessionLabel} />
    </SessionProtectionProvider>,
  );
  await settle();
  return view;
};

const dispatch = (event: Record<string, unknown>) => {
  act(() => {
    for (const listener of page.listeners) {
      listener(event);
    }
  });
};

/** A run end as the server sends it; the frame and the recent-ends list carry the same fields. */
const runEnd = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'run_ended',
  sessionId: 'session-a',
  provider: 'claude',
  runStartedAt: 1000,
  endedAt: 2000,
  outcome: 'done',
  backgroundWork: false,
  sessionName: null,
  timestamp: '2026-10-27T10:00:00.000Z',
  ...overrides,
});

const reconnect = async () => {
  dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
  await settle();
};

const alertSummary = () => alerts.map(({ key, outcome, isCatchUp }) => ({ key, outcome, isCatchUp }));

beforeEach(() => {
  alerts.length = 0;
  page.runEndsReplies.length = 0;
  localStorage.clear();
});

test('a finished turn raises a live done alert; with background work left running it reads as replied', async () => {
  await renderFeed(() => ({ title: 'Fix login bug', projectName: 'Alpha' }));

  dispatch(runEnd());
  dispatch(runEnd({ sessionId: 'session-b', backgroundWork: true }));

  assert.deepEqual(alertSummary(), [
    { key: 'session-a:1000:turn', outcome: 'done', isCatchUp: false },
    { key: 'session-b:1000:turn', outcome: 'replied', isCatchUp: false },
  ]);
  assert.equal(alerts[0].sessionId, 'session-a');
  assert.equal(alerts[0].provider, 'claude');
  assert.equal(alerts[0].title, 'Fix login bug');
  assert.equal(alerts[0].projectName, 'Alpha');
  assert.equal(typeof alerts[0].receivedAt, 'number');
});

test('failed runs and finished background work raise their own alerts; an aborted run raises none', async () => {
  await renderFeed();

  dispatch(runEnd({ sessionId: 'session-f', outcome: 'failed' }));
  dispatch(runEnd({ outcome: 'aborted' }));
  // The turn's end and its background work's end are two alerts of the same run.
  dispatch(runEnd({ sessionId: 'session-b' }));
  dispatch(runEnd({ sessionId: 'session-b', outcome: 'backgroundDone' }));

  assert.deepEqual(alertSummary(), [
    { key: 'session-f:1000:turn', outcome: 'failed', isCatchUp: false },
    { key: 'session-b:1000:turn', outcome: 'done', isCatchUp: false },
    { key: 'session-b:1000:background', outcome: 'backgroundDone', isCatchUp: false },
  ]);
});

test('each alert key is handed over once', async () => {
  await renderFeed();

  dispatch(runEnd());
  dispatch(runEnd());
  // The next run of the same session is a new alert.
  dispatch(runEnd({ runStartedAt: 5000 }));

  assert.deepEqual(alerts.map((alert) => alert.key), ['session-a:1000:turn', 'session-a:5000:turn']);
});

test('frames with a missing or malformed field are dropped', async () => {
  await renderFeed();

  dispatch(runEnd({ sessionId: '' }));
  dispatch(runEnd({ sessionId: 42 }));
  dispatch(runEnd({ provider: 'gpt' }));
  dispatch(runEnd({ runStartedAt: '1000' }));
  dispatch(runEnd({ runStartedAt: Number.NaN }));
  dispatch(runEnd({ outcome: 'finished' }));
  assert.equal(alerts.length, 0);

  // The optional fields fall back instead: no background work, no server name.
  dispatch(runEnd({ backgroundWork: 'yes', sessionName: 7 }));
  assert.deepEqual(alertSummary(), [{ key: 'session-a:1000:turn', outcome: 'done', isCatchUp: false }]);
  assert.equal(alerts[0].title, 'Untitled session');
});

test('a turn\'s end idles its turn entry, aborted or not, and leaves background work alone', async () => {
  await renderFeed();
  act(() => {
    activity.actions?.markSessionProcessing('session-a');
    activity.actions?.markSessionProcessing('session-b');
    activity.actions?.markSessionBackground('session-c', [
      { taskId: 'w1', toolUseId: 'toolu_1', taskType: 'local_workflow', description: 'Audit', startedAt: 1 },
    ]);
  });

  dispatch(runEnd({ sessionId: 'session-a' }));
  dispatch(runEnd({ sessionId: 'session-b', outcome: 'aborted' }));
  dispatch(runEnd({ sessionId: 'session-c', backgroundWork: true }));

  assert.equal(activity.map.has('session-a'), false);
  assert.equal(activity.map.has('session-b'), false);
  assert.equal(activity.map.get('session-c')?.background, true);
});

test('a turn\'s end with background work still running leaves the tasks its entry lists as background work', async () => {
  await renderFeed();
  const workflow = { taskId: 'w1', toolUseId: 'toolu_1', taskType: 'local_workflow', description: 'Audit', startedAt: 1 };
  act(() => {
    // A session the running-sessions poll lists for its work alone, timed from when its run started.
    activity.actions?.syncProcessingSessions([
      { sessionId: 'session-e', startedAt: 5, canInterrupt: true, background: true, tasks: [workflow] },
    ]);
    // Turns that went into the process held for each session's work: their entries are responses again, still
    // listing the work.
    for (const sessionId of ['session-a', 'session-b', 'session-c']) {
      activity.actions?.markSessionBackground(sessionId, [workflow]);
      activity.actions?.markSessionProcessing(sessionId);
    }
    activity.actions?.markSessionProcessing('session-d');
  });

  // Stopped alone, or finished, with the work going on.
  dispatch(runEnd({ sessionId: 'session-a', outcome: 'aborted', backgroundWork: true }));
  dispatch(runEnd({ sessionId: 'session-b', backgroundWork: true }));
  // The stop took the work down.
  dispatch(runEnd({ sessionId: 'session-c', outcome: 'aborted' }));
  // No task to list: the running-sessions poll brings the work.
  dispatch(runEnd({ sessionId: 'session-d', outcome: 'aborted', backgroundWork: true }));
  // Already background work: left as the poll wrote it.
  dispatch(runEnd({ sessionId: 'session-e', backgroundWork: true }));

  assert.equal(activity.map.get('session-a')?.background, true);
  assert.equal(activity.map.get('session-a')?.tasks?.map((task) => task.taskId).join(','), 'w1');
  assert.equal(activity.map.get('session-b')?.background, true);
  assert.equal(activity.map.get('session-b')?.tasks?.map((task) => task.taskId).join(','), 'w1');
  assert.equal(activity.map.has('session-c'), false);
  assert.equal(activity.map.has('session-d'), false);
  assert.equal(activity.map.get('session-e')?.startedAt === 5, true);
  assert.equal(activity.map.get('session-e')?.canInterrupt, true);
});

test('in a tab that follows the run, its end leaves the entry as the chat settled it from the complete before it', async () => {
  await renderFeed();
  const agent = (taskId: string) => ({ taskId, toolUseId: `toolu_${taskId}`, taskType: 'local_agent', description: taskId, startedAt: 1 });
  act(() => {
    for (const sessionId of ['session-a', 'session-b']) {
      activity.actions?.markSessionBackground(sessionId, [agent('w1')]);
      activity.actions?.markSessionProcessing(sessionId);
    }
  });

  // The `complete` and the `run_ended` right after it, both handled before React renders again.
  act(() => {
    // By the transcript, w1 finished during the turn and w2 started; in session-b nothing runs any more.
    activity.actions?.markSessionBackground('session-a', [agent('w2')]);
    activity.actions?.markSessionBackground('session-b', []);
    for (const listener of page.listeners) {
      listener(runEnd({ sessionId: 'session-a', backgroundWork: true }));
      listener(runEnd({ sessionId: 'session-b', backgroundWork: true }));
    }
  });

  assert.equal(activity.map.get('session-a')?.tasks?.map((task) => task.taskId).join(','), 'w2');
  assert.equal(activity.map.has('session-b'), false);
});

test('finished background work clears the session\'s background entry, but not a turn started since', async () => {
  await renderFeed();
  act(() => {
    activity.actions?.markSessionBackground('session-a', [
      { taskId: 'w1', toolUseId: 'toolu_1', taskType: 'local_workflow', description: 'Audit', startedAt: 1 },
    ]);
    activity.actions?.markSessionProcessing('session-b');
  });

  dispatch(runEnd({ sessionId: 'session-a', outcome: 'backgroundDone' }));
  dispatch(runEnd({ sessionId: 'session-b', outcome: 'backgroundDone' }));

  assert.equal(activity.map.has('session-a'), false);
  assert.equal(activity.map.get('session-b')?.background, undefined);
  assert.equal(activity.map.has('session-b'), true);
});

test('finished background work clears the scheduled work the entry lists too: the loops ended with it', async () => {
  await renderFeed();
  const loop = {
    id: 'cron:b2148320',
    kind: 'cron' as const,
    toolUseId: 'toolu_cron_1',
    prompt: 'check CI',
    startedAt: 1,
    nextFireAt: 300_001,
    recurring: true,
    holdUntil: 691_200_001,
  };
  act(() => {
    activity.actions?.markSessionBackground('session-a', [], [loop]);
    activity.actions?.markSessionBackground('session-b', [
      { taskId: 'w1', toolUseId: 'toolu_1', taskType: 'local_workflow', description: 'Audit', startedAt: 1 },
    ], [loop]);
  });
  assert.equal(activity.map.get('session-a')?.background, true);

  dispatch(runEnd({ sessionId: 'session-a', outcome: 'backgroundDone' }));
  dispatch(runEnd({ sessionId: 'session-b', outcome: 'backgroundDone' }));

  assert.equal(activity.map.has('session-a'), false);
  assert.equal(activity.map.has('session-b'), false);
});

test('ends listed on mount raise nothing; ones missed during a drop come as catch-up alerts after the reconnect', async () => {
  page.runEndsReplies.push([runEnd()]);
  await renderFeed();
  assert.equal(alerts.length, 0);

  // A live frame for an end the baseline listed is old news too.
  dispatch(runEnd());
  assert.equal(alerts.length, 0);

  page.runEndsReplies.push([
    runEnd(),
    runEnd({ sessionId: 'session-b', outcome: 'failed' }),
    runEnd({ sessionId: 'session-c', outcome: 'aborted' }),
  ]);
  await reconnect();
  assert.deepEqual(alertSummary(), [{ key: 'session-b:1000:turn', outcome: 'failed', isCatchUp: true }]);

  // The next reconnect lists the same ends: nothing new.
  page.runEndsReplies.push([runEnd(), runEnd({ sessionId: 'session-b', outcome: 'failed' })]);
  await reconnect();
  assert.equal(alerts.length, 1);
});

test('catch-up skips the alerts another tab has already seen', async () => {
  await renderFeed();
  localStorage.setItem('cloudcli:run-alerts:seen', JSON.stringify({ 'session-b:1000:turn': Date.now() }));

  page.runEndsReplies.push([runEnd({ sessionId: 'session-b' }), runEnd({ sessionId: 'session-c' })]);
  await reconnect();

  assert.deepEqual(alertSummary(), [{ key: 'session-c:1000:turn', outcome: 'done', isCatchUp: true }]);
});

test('when the baseline read fails, the next read that succeeds is the baseline', async () => {
  page.runEndsReplies.push('fail');
  await renderFeed();

  page.runEndsReplies.push([runEnd()]);
  await reconnect();
  assert.equal(alerts.length, 0);

  page.runEndsReplies.push([runEnd(), runEnd({ sessionId: 'session-b' })]);
  await reconnect();
  assert.deepEqual(alertSummary(), [{ key: 'session-b:1000:turn', outcome: 'done', isCatchUp: true }]);
});

test('names fall back from the workspace label to the server\'s session name to an untitled placeholder', async () => {
  const labels: Record<string, ReturnType<ResolveRunSessionLabel>> = {
    'session-a': { title: 'Workspace title', projectName: 'Alpha' },
    'session-b': { title: '', projectName: 'Beta' },
  };
  await renderFeed((sessionId) => labels[sessionId] ?? null);

  dispatch(runEnd({ sessionId: 'session-a', sessionName: 'Server name A' }));
  dispatch(runEnd({ sessionId: 'session-b', sessionName: '  Server name B  ' }));
  dispatch(runEnd({ sessionId: 'session-c', sessionName: 'Server name C' }));
  dispatch(runEnd({ sessionId: 'session-d', sessionName: null }));

  assert.deepEqual(alerts.map(({ title, projectName }) => ({ title, projectName })), [
    { title: 'Workspace title', projectName: 'Alpha' },
    { title: 'Server name B', projectName: 'Beta' },
    { title: 'Server name C', projectName: null },
    { title: 'Untitled session', projectName: null },
  ]);
});

test('a session the workspace does not know reads by the server\'s placeholder name in the interface language', async () => {
  await renderFeed();
  await act(async () => {
    await i18n.changeLanguage('zh-CN');
  });
  try {
    dispatch(runEnd({ sessionId: 'session-a', outcome: 'failed', sessionName: 'Untitled Claude Session' }));
    dispatch(runEnd({ sessionId: 'session-b', sessionName: 'Untitled Session' }));
    dispatch(runEnd({ sessionId: 'session-c', sessionName: 'New Session' }));
    dispatch(runEnd({ sessionId: 'session-e', sessionName: 'Fix login bug' }));
    assert.deepEqual(alerts.map(({ title }) => title), ['未命名的 Claude 会话', '未命名会话', '新会话', 'Fix login bug']);
  } finally {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  }

  // English reads as the server wrote it.
  dispatch(runEnd({ sessionId: 'session-d', sessionName: 'Untitled Claude Session' }));
  assert.equal(alerts.at(-1)?.title, 'Untitled Claude Session');
});
