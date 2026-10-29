import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { X } from 'lucide-react';

import type { BackgroundTaskSummary, ChatMessage, ScheduledWorkSummary } from '@/shared/types';
import { ownBackgroundTasks } from '@/shared/utils';
import {
  describeWorkflowAgent,
  findCurrentWorkflowAgent,
  listRunningBackgroundLaunches,
  readBackgroundTaskId,
  readBackgroundTaskStatus,
} from '@/modules/chat/utils/backgroundTasks';
import { parseToolPayload } from '@/modules/chat/utils/messageTransforms';
import { parseWorkflowMeta } from '@/modules/chat/utils/workflowScriptMeta';
import { ScheduledWorkChips } from '@/modules/chat/transcript/ScheduledWorkChips';

type BackgroundTasksStripProps = {
  /** Every loaded row of the session, not the visible window: a task launched pages ago is still running. */
  messages: ChatMessage[];
  /**
   * The session's running tasks as the activity map has them — from the
   * running-sessions poll after a reload, or the rows themselves once the
   * turn ended. A task whose launch row is on a page not loaded yet has no
   * row to draw from and is listed from here, so it can still be stopped.
   */
  tasks?: BackgroundTaskSummary[];
  /**
   * The scheduled work (loops, reminders) the session's held process keeps,
   * as the activity map has it from the server; listed after the tasks.
   */
  scheduled?: ScheduledWorkSummary[];
  /** The session the tasks belong to, which `chat.stop-task` names; null before one exists. */
  sessionId: string | null;
  /**
   * Whether CloudCLI's own runtime drives the session's run: a turn sent from
   * here, or the background work such a turn left running. Only that runtime
   * can stop a task (`chat.stop-task` reaches the SDK session that launched
   * it, and anything else is refused as NO_SUCH_TASK), so a row's chip offers
   * its ✕ only then. False for a turn a Claude CLI outside CloudCLI drives (a
   * Shell tab's `claude --resume`, another CloudCLI instance), whose launches
   * a history load can read as running, and for a session with no activity,
   * where nothing here runs.
   */
  canStopTasks: boolean;
  /** A turn runs in the session, which holds back a stop of its scheduled work until it is over. */
  isTurnRunning?: boolean;
  /** The chat websocket's send, for stopping a task. */
  sendMessage: (message: unknown) => void;
  /**
   * Brings a row into view. Owned by the pane's session state because the
   * row may sit outside the visible window or in an unmounted lazy row, so
   * it takes more than an element lookup to reach it.
   */
  onReveal: (message: ChatMessage) => void;
  /** Loads the rest of the transcript, for a task whose launch row is not loaded yet. */
  onLoadAll: () => void;
};

/** The one-line description the launch was given, as the card reads it. */
function readLaunchDescription(message: ChatMessage): string {
  if (message.workflow?.description) {
    return message.workflow.description;
  }
  const input = parseToolPayload(message.toolInput);
  const { description, script } = input && typeof input === 'object'
    ? (input as { description?: unknown; script?: unknown })
    : { description: undefined, script: undefined };
  if (typeof description === 'string' && description) {
    return description;
  }
  // The CLI sets a workflow's description in the script's `meta` header, not
  // in the tool input, and reports it back as the run's first summary.
  return typeof script === 'string' ? parseWorkflowMeta(script).description ?? '' : '';
}

/** What one running task's chip says: its kind, its name, and how far it has got. */
function describeTask(message: ChatMessage, t: TFunction) {
  const live = message.taskStatus;
  const name = message.toolName === 'Workflow'
    ? message.workflow?.name || live?.workflowName || ''
    : message.subagent?.description || live?.description || '';
  const kind = message.toolName === 'Workflow'
    ? t('workflow.title', 'Workflow')
    : message.toolName === 'Bash'
      ? t('workflow.backgroundCommand', 'Command')
      : t('workflow.backgroundAgent', 'Agent');

  // A workflow reports on each agent it spawned — "2/6 agents · audit:sidebar"
  // says how many have finished and the one it is on. Short of that, its own
  // summary, unless it merely restates the launch's description (a workflow's
  // progress opens with it) or the chip's name — that says nothing new and it
  // is long. An agent reports only what it has spent. The history-loaded agent
  // counts stand in for a workflow the live stream has not described yet.
  let agentsProgress = '';
  if (live?.agents?.length) {
    const finished = live.agents.filter((agent) => agent.state === 'done' || agent.state === 'failed').length;
    const current = findCurrentWorkflowAgent(live.agents);
    agentsProgress = t('workflow.agentsProgress', { finished, count: live.agents.length, defaultValue_one: '{{finished}}/{{count}} agent', defaultValue_other: '{{finished}}/{{count}} agents' });
    if (current) {
      agentsProgress += ` · ${describeWorkflowAgent(current)}`;
    }
  }
  const description = readLaunchDescription(message);
  const summary = live?.summary && live.summary !== description && live.summary !== name ? live.summary : '';
  const progress = agentsProgress
    || summary
    || (live?.usage ? t('chat:claudeStatus.backgroundTask.toolUses', { count: live.usage.toolUses }) : '')
    || (message.workflow && message.workflow.agentCounts.total > 0
      ? `${message.workflow.agentCounts.completed + message.workflow.agentCounts.failed}/${message.workflow.agentCounts.total}`
      : '');

  return { kind, name, progress };
}

