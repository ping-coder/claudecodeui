import { clsx, type ClassValue } from 'clsx';
import type { TFunction } from 'i18next';
import { twMerge } from 'tailwind-merge';

import type { LLMProvider, Project, ProjectSession, QuickSettingsTab, SlashCommand } from '@/shared/types';

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
 * `document.title`, which would drop the label. Used by the sidebar module's project list.
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
