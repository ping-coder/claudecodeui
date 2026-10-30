import { isCloneWorkflow } from '@/modules/project-creation-wizard/utils/pathUtils';
import { BLANK_PROJECT_TEMPLATE } from '@/shared/constants';
import type { ProjectTemplateGitSource, ProjectTemplateSummary } from '@/shared/types';

/** What the chosen template and the Configure step's answers mean for the repository and the request sent. */
type TemplateGitPlan = {
  /** Shows the New repository / Import from GitHub switch. */
  offersSourceChoice: boolean;
  showsGithubUrl: boolean;
  /** Next refuses an empty GitHub URL. */
  requiresGithubUrl: boolean;
  /** Creation goes through the clone stream rather than create-project. */
  clones: boolean;
  /** create-project runs git init and the first commit. */
  initializesRepository: boolean;
};

/**
 * Blank keeps the optional GitHub URL it always had: a clone when one is given, a plain folder
 * otherwise. Any other template takes its Git source from the switch when it offers both, or from
 * the only one it offers; a template that offers neither just writes its files.
 */
export const resolveTemplateGitPlan = (
  template: ProjectTemplateSummary,
  gitSource: ProjectTemplateGitSource,
  githubUrl: string,
): TemplateGitPlan => {
  if (template.id === BLANK_PROJECT_TEMPLATE.id) {
    return {
      offersSourceChoice: false,
      showsGithubUrl: true,
      requiresGithubUrl: false,
      clones: isCloneWorkflow(githubUrl),
      initializesRepository: false,
    };
  }

  const { init, clone } = template.git;
  const source: ProjectTemplateGitSource | null = init && clone ? gitSource : init ? 'init' : clone ? 'clone' : null;
  return {
    offersSourceChoice: init && clone,
    showsGithubUrl: source === 'clone',
    requiresGithubUrl: source === 'clone',
    clones: source === 'clone',
    initializesRepository: source === 'init',
  };
};
