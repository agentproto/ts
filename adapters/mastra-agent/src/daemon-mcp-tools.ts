/**
 * Generic daemon MCP tool proxy (P7 deliverable 1 — "the real fix").
 *
 * `daemon-tools.ts` only wires a small, hand-curated set of daemon verbs
 * (agent_start/agent_prompt/agent_output/session_list) over the daemon's
 * REST surface. Any OTHER daemon tool an AGENT.md declares in `tools:`
 * (`app_data_read`, `mcp_imported_call`, `app_run`, `app_status`, ...) had no
 * executor at all — `default-agent.ts`'s `resolveTool` fell straight through
 * to `makeUnwiredToolStub`, so an app agent could never reach its own data
 * plane or an imported MCP server.
 *
 * This module closes that gap generically, over the daemon's OWN `/mcp`
 * endpoint (the same JSON-RPC surface `packages/cli/src/app-serve.ts` already
 * speaks to for the app UI bridge): discover the daemon
 * (`discoverDaemonEndpoint`, already used by `daemon-client.ts` — same env/
 * runtime.json convention, no new plumbing), connect an
 * `@modelcontextprotocol/sdk` `Client` over `StreamableHTTPClientTransport`,
 * `tools/list` once, and for any AGENT.md-declared tool id matching a name in
 * that list, build a Mastra tool that proxies `tools/call`.
 *
 * Deliberately NOT the ACP `session/new.mcpServers` mechanism claude-code's
 * self-mount uses (`shouldInjectDaemonSelfMount`, `session-spawn.ts`):
 * mastra-agent's `AgentController` (and its bound toolset) is built ONCE per
 * spawned process, before any ACP `session/new` call ever arrives, so a
 * per-session `mcpServers` list would arrive too late to influence tool
 * resolution. Reusing the adapter's own pre-existing discovery convention
 * sidesteps that timing mismatch entirely and matches how the curated
 * `daemon-tools.ts` set already reaches the daemon.
 *
 * Input schema: an MCP tool's `inputSchema` (from `tools/list`) is already a
 * JSON Schema — and Mastra's tool `inputSchema` (`PublicSchema`, see
 * `@mastra/schema-compat/schema`) accepts a raw `JSONSchema7` directly, no
 * zod conversion needed. A hand-rolled JSON-schema-to-zod converter would
 * just be a lossy reimplementation of a case Mastra already handles.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createTool } from "@mastra/core/tools"
import { discoverDaemonEndpoint, DaemonNotFoundError, type DiscoverDaemonOptions } from "./daemon-client.js"

export interface DaemonMcpToolDef {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

/** Discover the daemon (same convention as `daemon-client.ts`'s
 *  `DaemonClient`) and connect an MCP client to its `/mcp` endpoint,
 *  carrying `?callerSessionId=` when `AGENTPROTO_SESSION_ID` is set — the
 *  same identity stamp `session-spawn.ts` gives a claude-code/hermes
 *  self-mount, so a tool call this session makes attributes back to it. */
export async function connectDaemonMcpClient(opts: DiscoverDaemonOptions = {}): Promise<Client> {
  const endpoint = await discoverDaemonEndpoint(opts)
  if (!endpoint) throw new DaemonNotFoundError()
  const env = opts.env ?? process.env
  const url = new URL(`${endpoint.url}/mcp`)
  if (env.AGENTPROTO_SESSION_ID) url.searchParams.set("callerSessionId", env.AGENTPROTO_SESSION_ID)
  const client = new Client({ name: "agentproto-mastra-agent", version: "0.1.0" }, { capabilities: {} })
  const transport = new StreamableHTTPClientTransport(url, {
    ...(endpoint.token ? { requestInit: { headers: { authorization: `Bearer ${endpoint.token}` } } } : {}),
  })
  await client.connect(transport)
  return client
}

/** `tools/list` projected down to what a proxy tool needs. */
export async function listDaemonMcpTools(client: Client): Promise<DaemonMcpToolDef[]> {
  const { tools } = await client.listTools()
  return tools.map(t => ({
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    inputSchema: (t.inputSchema as Record<string, unknown> | undefined) ?? { type: "object" },
  }))
}

