import { CODE_EDITOR_DEFAULTS } from '@/shared/constants';
import type { CodeEditorSettingsState } from '@/shared/types';
import { readUserPreference, writeUserPreference } from '@/shared/userSettings';

/**
 * The single reader and writer for the code-editor display settings.
 *
 * The settings dialog and the editor header's wrap toggle write them and the
 * code editor reads them, and each module used to decode the same keys with its
 * own helper — which had already drifted on the fontSize default. One reader,
 * one writer, one place to change a key.
 *
 * They are stored as one blob in `auth.db` now, so the editor looks the same on
 * every device the user opens it from.
 */

type StoredCodeEditorSettings = Partial<Record<keyof CodeEditorSettingsState, unknown>>;

// The server stores the blob without checking its shape, so anything but a
// plain object counts as nothing set rather than being spread into a write.
const readStoredSettings = (): StoredCodeEditorSettings => {
  const stored = readUserPreference<unknown>('codeEditorSettings', {});
  return typeof stored === 'object' && stored !== null && !Array.isArray(stored)
    ? (stored as StoredCodeEditorSettings)
    : {};
};

const readStoredBoolean = (stored: unknown, defaultValue: boolean): boolean => {
  if (typeof stored === 'boolean') {
    return stored;
  }
  // Values written before the move were the strings "true"/"false".
  if (typeof stored === 'string') {
    return stored !== 'false';
  }
  return defaultValue;
};

/**
 * Reading must never write: this runs when the settings dialog mounts, and a
 * write here would materialize defaults over settings the user never chose.
 *
 * `fontSize` stays a string. The settings dialog binds it to a select; the
 * editor turns it into a number.
 */
export const readCodeEditorSettings = (): CodeEditorSettingsState => {
  const stored = readStoredSettings();

  return {
    wordWrap: readStoredBoolean(stored.wordWrap, CODE_EDITOR_DEFAULTS.wordWrap),
    textWordWrap: readStoredBoolean(stored.textWordWrap, CODE_EDITOR_DEFAULTS.textWordWrap),
    showMinimap: readStoredBoolean(stored.showMinimap, CODE_EDITOR_DEFAULTS.showMinimap),
    lineNumbers: readStoredBoolean(stored.lineNumbers, CODE_EDITOR_DEFAULTS.lineNumbers),
    fontSize: typeof stored.fontSize === 'string' ? stored.fontSize : CODE_EDITOR_DEFAULTS.fontSize,
  };
};

/**
 * Merges the given settings into the stored blob. A key not passed keeps its
 * stored value, or stays absent and keeps following CODE_EDITOR_DEFAULTS, so a
 * later change to a default still reaches everyone who never chose that
 * setting.
 *
 * The merge only protects writers in the same tab, the settings dialog and the
 * editor header's wrap toggle, from writing back a stale copy of each other's
 * keys. Its base is this tab's copy, fetched from the server when the page
 * loaded or the user signed in, and the server replaces the whole blob on every
 * write. Across tabs and devices the last writer therefore still wins: a write
 * from this tab drops any key changed elsewhere since it loaded. The fix for
 * that belongs in the preference store and on the server, not here.
 *
 * The preference store notifies its subscribers synchronously, including in
 * the writing tab, so the editor re-reads without a separate same-tab event.
 * Called only from a user edit.
 */
export const writeCodeEditorSettings = (settings: Partial<CodeEditorSettingsState>) => {
  writeUserPreference('codeEditorSettings', { ...readStoredSettings(), ...settings });
};
