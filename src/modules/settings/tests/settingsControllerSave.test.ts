import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useSettingsController } from '@/modules/settings/hooks/useSettingsController';
import { hydrateUserPreferences, readUserPreference, resetUserPreferences } from '@/shared/userSettings';
import type { NotificationPreferencesState } from '@/shared/types';

/**
 * Opening Settings used to show "Settings saved successfully!" about half a second later and
 * write the dialog's values back, with nothing changed: the auto-save effect keyed on them
 * also ran for the renders loading causes, and its skip flag was used up before the
 * notification preferences arrived. Saving now starts only from the dialog's edit handlers
 * and writes only what differs from what is stored.
 */

const server = vi.hoisted(() => ({
  /** What the server holds; GET answers it and a successful PUT replaces it. */
  stored: null as unknown,
  getOk: true,
  getDelayMs: 20,
  getCount: 0,
  putDelayMs: 0,
  notificationPuts: [] as unknown[],
  preferencePatches: [] as Array<Record<string, unknown>>,
  /** The user preferences the server holds; the store's read answers them and a PATCH merges into them. */
  userPreferences: {} as Record<string, unknown>,
  /** While set, the store's read waits until releasePreferencesRead is called. */
  holdPreferencesRead: false,
  releasePreferencesRead: null as null | (() => void),
}));

vi.mock('@/shared/api', () => ({
  api: {
    settings: {
      notificationPreferences: () => {
        server.getCount += 1;
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(server.getOk
              ? { ok: true, json: async () => ({ success: true, preferences: server.stored }) }
              : { ok: false, json: async () => ({}) });
          }, server.getDelayMs);
        });
      },
      saveNotificationPreferences: (preferences: unknown) => {
        server.notificationPuts.push(preferences);
        return new Promise((resolve) => {
          setTimeout(() => {
            server.stored = preferences;
            resolve({ ok: true, json: async () => ({ success: true, preferences }) });
          }, server.putDelayMs);
        });
      },
    },
    user: {
      preferences: () => new Promise((resolve) => {
        const answer = () => {
          resolve({ ok: true, json: async () => ({ preferences: structuredClone(server.userPreferences) }) });
        };
        if (server.holdPreferencesRead) {
          server.releasePreferencesRead = answer;
        } else {
          answer();
        }
      }),
      savePreferences: (updates: Record<string, unknown>) => {
        server.preferencePatches.push(updates);
        Object.assign(server.userPreferences, structuredClone(updates));
        return Promise.resolve({ ok: true, json: async () => ({}) });
      },
    },
  },
}));

// Stable identities: the open effect depends on these functions.
vi.mock('@/shared/context/ThemeContext', () => {
  const theme = { isDarkMode: false, toggleDarkMode: () => undefined };
  return { useTheme: () => theme };
});

vi.mock('@/modules/provider-auth', () => {
  const authStatus = {
    providerAuthStatus: {},
    checkProviderAuthStatus: () => Promise.resolve({ authenticated: false }),
    refreshProviderAuthStatuses: () => Promise.resolve(),
  };
  return { useProviderAuthStatus: () => authStatus };
});

/** Unlike the client defaults (inApp on, Web Push and desktop off), so a PUT of defaults shows. */
const STORED: NotificationPreferencesState = {
  channels: { inApp: false, webPush: true, desktop: true, sound: true },
  events: { actionRequired: true, stop: true, error: false },
};

/** Moves fake time in small steps, each inside act, so every update renders and its effects run. */
const advance = async (totalMs: number, stepMs = 25) => {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(stepMs);
    });
  }
};

/** Opens the controller and records every saveStatus it renders, since the message clears itself after 2 s. */
const openSettings = ({ reactStrictMode = false, initialTab = 'agents' } = {}) => {
  const statuses: Array<'success' | 'error' | null> = [];
  const rendered = renderHook(({ tab }) => {
    const controller = useSettingsController({ isOpen: true, initialTab: tab });
    statuses.push(controller.saveStatus);
    return controller;
  }, { initialProps: { tab: initialTab }, reactStrictMode });
  return { ...rendered, statuses };
};

const withEvent = (
  preferences: NotificationPreferencesState,
  event: keyof NotificationPreferencesState['events'],
  value: boolean,
): NotificationPreferencesState => ({ ...preferences, events: { ...preferences.events, [event]: value } });

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetUserPreferences();
  server.stored = structuredClone(STORED);
  server.getOk = true;
  server.getDelayMs = 20;
  server.getCount = 0;
  server.putDelayMs = 0;
  server.notificationPuts = [];
  server.preferencePatches = [];
  server.userPreferences = {};
  server.holdPreferencesRead = false;
  server.releasePreferencesRead = null;
});

afterEach(() => {
  resetUserPreferences();
  vi.useRealTimers();
});

