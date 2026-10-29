import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import type { BackgroundSendChoice, BackgroundSendPrompt } from '@/shared/types';
import { describeHandOverChanges } from '@/shared/utils';

type BackgroundSendDialogProps = {
  prompt: BackgroundSendPrompt | null;
  onResolve: (choice: BackgroundSendChoice) => void;
};

/**
 * Rendered by chat's ChatComposer when a message is sent to a session whose
 * turn has ended but whose background work is still running, and sending
 * would stop that work: the provider starts a new process for every turn, or
 * the message replaces an already-sent one, or (Claude, which runs a new turn
 * in the process the work runs in) the message needs a new process, which the
 * dialog names: a setting changed since that process started, from the
 * server's hand-over plan or its refusal of the send. The choices are to send
 * anyway, queue the message until the work finishes, or cancel.
 *
 * Cancel comes first in the DOM so Dialog's open-focus lands on it: an Enter
 * pressed right after the send that opened the prompt (a double Enter, a key
 * repeat) cancels instead of stopping the work. Esc and a click outside also
 * cancel. Sending anyway takes a deliberate click or Tab.
 */
export default function BackgroundSendDialog({ prompt, onResolve }: BackgroundSendDialogProps) {
  const { t } = useTranslation('chat');
  // Per instance: each pane's composer renders its own dialog.
  const descriptionId = useId();
  const reasonId = useId();

  const changes = prompt?.changes;
  // The settings named; `lookup`, the server failing to prepare the turn for
  // the process at all, gets a sentence of its own.
  const changedSettings = describeHandOverChanges(changes ?? [], t);
  const lookupFailed = Boolean(changes?.includes('lookup'));
  // What keeps the message out of the work's process is read out with the description.
  const describedBy = changedSettings.count > 0 || lookupFailed ? `${reasonId} ${descriptionId}` : descriptionId;

  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open) {
          onResolve('cancel');
        }
      }}
    >
      <DialogContent aria-describedby={describedBy} className="p-5">
        <DialogTitle className="not-sr-only text-base font-semibold text-foreground">
          {t('claudeStatus.backgroundTask.prompt.title', {
            defaultValue: 'This session still has background work running',
          })}
        </DialogTitle>

        {prompt && prompt.work.length > 0 && (
          <ul className="mt-3 list-disc space-y-1 ps-5 text-sm text-foreground/90">
            {prompt.work.map((item, index) => (
              <li key={`${index}-${item}`} className="break-words">{item}</li>
            ))}
          </ul>
        )}

        {(changedSettings.count > 0 || lookupFailed) && (
          <div id={reasonId}>
            {changedSettings.count > 0 && (
              <p className="mt-3 text-sm text-foreground">
                {t('claudeStatus.backgroundTask.prompt.changes', {
                  count: changedSettings.count,
                  changes: changedSettings.text,
                  defaultValue: 'This message changes {{changes}}, which only a new process can apply. Change them back to send it without stopping the work.',
                })}
              </p>
            )}
            {lookupFailed && (
              <p className="mt-3 text-sm text-foreground">
                {t('claudeStatus.backgroundTask.prompt.lookupFailed', {
                  defaultValue: 'The message could not be handed to the process the work runs in.',
                })}
              </p>
            )}
          </div>
        )}

        <p id={descriptionId} className="mt-3 text-sm text-muted-foreground">
          {changes
            ? t('claudeStatus.backgroundTask.prompt.descriptionNewProcess', {
                defaultValue: 'Sending it anyway starts a new process, which stops that work; anything it has not reported yet is lost. Queue the message to send it when the work finishes.',
              })
            : t('claudeStatus.backgroundTask.prompt.description', {
                defaultValue: 'A new message starts a new turn, which stops that work; anything it has not reported yet is lost. Queue the message to send it when the work finishes.',
              })}
        </p>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onResolve('cancel')}>
            {t('claudeStatus.backgroundTask.prompt.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button type="button" variant="default" onClick={() => onResolve('queue')}>
            {t('claudeStatus.backgroundTask.prompt.queue', { defaultValue: 'Queue' })}
          </Button>
          <Button type="button" variant="destructive" onClick={() => onResolve('send')}>
            {t('claudeStatus.backgroundTask.prompt.sendAnyway', { defaultValue: 'Send anyway' })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
