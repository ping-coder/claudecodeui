import type { TFunction } from 'i18next';

import type {
  ActivityDetails,
  ActivityDetailsAgent,
  ActivityDetailsTask,
  ActivityDetailsWorkflow,
  ActivityProgress,
  BackgroundTaskStatus,
  ChatMessage,
  SessionActivity,
  WorkflowAgentInfo,
  WorkflowAgentProgress,
  WorkflowAgentRow,
} from '@/shared/types';
import {
  describeWorkflowAgent,
  ownBackgroundTasks,
  resolveBackgroundTaskStatus,
} from '@/modules/chat/utils/backgroundTasks';
import { parseToolPayload } from '@/modules/chat/utils/messageTransforms';
import { parseWorkflowMeta } from '@/modules/chat/utils/workflowScriptMeta';

/*
 * How far a session's running work has got, read from the same transcript
 * rows the cards draw: a workflow's agents, or a turn's checklist. The Workflow
 * card, the activity tab above the composer and the tab's details panel all
 * count from here, so none of them disagrees with another about the same run.
 */

//----------------- WORKFLOW AGENTS ------------

/** The live stream's word on an agent, in the card's statuses. */
const LIVE_AGENT_STATUS: Record<WorkflowAgentProgress['state'], WorkflowAgentRow['status']> = {
  queued: 'queued',
  running: 'running',
  done: 'completed',
  failed: 'failed',
};

/**
 * Settles one agent's status from its two sources.
 *
 * The journal (from the last history load) is what survives a reload and the
 * only source once the run is over; the live stream is fresher while the run
 * is going and the only source for an agent's current tool, spend and queued
 * slots. So a journal status that has settled wins — the journal was read
 * after the fact — and an unsettled one defers to the live state, which is
 * newer. Once the workflow itself is over, a slot either source still has
 * running or queued is one the run ended under, not one still going.
 */
function settleAgentStatus(
  journalStatus: WorkflowAgentInfo['status'],
  liveState: WorkflowAgentProgress['state'] | undefined,
  isWorkflowRunning: boolean,
): WorkflowAgentRow['status'] {
  if (journalStatus !== 'running') {
    return journalStatus;
  }
  const status = liveState ? LIVE_AGENT_STATUS[liveState] : journalStatus;
  return isWorkflowRunning || status === 'completed' || status === 'failed' ? status : 'stopped';
}

/** Folds the run's agents from the journal and the live stream into the one list the card shows and the progress readouts count. */
export function mergeWorkflowAgents(
  journalAgents: WorkflowAgentInfo[],
  liveAgents: WorkflowAgentProgress[] | undefined,
  isWorkflowRunning: boolean,
): WorkflowAgentRow[] {
  const liveById = new Map<string, WorkflowAgentProgress>();
  for (const agent of liveAgents ?? []) {
    if (agent.agentId) {
      liveById.set(agent.agentId, agent);
    }
  }

  const rows: WorkflowAgentRow[] = journalAgents.map((agent, index) => {
    const live = liveById.get(agent.id);
    const { state, ...liveFields } = live ?? { index, state: undefined };
    return {
      ...liveFields,
      key: agent.id,
      agentId: agent.id,
      label: agent.label ?? live?.label,
      phase: agent.phase ?? live?.phase,
      status: settleAgentStatus(agent.status, state, isWorkflowRunning),
    };
  });

  const journalIds = new Set(journalAgents.map((agent) => agent.id));
  for (const { state, ...live } of liveAgents ?? []) {
    if (live.agentId && journalIds.has(live.agentId)) {
      continue;
    }
    const liveStatus = LIVE_AGENT_STATUS[state];
    if (!isWorkflowRunning && liveStatus === 'queued') {
      // Never started, and now never will: nothing to list.
      continue;
    }
    rows.push({
      ...live,
      key: live.agentId ?? `slot-${live.index}`,
      status: isWorkflowRunning || liveStatus === 'completed' || liveStatus === 'failed' ? liveStatus : 'stopped',
    });
  }

  return rows;
}

/**
 * Where a `Workflow` call's run stands, as its card draws it.
 *
 * A workflow only ever runs in the background, so until something reports on
 * it — the backend from the journal and notification, the live stream from
 * its task events — it is still going. Unless the tool refused the call
 * outright (a script that does not parse): that result is an error and
 * nothing was ever launched.
 */
