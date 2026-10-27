import { clsx, type ClassValue } from 'clsx';
import type { TFunction } from 'i18next';
import { twMerge } from 'tailwind-merge';

import type {
  AppTab,
  LLMProvider,
  Project,
  ProjectSession,
  QuickSettingsTab,
  SessionDragPayload,
  SlashCommand,
  UntitledPaneTabLabels,
  WorkspacePaneSide,
  WorkspaceSessionTab,
} from '@/shared/types';

//----------------- DEPLOYMENT MODE ------------

/**
 * Indicates whether the app runs in Platform mode (hosted) or OSS mode (self-hosted).
 * Read it to hide or gate features that only exist in one of the two deployments.
 */
export const IS_PLATFORM = import.meta.env?.VITE_IS_PLATFORM === 'true';

// ---------------------------

//----------------- TAILWIND CLASS COMPOSITION ------------

/**
 * Merges conditional class names and resolves conflicting Tailwind utilities so the
 * last-specified utility wins. Use it for every className built from props or state.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------

//----------------- CLIPBOARD ------------

/**
 * Copies text with `document.execCommand`, the only path that works in browsers or
 * contexts where the async Clipboard API is unavailable. Private to `copyTextToClipboard`.
 */
function fallbackCopyToClipboard(text: string): boolean {
  if (!text || typeof document === 'undefined') {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
  }

  return copied;
}

/**
 * Copies text to the clipboard, falling back to a hidden textarea when the Clipboard API
 * is blocked. Resolves to whether the copy succeeded so callers can show copied feedback.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) {
    return false;
  }

  let copied = false;

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch {
    copied = false;
  }

  if (!copied) {
    copied = fallbackCopyToClipboard(text);
  }

  return copied;
}

// ---------------------------

//----------------- NOTIFICATION SOUND ------------

/** localStorage key holding the user's completion-sound preference. Private to the sound helpers. */
const NOTIFICATION_SOUND_ENABLED_STORAGE_KEY = 'notificationSoundEnabled';

/** The browser's AudioContext constructor, including the webkit-prefixed fallback; undefined outside a browser. */
const AudioContextConstructor =
  typeof window !== 'undefined'
    ? window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    : undefined;

/** Lazily created and reused, because browsers cap how many AudioContexts a page may open. */
let audioContext: AudioContext | null = null;

/** Reports whether the user has left completion sounds on; defaults to on when unset. */
export const isNotificationSoundEnabled = (): boolean => {
  if (typeof localStorage === 'undefined') {
    return true;
  }

  return localStorage.getItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY) !== 'false';
};

/** Persists the user's completion-sound preference; call it from settings toggles. */
export const setNotificationSoundEnabled = (enabled: boolean): void => {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY, String(enabled));
};

/** Returns the shared AudioContext, creating it on first use. Private to the sound helpers. */
const getAudioContext = (): AudioContext | null => {
  if (!AudioContextConstructor) {
    return null;
  }

  if (!audioContext) {
    audioContext = new AudioContextConstructor();
  }

  return audioContext;
};

/** Schedules one synthesized sine tone on the shared context. Private to `playNotificationSound`. */
const playTone = (
  context: AudioContext,
  frequency: number,
  startsAt: number,
  duration: number,
  peakVolume: number,
): void => {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, startsAt);

  // Shape the volume so the synthesized tone starts and stops cleanly.
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(peakVolume, startsAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startsAt);
  oscillator.stop(startsAt + duration + 0.02);
};

/**
 * Plays the two-tone notification chime, honouring the user's preference unless `force`
 * is set (settings previews pass `force` so the user can hear the sound while it is off).
 */
export const playNotificationSound = async ({ force = false } = {}): Promise<void> => {
  if (!force && !isNotificationSoundEnabled()) {
    return;
  }

  const context = getAudioContext();
  if (!context) {
    return;
  }

  try {
    if (context.state === 'suspended') {
      await context.resume();
    }

    const now = context.currentTime;
    playTone(context, 740, now, 0.12, 0.075);
    playTone(context, 988, now + 0.11, 0.16, 0.06);
  } catch (error) {
    // Browsers may block audio until the page receives a user gesture.
    console.warn('Unable to play notification sound:', error);
  }
};

