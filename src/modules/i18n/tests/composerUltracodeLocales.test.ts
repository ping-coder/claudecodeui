import assert from 'node:assert/strict';

import { test } from 'vitest';

import { languages } from '@/modules/i18n/languages';

type ChatLocale = { composer?: Record<string, unknown> };

// Every chat.json, keyed by its locale directory ('en', 'zh-CN', ...).
const chatLocales = Object.fromEntries(
  Object.entries(
    import.meta.glob<ChatLocale>('/src/modules/i18n/locales/*/chat.json', { eager: true, import: 'default' }),
  ).map(([filePath, locale]) => [filePath.split('/').at(-2) ?? '', locale]),
);

const supportedLocales = languages.map((language) => language.value);

test('every supported language ships a chat.json', () => {
  assert.deepEqual(
    supportedLocales.filter((locale) => !chatLocales[locale]),
    [],
  );
});

test.each(supportedLocales)('%s labels the composer\'s Ultracode switch', (locale) => {
  const composer = chatLocales[locale]?.composer ?? {};

  // A product name, kept as is in every language.
  assert.equal(composer.ultracode, 'Ultracode');
  for (const key of ['ultracodeDescription', 'ultracodeOn']) {
    const text = composer[key];
    assert.equal(typeof text, 'string', `${locale}: composer.${key} is missing`);
    assert.ok((text as string).trim().length > 0, `${locale}: composer.${key} is empty`);
  }
});