export function resolveWorkflowRunStatus(
  launch: Pick<ChatMessage, 'toolResult' | 'workflow' | 'taskStatus'>,
): BackgroundTaskStatus {
  return launch.toolResult?.isError
    ? 'failed'
    : resolveBackgroundTaskStatus(launch.workflow?.status, launch.taskStatus?.status) ?? 'running';
}

/**
 * What a run's progress bar counts: agents finished (completed or failed, the
 * same "finished" the card's agent list reports), agents running, every agent
 * known so far, and the phase of the agent the run is on — the running one it
 * started last.
 */
export function summarizeWorkflowAgents(
  rows: WorkflowAgentRow[],
): Pick<ActivityProgress, 'done' | 'total' | 'running' | 'phase'> {
  let done = 0;
  let running = 0;
  let current: WorkflowAgentRow | undefined;
  for (const row of rows) {
    if (row.status === 'completed' || row.status === 'failed') {
      done += 1;
    } else if (row.status === 'running') {
      running += 1;
      if (!current || (row.startedAt ?? 0) >= (current.startedAt ?? 0)) {
        current = row;
      }
    }
  }
  return { done, total: rows.length, running, ...(current?.phase ? { phase: current.phase } : {}) };
}

/**
 * What the time-left estimate needs to treat agents running side by side as
 * concurrent: the mean run time of the finished agents that reported one,
 * when each running agent started, and how many slots wait to start. Only the
 * live stream times agents, so a run known from its journal alone, or one
 * with a running agent that never said when it started, has none.
 */
function readWorkflowAgentTiming(rows: WorkflowAgentRow[]): ActivityProgress['agentTiming'] {
  let finishedRunTimeMs = 0;
  let timedFinishedCount = 0;
  let queued = 0;
  const runningStartedAt: number[] = [];
  for (const row of rows) {
    if (row.status === 'completed' || row.status === 'failed') {
      if (row.durationMs !== undefined && Number.isFinite(row.durationMs) && row.durationMs > 0) {
        finishedRunTimeMs += row.durationMs;
        timedFinishedCount += 1;
      }
    } else if (row.status === 'running') {
      if (row.startedAt === undefined || !Number.isFinite(row.startedAt)) {
        return undefined;
      }
      runningStartedAt.push(row.startedAt);
    } else if (row.status === 'queued') {
      queued += 1;
    }
  }
  return timedFinishedCount > 0
    ? { meanDurationMs: finishedRunTimeMs / timedFinishedCount, runningStartedAt, queued }
    : undefined;
}

function isWorkflowLaunch(message: ChatMessage): boolean {
  return Boolean(message.isToolUse) && message.toolName === 'Workflow';
}

/**
 * A `Workflow` row's run as its card lists it: the agents merged from the
 * journal and the live stream, when the run started, and the agents counted
 * from then — null until the run has listed one, as there is nothing to count.
 * Only a running run is timed per agent: a finished one has nothing left.
 */
function countWorkflowRun(
  message: ChatMessage,
  isRunning: boolean,
  fallbackStartedAt: number,
): { rows: WorkflowAgentRow[]; startedAt: number; progress: ActivityProgress | null } {
  const rows = mergeWorkflowAgents(message.workflow?.agents ?? [], message.taskStatus?.agents, isRunning);
  // The launch row is the run's start: the SDK's start event follows the
  // call within the same second.
  const launchedAt = new Date(message.timestamp).getTime();
  const startedAt = Number.isFinite(launchedAt) ? launchedAt : fallbackStartedAt;
  const counts = summarizeWorkflowAgents(rows);
  if (counts.total === 0) {
    return { rows, startedAt, progress: null };
  }
  const agentTiming = isRunning ? readWorkflowAgentTiming(rows) : undefined;
  return {
    rows,
    startedAt,
    progress: { unit: 'agents', ...counts, startedAt, ...(agentTiming ? { agentTiming } : {}) },
  };
}

/**
 * The newest workflow still running that has listed its agents, counted.
 * A run that has not listed one yet has nothing to count, so an older run
 * still going is looked at instead; with none, there is no workflow progress.
 */
function readRunningWorkflowProgress(messages: ChatMessage[], fallbackStartedAt: number): ActivityProgress | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isWorkflowLaunch(message) || resolveWorkflowRunStatus(message) !== 'running') {
      continue;
    }
    const { progress } = countWorkflowRun(message, true, fallbackStartedAt);
    if (progress) {
      return progress;
    }
  }
  return null;
}

