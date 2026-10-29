import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { afterEach, test } from 'vitest';

import { i18n } from '@/modules/i18n';
import PrdEditorHeader from '@/modules/prd-editor/PrdEditorHeader';

/** The PRD editor's full-screen button is named in the UI language, from the tasks locale. */

afterEach(async () => {
  await i18n.changeLanguage('en');
});

const renderHeader = (isFullscreen: boolean) =>
  render(
    <PrdEditorHeader
      fileName="prd"
      onFileNameChange={() => {}}
      isNewFile={false}
      previewMode={false}
      onTogglePreview={() => {}}
      wordWrap={false}
      onToggleWordWrap={() => {}}
      isDarkMode={false}
      onToggleTheme={() => {}}
      onDownload={() => {}}
      onOpenGenerateTasks={() => {}}
      canGenerateTasks
      onSave={() => {}}
      saving={false}
      saveSuccess={false}
      isFullscreen={isFullscreen}
      onToggleFullscreen={() => {}}
      onClose={() => {}}
    />,
  );

test('the full-screen button says what a click does', () => {
  const { unmount } = renderHeader(false);
  assert.equal(screen.queryByTitle('Fullscreen') !== null, true);
  unmount();

  renderHeader(true);
  assert.equal(screen.queryByTitle('Exit fullscreen') !== null, true);
});

test('in Hebrew the button is named from the Hebrew locale', async () => {
  await i18n.changeLanguage('he');
  const hebrew = i18n.getFixedT('he', 'tasks');
  const { unmount } = renderHeader(false);
  assert.equal(screen.queryByTitle(hebrew('prdEditor.fullscreen')) !== null, true);
  // A Hebrew word, or the English one set apart as a fallback: either way not the bare English.
  assert.equal(screen.queryByTitle('Fullscreen') === null, true);
  unmount();

  renderHeader(true);
  assert.equal(screen.queryByTitle(hebrew('prdEditor.exitFullscreen')) !== null, true);
});
