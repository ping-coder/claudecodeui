import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import type { PendingPermissionRequest, PermissionMode,
  ProjectSession,
  LLMProvider,
  Project,
  CustomProviderModelInput,
  ProviderModelActions,
  ProviderModelOption,
  ProviderModelsDefinition } from '@/shared/types';
import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import { readSelectedProvider, writeSelectedProvider } from '@/shared/selectedProvider';
import { getProviderModelStorageKey } from '@/shared/utils';

const FALLBACK_PROVIDER_EFFORT_VALUES: Partial<Record<LLMProvider, readonly string[]>> = {
  // Superset used only before the model catalog loads. Per-model metadata
  // narrows this once available; listing every level any Claude model accepts
  // keeps a stored xhigh or max selection from being reset during catalog
  // hydration. Ultracode is not an effort level; see providerUltracode.
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  // Superset used only before the model catalog loads. Per-model metadata
  // narrows this once available; including the GPT-5.6 tiers here prevents a
  // valid Max/Ultra selection from being reset during catalog hydration.
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  opencode: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  // Every Antigravity model offers the same levels (passed on as `--effort`);
  // without this entry its effort menu would stay hidden until the
  // capabilities request lands.
  agy: ['low', 'medium', 'high', 'xhigh', 'max'],
};

const toProviderEffortOptions = (
  values: readonly string[],
): NonNullable<ProviderModelOption['effort']>['values'] => values.map((value) => ({ value }));

const FALLBACK_DEFAULT_MODEL: Record<LLMProvider, string> = {
  claude: 'default',
  cursor: 'gpt-5.3-codex',
  codex: 'gpt-5.4',
  opencode: 'anthropic/claude-sonnet-4-5',
  // Empty on purpose: the backend catalog's DEFAULT (the model agy's own
  // settings.json names, else 'auto') then wins on first use, and a send made
  // before the catalog loads passes no --model, so agy uses that same default.
  agy: '',
};

const PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'opencode', 'agy'];


/** localStorage key holding the user's default reasoning effort for one provider. */
const providerEffortStorageKey = (provider: LLMProvider): string => `${provider}-effort`;

/** localStorage key holding the user's default ultracode switch ('true' or 'false') for one provider. */
const providerUltracodeStorageKey = (provider: LLMProvider): string => `${provider}-ultracode`;

/**
 * Effort value older builds stored for Claude Code's ultracode, back when it
 * was offered as a sixth effort level meaning "xhigh plus workflows". Ultracode
 * is now a separate switch that combines with any level.
 */
const LEGACY_ULTRACODE_EFFORT = 'ultracode';

/** Effort level a stored legacy `ultracode` effort always ran at. */
const LEGACY_ULTRACODE_EFFORT_LEVEL = 'xhigh';

/**
 * Rewrites a stored legacy `ultracode` effort into its current shape: effort
 * xhigh with the ultracode switch on. It has to run before the effort state
 * reads storage, because the catalog no longer lists `ultracode` as an effort
 * and the reconcile effect would otherwise reset it to the default level and
 * lose the choice. Idempotent, so React re-running initializers is harmless.
 */
const migrateLegacyUltracodeEffort = (targetProvider: LLMProvider): void => {
  if (localStorage.getItem(providerEffortStorageKey(targetProvider)) !== LEGACY_ULTRACODE_EFFORT) {
    return;
  }

  localStorage.setItem(providerEffortStorageKey(targetProvider), LEGACY_ULTRACODE_EFFORT_LEVEL);
  localStorage.setItem(providerUltracodeStorageKey(targetProvider), 'true');
};

/**
 * Fallback ultracode support used only until the backend capability matrix
 * has loaded (or when it fails, or comes from a server that predates the
 * `supportsUltracode` capability). The per-model catalog flag still decides
 * whether the current model can run it.
 */
const FALLBACK_PROVIDER_ULTRACODE_SUPPORT: Partial<Record<LLMProvider, boolean>> = {
  claude: true,
};

/**
 * Fallback permission-mode matrix used only until the backend capability
 * matrix (`GET /api/providers/capabilities`) has loaded. The backend is the
 * source of truth; this mirror exists so the composer renders sensibly on
 * first paint and when the capabilities request fails.
 */
const FALLBACK_PERMISSION_MODES: Record<LLMProvider, PermissionMode[]> = {
  claude: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
  cursor: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  codex: ['default', 'acceptEdits', 'bypassPermissions'],
  opencode: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  agy: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
};

/**
 * Fallback attachment support used only until the backend capability matrix
 * has loaded (or when it fails). Every other provider accepts both images and
 * files, so only the exception is listed and the rest default to supported.
 */
const FALLBACK_PROVIDER_ATTACHMENT_SUPPORT: Partial<Record<LLMProvider, boolean>> = {
  agy: false,
};

/**
 * Fallback mid-run insert support, used only until the backend capability
 * matrix has loaded (or when it fails). A matrix that loaded without the flag
 * comes from a server that predates `chat.insert`, so there the answer is no.
 */
const FALLBACK_PROVIDER_MID_RUN_INSERT_SUPPORT: Partial<Record<LLMProvider, boolean>> = {
  claude: true,
};

type ProviderCapabilities = {
  provider: LLMProvider;
  permissionModes: string[];
  defaultPermissionMode: string;
  supportsImages: boolean;
  supportsFiles: boolean;
  supportsAbort: boolean;
  supportsPermissionRequests: boolean;
  supportsTokenUsage: boolean;
  supportsEffort?: boolean;
  /** Absent from servers that predate ultracode as a separate switch. */
  supportsUltracode?: boolean;
  supportsMessageEditing?: boolean;
  supportsSessionForking?: boolean;
  /** Whether a message sent while a turn runs can go into that turn; absent from servers that predate `chat.insert`. */
  supportsMidRunInsert?: boolean;
};

