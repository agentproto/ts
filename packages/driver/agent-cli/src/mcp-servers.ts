/**
 * Shared converter from this repo's generic `AcpMcpServer[]`
 * (`{ name, transport: "stdio"|"http"|"sse", ref? }`) to the
 * `Record<string, McpServerConfig>` shape mastracode expects — both
 * for the in-process SDK config (`MastraCodeConfig.mcpServers`) and
 * for the file-based `.mastracode/mcp.json` the print arm writes.
 *
 * The target type is structurally identical in both contexts:
 *   - stdio → `{ command, args?, env? }`
 *   - http  → `{ url, headers? }`
 *   - sse   → `{ url }` (mastracode's `McpHttpServerConfig` doc says
 *             it handles SSE through the same `url` field, no separate
 *             discriminator)
 *
 * Neither `McpServerConfig`/`McpStdioServerConfig`/`McpHttpServerConfig`
 * is exported from `mastracode`'s public surface (only `.`, `./tui`,
 * `./acp`, `./headless`, `./plugin` subpaths are exported — no `./mcp`),
 * so we define a local, structurally-matching type here. TS structural
 * typing means a plain object literal shaped correctly type-checks fine
 * against `MastraCodeConfig.mcpServers` without a named import.
 *
 * Mirrors EXACTLY the same transport→field semantics the ACP arm uses
 * in `toAcpMcpServer` (`@agentproto/acp/client`), just flattened to
 * mastracode's keyed-record shape instead of the ACP wire array.
 */

import type { AcpMcpServer } from "./types.js"

/**
 * mastracode's per-server config entry (structural — not imported from
 * `mastracode`, which doesn't export these types from its public
 * surface). Detected structurally by mastracode: `command` present →
 * stdio, `url` present → http. Both keys present → entry is skipped
 * (mastracode's own validation).
 */
export type MastracodeMcpServerConfig =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { url: string; headers?: Record<string, string> }

/**
 * Convert the repo's compact `AcpMcpServer[]` into mastracode's
 * `Record<string, McpServerConfig>` keyed by server name. Returns
 * `undefined` for an empty/missing input so callers can spread the
 * result conditionally (`...(cond ? { mcpServers } : {})`).
 *
 * On key collision the caller's entry simply overwrites — this matches
 * mastracode's own "higher precedence overrides lower, by server name"
 * merge semantics for both the SDK config field and the file-based
 * load-order.
 */
export function toFileBasedMcpServers(
  servers: readonly AcpMcpServer[] | undefined,
): Record<string, MastracodeMcpServerConfig> | undefined {
  if (!servers || servers.length === 0) return undefined
  const out: Record<string, MastracodeMcpServerConfig> = {}
  for (const s of servers) {
    out[s.name] =
      s.transport === "stdio"
        ? { command: s.ref ?? "" }
        : { url: s.ref ?? "" }
  }
  return out
}
