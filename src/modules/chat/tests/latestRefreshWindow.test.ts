import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  listToolIdsBeyondLatestRefresh,
  resolveLatestRefreshLimit,
} from '@/modules/chat/utils/sessionMessagePagination';
import type { NormalizedMessage, Project, ProjectSession, WorkflowAgentInfo, WorkflowInfo } from '@/shared/types';

/**
 * Every automatic reload of the viewed transcript (the poll that follows a
 * workflow the Claude CLI runs outside CloudCLI, a `session_upserted` reload,
 * a return to the tab, a turn's end) re-read only its newest 20 rows, and the
 * merge keeps every cached row older than those as it was. A `Workflow`
 * launch's row is the only place a history load reports its run, so once 20
 * rows had been written after it, its agents froze where they stood, a run
 * that had ended still read `running`, and the poll went on re-reading the
 * newest page every 5 s for nothing. The reload now reaches back to a cached
 * launch whose run was last seen going.
 */

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
      sessionTokenUsage: () => Promise.resolve({ ok: false, json: async () => ({}) }),
    },
  },
}));

const SESSION_ID = 'session-1';
const TURN_AT = Date.parse('2026-10-26T10:00:00.000Z');

const row = (id: string, atMs: number, fields: Partial<NormalizedMessage>): NormalizedMessage => ({
  id,
  sessionId: SESSION_ID,
  timestamp: new Date(atMs).toISOString(),
  provider: 'claude',
  kind: 'text',
  role: 'assistant',
  ...fields,
});

const userTurn = row('turn-1', TURN_AT, { role: 'user', content: 'Audit the frontend' });

/** An exchange from before the turn, one row each. */
const earlierRows = (count: number) => Array.from({ length: count }, (_, index) => (
  row(`earlier-${index}`, TURN_AT - (count - index) * 60_000, { role: index % 2 === 0 ? 'user' : 'assistant', content: `Earlier (${index})` })
));

/** What the CLI writes after the launch, one row each: replies, tool calls, thinking. */
const laterRows = (count: number, prefix = 'later') => Array.from({ length: count }, (_, index) => (
  row(`${prefix}-${index}`, TURN_AT + 10_000 + index * 1_000, { content: `Still auditing (${index + 1})` })
));

const agent = (id: string, status: WorkflowAgentInfo['status']): WorkflowAgentInfo => ({ id, label: `audit:${id}`, status });

/** A `Workflow` call as a history load returns it: acknowledged, with its run as the journal describes it. */
const workflowLaunch = (
  status: WorkflowInfo['status'],
  agents: WorkflowAgentInfo[],
  toolId = 'toolu_workflow_1',
): NormalizedMessage => row(`row-${toolId}`, TURN_AT + 5_000, {
  kind: 'tool_use',
  toolName: 'Workflow',
  toolId,
  toolInput: { description: 'Audit the frontend' },
  toolResult: { content: '', isError: false, toolUseResult: { status: 'async_launched', taskId: 'wxkj4kcvd', runId: 'wf_1' } },
  workflow: {
    runId: 'wf_1',
    name: 'frontend-audit',
    status,
    agents,
    agentCounts: {
      total: agents.length,
      completed: agents.filter((item) => item.status === 'completed').length,
      failed: agents.filter((item) => item.status === 'failed').length,
      running: agents.filter((item) => item.status === 'running').length,
      stopped: agents.filter((item) => item.status === 'stopped').length,
    },
  },
});

/** A background `Agent` call as a history load returns it. */
const agentLaunch = (status: WorkflowInfo['status'], toolId = 'toolu_agent_1'): NormalizedMessage => row(`row-${toolId}`, TURN_AT + 6_000, {
  kind: 'tool_use',
  toolName: 'Agent',
  toolId,
  toolInput: { description: 'Survey the repo', run_in_background: true },
  subagent: { id: 'a8c1', description: 'Survey the repo', status },
});

