/**
 * Per-call resolver for the top-level `mcp` config block. Same discipline as
 * `resolveMessagingDefaults`: the MCP gateways rebuild their `McpServer` on
 * every request, so reading the config here makes a `config_set` change
 * take effect on the very next call without a restart.
 */

import { loadConfig } from "./config.js"
import type { McpConfig } from "./config.js"

export type NoCallerIdentityPolicy = "block" | "ask" | "accept"

export const DEFAULT_NO_CALLER_IDENTITY: NoCallerIdentityPolicy = "block"

export async function resolveMcpConfig(
  loadCfg: () => Promise<{ mcp?: McpConfig }> = loadConfig,
): Promise<McpConfig> {
  try {
    return (await loadCfg()).mcp ?? {}
  } catch {
    return {}
  }
}

export async function resolveNoCallerIdentity(
  loadCfg: () => Promise<{ mcp?: McpConfig }> = loadConfig,
): Promise<NoCallerIdentityPolicy> {
  const value = (await resolveMcpConfig(loadCfg)).noCallerIdentity
  return value === "accept" || value === "ask" ? value : DEFAULT_NO_CALLER_IDENTITY
}
