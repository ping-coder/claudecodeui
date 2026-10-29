import type { TFunction } from 'i18next';

/** Stands in for the value while the sentence is translated; never reaches the screen. */
const SLOT = '\u0000';

/**
 * A translated sentence split around one of its values, for a caller that renders the value as an
 * element of its own (in bold, say) while the translation keeps the words, the punctuation and the
 * order around it. For user text: Trans would show a "<" in it escaped. In a right-to-left language
 * the value's isolate opens at the end of the first part and closes at the start of the second, so it
 * still wraps the element.
 */
export function splitTranslationAtValue(
  t: TFunction,
  key: string,
  valueName: string,
  options: Record<string, unknown> = {},
): [string, string] {
  const text = String(t(key, { ...options, [valueName]: SLOT }));
  const at = text.indexOf(SLOT);
  return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + SLOT.length)];
}
