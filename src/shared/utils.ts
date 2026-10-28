import { clsx, type ClassValue } from 'clsx';
import type { TFunction } from 'i18next';
import { twMerge } from 'tailwind-merge';

import type {
  AppTab,
  DocumentTitleStatus,
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

/**
 * How long a chime waits for the AudioContext to resume. Browsers leave resume() pending, not rejected, while
 * their autoplay policy holds a page back (no user gesture yet), and a caller waiting on the chime's answer
 * (run-notifications, before it posts a system notification) must not wait forever. Private to `playNotificationSound`.
 */
const NOTIFICATION_SOUND_RESUME_TIMEOUT_MS = 1000;

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

/** Persists the user's completion-sound preference; called by the settings page and by run-notifications, which mirrors the server's `channels.sound` on mount. */
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
 * Resumes the shared context before a chime: true once it runs, false while the autoplay policy still holds it
 * back after NOTIFICATION_SOUND_RESUME_TIMEOUT_MS. A rejected resume() (a closed context) rejects this too.
 * Private to `playNotificationSound`.
 */
const resumeAudioContextForChime = async (context: AudioContext): Promise<boolean> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const heldBack = new Promise<boolean>((resolve) => {
    timeoutId = setTimeout(() => resolve(false), NOTIFICATION_SOUND_RESUME_TIMEOUT_MS);
  });

  try {
    return await Promise.race([context.resume().then(() => true), heldBack]);
  } finally {
    clearTimeout(timeoutId);
  }
};

/**
 * Plays the two-tone notification chime, honouring the user's preference unless `force`
 * is set (settings previews pass `force` so the user can hear the sound while it is off).
 * Resolves to whether the tones were scheduled: false while the sound is off, without Web
 * Audio, when the context does not resume in time, or when resuming or playing throws, so
 * run-notifications can give a system notification its own sound when the page made none.
 */
export const playNotificationSound = async ({ force = false }: { force?: boolean } = {}): Promise<boolean> => {
  if (!force && !isNotificationSoundEnabled()) {
    return false;
  }

  try {
    const context = getAudioContext();
    if (!context) {
      return false;
    }

    // Tones go only onto a running context: ones scheduled on a held-back context
    // would play late, whenever a later gesture finally resumes it.
    if (context.state !== 'running' && !(await resumeAudioContextForChime(context))) {
      return false;
    }

    const now = context.currentTime;
    playTone(context, 740, now, 0.12, 0.075);
    playTone(context, 988, now + 0.11, 0.16, 0.06);
    return true;
  } catch (error) {
    // Browsers may block audio until the page receives a user gesture.
    console.warn('Unable to play notification sound:', error);
    return false;
  }
};

/** Task-completion chime, used by run-notifications and the settings page's sound preview; resolves like `playNotificationSound`. */
export const playChatCompletionSound = (options: { force?: boolean } = {}): Promise<boolean> =>
  playNotificationSound(options);

/**
 * Unlocks the chime ahead of time: while the sound is on, takes the shared AudioContext (creating it on first
 * use) and resumes it unless it is already running, so a later chime that plays outside any user gesture is
 * heard, also after iOS interrupted the context. Errors are swallowed; the next gesture tries again. Call it
 * from user-gesture handlers: run-notifications does on every pointerdown and keydown. A no-op while the sound is off.
 */
export const primeNotificationSound = (): void => {
  if (!isNotificationSoundEnabled()) {
    return;
  }

  try {
    const context = getAudioContext();
    if (context && context.state !== 'running') {
      void context.resume().catch(() => undefined);
    }
  } catch {
    // Creating or resuming a context can throw (a closed context, too many contexts).
  }
};

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
 * A session's live title in the loaded projects: its `summary` (where renames and generated
 * summaries land), else its `name`, trimmed, a blank one counting as missing; null when no
 * loaded project lists the session with a title. Unlike `getSessionTitle` it never falls back
 * to a placeholder, so a caller can try its own next source (a pane tab's snapshot). Used by
 * project-workspace's ProjectEffects (page title), useRunningSessionTitle (the session the
 * running part is about) and ProjectRunNotifications (alert labels).
 */
export const findLiveSessionTitle = (sessionId: string, projects: readonly Project[]): string | null => {
  for (const project of projects) {
    for (const session of project.sessions ?? []) {
      if (session.id !== sessionId) {
        continue;
      }

      const summary = typeof session.summary === 'string' ? session.summary.trim() : '';
      const name = typeof session.name === 'string' ? session.name.trim() : '';
      if (summary || name) {
        return summary || name;
      }
    }
  }

  return null;
};

/**
 * The page part of the tab title, as last given to `setDocumentPageTitle`. It starts as the
 * static `<title>` of index.html, which the login and setup screens keep. Private to the title helpers.
 */
let documentPageTitle = DEFAULT_PAGE_TITLE;

/** Label of the non-production deployment, written after the status marker and ahead of the rest of the tab title; null in production. Private to the title helpers. */
let documentTitleEnvironmentLabel: string | null = null;

/** The running part of the tab title (the latest running session and its marker), as last given to `setDocumentTitleActivity`; null while nothing runs. Private to the title helpers. */
let documentTitleActivity: DocumentTitleStatus | null = null;

/** The alert part of the tab title (unread finished-run alerts), as last given to `setDocumentTitleAlert`; wins over the running part; null when there is none and between blinks. Private to the title helpers. */
let documentTitleAlert: DocumentTitleStatus | null = null;

/**
 * Writes the tab title from the four parts above. The status is the alert, else the running part:
 * with one the title reads "marker label · subject", without one "label · page title"; production
 * has no label, so no "label · " either. Private to the title setters.
 */
