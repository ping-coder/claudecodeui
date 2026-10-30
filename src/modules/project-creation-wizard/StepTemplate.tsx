import { Code2, FolderPlus, LayoutTemplate, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { BLANK_PROJECT_TEMPLATE } from '@/shared/constants';
import type { ProjectTemplateSummary } from '@/shared/types';

type StepTemplateProps = {
  templates: ProjectTemplateSummary[];
  selectedTemplateId: string;
  isLoading: boolean;
  loadFailed: boolean;
  onSelectTemplate: (templateId: string) => void;
};

const TEMPLATE_ICONS: Record<string, typeof FolderPlus> = {
  [BLANK_PROJECT_TEMPLATE.id]: FolderPlus,
  coding: Code2,
};

/** Rendered by ProjectCreationWizard as step 1, offering Blank and the server's templates as cards that list what each adds. */
export default function StepTemplate({
  templates,
  selectedTemplateId,
  isLoading,
  loadFailed,
  onSelectTemplate,
}: StepTemplateProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">
        {t('projectWizard.step1.question')}
      </h4>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('projectWizard.step1.loading')}
        </div>
      )}

      {loadFailed && (
        <p className="text-sm text-amber-700 dark:text-amber-300">{t('projectWizard.step1.loadFailed')}</p>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {templates.map((template) => {
          const isSelected = template.id === selectedTemplateId;
          const Icon = TEMPLATE_ICONS[template.id] ?? LayoutTemplate;

          return (
            <button
              key={template.id}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onSelectTemplate(template.id)}
              className={`flex flex-col justify-start rounded-lg border-2 p-4 text-start transition-all ${
                isSelected
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                  : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'
              }`}
            >
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/50">
                  <Icon className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <h5 className="mb-1 font-semibold text-gray-900 dark:text-white">
                    {t(`projectWizard.templates.${template.id}.title`, { defaultValue: template.id })}
                  </h5>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {t(`projectWizard.templates.${template.id}.description`, { defaultValue: '' })}
                  </p>

                  {template.files.length > 0 && (
                    <div className="mt-3">
                      <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
                        {t('projectWizard.step1.files')}
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {template.files.map((file) => (
                          <li key={file} className="break-all font-mono text-xs text-gray-600 dark:text-gray-400">
                            {file}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {template.skills.length > 0 && (
                    <div className="mt-2">
                      <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
                        {t('projectWizard.step1.skills')}
                      </p>
                      <p className="mt-1 font-mono text-xs text-gray-600 dark:text-gray-400">
                        {template.skills.join(', ')}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
