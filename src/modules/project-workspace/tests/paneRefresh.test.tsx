import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { Project, ProjectSession } from '@/shared/types';

/**
 * Refreshing a tab, or everything, without reloading the page. The view on screen reloads in place, the
 * chat hears a new refresh trigger without remounting, a clean editor rereads its file while one with
 * unsaved edits keeps them and says so, the editor keeps the browser's full screen, a terminal mounts
 * again and reconnects on its own (never through its restart), the other views reload without
 * remounting (Tasks only while on screen) and a plugin tab mounts its code again. Refresh all reaches
 * every mounted pane and asks for the project list once, single-flight. Runs the real project state,
 * pane group, panes, WorkspaceMain, file tree, code editor and StandaloneShell; the chat, the terminal,
 * CodeMirror and the other heavy views are stand-ins.
 */

// Hoisted: the i18n import above already loads the API module, before this file's own constants exist.
const { projectsResponse, getFiles, readFile, saveFile } = vi.hoisted(() => ({
  projectsResponse: vi.fn(),
  getFiles: vi.fn(),
  readFile: vi.fn(),
  saveFile: vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) })),
}));

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectTaskmaster: async () => ({ ok: false }),
    projectSessions: async () => ({ ok: false }),
    sessionDetails: async () => ({ ok: false, status: 404 }),
    getFiles: (...args: unknown[]) => getFiles(...args),
    readFile: (...args: unknown[]) => readFile(...args),
    saveFile,
  },
  readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
}));
vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }) }));
vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange }: { value: string; onChange?: (value: string) => void }) => (
    <textarea aria-label="code" value={value} onChange={(event) => onChange?.(event.target.value)} />
  ),
}));
const NO_SESSIONS: ReadonlySet<string> = new Set();
const noop = () => undefined;

// Every chat mount, and the refresh trigger each chat (by session id) saw last.
const chatLifecycle = { mounts: 0, unmounts: 0 };
const chatTriggers = new Map<string, number | undefined>();
// Every terminal mount and unmount, and how each mounted terminal was asked to connect.
const shellLifecycle = { mounts: 0, unmounts: 0, connects: [] as Array<{ sessionId: string | null; autoConnect: boolean }> };

vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useBusySessionIdSet: () => NO_SESSIONS,
  useBackgroundSessionIdSet: () => NO_SESSIONS,
}));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ connectionStatus: 'connected' }) }));
vi.mock('@/shared/context/UiPreferencesContext', () => ({
  useUiPreferences: () => ({ showRawParameters: false, showThinking: false, sendByCtrlEnter: false, sidebarVisible: true }),
}));
vi.mock('@/modules/chat', () => ({
  ChatInterface: ({ selectedProject, selectedSession, onFileOpen, refreshTrigger }: {
    selectedProject: Project | null;
    selectedSession: ProjectSession | null;
    onFileOpen?: (filePath: string) => void;
    refreshTrigger?: number;
  }) => {
    useEffect(() => {
      chatLifecycle.mounts += 1;
      return () => {
        chatLifecycle.unmounts += 1;
      };
    }, []);
    const sessionId = selectedSession?.id ?? 'draft';
    useEffect(() => {
      chatTriggers.set(sessionId, refreshTrigger);
    }, [refreshTrigger, sessionId]);
    return (
      <button type="button" onClick={() => onFileOpen?.(`/repo/${selectedProject?.projectId}/src/app.ts`)}>
        {`open file in ${sessionId}`}
      </button>
    );
  },
}));
// The terminal inside the real StandaloneShell. A mounting Shell connects on its own and reattaches to
// the shell the server keeps (shell's shellRemountReattach.test.tsx); only its restart button restarts it.
vi.mock('@/modules/shell', async () => {
  const { useState: useTerminalState } = await import('react');
  return {
    Shell: ({ selectedSession, autoConnect }: { selectedSession: ProjectSession | null; autoConnect: boolean }) => {
      // How this instance was asked to connect when it mounted.
      const [connect] = useTerminalState(() => ({ sessionId: selectedSession?.id ?? null, autoConnect }));
      useEffect(() => {
        shellLifecycle.mounts += 1;
        shellLifecycle.connects.push(connect);
        return () => {
          shellLifecycle.unmounts += 1;
        };
      }, [connect]);
      return <div data-testid="terminal" />;
    },
  };
});
// The other views, as probes of the refresh token each gets (and of their mounts).
const views = vi.hoisted(() => ({
  tasksAndBrowserEnabled: false,
  tokens: { git: [] as Array<number | undefined>, browser: [] as Array<number | undefined>, tasks: [] as Array<number | undefined> },
  mounts: { git: 0, browser: 0, plugin: 0 },
}));
vi.mock('@/modules/git-panel', async () => {
  const { useEffect: useViewEffect } = await import('react');
  return {
    GitPanel: ({ refreshToken }: { refreshToken?: number }) => {
      useViewEffect(() => {
        views.mounts.git += 1;
      }, []);
      useViewEffect(() => {
        views.tokens.git.push(refreshToken);
      }, [refreshToken]);
      return <div />;
    },
  };
});
vi.mock('@/modules/plugins', async () => {
  const { useEffect: useViewEffect } = await import('react');
  return {
    usePlugins: () => ({ plugins: [] }),
    PluginIcon: () => null,
    PluginTabContent: () => {
      useViewEffect(() => {
        views.mounts.plugin += 1;
      }, []);
      return <div />;
    },
  };
});
vi.mock('@/modules/browser-use', async () => {
  const { useEffect: useViewEffect } = await import('react');
  return {
    BrowserUsePanel: ({ refreshToken }: { refreshToken?: number }) => {
      useViewEffect(() => {
        views.mounts.browser += 1;
      }, []);
      useViewEffect(() => {
        views.tokens.browser.push(refreshToken);
      }, [refreshToken]);
      return <div />;
    },
    useBrowserUseEnabled: () => views.tasksAndBrowserEnabled,
  };
});
vi.mock('@/modules/task-master', async () => {
  const { useEffect: useViewEffect } = await import('react');
  return {
    TaskMasterPanel: ({ refreshToken }: { refreshToken?: number }) => {
      useViewEffect(() => {
        views.tokens.tasks.push(refreshToken);
      }, [refreshToken]);
      return <div />;
    },
    useTaskMaster: () => ({ currentProject: { projectId: 'alpha' } }),
    useTasksSettings: () => ({ tasksEnabled: views.tasksAndBrowserEnabled, isTaskMasterInstalled: views.tasksAndBrowserEnabled }),
    useTaskMasterProjectSync: () => undefined,
  };
});

