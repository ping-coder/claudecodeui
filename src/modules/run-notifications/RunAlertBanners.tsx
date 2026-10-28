import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, FocusEvent, PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, CircleCheck, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { describeRunAlertOutcome } from '@/modules/run-notifications/utils/runAlertCoordination';
import type { RunAlert, RunAlertBannerPlacement, RunAlertOutcome } from '@/shared/types';
import { Button, LLMProviderLogo } from '@/shared/ui';
import { cn } from '@/shared/utils';

type RunAlertBannersProps = {
  /** Newest first. */
  banners: RunAlert[];
  /** How many cards show; the rest fold into a "N more · Dismiss all" line. */
  maxVisible: number;
  placement: RunAlertBannerPlacement;
  /** Puts the "Turn on system notifications" prompt at the bottom of the top card. */
  showSystemNotificationCta: boolean;
  onOpen: (alert: RunAlert) => void;
  onDismiss: (alertKey: string) => void;
  onDismissAll: () => void;
  onEnableSystemNotifications: () => void;
  /** Whether the pointer or the focus is on a card, so the cards' visible time can stop counting meanwhile. */
  onHoverChange: (hovered: boolean) => void;
};

type RunAlertBannerCardProps = {
  alert: RunAlert;
  showSystemNotificationCta: boolean;
  onOpen: (alert: RunAlert) => void;
  onDismiss: (alertKey: string) => void;
  onEnableSystemNotifications: () => void;
  onPointerInsideChange: (alertKey: string, isInside: boolean) => void;
};

/** A click on a card this soon after it appeared (a tap meant for whatever was there a moment ago) is ignored. */
const CARD_CLICK_GUARD_MS = 400;

/** How far a card must be swiped sideways to dismiss it. */
const CARD_SWIPE_DISMISS_PX = 64;

/** How many announced alert keys the live region remembers, so an older banner coming back to the top is not read out again. */
const ANNOUNCED_KEY_LIMIT = 50;

/**
 * Where the stack sits: below the pane tab bar and view switcher on desktop, below the two-row header on phones,
 * below the exit capsule in phone immersive mode. Kept at the top, out of the soft keyboard's way.
 */
const PLACEMENT_TOPS: Record<RunAlertBannerPlacement, string> = {
  desktop: 'calc(env(safe-area-inset-top, 0px) + 6rem)',
  phone: 'calc(env(safe-area-inset-top, 0px) + 6rem)',
  phoneImmersive: 'calc(env(safe-area-inset-top, 0px) + 3.5rem)',
};

/** The status icon of an outcome: green done, blue replied, purple background work (the purple of the background dot), red failed. */
function RunAlertOutcomeIcon({ outcome }: { outcome: RunAlertOutcome }) {
  if (outcome === 'failed') {
    return <CircleAlert aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-red-500 dark:text-red-400" />;
  }
  const colour = outcome === 'replied'
    ? 'text-blue-500 dark:text-blue-400'
    : outcome === 'backgroundDone'
      ? 'text-purple-500 dark:text-purple-400'
      : 'text-green-500 dark:text-green-400';
  return <CircleCheck aria-hidden="true" className={cn('h-3.5 w-3.5 shrink-0', colour)} />;
}

