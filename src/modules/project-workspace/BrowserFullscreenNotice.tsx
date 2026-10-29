import { memo } from 'react';
import { createPortal } from 'react-dom';
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
 * Rendered by ProjectWorkspaceShell on desktop when a maximize came without the whole screen: the
 * browser refused (with a retry), kept the full screen inside the tab or the window is smaller than
 * the screen (with what to do instead; retrying cannot leave a fullscreen the document already
 * holds), or no request could be made (an embedding page, a browser without the API). A status, not
 * a dialog or an escape layer: it never takes focus, Escape or the shortcuts.
 * Portaled to <body> at z-[39]: above the whole workspace shell (a maximized editor at z-[9999], the
 * docked editor's CodeMirror panels at 300, the immersive sidebar drawer), under the run banners
 * (z-40) and every dialog and menu (z-50 and up). The browser fullscreen is the root element's, so
 * <body> is on screen with it. The keys keep their workspace.* names from when only immersive mode
 * used the notice.
 */
function BrowserFullscreenNotice({ issue, onRetry, onDismiss }: BrowserFullscreenNoticeProps) {
  const { t } = useTranslation('common');

  let message: string;
  let tip: string | null = null;
  switch (issue.reason) {
    case 'refused':
      message = t('workspace.fullscreenRefused', {
        detail: issue.detail,
        defaultValue: 'The browser refused full screen ({{detail}}), so this only fills the window.',
      });
      break;
    case 'inWindow':
      if (issue.kind === 'tab') {
        message = t('workspace.fullscreenInWindow', {
          defaultValue: 'The browser kept full screen inside the window: this tab may be shared, cast or recorded by an extension, or an extension may be handling full screen.',
        });
        // macOS Chrome keeps its toolbar in a full-screen window unless that View menu item is off.
        tip = isApplePlatform()
          ? t('workspace.fullscreenWindowTipApple', {
            defaultValue: 'Press ⌃⌘F for a full-screen window; to hide the toolbar, turn off View > Always Show Toolbar in Full Screen (⇧⌘F).',
          })
          : t('workspace.fullscreenWindowTip', { defaultValue: 'Press F11 for a full-screen window.' });
      } else {
        message = t('workspace.fullscreenPartial', {
          width: issue.window.width,
          height: issue.window.height,
          screenWidth: issue.screen.width,
          screenHeight: issue.screen.height,
          defaultValue: 'Full screen covers only part of the screen (window {{width}}×{{height}}, screen {{screenWidth}}×{{screenHeight}}): the window may be in Split View or tiled.',
        });
        tip = t('workspace.fullscreenPartialTip', {
          defaultValue: 'Take the window out of Split View or the tile, then choose full screen again.',
        });
      }
      break;
    case 'unavailable':
      message = issue.cause === 'iframe'
        ? t('workspace.fullscreenIframe', {
          defaultValue: 'This page is embedded in a page that does not allow full screen; open CloudCLI in its own tab for the whole screen.',
        })
        : t('workspace.fullscreenNoApi', { defaultValue: 'This browser has no full screen for web pages, so this only fills the window.' });
      break;
  }

  return createPortal(
    <div
      role="status"
      className="fixed left-1/2 z-[39] flex w-max max-w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 items-start gap-2 rounded-lg border border-border/60 bg-background/95 py-2 pe-1.5 ps-3 text-sm shadow-lg backdrop-blur-sm"
      // Just under the immersive tab bar (40px) or a maximized editor's header, clear of the safe area.
      style={{ top: 'calc(env(safe-area-inset-top, 0px) + 3rem)' }}
    >
      <div className="min-w-0 flex-1 py-1">
        <p className="text-foreground">{message}</p>
        {tip && <p className="mt-0.5 text-muted-foreground">{tip}</p>}
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
    </div>,
    document.body,
  );
}

export default memo(BrowserFullscreenNotice);
