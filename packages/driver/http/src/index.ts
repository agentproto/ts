/**
 * @agentproto/http — AIP-31 HTTP provider specialisation.
 *
 * Sugar over `defineDriver({ kind: "http", ... })` plus the
 * HTTP-specific dispatch logic: body / query templating, header
 * substitution, JSONPath-lite response extraction, and SSE streaming.
 *
 * Spec: https://agentproto.sh/docs/aip-31
 */

import {
  defineDriver,
  type ExecuteFn,
  type ImplementsEntry,
  type DriverDefinition,
  type DriverHandle,
} from "@agentproto/driver"
import {
  redactSecrets,
  SAFE_HTTP_EXTRA_HEADERS_KEY,
  SAFE_HTTP_FETCH_KEY,
} from "./safe-collector.js"

/** AIP-70 registry spec id for this package (`http/v1`, AIP-31). */
export const SPEC_NAME = "http/v1" as const

export interface HttpDriverDefinition extends Omit<DriverDefinition, "kind" | "execute"> {
  kind?: "http"
  /** API base URL. All implements[].metadata.http.endpoint paths relative to this. */
  baseUrl: string
  /** Headers attached to every request. Templating allowed via ${secrets.X} / ${context.X}. */
  defaultHeaders?: Record<string, string>
  /** Default HTTP method when per-tool entry omits it. Defaults to POST. */
  defaultMethod?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  /** Default streaming config; per-tool override via metadata.http.streaming. */
  streaming?: { transport: "sse" | "ndjson" | "chunked"; eventField?: string; terminator?: string }

  /**
   * Optional behavioural adapter. When omitted, the runtime synthesises
   * an execute body per implements[] entry from the per-tool metadata.http
   * dispatch hints (endpoint, method, body_template, response_extract).
   */
  buildRequest?: (args: BuildRequestArgs) => HttpRequest | Promise<HttpRequest>
  parseResponse?: (args: ParseResponseArgs) => HttpParseResult
}

export interface BuildRequestArgs {
  toolId: string
  input: Record<string, unknown>
  context: Record<string, unknown>
  driverCtx: { secrets: Record<string, string>; baseUrl: string; [k: string]: unknown }
  signal: AbortSignal
}

export interface HttpRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
  query?: Record<string, string>
}

export interface ParseResponseArgs {
  toolId: string
  status: number
  body: unknown
  headers: Record<string, string>
}

export type HttpParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; retryable?: boolean } }

/**
 * Define an HTTP provider — sugar over defineDriver with kind: http
 * and an auto-synthesised execute map keyed by tool id when explicit
 * `execute` isn't provided.
 */
export function defineHttpDriver(
  definition: HttpDriverDefinition
): DriverHandle {
  const raw = definition as HttpDriverDefinition & {
    base_url?: string
    default_headers?: Record<string, string>
    default_method?: HttpDriverDefinition["defaultMethod"]
  }
  const baseUrl = raw.baseUrl ?? raw.base_url
  const defaultHeaders = raw.defaultHeaders ?? raw.default_headers ?? {}
  const defaultMethod = raw.defaultMethod ?? raw.default_method ?? "POST"
  const execute: Record<string, ExecuteFn> = {}

  for (const entry of definition.implements) {
    const toolId = normalizeToolId(entry.tool)
    execute[toolId] = createExecuteFn({
      toolId,
      entry,
      baseUrl,
      defaultHeaders,
      defaultMethod,
      buildRequest: definition.buildRequest,
      parseResponse: definition.parseResponse,
    })
  }

  return defineDriver({
    ...definition,
    kind: "http",
    execute,
    metadata: {
      ...(definition.metadata ?? {}),
      http: { baseUrl, defaultHeaders, defaultMethod, streaming: definition.streaming },
    },
  })
}

function normalizePerToolHttp(raw: PerToolHttp | undefined): PerToolHttp {
  if (!raw) return {}
  return {
    endpoint: raw.endpoint,
    method: raw.method,
    headers: raw.headers,
    bodyTemplate: raw.bodyTemplate ?? raw.body_template,
    queryTemplate: raw.queryTemplate ?? raw.query_template,
    responseExtract: raw.responseExtract ?? raw.response_extract,
    streaming: raw.streaming,
    idempotencyKeyHeader: raw.idempotencyKeyHeader ?? raw.idempotency_key_header,
  }
}

