import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Workflow } from 'lucide-react';

import type { ProviderModelOption } from '@/shared/types';
import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import { cn } from '@/shared/utils';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import { formatAnsweringModelLabel } from '@/modules/chat/utils/modelLabel';
import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSeparator,
  ComposerMenuSurface,
} from '@/modules/chat/composer/ComposerMenuPrimitives';

type EffortOption = NonNullable<ProviderModelOption['effort']>['values'][number];

type ComposerModelMenuProps = {
  effort: string;
  /** Effort values the active provider/model actually accepts; empty hides the section. */
  effortOptions: EffortOption[];
  onSelectEffort: (effort: string) => void;
  model: string;
  /** Model catalog for the active provider; empty hides the section. */
  modelOptions: ProviderModelOption[];
  onSelectModel: (model: string) => void;
  modelsLoading: boolean;
  /**
   * Whether ultracode (standing workflow orchestration, independent of the
   * effort level) is on for the next turn; `null` when the active model cannot
   * run it, which hides the control.
   */
  ultracode: boolean | null;
  onToggleUltracode: (ultracode: boolean) => void;
};

/**
 * Compact, purely visual switch for the Ultracode row, in the settings
 * toggle's colours. The row itself carries the checked state for assistive
 * tech, so this stays hidden from it.
 */
function UltracodeSwitchIndicator({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors duration-200',
        checked ? 'border-primary bg-primary' : 'border-border bg-muted',
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block h-3 w-3 rounded-full shadow-sm transition-transform duration-200',
          checked ? 'translate-x-[13px] bg-white' : 'translate-x-px bg-foreground/60 dark:bg-foreground/80',
        )}
      />
    </span>
  );
}

/**
 * Rendered by chat's ChatComposer as the popover for choosing the active
 * provider's model, reasoning effort and ultracode switch for the next turn.
 */