const { ProjectsStateProvider, useProjectPanesState } = await import('@/modules/project-workspace/context/ProjectsStateContext');
const { WorkspaceChromeProvider } = await import('@/modules/project-workspace/context/WorkspaceChromeContext');
const { default: ProjectMainRegion } = await import('@/modules/project-workspace/ProjectMainRegion');

const ALPHA: Project = {
  projectId: 'alpha',
  displayName: 'Alpha',
  fullPath: '/repo/alpha',
  path: '/repo/alpha',
  sessions: [{ id: 'a1', summary: 'Chat a1', __provider: 'claude' }],
  sessionMeta: { hasMore: false, total: 1 },
};
const BETA: Project = {
  projectId: 'beta',
  displayName: 'Beta',
  fullPath: '/repo/beta',
  path: '/repo/beta',
  sessions: [{ id: 'b1', summary: 'Chat b1', __provider: 'claude' }],
  sessionMeta: { hasMore: false, total: 1 },
};
const rowOf = (project: Project, sessionId: string): ProjectSession => ({
  id: sessionId,
  summary: `Chat ${sessionId}`,
  __provider: 'claude',
  __projectId: project.projectId,
});

type PanesState = ReturnType<typeof useProjectPanesState>;
const harness: { panes: PanesState | null } = { panes: null };
const panes = () => harness.panes as PanesState;

function HarnessProbe() {
  const panesState = useProjectPanesState();
  useEffect(() => {
    harness.panes = panesState;
  });
  return null;
}

const navigate = vi.fn() as unknown as NavigateFunction;
const refreshAppState = vi.fn(async () => undefined);

function Workspace({ canSplit = true }: { canSplit?: boolean }) {
  return (
    <ProjectsStateProvider
      navigate={navigate}
      subscribe={() => noop}
      isMobile={false}
      isSessionProcessing={() => false}
      refreshAppState={refreshAppState}
    >
      <WorkspaceChromeProvider
        value={{
          isImmersive: false,
          isBrowserFullscreen: false,
          toggleImmersive: noop,
          exitImmersive: noop,
          isSidebarPeekOpen: false,
          setSidebarPeekOpen: noop,
          canSplit,
        }}
      >
        <ProjectMainRegion isMobile={false} ws={null} sendMessage={noop} navigate={navigate} />
        <HarnessProbe />
      </WorkspaceChromeProvider>
    </ProjectsStateProvider>
  );
}