// ---------------------------

//----------------- TURN CHECKLIST ------------

/** The tool every provider's whole-list checklist is normalized onto: Claude's TodoWrite, Codex's plan updates. */
const CHECKLIST_SNAPSHOT_TOOL = 'TodoWrite';

/**
 * Claude's incremental task tracker. A history load rewrites these calls into
 * whole-list `TodoWrite` snapshots; calls streamed since still arrive raw,
 * each changing one task of a list no single call states.
 */
const TASK_TRACKER_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

/** The todo vocabulary every provider's checklist is normalized onto. */
type ChecklistStatus = 'completed' | 'in_progress' | 'pending';

/**
 * One item of a rebuilt checklist: its status, its text as the checklist view
 * draws it, and what names the same item in another rebuild of the list. That
 * is the tracker's id, else the item's text, since a TodoWrite or Codex item
 * has no id. Empty when neither is known.
 */
type ChecklistItem = { status: ChecklistStatus; text: string; identity: string };

/** Anything but done or in progress is still open, as the checklist view draws it. */
function readChecklistStatus(value: unknown): ChecklistStatus {
  return value === 'completed' || value === 'in_progress' ? value : 'pending';
}

/** A task of Claude's tracker, which its id names in every rebuild. */
function readTrackerItem(id: string, status: unknown, text: string): ChecklistItem {
  return { status: readChecklistStatus(status), text, identity: `id:${id}` };
}