/** Plays the chime for a finished assistant turn; named for the chat call site it serves. */
export const playChatCompletionSound = (options = {}): Promise<void> => playNotificationSound(options);

// ---------------------------

//----------------- DOCUMENT TITLE ------------

/** Browser tab title shown when no project or session is selected. Private to the title helpers. */
const DEFAULT_PAGE_TITLE = 'CloudCLI UI';

/**
 * Resolves the human-readable label for a session: the persisted `summary` (the custom
 * name the sessions API returns for every provider, Cursor included), else the `name` a
 * Cursor session object may carry locally, else the provider's placeholder. Reads the
 * same fields in the same order as the sidebar row, so the header, document title and
 * sidebar never disagree about a session's name.
 */
export const getSessionTitle = (session: ProjectSession): string => {
  const title = (session.summary as string) || (session.name as string);
  if (session.__provider === 'cursor') {
    return title || 'Untitled Session';
  }

  return title || 'New Session';
};

/**
 * Builds the browser tab title for the current selection: the session title when one is
 * open, otherwise the project name, otherwise the app name.
 */
export const getPageTitle = (
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): string => {
  if (selectedSession) {
    return getSessionTitle(selectedSession);
  }

  const displayName = selectedProject?.displayName?.trim();
  return displayName ? `${displayName} - ${DEFAULT_PAGE_TITLE}` : DEFAULT_PAGE_TITLE;
};

/**
 * The page part of the tab title, as last given to `setDocumentPageTitle`. It starts as the
 * static `<title>` of index.html, which the login and setup screens keep. Private to the title helpers.
 */
let documentPageTitle = DEFAULT_PAGE_TITLE;

/** Label of the non-production deployment that leads the tab title; null in production. Private to the title helpers. */
let documentTitleEnvironmentLabel: string | null = null;

/** Writes the tab title from the two parts above. Private to the title setters. */
const applyDocumentTitle = (): void => {
  if (typeof document === 'undefined') {
    return;
  }

  document.title = documentTitleEnvironmentLabel
    ? `${documentTitleEnvironmentLabel} · ${documentPageTitle}`
    : documentPageTitle;
};

/**
 * Sets the browser tab title of the current page. Outside production the deployment
 * environment label stays in front of it ("Stage · My session"); in production the title
 * is written exactly as given. Write page titles through here rather than assigning
 * `document.title`, which would drop the label. Called by project-workspace's ProjectEffects.
 */
export const setDocumentPageTitle = (title: string): void => {
  documentPageTitle = title;
  applyDocumentTitle();
};

/**
 * Sets the label that leads the browser tab title, or removes it with null; production
 * passes null, so its titles stay exactly as the page sets them. The title is rewritten
 * only when the label changes. Used by the `useDeploymentEnvironmentTitle` shared hook.
 */
export const setDocumentTitleEnvironmentLabel = (label: string | null): void => {
  if (label === documentTitleEnvironmentLabel) {
    return;
  }

  documentTitleEnvironmentLabel = label;
  applyDocumentTitle();
};

// ---------------------------

//----------------- DEPLOYMENT ENVIRONMENT ------------

/**
 * Deployment environment ids (lower-cased) that have a translated label, mapped to the
 * `common` namespace key holding it. A Map, so an id such as "constructor" cannot match an
 * Object prototype member. Private to `getDeploymentEnvironmentLabel`.
 */
const DEPLOYMENT_ENVIRONMENT_LABEL_KEYS = new Map<string, string>([
  ['staging', 'deploymentEnvironment.staging'],
  ['stage', 'deploymentEnvironment.staging'],
  ['preprod', 'deploymentEnvironment.staging'],
  ['pre-production', 'deploymentEnvironment.staging'],
  ['development', 'deploymentEnvironment.development'],
  ['dev', 'deploymentEnvironment.development'],
  ['test', 'deploymentEnvironment.test'],
  ['testing', 'deploymentEnvironment.test'],
]);

