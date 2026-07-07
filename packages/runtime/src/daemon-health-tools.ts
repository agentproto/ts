/**
 * MCP tool for a cheap, read-only daemon liveness probe.
 *
 * `daemon_health` returns the same data as `GET /health` but in-process:
 * no HTTP round-trip, no side effects. It is intended for orchestrating
 * clients that want an unambiguous "is the daemon still serving me?" check
 * without shelling out or firing a heavier operation.
 *
 * Because the tool only runs if the daemon that hosts it is alive and
 * serving MCP requests, the `alive` field is always `true` on a successful
 * return. The real failure mode this protects against is the client's
 * request itself failing or timing out at the transport level — observed as
 * a thrown/failed tool call, not as a `false` field in the response.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

export interface RegisterDaemonHealthToolsOptions {
  workspace: string
  registered: readonly string[]
  startedAt: number
}

function text(value: string | object): {
  content: Array<{ type: "text"; text: string }>
} {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  }
}

export function registerDaemonHealthTools(
  server: McpServer,
  opts: RegisterDaemonHealthToolsOptions,
): void {
  server.tool(
    "daemon_health",
    "Cheap, side-effect-free liveness probe for this daemon. Returns the same " +
      "fields as GET /health but in-process. `alive` is always true when the tool " +
      "returns successfully; if the daemon is unreachable the failure is observed " +
      "as a thrown/failed tool call at the transport level, not as a false field.",
    {},
    async () => {
      return text({
        alive: true,
        status: "ok",
        workspace: opts.workspace,
        registered: opts.registered,
        uptimeMs: Date.now() - opts.startedAt,
      })
    },
  )
}
