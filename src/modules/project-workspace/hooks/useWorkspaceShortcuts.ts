import { useEffect, useLayoutEffect, useRef } from 'react';

import { getActiveTab, getPane } from '@/modules/project-workspace/utils/workspaceLayout';
import {
  ESCAPE_LAYER_SELECTOR,
  WORKSPACE_FOCUS_LEFT_PANE_SHORTCUT,
  WORKSPACE_FOCUS_RIGHT_PANE_SHORTCUT,
  WORKSPACE_FULLSCREEN_SHORTCUT,
  WORKSPACE_SPLIT_SHORTCUT,
} from '@/shared/constants';
import type { WorkspaceLayout, WorkspaceLayoutActions, WorkspacePaneSide } from '@/shared/types';
import { focusWorkspacePaneElement, isApplePlatform } from '@/shared/utils';

type WorkspaceShortcut = 'toggleSplit' | 'focusLeft' | 'focusRight' | 'toggleImmersive';

type UseWorkspaceShortcutsOptions = {
  /** Phones have neither a split nor these shortcuts. */
  isMobile: boolean;
  /** The main column holds two panes side by side; only then does Mod+\ split. */
  canSplit: boolean;
  layout: WorkspaceLayout;
  actions: Pick<WorkspaceLayoutActions, 'focusPane' | 'toggleSplit'>;
  toggleImmersive: () => void;
  /**
   * Closes the immersive sidebar drawer once a pane key has put DOM focus in a pane, which the drawer
   * covers. Mod+1/2 on the pane already focused and a merge keep the focused tab, so the drawer's own
   * rule (it closes when the focused tab changes) does not catch them.
   */
  closeSidebarPeek: () => void;
};

/** Each shortcut's keys, in formatShortcut's tokens: the same constants the tooltips, hints and palette show. */
const SHORTCUT_KEYS: ReadonlyArray<[WorkspaceShortcut, readonly string[]]> = [
  ['toggleSplit', WORKSPACE_SPLIT_SHORTCUT],
  ['focusLeft', WORKSPACE_FOCUS_LEFT_PANE_SHORTCUT],
  ['focusRight', WORKSPACE_FOCUS_RIGHT_PANE_SHORTCUT],
  ['toggleImmersive', WORKSPACE_FULLSCREEN_SHORTCUT],
];

/** The physical keys (KeyboardEvent.code) a shortcut's main key token stands for. */
const toKeyCodes = (key: string): string[] => {
  const token = key.toLowerCase();
  if (token === 'enter') {
    return ['Enter', 'NumpadEnter'];
  }
  if (token === '\\') {
    return ['Backslash'];
  }
  if (/^[0-9]$/.test(token)) {
    return [`Digit${token}`];
  }
  if (/^[a-z]$/.test(token)) {
    return [`Key${token.toUpperCase()}`];
  }
  return [key];
};

/** Whether a key press is exactly these keys: Shift down only when they name it; Mod and the other primary modifier are checked by the caller. */
const matchesShortcutKeys = (event: KeyboardEvent, keys: readonly string[]): boolean => {
  const tokens = keys.map((key) => key.toLowerCase());
  const mainKey = keys.find((key) => !['mod', 'shift', 'alt'].includes(key.toLowerCase()));
  return Boolean(mainKey)
    && event.shiftKey === tokens.includes('shift')
    && toKeyCodes(mainKey as string).includes(event.code);
};

/**
 * Which workspace shortcut a key press is, if any. Mod is Command on Apple platforms and Ctrl
 * elsewhere; the other primary modifier and Alt must be up, so AltGr chords never match. Keys are
 * matched by their physical position (event.code), which Shift and the keyboard layout leave alone.
 * Also used by PaneTabRenameInput, whose box ignores exactly the full-screen chord and no other Enter.
 */
export const readWorkspaceShortcut = (event: KeyboardEvent): WorkspaceShortcut | null => {
  const isApple = isApplePlatform();
  const isModDown = isApple ? event.metaKey : event.ctrlKey;
  const isOtherPrimaryDown = isApple ? event.ctrlKey : event.metaKey;
  if (!isModDown || isOtherPrimaryDown || event.altKey) {
    return null;
  }
  return SHORTCUT_KEYS.find(([, keys]) => matchesShortcutKeys(event, keys))?.[0] ?? null;
};

const isInsideTerminal = (target: EventTarget | null): boolean => (
  target instanceof Element && target.closest('.xterm') !== null
);