/** A tracker task's subject, its text in the checklist; empty when absent. */
function readTaskSubject(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A task id as the tracker spells it, a string or a number; empty when absent. */
function readTaskId(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === 'string' ? value.trim() : '';
}

function isChecklistSnapshot(message: ChatMessage): boolean {
  return Boolean(message.isToolUse) && message.toolName === CHECKLIST_SNAPSHOT_TOOL;
}

function isTaskTrackerCall(message: ChatMessage): boolean {
  return Boolean(message.isToolUse) && TASK_TRACKER_TOOLS.has(message.toolName ?? '');
}

/** A row that states or changes the checklist: a whole-list snapshot or a tracker call. */
function isChecklistRow(message: ChatMessage): boolean {
  return isChecklistSnapshot(message) || isTaskTrackerCall(message);
}

/** The items of a snapshot the checklist view would draw: those with text and a status. */
function readSnapshotTodos(message: ChatMessage): Record<string, unknown>[] {
  const todos = readRecord(parseToolPayload(message.toolInput))?.todos;
  if (!Array.isArray(todos)) {
    return [];
  }
  return todos
    .map(readRecord)
    .filter((todo): todo is Record<string, unknown> => (
      todo !== null && typeof todo.content === 'string' && typeof todo.status === 'string'
    ));
}

/**
 * Rebuilds the checklist as it stands at `lastIndex`: the newest whole-list
 * snapshot at or above it, with the tracker calls streamed since applied in
 * order — the same replay the server runs on a history load, down to dropping
 * a deleted task.
 *
 * Null when the list cannot be known in full. A call naming a task the replay
 * never saw means the list began above the loaded rows (unless it deletes a
 * task the whole list seeding the replay already lacks); so does a tracker id
 * skipped below the highest one created when no whole list seeded the replay
 * (the tracker numbers tasks from 1). A partial list would draw a false
 * fraction, which is worse than none.
 */
function rebuildChecklist(messages: ChatMessage[], lastIndex: number): Map<string, ChecklistItem> | null {
  let snapshotIndex = lastIndex;
  while (snapshotIndex >= 0 && !isChecklistSnapshot(messages[snapshotIndex])) {
    snapshotIndex -= 1;
  }

  const items = new Map<string, ChecklistItem>();
  // Every id the tracker calls have named, deleted ones included, for the gap check.
  const trackerIds = new Set<string>();
  // Whether a whole list (a snapshot or a listing) seeded the replay, so no
  // earlier task can be missing from it.
  let seeded = snapshotIndex >= 0;
  if (seeded) {
    readSnapshotTodos(messages[snapshotIndex]).forEach((todo, position) => {
      const id = readTaskId(todo.id);
      const text = String(todo.content).trim();
      items.set(id || `#${position}`, {
        status: readChecklistStatus(todo.status),
        text,
        identity: id ? `id:${id}` : text && `text:${text}`,
      });
    });
  }

  for (let index = snapshotIndex + 1; index <= lastIndex; index += 1) {
    const message = messages[index];
    if (!isTaskTrackerCall(message)) {
      continue;
    }
    const input = readRecord(parseToolPayload(message.toolInput)) ?? {};
    const result = readRecord(message.toolResult?.toolUseResult);
    const reportedTask = readRecord(result?.task);
    const listedTasks = result?.tasks;

    // A listing restates the whole tracker: adopt it wholesale, keeping the
    // text of a task it lists without a subject.
    if (Array.isArray(listedTasks)) {
      const knownTexts = new Map([...items].map(([id, item]) => [id, item.text]));
      items.clear();
      trackerIds.clear();
      seeded = true;
      for (const entry of listedTasks) {
        const task = readRecord(entry);
        const id = readTaskId(task?.id);
        if (id) {
          items.set(id, readTrackerItem(id, task?.status, readTaskSubject(task?.subject) || knownTexts.get(id) || id));
          trackerIds.add(id);
        }
      }
      continue;
    }

    if (message.toolName === 'TaskCreate') {
      // The tracker's id comes back with the result; until it does, the
      // call's own id stands in. Nothing can name the task before then.
      const id = readTaskId(reportedTask?.id) || message.toolId || '';
      if (id) {
        const text = readTaskSubject(reportedTask?.subject) || readTaskSubject(input.subject) || id;
        items.set(id, readTrackerItem(id, reportedTask?.status ?? input.status, text));
        trackerIds.add(id);
      }
      continue;
    }

    // An update or a read of one existing task.
    const id = readTaskId(input.taskId) || readTaskId(reportedTask?.id);
    if (!id) {
      continue;
    }
    const isKnownTask = items.has(id) || trackerIds.has(id);
    if (input.status === 'deleted' || reportedTask?.status === 'deleted') {
      // A whole list that seeded the replay already lacks a deleted task it
      // never listed: the server's snapshot that folded the deletion in can
      // sort above the raw call. Unseeded, it is a task from above the rows.
      if (!isKnownTask && !seeded) {
        return null;
      }
      trackerIds.add(id);
      items.delete(id);
      continue;
    }
    if (!isKnownTask) {
      return null;
    }
    trackerIds.add(id);
    const existing = items.get(id);
    const status = reportedTask?.status ?? input.status;
    const text = readTaskSubject(reportedTask?.subject) || readTaskSubject(input.subject) || existing?.text || id;
    if (status !== undefined) {
      items.set(id, readTrackerItem(id, status, text));
    } else if (existing) {
      // A rename leaves the status as it was.
      items.set(id, { ...existing, text });
    }
  }

  if (!seeded) {
    // Every id from 1 to the highest must have been seen: that holds exactly
    // when there are as many distinct ids in that range as the highest one.
    const numericIds = new Set(
      [...trackerIds].map(Number).filter((numericId) => Number.isInteger(numericId) && numericId > 0),
    );
    const highestId = numericIds.size > 0 ? Math.max(...numericIds) : 0;
    if (numericIds.size < highestId) {
      return null;
    }
  }

  return items;
}

/**
 * How many of the items `current` counts done were already done in `earlier`:
 * the same item by tracker id, or by text when it has no id. A fresh list
 * shares no item with the one before it, so nothing carries over.
 */
function countCarriedOverDone(earlier: Map<string, ChecklistItem>, current: Map<string, ChecklistItem>): number {
  // Counted per identity, so two items with the same text each match once.
  const doneEarlier = new Map<string, number>();
  for (const { status, identity } of earlier.values()) {
    if (status === 'completed' && identity) {
      doneEarlier.set(identity, (doneEarlier.get(identity) ?? 0) + 1);
    }
  }
  let carriedOver = 0;
  for (const { status, identity } of current.values()) {
    const unmatched = doneEarlier.get(identity) ?? 0;
    if (status === 'completed' && unmatched > 0) {
      carriedOver += 1;
      doneEarlier.set(identity, unmatched - 1);
    }
  }
  return carriedOver;
}

/**
 * Where the pace of the turn's checklist is measured from: when the timed
 * window opened, and how many of the items done now were done by then.
 *
 * The window is the turn's own. It opens at the turn's start, on the list as
 * it stood just above the user message that opened the turn, which is empty
 * when no list came before it. That list cannot be known when the user
 * message is above the loaded rows, or when the list began above them. The
 * turn's oldest checklist row that can be read in full then stands in for
 * it. Items that row already shows done may have been finished before the
 * turn or during it, and the two cannot be told apart, so the window then
 * opens at that row.
 */
function readChecklistWindow(
  messages: ChatMessage[],
  turnOpenIndex: number,
  lastChecklistIndex: number,
  current: Map<string, ChecklistItem>,
  turnStartedAt: number,
): { startedAt: number; doneAtStart: number } {
  const opening = turnOpenIndex >= 0 ? rebuildChecklist(messages, turnOpenIndex - 1) : null;
  if (opening) {
    return { startedAt: turnStartedAt, doneAtStart: countCarriedOverDone(opening, current) };
  }

  // The newest row always reads: the current list was rebuilt from it.
  let earliestIndex = lastChecklistIndex;
  let earliest = current;
  for (let index = turnOpenIndex + 1; index < lastChecklistIndex; index += 1) {
    const items = isChecklistRow(messages[index]) ? rebuildChecklist(messages, index) : null;
    if (items) {
      earliestIndex = index;
      earliest = items;
      break;
    }
  }
  const doneAtStart = countCarriedOverDone(earliest, current);
  if (doneAtStart === 0) {
    // Nothing that row shows done is done now, so there is nothing to leave
    // out and the turn's clock stands.
    return { startedAt: turnStartedAt, doneAtStart: 0 };
  }
  const rowTime = new Date(messages[earliestIndex].timestamp).getTime();
  return { startedAt: Number.isFinite(rowTime) ? Math.max(turnStartedAt, rowTime) : turnStartedAt, doneAtStart };
}

/**
 * Where the newest turn sits in the rows: the user message that opened it
 * (-1 when that message is above the loaded rows, so every loaded row is the
 * turn's) and the turn's newest checklist row (-1 when it has none).
 */
function locateTurn(messages: ChatMessage[]): { turnOpenIndex: number; lastChecklistIndex: number } {
  let lastChecklistIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type === 'user') {
      return { turnOpenIndex: index, lastChecklistIndex };
    }
    if (lastChecklistIndex === -1 && isChecklistRow(message)) {
      lastChecklistIndex = index;
    }
  }
  return { turnOpenIndex: -1, lastChecklistIndex };
}

