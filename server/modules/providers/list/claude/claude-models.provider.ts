import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  isPlaceholderProviderModel,
  stripAnsiSequences,
} from '@/shared/utils.js';

/** Effort levels of every model that can also run at xhigh. */
const XHIGH_CAPABLE_EFFORT_VALUES = [
  { value: 'low' },
  { value: 'medium' },
  { value: 'high' },
  { value: 'xhigh' },
  { value: 'max' },
];

/**
 * Claude Code's built-in model choices.
 *
 * `value` is the alias handed to the CLI and stays unversioned, so it keeps
 * following the newest model of each family. `label` names the model that
 * alias resolves to in the current Claude Code release, so the picker shows
 * versions the way `/model` does; bump the labels together when the CLI moves
 * an alias to a new model. A gateway that remaps aliases (the
 * `ANTHROPIC_DEFAULT_*_MODEL` variables) runs whatever it maps them to.
 *
 * `supportsUltracode` marks the xhigh-capable models: Claude Code offers
 * ultracode, its standing workflow orchestration, only on those. Ultracode is
 * an on/off switch that combines with any effort level, so it is never one of
 * the `effort.values`.
 */
export const CLAUDE_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: 'Use the recommended model for your Claude account and deployment.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'best',
      label: 'Best available',
      description: 'Use Fable 5.1 when available, otherwise Opus 5.5.',
      effort: {
        default: 'high',
        values: XHIGH_CAPABLE_EFFORT_VALUES,
      },
      supportsUltracode: true,
    },
    {
      value: 'fable',
      label: 'Fable 5.1',
      description: 'Most capable Claude model for the hardest, longest-running tasks.',
      effort: {
        default: 'high',
        values: XHIGH_CAPABLE_EFFORT_VALUES,
      },
      supportsUltracode: true,
    },
    {
      value: 'sonnet',
      label: 'Sonnet 5.5',
      description: 'Latest Sonnet model for everyday coding tasks.',
      effort: {
        default: 'high',
        values: XHIGH_CAPABLE_EFFORT_VALUES,
      },
      supportsUltracode: true,
    },
    {
      value: 'sonnet[1m]',
      label: 'Sonnet 5.5 (1M context)',
      description: 'Latest Sonnet model with a 1M context window.',
      effort: {
        default: 'high',
        values: XHIGH_CAPABLE_EFFORT_VALUES,
      },
      supportsUltracode: true,
    },
    {
      value: 'opus',
      label: 'Opus 5.5',
      description: 'Latest Opus model for complex reasoning and coding tasks.',
      effort: {
        default: 'high',
        values: XHIGH_CAPABLE_EFFORT_VALUES,
      },
      supportsUltracode: true,
    },
    {
      value: 'opus[1m]',
      label: 'Opus 5.5 (1M context)',
      description: 'Latest Opus model with a 1M context window.',
      effort: {
        default: 'high',
        values: XHIGH_CAPABLE_EFFORT_VALUES,
      },
      supportsUltracode: true,
    },
    {
      value: 'haiku',
      label: 'Haiku 5.5',
      description: 'Fast and efficient Claude model for simple tasks.',
      effort: {
        default: 'high',
        values: XHIGH_CAPABLE_EFFORT_VALUES,
      },
      supportsUltracode: true,
    },
    {
      value: 'opusplan',
      label: 'Opus Plan',
      description: 'Use Opus 5.5 while planning, then switch to Sonnet 5.5 for execution.',
      effort: {
        default: 'high',
        values: XHIGH_CAPABLE_EFFORT_VALUES,
      },
      supportsUltracode: true,
    },
  ],
  DEFAULT: 'default',
};

export const findClaudeModelOption = (model: string | undefined | null): ProviderModelOption | null => {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!normalizedModel) {
    return null;
  }

  return CLAUDE_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === normalizedModel) ?? null;
};
type ClaudeInitEvent = {
  sessionId?: string;
  session_id?: string;
  type?: string;
  subtype?: string;
  model?: string;
  /**
   * On assistant rows, the model Claude Code was asked to run (its `--model`),
   * which keeps the `[1m]` suffix and provider id spelling that `message.model`
   * drops ("claude-opus-5-5[1m]" vs "claude-opus-5-5").
   */
  requestedModel?: string;
  message?: {
    content?: unknown;
    model?: string;
  };
};

