/**
 * Tool-subset guard — the single mechanism that scopes which MCP tools
 * a `register*` pass actually exposes on a server.
 *
 * `withToolSubset(server, subset)` returns a Proxy where
 * `server.tool(name, …)` is a no-op when `name ∉ subset`; every other
 * call delegates to the underlying server unchanged. The orchestrator
 * sub-gateway (ADR §4.2 / WP2) wraps its per-request server with this
 * before running the normal `registerSessionTools` /
 * `registerOrchestrationTools` passes, so a scoped child orchestrator
 * only ever sees the curated allowlist (spawn / prompt / wait / poll /
 * output / list / kill) — never `command_execute`, fs, remote, import,
 * or terminal tools.
 *
 * Backward-compatible by construction: callers that don't pass a subset
 * use the raw server and register everything, exactly as before.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

export function withToolSubset(
  server: McpServer,
  subset: ReadonlySet<string>,
): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "tool") {
        // One guard for every `server.tool(name, …)` call: drop the
        // registration entirely when the name is outside the allowlist.
        return (name: string, ...rest: unknown[]): unknown => {
          if (!subset.has(name)) return undefined
          return (
            target.tool as unknown as (n: string, ...r: unknown[]) => unknown
          )(name, ...rest)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      // Bind methods to the real server so SDK internals that touch
      // private fields keep working through the proxy.
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}
