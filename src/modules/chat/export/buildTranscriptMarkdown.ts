import type { TFunction } from 'i18next';

import type { ChatMessage, DiffLine, LLMProvider } from '@/shared/types';
import { stripBidiIsolates } from '@/shared/direction';
import { getToolConfig } from '@/modules/chat/tools';
import {
  describeControlNote,
  describeTaskNotificationFallback,
  formatDateTime,
  formatUsageLimitText,
} from '@/modules/chat/utils/chatFormatting';
import { parseToolPayload, summarizeDiff } from '@/modules/chat/utils/messageTransforms';

type BuildTranscriptMarkdownInput = {
  messages: ChatMessage[];
  sessionTitle: string;
  provider: LLMProvider | string;
  exportedAt: Date;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  t: TFunction;
  language: string;
};

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  agy: 'Antigravity',
};

/** Fenced blocks need a longer fence than anything they contain. */
function fence(content: string): string {
  const longestRun = [...content.matchAll(/`{3,}/g)].reduce(
    (longest, match) => Math.max(longest, match[0].length),
    2,
  );
  return '`'.repeat(longestRun + 1);
}

function codeBlock(content: string, language = ''): string {
  const marker = fence(content);
  return `${marker}${language}\n${content}\n${marker}`;
}

function readString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value, null, 2);
}

/**
 * Renders one tool call the way the transcript summarizes it: what ran, on
 * what, and what came back.
 *
 * The previous exporter branched on `msg.type` alone, and a tool call is typed
 * `assistant` with empty content — so every one of them, which on an agent
 * transcript is most of the file, exported as a blank section.
 */
function renderToolCall(
  message: ChatMessage,
  createDiff: (oldStr: string, newStr: string) => DiffLine[],
  t: TFunction,
): string {
  const toolName = message.toolName || 'Tool';
  const input = parseToolPayload(message.toolInput);
  const config = getToolConfig(toolName).input;
  const lines: string[] = [];

  const contentProps = config.getContentProps?.(input ?? {}) as Record<string, unknown> | undefined;
  const filePath = typeof contentProps?.filePath === 'string' ? contentProps.filePath : undefined;

  lines.push(`**\`${toolName}\`**${filePath ? ` — \`${filePath}\`` : ''}`);

  if (
    config.contentType === 'diff'
    && typeof contentProps?.oldContent === 'string'
    && typeof contentProps?.newContent === 'string'
  ) {
    const diffLines = createDiff(contentProps.oldContent, contentProps.newContent);
    const stats = summarizeDiff(diffLines);
    lines.push('', `\`+${stats.added} -${stats.removed}\``);
    lines.push('', codeBlock(
      diffLines.map((line) => `${line.type === 'added' ? '+' : '-'}${line.content}`).join('\n'),
      'diff',
    ));
  } else {
    const rendered = readString(input);
    if (rendered.trim()) {
      lines.push('', codeBlock(rendered, rendered.trimStart().startsWith('{') ? 'json' : ''));
    }
  }

  const result = readString(message.toolResult?.content);
  if (result.trim()) {
    const label = message.toolResult?.isError ? t('chat:export.document.failed') : t('chat:export.document.result');
    lines.push('', `_${label}_`, '', codeBlock(result));
  }

  return lines.join('\n');
}

/**
 * Renders a transcript as Markdown that reads well in a plain text editor and
 * on any Markdown host, with tool calls, diffs and thinking blocks intact. Its
 * headings and labels are in the interface language (`input.t`), without the
 * bidi isolates a right-to-left interface puts around values on screen: the
 * file leaves the screen, as a copy does.
 */
export function buildTranscriptMarkdown(input: BuildTranscriptMarkdownInput): string {
  const t = ((...args: Parameters<TFunction>) => stripBidiIsolates(String(input.t(...args)))) as TFunction;
  const providerLabel = PROVIDER_LABELS[String(input.provider)] ?? t('chat:export.document.assistant');
  const sections: string[] = [
    `# ${input.sessionTitle}`,
    '',
    `_${t('chat:export.meta', { count: input.messages.length, time: formatDateTime(input.exportedAt, input.language) })}_`,
    '',
    '---',
  ];

  for (const message of input.messages) {
    sections.push('');

    if (message.isToolUse) {
      sections.push(renderToolCall(message, input.createDiff, t));
      continue;
    }

    if (message.type === 'user') {
      sections.push(`### ${t('chat:export.document.you')}`);
      sections.push('', readString(message.content));
      if (message.images?.length) {
        sections.push('', `_${t('chat:export.document.images', { count: message.images.length })}_`);
      }
      if (message.files?.length) {
        sections.push('', `_${t('chat:export.document.attached', { files: message.files.map((file) => file.name).join(', ') })}_`);
      }
      continue;
    }

    if (message.type === 'error') {
      // An error the server sent no words for reads as the transcript says it.
      const content = readString(message.content).trim() ? readString(message.content) : t('chat:misc.unknownError');
      sections.push(`### ${t('chat:messageTypes.error')}`, '', codeBlock(content));
      continue;
    }

    if (message.isThinking) {
      sections.push(`### ${t('chat:export.document.thinking', { provider: providerLabel })}`, '', readString(message.content));
      continue;
    }

    // A prompt CloudCLI sent on its own reads as a line of its own, as on screen.
    if (message.controlNote) {
      sections.push(`_${describeControlNote(message.controlNote, readString(message.content), t)}_`);
      continue;
    }

    sections.push(`### ${providerLabel}`);
    if (message.reasoning) {
      sections.push('', `<details><summary>${t('chat:export.document.reasoning')}</summary>`, '', readString(message.reasoning), '', '</details>');
    }
    const content = message.isTaskNotification && !readString(message.content).trim()
      ? describeTaskNotificationFallback(message.taskNotificationStatus, t)
      : readString(message.content);
    sections.push('', formatUsageLimitText(content, t, input.language));
  }

  return `${sections.join('\n').replace(/\n{4,}/g, '\n\n\n')}\n`;
}
