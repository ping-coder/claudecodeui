import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import CommandMenu from '@/modules/chat/composer/CommandMenu';
import ProviderSelectionEmptyState from '@/modules/chat/transcript/ProviderSelectionEmptyState';
import type { LLMProvider, ProviderModelActions, ProviderModelOption, ProviderModelsDefinition } from '@/shared/types';

/**
 * The composer's menus read what the server sends in English in the interface
 * language where this client knows it: the effort levels and the catalog's
 * worded model names in the model menu and the model picker, the built-in
 * slash commands' descriptions and badge in the command menu, and the menus'
 * own headings. What it does not know shows as sent.
 */

// The picker's task banner pulls in the terminal stack; these tests never show it.
vi.mock('@/modules/task-master', () => ({ NextTaskBanner: () => null }));

type EffortOption = NonNullable<ProviderModelOption['effort']>['values'][number];

const EFFORT_OPTIONS: EffortOption[] = ['low', 'medium', 'high', 'xhigh', 'max', 'turbo'].map((value) => ({ value }));

const MODEL_OPTIONS: ProviderModelOption[] = [
  { value: 'default', label: 'Default (recommended)' },
  { value: 'sonnet[1m]', label: 'Sonnet 5.5 (1M context)' },
  { value: 'gateway-auto', label: 'Auto', recordId: 3, isCustom: true },
];

const renderModelMenu = () => render(
  <ComposerModelMenu
    effort="xhigh"
    effortOptions={EFFORT_OPTIONS}
    onSelectEffort={() => {}}
    model="default"
    modelOptions={MODEL_OPTIONS}
    onSelectModel={() => {}}
    modelsLoading={false}
    ultracode={null}
    onToggleUltracode={() => {}}
  />,
);

/** The menu's item names, as strings: a failing assertion never inspects a DOM node. */
const menuItemNames = () => screen.queryAllByRole('menuitemradio').concat(screen.queryAllByRole('menuitem'))
  .map((item) => item.textContent ?? '');

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('the model menu', () => {
  it('names the effort levels and the catalog\'s worded models in Chinese, the rest as sent', async () => {
    await i18n.changeLanguage('zh-CN');
    renderModelMenu();
    const trigger = screen.getByRole('button', { name: /选择模型和推理级别/ });
    assert.equal(trigger.textContent?.includes('默认（推荐）'), true);
    assert.equal(trigger.textContent?.includes('超高'), true);

    fireEvent.click(trigger);
    const levels = menuItemNames();
    for (const level of ['默认', '低', '中', '高', '超高', '最高', 'turbo']) {
      assert.equal(levels.some((name) => name.startsWith(level)), true, level);
    }
    assert.equal(levels.some((name) => /^(Low|low|Xhigh|xhigh)/.test(name)), false);

    fireEvent.click(screen.getByRole('menuitem', { name: /默认（推荐）/ }));
    const models = menuItemNames();
    assert.equal(models.some((name) => name.startsWith('Sonnet 5.5（1M 上下文）')), true);
    // A custom model keeps the name the user gave it.
    assert.equal(models.some((name) => name.startsWith('Auto')), true);
  });

  it('reads as before in English', () => {
    renderModelMenu();
    const trigger = screen.getByRole('button', { name: /Select model and reasoning effort/ });
    assert.equal(trigger.textContent?.includes('Default (recommended)'), true);
    assert.equal(trigger.textContent?.includes('xhigh'), true);
    fireEvent.click(trigger);
    const levels = menuItemNames();
    for (const level of ['Default', 'low', 'medium', 'high', 'xhigh', 'max', 'turbo']) {
      assert.equal(levels.some((name) => name.startsWith(level)), true, level);
    }
  });
});

const COMMANDS = [
  { name: '/help', description: 'Show help documentation for Claude Code', namespace: 'builtin', metadata: { type: 'builtin' } },
  { name: '/cost', description: 'Display token usage information', namespace: 'builtin', metadata: { type: 'builtin' } },
  { name: '/deploy', description: 'Ship the build', namespace: 'project', metadata: { type: 'release' } },
];

