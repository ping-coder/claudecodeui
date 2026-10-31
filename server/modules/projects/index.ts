export {
  generateDisplayName,
  getProjectsWithSessions,
} from './services/projects-with-sessions-fetch.service.js';
export { updateProjectDisplayName } from './services/project-management.service.js';
// createProject: used by the worktrees module to register a worktree directory as a switchable project.
export { createProject } from './services/project-management.service.js';
// deleteOrArchiveProject: used by Projects routes and Worktrees cleanup to hide or permanently remove a project.
export { deleteOrArchiveProject, deleteSessionJsonlFilesForProjectPath } from './services/project-delete.service.js';
// restoreArchivedProject: used by the worktrees module to re-activate an archived project when its worktree is reopened.
export { restoreArchivedProject } from './services/project-delete.service.js';
// listProjectMountDirectories: used by the Providers module's runtime context, which hands the project's mounts to the Claude and Codex CLIs.
// listProjectMounts, PROJECT_MOUNTS_DIRECTORY_NAME: used by the File Tree to list mounts as folders, protect their links and read their targets.
// runInMountTarget: used by the File Tree to make its calls in a mount's target through the mount gate, so a hung share cannot take the server's threads.
// isMountShareUnreachable: used by the File Tree to refuse a read by a path outside every mount whose filesystem the mount gate knows to hang.
// onProjectMountsChanged: used by the File Tree to stop listing a mount from its last walk once the mount is added, removed or repaired.
// detachProjectMountLinks: used by the Worktrees module to take a worktree's mount links (and those of projects inside it) out before git deletes it, and put them back when git does not.
export {
  detachProjectMountLinks,
  isMountShareUnreachable,
  listProjectMountDirectories,
  listProjectMounts,
  onProjectMountsChanged,
  PROJECT_MOUNTS_DIRECTORY_NAME,
  runInMountTarget,
} from './services/project-mounts.service.js';
