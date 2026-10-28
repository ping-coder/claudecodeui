import { useCallback, useEffect, useRef, useState } from 'react';

import type { BrowserFullscreenIssue, KeyboardLockNavigator } from '@/shared/types';

/** Safari's prefixed Fullscreen API on the document; widened here instead of augmenting the global DOM types. */
type PrefixedFullscreenDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
};

/** Safari's prefixed request on an element; it returns nothing, fullscreenchange reports the outcome. */
type PrefixedFullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => void;
};

/** The desktop app's preload bridge; its presence means the page runs inside the Electron shell. */
type DesktopShellWindow = Window & {
  cloudcliDesktopNotifications?: unknown;
};

/**
 * How long a granted request may take to show in the window. Past this, a document that is
 * fullscreen in a window that is not counts as full screen kept inside the window. The macOS
 * full-screen animation switches the window state as it starts, well within this.
 */
const WINDOW_FULLSCREEN_CONFIRM_MS = 3000;

const getFullscreenElement = (): Element | null => {
  const prefixedDocument = document as PrefixedFullscreenDocument;
  return prefixedDocument.fullscreenElement ?? prefixedDocument.webkitFullscreenElement ?? null;
};

/**
 * Whether immersive mode also takes the browser fullscreen. Not where the API is off (iPhone, an
 * iframe without permission), and not in the desktop app: HTML fullscreen inside its BrowserView is
 * unverified there, and its window menu already has the native full screen.
 */
const canTakeBrowserFullscreen = (): boolean => {
  if ((window as DesktopShellWindow).cloudcliDesktopNotifications) {
    return false;
  }
  const prefixedDocument = document as PrefixedFullscreenDocument;
  return Boolean(prefixedDocument.fullscreenEnabled || prefixedDocument.webkitFullscreenEnabled);
};

/**
 * The `(display-mode: fullscreen)` query where it follows the browser window: Chromium, whose
 * display mode is fullscreen exactly while its window is (Android included). Null elsewhere. Read
 * from the user agent, because userAgentData exists only on secure origins; no \b before Chrome, so
 * HeadlessChrome matches too.
 */
const getWindowFullscreenQuery = (): MediaQueryList | null => {
  if (!/Chrom(e|ium)\/\d/.test(navigator.userAgent) || typeof window.matchMedia !== 'function') {
    return null;
  }
  return window.matchMedia('(display-mode: fullscreen)');
};

/**
 * Asks for fullscreen on the root element, so dialogs, tooltips and menus portaled to <body> stay
 * visible. Must run inside the user's gesture: the request is made before the first await.
 * Resolves true once granted and rejects when refused. The prefixed call resolves false at once:
 * only webkitfullscreenchange reports its outcome, so there is nothing to check afterwards.
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
 * Keeps a short Escape press for the app (abort a run, close the editor or a menu) while holding
 * Escape still leaves fullscreen. Keyboard Lock exists only in Chromium and only on secure origins,
 * so LAN http access goes without it.
 */
const lockEscapeKey = (): void => {
  if (!window.isSecureContext) {
    return;
  }
  const { keyboard } = navigator as KeyboardLockNavigator;
  if (typeof keyboard?.lock !== 'function') {
    return;
  }
  Promise.resolve(keyboard.lock(['Escape'])).catch(() => undefined);
};

const unlockKeys = (): void => {
  (navigator as KeyboardLockNavigator).keyboard?.unlock?.();
};

/** The browser's reason for a refusal, as the notice shows it: its message ("not granted"), else its name. */
const describeRefusal = (error: unknown): string => (
  error instanceof Error ? error.message || error.name : String(error)
);

/**
 * Used by ProjectWorkspaceShell for the workspace's single full-screen state: entering makes the
 * workspace immersive and, where the browser allows it, takes the browser fullscreen of the root
 * element in the same gesture; leaving undoes both, and so does the browser ending that fullscreen.
 * When the browser refuses, or keeps its fullscreen inside the window, immersive mode stays and
 * browserFullscreenIssue says why.
 */
