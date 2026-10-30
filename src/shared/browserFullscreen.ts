import { api } from '@/shared/api';
import type {
  BrowserDisplayModeName,
  BrowserFullscreenIssue,
  BrowserFullscreenReport,
  BrowserFullscreenSize,
  BrowserFullscreenSource,
  KeyboardLockNavigator,
} from '@/shared/types';

/**
 * The page's single owner of the browser fullscreen. A component that maximizes itself (workspace
 * immersive mode, the floating code editor, the PRD editor, Browser Use's preview) holds it for as
 * long as it is maximized: the first holder's gesture asks the browser for fullscreen, the last
 * release leaves it, and when the browser ends it (Escape, F11, a system gesture, another tab) every
 * holder drops its maximized state, so the user never sees a maximize without the screen or the
 * other way round.
 *
 * The request is always for the root element, never the holder's own: dialogs, tooltips and menus
 * portaled to <body> stay visible, and each holder's CSS maximize already fills the viewport, which
 * fullscreen turns into the screen. When the browser refuses or cannot, the holder keeps its CSS
 * maximize and `issue` says why.
 *
 * While a granted fullscreen lasts Escape is locked where Keyboard Lock exists: a short press stays
 * the page's, so the completion list, the search panel, the palette or a dialog closes first and the
 * holder's own Escape handler then leaves its maximize; holding Escape leaves the browser fullscreen.
 */

/** Safari's prefixed Fullscreen API on the document; widened here instead of augmenting the global DOM types. */
type PrefixedFullscreenDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
};

/** Safari's prefixed request on an element; it returns nothing, webkitfullscreenchange reports the outcome. */
type PrefixedFullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => void;
};

/** The desktop app's preload bridge; its presence means the page runs inside the Electron shell. */
type DesktopShellWindow = Window & {
  cloudcliDesktopNotifications?: unknown;
};

type UserActivationNavigator = Navigator & {
  userActivation?: { isActive?: boolean };
  standalone?: boolean;
  userAgentData?: { platform?: string };
};

type BrowserFullscreenHolder = {
  source: BrowserFullscreenSource;
  onBrowserExit: () => void;
};

/** What a holder asks for; see holdBrowserFullscreen. */
type BrowserFullscreenHoldOptions = BrowserFullscreenHolder;

/** The state React reads through useSyncExternalStore; replaced, never mutated, on every change. */
type BrowserFullscreenSnapshot = {
  /** Whether the root fullscreen the holders asked for is showing. */
  isFullscreen: boolean;
  /** Why the current maximize came without the whole screen; null when there is nothing to say. */
  issue: BrowserFullscreenIssue | null;
};

/** What was true when a request was made, for its diagnostics report. */
type RequestContext = {
  source: BrowserFullscreenSource;
  startedAt: number;
  displayModeBefore: BrowserDisplayModeName;
  focused: boolean;
  userActivation: boolean | null;
};

/**
 * How long a granted request may take to show in the window. Past this, a document that is
 * fullscreen in a window that is not, or in a window smaller than the screen, counts as full screen
 * kept inside the window. The macOS full-screen animation ends well within this.
 */
const WINDOW_FULLSCREEN_CONFIRM_MS = 3000;

/**
 * How far a fullscreen window may fall short of the screen and still count as the whole screen, in
 * CSS pixels at 100% zoom (outer and screen sizes ignore page zoom). Covers the black band macOS
 * leaves above the notch (32 to 44 points depending on the display scaling) and rounding; a Split
 * View tile misses by a third of the screen or more.
 */
const SCREEN_FIT_TOLERANCE_PX = 64;

/** The longest refusal message kept for the notice and the report. */
const MAX_DETAIL_LENGTH = 120;

const DISPLAY_MODES: BrowserDisplayModeName[] = ['fullscreen', 'standalone', 'minimal-ui', 'window-controls-overlay', 'picture-in-picture', 'browser'];

const holders = new Map<number, BrowserFullscreenHolder>();
let nextHolderId = 1;
// 'pending' from the request until the browser answers, 'granted' while the root fullscreen is ours.
let phase: 'idle' | 'pending' | 'granted' = 'idle';
// Numbers the requests, so a late answer to an older one cannot disown or check a newer one.
let requestSeq = 0;
let snapshot: BrowserFullscreenSnapshot = { isFullscreen: false, issue: null };
const listeners = new Set<() => void>();
// Stops the running wait for the window to show a granted fullscreen; null when none is running.
let stopWindowCheck: ((reason: 'settled' | 'interrupted') => void) | null = null;
// Whether Escape is locked for the page, and how the last lock went (for the report).
let isEscapeLocked = false;
let keyboardLockState: BrowserFullscreenReport['keyboardLock'] = 'notRequested';
// The 'unavailable' notice shows once per page load and cause (the desktop app's is only reported).
const explainedUnavailableCauses = new Set<string>();
let areDocumentListenersInstalled = false;

