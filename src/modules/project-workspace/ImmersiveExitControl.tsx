import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Menu, Minimize2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useMobileMenuHandlers } from '@/modules/project-workspace/hooks/useMobileMenuHandlers';
import { cn } from '@/shared/utils';

/** How long the capsule stays fully opaque after it appears or is touched. */
const FADE_DELAY_MS = 3000;

type ImmersiveExitControlProps = {
  /** Opens the sidebar drawer, as the hidden header's menu button does. */
  onOpenMenu: () => void;
  /** Leaves immersive mode, and the browser fullscreen with it. */
  onExit: () => void;
};

/**
 * Rendered by ProjectWorkspaceShell on phones in immersive mode, where the header is hidden: a
 * floating [menu][exit] capsule in the top-right corner, clear of the safe area. It fades after a
 * few seconds so it does not cover the conversation, and a touch brings it back.
 */
function ImmersiveExitControl({ onOpenMenu, onExit }: ImmersiveExitControlProps) {
  const { t } = useTranslation('common');
  const { handleMobileMenuClick, handleMobileMenuTouchEnd } = useMobileMenuHandlers(onOpenMenu);
  // Whether the capsule has been left alone long enough to fade; it stays findable at 40% opacity
  // without hiding the transcript under it.
  const [isFaded, setIsFaded] = useState(false);
  const fadeTimerRef = useRef<number | null>(null);

  const restartFadeTimer = useCallback(() => {
    if (fadeTimerRef.current !== null) {
      window.clearTimeout(fadeTimerRef.current);
    }
    fadeTimerRef.current = window.setTimeout(() => {
      fadeTimerRef.current = null;
      setIsFaded(true);
    }, FADE_DELAY_MS);
  }, []);

  useEffect(() => {
    restartFadeTimer();
    return () => {
      if (fadeTimerRef.current !== null) {
        window.clearTimeout(fadeTimerRef.current);
      }
    };
  }, [restartFadeTimer]);

  // Seen in the capture phase, so a touch counts wherever it lands on the capsule, buttons included.
  const handlePointerDownCapture = useCallback(() => {
    setIsFaded(false);
    restartFadeTimer();
  }, [restartFadeTimer]);

  return (
    <div
      onPointerDownCapture={handlePointerDownCapture}
      className={cn(
        'fixed z-40 flex items-center gap-0.5 rounded-full border border-border/60 bg-background/90 p-1 shadow-lg backdrop-blur-sm transition-opacity duration-300 has-[:focus-visible]:opacity-100 motion-reduce:transition-none',
        isFaded ? 'opacity-40' : 'opacity-100',
      )}
      style={{
        top: 'calc(env(safe-area-inset-top, 0px) + 0.5rem)',
        right: 'calc(env(safe-area-inset-right, 0px) + 0.5rem)',
      }}
    >
      <button
        type="button"
        onClick={handleMobileMenuClick}
        onTouchEnd={handleMobileMenuTouchEnd}
        aria-label={t('workspace.showSidebar', { defaultValue: 'Show sidebar' })}
        className="flex h-9 w-9 touch-manipulation items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Menu className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onExit}
        aria-label={t('workspace.exitFullscreen', { defaultValue: 'Exit full screen' })}
        className="flex h-9 w-9 touch-manipulation items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Minimize2 className="h-4 w-4" />
      </button>
    </div>
  );
}

export default memo(ImmersiveExitControl);