/**
 * Auto-inject `appId` into an `app_*` tool call's args when the caller
 * omitted one — `app_data_read`/`app_data_write`/`app_data_list`/`app_run`/...
 * all REQUIRE `appId` in their own input schema, but the model driving this
 * session has no way to know its own appId unless told. The daemon's
 * existing `app_tool_call` gateway has this exact bug (doesn't inject appId
 * either — seen live from the UI side); this proxy must not repeat it. Never
 * overrides an `appId` the model DID supply.
 */
export function injectAppId(
  toolName: string,
  args: Record<string, unknown>,
  appId: string | undefined,
): Record<string, unknown> {
  if (!appId) return args
  if (!toolName.startsWith("app_")) return args
  if (args.appId !== undefined) return args
  return { ...args, appId }
}

/**
 * The schema handed to the MODEL must not still mark `appId` required: Mastra
 * validates a tool call's arguments against its `inputSchema` BEFORE
 * `execute` ever runs, so a model call that (correctly) omits an appId it
 * doesn't know would be rejected at that pre-validation step — never
 * reaching {@link injectAppId} at all. Only relaxes the requirement when we
 * actually have an appId to fill in; `properties.appId` (if declared) stays
 * in the schema so a model that DOES want to pass one explicitly still can.
 */
export function relaxAppIdRequirement(
  inputSchema: Record<string, unknown>,
  toolName: string,
  appId: string | undefined,
): Record<string, unknown> {
  if (!appId || !toolName.startsWith("app_")) return inputSchema
  if (!Array.isArray(inputSchema.required) || !inputSchema.required.includes("appId")) return inputSchema
  return { ...inputSchema, required: inputSchema.required.filter(id => id !== "appId") }
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map(block => block.text)
    .join("\n")
}

export interface MakeDaemonMcpProxyToolOptions {
  /** Lazily resolves the connected client — called on every execute, so a
   *  memoized getter (see `default-agent.ts`) reconnects at most once. */
  getClient: () => Promise<Client>
  /** Threaded from `AGENTPROTO_APP_ID` (or an explicit test override) — see
   *  {@link injectAppId}. */
  appId?: string
}

/** Build a Mastra tool that proxies `tools/call` for one daemon-exposed
 *  tool. Only ever constructed for an id an AGENT.md actually declared in
 *  `tools:` (see `default-agent.ts`'s `resolveTool`) — that per-ref
 *  invocation is what keeps this an allowlist rather than a blanket grant of
 *  every tool the daemon happens to expose. */
export function makeDaemonMcpProxyTool(def: DaemonMcpToolDef, opts: MakeDaemonMcpProxyToolOptions): ReturnType<typeof createTool> {
  const config: Record<string, unknown> = {
    id: def.name,
    description: def.description ?? `Daemon tool "${def.name}", proxied via the daemon's MCP gateway.`,
    inputSchema: relaxAppIdRequirement(def.inputSchema, def.name, opts.appId),
    execute: async (input: unknown) => {
      const client = await opts.getClient()
      const args = injectAppId(def.name, (input ?? {}) as Record<string, unknown>, opts.appId)
      const result = await client.callTool({ name: def.name, arguments: args })
      if (result.isError) {
        throw new Error(`daemon tool "${def.name}" failed: ${extractText(result.content) || "(no error detail)"}`)
      }
      return result.structuredContent ?? extractText(result.content)
    },
  }
  // Mastra's `createTool` generics can't express "input schema decided at
  // runtime from an MCP tool's JSON Schema" — the shape genuinely isn't
  // known until `tools/list` returns it. This cast only turns off
  // compile-time inference for it; `PublicSchema` (see the module doc)
  // still accepts — and Mastra still validates against — the raw
  // JSONSchema7 at runtime.
  return createTool(config as unknown as Parameters<typeof createTool>[0])
}
