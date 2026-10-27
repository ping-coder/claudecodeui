import { fireEvent, render, screen, within } from '@testing-library/react';
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import BackgroundSendDialog from '@/modules/chat/composer/BackgroundSendDialog';
import { ScheduleMessagePopover } from '@/modules/chat/composer/ScheduleMessagePopover';
import { AskUserQuestionPanel } from '@/modules/chat/tools/InteractiveRenderers/AskUserQuestionPanel';
import { Markdown } from '@/modules/chat/transcript/Markdown';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import ProviderSelectionEmptyState from '@/modules/chat/transcript/ProviderSelectionEmptyState';
import { WorkspacePaneProvider } from '@/shared/context/WorkspacePaneContext';
import type {
  ChatMessage,
  PendingPermissionRequest,
  ProjectSession,
  ProviderModelActions,
  WorkspacePaneSide,
} from '@/shared/types';

/**
 * With the workspace split, one session's transcript and composer can be on
 * screen twice, and a pane without focus keeps rendering. These pin what the
 * chat does inside a pane: file links open in their own pane, DOM ids never
 * collide across panes, and only the focused pane takes DOM focus or shows
 * TaskMaster's next task.
 */

const { paletteOps } = vi.hoisted(() => ({
  paletteOps: { openFileInEditor: vi.fn(), openDirectory: vi.fn() },
}));

vi.mock('@/modules/command-palette', () => ({ usePaletteOps: () => paletteOps }));

// The real banner pulls in TaskMaster and the terminal stack; a marker shows where it renders.
vi.mock('@/modules/task-master', async () => {
  const { createElement } = await import('react');
  return { NextTaskBanner: () => createElement('div', { 'data-testid': 'next-task-banner' }) };
});

afterEach(() => {
  paletteOps.openFileInEditor.mockReset();
  paletteOps.openDirectory.mockReset();
  // Drop the own properties a test defined, so the jsdom navigator answers again.
  delete (window.navigator as unknown as Record<string, unknown>).platform;
});

type PaneProps = {
  side: WorkspacePaneSide;
  isFocusedPane?: boolean;
  openFileInEditor?: ((filePath: string, line?: number | null) => void) | null;
  openDirectory?: ((directoryPath: string) => void) | null;
  children?: ReactNode;
};

/** Stands in for project-workspace's WorkspaceMain, which provides the pane around each pane's content. */
function Pane({ side, isFocusedPane = true, openFileInEditor = null, openDirectory = null, children }: PaneProps) {
  const value = useMemo(
    () => ({ side, isFocusedPane, isSplitPane: true, openFileInEditor, openDirectory }),
    [side, isFocusedPane, openFileInEditor, openDirectory],
  );
  return (
    <WorkspacePaneProvider value={value}>
      <div data-testid={`pane-${side}`}>{children}</div>
    </WorkspacePaneProvider>
  );
}

const paneElement = (side: WorkspacePaneSide) => screen.getByTestId(`pane-${side}`);

describe('file links in a chat message', () => {
  const MESSAGE = 'See [src/foo.ts:12](src/foo.ts:12) and [docs/](docs/).';

  it('open in the pane showing the message, focused or not, never through the palette', () => {
    const left = { openFileInEditor: vi.fn(), openDirectory: vi.fn() };
    const right = { openFileInEditor: vi.fn(), openDirectory: vi.fn() };
    render(
      <>
        <Pane side="left" isFocusedPane={false} {...left}>
          <Markdown>{MESSAGE}</Markdown>
        </Pane>
        <Pane side="right" {...right}>
          <Markdown>{MESSAGE}</Markdown>
        </Pane>
      </>,
    );

    fireEvent.click(within(paneElement('left')).getByText('src/foo.ts:12'));
    fireEvent.click(within(paneElement('right')).getByText('docs/'));

    expect(left.openFileInEditor.mock.calls).toEqual([['src/foo.ts', 12]]);
    expect(left.openDirectory).not.toHaveBeenCalled();
    expect(right.openDirectory.mock.calls).toEqual([['docs/']]);
    expect(right.openFileInEditor).not.toHaveBeenCalled();
    expect(paletteOps.openFileInEditor).not.toHaveBeenCalled();
    expect(paletteOps.openDirectory).not.toHaveBeenCalled();
  });

  it('fall back to the palette, op by op, where the pane offers no opener', () => {
    const paneOpenFile = vi.fn();
    render(
      <Pane side="left" openFileInEditor={paneOpenFile}>
        <Markdown>{MESSAGE}</Markdown>
      </Pane>,
    );

    fireEvent.click(screen.getByText('src/foo.ts:12'));
    fireEvent.click(screen.getByText('docs/'));

    expect(paneOpenFile.mock.calls).toEqual([['src/foo.ts', 12]]);
    expect(paletteOps.openDirectory.mock.calls).toEqual([['docs/']]);
    expect(paletteOps.openFileInEditor).not.toHaveBeenCalled();
  });
});

