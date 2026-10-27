import { useCallback, useEffect, useRef, useState } from 'react';

import type { KeyboardLockNavigator } from '@/shared/types';

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
 * Asks for fullscreen on the root element, so dialogs, tooltips and menus portaled to <body> stay
 * visible. Must run inside the user's gesture: the request is made before the first await.
 * Resolves once granted and rejects when refused; the prefixed call resolves at once.
 */
const requestRootFullscreen = async (): Promise<void> => {
  const root = document.documentElement as PrefixedFullscreenElement;
  if (typeof root.requestFullscreen === 'function') {
    await root.requestFullscreen({ navigationUI: 'hide' });
    return;
  }
  if (typeof root.webkitRequestFullscreen === 'function') {
    root.webkitRequestFullscreen();
    return;
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

/**
 * Used by ProjectWorkspaceShell for the workspace's single full-screen state: entering makes the
 * workspace immersive and, where the browser allows it, takes the browser fullscreen of the root
 * element in the same gesture; leaving undoes both, and so does the browser ending that fullscreen.
 */
export function useImmersiveMode() {
  // Whether the workspace is immersive: sidebar and docked quick settings hidden, panes down to one
  // chrome row (a floating capsule on phones). Memory only: the browser fullscreen that comes with it
  // needs a user gesture, so a reload could not restore the pair.
  const [isImmersive, setIsImmersive] = useState(false);
  // Whether the browser fullscreen immersive mode asked for is showing. Not derivable from
  // isImmersive: iPhone, the desktop app and a refused request give immersive mode without it.
  const [isBrowserFullscreen, setIsBrowserFullscreen] = useState(false);
  // The latest requested immersive state, read synchronously by toggle and by a late fullscreen grant.
  const isImmersiveRef = useRef(false);
  // Whether the root fullscreen, requested or showing, belongs to immersive mode. Only then does its
  // end leave immersive mode, and only then does leaving immersive mode turn it off.
  const ownsFullscreenRef = useRef(false);
  // Numbers the fullscreen requests, so a late refusal cannot disown a newer request.
  const fullscreenRequestRef = useRef(0);

  const enterImmersive = useCallback(() => {
    isImmersiveRef.current = true;
    setIsImmersive(true);
    if (!canTakeBrowserFullscreen()) {
      return;
    }

    const requestId = fullscreenRequestRef.current + 1;
    fullscreenRequestRef.current = requestId;
    ownsFullscreenRef.current = true;
    requestRootFullscreen().then(
      () => {
        if (!isImmersiveRef.current) {
          // Immersive mode was left while the browser was still granting the request.
          exitDocumentFullscreen();
          return;
        }
        lockEscapeKey();
      },
      () => {
        // Refused (no user activation, a permissions policy): immersive mode stays, without it.
        if (fullscreenRequestRef.current === requestId) {
          ownsFullscreenRef.current = false;
        }
      },
    );
  }, []);

  const exitImmersive = useCallback(() => {
    isImmersiveRef.current = false;
    setIsImmersive(false);
    setIsBrowserFullscreen(false);
    if (!ownsFullscreenRef.current) {
      return;
    }
    ownsFullscreenRef.current = false;
    unlockKeys();
    // A request still pending is undone by its grant handler instead.
    if (getFullscreenElement()) {
      exitDocumentFullscreen();
    }
  }, []);

  const toggleImmersive = useCallback(() => {
    if (isImmersiveRef.current) {
      exitImmersive();
    } else {
      enterImmersive();
    }
  }, [enterImmersive, exitImmersive]);

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
      isImmersiveRef.current = false;
      setIsImmersive(false);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
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
  }, []);

  return {
    isImmersive,
    isBrowserFullscreen,
    toggleImmersive,
    exitImmersive,
  };
}
