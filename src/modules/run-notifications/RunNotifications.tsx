import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { useRunAlertEffects } from '@/modules/run-notifications/hooks/useRunAlertEffects';
import { useRunAlertPresentation } from '@/modules/run-notifications/hooks/useRunAlertPresentation';
import { useRunEndedFeed } from '@/modules/run-notifications/hooks/useRunEndedFeed';
import RunAlertBanners from '@/modules/run-notifications/RunAlertBanners';
import {
  mergeSystemNotificationCta,
  readDesktopNotificationsBridge,
  readSystemNotificationCta,
  subscribeToSystemNotificationCta,
  writeSystemNotificationCta,
} from '@/modules/run-notifications/utils/runAlertCoordination';
import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import type { ResolveRunSessionLabel, RunAlert, RunAlertBannerPlacement } from '@/shared/types';

type RunNotificationsProps = {
  resolveSessionLabel: ResolveRunSessionLabel;
  /** Sessions in the Chat view of a pane this tab shows (split side by side: both panes; otherwise the focused one). */
  onScreenSessionIds: ReadonlySet<string>;
  /** Banner "Open": opens the session kept, on Chat, in the focused pane. */
  onOpenSession: (sessionId: string) => void;
  placement: RunAlertBannerPlacement;
};

/** The system-notification prompt appears on at most this many banners, ever. */
const SYSTEM_CTA_MAX_SHOWN = 3;

/** How many banner cards show at once: three on desktop, one on a phone. */
const MAX_VISIBLE_BANNERS: Record<RunAlertBannerPlacement, number> = { desktop: 3, phone: 1, phoneImmersive: 1 };

/**
 * Whether this browser could show the page's system notifications once the user allows them: not the desktop app
 * (it has native notifications), a secure context with the Notification API, permission not asked yet, the user's
 * switch on, and no push subscription (push already delivers them).
 */
const canOfferSystemNotifications = (systemNotificationsEnabled: boolean, isBrowserPushSubscribed: boolean | null): boolean =>
  readDesktopNotificationsBridge() === null
  && window.isSecureContext === true
  && 'Notification' in window
  && Notification.permission === 'default'
  && systemNotificationsEnabled
  && isBrowserPushSubscribed === false;

/**
 * The finished-run alerts of this tab: it turns the server's run ends into a title alert and banners, and in the
 * one tab of the browser that claims each alert, a chime and a system notification. The banners follow the user's
 * banner switch, the system notification their system-notification switch. The module's only export, rendered
 * once by project-workspace's ProjectRunNotifications, which supplies the session labels, the sessions on screen,
 * opening a session and where the banners sit.
 */
function RunNotifications({ resolveSessionLabel, onScreenSessionIds, onOpenSession, placement }: RunNotificationsProps) {
  const { runAlertBanner, runAlertSystemNotification } = useUiPreferences();
  const {
    present,
    banners,
    dismissBanner,
    openBanner,
    dismissAllBanners,
    setBannersHovered,
  } = useRunAlertPresentation({ bannersEnabled: runAlertBanner, onScreenSessionIds });
  const { announce, isBrowserPushSubscribed } = useRunAlertEffects({ systemNotificationsEnabled: runAlertSystemNotification });

  const handleAlert = useCallback((alert: RunAlert) => {
    present(alert);
    announce(alert);
  }, [announce, present]);
  useRunEndedFeed({ resolveSessionLabel, onAlert: handleAlert });

  // The system-notification prompt's record, kept in localStorage: how many banners it has appeared on, and
  // whether the user used or dismissed it. It decides whether the top banner offers the prompt.
  const [systemCta, setSystemCta] = useState(readSystemNotificationCta);
  // The banners the prompt has appeared on this page load: each counts once toward SYSTEM_CTA_MAX_SHOWN, and keeps
  // the prompt while it stays on top, also once the count has reached the limit.
  const [systemCtaBannerKeys, setSystemCtaBannerKeys] = useState<readonly string[]>([]);

  const topBannerKey = banners[0]?.key ?? null;
  const isSystemCtaOffered = topBannerKey !== null
    && !systemCta.done
    && canOfferSystemNotifications(runAlertSystemNotification, isBrowserPushSubscribed);
  const isTopBannerCounted = topBannerKey !== null && systemCtaBannerKeys.includes(topBannerKey);
  const showSystemNotificationCta = isSystemCtaOffered && (isTopBannerCounted || systemCta.shown < SYSTEM_CTA_MAX_SHOWN);

  // A new banner carrying the prompt counts one more appearance (state adjusted during render, so the count is
  // in place in the same commit as the banner); the effect below saves it.
  if (showSystemNotificationCta && !isTopBannerCounted && topBannerKey !== null) {
    setSystemCta({ shown: systemCta.shown + 1, done: systemCta.done });
    setSystemCtaBannerKeys([...systemCtaBannerKeys, topBannerKey]);
  }

  // Saves the record for later page loads and the other tabs whenever it changes; the one read on mount needs no
  // writing back.
  const savedSystemCtaRef = useRef(systemCta);
  useEffect(() => {
    if (savedSystemCtaRef.current !== systemCta) {
      savedSystemCtaRef.current = systemCta;
      writeSystemNotificationCta(systemCta);
    }
  }, [systemCta]);

  // Another tab's count or answer: this tab neither offers the prompt past the limit nor after the user answered it there.
  useEffect(() => subscribeToSystemNotificationCta((stored) => {
    setSystemCta((current) => mergeSystemNotificationCta(current, stored));
  }), []);

  const finishSystemCta = useCallback(() => {
    setSystemCta((record) => (record.done ? record : { shown: record.shown, done: true }));
  }, []);

  const handleEnableSystemNotifications = useCallback(() => {
    finishSystemCta();
    // The first asynchronous call of the click handler: Safari asks for the permission only from a user gesture.
    void Notification.requestPermission();
  }, [finishSystemCta]);

  const handleDismiss = useCallback((alertKey: string) => {
    // Closing the card that carries the prompt declines it for good.
    if (showSystemNotificationCta && alertKey === topBannerKey) {
      finishSystemCta();
    }
    dismissBanner(alertKey);
  }, [dismissBanner, finishSystemCta, showSystemNotificationCta, topBannerKey]);

  const handleOpen = useCallback((alert: RunAlert) => {
    openBanner(alert.key);
    onOpenSession(alert.sessionId);
  }, [onOpenSession, openBanner]);

  return (
    <RunAlertBanners
      banners={banners}
      maxVisible={MAX_VISIBLE_BANNERS[placement]}
      placement={placement}
      showSystemNotificationCta={showSystemNotificationCta}
      onOpen={handleOpen}
      onDismiss={handleDismiss}
      onDismissAll={dismissAllBanners}
      onEnableSystemNotifications={handleEnableSystemNotifications}
      onHoverChange={setBannersHovered}
    />
  );
}

export default memo(RunNotifications);
