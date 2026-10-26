import { useTranslation } from 'react-i18next';
import { Circle, CircleAlert, CircleCheck, CircleDashed, Workflow } from 'lucide-react';

import type {
  ActivityDetails,
  ActivityDetailsAgent,
  ActivityDetailsTask,
  ActivityDetailsWorkflow,
  BackgroundTaskStatus,
} from '@/shared/types';
import { cn } from '@/shared/utils';
import { Queue, QueueItem, QueueItemContent, QueueItemIndicator } from '@/modules/chat/tools/Queue';
import { RunProgressBar } from '@/modules/chat/tools/RunProgressBar';
import { describeBackgroundTask, formatTaskDuration } from '@/modules/chat/utils/backgroundTasks';
import {
  computeProgressPercent,
  formatElapsed,
  formatProgressCount,
  formatRemainingEstimate,
} from '@/modules/chat/utils/runProgress';

type ActivityDetailsPanelProps = {
  /** The id the activity tab's toggle names in `aria-controls`. */
  id: string;
  /** What to list, read at the tab's clock. */
  details: ActivityDetails;
  /**
   * The tallest it may be, in px, to fit the room above the composer. Null
   * leaves only its own 16rem ceiling. Either way it scrolls within.
   */
  maxHeightPx?: number | null;
};

/** A run's status in the Workflow card's colours. */
const WORKFLOW_STATUS_STYLES: Record<BackgroundTaskStatus, string> = {
  running: 'text-purple-600 dark:text-purple-300',
  completed: 'text-muted-foreground',
  failed: 'text-red-600 dark:text-red-400',
  stopped: 'text-muted-foreground/70',
};

/** An agent's name, dimmed while it waits or after it was abandoned, red when it failed. */
const AGENT_LABEL_STYLES: Record<ActivityDetailsAgent['status'], string> = {
  running: 'text-foreground',
  completed: 'text-foreground',
  failed: 'text-red-600 dark:text-red-400',
  queued: 'text-muted-foreground',
  stopped: 'text-muted-foreground',
};

/** A section's heading, in the small caps of the Workflow card's. */
const SECTION_HEADING_CLASS =
  'mb-1 flex items-baseline justify-between gap-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60';

/** The pulsing purple dot the workflow and agent cards mark work in flight with. */
function RunningDot() {
  return <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-purple-500 dark:bg-purple-400" />;
}

/** An agent's status as an icon: done, running, waiting, failed or abandoned. Its word is read out beside it. */
function AgentStatusIcon({ status }: { status: ActivityDetailsAgent['status'] }) {
  switch (status) {
    case 'running':
      return <RunningDot />;
    case 'completed':
      return <CircleCheck className="h-3 w-3 text-green-500 dark:text-green-400" />;
    case 'failed':
      return <CircleAlert className="h-3 w-3 text-red-500 dark:text-red-400" />;
    case 'queued':
      return <Circle className="h-3 w-3 text-muted-foreground/50" />;
    default:
      return <CircleDashed className="h-3 w-3 text-muted-foreground/50" />;
  }
}

function WorkflowAgentLine({ agent }: { agent: ActivityDetailsAgent }) {
  const { t } = useTranslation('chat');
  return (
    <li className="flex min-w-0 items-center gap-1.5">
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden>
        <AgentStatusIcon status={agent.status} />
      </span>
      <span className="sr-only">{`${t(`activityDetails.status.${agent.status}`, agent.status)}: `}</span>
      <span className={cn('min-w-0 truncate', AGENT_LABEL_STYLES[agent.status])} title={agent.label}>
        {agent.label}
      </span>
      {agent.phase && <span className="min-w-0 max-w-[40%] shrink-0 truncate text-muted-foreground/70">· {agent.phase}</span>}
      {agent.elapsedMs !== undefined && (
        <span className="ml-auto shrink-0 pl-2 tabular-nums text-muted-foreground/60">{formatElapsed(agent.elapsedMs, t)}</span>
      )}
    </li>
  );
}

/**
 * One workflow: its name and status, what it does, the readout the tab
 * shows for it (bar, count, percent, phase, elapsed time, time left) and its
 * agents, the cap's remainder folded into "+N more".
 */
