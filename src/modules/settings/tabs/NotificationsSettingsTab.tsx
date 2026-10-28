import { Bell, BellOff, BellRing, Loader2, PanelTop, Play, Volume2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetUiPreference, useUiPreferences } from '@/shared/context/UiPreferencesContext';
import { Button } from '@/shared/ui';
import { playChatCompletionSound } from '@/shared/utils';
import type { NotificationPreferencesState } from '@/shared/types';
import SettingsToggle from '@/modules/settings/SettingsToggle';

type NotificationsSettingsTabProps = {
  notificationPreferences: NotificationPreferencesState;
  onNotificationPreferencesChange: (value: NotificationPreferencesState) => void;
  pushPermission: NotificationPermission | 'unsupported';
  isPushSubscribed: boolean;
  isPushLoading: boolean;
  onEnablePush: () => void;
  onDisablePush: () => void;
  /** Asks the browser for notification permission; must be the first async step of the click that calls it. */
  onRequestNotificationPermission: () => Promise<NotificationPermission | 'unsupported'>;
  isDesktop?: boolean;
  desktopNotifications?: {
    enabled: boolean;
    supported: boolean;
    connectedCount?: number;
    targetCount?: number;
    lastError?: string | null;
  } | null;
  onEnableDesktopNotifications?: () => void;
  onDisableDesktopNotifications?: () => void;
};

type PageAlertRowProps = {
  icon: LucideIcon;
  label: string;
  description: string;
  toggle: ReactNode;
  /** Shown under the description: the sound preview, or what the permission state means for system notifications. */
  children?: ReactNode;
};

/** One row of the "While CloudCLI is open" card: a labelled, described switch with optional detail below. */
function PageAlertRow({ icon: Icon, label, description, toggle, children }: PageAlertRowProps) {
  return (
    <div className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-blue-600" />
          <span className="text-sm font-medium text-foreground">{label}</span>
        </div>
        <p className="text-sm text-muted-foreground">{description}</p>
        {children ? <div className="pt-2">{children}</div> : null}
      </div>
      <div className="flex-shrink-0">{toggle}</div>
    </div>
  );
}

