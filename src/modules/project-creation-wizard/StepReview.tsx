import { useMemo } from 'react';
import { Check, Circle, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { getCloneTargetPath, isSshGitUrl } from '@/modules/project-creation-wizard/utils/pathUtils';
import { resolveTemplateGitPlan } from '@/modules/project-creation-wizard/utils/templateGitPlan';
import { BLANK_PROJECT_TEMPLATE } from '@/shared/constants';
import type { CloneTemplatePhase, ProjectTemplateSummary, WizardFormState } from '@/shared/types';

type StepReviewProps = {
  formState: WizardFormState;
  template: ProjectTemplateSummary;
  selectedTokenName: string | null;
  isCreating: boolean;
  cloneProgress: string;
  /** Only read while a template other than Blank is cloning. */
  clonePhase: CloneTemplatePhase;
};

/** Rendered by ProjectCreationWizard as step 3, summarising the chosen template and configuration and streaming creation progress. */
export default function StepReview({
  formState,
  template,
  selectedTokenName,
  isCreating,
  cloneProgress,
  clonePhase,
}: StepReviewProps) {
  const { t } = useTranslation();
  const isBlank = template.id === BLANK_PROJECT_TEMPLATE.id;
  const gitPlan = resolveTemplateGitPlan(template, formState.gitSource, formState.githubUrl);

  const authenticationLabel = useMemo(() => {
    if (formState.tokenMode === 'stored' && formState.selectedGithubToken) {
      return `${t('projectWizard.step3.usingStoredToken')} ${selectedTokenName || t('common:misc.unknownProvider')}`;
    }

    if (formState.tokenMode === 'new' && formState.newGithubToken.trim()) {
      return t('projectWizard.step3.usingProvidedToken');
    }

    if (isSshGitUrl(formState.githubUrl)) {
      return t('projectWizard.step3.sshKey', { defaultValue: 'SSH Key' });
    }

    return t('projectWizard.step3.noAuthentication');
  }, [formState, selectedTokenName, t]);

  const gitActionLabel = gitPlan.initializesRepository
    ? t('projectWizard.step3.gitInitCommit')
    : gitPlan.clones
      ? t('projectWizard.step3.gitCloneUncommitted')
      : t('projectWizard.step3.gitNone');

  const renderPhase = (label: string, state: 'pending' | 'running' | 'done') => (
    <li className="flex items-center gap-2 text-sm font-medium text-blue-800 dark:text-blue-200">
      {state === 'done' && <Check className="h-4 w-4 flex-shrink-0 text-green-600 dark:text-green-400" />}
      {state === 'running' && <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" />}
      {state === 'pending' && <Circle className="h-4 w-4 flex-shrink-0 opacity-50" />}
      {label}
    </li>
  );

  const renderStatus = () => {
    if (isCreating && gitPlan.clones && !isBlank) {
      return (
        <div className="space-y-2">
          <ol className="space-y-1">
            {renderPhase(t('projectWizard.step3.phaseClone'), clonePhase === 'clone' ? 'running' : 'done')}
            {renderPhase(
              t('projectWizard.step3.phaseTemplate'),
              clonePhase === 'clone' ? 'pending' : clonePhase === 'template' ? 'running' : 'done',
            )}
          </ol>
          {cloneProgress && clonePhase === 'clone' && (
            <code className="block whitespace-pre-wrap break-all font-mono text-xs text-blue-700 dark:text-blue-300">
              {cloneProgress}
            </code>
          )}
        </div>
      );
    }

    if (isCreating && cloneProgress) {
      return (
        <div className="space-y-2">
          <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
            {t('projectWizard.step3.cloningRepository', { defaultValue: 'Cloning repository...' })}
          </p>
          <code className="block whitespace-pre-wrap break-all font-mono text-xs text-blue-700 dark:text-blue-300">
            {cloneProgress}
          </code>
        </div>
      );
    }

    if (isCreating && !isBlank) {
      return (
        <p className="flex items-center gap-2 text-sm text-blue-800 dark:text-blue-200">
          <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" />
          {t('projectWizard.step3.creatingWithTemplate')}
        </p>
      );
    }

    return (
      <div className="space-y-1">
        <p className="text-sm text-blue-800 dark:text-blue-200">
          {gitPlan.clones
            ? t('projectWizard.step3.newWithClone')
            : t('projectWizard.step3.newEmpty')}
        </p>
        {!isBlank && (
          <p className="text-sm text-blue-800 dark:text-blue-200">{t('projectWizard.step3.keepsExisting')}</p>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
        <h4 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
          {t('projectWizard.step3.reviewConfig')}
        </h4>

        <div className="space-y-2">
          <div className="flex justify-between gap-4 text-sm">
            <span className="text-gray-600 dark:text-gray-400">{t('projectWizard.step3.template')}</span>
            <span className="text-xs text-gray-900 dark:text-white">
              {t(`projectWizard.templates.${template.id}.title`, { defaultValue: template.id })}
            </span>
          </div>

          <div className="flex justify-between gap-4 text-sm">
            <span className="text-gray-600 dark:text-gray-400">{t('projectWizard.step3.path')}</span>
            <span className="break-all font-mono text-xs text-gray-900 dark:text-white">
              {formState.workspacePath}
            </span>
          </div>

          {gitPlan.clones && (
            <>
              <div className="flex justify-between gap-4 text-sm">
                <span className="text-gray-600 dark:text-gray-400">{t('projectWizard.step3.finalPath')}</span>
                <span className="break-all font-mono text-xs text-gray-900 dark:text-white">
                  {getCloneTargetPath(formState.workspacePath, formState.githubUrl)}
                </span>
              </div>

              <div className="flex justify-between gap-4 text-sm">
                <span className="text-gray-600 dark:text-gray-400">
                  {t('projectWizard.step3.cloneFrom')}
                </span>
                <span className="break-all font-mono text-xs text-gray-900 dark:text-white">
                  {formState.githubUrl}
                </span>
              </div>

              <div className="flex justify-between gap-4 text-sm">
                <span className="text-gray-600 dark:text-gray-400">
                  {t('projectWizard.step3.authentication')}
                </span>
                <span className="text-xs text-gray-900 dark:text-white">{authenticationLabel}</span>
              </div>
            </>
          )}

          {!isBlank && (
            <>
              {template.files.length > 0 && (
                <div className="flex justify-between gap-4 text-sm">
                  <span className="flex-shrink-0 text-gray-600 dark:text-gray-400">
                    {t('projectWizard.step3.filesToAdd')}
                  </span>
                  <ul className="min-w-0 space-y-0.5">
                    {template.files.map((file) => (
                      <li key={file} className="break-all font-mono text-xs text-gray-900 dark:text-white">
                        {file}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {template.skills.length > 0 && (
                <div className="flex justify-between gap-4 text-sm">
                  <span className="flex-shrink-0 text-gray-600 dark:text-gray-400">
                    {t('projectWizard.step3.skillsToAdd')}
                  </span>
                  <span className="break-all font-mono text-xs text-gray-900 dark:text-white">
                    {template.skills.join(', ')}
                  </span>
                </div>
              )}

              <div className="flex justify-between gap-4 text-sm">
                <span className="flex-shrink-0 text-gray-600 dark:text-gray-400">
                  {t('projectWizard.step3.gitAction')}
                </span>
                <span className="text-xs text-gray-900 dark:text-white">{gitActionLabel}</span>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-900/20">
        {renderStatus()}
      </div>
    </div>
  );
}
