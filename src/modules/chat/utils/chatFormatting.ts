import type { TFunction } from 'i18next';

import type { ControlNote } from '@/shared/types';

export function normalizeInlineCodeFences(text: string) {
  if (!text || typeof text !== 'string') return text;
  try {
    return text.replace(/```[ \t]*([^\n\r]+?)[ \t]*```/g, '`$1`');
  } catch {
    return text;
  }
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes Codex's outer plan transport envelope while preserving its Markdown.
 * The closing tag is optional because streamed plans expose the opening tag
 * before the complete response arrives.
 */
export function stripProposedPlanEnvelope(text: string) {
  if (!text || typeof text !== 'string') return text;

  const openingTag = /^\s*<proposed_plan>[ \t]*(?:\r?\n)?/i;
  if (!openingTag.test(text)) return text;

  const withoutOpeningTag = text.replace(openingTag, '');
  return withoutOpeningTag.replace(/(?:\r?\n)?[ \t]*<\/proposed_plan>\s*$/i, '');
}

/**
 * The Claude CLI's usage-limit marker (`Claude AI usage limit reached|<epoch>`) as a sentence in the
 * interface language (chat:usageLimit.resetAt), with the reset time in the browser's time zone.
 * English keeps the time and date format it always had; another language formats them its own way.
 * Applied where a row is drawn (MessageComponent) and exported (buildTranscriptMarkdown), so a
 * change of language reaches rows already loaded.
 */
export function formatUsageLimitText(text: string, t: TFunction, language: string | undefined) {
  try {
    if (typeof text !== 'string') return text;
    return text.replace(/Claude AI usage limit reached\|(\d{10,13})/g, (match, ts) => {
      let timestampMs = parseInt(ts, 10);
      if (!Number.isFinite(timestampMs)) return match;
      if (timestampMs < 1e12) timestampMs *= 1000;
      const reset = new Date(timestampMs);
      const english = !language || language.startsWith('en');

      const timeStr = new Intl.DateTimeFormat(english ? undefined : language, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(reset);

      const offsetMinutesLocal = -reset.getTimezoneOffset();
      const sign = offsetMinutesLocal >= 0 ? '+' : '-';
      const abs = Math.abs(offsetMinutesLocal);
      const offH = Math.floor(abs / 60);
      const offM = abs % 60;
      const gmt = `GMT${sign}${offH}${offM ? ':' + String(offM).padStart(2, '0') : ''}`;
      const tzId = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      const cityRaw = tzId.split('/').pop() || '';
      const city = cityRaw
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, (char) => char.toUpperCase());
      const tzHuman = city ? `${gmt} (${city})` : gmt;

      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const dateReadable = english
        ? `${reset.getDate()} ${months[reset.getMonth()]} ${reset.getFullYear()}`
        : new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short', year: 'numeric' }).format(reset);

      return t('chat:usageLimit.resetAt', { time: timeStr, timezone: tzHuman, date: dateReadable });
    });
  } catch {
    return text;
  }
}

/**
 * A time of day in the interface language rather than the browser's: a
 * Chinese interface in an English browser reads 18:33:22, not 6:33:22 PM.
 * `language` is i18next's; with none, or one Intl rejects, the browser's applies.
 */
export function formatTimeOfDay(
  value: string | number | Date,
  language: string | undefined,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = new Date(value);
  try {
    return date.toLocaleTimeString(language || undefined, options);
  } catch {
    return date.toLocaleTimeString(undefined, options);
  }
}

/** A date and time in the interface language, as formatTimeOfDay does a time. */
export function formatDateTime(value: string | number | Date, language: string | undefined): string {
  const date = new Date(value);
  try {
    return date.toLocaleString(language || undefined);
  } catch {
    return date.toLocaleString();
  }
}

/**
 * What a background task's report reads when it came without a summary, in the interface
 * language: finished for a completed task, an update for any other status. Drawn by
 * MessageComponent and written by buildTranscriptMarkdown; the row keeps an empty `content`.
 */
export function describeTaskNotificationFallback(status: string | undefined, t: TFunction): string {
  return status === 'completed' ? t('chat:misc.backgroundTaskFinished') : t('chat:misc.backgroundTaskUpdate');
}

/**
 * What the note for a prompt CloudCLI sent the model on its own reads, in the interface language:
 * how many loops Claude was asked to stop, or the dynamic loop when that is all; how many loops
 * no process ran that CloudCLI resumed. `fallback` (the row's English content) for a
 * kind this client does not know. Drawn by MessageComponent and written by buildTranscriptMarkdown.
 */
export function describeControlNote(note: ControlNote, fallback: string, t: TFunction): string {
  if (note.kind === 'scheduled-stop') {
    return !note.jobIds?.length && note.wakeup
      ? t('chat:scheduledWork.stopNoteWakeup')
      : t('chat:scheduledWork.stopNote', { count: note.count });
  }
  if (note.kind === 'loops-resume') {
    return t('chat:scheduledWork.resumeNote', { count: note.count });
  }
  return fallback;
}
