// Service Worker for CloudCLI PWA
// Cache only manifest (needed for PWA install). HTML and JS are never pre-cached
// so a rebuild + refresh always picks up the latest assets.
const CACHE_NAME = 'claude-ui-v2';
const urlsToCache = [
  '/manifest.json'
];

// Install event
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

// Fetch event — network-first for everything except hashed assets
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Never intercept API requests or WebSocket upgrades
  if (url.includes('/api/') || url.includes('/ws')) {
    return;
  }

  // Navigation requests (HTML) — always go to network, no caching
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/manifest.json').then(() =>
        new Response('<h1>Offline</h1><p>Please check your connection.</p>', {
          headers: { 'Content-Type': 'text/html' }
        })
      ))
    );
    return;
  }

  // Hashed assets (JS/CSS in /assets/) — cache-first since filenames change per build
  if (url.includes('/assets/')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        });
      })
    );
    return;
  }

  // Everything else — network-first
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// Activate event — purge old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames =>
      Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

// Pushes for a finished task. While a CloudCLI window is focused, that page chimes for
// the task itself (run-notifications), so these pushes are shown without a sound of their own;
// the banner still shows.
const RUN_PUSH_CODES = new Set(['run.stopped', 'run.failed', 'run.background_completed']);

// True when any CloudCLI window of this origin has focus, also one this worker does not
// control yet. A failed lookup counts as no focus: the push still shows, with its sound.
async function hasFocusedWindow() {
  try {
    const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    return windowClients.some(client => client.focused === true);
  } catch {
    return false;
  }
}

// Push notification event
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'CloudCLI', body: event.data.text() };
  }

  const options = {
    body: payload.body || '',
    icon: '/logo-256.png',
    badge: '/logo-128.png',
    data: payload.data || {},
    tag: payload.data?.tag || `${payload.data?.sessionId || 'global'}:${payload.data?.code || 'default'}`,
    // The tag names the session and outcome, so a push replaces the session's last notification
    // while it still sits in Notification Center or Action Center. Without renotify, macOS and
    // Windows make that replacement without a banner: one banner per session, then none.
    renotify: true
  };

  // Every push shows a notification, focused or not: Safari revokes the subscription of a
  // worker that receives pushes without showing one.
  event.waitUntil((async () => {
    if (RUN_PUSH_CODES.has(payload.data?.code) && await hasFocusedWindow()) {
      options.silent = true;
    }
    await self.registration.showNotification(payload.title || 'CloudCLI', options);
  })());
});

// The browser replaced or dropped this worker's push subscription (Firefox does it now and
// then, other browsers when the push service expires one). The worker cannot tell the server: API
// calls carry the sign-in token a page keeps in localStorage, out of a worker's reach. So it
// makes sure the browser still holds a subscription with the same key and asks the open pages
// to check it with the server, which saves it again; with no page open, the next page load does.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    try {
      const applicationServerKey = event.oldSubscription?.options?.applicationServerKey;
      if (!event.newSubscription && applicationServerKey) {
        await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      }
    } catch {
      // The pages find no subscription, or one the server lacks, and post their own notifications.
    }
    try {
      const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windowClients) {
        client.postMessage({ type: 'push:subscription-changed' });
      }
    } catch {
      // Each page checks again on its next load or when it comes back into view.
    }
  })());
});

// Notification click event
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const sessionId = event.notification.data?.sessionId;
  const provider = event.notification.data?.provider || null;
  const urlPath = sessionId ? `/session/${sessionId}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          await client.focus();
          client.postMessage({
            type: 'notification:navigate',
            sessionId: sessionId || null,
            provider,
            urlPath
          });
          return;
        }
      }
      return self.clients.openWindow(urlPath);
    })
  );
});