const projectsReply = () => ({ ok: true, json: async () => [ALPHA, BETA] });
const filesReply = (names: string[]) => new Response(
  JSON.stringify(names.map((name) => ({ name, path: `/repo/alpha/${name}`, type: 'file' }))),
  { status: 200 },
);
/** What the disk holds for src/app.ts; readFile answers with it. */
const disk = { content: 'hello' };

const renderWorkspace = async ({ canSplit = true } = {}) => {
  render(<Workspace canSplit={canSplit} />);
  await waitFor(() => assert.equal(panes().isLoadingProjects, false));
};

const run = (change: () => void) => {
  act(() => {
    change();
  });
};

const paneElement = (side: 'left' | 'right') => document.querySelector(`[data-workspace-pane="${side}"]`) as HTMLElement;
const refreshTabButton = (side: 'left' | 'right') => within(paneElement(side)).getByRole('button', { name: 'Refresh tab' });
const refreshAllButton = () => screen.getByRole('button', { name: 'Refresh all' });
// Strings rather than nodes: a failed assertion on a jsdom node walks the whole tree.
const editorValues = () => screen.queryAllByLabelText<HTMLTextAreaElement>('code').map((editor) => editor.value);
const hasText = (text: string) => screen.queryByText(text) !== null;

/** Opens src/app.ts from the chat of `sessionId` and waits for the editor to show what the disk holds. */
const openFileFromChat = async (sessionId: string) => {
  fireEvent.click(screen.getByRole('button', { name: `open file in ${sessionId}` }));
  await waitFor(() => assert.deepEqual(editorValues(), [disk.content]));
};

let fullscreenElement: Element | null = null;
const requestFullscreen = vi.fn(async () => {
  fullscreenElement = document.documentElement;
  document.dispatchEvent(new Event('fullscreenchange'));
});
const exitFullscreen = vi.fn(async () => {
  fullscreenElement = null;
  document.dispatchEvent(new Event('fullscreenchange'));
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  harness.panes = null;
  chatLifecycle.mounts = 0;
  chatLifecycle.unmounts = 0;
  chatTriggers.clear();
  shellLifecycle.mounts = 0;
  shellLifecycle.unmounts = 0;
  shellLifecycle.connects = [];
  views.tasksAndBrowserEnabled = false;
  views.tokens = { git: [], browser: [], tasks: [] };
  views.mounts = { git: 0, browser: 0, plugin: 0 };
  disk.content = 'hello';
  projectsResponse.mockReset();
  projectsResponse.mockImplementation(async () => projectsReply());
  getFiles.mockReset();
  getFiles.mockImplementation(async () => filesReply(['README.md']));
  readFile.mockReset();
  readFile.mockImplementation(async () => ({ ok: true, json: async () => ({ content: disk.content }) }));
  refreshAppState.mockClear();
  fullscreenElement = null;
  requestFullscreen.mockClear();
  exitFullscreen.mockClear();
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true });
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
  Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, writable: true, value: requestFullscreen });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, writable: true, value: exitFullscreen });
  // jsdom has no ResizeObserver; the panes, the file tree and the editor observe their size with it.
  vi.stubGlobal('ResizeObserver', class {
    observe() {}

    unobserve() {}

    disconnect() {}
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [target, key] of [[document, 'fullscreenEnabled'], [document, 'fullscreenElement'], [document.documentElement, 'requestFullscreen'], [document, 'exitFullscreen']] as const) {
    Reflect.deleteProperty(target, key);
  }
});

test('refreshing a tab reloads its file tree behind the rows on screen and has its chat catch up without remounting it', async () => {
  await renderWorkspace();
  run(() => panes().actions.openSession(rowOf(ALPHA, 'a1'), { view: 'files' }));
  await waitFor(() => assert.equal(hasText('README.md'), true));
  assert.equal(getFiles.mock.calls.length, 1);
  const triggerBefore = chatTriggers.get('a1');
  const chatMountsBefore = chatLifecycle.mounts;

  // The reload answers later: meanwhile the tree stays, no loading state in its place.
  let answer: (response: Response) => void = noop;
  getFiles.mockImplementationOnce(() => new Promise<Response>((resolve) => {
    answer = resolve;
  }));
  fireEvent.click(refreshTabButton('left'));

  await waitFor(() => assert.equal(getFiles.mock.calls.length, 2));
  assert.equal(hasText('README.md'), true, 'the rows stay while the tree reloads');
  await act(async () => {
    answer(filesReply(['README.md', 'CHANGELOG.md']));
  });
  await waitFor(() => assert.equal(hasText('CHANGELOG.md'), true));

  assert.equal(typeof triggerBefore, 'number');
  assert.equal(chatTriggers.get('a1'), (triggerBefore as number) + 1, 'the chat hears a new refresh trigger');
  assert.equal(chatLifecycle.mounts, chatMountsBefore, 'the same chat instance');
  assert.equal(chatLifecycle.unmounts, 0);
  assert.equal(projectsResponse.mock.calls.length, 1, 'a tab refresh asks for no project list');
});

