import { useEffect } from 'react';

import { hasMaximizedOverlay } from '@/shared/browserFullscreen';
import { ESCAPE_LAYER_SELECTOR } from '@/shared/constants';
import { useWorkspacePane } from '@/shared/context/WorkspacePaneContext';

type UseEditorKeyboardShortcutsParams = {
  onSave: () => void;
  onClose: () => void;
  dependency: string;
  // Docked beside the pane's view, the editor sits under any view maximized over the page (Browser
  // Use's preview, the PRD editor), and that view's Escape comes first. A floating editor (popped
  // out, on a phone, in full screen) is above them all and keeps it.
  isDocked: boolean;
};

export const useEditorKeyboardShortcuts = ({
  onSave,
  onClose,
  dependency,
  isDocked,
}: UseEditorKeyboardShortcutsParams) => {
  // Each split pane can hold an open editor, and both used to listen on the
  // document: Ctrl/Cmd+S saved both files, and Escape closed the editor that
  // registered first rather than the one in use. Only the focused pane's editor
  // listens now; outside the split workspace an editor always does.
  const { isFocusedPane } = useWorkspacePane();

  useEffect(() => {
    if (!isFocusedPane) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Leave Escapes another handler consumed or a layer above the editor
        // (a menu, a dialog, another Escape layer, a view maximized over the
        // docked editor) owns, and the repeats of a held one: its first press
        // already acted, and holding Escape in full screen is how the browser's
        // own full screen is left.
        if (
          event.repeat
          || event.defaultPrevented
          || document.querySelector(ESCAPE_LAYER_SELECTOR)
          || (isDocked && hasMaximizedOverlay())
        ) {
          return;
        }

        event.preventDefault();
        onClose();
        return;
      }

      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }

      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        onSave();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [dependency, isDocked, isFocusedPane, onClose, onSave]);
};
