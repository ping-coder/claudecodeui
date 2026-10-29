import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { isRtl } from '@/shared/direction';
import { cn } from '@/shared/utils';

/** Gap kept between the menu and the viewport edges. */
const VIEWPORT_MARGIN_PX = 8;

type PaneTabMenuItem = {
  key: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Draws a separator above the entry. */
  separatorBefore?: boolean;
  /** The key that does the same on a focused tab (F2 renames), shown dimmed at the right and announced as aria-keyshortcuts. */
  shortcut?: string;
};

type PaneTabContextMenuProps = {
  /** Viewport point the menu opens at: the cursor, or the tab's lower-left corner for Shift+F10. */
  anchor: { x: number; y: number };
  /** Accessible name of the menu. */
  label: string;
  items: PaneTabMenuItem[];
  /** Closes the menu. `restoreFocus` is false when the user clicked elsewhere, so focus stays where they clicked. */
  onClose: (restoreFocus: boolean) => void;
};

const getEnabledItems = (menu: HTMLElement | null): HTMLButtonElement[] =>
  Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []);

/**
 * Rendered by PaneTabBar for a tab's right-click (or Shift+F10 / Menu key) menu. It owns Escape while
 * open: the key is taken on window capture with preventDefault + stopPropagation and the menu carries
 * data-escape-layer, so neither the chat's abort nor the workspace shortcuts react to it.
 */
export default function PaneTabContextMenu({ anchor, label, items, onClose }: PaneTabContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  // Where the menu sits once measured: the anchor, pulled back inside the viewport.
  const [position, setPosition] = useState(anchor);
  // Latest onClose for the document listeners, which are installed once.
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) {
      return;
    }
    const { width, height } = menu.getBoundingClientRect();
    // Right to left the menu opens leftwards from the anchor (the pointer, or the tab's right edge).
    const startX = isRtl(menu) ? anchor.x - width : anchor.x;
    setPosition({
      x: Math.max(VIEWPORT_MARGIN_PX, Math.min(startX, window.innerWidth - width - VIEWPORT_MARGIN_PX)),
      y: Math.max(VIEWPORT_MARGIN_PX, Math.min(anchor.y, window.innerHeight - height - VIEWPORT_MARGIN_PX)),
    });
    getEnabledItems(menu)[0]?.focus();
  }, [anchor]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current(true);
    };
    const handlePointerDown = (event: PointerEvent | MouseEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) {
        return;
      }
      onCloseRef.current(false);
    };
    const handleViewportChange = () => onCloseRef.current(false);

    window.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('pointerdown', handlePointerDown, true);
    // jsdom and some older webviews send no pointer events; a mousedown closes it there.
    document.addEventListener('mousedown', handlePointerDown, true);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('blur', handleViewportChange);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('mousedown', handlePointerDown, true);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('blur', handleViewportChange);
    };
  }, []);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const enabledItems = getEnabledItems(menuRef.current);
    if (enabledItems.length === 0) {
      return;
    }
    const currentIndex = enabledItems.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % enabledItems.length;
    } else if (event.key === 'ArrowUp') {
      nextIndex = currentIndex <= 0 ? enabledItems.length - 1 : currentIndex - 1;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = enabledItems.length - 1;
    } else if (event.key === 'Tab') {
      // A menu is not part of the tab order: leaving it closes it.
      event.preventDefault();
      onClose(true);
      return;
    }
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    enabledItems[nextIndex]?.focus();
  };

  const runItem = (item: PaneTabMenuItem) => {
    if (item.disabled) {
      return;
    }
    onClose(true);
    item.onSelect();
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      data-escape-layer=""
      tabIndex={-1}
      onKeyDown={handleMenuKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      className="fixed z-[70] min-w-52 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{ left: position.x, top: position.y }}
    >
      {items.map((item) => (
        <Fragment key={item.key}>
          {item.separatorBefore && <div role="separator" className="mx-2 my-1 h-px bg-border" />}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            aria-keyshortcuts={item.shortcut}
            onClick={() => runItem(item)}
            className={cn(
              'flex w-full items-center rounded-md px-3 py-1.5 text-start text-sm transition-colors focus:outline-none focus-visible:bg-accent',
              item.disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-accent',
            )}
          >
            {item.label}
            {item.shortcut && <span aria-hidden="true" className="ms-auto ps-6 text-xs text-muted-foreground">{item.shortcut}</span>}
          </button>
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}