/** One card: who it is about, how it ended, "Open" and close. The card body itself does nothing when clicked. */
function RunAlertBannerCard({
  alert,
  showSystemNotificationCta,
  onOpen,
  onDismiss,
  onEnableSystemNotifications,
  onPointerInsideChange,
}: RunAlertBannerCardProps) {
  const { t } = useTranslation('common');

  // Armed CARD_CLICK_GUARD_MS after the card appeared; until then its buttons ignore clicks.
  const isArmedRef = useRef(false);
  useEffect(() => {
    const armTimer = window.setTimeout(() => {
      isArmedRef.current = true;
    }, CARD_CLICK_GUARD_MS);
    return () => window.clearTimeout(armTimer);
  }, []);

  // How far the card is being swiped sideways, in px: it follows the finger, and past CARD_SWIPE_DISMISS_PX lets go dismissed.
  const [swipeOffset, setSwipeOffset] = useState(0);
  const swipeStartRef = useRef<{ pointerId: number; x: number } | null>(null);

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    // The buttons click; only the card body swipes.
    if ((event.target as Element).closest('button')) {
      return;
    }
    swipeStartRef.current = { pointerId: event.pointerId, x: event.clientX };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const start = swipeStartRef.current;
    if (start && start.pointerId === event.pointerId) {
      setSwipeOffset(event.clientX - start.x);
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const start = swipeStartRef.current;
    if (!start || start.pointerId !== event.pointerId) {
      return;
    }
    swipeStartRef.current = null;
    setSwipeOffset(0);
    if (Math.abs(event.clientX - start.x) >= CARD_SWIPE_DISMISS_PX) {
      onDismiss(alert.key);
    }
  };

  const handlePointerCancel = () => {
    swipeStartRef.current = null;
    setSwipeOffset(0);
  };

  const whenArmed = (action: () => void) => () => {
    if (isArmedRef.current) {
      action();
    }
  };

  const outcomeText = describeRunAlertOutcome(alert.outcome, t);
  const swipeStyle: CSSProperties | undefined = swipeOffset
    ? { transform: `translateX(${swipeOffset}px)`, opacity: Math.max(0.3, 1 - Math.abs(swipeOffset) / 240) }
    : undefined;

  return (
    <article
      aria-label={alert.title}
      className="pointer-events-auto animate-dialog-overlay-show touch-pan-y select-none overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
      style={swipeStyle}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onMouseEnter={() => onPointerInsideChange(alert.key, true)}
      onMouseLeave={() => onPointerInsideChange(alert.key, false)}
    >
      <div className="flex items-center gap-3 py-2 pl-3 pr-1.5">
        <LLMProviderLogo provider={alert.provider} className="h-5 w-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{alert.title}</p>
          <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <RunAlertOutcomeIcon outcome={alert.outcome} />
            <span className="truncate">
              {alert.projectName ? `${outcomeText} · ${alert.projectName}` : outcomeText}
            </span>
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 shrink-0 px-2.5"
          aria-label={t('runNotifications.banner.openLabel', { title: alert.title, defaultValue: 'Open {{title}}' })}
          onClick={whenArmed(() => onOpen(alert))}
        >
          {t('runNotifications.banner.open', { defaultValue: 'Open' })}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label={t('runNotifications.banner.dismiss', { defaultValue: 'Dismiss' })}
          onClick={whenArmed(() => onDismiss(alert.key))}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      {showSystemNotificationCta && (
        <div className="border-t border-border px-3 py-1.5">
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-7 px-0 text-xs"
            onClick={whenArmed(onEnableSystemNotifications)}
          >
            {t('runNotifications.banner.enableSystem', { defaultValue: 'Turn on system notifications' })}
          </Button>
        </div>
      )}
    </article>
  );
}

/**
 * Rendered by RunNotifications to draw the finished-run banners, portaled into body: fixed at z-40, above the
 * whole workspace shell and below every dialog (z-50 and up); the stack lets clicks through between its cards. A
 * persistent polite live region reads each new banner out. It uses no dialog, alert or menu role, no aria-modal
 * and no data-escape-layer, and never takes the focus, so Escape keeps stopping runs and closing Settings, and the
 * workspace shortcuts keep working.
 */
