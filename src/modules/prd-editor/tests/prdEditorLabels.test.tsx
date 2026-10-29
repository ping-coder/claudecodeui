import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * Every word the PRD editor shows comes from the tasks locale: the header, the footer, the loading
 * state, both dialogs and the messages a failed load or save shows. The word-wrap button shows the
 * code editor's wrap glyph, not the word "WRAP".
 */

vi.mock('@uiw/react-codemirror', () => ({
  default: function CodeMirrorStub({ value, onChange }: { value: string; onChange?: (value: string) => void }) {
    return <textarea data-testid="prd-body" value={value} onChange={(event) => onChange?.(event.target.value)} />;
  },
}));

const readFile = vi.fn();
const prdFiles = vi.fn();
const savePrd = vi.fn();
vi.mock('@/shared/api', () => ({ api: { readFile, taskmaster: { prdFiles, savePrd } } }));

const { i18n } = await import('@/modules/i18n');
const { default: PRDEditor } = await import('@/modules/prd-editor/PRDEditor');
const { default: PrdEditorLoadingState } = await import('@/modules/prd-editor/PrdEditorLoadingState');
const { default: GenerateTasksModal } = await import('@/modules/prd-editor/modals/GenerateTasksModal');
const { default: OverwriteConfirmModal } = await import('@/modules/prd-editor/modals/OverwriteConfirmModal');

const project = { projectId: 'p1' } as Project;
const alertSpy = vi.fn();

beforeEach(() => {
  readFile.mockReset();
  prdFiles.mockReset();
  savePrd.mockReset();
  prdFiles.mockResolvedValue({ ok: true, json: async () => ({ prdFiles: [] }) });
  alertSpy.mockReset();
  vi.stubGlobal('alert', alertSpy);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage('en');
});

// What stays as it is in every language: names, keys, a format, the docs folder, the file's own name.
const KEPT = /Claude Code|TaskMaster|PRD|Markdown|Ctrl\+S|Esc|\.taskmaster\/docs\/|prd-2026\.txt|\.txt/g;
const ISOLATES = /[\u2066-\u2069]/g;

/** The Latin words left in what the user can read: text outside the editor body, titles, placeholders, labels. */
function englishLeft(root: HTMLElement): string[] {
  const shown: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest('textarea')) shown.push(node.textContent ?? '');
  }
  for (const element of root.querySelectorAll('[title], [placeholder], [aria-label]')) {
    shown.push(...['title', 'placeholder', 'aria-label'].map((name) => element.getAttribute(name) ?? ''));
  }
  return shown.join(' ').replace(ISOLATES, '').replace(KEPT, ' ').match(/[A-Za-z]{2,}/g) ?? [];
}

const renderNewPrd = async (props: { project?: Project | null; initialContent?: string } = {}) => {
  const view = render(
    <PRDEditor
      onClose={() => undefined}
      isNewFile
      project={props.project ?? null}
      initialContent={props.initialContent ?? '# PRD\nGoals here'}
    />,
  );
  await screen.findByTestId('prd-body');
  return view;
};

const titles = (root: HTMLElement) => [...root.querySelectorAll('[title]')].map((element) => element.getAttribute('title'));

test('in English the editor reads as before, with the counts in the footer', async () => {
  const { container } = await renderNewPrd();
  assert.equal(screen.queryByPlaceholderText('Enter PRD filename') !== null, true);
  assert.deepEqual(titles(container), [
    'Focus filename input',
    'Preview markdown',
    'Disable word wrap',
    'Toggle theme',
    'Download PRD',
    'Generate tasks from PRD content',
    'Fullscreen',
    'Close',
  ]);
  for (const text of ['New', 'Product Requirements Document', 'Generate Tasks', 'Save PRD', 'Lines: 2', 'Characters: 16', 'Words: 4', 'Format: Markdown', 'Press Ctrl+S to save and Esc to close']) {
    assert.equal(screen.queryByText(text) !== null, true, text);
  }
});

test('in Simplified Chinese no English word is left in the header or the footer', async () => {
  await i18n.changeLanguage('zh-CN');
  const { container } = await renderNewPrd();

  assert.equal(screen.queryByPlaceholderText('输入 PRD 文件名') !== null, true);
  assert.deepEqual(titles(container), ['编辑文件名', '预览 Markdown', '关闭自动换行', '切换主题', '下载 PRD', '根据 PRD 内容生成任务', '全屏', '关闭']);
  for (const text of ['新建', '产品需求文档', '生成任务', '保存 PRD', '行数：2', '字符数：16', '词数：4', '格式：Markdown', '按 Ctrl+S 保存，按 Esc 关闭']) {
    assert.equal(screen.queryByText(text) !== null, true, text);
  }
  assert.deepEqual(englishLeft(container), []);
  // The wrap toggle is a glyph now, not the word.
  assert.equal(screen.queryByText('WRAP') === null, true);

  fireEvent.click(screen.getByTitle('预览 Markdown'));
  fireEvent.click(screen.getByTitle('关闭自动换行'));
  assert.equal(screen.queryByTitle('切换到编辑模式') !== null, true);
  assert.equal(screen.queryByTitle('开启自动换行') !== null, true);
});

