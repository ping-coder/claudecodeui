import { useState } from 'react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';
import { ensurePrdExtension } from '@/modules/prd-editor/utils/fileName';
import GenerateTasksModal from '@/modules/prd-editor/modals/GenerateTasksModal';
import PrdEditorBody from '@/modules/prd-editor/PrdEditorBody';
import PrdEditorFooter from '@/modules/prd-editor/PrdEditorFooter';
import PrdEditorHeader from '@/modules/prd-editor/PrdEditorHeader';

type PrdEditorWorkspaceProps = {
  // The editor's dialog element, read by PRDEditor's Escape (see usePrdKeyboardShortcuts).
  dialogRef: RefObject<HTMLDivElement>;
  content: string;
  onContentChange: (nextContent: string) => void;
  fileName: string;
  onFileNameChange: (nextFileName: string) => void;
  isNewFile: boolean;
  saving: boolean;
  saveSuccess: boolean;
  onSave: () => void;
  onDownload: () => void;
  onClose: () => void;
  // The full screen, held by PRDEditor so its Escape can leave it first.
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  // Why the PRD could not be read (the HTTP status, the error); the banner here says the rest.
  loadError: string | null;
};

/** Rendered by PRDEditor inside the prd-editor module to lay out the PRD header, editing body and footer once the document has loaded. */
export default function PrdEditorWorkspace({
  dialogRef,
  content,
  onContentChange,
  fileName,
  onFileNameChange,
  isNewFile,
  saving,
  saveSuccess,
  onSave,
  onDownload,
  onClose,
  isFullscreen,
  onToggleFullscreen,
  loadError,
}: PrdEditorWorkspaceProps) {
  const { t } = useTranslation('tasks');
  const [isDarkMode, setIsDarkMode] = useState<boolean>(true);
  const [previewMode, setPreviewMode] = useState<boolean>(false);
  const [wordWrap, setWordWrap] = useState<boolean>(true);
  const [showGenerateModal, setShowGenerateModal] = useState<boolean>(false);

  const handleOpenGenerateTasks = () => {
    if (!content.trim()) {
      alert(t('prdEditor.errors.generateNeedsContent', 'Please add content to the PRD before generating tasks.'));
      return;
    }

    setShowGenerateModal(true);
  };

  return (
    <div
      className={cn(
        'fixed inset-0 z-[200] md:bg-black/50 md:flex md:items-center md:justify-center',
        isFullscreen ? 'md:p-0' : 'md:p-4',
      )}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('prdEditor.documentType', 'Product Requirements Document')}
        className={cn(
          'bg-white dark:bg-gray-900 shadow-2xl flex flex-col',
          'w-full h-full md:rounded-lg md:shadow-2xl',
          isFullscreen
            ? 'md:w-full md:h-full md:rounded-none'
            : 'md:w-full md:max-w-6xl md:h-[85vh] md:max-h-[85vh]',
        )}
      >
        {loadError !== null && (
          <div className="border-b border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-200">
            {t('prdEditor.errors.load', { defaultValue: 'Unable to load file content: {{message}}', message: loadError })}
          </div>
        )}

        <PrdEditorHeader
          fileName={fileName}
          onFileNameChange={onFileNameChange}
          isNewFile={isNewFile}
          previewMode={previewMode}
          onTogglePreview={() => setPreviewMode((current) => !current)}
          wordWrap={wordWrap}
          onToggleWordWrap={() => setWordWrap((current) => !current)}
          isDarkMode={isDarkMode}
          onToggleTheme={() => setIsDarkMode((current) => !current)}
          onDownload={onDownload}
          onOpenGenerateTasks={handleOpenGenerateTasks}
          canGenerateTasks={Boolean(content.trim())}
          onSave={onSave}
          saving={saving}
          saveSuccess={saveSuccess}
          isFullscreen={isFullscreen}
          onToggleFullscreen={onToggleFullscreen}
          onClose={onClose}
        />

        <div className="flex-1 overflow-hidden">
          <PrdEditorBody
            content={content}
            onContentChange={onContentChange}
            previewMode={previewMode}
            isDarkMode={isDarkMode}
            wordWrap={wordWrap}
          />
        </div>

        <PrdEditorFooter content={content} />
      </div>

      <GenerateTasksModal
        isOpen={showGenerateModal}
        fileName={ensurePrdExtension(fileName || 'prd')}
        onClose={() => setShowGenerateModal(false)}
      />
    </div>
  );
}
