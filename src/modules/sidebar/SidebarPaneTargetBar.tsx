import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { TFunction } from 'i18next';

import { PaneSideGlyph } from '@/shared/ui';
import { cn } from '@/shared/utils';
import { WORKSPACE_PANE_SIDES } from '@/shared/constants';
import type { SidebarPaneTargeting, WorkspacePaneSide } from '@/shared/types';

type SidebarPaneTargetBarProps = {
  paneTargeting: SidebarPaneTargeting | null | undefined;
  t: TFunction;
};

/**
 * Rendered by SidebarContent above the Projects, Conversations and Running lists while the
 * workspace is split: "Open in: Left | Right". Choosing a side focuses that pane, which is
 * where a plain click on a row lands, so touch users pick a side without hover or modifiers.
 * On phones it doubles as the pane switcher.
 */
export default function SidebarPaneTargetBar({ paneTargeting, t }: SidebarPaneTargetBarProps) {
  const radioRefs = useRef<Partial<Record<WorkspacePaneSide, HTMLButtonElement | null>>>({});

  if (!paneTargeting?.isSplit) {
    return null;
  }

  const { focusedSide, onFocusSide } = paneTargeting;
  const label = t('paneTarget.label', { defaultValue: 'Open in' });

  const selectSide = (side: WorkspacePaneSide) => {
    if (side !== focusedSide) {
      onFocusSide(side);
    }
  };

  // Radio-group keys: the arrows move the choice and the focus together.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const side: WorkspacePaneSide | null = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
      ? 'left'
      : event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 'right'
        : null;
    if (!side) {
      return;
    }
    event.preventDefault();
    selectSide(side);
    radioRefs.current[side]?.focus();
  };

  return (
    <div className="flex items-center gap-2 px-3 pb-2 pt-1">
      <span className="flex-shrink-0 text-[11px] font-medium text-muted-foreground">{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex min-w-0 flex-1 items-center gap-0.5 rounded-lg bg-muted/60 p-0.5"
        onKeyDown={handleKeyDown}
      >
        {WORKSPACE_PANE_SIDES.map((side) => {
          const isChecked = side === focusedSide;
          return (
            <button
              key={side}
              ref={(element) => {
                radioRefs.current[side] = element;
              }}
              type="button"
              role="radio"
              aria-checked={isChecked}
              // Roving focus: Tab reaches the chosen side, the arrows the other one.
              tabIndex={isChecked ? 0 : -1}
              className={cn(
                'flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-xs transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                isChecked
                  ? 'bg-background font-medium text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => selectSide(side)}
            >
              <PaneSideGlyph placement={side} className="h-3.5 w-3.5" />
              <span className="truncate">
                {side === 'left'
                  ? t('paneTarget.left', { defaultValue: 'Left' })
                  : t('paneTarget.right', { defaultValue: 'Right' })}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