/**
 * Turns the deployment environment id reported by `/health` into the short label shown in
 * the tab title and the environment badge: the translated name of a well-known id, matched
 * regardless of case (staging, stage, preprod and pre-production give "Stage" / "预发布"),
 * otherwise the id exactly as the operator wrote it. The key is read from the `common`
 * namespace whichever namespace `t` defaults to. Used by the DeploymentEnvironmentBadge
 * shared UI component and the `useDeploymentEnvironmentTitle` shared hook.
 */
export const getDeploymentEnvironmentLabel = (environment: string, t: TFunction): string => {
  const labelKey = DEPLOYMENT_ENVIRONMENT_LABEL_KEYS.get(environment.trim().toLowerCase());
  return labelKey ? t(labelKey, { ns: 'common' }) : environment;
};

// ---------------------------

//----------------- SLASH COMMANDS ------------

/**
 * Whether a slash command is a provider skill (as opposed to a built-in or a
 * custom `.md` command). Skills are mapped with `type: 'skill'`; the metadata
 * check catches entries that only carry the skill marker there. Used wherever
 * commands are grouped or executed differently by kind.
 */
export const isSkillCommand = (command: SlashCommand): boolean =>
  command.type === 'skill' || command.metadata?.type === 'skill';

// ---------------------------

//----------------- QUICK SETTINGS PANEL ------------

/** DOM id of a quick settings tab button; pairs with `getQuickSettingsTabPanelId` for aria-controls / aria-labelledby. */
export const getQuickSettingsTabId = (tab: QuickSettingsTab): string => `quick-settings-tab-${tab}`;

/** DOM id of the tabpanel a quick settings tab controls; pairs with `getQuickSettingsTabId`. */
export const getQuickSettingsTabPanelId = (tab: QuickSettingsTab): string => `quick-settings-tabpanel-${tab}`;

// ---------------------------

//----------------- CHAT RUN OPTIONS ------------

/**
 * The model, reasoning-effort and ultracode part of a chat run's `options`,
 * shared by a live send (the chat composer state) and a scheduled message
 * (ChatInterface) so both follow one rule: `ultracode` is included only as a
 * boolean, i.e. only when the selected model can run it, and a `null` or
 * `undefined` switch leaves the key out so the runtime makes no choice.
 * `ultracode` is a required key so every caller has to pass the switch on.
 */
export const buildModelRunOptions = (selection: {
  model: string;
  effort: string;
  ultracode: boolean | null | undefined;
}): { model: string; effort: string; ultracode?: boolean } => ({
  model: selection.model,
  effort: selection.effort,
  ...(typeof selection.ultracode === 'boolean' ? { ultracode: selection.ultracode } : {}),
});

// ---------------------------

//----------------- PROVIDER MODEL PREFERENCE ------------

/**
 * localStorage key holding the user's default model for one provider (the
 * model the chat composer last picked for it). Written by the chat module's
 * provider state; read by the Shell tab so an agy terminal starts on the same
 * model as the chat.
 */
export const getProviderModelStorageKey = (provider: LLMProvider): string => `${provider}-model`;

// ---------------------------

//----------------- KEYBOARD SHORTCUTS ------------

/**
 * True on macOS/iOS/iPadOS, where the primary modifier is the Command key. Evaluated at
 * call time rather than at import, so it always reflects the current navigator. Used by
 * `formatShortcut` and by keyboard handlers that pick `metaKey` or `ctrlKey` as Mod.
 */
export const isApplePlatform = (): boolean => {
  if (typeof navigator === 'undefined') {
    return false;
  }

  // userAgentData is Chromium-only; Safari, on every iPhone and iPad, reports navigator.platform.
  const { userAgentData } = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = userAgentData?.platform || navigator.platform || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
};

/** Glyphs Apple platforms draw for the reserved shortcut tokens. A Map, so a key label such as "constructor" cannot match an Object prototype member. Private to `formatShortcut`. */
const APPLE_SHORTCUT_GLYPHS = new Map<string, string>([
  ['mod', '⌘'],
  ['shift', '⇧'],
  ['alt', '⌥'],
  ['enter', '↵'],
]);

