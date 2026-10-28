import assert from 'node:assert/strict';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

/**
 * The store that replaced a dozen hand-rolled localStorage readers with one
 * server-backed copy. What matters here is the two behaviours the move must not
 * get wrong: an existing install's settings survive the migration, and a read
 * stays synchronous so the first paint is not a flash of defaults.
 *
 * Each test loads a fresh module copy because the store reads its localStorage
 * mirror once at module scope.
 */

type SavedPayload = Record<string, unknown>;

const saved: SavedPayload[] = [];
let serverPreferences: Record<string, unknown> | null = {};
let preferencesRequestFailed = false;
// The status GET /api/user/preferences answers with; its body is the same either way.
let preferencesStatus = 200;

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: async () => {
        if (preferencesRequestFailed) {
          throw new Error('offline');
        }
        return new Response(JSON.stringify({ success: true, preferences: serverPreferences }), {
          status: preferencesStatus,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      savePreferences: async (updates: SavedPayload) => {
        saved.push(updates);
        return new Response('{}', { status: 200 });
      },
      // Only field-level writes use this route; recorded so that any save shows.
      patchPreferences: async (changes: SavedPayload) => {
        saved.push(changes);
        return new Response('{}', { status: 200 });
      },
    },
  },
}));

const loadStore = async () => {
  vi.resetModules();
  return import('@/shared/userSettings');
};

