import { useEffect } from 'react';
import type { RefObject } from 'react';

import { ESCAPE_LAYER_SELECTOR } from '@/shared/constants';

type UsePrdKeyboardShortcutsArgs = {
  onSave: () => void;
  onClose: () => void;
  // The editor's own dialog element. It is a modal layer itself, so the code editor docked behind
  // it and the chat leave Escape to it; its own Escape skips it when looking for a layer above.
  dialogRef: RefObject<HTMLElement>;
};

export function usePrdKeyboardShortcuts({
  onSave,
  onClose,
  dialogRef,
}: UsePrdKeyboardShortcutsArgs): void {
  useEffect(() => {
    // Keep shortcuts global so the editor behaves consistently in fullscreen and modal mode.
    const handleKeyDown = (event: KeyboardEvent) => {
      const loweredKey = event.key.toLowerCase();

      if ((event.ctrlKey || event.metaKey) && loweredKey === 's') {
        event.preventDefault();
        onSave();
        return;
      }

      if (event.key === 'Escape') {
        // Leave an Escape another handler took (CodeMirror's completion list or search panel) or a
        // layer above the editor owns (a menu, a dialog, the palette): that one closes alone. The
        // repeats of a held Escape are left too: holding it is how the browser's full screen is left.
        const hasLayerAbove = Array.from(document.querySelectorAll(ESCAPE_LAYER_SELECTOR))
          .some((layer) => layer !== dialogRef.current);
        if (event.repeat || event.defaultPrevented || hasLayerAbove) {
          return;
        }
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [dialogRef, onClose, onSave]);
}
