import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import { isPushSubscriptionMadeWithKey, urlBase64ToUint8Array } from '@/shared/systemNotifications';
import type { PushSubscribeOutcome } from '@/shared/types';

type PushSubscribeFailure = Exclude<PushSubscribeOutcome, 'subscribed'>;

type WebPushState = {
  permission: NotificationPermission | 'unsupported';
  isSubscribed: boolean;
  isLoading: boolean;
  /**
   * Why the last attempt to subscribe failed, until the next attempt or until push is turned off;
   * null when it did not fail, or failed with push already on in this browser.
   */
  subscribeFailure: PushSubscribeFailure | null;
  /** Subscribes this browser and resolves to how it went: only 'subscribed' means the server saved the subscription. */
  subscribe: () => Promise<PushSubscribeOutcome>;
  unsubscribe: () => Promise<void>;
  /** Asks for notification permission alone (no push subscription) and resolves to the answer. */
  requestPermission: () => Promise<NotificationPermission | 'unsupported'>;
};

/** How long subscribing waits for the service worker; `ready` never settles while none is active. */
const SERVICE_WORKER_READY_TIMEOUT_MS = 10_000;

/** The active service worker's registration, or null when none is active within SERVICE_WORKER_READY_TIMEOUT_MS. */
function waitForServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), SERVICE_WORKER_READY_TIMEOUT_MS);
    navigator.serviceWorker.ready.then(
      (registration) => {
        window.clearTimeout(timer);
        resolve(registration);
      },
      () => {
        window.clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export function useWebPush(): WebPushState {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => {
    if (
      typeof window === 'undefined'
      || Boolean((window as any).cloudcliDesktopNotifications)
      || !('Notification' in window)
      || !('serviceWorker' in navigator)
    ) {
      return 'unsupported';
    }
    return Notification.permission;
  });
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  // Why the last subscribe attempt failed: the notifications tab says so under the push button,
  // since a failed attempt leaves the button as it was before the click.
  const [subscribeFailure, setSubscribeFailure] = useState<PushSubscribeFailure | null>(null);

  // Check existing subscription on mount
  useEffect(() => {
    if (permission === 'unsupported') return;

    navigator.serviceWorker.ready.then((registration) => {
      registration.pushManager.getSubscription().then((sub) => {
        setIsSubscribed(sub !== null);
      });
    }).catch(() => {
      // SW not ready yet
    });
  }, [permission]);

  const subscribe = useCallback(async (): Promise<PushSubscribeOutcome> => {
    const fail = (failure: PushSubscribeFailure): PushSubscribeOutcome => {
      setSubscribeFailure(failure);
      return failure;
    };
    if (permission === 'unsupported') {
      return fail('unsupported');
    }
    setIsLoading(true);
    setSubscribeFailure(null);

    // Set once the browser holds a subscription, which has to go again if the server never gets it.
    let subscription: PushSubscription | null = null;
    // False when subscribe() handed back the subscription the browser already held, say one another
    // tab turned on since this one looked: the server got it then, so a failure here leaves it be.
    let createdHere = false;
    try {
      // The first async step: browsers show the prompt only while the click's user activation is live.
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm === 'denied') return fail('denied');
      // Still 'default': the prompt was closed without an answer.
      if (perm !== 'granted') return fail('dismissed');

      const registration = await waitForServiceWorker();
      if (!registration) {
        throw new Error('No active service worker');
      }
      // Notifications without push: Safari before 16, or iOS outside a Home Screen web app.
      if (!registration.pushManager) return fail('unsupported');

      const keyRes = await api.settings.push.vapidPublicKey();
      const { publicKey } = keyRes.ok ? await keyRes.json() : { publicKey: null };
      if (typeof publicKey !== 'string' || !publicKey) {
        throw new Error(`No VAPID public key (${keyRes.status})`);
      }

      // What the browser holds, read just before subscribe(), which hands it back when it was made
      // with the same key. One made with another key (an older VAPID key of this server, or another
      // server at this address) takes no push from here, and subscribe() refuses to replace it.
      let held = await registration.pushManager.getSubscription().catch(() => null);
      if (held && !isPushSubscriptionMadeWithKey(held, publicKey)) {
        await held.unsubscribe().catch(() => false);
        held = null;
      }
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
      });
      // Compared by endpoint, since every call returns a new object. An expired subscription is
      // replaced by one with a new endpoint, which counts as made here.
      createdHere = subscription.endpoint !== held?.endpoint;

      const subJson = subscription.toJSON();
      const saved = await api.settings.push.subscribe({
        endpoint: subJson.endpoint,
        keys: subJson.keys,
      });
      if (!saved.ok) {
        throw new Error(`The server refused the push subscription (${saved.status})`);
      }

      setIsSubscribed(true);
      return 'subscribed';
    } catch (err) {
      console.error('Push subscribe failed:', err);
      if (subscription && !createdHere) {
        // Push was on in this browser before the click: the subscription stays and the button
        // catches up with it. The outcome alone says that this attempt saved nothing.
        setIsSubscribed(true);
        return 'failed';
      }
      // The server has no copy of the subscription made here, so nothing would arrive through the
      // browser's. Dropping it too keeps run notifications from leaving a finished task's alert to
      // a push that never comes.
      await subscription?.unsubscribe().catch(() => false);
      setIsSubscribed(false);
      return fail('failed');
    } finally {
      setIsLoading(false);
    }
  }, [permission]);

  // The settings page's "Allow notifications" button, for page-sent system notifications.
  // Notification.requestPermission() must stay the first async step: browsers only show
  // the prompt while the click's user activation is still live.
  const requestPermission = useCallback(async (): Promise<NotificationPermission | 'unsupported'> => {
    if (permission === 'unsupported') {
      return 'unsupported';
    }

    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      return result;
    } catch (err) {
      console.error('Notification permission request failed:', err);
      return Notification.permission;
    }
  }, [permission]);

  const unsubscribe = useCallback(async () => {
    setIsLoading(true);
    // A failure note from an attempt before push came on (another tab turned it on) would show
    // again under the button once push is off.
    setSubscribeFailure(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();
        await api.settings.push.unsubscribe(endpoint);
      }
      setIsSubscribed(false);
    } catch (err) {
      console.error('Push unsubscribe failed:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { permission, isSubscribed, isLoading, subscribeFailure, subscribe, unsubscribe, requestPermission };
}