type ProviderCapabilitiesApiResponse = {
  success?: boolean;
  data?: {
    providers?: ProviderCapabilities[];
  };
};

type UseChatProviderStateArgs = {
  selectedSession: ProjectSession | null;
  selectedProject: Project | null;
  /**
   * Whether this chat's pane is the focused one. Only the focused pane writes
   * the page-wide selected provider, which new chats, the shell and the git
   * panel start from. Defaults to true: outside the split workspace the lone
   * chat is the focused one.
   */
  isFocusedPane?: boolean;
};

type ProviderModelsApiResponse = {
  success?: boolean;
  data?: {
    models?: ProviderModelsDefinition;
  };
};

type ProviderModelMutationApiResponse = {
  success?: boolean;
  data?: {
    model?: ProviderModelOption;
    models?: ProviderModelsDefinition;
  };
  error?: {
    message?: string;
  };
};

type SessionSelectionApiResponse = {
  success?: boolean;
  data?: {
    provider?: LLMProvider;
    sessionId?: string | null;
    model?: string | null;
    effort?: string | null;
    /** NULL means the session has not recorded an ultracode choice yet. */
    ultracode?: boolean | null;
    /**
     * `session` and `provider` are real answers for this session; `default`
     * means the backend had nothing recorded and returned the catalog default,
     * which the composer replaces with the user's per-provider selection.
     */
    source?: 'session' | 'provider' | 'default';
  };
};

type SessionProviderSelection = {
  provider: LLMProvider;
  sessionId: string;
  model: string | null;
  effort: string | null;
  /** NULL means nothing is recorded, so the per-provider default applies. */
  ultracode: boolean | null;
};

/** The per-session fields a composer choice can change. */
type SessionSelectionFields = Pick<SessionProviderSelection, 'model' | 'effort' | 'ultracode'>;

type SessionSelectionField = keyof SessionSelectionFields;

/**
 * Everything known about one session's recorded model, effort and ultracode,
 * in layers so that no answer can overwrite a newer one. Every load and save
 * takes a number from one per-hook counter, which orders them on this client:
 * - `loaded`: the latest active-model load to land, issued at `loadedSeq`;
 *   null until one lands;
 * - `confirmed`: what the server stored for a choice. Among saves of one field
 *   the latest started wins, whatever order they settle in, and a confirmed
 *   value beats any load issued before its save settled (that load may predate
 *   the write);
 * - `pending`: choices whose save is still in flight, shown at once; only the
 *   save that set an entry clears it, and a failed save just drops it.
 */
type SessionSelectionLayers = {
  loaded: SessionSelectionFields | null;
  loadedSeq: number;
  confirmed: Partial<Record<SessionSelectionField, { value: unknown; startedSeq: number; settledSeq: number }>>;
  pending: Partial<Record<SessionSelectionField, { value: unknown; startedSeq: number }>>;
};

const EMPTY_SESSION_SELECTION_LAYERS: SessionSelectionLayers = {
  loaded: null,
  loadedSeq: 0,
  confirmed: {},
  pending: {},
};

const getSessionSelectionKey = (provider: LLMProvider, sessionId: string): string => (
  `${provider}:${sessionId}`
);

/** Reads one field through the layers: an in-flight choice, else a save newer than the load, else the load. */
const resolveSessionSelectionField = <TField extends SessionSelectionField>(
  layers: SessionSelectionLayers,
  field: TField,
): SessionSelectionFields[TField] | null => {
  const pending = layers.pending[field];
  if (pending) {
    return pending.value as SessionSelectionFields[TField];
  }

  const confirmed = layers.confirmed[field];
  if (confirmed && confirmed.settledSeq > layers.loadedSeq) {
    return confirmed.value as SessionSelectionFields[TField];
  }

  return layers.loaded ? layers.loaded[field] : null;
};

/** Returns `layersByKey` with one session's layers replaced by `update` of them (empty layers if none yet). */
const updateSessionSelectionLayers = (
  layersByKey: Record<string, SessionSelectionLayers>,
  sessionKey: string,
  update: (layers: SessionSelectionLayers) => SessionSelectionLayers,
): Record<string, SessionSelectionLayers> => {
  const layers = layersByKey[sessionKey] ?? EMPTY_SESSION_SELECTION_LAYERS;
  const nextLayers = update(layers);
  return nextLayers === layers ? layersByKey : { ...layersByKey, [sessionKey]: nextLayers };
};

/** Drops the in-flight choice of `field` if the save started at `startedSeq` is still the one that set it. */
const dropPendingSessionChoice = (
  layers: SessionSelectionLayers,
  field: SessionSelectionField,
  startedSeq: number,
): SessionSelectionLayers => {
  if (layers.pending[field]?.startedSeq !== startedSeq) {
    return layers;
  }

  const pending = { ...layers.pending };
  delete pending[field];
  return { ...layers, pending };
};

/** Records what the server stored for `field` and clears the save's own in-flight choice. */
const confirmSessionChoice = (
  layers: SessionSelectionLayers,
  field: SessionSelectionField,
  confirmed: { value: unknown; startedSeq: number; settledSeq: number },
): SessionSelectionLayers => {
  const withoutPending = dropPendingSessionChoice(layers, field, confirmed.startedSeq);
  const previous = withoutPending.confirmed[field];
  if (previous && previous.startedSeq > confirmed.startedSeq) {
    return withoutPending;
  }
  return { ...withoutPending, confirmed: { ...withoutPending.confirmed, [field]: confirmed } };
};