function WorkflowDetails({ workflow }: { workflow: ActivityDetailsWorkflow }) {
  const { t } = useTranslation('chat');
  const { progress, status } = workflow;
  const isRunning = status === 'running';
  const countLabel = progress ? formatProgressCount(progress, t) : '';
  // A running run's time ticks on the tab's clock. A finished run's is the
  // one the CLI reported, printed as its Workflow card prints it (to the
  // nearest second), so the panel and the card never read a second apart.
  const elapsedLabel = workflow.elapsedMs === null
    ? ''
    : isRunning ? formatElapsed(workflow.elapsedMs, t) : formatTaskDuration(workflow.elapsedMs);
  const readout: Array<[part: string, text: string]> = [
    ['count', progress ? countLabel : isRunning ? t('activityDetails.noAgentsYet', 'No agents listed yet') : ''],
    ['percent', progress ? t('runProgress.percent', { percent: computeProgressPercent(progress), defaultValue: '{{percent}}%' }) : ''],
    ['phase', progress?.phase ?? ''],
    ['elapsed', elapsedLabel],
    ['estimate', workflow.remainingMs === null ? '' : formatRemainingEstimate(workflow.remainingMs, t)],
  ];
  const shownReadout = readout.filter(([, text]) => text.length > 0);

  return (
    <section>
      <div className="flex min-w-0 items-center gap-1.5">
        <Workflow className="h-3.5 w-3.5 shrink-0 text-purple-500 dark:text-purple-400" aria-hidden />
        <span className="sr-only">{`${t('activityDetails.workflow', 'Workflow')}: `}</span>
        <span className="min-w-0 truncate font-medium text-foreground" title={workflow.name || undefined}>
          {workflow.name || t('activityDetails.workflow', 'Workflow')}
        </span>
        <span className={cn('ml-auto flex shrink-0 items-center gap-1 pl-2 text-[11px]', WORKFLOW_STATUS_STYLES[status])}>
          {isRunning && <RunningDot />}
          {t(`activityDetails.status.${status}`, status)}
        </span>
      </div>
      {workflow.description && (
        <div className="truncate pl-5" title={workflow.description}>{workflow.description}</div>
      )}
      {shownReadout.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-5 tabular-nums">
          {progress && (
            <RunProgressBar
              done={progress.done}
              total={progress.total}
              running={isRunning ? progress.running : 0}
              label={countLabel}
            />
          )}
          {shownReadout.map(([part, text], index) => (
            <span
              key={part}
              className={cn(part === 'estimate' && 'cursor-help')}
              title={part === 'estimate' ? t('runProgress.eta.hint', 'Estimated from the pace so far') : undefined}
            >
              {index > 0 && <span aria-hidden>· </span>}
              {text}
            </span>
          ))}
        </div>
      )}
      {workflow.agents.length > 0 && (
        <ul className="mt-1 space-y-0.5 pl-5">
          {workflow.agents.map((agent) => <WorkflowAgentLine key={agent.key} agent={agent} />)}
        </ul>
      )}
      {workflow.hiddenAgentCount > 0 && (
        <div className="pl-10 text-[11px] text-muted-foreground/70">
          {t('activityDetails.moreAgents', { count: workflow.hiddenAgentCount, defaultValue: '+{{count}} more' })}
        </div>
      )}
    </section>
  );
}

/** The turn's checklist item by item, drawn like the transcript's checklist view, with its count. */
function ChecklistDetails({ checklist }: { checklist: NonNullable<ActivityDetails['checklist']> }) {
  const { t } = useTranslation('chat');
  return (
    <section>
      <div className={SECTION_HEADING_CLASS}>
        <span>{t('activityDetails.checklist', 'Task list')}</span>
        <span className="normal-case tabular-nums tracking-normal">
          {formatProgressCount({ unit: 'tasks', done: checklist.done, total: checklist.total }, t)}
        </span>
      </div>
      <Queue>
        {checklist.items.map((item) => (
          <QueueItem key={item.key} status={item.status}>
            <QueueItemIndicator />
            <QueueItemContent>
              <span className="sr-only">{`${t(`activityDetails.checklistStatus.${item.status}`, item.status)}: `}</span>
              {item.text}
            </QueueItemContent>
          </QueueItem>
        ))}
      </Queue>
    </section>
  );
}

