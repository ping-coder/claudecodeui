import { readAgyTranscript, summarizeAgyTranscriptTokenUsage } from '@/modules/providers/list/agy/agy-store.js';
import { parseFilesInputTag, parseImagesInputTag } from '@/shared/image-attachments.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import { prepareTranscriptMessages } from '@/shared/message-unification.js';
import type {
  AgyStepUpdate,
  AgyTranscript,
  AgyTranscriptStep,
  AnyRecord,
  FetchHistoryOptions,
  FetchHistoryResult,
  NormalizedMessage,
} from '@/shared/types.js';
import {
  createNormalizedMessage,
  parseAgyTimestampMs,
  readJsonRecord,
  readObjectRecord,
  readOptionalString,
  sliceTailPage,
  unwrapAgyUserInput,
} from '@/shared/utils.js';

const PROVIDER = 'agy';

/** Appended to a field agy shortened in `transcript.jsonl` (named in its `truncated_fields`). */
const TRUNCATION_MARKER = '\n… (truncated)';

/** The `Created At: …` / `Completed At: …` lines agy puts before a tool's output. */
const TOOL_RESULT_HEADER_PATTERN = /^(?:Created At:[^\n]*\r?\n)?(?:Completed At:[^\n]*\r?\n)?/;

/** Step states that end a step without success. Unverified beyond DONE, so matched loosely. */
const FAILED_STEP_STATE_PATTERN = /error|fail|cancel/i;

/** Renderer names with behaviour of their own (subagent and workflow cards, `exec`) a raw agy tool must not take. */
const RESERVED_TOOL_NAMES = new Set(['Task', 'Agent', 'Workflow', 'exec', 'Default']);

/** Each unknown live step type is logged once, not once per event. */
const loggedUnknownStepTypes = new Set<string>();

type AgyMessagePart = 'text' | 'thinking' | 'tool' | 'result' | 'end';

type AgyToolRow = {
  toolName: string;
  toolInput: AnyRecord;
};

/** The tool_use rows of one planner call, waiting for the GENERIC step that carries its result. */
type PendingToolCall = {
  messages: NormalizedMessage[];
};

/**
 * The one message id scheme live events and history share, so the history
 * refetch after a run replaces the streamed rows instead of duplicating them:
 * `agy:<conversation>:<step>:<part>`. `stepKey` is a step index, optionally
 * with a `#<row>` suffix, or `<planner step>-<call>` for a call whose result
 * step is not known yet.
 */
function buildAgyMessageId(conversationId: string, stepKey: string | number, part: AgyMessagePart): string {
  return `agy:${conversationId}:${stepKey}:${part}`;
}

/**
 * A tool call's id: the step index of the step that ran it (the stream's
 * `tool` step, the transcript's GENERIC step), so live and history agree.
 */
function buildAgyToolId(conversationId: string, stepKey: string | number): string {
  return `${conversationId}:${stepKey}`;
}

/** A call shown as several rows (one per edit chunk) numbers them `#0`, `#1`, …; a single row keeps the bare key. */
function buildToolRowKey(stepKey: string | number, rowIndex: number, rowCount: number): string {
  return rowCount > 1 ? `${stepKey}#${rowIndex}` : String(stepKey);
}

const normalizeParameterKey = (key: string): string => key.replace(/[\s_-]/g, '').toLowerCase();

/** The first present parameter among `names` (in that order), ignoring case and separators. */
function readParameter(parameters: AnyRecord, names: string[]): unknown {
  for (const name of names.map(normalizeParameterKey)) {
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== undefined && value !== null && normalizeParameterKey(key) === name) {
        return value;
      }
    }
  }
  return undefined;
}

function readStringParameter(parameters: AnyRecord, names: string[]): string | undefined {
  const value = readParameter(parameters, names);
  if (typeof value === 'string') {
    return value;
  }
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
}

