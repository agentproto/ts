/**
 * Deferred/lazy MCP tool loading (harness-parity item 3).
 *
 * Motivation: a root `/mcp` session sees every tool the daemon registers —
 * today that's 60+ tools across families (agent_*, session_*, policy_*,
 * routine_*, workflow_*, terminal_*, command_*, file_*, directory_*,
 * browser_*, tunnel_*, mcp_*, inbound_watcher_*) — all with full schemas,
 * loaded upfront, whether or not the session ever touches most of them.
 *
 * NB: imported third-party MCP servers (`mcp_import`) do NOT have this
 * problem — they're already proxied behind `mcp_imported_tool_list` /
 * `mcp_imported_call` (session-tools.ts), a search-then-call pattern that
 * never mounts an upstream server's tools directly. This module addresses
 * the daemon's OWN gateway tools, the part of the surface still eager.
 *
 * ## Why this does NOT use the SDK's enable()/disable()
 *
 * `@modelcontextprotocol/sdk` 1.29.0's `server.tool(...)` returns a
 * `RegisteredTool` with `.enable()`/`.disable()`, `tools/list` filters on
 * `.enabled`, and the server auto-advertises `tools: { listChanged: true }`
 * — a real, SDK-supported dynamic-registration mechanism. An earlier draft
 * of this module used exactly that: register tools disabled, `.enable()`
 * them from `tool_search`.
 *
 * It does not work here. `http-server.ts` documents (and a live daemon
 * run confirmed): "MCP transport: stateless mode for v1 — each request is
 * independent" — a FRESH `McpServer` is built via `mcpServerFactory()` for
 * EVERY request, including `tools/call`. An `.enable()` mutation made
 * during a `tool_search` call lives only on that call's own throwaway
 * server instance; the very next `tools/call` for the newly-"enabled"
 * tool gets a brand-new instance where it's disabled again, and fails
 * with `Tool X disabled`. Confirmed by running exactly that sequence
 * against a live gateway — the mutation never survives past the request
 * that made it, so a real orchestrator would search successfully, read
 * a schema, then have the follow-up call rejected. Worse than doing
 * nothing: it looks like it works, right up until the second call.
 *
 * ## What this does instead
 *
 * Every tool stays fully registered AND enabled (`tools/call` always
 * works for any tool name, deferred or not — the daemon is stateless
 * regardless, so there is no session-scoped "have they earned the right
 * to call this" state to enforce even if it were desirable). "Deferred"
 * only means: excluded from the `tools/list` response, so a session
 * doesn't pay the schema-loading token tax for tools it never asked
 * about. The `tools/list` handler is overridden directly on the
 * underlying low-level `Server` (`mcpServer.server.setRequestHandler` —
 * the SDK's own documented escape hatch: "For advanced usage ... use the
 * underlying Server instance") to return only the `alwaysOn` set plus
 * `tool_search` itself; this is a pure per-request read, so it's
 * naturally correct under statelessness — there's no history to lose.
 * `tool_search` matches a keyword (or `select:name1,name2` for exact
 * names) against a catalog of every OTHER registered tool and returns
 * full JSON Schema for the hits directly in its own result text — the
 * one channel that reliably survives the stateless boundary, since it's
 * read from the SAME call that produced it.
 *
 * Opt-in and backward-compatible by construction: nothing calls this
 * unless a host explicitly wires `deferredTools` into `createGateway` —
 * see `index.ts`. Every existing daemon keeps registering (and exposing)
 * everything eagerly, exactly as before.
 *
 * Both SDK registration entry points are intercepted — `server.tool(...)`
 * AND `server.registerTool(...)` (the config-object overload; e.g.
 * mcp-apps-adapter.ts's `agentproto_sessions` panel tool uses the latter,
 * and would silently skip the catalog if only one were patched).
 *
 * Tools registered on the server BEFORE it's wrapped — e.g. `self_inspect`,
 * added inside `@agentproto/mcp-server`'s `createMcpServer()` — are
 * automatically excluded from `tools/list` too: the override only lists
 * names present in `registry` (built from tools that passed through the
 * proxy), so anything registered earlier is simply absent from that set,
 * with no extra bookkeeping needed. They stay fully callable, same as
 * every other tool here — the override only ever touches what `tools/list`
 * shows.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

interface CatalogEntry {
  description?: string
  inputSchema?: unknown
}

export interface DeferredToolGatewayOptions {
  /** Tool names that stay in `tools/list` from the first connection — the
   *  always-on hot loop. Everything else registered through the wrapped
   *  server is fully callable (statelessness makes gating calls pointless
   *  — see module docs) but excluded from `tools/list` until
   *  `tool_search`ed. */
  alwaysOn: ReadonlySet<string>
}

/** Best-effort JSON Schema for a tool's Zod input object — `undefined`
 *  when the tool takes no arguments, or on any conversion failure (a
 *  malformed/incompatible schema shouldn't break the response, just omit
 *  that one tool's schema). */
