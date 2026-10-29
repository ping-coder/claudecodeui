import { AlertTriangle, LogIn, Terminal } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';

import { PROVIDER_TERMINAL_SIGN_IN_COMMANDS } from '@/shared/constants';
import { Badge, Button, LLMProviderLogo } from '@/shared/ui';
import type { AgentProvider, ProviderAuthStatus, ProviderAuthSubscriptionOverride } from '@/shared/types';

type AccountContentProps = {
  agent: AgentProvider;
  authStatus: ProviderAuthStatus;
  /** Opens the embedded login shell; absent for an agent signed into from a terminal. */
  onLogin?: () => void;
};

type AgentVisualConfig = {
  name: string;
  bgClass: string;
  borderClass: string;
  textClass: string;
  subtextClass: string;
  /** Colours of the Login button; absent for an agent signed into from a terminal. */
  buttonClass?: string;
  description?: string;
};

const agentConfig: Record<AgentProvider, AgentVisualConfig> = {
  claude: {
    name: 'Claude',
    bgClass: 'bg-blue-50 dark:bg-blue-900/20',
    borderClass: 'border-blue-200 dark:border-blue-800',
    textClass: 'text-blue-900 dark:text-blue-100',
    subtextClass: 'text-blue-700 dark:text-blue-300',
    buttonClass: 'bg-blue-600 hover:bg-blue-700 active:bg-blue-800',
  },
  cursor: {
    name: 'Cursor',
    bgClass: 'bg-purple-50 dark:bg-purple-900/20',
    borderClass: 'border-purple-200 dark:border-purple-800',
    textClass: 'text-purple-900 dark:text-purple-100',
    subtextClass: 'text-purple-700 dark:text-purple-300',
    buttonClass: 'bg-purple-600 hover:bg-purple-700 active:bg-purple-800',
  },
  codex: {
    name: 'Codex',
    bgClass: 'bg-muted/50',
    borderClass: 'border-gray-300 dark:border-gray-600',
    textClass: 'text-gray-900 dark:text-gray-100',
    subtextClass: 'text-gray-700 dark:text-gray-300',
    buttonClass: 'bg-gray-800 hover:bg-gray-900 active:bg-gray-950 dark:bg-gray-700 dark:hover:bg-gray-600 dark:active:bg-gray-500',
  },
  opencode: {
    name: 'OpenCode',
    description: 'OpenCode CLI assistant',
    bgClass: 'bg-zinc-50 dark:bg-zinc-900/20',
    borderClass: 'border-zinc-200 dark:border-zinc-700',
    textClass: 'text-zinc-900 dark:text-zinc-100',
    subtextClass: 'text-zinc-700 dark:text-zinc-300',
    buttonClass: 'bg-zinc-900 hover:bg-zinc-800 active:bg-zinc-950 dark:bg-zinc-700 dark:hover:bg-zinc-600',
  },
  agy: {
    name: 'Antigravity',
    description: 'Antigravity CLI assistant',
    bgClass: 'bg-cyan-50 dark:bg-cyan-900/20',
    borderClass: 'border-cyan-200 dark:border-cyan-800',
    textClass: 'text-cyan-900 dark:text-cyan-100',
    subtextClass: 'text-cyan-700 dark:text-cyan-300',
  },
};

type SubscriptionOverrideNoticeProps = {
  override: ProviderAuthSubscriptionOverride;
};

// Issue #568: Claude Code prefers ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN over
// the `claude /login` subscription and says nothing about it, so a subscriber
// who also has a key in the server env is billed pay-as-you-go without knowing.
// The server only reports the override while a usable login is really being
// bypassed, so this stays out of the way for key-only and login-only setups.
function SubscriptionOverrideNotice({ override }: SubscriptionOverrideNoticeProps) {
  const { t } = useTranslation('settings');
  const source = t(`agents.subscriptionOverride.source.${override.source}`);
  const description = override.subscriptionEmail
    ? t('agents.subscriptionOverride.descriptionWithEmail', {
      variable: override.variable,
      source,
      email: override.subscriptionEmail,
    })
    : t('agents.subscriptionOverride.description', { variable: override.variable, source });

  return (
    <div
      role="alert"
      data-testid="provider-auth-subscription-override"
      className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-900/30"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="space-y-1 text-sm text-amber-900 dark:text-amber-100">
          <div className="font-medium">{t('agents.subscriptionOverride.title')}</div>
          <p>{description}</p>
          <p>{t(`agents.subscriptionOverride.fix.${override.source}`, { variable: override.variable })}</p>
        </div>
      </div>
    </div>
  );
}

