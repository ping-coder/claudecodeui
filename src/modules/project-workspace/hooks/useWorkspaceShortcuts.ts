import { useEffect, useLayoutEffect, useRef } from 'react';

import { getActiveTab, getPane } from '@/modules/project-workspace/utils/workspaceLayout';
import { ESCAPE_LAYER_SELECTOR } from '@/shared/constants';
import type { WorkspaceLayout, WorkspaceLayoutActions, WorkspacePaneSide } from '@/shared/types';
import { focusWorkspacePaneElement, isApplePlatform } from '@/shared/utils';

type WorkspaceShortcut = 'toggleSplit' | 'focusLeft' | 'focusRight' | 'toggleImmersive';

type UseWorkspaceShortcutsOptions = {
  /** Phones have neither a split nor these shortcuts. */
  isMobile: boolean;
  /** The main column holds two panes side by side; only then do Mod+\ and Mod+2 split. */
  canSplit: boolean;
  layout: WorkspaceLayout;
  actions: Pick<WorkspaceLayoutActions, 'focusPane' | 'split' | 'toggleSplit'>;
  toggleImmersive: () => void;
};

/**
 * Which workspace shortcut a key press is, if any. Mod is Command on Apple platforms and Ctrl
 * elsewhere; the other primary modifier and Alt must be up, so AltGr chords never match. Keys are
 * matched by their physical position (event.code), which Shift and the keyboard layout leave alone.
 */
const readWorkspaceShortcut = (event: KeyboardEvent): WorkspaceShortcut | null => {
  const isApple = isApplePlatform();
  const isModDown = isApple ? event.metaKey : event.ctrlKey;
  const isOtherPrimaryDown = isApple ? event.ctrlKey : event.metaKey;
  if (!isModDown || isOtherPrimaryDown || event.altKey) {
    return null;
  }

  switch (event.code) {
    case 'Backslash':
      return event.shiftKey ? null : 'toggleSplit';
    case 'Digit1':
      return event.shiftKey ? null : 'focusLeft';
    case 'Digit2':
      return event.shiftKey ? null : 'focusRight';
    case 'Enter':
    case 'NumpadEnter':
      return event.shiftKey ? 'toggleImmersive' : null;
    default:
      return null;
  }
};

const isInsideTerminal = (target: EventTarget | null): boolean => (
  target instanceof Element && target.closest('.xterm') !== null
);

/**
 * Used by ProjectWorkspaceShell as the single registration point of the workspace shortcuts:
 * Mod+\ split or merge, Mod+1 / Mod+2 focus the left / right pane (Mod+2 splits when unsplit) and
 * Mod+Shift+Enter full screen. Listens on window in the capture phase, so the terminal and the
 * editors cannot swallow these keys first; desktop only.
 */
export function useWorkspaceShortcuts(options: UseWorkspaceShortcutsOptions): void {
  // The newest options, read when a key arrives, so the one window listener is never re-registered.
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    let focusFrame: number | null = null;

    // DOM focus follows the focused pane once the layout change has rendered: the composer on the
    // Chat view, the pane root on every other view (and on a new, empty right pane). It moves even
    // when focus is already inside that pane, so the shortcut always lands in the composer.
    const moveFocusIntoPane = (side: WorkspacePaneSide) => {
      if (focusFrame !== null) {
        window.cancelAnimationFrame(focusFrame);
      }
      focusFrame = window.requestAnimationFrame(() => {
        focusFrame = null;
        focusWorkspacePaneElement(side, getActiveTab(getPane(optionsRef.current.layout, side))?.view);
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
          return actions.toggleSplit;
        case 'focusLeft':
          return () => {
            actions.focusPane('left');
            moveFocusIntoPane('left');
          };
        case 'focusRight':
          if (!isSplit && !canSplit) {
            return null;
          }
          return () => {
            if (isSplit) {
              actions.focusPane('right');
            } else {
              actions.split();
            }
            moveFocusIntoPane('right');
          };
        case 'toggleImmersive':
          return toggleImmersive;
        default:
          return null;
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const shortcut = readWorkspaceShortcut(event);
      // Keys another handler consumed and keys typed while an IME composes are not ours.
      if (!shortcut || event.defaultPrevented || event.isComposing) {
        return;
      }
      // Phones have none of these shortcuts, and an open menu, dialog or other Escape layer owns the
      // keyboard while it is up.
      if (optionsRef.current.isMobile || document.querySelector(ESCAPE_LAYER_SELECTOR)) {
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