/**
 * Arguments of a transcript `tool_calls` entry. They arrive as an object or a
 * JSON string, and the transcript JSON-encodes each value (`"\"/a.ts\""`), so
 * one level of each value is decoded; text that is not JSON stays as it is.
 *
 * Transcript only: the live stream sends raw values, which this would corrupt
 * (a JSON file's content would become an object, a quoted query would lose
 * its quotes).
 */
function decodeAgyTranscriptToolArguments(rawArguments: unknown): AnyRecord {
  const decoded: AnyRecord = {};
  for (const [key, value] of Object.entries(readJsonRecord(rawArguments) ?? {})) {
    if (typeof value !== 'string') {
      decoded[key] = value;
      continue;
    }
    try {
      decoded[key] = JSON.parse(value);
    } catch {
      decoded[key] = value;
    }
  }
  return decoded;
}

const toSnakeCase = (key: string): string => key
  .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
  .replace(/[\s-]+/g, '_')
  .toLowerCase();

/**
 * The `ReplacementChunks` of an edit: an array, or a JSON string holding one
 * (live values are raw, so they are not decoded before this). Each chunk may
 * itself be an object or a JSON string.
 */
function readReplacementChunks(parameters: AnyRecord): AnyRecord[] {
  let chunksValue = readParameter(parameters, ['ReplacementChunks']);
  if (typeof chunksValue === 'string') {
    try {
      chunksValue = JSON.parse(chunksValue);
    } catch {
      return [];
    }
  }
  return Array.isArray(chunksValue)
    ? chunksValue.map((chunk) => readJsonRecord(chunk)).filter((chunk): chunk is AnyRecord => chunk !== null)
    : [];
}

/** `replace_file_content` and `multi_replace_file_content`: one Edit row per replacement chunk. */
function translateAgyEditCall(parameters: AnyRecord): AgyToolRow[] {
  const filePath = readStringParameter(parameters, ['TargetFile', 'Path', 'File']) ?? '';
  const chunks = readReplacementChunks(parameters);
  // Without chunks, the single replacement sits at the top level.
  const replacements = chunks.length > 0 ? chunks : [parameters];

  return replacements.map((replacement) => ({
    toolName: 'Edit',
    toolInput: {
      file_path: filePath,
      old_string: readStringParameter(replacement, ['TargetContent']) ?? '',
      new_string: readStringParameter(replacement, ['ReplacementContent']) ?? '',
    },
  }));
}

/**
 * Any other tool keeps its own name, with snake_case keys so the generic
 * renderer finds a title (`path`, `query`, `url`, …). MCP tools keep their
 * server's argument names.
 */
function translateUnknownAgyTool(name: string, parameters: AnyRecord): AgyToolRow {
  const toolName = name.trim() || 'tool';
  if (toolName.startsWith('mcp__')) {
    return { toolName, toolInput: parameters };
  }

  const toolInput: AnyRecord = {};
  for (const [key, value] of Object.entries(parameters)) {
    toolInput[toSnakeCase(key)] = value;
  }
  return { toolName: RESERVED_TOOL_NAMES.has(toolName) ? `agy_${toolName}` : toolName, toolInput };
}

/**
 * Maps an agy tool call onto the Claude tool renderers the chat already has.
 * Parameter names are read case-insensitively with fallbacks, since agy's are
 * only partly verified. Returns one row per call, except edits, which get one
 * row per chunk.
 */
