import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import type { ExistingPrdFile } from '@/shared/types';
import { ensurePrdExtension } from '@/modules/prd-editor/utils/fileName';

type SavePrdInput = {
  content: string;
  fileName: string;
  allowOverwrite?: boolean;
};

type SavePrdResult =
  | { status: 'saved'; fileName: string }
  | { status: 'needs-overwrite'; fileName: string }
  | { status: 'failed'; message: string };

type UsePrdSaveArgs = {
  // DB primary key of the project (post migration).
  projectId?: string;
  existingPrds: ExistingPrdFile[];
  isExistingFile: boolean;
  onAfterSave?: () => Promise<void>;
};

type UsePrdSaveResult = {
  savePrd: (input: SavePrdInput) => Promise<SavePrdResult>;
  saving: boolean;
  saveSuccess: boolean;
};

export function usePrdSave({
  projectId,
  existingPrds,
  isExistingFile,
  onAfterSave,
}: UsePrdSaveArgs): UsePrdSaveResult {
  // A failure's message is shown to the user as it is, so it is worded here, in the UI language.
  const { t } = useTranslation('tasks');
  const [saving, setSaving] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const saveSuccessTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (saveSuccessTimeoutRef.current) {
        clearTimeout(saveSuccessTimeoutRef.current);
      }
    };
  }, []);

  const savePrd = useCallback(
    async ({ content, fileName, allowOverwrite = false }: SavePrdInput): Promise<SavePrdResult> => {
      if (!content.trim()) {
        return { status: 'failed', message: t('prdEditor.errors.emptyContent', 'Please add content before saving.') };
      }

      if (!fileName.trim()) {
        return { status: 'failed', message: t('prdEditor.errors.emptyFileName', 'Please provide a filename for the PRD.') };
      }

      if (!projectId) {
        return { status: 'failed', message: t('prdEditor.errors.noProject', 'No project selected. Please reopen the editor.') };
      }

      const finalFileName = ensurePrdExtension(fileName.trim());
      const hasConflict = existingPrds.some((prd) => prd.name === finalFileName);

      // Overwrite confirmation is only required when creating a brand-new PRD.
      if (hasConflict && !allowOverwrite && !isExistingFile) {
        return { status: 'needs-overwrite', fileName: finalFileName };
      }

      setSaving(true);

      try {
        const response = await api.taskmaster.savePrd(projectId, {
          fileName: finalFileName,
          content,
        });

        if (!response.ok) {
          const fallbackMessage = t('prdEditor.errors.saveStatus', { defaultValue: 'Save failed: {{status}}', status: response.status });

          try {
            const errorData = (await response.json()) as { message?: string };
            return { status: 'failed', message: errorData.message || fallbackMessage };
          } catch {
            return { status: 'failed', message: fallbackMessage };
          }
        }

        if (saveSuccessTimeoutRef.current) {
          clearTimeout(saveSuccessTimeoutRef.current);
        }

        setSaveSuccess(true);
        saveSuccessTimeoutRef.current = setTimeout(() => {
          setSaveSuccess(false);
          saveSuccessTimeoutRef.current = null;
        }, 2000);

        if (onAfterSave) {
          await onAfterSave();
        }

        return { status: 'saved', fileName: finalFileName };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { status: 'failed', message: t('prdEditor.errors.save', { defaultValue: 'Error saving PRD: {{message}}', message }) };
      } finally {
        setSaving(false);
      }
    },
    [existingPrds, isExistingFile, onAfterSave, projectId, t],
  );

  return {
    savePrd,
    saving,
    saveSuccess,
  };
}
