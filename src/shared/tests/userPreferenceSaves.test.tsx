import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * Preference saves from several tabs and devices. A page keeps the copy it
 * loaded, so a write that sent that whole copy put back every field changed
 * elsewhere since. The two object preferences now send only the fields that
 * changed, and saves that fail are kept and sent again.
 *
 * The fake server applies both routes' real semantics: PATCH /preferences
 * replaces each key whole, PATCH /preferences/merge replaces its `set` keys
 * and merges its `merge` keys field by field (a null field is removed). Each
 * route answers from a script, in order: a status, 'offline' (a network
 * error), 'hang' (no answer until the request is aborted) or 'hold' (no answer
 * until the test releases it with a status). Unscripted requests get a 200.
 *
 * Each test loads fresh module copies: the store reads its localStorage mirror
 * once, when it loads.
 */

type Route = 'get' | 'save' | 'merge';
type Step = number | 'offline' | 'hang' | 'hold';
type MergeBody = { set: Record<string, unknown>; merge: Record<string, Record<string, unknown>> };
type RequestOptions = { signal?: AbortSignal };

const server = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  script: { get: [], save: [], merge: [] } as Record<Route, Step[]>,
  /** Every request, in the order it was made. */
  attempts: [] as Route[],
  /** The bodies of the saves that were answered with a 2xx. */
  accepted: [] as Array<{ route: Route; body: unknown }>,
  aborted: 0,
  /** Answers the request held by a 'hold' step. */
  release: null as null | ((status: number) => void),
}));

