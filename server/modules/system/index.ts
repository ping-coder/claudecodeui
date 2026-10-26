// createSystemModule: used by the server entrypoint to mount protected system update routes.
export { createSystemModule } from './system.module.js';
// resolveDeploymentEnvironment: used by the server entrypoint to report CLOUDCLI_DEPLOY_ENV on /health.
export { resolveDeploymentEnvironment } from './deployment-environment.service.js';
