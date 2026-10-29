import { memo, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, CircleAlert, CircleCheck, CircleDashed, Workflow } from 'lucide-react';

import type {
  BackgroundTaskStatus,
  DiffLine,
  LiveTaskStatus,
  Project,
  SubagentActivity,
  ToolResult,
  WorkflowAgentRow,
  WorkflowInfo,
} from '@/shared/types';
import { api, readApiJson } from '@/shared/api';
import { cn } from '@/shared/utils';
import { MarkdownContent } from '@/modules/chat/tools/ContentRenderers/MarkdownContent';
import { RunProgressBar } from '@/modules/chat/tools/RunProgressBar';
import { SubagentTimeline } from '@/modules/chat/tools/SubagentTimeline';
import { ToolErrorDisplay } from '@/modules/chat/tools/ToolErrorDisplay';
import { useIsExportingTranscript } from '@/modules/chat/context/TranscriptRenderContext';
import { useTranscriptSessionId } from '@/modules/chat/context/TranscriptSessionContext';
import {
  describeWorkflowAgent,
  findCurrentWorkflowAgent,
  formatTaskDuration,
} from '@/modules/chat/utils/backgroundTasks';
import {
  formatProgressCount,
  mergeWorkflowAgents,
  resolveWorkflowRunStatus,
  summarizeWorkflowAgents,
} from '@/modules/chat/utils/runProgress';
import { parseWorkflowMeta } from '@/modules/chat/utils/workflowScriptMeta';

type WorkflowPanelProps = {
  /** Raw tool input of the `Workflow` call: the script (or its path) and a one-line description. */
  toolInput: unknown;
  toolResult?: ToolResult | null;
  /** The run as the backend read it from disk on the last history load. */
  workflow?: WorkflowInfo;
  /** The latest live word on the run, while it is in flight. */
  taskStatus?: LiveTaskStatus;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  selectedProject?: Project | null;
};

/** What the agent-activity route answers with. */
type WorkflowAgentActivity = {
  agent: { id: string; label?: string; model?: string; status: BackgroundTaskStatus };
  activity: SubagentActivity[];
  activityCount: number;
};

/** How often an open, running agent's timeline is re-read from its transcript. */
const AGENT_TIMELINE_POLL_MS = 3_000;

/** The text of a launch acknowledgement, which is never the run's result. */
const LAUNCH_ACK_PREFIX = 'Workflow launched in background';

function parseToolInput(toolInput: unknown): Record<string, unknown> {
  if (typeof toolInput !== 'string') {
    return (toolInput as Record<string, unknown>) || {};
  }
  try {
    return JSON.parse(toolInput) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Tokens the way the CLI writes them: 725k rather than 724,871. */
function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : `${tokens}`;
}

/** Pretty-prints a JSON result so it reads as a document rather than one line. */
function formatResultText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return `\`\`\`json\n${JSON.stringify(JSON.parse(trimmed), null, 2)}\n\`\`\``;
    } catch {
      return text;
    }
  }
  return text;
}

const STATUS_STYLES: Record<BackgroundTaskStatus, string> = {
  running: 'text-purple-600 dark:text-purple-300',
  completed: 'text-muted-foreground',
  failed: 'text-red-600 dark:text-red-400',
  stopped: 'text-muted-foreground/70',
};

const AGENT_STATUS_STYLES: Record<WorkflowAgentRow['status'], string> = {
  queued: 'border border-muted-foreground/50',
  running: 'bg-purple-500 dark:bg-purple-400 animate-pulse',
  completed: 'bg-green-500 dark:bg-green-400',
  failed: 'bg-red-500 dark:bg-red-400',
  stopped: 'bg-muted-foreground/40',
};

type WorkflowAgentTimelineProps = {
  sessionId: string;
  runId: string;
  agentId: string;
  /** Whether the card still lists the agent as running, which is what keeps the timeline re-reading. */
  isRunning: boolean;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  selectedProject?: Project | null;
};

/**
 * One agent's timeline, read from its transcript when its row is opened.
 *
 * The SDK streams nothing of a workflow agent's own work to the parent
 * session, so this is fetched rather than folded from the store — and
 * re-read every few seconds while the agent runs, since the transcript is
 * the only place its progress lands.
 */
