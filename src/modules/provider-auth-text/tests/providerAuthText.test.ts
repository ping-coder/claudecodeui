import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, test } from 'vitest';

import { i18n } from '@/modules/i18n';
import { stripBidiIsolates } from '@/shared/direction';
import {
  PROVIDER_AUTH_SERVER_TEXTS,
  PROVIDER_AUTH_TEXT_KEYS,
  localizeProviderAccount,
  localizeProviderAuthError,
} from '@/modules/provider-auth-text/providerAuthText';

/**
 * The server words a provider's sign-in state in English and sends no codes, so the settings account
 * view and the onboarding cards match its fixed sentences and labels to translations. English keeps
 * the server's words; text the server builds on the fly (an error from the file system) is shown as is.
 */

const en = i18n.getFixedT('en', 'settings');
const zh = i18n.getFixedT('zh-CN', 'settings');
const he = i18n.getFixedT('he', 'settings');

afterAll(async () => {
  await i18n.changeLanguage('en');
});

test('every sentence and label has a key that zh-CN and he translate', () => {
  const untranslated = PROVIDER_AUTH_TEXT_KEYS.filter((key) => {
    const [ns, path] = key.split(':');
    return !['en', 'zh-CN', 'he'].every((language) => typeof i18n.getResource(language, ns, path) === 'string');
  });
  assert.deepEqual(untranslated, []);
});

test('English shows the server\'s own words, zh-CN and he their translation', () => {
  const sentences = PROVIDER_AUTH_SERVER_TEXTS.filter((text) => text !== 'Authenticated');
  const shown = (t: typeof en, text: string) => localizeProviderAuthError(text, t) === text
    ? localizeProviderAccount(text, t)
    : localizeProviderAuthError(text, t);

  assert.deepEqual(sentences.map((text) => shown(en, text)), sentences);
  assert.deepEqual(sentences.filter((text) => shown(zh, text) === text), []);
  assert.deepEqual(sentences.filter((text) => stripBidiIsolates(shown(he, text) ?? '') === text), []);
});

test('a sentence fills in the provider it names', () => {
  assert.equal(localizeProviderAuthError('Codex not configured', zh), 'Codex 未配置');
  assert.equal(localizeProviderAuthError('Cursor CLI not found or not installed', zh), '找不到 Cursor CLI，或者没有安装');
  assert.equal(
    stripBidiIsolates(localizeProviderAuthError('Claude Code CLI is not installed', he)),
    'ה-CLI של Claude Code לא מותקן',
  );
  assert.equal(
    localizeProviderAuthError('Claude CLI is not authenticated. Run claude /login or configure ANTHROPIC_API_KEY.', zh),
    'Claude CLI 未登录。运行 claude /login，或者配置 ANTHROPIC_API_KEY。',
  );
});

test('text the server builds on the fly comes back as it is', () => {
  for (const text of ["EACCES: permission denied, open '/home/u/.codex/auth.json'", 'constructor', '__proto__', 'toString']) {
    assert.equal(localizeProviderAuthError(text, zh), text);
    assert.equal(localizeProviderAccount(text, zh), text);
  }
});

test('the account: an email as it is, a key or token sign-in by its label, the bare "Authenticated" as none', () => {
  assert.equal(localizeProviderAccount('dana@example.com', zh), 'dana@example.com');
  assert.equal(localizeProviderAccount('API Key Auth', zh), 'API 密钥');
  assert.equal(localizeProviderAccount('OAuth Token (long-lived)', zh), 'OAuth 令牌（长期有效）');
  assert.equal(localizeProviderAccount('anthropic credentials', zh), 'anthropic 凭据');
  assert.equal(localizeProviderAccount('anthropic credentials', en), 'anthropic credentials');
  assert.equal(localizeProviderAccount('Authenticated', zh), null);
  assert.equal(localizeProviderAccount(null, zh), null);
  assert.equal(localizeProviderAccount('', zh), null);
});

// Resolved from this file's path: under jsdom, URL is jsdom's class, which node:url does not accept.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

test('every sentence and label is still written that way by the server', () => {
  const sources = [
    ...['agy', 'claude', 'codex', 'cursor', 'opencode'].map((provider) => (
      `server/modules/providers/list/${provider}/${provider}-auth.provider.ts`
    )),
    // The hook's own fallback when the status request fails.
    'src/modules/provider-auth/hooks/useProviderAuthStatus.ts',
  ].map((file) => readFileSync(join(ROOT, file), 'utf8')).join('\n');
  // A sentence with the provider filled in may be written with the provider as a literal or not at all.
  const written = (text: string) => sources.includes(`'${text}'`) || sources.includes(`\`${text}\``);
  assert.deepEqual(PROVIDER_AUTH_SERVER_TEXTS.filter((text) => !written(text)), []);
  assert.equal(sources.includes('`${providerId} credentials`'), true);
});
