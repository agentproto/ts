/**
 * McpSink — a config-driven SinkPort that pushes each refined entry by calling
 * a configured MCP tool. Host-agnostic: the endpoint, tool name, and the
 * entry→args mapping all come from a sink manifest, so the corpus links to ANY
 * host (a Guilde guild KB, a Notion db, a vector store) without naming it.
 *
 * The manifest's `args` is a template: string values containing `${slug}`,
 * `${title}`, `${body}`, `${sources}`, `${tags}`, `${access}`, `${uri}`,
 * `${kind}`, `${confidence}` are substituted per entry. A value that is exactly
 * one placeholder (e.g. `"${sources}"`) is replaced with the typed value (array
 * / number), not a string.
 */

import { z } from "zod"
import type { SinkPort, SinkItem, SinkPushResult } from "@agentproto/corpus"
import { connectMcpHttp, type McpClientLike } from "./mcp-http-client.js"

/** Validates a sink manifest (the `--config` JSON) — single source for the type. */
export const SINK_CONFIG_SCHEMA = z.object({
  endpoint: z.string().min(1),
  tool: z.string().min(1),
  /** Arg template — substituted per entry. */
  args: z.record(z.string(), z.unknown()),
  headers: z.record(z.string(), z.string()).optional(),
  /** MCP transport: "streamable-http" (default) or "sse". */
  transport: z.enum(["streamable-http", "sse"]).optional(),
  /**
   * If set, calls go through `mcp_imported_call({ alias, toolName, args })`
   * (the agentproto daemon's imported-MCP proxy) instead of the tool directly.
   */
  importedAlias: z.string().optional(),
})

export type McpSinkConfig = z.infer<typeof SINK_CONFIG_SCHEMA>

export class McpSink implements SinkPort {
  private client: McpClientLike | undefined
  constructor(
    private readonly config: McpSinkConfig,
    client?: McpClientLike // injectable for tests
  ) {
    this.client = client
  }

  private async ensure(): Promise<McpClientLike> {
    if (!this.client) {
      this.client = await connectMcpHttp({
        endpoint: this.config.endpoint,
        ...(this.config.headers ? { headers: this.config.headers } : {}),
        ...(this.config.transport ? { transport: this.config.transport } : {}),
      })
    }
    return this.client
  }

  async push(item: SinkItem): Promise<SinkPushResult> {
    let client: McpClientLike
    try {
      client = await this.ensure()
    } catch (e) {
      return { uri: item.uri, ok: false, error: `connect: ${msg(e)}` }
    }
    const args = template(this.config.args, item)
    const call = this.config.importedAlias
      ? { name: "mcp_imported_call", args: { alias: this.config.importedAlias, toolName: this.config.tool, args } }
      : { name: this.config.tool, args }
    try {
      const res = await client.callTool(call.name, call.args)
      if (res.isError) return { uri: item.uri, ok: false, error: "tool returned isError" }
      return { uri: item.uri, ok: true }
    } catch (e) {
      return { uri: item.uri, ok: false, error: msg(e) }
    }
  }
}

// ── templating ──────────────────────────────────────────────────────

const PLACEHOLDER_RE = /\$\{(\w+)\}/g

function template(args: Record<string, unknown>, item: SinkItem): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    slug: item.slug,
    title: item.title,
    body: item.body,
    sources: item.sources,
    tags: item.tags,
    access: item.access ?? "",
    uri: item.uri,
    kind: item.kind,
    confidence: item.confidence,
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    out[key] = substitute(value, fields)
  }
  return out
}

function substitute(value: unknown, fields: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    // Whole-value placeholder → typed substitution.
    const whole = value.match(/^\$\{(\w+)\}$/)
    if (whole && whole[1]! in fields) return fields[whole[1]!]
    // Otherwise string interpolation.
    return value.replace(PLACEHOLDER_RE, (_, k) =>
      k in fields ? stringify(fields[k]) : `\${${k}}`
    )
  }
  if (Array.isArray(value)) return value.map(v => substitute(v, fields))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, fields)
    return out
  }
  return value
}

function stringify(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ")
  return v == null ? "" : String(v)
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
