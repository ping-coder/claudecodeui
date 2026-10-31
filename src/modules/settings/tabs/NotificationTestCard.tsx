import { BellRing, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { useNotificationTest } from '@/modules/settings/hooks/useNotificationTest';
import type {
  LocalTestOutcome,
  PushTestOutcome,
  RequestNotificationPermission,
} from '@/modules/settings/hooks/useNotificationTest';
import { Button } from '@/shared/ui';

type NotificationTestCardProps = {
  /** Settings' permission request, so the switches above follow an answer given here. */
  onRequestNotificationPermission: RequestNotificationPermission;
  /**
   * The account's Web Push channel is off (turning push off on any device does that): a test push still reaches this
   * browser, finished tasks do not, and the outcome says so.
   */
  isAccountPushOff: boolean;
};

const describeLocalOutcome = (outcome: LocalTestOutcome, t: TFunction): string => {
  switch (outcome.kind) {
    case 'posted':
      return t('notifications.test.local.posted', { defaultValue: 'Posted a system notification from this page.' });
    case 'denied':
      return t('notifications.test.local.denied', {
        defaultValue: 'Notifications are blocked for this site, so nothing was posted.',
      });
    case 'dismissed':
      return t('notifications.test.local.dismissed', {
        defaultValue: 'Notifications were not allowed, so nothing was posted.',
      });
    case 'unsupported':
      return t('notifications.test.local.unsupported', {
        defaultValue: 'This browser cannot show system notifications here.',
      });
    case 'noServiceWorker':
      return t('notifications.test.local.noServiceWorker', {
        defaultValue: 'No service worker is running for this page. Reload the page and try again.',
      });
    default:
      return t('notifications.test.local.failed', {
        reason: outcome.reason,
        defaultValue: 'The browser refused the notification: {{reason}}',
      });
  }
};

const describePushOutcome = (outcome: PushTestOutcome, isAccountPushOff: boolean, t: TFunction): string => {
  switch (outcome.kind) {
    case 'notSubscribed':
      return t('notifications.test.push.notSubscribed', {
        defaultValue: 'Push is not on for this browser, so no push was sent.',
      });
    case 'notRegistered':
      return t('notifications.test.push.notRegistered', {
        defaultValue: "The server doesn't have this browser's push subscription and couldn't save it again. Turn push off and on again.",
      });
    case 'serverUnreachable':
      return t('notifications.test.push.serverUnreachable', {
        defaultValue: "Couldn't reach CloudCLI to send the test push.",
      });
    case 'serverError':
      return t('notifications.test.push.serverError', {
        status: outcome.status,
        defaultValue: "CloudCLI couldn't send the test push (HTTP {{status}}).",
      });
    case 'accepted':
      return [
        outcome.reregistered ? t('notifications.test.push.reregistered', {
          defaultValue: "The server couldn't push to this browser's subscription, so it was set up again.",
        }) : null,
        t('notifications.test.push.accepted', {
          status: outcome.statusCode ?? '?',
          defaultValue: 'The push service accepted the test push ({{status}}). It should arrive within seconds.',
        }),
        isAccountPushOff ? t('notifications.test.push.accountOff', {
          defaultValue: "Finished tasks won't be pushed here, though: push is off for your account, as happens when it is turned off on another device. Turn push off and on again above to switch it back on.",
        }) : null,
      ].filter(Boolean).join(' ');
    default:
      return [
        outcome.reregistered ? t('notifications.test.push.reregistered', {
          defaultValue: "The server couldn't push to this browser's subscription, so it was set up again.",
        }) : null,
        outcome.statusCode === null
          ? t('notifications.test.push.unreachable', {
            detail: outcome.detail,
            defaultValue: "Couldn't reach the push service: {{detail}}",
          })
          : t('notifications.test.push.rejected', {
            status: outcome.statusCode,
            detail: outcome.detail,
            defaultValue: 'The push service refused the test push ({{status}}): {{detail}}',
          }),
        outcome.dropped ? t('notifications.test.push.dropped', {
          defaultValue: 'That subscription no longer works and was removed. Turn push on again.',
        }) : null,
      ].filter(Boolean).join(' ');
  }
};

/**
 * The notifications tab's test card: "Send test notification" posts one system notification from this page and,
 * when push is on for this browser, has the server push one, then says what became of each; a push that arrived
 * while the account's push is off says finished tasks still will not. Under it, a collapsed "No banner?" lists what
 * hides a posted notification on macOS, on Windows and in the browser.
 */
export default function NotificationTestCard({ onRequestNotificationPermission, isAccountPushOff }: NotificationTestCardProps) {
  const { t } = useTranslation('settings');
  const { isTesting, result, sendTest } = useNotificationTest(onRequestNotificationPermission);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="space-y-1">
        <h4 className="font-medium text-foreground">
          {t('notifications.test.title', { defaultValue: 'Test notifications' })}
        </h4>
        <p className="text-sm text-muted-foreground">
          {t('notifications.test.description', {
            defaultValue: 'Sends one notification from this page and, if push is on for this browser, one through push, then says what became of each.',
          })}
        </p>
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isTesting}
        onClick={() => {
          // The click's first async step may be the permission prompt, which needs its user activation.
          void sendTest({
            title: t('notifications.test.notificationTitle', { defaultValue: 'CloudCLI test' }),
            localBody: t('notifications.test.localBody', {
              defaultValue: 'Sent by this page. If you see this, system notifications work.',
            }),
            pushBody: t('notifications.test.pushBody', {
              defaultValue: 'Sent through push. If you see this, push works.',
            }),
          });
        }}
      >
        {isTesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellRing className="h-4 w-4" />}
        {t('notifications.test.send', { defaultValue: 'Send test notification' })}
      </Button>

      {/* Always there, so screen readers announce each outcome as it comes in. */}
      <div aria-live="polite">
        {result && (
          <dl className="space-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="flex-shrink-0 font-medium text-foreground">
                {t('notifications.test.localLabel', { defaultValue: 'This page:' })}
              </dt>
              <dd className="text-muted-foreground">{describeLocalOutcome(result.local, t)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="flex-shrink-0 font-medium text-foreground">
                {t('notifications.test.pushLabel', { defaultValue: 'Push:' })}
              </dt>
              <dd className="text-muted-foreground">{describePushOutcome(result.push, isAccountPushOff, t)}</dd>
            </div>
          </dl>
        )}
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer font-medium text-foreground">
          {t('notifications.test.help.title', { defaultValue: 'No banner?' })}
        </summary>
        <div className="mt-2 space-y-2 text-muted-foreground">
          <p>
            {t('notifications.test.help.intro', {
              defaultValue: 'A notification can be posted and still show no banner. Check these:',
            })}
          </p>
          <p>
            {t('notifications.test.help.mac', {
              defaultValue: 'macOS: System Settings → Notifications → Google Chrome (or your browser): turn on Allow notifications and choose Banners or Alerts. Focus and Do Not Disturb hide banners too.',
            })}
          </p>
          <p>
            {t('notifications.test.help.windows', {
              defaultValue: 'Windows: Settings → System → Notifications: turn on Google Chrome (or your browser) and Show notification banners. Turn off Do not disturb (Focus assist on Windows 10).',
            })}
          </p>
          <p>
            {t('notifications.test.help.browser', {
              origin,
              defaultValue: 'Browser: notifications must be allowed for {{origin}} (the icon left of the address bar). Each address counts on its own: localhost and 127.0.0.1 are two sites.',
            })}
          </p>
        </div>
      </details>
    </div>
  );
}