/**
 * The checklist of the turn in flight, counted. The newest user message
 * opened that turn; a checklist above it belongs to a turn that is over and
 * says nothing about this one, so it is never borrowed — though the items it
 * had done, when the turn carries its list on, are left out of the turn's pace.
 */
function readTurnChecklistProgress(messages: ChatMessage[], turnStartedAt: number): ActivityProgress | null {
  const { turnOpenIndex, lastChecklistIndex } = locateTurn(messages);
  if (lastChecklistIndex === -1) {
    return null;
  }

  const items = rebuildChecklist(messages, lastChecklistIndex);
  if (!items || items.size === 0) {
    return null;
  }
  let done = 0;
  let running = 0;
  for (const { status } of items.values()) {
    if (status === 'completed') {
      done += 1;
    } else if (status === 'in_progress') {
      running += 1;
    }
  }
  const { startedAt, doneAtStart } = readChecklistWindow(
    messages,
    turnOpenIndex,
    lastChecklistIndex,
    items,
    turnStartedAt,
  );
  return {
    unit: 'tasks',
    done,
    total: items.size,
    running,
    startedAt,
    ...(doneAtStart > 0 ? { doneAtStart } : {}),
  };
}

/**
 * What the activity tab's progress readout counts for the viewed session: the
 * agents of the newest workflow still running, else — while a turn is in
 * flight — that turn's checklist. Null when the session is not busy or has
 * nothing to count, which leaves the tab as it was.
 *
 * Once the turn has ended and only background work remains, the checklist no
 * longer counts: nothing advances it until the next turn, so its fraction and
 * the time left extrapolated from it would only drift.
 */
export function deriveActivityProgress(messages: ChatMessage[], activity: SessionActivity | null): ActivityProgress | null {
  if (!activity) {
    return null;
  }
  return readRunningWorkflowProgress(messages, activity.startedAt)
    ?? (activity.background ? null : readTurnChecklistProgress(messages, activity.startedAt));
}