test('opening settings without a change saves nothing and says nothing', async () => {
  const { result, statuses } = openSettings();

  await advance(3000);

  assert.equal(result.current.notificationPreferencesStatus, 'ready');
  assert.deepEqual(result.current.notificationPreferences, STORED);
  assert.equal(server.notificationPuts.length, 0, 'no PUT of the notification preferences');
  assert.equal(server.preferencePatches.length, 0, 'no PATCH of the user preferences');
  assert.equal(localStorage.getItem('user-preferences'), null, 'defaults are not written into the mirror');
  assert.equal(statuses.includes('success'), false, 'no saved message');
});

test('opening settings in StrictMode, which runs the open effects twice, saves nothing either', async () => {
  const { statuses } = openSettings({ reactStrictMode: true });

  await advance(3000);

  assert.equal(server.notificationPuts.length, 0);
  assert.equal(server.preferencePatches.length, 0);
  assert.equal(statuses.includes('success'), false);
});

test('when the notification preferences cannot be read, nothing sends the defaults over them', async () => {
  server.getOk = false;
  const { result, statuses } = openSettings();
  await advance(200);

  assert.equal(result.current.notificationPreferencesStatus, 'failed');
  // What the push and desktop handlers still do after a failed read.
  act(() => {
    result.current.updateNotificationPreferences((current) => withEvent(current, 'stop', false));
  });
  await advance(1500);

  assert.equal(server.notificationPuts.length, 0);
  assert.deepEqual(server.stored, STORED);
  assert.equal(statuses.includes('success'), false);
});

test('a permission change saves that key alone and says so', async () => {
  const { result, statuses } = openSettings();
  await advance(200);

  act(() => {
    result.current.updateClaudePermissions({
      allowedTools: ['Bash(git status:*)'],
      disallowedTools: [],
      skipPermissions: false,
    });
  });
  await advance(1500);

  assert.deepEqual(server.preferencePatches, [{
    claudePermissions: { allowedTools: ['Bash(git status:*)'], disallowedTools: [], skipPermissions: false },
  }]);
  assert.equal(server.notificationPuts.length, 0, 'the notification preferences did not change');
  assert.equal(statuses.includes('success'), true);
});

test('a notification change is PUT once, with the loaded values kept', async () => {
  const { result, statuses } = openSettings();
  await advance(200);

  act(() => {
    result.current.updateNotificationPreferences(withEvent(result.current.notificationPreferences, 'stop', false));
  });
  await advance(1500);

  assert.deepEqual(server.notificationPuts, [withEvent(STORED, 'stop', false)]);
  assert.equal(server.preferencePatches.length, 0);
  assert.equal(statuses.includes('success'), true);
});

test('a permission changed and changed back saves nothing', async () => {
  const { result, statuses } = openSettings();
  await advance(200);
  const loaded = result.current.claudePermissions;

  act(() => {
    result.current.updateClaudePermissions({ ...loaded, skipPermissions: true });
  });
  act(() => {
    result.current.updateClaudePermissions({ ...loaded, skipPermissions: false });
  });
  await advance(1500);

  assert.equal(server.preferencePatches.length, 0);
  assert.equal(statuses.includes('success'), false);
});

test('a notification switch flipped and flipped back saves nothing', async () => {
  const { result, statuses } = openSettings();
  await advance(200);

  act(() => {
    result.current.updateNotificationPreferences((current) => withEvent(current, 'stop', false));
  });
  act(() => {
    result.current.updateNotificationPreferences((current) => withEvent(current, 'stop', true));
  });
  await advance(1500);

  assert.equal(server.notificationPuts.length, 0);
  assert.equal(statuses.includes('success'), false);
});

test('a switch flipped back while the first PUT is still on its way is saved too, in order', async () => {
  server.putDelayMs = 1000;
  const { result } = openSettings();
  await advance(200);

  act(() => {
    result.current.updateNotificationPreferences((current) => withEvent(current, 'stop', false));
  });
  await advance(600);
  assert.equal(server.notificationPuts.length, 1, 'the first PUT is on its way');
  act(() => {
    result.current.updateNotificationPreferences((current) => withEvent(current, 'stop', true));
  });
  await advance(3000);

  assert.deepEqual(server.notificationPuts, [withEvent(STORED, 'stop', false), STORED]);
  assert.deepEqual(server.stored, STORED, 'the server ends where the screen does');
  assert.deepEqual(result.current.notificationPreferences, STORED);
});

test('while the notification preferences load, a permission edit saves and the defaults are never sent', async () => {
  server.getDelayMs = 2000;
  const { result } = openSettings();
  await advance(50);

  assert.equal(result.current.notificationPreferencesStatus, 'loading');
  act(() => {
    result.current.updateCodexPermissionMode('acceptEdits');
    result.current.updateNotificationPreferences((current) => withEvent(current, 'stop', false));
  });
  await advance(4000);

  assert.deepEqual(server.preferencePatches, [{ codexPermissions: { permissionMode: 'acceptEdits' } }]);
  assert.equal(server.notificationPuts.length, 0, 'the defaults shown while loading never reach the server');
  assert.deepEqual(result.current.notificationPreferences, STORED);
});