/** Exported for tests. */
export const extractClaudeEventModel = (event: ClaudeInitEvent, sessionId: string): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  // Copies of what was sent to the API, not session events: one bundles every
  // command output since the last reply, so it would replay older switches.
  if (event.type === 'api-request-blob') {
    return null;
  }

  // An assistant row's own model is the one that answered; its text can quote
  // command output (or a transcript) without being a model switch. The model it
  // was requested as is what a resume must pass back as `--model`.
  if (event.type === 'assistant') {
    const requestedModel = event.requestedModel?.trim();
    if (requestedModel && !isPlaceholderProviderModel(requestedModel)) {
      return requestedModel;
    }
  }

  const contentModel = event.type === 'assistant'
    ? null
    : extractClaudeModelFromMessageContent(event.message?.content);
  if (contentModel) {
    return contentModel;
  }

  const directModel = event.model?.trim();
  if (directModel && !isPlaceholderProviderModel(directModel)) {
    return directModel;
  }

  const messageModel = event.message?.model?.trim();
  return messageModel && !isPlaceholderProviderModel(messageModel) ? messageModel : null;
};

const extractTaggedContent = (content: string, tagName: string): string | null => {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
};

/** Model families whose `/model` display names map onto a `claude-<family>-<version>` id. */
const CLAUDE_DISPLAY_NAME_FAMILIES = new Set(['fable', 'mythos', 'opus', 'sonnet', 'haiku']);

/**
 * Maps a model display name from `/model` output ("Opus 5.5", "Haiku 4.5",
 * "Opus 5.5 (1M context)") to the canonical id it names ("claude-opus-5-5",
 * "claude-haiku-4-5", "claude-opus-5-5[1m]"). The value read from a transcript
 * becomes the session's model, which the composer sends back and the runtime
 * hands Claude Code as `--model` on resume; that flag takes an id or alias,
 * never a display name. Claude Code names two choices without a model id:
 * Default prints the model it resolves to plus " (default)" ("Opus 5.5
 * (default)"), and opusplan prints "Opus in plan mode, else Sonnet"; those map
 * back to their aliases. Returns null for anything else.
 */
const mapClaudeDisplayNameToModelId = (displayName: string): string | null => {
  if (/\s\(default\)$/i.test(displayName)) {
    return CLAUDE_PREDEFINED_MODELS.DEFAULT;
  }

  if (/^opus in plan mode\b/i.test(displayName) || /^opus plan(?: mode)?$/i.test(displayName)) {
    return 'opusplan';
  }

  // A name followed by the id it resolves to: "sonnet (claude-sonnet-4-20250514)".
  const parenthesizedId = /\((claude-[^\s()]+)\)$/i.exec(displayName);
  if (parenthesizedId) {
    return parenthesizedId[1];
  }

  const match = /^([a-z]+)\s+(\d+(?:\.\d+)*)(\s*\(1m context\))?$/i.exec(displayName);
  if (!match || !CLAUDE_DISPLAY_NAME_FAMILIES.has(match[1].toLowerCase())) {
    return null;
  }

  const [, family, version, oneMillionContext] = match;
  return `claude-${family.toLowerCase()}-${version.replace(/\./g, '-')}${oneMillionContext ? '[1m]' : ''}`;
};

/**
 * What a `/model` stdout says about the session's model: no model statement
 * at all, a statement naming a usable id or alias, or a statement whose model
 * cannot be named (a display name this parser does not know). The last case
 * still proves the session moved off whatever older transcript lines show.
 */
type ClaudeCommandStdoutModel =
  | { kind: 'none' }
  | { kind: 'model'; model: string }
  | { kind: 'unnamed' };

/**
 * Reads the model a `/model` command left the session on from its stdout.
 * Claude Code prints "Set model to `claude-opus-5-5`" for an id, "Set model
 * to `Opus 5.5`" for a picker choice, "Kept model as `Opus 5.5`" when nothing
 * changed, and may append clauses such as " and saved as your default for new
 * sessions", " for this session only" or " · `max` effort for this session
 * only". The name may also come unquoted, or bolded with ANSI codes.
 */
