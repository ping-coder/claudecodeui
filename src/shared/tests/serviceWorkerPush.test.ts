import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from 'vitest';

/**
 * public/sw.js is a classic worker script, not a module, so it runs here the way the
 * browser runs it: its source evaluated against a stubbed worker scope.
 *
 * A push for a finished task can land while a CloudCLI page is chiming for the same task.
 * With a CloudCLI window focused the push must therefore be silent; with none focused it
 * keeps its sound. Every push still shows a notification, and the other codes and the
 * notification click behave as before.
 */

// Resolved from this file's path rather than with `new URL(…, import.meta.url)`: under
// jsdom, URL is jsdom's class, which node:url does not accept.
const SERVICE_WORKER_SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../public/sw.js'),
  'utf8',
);

const ORIGIN = 'https://cloudcli.test';

type WindowClientStub = {
  url: string;
  focused: boolean;
  focusCalls: number;
  messages: unknown[];
  focus: () => Promise<void>;
  postMessage: (message: unknown) => void;
};

type ShownNotification = {
  title: string;
  options: Record<string, unknown>;
};

const windowClient = ({ focused }: { focused: boolean }): WindowClientStub => {
  const client: WindowClientStub = {
    url: `${ORIGIN}/session/other`,
    focused,
    focusCalls: 0,
    messages: [],
    focus: async () => {
      client.focusCalls += 1;
    },
    postMessage: (message) => {
      client.messages.push(message);
    },
  };
  return client;
};

/**
 * Evaluates sw.js against a fresh stub scope. `matchAll` answers with `windowClients`, or
 * rejects when `matchAllError` is set.
 */
const loadServiceWorker = ({
  windowClients = [],
  matchAllError = null,
}: {
  windowClients?: WindowClientStub[];
  matchAllError?: Error | null;
} = {}) => {
  const listeners = new Map<string, (event: unknown) => void>();
  const shown: ShownNotification[] = [];
  const matchAllQueries: unknown[] = [];
  const openedUrls: string[] = [];

  const clients = {
    matchAll: async (query: unknown) => {
      matchAllQueries.push(query);
      if (matchAllError) {
        throw matchAllError;
      }
      return windowClients;
    },
    openWindow: async (url: string) => {
      openedUrls.push(url);
      return null;
    },
    claim: async () => undefined,
  };

  const scope = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    },
    skipWaiting: () => undefined,
    clients,
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
      },
    },
    location: { origin: ORIGIN },
  };

  const caches = {
    open: async () => ({ addAll: async () => undefined, put: async () => undefined }),
    keys: async () => [],
    match: async () => undefined,
    delete: async () => true,
  };

  // The worker's globals are passed as parameters, so nothing reaches the real ones.
  const runWorkerScript = new Function('self', 'clients', 'caches', 'fetch', 'Response', SERVICE_WORKER_SOURCE);
  runWorkerScript(scope, clients, caches, () => Promise.reject(new Error('offline')), class {});

  /** Dispatches an event to the worker's listener and waits for everything it handed to waitUntil. */
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    const pending: Promise<unknown>[] = [];
    const listener = listeners.get(type);
    assert.ok(listener, `sw.js registers a ${type} listener`);
    listener({
      ...event,
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
    });
    await Promise.all(pending);
  };

  const push = (payload: unknown) => dispatch('push', {
    data: {
      json: () => payload,
      text: () => JSON.stringify(payload),
    },
  });

  return { dispatch, push, shown, matchAllQueries, openedUrls };
};

/** A push shaped like the server's notification orchestrator builds it. */
const pushPayload = (code: string) => ({
  title: 'Fix login bug',
  body: 'Claude: Run Stopped: The run has stopped',
  data: {
    sessionId: 'session-1',
    code,
    provider: 'claude',
    sessionName: 'Fix login bug',
    tag: `claude:session-1:${code}`,
  },
});

/** The options sw.js has always shown a push with: sound on, renotify on. */
const audibleOptions = (code: string) => ({
  body: 'Claude: Run Stopped: The run has stopped',
  icon: '/logo-256.png',
  badge: '/logo-128.png',
  data: pushPayload(code).data,
  tag: `claude:session-1:${code}`,
  renotify: true,
});

test('a run.stopped push is shown silently while a CloudCLI window is focused', async () => {
  const worker = loadServiceWorker({
    windowClients: [windowClient({ focused: false }), windowClient({ focused: true })],
  });

  await worker.push(pushPayload('run.stopped'));

  assert.equal(worker.shown.length, 1);
  assert.equal(worker.shown[0].title, 'Fix login bug');
  assert.deepEqual(worker.shown[0].options, {
    ...audibleOptions('run.stopped'),
    silent: true,
    renotify: false,
  });
  // Uncontrolled windows count too: a page loaded before this worker took over still chimes.
  assert.deepEqual(worker.matchAllQueries, [{ type: 'window', includeUncontrolled: true }]);
});

test('run.failed and run.background_completed pushes are silent while a window is focused', async () => {
  for (const code of ['run.failed', 'run.background_completed']) {
    const worker = loadServiceWorker({ windowClients: [windowClient({ focused: true })] });

    await worker.push(pushPayload(code));

    assert.equal(worker.shown.length, 1, code);
    assert.equal(worker.shown[0].options.silent, true, code);
    assert.equal(worker.shown[0].options.renotify, false, code);
  }
});

test('a run.stopped push keeps its sound when no CloudCLI window is focused', async () => {
  for (const windowClients of [[], [windowClient({ focused: false })]]) {
    const worker = loadServiceWorker({ windowClients });

    await worker.push(pushPayload('run.stopped'));

    assert.equal(worker.shown.length, 1);
    assert.deepEqual(worker.shown[0].options, audibleOptions('run.stopped'));
  }
});

test('a run push is still shown, with its sound, when the window lookup fails', async () => {
  const worker = loadServiceWorker({ matchAllError: new Error('clients unavailable') });

  await worker.push(pushPayload('run.stopped'));

  assert.equal(worker.shown.length, 1);
  assert.deepEqual(worker.shown[0].options, audibleOptions('run.stopped'));
});

test('a permission.required push keeps its sound even while a window is focused', async () => {
  const worker = loadServiceWorker({ windowClients: [windowClient({ focused: true })] });

  await worker.push(pushPayload('permission.required'));

  assert.equal(worker.shown.length, 1);
  assert.deepEqual(worker.shown[0].options, audibleOptions('permission.required'));
});

test('a notification click focuses an open CloudCLI window and asks it to open the session', async () => {
  const client = windowClient({ focused: false });
  const worker = loadServiceWorker({ windowClients: [client] });
  let closed = false;

  await worker.dispatch('notificationclick', {
    notification: {
      data: { sessionId: 'session-1', provider: 'claude' },
      close: () => {
        closed = true;
      },
    },
  });

  assert.equal(closed, true);
  assert.equal(client.focusCalls, 1);
  assert.deepEqual(client.messages, [{
    type: 'notification:navigate',
    sessionId: 'session-1',
    provider: 'claude',
    urlPath: '/session/session-1',
  }]);
  assert.deepEqual(worker.openedUrls, []);
});

test('a notification click opens a window on the session when none is open', async () => {
  const worker = loadServiceWorker();

  await worker.dispatch('notificationclick', {
    notification: {
      data: { sessionId: 'session-1', provider: 'claude' },
      close: () => undefined,
    },
  });

  assert.deepEqual(worker.openedUrls, ['/session/session-1']);
});