/** Rendered by Settings for the "notifications" tab, covering the alerts shown while CloudCLI is open, notification channels and events. */
export default function NotificationsSettingsTab({
  notificationPreferences,
  onNotificationPreferencesChange,
  pushPermission,
  isPushSubscribed,
  isPushLoading,
  onEnablePush,
  onDisablePush,
  onRequestNotificationPermission,
  isDesktop = false,
  desktopNotifications = null,
  onEnableDesktopNotifications,
  onDisableDesktopNotifications,
}: NotificationsSettingsTabProps) {
  const { t } = useTranslation('settings');
  const preferences = useUiPreferences();
  const setPreference = useSetUiPreference();

  const pushSupported = pushPermission !== 'unsupported';
  const pushDenied = pushPermission === 'denied';
  // Page-sent system notifications need the permission; until it is granted the switch
  // reads off and cannot be flipped, whatever the stored preference says.
  const notificationsGranted = pushPermission === 'granted';

  const soundLabel = t('notifications.sound.title', { defaultValue: 'Sound' });
  const bannerLabel = t('notifications.page.banner.title', { defaultValue: 'Banner' });
  const systemNotificationLabel = t('notifications.page.system.title', { defaultValue: 'System notification' });

  let systemNotificationNote: string | null = null;
  if (pushPermission === 'denied') {
    systemNotificationNote = t('notifications.page.system.denied', {
      defaultValue: 'Notifications are blocked for this site. Allow them in the browser site settings.',
    });
  } else if (pushPermission === 'unsupported') {
    systemNotificationNote = t('notifications.page.system.unsupported', {
      defaultValue: 'Not available here. System notifications need HTTPS or localhost.',
    });
  } else if (notificationsGranted && isPushSubscribed) {
    // run-notifications leaves the system notification to the push this browser receives.
    systemNotificationNote = t('notifications.page.system.viaPush', {
      defaultValue: 'Push notifications are on for this browser, so they deliver these instead.',
    });
  }

  return (
    <div className="space-y-6 md:space-y-8">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Bell className="h-5 w-5 text-blue-600" />
          <h3 className="text-lg font-medium text-foreground">{t('notifications.title')}</h3>
        </div>
        <p className="text-sm text-muted-foreground">{t('notifications.description')}</p>
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-card p-4">
        <div className="space-y-1">
          <h4 className="font-medium text-foreground">
            {t('notifications.page.title', { defaultValue: 'While CloudCLI is open' })}
          </h4>
          <p className="text-sm text-muted-foreground">
            {t('notifications.page.description', {
              defaultValue: 'How this browser tells you a task has finished while a CloudCLI tab is open.',
            })}
          </p>
        </div>

        <div className="divide-y divide-border">
          <PageAlertRow
            icon={Volume2}
            label={soundLabel}
            description={t('notifications.sound.description', {
              defaultValue: 'Play a short tone when a task finishes or needs tool approval.',
            })}
            toggle={
              <SettingsToggle
                checked={notificationPreferences.channels.sound}
                onChange={(value) =>
                  onNotificationPreferencesChange({
                    ...notificationPreferences,
                    channels: {
                      ...notificationPreferences.channels,
                      sound: value,
                    },
                  })
                }
                ariaLabel={soundLabel}
              />
            }
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void playChatCompletionSound({ force: true });
              }}
            >
              <Play className="h-4 w-4" />
              {t('notifications.sound.test', { defaultValue: 'Test sound' })}
            </Button>
          </PageAlertRow>

          <PageAlertRow
            icon={PanelTop}
            label={bannerLabel}
            description={t('notifications.page.banner.description', {
              defaultValue: 'Show a banner when a task finishes, with a button to open its conversation.',
            })}
            toggle={
              <SettingsToggle
                checked={preferences.runAlertBanner}
                onChange={(value) => setPreference('runAlertBanner', value)}
                ariaLabel={bannerLabel}
              />
            }
          />

          {/* Hidden in the desktop app: run-notifications sends no page system notifications
              there, and its own native notifications have the card below. */}
          {!isDesktop && (
            <PageAlertRow
              icon={BellRing}
              label={systemNotificationLabel}
              description={t('notifications.page.system.description', {
                defaultValue: 'Show a system notification when a task finishes and no CloudCLI tab is in front.',
              })}
              toggle={
                <SettingsToggle
                  checked={preferences.runAlertSystemNotification && notificationsGranted}
                  onChange={(value) => setPreference('runAlertSystemNotification', value)}
                  ariaLabel={systemNotificationLabel}
                  disabled={!notificationsGranted}
                />
              }
            >
              {pushPermission === 'default' ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    // The click's first and only async step: browsers show the permission
                    // prompt only while the click's user activation is still live.
                    void onRequestNotificationPermission();
                  }}
                >
                  <Bell className="h-4 w-4" />
                  {t('notifications.page.system.allow', { defaultValue: 'Allow notifications' })}
                </Button>
              ) : systemNotificationNote ? (
                <p className="text-sm text-muted-foreground">{systemNotificationNote}</p>
              ) : null}
            </PageAlertRow>
          )}
        </div>
      </div>

      {isDesktop ? (
        <div className="space-y-4 rounded-lg border border-border bg-card p-4">
          <h4 className="font-medium text-foreground">
            {t('notifications.desktop.title', { defaultValue: 'Notify this desktop app' })}
          </h4>
          {desktopNotifications?.supported === false ? (
            <p className="text-sm text-muted-foreground">
              {t('notifications.desktop.unsupported', { defaultValue: 'Desktop notifications are not supported on this system.' })}
            </p>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    if (desktopNotifications?.enabled) {
                      onDisableDesktopNotifications?.();
                    } else {
                      onEnableDesktopNotifications?.();
                    }
                  }}
                  className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                    desktopNotifications?.enabled
                      ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50'
                      : 'bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600'
                  }`}
                >
                  {desktopNotifications?.enabled ? (
                    <BellOff className="h-4 w-4" />
                  ) : (
                    <BellRing className="h-4 w-4" />
                  )}
                  {desktopNotifications?.enabled
                    ? t('notifications.desktop.disable', { defaultValue: 'Disable desktop notifications' })
                    : t('notifications.desktop.enable', { defaultValue: 'Enable desktop notifications' })}
                </button>
                {desktopNotifications?.enabled && (
                  <span className="text-sm text-green-600 dark:text-green-400">
                    {t('notifications.desktop.enabled', { defaultValue: 'Desktop notifications are enabled' })}
                  </span>
                )}
              </div>
              {desktopNotifications?.lastError && (
                <p className="text-sm text-red-600 dark:text-red-400">{desktopNotifications.lastError}</p>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4 rounded-lg border border-border bg-card p-4">
          <div className="space-y-1">
            <h4 className="font-medium text-foreground">{t('notifications.webPush.title')}</h4>
            <p className="text-sm text-muted-foreground">
              {t('notifications.webPush.description', {
                defaultValue:
                  'Reaches this browser even when CloudCLI is closed. While a CloudCLI tab is in front, task notifications arrive without sound.',
              })}
            </p>
          </div>
          {!pushSupported ? (
            <p className="text-sm text-muted-foreground">{t('notifications.webPush.unsupported')}</p>
          ) : pushDenied ? (
            <p className="text-sm text-muted-foreground">{t('notifications.webPush.denied')}</p>
          ) : (
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={isPushLoading}
                onClick={() => {
                  if (isPushSubscribed) {
                    onDisablePush();
                  } else {
                    onEnablePush();
                  }
                }}
                className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  isPushSubscribed
                    ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50'
                    : 'bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600'
                }`}
              >
                {isPushLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : isPushSubscribed ? (
                  <BellOff className="h-4 w-4" />
                ) : (
                  <BellRing className="h-4 w-4" />
                )}
                {isPushLoading
                  ? t('notifications.webPush.loading')
                  : isPushSubscribed
                    ? t('notifications.webPush.disable')
                    : t('notifications.webPush.enable')}
              </button>
              {isPushSubscribed && (
                <span className="text-sm text-green-600 dark:text-green-400">
                  {t('notifications.webPush.enabled')}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      <div className="space-y-4 rounded-lg border border-border bg-card p-4">
        <h4 className="font-medium text-foreground">
          {t('notifications.events.title', { defaultValue: 'Push and desktop notification events' })}
        </h4>
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={notificationPreferences.events.actionRequired}
              onChange={(event) =>
                onNotificationPreferencesChange({
                  ...notificationPreferences,
                  events: {
                    ...notificationPreferences.events,
                    actionRequired: event.target.checked,
                  },
                })
              }
              className="h-4 w-4"
            />
            {t('notifications.events.actionRequired')}
          </label>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={notificationPreferences.events.stop}
              onChange={(event) =>
                onNotificationPreferencesChange({
                  ...notificationPreferences,
                  events: {
                    ...notificationPreferences.events,
                    stop: event.target.checked,
                  },
                })
              }
              className="h-4 w-4"
            />
            {t('notifications.events.stop')}
          </label>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={notificationPreferences.events.error}
              onChange={(event) =>
                onNotificationPreferencesChange({
                  ...notificationPreferences,
                  events: {
                    ...notificationPreferences.events,
                    error: event.target.checked,
                  },
                })
              }
              className="h-4 w-4"
            />
            {t('notifications.events.error')}
          </label>
        </div>
      </div>
    </div>
  );
}