test('a clean editor rereads its file on refresh; one with unsaved edits keeps them, is not reread and says so', async () => {
  await renderWorkspace();
  run(() => panes().actions.openSession(rowOf(ALPHA, 'a1')));
  await openFileFromChat('a1');
  assert.equal(readFile.mock.calls.length, 1);

  disk.content = 'changed on disk';
  fireEvent.click(refreshTabButton('left'));
  await waitFor(() => assert.deepEqual(editorValues(), ['changed on disk']));
  assert.equal(readFile.mock.calls.length, 2);
  assert.equal(screen.queryByLabelText('Unsaved changes') === null, true, 'what was reread is the new baseline');

  const editor = screen.getByLabelText<HTMLTextAreaElement>('code');
  fireEvent.change(editor, { target: { value: 'my edit' } });
  await waitFor(() => assert.equal(screen.queryByLabelText('Unsaved changes') !== null, true));
  disk.content = 'changed again';
  fireEvent.click(refreshTabButton('left'));

  await waitFor(() => assert.equal(hasText('Unsaved changes, so the file was not reloaded'), true));
  assert.deepEqual(editorValues(), ['my edit'], 'the edit is still there');
  assert.equal(readFile.mock.calls.length, 2, 'and the file was not read again');
});

test('the editor keeps the browser full screen through Refresh all', async () => {
  await renderWorkspace();
  run(() => panes().actions.openSession(rowOf(ALPHA, 'a1')));
  await openFileFromChat('a1');
  act(() => {
    fireEvent.click(screen.getByTitle('Fullscreen'));
  });
  await act(async () => undefined);
  assert.equal(requestFullscreen.mock.calls.length, 1);
  assert.equal(document.fullscreenElement !== null, true);

  disk.content = 'changed on disk';
  await act(async () => {
    fireEvent.click(refreshAllButton());
  });
  await waitFor(() => assert.deepEqual(editorValues(), ['changed on disk']));

  assert.equal(exitFullscreen.mock.calls.length, 0, 'no holder let go of the full screen');
  assert.equal(document.fullscreenElement !== null, true);
  assert.equal(screen.queryByTitle('Exit fullscreen') !== null, true, 'the editor is still the full-screen one');
});

test('refreshing a terminal tab mounts its terminal again, which connects on its own to the same session', async () => {
  await renderWorkspace();
  run(() => panes().actions.openSession(rowOf(ALPHA, 'a1'), { view: 'shell' }));
  await waitFor(() => assert.equal(shellLifecycle.mounts, 1));

  fireEvent.click(refreshTabButton('left'));

  await waitFor(() => assert.equal(shellLifecycle.mounts, 2));
  assert.equal(shellLifecycle.unmounts, 1, 'the old terminal let go of its socket');
  assert.deepEqual(shellLifecycle.connects, [
    { sessionId: 'a1', autoConnect: true },
    { sessionId: 'a1', autoConnect: true },
  ]);
});

