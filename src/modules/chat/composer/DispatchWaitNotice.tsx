import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Loader2 } from 'lucide-react';

import type { DispatchWait } from '@/shared/types';
import { describeHandOverChanges, describeHandOverDetails, handOverMountsChanged } from '@/shared/utils';
import type { DispatchWaitBusy, DispatchWaitNotice as Notice } from '@/modules/chat/composer/useDispatchWaits';
import { formatDateTime } from '@/modules/chat/utils/chatFormatting';

type DispatchWaitNoticeProps = {
  wait: DispatchWait;
  /** The user chose to keep waiting: the actions are folded away, the reason stays. */
  folded: boolean;
  busy: DispatchWaitBusy | null;
  notice: Notice | null;
  onStopAndSend: () => void;
  onUseProcessSettings: () => void;
  onKeepWaiting: () => void;
  onShowActions: () => void;
  onCancel: () => void;
};

const isoOf = (epochMs: number): string => new Date(epochMs).toISOString();

/** Whether loops alone hold the session's process, so the wait is worded as one for a loop (see DispatchWait). */
const heldForLoops = (wait: DispatchWait): boolean => wait.heldFor !== 'work';

/** Why the message waits, in one line. */
function describeReason(wait: DispatchWait, t: TFunction, language: string): string {
  switch (wait.reason) {
    case 'held_settings': {
      const changes = describeHandOverChanges(wait.changes, t);
      if (!heldForLoops(wait)) {
        return changes.count === 0
          ? t('dispatchWait.heldWork', { defaultValue: 'Waiting for the background work to finish' })
          : t('dispatchWait.heldSettingsWork', {
              changes: changes.text,
              defaultValue: 'Waiting for the background work to finish: this message changes {{changes}}',
            });
      }
      const time = wait.holdUntil !== null ? formatDateTime(isoOf(wait.holdUntil), language) : null;
      if (changes.count === 0) {
        return time
          ? t('dispatchWait.heldLoop', { time, defaultValue: 'Waiting for the loop to end (by {{time}})' })
          : t('dispatchWait.heldLoopUntimed', { defaultValue: 'Waiting for the loop to end' });
      }
      return time
        ? t('dispatchWait.heldSettings', {
            time,
            changes: changes.text,
            defaultValue: 'Waiting for the loop to end (by {{time}}): this message changes {{changes}}',
          })
        : t('dispatchWait.heldSettingsUntimed', {
            changes: changes.text,
            defaultValue: 'Waiting for the loop to end: this message changes {{changes}}',
          });
    }
    case 'retry':
      return wait.retryAt !== undefined
        ? t('dispatchWait.retry', {
            time: formatDateTime(isoOf(wait.retryAt), language),
            defaultValue: 'The loop\'s process turned this message away; it is tried again at {{time}}',
          })
        : t('dispatchWait.retryUntimed', { defaultValue: 'The loop\'s process turned this message away; it is tried again soon' });
    case 'behind':
      return t('dispatchWait.behind', { defaultValue: 'Waiting for an earlier scheduled message to go' });
    default:
      return t('dispatchWait.heldWork', { defaultValue: 'Waiting for the background work to finish' });
  }
}

/** What sending with the held process's settings means for this message, said before the user picks it. */
function describeConsequence(wait: DispatchWait, t: TFunction): string {
  const loops = heldForLoops(wait);
  if (wait.details?.permissionMode?.process === 'plan') {
    return loops
      ? t('dispatchWait.consequence.plan', { defaultValue: 'With the loop\'s settings it runs in plan mode, like the loop: Claude only makes a plan.' })
      : t('dispatchWait.consequence.planWork', { defaultValue: 'With the background process\'s settings it runs in plan mode: Claude only makes a plan.' });
  }
  const allowed = wait.details?.tools?.notAllowed ?? [];
  if (allowed.length > 0) {
    const tools = allowed.join(t('claudeStatus.backgroundTask.prompt.changeSeparator', { defaultValue: ', ' }));
    return loops
      ? t('dispatchWait.consequence.tools', {
          tools,
          defaultValue: 'With the loop\'s settings it uses the loop\'s tool permissions, which allow {{tools}}.',
        })
      : t('dispatchWait.consequence.toolsWork', {
          tools,
          defaultValue: 'With the background process\'s settings it uses that process\'s tool permissions, which allow {{tools}}.',
        });
  }
  return loops
    ? t('dispatchWait.consequence.settings', { defaultValue: 'With the loop\'s settings it runs on the loop\'s model, effort and permissions.' })
    : t('dispatchWait.consequence.settingsWork', { defaultValue: 'With the background process\'s settings it runs on that process\'s model, effort and permissions.' });
}

