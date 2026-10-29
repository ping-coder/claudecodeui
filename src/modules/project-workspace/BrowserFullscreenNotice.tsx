import { memo } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { BrowserFullscreenIssue } from '@/shared/types';
import { isApplePlatform } from '@/shared/utils';

type BrowserFullscreenNoticeProps = {
  issue: BrowserFullscreenIssue;
  /** Asks for the browser fullscreen again; called straight from the click, so it keeps the user's gesture. */
  onRetry: () => void;
  onDismiss: () => void;
};

/**
 * Rendered by ProjectWorkspaceShell in desktop immersive mode when the browser refused its full
 * screen or kept it inside the window: says which, with a retry for a refusal and the window's own
 * full-screen shortcut otherwise (retrying cannot leave a fullscreen the document already holds).
 * It sits below the tab bars and under the sidebar drawer with its backdrop, the run banners and
 * dialogs. A status, not a dialog or an escape layer: it never takes focus, Escape or the shortcuts.
 */
function BrowserFullscreenNotice({ issue, onRetry, onDismiss }: BrowserFullscreenNoticeProps) {
  const { t } = useTranslation('common');
  const message = issue.reason === 'refused'
    ? t('workspace.fullscreenRefused', {
      detail: issue.detail,
      defaultValue: 'The browser refused full screen ({{detail}}); the workspace only fills the window.',
    })
    : t('workspace.fullscreenInWindow', {
      defaultValue: 'The browser kept full screen inside the window: this tab may be shared, cast or recorded by an extension, or an extension may be handling full screen.',
    });
  // macOS Chrome keeps its toolbar in a full-screen window unless that View menu item is off.
  const windowTip = issue.reason === 'inWindow'
    ? (isApplePlatform()
      ? t('workspace.fullscreenWindowTipApple', {
        defaultValue: 'Press ⌃⌘F for a full-screen window; to hide the toolbar, turn off View > Always Show Toolbar in Full Screen (⇧⌘F).',
      })
      : t('workspace.fullscreenWindowTip', { defaultValue: 'Press F11 for a full-screen window.' }))
    : null;

  return (
    <div
      role="status"
      className="fixed left-1/2 z-20 flex w-max max-w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 items-start gap-2 rounded-lg border border-border/60 bg-background/95 py-2 pe-1.5 ps-3 text-sm shadow-lg backdrop-blur-sm"
      // Just under the immersive tab bar (40px), clear of the safe area.
      style={{ top: 'calc(env(safe-area-inset-top, 0px) + 3rem)' }}
    >
      <div className="min-w-0 flex-1 py-1">
        <p className="text-foreground">{message}</p>
        {windowTip && <p className="mt-0.5 text-muted-foreground">{windowTip}</p>}
      </div>
      {issue.reason === 'refused' && (
        <button
          type="button"
          onClick={onRetry}
          className="flex-shrink-0 rounded-md px-2 py-1 font-medium text-primary transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          {t('buttons.retry', { defaultValue: 'Retry' })}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('buttons.close', { defaultValue: 'Close' })}
        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export default memo(BrowserFullscreenNotice);