/**
 * Whether a layer that owns the keyboard is open: a modal dialog, a menu, or another Escape layer. A
 * non-modal dialog (the immersive sidebar drawer) only owns Escape, so the workspace keys still work.
 */
const isKeyboardOwnedByLayer = (): boolean => Array.from(document.querySelectorAll(ESCAPE_LAYER_SELECTOR))
  .some((layer) => layer.getAttribute('role') !== 'dialog' || layer.getAttribute('aria-modal') === 'true');

/**
 * Used by ProjectWorkspaceShell as the single registration point of the workspace shortcuts:
 * Mod+\ split or merge, Mod+1 / Mod+2 focus the left / right pane (only while split; unsplit they stay
 * with the browser, which switches its tabs with them) and Mod+Shift+Enter full screen. Listens on
 * window in the capture phase, so the terminal and the editors cannot swallow these keys first; desktop only.
 */
export function useWorkspaceShortcuts(options: UseWorkspaceShortcutsOptions): void {
  // The newest options, read when a key arrives, so the one window listener is never re-registered.
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    let focusFrame: number | null = null;

    // DOM focus follows the pane focus once the layout change has rendered: the composer on the Chat
    // view, the pane root on every other view (and on a new, empty right pane). Mod+1/2 move it even
    // when it is already inside that pane, so the shortcut always lands in the composer; after Mod+\
    // focus already inside the focused pane stays where it is. The immersive sidebar drawer closes
    // after the move, so it does not hand focus back to its "Show sidebar" button first.
    const moveFocusIntoPane = (side: WorkspacePaneSide | 'focused', keepFocusInside = false) => {
      if (focusFrame !== null) {
        window.cancelAnimationFrame(focusFrame);
      }
      focusFrame = window.requestAnimationFrame(() => {
        focusFrame = null;
        const { layout, closeSidebarPeek } = optionsRef.current;
        const targetSide = side === 'focused' ? layout.focusedSide : side;
        focusWorkspacePaneElement(targetSide, getActiveTab(getPane(layout, targetSide))?.view, { keepFocusInside });
        closeSidebarPeek();
      });
    };

    // What a shortcut does right now, or null when it should stay with the browser or the page.
    const resolveShortcutAction = (shortcut: WorkspaceShortcut, event: KeyboardEvent): (() => void) | null => {
      const { canSplit, layout, actions, toggleImmersive } = optionsRef.current;
      const isSplit = layout.right !== null;

      switch (shortcut) {
        case 'toggleSplit':
          // Nothing to merge and no room to split.
          if (!isSplit && !canSplit) {
            return null;
          }
          // Ctrl+\ is SIGQUIT in a terminal on Windows and Linux; Cmd+\ never reaches one.
          if (!isApplePlatform() && isInsideTerminal(event.target)) {
            return null;
          }
          return () => {
            actions.toggleSplit();
            // A split focuses the new pane, a merge the one that stays: DOM focus goes along, or the
            // keys that follow (Ctrl/Cmd+S, Escape) would act on a pane that is no longer focused.
            moveFocusIntoPane('focused', true);
          };
        case 'focusLeft':
        case 'focusRight': {
          // Unsplit there is no other pane: the browser keeps the key (Mod+1/2 switch its tabs).
          if (!isSplit) {
            return null;
          }
          const side: WorkspacePaneSide = shortcut === 'focusLeft' ? 'left' : 'right';
          return () => {
            actions.focusPane(side);
            moveFocusIntoPane(side);
          };
        }
        case 'toggleImmersive':
          return toggleImmersive;
        default:
          return null;
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const shortcut = readWorkspaceShortcut(event);
      // Keys another handler consumed and keys typed while an IME composes are not ours.
      if (!shortcut || event.defaultPrevented || event.isComposing || optionsRef.current.isMobile) {
        return;
      }
      // An open menu, modal dialog or other keyboard-owning layer has the keyboard while it is up. A
      // pane key that is ours while split is still kept from the browser, which would switch tabs.
      if (isKeyboardOwnedByLayer()) {
        if ((shortcut === 'focusLeft' || shortcut === 'focusRight') && optionsRef.current.layout.right !== null) {
          event.preventDefault();
        }
        return;
      }

      const action = resolveShortcutAction(shortcut, event);
      if (!action) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      // A held key repeats: only the first press acts. The repeats are still kept from the browser
      // (Ctrl+1 would switch browser tabs) and from the focused field.
      if (!event.repeat) {
        action();
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      if (focusFrame !== null) {
        window.cancelAnimationFrame(focusFrame);
      }
    };
  }, []);
}
