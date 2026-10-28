import { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { getDeploymentEnvironmentLabel, setDocumentTitleEnvironmentLabel } from '@/shared/utils';

/**
 * The deployment environment `/health` reported. It stays null while the request is in
 * flight, and for the rest of the page load in production or when the request failed.
 */
let deploymentEnvironment: string | null = null;

/** The page load's one `/health` read, started by the first subscriber and shared by all later ones. */
let deploymentEnvironmentRequest: Promise<void> | null = null;

/** Re-render callbacks of the mounted `useDeploymentEnvironment` callers. */
const deploymentEnvironmentListeners = new Set<() => void>();

/**
 * Reads `environment` from `/health`. A network error, an error status, or a body that is
 * not JSON or has no non-blank string there all count as production, so a failed health
 * check can never put a marker on a production tab.
 */
async function fetchDeploymentEnvironment(): Promise<string | null> {
  try {
    const response = await api.system.health();
    if (!response.ok) {
      return null;
    }

    const body: unknown = await response.json();
    const environment = body && typeof body === 'object'
      ? (body as { environment?: unknown }).environment
      : null;
    return typeof environment === 'string' && environment.trim() ? environment.trim() : null;
  } catch {
    return null;
  }
}

/** The `useSyncExternalStore` subscriber; the first caller to mount starts the `/health` read. */
function subscribeToDeploymentEnvironment(onChange: () => void): () => void {
  deploymentEnvironmentListeners.add(onChange);
  deploymentEnvironmentRequest ??= fetchDeploymentEnvironment().then((environment) => {
    deploymentEnvironment = environment;
    // React re-renders only callers whose snapshot changed, and a production
    // answer leaves it at null, so production re-renders nothing here.
    deploymentEnvironmentListeners.forEach((listener) => listener());
  });

  return () => {
    deploymentEnvironmentListeners.delete(onChange);
  };
}

const getDeploymentEnvironmentSnapshot = (): string | null => deploymentEnvironment;

/**
 * The non-production deployment this server runs as, set by CLOUDCLI_DEPLOY_ENV and read
 * from `/health` (for example "staging"); null in production, until the answer arrives and
 * when it cannot be read. All callers share one request per page load, and a caller that
 * mounts after the answer gets it on its first render. Used by the DeploymentEnvironmentBadge
 * shared UI component, by ThemeProvider for the browser chrome colour, by
 * `useDeploymentEnvironmentTitle` and `useDeploymentEnvironmentFavicon`, and by run-notifications
 * for the label in front of a system notification's title.
 */
export function useDeploymentEnvironment(): string | null {
  return useSyncExternalStore(subscribeToDeploymentEnvironment, getDeploymentEnvironmentSnapshot);
}

/**
 * Keeps the deployment environment label, in the current language, at the start of the
 * browser tab title ("Stage · My session", "预发布 · My session"). Used once by App at the
 * root, so every screen gets the label, login and setup included; production never
 * changes the title.
 */
export function useDeploymentEnvironmentTitle(): void {
  const { t } = useTranslation('common');
  const environment = useDeploymentEnvironment();
  const environmentLabel = environment ? getDeploymentEnvironmentLabel(environment, t) : null;

  useEffect(() => {
    setDocumentTitleEnvironmentLabel(environmentLabel);
    return () => setDocumentTitleEnvironmentLabel(null);
  }, [environmentLabel]);
}

/**
 * The amber tab icons (the badge's colours) a non-production deployment shows, keyed by the
 * `type` of the index.html icon link each one replaces. Both files sit beside the production
 * icons in public/.
 */
const DEPLOYMENT_ENVIRONMENT_FAVICON_FILES: Partial<Record<string, string>> = {
  'image/svg+xml': 'favicon-stage.svg',
  'image/png': 'favicon-stage.png',
};

/**
 * The URL of an amber icon file beside the given production icon URL, or null when that URL is
 * not http(s): a data:, blob: or about: URL cannot be the base of a relative one, nor can an
 * href that does not parse. The swap runs above every error boundary, so it must skip such an
 * icon (inlined by the deployer, or rewritten by a browser extension) rather than throw.
 */
const resolveDeploymentEnvironmentFaviconHref = (stageFile: string, productionIconUrl: string): string | null => {
  try {
    const productionIcon = new URL(productionIconUrl);
    return productionIcon.protocol === 'http:' || productionIcon.protocol === 'https:'
      ? new URL(stageFile, productionIcon).href
      : null;
  } catch {
    return null;
  }
};

/**
 * Swaps the browser tab icon for the amber one while the deployment is not production, since
 * the label in the tab title cannot be coloured, and puts the production icon back on unmount.
 * Used once by App at the root, beside `useDeploymentEnvironmentTitle`; production never
 * touches the icons.
 */
export function useDeploymentEnvironmentFavicon(): void {
  const isNonProductionDeployment = useDeploymentEnvironment() !== null;

  useEffect(() => {
    if (!isNonProductionDeployment) {
      return undefined;
    }

    const swappedIcons = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'))
      .flatMap((iconLink) => {
        const stageFile = DEPLOYMENT_ENVIRONMENT_FAVICON_FILES[iconLink.type];
        const productionHref = iconLink.getAttribute('href');
        if (!stageFile || !productionHref) {
          return [];
        }

        // Resolved against the production icon rather than the site root, so the swap
        // also holds when the app is served from a sub-path.
        const stageHref = resolveDeploymentEnvironmentFaviconHref(stageFile, iconLink.href);
        if (!stageHref) {
          return [];
        }

        iconLink.setAttribute('href', stageHref);
        return [{ iconLink, productionHref }];
      });

    return () => {
      swappedIcons.forEach(({ iconLink, productionHref }) => iconLink.setAttribute('href', productionHref));
    };
  }, [isNonProductionDeployment]);
}