beforeEach(() => {
  localStorage.clear();
  saved.length = 0;
  serverPreferences = {};
  preferencesRequestFailed = false;
  preferencesStatus = 200;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('a write is readable synchronously and reaches the server after the debounce', async () => {
  const store = await loadStore();

  store.writeUserPreference('theme', 'dark');

  assert.equal(store.readUserPreference('theme', 'light'), 'dark');
  assert.deepEqual(saved, [], 'the request must not fire on every keystroke');

  await vi.advanceTimersByTimeAsync(500);
  assert.deepEqual(saved, [{ theme: 'dark' }]);
});

test('a burst of writes collapses into one request carrying every change', async () => {
  const store = await loadStore();

  store.writeUserPreference('theme', 'dark');
  store.writeUserPreference('userLanguage', 'de');
  store.writeUserPreference('tasksEnabled', true);

  await vi.advanceTimersByTimeAsync(500);
  assert.deepEqual(saved, [{ theme: 'dark', userLanguage: 'de', tasksEnabled: true }]);
});

test('writing the value a preference already has sends nothing and notifies nobody', async () => {
  const store = await loadStore();
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(500);
  saved.length = 0;

  const listener = vi.fn();
  store.subscribeToUserPreferences(listener);
  store.writeUserPreference('theme', 'dark');

  await vi.advanceTimersByTimeAsync(500);
  assert.deepEqual(saved, []);
  expect(listener).not.toHaveBeenCalled();
});

test('a value written in one page load is readable synchronously in the next', async () => {
  const first = await loadStore();
  first.writeUserPreference('theme', 'dark');

  // No hydrate: this is the very first paint of the next load, before any
  // network request could have resolved.
  const second = await loadStore();
  assert.equal(second.readUserPreference('theme', 'light'), 'dark');
});

test('hydrate adopts the server copy over the local mirror', async () => {
  const store = await loadStore();
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(500);

  serverPreferences = { theme: 'light' };
  await store.hydrateUserPreferences();

  assert.equal(store.readUserPreference('theme', 'light'), 'light');
  assert.equal(store.hasHydratedUserPreferences(), true);
});

test('hydrate seeds a preference the server has never seen from its legacy key', async () => {
  localStorage.setItem('theme', 'dark');
  localStorage.setItem('tasks-enabled', 'true');
  localStorage.setItem('selected-provider', 'codex');
  localStorage.setItem('uiPreferences', JSON.stringify({ showThinking: false }));

  const store = await loadStore();
  await store.hydrateUserPreferences();

  assert.equal(store.readUserPreference('theme', 'light'), 'dark');
  assert.equal(store.readUserPreference('tasksEnabled', false), true);
  assert.equal(store.readUserPreference('selectedProvider', 'claude'), 'codex');
  assert.deepEqual(store.readUserPreference('uiPreferences', {}), { showThinking: false });

  await vi.advanceTimersByTimeAsync(500);
  assert.equal(saved.length, 1, 'the migrated values are pushed up in one request');
  assert.equal((saved[0] as Record<string, unknown>).theme, 'dark');
});

test('hydrate splits the legacy claude-settings blob into permissions and sort order', async () => {
  localStorage.setItem('claude-settings', JSON.stringify({
    allowedTools: ['Read'],
    disallowedTools: ['Bash'],
    skipPermissions: true,
    projectSortOrder: 'date',
    lastUpdated: '2026-01-01T00:00:00.000Z',
  }));

  const store = await loadStore();
  await store.hydrateUserPreferences();

  assert.deepEqual(store.readUserPreference('claudePermissions', null), {
    allowedTools: ['Read'],
    disallowedTools: ['Bash'],
    skipPermissions: true,
  });
  assert.equal(store.readUserPreference('projectSortOrder', 'name'), 'date');
});

test('hydrate reassembles the four separate code-editor keys into one preference', async () => {
  localStorage.setItem('codeEditorWordWrap', 'true');
  localStorage.setItem('codeEditorShowMinimap', 'false');
  localStorage.setItem('codeEditorFontSize', '16');

  const store = await loadStore();
  await store.hydrateUserPreferences();

  assert.deepEqual(store.readUserPreference('codeEditorSettings', null), {
    wordWrap: true,
    showMinimap: false,
    fontSize: '16',
  });
});

test('a legacy value is never allowed to overwrite what the server already holds', async () => {
  localStorage.setItem('theme', 'dark');
  serverPreferences = { theme: 'light' };

  const store = await loadStore();
  await store.hydrateUserPreferences();

  assert.equal(store.readUserPreference('theme', 'light'), 'light');
  await vi.advanceTimersByTimeAsync(500);
  assert.deepEqual(saved, [], 'nothing was migrated, so nothing is pushed up');
});

test('a failed hydrate keeps the mirrored values instead of snapping back to defaults', async () => {
  const store = await loadStore();
  store.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(500);

  preferencesRequestFailed = true;
  await store.hydrateUserPreferences();

  assert.equal(store.readUserPreference('theme', 'light'), 'dark');
  assert.equal(store.hasHydratedUserPreferences(), false);
});

test('hydrate cancels a write the page made on its own before it, so a second device cannot clobber the server', async () => {
  // The failure this pins: on a device with an empty mirror, the page starts
  // on the default provider and the focused pane writes it on its own before
  // the stored choice arrives. Flushed after the hydrate, that start-up value
  // would reset the user's choice for every device.
  serverPreferences = { selectedProvider: 'codex' };
  const store = await loadStore();
  const { writeSelectedProvider } = await import('@/shared/selectedProvider');

  writeSelectedProvider('claude', { automatic: true });
  await store.hydrateUserPreferences();
  await vi.advanceTimersByTimeAsync(500);

  assert.deepEqual(saved, [], 'the pre-hydrate write must not reach the server');
  assert.equal(store.readUserPreference('selectedProvider', null), 'codex');
});

test('a choice the user made before the hydrate answered survives it and is sent', async () => {
  serverPreferences = { theme: 'dark', projectSortOrder: 'name' };
  const store = await loadStore();

  store.writeUserPreference('theme', 'light');
  store.writeUserPreferences({ projectSortOrder: 'date' });
  await store.hydrateUserPreferences();

  assert.equal(store.readUserPreference('theme', null), 'light');
  assert.equal(store.readUserPreference('projectSortOrder', null), 'date');
  await vi.advanceTimersByTimeAsync(500);
  assert.deepEqual(saved, [{ theme: 'light', projectSortOrder: 'date' }]);
});

test('a migrated value not sent yet gives way to a later hydrate that finds the key on the server', async () => {
  localStorage.setItem('theme', 'dark');
  const store = await loadStore();
  await store.hydrateUserPreferences();
  // Another device stores a theme before the migrated one has gone out.
  serverPreferences = { theme: 'light' };
  await store.hydrateUserPreferences();
  await vi.advanceTimersByTimeAsync(500);

  assert.equal(store.readUserPreference('theme', null), 'light');
  assert.deepEqual(saved, [], 'the legacy value never reaches the server');
});

test('hydrate leaves a queued write for a key the server has no answer for', async () => {
  serverPreferences = { theme: 'dark' };
  const store = await loadStore();

  store.writeUserPreference('userLanguage', 'de');
  await store.hydrateUserPreferences();
  await vi.advanceTimersByTimeAsync(500);

  assert.deepEqual(saved, [{ userLanguage: 'de' }]);
});

test('reset clears the copy so the next user does not inherit the previous one', async () => {
  const store = await loadStore();
  store.writeUserPreference('theme', 'dark');

  store.resetUserPreferences();

  assert.equal(store.readUserPreference('theme', 'light'), 'light');
  assert.equal(localStorage.getItem('user-preferences'), null);
});

/**
 * Seeds a browser that has migrated: the mirror holds the server's copy, and
 * the legacy keys the migration read from were never removed.
 */
const seedMigratedBrowser = (): string => {
  localStorage.setItem('theme', 'light');
  localStorage.setItem('claude-settings', JSON.stringify({ allowedTools: ['Read'], projectSortOrder: 'name' }));
  const mirror = JSON.stringify({
    theme: 'dark',
    claudePermissions: { allowedTools: ['Read', 'Grep'], skipPermissions: true },
  });
  localStorage.setItem('user-preferences', mirror);
  return mirror;
};

test('a hydrate answered with an error status keeps the mirror and migrates nothing', async () => {
  // A 502 used to read as an empty server, so the long-replaced legacy values
  // were adopted and pushed over the user's real settings.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const mirror = seedMigratedBrowser();
  preferencesStatus = 502;

  const store = await loadStore();
  await store.hydrateUserPreferences();

  assert.equal(store.readUserPreference('theme', 'light'), 'dark');
  assert.equal(localStorage.getItem('user-preferences'), mirror);
  assert.equal(store.hasHydratedUserPreferences(), false);
  await vi.advanceTimersByTimeAsync(500);
  assert.equal(saved.length, 0, 'nothing is pushed up');
});

test('a hydrate whose answer carries no preferences object is a failed read too', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const mirror = seedMigratedBrowser();
  serverPreferences = null;

  const store = await loadStore();
  await store.hydrateUserPreferences();

  assert.equal(store.readUserPreference('theme', 'light'), 'dark');
  assert.equal(localStorage.getItem('user-preferences'), mirror);
  assert.equal(store.hasHydratedUserPreferences(), false);
  await vi.advanceTimersByTimeAsync(500);
  assert.equal(saved.length, 0, 'nothing is pushed up');
});
