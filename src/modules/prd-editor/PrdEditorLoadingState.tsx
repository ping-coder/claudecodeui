import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';

type PrdEditorLoadingStateProps = {
  // The editor's dialog element while it loads, read by PRDEditor's Escape (see usePrdKeyboardShortcuts).
  dialogRef: RefObject<HTMLDivElement>;
};

/** Rendered by PRDEditor inside the prd-editor module while an existing PRD's contents are still loading. */
export default function PrdEditorLoadingState({ dialogRef }: PrdEditorLoadingStateProps) {
  const { t } = useTranslation('tasks');

  return (
    <div className="fixed inset-0 z-[200] md:flex md:items-center md:justify-center md:bg-black/50">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('prdEditor.documentType', 'Product Requirements Document')}
        className="flex h-full w-full items-center justify-center bg-white p-8 dark:bg-gray-900 md:h-auto md:w-auto md:rounded-lg"
      >
        <div className="flex items-center gap-3">
          <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-blue-600" />
          <span className="text-gray-900 dark:text-white">{t('prdEditor.loading', 'Loading PRD...')}</span>
        </div>
      </div>
    </div>
  );
}
