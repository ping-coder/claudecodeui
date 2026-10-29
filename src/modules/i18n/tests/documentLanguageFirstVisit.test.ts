import assert from 'node:assert/strict';

import { test } from 'vitest';

import { i18n } from '@/modules/i18n';
import { readUserPreference } from '@/shared/userSettings';

/**
 * A first visit: nothing is saved yet. <html> is labelled from the start, but
 * the start-up language is not a choice and must not be stored, or it would be
 * pushed over the language this user already picked on another device.
 *
 * Its own file: i18next comes from node_modules, so vi.resetModules() hands back
 * the same instance with the previous load's listeners still attached.
 */
test('a first visit labels <html> as English without storing a language', () => {
  assert.equal(i18n.language, 'en');
  assert.equal(document.documentElement.getAttribute('lang'), 'en');
  assert.equal(document.documentElement.getAttribute('dir'), 'ltr');
  assert.equal(readUserPreference<string | null>('userLanguage', null), null);
});