describe('how many rows a latest-page refresh reads', () => {
  const running = workflowLaunch('running', [agent('ag1', 'running')]);

  it('reads a page while no cached launch is running, or the running one is still in it', () => {
    expect(resolveLatestRefreshLimit([])).toBe(20);
    expect(resolveLatestRefreshLimit([userTurn, workflowLaunch('completed', []), agentLaunch('stopped'), ...laterRows(60)])).toBe(20);
    // The launch, the 18 rows after it and the row of slack make a page.
    expect(resolveLatestRefreshLimit([userTurn, running, ...laterRows(18)])).toBe(20);
  });

  it('reaches back to the oldest launch still running, with a row of slack for one written meanwhile', () => {
    expect(resolveLatestRefreshLimit([userTurn, running, ...laterRows(19)])).toBe(21);
    expect(resolveLatestRefreshLimit([userTurn, running, ...laterRows(60)])).toBe(62);
    // A background agent counts as a workflow does, and the older of the two decides.
    expect(resolveLatestRefreshLimit([userTurn, agentLaunch('running'), ...laterRows(10, 'gap'), running, ...laterRows(30)])).toBe(43);
  });

  it('reaches no further back than 150 rows, and follows a launch within them when an older one is past them', () => {
    expect(resolveLatestRefreshLimit([userTurn, running, ...laterRows(148)])).toBe(150);
    expect(resolveLatestRefreshLimit([userTurn, running, ...laterRows(149)])).toBe(20);
    expect(resolveLatestRefreshLimit([
      agentLaunch('running'),
      ...laterRows(160, 'gap'),
      workflowLaunch('running', [], 'toolu_workflow_2'),
      ...laterRows(40),
    ])).toBe(42);
  });

  it('never reaches above the oldest cached row, which the merge could not place', () => {
    // The launch is the oldest cached row: the window is the cache, with no
    // row of slack above it.
    expect(resolveLatestRefreshLimit([running, ...laterRows(19)])).toBe(20);
    expect(resolveLatestRefreshLimit([running, ...laterRows(60)])).toBe(61);
    expect(resolveLatestRefreshLimit([running, ...laterRows(148)])).toBe(149);
    // And a quiet read of it reaches the launch, so the poll follows it.
    expect([...listToolIdsBeyondLatestRefresh([running, ...laterRows(60)])]).toEqual([]);
  });

  it('names the calls the refresh leaves as they are: those above the rows it reaches', () => {
    const olderCall = row('older-call', TURN_AT - 1_000, { kind: 'tool_use', toolName: 'Read', toolId: 'toolu_read_1' });

    // A page reaches the newest 19 rows, its row of slack aside.
    expect([...listToolIdsBeyondLatestRefresh([olderCall, running, ...laterRows(18)])]).toEqual(['toolu_read_1']);
    expect([...listToolIdsBeyondLatestRefresh([olderCall, running, ...laterRows(17)])]).toEqual([]);
    // Reaching back to the running launch leaves out only what is above it.
    expect([...listToolIdsBeyondLatestRefresh([olderCall, running, ...laterRows(60)])]).toEqual(['toolu_read_1']);
    // Past the reach, the launch itself is left as it is.
    expect([...listToolIdsBeyondLatestRefresh([olderCall, running, ...laterRows(149)])]).toEqual(['toolu_read_1', 'toolu_workflow_1']);
  });
});

