import { api } from '@/shared/api';
import { CODE_EDITOR_STORAGE_KEYS } from '@/shared/constants';

/**
 * The one reader and writer for the settings that used to live in browser
 * localStorage and now live in `auth.db`.
 *
 * The server is the source of truth — that is what makes a setting follow the
 * user from a laptop to a phone. localStorage keeps a mirror of the last known
 * server state purely so the very first paint is synchronous: without it the
 * app would flash the default light theme, the default language and a
 * collapsed sidebar on every load while the fetch was in flight.
 *
 * Reads are therefore synchronous against the mirror, and writes go to the
 * mirror immediately and to the server on a short debounce. The two object
 * preferences that several screens each change a part of, the code-editor
 * settings and the UI toggles, send only the fields that changed, and the
 * server merges them into its copy: a tab or device holding an older copy of
 * the other fields cannot write them back.
 */

/** Every setting the server stores for a user. */
export type UserPreferences = {
  theme: 'light' | 'dark';
  userLanguage: string;
  tasksEnabled: boolean;
  projectSortOrder: 'name' | 'date';
  claudePermissions: unknown;
  cursorPermissions: unknown;
  codexPermissions: unknown;
  opencodePermissions: unknown;
  agyPermissions: unknown;
  codeEditorSettings: unknown;
  uiPreferences: unknown;
  selectedProvider: string;
};

export type UserPreferenceKey = keyof UserPreferences;

/** The object preferences written field by field; every other key is written whole. */
type MergeableUserPreferenceKey = 'codeEditorSettings' | 'uiPreferences';

/**
 * One field of a field-level write. Scalars only, so a merge stays one level
 * deep on both ends; null removes the field.
 */
type PreferenceFieldValue = string | number | boolean | null;

/** Fired after any preference changes, from a local write or from a hydrate. */
export const USER_PREFERENCES_CHANGED_EVENT = 'user-preferences:changed';

/** The single localStorage blob mirroring the server's copy. */
const MIRROR_STORAGE_KEY = 'user-preferences';

/**
 * Long enough to collapse a burst of edits (dragging the font-size select,
 * toggling several switches) into one request, short enough that closing the
 * tab right after a change almost never loses it.
 */
const SERVER_WRITE_DEBOUNCE_MS = 400;

/** The first and the longest wait before a save that failed is sent again. */
const RETRY_DELAY_MIN_MS = 1_000;
const RETRY_DELAY_MAX_MS = 30_000;

/** How long one request may hang before it is abandoned; a save is then retried. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The localStorage keys each preference was read from before this module.
 *
 * Kept so an existing install does not lose its settings on upgrade: on the
 * first hydrate, any key the server has never seen is seeded from its legacy
 * location and pushed up. Removing an entry here silently resets that setting
 * for every user who has not opened the app since the migration.
 */
const LEGACY_STORAGE_KEYS: Record<UserPreferenceKey, string> = {
  theme: 'theme',
  userLanguage: 'userLanguage',
  tasksEnabled: 'tasks-enabled',
  projectSortOrder: 'claude-settings',
  claudePermissions: 'claude-settings',
  cursorPermissions: 'cursor-tools-settings',
  codexPermissions: 'codex-settings',
  opencodePermissions: 'opencode-settings',
  // Like OpenCode's, a key nothing has ever written: Antigravity arrived after
  // the move to auth.db, so there is no legacy value to migrate.
  agyPermissions: 'agy-settings',
  // Unused: the four code-editor settings never shared one key, so they are
  // read by readLegacyCodeEditorSettings instead.
  codeEditorSettings: '',
  uiPreferences: 'uiPreferences',
  selectedProvider: 'selected-provider',
};

const PREFERENCE_KEYS = Object.keys(LEGACY_STORAGE_KEYS) as UserPreferenceKey[];

type PreferenceRecord = Partial<Record<UserPreferenceKey, unknown>>;

/**
 * One unsent change to a key: its whole new value, or the fields to merge into
 * it. A whole value is `automatic` when the page wrote it on its own rather
 * than because the user chose it; a field change always comes from the user.
 */
type PreferenceChange =
  | { kind: 'set'; value: unknown; automatic: boolean }
  | { kind: 'merge'; patch: Record<string, PreferenceFieldValue> };

/** How a whole-value write came about. */
type PreferenceWriteOptions = {
  /**
   * The page wrote the value on its own, following its own state, and not
   * because the user chose it. One written before the server's copy arrives
   * may follow this device's start-up state, so the hydrate drops it.
   */
  automatic?: boolean;
};

type PreferenceChanges = Partial<Record<UserPreferenceKey, PreferenceChange>>;