export function useImmersiveMode() {
  // Whether the workspace is immersive: sidebar and docked quick settings hidden, panes down to one
  // chrome row (a floating capsule on phones). Memory only: the browser fullscreen that comes with it
  // needs a user gesture, so a reload could not restore the pair.
  const [isImmersive, setIsImmersive] = useState(false);
  // Whether the browser fullscreen immersive mode asked for is showing. Not derivable from
  // isImmersive: iPhone, the desktop app and a refused request give immersive mode without it.
  const [isBrowserFullscreen, setIsBrowserFullscreen] = useState(false);
  // Why the current immersive mode came without the whole screen, for the notice that says so.
  // Neither cause can be read back from the DOM later: a refusal leaves no trace, and a fullscreen
  // kept inside the window has the same fullscreen element as one that fills the screen.
  const [browserFullscreenIssue, setBrowserFullscreenIssue] = useState<BrowserFullscreenIssue | null>(null);
  // The latest requested immersive state, read synchronously by toggle and by a late fullscreen grant.
  const isImmersiveRef = useRef(false);
  // Whether the root fullscreen, requested or showing, belongs to immersive mode. Only then does its
  // end leave immersive mode, and only then does leaving immersive mode turn it off.
  const ownsFullscreenRef = useRef(false);
  // Numbers the fullscreen requests, so a late answer to an older one cannot disown a newer request,
  // clear its reason or start a window check for it.
  const fullscreenRequestRef = useRef(0);
  // Stops the running wait for the window to show a granted fullscreen; null when none is running.
  const stopWindowCheckRef = useRef<(() => void) | null>(null);

  const stopWindowCheck = useCallback(() => {
    stopWindowCheckRef.current?.();
    stopWindowCheckRef.current = null;
  }, []);

  // After a grant: a document that is fullscreen in a window that does not become fullscreen within
  // WINDOW_FULLSCREEN_CONFIRM_MS (this tab captured, an extension's stand-in) is reported.
  const confirmWindowFullscreen = useCallback((requestId: number) => {
    stopWindowCheck();
    const query = getWindowFullscreenQuery();
    // Outside Chromium nothing tells the window's state, so only a grant without any fullscreen
    // element (an extension's stand-in) counts.
    const isWholeScreen = () => getFullscreenElement() !== null && (query?.matches ?? true);
    if (isWholeScreen()) {
      return;
    }
    const handleChange = () => {
      if (isWholeScreen()) {
        stopWindowCheck();
      }
    };
    const timer = window.setTimeout(() => {
      stopWindowCheck();
      const isStillOurs = fullscreenRequestRef.current === requestId && isImmersiveRef.current && ownsFullscreenRef.current;
      if (isStillOurs && !isWholeScreen()) {
        setBrowserFullscreenIssue({ reason: 'inWindow' });
      }
    }, WINDOW_FULLSCREEN_CONFIRM_MS);
    query?.addEventListener('change', handleChange);
    stopWindowCheckRef.current = () => {
      window.clearTimeout(timer);
      query?.removeEventListener('change', handleChange);
    };
  }, [stopWindowCheck]);

  // Asks for the root fullscreen on behalf of immersive mode. Called synchronously from the gesture:
  // the pane button, the shortcut, the command palette or the notice's Retry.
  const requestBrowserFullscreen = useCallback(() => {
    stopWindowCheck();
    const requestId = fullscreenRequestRef.current + 1;
    fullscreenRequestRef.current = requestId;
    ownsFullscreenRef.current = true;
    requestRootFullscreen().then(
      (isConfirmable) => {
        if (!isImmersiveRef.current) {
          // Immersive mode was left while the browser was still granting the request.
          exitDocumentFullscreen();
          return;
        }
        lockEscapeKey();
        if (fullscreenRequestRef.current !== requestId) {
          return;
        }
        setBrowserFullscreenIssue(null);
        if (isConfirmable) {
          confirmWindowFullscreen(requestId);
        }
      },
      (error: unknown) => {
        // A newer request is the one immersive mode waits on; this late refusal says nothing about it.
        if (fullscreenRequestRef.current !== requestId) {
          return;
        }
        ownsFullscreenRef.current = false;
        if (!isImmersiveRef.current) {
          return;
        }
        // Chromium logs nothing when the browser itself refuses (an unfocused view, a prompt over the page).
        console.warn('[workspace] The browser refused full screen:', error);
        setBrowserFullscreenIssue({ reason: 'refused', detail: describeRefusal(error) });
      },
    );
  }, [confirmWindowFullscreen, stopWindowCheck]);

  const enterImmersive = useCallback(() => {
    isImmersiveRef.current = true;
    setIsImmersive(true);
    if (canTakeBrowserFullscreen()) {
      requestBrowserFullscreen();
    }
  }, [requestBrowserFullscreen]);

  const exitImmersive = useCallback(() => {
    isImmersiveRef.current = false;
    setIsImmersive(false);
    setIsBrowserFullscreen(false);
    // Before the ownership check: a refused request left no fullscreen of ours, but its notice goes too.
    setBrowserFullscreenIssue(null);
    stopWindowCheck();
    if (!ownsFullscreenRef.current) {
      return;
    }
    ownsFullscreenRef.current = false;
    unlockKeys();
    // A request still pending is undone by its grant handler instead.
    if (getFullscreenElement()) {
      exitDocumentFullscreen();
    }
  }, [stopWindowCheck]);

  const toggleImmersive = useCallback(() => {
    if (isImmersiveRef.current) {
      exitImmersive();
    } else {
      enterImmersive();
    }
  }, [enterImmersive, exitImmersive]);

  // The notice's Retry, called from its click. Asks again only in immersive mode, with no request of
  // ours pending or granted (a second click while the first is pending) and nothing fullscreen.
  const retryBrowserFullscreen = useCallback(() => {
    if (isImmersiveRef.current && !ownsFullscreenRef.current && !getFullscreenElement() && canTakeBrowserFullscreen()) {
      requestBrowserFullscreen();
    }
  }, [requestBrowserFullscreen]);

  const dismissBrowserFullscreenIssue = useCallback(() => {
    setBrowserFullscreenIssue(null);
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (getFullscreenElement()) {
        if (ownsFullscreenRef.current) {
          setIsBrowserFullscreen(true);
        }
        return;
      }

      setIsBrowserFullscreen(false);
      if (!ownsFullscreenRef.current) {
        // Not ours (a video's fullscreen, say): its end leaves immersive mode alone. An F11
        // fullscreen reports no fullscreen element at all, so it never gets here.
        return;
      }
      // The browser ended the fullscreen immersive mode took (Escape held, F11, a system gesture):
      // immersive mode ends with it, so the user only ever sees one full-screen state.
      ownsFullscreenRef.current = false;
      unlockKeys();
      stopWindowCheck();
      isImmersiveRef.current = false;
      setIsImmersive(false);
      setBrowserFullscreenIssue(null);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      stopWindowCheck();
      // Leaving the workspace (logout, another route) must not keep the page fullscreen without the
      // immersive mode it belonged to.
      if (ownsFullscreenRef.current) {
        ownsFullscreenRef.current = false;
        unlockKeys();
        if (getFullscreenElement()) {
          exitDocumentFullscreen();
        }
      }
    };
  }, [stopWindowCheck]);

  return {
    isImmersive,
    isBrowserFullscreen,
    browserFullscreenIssue,
    toggleImmersive,
    exitImmersive,
    retryBrowserFullscreen,
    dismissBrowserFullscreenIssue,
  };
}
