import { useTranslation } from 'react-i18next';

import type { ShellSessionBusy } from '@/shared/types';
import { describeBackgroundTask, ownBackgroundTasks } from '@/shared/utils';

// The most tasks the notice names; the rest are counted.
const MAX_LISTED_TASKS = 5;

// English for each reason, the fallback where a language has no entry.
const REASON_DEFAULTS: Record<ShellSessionBusy['reason'], string> = {
  turn: 'A chat turn is still running.',
  background: 'Background tasks are still running:',
  held: 'CloudCLI\'s Claude process still has this session open, most likely waiting on a Monitor or a scheduled wake-up.',
  exiting: 'CloudCLI\'s Claude process is shutting down. This usually takes seconds, at most about 6 minutes.',
  queued: 'A queued chat message goes out as soon as the session is free.',
};

type ShellSessionBusyNoticeProps = {
  busy: ShellSessionBusy;
  isTakingOver: boolean;
  onRetry: () => void;
  onTakeOver: () => void;
};

/**
 * Rendered by Shell over the terminal while the server holds the CLI back
 * because CloudCLI still runs the session: says what runs there and what a
 * second process would do, and offers to ask again or to stop that work and
 * open the session here. No takeover while a chat message is queued: the
 * dispatcher would send it, in a new process, as soon as the session is free.
 * After a takeover the server refused, because more had started than the
 * notice showed, it says so above the new state.
 */
export default function ShellSessionBusyNotice({ busy, isTakingOver, onRetry, onTakeOver }: ShellSessionBusyNoticeProps) {
  const { t } = useTranslation('chat');
  const tasks = ownBackgroundTasks(busy.tasks);
  const listedTasks = tasks.slice(0, MAX_LISTED_TASKS);
  const unlistedCount = tasks.length - listedTasks.length;

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center overflow-y-auto bg-card/95 p-6">
      <div role="status" className="flex w-full max-w-md flex-col gap-3 text-sm leading-6">
        <h3 className="text-base font-semibold text-foreground">
          {t('shell.sessionBusy.title', { defaultValue: 'CloudCLI is still using this session' })}
        </h3>
        {busy.changed && (
          <p className="font-medium text-foreground">
            {t('shell.sessionBusy.changed', {
              defaultValue: 'New work started on this session since you last looked, so nothing was stopped. Check what is running now before stopping it.',
            })}
          </p>
        )}
        <p className="text-muted-foreground">
          {t(`shell.sessionBusy.reason.${busy.reason}`, { defaultValue: REASON_DEFAULTS[busy.reason] })}
        </p>
        {listedTasks.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-foreground">
            {listedTasks.map((task) => (
              <li key={task.taskId} className="break-words">{describeBackgroundTask(task, t)}</li>
            ))}
            {unlistedCount > 0 && (
              <li className="list-none text-muted-foreground">
                {t('shell.sessionBusy.moreTasks', { count: unlistedCount, defaultValue: '+{{count}} more' })}
              </li>
            )}
          </ul>
        )}
        <p className="text-muted-foreground">
          {t('shell.sessionBusy.consequence', {
            defaultValue: 'Opening it in the terminal now would have two processes writing to this session, and running tasks would be recorded as stopped.',
          })}
        </p>
        {busy.hasQueuedMessage && (
          <p className="font-medium text-foreground">
            {t('shell.sessionBusy.queuedHint', { defaultValue: 'Send or withdraw the queued message in the chat first.' })}
          </p>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            onClick={onRetry}
            disabled={isTakingOver}
            className="inline-flex min-h-9 items-center justify-center rounded-md border border-border bg-background px-4 py-1.5 font-medium text-foreground transition-colors hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('shell.sessionBusy.retry', { defaultValue: 'Try again' })}
          </button>
          {!busy.hasQueuedMessage && (
            <button
              type="button"
              onClick={onTakeOver}
              disabled={isTakingOver}
              className="inline-flex min-h-9 items-center justify-center rounded-md bg-red-600 px-4 py-1.5 font-medium text-white transition-colors hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-red-300 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isTakingOver
                ? t('shell.sessionBusy.takingOver', { defaultValue: 'Stopping…' })
                : t('shell.sessionBusy.takeOver', { defaultValue: 'Stop it and open here' })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
