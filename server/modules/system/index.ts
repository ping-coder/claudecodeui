// createSystemModule: used by the server entrypoint to mount the protected system routes (update, browser diagnostics).
export { createSystemModule } from './system.module.js';
// resolveDeploymentEnvironment: used by the server entrypoint to report CLOUDCLI_DEPLOY_ENV on /health.
export { resolveDeploymentEnvironment } from './deployment-environment.service.js';
