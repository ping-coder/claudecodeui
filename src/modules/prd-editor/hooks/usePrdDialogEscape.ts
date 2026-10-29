import { useEffect, useRef } from 'react';

/**
 * Escape closes one of the PRD editor's own dialogs (the overwrite confirmation, the Generate Tasks
 * help) and nothing under it. Used by OverwriteConfirmModal and GenerateTasksModal while they are
 * open. Claimed on window in the capture phase, before anything else hears the key: the focus is
 * usually still in CodeMirror, whose search panel would close instead, and the PRD editor's own
 * Escape would close the editor and drop what is typed in it. An Escape that ends an IME
 * composition is left to the composition.
 */
export function usePrdDialogEscape(isOpen: boolean, onEscape: () => void): void {
  // Read when the key arrives, so the listener stays put while the dialog re-renders.
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onEscapeRef.current();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [isOpen]);
}
