import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type PaletteOps = {
  openFile: (path: string) => void;
  // Opens a file in the editor side panel without changing the active tab
  // (the fallback of in-chat file links, which use their own pane's editor
  // when they have one, so they behave like the inline edit view).
  openFileInEditor: (path: string, line?: number | null) => void;
  // Directories cannot be read as text: they open in the file tree instead.
  openDirectory: (path: string) => void;
  openSettings: (tab?: string) => void;
  refreshProjects: () => Promise<void> | void;
  // Appends text to the chat composer and focuses it (used by the quick
  // settings Commands tab to hand a picked slash command to the composer).
  insertComposerText: (text: string) => void;
};

type PaletteOpName = keyof PaletteOps;

/** One live registration. A fresh object per effect run, so a cleanup finds exactly its own entry even when two registrants pass the same function. */
type PaletteOpEntry<K extends PaletteOpName> = { fn: PaletteOps[K] };

/**
 * Every live registration of each op, oldest first; the newest one answers. A stack rather than one
 * slot that remembers the previous value: a registrant that unregisters removes only its own entry,
 * so no unmount order can hand an op back to a registrant (a closed pane) that is already gone.
 */
type PaletteOpsRegistry = { [K in PaletteOpName]: Array<PaletteOpEntry<K>> };

const createPaletteOpsRegistry = (): PaletteOpsRegistry => ({
  openFile: [],
  openFileInEditor: [],
  openDirectory: [],
  openSettings: [],
  refreshProjects: [],
  insertComposerText: [],
});

const PaletteOpsContext = createContext<PaletteOpsRegistry | null>(null);

const defaultOps: PaletteOps = {
  openFile: () => undefined,
  openFileInEditor: () => undefined,
  openDirectory: () => undefined,
  openSettings: () => undefined,
  refreshProjects: () => undefined,
  insertComposerText: () => undefined,
};

/** The newest live registration of an op, or its no-op default. */
const readTopOp = <K extends PaletteOpName>(registry: PaletteOpsRegistry | null, name: K): PaletteOps[K] =>
  registry?.[name].at(-1)?.fn ?? defaultOps[name];

/** Mounted by the project-workspace module so CommandPalette and the chat, code-editor and sidebar modules share one set of palette operations. */
export function PaletteOpsProvider({ children }: { children: ReactNode }) {
  // One registry for the provider's lifetime, never set again: registrations mutate its stacks in
  // place, so registering an op never re-renders a consumer.
  const [registry] = useState(createPaletteOpsRegistry);
  return <PaletteOpsContext.Provider value={registry}>{children}</PaletteOpsContext.Provider>;
}

/** Stable functions that call whichever registration of each op is newest at call time (a no-op when none is). */
export function usePaletteOps(): PaletteOps {
  const registry = useContext(PaletteOpsContext);
  return useMemo<PaletteOps>(
    () => ({
      openFile: (path) => readTopOp(registry, 'openFile')(path),
      openFileInEditor: (path, line) => readTopOp(registry, 'openFileInEditor')(path, line),
      openDirectory: (path) => readTopOp(registry, 'openDirectory')(path),
      openSettings: (tab) => readTopOp(registry, 'openSettings')(tab),
      refreshProjects: () => readTopOp(registry, 'refreshProjects')(),
      insertComposerText: (text) => readTopOp(registry, 'insertComposerText')(text),
    }),
    [registry],
  );
}

/** Keeps one op registered while `fn` is set; a new identity re-registers it as the newest. */
function usePaletteOpRegistration<K extends PaletteOpName>(
  registry: PaletteOpsRegistry | null,
  name: K,
  fn: PaletteOps[K] | undefined,
) {
  useEffect(() => {
    if (!registry || !fn) return undefined;
    // The provider never replaces its stacks, so the one captured here is the one the cleanup must edit.
    const stack = registry[name];
    const entry: PaletteOpEntry<K> = { fn };
    stack.push(entry);
    return () => {
      const index = stack.indexOf(entry);
      if (index >= 0) stack.splice(index, 1);
    };
  }, [registry, name, fn]);
}

/**
 * Registers the given ops while the caller is mounted; the newest registration of an op wins, and
 * unregistering hands it back to the newest one still mounted. Callers that exist once per pane pass
 * their functions only while their pane is focused (an empty object otherwise), so ops follow focus.
 */
export function usePaletteOpsRegister(partial: Partial<PaletteOps>) {
  const registry = useContext(PaletteOpsContext);
  // One registration per op, so a new identity for one op does not reorder the others.
  usePaletteOpRegistration(registry, 'openFile', partial.openFile);
  usePaletteOpRegistration(registry, 'openFileInEditor', partial.openFileInEditor);
  usePaletteOpRegistration(registry, 'openDirectory', partial.openDirectory);
  usePaletteOpRegistration(registry, 'openSettings', partial.openSettings);
  usePaletteOpRegistration(registry, 'refreshProjects', partial.refreshProjects);
  usePaletteOpRegistration(registry, 'insertComposerText', partial.insertComposerText);
}
