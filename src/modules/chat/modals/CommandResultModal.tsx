import { memo, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  Activity,
  BadgeCheck,
  CircleHelp,
  Coins,
  Cpu,
  Gauge,
  Package,
  Plus,
  Search,
  Server,
  Sparkles,
  TerminalSquare,
  Timer,
  Loader2,
  X,
} from 'lucide-react';

import { Badge, Button, Dialog, DialogContent, DialogTitle, Input } from '@/shared/ui';
import { IsolateFreeCode } from '@/shared/ui/IsolateFreeCode';
import type {
  LLMProvider,
  ProviderModelActions,
  ProviderModelOption,
  ProviderModelsDefinition,CommandModalPayload,CostCommandData,HelpCommandData,ModelCommandData,StatusCommandData
} from '@/shared/types';
import ModelLibraryPanel from '@/modules/chat/modals/ModelLibraryPanel';
import { describeCommandType, describeModelDescription, describeModelOption, describeSlashCommand } from '@/modules/chat/utils/catalogLabels';

type CommandResultModalProps = {
  payload: CommandModalPayload | null;
  onClose: () => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelActions: ProviderModelActions;
  activeProvider: LLMProvider;
  activeProviderModel: string;
  currentSessionId: string | null;
  onSelectProviderModel: (
    provider: LLMProvider,
    model: string,
    sessionId?: string | null,
  ) => Promise<{
    scope: 'default' | 'session';
    model: string;
  }>;
};

type CommandEntry = {
  name: string;
  description?: string;
  descriptionKey?: string;
  namespace?: string;
};

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  opencode: 'OpenCode',
  agy: 'Antigravity',
};

const FALLBACK_COMMANDS: CommandEntry[] = [
  { name: '/models', descriptionKey: 'chat:misc.fallbackCommands.models' },
  { name: '/cost', descriptionKey: 'chat:misc.fallbackCommands.cost' },
  { name: '/status', descriptionKey: 'chat:misc.fallbackCommands.status' },
  { name: '/memory', descriptionKey: 'chat:misc.fallbackCommands.memory' },
  { name: '/config', descriptionKey: 'chat:misc.fallbackCommands.config' },
  { name: '/help', descriptionKey: 'chat:misc.fallbackCommands.help' },
];

/** A provider by its product name; `unknown` when the server names none. */
const getProviderLabel = (provider: string | undefined, unknown: string) => {
  if (!provider) {
    return unknown;
  }

  return PROVIDER_LABELS[provider] || provider;
};

/** The server's uptime ("2h 5m", "5m") in the interface language; any other shape as the server words it. */
const formatUptime = (uptime: string, t: TFunction): string => {
  const match = /^(?:(\d+)h )?(\d+)m$/.exec(uptime);
  if (!match) {
    return uptime;
  }
  return match[1] === undefined
    ? t('chat:commandResult.status.uptimeMinutes', { minutes: Number(match[2]) })
    : t('chat:commandResult.status.uptimeHours', { hours: Number(match[1]), minutes: Number(match[2]) });
};

const formatNumber = (value: number) => {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return value.toLocaleString();
};

function MetricCard({
  label,
  value,
  icon: Icon,
  tone = 'neutral',
  compact = false,
}: {
  label: string;
  value: string;
  icon: typeof Activity;
  tone?: 'neutral' | 'primary' | 'success';
  compact?: boolean;
}) {
  const toneClass =
    tone === 'primary'
      ? 'border-primary/35 bg-primary/10 text-primary'
      : tone === 'success'
        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
        : 'border-border/70 bg-background/75 text-muted-foreground';

  return (
    <div
      className={`group rounded-2xl border border-border/70 bg-background/75 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md ${
        compact ? 'p-3' : 'p-4'
      }`}
    >
      <div className={`inline-flex rounded-xl border ${compact ? 'mb-2 p-1.5' : 'mb-3 p-2'} ${toneClass}`}>
        <Icon className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
      </div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className={`${compact ? 'mt-0.5 text-[13px]' : 'mt-1 text-sm'} break-all font-semibold text-foreground`}>{value}</p>
    </div>
  );
}

function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-10 rounded-xl border-border/70 bg-background/75 pe-3 ps-9 shadow-none focus-visible:ring-primary/40"
      />
    </div>
  );
}

