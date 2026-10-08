import {
  ERR_HEADER_MISMATCH,
  ERR_INVALID_PARAMS,
  ERR_INVALID_REQUEST,
  ERR_METHOD_NOT_FOUND,
  ERR_PARSE,
  ERR_UNSUPPORTED_VERSION,
  META_CLIENT_CAPABILITIES,
  META_PROTOCOL_VERSION,
  NAME_HEADER_SOURCE,
} from "./constants.js"

export type RawHeaders = Record<string, string | string[] | undefined>
/** Lowercased names, trimmed values; a duplicated header is joined with ", " so it can never equal one expected value. */
export type Headers = Record<string, string>

export interface ModernError {
  status: number
  code: number
  message: string
  data?: unknown
  /** Echoed in the error body; null when the request could not be parsed. */
  id: string | number | null
}

export interface ParsedRequest {
  /** undefined means a notification (no `id` member). */
  id: string | number | undefined
  method: string
  params: Record<string, unknown>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function normalizeHeaders(raw: RawHeaders): Headers {
  const out: Headers = {}
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue
    const joined = (Array.isArray(value) ? value.join(", ") : value).trim()
    const key = name.toLowerCase()
    const previous = out[key]
    out[key] = previous === undefined ? joined : `${previous}, ${joined}`
  }
  return out
}

/** True when `Accept` allows an `application/json` response (our responses are always JSON). */
export function acceptsJson(accept: string | undefined): boolean {
  if (accept === undefined) return false
  return accept.split(",").some(part => {
    const type = (part.split(";")[0] ?? "").trim().toLowerCase()
    return type === "application/json" || type === "application/*" || type === "*/*"
  })
}

export function isJsonContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false
  return (contentType.split(";")[0] ?? "").trim().toLowerCase() === "application/json"
}

/** Spec "Value Encoding": `=?base64?<b64 of UTF-8>?=` is decoded before comparison; anything else is used as is. */
export function decodeHeaderValue(raw: string): string {
  const match = /^=\?base64\?(.*)\?=$/.exec(raw)
  if (!match) return raw
  return Buffer.from(match[1] ?? "", "base64").toString("utf8")
}

export type BodyResult = { ok: true; request: ParsedRequest } | { ok: false; error: ModernError }

export function parseBody(body: string): BodyResult {
  const fail = (status: number, code: number, message: string): BodyResult => ({ ok: false, error: { status, code, message, id: null } })
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return fail(400, ERR_PARSE, "Parse error")
  }
  if (Array.isArray(value)) return fail(400, ERR_INVALID_REQUEST, "Batch requests are not supported")
  if (!isRecord(value)) return fail(400, ERR_INVALID_REQUEST, "The body must be a single JSON-RPC request or notification")
  const method = value.method
  if (typeof method !== "string" && ("result" in value || "error" in value)) {
    return fail(400, ERR_INVALID_REQUEST, "JSON-RPC responses must not be sent to the server")
  }
  if (value.jsonrpc !== "2.0" || typeof method !== "string") return fail(400, ERR_INVALID_REQUEST, "Not a JSON-RPC 2.0 request")
  const hasId = "id" in value
  const id = value.id
  if (hasId && typeof id !== "string" && typeof id !== "number") return fail(400, ERR_INVALID_REQUEST, "`id` must be a string or a number")
  if (value.params !== undefined && !isRecord(value.params)) return fail(400, ERR_INVALID_PARAMS, "`params` must be an object")
  return {
    ok: true,
    request: {
      id: hasId ? (id as string | number) : undefined,
      method,
      params: isRecord(value.params) ? value.params : {},
    },
  }
}

/**
 * Validate one modern request, in this order: legacy `initialize`, required `_meta`, protocol version, the
 * `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers, then the method matrix. First failure wins.
 */
export function validateRequest(
  request: ParsedRequest,
  headers: Headers,
  supported: readonly string[],
  allowed: ReadonlySet<string>,
): ModernError | null {
  const id = request.id ?? null
  const err = (status: number, code: number, message: string, data?: unknown): ModernError => ({
    status,
    code,
    message,
    id,
    ...(data !== undefined ? { data } : {}),
  })
  const { method, params } = request

  if (method === "initialize") {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "unknown"
    // Removed in the modern era: 404 -32601 like any removed method (conformance `server-stateless`), with the supported
    // versions named in `data` because a modern-only server SHOULD name them in any error answering `initialize`.
    return err(404, ERR_METHOD_NOT_FOUND, "Method not found: initialize (this endpoint is stateless, send server/discover)", {
      supported: [...supported],
      requested,
    })
  }

  const meta = params._meta
  const missing: string[] = []
  if (!isRecord(meta) || typeof meta[META_PROTOCOL_VERSION] !== "string") missing.push(META_PROTOCOL_VERSION)
  if (!isRecord(meta) || !isRecord(meta[META_CLIENT_CAPABILITIES])) missing.push(META_CLIENT_CAPABILITIES)
  if (!isRecord(meta) || missing.length > 0) return err(400, ERR_INVALID_PARAMS, `Missing required _meta field(s): ${missing.join(", ")}`)

  const version = String(meta[META_PROTOCOL_VERSION])
  if (!supported.includes(version)) {
    return err(400, ERR_UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: [...supported], requested: version })
  }

  const headerVersion = headers["mcp-protocol-version"]
  if (headerVersion === undefined) return err(400, ERR_HEADER_MISMATCH, "Header mismatch: MCP-Protocol-Version header is missing")
  if (headerVersion !== version) {
    return err(400, ERR_HEADER_MISMATCH, `Header mismatch: MCP-Protocol-Version ${headerVersion} does not match _meta ${version}`)
  }

  const headerMethod = headers["mcp-method"]
  if (headerMethod === undefined) return err(400, ERR_HEADER_MISMATCH, "Header mismatch: Mcp-Method header is missing")
  if (headerMethod !== method) {
    return err(400, ERR_HEADER_MISMATCH, `Header mismatch: Mcp-Method ${headerMethod} does not match body ${method}`)
  }

  const source = NAME_HEADER_SOURCE.get(method)
  if (source !== undefined) {
    const expected = params[source]
    if (typeof expected !== "string") return err(400, ERR_INVALID_PARAMS, `Missing required params.${source}`)
    const rawName = headers["mcp-name"]
    if (rawName === undefined) return err(400, ERR_HEADER_MISMATCH, "Header mismatch: Mcp-Name header is missing")
    if (decodeHeaderValue(rawName) !== expected) {
      return err(400, ERR_HEADER_MISMATCH, `Header mismatch: Mcp-Name does not match params.${source}`)
    }
  }

  if (!allowed.has(method)) return err(404, ERR_METHOD_NOT_FOUND, `Method not found: ${method}`)
  return null
}