const setSnapshot = (next: Partial<BrowserFullscreenSnapshot>) => {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
};

const setIssue = (issue: BrowserFullscreenIssue | null) => {
  setSnapshot({ issue });
};

/**
 * The element the document shows in full screen, from the standard API or Safari's prefixed one;
 * null when nothing is. Also read by project-workspace's useWorkspaceShortcuts, whose reload keys
 * refresh in place while the page is in full screen.
 */
export const getFullscreenElement = (): Element | null => {
  const prefixedDocument = document as PrefixedFullscreenDocument;
  return prefixedDocument.fullscreenElement ?? prefixedDocument.webkitFullscreenElement ?? null;
};

const isInIframe = (): boolean => {
  try {
    return window.self !== window.top;
  } catch {
    // A cross-origin parent throws on access: embedded either way.
    return true;
  }
};

/**
 * Why no request can be made, or null when one can. Not in the desktop app: HTML fullscreen inside
 * its BrowserView is unverified and the view sits below the app's title bar, while its window menu
 * has the native full screen. Not where the API is off: an iframe without permission, iPhone.
 */
const getUnavailableCause = (): 'desktopApp' | 'iframe' | 'noApi' | null => {
  if ((window as DesktopShellWindow).cloudcliDesktopNotifications) {
    return 'desktopApp';
  }
  const prefixedDocument = document as PrefixedFullscreenDocument;
  if (prefixedDocument.fullscreenEnabled || prefixedDocument.webkitFullscreenEnabled) {
    return null;
  }
  return isInIframe() ? 'iframe' : 'noApi';
};

/**
 * Whether the user agent is Chromium, whose `(display-mode: fullscreen)` follows the browser window.
 * Read from the user agent because userAgentData exists only on secure origins; no \b before Chrome,
 * so HeadlessChrome matches too.
 */
const isChromium = (): boolean => /Chrom(e|ium)\/\d/.test(navigator.userAgent);

const getWindowFullscreenQuery = (): MediaQueryList | null => (
  isChromium() && typeof window.matchMedia === 'function'
    ? window.matchMedia('(display-mode: fullscreen)')
    : null
);

const readDisplayMode = (): BrowserDisplayModeName => {
  if (typeof window.matchMedia !== 'function') {
    return 'unknown';
  }
  return DISPLAY_MODES.find((mode) => window.matchMedia(`(display-mode: ${mode})`).matches) ?? 'unknown';
};

type ScreenFit =
  | { whole: true }
  | { whole: false; kind: 'tab' }
  | { whole: false; kind: 'partial'; window: BrowserFullscreenSize; screen: BrowserFullscreenSize };

/**
 * Whether the granted fullscreen fills the screen. In Chromium the window must be fullscreen (a
 * captured tab keeps it inside the tab); everywhere, the window may fall short of the screen by at
 * most SCREEN_FIT_TOLERANCE_PX. Outer and screen sizes are compared because neither follows page
 * zoom; a size of 0 (unknown, as in jsdom) skips the comparison. iOS and iPadOS report the screen
 * upright whichever way the device is held, so a screen whose shape is the other way round from the
 * window's is turned to match before the comparison; the notice still shows the reported sizes.
 */
const readScreenFit = (query: MediaQueryList | null): ScreenFit => {
  if (getFullscreenElement() === null || (query !== null && !query.matches)) {
    return { whole: false, kind: 'tab' };
  }
  const windowSize = { width: window.outerWidth, height: window.outerHeight };
  const screenSize = { width: window.screen?.width ?? 0, height: window.screen?.height ?? 0 };
  const isKnown = windowSize.width > 0 && windowSize.height > 0 && screenSize.width > 0 && screenSize.height > 0;
  const isTurned = (windowSize.width > windowSize.height) !== (screenSize.width > screenSize.height);
  const screenWidth = isTurned ? screenSize.height : screenSize.width;
  const screenHeight = isTurned ? screenSize.width : screenSize.height;
  const isShort = isKnown && (
    screenWidth - windowSize.width > SCREEN_FIT_TOLERANCE_PX
    || screenHeight - windowSize.height > SCREEN_FIT_TOLERANCE_PX
  );
  return isShort ? { whole: false, kind: 'partial', window: windowSize, screen: screenSize } : { whole: true };
};

