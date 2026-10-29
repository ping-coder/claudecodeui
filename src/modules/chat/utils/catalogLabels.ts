import type { TFunction } from 'i18next';

import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import type { ProviderModelOption } from '@/shared/types';

/*
 * Words the server sends in English, shown in the interface language when
 * this client knows them: the reasoning effort levels, the names in the
 * built-in model catalog that are words rather than model names, the built-in
 * models' descriptions, and the built-in slash commands. Anything it does not
 * know (a level, a model or a command added later, a custom model the user
 * named) shows as sent. Each takes any `t`: the keys carry their namespace.
 */

/** The effort levels the providers declare (the server's provider capabilities), weakest first. */
export const EFFORT_LEVEL_KEYS: ReadonlyMap<string, string> = new Map([
  ['none', 'chat:effortLevels.none'],
  ['minimal', 'chat:effortLevels.minimal'],
  ['low', 'chat:effortLevels.low'],
  ['medium', 'chat:effortLevels.medium'],
  ['high', 'chat:effortLevels.high'],
  ['xhigh', 'chat:effortLevels.xhigh'],
  ['max', 'chat:effortLevels.max'],
  ['ultra', 'chat:effortLevels.ultra'],
  ['thinking', 'chat:effortLevels.thinking'],
]);

/** A reasoning effort level by name; the composer's "use the model's default" choice included. */
export function describeEffortLevel(level: string, t: TFunction): string {
  if (level === DEFAULT_EFFORT_VALUE) {
    return t('chat:composer.effortDefault', { defaultValue: 'Default' });
  }
  const key = EFFORT_LEVEL_KEYS.get(level);
  return key ? t(key, { defaultValue: level }) : level;
}

/** The built-in catalog's names that are words, by the English the server sends. */
export const MODEL_LABEL_KEYS: ReadonlyMap<string, string> = new Map([
  ['Default (recommended)', 'chat:modelCatalog.defaultRecommended'],
  ['Best available', 'chat:modelCatalog.bestAvailable'],
  ['Auto', 'chat:modelCatalog.auto'],
]);

/** A model name with the size of its context window: "Sonnet 5.5 (1M context)". */
const CONTEXT_VARIANT = /^(.+) \((\d+(?:\.\d+)?[KM]) context\)$/;

/**
 * What a model picker calls a model: its label, in the interface language
 * where the built-in catalog uses words. A custom model keeps the name the
 * user gave it.
 */
export function describeModelOption(option: Pick<ProviderModelOption, 'value' | 'label' | 'isCustom'>, t: TFunction): string {
  const label = option.label || option.value;
  if (option.isCustom) {
    return label;
  }
  const key = MODEL_LABEL_KEYS.get(label);
  if (key) {
    return t(key, { defaultValue: label });
  }
  const variant = CONTEXT_VARIANT.exec(label);
  return variant
    ? t('chat:modelCatalog.contextVariant', { model: variant[1], context: variant[2], defaultValue: label })
    : label;
}

/**
 * The built-in catalogs' model descriptions, by the English the server sends
 * (server/modules/providers/list/<provider>/<provider>-models.provider.ts).
 * A description that names a model's version stops matching once the server
 * moves to the next one, and then shows as sent.
 */