// ---------------------------

//----------------- PROGRESS READOUT ------------

/** How long the timed window must have run before its pace is worth extrapolating into a time left. */
const MIN_ELAPSED_FOR_ESTIMATE_MS = 30_000;

/**
 * A workflow's time left from its agents' own timing: the running agents end
 * about when the last of them has run as long as a finished agent took on
 * average, and the queued slots then run in waves as wide as the running set.
 * Null when nothing left is running or queued (agents a stop abandoned), as
 * there is nothing to time.
 */
function estimateFromAgentTiming(timing: NonNullable<ActivityProgress['agentTiming']>, nowMs: number): number | null {
  const { meanDurationMs, runningStartedAt, queued } = timing;
  if (runningStartedAt.length === 0 && queued === 0) {
    return null;
  }
  let runningLeftMs = 0;
  for (const startedAt of runningStartedAt) {
    runningLeftMs = Math.max(runningLeftMs, meanDurationMs - Math.max(0, nowMs - startedAt));
  }
  return runningLeftMs + Math.ceil(queued / Math.max(1, runningStartedAt.length)) * meanDurationMs;
}

/**
 * The time left at `nowMs` (epoch ms). Null until a unit has finished inside
 * the timed window, while the window is too young for a pace to mean
 * anything, and once every unit is done.
 *
 * A workflow whose live stream timed its agents is estimated from that
 * timing. Otherwise the pace of the units finished since the window opened is
 * extrapolated: elapsed × (total − done) / (done − doneAtStart). That pace
 * cannot tell agents running side by side from agents run one after another,
 * so it gives no estimate while more than one agent runs.
 */
export function estimateRemainingMs(progress: ActivityProgress, nowMs: number): number | null {
  const { done, total, doneAtStart = 0, agentTiming } = progress;
  const doneInWindow = done - doneAtStart;
  const elapsedMs = nowMs - progress.startedAt;
  if (doneInWindow <= 0 || done >= total || elapsedMs < MIN_ELAPSED_FOR_ESTIMATE_MS) {
    return null;
  }
  if (agentTiming) {
    return estimateFromAgentTiming(agentTiming, nowMs);
  }
  if (progress.unit === 'agents' && progress.running > 1) {
    return null;
  }
  return (elapsedMs * (total - done)) / doneInWindow;
}

/** The share finished as a whole percent. It reads 100 only once every unit is done, so work still open never looks complete. */
export function computeProgressPercent(progress: Pick<ActivityProgress, 'done' | 'total'>): number {
  const { done, total } = progress;
  if (total <= 0) {
    return 0;
  }
  if (done >= total) {
    return 100;
  }
  return Math.min(99, Math.round((done / total) * 100));
}

/**
 * `3/7 agents` or `3/7 tasks`, pluralized on the total. The keys name the
 * chat namespace, so a translator bound to any namespace can render it.
 */
export function formatProgressCount(progress: Pick<ActivityProgress, 'unit' | 'done' | 'total'>, t: TFunction): string {
  const values = { done: progress.done, count: progress.total };
  return progress.unit === 'agents'
    ? t('chat:runProgress.agents', { ...values, defaultValue_one: '{{done}}/{{count}} agent', defaultValue_other: '{{done}}/{{count}} agents' })
    : t('chat:runProgress.tasks', { ...values, defaultValue_one: '{{done}}/{{count}} task', defaultValue_other: '{{done}}/{{count}} tasks' });
}

/**
 * A time-left estimate as the readout prints it — `<1m left`, `~3m left`,
 * `~1h 5m left` — rounded to the minute, the tilde marking it as an estimate.
 */
