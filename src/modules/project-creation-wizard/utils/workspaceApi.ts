import { api } from '@/shared/api';
import type {
  FolderSuggestion,
  GithubTokenCredential,
  ProjectTemplateReport,
  ProjectTemplateSummary,
  TokenMode,
} from '@/shared/types';

type CredentialsResponse = {
  credentials?: GithubTokenCredential[];
  error?: string;
};

type BrowseFilesystemResponse = {
  path?: string;
  suggestions?: FolderSuggestion[];
  error?: string;
};

type CreateFolderResponse = {
  success?: boolean;
  path?: string;
  error?: string;
  details?: string;
};

type CreateProjectPayload = {
  path: string;
  customName?: string;
  // Left out for Blank, so its request stays exactly what it was before templates.
  templateId?: string;
  git?: 'init' | 'none';
  locale?: string;
};

type CreateProjectApiError = {
  code?: string;
  message?: string;
  details?: unknown;
};

type CreateProjectResponse = {
  success?: boolean;
  project?: Record<string, unknown>;
  template?: ProjectTemplateReport;
  error?: string | CreateProjectApiError;
  details?: string;
  message?: string;
};

type ProjectTemplatesResponse = {
  success?: boolean;
  data?: { templates?: ProjectTemplateSummary[] };
  error?: string | CreateProjectApiError;
};

type CloneProgressEvent = {
  type?: string;
  message?: string;
  // 'template' marks the server writing the template files after the clone.
  phase?: string;
  code?: string;
  project?: Record<string, unknown>;
  report?: ProjectTemplateReport;
  template?: ProjectTemplateReport;
};

type CloneWorkspaceParams = {
  workspacePath: string;
  githubUrl: string;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
  // Left out for Blank, so its request stays exactly what it was before templates.
  templateId?: string;
  locale?: string;
};

type CloneProgressHandlers = {
  onProgress: (message: string) => void;
  // The clone is done and the template's files are being written; the wizard says so in its own words.
  onTemplatePhase?: () => void;
  // The template's files are in the clone; registration comes next.
  onTemplate?: (report: ProjectTemplateReport) => void;
};

/** The created project and, for a template other than Blank, what the template did. */
type ProjectCreationResult = {
  project?: Record<string, unknown>;
  template?: ProjectTemplateReport;
};

/** An Error that keeps the server's structured code, so the wizard can show its own text for codes it knows. */
const createCodedError = (message: string, code: unknown): Error & { code?: string } =>
  Object.assign(new Error(message), typeof code === 'string' ? { code } : {});

const readErrorCode = (error: CreateProjectResponse['error']): string | undefined =>
  error && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined;

const parseJson = async <T>(response: Response): Promise<T> => {
  const data = (await response.json()) as T;
  return data;
};

const resolveCreateProjectErrorMessage = (responseData: CreateProjectResponse): string | null => {
  if (typeof responseData.details === 'string' && responseData.details.trim().length > 0) {
    return responseData.details;
  }

  if (typeof responseData.error === 'string' && responseData.error.trim().length > 0) {
    return responseData.error;
  }

  if (responseData.error && typeof responseData.error === 'object') {
    const errorObject = responseData.error as { message?: unknown; details?: unknown };

    if (typeof errorObject.details === 'string' && errorObject.details.trim().length > 0) {
      return errorObject.details;
    }

    if (typeof errorObject.message === 'string' && errorObject.message.trim().length > 0) {
      return errorObject.message;
    }

    if (
      errorObject.details
      && typeof errorObject.details === 'object'
      && typeof (errorObject.details as { projectPath?: unknown }).projectPath === 'string'
    ) {
      return `Project path already exists: ${(errorObject.details as { projectPath: string }).projectPath}`;
    }
  }

  if (typeof responseData.message === 'string' && responseData.message.trim().length > 0) {
    return responseData.message;
  }

  return null;
};

export const fetchGithubTokenCredentials = async () => {
  const response = await api.settings.credentials('github_token');
  const data = await parseJson<CredentialsResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to load GitHub tokens');
  }

  return (data.credentials || []).filter((credential) => credential.is_active);
};

