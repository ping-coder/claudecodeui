import assert from 'node:assert/strict';

import type { ComponentProps } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, it } from 'vitest';

import { i18n } from '@/modules/i18n';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';
import type { CommandModalPayload, ProviderModelActions, ProviderModelsDefinition } from '@/shared/types';

/**
 * The slash commands' result modal (/help, /models, /cost, /status) reads in
 * the interface language: its row names and notes, and the built-in commands'
 * descriptions and the catalog's worded model names the server sends in
 * English. The English interface reads as it always did.
 */

const ACTIONS: ProviderModelActions = {
  create: async () => {},
  update: async () => {},
  remove: async () => {},
  setCustomModelsOnly: async () => {},
};

const CATALOG: Partial<Record<'claude', ProviderModelsDefinition>> = {
  claude: {
    OPTIONS: [
      { value: 'default', label: 'Default (recommended)', description: 'Use the recommended model for your Claude account and deployment.' },
      { value: 'opus', label: 'Opus 5.5' },
      { value: 'my-model', label: 'My Model', recordId: 1, isCustom: true },
    ],
    DEFAULT: 'default',
    EFFORT_LEVELS: [],
  },
};

type SelectModel = ComponentProps<typeof CommandResultModal>['onSelectProviderModel'];

const renderModal = (payload: CommandModalPayload, onSelectProviderModel: SelectModel = async () => ({ scope: 'session', model: 'opus' })) =>
  render(
    <CommandResultModal
      payload={payload}
      onClose={() => {}}
      providerModelCatalog={CATALOG}
      providerModelActions={ACTIONS}
      activeProvider="claude"
      activeProviderModel="default"
      currentSessionId="session-1"
      onSelectProviderModel={onSelectProviderModel}
    />,
  );

/** The open dialog's text, read as a string so a failing assertion never inspects a DOM node. */
const dialogText = () => document.body.textContent ?? '';

const COST: CommandModalPayload = {
  kind: 'cost',
  data: {
    tokenUsage: { used: 1500, total: 160000 },
    tokenBreakdown: { input: 1200, output: 300 },
    provider: 'claude',
    model: 'claude-opus-4-5',
  },
};

const STATUS: CommandModalPayload = {
  kind: 'status',
  data: {
    version: '1.37.5',
    packageName: 'claude-code-ui',
    uptime: '2h 5m',
    provider: 'claude',
    model: 'opus',
    nodeVersion: 'v22.1.0',
    platform: 'linux',
    pid: 4242,
    memoryUsage: { rssMb: 512 },
  },
};

const HELP: CommandModalPayload = {
  kind: 'help',
  data: {
    commands: [
      { name: '/help', description: 'Show help documentation for Claude Code', namespace: 'builtin' },
      { name: '/deploy', description: 'Ship the build', namespace: 'project' },
    ],
  },
};

const MODELS: CommandModalPayload = { kind: 'models', data: { current: { provider: 'claude', model: 'default' } } };

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('the token usage modal', () => {
  it('names its rows, the provider and the model in Chinese', async () => {
    await i18n.changeLanguage('zh-CN');
    renderModal(COST);
    const text = dialogText();
    for (const label of ['已用 Token 总数', '输入 Token', '输出 Token', '上下文窗口', '提供商', '模型']) {
      assert.equal(text.includes(label), true, label);
    }
    for (const english of ['Total tokens used', 'Input tokens', 'Output tokens', 'Context window', 'Provider']) {
      assert.equal(text.includes(english), false, english);
    }
  });

  it('says the breakdown is unavailable, and the model unknown, in Chinese', async () => {
    await i18n.changeLanguage('zh-CN');
    renderModal({ kind: 'cost', data: { tokenUsage: { used: 10, total: 0 } } });
    const text = dialogText();
    assert.equal(text.includes('明细'), true);
    assert.equal(text.includes('暂无'), true);
    assert.equal(text.includes('未知'), true);
    assert.equal(text.includes('Unknown'), false);
  });

  it('reads as before in English', () => {
    renderModal(COST);
    const text = dialogText();
    for (const label of ['Total tokens used', 'Input tokens', 'Output tokens', 'Context window', 'Provider', 'Model', 'claude-opus-4-5']) {
      assert.equal(text.includes(label), true, label);
    }
  });
});