/** What a save's answer means for the changes it carried. */
type SaveOutcome = 'saved' | 'retry' | 'dropped';

const listeners = new Set<() => void>();

// This tab's copy: the server's last answer with every local change since laid over it.
let preferences: PreferenceRecord = {};
// Changes waiting for the next save, one per key.
let pendingChanges: PreferenceChanges = {};
// The debounce, or after a failed save the backoff, before the next save.
let serverWriteTimer: ReturnType<typeof setTimeout> | null = null;
// The wait before the next retry; 0 until a save fails, and again once one goes through.
let retryDelayMs = 0;
let hasHydrated = false;
// Every request runs in turn on this chain, so only one save is ever in flight
// and a hydrate never interleaves with one.
let serverQueue: Promise<void> = Promise.resolve();
// Bumped on sign-out. A request started under an older value changes nothing
// when it returns, and a task queued under one never starts.
let generation = 0;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const changeEntries = (changes: PreferenceChanges) => (
  Object.entries(changes) as Array<[UserPreferenceKey, PreferenceChange]>
);

/**
 * Applies field changes one level deep: a null field is removed and any other
 * value replaces its field. The merge route applies the same rule on the
 * server. A value that is not an object counts as {}.
 */
function applyFieldPatch(target: unknown, patch: Record<string, PreferenceFieldValue>): Record<string, unknown> {
  const result: Record<string, unknown> = isRecord(target) ? { ...target } : {};
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[field];
    } else {
      result[field] = value;
    }
  }
  return result;
}

function applyChange(current: unknown, change: PreferenceChange): unknown {
  return change.kind === 'set' ? change.value : applyFieldPatch(current, change.patch);
}

/**
 * Folds a newer change to a key into the older one queued for it: a whole
 * value replaces anything older, fields merged into a whole value keep it a
 * whole value, and two sets of fields merge, the newer field winning. The
 * result is automatic only when the newer change is.
 */
function combineChanges(older: PreferenceChange | undefined, newer: PreferenceChange): PreferenceChange {
  if (!older || newer.kind === 'set') {
    return newer;
  }
  if (older.kind === 'set') {
    return { kind: 'set', value: applyFieldPatch(older.value, newer.patch), automatic: false };
  }
  return { kind: 'merge', patch: { ...older.patch, ...newer.patch } };
}

function combineAllChanges(older: PreferenceChanges, newer: PreferenceChanges): PreferenceChanges {
  const combined: PreferenceChanges = { ...older };
  for (const [key, change] of changeEntries(newer)) {
    combined[key] = combineChanges(combined[key], change);
  }
  return combined;
}

function readMirror(): PreferenceRecord {
  try {
    const raw = localStorage.getItem(MIRROR_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as PreferenceRecord) : {};
  } catch {
    return {};
  }
}

/**
 * Writes `keys` from this tab's copy into the mirror as it is now and leaves
 * its other keys alone, because another tab may have written them since this
 * one loaded. Without `keys` the whole copy is written, which only a hydrate
 * does: it has just adopted the server's copy of every key.
 */
function writeMirror(keys?: UserPreferenceKey[]): void {
  try {
    let next: PreferenceRecord = preferences;
    if (keys) {
      next = readMirror();
      for (const key of keys) {
        next[key] = preferences[key];
      }
    }
    localStorage.setItem(MIRROR_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A full or unavailable localStorage costs the first-paint optimization,
    // not the setting itself — the server copy is authoritative.
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(USER_PREFERENCES_CHANGED_EVENT));
  }
}

/**
 * Runs one request and gives up after REQUEST_TIMEOUT_MS. The signal aborts
 * the fetch, and the race settles even for a request that ignores it, so a
 * hung connection never stalls the chain every later request waits on.
 */
