import type { ReactNode, Ref } from 'react';
import { Check } from 'lucide-react';

import { cn } from '@/shared/utils';
import type { ComposerMenuAnchor } from '@/shared/types';

/**
 * Shared shell for the composer popovers (model/effort, permissions,
 * scheduling and the send button's Insert/Queue menu) so every menu shares one
 * surface, one heading style and one row style.
 *
 * Used by chat's ComposerModelMenu, ComposerPermissionMenu, ScheduleMessagePopover and BusySendMenu.
 */
export function ComposerMenuSurface({
  anchor,
  menuRef,
  ariaLabel,
  children,
}: {
  anchor: ComposerMenuAnchor;
  menuRef: Ref<HTMLDivElement>;
  ariaLabel: string;
  children: ReactNode;
}) {
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      className="fixed z-[100] min-w-48 overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl"
      style={{
        right: anchor.right,
        left: anchor.left,
        bottom: anchor.bottom,
        maxHeight: anchor.maxHeight,
        maxWidth: anchor.maxWidth,
      }}
    >
      {children}
    </div>
  );
}

/** Used by chat's ComposerModelMenu, ComposerPermissionMenu, ScheduleMessagePopover and BusySendMenu to label a section of the popover. */
export function ComposerMenuHeading({ children }: { children: ReactNode }) {
  return (
    <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">{children}</p>
  );
}

/** Used by chat's ComposerModelMenu and ScheduleMessagePopover to divide the sections of a popover. */
export function ComposerMenuSeparator() {
  return <div className="my-1 h-px bg-border" aria-hidden />;
}

/**
 * Used by chat's ComposerModelMenu, ComposerPermissionMenu,
 * ScheduleMessagePopover and BusySendMenu to render one selectable row with
 * its checked state.
 *
 * `menuitemradio` rows pick one value of a group, `menuitemcheckbox` rows flip
 * an independent on/off option, and plain `menuitem` rows act without a
 * checked state. A `trailing` element replaces the default check mark, e.g.
 * with a chevron or a switch. A `disabled` row is dimmed and ignores clicks
 * but stays focusable and hoverable, so its `title` and description can say
 * why it is off.
 */
export function ComposerMenuItem({
  label,
  description,
  icon,
  isSelected,
  onSelect,
  role = 'menuitemradio',
  trailing,
  className,
  disabled = false,
  title,
}: {
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  isSelected: boolean;
  onSelect: () => void;
  role?: 'menuitemradio' | 'menuitemcheckbox' | 'menuitem';
  trailing?: ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === 'menuitem' ? undefined : isSelected}
      aria-disabled={disabled || undefined}
      title={title}
      onClick={disabled ? undefined : onSelect}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-start text-sm transition-colors',
        'hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
        isSelected ? 'text-foreground' : 'text-foreground/90',
        disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
        className,
      )}
    >
      {icon && <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate leading-5">{label}</span>
        {description && (
          <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{description}</span>
        )}
      </span>
      {/* min-w rather than w so a trailing control wider than the check mark (a switch) is not clipped. */}
      <span className="mt-0.5 flex h-4 min-w-4 shrink-0 items-center justify-center">
        {trailing ?? (isSelected ? <Check className="h-3.5 w-3.5 text-foreground" /> : null)}
      </span>
    </button>
  );
}
