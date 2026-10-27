import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { useCallback, useEffect, useState } from 'react';
import { beforeEach, test } from 'vitest';

import {
  PaletteOpsProvider,
  usePaletteOps,
  usePaletteOpsRegister,
} from '@/modules/command-palette/context/PaletteOpsContext';
import type { PaletteOps } from '@/modules/command-palette/context/PaletteOpsContext';

/**
 * The palette ops registry keeps a stack of live registrations per op. A registrant that goes away
 * removes only its own entry, so a callback of an unmounted registrant (a closed pane) can never come
 * back, whatever order registrants unmount in. Panes register only while focused, so ops follow focus.
 */

const calls: string[] = [];

/** Stands in for a pane's WorkspaceMain: registers openFileInEditor under its name. `version` changes the callback identity. */
function Registrant({ name, version = 1 }: { name: string; version?: number }) {
  const openFileInEditor = useCallback((path: string) => {
    calls.push(`${name}@${version}:${path}`);
  }, [name, version]);
  usePaletteOpsRegister({ openFileInEditor });
  return null;
}

let readOps: PaletteOps | null = null;

/** Stands in for chat's file links and the palette: reads the ops the way their consumers do. */
function OpsReader() {
  const ops = usePaletteOps();
  useEffect(() => {
    readOps = ops;
  }, [ops]);
  return null;
}

type Mounted = Array<{ name: string; version?: number }>;

function Registry({ mounted }: { mounted: Mounted }) {
  return (
    <PaletteOpsProvider>
      <OpsReader />
      {mounted.map(({ name, version }) => <Registrant key={name} name={name} version={version} />)}
    </PaletteOpsProvider>
  );
}

/** Which registrant answers a call right now, as `name@version`; null when the op falls back to its no-op. */
const answeringRegistrant = (): string | null => {
  calls.length = 0;
  readOps?.openFileInEditor('a.ts', 3);
  assert.ok(calls.length <= 1, `one registration answers, got ${calls.join(', ')}`);
  return calls[0]?.replace(/:a\.ts$/, '') ?? null;
};

const permutations = <T,>(items: T[]): T[][] => (
  items.length <= 1
    ? [items]
    : items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]))
);

beforeEach(() => {
  calls.length = 0;
  readOps = null;
});

test('no unmount order brings back the callback of a registrant that is gone', () => {
  const names = ['left', 'right', 'third'];
  for (const unmountOrder of permutations(names)) {
    // Registered one at a time, so the registration order is left, right, third.
    const { rerender, unmount } = render(<Registry mounted={[]} />);
    for (let count = 1; count <= names.length; count += 1) {
      rerender(<Registry mounted={names.slice(0, count).map((name) => ({ name }))} />);
    }
    assert.equal(answeringRegistrant(), 'third@1');

    const remaining = [...names];
    for (const gone of unmountOrder) {
      remaining.splice(remaining.indexOf(gone), 1);
      rerender(<Registry mounted={remaining.map((name) => ({ name }))} />);
      const newestRemaining = remaining.at(-1);
      assert.equal(
        answeringRegistrant(),
        newestRemaining ? `${newestRemaining}@1` : null,
        `unmount order ${unmountOrder.join(' > ')}, after ${gone} went`,
      );
    }
    unmount();
  }
});

test('re-registering with a new callback makes it the newest without reviving one that left meanwhile', () => {
  const { rerender } = render(<Registry mounted={[{ name: 'left' }]} />);
  rerender(<Registry mounted={[{ name: 'left' }, { name: 'right' }]} />);
  assert.equal(answeringRegistrant(), 'right@1');

  // The left pane re-renders with a new handler: it re-registers as the newest.
  rerender(<Registry mounted={[{ name: 'left', version: 2 }, { name: 'right' }]} />);
  assert.equal(answeringRegistrant(), 'left@2');

  rerender(<Registry mounted={[{ name: 'left', version: 2 }]} />);
  assert.equal(answeringRegistrant(), 'left@2');

  // Both gone: nothing answers (a single "previous" slot handed the call to the unmounted right pane).
  rerender(<Registry mounted={[]} />);
  assert.equal(answeringRegistrant(), null);
});

type WorkspaceApi = {
  setFocusedSide: (side: 'left' | 'right') => void;
  setSplit: (split: boolean) => void;
};

let workspaceApi: WorkspaceApi | null = null;

/** Stands in for a pane: like WorkspaceMain, it hands its handler over only while focused. */
function FocusGatedPane({ side, isFocused }: { side: 'left' | 'right'; isFocused: boolean }) {
  const openFileInEditor = useCallback((path: string) => {
    calls.push(`${side}@1:${path}`);
  }, [side]);
  usePaletteOpsRegister(isFocused ? { openFileInEditor } : {});
  return null;
}

function TwoPaneWorkspace() {
  const [focusedSide, setFocusedSide] = useState<'left' | 'right'>('left');
  const [split, setSplit] = useState(true);
  useEffect(() => {
    workspaceApi = { setFocusedSide, setSplit };
  }, []);
  return (
    <PaletteOpsProvider>
      <OpsReader />
      <FocusGatedPane side="left" isFocused={!split || focusedSide === 'left'} />
      {split && <FocusGatedPane side="right" isFocused={focusedSide === 'right'} />}
    </PaletteOpsProvider>
  );
}

test('with focus-gated registration, ops always reach the focused pane', () => {
  const { unmount } = render(<TwoPaneWorkspace />);
  assert.equal(answeringRegistrant(), 'left@1');

  act(() => workspaceApi?.setFocusedSide('right'));
  assert.equal(answeringRegistrant(), 'right@1');

  act(() => workspaceApi?.setFocusedSide('left'));
  assert.equal(answeringRegistrant(), 'left@1');

  // Merging while the right pane is focused: the right pane unmounts and the left one takes over.
  act(() => workspaceApi?.setFocusedSide('right'));
  act(() => workspaceApi?.setSplit(false));
  assert.equal(answeringRegistrant(), 'left@1');

  // Splitting again with the right side focused hands the ops back to the new right pane.
  act(() => workspaceApi?.setSplit(true));
  assert.equal(answeringRegistrant(), 'right@1');

  act(() => workspaceApi?.setFocusedSide('left'));
  assert.equal(answeringRegistrant(), 'left@1');

  unmount();
  assert.equal(answeringRegistrant(), null);
});