function RunAlertBanners({
  banners,
  maxVisible,
  placement,
  showSystemNotificationCta,
  onOpen,
  onDismiss,
  onDismissAll,
  onEnableSystemNotifications,
  onHoverChange,
}: RunAlertBannersProps) {
  const { t } = useTranslation('common');
  const visibleBanners = banners.slice(0, maxVisible);
  const hiddenCount = banners.length - visibleBanners.length;
  const visibleKeysSignature = visibleBanners.map((banner) => banner.key).join('\u0000');

  // The live region's text: the announcement of the newest banner not read out yet, with the keys already read,
  // so a banner that comes back to the top (the newer one dismissed, the page shown again) is not read twice.
  const [announcement, setAnnouncement] = useState<{ text: string; keys: readonly string[] }>({ text: '', keys: [] });
  const newestBanner = banners[0];
  if (newestBanner && !announcement.keys.includes(newestBanner.key)) {
    // Adjusted during render, so the text is in place in the same commit as the card.
    setAnnouncement({
      text: t('runNotifications.banner.announce', {
        outcome: describeRunAlertOutcome(newestBanner.outcome, t),
        title: newestBanner.title,
        defaultValue: '{{outcome}}: {{title}}',
      }),
      keys: [...announcement.keys, newestBanner.key].slice(-ANNOUNCED_KEY_LIMIT),
    });
  }

  const sectionRef = useRef<HTMLElement>(null);
  // The cards under the pointer, and whether the focus is inside the stack: either one pauses the visible time.
  const hoveredCardKeysRef = useRef(new Set<string>());
  const hasFocusInsideRef = useRef(false);
  const reportHover = useCallback(() => {
    onHoverChange(hoveredCardKeysRef.current.size > 0 || hasFocusInsideRef.current);
  }, [onHoverChange]);

  const handlePointerInsideChange = useCallback((alertKey: string, isInside: boolean) => {
    if (isInside) {
      hoveredCardKeysRef.current.add(alertKey);
    } else {
      hoveredCardKeysRef.current.delete(alertKey);
    }
    reportHover();
  }, [reportHover]);

  const handleFocus = () => {
    hasFocusInsideRef.current = true;
    reportHover();
  };

  const handleBlur = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      hasFocusInsideRef.current = false;
      reportHover();
    }
  };

  // Whatever goes while hovered or focused fires no mouseleave or blur on its way out: a card dismissed or expired,
  // but also a focused button while every card stays, like the system-notification prompt once used, or "Dismiss
  // all" once the banners folded into its line are seen in another tab. Those change no card key, so the check runs
  // after every commit, not on a dependency: it is cheap, and the memoized stack seldom renders.
  useEffect(() => {
    const shownKeys = new Set(visibleKeysSignature ? visibleKeysSignature.split('\u0000') : []);
    let changed = false;
    for (const alertKey of hoveredCardKeysRef.current) {
      if (!shownKeys.has(alertKey)) {
        hoveredCardKeysRef.current.delete(alertKey);
        changed = true;
      }
    }
    if (hasFocusInsideRef.current && !sectionRef.current?.contains(document.activeElement)) {
      hasFocusInsideRef.current = false;
      changed = true;
    }
    if (changed) {
      reportHover();
    }
  });

  return createPortal(
    <section
      ref={sectionRef}
      aria-label={t('runNotifications.banner.region', { defaultValue: 'Task notifications' })}
      className={cn(
        'pointer-events-none fixed z-40 flex flex-col gap-2',
        placement === 'desktop' ? 'right-4 w-[22rem]' : 'inset-x-3',
      )}
      style={{ top: PLACEMENT_TOPS[placement] }}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      <div role="status" aria-live="polite" className="sr-only">
        {announcement.text}
      </div>
      {visibleBanners.map((banner, index) => (
        <RunAlertBannerCard
          key={banner.key}
          alert={banner}
          showSystemNotificationCta={showSystemNotificationCta && index === 0}
          onOpen={onOpen}
          onDismiss={onDismiss}
          onEnableSystemNotifications={onEnableSystemNotifications}
          onPointerInsideChange={handlePointerInsideChange}
        />
      ))}
      {hiddenCount > 0 && (
        <div className="pointer-events-auto flex items-center justify-end gap-1.5 self-end rounded-md border border-border bg-popover px-2.5 py-1 text-xs text-muted-foreground shadow-sm">
          <span>{t('runNotifications.banner.more', { count: hiddenCount, defaultValue: '{{count}} more' })}</span>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            className="font-medium text-foreground hover:underline"
            onClick={onDismissAll}
          >
            {t('runNotifications.banner.dismissAll', { defaultValue: 'Dismiss all' })}
          </button>
        </div>
      )}
    </section>,
    document.body,
  );
}

export default memo(RunAlertBanners);