export function formatRemainingEstimate(remainingMs: number, t: TFunction): string {
  if (remainingMs < 60_000) {
    return t('chat:runProgress.eta.underMinute', { defaultValue: '<1m left' });
  }
  const totalMinutes = Math.round(remainingMs / 60_000);
  if (totalMinutes < 60) {
    return t('chat:runProgress.eta.minutes', { minutes: totalMinutes, defaultValue: '~{{minutes}}m left' });
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0
    ? t('chat:runProgress.eta.hours', { hours, defaultValue: '~{{hours}}h left' })
    : t('chat:runProgress.eta.hoursMinutes', { hours, minutes, defaultValue: '~{{hours}}h {{minutes}}m left' });
}

/**
 * An elapsed time as the activity tab prints it — `45s`, `3m 12s` — in the
 * user's language. Whole seconds rounded down, so a time counted from the
 * tab's clock ticks with it.
 */
export function formatElapsed(elapsedMs: number, t: TFunction): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes < 1
    ? t('chat:claudeStatus.elapsed.seconds', { count: seconds, defaultValue: '{{count}}s' })
    : t('chat:claudeStatus.elapsed.minutesSeconds', { minutes, seconds, defaultValue: '{{minutes}}m {{seconds}}s' });
}

// ---------------------------

//----------------- ACTIVITY DETAILS ------------

/**
 * Whether a busy session's turn runs in a Claude CLI process CloudCLI does not
 * drive (a Shell tab's `claude --resume`, a run owned by another CloudCLI
 * instance). The server lists such a turn as one that cannot be stopped here,
 * and background work is the only other entry like that. No live events reach
 * the view for it: its transcript on disk is the only source.
 */
export function isCliDrivenActivity(activity: SessionActivity | null | undefined): boolean {
  return Boolean(activity && !activity.background && !activity.canInterrupt);
}

/** How many agents the details panel lists for one workflow; the rest fold into "+N more". */
const MAX_LISTED_AGENTS = 8;

/** How many workflows the details panel lists; the rest fold into "+N more". */
const MAX_LISTED_WORKFLOWS = 3;

/** The order the details panel lists a workflow's agents in: those at work, then those done, then those waiting. */
const AGENT_LIST_GROUP: Record<WorkflowAgentRow['status'], number> = {
  running: 0,
  completed: 1,
  failed: 1,
  stopped: 1,
  queued: 2,
};

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** How long an agent has run at `nowMs`, or ran once it finished, when the live stream timed it. */
function readAgentElapsedMs(row: WorkflowAgentRow, nowMs: number): number | undefined {
  if (row.status === 'running') {
    return isFiniteNumber(row.startedAt) ? Math.max(0, nowMs - row.startedAt) : undefined;
  }
  if (row.status === 'queued') {
    return undefined;
  }
  return isFiniteNumber(row.durationMs) && row.durationMs >= 0 ? row.durationMs : undefined;
}

/**
 * A workflow's agents as the details panel lists them: the running ones, then
 * the finished ones, the newest of each first (the merged list is in spawn
 * order), then the queued slots in the order they will start — so a capped
 * list still shows what the run is doing now.
 */
function listWorkflowAgents(rows: WorkflowAgentRow[], nowMs: number): ActivityDetailsAgent[] {
  return rows
    .map((row, position) => ({ row, position }))
    .sort((a, b) => (
      AGENT_LIST_GROUP[a.row.status] - AGENT_LIST_GROUP[b.row.status]
      || (a.row.status === 'queued' ? a.position - b.position : b.position - a.position)
    ))
    .map(({ row }) => {
      const elapsedMs = readAgentElapsedMs(row, nowMs);
      return {
        key: row.key,
        label: describeWorkflowAgent(row),
        status: row.status,
        ...(row.phase ? { phase: row.phase } : {}),
        ...(elapsedMs === undefined ? {} : { elapsedMs }),
      };
    });
}

/** A workflow's name and what it does, read in the order its card reads them: the journal, the live stream, the script's header, the call. */
function readWorkflowIdentity(message: ChatMessage): Pick<ActivityDetailsWorkflow, 'name' | 'description'> {
  const input = readRecord(parseToolPayload(message.toolInput)) ?? {};
  const meta = typeof input.script === 'string' ? parseWorkflowMeta(input.script) : null;
  return {
    name: message.workflow?.name || message.taskStatus?.workflowName || meta?.name || '',
    description: message.workflow?.description
      || meta?.description
      || (typeof input.description === 'string' ? input.description : ''),
  };
}