function HelpContent({ data }: { data: HelpCommandData }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const commands = (Array.isArray(data.commands) && data.commands.length > 0
    ? data.commands
    : FALLBACK_COMMANDS) as CommandEntry[];

  const filteredCommands = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return commands;
    }

    return commands.filter((command) => {
      const haystack = `${command.name} ${describeSlashCommand(command, t) || ''} ${command.description || ''} ${
        command.descriptionKey ? t(command.descriptionKey) : ''
      } ${command.namespace || ''}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [commands, query, t]);

  return (
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="flex min-h-0 flex-col gap-3">
        <SearchField value={query} onChange={setQuery} placeholder={t('chat:misc.filterCommands')} />

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto pe-1">
          <div className="grid gap-2 sm:grid-cols-2">
            {filteredCommands.map((command, index) => (
              <div
                key={`${command.namespace || 'builtin'}-${command.name}`}
                className="settings-content-enter rounded-2xl border border-border/70 bg-background/75 p-3 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:bg-muted/25"
                style={{ animationDelay: `${Math.min(index * 18, 160)}ms` }}
              >
                <div className="flex items-start justify-between gap-3">
                  <code className="rounded-lg border border-primary/20 bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">
                    {command.name}
                  </code>
                  <Badge variant="secondary" className="shrink-0 text-[10px] capitalize">
                    {describeCommandType(command.namespace || 'builtin', t)}
                  </Badge>
                </div>
                <p className="mt-3 text-sm leading-5 text-muted-foreground">
                  {describeSlashCommand(command, t)
                    || (command.descriptionKey ? t(command.descriptionKey) : t('chat:misc.noDescription'))}
                </p>
              </div>
            ))}
          </div>

          {filteredCommands.length === 0 && (
            <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-4 py-10 text-center text-sm text-muted-foreground">
              {t('chat:commandResult.help.noMatch')}
            </div>
          )}
        </div>
      </div>

      <aside className="space-y-3">
        <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
            <TerminalSquare className="h-4 w-4 text-primary" />
            {t('chat:commandResult.help.syntax')}
          </div>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p><code className="text-foreground">/command arg1 arg2</code></p>
            <p>
              <Trans
                i18nKey="chat:commandResult.help.allArgs"
                values={{ token: '$ARGUMENTS' }}
                components={{ code: <IsolateFreeCode className="text-foreground" /> }}
              />
            </p>
            <p>
              <Trans
                i18nKey="chat:commandResult.help.positionalArgs"
                values={{ first: '$1', second: '$2' }}
                components={{ code: <IsolateFreeCode className="text-foreground" /> }}
              />
            </p>
            <p>
              <Trans
                i18nKey="chat:commandResult.help.fileContents"
                values={{ token: '@file' }}
                components={{ code: <IsolateFreeCode className="text-foreground" /> }}
              />
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-primary/25 bg-primary/10 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Sparkles className="h-4 w-4 text-primary" />
            {t('chat:commandResult.help.quickTip')}
          </div>
          <p className="text-sm leading-5 text-muted-foreground">
            <Trans
              i18nKey="chat:commandResult.help.quickTipText"
              components={{ code: <IsolateFreeCode className="text-foreground" /> }}
            />
          </p>
        </div>
      </aside>
    </div>
  );
}

function ModelsContent({
  data,
  providerModelCatalog,
  providerModelActions,
  activeProvider,
  activeProviderModel,
  currentSessionId,
  onSelectProviderModel,
}: {
  data: ModelCommandData;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelActions: ProviderModelActions;
  activeProvider: LLMProvider;
  activeProviderModel: string;
  currentSessionId: string | null;
  onSelectProviderModel: CommandResultModalProps['onSelectProviderModel'];
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [changingModel, setChangingModel] = useState<string | null>(null);
  const [pendingSessionModel, setPendingSessionModel] = useState<string | null>(null);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [managingModels, setManagingModels] = useState(false);
  const currentProvider = (data?.current?.provider || 'claude') as LLMProvider;
  const currentModel = activeProvider === currentProvider
    ? activeProviderModel
    : pendingSessionModel ?? data?.current?.model ?? t('chat:commandResult.unknown');
  const providerLabel = data?.current?.providerLabel || getProviderLabel(currentProvider, t('chat:commandResult.unknown'));
  const liveDefinition = providerModelCatalog[currentProvider];
  const availableOptions = useMemo<ProviderModelOption[]>(() => {
    if (liveDefinition?.OPTIONS && liveDefinition.OPTIONS.length > 0) {
      return liveDefinition.OPTIONS;
    }

    if (Array.isArray(data?.availableOptions) && data.availableOptions.length > 0) {
      return data.availableOptions;
    }

    const availableModels = Array.isArray(data?.availableModels) ? data.availableModels : [];
    return availableModels.map((model) => ({ value: model, label: model }));
  }, [data, liveDefinition]);
  const filteredOptions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return availableOptions;
    }

    return availableOptions.filter((option) => {
      const haystack = `${option.value} ${describeModelOption(option, t)} ${option.label || ''} ${describeModelDescription(option, t) || ''} ${option.description || ''}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [availableOptions, query, t]);

  const hasConcreteSessionId = typeof currentSessionId === 'string' && currentSessionId.trim().length > 0;
  const showSearch = availableOptions.length > 6;

  const handleSelectModel = async (model: string) => {
    setChangingModel(model);
    try {
      const result = await onSelectProviderModel(currentProvider, model, currentSessionId);
      if (result.scope === 'session') {
        setPendingSessionModel(result.model);
        setSelectionNotice(t('chat:commandResult.models.sessionUses', { model: result.model }));
        return;
      }

      setPendingSessionModel(null);
      setSelectionNotice(t('chat:commandResult.models.defaultSet', { provider: providerLabel, model: result.model }));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('chat:misc.modelChangeFailed');
      setSelectionNotice(message);
    } finally {
      setChangingModel(null);
    }
  };

  if (managingModels) {
    return (
      <ModelLibraryPanel
        initialProvider={currentProvider}
        providerModelCatalog={providerModelCatalog}
        actions={providerModelActions}
        onDone={() => setManagingModels(false)}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/70 bg-muted/20 px-3.5 py-2.5">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {t('chat:commandResult.models.active', { provider: providerLabel })}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="break-all font-mono text-sm font-semibold text-foreground">{currentModel}</span>
            {pendingSessionModel && pendingSessionModel !== currentModel && (
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-500 dark:text-emerald-400">
                {t('chat:commandResult.models.next', { model: pendingSessionModel })}
              </span>
            )}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setManagingModels(true)}
          className="h-9 shrink-0 rounded-xl bg-background px-3 text-xs"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('chat:providerSelection.manageModels')}
        </Button>
      </div>

      {showSearch && (
        <SearchField value={query} onChange={setQuery} placeholder={t('chat:commandResult.models.search', { provider: providerLabel })} />
      )}

      {filteredOptions.length > 0 ? (
        <div className="scrollbar-thin -me-1 min-h-0 flex-1 overflow-y-auto pe-1">
          <div className="grid gap-2 md:grid-cols-2">
            {filteredOptions.map((option, index) => {
              const isCurrent = option.value === currentModel;
              const isPendingSelection = option.value === pendingSessionModel;
              const isChanging = option.value === changingModel;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleSelectModel(option.value)}
                  disabled={Boolean(changingModel)}
                  aria-label={t('chat:commandResult.models.select', { model: option.value })}
                  className={`settings-content-enter group flex min-h-16 flex-col rounded-2xl border p-3 text-start shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60 ${
                    isCurrent
                      ? 'border-primary/45 bg-primary/10'
                      : isPendingSelection
                        ? 'border-emerald-500/35 bg-emerald-500/10'
                        : 'border-border/70 bg-background/80 hover:border-primary/30 hover:bg-background'
                  }`}
                  style={{ animationDelay: `${Math.min(index * 14, 180)}ms` }}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="break-words text-sm font-semibold text-foreground">{describeModelOption(option, t)}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      {option.isCustom && <Badge className="rounded-full px-2 py-0 text-[9px]">{t('chat:modelLibrary.customBadge')}</Badge>}
                      {isCurrent ? (
                        <BadgeCheck className="h-4 w-4 shrink-0 text-primary" />
                      ) : isChanging ? (
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                      ) : null}
                    </span>
                  </span>
                  {option.label !== option.value && (
                    <span className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{option.value}</span>
                  )}
                  {option.description && (
                    <span className="mt-1 text-xs leading-5 text-muted-foreground">{describeModelDescription(option, t)}</span>
                  )}
                  {isCurrent && (
                    <span className="mt-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
                      {t('chat:commandResult.models.currentSelection')}
                    </span>
                  )}
                  {isPendingSelection && !isCurrent && (
                    <span className="mt-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-500 dark:text-emerald-400">
                      {t('chat:commandResult.models.sessionModel')}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-border bg-background/60 px-4 py-10 text-center text-sm text-muted-foreground">
          {t('chat:commandResult.models.noMatch')}
        </div>
      )}

      {/* Single quiet line of guidance / feedback */}
      <p className="shrink-0 text-[11px] leading-4 text-muted-foreground">
        {selectionNotice ? (
          <span className="text-foreground">{selectionNotice}</span>
        ) : hasConcreteSessionId ? (
          t('chat:misc.choiceSavedSession')
        ) : (
          t('chat:misc.choiceSavedDefault')
        )}
      </p>
    </div>
  );
}

function CostContent({ data }: { data: CostCommandData }) {
  const { t } = useTranslation();
  const unknown = t('chat:commandResult.unknown');
  const used = Number(data.tokenUsage?.used ?? 0);
  const total = Number(data.tokenUsage?.total ?? 0);
  const model = data.model || unknown;
  const provider = getProviderLabel(data.provider, unknown);
  const hasBreakdown =
    typeof data.tokenBreakdown?.input === 'number' ||
    typeof data.tokenBreakdown?.output === 'number';
  const usageRows = [
    { id: 'total', label: t('chat:commandResult.cost.totalTokens'), value: formatNumber(used), icon: Activity },
    ...(hasBreakdown
      ? [
          {
            id: 'input',
            label: t('chat:commandResult.cost.inputTokens'),
            value: formatNumber(Number(data.tokenBreakdown?.input ?? 0)),
            icon: TerminalSquare,
          },
          {
            id: 'output',
            label: t('chat:commandResult.cost.outputTokens'),
            value: formatNumber(Number(data.tokenBreakdown?.output ?? 0)),
            icon: Coins,
          },
        ]
      : [
          {
            id: 'breakdown',
            label: t('chat:commandResult.cost.breakdown'),
            value: t('chat:commandResult.cost.unavailable'),
            icon: TerminalSquare,
          },
        ]),
    // Only when it is consistent with what was actually used. Claude reports
    // the window its model has once a turn completes, but until then (and for
    // providers that report none) it is the CONTEXT_WINDOW setting, which cannot
    // know whether a session runs a 200K or a 1M variant of the same model —
    // and a row reading "used 404,009 / window 160,000" is worse than no row.
    ...(total > used
      ? [{ id: 'contextWindow', label: t('chat:commandResult.cost.contextWindow'), value: formatNumber(total), icon: Gauge }]
      : []),
  ];

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-2xl border border-border/70 bg-background/75">
        {usageRows.map((row) => {
          const Icon = row.icon;

          return (
            <div
              key={row.id}
              className="flex items-center justify-between gap-4 border-b border-border/60 px-4 py-3 last:border-b-0"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="truncate text-sm font-medium text-foreground">{row.label}</span>
              </div>
              <span className="shrink-0 font-mono text-sm font-semibold text-foreground">{row.value}</span>
            </div>
          );
        })}
      </div>

      <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {t('chat:commandResult.provider')}
            </p>
            <p className="mt-1 text-sm font-semibold text-foreground">{provider}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {t('chat:commandResult.model')}
            </p>
            <p className="mt-1 break-all font-mono text-sm text-foreground">{model}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusContent({ data }: { data: StatusCommandData }) {
  const { t } = useTranslation();
  const unknown = t('chat:commandResult.unknown');
  const memoryRssMb = data.memoryUsage?.rssMb;
  const rows = [
    { id: 'package', label: t('chat:commandResult.status.package'), value: data.packageName || 'claude-code-ui', icon: Package },
    { id: 'version', label: t('chat:commandResult.status.version'), value: data.version || unknown, icon: BadgeCheck, tone: 'success' as const },
    { id: 'uptime', label: t('chat:commandResult.status.uptime'), value: data.uptime ? formatUptime(data.uptime, t) : unknown, icon: Timer },
    { id: 'provider', label: t('chat:commandResult.provider'), value: getProviderLabel(data.provider, unknown), icon: Server, tone: 'primary' as const },
    { id: 'model', label: t('chat:commandResult.model'), value: data.model || unknown, icon: Cpu },
    { id: 'node', label: 'Node.js', value: data.nodeVersion || unknown, icon: TerminalSquare },
    { id: 'platform', label: t('chat:commandResult.status.platform'), value: data.platform || unknown, icon: Activity },
    {
      id: 'memory',
      label: t('chat:commandResult.status.memory'),
      value: typeof memoryRssMb === 'number' ? t('chat:commandResult.status.memoryRss', { mb: memoryRssMb }) : unknown,
      icon: Gauge,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-3xl border border-emerald-500/25 bg-emerald-500/10 p-4">
        <div className="flex items-center gap-3">
          <span className="relative flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">{t('chat:commandResult.status.online')}</p>
            <p className="text-xs text-muted-foreground">
              {data.pid
                ? t('chat:commandResult.status.responding', { pid: data.pid })
                : t('chat:commandResult.status.respondingNoPid')}
            </p>
          </div>
        </div>
        <Badge className="rounded-full bg-emerald-500 text-white hover:bg-emerald-500">{t('chat:commandResult.status.healthy')}</Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map((row) => (
          <MetricCard key={row.id} label={row.label} value={String(row.value)} icon={row.icon} tone={row.tone} />
        ))}
      </div>
    </div>
  );
}

/**
 * Rendered by chat's ChatInterface to present the result of a slash command
 * (help, model picker, cost or status) in a modal over the transcript.
 */
function CommandResultModal({
  payload,
  onClose,
  providerModelCatalog,
  providerModelActions,
  activeProvider,
  activeProviderModel,
  currentSessionId,
  onSelectProviderModel,
}: CommandResultModalProps) {
  const { t } = useTranslation();
  const isOpen = Boolean(payload);
  const kind = payload?.kind;
  const isModelsModal = kind === 'models';

  const modalMeta = {
    help: {
      eyebrow: t('chat:misc.modalMeta.helpEyebrow'),
      title: t('chat:misc.modalMeta.helpTitle'),
      subtitle: t('chat:misc.modalMeta.helpSubtitle'),
      icon: CircleHelp,
    },
    models: {
      eyebrow: t('chat:misc.modalMeta.modelsEyebrow'),
      title: t('chat:misc.modalMeta.modelsTitle'),
      subtitle: t('chat:misc.modalMeta.modelsSubtitle'),
      icon: Cpu,
    },
    cost: {
      eyebrow: t('chat:misc.modalMeta.costEyebrow'),
      title: t('chat:misc.modalMeta.costTitle'),
      subtitle: t('chat:misc.modalMeta.costSubtitle'),
      icon: Coins,
    },
    status: {
      eyebrow: t('chat:misc.modalMeta.statusEyebrow'),
      title: t('chat:misc.modalMeta.statusTitle'),
      subtitle: t('chat:misc.modalMeta.statusSubtitle'),
      icon: Activity,
    },
  } as const;

  const activeMeta = kind ? modalMeta[kind] : null;
  const HeaderIcon = activeMeta?.icon || Sparkles;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[min(92dvh,48rem)] w-[calc(100vw-1rem)] max-w-5xl flex-col overflow-hidden rounded-3xl border-border/80 bg-popover/95 p-0 shadow-2xl backdrop-blur-xl sm:w-[min(94vw,64rem)]">
        <DialogTitle>{activeMeta?.title || t('chat:misc.modalMeta.commandResult')}</DialogTitle>

        <div
          className={`flex shrink-0 items-start justify-between gap-3 border-b border-border bg-popover ${
            isModelsModal ? 'px-4 py-3 sm:px-5 sm:py-4' : 'px-4 py-4 sm:px-6 sm:py-5'
          }`}
        >
          <div className="flex min-w-0 items-center gap-3">
            <div
              className={`flex shrink-0 items-center justify-center rounded-xl border border-border bg-muted text-foreground ${
                isModelsModal ? 'h-9 w-9' : 'h-10 w-10'
              }`}
            >
              <HeaderIcon className={isModelsModal ? 'h-4 w-4' : 'h-5 w-5'} />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {activeMeta?.eyebrow}
              </p>
              <p className="mt-0.5 text-lg font-semibold tracking-tight text-foreground sm:text-xl">
                {activeMeta?.title}
              </p>
              <p className="mt-0.5 max-w-2xl text-sm leading-5 text-muted-foreground">
                {activeMeta?.subtitle}
              </p>
            </div>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('chat:misc.closeModal')}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="settings-content-enter min-h-0 flex-1 overflow-hidden px-4 py-4 sm:px-6 sm:py-5">
          {payload?.kind === 'help' && <HelpContent data={payload.data as HelpCommandData} />}
          {payload?.kind === 'models' && (
            <ModelsContent
              data={payload.data as ModelCommandData}
              providerModelCatalog={providerModelCatalog}
              providerModelActions={providerModelActions}
              activeProvider={activeProvider}
              activeProviderModel={activeProviderModel}
              currentSessionId={currentSessionId}
              onSelectProviderModel={onSelectProviderModel}
            />
          )}
          {payload?.kind === 'cost' && <CostContent data={payload.data as CostCommandData} />}
          {payload?.kind === 'status' && <StatusContent data={payload.data as StatusCommandData} />}
        </div>

        <div className="flex shrink-0 flex-col gap-3 border-t border-border/70 bg-muted/20 px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-2">
            <Gauge className="h-3.5 w-3.5" />
            {t('chat:misc.escClosesModal')}
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onClose} className="rounded-xl">
            {t('chat:misc.close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Memoized: chat re-renders on every keystroke and this modal is closed for almost all of them. */
export default memo(CommandResultModal);
