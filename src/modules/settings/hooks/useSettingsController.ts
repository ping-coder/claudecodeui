import { useCallback, useEffect, useRef, useState } from 'react';

import { useTheme } from '@/shared/context/ThemeContext';
import { api } from '@/shared/api';
import { isNotificationSoundEnabled, setNotificationSoundEnabled } from '@/shared/utils';
import {
  readCodeEditorSettings,
  writeCodeEditorSettings,
} from '@/shared/codeEditorSettings';
import {
  getUserPreferencesSession,
  readUserPreference,
  writeUserPreferences,
} from '@/shared/userSettings';
import { useProviderAuthStatus } from '@/modules/provider-auth';
import type { AgentProvider, ClaudePermissionsState, CodeEditorSettingsState, CodexPermissionMode, CursorPermissionsState, NotificationPreferencesState, NotificationPreferencesStatus, ProjectSortOrder, SettingsMainTab } from '@/shared/types';

const DEFAULT_CURSOR_PERMISSIONS: CursorPermissionsState = {
  allowedCommands: [],
  disallowedCommands: [],
  skipPermissions: false,
};

type ThemeContextValue = {
  isDarkMode: boolean;
  toggleDarkMode: () => void;
};

type UseSettingsControllerArgs = {
  isOpen: boolean;
  initialTab: string;
};

type ClaudeSettingsStorage = {
  allowedTools?: string[];
  disallowedTools?: string[];
  skipPermissions?: boolean;
  projectSortOrder?: ProjectSortOrder;
};

type CursorSettingsStorage = {
  allowedCommands?: string[];
  disallowedCommands?: string[];
  skipPermissions?: boolean;
};

type CodexSettingsStorage = {
  permissionMode?: CodexPermissionMode;
};

type NotificationPreferencesResponse = {
  success?: boolean;
  preferences?: NotificationPreferencesState;
};

type ActiveLoginProvider = AgentProvider | '';

/** The user preferences this dialog edits, each in the shape it is stored under. */
type DialogUserPreferences = {
  claudePermissions: ClaudePermissionsState;
  projectSortOrder: ProjectSortOrder;
  cursorPermissions: CursorPermissionsState;
  codexPermissions: { permissionMode: CodexPermissionMode };
};

type DialogUserPreferenceKey = keyof DialogUserPreferences;

/** A new notification-preferences value, or a function computing it from the value last shown. */
type NotificationPreferencesUpdate =
  | NotificationPreferencesState
  | ((current: NotificationPreferencesState) => NotificationPreferencesState);

/** Collapses a burst of edits (several switches in a row) into one save. */
const SETTINGS_SAVE_DEBOUNCE_MS = 500;

const KNOWN_MAIN_TABS: SettingsMainTab[] = ['agents', 'appearance', 'git', 'api', 'tasks', 'browser', 'notifications', 'plugins', 'about'];

const normalizeMainTab = (tab: string): SettingsMainTab => {
  // Keep backwards compatibility with older callers that still pass "tools".
  if (tab === 'tools') {
    return 'agents';
  }

  return KNOWN_MAIN_TABS.includes(tab as SettingsMainTab) ? (tab as SettingsMainTab) : 'agents';
};

const toCodexPermissionMode = (value: unknown): CodexPermissionMode => {
  if (value === 'acceptEdits' || value === 'bypassPermissions') {
    return value;
  }

  return 'default';
};

const toResponseJson = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const toJsonByKey = (
  preferences: Partial<DialogUserPreferences>,
): Partial<Record<DialogUserPreferenceKey, string>> => (
  Object.fromEntries(Object.entries(preferences).map(([key, value]) => [key, JSON.stringify(value)]))
);

const createEmptyClaudePermissions = (): ClaudePermissionsState => ({
  allowedTools: [],
  disallowedTools: [],
  skipPermissions: false,
});

const createEmptyCursorPermissions = (): CursorPermissionsState => ({
  ...DEFAULT_CURSOR_PERMISSIONS,
});

