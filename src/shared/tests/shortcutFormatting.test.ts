import assert from 'node:assert/strict';

import { afterEach, test } from 'vitest';

import { formatShortcut, isApplePlatform } from '@/shared/utils';

/**
 * Shortcut labels for tooltips, menus and hints: Apple platforms draw the modifier glyphs
 * back to back, everyone else spells them out joined by "+". The platform is read at call time.
 */

const setPlatform = (platform: string, userAgentDataPlatform?: string) => {
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true });
  Object.defineProperty(window.navigator, 'userAgentData', {
    value: userAgentDataPlatform === undefined ? undefined : { platform: userAgentDataPlatform },
    configurable: true,
  });
};

afterEach(() => {
  // Drop the own properties so the jsdom navigator answers again.
  delete (window.navigator as unknown as Record<string, unknown>).platform;
  delete (window.navigator as unknown as Record<string, unknown>).userAgentData;
});

test('Apple platforms are recognised from navigator.platform, and from userAgentData where Chromium has it', () => {
  for (const platform of ['MacIntel', 'iPhone', 'iPad', 'iPod touch']) {
    setPlatform(platform);
    assert.equal(isApplePlatform(), true, platform);
  }
  for (const platform of ['Win32', 'Linux x86_64', 'Linux armv81', '']) {
    setPlatform(platform);
    assert.equal(isApplePlatform(), false, platform);
  }
  setPlatform('', 'macOS');
  assert.equal(isApplePlatform(), true);
  setPlatform('MacIntel', 'Windows');
  assert.equal(isApplePlatform(), false, 'userAgentData is the more reliable source when present');
});

test('Apple platforms draw modifier glyphs back to back', () => {
  setPlatform('MacIntel');
  assert.equal(formatShortcut(['mod', 'shift', 'enter']), '⌘⇧↵');
  assert.equal(formatShortcut(['mod', 'K']), '⌘K');
  assert.equal(formatShortcut(['mod', '\\']), '⌘\\');
  assert.equal(formatShortcut(['alt', 'k']), '⌥K');
});

test('other platforms spell modifiers out, joined by "+"', () => {
  setPlatform('Win32');
  assert.equal(formatShortcut(['mod', 'shift', 'enter']), 'Ctrl+Shift+Enter');
  assert.equal(formatShortcut(['mod', 'K']), 'Ctrl+K');
  assert.equal(formatShortcut(['mod', '1']), 'Ctrl+1');
  assert.equal(formatShortcut(['alt', 'Enter']), 'Alt+Enter');
});

test('reserved tokens match case-insensitively; other labels pass through, single letters upper-cased', () => {
  setPlatform('Linux x86_64');
  assert.equal(formatShortcut(['Mod', 'ENTER']), 'Ctrl+Enter');
  assert.equal(formatShortcut(['mod', 'PageDown']), 'Ctrl+PageDown');
  assert.equal(formatShortcut(['constructor']), 'constructor', 'a label never resolves to an Object prototype member');
});

test('the platform is read on every call, not once at import', () => {
  setPlatform('Win32');
  assert.equal(formatShortcut(['mod', 'K']), 'Ctrl+K');
  setPlatform('MacIntel');
  assert.equal(formatShortcut(['mod', 'K']), '⌘K');
});