test('in Hebrew the header and the footer come from the Hebrew locale', async () => {
  await i18n.changeLanguage('he');
  const hebrew = i18n.getFixedT('he', 'tasks');
  const { container } = await renderNewPrd();

  assert.equal(screen.queryByPlaceholderText(hebrew('prdEditor.fileNamePlaceholder')) !== null, true);
  assert.equal(screen.queryByTitle(hebrew('prdEditor.generateTasksHint')) !== null, true);
  assert.equal(screen.queryByText(hebrew('prdEditor.footer.lines', { lines: 2 })) !== null, true);
  assert.equal(screen.queryByText(hebrew('prdEditor.footer.shortcuts')) !== null, true);
  assert.deepEqual(englishLeft(container), []);
});

test('the loading state says so in the UI language', async () => {
  await i18n.changeLanguage('zh-CN');
  const { container } = render(<PrdEditorLoadingState dialogRef={createRef<HTMLDivElement>()} />);
  assert.equal(container.textContent, '正在加载 PRD…');
});

test('the generate-tasks dialog and its example prompt are translated, the path kept as typed', async () => {
  await i18n.changeLanguage('zh-CN');
  const zh = render(<GenerateTasksModal isOpen fileName="prd-2026.txt" onClose={() => undefined} />);
  assert.equal(screen.queryByText('从 PRD 生成任务') !== null, true);
  assert.equal(screen.queryByText('我的 PRD 在 .taskmaster/docs/prd-2026.txt，解析它并创建初始任务。') !== null, true);
  assert.equal(screen.queryByLabelText('关闭') !== null, true);
  assert.equal(screen.queryByText('知道了') !== null, true);
  assert.deepEqual(englishLeft(zh.container), []);
  zh.unmount();

  await i18n.changeLanguage('he');
  const hebrew = i18n.getFixedT('he', 'tasks');
  const he = render(<GenerateTasksModal isOpen fileName="prd-2026.txt" onClose={() => undefined} />);
  const prompt = hebrew('prdEditor.generateTasksModal.prompt', { fileName: 'prd-2026.txt' });
  assert.equal(screen.queryByText(prompt) !== null, true);
  // The path sits in a left-to-right isolate, so its dots and slashes stay where they are typed.
  assert.equal(prompt.includes('\u2066.taskmaster/docs/'), true);
  assert.deepEqual(englishLeft(he.container), []);
});

test('the overwrite dialog names the file and its buttons in the UI language', async () => {
  await i18n.changeLanguage('zh-CN');
  const view = render(<OverwriteConfirmModal isOpen fileName="prd-2026.txt" saving={false} onCancel={() => undefined} onConfirm={() => undefined} />);
  for (const text of ['文件已存在', '已有名为「prd-2026.txt」的 PRD，要覆盖吗？', '取消', '覆盖']) {
    assert.equal(screen.queryByText(text) !== null, true, text);
  }
  assert.deepEqual(englishLeft(view.container), []);

  view.rerender(<OverwriteConfirmModal isOpen fileName="prd-2026.txt" saving onCancel={() => undefined} onConfirm={() => undefined} />);
  assert.equal(screen.queryByText('正在保存…') !== null, true);
});

const clickSave = async (label: string) => {
  await act(async () => {
    fireEvent.click(screen.getByText(label));
  });
};

test('a save that cannot start says why in the UI language', async () => {
  await i18n.changeLanguage('zh-CN');
  await renderNewPrd();
  await clickSave('保存 PRD');
  assert.equal(alertSpy.mock.calls.at(-1)?.[0], '没有选中项目，重新打开编辑器再试。');

  fireEvent.change(screen.getByTestId('prd-body'), { target: { value: '   ' } });
  await clickSave('保存 PRD');
  assert.equal(alertSpy.mock.calls.at(-1)?.[0], '先写点内容再保存。');

  fireEvent.change(screen.getByTestId('prd-body'), { target: { value: '# PRD' } });
  fireEvent.change(screen.getByPlaceholderText('输入 PRD 文件名'), { target: { value: '' } });
  await clickSave('保存 PRD');
  assert.equal(alertSpy.mock.calls.at(-1)?.[0], '先填写 PRD 的文件名。');
  assert.equal(savePrd.mock.calls.length, 0);
});

test('a failed save words the status or the error in the UI language and keeps the server\'s own message', async () => {
  await i18n.changeLanguage('zh-CN');
  await renderNewPrd({ project });
  await waitFor(() => assert.equal(prdFiles.mock.calls.length > 0, true));

  savePrd.mockResolvedValueOnce({ ok: false, status: 500, json: async () => { throw new SyntaxError('not JSON'); } });
  await clickSave('保存 PRD');
  assert.equal(alertSpy.mock.calls.at(-1)?.[0], '保存失败：500');

  savePrd.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ message: 'Invalid file name' }) });
  await clickSave('保存 PRD');
  assert.equal(alertSpy.mock.calls.at(-1)?.[0], 'Invalid file name');

  savePrd.mockRejectedValueOnce(new Error('network down'));
  await clickSave('保存 PRD');
  assert.equal(alertSpy.mock.calls.at(-1)?.[0], '保存 PRD 出错：network down');
});

test('a PRD that cannot be read shows the status inside a translated banner', async () => {
  readFile.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
  const file = { name: 'prd.txt', path: '.taskmaster/docs/prd.txt', projectId: 'p1' };

  const english = render(<PRDEditor file={file} onClose={() => undefined} project={project} />);
  await screen.findByTestId('prd-body');
  assert.equal(screen.queryByText('Unable to load file content: 404 Not Found') !== null, true);
  english.unmount();

  await i18n.changeLanguage('zh-CN');
  render(<PRDEditor file={file} onClose={() => undefined} project={project} />);
  await screen.findByTestId('prd-body');
  assert.equal(screen.queryByText('无法加载文件内容：404 Not Found') !== null, true);
});
