import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, it, vi } from 'vitest';

import '@/modules/i18n';
import { WorkspacePaneProvider } from '@/shared/context/WorkspacePaneContext';
import type { Project } from '@/shared/types';

/**
 * A split workspace can show a terminal in each pane, and a terminal takes DOM
 * focus once it is connected. It did so in whichever pane it was, so a
 * terminal in the pane the user was not in, connecting or reconnecting after
 * a dropped socket, pulled the caret out of the other pane's composer: the
 * next keys went to its CLI, and Escape both stopped the other pane's run and
 * reached the terminal. Only the focused pane's terminal takes focus now.
 */

const runtime = vi.hoisted(() => ({
  isConnected: false,
  focusCalls: 0,
  // Stable like the real hook's ref, so the focus effect runs on connection changes only.
  terminalRef: { current: null as { focus: () => void } | null },
}));

vi.mock('@/modules/shell/hooks/useShellRuntime', () => ({
  useShellRuntime: () => ({
    terminalContainerRef: { current: null },
    terminalRef: runtime.terminalRef,
    wsRef: { current: null },
    isConnected: runtime.isConnected,
    isInitialized: true,
    isConnecting: false,
    isClaudeThemeOutdated: false,
    connectToShell: () => undefined,
    disconnectFromShell: () => undefined,
  }),
}));

const { Shell } = await import('@/modules/shell');

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };

const inPane = (isFocusedPane: boolean, children: ReactNode) => (
  <WorkspacePaneProvider value={{ side: 'right', isFocusedPane, isSplitPane: true, openFileInEditor: null, openDirectory: null }}>
    {children}
  </WorkspacePaneProvider>
);

/** Lets the focus the terminal schedules (a frame, then a task) run. */
const settleFocus = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 40));
});

/** Renders the terminal, then reports its socket open, as useShellRuntime does once connected. */
const renderConnected = async (wrap: (children: ReactNode) => ReactNode) => {
  runtime.isConnected = false;
  const view = render(<>{wrap(<Shell selectedProject={PROJECT} />)}</>);
  runtime.isConnected = true;
  view.rerender(<>{wrap(<Shell selectedProject={PROJECT} />)}</>);
  await settleFocus();
  return {
    setConnected: async (connected: boolean) => {
      runtime.isConnected = connected;
      view.rerender(<>{wrap(<Shell selectedProject={PROJECT} />)}</>);
      await settleFocus();
    },
    rerender: async (nextWrap: (children: ReactNode) => ReactNode) => {
      view.rerender(<>{nextWrap(<Shell selectedProject={PROJECT} />)}</>);
      await settleFocus();
    },
  };
};

beforeEach(() => {
  runtime.isConnected = false;
  runtime.focusCalls = 0;
  runtime.terminalRef.current = {
    focus: () => {
      runtime.focusCalls += 1;
    },
  };
});

describe('a terminal that connects', () => {
  it('takes focus in the focused pane, and on its own outside the workspace', async () => {
    await renderConnected((children) => inPane(true, children));
    assert.equal(runtime.focusCalls > 0, true);

    runtime.focusCalls = 0;
    await renderConnected((children) => children);
    assert.equal(runtime.focusCalls > 0, true);
  });

  it('leaves focus where it is in the other pane, also when it reconnects', async () => {
    const terminal = await renderConnected((children) => inPane(false, children));
    assert.equal(runtime.focusCalls, 0);

    // The socket drops and the terminal connects again by itself.
    await terminal.setConnected(false);
    await terminal.setConnected(true);
    assert.equal(runtime.focusCalls, 0);
  });

  it('does not take focus either when its pane becomes the focused one by a click', async () => {
    const terminal = await renderConnected((children) => inPane(false, children));

    await terminal.rerender((children) => inPane(true, children));

    assert.equal(runtime.focusCalls, 0);
  });
});