function createExecuteFn(args: {
  toolId: string
  entry: ImplementsEntry
  baseUrl: string
  defaultHeaders: Record<string, string>
  defaultMethod: string
  buildRequest?: HttpDriverDefinition["buildRequest"]
  parseResponse?: HttpDriverDefinition["parseResponse"]
}): ExecuteFn {
  const meta = (args.entry.metadata ?? {}) as { http?: PerToolHttp }
  const httpMeta = normalizePerToolHttp(meta.http)

  return async ({ input, context, driverCtx, signal }) => {
    const inputObj = (input ?? {}) as Record<string, unknown>
    const ctxObj = context as Record<string, unknown>
    const provCtx = driverCtx as {
      secrets: Record<string, string>
      [SAFE_HTTP_FETCH_KEY]?: typeof globalThis.fetch
      [SAFE_HTTP_EXTRA_HEADERS_KEY]?: Record<string, string>
      [k: string]: unknown
    }
    const secrets = provCtx.secrets ?? {}
    const fetchFn = provCtx[SAFE_HTTP_FETCH_KEY] ?? fetch
    const extraHeaders = provCtx[SAFE_HTTP_EXTRA_HEADERS_KEY] ?? {}

    let request: HttpRequest
    if (args.buildRequest) {
      request = await args.buildRequest({
        toolId: args.toolId,
        input: inputObj,
        context: ctxObj,
        driverCtx: { ...provCtx, baseUrl: args.baseUrl },
        signal,
      })
      if (Object.keys(extraHeaders).length > 0) {
        request = { ...request, headers: { ...request.headers, ...extraHeaders } }
      }
    } else {
      const rawEndpoint = httpMeta.endpoint ?? "/"
      const endpoint = expandEndpoint(rawEndpoint, {
        input: inputObj,
        secrets,
        context: ctxObj,
      })
      const method = httpMeta.method ?? args.defaultMethod
      const baseParsed = new URL(args.baseUrl)
      const resolvedUrl = new URL(endpoint, args.baseUrl)
      if (resolvedUrl.origin !== baseParsed.origin) {
        throw new HttpDriverError(
          "invalid_endpoint",
          `Endpoint '${rawEndpoint}' resolved to origin '${resolvedUrl.origin}', outside baseUrl origin '${baseParsed.origin}'.`,
          false,
        )
      }
      const url = resolvedUrl.toString()
      const headers = expandHeaders(
        { ...args.defaultHeaders, ...(httpMeta.headers ?? {}), ...extraHeaders },
        { input: inputObj, secrets, context: ctxObj }
      )
      const body = httpMeta.bodyTemplate
        ? expandTemplate(httpMeta.bodyTemplate, {
            input: inputObj,
            secrets,
            context: ctxObj,
          })
        : inputObj
      const query = httpMeta.queryTemplate
        ? Object.fromEntries(
            Object.entries(
              expandTemplate(httpMeta.queryTemplate, {
                input: inputObj,
                secrets,
                context: ctxObj,
              }) as Record<string, unknown>
            ).map(([k, v]) => [k, String(v)])
          )
        : undefined
      request = { url: appendQuery(url, query), method, headers, body }
    }

    const response = await fetchFn(request.url, {
      method: request.method,
      headers: request.headers,
      body:
        request.body == null || request.method === "GET"
          ? undefined
          : typeof request.body === "string"
            ? request.body
            : JSON.stringify(request.body),
      signal,
    })

    const responseHeaders = headersToObject(response.headers)
    const responseBody = await parseResponseBody(response)

    if (args.parseResponse) {
      const parsed = args.parseResponse({
        toolId: args.toolId,
        status: response.status,
        body: responseBody,
        headers: responseHeaders,
      })
      if (parsed.ok) return parsed.value
      throw new HttpDriverError(
        parsed.error.code,
        redactSecrets(parsed.error.message, secrets),
        parsed.error.retryable,
      )
    }

    if (response.status === 401 || response.status === 403) {
      throw new HttpDriverError("auth_required", `HTTP ${response.status}${bodyExcerpt(responseBody, secrets)}`, false)
    }
    if (response.status === 429) {
      throw new HttpDriverError("rate_limited", `HTTP 429${bodyExcerpt(responseBody, secrets)}`, true)
    }
    if (response.status >= 500) {
      throw new HttpDriverError(
        "upstream_error",
        `HTTP ${response.status}${bodyExcerpt(responseBody, secrets)}`,
        true,
      )
    }
    if (response.status >= 400) {
      throw new HttpDriverError(
        "upstream_error",
        `HTTP ${response.status}${bodyExcerpt(responseBody, secrets)}`,
        false,
      )
    }

    const path = httpMeta.responseExtract ?? "$"
    return extractResponse(responseBody, path)
  }
}