vi.mock('@/shared/api', () => {
  const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  const mergeFields = (stored: unknown, patch: Record<string, unknown>) => {
    const merged: Record<string, unknown> = stored && typeof stored === 'object' && !Array.isArray(stored)
      ? { ...(stored as Record<string, unknown>) }
      : {};
    for (const [field, value] of Object.entries(patch)) {
      if (value === null) {
        delete merged[field];
      } else {
        merged[field] = value;
      }
    }
    return merged;
  };

  const answer = async (
    route: Route,
    options: RequestOptions | undefined,
    readBody: () => unknown,
    apply: () => void,
  ): Promise<Response> => {
    server.attempts.push(route);
    const step = server.script[route].shift() ?? 200;
    if (step === 'offline') {
      throw new TypeError('Failed to fetch');
    }
    if (step === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          server.aborted += 1;
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    }
    const status = step === 'hold'
      ? await new Promise<number>((resolve) => {
        server.release = resolve;
      })
      : step;
    if (status >= 200 && status < 300) {
      apply();
    }
    return new Response(JSON.stringify(readBody()), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  return {
    api: {
      user: {
        preferences: (options?: RequestOptions) => answer(
          'get',
          options,
          () => ({ success: true, preferences: server.rows }),
          () => undefined,
        ),
        savePreferences: (updates: Record<string, unknown>, options?: RequestOptions) => {
          const body = clone(updates);
          return answer('save', options, () => ({ success: true }), () => {
            server.accepted.push({ route: 'save', body });
            Object.assign(server.rows, body);
          });
        },
        patchPreferences: (changes: MergeBody, options?: RequestOptions) => {
          const body = clone(changes);
          return answer('merge', options, () => ({ success: true }), () => {
            server.accepted.push({ route: 'merge', body });
            Object.assign(server.rows, body.set);
            for (const [key, patch] of Object.entries(body.merge)) {
              server.rows[key] = mergeFields(server.rows[key], patch);
            }
          });
        },
      },
    },
  };
});

const loadModules = async () => {
  vi.resetModules();
  const store = await import('@/shared/userSettings');
  const editor = await import('@/shared/codeEditorSettings');
  return { store, editor };
};

const attemptsOf = (route: Route) => server.attempts.filter((attempt) => attempt === route).length;

const mergeSave = (merge: Record<string, Record<string, unknown>>, set: Record<string, unknown> = {}) => (
  { route: 'merge', body: { set, merge } }
);

const readMirror = () => JSON.parse(localStorage.getItem('user-preferences') ?? 'null') as unknown;

let consoleErrors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  server.rows = {};
  server.script = { get: [], save: [], merge: [] };
  server.attempts = [];
  server.accepted = [];
  server.aborted = 0;
  server.release = null;
  vi.useFakeTimers();
  // Failed and refused saves are logged; the tests read the outcome from the server.
  consoleErrors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

test('a stale page turning wrap on keeps the font size another device chose', async () => {
  const { store, editor } = await loadModules();
  await store.hydrateUserPreferences();
  // Another device sets the font size after this page loaded.
  server.rows.codeEditorSettings = { fontSize: '16' };

  editor.writeCodeEditorSettings({ wordWrap: true });
  await vi.advanceTimersByTimeAsync(500);

  assert.deepEqual(server.accepted, [mergeSave({ codeEditorSettings: { wordWrap: true } })]);
  assert.deepEqual(server.rows.codeEditorSettings, { fontSize: '16', wordWrap: true });

  // The other device reloads.
  const reloaded = await loadModules();
  await reloaded.store.hydrateUserPreferences();
  assert.equal(reloaded.editor.readCodeEditorSettings().fontSize, '16');
  assert.equal(reloaded.editor.readCodeEditorSettings().wordWrap, true);
});

test('a stale page hiding the sidebar keeps the banner another device turned off', async () => {
  const { store } = await loadModules();
  const { UiPreferencesProvider, useSetUiPreference, useUiPreferences } = await import(
    '@/shared/context/UiPreferencesContext'
  );
  await store.hydrateUserPreferences();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    React.createElement(UiPreferencesProvider, null, children)
  );
  const { result } = renderHook(
    () => ({ preferences: useUiPreferences(), setPreference: useSetUiPreference() }),
    { wrapper },
  );
  server.rows.uiPreferences = { runAlertBanner: false };

  act(() => {
    result.current.setPreference('sidebarVisible', false);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });

  assert.equal(result.current.preferences.sidebarVisible, false);
  assert.deepEqual(server.accepted, [mergeSave({ uiPreferences: { sidebarVisible: false } })]);
  assert.deepEqual(server.rows.uiPreferences, { runAlertBanner: false, sidebarVisible: false });
});

test('a toggle written before the provider subscribes still shows', async () => {
  await loadModules();
  const { UiPreferencesProvider, useSetUiPreference, useUiPreferences } = await import(
    '@/shared/context/UiPreferencesContext'
  );
  // A child's mount effect runs before the provider's, so this write reaches
  // the store before the provider has subscribed to it.
  function HideSidebarOnMount() {
    const setPreference = useSetUiPreference();
    React.useEffect(() => {
      setPreference('sidebarVisible', false);
    }, [setPreference]);
    return null;
  }
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    React.createElement(UiPreferencesProvider, null, React.createElement(HideSidebarOnMount), children)
  );

  const { result } = renderHook(() => useUiPreferences(), { wrapper });

  assert.equal(result.current.sidebarVisible, false);
});

test('a patch with nothing in it writes and sends nothing', async () => {
  const { store, editor } = await loadModules();
  await store.hydrateUserPreferences();
  const listener = vi.fn();
  store.subscribeToUserPreferences(listener);

  editor.writeCodeEditorSettings({});
  editor.writeCodeEditorSettings({ wordWrap: undefined });
  await vi.advanceTimersByTimeAsync(500);

  assert.equal(store.readUserPreference('codeEditorSettings', null), null);
  assert.equal(listener.mock.calls.length, 0);
  assert.equal(attemptsOf('merge') + attemptsOf('save'), 0);
});