describe('a reload of the viewed transcript', () => {
  /** The transcript on disk, paged the way the history endpoint pages it: the newest `limit` rows before the newest `offset`. */
  let serverRows: NormalizedMessage[] = [];
  /** Every history request the store made, in order. */
  const requests: Array<{ limit?: number | null; offset?: number }> = [];

  beforeEach(() => {
    serverRows = [];
    requests.length = 0;
    sessionMessages.mockReset();
    sessionMessages.mockImplementation(async (_sessionId: string, options: { limit?: number | null; offset?: number }) => {
      requests.push({ limit: options.limit, offset: options.offset });
      const end = Math.max(0, serverRows.length - (options.offset ?? 0));
      const start = options.limit == null ? 0 : Math.max(0, end - options.limit);
      return {
        ok: true,
        json: async () => ({ data: { messages: serverRows.slice(start, end), total: serverRows.length, hasMore: start > 0 } }),
      };
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  // Stable across renders, as ChatInterface's are: the session-loading effect
  // runs again whenever one of these changes.
  const project: Project = { projectId: 'project-1', path: '/repo', fullPath: '/repo', displayName: 'Repo', isStarred: false };
  const session = { id: SESSION_ID } as ProjectSession;
  const noop = () => {};
  const statusCheckSentAtRef = { current: new Map<string, number>() };
  const lastSeqRef = { current: new Map<string, number>() };

  /** Opens the session on its newest page, with the real store behind the view. */
  const openSession = async () => {
    const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
    const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');
    const view = renderHook(() => {
      const sessionStore = useSessionStore();
      const { requestLatestMessages } = useChatSessionState({
        isActive: true,
        selectedProject: project,
        selectedSession: session,
        ws: null,
        sendMessage: noop,
        resetStreamingState: noop,
        statusCheckSentAtRef,
        lastSeqRef,
        sessionStore,
      });
      return { sessionStore, requestLatestMessages };
    });
    await waitFor(() => expect(view.result.current.sessionStore.getSessionSlot(SESSION_ID)?.fetchedAt).toBeGreaterThan(0));

    /** Reloads the way every automatic refresh does, and returns the requests it made. */
    const reload = async () => {
      requests.length = 0;
      await act(async () => {
        await view.result.current.requestLatestMessages(SESSION_ID);
      });
      return [...requests];
    };
    /** The run as the store now holds it. */
    const storedRun = () => view.result.current.sessionStore.getMessages(SESSION_ID)
      .find((message) => message.toolId === 'toolu_workflow_1')?.workflow;
    return { reload, storedRun };
  };

  it('re-reads a launch later rows pushed out of the newest page until its run reads as over', async () => {
    const agentStatuses = (run: WorkflowInfo | undefined) => run?.agents.map((item) => [item.id, item.status]);
    serverRows = [...earlierRows(10), userTurn, workflowLaunch('running', [agent('ag1', 'running')])];
    const { reload, storedRun } = await openSession();

    // The CLI writes 25 rows after the launch while the run moves on.
    serverRows = [
      ...earlierRows(10),
      userTurn,
      workflowLaunch('running', [agent('ag1', 'completed'), agent('ag2', 'running')]),
      ...laterRows(25),
    ];
    await reload();
    expect(agentStatuses(storedRun())).toEqual([['ag1', 'completed'], ['ag2', 'running']]);

    // The run moves on in its journal alone, as the poll's reload finds it:
    // only a re-read that reaches back to the launch can say so.
    serverRows = [
      ...earlierRows(10),
      userTurn,
      workflowLaunch('running', [agent('ag1', 'completed'), agent('ag2', 'completed'), agent('ag3', 'running')]),
      ...laterRows(25),
    ];
    let requested = await reload();
    expect(agentStatuses(storedRun())).toEqual([['ag1', 'completed'], ['ag2', 'completed'], ['ag3', 'running']]);
    // The launch, the 25 rows after it and the row of slack.
    expect(requested).toEqual([{ limit: 27, offset: 0 }]);

    // The run ends, and the CLI writes its next row, which is what sets off
    // the reload: the row of slack keeps the launch inside the window.
    serverRows = [
      ...earlierRows(10),
      userTurn,
      workflowLaunch('completed', [agent('ag1', 'completed'), agent('ag2', 'completed'), agent('ag3', 'completed')]),
      ...laterRows(26),
    ];
    requested = await reload();
    expect(storedRun()).toMatchObject({ status: 'completed', agentCounts: { total: 3, completed: 3, running: 0 } });
    expect(requested).toEqual([{ limit: 27, offset: 0 }]);

    // Over, it is no longer followed: the next reload reads a page again.
    expect(await reload()).toEqual([{ limit: 20, offset: 0 }]);
  });

  it('re-reads a launch that is the oldest row the view holds', async () => {
    const agentStatuses = (run: WorkflowInfo | undefined) => run?.agents.map((item) => [item.id, item.status]);
    // Opened on the newest page while 19 rows follow the launch, over older
    // history: the launch is the oldest row the view holds.
    serverRows = [...earlierRows(10), userTurn, workflowLaunch('running', [agent('ag1', 'running')]), ...laterRows(19)];
    const { reload, storedRun } = await openSession();

    // The run moves on in its journal alone, so a reload adds no row. A window
    // one row longer than the view would start above it, where the merge
    // cannot place it, and the whole read would be dropped.
    serverRows = [
      ...earlierRows(10),
      userTurn,
      workflowLaunch('running', [agent('ag1', 'completed'), agent('ag2', 'running')]),
      ...laterRows(19),
    ];
    const requested = await reload();
    expect(requested).toEqual([{ limit: 20, offset: 0 }]);
    expect(agentStatuses(storedRun())).toEqual([['ag1', 'completed'], ['ag2', 'running']]);
  });
});
