import { useCallback, useState } from 'react';
import { FolderPlus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import CreationResult from '@/modules/project-creation-wizard/CreationResult';
import ErrorBanner from '@/modules/project-creation-wizard/ErrorBanner';
import StepConfiguration from '@/modules/project-creation-wizard/StepConfiguration';
import StepReview from '@/modules/project-creation-wizard/StepReview';
import StepTemplate from '@/modules/project-creation-wizard/StepTemplate';
import WizardFooter from '@/modules/project-creation-wizard/WizardFooter';
import WizardProgress from '@/modules/project-creation-wizard/WizardProgress';
import { useGithubTokens } from '@/modules/project-creation-wizard/hooks/useGithubTokens';
import { useProjectTemplates } from '@/modules/project-creation-wizard/hooks/useProjectTemplates';
import { cloneWorkspaceWithProgress, createProjectRequest } from '@/modules/project-creation-wizard/utils/workspaceApi';
import { shouldShowGithubAuthentication } from '@/modules/project-creation-wizard/utils/pathUtils';
import { resolveTemplateGitPlan } from '@/modules/project-creation-wizard/utils/templateGitPlan';
import { BLANK_PROJECT_TEMPLATE } from '@/shared/constants';
import type {
  CloneTemplatePhase,
  ProjectTemplateReport,
  TokenMode,
  WizardFormState,
  WizardStep,
} from '@/shared/types';

type ProjectCreationWizardProps = {
  onClose: () => void;
  onProjectCreated?: (project?: Record<string, unknown>) => void;
};

const REMEMBERED_TEMPLATE_STORAGE_KEY = 'project-wizard-template';

// The template picked last time; Blank on the first run or when storage is unavailable.
const readRememberedTemplateId = (): string => {
  try {
    return window.localStorage.getItem(REMEMBERED_TEMPLATE_STORAGE_KEY) || BLANK_PROJECT_TEMPLATE.id;
  } catch {
    return BLANK_PROJECT_TEMPLATE.id;
  }
};

const rememberTemplateId = (templateId: string) => {
  try {
    window.localStorage.setItem(REMEMBERED_TEMPLATE_STORAGE_KEY, templateId);
  } catch {
    // Storage unavailable (private mode, quota): the choice just stops being remembered.
  }
};

const createInitialFormState = (): WizardFormState => ({
  templateId: readRememberedTemplateId(),
  gitSource: 'init',
  workspacePath: '',
  githubUrl: '',
  tokenMode: 'stored',
  selectedGithubToken: '',
  newGithubToken: '',
});

// Anything the template left alone or warned about keeps the wizard open on the result view.
const needsAttention = (report: ProjectTemplateReport | undefined): report is ProjectTemplateReport =>
  Boolean(report && (report.skipped.length > 0 || report.warnings.length > 0));

/** Rendered by the sidebar module's modal layer to create a new project, from a template, or clone one from GitHub. */
export default function ProjectCreationWizard({
  onClose,
  onProjectCreated,
}: ProjectCreationWizardProps) {
  const { t, i18n } = useTranslation();
  const [step, setStep] = useState<WizardStep>(1);
  const [formState, setFormState] = useState<WizardFormState>(createInitialFormState);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloneProgress, setCloneProgress] = useState('');
  // How far a template clone has got, for the phases StepReview lists while creating.
  const [clonePhase, setClonePhase] = useState<CloneTemplatePhase>('clone');
  // The report of a creation that skipped files or warned; set, the wizard shows it instead of the steps.
  const [result, setResult] = useState<ProjectTemplateReport | null>(null);

  const { templates, isLoading: isLoadingTemplates, loadFailed: templatesLoadFailed } = useProjectTemplates();
  // A remembered template the server no longer offers (or a list that failed) falls back to Blank.
  const selectedTemplate =
    templates.find((template) => template.id === formState.templateId) ?? BLANK_PROJECT_TEMPLATE;
  const isBlankTemplate = selectedTemplate.id === BLANK_PROJECT_TEMPLATE.id;
  const gitPlan = resolveTemplateGitPlan(selectedTemplate, formState.gitSource, formState.githubUrl);

  const shouldLoadTokens =
    step === 2 && gitPlan.showsGithubUrl && shouldShowGithubAuthentication(formState.githubUrl);

  const autoSelectToken = useCallback((tokenId: string) => {
    setFormState((previous) => ({ ...previous, selectedGithubToken: tokenId }));
  }, []);

  const {
    tokens: availableTokens,
    loading: loadingTokens,
    loadError: tokenLoadError,
    selectedTokenName,
  } = useGithubTokens({
    shouldLoad: shouldLoadTokens,
    selectedTokenId: formState.selectedGithubToken,
    onAutoSelectToken: autoSelectToken,
  });

  // Keep cross-step values in this component; local UI state lives in child components.
  const updateField = useCallback(<K extends keyof WizardFormState>(key: K, value: WizardFormState[K]) => {
    setFormState((previous) => ({ ...previous, [key]: value }));
  }, []);

  const updateTokenMode = useCallback(
    (tokenMode: TokenMode) => updateField('tokenMode', tokenMode),
    [updateField],
  );

  const handleSelectTemplate = useCallback((templateId: string) => {
    updateField('templateId', templateId);
    rememberTemplateId(templateId);
  }, [updateField]);

  const githubUrlError =
    gitPlan.requiresGithubUrl && !formState.githubUrl.trim() ? t('projectWizard.errors.provideGithubUrl') : null;

  const handleNext = useCallback(() => {
    setError(null);

    if (step === 1) {
      setStep(2);
      return;
    }

    if (step === 2) {
      if (!formState.workspacePath.trim()) {
        setError(t('projectWizard.errors.providePath'));
        return;
      }
      if (githubUrlError) {
        setError(githubUrlError);
        return;
      }
      setStep(3);
    }
  }, [formState.workspacePath, githubUrlError, step, t]);

  // The folder browser picks a path and may jump straight to Confirm; an import still needs its URL first.
  const handleAdvanceToConfirm = useCallback(() => {
    setError(githubUrlError);
    if (!githubUrlError) {
      setStep(3);
    }
  }, [githubUrlError]);

  const handleBack = useCallback(() => {
    setError(null);
    setStep((previousStep) => (previousStep > 1 ? ((previousStep - 1) as WizardStep) : previousStep));
  }, []);

  const handleCreate = useCallback(async () => {
    setIsCreating(true);
    setError(null);
    setCloneProgress('');
    setClonePhase('clone');

    // Blank sends nothing new, so its requests stay exactly what they were before templates.
    const templateFields = isBlankTemplate ? {} : { templateId: selectedTemplate.id, locale: i18n.language };
    const createGit: 'init' | 'none' = gitPlan.initializesRepository ? 'init' : 'none';

    try {
      const { project, template } = gitPlan.clones
        ? await cloneWorkspaceWithProgress(
          {
            workspacePath: formState.workspacePath,
            githubUrl: formState.githubUrl,
            tokenMode: formState.tokenMode,
            selectedGithubToken: formState.selectedGithubToken,
            newGithubToken: formState.newGithubToken,
            ...templateFields,
          },
          {
            onProgress: setCloneProgress,
            onTemplatePhase: () => setClonePhase('template'),
            onTemplate: () => setClonePhase('done'),
          },
        )
        : await createProjectRequest({
          path: formState.workspacePath.trim(),
          ...(isBlankTemplate ? {} : { ...templateFields, git: createGit }),
        });

      onProjectCreated?.(project);
      if (needsAttention(template)) {
        setResult(template);
        return;
      }
      onClose();
    } catch (createError) {
      const errorCode = (createError as { code?: unknown } | null)?.code;
      const errorMessage =
        errorCode === 'UNKNOWN_PROJECT_TEMPLATE'
          ? t('projectWizard.errors.unknownTemplate')
          : errorCode === 'TEMPLATE_NOT_ALLOWED_AT_ROOT'
            ? t('projectWizard.errors.templateAtRoot')
            : createError instanceof Error
              ? createError.message
              : t('projectWizard.errors.failedToCreate');
      setError(errorMessage);
    } finally {
      setIsCreating(false);
    }
  }, [formState, gitPlan, i18n.language, isBlankTemplate, onClose, onProjectCreated, selectedTemplate.id, t]);

  return (
    <div className="fixed bottom-0 end-0 start-0 top-0 z-[60] flex items-center justify-center bg-black/50 p-0 backdrop-blur-sm sm:p-4">
      <div className="h-full w-full overflow-y-auto rounded-none border-0 border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800 sm:h-auto sm:max-w-2xl sm:rounded-lg sm:border">
        <div className="flex items-center justify-between border-b border-gray-200 p-6 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/50">
              <FolderPlus className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {t('projectWizard.title')}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            disabled={isCreating}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <WizardProgress step={step} isComplete={result !== null} />

        <div className="min-h-[300px] space-y-6 p-6">
          {error && <ErrorBanner message={error} />}

          {result && <CreationResult report={result} />}

          {!result && step === 1 && (
            <StepTemplate
              templates={templates}
              // Until the list is in, a remembered template is not drawn as Blank.
              selectedTemplateId={isLoadingTemplates ? formState.templateId : selectedTemplate.id}
              isLoading={isLoadingTemplates}
              loadFailed={templatesLoadFailed}
              onSelectTemplate={handleSelectTemplate}
            />
          )}

          {!result && step === 2 && (
            <StepConfiguration
              template={selectedTemplate}
              gitSource={formState.gitSource}
              workspacePath={formState.workspacePath}
              githubUrl={formState.githubUrl}
              tokenMode={formState.tokenMode}
              selectedGithubToken={formState.selectedGithubToken}
              newGithubToken={formState.newGithubToken}
              availableTokens={availableTokens}
              loadingTokens={loadingTokens}
              tokenLoadError={tokenLoadError}
              isCreating={isCreating}
              onGitSourceChange={(gitSource) => updateField('gitSource', gitSource)}
              onWorkspacePathChange={(workspacePath) => updateField('workspacePath', workspacePath)}
              onGithubUrlChange={(githubUrl) => updateField('githubUrl', githubUrl)}
              onTokenModeChange={updateTokenMode}
              onSelectedGithubTokenChange={(selectedGithubToken) =>
                updateField('selectedGithubToken', selectedGithubToken)
              }
              onNewGithubTokenChange={(newGithubToken) =>
                updateField('newGithubToken', newGithubToken)
              }
              onAdvanceToConfirm={handleAdvanceToConfirm}
            />
          )}

          {!result && step === 3 && (
            <StepReview
              formState={formState}
              template={selectedTemplate}
              selectedTokenName={selectedTokenName}
              isCreating={isCreating}
              cloneProgress={cloneProgress}
              clonePhase={clonePhase}
            />
          )}
        </div>

        <WizardFooter
          step={step}
          isCreating={isCreating}
          isCloneWorkflow={gitPlan.clones}
          isNextDisabled={step === 1 && isLoadingTemplates}
          isShowingResult={result !== null}
          onClose={onClose}
          onBack={handleBack}
          onNext={handleNext}
          onCreate={handleCreate}
        />
      </div>
    </div>
  );
}
