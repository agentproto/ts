/**
 * `ICodeBrainProvider` backed by a remote gbrain over its MCP/HTTP endpoint,
 * authenticated with a machine bearer token (`GBRAIN_BEARER_TOKEN`).
 *
 * Same pure contract as {@link GbrainLocalProvider}, different transport:
 * instead of `docker exec` it issues MCP `tools/call` JSON-RPC requests to
 * gbrain's `POST /mcp` endpoint (OAuth 2.1 / bearer). gbrain's HTTP tool
 * names use underscores (`code_def`, `code_callers`, `query`) and its
 * `code_def` envelope uses `defs` where the CLI uses `results` — both
 * dialect facts are confined to this package (parsing lives in `parse.ts`).
 *
 * gbrain serves `/mcp` as a Streamable-HTTP transport, so responses arrive
 * as Server-Sent Events; {@link extractJsonRpcPayload} pulls the JSON-RPC
 * envelope out of the `data:` frame(s).
 */

import { z } from "zod"
import type {
  CallEdge,
  GraphQuery,
  GraphResult,
  ICodeBrainProvider,
  SymbolDef,
} from "@agentproto/code-brain"
import { loadGbrainHttpEnv, type GbrainHttpEnv } from "./env.js"
import { parseCallEdges, parseQueryJson, parseSymbolDef } from "./parse.js"

const DEFAULT_QUERY_LIMIT = 10
const ALL_SOURCES = "__all__"

/** The MCP `tools/call` result envelope we consume — a single text block. */
const jsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]),
  result: z
    .object({
      content: z.array(z.object({ type: z.string(), text: z.string() })),
    })
    .optional(),
  error: z
    .object({ code: z.number().optional(), message: z.string() })
    .optional(),
})

/**
 * Extract the JSON-RPC envelope from a Streamable-HTTP response body. gbrain
 * replies with SSE frames (`event: message\ndata: {…}`); the last non-empty
 * `data:` line carries the JSON-RPC payload. A plain-JSON body (no SSE
 * framing) is parsed whole.
 */
export function extractJsonRpcPayload(body: string): string {
  const dataLines = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((payload) => payload.length > 0)
  const last = dataLines[dataLines.length - 1]
  return last ?? body.trim()
}

export class GbrainHttpProvider implements ICodeBrainProvider {
  private readonly env: GbrainHttpEnv

  constructor(env: GbrainHttpEnv = loadGbrainHttpEnv()) {
    this.env = env
  }

  async defineSymbol(symbol: string): Promise<SymbolDef | null> {
    const text = await this.callTool("code_def", { symbol })
    return parseSymbolDef(symbol, text)
  }

  async callers(symbol: string): Promise<readonly CallEdge[]> {
    const text = await this.callTool("code_callers", { symbol, all_sources: true })
    return parseCallEdges(text, "callers")
  }

  async callees(symbol: string): Promise<readonly CallEdge[]> {
    const text = await this.callTool("code_callees", { symbol, all_sources: true })
    return parseCallEdges(text, "callees")
  }

  async graphQuery(query: GraphQuery): Promise<GraphResult> {
    const text = await this.callTool("query", {
      query: query.question,
      source_id: query.scope ?? ALL_SOURCES,
      limit: query.limit ?? DEFAULT_QUERY_LIMIT,
      autocut: false,
    })
    return { hits: parseQueryJson(text) }
  }

  /**
   * Probe whether the gbrain HTTP endpoint is reachable and the bearer is
   * accepted — issues an MCP `tools/list`. Returns false (never throws) on
   * network failure, timeout, or a non-2xx response.
   */
  async check(): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.env.timeoutMs)
    try {
      const response = await fetch(`${this.env.endpoint}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.env.bearerToken}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        signal: controller.signal,
      })
      return response.ok
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Issue one MCP `tools/call` and return the tool's text payload (gbrain
   * wraps its JSON output in a single `content[].text` block).
   */
  private async callTool(
    name: string,
    args: Readonly<Record<string, string | number | boolean>>,
  ): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.env.timeoutMs)
    try {
      const response = await fetch(`${this.env.endpoint}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.env.bearerToken}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`gbrain HTTP ${name} failed: ${response.status} ${response.statusText}`)
      }
      const body = await response.text()
      const envelope = jsonRpcResponseSchema.parse(
        JSON.parse(extractJsonRpcPayload(body)),
      )
      if (envelope.error !== undefined) {
        throw new Error(`gbrain HTTP ${name} error: ${envelope.error.message}`)
      }
      const text = envelope.result?.content[0]?.text
      if (text === undefined) {
        throw new Error(`gbrain HTTP ${name} returned no content`)
      }
      return text
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Construct a {@link GbrainHttpProvider} from the ambient environment. */
export function gbrainHttpProvider(env?: GbrainHttpEnv): GbrainHttpProvider {
  return new GbrainHttpProvider(env)
}
