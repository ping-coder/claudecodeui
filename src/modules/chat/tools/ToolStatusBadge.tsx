import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';
import type { ToolStatus } from '@/shared/types';


const STATUS_CONFIG: Record<ToolStatus, { labelKey: string; className: string }> = {
  running: {
    labelKey: 'tools.status.running',
    className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  },
  completed: {
    labelKey: 'tools.status.completed',
    className: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  },
  error: {
    labelKey: 'tools.status.error',
    className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  },
  denied: {
    labelKey: 'tools.status.denied',
    className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  },
};

type ToolStatusBadgeProps = {
  status: ToolStatus;
  className?: string;
};

/**
 * Used by chat's ToolRenderer, BashCommandDisplay and OneLineDisplay to label a
 * tool call's pending, running, error or denied state.
 */
export function ToolStatusBadge({ status, className }: ToolStatusBadgeProps) {
  const { t } = useTranslation('chat');
  const config = STATUS_CONFIG[status];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-px text-[10px] font-medium',
        config.className,
        className,
      )}
    >
      {t(config.labelKey)}
    </span>
  );
}