async function withRequestTimeout<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`No answer within ${REQUEST_TIMEOUT_MS / 1000} seconds`));
    }, REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([request(controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Queues a request behind every earlier one. The task is told the generation
 * it was queued under, so it can tell a sign-out that happened while it waited
 * on the network; a task whose generation is gone by its turn never starts.
 */
function enqueueServerTask(task: (startedIn: number) => Promise<void>): Promise<void> {
  const queuedIn = generation;
  const run = serverQueue.then(() => (queuedIn === generation ? task(queuedIn) : undefined));
  serverQueue = run.catch(() => undefined);
  return run;
}

function scheduleServerWrite(delayMs: number): void {
  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
  }
  serverWriteTimer = setTimeout(() => {
    serverWriteTimer = null;
    void enqueueServerTask(sendPendingChanges);
  }, delayMs);
}

/**
 * A 2xx saved the batch. Any other 4xx is an answer that will not change on a
 * resend: a body the server refuses (400, 413), or a signed-out session (401),
 * which signs this page out and clears the queue anyway. 408, 429 and 5xx ask
 * to try again later.
 */
function readSaveOutcome(response: Response): SaveOutcome {
  if (response.ok) {
    return 'saved';
  }
  const { status } = response;
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    console.error(`The server refused a user preferences save (HTTP ${status}); it is not retried.`);
    return 'dropped';
  }
  console.error(`Failed to save user preferences (HTTP ${status}); retrying.`);
  return 'retry';
}

/**
 * Sends one batch. A batch with a field change goes to the merge route; one of
 * whole values only goes to PATCH /preferences, as every save did before, so
 * the scalar settings and the permissions do not depend on the newer route.
 * `startedIn` is the generation the batch was taken in.
 */
async function sendChanges(changes: PreferenceChanges, startedIn: number): Promise<SaveOutcome> {
  const set: Record<string, unknown> = {};
  const merge: Record<string, Record<string, PreferenceFieldValue>> = {};
  for (const [key, change] of changeEntries(changes)) {
    if (change.kind === 'set') {
      set[key] = change.value;
    } else {
      merge[key] = change.patch;
    }
  }

  if (Object.keys(merge).length > 0) {
    const response = await withRequestTimeout((signal) => api.user.patchPreferences({ set, merge }, { signal }));
    if (response.status !== 404) {
      return readSaveOutcome(response);
    }
    // Signed out while the merge request was out: the batch belonged to that
    // session, and the fallback would send the next session's copy under
    // whatever credentials the page holds by now.
    if (startedIn !== generation) {
      return 'dropped';
    }
    // A server older than the merge route, which a rollback leaves behind an
    // open page. Sent as a whole value, a field change would erase every field
    // it does not name, so this batch carries this tab's whole copy of those
    // keys instead and the last writer wins, as before the route existed. The
    // 404 is not remembered: the next batch tries the merge route again, so a
    // redeploy is picked up without a reload.
    for (const key of Object.keys(merge) as UserPreferenceKey[]) {
      set[key] = preferences[key];
    }
  }
  return readSaveOutcome(await withRequestTimeout((signal) => api.user.savePreferences(set, { signal })));
}

async function sendPendingChanges(startedIn: number): Promise<void> {
  const sending = pendingChanges;
  if (Object.keys(sending).length === 0) {
    return;
  }
  pendingChanges = {};

  let outcome: SaveOutcome;
  try {
    outcome = await sendChanges(sending, startedIn);
  } catch (error) {
    // Offline, a dropped connection or a request that hung. Never an unhandled
    // rejection out of a timer callback: the batch is retried below.
    if (startedIn === generation) {
      console.error('Failed to save user preferences:', error);
    }
    outcome = 'retry';
  }

  // Signed out while the request was out: the batch belonged to that session.
  if (startedIn !== generation) {
    return;
  }

  if (outcome === 'retry') {
    // Back under anything changed meanwhile, which is newer and so wins.
    pendingChanges = combineAllChanges(sending, pendingChanges);
    retryDelayMs = Math.min(Math.max(retryDelayMs * 2, RETRY_DELAY_MIN_MS), RETRY_DELAY_MAX_MS);
    scheduleServerWrite(retryDelayMs);
    return;
  }

  retryDelayMs = 0;
  // Anything changed meanwhile already has its own timer, or a task queued
  // behind this one, from queueServerChange.
}

function queueServerChange(key: UserPreferenceKey, change: PreferenceChange): void {
  pendingChanges = { ...pendingChanges, [key]: combineChanges(pendingChanges[key], change) };
  // A new edit is also the moment to retry a save that failed, rather than
  // waiting out the rest of its backoff.
  scheduleServerWrite(SERVER_WRITE_DEBOUNCE_MS);
}

/**
 * Reads one preference, or `fallback` when the user has never set it.
 *
 * Synchronous by design: callers include module-level initializers and
 * `useState` initial values that run before any fetch could resolve.
 */
export function readUserPreference<T>(key: UserPreferenceKey, fallback: T): T {
  const value = preferences[key];
  return value === undefined || value === null ? fallback : (value as T);
}

/**
 * Writes one preference through to the mirror, the listeners and the server.
 * A write the page makes on its own passes `automatic` (see
 * PreferenceWriteOptions); anything else counts as the user's choice.
 */
export function writeUserPreference(
  key: UserPreferenceKey,
  value: unknown,
  { automatic = false }: PreferenceWriteOptions = {},
): void {
  if (JSON.stringify(preferences[key]) === JSON.stringify(value)) {
    return;
  }

  preferences = { ...preferences, [key]: value };
  writeMirror([key]);
  queueServerChange(key, { kind: 'set', value, automatic });
  notifyListeners();
}

/**
 * Changes some fields of an object preference and sends only those fields,
 * which the server merges into its copy: a page holding an older copy of the
 * other fields cannot write them back, as a whole-value write would. A null
 * field removes it and an undefined one is ignored. Used by
 * codeEditorSettings.ts for the editor settings and by UiPreferencesContext for
 * the UI toggles; callers pass only the fields the user changed.
 */
export function patchUserPreference(
  key: MergeableUserPreferenceKey,
  fields: Readonly<Record<string, PreferenceFieldValue | undefined>>,
): void {
  const patch: Record<string, PreferenceFieldValue> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (value !== undefined) {
      patch[field] = value;
    }
  }
  // Nothing to change; writing would only store {} for a key never set.
  if (Object.keys(patch).length === 0) {
    return;
  }

  const next = applyFieldPatch(preferences[key], patch);
  if (JSON.stringify(preferences[key]) === JSON.stringify(next)) {
    return;
  }

  preferences = { ...preferences, [key]: next };
  writeMirror([key]);
  queueServerChange(key, { kind: 'merge', patch });
  notifyListeners();
}

