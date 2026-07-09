/**
 * Shared types for the pi↔MCP bridge (`@agentproto/adapter-pi`).
 *
 * Pi ships no MCP client. This bridge closes the gap by generating a pi
 * **extension** (loaded via `pi -e <file>`) that registers one pi tool per MCP
 * tool; each tool's `execute` proxies to the MCP server over
 * `@modelcontextprotocol/sdk`. The adapter's `client.ts` enumerates the servers'
 * tools up-front, writes them into a per-session config JSON, and the extension
 * registers them synchronously at load — `execute` connects lazily and calls the
 * remote tool.
 *
 * These types are intentionally self-contained: the extension has NO
 * `@earendil-works/*` import. It relies on pi's structural (duck-typed) runtime
 * contract — pi calls the default-exported factory with an object exposing
 * `registerTool`, and accepts a plain JSON Schema as a tool's `parameters`
 * (verified: pi compiles `parameters` with TypeBox `Compile`, which validates a
 * raw JSON Schema unchanged; see MCP-BRIDGE.md).
 */

/** A JSON value — the wire vocabulary of MCP tool arguments and results. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/** A JSON object (an MCP tool's `inputSchema`, or a tool call's arguments). */
export type JsonObject = { [key: string]: JsonValue }

/** MCP transport discriminant, mirroring `AcpMcpServer.transport`. */
export type BridgeTransport = "stdio" | "http" | "sse"

/**
 * One MCP server the extension can connect to, flattened from `AcpMcpServer`.
 * For `stdio`, `command` is required (`args`/`env` optional). For `http`/`sse`,
 * `url` is required (`headers` optional).
 */
export interface BridgeServerSpec {
  name: string
  transport: BridgeTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

/**
 * One bridged tool: the pi-facing (namespaced, sanitized) `toolName`, the
 * `server` it lives on, the `remoteName` used in the MCP `tools/call`, plus the
 * `description` + `inputSchema` advertised to the model.
 */
export interface BridgeToolSpec {
  toolName: string
  server: string
  remoteName: string
  description: string
  inputSchema: JsonObject
}

/** The full per-session config the adapter writes and the extension reads. */
export interface BridgeConfig {
  servers: BridgeServerSpec[]
  tools: BridgeToolSpec[]
}

/** A text content block returned to the model (pi's `TextContent`, minimal). */
export interface PiTextContent {
  type: "text"
  text: string
}

/** The result a pi tool's `execute` returns (pi's `AgentToolResult`, minimal). */
export interface PiToolResult {
  content: PiTextContent[]
  details: PiToolResultDetails
  terminate?: boolean
}

/** Structured details attached to a bridged tool result, for logs/UI. */
export interface PiToolResultDetails {
  server: string
  tool: string
  isError: boolean
}

/**
 * The subset of pi's tool-definition contract this bridge produces. `parameters`
 * is a raw JSON Schema (pi accepts it structurally as a TypeBox `TSchema`).
 */
export interface PiToolDefinition {
  name: string
  label: string
  description: string
  promptSnippet?: string
  promptGuidelines?: string[]
  parameters: JsonObject
  execute: (
    toolCallId: string,
    params: JsonObject,
    signal: AbortSignal | undefined,
  ) => Promise<PiToolResult>
}

/** The subset of pi's `ExtensionAPI` this bridge uses (structural). */
export interface PiExtensionAPI {
  registerTool: (tool: PiToolDefinition) => void
}

/** Type guard: a value is a non-null, non-array object. */
export function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Coerce an unknown into a `JsonObject`, defaulting to `{}`. */
export function asJsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) return {}
  const out: JsonObject = {}
  for (const [key, raw] of Object.entries(value)) {
    out[key] = toJsonValue(raw)
  }
  return out
}

/** Deep-coerce an unknown into a `JsonValue` (functions/undefined → null). */
export function toJsonValue(value: unknown): JsonValue {
  if (value === null) return null
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value
  }
  if (Array.isArray(value)) return value.map(toJsonValue)
  if (isRecord(value)) {
    const out: JsonObject = {}
    for (const [key, raw] of Object.entries(value)) out[key] = toJsonValue(raw)
    return out
  }
  return null
}
