import { renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage, ProjectSession, ServerEvent, SessionActivity } from '@/shared/types';

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

const renderHandlers = (activityBySession: Record<string, SessionActivity>) => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const reloads: string[] = [];
  const stored: NormalizedMessage[] = [];

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: VIEWED } as ProjectSession,
    currentSessionId: VIEWED,
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    getSessionActivity: (sessionId) => activityBySession[sessionId],
    requestLatestMessages: async (sessionId) => { reloads.push(sessionId); },
    sessionStore: {
      appendRealtime: (_sessionId: string, message: NormalizedMessage) => { stored.push(message); },
      getMessages: () => stored,
      updateStreaming: () => {},
      finalizeStreaming: () => {},
    } as unknown as SessionStore,
  }));

  /** What the sessions watcher broadcasts once a session's transcript changed on disk. */
  const transcriptChanged = (sessionId: string) => listener?.({
    kind: 'session_upserted',
    sessionId,
    session: { id: sessionId, summary: 'Audit the frontend' },
    project: { projectId: 'project-1' },
  } as unknown as ServerEvent);

  return { transcriptChanged, reloads, stored };
};

const cliDrivenRun: SessionActivity = { statusText: 'Running in the Claude CLI', canInterrupt: false, startedAt: 1_000 };

it('reloads the viewed transcript each time a Claude CLI CloudCLI does not drive writes to it', () => {
  const { transcriptChanged, reloads, stored } = renderHandlers({ [VIEWED]: cliDrivenRun });

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
    [{ 'other-session': cliDrivenRun }, 'other-session'],
  ];
  for (const [activityBySession, changedSessionId] of cases) {
    const { transcriptChanged, reloads } = renderHandlers(activityBySession);
    transcriptChanged(changedSessionId);
    expect(reloads).toEqual([]);
  }
});
