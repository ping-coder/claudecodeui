import { createRef } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import ChatInterface from '@/modules/chat/ChatInterface';
import type { ChatMessage, Project, ProjectSession, SessionActivity } from '@/shared/types';

/**
 * The transcript's background-tasks strip drew a Stop ✕ on every running
 * launch its rows named. Only CloudCLI's own runtime can stop a task, and a
 * history load reads the launches of a Claude CLI CloudCLI does not drive (a
 * Shell tab's `claude --resume`, another CloudCLI instance) as running too,
 * so a click on theirs was refused as NO_SUCH_TASK and left an error row in
 * the transcript. ChatInterface now offers the ✕ only while CloudCLI's
 * runtime drives the viewed session's run.
 *
 * ChatInterface is rendered with the real transcript pane and strip; the
 * hooks that own its session, provider, composer and realtime state stand in
 * with what they would hand it, and the composer, which this is not about,
 * draws nothing.
 */

const noop = () => undefined;

// A Workflow launch as a history load returns it: read running, its
// acknowledgement naming the task.
const runningLaunch: ChatMessage = {
  type: 'assistant',
  content: '',
  timestamp: '2026-10-26T10:00:00.000Z',
  isToolUse: true,
  toolName: 'Workflow',
  toolId: 'toolu_workflow_1',
  workflow: {
    runId: 'wf_1',
    name: 'frontend-audit',
    status: 'running',
    agents: [{ id: 'a1', status: 'running' }],
    agentCounts: { total: 1, completed: 0, failed: 0, running: 1, stopped: 0 },
  },
  toolResult: {
    content: 'Workflow launched in background. Task ID: w1',
    isError: false,
    toolUseResult: { status: 'async_launched', taskId: 'w1', runId: 'wf_1' },
  },
};

/** What useChatSessionState hands ChatInterface for the viewed session; each case sets `sessionActivity`. */
const sessionState = {
  chatMessages: [runningLaunch],
  // The strip reads every loaded row; the transcript's own rows, drawn from
  // the visible window, are not what this is about.
  visibleMessages: [] as ChatMessage[],
  sessionActivity: null as SessionActivity | null,
  currentSessionId: 'session-1',
  scrollContainerRef: createRef<HTMLDivElement>(),
  addMessage: noop,
  setCurrentSessionId: noop,
  isProcessing: false,
  canAbortSession: false,
  isLoadingSessionMessages: false,
  isLoadingMoreMessages: false,
  hasMoreMessages: false,
  totalMessages: 1,
  isUserScrolledUp: false,
  setIsUserScrolledUp: noop,
  tokenBudget: null,
  setTokenBudget: noop,
  visibleMessageCount: 100,
  loadEarlierMessages: noop,
  revealMessage: noop,
  loadAllMessages: noop,
  loadFullTranscript: async () => [],
  allMessagesLoaded: true,
  isLoadingAllMessages: false,
  loadAllJustFinished: false,
  showLoadAllOverlay: false,
  createDiff: () => [],
  scrollToBottom: noop,
  scrollToBottomAndReset: noop,
  handleScroll: noop,
  requestLatestMessages: async () => undefined,
};

vi.mock('@/modules/chat/hooks/useChatSessionState', () => ({ useChatSessionState: () => sessionState }));
vi.mock('@/modules/chat/hooks/useChatProviderState', () => ({
  useChatProviderState: () => ({
    provider: 'claude',
    setProvider: noop,
    providerModels: {},
    setStoredProviderModel: noop,
    permissionMode: 'default',
    pendingPermissionRequests: [],
    setPendingPermissionRequests: noop,
    availablePermissionModes: [],
    providerModelCatalog: {},
    providerModelsLoading: false,
    providerModelActions: {},
    supportsMessageEditing: false,
    supportsSessionForking: false,
    supportsImageAttachments: false,
    supportsFileAttachments: false,
  }),
}));
vi.mock('@/modules/chat/hooks/useChatComposerState', () => ({
  useChatComposerState: () => ({ input: '', setInput: noop, textareaRef: createRef<HTMLTextAreaElement>() }),
}));
vi.mock('@/modules/chat/hooks/useChatRealtimeHandlers', () => ({ useChatRealtimeHandlers: () => undefined }));
vi.mock('@/modules/chat/hooks/useSessionStore', () => ({ useSessionStore: () => ({}) }));
vi.mock('@/modules/chat/composer/useScheduledMessages', () => ({
  useScheduledMessages: () => ({ scheduledMessages: [], schedule: async () => false, cancel: noop }),
}));
vi.mock('@/modules/chat/composer/ChatComposer', () => ({ default: () => null }));
vi.mock('@/modules/chat/modals/CommandResultModal', () => ({ default: () => null }));
vi.mock('@/modules/task-master', () => ({ useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }) }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOpsRegister: () => undefined }));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: () => noop }) }));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useProcessingSessions: () => new Map(),
  useSessionProtectionActions: () => ({
    markSessionProcessing: noop,
    markSessionIdle: noop,
    markSessionBackground: noop,
    getSessionActivity: noop,
  }),
}));

const project: Project = { projectId: 'project-1', path: '/repo', fullPath: '/repo', displayName: 'Repo', isStarred: false };
const session = { id: 'session-1', summary: 'Audit', lastActivity: '2026-10-26T10:00:00.000Z', messageCount: 2 } as ProjectSession;

/** The viewed session's chat with `activity` as its entry in the activity map; returns the strip's Stop buttons and the send. */
function renderChat(activity: SessionActivity | null) {
  sessionState.sessionActivity = activity;
  sessionState.isProcessing = Boolean(activity && !activity.background);
  const sendMessage = vi.fn();
  render(<ChatInterface isActive selectedProject={project} selectedSession={session} ws={null} sendMessage={sendMessage} />);
  const strip = screen.getByRole('status', { name: 'Background tasks' });
  return { stops: within(strip).queryAllByRole('button', { name: 'Stop' }), sendMessage };
}

describe('the background-tasks strip\'s Stop, by who drives the viewed session', () => {
  beforeEach(() => {
    sessionState.sessionActivity = null;
  });

  it('is not offered while a Claude CLI outside CloudCLI drives the turn', () => {
    // What the running-sessions poll reports for such a turn.
    const { stops } = renderChat({ statusText: 'Running in the Claude CLI', canInterrupt: false, startedAt: 1 });
    expect(stops).toHaveLength(0);
  });

  it('is not offered when nothing runs here at all', () => {
    const { stops } = renderChat(null);
    expect(stops).toHaveLength(0);
  });

  it('is offered for a turn sent from here', () => {
    const { stops, sendMessage } = renderChat({ statusText: null, canInterrupt: true, startedAt: 1 });
    expect(stops).toHaveLength(1);
    fireEvent.click(stops[0]!);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'chat.stop-task', sessionId: 'session-1', taskId: 'w1' });
  });

  it('is offered for the background work such a turn left running', () => {
    const { stops, sendMessage } = renderChat({
      statusText: null,
      canInterrupt: false,
      startedAt: 1,
      background: true,
      tasks: [{ taskId: 'w1', toolUseId: 'toolu_workflow_1', taskType: 'local_workflow', description: 'Audit', workflowName: 'frontend-audit', startedAt: 1 }],
    });
    expect(stops).toHaveLength(1);
    fireEvent.click(stops[0]!);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'chat.stop-task', sessionId: 'session-1', taskId: 'w1' });
  });
});
