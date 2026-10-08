import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { McpError } from "@modelcontextprotocol/sdk/types.js"
import { forwardParams, openBridge, type Bridge } from "./bridge.js"
import {
  ALLOWED_METHODS,
  CACHE_HINT_METHODS,
  DEFAULT_SUPPORTED_VERSIONS,
  ERR_INTERNAL,
  ERR_INVALID_REQUEST,
  ERR_METHOD_NOT_FOUND,
  META_SERVER_INFO,
} from "./constants.js"
import {
  acceptsJson,
  isJsonContentType,
  normalizeHeaders,
  parseBody,
  validateRequest,
  type ModernError,
  type ParsedRequest,
  type RawHeaders,
} from "./validate.js"

export * from "./constants.js"
export { forwardParams } from "./bridge.js"
export { decodeHeaderValue, normalizeHeaders } from "./validate.js"

export interface ModernRequestInput {
  /** HTTP verb. */
  method: string
  headers: RawHeaders
  /** Raw body text, already size-capped by the caller. */
  body: string
}

export interface ModernResponse {
  status: number
  headers: Record<string, string>
  body?: string
}

export interface CacheHints {
  ttlMs: number
  cacheScope: "public" | "private"
}

export interface ModernDeps {
  /** Build a FRESH legacy server for this one request (same factory, same query scoping as the legacy path). */
  createServer: () => Promise<McpServer>
  supportedVersions?: readonly string[]
  /** Hints for the six cacheable operations. Default: `{ ttlMs: 0, cacheScope: "private" }` (never cached). */
  cachePolicy?: (method: string) => CacheHints
  /** Called for `server/discover` and `tools/list` with the JSON-RPC response sent back (lane B feeds the observer). */
  onObserved?: (method: "server/discover" | "tools/list", response: Record<string, unknown>) => void
  /** Aborted when the HTTP client disconnects; the in-process request is cancelled. */
  signal?: AbortSignal
}

const DEFAULT_CACHE_POLICY = (): CacheHints => ({ ttlMs: 0, cacheScope: "private" })

const JSON_HEADERS = { "content-type": "application/json" }

function errorResponse(error: ModernError, extraHeaders: Record<string, string> = {}): ModernResponse {
  return {
    status: error.status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: error.id,
      error: { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) },
    }),
  }
}

function okResponse(id: string | number, result: Record<string, unknown>): ModernResponse {
  return { status: 200, headers: { ...JSON_HEADERS }, body: JSON.stringify({ jsonrpc: "2.0", id, result }) }
}

/** `resultType`, the server info in `_meta`, and the cache hints on the six operations that must carry them. */
function decorate(
  method: string,
  result: Record<string, unknown>,
  serverInfo: { name: string; version: string },
  hints: CacheHints,
): Record<string, unknown> {
  const meta =
    typeof result._meta === "object" && result._meta !== null && !Array.isArray(result._meta)
      ? (result._meta as Record<string, unknown>)
      : {}
  const resultType = typeof result.resultType === "string" ? result.resultType : "complete"
  const decorated: Record<string, unknown> = {
    ...result,
    resultType,
    _meta: { ...meta, [META_SERVER_INFO]: meta[META_SERVER_INFO] ?? serverInfo },
  }
  if (resultType === "complete" && CACHE_HINT_METHODS.has(method)) {
    decorated.ttlMs = typeof result.ttlMs === "number" ? result.ttlMs : hints.ttlMs
    decorated.cacheScope = typeof result.cacheScope === "string" ? result.cacheScope : hints.cacheScope
  }
  return decorated
}

function fromThrown(error: unknown, id: string | number): ModernResponse {
  if (error instanceof McpError) {
    const message = error.message.replace(/^MCP error -?\d+: /, "")
    // An unknown method is a protocol error (404). Any other JSON-RPC error raised by a handler keeps HTTP 200,
    // exactly as the legacy transport answers it (events adapter codes -32011..-32016 included).
    const status = error.code === ERR_METHOD_NOT_FOUND ? 404 : 200
    return errorResponse({ status, code: error.code, message, id, ...(error.data !== undefined ? { data: error.data } : {}) })
  }
  return errorResponse({ status: 500, code: ERR_INTERNAL, message: "Internal error", id })
}

async function answer(
  request: ParsedRequest & { id: string | number },
  bridge: Bridge,
  supported: readonly string[],
  hints: CacheHints,
): Promise<Record<string, unknown>> {
  if (request.method === "server/discover") {
    const capabilities = { ...bridge.capabilities }
    delete capabilities.logging // removed in the modern era
    return decorate(
      "server/discover",
      {
        supportedVersions: [...supported],
        capabilities,
        ...(bridge.instructions ? { instructions: bridge.instructions } : {}),
      },
      bridge.serverInfo,
      hints,
    )
  }
  return decorate(request.method, await bridge.request(request.method, forwardParams(request.params)), bridge.serverInfo, hints)
}

/**
 * Serve ONE modern-era HTTP request without touching the network layer. Order: verb, Accept, Content-Type, body,
 * notification (202), request validation, in-process bridge. Never throws.
 */
export async function handleModernRequest(input: ModernRequestInput, deps: ModernDeps): Promise<ModernResponse> {
  const supported = deps.supportedVersions ?? DEFAULT_SUPPORTED_VERSIONS
  const cachePolicy = deps.cachePolicy ?? DEFAULT_CACHE_POLICY
  const headers = normalizeHeaders(input.headers)

  if (input.method !== "POST") {
    return errorResponse({ status: 405, code: ERR_INVALID_REQUEST, message: "Only POST is supported", id: null }, { allow: "POST" })
  }
  if (!acceptsJson(headers["accept"])) {
    return errorResponse({ status: 406, code: ERR_INVALID_REQUEST, message: "Accept must allow application/json", id: null })
  }
  if (!isJsonContentType(headers["content-type"])) {
    return errorResponse({ status: 415, code: ERR_INVALID_REQUEST, message: "Content-Type must be application/json", id: null })
  }
  const parsed = parseBody(input.body)
  if (!parsed.ok) return errorResponse(parsed.error)
  const request = parsed.request
  // No client-to-server notification exists in the modern core: accept and ignore (202, no body).
  if (request.id === undefined) return { status: 202, headers: {} }
  const invalid = validateRequest(request, headers, supported, ALLOWED_METHODS)
  if (invalid) return errorResponse(invalid)

  const id = request.id
  let bridge: Bridge | undefined
  try {
    bridge = await openBridge(await deps.createServer())
    const result = await answer({ ...request, id }, bridge, supported, cachePolicy(request.method))
    const response = okResponse(id, result)
    if ((request.method === "server/discover" || request.method === "tools/list") && deps.onObserved) {
      try {
        deps.onObserved(request.method, { jsonrpc: "2.0", id, result })
      } catch {
        // observation must never break the request
      }
    }
    return response
  } catch (error) {
    if (deps.signal?.aborted) return { status: 499, headers: {} }
    const response = fromThrown(error, id)
    if ((request.method === "server/discover" || request.method === "tools/list") && deps.onObserved && response.body) {
      try {
        deps.onObserved(request.method, JSON.parse(response.body) as Record<string, unknown>)
      } catch {
        // observation must never break the request
      }
    }
    return response
  } finally {
    await bridge?.close()
  }
}
