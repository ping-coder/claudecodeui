import { createContext, useContext, useEffect, useMemo, useReducer } from 'react';
import type { ReactNode } from 'react';

import {
  readStoredUiPreferences,
  uiPreferencesReducer,
} from '@/shared/uiPreferences';
import type { UiPreferenceKey, UiPreferences } from '@/shared/uiPreferences';
import { patchUserPreference, subscribeToUserPreferences } from '@/shared/userSettings';

type UiPreferenceActions = {
  setPreference: (key: UiPreferenceKey, value: boolean) => void;
};

const UiPreferencesStateContext = createContext<UiPreferences | null>(null);
const UiPreferencesActionsContext = createContext<UiPreferenceActions | null>(null);

/**
 * Mounted once by App; owns the boolean UI preferences that the sidebar, quick
 * settings, the workspace, the voice controls, run-notifications (its banner and
 * system-notification switches) and the settings' notifications page all read.
 *
 * This used to be a plain hook, which meant every call site held its own reducer
 * and they reconciled after the fact through a `ui-preferences:sync` CustomEvent
 * tagged with a per-instance id — so one toggle produced four localStorage
 * writes and four DOM events. With a single owner that channel is unnecessary,
 * and the preferences themselves now live in `auth.db`, which is what carries a
 * change to another tab or another device. A toggle sends only its own key,
 * which the server merges in, so a page holding an older copy of the others
 * never writes them back.
 */
export function UiPreferencesProvider({ children }: { children: ReactNode }) {
  // The single copy of the preferences. Every consumer used to hold its own
  // reducer and reconcile through an event, so one toggle wrote localStorage
  // once per consumer and re-rendered all of them.
  const [preferences, dispatch] = useReducer(
    uiPreferencesReducer,
    undefined,
    readStoredUiPreferences,
  );

  // The store is the only copy that is written: a toggle patches its one key
  // there, and this state follows the store, which notifies synchronously, so
  // the toggle shows in the same frame. Nothing is written on mount, a value
  // arriving from a hydrate is never echoed back, and the defaults filled in
  // for keys the user never toggled are never sent.
  useEffect(() => {
    const followStore = () => dispatch({ type: 'set_many', value: readStoredUiPreferences() });
    const unsubscribe = subscribeToUserPreferences(followStore);
    // Catches a write made between the first render and this subscription,
    // such as one from a child's mount effect, which runs before this one.
    followStore();
    return unsubscribe;
  }, []);

  const actions = useMemo<UiPreferenceActions>(() => ({
    setPreference: (key, value) => patchUserPreference('uiPreferences', { [key]: value }),
  }), []);

  return (
    <UiPreferencesActionsContext.Provider value={actions}>
      <UiPreferencesStateContext.Provider value={preferences}>
        {children}
      </UiPreferencesStateContext.Provider>
    </UiPreferencesActionsContext.Provider>
  );
}

/**
 * Reads the UI preferences. Components that only write should use
 * useSetUiPreference instead, so a toggle does not re-render them.
 */
export function useUiPreferences(): UiPreferences {
  const preferences = useContext(UiPreferencesStateContext);
  if (!preferences) {
    throw new Error('useUiPreferences must be used within a UiPreferencesProvider');
  }
  return preferences;
}

/** Stable setter, so writers never re-render on a preference change. */
export function useSetUiPreference(): UiPreferenceActions['setPreference'] {
  const actions = useContext(UiPreferencesActionsContext);
  if (!actions) {
    throw new Error('useSetUiPreference must be used within a UiPreferencesProvider');
  }
  return actions.setPreference;
}
