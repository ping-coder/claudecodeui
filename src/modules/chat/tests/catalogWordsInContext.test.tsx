import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import type { RefObject } from 'react';

import { i18n } from '@/modules/i18n';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';
import ProviderSelectionEmptyState from '@/modules/chat/transcript/ProviderSelectionEmptyState';
import type * as ApiModule from '@/shared/api';
import type { LLMProvider, Project, ProviderModelActions, ProviderModelsDefinition } from '@/shared/types';

/**
 * Where the catalog's English shows inside a sentence or is searched, the interface language
 * holds there too: the new conversation's "ready" line names the model by its catalog name (in
 * the interface language), not by the id the CLI is given; /models describes the built-in models
 * it knows in the interface language, and keeps any other description as sent; the slash menu
 * finds a built-in command by the description it shows.
 */

const listCommands = vi.fn();
const listSkills = vi.fn();

vi.mock('@/shared/api', async (importOriginal) => {
  const original = await importOriginal<typeof ApiModule>();
  return {
    ...original,
    api: {
      ...original.api,
      commands: { list: (...args: unknown[]) => listCommands(...args) },
      providers: { ...original.api.providers, skills: (...args: unknown[]) => listSkills(...args) },
    },
  };
});

// The picker's task banner pulls in the terminal stack; these tests never show it.
vi.mock('@/modules/task-master', () => ({ NextTaskBanner: () => null }));

const { useSlashCommands } = await import('@/modules/chat/hooks/useSlashCommands');

const ACTIONS: ProviderModelActions = {
  create: async () => {},
  update: async () => {},
  remove: async () => {},
  setCustomModelsOnly: async () => {},
};

const CATALOG: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {
  claude: {
    OPTIONS: [
      { value: 'default', label: 'Default (recommended)', description: 'Use the recommended model for your Claude account and deployment.' },
      { value: 'sonnet', label: 'Sonnet 5.5', description: 'Latest Sonnet model for everyday coding tasks.' },
      { value: 'opus', label: 'Opus 5.5', description: 'A description this client has never seen.' },
    ],
    DEFAULT: 'default',
  },
};

/** The page's text, as a string: a failing assertion never inspects a DOM node. */
const pageText = () => document.body.textContent ?? '';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('the new conversation\'s ready line', () => {
  const renderEmptyState = (claudeModel: string) => render(
    <ProviderSelectionEmptyState
      selectedSession={null}
      currentSessionId={null}
      provider="claude"
      setProvider={() => {}}
      textareaRef={{ current: null }}
      providerModels={{ claude: claudeModel, codex: '', cursor: '', opencode: '', agy: '' }}
      setProviderModel={() => {}}
      providerModelCatalog={CATALOG}
      providerModelActions={ACTIONS}
      providerModelsLoading={false}
      tasksEnabled={false}
      isTaskMasterInstalled={null}
      setInput={() => {}}
    />,
  );

  it('names the model by its catalog name in Chinese', async () => {
    await i18n.changeLanguage('zh-CN');
    renderEmptyState('default');
    assert.equal(pageText().includes('Claude 已就绪，模型：默认（推荐）。在下方输入消息开始对话。'), true);
    assert.equal(pageText().includes('使用 default'), false);
  });

  it('names it in Hebrew', async () => {
    await i18n.changeLanguage('he');
    renderEmptyState('sonnet');
    assert.equal(pageText().includes('Claude מוכן לשימוש. המודל: \u2068Sonnet 5.5\u2069. אפשר להתחיל להקליד הודעה למטה.'), true);
  });

  it('names it in English, and a model the catalog does not list by its id', () => {
    const { unmount } = renderEmptyState('default');
    assert.equal(pageText().includes('Ready to use Claude with Default (recommended). Start typing your message below.'), true);
    unmount();
    renderEmptyState('claude-opus-4-5');
    assert.equal(pageText().includes('Ready to use Claude with claude-opus-4-5.'), true);
  });
});

