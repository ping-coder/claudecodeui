import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { usePausedScheduledWork } from '@/modules/chat/hooks/usePausedScheduledWork';
import { BackgroundTasksStrip } from '@/modules/chat/transcript/BackgroundTasksStrip';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { describeScheduledTiming, stopReleasesProcess } from '@/modules/chat/utils/scheduledWork';
import { SessionProtectionProvider } from '@/shared/context/SessionProtectionContext';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, ScheduledWorkSummary } from '@/shared/types';
import { parseScheduledWork } from '@/shared/utils';

/*
 * A restart of the server ends the Claude processes it held for loops. Their
 * loops wait in the transcript, paused: the strip lists them as such, stops
 * them in a turn of a new process, and resumes them all with one turn; the
 * turn that resumes them reads as a note. The HTTP reads and the shared
 * socket are stand-ins.
 */

const page = vi.hoisted(() => {
  const listeners = new Set<(frame: Record<string, unknown>) => void>();
  return {
    listeners,
    paused: [] as unknown[],
    pausedReads: [] as string[],
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
    runningSessions: async () => ({ ok: true, json: async () => ({ data: { sessions: [] } }) }),
    pausedScheduledWork: async (sessionId: string) => {
      page.pausedReads.push(sessionId);
      return { ok: true, json: async () => ({ data: { scheduled: page.paused } }) };
    },
  },
}));

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: page.subscribe }),
}));

afterEach(async () => {
  page.listeners.clear();
  page.paused = [];
  page.pausedReads = [];
  await act(async () => { await i18n.changeLanguage('en'); });
});

const SESSION_ID = 'session-paused';
const T0 = Date.now() - 60 * 60_000;
const pausedLoop: ScheduledWorkSummary = {
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
  paused: true,
};
const pausedWakeup: ScheduledWorkSummary = {
  id: 'wakeup:toolu_w',
  kind: 'wakeup',
  toolUseId: 'toolu_w',
  prompt: '/loop',
  startedAt: T0 + 1,
  nextFireAt: Date.now() - 60_000,
  recurring: true,
  holdUntil: T0 + 691_200_000,
  paused: true,
};

function renderStrip(
  { paused = [pausedLoop, pausedWakeup], isTurnRunning = false }: { paused?: ScheduledWorkSummary[]; isTurnRunning?: boolean } = {},
) {
  const sent: Array<Record<string, unknown>> = [];
  const refreshes: number[] = [];
  const view = render(
    <SessionProtectionProvider>
      <BackgroundTasksStrip
        messages={[]}
        paused={paused}
        onPausedChange={() => { refreshes.push(Date.now()); }}
        buildResumeOptions={() => ({ model: 'sonnet', permissionMode: 'default' })}
        sessionId={SESSION_ID}
        // Nothing runs in the session: CloudCLI's runtime drives none of it.
        canStopTasks={false}
        isTurnRunning={isTurnRunning}
        sendMessage={(message) => { sent.push(message as Record<string, unknown>); }}
        onReveal={() => {}}
        onLoadAll={() => {}}
      />
    </SessionProtectionProvider>,
  );
  return { ...view, sent, refreshes };
}

