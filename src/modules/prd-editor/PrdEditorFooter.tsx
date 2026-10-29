import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

type PrdEditorFooterProps = {
  content: string;
};

type ContentStats = {
  lines: number;
  characters: number;
  words: number;
};

function getContentStats(content: string): ContentStats {
  return {
    lines: content.split('\n').length,
    characters: content.length,
    words: content.split(/\s+/).filter(Boolean).length,
  };
}

/** Rendered by PrdEditorWorkspace inside the prd-editor module to show PRD line, character and word counts plus the shortcut hint. */
export default function PrdEditorFooter({ content }: PrdEditorFooterProps) {
  const { t } = useTranslation('tasks');
  const stats = useMemo(() => getContentStats(content), [content]);

  return (
    <div className="flex flex-shrink-0 items-center justify-between border-t border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-center gap-4 text-sm text-gray-600 dark:text-gray-400">
        <span>{t('prdEditor.footer.lines', { defaultValue: 'Lines: {{lines}}', lines: stats.lines })}</span>
        <span>{t('prdEditor.footer.characters', { defaultValue: 'Characters: {{characters}}', characters: stats.characters })}</span>
        <span>{t('prdEditor.footer.words', { defaultValue: 'Words: {{words}}', words: stats.words })}</span>
        <span>{t('prdEditor.footer.format', 'Format: Markdown')}</span>
      </div>

      <div className="text-sm text-gray-500 dark:text-gray-400">
        {t('prdEditor.footer.shortcuts', 'Press Ctrl+S to save and Esc to close')}
      </div>
    </div>
  );
}
