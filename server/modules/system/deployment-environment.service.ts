/**
 * `CLOUDCLI_DEPLOY_ENV` values (compared lower-cased) that name the production
 * deployment, which carries no environment marker.
 */
const PRODUCTION_DEPLOYMENT_ENVIRONMENTS = new Set(['production', 'prod']);

/**
 * Turns the raw `CLOUDCLI_DEPLOY_ENV` value into the environment name the public
 * `/health` route reports: the trimmed value as configured (case kept) when it
 * names a non-production deployment such as "staging", otherwise null. Unset,
 * blank, "production" and "prod" (in any case) all mean production.
 *
 * Used by the server entrypoint, which resolves it once at startup for `/health`
 * so the web UI can mark the tab title and the sidebar of a non-production server.
 */
export function resolveDeploymentEnvironment(rawValue: string | undefined): string | null {
  const environment = rawValue?.trim() ?? '';
  if (!environment || PRODUCTION_DEPLOYMENT_ENVIRONMENTS.has(environment.toLowerCase())) {
    return null;
  }

  return environment;
}