/** Writes several preferences the user chose as one change, so listeners re-render once. */
export function writeUserPreferences(updates: PreferenceRecord): void {
  const changed: PreferenceRecord = {};
  for (const [key, value] of Object.entries(updates) as Array<[UserPreferenceKey, unknown]>) {
    if (JSON.stringify(preferences[key]) !== JSON.stringify(value)) {
      changed[key] = value;
    }
  }

  if (Object.keys(changed).length === 0) {
    return;
  }

  preferences = { ...preferences, ...changed };
  const changedKeys = Object.keys(changed) as UserPreferenceKey[];
  writeMirror(changedKeys);
  for (const key of changedKeys) {
    queueServerChange(key, { kind: 'set', value: changed[key], automatic: false });
  }
  notifyListeners();
}

/** Subscribes to any preference change; returns the unsubscribe function. */
export function subscribeToUserPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Reads what a preference was stored under before this module existed.
 *
 * `claude-settings` held four settings in one blob, so `projectSortOrder` and
 * `claudePermissions` are pulled out of it separately.
 */
function readLegacyPreference(key: UserPreferenceKey): unknown {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_STORAGE_KEYS[key]);
  } catch {
    return undefined;
  }

  if (raw === null) {
    return undefined;
  }

  if (key === 'theme' || key === 'userLanguage' || key === 'selectedProvider') {
    return raw;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (key === 'projectSortOrder') {
    return isRecord(parsed) ? parsed.projectSortOrder : undefined;
  }

  if (key === 'claudePermissions') {
    if (!isRecord(parsed)) {
      return undefined;
    }
    // The sort order rides along in the same legacy blob but is its own
    // preference now, so it is deliberately not copied into the permissions.
    const { allowedTools, disallowedTools, skipPermissions } = parsed;
    return { allowedTools, disallowedTools, skipPermissions };
  }

  return parsed;
}

/**
 * Reads the four code-editor settings, which never shared a single key.
 *
 * They were stored as four separate strings, so unlike every other legacy
 * value there is nothing to `JSON.parse` — hence the dedicated reader.
 */
function readLegacyCodeEditorSettings(): unknown {
  try {
    const wordWrap = localStorage.getItem(CODE_EDITOR_STORAGE_KEYS.wordWrap);
    const showMinimap = localStorage.getItem(CODE_EDITOR_STORAGE_KEYS.showMinimap);
    const lineNumbers = localStorage.getItem(CODE_EDITOR_STORAGE_KEYS.lineNumbers);
    const fontSize = localStorage.getItem(CODE_EDITOR_STORAGE_KEYS.fontSize);

    if (wordWrap === null && showMinimap === null && lineNumbers === null && fontSize === null) {
      return undefined;
    }

    const settings: Record<string, unknown> = {};
    if (wordWrap !== null) settings.wordWrap = wordWrap !== 'false';
    if (showMinimap !== null) settings.showMinimap = showMinimap !== 'false';
    if (lineNumbers !== null) settings.lineNumbers = lineNumbers !== 'false';
    if (fontSize !== null) settings.fontSize = fontSize;
    return settings;
  } catch {
    return undefined;
  }
}

/**
 * Loads the server's copy and adopts it as the source of truth.
 *
 * Called once the user is authenticated. Any key the server has never seen is
 * seeded from wherever it used to live in localStorage and pushed up, so the
 * settings an existing install already had survive the move. Runs on the same
 * chain as the saves, so it never interleaves with one.
 */