interface PerToolHttp {
  endpoint?: string
  method?: string
  headers?: Record<string, string>
  bodyTemplate?: unknown
  body_template?: unknown
  queryTemplate?: Record<string, string>
  query_template?: Record<string, string>
  responseExtract?: string
  response_extract?: string
  streaming?: { transport: string; eventField?: string; terminator?: string }
  idempotencyKeyHeader?: string
  idempotency_key_header?: string
}

class HttpDriverError extends Error {
  code: string
  retryable?: boolean
  constructor(code: string, message: string, retryable?: boolean) {
    super(message)
    this.name = "HttpDriverError"
    this.code = code
    this.retryable = retryable
  }
}

/** Expand `${input.X}` / `${secrets.X}` / `${context.X}` substitutions in a value tree. */
export function expandTemplate(
  value: unknown,
  vars: { input: Record<string, unknown>; secrets: Record<string, string>; context: Record<string, unknown> }
): unknown {
  if (typeof value === "string") return substituteString(value, vars)
  if (Array.isArray(value)) return value.map(v => expandTemplate(v, vars))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandTemplate(v, vars)
    }
    return out
  }
  return value
}

export function expandHeaders(
  headers: Record<string, string>,
  vars: { input: Record<string, unknown>; secrets: Record<string, string>; context: Record<string, unknown> }
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    const expanded = substituteString(v, vars)
    out[k] = typeof expanded === "string" ? expanded : String(expanded)
  }
  return out
}

const TEMPLATE_RE = /\$\{(input|secrets|context)\.([\w.]+)(?:\s*\|\s*default\(([^)]*)\))?\}/g

function substituteString(
  template: string,
  vars: { input: Record<string, unknown>; secrets: Record<string, string>; context: Record<string, unknown> }
): unknown {
  // If the entire string is a single substitution, return the typed value.
  const single = template.match(/^\$\{(input|secrets|context)\.([\w.]+)\}$/)
  if (single) {
    const [, scope, path] = single
    return resolvePath(vars[scope as "input" | "secrets" | "context"], path!)
  }
  return template.replace(TEMPLATE_RE, (_match, scope: string, path: string, fallbackRaw?: string) => {
    const resolved = resolvePath(vars[scope as "input" | "secrets" | "context"], path)
    if (resolved === undefined || resolved === null) {
      if (fallbackRaw !== undefined) {
        const trimmed = fallbackRaw.trim()
        return trimmed.startsWith("'") || trimmed.startsWith('"')
          ? trimmed.slice(1, -1)
          : trimmed
      }
      return ""
    }
    return typeof resolved === "string" ? resolved : JSON.stringify(resolved)
  })
}

const FORBIDDEN_PATH_KEYS = new Set(["__proto__", "constructor", "prototype"])

/**
 * Interpolate `${input.X}` / `${secrets.X}` / `${context.X}` in a URL endpoint
 * path, URI-encoding each substituted segment and rejecting path-traversal or
 * scheme-override injections.
 */
export function expandEndpoint(
  endpoint: string,
  vars: { input: Record<string, unknown>; secrets: Record<string, string>; context: Record<string, unknown> },
): string {
  return endpoint.replace(TEMPLATE_RE, (_match, scope: string, path: string, fallbackRaw?: string) => {
    const resolved = resolvePath(vars[scope as "input" | "secrets" | "context"], path)
    let raw: string
    if (resolved === undefined || resolved === null) {
      if (fallbackRaw !== undefined) {
        const trimmed = fallbackRaw.trim()
        raw = trimmed.startsWith("'") || trimmed.startsWith('"')
          ? trimmed.slice(1, -1)
          : trimmed
      } else {
        raw = ""
      }
    } else {
      raw = typeof resolved === "string" ? resolved : String(resolved)
    }
    if (raw === ".." || raw.includes("..") || raw.includes("\\") || /[\r\n]/.test(raw)) {
      throw new HttpDriverError(
        "invalid_endpoint",
        `Refused unsafe path segment substituted into endpoint '${endpoint}'.`,
        false,
      )
    }
    return encodeURIComponent(raw)
  })
}

