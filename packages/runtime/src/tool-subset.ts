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
      // Both SDK registration entry points must be guarded: `tool()` AND
      // `registerTool()` (the config-object overload MCP-App tools use for
      // `_meta.ui.resourceUri` — e.g. `agent_start` now carries the live
      // widget resource). Guarding only `tool()` would let a `registerTool`
      // registration slip the allowlist entirely. Mirrors deferred-tools.ts.
      if (prop === "tool" || prop === "registerTool") {
        return (name: string, ...rest: unknown[]): unknown => {
          if (!subset.has(name)) return undefined
          return (
            target[prop] as unknown as (n: string, ...r: unknown[]) => unknown
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

/**
 * The denylist complement of `withToolSubset` — blocks registration of
 * specific tool NAMES while letting everything else through unchanged.
 *
 * Used on the plain, full `/mcp` gateway (unlike the orchestrator's
 * curated allowlist, this surface registers fs/command/remote/etc. and
 * must keep doing so) to enforce the spawn-role-profiles tool gate: an
 * executor-role child still needs `command_execute`/fs tools to do real
 * work, it just must never see `agent_start`/`agent_prompt`. See
 * `DELEGATION_TOOL_NAMES` in `role.ts` and the `denyTools` query param
 * on `/mcp` in `http-server.ts`.
 */
export function withToolExclusion(
  server: McpServer,
  excluded: ReadonlySet<string>,
): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      // Guard BOTH `tool()` and `registerTool()` — see withToolSubset. The
      // executor-role gate denies `agent_start`, which is now registered via
      // `registerTool` (it carries `_meta.ui.resourceUri` for the live
      // widget), so a `tool`-only intercept would leak delegation tools to
      // an executor child.
      if (prop === "tool" || prop === "registerTool") {
        return (name: string, ...rest: unknown[]): unknown => {
          if (excluded.has(name)) return undefined
          return (
            target[prop] as unknown as (n: string, ...r: unknown[]) => unknown
          )(name, ...rest)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}
