import { useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { PANE_TAB_DRAG_EFFECT } from '@/shared/constants';
import type { SessionDragPayload, WorkspacePaneSide } from '@/shared/types';
import { PaneSideGlyph } from '@/shared/ui';
import { cn, readSessionDragPayload } from '@/shared/utils';

type PaneDropOverlayProps = {
  /** One drop zone per side, left to right. */
  targets: readonly WorkspacePaneSide[];
  /** A right pane exists, so zones name a side; otherwise they read "here" and "on the right (split)". */
  isSplit: boolean;
  /** A conversation or tab was dropped on a zone; `copy` is the Alt key, which copies a dragged tab instead of moving it. */
  onDropSession: (side: WorkspacePaneSide, payload: SessionDragPayload, copy: boolean) => void;
};

/**
 * Rendered by WorkspacePane over its content while a conversation or a pane tab is dragged over
 * the workspace (never for files). It covers the composer, so a dropped link never lands in the
 * textarea, and offers one large zone per side.
 */
export default function PaneDropOverlay({ targets, isSplit, onDropSession }: PaneDropOverlayProps) {
  const { t } = useTranslation();
  // The zone under the pointer, highlighted so the user sees where the drop lands.
  const [hoveredSide, setHoveredSide] = useState<WorkspacePaneSide | null>(null);

  const getZoneLabel = (side: WorkspacePaneSide): string => {
    if (isSplit) {
      return side === 'left'
        ? t('workspace.dropLeft', { defaultValue: 'Open on the left' })
        : t('workspace.dropRight', { defaultValue: 'Open on the right' });
    }
    return side === 'right'
      ? t('workspace.dropRightSplit', { defaultValue: 'Open on the right (split)' })
      : t('workspace.dropHere', { defaultValue: 'Open here' });
  };

  const handleDragOver = (event: ReactDragEvent<HTMLDivElement>, side: WorkspacePaneSide) => {
    // Allows the drop. Tab drags (see PaneTabBar) say whether they move or, with Alt, copy.
    event.preventDefault();
    if (event.dataTransfer.effectAllowed === PANE_TAB_DRAG_EFFECT) {
      event.dataTransfer.dropEffect = event.altKey ? 'copy' : 'move';
    }
    setHoveredSide(side);
  };

  const handleDragLeave = (event: ReactDragEvent<HTMLDivElement>, side: WorkspacePaneSide) => {
    const nextTarget = event.relatedTarget as Node | null;
    if (nextTarget && event.currentTarget.contains(nextTarget)) {
      return;
    }
    setHoveredSide((current) => (current === side ? null : current));
  };

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>, side: WorkspacePaneSide) => {
    // Handled here: nothing underneath (the composer, react-dropzone on the document) may act on it.
    event.preventDefault();
    event.stopPropagation();
    setHoveredSide(null);
    const payload = readSessionDragPayload(event.dataTransfer);
    if (payload) {
      onDropSession(side, payload, event.altKey);
    }
  };

  return (
    <div data-pane-drop-overlay="" className="absolute inset-0 z-30 flex gap-2 bg-background/70 p-2">
      {targets.map((side) => (
        <div
          key={side}
          data-drop-zone={side}
          onDragEnter={(event) => handleDragOver(event, side)}
          onDragOver={(event) => handleDragOver(event, side)}
          onDragLeave={(event) => handleDragLeave(event, side)}
          onDrop={(event) => handleDrop(event, side)}
          className={cn(
            'flex min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-3 text-center text-sm font-medium transition-colors',
            hoveredSide === side ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground',
          )}
        >
          <PaneSideGlyph placement={side} className="h-6 w-6" />
          <span>{getZoneLabel(side)}</span>
        </div>
      ))}
    </div>
  );
}
