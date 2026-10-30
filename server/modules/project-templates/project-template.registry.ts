import path from 'node:path';

import type { ProjectTemplateDefinition, ProjectTemplateSummary } from '@/shared/types.js';
import { AppError, findServerRoot, getModuleDirectory } from '@/shared/utils.js';

const BLANK_TEMPLATE_ID = 'blank';

/**
 * Every template the project wizard offers, Blank first. Add a template by
 * adding an entry here and its assets under `templates/<id>/<locale>/`.
 * Asset names end in `.tpl` and never use the real file name: the repository's
 * .gitignore drops CLAUDE.md and .claude/, and npm's packlist drops any file
 * named .gitignore.
 */
const PROJECT_TEMPLATES: ProjectTemplateDefinition[] = [
  {
    id: BLANK_TEMPLATE_ID,
    locales: [],
    defaultLocale: 'en',
    files: [],
    skills: [],
    git: {
      offersInit: false,
      offersClone: true,
      defaultMode: 'none',
      initialCommitMessage: '',
    },
  },
  {
    id: 'coding',
    locales: ['en', 'zh-CN'],
    defaultLocale: 'en',
    files: [
      { target: 'TASKS.md', source: 'TASKS.md.tpl', render: true },
      { target: 'CLAUDE.md', source: 'CLAUDE.md.tpl', render: true },
      { target: '.gitignore', source: 'gitignore.tpl', render: false },
      {
        target: '.claude/skills/task-runner/SKILL.md',
        source: 'skills/task-runner/SKILL.md.tpl',
        render: false,
        group: '.claude/skills/task-runner',
      },
      {
        target: '.claude/skills/issue/SKILL.md',
        source: 'skills/issue/SKILL.md.tpl',
        render: false,
        group: '.claude/skills/issue',
      },
    ],
    skills: ['task-runner', 'issue'],
    git: {
      offersInit: true,
      offersClone: true,
      defaultMode: 'init',
      // Commit messages stay English whatever the interface language is.
      initialCommitMessage: 'Initial commit from the coding template',
    },
  },
];

/**
 * Where template assets live at runtime. `findServerRoot` resolves to
 * `server/` under tsx and to `dist-server/server/` in a build, where
 * scripts/copy-server-assets.mjs puts the same folder.
 */
const PROJECT_TEMPLATE_ASSET_ROOT = path.join(
  findServerRoot(getModuleDirectory(import.meta.url)),
  'modules',
  'project-templates',
  'templates',
);

/**
 * Absolute path of one asset for a template and locale. Used by the apply
 * engine to read file contents and by the registry tests to check that every
 * source ships.
 */
export function resolveProjectTemplateAssetPath(templateId: string, locale: string, source: string): string {
  return path.join(PROJECT_TEMPLATE_ASSET_ROOT, templateId, locale, source);
}

/**
 * Template list for `GET /api/projects/templates` (projects module), Blank
 * first. Only ids, target paths, skill names and git options go out; the client
 * localizes names and descriptions from the id.
 */
export function listProjectTemplates(): ProjectTemplateSummary[] {
  return PROJECT_TEMPLATES.map((template) => ({
    id: template.id,
    files: template.files.map((file) => file.target),
    skills: [...template.skills],
    git: { init: template.git.offersInit, clone: template.git.offersClone },
  }));
}

/**
 * Looks up the template a create or clone request asked for. Used by the
 * projects module before it touches the disk.
 *
 * A missing id or `blank` returns null, meaning "no template work": the caller
 * keeps today's behavior. An id the registry does not know throws a 400
 * `UNKNOWN_PROJECT_TEMPLATE`.
 */
export function resolveProjectTemplate(templateId: string | null | undefined): ProjectTemplateDefinition | null {
  if (templateId === undefined || templateId === null || templateId === '' || templateId === BLANK_TEMPLATE_ID) {
    return null;
  }

  const template = PROJECT_TEMPLATES.find((candidate) => candidate.id === templateId);
  if (!template) {
    throw new AppError(`Unknown project template: ${templateId}`, {
      code: 'UNKNOWN_PROJECT_TEMPLATE',
      statusCode: 400,
    });
  }

  return template;
}
