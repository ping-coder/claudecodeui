import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronUpIcon } from 'lucide-react';

import type { BusySubmitMode, InsertUnavailableReason } from '@/shared/types';
import { Button } from '@/shared/ui';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSurface,
} from '@/modules/chat/composer/ComposerMenuPrimitives';

type BusySendMenuProps = {
  /** Why the message cannot go into the running turn, or null when it can. */
  insertUnavailableReason: InsertUnavailableReason | null;
  providerLabel: string;
  /** A queued message is waiting, so Queue adds to it. */
  hasQueuedDraft: boolean;
  sendByCtrlEnter?: boolean;
  /**
   * The turn has ended and only its background work runs: the first item
   * sends the message as a new turn, which the work does not stop, and Queue
   * waits for the work. Absent, the menu is for a running turn.
   */
  afterTurn?: boolean;
  onSelect: (mode: BusySubmitMode) => void;
};

/**
 * Rendered by chat's ChatComposer as the second half of the send button while
 * a turn runs: a menu offering to put the message into that turn (Insert) or
 * to queue it (Queue), with the keys for each. A queued message goes once the
 * session is idle: the turn has ended and no background work is left, as the
 * server's dispatcher waits for both. Insert is dimmed, saying why, when the
 * message cannot go in. After the turn, while only its background work runs
 * (`afterTurn`), it offers to send now or once the work finishes.
 */
export default function BusySendMenu({
  insertUnavailableReason,
  providerLabel,
  hasQueuedDraft,
  sendByCtrlEnter,
  afterTurn = false,
  onSelect,
}: BusySendMenuProps) {
  const { t } = useTranslation('chat');
  // The menu opens from the chevron and closes on a pick, a click outside or Escape.
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close, 20 * 16);

  const canInsert = afterTurn || insertUnavailableReason === null;
  const sendKey = sendByCtrlEnter ? 'Ctrl+Enter' : 'Enter';
  const alternateKey = sendByCtrlEnter ? 'Ctrl+Alt+Enter' : 'Alt+Enter';
  const heading = afterTurn
    ? t('input.backgroundSend.menuLabel', { defaultValue: 'Send while background work runs' })
    : t('input.insert.menuLabel', {
        provider: providerLabel,
        defaultValue: 'Send while {{provider}} is working',
      });
  const triggerLabel = t('input.insert.moreOptions', { defaultValue: 'More ways to send' });
  const insertUnavailableText = insertUnavailableReason === 'provider'
    ? t('input.insert.unsupported', {
        provider: providerLabel,
        defaultValue: '{{provider}} does not support insert, so it will be queued',
      })
    : insertUnavailableReason === 'slashCommand'
      ? t('input.insert.slashCommand', { defaultValue: 'A slash command cannot be inserted, so it will be queued' })
      : insertUnavailableReason === 'attachments'
        ? t('input.insert.attachments', {
            defaultValue: 'A message with attachments cannot be inserted yet, so it will be queued',
          })
        : t('input.insert.unavailable', { defaultValue: 'Insert is not available right now, so it will be queued' });

  const choose = (mode: BusySubmitMode) => {
    setIsOpen(false);
    onSelect(mode);
  };

  const keyHint = (keys: string) => (
    <kbd className="whitespace-nowrap rounded border border-border/60 px-1 font-sans text-[10px] leading-4 text-muted-foreground">
      {keys}
    </kbd>
  );

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        size="icon"
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={triggerLabel}
        title={triggerLabel}
        className="h-10 w-6 shrink-0 rounded-l-none rounded-r-lg border-l border-primary-foreground/25 [&_svg]:size-3.5"
      >
        <ChevronUpIcon />
      </Button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={heading}>
          <ComposerMenuHeading>{heading}</ComposerMenuHeading>
          <ComposerMenuItem
            role="menuitem"
            label={afterTurn
              ? t('input.backgroundSend.send', { defaultValue: 'Send' })
              : t('input.insert.insert', { defaultValue: 'Insert' })}
            description={afterTurn
              ? t('input.backgroundSend.sendDescription', {
                  defaultValue: 'Starts a new turn; the background work keeps running',
                })
              : canInsert
                ? t('input.insert.willRead', {
                    provider: providerLabel,
                    defaultValue: '{{provider}} reads it at its next step',
                  })
                : insertUnavailableText}
            title={canInsert ? undefined : insertUnavailableText}
            disabled={!canInsert}
            isSelected={false}
            trailing={canInsert ? keyHint(sendKey) : null}
            onSelect={() => choose('insert')}
          />
          <ComposerMenuItem
            role="menuitem"
            label={t('input.insert.queue', { defaultValue: 'Queue' })}
            description={hasQueuedDraft
              ? t('input.insert.queueAppend', { defaultValue: 'Add to the queued message' })
              : afterTurn
                ? t('input.backgroundSend.queueDescription', { defaultValue: 'Send when the background work finishes' })
                : t('input.insert.queueDescription', {
                    defaultValue: 'Send when this turn and any background work are done',
                  })}
            isSelected={false}
            trailing={keyHint(canInsert ? alternateKey : sendKey)}
            onSelect={() => choose('queue')}
          />
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}