const TOOL_ROW: ChatMessage = {
  type: 'tool',
  content: '',
  timestamp: '2026-10-27T08:00:00.000Z',
  isToolUse: true,
};

// A search call with its result: the input row carries the jump arrow, the result row is its target.
const GREP_TOOL_ID = 'toolu_grep_1';
const GREP_CALL: ChatMessage = {
  ...TOOL_ROW,
  toolName: 'Grep',
  toolId: GREP_TOOL_ID,
  toolInput: JSON.stringify({ pattern: 'useWorkspacePane', path: 'src' }),
  toolResult: { content: 'src/a.ts', isError: false, toolUseResult: { filenames: ['src/a.ts'], numFiles: 1 } },
};

const renderRow = (message: ChatMessage) => (
  <MessageComponent message={message} prevMessage={null} createDiff={() => []} provider="claude" />
);

const jumpArrowIn = (container: HTMLElement) => {
  const anchor = container.querySelector<HTMLAnchorElement>('a[href*="tool-result-"]');
  expect(anchor).not.toBeNull();
  return anchor as HTMLAnchorElement;
};

describe('tool-result anchors', () => {
  const renderSessionInBothPanes = () => render(
    <>
      <Pane side="left">{renderRow(GREP_CALL)}</Pane>
      <Pane side="right" isFocusedPane={false}>{renderRow(GREP_CALL)}</Pane>
    </>,
  );

  it('are scoped to the pane, so one session in two panes never repeats a DOM id', () => {
    renderSessionInBothPanes();

    for (const side of ['left', 'right'] as const) {
      const scopedId = `pane-${side}-tool-result-${GREP_TOOL_ID}`;
      expect(paneElement(side).querySelector(`[id="${scopedId}"]`)).not.toBeNull();
      expect(jumpArrowIn(paneElement(side)).getAttribute('href')).toBe(`#${scopedId}`);
    }
    expect(document.getElementById(`tool-result-${GREP_TOOL_ID}`)).toBeNull();
    const ids = Array.from(document.querySelectorAll('[id]'), (element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('scroll only their own pane and leave the URL hash alone', () => {
    renderSessionInBothPanes();
    const leftResult = document.getElementById(`pane-left-tool-result-${GREP_TOOL_ID}`) as HTMLElement;
    const rightResult = document.getElementById(`pane-right-tool-result-${GREP_TOOL_ID}`) as HTMLElement;
    // jsdom has no scrollIntoView.
    leftResult.scrollIntoView = vi.fn();
    rightResult.scrollIntoView = vi.fn();
    const hashBefore = window.location.hash;

    const followedDefault = fireEvent.click(jumpArrowIn(paneElement('right')));

    expect(followedDefault).toBe(false);
    expect(rightResult.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(leftResult.scrollIntoView).not.toHaveBeenCalled();
    expect(window.location.hash).toBe(hashBefore);
  });

  it('cover every kind of tool row', () => {
    const rows: ChatMessage[] = [
      // Bash draws its output in the command row, so that row is the anchor.
      { ...TOOL_ROW, toolName: 'Bash', toolId: 'toolu_bash', toolInput: JSON.stringify({ command: 'ls' }) },
      {
        ...TOOL_ROW,
        toolName: 'Read',
        toolId: 'toolu_read_failed',
        toolInput: JSON.stringify({ file_path: '/repo/missing.ts' }),
        toolResult: { content: 'File does not exist.', isError: true },
      },
      GREP_CALL,
      {
        ...TOOL_ROW,
        toolName: 'Workflow',
        toolId: 'toolu_workflow',
        toolInput: JSON.stringify({ script: "export const meta = { name: 'audit' };", description: 'Audit' }),
      },
      {
        ...TOOL_ROW,
        toolName: 'Agent',
        toolId: 'toolu_agent',
        isSubagentContainer: true,
        toolInput: JSON.stringify({ subagent_type: 'Explore', description: 'Survey the repo' }),
      },
    ];
    render(
      <Pane side="right">
        {rows.map((message) => <div key={message.toolId}>{renderRow(message)}</div>)}
      </Pane>,
    );

    for (const toolId of ['toolu_bash', 'toolu_read_failed', GREP_TOOL_ID, 'toolu_workflow', 'toolu_agent']) {
      expect(document.getElementById(`pane-right-tool-result-${toolId}`), toolId).not.toBeNull();
      expect(document.getElementById(`tool-result-${toolId}`), toolId).toBeNull();
    }
  });

  it('keep the bare id outside the split workspace, and still scroll by hand', () => {
    const { container } = render(renderRow(GREP_CALL));
    const result = document.getElementById(`tool-result-${GREP_TOOL_ID}`) as HTMLElement;
    expect(result).not.toBeNull();
    result.scrollIntoView = vi.fn();

    const arrow = jumpArrowIn(container);
    expect(arrow.getAttribute('href')).toBe(`#tool-result-${GREP_TOOL_ID}`);
    fireEvent.click(arrow);

    expect(result.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });
});

const QUESTION_REQUEST: PendingPermissionRequest = {
  requestId: 'request-1',
  toolName: 'AskUserQuestion',
  input: { questions: [{ question: 'Which file first?', options: [{ label: 'a.ts' }, { label: 'b.ts' }] }] },
  sessionId: 'session-right',
};

/** The other pane's composer, where the user is typing, beside the pane the question arrives in. */
function QuestionBesideComposer({ isFocusedPane, showQuestion = true }: { isFocusedPane: boolean; showQuestion?: boolean }) {
  return (
    <>
      <textarea aria-label="Composer in the other pane" />
      <Pane side="right" isFocusedPane={isFocusedPane}>
        {showQuestion && <AskUserQuestionPanel request={QUESTION_REQUEST} onDecision={() => {}} />}
      </Pane>
    </>
  );
}

/** Mounts the question while the user is typing in the other pane's composer. */
const askWhileTyping = (isFocusedPane: boolean) => {
  const view = render(<QuestionBesideComposer isFocusedPane={isFocusedPane} showQuestion={false} />);
  const composer = screen.getByLabelText('Composer in the other pane');
  composer.focus();
  view.rerender(<QuestionBesideComposer isFocusedPane={isFocusedPane} />);
  return { view, composer };
};

const otherAnswerInput = () => document.querySelector<HTMLInputElement>(`[data-testid="pane-right"] input[type="text"]`);

describe('AskUserQuestion in a pane', () => {
  it('leaves the caret in the composer when it arrives in a pane without focus', () => {
    const { composer } = askWhileTyping(false);
    expect(document.activeElement).toBe(composer);

    // Opening the free-text answer focuses it only in the focused pane, too.
    fireEvent.click(screen.getByText('Other...'));
    expect(otherAnswerInput()).not.toBeNull();
    expect(document.activeElement).toBe(composer);
  });

  it('takes focus as before in the focused pane', () => {
    askWhileTyping(true);
    expect(document.activeElement).toBe(screen.getByText('Which file first?').closest('[tabindex="-1"]'));

    fireEvent.click(screen.getByText('Other...'));
    expect(document.activeElement).toBe(otherAnswerInput());
  });

  it('does not pull the caret in later, when its pane gains focus', () => {
    const { view, composer } = askWhileTyping(false);

    view.rerender(<QuestionBesideComposer isFocusedPane />);

    expect(document.activeElement).toBe(composer);
  });
});

const PROVIDER_MODEL_ACTIONS: ProviderModelActions = {
  create: async () => {},
  update: async () => {},
  remove: async () => {},
  setCustomModelsOnly: async () => {},
};

const renderEmptyState = (selectedSession: ProjectSession | null) => (
  <ProviderSelectionEmptyState
    selectedSession={selectedSession}
    currentSessionId={null}
    provider="claude"
    setProvider={() => {}}
    textareaRef={{ current: null }}
    providerModels={{ claude: 'default', codex: '', cursor: '', opencode: '', agy: '' }}
    setProviderModel={() => {}}
    providerModelCatalog={{}}
    providerModelActions={PROVIDER_MODEL_ACTIONS}
    providerModelsLoading={false}
    tasksEnabled
    isTaskMasterInstalled
    setInput={() => {}}
  />
);

describe('the new-chat empty state', () => {
  it.each([
    ['a new chat', null],
    ['a session with no messages yet', { id: 'session-1' }],
  ])('offers the next task only in the focused pane, on %s', (_label, selectedSession) => {
    render(
      <>
        <Pane side="left">{renderEmptyState(selectedSession)}</Pane>
        <Pane side="right" isFocusedPane={false}>{renderEmptyState(selectedSession)}</Pane>
      </>,
    );

    expect(within(paneElement('left')).queryByTestId('next-task-banner')).not.toBeNull();
    expect(within(paneElement('right')).queryByTestId('next-task-banner')).toBeNull();
  });

  it('names the palette shortcut for the platform it renders on', () => {
    const shortcutShownOn = (platform: string) => {
      Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true });
      const view = render(renderEmptyState(null));
      const shortcut = view.container.querySelector('kbd')?.textContent;
      view.unmount();
      return shortcut;
    };

    expect(shortcutShownOn('MacIntel')).toBe('⌘K');
    expect(shortcutShownOn('Win32')).toBe('Ctrl+K');
  });
});

describe('composer dialogs rendered once per pane', () => {
  it('give each background-work dialog its own description', () => {
    const prompt = { work: ['Workflow frontend-architecture-audit'] };
    render(
      <>
        <BackgroundSendDialog prompt={prompt} onResolve={() => {}} />
        <BackgroundSendDialog prompt={prompt} onResolve={() => {}} />
      </>,
    );

    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs).toHaveLength(2);
    const descriptionIds = dialogs.map((dialog) => dialog.getAttribute('aria-describedby'));
    expect(new Set(descriptionIds).size).toBe(2);
    dialogs.forEach((dialog, index) => {
      const description = document.getElementById(descriptionIds[index] ?? '');
      expect(description?.textContent).toContain('A new message starts a new turn');
      expect(dialog.contains(description)).toBe(true);
    });
  });

  it('give each schedule popover its own labelled time input', () => {
    render(
      <>
        <ScheduleMessagePopover disabled={false} onSchedule={() => {}} />
        <ScheduleMessagePopover disabled={false} onSchedule={() => {}} />
      </>,
    );
    for (const trigger of screen.getAllByRole('button', { name: 'Schedule this message' })) {
      fireEvent.click(trigger);
    }

    const menus = screen.getAllByRole('menu');
    expect(menus).toHaveLength(2);
    const inputs = menus.map((menu) => menu.querySelector<HTMLInputElement>('input[type="datetime-local"]'));
    expect(new Set(inputs.map((input) => input?.id)).size).toBe(2);
    menus.forEach((menu, index) => {
      expect(inputs[index]?.id).toBeTruthy();
      expect(menu.querySelector('label')?.htmlFor).toBe(inputs[index]?.id);
    });
  });
});