/** Rendered by AgentCategoryContentSection for the "account" category to show sign-in state for one provider. */
export default function AccountContent({ agent, authStatus, onLogin }: AccountContentProps) {
  const { t } = useTranslation('settings');
  const config = agentConfig[agent];
  const terminalSignInCommand = PROVIDER_TERMINAL_SIGN_IN_COMMANDS[agent];
  // For an agent signed into from a terminal, a missing CLI or a missing
  // sign-in is explained by the hint below rather than reported as an error.
  // An unknown install state (the status request failed) still shows the error.
  const hintExplainsStatus = Boolean(terminalSignInCommand)
    && !authStatus.loading
    && authStatus.installed !== undefined;
  // Checked before `authenticated` everywhere below: such an agent's sign-in
  // can outlive its CLI (the token stays after agy is removed), and nothing
  // runs without the CLI, so it must not read as connected.
  const isNotInstalled = Boolean(terminalSignInCommand) && authStatus.installed === false;
  const isConnected = authStatus.authenticated && !isNotInstalled;

  return (
    <div className="space-y-6">
      <div className="mb-4 flex items-center gap-3">
        <LLMProviderLogo provider={agent} className="h-6 w-6" />
        <div>
          <h3 className="text-lg font-medium text-foreground">{config.name}</h3>
          <p className="text-sm text-muted-foreground">
            {t(`agents.account.${agent}.description`, {
              defaultValue: config.description || `${config.name} CLI assistant`,
            })}
          </p>
        </div>
      </div>

      <div className={`${config.bgClass} border ${config.borderClass} rounded-lg p-4`}>
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className={`font-medium ${config.textClass}`}>
                {t('agents.connectionStatus')}
              </div>
              <div className={`text-sm ${config.subtextClass}`}>
                {authStatus.loading ? (
                  t('agents.authStatus.checkingAuth')
                ) : isNotInstalled ? (
                  t('agents.authStatus.cliNotInstalled', { agent: config.name })
                ) : authStatus.authenticated ? (
                  t('agents.authStatus.loggedInAs', {
                    email: authStatus.email || t('agents.authStatus.authenticatedUser'),
                  })
                ) : (
                  t('agents.authStatus.notConnected')
                )}
              </div>
            </div>
            <div>
              {authStatus.loading ? (
                <Badge variant="secondary" className="bg-muted">
                  {t('agents.authStatus.checking')}
                </Badge>
              ) : isNotInstalled ? (
                <Badge variant="secondary" className="bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300">
                  {t('agents.authStatus.notInstalled')}
                </Badge>
              ) : authStatus.authenticated ? (
                <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
                  {t('agents.authStatus.connected')}
                </Badge>
              ) : (
                <Badge variant="secondary" className="bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300">
                  {t('agents.authStatus.disconnected')}
                </Badge>
              )}
            </div>
          </div>

          {!authStatus.loading && authStatus.subscriptionOverride && (
            <SubscriptionOverrideNotice override={authStatus.subscriptionOverride} />
          )}

          {onLogin && authStatus.method !== 'api_key' && (
            <div className="border-t border-border/50 pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className={`font-medium ${config.textClass}`}>
                    {authStatus.authenticated ? t('agents.login.reAuthenticate') : t('agents.login.title')}
                  </div>
                  <div className={`text-sm ${config.subtextClass}`}>
                    {authStatus.authenticated
                      ? t('agents.login.reAuthDescription')
                      : t('agents.login.description', { agent: config.name })}
                  </div>
                </div>
                <Button
                  onClick={onLogin}
                  className={`${config.buttonClass ?? ''} text-white`}
                  size="sm"
                >
                  <LogIn className="me-2 h-4 w-4" />
                  {authStatus.authenticated ? t('agents.login.reLoginButton') : t('agents.login.button')}
                </Button>
              </div>
            </div>
          )}

          {terminalSignInCommand && !authStatus.loading && !isConnected && (
            <div className="border-t border-border/50 pt-4" data-testid="provider-terminal-sign-in">
              <div className={`flex items-center gap-2 font-medium ${config.textClass}`}>
                <Terminal className="h-4 w-4 flex-shrink-0" />
                {t('agents.terminalLogin.title')}
              </div>
              <div className={`mt-1 text-sm ${config.subtextClass}`}>
                <Trans
                  ns="settings"
                  i18nKey={isNotInstalled ? 'agents.terminalLogin.installDescription' : 'agents.terminalLogin.description'}
                  values={{ command: terminalSignInCommand, agent: config.name }}
                  components={{ code: <code className="rounded bg-background/70 px-1 font-mono text-xs" /> }}
                />
              </div>
            </div>
          )}

          {authStatus.error && !hintExplainsStatus && (
            <div className="border-t border-border/50 pt-4">
              <div className="text-sm text-red-600 dark:text-red-400">
                {t('agents.error', { error: authStatus.error })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
