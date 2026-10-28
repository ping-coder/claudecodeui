import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import Settings from '@/modules/settings/Settings';
import { resetUserPreferences } from '@/shared/userSettings';
import type { NotificationPreferencesState } from '@/shared/types';

/**
 * Settings hands each tab the controller's saving handlers. A tab wired to a plain state
 * setter would show the change and never save it, which the controller's own tests cannot
 * see, so this drives the dialog itself.
 */

const server = vi.hoisted(() => ({
  stored: null as unknown,
  getOk: true,
  notificationPuts: [] as unknown[],
  preferencePatches: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/shared/api', () => ({
  api: {
    settings: {
      notificationPreferences: () => new Promise((resolve) => {
        setTimeout(() => {
          resolve(server.getOk
            ? { ok: true, json: async () => ({ success: true, preferences: server.stored }) }
            : { ok: false, json: async () => ({}) });
        }, 20);
      }),
      saveNotificationPreferences: (preferences: unknown) => {
        server.notificationPuts.push(preferences);
        server.stored = preferences;
        return Promise.resolve({ ok: true, json: async () => ({ success: true, preferences }) });
      },
    },
    user: {
      preferences: () => Promise.resolve({ ok: true, json: async () => ({ preferences: {} }) }),
      savePreferences: (updates: Record<string, unknown>) => {
        server.preferencePatches.push(updates);
        return Promise.resolve({ ok: true, json: async () => ({}) });
      },
    },
  },
}));

vi.mock('@/shared/context/ThemeContext', () => {
  const theme = { isDarkMode: false, toggleDarkMode: () => undefined, themeMode: 'light', setThemeMode: () => undefined };
  return { useTheme: () => theme };
});

vi.mock('@/modules/provider-auth', () => {
  const authStatus = {
    providerAuthStatus: {},
    checkProviderAuthStatus: () => Promise.resolve({ authenticated: false }),
    refreshProviderAuthStatuses: () => Promise.resolve(),
  };
  return { useProviderAuthStatus: () => authStatus, ProviderLoginModal: () => null };
});

vi.mock('@/modules/plugins', () => ({ PluginSettingsTab: () => null }));
// Pulls in the terminal (xterm), which jsdom cannot draw; the tasks tab is not rendered here.
vi.mock('@/modules/task-master', () => ({ useTasksSettings: () => ({}) }));
vi.mock('@/modules/i18n', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  LanguageSelector: () => null,
}));
// Subscribing waits on the browser's permission prompt; the test decides when it answers.
const push = vi.hoisted(() => ({ finishSubscribe: () => undefined as void }));
vi.mock('@/modules/settings/hooks/useWebPush', () => ({
  useWebPush: () => ({
    permission: 'default',
    isSubscribed: false,
    isLoading: false,
    subscribe: () => new Promise<void>((resolve) => {
      push.finishSubscribe = resolve;
    }),
    unsubscribe: () => Promise.resolve(),
    requestPermission: () => Promise.resolve('default'),
  }),
}));

vi.mock('@/shared/context/UiPreferencesContext', () => ({
  useUiPreferences: () => ({ keepProjectsExpanded: false, runAlertBanner: true, runAlertSystemNotification: false }),
  useSetUiPreference: () => () => undefined,
}));

const STORED: NotificationPreferencesState = {
  channels: { inApp: false, webPush: false, desktop: false, sound: true },
  events: { actionRequired: true, stop: true, error: true },
};

const SAVED_MESSAGE = 'Settings saved successfully!';

const advance = async (totalMs: number, stepMs = 25) => {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(stepMs);
    });
  }
};

const openSettings = (initialTab: string) => render(
  <Settings isOpen onClose={() => undefined} initialTab={initialTab} />,
);

const runStopped = () => screen.getByRole('checkbox', { name: 'Run stopped' }) as HTMLInputElement;
const hasSavedMessage = () => screen.queryByText(SAVED_MESSAGE) !== null;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetUserPreferences();
  server.stored = structuredClone(STORED);
  server.getOk = true;
  server.notificationPuts = [];
  server.preferencePatches = [];
});

afterEach(() => {
  resetUserPreferences();
  vi.useRealTimers();
});

test('opening the notifications tab and changing nothing saves nothing and shows no message', async () => {
  openSettings('notifications');
  assert.equal(runStopped().disabled, true, 'disabled until the server answers');

  await advance(100);
  assert.equal(runStopped().disabled, false);
  let sawSavedMessage = false;
  for (let elapsed = 0; elapsed < 3000; elapsed += 100) {
    await advance(100);
    sawSavedMessage ||= hasSavedMessage();
  }

  assert.equal(sawSavedMessage, false);
  assert.equal(server.notificationPuts.length, 0);
  assert.equal(server.preferencePatches.length, 0);
});

test('a notification event switch is saved through the dialog and the message shows', async () => {
  openSettings('notifications');
  await advance(100);

  fireEvent.click(runStopped());
  await advance(600);

  assert.deepEqual(server.notificationPuts, [{ ...STORED, events: { ...STORED.events, stop: false } }]);
  assert.equal(hasSavedMessage(), true);
});

test('a failed read leaves the switches disabled and explains why', async () => {
  server.getOk = false;
  openSettings('notifications');
  await advance(100);

  assert.equal(runStopped().disabled, true);
  assert.equal(screen.queryByText("Couldn't load your notification settings. Close Settings and open it again to retry.") !== null, true);
});

test('the project sort order is saved through the dialog', async () => {
  openSettings('appearance');
  await advance(100);

  fireEvent.change(screen.getByDisplayValue('Alphabetical'), { target: { value: 'date' } });
  await advance(1000);

  assert.deepEqual(server.preferencePatches, [{ projectSortOrder: 'date' }]);
});

test('enabling push keeps an event switch flipped while the browser was asking', async () => {
  openSettings('notifications');
  await advance(100);

  fireEvent.click(screen.getByRole('button', { name: 'Enable notifications' }));
  fireEvent.click(runStopped());
  await advance(600);
  await act(async () => {
    push.finishSubscribe();
  });
  await advance(600);

  assert.equal(runStopped().checked, false, 'the switch stays where the user put it');
  assert.deepEqual(server.notificationPuts.at(-1), {
    channels: { ...STORED.channels, webPush: true },
    events: { ...STORED.events, stop: false },
  });
});