const readPair = (width: number | undefined, height: number | undefined): [number, number] => [
  Math.round(width ?? 0),
  Math.round(height ?? 0),
];

/** Sends one diagnostics line; best effort, never in the way of the fullscreen itself. */
const report = (context: RequestContext, result: Pick<BrowserFullscreenReport, 'outcome' | 'kind' | 'cause' | 'detail'>) => {
  const userActivationNavigator = navigator as UserActivationNavigator;
  const payload: BrowserFullscreenReport = {
    event: 'fullscreen',
    source: context.source,
    ...result,
    elapsedMs: Math.max(0, Math.round(performance.now() - context.startedAt)),
    displayModeBefore: context.displayModeBefore,
    displayModeAfter: readDisplayMode(),
    standalone: context.displayModeBefore === 'standalone' || userActivationNavigator.standalone === true,
    inIframe: isInIframe(),
    secure: window.isSecureContext === true,
    focused: context.focused,
    userActivation: context.userActivation,
    keyboardLock: keyboardLockState,
    outer: readPair(window.outerWidth, window.outerHeight),
    inner: readPair(window.innerWidth, window.innerHeight),
    screen: readPair(window.screen?.width, window.screen?.height),
    avail: readPair(window.screen?.availWidth, window.screen?.availHeight),
    position: readPair(window.screenX, window.screenY),
    dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100,
    platform: (userActivationNavigator.userAgentData?.platform || navigator.platform || '').slice(0, 40),
  };
  Promise.resolve()
    .then(() => api.system.reportClientDiagnostics(payload))
    .catch(() => undefined);
};

const captureRequestContext = (source: BrowserFullscreenSource): RequestContext => ({
  source,
  startedAt: performance.now(),
  displayModeBefore: readDisplayMode(),
  focused: document.hasFocus(),
  userActivation: (navigator as UserActivationNavigator).userActivation?.isActive ?? null,
});

/** The browser's reason for a refusal, as the notice shows it: its message ("not granted"), else its name. */
const describeRefusal = (error: unknown): string => (
  (error instanceof Error ? error.message || error.name : String(error)).slice(0, MAX_DETAIL_LENGTH)
);

/**
 * Asks for fullscreen on the root element. Must run inside the user's gesture: the request is made
 * before the first await. Resolves true once granted and rejects when refused. The prefixed call
 * resolves false at once: only webkitfullscreenchange reports its outcome.
 */
const requestRootFullscreen = async (): Promise<boolean> => {
  const root = document.documentElement as PrefixedFullscreenElement;
  if (typeof root.requestFullscreen === 'function') {
    await root.requestFullscreen({ navigationUI: 'hide' });
    return true;
  }
  if (typeof root.webkitRequestFullscreen === 'function') {
    root.webkitRequestFullscreen();
    return false;
  }
  throw new Error('The Fullscreen API is not available');
};

const exitDocumentFullscreen = (): void => {
  const prefixedDocument = document as PrefixedFullscreenDocument;
  if (typeof prefixedDocument.exitFullscreen === 'function') {
    // Rejects when the document has already left fullscreen; nothing is left to undo then.
    Promise.resolve(prefixedDocument.exitFullscreen()).catch(() => undefined);
    return;
  }
  prefixedDocument.webkitExitFullscreen?.();
};

/**
 * Locks Escape while the holders share a granted fullscreen, so a short press stays the page's (close
 * a completion list, the search panel, a menu; leave a maximize; abort a run) and holding it still
 * leaves fullscreen. Keyboard Lock exists only in Chromium and only on secure origins; elsewhere
 * Escape leaves the fullscreen at once, and every maximize with it.
 */
const syncKeyboardLock = () => {
  const wantsLock = phase === 'granted' && holders.size > 0;
  if (wantsLock === isEscapeLocked) {
    return;
  }
  isEscapeLocked = wantsLock;
  const { keyboard } = navigator as KeyboardLockNavigator;
  if (!wantsLock) {
    keyboard?.unlock?.();
    keyboardLockState = 'notRequested';
    return;
  }
  if (!window.isSecureContext) {
    keyboardLockState = 'insecure';
    return;
  }
  if (typeof keyboard?.lock !== 'function') {
    keyboardLockState = 'unsupported';
    return;
  }
  keyboardLockState = 'requested';
  Promise.resolve(keyboard.lock(['Escape'])).then(
    () => {
      keyboardLockState = 'locked';
    },
    () => {
      keyboardLockState = 'failed';
    },
  );
};