describe('the /models modal', () => {
  const renderModels = () => render(
    <CommandResultModal
      payload={{ kind: 'models', data: { current: { provider: 'claude', model: 'default' } } }}
      onClose={() => {}}
      providerModelCatalog={CATALOG}
      providerModelActions={ACTIONS}
      activeProvider="claude"
      activeProviderModel="default"
      currentSessionId="session-1"
      onSelectProviderModel={async () => ({ scope: 'session', model: 'opus' })}
    />,
  );

  it('describes the built-in models it knows in Chinese, and any other as sent', async () => {
    await i18n.changeLanguage('zh-CN');
    renderModels();
    const text = pageText();
    assert.equal(text.includes('使用你的 Claude 账号和部署推荐的模型。'), true);
    assert.equal(text.includes('最新的 Sonnet 模型，适合日常编码。'), true);
    assert.equal(text.includes('A description this client has never seen.'), true);
    assert.equal(text.includes('Use the recommended model'), false);
  });

  it('reads as before in English', () => {
    renderModels();
    const text = pageText();
    assert.equal(text.includes('Use the recommended model for your Claude account and deployment.'), true);
    assert.equal(text.includes('Latest Sonnet model for everyday coding tasks.'), true);
  });
});

describe('the slash menu\'s filter', () => {
  const project: Project = { projectId: 'repo', displayName: 'repo', fullPath: '/home/u/repo' };

  beforeEach(() => {
    localStorage.clear();
    listCommands.mockReset();
    listSkills.mockReset();
    listCommands.mockResolvedValue({
      ok: true,
      json: async () => ({
        builtIn: [
          { name: '/help', description: 'Show help documentation for Claude Code', namespace: 'builtin' },
          { name: '/cost', description: 'Display token usage information', namespace: 'builtin' },
        ],
        custom: [{ name: '/deploy', description: 'Ship the build', namespace: 'project', path: '.claude/commands/deploy.md' }],
      }),
    });
    listSkills.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { skills: [] } }) });
  });

  const typeInto = async (typed: string) => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    const textareaRef = { current: textarea } as RefObject<HTMLTextAreaElement>;
    const { result } = renderHook(() => useSlashCommands({
      selectedProject: project,
      provider: 'claude',
      input: typed,
      setInput: () => {},
      textareaRef,
      onExecuteCommand: () => {},
    }));
    await waitFor(() => assert.equal(result.current.slashCommandsCount, 3));
    act(() => {
      result.current.handleCommandInputChange(typed, typed.length);
    });
    return result;
  };

  it('finds a built-in command by the Chinese description it shows', async () => {
    await i18n.changeLanguage('zh-CN');
    const result = await typeInto('/用量');
    await waitFor(() => assert.deepEqual(result.current.filteredCommands.map((command) => command.name), ['/cost']));
  });

  it('still finds a command by its English description', async () => {
    const result = await typeInto('/usage');
    await waitFor(() => assert.deepEqual(result.current.filteredCommands.map((command) => command.name), ['/cost']));
  });

  it('finds a project\'s command by its file\'s description in any language', async () => {
    await i18n.changeLanguage('zh-CN');
    const result = await typeInto('/build');
    await waitFor(() => assert.deepEqual(result.current.filteredCommands.map((command) => command.name), ['/deploy']));
  });
});

describe('the /models modal\'s search', () => {
  it('finds a built-in model by the Chinese description it shows', async () => {
    await i18n.changeLanguage('zh-CN');
    const many: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {
      claude: {
        ...CATALOG.claude!,
        OPTIONS: [
          ...CATALOG.claude!.OPTIONS,
          ...['a', 'b', 'c', 'd'].map((id) => ({ value: `model-${id}`, label: `Model ${id.toUpperCase()}` })),
        ],
      },
    };
    render(
      <CommandResultModal
        payload={{ kind: 'models', data: { current: { provider: 'claude', model: 'default' } } }}
        onClose={() => {}}
        providerModelCatalog={many}
        providerModelActions={ACTIONS}
        activeProvider="claude"
        activeProviderModel="default"
        currentSessionId="session-1"
        onSelectProviderModel={async () => ({ scope: 'session', model: 'opus' })}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('搜索 Claude 模型…'), { target: { value: '日常编码' } });
    const text = pageText();
    assert.equal(text.includes('Sonnet 5.5'), true);
    assert.equal(text.includes('Model A'), false);
  });
});