function ComposerModelMenu({
  effort,
  effortOptions,
  onSelectEffort,
  model,
  modelOptions,
  onSelectModel,
  modelsLoading,
  ultracode,
  onToggleUltracode,
}: ComposerModelMenuProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const [isModelSectionOpen, setIsModelSectionOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close);

  // The model list starts collapsed every time the menu opens, the way Codex
  // shows reasoning first and keeps the longer model list one click away.
  useEffect(() => {
    if (!isOpen) {
      setIsModelSectionOpen(false);
    }
  }, [isOpen]);

  const defaultEffortLabel = t('composer.effortDefault', { defaultValue: 'Default' });
  const resolvedEffortOptions = useMemo<EffortOption[]>(
    () => (effortOptions.length > 0 ? [{ value: DEFAULT_EFFORT_VALUE }, ...effortOptions] : []),
    [effortOptions],
  );
  const effortLabel = effort === DEFAULT_EFFORT_VALUE ? defaultEffortLabel : effort;

  const selectedModelOption = useMemo(
    () => modelOptions.find((option) => option.value === model) ?? null,
    [model, modelOptions],
  );
  // A model missing from the catalog (an external session reporting a raw id
  // such as `claude-opus-5-5`) is named the way replies name it.
  const modelLabel = selectedModelOption?.label || formatAnsweringModelLabel(model) || model;

  const hasEffortSection = resolvedEffortOptions.length > 0;
  const hasModelSection = modelOptions.length > 0 || modelsLoading;
  const hasUltracodeControl = ultracode !== null;
  if (!hasEffortSection && !hasModelSection && !hasUltracodeControl) {
    return null;
  }

  const ultracodeLabel = t('composer.ultracode', { defaultValue: 'Ultracode' });
  const triggerLabel = hasModelSection ? modelLabel : hasEffortSection ? effortLabel : ultracodeLabel;
  const ariaLabel = t('composer.modelMenu', {
    defaultValue: 'Select model and reasoning effort',
  });
  // The trigger marks ultracode only visually (its colour, icon and badge are
  // hidden from assistive technology), so its name says it too.
  const triggerAriaLabel = ultracode
    ? `${ariaLabel} (${t('composer.ultracodeOn', { defaultValue: 'Ultracode on' })})`
    : ariaLabel;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        className={cn(
          'flex h-8 shrink-0 items-center gap-1 rounded-lg border px-2 text-xs font-medium text-foreground transition-colors',
          // With ultracode on, the whole chip turns the workflow cards' purple,
          // and from sm up a badge names the mode, so it reads at a glance
          // without opening the menu. On phones the chip keeps the width it
          // had (the icon gets its own room instead of eating the label's), so
          // turning ultracode on never moves the composer's controls onto a
          // second row.
          ultracode
            ? 'max-w-24 border-purple-500/50 bg-purple-500/10 hover:bg-purple-500/15 sm:max-w-72 dark:border-purple-400/50'
            : 'max-w-20 border-border/60 bg-muted/40 hover:bg-muted sm:max-w-56',
        )}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={triggerAriaLabel}
        title={triggerAriaLabel}
      >
        {ultracode && (
          <Workflow aria-hidden className="h-3.5 w-3.5 shrink-0 text-purple-600 dark:text-purple-300" />
        )}
        <span className="truncate">{triggerLabel}</span>
        {hasModelSection && hasEffortSection && effort !== DEFAULT_EFFORT_VALUE && (
          <span className="hidden shrink-0 capitalize text-muted-foreground sm:inline">· {effortLabel}</span>
        )}
        {ultracode && (
          <span
            data-testid="composer-ultracode-indicator"
            aria-hidden
            className="hidden shrink-0 rounded bg-purple-600 px-1 py-px text-[10px] font-semibold uppercase leading-4 tracking-wide text-white dark:bg-purple-500 sm:inline-block"
          >
            {ultracodeLabel}
          </span>
        )}
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={ariaLabel}>
          {hasEffortSection && (
            <>
              <ComposerMenuHeading>
                {t('composer.reasoning', { defaultValue: 'Reasoning' })}
              </ComposerMenuHeading>
              {resolvedEffortOptions.map((option) => (
                <ComposerMenuItem
                  key={option.value}
                  label={option.value === DEFAULT_EFFORT_VALUE ? defaultEffortLabel : option.value}
                  description={option.description}
                  isSelected={option.value === effort}
                  onSelect={() => {
                    onSelectEffort(option.value);
                    setIsOpen(false);
                  }}
                  className="capitalize"
                />
              ))}
            </>
          )}

          {hasUltracodeControl && (
            <>
              {hasEffortSection && <ComposerMenuSeparator />}
              {/* Independent of the effort level, so toggling it leaves the
                  menu open for the user to pick an effort as well. */}
              <ComposerMenuItem
                role="menuitemcheckbox"
                label={ultracodeLabel}
                description={t('composer.ultracodeDescription', {
                  defaultValue: 'Workflow orchestration at any reasoning level',
                })}
                isSelected={ultracode}
                onSelect={() => onToggleUltracode(!ultracode)}
                trailing={<UltracodeSwitchIndicator checked={ultracode} />}
              />
            </>
          )}

          {hasModelSection && (
            <>
              {(hasEffortSection || hasUltracodeControl) && <ComposerMenuSeparator />}
              <ComposerMenuItem
                role="menuitem"
                label={modelLabel}
                isSelected={false}
                onSelect={() => setIsModelSectionOpen((current) => !current)}
                trailing={
                  isModelSectionOpen
                    ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                }
                className="text-muted-foreground"
              />

              {isModelSectionOpen && (
                <>
                  <ComposerMenuHeading>
                    {t('composer.model', { defaultValue: 'Model' })}
                  </ComposerMenuHeading>
                  {modelOptions.length === 0 && modelsLoading && (
                    <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
                      {t('composer.loadingModels', { defaultValue: 'Loading models…' })}
                    </p>
                  )}
                  {modelOptions.map((option) => (
                    <ComposerMenuItem
                      key={option.value}
                      label={option.label || option.value}
                      isSelected={option.value === model}
                      onSelect={() => {
                        onSelectModel(option.value);
                        setIsOpen(false);
                      }}
                    />
                  ))}
                </>
              )}
            </>
          )}
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}

/** Memoized: the composer re-renders on every keystroke and none of this menu's props change while typing. */
export default memo(ComposerModelMenu);
