import React from 'react';

import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/shared/ui';
import { CollapsibleSection } from '@/modules/chat/tools/CollapsibleSection';

type CollapsibleDisplayProps = {
  toolName: string;
  toolId?: string;
  title: string;
  /** Extra classes for the title, e.g. `font-mono` for a file name that cannot be clicked. */
  titleClassName?: string;
  defaultOpen?: boolean;
  action?: React.ReactNode;
  badge?: React.ReactNode;
  onTitleClick?: () => void;
  children: React.ReactNode;
  showRawParameters?: boolean;
  rawContent?: string;
  className?: string;
  toolCategory?: string;
};

const borderColorMap: Record<string, string> = {
  edit: 'border-s-amber-500 dark:border-s-amber-400',
  search: 'border-s-muted-foreground/40',
  bash: 'border-s-green-500 dark:border-s-green-400',
  todo: 'border-s-violet-500 dark:border-s-violet-400',
  task: 'border-s-violet-500 dark:border-s-violet-400',
  agent: 'border-s-purple-500 dark:border-s-purple-400',
  plan: 'border-s-indigo-500 dark:border-s-indigo-400',
  question: 'border-s-blue-500 dark:border-s-blue-400',
  default: 'border-s-border',
};

/**
 * Rendered by chat's ToolRenderer for tools configured to show their input and
 * result inside an expandable, category-coloured section, and by BashEditDiff
 * for each file a Bash command changed, so those read like the Edit rows.
 */
export const CollapsibleDisplay: React.FC<CollapsibleDisplayProps> = ({
  toolName,
  title,
  titleClassName,
  defaultOpen = false,
  action,
  badge,
  onTitleClick,
  children,
  showRawParameters = false,
  rawContent,
  className = '',
  toolCategory,
}) => {
  const borderColor = borderColorMap[toolCategory || 'default'] || borderColorMap.default;

  return (
    <div className={`border-s-2 ${borderColor} my-1 py-0.5 ps-3 ${className}`}>
      <CollapsibleSection
        title={title}
        titleClassName={titleClassName}
        toolName={toolName}
        open={defaultOpen}
        action={action}
        badge={badge}
        onTitleClick={onTitleClick}
      >
        {children}

        {showRawParameters && rawContent && (
          <Collapsible className="mt-2">
            <CollapsibleTrigger className="flex items-center gap-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground">
              <svg
                className="rtl-mirror h-2.5 w-2.5 flex-shrink-0 transition-transform duration-150 data-[state=open]:rotate-90"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              raw params
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-1 overflow-hidden whitespace-pre-wrap break-words rounded border border-border/40 bg-muted p-2 font-mono text-[11px] text-muted-foreground">
                {rawContent}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CollapsibleSection>
    </div>
  );
};