test('field changes inside the debounce go out as one patch, and a patch after a whole value joins it', async () => {
  const { store, editor } = await loadModules();
  await store.hydrateUserPreferences();

  editor.writeCodeEditorSettings({ wordWrap: true });
  editor.writeCodeEditorSettings({ fontSize: '14' });
  await vi.advanceTimersByTimeAsync(500);

  assert.deepEqual(server.accepted, [mergeSave({ codeEditorSettings: { wordWrap: true, fontSize: '14' } })]);

  store.writeUserPreference('codeEditorSettings', { showMinimap: false });
  editor.writeCodeEditorSettings({ lineNumbers: false });
  await vi.advanceTimersByTimeAsync(500);

  assert.deepEqual(server.accepted.slice(1), [
    { route: 'save', body: { codeEditorSettings: { showMinimap: false, lineNumbers: false } } },
  ]);
});

test('failed saves stay queued and go out together once the server answers', async () => {
  const { store, editor } = await loadModules();
  await store.hydrateUserPreferences();
  server.script.merge = [500, 'offline'];

  editor.writeCodeEditorSettings({ wordWrap: true });
  await vi.advanceTimersByTimeAsync(500);
  editor.writeCodeEditorSettings({ fontSize: '14' });
  await vi.advanceTimersByTimeAsync(500);

  assert.equal(attemptsOf('merge'), 2);
  assert.equal(server.accepted.length, 0);

  // The second failure set a 2 s backoff.
  await vi.advanceTimersByTimeAsync(2_500);

  assert.equal(attemptsOf('merge'), 3);
  assert.deepEqual(server.accepted, [mergeSave({ codeEditorSettings: { wordWrap: true, fontSize: '14' } })]);
  assert.deepEqual(server.rows.codeEditorSettings, { wordWrap: true, fontSize: '14' });
});

test('a change made while a failing save is out wins over the value that failed', async () => {
  const { store, editor } = await loadModules();
  await store.hydrateUserPreferences();
  server.script.merge = ['hold'];

  editor.writeCodeEditorSettings({ fontSize: '14' });
  await vi.advanceTimersByTimeAsync(500);
  assert.equal(typeof server.release, 'function', 'the first save is out');
  editor.writeCodeEditorSettings({ fontSize: '18' });
  await vi.advanceTimersByTimeAsync(500);
  server.release?.(503);
  await vi.advanceTimersByTimeAsync(5_000);

  assert.deepEqual(server.rows.codeEditorSettings, { fontSize: '18' });
  assert.equal(editor.readCodeEditorSettings().fontSize, '18');
});

test('a save the server refuses with a 4xx is dropped, not retried', async () => {
  const { store, editor } = await loadModules();
  await store.hydrateUserPreferences();
  server.script.merge = [400];

  editor.writeCodeEditorSettings({ wordWrap: true });
  await vi.advanceTimersByTimeAsync(60_000);

  assert.equal(attemptsOf('merge'), 1);
  assert.equal(consoleErrors.mock.calls.length > 0, true, 'the refusal is logged');
});

test('a 408 or a 429 is retried like a server error', async () => {
  const { store, editor } = await loadModules();
  await store.hydrateUserPreferences();
  server.script.merge = [408, 429];

  editor.writeCodeEditorSettings({ wordWrap: true });
  await vi.advanceTimersByTimeAsync(5_000);

  assert.equal(attemptsOf('merge'), 3);
  assert.deepEqual(server.accepted, [mergeSave({ codeEditorSettings: { wordWrap: true } })]);
});

test('a server without the merge route gets this page\'s whole value, and the next batch tries the route again', async () => {
  server.rows.codeEditorSettings = { fontSize: '16' };
  const { store, editor } = await loadModules();
  await store.hydrateUserPreferences();
  server.script.merge = [404];

  editor.writeCodeEditorSettings({ wordWrap: true });
  await vi.advanceTimersByTimeAsync(500);

  // Sent as a whole value, the patch alone would have erased fontSize.
  assert.deepEqual(server.accepted, [
    { route: 'save', body: { codeEditorSettings: { fontSize: '16', wordWrap: true } } },
  ]);

  // Redeployed without this page reloading.
  editor.writeCodeEditorSettings({ fontSize: '14' });
  await vi.advanceTimersByTimeAsync(500);

  assert.deepEqual(server.accepted.slice(1), [mergeSave({ codeEditorSettings: { fontSize: '14' } })]);
});