/** Words other platforms spell the reserved shortcut tokens with. Private to `formatShortcut`. */
const SHORTCUT_WORDS = new Map<string, string>([
  ['mod', 'Ctrl'],
  ['shift', 'Shift'],
  ['alt', 'Alt'],
  ['enter', 'Enter'],
]);

/**
 * Renders a shortcut for tooltips, menus and hints: ['mod','shift','enter'] -> '⌘⇧↵' on Apple,
 * 'Ctrl+Shift+Enter' elsewhere. Tokens: 'mod' | 'shift' | 'alt' | 'enter' (matched case-insensitively)
 * or any key label, which is shown as given except that a single letter is upper-cased.
 */
export const formatShortcut = (keys: readonly string[]): string => {
  const isApple = isApplePlatform();
  const reservedLabels = isApple ? APPLE_SHORTCUT_GLYPHS : SHORTCUT_WORDS;
  const labels = keys.map((key) => reservedLabels.get(key.toLowerCase()) ?? (key.length === 1 ? key.toUpperCase() : key));
  return labels.join(isApple ? '' : '+');
};

// ---------------------------

//----------------- WORKSPACE PANES ------------

/** The side across from `side`. Used wherever the split workspace acts on "the other pane". */
export const getOtherPaneSide = (side: WorkspacePaneSide): WorkspacePaneSide => (side === 'left' ? 'right' : 'left');

/**
 * The provider a session object belongs to: its `__provider`, else its `provider`, else 'claude' (blank
 * values count as missing). The one rule project-workspace uses when it puts a session in a tab, resolves
 * a session id, or lists recent conversations.
 */
export const readSessionProvider = (session: ProjectSession): LLMProvider => {
  const provider = session.__provider ?? session.provider;
  return typeof provider === 'string' && provider.trim() ? provider as LLMProvider : 'claude';
};

/** MIME type a dragged sidebar row or pane tab carries its SessionDragPayload under. Private to the session drag helpers. */
const SESSION_DRAG_MIME = 'application/x-cloudcli-session';

/** Resolves a link against the page, because text/uri-list only accepts absolute URLs. Private to `writeSessionDragPayload`. */
const toAbsoluteUrl = (href: string): string => {
  try {
    return new URL(href, window.location.href).toString();
  } catch {
    return href;
  }
};

/**
 * Writes a session/tab drag payload under the app MIME; pass href for links so text/uri-list keeps
 * working outside the app (another browser tab, the address bar). Call it from a dragstart handler.
 */
export const writeSessionDragPayload = (dataTransfer: DataTransfer, payload: SessionDragPayload, href?: string): void => {
  // Only the documented fields travel, so a caller handing over a richer object leaks nothing.
  const serialized: SessionDragPayload = {
    sessionId: payload.sessionId,
    projectId: payload.projectId,
    provider: payload.provider,
    title: payload.title,
    ...(payload.fromTab ? { fromTab: { side: payload.fromTab.side, tabKey: payload.fromTab.tabKey } } : {}),
  };
  dataTransfer.setData(SESSION_DRAG_MIME, JSON.stringify(serialized));

  if (href) {
    const url = toAbsoluteUrl(href);
    dataTransfer.setData('text/uri-list', url);
    dataTransfer.setData('text/plain', url);
  }
};