describe('paused loops in the background-tasks strip', () => {
  it('reads paused in the interface language, with the loop\'s cadence', async () => {
    const strip = renderStrip({ paused: [pausedLoop] });
    const status = screen.getByRole('status');
    assert.equal(within(status).getByText(/Paused \(no process running\)/).textContent?.includes('Every 5 minutes'), true);
    strip.unmount();

    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    renderStrip({ paused: [pausedLoop] });
    assert.equal(screen.getByRole('status').textContent?.includes('已暂停（没有进程在跑）'), true);
    assert.equal(screen.getByRole('button', { name: /恢复/ }) !== null, true);
  });

  it('resumes them all with one chat.resume-loops carrying the composer\'s settings, and says why when the server did not', async () => {
    const { sent } = renderStrip();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));

    assert.equal(sent.length, 1);
    const [resume] = sent;
    assert.deepEqual([resume.type, resume.sessionId, resume.options], ['chat.resume-loops', SESSION_ID, { model: 'sonnet', permissionMode: 'default' }]);
    assert.equal(typeof resume.clientRequestId, 'string');
    assert.equal(screen.getByRole('status').textContent?.includes('Resuming…'), true);

    // Another pane's answer is not this strip's.
    act(() => page.emit({ kind: 'resume_loops_status', sessionId: SESSION_ID, status: 'busy', clientRequestId: 'resume_other' }));
    assert.equal(screen.getByRole('status').textContent?.includes('Resuming…'), true);

    act(() => page.emit({ kind: 'resume_loops_status', sessionId: SESSION_ID, status: 'busy', clientRequestId: resume.clientRequestId }));
    assert.equal(screen.getByRole('status').textContent?.includes('Resume them after this turn ends'), true);

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    const second = sent[1];
    act(() => page.emit({ kind: 'resume_loops_status', sessionId: SESSION_ID, status: 'held_elsewhere', clientRequestId: second.clientRequestId }));
    await waitFor(() => {
      assert.equal(screen.getByRole('status').textContent?.includes('Another Claude CLI holds this session and runs its loops.'), true);
    });
  });

  it('waits for a turn under way rather than resume during it', () => {
    const { sent } = renderStrip({ isTurnRunning: true });
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    assert.deepEqual(sent, []);
    assert.equal(screen.getByRole('status').textContent?.includes('Resume them after this turn ends'), true);
  });

  it('stops a paused loop in a turn, though no process runs the session, and reads the paused loops again once it is done', async () => {
    const { sent, refreshes } = renderStrip();
    const [stopLoop] = screen.getAllByRole('button', { name: 'Stop' });
    fireEvent.click(stopLoop);
    const question = screen.getByRole('group', { name: 'Stop' });
    assert.equal(question.textContent?.includes('CloudCLI runs one turn'), true, 'no process to let go of: a turn it is');
    fireEvent.click(within(question).getByRole('button', { name: 'Stop' }));

    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0].type, sent[0].taskId], ['chat.stop-task', 'cron:aaaaaaaa']);
    act(() => page.emit({ kind: 'stop_task_status', sessionId: SESSION_ID, taskId: 'cron:aaaaaaaa', status: 'finished', stillHeld: false, clientRequestId: sent[0].clientRequestId }));
    await waitFor(() => {
      assert.equal(refreshes.length, 1);
    });
  });

  it('a paused item\'s timing and stop follow the paused state', () => {
    const t = i18n.getFixedT('en', 'chat');
    assert.deepEqual(describeScheduledTiming(pausedWakeup, Date.now(), t, 'en'), ['Paused (no process running)', 'Self-paced']);
    assert.deepEqual(describeScheduledTiming({ ...pausedLoop, recurring: false }, Date.now(), t, 'en'), ['Paused (no process running)']);
    assert.equal(stopReleasesProcess([pausedWakeup], [pausedWakeup], false), false);
    assert.equal(stopReleasesProcess([{ ...pausedWakeup, paused: undefined }], [], false), true);
    assert.deepEqual(parseScheduledWork([pausedLoop, { ...pausedLoop, id: 'cron:bbbbbbbb', paused: 'yes' }])?.map((item) => item.paused), [true, undefined]);
  });
});

function PausedProbe({ sessionId, enabled }: { sessionId: string | null; enabled: boolean }) {
  const { items } = usePausedScheduledWork(sessionId, enabled);
  return <output data-testid="paused">{items.map((item) => item.id).join(',')}</output>;
}

describe('usePausedScheduledWork', () => {
  it('reads a session\'s paused loops while it is idle, again after its run ends, and lists none while a process holds it', async () => {
    page.paused = [pausedLoop];
    const view = render(<PausedProbe sessionId={SESSION_ID} enabled />);
    await waitFor(() => {
      assert.equal(screen.getByTestId('paused').textContent, 'cron:aaaaaaaa');
    });
    assert.deepEqual(page.pausedReads, [SESSION_ID]);

    page.paused = [];
    await act(async () => { page.emit({ kind: 'run_ended', sessionId: SESSION_ID }); });
    await waitFor(() => {
      assert.equal(screen.getByTestId('paused').textContent, '');
    });
    assert.equal(page.pausedReads.length, 2);

    // Another session's run ending is not this one's.
    await act(async () => { page.emit({ kind: 'run_ended', sessionId: 'other' }); });
    assert.equal(page.pausedReads.length, 2);

    page.paused = [pausedLoop];
    view.rerender(<PausedProbe sessionId={SESSION_ID} enabled={false} />);
    assert.equal(screen.getByTestId('paused').textContent, '');
    await act(async () => { page.emit({ kind: 'run_ended', sessionId: SESSION_ID }); });
    assert.equal(page.pausedReads.length, 2, 'a held session is not read');
  });
});

describe('the note of the turn that resumed loops', () => {
  it('says how many loops CloudCLI resumed, in the interface language, and not why they had stopped', async () => {
    const note: ChatMessage = {
      type: 'assistant',
      content: 'Resumed 2 loops',
      timestamp: '2026-10-30T10:00:00.000Z',
      controlNote: { kind: 'loops-resume', count: 2, jobIds: ['b2148320'], wakeup: true },
    };
    const renderNote = () => render(
      <UiPreferencesProvider>
        <MessageComponent message={note} prevMessage={null} createDiff={() => []} provider="claude" />
      </UiPreferencesProvider>,
    );
    const english = renderNote();
    assert.equal(english.container.textContent?.includes('Resumed 2 loops'), true);
    assert.equal(english.container.textContent?.includes('restart'), false);
    assert.equal(english.container.querySelector('[title]')?.getAttribute('title'), 'b2148320');
    english.unmount();

    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    const chinese = renderNote().container.textContent ?? '';
    assert.equal(chinese.includes('恢复了 2 个循环'), true);
    assert.equal(chinese.includes('重启'), false);
  });
});