function toJsonSchema(inputSchema: unknown): unknown {
  if (!inputSchema) return undefined
  try {
    return z.toJSONSchema(inputSchema as Parameters<typeof z.toJSONSchema>[0])
  } catch {
    return undefined
  }
}

const TOOL_SEARCH_NAME = "tool_search"

export function withDeferredTools(
  server: McpServer,
  opts: DeferredToolGatewayOptions,
): McpServer {
  const alwaysOn = new Set([...opts.alwaysOn, TOOL_SEARCH_NAME])
  // Every tool that passes through the proxy, always-on or not — the
  // `tools/list` override reads the always-on subset of this; `tool_search`
  // reads everything else.
  const registry = new Map<string, CatalogEntry>()

  type RawRegisteredTool = { description?: string; inputSchema?: unknown }

  /** Shared by both SDK registration entry points (`tool()` AND
   *  `registerTool()` — mcp-apps-adapter.ts uses the latter; missing
   *  either one would silently let those tools skip the catalog). */
  const intercept =
    (fn: (...a: unknown[]) => RawRegisteredTool) =>
    (name: string, ...rest: unknown[]): RawRegisteredTool => {
      const registered = fn(name, ...rest)
      registry.set(name, { description: registered.description, inputSchema: registered.inputSchema })
      return registered
    }

  const proxied = new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "tool") {
        return intercept(target.tool.bind(target) as (...a: unknown[]) => RawRegisteredTool)
      }
      if (prop === "registerTool") {
        return intercept(target.registerTool.bind(target) as (...a: unknown[]) => RawRegisteredTool)
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })

  // Registered THROUGH the proxy (not directly on `server`) so it lands in
  // `registry` and is naturally part of the always-on set via the union
  // above. This call also triggers the SDK's one-time `tools/list`
  // handler setup (McpServer.setToolRequestHandlers, lazily run on the
  // first tool registration) — the override below must come AFTER this,
  // replacing that default handler rather than racing to set it first
  // (setting it first would make the SDK's own lazy init throw when the
  // very next real tool registers: "A request handler for tools/list
  // already exists").
  proxied.tool(
    TOOL_SEARCH_NAME,
    "Look up full schemas for tools hidden from `tools/list` (kept out to " +
      "save context — every tool is still fully callable once you know its " +
      "shape, this just saves you from loading all of them upfront). Match " +
      "by keyword (against tool name + description) or `select:name1,name2` " +
      "for exact names when you already know what you want. Schemas are " +
      "returned directly in this call's result — call the tool by name " +
      "right away, no need to re-fetch `tools/list` first.",
    {
      query: z
        .string()
        .min(1)
        .describe(
          "Space-separated keyword(s) to match, or `select:<name1>,<name2>` " +
            "for exact tool names when you already know what you want.",
        ),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Cap on matches returned. Default 5."),
    },
    async input => {
      const max = input.maxResults ?? 5
      const candidates = Array.from(registry.entries()).filter(([name]) => !alwaysOn.has(name))
      let hits: Array<[string, CatalogEntry]>

      if (input.query.startsWith("select:")) {
        const names = new Set(
          input.query
            .slice("select:".length)
            .split(",")
            .map(s => s.trim())
            .filter(Boolean),
        )
        hits = candidates.filter(([name]) => names.has(name))
      } else {
        const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean)
        hits = candidates
          .map(([name, entry]): [string, CatalogEntry, number] => {
            const haystack = `${name} ${entry.description ?? ""}`.toLowerCase()
            return [name, entry, terms.filter(t => haystack.includes(t)).length]
          })
          .filter(([, , score]) => score > 0)
          .sort((a, b) => b[2] - a[2])
          .slice(0, max)
          .map(([name, entry]) => [name, entry])
      }

      const tools = hits.map(([name, entry]) => ({
        name,
        description: entry.description,
        inputSchema: toJsonSchema(entry.inputSchema),
      }))
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                tools,
                ...(tools.length === 0
                  ? { note: "No matching deferred tool. Names are case-sensitive; try a broader keyword." }
                  : {}),
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  // Pure per-request read over `registry` — safe under statelessness since
  // there's no cross-request history to reflect, just "what's registered
  // right now, filtered to alwaysOn". Overrides the SDK's own default
  // tools/list handler (installed by the `proxied.tool()` call above);
  // `Server.setRequestHandler` documents itself as a replace, not an
  // add — see @modelcontextprotocol/sdk shared/protocol.js.
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: Array.from(registry.entries())
      .filter(([name]) => alwaysOn.has(name))
      .map(([name, entry]) => ({
        name,
        description: entry.description,
        inputSchema: toJsonSchema(entry.inputSchema) ?? { type: "object" as const, properties: {} },
      })),
  }))

  return proxied
}
