import assert from 'node:assert/strict';

import { test } from 'vitest';

import { i18n } from '@/modules/i18n';

/**
 * Bidi controls in the locale files. Left-to-right languages carry none. In a
 * right-to-left language every isolate is closed, embeddings and overrides are not
 * used, and a code-like Latin fragment (".gitignore", "~/.claude", "+{{count}}",
 * "⌃⌘F", "v{{version}}") sits inside LRI…PDI: in a right-to-left sentence the
 * algorithm would move the neutral character at its edge. So do two values joined
 * by "×", "–", "—" or "~": between numbers those turn right to left, and
 * "{{width}}×{{height}}" would show as 900×1400.
 */

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[path] = value;
    else flatten(value, path, out);
  }
  return out;
}

// strings[language] = ['ns:key', text][]
const strings: Record<string, Array<[string, string]>> = {};
const files = import.meta.glob<Tree>('/src/modules/i18n/locales/*/*.json', { eager: true, import: 'default' });
for (const [path, tree] of Object.entries(files)) {
  const [language, file] = path.split('/').slice(-2);
  const ns = file.replace(/\.json$/, '');
  for (const [key, text] of Object.entries(flatten(tree))) (strings[language] ??= []).push([`${ns}:${key}`, text]);
}
const languages = Object.keys(strings);
const rightToLeft = languages.filter((language) => i18n.dir(language) === 'rtl');
const leftToRight = languages.filter((language) => i18n.dir(language) !== 'rtl');

/** Code-like fragments a right-to-left string may keep outside an isolate, each with the reason. */
const ALLOWED_BARE: Record<string, string> = {};

const ANY_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const EMBEDDING_OR_OVERRIDE = /[\u202A-\u202E]/;

/** Every LRI, RLI and FSI is closed by a PDI, and no PDI closes nothing. */
function isolatesBalanced(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === '\u2066' || ch === '\u2067' || ch === '\u2068') depth += 1;
    else if (ch === '\u2069') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

const HEBREW_OR_ARABIC = /[\u0590-\u08FF]/;
const ISOLATED = /[\u2066\u2067\u2068][^\u2066-\u2069]*\u2069/g;
const TRANS_TAG = /<\/?(?:[a-z]+|\d+)\s*\/?>/g;
const VALUE = /\{\{[^}]+\}\}/g;
const SYMBOL = /[⌘⌃⌥⇧↵]/;
// Two values joined by a neutral the algorithm reverses between numbers (unlike "/", ":", "-", "%").
const JOINED_VALUES = /\{\{[^}]+\}\}\s*[×–—~]\s*\{\{[^}]+\}\}/g;
// Neutral or weak characters the algorithm moves off the edge of a Latin phrase.
const EDGE_START = /^[./~+\-#@$<↑↓←→⌘⌃⌥⇧↵]/;
const EDGE_END = /[/~+\-#@$>⌘⌃⌥⇧↵]$/;

/** Outside isolates: values joined as above, and Latin phrases that start or end with such a character or glue a letter to a value. */
function bareFragments(text: string): string[] {
  const outside = text.replace(TRANS_TAG, '').replace(ISOLATED, ' ');
  const found = [...(outside.match(JOINED_VALUES) ?? [])];
  const rtlScript = HEBREW_OR_ARABIC.test(outside);
  const parts = rtlScript ? outside.split(/[\u0590-\u08FF]+/) : [outside];
  parts.forEach((part, index) => {
    for (let phrase of part.split(/ [·•|\-–—] |, |; /)) {
      if (index > 0) phrase = phrase.replace(/^[-\u05BE]/, ''); // the hyphen of a prefix letter: ב-commit
      phrase = phrase.trim()
        .replace(/^(?:[:;,!?…]|\.(?=\s))+/, '')
        .trim()
        .replace(/^[("'“„«[`*]+/, '')
        .replace(/[)"'”»\]`*.,;:!?…]+$/, '')
        .trim();
      if (!phrase || !(/[A-Za-z0-9]/.test(phrase) || /\{\{/.test(phrase) || SYMBOL.test(phrase))) continue;
      const plain = phrase.replace(VALUE, 'X');
      const onlyValues = phrase.replace(VALUE, '').replace(/[\s/%()\-]/g, '') === '';
      const glued = !onlyValues && /[A-Za-z0-9+#~./↑↓⌘⌃⌥⇧]\{\{|\}\}[A-Za-z0-9+#~/]/.test(phrase);
      if (EDGE_START.test(plain) || EDGE_END.test(plain) || glued || (rtlScript && SYMBOL.test(plain))) found.push(phrase);
    }
  });
  return found;
}

test.each(leftToRight)('%s has no bidi control characters', (language) => {
  assert.deepEqual(strings[language].filter(([, text]) => ANY_CONTROL.test(text)).map(([key]) => key), []);
});

test.each(rightToLeft)('%s closes every isolate and uses no embedding or override', (language) => {
  assert.deepEqual(
    strings[language].filter(([, text]) => !isolatesBalanced(text) || EMBEDDING_OR_OVERRIDE.test(text)).map(([key]) => key),
    [],
  );
});

test.each(rightToLeft)('%s keeps code-like Latin fragments inside LRI…PDI', (language) => {
  const bare = strings[language]
    .filter(([key]) => !(key in ALLOWED_BARE))
    .flatMap(([key, text]) => bareFragments(text).map((fragment) => `${key}: ${fragment}`));
  assert.deepEqual(bare, []);
});
