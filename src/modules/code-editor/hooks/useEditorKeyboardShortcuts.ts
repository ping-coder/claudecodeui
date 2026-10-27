import { useEffect } from 'react';

import { ESCAPE_LAYER_SELECTOR } from '@/shared/constants';
import { useWorkspacePane } from '@/shared/context/WorkspacePaneContext';

type UseEditorKeyboardShortcutsParams = {
  onSave: () => void;
  onClose: () => void;
  dependency: string;
};

export const useEditorKeyboardShortcuts = ({
  onSave,
  onClose,
  dependency,
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
        // (a menu, a dialog, another Escape layer) owns.
        if (event.defaultPrevented || document.querySelector(ESCAPE_LAYER_SELECTOR)) {
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
  }, [dependency, isFocusedPane, onClose, onSave]);
};