function translateAgyToolCall(name: string, parameters: AnyRecord): AgyToolRow[] {
  switch (name.trim().toLowerCase()) {
    case 'read_file':
    case 'view_file':
      return [{
        toolName: 'Read',
        toolInput: { file_path: readStringParameter(parameters, ['Path', 'AbsolutePath', 'File', 'FilePath']) ?? '' },
      }];
    case 'run_command': {
      const description = readStringParameter(parameters, ['Description']);
      return [{
        toolName: 'Bash',
        toolInput: {
          command: readStringParameter(parameters, ['CommandLine', 'Command']) ?? '',
          ...(description ? { description } : {}),
        },
      }];
    }
    case 'write_to_file':
      return [{
        toolName: 'Write',
        toolInput: {
          file_path: readStringParameter(parameters, ['TargetFile', 'Path', 'File']) ?? '',
          content: readStringParameter(parameters, ['CodeContent', 'Content']) ?? '',
        },
      }];
    case 'replace_file_content':
    case 'multi_replace_file_content':
      return translateAgyEditCall(parameters);
    case 'search_web':
      return [{ toolName: 'WebSearch', toolInput: { query: readStringParameter(parameters, ['Query']) ?? '' } }];
    case 'read_url_content':
      return [{ toolName: 'WebFetch', toolInput: { url: readStringParameter(parameters, ['Url']) ?? '' } }];
    default:
      return [translateUnknownAgyTool(name, parameters)];
  }
}

