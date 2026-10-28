import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { findSessionTab, layoutHasSession } from '@/modules/project-workspace/utils/workspaceLayout';
import type { Project, SessionActivity, SessionActivityMap, WorkspaceLayout } from '@/shared/types';
import { resolveDocumentSessionTitle, setDocumentTitleActivity } from '@/shared/utils';

type UseRunningSessionTitleInput = {
  activities: SessionActivityMap;
  projects: readonly Project[];
  layout: WorkspaceLayout;
};

/** What the running part counts: turns in flight, else, while no turn runs, sessions busy with agent or workflow tasks. */
type RunningTitleGroup = 'running' | 'background';

/** One session of the group, as the title effect reads it. */
type RunningTitleCandidate = {
  sessionId: string;
  /** Orders only the candidates that join the group together; see the arrival order below. */
  startedAt: number;
  /** A tab of either pane of this browser tab holds the session, which puts it ahead of the others. */
  isOpenHere: boolean;
  /** The session's title, named as the page part names the focused session (resolveDocumentSessionTitle). */
  subject: string;
};

/**
 * Everything the title effect reads. Its JSON form is the effect's only dependency, so a provider status
 * line (rewritten several times a second during a run) or a re-ordered poll leaves the title alone.
 */
type RunningTitleInput = {
  group: RunningTitleGroup;
  /** Localized marker for the whole group: "[Running 3]", "[Background]". */
  marker: string;
  /** Sorted by session id, so the same sessions always give the same key. */
  candidates: RunningTitleCandidate[];
};

/** Background work that may name the session: an agent or a workflow. A backgrounded shell command, often a dev server left running for hours, does not. */
const hasAgentOrWorkflowTask = (activity: SessionActivity): boolean =>
  Boolean(activity.tasks?.some((task) => task.taskType !== 'local_bash'));

/**
 * Keeps the running part of the browser tab title on the latest running session ("[Running 3] Fix
 * login bug"), and clears it on unmount. It counts CloudCLI turns and the external Claude CLI turns of
 * sessions this tab has open; only while none runs, sessions busy with agent or workflow tasks
 * ("[Background] Audit deps"). The session named is the last one to start among those this tab has
 * open (in any pane tab), else among all of them, so browser tabs showing different sessions read
 * differently. Run by ProjectEffects.
 */
export function useRunningSessionTitle({ activities, projects, layout }: UseRunningSessionTitleInput): void {
  const { t } = useTranslation('common');

  const runningEntries: Array<[string, SessionActivity]> = [];
  const backgroundEntries: Array<[string, SessionActivity]> = [];
  for (const [sessionId, activity] of activities) {
    if (activity.background) {
      if (hasAgentOrWorkflowTask(activity)) {
        backgroundEntries.push([sessionId, activity]);
      }
    } else if (activity.canInterrupt !== false || layoutHasSession(layout, sessionId)) {
      // A turn that cannot be interrupted is the Claude CLI's outside CloudCLI (a terminal, the Shell
      // view), found by the poll: it counts only while this tab has its session open.
      runningEntries.push([sessionId, activity]);
    }
  }

  let titleInputKey = '';
  const group: RunningTitleGroup | null = runningEntries.length > 0
    ? 'running'
    : backgroundEntries.length > 0 ? 'background' : null;
  if (group) {
    const candidates = (group === 'running' ? runningEntries : backgroundEntries)
      .map(([sessionId, activity]): RunningTitleCandidate => ({
        sessionId,
        startedAt: activity.startedAt,
        isOpenHere: layoutHasSession(layout, sessionId),
        subject: resolveDocumentSessionTitle(sessionId, projects, findSessionTab(layout, sessionId)?.tab.title, t),
      }))
      .sort((left, right) => (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0));

    const count = candidates.length;
    let marker: string;
    if (group === 'running') {
      marker = count === 1
        ? t('runNotifications.title.running', { defaultValue: '[Running]' })
        : t('runNotifications.title.runningCount', { count, defaultValue: '[Running {{count}}]' });
    } else {
      marker = count === 1
        ? t('runNotifications.title.background', { defaultValue: '[Background]' })
        : t('runNotifications.title.backgroundCount', { count, defaultValue: '[Background {{count}}]' });
    }

    // The localized marker and placeholder carry the language, so a language switch rewrites the title too.
    const titleInput: RunningTitleInput = { group, marker, candidates };
    titleInputKey = JSON.stringify(titleInput);
  }

  // The order in which this tab saw each candidate join its group, keyed `${group}:${sessionId}`: the
  // running part names the latest arrival. startedAt cannot order them directly, as it mixes the
  // browser's clock (a send from this tab) with the server's (the poll, which rewrites it); it only
  // orders the candidates that join together, such as the ones already running when the page loads.
  // A session that leaves and comes back (a new turn, a CLI turn back from a permission prompt, its
  // turn handing over to background work) arrives anew.
  const arrivalOrderRef = useRef(new Map<string, number>());
  // The number the next arrival gets. It only grows, so every arrival ranks above the ones before it.
  const nextArrivalRef = useRef(1);

  useEffect(() => {
    const arrivalOrder = arrivalOrderRef.current;
    if (!titleInputKey) {
      arrivalOrder.clear();
      setDocumentTitleActivity(null);
      return;
    }

    const { group: currentGroup, marker, candidates } = JSON.parse(titleInputKey) as RunningTitleInput;
    const arrivalKey = (candidate: RunningTitleCandidate) => `${currentGroup}:${candidate.sessionId}`;
    const present = new Set(candidates.map(arrivalKey));
    for (const key of arrivalOrder.keys()) {
      if (!present.has(key)) {
        arrivalOrder.delete(key);
      }
    }
    const arrivals = candidates
      .filter((candidate) => !arrivalOrder.has(arrivalKey(candidate)))
      .sort((left, right) => left.startedAt - right.startedAt);
    for (const candidate of arrivals) {
      arrivalOrder.set(arrivalKey(candidate), nextArrivalRef.current);
      nextArrivalRef.current += 1;
    }

    const openHere = candidates.filter((candidate) => candidate.isOpenHere);
    const pool = openHere.length > 0 ? openHere : candidates;
    const latest = pool.reduce((best, candidate) => (
      (arrivalOrder.get(arrivalKey(candidate)) ?? 0) > (arrivalOrder.get(arrivalKey(best)) ?? 0) ? candidate : best
    ));
    setDocumentTitleActivity({ marker, subject: latest.subject });
  }, [titleInputKey]);

  // Cleared only on unmount: the effect above writes each change over the last one, rather than
  // clearing the part and writing it again on every change.
  useEffect(() => () => setDocumentTitleActivity(null), []);
}
