import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useSettingsController } from '@/modules/settings/hooks/useSettingsController';
import { resetUserPreferences } from '@/shared/userSettings';

/**
 * The controller mirrors notificationPreferences.channels.sound into localStorage's
 * notificationSoundEnabled, which every chime reads. Its state used to start from a
 * hard-coded `sound: true`, so the mirror effect turned the sound back on the moment the
 * dialog opened, and kept it on whenever the server's preferences could not be read.
 */

/** localStorage key the chime helpers read; see isNotificationSoundEnabled in shared/utils. */
const SOUND_STORAGE_KEY = 'notificationSoundEnabled';

const notificationPreferencesApi = vi.hoisted(() => ({
  /** What GET /api/settings/notification-preferences answers in the current test. */
  respond: (): Promise<unknown> => Promise.resolve({ ok: false }),
  requests: 0,
}));

vi.mock('@/shared/api', () => {
  const ok = async () => new Response('{}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  return {
    api: {
      settings: {
        notificationPreferences: () => {
          notificationPreferencesApi.requests += 1;
          return notificationPreferencesApi.respond();
        },
        saveNotificationPreferences: () => Promise.resolve({ ok: true, json: async () => ({}) }),
      },
      user: {
        preferences: ok,
        savePreferences: ok,
      },
    },
  };
});

// Stable identities: the open effect depends on these functions, so fresh ones on
// every render would re-run it forever.
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

/** Opens the dialog's controller and waits until its notification preferences have loaded. */
const openSettings = async () => {
  const rendered = renderHook(() => useSettingsController({ isOpen: true, initialTab: 'notifications' }));
  await waitFor(() => {
    assert.equal(notificationPreferencesApi.requests, 1);
  });
  // Let the answer settle into state and the mirror effect run.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return rendered;
};

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
  notificationPreferencesApi.requests = 0;
  notificationPreferencesApi.respond = () => Promise.resolve({ ok: false });
});

afterEach(() => {
  resetUserPreferences();
});

test('opening settings keeps a sound the user switched off when the server cannot be read', async () => {
  localStorage.setItem(SOUND_STORAGE_KEY, 'false');

  const { result } = await openSettings();

  assert.equal(localStorage.getItem(SOUND_STORAGE_KEY), 'false');
  assert.equal(result.current.notificationPreferences.channels.sound, false);
});

test('opening settings keeps a sound the user switched off when the server omits it', async () => {
  localStorage.setItem(SOUND_STORAGE_KEY, 'false');
  notificationPreferencesApi.respond = () => Promise.resolve({
    ok: true,
    json: async () => ({ success: true, preferences: { channels: { webPush: false }, events: {} } }),
  });

  const { result } = await openSettings();

  assert.equal(localStorage.getItem(SOUND_STORAGE_KEY), 'false');
  assert.equal(result.current.notificationPreferences.channels.sound, false);
});

test('the server\'s sound preference still reaches localStorage', async () => {
  localStorage.setItem(SOUND_STORAGE_KEY, 'false');
  notificationPreferencesApi.respond = () => Promise.resolve({
    ok: true,
    json: async () => ({
      success: true,
      preferences: {
        channels: { inApp: true, webPush: false, desktop: false, sound: true },
        events: { actionRequired: true, stop: true, error: true },
      },
    }),
  });

  const { result } = await openSettings();

  assert.equal(result.current.notificationPreferences.channels.sound, true);
  assert.equal(localStorage.getItem(SOUND_STORAGE_KEY), 'true');
});

test('the sound stays on by default for a browser that never chose', async () => {
  const { result } = await openSettings();

  assert.equal(result.current.notificationPreferences.channels.sound, true);
  assert.notEqual(localStorage.getItem(SOUND_STORAGE_KEY), 'false');
});
