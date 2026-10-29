/**
 * Call-time gate for the tool deny grants a session carries from its AGENT
 * manifest (`SessionDescriptor.toolDenyGrants`, see `spawn-agent-manifest.ts`).
 *
 * The grants are composed as one policy `{ default: "allow", grants: denyGrants }`, so the
 * only way a call is refused is an explicit deny (or grants that cannot be
 * read): a session is never switched to AIP-38 default deny. The decision is
 * `decide("tool.invoke")`, the same engine as every other grant check.
 *
 * Two dispatch sites use it: `withToolDenyGate` wraps the handlers of the
 * built-ins (`agentproto/<name>`) on the `/mcp` server a session reaches, and
 * `createImportedCallGuard` calls `toolDenyRefusal` for `<server>/<name>`. A
 * caller with no grants is never evaluated, so nothing changes for it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Grant } from "@agentproto/policy"

import { decide, type Decision } from "./permissions.js"

export interface ToolDenyRefusal {
  /** The qualified `<server>/<name>` that was refused. */
  tool: string
  rule: string
  /** Names the tool and the grant that refused it. */
  reason: string
}

/** The refusal for `tool` (a bare built-in name or `<server>/<name>`), or
 *  undefined when the grants admit it. Pure; reads the grants it is handed. */
export function toolDenyRefusal(
  grants: readonly Grant[] | undefined,
  tool: string,
  callerSessionId: string | undefined,
): ToolDenyRefusal | undefined {
  if (!grants || grants.length === 0) return undefined
  const decision: Decision = decide(
    callerSessionId
      ? { kind: "session", session: { id: callerSessionId } }
      : { kind: "operator", via: "anonymous-local" },
    "tool.invoke",
    { kind: "tool", name: tool },
    { policy: { inputs: [{ default: "allow", grants: [...grants] }] } },
  )
  if (decision.allow) return undefined
  return {
    tool: decision.resourceId ?? tool,
    rule: decision.rule,
    reason: decision.reason,
  }
}

/** The typed MCP error a refused built-in call returns. */
export function toolDeniedResult(refusal: ToolDenyRefusal): {
  isError: true
  content: Array<{ type: "text"; text: string }>
} {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: "tool_denied", ...refusal }) }],
  }
}

/**
 * Wrap every handler registered through `server.tool()` / `registerTool()` so
 * a denied call returns {@link toolDeniedResult} instead of running. Tools are
 * still registered and listed; only the call is refused. Both SDK entry points
 * are covered (see `tool-subset.ts`); the handler is the last argument of each
 * overload, and the registration's return value passes through untouched.
 */
export function withToolDenyGate(
  server: McpServer,
  grants: readonly Grant[],
  callerSessionId: string | undefined,
): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "tool" || prop === "registerTool") {
        return (name: string, ...rest: unknown[]): unknown => {
          const last = rest.length - 1
          const handler = rest[last]
          if (typeof handler === "function") {
            rest[last] = (...args: unknown[]): unknown => {
              const refusal = toolDenyRefusal(grants, name, callerSessionId)
              return refusal ? toolDeniedResult(refusal) : (handler as (...a: unknown[]) => unknown)(...args)
            }
          }
          return (target[prop] as unknown as (n: string, ...r: unknown[]) => unknown).call(target, name, ...rest)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}
