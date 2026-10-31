import { useCallback, useState } from 'react';

import { api } from '@/shared/api';
import {
  checkPushRegistration,
  readNotificationPermission,
  readServiceWorkerRegistration,
  repairPushRegistration,
  reportNotificationDelivery,
} from '@/shared/systemNotifications';
import type { PushRegistrationStatus, TestPushDelivery } from '@/shared/types';

/** What came of the page's own test notification, posted through the service worker registration. */
export type LocalTestOutcome =
  | { kind: 'posted' }
  | { kind: 'denied' }
  | { kind: 'dismissed' }
  | { kind: 'unsupported' }
  | { kind: 'noServiceWorker' }
  | { kind: 'failed'; reason: string };

/**
 * What came of the test push, sent only when this browser holds a push subscription. 'notRegistered': the server
 * could not push to the subscription and setting it up again failed. 'accepted' / 'rejected': the push service's
 * answer, the subscription set up again first when `reregistered`.
 */
export type PushTestOutcome =
  | { kind: 'notSubscribed' }
  | { kind: 'notRegistered' }
  | { kind: 'serverUnreachable' }
  | { kind: 'serverError'; status: number }
  | { kind: 'accepted'; statusCode: number | null; reregistered: boolean }
  | { kind: 'rejected'; statusCode: number | null; detail: string; dropped: boolean; reregistered: boolean };

export type NotificationTestResult = {
  local: LocalTestOutcome;
  push: PushTestOutcome;
};

/** The test notifications' words, in the interface language. */
export type NotificationTestTexts = {
  title: string;
  localBody: string;
  pushBody: string;
};

/** Asks for the notification permission and resolves to the answer: Settings' own, so its switches follow it. */
export type RequestNotificationPermission = () => Promise<NotificationPermission | 'unsupported'>;

type NotificationTestState = {
  isTesting: boolean;
  /** The outcome of the last test; null before the first. */
  result: NotificationTestResult | null;
  /** Posts the page's test notification and asks the server for a test push; must run as the click's first step. */
  sendTest: (texts: NotificationTestTexts) => Promise<void>;
};

/** Its own tag, so a test never replaces a finished task's notification; renotify pops it again on every click. */
const LOCAL_TEST_TAG = 'cloudcli:test:local';

const describeError = (error: unknown): string => (
  error instanceof Error ? error.message || error.name : String(error)
).slice(0, 160);

/** Posts the page's test notification, asking for the permission first when it has not been asked yet. */
const postLocalTest = async (
  { title, localBody }: NotificationTestTexts,
  requestPermission: RequestNotificationPermission,
): Promise<LocalTestOutcome> => {
  let permission = readNotificationPermission();
  if (permission === 'default') {
    // The click's first async step: browsers show the prompt only while its user activation is live.
    permission = await requestPermission();
  }
  if (permission === 'unsupported') {
    return { kind: 'unsupported' };
  }
  if (permission === 'denied') {
    return { kind: 'denied' };
  }
  if (permission !== 'granted') {
    return { kind: 'dismissed' };
  }

  const registration = await readServiceWorkerRegistration();
  if (!registration) {
    return { kind: 'noServiceWorker' };
  }
  try {
    // `renotify` is missing from TypeScript's NotificationOptions, though browsers read it.
    const options: NotificationOptions & { renotify: boolean } = {
      body: localBody,
      tag: LOCAL_TEST_TAG,
      renotify: true,
      icon: '/logo-256.png',
      badge: '/logo-128.png',
      data: {},
    };
    await registration.showNotification(title, options);
    return { kind: 'posted' };
  } catch (error) {
    return { kind: 'failed', reason: describeError(error) };
  }
};

/**
 * Asks the server to push a test to this browser's endpoint alone. A subscription the server lacks, or one made with
 * an old key, is put right first: the user asked for a push to this browser, whatever the account's channel says.
 */
const sendPushTest = async ({ title, pushBody }: NotificationTestTexts): Promise<{ push: PushTestOutcome; status: PushRegistrationStatus }> => {
  let check = await checkPushRegistration();
  if (check.status === 'unsupported' || check.status === 'none') {
    return { push: { kind: 'notSubscribed' }, status: check.status };
  }
  if (check.status === 'unchecked') {
    return { push: { kind: 'serverUnreachable' }, status: check.status };
  }

  const reregistered = check.status !== 'registered';
  if (reregistered) {
    check = await repairPushRegistration();
  }
  if (check.status !== 'registered' || !check.endpoint) {
    return { push: { kind: 'notRegistered' }, status: check.status };
  }

  try {
    const response = await api.settings.push.test({ endpoint: check.endpoint, title, body: pushBody });
    if (response.status === 404) {
      return { push: { kind: 'notRegistered' }, status: 'unknown' };
    }
    const { delivery } = response.ok ? ((await response.json()) as { delivery?: TestPushDelivery }) : {};
    if (!delivery) {
      return { push: { kind: 'serverError', status: response.status }, status: check.status };
    }
    return {
      push: delivery.accepted
        ? { kind: 'accepted', statusCode: delivery.statusCode, reregistered }
        : {
          kind: 'rejected',
          statusCode: delivery.statusCode,
          detail: delivery.detail ?? '',
          dropped: delivery.dropped === true,
          reregistered,
        },
      status: check.status,
    };
  } catch {
    return { push: { kind: 'serverUnreachable' }, status: check.status };
  }
};

/**
 * The notifications tab's "Send test notification": the page posts a system notification through the service worker
 * at once and, when this browser holds a push subscription, asks the server to push one to this browser alone, then
 * says what became of each. The permission, when not asked yet, is asked through `requestPermission`. The page's
 * half is reported to the server log like a finished task's.
 */
export function useNotificationTest(requestPermission: RequestNotificationPermission): NotificationTestState {
  const [isTesting, setIsTesting] = useState(false);
  const [result, setResult] = useState<NotificationTestResult | null>(null);

  const sendTest = useCallback(async (texts: NotificationTestTexts) => {
    setIsTesting(true);
    try {
      const local = await postLocalTest(texts, requestPermission);
      const { push, status } = await sendPushTest(texts);
      reportNotificationDelivery({ outcome: local.kind === 'posted' ? 'posted' : 'skipped', reason: 'test', push: status });
      setResult({ local, push });
    } finally {
      setIsTesting(false);
    }
  }, [requestPermission]);

  return { isTesting, result, sendTest };
}