test('a notification edit made before the server answers is dropped when its copy arrives', async () => {
  // The push and desktop handlers can resume before the read answers. Their edit was made on
  // the defaults; sending it after the answer would write those defaults over the server's
  // other values.
  server.getDelayMs = 300;
  const { result } = openSettings();
  await advance(50);

  act(() => {
    result.current.updateNotificationPreferences((current) => withEvent(current, 'stop', false));
  });
  await advance(3000);

  assert.equal(server.notificationPuts.length, 0);
  assert.deepEqual(result.current.notificationPreferences, STORED);
});

test('closing the dialog right after an edit still saves it', async () => {
  const { result, unmount } = openSettings();
  await advance(200);

  act(() => {
    result.current.updateCodexPermissionMode('bypassPermissions');
    result.current.updateNotificationPreferences((current) => withEvent(current, 'error', true));
  });
  await advance(100);
  unmount();
  await advance(1500);

  assert.deepEqual(server.preferencePatches, [{ codexPermissions: { permissionMode: 'bypassPermissions' } }]);
  assert.deepEqual(server.notificationPuts, [withEvent(STORED, 'error', true)]);
});

test('opening settings at another tab while it is open switches tabs without loading again', async () => {
  const { result, rerender } = openSettings({ initialTab: 'agents' });
  await advance(200);

  act(() => {
    result.current.updateCodexPermissionMode('acceptEdits');
  });
  await advance(100);
  rerender({ tab: 'notifications' });
  await advance(1500);

  assert.equal(result.current.activeTab, 'notifications');
  assert.equal(server.getCount, 1, 'no second load');
  assert.equal(result.current.codexPermissionMode, 'acceptEdits');
  assert.deepEqual(readUserPreference('codexPermissions', null), { permissionMode: 'acceptEdits' });
});

test('two notification updates in one batch both survive', async () => {
  // The push and desktop handlers resume after an await; computing from the value last
  // shown, not from the render they started in, keeps an edit made in between.
  const { result } = openSettings();
  await advance(200);

  act(() => {
    result.current.updateNotificationPreferences((current) => withEvent(current, 'stop', false));
    result.current.updateNotificationPreferences((current) => ({
      ...current,
      channels: { ...current.channels, webPush: false },
    }));
  });
  await advance(1500);

  const expected = { channels: { ...STORED.channels, webPush: false }, events: { ...STORED.events, stop: false } };
  assert.deepEqual(result.current.notificationPreferences, expected);
  assert.deepEqual(server.notificationPuts, [expected]);
});

test('an edit still waiting when the session ends is not written after it', async () => {
  const { result, unmount } = openSettings();
  await advance(200);

  act(() => {
    result.current.updateClaudePermissions({ allowedTools: ['Bash'], disallowedTools: [], skipPermissions: true });
    result.current.updateNotificationPreferences((current) => withEvent(current, 'error', true));
  });
  await advance(100);
  // Signing out resets the store first; React unmounts the dialog after that.
  resetUserPreferences();
  unmount();
  await advance(2000);

  assert.equal(readUserPreference('claudePermissions', null), null);
  assert.equal(localStorage.getItem('user-preferences'), null);
  assert.equal(server.preferencePatches.length, 0, 'no PATCH');
  assert.equal(server.notificationPuts.length, 0, 'no PUT');
});

test('a notification save queued behind a PUT in flight is not sent once the session has ended', async () => {
  server.putDelayMs = 1000;
  const { result } = openSettings();
  await advance(200);

  act(() => {
    result.current.updateNotificationPreferences((current) => withEvent(current, 'stop', false));
  });
  await advance(600);
  assert.equal(server.notificationPuts.length, 1, 'the first PUT is on its way');
  act(() => {
    result.current.updateNotificationPreferences((current) => withEvent(current, 'stop', true));
  });
  // Past the debounce: the second save now waits for the first PUT.
  await advance(600);
  resetUserPreferences();
  await advance(3000);

  assert.equal(server.notificationPuts.length, 1);
});

test('a sort order picked while the preferences load is kept and saved after them', async () => {
  // Settings can open while the store's first read is still out. The save of a pick waits
  // behind that read, which used to drop it while the dialog went on showing it as saved.
  server.userPreferences = { projectSortOrder: 'name' };
  server.holdPreferencesRead = true;
  const hydrating = hydrateUserPreferences();
  const { result } = openSettings({ initialTab: 'appearance' });
  await advance(200);

  act(() => {
    result.current.updateProjectSortOrder('date');
  });
  await advance(1500);
  assert.equal(server.preferencePatches.length, 0, 'the save waits behind the read');

  server.releasePreferencesRead?.();
  await act(async () => {
    await hydrating;
  });
  await advance(1000);

  assert.equal(result.current.projectSortOrder, 'date');
  assert.equal(readUserPreference('projectSortOrder', null), 'date');
  assert.equal(server.userPreferences.projectSortOrder, 'date');
});
