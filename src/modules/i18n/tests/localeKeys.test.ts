import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from 'vitest';

import { i18n } from '@/modules/i18n';
import allowedMissing from '@/modules/i18n/tests/allowedMissing.json';

/**
 * The locale files stay in step with en. Simplified Chinese and Hebrew translate
 * every en key, so neither interface falls back to English, keep no key en
 * dropped, and keep the {{values}} and the tags of the English string. No
 * language uses a {{value}} its English string does not have: the code no longer
 * passes it, and the placeholder would show as typed. Every key the code asks for
 * exists in en, so a defaultValue in the code is never the only copy of a string.
 */

type Tree = { [key: string]: string | Tree };
type Flat = Record<string, string>;

const TARGETS = ['zh-CN', 'he'] as const;
type Target = (typeof TARGETS)[number];

/**
 * Keys a language may leave to the English fallback, each with the reason; "ns:prefix.*"
 * covers a group. Meant to stay short.
 */
const ALLOWED_MISSING: Record<Target, Record<string, string>> = allowedMissing;

function flatten(tree: Tree, prefix = '', out: Flat = {}): Flat {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[path] = value;
    else flatten(value, path, out);
  }
  return out;
}

// locales[language][namespace] = flat key -> string
const locales: Record<string, Record<string, Flat>> = {};
const files = import.meta.glob<Tree>('/src/modules/i18n/locales/*/*.json', { eager: true, import: 'default' });
for (const [path, tree] of Object.entries(files)) {
  const [language, file] = path.split('/').slice(-2);
  (locales[language] ??= {})[file.replace(/\.json$/, '')] = flatten(tree);
}

const PLURAL = /^(.*)_(zero|one|two|few|many|other)$/;
const categoriesOf = (language: string) => new Intl.PluralRules(language).resolvedOptions().pluralCategories as string[];

/** en keys with their plural forms folded into one: key -> plural or not. */
function englishKeys(ns: string): Map<string, boolean> {
  const keys = new Map<string, boolean>();
  const en = locales.en[ns];
  for (const key of Object.keys(en)) {
    const match = key.match(PLURAL);
    const plural = Boolean(match && (en[`${match[1]}_one`] !== undefined || en[`${match[1]}_other`] !== undefined));
    keys.set(plural ? match![1] : key, plural);
  }
  return keys;
}

/** i18next finds key_<category> for the count, else the bare key: either satisfies a lookup. */
function missingIn(language: Target): string[] {
  const categories = categoriesOf(language);
  const missing: string[] = [];
  for (const ns of Object.keys(locales.en)) {
    const target = locales[language][ns] ?? {};
    for (const key of englishKeys(ns).keys()) {
      const hasEveryForm = categories.every((category) => target[`${key}_${category}`] !== undefined);
      if (target[key] === undefined && !hasEveryForm) missing.push(`${ns}:${key}`);
    }
  }
  return missing;
}

const allowedEntryCovers = (entry: string, key: string) => (entry.endsWith('.*') ? key.startsWith(entry.slice(0, -1)) : key === entry);

/** The English string a translated key is measured against; a bare key stands for every plural form. */
function englishFor(ns: string, key: string): string | undefined {
  const en = locales.en[ns] ?? {};
  if (en[key] !== undefined) return en[key];
  const match = key.match(PLURAL);
  return match ? en[`${match[1]}_other`] ?? en[match[1]] : en[`${key}_other`];
}

