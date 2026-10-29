import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, it } from 'vitest';

import { i18n } from '@/modules/i18n';
import ModelLibraryPanel from '@/modules/chat/modals/ModelLibraryPanel';
import type { LLMProvider, ProviderModelActions, ProviderModelsDefinition } from '@/shared/types';

/**
 * The model library reads in the interface language: its title, the form's
 * labels, placeholders, hint and checks, the lists and the delete question,
 * and what it says after a save. Effort levels and the catalog's worded model
 * names are translated too; the names users give their models are not.
 */

const CATALOG: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {
  claude: {
    OPTIONS: [
      { value: 'default', label: 'Default (recommended)' },
      { value: 'opus', label: 'Opus 5.5' },
      {
        value: 'my-model',
        label: 'My Model',
        recordId: 7,
        isCustom: true,
        effort: { values: [{ value: 'low' }, { value: 'xhigh' }] },
      },
    ],
    DEFAULT: 'default',
    EFFORT_LEVELS: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
};

const ACTIONS: ProviderModelActions = {
  create: async () => {},
  update: async () => {},
  remove: async () => {},
  setCustomModelsOnly: async () => {},
};

const renderPanel = () => render(
  <ModelLibraryPanel initialProvider="claude" providerModelCatalog={CATALOG} actions={ACTIONS} onDone={() => {}} />,
);

/** The panel's text as a string, so a failing assertion never inspects a DOM node. */
const panelText = () => document.body.textContent ?? '';
const inputPlaceholder = (id: string) => (document.getElementById(id) as HTMLInputElement).placeholder;

const fillForm = (name: string, id: string) => {
  fireEvent.change(document.getElementById('custom-model-name') as HTMLInputElement, { target: { value: name } });
  fireEvent.change(document.getElementById('custom-model-id') as HTMLInputElement, { target: { value: id } });
};

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('the model library in Chinese', () => {
  it('names its parts, the form and the lists', async () => {
    await i18n.changeLanguage('zh-CN');
    renderPanel();
    const text = panelText();
    for (const label of [
      '模型库', '添加提供商支持的模型 ID。内置模型不能改动。', '返回模型列表', '添加自定义模型', 'ID 会原样发给 Claude。',
      '模型名称', '模型 ID', '填写提供商 CLI 接受的准确标识符，ID 不能包含空格。', '我的模型', '可以编辑，保存在 auth.db 里',
      '自定义', '内置模型', '由 CloudCLI 维护，只读',
    ]) {
      assert.equal(text.includes(label), true, label);
    }
    assert.equal(inputPlaceholder('custom-model-name'), '例如 GPT-5.5 Pro');
    assert.equal(inputPlaceholder('custom-model-id'), '例如 gpt-5.5-pro');
    for (const english of ['Model library', 'Your models', 'Built-in models', 'Back to models']) {
      assert.equal(text.includes(english), false, english);
    }
  });

  it('shows the catalog\'s worded names and the effort levels in Chinese, and user-named models as named', async () => {
    await i18n.changeLanguage('zh-CN');
    renderPanel();
    const text = panelText();
    assert.equal(text.includes('默认（推荐）'), true);
    assert.equal(text.includes('Default (recommended)'), false);
    assert.equal(text.includes('My Model'), true);
    assert.equal(text.includes('推理：低 · 超高'), true);
    for (const level of ['低', '中', '高', '超高', '最高']) {
      assert.equal(screen.queryByRole('button', { name: level }) !== null, true, level);
    }
  });

  it('asks before deleting, and names the edit and delete buttons by the model', async () => {
    await i18n.changeLanguage('zh-CN');
    renderPanel();
    assert.equal(screen.queryByRole('button', { name: '编辑 My Model' }) !== null, true);
    fireEvent.click(screen.getByRole('button', { name: '删除 My Model' }));
    const text = panelText();
    assert.equal(text.includes('从所有模型选择器里删除这个模型？'), true);
    assert.equal(screen.queryByRole('button', { name: '取消' }) !== null, true);
    assert.equal(screen.queryByRole('button', { name: '删除' }) !== null, true);
  });

  it('says what a save did, and why an ID was refused', async () => {
    await i18n.changeLanguage('zh-CN');
    renderPanel();
    fillForm('New Model', 'new model');
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    assert.equal(panelText().includes('模型 ID 不能包含空格。'), true);

    fillForm('New Model', 'new-model');
    await act(async () => {
      fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    });
    assert.equal(panelText().includes('已添加 New Model。'), true);

    fireEvent.click(screen.getByRole('button', { name: '删除 My Model' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '删除' }));
    });
    assert.equal(panelText().includes('已删除 My Model。'), true);
  });

  it('says it is editing, and that the edit was saved', async () => {
    await i18n.changeLanguage('zh-CN');
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '编辑 My Model' }));
    assert.equal(panelText().includes('编辑自定义模型'), true);
    await act(async () => {
      fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    });
    assert.equal(panelText().includes('已更新 My Model。'), true);
  });
});

describe('the model library in English', () => {
  it('reads as before', async () => {
    renderPanel();
    const text = panelText();
    for (const label of [
      'Model library', 'Add model IDs supported by your provider. Built-in models stay locked.', 'Back to models', 'Add a custom model',
      'The ID is sent to Claude exactly as written.', 'Model name', 'Model ID', 'Your models', 'Editable and stored in auth.db', 'Custom',
      'Built-in models', 'Maintained by CloudCLI and read-only', 'Default (recommended)', 'Reasoning: low · xhigh',
    ]) {
      assert.equal(text.includes(label), true, label);
    }
    assert.equal(inputPlaceholder('custom-model-name'), 'e.g. GPT-5.5 Pro');
    fillForm('New Model', 'new-model');
    await act(async () => {
      fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    });
    assert.equal(panelText().includes('New Model was added.'), true);
  });
});
