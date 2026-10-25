import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { ProviderMcpServer } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Antigravity MCP adapter with no supported scopes: CloudCLI does not manage
 * agy's MCP config, so listing reports nothing, writes fail with the base
 * class's MCP_SCOPE_NOT_SUPPORTED error, and "add to all providers" skips agy
 * (see `supportsScope`). Nothing under ~/.gemini is ever read or written.
 * Used by AgyProvider as its MCP facet.
 */
export class AgyMcpProvider extends McpProvider {
  constructor() {
    super('agy', [], []);
  }

  protected async readScopedServers(): Promise<Record<string, unknown>> {
    return {};
  }

  // Unreachable: the base class rejects every scope before writing.
  protected async writeScopedServers(): Promise<void> {
    throw new AppError('Antigravity MCP servers are not managed by CloudCLI.', {
      code: 'MCP_SCOPE_NOT_SUPPORTED',
      statusCode: 400,
    });
  }

  protected buildServerConfig(): Record<string, unknown> {
    throw new AppError('Antigravity MCP servers are not managed by CloudCLI.', {
      code: 'MCP_SCOPE_NOT_SUPPORTED',
      statusCode: 400,
    });
  }

  protected normalizeServerConfig(): ProviderMcpServer | null {
    return null;
  }
}