const extractClaudeModelFromCommandStdout = (stdout: string): ClaudeCommandStdoutModel => {
  const cleanedStdout = stripAnsiSequences(stdout).replace(/\s+/g, ' ').trim();
  const statement = /\b(?:(?:set|changed|switched)\s+model\s+to|kept\s+model\s+as)\s+(.+)$/i
    .exec(cleanedStdout)?.[1];
  if (!statement) {
    return { kind: 'none' };
  }

  // A quoted name ends at its closing backtick; an unquoted one at the first
  // trailing clause, which never belongs to the model name.
  const quotedName = /^`([^`]+)`/.exec(statement)?.[1];
  const modelName = (quotedName ?? statement.split(/\s+(?:and|for|·)\s+/i)[0])
    .trim()
    .replace(/\.$/, '');
  // A placeholder is a fabricated row, not a real switch, so it says nothing.
  if (!modelName || isPlaceholderProviderModel(modelName)) {
    return { kind: 'none' };
  }

  // Ids and aliases ("claude-haiku-4-5@20251001", "sonnet[1m]") never contain
  // whitespace; anything that does is a display name.
  const model = /\s/.test(modelName) ? mapClaudeDisplayNameToModelId(modelName) : modelName;
  return model ? { kind: 'model', model } : { kind: 'unnamed' };
};

const extractClaudeModelFromTextContent = (content: string): string | null => {
  const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
  const stdoutModel = localCommandStdout === null
    ? ({ kind: 'none' } as const)
    : extractClaudeModelFromCommandStdout(localCommandStdout);
  if (stdoutModel.kind === 'model') {
    return stdoutModel.model;
  }

  // A placeholder or unnamed stdout hit must not shadow a real <model> tag
  // further down, so the tag is read first.
  const modelTag = extractTaggedContent(content, 'model')?.trim();
  if (modelTag && !isPlaceholderProviderModel(modelTag)) {
    return modelTag;
  }

  // The session switched to a model this parser cannot name. Older lines show
  // the model from before the switch, so the scan must stop here; the catalog
  // default is the provider's "no answer", which makes resolveSessionModel fall
  // back to the composer's choice instead of reviving the old model.
  return stdoutModel.kind === 'unnamed' ? CLAUDE_PREDEFINED_MODELS.DEFAULT : null;
};

const extractClaudeModelFromMessageContent = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return extractClaudeModelFromTextContent(content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  // Newest part first: when one message carries several command outputs, the
  // last one is the session's current model.
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const part: unknown = content[index];
    if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') {
      continue;
    }

    // extractClaudeModelFromTextContent rejects placeholders, so a placeholder
    // part yields null here and an earlier part can still supply the model.
    const model = extractClaudeModelFromTextContent(part.text);
    if (model) {
      return model;
    }
  }

  return null;
};

const readClaudeSessionModelFromJsonl = async (
  sessionId: string,
  jsonlPath: string,
): Promise<ProviderCurrentActiveModel | null> => {
  const content = await readFile(jsonlPath, 'utf8');
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]) as ClaudeInitEvent;
      const model = extractClaudeEventModel(event, sessionId);
      if (model) {
        return { model };
      }
    } catch {
      // Skip malformed JSONL lines that can happen during concurrent writes.
    }
  }

  return null;
};

export class ClaudeProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    // claude creates a new jsonl file as a separate session for this request.
    // As a result, it lists the workspace where this is invoked when it shouldn't.
    //
    // Disabled for now:
    // const queryInstance = query({
    //   prompt: 'Get supported models',
    //   options: buildClaudeQueryOptions(),
    // });
    // const supportedModels = await queryInstance.supportedModels();
    // queryInstance.close();
    // return buildClaudeModelsDefinition(supportedModels);
    return CLAUDE_PREDEFINED_MODELS;
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    try {
      const jsonlPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
      const activeModel = jsonlPath
        ? await readClaudeSessionModelFromJsonl(sessionId, jsonlPath)
        : null;
      if (activeModel?.model) {
        return activeModel;
      }
    } catch {
      // Fall through to the provider default when the session-backed lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