test('a save that hangs is abandoned after 15 seconds and retried with the changes made meanwhile', async () => {
  const { store, editor } = await loadModules();
  await store.hydrateUserPreferences();
  server.script.merge = ['hang'];

  editor.writeCodeEditorSettings({ wordWrap: true });
  await vi.advanceTimersByTimeAsync(500);
  editor.writeCodeEditorSettings({ fontSize: '14' });
  await vi.advanceTimersByTimeAsync(14_000);

  assert.equal(server.aborted, 0, 'still waiting');
  assert.equal(server.accepted.length, 0);

  await vi.advanceTimersByTimeAsync(3_000);

  assert.equal(server.aborted, 1);
  assert.deepEqual(server.accepted, [mergeSave({ codeEditorSettings: { wordWrap: true, fontSize: '14' } })]);
});

test('an offline page keeps retrying, waiting longer each time but never more than 30 seconds', async () => {
  const { store, editor } = await loadModules();
  await store.hydrateUserPreferences();
  server.script.merge = Array<Step>(20).fill('offline');

  editor.writeCodeEditorSettings({ wordWrap: true });
  await vi.advanceTimersByTimeAsync(120_000);

  // Sent at 0.4 s, then after waits of 1, 2, 4, 8 and 16 s, then every 30 s:
  // 0.4, 1.4, 3.4, 7.4, 15.4, 31.4, 61.4 and 91.4 s.
  assert.equal(attemptsOf('merge'), 8);
});

test('a toggle clicked before the hydrate survives it and is sent as a patch', async () => {
  server.rows.uiPreferences = { runAlertBanner: false };
  const { store } = await loadModules();

  store.patchUserPreference('uiPreferences', { sidebarVisible: false });
  await store.hydrateUserPreferences();

  assert.deepEqual(store.readUserPreference('uiPreferences', null), { runAlertBanner: false, sidebarVisible: false });
  await vi.advanceTimersByTimeAsync(500);
  assert.deepEqual(server.accepted, [mergeSave({ uiPreferences: { sidebarVisible: false } })]);
  assert.deepEqual(server.rows.uiPreferences, { runAlertBanner: false, sidebarVisible: false });
});

test('a toggle clicked before the hydrate stays on top of the value migrated from the old storage', async () => {
  localStorage.setItem('uiPreferences', JSON.stringify({ showThinking: false, sidebarVisible: true }));
  const { store } = await loadModules();

  store.patchUserPreference('uiPreferences', { sidebarVisible: false });
  await store.hydrateUserPreferences();
  await vi.advanceTimersByTimeAsync(500);

  // The server has no uiPreferences yet, so the migrated value goes out whole, with the toggle in it.
  assert.deepEqual(server.accepted, [
    { route: 'save', body: { uiPreferences: { showThinking: false, sidebarVisible: false } } },
  ]);
  assert.deepEqual(store.readUserPreference('uiPreferences', null), { showThinking: false, sidebarVisible: false });
});

test('a write puts only its own key into the mirror, keeping keys another tab wrote', async () => {
  const { store } = await loadModules();
  store.writeUserPreference('theme', 'dark');

  // Another tab of this browser writes its own key into the mirror.
  const mirror = readMirror() as Record<string, unknown>;
  localStorage.setItem('user-preferences', JSON.stringify({ ...mirror, userLanguage: 'de' }));

  store.writeUserPreference('tasksEnabled', true);

  assert.deepEqual(readMirror(), { theme: 'dark', userLanguage: 'de', tasksEnabled: true });
});

