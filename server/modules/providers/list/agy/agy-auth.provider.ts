import { isAgyOauthTokenPresent, resolveAgyCliPath } from '@/shared/agy-cli-path.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

/**
 * Antigravity CLI status, read without running agy: "installed" means the
 * binary resolves (AGY_CLI_PATH, PATH, ~/.local/bin), and "authenticated"
 * means it is installed and agy's OAuth token file exists. The token's
 * contents are never read. There is no login flow in CloudCLI; signing in
 * happens by running `agy` in a terminal. Used by AgyProvider as its auth
 * facet (provider status routes, and the runtime context's install check).
 */
export class AgyProviderAuth implements IProviderAuth {
  async getStatus(): Promise<ProviderAuthStatus> {
    try {
      const installed = resolveAgyCliPath() !== null;
      // A token left behind (agy uninstalled, or signed in with a binary
      // outside the lookup path) is no usable sign-in: every turn would fail
      // as "not installed", so it must not read as connected.
      const authenticated = installed && isAgyOauthTokenPresent();
      let error: string | undefined;
      if (!installed) {
        error = 'Antigravity CLI (agy) is not installed';
      } else if (!authenticated) {
        error = 'Not signed in. Run `agy` once in a terminal to sign in.';
      }

      return {
        installed,
        provider: 'agy',
        authenticated,
        email: null,
        method: authenticated ? 'oauth' : null,
        error,
      };
    } catch (error) {
      return {
        installed: false,
        provider: 'agy',
        authenticated: false,
        email: null,
        method: null,
        error: error instanceof Error ? error.message : 'Failed to read Antigravity CLI status',
      };
    }
  }
}