function resolvePath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (FORBIDDEN_PATH_KEYS.has(key)) return undefined
    if (acc && typeof acc === "object" && Object.hasOwn(acc, key)) {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, obj)
}

/** Extract a value from a response body using a JSONPath-lite expression. */
export function extractResponse(body: unknown, path: string): unknown {
  if (path === "$") return body
  const tokens = parseJsonPath(path)
  let current: unknown = body
  for (const token of tokens) {
    if (current == null) return undefined
    if (token.kind === "key") {
      const key = token.value as string
      if (FORBIDDEN_PATH_KEYS.has(key)) return undefined
      if (typeof current !== "object" || !Object.hasOwn(current, key)) return undefined
      current = (current as Record<string, unknown>)[key]
    } else if (token.kind === "index") {
      current = (current as unknown[])[token.value as number]
    } else if (token.kind === "wildcard") {
      if (!Array.isArray(current)) return []
      // Map remaining tokens over each element.
      const rest = tokens.slice(tokens.indexOf(token) + 1)
      return current.map(el => applyTokens(el, rest))
    }
  }
  return current
}

function applyTokens(value: unknown, tokens: Array<{ kind: string; value: string | number }>): unknown {
  let current: unknown = value
  for (const token of tokens) {
    if (current == null) return undefined
    if (token.kind === "key") {
      const key = token.value as string
      if (FORBIDDEN_PATH_KEYS.has(key)) return undefined
      if (typeof current !== "object" || !Object.hasOwn(current, key)) return undefined
      current = (current as Record<string, unknown>)[key]
    } else if (token.kind === "index") {
      current = (current as unknown[])[token.value as number]
    }
  }
  return current
}

function parseJsonPath(path: string): Array<{ kind: "key" | "index" | "wildcard"; value: string | number }> {
  const tokens: Array<{ kind: "key" | "index" | "wildcard"; value: string | number }> = []
  // Strip leading "$"
  let s = path.replace(/^\$/, "")
  // Tokenise: .key | [N] | [*]
  const re = /\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]|\[(\*)\]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(s)) !== null) {
    if (match[1]) tokens.push({ kind: "key", value: match[1] })
    else if (match[2]) tokens.push({ kind: "index", value: Number.parseInt(match[2], 10) })
    else if (match[3]) tokens.push({ kind: "wildcard", value: "*" })
  }
  return tokens
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const ct = response.headers.get("content-type") ?? ""
  if (ct.includes("application/json")) return await response.json()
  return await response.text()
}

/** Trailing ` — <excerpt>` appended to a non-2xx error message — the body
 *  text (JSON stringified when parsed as JSON), capped so a large error
 *  page/payload doesn't blow up the step error. Empty body → no suffix. */
const BODY_EXCERPT_MAX_CHARS = 500

function bodyExcerpt(body: unknown, secrets?: Record<string, string>): string {
  if (body == null || body === "") return ""
  const text = typeof body === "string" ? body : JSON.stringify(body)
  if (!text) return ""
  const scrubbed = redactSecrets(text, secrets)
  const truncated = scrubbed.length > BODY_EXCERPT_MAX_CHARS ? `${scrubbed.slice(0, BODY_EXCERPT_MAX_CHARS)}…` : scrubbed
  return ` — ${truncated}`
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  h.forEach((v, k) => {
    out[k] = v
  })
  return out
}

function appendQuery(url: string, query: Record<string, string> | undefined): string {
  if (!query || Object.keys(query).length === 0) return url
  const u = new URL(url)
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v)
  return u.toString()
}

function normalizeToolId(ref: string): string {
  let s = ref.trim()
  if (s.startsWith("./")) s = s.slice(2)
  if (s.endsWith("/TOOL.md")) s = s.slice(0, -"/TOOL.md".length)
  if (s.startsWith("tools/")) s = s.slice("tools/".length)
  const lastSlash = s.lastIndexOf("/")
  return lastSlash === -1 ? s : s.slice(lastSlash + 1)
}

export { HttpDriverError }
export {
  safeHttpCollector,
  createSafeCollectorFetch,
  assertSafeUrl,
  isPrivateOrReservedIp,
  redactSecrets,
  SafeHttpCollectorError,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  type SafeHttpCollectorOptions,
  type DnsAddressRecord,
  type DnsLookupFn,
} from "./safe-collector.js"