export const browseFilesystemFolders = async (pathToBrowse: string) => {
  const response = await api.browseFilesystem(pathToBrowse);
  const data = await parseJson<BrowseFilesystemResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to browse filesystem');
  }

  return {
    path: data.path || pathToBrowse,
    suggestions: (data.suggestions || []) as FolderSuggestion[],
  };
};

export const createFolderInFilesystem = async (folderPath: string) => {
  const response = await api.createFolder(folderPath);
  const data = await parseJson<CreateFolderResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to create folder');
  }

  return data.path || folderPath;
};

export const fetchProjectTemplates = async (): Promise<ProjectTemplateSummary[]> => {
  const response = await api.projectTemplates();
  const data = await parseJson<ProjectTemplatesResponse>(response);
  const templates = data.data?.templates;

  if (!response.ok || !Array.isArray(templates)) {
    const errorMessage = typeof data.error === 'string' ? data.error : data.error?.message;
    throw new Error(errorMessage || 'Failed to load project templates');
  }

  return templates;
};

export const createProjectRequest = async (payload: CreateProjectPayload): Promise<ProjectCreationResult> => {
  const response = await api.createProject(payload);
  const data = await parseJson<CreateProjectResponse>(response);

  if (!response.ok) {
    throw createCodedError(
      resolveCreateProjectErrorMessage(data) || 'Failed to create project',
      readErrorCode(data.error),
    );
  }

  return { project: data.project, template: data.template };
};

type StartCloneResponse = {
  cloneId?: string;
  error?: string | CreateProjectApiError;
};

// Submits the clone details — token included — in a request body and returns
// the id the progress stream is opened with, so the token never enters a URL.
const startClone = async ({
  workspacePath,
  githubUrl,
  tokenMode,
  selectedGithubToken,
  newGithubToken,
  templateId,
  locale,
}: CloneWorkspaceParams) => {
  const response = await api.startProjectClone({
    path: workspacePath.trim(),
    githubUrl: githubUrl.trim(),
    githubTokenId: tokenMode === 'stored' && selectedGithubToken ? Number(selectedGithubToken) : null,
    newGithubToken: tokenMode === 'new' ? newGithubToken.trim() : null,
    ...(templateId ? { templateId, locale } : {}),
  });
  const data = await parseJson<StartCloneResponse>(response);

  if (!response.ok || !data.cloneId) {
    const errorMessage = typeof data.error === 'string' ? data.error : data.error?.message;
    throw createCodedError(errorMessage || 'Failed to start clone', readErrorCode(data.error));
  }

  return data.cloneId;
};

const streamCloneProgress = (
  cloneId: string,
  handlers: CloneProgressHandlers,
) =>
  new Promise<ProjectCreationResult>((resolve, reject) => {
    const eventSource = new EventSource(api.cloneProjectProgressUrl({ cloneId }));
    let settled = false;
    // `complete` carries the report too; this keeps the one the template event delivered in case it does not.
    let templateReport: ProjectTemplateReport | undefined;

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      eventSource.close();
      callback();
    };

    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as CloneProgressEvent;

        if (payload.type === 'progress' && payload.phase === 'template') {
          handlers.onTemplatePhase?.();
          return;
        }

        if (payload.type === 'progress' && payload.message) {
          handlers.onProgress(payload.message);
          return;
        }

        if (payload.type === 'template' && payload.report) {
          templateReport = payload.report;
          handlers.onTemplate?.(payload.report);
          return;
        }

        if (payload.type === 'complete') {
          settle(() => resolve({ project: payload.project, template: payload.template ?? templateReport }));
          return;
        }

        if (payload.type === 'error') {
          settle(() => reject(createCodedError(payload.message || 'Failed to clone repository', payload.code)));
        }
      } catch (error) {
        console.error('Error parsing clone progress event:', error);
      }
    };

    eventSource.onerror = () => {
      settle(() => reject(new Error('Connection lost during clone')));
    };
  });

export const cloneWorkspaceWithProgress = async (
  params: CloneWorkspaceParams,
  handlers: CloneProgressHandlers,
) => streamCloneProgress(await startClone(params), handlers);