/** Stops the window check; an early stop still reports what the window looked like. */
const endWindowCheck = (reason: 'settled' | 'interrupted') => {
  const stop = stopWindowCheck;
  stopWindowCheck = null;
  stop?.(reason);
};

/**
 * After a grant: waits up to WINDOW_FULLSCREEN_CONFIRM_MS for the page to fill the screen, checking
 * again on every display-mode change and resize, then reports the outcome and, if it never did,
 * sets the 'inWindow' issue.
 */
const confirmScreenFit = (seq: number, context: RequestContext) => {
  endWindowCheck('interrupted');
  const query = getWindowFullscreenQuery();
  const first = readScreenFit(query);
  if (first.whole) {
    report(context, { outcome: 'whole' });
    return;
  }
  let timer = 0;
  // The last fit seen while the fullscreen showed: an early end reports it, not the page after the exit.
  let lastFit: ScreenFit = first;
  const handleChange = () => {
    const fit = readScreenFit(query);
    if (getFullscreenElement() !== null) {
      lastFit = fit;
    }
    if (fit.whole) {
      endWindowCheck('settled');
      report(context, { outcome: 'whole' });
    }
  };
  stopWindowCheck = (reason) => {
    window.clearTimeout(timer);
    query?.removeEventListener('change', handleChange);
    window.removeEventListener('resize', handleChange);
    if (reason === 'interrupted') {
      report(context, { outcome: 'interrupted', ...(lastFit.whole ? {} : { kind: lastFit.kind }) });
    }
  };
  timer = window.setTimeout(() => {
    endWindowCheck('settled');
    const fit = readScreenFit(query);
    if (fit.whole) {
      report(context, { outcome: 'whole' });
      return;
    }
    report(context, { outcome: 'inWindow', kind: fit.kind });
    if (seq === requestSeq && phase === 'granted' && holders.size > 0) {
      setIssue(fit.kind === 'tab' ? { reason: 'inWindow', kind: 'tab' } : { reason: 'inWindow', kind: 'partial', window: fit.window, screen: fit.screen });
    }
  }, WINDOW_FULLSCREEN_CONFIRM_MS);
  query?.addEventListener('change', handleChange);
  window.addEventListener('resize', handleChange);
};

const requestBrowserFullscreen = (source: BrowserFullscreenSource) => {
  endWindowCheck('interrupted');
  const seq = requestSeq + 1;
  requestSeq = seq;
  phase = 'pending';
  const context = captureRequestContext(source);
  requestRootFullscreen().then(
    (isConfirmable) => {
      if (holders.size === 0) {
        // Every holder left while the browser was still granting the request.
        if (seq === requestSeq) {
          phase = 'idle';
        }
        exitDocumentFullscreen();
        return;
      }
      if (seq !== requestSeq) {
        // A newer request is pending: the document is fullscreen now, the newer grant checks it.
        return;
      }
      phase = 'granted';
      syncKeyboardLock();
      setSnapshot({ isFullscreen: getFullscreenElement() !== null, issue: null });
      if (isConfirmable) {
        confirmScreenFit(seq, context);
      } else {
        report(context, { outcome: 'prefixed' });
      }
    },
    (error: unknown) => {
      // A newer request is the one the holders wait on; this late refusal says nothing about it.
      if (seq !== requestSeq) {
        return;
      }
      phase = 'idle';
      if (holders.size === 0) {
        return;
      }
      const detail = describeRefusal(error);
      // Chromium logs nothing when the browser itself refuses (an unfocused view, a prompt over the page).
      console.warn('[fullscreen] The browser refused full screen:', error);
      setIssue({ reason: 'refused', detail });
      report(context, { outcome: 'refused', detail });
    },
  );
};

