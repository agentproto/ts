/**
 * resolveImportConnection — the ONE place an imported-MCP entry becomes a
 * connection config. Both connection paths call it: `McpProxyRegistry`
 * (daemon `/mcp` proxy + `/mcp/imported/<id>` native mounts) and
 * `resolveMcpServer` step 4 (MCP Apps host), so credentials and header
 * handling cannot diverge between them.
 *
 * P0: returns the snapshot verbatim (`connectionOf`). Later phases layer
 * live-source resolution and secret refs (`deps.resolveMcpSecret`) here.
 */

import type { McpConnectionConfig } from "./mcp-client-pool.js"
import type { McpCredentialDeps } from "./mcp-credential-deps.js"
import type { DiscoveredMcp } from "./mcp-discovery.js"
import type { ImportedMcpEntry } from "./mcp-imports.js"

export interface ResolvedImportConnection {
  config: McpConnectionConfig
  /** Set when the entry could not be resolved against its live source. */
  stale?: { reason: string }
}

/** The connection-relevant slice of a discovered/snapshotted server. */
export function connectionOf(m: DiscoveredMcp): McpConnectionConfig {
  return {
    type: m.type,
    ...(m.command !== undefined ? { command: m.command } : {}),
    ...(m.args !== undefined ? { args: m.args } : {}),
    ...(m.env !== undefined ? { env: m.env } : {}),
    ...(m.url !== undefined ? { url: m.url } : {}),
    ...(m.headers !== undefined ? { headers: m.headers } : {}),
  }
}

export async function resolveImportConnection(
  entry: ImportedMcpEntry,
  // Seam only in P0: secret resolution arrives with P1.
  _deps?: McpCredentialDeps
): Promise<ResolvedImportConnection> {
  return { config: connectionOf(entry.snapshot) }
}