function formatToolOutput(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function readStepIndex(step: AgyTranscriptStep): number | null {
  const stepIndex = typeof step.step_index === 'string' ? Number(step.step_index) : step.step_index;
  return typeof stepIndex === 'number' && Number.isInteger(stepIndex) && stepIndex >= 0 ? stepIndex : null;
}

function readStepText(step: AgyTranscriptStep, field: string): string {
  const value = step[field];
  return typeof value === 'string' ? value : '';
}

/** Marks a field `transcript.jsonl` cut short, so a clipped answer is not mistaken for the whole one. */
function markTruncated(text: string, step: AgyTranscriptStep, field: string): string {
  const truncatedFields = step.truncated_fields;
  return text && Array.isArray(truncatedFields) && truncatedFields.includes(field) ? `${text}${TRUNCATION_MARKER}` : text;
}

function readToolCalls(step: AgyTranscriptStep): unknown[] {
  if (Array.isArray(step.tool_calls)) {
    return step.tool_calls;
  }
  if (typeof step.tool_calls === 'string') {
    try {
      const parsed: unknown = JSON.parse(step.tool_calls);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function readTimestamp(value: unknown): string | null {
  const millis = parseAgyTimestampMs(value);
  return millis === null ? null : new Date(millis).toISOString();
}

/**
 * Turns transcript steps into chat rows. Per planner step: its thinking, its
 * text, then one tool_use per call; the GENERIC steps that follow carry the
 * calls' results, in order, and give each call its final ids. User turns lose
 * agy's wrapper; system messages and unknown step kinds are not shown.
 */
function normalizeAgyTranscript(transcript: AgyTranscript, sessionId: string): NormalizedMessage[] {
  const conversationId = transcript.conversationId;
  const messages: NormalizedMessage[] = [];
  let pendingCalls: PendingToolCall[] = [];
  // Steps without a readable time take the one before them (never "now", which
  // would move rows on every read); the first ones take the first known time.
  let lastTimestamp = transcript.steps
    .map((step) => readTimestamp(step.created_at))
    .find((timestamp): timestamp is string => timestamp !== null) ?? transcript.modifiedAt;

  transcript.steps.forEach((step, position) => {
    const stepIndex = readStepIndex(step) ?? position;
    const timestamp = readTimestamp(step.created_at) ?? lastTimestamp;
    lastTimestamp = timestamp;
    const envelope = { sessionId, timestamp, provider: PROVIDER } as const;

    switch (readOptionalString(step.type)) {
      case 'USER_INPUT': {
        pendingCalls = [];
        const images = parseImagesInputTag(unwrapAgyUserInput(readStepText(step, 'content')));
        const files = parseFilesInputTag(images.text);
        if (!files.text.trim() && images.attachments.length === 0 && files.attachments.length === 0) {
          return;
        }
        messages.push(createNormalizedMessage({
          ...envelope,
          id: buildAgyMessageId(conversationId, stepIndex, 'text'),
          kind: 'text',
          role: 'user',
          content: markTruncated(files.text, step, 'content'),
          images: images.attachments.length > 0 ? images.attachments : undefined,
          files: files.attachments.length > 0 ? files.attachments : undefined,
        }));
        return;
      }

      case 'PLANNER_RESPONSE': {
        // Results of an earlier step's calls never follow a newer planner step.
        pendingCalls = [];
        const thinking = readStepText(step, 'thinking');
        if (thinking.trim()) {
          messages.push(createNormalizedMessage({
            ...envelope,
            id: buildAgyMessageId(conversationId, stepIndex, 'thinking'),
            kind: 'thinking',
            content: markTruncated(thinking, step, 'thinking'),
          }));
        }

        const content = readStepText(step, 'content');
        if (content.trim()) {
          const model = readOptionalString(step.model);
          messages.push(createNormalizedMessage({
            ...envelope,
            id: buildAgyMessageId(conversationId, stepIndex, 'text'),
            kind: 'text',
            role: 'assistant',
            content: markTruncated(content, step, 'content'),
            ...(model ? { model } : {}),
          }));
        }

        readToolCalls(step).forEach((rawCall, callIndex) => {
          const call = readJsonRecord(rawCall);
          if (!call) {
            return;
          }
          const name = readOptionalString(call.name) ?? readOptionalString(call.tool_name) ?? 'tool';
          const rows = translateAgyToolCall(
            name,
            decodeAgyTranscriptToolArguments(call.args ?? call.arguments ?? call.parameters ?? call.input),
          );
          const callKey = `${stepIndex}-${callIndex}`;
          const callMessages = rows.map((row, rowIndex) => {
            const rowKey = buildToolRowKey(callKey, rowIndex, rows.length);
            return createNormalizedMessage({
              ...envelope,
              id: buildAgyMessageId(conversationId, rowKey, 'tool'),
              kind: 'tool_use',
              toolName: row.toolName,
              toolInput: row.toolInput,
              toolId: buildAgyToolId(conversationId, rowKey),
            });
          });
          messages.push(...callMessages);
          pendingCalls.push({ messages: callMessages });
        });
        return;
      }

      case 'GENERIC': {
        const call = pendingCalls.shift();
        if (!call) {
          return;
        }
        const output = typeof step.content === 'string'
          ? step.content.replace(TOOL_RESULT_HEADER_PATTERN, '')
          : formatToolOutput(step.content);
        const toolResult = {
          content: markTruncated(output, step, 'content'),
          isError: FAILED_STEP_STATE_PATTERN.test(readOptionalString(step.status) ?? ''),
        };
        call.messages.forEach((message, rowIndex) => {
          const rowKey = buildToolRowKey(stepIndex, rowIndex, call.messages.length);
          message.id = buildAgyMessageId(conversationId, rowKey, 'tool');
          message.toolId = buildAgyToolId(conversationId, rowKey);
          message.toolResult = { ...toolResult };
        });
        return;
      }

      default:
        // SYSTEM_MESSAGE is agy's own prompt; unknown kinds are not conversation.
        return;
    }
  });

  return messages;
}

function logUnknownStepType(stepType: unknown): void {
  const label = String(stepType);
  if (loggedUnknownStepTypes.has(label)) {
    return;
  }
  loggedUnknownStepTypes.add(label);
  console.debug(`[AgyProvider] Ignoring stream step type "${label}"`);
}

/**
 * Chat history and live stream mapping for Antigravity CLI (agy)
 * conversations. History is read from agy's transcript files; nothing is ever
 * written to agy's data roots.
 *
 * Used by the agy provider as its `sessions` facet.
 */
export class AgySessionsProvider implements IProviderSessions {
  /**
   * Maps one `agy --output-format stream-json` event to chat messages. Stateless:
   * the runtime drops repeated tool updates and announces a tool whose ACTIVE
   * update never came before its DONE. `init` and `result` map to nothing (the
   * runtime binds the session and reports the outcome), and so do the echoed
   * user input and system messages.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw || raw.event !== 'step_update') {
      return [];
    }

    const step = readObjectRecord(raw.step_update) as AgyStepUpdate | null;
    if (!step) {
      return [];
    }

    // Ids come from the conversation id, as in history; the session id the
    // runtime passes may be the app's own.
    const conversationId = readOptionalString(step.conversation_id) ?? sessionId ?? '';
    const stepIndex = typeof step.step_index === 'number' && Number.isInteger(step.step_index)
      ? step.step_index
      : null;
    const state = readOptionalString(step.state) ?? '';
    const isDone = state === 'DONE';
    const isFailed = FAILED_STEP_STATE_PATTERN.test(state);
    const envelope = {
      sessionId: sessionId ?? conversationId,
      timestamp: new Date().toISOString(),
      provider: PROVIDER,
    } as const;

    switch (step.step_type) {
      case 'agent_response': {
        const messages: NormalizedMessage[] = [];
        if (typeof step.text_delta === 'string' && step.text_delta) {
          messages.push(createNormalizedMessage({
            ...envelope,
            id: stepIndex === null ? null : buildAgyMessageId(conversationId, stepIndex, 'text'),
            kind: 'stream_delta',
            content: step.text_delta,
          }));
        }
        // A finished step closes its bubble, so the next step's text starts a
        // new one below the tool cards in between.
        if (isDone || isFailed) {
          messages.push(createNormalizedMessage({
            ...envelope,
            id: stepIndex === null ? null : buildAgyMessageId(conversationId, stepIndex, 'end'),
            kind: 'stream_end',
          }));
        }
        return messages;
      }

      case 'tool': {
        // Without a step index a call cannot be paired with its result.
        if (stepIndex === null || (state !== 'ACTIVE' && !isDone && !isFailed)) {
          return [];
        }
        const toolInfo = readObjectRecord(step.tool_info) ?? {};
        const rows = translateAgyToolCall(
          readOptionalString(toolInfo.name) ?? readOptionalString(step.tool_name) ?? 'tool',
          // Stream values are raw, unlike the transcript's: they are used as
          // they are, so a JSON file's content stays text.
          readJsonRecord(toolInfo.parameters) ?? {},
        );

        return rows.map((row, rowIndex) => {
          const rowKey = buildToolRowKey(stepIndex, rowIndex, rows.length);
          const toolId = buildAgyToolId(conversationId, rowKey);
          if (state === 'ACTIVE') {
            return createNormalizedMessage({
              ...envelope,
              id: buildAgyMessageId(conversationId, rowKey, 'tool'),
              kind: 'tool_use',
              toolName: row.toolName,
              toolInput: row.toolInput,
              toolId,
            });
          }
          return createNormalizedMessage({
            ...envelope,
            id: buildAgyMessageId(conversationId, rowKey, 'result'),
            kind: 'tool_result',
            toolId,
            content: formatToolOutput(toolInfo.output),
            isError: !isDone,
          });
        });
      }

      case 'user_input':
      case 'system_message':
        return [];

      default:
        logUnknownStepType(step.step_type);
        return [];
    }
  }

  /**
   * Loads a conversation's history from its agy transcript, newest page last,
   * with the context usage of its latest response. A conversation without a
   * transcript (no steps yet) has an empty history.
   */
  async fetchHistory(sessionId: string, options: FetchHistoryOptions = {}): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    // agy names conversations by its own id; app-created sessions have another.
    const conversationId = options.providerSessionId ?? sessionId;

    let transcript: AgyTranscript | null = null;
    try {
      transcript = await readAgyTranscript(conversationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[AgyProvider] Failed to load session ${sessionId}:`, message);
    }
    if (!transcript) {
      return { messages: [], total: 0, hasMore: false, offset: normalizedOffset, limit: normalizedLimit };
    }

    // Caps oversized tool output, as for Claude and Codex.
    const messages = prepareTranscriptMessages(normalizeAgyTranscript(transcript, sessionId));
    const { page, hasMore } = sliceTailPage(messages, normalizedLimit, normalizedOffset);
    return {
      messages: page,
      total: messages.length,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
      tokenUsage: summarizeAgyTranscriptTokenUsage(transcript),
    };
  }
}
