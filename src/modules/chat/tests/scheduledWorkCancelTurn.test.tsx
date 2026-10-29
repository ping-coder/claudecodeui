import React, { forwardRef, useImperativeHandle } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import { BackgroundTasksStrip } from '@/modules/chat/transcript/BackgroundTasksStrip';
import { isCliDrivenActivity } from '@/modules/chat/utils/runProgress';
import {
  SessionProtectionProvider,
  useProcessingSessions,
  useSessionProtectionActions,
} from '@/shared/context/SessionProtectionContext';
import type { ScheduledWorkSummary } from '@/shared/types';

/*
 * A stop of a held /loop that needs a turn runs that turn detached from any
 * pane, and the page learns of it from the stop's `started` answer and from
 * the running-sessions poll. Either way it is a turn CloudCLI runs, which the
 * pane can stop, never one the Claude CLI drives outside CloudCLI. Real
 * activity map, strip and activity indicator; the poll's HTTP read and the
 * shared socket are stand-ins.
 */

const page = vi.hoisted(() => {
  const listeners = new Set<(frame: Record<string, unknown>) => void>();
  return {
    listeners,
    sessions: [] as unknown[],
    subscribe: (listener: (frame: Record<string, unknown>) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (frame: Record<string, unknown>) => {
      for (const listener of [...listeners]) {
        listener(frame);
      }
    },
  };
});

vi.mock('@/shared/api', () => ({
  api: {
    runningSessions: async () => ({ ok: true, json: async () => ({ data: { sessions: page.sessions } }) }),
  },
}));

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: page.subscribe }),
}));

afterEach(() => {
  page.listeners.clear();
  page.sessions = [];
});

const SESSION_ID = 'session-1';
const T0 = Date.now() - 10 * 60_000;
const loop: ScheduledWorkSummary = {
  id: 'cron:aaaaaaaa',
  kind: 'cron',
  toolUseId: 'toolu_cron_aaaaaaaa',
  prompt: 'check CI',
  startedAt: T0,
  nextFireAt: Date.now() + 4 * 60_000,
  recurring: true,
  holdUntil: T0 + 691_200_000,
  cron: '*/5 * * * *',
  cadence: 'Every 5 minutes',
};

// What the server lists: the loop alone, then the cancelling turn's run (which carries no canInterrupt).
const LOOP_ALONE = [{ sessionId: SESSION_ID, provider: 'claude', startedAt: T0, lastSeq: 3, background: true, canInterrupt: false, tasks: [], scheduled: [loop] }];
const CANCELLING_TURN = [{ sessionId: SESSION_ID, provider: 'claude', startedAt: Date.now() - 2_000, lastSeq: 2, scheduled: [loop] }];

type Handle = { refresh: () => Promise<void> };

// The pane, wired as ChatInterface, useChatSessionState and useChatComposerState wire it.
const Pane = forwardRef<Handle, { sendMessage: (message: unknown) => void }>(({ sendMessage }, ref) => {
  const processingSessions = useProcessingSessions();
  const { refreshRunningSessions } = useSessionProtectionActions();
  useImperativeHandle(ref, () => ({ refresh: refreshRunningSessions }), [refreshRunningSessions]);

  const activity = processingSessions.get(SESSION_ID) ?? null;
  const isProcessing = activity !== null && !activity.background;
  const canAbortSession = isProcessing && activity.canInterrupt;
  const canStopBackgroundTasks = activity !== null && !isCliDrivenActivity(activity);
  const handleAbortSession = () => {
    if (canAbortSession) {
      sendMessage({ type: 'chat.abort', sessionId: SESSION_ID });
    }
  };

  return (
    <div>
      <div data-testid="strip">
        <BackgroundTasksStrip
          messages={[]}
          tasks={activity?.tasks}
          scheduled={activity?.scheduled}
          sessionId={SESSION_ID}
          canStopTasks={canStopBackgroundTasks}
          isTurnRunning={isProcessing}
          sendMessage={sendMessage}
          onReveal={() => {}}
          onLoadAll={() => {}}
        />
      </div>
      <div data-testid="indicator">
        <ActivityIndicator activity={activity} onAbort={handleAbortSession} />
      </div>
      <output data-testid="state">
        {JSON.stringify({ isProcessing, canAbortSession: Boolean(canAbortSession), isCliDriven: isCliDrivenActivity(activity) })}
      </output>
    </div>
  );
});
Pane.displayName = 'Pane';

const readState = () => JSON.parse(screen.getByTestId('state').textContent || '{}') as Record<string, boolean>;
const indicatorStop = () => within(screen.getByTestId('indicator')).queryByRole('button', { name: 'Stop' });

async function renderPane() {
  await i18n.changeLanguage('en');
  const sent: Array<Record<string, unknown>> = [];
  const ref = React.createRef<Handle>();
  page.sessions = LOOP_ALONE;
  render(
    <SessionProtectionProvider>
      <Pane ref={ref} sendMessage={(message) => sent.push(message as Record<string, unknown>)} />
    </SessionProtectionProvider>,
  );
  // The mount read lists the loop: background work, with a ✕ on its chip.
  await waitFor(() => expect(within(screen.getByTestId('strip')).queryAllByRole('button', { name: 'Stop' }).length).toBe(1));
  const poll = async (sessions: unknown[]) => {
    page.sessions = sessions;
    await act(async () => {
      await ref.current?.refresh();
    });
  };
  return { sent, poll };
}

it('the turn a stop starts is a turn the asking pane can stop, from its started answer on, and still once the poll lists it', async () => {
  const { sent, poll } = await renderPane();
  const strip = screen.getByTestId('strip');
  fireEvent.click(within(strip).getByRole('button', { name: 'Stop' }));
  fireEvent.click(within(within(strip).getByRole('group', { name: 'Stop' })).getByRole('button', { name: 'Stop' }));
  const stop = sent.find((frame) => frame.type === 'chat.stop-task');
  expect(stop?.taskId).toBe('cron:aaaaaaaa');

  act(() => {
    page.emit({ kind: 'stop_task_status', sessionId: SESSION_ID, taskId: 'cron:aaaaaaaa', status: 'started', clientRequestId: stop?.clientRequestId });
  });
  expect(readState()).toEqual({ isProcessing: true, canAbortSession: true, isCliDriven: false });
  expect(indicatorStop() !== null).toBe(true);

  await poll(CANCELLING_TURN);
  expect(readState()).toEqual({ isProcessing: true, canAbortSession: true, isCliDriven: false });
  fireEvent.click(indicatorStop()!);
  expect(sent.some((frame) => frame.type === 'chat.abort')).toBe(true);
});

it('a turn the poll lists where the map had only the loop is one the pane can stop', async () => {
  // A due message, or another tab's send, into the process the loop holds.
  const { poll } = await renderPane();

  await poll(CANCELLING_TURN);
  expect(readState()).toEqual({ isProcessing: true, canAbortSession: true, isCliDriven: false });
  expect(indicatorStop() !== null).toBe(true);
  expect(within(screen.getByTestId('strip')).queryAllByText('check CI').length).toBe(1);
});

it('a turn of the Claude CLI outside CloudCLI, listed where the map had only the loop, stays one the pane cannot stop', async () => {
  const { poll } = await renderPane();

  await poll([{ sessionId: SESSION_ID, provider: 'claude', startedAt: Date.now() - 1_000, lastSeq: 3, canInterrupt: false, statusText: 'Running in the Claude CLI' }]);
  expect(readState()).toEqual({ isProcessing: true, canAbortSession: false, isCliDriven: true });
  expect(indicatorStop() === null).toBe(true);
});
