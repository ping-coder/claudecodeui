import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useSessionTitleRename } from '@/modules/project-workspace/hooks/useSessionTitleRename';
import { readWorkspaceShortcut } from '@/modules/project-workspace/hooks/useWorkspaceShortcuts';

/** Gap kept between the box and the viewport edges. */
const VIEWPORT_MARGIN_PX = 8;
/** The box sits this far inside the tab's top and bottom edges. */
const TAB_INSET_PX = 4;
/** The narrowest box, in rem, so a short tab still leaves room to type a title. */
const MIN_BOX_WIDTH_REM = 20;
/** Root font size assumed when the computed one cannot be read. */
const DEFAULT_ROOT_FONT_SIZE_PX = 16;

/** Where the box sits, in viewport pixels. */
type RenameBoxRect = { left: number; top: number; width: number; height: number };

type PaneTabRenameInputProps = {
  /** DOM id of the tab the box covers. */
  tabElementId: string;
  sessionId: string;
  /** The tab's live title: the draft starts from it, and an unchanged draft saves nothing. */
  title: string;
  /** Persists a new title for a session; resolves false when the backend refuses it. */
  onRenameSession: (sessionId: string, summary: string) => Promise<boolean>;
  /** The edit ended. `restoreFocus` is true after Enter, Tab or Escape, false after a click away (focus stays there). */
  onClose: (restoreFocus: boolean) => void;
};

/** Covers the tab less the insets, at least MIN_BOX_WIDTH_REM wide, kept inside the viewport. */
const measureRenameBox = (tab: HTMLElement): RenameBoxRect => {
  const tabRect = tab.getBoundingClientRect();
  const rootFontSize = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || DEFAULT_ROOT_FONT_SIZE_PX;
  const width = Math.min(
    Math.max(tabRect.width, MIN_BOX_WIDTH_REM * rootFontSize),
    window.innerWidth - VIEWPORT_MARGIN_PX * 2,
  );
  return {
    left: Math.max(VIEWPORT_MARGIN_PX, Math.min(tabRect.left, window.innerWidth - width - VIEWPORT_MARGIN_PX)),
    top: tabRect.top + TAB_INSET_PX,
    width,
    height: Math.max(tabRect.height - TAB_INSET_PX * 2, 0),
  };
};

const isSameRect = (a: RenameBoxRect, b: RenameBoxRect): boolean => (
  a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height
);

/**
 * Rendered by PaneTabBar over the session tab being renamed. The box is portalled to the body, outside
 * the tablist, so the tab's click, drag, middle-click, right-click and key handlers never see its events,
 * and it carries data-escape-layer, so Escape cancels the edit without also stopping the chat's run or
 * reaching the workspace shortcuts. It edits like the header title (useSessionTitleRename): Enter saves,
 * Escape or a click away cancels, with two differences. The full-screen shortcut (Mod+Shift+Enter) does
 * nothing, so reaching for it cannot save a half-typed title; every other Enter saves, modifiers or not.
 * Tab and Shift+Tab save too: the box sits at the end of the body, so the browser would move the focus
 * out of the page or far from the tab.
 */
