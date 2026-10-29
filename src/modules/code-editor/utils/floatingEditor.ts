// The floating editors over the focused pane, one entry per EditorSidebar holding one.
const floatingEditors = new Set<symbol>();

/**
 * Held by EditorSidebar while its editor floats over the focused pane: popped out, on a phone or a
 * window too narrow to dock it, or in full screen. Such an editor is a view over the page that owns a
 * short Escape once nothing above it (its completion list or search panel, a menu, a dialog) took the
 * press: the press closes the editor, or ends its full screen. Returns the release, idempotent.
 */
export function holdFloatingEditor(): () => void {
  const entry = Symbol('floating editor');
  floatingEditors.add(entry);
  return () => {
    floatingEditors.delete(entry);
  };
}

/**
 * Whether an editor floats over the focused pane. Read through the module barrel by chat's
 * ChatInterface, which then leaves a short Escape to the editor instead of stopping the run underneath.
 */
export function hasFloatingEditor(): boolean {
  return floatingEditors.size > 0;
}
