import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { test } from 'vitest';

import '@/modules/i18n';
import CreationResult from '@/modules/project-creation-wizard/CreationResult';
import type { ProjectTemplateReport } from '@/shared/types';

/**
 * The result view's Git line says what happened to the repository and, only when the run wrote
 * files, that those files wait uncommitted. A clone or an existing repository where every file was
 * skipped, or where the template write failed, has nothing to review in Source Control.
 */

const CODING_FILES = ['TASKS.md', 'CLAUDE.md', '.gitignore'];
const CLONED_UNCOMMITTED = 'The template files are uncommitted in the clone. Review them in Source Control.';
const ALREADY_REPOSITORY_UNCOMMITTED = 'The folder was already a Git repository, so the new files are left uncommitted.';

const report = (overrides: Partial<ProjectTemplateReport>): ProjectTemplateReport => ({
  templateId: 'coding',
  created: [],
  skipped: [],
  git: { action: 'none', committed: false },
  warnings: [],
  ...overrides,
});

const shows = (text: string | RegExp) => screen.queryByText(text) !== null;

test('a clone whose template write failed only says it cloned', () => {
  render(<CreationResult report={report({ git: { action: 'cloned', committed: false }, warnings: ['TEMPLATE_APPLY_FAILED'] })} />);

  assert.equal(shows("The template files couldn't be written. The project was created without them."), true);
  assert.equal(shows(CLONED_UNCOMMITTED), false);
  assert.equal(shows('Cloned the repository.'), true);
});

test('a clone that already had every template file only says it cloned', () => {
  render(
    <CreationResult
      report={report({
        git: { action: 'cloned', committed: false },
        skipped: [
          ...CODING_FILES.map((path) => ({ path, reason: 'exists' as const })),
          { path: '.claude/skills/task-runner/SKILL.md', reason: 'group-exists' },
        ],
      })}
    />,
  );

  assert.equal(shows(CLONED_UNCOMMITTED), false);
  assert.equal(shows('Cloned the repository.'), true);
});

test('a clone that wrote files points at them in Source Control', () => {
  render(
    <CreationResult
      report={report({
        git: { action: 'cloned', committed: false },
        created: ['TASKS.md'],
        skipped: [{ path: 'CLAUDE.md', reason: 'exists' }],
      })}
    />,
  );

  assert.equal(shows(CLONED_UNCOMMITTED), true);
  assert.equal(shows('Cloned the repository.'), false);
});

test('an existing repository speaks of uncommitted files only when some were written', () => {
  const view = render(
    <CreationResult
      report={report({
        git: { action: 'already-repository', committed: false },
        skipped: CODING_FILES.map((path) => ({ path, reason: 'exists' as const })),
      })}
    />,
  );
  assert.equal(shows(ALREADY_REPOSITORY_UNCOMMITTED), false);
  assert.equal(shows('The folder was already a Git repository.'), true);
  view.unmount();

  render(
    <CreationResult
      report={report({
        git: { action: 'already-repository', committed: false },
        created: ['TASKS.md'],
        skipped: [{ path: 'CLAUDE.md', reason: 'exists' }],
      })}
    />,
  );
  assert.equal(shows(ALREADY_REPOSITORY_UNCOMMITTED), true);
  assert.equal(shows('The folder was already a Git repository.'), false);
});

test('a file skipped as unsafe names both causes: a symlink or a path outside the project', () => {
  render(
    <CreationResult
      report={report({
        git: { action: 'cloned', committed: false },
        skipped: [{ path: '.claude/skills/issue/SKILL.md', reason: 'unsafe-path' }],
      })}
    />,
  );

  assert.equal(shows(/the path goes through a symlink or leads outside the project/), true);
});
