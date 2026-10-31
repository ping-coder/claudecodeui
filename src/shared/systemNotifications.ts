import { api } from '@/shared/api';
import type { NotificationDeliveryReport, PushRegistrationStatus } from '@/shared/types';

/**
 * This browser's system notifications, as run-notifications and Settings both need them: whether the server can
 * push to this browser, putting that right, and one line of the server log for each decision a page makes about
 * a notification. A browser can hold a push subscription the server cannot use: one the server dropped (the push
 * service called it gone), never got (saving it failed), got on another server, or one made with an older VAPID
 * key. Trusting such a subscription to deliver left a finished task with no notification at all.
 */

/** Web Locks name a repair runs under, so two tabs never replace the one subscription at once. */
const PUSH_REPAIR_LOCK_NAME = 'cloudcli:push-registration';

/** The longest platform name a report carries. */
const PLATFORM_MAX_LENGTH = 40;

export type PushRegistrationCheck = {
  status: PushRegistrationStatus;
  /** This browser's push endpoint; null without a subscription, or when it could not be read. */
  endpoint: string | null;
};

type HeldSubscription = {
  registration: ServiceWorkerRegistration;
  subscription: PushSubscription | null;
};

type PlatformNavigator = Navigator & { userAgentData?: { platform?: string } };

/** The base64url VAPID public key the server hands out, as the bytes pushManager.subscribe() takes. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/** The Notification permission, 'unsupported' where the API is missing (plain http, some webviews). */
export const readNotificationPermission = (): NotificationPermission | 'unsupported' => (
  typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported'
);

/**
 * This origin's service worker registration; null without one. It never waits on `serviceWorker.ready`, which
 * stays pending while no worker is active.
 */
export const readServiceWorkerRegistration = async (): Promise<ServiceWorkerRegistration | null> => {
  try {
    return (await navigator.serviceWorker?.getRegistration()) ?? null;
  } catch {
    return null;
  }
};

/** The registration and the subscription it holds; null without a registration or without push (Safari before 16). */
const readHeldSubscription = async (): Promise<HeldSubscription | null> => {
  const registration = await readServiceWorkerRegistration();
  if (!registration?.pushManager) {
    return null;
  }
  try {
    return { registration, subscription: await registration.pushManager.getSubscription() };
  } catch {
    return null;
  }
};

const isSameKey = (key: ArrayBuffer, expected: Uint8Array): boolean => {
  const bytes = new Uint8Array(key);
  return bytes.length === expected.length && bytes.every((byte, index) => byte === expected[index]);
};

/**
 * Whether the subscription was made with `publicKey`. A browser that does not say which key it used (no
 * `options`) gets the benefit of the doubt; one made without a key at all (an old GCM sender id) did not use it.
 */
export const isPushSubscriptionMadeWithKey = (subscription: PushSubscription, publicKey: string): boolean => {
  if (!subscription.options) {
    return true;
  }
  const key = subscription.options.applicationServerKey;
  return key !== null && isSameKey(key, urlBase64ToUint8Array(publicKey));
};

/** Asks the server for its VAPID key and whether it holds the subscription; 'unchecked' with no key when it cannot say. */
const askServer = async (subscription: PushSubscription): Promise<{ status: PushRegistrationStatus; publicKey: string | null }> => {
  try {
    const [keyResponse, statusResponse] = await Promise.all([
      api.settings.push.vapidPublicKey(),
      api.settings.push.status(subscription.endpoint),
    ]);
    if (!keyResponse.ok || !statusResponse.ok) {
      return { status: 'unchecked', publicKey: null };
    }
    const { publicKey } = (await keyResponse.json()) as { publicKey?: unknown };
    const { registered } = (await statusResponse.json()) as { registered?: unknown };
    if (typeof publicKey !== 'string' || !publicKey || typeof registered !== 'boolean') {
      return { status: 'unchecked', publicKey: null };
    }
    if (!isPushSubscriptionMadeWithKey(subscription, publicKey)) {
      return { status: 'staleKey', publicKey };
    }
    return { status: registered ? 'registered' : 'unknown', publicKey };
  } catch {
    return { status: 'unchecked', publicKey: null };
  }
};

/**
 * Whether the server can push to this browser (see PushRegistrationStatus). 'unsupported' and 'none' are read
 * locally, at once; anything else asks the server, unless `reuse` already knows the answer for this endpoint.
 */
export const checkPushRegistration = async (
  reuse?: (endpoint: string) => PushRegistrationStatus | null,
): Promise<PushRegistrationCheck> => {
  const held = await readHeldSubscription();
  if (!held) {
    return { status: 'unsupported', endpoint: null };
  }
  if (!held.subscription) {
    return { status: 'none', endpoint: null };
  }

  const { endpoint } = held.subscription;
  const known = reuse?.(endpoint) ?? null;
  if (known) {
    return { status: known, endpoint };
  }
  return { status: (await askServer(held.subscription)).status, endpoint };
};

