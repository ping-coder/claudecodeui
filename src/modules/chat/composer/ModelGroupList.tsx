import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronRight } from "lucide-react";

import type { LLMProvider, ProviderModelOption } from "@/shared/types";
import { Badge, CommandGroup, CommandItem, LLMProviderLogo } from "@/shared/ui";
import { describeModelDescription, describeModelOption } from "@/modules/chat/utils/catalogLabels";

/**
 * One branch of the model picker.
 *
 * `provider` is what selecting a model in this branch sets, kept separate from
 * the branch itself so a branch does not have to be a provider.
 */
export type ModelGroup = {
  key: string;
  provider: LLMProvider;
  name: string;
  models: ProviderModelOption[];
};

type ModelGroupListProps = {
  groups: ModelGroup[];
  provider: LLMProvider;
  currentModel: string;
  loading: boolean;
  /** While searching, every branch is shown open — a hit inside a collapsed one would be invisible. */
  searching: boolean;
  onSelect: (provider: LLMProvider, model: string) => void;
  loadingLabel: string;
};

const STORAGE_KEY = "model-groups-collapsed";

function readCollapsed(): string[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed.filter((key) => typeof key === "string") : [];
  } catch {
    return [];
  }
}

export default function ModelGroupList({
  groups,
  provider,
  currentModel,
  loading,
  searching,
  onSelect,
  loadingLabel,
}: ModelGroupListProps) {
  const { t } = useTranslation("chat");
  const [collapsedKeys, setCollapsedKeys] = useState<string[]>(readCollapsed);
  const collapsed = useMemo(() => new Set(collapsedKeys), [collapsedKeys]);

  const toggle = useCallback((key: string) => {
    setCollapsedKeys((previous) => (previous.includes(key)
      ? previous.filter((entry) => entry !== key)
      : [...previous, key]));
  }, []);

  // Persisted from an effect, not from the updater: React may run an updater
  // more than once or throw its result away, and only committed state should
  // reach storage.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsedKeys));
    } catch {
      // A closed branch is a convenience; not being able to remember it is no reason to fail.
    }
  }, [collapsedKeys]);

  return (
    <>
      {groups.map((group, index) => {
        const isCollapsed = collapsed.has(group.key) && !searching;

        return (
          <CommandGroup
            key={group.key}
            className={
              index > 0
                ? "border-t border-border/40 [&_[cmdk-group-heading]]:mt-1 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                : "[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
            }
            heading={
              <button
                type="button"
                onClick={() => toggle(group.key)}
                className="flex w-full items-center gap-1.5 text-start hover:text-foreground"
                aria-expanded={!isCollapsed}
              >
                {isCollapsed ? (
                  <ChevronRight className="h-3 w-3 shrink-0" />
                ) : (
                  <ChevronDown className="h-3 w-3 shrink-0" />
                )}
                <LLMProviderLogo provider={group.provider} className="h-3.5 w-3.5 shrink-0" />
                {group.name}
                <span className="ms-auto text-[10px] font-normal normal-case tracking-normal text-muted-foreground">
                  {group.models.length}
                </span>
              </button>
            }
          >
            {group.models.length === 0 && loading ? (
              <CommandItem disabled className="ms-4 border-s border-border/40 ps-4 text-muted-foreground">
                {loadingLabel}
              </CommandItem>
            ) : null}

            {/*
              A collapsed branch still needs one item: cmdk hides a group whose
              items are all gone, and a vanished heading cannot be clicked open
              again. This row doubles as that click target.
            */}
            {isCollapsed && group.models.length > 0 ? (
              <CommandItem
                value={`${group.name} show`}
                onSelect={() => toggle(group.key)}
                className="ms-4 border-s border-border/40 ps-4 text-[11px] text-muted-foreground"
              >
                {t("providerSelection.hiddenModels", { count: group.models.length })}
              </CommandItem>
            ) : null}

            {!isCollapsed && group.models.map((model) => {
              const isSelected = provider === group.provider && currentModel === model.value;
              const label = describeModelOption(model, t);
              const description = describeModelDescription(model, t);

              return (
                <CommandItem
                  key={`${group.key}-${model.value}`}
                  // The shown name and description, and the catalog's own, so a search finds the model by any of them.
                  value={`${group.name} ${label === model.label ? label : `${label} ${model.label}`} ${description === model.description ? description || "" : `${description} ${model.description}`}`}
                  onSelect={() => onSelect(group.provider, model.value)}
                  className="ms-4 border-s border-border/40 ps-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{label}</span>
                      {model.isCustom && (
                        <Badge className="h-4 shrink-0 rounded-full px-1.5 text-[8px]">{t("modelLibrary.customBadge")}</Badge>
                      )}
                    </div>
                    {model.label !== model.value && (
                      <div className="truncate font-mono text-[10px] text-muted-foreground">
                        {model.value}
                      </div>
                    )}
                  </div>
                  {isSelected && <Check className="ms-auto h-4 w-4 shrink-0 text-primary" />}
                </CommandItem>
              );
            })}
          </CommandGroup>
        );
      })}
    </>
  );
}