const handleFullscreenChange = () => {
  if (getFullscreenElement()) {
    if (phase !== 'idle') {
      setSnapshot({ isFullscreen: true });
    }
    return;
  }
  if (snapshot.isFullscreen) {
    setSnapshot({ isFullscreen: false });
  }
  if (phase === 'idle') {
    // Not ours (a video's fullscreen, say): its end changes no holder. An F11 fullscreen reports no
    // fullscreen element at all, so it never gets here.
    return;
  }
  // The browser ended the fullscreen the holders shared (Escape held, F11, a system gesture): every
  // maximize ends with it, so the user only ever sees one full-screen state.
  phase = 'idle';
  syncKeyboardLock();
  endWindowCheck('interrupted');
  const exiting = [...holders.values()];
  holders.clear();
  setIssue(null);
  exiting.forEach((holder) => holder.onBrowserExit());
};

const installDocumentListeners = () => {
  if (areDocumentListenersInstalled) {
    return;
  }
  areDocumentListenersInstalled = true;
  document.addEventListener('fullscreenchange', handleFullscreenChange);
  document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
};

const release = (holderId: number) => {
  if (!holders.delete(holderId)) {
    return;
  }
  if (holders.size > 0) {
    syncKeyboardLock();
    return;
  }
  endWindowCheck('interrupted');
  setIssue(null);
  if (phase !== 'granted') {
    // A request still pending is undone by its grant handler.
    return;
  }
  phase = 'idle';
  syncKeyboardLock();
  setSnapshot({ isFullscreen: false });
  if (getFullscreenElement()) {
    exitDocumentFullscreen();
  }
};

/**
 * Used by the shared useBrowserFullscreen hook when a component maximizes itself. Call it inside the
 * user's gesture (click, keydown): the first holder's request is made before it returns. Returns the
 * release, idempotent, for when the component stops being maximized; onBrowserExit runs instead
 * when the browser ends the fullscreen, and the holder is gone by then.
 */
export function holdBrowserFullscreen(options: BrowserFullscreenHoldOptions): () => void {
  installDocumentListeners();
  const holderId = nextHolderId;
  nextHolderId += 1;
  const isFirstHolder = holders.size === 0;
  holders.set(holderId, { ...options });
  const releaseThisHolder = () => release(holderId);

  // Shares the fullscreen the earlier holders have, or the request they wait on. A first holder
  // never waits on a request every earlier holder left (it may never be answered), and a holder
  // joining after a refusal makes a new request with its own gesture.
  const isShared = (phase === 'granted' && getFullscreenElement() !== null) || (phase === 'pending' && !isFirstHolder);
  if (isShared) {
    syncKeyboardLock();
    return releaseThisHolder;
  }
  const unavailableCause = getUnavailableCause();
  if (unavailableCause) {
    const context = captureRequestContext(options.source);
    // The desktop app has filled its window this way since immersive mode came, and its window menu
    // has the native full screen: reported, not explained. The others say what to do once a load.
    if (unavailableCause !== 'desktopApp' && !explainedUnavailableCauses.has(unavailableCause)) {
      explainedUnavailableCauses.add(unavailableCause);
      setIssue({ reason: 'unavailable', cause: unavailableCause });
    }
    report(context, { outcome: 'unavailable', cause: unavailableCause });
    return releaseThisHolder;
  }
  requestBrowserFullscreen(options.source);
  return releaseThisHolder;
}

/**
 * Whether a maximized view over the page holds the fullscreen (the code editor, the PRD editor,
 * Browser Use's preview), with or without the browser's. Such a view owns a short Escape: read by
 * chat's ChatInterface, which then leaves the press to it instead of stopping the run underneath,
 * and by code-editor's useEditorKeyboardShortcuts, whose docked editor then stays open under it.
 */
export function hasMaximizedOverlay(): boolean {
  return [...holders.values()].some((holder) => holder.source !== 'workspace');
}

/**
 * The notice's Retry, called from its click. Asks again only while someone holds the fullscreen,
 * with no request pending or granted and nothing fullscreen (a second click while the first is
 * pending, a video's fullscreen).
 */
export function retryBrowserFullscreen(): void {
  const firstHolder = holders.values().next().value;
  if (!firstHolder || phase !== 'idle' || getFullscreenElement() || getUnavailableCause()) {
    return;
  }
  requestBrowserFullscreen(firstHolder.source);
}

/** The notice's Close: forgets the current issue until the next request has one. */
export function dismissBrowserFullscreenIssue(): void {
  setIssue(null);
}

/** useSyncExternalStore's subscriber for the shared hooks. */
export function subscribeToBrowserFullscreen(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** useSyncExternalStore's snapshot reader for the shared hooks. */
export function getBrowserFullscreenSnapshot(): BrowserFullscreenSnapshot {
  return snapshot;
}
