import { useState } from 'react';
import type { FocusEvent, MouseEvent } from 'react';
import type { TFunction } from 'i18next';

import { PaneSideGlyph, Tooltip } from '@/shared/ui';
import { visualPaneSide } from '@/shared/direction';
import { cn } from '@/shared/utils';
import type { SessionPanePlacement, WorkspacePaneSide } from '@/shared/types';

type SessionPaneButtonsProps = {
  /** Desktop, and the main area is split or wide enough to split; nothing renders otherwise. */
  canTargetSides: boolean;
  /** A right pane exists: both sides are offered instead of the one "open on the right (split view)". */
  isWorkspaceSplit: boolean;
  /** Where the session is open now; the button of each side it is on shows pressed. */
  panePlacement: SessionPanePlacement;
  onOpenInPane: (side: WorkspacePaneSide) => void;
  /** Where the buttons sit among the row's controls. */
  className?: string;
  t: TFunction;
};

type PanePlacementMarkerProps = {
  /** Drawn only while the workspace is split and the session is open on a side. */
  isWorkspaceSplit: boolean;
  panePlacement: SessionPanePlacement;
  t: TFunction;
};

/** Named after where the pane is drawn: right to left the first pane ('left') is on the right. */
const getSideLabel = (side: WorkspacePaneSide, isWorkspaceSplit: boolean, t: TFunction): string => {
  const isOnLeft = visualPaneSide(side) === 'left';
  if (side === 'left' || isWorkspaceSplit) {
    return isOnLeft
      ? t('sessions.openOnLeft', { defaultValue: 'Open on the left' })
      : t('sessions.openOnRight', { defaultValue: 'Open on the right' });
  }
  // Unsplit, the second pane is not there yet: opening there splits.
  return isOnLeft
    ? t('sessions.openOnLeftSplit', { defaultValue: 'Open on the left (split view)' })
    : t('sessions.openOnRightSplit', { defaultValue: 'Open on the right (split view)' });
};

/**
 * Rendered by SessionOptions left of a session row's "…" button: ◨ "open on the right
 * (split view)" while unsplit, ◧ ◨ once split, pressed for the side(s) the session is
 * already open on. Shown on hover or keyboard focus of the row only; touch screens use
 * the menu items and the sidebar's Open-in switch instead.
 */
export default function SessionPaneButtons({
  canTargetSides,
  isWorkspaceSplit,
  panePlacement,
  onOpenInPane,
  className,
  t,
}: SessionPaneButtonsProps) {
  // The side an Alt+click on the row would open on, i.e. the pane that is not focused,
  // so its tooltip alone carries the Alt+click hint. Read from the sidebar root when the
  // buttons are reached instead of passed in: a focus switch must not re-render the rows.
  const [altClickSide, setAltClickSide] = useState<WorkspacePaneSide>('right');

  if (!canTargetSides) {
    return null;
  }

  const readAltClickSide = (event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
    const focusedSide = event.currentTarget
      .closest<HTMLElement>('[data-focused-pane-side]')
      ?.getAttribute('data-focused-pane-side');
    setAltClickSide(isWorkspaceSplit && focusedSide === 'right' ? 'left' : 'right');
  };

  const sides: WorkspacePaneSide[] = isWorkspaceSplit ? ['left', 'right'] : ['right'];

  return (
    <div
      className={cn(
        // Invisible rather than only transparent, so the buttons cannot be clicked or tabbed to
        // until the row is hovered or keyboard-focused.
        'invisible flex items-center gap-0.5 opacity-0 transition-[opacity,visibility] duration-150',
        'group-hover:visible group-hover:opacity-100',
        // Keyboard focus only: a mouse click focuses the row's link too, and the buttons
        // would then stay over its time label and spinner after the pointer has left.
        'group-has-[:focus-visible]:visible group-has-[:focus-visible]:opacity-100',
        // Not on touch screens at all: a tap reveals hover content first, which iPad Safari
        // can take as the whole tap, and the menu offers the same sides there.
        '[@media(pointer:coarse)]:hidden',
        className,
      )}
      onMouseEnter={readAltClickSide}
      onFocus={readAltClickSide}
    >
      {sides.map((side) => {
        const label = getSideLabel(side, isWorkspaceSplit, t);
        const isPressed = isWorkspaceSplit && (panePlacement === side || panePlacement === 'both');

        return (
          <Tooltip
            key={side}
            position="top"
            content={side === altClickSide ? (
              <>
                <span className="block">{label}</span>
                <span className="block opacity-75">
                  {t('tooltips.altClickOtherSide', { defaultValue: 'You can also Alt+click' })}
                </span>
              </>
            ) : label}
          >
            <button
              type="button"
              aria-label={label}
              // A toggle only once there are two sides to be on; unsplit it is a plain action.
              aria-pressed={isWorkspaceSplit ? isPressed : undefined}
              data-pane-side={side}
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded-md border shadow-sm transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                isPressed
                  ? 'border-primary/40 bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'border-border/60 bg-background text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
              onClick={(event) => {
                // Same as the row's other controls: the click stays with the button.
                event.stopPropagation();
                onOpenInPane(side);
              }}
            >
              <PaneSideGlyph placement={side} className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

/**
 * Rendered by SidebarSessionItem and SidebarRecentConversations beside a row's provider
 * icon: which pane(s) show the session, readable without hovering. Only while split,
 * where "open" no longer says where.
 */
export function PanePlacementMarker({ isWorkspaceSplit, panePlacement, t }: PanePlacementMarkerProps) {
  if (!isWorkspaceSplit || !panePlacement) {
    return null;
  }

  // Named after where the pane is drawn, as the glyph beside it is.
  const label = panePlacement === 'both'
    ? t('tooltips.openedBoth', { defaultValue: 'Open in both panes' })
    : visualPaneSide(panePlacement) === 'left'
      ? t('tooltips.openedLeft', { defaultValue: 'Open in the left pane' })
      : t('tooltips.openedRight', { defaultValue: 'Open in the right pane' });

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-pane-placement={panePlacement}
      className="flex flex-shrink-0 items-center text-primary/80"
    >
      <PaneSideGlyph placement={panePlacement} className="h-3 w-3" />
    </span>
  );
}