/**
 * Rendered by chat's QueuedMessageCard and ScheduledMessageList under a message the server holds
 * back (see DispatchWait): why it waits, in one line, what exactly keeps it out, and what the user
 * can do. "Stop the loop and send" comes first, in the destructive style, as the background-send
 * dialog's "Send anyway"; "Send with the loop's settings" says what that means for the message.
 * A process a task holds too is not called a loop: the wait, the details and the lending action
 * speak of the background work and the background process instead.
 * "Keep waiting" folds the actions away, leaving the reason and a way to unfold them. An action
 * under way reads so, and what it came to is said under the actions.
 */
export default function DispatchWaitNotice({
  wait,
  folded,
  busy,
  notice,
  onStopAndSend,
  onUseProcessSettings,
  onKeepWaiting,
  onShowActions,
  onCancel,
}: DispatchWaitNoticeProps) {
  const { t, i18n } = useTranslation('chat');
  const loops = heldForLoops(wait);
  // The project's mounts changing is no change of the message, so it is no part of the reason's
  // "this message changes …": it is a line of its own among what keeps the message out.
  const mountsLine = wait.reason === 'held_settings' && handOverMountsChanged(wait.changes)
    ? loops
      ? t('dispatchWait.detail.mounts', { defaultValue: 'The project\'s mounted folders changed after the loop\'s process started' })
      : t('dispatchWait.detail.mountsWork', { defaultValue: 'The project\'s mounted folders changed after the background process started' })
    : null;
  const details = [
    ...(mountsLine ? [mountsLine] : []),
    ...describeHandOverDetails(wait.details, t, loops ? 'loops' : 'work'),
  ];
  const can = (action: DispatchWait['actions'][number]) => wait.actions.includes(action);
  const offersMore = can('stop_work_and_send') || can('use_process_settings');
  const quietButton = 'rounded px-2 py-0.5 font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50';

  const describeNotice = (kind: Notice): string => {
    switch (kind) {
      case 'stopFailed':
        return t('dispatchWait.stopFailed', { defaultValue: 'The loop was not stopped. Try again, or stop it from the task strip.' });
      case 'stopAfterTurn':
        return t('scheduledWork.stopAfterTurn', { defaultValue: 'Stop it after this turn ends' });
      default:
        return t('dispatchWait.useFailed', { defaultValue: 'That did not work. The message may have gone already.' });
    }
  };

  return (
    <div className="mt-1 text-xs" data-dispatch-wait={wait.reason}>
      <p className="text-amber-700 dark:text-amber-300">{describeReason(wait, t, i18n.language)}</p>
      {details.map((line) => (
        <p key={line} className="text-muted-foreground">{line}</p>
      ))}
      {busy ? (
        <p className="mt-1 flex items-center gap-1 text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          {busy === 'stopping'
            ? t('dispatchWait.stopping', { defaultValue: 'Stopping the loop…' })
            : loops
              ? t('dispatchWait.using', { defaultValue: 'Sending with the loop\'s settings…' })
              : t('dispatchWait.usingWork', { defaultValue: 'Sending with the background process\'s settings…' })}
        </p>
      ) : folded ? (
        offersMore && (
          <button type="button" onClick={onShowActions} className={`mt-1 ${quietButton} px-0`}>
            {t('dispatchWait.showActions', { defaultValue: 'Options' })}
          </button>
        )
      ) : (
        <>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {can('stop_work_and_send') && (
              <button
                type="button"
                onClick={onStopAndSend}
                className="rounded bg-destructive px-2 py-0.5 font-medium text-destructive-foreground hover:bg-destructive/90"
              >
                {t('dispatchWait.action.stopAndSend', { defaultValue: 'Stop the loop and send' })}
              </button>
            )}
            {can('use_process_settings') && (
              <button
                type="button"
                onClick={onUseProcessSettings}
                className="rounded border border-border px-2 py-0.5 font-medium text-foreground hover:bg-accent"
              >
                {loops
                  ? t('dispatchWait.action.useProcessSettings', { defaultValue: 'Send with the loop\'s settings' })
                  : t('dispatchWait.action.useProcessSettingsWork', { defaultValue: 'Send with the background process\'s settings' })}
              </button>
            )}
            {offersMore && can('keep_waiting') && (
              <button type="button" onClick={onKeepWaiting} className={quietButton}>
                {t('dispatchWait.action.keepWaiting', { defaultValue: 'Keep waiting' })}
              </button>
            )}
            {can('cancel') && (
              <button type="button" onClick={onCancel} className={quietButton}>
                {t('dispatchWait.action.cancel', { defaultValue: 'Cancel' })}
              </button>
            )}
          </div>
          {can('use_process_settings') && (
            <p className="mt-1 text-muted-foreground">{describeConsequence(wait, t)}</p>
          )}
        </>
      )}
      {notice && !busy && <p role="status" className="mt-1 text-destructive">{describeNotice(notice)}</p>}
    </div>
  );
}