const applyDocumentTitle = (): void => {
  if (typeof document === 'undefined') {
    return;
  }

  const environmentPrefix = documentTitleEnvironmentLabel ? `${documentTitleEnvironmentLabel} · ` : '';
  const status = documentTitleAlert ?? documentTitleActivity;
  document.title = status
    ? `${status.marker} ${environmentPrefix}${status.subject}`
    : `${environmentPrefix}${documentPageTitle}`;
};

/** Whether two status parts read the same, so repeating one leaves the title alone. Private to the status setters. */
const isSameDocumentTitleStatus = (current: DocumentTitleStatus | null, next: DocumentTitleStatus | null): boolean => {
  if (!current || !next) {
    return current === next;
  }

  return current.marker === next.marker && current.subject === next.subject;
};

/**
 * Sets the page part of the browser tab title, or puts the app name back with null (the
 * workspace passes null as it unmounts, so a signed-out tab does not keep the last session's
 * name). It shows while no status part is set; outside production the deployment environment
 * label stays in front of it ("Stage · My session"), and in production the title is written
 * exactly as given. Every call rewrites the title. Write page titles through here rather than
 * assigning `document.title`, which would drop the label and the status marker. Called by
 * project-workspace's ProjectEffects.
 */
export const setDocumentPageTitle = (title: string | null): void => {
  documentPageTitle = title ?? DEFAULT_PAGE_TITLE;
  applyDocumentTitle();
};

/**
 * Sets the deployment environment label of the browser tab title, or removes it with null;
 * production passes null, so its titles stay exactly as the page sets them. The label leads
 * the title ("Stage · My session"), except that a status marker goes before it ("[Running]
 * Stage · My session"). The title is rewritten only when the label changes. Used by the
 * `useDeploymentEnvironmentTitle` shared hook.
 */
export const setDocumentTitleEnvironmentLabel = (label: string | null): void => {
  if (label === documentTitleEnvironmentLabel) {
    return;
  }

  documentTitleEnvironmentLabel = label;
  applyDocumentTitle();
};

/**
 * Sets the running part of the browser tab title, a localized marker and the session it is
 * about ("[Running 2] Fix login bug"), or clears it with null. While set, and no alert is,
 * it shows in place of the page title. Returns early, leaving the title alone, when the marker
 * and subject are unchanged. Called by project-workspace's useRunningSessionTitle, which
 * ProjectEffects runs.
 */
export const setDocumentTitleActivity = (status: DocumentTitleStatus | null): void => {
  if (isSameDocumentTitleStatus(documentTitleActivity, status)) {
    return;
  }

  documentTitleActivity = status ? { marker: status.marker, subject: status.subject } : null;
  applyDocumentTitle();
};

/**
 * Sets the alert part of the browser tab title, unread finished-run alerts ("[Done] Fix login
 * bug"), or clears it with null. While set it shows in place of the running part and the page
 * title. Returns early, leaving the title alone, when the marker and subject are unchanged, so
 * only a blinking alert rewrites the title every second. Called by run-notifications.
 */
export const setDocumentTitleAlert = (status: DocumentTitleStatus | null): void => {
  if (isSameDocumentTitleStatus(documentTitleAlert, status)) {
    return;
  }

  documentTitleAlert = status ? { marker: status.marker, subject: status.subject } : null;
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
 * shared UI component, the `useDeploymentEnvironmentTitle` shared hook and run-notifications
 * (the system notification title).
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

/** The tabindex loans focusWithLentTabIndex has outstanding, by element, so a second call shares the first one. */
const lentTabIndexReleases = new WeakMap<HTMLElement, () => void>();

/**
 * Focuses an element that is not focusable on its own (a workspace pane root, the immersive sidebar
 * drawer) by lending it tabindex="-1". The loan is taken back once a pointer presses inside the element
 * (capture phase, before the press's own focus step, so the click focuses what it would without it) or
 * focus moves on to something inside it: an element that stayed focusable would take the focus of every
 * click on plain text in it, and the keyboard scrolling of the scroll area under that text with it. Focus
 * leaving for somewhere else keeps the loan, so a dialog opened from here (the command palette) can hand
 * focus back when it closes, and so can the browser when its window is left and entered again. Returns a
 * function that takes the loan back at once (a no-op for an element with a tabindex of its own). Used by
 * focusWorkspacePaneElement and project-workspace's ProjectSidebarRegion (its drawer, while it is out).
 */
export const focusWithLentTabIndex = (element: HTMLElement, options?: FocusOptions): (() => void) => {
  let release = lentTabIndexReleases.get(element);
  if (!release && !element.hasAttribute('tabindex')) {
    const takeBack = () => {
      if (lentTabIndexReleases.get(element) !== takeBack) {
        return;
      }
      lentTabIndexReleases.delete(element);
      element.removeAttribute('tabindex');
      element.removeEventListener('pointerdown', takeBack, true);
      element.removeEventListener('focusin', handleFocusIn);
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (event.target !== element) {
        takeBack();
      }
    };
    element.setAttribute('tabindex', '-1');
    element.addEventListener('pointerdown', takeBack, true);
    element.addEventListener('focusin', handleFocusIn);
    lentTabIndexReleases.set(element, takeBack);
    release = takeBack;
  }
  element.focus(options);
  return release ?? (() => undefined);
};

/**
 * Puts DOM focus in a workspace pane: the composer on the Chat view, otherwise (or when the composer
 * cannot take focus, e.g. hidden behind an editor expanded over the chat) the pane root, which borrows a
 * tabindex for it (focusWithLentTabIndex; pane DOM contract: data-workspace-pane, data-slot="prompt-input-textarea").
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
  focusWithLentTabIndex(pane);
};