/** The background tasks by kind and name, each with how long it has run. */
function BackgroundTaskDetails({ tasks }: { tasks: ActivityDetailsTask[] }) {
  const { t } = useTranslation('chat');
  return (
    <section>
      <div className={SECTION_HEADING_CLASS}>
        <span>{t('activityDetails.backgroundTasks', 'Background tasks')}</span>
      </div>
      <ul className="space-y-0.5">
        {tasks.map((task) => {
          const name = describeBackgroundTask(task, t);
          return (
            <li key={task.taskId} className="flex min-w-0 items-center gap-1.5">
              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden>
                <RunningDot />
              </span>
              <span className="min-w-0 truncate text-foreground" title={name}>{name}</span>
              <span className="ml-auto shrink-0 pl-2 tabular-nums text-muted-foreground/60">{formatElapsed(task.elapsedMs, t)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Rendered by chat's ActivityIndicator above the activity tab once the user
 * opens it: in full what the tab's readout sums up — each workflow with its
 * agents, the turn's checklist item by item, the background tasks — under a
 * line naming the run, its elapsed time and, for a run the Claude CLI drives
 * outside this view, why its details arrive only as its transcript is
 * written. With none of that to list, it says so plainly.
 *
 * It grows upward from the tab, so it is capped by the room above the
 * composer as well as its own ceiling: past the top of the chat column it
 * would be clipped where no scrolling of its own could bring its first rows
 * back.
 */
export default function ActivityDetailsPanel({ id, details, maxHeightPx = null }: ActivityDetailsPanelProps) {
  const { t } = useTranslation('chat');
  const { run, workflows, hiddenWorkflowCount, checklist, tasks } = details;
  const runLabel = run.isBackground
    ? t('claudeStatus.backgroundWork', 'Background work')
    : run.statusText?.replace(/\.+$/, '') || t('activityDetails.turnInProgress', 'Turn in progress');
  const isEmpty = workflows.length === 0 && !checklist && tasks.length === 0;

  return (
    <div
      id={id}
      role="region"
      aria-label={t('activityDetails.title', 'Progress details')}
      // Focusable so a keyboard can scroll it when it runs long.
      tabIndex={0}
      // ActivityIndicator counts its gap above the tab (mb-1.5) in the room it leaves it.
      className="chat-activity-details-enter pointer-events-auto mb-1.5 max-h-64 space-y-3 overflow-y-auto overscroll-contain rounded-lg border border-border/50 bg-card px-3 py-2.5 text-xs text-muted-foreground shadow-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      style={maxHeightPx === null ? undefined : { maxHeight: `min(16rem, ${maxHeightPx}px)` }}
    >
      <div>
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 truncate font-medium text-foreground">{runLabel}</span>
          <span className="shrink-0 tabular-nums text-muted-foreground/60">· {formatElapsed(run.elapsedMs, t)}</span>
        </div>
        {run.isCliDriven && (
          <p className="mt-0.5 text-[11px] text-muted-foreground/70">
            {t(
              'activityDetails.cliDriven',
              'This run is driven by the Claude CLI outside this view, so these details update as its transcript is written.',
            )}
          </p>
        )}
      </div>

      {workflows.map((workflow) => <WorkflowDetails key={workflow.key} workflow={workflow} />)}
      {hiddenWorkflowCount > 0 && (
        <div className="text-[11px] text-muted-foreground/70">
          {t('activityDetails.moreWorkflows', {
            count: hiddenWorkflowCount,
            defaultValue_one: '+{{count}} more workflow',
            defaultValue_other: '+{{count}} more workflows',
          })}
        </div>
      )}

      {checklist && <ChecklistDetails checklist={checklist} />}
      {tasks.length > 0 && <BackgroundTaskDetails tasks={tasks} />}

      {isEmpty && (
        <p>
          {t(
            'activityDetails.empty',
            'No detailed progress yet — this run has no workflow, task list or background task.',
          )}
        </p>
      )}
    </div>
  );
}
