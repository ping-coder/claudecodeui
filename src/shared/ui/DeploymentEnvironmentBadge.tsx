import { useTranslation } from 'react-i18next';

import { useDeploymentEnvironment } from '@/shared/hooks/useDeploymentEnvironment';
import { cn, getDeploymentEnvironmentLabel } from '@/shared/utils';

type DeploymentEnvironmentBadgeProps = {
  className?: string;
};

/**
 * Used by the sidebar module (beside the app name, and in the collapsed icon rail), the
 * project-workspace module (the mobile header, where the sidebar is a closed drawer) and the
 * auth module (on the login and setup card) to mark a non-production deployment with an
 * amber "STAGE" / "预发布" pill. Renders nothing in production.
 */
export function DeploymentEnvironmentBadge({ className }: DeploymentEnvironmentBadgeProps) {
  const { t } = useTranslation('common');
  const environment = useDeploymentEnvironment();
  if (!environment) {
    return null;
  }

  const label = getDeploymentEnvironmentLabel(environment, t);
  return (
    <span
      className={cn(
        // inline-block, not inline-flex: text-overflow only ellipsizes a block container.
        'inline-block max-w-full flex-shrink-0 truncate rounded-full bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none tracking-wide text-amber-950 ring-1 ring-inset ring-amber-600/40',
        className,
      )}
      title={t('deploymentEnvironment.badgeTooltip', { environment: label })}
    >
      {label}
    </span>
  );
}