/** One `Workflow` row's run as the details panel draws it, at `nowMs`. */
function readWorkflowDetails(
  message: ChatMessage,
  status: BackgroundTaskStatus,
  index: number,
  nowMs: number,
  fallbackStartedAt: number,
): ActivityDetailsWorkflow {
  const isRunning = status === 'running';
  const { rows, startedAt, progress } = countWorkflowRun(message, isRunning, fallbackStartedAt);
  const agents = listWorkflowAgents(rows, nowMs);
  // A finished run's own wall time, from the CLI's last word on it.
  const reportedDurationMs = message.taskStatus?.usage?.durationMs;
  return {
    key: message.toolId ?? `workflow-row-${index}`,
    ...readWorkflowIdentity(message),
    status,
    progress,
    elapsedMs: isRunning
      ? Math.max(0, nowMs - startedAt)
      : isFiniteNumber(reportedDurationMs) ? reportedDurationMs : null,
    remainingMs: isRunning && progress ? estimateRemainingMs(progress, nowMs) : null,
    agents: agents.slice(0, MAX_LISTED_AGENTS),
    hiddenAgentCount: Math.max(0, agents.length - MAX_LISTED_AGENTS),
  };
}

/**
 * The checklist of the turn in flight, item by item as the checklist view
 * draws it. Null when the turn has none, or when the list cannot be known in
 * full (it began above the loaded rows): a partial list would draw a false
 * count, as the readout's rebuild says.
 */
function readTurnChecklistItems(messages: ChatMessage[], lastChecklistIndex: number): ActivityDetails['checklist'] {
  const items = lastChecklistIndex === -1 ? null : rebuildChecklist(messages, lastChecklistIndex);
  if (!items || items.size === 0) {
    return null;
  }
  const listed = [...items].map(([key, { status, text }]) => ({ key, text, status }));
  return {
    items: listed,
    done: listed.filter((item) => item.status === 'completed').length,
    total: listed.length,
  };
}

/**
 * The background tasks the panel lists: the session's own, as the tab names
 * them, newest first, less the workflows the panel already draws from their
 * transcript rows. A workflow whose row is not loaded is still listed here.
 */
function listActivityTasks(
  activity: SessionActivity,
  drawnWorkflowIds: ReadonlySet<string>,
  nowMs: number,
): ActivityDetailsTask[] {
  return ownBackgroundTasks(activity.tasks ?? [])
    .filter((task) => !drawnWorkflowIds.has(task.toolUseId))
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((task) => ({ ...task, elapsedMs: Math.max(0, nowMs - task.startedAt) }));
}

/**
 * What the activity tab's details panel lists for the viewed session at
 * `nowMs` (the tab's clock, epoch ms), from the rows the tab's readout counts:
 *
 * - every workflow still running, whichever turn launched it, then the ones
 *   the current turn saw end, newest first in each, each with its agents;
 * - the checklist of the turn in flight, item by item; none once the turn is
 *   over, since nothing advances it until the next one;
 * - the session's background tasks, less the workflows already drawn;
 * - the run itself, and whether a Claude CLI process CloudCLI does not drive
 *   is behind it — then no live events reach the view, and what is listed
 *   comes from the transcript, reloaded as the CLI writes it.
 *
 * Null when the session is not busy.
 */
export function deriveActivityDetails(
  messages: ChatMessage[],
  activity: SessionActivity | null,
  nowMs: number,
): ActivityDetails | null {
  if (!activity) {
    return null;
  }
  const { turnOpenIndex, lastChecklistIndex } = locateTurn(messages);

  const running: ActivityDetailsWorkflow[] = [];
  const ended: ActivityDetailsWorkflow[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isWorkflowLaunch(message)) {
      continue;
    }
    const status = resolveWorkflowRunStatus(message);
    if (status === 'running') {
      running.push(readWorkflowDetails(message, status, index, nowMs, activity.startedAt));
    } else if (index > turnOpenIndex) {
      ended.push(readWorkflowDetails(message, status, index, nowMs, activity.startedAt));
    }
  }
  const workflows = [...running, ...ended];

  return {
    run: {
      statusText: activity.statusText,
      elapsedMs: Math.max(0, nowMs - activity.startedAt),
      isBackground: Boolean(activity.background),
      isCliDriven: isCliDrivenActivity(activity),
    },
    workflows: workflows.slice(0, MAX_LISTED_WORKFLOWS),
    hiddenWorkflowCount: Math.max(0, workflows.length - MAX_LISTED_WORKFLOWS),
    checklist: activity.background ? null : readTurnChecklistItems(messages, lastChecklistIndex),
    tasks: listActivityTasks(activity, new Set(workflows.map((workflow) => workflow.key)), nowMs),
  };
}
