import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { afterAll, test, vi } from 'vitest';

import { i18n, LanguageSelector } from '@/modules/i18n';
import { languages } from '@/modules/i18n/languages';
import { hydrateUserPreferences } from '@/shared/userSettings';

/**
 * <html lang> picks the screen reader's voice and the browser's CJK glyph forms
 * and case rules, so it has to name the UI language from the first paint on,
 * not only after a switch.
 *
 * Runs before the imports: index.html ships lang="en", and this user chose
 * Simplified Chinese on an earlier visit, so the preference mirror holds it.
 */
vi.hoisted(() => {
  document.documentElement.setAttribute('lang', 'en');
  localStorage.setItem('user-preferences', JSON.stringify({ userLanguage: 'zh-CN' }));
});

// What the server holds for this user; a test sets it to stand in for a
// language picked on another device.
let serverPreferences: Record<string, unknown> = {};

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: async () => new Response(
        JSON.stringify({ success: true, preferences: serverPreferences }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
      savePreferences: async () => new Response('{}', { status: 200 }),
    },
  },
}));

const htmlLang = () => document.documentElement.getAttribute('lang');
const htmlDir = () => document.documentElement.getAttribute('dir');

afterAll(async () => {
  await i18n.changeLanguage('en');
});

test('the saved language is on <html> as soon as i18n loads', () => {
  assert.equal(i18n.language, 'zh-CN');
  assert.equal(htmlLang(), 'zh-CN');
  assert.equal(htmlDir(), 'ltr');
});

test('a right-to-left language turns <html> around, and back', async () => {
  await i18n.changeLanguage('he');
  assert.equal(htmlLang(), 'he');
  assert.equal(htmlDir(), 'rtl');

  await i18n.changeLanguage('ja');
  assert.equal(htmlDir(), 'ltr');
});

test('picking a language in the selector relabels <html>', () => {
  render(<LanguageSelector />);
  const select = screen.getByRole('combobox');

  fireEvent.change(select, { target: { value: 'ja' } });
  assert.equal(htmlLang(), 'ja');

  fireEvent.change(select, { target: { value: 'en' } });
  assert.equal(htmlLang(), 'en');
});

test.each([
  ['settings page', false],
  ['quick settings', true],
])('each language name in the %s selector is marked with its own language', (_surface, compact) => {
  render(<LanguageSelector compact={compact} />);

  // "עברית" read with a Chinese voice is noise: each name carries its own lang.
  const labels = screen.getAllByRole('option').map(
    (option) => `${option.textContent ?? ''} ${option.getAttribute('lang') ?? '(none)'}`,
  );
  assert.deepEqual(labels, languages.map((language) => `${language.nativeName} ${language.value}`));
});

test('a language chosen on another device reaches <html> when preferences load', async () => {
  // The picks in the selector test above wait out the store's 400 ms debounce, and a
  // pick still waiting when the read answers wins over it. Let them be saved first.
  await new Promise((resolve) => {
    setTimeout(resolve, 500);
  });
  serverPreferences = { userLanguage: 'zh-TW' };

  await hydrateUserPreferences();

  assert.equal(htmlLang(), 'zh-TW');
});

test('a code without translations is labelled as the English that is shown', async () => {
  await i18n.changeLanguage('ja');
  assert.equal(htmlLang(), 'ja');

  await i18n.changeLanguage('xx');

  // i18next keeps the requested code but falls back to the English strings.
  assert.equal(i18n.language, 'xx');
  assert.equal(htmlLang(), 'en');
  assert.equal(htmlDir(), 'ltr');
});
