import type { TFunction } from 'i18next';

/**
 * A provider's sign-in state as the server reports it in English, in the interface language. Used by
 * the settings account view and the onboarding cards.
 *
 * The status routes send no codes, only fixed sentences (the providers' auth facets in
 * server/modules/providers/list/<provider>/<provider>-auth.provider.ts) and fixed labels shown in place
 * of an email for a key or token sign-in. Known text is matched as written; anything else (an error
 * passed through from the file system or a CLI) comes back as it is. The English strings in the
 * settings namespace match the server's exactly, so English shows what it always did. Keys are named
 * with their namespace, so any `t` can look them up.
 */

type KnownText = { key: string; values?: Record<string, string> };

const SERVER = 'settings:agents.authStatus.server';

const AUTH_ERRORS = new Map<string, KnownText>(Object.entries({
  'Not authenticated': { key: `${SERVER}.notAuthenticated` },
  'Not logged in': { key: `${SERVER}.notLoggedIn` },
  'Claude Code CLI is not installed': { key: `${SERVER}.cliNotInstalled`, values: { agent: 'Claude Code' } },
  'Cursor CLI is not installed': { key: `${SERVER}.cliNotInstalled`, values: { agent: 'Cursor' } },
  'Cursor CLI not found or not installed': { key: `${SERVER}.cliNotFound`, values: { agent: 'Cursor' } },
  'Antigravity CLI (agy) is not installed': { key: `${SERVER}.agyNotInstalled` },
  'Not signed in. Run `agy` once in a terminal to sign in.': { key: `${SERVER}.agyNotSignedIn` },
  'Claude CLI is not authenticated. Run claude /login or configure ANTHROPIC_API_KEY.': { key: `${SERVER}.claudeNotAuthenticated` },
  'Claude login has expired. Run claude /login again.': { key: `${SERVER}.claudeLoginExpired` },
  'Unable to read Claude credentials. Run claude /login again.': { key: `${SERVER}.claudeCredentialsUnreadable` },
  'Claude credentials are unreadable. Run claude /login again.': { key: `${SERVER}.claudeCredentialsCorrupt` },
  'No valid tokens found': { key: `${SERVER}.noValidTokens` },
  'Codex not configured': { key: `${SERVER}.notConfigured`, values: { agent: 'Codex' } },
  'OpenCode not configured': { key: `${SERVER}.notConfigured`, values: { agent: 'OpenCode' } },
  'Failed to read Codex auth': { key: `${SERVER}.readFailed`, values: { agent: 'Codex' } },
  'Failed to read OpenCode auth': { key: `${SERVER}.readFailed`, values: { agent: 'OpenCode' } },
  'Failed to read Antigravity CLI status': { key: `${SERVER}.agyStatusFailed` },
  'Command timeout': { key: `${SERVER}.commandTimeout` },
  // provider-auth's own fallback when the status request fails.
  'Failed to check authentication status': { key: `${SERVER}.checkFailed` },
}));

const ACCOUNT_LABELS = new Map<string, KnownText>(Object.entries({
  'API Key Auth': { key: `${SERVER}.apiKey` },
  'Auth Token': { key: `${SERVER}.authToken` },
  'Configured via settings.json': { key: `${SERVER}.settingsFile` },
  'OAuth Token (long-lived)': { key: `${SERVER}.oauthToken` },
}));

/** OpenCode names the provider whose credentials it found: "anthropic credentials". */
const PROVIDER_CREDENTIALS = /^(\S+) credentials$/;

/** The server's placeholder for a signed-in account it knows no email for. */
const AUTHENTICATED_PLACEHOLDER = 'Authenticated';

/** All the keys this file can ask for, for the tests. */
export const PROVIDER_AUTH_TEXT_KEYS: readonly string[] = [
  ...new Set([...AUTH_ERRORS.values(), ...ACCOUNT_LABELS.values()].map(({ key }) => key)),
  `${SERVER}.providerCredentials`,
];

/** The English sentences and labels matched as written, for the tests. */
export const PROVIDER_AUTH_SERVER_TEXTS: readonly string[] = [
  ...AUTH_ERRORS.keys(),
  ...ACCOUNT_LABELS.keys(),
  AUTHENTICATED_PLACEHOLDER,
];

/** A sign-in error from the status route, in the interface language; text this file does not know comes back as it is. */
export function localizeProviderAuthError(error: string, t: TFunction): string {
  const known = AUTH_ERRORS.get(error.trim());
  return known ? t(known.key, known.values) : error;
}

/**
 * The account a signed-in agent reports, in the interface language: an email as it is, a key or token
 * sign-in by its label. Null for no account, and for the server's bare "Authenticated", which names
 * none: callers show their own word for a signed-in agent instead.
 */
export function localizeProviderAccount(account: string | null | undefined, t: TFunction): string | null {
  const text = account?.trim();
  if (!text || text === AUTHENTICATED_PLACEHOLDER) {
    return null;
  }
  const known = ACCOUNT_LABELS.get(text);
  if (known) {
    return t(known.key, known.values);
  }
  const provider = PROVIDER_CREDENTIALS.exec(text)?.[1];
  return provider ? t(`${SERVER}.providerCredentials`, { provider }) : text;
}
