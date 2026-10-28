import { useTranslation } from 'react-i18next';
import { Undo2Icon } from 'lucide-react';

import type { PendingInsert } from '@/shared/types';

type PendingInsertsCardProps = {
  inserts: PendingInsert[];
  providerLabel: string;
  /**
   * A permission request or plan approval is waiting. The turn is stopped at
   * that tool call, so the model reads the inserts once it is answered.
   */
  isAwaitingApproval: boolean;
  onWithdraw: (insertId: string) => void;
};

/**
 * Rendered by chat's ChatComposer above the input to list the messages
 * inserted into the running turn that the model has not read yet, each with a
 * withdraw button, in every pane and tab on the session.
 */
export default function PendingInsertsCard({
  inserts,
  providerLabel,
  isAwaitingApproval,
  onWithdraw,
}: PendingInsertsCardProps) {
  const { t } = useTranslation('chat');
  const withdrawLabel = t('input.insert.withdraw', { defaultValue: 'Withdraw inserted message' });

  return (
    <div className="settings-content-enter mx-auto mb-2 max-w-[54.25rem] rounded-xl rounded-t-none border border-dashed border-primary/25 bg-primary/[0.04] px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-primary/70">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary/60" aria-hidden />
        <span>{t('input.insert.label', { defaultValue: 'Inserting' })}</span>
        <span className="normal-case text-muted-foreground/60">
          ·{' '}
          {isAwaitingApproval
            ? t('input.insert.afterApproval', { defaultValue: 'Delivered once the request above is answered' })
            : t('input.insert.willRead', {
                provider: providerLabel,
                defaultValue: '{{provider}} reads it at its next step',
              })}
        </span>
      </div>

      <ul className="mt-1 space-y-1">
        {inserts.map((insert) => (
          <li key={insert.insertId} className="flex items-start gap-2.5">
            <p className="max-h-20 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words text-sm text-foreground/90">
              {insert.content}
            </p>
            {insert.state === 'delivering' || insert.state === 'withdrawFailed' ? (
              <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">
                {insert.state === 'delivering'
                  ? t('input.insert.delivering', { defaultValue: 'Already being delivered, cannot withdraw' })
                  : t('input.insert.withdrawFailed', { defaultValue: 'Could not withdraw' })}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onWithdraw(insert.insertId)}
                // Only an insert the server holds can be taken back.
                disabled={insert.state !== 'pending'}
                aria-label={withdrawLabel}
                title={withdrawLabel}
                className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
              >
                <Undo2Icon className="h-3.5 w-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
