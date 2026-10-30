import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { Input } from '@/shared/ui';
import { shouldShowGithubAuthentication } from '@/modules/project-creation-wizard/utils/pathUtils';
import { resolveTemplateGitPlan } from '@/modules/project-creation-wizard/utils/templateGitPlan';
import type { GithubTokenCredential, ProjectTemplateGitSource, ProjectTemplateSummary, TokenMode } from '@/shared/types';
import GithubAuthenticationCard from '@/modules/project-creation-wizard/GithubAuthenticationCard';
import WorkspacePathField from '@/modules/project-creation-wizard/WorkspacePathField';

type StepConfigurationProps = {
  template: ProjectTemplateSummary;
  gitSource: ProjectTemplateGitSource;
  workspacePath: string;
  githubUrl: string;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
  availableTokens: GithubTokenCredential[];
  loadingTokens: boolean;
  tokenLoadError: string | null;
  isCreating: boolean;
  onGitSourceChange: (gitSource: ProjectTemplateGitSource) => void;
  onWorkspacePathChange: (workspacePath: string) => void;
  onGithubUrlChange: (githubUrl: string) => void;
  onTokenModeChange: (tokenMode: TokenMode) => void;
  onSelectedGithubTokenChange: (tokenId: string) => void;
  onNewGithubTokenChange: (tokenValue: string) => void;
  onAdvanceToConfirm: () => void;
};

const getSourceClassName = (isSelected: boolean) =>
  `rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
    isSelected
      ? 'bg-blue-500 text-white'
      : 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
  }`;

/** Rendered by ProjectCreationWizard as step 2, collecting the workspace path, the template's Git source, the clone URL and GitHub authentication. */
export default function StepConfiguration({
  template,
  gitSource,
  workspacePath,
  githubUrl,
  tokenMode,
  selectedGithubToken,
  newGithubToken,
  availableTokens,
  loadingTokens,
  tokenLoadError,
  isCreating,
  onGitSourceChange,
  onWorkspacePathChange,
  onGithubUrlChange,
  onTokenModeChange,
  onSelectedGithubTokenChange,
  onNewGithubTokenChange,
  onAdvanceToConfirm,
}: StepConfigurationProps) {
  const { t } = useTranslation();
  const gitSourceLabelId = useId();
  const githubUrlInputId = useId();
  const gitPlan = resolveTemplateGitPlan(template, gitSource, githubUrl);
  const showGithubAuth = gitPlan.showsGithubUrl && shouldShowGithubAuthentication(githubUrl);

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('projectWizard.step2.newPath')}
        </label>

        <WorkspacePathField
          value={workspacePath}
          disabled={isCreating}
          onChange={onWorkspacePathChange}
          onAdvanceToConfirm={onAdvanceToConfirm}
        />

        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('projectWizard.step2.newHelp')}
        </p>
      </div>

      {gitPlan.offersSourceChoice && (
        <div>
          <p id={gitSourceLabelId} className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('projectWizard.git.label')}
          </p>
          <div role="radiogroup" aria-labelledby={gitSourceLabelId} className="grid grid-cols-2 gap-2">
            <button
              type="button"
              role="radio"
              aria-checked={gitSource === 'init'}
              onClick={() => onGitSourceChange('init')}
              className={getSourceClassName(gitSource === 'init')}
              disabled={isCreating}
            >
              {t('projectWizard.git.newRepo')}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={gitSource === 'clone'}
              onClick={() => onGitSourceChange('clone')}
              className={getSourceClassName(gitSource === 'clone')}
              disabled={isCreating}
            >
              {t('projectWizard.git.importGithub')}
            </button>
          </div>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {gitSource === 'init' ? t('projectWizard.git.newRepoHelp') : t('projectWizard.git.importGithubHelp')}
          </p>
        </div>
      )}

      {gitPlan.showsGithubUrl && (
        <div>
          <label htmlFor={githubUrlInputId} className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
            {gitPlan.requiresGithubUrl ? t('projectWizard.git.githubUrl') : t('projectWizard.step2.githubUrl')}
          </label>
          <Input
            id={githubUrlInputId}
            type="text"
            value={githubUrl}
            onChange={(event) => onGithubUrlChange(event.target.value)}
            placeholder="https://github.com/username/repository"
            className="w-full"
            disabled={isCreating}
          />
          {!gitPlan.requiresGithubUrl && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('projectWizard.step2.githubHelp')}
            </p>
          )}
        </div>
      )}

      {showGithubAuth && (
        <GithubAuthenticationCard
          tokenMode={tokenMode}
          selectedGithubToken={selectedGithubToken}
          newGithubToken={newGithubToken}
          availableTokens={availableTokens}
          loadingTokens={loadingTokens}
          tokenLoadError={tokenLoadError}
          onTokenModeChange={onTokenModeChange}
          onSelectedGithubTokenChange={onSelectedGithubTokenChange}
          onNewGithubTokenChange={onNewGithubTokenChange}
        />
      )}
    </div>
  );
}