/** Reads the payload `writeSessionDragPayload` wrote, on drop; null when absent or malformed. */
export const readSessionDragPayload = (dataTransfer: DataTransfer): SessionDragPayload | null => {
  let raw = '';
  try {
    raw = dataTransfer.getData(SESSION_DRAG_MIME);
  } catch {
    return null;
  }
  if (!raw) {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const isNullableId = (id: unknown): id is string | null => id === null || (typeof id === 'string' && id.length > 0);
  if (!isNullableId(candidate.sessionId) || !isNullableId(candidate.projectId)) {
    return null;
  }
  if (typeof candidate.provider !== 'string' || !candidate.provider) {
    return null;
  }

  const payload: SessionDragPayload = {
    sessionId: candidate.sessionId,
    projectId: candidate.projectId,
    provider: candidate.provider as LLMProvider,
    title: typeof candidate.title === 'string' ? candidate.title : '',
  };

  if (candidate.fromTab !== undefined) {
    const fromTab = candidate.fromTab as Record<string, unknown> | null;
    if (
      !fromTab
      || typeof fromTab !== 'object'
      || (fromTab.side !== 'left' && fromTab.side !== 'right')
      || typeof fromTab.tabKey !== 'string'
      || !fromTab.tabKey
    ) {
      return null;
    }
    payload.fromTab = { side: fromTab.side, tabKey: fromTab.tabKey };
  }

  return payload;
};

/** Whether a drag carries a session payload; usable during dragenter/dragover, where types are readable but data is not. */
export const hasSessionDragPayload = (dataTransfer: DataTransfer | null): boolean =>
  Boolean(dataTransfer && Array.from(dataTransfer.types ?? []).includes(SESSION_DRAG_MIME));

/** `pane-${side}-${id}` inside a pane, unchanged outside, so two panes never share DOM ids (tool-result anchors, for one). */
export const getPaneScopedDomId = (side: WorkspacePaneSide | null, id: string): string =>
  (side ? `pane-${side}-${id}` : id);

/**
 * A pane tab's label: labels.newChat for a draft; otherwise liveTitle (the session's title in the
 * projects list, where renames and generated summaries land), then the tab's own snapshot, then
 * labels.missing for a missing session or the generic session title. Each caller looks the live title
 * up its own way: project-workspace's ProjectMainRegion (tab bar) and ProjectCommandPalette (Open tabs).
 */
export const resolvePaneTabTitle = (
  tab: WorkspaceSessionTab,
  liveTitle: string | null | undefined,
  labels: UntitledPaneTabLabels,
): string => {
  if (!tab.sessionId) {
    return labels.newChat;
  }
  const title = liveTitle || tab.title;
  if (title) {
    return title;
  }
  return tab.isMissing
    ? labels.missing
    : getSessionTitle(tab.session ?? { id: tab.sessionId, __provider: tab.provider });
};

/**
 * Lends a pane root the tabindex programmatic focus needs, focuses it, and takes the tabindex back as
 * soon as focus leaves or a pointer presses inside: a root that stayed focusable would take the focus
 * of every click on plain text in the pane, and keyboard scrolling of the scroll area under it with it.
 * Private to `focusWorkspacePaneElement`.
 */
const focusPaneRoot = (pane: HTMLElement): void => {
  if (!pane.hasAttribute('tabindex')) {
    pane.setAttribute('tabindex', '-1');
    const release = () => {
      pane.removeAttribute('tabindex');
      pane.removeEventListener('blur', release);
      pane.removeEventListener('pointerdown', release, true);
    };
    pane.addEventListener('blur', release);
    // Capture, before the press's own focus step, so the click focuses what it would without the root.
    pane.addEventListener('pointerdown', release, true);
  }
  pane.focus();
};

/**
 * Puts DOM focus in a workspace pane: the composer on the Chat view, otherwise (or when the composer
 * cannot take focus, e.g. hidden behind an editor expanded over the chat) the pane root, which is only
 * made focusable for that moment (pane DOM contract: data-workspace-pane, data-slot="prompt-input-textarea").
 * Does nothing when the pane is not on the page; keepFocusInside also leaves focus alone when it is
 * already somewhere inside the pane. Callers run it once the layout change has rendered: project-workspace's
 * useWorkspaceShortcuts (Mod+1/2 always move; after Mod+\ focus already inside the pane stays) and
 * ProjectCommandPalette (pane commands, keepFocusInside).
 */
export const focusWorkspacePaneElement = (
  side: WorkspacePaneSide,
  view: AppTab | null | undefined,
  { keepFocusInside = false }: { keepFocusInside?: boolean } = {},
): void => {
  const pane = document.querySelector<HTMLElement>(`[data-workspace-pane="${side}"]`);
  if (!pane || (keepFocusInside && pane.contains(document.activeElement))) {
    return;
  }
  const composer = view === 'chat' ? pane.querySelector<HTMLElement>('[data-slot="prompt-input-textarea"]') : null;
  if (composer) {
    composer.focus();
    // focus() does nothing on a hidden or disabled field; the pane then takes focus itself.
    if (document.activeElement === composer) {
      return;
    }
  }
  focusPaneRoot(pane);
};
