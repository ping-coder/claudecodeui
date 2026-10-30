// listProjectTemplates, resolveProjectTemplate: used by the projects module to list templates for the
// wizard and to reject an unknown template id before a create or clone touches the disk.
export { listProjectTemplates, resolveProjectTemplate } from './project-template.registry.js';
// applyProjectTemplate: used by the projects module to write template files into a created or cloned project.
export { applyProjectTemplate } from './services/project-template-apply.service.js';
// initializeTemplateGitRepository: used by the projects module for the "new repository" git source.
export { initializeTemplateGitRepository } from './services/project-template-git.service.js';
