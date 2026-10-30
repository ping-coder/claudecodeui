import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ProjectTemplateReport } from '@/shared/types';

type CreationResultProps = {
  report: ProjectTemplateReport;
};

/** Rendered by ProjectCreationWizard in place of the steps when a template skipped a file or warned, listing what was created, what was left alone and the warnings. */
export default function CreationResult({ report }: CreationResultProps) {
  const { t } = useTranslation();

  const skipReasonLabel = (reason: ProjectTemplateReport['skipped'][number]['reason']) => {
    switch (reason) {
      case 'exists':
        return t('projectWizard.result.skippedExists');
      case 'unsafe-path':
        return t('projectWizard.result.skippedUnsafe');
      case 'group-exists':
        return t('projectWizard.result.skippedGroup');
      default:
        return String(reason);
    }
  };

  // Codes, not text, come from the server; one it does not know yet still shows as its code.
  const warningLabel = (code: ProjectTemplateReport['warnings'][number]) => {
    switch (code) {
      case 'GIT_IDENTITY_MISSING':
        return t('projectWizard.result.gitIdentityMissing');
      case 'GIT_NOT_FOUND':
        return t('projectWizard.result.gitNotFound');
      case 'GIT_INIT_FAILED':
        return t('projectWizard.result.gitInitFailed');
      case 'GIT_COMMIT_FAILED':
        return t('projectWizard.result.gitCommitFailed');
      case 'INSIDE_PARENT_REPOSITORY':
        return t('projectWizard.result.insideParentRepository');
      case 'TEMPLATE_APPLY_FAILED':
        return t('projectWizard.result.templateApplyFailed');
      default:
        return t('projectWizard.result.unknownWarning', { code: String(code) });
    }
  };

  // "Left uncommitted" speaks of the files this run wrote; when every file was skipped or the
  // write failed there are none, so only the repository state is told.
  const hasCreatedFiles = report.created.length > 0;
  const gitSummary = (() => {
    switch (report.git.action) {
      case 'initialized':
        return report.git.committed
          ? t('projectWizard.result.gitInitialized')
          : t('projectWizard.result.gitInitializedUncommitted');
      case 'already-repository':
        return hasCreatedFiles
          ? t('projectWizard.result.gitAlreadyRepository')
          : t('projectWizard.result.gitAlreadyRepositoryNoFiles');
      case 'cloned':
        return hasCreatedFiles ? t('projectWizard.result.gitCloned') : t('projectWizard.result.gitClonedNoFiles');
      default:
        // 'inside-parent-repository' and 'none' are explained by their warning, if any.
        return null;
    }
  })();

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-600 dark:text-green-400" />
        <div>
          <h4 className="font-semibold text-gray-900 dark:text-white">{t('projectWizard.result.title')}</h4>
          <p className="text-sm text-gray-600 dark:text-gray-400">{t('projectWizard.result.summary')}</p>
        </div>
      </div>

      {report.warnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20">
          <h5 className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            {t('projectWizard.result.warnings')}
          </h5>
          <ul className="list-disc space-y-1 ps-5 text-sm text-amber-800 dark:text-amber-200">
            {report.warnings.map((code) => (
              <li key={code}>{warningLabel(code)}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
        {gitSummary && <p className="text-sm text-gray-700 dark:text-gray-300">{gitSummary}</p>}

        {report.created.length > 0 && (
          <div>
            <h5 className="mb-1 text-sm font-semibold text-gray-900 dark:text-white">
              {t('projectWizard.result.created')}
            </h5>
            <ul className="space-y-0.5">
              {report.created.map((file) => (
                <li key={file} className="break-all font-mono text-xs text-gray-700 dark:text-gray-300">
                  {file}
                </li>
              ))}
            </ul>
          </div>
        )}

        {report.skipped.length > 0 && (
          <div>
            <h5 className="mb-1 text-sm font-semibold text-gray-900 dark:text-white">
              {t('projectWizard.result.skipped')}
            </h5>
            <ul className="space-y-0.5">
              {report.skipped.map((entry) => (
                <li key={entry.path} className="text-xs text-gray-700 dark:text-gray-300">
                  <span className="break-all font-mono">{entry.path}</span>
                  {' · '}
                  {skipReasonLabel(entry.reason)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