/** Saves the subscription on the server without the preference change and "enabled" push that subscribing makes. */
const resyncSubscription = async (subscription: PushSubscription, previousEndpoint?: string): Promise<boolean> => {
  const { endpoint, keys } = subscription.toJSON();
  const response = await api.settings.push.resync({ endpoint, keys, ...(previousEndpoint ? { previousEndpoint } : {}) });
  return response.ok;
};

/**
 * Whether the browser lets the page subscribe now, outside a click. Asked with the key the held subscription was
 * made with, subscribe() hands that one back and changes nothing; Safari refuses it without a user gesture.
 */
const canSubscribeWithoutGesture = async (
  registration: ServiceWorkerRegistration,
  applicationServerKey: ArrayBuffer,
): Promise<boolean> => {
  try {
    await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    return true;
  } catch {
    return false;
  }
};

/** The repair itself, with the subscription read and checked again: another tab may have done it meanwhile. */
const repairHeldSubscription = async (): Promise<PushRegistrationCheck> => {
  const held = await readHeldSubscription();
  if (!held?.subscription) {
    return { status: held ? 'none' : 'unsupported', endpoint: null };
  }

  const { subscription, registration } = held;
  const { status, publicKey } = await askServer(subscription);
  if ((status !== 'unknown' && status !== 'staleKey') || !publicKey) {
    return { status, endpoint: subscription.endpoint };
  }

  const applicationServerKey = urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer;
  // The server most often lacks a subscription because the push service called it gone and the server dropped it.
  // Saved again as it is, it would be dropped again at the next push, and that push lost; so it is replaced, like
  // one made with an old key. A browser that will not subscribe outside a click would be left with none, so there
  // the one it holds is saved again instead.
  if (status === 'unknown' && !(await canSubscribeWithoutGesture(registration, applicationServerKey))) {
    return (await resyncSubscription(subscription))
      ? { status: 'registered', endpoint: subscription.endpoint }
      : { status, endpoint: subscription.endpoint };
  }

  // The browser hands back the subscription it holds when asked with the same key, and refuses to replace one made
  // with another: the old one has to go first. Should subscribing again fail, little is lost, as the server could
  // not push to the old one anyway.
  const previousEndpoint = subscription.endpoint;
  await subscription.unsubscribe();
  const fresh = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  return (await resyncSubscription(fresh, previousEndpoint))
    ? { status: 'registered', endpoint: fresh.endpoint }
    : { status: 'unknown', endpoint: fresh.endpoint };
};

/**
 * Puts right a subscription the server cannot push to: one it lacks, or one made with another VAPID key, is
 * replaced by a new one made with the current key, and the old endpoint dropped on the server (where the browser
 * will not subscribe outside a click, one the server lacks is saved again as it is). Neither changes the user's
 * preferences or sends the "enabled" push, as turning push on in Settings does. Runs under a Web Lock where there
 * is one, so tabs repairing at once do the work once. Resolves to the check after it, with the endpoint the
 * browser holds then; 'unchecked' when something failed on the way.
 */
export const repairPushRegistration = async (): Promise<PushRegistrationCheck> => {
  try {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    return locks
      ? await locks.request(PUSH_REPAIR_LOCK_NAME, repairHeldSubscription)
      : await repairHeldSubscription();
  } catch {
    return { status: 'unchecked', endpoint: null };
  }
};

/** userAgentData.platform, else navigator.platform; at most 40 characters. */
const readPlatform = (): string => {
  const platformNavigator = navigator as PlatformNavigator;
  return (platformNavigator.userAgentData?.platform || navigator.platform || '').slice(0, PLATFORM_MAX_LENGTH);
};

/**
 * Sends one system-notification decision to the server log (`[client-diag] notification`), with the permission,
 * the page's visibility and focus, and the platform read now; best effort, never in the way of the notification.
 */
export const reportNotificationDelivery = (
  report: Pick<NotificationDeliveryReport, 'outcome' | 'reason' | 'push' | 'silent'>,
): void => {
  const payload: NotificationDeliveryReport = {
    event: 'notification',
    ...report,
    permission: readNotificationPermission(),
    visibility: document.visibilityState === 'visible' ? 'visible' : 'hidden',
    focused: document.hasFocus(),
    platform: readPlatform(),
  };
  Promise.resolve()
    .then(() => api.system.reportClientDiagnostics(payload))
    .catch(() => undefined);
};