/** Reads a recorded ultracode choice from an API answer; anything but a boolean means none. */
const readResponseUltracode = (body: SessionSelectionApiResponse): boolean | null => (
  typeof body.data?.ultracode === 'boolean' ? body.data.ultracode : null
);

export function useChatProviderState({
  selectedSession,
  selectedProject: _selectedProject,
  isFocusedPane = true,
}: UseChatProviderStateArgs) {
  // Words the errors a failed session choice throws, which the model picker shows as they are.
  const { t } = useTranslation('chat');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  // The provider the composer sends under. Held here rather than read from
  // storage per render because switching it has to reset the model menu, the
  // permission mode and the session in one commit.
  const [provider, setProvider] = useState<LLMProvider>(readSelectedProvider);
  // Every provider's chosen model, not just the active one: switching provider
  // must restore the model that provider was last used with, and the catalogue
  // that validates them arrives asynchronously per provider.
  const [providerModels, setProviderModels] = useState<Record<LLMProvider, string>>(() => {
    return PROVIDERS.reduce<Record<LLMProvider, string>>((acc, targetProvider) => {
      acc[targetProvider] = localStorage.getItem(getProviderModelStorageKey(targetProvider))
        || FALLBACK_DEFAULT_MODEL[targetProvider];
      return acc;
    }, {} as Record<LLMProvider, string>);
  });
  const [providerEfforts, setProviderEfforts] = useState<Partial<Record<LLMProvider, string>>>(() => {
    return PROVIDERS.reduce<Partial<Record<LLMProvider, string>>>((acc, targetProvider) => {
      // Before the read, so a legacy `ultracode` effort arrives as xhigh and
      // the ultracode initializer below sees the switch it implied.
      migrateLegacyUltracodeEffort(targetProvider);
      acc[targetProvider] = localStorage.getItem(providerEffortStorageKey(targetProvider)) || DEFAULT_EFFORT_VALUE;
      return acc;
    }, {});
  });
  // Every provider's default ultracode switch, kept apart from the effort
  // because the two combine freely. Unlike the effort it is never reconciled
  // against the current model: a model that cannot run ultracode only hides the
  // switch, so the preference survives a detour through such a model. Must stay
  // declared after providerEfforts, whose initializer migrates legacy storage.
  const [providerUltracode, setProviderUltracode] = useState<Partial<Record<LLMProvider, boolean>>>(() => {
    return PROVIDERS.reduce<Partial<Record<LLMProvider, boolean>>>((acc, targetProvider) => {
      acc[targetProvider] = localStorage.getItem(providerUltracodeStorageKey(targetProvider)) === 'true';
      return acc;
    }, {});
  });

  /**
   * Backend-owned capability matrix keyed by provider. Drives the permission
   * mode picker (and is the extension point for future per-provider UI
   * differences) so the frontend stays free of hardcoded provider branching.
   * Null until `/api/providers/capabilities` resolves; the static fallback
   * map covers that window.
   */
  const [providerCapabilities, setProviderCapabilities] = useState<
    Partial<Record<LLMProvider, ProviderCapabilities>> | null
  >(null);

  const [providerModelCatalog, setProviderModelCatalog] = useState<
    Partial<Record<LLMProvider, ProviderModelsDefinition>>
  >({});
  const [providerModelsLoading, setProviderModelsLoading] = useState(true);

  const providerModelsRequestIdRef = useRef(0);
  // The counter that orders session-selection loads and saves; see SessionSelectionLayers.
  const sessionSelectionSeqRef = useRef(0);
  const nextSessionSelectionSeq = useCallback((): number => {
    sessionSelectionSeqRef.current += 1;
    return sessionSelectionSeqRef.current;
  }, []);

  const setStoredProviderModel = useCallback((targetProvider: LLMProvider, model: string) => {
    setProviderModels((previous) => (
      previous[targetProvider] === model
        ? previous
        : { ...previous, [targetProvider]: model }
    ));
    localStorage.setItem(getProviderModelStorageKey(targetProvider), model);
  }, []);

  const setStoredProviderEffort = useCallback((targetProvider: LLMProvider, effort: string) => {
    setProviderEfforts((previous) => (
      previous[targetProvider] === effort
        ? previous
        : { ...previous, [targetProvider]: effort }
    ));
    localStorage.setItem(providerEffortStorageKey(targetProvider), effort);
  }, []);

  const setStoredProviderUltracode = useCallback((targetProvider: LLMProvider, ultracode: boolean) => {
    setProviderUltracode((previous) => (
      previous[targetProvider] === ultracode
        ? previous
        : { ...previous, [targetProvider]: ultracode }
    ));
    localStorage.setItem(providerUltracodeStorageKey(targetProvider), ultracode ? 'true' : 'false');
  }, []);

  const loadProviderModels = useCallback(async () => {
    const requestId = providerModelsRequestIdRef.current + 1;
    providerModelsRequestIdRef.current = requestId;
    setProviderModelsLoading(true);

    try {
      // Each provider lands in the catalog as soon as it answers, so a slow
      // one (OpenCode shells out to its CLI) cannot hold back the others.
      await Promise.all(
        PROVIDERS.map(async (p) => {
          try {
            const response = await api.providers.models(p);
            const body = (await response.json()) as ProviderModelsApiResponse;
            const models = body.success ? body.data?.models : undefined;
            if (!models || providerModelsRequestIdRef.current !== requestId) {
              return;
            }

            setProviderModelCatalog((previous) => ({ ...previous, [p]: models }));
          } catch (error) {
            console.error(`Error loading ${p} models:`, error);
          }
        }),
      );
    } finally {
      if (providerModelsRequestIdRef.current === requestId) {
        setProviderModelsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadProviderModels();
  }, [loadProviderModels]);

  useEffect(() => {
    let cancelled = false;

    const loadCapabilities = async () => {
      try {
        const response = await api.providers.capabilities();
        const body = (await response.json()) as ProviderCapabilitiesApiResponse;
        if (cancelled || !body.success || !Array.isArray(body.data?.providers)) {
          return;
        }

        const byProvider: Partial<Record<LLMProvider, ProviderCapabilities>> = {};
        for (const capabilities of body.data.providers) {
          byProvider[capabilities.provider] = capabilities;
        }
        setProviderCapabilities(byProvider);
      } catch (error) {
        console.error('Error loading provider capabilities:', error);
      }
    };

    void loadCapabilities();
    return () => {
      cancelled = true;
    };
  }, []);

  const getPermissionModesForProvider = useCallback((targetProvider: LLMProvider): PermissionMode[] => {
    const capabilityModes = providerCapabilities?.[targetProvider]?.permissionModes;
    if (capabilityModes && capabilityModes.length > 0) {
      return capabilityModes as PermissionMode[];
    }
    return FALLBACK_PERMISSION_MODES[targetProvider] ?? ['default'];
  }, [providerCapabilities]);

  const getDefaultPermissionModeForProvider = useCallback((targetProvider: LLMProvider): PermissionMode => {
    const modes = getPermissionModesForProvider(targetProvider);
    const capabilityDefault = providerCapabilities?.[targetProvider]?.defaultPermissionMode as PermissionMode | undefined;
    if (capabilityDefault && modes.includes(capabilityDefault)) {
      return capabilityDefault;
    }
    return modes[0] ?? 'default';
  }, [getPermissionModesForProvider, providerCapabilities]);

  const getSupportsEffortForProvider = useCallback((targetProvider: LLMProvider): boolean => {
    const capabilitySupport = providerCapabilities?.[targetProvider]?.supportsEffort;
    if (typeof capabilitySupport === 'boolean') {
      return capabilitySupport;
    }
    return Boolean(FALLBACK_PROVIDER_EFFORT_VALUES[targetProvider]?.length);
  }, [providerCapabilities]);

  const getSupportsUltracodeForProvider = useCallback((targetProvider: LLMProvider): boolean => {
    const capabilitySupport = providerCapabilities?.[targetProvider]?.supportsUltracode;
    if (typeof capabilitySupport === 'boolean') {
      return capabilitySupport;
    }
    return FALLBACK_PROVIDER_ULTRACODE_SUPPORT[targetProvider] ?? false;
  }, [providerCapabilities]);

  const pickStoredOrCurrent = (
    storageKey: string,
    current: string,
    def: ProviderModelsDefinition,
  ): string => {
    const stored = localStorage.getItem(storageKey);
    if (stored && def.OPTIONS.some((o) => o.value === stored)) {
      return stored;
    }
    if (current && def.OPTIONS.some((o) => o.value === current)) {
      return current;
    }
    return def.DEFAULT;
  };

  const getModelOption = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): ProviderModelOption | null => {
    const definition = providerModelCatalog[targetProvider];
    if (!definition) {
      return null;
    }

    return definition.OPTIONS.find((option) => option.value === model) ?? null;
  }, [providerModelCatalog]);

  const getModelSupportsUltracode = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): boolean => {
    if (!getSupportsUltracodeForProvider(targetProvider)) {
      return false;
    }

    // Until the provider's catalog arrives the switch stays offered rather
    // than flickering in; nothing is reset either way.
    if (!providerModelCatalog[targetProvider]) {
      return true;
    }

    // A model the catalog does not list (e.g. a raw versioned id recorded by an
    // external session) cannot run it: the runtime drops ultracode for models
    // it cannot find in the catalog.
    return getModelOption(targetProvider, model)?.supportsUltracode === true;
  }, [getModelOption, getSupportsUltracodeForProvider, providerModelCatalog]);

  const getEffortOptionsForModel = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): NonNullable<ProviderModelOption['effort']>['values'] => {
    if (!getSupportsEffortForProvider(targetProvider)) {
      return [];
    }

    const option = getModelOption(targetProvider, model);
    if (option) {
      return option.effort?.values ?? [];
    }

    return toProviderEffortOptions(FALLBACK_PROVIDER_EFFORT_VALUES[targetProvider] ?? []);
  }, [getModelOption, getSupportsEffortForProvider]);

  const getAllowedEffortValues = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): string[] => (
    getEffortOptionsForModel(targetProvider, model).map((value) => value.value)
  ), [getEffortOptionsForModel]);

  const reconcileStoredEffort = useCallback((
    targetProvider: LLMProvider,
    model: string,
    currentEffort: string,
  ): string => {
    const allowedValues = getAllowedEffortValues(targetProvider, model);
    if (allowedValues.length === 0) {
      return DEFAULT_EFFORT_VALUE;
    }

    if (currentEffort === DEFAULT_EFFORT_VALUE || !currentEffort) {
      return DEFAULT_EFFORT_VALUE;
    }

    if (allowedValues.includes(currentEffort)) {
      return currentEffort;
    }

    return DEFAULT_EFFORT_VALUE;
  }, [getAllowedEffortValues]);

  // One reconciliation pass over every provider, mirroring the effort effect
  // below. This was four copy-pasted eleven-line effects, one per provider.
  useEffect(() => {
    const reconciledModels: Partial<Record<LLMProvider, string>> = {};

    for (const targetProvider of PROVIDERS) {
      const catalog = providerModelCatalog[targetProvider];
      if (!catalog) {
        continue;
      }

      const storageKey = getProviderModelStorageKey(targetProvider);
      const currentModel = providerModels[targetProvider];
      const nextModel = pickStoredOrCurrent(storageKey, currentModel, catalog);

      if (nextModel !== currentModel) {
        reconciledModels[targetProvider] = nextModel;
      }
      if (localStorage.getItem(storageKey) !== nextModel) {
        localStorage.setItem(storageKey, nextModel);
      }
    }

    if (Object.keys(reconciledModels).length > 0) {
      setProviderModels((previous) => ({ ...previous, ...reconciledModels }));
    }
  }, [providerModelCatalog, providerModels]);

  useEffect(() => {
    const nextEfforts: Partial<Record<LLMProvider, string>> = {};
    let hasUpdates = false;

    for (const targetProvider of PROVIDERS) {
      const currentEffort = providerEfforts[targetProvider] ?? DEFAULT_EFFORT_VALUE;
      const nextEffort = reconcileStoredEffort(targetProvider, providerModels[targetProvider], currentEffort);
      if (nextEffort === currentEffort) {
        continue;
      }

      nextEfforts[targetProvider] = nextEffort;
      localStorage.setItem(providerEffortStorageKey(targetProvider), nextEffort);
      hasUpdates = true;
    }

    if (hasUpdates) {
      setProviderEfforts((previous) => ({ ...previous, ...nextEfforts }));
    }
  }, [providerEfforts, providerModels, reconcileStoredEffort]);

  useEffect(() => {
    const validModes = getPermissionModesForProvider(provider);
    const sessionSavedMode = selectedSession?.id
      ? (localStorage.getItem(`permissionMode-${selectedSession.id}`) as PermissionMode | null)
      : null;
    // Fall back to the last mode picked for this provider: a brand-new chat
    // only receives its session id after the first send, so without this the
    // mode chosen beforehand would snap back to the default as soon as the
    // session id appears.
    const providerSavedMode = localStorage.getItem(`permissionMode-last-${provider}`) as PermissionMode | null;
    const savedMode = [sessionSavedMode, providerSavedMode].find(
      (mode): mode is PermissionMode => Boolean(mode && validModes.includes(mode)),
    );
    setPermissionMode(savedMode ?? getDefaultPermissionModeForProvider(provider));
  }, [selectedSession?.id, provider, getDefaultPermissionModeForProvider, getPermissionModesForProvider]);

  // Whether the pane was focused at the last pass of the effect below, so it
  // can tell the commit in which the pane gains focus.
  const wasFocusedPaneRef = useRef(isFocusedPane);

  // The composer follows the provider of the session it shows, in every pane.
  // The page-wide selected provider follows only the focused pane: a session
  // opened in the other pane must not change what new chats start with. A
  // pane that gains focus writes its provider once, as what it synced while
  // in the background was not written; when that commit also brings a session
  // of another provider, the session's provider is the one written. Both
  // writes follow the pane rather than a pick, so they are automatic.
  useEffect(() => {
    const gainedFocus = isFocusedPane && !wasFocusedPaneRef.current;
    wasFocusedPaneRef.current = isFocusedPane;

    const sessionProvider = selectedSession?.__provider;
    if (sessionProvider && sessionProvider !== provider) {
      setProvider(sessionProvider);
      if (isFocusedPane) {
        writeSelectedProvider(sessionProvider, { automatic: true });
      }
      return;
    }

    if (gainedFocus) {
      writeSelectedProvider(provider, { automatic: true });
    }
  }, [isFocusedPane, provider, selectedSession]);

  // Permission prompts belong to a session, not to the transient provider
  // selection that is synchronized after navigation.
  useEffect(() => {
    setPendingPermissionRequests((previous) =>
      previous.filter((request) => !request.sessionId || request.sessionId === selectedSession?.id),
    );
  }, [selectedSession?.id]);

  const selectPermissionMode = useCallback((nextMode: PermissionMode) => {
    setPermissionMode(nextMode);

    // Persist per provider as well as per session: a brand-new chat has no
    // session id yet, and the per-provider key keeps the choice sticky when
    // the real id arrives (and for future sessions of this provider).
    localStorage.setItem(`permissionMode-last-${provider}`, nextMode);
    if (selectedSession?.id) {
      localStorage.setItem(`permissionMode-${selectedSession.id}`, nextMode);
    }
  }, [provider, selectedSession?.id]);

  const cyclePermissionMode = useCallback(() => {
    const modes = getPermissionModesForProvider(provider);

    const currentIndex = modes.indexOf(permissionMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    selectPermissionMode(modes[nextIndex]);
  }, [permissionMode, provider, getPermissionModesForProvider, selectPermissionMode]);

  const availablePermissionModes = useMemo(
    () => getPermissionModesForProvider(provider),
    [getPermissionModesForProvider, provider],
  );

  /**
   * Both default to false until the matrix loads, so an affordance is never
   * offered and then withdrawn — and never offered at all for a provider whose
   * runtime would reject it.
   */
  const supportsMessageEditing = Boolean(providerCapabilities?.[provider]?.supportsMessageEditing);
  const supportsSessionForking = Boolean(providerCapabilities?.[provider]?.supportsSessionForking);

  /**
   * Whether the composer may attach images and other files for the active
   * provider. Unlike the two flags above these default to the fallback map
   * rather than to false, so the attachment controls of the providers that
   * accept attachments do not flicker off while the matrix loads.
   */
  const supportsImageAttachments = providerCapabilities?.[provider]?.supportsImages
    ?? FALLBACK_PROVIDER_ATTACHMENT_SUPPORT[provider]
    ?? true;
  const supportsFileAttachments = providerCapabilities?.[provider]?.supportsFiles
    ?? FALLBACK_PROVIDER_ATTACHMENT_SUPPORT[provider]
    ?? true;

  /**
   * Whether a message sent while a turn runs may go into that turn. The
   * fallback map covers only the time before the matrix loads, so Enter does
   * not change meaning mid-load; once loaded the matrix alone decides.
   */
  const supportsMidRunInsert = providerCapabilities
    ? providerCapabilities[provider]?.supportsMidRunInsert === true
    : FALLBACK_PROVIDER_MID_RUN_INSERT_SUPPORT[provider] ?? false;

  const resolvePermissionModeForProvider = useCallback((
    targetProvider: LLMProvider,
    requestedMode: PermissionMode | string,
  ): PermissionMode => {
    const validModes = getPermissionModesForProvider(targetProvider);
    return validModes.includes(requestedMode as PermissionMode)
      ? requestedMode as PermissionMode
      : getDefaultPermissionModeForProvider(targetProvider);
  }, [getDefaultPermissionModeForProvider, getPermissionModesForProvider]);

  // Model, reasoning effort and ultracode recorded for each session the user
  // has had open, layered so a slow load or save never overwrites a newer
  // answer (see SessionSelectionLayers). Keyed by session rather than holding
  // only the open one, so a save that settles after the user moved on still
  // lands on its own session and a return visit starts from what is known.
  const [sessionSelectionLayers, setSessionSelectionLayers] = useState<Record<string, SessionSelectionLayers>>({});
  const selectedSessionId = selectedSession?.id?.trim() || null;
  const selectedSessionProvider = selectedSession?.__provider ?? provider;
  const selectedSessionKey = selectedSessionId
    ? getSessionSelectionKey(selectedSessionProvider, selectedSessionId)
    : null;

  const selectedSessionLayers = selectedSessionKey ? sessionSelectionLayers[selectedSessionKey] : undefined;
  const activeSessionSelection: SessionProviderSelection | null = selectedSessionLayers && selectedSessionId
    ? {
      provider: selectedSessionProvider,
      sessionId: selectedSessionId,
      model: resolveSessionSelectionField(selectedSessionLayers, 'model'),
      effort: resolveSessionSelectionField(selectedSessionLayers, 'effort'),
      ultracode: resolveSessionSelectionField(selectedSessionLayers, 'ultracode'),
    }
    : null;
  const sessionModel = activeSessionSelection?.model ?? null;

  useEffect(() => {
    if (!selectedSessionId) {
      return;
    }

    let cancelled = false;
    const targetProvider = selectedSessionProvider;
    const targetSessionId = selectedSessionId;
    const targetSessionKey = getSessionSelectionKey(targetProvider, targetSessionId);
    const issuedSeq = nextSessionSelectionSeq();

    const loadSessionSelection = async () => {
      try {
        const response = await api.providers.sessionActiveModel(targetProvider, targetSessionId);
        const body = (await response.json()) as SessionSelectionApiResponse;
        if (cancelled) {
          return;
        }

        const resolvedModel = body.data?.model?.trim();
        const loadedFields: SessionSelectionFields = {
          model: body.success && resolvedModel && body.data?.source !== 'default' ? resolvedModel : null,
          effort: body.success ? body.data?.effort?.trim() || null : null,
          ultracode: body.success ? readResponseUltracode(body) : null,
        };
        setSessionSelectionLayers((layersByKey) => updateSessionSelectionLayers(
          layersByKey,
          targetSessionKey,
          // An older load of this session landing after a newer one changes nothing.
          (layers) => (issuedSeq <= layers.loadedSeq
            ? layers
            : { ...layers, loaded: loadedFields, loadedSeq: issuedSeq }),
        ));
      } catch (error) {
        // Whatever is already known for the session stays; with nothing known
        // the per-provider defaults show, as before any load.
        if (!cancelled) {
          console.error('Error loading the session model and reasoning effort:', error);
        }
      }
    };

    void loadSessionSelection();
    return () => {
      cancelled = true;
    };
  }, [nextSessionSelectionSeq, selectedSessionId, selectedSessionProvider]);

  /**
   * Shows one session choice at once and saves it. A successful save records
   * the stored value; a failed one drops only this choice, so the field falls
   * back to the newest known answer and other choices made meanwhile stay.
   * Loads are never cancelled for a choice: the layers merge them underneath.
   * `readLoadedFields` lets a response that carries the session's whole
   * recorded selection count as a load issued when the save started, since the
   * server read the row after that.
   */
  const saveSessionChoice = useCallback(async <TValue extends string | boolean>(
    sessionKey: string,
    field: SessionSelectionField,
    value: TValue,
    save: () => Promise<Response>,
    readStoredValue: (body: SessionSelectionApiResponse) => TValue,
    failureMessage: string,
    readLoadedFields?: (body: SessionSelectionApiResponse) => SessionSelectionFields,
  ): Promise<TValue> => {
    const startedSeq = nextSessionSelectionSeq();
    setSessionSelectionLayers((layersByKey) => updateSessionSelectionLayers(
      layersByKey,
      sessionKey,
      (layers) => ({ ...layers, pending: { ...layers.pending, [field]: { value, startedSeq } } }),
    ));

    try {
      const response = await save();
      const body = (await response.json()) as SessionSelectionApiResponse;
      if (!response.ok || !body.success) {
        throw new Error(failureMessage);
      }

      const storedValue = readStoredValue(body);
      const loadedFields = readLoadedFields?.(body);
      const settledSeq = nextSessionSelectionSeq();
      setSessionSelectionLayers((layersByKey) => updateSessionSelectionLayers(
        layersByKey,
        sessionKey,
        (layers) => {
          const withLoad = loadedFields && startedSeq > layers.loadedSeq
            ? { ...layers, loaded: loadedFields, loadedSeq: startedSeq }
            : layers;
          return confirmSessionChoice(withLoad, field, { value: storedValue, startedSeq, settledSeq });
        },
      ));
      return storedValue;
    } catch (error) {
      setSessionSelectionLayers((layersByKey) => updateSessionSelectionLayers(
        layersByKey,
        sessionKey,
        (layers) => dropPendingSessionChoice(layers, field, startedSeq),
      ));
      throw error;
    }
  }, [nextSessionSelectionSeq]);

  /**
   * Records session fields the server already changed on its own, so the open
   * session shows what it now runs: a custom-model rename moves the model, and
   * a delete moves it to the fallback and clears the recorded effort and
   * ultracode (null falls back to the per-provider defaults).
   */
  const confirmServerSessionFields = useCallback((
    sessionKey: string,
    fields: Partial<SessionSelectionFields>,
  ) => {
    const seq = nextSessionSelectionSeq();
    setSessionSelectionLayers((layersByKey) => updateSessionSelectionLayers(
      layersByKey,
      sessionKey,
      (layers) => (Object.keys(fields) as SessionSelectionField[]).reduce(
        (nextLayers, field) => confirmSessionChoice(nextLayers, field, {
          value: fields[field],
          startedSeq: seq,
          settledSeq: seq,
        }),
        layers,
      ),
    ));
  }, [nextSessionSelectionSeq]);

  /**
   * Applies a model choice.
   *
   * The pick always becomes the per-provider default so the next new chat
   * inherits it, and — when a session is open — is shown for that session at
   * once and recorded against it so reopening it later restores this model.
   */
  const selectProviderModel = useCallback(async (
    targetProvider: LLMProvider,
    model: string,
    sessionId?: string | null,
  ) => {
    setStoredProviderModel(targetProvider, model);

    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      return { scope: 'default' as const, model };
    }

    const storedModel = await saveSessionChoice(
      getSessionSelectionKey(targetProvider, normalizedSessionId),
      'model',
      model,
      () => api.providers.setSessionActiveModel(targetProvider, normalizedSessionId, model),
      (body) => body.data?.model?.trim() || model,
      t('misc.sessionModelChangeFailed'),
      // The answer also carries the session's recorded effort and ultracode.
      (body) => ({
        model: body.data?.model?.trim() || model,
        effort: body.data?.effort?.trim() || null,
        ultracode: readResponseUltracode(body),
      }),
    );
    return { scope: 'session' as const, model: storedModel };
  }, [saveSessionChoice, setStoredProviderModel, t]);

  /**
   * Applies an effort choice: it always becomes the per-provider default, and
   * with a session open it is shown at once and persisted for that session.
   */
  const selectProviderEffort = useCallback(async (
    targetProvider: LLMProvider,
    effort: string,
    sessionId?: string | null,
  ) => {
    setStoredProviderEffort(targetProvider, effort);

    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      return { scope: 'default' as const, effort };
    }

    const storedEffort = await saveSessionChoice(
      getSessionSelectionKey(targetProvider, normalizedSessionId),
      'effort',
      effort,
      () => api.providers.setSessionActiveEffort(targetProvider, normalizedSessionId, effort),
      (body) => body.data?.effort?.trim() || effort,
      t('misc.sessionEffortChangeFailed'),
    );
    return { scope: 'session' as const, effort: storedEffort };
  }, [saveSessionChoice, setStoredProviderEffort, t]);

  /**
   * Applies an ultracode on/off choice the same way selectProviderEffort
   * applies an effort: it always becomes the per-provider default, and with a
   * session open it is shown at once and persisted for that session.
   */
  const selectProviderUltracode = useCallback(async (
    targetProvider: LLMProvider,
    ultracode: boolean,
    sessionId?: string | null,
  ) => {
    setStoredProviderUltracode(targetProvider, ultracode);

    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      return { scope: 'default' as const, ultracode };
    }

    const storedUltracode = await saveSessionChoice(
      getSessionSelectionKey(targetProvider, normalizedSessionId),
      'ultracode',
      ultracode,
      () => api.providers.setSessionActiveUltracode(targetProvider, normalizedSessionId, ultracode),
      (body) => readResponseUltracode(body) ?? ultracode,
      t('misc.sessionUltracodeChangeFailed'),
    );
    return { scope: 'session' as const, ultracode: storedUltracode };
  }, [saveSessionChoice, setStoredProviderUltracode, t]);

  // The open session's model wins over the per-provider default, so switching
  // sessions shows (and sends) what each session actually runs with.
  const currentProviderModel = sessionModel ?? providerModels[provider];
  const currentProviderEffortOptions = useMemo(() => {
    return getEffortOptionsForModel(provider, currentProviderModel);
  }, [currentProviderModel, getEffortOptionsForModel, provider]);
  const currentProviderEffort = useMemo(() => {
    return reconcileStoredEffort(
      provider,
      currentProviderModel,
      activeSessionSelection?.effort
        ?? providerEfforts[provider]
        ?? DEFAULT_EFFORT_VALUE,
    );
  }, [activeSessionSelection?.effort, currentProviderModel, provider, providerEfforts, reconcileStoredEffort]);
  // NULL hides the switch and keeps ultracode out of sends: the provider or the
  // current model cannot run it. Otherwise the session's recorded choice wins
  // over the per-provider default, as with the effort.
  const currentProviderUltracode = useMemo<boolean | null>(() => {
    if (!getModelSupportsUltracode(provider, currentProviderModel)) {
      return null;
    }
    return activeSessionSelection?.ultracode ?? providerUltracode[provider] ?? false;
  }, [activeSessionSelection?.ultracode, currentProviderModel, getModelSupportsUltracode, provider, providerUltracode]);
  const currentProviderModelOptions = useMemo(
    () => providerModelCatalog[provider]?.OPTIONS ?? [],
    [provider, providerModelCatalog],
  );

  const applyProviderCatalog = useCallback((
    targetProvider: LLMProvider,
    models: ProviderModelsDefinition,
  ) => {
    setProviderModelCatalog((previous) => ({
      ...previous,
      [targetProvider]: models,
    }));
  }, []);

  const readModelMutationResponse = useCallback(async (
    response: Response,
  ): Promise<Required<Pick<NonNullable<ProviderModelMutationApiResponse['data']>, 'model' | 'models'>>> => {
    const body = (await response.json()) as ProviderModelMutationApiResponse;
    if (!response.ok || !body.success || !body.data?.model || !body.data.models) {
      throw new Error(body.error?.message || 'Unable to save this model.');
    }

    return {
      model: body.data.model,
      models: body.data.models,
    };
  }, []);

  const createCustomModel = useCallback(async (
    targetProvider: LLMProvider,
    input: CustomProviderModelInput,
  ) => {
    const response = await api.providers.createModel(targetProvider, input);
    const result = await readModelMutationResponse(response);
    applyProviderCatalog(targetProvider, result.models);
  }, [applyProviderCatalog, readModelMutationResponse]);

  const updateCustomModel = useCallback(async (
    targetProvider: LLMProvider,
    existing: ProviderModelOption,
    input: CustomProviderModelInput,
  ) => {
    if (!existing.recordId) {
      throw new Error('This model cannot be edited.');
    }

    const response = await api.providers.updateModel(targetProvider, existing.recordId, input);
    const result = await readModelMutationResponse(response);
    applyProviderCatalog(targetProvider, result.models);

    if (providerModels[targetProvider] === existing.value) {
      setStoredProviderModel(targetProvider, result.model.value);
    }
    if (provider === targetProvider && sessionModel === existing.value && selectedSessionKey) {
      confirmServerSessionFields(selectedSessionKey, { model: result.model.value });
    }
  }, [
    applyProviderCatalog,
    confirmServerSessionFields,
    provider,
    providerModels,
    readModelMutationResponse,
    selectedSessionKey,
    sessionModel,
    setStoredProviderModel,
  ]);

  const removeCustomModel = useCallback(async (
    targetProvider: LLMProvider,
    existing: ProviderModelOption,
  ) => {
    if (!existing.recordId) {
      throw new Error('This model cannot be deleted.');
    }

    const response = await api.providers.deleteModel(targetProvider, existing.recordId);
    const result = await readModelMutationResponse(response);
    applyProviderCatalog(targetProvider, result.models);

    if (providerModels[targetProvider] === existing.value) {
      setStoredProviderModel(targetProvider, result.models.DEFAULT);
    }
    if (provider === targetProvider && sessionModel === existing.value && selectedSessionKey) {
      // Mirrors the server, which also clears the session's effort and ultracode.
      confirmServerSessionFields(selectedSessionKey, { model: result.models.DEFAULT, effort: null, ultracode: null });
    }
  }, [
    applyProviderCatalog,
    confirmServerSessionFields,
    provider,
    providerModels,
    readModelMutationResponse,
    selectedSessionKey,
    sessionModel,
    setStoredProviderModel,
  ]);

  /**
   * Applies the server's catalog for the new flag. A remembered per-provider
   * model that the catalog no longer lists is moved to its `DEFAULT` by the
   * reconciliation effect above; an open session keeps its recorded model.
   */
  const setCustomModelsOnly = useCallback(async (
    targetProvider: LLMProvider,
    enabled: boolean,
  ) => {
    const response = await api.providers.setCustomModelsOnly(targetProvider, enabled);
    const body = (await response.json()) as ProviderModelMutationApiResponse;
    if (!response.ok || !body.success || !body.data?.models) {
      throw new Error(body.error?.message || 'Unable to change this setting.');
    }

    applyProviderCatalog(targetProvider, body.data.models);
  }, [applyProviderCatalog]);

  const providerModelActions = useMemo<ProviderModelActions>(() => ({
    create: createCustomModel,
    update: updateCustomModel,
    remove: removeCustomModel,
    setCustomModelsOnly,
  }), [createCustomModel, removeCustomModel, setCustomModelsOnly, updateCustomModel]);

  return {
    provider,
    setProvider,
    providerModels,
    setStoredProviderModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    currentProviderUltracode,
    currentProviderModel,
    currentProviderModelOptions,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    availablePermissionModes,
    selectPermissionMode,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelsLoading,
    providerModelActions,
    selectProviderModel,
    selectProviderEffort,
    selectProviderUltracode,
    resolvePermissionModeForProvider,
    supportsMessageEditing,
    supportsSessionForking,
    supportsImageAttachments,
    supportsFileAttachments,
    supportsMidRunInsert,
  };
}