/**
 * Rendered by chat's ChatMessagesPane above the transcript: one chip per
 * background task — workflow, agent or command — that is still running, each
 * scrolling to its card when clicked. A task CloudCLI's runtime tracks is
 * stoppable from its ✕; one a Claude CLI outside CloudCLI runs is listed
 * without one, as only that CLI can stop it. The session's scheduled work
 * follows the tasks (see ScheduledWorkChips). Renders nothing while nothing
 * runs or waits, which is most of the time.
 */
export const BackgroundTasksStrip = memo(({ messages, tasks, scheduled, sessionId, canStopTasks, isTurnRunning = false, sendMessage, onReveal, onLoadAll }: BackgroundTasksStripProps) => {
  const { t } = useTranslation();
  const running = listRunningBackgroundLaunches(messages);
  // A loaded row that has a word on its task — settled or not — is the word;
  // a task whose row is not loaded, or is loaded without one (a backgrounded
  // command's launch row from history says nothing until the poll does), is
  // drawn from the map.
  const settledToolIds = new Set(
    messages.filter((message) => readBackgroundTaskStatus(message) !== undefined).map((message) => message.toolId),
  );
  const fromMap = ownBackgroundTasks(tasks ?? []).filter((task) => !settledToolIds.has(task.toolUseId));

  const scheduledWork = scheduled ?? [];

  if (running.length === 0 && fromMap.length === 0 && scheduledWork.length === 0) {
    return null;
  }

  return (
    <div
      role="status"
      aria-label={t('workflow.backgroundTasks', 'Background tasks')}
      className="flex max-w-full flex-wrap items-center gap-1.5 rounded-md border border-border/60 bg-background/95 px-2 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur"
    >
      {running.map((message) => {
        const { kind, name, progress } = describeTask(message, t);
        const taskId = readBackgroundTaskId(message);
        const title = [kind, name, progress].filter(Boolean).join(' · ');
        return (
          <span key={message.toolId} className="flex min-w-0 max-w-full items-center">
            <button
              type="button"
              onClick={() => onReveal(message)}
              title={title}
              className="flex min-w-0 max-w-xs items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
            >
              <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-purple-500 dark:bg-purple-400" />
              <span className="flex-shrink-0 font-medium text-foreground">{kind}</span>
              {/* bidi-auto: right to left, a task's name keeps its own order and is cut at its end. */}
              {name && <span className="bidi-auto min-w-0 truncate">{name}</span>}
              {progress && <span className="min-w-0 truncate text-muted-foreground/70">· {progress}</span>}
            </button>
            {canStopTasks && sessionId && taskId && (
              <button
                type="button"
                onClick={() => sendMessage({ type: 'chat.stop-task', sessionId, taskId })}
                aria-label={t('workflow.stopTask', 'Stop')}
                title={t('workflow.stopTask', 'Stop')}
                className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        );
      })}
      {fromMap.map((task) => {
        const kind = task.taskType === 'local_workflow'
          ? t('workflow.title', 'Workflow')
          : task.taskType === 'local_bash'
            ? t('workflow.backgroundCommand', 'Command')
            : t('workflow.backgroundAgent', 'Agent');
        const name = task.workflowName ?? task.description;
        const label = (
          <>
            <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-purple-500 dark:bg-purple-400" />
            <span className="flex-shrink-0 font-medium text-foreground">{kind}</span>
            {name && <span className="bidi-auto min-w-0 truncate">{name}</span>}
          </>
        );
        return (
          <span key={task.taskId} className="flex min-w-0 max-w-full items-center">
            {task.nested ? (
              // Launched by one of the session's agents: its row is in that
              // agent's transcript, so no page of this one will ever hold it.
              <span
                title={`${[kind, name].filter(Boolean).join(' · ')} · ${t('workflow.taskOfAgent', 'Launched by one of this session\'s agents')}`}
                className="flex min-w-0 max-w-xs items-center gap-1.5 rounded px-1.5 py-0.5"
              >
                {label}
              </span>
            ) : (
              <button
                type="button"
                onClick={onLoadAll}
                title={`${[kind, name].filter(Boolean).join(' · ')} · ${t('workflow.taskRowNotLoaded', 'Launched earlier in this conversation; click to load it')}`}
                className="flex min-w-0 max-w-xs items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
              >
                {label}
              </button>
            )}
            {/* The map holds the tasks CloudCLI's runtime reports it tracks,
                so these keep their ✕ whatever `canStopTasks` says. */}
            {sessionId && (
              <button
                type="button"
                onClick={() => sendMessage({ type: 'chat.stop-task', sessionId, taskId: task.taskId })}
                aria-label={t('workflow.stopTask', 'Stop')}
                title={t('workflow.stopTask', 'Stop')}
                className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        );
      })}
      {scheduledWork.length > 0 && (
        <ScheduledWorkChips
          // A session's own: a stop asked for in one is not heard of in another.
          key={sessionId ?? ''}
          items={scheduledWork}
          hasTasks={running.length > 0 || Boolean(tasks?.length)}
          messages={messages}
          sessionId={sessionId}
          canStop={canStopTasks}
          isTurnRunning={isTurnRunning}
          sendMessage={sendMessage}
          onReveal={onReveal}
          onLoadAll={onLoadAll}
        />
      )}
    </div>
  );
});
BackgroundTasksStrip.displayName = 'BackgroundTasksStrip';
