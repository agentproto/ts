/**
 * Pure logic for the mcp-bridge's origin auto-stamp. The bridge is spawned by
 * its stdio host (Codex, Cursor, Claude Desktop, …) and inherits nothing that
 * identifies a conversation — but the host DOES announce itself in the MCP
 * `initialize` handshake (`clientInfo.name`). The bridge reads that name and
 * stamps it as the `origin` of any spawn it forwards, so a bridge-routed host
 * gets a source node in the sessions tree with zero cooperation.
 *
 * This is the honest ceiling: it identifies the HOST ("codex"), never a
 * specific conversation — a stateless shared endpoint has no per-conversation
 * signal (see #575). Descriptor-only; never overrides an origin the caller set
 * explicitly, and only touches session-creating tools.
 */

/** Tools that create a session and accept an `origin` (see agent-tools.ts). */
export const ORIGIN_STAMP_TOOLS: ReadonlySet<string> = new Set(["agent_start"])

/**
 * Return `params` with `arguments.origin` set to `hostName` when: a host name
 * is known, the tool is one that records an origin, and the caller did not
 * already provide one. Otherwise returns `params` unchanged (same reference).
 * Generic over the params shape so the forwarded call keeps its exact type.
 */
export function stampOrigin<
  T extends { name: string; arguments?: Record<string, unknown> },
>(params: T, hostName: string | undefined): T & { arguments?: Record<string, unknown> } {
  if (!hostName) return params
  if (!ORIGIN_STAMP_TOOLS.has(params.name)) return params
  const args = params.arguments
  if (args && typeof args.origin === "string" && args.origin.length > 0) return params
  return { ...params, arguments: { ...(args ?? {}), origin: hostName } }
}
