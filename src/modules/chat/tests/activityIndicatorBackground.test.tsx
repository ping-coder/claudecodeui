import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import type { BackgroundTaskSummary, ScheduledWorkSummary, SessionActivity } from '@/shared/types';

/**
 * The pill above the composer used to vanish at the turn's `complete` even
 * when the CLI stayed open for the agents, workflows or commands the turn
 * launched. A background-only entry now keeps it up, named for the work and
 * in the purple of the workflow and agent cards — with no Stop, because
 * nothing is responding and the composer can send.
 */

const task = (overrides: Partial<BackgroundTaskSummary> = {}): BackgroundTaskSummary => ({
  taskId: 'wxkj4kcvd',
  toolUseId: 'toolu_workflow_1',
  taskType: 'local_workflow',
  description: 'Audit the frontend',
  workflowName: 'frontend-architecture-audit',
  startedAt: Date.now() - 65_000,
  ...overrides,
});

const backgroundActivity = (tasks: BackgroundTaskSummary[]): SessionActivity => ({
  statusText: null,
  canInterrupt: false,
  startedAt: Math.min(...tasks.map((entry) => entry.startedAt)),
  background: true,
  tasks,
});

test('a background-only session names its workflow, counts from its start and offers no Stop', () => {
  const onAbort = vi.fn();
  const { container } = render(<ActivityIndicator activity={backgroundActivity([task()])} onAbort={onAbort} />);

  assert.match(container.textContent ?? '', /Background work…/);
  assert.match(container.textContent ?? '', /Workflow frontend-architecture-audit/);
  assert.match(container.textContent ?? '', /1m 5s/, 'elapsed since the task started, not since the pill mounted');
  assert.equal(screen.queryByRole('button', { name: 'Stop' }) === null, true);
  assert.ok(container.querySelector('.bg-purple-500'), 'the dot is the cards\' purple, not the primary colour');
});

test('an agent and a command are named by what they were asked to do; several tasks by their count', () => {
  const agent = render(
    <ActivityIndicator activity={backgroundActivity([task({ taskType: 'local_agent', description: 'Survey the repo', workflowName: undefined })])} />,
  );
  assert.match(agent.container.textContent ?? '', /Agent Survey the repo/);
  agent.unmount();

  const command = render(
    <ActivityIndicator activity={backgroundActivity([task({ taskType: 'local_bash', description: 'npm test', workflowName: undefined })])} />,
  );
  assert.match(command.container.textContent ?? '', /Command npm test/);
  command.unmount();

  const several = render(
    <ActivityIndicator activity={backgroundActivity([task(), task({ taskId: 'b5xsbzu5k', toolUseId: 'toolu_bash_1', taskType: 'local_bash' })])} />,
  );
  assert.match(several.container.textContent ?? '', /2 tasks/);
  several.unmount();

  // A workflow agent's own backgrounded command is listed (it can be stopped)
  // but it is the agent's business, not a second task of the session's.
  const nested = render(
    <ActivityIndicator activity={backgroundActivity([task(), task({ taskId: 'b5xsbzu5k', toolUseId: 'toolu_bash_1', taskType: 'local_bash', nested: true })])} />,
  );
  assert.match(nested.container.textContent ?? '', /Workflow frontend-architecture-audit/);
  assert.doesNotMatch(nested.container.textContent ?? '', /2 tasks/);
});

test('a response in flight still shows the Stop button and the primary dot', () => {
  const { container } = render(
    <ActivityIndicator
      activity={{ statusText: 'Thinking', canInterrupt: true, startedAt: Date.now() }}
      onAbort={() => {}}
    />,
  );

  assert.ok(screen.getByRole('button', { name: 'Stop' }));
  assert.ok(container.querySelector('.bg-primary'));
  assert.equal(container.querySelector('.bg-purple-500') === null, true);
});

const loop = (overrides: Partial<ScheduledWorkSummary> = {}): ScheduledWorkSummary => ({
  id: 'cron:b2148320',
  kind: 'cron',
  toolUseId: 'toolu_cron_1',
  prompt: 'check CI',
  startedAt: Date.now() - 125_000,
  nextFireAt: Date.now() + 60_000,
  recurring: true,
  holdUntil: Date.now() + 8 * 86_400_000,
  cron: '*/5 * * * *',
  ...overrides,
});

const scheduledActivity = (scheduled: ScheduledWorkSummary[], tasks: BackgroundTaskSummary[] = []): SessionActivity => ({
  statusText: null,
  canInterrupt: false,
  startedAt: Math.min(...tasks.map((entry) => entry.startedAt), ...scheduled.map((item) => item.startedAt)),
  background: true,
  tasks,
  scheduled,
});

test('scheduled work alone is named by its one loop or reminder, or counted, never as "0 tasks"', () => {
  const one = render(<ActivityIndicator activity={scheduledActivity([loop()])} />);
  assert.match(one.container.textContent ?? '', /Background work…/);
  assert.match(one.container.textContent ?? '', /Loop check CI/);
  assert.match(one.container.textContent ?? '', /2m 5s/, 'timed from the loop\'s start');
  assert.doesNotMatch(one.container.textContent ?? '', /tasks/);
  one.unmount();

  const reminder = render(<ActivityIndicator activity={scheduledActivity([loop({ recurring: false, prompt: 'stretch' })])} />);
  assert.match(reminder.container.textContent ?? '', /Reminder stretch/);
  reminder.unmount();

  const loops = render(<ActivityIndicator activity={scheduledActivity([loop(), loop({ id: 'wakeup:toolu_wake_1', kind: 'wakeup' })])} />);
  assert.match(loops.container.textContent ?? '', /2 loops/);
  loops.unmount();

  const mixed = render(<ActivityIndicator activity={scheduledActivity([loop(), loop({ id: 'cron:7b7cd8fc', recurring: false })])} />);
  assert.match(mixed.container.textContent ?? '', /2 scheduled items/);
});

test('tasks alone say nothing of scheduled work', () => {
  const { container } = render(<ActivityIndicator activity={backgroundActivity([task()])} />);
  assert.equal(container.querySelector('[data-fit-detail]')?.getAttribute('title'), 'Workflow frontend-architecture-audit');
});

test('tasks and scheduled work together read as the tasks, then how much scheduled work', () => {
  const { container } = render(<ActivityIndicator activity={scheduledActivity([loop()], [task()])} />);
  assert.match(container.textContent ?? '', /Workflow frontend-architecture-audit · 1 loop/);
});