const valuesIn = (text: string) => new Set([...text.matchAll(/\{\{-?\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1]));
const tagsIn = (text: string) => [...text.matchAll(/<\/?([a-z]+|\d+)\s*\/?>/g)].map((m) => m[0]).sort();

test.each(TARGETS)('%s has every namespace en has, registered with i18n', (language) => {
  assert.deepEqual(
    Object.keys(locales.en).filter((ns) => !locales[language][ns] || !i18n.hasResourceBundle(language, ns)),
    [],
  );
});

test.each(TARGETS)('%s translates every en key', (language) => {
  const allowed = Object.keys(ALLOWED_MISSING[language]);
  assert.deepEqual(missingIn(language).filter((key) => !allowed.some((entry) => allowedEntryCovers(entry, key))), []);
});

test.each(TARGETS)('%s lists only keys that are really missing as allowed', (language) => {
  const missing = missingIn(language);
  assert.deepEqual(
    Object.keys(ALLOWED_MISSING[language]).filter((entry) => !missing.some((key) => allowedEntryCovers(entry, key))),
    [],
  );
});

test.each(TARGETS)('%s keeps no key en does not have', (language) => {
  const extra: string[] = [];
  for (const [ns, target] of Object.entries(locales[language])) {
    for (const key of Object.keys(target)) {
      if (englishFor(ns, key) === undefined) extra.push(`${ns}:${key}`);
    }
  }
  assert.deepEqual(extra, []);
});

test.each(TARGETS)('%s keeps the values and tags of the English string', (language) => {
  const mismatched: string[] = [];
  for (const [ns, target] of Object.entries(locales[language])) {
    for (const [key, text] of Object.entries(target)) {
      const english = englishFor(ns, key);
      if (english === undefined) continue;
      const theirs = valuesIn(english);
      const ours = valuesIn(text);
      // "one" and "two" may say the number in words ("שני קבצים").
      const category = key.match(PLURAL)?.[2];
      if (category && category !== 'other') theirs.delete('count');
      const lost = [...theirs].filter((value) => !ours.has(value));
      const added = [...ours].filter((value) => !valuesIn(english).has(value));
      if (lost.length || added.length || tagsIn(english).join() !== tagsIn(text).join()) mismatched.push(`${ns}:${key}`);
    }
  }
  assert.deepEqual(mismatched, []);
});

test('no language uses a {{value}} its English string does not have', () => {
  const unknown: string[] = [];
  for (const [language, namespaces] of Object.entries(locales)) {
    if (language === 'en') continue;
    for (const [ns, target] of Object.entries(namespaces)) {
      for (const [key, text] of Object.entries(target)) {
        const english = englishFor(ns, key);
        if (english === undefined) continue;
        const known = valuesIn(english);
        // A plural form may show the count even where the English form leaves it out.
        if (PLURAL.test(key) || english !== locales.en[ns]?.[key]) known.add('count');
        const added = [...valuesIn(text)].filter((value) => !known.has(value));
        if (added.length) unknown.push(`${language}/${ns}:${key} {{${added.join('}}, {{')}}}`);
      }
    }
  }
  assert.deepEqual(unknown, []);
});

// Resolved from this file's path rather than with `new URL(…, import.meta.url)`: under
// jsdom, URL is jsdom's class, which node:url does not accept.
const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('every key the code passes to t() or Trans exists in en', () => {
  const inEnglish = (raw: string) => {
    const [ns, key] = raw.includes(':') ? [raw.slice(0, raw.indexOf(':')), raw.slice(raw.indexOf(':') + 1)] : [null, raw];
    return (ns ? [ns] : Object.keys(locales.en)).some((name) => {
      const en = locales.en[name];
      return en !== undefined && (en[key] !== undefined || en[`${key}_other`] !== undefined || Object.keys(en).some((k) => k.startsWith(`${key}.`)));
    });
  };
  const absent = new Set<string>();
  const sources = readdirSync(SOURCE_ROOT, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file) && !/(^|\/)tests?\/|\.test\.tsx?$|\.d\.ts$/.test(file));
  for (const file of sources) {
    const source = readFileSync(join(SOURCE_ROOT, file), 'utf8');
    const keys = [
      ...[...source.matchAll(/\bt\(\s*(['"])([\w.:-]+)\1\s*[,)]/g)].map((m) => m[2]),
      ...[...source.matchAll(/i18nKey=(?:"([\w.:-]+)"|\{([^}]*)\})/g)].flatMap((m) => (m[1] ? [m[1]] : [...m[2].matchAll(/'([\w.:-]+)'/g)].map((q) => q[1]))),
    ];
    for (const key of keys) if (!inEnglish(key)) absent.add(`${key} (${file})`);
  }
  assert.deepEqual([...absent], []);
});
