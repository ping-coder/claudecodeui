import assert from 'node:assert/strict';
import test from 'node:test';

import { createSettingsService } from '../settings.service.js';

type Dependencies = Parameters<typeof createSettingsService>[0];

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    apiKeys: { list: () => [], create: () => ({}), remove: () => false, toggle: () => false },
    credentials: { list: () => [], create: () => ({}), remove: () => false, toggle: () => false },
    notifications: {
      getPreferences: () => undefined,
      updatePreferences: () => ({}),
      createEnabledEvent: () => ({}),
      notifyUser: () => undefined,
    },
    pushSubscriptions: { save: () => undefined, remove: () => undefined, isRegistered: () => false },
    getVapidPublicKey: () => null,
    sendTestPush: async () => null,
    ...overrides,
  };
}

test('listApiKeys redacts secret values through the service boundary', () => {
  const service = createSettingsService(dependencies({
    apiKeys: {
      list: () => [{ id: 1, api_key: '1234567890-secret' }],
      create: () => ({}), remove: () => false, toggle: () => false,
    },
  }));
  assert.equal(service.listApiKeys(1).apiKeys[0]?.api_key, '1234567890...');
});

test('subscribeToPush persists the subscription and enables Web Push', () => {
  const operations: string[] = [];
  const service = createSettingsService(dependencies({
    pushSubscriptions: {
      save: (_id, endpoint) => operations.push(`save:${endpoint}`),
      remove: () => undefined,
      isRegistered: () => false,
    },
    notifications: {
      getPreferences: () => ({ channels: { webPush: false } }),
      updatePreferences: () => { operations.push('preferences'); return {}; },
      createEnabledEvent: () => ({ code: 'push.enabled' }),
      notifyUser: () => { operations.push('notify'); },
    },
  }));

  service.subscribeToPush(1, {
    endpoint: 'https://push.example.test',
    keys: { p256dh: 'key', auth: 'auth' },
  });
  assert.deepEqual(operations, ['save:https://push.example.test', 'preferences', 'notify']);
});

/** A store of push subscriptions per user, as the repository keeps them, recording what the service does to it. */
function subscriptionStore(entries: Array<[number, string]>) {
  const rows = new Map(entries.map(([userId, endpoint]) => [endpoint, userId]));
  const operations: string[] = [];
  return {
    rows,
    operations,
    pushSubscriptions: {
      save: (userId: number, endpoint: string) => {
        rows.set(endpoint, userId);
        operations.push(`save:${endpoint}`);
      },
      remove: (endpoint: string) => {
        rows.delete(endpoint);
        operations.push(`remove:${endpoint}`);
      },
      isRegistered: (userId: number, endpoint: string) => rows.get(endpoint) === userId,
    },
  };
}

test('getPushStatus says whether this user holds the endpoint', () => {
  const store = subscriptionStore([[1, 'https://push.example.test/mine'], [2, 'https://push.example.test/theirs']]);
  const service = createSettingsService(dependencies({ pushSubscriptions: store.pushSubscriptions }));

  assert.deepEqual(service.getPushStatus(1, 'https://push.example.test/mine'), { success: true, registered: true });
  assert.equal(service.getPushStatus(1, 'https://push.example.test/theirs').registered, false);
  assert.equal(service.getPushStatus(1, 'https://push.example.test/gone').registered, false);
  assert.throws(() => service.getPushStatus(1, ''), { code: 'PUSH_ENDPOINT_REQUIRED' });
});

test('resyncPushSubscription saves the subscription without touching the preferences or pushing', () => {
  const store = subscriptionStore([]);
  const effects: string[] = [];
  const service = createSettingsService(dependencies({
    pushSubscriptions: store.pushSubscriptions,
    notifications: {
      getPreferences: () => ({ channels: { webPush: false } }),
      updatePreferences: () => { effects.push('preferences'); return {}; },
      createEnabledEvent: () => ({ code: 'push.enabled' }),
      notifyUser: () => { effects.push('notify'); },
    },
  }));

  service.resyncPushSubscription(1, { endpoint: 'https://push.example.test/new', keys: { p256dh: 'key', auth: 'auth' } });

  assert.deepEqual(store.operations, ['save:https://push.example.test/new']);
  assert.deepEqual(effects, []);
  assert.throws(() => service.resyncPushSubscription(1, { endpoint: 'https://push.example.test/new' }), { code: 'PUSH_SUBSCRIPTION_REQUIRED' });
});

test('resyncPushSubscription drops the replaced endpoint only when it is this user\'s', () => {
  const store = subscriptionStore([[1, 'https://push.example.test/old'], [2, 'https://push.example.test/theirs']]);
  const service = createSettingsService(dependencies({ pushSubscriptions: store.pushSubscriptions }));
  const keys = { p256dh: 'key', auth: 'auth' };

  service.resyncPushSubscription(1, { endpoint: 'https://push.example.test/new', keys, previousEndpoint: 'https://push.example.test/old' });
  service.resyncPushSubscription(1, { endpoint: 'https://push.example.test/new', keys, previousEndpoint: 'https://push.example.test/theirs' });
  service.resyncPushSubscription(1, { endpoint: 'https://push.example.test/new', keys, previousEndpoint: 'https://push.example.test/new' });

  assert.deepEqual([...store.rows.entries()].sort(), [
    ['https://push.example.test/new', 1],
    ['https://push.example.test/theirs', 2],
  ]);
});

test('sendTestPush pushes to the one endpoint and returns the push service\'s answer', async () => {
  const sent: unknown[] = [];
  const service = createSettingsService(dependencies({
    sendTestPush: async (test) => {
      sent.push(test);
      return test.endpoint === 'https://push.example.test/mine' ? { accepted: true, statusCode: 201 } : null;
    },
  }));

  assert.deepEqual(await service.sendTestPush(1, {
    endpoint: 'https://push.example.test/mine',
    title: '  CloudCLI test  ',
    body: 'x'.repeat(500),
  }), { success: true, delivery: { accepted: true, statusCode: 201 } });
  assert.deepEqual(sent, [{ userId: 1, endpoint: 'https://push.example.test/mine', title: 'CloudCLI test', body: 'x'.repeat(200) }]);

  // Not this user's, or not stored at all.
  await assert.rejects(service.sendTestPush(1, { endpoint: 'https://push.example.test/theirs' }), {
    code: 'PUSH_SUBSCRIPTION_NOT_FOUND',
    statusCode: 404,
  });
  assert.deepEqual(sent[1], { userId: 1, endpoint: 'https://push.example.test/theirs', title: 'CloudCLI', body: 'Test notification' });
});