test('a save that fails after sign-out is not put back or retried', async () => {
  const { store, editor } = await loadModules();
  await store.hydrateUserPreferences();
  server.script.merge = ['hold'];

  editor.writeCodeEditorSettings({ wordWrap: true });
  await vi.advanceTimersByTimeAsync(500);
  assert.equal(typeof server.release, 'function', 'the save is out');

  store.resetUserPreferences();
  server.release?.(500);
  await vi.advanceTimersByTimeAsync(60_000);

  assert.equal(attemptsOf('merge'), 1);
  assert.equal(store.readUserPreference('codeEditorSettings', null), null);
  assert.equal(localStorage.getItem('user-preferences'), null);
});

test('a merge save answered 404 after sign-out sends no fallback on the old route', async () => {
  const { store, editor } = await loadModules();
  await store.hydrateUserPreferences();
  server.script.merge = ['hold'];

  editor.writeCodeEditorSettings({ wordWrap: true });
  await vi.advanceTimersByTimeAsync(500);
  assert.equal(typeof server.release, 'function', 'the save is out');

  store.resetUserPreferences();
  server.release?.(404);
  await vi.advanceTimersByTimeAsync(60_000);

  assert.equal(attemptsOf('save'), 0, 'the fallback is not sent');
  assert.equal(attemptsOf('merge'), 1);
  assert.equal(store.readUserPreference('codeEditorSettings', null), null);
  assert.equal(localStorage.getItem('user-preferences'), null);
});

test('a whole value the user chooses while the hydrate is out is kept and sent after it', async () => {
  // Settings can be open while the first read is still out. The save of a pick
  // made there waits behind the read, and the read used to drop it.
  server.rows = { projectSortOrder: 'name' };
  server.script.get = ['hold'];
  const { store } = await loadModules();

  const hydrating = store.hydrateUserPreferences();
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(typeof server.release, 'function', 'the hydrate is out');
  store.writeUserPreferences({ projectSortOrder: 'date' });
  await vi.advanceTimersByTimeAsync(1_000);
  assert.equal(attemptsOf('save'), 0, 'the save waits behind the hydrate');

  server.release?.(200);
  await hydrating;
  await vi.advanceTimersByTimeAsync(0);

  assert.equal(store.readUserPreference('projectSortOrder', null), 'date');
  assert.deepEqual(server.accepted, [{ route: 'save', body: { projectSortOrder: 'date' } }]);
  assert.equal(server.rows.projectSortOrder, 'date');
});

test('a hydrate answered after sign-out does not bring the previous user back', async () => {
  server.rows.theme = 'dark';
  server.script.get = ['hold'];
  const { store } = await loadModules();

  const hydrating = store.hydrateUserPreferences();
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(typeof server.release, 'function', 'the hydrate is out');
  store.resetUserPreferences();
  server.release?.(200);
  await hydrating;

  assert.equal(store.readUserPreference('theme', 'light'), 'light');
  assert.equal(localStorage.getItem('user-preferences'), null);
  assert.equal(store.hasHydratedUserPreferences(), false);
});

test('after sign-out the next hydrate does not wait behind a save that hangs', async () => {
  const { store, editor } = await loadModules();
  await store.hydrateUserPreferences();
  server.script.merge = ['hang'];

  editor.writeCodeEditorSettings({ wordWrap: true });
  await vi.advanceTimersByTimeAsync(500);
  assert.equal(attemptsOf('merge'), 1, 'the save is out');

  store.resetUserPreferences();
  server.rows = { theme: 'dark' };
  const hydrating = store.hydrateUserPreferences();
  await vi.advanceTimersByTimeAsync(0);

  assert.equal(attemptsOf('get'), 2, 'the next session reads at once');
  await hydrating;
  assert.equal(store.readUserPreference('theme', 'light'), 'dark');
});