export const MODEL_DESCRIPTION_KEYS: ReadonlyMap<string, string> = new Map([
  ['Use the recommended model for your Claude account and deployment.', 'chat:modelCatalog.descriptions.claudeDefault'],
  ['Use Fable 5.1 when available, otherwise Opus 5.5.', 'chat:modelCatalog.descriptions.claudeBest'],
  ['Most capable Claude model for the hardest, longest-running tasks.', 'chat:modelCatalog.descriptions.claudeFable'],
  ['Latest Sonnet model for everyday coding tasks.', 'chat:modelCatalog.descriptions.claudeSonnet'],
  ['Latest Sonnet model with a 1M context window.', 'chat:modelCatalog.descriptions.claudeSonnet1m'],
  ['Latest Opus model for complex reasoning and coding tasks.', 'chat:modelCatalog.descriptions.claudeOpus'],
  ['Latest Opus model with a 1M context window.', 'chat:modelCatalog.descriptions.claudeOpus1m'],
  ['Fast and efficient Claude model for simple tasks.', 'chat:modelCatalog.descriptions.claudeHaiku'],
  ['Use Opus 5.5 while planning, then switch to Sonnet 5.5 for execution.', 'chat:modelCatalog.descriptions.claudeOpusPlan'],
  ['Our most capable model for complex, demanding work.', 'chat:modelCatalog.descriptions.codexMostCapable'],
  ['Workhorse model for coding and everyday work.', 'chat:modelCatalog.descriptions.codexWorkhorse'],
  ['Fast and affordable model for easier tasks.', 'chat:modelCatalog.descriptions.codexFast'],
  ['Latest frontier agentic coding model.', 'chat:modelCatalog.descriptions.codexAgenticFrontier'],
  ['Balanced agentic coding model for everyday work.', 'chat:modelCatalog.descriptions.codexAgenticBalanced'],
  ['Fast and affordable agentic coding model.', 'chat:modelCatalog.descriptions.codexAgenticFast'],
  ['Frontier model for complex coding, research, and real-world work.', 'chat:modelCatalog.descriptions.codexFrontier'],
  ['Strong model for everyday coding.', 'chat:modelCatalog.descriptions.codexStrong'],
  ['Small, fast, and cost-efficient model for simpler coding tasks.', 'chat:modelCatalog.descriptions.codexSmall'],
  ['Let Cursor choose the model.', 'chat:modelCatalog.descriptions.cursorAuto'],
  ['Cursor Composer 2.5 with faster inference.', 'chat:modelCatalog.descriptions.cursorComposerFast'],
  ['Cursor model for efficient, long-running coding tasks.', 'chat:modelCatalog.descriptions.cursorComposer'],
]);

/**
 * A model's description in a model list: a built-in model's in the interface
 * language while the server still describes it as this client knows; a custom
 * model's, or one this client does not know, as sent.
 */
export function describeModelDescription(option: Pick<ProviderModelOption, 'description' | 'isCustom'>, t: TFunction): string | undefined {
  const key = option.description && !option.isCustom ? MODEL_DESCRIPTION_KEYS.get(option.description) : undefined;
  return key ? t(key, { defaultValue: option.description }) : option.description;
}

/**
 * The built-in slash commands, with the description the server lists each by
 * (server/modules/commands/commands.routes.ts) and the key of its translation.
 */
export const BUILTIN_COMMAND_DESCRIPTIONS: ReadonlyMap<string, { english: string; key: string }> = new Map([
  ['/help', { english: 'Show help documentation for Claude Code', key: 'chat:slashCommands.builtin.help' }],
  ['/models', { english: 'View available models for the current provider', key: 'chat:slashCommands.builtin.models' }],
  ['/cost', { english: 'Display token usage information', key: 'chat:slashCommands.builtin.cost' }],
  ['/memory', { english: 'Open CLAUDE.md memory file for editing', key: 'chat:slashCommands.builtin.memory' }],
  ['/config', { english: 'Open settings and configuration', key: 'chat:slashCommands.builtin.config' }],
  ['/status', { english: 'Show system status and version information', key: 'chat:slashCommands.builtin.status' }],
]);

type DescribedCommand = {
  name: string;
  description?: string;
  namespace?: string;
  metadata?: { type?: unknown };
};

/**
 * A slash command's description: a built-in command's in the interface
 * language while the server still describes it as this client knows; any
 * other command's (a project's, a user's, a skill's) as its file has it.
 */
export function describeSlashCommand(command: DescribedCommand, t: TFunction): string | undefined {
  const isBuiltin = command.namespace === 'builtin' || command.metadata?.type === 'builtin';
  const known = isBuiltin ? BUILTIN_COMMAND_DESCRIPTIONS.get(command.name) : undefined;
  return known && command.description === known.english
    ? t(known.key, { defaultValue: known.english })
    : command.description;
}

/** A command's type badge: the built-in one in the interface language, any other as the command declares it. */
export function describeCommandType(type: string, t: TFunction): string {
  return type === 'builtin' ? t('chat:slashCommands.builtinBadge', { defaultValue: 'builtin' }) : type;
}