test('Refresh all reaches both panes, asks for the project list once and does nothing more while it runs', async () => {
  await renderWorkspace();
  run(() => panes().actions.openSession(rowOf(ALPHA, 'a1'), { view: 'files' }));
  run(() => panes().actions.split());
  run(() => panes().actions.openSession(rowOf(BETA, 'b1')));
  await waitFor(() => assert.equal(hasText('README.md'), true));
  const leftBefore = chatTriggers.get('a1') as number;
  const rightBefore = chatTriggers.get('b1') as number;
  const projectRequestsBefore = projectsResponse.mock.calls.length;
  const chatMountsBefore = chatLifecycle.mounts;

  let answerProjects: (value: unknown) => void = noop;
  projectsResponse.mockImplementationOnce(() => new Promise((resolve) => {
    answerProjects = resolve;
  }));
  fireEvent.click(refreshAllButton());

  await waitFor(() => assert.equal(getFiles.mock.calls.length, 2, 'the left pane\'s files reload'));
  await waitFor(() => assert.equal(chatTriggers.get('a1'), leftBefore + 1));
  assert.equal(chatTriggers.get('b1'), rightBefore + 1, 'and the right pane\'s chat catches up');
  assert.equal(projectsResponse.mock.calls.length, projectRequestsBefore + 1, 'one project list');
  assert.equal(refreshAppState.mock.calls.length, 1);
  assert.equal(refreshAllButton().getAttribute('aria-busy'), 'true');

  // A second press while the first runs, or F5 or the palette calling it straight: nothing more.
  fireEvent.click(refreshAllButton());
  let secondRun: Promise<void> | null = null;
  act(() => {
    secondRun = panes().refreshWorkspace();
  });
  assert.equal(secondRun !== null, true);
  assert.equal(projectsResponse.mock.calls.length, projectRequestsBefore + 1);
  assert.equal(refreshAppState.mock.calls.length, 1);
  assert.equal(chatTriggers.get('a1'), leftBefore + 1);

  await act(async () => {
    answerProjects(projectsReply());
  });
  await waitFor(() => assert.equal(refreshAllButton().hasAttribute('aria-busy'), false));
  assert.equal(chatLifecycle.mounts, chatMountsBefore, 'no chat remounted');
  assert.equal(chatLifecycle.unmounts, 0);

  // Settled, it runs again.
  fireEvent.click(refreshAllButton());
  await waitFor(() => assert.equal(projectsResponse.mock.calls.length, projectRequestsBefore + 2));
});

test('Refresh all also reaches the pane a collapsed split keeps hidden; Refresh tab only its own pane', async () => {
  await renderWorkspace({ canSplit: false });
  run(() => panes().actions.openSession(rowOf(ALPHA, 'a1')));
  run(() => panes().actions.split());
  run(() => panes().actions.openSession(rowOf(BETA, 'b1')));
  assert.equal(paneElement('left').classList.contains('hidden'), true, 'the left pane is mounted but hidden');
  const leftBefore = chatTriggers.get('a1') as number;
  const rightBefore = chatTriggers.get('b1') as number;

  fireEvent.click(refreshTabButton('right'));
  await waitFor(() => assert.equal(chatTriggers.get('b1'), rightBefore + 1));
  assert.equal(chatTriggers.get('a1'), leftBefore, 'a tab refresh leaves the other pane alone');

  await act(async () => {
    fireEvent.click(refreshAllButton());
  });
  await waitFor(() => assert.equal(chatTriggers.get('a1'), leftBefore + 1));
  assert.equal(chatTriggers.get('b1'), rightBefore + 2);
});

test('each view reloads its own way: git and browser in place, tasks only while on screen, a plugin tab mounts its code again', async () => {
  views.tasksAndBrowserEnabled = true;
  await renderWorkspace();
  run(() => panes().actions.openSession(rowOf(ALPHA, 'a1'), { view: 'git' }));
  await waitFor(() => assert.equal(views.tokens.git.length, 1));
  const tabKey = panes().layout.left.activeTabKey as string;
  const tasksTokensBefore = views.tokens.tasks.length;

  fireEvent.click(refreshTabButton('left'));
  await waitFor(() => assert.equal(views.tokens.git.length, 2));
  assert.equal(views.tokens.git[1], (views.tokens.git[0] as number) + 1);
  assert.equal(views.mounts.git, 1, 'it reloads in place');
  assert.equal(views.tokens.tasks.length, tasksTokensBefore, 'the hidden Tasks panel is left alone');

  run(() => panes().actions.setTabView('left', tabKey, 'browser'));
  await waitFor(() => assert.equal(views.tokens.browser.length, 1));
  fireEvent.click(refreshTabButton('left'));
  await waitFor(() => assert.equal(views.tokens.browser.length, 2));
  assert.equal(views.mounts.browser, 1, 'Browser Use keeps its instance, and with it its full screen');

  run(() => panes().actions.setTabView('left', tabKey, 'tasks'));
  fireEvent.click(refreshTabButton('left'));
  await waitFor(() => assert.equal(views.tokens.tasks.length, tasksTokensBefore + 1, 'on screen, Tasks reloads'));

  run(() => panes().actions.setTabView('left', tabKey, 'plugin:demo'));
  await waitFor(() => assert.equal(views.mounts.plugin, 1));
  fireEvent.click(refreshTabButton('left'));
  await waitFor(() => assert.equal(views.mounts.plugin, 2));
});
