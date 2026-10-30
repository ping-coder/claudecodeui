import { useEffect, useState } from 'react';

import { fetchProjectTemplates } from '@/modules/project-creation-wizard/utils/workspaceApi';
import { BLANK_PROJECT_TEMPLATE } from '@/shared/constants';
import type { ProjectTemplateSummary } from '@/shared/types';

/**
 * The templates the wizard offers, loaded once when it opens. A list that fails to load leaves only
 * Blank, which needs nothing from the server; Blank stays first even if the server ever omits it.
 */
export const useProjectTemplates = () => {
  // The cards on the Template step, and the summary every later step reads for the chosen id.
  const [templates, setTemplates] = useState<ProjectTemplateSummary[]>([BLANK_PROJECT_TEMPLATE]);
  // Holds the Template step's Next until the list is in, so a remembered template is not skipped over.
  const [isLoading, setIsLoading] = useState(true);
  // Tells the user why only Blank is on offer.
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let isDisposed = false;

    fetchProjectTemplates()
      .then((loadedTemplates) => {
        if (isDisposed) {
          return;
        }
        const others = loadedTemplates.filter((template) => template.id !== BLANK_PROJECT_TEMPLATE.id);
        const blank = loadedTemplates.find((template) => template.id === BLANK_PROJECT_TEMPLATE.id);
        setTemplates([blank ?? BLANK_PROJECT_TEMPLATE, ...others]);
      })
      .catch((error) => {
        if (isDisposed) {
          return;
        }
        console.error('Failed to load project templates:', error);
        setLoadFailed(true);
      })
      .finally(() => {
        if (!isDisposed) {
          setIsLoading(false);
        }
      });

    return () => {
      isDisposed = true;
    };
  }, []);

  return { templates, isLoading, loadFailed };
};