describe('the system status modal', () => {
  it('names its rows and says how the process is doing in Chinese, with the uptime worded', async () => {
    await i18n.changeLanguage('zh-CN');
    renderModal(STATUS);
    const text = dialogText();
    for (const label of ['包名', '版本', '运行时长', '2 小时 5 分钟', '平台', '内存', '512 MB RSS', '服务在线', '进程 #4242 正常响应。', '正常', 'Node.js']) {
      assert.equal(text.includes(label), true, label);
    }
    assert.equal(text.includes('Runtime online'), false);
    assert.equal(text.includes('2h 5m'), false);
  });

  it('keeps an uptime it cannot read as the server words it', async () => {
    await i18n.changeLanguage('zh-CN');
    renderModal({ kind: 'status', data: { ...STATUS.data, uptime: '3 days' } });
    assert.equal(dialogText().includes('3 days'), true);
  });

  it('keeps the memory and the process number in their own order in Hebrew', async () => {
    await i18n.changeLanguage('he');
    renderModal(STATUS);
    const text = dialogText();
    assert.equal(text.includes('\u2066512 MB RSS\u2069'), true);
    assert.equal(text.includes('\u2066#4242\u2069'), true);
  });

  it('reads as before in English', () => {
    renderModal(STATUS);
    const text = dialogText();
    for (const label of ['Package', 'Uptime', '2h 5m', '512 MB RSS', 'Runtime online', 'Process #4242 is responding.', 'Healthy']) {
      assert.equal(text.includes(label), true, label);
    }
  });
});

describe('the help modal', () => {
  it('describes the built-in commands, their badge, the syntax and the tip in Chinese', async () => {
    await i18n.changeLanguage('zh-CN');
    renderModal(HELP);
    const text = dialogText();
    for (const label of ['查看 Claude Code 的帮助文档', '内置', '语法', '$ARGUMENTS 传入全部参数。', '$1、$2 按位置传入参数。', '@file 插入文件内容。', '小提示', '打开命令菜单']) {
      assert.equal(text.includes(label), true, label);
    }
    // A project's command reads as its file has it.
    assert.equal(text.includes('Ship the build'), true);
    assert.equal(text.includes('Show help documentation for Claude Code'), false);
  });

  it('finds a built-in command by its Chinese description', async () => {
    await i18n.changeLanguage('zh-CN');
    renderModal(HELP);
    fireEvent.change(screen.getByPlaceholderText('筛选命令…'), { target: { value: '帮助文档' } });
    const text = dialogText();
    assert.equal(text.includes('/help'), true);
    assert.equal(text.includes('/deploy'), false);

    fireEvent.change(screen.getByPlaceholderText('筛选命令…'), { target: { value: 'nothing-like-this' } });
    assert.equal(dialogText().includes('没有符合筛选条件的命令。'), true);
  });

  it('reads as before in English', () => {
    renderModal(HELP);
    const text = dialogText();
    for (const label of ['Show help documentation for Claude Code', 'builtin', 'Syntax', '$ARGUMENTS passes all args.', '$1, $2 pass positional args.', '@file includes file contents.', 'Quick tip', 'Type / in the composer to open the command palette']) {
      assert.equal(text.includes(label), true, label);
    }
  });
});

describe('the model picker modal', () => {
  it('names the active model, the catalog\'s worded names and its controls in Chinese', async () => {
    await i18n.changeLanguage('zh-CN');
    renderModal(MODELS);
    const text = dialogText();
    for (const label of ['当前模型 · Claude', '默认（推荐）', 'Opus 5.5', 'My Model', '自定义', '当前选择', '管理模型']) {
      assert.equal(text.includes(label), true, label);
    }
    assert.equal(text.includes('Default (recommended)'), false);
    assert.equal(screen.queryByRole('button', { name: '选择模型 opus' }) !== null, true);
  });

  it('says in Chinese which model the session now uses', async () => {
    await i18n.changeLanguage('zh-CN');
    renderModal(MODELS);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '选择模型 opus' }));
    });
    const text = dialogText();
    assert.equal(text.includes('这个会话现在使用 opus。'), true);
    assert.equal(text.includes('下一轮改用 opus'), true);
  });

  it('says in Chinese which model became the default', async () => {
    await i18n.changeLanguage('zh-CN');
    renderModal(MODELS, async () => ({ scope: 'default', model: 'opus' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '选择模型 opus' }));
    });
    assert.equal(dialogText().includes('Claude 的默认模型已设为 opus。'), true);
  });

  it('opens the model library in Chinese', async () => {
    await i18n.changeLanguage('zh-CN');
    renderModal(MODELS);
    fireEvent.click(screen.getByRole('button', { name: /管理模型/ }));
    assert.equal(dialogText().includes('模型库'), true);
  });

  it('reads as before in English', () => {
    renderModal(MODELS);
    const text = dialogText();
    for (const label of ['Active model · Claude', 'Default (recommended)', 'Custom', 'Current selection', 'Manage models']) {
      assert.equal(text.includes(label), true, label);
    }
    assert.equal(screen.queryByRole('button', { name: 'Select model opus' }) !== null, true);
  });
});