const WorkflowAgentTimeline = memo(({ sessionId, runId, agentId, isRunning, onFileOpen, createDiff, selectedProject }: WorkflowAgentTimelineProps) => {
  const { t } = useTranslation();
  // What the last read returned — the timeline, or why there is none — and
  // null until the first read lands. A later read that fails keeps the last
  // timeline: what the agent had done does not stop being true.
  const [loaded, setLoaded] = useState<{ activity: WorkflowAgentActivity } | { error: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let nextRead: ReturnType<typeof setTimeout> | undefined;

    const read = async () => {
      let settled = false;
      try {
        const payload = await readApiJson<{ data: WorkflowAgentActivity }>(
          await api.workflowAgentActivity(sessionId, runId, agentId),
        );
        if (cancelled) {
          return;
        }
        setLoaded({ activity: payload.data });
        // The transcript's own status can settle the agent before the card
        // hears of it.
        settled = payload.data.agent.status !== 'running';
      } catch (error) {
        if (cancelled) {
          return;
        }
        // The transcript is written a moment after the agent's start is
        // reported, so the first read of a fresh agent can miss it.
        setLoaded((previous) => previous && 'activity' in previous
          ? previous
          : { error: error instanceof Error ? error.message : String(error) });
      }
      if (isRunning && !settled) {
        nextRead = setTimeout(read, AGENT_TIMELINE_POLL_MS);
      }
    };
    void read();

    return () => {
      cancelled = true;
      clearTimeout(nextRead);
    };
  }, [sessionId, runId, agentId, isRunning]);

  if (!loaded) {
    return <div className="text-[11px] text-muted-foreground/60">{t('workflow.agentTimelineLoading', 'Reading the agent\'s steps…')}</div>;
  }
  if ('error' in loaded) {
    return (
      <div className="text-[11px] text-muted-foreground/60">
        {t('workflow.agentTimelineUnavailable', 'Steps unavailable: {{reason}}', { reason: loaded.error })}
      </div>
    );
  }
  if (loaded.activity.activity.length === 0) {
    return <div className="text-[11px] text-muted-foreground/60">{t('workflow.agentTimelineEmpty', 'Nothing recorded yet')}</div>;
  }
  return (
    <SubagentTimeline
      activity={loaded.activity.activity}
      activityCount={loaded.activity.activityCount}
      onFileOpen={onFileOpen}
      createDiff={createDiff}
      selectedProject={selectedProject}
    />
  );
});
WorkflowAgentTimeline.displayName = 'WorkflowAgentTimeline';

type WorkflowAgentRowProps = {
  agent: WorkflowAgentRow;
  /** Where the agent's transcript can be fetched from; absent outside a session. */
  timelineAddress: { sessionId: string; runId: string } | null;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  selectedProject?: Project | null;
};

/**
 * One agent of the run: its name, phase and status, what it is on while it
 * runs and what it came back with when done — and, opened on demand, its
 * timeline.
 */
