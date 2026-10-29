import { Check } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';

import { LLMProviderLogo } from '@/shared/ui';
import { IsolateFreeCode } from '@/shared/ui/IsolateFreeCode';
import type { LLMProvider, ProviderAuthStatus } from '@/shared/types';
import { localizeProviderAccount, localizeProviderAuthError } from '@/modules/provider-auth-text';

type AgentConnectionCardProps = {
  provider: LLMProvider;
  title: string;
  status: ProviderAuthStatus;
  connectedClassName: string;
  iconContainerClassName: string;
  /** Colours of the Login button; only needed alongside `onLogin`. */
  loginButtonClassName?: string;
  /** Opens the embedded login shell; absent for a provider signed into from a terminal. */
  onLogin?: () => void;
  /** The command that signs the provider in from a terminal, shown in place of the Login button. */
  terminalSignInCommand?: string;
};

/** Rendered by onboarding's AgentConnectionsStep to show one CLI provider's connection state. */
export default function AgentConnectionCard({
  provider,
  title,
  status,
  connectedClassName,
  iconContainerClassName,
  loginButtonClassName,
  onLogin,
  terminalSignInCommand,
}: AgentConnectionCardProps) {
  const { t } = useTranslation('auth');
  // For a provider signed into from a terminal, a missing CLI or a missing
  // sign-in is explained by the hint below rather than shown as an error. An
  // unknown install state (the status request failed) still shows the error.
  const hintExplainsStatus = Boolean(terminalSignInCommand) && status.installed !== undefined;
  // Checked before `authenticated`: such a provider's sign-in can outlive its
  // CLI (the token stays after agy is removed), and nothing runs without the
  // CLI, so it must not read as connected.
  const isNotInstalled = Boolean(terminalSignInCommand) && status.installed === false;
  const isConnected = status.authenticated && !isNotInstalled;
  const containerClassName = isConnected ? connectedClassName : 'border-border bg-card';
  const needsSignIn = !isConnected && !status.loading;

  // The server words the account and the error in English; the ones it always words the same way
  // are shown in the interface language.
  const statusText = status.loading
    ? t('onboarding.checking')
    : isNotInstalled
      ? t('onboarding.notInstalled')
      : status.authenticated
        ? localizeProviderAccount(status.email, t) || t('onboarding.connected')
        : hintExplainsStatus || !status.error
          ? t('onboarding.notConnected')
          : localizeProviderAuthError(status.error, t);

  return (
    <div className={`rounded-xl border px-3 py-2.5 transition-colors ${containerClassName}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full ${iconContainerClassName}`}>
            <LLMProviderLogo provider={provider} className="h-5 w-5" />
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              {title}
              {isConnected && <Check className="h-3.5 w-3.5 flex-shrink-0 text-emerald-500" />}
            </div>
            {/* Laid out by its own first letter: right to left, an English error ends with its full stop on the wrong side. */}
            <div className="bidi-auto truncate text-xs text-muted-foreground" title={statusText}>{statusText}</div>
            {needsSignIn && terminalSignInCommand && (
              <p className="mt-0.5 text-xs text-muted-foreground" data-testid="terminal-sign-in-hint">
                <Trans
                  ns="auth"
                  i18nKey={isNotInstalled ? 'onboarding.terminalInstallHint' : 'onboarding.terminalSignInHint'}
                  values={{ command: terminalSignInCommand, agent: title }}
                  components={{ code: <IsolateFreeCode className="rounded bg-muted px-1 font-mono text-[11px] text-foreground" /> }}
                />
              </p>
            )}
          </div>
        </div>

        {needsSignIn && onLogin && (
          <button
            onClick={onLogin}
            className={`${loginButtonClassName ?? ''} flex-shrink-0 rounded-lg px-4 py-1.5 text-sm font-medium text-white transition-colors`}
          >
            {t('onboarding.login')}
          </button>
        )}
      </div>
    </div>
  );
}
