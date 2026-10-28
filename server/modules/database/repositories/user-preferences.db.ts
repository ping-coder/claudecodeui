import { getConnection } from '@/modules/database/connection.js';

type PreferenceRow = {
  preference_key: string;
  preference_value: string;
};

/**
 * Decodes one stored preference, dropping any row whose JSON no longer parses
 * rather than failing the whole read. A single corrupted value must not cost
 * the user every other setting they have.
 */
function decodePreference(row: PreferenceRow): [string, unknown] | null {
  try {
    return [row.preference_key, JSON.parse(row.preference_value) as unknown];
  } catch {
    console.warn(`[UserPreferences] Dropping unreadable value for "${row.preference_key}"`);
    return null;
  }
}

/** Reads a stored value as a merge base: one that is not a plain object, or does not parse, counts as {}. */
function readStoredObject(storedValue: string | undefined): Record<string, unknown> {
  if (storedValue === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(storedValue);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Applies one level of field changes: a null field is removed, any other value
 * replaces that field. Nested objects are replaced, not merged, which is the
 * same rule the client applies to its own copy.
 */
function applyFieldPatch(
  stored: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...stored };
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[field];
    } else {
      merged[field] = value;
    }
  }
  return merged;
}

export const userPreferencesDb = {
  /**
   * Returns every preference the user has ever set, as one object.
   *
   * The client fetches this once on start-up, so absent keys simply mean "the
   * user never changed this" and the client applies its own default.
   */
  getPreferences(userId: number): Record<string, unknown> {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT preference_key, preference_value
         FROM user_preferences
         WHERE user_id = ?`
      )
      .all(userId) as PreferenceRow[];

    const preferences: Record<string, unknown> = {};
    for (const row of rows) {
      const decoded = decodePreference(row);
      if (decoded) {
        preferences[decoded[0]] = decoded[1];
      }
    }

    return preferences;
  },

  /**
   * Replaces the whole stored value of every key in `updates`. Keys absent are
   * left alone, and a key given as `undefined` is deleted. An object
   * preference is replaced as a whole, so a write from a page holding an older
   * copy puts that copy's other fields back; patchPreferences merges instead.
   *
   * Runs in one transaction so a multi-key save from the settings dialog can
   * never be observed half-applied.
   */
  savePreferences(userId: number, updates: Record<string, unknown>): void {
    const db = getConnection();
    const upsert = db.prepare(
      `INSERT INTO user_preferences (user_id, preference_key, preference_value, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, preference_key) DO UPDATE SET
         preference_value = excluded.preference_value,
         updated_at = CURRENT_TIMESTAMP`
    );
    const remove = db.prepare(
      'DELETE FROM user_preferences WHERE user_id = ? AND preference_key = ?'
    );

    db.transaction(() => {
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined) {
          remove.run(userId, key);
          continue;
        }
        upsert.run(userId, key, JSON.stringify(value));
      }
    })();
  },

  /**
   * Saves one batch from PATCH /api/user/preferences/merge.
   *
   * `set` keys are written as savePreferences writes them. Each `merge` key is
   * read, has the given fields applied one level deep (a null field removes
   * it, a stored value that is not an object counts as {}), and is written
   * back. Fields the patch does not name keep their stored values, so a page
   * that changed one field cannot put back another page's older copy of the
   * rest. A key in both groups gets its `set` value first, then the patch.
   *
   * One transaction: nothing is written when any key fails, and no other
   * writer to the database can land between a read and its write.
   */
  patchPreferences(
    userId: number,
    set: Record<string, unknown>,
    merge: Record<string, Record<string, unknown>>,
  ): void {
    const db = getConnection();
    const read = db.prepare(
      `SELECT preference_value
       FROM user_preferences
       WHERE user_id = ? AND preference_key = ?`
    );
    const upsert = db.prepare(
      `INSERT INTO user_preferences (user_id, preference_key, preference_value, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, preference_key) DO UPDATE SET
         preference_value = excluded.preference_value,
         updated_at = CURRENT_TIMESTAMP`
    );
    const remove = db.prepare(
      'DELETE FROM user_preferences WHERE user_id = ? AND preference_key = ?'
    );

    db.transaction(() => {
      for (const [key, value] of Object.entries(set)) {
        if (value === undefined) {
          remove.run(userId, key);
          continue;
        }
        upsert.run(userId, key, JSON.stringify(value));
      }
      for (const [key, patch] of Object.entries(merge)) {
        const row = read.get(userId, key) as { preference_value: string } | undefined;
        const merged = applyFieldPatch(readStoredObject(row?.preference_value), patch);
        upsert.run(userId, key, JSON.stringify(merged));
      }
    })();
  },
};