const WorkflowAgentRowView = memo(({ agent, timelineAddress, onFileOpen, createDiff, selectedProject }: WorkflowAgentRowProps) => {
  const { t } = useTranslation();
  // Opened on demand: the timeline is a fetch and, for a long run, a few
  // hundred tool renderers.
  const [isOpen, setIsOpen] = useState(false);
  // A queued slot has no transcript yet, and outside a session there is
  // nothing to fetch one from.
  const canOpen = Boolean(timelineAddress && agent.agentId);

  const summary = (
    <>
      <span className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full', AGENT_STATUS_STYLES[agent.status])} />
      <span className={cn('min-w-0 truncate', agent.status === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-foreground')}>
        {describeWorkflowAgent(agent)}
      </span>
      {agent.phase && <span className="flex-shrink-0 text-muted-foreground/70">· {agent.phase}</span>}
      <span className="ms-auto flex-shrink-0 text-[11px] text-muted-foreground/70">
        {t(`workflow.agentStatus.${agent.status}`, agent.status)}
      </span>
    </>
  );

  return (
    <li>
      {canOpen ? (
        <button
          type="button"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((previous) => !previous)}
          className="flex w-full items-center gap-1.5 text-start hover:text-foreground"
        >
          <ChevronRight className={cn('h-3 w-3 flex-shrink-0 transition-transform duration-150', isOpen && 'rotate-90')} />
          {summary}
        </button>
      ) : (
        <div className="flex items-center gap-1.5 ps-[18px]">{summary}</div>
      )}

      {agent.status === 'running' && (agent.lastToolName || agent.tokens !== undefined || agent.toolCalls !== undefined) && (
        <div className="flex flex-wrap gap-x-2 ps-[30px] text-[11px] text-muted-foreground/70">
          {agent.lastToolName && (
            <span className="min-w-0 truncate">
              {agent.lastToolName}
              {agent.lastToolSummary && `: ${agent.lastToolSummary}`}
            </span>
          )}
          {agent.tokens !== undefined && <span className="flex-shrink-0">{t('workflow.agentTokens', '{{tokens}} tokens', { tokens: formatTokenCount(agent.tokens) })}</span>}
          {agent.toolCalls !== undefined && <span className="flex-shrink-0">{t('workflow.agentToolCalls', { count: agent.toolCalls, defaultValue_one: '{{count}} tool call', defaultValue_other: '{{count}} tool calls' })}</span>}
        </div>
      )}

      {agent.status === 'completed' && agent.resultPreview && (
        <div className="line-clamp-2 whitespace-pre-wrap break-words ps-[30px] text-[11px] text-muted-foreground/70">{agent.resultPreview}</div>
      )}

      {isOpen && timelineAddress && agent.agentId && (
        <div className="mt-1 space-y-2 ps-[30px]">
          <WorkflowAgentTimeline
            sessionId={timelineAddress.sessionId}
            runId={timelineAddress.runId}
            agentId={agent.agentId}
            isRunning={agent.status === 'running'}
            onFileOpen={onFileOpen}
            createDiff={createDiff}
            selectedProject={selectedProject}
          />
        </div>
      )}
    </li>
  );
});
WorkflowAgentRowView.displayName = 'WorkflowAgentRowView';

/**
 * Rendered by chat's MessageComponent for a `Workflow` tool call: the run's
 * name and status in the header, with the CLI's progress row beside them (or
 * on a line of its own on a narrow card) once agents are listed — a segmented
 * bar, `done/total agents`, the phase and the elapsed time — and, opened on
 * demand, its phases, the agents it spawned with what each is doing, live
 * usage, its result and the script it ran.
 *
 * Shaped like SubagentPanel: the launch is a summary of work, and the
 * detail is only wanted on demand, so the body stays unmounted until opened.
 */
export const WorkflowPanel = memo(({ toolInput, toolResult, workflow, taskStatus, onFileOpen, createDiff, selectedProject }: WorkflowPanelProps) => {
  const { t } = useTranslation();
  const isExporting = useIsExportingTranscript();
  // Collapsed by default, like an agent card; the header carries the status.
  const [isOpen, setIsOpen] = useState(false);
  const showBody = isOpen || isExporting;

  const parsedInput = useMemo(() => parseToolInput(toolInput), [toolInput]);
  const script = typeof parsedInput.script === 'string' ? parsedInput.script : '';
  const meta = useMemo(() => parseWorkflowMeta(script), [script]);

  const status = resolveWorkflowRunStatus({ toolResult, workflow, taskStatus });
  const name = workflow?.name || taskStatus?.workflowName || meta.name || '';
  const description = workflow?.description || meta.description || String(parsedInput.description ?? '');
  // A progress summary restating the description ("one agent that waits…")
  // says nothing the header does not; only a real phase or count earns the
  // badge over the plain word.
  const liveSummary = taskStatus?.summary && taskStatus.summary !== description ? taskStatus.summary : undefined;
  const scriptPath = workflow?.scriptPath ?? (typeof parsedInput.scriptPath === 'string' ? parsedInput.scriptPath : '');

  const agents = useMemo(
    () => mergeWorkflowAgents(workflow?.agents ?? [], taskStatus?.agents, status === 'running'),
    [workflow?.agents, taskStatus?.agents, status],
  );
  // The header's progress row counts the same list the body shows.
  const agentProgress = useMemo(() => summarizeWorkflowAgents(agents), [agents]);
  const finishedCount = agentProgress.done;
  const failedCount = agents.filter((agent) => agent.status === 'failed').length;
  // An agent's transcript is fetched by session and run; the run id is on the
  // journal read or, before history reloads, the launch acknowledgement.
  const sessionId = useTranscriptSessionId();
  const runId = workflow?.runId
    || String((toolResult?.toolUseResult as { runId?: unknown } | undefined)?.runId ?? '');
  const timelineAddress = useMemo(
    () => (sessionId && runId ? { sessionId, runId } : null),
    [sessionId, runId],
  );
  // The agent the run is on, for the usage line: the stream names it in
  // `agents`, and — for a workflow — its task-level description is that
  // agent's label too.
  const currentAgent = findCurrentWorkflowAgent(taskStatus?.agents);
  // Before the stream has listed any agent, the task's description is the
  // step the CLI says it is on; once it has, no running agent means none.
  const currentAgentLabel = currentAgent
    ? describeWorkflowAgent(currentAgent)
    : taskStatus?.agents ? undefined : taskStatus?.description;

  const agentCountLabel = formatProgressCount({ unit: 'agents', ...agentProgress }, t);
  // The phase belongs to the agent the run is on, so only a running run has
  // one, and it is left out when the status badge already says it.
  const headerPhase = status === 'running' && agentProgress.phase !== liveSummary ? agentProgress.phase : undefined;
  // The CLI's own wall time for the run, from its latest progress event.
  const headerElapsed = taskStatus?.usage ? formatTaskDuration(taskStatus.usage.durationMs) : '';

  // The folded notification is the result; a live launch still holds the
  // acknowledgement until history reloads, and that is never worth showing.
  const content = typeof toolResult?.content === 'string' ? toolResult.content : '';
  const resultText = useMemo(
    () => (status !== 'running' && content.trim() && !content.startsWith(LAUNCH_ACK_PREFIX) ? formatResultText(content) : ''),
    [content, status],
  );

  return (
    <div className="my-1 border-s-2 border-s-purple-500 py-0.5 ps-3 dark:border-s-purple-400">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((previous) => !previous)}
        className="flex w-full select-none flex-wrap items-center gap-x-1.5 gap-y-0.5 py-0.5 text-start text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {/* One unit, so the name never wraps away from its title; it
            truncates only once the title has a line to itself. */}
        <span className="flex min-w-0 items-center gap-1.5">
          <ChevronRight className={cn('h-3 w-3 flex-shrink-0 transition-transform duration-150', isOpen && 'rotate-90')} />
          <Workflow className="h-3.5 w-3.5 flex-shrink-0 text-purple-500 dark:text-purple-400" />
          <span className="flex-shrink-0 font-medium text-foreground">{t('workflow.title', 'Workflow')}</span>
          {name && (
            <>
              <span className="flex-shrink-0 text-[10px] text-muted-foreground/40">/</span>
              <span className="min-w-0 truncate font-medium" title={name}>{name}</span>
            </>
          )}
        </span>
        {description && <span className="min-w-0 flex-1 truncate">{description}</span>}
        {/* The progress row and the status move together onto a line of their
            own when the card is too narrow for them beside the name, rather
            than squeezing it; on that line the phase and the elapsed time
            truncate before the count and the status do. */}
        <span className="ms-auto flex min-w-0 max-w-full items-center gap-2 text-[11px]">
          {agentProgress.total > 0 && (
            // Like the CLI's workflow row. The bar is decoration here: the
            // count beside it already says it in the button's name.
            <span className="flex min-w-0 items-center gap-1.5 overflow-hidden tabular-nums text-muted-foreground">
              <RunProgressBar
                decorative
                done={agentProgress.done}
                total={agentProgress.total}
                running={status === 'running' ? agentProgress.running : 0}
              />
              <span className="shrink-0">{agentCountLabel}</span>
              {headerPhase && <span className="min-w-0 max-w-40 truncate">· {headerPhase}</span>}
              {headerElapsed && <span className="min-w-0 truncate">· {headerElapsed}</span>}
            </span>
          )}
          <span className={cn('flex flex-shrink-0 items-center gap-1', STATUS_STYLES[status])}>
            {status === 'running' ? (
              <>
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-purple-500 dark:bg-purple-400" />
                {liveSummary || t('workflow.status.running', 'running')}
              </>
            ) : status === 'failed' ? (
              <>
                <CircleAlert className="h-3 w-3" />
                {t('workflow.status.failed', 'failed')}
              </>
            ) : status === 'stopped' ? (
              // Neither a spinner nor a check mark: the run never reported and
              // the process it ran in is gone, so there is no outcome to draw.
              <span title={t('workflow.stoppedHint', 'The run ended before this workflow reported back')} className="flex items-center gap-1">
                <CircleDashed className="h-3 w-3" />
                {t('workflow.status.stopped', 'no result')}
              </span>
            ) : (
              <>
                <CircleCheck className="h-3 w-3" />
                {t('workflow.status.completed', 'done')}
              </>
            )}
          </span>
        </span>
      </button>

      {showBody && (
        <div className="mt-1.5 space-y-2 ps-[18px] text-xs">
          {meta.phases.length > 0 && (
            <div className="rounded border border-border/40 bg-muted/40 p-2 text-muted-foreground">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">{t('workflow.phases', 'Phases')}</div>
              <ol className="list-decimal space-y-0.5 ps-4">
                {meta.phases.map((phase) => (
                  <li key={phase.title}>
                    <span className="font-medium text-foreground">{phase.title}</span>
                    {phase.detail && <span className="text-muted-foreground"> — {phase.detail}</span>}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {agents.length > 0 && (
            <div className="rounded border border-border/40 bg-muted/40 p-2 text-muted-foreground">
              <div className="mb-1 flex items-baseline justify-between gap-2 text-[10px] uppercase tracking-wide text-muted-foreground/60">
                <span>{t('workflow.agents', 'Agents')}</span>
                <span className="normal-case tracking-normal">
                  {t('workflow.agentsFinished', { finished: finishedCount, count: agents.length, defaultValue_one: '{{finished}} of {{count}} agent finished', defaultValue_other: '{{finished}} of {{count}} agents finished' })}
                  {failedCount > 0 && ` · ${t('workflow.agentsFailed', '{{count}} failed', { count: failedCount })}`}
                </span>
              </div>
              <ul className="space-y-0.5">
                {agents.map((agent) => (
                  <WorkflowAgentRowView
                    key={agent.key}
                    agent={agent}
                    timelineAddress={timelineAddress}
                    onFileOpen={onFileOpen}
                    createDiff={createDiff}
                    selectedProject={selectedProject}
                  />
                ))}
              </ul>
            </div>
          )}

          {taskStatus?.usage && (
            <div className="text-[11px] text-muted-foreground/70">
              {t('workflow.usage', '{{toolUses}} tool uses · {{elapsed}}', {
                toolUses: taskStatus.usage.toolUses,
                elapsed: formatTaskDuration(taskStatus.usage.durationMs),
              })}
              {status === 'running' && currentAgentLabel && ` · ${t('workflow.currentAgent', 'current: {{label}}', { label: currentAgentLabel })}`}
            </div>
          )}

          {toolResult?.isError ? (
            // The tool's refusal is the whole story of this call.
            <ToolErrorDisplay label={t('chat:messageTypes.error', 'Error')} content={content} />
          ) : resultText && (
            <details open className="rounded border border-border/40 bg-muted/30 p-2">
              <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-muted-foreground/60">
                {t('workflow.result', 'Result')}
              </summary>
              <MarkdownContent content={resultText} className="prose prose-sm max-w-none dark:prose-invert" />
            </details>
          )}

          {(script || scriptPath) && (
            <details className="rounded border border-border/40 bg-muted/30 p-2">
              <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-muted-foreground/60">
                {t('workflow.script', 'Script')}
                {scriptPath && <span className="ms-2 normal-case tracking-normal text-muted-foreground/50">{scriptPath}</span>}
              </summary>
              {script && (
                <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">{script}</pre>
              )}
            </details>
          )}
        </div>
      )}
    </div>
  );
});
WorkflowPanel.displayName = 'WorkflowPanel';
