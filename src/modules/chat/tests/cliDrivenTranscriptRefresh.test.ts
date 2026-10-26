import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage, ProjectSession, ServerEvent, SessionActivity, WorkflowInfo } from '@/shared/types';

/**
 * A turn the Claude CLI drives outside CloudCLI (a Shell tab's `claude
 * --resume`, another CloudCLI instance) sends no live events, so its
 * transcript on disk is all the view can show. The sidebar reloads the viewed
 * transcript when the watcher reports it changed — but not for a busy session,
 * and the running-sessions poll lists such a turn as busy. So the view, and
 * the activity tab's details with it, stayed as they were when the session
 * was opened until the CLI finished. Chat now reloads it as the CLI writes.
 */

const VIEWED = 'viewed-session';
const OTHER = 'other-session';

type Harness = {
  /** Each busy session's entry in the activity map, as the running-sessions poll last left it. */
  activityBySession: Record<string, SessionActivity>;
  /**
   * Each session's transcript as the session store holds it: all of it read
   * from the server, as a turn the CLI drives streams no live rows.
   */
  messagesBySession: Record<string, NormalizedMessage[]>;
};

const renderHandlers = (harness: Harness) => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const reloads: string[] = [];
  const stored: NormalizedMessage[] = [];

  // Stable across renders, as ChatInterface's are: the refresh timer starts
  // over whenever one of the last three changes.
  const subscribe = (fn: (event: ServerEvent) => void) => {
    listener = fn;
    return () => { listener = null; };
  };
  const getSessionActivity = (sessionId: string) => harness.activityBySession[sessionId];
  const requestLatestMessages = async (sessionId: string) => { reloads.push(sessionId); };
  const sessionStore = {
    appendRealtime: (_sessionId: string, message: NormalizedMessage) => { stored.push(message); },
    getMessages: (sessionId: string) => harness.messagesBySession[sessionId] ?? [],
    getSessionSlot: (sessionId: string) => ({ serverMessages: harness.messagesBySession[sessionId] ?? [] }),
    updateStreaming: () => {},
    finalizeStreaming: () => {},
  } as unknown as SessionStore;

  const hook = renderHook(({ viewedSessionId }: { viewedSessionId: string }) => useChatRealtimeHandlers({
    isActive: true,
    subscribe,
    provider: 'claude',
    selectedSession: { id: viewedSessionId } as ProjectSession,
    currentSessionId: viewedSessionId,
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    getSessionActivity,
    requestLatestMessages,
    sessionStore,
  }), { initialProps: { viewedSessionId: VIEWED } });

  /** What the sessions watcher broadcasts once a session's transcript changed on disk. */
  const transcriptChanged = (sessionId: string) => listener?.({
    kind: 'session_upserted',
    sessionId,
    session: { id: sessionId, summary: 'Audit the frontend' },
    project: { projectId: 'project-1' },
  } as unknown as ServerEvent);

  return {
    transcriptChanged,
    reloads,
    stored,
    view: (sessionId: string) => hook.rerender({ viewedSessionId: sessionId }),
    unmount: hook.unmount,
  };
};

const cliDrivenRun: SessionActivity = { statusText: 'Running in the Claude CLI', canInterrupt: false, startedAt: 1_000 };

it('reloads the viewed transcript each time a Claude CLI CloudCLI does not drive writes to it', () => {
  const { transcriptChanged, reloads, stored } = renderHandlers({ activityBySession: { [VIEWED]: cliDrivenRun }, messagesBySession: {} });

  transcriptChanged(VIEWED);
  transcriptChanged(VIEWED);

  expect(reloads).toEqual([VIEWED, VIEWED]);
  // The event is the sidebar's to fold; nothing of it lands in the transcript.
  expect(stored).toEqual([]);
});

it('leaves a run CloudCLI drives, background work, an idle session and other sessions as they were', () => {
  const cases: Array<[Record<string, SessionActivity>, string]> = [
    // A run this server drives streams its rows live; a reload mid-stream is
    // what the sidebar's guard is there to avoid.
    [{ [VIEWED]: { statusText: 'Thinking', canInterrupt: true, startedAt: 1_000 } }, VIEWED],
    [{ [VIEWED]: { statusText: null, canInterrupt: false, startedAt: 1_000, background: true, tasks: [] } }, VIEWED],
    // An idle session is the sidebar's to reload.
    [{}, VIEWED],
    // Another session's CLI run is not on screen.
    [{ [OTHER]: cliDrivenRun }, OTHER],
  ];
  for (const [activityBySession, changedSessionId] of cases) {
    const { transcriptChanged, reloads, unmount } = renderHandlers({ activityBySession, messagesBySession: {} });
    transcriptChanged(changedSessionId);
    expect(reloads).toEqual([]);
    unmount();
  }
});

/**
 * A workflow writes its agents' progress to its own journal, under the
 * session's `subagents/` directory, which the sessions watcher ignores. While
 * the CLI ran one, the transcript itself stayed quiet, so no reload came and
 * the details panel kept the agents as they stood when the run launched.
 */