export function hydrateUserPreferences(): Promise<void> {
  return enqueueServerTask(loadServerPreferences);
}

async function loadServerPreferences(startedIn: number): Promise<void> {
  let serverPreferences: PreferenceRecord;

  try {
    serverPreferences = await withRequestTimeout(async (signal) => {
      const response = await api.user.preferences({ signal });
      if (!response.ok) {
        throw new Error(`The server answered ${response.status}`);
      }
      const payload = (await response.json()) as { preferences?: unknown } | null;
      if (!isRecord(payload?.preferences)) {
        throw new Error('The answer carried no preferences object');
      }
      return payload.preferences as PreferenceRecord;
    });
  } catch (error) {
    // Keep whatever the mirror holds: an offline load must still render the
    // user's own theme and language rather than snapping back to defaults.
    // Nothing is migrated either. A failed read is not an empty server, and
    // treating one as empty pushed long-replaced legacy values over the
    // user's real settings.
    if (startedIn === generation) {
      console.error('Failed to load user preferences:', error);
    }
    return;
  }

  // Signed out while the request was out: this answer is the previous user's.
  if (startedIn !== generation) {
    return;
  }

  const migrated: PreferenceRecord = {};
  for (const key of PREFERENCE_KEYS) {
    if (serverPreferences[key] !== undefined) {
      continue;
    }

    const legacyValue = key === 'codeEditorSettings'
      ? readLegacyCodeEditorSettings()
      : readLegacyPreference(key);

    if (legacyValue !== undefined) {
      migrated[key] = legacyValue;
    }
  }

  // A whole value the page wrote on its own, still queued for a key the server
  // just answered for, followed pre-hydrate state and is now stale. Letting it
  // flush would push this device's start-up value over the one just fetched —
  // the exact shape of a preference silently resetting itself on a second
  // device. What the user chose before the answer came stays, whole values and
  // field changes alike, and is sent after this read: it is newer than the
  // copy the read returned.
  const keptChanges: PreferenceChanges = {};
  for (const [key, change] of changeEntries(pendingChanges)) {
    if (change.kind === 'merge' || !change.automatic || serverPreferences[key] === undefined) {
      keptChanges[key] = change;
    }
  }

  // A migrated value goes under whatever is still queued for its key: a
  // choice made before the hydrate is newer than the old storage. The value
  // itself is the old storage's, not a choice, so it counts as automatic.
  const migratedChanges: PreferenceChanges = {};
  for (const [key, value] of Object.entries(migrated) as Array<[UserPreferenceKey, unknown]>) {
    migratedChanges[key] = { kind: 'set', value, automatic: true };
  }
  pendingChanges = combineAllChanges(migratedChanges, keptChanges);

  const adopted: PreferenceRecord = { ...serverPreferences, ...migrated };
  for (const [key, change] of changeEntries(pendingChanges)) {
    adopted[key] = applyChange(adopted[key], change);
  }
  preferences = adopted;
  hasHydrated = true;
  writeMirror();

  if (Object.keys(migrated).length > 0) {
    scheduleServerWrite(SERVER_WRITE_DEBOUNCE_MS);
  }

  notifyListeners();
}

/** True once the server's copy has been read at least one time this session. */
export function hasHydratedUserPreferences(): boolean {
  return hasHydrated;
}

/**
 * Names the current session; every sign-out changes it. The Settings dialog
 * holds its edits back for a moment before writing them, and compares this
 * first, so an edit made in a session that has since ended is not written into
 * the next one.
 */
export function getUserPreferencesSession(): number {
  return generation;
}

/**
 * Drops the in-memory and mirrored copies on sign-out, so the next user on
 * this device does not start out looking at the previous user's settings.
 */
export function resetUserPreferences(): void {
  // Any request still out, and any task still queued, now belongs to the
  // previous session and changes nothing when it returns.
  generation += 1;
  preferences = {};
  pendingChanges = {};
  retryDelayMs = 0;
  hasHydrated = false;
  // A fresh chain, so the next session's hydrate does not wait behind a
  // request of this one that is still out.
  serverQueue = Promise.resolve();
  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
    serverWriteTimer = null;
  }
  try {
    localStorage.removeItem(MIRROR_STORAGE_KEY);
  } catch {
    // Nothing to do: the in-memory copy is already cleared.
  }
  notifyListeners();
}

// The mirror is read at module load rather than on first use because the theme
// and language readers run during module initialization, before any component
// has mounted.
if (typeof localStorage !== 'undefined') {
  preferences = readMirror();
}