export default function PaneTabRenameInput({ tabElementId, sessionId, title, onRenameSession, onClose }: PaneTabRenameInputProps) {
  const { t } = useTranslation();
  const {
    isEditing,
    draft,
    isSaving,
    inputRef,
    startEditing,
    updateDraft,
    cancelEditing,
    saveDraft,
    handleInputKeyDown,
  } = useSessionTitleRename({ sessionId, currentTitle: title, onRenameSession });
  // The box's place over the tab: the input renders only once it is known, and it follows the tab when
  // the window resizes or the strip scrolls.
  const [boxRect, setBoxRect] = useState<RenameBoxRect | null>(null);
  // The draft opens once, on mount; the hook's startEditing changes with the live title.
  const hasStartedRef = useRef(false);
  // isEditing is false before the draft opens too: only a change from open to closed ends the edit.
  const hasOpenedRef = useRef(false);
  // Enter or Tab (a save) or Escape ended the edit, so the tab takes the focus back.
  const endedByKeyRef = useRef(false);
  // Latest onClose, so the effect that reports the end runs when editing stops, not on every render.
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  /** Measures the tab; false when it is no longer on the page. */
  const reposition = useCallback((): boolean => {
    const tab = document.getElementById(tabElementId);
    if (!tab) {
      return false;
    }
    const nextRect = measureRenameBox(tab);
    setBoxRect((current) => (current && isSameRect(current, nextRect) ? current : nextRect));
    return true;
  }, [tabElementId]);

  // Measure and open the draft in one pass before paint: the input mounts in place, where the hook's
  // focus effect finds it and selects the title.
  useLayoutEffect(() => {
    if (hasStartedRef.current) {
      return;
    }
    hasStartedRef.current = true;
    // The strip may have scrolled the tab out of sight (the pane menu renames the active tab wherever
    // the strip is): bring it back first, at once rather than smoothly, so the box opens over it.
    // jsdom has no scrollIntoView.
    document.getElementById(tabElementId)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (!reposition()) {
      onCloseRef.current(false);
      return;
    }
    startEditing();
  }, [reposition, startEditing, tabElementId]);

  useEffect(() => {
    const handleResize = () => {
      reposition();
    };
    const handleScroll = (event: Event) => {
      // Only a scroll that can move the tab (the strip's own, the page's): a chat streaming below
      // scrolls all the time and must not measure the tab on every frame.
      const tab = document.getElementById(tabElementId);
      if (tab && event.target instanceof Node && event.target.contains(tab)) {
        reposition();
      }
    };
    window.addEventListener('resize', handleResize);
    // Scroll events do not bubble: the capture phase on window also hears the tab strip scroll.
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [reposition, tabElementId]);

  useEffect(() => {
    if (isEditing) {
      hasOpenedRef.current = true;
      return;
    }
    if (hasOpenedRef.current) {
      hasOpenedRef.current = false;
      onCloseRef.current(endedByKeyRef.current);
    }
  }, [isEditing]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const isComposing = event.nativeEvent.isComposing;
    if (event.key === 'Enter' && !isComposing && readWorkspaceShortcut(event.nativeEvent) === 'toggleImmersive') {
      // The full-screen chord, which the workspace leaves to the open box, does nothing. The workspace's
      // own matcher picks it out, so every other Enter still saves: Shift held over from typing a capital,
      // Ctrl, Alt, or the chord plus another modifier.
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === 'Tab' && !isComposing) {
      // Tab and Shift+Tab save like Enter instead of moving the focus away; the tab takes it back once
      // the save settles.
      event.preventDefault();
      event.stopPropagation();
      endedByKeyRef.current = true;
      void saveDraft();
      return;
    }
    // Either key ends the edit, the Enter once its save settles; an Enter that only confirms an IME
    // candidate is not a save and keeps editing.
    if (event.key === 'Escape' || (event.key === 'Enter' && !isComposing)) {
      endedByKeyRef.current = true;
    }
    handleInputKeyDown(event);
  };

  if (!isEditing || !boxRect) {
    return null;
  }

  return createPortal(
    <input
      ref={inputRef}
      type="text"
      value={draft}
      onChange={(event) => updateDraft(event.target.value)}
      onKeyDown={handleKeyDown}
      // Clicking anywhere else cancels, as the header title's and the sidebar's renames do.
      onBlur={cancelEditing}
      readOnly={isSaving}
      aria-busy={isSaving}
      aria-label={t('mainContent.renameSessionLabel', { defaultValue: 'Session title' })}
      // Blur cancels, so a touch keyboard needs a key that commits.
      enterKeyHint="done"
      data-escape-layer=""
      className="fixed z-[60] rounded-md border border-primary/60 bg-background px-2 text-sm text-foreground shadow-md outline-none"
      style={boxRect}
    />,
    document.body,
  );
}