const renderCommandMenu = (commands = COMMANDS) => render(
  <CommandMenu commands={commands} isOpen onClose={() => {}} position={{ top: 0, left: 0, bottom: 90 }} />,
);

describe('the slash command menu', () => {
  it('describes the built-in commands, their badge and the groups in Chinese, a project\'s command as its file has it', async () => {
    await i18n.changeLanguage('zh-CN');
    renderCommandMenu();
    const text = screen.getByRole('listbox').textContent ?? '';
    for (const label of ['内置命令', '项目命令', '查看 Claude Code 的帮助文档', '查看 Token 用量', '内置', 'Ship the build', 'release']) {
      assert.equal(text.includes(label), true, label);
    }
    assert.equal(text.includes('Built-in Commands'), false);
    assert.equal(text.includes('Show help documentation'), false);
  });

  it('says there are no commands in Chinese', async () => {
    await i18n.changeLanguage('zh-CN');
    renderCommandMenu([]);
    assert.equal(document.body.textContent?.includes('没有可用的命令'), true);
  });

  it('reads as before in English', () => {
    renderCommandMenu();
    const text = screen.getByRole('listbox').textContent ?? '';
    for (const label of ['Built-in Commands', 'Project Commands', 'Show help documentation for Claude Code', 'builtin']) {
      assert.equal(text.includes(label), true, label);
    }
  });
});

const ACTIONS: ProviderModelActions = {
  create: async () => {},
  update: async () => {},
  remove: async () => {},
  setCustomModelsOnly: async () => {},
};

const PICKER_CATALOG: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {
  claude: {
    OPTIONS: [
      { value: 'default', label: 'Default (recommended)' },
      { value: 'my-model', label: 'My Model', recordId: 1, isCustom: true },
    ],
    DEFAULT: 'default',
  },
  codex: { OPTIONS: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }], DEFAULT: 'gpt-5.6-sol' },
};

const renderPicker = () => render(
  <ProviderSelectionEmptyState
    selectedSession={null}
    currentSessionId={null}
    provider="claude"
    setProvider={() => {}}
    textareaRef={{ current: null }}
    providerModels={{ claude: 'default', codex: 'gpt-5.6-sol', cursor: 'auto', opencode: '', agy: '' }}
    setProviderModel={() => {}}
    providerModelCatalog={PICKER_CATALOG}
    providerModelActions={ACTIONS}
    providerModelsLoading={false}
    tasksEnabled={false}
    isTaskMasterInstalled={null}
    setInput={() => {}}
  />,
);

describe('the new conversation\'s model picker', () => {
  const scrollIntoView = Element.prototype.scrollIntoView;

  beforeEach(() => {
    localStorage.clear();
    // The Codex branch starts folded, which its row says.
    localStorage.setItem('model-groups-collapsed', JSON.stringify(['codex']));
    // jsdom ships no ResizeObserver or scrollIntoView, which the picker's cmdk list uses.
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    Element.prototype.scrollIntoView = () => undefined;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Element.prototype.scrollIntoView = scrollIntoView;
    localStorage.clear();
  });

  it('names the current model, the catalog\'s worded models, custom models and a folded branch in Chinese', async () => {
    await i18n.changeLanguage('zh-CN');
    renderPicker();
    const card = screen.getByRole('button', { name: /点击更换模型/ });
    assert.equal(card.textContent?.includes('默认（推荐）'), true);

    fireEvent.click(card);
    const dialog = screen.getByRole('dialog').textContent ?? '';
    for (const label of ['默认（推荐）', 'My Model', '自定义', '已隐藏 1 个，点击显示']) {
      assert.equal(dialog.includes(label), true, label);
    }
    assert.equal(dialog.includes('Default (recommended)'), false);
    assert.equal(dialog.includes('hidden — click to show'), false);
  });

  it('reads as before in English', () => {
    renderPicker();
    const card = screen.getByRole('button', { name: /Click to change model/ });
    assert.equal(card.textContent?.includes('Default (recommended)'), true);
    fireEvent.click(card);
    const dialog = screen.getByRole('dialog').textContent ?? '';
    for (const label of ['Default (recommended)', 'Custom', '1 hidden — click to show']) {
      assert.equal(dialog.includes(label), true, label);
    }
  });
});
