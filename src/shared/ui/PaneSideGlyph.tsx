import type { SessionPanePlacement } from '@/shared/types';
import { cn } from '@/shared/utils';

type PaneSideGlyphProps = {
  placement: SessionPanePlacement;
  className?: string;
};

/**
 * Two-cell picture of the split workspace with the cell(s) for `placement` filled: 'left',
 * 'right', 'both', or null for neither. Used by the sidebar module (row side buttons,
 * placement marker, Open-in switch) and the project-workspace module (collapsed pane
 * switcher, drop overlay, empty pane). Decorative: the control around it carries the label.
 */
export function PaneSideGlyph({ placement, className }: PaneSideGlyphProps) {
  const fillsLeft = placement === 'left' || placement === 'both';
  const fillsRight = placement === 'right' || placement === 'both';

  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      data-placement={placement ?? 'none'}
      className={cn('h-4 w-4 shrink-0', className)}
    >
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <line x1="8" y1="2.5" x2="8" y2="13.5" stroke="currentColor" strokeWidth="1.25" />
      {fillsLeft && <rect x="3" y="4" width="3.5" height="8" rx="0.75" fill="currentColor" />}
      {fillsRight && <rect x="9.5" y="4" width="3.5" height="8" rx="0.75" fill="currentColor" />}
    </svg>
  );
}