describe('a workflow the Claude CLI runs outside CloudCLI', () => {
  const TURN_AT = '2026-10-26T10:00:00.000Z';
  const LAUNCHED_AT = '2026-10-26T10:00:05.000Z';
  const NEXT_TURN_AT = '2026-10-26T11:00:00.000Z';

  const userTurn = (id: string, timestamp: string): NormalizedMessage => ({
    id,
    sessionId: VIEWED,
    timestamp,
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content: 'Audit the frontend',
  });

  /**
   * A `Workflow` call as a history load returns it: acknowledged, with the run
   * as the journal and the live-run lookup describe it (one agent done, the
   * other at work while the run goes on). Null leaves the run unreported.
   */
  const workflowLaunch = (status: WorkflowInfo['status'] | null, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => {
    const isRunning = status === 'running';
    return {
      id: 'launch-row',
      sessionId: VIEWED,
      timestamp: LAUNCHED_AT,
      provider: 'claude',
      kind: 'tool_use',
      toolName: 'Workflow',
      toolId: 'toolu_workflow_1',
      toolInput: { script: "export const meta = { name: 'frontend-architecture-audit' }", description: 'Audit the frontend' },
      toolResult: {
        content: '',
        isError: false,
        toolUseResult: { status: 'async_launched', taskId: 'wxkj4kcvd', runId: 'wf_16fbf852-274' },
      },
      ...(status ? {
        workflow: {
          runId: 'wf_16fbf852-274',
          name: 'frontend-architecture-audit',
          status,
          agents: [
            { id: 'ag1', label: 'audit:chat', status: 'completed' },
            { id: 'ag2', label: 'audit:sidebar', status: isRunning ? 'running' : 'completed' },
          ],
          agentCounts: { total: 2, completed: isRunning ? 1 : 2, failed: 0, running: isRunning ? 1 : 0, stopped: 0 },
        },
      } : {}),
      ...overrides,
    };
  };

  const runningInThisTurn = [userTurn('turn-1', TURN_AT), workflowLaunch('running')];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-reads the viewed transcript every 5 s while the CLI runs it', () => {
    const { reloads } = renderHandlers({
      activityBySession: { [VIEWED]: cliDrivenRun },
      messagesBySession: { [VIEWED]: runningInThisTurn },
    });

    vi.advanceTimersByTime(4_999);
    expect(reloads).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(reloads).toEqual([VIEWED]);
    vi.advanceTimersByTime(5_000);
    expect(reloads).toEqual([VIEWED, VIEWED]);
  });

  it('follows a run an earlier turn launched that the CLI still runs, and one just called that has not reported yet', () => {
    const transcripts: NormalizedMessage[][] = [
      // The history reader reports a run of a CLI process still up as running.
      [userTurn('turn-1', TURN_AT), workflowLaunch('running'), userTurn('turn-2', NEXT_TURN_AT)],
      // Called moments ago: no acknowledgement on disk yet.
      [userTurn('turn-1', TURN_AT), workflowLaunch(null, { toolResult: null })],
    ];
    for (const transcript of transcripts) {
      const { reloads, unmount } = renderHandlers({
        activityBySession: { [VIEWED]: cliDrivenRun },
        messagesBySession: { [VIEWED]: transcript },
      });
      vi.advanceTimersByTime(5_000);
      expect(reloads).toEqual([VIEWED]);
      unmount();
    }
  });

  /** What the CLI writes after the launch, one row each: replies, tool calls, thinking. */
  const laterRows = (count: number): NormalizedMessage[] => Array.from({ length: count }, (_, index) => ({
    id: `later-${index}`,
    sessionId: VIEWED,
    timestamp: new Date(Date.parse(LAUNCHED_AT) + (index + 1) * 1_000).toISOString(),
    provider: 'claude',
    kind: 'text',
    role: 'assistant',
    content: `Still auditing (${index + 1})`,
  }));

  it('follows a run whose launch later rows pushed out of the newest page, but not one past what a re-read reaches', () => {
    const cases: Array<[string, NormalizedMessage[], string[]]> = [
      // Out of the newest page of 20: the re-read reaches back to it.
      ['30 rows after the launch', [userTurn('turn-1', TURN_AT), workflowLaunch('running'), ...laterRows(30)], [VIEWED]],
      // The re-read reaches 150 rows back, with a row to spare for one
      // written meanwhile: the launch and the 148 after it, plus that row.
      ['148 rows after the launch', [userTurn('turn-1', TURN_AT), workflowLaunch('running'), ...laterRows(148)], [VIEWED]],
      // One more and no re-read reaches it: each tick would fetch the same
      // stale copy, so the run is not followed.
      ['149 rows after the launch', [userTurn('turn-1', TURN_AT), workflowLaunch('running'), ...laterRows(149)], []],
    ];
    for (const [what, transcript, expected] of cases) {
      const { reloads, unmount } = renderHandlers({
        activityBySession: { [VIEWED]: cliDrivenRun },
        messagesBySession: { [VIEWED]: transcript },
      });
      // A run followed past the newest page is re-read every third tick.
      vi.advanceTimersByTime(15_000);
      expect(reloads, what).toEqual(expected);
      unmount();
    }
  });

  it('re-reads a run within the newest page every 5 s, and one further back every 15 s', () => {
    const withinPage = renderHandlers({
      activityBySession: { [VIEWED]: cliDrivenRun },
      messagesBySession: { [VIEWED]: [userTurn('turn-1', TURN_AT), workflowLaunch('running'), ...laterRows(10)] },
    });
    vi.advanceTimersByTime(15_000);
    expect(withinPage.reloads).toEqual([VIEWED, VIEWED, VIEWED]);
    withinPage.unmount();

    // Every re-read of this one re-sends the 32 rows from its launch on.
    const furtherBack = renderHandlers({
      activityBySession: { [VIEWED]: cliDrivenRun },
      messagesBySession: { [VIEWED]: [userTurn('turn-1', TURN_AT), workflowLaunch('running'), ...laterRows(30)] },
    });
    vi.advanceTimersByTime(10_000);
    expect(furtherBack.reloads).toEqual([]);
    vi.advanceTimersByTime(5_000);
    expect(furtherBack.reloads).toEqual([VIEWED]);
    vi.advanceTimersByTime(15_000);
    expect(furtherBack.reloads).toEqual([VIEWED, VIEWED]);
    furtherBack.unmount();
  });

  it('stops once the workflow is over, once the CLI\'s turn is, and when the view moves to another session or closes', () => {
    const stops: Array<[string, (harness: Harness, rendered: ReturnType<typeof renderHandlers>) => void]> = [
      ['the workflow ends', (harness) => {
        harness.messagesBySession[VIEWED] = [userTurn('turn-1', TURN_AT), workflowLaunch('completed')];
      }],
      ['the turn ends and the session goes idle', (harness) => {
        delete harness.activityBySession[VIEWED];
      }],
      ['the turn ends and the session goes on with background work', (harness) => {
        harness.activityBySession[VIEWED] = { statusText: null, canInterrupt: false, startedAt: 1_000, background: true, tasks: [] };
      }],
      ['the view moves to another session', (_harness, rendered) => {
        rendered.view(OTHER);
      }],
      ['the view closes', (_harness, rendered) => {
        rendered.unmount();
      }],
    ];
    for (const [what, stop] of stops) {
      const harness: Harness = {
        activityBySession: { [VIEWED]: cliDrivenRun, [OTHER]: cliDrivenRun },
        messagesBySession: { [VIEWED]: runningInThisTurn },
      };
      const rendered = renderHandlers(harness);
      vi.advanceTimersByTime(5_000);
      expect(rendered.reloads, what).toEqual([VIEWED]);

      stop(harness, rendered);
      vi.advanceTimersByTime(15_000);
      expect(rendered.reloads, what).toEqual([VIEWED]);
      rendered.unmount();
    }
  });

  it('never re-reads a run CloudCLI drives, background work, an idle session, a session not on screen, or a transcript with no workflow running', () => {
    const quiet: Array<[string, Harness]> = [
      // Its rows stream in live.
      ['a run CloudCLI drives', {
        activityBySession: { [VIEWED]: { statusText: 'Thinking', canInterrupt: true, startedAt: 1_000 } },
        messagesBySession: { [VIEWED]: runningInThisTurn },
      }],
      ['background work', {
        activityBySession: { [VIEWED]: { statusText: null, canInterrupt: false, startedAt: 1_000, background: true, tasks: [] } },
        messagesBySession: { [VIEWED]: runningInThisTurn },
      }],
      ['an idle session', { activityBySession: {}, messagesBySession: { [VIEWED]: runningInThisTurn } }],
      ['another session\'s CLI run', {
        activityBySession: { [OTHER]: cliDrivenRun },
        messagesBySession: { [OTHER]: runningInThisTurn },
      }],
      ['no workflow', { activityBySession: { [VIEWED]: cliDrivenRun }, messagesBySession: { [VIEWED]: [userTurn('turn-1', TURN_AT)] } }],
      ['a workflow that is over', {
        activityBySession: { [VIEWED]: cliDrivenRun },
        messagesBySession: { [VIEWED]: [userTurn('turn-1', TURN_AT), workflowLaunch('completed')] },
      }],
      // An earlier turn's call its process never answered: no run to follow.
      ['an unanswered call from an earlier turn', {
        activityBySession: { [VIEWED]: cliDrivenRun },
        messagesBySession: {
          [VIEWED]: [userTurn('turn-1', TURN_AT), workflowLaunch(null, { toolResult: null }), userTurn('turn-2', NEXT_TURN_AT)],
        },
      }],
    ];
    for (const [what, harness] of quiet) {
      const { reloads, unmount } = renderHandlers(harness);
      vi.advanceTimersByTime(15_000);
      expect(reloads, what).toEqual([]);
      unmount();
    }
  });
});