const createDefaultNotificationPreferences = (): NotificationPreferencesState => ({
  channels: {
    inApp: true,
    webPush: false,
    desktop: false,
    // The local mirror, not a hard-coded true: the effect that mirrors `sound` into
    // localStorage runs on open, before (or without) the server's answer, and would
    // otherwise turn a sound the user switched off back on.
    sound: isNotificationSoundEnabled(),
  },
  events: {
    actionRequired: true,
    stop: true,
    error: true,
  },
});

const normalizeNotificationPreferences = (
  preferences?: Partial<NotificationPreferencesState> | null,
): NotificationPreferencesState => {
  const defaults = createDefaultNotificationPreferences();

  return {
    channels: {
      inApp: preferences?.channels?.inApp ?? defaults.channels.inApp,
      webPush: preferences?.channels?.webPush ?? defaults.channels.webPush,
      desktop: preferences?.channels?.desktop ?? defaults.channels.desktop,
      sound: preferences?.channels?.sound ?? defaults.channels.sound,
    },
    events: {
      actionRequired: preferences?.events?.actionRequired ?? defaults.events.actionRequired,
      stop: preferences?.events?.stop ?? defaults.events.stop,
      error: preferences?.events?.error ?? defaults.events.error,
    },
  };
};

export function useSettingsController({ isOpen, initialTab }: UseSettingsControllerArgs) {
  const { isDarkMode, toggleDarkMode } = useTheme() as ThemeContextValue;
  const closeTimerRef = useRef<number | null>(null);

  const [activeTab, setActiveTab] = useState<SettingsMainTab>(() => normalizeMainTab(initialTab));
  // The initialTab last applied, so opening Settings at another tab while it is open switches
  // to that tab during render, without the open effect (and its load) running again.
  const [appliedInitialTab, setAppliedInitialTab] = useState(initialTab);
  if (appliedInitialTab !== initialTab) {
    setAppliedInitialTab(initialTab);
    setActiveTab(normalizeMainTab(initialTab));
  }
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);
  const [projectSortOrder, setProjectSortOrder] = useState<ProjectSortOrder>('name');
  const [codeEditorSettings, setCodeEditorSettings] = useState<CodeEditorSettingsState>(() => (
    readCodeEditorSettings()
  ));

  const [claudePermissions, setClaudePermissions] = useState<ClaudePermissionsState>(() => (
    createEmptyClaudePermissions()
  ));
  const [cursorPermissions, setCursorPermissions] = useState<CursorPermissionsState>(() => (
    createEmptyCursorPermissions()
  ));
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferencesState>(() => (
    createDefaultNotificationPreferences()
  ));
  const [codexPermissionMode, setCodexPermissionMode] = useState<CodexPermissionMode>('default');
  // Whether the server's notification preferences have arrived. Until they have, the
  // notifications tab keeps the switches that save them disabled, and says so when the
  // read failed: the defaults on screen are not the user's.
  const [notificationPreferencesStatus, setNotificationPreferencesStatus] = useState<NotificationPreferencesStatus>('loading');

  // JSON of what is stored for each value this dialog saves: the user preferences as read
  // on opening, the notification preferences as the server answered (null until it has).
  // A save writes only what differs from it, so loading never writes and an edit undone
  // within the debounce writes nothing.
  const savedUserPreferencesRef = useRef<Partial<Record<DialogUserPreferenceKey, string>>>({});
  const savedNotificationPreferencesRef = useRef<string | null>(null);
  // Edits waiting out the debounce, and its timer.
  const pendingUserPreferencesRef = useRef<Partial<DialogUserPreferences>>({});
  const pendingNotificationPreferencesRef = useRef<NotificationPreferencesState | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  // Notification saves run one at a time, so each compares against what the previous one
  // stored and the PUTs reach the server in the order they were made.
  const notificationSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  // The notification preferences last shown, for edits computed from the current value.
  const notificationPreferencesRef = useRef(notificationPreferences);
  // The session this dialog opened in. A sign-out resets the preference store before the
  // dialog unmounts, so its closing flush, a debounce that fires in between and a
  // notification PUT still queued compare against this and write nothing after it.
  const sessionRef = useRef(getUserPreferencesSession());

  const [showLoginModal, setShowLoginModal] = useState(false);
  const [loginProvider, setLoginProvider] = useState<ActiveLoginProvider>('');
  const {
    providerAuthStatus,
    checkProviderAuthStatus,
    refreshProviderAuthStatuses,
  } = useProviderAuthStatus();

  const showNotificationPreferences = useCallback((preferences: NotificationPreferencesState) => {
    notificationPreferencesRef.current = preferences;
    setNotificationPreferences(preferences);
  }, []);

  // Loading only shows values and records them as stored; it never schedules a save.
  const adoptNotificationPreferences = useCallback((preferences: NotificationPreferencesState) => {
    savedNotificationPreferencesRef.current = JSON.stringify(preferences);
    // An edit still waiting was made on the defaults shown while loading; sending it
    // would write them over the copy that just arrived.
    pendingNotificationPreferencesRef.current = null;
    showNotificationPreferences(preferences);
    setNotificationPreferencesStatus('ready');
  }, [showNotificationPreferences]);

  // Runs once per opening (Settings mounts when it opens), so the status and the stored
  // notification copy start out as 'loading' and null.
  const loadSettings = useCallback(async () => {
    try {
      const savedClaudeSettings = readUserPreference<ClaudeSettingsStorage>('claudePermissions', {});
      const savedCursorSettings = readUserPreference<CursorSettingsStorage>('cursorPermissions', {});
      const savedCodexSettings = readUserPreference<CodexSettingsStorage>('codexPermissions', {});
      const loadedUserPreferences: DialogUserPreferences = {
        claudePermissions: {
          allowedTools: savedClaudeSettings.allowedTools || [],
          disallowedTools: savedClaudeSettings.disallowedTools || [],
          skipPermissions: Boolean(savedClaudeSettings.skipPermissions),
        },
        projectSortOrder: readUserPreference<ProjectSortOrder>('projectSortOrder', 'name') === 'date' ? 'date' : 'name',
        cursorPermissions: {
          allowedCommands: savedCursorSettings.allowedCommands || [],
          disallowedCommands: savedCursorSettings.disallowedCommands || [],
          skipPermissions: Boolean(savedCursorSettings.skipPermissions),
        },
        codexPermissions: { permissionMode: toCodexPermissionMode(savedCodexSettings.permissionMode) },
      };
      savedUserPreferencesRef.current = toJsonByKey(loadedUserPreferences);
      setClaudePermissions(loadedUserPreferences.claudePermissions);
      setProjectSortOrder(loadedUserPreferences.projectSortOrder);
      setCursorPermissions(loadedUserPreferences.cursorPermissions);
      setCodexPermissionMode(loadedUserPreferences.codexPermissions.permissionMode);

      let loaded: NotificationPreferencesState | null = null;
      try {
        const notificationResponse = await api.settings.notificationPreferences();
        if (notificationResponse.ok) {
          const notificationData = await toResponseJson<NotificationPreferencesResponse>(notificationResponse);
          if (notificationData.success && notificationData.preferences) {
            loaded = normalizeNotificationPreferences(notificationData.preferences);
          }
        }
      } catch {
        // Treated as a failed read below.
      }

      if (loaded) {
        adoptNotificationPreferences(loaded);
      } else {
        // The server's copy stays unknown, so nothing on this tab is saved: the
        // defaults on screen would overwrite it.
        setNotificationPreferencesStatus('failed');
      }
    } catch (error) {
      console.error('Error loading settings:', error);
      savedUserPreferencesRef.current = toJsonByKey({
        claudePermissions: createEmptyClaudePermissions(),
        projectSortOrder: 'name',
        cursorPermissions: createEmptyCursorPermissions(),
        codexPermissions: { permissionMode: 'default' },
      });
      setClaudePermissions(createEmptyClaudePermissions());
      setCursorPermissions(createEmptyCursorPermissions());
      setCodexPermissionMode('default');
      setProjectSortOrder('name');
      setNotificationPreferencesStatus('failed');
    }
  }, [adoptNotificationPreferences]);

  const openLoginForProvider = useCallback((provider: AgentProvider) => {
    setLoginProvider(provider);
    setShowLoginModal(true);
  }, []);

  const handleLoginComplete = useCallback((exitCode: number) => {
    if (!loginProvider) {
      return;
    }

    void (async () => {
      const authStatus = await checkProviderAuthStatus(loginProvider);

      if (exitCode !== 0) {
        console.warn(`Login process exited with code ${exitCode}; refreshing auth status before setting save status.`);
      }

      setSaveStatus(authStatus.authenticated ? 'success' : 'error');
    })();
  }, [checkProviderAuthStatus, loginProvider]);

  // Writes the edits that differ from what is stored. The user preferences go at once, in
  // one write of the changed keys only, so a key the user never touched is not written
  // back from this dialog's copy. The notification preferences are queued behind any PUT
  // still in flight and sent only once the server's copy is known.
  const flushPendingSave = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pendingUserPreferences = pendingUserPreferencesRef.current;
    const pendingNotificationPreferences = pendingNotificationPreferencesRef.current;
    pendingUserPreferencesRef.current = {};
    pendingNotificationPreferencesRef.current = null;
    // Signed out since the dialog opened: the edits belonged to that session.
    if (getUserPreferencesSession() !== sessionRef.current) {
      return;
    }

    const changedUserPreferences = Object.fromEntries(
      Object.entries(pendingUserPreferences).filter(([key, value]) => (
        JSON.stringify(value) !== savedUserPreferencesRef.current[key as DialogUserPreferenceKey]
      )),
    ) as Partial<DialogUserPreferences>;
    if (Object.keys(changedUserPreferences).length > 0) {
      writeUserPreferences(changedUserPreferences);
      Object.assign(savedUserPreferencesRef.current, toJsonByKey(changedUserPreferences));
      setSaveStatus('success');
    }

    if (pendingNotificationPreferences === null) {
      return;
    }
    notificationSaveQueueRef.current = notificationSaveQueueRef.current.then(async () => {
      // The session may have ended while an earlier PUT was on its way.
      if (getUserPreferencesSession() !== sessionRef.current) {
        return;
      }
      const saved = savedNotificationPreferencesRef.current;
      const next = JSON.stringify(normalizeNotificationPreferences(pendingNotificationPreferences));
      if (saved === null || next === saved) {
        return;
      }
      try {
        const notificationResponse = await api.settings.saveNotificationPreferences(pendingNotificationPreferences);
        if (!notificationResponse.ok) {
          throw new Error('Failed to save notification preferences');
        }
        savedNotificationPreferencesRef.current = next;
        setSaveStatus('success');
      } catch (error) {
        console.error('Error saving settings:', error);
        setSaveStatus('error');
      }
    });
  }, []);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(flushPendingSave, SETTINGS_SAVE_DEBOUNCE_MS);
  }, [flushPendingSave]);

  // The dialog's edit handlers: each shows the new value and schedules its save. Saving used
  // to run from an effect keyed on these values, which also ran for the renders loading
  // causes; its skip flag was used up before the notification preferences arrived, so that
  // answer was saved as an edit and "Settings saved successfully!" showed on every open.
  const updateClaudePermissions = useCallback((value: ClaudePermissionsState) => {
    setClaudePermissions(value);
    pendingUserPreferencesRef.current = {
      ...pendingUserPreferencesRef.current,
      claudePermissions: {
        allowedTools: value.allowedTools,
        disallowedTools: value.disallowedTools,
        skipPermissions: value.skipPermissions,
      },
    };
    scheduleSave();
  }, [scheduleSave]);

  const updateCursorPermissions = useCallback((value: CursorPermissionsState) => {
    setCursorPermissions(value);
    pendingUserPreferencesRef.current = {
      ...pendingUserPreferencesRef.current,
      cursorPermissions: {
        allowedCommands: value.allowedCommands,
        disallowedCommands: value.disallowedCommands,
        skipPermissions: value.skipPermissions,
      },
    };
    scheduleSave();
  }, [scheduleSave]);

  const updateCodexPermissionMode = useCallback((value: CodexPermissionMode) => {
    setCodexPermissionMode(value);
    pendingUserPreferencesRef.current = {
      ...pendingUserPreferencesRef.current,
      codexPermissions: { permissionMode: value },
    };
    scheduleSave();
  }, [scheduleSave]);

  const updateProjectSortOrder = useCallback((value: ProjectSortOrder) => {
    setProjectSortOrder(value);
    pendingUserPreferencesRef.current = { ...pendingUserPreferencesRef.current, projectSortOrder: value };
    scheduleSave();
  }, [scheduleSave]);

  // Accepts a function of the current value for callers that resume after an await (the
  // push and desktop handlers), so they build on what is shown now, not on what was shown
  // when they started.
  const updateNotificationPreferences = useCallback((update: NotificationPreferencesUpdate) => {
    const next = typeof update === 'function' ? update(notificationPreferencesRef.current) : update;
    showNotificationPreferences(next);
    pendingNotificationPreferencesRef.current = next;
    scheduleSave();
  }, [scheduleSave, showNotificationPreferences]);

  // Persist on the user's edit rather than in an effect keyed on the settings
  // object. The effect form also ran on mount, so merely opening this dialog
  // rewrote every key — which reset the editor's font size for anyone who had
  // never changed it.
  //
  // Two places write these settings, this dialog and the editor header's wrap
  // toggle, and each sends only its own key, which the server merges into its
  // copy (see writeCodeEditorSettings). Keys the user never changed therefore
  // stay unset and keep following their defaults, and no write undoes a key
  // changed by the other writer, in another tab or on another device. The state
  // is re-read from storage rather than built from the rendered value, so two
  // edits landing in one React batch both survive.
  const updateCodeEditorSetting = useCallback(
    <K extends keyof CodeEditorSettingsState>(key: K, value: CodeEditorSettingsState[K]) => {
      const update: Partial<CodeEditorSettingsState> = {};
      update[key] = value;
      writeCodeEditorSettings(update);
      setCodeEditorSettings(readCodeEditorSettings());
    },
    [],
  );

  // Not keyed on initialTab: loading again while open would put the stored values back on
  // screen under an edit still waiting to be saved.
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    void loadSettings();
    void refreshProviderAuthStatuses();
  }, [isOpen, loadSettings, refreshProviderAuthStatuses]);

  useEffect(() => {
    setNotificationSoundEnabled(notificationPreferences.channels.sound);
  }, [notificationPreferences.channels.sound]);

  // Clear save status after 2 seconds
  useEffect(() => {
    if (saveStatus === null) {
      return;
    }

    const timer = window.setTimeout(() => setSaveStatus(null), 2000);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    // Closing the dialog right after an edit saves it now instead of dropping it, unless
    // the dialog is closing because the session ended.
    if (saveTimerRef.current !== null) {
      flushPendingSave();
    }
  }, [flushPendingSave]);

  return {
    activeTab,
    setActiveTab,
    isDarkMode,
    toggleDarkMode,
    saveStatus,
    projectSortOrder,
    updateProjectSortOrder,
    codeEditorSettings,
    updateCodeEditorSetting,
    claudePermissions,
    updateClaudePermissions,
    cursorPermissions,
    updateCursorPermissions,
    notificationPreferences,
    notificationPreferencesStatus,
    updateNotificationPreferences,
    codexPermissionMode,
    updateCodexPermissionMode,
    providerAuthStatus,
    openLoginForProvider,
    showLoginModal,
    setShowLoginModal,
    loginProvider,
    handleLoginComplete,
  };
}
