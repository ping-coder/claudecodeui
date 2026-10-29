import { useTranslation } from 'react-i18next';
import { AlertTriangle, Clock, X } from 'lucide-react';

import type { ScheduledMessage } from '@/shared/types';
import { formatDateTime } from '@/modules/chat/utils/chatFormatting';

type ScheduledMessageListProps = {
  scheduledMessages: ScheduledMessage[];
  onCancel: (id: string) => void;
};

/**
 * The failure reasons the server records as a code (the scheduled-messages dispatcher, when the
 * process held for the session's scheduled work turned the message away), with the key that words
 * each after "Not sent —". Any other reason is the server's own text, shown as it is.
 */
const FAILURE_REASON_KEYS: Readonly<Record<string, string>> = {
  'hand_over_failed:stale-plan': 'chat:schedule.failureReason.stalePlan',
  'hand_over_failed:lookup': 'chat:schedule.failureReason.lookup',
};

/**
 * Rendered by ChatComposer above the input, so a message waiting to be sent is
 * visible in the session it will be sent to — and can be called off.
 *
 * Failed ones are shown too: a message that did not go is exactly the thing a
 * user needs to know about, and the server records why. Dismissing one goes
 * through the same cancel endpoint, so it stays gone across reloads.
 */
export function ScheduledMessageList({ scheduledMessages, onCancel }: ScheduledMessageListProps) {
  const { t, i18n } = useTranslation('chat');
  const visible = scheduledMessages.filter(
    (message) => message.status === 'pending' || message.status === 'failed',
  );

  if (visible.length === 0) {
    return null;
  }

  return (
    <div className="mx-auto mb-2 flex max-w-[54.25rem] flex-col gap-1.5">
      {visible.map((message) => {
        const isFailed = message.status === 'failed';
        const failureReason = message.failureReason ?? '';
        const failureReasonKey = Object.prototype.hasOwnProperty.call(FAILURE_REASON_KEYS, failureReason)
          ? FAILURE_REASON_KEYS[failureReason]
          : null;

        return (
          <div
            key={message.id}
            className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-xs ${
              isFailed
                ? 'border-red-500/30 bg-red-500/10'
                : 'border-border/60 bg-muted/40'
            }`}
          >
            {isFailed ? (
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
            ) : (
              <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-muted-foreground">
                {isFailed
                  ? t('schedule.failed', { reason: failureReasonKey ? t(failureReasonKey) : failureReason })
                  : t('schedule.pending', {
                    // In the interface language. A right-to-left one isolates the value (i18n's bidi
                    // handling), so the date keeps its order inside the sentence.
                    when: formatDateTime(message.scheduledFor, i18n.language),
                  })}
              </p>
              {/* bidi-auto: right to left, the message reads by its own first letter and is cut at its end. */}
              <p className="bidi-auto mt-0.5 truncate text-foreground">{message.content}</p>
            </div>
            <button
              type="button"
              onClick={() => onCancel(message.id)}
              title={isFailed ? t('schedule.dismiss') : t('schedule.cancel')}
              aria-label={isFailed ? t('schedule.dismiss') : t('schedule.cancel')}
              className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
