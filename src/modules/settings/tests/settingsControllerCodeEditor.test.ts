import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { CodeEditorSettingsState } from '@/shared/types';

/**
 * The regression was in useSettingsController itself: an effect keyed on the
 * settings object wrote all four codeEditor* values, and it ran on mount.
 * Opening the dialog on any tab therefore materialized the settings module's
 * own defaults over the editor's, changing the font size of anyone who had
 * never set one. Testing the storage helpers alone cannot catch that, so this
 * drives the hook.
 *
 * The four values are one server-backed `codeEditorSettings` preference now, so
 * a stray write is worse than it was: it would follow the user to every device.
 */

vi.mock('@/shared/api', () => {
  const ok = async () => new Response('{}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  return {
    api: {
      settings: {
        notificationPreferences: () => Promise.resolve({ ok: false }),
        saveNotificationPreferences: () => Promise.resolve({ ok: true, json: async () => ({}) }),
      },
      user: {
        preferences: async () => new Response(JSON.stringify({ preferences: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
        savePreferences: ok,
        patchPreferences: ok,
        drafts: ok,
        saveDraft: ok,
        deleteDraft: ok,
      },
    },
  };
});

// These mocks must return stable identities: the hook's open-effect depends on
// the functions they expose, so fresh ones each render would re-run it forever.
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

// The appearance tab's other sections, kept out of the way of its wrap rows.
vi.mock('@/modules/i18n', () => ({ LanguageSelector: () => null }));
vi.mock('@/shared/context/UiPreferencesContext', () => ({
  useUiPreferences: () => ({ keepProjectsExpanded: false }),
  useSetUiPreference: () => () => undefined,
}));

/** The single localStorage blob the preference store mirrors the server into. */
const MIRROR_STORAGE_KEY = 'user-preferences';

/**
 * Seeds the store the way a returning user's browser already holds it: the
 * mirror is read once, when the module loads, so this has to happen before the
 * controller is imported.
 */
const seedPreferences = (preferences: Record<string, unknown>) => {
  localStorage.setItem(MIRROR_STORAGE_KEY, JSON.stringify(preferences));
};

const storedCodeEditorSettings = (): Record<string, unknown> | undefined => {
  const raw = localStorage.getItem(MIRROR_STORAGE_KEY);
  if (raw === null) {
    return undefined;
  }

  return (JSON.parse(raw) as { codeEditorSettings?: Record<string, unknown> }).codeEditorSettings;
};

/**
 * Pulled from the same dynamic import as the controller: `vi.resetModules()`
 * gives each test its own module graph, so a statically imported copy of the
 * store would be a different instance from the one the hook writes to.
 */
const loadPreferenceStore = () => import('@/shared/userSettings');

const renderSettings = async () => {
  const { useSettingsController } = await import(
    '@/modules/settings/hooks/useSettingsController'
  );
  return renderHook(() => useSettingsController({ isOpen: true, initialTab: 'appearance' }));
};

beforeEach(() => {
  // A fresh module graph per test, so the seeded mirror above is what the
  // preference store picks up when the controller pulls it in.
  vi.resetModules();
  localStorage.clear();
});

afterEach(() => {
  vi.resetModules();
});

test('opening settings writes no code-editor preference for a user who never set one', async () => {
  const { result } = await renderSettings();

  await waitFor(() => {
    assert.ok(result.current.codeEditorSettings);
  });

  assert.equal(
    storedCodeEditorSettings(),
    undefined,
    'merely opening the dialog must not materialize code-editor defaults',
  );
});

test('opening settings does not change a font size the user already chose', async () => {
  seedPreferences({ codeEditorSettings: { fontSize: '16' } });

  const { result } = await renderSettings();
  await waitFor(() => {
    assert.equal(result.current.codeEditorSettings.fontSize, '16');
  });

  assert.deepEqual(
    storedCodeEditorSettings(),
    { fontSize: '16' },
    'opening the dialog must not rewrite the stored settings',
  );
});

test('changing a setting stores only that key and notifies the editor once', async () => {
  const { result } = await renderSettings();
  await waitFor(() => {
    assert.ok(result.current.updateCodeEditorSetting);
  });

  // The editor is woken by the preference store, which notifies synchronously
  // in the writing tab too — that is what replaced the same-tab
  // `codeEditorSettingsChanged` event this used to count.
  const { subscribeToUserPreferences } = await loadPreferenceStore();
  let notifications = 0;
  const unsubscribe = subscribeToUserPreferences(() => {
    notifications += 1;
  });

  act(() => {
    result.current.updateCodeEditorSetting('fontSize', '18');
  });

  unsubscribe();

  // The keys the user never touched stay unset, so they keep following their
  // defaults instead of freezing today's defaults into stored values.
  assert.deepEqual(
    storedCodeEditorSettings(),
    { fontSize: '18' },
    'only the changed key is written',
  );
  assert.equal(notifications, 1);
  assert.equal(result.current.codeEditorSettings.fontSize, '18');
});

test('a second change keeps the earlier one', async () => {
  const { result } = await renderSettings();
  await waitFor(() => {
    assert.ok(result.current.updateCodeEditorSetting);
  });

  act(() => {
    result.current.updateCodeEditorSetting('fontSize', '18');
  });
  act(() => {
    result.current.updateCodeEditorSetting('wordWrap', true);
  });

  assert.equal(storedCodeEditorSettings()?.fontSize, '18');
  assert.equal(storedCodeEditorSettings()?.wordWrap, true);
});

test('two edits in one batch both survive', async () => {
  // The merge base is the preference store, not the rendered state, so the
  // second call in a batch cannot write a pre-first-edit snapshot back over the
  // first.
  const { result } = await renderSettings();

  act(() => {
    result.current.updateCodeEditorSetting('fontSize', '20');
    result.current.updateCodeEditorSetting('wordWrap', true);
  });

  await waitFor(() => {
    assert.equal(storedCodeEditorSettings()?.fontSize, '20');
  });
  assert.equal(storedCodeEditorSettings()?.wordWrap, true);
  assert.equal(result.current.codeEditorSettings.fontSize, '20');
  assert.equal(result.current.codeEditorSettings.wordWrap, true);
});

test('the text-file wrap setting is stored and shown like the others', async () => {
  const { result } = await renderSettings();
  await waitFor(() => {
    assert.equal(result.current.codeEditorSettings.textWordWrap, true);
  });

  act(() => {
    result.current.updateCodeEditorSetting('textWordWrap', false);
  });

  assert.deepEqual(storedCodeEditorSettings(), { textWordWrap: false });
  assert.equal(result.current.codeEditorSettings.textWordWrap, false);
});

test('a dialog edit keeps a wrap setting written elsewhere since the dialog opened', async () => {
  // The editor header's wrap toggle writes through the same helper. The dialog
  // merges its own key into the newest stored value rather than writing its
  // rendered snapshot back, and shows the stored result.
  const { result } = await renderSettings();
  await waitFor(() => {
    assert.ok(result.current.updateCodeEditorSetting);
  });
  const { writeCodeEditorSettings } = await import('@/shared/codeEditorSettings');

  act(() => {
    writeCodeEditorSettings({ textWordWrap: false });
  });
  act(() => {
    result.current.updateCodeEditorSetting('fontSize', '18');
  });

  assert.deepEqual(storedCodeEditorSettings(), { textWordWrap: false, fontSize: '18' });
  assert.equal(result.current.codeEditorSettings.textWordWrap, false);
});

test('the appearance tab binds the text-file and code-file wrap rows to their own settings', async () => {
  const { default: AppearanceSettingsTab } = await import('@/modules/settings/tabs/AppearanceSettingsTab');
  const codeEditorSettings: CodeEditorSettingsState = {
    wordWrap: false,
    textWordWrap: true,
    showMinimap: true,
    lineNumbers: true,
    fontSize: '12',
  };
  const onTextWordWrapChange = vi.fn();
  const onWordWrapChange = vi.fn();

  render(createElement(AppearanceSettingsTab, {
    projectSortOrder: 'name',
    onProjectSortOrderChange: () => undefined,
    codeEditorSettings,
    onCodeEditorTextWordWrapChange: onTextWordWrapChange,
    onCodeEditorWordWrapChange: onWordWrapChange,
    onCodeEditorShowMinimapChange: () => undefined,
    onCodeEditorLineNumbersChange: () => undefined,
    onCodeEditorFontSizeChange: () => undefined,
  }));

  // No i18n instance is initialised here, so the labels are their English defaults.
  const textRow = screen.getByRole('switch', { name: 'Word Wrap in Markdown and Text Files' });
  const codeRow = screen.getByRole('switch', { name: 'Word Wrap in Code Files' });
  assert.equal(textRow.getAttribute('aria-checked'), 'true');
  assert.equal(codeRow.getAttribute('aria-checked'), 'false');

  fireEvent.click(textRow);
  fireEvent.click(codeRow);

  assert.deepEqual(onTextWordWrapChange.mock.calls, [[false]]);
  assert.deepEqual(onWordWrapChange.mock.calls, [[true]]);
});
